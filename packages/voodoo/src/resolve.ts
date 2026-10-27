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
// Conventions: colour is Uint32 0xAABBGGRR (see @q2/renderer-api Framebuffer).
// Inner loops use typed arrays only and allocate nothing.

import { DITHER_G_POS, DITHER_RB_POS } from './bayer.js';

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

export interface ResolveOptions {
  /** Glide gamma lift; 1.0 disables the stage. */
  gamma: number;
  /** 4x4 ordered dither before quantise. */
  dither: boolean;
  /**
   * Quantise 8:8:8 -> 5:6:5 (vd_16bit). Off still packs 565 (round-to-nearest
   * instead of truncating) for backwards compatibility — it is NOT a true
   * bypass. Use resolveRGB888 for the genuine RGB888 debug path.
   */
  quantise: boolean;
}

export function defaultResolveOptions(): ResolveOptions {
  return { gamma: 1.3, dither: true, quantise: true };
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
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const pos = (y & 3) << 2;
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
        const p = pos | (x & 3);
        r += DITHER_RB_POS[p]!;
        g += DITHER_G_POS[p]!;
        b += DITHER_RB_POS[p]!;
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
   * not hardware behaviour.
   */
  dither: boolean;
}

export function defaultResolveRGB888Options(): ResolveRGB888Options {
  return { gamma: 1.3, dither: false };
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
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const pos = (y & 3) << 2;
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
        const p = pos | (x & 3);
        r += DITHER_RB_POS[p]!;
        g += DITHER_G_POS[p]!;
        b += DITHER_RB_POS[p]!;
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

/** Placeholder defaults (see RgbMaxDelta): smooth gradients pass, hard edges reject. */
export function defaultRgbMaxDelta(): RgbMaxDelta {
  return { r: 8, g: 8, b: 8 };
}

/**
 * Edge-rejection gate for scanout reconstruction (STUB — documented
 * approximation until HW capture, NOT yet wired into applyPostFilter).
 * Returns true when the 2x2 block of packed 0xFFBBGGRR taps is smooth enough
 * to box-filter (per-channel spread <= the matching maxDelta component) and
 * false when any channel spread exceeds it (one-pixel edge: keep sharp, do
 * not blur the dither/edge away). Pure, zero-alloc.
 */
export function passesReconstructionThreshold(
  p00: number,
  p10: number,
  p01: number,
  p11: number,
  maxDelta: RgbMaxDelta,
): boolean {
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
