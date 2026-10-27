---
"@q2/voodoo": patch
---

fix(voodoo): astra milestone-1 resolve defects (postfilter/bypass/sampler/lodbias/depth-note)

- `resolveFrame` always fills `display`: with `postfilter` off it expands every freshly packed RGB565 pixel via `expandRGB565` (no stale output); with `quantise` off it writes the genuine RGB888 bypass (gamma on, dither/postfilter bypassed).
- New `resolveRGB888` debug path (gamma + optional dither, default off) into opaque `0xAABBGGRR`, preserving values RGB565 cannot represent. `resolveRGB565` with `quantise:false` keeps its legacy rounding-pack behaviour for compat readers.
- `sampleTexture` filtering follows `vd_bilinear` only (`vd_paleltetex` is now storage/upload policy, not a filter switch); new `sampleRGBTexture` / `sampleRGBTextureFrame` for expanded RGB triplets with the same bilinear/nearest policy. Also fixed a latent `samplePalette` weight typo (`w01` used `(256-fv)*fv` instead of `(256-fu)*fv`), which skewed asymmetric bilinear taps.
- `mipLevel` now adds `tLOD.lodbias` (`log2(rho) + bias`, so negative bias favours finer detail), clamps to `[0, maxLevel]`, and clamps non-positive rho to epsilon 1e-6 instead of throwing (throws only on non-finite input). Behaviour change: zero/negative rho no longer throw.
- `quantiseDepth` / `quantiseDepthFrame` documented as display/banding approximation only, NOT depth-buffer emulation; `Framebuffer.depth` 1/z semantics unchanged.
