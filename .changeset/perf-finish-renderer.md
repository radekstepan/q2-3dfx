---
"@q2/sw-renderer": patch
---

PERF-FINISH-A renderer lane: RGB-authoritative Voodoo on by default (skip
classic world+foreground where the RGB overlay drew; cvar-0 oracle kept;
software bit-identical), worker-owned staged span ranges (D_YMIN/D_YMAX at
staging, no per-worker rescan; legacy zero-range fallback), zero-scan
emitter order (fuzz-guarded) + all-inside projection fast path + sqrt-free
mip select, skip counters + real-asset oracle-vs-authoritative gate.
Display pins unchanged; classic index pins moved by design with oracle pins
locking the old values. Pooled identical to serial, zero fallbacks.
Foreground per-pixel rasterizer stays serial (incremental/barycentric
rewrites rejected: changed coverage/ties); worker-staged foreground is an
open follow-up.
