---
"@q2/sw-renderer": patch
---

perf(sw-renderer): RGB span hot-path cuts, banded RGB routing (perf-2)

Perf: hoists span-constant lightmap v-side state out of the RGB pixel loops, folds the Bayer row offset per subdivision, and inlines the per-pixel repeat-wrap calls (all output-bit-identical: frame hash `8372b322` pinned). Devroom serial RGB 60.7 → 54.6 ms/frame @640x480 (~10%; 15.4 → 14.4 @320x240), classic path untouched. Skipped (documented in spans.ts): dlux==0 fast loop (4% of spans), modulate LUTs, clamp-path fdiv, edge-trim branches, Bayer unroll, reciprocal-mult.

Worker bands: `BandedSoftwareBackend.drawSpansRGB` routes RGB spans per row band with absolute screen coords (bit-identical Bayer dither phase + seam rows); pooled classic planes merge with the single global endFrame composite (bands produce pre-scanout planes only). Pooled + serial RGB are byte-identical (new rgbBands.test.ts: 2..8 bands @160x120, seam splits @320x240, pooled accum/per-batch). WASM + RGB flag is now an explicit `Com_Error` (never silent software); a full WASM RGB port stays out of scope.
