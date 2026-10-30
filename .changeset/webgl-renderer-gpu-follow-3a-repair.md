---
'@q2/webgl-renderer': patch
'@q2/testkit': patch
---

GPU-FOLLOW-3A sky repair: per-face isolated sky sampling + unconditional textured background. The six strip tiles now upload to six separate CLAMP face textures (tile order [rt,bk,lf,ft,up,dn], box face f binds tile SKY_SIDE_IMAGE[f]); sky UVs are face-local with half-texel inset so bilinear taps can never blend a neighbour face. The textured background box draws whenever a strip is retained, no longer gated on selected sky refs, so exterior sky survives transparent windows while opaque occlusion is preserved. Regressions: stub-GL per-face draw + zero-ref background legs, face-local UV isolation pins, and a real-WebGL2 pixel probe (edge/corner/nearest exact-color isolation, tamper liveness, zero-ref window before/after, real base1 strip-vs-cleared + clear-vs-re-register identity). No contract changes; no perf impact (same 36 indices, 6 draws).
