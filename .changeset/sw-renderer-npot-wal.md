---
'@q2/sw-renderer': patch
---

fix(sw-renderer): accept NPOT WALs instead of green checker fallback

Base1 `*13` secret-button sides (`e1u1/box1_1`, 96x32) and 32 other NPOT WALs failed the `isPow2` gate in `bspToMiniWorld` and baked as the `checker(64,200,90)` fallback, whose index 200 renders olive-green — the nuclear-green button sides. Original `ref_gl` `GL_Upload32` rescales NPOT to the next POT instead. Bake now resamples NPOT palette indices to the next POT with nearest-neighbor and scales that face's texel-space UVs by the same factor, preserving tiling on both renderers.
