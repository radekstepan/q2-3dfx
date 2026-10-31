---
'@q2/voodoo': major
---

RELEASE-8: remove the CPU frame-execution driver. Deletes resolveFrame, resolveFusedFrame, resolveRGB565, resolveRGB888 (+ option types/defaults), applyDisplayGamma, applyPostFilter, applyReconstruction2x2/4x1. The package is now a pure policy library (quantise, gammaLUT, Bayer/dither tables, mip/LOD, fog, modulate, cap, upload, table-fog); WebGL2 appearance is canonical in webgl-renderer/appearance.ts.
