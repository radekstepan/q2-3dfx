// M3.2 tests: R_BuildLightMap equivalent + LRU surface cache.
import { describe, expect, it } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import { buildLightMap, combineStyleScales, DLightState, bboxDistance, luxelWorldPositions } from './light.js';
import { DEFAULT_DLIGHT_TTL_FRAMES, LIGHT_OVERBRIGHT, LIGHT_STYLE_UNUSED } from './light.js';
import { SurfaceCache, hashLightStyles, surfaceCacheKey } from './surfaceCache.js';
import { SoftwareRenderer } from './frame.js';
import type { MiniWorld } from './worldNodes.js';

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

  it('lightstyle scales the block (dark style -> dark grades, floored)', () => {
    const bright = new Uint8Array(4);
    const dark = new Uint8Array(4);
    const s = flatSamples(2, 2, 200);
    buildLightMap(bright, s, 2, 2, [1.5], [], new Float32Array([0, 0, 0]), 0);
    buildLightMap(dark, s, 2, 2, [0.25], [], new Float32Array([0, 0, 0]), 0);
    // 200/255=0.784; *1.5 clamps to 1 -> 63; *0.25=0.196 -> 12 -> floor 16
    expect([...bright]).toEqual([63, 63, 63, 63]);
    expect([...dark]).toEqual([16, 16, 16, 16]);
  });

  it('dynamic light adds falloff-limited contribution', () => {
    const base = new Uint8Array(1);
    const lit = new Uint8Array(1);
    const s = flatSamples(1, 1, 0);
    const dl = { origin: new Float32Array([0, 0, 0]), intensity: 100, color: new Float32Array([1, 1, 1]) };
    buildLightMap(base, s, 1, 1, [1], [], new Float32Array([0, 0, 0]), 0);
    buildLightMap(lit, s, 1, 1, [1], [dl], new Float32Array([0, 0, 0]), 1);
    // unlit static reads the dark-end floor, not pure black
    expect(base[0]).toBe(16);
    // dist 0 < 100: f = 1, luma(white) = 1 -> grade 63
    expect(lit[0]).toBe(63);
  });

  it('two-style sum equals the single-style equivalent (M6.1 dark baseline)', () => {
    const one = new Uint8Array(4);
    const two = new Uint8Array(4);
    const s = flatSamples(2, 2, 200);
    buildLightMap(one, s, 2, 2, [1], [], new Float32Array([0, 0, 0]), 0);
    buildLightMap(two, s, 2, 2, [0.5, 0.5], [], new Float32Array([0, 0, 0]), 0);
    // 200/255=0.784 -> *1.0 -> 49.4 -> 49 either way: multi-style sums,
    // single-style is unchanged (devroom golden intact).
    expect([...one]).toEqual([49, 49, 49, 49]);
    expect([...two]).toEqual([...one]);
  });

  it('multi-style surface is lit by its live styles, not black', () => {
    const out = new Uint8Array(1);
    // first style off (flicker), second on: old [0]-only path gave 0.
    buildLightMap(out, flatSamples(1, 1, 200), 1, 1, [0, 1],
      [], new Float32Array([0, 0, 0]), 0);
    expect(out[0]).toBe(49);
  });

  it('overbright modulate defaults to current look, x2 brightens', () => {
    expect(LIGHT_OVERBRIGHT).toBe(1);
    const normal = new Uint8Array(1);
    const bright = new Uint8Array(1);
    const dim2x = new Uint8Array(1);
    buildLightMap(normal, flatSamples(1, 1, 128), 1, 1, [1],
      [], new Float32Array([0, 0, 0]), 0);
    expect(normal[0]).toBe(32); // pinned current look
    buildLightMap(bright, flatSamples(1, 1, 128), 1, 1, [1],
      [], new Float32Array([0, 0, 0]), 0, 2);
    expect(bright[0]).toBe(63); // 0.502*2 clamps to full grade
    buildLightMap(dim2x, flatSamples(1, 1, 64), 1, 1, [1],
      [], new Float32Array([0, 0, 0]), 0, 2);
    expect(dim2x[0]).toBe(32); // linear region doubles 16 -> 32
  });

  it('combineStyleScales skips the 255 terminator (id-correct)', () => {
    const styles = new Float32Array(256).fill(1);
    expect(combineStyleScales([0, 1], styles)).toBe(2);
    expect(combineStyleScales([0, LIGHT_STYLE_UNUSED], styles)).toBe(1);
    expect(combineStyleScales(
      [LIGHT_STYLE_UNUSED, LIGHT_STYLE_UNUSED], styles)).toBe(0);
  });

  it('dynamic light out of range adds nothing without its bit', () => {
    const out = new Uint8Array(1);
    const dl = { origin: new Float32Array([1000, 0, 0]), intensity: 10, color: new Float32Array([1, 1, 1]) };
    buildLightMap(out, flatSamples(1, 1, 64), 1, 1, [1], [dl], new Float32Array([0, 0, 0]), 1);
    // dist 1000 > 10 -> no contribution; 64/255=0.251 -> 16
    expect(out[0]).toBe(16);
  });
});

describe('luxelWorldPositions (per-luxel dlight falloff grid)', () => {
  // Quad in the z=0 plane, x in [0,64], y in [0,16]; lux = (uv-base)/16.
  const verts = new Float32Array([0, 0, 0, 64, 0, 0, 64, 16, 0, 0, 16, 0]);
  const lux = new Float32Array([0, 0, 4, 0, 4, 1, 0, 1]);
  const center = new Float32Array([32, 8, 0]);

  it('fits exact world pos at luxel centers for a planar quad', () => {
    const out = new Float32Array(4 * 1 * 3);
    luxelWorldPositions(verts, lux, 4, 4, 1, center, out);
    expect([...out]).toEqual([
      8, 8, 0,
      24, 8, 0,
      40, 8, 0,
      56, 8, 0,
    ]);
  });

  it('a point light only affects nearby luxels, not the whole surface', () => {
    const w = 4, h = 1;
    const samples = new Uint8Array(w * h * 3); // black static: base grade 0
    const pos = new Float32Array(w * h * 3);
    luxelWorldPositions(verts, lux, 4, w, h, center, pos);
    const out = new Uint8Array(w * h);
    // light at luxel-0 center, radius 32: covers luxels 0 (fully) and 1 (half)
    const dl = { origin: new Float32Array([8, 8, 0]), intensity: 32, color: new Float32Array([1, 1, 1]) };
    buildLightMap(out, samples, w, h, [1], [dl], center, 1, 1, pos);
    // dists 0/16/32/48 -> f 1/0.5/0/0 -> grades 63/31/16/16 (31: fp luma
    // sum; the dark end reads the grade floor, never pure black)
    expect([...out]).toEqual([63, 31, 16, 16]);
  });

  it('legacy center path stays uniform when no luxel grid is supplied', () => {
    const w = 4, h = 1;
    const samples = new Uint8Array(w * h * 3);
    const out = new Uint8Array(w * h);
    const dl = { origin: new Float32Array([8, 8, 0]), intensity: 32, color: new Float32Array([1, 1, 1]) };
    buildLightMap(out, samples, w, h, [1], [dl], center, 1);
    // dist(center, light) = 24 -> f = 0.25 -> every luxel 16
    expect([...out]).toEqual([16, 16, 16, 16]);
  });

  it('degenerate lux mapping falls back to center, never NaN', () => {
    const out = new Float32Array(2 * 2 * 3);
    const dv = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const dl = new Float32Array([5, 5, 5, 5, 5, 5]); // all verts one luxel
    luxelWorldPositions(dv, dl, 3, 2, 2, center, out);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
    expect([...out]).toEqual([32, 8, 0, 32, 8, 0, 32, 8, 0, 32, 8, 0]);
    const grades = new Uint8Array(4);
    buildLightMap(grades, new Uint8Array(12), 2, 2, [1],
      [{ origin: new Float32Array([32, 8, 0]), intensity: 10, color: new Float32Array([1, 1, 1]) }],
      center, 1, 1, out);
    expect([...grades]).toEqual([63, 63, 63, 63]);
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

describe('DLightState expiry (muzzle-leak fix, renderer side)', () => {
  const mk = (intensity: number) => ({
    origin: new Float32Array([0, 0, 0]), intensity, color: new Float32Array([1, 1, 1]),
  });

  it('defaults to a 2-frame ttl', () => {
    expect(DEFAULT_DLIGHT_TTL_FRAMES).toBe(2);
  });

  it('stale lights expire with exactly one serial bump, then stay gone', () => {
    const st = new DLightState();
    const s0 = st.serial;
    st.addLight(mk(200));
    expect(st.serial).toBe(s0 + 1);
    expect(st.count).toBe(1);
    // two rendered frames pass without re-add: light still pending
    expect(st.expireStaleLights()).toBe(0);
    st.ageFrame();
    expect(st.expireStaleLights()).toBe(0);
    st.ageFrame();
    expect(st.serial).toBe(s0 + 1); // no bump until the sweep drops it
    // third sweep drops it: exactly one bump, then steady
    expect(st.expireStaleLights()).toBe(1);
    expect(st.serial).toBe(s0 + 2);
    expect(st.count).toBe(0);
    expect(st.expireStaleLights()).toBe(0);
    expect(st.serial).toBe(s0 + 2);
  });

  it('explicit ttl=1 lasts a single frame; ttl=0 expires immediately', () => {
    const st = new DLightState();
    st.addLight(mk(200), 1);
    expect(st.expireStaleLights()).toBe(0);
    st.ageFrame();
    expect(st.expireStaleLights()).toBe(1);
    st.addLight(mk(200), 0);
    expect(st.expireStaleLights()).toBe(1);
    expect(st.count).toBe(0);
  });

  it('sweep removes only the stale lights (swap-remove keeps the live one)', () => {
    const st = new DLightState();
    st.addLight(mk(111), 1); // short-lived
    st.addLight(mk(222), 9); // long-lived
    st.ageFrame();
    expect(st.expireStaleLights()).toBe(1);
    expect(st.count).toBe(1);
    expect(st.lights[0]!.intensity).toBe(222);
    // live light still marks surfaces
    const affected = st.markLights([
      { id: 3, mins: new Float32Array([-5, -5, -5]), maxs: new Float32Array([5, 5, 5]) },
    ]);
    expect(affected).toEqual([3]);
  });

  it('expireAll drops everything with one bump, free when idle', () => {
    const st = new DLightState();
    const s0 = st.serial;
    expect(st.expireAll()).toBe(0);
    expect(st.serial).toBe(s0); // idle pump hook: no invalidation, cache hot
    st.addLight(mk(200), 9);
    st.addLight(mk(200), 9);
    expect(st.count).toBe(2);
    expect(st.expireAll()).toBe(2);
    expect(st.count).toBe(0);
    expect(st.serial).toBe(s0 + 3); // two adds + one drop
    expect(st.expireAll()).toBe(0);
    expect(st.serial).toBe(s0 + 3);
  });

  it('clear() drops lights and ttls together', () => {
    const st = new DLightState();
    st.addLight(mk(200));
    st.addLight(mk(200));
    st.clear();
    expect(st.count).toBe(0);
    expect(st.expireStaleLights()).toBe(0);
  });

  it('clear() on an idle list bumps no serial (stays cache-hot)', () => {
    const st = new DLightState();
    const s0 = st.serial;
    st.clear();
    expect(st.serial).toBe(s0);
    st.addLight(mk(200));
    st.clear();
    expect(st.serial).toBe(s0 + 2); // one add bump + one drop bump
    st.clear();
    expect(st.serial).toBe(s0 + 2);
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

describe('per-luxel dynamic light (full render path)', () => {
  it('a blaster impact lights nearby luxels, not the whole surface', () => {
    // Quad at x=100 facing the camera (-X normal). y in [-32,32] maps to
    // screen columns (screen-left = +Y), z in [-8,8]. Static lightmap is
    // black, texture flat mid-grey: every lit pixel comes from the dlight.
    const verts = new Float32Array([
      100, -32, -8, 100, 32, -8, 100, 32, 8, 100, -32, 8,
    ]);
    const world: MiniWorld = {
      brand: 'miniworld',
      nodes: [],
      leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 1 }],
      pvs: [new Uint8Array([1])],
      clusterCount: 1,
      surfaces: [{
        id: 0, verts,
        uvs: new Float32Array([0, 0, 32, 0, 32, 16, 0, 16]),
        lux: new Float32Array([0, 0, 4, 0, 4, 1, 0, 1]),
        n: 4, texId: 0, lightId: 0,
        center: new Float32Array([100, 0, 0]), radius: 40,
        mins: new Float32Array([100, -32, -8]), maxs: new Float32Array([100, 32, 8]),
        turbulent: false, sky: false,
        fn: new Float32Array([-1, 0, 0]),
      }],
      textures: [{ texels: new Uint8Array(32 * 16).fill(200), width: 32, height: 16 }],
      lightmaps: [{ samples: new Uint8Array(4 * 1 * 3), luxW: 4, luxH: 1, styles: [0] }],
      dynamicLights: [],
      alias: [],
      sprites: [],
      particles: [],
    };
    const W = 160, H = 120;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = i;
      pal[i * 3 + 1] = i;
      pal[i * 3 + 2] = i;
    }
    r.setPalette(pal);
    const view = {
      origin: new Float32Array([0, 0, 0]), angles: new Float32Array([0, 0, 0]),
      fovX: 90, time: 0, lightStyles: new Float32Array(256).fill(1),
    };
    const w = { name: 'quad', data: world };
    r.beginFrame();
    r.renderView(view, w, []);
    r.endFrame();
    const base = fb.index!.slice();
    // Impact near the screen-left edge of the quad (light radius 40 covers
    // ~2 of the 4 luxels; the far half must stay near baseline).
    r.testAddDynamicLight({
      origin: new Float32Array([100, 28, 0]), intensity: 40,
      color: new Float32Array([1, 1, 1]),
    });
    r.beginFrame();
    r.renderView(view, w, []);
    r.endFrame();
    const lit = fb.index!;
    let nearSum = 0, nearN = 0, farSum = 0, farN = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = lit[y * W + x]! - base[y * W + x]!;
        if (d === 0) continue;
        if (x < W / 2) {
          nearSum += d;
          nearN++;
        } else {
          farSum += d;
          farN++;
        }
      }
    }
    expect(nearN).toBeGreaterThan(50);
    expect(farN).toBeGreaterThan(50);
    const nearMean = nearSum / nearN;
    const farMean = farSum / farN;
    // Localised falloff: the lit half averages far brighter than the far
    // half (legacy surfCenter falloff lit both halves uniformly).
    expect(nearMean).toBeGreaterThan(farMean + 40);
    expect(farMean).toBeLessThan(60);
  });
});
