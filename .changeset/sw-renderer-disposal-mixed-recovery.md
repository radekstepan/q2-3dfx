---
"@q2/sw-renderer": patch
---

Pin disposal-during-RGB-kick and mixed-class partial recovery (TASK.md item 1 gaps): async RGB kick + dispose() mid-flight resolves bounded with inline fallback converging to serial (pool + renderer full-RGBA, fresh-pool next frame exact); staged tris + alpha spans + beams with real calling-thread writes then worker failure replays blend-suffix exactly once (double-apply control differs); indexed flushFrame timeout fast-fail/no-quarantine behavior pinned with a design NOTE. Tests only, no raster-math change; pooled-serial hashes unchanged.
