---
"@q2/sw-renderer": minor
---

fix(sw-renderer): flat sky fill + soldier-shaped fallbacks (feedback follow-up)

- Sky surfaces (`SURF_SKY` → `MiniSurf.sky`) bypass texture/lightmap/cache and render as depth-tested `SPAN_FLAT` spans in the bluest-bright palette entry (`pickSkyIndex`, recomputed per palette); sky exempt from backface cull (sky hulls face outward). `SPAN_FLAT` now handled in classic, banded inline/packed/worker, and wasm backends. Previously sky fell through to the orange fallback checker with visible edges.
- Real MD2s with a missing skin fall back to an olive-drab `createSoldierSkin` (gun fallback keeps gunmetal); new `createSoldierMesh` 6-box humanoid fallback so missing data never renders as a cube. Devroom golden `8f61c755` intact.
