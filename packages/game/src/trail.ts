// @q2/game/trail — C p_trail.c PlayerTrail_* port (M5.3 depth).
//
// A circular list of the last TRAIL_LENGTH player spots, used by monsters
// for pursuit when line of sight breaks (g_ai.c ai_run). Ported algorithm,
// our naming/types. No I/O, no globals: the trail lives on the caller's
// state (the server owns one per level, like C's file-static ring).
//
// C behaviour preserved exactly:
// - ring of 8, NEXT/PREV wrap with & (TRAIL_LENGTH - 1);
// - Add stores the spot + level.time and yaws the marker toward the delta
//   from the previous marker (vectoyaw);
// - PickFirst skips markers at/below the monster's trail_time, then prefers
//   a marker visible from the monster, else the previous one, else the
//   newest (always non-null when active);
// - PickNext returns the newest marker past the monster's trail_time;
// - everything is a no-op / null when the trail is inactive (deathmatch in
//   C; our sim is always SP, so spawn activates it like g_spawn.c does).

import type { Vec3 } from '@q2/math';
import { v3 } from '@q2/math';
import { monsterYawTo } from './monsters.js';

/** C TRAIL_LENGTH (p_trail.c): power of two, the ring masks with it. */
export const TRAIL_LENGTH = 8;

/** One trail marker: C edict s.origin + timestamp + s.angles[YAW]. */
export interface TrailMarker {
  origin: Vec3;
  timestamp: number;
  yaw: number;
}

/** The trail ring (C file-statics trail[]/trail_head/trail_active). */
export interface PlayerTrail {
  markers: TrailMarker[];
  head: number;
  active: boolean;
}

/** C NEXT(n): advance in the power-of-two ring. */
export function trailNext(n: number): number {
  return (n + 1) & (TRAIL_LENGTH - 1);
}

/** C PREV(n): step back in the power-of-two ring. */
export function trailPrev(n: number): number {
  return (n - 1) & (TRAIL_LENGTH - 1);
}

/**
 * C PlayerTrail_Init: fresh ring of zeroed markers. `active` mirrors
 * trail_active (C skips init in deathmatch; our SP sim always activates
 * at spawn — pass false only for headless tests that want the C
 * inactive-trail NULL path).
 */
export function trailInit(active = true): PlayerTrail {
  const markers: TrailMarker[] = [];
  for (let n = 0; n < TRAIL_LENGTH; n++) {
    markers.push({ origin: v3(), timestamp: 0, yaw: 0 });
  }
  return { markers, head: 0, active };
}

/**
 * C PlayerTrail_Add: store one player spot at the head and advance.
 * The marker yaw faces the delta from the previous marker (C vectoyaw),
 * which is what ai_run steers the monster toward on reacquire.
 */
export function trailAdd(trail: PlayerTrail, spot: Vec3, time: number): void {
  if (!trail.active) return;
  const marker = trail.markers[trail.head];
  const prev = trail.markers[trailPrev(trail.head)];
  if (!marker || !prev) return;
  marker.origin[0] = spot[0]!;
  marker.origin[1] = spot[1]!;
  marker.origin[2] = spot[2]!;
  marker.timestamp = time;
  const yaw = monsterYawTo(prev.origin, spot);
  marker.yaw = yaw;
  trail.head = trailNext(trail.head);
}

/** C PlayerTrail_LastSpot: newest written marker (null when inactive). */
export function trailLastSpot(trail: PlayerTrail): TrailMarker | null {
  if (!trail.active) return null;
  return trail.markers[trailPrev(trail.head)] ?? null;
}

/**
 * C PlayerTrail_PickFirst: newest marker past `trailTime`, preferring one
 * visible from the monster (eye-to-marker point trace via `visible`),
 * else the previous marker when visible, else the newest regardless.
 * Null when the trail is inactive.
 */
export function trailPickFirst(
  trail: PlayerTrail,
  trailTime: number,
  visible: (spot: Vec3) => boolean,
): TrailMarker | null {
  if (!trail.active) return null;
  let marker = trail.head;
  for (let n = TRAIL_LENGTH; n > 0; n--) {
    if (trail.markers[marker]!.timestamp <= trailTime) marker = trailNext(marker);
    else break;
  }
  if (visible(trail.markers[marker]!.origin)) return trail.markers[marker]!;
  const prev = trail.markers[trailPrev(marker)]!;
  if (visible(prev.origin)) return prev;
  return trail.markers[marker]!;
}

/**
 * C PlayerTrail_PickNext: newest marker past `trailTime` (no visibility
 * test — the monster committed to the trail already). Null when inactive.
 */
export function trailPickNext(trail: PlayerTrail, trailTime: number): TrailMarker | null {
  if (!trail.active) return null;
  let marker = trail.head;
  for (let n = TRAIL_LENGTH; n > 0; n--) {
    if (trail.markers[marker]!.timestamp <= trailTime) marker = trailNext(marker);
    else break;
  }
  return trail.markers[marker] ?? null;
}
