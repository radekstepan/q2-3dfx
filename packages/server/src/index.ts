// @q2/server — SV_: world state, entity spawning, 10Hz tick. M5.2 owns this.
// In-process server: SV_Tick advances level.time by SERVER_DT (0.1s) and
// runs entities (movers, triggers). Quake coords/angles per BRAIN.md §5.

import { SERVER_DT } from '@q2/config';
import {
  DoRespawn,
  EXPLOBOX_MAXS,
  EXPLOBOX_MINS,
  MONSTER_HULL_MAXS,
  MONSTER_HULL_MINS,
  MONSTER_STEP_HEIGHT,
  MOVER_BOTTOM,
  MOVER_GOING_UP,
  MOVER_TOP,
  MOVER_WAITING,
  SetRespawn,
  barrelDebrisSpeeds,
  barrelFuseAt,
  blasterMuzzle,
  blasterSpawn,
  doorTravel,
  explosionBaseframe,
  explosionFrames,
  findWeapon,
  fireWeapon,
  funcExplosiveDebris,
  monsterChaseMove,
  monsterFlashOffset,
  monsterLocomotion,
  monsterPain,
  monsterThink,
  moverThink,
  moverUse,
  muzzleRadius,
  parseEntities,
  parseFloat,
  projectSource,
  radiusDamageAttackerPoints,
  radiusDamagePoints,
  radiusDamageRadius,
  respawnDelayFor,
  resetEdictNums,
  soldierWeaponForSkin,
  spawnButton,
  spawnDoor,
  spawnEdict,
  spawnExplosive,
  spawnMonster,
  spawnPlat,
  spawnTrigger,
  targetExplosionFuseAt,
  triggerTouch,
  BOLT_LIFE,
  BOLT_SPEED,
  BLASTER_TRAIL_COLOR,
  GIB_SOUND,
  HITSCAN_TRACER_COLOR,
  SOLDIER_WEAPON_STATS,
  MZ2_GUNNER_GRENADE_1,
  MZ2_GUNNER_MACHINEGUN_1,
  MZ2_SOLDIER_BLASTER_1,
  MZ2_SOLDIER_MACHINEGUN_1,
  MZ2_SOLDIER_SHOTGUN_1,
} from '@q2/game';
import type {
  AttackChoice,
  Edict,
  MonsterKind,
  MonsterNav,
  MonsterState,
  Mover,
  TraceFn,
  Trigger,
} from '@q2/game';
import {
  bspContentsFor,
  setPmoveWorld,
} from '@q2/game';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import { AngleVectors } from '@q2/math';
import { traceBox } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';

export interface ServerState {
  /** level.time in seconds (float). Never wall-clock. */
  time: number;
  /**
   * Skill level 0-3 (id `skill` cvar, default 1 = medium). Set via
   * SV_SetSkill (floor + clamp, g_spawn.c). Gates entity inhibit at spawn
   * (SPAWNFLAG_NOT_*), easy-mode damage halving (g_combat.c) and the
   * monster tick's reported damage scale.
   */
  skill: number;
  entities: Edict[];
  movers: Mover[];
  triggers: Trigger[];
  /** scripted movers: func_train + misc_strogg_ship (path_corner chains) */
  trains: Train[];
  /** monster bodies: every spawned monster_* edict (g_monster.c) */
  monsters: ServerMonster[];
  /** fired targetnames this tick (test/diagnostics hook) */
  firedThisTick: string[];
  /** per-tick mover displacement by edict num (SV_Push rider carrying) */
  moverDeltas: Map<number, Vec3>;
  /** brush-model bounds by mover edict num (for rider stand tests) */
  moverBounds: Map<number, { mins: Float32Array; maxs: Float32Array }>;
  /**
   * brush-model bounds by trigger edict num. Brush triggers (model *N) have
   * no usable edict origin (it defaults to the world origin 0,0,0), so
   * volume overlap can only be tested when the BSP side supplied bounds via
   * the modelSizes hook. Triggers without bounds never fire from the point
   * hook — firing them by proximity to 0,0,0 is always spurious.
   */
  triggerBounds: Map<number, { mins: Float32Array; maxs: Float32Array }>;
  /**
   * Solid brush-model clips by edict num (func_explosive / func_wall).
   * In C these are SOLID_BSP from spawn until destroyed (SP_func_explosive,
   * SP_func_wall): they block movement while standing. SV_SpawnEntities
   * records their world-space bounds here when modelSizes resolves them;
   * SV_RemoveBrushClip drops the entry when the brush is destroyed
   * (func_explosive_explode / G_FreeEdict). Drivers feed this registry into
   * SV_ClipTrace so walls block before detonation and open after.
   */
  brushClips: Map<number, { mins: Float32Array; maxs: Float32Array }>;
  // --- Phase 0 single sim: server-owned gameplay state --------------------
  //
  // The browser used to run a private driver sim alongside the server tick
  // and rendered only the driver sim, so server fixes never reached the
  // screen (BRAIN.md §15). Phase 0 inverts this: the server owns barrels,
  // bolts, explosions + muzzle/tracer/spark/sound events, debris/gibs and
  // the player health pool. The driver renders from this state and forwards
  // input via SV_PlayerFire. Drained/consumed by the driver every tick;
  // SV_Tick prunes the time-lived ones.
  /** Flying blaster bolts (player + foe edicts: move, wall/flesh touch). */
  bolts: ServerBolt[];
  /** Shootable barrels (misc_explobox bottom-origin + func_explosive center). */
  barrels: ServerBarrel[];
  /** Live explosion visuals (TE_EXPLOSION1/2, TE_BLASTER touch flashes). */
  explosions: ServerExplosion[];
  /** Pending muzzle-flash dlight requests (player + enemy, one-shot). */
  muzzles: ServerMuzzle[];
  /** Pending hitscan tracer beams (short muzzle streaks, never eye-ending). */
  tracers: ServerTracer[];
  /** Pending particle-burst requests (impacts, trails, booms). */
  sparks: ServerSpark[];
  /** Pending positional-sound requests (shots, impacts). */
  sounds: ServerSound[];
  /** Thrown debris chunks (barrel/func_explosive, SV_Physics_Toss-lite). */
  debris: ServerDebris[];
  /** Gib chunks (minced monsters, MOVETYPE_TOSS-lite). */
  gibs: ServerGib[];
  /** Pending 0.2s barrel fuses / target_explosion delays (server time). */
  fuses: ServerFuse[];
  /** Scripted explosion targets (target_explosion) by targetname. */
  explosionTargets: Map<string, { origin: Vec3; dmg: number; delay: number }>;
  /** Authoritative player health (the driver mirrors it into HUD state). */
  playerHealth: number;
  playerMaxHealth: number;
}

export function SV_Init(): ServerState {
  return { time: 0, skill: 1, entities: [], movers: [], trains: [], monsters: [], triggers: [] as Trigger[], firedThisTick: [], moverDeltas: new Map(), moverBounds: new Map(), triggerBounds: new Map(), brushClips: new Map(), bolts: [], barrels: [], explosions: [], muzzles: [], tracers: [], sparks: [], sounds: [], debris: [], gibs: [], fuses: [], explosionTargets: new Map(), playerHealth: 100, playerMaxHealth: 100 };
}

/** Link an edict into the world (SV_LinkEdict: register + solid bookkeeping). */
export function SV_LinkEdict(st: ServerState, e: Edict): void {
  if (!st.entities.includes(e)) st.entities.push(e);
}

// --- skill (game/g_spawn.c, game/g_combat.c) ---------------------------------
//
// The id `skill` cvar (0 easy, 1 medium, 2 hard, 3 nightmare; default 1).
// Concrete game effects, ported verbatim where they touch the server:
// - Spawn inhibit (g_spawn.c SpawnEntities): entities carrying
//   SPAWNFLAG_NOT_EASY/MEDIUM/HARD never spawn at the matching skill. This is
//   why base1's 1792-flagged ammo caches and the exit machinegun are
//   deathmatch-only, and why two ambush infantries appear only at skill 2+.
// - Easy damage halving (g_combat.c T_Damage): skill 0 halves damage dealt
//   to the player (minimum 1, applied driver-side).
// NOT flags are stripped from spawned edicts after the check, exactly like C.

export const SPAWNFLAG_NOT_EASY = 256;
export const SPAWNFLAG_NOT_MEDIUM = 512;
export const SPAWNFLAG_NOT_HARD = 1024;
export const SPAWNFLAG_NOT_DEATHMATCH = 2048;
export const SPAWNFLAG_NOT_COOP = 4096;

/**
 * func_door spawnflag: monsters never trip this door (id g_func.c
 * Touch_DoorTrigger). Local copy — @q2/game owns the mover sim and only
 * re-exports DOOR_START_OPEN/DOOR_TOGGLE; like the SPAWNFLAG_* bits above,
 * the server keeps its own copy for spawn/touch gating (same value, C-cited).
 */
export const DOOR_NOMONSTER = 8;

/** True when the entity is inhibited at `skill` (g_spawn.c SpawnEntities). */
export function inhibitedBySkill(spawnflags: number, skill: number): boolean {
  if (skill === 0 && spawnflags & SPAWNFLAG_NOT_EASY) return true;
  if (skill === 1 && spawnflags & SPAWNFLAG_NOT_MEDIUM) return true;
  if ((skill === 2 || skill === 3) && spawnflags & SPAWNFLAG_NOT_HARD) return true;
  return false;
}

/**
 * Damage dealt TO the player scales by this (g_combat.c: easy halves it).
 * Health is not skill-scaled in id (only damage, pain, aim and the roster).
 */
export function skillMultiplier(skill: number): number {
  return skill <= 0 ? 0.5 : 1;
}

/**
 * Set the skill level (id skill cvar: floor + clamp to 0-3, g_spawn.c).
 * Returns the applied level.
 */
export function SV_SetSkill(st: ServerState, skill: number): number {
  let s = Math.floor(skill);
  if (!Number.isFinite(s)) s = 1;
  if (s < 0) s = 0;
  if (s > 3) s = 3;
  st.skill = s;
  return s;
}

// --- C-authentic contents masks (game/q_shared.h) --------------------------
//
// The game-side default (MASK_PLAYERSOLID = 1 in @q2/game/collision.ts) only
// tests CONTENTS_SOLID. The C engine collides the player against
// MASK_PLAYERSOLID = SOLID|PLAYERCLIP|WINDOW|MONSTER and walks monsters with
// MASK_MONSTERSOLID = SOLID|MONSTERCLIP|WINDOW|MONSTER; sight checks run eye
// to eye against MASK_OPAQUE = SOLID|SLIME|LAVA. Base1 seals stairs and
// ledges with PLAYERCLIP detail brushes (36 in this map) and glass with
// WINDOW (7): a mask-1 trace falls straight through those floors, including
// spots where the player box exits the world volume entirely (the reported
// clip-through/void). traceBox itself is mask-correct — only the mask handed
// in was wrong — so these server-owned helpers hand in the C masks.

export const CONTENTS_SOLID = 1;
export const CONTENTS_WINDOW = 2;
export const CONTENTS_SLIME = 16;
export const CONTENTS_LAVA = 8;
export const CONTENTS_PLAYERCLIP = 0x10000;
export const CONTENTS_MONSTERCLIP = 0x20000;
export const CONTENTS_MONSTER = 0x2000000;

/** C MASK_PLAYERSOLID (SOLID|PLAYERCLIP|WINDOW|MONSTER, q_shared.h). */
export const MASK_PLAYERSOLID_C =
  CONTENTS_SOLID | CONTENTS_WINDOW | CONTENTS_PLAYERCLIP | CONTENTS_MONSTER;
/** C MASK_MONSTERSOLID (SOLID|MONSTERCLIP|WINDOW|MONSTER, q_shared.h). */
export const MASK_MONSTERSOLID_C =
  CONTENTS_SOLID | CONTENTS_WINDOW | CONTENTS_MONSTERCLIP | CONTENTS_MONSTER;
/** C MASK_OPAQUE (SOLID|SLIME|LAVA: the visible() sight mask, g_ai.c). */
export const MASK_OPAQUE_C = CONTENTS_SOLID | CONTENTS_SLIME | CONTENTS_LAVA;

/** Monster eye height above origin (walkmonster_start_go, g_monster.c). */
export const MONSTER_VIEWHEIGHT = 25;
/** Standing player eye height (pmove_t.viewheight default, pmove.c). */
export const PLAYER_VIEWHEIGHT = 22;

/** Swept-box world trace with the C player mask (CM_BoxTrace, model 0). */
export function SV_TraceFor(map: BspMap, mask: number = MASK_PLAYERSOLID_C): TraceFn {
  return (start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => {
    const t = traceBox(map, start, end, mins, maxs, mask);
    return {
      fraction: t.fraction,
      endpos: t.endpos,
      planeNormal: t.planeNormal,
      allsolid: t.allsolid,
      startsolid: t.startsolid,
      entityNum: t.entityNum,
      contents: t.contents,
    };
  };
}

/**
 * C M_droptofloor grounding trace (game/g_monster.c): id drops walkmonsters
 * AND exploboxes with `gi.trace(..., MASK_MONSTERSOLID)` — never the player
 * mask and never mask 1. A mask-1 trace misses clip-sealed decks (base1's
 * start-room soldier at (348,-348,-64) falls to -86.27, below the true
 * -83.97 floor both C masks hit) so spawn grounding must run through this,
 * not through a generic world trace. Pass it as SV_SpawnEntities' dropTrace.
 */
export function SV_DropTraceFor(map: BspMap): TraceFn {
  return SV_TraceFor(map, MASK_MONSTERSOLID_C);
}

/**
 * Install C-mask world hooks for pmove. Same shape as the game-side
 * setPmoveWorldFromBsp but with MASK_PLAYERSOLID_C, so clip-deck floors and
 * stairs the mapper sealed with PLAYERCLIP/WINDOW hold the player the way
 * the C engine holds them.
 */
export function SV_SetPmoveWorldFromBsp(map: BspMap): void {
  setPmoveWorld(SV_TraceFor(map), bspContentsFor(map));
}

export function SV_SpawnMover(st: ServerState, m: Mover): void {
  SV_LinkEdict(st, m.ent);
  st.movers.push(m);
}

export function SV_SpawnTrigger(st: ServerState, t: Trigger, bounds?: { mins: Float32Array; maxs: Float32Array }): void {
  SV_LinkEdict(st, t.ent);
  st.triggers.push(t);
  if (bounds) st.triggerBounds.set(t.ent.num, bounds);
}

/**
 * Drop a brush clip when its brush is destroyed (func_explosive_explode with
 * or without dmg — BecomeExplosion1 frees the edict either way; G_FreeEdict
 * for damageless ones — and G_FreeEdict for func_wall). The opening stays
 * open; whatever world floor the mapper left beneath catches the fall.
 */
export function SV_RemoveBrushClip(st: ServerState, ent: Edict): void {
  st.brushClips.delete(ent.num);
}

/**
 * Swept player/monster box vs one static brush AABB. Same conventions as the
 * traversal driver's door sweep (CM_ClipBoxToBrush: starting inside only
 * stops the move when the end is inside too; bodies resting exactly on the
 * slab boundary keep moving).
 */
export function sweepBrushBox(
  start: Vec3, end: Vec3,
  mins: Vec3, maxs: Vec3,
  bmins: Float32Array, bmaxs: Float32Array,
): { fraction: number; normal: Vec3; allsolid: boolean; startsolid: boolean } {
  const lo = [bmins[0]! - maxs[0]!, bmins[1]! - maxs[1]!, bmins[2]! - maxs[2]!];
  const hi = [bmaxs[0]! - mins[0]!, bmaxs[1]! - mins[1]!, bmaxs[2]! - mins[2]!];
  const inside = (p: Vec3): boolean =>
    p[0]! >= lo[0]! && p[0]! <= hi[0]! &&
    p[1]! >= lo[1]! && p[1]! <= hi[1]! &&
    p[2]! >= lo[2]! && p[2]! <= hi[2]!;
  if (inside(start)) {
    if (inside(end)) {
      const n = v3(0, 0, 0);
      const pens = [
        Math.min(start[0]! - lo[0]!, hi[0]! - start[0]!),
        Math.min(start[1]! - lo[1]!, hi[1]! - start[1]!),
        Math.min(start[2]! - lo[2]!, hi[2]! - start[2]!),
      ];
      let axis = 0;
      if (pens[1]! < pens[axis]!) axis = 1;
      if (pens[2]! < pens[axis]!) axis = 2;
      const mid = (lo[axis]! + hi[axis]!) / 2;
      n[axis] = start[axis]! < mid ? -1 : 1;
      return { fraction: 0, normal: n, allsolid: true, startsolid: true };
    }
    return { fraction: 1, normal: v3(0, 0, 1), allsolid: false, startsolid: true };
  }
  let tmin = 0, tmax = 1, axis = -1, sign = 0;
  for (let i = 0; i < 3; i++) {
    const d = end[i]! - start[i]!;
    if (Math.abs(d) < 1e-9) {
      if (start[i]! < lo[i]! || start[i]! > hi[i]!) {
        return { fraction: 1, normal: v3(0, 0, 1), allsolid: false, startsolid: false };
      }
      continue;
    }
    let t1 = (lo[i]! - start[i]!) / d;
    let t2 = (hi[i]! - start[i]!) / d;
    let s = -1;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = i;
      sign = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return { fraction: 1, normal: v3(0, 0, 1), allsolid: false, startsolid: false };
  }
  if (axis < 0) return { fraction: 1, normal: v3(0, 0, 1), allsolid: false, startsolid: false };
  const n = v3(0, 0, 0);
  n[axis] = sign;
  return { fraction: Math.max(0, Math.min(1, tmin)), normal: n, allsolid: false, startsolid: tmin <= 0 };
}

/**
 * World trace plus the solid brush clips (func_explosive / func_wall while
 * standing). Drivers that move bodies (pmove, monster locomotion) should run
 * against this instead of the bare world trace so walls block until
 * SV_RemoveBrushClip opens them.
 */
export function SV_ClipTrace(st: ServerState, worldTrace: TraceFn): TraceFn {
  return (start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => {
    let best = worldTrace(start, mins, maxs, end);
    for (const b of st.brushClips.values()) {
      const hit = sweepBrushBox(start, end, mins, maxs, b.mins, b.maxs);
      if (hit.fraction < best.fraction || hit.allsolid) {
        const f = hit.fraction;
        best = {
          fraction: f,
          endpos: v3(
            start[0]! + (end[0]! - start[0]!) * f,
            start[1]! + (end[1]! - start[1]!) * f,
            start[2]! + (end[2]! - start[2]!) * f,
          ),
          planeNormal: hit.normal,
          allsolid: hit.allsolid,
          startsolid: hit.startsolid,
          entityNum: best.entityNum,
          contents: best.contents,
        };
      }
    }
    return best;
  };
}

// --- drop to floor (game/g_monster.c M_droptofloor) ---------------------------
//
// Barrels (SP_misc_explobox think) and walkmonsters (walkmonster_start_go,
// when not triggered and level.time < 1) snap to the floor at spawn: origin
// nudged +1 up, traced 256 down with the entity hull under MASK_MONSTERSOLID
// (see SV_DropTraceFor — a narrower mask falls through clip decks to a lower
// level); a clean miss or an allsolid start keeps the mapper origin. The
// trace hook is supplied by the caller (SV_DropTraceFor in tests); without
// it origins are kept as mapped.

export function droptofloor(origin: Vec3, mins: Vec3, maxs: Vec3, trace: TraceFn): Vec3 {
  const start = v3(origin[0], origin[1], origin[2]! + 1);
  const end = v3(origin[0], origin[1], origin[2]! - 256);
  const t = trace(start, mins, maxs, end);
  if (t.fraction === 1 || t.allsolid) return v3(origin[0], origin[1], origin[2]);
  return v3(t.endpos[0], t.endpos[1], t.endpos[2]);
}

// --- monsters (game/g_monster.c walkmonster_start) ---------------------------

export interface ServerMonster {
  edict: Edict;
  state: MonsterState;
  /** soldier | gunner, or null when no lite def exists (monster_infantry:
   * needs an INFANTRY table in packages/game/src/monsters.ts — reported,
   * out of this package's lock; the edict still spawns and renders). */
  kind: MonsterKind | null;
  /** spawnflags & 1: ambush — holds position until it sees the player. */
  ambush: boolean;
  /** spawnflags & 2: triggered — dormant until used (monster_triggered_start). */
  triggered: boolean;
  /** latched the first tick with line of sight (ambush acquire). */
  seen: boolean;
}

/**
 * Map a monster classname onto the lite defs. monster_soldier_light is a
 * soldier with a different skin (SP_monster_soldier_light); infantry and
 * the rest have no lite table yet and map to null (present, not simulated).
 */
export function monsterKindOf(classname: string): MonsterKind | null {
  if (classname === 'monster_soldier' || classname === 'monster_soldier_light') return 'soldier';
  if (classname === 'monster_soldier_ss') return 'soldier';
  if (classname === 'monster_gunner') return 'gunner';
  return null;
}

// --- trains + ships (game/g_func.c func_train, game/g_misc.c ships) ----------
//
// func_train and misc_strogg_ship both ride path_corner chains (train_next):
// the body origin tracks `corner - base`, where base is the brush-model mins
// for trains and the (-16,-16,0) ship hull for point ships. Teleport corners
// (spawnflags & 1) snap the origin instead of travelling. Ships start hidden
// (SVF_NOCLIENT) and trains dormant while they carry a targetname; a use
// (misc_strogg_ship_use / train_use, e.g. trigger_always at level start or
// the *13 button for the exit train) starts them. Bodies with no remaining
// target stop on the final corner.

export interface TrainCorner {
  pos: Vec3;
  wait: number;
  teleport: boolean;
  pathtarget: string;
  /**
   * Targetname of this corner (the key other corners / the train link by).
   * Needed for C-faithful chaining: id train_next advances via
   * self->target = ent->target (G_PickTarget), so a corner whose target
   * names an earlier corner wraps the loop forever instead of ending it.
   */
  name: string;
  /** Target link this corner hands off to on arrival (ent->target). */
  target: string;
}

export interface Train {
  ent: Edict;
  /** true for misc_strogg_ship (point hull), false for func_train (brush). */
  ship: boolean;
  /** mins reference subtracted from corner positions (g_func.c dest math). */
  base: Vec3;
  corners: TrainCorner[];
  /** index of the corner currently being travelled to */
  seg: number;
  from: Vec3;
  to: Vec3;
  /** level.time at which a wait ends, or -1 when travelling/stopped */
  waitUntil: number;
  started: boolean;
  arrived: boolean;
  speed: number;
}

/** Ship hull from SP_misc_strogg_ship (VectorSet mins -16,-16,0). */
const SHIP_BASE: Vec3 = v3(-16, -16, 0);

/** Resolve the path_corner chain starting at `target` (G_PickTarget: first match). */
function resolveCorners(edicts: Edict[], target: string): TrainCorner[] {
  const corners: TrainCorner[] = [];
  const seen = new Set<string>();
  let t = target;
  for (let i = 0; i < 64 && t && !seen.has(t); i++) {
    seen.add(t);
    const c = edicts.find((e) => !e.freed && e.targetname === t && e.classname === 'path_corner');
    if (!c) break;
    corners.push({
      pos: v3(c.origin[0], c.origin[1], c.origin[2]),
      wait: c.wait,
      teleport: (c.spawnflags & 1) !== 0,
      pathtarget: c.extra['pathtarget'] ?? '',
      name: t,
      target: c.target,
    });
    t = c.target;
  }
  return corners;
}

/** Place a train/ship on its first corner (func_train_find). */
function placeTrain(tr: Train): void {
  const first = tr.corners[0];
  if (!first) return;
  tr.ent.origin[0] = first.pos[0]! - tr.base[0]!;
  tr.ent.origin[1] = first.pos[1]! - tr.base[1]!;
  tr.ent.origin[2] = first.pos[2]! - tr.base[2]!;
}

/** Begin (or resume) travel toward corners[seg] (train_next). */
function trainNext(tr: Train, now: number): void {
  for (let guard = 0; guard < tr.corners.length + 1; guard++) {
    const dest = tr.corners[tr.seg];
    if (!dest) {
      tr.arrived = true;
      tr.waitUntil = -1;
      return;
    }
    if (dest.teleport) {
      // Teleport corner (id `goto again`): snap without a travel leg, then
      // keep chaining from the teleport's own target link. A cycle made only
      // of teleports exhausts the guard and stops, like C's connected-
      // teleport error return.
      tr.ent.origin[0] = dest.pos[0]! - tr.base[0]!;
      tr.ent.origin[1] = dest.pos[1]! - tr.base[1]!;
      tr.ent.origin[2] = dest.pos[2]! - tr.base[2]!;
      if (!advanceTrainSeg(tr)) return;
      continue;
    }
    tr.from = v3(tr.ent.origin[0], tr.ent.origin[1], tr.ent.origin[2]);
    tr.to = v3(dest.pos[0]! - tr.base[0]!, dest.pos[1]! - tr.base[1]!, dest.pos[2]! - tr.base[2]!);
    tr.waitUntil = -1;
    return;
  }
  tr.arrived = true;
}

/**
 * Advance seg past the just-arrived corner the id way (train_next):
 * self->target was set to ent->target when the corner was picked, so the
 * next leg goes to the corner NAMED by the arrived corner's target link —
 * not to the next array slot. A link back into the chain (base1's ship
 * loops close t147->t143, t141->t137, t130->t131, each a TELEPORT corner)
 * wraps seg and the train runs forever; an empty or dangling link ends the
 * chain (C prints "bad target" and returns).
 */
function advanceTrainSeg(tr: Train): boolean {
  const cur = tr.corners[tr.seg];
  const next = cur ? cur.target : '';
  if (!next) {
    tr.arrived = true;
    tr.waitUntil = -1;
    return false;
  }
  const idx = tr.corners.findIndex((c) => c.name === next);
  if (idx < 0) {
    tr.arrived = true;
    tr.waitUntil = -1;
    return false;
  }
  tr.seg = idx;
  return true;
}

/** Use a train/ship the id way (train_use / misc_strogg_ship_use). */
export function startTrain(tr: Train, now: number): void {
  void now;
  if (tr.arrived) return;
  if (!tr.started) {
    tr.started = true;
    if (tr.seg >= tr.corners.length) {
      tr.arrived = true;
      return;
    }
    trainNext(tr, now);
    return;
  }
  // non-TOGGLE trains ignore use while running (C train_use returns).
}

/**
 * Advance one train by dt seconds at constant speed (Move_Calc-lite: id
 * eases with accel/decel; constant speed matches average arrival and keeps
 * the mover deterministic for tests). On arrival runs the train_wait
 * sequence: fires pathtarget, honors the corner wait, then continues or
 * stops when the chain ends. Returns the displacement this tick.
 */
export function trainThink(tr: Train, now: number, dt: number, fire: (targetname: string) => void): Vec3 {
  const ox = tr.ent.origin[0]!;
  const oy = tr.ent.origin[1]!;
  const oz = tr.ent.origin[2]!;
  if (!tr.started || tr.arrived) return v3(0, 0, 0);
  if (tr.waitUntil >= 0) {
    if (now < tr.waitUntil) return v3(0, 0, 0);
    if (!advanceTrainSeg(tr)) return v3(0, 0, 0);
    trainNext(tr, now);
    if (tr.arrived) return v3(0, 0, 0);
  }
  const dx = tr.to[0]! - tr.ent.origin[0]!;
  const dy = tr.to[1]! - tr.ent.origin[1]!;
  const dz = tr.to[2]! - tr.ent.origin[2]!;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const step = tr.speed * dt;
  if (len <= step || len === 0) {
    tr.ent.origin[0] = tr.to[0]!;
    tr.ent.origin[1] = tr.to[1]!;
    tr.ent.origin[2] = tr.to[2]!;
    // train_wait: fire pathtarget, then wait or continue.
    const dest = tr.corners[tr.seg];
    if (dest && dest.pathtarget) fire(dest.pathtarget);
    if (dest && dest.wait > 0) {
      tr.waitUntil = now + dest.wait;
    } else {
      if (advanceTrainSeg(tr)) trainNext(tr, now);
    }
  } else {
    const k = step / len;
    tr.ent.origin[0] = tr.ent.origin[0]! + dx * k;
    tr.ent.origin[1] = tr.ent.origin[1]! + dy * k;
    tr.ent.origin[2] = tr.ent.origin[2]! + dz * k;
  }
  return v3(tr.ent.origin[0]! - ox, tr.ent.origin[1]! - oy, tr.ent.origin[2]! - oz);
}
/**
 * Spawn a full entities lump: creates edicts for every block and wires
 * movers/triggers/trains/monsters for the classes base1 needs. Unknown
 * classes are kept as plain edicts (decorations, lights, banners).
 *
 * Skill gating (g_spawn.c): edicts carrying SPAWNFLAG_NOT_* for the state's
 * skill never spawn (worldspawn exempt). The NOT bits are stripped from
 * spawned edicts afterwards, exactly like C.
 *
 * `modelSizes` is the WIRE hook for id-correct door travel: SP_func_door
 * computes travel as |movedir| . brushSize - lip from the brush model bounds,
 * which only the BSP side knows. When a model resolves, its size-based travel
 * is used; otherwise the legacy `distance`-key default (128) applies.
 *
 * `dropTrace` is the M_droptofloor hook (SV_DropTraceFor: MASK_MONSTERSOLID
 *   per C, for both barrels and monsters): barrels and non-triggered monsters
 *   snap to the floor at spawn; without it mapper origins are kept verbatim.
 */
export function SV_SpawnEntities(
  st: ServerState,
  text: string,
  modelSizes?: (model: string) => { mins: Float32Array; maxs: Float32Array } | null,
  dropTrace?: TraceFn,
): Edict[] {
  resetEdictNums();
  const out: Edict[] = [];
  const dicts = parseEntities(text);
  dicts.forEach((dict, index) => {
    const spawnflags = parseFloat(dict['spawnflags'], 0);
    // Skill inhibit (g_spawn.c); worldspawn (first block) is exempt.
    if (index > 0 && inhibitedBySkill(spawnflags, st.skill)) return;
    const e = spawnEdict(dict);
    // C strips the NOT bits after the check so later logic sees clean flags.
    e.spawnflags &= ~(
      SPAWNFLAG_NOT_EASY |
      SPAWNFLAG_NOT_MEDIUM |
      SPAWNFLAG_NOT_HARD |
      SPAWNFLAG_NOT_DEATHMATCH |
      SPAWNFLAG_NOT_COOP
    );
    SV_LinkEdict(st, e);
    out.push(e);
    const angle = parseFloat(dict['angle'], 0);
    switch (e.classname) {
      case 'func_door': {
        let distance = parseFloat(dict['distance'], 128);
        const model = dict['model'];
        if (modelSizes && model) {
          const bounds = modelSizes(model);
          if (bounds) {
            const size = [
              bounds.maxs[0]! - bounds.mins[0]!,
              bounds.maxs[1]! - bounds.mins[1]!,
              bounds.maxs[2]! - bounds.mins[2]!,
            ] as [number, number, number];
            const lip = e.lip || 8;
            distance = doorTravel(new Float32Array(size), angle, lip) + lip;
            const m = spawnDoor(e, angle, distance);
            SV_SpawnMover(st, m);
            st.moverBounds.set(e.num, { mins: bounds.mins, maxs: bounds.maxs });
            break;
          }
        }
        SV_SpawnMover(st, spawnDoor(e, angle, distance));
        break;
      }
      case 'func_plat':
        SV_SpawnMover(st, spawnPlat(e, parseFloat(dict['height'], 160)));
        break;
      case 'func_button': {
        const m = spawnButton(e, angle);
        SV_SpawnMover(st, m);
        const model = dict['model'];
        if (modelSizes && model) {
          const bounds = modelSizes(model);
          if (bounds) st.moverBounds.set(e.num, { mins: bounds.mins, maxs: bounds.maxs });
        }
        break;
      }
      case 'trigger_once':
      case 'trigger_multiple': {
        let bounds: { mins: Float32Array; maxs: Float32Array } | null = null;
        const model = dict['model'];
        if (modelSizes && model) {
          const b = modelSizes(model);
          if (b) bounds = b;
        }
        SV_SpawnTrigger(st, spawnTrigger(e), bounds ?? undefined);
        break;
      }
      case 'misc_explobox': {
        // SP_misc_explobox thinks M_droptofloor on spawn. The edict doubles
        // as the server barrel record (health/dmg from the game tables,
        // origin = box bottom = hull origin; Phase 0 single sim).
        if (dropTrace) {
          const g = droptofloor(e.origin, EXPLOBOX_MINS, EXPLOBOX_MAXS, dropTrace);
          e.origin[0] = g[0]!;
          e.origin[1] = g[1]!;
          e.origin[2] = g[2]!;
        }
        {
          const ex = spawnExplosive(dict);
          if (ex) {
            e.health = ex.health;
            e.maxHealth = ex.health;
            e.dmg = ex.dmg;
            st.barrels.push({
              edict: e,
              origin: v3(e.origin[0], e.origin[1], e.origin[2]),
              size: v3(EXPLOBOX_MAXS[0]! - EXPLOBOX_MINS[0]!, EXPLOBOX_MAXS[1]! - EXPLOBOX_MINS[1]!, EXPLOBOX_MAXS[2]! - EXPLOBOX_MINS[2]!),
              mass: ex.mass,
              isFunc: false,
              fused: false,
            });
          }
        }
        break;
      }
      case 'func_explosive':
      case 'func_wall': {
        // C SOLID_BSP while standing (SP_func_explosive / SP_func_wall):
        // block movement until destroyed. Submodel bounds are already
        // world-space (brush-model origins are 0 in base1), so no mover
        // offset applies, unlike doors.
        const model = dict['model'];
        if (modelSizes && model) {
          const bounds = modelSizes(model);
          if (bounds) st.brushClips.set(e.num, { mins: bounds.mins, maxs: bounds.maxs });
        }
        // func_explosive is a shootable barrel too (barrel_delay fuse +
        // T_RadiusDamage + mass-formula debris): record the center + size so
        // SV_DamageBarrel and the driver render path share one record.
        if (e.classname === 'func_explosive') {
          const ex = spawnExplosive(dict);
          if (ex) {
            e.health = ex.health;
            e.maxHealth = ex.health;
            e.dmg = ex.dmg;
            const model = dict['model'];
            const bounds = model && modelSizes ? modelSizes(model) : null;
            if (bounds) {
              const cx = (bounds.mins[0]! + bounds.maxs[0]!) / 2;
              const cy = (bounds.mins[1]! + bounds.maxs[1]!) / 2;
              const cz = (bounds.mins[2]! + bounds.maxs[2]!) / 2;
              st.barrels.push({
                edict: e,
                origin: v3(cx, cy, cz),
                size: v3(bounds.maxs[0]! - bounds.mins[0]!, bounds.maxs[1]! - bounds.mins[1]!, bounds.maxs[2]! - bounds.mins[2]!),
                mass: ex.mass,
                isFunc: true,
                fused: false,
              });
            }
          }
        }
        break;
      }
      case 'func_train':
      case 'misc_strogg_ship': {
        // Placed on the first path_corner below (needs the full edict list).
        const ship = e.classname === 'misc_strogg_ship';
        let base: Vec3 = v3(SHIP_BASE[0], SHIP_BASE[1], SHIP_BASE[2]);
        const model = dict['model'];
        if (!ship && modelSizes && model) {
          const bounds = modelSizes(model);
          if (bounds) {
            base = v3(bounds.mins[0], bounds.mins[1], bounds.mins[2]);
            st.moverBounds.set(e.num, { mins: bounds.mins, maxs: bounds.maxs });
          }
        }
        st.trains.push({
          ent: e,
          ship,
          base,
          corners: [],
          seg: 1,
          from: v3(e.origin[0], e.origin[1], e.origin[2]),
          to: v3(e.origin[0], e.origin[1], e.origin[2]),
          waitUntil: -1,
          started: false,
          arrived: false,
          speed: e.speed || (ship ? 300 : 100),
        });
        break;
      }
      default:
        break;
    }
    // Scripted explosion targets (target_explosion, g_target.c
    // use_target_explosion): recorded by targetname so SV_Tick can fire
    // them when the relay chain reaches them (Phase 0 single sim — the
    // driver used to own this table).
    if (e.classname === 'target_explosion' && e.targetname) {
      const ex = spawnExplosive(dict);
      if (ex) {
        st.explosionTargets.set(e.targetname, {
          origin: v3(ex.origin[0], ex.origin[1], ex.origin[2]),
          dmg: ex.dmg,
          delay: ex.delay,
        });
      }
    }
    if (e.classname.startsWith('monster_')) {      // id skin assignment (m_soldier.c SP_monster_soldier_*): light troops
      // wear skin 0 (blaster), normals skin 2 (shotgun), supershots skin 4
      // (machinegun). Stashed on the edict so the render lane can pick a
      // distinct skin per kind (selectSoldierAttack keys off the same skins).
      // Base1 fields 6× light + 8× normal, no supershots.
      if (e.classname === 'monster_soldier_light') e.extra['skinnum'] = '0';
      else if (e.classname === 'monster_soldier') e.extra['skinnum'] = '2';
      else if (e.classname === 'monster_soldier_ss') e.extra['skinnum'] = '4';
      // walkmonster_start_go drops non-triggered monsters when level.time < 1
      // (spawn always qualifies: time is still 0 here).
      if (dropTrace && !(e.spawnflags & 2)) {
        const g = droptofloor(e.origin, MONSTER_HULL_MINS, MONSTER_HULL_MAXS, dropTrace);
        e.origin[0] = g[0]!;
        e.origin[1] = g[1]!;
        e.origin[2] = g[2]!;
      }
      const kind = monsterKindOf(e.classname);
      st.monsters.push({
        edict: e,
        state: kind ? spawnMonster(kind) : spawnMonster('soldier'),
        kind,
        ambush: (e.spawnflags & 1) !== 0,
        triggered: (e.spawnflags & 2) !== 0,
        seen: false,
      });
      if (kind) {
        // face the mapper angle until the first tick re-yaws (M_ChangeYaw).
        const yaw = parseFloat(dict['angle'], 0);
        const last = st.monsters[st.monsters.length - 1]!;
        last.state.yaw = ((yaw % 360) + 360) % 360;
      }
    }
  });
  // Second pass: trains need the full edict list to resolve corner chains
  // (func_train_find runs on the second frame in C, after all spawns).
  for (const tr of st.trains) {
    tr.corners = resolveCorners(st.entities, tr.ent.target);
    if (tr.corners.length === 0) {
      tr.arrived = true;
      continue;
    }
    placeTrain(tr);
    // Ships/trains with no targetname start immediately (func_train_find);
    // named ones wait for a use (trigger_always, buttons).
    if (!tr.ent.targetname) {
      tr.started = true;
      trainNext(tr, 0);
    }
  }
  // SP_trigger_always: fire at spawn (starts base1's ships; the exit train's
  // own trigger_always is skill-inhibited in SP, so the train waits for *13).
  // Explosion targets fire for real too (none in base1, but the path is the
  // same use_target_explosion fuse the tick runs for relay chains).
  for (const e of out) {
    if (!e.freed && e.classname === 'trigger_always' && e.target) {
      const pseudo: Edict = { ...e };
      fireTargets(st, pseudo);
      fireExplosionTarget(st, e.target);
    }
  }
  return out;
}

/** Fire a "use" on every entity with the given targetname (button/trigger path). */
export function SV_UseTargetname(st: ServerState, targetname: string): void {
  for (const m of st.movers) {
    if (m.ent.targetname === targetname) SV_UseMover(st, m);
  }
  for (const tr of st.trains) {
    if (tr.ent.targetname === targetname) startTrain(tr, st.time);
  }
  for (const e of st.entities) {
    if (e.targetname === targetname && e.classname === 'trigger_relay') {
      fireTargets(st, e);
    }
  }
}

/**
 * Use a mover the id way (G_UseTargets equivalent for movers): run moverUse,
 * and when a func_door starts opening, fire the door's own target right away
 * (id door_go_up calls G_UseTargets the moment the door starts moving — not
 * on arrival). Buttons instead fire on reaching the top (see SV_Tick,
 * id button_wait); plats never fire. Depth-guarded: cyclic target graphs
 * stop instead of overflowing the stack (a deliberate safety deviation).
 */
export function SV_UseMover(st: ServerState, m: Mover, depth = 0): void {
  const wasUp = m.state === MOVER_GOING_UP;
  moverUse(m, st.time);
  if (
    !wasUp &&
    m.state === MOVER_GOING_UP &&
    m.ent.classname === 'func_door' &&
    m.ent.target
  ) {
    fireTargets(st, m.ent, depth + 1);
  }
}

/** Maximum G_UseTargets cascade depth (cycle guard; id would recurse). */
export const MAX_USETARGETS_DEPTH = 16;

/** G_UseTargets equivalent: use every entity targeted by `user`. */
export function fireTargets(st: ServerState, user: Edict, depth = 0): void {
  if (!user.target || depth > MAX_USETARGETS_DEPTH) return;
  for (const e of st.entities) {
    if (e.freed || e.targetname !== user.target) continue;
    st.firedThisTick.push(e.targetname);
    const m = st.movers.find((mm) => mm.ent === e);
    if (m) {
      SV_UseMover(st, m, depth);
    } else if (e.classname === 'trigger_relay') {
      // id G_UseTargets uses the relay, which fires the relay's own target.
      fireTargets(st, e, depth + 1);
    } else {
      const tr = st.trains.find((tt) => tt.ent === e);
      // func_train / misc_strogg_ship use (train_use / ship use).
      if (tr) startTrain(tr, st.time);
    }
  }
}

/** True when the edict is a brush-model trigger (model *N, no usable origin). */
function isBrushTrigger(e: Edict): boolean {
  return e.model.startsWith('*');
}

/** AABB overlap of a body box (origin + mins/maxs) with brush bounds. */
function bodyOverlapsBounds(
  origin: Vec3,
  mins: Vec3,
  maxs: Vec3,
  bmins: Float32Array,
  bmaxs: Float32Array,
): boolean {
  for (let i = 0; i < 3; i++) {
    if (origin[i]! + mins[i]! > bmaxs[i]! || origin[i]! + maxs[i]! < bmins[i]!) return false;
  }
  return true;
}

/**
 * Touch all triggers as `toucherClass` at the toucher's position.
 *
 * Brush triggers (model *N) are tested by real brush-VOLUME overlap: their
 * edict origin defaults to the world origin (0,0,0), so any point-proximity
 * test fires them spuriously whenever the player walks near (0,0,0) — in
 * base1 that walkable floor point sits ~344 units from spawn, and every
 * brush trigger (including the *27 exit-pit chain) fired there. Triggers
 * whose bounds were never registered (no modelSizes hook) are skipped
 * rather than fired by proximity: firing them would always be spurious.
 * Point triggers (no brush model) keep the legacy 96-unit proximity check.
 */
export function SV_TouchTriggersAt(
  st: ServerState,
  toucherClass: 'player' | 'monster',
  toucher: Edict,
): void {
  for (const t of st.triggers) {
    if (t.ent.freed) continue;
    if (isBrushTrigger(t.ent)) {
      const b = st.triggerBounds.get(t.ent.num);
      if (!b) continue;
      if (!bodyOverlapsBounds(toucher.origin, toucher.mins, toucher.maxs, b.mins, b.maxs)) continue;
    } else {
      // point trigger: proximity check around the edict origin
      const dx = toucher.origin[0]! - t.ent.origin[0]!;
      const dy = toucher.origin[1]! - t.ent.origin[1]!;
      const dz = toucher.origin[2]! - t.ent.origin[2]!;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 96 * 96) continue;
    }
    triggerTouch(t, st.time, toucherClass, (tt) => {
      const pseudo: Edict = { ...tt.ent };
      fireTargets(st, pseudo);
    });
  }
}

/**
 * Touch door trigger fields (id Touch_DoorTrigger, g_func.c): every func_door
 * spawns an invisible trigger volume from its brush bounds expanded 60 in
 * x/y (Think_SpawnDoorTrigger). A body overlapping a closed/waiting door's
 * volume uses the door (door_use), exactly like the bot driver mirrors.
 * Doors without registered brush bounds (no modelSizes hook) are skipped.
 *
 * C gates (Touch_DoorTrigger): monsters never trip DOOR_NOMONSTER doors
 * (spawnflags & 8 — both base1 sliders carry it), and touches debounce at
 * 1Hz. The debounce is implicit here: moverUse only re-fires from
 * bottom/waiting, so a body already inside merely refreshes the wait —
 * exactly the C door_go_up-on-TOP wait reset. Pass toucherClass 'monster'
 * for monster bodies so the NOMONSTER gate applies.
 *
 * Returns the doors that started moving.
 */
export function SV_TouchDoorsAt(
  st: ServerState,
  body: { origin: Vec3; mins: Vec3; maxs: Vec3 },
  toucherClass: 'player' | 'monster' = 'player',
): Mover[] {
  const used: Mover[] = [];
  for (const m of st.movers) {
    if (m.ent.classname !== 'func_door') continue;
    if (m.state !== MOVER_BOTTOM && m.state !== MOVER_WAITING) continue;
    // id Touch_DoorTrigger: NOMONSTER doors ignore monster touches.
    if (toucherClass === 'monster' && m.ent.spawnflags & DOOR_NOMONSTER) continue;
    const b = st.moverBounds.get(m.ent.num);
    if (!b) continue;
    const ox = m.ent.origin[0]! - m.pos1[0]!;
    const oy = m.ent.origin[1]! - m.pos1[1]!;
    const oz = m.ent.origin[2]! - m.pos1[2]!;
    const tmins = new Float32Array([b.mins[0]! + ox - 60, b.mins[1]! + oy - 60, b.mins[2]! + oz]);
    const tmaxs = new Float32Array([b.maxs[0]! + ox + 60, b.maxs[1]! + oy + 60, b.maxs[2]! + oz]);
    if (!bodyOverlapsBounds(body.origin, body.mins, body.maxs, tmins, tmaxs)) continue;
    // door_use → door_go_up: fires the door's own target as it starts moving.
    SV_UseMover(st, m);
    used.push(m);
  }
  return used;
}

// --- monster tick (game/g_ai.c M_CheckAttack + m_move.c locomotion) -----------

export interface MonsterEvent {
  /** edict num of the firing monster */
  num: number;
  classname: string;
  /** lite attack choice (selectAttack / move mapping in @q2/game) */
  attack: AttackChoice;
  /** data-table move playing (attack1/attack_chain/runandshoot/...) */
  move: string;
  /** damage-to-player scale at this skill (g_combat.c easy half) */
  dmgScale: number;
  /** move-frame index that just played (fire-tagged; grenades leave the tube
   * only on the C frames — the resolver gates on this, like monsterFire). */
  frame: number;
}

const POINT_HULL: Vec3 = v3(0, 0, 0);

/**
 * C visible() (g_ai.c): eye-to-eye point trace — self origin + viewheight
 * (25 for walkmonsters, g_monster.c) to other origin + its viewheight —
 * against MASK_OPAQUE. Knee-to-knee origin traces stay blocked behind low
 * rails and stair lips the eyes clear, which wedges ambush monsters in
 * stand forever; the +25/+22 offsets are the fix. The C sight mask ignores
 * WINDOW, so glass never blocks C sight: pass an opaque-mask trace via
 * MonsterTickOpts when glass sits between the bodies, otherwise the shared
 * move trace doubles (glass then blocks sight — the one known deviation).
 */
function losClear(
  sightTrace: TraceFn,
  selfPos: Vec3,
  playerPos: Vec3,
  playerView: number,
): boolean {
  const a = v3(selfPos[0], selfPos[1], selfPos[2]! + MONSTER_VIEWHEIGHT);
  const b = v3(playerPos[0], playerPos[1], playerPos[2]! + playerView);
  const t = sightTrace(a, POINT_HULL, POINT_HULL, b);
  return t.fraction === 1 && !t.startsolid;
}

/**
 * C SV_movestep stair climb (m_move.c, STEPSIZE 18) wrapped around the
 * locomotion hull trace: when the straight move clips, lift one step, move,
 * and drop two steps, keeping the stepped landing when it lands on ground
 * and travels farther than the direct clip. Without this any riser wedges
 * the hull and uphill pursuit stalls at the stair base forever. Vertical
 * probes (the gravity leg) pass through untouched — stepping applies only
 * to horizontal moves. M_CheckBottom's dangling-corner veto is omitted;
 * the drop must land (fraction < 1) or the step is rejected.
 */
function stepHullTrace(
  trace: TraceFn,
  start: Vec3,
  end: Vec3,
): { fraction: number; endpos: Vec3 } {
  const direct = trace(start, MONSTER_HULL_MINS, MONSTER_HULL_MAXS, end);
  if (direct.fraction === 1 || direct.allsolid) {
    return { fraction: direct.fraction, endpos: direct.endpos };
  }
  if (Math.abs(end[2]! - start[2]!) > 1e-9) {
    return { fraction: direct.fraction, endpos: direct.endpos };
  }
  const sUp = v3(start[0], start[1], start[2]! + MONSTER_STEP_HEIGHT);
  const eUp = v3(end[0], end[1], end[2]! + MONSTER_STEP_HEIGHT);
  const up = trace(sUp, MONSTER_HULL_MINS, MONSTER_HULL_MAXS, eUp);
  if (up.allsolid || up.startsolid) return { fraction: direct.fraction, endpos: direct.endpos };
  const down = trace(
    up.endpos,
    MONSTER_HULL_MINS,
    MONSTER_HULL_MAXS,
    v3(up.endpos[0], up.endpos[1], up.endpos[2]! - 2 * MONSTER_STEP_HEIGHT),
  );
  if (down.allsolid || down.fraction === 1) return { fraction: direct.fraction, endpos: direct.endpos };
  const step2 =
    (down.endpos[0]! - start[0]!) * (down.endpos[0]! - start[0]!) +
    (down.endpos[1]! - start[1]!) * (down.endpos[1]! - start[1]!);
  const direct2 =
    (direct.endpos[0]! - start[0]!) * (direct.endpos[0]! - start[0]!) +
    (direct.endpos[1]! - start[1]!) * (direct.endpos[1]! - start[1]!);
  if (step2 <= direct2 + 1e-6) return { fraction: direct.fraction, endpos: direct.endpos };
  return { fraction: 1, endpos: down.endpos };
}

/** Inverse of attackMoveFor for the firing event (melee resolved by range). */
function attackOfMove(kind: MonsterKind, move: string): AttackChoice {
  switch (move) {
    case 'attack1':
      return 'shotgun';
    case 'attack2':
      return 'blaster';
    case 'attack_chain':
    case 'fire_chain':
    case 'endfire_chain':
    case 'runandshoot':
      return 'chaingun';
    case 'attack_grenade':
      return 'grenade';
    default:
      return kind === 'soldier' ? 'blaster' : 'chaingun';
  }
}

/**
 * One 10Hz monster tick for every spawned monster (the M7.2 driver runs the
 * same @q2/game primitives in apps/web; this is the server-authoritative
 * equivalent used by tests and headless sims):
 * - triggered (spawnflags & 2) and unmapped (infantry: no lite def) monsters
 *   stay dormant;
 * - ambush (spawnflags & 1) monsters hold their stand pose until line of
 *   sight latches `seen` — the base1 opener: the start-room soldier waits
 *   until the player rounds the corner, then runs at them. Sight is C
 *   visible(): eye to eye (monster +25, player +22 standing) against an
 *   opaque-mask trace;
 * - otherwise monsterChaseMove selects attack vs. close-in (needs a nav
 *   graph; null builds a trivial two-node graph, i.e. straight steering),
 *   monsterLocomotion steps the body with a C SV_movestep stair-climbing
 *   hull trace plus gravity, and monsterThink advances the frame;
 * - every 'fire' frame with line of sight emits a MonsterEvent carrying the
 *   skill damage scale, so drivers land shots on the muzzle flash.
 */
export interface MonsterTickOpts {
  /** Eye height of the player body (22 standing, 12 ducked, pmove.c). */
  playerViewheight?: number;
  /**
   * Sight trace for the visible() check (C runs MASK_OPAQUE, which ignores
   * WINDOW so glass never blocks monster sight). Defaults to the move trace;
   * pass SV_TraceFor(map, MASK_OPAQUE_C) when glass sits between bodies.
   */
  sightTrace?: TraceFn;
}

export function SV_MonsterTick(
  st: ServerState,
  playerPos: Vec3,
  trace: TraceFn,
  nav: MonsterNav | null,
  rand: () => number,
  opts?: MonsterTickOpts,
): MonsterEvent[] {
  const events: MonsterEvent[] = [];
  const sightTrace = opts?.sightTrace ?? trace;
  const playerView = opts?.playerViewheight ?? PLAYER_VIEWHEIGHT;
  for (const m of st.monsters) {
    if (m.triggered || m.kind === null) continue;
    const ms: MonsterState = m.state;
    if (ms.gibbed) continue;
    if (ms.dead) {
      monsterThink(ms); // corpses hold their last death frame
      continue;
    }
    const pos = m.edict.origin;
    const dx = playerPos[0]! - pos[0]!;
    const dy = playerPos[1]! - pos[1]!;
    const dz = playerPos[2]! - pos[2]!;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const canSee = losClear(sightTrace, pos, playerPos, playerView);
    if (m.ambush && !m.seen) {
      if (!canSee) {
        const stand = m.kind === 'soldier' ? 'stand1' : 'stand';
        if (ms.move !== stand) {
          ms.move = stand;
          ms.frame = 0;
        }
        monsterThink(ms);
        continue;
      }
      m.seen = true;
    }
    const navEff: MonsterNav =
      nav ??
      {
        graph: new Map<number, number[]>([
          [0, [1]],
          [1, [0]],
        ]),
        positions: new Map<number, Vec3>([
          [0, v3(pos[0], pos[1], pos[2])],
          [1, v3(playerPos[0], playerPos[1], playerPos[2])],
        ]),
      };
    monsterChaseMove(ms, pos, playerPos, navEff, canSee, rand);
    monsterLocomotion(ms, pos, playerPos, (s, e) => {
      const h = stepHullTrace(trace, s, e);
      return { fraction: h.fraction, endpos: h.endpos };
    });
    const playedIdx = ms.frame;
    const action = monsterThink(ms);
    if (action === 'fire' && canSee) {
      events.push({
        num: m.edict.num,
        classname: m.edict.classname,
        attack: dist < 80 ? 'melee' : attackOfMove(m.kind, ms.move),
        move: ms.move,
        dmgScale: skillMultiplier(st.skill),
        frame: playedIdx,
      });
    }
  }
  return events;
}

/**
 * Advance the world by dt seconds (default SERVER_DT = 0.1, 10Hz).
 * Runs movers and trains to completion legs, records per-mover displacement
 * for rider carrying, respawns due pickups, and clears per-tick diagnostics.
 *
 * Phase 0 single sim: `game` carries the live player body + world trace so
 * the tick also runs the gameplay phase — monster think with C cadence
 * fire resolution (melee/hitscan/foe-bolt damage, tracers, muzzles,
 * sounds), bolt flight + touch, barrel fuses, scripted explosions,
 * debris/gibs and explosion pruning, plus monster door touches. Absent
 * (headless/unit use), the tick stays movers+trains+respawn only.
 */
export function SV_Tick(st: ServerState, dt: number = SERVER_DT, game?: SVGameTick): void {
  st.firedThisTick = [];
  st.time += dt;
  const now = st.time;
  const before = new Map<number, Vec3>();
  for (const m of st.movers) {
    if (m.ent.freed) continue;
    before.set(m.ent.num, v3(m.ent.origin[0], m.ent.origin[1], m.ent.origin[2]));
  }
  for (const tr of st.trains) {
    if (tr.ent.freed) continue;
    before.set(tr.ent.num, v3(tr.ent.origin[0], tr.ent.origin[1], tr.ent.origin[2]));
  }
  for (const m of st.movers) {
    if (m.ent.freed) continue;
    const completed = moverThink(m, now);
    if (
      completed &&
      m.ent.classname === 'func_button' &&
      (m.state === MOVER_WAITING || m.state === MOVER_TOP)
    ) {
      // id button_wait fires the button's target on reaching the top.
      fireTargets(st, m.ent);
    }
  }
  for (const tr of st.trains) {
    if (tr.ent.freed) continue;
    trainThink(tr, now, dt, (targetname) => {
      const pseudo: Edict = { ...tr.ent, target: targetname };
      fireTargets(st, pseudo);
    });
  }
  st.moverDeltas.clear();
  for (const m of st.movers) {
    if (m.ent.freed) continue;
    const b = before.get(m.ent.num);
    if (!b) continue;
    const dx = m.ent.origin[0]! - b[0]!;
    const dy = m.ent.origin[1]! - b[1]!;
    const dz = m.ent.origin[2]! - b[2]!;
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      st.moverDeltas.set(m.ent.num, v3(dx, dy, dz));
    }
  }
  // Trains displace riders the same way (SV_Push semantics).
  for (const tr of st.trains) {
    if (tr.ent.freed) continue;
    const b = before.get(tr.ent.num);
    if (!b) continue;
    const dx = tr.ent.origin[0]! - b[0]!;
    const dy = tr.ent.origin[1]! - b[1]!;
    const dz = tr.ent.origin[2]! - b[2]!;
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      st.moverDeltas.set(tr.ent.num, v3(dx, dy, dz));
    }
  }
  // Pickup respawn (DoRespawn): re-materialize hidden items whose timer
  // (SetRespawn via SV_ConsumePickup) elapsed on level.time.
  for (const e of st.entities) {
    if (!e.freed && e.extra['respawnAt'] !== undefined) {
      DoRespawn(e, now);
    }
  }
  // Scripted corridor blasts (trigger_once/relay chains fire
  // target_explosion): every firing path pushes the relay targetname into
  // firedThisTick, so the tick resolves them here — immediate or delayed
  // via the fuse list (use_target_explosion think at level.time + delay).
  for (const t of st.firedThisTick) fireExplosionTarget(st, t);
  // Phase 0 gameplay: monsters, bolts, fuses, debris/gibs, explosions.
  if (game) SV_GameTick(st, game, dt);
}

/**
 * Consume a pickup edict the way Touch_Item does after a successful grab:
 * hide it (SOLID_NOT) and arm the id respawn timer (SetRespawn, ~30s for
 * weapons/health/ammo, 20s for armor). SV_Tick re-materializes it via
 * DoRespawn. `delay` overrides the id table; `now` defaults to level.time.
 */
export function SV_ConsumePickup(st: ServerState, ent: Edict, delay?: number, now?: number): number {
  const t = now ?? st.time;
  const d = delay ?? respawnDelayFor(ent.classname);
  return SetRespawn(ent, d, t);
}

/** A headless body (pmove state) eligible for pusher carrying. */
export interface RiderBody {
  origin: Vec3;
  mins: Vec3;
  maxs: Vec3;
  /** edict num of the mover stood upon (pmove groundEntity; -1 = none) */
  groundEntity: number;
  onGround: boolean;
}

/**
 * SV_Push rider pass: carry bodies standing on movers that displaced this
 * tick (id g_phys.c: riders move with the pusher). Matches C semantics
 * exactly — only groundEntity == pusher links ride; world-grounded and
 * airborne bodies are untouched. Must run after SV_Tick (reads
 * moverDeltas) and before the bodies' own movement for the tick.
 */
export function SV_CarryRiders(st: ServerState, bodies: RiderBody[]): void {
  for (const b of bodies) {
    if (!b.onGround || b.groundEntity < 0) continue;
    const d = st.moverDeltas.get(b.groundEntity);
    if (!d) continue;
    b.origin[0] = b.origin[0]! + d[0]!;
    b.origin[1] = b.origin[1]! + d[1]!;
    b.origin[2] = b.origin[2]! + d[2]!;
  }
}
// --- Phase 0: single authoritative sim (BRAIN.md §15) -------------------------
//
// The browser used to run a private driver sim (PlacedMonster[], barrels,
// bolts, monsterFire, stepBolts, driver door touch) and rendered only it, so
// server fixes never reached the screen. This section is the inversion:
// the server owns ALL gameplay state at 10Hz in SV_Tick — monsters (via the
// existing SV_MonsterTick path, resolved here with C cadence), barrels
// (misc_explobox + func_explosive), bolts (player + foe blaster edicts),
// explosions + muzzle/tracer/spark/sound events (visual feed for the
// driver), debris/gibs, scripted target_explosions and the player health
// pool. The driver (apps/web) renders from this state and forwards input
// via SV_PlayerFire, which owns damage. Pure data + the game tables; no
// rendering, no DOM.

/** Enemy hitscan tracer streak length (short muzzle streak, never eye-ending). */
export const SERVER_ENEMY_TRACER_LENGTH = 48;
/** id pellet spread basis: r/u are world units at this range (fire_lead). */
export const SV_PELLET_RANGE = 8192;
/** Static impact-puff lifetime in server seconds (driver spark sweep). */
export const SV_SPARK_TTL = 0.4;
/** id PARTICLE_GRAVITY (cl_fx.c ballistic spark falloff). */
export const SV_SPARK_GRAVITY = 40;
/** id sv_gravity default for tossed debris/gibs (g_phys.c SV_AddGravity). */
export const SV_TOSS_GRAVITY = 800;

/** Flying blaster bolt (g_weapon.c fire_blaster / monster_fire_blaster). */
export interface ServerBolt {
  pos: Vec3;
  dir: Vec3; // normalized
  life: number;
  damage: number;
  /** Units/second (1000 player blaster, 600 soldier monster blaster). */
  speed: number;
  /** True for monster return fire (damages the player, never its owner). */
  foe: boolean;
  /** Server time the bolt was spawned (life expires on server time). */
  born: number;
}

/** Shootable explosive (g_misc.c barrel_delay / func_explosive_explode). */
export interface ServerBarrel {
  edict: Edict;
  /**
   * Damage origin: box bottom for misc_explobox (hull origin), bbox center
   * for func_explosive (a wall/slab middle). Matches the old driver layout
   * so radius math and the render base agree.
   */
  origin: Vec3;
  /** Hull size (explobox 32,32,40; brush bbox otherwise). */
  size: Vec3;
  /** Debris mass class (400 explobox, 75 func_explosive default). */
  mass: number;
  /** True for brush func_explosive (mass-formula debris), else explobox. */
  isFunc: boolean;
  /**
   * Lethal hit latched (takedamage NO + 0.2s fuse, barrel_delay). Further
   * hits are immune until the fuse blows.
   */
  fused: boolean;
}

/** Explosion visual kind (cl_tent.c TE_ paths). */
export type ServerExplosionKind = 'explosion1' | 'explosion2' | 'blaster';

/** Live explosion flash (TE_EXPLOSION1/2 big boom, TE_BLASTER touch). */
export interface ServerExplosion {
  pos: Vec3;
  born: number;
  kind: ServerExplosionKind;
  baseframe: number;
  yaw: number;
}

/** One-shot muzzle-flash dlight request (id CL_MuzzleFlash). */
export interface ServerMuzzle {
  pos: Vec3;
  intensity: number;
  born: number;
  foe: boolean;
}

/** One queued hitscan tracer beam (origin + dir + color + length). */
export interface ServerTracer {
  origin: Vec3;
  dir: Vec3;
  color: number;
  length: number;
  born: number;
}

/** One queued particle-burst request (impact, trail, boom). */
export interface ServerSpark {
  pos: Vec3;
  color: number;
  /** Ballistic velocity (boom sparks) or null (static puffs). */
  vel: Vec3 | null;
  ttl: number;
  born: number;
}

/** One queued positional-sound request (shots, impacts). */
export interface ServerSound {
  name: string;
  pos: Vec3;
  born: number;
}

/** Thrown chunk (g_misc.c ThrowDebris: MOVETYPE_BOUNCE, backoff 1.5). */
export interface ServerDebris {
  origin: Vec3;
  vel: Vec3;
  avel: Vec3;
  born: number;
  life: number;
  kind: 'debris1' | 'debris2' | 'debris3';
  rest: boolean;
}

/** Gib chunk (g_misc.c ThrowGib/ThrowHead: MOVETYPE_TOSS, backoff 1.0). */
export interface ServerGib {
  origin: Vec3;
  vel: Vec3;
  avel: Vec3;
  born: number;
  life: number;
  kind: 'meat' | 'chest' | 'bone' | 'head';
  rest: boolean;
}

/** Pending barrel fuse / target_explosion delay (server-time stepped). */
export interface ServerFuse {
  pos: Vec3;
  dmg: number;
  at: number;
  barrel?: { edict: Edict; origin: Vec3; size: Vec3; mass: number; dmg: number; isFunc: boolean };
}

/** Live player body for the gameplay phase (touch, LOS, bolt flesh). */
export interface SVPlayerBody {
  pos: Vec3;
  mins: Vec3;
  maxs: Vec3;
  /** Eye height above the origin (22 standing, 12 ducked, pmove.c). */
  view: number;
}

/** Gameplay-phase inputs for SV_Tick (absent = movers/trains/respawn only). */
export interface SVGameTick {
  player: SVPlayerBody;
  /** World trace (C-mask via SV_TraceFor; wrap in SV_ClipTrace for clips). */
  trace: TraceFn;
  /** Sight trace for visible() (C MASK_OPAQUE, ignores WINDOW/glass). */
  sightTrace?: TraceFn;
  /** Monster nav graph; null builds the trivial two-node chase graph. */
  nav?: MonsterNav | null;
  /** Caller-seeded RNG (deterministic tests); defaults to Math.random. */
  rand?: () => number;
}

const ZERO_HULL: Vec3 = v3(0, 0, 0);

/** Slab segment-vs-AABB (hitscan flesh tests: monsters, barrels, player). */
function segmentAabbSeg(
  origin: Vec3,
  delta: Vec3,
  mins: Vec3,
  maxs: Vec3,
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

/** Skinnum stashed on a monster edict (m_soldier.c SP_ funcs). */
function skinOf(m: ServerMonster): number {
  const raw = m.edict.extra['skinnum'] ?? '2';
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) ? v : 2;
}

/**
 * Spawn a synthetic monster (test hook + devroom synthetics): creates and
 * links the edict, maps the classname onto the lite defs (unmapped kinds
 * stay present but dormant, like the lump path), faces yaw. Seen latches
 * immediately so synthetic bodies act without an acquire walk.
 */
export function SV_SpawnMonster(
  st: ServerState,
  classname: string,
  origin: Vec3,
  yaw = 0,
): ServerMonster {
  const e = spawnEdict({ classname, origin: `${origin[0]} ${origin[1]} ${origin[2]}` });
  SV_LinkEdict(st, e);
  const kind = monsterKindOf(classname);
  // id skin assignment parity with the lump path (m_soldier.c SP_ funcs):
  // light troops wear skin 0 (blaster), normals skin 2 (shotgun),
  // supershots skin 4 (machinegun). selectSoldierAttack keys the weapon off
  // the same skins, so synthetics must carry them too.
  if (classname === 'monster_soldier_light') e.extra['skinnum'] = '0';
  else if (classname === 'monster_soldier') e.extra['skinnum'] = '2';
  else if (classname === 'monster_soldier_ss') e.extra['skinnum'] = '4';
  const m: ServerMonster = {
    edict: e,
    state: kind ? spawnMonster(kind) : spawnMonster('soldier'),
    kind,
    ambush: false,
    triggered: false,
    seen: true,
  };
  m.state.yaw = ((yaw % 360) + 360) % 360;
  st.monsters.push(m);
  return m;
}

/**
 * Add a synthetic shootable barrel (test hook): links an explobox edict and
 * records it. Defaults are the id SP_misc_explobox table values.
 */
export function SV_AddBarrel(
  st: ServerState,
  origin: Vec3,
  opts?: { health?: number; dmg?: number; mass?: number; size?: Vec3; isFunc?: boolean },
): ServerBarrel {
  const e = spawnEdict({ classname: 'misc_explobox', origin: `${origin[0]} ${origin[1]} ${origin[2]}` });
  e.health = opts?.health ?? 10;
  e.maxHealth = e.health;
  e.dmg = opts?.dmg ?? 150;
  SV_LinkEdict(st, e);
  const b: ServerBarrel = {
    edict: e,
    origin: v3(origin[0], origin[1], origin[2]),
    size: opts?.size ?? v3(32, 32, 40),
    mass: opts?.mass ?? 400,
    isFunc: opts?.isFunc ?? false,
    fused: false,
  };
  st.barrels.push(b);
  return b;
}

/** T_Damage on the player pool (g_combat.c easy-half scaling owned here). */
export function SV_DamagePlayer(st: ServerState, dmg: number): number {
  if (st.playerHealth <= 0) return 0;
  const applied = Math.max(1, Math.round(dmg * skillMultiplier(st.skill)));
  st.playerHealth = Math.max(0, st.playerHealth - applied);
  return applied;
}

/** Heal (pickup path writes back through here; clamped to the max pool). */
export function SV_HealPlayer(st: ServerState, amount: number): number {
  st.playerHealth = Math.min(st.playerMaxHealth, Math.max(0, st.playerHealth + amount));
  return st.playerHealth;
}

/** Set the pool directly (respawn path; clamped to 0..max). */
export function SV_SetPlayerHealth(st: ServerState, hp: number): number {
  st.playerHealth = Math.min(st.playerMaxHealth, Math.max(0, hp));
  return st.playerHealth;
}

/**
 * T_Damage on a monster (g_combat.c gib-first ordering via monsterPain).
 * Gibbing spawns meat/chest/head extras + the udeath sound and marks
 * DEAD_DEAD (unhittable from then on). Returns the pain result.
 */
export function SV_DamageMonster(
  st: ServerState,
  m: ServerMonster,
  damage: number,
  rand: () => number,
): 'gib' | 'dead' | 'pain' | 'none' {
  const res = monsterPain(m.state, damage, rand);
  if (res === 'gib') {
    st.sounds.push({ name: GIB_SOUND, pos: v3(m.edict.origin[0], m.edict.origin[1], m.edict.origin[2]), born: st.time });
    const kinds: ServerGib['kind'][] = ['meat', 'meat', 'meat', 'chest', 'head'];
    for (const kind of kinds) {
      const scale = damage < 50 ? 0.7 : 1.2;
      const vx = Math.max(-300, Math.min(300, 100 * (rand() * 2 - 1) * scale * 0.5));
      const vy = Math.max(-300, Math.min(300, 100 * (rand() * 2 - 1) * scale * 0.5));
      const vz = Math.max(200, Math.min(500, (200 + 100 * rand()) * scale * 0.5));
      st.gibs.push({
        origin: v3(
          m.edict.origin[0]! + (rand() * 2 - 1) * 16,
          m.edict.origin[1]! + (rand() * 2 - 1) * 16,
          m.edict.origin[2]! + (rand() * 2 - 1) * 16,
        ),
        vel: v3(vx, vy, vz),
        avel: v3(rand() * 600, rand() * 600, rand() * 600),
        born: st.time,
        life: 10 + rand() * 10,
        kind,
        rest: false,
      });
    }
  }
  return res;
}

/**
 * T_Damage on a barrel (g_misc.c barrel_delay): the first lethal hit frees
 * the edict (takedamage NO) + arms a 0.2s fuse (think = barrel_explode at
 * level.time + 2 frames), then the fuse runs T_RadiusDamage + BecomeExplosion.
 * Chained hits (damageRadius chains) re-enter through the same fuse; hits
 * during the fuse are immune.
 */
export function SV_DamageBarrel(
  st: ServerState,
  b: ServerBarrel,
  dmg: number,
): boolean {
  if (b.edict.freed || b.fused) return false;
  b.edict.health -= dmg;
  if (b.edict.health > 0) return false;
  b.fused = true;
  b.edict.freed = true;
  st.fuses.push({
    pos: v3(b.origin[0], b.origin[1], b.origin[2]),
    dmg: b.edict.dmg,
    at: barrelFuseAt(st.time),
    barrel: {
      edict: b.edict,
      origin: v3(b.origin[0], b.origin[1], b.origin[2]),
      size: v3(b.size[0], b.size[1], b.size[2]),
      mass: b.mass,
      dmg: b.edict.dmg,
      isFunc: b.isFunc,
    },
  });
  return true;
}

/**
 * Explosion visual + sound + radius damage (TE_EXPLOSION1/2 barrel/func/
 * target, TE_BLASTER touch flash). Big booms emit the 256-count ballistic
 * burst (CL_ExplosionParticles) and the explod1 fallback sound; the blaster
 * flash keeps its 40-spark burst (added by SV_BlasterImpact, not here).
 * Grounded booms render as explosion2 (BecomeExplosion2), airborne as
 * explosion1 (BecomeExplosion1). No scorch (Q2 has none).
 */
export function SV_SpawnExplosion(
  st: ServerState,
  pos: Vec3,
  dmg: number,
  opts?: { kind?: ServerExplosionKind; trace?: TraceFn; rand?: () => number },
): void {
  const rand = opts?.rand ?? Math.random;
  let kind = opts?.kind ?? 'explosion1';
  let baseframe = 0;
  if (opts?.kind === 'blaster') {
    baseframe = 0;
  } else if (opts?.kind === 'explosion2') {
    kind = 'explosion2';
    baseframe = 30;
  } else if (opts?.trace) {
    const grounded =
      opts.trace(v3(pos[0], pos[1], pos[2]! + 1), ZERO_HULL, ZERO_HULL, v3(pos[0], pos[1], pos[2]! - 8)).fraction < 1;
    if (grounded) {
      kind = 'explosion2';
      baseframe = 30;
    } else {
      baseframe = explosionBaseframe('explosion1', rand);
    }
  } else {
    baseframe = explosionBaseframe('explosion1', rand);
  }
  st.explosions.push({
    pos: v3(pos[0], pos[1], pos[2]),
    born: st.time,
    kind,
    baseframe,
    yaw: (rand() * 360) | 0,
  });
  if (kind === 'blaster') return;
  for (let i = 0; i < 256; i++) {
    st.sparks.push({
      pos: v3(pos[0]! + ((rand() * 32 - 16) | 0), pos[1]! + ((rand() * 32 - 16) | 0), pos[2]! + ((rand() * 32 - 16) | 0)),
      color: 0xe0 + ((rand() * 8) | 0),
      vel: v3((rand() * 384 - 192) | 0, (rand() * 384 - 192) | 0, (rand() * 384 - 192) | 0),
      ttl: 0.625 + rand() * 0.375,
      born: st.time,
    });
  }
  st.sounds.push({ name: 'world/explod1.wav', pos: v3(pos[0], pos[1], pos[2]), born: st.time });
  void dmg;
}

/**
 * id T_RadiusDamage (g_combat.c): distance is measured from the entity's
 * bbox CENTER (mins+maxs)/2, points = dmg - 0.5*len, the attacker takes
 * half, and CanDamage (LOS) must pass or the entity is skipped. Barrels
 * chain through the 0.2s fuse (SV_DamageBarrel). Corpses keep their skip
 * (radius never minces — only direct fire does).
 */
export function SV_RadiusDamage(
  st: ServerState,
  pos: Vec3,
  dmg: number,
  player: SVPlayerBody,
  trace: TraceFn,
  rand: () => number,
): void {
  const radius = radiusDamageRadius(dmg);
  if (!(radius > 0)) return;
  const canDamage = (target: Vec3): boolean => trace(pos, ZERO_HULL, ZERO_HULL, target).fraction >= 1;
  for (const m of st.monsters) {
    if (m.state.dead || m.state.gibbed) continue;
    const cx = m.edict.origin[0]! + (MONSTER_HULL_MINS[0]! + MONSTER_HULL_MAXS[0]!) / 2;
    const cy = m.edict.origin[1]! + (MONSTER_HULL_MINS[1]! + MONSTER_HULL_MAXS[1]!) / 2;
    const cz = m.edict.origin[2]! + (MONSTER_HULL_MINS[2]! + MONSTER_HULL_MAXS[2]!) / 2;
    const center = v3(cx, cy, cz);
    const len = Math.hypot(center[0]! - pos[0]!, center[1]! - pos[1]!, center[2]! - pos[2]!);
    if (len >= radius) continue;
    if (!canDamage(center)) continue;
    SV_DamageMonster(st, m, Math.max(1, Math.round(radiusDamagePoints(dmg, len))), rand);
  }
  const pcenter = v3(player.pos[0], player.pos[1], player.pos[2]! + 4);
  const pd = Math.hypot(pcenter[0]! - pos[0]!, pcenter[1]! - pos[1]!, pcenter[2]! - pos[2]!);
  if (pd < radius && canDamage(pcenter)) {
    // The attacker (us, who shot the barrel) takes half damage.
    SV_DamagePlayer(st, Math.max(1, Math.round(radiusDamageAttackerPoints(radiusDamagePoints(dmg, pd)))));
  }
  for (const b of st.barrels) {
    if (b.edict.freed) continue;
    const bx = b.isFunc ? b.origin[0]! : b.origin[0]! + b.size[0]! / 2;
    const by = b.isFunc ? b.origin[1]! : b.origin[1]! + b.size[1]! / 2;
    const bz = b.isFunc ? b.origin[2]! : b.origin[2]! + b.size[2]! / 2;
    const bcenter = v3(bx, by, bz);
    const bd = Math.hypot(bcenter[0]! - pos[0]!, bcenter[1]! - pos[1]!, bcenter[2]! - pos[2]!);
    if (bd >= radius) continue;
    if (!canDamage(bcenter)) continue;
    SV_DamageBarrel(st, b, Math.max(1, Math.round(radiusDamagePoints(dmg, bd))));
  }
}

/** TE_BLASTER impact: sparks + explosion flash + lashit + flesh damage. */
export function SV_BlasterImpact(
  st: ServerState,
  pos: Vec3,
  damage: number,
  hitMonster: ServerMonster | null,
  rand: () => number,
): void {
  for (let i = 0; i < 40; i++) {
    st.sparks.push({
      pos: v3(pos[0]! + ((rand() * 16 - 8) | 0), pos[1]! + ((rand() * 16 - 8) | 0), pos[2]! + ((rand() * 16 - 8) | 0)),
      color: 0xe0 + ((rand() * 8) | 0),
      vel: null,
      ttl: SV_SPARK_TTL,
      born: st.time,
    });
  }
  SV_SpawnExplosion(st, pos, 0, { kind: 'blaster', rand });
  st.sounds.push({ name: 'weapons/lashit.wav', pos: v3(pos[0], pos[1], pos[2]), born: st.time });
  if (hitMonster) SV_DamageMonster(st, hitMonster, damage, rand);
}

/** Fire one target_explosion: immediate, or delayed via the fuse list. */
export function fireExplosionTarget(st: ServerState, targetname: string): void {
  const ex = st.explosionTargets.get(targetname);
  if (!ex) return;
  if (ex.delay > 0) {
    st.fuses.push({ pos: v3(ex.origin[0], ex.origin[1], ex.origin[2]), dmg: ex.dmg, at: targetExplosionFuseAt(st.time, ex.delay) });
    return;
  }
  SV_SpawnExplosion(st, ex.origin, 0);
}

/**
 * Debris for one exploded barrel (g_misc.c barrel_explode: 2 big (debris1)
 * + 4 bottom corners (debris3) + 8 small (debris2)). func_explosive instead
 * uses its mass class (mass/100 cap 8 big + mass/25 cap 16 small).
 */
function spawnBarrelDebris(
  st: ServerState,
  b: { origin: Vec3; size: Vec3; mass: number; dmg: number; isFunc: boolean },
  rand: () => number,
): void {
  const pushDebris = (kind: ServerDebris['kind'], origin: Vec3, speed: number): void => {
    st.debris.push({
      origin: v3(origin[0], origin[1], origin[2]),
      vel: v3(
        100 * (rand() * 2 - 1) * speed,
        100 * (rand() * 2 - 1) * speed,
        (100 + 100 * rand()) * speed,
      ),
      avel: v3(rand() * 600, rand() * 600, rand() * 600),
      born: st.time,
      life: 5 + rand() * 5,
      kind,
      rest: false,
    });
  };
  const jitter = (center: Vec3, size: Vec3): Vec3 =>
    v3(
      center[0]! + (rand() * 2 - 1) * size[0]!,
      center[1]! + (rand() * 2 - 1) * size[1]!,
      center[2]! + (rand() * 2 - 1) * size[2]!,
    );
  const center = v3(b.origin[0]! + b.size[0]! / 2, b.origin[1]! + b.size[1]! / 2, b.origin[2]! + b.size[2]! / 2);
  if (b.isFunc) {
    const { big, small } = funcExplosiveDebris(b.mass);
    for (let i = 0; i < big; i++) pushDebris('debris1', jitter(center, b.size), 1);
    for (let i = 0; i < small; i++) pushDebris('debris2', jitter(center, b.size), 2);
    return;
  }
  const spd = barrelDebrisSpeeds(b.dmg);
  for (let i = 0; i < 2; i++) pushDebris('debris1', jitter(center, b.size), spd.big);
  for (let cx = 0; cx < 2; cx++) {
    for (let cy = 0; cy < 2; cy++) {
      pushDebris('debris3', v3(b.origin[0]! + cx * b.size[0]!, b.origin[1]! + cy * b.size[1]!, b.origin[2]!), spd.corner);
    }
  }
  for (let i = 0; i < 8; i++) pushDebris('debris2', jitter(center, b.size), spd.small);
}

/**
 * Resolve one monster 'fire' frame (m_soldier.c soldier_fire / m_gunner.c
 * GunnerFire+GunnerGrenade): the soldier weapon is skin-determined (never
 * random); blaster skins spawn a real foe bolt, shotgun/machinegun skins
 * draw short yellow muzzle streaks and roll id's pHit, grenades leave the
 * tube only on the C frames, melee commits at close range through the
 * attack move. Every shot carries its enemy muzzle dlight.
 */
function resolveMonsterFire(
  st: ServerState,
  m: ServerMonster,
  ev: MonsterEvent,
  player: SVPlayerBody,
  rand: () => number,
): void {
  if (st.playerHealth <= 0) return;
  const eye = v3(player.pos[0], player.pos[1], player.pos[2]! + player.view);
  const dx = eye[0]! - m.edict.origin[0]!;
  const dy = eye[1]! - m.edict.origin[1]!;
  const dz = eye[2]! - m.edict.origin[2]!;
  const dist = Math.hypot(dx, dy, dz);
  if (dist > 1000) return;
  const fwd = v3();
  const right = v3();
  const up = v3();
  AngleVectors(v3(0, m.state.yaw, 0), fwd, right, up);
  const move = ev.move;
  const skinWeapon = m.kind === 'soldier' ? soldierWeaponForSkin(skinOf(m)) : null;
  let flashId = MZ2_SOLDIER_SHOTGUN_1;
  if (m.kind === 'soldier') {
    if (skinWeapon === 'blaster') flashId = MZ2_SOLDIER_BLASTER_1;
    else if (skinWeapon === 'machinegun') flashId = MZ2_SOLDIER_MACHINEGUN_1 + (ev.frame % 2);
    else flashId = MZ2_SOLDIER_SHOTGUN_1;
  } else if (move === 'attack_grenade') flashId = MZ2_GUNNER_GRENADE_1 + (ev.frame % 4);
  else if (m.kind === 'gunner') flashId = MZ2_GUNNER_MACHINEGUN_1 + (ev.frame % 8);
  const muzzle = projectSource(
    v3(m.edict.origin[0], m.edict.origin[1], m.edict.origin[2]),
    monsterFlashOffset(flashId),
    fwd,
    right,
  );
  const flashIdx = st.muzzles.length;
  st.muzzles.push({ pos: muzzle, intensity: 200 + ((rand() * 32) | 0), born: st.time, foe: true });
  const dirToEye = v3(eye[0]! - muzzle[0]!, eye[1]! - muzzle[1]!, eye[2]! - muzzle[2]!);
  const dirLen = Math.hypot(dirToEye[0]!, dirToEye[1]!, dirToEye[2]!) || 1;
  const chest = v3(m.edict.origin[0], m.edict.origin[1], m.edict.origin[2]! + 32);
  // Soldier blaster skin: a real projectile, not a damage roll.
  if (skinWeapon === 'blaster') {
    st.bolts.push({
      pos: v3(muzzle[0], muzzle[1], muzzle[2]),
      dir: v3(dirToEye[0]! / dirLen, dirToEye[1]! / dirLen, dirToEye[2]! / dirLen),
      life: 2,
      damage: SOLDIER_WEAPON_STATS.blaster.damage,
      speed: SOLDIER_WEAPON_STATS.blaster.boltSpeed,
      foe: true,
      born: st.time,
    });
    st.sounds.push({ name: SOLDIER_WEAPON_STATS.blaster.sound, pos: chest, born: st.time });
    return;
  }
  // Grenades leave the tube only on their C frames (105/108/111/114).
  if (move === 'attack_grenade' && ev.frame !== 4 && ev.frame !== 7 && ev.frame !== 10 && ev.frame !== 13) {
    st.muzzles.splice(flashIdx, 1);
    return;
  }
  // Melee commits at close range through the attack move.
  if (dist < 96 && (move === 'attack1' || move === 'attack_chain')) {
    SV_DamagePlayer(st, m.kind === 'gunner' ? 15 : 10);
    st.sounds.push({ name: 'monster/melee.wav', pos: chest, born: st.time });
    return;
  }
  const pHit = dist < 500 ? 0.6 : 0.25;
  // Soldier machinegun skin: 3-round burst (id monster_fire_bullet dmg 2 ×
  // the HOLD_FRAME repeat), fanned ±40u at 8192 like the pellet spread
  // basis; each round rolls pHit independently and draws its own SHORT
  // muzzle streak (never a muzzle→eye beam).
  if (skinWeapon === 'machinegun') {
    for (let bb = -1; bb <= 1; bb++) {
      const fan = v3(dirToEye[0]! + bb * 40, dirToEye[1]! - bb * 40, dirToEye[2]!);
      st.tracers.push({ origin: v3(muzzle[0], muzzle[1], muzzle[2]), dir: fan, color: HITSCAN_TRACER_COLOR, length: SERVER_ENEMY_TRACER_LENGTH, born: st.time });
      if (rand() < pHit) {
        SV_DamagePlayer(st, SOLDIER_WEAPON_STATS.machinegun.damage);
        st.sparks.push({ pos: v3(eye[0], eye[1], eye[2]), color: 200 + ((rand() * 55) | 0), vel: null, ttl: SV_SPARK_TTL, born: st.time });
      }
    }
    st.sounds.push({ name: SOLDIER_WEAPON_STATS.machinegun.sound, pos: chest, born: st.time });
    return;
  }
  let dmg = SOLDIER_WEAPON_STATS.shotgun.damage;
  let sound = SOLDIER_WEAPON_STATS.shotgun.sound;
  if (m.kind === 'gunner') {
    dmg = move === 'attack_grenade' ? 12 : 6;
    sound = move === 'attack_grenade' ? 'gunner/gunatck3.wav' : 'gunner/gunatck2.wav';
  }
  st.tracers.push({ origin: v3(muzzle[0], muzzle[1], muzzle[2]), dir: v3(dirToEye[0], dirToEye[1], dirToEye[2]), color: HITSCAN_TRACER_COLOR, length: SERVER_ENEMY_TRACER_LENGTH, born: st.time });
  st.sounds.push({ name: sound, pos: chest, born: st.time });
  if (rand() < pHit) {
    SV_DamagePlayer(st, dmg);
    st.sparks.push({ pos: v3(eye[0], eye[1], eye[2]), color: 200 + ((rand() * 55) | 0), vel: null, ttl: SV_SPARK_TTL, born: st.time });
  }
}

/**
 * Step flying blaster bolts. Life expires on SERVER time (G_FreeEdict at
 * level.time + 2); movement integrates the tick quantum. Foe bolts test the
 * player box and damage the player; player bolts test monsters first, then
 * barrels. Gibbed monsters are skipped, but corpses are NOT (takedamage YES
 * — re-hit minces via SV_DamageMonster).
 */
function stepBoltFlight(
  st: ServerState,
  player: SVPlayerBody,
  trace: TraceFn,
  rand: () => number,
  dt: number,
): void {
  if (st.bolts.length === 0) return;
  for (let i = st.bolts.length - 1; i >= 0; i--) {
    const bolt = st.bolts[i]!;
    const stepLen = bolt.speed * dt;
    const next = v3(
      bolt.pos[0]! + bolt.dir[0]! * stepLen,
      bolt.pos[1]! + bolt.dir[1]! * stepLen,
      bolt.pos[2]! + bolt.dir[2]! * stepLen,
    );
    // EF_BLASTER trail (cl_fx.c CL_BlasterTrail): yellow puffs every ~5u.
    const trailSteps = Math.min(8, Math.max(1, Math.round(stepLen / 5)));
    for (let k = 1; k <= trailSteps; k++) {
      const f = k / (trailSteps + 1);
      st.sparks.push({
        pos: v3(
          bolt.pos[0]! + (next[0]! - bolt.pos[0]!) * f,
          bolt.pos[1]! + (next[1]! - bolt.pos[1]!) * f,
          bolt.pos[2]! + (next[2]! - bolt.pos[2]!) * f,
        ),
        color: BLASTER_TRAIL_COLOR,
        vel: null,
        ttl: SV_SPARK_TTL,
        born: st.time,
      });
    }
    let dead = st.time - bolt.born >= bolt.life;
    if (!dead) {
      // Wall touch (blaster_touch: sky frees silently, wall explodes).
      // TODO(sky): the trace carries no SURF_SKY flag, so sky hits explode
      // here; free the bolt silently once the trace carries the surface flag.
      const wall = trace(bolt.pos, ZERO_HULL, ZERO_HULL, next);
      if (wall.fraction < 1) {
        const hitPos = v3(
          bolt.pos[0]! + (next[0]! - bolt.pos[0]!) * wall.fraction,
          bolt.pos[1]! + (next[1]! - bolt.pos[1]!) * wall.fraction,
          bolt.pos[2]! + (next[2]! - bolt.pos[2]!) * wall.fraction,
        );
        SV_BlasterImpact(st, hitPos, bolt.damage, null, rand);
        dead = true;
      } else if (bolt.foe) {
        // Soldier return fire: test the player box.
        const seg = v3(next[0]! - bolt.pos[0]!, next[1]! - bolt.pos[1]!, next[2]! - bolt.pos[2]!);
        const pmins = v3(player.pos[0]! + player.mins[0]!, player.pos[1]! + player.mins[1]!, player.pos[2]! + player.mins[2]!);
        const pmaxs = v3(player.pos[0]! + player.maxs[0]!, player.pos[1]! + player.maxs[1]!, player.pos[2]! + player.maxs[2]!);
        const tHit = segmentAabbSeg(bolt.pos, seg, pmins, pmaxs);
        if (tHit !== null) {
          const hitPos = v3(bolt.pos[0]! + seg[0]! * tHit, bolt.pos[1]! + seg[1]! * tHit, bolt.pos[2]! + seg[2]! * tHit);
          SV_BlasterImpact(st, hitPos, bolt.damage, null, rand);
          if (st.playerHealth > 0) {
            SV_DamagePlayer(st, bolt.damage);
            st.sparks.push({
              pos: v3(player.pos[0], player.pos[1], player.pos[2]! + player.view),
              color: 200 + ((rand() * 55) | 0),
              vel: null,
              ttl: SV_SPARK_TTL,
              born: st.time,
            });
          }
          dead = true;
        }
      } else {
        // Flesh touch: monsters first (T_Damage ENERGY), then barrels.
        const seg = v3(next[0]! - bolt.pos[0]!, next[1]! - bolt.pos[1]!, next[2]! - bolt.pos[2]!);
        let hitMonster: ServerMonster | null = null;
        let bestT = 1;
        for (const m of st.monsters) {
          if (m.state.gibbed) continue;
          const tHit = segmentAabbSeg(
            bolt.pos, seg,
            v3(m.edict.origin[0]! + MONSTER_HULL_MINS[0]!, m.edict.origin[1]! + MONSTER_HULL_MINS[1]!, m.edict.origin[2]! + MONSTER_HULL_MINS[2]!),
            v3(m.edict.origin[0]! + MONSTER_HULL_MAXS[0]!, m.edict.origin[1]! + MONSTER_HULL_MAXS[1]!, m.edict.origin[2]! + MONSTER_HULL_MAXS[2]!),
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
          SV_BlasterImpact(st, hitPos, bolt.damage, hitMonster, rand);
          dead = true;
        } else {
          let hb: ServerBarrel | null = null;
          let bt = 1;
          for (const b of st.barrels) {
            if (b.edict.freed) continue;
            const tHit = b.isFunc
              ? segmentAabbSeg(bolt.pos, seg, v3(b.origin[0]! - b.size[0]! / 2, b.origin[1]! - b.size[1]! / 2, b.origin[2]! - b.size[2]! / 2), v3(b.origin[0]! + b.size[0]! / 2, b.origin[1]! + b.size[1]! / 2, b.origin[2]! + b.size[2]! / 2))
              : segmentAabbSeg(bolt.pos, seg, v3(b.origin[0]! + EXPLOBOX_MINS[0]!, b.origin[1]! + EXPLOBOX_MINS[1]!, b.origin[2]! + EXPLOBOX_MINS[2]!), v3(b.origin[0]! + EXPLOBOX_MAXS[0]!, b.origin[1]! + EXPLOBOX_MAXS[1]!, b.origin[2] + EXPLOBOX_MAXS[2]!));
            if (tHit !== null && tHit < bt) {
              bt = tHit;
              hb = b;
            }
          }
          if (hb && !hb.edict.freed) {
            SV_DamageBarrel(st, hb, bolt.damage);
            SV_BlasterImpact(st, v3(hb.origin[0], hb.origin[1], hb.origin[2]), bolt.damage, null, rand);
            dead = true;
          }
        }
      }
    }
    if (dead) st.bolts.splice(i, 1);
    else bolt.pos = next;
  }
}

/**
 * Step debris + gibs (g_phys.c SV_Physics_Toss-lite): gravity, point-trace
 * move, ClipVelocity backoff (1.5 bounce debris / 1.0 toss gibs), floor rest
 * when vz < 60 and the plane normal is floor-like (> 0.7), life expiry
 * (5+rand*5 debris, 10+rand*10 gibs).
 */
function stepChunks(
  st: ServerState,
  items: Array<ServerDebris | ServerGib>,
  trace: TraceFn,
  dt: number,
  backoff: number,
): void {
  for (let i = items.length - 1; i >= 0; i--) {
    const c = items[i]!;
    if (st.time - c.born >= c.life) {
      items.splice(i, 1);
      continue;
    }
    if (c.rest) continue;
    c.vel[2] = c.vel[2]! - SV_TOSS_GRAVITY * dt;
    const next = v3(
      c.origin[0]! + c.vel[0]! * dt,
      c.origin[1]! + c.vel[1]! * dt,
      c.origin[2]! + c.vel[2]! * dt,
    );
    const hit = trace(c.origin, ZERO_HULL, ZERO_HULL, next);
    if (hit.fraction >= 1) {
      c.origin = next;
      continue;
    }
    c.origin = v3(
      c.origin[0]! + (next[0]! - c.origin[0]!) * hit.fraction,
      c.origin[1]! + (next[1]! - c.origin[1]!) * hit.fraction,
      c.origin[2]! + (next[2]! - c.origin[2]!) * hit.fraction,
    );
    const n = hit.planeNormal ?? v3(0, 0, 1);
    const d = (c.vel[0]! * n[0]! + c.vel[1]! * n[1]! + c.vel[2]! * n[2]!) * backoff;
    c.vel = v3(c.vel[0]! - n[0]! * d, c.vel[1]! - n[1]! * d, c.vel[2]! - n[2]! * d);
    if (n[2]! > 0.7 && (backoff < 1.5 || c.vel[2]! < 60)) {
      c.vel = v3();
      c.rest = true;
    }
  }
}

/**
 * Phase 0 gameplay phase of SV_Tick: monster think with C cadence fire
 * resolution, monster door touches, bolt flight + touch, barrel fuses,
 * debris/gibs and explosion pruning (all at 10Hz on server time).
 */
function SV_GameTick(st: ServerState, game: SVGameTick, dt: number): void {
  const rand = game.rand ?? Math.random;
  // Monsters use doors (Touch_DoorTrigger; NOMONSTER sliders ignore them).
  for (const m of st.monsters) {
    if (m.state.dead || m.state.gibbed || m.triggered || m.kind === null) continue;
    SV_TouchDoorsAt(st, { origin: m.edict.origin, mins: MONSTER_HULL_MINS, maxs: MONSTER_HULL_MAXS }, 'monster');
  }
  // Think + C-cadence return fire (damage, bolts, tracers, muzzles, sounds).
  const sightTrace = game.sightTrace ?? game.trace;
  for (const ev of SV_MonsterTick(st, game.player.pos, game.trace, game.nav ?? null, rand, { sightTrace, playerViewheight: game.player.view })) {
    const m = st.monsters.find((mm) => mm.edict.num === ev.num);
    if (!m) continue;
    resolveMonsterFire(st, m, ev, game.player, rand);
  }
  // Bolts fly and touch.
  stepBoltFlight(st, game.player, game.trace, rand, dt);
  // Barrel fuses / target_explosion delays blow on server time.
  for (let i = st.fuses.length - 1; i >= 0; i--) {
    const f = st.fuses[i]!;
    if (st.time < f.at) continue;
    st.fuses.splice(i, 1);
    if (f.barrel) {
      spawnBarrelDebris(st, f.barrel, rand);
      // The brush is gone (func_explosive_explode / BecomeExplosion free the
      // edict either way): open the clip so the hole stays open.
      if (f.barrel.isFunc) SV_RemoveBrushClip(st, f.barrel.edict);
    }
    SV_SpawnExplosion(st, f.pos, f.dmg, { trace: game.trace, rand });
    SV_RadiusDamage(st, f.pos, f.dmg, game.player, game.trace, rand);
  }
  // Tossed chunks fall and rest; visuals live their full frame life.
  stepChunks(st, st.debris, game.trace, dt, 1.5);
  stepChunks(st, st.gibs, game.trace, dt, 1.0);
  for (let i = st.explosions.length - 1; i >= 0; i--) {
    const e = st.explosions[i]!;
    const frames = explosionFrames(e.kind);
    if (st.time - e.born >= frames * 0.1) st.explosions.splice(i, 1);
  }
  // Safety prune: undrained one-shot queues never grow across frames.
  const wipe = (q: Array<{ born: number }>): void => {
    for (let i = q.length - 1; i >= 0; i--) {
      if (st.time - q[i]!.born > 5) q.splice(i, 1);
    }
  };
  wipe(st.muzzles);
  wipe(st.tracers);
  wipe(st.sparks);
  wipe(st.sounds);
}

/** Drain the pending muzzle flashes (one-shot dlight pump). */
export function SV_DrainMuzzles(st: ServerState): ServerMuzzle[] {
  if (st.muzzles.length === 0) return [];
  const out = st.muzzles.slice();
  st.muzzles.length = 0;
  return out;
}

/** Drain the pending tracer beams (short muzzle streaks). */
export function SV_DrainTracers(st: ServerState): ServerTracer[] {
  if (st.tracers.length === 0) return [];
  const out = st.tracers.slice();
  st.tracers.length = 0;
  return out;
}

/** Drain the pending particle-burst requests (impacts, trails, booms). */
export function SV_DrainSparks(st: ServerState): ServerSpark[] {
  if (st.sparks.length === 0) return [];
  const out = st.sparks.slice();
  st.sparks.length = 0;
  return out;
}

/** Drain the pending positional-sound requests. */
export function SV_DrainSounds(st: ServerState): ServerSound[] {
  if (st.sounds.length === 0) return [];
  const out = st.sounds.slice();
  st.sounds.length = 0;
  return out;
}

/** Player fire inputs (computed by the driver from its input state). */
export interface SVFireOpts {
  eye: Vec3;
  feet: Vec3;
  angles: Vec3;
  /** Standing eye height (22; the bolt spawn offset keys off it). */
  viewheight: number;
  /** Current reserve for the weapon's ammo kind (ignored for blaster). */
  ammo: number;
  /** World trace (C-mask via SV_TraceFor; wrap in SV_ClipTrace for clips). */
  trace: TraceFn;
  /** Caller-seeded RNG (spread, muzzle radius, gibs). */
  rand: () => number;
}

/** Player fire outcome (ammo sync for the driver's HUD state). */
export interface SVFireResult {
  fired: boolean;
  reason: string;
  ammoLeft: number;
  /** True when a player bolt was spawned (authentic fire_blaster). */
  bolt: boolean;
}

/**
 * SV_PlayerFire: the driver computes the shot (eye/feet/angles from input)
 * but the server applies it — ammo, muzzle dlight, foe/player bolts,
 * hitscan pellet traces vs wall/monsters/barrels, pain/gib/barrel damage,
 * impact sparks and sounds. Returns the ammo sync for the driver.
 *
 * Authentic split (g_weapon.c): the blaster is a PROJECTILE weapon
 * (fire_blaster bolt edict, 1000 u/s, 2s life, EF_BLASTER trail) — never
 * hitscan, never a muzzle->impact beam. Hitscan weapons (shotgun /
 * machinegun, fire_lead) are instant traces with impact sparks only.
 */
export function SV_PlayerFire(
  st: ServerState,
  weaponKind: string,
  opts: SVFireOpts,
): SVFireResult {
  const def = findWeapon(weaponKind);
  if (!def) return { fired: false, reason: 'no weapon', ammoLeft: opts.ammo, bolt: false };
  const res = fireWeapon(def, opts.ammo, opts.rand, false);
  if (!res.fired) {
    st.sounds.push({ name: 'weapons/noammo.wav', pos: v3(opts.eye[0], opts.eye[1], opts.eye[2]), born: st.time });
    return { fired: false, reason: res.reason, ammoLeft: res.ammoLeft, bolt: false };
  }
  const fwd = v3();
  const right = v3();
  const up = v3();
  AngleVectors(opts.angles, fwd, right, up);
  st.sounds.push({
    name:
      weaponKind === 'weapon_shotgun'
        ? 'weapons/shotgf1b.wav'
        : weaponKind === 'weapon_machinegun'
          ? 'weapons/machgf1b.wav'
          : 'weapons/blastf1a.wav',
    pos: v3(opts.eye[0], opts.eye[1], opts.eye[2]),
    born: st.time,
  });
  // Muzzle flash: HUD glow + a real dlight (id CL_MuzzleFlash: origin =
  // feet + fwd*18 + right*16, radius 200+(rand&31), pure yellow).
  st.muzzles.push({
    pos: blasterMuzzle(opts.feet, fwd, right),
    intensity: muzzleRadius(opts.rand),
    born: st.time,
    foe: false,
  });
  // Authentic blaster: G_ProjectSource from the feet (start = feet +
  // fwd*24 + right*8, z += viewheight-8). The bolt leaves the gun muzzle.
  if (weaponKind === 'weapon_blaster' && res.bolt) {
    const start = blasterSpawn(opts.feet, fwd, right, opts.viewheight);
    const dl = Math.hypot(fwd[0]!, fwd[1]!, fwd[2]!) || 1;
    st.bolts.push({
      pos: start,
      dir: v3(fwd[0]! / dl, fwd[1]! / dl, fwd[2]! / dl),
      life: res.bolt.life,
      damage: res.bolt.damage,
      speed: BOLT_SPEED,
      foe: false,
      born: st.time,
    });
    return { fired: true, reason: 'ok', ammoLeft: res.ammoLeft, bolt: true };
  }
  for (const pl of res.pellets) {
    const dir = v3(
      fwd[0]! * SV_PELLET_RANGE + right[0]! * pl.r + up[0]! * pl.u,
      fwd[1]! * SV_PELLET_RANGE + right[1]! * pl.r + up[1]! * pl.u,
      fwd[2]! * SV_PELLET_RANGE + right[2]! * pl.r + up[2]! * pl.u,
    );
    const len = Math.hypot(dir[0]!, dir[1]!, dir[2]!) || 1;
    const far = v3(
      opts.eye[0]! + ((dir[0]! / len) * SV_PELLET_RANGE),
      opts.eye[1]! + ((dir[1]! / len) * SV_PELLET_RANGE),
      opts.eye[2]! + ((dir[2]! / len) * SV_PELLET_RANGE),
    );
    const wall = opts.trace(opts.eye, ZERO_HULL, ZERO_HULL, far);
    let bestT = wall.fraction;
    let hitMonster: ServerMonster | null = null;
    const seg = v3(far[0]! - opts.eye[0]!, far[1]! - opts.eye[1]!, far[2]! - opts.eye[2]!);
    for (const m of st.monsters) {
      if (m.state.gibbed) continue;
      // No dead-skip: corpses stay hittable (takedamage YES) so re-hitting
      // them minces (g_combat.c T_Damage gib-first ordering).
      const tHit = segmentAabbSeg(
        opts.eye, seg,
        v3(m.edict.origin[0]! + MONSTER_HULL_MINS[0]!, m.edict.origin[1]! + MONSTER_HULL_MINS[1]!, m.edict.origin[2]! + MONSTER_HULL_MINS[2]!),
        v3(m.edict.origin[0]! + MONSTER_HULL_MAXS[0]!, m.edict.origin[1]! + MONSTER_HULL_MAXS[1]!, m.edict.origin[2]! + MONSTER_HULL_MAXS[2]!),
      );
      if (tHit !== null && tHit < bestT) {
        bestT = tHit;
        hitMonster = m;
      }
    }
    const hitPos = v3(
      opts.eye[0]! + seg[0]! * bestT,
      opts.eye[1]! + seg[1]! * bestT,
      opts.eye[2]! + seg[2]! * bestT,
    );
    // Barrels are shootable (misc_explobox takes T_Damage): test the shot
    // path against live barrels before resolving the wall/monster hit.
    let hitBarrel: ServerBarrel | null = null;
    let barrelT = bestT;
    for (const b of st.barrels) {
      if (b.edict.freed) continue;
      const tHit = b.isFunc
        ? segmentAabbSeg(opts.eye, seg, v3(b.origin[0]! - b.size[0]! / 2, b.origin[1]! - b.size[1]! / 2, b.origin[2]! - b.size[2]! / 2), v3(b.origin[0]! + b.size[0]! / 2, b.origin[1]! + b.size[1]! / 2, b.origin[2]! + b.size[2]! / 2))
        : segmentAabbSeg(opts.eye, seg, v3(b.origin[0]! + EXPLOBOX_MINS[0]!, b.origin[1]! + EXPLOBOX_MINS[1]!, b.origin[2]! + EXPLOBOX_MINS[2]!), v3(b.origin[0]! + EXPLOBOX_MAXS[0]!, b.origin[1]! + EXPLOBOX_MAXS[1]!, b.origin[2]! + EXPLOBOX_MAXS[2]!));
      if (tHit !== null && tHit < barrelT) {
        barrelT = tHit;
        hitBarrel = b;
      }
    }
    if (hitBarrel && !hitBarrel.edict.freed) {
      SV_DamageBarrel(st, hitBarrel, pl.damage);
    } else if (hitMonster) {
      SV_DamageMonster(st, hitMonster, pl.damage, opts.rand);
    } else if (bestT < 1) {
      // TE_GUNSHOT / TE_SHOTGUN impact: gray sparks + smoke, no beam.
      st.sparks.push({
        pos: hitPos,
        color: 200 + ((opts.rand() * 55) | 0),
        vel: null,
        ttl: SV_SPARK_TTL,
        born: st.time,
      });
    }
  }
  return { fired: true, reason: 'ok', ammoLeft: res.ammoLeft, bolt: false };
}
