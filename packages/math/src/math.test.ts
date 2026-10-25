// Unit tests for @q2/math: vec3, angles helpers, mat4, planes, fixed point.
import { describe, expect, it } from 'vitest';
import {
  AngleVectors,
  BoxOnPlaneSide,
  DEG2RAD,
  FIX_HALF,
  FIX_MASK,
  FIX_ONE,
  FIX_SHIFT,
  FrustumFromView,
  LUXEL,
  PLANE_ANYX,
  PLANE_ANYY,
  PLANE_ANYZ,
  PLANE_X,
  PLANE_Y,
  PLANE_Z,
  PlaneDiff,
  PlanePoint,
  anglemod,
  boxInFrustum,
  boxOnPlane,
  cross,
  dirToAngles,
  dot,
  fixClamp,
  fixDiv,
  fixMul,
  fixToFloat,
  floatToFix,
  lerpAngle,
  m4identity,
  m4multiply,
  m4perspective,
  m4transformDir,
  m4transformPoint,
  m4view,
  makePlane,
  normalize,
  perpendicularVector,
  planeSignbits,
  planeTypeForNormal,
  rotatePointAroundVector,
  v3,
  v3add,
  v3clear,
  v3copy,
  v3copyTo,
  v3dist,
  v3equals,
  v3length,
  v3lengthSq,
  v3ma,
  v3negate,
  v3scale,
  v3set,
  v3sub,
} from './index.js';

const EPS = 1e-6;

function closeVec(received: Float32Array, expected: readonly number[]): void {
  expect(received.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(Math.abs(received[i]! - expected[i]!)).toBeLessThanOrEqual(EPS);
  }
}

describe('constants', () => {
  it('match §5 conventions', () => {
    expect(LUXEL).toBe(16);
    expect(FIX_SHIFT).toBe(16);
    expect(FIX_ONE).toBe(65536);
    expect(FIX_HALF).toBe(32768);
    expect(FIX_MASK).toBe(0xffff);
    expect(DEG2RAD).toBeCloseTo(Math.PI / 180, 12);
  });
});

describe('vec3', () => {
  it('v3 defaults to zero and v3set writes in place', () => {
    closeVec(v3(), [0, 0, 0]);
    const o = v3();
    expect(v3set(o, 1, 2, 3)).toBe(o);
    closeVec(o, [1, 2, 3]);
  });

  it('copy variants', () => {
    const a = v3(1, 2, 3);
    const c = v3copy(a);
    closeVec(c, [1, 2, 3]);
    expect(c).not.toBe(a);
    const dst = v3();
    expect(v3copyTo(a, dst)).toBe(dst);
    closeVec(dst, [1, 2, 3]);
  });

  it('add/sub/scale/ma/negate/clear', () => {
    const a = v3(1, 2, 3), b = v3(4, 5, 6);
    closeVec(v3add(a, b), [5, 7, 9]);
    closeVec(v3sub(a, b), [-3, -3, -3]);
    closeVec(v3scale(a, 2), [2, 4, 6]);
    closeVec(v3ma(a, 2, b), [9, 12, 15]); // a + 2b
    closeVec(v3negate(a), [-1, -2, -3]);
    const o = v3();
    v3add(a, b, o);
    closeVec(o, [5, 7, 9]);
    const m = v3(7, 8, 9);
    expect(v3clear(m)).toBe(m);
    closeVec(m, [0, 0, 0]);
  });

  it('dot/cross/normalize/length', () => {
    expect(dot(v3(1, 2, 3), v3(4, 5, 6))).toBe(32);
    closeVec(cross(v3(1, 0, 0), v3(0, 1, 0)), [0, 0, 1]);
    closeVec(cross(v3(1, 0, 0), v3(0, 1, 0), v3()), [0, 0, 1]);
    closeVec(normalize(v3(0, 3, 4)), [0, 0.6, 0.8]);
    // Zero vector normalizes to zero, not NaN (C divides by guarded length).
    closeVec(normalize(v3()), [0, 0, 0]);
    expect(v3length(v3(3, 4, 0))).toBe(5);
    expect(v3lengthSq(v3(1, 2, 2))).toBe(9);
    expect(v3dist(v3(0, 0, 0), v3(1, 2, 2))).toBe(3);
  });

  it('v3equals respects epsilon', () => {
    expect(v3equals(v3(1, 0, 0), v3(1, 0, 0))).toBe(true);
    expect(v3equals(v3(1, 0, 0), v3(1 + 5e-7, 0, 0))).toBe(true);
    expect(v3equals(v3(1, 0, 0), v3(1.001, 0, 0))).toBe(false);
    expect(v3equals(v3(1, 0, 0), v3(1.001, 0, 0), 0.01)).toBe(true);
  });
});

describe('angles helpers', () => {
  it('anglemod wraps to [0, 360)', () => {
    expect(anglemod(0)).toBe(0);
    expect(anglemod(360)).toBeCloseTo(0, 10);
    expect(anglemod(720 + 45)).toBeCloseTo(45, 3);
    expect(anglemod(-90)).toBeCloseTo(270, 3);
  });

  it('lerpAngle takes the shortest arc (arg order matches C: a2, a1, frac)', () => {
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(360, 10);
    expect(lerpAngle(10, 350, 0.5)).toBeCloseTo(0, 10);
    expect(lerpAngle(0, 90, 0.25)).toBeCloseTo(22.5, 10);
  });

  it('dirToAngles inverts AngleVectors forward', () => {
    closeVec(dirToAngles(v3(1, 0, 0)), [0, 0, 0]);
    closeVec(dirToAngles(v3(0, 0, -1)), [90, 0, 0]); // down is positive pitch
    closeVec(dirToAngles(v3(0, 1, 0)), [0, 90, 0]);
    closeVec(dirToAngles(v3(-1, 0, 0)), [0, 180, 0]);
    // Round-trip through AngleVectors for several directions.
    for (const d of [v3(1, 1, 0), v3(1, 0, -1), v3(-1, -1, -1), v3(0.2, -0.5, 0.3)]) {
      const n = normalize(d);
      const f = v3();
      AngleVectors(dirToAngles(n), f);
      closeVec(f, [n[0], n[1], n[2]]);
    }
  });

  it('PlanePoint projects onto the plane (C ProjectPointOnPlane, non-unit normal)', () => {
    closeVec(PlanePoint(v3(1, 2, 5), v3(0, 0, 2)), [1, 2, 3.75]);
    closeVec(PlanePoint(v3(3, 0, 0), v3(1, 0, 0)), [0, 0, 0]);
  });

  it('perpendicularVector returns a unit perpendicular', () => {
    for (const s of [v3(0, 0, 1), v3(1, 0, 0), normalize(v3(1, 2, 3))]) {
      const p = perpendicularVector(s);
      expect(Math.abs(dot(p, s))).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(v3length(p) - 1)).toBeLessThanOrEqual(1e-6);
    }
    // Smallest-axis branch: (0.5, 0.5, ~0.7) picks z... just check property.
    const p = perpendicularVector(normalize(v3(0.1, 0.9, 0.2)));
    expect(Math.abs(v3length(p) - 1)).toBeLessThanOrEqual(1e-6);
  });

  it('rotatePointAroundVector follows the right-hand rule (C formula)', () => {
    closeVec(rotatePointAroundVector(v3(0, 0, 1), v3(1, 0, 0), 90), [0, 1, 0]);
    closeVec(rotatePointAroundVector(v3(0, 0, 1), v3(1, 0, 0), 180), [-1, 0, 0]);
    // Axis itself is fixed; length preserved.
    const r = rotatePointAroundVector(v3(0, 0, 1), v3(0, 0, 1), 33);
    closeVec(r, [0, 0, 1]);
    expect(v3length(rotatePointAroundVector(normalize(v3(1, 1, 1)), v3(1, 2, 3), 37))).toBeCloseTo(
      v3length(v3(1, 2, 3)), 5,
    );
  });
});

describe('mat4', () => {
  it('identity', () => {
    closeVec(m4identity(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const o = new Float32Array(16);
    expect(m4identity(o)).toBe(o);
    expect(o[0]).toBe(1);
    expect(o[15]).toBe(1);
  });

  it('multiply: identity laws and a known rotation product', () => {
    const a = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const ident = m4identity();
    closeVec(m4multiply(a, ident), Array.from(a));
    closeVec(m4multiply(ident, a), Array.from(a));
    // Rz(90)^2 = Rz(180), column-major.
    const rz90 = new Float32Array([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    closeVec(m4multiply(rz90, rz90), [-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    // In-place multiply (out === a) matches the out-of-place result.
    const b = new Float32Array(rz90);
    const expected = m4multiply(rz90, a);
    const inout = new Float32Array(rz90);
    m4multiply(inout, a, inout);
    closeVec(inout, Array.from(expected));
    expect(b[0]).toBe(0); // fixture untouched sanity
  });

  it('perspective matches the OpenGL formula', () => {
    // fovY=90, aspect=1, near=1, far=10: f=1, m10=-11/9, m14=-20/9.
    const m = m4perspective(90, 1, 1, 10);
    expect(m[0]).toBeCloseTo(1, 6);
    expect(m[5]).toBeCloseTo(1, 6);
    expect(m[10]).toBeCloseTo(-11 / 9, 6);
    expect(m[11]).toBe(-1);
    expect(m[14]).toBeCloseTo(-20 / 9, 6);
    expect(m[15]).toBe(0);
    // Aspect scales x. Center point at z=-2 maps to NDC z=1/9.
    const wide = m4perspective(90, 2, 1, 10);
    expect(wide[0]).toBeCloseTo(0.5, 6);
    closeVec(m4transformPoint(m, v3(0, 0, -2)), [0, 0, 1 / 9]);
  });

  it('view matches R_SetupFrame: origin maps to zero, basis to unit axes', () => {
    const origin = v3(10, 20, 30);
    const angles = v3(0, 0, 0); // facing +X; right=(0,-1,0), up=(0,0,1)
    const m = m4view(origin, angles);
    closeVec(m4transformPoint(m, origin), [0, 0, 0]);
    closeVec(m4transformPoint(m, v3(11, 20, 30)), [0, 0, 1]); // +forward
    closeVec(m4transformPoint(m, v3(10, 19, 30)), [1, 0, 0]); // +right
    closeVec(m4transformPoint(m, v3(10, 20, 31)), [0, 1, 0]); // +up
    closeVec(m4transformDir(m, v3(1, 0, 0)), [0, 0, 1]);
  });

  it('view agrees with AngleVectors dots for pitched/yawed cameras', () => {
    const origin = v3(-4, 7, 2);
    const angles = v3(30, 45, 0);
    const m = m4view(origin, angles);
    const f = v3(), r = v3(), u = v3();
    AngleVectors(angles, f, r, u);
    for (const p of [v3(0, 0, 0), v3(9, -3, 12), v3(-4, 7, 2)]) {
      const d = v3sub(p, origin);
      closeVec(m4transformPoint(m, p), [dot(d, r), dot(d, u), dot(d, f)]);
    }
    // Yaw-90 camera: world +Y is forward.
    const m2 = m4view(v3(), v3(0, 90, 0));
    closeVec(m4transformPoint(m2, v3(0, 5, 0)), [0, 0, 5]);
  });
});

describe('planes', () => {
  it('plane type + signbits follow qfiles.h / CM_LoadMapPlanes', () => {
    expect(planeTypeForNormal(v3(1, 0, 0))).toBe(PLANE_X);
    expect(planeTypeForNormal(v3(0, -1, 0))).toBe(PLANE_Y);
    expect(planeTypeForNormal(v3(0, 0, 1))).toBe(PLANE_Z);
    expect(planeTypeForNormal(v3(0.6, 0.8, 0))).toBe(PLANE_ANYY);
    expect(planeTypeForNormal(v3(0.7, -0.7, 0))).toBe(PLANE_ANYX); // tie → first axis
    expect(planeTypeForNormal(v3(0.1, 0.2, 0.9))).toBe(PLANE_ANYZ);
    expect(planeSignbits(v3(1, 1, 1))).toBe(0);
    expect(planeSignbits(v3(-1, 1, 1))).toBe(1);
    expect(planeSignbits(v3(1, -1, 1))).toBe(2);
    expect(planeSignbits(v3(1, 1, -1))).toBe(4);
    expect(planeSignbits(v3(-1, -1, -1))).toBe(7);
  });

  it('makePlane copies the normal and classifies', () => {
    const n = v3(0, 0, 1);
    const p = makePlane(n, 5);
    expect(p.dist).toBe(5);
    expect(p.type).toBe(PLANE_Z);
    expect(p.signbits).toBe(0);
    n[2] = -1; // mutating the source must not affect the plane
    expect(p.normal[2]).toBe(1);
    const reused = makePlane(v3(0, 1, 0), 2, p);
    expect(reused).toBe(p);
    expect(p.type).toBe(PLANE_Y);
    expect(p.dist).toBe(2);
  });

  it('PlaneDiff: axial fast path and general case', () => {
    expect(PlaneDiff(v3(7, 0, 0), makePlane(v3(1, 0, 0), 5))).toBe(2);
    expect(PlaneDiff(v3(3, 0, 0), makePlane(v3(1, 0, 0), 5))).toBe(-2);
    expect(PlaneDiff(v3(0, 0, 10), makePlane(v3(0, 0, 1), 3))).toBe(7);
  });

  it('BoxOnPlaneSide keeps its legacy signature (front/back/spanning)', () => {
    const n = v3(0, 0, 1);
    expect(BoxOnPlaneSide(v3(0, 0, 4), v3(1, 1, 5), n, 3)).toBe(1);
    expect(BoxOnPlaneSide(v3(0, 0, -5), v3(1, 1, -4), n, 3)).toBe(2);
    expect(BoxOnPlaneSide(v3(0, 0, -5), v3(1, 1, 5), n, 3)).toBe(3);
  });

  it('boxOnPlane: axial fast paths', () => {
    expect(boxOnPlane(v3(4, 0, 0), v3(5, 1, 1), makePlane(v3(1, 0, 0), 3))).toBe(1);
    expect(boxOnPlane(v3(4, 0, 0), v3(5, 1, 1), makePlane(v3(1, 0, 0), 6))).toBe(2);
    expect(boxOnPlane(v3(4, 0, 0), v3(5, 1, 1), makePlane(v3(1, 0, 0), 4.5))).toBe(3);
  });

  it('boxOnPlane: all 8 signbits arms (C switch) + front/back/spanning', () => {
    const mins = v3(-1, -1, -1), maxs = v3(1, 1, 1);
    const s = Math.SQRT1_2 / Math.SQRT2; // 1/sqrt(3)
    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        for (const sz of [1, -1]) {
          const n = v3(sx * s, sy * s, sz * s);
          // dist 0 straddles every diagonal plane through the origin.
          expect(boxOnPlane(mins, maxs, makePlane(n, 0))).toBe(3);
        }
      }
    }
    const diag = v3(s, s, s);
    expect(boxOnPlane(mins, maxs, makePlane(diag, -5))).toBe(1);
    expect(boxOnPlane(mins, maxs, makePlane(diag, 5))).toBe(2);
  });

  it('FrustumFromView: symmetric 90-degree frustum goldens (R_ViewChanged + R_TransformFrustum)', () => {
    const s = Math.SQRT1_2;
    const planes = FrustumFromView(v3(0, 0, 0), v3(0, 0, 0), 90, 90);
    expect(planes.length).toBe(4);
    closeVec(planes[0]!.normal, [s, -s, 0]); // left
    closeVec(planes[1]!.normal, [s, s, 0]); // right
    closeVec(planes[2]!.normal, [s, 0, -s]); // top
    closeVec(planes[3]!.normal, [s, 0, s]); // bottom
    for (const p of planes) expect(p.dist).toBe(0);
    // Ahead is inside every plane; behind is outside; sides classify correctly.
    expect(PlaneDiff(v3(10, 0, 0), planes[0]!)).toBeGreaterThan(0);
    expect(PlaneDiff(v3(-10, 0, 0), planes[0]!)).toBeLessThan(0);
    expect(PlaneDiff(v3(0, 10, 0), planes[0]!)).toBeLessThan(0); // screen-left (+Y)
    expect(PlaneDiff(v3(0, -10, 0), planes[1]!)).toBeLessThan(0); // past screen-right
    expect(PlaneDiff(v3(10, 0, 10), planes[3]!)).toBeGreaterThan(0);
  });

  it('FrustumFromView: dist follows the origin, reuses out planes', () => {
    const s = Math.SQRT1_2;
    const planes = FrustumFromView(v3(5, 0, 0), v3(0, 0, 0), 90, 90);
    expect(planes[0]!.dist).toBeCloseTo(5 * s, 6);
    const again = FrustumFromView(v3(5, 0, 0), v3(0, 90, 0), 90, 90, planes);
    expect(again).toBe(planes);
    // Yaw-90 camera looks along +Y: +Y is now forward.
    closeVec(planes[0]!.normal, [s, s, 0]);
    expect(PlaneDiff(v3(5, 10, 0), planes[0]!)).toBeGreaterThan(0);
    expect(planes[0]!.dist).toBeCloseTo(5 * s, 6);
  });

  it('boxInFrustum culls only fully-outside boxes', () => {
    const planes = FrustumFromView(v3(0, 0, 0), v3(0, 0, 0), 90, 90);
    expect(boxInFrustum(v3(5, -1, -1), v3(6, 1, 1), planes)).toBe(true); // ahead
    expect(boxInFrustum(v3(-6, -1, -1), v3(-5, 1, 1), planes)).toBe(false); // behind
    expect(boxInFrustum(v3(0, 20, 0), v3(1, 21, 1), planes)).toBe(false); // past screen-left
    expect(boxInFrustum(v3(5, 4, -1), v3(6, 6, 1), planes)).toBe(true); // straddles left edge
    expect(boxInFrustum(v3(0, 0, 0), v3(1, 1, 1), [])).toBe(true); // no planes: visible
  });
});

describe('fixed point', () => {
  it('converts and multiplies like d_scan.c', () => {
    expect(floatToFix(1.5)).toBe(98304);
    expect(floatToFix(-1.5)).toBe(-98304);
    expect(fixToFloat(98304)).toBe(1.5);
    expect(fixMul(floatToFix(1.5), floatToFix(2))).toBe(floatToFix(3));
    expect(fixToFloat(fixDiv(floatToFix(1.5), floatToFix(0.5)))).toBe(3);
    expect(fixClamp(10, 0, 5)).toBe(5);
    expect(fixClamp(-1, 0, 5)).toBe(0);
    expect(fixClamp(3, 0, 5)).toBe(3);
  });
});
