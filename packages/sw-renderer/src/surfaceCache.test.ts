// M3.2 tests: R_BuildLightMap equivalent + LRU surface cache.
import { describe, expect, it } from 'vitest';
import { buildLightMap, DLightState, bboxDistance } from './light.js';
import { SurfaceCache, hashLightStyles, surfaceCacheKey } from './surfaceCache.js';

function flatSamples(w: number, h: number, v: number): Uint8Array {
  const s = new Uint8Array(w * h * 3);
  s.fill(v);
  return s;
}

describe('buildLightMap', () => {
  it('maps mid-grey to grade ~32 at style 1.0', () => {
    const out = new Uint8Array(4);
    buildLightMap(out, flatSamples(2, 2, 128), 2, 2, [1],
      [], new Float32Array([0, 0, 0]), 0);
    // luma(128,128,128) = 0.502 -> 0.502*63 = 31.6 -> 32
    expect([...out]).toEqual([32, 32, 32, 32]);
  });

  it('lightstyle scales the block (dark style -> dark grades)', () => {
    const bright = new Uint8Array(4);
    const dark = new Uint8Array(4);
    const s = flatSamples(2, 2, 200);
    buildLightMap(bright, s, 2, 2, [1.5], [], new Float32Array([0, 0, 0]), 0);
    buildLightMap(dark, s, 2, 2, [0.25], [], new Float32Array([0, 0, 0]), 0);
    // 200/255=0.784; *1.5 clamps to 1 -> 63; *0.25=0.196 -> 12
    expect([...bright]).toEqual([63, 63, 63, 63]);
    expect([...dark]).toEqual([12, 12, 12, 12]);
  });

  it('dynamic light adds falloff-limited contribution', () => {
    const base = new Uint8Array(1);
    const lit = new Uint8Array(1);
    const s = flatSamples(1, 1, 0);
    const dl = { origin: new Float32Array([0, 0, 0]), intensity: 100, color: new Float32Array([1, 1, 1]) };
    buildLightMap(base, s, 1, 1, [1], [], new Float32Array([0, 0, 0]), 0);
    buildLightMap(lit, s, 1, 1, [1], [dl], new Float32Array([0, 0, 0]), 1);
    expect(base[0]).toBe(0);
    // dist 0 < 100: f = 1, luma(white) = 1 -> grade 63
    expect(lit[0]).toBe(63);
  });

  it('dynamic light out of range adds nothing without its bit', () => {
    const out = new Uint8Array(1);
    const dl = { origin: new Float32Array([1000, 0, 0]), intensity: 10, color: new Float32Array([1, 1, 1]) };
    buildLightMap(out, flatSamples(1, 1, 64), 1, 1, [1], [dl], new Float32Array([0, 0, 0]), 1);
    // dist 1000 > 10 -> no contribution; 64/255=0.251 -> 16
    expect(out[0]).toBe(16);
  });
});

describe('bboxDistance', () => {
  it('is zero inside, axis distance outside', () => {
    const mins = new Float32Array([0, 0, 0]);
    const maxs = new Float32Array([10, 10, 10]);
    expect(bboxDistance(new Float32Array([5, 5, 5]), mins, maxs)).toBe(0);
    expect(bboxDistance(new Float32Array([13, 5, 5]), mins, maxs)).toBe(3);
  });
});

describe('DLightState.markLights', () => {
  it('marks only surfaces within radius, sets bits', () => {
    const st = new DLightState();
    st.addLight({ origin: new Float32Array([0, 0, 0]), intensity: 50, color: new Float32Array([1, 1, 1]) });
    const surfs = [
      { id: 7, mins: new Float32Array([-5, -5, -5]), maxs: new Float32Array([5, 5, 5]) },
      { id: 9, mins: new Float32Array([1000, 0, 0]), maxs: new Float32Array([1010, 10, 10]) },
    ];
    const affected = st.markLights(surfs);
    expect(affected).toEqual([7]);
    expect(st.bitsFor(7)).toBe(1);
    expect(st.bitsFor(9)).toBe(0);
  });
});

describe('SurfaceCache', () => {
  const block = (v: number) => ({
    texels: new Uint8Array([v]), bw: 1, bh: 1, light: new Uint8Array([v]), luxW: 1, luxH: 1,
  });

  it('hits after put, misses on different style hash or mip', () => {
    const c = new SurfaceCache();
    c.put(3, 11, 0, block(42));
    expect(c.get(3, 11, 0)?.texels[0]).toBe(42);
    expect(c.get(3, 12, 0)).toBeNull();
    expect(c.get(3, 11, 1)).toBeNull();
    expect(c.get(4, 11, 0)).toBeNull();
    expect(c.hits).toBe(1);
    expect(c.misses).toBe(3);
    expect(c.hitRate()).toBeCloseTo(0.25, 10);
  });

  it('evicts LRU entries to respect the budget', () => {
    const c = new SurfaceCache(200); // tiny budget
    c.put(1, 1, 0, { texels: new Uint8Array(60), bw: 1, bh: 1, light: new Uint8Array(60), luxW: 1, luxH: 1 });
    c.put(2, 1, 0, { texels: new Uint8Array(60), bw: 1, bh: 1, light: new Uint8Array(60), luxW: 1, luxH: 1 });
    // 60+60+64 bytes each > 200 -> first entry evicted
    expect(c.get(1, 1, 0)).toBeNull();
    expect(c.get(2, 1, 0)).not.toBeNull();
    expect(c.evictions).toBe(1);
    expect(c.used).toBeLessThanOrEqual(200);
  });

  it('invalidateSurfaces drops all mips/styles of a surface (dynamic-light path)', () => {
    const c = new SurfaceCache();
    c.put(5, 1, 0, block(1));
    c.put(5, 2, 1, block(2));
    c.put(6, 1, 0, block(3));
    c.invalidateSurfaces([5]);
    expect(c.get(5, 1, 0)).toBeNull();
    expect(c.get(5, 2, 1)).toBeNull();
    expect(c.get(6, 1, 0)?.texels[0]).toBe(3);
  });

  it('key composition separates (surface, hash, mip)', () => {
    const keys = new Set([
      surfaceCacheKey(1, 2, 0), surfaceCacheKey(1, 2, 1),
      surfaceCacheKey(1, 3, 0), surfaceCacheKey(2, 2, 0),
    ]);
    expect(keys.size).toBe(4);
  });

  it('hashLightStyles is deterministic and sensitive', () => {
    expect(hashLightStyles([1, 1])).toBe(hashLightStyles([1, 1]));
    expect(hashLightStyles([1, 0.5])).not.toBe(hashLightStyles([1, 1]));
  });
});
