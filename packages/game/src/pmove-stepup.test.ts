// RELEASE-4 game lane: pmove boarding audit — C STEPSIZE step-up semantics.
//
// Real base1 numbers (measured from pak0.pak maps/base1.bsp, model bounds +
// world traces): the parked *12 func_train deck is 16 wide in X
// (mins [-2064,1472,-48], maxs [-2048,1600,0], origin parked at 0, so the
// deck top is z=0) while the adjacent hall floor is z=96 (delta 96).
// Stepping that delta is impossible in id C too (PM_StepSlideMove only
// climbs STEPSIZE=18). The invisible obstruction on the live route is
// therefore server-collision-side, not pmove-side: pmove must stay
// C-exact here (no teleporting, no clip disabling, no per-map hacks).
//
// This test pins the C-exact behaviour with a train-shaped deck (16-wide
// slab, top z=0) against a doorway floor at several deltas, using the same
// world+nearest-clip-wins structure as the driver trace:
// - floor 12/17/18 below the deck top: walks in and steps UP onto the deck,
//   grounded with groundEntity == the deck (rider linkage).
// - floor 19 below: REFUSES — a horizontal clip that must NOT be stepped.
// - floor 12/96 above a landing strip: drops DOWN C-style (ballistic fall,
//   no terminal velocity in Q2), lands and stands on the deck.
// - real slot proportions (16-wide, 96 above): a walking player sails past
//   the slot and falls through — C-identical, so the live-route obstruction
//   cannot be a pmove step failure.
import { describe, expect, it } from 'vitest';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  makePmoveState,
  pmove,
  resetPmoveWorld,
  setPmoveWorld,
} from './index.js';
import type { TraceResult } from './index.js';

// Parked-deck shape (base1 *12 proportions: 16 wide in X, top at z=0).
const DECK_MINS = [-64, -64, -48];
const DECK_MAXS = [-48, 64, 0];
const DECK_TOP = 0;
const DECK_NUM = 7;
// C qcommon/cmodel.c DIST_EPSILON enter/leave bias (1/32): contact stops a
// hair proud so a landing never rests exactly on the plane (which would
// read allsolid on the next overlapping sweep).
const DIST_EPSILON = 1 / 32;

interface SweepHit {
  fraction: number;
  normal: Vec3;
  allsolid: boolean;
  startsolid: boolean;
}

/** C CM_ClipBoxToBrush slab walk for one AABB (boundary-inclusive inside). */
function sweepBox(
  start: Vec3, end: Vec3,
  mins: Vec3, maxs: Vec3,
  bmins: number[], bmaxs: number[],
): SweepHit {
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
    // Leaving solid counts as fraction 1 with an unset plane (C getout
    // path: startsolid set, fraction stays 1), keeps startsolid.
    return { fraction: 1, normal: v3(), allsolid: false, startsolid: true };
  }
  // C enterfrac starts at -1 so a contact entry (biased fraction <= 0)
  // still records the hit axis and clamps to fraction 0.
  let tmin = -1;
  let tmax = 1;
  let tminRaw = 0;
  let axis = -1;
  let sign = 0;
  for (let i = 0; i < 3; i++) {
    const d = end[i]! - start[i]!;
    if (Math.abs(d) < 1e-12) {
      if (start[i]! < lo[i]! || start[i]! > hi[i]!) {
        // Total miss: fraction 1 with a zero normal (id CM_BoxTrace zeroes
        // the trace on a miss), so PM_CategorizePosition reads airborne and
        // the PM_StepSlideMove down-settle rejects the step (0 < 0.7).
        return { fraction: 1, normal: v3(), allsolid: false, startsolid: false };
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
    // C enter/leave bias: entry shifts earlier by eps/|d|.
    const bias = DIST_EPSILON / Math.abs(d);
    const t1b = t1 - bias;
    const t2b = t2 + bias;
    if (t1 > tminRaw) tminRaw = t1;
    if (t1b > tmin) {
      tmin = t1b;
      axis = i;
      sign = s;
    }
    if (t2b < tmax) tmax = t2b;
    if (tmin > tmax) {
      return { fraction: 1, normal: v3(), allsolid: false, startsolid: false };
    }
  }
  if (axis < 0) {
    // Total miss: fraction 1 with a zero normal (id CM_BoxTrace zeroes the
    // trace on a miss), so PM_CategorizePosition reads airborne and the
    // PM_StepSlideMove down-settle rejects the step (normal 0 < 0.7).
    return { fraction: 1, normal: v3(), allsolid: false, startsolid: false };
  }
  const n = v3(0, 0, 0);
  n[axis] = sign;
  return { fraction: Math.max(0, Math.min(1, tmin)), normal: n, allsolid: false, startsolid: tminRaw <= 0 };
}

/**
 * Driver-shaped trace: doorway floor slab (top at `floorZ`, east of the
 * deck mouth) plus the deck clip box, nearest-wins with the deck edict num
 * on deck hits (the SV_ClipTrace groundEntity linkage for riders).
 * `wide` extends the deck west into a landing strip for the drop tests;
 * the step tests keep the 16-wide *12-like slot.
 */
function boardingTrace(floorZ: number, wide: boolean) {
  const floorMins = [-48, -400, floorZ - 8];
  const floorMaxs = [400, 400, floorZ];
  const deckMins = wide ? [-400, -64, -48] : DECK_MINS;
  return (start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3): TraceResult => {
    const fw = sweepBox(start, end, mins, maxs, floorMins, floorMaxs);
    const fd = sweepBox(start, end, mins, maxs, deckMins, DECK_MAXS);
    let best = {
      fraction: fw.fraction,
      normal: fw.normal,
      allsolid: fw.allsolid,
      startsolid: fw.startsolid,
      entityNum: 0,
    };
    if (fd.fraction < best.fraction || fd.allsolid) {
      best = {
        fraction: fd.fraction,
        normal: fd.normal,
        allsolid: fd.allsolid,
        startsolid: fd.startsolid,
        entityNum: DECK_NUM,
      };
    }
    const f = best.fraction;
    return {
      fraction: f,
      endpos: v3(
        start[0]! + (end[0]! - start[0]!) * f,
        start[1]! + (end[1]! - start[1]!) * f,
        start[2]! + (end[2]! - start[2]!) * f,
      ),
      planeNormal: best.normal,
      allsolid: best.allsolid,
      startsolid: best.startsolid,
      entityNum: best.entityNum,
      contents: 0,
    };
  };
}

interface WalkOutcome {
  feet: number;
  x: number;
  onGround: boolean;
  groundEntity: number;
  /** Any tick with groundEntity == deck (stood on / touched the deck top). */
  touchedDeck: boolean;
  /** Any tick grounded ON the deck (onGround + groundEntity == deck). */
  groundedOnDeck: boolean;
  /** Lowest feet reached (documents drops). */
  minFeet: number;
  /** Highest feet reached (no-teleport-up bound). */
  maxFeet: number;
  /** Largest single-tick displacement (no-teleport bound). */
  maxStep: number;
  /** Origin X when first grounded on the deck (boarding point). */
  boardX: number | null;
}

interface WalkOpts {
  wideDeck?: boolean;
  /** Stop walking (forwardmove 0) once grounded on the deck: pins standing. */
  stopAfterBoard?: boolean;
}

/** Walk west (-X, yaw 180) from the doorway floor toward the deck mouth. */
function walkWest(floorZ: number, ticks: number, opts: WalkOpts = {}): WalkOutcome {
  setPmoveWorld(boardingTrace(floorZ, opts.wideDeck === true));
  const st = makePmoveState();
  st.origin = v3(40, 0, floorZ + 24);
  st.velocity = v3();
  let touchedDeck = false;
  let groundedOnDeck = false;
  let minFeet = Infinity;
  let maxFeet = -Infinity;
  let maxStep = 0;
  let boardX: number | null = null;
  let walking = true;
  for (let i = 0; i < ticks; i++) {
    const px = st.origin[0]!;
    const py = st.origin[1]!;
    const pz = st.origin[2]!;
    pmove(st, {
      msec: 100,
      angles: v3(0, 180, 0),
      forwardmove: walking ? 200 : 0,
      sidemove: 0,
      upmove: 0,
      buttons: 0,
    });
    maxStep = Math.max(
      maxStep,
      Math.hypot(st.origin[0]! - px, st.origin[1]! - py, st.origin[2]! - pz),
    );
    const feet = st.origin[2]! - 24;
    if (feet < minFeet) minFeet = feet;
    if (feet > maxFeet) maxFeet = feet;
    if (st.groundEntity === DECK_NUM) {
      touchedDeck = true;
      if (st.onGround && !groundedOnDeck) {
        groundedOnDeck = true;
        boardX = st.origin[0]!;
        if (opts.stopAfterBoard) walking = false;
      }
    }
  }
  const out: WalkOutcome = {
    feet: st.origin[2]! - 24,
    x: st.origin[0]!,
    onGround: st.onGround,
    groundEntity: st.groundEntity,
    touchedDeck,
    groundedOnDeck,
    minFeet,
    maxFeet,
    maxStep,
    boardX,
  };
  resetPmoveWorld();
  return out;
}

describe('RELEASE-4 pmove boarding audit (C STEPSIZE semantics)', () => {
  it('steps UP onto a waiting-deck-height top from 12 below, then stands', () => {
    const r = walkWest(DECK_TOP - 12, 120, { stopAfterBoard: true });
    expect(r.groundedOnDeck).toBe(true);
    expect(r.boardX).not.toBeNull();
    // Boarded at the deck mouth (hull over the deck slab), not past it.
    expect(r.boardX!).toBeLessThan(DECK_MAXS[0]! + 16);
    expect(r.boardX!).toBeGreaterThan(DECK_MINS[0]! - 16);
    // Stands on the deck afterwards: feet glued to the top, rider linkage.
    expect(r.feet).toBeCloseTo(DECK_TOP, 1);
    expect(r.onGround).toBe(true);
    expect(r.groundEntity).toBe(DECK_NUM);
    expect(r.maxStep).toBeLessThan(41); // no teleport: bounded per-tick travel
  });

  it('steps UP from 17 below (largest climbable integer delta)', () => {
    const r = walkWest(DECK_TOP - 17, 120, { stopAfterBoard: true });
    expect(r.groundedOnDeck).toBe(true);
    expect(r.feet).toBeCloseTo(DECK_TOP, 1);
    expect(r.groundEntity).toBe(DECK_NUM);
    expect(r.maxStep).toBeLessThan(41);
  });

  it('steps UP from exactly STEPSIZE=18 below (C climbs its own STEPSIZE)', () => {
    // id PM_StepSlideMove from a run-up: the low slide stops 1/32 proud of
    // the face (DIST_EPSILON), so the raised zero-trace starts outside the
    // deck and the down-settle lands on the top. The CM_TestBoxInBrush
    // exact-touch allsolid only fires from exact-boundary contact, which
    // the epsilon-biased slide never produces — so C climbs a full 18.
    // Refusing it here would be a pmove deviation from C.
    const r = walkWest(DECK_TOP - 18, 120, { stopAfterBoard: true });
    expect(r.groundedOnDeck).toBe(true);
    expect(r.feet).toBeCloseTo(DECK_TOP, 1);
    expect(r.groundEntity).toBe(DECK_NUM);
    expect(r.maxStep).toBeLessThan(41);
  });

  it('REFUSES 19 below: a horizontal clip that must NOT be stepped', () => {
    const r = walkWest(DECK_TOP - 19, 120);
    expect(r.groundedOnDeck).toBe(false);
    expect(r.touchedDeck).toBe(false);
    expect(r.minFeet).toBeLessThan(DECK_TOP - 18);
    expect(r.maxFeet).toBeLessThan(DECK_TOP - 18.5);
    expect(r.x).toBeGreaterThan(DECK_MAXS[0]! - 32);
    expect(r.maxStep).toBeLessThan(41);
  });

  it('drops DOWN 12 onto the deck when it is underfoot, then stands', () => {
    const r = walkWest(DECK_TOP + 12, 120, { wideDeck: true, stopAfterBoard: true });
    expect(r.groundedOnDeck).toBe(true);
    expect(r.feet).toBeCloseTo(DECK_TOP, 1);
    expect(r.onGround).toBe(true);
    expect(r.groundEntity).toBe(DECK_NUM);
    expect(r.maxFeet).toBeLessThan(DECK_TOP + 12.5); // never popped up
    expect(r.maxStep).toBeLessThan(41);
  });

  it('drops DOWN the real base1 delta (hall 96 above deck) C-style, then stands', () => {
    // delta 96 >> STEPSIZE: C physics walks off the mouth and falls; the
    // fall is purely ballistic (no terminal velocity in Q2), so the bound
    // below only excludes teleports, not fast falls.
    const r = walkWest(DECK_TOP + 96, 200, { wideDeck: true, stopAfterBoard: true });
    expect(r.minFeet).toBeLessThan(DECK_TOP + 95); // left the doorway floor
    expect(r.maxFeet).toBeLessThan(DECK_TOP + 96.5); // never popped up
    expect(r.groundedOnDeck).toBe(true); // landed on the deck top
    expect(r.feet).toBeCloseTo(DECK_TOP, 1);
    expect(r.groundEntity).toBe(DECK_NUM);
    expect(r.maxStep).toBeLessThan(80);
  });

  it('real slot proportions (16-wide deck, 96 above): a walking player sails past', () => {
    // With the true *12 slot width, a player walking off the 96-high mouth
    // at patrol speed overshoots the 16-wide deck and falls past it — id C
    // behaves identically (fall time ~0.49s vs ~0.08s over the slot). Pin
    // that pmove neither hangs in mid-air nor mounts the deck by stepping:
    // boarding a walking-speed crossing is impossible in C too, so the live
    // obstruction cannot be a pmove step failure.
    const r = walkWest(DECK_TOP + 96, 200);
    expect(r.minFeet).toBeLessThan(DECK_TOP + 95); // left the doorway floor
    expect(r.maxFeet).toBeLessThan(DECK_TOP + 96.5); // never popped up
    expect(r.groundedOnDeck).toBe(false); // sailed past the narrow slot
    expect(r.minFeet).toBeLessThan(DECK_TOP); // fell through deck level
  });
});
