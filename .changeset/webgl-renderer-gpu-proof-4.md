---
"@q2/webgl-renderer": patch
---

GPU-PROOF-4: Voodoo appearance pass — linear scene target (RGBA16F w/ float ext, RGBA8 fallback), fullscreen dither→RGB565→matched-reconstruction→gamma resolve, CPU box-filter mip chains with dithered level pick + LOD bias, 64-entry table fog, gun NDC remap, per-pixel dlights. Output stays resident on GPU; no readPixels in the normal path.
