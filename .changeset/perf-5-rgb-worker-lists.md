---
"@q2/sw-renderer": patch
---

PERF-5 RGB worker admission + persistent uploads + fused pooled resolve.

- Band-specific work lists: RGB descriptors carry their staged span y-range (R_YMIN/R_YMAX); workers skip out-of-band batches before material resolution and span scans. Preserves per-pixel order, depth ties and blending (disjoint rows, in-order drain per band).
- Persistent shared chain uploads: the SAB chain region/directory/identity map survive across frames (copy-on-first-use, evict-all retry). Palette/world changes drop via clearRGBChains. Eliminates the ~2.4MB per-frame chain re-upload after warmup; luxels/spans/descriptors still stage per frame.
- Reused worker material records: single mutable material/light/flat-color per kick, no per-descriptor allocations; chain level views still built per kick only for intersecting bands.
- Fused pooled end-frame: resolve kick now expands palette + composites RGB in one pass (resolveBandFused, worker + main band + fallback); endFrame/endFrameAsync drop the second compositeRGB pass. Bit-identical to the serial fused path.
