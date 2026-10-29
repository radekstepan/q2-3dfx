---
'@q2/sw-renderer': patch
---

Wire real worker execution timing end to end (PERF-NEXT-4): `bandWorkerLoop` measures execution around every world/foreground/resolve/scanout drain on one worker-local clock and publishes finite `execMs` plus frame/sequence/job-band identity and drained work counts on completion messages; a shared-memory `CTL_EXEC` slot carries the same measurement for sync kicks (harvested after the fence, exactly once). The Node pool exposes validated newest-kick samples (`lastWorkerExec`), per-frame accumulation and the feature-detected `testBandExecStats` hook with string job labels. Timing disables via `BandWorkerOptions.timing` / `PoolOptions.workerTiming`, restoring the legacy shape with zero added cost. No raster-math change: disabled-vs-enabled planes are bit-identical; successful-path overhead within run-to-run noise.
