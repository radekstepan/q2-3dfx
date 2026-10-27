---
'@q2/sw-renderer': minor
---

perf(sw-renderer): async frame accumulation + parallel resolve toward 60fps (M8.1)

Frame-level batch accumulation over SAB: the renderer's ~1800 per-surface
batches/frame are fused-packed during emission (no separate pack pass) and
drained in ONE pool kick (frameAccum, `sw_accum` default on) instead of 1806
per-batch kicks; the 640×480 palette expand resolves in a second parallel
kick. Byte-identical on all paths (classic = per-batch pool = frame-accum,
index + color planes; devroom `8f61c755` and 4 real base1 views pinned).

Also: sortBatchByRow vertical-range fast path + singleton skip, SurfaceCache
frame-stamp LRU (no per-hit Map churn), reusable scratch camera
(`setupCameraInto`, bit-identical incl. f32 rounding), cached surfBounds
mirror, armed phase attribution (`testMeasurePhases`), and a per-batch pool
clear-guard fix (legacy pooled path was divergent on real frames).
M9.1 SIMD v128 spike outcome documented in `wasmSpans.ts` (V8 scalar at
ceiling; no v128 path lands).

Bench (Ryzen 5 PRO 2400G, Node 22, base1 spawn-north 640×480): classic
~19ms → pooled frame-accum 15.1ms @7 workers (1.25x frame; spanfill kernel
parallelises ~3x). All 153 sw-renderer tests green incl. Q2_PAK goldens.
