---
'web': minor
---

Browser async render follow-up (M7.1 perf lane): the live rAF loop now uses
the pooled async path when workers are available, with a sync fallback.

- `dom.ts` rAF tick: runs `frameAsync` (pumps + sim + async kick + resolve)
  when a worker pool is attached, classic `host.frame` otherwise; in-flight
  guard prevents overlapping frames/double-pumped sim, and one bad frame
  falls back to sync without wedging the loop. Pool pre-spawned once per
  loop (never per frame) and disposed on stop; `sw_workers` left at default
  0 latches a `hardwareConcurrency`-capped count in-session.
- `play.ts` `attachBrowserPool`: pool sized from the `sw_workers` cvar
  (bands − 1) when no explicit count is passed.
- `render-workers.ts`: new `defaultBrowserWorkers()` helper.
- `blitToCanvas`: cached `ImageData` (no per-frame `createImageData`) +
  bulk u32 copy on little-endian (0.074 ms vs ~1.8 ms per-byte loop at
  640×480 headless, byte-identical); new pure `blitCopyRGBA` + tests.
- M7.1 60fps box stays unchecked: headless numbers recorded, real-browser
  sign-off still needs an in-browser run (pool tuning + fps meter).
