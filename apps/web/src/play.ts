// q2ts-web play driver: server-authoritative local play (M7.1+).
//
// Headless-safe (no DOM here; the rAF loop lives in dom.ts). Two modes:
// - devroom: procedural MiniWorld visuals + analytic room collision.
// - pak: real base1.bsp (BSP collision, WAL textures, PCX palette,
//   doors/triggers/movers, static soldier/gunner placeholders you can shoot).
import { Host } from '@q2/host';
import type { ExtraRenderable, HostDriver } from '@q2/host';
import { BUTTON_ATTACK } from '@q2/input';
import type { UserCmdT } from '@q2/input';
import type { Snapshot } from '@q2/client';
import {
  drawString,
  fillRect,
  makeConcharsFont,
  setConcharsFont,
  stringWidth,
  loadConcharsFont as loadConcharsPixels,
} from '@q2/client';
import type { ConcharsFont } from '@q2/client';
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
  BOLT_SPEED,
  WEAPON_BLASTER,
  spawnMonster,
  monsterChaseMove,
  monsterLocomotion,
  MONSTER_HULL_MINS,
  MONSTER_HULL_MAXS,
  monsterMoveOf,
  monsterThink,
  monsterPain,
  selectAttack,
  makePlayerState,
  pickupItem,
  triggerTouch,
  moverUse,
  modelForMonster,
  skinForMonster,
  viewModelForWeapon,
  modelForBolt,
  skinForBolt,
  skinForWeaponModel,
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
import { parseMD2, parseWAL, parsePCX } from '@q2/formats';
import type { Pcx } from '@q2/formats';
import { resolveFrame } from '@q2/voodoo';
import { AngleVectors, v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import { getCVar, getCVarNumber, getCVarString, registerCVar } from '@q2/config';
import { readPakEntry } from './pak.js';
import type { WebPak } from './pak.js';

export type RendererKind = 'software' | 'voodoo';

// --- display-only brightness (M7.1 feedback) ---
//
// `r_brightness` is a pure presentation lift applied post-resolve in
// `resolveDisplay` (0xAABBGGRR scale + clamp). It never touches lightmaps,
// the palette, the pak, or the renderer internals — the framebuffer the
// engine produced is unchanged. Registered here (apps/web owns the display
// path); `getBrightness` treats an absent cvar (e.g. after `resetCVars()` in
// tests) as the default so headless boots stay deterministic.
export const BRIGHTNESS_DEFAULT = 2.0;
export const BRIGHTNESS_MIN = 0.5;
export const BRIGHTNESS_MAX = 2.0;

registerCVar('r_brightness', BRIGHTNESS_DEFAULT, 'display-only post-resolve brightness lift 0.5..2.0');

/** Clamped `r_brightness` (absent/non-finite cvar → default). Self-healing:
 * re-registers the default when a test `resetCVars()` wiped it, so the panel
 * keeps listing it and headless boots stay deterministic. */
export function getBrightness(): number {
  let raw = getCVar('r_brightness');
  if (raw === undefined) {
    registerCVar('r_brightness', BRIGHTNESS_DEFAULT, 'display-only post-resolve brightness lift 0.5..2.0');
    raw = BRIGHTNESS_DEFAULT;
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) return BRIGHTNESS_DEFAULT;
  return Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, v));
}

/**
 * Scale a 0xAABBGGRR buffer by `brightness` in place (alpha preserved,
 * channels rounded + clamped to 255). `brightness === 1` is a no-op so the
 * 1.0 path stays byte-identical. Zero-alloc; display-only, never pak data.
 */
export function applyBrightness(dst: Uint32Array, brightness: number): void {
  if (brightness === 1) return;
  for (let i = 0; i < dst.length; i++) {
    const px = dst[i]!;
    let r = (px & 255) * brightness;
    let g = ((px >> 8) & 255) * brightness;
    let b = ((px >> 16) & 255) * brightness;
    r = r > 255 ? 255 : Math.round(r);
    g = g > 255 ? 255 : Math.round(g);
    b = b > 255 ? 255 : Math.round(b);
    dst[i] = (px & 0xff000000) | (b << 16) | (g << 8) | r;
  }
}

const PLAYER_ID = 1;
/** Eye height above the pm origin (matches PmoveState.viewheight). */
const EYE = 22;
/** id pellet spread basis: r/u are world units at 8192 range. */
const PELLET_RANGE = 8192;
const MONSTER_MINS: [number, number, number] = [-16, -16, -24];
const MONSTER_MAXS: [number, number, number] = [16, 16, 32];

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

/**
 * One queued beam for the renderer's `spawnTracer` pool: origin + direction
 * (need not be normalized — the renderer normalizes) + palette-index color +
 * world-unit length. Queued by the driver in step(), drained by
 * pumpTracers() before the frame renders. Blaster bolts and shotgun pellets
 * both travel this path; impact sparks stay on the mini.particles path.
 */
export interface TracerBeam {
  origin: [number, number, number];
  dir: [number, number, number];
  color: number;
  length: number;
}

/** Full-bright palette index for the blaster bolt beam (matches id's EF_BLASTER look). */
export const BLASTER_TRACER_COLOR = 225;
/** Hot orange pellet streak for shotgun/machinegun + monster return fire. */
export const PELLET_TRACER_COLOR = 208;
/**
 * Authentic v_weap anim frames (game/p_weapon.c Weapon_Generic tables):
 * Blaster (4,8,52,55) fires on gunframe 5, idles 9..52; Shotgun
 * (7,18,36,39) fires on 8..9, idles 19..36; Machinegun (3,5,45,49) fires
 * on 4..5, idles 6..45. Frame 0 was the half-raised active pose, never the
 * idle — that is why the gun read as a small hand-held toy.
 * VIEWMODEL_FIRE_FRAME stays as the blaster alias (back-compat for tests).
 */
export const VIEWMODEL_FIRE_FRAME = 5;
export const VIEWMODEL_IDLE_FRAMES: Record<string, number> = {
  weapon_blaster: 9,
  weapon_shotgun: 19,
  weapon_machinegun: 6,
};
export const VIEWMODEL_FIRE_FRAMES: Record<string, number> = {
  weapon_blaster: 5,
  weapon_shotgun: 8,
  weapon_machinegun: 4,
};

/** Authentic blaster projectile (g_weapon.c fire_blaster): 1000 u/s, 2s life. */
export interface Bolt {
  pos: Vec3;
  dir: Vec3; // normalized
  life: number;
  damage: number;
  /** Server time the bolt was spawned (life expires on server time, not frame dt). */
  born: number;
}

/**
 * Trail/impact spark lifetime in server seconds. id's CL_BlasterParticles
 * fade in a fraction of a second; the old path never expired them (cap-only
 * ring), so every bolt left a permanent spark line. The sweep in step()
 * keeps world-seeded particles (devroom torch flame, born +Infinity) forever.
 */
export const SPARK_TTL = 0.4;

/**
 * Impact-flash dlight window in server seconds. TE_BLASTER / TE_EXPLOSION1
 * are brief flashes (id adds a short yellow light on touch); the old 0.3s
 * drain window lit the whole tile noticeably longer than the authentic
 * impact. The renderer's own light ttl still bounds each add to ~2 renders.
 */
export const EXPLOSION_LIGHT_WINDOW = 0.1;

/** Pak lump for shootable barrels (g_misc.c SP_misc_explobox, origin at the box bottom). */
export const BARREL_MODEL = 'models/objects/barrels/tris.md2';
export const BARREL_SKIN = 'models/objects/barrels/skin.pcx';
/** Authentic explobox hull (g_misc.c: mins -16,-16,0 / maxs 16,16,40). */
export const BARREL_MINS: [number, number, number] = [-16, -16, 0];
export const BARREL_MAXS: [number, number, number] = [16, 16, 40];

/** Shootable explosive (misc_explobox / func_explosive-lite). */
export interface Barrel {
  origin: Vec3;
  health: number;
  dmg: number;
  dead: boolean;
}

/** Explosion flash (TE_BLASTER / TE_EXPLOSION1): particles + dlight + sound. */
export interface Explosion {
  pos: Vec3;
  born: number;
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
  /** Muzzle dlight radius for the pending flash (id CL_MuzzleFlash 200+(rand&31)). */
  private flashIntensity = 200;
  /** One-shot pump gate: true only between a shot and its single drain. */
  private flashPending = false;
  /** Queued tracer beams (see TracerBeam): drained by pumpTracers(). */
  private tracerQueue: TracerBeam[] = [];
  /** Flying blaster bolts (authentic fire_blaster projectiles, not hitscan). */
  readonly bolts: Bolt[] = [];
  /** Shootable explosive barrels (misc_explobox) + breakables. */
  readonly barrels: Barrel[] = [];
  /** Scripted explosion targets (target_explosion) by targetname. */
  private explosionTargets = new Map<string, { origin: Vec3; dmg: number }>();
  /** Recent explosion flashes (TE_EXPLOSION1/TE_BLASTER visuals). */
  readonly explosions: Explosion[] = [];
  /**
   * Per-particle birth (server time), parallel to `mini.particles`.
   * World-seeded particles (devroom torch flame) start at +Infinity and
   * never expire (`time - Infinity = -Infinity`, never past the ttl);
   * driver-pushed sparks expire after SPARK_TTL.
   */
  private particleBorn: number[] = [];
  /** Player death/respawn. */
  private deadUntil = -1;
  private spawnPoints: Array<{ origin: Vec3; yaw: number }> = [];
  /** mover state snapshot for door-move sound edges. */
  private moverStates = new Map<Mover, string>();
  private soundBorn = new Map<number, number>();
  /**
   * Real-pak MD2/skin handles (set by bootPlay after registerPakModels).
   * Null in devroom: viewModel() hides the 3D gun, HUD keeps the 2D icon.
   */
  models: PakModelHandles | null = null;

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
      this.parseExplosives(built.map);
      this.snapshotDoorBases();
      // id SP_trigger_always: fire at spawn (level-start flybys/relays).
      // Flyby visuals are out of scope; explosion targets fire for real.
      this.fireTriggerAlways(built.map);
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
    // World-seeded particles predate the driver: they never expire. Prepend
    // (not overwrite): fireTriggerAlways may already have pushed spawn
    // sparks with real births above.
    while (this.particleBorn.length < this.mini.particles.length) this.particleBorn.unshift(Infinity);
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
      if (m.state.dead) {
        // Corpses persist: keep advancing the death move to its last frame
        // (monsterThink holds it there) so the snapshot keeps rendering the
        // fallen body instead of freezing on frame 0.
        monsterThink(m.state);
        continue;
      }
      // Steering (id walkmonster_start/run logic): chase the player along a
      // trivial 2-node graph (self -> player) with line-of-sight, so idle
      // stand flips to run/attack and locomotion has a nonzero dist to play.
      // Uses the tested monsterChaseMove selector; pathfinding on the real
      // node graph arrives with M5.3 full AI.
      const eyeForSee = v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]! + EYE);
      const chestSee = v3(m.origin[0]!, m.origin[1]!, m.origin[2]! + 8);
      const seen = this.traceShot(chestSee, eyeForSee).fraction >= 1;
      try {
        monsterChaseMove(
          m.state,
          v3(m.origin[0], m.origin[1], m.origin[2]),
          v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]),
          {
            graph: new Map([[0, [1]], [1, [0]]]),
            positions: new Map([[0, v3(m.origin[0], m.origin[1], m.origin[2])], [1, v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2])]]),
          },
          seen,
          this.rand,
        );
      } catch {
        // Unknown move names from older saves stay put; locomotion still runs.
      }
      // Locomotion BEFORE think (id ai_move runs inside the frame): yaw
      // toward the player, advance by the current frame's dist,
      // collision-clamped + gravity-settled by the helper. `think` then
      // steps the frame counter.
      const body = v3(m.origin[0], m.origin[1], m.origin[2]);
      monsterLocomotion(m.state, body, this.pm.origin, (start, end) =>
        this.bspTrace
          ? this.bspTrace(start, MONSTER_HULL_MINS, MONSTER_HULL_MAXS, end)
          : devroomTrace(start, MONSTER_HULL_MINS, MONSTER_HULL_MAXS, end),
      );
      m.origin[0] = body[0]!;
      m.origin[1] = body[1]!;
      m.origin[2] = body[2]!;
      monsterThink(m.state);
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
    this.checkScriptedExplosions();
    this.sweepParticles();
    this.stepBolts(dt);
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
      // Corpses persist in the snapshot (id keeps the dead edict rendering
      // its last death frame); the host draws them via entityFrame, which
      // clamps to the held final frame of the death move.
      entities.push({
        id: m.id,
        origin: [m.origin[0]!, m.origin[1]!, m.origin[2]!],
        velocity: [0, 0, 0],
      });
    }
    return { serverTime, entities };
  }

  /**
   * Extra world entities the snapshot omits (HostDriver pairing: the Host
   * appends these to its renderables with explicit model/skin/angles, so
   * bolts and barrels render as their own MD2s the moment a pak is present
   * — no host change needed, the hook already landed there). Null when
   * there is nothing live (devroom at rest). Bolt flight orientation rides
   * along as yaw/pitch (id convention pitch positive = down).
   */
  extraEntities(): ExtraRenderable[] | null {
    const out: ExtraRenderable[] = [];
    for (const b of this.barrels) {
      if (b.dead) continue;
      out.push({
        origin: [b.origin[0]!, b.origin[1]!, b.origin[2]!],
        angles: [0, 0, 0],
        model: this.models?.barrel ?? 0,
        skin: this.models?.barrelSkin ?? 0,
        frame: 0,
      });
    }
    for (const bolt of this.bolts) {
      const yaw = (Math.atan2(bolt.dir[1]!, bolt.dir[0]!) * 180) / Math.PI;
      const z = Math.max(-1, Math.min(1, bolt.dir[2]!));
      const pitch = -(Math.asin(z) * 180) / Math.PI;
      out.push({
        origin: [bolt.pos[0]!, bolt.pos[1]!, bolt.pos[2]!],
        angles: [pitch, yaw, 0],
        model: this.models?.bolt ?? 0,
        skin: this.models?.boltSkin ?? 0,
        frame: 0,
      });
    }
    return out.length > 0 ? out : null;
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

  /**
   * First-person 3D weapon view model (HostDriver contract): the registered
   * `v_weap` MD2 handle + its PCX skin for the selected weapon. Frame 0
   * idle, frame 4 while the muzzle is lit (the renderer wraps out-of-range
   * indices, so this is safe for every v_weap lump). Null without a pak —
   * the caller falls back to the 2D silhouette.
   */
  viewModel(): { model: number; skin: number; frame: number } | null {
    const model = this.models?.weapons[this.weapon.classname];
    const skin = this.models?.weaponSkins[this.weapon.classname];
    if (model === undefined || skin === undefined) return null;
    if (this.muzzleLit()) return { model, skin, frame: VIEWMODEL_FIRE_FRAMES[this.weapon.classname] ?? VIEWMODEL_FIRE_FRAME };
    return { model, skin, frame: VIEWMODEL_IDLE_FRAMES[this.weapon.classname] ?? 9 };
  }

  /**
   * MD2 frame for a snapshot entity (HostDriver contract): the move table's
   * `first` frame number (already matching the MD2 frame names) plus the
   * state's frame offset. Unknown ids map to 0; the renderer wraps.
   */
  entityFrame(id: number): number {
    const m = this.monsters.find((m) => m.id === id);
    if (!m) return 0;
    try {
      const mv = monsterMoveOf(m.state);
      const idx = Math.min(m.state.frame, Math.max(0, mv.frames.length - 1));
      return mv.first + Math.max(0, idx);
    } catch {
      return 0;
    }
  }

  /**
   * Registered model/skin for a snapshot entity (HostDriver pairing:
   * same optional-method shape as entityFrame). Soldier and gunner resolve
   * to their own MD2 + PCX handles (registration order pins soldier skin 0
   * / mesh 0); unknown ids return null for the Host default. Null without
   * a pak — devroom keeps the legacy model-0 rendering.
   */
  entityModel(id: number): { model: number; skin: number } | null {
    const m = this.monsters.find((m) => m.id === id);
    if (!m || !this.models) return null;
    if (m.state.kind === 'gunner') return { model: this.models.gunner, skin: this.models.gunnerSkin };
    return { model: this.models.monster, skin: this.models.monsterSkin };
  }

  /**
   * World orientation for a snapshot entity (HostDriver pairing). Monsters
   * report the locomotion-maintained yaw (id M_ChangeYaw, shortest-arc
   * clamped per tick) so the host renders them facing the player instead of
   * the legacy yaw-0 snap. Bolt flight orientation rides on the extras
   * themselves (see extraEntities). Headless-safe pure math. Unknown ids
   * return null for the Host default.
   * TODO(interp): LerpAngle between snapshots (client/cl_ents.c) + frame
   * vertex lerp via oldframe/backlerp (RF_FRAMELERP) keyed off
   * serverAcc/SERVER_DT. Needs an Entity contract change (frozen BRAIN.md
   * §6), so yaw/frames still step at 10Hz for now.
   */
  entityAngles(id: number): [number, number, number] | null {
    const m = this.monsters.find((m) => m.id === id);
    if (!m) return null;
    return [0, ((m.state.yaw % 360) + 360) % 360, 0];
  }

  /** Drain the one-shot muzzle-flash dlight request (dom tick pumps it). */
  drainFlash(): Vec3 | null {
    if (!this.flashPending) return null;
    if (!this.muzzleLit()) {
      // Window expired before the pump ran: drop the request so a stale
      // pos can never brighten a later frame.
      this.flashPending = false;
      return null;
    }
    this.flashPending = false;
    return this.flashPos;
  }

  /**
   * Pending muzzle-flash radius (id CL_MuzzleFlash 200+(rand&31), rolled at
   * fire time so the stream stays caller-seeded deterministic). Read after
   * drainFlash() by the dlight pump; 200 before the first shot.
   */
  peekFlashIntensity(): number {
    return this.flashIntensity;
  }

  /**
   * Queue a beam from `origin` along `dir` (unnormalized ok) with palette
   * `color`, `length` world units. Called for every fired pellet/bolt and
   * every monster ranged shot; pumpTracers() moves them into the renderer's
   * spawnTracer pool before the frame renders. Zero-alloc per call aside
   * from the queue entry itself (capped below).
   */
  queueTracer(origin: Vec3, dir: Vec3, color: number, length: number): void {
    if (this.tracerQueue.length >= 64) this.tracerQueue.shift();
    this.tracerQueue.push({
      origin: [origin[0]!, origin[1]!, origin[2]!],
      dir: [dir[0]!, dir[1]!, dir[2]!],
      color: color & 255,
      length,
    });
  }

  /** Live queued beams (observability, test hook). */
  get pendingTracers(): number {
    return this.tracerQueue.length;
  }

  /** Drain the queued beams (pumpTracers moves them to the renderer). */
  drainTracers(): TracerBeam[] {
    if (this.tracerQueue.length === 0) return [];
    const out = this.tracerQueue;
    this.tracerQueue = [];
    return out;
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

  /** id-style touch damage + ranged tracer fire back at the player.
   *
   * TODO(fire-frames): key damage/sound off the move's fire-tagged frames
   * (monsterThink action) instead of this ~1/s timer, so hits land on the
   * muzzle flash. Left timer-based on purpose: the soldier attack tables
   * carry no fire tags yet (all 'move'), so gating here would silence/stall
   * soldier attacks, and re-timing kills would invalidate the Q2_PAK bot
   * expectations (damage within the kill loop, melee-back every ~1s).
   */
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
        // Authentic: no hitscan beam (only the railgun draws TE_RAILTRAIL).
        // The lite state machine keeps id's damage roll + sound; a visible
        // projectile arrives with full monster AI (M5.3). Muzzle location
        // kept for the (currently unused) tracer path.
        void from;
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
    // A new life is vulnerable again: without this, a completed level left
    // `exited` set forever (spurious or real), and damagePlayer's
    // `exited` guard made the player permanently invincible.
    this.exited = false;
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
      let origin: [number, number, number] = [o[0] ?? 0, o[1] ?? 0, o[2] ?? 0];
      // id walkmonster_start_go + M_droptofloor: the lump origin is the
      // entity origin 24 above the feet; drop the hull to the floor so a
      // map-placed origin floating above ground rests correctly instead of
      // hovering, and clamp startsolid Luton setups onto the floor.
      if (this.bspTrace) {
        const start = v3(origin[0], origin[1], origin[2] + 1);
        const end = v3(origin[0], origin[1], origin[2] - 256);
        try {
          const tr = this.bspTrace(start, MONSTER_HULL_MINS, MONSTER_HULL_MAXS, end);
          if (!tr.allsolid) origin = [tr.endpos[0]!, tr.endpos[1]!, tr.endpos[2]!];
        } catch {
          // Keep the lump origin on trace failure (devroom-style fallback).
        }
      }
      this.monsters.push({
        id: id++,
        origin,
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
    // id CL_MuzzleFlash: origin = feet + fwd*18 + right*16 (full 3D fwd/
    // right via G_ProjectSource, no up vector), radius 200+(rand&31),
    // pure yellow, single frame.
    this.flashUntil = t + 0.09;
    this.flashPending = true;
    this.flashIntensity = 200 + ((this.rand() * 32) | 0);
    const fwd0 = v3();
    const right0 = v3();
    const up0 = v3();
    AngleVectors(new Float32Array(cmd.angles) as Vec3, fwd0, right0, up0);
    const feet0 = this.pm.origin;
    this.flashPos = v3(
      feet0[0]! + fwd0[0]! * 18 + right0[0]! * 16,
      feet0[1]! + fwd0[1]! * 18 + right0[1]! * 16,
      feet0[2]! + fwd0[2]! * 18 + right0[2]! * 16,
    );
    const fwd = v3();
    const right = v3();
    const up = v3();
    AngleVectors(new Float32Array(cmd.angles) as Vec3, fwd, right, up);
    // Authentic split (g_weapon.c): the blaster is a PROJECTILE weapon
    // (fire_blaster bolt edict, 1000 u/s, 2s life, EF_BLASTER trail) — never
    // hitscan, never a muzzle->impact beam. Hitscan weapons (shotgun /
    // machinegun, fire_lead) are instant traces with impact sparks only;
    // only the railgun draws a beam (TE_RAILTRAIL, not in v1).
    if (this.weapon.classname === 'weapon_blaster' && res.bolt) {
      // G_ProjectSource (g_utils.c) from the feet origin: start = feet +
      // fwd*24 + right*8 (full 3D fwd/right), then start.z += viewheight-8
      // (22-8 = 14). No up vector. The bolt leaves the gun muzzle, not the eye.
      const feet = this.pm.origin;
      const start = v3(
        feet[0]! + fwd[0]! * 24 + right[0]! * 8,
        feet[1]! + fwd[1]! * 24 + right[1]! * 8,
        feet[2]! + fwd[2]! * 24 + right[2]! * 8 + (EYE - 8),
      );
      const dir = v3(fwd[0]!, fwd[1]!, fwd[2]!);
      const dl = Math.hypot(dir[0]!, dir[1]!, dir[2]!) || 1;
      this.bolts.push({
        pos: start,
        dir: v3(dir[0]! / dl, dir[1]! / dl, dir[2]! / dl),
        life: res.bolt.life,
        damage: res.bolt.damage,
        born: this.server.time,
      });
      this.events.push('bolt');
      return;
    }
    for (const pl of res.pellets) {
      const dir = v3(
        fwd[0]! * PELLET_RANGE + right[0]! * pl.r + up[0]! * pl.u,
        fwd[1]! * PELLET_RANGE + right[1]! * pl.r + up[1]! * pl.u,
        fwd[2]! * PELLET_RANGE + right[2]! * pl.r + up[2]! * pl.u,
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
      // Barrels are shootable (misc_explobox takes T_Damage): test the bolt
      // path against live barrels before resolving the wall/monster hit.
      const hitBarrel = this.barrelAT(eye, seg, bestT);
      if (hitBarrel && !hitBarrel.dead) {
        this.damageBarrel(hitBarrel, pl.damage);
      } else if (hitMonster) {
        monsterPain(hitMonster.state, pl.damage, this.rand);
        this.events.push(hitMonster.state.dead ? 'kill' : 'hit');
        if (hitMonster.state.dead) this.message = `${hitMonster.state.kind} down`;
      } else if (bestT < 1) {
        // TE_GUNSHOT / TE_SHOTGUN impact: gray sparks + smoke, no beam.
        this.pushSpark(hitPos);
      }
    }
  }

  /** Parse shootable/scripted explosives from the entities lump (base1).
   *
   * misc_explobox origins are kept as the mapper placed them (Verified
   * against real base1.bsp: the lump origins already rest on the floor —
   * a hull drop moves them by exactly CONTACT_EPS — matching id's
   * M_droptofloor outcome, since the origin is the box bottom). No drop.
   */
  private parseExplosives(map: BspMap): void {
    for (const d of parseEntities(map.entities)) {
      const cls = d['classname'];
      if (cls === 'misc_explobox') {
        const o = (d['origin'] ?? '0 0 0').trim().split(/\s+/).map(Number);
        const health = d['health'] !== undefined ? Number.parseInt(d['health']!, 10) : 10;
        const dmg = d['dmg'] !== undefined
          ? Number.parseFloat(d['dmg']!)
          : d['damage'] !== undefined
            ? Number.parseFloat(d['damage']!)
            : 150;
        this.barrels.push({
          origin: v3(o[0] ?? 0, o[1] ?? 0, o[2] ?? 0),
          health: Number.isFinite(health) ? health : 10,
          dmg: Number.isFinite(dmg) ? dmg : 150,
          dead: false,
        });
      } else if (cls === 'target_explosion' && d['targetname']) {
        const o = (d['origin'] ?? '0 0 0').trim().split(/\s+/).map(Number);
        const dmg = d['dmg'] !== undefined ? Number.parseFloat(d['dmg']!) : 0;
        this.explosionTargets.set(d['targetname']!, {
          origin: v3(o[0] ?? 0, o[1] ?? 0, o[2] ?? 0),
          dmg: Number.isFinite(dmg) ? dmg : 0,
        });
      } else if (cls === 'func_explosive') {
        const model = d['model'];
        const health = d['health'] !== undefined ? Number.parseInt(d['health']!, 10) : 10;
        const dmg = d['dmg'] !== undefined ? Number.parseFloat(d['dmg']!) : 25;
        if (model && this.map) {
          const b = modelBounds(this.map, model);
          if (b) {
            const cx = (b.mins[0]! + b.maxs[0]!) / 2;
            const cy = (b.mins[1]! + b.maxs[1]!) / 2;
            const cz = (b.mins[2]! + b.maxs[2]!) / 2;
            this.barrels.push({
              origin: v3(cx, cy, cz),
              health: Number.isFinite(health) ? health : 10,
              dmg: Number.isFinite(dmg) ? dmg : 25,
              dead: false,
            });
          }
        }
      }
    }
  }

  /** id SP_trigger_always: fire at spawn (base1 level-start relays). */
  private fireTriggerAlways(map: BspMap): void {
    for (const d of parseEntities(map.entities)) {
      if (d['classname'] !== 'trigger_always' || !d['target']) continue;
      for (const t of d['target']!.trim().split(/\s+/)) {
        const ex = this.explosionTargets.get(t);
        if (ex) this.spawnExplosion(ex.origin, ex.dmg);
      }
    }
  }

  /** Scripted corridor blasts: trigger_once/relay chains fire target_explosion. */
  private checkScriptedExplosions(): void {
    for (const t of this.server.firedThisTick) {
      const ex = this.explosionTargets.get(t);
      if (ex) this.spawnExplosion(ex.origin, ex.dmg);
    }
  }

  /** TE_BLASTER / TE_EXPLOSION1 visual + sound + radius damage. */
  private spawnExplosion(pos: Vec3, dmg: number): void {
    this.explosions.push({ pos: v3(pos[0], pos[1], pos[2]), born: this.server.time });
    // 40-spark yellow burst (cl_fx.c CL_BlasterParticles, color 0xe0 + rand&7).
    for (let i = 0; i < 40; i++) {
      const ox = (this.rand() * 16 - 8) | 0;
      const oy = (this.rand() * 16 - 8) | 0;
      const oz = (this.rand() * 16 - 8) | 0;
      this.pushColoredSpark(v3(pos[0]! + ox, pos[1]! + oy, pos[2]! + oz), 0xe0 + ((this.rand() * 8) | 0));
    }
    this.emitSound('world/explod1.wav', v3(pos[0], pos[1], pos[2]));
    this.events.push('explosion');
    if (dmg > 0) this.damageRadius(pos, dmg);
  }

  /** id T_RadiusDamage(dmg, dmg+40): linear falloff to monsters + player. */
  private damageRadius(pos: Vec3, dmg: number): void {
    const radius = dmg + 40;
    if (!(radius > 0)) return;
    for (const m of this.monsters) {
      if (m.state.dead) continue;
      const dist = Math.hypot(m.origin[0]! - pos[0]!, m.origin[1]! - pos[1]!, m.origin[2]! - pos[2]!);
      if (dist >= radius) continue;
      const scaled = Math.max(1, Math.round(dmg * (1 - dist / radius)));
      monsterPain(m.state, scaled, this.rand);
      this.events.push(m.state.dead ? 'kill' : 'hit');
    }
    const pd = Math.hypot(
      this.pm.origin[0]! - pos[0]!, this.pm.origin[1]! - pos[1]!, this.pm.origin[2]! - pos[2]!,
    );
    if (pd < radius) {
      const scaled = Math.max(1, Math.round(dmg * (1 - pd / radius)));
      this.damagePlayer(scaled, [pos[0]!, pos[1]!, pos[2]!]);
    }
    for (const b of this.barrels) {
      if (b.dead) continue;
      const bd = Math.hypot(b.origin[0]! - pos[0]!, b.origin[1]! - pos[1]!, b.origin[2]! - pos[2]!);
      if (bd < radius && bd > 1) this.damageBarrel(b, Math.max(1, Math.round(dmg * (1 - bd / radius))));
    }
  }

  /** Step flying blaster bolts (1000 u/s, 2s life): trail, touch, impact.
   *
   * Life expires on SERVER time (`server.time - born >= life`, id's
   * `G_FreeEdict at level.time + 2`): the old `life -= dt` tied the 2s fuse
   * to whatever dt the step happened to carry, so a non-tick dt stretched
   * or shrank the bolt's life. Movement still integrates the passed tick
   * quantum (always SERVER_DT from Host.serverTick).
   */
  private stepBolts(dt: number): void {
    if (this.bolts.length === 0) return;
    const speed = BOLT_SPEED;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const bolt = this.bolts[i]!;
      const stepLen = speed * dt;
      const next = v3(
        bolt.pos[0]! + bolt.dir[0]! * stepLen,
        bolt.pos[1]! + bolt.dir[1]! * stepLen,
        bolt.pos[2]! + bolt.dir[2]! * stepLen,
      );
      // EF_BLASTER trail (cl_fx.c CL_BlasterTrail): yellow puffs every ~5
      // units at the fixed palette color 0xe0 (no jitter — the impact
      // burst below is where the 0xe0+(rand&7) spread lives).
      const trailSteps = Math.min(8, Math.max(1, Math.round(stepLen / 5)));
      for (let k = 1; k <= trailSteps; k++) {
        const f = k / (trailSteps + 1);
        this.pushColoredSpark(
          v3(
            bolt.pos[0]! + (next[0]! - bolt.pos[0]!) * f,
            bolt.pos[1]! + (next[1]! - bolt.pos[1]!) * f,
            bolt.pos[2]! + (next[2]! - bolt.pos[2]!) * f,
          ),
          0xe0,
        );
      }
      let dead = this.server.time - bolt.born >= bolt.life;
      if (!dead) {
        // Wall touch (blaster_touch: sky frees silently, wall explodes).
        // TODO(sky): TraceResult exposes no SURF_SKY flag, so sky hits
        // explode here; free the bolt silently once the trace carries the
        // surface flag (id blaster_touch).
        const wall = this.traceShot(bolt.pos, next);
        if (wall.fraction < 1) {
          const hitPos = v3(
            bolt.pos[0]! + (next[0]! - bolt.pos[0]!) * wall.fraction,
            bolt.pos[1]! + (next[1]! - bolt.pos[1]!) * wall.fraction,
            bolt.pos[2]! + (next[2]! - bolt.pos[2]!) * wall.fraction,
          );
          this.blasterImpact(hitPos, bolt.damage, null);
          dead = true;
        } else {
          // Flesh touch: monsters first (T_Damage ENERGY), then barrels.
          const seg = v3(next[0]! - bolt.pos[0]!, next[1]! - bolt.pos[1]!, next[2]! - bolt.pos[2]!);
          let hitMonster: PlacedMonster | null = null;
          let bestT = 1;
          for (const m of this.monsters) {
            if (m.state.dead) continue;
            const tHit = segmentAabb(
              bolt.pos, seg,
              [m.origin[0]! + MONSTER_MINS[0], m.origin[1]! + MONSTER_MINS[1], m.origin[2]! + MONSTER_MINS[2]],
              [m.origin[0]! + MONSTER_MAXS[0], m.origin[1]! + MONSTER_MAXS[1], m.origin[2]! + MONSTER_MAXS[2]],
            );
            if (tHit !== null && tHit < bestT) {
              bestT = tHit;
              hitMonster = m;
            }
          }
          if (hitMonster) {
            const hitPos = v3(
              bolt.pos[0]! + seg[0]! * bestT,
              bolt.pos[1]! + seg[1]! * bestT,
              bolt.pos[2]! + seg[2]! * bestT,
            );
            this.blasterImpact(hitPos, bolt.damage, hitMonster);
            dead = true;
          } else {
            const hb = this.barrelSegmentAT(bolt.pos, seg);
            if (hb && !hb.dead) {
              this.damageBarrel(hb, bolt.damage);
              this.blasterImpact(v3(hb.origin[0], hb.origin[1], hb.origin[2]), bolt.damage, null);
              dead = true;
            }
          }
        }
      }
      if (dead) this.bolts.splice(i, 1);
      else bolt.pos = next;
    }
  }

  /** TE_BLASTER impact: sparks + explosion flash + lashit + flesh damage. */
  private blasterImpact(pos: Vec3, damage: number, hitMonster: PlacedMonster | null): void {
    for (let i = 0; i < 40; i++) {
      const ox = (this.rand() * 16 - 8) | 0;
      const oy = (this.rand() * 16 - 8) | 0;
      const oz = (this.rand() * 16 - 8) | 0;
      this.pushColoredSpark(v3(pos[0]! + ox, pos[1]! + oy, pos[2]! + oz), 0xe0 + ((this.rand() * 8) | 0));
    }
    this.explosions.push({ pos: v3(pos[0], pos[1], pos[2]), born: this.server.time });
    this.events.push('explosion');
    this.emitSound('weapons/lashit.wav', v3(pos[0], pos[1], pos[2]));
    if (hitMonster) {
      monsterPain(hitMonster.state, damage, this.rand);
      this.events.push(hitMonster.state.dead ? 'kill' : 'hit');
      if (hitMonster.state.dead) this.message = `${hitMonster.state.kind} down`;
    }
  }

  /** Live barrels whose authentic hull the hitscan segment reaches first. */
  private barrelAT(eye: Vec3, seg: Vec3, bestT: number): Barrel | null {
    let best: Barrel | null = null;
    let bt = bestT;
    for (const b of this.barrels) {
      if (b.dead) continue;
      const tHit = segmentAabb(
        eye, seg,
        [b.origin[0]! + BARREL_MINS[0], b.origin[1]! + BARREL_MINS[1], b.origin[2]! + BARREL_MINS[2]],
        [b.origin[0]! + BARREL_MAXS[0], b.origin[1]! + BARREL_MAXS[1], b.origin[2]! + BARREL_MAXS[2]],
      );
      if (tHit !== null && tHit < bt) {
        bt = tHit;
        best = b;
      }
    }
    return best;
  }

  /** Live barrel along a bolt step segment (point-box test). */
  private barrelSegmentAT(start: Vec3, seg: Vec3): Barrel | null {
    return this.barrelAT(start, seg, 1);
  }

  /** T_Damage on a barrel: fuse-less instant explode (lite) with radius. */
  private damageBarrel(b: Barrel, dmg: number): void {
    if (b.dead) return;
    b.health -= dmg;
    if (b.health > 0) return;
    b.dead = true;
    this.events.push('barrel');
    this.spawnExplosion(b.origin, b.dmg);
  }

  /** Drain recent explosion flashes for the dlight pump (brief TE_BLASTER window). */
  drainExplosions(): Vec3[] {
    const out: Vec3[] = [];
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i]!;
      if (this.server.time - e.born > EXPLOSION_LIGHT_WINDOW) {
        this.explosions.splice(i, 1);
        continue;
      }
      out.push(e.pos);
    }
    return out;
  }

  private traceShot(eye: Vec3, far: Vec3): { fraction: number } {
    const zero = v3();
    if (this.bspTrace) return this.bspTrace(eye, zero, zero, far);
    return devroomTrace(eye, zero, zero, far);
  }

  private pushSpark(pos: Vec3): void {
    this.pushColoredSpark(pos, 200 + ((this.rand() * 55) | 0));
  }

  private pushColoredSpark(pos: Vec3, color: number): void {
    const parts = this.mini.particles as { origin: Vec3; color: number }[];
    parts.push({ origin: v3(pos[0], pos[1], pos[2]), color });
    this.particleBorn.push(this.server.time);
    while (parts.length > 256) {
      parts.shift();
      this.particleBorn.shift();
    }
  }

  /**
   * Age out driver-pushed sparks older than SPARK_TTL. World-seeded
   * particles (born +Infinity, e.g. the devroom torch flame) never match
   * and are preserved; the length guards realign if the world ever ships
   * more seeded particles than the driver has births for, or vice versa.
   * Called every server tick before stepBolts so fresh impact sparks
   * (age 0) survive.
   */
  private sweepParticles(): void {
    const parts = this.mini.particles;
    while (this.particleBorn.length < parts.length) this.particleBorn.unshift(Infinity);
    while (this.particleBorn.length > parts.length) this.particleBorn.shift();
    for (let i = parts.length - 1; i >= 0; i--) {
      if (this.server.time - this.particleBorn[i]! > SPARK_TTL) {
        parts.splice(i, 1);
        this.particleBorn.splice(i, 1);
      }
    }
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

/**
 * Convert a parsed `pics/conchars.pcx` into @q2/client 1bpp font bytes.
 * Passes straight through the @q2/client loader (`loadConcharsFont`, which
 * owns the 128x128 16x16-grid layout + TRANSPARENT_COLOR 255 rule); a lump
 * of the wrong shape (or a loader throw) yields null and the caller keeps
 * the procedural fallback. Pure function: headless/Node safe.
 */
export function concharsFontFromPCX(pcx: Pcx): ConcharsFont | null {
  try {
    return loadConcharsPixels(pcx);
  } catch {
    return null;
  }
}

/**
 * Load the HUD font from a pak (`pics/conchars.pcx` via parsePCX).
 * Returns null when the pak is absent or the lump is missing/unparseable —
 * the caller falls back to the procedural font. Headless/Node safe
 * (no IndexedDB/DOM; parsePCX + setConcharsFont are pure).
 */
export function loadConcharsFont(pak: WebPak | null): ConcharsFont | null {
  if (!pak) return null;
  const bytes = tryPakEntry(pak, 'pics/conchars.pcx');
  if (!bytes) return null;
  try {
    return concharsFontFromPCX(parsePCX(bytes));
  } catch {
    return null;
  }
}

/**
 * Nearest-color remap of 8-bit `pixels` from lump palette `src` to the
 * engine's global palette `dst` (both 768-byte RGB). Fast path: identical
 * palettes (the common case — id art shares one palette) return the input
 * untouched. Else a 256-entry LUT is built once per face (65k distance
 * evaluations) and applied. Pure, headless-safe.
 */
export function remapToPalette(pixels: Uint8Array, src: Uint8Array, dst: Uint8Array): Uint8Array {
  let identical = src.length === dst.length;
  if (identical) {
    for (let i = 0; i < src.length; i++) {
      if (src[i] !== dst[i]) {
        identical = false;
        break;
      }
    }
  }
  if (identical) return pixels;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const r = src[i * 3]!, g = src[i * 3 + 1]!, b = src[i * 3 + 2]!;
    let best = 0, bd = Infinity;
    for (let j = 0; j < 256; j++) {
      const dr = dst[j * 3]! - r, dg = dst[j * 3 + 1]! - g, db = dst[j * 3 + 2]! - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    lut[i] = best;
  }
  const out = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) out[i] = lut[pixels[i]!]!;
  return out;
}

/** Face suffixes in the renderer's strip packing order (top-to-bottom). */
const SKY_SUFFIXES = ['rt', 'bk', 'lf', 'ft', 'up', 'dn'] as const;

/** Worldspawn `sky` key for a map (base1 = "unit1_"), null when absent. */
export function skyNameForMap(map: BspMap | null): string | null {
  if (!map) return null;
  for (const d of parseEntities(map.entities)) {
    if (d['classname'] === 'worldspawn') {
      const s = (d['sky'] ?? '').trim();
      return s ? s : null;
    }
  }
  return null;
}

/**
 * Load id's six `env/<sky>{rt,bk,lf,ft,up,dn}.pcx` sky faces and pack them
 * into the renderer's single-texture contract: vertical strip of 6 tiles,
 * top-to-bottom in suffix order (see `setSkyTexture` in sw-renderer/sky.ts).
 * Returns null when any face is missing/unparseable or sizes disagree — the
 * renderer then keeps its flat-fill fallback. Indices are remapped onto the
 * engine palette (normally a no-op: id art shares one palette).
 */
export function loadSkyStrip(
  pak: WebPak,
  sky: string,
  mainPalette: Uint8Array,
): { texels: Uint8Array; width: number; height: number } | null {
  const faces: Pcx[] = [];
  for (const suf of SKY_SUFFIXES) {
    const bytes = tryPakEntry(pak, `env/${sky}${suf}.pcx`);
    if (!bytes) return null;
    try {
      faces.push(parsePCX(bytes));
    } catch {
      return null;
    }
  }
  const w = faces[0]!.width, h = faces[0]!.height;
  if (w <= 0 || h <= 0) return null;
  for (const f of faces) {
    if (f.width !== w || f.height !== h || f.pixels.length !== w * h) return null;
  }
  const strip = new Uint8Array(w * h * 6);
  for (let i = 0; i < 6; i++) {
    strip.set(remapToPalette(faces[i]!.pixels, faces[i]!.palette, mainPalette), i * w * h);
  }
  return { texels: strip, width: w, height: h * 6 };
}

export interface PlayBoot {
  host: Host;
  driver: LocalDriver;
  refresh: SoftwareRenderer;
  renderer: RendererKind;
  source: 'devroom' | 'pak';
  display: Uint32Array;
  fb565: Uint16Array;
  /** Real-pak MD2/skin handles (null without a pak). */
  models: PakModelHandles | null;
}

/**
 * Register the real pak MD2 view/monster/bolt models + PCX skins
 * (TODO(M1.2 follow-up) wiring). Tables come from `@q2/game/assets`
 * (`modelForMonster`, `viewModelForWeapon`, …), parsing from `@q2/formats`
 * (`parseMD2`/`parsePCX`), storage from the renderer's `registerModel` MD2
 * path + `registerSkinData/Pixels`.
 *
 * Registration ORDER is the contract: the soldier skin is skin handle 0 and
 * the soldier mesh is model handle 0, because `Host.renderCurrentView`
 * hardcodes `model: 0, skin: 0` for every snapshot entity (packages/host —
 * outside this package's ownership, so per-kind entity models and skins
 * still share the soldier handles). Per-entity MD2 frames DO vary: the
 * driver maps them through the move tables via the HostDriver entityFrame
 * contract. First-person gun: the 3D view model renders camera-attached via
 * the HostDriver viewModel contract, and the 2D silhouette is skipped when
 * a pak view model is registered (see usesViewModel3D).
 * Until per-kind model selection lands, every monster renders as the
 * soldier mesh/skin. Per-file fallback is the box-critter so one corrupt
 * lump can never shift later handles or break the boot.
 */
export interface PakModelHandles {
  /** Model handle 0: soldier MD2 (or box-critter fallback). */
  monster: number;
  /** PCX skin handle for the soldier MD2 (handle 0, registered first). */
  monsterSkin: number;
  gunner: number;
  /** PCX skin handle for the gunner MD2. */
  gunnerSkin: number;
  weapons: Record<string, number>;
  /** PCX skin handle per weapon classname (parallel to `weapons`). */
  weaponSkins: Record<string, number>;
  bolt: number;
  /** PCX skin handle for the laser-bolt MD2. */
  boltSkin: number;
  /** Shootable explobox (g_misc.c `models/objects/barrels/tris.md2`). */
  barrel: number;
  /** PCX skin for the barrel MD2. */
  barrelSkin: number;
  skins: number[];
}

export function registerPakModels(refresh: SoftwareRenderer, pak: WebPak): PakModelHandles {
  createDevroom(); // guarantees getDevMesh(0) exists for per-file fallbacks
  const skins: number[] = [];
  const ext = refresh as unknown as {
    registerSkinData?: (name: string, texels: Uint8Array, width: number, height: number) => number;
  };
  const loadSkin = (path: string): number => {
    try {
      const bytes = tryPakEntry(pak, path);
      if (bytes && typeof ext.registerSkinData === 'function') {
        const pcx = parsePCX(bytes);
        const h = ext.registerSkinData(path, pcx.pixels, pcx.width, pcx.height);
        skins.push(h);
        return h;
      }
    } catch {
      /* fall through to the checker fallback */
    }
    const h = refresh.registerSkin(path);
    skins.push(h);
    return h;
  };
  const loadModel = (path: string): number => {
    try {
      const bytes = tryPakEntry(pak, path);
      if (bytes) return refresh.registerModel({ name: path, kind: 'md2', data: parseMD2(bytes) });
    } catch {
      /* fall through to the box-critter fallback */
    }
    return refresh.registerModel({ name: path, kind: 'md2', data: getDevMesh(0) });
  };
  // Soldier first: skin handle 0 + model handle 0 (see contract above).
  const monsterSkin = loadSkin(skinForMonster('soldier'));
  const monster = loadModel(modelForMonster('soldier'));
  const gunnerSkin = loadSkin(skinForMonster('gunner'));
  const gunner = loadModel(modelForMonster('gunner'));
  const weapons: Record<string, number> = {};
  const weaponSkins: Record<string, number> = {};
  for (const cls of ['weapon_blaster', 'weapon_shotgun', 'weapon_machinegun']) {
    const mdl = viewModelForWeapon(cls);
    if (!mdl) continue;
    weaponSkins[cls] = loadSkin(skinForWeaponModel(mdl));
    weapons[cls] = loadModel(mdl);
  }
  const boltSkin = loadSkin(skinForBolt());
  const bolt = loadModel(modelForBolt());
  // Barrel last: appending keeps every existing handle stable (soldier 0,
  // gunner, weapons, bolt). Missing lump → box-critter fallback, never a
  // shifted handle.
  const barrelSkin = loadSkin(BARREL_SKIN);
  const barrel = loadModel(BARREL_MODEL);
  return { monster, monsterSkin, gunner, gunnerSkin, weapons, weaponSkins, bolt, boltSkin, barrel, barrelSkin, skins };
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
  let mainPalette: Uint8Array | null = null;
  if (opts.pak) {
    const pcxBytes = tryPakEntry(opts.pak, 'pics/colormap.pcx');
    if (pcxBytes) {
      try {
        mainPalette = parsePCX(pcxBytes).palette;
        refresh.setPalette(mainPalette);
      } catch {
        /* procedural palette fallback */
      }
    }
    // Original Quake II sky: six env/ faces packed as one strip (id mapping).
    // Missing/unparseable art → renderer keeps its flat-fill fallback.
    if (driver.map && mainPalette) {
      const sky = skyNameForMap(driver.map);
      if (sky) {
        const strip = loadSkyStrip(opts.pak, sky, mainPalette);
        if (strip) {
          try {
            refresh.setSkyTexture(strip);
          } catch {
            /* flat-fill fallback stays active */
          }
        }
      }
    }
  }
  // HUD font: real `pics/conchars.pcx` when the pak ships it, procedural
  // xorshift fallback otherwise (deterministic per boot so tests are
  // order-independent despite the global active font).
  try {
    setConcharsFont(loadConcharsFont(opts.pak ?? null) ?? makeConcharsFont());
  } catch {
    /* procedural font already active via getConcharsFont() */
  }
  const host = new Host({
    refresh,
    width,
    height,
    indexed: true,
    world: { name: driver.source === 'pak' ? 'maps/base1' : 'maps/devroom', data: driver.mini },
    driver,
  });
  // M8.1: opt into SAB banding when the operator set sw_workers (cvar panel
  // or console). Silent fallback to the single-threaded path everywhere the
  // banded path is unavailable (default cvar 0, no SAB, Node/vitest).
  try {
    refresh.syncWorkersFromCvar();
  } catch {
    /* single-threaded path stays active */
  }
  // Monster placeholder mesh must be handle 0: register before anything else.
  // With a pak, register the real MD2s + PCX skins (soldier first so the
  // Host's hardcoded model:0/skin:0 entities render as the real mesh);
  // without one, keep the procedural box-critter exactly as before.
  let models: PakModelHandles | null = null;
  if (opts.pak) {
    models = registerPakModels(refresh, opts.pak);
    driver.models = models;
  } else if (driver.monsters.length > 0) {
    createDevroom();
    host.refresh.registerModel({ name: 'monster', kind: 'md2', data: getDevMesh(0) });
  }
  const n = width * height;
  return { host, driver, refresh, renderer, source: driver.source, display: new Uint32Array(n), fb565: new Uint16Array(n), models };
}

/** Resolve the software framebuffer for display (voodoo post chain or direct).
 *
 * Display-only `r_brightness` lift (see `getBrightness`) is applied to the
 * scene copy here, *before* `drawPlayHud` paints on top — so HUD text keeps
 * its full authored colour and is never dimmed or clipped by the lift.
 * At 1.0 the software path returns the engine buffer untouched
 * (byte-identical, same reference).
 */
export function resolveDisplay(boot: PlayBoot): Uint32Array {
  const { host } = boot;
  const brightness = getBrightness();
  if (getCVarString('vid_renderer') === 'voodoo') {
    resolveFrame(host.fb.color, boot.fb565, boot.display, host.fb.width, host.fb.height);
    applyBrightness(boot.display, brightness);
    return boot.display;
  }
  if (brightness === 1) return host.fb.color;
  boot.display.set(host.fb.color);
  applyBrightness(boot.display, brightness);
  return boot.display;
}

/**
 * Pump the one-shot muzzle-flash dynamic light into the renderer. Call
 * before the frame renders (the dom rAF tick does this; headless tests call
 * it directly). Clears the renderer's dlight list first so the flash can
 * never accumulate — exactly one add per shot, baseline restored on expiry.
 * The clear hook is feature-detected (a future expiry hook wins when
 * present). No-op once the flash window expires or was already drained.
 */
export function pumpMuzzleLight(boot: PlayBoot): boolean {
  const hooks = boot.refresh as unknown as {
    testExpireDynamicLights?: () => void;
    testClearDynamicLights?: () => void;
  };
  if (typeof hooks.testExpireDynamicLights === 'function') {
    hooks.testExpireDynamicLights();
  } else if (typeof hooks.testClearDynamicLights === 'function') {
    hooks.testClearDynamicLights();
  }
  const pos = boot.driver.drainFlash();
  if (!pos) return false;
  boot.refresh.testAddDynamicLight({
    origin: new Float32Array([pos[0]!, pos[1]!, pos[2]!]),
    intensity: boot.driver.peekFlashIntensity(),
    color: new Float32Array([1, 1, 0]),
  });
  return true;
}

/**
 * Pump one in-flight dlight per live blaster bolt (id CL_BlasterTrail /
 * V_AddLight: 200-intensity pure yellow every frame). Same
 * testAddDynamicLight path as the muzzle/explosion pumps; call alongside
 * them before the frame renders. The dom tick wires muzzle + explosion;
 * wire this next to them when the tick is next touched (dom.ts is outside
 * this change's file lock, so headless/tests pump it explicitly).
 */
export function pumpBoltLights(boot: PlayBoot): number {
  let n = 0;
  for (const bolt of boot.driver.bolts) {
    boot.refresh.testAddDynamicLight({
      origin: new Float32Array([bolt.pos[0]!, bolt.pos[1]!, bolt.pos[2]!]),
      intensity: 200,
      color: new Float32Array([1, 1, 0]),
    });
    n++;
  }
  return n;
}

/** Pump explosion/bolt-impact dlights (TE_BLASTER yellow, 150 intensity). */
export function pumpExplosionLights(boot: PlayBoot): number {
  const poss = boot.driver.drainExplosions();
  let n = 0;
  for (const pos of poss) {
    boot.refresh.testAddDynamicLight({
      origin: new Float32Array([pos[0]!, pos[1]!, pos[2]!]),
      intensity: 150,
      color: new Float32Array([1, 1, 0]),
    });
    n++;
  }
  return n;
}

/** Renderer-owned tracer ttl in frames (~0.1s at 60fps). */
export const TRACER_TTL_FRAMES = 6;

/**
 * Pump queued driver beams into the renderer's `spawnTracer` pool. Call
 * before the frame renders (the dom rAF tick does this, next to
 * pumpMuzzleLight; headless tests call it directly). Feature-detected like
 * the muzzle pump: without `spawnTracer` the queue is still drained (so it
 * can never grow across frames) and 0 is returned. Returns beams accepted.
 */
export function pumpTracers(boot: PlayBoot): number {
  const hooks = boot.refresh as unknown as {
    spawnTracer?: (
      origin: ArrayLike<number>,
      dir: ArrayLike<number>,
      color?: number,
      length?: number,
      ttlFrames?: number,
    ) => boolean;
  };
  const queued = boot.driver.drainTracers();
  if (typeof hooks.spawnTracer !== 'function') return 0;
  let n = 0;
  for (const t of queued) {
    if (hooks.spawnTracer(t.origin, t.dir, t.color, t.length, TRACER_TTL_FRAMES)) n++;
  }
  return n;
}

export interface HudState {
  fps: number;
  frame: number;
}

/** In-canvas fps readout colour: readable green, 0xAABBGGRR like all HUD. */
export const FPS_GREEN = 0xff00ff00;

/**
 * Pure anchor for the in-canvas fps readout: top-right, 8px margins, using
 * the active conchars font metrics (real pak glyphs when present, procedural
 * fallback otherwise — both are 8px-advance via `stringWidth`). No
 * background rect is ever drawn behind the text.
 */
export function fpsHudAnchor(width: number, text: string): { x: number; y: number } {
  return { x: Math.max(0, width - stringWidth(text) - 8), y: 8 };
}

/** `cl_showfps` gates the in-canvas fps readout too (default 1 when absent). */
function showInCanvasFps(): boolean {
  if (getCVar('cl_showfps') === undefined) return true;
  return getCVarNumber('cl_showfps') !== 0;
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
  // 3D view model (pak) replaces the 2D silhouette — never double-draw.
  if (usesViewModel3D(boot)) drawDeathBars(target, boot);
  else drawViewModel(target, boot);
  const o = boot.driver.pm.origin;
  const hp = boot.driver.playerHealth;
  const hpColor = boot.driver.playerDead ? 0xffff3333 : hp <= 25 ? 0xffff9933 : white;
  if (showInCanvasFps()) {
    const fpsText = `fps ${hud.fps.toFixed(0)}`;
    const anchor = fpsHudAnchor(target.width, fpsText);
    drawString(target, anchor.x, anchor.y, fpsText, FPS_GREEN);
  }
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
 * Whether the first-person gun renders as a real 3D `v_weap` MD2 (via the
 * HostDriver viewModel contract) instead of the 2D `fillRect` silhouette.
 * True exactly when the selected weapon has a registered pak view model.
 */
export function usesViewModel3D(boot: PlayBoot): boolean {
  return boot.models?.weapons[boot.driver.weapon.classname] !== undefined;
}

/** Red edge bars while dead (extracted so they survive the 2D-gun removal). */
function drawDeathBars(
  target: { width: number; height: number; color: Uint32Array },
  boot: PlayBoot,
): void {
  if (!boot.driver.playerDead) return;
  const w = target.width;
  const h = target.height;
  fillRect(target, 0, 0, w, 3, 0xffff2222);
  fillRect(target, 0, h - 3, w, 3, 0xffff2222);
}
/**
 * 2D `fillRect` gun silhouette bottom-right + muzzle flash rect — the
 * fallback when no 3D `v_weap` MD2 is registered for the selected weapon
 * (devroom / missing lump; see usesViewModel3D). With a pak the Host
 * renders the real camera-attached MD2 via the viewModel contract and this
 * icon is skipped (no double-draw).
 * Per-weapon body size/shape/caption already differ (blaster 52px,
 * machinegun 66px, shotgun 78px), so the selected weapon changes the
 * visible model. The 3D muzzle dlight is pumped separately via
 * drainFlash(), and bolt/pellet beams via pumpTracers().
 * Drawn post-resolve in HUD space (the software renderer has no
 * screen-space sprite path).
 *
 * The silhouette is a side-view breakdown — stepped wooden/polymer stock,
 * receiver with top highlight + bottom shade, thin barrel with muzzle ring,
 * grip, trigger guard, and sights — so it reads as an intentional low-res
 * sprite rather than stacked blobs. `fillRect` only (2D nicety, no MD2).
 */
function drawViewModel(
  target: { width: number; height: number; color: Uint32Array },
  boot: PlayBoot,
): void {
  const w = target.width;
  const h = target.height;
  const cls = boot.driver.weapon.classname;
  const isShotgun = cls === 'weapon_shotgun';
  const isMachinegun = cls === 'weapon_machinegun';
  const gunW = isShotgun ? 78 : isMachinegun ? 66 : 52;
  const gx = w - gunW - 10;
  const gy = h - 36;
  if (w < 120 || h < 100) return;
  const body = isShotgun ? 0xff6b4a26 : isMachinegun ? 0xff4a4a52 : 0xff3a3f44;
  const dark = 0xff1c1c20;
  const edge = 0xff101014;
  const gripC = 0xff2a2018;
  const wood = 0xff7a4d22;
  const steel = 0xff777782;
  const lite = 0xff9a9aa2;
  const muzzleX = gx + gunW - 2;
  // Stock: stepped taper toward the butt (left), wood on shotgun, dark else.
  const stockC = isShotgun ? wood : dark;
  fillRect(target, gx, gy + 14, 10, 10, stockC);
  fillRect(target, gx + 10, gy + 11, 8, 13, stockC);
  fillRect(target, gx, gy + 14, 18, 1, lite);
  // Receiver: main block with top highlight and bottom shade line.
  fillRect(target, gx + 18, gy + 9, 24, 13, body);
  fillRect(target, gx + 18, gy + 9, 24, 1, lite);
  fillRect(target, gx + 18, gy + 21, 24, 1, edge);
  // Barrel: thin steel tube + darker muzzle ring at the tip.
  fillRect(target, gx + 42, gy + 11, gunW - 48, 5, steel);
  fillRect(target, gx + 42, gy + 11, gunW - 48, 1, lite);
  fillRect(target, muzzleX - 3, gy + 10, 3, 7, dark);
  // Grip + trigger guard below the receiver.
  fillRect(target, gx + 22, gy + 22, 7, 7, gripC);
  fillRect(target, gx + 31, gy + 22, 6, 2, edge);
  // Rear notch + front post sights above the top line.
  fillRect(target, gx + 20, gy + 6, 2, 3, edge);
  fillRect(target, muzzleX - 5, gy + 7, 2, 4, edge);
  if (isShotgun) {
    // Wooden pump under the barrel.
    fillRect(target, gx + 46, gy + 17, 14, 5, wood);
    fillRect(target, gx + 46, gy + 17, 14, 1, lite);
  } else if (isMachinegun) {
    // Boxy magazine + top carry handle.
    fillRect(target, gx + 30, gy + 22, 9, 8, dark);
    fillRect(target, gx + 30, gy + 22, 9, 1, lite);
    fillRect(target, gx + 22, gy + 6, 14, 3, dark);
  } else {
    // Blaster: side cooling fins + glowing tip.
    fillRect(target, gx + 26, gy + 9, 2, 13, edge);
    fillRect(target, gx + 32, gy + 9, 2, 13, edge);
    fillRect(target, muzzleX - 1, gy + 12, 2, 3, 0xff66eeff);
  }
  if (boot.driver.muzzleLit()) {
    // Flash star at the muzzle + a soft glow wash over the gun.
    const bcy = gy + 13;
    fillRect(target, muzzleX - 8, bcy - 7, 18, 15, 0xffffee88);
    fillRect(target, muzzleX - 12, bcy - 2, 26, 5, 0xffffee88);
    fillRect(target, muzzleX - 6, bcy - 4, 14, 9, 0xffffffff);
    fillRect(target, gx, gy + 6, gunW, 24, 0x66ffdd66);
  }
  if (boot.driver.playerDead) {
    drawDeathBars(target, boot);
  }
  // Placeholder caption: short weapon name above the silhouette.
  const short = cls.replace(/^weapon_/, '');
  if (w >= 120 && h >= 100) drawString(target, gx, gy - 10, short, 0xffbbbbbb);
}
