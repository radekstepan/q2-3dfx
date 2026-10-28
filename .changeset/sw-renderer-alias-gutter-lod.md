---
'@q2/sw-renderer': patch
---

fix(sw-renderer): alias gutter-LOD bias + clamp taps kill black areas on MD2s

Real MD2 skins are ~40% pure-black gutter around thin mapped islands
(barrel 37%, soldier 47% index-127 black), so the shared vd_lodbias parks
mid-range models on coarse box-filtered mips that average to gutter grey —
shadow sides of barrels/enemies/bolts render flat black while software
(affine L0, never mips alias) keeps the texture. Measured entity-isolated
pre-resolve: soldier yaw90 @120u 29.4% pure-black pixels, bolt @40u 64.5%.

- `rgbMaterialForAlias` adds `ALIAS_LOD_BIAS_DELTA` (-3.3) to the fidelity
  lodBias (lands default -0.35 on -3.65: soldier 0.4%, bolt 0.0%
  post-resolve, at/below software levels everywhere measured). World
  textures tile (no gutters) and keep the shared bias; close-range
  viewmodels (L0 either way) unchanged in kind.
- `fillPerspTriRGB` honors `mat.addressS/T` (was hardcoded repeat):
  alias clamp materials no longer wrap edge taps into far-edge gutter.
- Fail-before gates: `rgbAliasSkin.test.ts` (4 tests: clamp tap, delta
  value, delta-vs-shared sampling, frame-level RGB/software parity).
- Devroom RGB pin re-pinned with cause (`436fe0c5` → `206e1dad`, critter
  pixels only; index `58e0ecf1` + all software goldens unchanged).

No per-pixel cost change (same taps, build-time bias only).
