// @q2/webgl-renderer appearance — GPU-PROOF-4 Voodoo appearance policy.
//
// What this module owns:
//   - the fullscreen appearance pass GLSL (VS_POST + FS_APPEARANCE, exported
//     reviewable consts): absolute-phase Bayer dither -> RGB565 quantize ->
//     matched reconstruction (or legacy box) -> display gamma, resident on
//     GPU through presentation (no readback on the normal path);
//   - shared GLSL chunks (Bayer tables, single-TMU mip pick, table fog,
//     overbright) interpolated into the scene programs in shaders.ts;
//   - CPU-side pure mirrors of the @q2/voodoo policy used at upload time
//     (mip-chain box filter, texture cap, fog/gamma LUT builders, LOD math).
//
// REUSE vs DUPLICATE-BY-VALUE (deliberate, enforced by `yarn deps:check`):
// the allowlist (`tools/asset-cooker/.../check-deps`, mirrored in BRAIN.md
// §3) permits webgl-renderer to depend on bsp/config/formats/math/
// renderer-api/sw-renderer ONLY — @q2/voodoo is NOT an allowed edge, and
// this card may not touch BRAIN.md, docs/ or the allowlist. So every voodoo
// value below is DUPLICATED BY VALUE from packages/voodoo/src (file + formula
// cited per symbol), and pinned by src/appearance.test.ts against literals
// copied from the voodoo source. If the integrator later adds the edge, these
// become imports with zero policy change. @q2/voodoo itself is untouched by
// this card (stays WebGL-free).
//
// Duplication inventory (source -> this module):
//   bayer.ts  BAYER4/BAYER2/DITHER_RB_POS/DITHER_G_POS/DITHER2_*
//           -> BAYER4/BAYER2/DITHER_RB4/DITHER_G4/DITHER_RB2/DITHER_G2
//              (+ GLSL_BAYER4 int array, same row-major values).
//   resolve.ts quantiseRGB565/expandRGB565/gammaLUT/parseDitherMode/
//              parseReconMode/parseRgbMaxDelta/defaultRgbMaxDelta
//           -> pack565/expand565/gammaLUTValue/parseDitherModeStr/
//              parseReconModeStr/parseRgbMaxDeltaStr/DEFAULT_RGB_MAX_DELTA.
//   sampler.ts buildFogTable/fogFactor/mipLevel/pickMipLevel/
//              lodBiasCompensation/capTextureSize/modulateLightmap
//           -> buildFogLUT01/fogTableIndex/mipLevelFor/pickMipLevelFor/
//              LOD_DITHER_MEAN/capCappedDims/applyOverbrightCPU.
//   upload.ts halveRGB/resampleRGBInto/nextPOT
//           -> halveRGBBox/resampleRGBBox (expanded-RGB only: the GPU always
//              uploads expanded RGB, so the indexed-input arms are dropped).

import { getCVarNumber, getCVarString } from '@q2/config';

// --- Bayer matrices (duplicate by value of voodoo/src/bayer.ts) -------------

// Row-major 4x4 Bayer matrix, values 0..15 (voodoo BAYER4, verbatim).
export const BAYER4: ReadonlyArray<number> = Object.freeze([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]);

// Row-major 2x2 Bayer matrix, values 0..3 (voodoo BAYER2, verbatim).
export const BAYER2: ReadonlyArray<number> = Object.freeze([0, 2, 3, 1]);

// Pre-quantise dither offsets in 8-bit units (voodoo DITHER_RB_POS /
// DITHER_G_POS, verbatim): offset = round((b - 7.5) * amp / 8),
// RB amp 4 (LSB 8 -> amplitude 4), G amp 2 (LSB 4 -> amplitude 2).
export const DITHER_RB4: ReadonlyArray<number> = Object.freeze(
  [-4, 0, -3, 1, 2, -2, 3, -1, -2, 2, -3, 1, 4, 0, 3, -1],
);
export const DITHER_G4: ReadonlyArray<number> = Object.freeze(
  [-2, 0, -1, 1, 1, -1, 2, 0, -1, 1, -2, 0, 2, 0, 1, -1],
);

// 2x2-mode offsets (voodoo DITHER2_RB_POS / DITHER2_G_POS, verbatim):
// offset = round((b - 1.5) * amp / 2); G asymmetry (+2 vs -1) is JS
// Math.round half-up on exact .5 fractions, kept verbatim.
export const DITHER_RB2: ReadonlyArray<number> = Object.freeze([-3, 1, 3, -1]);
export const DITHER_G2: ReadonlyArray<number> = Object.freeze([-1, 1, 2, 0]);

/** Dither offset for R/B at pixel (x, y) in 4x4 mode (voodoo ditherOffsetRB). */
export function ditherOffsetRB(x: number, y: number): number {
  return DITHER_RB4[((y & 3) << 2) | (x & 3)]!;
}

/** Dither offset for G at pixel (x, y) in 4x4 mode (voodoo ditherOffsetG). */
export function ditherOffsetG(x: number, y: number): number {
  return DITHER_G4[((y & 3) << 2) | (x & 3)]!;
}

/** Raw Bayer threshold 0..15 at pixel (x, y) for mip-dithering. */
export function bayerThreshold4(x: number, y: number): number {
  return BAYER4[((y & 3) << 2) | (x & 3)]!;
}

// --- RGB565 (duplicate of voodoo/src/resolve.ts quantise/expand) ------------

/** Pack 8:8:8 into RGB565 (truncating, voodoo quantiseRGB565). */
export function pack565(r: number, g: number, b: number): number {
  return (
    (((r & 0xf8) << 8) | ((g & 0xfc) << 3) | ((b & 0xf8) >> 3)) & 0xffff
  );
}

/** Expand RGB565 to 8:8:8 with bit replication (voodoo expandRGB565). */
export function expand565(v: number): [number, number, number] {
  const r5 = (v >> 11) & 31;
  const g6 = (v >> 5) & 63;
  const b5 = v & 31;
  return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)];
}

// --- Gamma (duplicate of voodoo/src/resolve.ts gammaLUT) --------------------

/**
 * Glide-style gamma LUT entry: out = round(255 * (i/255)^(1/gamma))
 * (voodoo gammaLUT, per-entry formula). gamma = 1 is the identity.
 * The GPU evaluates the same curve as pow(c, 1/gamma) in FS_APPEARANCE
 * (RAMDAC placement: after reconstruction); this CPU form pins spot values.
 */
export function gammaLUTValue(i: number, gamma: number): number {
  if (!(gamma > 0) || !Number.isFinite(gamma) || !Number.isInteger(i) || i < 0 || i > 255) {
    throw new Error(`[webgl-renderer] gammaLUTValue: bad i/gamma ${i}/${gamma}`);
  }
  return Math.min(255, Math.round(255 * Math.pow(i / 255, 1 / gamma)));
}

/** Full 256-entry gamma LUT (upload-time/spot-check helper). */
export function buildGammaLUT(gamma: number): Uint8Array {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = gammaLUTValue(i, gamma);
  return lut;
}

// --- Scanout profile parsing (duplicates of voodoo resolve.ts parsers) ------

export type DitherModeStr = '2x2' | '4x4';
export type ReconModeStr = 'legacy' | '2x2sub+2x2box' | '4x4sub+4x1';

/** vd_dithermode parse (voodoo parseDitherMode): only '2x2' is 2x2. */
export function parseDitherModeStr(s: string): DitherModeStr {
  return s === '2x2' ? '2x2' : '4x4';
}

/** vd_reconmode parse (voodoo parseReconMode): unknown -> matched default. */
export function parseReconModeStr(s: string): ReconModeStr {
  if (s === 'legacy') return 'legacy';
  return s === '4x4sub+4x1' ? '4x4sub+4x1' : '2x2sub+2x2box';
}

/** Default reconstruction thresholds (voodoo defaultRgbMaxDelta): 8,8,8. */
export const DEFAULT_RGB_MAX_DELTA: Readonly<[number, number, number]> = Object.freeze([8, 8, 8] as const);

/**
 * vd_rgbmaxdelta parse (voodoo parseRgbMaxDelta): 'r,g,b', each 0..63
 * clamped/rounded (hardware 6-bit fields, PG §6.5.2 bits 21:16/13:8/5:0);
 * unparseable components fall back to 0 (so an explicitly
 * cleared '0,0,0' parses to itself and disables edge substitution).
 */
export function parseRgbMaxDeltaStr(s: string): [number, number, number] {
  const parts = s.split(',');
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const v = Number((parts[i] ?? '').trim());
    out[i] = !Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 63 ? 63 : Math.round(v);
  }
  return out;
}

// --- Table fog (duplicate of voodoo/src/sampler.ts buildFogTable/fogFactor) -

/** Fog density for the 64-entry LUT upload (voodoo buildFogTable default). */
export const FOG_DENSITY = 3.0;

/**
 * 64-entry exp^2 fog LUT as 0..1 floats (voodoo buildFogTable, normalized):
 * entry[i] = 1 - exp(-(density * i/63)^2). [0] = 0 (no fog), [63] ~ 1.
 * Uploaded as a `uniform float uFogTable[64]`; the scene contribution is 0
 * in base1 (uFogAmount 0), so the state is live but inert there.
 */
export function buildFogLUT01(density = FOG_DENSITY): Float32Array {
  if (!(density >= 0) || !Number.isFinite(density)) {
    throw new Error(`[webgl-renderer] buildFogLUT01: bad density ${density}`);
  }
  const t = new Float32Array(64);
  for (let i = 0; i < 64; i++) {
    const x = (density * i) / 63;
    t[i] = 1 - Math.exp(-x * x);
  }
  return t;
}

/**
 * Fog table index for normalized depth w01 in [0, 1] (voodoo fogFactor):
 * clamp-to-edge, index (w01*64)|0. Pure; used by tests to pin the mapping.
 */
export function fogTableIndex(w01: number): number {
  if (!(w01 > 0)) return 0;
  if (w01 >= 1) return 63;
  return (w01 * 64) | 0;
}

// --- Mip LOD (duplicates of voodoo/src/sampler.ts mip policy) ---------------

/**
 * Hardware LOD-dithering average (voodoo lodBiasCompensation source):
 * when the single-TMU dither is ON the hardware averages +0.375 level, so
 * the single-level pick adds +0.375 to match the hardware mean. NOT smooth
 * trilinear and NOT anisotropy (both out of scope: GL_LINEAR_MIPMAP_NEAREST
 * spirit — one level, bilinear within it).
 */
export const LOD_DITHER_MEAN = 0.375;

/** Pinned proof-baseline LOD bias (vd_lodbias contract value). */
export const PINNED_LOD_BIAS = -0.35;

/**
 * Mipmap LOD (voodoo mipLevel): lod = log2(rho) + bias [+ 0.375 when the
 * dither path is on], clamped to [0, maxLevel]. rho <= 0 clamps to epsilon
 * (LOD 0); non-finite rho/bias throw. Sign follows the tLOD.lodbias
 * register: NEGATIVE bias favours finer detail.
 */
export function mipLevelFor(
  rho: number,
  bias: number,
  maxLevel = Number.POSITIVE_INFINITY,
  tlodDither = false,
): number {
  if (!Number.isFinite(rho) || !Number.isFinite(bias)) {
    throw new Error(`[webgl-renderer] mipLevelFor: rho/bias must be finite, got ${rho}, ${bias}`);
  }
  if (Number.isNaN(maxLevel)) {
    throw new Error(`[webgl-renderer] mipLevelFor: maxLevel must not be NaN`);
  }
  const r = rho <= 0 ? 1e-6 : rho;
  const lod = Math.log2(r) + bias + (tlodDither ? LOD_DITHER_MEAN : 0);
  if (!(lod > 0)) return 0;
  const cap = maxLevel < 0 ? 0 : maxLevel;
  return lod > cap ? cap : lod;
}

/**
 * Single-TMU "trilinear" pick (voodoo pickMipLevel): per-pixel choice of LOD
 * n or n+1 by comparing the fractional LOD against the Bayer threshold
 * (b/16) at this pixel — f * 16 <= bayer(x, y) ? n : n + 1. mipDither=false
 * degrades to round-to-nearest. maxLevel clamps. Deterministic (no RNG).
 */
export function pickMipLevelFor(
  lod: number,
  x: number,
  y: number,
  mipDither = true,
  maxLevel = 16,
): number {
  const clamped = lod < 0 ? 0 : lod;
  const n = clamped | 0;
  const f = clamped - n;
  let level: number;
  if (!mipDither) {
    level = f < 0.5 ? n : n + 1;
  } else {
    const b = BAYER4[((y & 3) << 2) | (x & 3)]!;
    level = f * 16 <= b ? n : n + 1;
  }
  return level > maxLevel ? maxLevel : level;
}

/**
 * CPU-sampler UV scale into the picked level (voodoo sampler contract):
 * muv = uv / (1 << lvl). On the GPU this scale is SUBSUMED by
 * textureLod(uDiffuse, vUV, float(lvl)) — the picked level is addressed in
 * its own coordinate space, which is exactly the scaled-UV equivalent —
 * so the shader passes level-0 texel-space UVs plus the integer level and
 * this function documents/pins the equivalence (table-driven in tests).
 */
export function mipUVScale(lvl: number): number {
  if (!Number.isInteger(lvl) || lvl < 0 || lvl > 16) {
    throw new Error(`[webgl-renderer] mipUVScale: lvl must be an int 0..16, got ${lvl}`);
  }
  return 1 / (1 << lvl);
}

/**
 * CPU mirror of the GPU `textureLod(map, sampleUv, lvl)` tap with REPEAT
 * wrap (the `voodooSampleMippedWarped` sample arm): bilinear in the picked
 * level, every tap positive-modulo wrapped. Texel units: texel (i, j)
 * occupies [i, i+1) x [j, j+1) (centre i+0.5), matching GL's (i+0.5)/w
 * convention, so i0 = floor(x - 0.5). Pure, typed arrays, no allocation;
 * GPU float rounding may differ by ~1 LSB. Used by the FOLLOW-3B pixel
 * regression to sample across repeat/face boundaries at fixed times.
 */
export function sampleLevelBilinearRepeat(
  data: Uint8Array,
  w: number,
  h: number,
  u: number,
  v: number,
): [number, number, number] {
  if (data.length < w * h * 3 || w < 1 || h < 1) {
    throw new Error(`[webgl-renderer] sampleLevelBilinearRepeat: bad ${w}x${h} level`);
  }
  const wrap = (i: number, n: number): number => ((i % n) + n) % n;
  const tap = (ix: number, iy: number): [number, number, number] => {
    const o = (wrap(iy, h) * w + wrap(ix, w)) * 3;
    return [data[o]!, data[o + 1]!, data[o + 2]!];
  };
  const x = u - 0.5;
  const y = v - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
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
}

// --- Upload-time resampling (duplicates of voodoo/src/upload.ts RGB arms) ---

/**
 * Voodoo3 max texture size helper (voodoo capTextureSize): repeatedly halve
 * until both dimensions fit max. max <= 0 disables the cap.
 */
export function capCappedDims(w: number, h: number, max = 256): { w: number; h: number } {
  if (!(max > 0)) return { w, h };
  while (w > max || h > max) {
    w = w > 1 ? w >> 1 : 1;
    h = h > 1 ? h >> 1 : 1;
  }
  return { w, h };
}

/**
 * Box resample for expanded-RGB uploads (voodoo resampleRGBInto, verbatim
 * footprint rule): each dst texel averages its full source footprint
 * (rounding half up). Clamp addressing is inherent (footprints clip to the
 * source) — the VOODOO-REPAIR-2 green-where-red fix is this clamp: taps
 * never wrap into foreign texels.
 */
export function resampleRGBBox(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8Array {
  if (src.length < srcW * srcH * 3) {
    throw new Error(`[webgl-renderer] resampleRGBBox: src too small`);
  }
  const out = new Uint8Array(dstW * dstH * 3);
  for (let dy = 0; dy < dstH; dy++) {
    let iy0 = (dy * srcH) / dstH | 0;
    let iy1 = Math.ceil(((dy + 1) * srcH) / dstH) - 1;
    if (iy1 < iy0) iy1 = iy0;
    if (iy0 < 0) iy0 = 0;
    if (iy1 >= srcH) iy1 = srcH - 1;
    for (let dx = 0; dx < dstW; dx++) {
      let ix0 = (dx * srcW) / dstW | 0;
      let ix1 = Math.ceil(((dx + 1) * srcW) / dstW) - 1;
      if (ix1 < ix0) ix1 = ix0;
      if (ix0 < 0) ix0 = 0;
      if (ix1 >= srcW) ix1 = srcW - 1;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let sy = iy0; sy <= iy1; sy++) {
        const row = sy * srcW;
        for (let sx = ix0; sx <= ix1; sx++) {
          const p = (row + sx) * 3;
          sr += src[p]!;
          sg += src[p + 1]!;
          sb += src[p + 2]!;
          n++;
        }
      }
      const half = n >> 1;
      const d = (dy * dstW + dx) * 3;
      out[d] = ((sr + half) / n) | 0;
      out[d + 1] = ((sg + half) / n) | 0;
      out[d + 2] = ((sb + half) / n) | 0;
    }
  }
  return out;
}

/** One mip level of expanded RGB. */
export interface MipLevelRGB {
  data: Uint8Array;
  w: number;
  h: number;
}

/**
 * Halve an expanded-RGB image by 2x2 box filtering (voodoo halveRGB):
 * odd dimensions cover the full footprint; floor at 1x1.
 */
export function halveRGBBox(src: Uint8Array, srcW: number, srcH: number): MipLevelRGB {
  const w = srcW > 1 ? srcW >> 1 : 1;
  const h = srcH > 1 ? srcH >> 1 : 1;
  return { data: resampleRGBBox(src, srcW, srcH, w, h), w, h };
}

/**
 * Build the full mip chain at upload (voodoo completeMipChainRGB spirit):
 * level 0 is the (already capped) base; each step halves until 1x1.
 * Upload-time allocation; never in the inner loop. Chains always terminate
 * at 1x1 so textureLod can never address an undefined level.
 */
export function buildMipChainRGB(base: Uint8Array, w: number, h: number): MipLevelRGB[] {
  if (base.length < w * h * 3) {
    throw new Error(`[webgl-renderer] buildMipChainRGB: base too small`);
  }
  const chain: MipLevelRGB[] = [{ data: base.slice(), w, h }];
  for (;;) {
    const last = chain[chain.length - 1]!;
    if (last.w === 1 && last.h === 1) break;
    chain.push(halveRGBBox(last.data, last.w, last.h));
  }
  return chain;
}

/**
 * Enforce vd_maxtexsize at upload with aspect-preserving box resampling:
 * dims via capCappedDims (repeated halving), texels via resampleRGBBox.
 * The contract allows clamp+warn like the CPU dims-helper; the GPU goes one
 * step further and actually resamples (box filter) so stored UVs stay valid
 * — recorded as closing the "real resampling pending" gap on the GPU path
 * while the CPU helper remains dims-only (see PROOF-4.md).
 */
export function downsampleToCap(
  rgb: Uint8Array,
  w: number,
  h: number,
  max: number,
): { data: Uint8Array; w: number; h: number; capped: boolean } {
  const cap = capCappedDims(w, h, max);
  if (cap.w === w && cap.h === h) return { data: rgb, w, h, capped: false };
  return { data: resampleRGBBox(rgb, w, h, cap.w, cap.h), w: cap.w, h: cap.h, capped: true };
}

// --- Turbulent water warp (GPU-FOLLOW-3 CPU mirror) --------------------------
//
// The CPU warps turbulent UVs per pixel (spans.ts runSubdivTurbulent, the
// ref_soft water rule): in 16.16 texel units,
//   wu = u + turbTable[(v_int + phase) & 1023]
//   wv = v + turbTable[(u_int + phase) & 1023]
// with turbTable[i] = round(16 + 15*sin(2*pi*i/1024)) (buildTurbTable,
// r_scan.c sintable equivalent, values 1..31) and
// phase = ((time*64)|0) & 1023 (frame.ts turbPhase, level-time seconds).
//
// The GPU evaluates the same rule in FS_LIT in closed form
// (16 + 15*sin(2*pi*idx/1024), no 1024-entry table upload); warpUv is the
// CPU-side pure mirror of that closed form, used by tests to pin the
// approximation against the real table. Agreement is within half a texel
// (table rounding) plus float-sin precision — an approximation, stated here,
// not bit-exact emulation. Indices use the integer texel part (floor for
// negative repeat UVs, matching (tv>>16) arithmetic shift + & 1023 mask via
// a positive modulo).

/** Warp phase for a level-time in seconds (frame.ts turbPhase rule: ((time*64)|0) & 1023). */
export function warpPhaseFor(timeSec: number): number {
  return ((timeSec * 64) | 0) & 1023;
}

/** Closed-form warp-table value at index 0..1023 (unrounded). */
export function warpTableValue(idx: number): number {
  return 16 + 15 * Math.sin((2 * Math.PI * idx) / 1024);
}

/**
 * Warped UVs in texel units for a turbulent surface at level-time timeSec.
 * Pure mirror of the FS_LIT voodooWarp chunk (same formula, same phase).
 */
export function warpUv(u: number, v: number, timeSec: number): [number, number] {
  const phase = warpPhaseFor(timeSec);
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  const pos = (x: number): number => ((x % 1024) + 1024) % 1024;
  const tu = warpTableValue(pos(iv + phase));
  const tv = warpTableValue(pos(iu + phase));
  return [u + tu, v + tv];
}

// --- Underwater screen warp (DIVERGENCE CPU mirror, D_WarpScreen) -------------
//
// FS_APPEARANCE warpSrcPx mirror (software top-origin orientation):
// phase = floor(mod(time*20,128)), table int(3+3*sin(2*pi*(idx%128)/128)),
// tv = table[(phase+vTop)%1280], tu = table[(phase+u)%1280],
// sx = ((tv+u)/(w+6))*w, syTop = ((vTop+tu)/(h+6))*h, sy = h-1-syTop.
// Pure, tested against apps/web underwater.ts warpTablesFor parity.

/** Underwater warp phase for level-time seconds (floor(mod(t*20,128)), 0..127). */
export function underwaterWarpPhaseFor(timeSec: number): number {
  if (!Number.isFinite(timeSec)) return 0;
  return Math.floor(((timeSec * 20) % 128 + 128) % 128);
}

/** Underwater warp table int at index (C truncation, values 0..6). */
export function underwaterWarpIntAt(idx: number): number {
  const c = ((idx % 128) + 128) % 128;
  return Math.floor(3 + 3 * Math.sin((2 * Math.PI * c) / 128));
}

/** Underwater screen-warp source pixel (GL bottom-origin in/out, software top-origin inside). */
export function underwaterWarpSrc(
  x: number,
  y: number,
  w: number,
  h: number,
  timeSec: number,
): [number, number] {
  const phase = underwaterWarpPhaseFor(timeSec);
  const vTop = h - 1 - y;
  const tv = underwaterWarpIntAt((phase + vTop) % 1280);
  const tu = underwaterWarpIntAt((phase + x) % 1280);
  const sx = Math.floor(((tv + x) / (w + 6)) * w);
  const syTop = Math.floor(((vTop + tu) / (h + 6)) * h);
  return [sx, h - 1 - syTop];
}

// --- Lightmap overbright (duplicate of voodoo modulateLightmap, CPU form) ---

/**
 * No per-pixel overbright on Voodoo: diffuse x lightmap x (overbright ? 2:1),
 * clamped (voodoo modulateLightmap). The GPU evaluates the same rule in-shader
 * (uOverbright uniform); this CPU form pins spot values in tests.
 */
export function applyOverbrightCPU(tr: number, lr: number, overbright: boolean): number {
  const v = ((tr * lr * (overbright ? 2 : 1) + 127) / 255) | 0;
  return v > 255 ? 255 : v;
}

// --- Per-frame appearance state (reads @q2/config vd_* cvars) ---------------

/** Resolved per-frame Voodoo appearance state (live cvar snapshot). */
export interface AppearanceFrame {
  /** vd_dither: ordered dither at target writes (independent of mip dither). */
  dither: boolean;
  /** vd_dithermode: write-matrix profile ('4x4' default). */
  ditherMode: DitherModeStr;
  /** vd_postfilter: matched reconstruction on output (off = quantized target). */
  postfilter: boolean;
  /** vd_reconmode: scanout profile (matched 2x2 default; legacy = plain box). */
  reconMode: ReconModeStr;
  /** vd_rgbmaxdelta: per-component edge-rejection thresholds. */
  rgbMaxDelta: [number, number, number];
  /** vd_gamma: display-stage transfer LUT after reconstruction. */
  gamma: number;
  /** vd_16bit: RGB565 quantize on; off = RGB888 debug bypass. */
  use16bit: boolean;
  /** vd_overbright: lightmap modulate x2 + clamp (1) or x1 (0). */
  overbright: boolean;
  /** vd_fog: capability gate for the 64-entry table-fog state. */
  fogEnabled: boolean;
  /** vd_lodbias: added to log2(rho); pinned -0.35 for the proof baseline. */
  lodBias: number;
  /** vd_mipdither: single-TMU LOD n/n+1 dither pick (off = round-to-nearest). */
  mipDither: boolean;
  /** vd_bilinear: LINEAR filtering (off = NEAREST point sampling). */
  bilinear: boolean;
  /** vd_maxtexsize: upload cap (upload-time; default 256). */
  maxtexsize: number;
  /** vd_zbits: depth precision at target creation (default 16). */
  zbits: number;
}

/** Snapshot every vd_* cvar into one frame-reused state (mirrors readVoodooState). */
export function resolveAppearanceFrame(): AppearanceFrame {
  return {
    dither: getCVarNumber('vd_dither') !== 0,
    ditherMode: parseDitherModeStr(getCVarString('vd_dithermode')),
    postfilter: getCVarNumber('vd_postfilter') !== 0,
    reconMode: parseReconModeStr(getCVarString('vd_reconmode')),
    rgbMaxDelta: parseRgbMaxDeltaStr(getCVarString('vd_rgbmaxdelta')),
    gamma: getCVarNumber('vd_gamma'),
    use16bit: getCVarNumber('vd_16bit') !== 0,
    overbright: getCVarNumber('vd_overbright') !== 0,
    fogEnabled: getCVarNumber('vd_fog') !== 0,
    lodBias: getCVarNumber('vd_lodbias'),
    mipDither: getCVarNumber('vd_mipdither') !== 0,
    bilinear: getCVarNumber('vd_bilinear') !== 0,
    maxtexsize: getCVarNumber('vd_maxtexsize'),
    zbits: getCVarNumber('vd_zbits'),
  };
}

/** reconMode -> FS_APPEARANCE uReconMode int (0 legacy, 1 matched-2x2, 2 4x4sub+4x1). */
export function reconModeToInt(m: ReconModeStr): number {
  return m === 'legacy' ? 0 : m === '4x4sub+4x1' ? 2 : 1;
}

/** ditherMode -> FS_APPEARANCE uDitherMode int (0 = 2x2, 1 = 4x4). */
export function ditherModeToInt(m: DitherModeStr): number {
  return m === '2x2' ? 0 : 1;
}

// --- GLSL chunks shared by the scene programs (shaders.ts interpolates) -----

/** Canonical 4x4 Bayer table as GLSL (row-major BAYER4, absolute phase). */
export const GLSL_BAYER4 =
  `const int VOODOO_BAYER4[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);\n`;

/**
 * Single-TMU mip policy chunk (fragment stage): uniforms + LOD + dithered
 * n/n+1 pick + level sampling. Interpretation notes (see PROOF-4.md):
 * - uLodBias is live (vd_lodbias, pinned -0.35); the +0.375 single-TMU mean
 *   applies ONLY on the dither path (voodoo lodBiasCompensation rule).
 * - The CPU's explicit "scale UVs into the picked level (1/(1<<lvl))" is
 *   subsumed by textureLod(map, vUV, lvl): the picked level is addressed in
 *   its own coordinate space. vUV stays level-0 texel space everywhere.
 * - Lightmaps are deliberately NOT mipped (plain texture(), LINEAR): the CPU
 *   bakes per-miplevel surface blocks, which has no GPU equivalent here.
 */
export const GLSL_MIP_POLICY = `\
uniform float uLodBias;
uniform int uMipDither;
uniform int uMaxLevel;
${GLSL_BAYER4}
float voodooLod(sampler2D map, vec2 uv) {
  vec2 tsz = vec2(textureSize(map, 0));
  vec2 t = uv * tsz;
  float rho = max(length(dFdx(t)), length(dFdy(t)));
  rho = max(rho, 1.0e-6);
  float comp = (uMipDither != 0) ? 0.375 : 0.0;
  return log2(rho) + uLodBias + comp;
}
int voodooPickLevel(float lod, ivec2 px) {
  float c = clamp(lod, 0.0, float(uMaxLevel));
  int n = int(floor(c));
  float f = c - float(n);
  int lvl;
  if (uMipDither != 0) {
    int b = VOODOO_BAYER4[(px.y & 3) * 4 + (px.x & 3)];
    lvl = (f * 16.0 <= float(b)) ? n : n + 1;
  } else {
    lvl = (f < 0.5) ? n : n + 1;
  }
  return min(lvl, uMaxLevel);
}
// Turbulent-water tap (GPU-FOLLOW-3B): LOD/level from the UNWARPED coords
// (CPU spanLod parity — spans.ts builds spanLod from unwarped screen-space
// gradients, then warps only the diffuse lookup), sample at the warped
// coords. The old single-arg call on warped UVs folded the warp's
// floor() steps into fwidth derivatives, flipping the Bayer n/n+1 pick
// along integer texel lines (tile-grid seams). Warp offsets only the tap.
// NOTE: Warped is defined BEFORE Mipped — GLSL ES requires declaration
// before use (ANGLE rejects forward references that stub-GL tolerates).
vec3 voodooSampleMippedWarped(sampler2D map, vec2 lodUv, vec2 sampleUv) {
  float lod = voodooLod(map, lodUv);
  int lvl = voodooPickLevel(lod, ivec2(gl_FragCoord.xy));
  return textureLod(map, sampleUv, float(lvl)).rgb;
}
vec3 voodooSampleMipped(sampler2D map, vec2 uv) {
  return voodooSampleMippedWarped(map, uv, uv);
}
`;

/**
 * Table-fog + overbright chunk (fragment stage). Placement matches the CPU
 * shadePixel order: overbright modulate x2 + clamp FIRST, then fog blend
 * toward uFogColor. uFogAmount is the SCENE contribution (0 in base1 — no
 * haze — nonzero only via the forced-fog test hook); vd_fog gates the state.
 */
export const GLSL_FOG_OVERBRIGHT = `\
uniform float uOverbright;
uniform int uFogEnabled;
uniform float uFogAmount;
uniform vec3 uFogColor;
uniform float uFogTable[64];
vec3 voodooOverbright(vec3 c) {
  return min(c * uOverbright, vec3(1.0));
}
vec3 voodooApplyFog(vec3 col, float w01) {
  if (uFogEnabled == 0) return col;
  if (!(uFogAmount > 0.0)) return col;
  float t = clamp(w01, 0.0, 1.0);
  int fi = min(int(t * 64.0), 63);
  float f = clamp(uFogTable[fi] * uFogAmount, 0.0, 1.0);
  return mix(col, uFogColor, f);
}
`;

// --- Fullscreen appearance shaders (production GLSL ES 3.00) -----------------

/**
 * Fullscreen-triangle vertex shader: buffer-less (gl_VertexID), positions
 * (-1,-1)/(3,-1)/(-1,3) cover the viewport in one triangle; vUV is carried
 * for reviewability (the fragment stage uses texelFetch, never filtering).
 */
export const VS_POST = `#version 300 es
out vec2 vUV;
void main() {
  // Covering triangle (-1,-1),(3,-1),(-1,3): every viewport fragment is
  // inside, overscan corners clip away. (A (0,0),(2,0),(0,2) triangle covers
  // only the x+y<=0 half — caught by the resolve-coverage fixture.)
  vec2 p = vec2(float((gl_VertexID & 1) << 2), float((gl_VertexID & 2) << 1));
  vUV = p * 0.5;
  gl_Position = vec4(p - 1.0, 0.0, 1.0);
}
`;

/**
 * Appearance fragment shader: the GPU resolve + scanout, resident on GPU
 * through presentation (the linear scene target is sampled, the canvas is
 * written; the normal path never reads back).
 *
 * Order (voodoo resolve.ts RAMDAC order): dither -> RGB565 quantize ->
 * reconstruction/box -> display gamma. Alpha is preserved verbatim through
 * every path (blend-pass invariant: translucents were composited in the
 * linear target in draw order; the appearance pass must not touch alpha).
 *
 * Uniform interpretation (vd_* live uniforms, set per frame):
 * - uDitherOn/uDitherMode: write-matrix dither (4x4 default, 2x2 alias).
 * - uPostfilter: 0 shows the quantized target directly (per-pixel expand,
 *   every pixel rewritten — never stale), then display gamma.
 * - uReconMode: 0 legacy (unconditional 2x2 box, NO subtract, NO substitution);
 *   1 matched 2x2sub+2x2box (subtract the MODE's 2x2 pattern, substitute);
 *   2 4x4sub+4x1 (subtract 4x4, centered [x-1,x+2] window, row substitute).
 *   The subtract matrix is dictated by the MODE, never by uDitherMode
 *   (voodoo matched-reinforcement rule); with dither off there is no
 *   subtract (ditherSub = null rule). Taps use absolute screen coordinates
 *   (gl_FragCoord) so tiled/banded work stays seamless.
 * - uRgbMaxDelta: per-component substitute-with-centre thresholds (PG §6.5.2,
 *   6-bit 0..63); 0,0,0 disables (= unconditional box). Breaching components
 *   are replaced with the centre tap before the box filter (per-tap deviation
 *   from centre, not block spread).
 * - uGamma: display-stage transfer AFTER reconstruction (RAMDAC placement):
 *   pow(c, 1/gamma), the shader form of gammaLUTValue.
 * - u16bit: 0 = RGB888 debug bypass (gamma on, dither/recon off).
 */
export const FS_APPEARANCE = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform int uDitherOn;
uniform int uDitherMode;
uniform int uPostfilter;
uniform int uReconMode;
uniform vec3 uRgbMaxDelta;
uniform float uGamma;
uniform int u16bit;
uniform int uWarpOn;
uniform float uWarpTime;
out vec4 oColor;
const int BAYER4A[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
const int BAYER2A[4] = int[4](0, 2, 3, 1);
const int DITHRB4[16] = int[16](-4, 0, -3, 1, 2, -2, 3, -1, -2, 2, -3, 1, 4, 0, 3, -1);
const int DITHG4[16] = int[16](-2, 0, -1, 1, 1, -1, 2, 0, -1, 1, -2, 0, 2, 0, 1, -1);
const int DITHRB2[4] = int[4](-3, 1, 3, -1);
const int DITHG2[4] = int[4](-1, 1, 2, 0);
int ditherPhase(ivec2 px) {
  if (uDitherMode == 0) return ((px.y & 1) << 1) | (px.x & 1);
  return ((px.y & 3) << 2) | (px.x & 3);
}
vec3 ditherOffAt(int ph) {
  if (uDitherMode == 0) {
    return vec3(float(DITHRB2[ph]), float(DITHG2[ph]), float(DITHRB2[ph]));
  }
  return vec3(float(DITHRB4[ph]), float(DITHG4[ph]), float(DITHRB4[ph]));
}
int subPhase(ivec2 px, int two) {
  if (two != 0) return ((px.y & 1) << 1) | (px.x & 1);
  return ((px.y & 3) << 2) | (px.x & 3);
}
vec3 subOffAt(int ph, int two) {
  if (two != 0) {
    return vec3(float(DITHRB2[ph]), float(DITHG2[ph]), float(DITHRB2[ph]));
  }
  return vec3(float(DITHRB4[ph]), float(DITHG4[ph]), float(DITHRB4[ph]));
}
vec3 fetchLin(ivec2 px, ivec2 size) {
  ivec2 pc = clamp(px, ivec2(0), size - ivec2(1));
  return texelFetch(uScene, pc, 0).rgb;
}
float fetchAlpha(ivec2 px, ivec2 size) {
  ivec2 pc = clamp(px, ivec2(0), size - ivec2(1));
  return texelFetch(uScene, pc, 0).a;
}
vec3 quantTap(ivec2 px, ivec2 size) {
  vec3 lin = fetchLin(px, size);
  vec3 v = lin * 255.0;
  if (uDitherOn != 0) v += ditherOffAt(ditherPhase(px));
  v = clamp(v, vec3(0.0), vec3(255.0));
  float r5 = floor(v.r / 8.0);
  float g6 = floor(v.g / 4.0);
  float b5 = floor(v.b / 8.0);
  return vec3(r5 * 8.0 + floor(r5 / 4.0), g6 * 4.0 + floor(g6 / 16.0), b5 * 8.0 + floor(b5 / 4.0));
}
bool gateDisabled() {
  return uRgbMaxDelta.r == 0.0 && uRgbMaxDelta.g == 0.0 && uRgbMaxDelta.b == 0.0;
}
vec3 subTap(vec3 tap, vec3 centre) {
  vec3 d = abs(tap - centre);
  return vec3(
    d.r > uRgbMaxDelta.r ? centre.r : tap.r,
    d.g > uRgbMaxDelta.g ? centre.g : tap.g,
    d.b > uRgbMaxDelta.b ? centre.b : tap.b
  );
}
vec3 reconLegacy(ivec2 px, ivec2 size) {
  vec3 a = quantTap(px, size);
  vec3 b = quantTap(px + ivec2(1, 0), size);
  vec3 c = quantTap(px + ivec2(0, 1), size);
  vec3 d = quantTap(px + ivec2(1, 1), size);
  return floor((a + b + c + d + vec3(2.0)) / 4.0);
}
vec3 recon2x2(ivec2 px, ivec2 size) {
  ivec2 q1 = px + ivec2(1, 0);
  ivec2 q2 = px + ivec2(0, 1);
  ivec2 q3 = px + ivec2(1, 1);
  vec3 a = quantTap(px, size);
  vec3 b = quantTap(q1, size);
  vec3 c = quantTap(q2, size);
  vec3 d = quantTap(q3, size);
  if (uDitherOn != 0) {
    a = clamp(a - subOffAt(subPhase(px, 1), 1), vec3(0.0), vec3(255.0));
    b = clamp(b - subOffAt(subPhase(q1, 1), 1), vec3(0.0), vec3(255.0));
    c = clamp(c - subOffAt(subPhase(q2, 1), 1), vec3(0.0), vec3(255.0));
    d = clamp(d - subOffAt(subPhase(q3, 1), 1), vec3(0.0), vec3(255.0));
  }
  if (gateDisabled()) return floor((a + b + c + d + vec3(2.0)) / 4.0);
  b = subTap(b, a);
  c = subTap(c, a);
  d = subTap(d, a);
  return floor((a + b + c + d + vec3(2.0)) / 4.0);
}
vec3 recon4x1(ivec2 px, ivec2 size) {
  ivec2 pa = px + ivec2(-1, 0);
  ivec2 pb = px;
  ivec2 pc = px + ivec2(1, 0);
  ivec2 pd = px + ivec2(2, 0);
  vec3 a = quantTap(pa, size);
  vec3 b = quantTap(pb, size);
  vec3 c = quantTap(pc, size);
  vec3 d = quantTap(pd, size);
  if (uDitherOn != 0) {
    a = clamp(a - subOffAt(subPhase(pa, 0), 0), vec3(0.0), vec3(255.0));
    b = clamp(b - subOffAt(subPhase(pb, 0), 0), vec3(0.0), vec3(255.0));
    c = clamp(c - subOffAt(subPhase(pc, 0), 0), vec3(0.0), vec3(255.0));
    d = clamp(d - subOffAt(subPhase(pd, 0), 0), vec3(0.0), vec3(255.0));
  }
  if (gateDisabled()) return floor((a + b + c + d + vec3(2.0)) / 4.0);
  a = subTap(a, b);
  c = subTap(c, b);
  d = subTap(d, b);
  return floor((a + b + c + d + vec3(2.0)) / 4.0);
}
// Underwater screen warp (DIVERGENCE from ref_gl, user-requested):
// ref_soft r_scan.c D_WarpScreen mirror in the appearance pass, applied to
// the scene-target fetch BEFORE dither/565/recon/gamma (warp-then-Voodoo,
// like software warp-then-palettize). Integer table:
//   intsintable[i] = int(3 + 3*sin(2*pi*(i%128)/128)) (r_main.c R_InitTurb,
//   AMP2=3/SPEED=20/CYCLE=128), phase = floor(mod(time*20,128)).
// dest[u,v] = src[col[tv+u], row[v+tu]] with col[i]=(i/(w+6))*w,
// row[i]=((i/(h+6))*h) (edge compression MARGIN=2*AMP2=6, underwater.ts
// warpTablesFor parity). Y uses the software top-origin convention:
// vTop = h-1-py so the phase matches the software warp orientation;
// the GL bottom-origin flip is undone around the lookup. uWarpOn 0 =
// verbatim passthrough (dry / ref_gl parity path).
int warpIntAt(int idx) {
  int c = idx - (idx / 128) * 128;
  float s = sin(6.283185307179586 * float(c) / 128.0);
  return int(floor(3.0 + 3.0 * s));
}
ivec2 warpSrcPx(ivec2 px, ivec2 size) {
  if (uWarpOn == 0) return px;
  float ph = floor(mod(uWarpTime * 20.0, 128.0));
  int vTop = size.y - 1 - px.y;
  int tv = warpIntAt(int(mod(ph + float(vTop), 1280.0)));
  int tu = warpIntAt(int(mod(ph + float(px.x), 1280.0)));
  int sx = int(float(tv + px.x) / float(size.x + 6) * float(size.x));
  int syTop = int(float(vTop + tu) / float(size.y + 6) * float(size.y));
  int sy = size.y - 1 - syTop;
  return ivec2(sx, sy);
}
void main() {
  ivec2 size = textureSize(uScene, 0);
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec2 srcPx = warpSrcPx(px, size);
  float alpha = fetchAlpha(srcPx, size);
  vec3 col;
  if (u16bit == 0) {
    col = fetchLin(srcPx, size);
  } else {
    if (uPostfilter == 0) {
      col = quantTap(srcPx, size) / 255.0;
      col = pow(max(col, vec3(0.0)), vec3(1.0 / uGamma));
      oColor = vec4(col, alpha);
      return;
    }
    vec3 rec;
    if (uReconMode == 0) rec = reconLegacy(srcPx, size);
    else if (uReconMode == 2) rec = recon4x1(srcPx, size);
    else rec = recon2x2(srcPx, size);
    col = rec / 255.0;
  }
  col = pow(max(col, vec3(0.0)), vec3(1.0 / uGamma));
  oColor = vec4(col, alpha);
}
`;

// --- GPU cvar interpretation table (mirrored in PROOF-4.md) ------------------

/** How each vd_* cvar is interpreted on the GPU (documented, reviewable). */
export interface CvarInterpretation {
  cvar: string;
  /** live-uniform (per-frame, no re-upload) | upload-time | target-creation | policy-note. */
  kind: 'live-uniform' | 'upload-time' | 'target-creation' | 'policy-note';
  note: string;
}

export const APPEARANCE_CVAR_DOC: ReadonlyArray<CvarInterpretation> = Object.freeze([
  { cvar: 'vd_gamma', kind: 'live-uniform', note: 'uGamma display LUT AFTER reconstruction (RAMDAC placement); 1.3 is a project preset, not a hardware constant.' },
  { cvar: 'vd_dither', kind: 'live-uniform', note: 'uDitherOn write-matrix dither at target resolve; independent of mip dithering.' },
  { cvar: 'vd_dithermode', kind: 'live-uniform', note: 'uDitherMode write matrix 4x4 (default) / 2x2; the scanout subtract matrix is dictated by vd_reconmode, never this.' },
  { cvar: 'vd_postfilter', kind: 'live-uniform', note: 'uPostfilter; off shows the quantized target per-pixel (never stale), then display gamma.' },
  { cvar: 'vd_reconmode', kind: 'live-uniform', note: 'uReconMode: matched 2x2sub+2x2box default; legacy = unconditional box alias; 4x4sub+4x1 centered window.' },
  { cvar: 'vd_rgbmaxdelta', kind: 'live-uniform', note: 'uRgbMaxDelta per-component substitute-with-centre thresholds (6-bit 0..63, per-tap deviation from centre); 0,0,0 disables (= unconditional box).' },
  { cvar: 'vd_16bit', kind: 'live-uniform', note: 'u16bit; =0 is the RGB888 debug bypass (gamma on, dither/reconstruction off), mirroring resolveRGB888.' },
  { cvar: 'vd_overbright', kind: 'live-uniform', note: 'uOverbright modulate x2 + clamp (clipping highlights like hardware); blanket x2 pending the gl_image audit.' },
  { cvar: 'vd_fog', kind: 'live-uniform', note: 'uFogEnabled capability gate; scene contribution (uFogAmount) is 0 in base1 — no haze expected.' },
  { cvar: 'vd_lodbias', kind: 'live-uniform', note: 'uLodBias added to log2(rho); pinned -0.35 for the proof baseline (negative favours finer).' },
  { cvar: 'vd_mipdither', kind: 'live-uniform', note: 'uMipDither single-TMU n/n+1 Bayer pick (avg +0.375 comp); =0 forces level-n LINEAR (round-to-nearest).' },
  { cvar: 'vd_bilinear', kind: 'live-uniform', note: 'Sampler MIN/MAG LINEAR vs NEAREST, switched per frame via texParameteri (no re-upload); mip levels still sampled with textureLod.' },
  { cvar: 'vd_maxtexsize', kind: 'upload-time', note: 'Cap enforced at upload: aspect-preserving box resample + recorded warning (closes the CPU dims-only gap on the GPU path).' },
  { cvar: 'vd_zbits', kind: 'target-creation', note: '<=16 requests DEPTH_COMPONENT16, >=24 requests DEPTH_COMPONENT24. GL depth tests BEFORE write (true pre-test policy), unlike the CPU post-hoc banding helper.' },
  { cvar: 'vd_palettetex', kind: 'policy-note', note: 'No paletted textures in WebGL: always uploads expanded RGB; filtering is identical either way (never gates filtering, per the CPU rule).' },
]);

// --- Non-vd_ cvar audit (GPU-FOLLOW-3: remaining behavior, unsupported labelled)
//
// Appearance-affecting cvars the CPU world path reads that the GPU backend
// does NOT honor. Listed explicitly so no silent divergence: each entry is
// a deliberate unsupported choice (out of scope for this card) or a pending
// audit. Changing any entry to honored behavior is a follow-up card, not a
// silent fix.
export const GPU_CVAR_GAPS: ReadonlyArray<CvarInterpretation> = Object.freeze([
  { cvar: 'r_translucency', kind: 'policy-note', note: 'UNSUPPORTED (=0 opaque fallback ignored): the GPU always blends translucent world surfaces (TRANS33/66 alpha) in the far->near blend pass. Set on the CPU by translucencyModeFromCvars; no GPU read.' },
  { cvar: 'sw_stipplealpha', kind: 'policy-note', note: 'UNSUPPORTED (screen-door stipple ignored): the GPU always true-blends; the CPU stipple path (mode 2) has no GPU equivalent. Documented deviation (true blending vs Voodoo screen-door).' },
  { cvar: 'r_drawworld', kind: 'policy-note', note: 'UNSUPPORTED (=0 world-hide ignored): the GPU always draws the submitted world selection. The play layer never sets it on the GPU path; hiding the world requires not submitting it.' },
  { cvar: 'sw_gamma', kind: 'policy-note', note: 'NOT READ (by design): the software 8-bit gamma path does not apply here; the GPU uses vd_gamma (display-stage RAMDAC placement) for the same role.' },
  { cvar: 'sw_workers', kind: 'policy-note', note: 'UNSUPPORTED (CPU execution knob ignored): the GPU backend issues one GL submission per frame; software banded-SAB worker count has no GPU equivalent.' },
  { cvar: 'sw_wasm', kind: 'policy-note', note: 'UNSUPPORTED (CPU execution knob ignored): selects the software TS/WASM span backend; the GPU backend never runs span fills.' },
  { cvar: 'sw_accum', kind: 'policy-note', note: 'UNSUPPORTED (CPU execution knob ignored): software frame-accumulation batching; the GPU backend has no frame accumulator.' },
]);
