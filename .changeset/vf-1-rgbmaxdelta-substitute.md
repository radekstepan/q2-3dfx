---
"@q2/voodoo": patch
"@q2/webgl-renderer": patch
---

fix(voodoo,webgl-renderer): VF-1 rgbMaxDelta per-component substitute-then-filter (PG §6.5.2)

- CPU `parseRgbMaxDelta` and GPU `parseRgbMaxDeltaStr` clamp to 6-bit 0..63 (was 0..255); defaults stay 8,8,8 and `0,0,0` still disables to the unconditional box.
- `passesReconstructionThreshold[Row]` metric is per-tap absolute deviation from the centre (p00 for 2x2, p1 for 4x1), not block max-min spread.
- New `substituteTap` / `reconstructFiltered2x2` / `reconstructFilteredRow` implement the hardware rule: breaching components are replaced with the centre tap before the box filter (e.g. taps {0,0,0,10} centre 0 filter to 0 with one clamped component).
- GLSL `FS_APPEARANCE` replaces the whole-block `passesGate` reject with `subTap` + `gateDisabled`: non-centre taps substitute per-component against the centre, then average; `0,0,0` averages raw taps.
- Restates `scanout.rgbMaxDelta-register` profile entry (substitute rule, deviation metric, 6-bit range) and the mirrored `vd_rgbmaxdelta` cvar note. Adds fail-before vectors (mixed-tap clamp, >63 clamp, CPU↔GLSL parity pin).
- Fixes a pre-existing `@q2/webgl-renderer` typecheck break: `button-anim.test.ts` imported `RefDef` from `@q2/sw-renderer` (not exported there); now imports from `@q2/renderer-api`.
