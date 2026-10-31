// GPU-FOLLOW-3B — water tile-boundary regression (webgl-renderer lane:
// shader/sampling fix + unit/pixel evidence; browser captures ride the
// integrator lane in apps/web + testkit).
//
// Demonstrated cause (recorded from real base1 before the fix; Q2_PAK leg
// below re-proves it on retail art):
//   map base1, water material textures/e1u1/bluwter.wal (all 102 turbulent
//   faces share one 64x64 WAL, texId 11), faces 117/118 share world pos
//   [448,1280,-252] with IDENTICAL uv [448,-1280] and lux [16,0] —
//   texture-repeat mapping and lightmap blocks are continuous across the
//   shared edge, so BSP-face/lightmap seams are NOT the cause here.
//   Two defects were implicated instead:
//   (1) FS_LIT derived mip LOD from WARPED uv derivatives (fwidth of
//       u+T(floor(v))), while the CPU reference (spans.ts spanLod, the
//       runSubdivTurbulent ground truth) derives LOD from UNWARPED
//       gradients and warps only the diffuse lookup. The warp's floor()
//       steps inflate rho at integer texel lines and flip the Bayer n/n+1
//       pick on a tile grid (cause demo below finds the flips).
//   (2) FS_LIT used mediump with world UVs spanning ~30 tiles (uv down to
//       -1392 texels / normalized ~-21.75): the min-spec mediump mantissa
//       quantizes such varyings to ~whole texels, snapping warp indices
//       and bilinear fractions on the tile grid.
// Fix (production): LOD/level from unwarped vUV via
// voodooSampleMippedWarped (warp offsets only the tap; diffuse wrap,
// lighting, mip chain and animation unchanged) + highp in FS_LIT
// (FS_APPEARANCE parity).
//
// Regression shape (formula mirrors alone are insufficient per review):
// sampled pixels across repeat/face boundaries at multiple times, with an
// effective negative control (unwarped path stable; lightmap continuous)
// and a source pin tying the exercised logic to the shipped shader.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { loadBsp } from '@q2/bsp';
import { parsePCX, parseWAL } from '@q2/formats';
import { bspToMiniWorld, type BspTexelSource, type MiniSurf, type MiniWorld } from '@q2/sw-renderer';
import {
  buildMipChainRGB,
  downsampleToCap,
  GLSL_MIP_POLICY,
  mipLevelFor,
  pickMipLevelFor,
  PINNED_LOD_BIAS,
  sampleLevelBilinearRepeat,
  warpPhaseFor,
  warpTableValue,
  warpUv,
} from './appearance.js';
import { expandPaletteTexture, packLightAtlas, TRANS66_ALPHA } from './worldMesh.js';
import { buildFullWorldStore } from './worldMesh.js';
import { FS_LIT } from './shaders.js';

/** Times probed (level-time seconds; 15.984375/16.0 straddle turb phase wrap 1023->0). */
const TIMES = [0, 0.5, 1.5, 7.25, 15.984375, 16.0, 33.3125];

function pakReadFile(pakPath: string, name: string): ArrayBuffer {
  const data = readFileSync(pakPath);
  const dirofs = data.readUInt32LE(4);
  const dirlen = data.readUInt32LE(8);
  for (let o = dirofs; o < dirofs + dirlen; o += 64) {
    const entry = data.subarray(o, o + 56).toString().replace(/\0.*$/, '');
    if (entry === name) {
      const off = data.readUInt32LE(o + 56);
      const len = data.readUInt32LE(o + 60);
      return data.buffer.slice(data.byteOffset + off, data.byteOffset + off + len) as ArrayBuffer;
    }
  }
  throw new Error(`pak entry missing: ${name}`);
}

/**
 * Screen-space rho mirror of the shader's fwidth rule: max length of the
 * discrete uv derivatives over a (du, dv) texel/px footprint. warped=false
 * is the CPU spanLod input (unwarped gradients); warped=true is the OLD
 * shader input (warped derivatives, floor steps included).
 */
function rhoAt(u: number, v: number, t: number, du: number, dv: number, warped: boolean): number {
  const p = (x: number, y: number): [number, number] => (warped ? warpUv(x, y, t) : [x, y]);
  const [a0, b0] = p(u, v);
  const [a1, b1] = p(u + du, v);
  const [a2, b2] = p(u, v + dv);
  return Math.max(Math.hypot(a1 - a0, b1 - b0), Math.hypot(a2 - a0, b2 - b0));
}

/** Level pick mirror (single-TMU dither path, chain-capped). */
function levelAt(u: number, v: number, t: number, du: number, dv: number, warped: boolean, px: number, py: number, maxLevel: number): number {
  const lod = mipLevelFor(rhoAt(u, v, t, du, dv, warped), PINNED_LOD_BIAS, maxLevel, true);
  return pickMipLevelFor(lod, px, py, true, maxLevel);
}

/** Smooth tileable 64x64 RGB water-stand-in (period divides 64: wrap-exact). */
function tileableWater64(): Uint8Array {
  const w = 64;
  const h = 64;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      out[o] = 128 + 90 * Math.sin((2 * Math.PI * x) / 64) * Math.cos((2 * Math.PI * y) / 64);
      out[o + 1] = 110 + 70 * Math.sin((2 * Math.PI * (x + y)) / 64);
      out[o + 2] = 150 + 60 * Math.cos((2 * Math.PI * (x - y)) / 64);
    }
  }
  return out;
}

describe('GPU-FOLLOW-3B water repeat diagnostic', () => {
  it('warp phase is deterministic at fixed time', () => {
    expect(warpPhaseFor(1.0)).toBe(64 & 1023);
    expect(warpPhaseFor(1.0)).toBe(warpPhaseFor(1.0));
  });

  it('adjacent texels across a 64-px tile edge warp continuously', () => {
    const t = 1.5;
    // Sample just left and right of a tile boundary (u=63.9 vs 64.1, same v).
    const [wu0, wv0] = warpUv(63.9, 10.2, t);
    const [wu1, wv1] = warpUv(64.1, 10.2, t);
    // Warp adds 1..31 texels; the delta across 0.2 texels must stay small.
    // A seam would appear as a multi-texel jump from the table index flip.
    expect(Math.abs(wu1 - wu0 - 0.2)).toBeLessThan(2.0);
    expect(Math.abs(wv1 - wv0)).toBeLessThan(2.0);
  });

  it('warp table step is bounded (no hidden discontinuity)', () => {
    let maxStep = 0;
    for (let i = 0; i < 1024; i++) {
      const a = warpTableValue(i);
      const b = warpTableValue((i + 1) % 1024);
      maxStep = Math.max(maxStep, Math.abs(b - a));
    }
    // sin step ~0.09; the wrap 1023->0 step must also stay small.
    expect(maxStep).toBeLessThan(1.0);
  });
});

describe('GPU-FOLLOW-3B cause: warped-derivative LOD flips on the tile grid', () => {
  it('old (warped) LOD input picks a coarser level than the reference input', () => {
    // The warp table's sine slope (up to ~0.09/index) inflates fwidth rho by
    // up to ~9% where footprints cross steep table regions; the +0.125 LOD
    // bias flips the Bayer n/n+1 pick wherever f*16 sits just below a
    // threshold. The reference (spans.ts spanLod) never sees this: it uses
    // unwarped gradients. Scan time x footprint x position x dither phase.
    let oldFlips = 0;
    let probed = 0;
    for (const t of TIMES) {
      for (let fp = 1.2; fp < 4; fp += 0.05) {
        for (let u = 0; u < 64; u += 1) {
          for (let pi = 0; pi < 16; pi++) {
            const px = pi & 3;
            const py = (pi >> 2) & 3;
            const ref = levelAt(u, 10.125, t, fp, fp, false, px, py, 6);
            const old = levelAt(u, 10.125, t, fp, fp, true, px, py, 6);
            probed++;
            if (ref !== old) {
              // Bias is always toward coarser (rho can only inflate).
              expect(old).toBeGreaterThan(ref);
              oldFlips++;
            }
          }
        }
      }
    }
    expect(probed).toBeGreaterThan(0);
    // Recorded defect class: present in the grid (e.g. t=0, fp=1.45, u=0,
    // phase (3,2): reference 0, warped input 1).
    expect(oldFlips).toBeGreaterThan(0);
  });

  it('reference (unwarped) LOD input is warp-independent: fixed pixel, any time', () => {
    // Same footprint/phase at any time and any position with the same
    // sub-texel fraction: identical level (warp phase cannot leak into LOD).
    for (const fp of [1, 2, 4]) {
      for (let pi = 0; pi < 16; pi++) {
        const px = pi & 3;
        const py = (pi >> 2) & 3;
        const first = levelAt(3.25, -7.5, TIMES[0]!, fp, fp, false, px, py, 6);
        for (const t of TIMES) {
          expect(levelAt(3.25, -7.5, t, fp, fp, false, px, py, 6)).toBe(first);
          expect(levelAt(67.25, 56.5, t, fp, fp, false, px, py, 6)).toBe(first);
        }
      }
    }
  });
});

describe('GPU-FOLLOW-3B shader pins (fixed path is the shipped path)', () => {
  it('FS_LIT samples water with LOD from unwarped UVs', () => {
    expect(FS_LIT).toContain('voodooSampleMippedWarped(uDiffuse, vUV,');
    expect(FS_LIT).not.toContain('voodooSampleMipped(uDiffuse, wuv');
  });

  it('FS_LIT runs highp (multi-tile water UV precision)', () => {
    expect(FS_LIT).toContain('precision highp float');
  });

  it('mip policy exposes the warped-tap variant with unwarped LOD', () => {
    expect(GLSL_MIP_POLICY).toContain('voodooSampleMippedWarped');
    expect(GLSL_MIP_POLICY).toContain('float lod = voodooLod(map, lodUv)');
    expect(GLSL_MIP_POLICY).toContain('textureLod(map, sampleUv, float(lvl))');
  });
});

describe('GPU-FOLLOW-3B sampler mirror (textureLod + REPEAT tap)', () => {
  it('bilinear-centre convention matches GL texel centres', () => {
    // 2x2 distinct texels: centre of texel (0,0) is u=0.5,v=0.5.
    const data = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    expect(sampleLevelBilinearRepeat(data, 2, 2, 0.5, 0.5)).toEqual([255, 0, 0]);
    expect(sampleLevelBilinearRepeat(data, 2, 2, 1.5, 0.5)).toEqual([0, 255, 0]);
    // Mid-edge blends two texels evenly.
    const mid = sampleLevelBilinearRepeat(data, 2, 2, 1.0, 0.5);
    expect(mid[0]).toBeCloseTo(127.5, 9);
    expect(mid[1]).toBeCloseTo(127.5, 9);
    expect(mid[2]).toBeCloseTo(0, 9);
  });

  it('REPEAT wraps negative and over-range coords', () => {
    const data = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
    const a = sampleLevelBilinearRepeat(data, 2, 2, -0.5, 0.5);
    const b = sampleLevelBilinearRepeat(data, 2, 2, 1.5, 0.5);
    expect(a).toEqual(b);
    const c = sampleLevelBilinearRepeat(data, 2, 2, 2.5, 2.5);
    const d = sampleLevelBilinearRepeat(data, 2, 2, 0.5, 0.5);
    expect(c).toEqual(d);
  });
});

describe('GPU-FOLLOW-3B pixel regression: fixed path continuous across boundaries', () => {
  const W = 64;
  const chain = buildMipChainRGB(tileableWater64(), W, W);
  // 64 -> ... -> 1x1 terminates (uMaxLevel clamp target).
  const maxLevel = chain.length - 1;
  const lvl0 = chain[0]!;

  function sampleFixed(u: number, v: number, t: number, lodRho: number, px: number, py: number): [number, number, number] {
    const lod = mipLevelFor(lodRho, PINNED_LOD_BIAS, maxLevel, true);
    const lvl = pickMipLevelFor(lod, px, py, true, maxLevel);
    const [wu, wv] = warpUv(u, v, t);
    const m = chain[lvl]!;
    return sampleLevelBilinearRepeat(m.data, m.w, m.h, wu * (m.w / W), wv * (m.h / W));
  }

  it('repeat boundary: warped samples stay continuous at fixed LOD, multiple times', () => {
    for (const t of TIMES) {
      // Straddle the u=64 tile edge (multi-tile + negative coords included).
      for (const [u0, v] of [[63.9, 10.2], [-64.1, -33.7], [128.0, 200.4]] as const) {
        const a = sampleFixed(u0 - 0.1, v, t, 1, 0, 0);
        const b = sampleFixed(u0 + 0.1, v, t, 1, 0, 0);
        for (let c = 0; c < 3; c++) {
          // Smooth tileable content: 0.2-texel neighbours differ by gradient only.
          expect(Math.abs(a[c]! - b[c]!)).toBeLessThan(6);
        }
      }
    }
    void lvl0;
  });

  it('face boundary: adjacent turbulent+translucent quads agree at the shared edge', () => {
    // Two quads sharing the x=8 edge with one continuous texel mapping
    // (mirrors real faces 117/118: same texId, same uv at shared verts).
    const world: MiniWorld = {
      brand: 'miniworld',
      nodes: [],
      leafs: [],
      pvs: [],
      clusterCount: 0,
      surfaces: [],
      textures: [{ texels: new Uint8Array(64).fill(3), width: 8, height: 8 }],
      lightmaps: [
        { samples: new Uint8Array(12).fill(64), luxW: 2, luxH: 2, styles: [0, 255, 255, 255] },
        { samples: new Uint8Array(12).fill(64), luxW: 2, luxH: 2, styles: [0, 255, 255, 255] },
      ],
      dynamicLights: [],
      alias: [],
      sprites: [],
      particles: [],
    };
    const quad = (
      id: number, x0: number, lightId: number,
    ): MiniSurf => ({
      id,
      verts: new Float32Array([x0, 0, 0, x0 + 8, 0, 0, x0 + 8, 0, 8, x0, 0, 8]),
      uvs: new Float32Array([x0, 0, x0 + 8, 0, x0 + 8, 8, x0, 8]),
      lux: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      n: 4,
      texId: 0,
      lightId,
      center: new Float32Array([x0 + 4, 0, 4]),
      radius: 8,
      mins: new Float32Array([x0, -1, -1]),
      maxs: new Float32Array([x0 + 8, 1, 9]),
      turbulent: true,
      translucent: 2,
      sky: false,
      fn: new Float32Array([0, 1, 0]),
    });
    world.surfaces = [quad(0, 0, 0), quad(1, 8, 1)];
    const styles = new Float32Array(256).fill(1);
    const { atlas } = packLightAtlas(world, [0, 1], styles);
    const store = buildFullWorldStore(world, atlas);
    // Plumbing: both ranges warp with TRANS66 alpha (turbulent+translucent).
    for (const id of [0, 1]) {
      const r = store.world.surfaces.get(id)!;
      expect(r.material).toBe('turbulent');
      expect(r.transparent).toBe(true);
      expect(store.world.alphas[r.vertStart]!).toBeCloseTo(TRANS66_ALPHA, 6);
    }
    // Shared-edge UVs agree in texel space (no per-face rescale seam) ...
    const au = store.world.uvs;
    // quad0 vert1 (u=8/8=1.0) == quad1 vert0 (u=8/8=1.0) in normalized units.
    const r0 = store.world.surfaces.get(0)!;
    const r1 = store.world.surfaces.get(1)!;
    expect(au[(r0.vertStart + 1) * 2]!).toBeCloseTo(au[r1.vertStart * 2]!, 9);
    // ... and the fixed-path warped samples agree there at every time.
    for (const t of TIMES) {
      const a = sampleFixed(8 - 0.05, 4, t, 1, 0, 0);
      const b = sampleFixed(8 + 0.05, 4, t, 1, 0, 0);
      for (let c = 0; c < 3; c++) expect(Math.abs(a[c]! - b[c]!)).toBeLessThan(6);
    }
  });

  it('negative control: unwarped diffuse is continuous (sampler itself is sound)', () => {
    for (const t of TIMES) {
      void t;
      const a = sampleLevelBilinearRepeat(lvl0.data, lvl0.w, lvl0.h, 63.9, 10.2);
      const b = sampleLevelBilinearRepeat(lvl0.data, lvl0.w, lvl0.h, 64.1, 10.2);
      for (let c = 0; c < 3; c++) expect(Math.abs(a[c]! - b[c]!)).toBeLessThan(6);
    }
  });
});

describe.runIf(!!process.env.Q2_PAK)('GPU-FOLLOW-3B on real base1 water (Q2_PAK)', () => {
  // Map base1, material textures/e1u1/bluwter.wal (64x64, shared by all 102
  // turbulent faces), camera facing surf 127 front side (~[416,1040,-244]
  // yaw ~90 pitch ~-6 at t=1.5/7.25), translucent TRANS66 water.
  let cached: { world: MiniWorld; palette: Uint8Array; bluwter: Uint8Array } | null = null;
  function loadReal(): { world: MiniWorld; palette: Uint8Array; bluwter: Uint8Array } {
    if (cached) return cached;
    const pakPath = process.env.Q2_PAK as string;
    const map = loadBsp(pakReadFile(pakPath, 'maps/base1.bsp'));
    const cache = new Map<string, BspTexelSource | null>();
    const texelFor = (name: string): BspTexelSource | null => {
      if (cache.has(name)) return cache.get(name)!;
      let src: BspTexelSource | null = null;
      try {
        const wal = parseWAL(pakReadFile(pakPath, `textures/${name}.wal`));
        src = { texels: wal.mips[0] as Uint8Array, width: wal.width, height: wal.height };
      } catch {
        src = null;
      }
      cache.set(name, src);
      return src;
    };
    const world = bspToMiniWorld(map, { texelFor });
    const palette = parsePCX(pakReadFile(pakPath, 'pics/colormap.pcx')).palette;
    const bluwter = parseWAL(pakReadFile(pakPath, 'textures/e1u1/bluwter.wal'));
    expect(bluwter.width).toBe(64);
    expect(bluwter.height).toBe(64);
    cached = { world, palette, bluwter: bluwter.mips[0] as Uint8Array };
    return cached;
  }

  it('original vs resized dims: 64x64 water is untouched by the 256 cap', () => {
    const { palette, bluwter } = loadReal();
    const rgb = expandPaletteTexture(bluwter, 64, 64, palette)!;
    expect(rgb).not.toBeNull();
    const capped = downsampleToCap(rgb, 64, 64, 256);
    expect(capped.capped).toBe(false);
    expect(capped.w).toBe(64);
    expect(capped.h).toBe(64);
    const chain = buildMipChainRGB(capped.data, capped.w, capped.h);
    expect(chain.length).toBe(7); // 64 -> ... -> 1x1, uMaxLevel 6
    expect(chain[chain.length - 1]!.w).toBe(1);
  });

  it('real faces 117/118: shared world pos has identical uv+lux (face seam ruled out)', { timeout: 180000 }, () => {
    const { world } = loadReal();
    const byId = new Map(world.surfaces.map((s) => [s.id, s]));
    const a = byId.get(117)!;
    const b = byId.get(118)!;
    expect(a.turbulent).toBe(true);
    expect(b.turbulent).toBe(true);
    expect(a.translucent).toBe(2);
    // Shared vert [448,1280,-252] (toFixed(1) key).
    const key = (p: number[]): string => p.map((x) => x.toFixed(1)).join(',');
    const am = new Map<string, number>();
    for (let i = 0; i < a.n; i++) am.set(key([a.verts[i * 3]!, a.verts[i * 3 + 1]!, a.verts[i * 3 + 2]!]), i);
    let checked = 0;
    for (let j = 0; j < b.n; j++) {
      const k = key([b.verts[j * 3]!, b.verts[j * 3 + 1]!, b.verts[j * 3 + 2]!]);
      const i = am.get(k);
      if (i === undefined) continue;
      expect(a.uvs[i * 2]!).toBe(b.uvs[j * 2]!);
      expect(a.uvs[i * 2 + 1]!).toBe(b.uvs[j * 2 + 1]!);
      expect(a.lux[i * 2]!).toBe(b.lux[j * 2]!);
      expect(a.lux[i * 2 + 1]!).toBe(b.lux[j * 2 + 1]!);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('real bluwter: fixed path continuous across the repeat edge at multiple times', { timeout: 180000 }, () => {
    const { palette, bluwter } = loadReal();
    const rgb = expandPaletteTexture(bluwter, 64, 64, palette)!;
    const chain = buildMipChainRGB(rgb, 64, 64);
    const maxLevel = chain.length - 1;
    // Real-scale probes: repeat edge u=64 plus negative multi-tile coords.
    for (const t of TIMES) {
      for (const [u, v, rho] of [[64, 20.5, 1], [-100.1, -33.7, 1], [300.2, 511.9, 2]] as const) {
        const lod = mipLevelFor(rho, PINNED_LOD_BIAS, maxLevel, true);
        const lvl = pickMipLevelFor(lod, 0, 0, true, maxLevel);
        const m = chain[lvl]!;
        const s = m.w / 64;
        const [wu0, wv0] = warpUv(u - 0.1, v, t);
        const [wu1, wv1] = warpUv(u + 0.1, v, t);
        const a = sampleLevelBilinearRepeat(m.data, m.w, m.h, wu0 * s, wv0 * s);
        const b = sampleLevelBilinearRepeat(m.data, m.w, m.h, wu1 * s, wv1 * s);
        for (let c = 0; c < 3; c++) {
          // Real art gradient across 0.2 texels stays small on the fixed path.
          expect(Math.abs(a[c]! - b[c]!)).toBeLessThan(28);
        }
      }
    }
  });
});

describe.runIf(!process.env.Q2_PAK)('GPU-FOLLOW-3B real base1 (no Q2_PAK)', () => {
  it('skips the real-asset legs gracefully', () => {
    console.log('GPU-FOLLOW-3B real-base1 skipped: Q2_PAK absent');
  });
});
