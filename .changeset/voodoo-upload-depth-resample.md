---
"@q2/voodoo": patch
---

feat(voodoo): upload resample + wrap/LOD/depth-threshold policy (astra V2b/step4)

- New `src/upload.ts`: `resampleTexture` performs REAL texel resampling (box filter) to capped dimensions with UV scale (`uvScaleS/T`); indexed input expands through the palette and filters COLORS (indices never averaged numerically), index 255 excluded from averages and preserved on all-transparent footprints; `halveRGB` / `completeMipChainRGB` keep WAL levels where present and generate the missing tail; `wrapTap` gives per-axis repeat/clamp addressing; texel-centre convention (`u*w-0.5`, no double offset) documented once.
- `sampleBilinear` / `sampleNearest` / `samplePalette` / `sampleRGBTexture` take optional per-axis `addressS/addressT` (default clamp = historical behaviour); repeat wraps EACH of the 4 taps plus the centre, fixing bilinear seams.
- LOD: `mipLevel` gains optional `tlodDither` adding `lodBiasCompensation` (+0.375 average per guide §3); `mipRho` documented no-throw on constant-UV/mag footprints. No trilinear/anisotropy added.
- Depth: pure `quantiseDepthBeforeTest` (normalized 0..1 -> 0..2^bits-1) + `depthTestLess` (LESS wins, ties keep stored, clear = far = 1.0); existing post-hoc `quantiseDepth` marked COMPAT ONLY.
- Scanout: `RgbMaxDelta` / `defaultRgbMaxDelta` / `passesReconstructionThreshold` stub (documented approximation until HW capture; not yet wired into `applyPostFilter`).
- Fog: `fogContribution` capability gate returning 0 unless explicitly enabled (base1 stays at zero).
