// q2ts-web play driver: server-authoritative local play (M7.1+).
//
// Headless-safe (no DOM here; the rAF loop lives in dom.ts). Two modes:
// - devroom: procedural MiniWorld visuals + analytic room collision.
// - pak: real base1.bsp (BSP collision, WAL textures, PCX palette,
//   doors/triggers/movers, static soldier/gunner placeholders you can shoot).
import { Host } from '@q2/host';
import type { HostDriver } from '@q2/host';
import { BUTTON_ATTACK } from '@q2/input';
import type { UserCmdT } from '@q2/input';
import type { Snapshot } from '@q2/client';
import { drawString, fillRect } from '@q2/client';
import {
  SoftwareRenderer,
  createDevroom,
  bspToMiniWorld,
  getDevMesh,
} from '@q2/sw-renderer';
import type { MiniWorld, MiniSurf } from '@q2/sw-renderer';
import { loadBsp, MODEL_EXTRA_STRIDE } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import {
  parseEntities,
  parseFloat,
  spawnEdict,
  makePmoveState,
  pmoveFull,
  setPmoveWorld,
  bspTraceFor,
  setPmoveWorldFromBsp,
  findWeapon,
  fireWeapon,
  mulberry32,
  WEAPON_BLASTER,
  spawnMonster,
  monsterThink,
  monsterPain,
  selectAttack,
  makePlayerState,
  pickupItem,
  triggerTouch,
  moverUse,
} from '@q2/game';
import type {
  PmoveState,
  UserCmd,
  Edict,
  Mover,
  MonsterState,
  MonsterKind,
  Trigger,
  WeaponDef,
  TraceResult,
  PlayerState,
} from '@q2/game';
import { SV_Init, SV_SpawnEntities, SV_Tick, SV_TouchTriggersAt, fireTargets } from '@q2/server';
import type { ServerState } from '@q2/server';
import { ATTN_NORM, Mixer } from '@q2/sound';
import { parseWAL, parsePCX } from '@q2/formats';
import { resolveFrame } from '@q2/voodoo';
import { AngleVectors, v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import { getCVarString } from '@q2/config';
import { readPakEntry } from './pak.js';
import type { WebPak } from './pak.js';

export type RendererKind = 'software' | 'voodoo';

const PLAYER_ID = 1;
/** Eye height above the pm origin (matches PmoveState.viewheight). */
const EYE = 22;
/** id pellet spread basis: r/u are world units at 8192 range. */
const PELLET_RANGE = 8192;
const MONSTER_MINS: [number, number, number] = [-16, -16, 0];
const MONSTER_MAXS: [number, number, number] = [16, 16, 56];

const REFIRE: Record<string, number> = {
  weapon_blaster: 0.25,
  weapon_shotgun: 0.9,
  weapon_machinegun: 0.1,
};

// --- devroom analytic collision (floor z=0, walls +-256, center pillar) ---

interface Box {
  mins: [number, number, number];
  maxs: [number, number, number];
}

const DEV_BOXES: Box[] = [
  { mins: [-256, -256, -8], maxs: [256, 256, 0] }, // floor slab
  { mins: [256, -256, 0], maxs: [272, 256, 256] }, // +x wall
  { mins: [-272, -256, 0], maxs: [-256, 256, 256] }, // -x wall
  { mins: [-256, 256, 0], maxs: [256, 272, 256] }, // +y wall
  { mins: [-256, -272, 0], maxs: [256, -256, 256] }, // -y wall
  { mins: [-48, -48, 0], maxs: [48, 48, 192] }, // pillar
];

/** Contact epsilon, mirroring the C engine's DIST_EPSILON (1/32). */
const CONTACT_EPS = 1 / 32;

function sweepBoxVsBoxes(
  start: Vec3,
  mins: Vec3,
  maxs: Vec3,
  end: Vec3,
  boxes: Box[],
): { fraction: number; normal: Vec3; startsolid: boolean; allsolid: boolean } {
  const d = [end[0]! - start[0]!, end[1]! - start[1]!, end[2]! - start[2]!];
  let best = 1;
  let bestAxis = -1;
  let bestSign = 0;
  let startsolid = false;
  // Push-out normal when starting inside geometry (least penetration axis).
  let pushAxis = -1;
  let pushSign = 0;
  let pushDepth = Infinity;
  for (const b of boxes) {
    // Minkowski-expand the obstacle by the player extents.
    const lo = [b.mins[0]! - maxs[0]!, b.mins[1]! - maxs[1]!, b.mins[2]! - maxs[2]!];
    const hi = [b.maxs[0]! - mins[0]!, b.maxs[1]! - mins[1]!, b.maxs[2]! - mins[2]!];
    let tEnter = -Infinity;
    let tExit = Infinity;
    let axis = -1;
    let sign = 0;
    let ok = true;
    // Strict-epsilon containment: resting exactly on a face is contact,
    // not penetration (mirrors the C engine's DIST_EPSILON handling).
    let contained = true;
    for (let k = 0; k < 3; k++) {
      const s = start[k]!;
      const dk = d[k]!;
      if (s <= lo[k]! + CONTACT_EPS || s >= hi[k]! - CONTACT_EPS) contained = false;
      if (dk === 0) {
        if (s < lo[k]! || s > hi[k]!) {
          ok = false;
          break;
        }
        continue;
      }
      let t0 = (lo[k]! - s) / dk;
      let t1 = (hi[k]! - s) / dk;
      if (t0 > t1) {
        const t = t0;
        t0 = t1;
        t1 = t;
      }
      if (t0 > tEnter) {
        tEnter = t0;
        axis = k;
        sign = dk < 0 ? 1 : -1;
      }
      if (t1 < tExit) tExit = t1;
      if (tEnter > tExit) {
        ok = false;
        break;
      }
    }
    if (!ok || tExit < 0 || tEnter > 1) continue;
    if (contained) {
      // Penetration: report startsolid with a least-penetration push normal.
      startsolid = true;
      for (let k = 0; k < 3; k++) {
        const s = start[k]!;
        const penLo = s - lo[k]!;
        const penHi = hi[k]! - s;
        if (penLo < pushDepth) {
          pushDepth = penLo;
          pushAxis = k;
          pushSign = -1;
        }
        if (penHi < pushDepth) {
          pushDepth = penHi;
          pushAxis = k;
          pushSign = 1;
        }
      }
      continue;
    }
    if (tEnter > 0) {
      // Approaching from outside: genuine entry hit.
      if (tEnter < best) {
        best = tEnter;
        bestAxis = axis;
        bestSign = sign;
      }
      continue;
    }
    // Touching contact (entry in the past or right now): find the nearest
    // face by proximity and only hit when moving into it. Sliding along or
    // away from a resting contact must not zero the whole fraction.
    let contactAxis = -1;
    let contactSign = 0;
    let contactDist = Infinity;
    for (let k = 0; k < 3; k++) {
      const s = start[k]!;
      const distLo = s - lo[k]!;
      const distHi = hi[k]! - s;
      if (distLo < contactDist) {
        contactDist = distLo;
        contactAxis = k;
        contactSign = -1;
      }
      if (distHi < contactDist) {
        contactDist = distHi;
        contactAxis = k;
        contactSign = 1;
      }
    }
    if (contactAxis >= 0 && contactDist <= CONTACT_EPS && d[contactAxis]! * contactSign < 0) {
      if (0 < best) {
        best = 0;
        bestAxis = contactAxis;
        bestSign = contactSign;
      }
    }
  }
  const endInside = boxes.some((b) => {
    const lo = [b.mins[0]! - maxs[0]!, b.mins[1]! - maxs[1]!, b.mins[2]! - maxs[2]!];
    const hi = [b.maxs[0]! - mins[0]!, b.maxs[1]! - mins[1]!, b.maxs[2]! - mins[2]!];
    return (
      end[0]! >= lo[0]! && end[0]! <= hi[0]! &&
      end[1]! >= lo[1]! && end[1]! <= hi[1]! &&
      end[2]! >= lo[2]! && end[2]! <= hi[2]!
    );
  });
  const normal = v3();
  if (bestAxis >= 0) {
    normal[bestAxis] = bestSign;
    return { fraction: best, normal, startsolid, allsolid: startsolid && endInside };
  }
  if (startsolid && pushAxis >= 0) normal[pushAxis] = pushSign;
  return { fraction: startsolid ? 0 : best, normal, startsolid, allsolid: startsolid && endInside };
}

function devroomTrace(start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3): TraceResult {
  const r = sweepBoxVsBoxes(start, mins, maxs, end, DEV_BOXES);
  const endpos = v3(
    start[0]! + (end[0]! - start[0]!) * r.fraction,
    start[1]! + (end[1]! - start[1]!) * r.fraction,
    start[2]! + (end[2]! - start[2]!) * r.fraction,
  );
  const hit = r.startsolid || r.fraction < 1;
  return {
    fraction: r.fraction,
    endpos,
    planeNormal: r.normal,
    allsolid: r.allsolid,
    startsolid: r.startsolid,
    // No entity numbers in the analytic room: miss => -1 (airborne).
    entityNum: hit ? 0 : -1,
    contents: 0,
  };
}

// --- driver ---

export interface PlacedMonster {
  id: number;
  origin: [number, number, number];
  state: MonsterState;
  /** last server time this monster attacked (id rate-limits to ~1/s). */
  lastAttack: number;
}

interface DoorSync {
  mover: Mover;
  model: number;
  faces: MiniSurf[];
  baseVerts: Float32Array[];
  baseCenter: Float32Array[];
  baseMins: Float32Array[];
  baseMaxs: Float32Array[];
}

function tryPakEntry(pak: WebPak, name: string): ArrayBuffer | null {
  try {
    return readPakEntry(pak, name);
  } catch {
    return null;
  }
}

export class LocalDriver implements HostDriver {
  readonly source: 'devroom' | 'pak';
  readonly pm: PmoveState = makePmoveState();
  readonly server: ServerState = SV_Init();
  /** Q2 player state: health/armor/ammo/weapons. Pickups go through pickupItem. */
  readonly ps: PlayerState = makePlayerState();
  /** Per-channel positional sound: dom.ts syncs mix() gains to BrowserMixer. */
  readonly mixer = new Mixer();
  readonly mini: MiniWorld;
  readonly map: BspMap | null;
  readonly playerEdict: Edict;
  readonly monsters: PlacedMonster[] = [];
  readonly events: string[] = [];
  readonly changeTargets = new Set<string>();
  message = '';
  exited = false;
  weapon: WeaponDef = WEAPON_BLASTER;
  shells = 0;
  bullets = 0;
  readonly rand = mulberry32(0x51ab);
  private lastShotAt = -10;
  private doors: DoorSync[] = [];
  private bspTrace: ((start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => TraceResult) | null = null;
  /** Muzzle flash expiry (server time) + world pos for the dlight/HUD flash. */
  private flashUntil = -10;
  private flashPos: Vec3 = v3();
  /** Player death/respawn. */
  private deadUntil = -1;
  private spawnPoints: Array<{ origin: Vec3; yaw: number }> = [];
  /** mover state snapshot for door-move sound edges. */
  private moverStates = new Map<Mover, string>();
  private soundBorn = new Map<number, number>();

  constructor(pak: WebPak | null) {
    if (pak && pak.entries.some((e) => e.name === 'maps/base1.bsp')) {
      const built = buildBase1(pak);
      this.source = 'pak';
      this.map = built.map;
      this.mini = built.mini;
      setPmoveWorldFromBsp(built.map);
      this.bspTrace = bspTraceFor(built.map);
      SV_SpawnEntities(this.server, built.map.entities, (model) => modelBounds(built.map, model));
      this.playerEdict = spawnEdict({ classname: 'player' });
      this.spawnFromLump(built.map);
      this.placeMonsters(built.map);
      this.snapshotDoorBases();
      for (const e of this.server.entities) {
        if (e.classname === 'target_changelevel' && e.targetname) this.changeTargets.add(e.targetname);
      }
    } else {
      this.source = 'devroom';
      this.map = null;
      this.mini = createDevroom();
      setPmoveWorld(devroomTrace, () => 0);
      this.playerEdict = spawnEdict({ classname: 'player' });
      this.pm.origin = v3(-168, 0, 32);
      this.pm.velocity = v3();
      this.spawnPoints = [{ origin: v3(-168, 0, 32), yaw: 0 }];
    }
    this.playerEdict.origin = v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]);
    this.syncAmmo();
    this.updateMixerListener();
  }

  spawn(): { origin: [number, number, number]; angles?: [number, number, number] } {
    return {
      origin: [this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]!],
      angles: [this.pm.viewAngles[0]!, this.pm.viewAngles[1]!, this.pm.viewAngles[2]!],
    };
  }

  step(cmd: UserCmdT, dt: number): void {
    const msec = Math.max(1, Math.round(dt * 1000));
    const gcmd: UserCmd = {
      msec,
      angles: new Float32Array(cmd.angles) as Vec3,
      forwardmove: cmd.forwardmove,
      sidemove: cmd.sidemove,
      upmove: cmd.upmove,
      buttons: cmd.buttons,
    };
    // Dead players keep no momentum and can't move until respawn.
    if (this.ps.health <= 0 && this.deadUntil > 0 && this.server.time < this.deadUntil) {
      this.pm.velocity = v3();
    } else {
      this.pm.viewAngles = new Float32Array(cmd.angles) as Vec3;
      pmoveFull(this.pm, gcmd);
    }
    this.playerEdict.origin = v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]);
    for (const m of this.server.movers) this.moverStates.set(m, m.state);
    SV_Tick(this.server, dt);
    SV_TouchTriggersAt(this.server, 'player', this.playerEdict);
    this.syncDoors();
    for (const m of this.monsters) {
      if (!m.state.dead) monsterThink(m.state);
    }
    this.checkDoorTouch();
    this.checkBrushTriggers();
    this.emitDoorSounds();
    // Exit scan runs after every firing path (point + brush triggers):
    // each pushes the relay targetname into firedThisTick.
    for (const t of this.server.firedThisTick) {
      if (this.changeTargets.has(t) && !this.exited) {
        this.exited = true;
        this.message = 'LEVEL COMPLETE — base2 is not shipped yet. Thanks for playing!';
        this.events.push('exit');
      }
    }
    this.monsterCombat();
    this.checkPickups();
    this.handleAttack(cmd);
    this.expireSounds();
    this.updateMixerListener();
    if (this.ps.health <= 0 && this.deadUntil > 0 && this.server.time >= this.deadUntil) {
      this.respawn();
    }
  }

  snapshot(serverTime: number): Snapshot {
    const entities: Snapshot['entities'] = [
      {
        id: PLAYER_ID,
        origin: [this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]!],
        velocity: [this.pm.velocity[0]!, this.pm.velocity[1]!, this.pm.velocity[2]!],
      },
    ];
    for (const m of this.monsters) {
      if (m.state.dead) continue;
      entities.push({
        id: m.id,
        origin: [m.origin[0]!, m.origin[1]!, m.origin[2]!],
        velocity: [0, 0, 0],
      });
    }
    return { serverTime, entities };
  }

  selectWeapon(classname: string): void {
    if (!this.ps.weapons.includes(classname)) {
      this.message = 'NO WEAPON';
      this.events.push('empty');
      return;
    }
    const def = findWeapon(classname);
    if (def) {
      this.weapon = def;
      this.events.push('weapon');
    }
  }

  hasWeapon(classname: string): boolean {
    return this.ps.weapons.includes(classname);
  }

  get aliveMonsters(): number {
    return this.monsters.filter((m) => !m.state.dead).length;
  }

  get playerHealth(): number {
    return this.ps.health;
  }

  get playerDead(): boolean {
    return this.ps.health <= 0;
  }

  /** Muzzle flash lit while server time is inside the post-shot window. */
  muzzleLit(): boolean {
    return this.server.time < this.flashUntil;
  }

  /** Drain the one-shot muzzle-flash dlight request (dom tick pumps it). */
  drainFlash(): Vec3 | null {
    if (!this.muzzleLit()) return null;
    return this.flashPos;
  }

  hudAmmo(): string {
    if (!this.weapon.ammoKind) return '∞';
    return String(this.weapon.ammoKind === 'shells' ? this.shells : this.bullets);
  }

  /** Compat sync: legacy shells/bullets ints mirror PlayerState ammo. */
  private syncAmmo(): void {
    this.shells = this.ps.ammo['shells'] ?? 0;
    this.bullets = this.ps.ammo['bullets'] ?? 0;
  }

  private emitSound(name: string, origin: Vec3, attn = ATTN_NORM, masterVol = 1): number {
    const id = this.mixer.startSound({
      origin: [origin[0]!, origin[1]!, origin[2]!],
      fixedOrigin: false,
      entnum: PLAYER_ID,
      attenuation: attn,
      masterVol,
      loop: false,
      name,
    });
    this.soundBorn.set(id, this.server.time);
    return id;
  }

  /** Drop one-shot channels ~1s after they fire (mix() would hold them). */
  private expireSounds(): void {
    for (const [id, born] of this.soundBorn) {
      if (this.server.time - born > 1.0) {
        this.mixer.stopSound(id);
        this.soundBorn.delete(id);
      }
    }
  }

  private updateMixerListener(): void {
    const fwd = v3();
    const right = v3();
    const up = v3();
    AngleVectors(this.pm.viewAngles, fwd, right, up);
    const eye = v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]! + EYE);
    this.mixer.setListener(eye, right);
  }

  private emitDoorSounds(): void {
    for (const m of this.server.movers) {
      const prev = this.moverStates.get(m);
      if (prev !== undefined && prev !== m.state && (m.state === 'going_up' || m.state === 'going_down')) {
        this.emitSound(
          m.ent.classname === 'func_button' ? 'buttons/button.wav' : 'doors/door.wav',
          m.ent.origin,
        );
        this.events.push('door');
      }
    }
  }

  private playerBox(): { mins: Vec3; maxs: Vec3 } {
    return { mins: v3(-16, -16, -24), maxs: v3(16, 16, 32) };
  }

  /**
   * Door touch (Touch_DoorTrigger, id g_func.c): walking into a door's
   * expanded volume uses it. The web driver can't rely on the C brush-touch
   * path, so the 60-unit expanded AABB check from the WIRE bot is the play
   * path here too — this is what actually opens doors in the browser.
   */
  private checkDoorTouch(): void {
    if (!this.map || this.playerDead) return;
    const { mins, maxs } = this.playerBox();
    for (const m of this.server.movers) {
      if (m.ent.classname !== 'func_door') continue;
      const b = modelBounds(this.map, m.ent.model);
      if (!b) continue;
      const ox = m.ent.origin[0]! - m.pos1[0]!;
      const oy = m.ent.origin[1]! - m.pos1[1]!;
      const oz = m.ent.origin[2]! - m.pos1[2]!;
      const tmins = new Float32Array([b.mins[0]! + ox - 60, b.mins[1]! + oy - 60, b.mins[2]! + oz]);
      const tmaxs = new Float32Array([b.maxs[0]! + ox + 60, b.maxs[1]! + oy + 60, b.maxs[2]! + oz]);
      if (!boxOverlap(this.pm.origin, mins, maxs, tmins, tmaxs)) continue;
      if (m.state === 'bottom' || m.state === 'waiting') {
        moverUse(m, this.server.time);
      }
    }
  }

  /**
   * Brush trigger volumes (trigger_once/multiple on model *N): real AABB
   * overlap — the point-proximity hook in SV_TouchTriggersAt can't see brush
   * models (their edict origin is 0,0,0). This is the exit path: the *27 pit
   * volume fires t37 -> target_changelevel when the player body arrives.
   */
  private checkBrushTriggers(): void {
    if (!this.map || this.playerDead) return;
    const { mins, maxs } = this.playerBox();
    for (const t of this.server.triggers) {
      const n = brushModelNum(t.ent.model);
      if (n === null) continue;
      const b = modelBounds(this.map, t.ent.model);
      if (!b) continue;
      if (!boxOverlap(this.pm.origin, mins, maxs, b.mins, b.maxs)) continue;
      const pseudo: Edict = { ...t.ent };
      triggerTouch(t, this.server.time, 'player', () => fireTargets(this.server, pseudo));
    }
  }

  /** id-style touch damage + ranged tracer fire back at the player. */
  private monsterCombat(): void {
    if (this.playerDead) return;
    const eye = v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]! + EYE);
    for (const m of this.monsters) {
      if (m.state.dead) continue;
      // id rate-limits attacks to roughly one per second per monster.
      if (this.server.time - m.lastAttack < 1.0) continue;
      const dx = eye[0]! - m.origin[0]!;
      const dy = eye[1]! - m.origin[1]!;
      const dz = eye[2]! - m.origin[2]!;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 1000) continue;
      // Line of sight from the monster's chest to the player's eye.
      const from = v3(m.origin[0]!, m.origin[1]!, m.origin[2]! + 32);
      if (this.traceShot(from, eye).fraction < 1) continue;
      const choice = selectAttack(m.state.kind as MonsterKind, dist, this.rand);
      if (choice === 'melee') {
        if (dist < 96) {
          m.lastAttack = this.server.time;
          this.damagePlayer(m.state.kind === 'gunner' ? 15 : 10, m.origin);
          this.emitSound('monster/melee.wav', v3(m.origin[0]!, m.origin[1]!, m.origin[2]!));
        }
      } else if (choice === 'shotgun' || choice === 'blaster' || choice === 'chaingun' || choice === 'grenade') {
        // Tracer: hit chance falls with range (near ~0.6, mid ~0.25).
        m.lastAttack = this.server.time;
        const pHit = dist < 500 ? 0.6 : 0.25;
        const dmg = choice === 'chaingun' ? 6 : choice === 'grenade' ? 12 : 5;
        this.emitSound(
          m.state.kind === 'gunner' ? 'gunner/gunfire.wav' : 'soldier/shot.wav',
          v3(m.origin[0]!, m.origin[1]!, m.origin[2]! + 32),
        );
        this.events.push('monshot');
        if (this.rand() < pHit) this.damagePlayer(dmg, m.origin);
      }
    }
  }

  /** Apply damage to the player; death parks a 2s respawn timer. */
  damagePlayer(dmg: number, from?: Vec3 | [number, number, number]): void {
    if (this.playerDead || this.exited) return;
    void from;
    this.ps.health -= dmg;
    this.events.push('pain');
    this.emitSound('player/pain.wav', v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]!));
    if (this.ps.health <= 0) {
      this.ps.health = 0;
      this.message = 'YOU DIED — respawning…';
      this.events.push('death');
      this.emitSound('player/death.wav', v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]!));
      this.deadUntil = this.server.time + 2;
    }
  }

  private respawn(): void {
    const sp = this.spawnPoints[0];
    if (sp) {
      this.pm.origin = v3(sp.origin[0], sp.origin[1], sp.origin[2]);
      this.pm.viewAngles = v3(0, sp.yaw, 0);
    } else {
      this.pm.origin = v3(0, 0, 32);
      this.pm.viewAngles = v3();
    }
    this.pm.velocity = v3();
    this.ps.health = this.ps.maxHealth;
    this.deadUntil = -1;
    this.message = '';
    this.events.push('respawn');
    this.playerEdict.origin = v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]);
  }

  /** Walk-over pickups: item/weapon/ammo edicts grant via pickupItem. */
  private checkPickups(): void {
    if (this.playerDead) return;
    const px = this.pm.origin[0]!;
    const py = this.pm.origin[1]!;
    const pz = this.pm.origin[2]!;
    for (const e of this.server.entities) {
      if (e.freed) continue;
      const c = e.classname;
      if (!c.startsWith('item_') && !c.startsWith('weapon_') && !c.startsWith('ammo_')) continue;
      const dx = Math.abs(px - e.origin[0]!);
      const dy = Math.abs(py - e.origin[1]!);
      const dz = pz - e.origin[2]!;
      if (dx > 40 || dy > 40 || dz < -24 || dz > 64) continue;
      const res = pickupItem(this.ps, c);
      if (!res.picked) continue;
      e.freed = true;
      this.syncAmmo();
      this.events.push('pickup');
      this.message = c.replace(/_/g, ' ');
      this.emitSound('items/pickup.wav', v3(px, py, pz));
      if (res.reason === 'weapon' && (c === 'weapon_shotgun' || c === 'weapon_machinegun')) {
        const def = findWeapon(c);
        if (def) {
          this.weapon = def;
          this.events.push('weapon');
        }
      }
    }
  }

  private spawnFromLump(map: BspMap): void {
    // id SelectSpawnPoint (SP): the first info_player_start WITHOUT a
    // targetname. base1's lump leads with a targeted ("base2") start in the
    // exit room for back-travel from base2 — spawning there would drop the
    // player on top of the exit volume and instantly "complete" the level.
    const starts = parseEntities(map.entities).filter(
      (d) => d['classname'] === 'info_player_start' && !d['targetname'],
    );
    this.spawnPoints = starts.map((d) => {
      const yaw = parseFloat(d['angle'], 0);
      let origin = v3(128, -320, 32);
      if (d['origin']) {
        const o = d['origin']!.trim().split(/\s+/).map(Number);
        origin = v3(o[0] ?? 0, o[1] ?? 0, o[2] ?? 32);
      }
      return { origin, yaw };
    });
    const first = this.spawnPoints[0];
    if (first) {
      this.pm.origin = v3(first.origin[0], first.origin[1], first.origin[2]);
      this.pm.viewAngles = v3(0, first.yaw, 0);
    } else {
      this.pm.origin = v3(128, -320, 32);
      this.pm.viewAngles = v3(0, 0, 0);
    }
    this.pm.velocity = v3();
  }

  private placeMonsters(map: BspMap): void {
    let id = 2;
    for (const d of parseEntities(map.entities)) {
      const cls = d['classname'];
      if (cls !== 'monster_soldier' && cls !== 'monster_gunner') continue;
      if (this.monsters.length >= 12) break;
      const o = (d['origin'] ?? '0 0 0').trim().split(/\s+/).map(Number);
      this.monsters.push({
        id: id++,
        origin: [o[0] ?? 0, o[1] ?? 0, o[2] ?? 0],
        state: spawnMonster(cls === 'monster_soldier' ? 'soldier' : 'gunner'),
        lastAttack: -10,
      });
    }
  }

  private snapshotDoorBases(): void {
    if (!this.map) return;
    for (const m of this.server.movers) {
      const model = m.ent.model;
      if (!model || !model.startsWith('*')) continue;
      const n = Number.parseInt(model.slice(1), 10);
      if (!Number.isFinite(n)) continue;
      const count = this.map.modelsExtra.length / MODEL_EXTRA_STRIDE;
      if (n < 0 || n >= count) continue;
      const first = this.map.modelsExtra[n * MODEL_EXTRA_STRIDE + 1]!;
      const num = this.map.modelsExtra[n * MODEL_EXTRA_STRIDE + 2]!;
      const faces: MiniSurf[] = [];
      const baseVerts: Float32Array[] = [];
      const baseCenter: Float32Array[] = [];
      const baseMins: Float32Array[] = [];
      const baseMaxs: Float32Array[] = [];
      for (let f = first; f < first + num; f++) {
        const s = this.mini.surfaces[f];
        if (!s || s.n === 0) continue;
        faces.push(s);
        baseVerts.push(new Float32Array(s.verts));
        baseCenter.push(new Float32Array(s.center));
        baseMins.push(new Float32Array(s.mins));
        baseMaxs.push(new Float32Array(s.maxs));
      }
      if (faces.length > 0) {
        this.doors.push({ mover: m, model: n, faces, baseVerts, baseCenter, baseMins, baseMaxs });
      }
    }
  }

  private syncDoors(): void {
    for (const d of this.doors) {
      const ox = d.mover.ent.origin[0]! - d.mover.pos1[0]!;
      const oy = d.mover.ent.origin[1]! - d.mover.pos1[1]!;
      const oz = d.mover.ent.origin[2]! - d.mover.pos1[2]!;
      if (ox === 0 && oy === 0 && oz === 0) continue;
      for (let i = 0; i < d.faces.length; i++) {
        const s = d.faces[i]!;
        const bv = d.baseVerts[i]!;
        for (let k = 0; k < bv.length; k += 3) {
          s.verts[k] = bv[k]! + ox;
          s.verts[k + 1] = bv[k + 1]! + oy;
          s.verts[k + 2] = bv[k + 2]! + oz;
        }
        const bc = d.baseCenter[i]!;
        s.center[0] = bc[0]! + ox;
        s.center[1] = bc[1]! + oy;
        s.center[2] = bc[2]! + oz;
        const bn = d.baseMins[i]!;
        const bx = d.baseMaxs[i]!;
        s.mins[0] = bn[0]! + ox;
        s.mins[1] = bn[1]! + oy;
        s.mins[2] = bn[2]! + oz;
        s.maxs[0] = bx[0]! + ox;
        s.maxs[1] = bx[1]! + oy;
        s.maxs[2] = bx[2]! + oz;
      }
    }
  }

  private handleAttack(cmd: UserCmdT): void {
    if (!(cmd.buttons & BUTTON_ATTACK)) return;
    if (this.playerDead) return;
    const t = this.server.time;
    const refire = REFIRE[this.weapon.classname] ?? 0.25;
    if (t - this.lastShotAt < refire) return;
    const ammo = this.weapon.ammoKind === 'shells' ? this.shells : this.bullets;
    const res = fireWeapon(this.weapon, ammo, this.rand, false);
    if (!res.fired) {
      this.message = 'NO AMMO';
      this.events.push('empty');
      this.emitSound('weapons/noammo.wav', v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]!));
      this.lastShotAt = t;
      return;
    }
    if (this.weapon.ammoKind === 'shells') this.ps.ammo['shells'] = res.ammoLeft;
    if (this.weapon.ammoKind === 'bullets') this.ps.ammo['bullets'] = res.ammoLeft;
    this.syncAmmo();
    this.lastShotAt = t;
    this.message = '';
    this.events.push('shot');
    const eye = v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]! + EYE);
    this.emitSound(
      this.weapon.classname === 'weapon_shotgun'
        ? 'weapons/shotgf1b.wav'
        : this.weapon.classname === 'weapon_machinegun'
          ? 'weapons/machgf1b.wav'
          : 'weapons/blastf1a.wav',
      eye,
    );
    // Muzzle flash: HUD glow + a real dlight the renderer understands.
    this.flashUntil = t + 0.09;
    const fwd0 = v3();
    const right0 = v3();
    const up0 = v3();
    AngleVectors(new Float32Array(cmd.angles) as Vec3, fwd0, right0, up0);
    this.flashPos = v3(
      eye[0]! + fwd0[0]! * 16,
      eye[1]! + fwd0[1]! * 16,
      eye[2]! + fwd0[2]! * 16,
    );
    const fwd = v3();
    const right = v3();
    const up = v3();
    AngleVectors(new Float32Array(cmd.angles) as Vec3, fwd, right, up);
    for (const p of res.pellets) {
      const dir = v3(
        fwd[0]! * PELLET_RANGE + right[0]! * p.r + up[0]! * p.u,
        fwd[1]! * PELLET_RANGE + right[1]! * p.r + up[1]! * p.u,
        fwd[2]! * PELLET_RANGE + right[2]! * p.r + up[2]! * p.u,
      );
      const len = Math.hypot(dir[0]!, dir[1]!, dir[2]!) || 1;
      // Pellet spread basis: r/u are world units at PELLET_RANGE (id convention).
      const far = v3(
        eye[0]! + ((dir[0]! / len) * PELLET_RANGE),
        eye[1]! + ((dir[1]! / len) * PELLET_RANGE),
        eye[2]! + ((dir[2]! / len) * PELLET_RANGE),
      );
      const wall = this.traceShot(eye, far);
      let bestT = wall.fraction;
      let hitMonster: PlacedMonster | null = null;
      const seg = v3(far[0]! - eye[0]!, far[1]! - eye[1]!, far[2]! - eye[2]!);
      for (const m of this.monsters) {
        if (m.state.dead) continue;
        const mmins: [number, number, number] = [
          m.origin[0]! + MONSTER_MINS[0],
          m.origin[1]! + MONSTER_MINS[1],
          m.origin[2]! + MONSTER_MINS[2],
        ];
        const mmaxs: [number, number, number] = [
          m.origin[0]! + MONSTER_MAXS[0],
          m.origin[1]! + MONSTER_MAXS[1],
          m.origin[2]! + MONSTER_MAXS[2],
        ];
        const tHit = segmentAabb(eye, seg, mmins, mmaxs);
        if (tHit !== null && tHit < bestT) {
          bestT = tHit;
          hitMonster = m;
        }
      }
      const hitPos = v3(
        eye[0]! + seg[0]! * bestT,
        eye[1]! + seg[1]! * bestT,
        eye[2]! + seg[2]! * bestT,
      );
      if (hitMonster) {
        monsterPain(hitMonster.state, p.damage, this.rand);
        this.events.push(hitMonster.state.dead ? 'kill' : 'hit');
        if (hitMonster.state.dead) this.message = `${hitMonster.state.kind} down`;
      } else if (bestT < 1) {
        this.pushSpark(hitPos);
      }
    }
  }

  private traceShot(eye: Vec3, far: Vec3): { fraction: number } {
    const zero = v3();
    if (this.bspTrace) return this.bspTrace(eye, zero, zero, far);
    return devroomTrace(eye, zero, zero, far);
  }

  private pushSpark(pos: Vec3): void {
    const parts = this.mini.particles as { origin: Vec3; color: number }[];
    parts.push({ origin: v3(pos[0], pos[1], pos[2]), color: 200 + ((this.rand() * 55) | 0) });
    while (parts.length > 48) parts.shift();
  }
}

function segmentAabb(
  origin: Vec3,
  delta: Vec3,
  mins: [number, number, number],
  maxs: [number, number, number],
): number | null {
  let tEnter = 0;
  let tExit = 1;
  for (let k = 0; k < 3; k++) {
    const o = origin[k]!;
    const d = delta[k]!;
    if (d === 0) {
      if (o < mins[k]! || o > maxs[k]!) return null;
      continue;
    }
    let t0 = (mins[k]! - o) / d;
    let t1 = (maxs[k]! - o) / d;
    if (t0 > t1) {
      const t = t0;
      t0 = t1;
      t1 = t;
    }
    if (t0 > tEnter) tEnter = t0;
    if (t1 < tExit) tExit = t1;
    if (tEnter > tExit) return null;
  }
  if (tEnter > 1 || tExit < 0) return null;
  return tEnter;
}

function modelBounds(
  map: BspMap,
  model: string,
): { mins: Float32Array; maxs: Float32Array } | null {
  const n = brushModelNum(model);
  if (n === null) return null;
  const count = map.modelsExtra.length / MODEL_EXTRA_STRIDE;
  if (n < 0 || n >= count) return null;
  return {
    mins: map.modelsMins.slice(n * 3, n * 3 + 3),
    maxs: map.modelsMaxs.slice(n * 3, n * 3 + 3),
  };
}

/** Parse a brush-model ref ('*27') to its model number; null otherwise. */
function brushModelNum(model: string): number | null {
  if (!model.startsWith('*')) return null;
  const n = Number.parseInt(model.slice(1), 10);
  return Number.isFinite(n) ? n : null;
}

/** Inclusive AABB overlap of the player box with brush bounds (C G_TouchTriggers). */
function boxOverlap(
  o: Vec3,
  mins: Vec3, maxs: Vec3,
  bmins: Float32Array, bmaxs: Float32Array,
): boolean {
  for (let i = 0; i < 3; i++) {
    if (o[i]! + mins[i]! > bmaxs[i]! || o[i]! + maxs[i]! < bmins[i]!) return false;
  }
  return true;
}

function buildBase1(pak: WebPak): { map: BspMap; mini: MiniWorld } {
  const bspBytes = readPakEntry(pak, 'maps/base1.bsp');
  const map = loadBsp(bspBytes);
  const texelFor = (walName: string): { texels: Uint8Array; width: number; height: number } | null => {
    const walBytes = tryPakEntry(pak, `textures/${walName}.wal`);
    if (!walBytes) return null;
    try {
      const wal = parseWAL(walBytes);
      return { texels: wal.mips[0]!, width: wal.width, height: wal.height };
    } catch {
      return null;
    }
  };
  const mini = bspToMiniWorld(map, { texelFor });
  return { map, mini };
}

// --- boot + HUD ---

export interface PlayBoot {
  host: Host;
  driver: LocalDriver;
  refresh: SoftwareRenderer;
  renderer: RendererKind;
  source: 'devroom' | 'pak';
  display: Uint32Array;
  fb565: Uint16Array;
}

export function bootPlay(opts: {
  width?: number;
  height?: number;
  renderer?: RendererKind;
  pak?: WebPak | null;
}): PlayBoot {
  const width = opts.width ?? 320;
  const height = opts.height ?? 240;
  const renderer = opts.renderer ?? 'software';
  const driver = new LocalDriver(opts.pak ?? null);
  const refresh = new SoftwareRenderer();
  if (opts.pak) {
    const pcxBytes = tryPakEntry(opts.pak, 'pics/colormap.pcx');
    if (pcxBytes) {
      try {
        refresh.setPalette(parsePCX(pcxBytes).palette);
      } catch {
        /* procedural palette fallback */
      }
    }
  }
  const host = new Host({
    refresh,
    width,
    height,
    indexed: true,
    world: { name: driver.source === 'pak' ? 'maps/base1' : 'maps/devroom', data: driver.mini },
    driver,
  });
  // Monster placeholder mesh must be handle 0: register before anything else.
  if (driver.monsters.length > 0) {
    createDevroom();
    host.refresh.registerModel({ name: 'monster', kind: 'md2', data: getDevMesh(0) });
  }
  const n = width * height;
  return { host, driver, refresh, renderer, source: driver.source, display: new Uint32Array(n), fb565: new Uint16Array(n) };
}

/** Resolve the software framebuffer for display (voodoo post chain or direct). */
export function resolveDisplay(boot: PlayBoot): Uint32Array {
  const { host } = boot;
  if (getCVarString('vid_renderer') === 'voodoo') {
    resolveFrame(host.fb.color, boot.fb565, boot.display, host.fb.width, host.fb.height);
    return boot.display;
  }
  return host.fb.color;
}

/**
 * Pump the one-shot muzzle-flash dynamic light into the renderer. Call
 * before the frame renders (the dom rAF tick does this; headless tests call
 * it directly). No-op once the flash window expires.
 */
export function pumpMuzzleLight(boot: PlayBoot): boolean {
  const pos = boot.driver.drainFlash();
  if (!pos) return false;
  boot.refresh.testAddDynamicLight({
    origin: new Float32Array([pos[0]!, pos[1]!, pos[2]!]),
    intensity: 200,
    color: new Float32Array([1, 0.85, 0.5]),
  });
  return true;
}

export interface HudState {
  fps: number;
  frame: number;
}

/** Draw crosshair + status lines onto a 0xAABBGGRR buffer (runs post-resolve). */
export function drawPlayHud(
  target: { width: number; height: number; color: Uint32Array },
  boot: PlayBoot,
  hud: HudState,
): void {
  const white = 0xffffffff;
  const dim = 0xff888888;
  const cx = (target.width / 2) | 0;
  const cy = (target.height / 2) | 0;
  fillRect(target, cx - 4, cy, 9, 1, dim);
  fillRect(target, cx, cy - 4, 1, 9, dim);
  fillRect(target, cx, cy, 1, 1, white);
  drawViewModel(target, boot);
  const o = boot.driver.pm.origin;
  const hp = boot.driver.playerHealth;
  const hpColor = boot.driver.playerDead ? 0xffff3333 : hp <= 25 ? 0xffff9933 : white;
  drawString(target, 8, 8, `fps ${hud.fps.toFixed(0)}`, white);
  drawString(target, 8, 18, `${o[0]!.toFixed(0)} ${o[1]!.toFixed(0)} ${o[2]!.toFixed(0)}`, dim);
  drawString(target, 8, target.height - 18, `${boot.driver.weapon.classname} ${boot.driver.hudAmmo()}`, white);
  drawString(target, 8, target.height - 48, `hp ${hp}`, hpColor);
  if (boot.driver.message) {
    const msg = boot.driver.message.slice(0, 48);
    drawString(target, 8, target.height - 30, msg, 0xffffff00);
  }
  if (boot.source === 'devroom') {
    drawString(target, 8, 28, 'devroom - drop pak0.pak for base1', dim);
  }
}

/**
 * Weapon view model: gun body bottom-right + muzzle flash light rectangle.
 * Drawn post-resolve in HUD space (the software renderer has no screen-space
 * sprite path); the 3D muzzle dlight is pumped separately via drainFlash().
 */
function drawViewModel(
  target: { width: number; height: number; color: Uint32Array },
  boot: PlayBoot,
): void {
  const w = target.width;
  const h = target.height;
  const cls = boot.driver.weapon.classname;
  const gunW = cls === 'weapon_shotgun' ? 64 : cls === 'weapon_machinegun' ? 58 : 46;
  const gunH = 26;
  const gx = w - gunW - 10;
  const gy = h - gunH - 8;
  if (w < 120 || h < 100) return;
  const body = cls === 'weapon_shotgun' ? 0xff6b4a26 : cls === 'weapon_machinegun' ? 0xff4a4a52 : 0xff3a3f44;
  const dark = 0xff1c1c20;
  const grip = 0xff2a2018;
  // Receiver + barrel + grip silhouette.
  fillRect(target, gx, gy + 6, gunW, 12, body);
  fillRect(target, gx + gunW - 18, gy, 14, 8, dark);
  fillRect(target, gx + 8, gy + 16, 14, 10, grip);
  // Top highlight.
  fillRect(target, gx, gy + 6, gunW, 1, 0xff9a9aa2);
  if (boot.driver.muzzleLit()) {
    // Flash star at the muzzle + a soft glow over the gun.
    const mx = gx + gunW - 18;
    fillRect(target, mx - 6, gy - 6, 26, 14, 0xffffee88);
    fillRect(target, mx, gy - 2, 14, 6, 0xffffffff);
    fillRect(target, gx, gy + 6, gunW, 12, 0x66ffdd66);
  }
  if (boot.driver.playerDead) {
    fillRect(target, 0, 0, w, 3, 0xffff2222);
    fillRect(target, 0, h - 3, w, 3, 0xffff2222);
  }
}
