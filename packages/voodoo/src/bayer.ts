// @q2/voodoo — shared 4x4 Bayer ordered-dither tables.
// Used both by the resolve chain (M4.1, pre-quantise dither) and the
// sampler (M4.2, single-TMU "trilinear" mip-dithering).
//
// The matrix is the canonical 4x4 Bayer matrix, fixed and deterministic:
// no RNG anywhere in this package so golden frames are tight.

// Row-major 4x4 Bayer matrix, values 0..15.
export const BAYER4: Readonly<Uint8Array> = new Uint8Array([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]);

// Pre-quantise dither offsets in 8-bit units, indexed by (y & 3) * 4 + (x & 3).
// Voodoo3 applies ~+/-0.5 LSB of the 16-bit target before quantising:
//   R/B lose 3 bits (LSB = 8) -> offset amplitude 4
//   G   loses 2 bits (LSB = 4) -> offset amplitude 2
// offset = round((b - 7.5) * amp / 8), so b=0 -> -amp, b=15 -> +amp.
function buildOffset(amp: number): Int8Array {
  const t = new Int8Array(16);
  for (let p = 0; p < 16; p++) t[p] = Math.round((BAYER4[p]! - 7.5) * amp / 8);
  return t;
}

export const DITHER_RB_POS: Readonly<Int8Array> = buildOffset(4);
export const DITHER_G_POS: Readonly<Int8Array> = buildOffset(2);

/** Dither offset for the R/B channels at pixel (x, y): integer in [-4, +4]. */
export function ditherOffsetRB(x: number, y: number): number {
  return DITHER_RB_POS[((y & 3) << 2) | (x & 3)]!;
}

/** Dither offset for the G channel at pixel (x, y): integer in [-2, +2]. */
export function ditherOffsetG(x: number, y: number): number {
  return DITHER_G_POS[((y & 3) << 2) | (x & 3)]!;
}

/** Raw Bayer threshold 0..15 at pixel (x, y) for mip-dithering. */
export function bayerThreshold(x: number, y: number): number {
  return BAYER4[((y & 3) << 2) | (x & 3)]!;
}
