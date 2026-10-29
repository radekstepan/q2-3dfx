---
'@q2/sw-renderer': patch
---

Correct foreground worker/main-thread attribution (PERF-NEXT-5): pool RGB flush tallies now return `mainSpans/mainPixels/mainTris` separately from combined totals and `workerSpans/workerPixels/workerTris` (worker bands only; the calling-thread band is main, never worker); absent split fields are UNKNOWN and map to the calling-thread band, never to worker-completed. Fixed particle staged-vs-inline double-count and per-class inline-span undercount on staging refusal; added `aliasDrawsStaged` plus sprite/particle/beam inline-span counters with explicit per-field units. Staged-but-failed work reports zero worker/main completion with the work in replay/inline counters. No raster-math change; pooled-serial hashes unchanged.
