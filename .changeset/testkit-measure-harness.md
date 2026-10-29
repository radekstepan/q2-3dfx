---
'@q2/testkit': patch
---

Add PERF-NEXT-6 Lane C measurement collectors (consumer-only, no renderer or contract changes): per-rep reconciled GEO phase attribution (geo-attribution.ts — eight setup/mark/traverse/cull/cache/project/emit/sort phases validated structurally, per-rep totals and instrumented-wall gaps reconciled before medians, never summed medians), kick-size histograms with a first-class empty-kick counter (kick-histogram.ts — per-(frame,seq,job) kick sizes with drain order, band counts and exec maxes; resolve/scanout kicks never flagged empty; newest-kick descriptor drain via lastWorkerExec with kickBase/kickDescs range and the empty-suffix-kick flag), and an interleaved candidate-A/B helper (ab-compare.ts — warm up both legs then alternate A_i/B_i reps on one box with paired deltas, settings-match verification covering dimensions, rep-0 camera and mid-run fidelity drift, cross-leg output parity reported not gated, and per-leg execution proof).
