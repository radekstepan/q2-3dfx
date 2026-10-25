---
"@q2/voodoo": minor
---

feat(voodoo): Voodoo3 resolve chain + sampler (M4.1/M4.2)

M4.1 resolve: Glide gamma ~1.3 LUT, 4x4 Bayer ordered dither (+/-4 R/B, +/-2 G), 8:8:8 to RGB565 quantise, 2x2 box RAMDAC post filter, and 16-bit W-buffer banding. Every stage cvar-switchable via vd_gamma/vd_dither/vd_16bit/vd_postfilter/vd_zbits.

M4.2 sampler: 4-tap bilinear with 8-bit fractional fixed-point weights, mipmap LOD via log2(rho) minus vd_lodbias, single-TMU trilinear via Bayer mip-dithering, 64-entry exp^2 table fog (vd_fog), lightmap modulate x2 with clamp (vd_overbright), palette-expand-at-sample-time (vd_palettetex), 256x256 cap helper (vd_maxtexsize).

Deterministic (fixed Bayer matrices, no RNG); zero-alloc inner loops over typed arrays. 39 vitest tests: LUT spots, dither period 4, RGB565 round-trip bounds + full-space idempotence, bilinear exactness on 2x2, LOD + bias, mip-dither determinism, fog endpoints, postfilter averaging, golden FNV-1a hash. Measured: resolve chain 43.6 Mpixel/s, inlined span 28.7 Mpixel/s at 640x480.
