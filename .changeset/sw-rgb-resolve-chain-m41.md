---
"@q2/sw-renderer": patch
---

feat(sw-renderer): M4.1 voodoo resolve chain — instance enable, fidelity cvars, 16-bit depth, full-res mips

Instance `SoftwareRenderer.setRGBWorldEnabled/isRGBWorldEnabled` (what `apps/web` probes) now set the shared flag and drop RGB state (coverage, both depth planes, caches, skin/sky memos); `invalidateCaches()` drops scalar + RGB caches. Module-level functions stay as thin flag wrappers.

Fidelity controls (`vd_overbright`, `vd_lodbias`, `vd_mipdither`, `vd_bilinear`) are snapshotted once per renderView and baked into every RGB material (world, skin, sky, flat); any cvar change invalidates the RGB cache + memos. `vd_bilinear=0` selects nearest point sampling in the span loops; LOD rho is the max of the horizontal and optional vertical gradients (isotropic default — span records carry no vertical derivatives).

`vd_zbits` (1..23, default 16) now affects visibility: 1/z is quantised before the test in the RGB span loops against an optional Uint16 authority plane (`rgbDepth16`, cleared to 0 = far under larger-1/z-wins) with the float round-trip mirrored to the shared plane. Raw-1/z mapping is documented as an approximation (no near/far window-Z mapping at span time). Software path bit-identical.

RGB mip chains build from the original full-res texture texels instead of the scalar block's point-subsampled texels (the old source double-applied the mip select); a minified 1-texel checker test pins the box-filtered mean.

Also fixes `seedRGBBackground` clobbering world RGB pixels: covered pixels are now spared, so the world pass actually displays (ON vs OFF frames differ; serial RGB pin re-pinned `8372b322` -> `3534624e`, software pins unchanged).
