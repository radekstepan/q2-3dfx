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
  doorTravel,
  monsterChaseMove,
  monsterLocomotion,
  monsterThink,
  moverThink,
  moverUse,
  parseEntities,
  parseFloat,
  respawnDelayFor,
  resetEdictNums,
  spawnButton,
  spawnDoor,
  spawnEdict,
  spawnMonster,
  spawnPlat,
  spawnTrigger,
  triggerTouch,
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
}

export function SV_Init(): ServerState {
  return { time: 0, skill: 1, entities: [], movers: [], trains: [], monsters: [], triggers: [] as Trigger[], firedThisTick: [], moverDeltas: new Map(), moverBounds: new Map(), triggerBounds: new Map(), brushClips: new Map() };
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
        // SP_misc_explobox thinks M_droptofloor on spawn.
        if (dropTrace) {
          const g = droptofloor(e.origin, EXPLOBOX_MINS, EXPLOBOX_MAXS, dropTrace);
          e.origin[0] = g[0]!;
          e.origin[1] = g[1]!;
          e.origin[2] = g[2]!;
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
    if (e.classname.startsWith('monster_')) {
      // id skin assignment (m_soldier.c SP_monster_soldier_*): light troops
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
  for (const e of out) {
    if (!e.freed && e.classname === 'trigger_always' && e.target) {
      const pseudo: Edict = { ...e };
      fireTargets(st, pseudo);
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
    const action = monsterThink(ms);
    if (action === 'fire' && canSee) {
      events.push({
        num: m.edict.num,
        classname: m.edict.classname,
        attack: dist < 80 ? 'melee' : attackOfMove(m.kind, ms.move),
        move: ms.move,
        dmgScale: skillMultiplier(st.skill),
      });
    }
  }
  return events;
}

/**
 * Advance the world by dt seconds (default SERVER_DT = 0.1, 10Hz).
 * Runs movers and trains to completion legs, records per-mover displacement
 * for rider carrying, respawns due pickups, and clears per-tick diagnostics.
 */
export function SV_Tick(st: ServerState, dt: number = SERVER_DT): void {
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
