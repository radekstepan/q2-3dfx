---
'@q2/webgl-renderer': patch
---

RELEASE-7 (webgl-renderer lane): guard WebGLRenderer.resize against invalid sizes (warn-and-ignore without mutating dims, viewport, or the live target). Adds rapid bidirectional resize regression pinning viewport/target/status/camera sync, same-size no-op, and coherent invalid-size handling.
