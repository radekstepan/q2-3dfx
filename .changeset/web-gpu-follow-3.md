---
'web': patch
---

GPU-FOLLOW-3 lane B (apps/web): wire live combat events to GPU drawing. Add the effects inventory + per-frame helpers (model-kind map, beam synthesis, light consts, material censuses, live-effects reader); frameGpuPlay submits full retained-asset kinds to selection and draw dispatch; soak route gains additive optional `effects`. Prove blaster→bolt→muzzle-light→impact-explosion→particles→submitted geometry→real submissions plus monster tracer beams, refire/muzzle/gunframe timing, full weapon/enemy/pickup registration sweep, and sky/glass/water submission on a live walk, with a headless-browser combat-pixels leg.
