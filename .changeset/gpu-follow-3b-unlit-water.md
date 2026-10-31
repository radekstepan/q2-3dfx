---
'@q2/webgl-renderer': patch
---

GPU-FOLLOW-3B: draw turbulent water unlit (ref_soft/ref_gl parity). FS_LIT multiplied warp faces by per-face lightmap blocks that step up to 247/255 at shared base1 water edges, drawing tile seams; both id references serve warp faces raw texels ("no lightmaps"). Warp-gated col = texel branch; glass/opaque lighting, motion, mips, transparency untouched. Adds sampled-pixel regressions with an injected lit-water seam control.
