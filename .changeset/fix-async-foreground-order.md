---
'@q2/sw-renderer': patch
---

Async foreground ordering: the entity foreground now draws after the deferred pooled world kick. The kick lazily clears every band it touches, so foreground drawn before it (world alias, entities including the depthHack viewmodel gun, sprites, particles, tracer beams) was wiped — the live browser loop (now on `renderViewAsync` after the async-tick lane) lost the hand gun. `renderView` is split into world pass + `drawForeground`; the sync path calls it inline in the same order as before (bit-identical), the async path calls it after `flushAccumAsync`. Regression pins: pooled async vs pooled sync with world alias and with a depthHack gun entity (both failed pre-fix with the foreground wiped, green post-fix).
