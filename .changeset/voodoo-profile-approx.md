---
"@q2/voodoo": patch
---

feat(voodoo): documented approximation profile + CLAMPED pad-to-POT upload

- Adds `VOODOO_APPROX_PROFILE` (`src/profile.ts`): every non-hardware-calibrated setting with its source tag (`manual:fbzMode` / `manual:vidProcCfg` / `manual:tLOD` / `approx:chosen` / `preset:appearance`) — dither weights/phase, subtract-then-filter order + matched pairs, provisional tap alignment, rgbMaxDelta values, gamma curve/value/stage (default 1.3 appearance preset), LOD +0.375 single compensation, non-POT policy, normalized Z16, W-buffer NOT implemented. Pinned by `src/profile.test.ts`.
- Adds `padTextureToPOT` + `nextPOT` (`src/upload.ts`) for CLAMPED non-POT textures (edge-replicate pad to POT + UV scale adjust, texels byte-exact) beside the existing `resampleTexture` path for REPEAT textures; documents the application/driver policy choice. No behavior change to existing helpers.
- Documents why `reconmode: 'legacy'` stays the default (bit-exact M4.1 preservation; subtract modes opt-in until HW capture), provisional tap-alignment windows, and explicit W-buffer non-implementation. No resolve/sampler behavior changed.
