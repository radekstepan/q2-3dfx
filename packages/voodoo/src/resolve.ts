// @q2/voodoo — M4.1 resolve chain.
//
// Pipeline order (fixed, matches Glide on Voodoo3):
//   8:8:8 framebuffer -> gamma LUT -> 4x4 ordered dither -> RGB565 quantise
//   -> optional 2x2 box ("22-bit" RAMDAC post filter) for display.
//   Depth: stored 1/z quantised to vd_zbits bits (16-bit W-buffer banding).
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
  /** Quantise 8:8:8 -> 5:6:5 (vd_16bit). Off = round-to-nearest packing. */
  quantise: boolean;
}

export function defaultResolveOptions(): ResolveOptions {
  return { gamma: 1.3, dither: true, quantise: true };
}

/**
 * M4.1 resolve: src 8:8:8 (0xAABBGGRR) -> dst RGB565.
 * Zero-alloc inner loop; reads the (cached) gamma LUT once per call.
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
 */
export function quantiseDepth(depth: Float32Array, bits = 16): void {
  if (!(bits > 0) || bits >= 24) return;
  const scale = (1 << bits) - 1;
  const inv = 1 / scale;
  for (let i = 0; i < depth.length; i++) {
    depth[i] = Math.round(depth[i]! * scale) * inv;
  }
}
