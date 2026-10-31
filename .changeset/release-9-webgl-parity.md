---
'@q2/webgl-renderer': patch
---

RELEASE-9 GPU lane: pin explosion/blaster presentation parity. Adds release9-effects tests proving the GPU scene path renders explosion (r_explode 49f) and blaster-impact (explode 5f) entities with CPU-matching projected extents (<1.2px across distance/FOV/pitch/lerp on real pak art), exact frame/oldframe/backlerp selection, alpha to pass routing and skin resolution, plus a wrong-scale control. No renderer source changes (audit verdict: no GPU-side deviation).
