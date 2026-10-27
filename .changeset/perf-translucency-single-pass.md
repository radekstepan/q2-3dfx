---
'@q2/sw-renderer': patch
---

Single-walk translucency: the recursive BSP walk admits each visible surface once (frustum/backface cull runs a single time) and records translucent surfaces into a reused deferred alpha list, drawn after all opaque geometry in reverse traversal order. Opaque-then-alpha ordering, BSP back-to-front within alpha, and stipple/alpha blend math are unchanged. Cuts the serial cull walk on spawn-north (interleaved before/after: cull lower in all 3 pairs, median −4.0 ms under concurrent-lane load). All goldens byte-identical: devroom `8f61c755`, base1 ×4 views, TRANS66 pool-water mode-1 `06456518` / mode-0 `1dc00e44`.
