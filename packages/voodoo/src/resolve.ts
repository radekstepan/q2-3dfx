// @q2/voodoo — M4.1 resolve chain.
//
// Pipeline order (fixed, matches Glide on Voodoo3):
//   8:8:8 framebuffer -> gamma LUT -> 4x4 ordered dither -> RGB565 quantise
//   -> optional 2x2 box ("22-bit" RAMDAC post filter) for display.
//   Depth: stored 1/z quantised to vd_zbits bits is a DISPLAY/BANDING
//   approximation only, NOT a depth-buffer emulation (see quantiseDepth).
//   True depth emulation must quantise BEFORE the depth test/write against
//   an internal quantized plane; Framebuffer.depth keeps its documented 1/z
//   semantics (frozen @q2/renderer-api contract).
//
// GAMMA STAGE (documented placement — behaviour unchanged since M4.1).
//
// The guide pipeline lists "display gamma" AFTER scanout reconstruction, i.e.
// in the RAMDAC on the already-reconstructed signal. This package applies the
// equivalent Glide transfer LUT to the 8:8:8 source BEFORE dither/quantise:
// for a per-frame resolve of an 8:8:8 framebuffer the two placements differ
// only by gamma-of-average vs average-of-gamma rounding (<= 1 LSB per channel
// after the 565 round-trip), so the LUT-on-source placement stands in for the
// RAMDAC stage deterministically. Moving the LUT after the box would change
// every golden value for no calibrated gain — NOT done until an HW capture
// establishes the real RAMDAC curve. The RGB888 bypass keeps the SAME LUT
// stage (gamma on, dither/reconstruction off); gamma 1.0 disables the stage
// on both paths.
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
// Read-path-only driver-profile selectors (registered in @q2/config, defaults
// preserve the legacy M4.1 bit-exact path). Values are snapshots in
// VoodooState; resolveFrame wires them into write dither + scanout. Every
// non-legacy combination is a DETERMINISTIC APPROXIMATION until an HW capture
// establishes the MiniGL programming of fbzMode / vidProcCfg / rgbMaxDelta.

/** Ordered-dither matrix at target writes: '4x4' (legacy default) or '2x2'. */
export type DitherMode = '2x2' | '4x4';

/**
 * Scanout reconstruction profile (vidProcCfg):
 * - 'legacy' (default): 4x4-dither write + unconditional 2x2 box, NO dither
 *   subtraction — the M4.1 approximation, bit-exact preserved. Legacy stays
 *   the DEFAULT because every existing golden/capture pins this exact path;
 *   the subtract modes below are opt-in comparison profiles until an HW
 *   capture establishes the MiniGL programming of fbzMode / vidProcCfg.
 * - '2x2sub+2x2box': subtract the 2x2 dither pattern, then 2x2 box with
 *   rgbMaxDelta edge rejection.
 * - '4x4sub+4x1': subtract the 4x4 dither pattern, then a horizontal 4x1 box
 *   (centered window [x-1, x+2], clamp-to-edge) with rgbMaxDelta rejection.
 * The subtract matrix is dictated by the MODE, not by vd_dithermode: a
 * mismatched write dither (e.g. 4x4 writes + 2x2sub scanout) subtracts the
 * wrong pattern and is a documented misconfiguration, not an error.
 */
export type ReconMode = 'legacy' | '2x2sub+2x2box' | '4x4sub+4x1';

/** Parse vd_dithermode; anything but '2x2' falls back to legacy '4x4'. */
export function parseDitherMode(s: string): DitherMode {
  return s === '2x2' ? '2x2' : '4x4';
}

/** Parse vd_reconmode; unknown strings fall back to legacy 'legacy'. */
export function parseReconMode(s: string): ReconMode {
  return s === '2x2sub+2x2box' || s === '4x4sub+4x1' ? s : 'legacy';
}

export interface ResolveOptions {
  /** Glide gamma lift; 1.0 disables the stage. */
  gamma: number;
  /** Ordered dither before quantise (matrix selected by ditherMode). */
  dither: boolean;
  /** Dither matrix: '4x4' (default, legacy bit-exact) or '2x2'. */
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

// --- 16-bit W-buffer banding ----------------------------------------------

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
 * register is not yet established from a hardware capture, so the defaults
 * below are a placeholder (smooth gradients pass, hard edges reject) and the
 * current applyPostFilter path stays unconditional. Wire passes through
 * passesReconstructionThreshold only behind an explicit comparison profile.
 */
export interface RgbMaxDelta {
  r: number;
  g: number;
  b: number;
}

/** Placeholder comparison-profile thresholds (NOT the default): smooth
 * gradients pass, hard edges reject. The live default is {0,0,0} (no
 * rejection — unconditional box, preserving legacy behaviour); use
 * parseRgbMaxDelta(getCVarString('vd_rgbmaxdelta')) for the frame value. */
export function defaultRgbMaxDelta(): RgbMaxDelta {
  return { r: 8, g: 8, b: 8 };
}

/**
 * Parse vd_rgbmaxdelta ('r,g,b', each 0..255, clamped; unparseable or missing
 * components fall back to 0). '0,0,0' (the default) disables rejection:
 * passesReconstructionThreshold returns true unconditionally, i.e. the
 * legacy unconditional box.
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
 * ALL-ZERO DISABLES THE GATE: maxDelta {0,0,0} (the vd_rgbmaxdelta default)
 * returns true unconditionally — the legacy unconditional box. Nonzero
 * thresholds reject per channel; a channel threshold of 0 while others are
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
