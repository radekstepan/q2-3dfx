---
'@q2/webgl-renderer': patch
---

GPU-FOLLOW-3B shader order: define voodooSampleMippedWarped before voodooSampleMipped. GLSL ES requires declaration before use; ANGLE rejected the forward reference that stub-GL tolerates, killing every real WebGL2 program. No sampling/logic change.
