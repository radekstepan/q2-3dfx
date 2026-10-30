---
"@q2/webgl-renderer": patch
---

GPU-PROOF-3: real WebGL2 scene drawing — production GLSL programs (lit world/alias + flat billboards), per-material world batches with a shelf-packed lightmap atlas and palette-expanded diffuse textures, CPU-interpolated MD2 alias meshes with gun depth-hack remap, camera-facing beam/sprite billboards and point particles, per-pixel dynamic lights, opaque-then-far-to-near blend passes. No readPixels in the normal path.
