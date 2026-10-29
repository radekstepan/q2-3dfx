---
'@q2/sw-renderer': patch
---

PERF-NEXT-6 round 1: skip redundant dlight cache invalidation when lights, world and affected set are unchanged (steady-state combat stops ~100 rebuilds/frame); fuse the three foreground flush barriers into a single ordered drain (fgKicks 2→1, empty suffix kick gone); fuse expand+dither-subtract+clamp into phase tables in the pooled 2x2 scanout arm (bit-identical). Pooled-serial full-RGBA and odd-dims parity preserved.
