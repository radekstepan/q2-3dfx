---
"@q2/sw-renderer": patch
---

M6.1 lighting follow-up (renderer side only): fix the dark multi-style baseline and the muzzle-dlight leak.

- `buildLightMap` now sums all per-style scales instead of using only `styleScales[0]`, so multi-style surfaces pick up every live style instead of going dark when style 0 is off (single-style surfaces resolve to exactly one scale: devroom golden `8f61c755` byte-identical; real base1 spawn-north mean index 56.27 -> 58.14 under WALs + real palette). Style slot 255 (id terminator) is skipped both when resolving scales in `renderView` and in `combineStyleScales`. New `LIGHT_STYLE_UNUSED` export plus a `LIGHT_OVERBRIGHT` modulate (default 1 = current look; pass 2 for the gl-style x2) as the cvar-friendly knob.
- Renderer-owned dynamic lights expire on their own via two paths: pump-driven hosts call the new `testExpireDynamicLights()` (drops all live flash requests, serial bump only when something was dropped so idle frames keep the cache hot — this is the hook `pumpMuzzleLight` already probes), and direct-add users are covered by a per-light ttl (`DEFAULT_DLIGHT_TTL_FRAMES = 2`): `renderView` sweeps `expireStaleLights()` before the serial check and `ageFrame()` after drawing, so an abandoned flash is rebuilt exactly once and the scene returns to baseline. `testAddDynamicLight`/`testClearDynamicLights` signatures unchanged; new `testDynamicLightCount()` observability. No allocation in the frame loop (swap-remove sweep, counter decrement).
