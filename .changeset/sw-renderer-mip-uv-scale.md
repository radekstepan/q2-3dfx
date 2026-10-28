---
'@q2/sw-renderer': patch
---

fix(sw-renderer): scale UVs into the picked RGB mip; drop the alias LOD bias to 0

`fillPerspTriRGB` picked a coarse mip but sampled it with full-resolution
UVs, so minified texels wrapped/clamped into the wrong mip texel — on
gutter-heavy MD2 skins usually black (repro: 2-level chain, force mip1 at
u=2.0: green sampled where red lives). The world span loops
(`runSubdivRGBRepeat/Clamp/Generic`) shared the defect (full-res
fixed-point/float UVs wrapped into shrunken mip dims). All samplers now
scale UVs into the selected level (`1/(1<<lvl)`; `>> lvl` on the
fixed-point paths, warp applied pre-scale). Fail-before gates:
`rgbMipUV.test.ts` (alias + repeat/clamp/generic, green-where-red
pre-fix, exact 565 asserts).

Bias reassessment (do not silently keep a masking bias): the old
`ALIAS_LOD_BIAS_DELTA` (-3.3) hid this sampling bug by pinning alias to
L0 — its supporting measurements are confounded (they were taken with
the bug active). Re-measured post-fix on real skins with production
sampling: soldier @120u 1.7% pure-black pre-resolve at shared bias (was
29.4%), @300u 2.5%, v_blast @40u 4.4% (was 64.5%), synthetic thin island
91% of L0 with 0% black — all flat across the bias sweep, so the delta is
now 0 and alias tracks the shared `vd_lodbias` like world textures
(`rgbAliasSkin.test.ts` re-pinned to assert shared ≈ L0). Trade: alias
now minifies with real mip filtering like hardware instead of staying
L0-sharp; viewmodels (rho < 1) unaffected.

Devroom RGB pins re-pinned with cause (`206e1dad` → `68b22dea`, minified
alias/world texels now sample correctly; index `58e0ecf1` + all software
goldens unchanged). One extra float scale per alias pixel; world loops
hoist per-level scales (fixed-level repeat: one shift per pixel).
