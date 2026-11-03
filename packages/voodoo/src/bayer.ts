// @q2/voodoo — shared 4x4 Bayer ordered-dither tables.
// Used both by the resolve chain (M4.1, pre-quantise dither) and the
// sampler (M4.2, dithered single-level selection — NOT PG trilinear — mip-dithering).
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

// --- 2x2 ordered dither (fbzMode 2x2 mode, overlay video-processor 2x2-sub pairing) --------
// (vidProcCfg §6.5.3 overlay filter mode 01b, marked 3D-only) //
//
// DETERMINISTIC APPROXIMATION UNTIL HW CAPTURE: the Voodoo3 fbzMode register
// supports both 2x2 and 4x4 ordered dither, but the exact 2x2 matrix weights,
// amplitude and phase programmed by the Quake II MiniGL driver are not
// established from a hardware capture. This table uses the canonical 2x2 Bayer
// matrix with the SAME +/-0.5 LSB amplitude model as the 4x4 table above
// (offset = round((b - 1.5) * amp / 2), indexed by (y & 1) * 2 + (x & 1)).
// RB (amp 4): [-3, +1, +3, -1]; G (amp 2): [-1, +1, +2, 0] — the G asymmetry
// (+2 vs -1) is JS Math.round half-up on exact .5 fractions, kept verbatim so
// the table stays a pure function of the stated formula. Select via
// vd_dithermode ('2x2' | '4x4', default '4x4').

// Row-major 2x2 Bayer matrix, values 0..3.
export const BAYER2: Readonly<Uint8Array> = new Uint8Array([0, 2, 3, 1]);

function buildOffset2(amp: number): Int8Array {
  const t = new Int8Array(4);
  for (let p = 0; p < 4; p++) t[p] = Math.round((BAYER2[p]! - 1.5) * amp / 2);
  return t;
}

export const DITHER2_RB_POS: Readonly<Int8Array> = buildOffset2(4);
export const DITHER2_G_POS: Readonly<Int8Array> = buildOffset2(2);

/** Dither offset for the R/B channels at pixel (x, y) in 2x2 mode. */
export function ditherOffsetRB2(x: number, y: number): number {
  return DITHER2_RB_POS[((y & 1) << 1) | (x & 1)]!;
}

/** Dither offset for the G channel at pixel (x, y) in 2x2 mode. */
export function ditherOffsetG2(x: number, y: number): number {
  return DITHER2_G_POS[((y & 1) << 1) | (x & 1)]!;
}

/** Raw Bayer threshold 0..3 at pixel (x, y) for the 2x2 matrix. */
export function bayerThreshold2(x: number, y: number): number {
  return BAYER2[((y & 1) << 1) | (x & 1)]!;
}
