---
'@q2/sw-renderer': patch
---

Harden recovery against genuinely live writers (PERF-NEXT-2): `quarantineWorkers` now fences shared planes before replay (shutdown signal + replacement-buffer isolation with epoch bump + termination), the async RGB path joins completed termination (bounded), and frame recovery re-adopts the pool's current planes. Adds optional `BandDispatcher.recoveryEpoch`/`quarantineWorkersAsync` and adversarial live-writer recovery tests. No raster-math or contract changes; success-path cost is zero by construction.
