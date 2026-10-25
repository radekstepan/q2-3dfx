---
"@q2/bsp": minor
---

feat(bsp): BSP38 loader + PVS + traceBox/pointLeaf (M2.1)

BSP-side M2.1: full IBSP v38 loader (all 19 lumps as flat typed arrays), RLE leaf/cluster PVS decompression (CM_DecompressVis port), pointLeaf node walk and BoxTrace hull/clip sweep (CM_RecursiveHullCheck/CM_ClipBoxToBrush port, DIST_EPSILON 1/32, contents-mask filtering, position-test special case).

Vitest: 26 tests — 19-lump parse of a synthetic map, PVS unit cases + 6 real base1.bsp cluster rows byte-compared against a committed fixture, traceBox smoke (corridor fraction 1, wall hit with +X/-X normals, box-extents offset, startsolid/allsolid, mask filtering), pointLeaf consistency, and a 2000-ray deterministic-PNRG sweep with recorded spot fractions. Validated against real base1.bsp: 8558 planes, 5202 nodes, 5238 leafs, 1765 brushes, 1446 clusters.
