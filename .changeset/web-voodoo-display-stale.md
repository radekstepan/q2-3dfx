---
"web": patch
---

fix(web): voodoo display no stale on postfilter off

`resolveDisplay` now backfills `boot.display` when `vd_postfilter` is off
and `resolveFrame` leaves it untouched (astra §2 defect #1): a pixel-0
sentinel (alpha 0x12, impossible in opaque resolve output) detects the
pre-fix behaviour and only then expands `fb565` via `expandRGB565`
(`vd_16bit` on) or a gamma-lifted RGB888 copy (`vd_16bit` off, no dither).
Once `@q2/voodoo` lands its always-fill `resolveFrame` the sentinel is
overwritten with real output and the backfill never runs — zero extra
passes, robust to both behaviours. Covered by
`apps/web/src/voodoo-display.test.ts` (postfilter toggle freshness, all 8
`vd_16bit`/`vd_dither`/`vd_postfilter` combos, sub-565 bypass, brightness).
Renderer switching (`applyRendererCvar`) and the software byte-identical
path are untouched.
