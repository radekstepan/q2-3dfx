---
'@q2/webgl-renderer': patch
---

GPU-FOLLOW-3B: fix water tile-boundary sampling. FS_LIT now derives mip LOD from unwarped UVs (CPU spanLod parity) and warps only the textureLod tap via voodooSampleMippedWarped, and runs highp for multi-tile water UVs. Warp animation, scale, REPEAT wrap, lighting and mipmapping unchanged.
