---
"@q2/voodoo": patch
---

Gamma-after-reconstruction strict path + matched recon enforcement (M4.1 feedback P2 #5/#6). New `applyDisplayGamma` helper applies the Glide transfer LUT on the display plane (guide §7.2 RAMDAC placement). `resolveFrame` with a non-legacy `reconmode` now packs a linear 565 target (gamma 1), runs the matched reconstruction (subtract matrix forced by the mode, never by `vd_dithermode`; null when `vd_dither=0`), then gamma-corrects the display; postfilter-off strict packs linear, expands, then gamma-corrects. The `legacy` reconmode (default) keeps the historical LUT-on-source order byte-exact — goldens unchanged. Depth/quantise helpers (`quantiseDepthBeforeTest`, `depthClearValue`, `createDepth16`, `testAndWriteDepth16`, `quantiseRGB565`) confirmed exported for raster use with no renderer import.
