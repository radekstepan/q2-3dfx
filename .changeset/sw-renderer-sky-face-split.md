---
"@q2/sw-renderer": patch
---

fix(sw-renderer): face-consistent sky sampling kills the black lava streaks

A world SURF_SKY poly routinely straddles 2-3 skybox-face pyramids; the
old path interpolated packed-strip UVs across the whole poly, sweeping
through unrelated tiles (the bk/lf black bands over orange faces). The
sky path now fan-triangulates each world poly and samples every fragment
with ONE face (centroid ray via skyUvOnFace), so interpolation can never
leave the fragment's tile — the same no-cross-face invariant id gets by
emitting 6 single-face box quads in R_EmitSkyBox. Adds a lava regression
test (fails on the old path with tile-30 smear, passes now).
