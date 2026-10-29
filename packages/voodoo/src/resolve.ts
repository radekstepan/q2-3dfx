// @q2/voodoo — M4.1 resolve chain.
//
// Pipeline order (Glide on Voodoo3, guide §7.2): the display gamma LUT lives
// in the RAMDAC on the already-reconstructed signal:
//   8:8:8 framebuffer -> ordered dither -> RGB565 quantise
//   -> scanout reconstruction (matched subtract+box, or unconditional box
//      under the 'legacy' alias) for display
//   -> display gamma LUT.
// Single hardware-correct path for ALL reconmodes (postfilter on or off):
// linear dither+quant (gamma 1) -> reconstruction/box (subtract matrix
// dictated by the mode, never by vd_dithermode; 'legacy' = unconditional
// 2x2 box with NO subtraction, kept as a compat alias) -> display gamma LUT
// on the display plane via applyDisplayGamma. Postfilter-off follows the
// same rule with no reconstruction: linear pack -> expand -> display gamma
// (direct-view path).
// The RGB888 debug bypass keeps the historical LUT-on-source order (gamma
// on, dither/reconstruction off); gamma 1.0 disables the stage everywhere.
//   Depth: stored 1/z quantised to vd_zbits bits is a DISPLAY/BANDING
//   approximation only, NOT a depth-buffer emulation (see quantiseDepth).
//   True depth emulation must quantise BEFORE the depth test/write against
//   an internal quantized plane; Framebuffer.depth keeps its documented 1/z
//   semantics (frozen @q2/renderer-api contract).
//
// Conventions: colour is Uint32 0xAABBGGRR (see @q2/renderer-api Framebuffer).
// Inner loops use typed arrays only and allocate nothing.

import { DITHER2_G_POS, DITHER2_RB_POS, DITHER_G_POS, DITHER_RB_POS } from './bayer.js';

// --- Gamma ---------------------------------------------------------------

/** Cached LUT so the per-frame path allocates nothing. */
let cachedGamma = Number.NaN;
let cachedLUT: Uint8Array = new Uint8Array(256);

/**
 * Glide-style gamma lift LUT. out[i] = round(255 * (i/255)^(1/gamma)).
 * gamma = 1 is the identity. Glide default ~1.3 brightens midtones
 * (LUT[128] == 150 at gamma 1.3).
 */
export function gammaLUT(gamma: number): Uint8Array {
  if (!(gamma > 0) || !Number.isFinite(gamma)) {
    throw new Error(`[voodoo] gammaLUT: gamma must be > 0, got ${gamma}`);
  }
  if (gamma === cachedGamma) return cachedLUT;
  const lut = new Uint8Array(256);
  const inv = 1 / gamma;
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.min(255, Math.round(255 * Math.pow(i / 255, inv)));
  }
  cachedGamma = gamma;
  cachedLUT = lut;
  return lut;
}

/**
 * Display-stage gamma (guide §7.2 placement): apply the Glide transfer LUT
 * in place to a packed 0xFFBBGGRR display plane (alpha forced opaque, like
 * every other display-plane producer here). This is the RAMDAC stage — it
 * runs on the already-reconstructed signal, AFTER dither/quant/recon.
 * gamma = 1 validates then no-ops. Zero-alloc inner loop.
 *
 * Used by every quantise-on resolveFrame path: the 565 target is packed
 * linear (gamma 1), reconstructed (or box-filtered under the 'legacy'
 * alias), then this LUT runs on the display plane. Raster backends must NOT import
 * this to gamma-correct their own buffers — it is resolve-internal; call
 * resolveFrame and treat the display plane as final.
 */
export function applyDisplayGamma(dst32: Uint32Array, w: number, h: number, gamma: number): void {
  if (dst32.length < w * h) {
    throw new Error('[voodoo] applyDisplayGamma: buffer too small');
  }
  const lut = gammaLUT(gamma);
  if (gamma === 1) return;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const px = dst32[i]!;
    const r = lut[px & 255]!;
    const g = lut[(px >> 8) & 255]!;
    const b = lut[(px >> 16) & 255]!;
    dst32[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
}

// --- RGB565 quantise -----------------------------------------------------

const R5_MASK = 0b11111000;
const G6_MASK = 0b11111100;

/** Pack 8:8:8 into RGB565: (r5 << 11) | (g6 << 5) | b5, truncating. */
export function quantiseRGB565(r: number, g: number, b: number): number {
  return (((r & R5_MASK) << 8) | ((g & G6_MASK) << 3) | ((b & R5_MASK) >> 3)) & 0xffff;
}

/** Expand RGB565 back to 8:8:8 packed 0xFFBBGGRR with bit replication. */
export function expandRGB565(v: number): number {
  const r5 = (v >> 11) & 31;
  const g6 = (v >> 5) & 63;
  const b5 = v & 31;
  const r = (r5 << 3) | (r5 >> 2);
  const g = (g6 << 2) | (g6 >> 4);
  const b = (b5 << 3) | (b5 >> 2);
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

// --- Scanout profile data (vd_dithermode / vd_reconmode / vd_rgbmaxdelta) -----
//
// Read-path-only driver-profile selectors (registered in @q2/config).
// Values are snapshots in
// VoodooState; resolveFrame wires them into write dither + scanout. Every
// combination is a DETERMINISTIC APPROXIMATION until an HW capture
// establishes the MiniGL programming of fbzMode / vidProcCfg / rgbMaxDelta.

/** Ordered-dither matrix at target writes: '4x4' (default) or '2x2'. */
export type DitherMode = '2x2' | '4x4';

/**
 * Scanout reconstruction profile (vidProcCfg):
 * - '2x2sub+2x2box' (DEFAULT): subtract the 2x2 dither pattern, then 2x2
 *   box with rgbMaxDelta edge rejection — the matched hardware pairing.
 * - '4x4sub+4x1': subtract the 4x4 dither pattern, then a horizontal 4x1 box
 *   (centered window [x-1, x+2], clamp-to-edge) with rgbMaxDelta rejection.
 * - 'legacy': accepted alias for the unconditional 2x2 box with NO dither
 *   subtraction (compat/tests only) — same linear-pack + display-gamma
 *   placement as every other mode, just no subtract and no edge rejection.
 * The subtract matrix is dictated by the MODE, never by vd_dithermode: the
 * scanout filter is programmed for the mode's pattern regardless of the
 * write matrix. A mismatched write dither (e.g. 2x2 writes under 4x4sub+4x1
 * scanout) still subtracts the mode's pattern — deterministic and tolerated,
 * not an error (see resolveFrame matched-reconforcement comment). Pass
 * ditherSub = null when the write path ran dither-off.
 */
export type ReconMode = 'legacy' | '2x2sub+2x2box' | '4x4sub+4x1';

/** Parse vd_dithermode; anything but '2x2' falls back to '4x4'. */
export function parseDitherMode(s: string): DitherMode {
  return s === '2x2' ? '2x2' : '4x4';
}

/**
 * Parse vd_reconmode; 'legacy' stays an accepted alias for the
 * unconditional box (no subtraction). Unknown strings fall back to the
 * hardware-correct default '2x2sub+2x2box'.
 */
export function parseReconMode(s: string): ReconMode {
  if (s === 'legacy') return 'legacy';
  return s === '4x4sub+4x1' ? '4x4sub+4x1' : '2x2sub+2x2box';
}

export interface ResolveOptions {
  /** Glide gamma lift; 1.0 disables the stage. */
  gamma: number;
  /** Ordered dither before quantise (matrix selected by ditherMode). */
  dither: boolean;
  /** Dither matrix: '4x4' (default) or '2x2'. */
  ditherMode?: DitherMode;  /**
   * Quantise 8:8:8 -> 5:6:5 (vd_16bit). Off still packs 565 (round-to-nearest
   * instead of truncating) for backwards compatibility — it is NOT a true
   * bypass. Use resolveRGB888 for the genuine RGB888 debug path.
   */
  quantise: boolean;
}

export function defaultResolveOptions(): ResolveOptions {
  return { gamma: 1.3, dither: true, ditherMode: '4x4', quantise: true };
}

/**
 * M4.1 resolve: src 8:8:8 (0xAABBGGRR) -> dst RGB565.
 * Zero-alloc inner loop; reads the (cached) gamma LUT once per call.
 * NOTE (astra §2.2): quantise:false still packs 565, only changing the
 * rounding (round-to-nearest vs truncate). It is kept byte-compatible for
 * existing dst565 readers; the genuine RGB888 bypass is resolveRGB888.
 */
export function resolveRGB565(
  src: Uint32Array,
  dst: Uint16Array,
  w: number,
  h: number,
  opts: ResolveOptions = defaultResolveOptions(),
): void {
  if (dst.length < w * h || src.length < w * h) {
    throw new Error('[voodoo] resolveRGB565: buffer too small');
  }
  const lut = opts.gamma !== 1 ? gammaLUT(opts.gamma) : null;
  const n = w * h;
  // Hoisted dither-matrix select: branchless per-pixel phase; the table
  // pointer is fixed for the whole call (zero-alloc, no per-pixel branch on
  // mode — only the cheap opts.dither flag stays in the loop).
  const two = (opts.ditherMode ?? '4x4') === '2x2';
  const rbT = two ? DITHER2_RB_POS : DITHER_RB_POS;
  const gT = two ? DITHER2_G_POS : DITHER_G_POS;
  const xm = two ? 1 : 3;
  const ym = two ? 1 : 3;
  const sh = two ? 1 : 2;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const rowPh = (y & ym) << sh;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const px = src[i]!;
      let r = px & 255;
      let g = (px >> 8) & 255;
      let b = (px >> 16) & 255;
      if (lut !== null) {
        r = lut[r]!;
        g = lut[g]!;
        b = lut[b]!;
      }
      if (opts.dither) {
        const p = rowPh | (x & xm);
        r += rbT[p]!;
        g += gT[p]!;
        b += rbT[p]!;
        r = r < 0 ? 0 : r > 255 ? 255 : r;
        g = g < 0 ? 0 : g > 255 ? 255 : g;
        b = b < 0 ? 0 : b > 255 ? 255 : b;
      }
      if (opts.quantise) {
        dst[i] = quantiseRGB565(r, g, b);
      } else {
        // 16-bit path disabled: round to nearest instead of truncating.
        const r5 = (r + 4) >> 3;
        const g6 = (g + 2) >> 2;
        const b5 = (b + 4) >> 3;
        dst[i] =
          ((r5 > 31 ? 31 : r5) << 11) |
          ((g6 > 63 ? 63 : g6) << 5) |
          (b5 > 31 ? 31 : b5);
      }
    }
  }
}

// --- RGB888 debug bypass (vd_16bit off) ------------------------------------

export interface ResolveRGB888Options {
  /**
   * Display gamma lift; 1.0 disables the stage. The gamma stage REMAINS
   * active in this path (same LUT/semantics as resolveRGB565) — only the
   * quantise is bypassed. Documented per astra §2.2.
   */
  gamma: number;
  /**
   * Ordered dither before write. Default OFF in this path (per guide: there
   * is no quantiser for the dither to feed); enabling it just perturbs the
   * 8-bit values with the same pre-quantise offsets — a debug-only knob,
   * not hardware behaviour. Matrix selected by ditherMode ('4x4' default).
   */
  dither: boolean;
  /** Dither matrix used when dither is on: '4x4' (default) or '2x2'. */
  ditherMode?: DitherMode;
}

export function defaultResolveRGB888Options(): ResolveRGB888Options {
  return { gamma: 1.3, dither: false, ditherMode: '4x4' };
}

/**
 * Genuine RGB888 debug path (vd_16bit off): src 8:8:8 (0xAABBGGRR) -> dst32
 * 8:8:8 (0xFFBBGGRR, opaque alpha), preserving values that RGB565 cannot
 * represent. Applies the gamma LUT, optionally the ordered-dither offsets
 * (default off), and NO postfilter — the caller (resolveFrame) bypasses
 * dither reconstruction in this path. Zero-alloc inner loop.
 */
export function resolveRGB888(
  src: Uint32Array,
  dst32: Uint32Array,
  w: number,
  h: number,
  opts: ResolveRGB888Options = defaultResolveRGB888Options(),
): void {
  if (dst32.length < w * h || src.length < w * h) {
    throw new Error('[voodoo] resolveRGB888: buffer too small');
  }
  const lut = opts.gamma !== 1 ? gammaLUT(opts.gamma) : null;
  const n = w * h;
  // Hoisted dither-matrix select: branchless per-pixel phase; the table
  // pointer is fixed for the whole call (zero-alloc, no per-pixel branch on
  // mode — only the cheap opts.dither flag stays in the loop).
  const two = (opts.ditherMode ?? '4x4') === '2x2';
  const rbT = two ? DITHER2_RB_POS : DITHER_RB_POS;
  const gT = two ? DITHER2_G_POS : DITHER_G_POS;
  const xm = two ? 1 : 3;
  const ym = two ? 1 : 3;
  const sh = two ? 1 : 2;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const rowPh = (y & ym) << sh;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const px = src[i]!;
      let r = px & 255;
      let g = (px >> 8) & 255;
      let b = (px >> 16) & 255;
      if (lut !== null) {
        r = lut[r]!;
        g = lut[g]!;
        b = lut[b]!;
      }
      if (opts.dither) {
        const p = rowPh | (x & xm);
        r += rbT[p]!;
        g += gT[p]!;
        b += rbT[p]!;
        r = r < 0 ? 0 : r > 255 ? 255 : r;
        g = g < 0 ? 0 : g > 255 ? 255 : g;
        b = b < 0 ? 0 : b > 255 ? 255 : b;
      }
      dst32[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
}

// --- 2x2 "22-bit" box post filter ------------------------------------------

/**
 * Voodoo3 RAMDAC post filter: 2x2 box average of the dithered 565 buffer,
 * expanded back to 8:8:8 (0xFFBBGGRR) for display. Dither subtract + box is
 * what melts the Bayer pattern into smooth "22-bit" output. Edge pixels
 * replicate (clamp-to-edge). Zero-alloc.
 *
 * TAP ALIGNMENT (provisional but deterministic): the forward [x, x+1] window
 * origin and clamp-to-edge borders are a CHOICE — HW phase is uncalibrated.
 * Taps use absolute screen coordinates so worker bands stay seamless.
 */
export function applyPostFilter(src565: Uint16Array, dst32: Uint32Array, w: number, h: number): void {
  if (src565.length < w * h || dst32.length < w * h) {
    throw new Error('[voodoo] applyPostFilter: buffer too small');
  }
  for (let y = 0; y < h; y++) {
    const y1 = y + 1 < h ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const x1 = x + 1 < w ? x + 1 : x;
      const a = src565[y * w + x]!;
      const b = src565[y * w + x1]!;
      const c = src565[y1 * w + x]!;
      const d = src565[y1 * w + x1]!;
      // Expand each 565 tap to 8 bit (bit replication), then 2x2 box
      // average with rounding: (sum + 2) >> 2 per channel.
      const ar5 = (a >> 11) & 31;
      const br5 = (b >> 11) & 31;
      const cr5 = (c >> 11) & 31;
      const dr5 = (d >> 11) & 31;
      const ag6 = (a >> 5) & 63;
      const bg6 = (b >> 5) & 63;
      const cg6 = (c >> 5) & 63;
      const dg6 = (d >> 5) & 63;
      const ab5 = a & 31;
      const bb5 = b & 31;
      const cb5 = c & 31;
      const db5 = d & 31;
      const rSum =
        ((ar5 << 3) | (ar5 >> 2)) +
        ((br5 << 3) | (br5 >> 2)) +
        ((cr5 << 3) | (cr5 >> 2)) +
        ((dr5 << 3) | (dr5 >> 2));
      const gSum =
        ((ag6 << 2) | (ag6 >> 4)) +
        ((bg6 << 2) | (bg6 >> 4)) +
        ((cg6 << 2) | (cg6 >> 4)) +
        ((dg6 << 2) | (dg6 >> 4));
      const bSum =
        ((ab5 << 3) | (ab5 >> 2)) +
        ((bb5 << 3) | (bb5 >> 2)) +
        ((cb5 << 3) | (cb5 >> 2)) +
        ((db5 << 3) | (db5 >> 2));
      const r = (rSum + 2) >> 2;
      const g = (gSum + 2) >> 2;
      const bl = (bSum + 2) >> 2;
      dst32[y * w + x] = (0xff000000 | (bl << 16) | (g << 8) | r) >>> 0;
    }
  }
}

// --- Fused pack→recon→gamma (PERF-3) ------------------------------------------
//
// Byte-identical fusion of the resolveFrame quantise-on path. Each src pixel
// is dithered+packed exactly once (same ops as resolveRGB565, gamma 1) into
// dst565; display rows are reconstructed from the just-written (cache-hot)
// dst565 rows with the display-gamma LUT applied inline. This eliminates two
// full-frame passes (cold dst565 re-read + display re-read/re-write) and the
// threshold repack (resolve.ts used to pack p00..p11 then re-extract channels
// for the spread test — the pack/unpack round-trip is lossless for 8-bit
// channels, so spreads computed directly from the subtracted taps match
// exactly). Taps are expanded into locals (the old path allocated 4 objects
// per pixel via expandTap565). No scratch buffers, no per-frame allocation.
//
// PERF-NEXT-6 Lane D: the 565→8-bit expand + dither-subtract + clamp sequence
// (per tap-channel: extract field, expand ((v<<3)|(v>>2)), subtract the phase
// offset, clamp twice — ~7 integer ops x 12 tap-channels per pixel) runs
// through small phase-strided fusion tables (EXP_/SUB_ below, ~3.5KB total,
// L1-resident): one load per tap-channel. The tables are built with the SAME
// expressions as the loop ops they replace (structural bit-identity — every
// entry equals expand(clamp(sub))) and selected per frame by pointer swap, so
// the inner loop carries no mode/subtract branch. The edge gate keeps the
// Math.max/min spread form (a branchy manual min/max measured SLOWER).
//
// Equivalence pins: src/fused.test.ts (cross-product differential vs the
// manual pipeline + display golden). The exported stage functions above are
// untouched so the manual pipeline stays available as the oracle.

/** 5-bit -> 8-bit bit-replication expand, flat (R and B channels share it). */
const V5_TO_8: Readonly<Uint8Array> = (() => {
  const t = new Uint8Array(32);
  for (let v = 0; v < 32; v++) t[v] = (v << 3) | (v >> 2);
  return t;
})();

/** 6-bit -> 8-bit bit-replication expand (G channel), flat. */
const V6_TO_8: Readonly<Uint8Array> = (() => {
  const t = new Uint8Array(64);
  for (let v = 0; v < 64; v++) t[v] = (v << 2) | (v >> 4);
  return t;
})();

/**
 * Phase-strided plain expand is NOT used in the fused loops: interleaved A/B
 * showed plain-expand table loads lose to register-only shift/or when there
 * is no subtract to fuse (8.76ms ALU vs 10.58ms flat LUT on the dither-off
 * recon). Only the subtract-fusion tables below pay off.
 */

/**
 * [phase * 32 + q] = clamp(expand5(q) - DITHER2_RB_POS[phase]): 2x2-subtract
 * fusion for the R/B channels ('2x2sub+2x2box' scanout). Same expand, same
 * offset table, same clamp shape as the loop ops this replaces.
 */
const SUB2_RB: Readonly<Uint8Array> = (() => {
  const t = new Uint8Array(4 * 32);
  for (let ph = 0; ph < 4; ph++)
    for (let q = 0; q < 32; q++) {
      const v = V5_TO_8[q]! - DITHER2_RB_POS[ph]!;
      t[ph * 32 + q] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  return t;
})();

/** [phase * 64 + s] = clamp(expand6(s) - DITHER2_G_POS[phase]): G version. */
const SUB2_G: Readonly<Uint8Array> = (() => {
  const t = new Uint8Array(4 * 64);
  for (let ph = 0; ph < 4; ph++)
    for (let s = 0; s < 64; s++) {
      const v = V6_TO_8[s]! - DITHER2_G_POS[ph]!;
      t[ph * 64 + s] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  return t;
})();

/**
 * [phase * 32 + q] = clamp(expand5(q) - DITHER_RB_POS[phase]): 4x4-subtract
 * fusion for R/B ('4x4sub+4x1' scanout, 16 phases).
 */
const SUB4_RB: Readonly<Uint8Array> = (() => {
  const t = new Uint8Array(16 * 32);
  for (let ph = 0; ph < 16; ph++)
    for (let q = 0; q < 32; q++) {
      const v = V5_TO_8[q]! - DITHER_RB_POS[ph]!;
      t[ph * 32 + q] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  return t;
})();

/** [phase * 64 + s] = clamp(expand6(s) - DITHER_G_POS[phase]): G version. */
const SUB4_G: Readonly<Uint8Array> = (() => {
  const t = new Uint8Array(16 * 64);
  for (let ph = 0; ph < 16; ph++)
    for (let s = 0; s < 64; s++) {
      const v = V6_TO_8[s]! - DITHER_G_POS[ph]!;
      t[ph * 64 + s] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  return t;
})();

/** Ingredients for the fused quantise-on path (mirrors VoodooState subset). */
export interface FusedFrameOptions {
  dither: boolean;
  ditherMode: DitherMode;
  postfilter: boolean;
  reconmode: ReconMode;
  rgbmaxdelta: RgbMaxDelta;
  gamma: number;
}

/**
 * Pack one src row y into dst565 (linear transfer): identical per-pixel ops
 * to resolveRGB565 with gamma 1 and truncating quantise. Module-level (not a
 * closure) so the fused path allocates nothing per frame.
 */
function packLinearRow(
  src: Uint32Array,
  dst565: Uint16Array,
  w: number,
  y: number,
  dither: boolean,
  rbW: Readonly<Int8Array>,
  gW: Readonly<Int8Array>,
  xmW: number,
  ymW: number,
  shW: number,
): void {
  const rowPh = (y & ymW) << shW;
  let i = y * w;
  for (let x = 0; x < w; x++, i++) {
    const px = src[i]!;
    let r = px & 255;
    let g = (px >> 8) & 255;
    let b = (px >> 16) & 255;
    if (dither) {
      const p = rowPh | (x & xmW);
      r += rbW[p]!;
      g += gW[p]!;
      b += rbW[p]!;
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;
    }
    dst565[i] = quantiseRGB565(r, g, b);
  }
}

/**
 * Fused quantise-on resolve: pack rows into dst565 on demand, reconstruct
 * display rows from the hot dst565 rows, gamma LUT inline. Byte-identical to
 * the manual linear-pack → recon/box → display-gamma pipeline for every
 * reconmode, threshold, dither and gamma setting.
 */
export function resolveFusedFrame(
  src: Uint32Array,
  dst565: Uint16Array,
  display: Uint32Array,
  w: number,
  h: number,
  o: FusedFrameOptions,
): void {
  if (dst565.length < w * h || display.length < w * h || src.length < w * h) {
    throw new Error('[voodoo] resolveFusedFrame: buffer too small');
  }
  // Same validation order as applyDisplayGamma: LUT lookup (throws on bad
  // gamma) before the gamma==1 no-op.
  const lut = o.gamma !== 1 ? gammaLUT(o.gamma) : null;
  const dither = o.dither;
  const twoW = o.ditherMode === '2x2';
  const rbW = twoW ? DITHER2_RB_POS : DITHER_RB_POS;
  const gW = twoW ? DITHER2_G_POS : DITHER_G_POS;
  const xmW = twoW ? 1 : 3;
  const ymW = twoW ? 1 : 3;
  const shW = twoW ? 1 : 2;

  // --- Postfilter off: pack -> expand -> display gamma, one row at a time.
  // NOTE: plain expand stays ALU ops (shift/or): table loads measured SLOWER
  // than the register-only sequence when there is no subtract to fuse
  // (Lane D interleaved A/B: 8.76ms ALU vs 10.58ms flat LUT on the 2x2
  // dither-off recon at 640x480). Tables pay off only fused with subtract.
  if (!o.postfilter) {
    for (let y = 0; y < h; y++) {
      packLinearRow(src, dst565, w, y, dither, rbW, gW, xmW, ymW, shW);
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const v = dst565[i]!;
        const r5 = (v >> 11) & 31;
        const g6 = (v >> 5) & 63;
        const b5 = v & 31;
        let r = (r5 << 3) | (r5 >> 2);
        let g = (g6 << 2) | (g6 >> 4);
        let b = (b5 << 3) | (b5 >> 2);
        if (lut !== null) {
          r = lut[r]!;
          g = lut[g]!;
          b = lut[b]!;
        }
        display[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      }
    }
    return;
  }

  // --- '4x4sub+4x1': pack row, then horizontal 4-tap window from the hot row.
  if (o.reconmode === '4x4sub+4x1') {
    // Subtract fusion tables are mode-forced to the 4x4 pattern (same rule as
    // applyReconstruction4x1's ditherSub parameter). The dither-on arm loads
    // expand+subtract+clamp fused; the dither-off arm keeps the ALU expand —
    // plain-expand table loads measured slower than shift/or (see note above).
    // Frame-constant arm: perfectly predicted, same shape as the old if(subOn).
    const subOn = dither;
    const md = o.rgbmaxdelta;
    const gateOff = md.r === 0 && md.g === 0 && md.b === 0;
    const mdR = md.r;
    const mdG = md.g;
    const mdB = md.b;
    for (let y = 0; y < h; y++) {
      packLinearRow(src, dst565, w, y, dither, rbW, gW, xmW, ymW, shW);
      const row = y * w;
      const ph = (y & 3) << 2;
      for (let x = 0; x < w; x++) {
        const xa = x - 1 < 0 ? 0 : x - 1;
        const xb = x;
        const xc = x + 1 < w ? x + 1 : x;
        const xd = x + 2 < w ? x + 2 : xc;
        const va = dst565[row + xa]!;
        const vb = dst565[row + xb]!;
        const vc = dst565[row + xc]!;
        const vd = dst565[row + xd]!;
        const qa5 = (va >> 11) & 31;
        const qb5 = (vb >> 11) & 31;
        const qc5 = (vc >> 11) & 31;
        const qd5 = (vd >> 11) & 31;
        const qa6 = (va >> 5) & 63;
        const qb6 = (vb >> 5) & 63;
        const qc6 = (vc >> 5) & 63;
        const qd6 = (vd >> 5) & 63;
        const qaf = va & 31;
        const qbf = vb & 31;
        const qcf = vc & 31;
        const qdf = vd & 31;
        let ra: number;
        let ga: number;
        let ba: number;
        let rb: number;
        let gb: number;
        let bb: number;
        let rc: number;
        let gc: number;
        let bc: number;
        let rd: number;
        let gd: number;
        let bd: number;
        if (subOn) {
          // Expand + mode-forced 4x4 subtract fused per tap-channel (phase =
          // row phase | tap column phase). Bit-identical to expand-then-
          // subtract-then-clamp: each load equals that sequence.
          const fa = ph | (xa & 3);
          const fb = ph | (xb & 3);
          const fc = ph | (xc & 3);
          const fd = ph | (xd & 3);
          ra = SUB4_RB[fa * 32 + qa5]!;
          rb = SUB4_RB[fb * 32 + qb5]!;
          rc = SUB4_RB[fc * 32 + qc5]!;
          rd = SUB4_RB[fd * 32 + qd5]!;
          ga = SUB4_G[fa * 64 + qa6]!;
          gb = SUB4_G[fb * 64 + qb6]!;
          gc = SUB4_G[fc * 64 + qc6]!;
          gd = SUB4_G[fd * 64 + qd6]!;
          ba = SUB4_RB[fa * 32 + qaf]!;
          bb = SUB4_RB[fb * 32 + qbf]!;
          bc = SUB4_RB[fc * 32 + qcf]!;
          bd = SUB4_RB[fd * 32 + qdf]!;
        } else {
          ra = (qa5 << 3) | (qa5 >> 2);
          ga = (qa6 << 2) | (qa6 >> 4);
          ba = (qaf << 3) | (qaf >> 2);
          rb = (qb5 << 3) | (qb5 >> 2);
          gb = (qb6 << 2) | (qb6 >> 4);
          bb = (qbf << 3) | (qbf >> 2);
          rc = (qc5 << 3) | (qc5 >> 2);
          gc = (qc6 << 2) | (qc6 >> 4);
          bc = (qcf << 3) | (qcf >> 2);
          rd = (qd5 << 3) | (qd5 >> 2);
          gd = (qd6 << 2) | (qd6 >> 4);
          bd = (qdf << 3) | (qdf >> 2);
        }
        // Direct row-spread gate: identical to passesReconstructionThresholdRow
        // (pack/unpack of pa..pd is lossless for 8-bit channels). Per-channel
        // r-then-g-then-b early-out order preserved.
        let pass = gateOff;
        if (!pass) {
          const rs = Math.max(ra, rb, rc, rd) - Math.min(ra, rb, rc, rd);
          if (rs <= mdR) {
            const gs = Math.max(ga, gb, gc, gd) - Math.min(ga, gb, gc, gd);
            if (gs <= mdG) {
              const bs = Math.max(ba, bb, bc, bd) - Math.min(ba, bb, bc, bd);
              if (bs <= mdB) pass = true;
            }
          }
        }
        let r: number;
        let g: number;
        let b: number;
        if (pass) {
          r = (ra + rb + rc + rd + 2) >> 2;
          g = (ga + gb + gc + gd + 2) >> 2;
          b = (ba + bb + bc + bd + 2) >> 2;
        } else {
          r = rb;
          g = gb;
          b = bb;
        }
        if (lut !== null) {
          r = lut[r]!;
          g = lut[g]!;
          b = lut[b]!;
        }
        display[row + x] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      }
    }
    return;
  }

  // --- 'legacy' unconditional 2x2 box + display gamma. Own loop in the exact
  // accumulation shape of applyPostFilter (minimal live variables): pack one
  // row ahead, box from the hot dst565 rows, gamma inline.
  if (o.reconmode === 'legacy') {
    if (h > 0) packLinearRow(src, dst565, w, 0, dither, rbW, gW, xmW, ymW, shW);
    for (let y = 0; y < h; y++) {
      if (y + 1 < h) packLinearRow(src, dst565, w, y + 1, dither, rbW, gW, xmW, ymW, shW);
      const y1 = y + 1 < h ? y + 1 : y;
      const row0 = y * w;
      const row1 = y1 * w;
      for (let x = 0; x < w; x++) {
        const x1 = x + 1 < w ? x + 1 : x;
        const a = dst565[row0 + x]!;
        const bq = dst565[row0 + x1]!;
        const c = dst565[row1 + x]!;
        const dq = dst565[row1 + x1]!;
        const ar5 = (a >> 11) & 31;
        const br5 = (bq >> 11) & 31;
        const cr5 = (c >> 11) & 31;
        const dr5 = (dq >> 11) & 31;
        const ag6 = (a >> 5) & 63;
        const bg6 = (bq >> 5) & 63;
        const cg6 = (c >> 5) & 63;
        const dg6 = (dq >> 5) & 63;
        const ab5 = a & 31;
        const bb5 = bq & 31;
        const cb5 = c & 31;
        const db5 = dq & 31;
        const rSum =
          ((ar5 << 3) | (ar5 >> 2)) +
          ((br5 << 3) | (br5 >> 2)) +
          ((cr5 << 3) | (cr5 >> 2)) +
          ((dr5 << 3) | (dr5 >> 2));
        const gSum =
          ((ag6 << 2) | (ag6 >> 4)) +
          ((bg6 << 2) | (bg6 >> 4)) +
          ((cg6 << 2) | (cg6 >> 4)) +
          ((dg6 << 2) | (dg6 >> 4));
        const bSum =
          ((ab5 << 3) | (ab5 >> 2)) +
          ((bb5 << 3) | (bb5 >> 2)) +
          ((cb5 << 3) | (cb5 >> 2)) +
          ((db5 << 3) | (db5 >> 2));
        let r = (rSum + 2) >> 2;
        let g = (gSum + 2) >> 2;
        let b = (bSum + 2) >> 2;
        if (lut !== null) {
          r = lut[r]!;
          g = lut[g]!;
          b = lut[b]!;
        }
        display[row0 + x] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      }
    }
    return;
  }

  // --- '2x2sub+2x2box' matched recon: subtract the mode's 2x2 pattern, then
  // 2x2 box with edge rejection. Pack rows one ahead; reconstruct row y from
  // the hot dst565 rows y,y1. (2x2sub is the only remaining mode here: legacy
  // and 4x4sub returned above, and parseReconMode falls back to this default.)
  //
  // The dither-on arm loads expand+subtract+clamp fused from SUB2_* (one load
  // per tap-channel replaces extract+expand+subtract+clamp). The dither-off
  // arm keeps the ALU expand — plain-expand table loads measured SLOWER than
  // shift/or (Lane D interleaved A/B). Frame-constant arm, same shape as the
  // old if(subOn).
  const subOn = dither;
  const md = o.rgbmaxdelta;
  const gateOff = md.r === 0 && md.g === 0 && md.b === 0;
  const mdR = md.r;
  const mdG = md.g;
  const mdB = md.b;
  if (h > 0) packLinearRow(src, dst565, w, 0, dither, rbW, gW, xmW, ymW, shW);
  for (let y = 0; y < h; y++) {
    if (y + 1 < h) packLinearRow(src, dst565, w, y + 1, dither, rbW, gW, xmW, ymW, shW);
    const y1 = y + 1 < h ? y + 1 : y;
    const ph0 = (y & 1) << 1;
    const ph1 = (y1 & 1) << 1;
    const row0 = y * w;
    const row1 = y1 * w;
    for (let x = 0; x < w; x++) {
      const x1 = x + 1 < w ? x + 1 : x;
      const v00 = dst565[row0 + x]!;
      const v10 = dst565[row0 + x1]!;
      const v01 = dst565[row1 + x]!;
      const v11 = dst565[row1 + x1]!;
      const q00 = (v00 >> 11) & 31;
      const q10 = (v10 >> 11) & 31;
      const q01 = (v01 >> 11) & 31;
      const q11 = (v11 >> 11) & 31;
      const s00 = (v00 >> 5) & 63;
      const s10 = (v10 >> 5) & 63;
      const s01 = (v01 >> 5) & 63;
      const s11 = (v11 >> 5) & 63;
      const u00 = v00 & 31;
      const u10 = v10 & 31;
      const u01 = v01 & 31;
      const u11 = v11 & 31;
      let r0: number;
      let g0: number;
      let b0: number;
      let r1: number;
      let g1: number;
      let b1: number;
      let r2: number;
      let g2: number;
      let b2: number;
      let r3: number;
      let g3: number;
      let b3: number;
      if (subOn) {
        // Expand + mode-forced 2x2 subtract fused per tap-channel (phase =
        // row phase | tap column phase). Bit-identical to expand-then-
        // subtract-then-clamp: each load equals that sequence exactly.
        const f00 = ph0 | (x & 1);
        const f10 = ph0 | (x1 & 1);
        const f01 = ph1 | (x & 1);
        const f11 = ph1 | (x1 & 1);
        r0 = SUB2_RB[f00 * 32 + q00]!;
        r1 = SUB2_RB[f10 * 32 + q10]!;
        r2 = SUB2_RB[f01 * 32 + q01]!;
        r3 = SUB2_RB[f11 * 32 + q11]!;
        g0 = SUB2_G[f00 * 64 + s00]!;
        g1 = SUB2_G[f10 * 64 + s10]!;
        g2 = SUB2_G[f01 * 64 + s01]!;
        g3 = SUB2_G[f11 * 64 + s11]!;
        b0 = SUB2_RB[f00 * 32 + u00]!;
        b1 = SUB2_RB[f10 * 32 + u10]!;
        b2 = SUB2_RB[f01 * 32 + u01]!;
        b3 = SUB2_RB[f11 * 32 + u11]!;
      } else {
        r0 = (q00 << 3) | (q00 >> 2);
        g0 = (s00 << 2) | (s00 >> 4);
        b0 = (u00 << 3) | (u00 >> 2);
        r1 = (q10 << 3) | (q10 >> 2);
        g1 = (s10 << 2) | (s10 >> 4);
        b1 = (u10 << 3) | (u10 >> 2);
        r2 = (q01 << 3) | (q01 >> 2);
        g2 = (s01 << 2) | (s01 >> 4);
        b2 = (u01 << 3) | (u01 >> 2);
        r3 = (q11 << 3) | (q11 >> 2);
        g3 = (s11 << 2) | (s11 >> 4);
        b3 = (u11 << 3) | (u11 >> 2);
      }
      // Direct 2x2-spread gate: identical to passesReconstructionThreshold
      // (packing p00..p11 then re-extracting is lossless). Unconditional box
      // when all thresholds are zero.
      let r: number;
      let g: number;
      let b: number;
      if (gateOff) {
        r = (r0 + r1 + r2 + r3 + 2) >> 2;
        g = (g0 + g1 + g2 + g3 + 2) >> 2;
        b = (b0 + b1 + b2 + b3 + 2) >> 2;
      } else {
        const rs = Math.max(r0, r1, r2, r3) - Math.min(r0, r1, r2, r3);
        if (rs > mdR) {
          r = r0;
          g = g0;
          b = b0;
        } else {
          const gs = Math.max(g0, g1, g2, g3) - Math.min(g0, g1, g2, g3);
          if (gs > mdG) {
            r = r0;
            g = g0;
            b = b0;
          } else {
            const bs = Math.max(b0, b1, b2, b3) - Math.min(b0, b1, b2, b3);
            if (bs > mdB) {
              r = r0;
              g = g0;
              b = b0;
            } else {
              r = (r0 + r1 + r2 + r3 + 2) >> 2;
              g = (g0 + g1 + g2 + g3 + 2) >> 2;
              b = (b0 + b1 + b2 + b3 + 2) >> 2;
            }
          }
        }
      }
      if (lut !== null) {
        r = lut[r]!;
        g = lut[g]!;
        b = lut[b]!;
      }
      display[row0 + x] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
}

/**
 * Quantise stored 1/z depth to `bits` bits (vd_zbits, default 16):
 * q = round(v * (2^bits - 1)) / (2^bits - 1). In-place, zero-alloc.
 * bits >= 24 is a no-op (Float32 mantissa); bits <= 0 is a no-op.
 *
 * COMPAT ONLY — DISPLAY/BANDING APPROXIMATION, NOT a depth-buffer emulation
 * (astra §2.5). This runs post-hoc on already-resolved depth and therefore
 * cannot affect visibility: no depth test consults its output. For TRUE
 * pre-test depth policy see quantiseDepthBeforeTest + depthTestLess below,
 * which quantise to 0..2^bits-1 BEFORE each depth test/write (with a defined
 * clear value, compare op and tie rule derived from the projection near/far
 * planes), against a future internal quantized plane.
 * Framebuffer.depth keeps its documented 1/z semantics (frozen contract —
 * this helper never changes its meaning, only its banding).
 */
export function quantiseDepth(depth: Float32Array, bits = 16): void {
  if (!(bits > 0) || bits >= 24) return;
  const scale = (1 << bits) - 1;
  const inv = 1 / scale;
  for (let i = 0; i < depth.length; i++) {
    depth[i] = Math.round(depth[i]! * scale) * inv;
  }
}

// --- Pre-test Z-buffer policy (true depth emulation) -------------------------

/**
 * Normalized-depth clear value: the far plane (1.0) clears the quantized
 * plane to all-ones (0xFFFF at 16 bits). New geometry must be strictly
 * nearer to win (see depthTestLess).
 */
export const DEPTH_CLEAR_01 = 1.0;

/**
 * Quantise NORMALIZED depth to an integer depth-buffer value BEFORE the depth
 * test/write (guide §4 "Alpha, depth, fog and HUD"). depth01 is derived from
 * the SAME projection near/far planes used for clipping (0 = near, 1 = far),
 * clamped into range; bits is the vd_zbits profile (16 on hardware).
 * Returns round(depth01 * (2^bits - 1)) in [0, 2^bits - 1] (0..65535 at 16).
 * Pure (no allocation, no in-place mutation) — the rasterizer keeps a separate
 * internal quantized plane; Framebuffer.depth's 1/z semantics are untouched.
 * Throws on non-finite depth or non-integer bits outside 1..24.
 */
export function quantiseDepthBeforeTest(depth01: number, bits = 16): number {
  if (!Number.isFinite(depth01)) {
    throw new Error(`[voodoo] quantiseDepthBeforeTest: depth must be finite, got ${depth01}`);
  }
  if (!Number.isInteger(bits) || bits < 1 || bits > 24) {
    throw new Error(`[voodoo] quantiseDepthBeforeTest: bits must be an int 1..24, got ${bits}`);
  }
  const clamped = depth01 < 0 ? 0 : depth01 > 1 ? 1 : depth01;
  return Math.round(clamped * ((1 << bits) - 1));
}

/**
 * Z-buffer compare: LESS wins, ties keep the stored value.
 *
 * A new fragment writes iff quantNew < quantStored; coplanar/equal depths
 * keep the FIRST writer (stable, no z-fighting churn — coplanar surfaces
 * resolve deterministically in draw order). The plane clears to the quantized
 * DEPTH_CLEAR_01 (far), so any fragment nearer than far passes on a fresh
 * buffer. Pure.
 */
export function depthTestLess(quantNew: number, quantStored: number): boolean {
  return quantNew < quantStored;
}

// --- Internal quantized depth plane (true pre-test depthbuffer) --------------
//
// Z vs W MAPPING CONTRACT (guide §4 "Alpha, depth, fog and HUD").
//
// These helpers implement a Z-buffer: depth01 is NORMALIZED window depth,
// 0 = near plane, 1 = far plane, derived from the SAME projection near/far
// planes used for clipping. The future Voodoo rasterizer MUST derive depth01
// from clip space per fragment; with the engine's stored reciprocal depth
// invZ = 1/z (positive forward distance, i.e. Framebuffer.depth semantics):
//
//   depth01 = far/(far-near) - (far*near/(far-near)) * invZ
//
// (0 at invZ = 1/near, 1 at invZ = 1/far; clamp outside [near, far] —
// clipped geometry never produces it). Quantizing raw 1/z WITHOUT this
// near/far mapping is NOT either hardware operation: it is neither window-Z
// nor 1/W. W-BUFFER NOT IMPLEMENTED: a true W-buffer would instead quantize
// 1/W with the Voodoo3 hardware encoding (nonlinear, card-specific); that
// encoding is NOT implemented here — these helpers are Z-operation only,
// labeled accordingly.
//
// NEAR/FAR DERIVATION CONTRACT for the rasterizer: near/far come from the
// active projection setup (the same values feeding clipping); clear value is
// far (DEPTH_CLEAR_01 -> all-ones); compare is LESS; ties keep the stored
// value (first writer wins). Framebuffer.depth keeps its documented 1/z
// semantics untouched (frozen contract) — the quantized plane is a SEPARATE
// internal buffer owned by the Voodoo backend, never aliased to fb.depth.
//
//BITS: vd_zbits profile (16 = hardware); quantise to (1<<bits)-1.

/** Clear value for the quantized plane: all-ones (far) at any bit depth. */
export function depthClearValue(bits = 16): number {
  if (!Number.isInteger(bits) || bits < 1 || bits > 24) {
    throw new Error(`[voodoo] depthClearValue: bits must be an int 1..24, got ${bits}`);
  }
  return (1 << bits) - 1;
}

/**
 * Allocate the internal quantized depth plane, cleared to far (all-ones).
 * w/h must be positive ints. The rasterizer owns this buffer; it is never
 * Framebuffer.depth.
 */
export function createDepth16(w: number, h: number, bits = 16): Uint16Array {
  if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
    throw new Error(`[voodoo] createDepth16: w/h must be positive ints, got ${w}x${h}`);
  }
  return new Uint16Array(w * h).fill(depthClearValue(bits));
}

/** Clear the quantized plane to far (all-ones at `bits`). Zero-alloc. */
export function clearDepth16(plane: Uint16Array, bits = 16): void {
  plane.fill(depthClearValue(bits));
}

/**
 * Pre-test depth write: quantise depth01 (Z-operation, see contract above)
 * to `bits` BEFORE the test, compare LESS against the stored quantized
 * value, write on win. Ties keep the stored value (first writer wins —
 * coplanar geometry is stable, no churn). Returns true iff the fragment
 * passes (and was written). Throws on OOB pixels or non-finite depth
 * (rasterizer bugs fail loudly, never silently wrap).
 */
export function testAndWriteDepth16(
  plane: Uint16Array,
  w: number,
  h: number,
  x: number,
  y: number,
  depth01: number,
  bits = 16,
): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= w || y >= h) {
    throw new Error(`[voodoo] testAndWriteDepth16: pixel (${x},${y}) outside ${w}x${h}`);
  }
  const q = quantiseDepthBeforeTest(depth01, bits);
  const i = y * w + x;
  if (q < plane[i]!) {
    plane[i] = q;
    return true;
  }
  return false;
}

// --- Scanout reconstruction thresholds (vidProcCfg/rgbMaxDelta) --------------

/**
 * Per-component rejection thresholds for scanout reconstruction, mirroring
 * the rgbMaxDelta register (prog guide §vidProcCfg): when the 2x2 display
 * taps differ by more than the threshold in any channel, the block holds an
 * edge and must NOT be box-averaged away.
 *
 * APPROXIMATION UNTIL HW CAPTURE: the Quake II MiniGL programming of this
 * register is not yet established from a hardware capture, so the default
 * below is a placeholder (smooth gradients pass, hard edges reject); the
 * all-zero value disables the gate (unconditional box).
 */
export interface RgbMaxDelta {
  r: number;
  g: number;
  b: number;
}

/** Default reconstruction thresholds: smooth gradients pass, hard edges
 * reject. This IS the live default (see defaultVoodooState); the all-zero
 * value disables rejection (= unconditional box, e.g. under the 'legacy'
 * alias). Use parseRgbMaxDelta(getCVarString('vd_rgbmaxdelta')) for the
 * frame value. */
export function defaultRgbMaxDelta(): RgbMaxDelta {
  return { r: 8, g: 8, b: 8 };
}

/**
 * Parse vd_rgbmaxdelta ('r,g,b', each 0..255, clamped; unparseable or missing
 * components fall back to 0). '0,0,0' disables rejection:
 * passesReconstructionThreshold returns true unconditionally, i.e. an
 * unconditional box. The live voodoo default is {8,8,8} (see
 * defaultRgbMaxDelta); the parse fallback stays per-component 0 so an
 * explicitly cleared cvar ('0,0,0' as registered in @q2/config) keeps
 * parsing to itself.
 */
export function parseRgbMaxDelta(s: string): RgbMaxDelta {
  const parts = s.split(',');
  const nums: number[] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const v = Number((parts[i] ?? '').trim());
    nums[i] = !Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  return { r: nums[0]!, g: nums[1]!, b: nums[2]! };
}

/**
 * Edge-rejection gate for scanout reconstruction (vidProcCfg/rgbMaxDelta).
 * Returns true when the 2x2 block of packed 0xFFBBGGRR taps is smooth enough
 * to box-filter (per-channel spread <= the matching maxDelta component) and
 * false when any channel spread exceeds it (one-pixel edge: keep sharp, do
 * not blur the dither/edge away). Pure, zero-alloc.
 *
 * ALL-ZERO DISABLES THE GATE: maxDelta {0,0,0} returns true
 * unconditionally — an unconditional box (e.g. under the 'legacy' alias).
 * Nonzero thresholds reject per channel; a channel threshold of 0 while others are
 * nonzero still rejects on that channel (any spread > 0 fails), so enable
 * the gate with all three components (e.g. the {8,8,8} comparison profile).
 * Threshold programming is a DETERMINISTIC APPROXIMATION until HW capture.
 */
export function passesReconstructionThreshold(
  p00: number,
  p10: number,
  p01: number,
  p11: number,
  maxDelta: RgbMaxDelta,
): boolean {
  if (maxDelta.r === 0 && maxDelta.g === 0 && maxDelta.b === 0) return true;
  const r0 = p00 & 255;
  const r1 = p10 & 255;
  const r2 = p01 & 255;
  const r3 = p11 & 255;
  const g0 = (p00 >> 8) & 255;
  const g1 = (p10 >> 8) & 255;
  const g2 = (p01 >> 8) & 255;
  const g3 = (p11 >> 8) & 255;
  const b0 = (p00 >> 16) & 255;
  const b1 = (p10 >> 16) & 255;
  const b2 = (p01 >> 16) & 255;
  const b3 = (p11 >> 16) & 255;
  const rs = Math.max(r0, r1, r2, r3) - Math.min(r0, r1, r2, r3);
  if (rs > maxDelta.r) return false;
  const gs = Math.max(g0, g1, g2, g3) - Math.min(g0, g1, g2, g3);
  if (gs > maxDelta.g) return false;
  const bs = Math.max(b0, b1, b2, b3) - Math.min(b0, b1, b2, b3);
  if (bs > maxDelta.b) return false;
  return true;
}

/**
 * Row variant of the edge-rejection gate for the 4x1 filter: same
 * per-channel spread rule over four HORIZONTAL taps. All-zero disables.
 * Pure, zero-alloc.
 */
export function passesReconstructionThresholdRow(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  maxDelta: RgbMaxDelta,
): boolean {
  if (maxDelta.r === 0 && maxDelta.g === 0 && maxDelta.b === 0) return true;
  const rs =
    Math.max(p0 & 255, p1 & 255, p2 & 255, p3 & 255) -
    Math.min(p0 & 255, p1 & 255, p2 & 255, p3 & 255);
  if (rs > maxDelta.r) return false;
  const gs =
    Math.max((p0 >> 8) & 255, (p1 >> 8) & 255, (p2 >> 8) & 255, (p3 >> 8) & 255) -
    Math.min((p0 >> 8) & 255, (p1 >> 8) & 255, (p2 >> 8) & 255, (p3 >> 8) & 255);
  if (gs > maxDelta.g) return false;
  const bs =
    Math.max((p0 >> 16) & 255, (p1 >> 16) & 255, (p2 >> 16) & 255, (p3 >> 16) & 255) -
    Math.min((p0 >> 16) & 255, (p1 >> 16) & 255, (p2 >> 16) & 255, (p3 >> 16) & 255);
  if (bs > maxDelta.b) return false;
  return true;
}

// --- Matched scanout reconstruction (vidProcCfg §3) ---------------------------
//
// Dither SUBTRACTION + box, per hardware profile. The write path adds a
// per-pixel ordered-dither offset before 565 quantise; the scanout subtracts
// the SAME offset (recomputed from absolute screen coordinates — filter taps
// must use absolute coordinates so worker bands stay seamless) from each
// expanded 565 tap, clamps, then box-filters with rgbMaxDelta edge rejection
// (rejected pixels keep the dither-subtracted centre tap, sharp).
//
// DETERMINISTIC APPROXIMATIONS UNTIL HW CAPTURE: the subtract-then-filter
// order and the reject-keeps-centre rule follow vidProcCfg; exact tap weights,
// phase and the threshold programming are uncalibrated. Pass ditherSub = null
// when the write path ran with dither off (subtracting a pattern that was
// never added would corrupt the image).

/** Expand one 565 tap to 8-bit channels with bit replication. */
function expandTap565(v: number): { r: number; g: number; b: number } {
  const r5 = (v >> 11) & 31;
  const g6 = (v >> 5) & 63;
  const b5 = v & 31;
  return { r: (r5 << 3) | (r5 >> 2), g: (g6 << 2) | (g6 >> 4), b: (b5 << 3) | (b5 >> 2) };
}

/**
 * '2x2sub+2x2box': subtract the 2x2 dither pattern, then 2x2 box with edge
 * rejection. Zero-alloc inner loop; clamp-to-edge borders. TAP ALIGNMENT
 * (provisional but deterministic): forward [x, x+1] window like the legacy
 * box; absolute screen coordinates so worker bands stay seamless.
 */
export function applyReconstruction2x2(
  src565: Uint16Array,
  dst32: Uint32Array,
  w: number,
  h: number,
  maxDelta: RgbMaxDelta,
  ditherSub: DitherMode | null,
): void {
  if (src565.length < w * h || dst32.length < w * h) {
    throw new Error('[voodoo] applyReconstruction2x2: buffer too small');
  }
  const sub2 = ditherSub === '2x2';
  const rbT = sub2 ? DITHER2_RB_POS : DITHER_RB_POS;
  const gT = sub2 ? DITHER2_G_POS : DITHER_G_POS;
  const sub = ditherSub !== null;
  // Phase masks for the subtract pattern (branchless, hoisted).
  const xm = sub2 ? 1 : 3;
  const ym = sub2 ? 1 : 3;
  const sh = sub2 ? 1 : 2;
  for (let y = 0; y < h; y++) {
    const y1 = y + 1 < h ? y + 1 : y;
    const ph0 = (y & ym) << sh;
    const ph1 = (y1 & ym) << sh;
    for (let x = 0; x < w; x++) {
      const x1 = x + 1 < w ? x + 1 : x;
      const i00 = y * w + x;
      const i10 = y * w + x1;
      const i01 = y1 * w + x;
      const i11 = y1 * w + x1;
      const e00 = expandTap565(src565[i00]!);
      const e10 = expandTap565(src565[i10]!);
      const e01 = expandTap565(src565[i01]!);
      const e11 = expandTap565(src565[i11]!);
      let r0 = e00.r;
      let g0 = e00.g;
      let b0 = e00.b;
      let r1 = e10.r;
      let g1 = e10.g;
      let b1 = e10.b;
      let r2 = e01.r;
      let g2 = e01.g;
      let b2 = e01.b;
      let r3 = e11.r;
      let g3 = e11.g;
      let b3 = e11.b;
      if (sub) {
        const s00 = rbT[ph0 | (x & xm)]!;
        const s10 = rbT[ph0 | (x1 & xm)]!;
        const s01 = rbT[ph1 | (x & xm)]!;
        const s11 = rbT[ph1 | (x1 & xm)]!;
        const t00 = gT[ph0 | (x & xm)]!;
        const t10 = gT[ph0 | (x1 & xm)]!;
        const t01 = gT[ph1 | (x & xm)]!;
        const t11 = gT[ph1 | (x1 & xm)]!;
        r0 = r0 - s00 < 0 ? 0 : r0 - s00 > 255 ? 255 : r0 - s00;
        g0 = g0 - t00 < 0 ? 0 : g0 - t00 > 255 ? 255 : g0 - t00;
        b0 = b0 - s00 < 0 ? 0 : b0 - s00 > 255 ? 255 : b0 - s00;
        r1 = r1 - s10 < 0 ? 0 : r1 - s10 > 255 ? 255 : r1 - s10;
        g1 = g1 - t10 < 0 ? 0 : g1 - t10 > 255 ? 255 : g1 - t10;
        b1 = b1 - s10 < 0 ? 0 : b1 - s10 > 255 ? 255 : b1 - s10;
        r2 = r2 - s01 < 0 ? 0 : r2 - s01 > 255 ? 255 : r2 - s01;
        g2 = g2 - t01 < 0 ? 0 : g2 - t01 > 255 ? 255 : g2 - t01;
        b2 = b2 - s01 < 0 ? 0 : b2 - s01 > 255 ? 255 : b2 - s01;
        r3 = r3 - s11 < 0 ? 0 : r3 - s11 > 255 ? 255 : r3 - s11;
        g3 = g3 - t11 < 0 ? 0 : g3 - t11 > 255 ? 255 : g3 - t11;
        b3 = b3 - s11 < 0 ? 0 : b3 - s11 > 255 ? 255 : b3 - s11;
      }
      const p00 = (0xff000000 | (b0 << 16) | (g0 << 8) | r0) >>> 0;
      const p10 = (0xff000000 | (b1 << 16) | (g1 << 8) | r1) >>> 0;
      const p01 = (0xff000000 | (b2 << 16) | (g2 << 8) | r2) >>> 0;
      const p11 = (0xff000000 | (b3 << 16) | (g3 << 8) | r3) >>> 0;
      let r: number;
      let g: number;
      let b: number;
      if (passesReconstructionThreshold(p00, p10, p01, p11, maxDelta)) {
        r = (r0 + r1 + r2 + r3 + 2) >> 2;
        g = (g0 + g1 + g2 + g3 + 2) >> 2;
        b = (b0 + b1 + b2 + b3 + 2) >> 2;
      } else {
        r = r0;
        g = g0;
        b = b0;
      }
      dst32[i00] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
}

/**
 * '4x4sub+4x1': subtract the 4x4 dither pattern, then a horizontal 4-tap box
 * over the centered window [x-1, x+2] (clamp-to-edge) with edge rejection.
 * Rejected pixels keep the dither-subtracted centre tap. The centered window
 * (not a forward [x, x+3] window) is a CHOICE: it keeps 1-px-wide vertical
 * features symmetric; HW phase is uncalibrated. Zero-alloc; clamp-to-edge.
 */
export function applyReconstruction4x1(
  src565: Uint16Array,
  dst32: Uint32Array,
  w: number,
  h: number,
  maxDelta: RgbMaxDelta,
  ditherSub: DitherMode | null,
): void {
  if (src565.length < w * h || dst32.length < w * h) {
    throw new Error('[voodoo] applyReconstruction4x1: buffer too small');
  }
  const sub2 = ditherSub === '2x2';
  const rbT = sub2 ? DITHER2_RB_POS : DITHER_RB_POS;
  const gT = sub2 ? DITHER2_G_POS : DITHER_G_POS;
  const sub = ditherSub !== null;
  const xm = sub2 ? 1 : 3;
  const ym = sub2 ? 1 : 3;
  const sh = sub2 ? 1 : 2;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const ph = (y & ym) << sh;
    for (let x = 0; x < w; x++) {
      const xa = x - 1 < 0 ? 0 : x - 1;
      const xb = x;
      const xc = x + 1 < w ? x + 1 : x;
      const xd = x + 2 < w ? x + 2 : xc;
      const ea = expandTap565(src565[row + xa]!);
      const eb = expandTap565(src565[row + xb]!);
      const ec = expandTap565(src565[row + xc]!);
      const ed = expandTap565(src565[row + xd]!);
      let ra = ea.r;
      let ga = ea.g;
      let ba = ea.b;
      let rb = eb.r;
      let gb = eb.g;
      let bb = eb.b;
      let rc = ec.r;
      let gc = ec.g;
      let bc = ec.b;
      let rd = ed.r;
      let gd = ed.g;
      let bd = ed.b;
      if (sub) {
        const sa = rbT[ph | (xa & xm)]!;
        const sb = rbT[ph | (xb & xm)]!;
        const sc = rbT[ph | (xc & xm)]!;
        const sd = rbT[ph | (xd & xm)]!;
        const ta = gT[ph | (xa & xm)]!;
        const tb = gT[ph | (xb & xm)]!;
        const tc = gT[ph | (xc & xm)]!;
        const td = gT[ph | (xd & xm)]!;
        ra = ra - sa < 0 ? 0 : ra - sa > 255 ? 255 : ra - sa;
        ga = ga - ta < 0 ? 0 : ga - ta > 255 ? 255 : ga - ta;
        ba = ba - sa < 0 ? 0 : ba - sa > 255 ? 255 : ba - sa;
        rb = rb - sb < 0 ? 0 : rb - sb > 255 ? 255 : rb - sb;
        gb = gb - tb < 0 ? 0 : gb - tb > 255 ? 255 : gb - tb;
        bb = bb - sb < 0 ? 0 : bb - sb > 255 ? 255 : bb - sb;
        rc = rc - sc < 0 ? 0 : rc - sc > 255 ? 255 : rc - sc;
        gc = gc - tc < 0 ? 0 : gc - tc > 255 ? 255 : gc - tc;
        bc = bc - sc < 0 ? 0 : bc - sc > 255 ? 255 : bc - sc;
        rd = rd - sd < 0 ? 0 : rd - sd > 255 ? 255 : rd - sd;
        gd = gd - td < 0 ? 0 : gd - td > 255 ? 255 : gd - td;
        bd = bd - sd < 0 ? 0 : bd - sd > 255 ? 255 : bd - sd;
      }
      const pa = (0xff000000 | (ba << 16) | (ga << 8) | ra) >>> 0;
      const pb = (0xff000000 | (bb << 16) | (gb << 8) | rb) >>> 0;
      const pc = (0xff000000 | (bc << 16) | (gc << 8) | rc) >>> 0;
      const pd = (0xff000000 | (bd << 16) | (gd << 8) | rd) >>> 0;
      let r: number;
      let g: number;
      let b: number;
      if (passesReconstructionThresholdRow(pa, pb, pc, pd, maxDelta)) {
        r = (ra + rb + rc + rd + 2) >> 2;
        g = (ga + gb + gc + gd + 2) >> 2;
        b = (ba + bb + bc + bd + 2) >> 2;
      } else {
        r = rb;
        g = gb;
        b = bb;
      }
      dst32[row + x] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
}
