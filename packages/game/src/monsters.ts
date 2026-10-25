// @q2/game/monsters — soldier + gunner-lite state machines (m_soldier.c, m_gunner.c).
// Moves are data tables: {first, last, action per frame, end} exactly like
// id's mframe_t/mmovemove_t arrays, minus function pointers (actions are
// string tags the game logic switches on).

import type { Vec3 } from '@q2/math';
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

export interface MonsterDef {
  classname: string;
  health: number;
  gibHealth: number;
  mass: number;
  moves: Record<string, MonsterMove>;
}

// Frame numbers match the MD2 frame names in the original models.
export const SOLDIER: MonsterDef = {
  classname: 'monster_soldier',
  health: 30,
  gibHealth: -30,
  mass: 100,
  moves: {
    stand1: run('stand1', 101, 130, 'stand1'),
    walk1: run('walk1', 101, 133, 'walk1', 5),
    start_run: run('start_run', 1, 2, 'run'),
    run: run('run', 3, 8, 'run', 12),
    pain1: run('pain1', 101, 105, 'run'),
    pain2: run('pain2', 201, 207, 'run'),
    pain3: run('pain3', 301, 318, 'run'),
    attack1: run('attack1', 101, 112, 'run'), // shotgun
    attack2: run('attack2', 201, 218, 'run'), // blaster
    duck: run('duck', 1, 5, 'run'),
    death1: run('death1', 101, 136, 'dead'),
  },
};

export const GUNNER: MonsterDef = {
  classname: 'monster_gunner',
  health: 175,
  gibHealth: -70,
  mass: 200,
  moves: {
    stand: run('stand', 1, 30, 'stand'),
    walk: run('walk', 7, 19, 'walk', 4),
    run: run('run', 1, 8, 'run', 10),
    runandshoot: run('runandshoot', 1, 6, 'run', 10, 'fire'),
    pain1: run('pain1', 101, 118, 'run'),
    pain2: run('pain2', 201, 208, 'run'),
    pain3: run('pain3', 301, 305, 'run'),
    attack_chain: run('attack_chain', 209, 215, 'fire_chain', 0, 'fire'),
    fire_chain: run('fire_chain', 216, 223, 'refire_chain', 0, 'fire'),
    endfire_chain: run('endfire_chain', 224, 230, 'run'),
    attack_grenade: run('attack_grenade', 101, 121, 'run', 0, 'fire'),
    duck: run('duck', 1, 5, 'run'),
    death: run('death', 1, 11, 'dead'),
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
