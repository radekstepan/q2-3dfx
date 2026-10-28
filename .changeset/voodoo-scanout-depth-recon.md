---
"@q2/voodoo": patch
---

feat(voodoo): scanout reconstruction profiles + quantized depth plane (astra step 4)

- Wires `vd_dithermode` (`2x2`|`4x4`), `vd_reconmode`
  (`legacy`|`2x2sub+2x2box`|`4x4sub+4x1`) and `vd_rgbmaxdelta` (`r,g,b`)
  read-path into resolve: new 2x2 ordered-dither tables (same +/-0.5 LSB
  amplitude model as 4x4), `ditherMode` option on both resolve paths
  (default `4x4` = bit-exact legacy), dither-subtract + 2x2 box and
  dither-subtract + centered 4x1 box with `passesReconstructionThreshold`
  per-region edge rejection. `legacy` stays the default and is unchanged
  (M4.1 golden hash still passes). All-zero thresholds disable the gate
  (unconditional box).
- Adds internal quantized depth-plane helpers `createDepth16` /
  `clearDepth16` / `testAndWriteDepth16` (LESS + tie-keeps-stored, clear =
  far) with a documented Z-vs-W mapping + near/far derivation contract for
  future rasterizer use. `Framebuffer.depth` 1/z semantics untouched;
  post-hoc `quantiseDepth` kept as compat.
- Documents the gamma stage (LUT on 8:8:8 source standing in for the
  RAMDAC display stage; bypass keeps gamma on) and verifies the fog
  zero-contribution gate (`fogContribution` / factor-0 `shadePixel`
  passthrough).
- All non-legacy scanout/dither combinations are labeled deterministic
  approximations until HW capture (exact fbzMode/vidProcCfg/rgbMaxDelta
  programming, tap weights/phase, RAMDAC curve uncalibrated).
