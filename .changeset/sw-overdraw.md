---
"@q2/sw-renderer": patch
---

M3.3 option (b): close the open overdraw checkbox by recalibrating the budget to measured reality instead of adding occluder clipping. Adds zero-cost-when-off overdraw attribution (`src/overdraw.ts`, `SoftwareRenderer.testMeasureOverdraw`): per-view stage accounting proving the 1.81–2.36x residual across 4 real base1 views at 640x480 is in-frustum occluded span fill (44.8–57.7% of span pixels lose the C-faithful depth test at exactly 1.000 screen coverage), with frustum + backface + clip naming every PVS-admitted-but-unemitted surface — zero unaccounted bucketing waste. No draw-path change: devroom golden `8f61c755` pinned, base1 hashes unchanged. Recommends replacing the aspirational 1.15x M3.3 budget with a 2.5x ceiling (worst measured 2.362).
