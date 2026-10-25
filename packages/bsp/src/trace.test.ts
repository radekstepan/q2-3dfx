// M2.1: traceBox smoke tests + pointLeaf consistency + 2000-ray determinism.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@q2/math';
import { pointLeaf, traceBox, loadBsp } from './index.js';
import type { BspMap } from './index.js';
import { buildTestMap } from './testmap.js';

const SOLID = 1;

function v(x: number, y: number, z: number): Vec3 {
  return new Float32Array([x, y, z]) as Vec3;
}
function z3(): Vec3 {
  return v(0, 0, 0);
}

let world: BspMap;
function getWorld(): BspMap {
  if (!world) world = loadBsp(buildTestMap());
  return world;
}

describe('pointLeaf', () => {
  it('routes either side of the node plane', () => {
    const w = getWorld();
    expect(pointLeaf(w, v(5, 0, 0))).toBe(1); // empty leaf
    expect(pointLeaf(w, v(-5, 0, 0))).toBe(0); // solid structural leaf
    expect(pointLeaf(w, v(0, 0, 0))).toBe(1); // on-plane goes front
  });

  it('is consistent with the leaf the trace stops in', () => {
    const w = getWorld();
    const start = v(50, 0, 0);
    expect(pointLeaf(w, start)).toBe(1);
    expect(w.leafs[1 * 13]!).toBe(1); // that leaf holds the solid brush
    const t = traceBox(w, start, v(-50, 0, 0), z3(), z3(), SOLID);
    // endpos rests just outside the wall face (x=10 + epsilon bias)
    expect(t.endpos[0]!).toBeGreaterThan(10);
    expect(t.endpos[0]!).toBeLessThan(10.5);
    expect(pointLeaf(w, t.endpos)).toBe(1);
  });
});

describe('traceBox smoke', () => {
  it('open corridor: fraction 1, endpos == end', () => {
    const w = getWorld();
    const end = v(60, 30, 30);
    const t = traceBox(w, v(50, 20, 20), end, z3(), z3(), SOLID);
    expect(t.fraction).toBe(1);
    expect(Array.from(t.endpos)).toEqual(Array.from(end));
    expect(t.startsolid).toBe(false);
    expect(t.allsolid).toBe(false);
    expect(t.contents).toBe(0);
  });

  it('through-wall point trace: fraction < 1, face normal +X', () => {
    const w = getWorld();
    const t = traceBox(w, v(50, 0, 0), v(-50, 0, 0), z3(), z3(), SOLID);
    // enter at x=10 over a 100-unit sweep, minus DIST_EPSILON bias
    expect(t.fraction).toBeGreaterThan(0.39);
    expect(t.fraction).toBeLessThan(0.41);
    expect(t.endpos[0]!).toBeCloseTo(50 - 100 * t.fraction, 9);
    expect(t.planeNormal[0]).toBeCloseTo(1, 6);
    expect(t.planeNormal[1]).toBe(0);
    expect(t.planeNormal[2]).toBe(0);
    expect(t.contents).toBe(SOLID);
    expect(t.startsolid).toBe(false);
  });

  it('box trace stops one unit earlier (extents offset)', () => {
    const w = getWorld();
    const point = traceBox(w, v(50, 0, 0), v(-50, 0, 0), z3(), z3(), SOLID);
    const box = traceBox(w, v(50, 0, 0), v(-50, 0, 0), v(-1, -1, -1), v(1, 1, 1), SOLID);
    expect(box.fraction).toBeLessThan(point.fraction);
    expect(box.endpos[0]!).toBeCloseTo(11, 0); // 10 + 1 extents, within epsilon
    expect(box.fraction).toBeCloseTo((50 - box.endpos[0]!) / 100, 6);
  });

  it('start inside solid (position test): startsolid + allsolid, fraction 0', () => {
    const w = getWorld();
    const t = traceBox(w, v(0, 0, 0), v(0, 0, 0), z3(), z3(), SOLID);
    expect(t.fraction).toBe(0);
    expect(t.startsolid).toBe(true);
    expect(t.allsolid).toBe(true);
    expect(t.contents).toBe(SOLID);
  });

  it('empty mask passes through everything', () => {
    const w = getWorld();
    const t = traceBox(w, v(50, 0, 0), v(-50, 0, 0), z3(), z3(), 0);
    expect(t.fraction).toBe(1);
  });

  it('backwards trace out of the wall', () => {
    const w = getWorld();
    const t = traceBox(w, v(-50, 0, 0), v(50, 0, 0), z3(), z3(), SOLID);
    // wall spans x in [-10,10]; entering the -X face from the back side
    expect(t.fraction).toBeGreaterThan(0.39);
    expect(t.fraction).toBeLessThan(0.41);
    expect(t.planeNormal[0]).toBeCloseTo(-1, 6);
  });
});

describe('2000-ray determinism', () => {
  // mulberry32 — deterministic PRNG, fixed seed
  function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function runRays(w: BspMap): number[] {
    const rand = prng(0xc0ffee);
    const fracs: number[] = new Array(2000);
    for (let i = 0; i < 2000; i++) {
      const sx = rand() * 160 - 80;
      const sy = rand() * 160 - 80;
      const sz = rand() * 160 - 80;
      const ex = rand() * 160 - 80;
      const ey = rand() * 160 - 80;
      const ez = rand() * 160 - 80;
      const t = traceBox(w, v(sx, sy, sz), v(ex, ey, ez), z3(), z3(), SOLID);
      fracs[i] = t.fraction;
    }
    return fracs;
  }

  it('two runs agree bit-for-bit and hit the recorded spot fractions', () => {
    const w = getWorld();
    const a = runRays(w);
    const b = runRays(w);
    expect(a).toEqual(b);
    const hits = a.filter((f) => f < 1).length;
    expect(hits).toBeGreaterThan(50); // wall is regularly in the way
    expect(hits).toBeLessThan(2000);
    // spot checks recorded from the reference run (update only with review)
    expect(a[0]).toBe(1);
    expect(a[2]).toBeCloseTo(0.57568091148837874, 12);
    expect(a[5]).toBeCloseTo(0.78513900322485974, 12);
    expect(a[7]).toBeCloseTo(0.22513234911624691, 12);
    expect(Math.min(...a)).toBeCloseTo(0.10683489328590873, 12);
    expect(a.filter((f) => f < 1).length).toBe(94);
    const mean = a.reduce((s, f) => s + f, 0) / a.length;
    expect(mean).toBeGreaterThan(0.5);
    expect(mean).toBeLessThan(1);
  });
});
