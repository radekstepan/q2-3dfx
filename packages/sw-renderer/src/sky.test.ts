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
import { setupCamera } from './camera.js';
import {
  SKY_BOX_CORNERS, SKY_BOX_HALF, SKY_SIDE_IMAGE, SKY_TILE_SUFFIXES,
  isValidSkySize, skyFaceForDir, skyUvForDir, skyUvOnFace,
} from './sky.js';
import { SoftwareBackend } from './spans.js';
import { WasmSpanBackend } from './wasmSpans.js';
import { buildColormap, defaultPalette } from './colormap.js';
import { readFileSync } from 'fs';
import { loadBsp } from '@q2/bsp';
import { parsePCX, parseWAL } from '@q2/formats';
import { bspToMiniWorld, type BspTexelSource } from './index.js';
import { v3 } from '@q2/math';

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

  it('corner-spanning polys sample the geometrically correct face per pixel', () => {
    // A world sky quad straddling the +X/+Z box edge. With flat tiles the
    // correct output is fully determined: every rendered pixel must carry
    // the tile of the box face its camera ray actually pierces (id
    // R_EmitSkyBox rasterises the 6 faces separately, so span interpolation
    // can never sweep across tile boundaries). Single-face centroid
    // fan-triangulation smears whole triangles with the wrong tile instead.
    const tex = stripTexture();
    // Wall at x=40 spanning y in [-120,30]: its on-screen part is pierced
    // only by +X (face 4/rt) rays, but the fan triangle (v0,v2,v3) has its
    // centroid deep in -Y (face 5/ft) land, so centroid sampling paints the
    // whole on-screen fragment with the wrong tile.
    const verts = new Float32Array([40, -120, 0, 40, 30, 0, 40, 30, 60, 40, -120, 60]);
    const world: MiniWorld = {
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
        center: new Float32Array([40, -45, 30]), radius: 120,
        mins: new Float32Array([40, -120, 0]), maxs: new Float32Array([40, 30, 60]),
        turbulent: false, sky: true,
        fn: new Float32Array([0, 1, 0]),
      }],
      textures: [{ texels: new Uint8Array(16).fill(7), width: 4, height: 4 }],
      lightmaps: [{ samples: new Uint8Array([128, 128, 128]), luxW: 1, luxH: 1, styles: [0] }],
      dynamicLights: [],
      alias: [],
      sprites: [],
      particles: [],
    };
    const W = 160, H = 120;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(skyPalette());
    r.setSkyTexture(tex);
    const origin = new Float32Array([0, 0, 30]);
    const angles = new Float32Array([0, 0, 0]);
    r.beginFrame();
    r.renderView(
      { origin, angles, fovX: 90, time: 0, lightStyles: new Float32Array(256).fill(1) },
      { name: 'sky-corner', data: world },
      [],
    );
    r.endFrame();
    // Expected tile per pixel from the camera ray. Pixels whose center ray
    // lands within half a pixel of a box edge may rasterise from the
    // neighbour face, so the 4-neighbour rays are accepted too — but a
    // wrong-face triangle is dozens of pixels wide and matches neither.
    const cam = setupCamera(origin, angles, 90, W, H);
    const rayTile = (px: number, py: number): number => {
      const vx = (px - cam.xCenter) / cam.focalX;
      const vy = -(py - cam.yCenter) / cam.focalY;
      const dx = cam.right[0]! * vx + cam.up[0]! * vy + cam.forward[0]!;
      const dy = cam.right[1]! * vx + cam.up[1]! * vy + cam.forward[1]!;
      const dz = cam.right[2]! * vx + cam.up[2]! * vy + cam.forward[2]!;
      return SKY_SIDE_IMAGE[skyFaceForDir(dx, dy, dz)]!;
    };
    let checked = 0, strict = 0;
    const bad: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const got = fb.index![y * W + x]!;
        if (got === 0) continue; // occluded background (none in this world)
        checked++;
        const want = 10 + rayTile(x + 0.5, y + 0.5) * 20;
        if (got === want) {
          strict++;
          continue;
        }
        const near: number[] = [want];
        if (x > 0) near.push(10 + rayTile(x - 0.5, y + 0.5) * 20);
        if (x + 1 < W) near.push(10 + rayTile(x + 1.5, y + 0.5) * 20);
        if (y > 0) near.push(10 + rayTile(x + 0.5, y - 0.5) * 20);
        if (y + 1 < H) near.push(10 + rayTile(x + 0.5, y + 1.5) * 20);
        if (!near.includes(got) && bad.length < 8) bad.push((y * W + x) | 0);
      }
    }
    expect(checked).toBeGreaterThan(160 * 120 * 0.2);
    expect(bad).toEqual([]);
    expect(strict / checked).toBeGreaterThan(0.99);
  });

  it('is stable across frames and view time (ref_soft has no sky scroll)', () => {
    const tex = stripTexture();
    const a = renderSky(-1, { tex, time: 0 });
    const b = renderSky(-1, { tex, time: 37.2 });
    expect(fnv(a.idx)).toBe(fnv(b.idx));
    expect([...a.idx]).toEqual([...b.idx]);
  });

  it('rejects bad strips and clears back to the flat fill', () => {    const W = 160, H = 120;
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

  it('pins the textured-sky golden hash (asset-free)', () => {
    const textured = renderSky(-1, { tex: stripTexture() });
    expect(fnv(textured.idx)).toBe('9a87c5c5');
  });
});

/** Six sky quads forming a room around the camera (all SURF_SKY). */
function skyRoomWorld(): MiniWorld {
  const quads: number[][] = [
    [40, -40, 0, 40, 40, 0, 40, 40, 60, 40, -40, 60], // +X
    [-40, 40, 0, -40, -40, 0, -40, -40, 60, -40, 40, 60], // -X
    [-40, 40, 0, 40, 40, 0, 40, 40, 60, -40, 40, 60], // +Y
    [40, -40, 0, -40, -40, 0, -40, -40, 60, 40, -40, 60], // -Y
    [-40, -40, 70, 40, -40, 70, 40, 40, 70, -40, 40, 70], // +Z
    [-40, 40, -10, 40, 40, -10, 40, -40, -10, -40, -40, -10], // -Z
  ];
  const surfaces = quads.map((q, i) => {
    const verts = new Float32Array(q);
    const mins = new Float32Array([Infinity, Infinity, Infinity]);
    const maxs = new Float32Array([-Infinity, -Infinity, -Infinity]);
    const center = new Float32Array(3);
    for (let k = 0; k < 4; k++) {
      for (let a = 0; a < 3; a++) {
        const v = verts[k * 3 + a]!;
        if (v < mins[a]!) mins[a] = v;
        if (v > maxs[a]!) maxs[a] = v;
        center[a]! += v / 4;
      }
    }
    const dx = maxs[0]! - center[0]!, dy = maxs[1]! - center[1]!, dz = maxs[2]! - center[2]!;
    return {
      id: i, verts,
      uvs: new Float32Array([0, 0, 64, 0, 64, 64, 0, 64]),
      lux: new Float32Array([0, 0, 4, 0, 4, 4, 0, 4]),
      n: 4, texId: 0, lightId: 0,
      center, radius: Math.hypot(dx, dy, dz), mins, maxs,
      turbulent: false, sky: true,
      fn: new Float32Array([0, 0, 1]),
    };
  });
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [{ cluster: 0, firstSurf: 0, numSurfs: surfaces.length }],
    pvs: [new Uint8Array([1])],
    clusterCount: 1,
    surfaces,
    textures: [{ texels: new Uint8Array(16).fill(7), width: 4, height: 4 }],
    lightmaps: [{ samples: new Uint8Array([128, 128, 128]), luxW: 1, luxH: 1, styles: [0] }],
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
}

describe('textured skybox all-6-faces (SKY_SIDE_IMAGE)', () => {
  /** Axis view per box face: [label, angles, face]. */
  const FACES: Array<[string, number[], number]> = [
    ['+X rt', [0, 0, 0], 4],
    ['+Y bk', [0, 90, 0], 3],
    ['-X lf', [0, 180, 0], 1],
    ['-Y ft', [0, 270, 0], 5],
    ['+Z up', [-90, 0, 0], 2],
    ['-Z dn', [90, 0, 0], 0],
  ];
  it('each axis view is covered by its SKY_SIDE_IMAGE tile', () => {
    const tex = stripTexture();
    const W = 160, H = 120;
    for (const [, angles, face] of FACES) {
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(skyPalette());
      r.setSkyTexture(tex);
      r.beginFrame();
      r.renderView(
        {
          origin: new Float32Array([0, 0, 30]), angles: new Float32Array(angles),
          fovX: 90, time: 0, lightStyles: new Float32Array(256).fill(1),
        },
        { name: 'sky-room', data: skyRoomWorld() },
        [],
      );
      r.endFrame();
      const want = 10 + SKY_SIDE_IMAGE[face]! * 20;
      const idx = fb.index!;
      // Center ray is exactly the face normal: exact tile, no tolerance.
      expect(idx[(H >> 1) * W + (W >> 1)]).toBe(want);
      let hit = 0, flat = 0;
      for (let i = 0; i < idx.length; i++) {
        if (idx[i] === want) hit++;
        if (idx[i] === 200) flat++;
      }
      // The facing box face fills the whole 90-degree frustum (corner rays
      // stay dominant-axis); only edge rasterisation may wobble.
      expect(hit / idx.length).toBeGreaterThan(0.99);
      expect(flat).toBe(0);
    }
  });

  it('pins the all-faces room hash at the +X view (asset-free)', () => {
    const W = 160, H = 120;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(skyPalette());
    r.setSkyTexture(stripTexture());
    r.beginFrame();
    r.renderView(
      {
        origin: new Float32Array([0, 0, 30]), angles: new Float32Array([0, 0, 0]),
        fovX: 90, time: 0, lightStyles: new Float32Array(256).fill(1),
      },
      { name: 'sky-room', data: skyRoomWorld() },
      [],
    );
    r.endFrame();
    expect(fnv(fb.index!)).toBe('9a87c5c5');
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

  it('adjacent faces meet at shared edges (continuity, no tile bleed)', () => {
    // Inverts the box mapping back to 3D: tile texel (u,v) on face f is the
    // box point 128*N + S*a + T*b with a/b from the normalized texel. Both
    // faces sharing an edge must invert to the SAME 3D point (up to the
    // 1/256-texel clamp epsilon) — a flipped axis/sign would land on the
    // wrong edge and open a visible seam under real art. UVs must also stay
    // inside their own tile for every direction (clamped, never bleeding).
    const sAxis = [
      [0, -1, 0], [0, 1, 0], [0, -1, 0], [1, 0, 0], [0, -1, 0], [-1, 0, 0],
    ];
    const tAxis = [
      [-1, 0, 0], [0, 0, -1], [1, 0, 0], [0, 0, -1], [0, 0, -1], [0, 0, -1],
    ];
    const normal = [
      [0, 0, -1], [-1, 0, 0], [0, 0, 1], [0, 1, 0], [1, 0, 0], [0, -1, 0],
    ];
    const invert = (face: number, u: number, v: number, tile: number): number[] => {
      const S = sAxis[face]!, T = tAxis[face]!, N = normal[face]!;
      const strip = SKY_SIDE_IMAGE[face]!;
      const a = ((u / tile) * 2 - 1) * 128;
      const b = (((v - strip * tile) / tile) * 2 - 1) * 128;
      return [
        N[0]! * 128 + S[0]! * a + T[0]! * b,
        N[1]! * 128 + S[1]! * a + T[1]! * b,
        N[2]! * 128 + S[2]! * a + T[2]! * b,
      ];
    };
    const edges: Array<[number, number, number[]]> = [
      [4, 2, [1, 0, 1]], [4, 0, [1, 0, -1]], [4, 3, [1, 1, 0]], [4, 5, [1, -1, 0]],
      [1, 2, [-1, 0, 1]], [1, 0, [-1, 0, -1]], [1, 3, [-1, 1, 0]], [1, 5, [-1, -1, 0]],
      [2, 3, [0, 1, 1]], [2, 5, [0, -1, 1]], [0, 3, [0, 1, -1]], [0, 5, [0, -1, -1]],
    ];
    const out = { u: 0, v: 0 };
    const tile = 64;
    for (const [fa, fb, d] of edges) {
      skyUvOnFace(d[0]!, d[1]!, d[2]!, fa, tile, tile, out);
      const A = invert(fa, out.u, out.v, tile);
      skyUvOnFace(d[0]!, d[1]!, d[2]!, fb, tile, tile, out);
      const B = invert(fb, out.u, out.v, tile);
      const err = Math.hypot(A[0]! - B[0]!, A[1]! - B[1]!, A[2]! - B[2]!);
      expect(err).toBeLessThan(0.1); // clamp epsilon is ~0.02 box units
    }
    // No bleed: a dense direction grid stays inside its selected tile.
    for (let ix = -8; ix <= 8; ix++) {
      for (let iy = -8; iy <= 8; iy++) {
        for (let iz = -8; iz <= 8; iz++) {
          if (ix === 0 && iy === 0 && iz === 0) continue;
          const face = skyFaceForDir(ix, iy, iz);
          skyUvOnFace(ix, iy, iz, face, tile, tile, out);
          const strip = SKY_SIDE_IMAGE[face]!;
          expect(out.u).toBeGreaterThanOrEqual(0);
          expect(out.u).toBeLessThan(tile);
          expect(out.v).toBeGreaterThanOrEqual(strip * tile);
          expect(out.v).toBeLessThan((strip + 1) * tile);
        }
      }
    }
    // Box corners regroup to the same 6 faces (emission table sanity).
    expect(SKY_BOX_CORNERS.length).toBe(6);
    expect(SKY_BOX_HALF).toBe(16384);
    for (let f = 0; f < 6; f++) expect(SKY_BOX_CORNERS[f]!.length).toBe(12);
  });
});

/** Minimal PAK reader (test-only; avoids a @q2/filesystem dependency). */
function pakReadFile(pakPath: string, name: string): ArrayBuffer {
  const data = readFileSync(pakPath);
  if (data.subarray(0, 4).toString() !== 'PACK') throw new Error('not a pak');
  const dirofs = data.readUInt32LE(4);
  const dirlen = data.readUInt32LE(8);
  for (let o = dirofs; o < dirofs + dirlen; o += 64) {
    const entry = data.subarray(o, o + 56).toString().replace(/\0.*$/, '');
    if (entry === name) {
      const off = data.readUInt32LE(o + 56);
      const len = data.readUInt32LE(o + 60);
      return data.buffer.slice(data.byteOffset + off, data.byteOffset + off + len);
    }
  }
  throw new Error(`pak entry missing: ${name}`);
}

describe.runIf(!!process.env.Q2_PAK)('real unit1_ sky over base1 (Q2_PAK)', () => {
  it('logs the real-art sky hash (unpinned first-run record)', { timeout: 300000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    // env/unit1_{rt,bk,lf,ft,up,dn}.pcx packed in suffix order with raw
    // indices (no palette remap — deterministic either way). Skips (logs)
    // when the faces are absent instead of failing.
    let strip: { texels: Uint8Array; width: number; height: number } | null = null;
    try {
      const faces = SKY_TILE_SUFFIXES.map((suf) => parsePCX(pakReadFile(pakPath, `env/unit1_${suf}.pcx`)));
      const w = faces[0]!.width, h = faces[0]!.height;
      if (!faces.every((f) => f.width === w && f.height === h && f.pixels.length === w * h)) {
        throw new Error('mismatched sky faces');
      }
      const texels = new Uint8Array(w * h * 6);
      faces.forEach((f, i) => texels.set(f.pixels.subarray(0, w * h), i * w * h));
      strip = { texels, width: w, height: h * 6 };
    } catch {
      strip = null;
    }
    if (!strip) {
      console.log('SKY-PAK: env/unit1_ faces missing, skipping');
      return;
    }
    const bsp = loadBsp(pakReadFile(pakPath, 'maps/base1.bsp'));
    const walCache = new Map<string, BspTexelSource | null>();
    const texelFor = (walName: string): BspTexelSource | null => {
      if (walCache.has(walName)) return walCache.get(walName)!;
      let src: BspTexelSource | null = null;
      try {
        const wal = parseWAL(pakReadFile(pakPath, `textures/${walName}.wal`));
        src = { texels: wal.mips[0]!, width: wal.width, height: wal.height };
      } catch { src = null; }
      walCache.set(walName, src);
      return src;
    };
    const world = bspToMiniWorld(bsp, { texelFor });
    const pcx = parsePCX(pakReadFile(pakPath, 'pics/colormap.pcx'));
    const W = 320, H = 240;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(pcx.palette);
    r.setSkyTexture(strip);
    r.beginFrame();
    const stats = r.renderView(
      {
        origin: v3(128, -320, 54), angles: v3(0, 90, 0), fovX: 90, time: 1.5,
        lightStyles: new Float32Array(256).fill(1),
      },
      { name: 'base1', data: world },
      [],
    );
    r.endFrame();
    // Unpinned by design: first run records the hash, later runs eyeball it.
    console.log(`SKY-PAK base1 spawn-north with unit1_ strip: hash=${fnv(fb.index!)} spans=${stats.spans} pixels=${stats.pixels}`);
    expect(stats.pixels).toBeGreaterThan(W * H * 0.15);
  });

  it('yaw sweep at spawn: no clear-black sky frames (M7.2 sky-black pin)', { timeout: 300000 }, () => {
    // Headless repro for the base1-play report "sky turns completely black
    // at certain view angles": sweep yaw 0-360 at the spawn-area viewpoint
    // with the original unit1_ 6-tile strip and require the textured box to
    // cover every pixel where the flat path shows sky. A missing face (clear
    // color showing through) fails; genuinely-black art texels keep depth
    // (zb > 0) and pass. Skips cleanly without Q2_PAK via describe.runIf.
    const pakPath = process.env.Q2_PAK as string;
    let strip: { texels: Uint8Array; width: number; height: number } | null = null;
    try {
      const faces = SKY_TILE_SUFFIXES.map((suf) => parsePCX(pakReadFile(pakPath, `env/unit1_${suf}.pcx`)));
      const w = faces[0]!.width, h = faces[0]!.height;
      if (!faces.every((f) => f.width === w && f.height === h && f.pixels.length === w * h)) {
        throw new Error('mismatched sky faces');
      }
      const texels = new Uint8Array(w * h * 6);
      faces.forEach((f, i) => texels.set(f.pixels.subarray(0, w * h), i * w * h));
      strip = { texels, width: w, height: h * 6 };
    } catch {
      console.log('SKY-PAK: env/unit1_ faces missing, skipping');
      return;
    }
    const bsp = loadBsp(pakReadFile(pakPath, 'maps/base1.bsp'));
    const walCache = new Map<string, BspTexelSource | null>();
    const texelFor = (walName: string): BspTexelSource | null => {
      if (walCache.has(walName)) return walCache.get(walName)!;
      let src: BspTexelSource | null = null;
      try {
        const wal = parseWAL(pakReadFile(pakPath, `textures/${walName}.wal`));
        src = { texels: wal.mips[0]!, width: wal.width, height: wal.height };
      } catch { src = null; }
      walCache.set(walName, src);
      return src;
    };
    const world = bspToMiniWorld(bsp, { texelFor });
    const pcx = parsePCX(pakReadFile(pakPath, 'pics/colormap.pcx'));
    const W = 160, H = 120;
    const eye = v3(128, -320, 54);
    const styles = new Float32Array(256).fill(1);
    let clearBlack = 0;
    let skyPixels = 0;
    // Yaw 0-360 plus look-up pitches: the spawn room shows sky through its
    // open top at pitch <= -45, which is exactly the "certain view angles"
    // of the report.
    for (const pitch of [0, -30, -45, -60, -89]) {
    for (let yaw = 0; yaw < 360; yaw += 10) {
      const angles = v3(pitch, yaw, 0);
      const flatFb = createFramebuffer(W, H, true);
      const rf = new SoftwareRenderer();
      rf.init(flatFb);
      rf.setPalette(pcx.palette);
      rf.beginFrame();
      rf.renderView(
        { origin: eye, angles, fovX: 90, time: 1.5, lightStyles: styles },
        { name: 'base1', data: world },
        [],
      );
      rf.endFrame();
      const skyIdx = rf.testSkyIndex();
      const flat = flatFb.index!;
      const tFb = createFramebuffer(W, H, true);
      const rt = new SoftwareRenderer();
      rt.init(tFb);
      rt.setPalette(pcx.palette);
      rt.setSkyTexture(strip);
      rt.beginFrame();
      rt.renderView(
        { origin: eye, angles, fovX: 90, time: 1.5, lightStyles: styles },
        { name: 'base1', data: world },
        [],
      );
      rt.endFrame();
      const tex = tFb.index!, zb = tFb.depth;
      for (let i = 0; i < flat.length; i++) {
        if (flat[i] !== skyIdx) continue;
        skyPixels++;
        // Clear color showing through = the box failed to cover a pixel the
        // world sky poly covered (wrongful face cull / missing emission).
        // Black ART keeps depth and is not counted here.
        if (tex[i] === 0 && zb[i] === 0) clearBlack++;
      }
    }
    }
    console.log(`SKY-PAK yaw sweep at spawn: skyPixels=${skyPixels} clearBlack=${clearBlack}`);
    expect(skyPixels).toBeGreaterThan(0); // the sweep actually sees sky
    expect(clearBlack).toBe(0); // ...and none of it is ever clear color
  });
});
