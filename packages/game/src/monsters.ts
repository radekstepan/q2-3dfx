// @q2/game/monsters — soldier + gunner-lite state machines (m_soldier.c, m_gunner.c).
// Moves are data tables: {first, last, action per frame, end} exactly like
// id's mframe_t/mmovemove_t arrays, minus function pointers (actions are
// string tags the game logic switches on).

import type { Vec3 } from '@q2/math';
import { v3 } from '@q2/math';
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
    attack1: mv('attack1', 0, new Array(12).fill(0), 'run'), // shotgun
    attack2: mv('attack2', 12, new Array(18).fill(0), 'run'), // blaster
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
    fire_chain: mv('fire_chain', 144, new Array(8).fill(0), 'refire_chain', 'fire'),
    endfire_chain: mv('endfire_chain', 152, new Array(7).fill(0), 'run'),
    attack_grenade: mv('attack_grenade', 108, new Array(21).fill(0), 'run', 'fire'),
    duck: mv('duck', 201, [1, 1, 1, 0, -1, -1, 0, -1], 'run'),
    death: mv('death', 190, [0, 0, 0, -7, -3, -5, 8, 6, 0, 0, 0], 'dead'),
  },
};

export type MonsterKind = 'soldier' | 'gunner';

export function monsterDef(kind: MonsterKind): MonsterDef {
  return kind === 'soldier' ? SOLDIER : GUNNER;
}

export interface MonsterState {
  kind: MonsterKind;
  health: number;
  move: string;
  frame: number; // absolute frame number within current move
  dead: boolean;
}

export function spawnMonster(kind: MonsterKind): MonsterState {
  const def = monsterDef(kind);
  return { kind, health: def.health, move: kind === 'soldier' ? 'stand1' : 'stand', frame: 0, dead: false };
}

export function monsterMoveOf(ms: MonsterState): MonsterMove {
  const def = monsterDef(ms.kind);
  const mv = def.moves[ms.move];
  if (!mv) throw new Error(`unknown move ${ms.move} for ${ms.kind}`);
  return mv;
}

/** Advance one server frame (0.1s). Returns the action tag of this frame. */
export function monsterThink(ms: MonsterState): string {
  if (ms.dead) return 'dead';
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
 * `trace` works in monster-origin space: the caller expands obstacles by the
 * monster hull (MONSTER_HULL_MINS/MAXS) and traces the origin as a point
 * segment; only `fraction`/`endpos` are used. Mutates `origin` in place and
 * touches nothing else (no I/O, no globals), so it is headless-testable with
 * a stub trace. Corpses (`state.dead`) never move.
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
): void {
  if (state.dead) return;
  const mv = monsterMoveOf(state);
  const fr = mv.frames[state.frame] ?? { dist: 0, action: 'move' };
  const dx = playerPos[0]! - origin[0]!;
  const dy = playerPos[1]! - origin[1]!;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len > 1e-9 && fr.dist !== 0) {
    const nx = dx / len;
    const ny = dy / len;
    const end = v3(origin[0]! + nx * fr.dist, origin[1]! + ny * fr.dist, origin[2]!);
    const h = trace(v3(origin[0], origin[1], origin[2]), end);
    origin[0] = h.endpos[0]!;
    origin[1] = h.endpos[1]!;
    origin[2] = h.endpos[2]!;
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

export function monsterPain(ms: MonsterState, damage: number, rand: () => number): void {
  ms.health -= damage;
  if (ms.health <= monsterDef(ms.kind).gibHealth || ms.health <= 0) {
    ms.dead = true;
    ms.move = ms.kind === 'soldier' ? 'death1' : 'death';
    ms.frame = 0;
    return;
  }
  // id skips pain anims probabilistically; keep deterministic via caller rng
  if (rand() < 0.4) {
    ms.move = ms.kind === 'soldier' ? (rand() < 0.5 ? 'pain1' : 'pain2') : 'pain1';
    ms.frame = 0;
  }
}

export type AttackChoice = 'melee' | 'shotgun' | 'blaster' | 'chaingun' | 'grenade' | 'none';

/**
 * Melee/ranged selection by range, mirroring soldier_attack/gunner_attack:
 * melee distance -> melee; near/mid -> weapon fire; far -> close in (none).
 */
export function selectAttack(kind: MonsterKind, dist: number, rand: () => number): AttackChoice {
  const r = monsterRange(dist);
  if (r === RANGE_MELEE) return 'melee';
  if (kind === 'soldier') {
    if (r === RANGE_NEAR || r === RANGE_MID) return rand() < 0.5 ? 'shotgun' : 'blaster';
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

/** Map an attack choice onto the kind's data-table move names. */
export function attackMoveFor(kind: MonsterKind, choice: AttackChoice): string {
  switch (choice) {
    case 'shotgun':
      return 'attack1';
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

/**
 * One chase tick: attack when in range with line of sight, else navigate
 * the graph toward the player. `dist` is the 3D monster-player distance,
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
): ChaseResult {
  if (ms.dead) return { move: ms.move, path: null, target: null };
  const dx = playerPos[0]! - selfPos[0]!;
  const dy = playerPos[1]! - selfPos[1]!;
  const dz = playerPos[2]! - selfPos[2]!;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const r = monsterRange(dist);
  // Melee always commits; at near/mid with sight the monster usually
  // plants and fires (id attack chance), otherwise it closes in.
  const commit =
    r === RANGE_MELEE || ((r === RANGE_NEAR || r === RANGE_MID) && canSee && rand() < 0.7);
  if (canSee && commit) {
    const choice = selectAttack(ms.kind, dist, rand);
    if (choice !== 'none') {
      const move = attackMoveFor(ms.kind, choice);
      setMove(ms, move);
      return { move, path: null, target: null };
    }
  }
  // Close in: walk the node graph toward the player.
  const from = nearestNode(nav.positions, selfPos);
  const to = nearestNode(nav.positions, playerPos);
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
