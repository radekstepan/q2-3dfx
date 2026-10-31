---
'@q2/game': patch
'@q2/server': patch
---

R9F-10: brown-water hitscan splash via contract-safe surface query. Game adds bspBrownWaterFor/isBrownWaterTexture (brwater-suffix match over WATER brushes, existing bsp views only). Server adds optional SVFireOpts.brownWaterAt + WaterSplashKind brown (base 0x50); WATER without the query stays blue, slime/lava/dry unchanged. Real-asset cover: base1 blue stays blue, train brwater draws brown, dry wall draws no splash.
