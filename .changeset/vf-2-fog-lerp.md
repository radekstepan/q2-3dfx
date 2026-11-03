---
"@q2/voodoo": patch
"@q2/webgl-renderer": patch
---

VF-2 fog de-banding: inter-entry lerp on the CPU (`fogFactor`/`fogFactorLerp` in `sampler.ts`) and GPU (`voodooApplyFog` in `appearance.ts` + `fogTableLerpFor`/`fogFactorLerpFor` mirrors) per PG §10.3.4, with `w01*64` standing in for the hardware 1/W bit-split. New `VOODOO_APPROX_PROFILE` fog entries: formula + index-domain (`approx:chosen` driver/caller policy), interpolation (`manual:fogTable`, implemented), 6.2 deltas + fogdither/forzones (tracked NOT-implemented omissions). Smooth-ramp pins (no 64-step cliff) and CPU/GPU parity pins (0.005 ≈ 1.3 LSB) in both packages' tests.
