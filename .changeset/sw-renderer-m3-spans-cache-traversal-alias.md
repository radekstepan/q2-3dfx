
---
"@q2/sw-renderer": minor
---

feat(sw-renderer): full software renderer — spans, surface cache, traversal, alias (M3.1-M3.4)

M3.1 span rasteriser: D_DrawSpans16 port with 16-pixel affine subdivision, 16.16 fixed point, one division per 16px, colormap[(light<<8)+texel], 1/z depth test. Monomorphic typed-array loops, preallocated span pool, separate spanSoftware/spanTurbulent/spanFlat passes (branch on span, never in pixel loop). Measured 120 Mpixel/s at 640x480 (budget 40).

M3.2 surface cache: R_BuildLightMap equivalent (luxel luma x style scale + dynamic-light falloff), LRU keyed by (surface, lightstyle hash, miplevel), 4MB budget, dynamic-light invalidation path via DLightState.markLights.

M3.3 traversal: recursive node walk with PVS + frustum reject, near-clip project, edge list to z-sorted spans (per-row 1/z sort, BSP-order coplanar-stable under strict > depth test).

M3.4 alias/sprite/particles: MD2-style affine triangles with shade dots (162-norm table), clipped billboard sprites, single-pixel depth-tested particles.

Frozen Refresh implemented (init/beginFrame/renderView/endFrame/setPalette/registerModel/registerSkin); procedural devroom fallback keeps golden tests asset-free. 41 vitest tests incl. 320x240 golden hash.
