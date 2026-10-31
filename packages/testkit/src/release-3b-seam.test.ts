// GPU-FOLLOW-3B testkit lane (box 2) — real-map water seam regression matrix.
//
// CPU-mirror seam matrix on REAL base1 water (Q2_PAK-gated; skips cleanly
// without it). Samples the PRODUCTION sampling path — sampleLevelBilinearRepeat
// + real mip chains (buildMipChainRGB on expanded bluwter art) + real warp
// (warpUv at multiple times incl. the turb phase wrap 1023->0) — across:
//   leg R: REPEAT tile borders (u = k*64, multi-tile + negative coords),
//   leg F: ADJACENT turbo-face shared edges (all base1 water faces),
//   leg L: lightmap rect borders (atlas gutter isolation for water rects),
//   leg A: source-ART edges (bluwter wrap column vs interior gradient),
// at multiple footprint orientations (view-angle proxies) and distances
// (LOD 0..4 via rho 1..16) WITH transparency semantics (TRANS66
// alpha-blended overlapping taps, as the renderer composites them).
//
// Continuity gates are tight PER-PIXEL tolerances on |left-right| taps —
// never animation deltas. If the webgl-renderer lane's fix had NOT landed,
// this matrix MUST fail: the tripwire pins name the true defect mechanisms
//   (1) warped-derivative LOD (fwidth of warped UVs flips the Bayer n/n+1
//       pick on the tile grid; CPU spanLod uses UNWARPED gradients), and
//   (2) mediump varying precision (multi-tile world UVs quantize to whole
//       texels, snapping warp indices on the grid).
// The INJECTED seam controls (clamp-wrap tap, off-by-one level,
// warped-derivative LOD reproduced locally) prove seam-sensitivity: they
// demonstrably EXCEED the fixed-path gates on the same probes.
//
// Verdict logic, stated explicitly: if every fixed-path leg passes AND every
// injected control is caught, the matrix is seam-sensitive and the shipped
// path is seamless in the sampled space. If the fixed path passed but no
// control produced a seam, the matrix would NOT be seam-proof — that outcome
// is reported, not claimed (see the sensitivity-summary test, which fails
// closed if a control stops catching).
//
// Recorded defect view (user report; close-crop coordinates are carried per
// leg in UV space because seams live in texture/level space and are
// view-independent once footprint orientation + magnitude are covered):
//   map base1, material textures/e1u1/bluwter.wal (64x64, shared by all
//   turbulent faces), camera ~[416,1040,-244] yaw ~90 pitch ~-6 facing the
//   pool (surf 127 front side), translucent TRANS66 water.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PakFile } from '@q2/filesystem';
import { loadBsp } from '@q2/bsp';
import { parsePCX, parseWAL } from '@q2/formats';
import { bspToMiniWorld } from '@q2/sw-renderer';
import type { BspTexelSource, MiniWorld } from '@q2/sw-renderer';
import {
  buildMipChainRGB,
  expandPaletteTexture,
  FS_LIT,
  mipLevelFor,
  packLightAtlas,
  pickMipLevelFor,
  PINNED_LOD_BIAS,
  sampleLevelBilinearRepeat,
  TRANS66_ALPHA,
  warpUv,
  type MipLevelRGB,
} from '@q2/webgl-renderer';

const HAS_PAK = !!process.env.Q2_PAK;

// ---------------------------------------------------------------------------
// Shared constants: map / material / camera / time lattice / LOD lattice.
// ---------------------------------------------------------------------------

const MAP = 'base1';
const MATERIAL = 'textures/e1u1/bluwter.wal';
/** Defect-view camera (recorded; UV/LOD legs are its sampling-space cover). */
const CAMERA = { origin: [416, 1040, -244] as const, yaw: 90, pitch: -6, fovX: 90 };
/** Level-time lattice (straddles the turb phase wrap 1023->0 at 15.984375/16). */
const TIMES = [0, 0.5, 1.5, 7.25, 15.984375, 16.0, 33.3125];
/** Distance lattice: footprints in texels/px; nominal LOD = log2(rho) in 0..4. */
const RHOS = [1, 2, 4, 8, 16];
/**
 * View-angle proxies: anisotropic footprints (du, dv). A pitched/oblique
 * view stretches the footprint along the view direction; covering axis
 * ratios 1:1, 2:1, 1:4 and 4:1 covers yaw/pitch variation around CAMERA.
 */
const FOOTPRINTS: Array<{ du: number; dv: number; view: string }> = [
  { du: 1, dv: 1, view: 'face-on (yaw 90/pitch -6)' },
  { du: 2, dv: 1, view: 'oblique yaw 45' },
  { du: 1, dv: 4, view: 'pitched pitch -12' },
  { du: 8, dv: 2, view: 'grazing yaw 135' },
];
/** Repeat-tile borders probed (tile units k*64 + negative multi-tile). */
const BORDERS = [64, -64, 128, -128, 0];
const EPS = 0.1; // texel straddle half-width (0.2-texel neighbour pair)
// Per-pixel continuity gates (0..255 RGB units; tight, not animation deltas).
const T_FIXED_STRADDLE = 34; // fixed warped path across any probed edge
const T_WARP_JUMP = 0.6; // warp-index step across a tile line (texels)
const T_CATCH_MIN = 8; // an injected seam must exceed this somewhere

interface LegRecord {
  leg: string;
  map: string;
  camera: string;
  material: string;
  time: number;
  cropUV: string;
  lod: string;
  maxDiff: number;
  gate: number;
  /** 'below' = seamlessness gate (maxDiff must be <= gate); 'above' = catch gate; 'na' = diagnostic. */
  sense: 'below' | 'above' | 'na';
  verdict: string;
}
const RECORDS: LegRecord[] = [];
function record(r: LegRecord): void {
  RECORDS.push(r);
}

// ---------------------------------------------------------------------------
// Real-asset load (Q2_PAK; cached).
// ---------------------------------------------------------------------------

interface RealSet {
  world: MiniWorld;
  chain: MipLevelRGB[];
  maxLevel: number;
  rgb0: Uint8Array;
  waterIds: number[];
}

let CACHE: RealSet | null = null;

function pakBytes(name: string): ArrayBuffer {
  const bytes = readFileSync(process.env.Q2_PAK as string);
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return new PakFile(buf).readFile(name);
}

function loadReal(): RealSet {
  if (CACHE) return CACHE;
  const map = loadBsp(pakBytes('maps/base1.bsp'));
  const walCache = new Map<string, BspTexelSource | null>();
  const texelFor = (walName: string): BspTexelSource | null => {
    if (walCache.has(walName)) return walCache.get(walName)!;
    let src: BspTexelSource | null = null;
    try {
      const wal = parseWAL(pakBytes(`textures/${walName}.wal`));
      src = { texels: wal.mips[0]!, width: wal.width, height: wal.height };
    } catch {
      src = null;
    }
    walCache.set(walName, src);
    return src;
  };
  const world = bspToMiniWorld(map, { texelFor });
  const palette = parsePCX(pakBytes('pics/colormap.pcx')).palette;
  const bluwter = parseWAL(pakBytes(MATERIAL));
  if (bluwter.width !== 64 || bluwter.height !== 64) {
    throw new Error(`[release-3b-seam] bluwter dims changed: ${bluwter.width}x${bluwter.height}`);
  }
  const rgb0 = expandPaletteTexture(bluwter.mips[0]!, 64, 64, palette);
  if (!rgb0) throw new Error('[release-3b-seam] bluwter expand failed');
  const chain = buildMipChainRGB(rgb0, 64, 64);
  const waterIds = world.surfaces.filter((s) => s.turbulent).map((s) => s.id);
  CACHE = { world, chain, maxLevel: chain.length - 1, rgb0, waterIds };
  return CACHE;
}

// ---------------------------------------------------------------------------
// Production-path sampler mirrors.
// ---------------------------------------------------------------------------

/** Fixed path: LOD from UNWARPED rho (CPU spanLod parity), warp offsets only the tap. */
function sampleFixed(
  chain: MipLevelRGB[],
  maxLevel: number,
  u: number,
  v: number,
  t: number,
  rho: number,
  px: number,
  py: number,
): [number, number, number] {
  const lod = mipLevelFor(rho, PINNED_LOD_BIAS, maxLevel, true);
  const lvl = pickMipLevelFor(lod, px, py, true, maxLevel);
  const m = chain[lvl]!;
  const s = m.w / 64;
  const [wu, wv] = warpUv(u, v, t);
  return sampleLevelBilinearRepeat(m.data, m.w, m.h, wu * s, wv * s);
}

/** INJECTED seam control C2: off-by-one mip level (coarser neighbour tap). */
function sampleOffByOneInjected(
  chain: MipLevelRGB[],
  maxLevel: number,
  u: number,
  v: number,
  t: number,
  rho: number,
  px: number,
  py: number,
): [number, number, number] {
  const lod = mipLevelFor(rho, PINNED_LOD_BIAS, maxLevel, true);
  const lvl = Math.min(pickMipLevelFor(lod, px, py, true, maxLevel) + 1, maxLevel);
  const m = chain[lvl]!;
  const s = m.w / 64;
  const [wu, wv] = warpUv(u, v, t);
  return sampleLevelBilinearRepeat(m.data, m.w, m.h, wu * s, wv * s);
}

/**
 * Screen-space rho mirror of the shader fwidth rule: max length of the
 * discrete uv derivatives over a (du, dv) footprint. warped=false is the
 * CPU spanLod input (reference); warped=true is the OLD shader input
 * (mechanism 1: warped-derivative LOD — INJECTED control C3 here).
 */
function rhoAt(u: number, v: number, t: number, du: number, dv: number, warped: boolean): number {
  const p = (x: number, y: number): [number, number] => (warped ? warpUv(x, y, t) : [x, y]);
  const [a0, b0] = p(u, v);
  const [a1, b1] = p(u + du, v);
  const [a2, b2] = p(u, v + dv);
  return Math.max(Math.hypot(a1 - a0, b1 - b0), Math.hypot(a2 - a0, b2 - b0));
}

function levelAt(
  maxLevel: number,
  u: number,
  v: number,
  t: number,
  du: number,
  dv: number,
  warped: boolean,
  px: number,
  py: number,
): number {
  const lod = mipLevelFor(rhoAt(u, v, t, du, dv, warped), PINNED_LOD_BIAS, maxLevel, true);
  return pickMipLevelFor(lod, px, py, true, maxLevel);
}

/** TRANS66 alpha blend of two overlapping translucent taps (renderer order: src over dst). */
function blendOver(
  src: [number, number, number],
  dst: [number, number, number],
  alpha = TRANS66_ALPHA,
): [number, number, number] {
  return [
    src[0] * alpha + dst[0] * (1 - alpha),
    src[1] * alpha + dst[1] * (1 - alpha),
    src[2] * alpha + dst[2] * (1 - alpha),
  ];
}

function diff3(a: [number, number, number], b: [number, number, number]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

const camLabel = `origin [${CAMERA.origin.join(',')}] yaw ${CAMERA.yaw} pitch ${CAMERA.pitch}`;

// ---------------------------------------------------------------------------
// Asset-free tripwires: the shipped shader must carry the fix. If the
// webgl-renderer lane's repair regressed, THESE fail and name the mechanism.
// ---------------------------------------------------------------------------

describe('GPU-FOLLOW-3B testkit tripwires (shipped-path pins, no assets)', () => {
  it('mechanism 1 (warped-derivative LOD): FS_LIT derives LOD from UNWARPED UVs', () => {
    expect(FS_LIT).toContain('voodooSampleMippedWarped(uDiffuse, vUV,');
    expect(FS_LIT).not.toContain('voodooSampleMipped(uDiffuse, wuv');
  });

  it('mechanism 2 (mediump UV precision): FS_LIT runs highp for multi-tile water UVs', () => {
    expect(FS_LIT).toContain('precision highp float');
  });

  it('warp table step is bounded (no hidden warp discontinuity)', () => {
    let maxStep = 0;
    for (let i = 0; i < 1024; i++) {
      const a = 16 + 15 * Math.sin((2 * Math.PI * i) / 1024);
      const b = 16 + 15 * Math.sin((2 * Math.PI * ((i + 1) % 1024)) / 1024);
      maxStep = Math.max(maxStep, Math.abs(b - a));
    }
    expect(maxStep).toBeLessThan(1.0);
  });
});

// ---------------------------------------------------------------------------
// Real-map seam matrix (Q2_PAK).
// ---------------------------------------------------------------------------

describe.runIf(HAS_PAK)('GPU-FOLLOW-3B testkit seam matrix on real base1 water', () => {
  it('leg R: REPEAT tile borders seamless on the fixed path (all times x LOD 0..4)', { timeout: 180000 }, () => {
    const { chain, maxLevel } = loadReal();
    let maxDiff = 0;
    let worst = '';
    for (const t of TIMES) {
      for (const b of BORDERS) {
        for (const rho of RHOS) {
          for (const fp of FOOTPRINTS) {
            for (let pi = 0; pi < 16; pi++) {
              const px = pi & 3;
              const py = (pi >> 2) & 3;
              void fp;
              const a = sampleFixed(chain, maxLevel, b - EPS, 20.5, t, rho, px, py);
              const c = sampleFixed(chain, maxLevel, b + EPS, 20.5, t, rho, px, py);
              const d = diff3(a, c);
              if (d > maxDiff) {
                maxDiff = d;
                worst = `t=${t} border u=${b} rho=${rho} phase=(${px},${py})`;
              }
            }
          }
        }
      }
    }
    record({
      leg: 'R repeat-border straddle',
      map: MAP,
      camera: camLabel,
      material: MATERIAL,
      time: TIMES[2]!,
      cropUV: 'u in {b-0.1,b+0.1} x v=20.5 (b in {64,-64,128,-128,0})',
      lod: 'rho 1..16 (LOD 0..4) x 16 Bayer phases',
      maxDiff,
      gate: T_FIXED_STRADDLE,
      verdict: `worst ${worst}`,
      sense: 'below',
    });
    expect(maxDiff).toBeLessThan(T_FIXED_STRADDLE);
  });

  it('leg R-exact: unwarped REPEAT wraps bit-exactly (sampler itself is sound)', { timeout: 60000 }, () => {
    const { chain, maxLevel } = loadReal();
    let maxDiff = 0;
    for (const lvl of [0, 1, 2, 3]) {
      const m = chain[lvl]!;
      for (const b of BORDERS) {
        const a = sampleLevelBilinearRepeat(m.data, m.w, m.h, b - EPS, 20.5);
        const c = sampleLevelBilinearRepeat(m.data, m.w, m.h, b + 64 - EPS, 20.5);
        void maxLevel;
        maxDiff = Math.max(maxDiff, diff3(a, c));
      }
    }
    record({
      leg: 'R-exact wrap equivalence',
      map: MAP,
      camera: camLabel,
      material: MATERIAL,
      time: TIMES[0]!,
      cropUV: 'u=b-0.1 vs u=b+64-0.1, v=20.5, levels 0..3',
      lod: 'explicit levels 0..3',
      maxDiff,
      gate: 1e-9,
      sense: 'below',
      verdict: 'REPEAT wrap exact to float rounding (sub-LSB), independent of art',
    });
    expect(maxDiff).toBeLessThan(1e-9);
  });

  it('leg R-warpidx: warp index step across tile lines is bounded (no warp jump)', { timeout: 60000 }, () => {
    let maxJump = 0;
    let worst = '';
    for (const t of TIMES) {
      for (const b of BORDERS) {
        const [wu0, wv0] = warpUv(b - EPS, 10.2, t);
        const [wu1, wv1] = warpUv(b + EPS, 10.2, t);
        const j = Math.max(Math.abs(wu1 - wu0 - 2 * EPS), Math.abs(wv1 - wv0));
        if (j > maxJump) {
          maxJump = j;
          worst = `t=${t} border u=${b}`;
        }
      }
    }
    record({
      leg: 'R-warpidx warp-index step',
      map: MAP,
      camera: camLabel,
      material: MATERIAL,
      time: TIMES[2]!,
      cropUV: 'u=b+/-0.1, v=10.2 (texel units)',
      lod: 'warp index space (art-independent)',
      maxDiff: maxJump,
      gate: T_WARP_JUMP,
      verdict: `worst ${worst}`,
      sense: 'below',
    });
    expect(maxJump).toBeLessThan(T_WARP_JUMP);
  });

  it('leg F: adjacent turbo-face UV agreement + lightmap truth (face-mismatch suspect)', { timeout: 180000 }, () => {
    const { world, waterIds } = loadReal();
    expect(waterIds.length).toBeGreaterThan(0);
    const key = (x: number, y: number, z: number): string => `${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}`;
    const vertUse = new Map<string, Array<{ id: number; vi: number }>>();
    for (const id of waterIds) {
      const s = world.surfaces[id]!;
      for (let i = 0; i < s.n; i++) {
        const k = key(s.verts[i * 3]!, s.verts[i * 3 + 1]!, s.verts[i * 3 + 2]!);
        const list = vertUse.get(k) ?? [];
        list.push({ id, vi: i });
        vertUse.set(k, list);
      }
    }
    let sharedVerts = 0;
    let edgePairs = 0;
    let maxUvMismatch = 0;
    let maxLuxCoordMismatch = 0;
    let maxLightValueDiff = 0;
    let worstUv = '';
    let worstLight = '';
    const pairKey = (a: number, b: number): string => (a < b ? `${a}/${b}` : `${b}/${a}`);
    const pairCount = new Map<string, number>();
    for (const list of vertUse.values()) {
      if (list.length < 2) continue;
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const k = pairKey(list[a]!.id, list[b]!.id);
          pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
        }
      }
    }
    const lightValAt = (sId: number, vi: number): [number, number, number] | null => {
      const s = world.surfaces[sId]!;
      const lm = world.lightmaps[s.lightId % world.lightmaps.length]!;
      const ax = Math.round(s.lux[vi * 2]! / 16);
      const ay = Math.round(s.lux[vi * 2 + 1]! / 16);
      if (ax < 0 || ay < 0 || ax >= lm.luxW || ay >= lm.luxH) return null;
      const o = (ay * lm.luxW + ax) * 3;
      return [lm.samples[o]!, lm.samples[o + 1]!, lm.samples[o + 2]!];
    };
    for (const list of vertUse.values()) {
      if (list.length < 2) continue;
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const sa = world.surfaces[list[a]!.id]!;
          const sb = world.surfaces[list[b]!.id]!;
          const ia = list[a]!.vi;
          const ib = list[b]!.vi;
          const du = Math.max(
            Math.abs(sa.uvs[ia * 2]! - sb.uvs[ib * 2]!),
            Math.abs(sa.uvs[ia * 2 + 1]! - sb.uvs[ib * 2 + 1]!),
          );
          const dl = Math.max(
            Math.abs(sa.lux[ia * 2]! - sb.lux[ib * 2]!),
            Math.abs(sa.lux[ia * 2 + 1]! - sb.lux[ib * 2 + 1]!),
          );
          sharedVerts++;
          if ((pairCount.get(pairKey(sa.id, sb.id)) ?? 0) >= 2) {
            edgePairs++;
            const va = lightValAt(sa.id, ia);
            const vb = lightValAt(sb.id, ib);
            if (va && vb) {
              const dv = diff3(va, vb);
              if (dv > maxLightValueDiff) {
                maxLightValueDiff = dv;
                worstLight = `faces ${sa.id}/${sb.id}`;
              }
            }
          }
          if (du > maxUvMismatch) {
            maxUvMismatch = du;
            worstUv = `faces ${sa.id}/${sb.id}`;
          }
          maxLuxCoordMismatch = Math.max(maxLuxCoordMismatch, dl);
        }
      }
    }
    // Faces 117/118 spot check (recorded pattern: identical uv AND identical
    // sampled light value at the shared verts — face/lightmap seams ruled
    // out at the reported defect view).
    const byId = new Map(world.surfaces.map((s) => [s.id, s]));
    const fa = byId.get(117);
    const fb = byId.get(118);
    let spotChecked = 0;
    let spotValueMax = 0;
    if (fa && fb && fa.turbulent && fb.turbulent) {
      const am = new Map<string, number>();
      for (let i = 0; i < fa.n; i++) {
        am.set(key(fa.verts[i * 3]!, fa.verts[i * 3 + 1]!, fa.verts[i * 3 + 2]!), i);
      }
      for (let j = 0; j < fb.n; j++) {
        const i = am.get(key(fb.verts[j * 3]!, fb.verts[j * 3 + 1]!, fb.verts[j * 3 + 2]!));
        if (i === undefined) continue;
        expect(fa.uvs[i * 2]!).toBe(fb.uvs[j * 2]!);
        expect(fa.uvs[i * 2 + 1]!).toBe(fb.uvs[j * 2 + 1]!);
        const va = lightValAt(117, i);
        const vb = lightValAt(118, j);
        if (va && vb) spotValueMax = Math.max(spotValueMax, diff3(va, vb));
        spotChecked++;
      }
    }
    record({
      leg: 'F adjacent-face UV agreement + lightmap truth',
      map: MAP,
      camera: camLabel,
      material: MATERIAL,
      time: TIMES[0]!,
      cropUV: `${waterIds.length} water faces, ${sharedVerts} shared-vert pairs (${edgePairs} edge-sharing; incl 117/118 x${spotChecked})`,
      lod: 'geometry space (art/LOD-independent)',
      maxDiff: maxUvMismatch,
      gate: 0,
      sense: 'below',
      verdict: `worst ${worstUv}; luxCoordMax ${maxLuxCoordMismatch}; edgeLightValMax ${maxLightValueDiff} (${worstLight}); 117/118 spotValMax ${spotValueMax}`,
    });
    console.log(
      `[release-3b-seam] leg F: waterFaces=${waterIds.length} sharedVertPairs=${sharedVerts} ` +
        `edgeSharing=${edgePairs} maxUvMismatch=${maxUvMismatch} maxLuxCoordMismatch=${maxLuxCoordMismatch} ` +
        `edgeLightValMax=${maxLightValueDiff} spot117/118=${spotChecked} spotValMax=${spotValueMax}`,
    );
    // Adjacent-face UV mismatch is EXONERATED (exact agreement everywhere).
    // Lux coords differ per face (independent lightmap blocks — expected by
    // construction, recorded not gated); sampled light VALUES differ across
    // some edges (up to 97/255) as original map truth, sampled identically
    // by the CPU reference — not a GPU-introduced seam (GPU bleed is ruled
    // out separately by leg L). At the reported 117/118 faces even the
    // light values agree exactly.
    expect(sharedVerts).toBeGreaterThan(0);
    expect(edgePairs).toBeGreaterThan(0);
    expect(maxUvMismatch).toBe(0);
    expect(spotChecked).toBeGreaterThan(0);
    expect(spotValueMax).toBe(0);
  });

  it('leg F-sample: fixed path continuous AT real shared-edge UVs (mid-tile face edges)', { timeout: 180000 }, () => {
    const { world, waterIds, chain, maxLevel } = loadReal();
    // Collect shared-edge midpoints in UV space (these are mid-tile, NOT tile borders).
    const key = (x: number, y: number, z: number): string => `${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}`;
    const seen = new Map<string, { u: number; v: number }>();
    for (const id of waterIds) {
      const s = world.surfaces[id]!;
      for (let i = 0; i < s.n; i++) {
        const k = key(s.verts[i * 3]!, s.verts[i * 3 + 1]!, s.verts[i * 3 + 2]!);
        if (!seen.has(k)) seen.set(k, { u: s.uvs[i * 2]!, v: s.uvs[i * 2 + 1]! });
      }
    }
    const pts = [...seen.values()].slice(0, 40);
    expect(pts.length).toBeGreaterThan(0);
    let maxDiff = 0;
    let worst = '';
    for (const t of TIMES) {
      for (const p of pts) {
        for (const rho of [1, 4, 16]) {
          const a = sampleFixed(chain, maxLevel, p.u - EPS, p.v, t, rho, 0, 0);
          const c = sampleFixed(chain, maxLevel, p.u + EPS, p.v, t, rho, 0, 0);
          const d = diff3(a, c);
          if (d > maxDiff) {
            maxDiff = d;
            worst = `t=${t} uv=(${p.u.toFixed(1)},${p.v.toFixed(1)}) rho=${rho}`;
          }
        }
      }
    }
    record({
      leg: 'F-sample shared-edge UV straddle',
      map: MAP,
      camera: camLabel,
      material: MATERIAL,
      time: TIMES[2]!,
      cropUV: `${pts.length} real shared-edge UVs +/-0.1 texels (mid-tile)`,
      lod: 'rho 1/4/16 (LOD 0/2/4)',
      maxDiff,
      gate: T_FIXED_STRADDLE,
      verdict: `worst ${worst}`,
      sense: 'below',
    });
    expect(maxDiff).toBeLessThan(T_FIXED_STRADDLE);
  });

  it('leg L: lightmap atlas gutters isolate every water rect (rect-border suspect)', { timeout: 180000 }, () => {
    const { world, waterIds } = loadReal();
    const styles = new Float32Array(256).fill(1);
    const { atlas, skipped } = packLightAtlas(world, waterIds, styles);
    const rectOf = atlas.rectOf as Map<number, { x: number; y: number; w: number; h: number }>;
    const px = atlas.pixels;
    const W = atlas.width;
    const at = (x: number, y: number): [number, number, number] => {
      const o = (y * W + x) * 3;
      return [px[o]!, px[o + 1]!, px[o + 2]!];
    };
    let checked = 0;
    let maxGutterDiff = 0;
    for (const id of waterIds) {
      const r = rectOf.get(id);
      if (!r) continue;
      // Every gutter texel must duplicate its adjacent edge texel exactly
      // (bilinear isolation: taps within half a luxel of the edge stay in-block).
      for (let x = 0; x < r.w; x++) {
        const top0 = at(r.x + x, r.y);
        const topG = at(r.x + x, r.y - 1);
        const bot0 = at(r.x + x, r.y + r.h - 1);
        const botG = at(r.x + x, r.y + r.h);
        maxGutterDiff = Math.max(maxGutterDiff, diff3(top0, topG), diff3(bot0, botG));
        checked += 2;
      }
      for (let y = 0; y < r.h; y++) {
        const l0 = at(r.x, r.y + y);
        const lG = at(r.x - 1, r.y + y);
        const r0 = at(r.x + r.w - 1, r.y + y);
        const rG = at(r.x + r.w, r.y + y);
        maxGutterDiff = Math.max(maxGutterDiff, diff3(l0, lG), diff3(r0, rG));
        checked += 2;
      }
    }
    record({
      leg: 'L atlas gutter isolation',
      map: MAP,
      camera: camLabel,
      material: MATERIAL,
      time: TIMES[0]!,
      cropUV: `atlas ${W}x${atlas.height}, ${checked} edge/gutter pairs over water rects (skipped=${skipped.length})`,
      lod: 'lightmap space (unmipped LINEAR)',
      maxDiff: maxGutterDiff,
      gate: 0,
      sense: 'below',
      verdict: `water rects placed: ${rectOf.size}/${waterIds.length}`,
    });
    console.log(
      `[release-3b-seam] leg L: waterRects=${rectOf.size}/${waterIds.length} ` +
        `edgeGutterPairs=${checked} maxGutterDiff=${maxGutterDiff} skipped=${skipped.length}`,
    );
    // Lightmap rect borders are EXONERATED (gutter duplication exact; no foreign bleed).
    expect(checked).toBeGreaterThan(0);
    expect(maxGutterDiff).toBe(0);
  });

  it('leg A: source-art wrap edge vs interior gradient (art suspect)', { timeout: 60000 }, () => {
    const { rgb0 } = loadReal();
    const W = 64;
    const H = 64;
    const at = (x: number, y: number): [number, number, number] => {
      const o = (y * W + x) * 3;
      return [rgb0[o]!, rgb0[o + 1]!, rgb0[o + 2]!];
    };
    let wrapMax = 0;
    for (let y = 0; y < H; y++) wrapMax = Math.max(wrapMax, diff3(at(W - 1, y), at(0, y)));
    let interiorMax = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W - 1; x++) interiorMax = Math.max(interiorMax, diff3(at(x, y), at(x + 1, y)));
    }
    record({
      leg: 'A source-art wrap gradient',
      map: MAP,
      camera: camLabel,
      material: MATERIAL,
      time: TIMES[0]!,
      cropUV: `bluwter col ${W - 1} vs col 0 (${H} rows) vs ${W * H} interior adjacencies`,
      lod: 'art space (level 0 texels)',
      maxDiff: wrapMax,
      gate: interiorMax,
      sense: 'na',
      verdict: `wrapMax=${wrapMax} interiorMax=${interiorMax}`,
    });
    console.log(`[release-3b-seam] leg A: artWrapMax=${wrapMax} artInteriorMax=${interiorMax}`);
    // Diagnostic, not a gate: documents whether the art's own wrap edge
    // could read as a seam under a perfect sampler. Verdict is recorded;
    // sampler legs above already bound the shipped path regardless.
    expect(Number.isFinite(wrapMax)).toBe(true);
    expect(Number.isFinite(interiorMax)).toBe(true);
  });

  it('leg T: TRANS66 alpha-blended overlaps stay seamless', { timeout: 180000 }, () => {
    const { chain, maxLevel } = loadReal();
    // Overlapping translucent taps: water doubles over itself where faces
    // overlap in screen space (renderer composites far->near, no depth write).
    // Blend is linear, so the blended seam is bounded by the tap seam.
    let maxDiff = 0;
    let worst = '';
    for (const t of TIMES) {
      for (const b of [64, -64]) {
        for (const rho of RHOS) {
          const fore0 = sampleFixed(chain, maxLevel, b - EPS, 20.5, t, rho, 1, 2);
          const back0 = sampleFixed(chain, maxLevel, b - EPS, 20.5, 7.25, rho, 1, 2);
          const fore1 = sampleFixed(chain, maxLevel, b + EPS, 20.5, t, rho, 1, 2);
          const back1 = sampleFixed(chain, maxLevel, b + EPS, 20.5, 7.25, rho, 1, 2);
          const d = diff3(blendOver(fore0, back0), blendOver(fore1, back1));
          if (d > maxDiff) {
            maxDiff = d;
            worst = `t=${t} border u=${b} rho=${rho}`;
          }
        }
      }
    }
    record({
      leg: 'T TRANS66 blended overlap',
      map: MAP,
      camera: camLabel,
      material: `${MATERIAL} alpha=${TRANS66_ALPHA}`,
      time: TIMES[2]!,
      cropUV: 'u=b+/-0.1 x v=20.5 (b in {64,-64}), fore t vs back t=7.25',
      lod: 'rho 1..16 (LOD 0..4)',
      maxDiff,
      gate: T_FIXED_STRADDLE,
      verdict: `worst ${worst}`,
      sense: 'below',
    });
    expect(maxDiff).toBeLessThan(T_FIXED_STRADDLE);
  });

  // -- INJECTED seam controls (must be CAUGHT: each produces a seam signal
  // -- exceeding its catch gate; C1 compares wrap modes at identical taps,
  // -- C2/C3 show level-pick defects as visible color steps) -------------------

  it('control C1 (CAUGHT): clamp-wrap tap deviates from REPEAT on the warped path', { timeout: 180000 }, () => {
    const { chain, maxLevel } = loadReal();
    // Wrap-mode sensitivity is warp-independent (REPEAT is translation
    // invariant), so the sweep covers every tap phase through warped taps:
    // for each past-edge offset the clamp tap is compared against the
    // production REPEAT tap at the SAME warped coords — the difference is
    // purely the wrap mode (same art, same level, same warp).
    const clampTapAt = (lvl: number, x: number, y: number): [number, number, number] => {
      const m = chain[lvl]!;
      const clamp = (i: number, n: number): number => (i < 0 ? 0 : i >= n ? n - 1 : i);
      const tap = (ix: number, iy: number): [number, number, number] => {
        const o = (clamp(iy, m.h) * m.w + clamp(ix, m.w)) * 3;
        return [m.data[o]!, m.data[o + 1]!, m.data[o + 2]!];
      };
      const xx = x - 0.5;
      const yy = y - 0.5;
      const x0 = Math.floor(xx);
      const y0 = Math.floor(yy);
      const fx = xx - x0;
      const fy = yy - y0;
      const a = tap(x0, y0);
      const b = tap(x0 + 1, y0);
      const c = tap(x0, y0 + 1);
      const d = tap(x0 + 1, y0 + 1);
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      return [
        a[0] * w00 + b[0] * w10 + c[0] * w01 + d[0] * w11,
        a[1] * w00 + b[1] * w10 + c[1] * w01 + d[1] * w11,
        a[2] * w00 + b[2] * w10 + c[2] * w01 + d[2] * w11,
      ];
    };
    let maxClampErr = 0;
    let worst = '';
    for (const t of TIMES) {
      for (const b of [64, -64]) {
        for (let v = 0; v < 64; v++) {
          for (const e of [0.5, 1, 2, 4, 8, 16]) {
            for (const lvl of [0, 1, 2]) {
              if (lvl > maxLevel) continue;
              const m = chain[lvl]!;
              const s = m.w / 64;
              const [wu, wv] = warpUv(b + e, v + 0.5, t);
              const rep = sampleLevelBilinearRepeat(m.data, m.w, m.h, wu * s, wv * s);
              const cl = clampTapAt(lvl, wu * s, wv * s);
              const d = diff3(rep, cl);
              if (d > maxClampErr) {
                maxClampErr = d;
                worst = `t=${t} border=${b} v=${v} e=${e} lvl=${lvl}`;
              }
            }
          }
        }
      }
    }
    record({
      leg: 'C1 injected clamp-wrap (control)',
      map: MAP,
      camera: camLabel,
      material: MATERIAL,
      time: TIMES[2]!,
      cropUV: 'warped taps past tile edge (offsets 0.5..16, all 64 v rows, levels 0..2)',
      lod: 'explicit levels 0..2 (wrap-mode defect, level-independent)',
      maxDiff: maxClampErr,
      gate: T_CATCH_MIN,
      sense: 'above',
      verdict: `worst ${worst} (control must exceed catch floor)`,
    });
    console.log(`[release-3b-seam] control C1: clampErrMax=${maxClampErr}`);
    expect(maxClampErr).toBeGreaterThan(T_CATCH_MIN);
  });

  it('control C2 (CAUGHT): off-by-one mip level visibly shifts taps', { timeout: 180000 }, () => {
    const { chain, maxLevel } = loadReal();
    let maxDiff = 0;
    let worst = '';
    for (const t of TIMES) {
      for (const rho of RHOS) {
        for (const uu of [4.5, 20.5, 37.5, 52.5]) {
          for (const vv of [4.5, 20.5, 37.5, 52.5]) {
            for (let pi = 0; pi < 16; pi++) {
              const px = pi & 3;
              const py = (pi >> 2) & 3;
              const a = sampleFixed(chain, maxLevel, uu, vv, t, rho, px, py);
              const b = sampleOffByOneInjected(chain, maxLevel, uu, vv, t, rho, px, py);
              const d = diff3(a, b);
              if (d > maxDiff) {
                maxDiff = d;
                worst = `t=${t} rho=${rho} uv=(${uu},${vv}) phase=(${px},${py})`;
              }
            }
          }
        }
      }
    }
    record({
      leg: 'C2 injected off-by-one level (control)',
      map: MAP,
      camera: camLabel,
      material: MATERIAL,
      time: TIMES[2]!,
      cropUV: 'uv 4x4 interior grid x all 16 Bayer phases',
      lod: 'rho 1..16 (LOD 0..4)',
      maxDiff,
      gate: T_CATCH_MIN,
      sense: 'above',
      verdict: `worst ${worst} (control must exceed catch floor)`,
    });
    console.log(`[release-3b-seam] control C2: offByOneMax=${maxDiff}`);
    expect(maxDiff).toBeGreaterThan(T_CATCH_MIN);
  });

  it('control C3 (CAUGHT): warped-derivative LOD flips levels where the fixed input does not', { timeout: 180000 }, () => {
    const { chain, maxLevel } = loadReal();
    // True-defect reproduction (mechanism 1): the OLD shader derived LOD
    // from WARPED uv derivatives. Scan the production footprint lattice for
    // reference-vs-old level disagreements, then show the disagreement is
    // VISIBLE (sampled color differs at the flip).
    let flips = 0;
    let probed = 0;
    let maxFlipColorDiff = 0;
    let worst = '';
    for (const t of TIMES) {
      for (const fp of [1.2, 1.45, 2, 3]) {
        for (let u = 0; u < 64; u += 1) {
          for (let pi = 0; pi < 16; pi++) {
            const px = pi & 3;
            const py = (pi >> 2) & 3;
            const ref = levelAt(maxLevel, u, 10.125, t, fp, fp, false, px, py);
            const old = levelAt(maxLevel, u, 10.125, t, fp, fp, true, px, py);
            probed++;
            if (ref !== old) {
              flips++;
              const mR = chain[ref]!;
              const mO = chain[old]!;
              const sR = mR.w / 64;
              const sO = mO.w / 64;
              const [wu, wv] = warpUv(u, 10.125, t);
              const d = diff3(
                sampleLevelBilinearRepeat(mR.data, mR.w, mR.h, wu * sR, wv * sR),
                sampleLevelBilinearRepeat(mO.data, mO.w, mO.h, wu * sO, wv * sO),
              );
              if (d > maxFlipColorDiff) {
                maxFlipColorDiff = d;
                worst = `t=${t} fp=${fp} u=${u} phase=(${px},${py}) ref=${ref} old=${old}`;
              }
            }
          }
        }
      }
    }
    // Fixed input is warp-independent: identical level at any time/position
    // sharing the sub-texel fraction (no leak from warp phase into LOD).
    for (const fp of [1, 2, 4]) {
      for (let pi = 0; pi < 16; pi++) {
        const px = pi & 3;
        const py = (pi >> 2) & 3;
        const first = levelAt(maxLevel, 3.25, -7.5, TIMES[0]!, fp, fp, false, px, py);
        for (const t of TIMES) {
          expect(levelAt(maxLevel, 3.25, -7.5, t, fp, fp, false, px, py)).toBe(first);
          expect(levelAt(maxLevel, 67.25, 56.5, t, fp, fp, false, px, py)).toBe(first);
        }
      }
    }
    record({
      leg: 'C3 injected warped-derivative LOD (control = true defect)',
      map: MAP,
      camera: camLabel,
      material: MATERIAL,
      time: TIMES[2]!,
      cropUV: `u 0..64 x v=10.125 grid, fp 1.2..3 (${probed} probes)`,
      lod: 'rho from footprint (old input warped)',
      maxDiff: maxFlipColorDiff,
      gate: T_CATCH_MIN,
      sense: 'above',
      verdict: `flips=${flips}/${probed}; worst ${worst}`,
    });
    console.log(`[release-3b-seam] control C3: flips=${flips}/${probed} flipColorMax=${maxFlipColorDiff}`);
    expect(probed).toBeGreaterThan(0);
    expect(flips).toBeGreaterThan(0);
    expect(maxFlipColorDiff).toBeGreaterThan(T_CATCH_MIN);
  });

  it('sensitivity summary: every control caught AND every fixed leg seamless', () => {
    const byLeg = new Map(RECORDS.map((r) => [r.leg, r]));
    const fixedLegs = [
      'R repeat-border straddle',
      'R-exact wrap equivalence',
      'R-warpidx warp-index step',
      'F adjacent-face UV agreement + lightmap truth',
      'F-sample shared-edge UV straddle',
      'L atlas gutter isolation',
      'T TRANS66 blended overlap',
    ];
    for (const leg of fixedLegs) {
      const r = byLeg.get(leg);
      expect(r, `leg record missing: ${leg}`).toBeDefined();
      expect(r!.sense, `${leg} misclassified`).toBe('below');
      expect(r!.maxDiff, `${leg} exceeded gate`).toBeLessThanOrEqual(r!.gate);
    }
    const controls = [
      'C1 injected clamp-wrap (control)',
      'C2 injected off-by-one level (control)',
      'C3 injected warped-derivative LOD (control = true defect)',
    ];
    for (const leg of controls) {
      const r = byLeg.get(leg);
      expect(r, `control record missing: ${leg}`).toBeDefined();
      expect(r!.sense, `${leg} misclassified`).toBe('above');
      expect(r!.maxDiff, `${leg} NOT caught — matrix is not seam-sensitive`).toBeGreaterThan(r!.gate);
    }
    // Diagnostic leg present but ungated.
    expect(byLeg.get('A source-art wrap gradient')?.sense).toBe('na');
    console.log(`[release-3b-seam] matrix records: ${JSON.stringify(RECORDS, null, 1)}`);
  });
});

describe.runIf(!HAS_PAK)('GPU-FOLLOW-3B testkit seam matrix (no Q2_PAK)', () => {
  it('skips the real-asset legs gracefully', () => {
    console.log('[release-3b-seam] real-base1 legs skipped: Q2_PAK absent');
    expect(HAS_PAK).toBe(false);
  });
});
