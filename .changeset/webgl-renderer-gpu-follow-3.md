---
'@q2/webgl-renderer': minor
---

GPU-FOLLOW-3 lane A: combined material/behavior semantics. TRANS-first classification (turbulent+translucent water blends and warps; glass single-sided per CPU rule); default-alpha beams always ride the blend pass with distance order; per-pixel water warp in FS_LIT (closed-form turbTable mirror); textured view-centered skybox via registerSkyStrip with flat fallback; unsupported cvars explicitly labelled in GPU_CVAR_GAPS. Tests: new follow3 suite (synthetic + real-base1 inventory/selection/draw pins).
