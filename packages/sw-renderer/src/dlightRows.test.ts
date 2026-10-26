// M3.2 dlight row-striping repro: luxel grid must match C CalcSurfaceExtents.
//
// Firing the blaster at a floor lit whole tile-rows while neighbors stayed
// dark instead of a radial disc. Root cause: bspToMiniWorld sized the luxel
// grid as floor(span/16)+1, but id CalcSurfaceExtents (r_model.c) uses
// floor(min/16)..ceil(max/16) with extents forced to >= 16 texels. On
// unaligned faces that truncated/misaligned the grid, so the lighting-lump
// slice row-shifted every static luxel after the first row and cut the far
// row/col off the dynamic per-luxel falloff grid. The synthetic quad below
// has texture coords deliberately off the 16-grid (like real base1 faces),
// with C-laid-out row-banded lighting: any grid deviation shows up as
// non-uniform screen rows (before the fix: 5x5 slice of a 6x6 layout, row 1
// reads the tail of C row 0). The base1 test pins all 7663 renderable faces
// against the C formula (skips cleanly without Q2_PAK).
import { describe, expect, it } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import { readFileSync } from 'fs';
import { loadBsp, FACE_STRIDE } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { SoftwareRenderer } from './frame.js';
import { bspToMiniWorld, SURF_NODRAW } from './bspWorld.js';

/** C layout under test: 6x6 luxels, row-banded R=G=B=t*36 (t = C row). */
const CW = 6, CH = 6;
function cLighting(): Uint8Array {
  const s = new Uint8Array(CW * CH * 3);
  for (let t = 0; t < CH; t++) {
    for (let w = 0; w < CW; w++) {
      const v = t * 36;
      const o = (t * CW + w) * 3;
      s[o] = v; s[o + 1] = v; s[o + 2] = v;
    }
  }
  return s;
}

/**
 * Minimal one-quad BspMap: x/y in [0,64] at z=0, texinfo u=x+5.3 / v=y+2.1
 * (deliberately off the 16-grid: C gives 6x6, the old formula gave 5x5),
 * lighting laid out exactly like the C engine (row width 6).
 */
function fakeQuadMap(): BspMap {
  const F = (a: number[]) => new Int32Array(a);
  return {
    planes: new Float32Array([0, 0, 1, 0]),
    nodes: new Int32Array(0),
    leafs: F([0, 0, 0, 0, 0, -8, 64, 64, 8, 0, 1, 0, 0]),
    faces: F([0, 0, 0, 4, 0, 0, 255, 255, 255, 0]),
    raw: new ArrayBuffer(8),
    planeTypes: F([2]),
    vertexes: new Float32Array([0, 0, 0, 64, 0, 0, 64, 64, 0, 0, 64, 0]),
    visibility: new Uint8Array(0),
    numClusters: 0,
    visBitofs: F([]),
    nodeMins: new Int16Array(0),
    nodeMaxs: new Int16Array(0),
    texinfoVecs: new Float32Array([1, 0, 0, 5.3, 0, 1, 0, 2.1]),
    texinfoFlags: F([0]),
    texinfoValue: F([0]),
    texinfoNext: F([0]),
    texinfoNames: ['fake/test'],
    lighting: cLighting(),
    leaffaces: new Uint16Array([0]),
    leafbrushes: new Uint16Array(0),
    edges: new Uint16Array([0, 1, 1, 2, 2, 3, 3, 0]),
    surfedges: F([0, 1, 2, 3]),
    modelsMins: new Float32Array(0),
    modelsMaxs: new Float32Array(0),
    modelsOrigin: new Float32Array(0),
    modelsExtra: F([]),
    brushes: F([]),
    brushsides: F([]),
    entities: '',
    pop: new Uint8Array(0),
    areas: F([]),
    areaportals: F([]),
  } as BspMap;
}

const flatTexelFor = () => ({ texels: new Uint8Array(64 * 64).fill(200), width: 64, height: 64 });
const greyPalette = (): Uint8Array => {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) { pal[i * 3] = i; pal[i * 3 + 1] = i; pal[i * 3 + 2] = i; }
  return pal;
};
const topDownView = (time = 0) => ({
  origin: new Float32Array([32, 32, 200]),
  angles: new Float32Array([90, 90, 0]),
  fovX: 90, time,
  lightStyles: new Float32Array(256).fill(1),
});

function renderQuad(light?: { origin: number[]; intensity: number }): { base: Uint8Array; lit: Uint8Array; W: number; H: number } {
  const world = { name: 'fakequad', data: bspToMiniWorld(fakeQuadMap(), { texelFor: flatTexelFor }) };
  const W = 320, H = 240;
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(greyPalette());
  const view = topDownView();
  r.beginFrame();
  r.renderView(view, world, []);
  r.endFrame();
  const base = fb.index!.slice();
  if (light) {
    r.testAddDynamicLight({
      origin: new Float32Array(light.origin),
      intensity: light.intensity,
      color: new Float32Array([1, 1, 1]),
    }, 99);
    r.beginFrame();
    r.renderView(view, world, []);
    r.endFrame();
  }
  return { base, lit: fb.index!.slice(), W, H };
}

/** Screen bbox of quad pixels (nonzero index), for analysis. */
function quadBox(idx: Uint8Array, W: number, H: number): { x0: number; x1: number; y0: number; y1: number } {
  let x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (idx[y * W + x]! !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x0, x1, y0, y1 };
}

describe('dlight row striping (luxel grid vs C)', () => {
  it('conversion matches the C 6x6 layout byte-for-byte', () => {
    const world = bspToMiniWorld(fakeQuadMap(), { texelFor: flatTexelFor });
    expect(world.surfaces).toHaveLength(1);
    const lm = world.lightmaps[0]!;
    // id CalcSurfaceExtents: u in [5.3,69.3] -> 0..5 -> 6; v in [2.1,66.1] -> 6.
    expect(lm.luxW).toBe(CW);
    expect(lm.luxH).toBe(CH);
    expect([...lm.samples]).toEqual([...cLighting()]);
  });

  it('static light bands render as uniform rows (no row striping)', () => {
    const { base: idx, W, H } = renderQuad();
    const box = quadBox(idx, W, H);
    expect(box.x1 - box.x0).toBeGreaterThan(30);
    expect(box.y1 - box.y0).toBeGreaterThan(30);
    // Interior rows: every pixel of a row shares one luxel row -> uniform.
    const x0 = box.x0 + 8, x1 = box.x1 - 8;
    const rowMeans: number[] = [];
    for (let y = box.y0 + 4; y <= box.y1 - 4; y++) {
      let mn = 255, mx = 0, sum = 0, n = 0;
      for (let x = x0; x <= x1; x++) {
        const v = idx[y * W + x]!;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sum += v; n++;
      }
      // A row-shifted slice mixes two C rows inside one screen row.
      expect(mx - mn).toBeLessThanOrEqual(1);
      rowMeans.push(sum / n);
    }
    // Row-banded input (t*36): bands must actually show up.
    const lo = Math.min(...rowMeans), hi = Math.max(...rowMeans);
    expect(hi - lo).toBeGreaterThan(10);
  });

  it('blaster disc is radial: unimodal rows, bright center, dark corners', () => {
    const { base, lit, W, H } = renderQuad({ origin: [32, 32, 30], intensity: 120 });
    const box = quadBox(base, W, H);
    const x0 = box.x0 + 8, x1 = box.x1 - 8;
    const y0 = box.y0 + 4, y1 = box.y1 - 4;
    const rows: number[] = [];
    for (let y = y0; y <= y1; y++) {
      let sum = 0, n = 0;
      for (let x = x0; x <= x1; x++) { sum += lit[y * W + x]! - base[y * W + x]!; n++; }
      rows.push(sum / n);
    }
    const peak = Math.max(...rows);
    // A 120-radius flash 30 above the quad lifts every luxel strongly.
    expect(peak).toBeGreaterThan(25);
    // Radial falloff: the row profile rises to one peak then falls — a dark
    // row inside the disc (striping) would break unimodality.
    const pi = rows.indexOf(peak);
    for (let i = 1; i <= pi; i++) expect(rows[i]).toBeGreaterThanOrEqual(rows[i - 1]! - 3);
    for (let i = pi + 1; i < rows.length; i++) expect(rows[i]).toBeLessThanOrEqual(rows[i - 1]! + 3);
    // Corners of the screen quad are the farthest luxels: dimmest delta.
    const c0 = lit[y0 * W + x0]! - base[y0 * W + x0]!;
    const c1 = lit[y1 * W + x1]! - base[y1 * W + x1]!;
    expect(peak - (c0 + c1) / 2).toBeGreaterThan(8);
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

describe.runIf(!!process.env.Q2_PAK)('base1 luxel grids match C (Q2_PAK)', () => {
  it('every renderable face uses CalcSurfaceExtents dims', { timeout: 120000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const map = loadBsp(pakReadFile(pakPath, 'maps/base1.bsp'));
    const world = bspToMiniWorld(map);
    const nFaces = map.faces.length / FACE_STRIDE;
    const sv = map.texinfoVecs;
    let checked = 0;
    const bad: string[] = [];
    for (let f = 0; f < nFaces; f++) {
      const d = f * FACE_STRIDE;
      const firstedge = map.faces[d + 2]!, numedges = map.faces[d + 3]!, ti = map.faces[d + 4]!;
      if (numedges < 3 || numedges > 64) continue;
      if (((map.texinfoFlags[ti] ?? 0) & SURF_NODRAW) !== 0) continue;
      const s0 = sv[ti * 8]!, s1 = sv[ti * 8 + 1]!, s2 = sv[ti * 8 + 2]!, so = sv[ti * 8 + 3]!;
      const t0 = sv[ti * 8 + 4]!, t1 = sv[ti * 8 + 5]!, t2 = sv[ti * 8 + 6]!, to = sv[ti * 8 + 7]!;
      let minS = Infinity, maxS = -Infinity, minT = Infinity, maxT = -Infinity;
      for (let k = 0; k < numedges; k++) {
        const se = map.surfedges[firstedge + k]!;
        const e = se < 0 ? -se : se;
        const v0 = map.edges[e * 2]!, v1 = map.edges[e * 2 + 1]!;
        const vi = se >= 0 ? v0 : v1;
        const x = map.vertexes[vi * 3]!, y = map.vertexes[vi * 3 + 1]!, z = map.vertexes[vi * 3 + 2]!;
        const u = x * s0 + y * s1 + z * s2 + so, v = x * t0 + y * t1 + z * t2 + to;
        if (u < minS) minS = u;
        if (u > maxS) maxS = u;
        if (v < minT) minT = v;
        if (v > maxT) maxT = v;
      }
      const cw = Math.min(256, Math.max(2, Math.ceil(maxS / 16) - Math.floor(minS / 16) + 1));
      const ch = Math.min(256, Math.max(2, Math.ceil(maxT / 16) - Math.floor(minT / 16) + 1));
      const lm = world.lightmaps[f]!;
      checked++;
      if (lm.luxW !== cw || lm.luxH !== ch) {
        if (bad.length < 5) bad.push(`face ${f}: got ${lm.luxW}x${lm.luxH}, C wants ${cw}x${ch}`);
      }
    }
    expect(checked).toBeGreaterThan(7000);
    expect(bad).toEqual([]);
  });
});
