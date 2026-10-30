---
"@q2/webgl-renderer": patch
---

GPU-FOLLOW-2B browser-evidence hooks: honest GL-error attribution in uploadPixels (pre-poll distinguishes a flag the texImage2D itself set from a drained pre-existing per-context flag, never misblaming uploads) and testPolicyUploads counting uMipDither on/off uploads in-page (dither-liveness attribution). No production sampling changes.
