---
"@q2/sw-renderer": patch
---

Perf remediation items 1-8: early entity/bounds culling, indexed band work ranges, emitter-order sort bypass, specialised RGB pixel paths (opaque-mask skip, verbatim 16-bit depth fast path), cached PVS marking, quadratic-free dlight marking, shared alias setup, and a gated RGB-authoritative skip with classic depth backfill. Output-identical (all goldens + RGB hashes pinned); measured 1.3-4x on marking/sort/band microbenchmarks. Classic planes stop being meaningful under sw_rgb_skip_classic=1 (opt-in only).
