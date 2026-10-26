---
'@q2/sw-renderer': patch
---

Fix radial blaster dlight on real maps: luxel grid now matches C CalcSurfaceExtents (M3.2)

`bspToMiniWorld` sized each face's lightmap grid as `floor(span/16)+1`, but id `CalcSurfaceExtents` (r_model.c) rounds `floor(min/16)..ceil(max/16)` and forces extents to >= 16 texels (every face owns at least 2x2 luxels). On unaligned faces — 6464 of 7905 base1 faces — the lighting-lump slice row-shifted every static luxel after the first row and cut the far row/col off the dynamic per-luxel falloff grid, so firing the blaster at a floor lit whole tile-rows while neighboring tiles stayed dark instead of a radial disc. The grid now matches C exactly (0 mismatches on base1's 7663 renderable faces), keeping `testAddDynamicLight`/`testClearDynamicLights` stable and devroom goldens intact. New `dlightRows.test.ts` repro: C-layout conversion pin, static row-uniformity render pin, radial-disc render pin, plus a Q2_PAK-gated all-faces grid pin (skips cleanly without pak).
