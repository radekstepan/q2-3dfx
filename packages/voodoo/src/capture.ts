// @q2/voodoo — M4.1 capture table.
//
// Single source for the written capture instructions
// (`packages/testkit/CAPTURE-M4.1.md`) and the devtools human-review
// checklist: the exact vd_* cvar values a reference Voodoo3 capture must be
// compared against. Values mirror the registered cvar defaults in
// `@q2/config` (BRAIN.md §7.2); the comparison harness reads them live via
// `readVoodooState()`, this table pins them for humans.

export interface CaptureCVar {
  /** cvar name, e.g. `vd_gamma`. */
  name: string;
  /** Value the reference capture is compared against. */
  value: number;
  /** One-line meaning (matches the @q2/config registration text). */
  meaning: string;
}

/** The 12 vd_* cvars, in §7.2 table order, at their capture values. */
export function captureCVarTable(): CaptureCVar[] {
  return [
    { name: 'vd_16bit', value: 1, meaning: 'quantise 8:8:8 to RGB565 at resolve' },
    { name: 'vd_dither', value: 1, meaning: '4x4 ordered dither before quantise' },
    { name: 'vd_postfilter', value: 1, meaning: '2x2 "22-bit" overlay video-processor post filter' },
    { name: 'vd_bilinear', value: 1, meaning: 'bilinear filtering' },
    { name: 'vd_mipdither', value: 1, meaning: 'dithered single-level selection via mip dithering (NOT PG trilinear)' },
    { name: 'vd_lodbias', value: -0.35, meaning: 'Glide LOD bias' },
    { name: 'vd_fog', value: 1, meaning: '64-entry table fog' },
    { name: 'vd_gamma', value: 1.3, meaning: 'Glide gamma lift' },
    { name: 'vd_maxtexsize', value: 256, meaning: '256x256 texture cap' },
    { name: 'vd_zbits', value: 16, meaning: '16-bit depth buffer' },
    { name: 'vd_palettetex', value: 1, meaning: '8-bit palettised textures' },
    { name: 'vd_overbright', value: 1, meaning: 'lightmap modulate x2 with clamp' },
  ];
}
