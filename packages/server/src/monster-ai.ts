// @q2/server/monster-ai — M5.3 depth monster AI (g_ai.c / p_trail.c /
// m_soldier.c ports). Pure helpers over ServerState/ServerMonster; the tick
// wiring (SV_MonsterTick/SV_GameTick/SV_PlayerFire calls) stays in index.ts.
//
// Ported algorithms (C ground truth in ../external/quake-2-source, behaviour
// template ../external/quake-2-JS — algorithms ported, our naming):
// - player-trail upkeep (p_client.c: add when the player leaves sight of the
//   last marker) + ai_run lost-sight pursuit (last sighting first, then
//   PlayerTrail_PickFirst/PickNext with the monster's trail_time);
// - combat points (g_ai.c FoundTarget combattarget + g_misc.c
//   point_combat_touch: head to the point, chain on arrival, hold or resume);
// - soldier dodge/duck (g_weapon.c check_dodge + m_soldier.c soldier_dodge,
//   soldier_duck_down/up with the C hull shrink + skill odds);
// - skill-scaled aggression (sightReactionDelay, burstRefire — game-owned
//   tables, applied here).
// Deviations from C (documented, deliberate):
// - anti-stack separation: base1 links zero combattargets, so mapper points
//   alone never separate the roster; crowded packmates get a small lateral
//   goal nudge so firing lines don't stack (pure steering, no teleports).
// - trail steering runs the C ai_run sidestep probe on freshly adopted legs
//   and the SV_NewChaseDir-lite heading sweep in locomotion (opt-in); long
//   wall faces are followed around their ends instead of pressed forever.
// - unseen non-ambush monsters keep the legacy beeline (C would stand until
//   FindTarget; we have no sound-alert path yet, and standing the whole map
//   down would read as dead).

import {
  MONSTER_HULL_MAXS,
  MONSTER_HULL_MAXS_DUCKED,
  MONSTER_HULL_MINS,
  burstRefire,
  checkDodgeGate,
  infantryCockBurstFrames,
  monsterRange,
  monsterYawTo,
  projectSource,
  sightReactionDelay,
  soldierDodgeChoice,
  soldierMachinegunBurstFrames,
  soldierWeaponForSkin,
  trailAdd,
  trailLastSpot,
  trailPickFirst,
  trailPickNext,
  yawDiff,
} from '@q2/game';
import type {
  AttackChoice,
  TraceFn,
} from '@q2/game';
import { AngleVectors, v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import { SERVER_DT } from '@q2/config';
import type { MonsterEvent, ServerMonster, ServerState } from './index.js';

/** C point_combat entity (g_misc.c SP_point_combat). */
export interface CombatPoint {
  /** targetname link the monster's combattarget names. */
  targetname: string;
  pos: Vec3;
  /** spawnflags & 1 hold: stand ground after arrival (AI_STAND_GROUND). */
  hold: boolean;
  /** chain link: monster's next goal on arrival (touch advances to it). */
  target: string;
  /** pathtarget fired on arrival (G_UseTargets). */
  pathtarget: string;
}

/** Skinnum stashed on a monster edict (m_soldier.c SP_ funcs). */
export function skinOf(m: ServerMonster): number {
  const raw = m.edict.extra['skinnum'] ?? '2';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 2;
}

/**
 * Hull maxs for bolt/pellet sweeps: ducking soldiers shrink to the C
 * duck hull (soldier_duck_down maxs[2] -= 32), everyone else the standing
 * hull. Read the move, not a flag — the duck move IS the ducked state.
 */
export function monsterHullMaxs(m: ServerMonster): Vec3 {
  if (m.kind === 'soldier' && m.state.move === 'duck') return MONSTER_HULL_MAXS_DUCKED;
  return MONSTER_HULL_MAXS;
}

/** C infront(self, other): other lies within ~72.5° of self's facing. */
export function monsterSeesPoint(m: ServerMonster, point: Vec3): boolean {
  return Math.abs(yawDiff(monsterYawTo(m.edict.origin, point), m.state.yaw)) <= 72.5;
}

// --- player-trail upkeep (p_client.c) ---------------------------------------

const ZERO_HULL: Vec3 = v3(0, 0, 0);

/**
 * Eye-to-point sight (C visible() with a marker instead of an enemy).
 * Monsters eye at origin + MONSTER_VIEWHEIGHT (25, walkmonster_start_go).
 */
export function spotVisible(sightTrace: TraceFn, from: Vec3, eye: number, spot: Vec3): boolean {
  const a = v3(from[0], from[1], from[2]! + eye);
  const t = sightTrace(a, ZERO_HULL, ZERO_HULL, spot);
  return t.fraction === 1 && !t.startsolid;
}

/**
 * C p_client.c upkeep: when the player leaves sight of the last trail
 * marker, record the current spot. Runs once per tick (not per monster).
 * Spots are feet positions (C old_origin); dead players leave no trail.
 */
export function trailUpkeep(
  st: ServerState,
  playerPos: Vec3,
  playerEye: Vec3,
  sightTrace: TraceFn,
  alive: boolean,
): void {
  if (!alive) return;
  const last = trailLastSpot(st.trail);
  if (!last) {
    trailAdd(st.trail, playerPos, st.time);
    return;
  }
  const t = sightTrace(playerEye, ZERO_HULL, ZERO_HULL, last.origin);
  if (t.fraction !== 1 || t.startsolid) trailAdd(st.trail, playerPos, st.time);
}

// --- FoundTarget combattarget hookup (g_ai.c) --------------------------------

/**
 * C FoundTarget combattarget branch: on acquire, a monster carrying
 * combattarget heads for the named point_combat (one-shot — the key is
 * cleared) instead of hunting the enemy directly. Returns true when a
 * combat goal was installed. No point by that name (or none carried) →
 * false, and the monster hunts normally.
 */
export function resolveCombatPoint(st: ServerState, m: ServerMonster): boolean {
  if (m.combatDone) return m.combatGoal !== null;
  const link = m.edict.extra['combattarget'] ?? '';
  if (!link) {
    m.combatDone = true;
    return false;
  }
  m.combatDone = true;
  const cp = st.combatPoints.find((c) => c.targetname === link);
  if (!cp) return false;
  m.combatGoal = v3(cp.pos[0], cp.pos[1], cp.pos[2]);
  m.combatHold = cp.hold;
  return true;
}

/**
 * C point_combat_touch arrival: chain to the next point (the monster's
 * movetarget advances down the target links), or clear the combat run.
 * Returns the pathtarget to fire, if the arrived point carries one.
 */
export function arriveCombatPoint(st: ServerState, m: ServerMonster): string | null {
  if (!m.combatGoal) return null;
  const arrived = st.combatPoints.find(
    (c) =>
      Math.abs(c.pos[0]! - m.combatGoal![0]!) < 1 &&
      Math.abs(c.pos[1]! - m.combatGoal![1]!) < 1 &&
      Math.abs(c.pos[2]! - m.combatGoal![2]!) < 1,
  );
  let fire: string | null = null;
  if (arrived && arrived.target) {
    const next = st.combatPoints.find((c) => c.targetname === arrived.target);
    if (next) {
      m.combatGoal = v3(next.pos[0], next.pos[1], next.pos[2]);
      m.combatHold = next.hold;
      if (next.pathtarget) fire = next.pathtarget;
      return fire;
    }
  }
  if (arrived && arrived.pathtarget) fire = arrived.pathtarget;
  m.combatGoal = null;
  return fire;
}

// --- ai_run lost-sight pursuit (g_ai.c) ---------------------------------------

/**
 * C ai_run lost-sight block, lite edition: while the (seen) enemy is not
 * visible, steer at last_sighting first (AI_PURSUIT_LAST_SEEN), then at
 * the trail markers (PickFirst once, PickNext after). Updates the
 * monsterinfo fields on the state and returns the steering goal.
 *
 * Arrival (within the frame's own travel + a step slack) latches
 * AI_PURSUE_NEXT so the next tick advances down the trail instead of
 * orbiting the reached spot. The 20s search timeout is omitted (the tick
 * re-arms search_time on every advance instead).
 *
 * When a fresh goal is adopted this tick (sight just lost, a TEMP restore,
 * or a trail-marker pick) the C `new` course correction runs when the
 * caller supplies `moveTrace`: the hull leg to the goal is traced, and
 * when blocked the ±16u lateral sidesteps are probed. The clearer side
 * (strictly better than the center leg, strictly better than the other
 * side) becomes the steering goal with the original stashed as the TEMP
 * goal, restored on arrival. That is what rounds corners; without it the
 * body presses into the wall between it and the marker forever.
 */
export function pursueGoal(
  st: ServerState,
  m: ServerMonster,
  playerPos: Vec3,
  canSee: boolean,
  sightTrace: TraceFn,
  frameDist: number,
  moveTrace?: TraceFn,
): Vec3 {
  const ms = m.state;
  const pos = m.edict.origin;
  if (canSee) {
    ms.lastSighting[0] = playerPos[0]!;
    ms.lastSighting[1] = playerPos[1]!;
    ms.lastSighting[2] = playerPos[2]!;
    ms.trailTime = st.time;
    ms.searchTime = st.time + 5;
    ms.lostSight = false;
    ms.pursueNext = false;
    ms.pursueTemp = false;
    ms.pursuitLastSeen = false;
    // Visible again: pursuit (and any wall-following hand) is over.
    m.slideDir = 0;
    return playerPos;
  }
  // C `new`: a fresh leg adopted this tick earns a course correction
  // below (the sidestep probe), exactly like the C block.
  let adopted = false;
  if (!ms.lostSight) {
    ms.lostSight = true;
    ms.pursuitLastSeen = true;
    ms.pursueNext = false;
    ms.pursueTemp = false;
    adopted = true;
  }
  if (ms.pursueNext) {
    ms.pursueNext = false;
    ms.searchTime = st.time + 5;
    if (ms.pursueTemp) {
      ms.pursueTemp = false;
      ms.lastSighting[0] = ms.savedGoal[0]!;
      ms.lastSighting[1] = ms.savedGoal[1]!;
      ms.lastSighting[2] = ms.savedGoal[2]!;
      adopted = true;
    } else if (ms.pursuitLastSeen) {
      ms.pursuitLastSeen = false;
      const marker = trailPickFirst(st.trail, ms.trailTime, (spot) =>
        spotVisible(sightTrace, pos, 25, spot),
      );
      if (marker) {
        ms.lastSighting[0] = marker.origin[0]!;
        ms.lastSighting[1] = marker.origin[1]!;
        ms.lastSighting[2] = marker.origin[2]!;
        ms.trailTime = marker.timestamp;
        ms.yaw = ((marker.yaw % 360) + 360) % 360;
        adopted = true;
      }
    } else {
      const marker = trailPickNext(st.trail, ms.trailTime);
      if (marker) {
        ms.lastSighting[0] = marker.origin[0]!;
        ms.lastSighting[1] = marker.origin[1]!;
        ms.lastSighting[2] = marker.origin[2]!;
        ms.trailTime = marker.timestamp;
        ms.yaw = ((marker.yaw % 360) + 360) % 360;
        adopted = true;
      }
    }
  }
  const dx = pos[0]! - ms.lastSighting[0]!;
  const dy = pos[1]! - ms.lastSighting[1]!;
  const dz = pos[2]! - ms.lastSighting[2]!;
  if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= Math.max(frameDist, 4)) {
    ms.pursueNext = true;
  }
  if (adopted && moveTrace) sidestepProbe(m, moveTrace);
  return ms.lastSighting;
}

/**
 * C ai_run lost-sight course correction (the `new` block, g_ai.c): the
 * hull leg from the body to the freshly adopted goal is traced, and when
 * blocked the ±16u lateral sidesteps at `d1 * ((center + 1) / 2)` down the
 * leg are probed. A side strictly better than the normalized center leg
 * (and strictly better than the other side) becomes the steering goal;
 * the original is stashed in savedGoal with AI_PURSUE_TEMP so arrival on
 * the probe restores it. Partial legs go partway
 * (`d2 * side * 0.5`), exactly like C. Facing is left to locomotion (C
 * sets ideal_yaw here; our tick yaws toward the returned goal each step).
 */
function sidestepProbe(m: ServerMonster, moveTrace: TraceFn): void {
  const ms = m.state;
  const pos = m.edict.origin;
  const gx = ms.lastSighting[0]! - pos[0]!;
  const gy = ms.lastSighting[1]! - pos[1]!;
  const gz = ms.lastSighting[2]! - pos[2]!;
  const d1 = Math.sqrt(gx * gx + gy * gy + gz * gz);
  if (d1 <= 1e-6) return;
  const maxs = monsterHullMaxs(m);
  const center = moveTrace(pos, MONSTER_HULL_MINS, maxs, ms.lastSighting).fraction;
  if (center >= 1) return;
  const d2 = d1 * ((center + 1) / 2);
  const yaw = monsterYawTo(pos, ms.lastSighting);
  const fwd = v3();
  const right = v3();
  AngleVectors(v3(0, yaw, 0), fwd, right);
  const leftTarget = projectSource(pos, v3(d2, -16, 0), fwd, right);
  const rightTarget = projectSource(pos, v3(d2, 16, 0), fwd, right);
  const left = moveTrace(pos, MONSTER_HULL_MINS, maxs, leftTarget).fraction;
  const rightF = moveTrace(pos, MONSTER_HULL_MINS, maxs, rightTarget).fraction;
  const need = (d1 * center) / d2;
  // Adopt only a MATERIAL improvement over the center leg. C adopts on a
  // strict >; with our deterministic tick the dust-winner flips every
  // restore/re-probe cycle and the body dithers ±16u in place instead of
  // ratcheting (C breaks the same symmetry stochastically inside
  // SV_NewChaseDir's randomized sweep). A useless sidestep falls through
  // to the locomotion heading sweep, which is what makes progress along
  // long faces; real posts still read ~1.0 vs ~0.4 and adopt.
  const MARGIN = 0.05;
  if (left >= need + MARGIN && left > rightF) {
    stashGoal(ms);
    const t =
      left < 1 ? projectSource(pos, v3(d2 * left * 0.5, -16, 0), fwd, right) : leftTarget;
    ms.lastSighting[0] = t[0]!;
    ms.lastSighting[1] = t[1]!;
    ms.lastSighting[2] = t[2]!;
  } else if (rightF >= need + MARGIN && rightF > left) {
    stashGoal(ms);
    const t =
      rightF < 1 ? projectSource(pos, v3(d2 * rightF * 0.5, 16, 0), fwd, right) : rightTarget;
    ms.lastSighting[0] = t[0]!;
    ms.lastSighting[1] = t[1]!;
    ms.lastSighting[2] = t[2]!;
  }
}

/** Stash the current goal across a sidestep (C saved_goal + AI_PURSUE_TEMP). */
function stashGoal(ms: ServerMonster['state']): void {
  ms.savedGoal[0] = ms.lastSighting[0]!;
  ms.savedGoal[1] = ms.lastSighting[1]!;
  ms.savedGoal[2] = ms.lastSighting[2]!;
  ms.pursueTemp = true;
}

// --- anti-stack separation (M5.3 depth; no direct C ancestor) -----------------

/**
 * Lateral nudge so firing lines don't stack: when another live, awake
 * packmate crowds this body (2D gap < 40u), offset the steering goal
 * sideways. Alternate side by edict parity so pairs flank instead of
 * both sliding the same way. Combat-point runs already separate by
 * design and skip this.
 */
export function separationOffset(st: ServerState, m: ServerMonster, goal: Vec3): Vec3 {
  for (const o of st.monsters) {
    if (o === m || o.state.dead || o.state.gibbed) continue;
    if (o.triggered && !o.woken) continue;
    if (o.kind === null) continue;
    const dx = o.edict.origin[0]! - m.edict.origin[0]!;
    const dy = o.edict.origin[1]! - m.edict.origin[1]!;
    if (Math.hypot(dx, dy) >= 40) continue;
    const gx = goal[0]! - m.edict.origin[0]!;
    const gy = goal[1]! - m.edict.origin[1]!;
    const len = Math.hypot(gx, gy) || 1;
    const side = m.edict.num % 2 === 0 ? 1 : -1;
    return v3(
      goal[0]! + (-gy / len) * 32 * side,
      goal[1]! + (gx / len) * 32 * side,
      goal[2]!,
    );
  }
  return goal;
}

// --- soldier dodge on incoming fire (g_weapon.c + m_soldier.c) ----------------

/**
 * C check_dodge (g_weapon.c): projectile weapons only. Trace the shot line
 * 8192u; when the first thing hit is a live soldier with a dodge callback
 * in front of the shooter, it dodges with eta = (dist - 16) / speed.
 * Easy mode only checks a quarter of the time (the C pre-gate).
 *
 * `traceWorld` is the caller's world trace (point segment); monster hulls
 * come from monsterHullMaxs so a ducking soldier is a smaller target.
 */
export function checkDodges(
  st: ServerState,
  eye: Vec3,
  dir: Vec3,
  skill: number,
  traceWorld: TraceFn,
  rand: () => number,
  boltSpeed: number,
): void {
  if (!checkDodgeGate(skill, rand)) return;
  const far = v3(eye[0]! + dir[0]! * 8192, eye[1]! + dir[1]! * 8192, eye[2]! + dir[2]! * 8192);
  const wall = traceWorld(eye, ZERO_HULL, ZERO_HULL, far);
  const seg = v3(far[0]! - eye[0]!, far[1]! - eye[1]!, far[2]! - eye[2]!);
  let bestT = wall.fraction;
  let best: ServerMonster | null = null;
  for (const m of st.monsters) {
    if (m.kind !== 'soldier' || m.state.dead || m.state.gibbed) continue;
    if (m.triggered && !m.woken) continue;
    const maxs = monsterHullMaxs(m);
    const tHit = segmentT(
      eye,
      seg,
      v3(
        m.edict.origin[0]! + MONSTER_HULL_MINS[0]!,
        m.edict.origin[1]! + MONSTER_HULL_MINS[1]!,
        m.edict.origin[2]! + MONSTER_HULL_MINS[2]!,
      ),
      v3(m.edict.origin[0]! + maxs[0]!, m.edict.origin[1]! + maxs[1]!, m.edict.origin[2]! + maxs[2]!),
    );
    if (tHit !== null && tHit < bestT) {
      bestT = tHit;
      best = m;
    }
  }
  if (!best) return;
  // C infront(tr.ent, self): the shooter must be in front of the monster
  // (it reacts to the muzzle flash it can see).
  if (!monsterSeesPoint(best, eye)) return;
  const choice = soldierDodgeChoice(skill, rand);
  if (choice === 'none') return;
  const dist = Math.hypot(
    eye[0]! - best.edict.origin[0]!,
    eye[1]! - best.edict.origin[1]!,
    eye[2]! - best.edict.origin[2]!,
  );
  const eta = Math.max(0, dist - 16) / boltSpeed;
  best.state.move = 'duck';
  best.state.frame = 0;
  best.duckUntil = st.time + eta + 0.3;
  best.duckShoot = choice === 'duckShoot';
}

/** Slab segment-vs-AABB (shared with the bolt sweeps in index.ts). */
function segmentT(origin: Vec3, delta: Vec3, mins: Vec3, maxs: Vec3): number | null {
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

// --- duck-hold + duck-shoot + burst state ---------------------------------------

/**
 * C AI_HOLD_FRAME (soldier_duck_hold): while the duck pausetime hasn't
 * elapsed, the hold frame (index 1) freezes instead of advancing.
 */
export function duckHoldFrozen(m: ServerMonster, now: number): boolean {
  return m.state.move === 'duck' && m.state.frame === 1 && now < m.duckUntil;
}

// --- sustained-fire hold (C AI_HOLD_FRAME: M_MoveFrame, g_monster.c) --------
//
// While the gun pausetime runs, the fire frame freezes and its thinkfunc
// re-fires every 0.1s tick: one single bullet per tick, never a same-tick
// fan. The flag (burstHeld) is C AI_HOLD_FRAME itself; the pausetime
// (burstUntil) alone cannot tell a fresh arrival (arm) from the expiry
// replay (advance without re-arming). Two C owners:
// - ss soldier attack4 (m_soldier.c soldier_fire4): pausetime armed on a
//   fresh arrival at the fire frame only (3 + rand()%8 FRAMETIME =
//   0.3-1.0s), no wind-up, no spin. The arming tick, every frozen tick,
//   and the expiry tick all fire: k+1 = 4-11 single rounds per burst.
// - infantry attack1 (m_infantry.c infantry_cock_gun + infantry_fire):
//   the cock frame (attak104) plays infatck3 and arms 10-25 frames
//   (1.0-2.5s); the fire frame (attak111, 7 frames later) then holds,
//   firing through the expiry tick: n-6 = 4-19 single rounds per burst.

/**
 * Freeze predicate for the sustained-fire hold: the flag is set, the
 * body is on the C fire frame, and the pausetime still runs. The tick
 * skips monsterThink (the frame stays) and re-emits the fire event,
 * exactly like M_MoveFrame skipping the frame++ and re-running the
 * thinkfunc.
 *
 * Boundary dust: level.time accumulates 0.1 per tick in floating point
 * while the pausetime is armed as cock-time + n*0.1 in one multiply, so
 * the two disagree by ~1e-16 at the expiry tick (C has the same float
 * shape with its own dust). The 1e-9 slack absorbs the accumulation so
 * the intended window — and only it — re-fires: without it the expiry
 * randomly costs or grants a 10Hz replay depending on magnitude dust.
 */
export function burstHoldFrozen(m: ServerMonster, now: number): boolean {
  if (!m.burstHeld || m.burstUntil <= 0 || now >= m.burstUntil - 1e-9) return false;
  return sustainedFireFrame(m.kind, m.state.move, m.state.frame);
}

/**
 * The C fire frames a hold freezes on: ss attack4 index 2 (attak403 =
 * soldier_fire4) and infantry attack1 index 10 (attak111 = infantry_fire).
 */
export function sustainedFireFrame(kind: ServerMonster['kind'], move: string, frame: number): boolean {
  if (kind === 'soldier' && move === 'attack4' && frame === 2) return true;
  if (kind === 'infantry' && move === 'attack1' && frame === 10) return true;
  return false;
}

/**
 * Arm the ss burst on a fresh arrival at the fire frame (m_soldier.c
 * soldier_fire: `if (!(aiflags & AI_HOLD_FRAME)) pausetime = ...`). Sets
 * the pausetime only — the tick latches the flag when it engages the
 * live hold. Called solely for fresh arrivals (frozen replays skip think,
 * expiry replays carry wasHeld), so a fresh arrival overwrites any stale
 * pausetime, exactly like C re-arming when the flag is clear.
 */
export function armSoldierBurst(m: ServerMonster, now: number, rand: () => number): void {
  if (m.kind !== 'soldier' || m.state.move !== 'attack4') return;
  m.burstUntil = now + soldierMachinegunBurstFrames(rand) * SERVER_DT;
}

/**
 * Arm the infantry burst on the cock frame (m_infantry.c
 * infantry_cock_gun: pausetime = level.time + ((rand&15)+3+7) *
 * FRAMETIME). Unconditional like C — the anim commits the gun the moment
 * the frame plays. The caller owns the infatck3 sound.
 */
export function armInfantryCock(m: ServerMonster, now: number, rand: () => number): void {
  if (m.kind !== 'infantry' || m.state.move !== 'attack1') return;
  m.burstUntil = now + infantryCockBurstFrames(rand) * SERVER_DT;
}

/**
 * Duck-and-shoot (m_soldier.c attack3): skill 1+ dodge losers fire once,
 * mid-duck, with the skin gun. Synthesized as an attack2-resolution event
 * (resolveMonsterFire keys the skin, never the label); the rendered move
 * stays 'duck'. Null unless the monster is on the duck fire frame with a
 * live duckShoot flag and line of sight.
 */
export function duckShootEvent(
  m: ServerMonster,
  canSee: boolean,
  dmgScale: number,
): MonsterEvent | null {
  if (!m.duckShoot || m.state.move !== 'duck' || m.state.frame !== 2 || !canSee) return null;
  m.duckShoot = false;
  const skin = skinOf(m);
  const weapon = soldierWeaponForSkin(skin);
  const attack: AttackChoice =
    weapon === 'blaster' ? 'blaster' : weapon === 'machinegun' ? 'machinegun' : 'shotgun';
  return {
    num: m.edict.num,
    classname: m.edict.classname,
    attack,
    move: 'attack2',
    dmgScale,
    frame: 2,
  };
}

/**
 * Last-ditch shots (m_soldier.c soldier_move_death1; m_infantry.c
 * infantry_move_death2): the falling soldier fires soldier_fire6 (flash 5)
 * at death-frame index 21 and soldier_fire7 (flash 6) at index 24; the
 * beheaded infantry sprays InfantryMachineGun at death2 indices 10-21
 * (FRAME_death211-222 = md2 155-166, flashes MZ2_INFANTRY_MACHINEGUN_2..13
 * through aimangles[]) — the only armed death moves in the game (soldier
 * death2-6, gunner death, infantry death1/3 frames are all NULL).
 * Synthesized as skin-gun events like duck-and-shoot (resolveMonsterFire
 * keys the skin, never the label); the rendered move stays on the death
 * move. Null unless a dead (non-gibbed) body just played a 'fire'-tagged
 * death frame. Fires unconditionally like C (no LOS gate — the shots spray
 * blindly; the lite resolver aims at the eye, and the ballistic bolt
 * detonates on cover instead of phasing, so an unsighted shot reads as
 * fire into the wall, never a wall-phase).
 */
export function deathFireEvent(
  m: ServerMonster,
  action: string,
  dmgScale: number,
): MonsterEvent | null {
  if (!m.state.dead || m.state.gibbed) return null;
  if (action !== 'fire') return null;
  if (m.kind === 'soldier' && m.state.move === 'death1') {
    const skin = skinOf(m);
    const weapon = soldierWeaponForSkin(skin);
    const attack: AttackChoice =
      weapon === 'blaster' ? 'blaster' : weapon === 'machinegun' ? 'machinegun' : 'shotgun';
    return {
      num: m.edict.num,
      classname: m.edict.classname,
      attack,
      move: 'death1',
      dmgScale,
      frame: m.state.frame,
    };
  }
  // Infantry "Off with his head" spray (m_infantry.c death211-222): always
  // the machinegun — infantry has no skins — resolved through the live
  // infantry bullet table (dmg 3, infatck1.wav) exactly like attack1 fire.
  if (m.kind === 'infantry' && m.state.move === 'death2') {
    return {
      num: m.edict.num,
      classname: m.edict.classname,
      attack: 'machinegun',
      move: 'death2',
      dmgScale,
      frame: m.state.frame,
    };
  }
  return null;
}

/**
 * Skill-3 burst refire (attack1/attack2 mid-move nextframe in C: skill 3
 * re-fires the volley half the time instead of exiting; the attack4
 * machinegun move has NO nextframe — its refire lines are commented out in
 * m_soldier.c, the hold IS the burst). When an attack1/attack2 move runs
 * to completion with the enemy still visible, half the time re-enter it
 * immediately, bypassing the cooldown. Only the machinegun-class guns
 * burst (ss soldier, gunner chain).
 */
export function maybeBurstRefire(
  m: ServerMonster,
  prevMove: string,
  canSee: boolean,
  skill: number,
  rand: () => number,
): boolean {
  if (!canSee || prevMove === m.state.move) return false;
  if (prevMove !== 'attack1' && prevMove !== 'attack2') return false;
  const skin = skinOf(m);
  const machinegunClass = m.kind === 'soldier' && soldierWeaponForSkin(skin) === 'machinegun';
  if (!burstRefire(skill, machinegunClass, rand)) return false;
  m.state.move = prevMove;
  m.state.frame = 0;
  return true;
}

/**
 * Sight reaction (C HuntTarget AttackFinished(self, 1), skill-scaled):
 * earliest attack start after acquiring the enemy. Synthetics spawn
 * already alert (reactionAt 0 = ready now); the tick stamps it on latch.
 */
export function reactionAt(skill: number, now: number): number {
  return now + sightReactionDelay(skill);
}

/** Range band to the enemy (thin wrapper so the tick reads C-clean). */
export function enemyRangeOf(selfPos: Vec3, playerPos: Vec3): number {
  const dx = playerPos[0]! - selfPos[0]!;
  const dy = playerPos[1]! - selfPos[1]!;
  const dz = playerPos[2]! - selfPos[2]!;
  return monsterRange(Math.sqrt(dx * dx + dy * dy + dz * dz));
}
