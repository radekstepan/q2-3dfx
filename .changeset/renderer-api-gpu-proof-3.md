---
"@q2/renderer-api": patch
---

GPU-PROOF-3: additive GPU frame inputs — `GpuLight` (origin/color/intensity), `MAX_GPU_LIGHTS = 8`, and optional `lights?: GpuLight[]` on `GpuFrameInput`. Backward compatible (optional field); frozen §5 contracts untouched; still DOM-free.
