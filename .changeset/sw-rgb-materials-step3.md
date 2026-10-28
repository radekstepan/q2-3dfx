---
'@q2/sw-renderer': patch
---

Complete RGB material coverage on the serial classic path (astra step 3). The RGB overlay now handles alias/MD2 models incl. the depth-hack viewmodel (new perspective-correct filler, affine artifact fixed), sprites, particles, tracer beams (additive), turbulent water (warp), sky/skybox (clamp + flat), and translucent glass/water (true alpha 33/66 ratios, original back-to-front ordering, no stipple). Transparent index-255 texels never write color or depth. The classic indexed path always draws underneath on its own depth plane, so software output is bit-identical with the flag on or off; unsupported combos Com_Error. Default off preserved.
