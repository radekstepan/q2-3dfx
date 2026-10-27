// @q2/game/monsters — soldier + gunner-lite state machines (m_soldier.c, m_gunner.c).
// Moves are data tables: {first, last, action per frame, end} exactly like
// id's mframe_t/mmovemove_t arrays, minus function pointers (actions are
// string tags the game logic switches on).

import type { Vec3 } from '@q2/math';
import { anglemod, v3 } from '@q2/math';
import { findPath, nearestNode } from './pathfind.js';
import type { PortalGraph } from './pathfind.js';

export const RANGE_MELEE = 0;
export const RANGE_NEAR = 1;
export const RANGE_MID = 2;
export const RANGE_FAR = 3;
export const MELEE_DISTANCE = 80;

/** id's range() thresholds from g_ai.c. */
export function monsterRange(dist: number): number {
  if (dist < MELEE_DISTANCE) return RANGE_MELEE;
  if (dist < 500) return RANGE_NEAR;
  if (dist < 1000) return RANGE_MID;
  return RANGE_FAR;
}

export interface MonsterFrame {
  /** movement applied this frame (forward units, id's ai_move dist) */
  dist: number;
  /** action tag: 'move' | 'fire' | 'duck' | 'melee' | ... */
  action: string;
}

export interface MonsterMove {
  name: string;
  first: number;
  last: number;
  frames: MonsterFrame[];
  end: string; // move to run when finished
}

function run(name: string, first: number, last: number, end: string, dist = 0, action = 'move'): MonsterMove {
  const frames: MonsterFrame[] = [];
  for (let f = first; f <= last; f++) {
    void f;
    frames.push({ dist, action });
  }
  return { name, first, last, frames, end };
}

/**
 * Authentic move builder: MD2 frame numbers are id's FRAME_* constants
 * (m_soldier.h / m_gunner.h), one dist per frame from the mframe_t tables.
 * `first` is the MD2 index of dists[0]; `last` is derived.
 */
function mv(name: string, first: number, dists: number[], end: string, action = 'move'): MonsterMove {
  return {
    name,
    first,
    last: first + dists.length - 1,
    frames: dists.map((dist) => ({ dist, action })),
    end,
  };
}

export interface MonsterDef {
  classname: string;
  health: number;
  gibHealth: number;
  mass: number;
  moves: Record<string, MonsterMove>;
}

// Frame numbers are id's MD2 FRAME_* constants (m_soldier.h / m_gunner.h),
// NOT name suffixes. Dists are the per-frame ai_move/ai_run/ai_walk/ai_charge
// values from m_soldier.c / m_gunner.c (origin is 24 above the feet:
// mins -24, maxs +32 — see MONSTER_HULL_* below).
//
// Soldier attack fire tags (m_soldier.c): attack1 (FRAME_attak101-112) fires
// at its 3rd frame (soldier_fire1 -> shotgun/blaster by skin), attack2
// (FRAME_attak201-218) fires at its 5th frame (soldier_fire2). The lite
// driver gates return-fire damage on monsterThink's 'fire' return, so these
// tags are what make soldier shots land on the muzzle flash instead of on a
// wall-clock timer.
function soldierAttackFrames(count: number, fireIdx: number): MonsterFrame[] {
  const frames: MonsterFrame[] = [];
  for (let f = 0; f < count; f++) frames.push({ dist: 0, action: f === fireIdx ? 'fire' : 'move' });
  return frames;
}

const soldierAttack1: MonsterMove = {
  name: 'attack1',
  first: 0,
  last: 11,
  frames: soldierAttackFrames(12, 2),
  end: 'run',
};

const soldierAttack2: MonsterMove = {
  name: 'attack2',
  first: 12,
  last: 29,
  frames: soldierAttackFrames(18, 4),
  end: 'run',
};

export const SOLDIER: MonsterDef = {
  classname: 'monster_soldier',
  health: 30,
  gibHealth: -30,
  mass: 100,
  moves: {
    stand1: mv('stand1', 146, new Array(30).fill(0), 'stand1'),
    walk1: mv('walk1', 215, [3, 6, 2, 2, 2, 1, 6, 5, 3, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'walk1'),
    walk2: mv('walk2', 256, [4, 4, 9, 8, 5, 1, 3, 7, 6, 7], 'walk2'),
    start_run: mv('start_run', 97, [7, 5], 'run'),
    run: mv('run', 99, [10, 11, 11, 16, 10, 15], 'run'),
    pain1: mv('pain1', 50, [-3, 4, 1, 1, 0], 'run'),
    pain2: mv('pain2', 55, [-13, -1, 2, 4, 2, 3, 2], 'run'),
    pain3: mv('pain3', 62, [-8, 10, -4, -1, -3, 0, 3, 0, 0, 0, 0, 1, 0, 1, 2, 4, 3, 2], 'run'),
    attack1: soldierAttack1,
    attack2: soldierAttack2,
    duck: mv('duck', 45, [5, -1, 1, 0, 5], 'run'),
    death1: mv('death1', 272, [0, -10, -10, -10, -5, ...new Array(31).fill(0)], 'dead'),
  },
};

export const GUNNER: MonsterDef = {
  classname: 'monster_gunner',
  health: 175,
  gibHealth: -70,
  mass: 200,
  moves: {
    stand: mv('stand', 0, new Array(30).fill(0), 'stand'),
    walk: mv('walk', 76, [0, 3, 4, 5, 7, 2, 6, 4, 2, 7, 5, 7, 4], 'walk'),
    run: mv('run', 94, [26, 9, 9, 9, 15, 10, 13, 6], 'run'),
    runandshoot: mv('runandshoot', 102, [32, 15, 10, 18, 8, 20], 'run', 'fire'),
    pain1: mv('pain1', 159, [2, 0, -5, 3, -1, 0, 0, 0, 0, 1, 1, 2, 1, 0, -2, -2, 0, 0], 'run'),
    pain2: mv('pain2', 177, [-2, 11, 6, 2, -1, -7, -2, -7], 'run'),
    pain3: mv('pain3', 185, [-3, 1, 1, 0, 1], 'run'),
    attack_chain: mv('attack_chain', 137, new Array(7).fill(0), 'fire_chain', 'fire'),
    // id gunner_move_fire_chain ends in gunner_refire_chain (a function, not
    // a move: it re-enters fire_chain while the enemy is visible, else exits
    // via endfire_chain). The lite tables are pure data, so the chain exits
    // deterministically after one 8-frame burst (a dangling 'refire_chain'
    // end would make monsterMoveOf throw on the next tick).
    fire_chain: mv('fire_chain', 144, new Array(8).fill(0), 'endfire_chain', 'fire'),
    endfire_chain: mv('endfire_chain', 152, new Array(7).fill(0), 'run'),
    attack_grenade: mv('attack_grenade', 108, new Array(21).fill(0), 'run', 'fire'),
    duck: mv('duck', 201, [1, 1, 1, 0, -1, -1, 0, -1], 'run'),
    death: mv('death', 190, [0, 0, 0, -7, -3, -5, 8, 6, 0, 0, 0], 'dead'),
  },
};

export type MonsterKind = 'soldier' | 'gunner' | 'infantry';

/**
 * C attack_state (g_local.h monsterinfo_t: AS_STRAIGHT/AS_MISSILE/AS_MELEE/
 * AS_SLIDING/AS_BLIND). Our kinds never fly, so SLIDING never occurs and
 * BLIND (predator/orbital-strike monsters only in C) is unrepresentable —
 * the lite sim runs the STRAIGHT/MISSILE/MELEE subset M_CheckAttack emits.
 */
export type AttackState = 'straight' | 'missile' | 'melee';

export function monsterDef(kind: MonsterKind): MonsterDef {
  if (kind === 'soldier') return SOLDIER;
  if (kind === 'gunner') return GUNNER;
  return INFANTRY;
}

export interface MonsterState {
  kind: MonsterKind;
  health: number;
  move: string;
  frame: number; // absolute frame number within current move
  dead: boolean;
  /**
   * Gibbed (id DEAD_DEAD after ThrowGib: soldier_die/gunner_die gib branch).
   * Gibbed bodies are gone — unhittable, skipped by snapshots. Plain corpses
   * (dead, !gibbed) stay hittable (takedamage YES) so re-hitting them can
   * still mince them via the gib-health check below.
   */
  gibbed: boolean;
  /** Facing yaw in degrees (Q2 convention: 0 = +X, 90 = +Y/left). */
  yaw: number;
  // --- C monsterinfo pursuit/attack fields (M5.3 depth; g_ai.c/g_local.h) ----
  // The lite sim used to beeline at the player and roll a flat 0.7 attack
  // commit. These fields carry the C ai_run/ai_checkattack state so monsters
  // follow the player trail around corners and gate attacks the C way.
  /** C monsterinfo.attack_state (what the last check decided). */
  attackState: AttackState;
  /** C monsterinfo.attack_finished: no new attack may start before this. */
  attackFinished: number;
  /** C monsterinfo.trail_time: timestamp of the trail marker being pursued. */
  trailTime: number;
  /** C monsterinfo.last_sighting: enemy spot at the last visible tick. */
  lastSighting: Vec3;
  /** C monsterinfo.search_time: pursuit gives up past search_time + 20. */
  searchTime: number;
  /** C AI_LOST_SIGHT: set on the tick sight breaks, cleared on regain. */
  lostSight: boolean;
  /** C AI_PURSUE_NEXT: reached the current goal, pick the next marker. */
  pursueNext: boolean;
  /** C AI_PURSUE_TEMP: last_sighting is a sidestep probe, retry after. */
  pursueTemp: boolean;
  /** C AI_PURSUIT_LAST_SEEN: next pick is the first-trail-marker branch. */
  pursuitLastSeen: boolean;
  /** C monsterinfo.saved_goal: probe origin saved across a sidestep. */
  savedGoal: Vec3;
}

export function spawnMonster(kind: MonsterKind): MonsterState {
  const def = monsterDef(kind);
  return {
    kind,
    health: def.health,
    move: kind === 'soldier' ? 'stand1' : 'stand',
    frame: 0,
    dead: false,
    gibbed: false,
    yaw: 0,
    attackState: 'straight',
    attackFinished: 0,
    trailTime: 0,
    lastSighting: v3(),
    searchTime: 0,
    lostSight: false,
    pursueNext: false,
    pursueTemp: false,
    pursuitLastSeen: false,
    savedGoal: v3(),
  };
}

export function monsterMoveOf(ms: MonsterState): MonsterMove {
  const def = monsterDef(ms.kind);
  const mv = def.moves[ms.move];
  if (!mv) throw new Error(`unknown move ${ms.move} for ${ms.kind}`);
  return mv;
}

/**
 * Render frame for a monster (web driver entityFrame): the move's MD2
 * `first` + the current frame offset, clamped to the move's last frame
 * so an overrun frame (or a death move held past its end) never walks
 * off the model. id holds the last death frame; the clamp is what keeps
 * corpses rendering the fallen pose instead of garbage.
 */
export function monsterFrameNumber(ms: MonsterState): number {
  const mv = monsterMoveOf(ms);
  const idx = Math.max(0, Math.min(ms.frame, mv.frames.length - 1));
  return mv.first + idx;
}

/**
 * Render angles for a monster (host entityAngles hook): yaw-only facing
 * from the stored yaw (was null → yaw 0 before the M7.2 facing fix).
 * Corpses keep their last yaw (locomotion never turns the dead).
 */
export function entityAngles(ms: MonsterState): [number, number, number] {
  return [0, ms.yaw, 0];
}

/**
 * Corpses stay hittable (id takedamage YES on the dead body — soldier_die
 * only stops at DEAD_DEAD after gibbing). Gibbed bodies are gone:
 * unhittable, skipped by snapshots. Only direct re-hits mince; radius
 * damage never minces (the driver skips dead bodies there by design).
 */
export function corpseHittable(ms: MonsterState): boolean {
  return ms.dead && !ms.gibbed;
}

/**
 * id's vectoyaw (g_utils.c): facing yaw in degrees from `from` toward `to`
 * (Q2: +X forward, +Y left, so yaw = atan2(dy, dx)), wrapped to [0, 360).
 * Z is ignored: monsters yaw on the floor plane (M_ChangeYaw).
 */
export function monsterYawTo(from: Vec3, to: Vec3): number {
  const dx = to[0]! - from[0]!;
  const dy = to[1]! - from[1]!;
  if (dx === 0 && dy === 0) return 0;
  let yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (yaw < 0) yaw += 360;
  if (yaw >= 360) yaw -= 360;
  return yaw;
}

/** id's yaw_speed per kind (m_soldier.c / m_gunner.c SP_ funcs; infantry
 * inherits walkmonster_start's default 20 — m_infantry.c sets none). */
export const MONSTER_YAW_SPEED: Record<MonsterKind, number> = { soldier: 20, gunner: 20, infantry: 20 };

// --- C damage/HP tables (Phase 2 audit: m_soldier.c SP_ funcs, m_infantry.c) --
//
// The lite soldier sim carries one shared SOLDIER def (30hp: the normal), but
// C spawns three HP classes by skin: light troops (skin 0/1, blaster) 20hp,
// normals (skin 2/3, shotgun) 30hp, supershots (skin 4+, machinegun) 40hp —
// all gib at -30. Spawn paths must stamp the skin HP (see
// soldierHealthForSkin), or TTK lies by a full blaster bolt per skin.

/** C spawn HP per soldier skin family (m_soldier.c SP_monster_soldier_*). */
export const SOLDIER_HP: Record<'blaster' | 'shotgun' | 'machinegun', number> = {
  blaster: 20,
  shotgun: 30,
  machinegun: 40,
};

/** C gib health shared by all three soldier skins (m_soldier.c). */
export const SOLDIER_GIB_HEALTH = -30;

/**
 * Skin-aware soldier spawn HP (thresholds mirror soldierWeaponForSkin in
 * weapons.ts: skins 0-1 light, 2-3 normal, 4+ super-shot).
 */
export function soldierHealthForSkin(skin: number): number {
  if (skin <= 1) return SOLDIER_HP.blaster;
  if (skin <= 3) return SOLDIER_HP.shotgun;
  return SOLDIER_HP.machinegun;
}

/**
 * C infantry tables (m_infantry.c SP_monster_infantry) as pure data, now
 * backed by the INFANTRY lite def below: 100hp / gib -40 / mass 200, ranged
 * monster_fire_bullet dmg 3 kick 4 spread 300/500 (m_infantry.c
 * InfantryMachineGun), melee fire_hit dmg 5+(rand%5) kick 50
 * (m_infantry.c infantry_smack).
 */
export interface InfantryCStats {
  health: number;
  gibHealth: number;
  mass: number;
  bulletDamage: number;
  bulletKick: number;
  bulletHspread: number;
  bulletVspread: number;
  meleeDamageMin: number;
  meleeDamageMax: number;
  meleeKick: number;
}

export const INFANTRY_C: InfantryCStats = {
  health: 100,
  gibHealth: -40,
  mass: 200,
  bulletDamage: 3,
  bulletKick: 4,
  bulletHspread: 300,
  bulletVspread: 500,
  meleeDamageMin: 5,
  meleeDamageMax: 9,
  meleeKick: 50,
};

/** C spawn HP (m_infantry.c SP_monster_infantry: no skin classes, all 100). */
export const INFANTRY_HP = 100;
/** C gib health shared by all infantry (m_infantry.c). */
export const INFANTRY_GIB_HEALTH = -40;

/**
 * Build a move with per-frame action tags (id mframe_t func slots, data-only).
 * `tags[i]` overrides frame i's action; untagged frames are plain 'move'.
 */
function taggedMove(
  name: string,
  first: number,
  dists: number[],
  end: string,
  tags: Record<number, string>,
): MonsterMove {
  return {
    name,
    first,
    last: first + dists.length - 1,
    frames: dists.map((dist, i) => ({ dist, action: tags[i] ?? 'move' })),
    end,
  };
}

// Frame numbers are id's MD2 FRAME_* constants (m_infantry.h), dists are
// the per-frame ai_stand/ai_walk/ai_run/ai_charge/ai_move values from
// m_infantry.c (MD2 has 206 frames: gun02=0 … attak208=206).
//
// Attack fire tags: attack1 (FRAME_attak101-115, the machinegun) fires via
// infantry_fire at its 11th frame (attak111 = InfantryMachineGun single
// bullet; the C AI_HOLD_FRAME re-fire across pausetime collapses to this
// one lite event); attack2 (FRAME_attak201-208, the melee) swings at frame
// 3 (infantry_swing) and smacks at frame 6 (infantry_smack 5+(rand%5)
// kick 50 — the 'melee' tag is what resolveMonsterFire keys off).
export const INFANTRY: MonsterDef = {
  classname: 'monster_infantry',
  health: INFANTRY_HP,
  gibHealth: INFANTRY_GIB_HEALTH,
  mass: 200,
  moves: {
    stand: mv('stand', 50, new Array(22).fill(0), 'stand'),
    walk: mv('walk', 74, [5, 4, 4, 5, 4, 5, 6, 4, 4, 4, 4, 5], 'walk'),
    run: mv('run', 92, [10, 20, 5, 7, 30, 35, 2, 6], 'run'),
    pain1: mv('pain1', 100, [-3, -2, -1, -2, -1, 1, -1, 1, 6, 2], 'run'),
    pain2: mv('pain2', 110, [-3, -3, 0, -1, -2, 0, 0, 2, 5, 2], 'run'),
    duck: mv('duck', 120, [-2, -5, 3, 4, 0], 'run'),
    death1: mv('death1', 125, [-4, 0, 0, -1, -4, 0, 0, 0, -1, 3, 1, 1, -2, 2, 2, 9, 9, 5, -3, -3], 'dead'),
    death2: mv('death2', 145, [0, 1, 5, -1, 0, 1, 1, 4, 3, 0, -2, -2, -3, -1, -2, 0, 2, 2, 3, -10, -7, -8, -6, 4, 0], 'dead'),
    death3: mv('death3', 170, [0, 0, 0, -6, -11, -3, -11, 0, 0], 'dead'),
    attack1: taggedMove('attack1', 184, [4, -1, -1, 0, -1, 1, 1, 2, -2, -3, 1, 5, -1, -2, -3], 'run', { 10: 'fire' }),
    attack2: taggedMove('attack2', 199, [3, 6, 0, 8, 5, 8, 6, 3], 'run', { 5: 'melee' }),
  },
};

/**
 * id m_move.c M_ChangeYaw: shortest-arc step from `current` toward `ideal`,
 * clamped to `speed` degrees. Both inputs wrap via anglemod; the return is
 * always in [0, 360).
 */
export function changeYaw(current: number, ideal: number, speed: number): number {
  const cur = anglemod(current);
  const tgt = anglemod(ideal);
  if (cur === tgt) return cur;
  let move = tgt - cur;
  if (tgt > cur) {
    if (move >= 180) move -= 360;
  } else {
    if (move <= -180) move += 360;
  }
  if (move > 0) {
    if (move > speed) move = speed;
  } else {
    if (move < -speed) move = -speed;
  }
  return anglemod(cur + move);
}

/**
 * Signed shortest-arc difference a-b in (-180, 180] degrees. Used for the
 * FacingIdeal attack gate in monsterChaseMove.
 */
export function yawDiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

/** Advance one server frame (0.1s). Returns the action tag of this frame. */
export function monsterThink(ms: MonsterState): string {
  if (ms.dead) {
    // Corpses persist (id holds the last death frame: the dead monster keeps
    // rendering via the snapshot instead of being freed). Advance the death
    // move to its last frame, then hold it — never wrap, never transition
    // (the 'dead' end name has no move table and must never be entered).
    const mv = monsterMoveOf(ms);
    if (ms.frame < mv.frames.length - 1) ms.frame++;
    return mv.frames[ms.frame]?.action ?? 'move';
  }
  const mv = monsterMoveOf(ms);
  const idx = ms.frame;
  const fr = mv.frames[idx] ?? { dist: 0, action: 'move' };
  ms.frame++;
  if (ms.frame >= mv.frames.length) {
    ms.move = mv.end;
    ms.frame = 0;
  }
  return fr.action;
}

// --- locomotion (M7.4 follow-up; the driver moves bodies, think only picks frames) ---

/** Monster hull in origin space (id m_soldier.c: mins -16,-16,-24 / maxs +16,+16,+32).
 * The origin sits 24 units above the feet; the MD2 verts span -24..+32 so a
 * resting origin is floor+24. Feet-space (0..56) sinks models halfway. */
export const MONSTER_HULL_MINS: Vec3 = v3(-16, -16, -24);
export const MONSTER_HULL_MAXS: Vec3 = v3(16, 16, 32);

/** Largest downward step a monster sticks to (id STEPSIZE). */
export const MONSTER_STEP_HEIGHT = 18;

/**
 * Maximum drop applied per 0.1s locomotion tick when no ground is in reach
 * (500 u/s terminal probe; keeps bodies from hovering off ledges).
 */
export const MONSTER_FALL_PROBE = 50;

/**
 * One locomotion tick (10Hz): yaw the monster toward `playerPos`, advance
 * `origin` along the facing by the CURRENT frame's `dist` (MonsterFrame.dist,
 * the same units monsterThink plays), collision-clamped via `trace`, then
 * drop to the ground via a downward trace (sticks to floors and step-downs
 * within MONSTER_STEP_HEIGHT, falls bounded by MONSTER_FALL_PROBE).
 *
 * `moveTarget` (default: the player) overrides the steering target while
 * facing/closing still key off the enemy: the trail-pursuit tick steers at
 * lastSighting/trail markers so the body rounds corners instead of
 * beelining the (possibly hidden) player. Facing follows the steering
 * target (C turns toward ideal_yaw, which ai_run points at the goal while
 * pursuing blind, and at the enemy while visible).
 *
 * `trace` works in monster-origin space: the caller expands obstacles by the
 * monster hull (MONSTER_HULL_MINS/MAXS) and traces the origin as a point
 * segment; only `fraction`/`endpos` are used. Mutates `origin` in place and
 * `state.yaw` (facing only), and touches nothing else (no I/O, no globals),
 * so it is headless-testable with a stub trace. Corpses (`state.dead`)
 * never move and keep their last yaw.
 *
 * Reads `state.frame` without advancing it: call BEFORE monsterThink each
 * tick so the move plays the frame think is about to advance (id ai_move
 * runs inside the frame, then the frame counter steps).
 */
export function monsterLocomotion(
  state: MonsterState,
  origin: Vec3,
  playerPos: Vec3,
  trace: (start: Vec3, end: Vec3) => { fraction: number; endpos: Vec3 },
  moveTarget?: Vec3,
): void {
  if (state.dead) return;
  const mv = monsterMoveOf(state);
  const fr = mv.frames[state.frame] ?? { dist: 0, action: 'move' };
  const goal = moveTarget ?? playerPos;
  const dx = goal[0]! - origin[0]!;
  const dy = goal[1]! - origin[1]!;
  const len = Math.sqrt(dx * dx + dy * dy);
  // Face the steering target every tick via id M_ChangeYaw (shortest-arc,
  // clamped by yaw_speed) — never an instant snap; only translate when the
  // frame carries a dist so stand/attack frames never moonwalk.
  if (len > 1e-9) {
    state.yaw = changeYaw(state.yaw, monsterYawTo(origin, goal), MONSTER_YAW_SPEED[state.kind]);
    if (fr.dist !== 0) {
      const nx = dx / len;
      const ny = dy / len;
      const end = v3(origin[0]! + nx * fr.dist, origin[1]! + ny * fr.dist, origin[2]!);
      const h = trace(v3(origin[0], origin[1], origin[2]), end);
      origin[0] = h.endpos[0]!;
      origin[1] = h.endpos[1]!;
      origin[2] = h.endpos[2]!;
    }
  }
  // Gravity: probe down from 1 unit above the feet so resting contact is a
  // clean hit, not a startsolid; snap to ground when in reach, else fall the
  // bounded probe so ledges never hover.
  const gstart = v3(origin[0], origin[1], origin[2]! + 1);
  const gend = v3(origin[0], origin[1], origin[2]! - MONSTER_FALL_PROBE);
  const g = trace(gstart, gend);
  if (g.fraction < 1) {
    origin[2] = g.endpos[2]!;
  } else {
    origin[2] = gend[2]!;
  }
}

/**
 * id T_Damage gib-first ordering (g_combat.c): the gib-health check runs
 * before the dead re-entry gate (soldier_die checks `health <= gib_health`
 * first, then `deadflag == DEAD_DEAD`). Returns what happened so drivers can
 * spawn gib extras + udeath on 'gib':
 * - 'gib': health at/below gibHealth — mince (DEAD_DEAD, unhittable).
 * - 'dead': killed (or a corpse re-hit short of gibbing — stays a corpse).
 * - 'pain': survived, maybe entered a pain move.
 * - 'none': already gibbed (unhittable — no further damage).
 */
export function monsterPain(ms: MonsterState, damage: number, rand: () => number): 'gib' | 'dead' | 'pain' | 'none' {
  if (ms.gibbed) return 'none';
  ms.health -= damage;
  if (ms.health <= monsterDef(ms.kind).gibHealth) {
    ms.dead = true;
    ms.gibbed = true;
    ms.move = ms.kind === 'soldier' ? 'death1' : 'death';
    ms.frame = 0;
    return 'gib';
  }
  if (ms.dead) return 'dead';
  if (ms.health <= 0) {
    ms.dead = true;
    // id infantry_die: n = rand() % 3 across the three death moves;
    // soldier/gunner lite sims hold one death move each.
    if (ms.kind === 'infantry') {
      const pick = Math.floor(rand() * 3) % 3;
      ms.move = pick === 0 ? 'death1' : pick === 1 ? 'death2' : 'death3';
    } else {
      ms.move = ms.kind === 'soldier' ? 'death1' : 'death';
    }
    ms.frame = 0;
    return 'dead';
  }
  // id skips pain anims probabilistically; keep deterministic via caller rng.
  // (C infantry_pain also suppresses pain anims entirely at skill 3
  // nightmare; the lite sim has no skill input, so aggression scaling stays
  // a documented deviation — see selectAttack.)
  if (rand() < 0.4) {
    if (ms.kind === 'infantry') {
      ms.move = Math.floor(rand() * 2) === 0 ? 'pain1' : 'pain2';
    } else {
      ms.move = ms.kind === 'soldier' ? (rand() < 0.5 ? 'pain1' : 'pain2') : 'pain1';
    }
    ms.frame = 0;
  }
  return 'pain';
}

export type AttackChoice = 'melee' | 'shotgun' | 'blaster' | 'machinegun' | 'chaingun' | 'grenade' | 'none';

/**
 * Which kinds have a real melee callback (C monsterinfo.melee != NULL).
 * Soldier/gunner melee is NULL in C (m_soldier.c/m_gunner.c never assign
 * it — point-blank events resolve as gunfire, see resolveMonsterFire); only
 * infantry has the smack (m_infantry.c infantry_attack -> attack2). The
 * melee branch of checkAttack keys the attack_state off this, exactly like
 * C's `if (self->monsterinfo.melee)` test.
 */
export function monsterHasMelee(kind: MonsterKind): boolean {
  return kind === 'infantry';
}

// --- M_CheckAttack (g_ai.c) + skill-scaled aggression (M5.3 depth) ----------
//
// Port of C M_CheckAttack with our naming. The caller supplies the eye-to-
// eye clear-shot result as `canSee` (C runs the trace inline against
// SOLID|MONSTER|SLIME|LAVA|WINDOW); everything else is the C decision
// tree verbatim: melee gate (easy mode fails it 3/4 via rand()&3), the
// attack-callback + attack_finished + FAR rejects, and the range/stand-
// ground chance table scaled x0.5 on easy / x2 on hard+ (skill->value).
//
// On success the result carries AS_MISSILE/AS_MELEE plus the refreshed
// attack_finished (level.time + 2*random); on failure the attack_state
// falls back to AS_STRAIGHT (C leaves flying monsters sliding — no flyers
// exist in the lite sim, documented).

export interface CheckAttackOpts {
  /** C enemy_range: monsterRange(dist) to the enemy. */
  range: number;
  /** Eye-to-eye clear shot (C inline trace passed). */
  canSee: boolean;
  /** C AI_STAND_GROUND (combat-point hold / ambush stand). */
  standGround: boolean;
  /** C monsterinfo.attack_finished. */
  attackFinished: number;
  /** C level.time. */
  time: number;
  /** C skill->value 0-3. */
  skill: number;
  /** C monsterinfo.attack != NULL (always true for our kinds). */
  hasAttack: boolean;
  /** C monsterinfo.melee != NULL (infantry only — see monsterHasMelee). */
  hasMelee: boolean;
  rand: () => number;
}

export interface CheckAttackResult {
  attack: boolean;
  attackState: AttackState;
  attackFinished: number;
}

export function checkAttack(opts: CheckAttackOpts): CheckAttackResult {
  const { range, canSee, standGround, attackFinished, time, skill, hasAttack, hasMelee, rand } = opts;
  if (!canSee) return { attack: false, attackState: 'straight', attackFinished };
  // Melee attack (C: enemy in melee range — easy mode usually declines).
  if (range === RANGE_MELEE) {
    // C: `if (skill->value == 0 && (rand()&3)) return false` — the float-rand
    // equivalent of the low two bits being nonzero (3/4 of the time).
    if (skill === 0 && Math.floor(rand() * 4) !== 0) {
      return { attack: false, attackState: 'straight', attackFinished };
    }
    return {
      attack: true,
      attackState: hasMelee ? 'melee' : 'missile',
      attackFinished,
    };
  }
  // Missile attack gates.
  if (!hasAttack) return { attack: false, attackState: 'straight', attackFinished };
  if (time < attackFinished) return { attack: false, attackState: 'straight', attackFinished };
  if (range === RANGE_FAR) return { attack: false, attackState: 'straight', attackFinished };
  let chance: number;
  if (standGround) chance = 0.4;
  else if (range === RANGE_MELEE) chance = 0.2;
  else if (range === RANGE_NEAR) chance = 0.1;
  else if (range === RANGE_MID) chance = 0.02;
  else return { attack: false, attackState: 'straight', attackFinished };
  if (skill === 0) chance *= 0.5;
  else if (skill >= 2) chance *= 2;
  if (rand() < chance) {
    return {
      attack: true,
      attackState: 'missile',
      attackFinished: time + 2 * rand(),
    };
  }
  return { attack: false, attackState: 'straight', attackFinished };
}

/**
 * Sight-delay before the first attack after acquiring the enemy (C
 * HuntTarget AttackFinished(self, 1): a flat 1s hold). Skill-scaled
 * extension the job asks for: easy reacts slower, nightmare near-
 * instantly; medium keeps the C 1s. No jitter (C has none).
 */
export function sightReactionDelay(skill: number): number {
  if (skill <= 0) return 1.2;
  if (skill === 1) return 1.0;
  if (skill === 2) return 0.6;
  return 0.3;
}

/** Soldier dodge outcome (C soldier_dodge branches). */
export type DodgeChoice = 'none' | 'duck' | 'duckShoot';

/**
 * C check_dodge easy-mode pre-gate (g_weapon.c): on easy the whole dodge
 * check only runs a quarter of the time. Skill 1+ always checks.
 */
export function checkDodgeGate(skill: number, rand: () => number): boolean {
  if (skill === 0 && rand() > 0.25) return false;
  return true;
}

/**
 * C soldier_dodge (m_soldier.c): 25% of incoming projectile shots make the
 * soldier react; easy always ducks, medium ducks 1/3 else duck-and-shoots
 * (attack3), hard+ ducks 2/3 else duck-and-shoots.
 */
export function soldierDodgeChoice(skill: number, rand: () => number): DodgeChoice {
  if (rand() > 0.25) return 'none';
  if (skill === 0) return 'duck';
  if (skill === 1) return rand() > 0.33 ? 'duck' : 'duckShoot';
  if (skill >= 2) return rand() > 0.66 ? 'duck' : 'duckShoot';
  return 'duckShoot';
}

/**
 * C soldier_duck_down hull (m_soldier.c): maxs[2] -= 32, so the 16x16x56
 * standing hull becomes 16x16x24 while ducked (mins unchanged). Bolt and
 * pellet sweeps test this hull while the duck move plays.
 */
export const MONSTER_HULL_MAXS_DUCKED: Vec3 = v3(16, 16, 0);

/**
 * Skill-3 burst refire (m_soldier.c attack4/attack6 nextframe: skill 3
 * re-fires the machinegun move half the time instead of exiting). The tick
 * calls this when an attack move runs to completion; true re-enters the
 * same move immediately, bypassing checkAttack like C's nextframe does.
 * Only the machinegun-class guns burst (soldier ss skin, gunner chain).
 */
export function burstRefire(skill: number, machinegunClass: boolean, rand: () => number): boolean {
  if (skill < 3 || !machinegunClass) return false;
  return rand() < 0.5;
}
/**
 * Melee/ranged selection by range. Soldier picks its skin weapon at
 * near/mid (see selectSoldierAttack); gunner sprays or lobs (the lite
 * caller handles LOS for grenades); infantry (m_infantry.c infantry_attack)
 * commits to the melee move in melee range, else the machinegun strafe.
 */
export function selectAttack(kind: MonsterKind, dist: number, rand: () => number): AttackChoice {
  const r = monsterRange(dist);
  if (r === RANGE_MELEE) return 'melee';
  if (kind === 'soldier') {
    if (r === RANGE_NEAR || r === RANGE_MID) return rand() < 0.5 ? 'shotgun' : 'blaster';
    return 'none';
  }
  if (kind === 'infantry') {
    if (r === RANGE_NEAR || r === RANGE_MID) return 'machinegun';
    return 'none';
  }
  // gunner: grenade at mid without line-of-sight handled by caller; chain otherwise
  if (r === RANGE_NEAR || r === RANGE_MID) return rand() < 0.7 ? 'chaingun' : 'grenade';
  return 'none';
}

// --- node-graph navigation (M7.4; full M5.3 AI remains out of scope) ----------
//
// The lite soldier/gunner state machines above only stand, walk in place and
// attack. monsterChaseMove adds the missing link: steering toward the player
// along a caller-supplied node graph (BFS in pathfind.ts). It stays
// data-driven — it only switches ms.move among the def's existing moves
// (run / runandshoot / attack* / stand) and never invents frames.

export interface MonsterNav {
  graph: PortalGraph;
  positions: Map<number, Vec3>;
}

export interface ChaseResult {
  /** move selected this tick (already installed on ms) */
  move: string;
  /** node path toward the player, or null when standing/attacking */
  path: number[] | null;
  /** next waypoint position, or null when standing/attacking */
  target: Vec3 | null;
}

/** Map an attack choice onto the kind's data-table move names. The soldier
 * 'machinegun' choice (ss skins, m_soldier.c attack4/attack6 — full moves
 * arrive with M5.3 full AI) plays the generic gunfire anim: it is a KNOWN
 * move every lane already treats as hitscan (web monsterFire only spawns
 * the foe bolt on attack2; server attackOfMove maps attack1 -> shotgun).
 * It must never be attack2 — the bolt move. */
export function attackMoveFor(kind: MonsterKind, choice: AttackChoice): string {
  // Infantry attack mapping (m_infantry.c infantry_attack): melee commits
  // to attack2 (the smack), everything ballistic plays the attack1
  // machinegun strafe.
  if (kind === 'infantry') {
    switch (choice) {
      case 'melee':
        return 'attack2';
      case 'none':
        return 'run';
      default:
        return 'attack1';
    }
  }
  switch (choice) {
    case 'shotgun':
      return 'attack1';
    case 'machinegun':
      return kind === 'soldier' ? 'attack1' : 'attack_chain';
    case 'blaster':
      return 'attack2';
    case 'chaingun':
      return 'attack_chain';
    case 'grenade':
      return 'attack_grenade';
    case 'melee':
      return kind === 'soldier' ? 'attack1' : 'attack_chain';
    case 'none':
      return kind === 'soldier' ? 'run' : 'runandshoot';
  }
}

function setMove(ms: MonsterState, move: string): void {
  if (ms.move !== move) {
    ms.move = move;
    ms.frame = 0;
  }
}

/** True for the firing/exit attack moves (id mmove_t attack sequences). While
 * one of these is playing, monsterChaseMove holds it to completion instead
 * of re-rolling selectAttack (which restarted frame 0 every tick). */
const ATTACK_MOVES: ReadonlySet<string> = new Set([
  'attack1',
  'attack2',
  'attack_chain',
  'fire_chain',
  'endfire_chain',
  'attack_grenade',
]);

export function isAttackMove(move: string): boolean {
  return ATTACK_MOVES.has(move);
}

/**
 * Optional per-tick context for monsterChaseMove. All optional so existing
 * callers (and the C-default behaviour) keep working with no changes:
 * - time/skill feed M_CheckAttack (defaults: 0/1 — the pre-depth path ran
 *   with no clock and medium odds);
 * - standGround mirrors AI_STAND_GROUND (combat-point hold);
 * - goal overrides the steering target while range/commit still key off the
 *   enemy (playerPos): the trail-pursuit tick steers at lastSighting/trail
 *   markers instead of beelining the (possibly hidden) player.
 */
export interface ChaseOpts {
  time?: number;
  skill?: number;
  standGround?: boolean;
  goal?: Vec3 | null;
}

/**
 * One chase tick: attack when in range with line of sight (gated by the
 * C M_CheckAttack chance table, not the old flat 0.7 roll), else navigate
 * the graph toward the goal. `dist` is the 3D monster-player distance,
 * `canSee` the caller's line-of-sight result. Returns the chosen move plus
 * the node path (null while attacking/standing).
 */
export function monsterChaseMove(
  ms: MonsterState,
  selfPos: Vec3,
  playerPos: Vec3,
  nav: MonsterNav,
  canSee: boolean,
  rand: () => number,
  opts?: ChaseOpts,
): ChaseResult {
  if (ms.dead) return { move: ms.move, path: null, target: null };
  // Attack latch: an attack move already playing runs to completion
  // (monsterThink advances it). Re-rolling here picked a new random attack
  // every tick, resetting frame to 0 — the anim strobed instead of playing.
  if (isAttackMove(ms.move)) return { move: ms.move, path: null, target: null };
  const time = opts?.time ?? 0;
  const skill = opts?.skill ?? 1;
  const goal = opts?.goal ?? playerPos;
  const dx = playerPos[0]! - selfPos[0]!;
  const dy = playerPos[1]! - selfPos[1]!;
  const dz = playerPos[2]! - selfPos[2]!;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const r = monsterRange(dist);
  // M_CheckAttack (g_ai.c): chance/as-state gating, skill-scaled. The old
  // flat `rand() < 0.7` commit fired far too eagerly (and never cooled
  // down); the C table + attack_finished is what paces real engagements.
  if (canSee) {
    const chk = checkAttack({
      range: r,
      canSee: true,
      standGround: opts?.standGround ?? false,
      attackFinished: ms.attackFinished,
      time,
      skill,
      hasAttack: true,
      hasMelee: monsterHasMelee(ms.kind),
      rand,
    });
    ms.attackState = chk.attackState;
    ms.attackFinished = chk.attackFinished;
    if (chk.attack) {
      // id FacingIdeal gate (ai_charge / ai_run_missile): only enter the
      // attack move when already roughly facing the enemy (±45°). Otherwise
      // keep closing/turning below so M_ChangeYaw can catch up — the anim
      // never fires over the shoulder.
      if (Math.abs(yawDiff(monsterYawTo(selfPos, playerPos), ms.yaw)) <= 45) {
        const choice = selectAttack(ms.kind, dist, rand);
        if (choice !== 'none') {
          const move = attackMoveFor(ms.kind, choice);
          setMove(ms, move);
          return { move, path: null, target: null };
        }
      }
    }
  } else {
    ms.attackState = 'straight';
  }
  // AI_STAND_GROUND (combat-point hold / ambush stand): plant and shoot,
  // never walk the graph. C ai_stand still runs the attack check above, so
  // a holder with sight and a passed roll enters the attack move; reaching
  // here means hold position.
  if (opts?.standGround ?? false) {
    const stand = ms.kind === 'soldier' ? 'stand1' : 'stand';
    setMove(ms, stand);
    return { move: ms.move, path: null, target: null };
  }
  // Close in: walk the node graph toward the goal (the enemy when visible,
  // the last sighting / trail marker while pursuing blind).
  const from = nearestNode(nav.positions, selfPos);
  const to = nearestNode(nav.positions, goal);
  if (from !== null && to !== null) {
    const path = from === to ? [from] : findPath(nav.graph, from, to);
    if (path && path.length > 0) {
      const next = path.length > 1 ? path[1]! : path[0]!;
      const target = nav.positions.get(next) ?? null;
      // Gunner sprays while closing when it sees a near/mid target.
      const move =
        ms.kind === 'gunner' && canSee && (r === RANGE_NEAR || r === RANGE_MID)
          ? 'runandshoot'
          : ms.kind === 'soldier'
            ? 'run'
            : 'run';
      setMove(ms, move);
      return { move: ms.move, path, target };
    }
  }
  // Nowhere to go: hold the stand pose.
  const stand = ms.kind === 'soldier' ? 'stand1' : 'stand';
  setMove(ms, stand);
  return { move: ms.move, path: null, target: null };
}
