---
"@q2/testkit": patch
---

GPU-FOLLOW-2B real-browser triage: proof page captures diffuse-only / lightmap-only / final at the same F1 camera via the debug-gated setDebugView seam (production default 0 unchanged) plus far-camera minified captures with dither on/off, and publishes brightStats, pairwise diffs, mip-flag state at capture time, atlas/material stats, warning list and drained GL-error checkpoints in proof.follow2b; gpu-browser suite pins non-black stage content, far-camera content/divergence, cvar-to-frame dither propagation, atlas/material presence and zero real texImage2D failures (stale per-context flags reported separately, never blamed on uploads).
