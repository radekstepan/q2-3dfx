// SKY surface handling: flat-shaded fill, no texture/cache/edges, no cull.
import { describe, expect, it } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import { SoftwareRenderer } from './frame.js';
import type { MiniWorld } from './worldNodes.js';
import {
  createSpan,
  SPAN_FLAT,
  drawSpansFlatPerSpan,
  type SpanList,
} from './spans.js';
import {
  BandedSoftwareBackend,
  attachBandShared,
  bandTotal,
  packBandSpans,
  processBandJob,
  splitBands,
} from './bands.js';
import {
  SKY_SIDE_IMAGE, SKY_TILE_SUFFIXES,
  isValidSkySize, skyFaceForDir, skyUvForDir,
} from './sky.js';
import { SoftwareBackend } from './spans.js';
import { WasmSpanBackend } from './wasmSpans.js';
import { buildColormap, defaultPalette } from './colormap.js';

/** Blue-forward palette: index 200 is the unambiguous sky pick. */
function skyPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = i;
    pal[i * 3 + 1] = i;
    pal[i * 3 + 2] = i;
  }
  pal[200 * 3] = 80;
  pal[200 * 3 + 1] = 120;
  pal[200 * 3 + 2] = 255;
  return pal;
}

/** One sky quad at x=40 in front of the camera, outward (+x) normal. */
function skyWorld(fnX: number): MiniWorld {
  const verts = new Float32Array([40, -30, 0, 40, 30, 0, 40, 30, 60, 40, -30, 60]);
  const mins = new Float32Array([40, -30, 0]);
  const maxs = new Float32Array([40, 30, 60]);
  const center = new Float32Array([40, 0, 30]);
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 1 }],
    pvs: [new Uint8Array([1])],
    clusterCount: 1,
    surfaces: [{
      id: 0, verts,
      uvs: new Float32Array([0, 0, 64, 0, 64, 64, 0, 64]),
      lux: new Float32Array([0, 0, 4, 0, 4, 4, 0, 4]),
      n: 4, texId: 0, lightId: 0,
      center, radius: 60, mins, maxs,
      turbulent: false, sky: true,
      fn: new Float32Array([fnX, 0, 0]),
    }],
    textures: [{ texels: new Uint8Array(16).fill(7), width: 4, height: 4 }],
    lightmaps: [{ samples: new Uint8Array([128, 128, 128]), luxW: 1, luxH: 1, styles: [0] }],
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
}

function renderSky(fnX: number, opts: { tex?: { texels: Uint8Array; width: number; height: number }; time?: number } = {}): { idx: Uint8Array; sky: number; stats: { misses: number; hits: number }; pixels: number } {
  const W = 160, H = 120;
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(skyPalette());
  if (opts.tex) r.setSkyTexture(opts.tex);
  const sky = r.testSkyIndex();
  r.beginFrame();
  const st = r.renderView(
    {
      origin: new Float32Array([0, 0, 30]), angles: new Float32Array([0, 0, 0]),
      fovX: 90, time: opts.time ?? 0, lightStyles: new Float32Array(256).fill(1),
    },
    { name: 'sky', data: skyWorld(fnX) },
    [],
  );
  r.endFrame();
  const c = r.testCacheStats();
  return { idx: fb.index!, sky, stats: { misses: c.misses, hits: c.hits }, pixels: st.pixels };
}

/** 64x384 packed strip (tile 64x64): tile f flat-filled with 10+f*20. */
function stripTexture(): { texels: Uint8Array; width: number; height: number } {
  const tile = 64;
  const texels = new Uint8Array(tile * tile * 6);
  for (let f = 0; f < 6; f++) texels.fill(10 + f * 20, f * tile * tile, (f + 1) * tile * tile);
  return { texels, width: tile, height: tile * 6 };
}

function fnv(idx: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < idx.length; i++) {
    h ^= idx[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

describe('sky surfaces (SURF_SKY)', () => {
  it('picks the bluest palette entry as the flat-sky index', () => {
    const fb = createFramebuffer(8, 8, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(skyPalette());
    expect(r.testSkyIndex()).toBe(200);
  });

  it('renders as one flat index: no texture, no cache, no edge lines', () => {
    const { idx, sky, stats, pixels } = renderSky(-1);
    expect(sky).toBe(200);
    expect(pixels).toBeGreaterThan(160 * 120 * 0.4);
    // every drawn pixel is the same flat index (background 0 elsewhere)
    expect(new Set(idx)).toEqual(new Set([0, 200]));
    // sky bypasses the surface cache entirely (was: orange fallback blocks)
    expect(stats.misses).toBe(0);
    expect(stats.hits).toBe(0);
  });

  it('is exempt from backface culling (outward hull normals still draw)', () => {
    const inward = renderSky(-1);
    const outward = renderSky(1);
    const count = (idx: Uint8Array): number => {
      let n = 0;
      for (let i = 0; i < idx.length; i++) if (idx[i] === 200) n++;
      return n;
    };
    expect(count(outward.idx)).toBeGreaterThan(160 * 120 * 0.4);
    expect(count(outward.idx)).toBe(count(inward.idx));
  });

  it('per-span flat color is identical across classic / banded / wasm backends', () => {
    const W = 64, H = 48;
    const colormap = buildColormap(defaultPalette());
    const spans = [];
    for (let y = 0; y < H; y += 3) {
      const s = createSpan();
      s.kind = SPAN_FLAT;
      s.y = y; s.x0 = 2; s.x1 = W - 2;
      s.iz = 0.05; s.diz = 0;
      s.light = 200; s.dlight = 0;
      spans.push(s);
    }
    const list: SpanList = { spans, count: spans.length };
    const dummyTex = { width: 4, height: 4, texels: new Uint8Array(16) };
    const dummyLight = { width: 1, height: 1, values: new Uint8Array([63]) };
    const refIdx = new Uint8Array(W * H);
    const refZb = new Float32Array(W * H);
    const be = new SoftwareBackend();
    be.attach(refIdx, refZb, W, H, colormap);
    be.drawSpans(list, dummyTex, dummyLight);
    expect(be.spansDrawn).toBe(spans.length);
    // every span row is the flat color
    for (let y = 0; y < H; y += 3) {
      for (let x = 2; x < W - 2; x++) expect(refIdx[y * W + x]).toBe(200);
    }
    for (const bands of [1, 2, 4]) {
      const bIdx = new Uint8Array(W * H);
      const bZb = new Float32Array(W * H);
      const bb = new BandedSoftwareBackend();
      bb.attach(bIdx, bZb, W, H, colormap);
      bb.setBandCount(bands);
      bb.drawSpans(list, dummyTex, dummyLight);
      expect([...bIdx]).toEqual([...refIdx]);
      expect([...bZb]).toEqual([...refZb]);
    }
    const wb = WasmSpanBackend.create(W, H);
    if (wb) {
      wb.attach(new Uint8Array(0), new Float32Array(0), W, H, colormap);
      wb.drawSpans(list, dummyTex, dummyLight);
      expect([...wb.idx]).toEqual([...refIdx]);
      expect([...wb.zb]).toEqual([...refZb]);
    }
    // standalone per-span helper agrees with the backend dispatch
    const dIdx = new Uint8Array(W * H);
    const dZb = new Float32Array(W * H);
    const d = drawSpansFlatPerSpan(dIdx, dZb, W, H, list);
    expect(d.spans).toBe(spans.length);
    expect([...dIdx]).toEqual([...refIdx]);
  });

  it('pack/processBandJob carries flat spans bit-identically', () => {    const W = 64, H = 32;
    const colormap = buildColormap(defaultPalette());
    const spans = [];
    for (let y = 0; y < H; y++) {
      const s = createSpan();
      s.kind = SPAN_FLAT;
      s.y = y; s.x0 = 0; s.x1 = W;
      s.iz = 0.02 + y * 0.0001; s.diz = 0.00001;
      s.light = 150 + (y % 3); s.dlight = 0;
      spans.push(s);
    }
    const list: SpanList = { spans, count: spans.length };
    const dummyTex = { width: 4, height: 4, texels: new Uint8Array(16) };
    const dummyLight = { width: 1, height: 1, values: new Uint8Array([63]) };
    const refIdx = new Uint8Array(W * H);
    const refZb = new Float32Array(W * H);
    const be = new SoftwareBackend();
    be.attach(refIdx, refZb, W, H, colormap);
    be.drawSpans(list, dummyTex, dummyLight);
    const sab = new SharedArrayBuffer(bandTotal(W, H));
    const { views } = attachBandShared(sab, W, H);
    const pk = packBandSpans(list, views.spansF, views.spansI);
    expect(pk).not.toBeNull();
    expect(pk!.count).toBe(spans.length);
    views.colormap.set(colormap);
    const base = {
      fbW: W, fbH: H, count: pk!.count,
      texW: 4, texH: 4, lightW: 1, lightH: 1,
      wshift: 2, wmask: 3, hmask: 3, turbPhase: 0,
    };
    for (const b of splitBands(H, 4)) {
      processBandJob(views, { ...base, y0: b.y0, y1: b.y1 });
    }
    expect([...views.idx.subarray(0, W * H)]).toEqual([...refIdx]);
    expect([...views.zb.subarray(0, W * H)]).toEqual([...refZb]);
  });
});

describe('textured skybox (setSkyTexture, ref_soft R_EmitSkyBox/D_SkySurf)', () => {
  it('textured sky differs from the flat fill (golden/hash assertion)', () => {
    const tex = stripTexture();
    const flat = renderSky(-1);
    const textured = renderSky(-1, { tex });
    expect(fnv(textured.idx)).not.toBe(fnv(flat.idx));
    // The test quad sits at +X: every ray hits box face 4 (rt = tile 0),
    // flat-filled with index 10, unlit (grade-63 identity, no lightmap).
    let tile = 0, flatLeft = 0;
    for (let i = 0; i < textured.idx.length; i++) {
      if (textured.idx[i] === 10) tile++;
      if (textured.idx[i] === flat.sky) flatLeft++;
    }
    expect(tile).toBeGreaterThan(160 * 120 * 0.4);
    expect(flatLeft).toBe(0);
    // Sky spans still bypass the surface cache when textured.
    expect(textured.stats.misses).toBe(0);
    expect(textured.stats.hits).toBe(0);
  });

  it('is stable across frames and view time (ref_soft has no sky scroll)', () => {
    const tex = stripTexture();
    const a = renderSky(-1, { tex, time: 0 });
    const b = renderSky(-1, { tex, time: 37.2 });
    expect(fnv(a.idx)).toBe(fnv(b.idx));
    expect([...a.idx]).toEqual([...b.idx]);
  });

  it('rejects bad strips and clears back to the flat fill', () => {
    const W = 160, H = 120;
    const mk = (tex: { texels: Uint8Array; width: number; height: number } | null) => {
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(skyPalette());
      r.setSkyTexture(tex);
      r.beginFrame();
      r.renderView(
        {
          origin: new Float32Array([0, 0, 30]), angles: new Float32Array([0, 0, 0]),
          fovX: 90, time: 0, lightStyles: new Float32Array(256).fill(1),
        },
        { name: 'sky', data: skyWorld(-1) },
        [],
      );
      r.endFrame();
      return fnv(fb.index!);
    };
    const flat = renderSky(-1);
    // Non-POT width, non-multiple-of-6 height, length mismatch, null.
    expect(mk({ texels: new Uint8Array(100 * 60), width: 100, height: 60 })).toBe(fnv(flat.idx));
    expect(mk({ texels: new Uint8Array(64 * 65), width: 64, height: 65 })).toBe(fnv(flat.idx));
    expect(mk({ texels: new Uint8Array(10), width: 64, height: 384 })).toBe(fnv(flat.idx));
    expect(mk(null)).toBe(fnv(flat.idx));
    // And a valid strip takes effect again afterwards (sticky-null check).
    expect(mk(stripTexture())).toBe(fnv(renderSky(-1, { tex: stripTexture() }).idx));
  });
});

describe('skybox mapping units (id r_rast.c box faces)', () => {
  it('dominant axis picks the id face', () => {
    expect(skyFaceForDir(5, 1, 1)).toBe(4); // +X rt
    expect(skyFaceForDir(-5, 1, 1)).toBe(1); // -X lf
    expect(skyFaceForDir(1, 5, 1)).toBe(3); // +Y bk
    expect(skyFaceForDir(1, -5, 1)).toBe(5); // -Y ft
    expect(skyFaceForDir(1, 1, 5)).toBe(2); // +Z up
    expect(skyFaceForDir(1, 1, -5)).toBe(0); // -Z dn
  });

  it('face centers land mid-tile with the r_skysideimage permutation', () => {
    expect(SKY_TILE_SUFFIXES).toEqual(['rt', 'bk', 'lf', 'ft', 'up', 'dn']);
    expect(SKY_SIDE_IMAGE).toEqual([5, 2, 4, 1, 0, 3]);
    const out = { u: 0, v: 0 };
    const tile = 64;
    // +X center -> face 4 -> tile SKY_SIDE_IMAGE[4] = 0 (rt), mid-texel.
    skyUvForDir(1, 0, 0, tile, tile, out);
    expect(out.u).toBeCloseTo(32, 6);
    expect(out.v).toBeCloseTo(32, 6);
    // +Z center -> face 2 -> tile 4 (up), rows [256, 320).
    skyUvForDir(0, 0, 1, tile, tile, out);
    expect(out.u).toBeCloseTo(32, 6);
    expect(out.v).toBeCloseTo(4 * tile + 32, 6);
    // -Y center -> face 5 -> tile 3 (ft), rows [192, 256).
    skyUvForDir(0, -1, 0, tile, tile, out);
    expect(out.v).toBeGreaterThanOrEqual(3 * tile);
    expect(out.v).toBeLessThan(4 * tile);
  });

  it('validates strip sizes for the affine sampler', () => {
    expect(isValidSkySize(256, 1536)).toBe(true);
    expect(isValidSkySize(64, 384)).toBe(true);
    expect(isValidSkySize(100, 600)).toBe(false); // non-POT width
    expect(isValidSkySize(64, 385)).toBe(false); // not a multiple of 6
    expect(isValidSkySize(0, 0)).toBe(false);
  });
});
