// AngleVectors golden tests (M1.1).
//
// Expected vectors were captured from the C source
// (game/q_shared.c AngleVectors, external/Quake-2-master) by evaluating the
// exact C formulas in double precision:
//
//   forward = (cp*cy, cp*sy, -sp)
//   right   = (-sr*sp*cy + cr*sy, -sr*sp*sy - cr*cy, -sr*cp)
//   up      = (cr*sp*cy + sr*sy, cr*sp*sy - sr*cy, cr*cp)
//
// with pitch/yaw/roll in radians. Q2 conventions: +X forward, +Y left,
// +Z up; angles [pitch, yaw, roll] in degrees, pitch positive = down.
// Float32 rounding vs the baked doubles is < 1e-7; tolerance is 1e-6.
import { describe, expect, it } from 'vitest';
import { AngleVectors, dot, v3 } from './index.js';
import type { Vec3 } from './index.js';

const EPS = 1e-6;

function anglesVec(pitch: number, yaw: number, roll: number): Vec3 {
  const a = v3();
  a[0] = pitch; a[1] = yaw; a[2] = roll;
  return a;
}

function checkVec(received: Vec3, expected: readonly [number, number, number]): void {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(received[i]! - expected[i]!)).toBeLessThanOrEqual(EPS);
  }
}

interface Case {
  angles: [number, number, number];
  f: [number, number, number];
  r: [number, number, number];
  u: [number, number, number];
}

// Cardinal angles 0/90/180 + a diagonal + roll cases, forward + right + up.
const CASES: Case[] = [
  {
    angles: [0, 0, 0],
    f: [1, 0, 0],
    r: [0, -1, 0],
    u: [0, 0, 1],
  },
  {
    angles: [0, 90, 0],
    f: [0, 1, 0],
    r: [1, 0, 0],
    u: [0, 0, 1],
  },
  {
    angles: [0, 180, 0],
    f: [-1, 0, 0],
    r: [0, 1, 0],
    u: [0, 0, 1],
  },
  {
    angles: [90, 0, 0], // looking straight down
    f: [0, 0, -1],
    r: [0, -1, 0],
    u: [1, 0, 0],
  },
  {
    angles: [-90, 0, 0], // looking straight up
    f: [0, 0, 1],
    r: [0, -1, 0],
    u: [-1, 0, 0],
  },
  {
    angles: [45, 45, 0], // diagonal
    f: [0.5, 0.5, -0.707106781],
    r: [0.707106781, -0.707106781, 0],
    u: [0.5, 0.5, 0.707106781],
  },
  {
    angles: [0, 0, 90], // rolled 90 degrees, still facing +X
    f: [1, 0, 0],
    r: [0, 0, -1],
    u: [0, -1, 0],
  },
  {
    angles: [30, 45, 10], // diagonal with roll
    f: [0.612372436, 0.612372436, -0.5],
    r: [0.634970338, -0.757758142, -0.150383733],
    u: [0.470969924, 0.225394316, 0.852868532],
  },
];

describe('AngleVectors vs C-captured goldens', () => {
  for (const c of CASES) {
    it(`angles [${c.angles}]`, () => {
      const f = v3(), r = v3(), u = v3();
      AngleVectors(anglesVec(...c.angles), f, r, u);
      checkVec(f, c.f);
      checkVec(r, c.r);
      checkVec(u, c.u);
    });
  }

  it('produces an orthonormal basis for a sweep of angles', () => {
    const f = v3(), r = v3(), u = v3();
    for (let pitch = -90; pitch <= 90; pitch += 15) {
      for (let yaw = 0; yaw < 360; yaw += 15) {
        for (const roll of [0, 45, 90]) {
          AngleVectors(anglesVec(pitch, yaw, roll), f, r, u);
          for (const v of [f, r, u]) {
            expect(Math.abs(Math.hypot(v[0]!, v[1]!, v[2]!) - 1)).toBeLessThanOrEqual(1e-6);
          }
          expect(Math.abs(dot(f, r))).toBeLessThanOrEqual(1e-6);
          expect(Math.abs(dot(f, u))).toBeLessThanOrEqual(1e-6);
          expect(Math.abs(dot(r, u))).toBeLessThanOrEqual(1e-6);
        }
      }
    }
  });

  it('supports omitted outputs (branch coverage of the C null checks)', () => {
    const a = anglesVec(30, 45, 10);
    // No outputs at all — must not throw.
    AngleVectors(a);
    // Forward only.
    const f = v3();
    AngleVectors(a, f);
    checkVec(f, [0.612372436, 0.612372436, -0.5]);
    // Right only.
    const r = v3();
    AngleVectors(a, undefined, r);
    checkVec(r, [0.634970338, -0.757758142, -0.150383733]);
    // Up only.
    const u = v3();
    AngleVectors(a, undefined, undefined, u);
    checkVec(u, [0.470969924, 0.225394316, 0.852868532]);
    // Forward + up, no right.
    const f2 = v3(), u2 = v3();
    AngleVectors(a, f2, undefined, u2);
    checkVec(f2, [0.612372436, 0.612372436, -0.5]);
    checkVec(u2, [0.470969924, 0.225394316, 0.852868532]);
  });
});
