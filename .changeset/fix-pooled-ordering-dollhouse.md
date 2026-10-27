---
'@q2/sw-renderer': patch
---

Pooled ordering: foreground, translucent alpha and resolve no longer race the deferred world kick. Three latent ordering bugs made the live browser loop (now on `renderViewAsync`) lose the world or the water on staging-exhausting views (whole map visible, e.g. embedded cameras) — the "doll-house" black frame:

- The deferred async kick's lazy per-band worker clear wiped everything drawn before it. `renderViewAsync` now draws the entity foreground AFTER the kick (same order as sync; `drawForeground` split out of `renderView`), and the deferred staging break replays inline and latches `deferredInlineRest` so the rest of the frame stays inline with no trailing kick to wipe it (all writes stay depth-guarded, output identical).
- The translucent alpha loop drew before the kick and was wiped whenever the kick cleared (i.e. nondeterministically, depending on whether a break had run workers earlier). It now runs first inside `drawForeground`, after the kick — pooled sync/async water matches classic bit-for-bit on the low-road pool view.
- The parallel resolve kick cleared bands on a stale frame generation, wiping all-inline and zero-batch frames (the resolve only reads planes; freshness is owned by raster kicks and main-thread clears). The worker clear is now raster-only and the main band no longer clears on resolve.

Regression pins: pooled async vs pooled sync with world alias and with a depthHack gun entity (both failed pre-fix), plus pooled sync/async vs classic on TRANS66 water (failed pre-fix on both pooled paths). A 135-view base1 corner sweep is async-identical to sync everywhere with the classic walk hashes unchanged.
