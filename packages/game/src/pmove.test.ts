// M5.1: pmove determinism + collision behaviour.
import { describe, expect, it } from 'vitest';
import { v3 } from '@q2/math';
import {
  PM_GRAVITY,
  clonePmoveState,
  makePmoveState,
  mulberry32,
  pmove,
  resetPmoveWorld,
  setPmoveWorld,
  CONTENTS_LADDER,
  CONTENTS_WATER,
  PMF_DUCKED,
} from './index.js';
import type { TraceResult, UserCmd } from './index.js';

function bits(a: Float32Array): number[] {
  const iv = new Int32Array(a.buffer, a.byteOffset, a.length);
  return [...iv];
}

/** Wall plane at x = wallX (normal -X). Player box collides with maxs[0] offset. */
function wallTraceAt(wallX: number) {
  return (
    start: Float32Array,
    mins: Float32Array,
    maxs: Float32Array,
    end: Float32Array,
  ): TraceResult => {
    const face = wallX - maxs[0]!;
    const sx = start[0]!;
    const ex = end[0]!;
    if (sx >= face) {
      // already touching/inside: fraction 0, stuck (like id's startsolid)
      return {
        fraction: 0,
        endpos: new Float32Array(start),
        planeNormal: v3(-1, 0, 0),
        allsolid: false,
        startsolid: true,
        entityNum: 0,
        contents: 0,
      };
    }
    if (ex <= face) {
      return {
        fraction: 1,
        endpos: new Float32Array(end),
        planeNormal: v3(0, 0, 1),
        allsolid: false,
        startsolid: false,
        entityNum: -1,
        contents: 0,
      };
    }
    const denom = ex - sx;
    const f = denom !== 0 ? (face - sx) / denom : 0;
    const clamped = Math.min(1, Math.max(0, f));
    return {
      fraction: clamped,
      endpos: new Float32Array([sx + (ex - sx) * clamped, end[1], end[2]]),
      planeNormal: v3(-1, 0, 0),
      allsolid: false,
      startsolid: false,
      entityNum: 0,
      contents: 0,
    };
  };
}

/** Flat floor at feet z = 0 (origin.z + mins.z), world entity 0. */
function floorTrace(
  start: Float32Array,
  mins: Float32Array,
  _maxs: Float32Array,
  end: Float32Array,
): TraceResult {
  const sb = start[2]! + mins[2]!;
  const eb = end[2]! + mins[2]!;
  if (eb < sb && eb <= 0) {
    const f = sb === eb ? 0 : Math.min(1, Math.max(0, sb / (sb - eb)));
    return {
      fraction: f,
      endpos: new Float32Array([
        start[0]! + (end[0]! - start[0]!) * f,
        start[1]! + (end[1]! - start[1]!) * f,
        start[2]! + (end[2]! - start[2]!) * f,
      ]),
      planeNormal: v3(0, 0, 1),
      allsolid: false,
      startsolid: false,
      entityNum: 0,
      contents: 0,
    };
  }
  return {
    fraction: 1,
    endpos: new Float32Array(end),
    planeNormal: v3(0, 0, 1),
    allsolid: false,
    startsolid: false,
    entityNum: -1,
    contents: 0,
  };
}

describe('pmove determinism (M5.1)', () => {
  it('replaying 10k seeded usercmds reproduces origins bit-for-bit', () => {
    resetPmoveWorld();
    const rand = mulberry32(0xc0ffee);
    const cmds: UserCmd[] = [];
    for (let i = 0; i < 10000; i++) {
      cmds.push({
        msec: 8 + Math.floor(rand() * 25), // 8..32ms, dt from msec only
        angles: new Float32Array([0, rand() * 360 - 180, 0]),
        forwardmove: Math.floor(rand() * 800) - 400,
        sidemove: Math.floor(rand() * 800) - 400,
        upmove: rand() < 0.05 ? 100 : 0,
        buttons: rand() < 0.1 ? 1 : 0,
      });
    }
    const runOnce = (): Float32Array[] => {
      resetPmoveWorld();
      const st = makePmoveState();
      st.gravity = PM_GRAVITY;
      const origins: Float32Array[] = [];
      for (const c of cmds) {
        pmove(st, c);
        origins.push(new Float32Array(st.origin));
      }
      return origins;
    };
    const a = runOnce();
    const b = runOnce();
    expect(a.length).toBe(10000);
    for (let i = 0; i < a.length; i++) {
      expect(bits(b[i]!)).toEqual(bits(a[i]!));
    }
    // sanity: it actually moved
    const last = a[a.length - 1]!;
    expect(Math.abs(last[0]!) + Math.abs(last[1]!)).toBeGreaterThan(0);
  });

  it('slides along a wall without penetrating', () => {
    resetPmoveWorld();
    const wall = wallTraceAt(64);
    setPmoveWorld((s, mi, ma, e) => {
      // floor first so the player stays grounded, then the wall
      const f = floorTrace(s, mi, ma, e);
      if (f.entityNum !== -1) return f;
      return wall(s, mi, ma, e);
    });
    const st = makePmoveState();
    st.origin = new Float32Array([0, 0, 24]); // resting on the floor
    st.onGround = true;
    // run diagonally at the wall: forward +X with right-strafe +Y? yaw 0 => fwd=+X
    for (let i = 0; i < 200; i++) {
      pmove(st, {
        msec: 50,
        angles: new Float32Array([0, 0, 0]),
        forwardmove: 400,
        sidemove: 400,
        upmove: 0,
        buttons: 0,
      });
    }
    // box maxs.x = 16 => origin.x must stay <= 48
    expect(st.origin[0]!).toBeLessThanOrEqual(48.0001);
    // slid sideways: y moved substantially
    expect(Math.abs(st.origin[1]!)).toBeGreaterThan(10);
    resetPmoveWorld();
  });

  it('steps onto a curb lower than STEPSIZE', () => {
    resetPmoveWorld();
    // step: solid box occupying x in [32,64], z in [0,8]; swept trace,
    // plus a floor (z=0 outside the curb, z=8 on top of it).
    const curbH = 8;
    setPmoveWorld((start, mins, maxs, end) => {
      const sb = start[2]! + mins[2]!;
      const eb = end[2]! + mins[2]!;
      const overCurb =
        start[0]! + maxs[0]! >= 32 - 0.001 || end[0]! + maxs[0]! >= 32;
      const floorZ = start[0]! + maxs[0]! >= 32 && start[0]! - mins[0]! <= 64 ? curbH : 0;
      if (eb < sb && eb <= floorZ) {
        const f = sb === eb ? 0 : Math.min(1, Math.max(0, (sb - floorZ) / (sb - eb)));
        void overCurb;
        return {
          fraction: f,
          endpos: new Float32Array([
            start[0]! + (end[0]! - start[0]!) * f,
            start[1]! + (end[1]! - start[1]!) * f,
            start[2]! + (end[2]! - start[2]!) * f,
          ]),
          planeNormal: v3(0, 0, 1),
          allsolid: false,
          startsolid: false,
          entityNum: 0,
          contents: 0,
        };
      }
      const feet = Math.min(sb, eb);
      const crosses =
        start[0]! + maxs[0]! <= 32 && end[0]! + maxs[0]! > 32 && feet < curbH;
      if (!crosses) {
        return {
          fraction: 1,
          endpos: new Float32Array(end),
          planeNormal: v3(0, 0, 1),
          allsolid: false,
          startsolid: false,
          entityNum: -1,
          contents: 0,
        };
      }
      const f = (32 - maxs[0]! - start[0]!) / (end[0]! - start[0]!);
      return {
        fraction: Math.min(1, Math.max(0, f)),
        endpos: new Float32Array([start[0]! + (end[0]! - start[0]!) * f, end[1], end[2]]),
        planeNormal: v3(-1, 0, 0),
        allsolid: false,
        startsolid: false,
        entityNum: 0,
        contents: 0,
      };
    });
    const st = makePmoveState();
    st.origin = new Float32Array([0, 0, 24]); // feet on the floor
    st.onGround = true;
    let maxZ = 24;
    for (let i = 0; i < 120; i++) {
      pmove(st, {
        msec: 50,
        angles: new Float32Array([0, 0, 0]),
        forwardmove: 400,
        sidemove: 0,
        upmove: 0,
        buttons: 0,
      });
      if (st.origin[2]! > maxZ) maxZ = st.origin[2]!;
    }
    // stepped up: peak feet (origin.z - 24) reached the curb top (8 => z=32)
    expect(maxZ).toBeGreaterThan(30);
    expect(st.origin[0]!).toBeGreaterThan(32);
    resetPmoveWorld();
  });

  it('applies gravity in free fall and friction on ground', () => {
    resetPmoveWorld();
    const fall = makePmoveState();
    fall.origin = new Float32Array([0, 0, 1000]);
    fall.onGround = false;
    pmove(fall, { msec: 100, angles: v3(), forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 });
    expect(fall.velocity[2]!).toBeLessThan(0);

    setPmoveWorld(floorTrace);
    const slide = makePmoveState();
    slide.origin = new Float32Array([0, 0, 24]); // resting on the floor
    slide.velocity = new Float32Array([300, 0, 0]);
    pmove(slide, { msec: 100, angles: v3(), forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 });
    expect(slide.velocity[0]!).toBeLessThan(300);
    resetPmoveWorld();
  });

  it('crouch shrinks hull and clamps speed', () => {
    resetPmoveWorld();
    const st = makePmoveState();
    st.pmFlags |= PMF_DUCKED;
    pmove(st, { msec: 50, angles: v3(), forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 });
    expect(st.maxs[2]).toBe(4);
    expect(st.viewheight).toBe(12);
  });

  it('detects water levels and ladders', () => {
    resetPmoveWorld();
    setPmoveWorld(
      (_s, _mi, _ma, end) => ({
        fraction: 0.5,
        endpos: new Float32Array(end),
        planeNormal: v3(0, 0, 1),
        allsolid: false,
        startsolid: false,
        entityNum: -1,
        contents: CONTENTS_LADDER,
      }),
      (_p) => CONTENTS_WATER,
    );
    const st = makePmoveState();
    pmove(st, { msec: 50, angles: v3(), forwardmove: 100, sidemove: 0, upmove: 0, buttons: 0 });
    expect(st.waterlevel).toBe(3);
    expect(st.ladder).toBe(true);
    resetPmoveWorld();
  });

  it('clonePmoveState is a deep copy', () => {
    const a = makePmoveState();
    a.origin[0] = 5;
    const b = clonePmoveState(a);
    expect(b.origin[0]).toBe(5);
    b.origin[0] = 9;
    expect(a.origin[0]).toBe(5);
  });
});
