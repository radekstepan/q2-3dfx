# @q2/bsp

BSP38 (IBSP v38) loader, PVS decompression, and collision traces. Ports
`qcommon/cmodel.c` (`CM_PointLeafnum_r`, `CM_ClipBoxToBrush`,
`CM_RecursiveHullCheck`, `CM_BoxTrace`, `CM_DecompressVis`) over the
`qcommon/qfiles.h` 19-lump layout.

## Public API

Entry point: `src/index.ts` (re-exports `bsp38.ts`, `pvs.ts`, `trace.ts`).

- `loadBsp(buf): BspMap` — parses all 19 lumps into flat typed arrays, never arrays of objects (BRAIN.md §8). `BspMap` structurally extends the `@q2/formats` `Bsp38` stub (same `planes/nodes/leafs/faces/raw` field types) plus `planeTypes, vertexes, visibility, numClusters, visBitofs, nodeMins/Maxs, texinfo*, lighting, leaffaces, leafbrushes, edges, surfedges, models*, brushes, brushsides, entities, pop, areas, areaportals` (`src/bsp38.ts:149`).
- `lumpCounts(w)` — element counts per lump, for stats/reporting (`src/bsp38.ts:388`).
- `decompressVis(src, inOfs, numClusters, out)` — one RLE visibility row; offset 0 means all-visible (`src/pvs.ts:23`).
- `clusterPVS(world, cluster): Uint8Array` — PVS for a cluster; cluster < 0 yields zeros (`src/pvs.ts:52`).
- `pointLeaf(world, p): number` — leaf index containing a point (`src/trace.ts:34`).
- `traceBox(world, start, end, mins, maxs, mask): Trace` — swept-box trace through model 0's headnode; `Trace` = fraction/endpos/planeNormal+planeDist/contents/entityNum/startsolid/allsolid (`src/trace.ts:320`).
- Lump/stride constants: `BSP_IDENT/VERSION`, `LUMP_*`, `HEADER_LUMPS`, `NODE/LEAF/FACE/BRUSH/BRUSHSIDE/MODEL_EXTRA/AREA/AREAPORTAL_STRIDE`, `DIST_EPSILON` = 1/32 (`src/bsp38.ts:33`, `src/trace.ts:14`).

## Usage

Consumed by `@q2/game` (pmove collision), `@q2/server` (world bridge),
`@q2/sw-renderer` (`clusterPVS` + `FACE_STRIDE` in `bspWorld.ts`),
`@q2/testkit` (real-base1 renders).

```ts
import { loadBsp, pointLeaf, traceBox } from '@q2/bsp';
import { v3 } from '@q2/math';
const world = loadBsp(pak.readFile('maps/base1.bsp'));
const leaf = pointLeaf(world, v3(96, -224, 24));
const hit = traceBox(world, start, end, v3(-16,-16,-24), v3(16,16,32), 1);
```

## Testing

```bash
yarn workspace @q2/bsp test
```

`src/bsp38.test.ts` + `src/testmap.ts` (synthetic 19-lump map),
`src/pvs.test.ts` + `src/fixtures/base1-pvs.ts` (6 real base1 rows,
numclusters=1446), `src/trace.test.ts` (2000-ray deterministic sweep).

## Constraints

Dependency direction (BRAIN.md §4): may depend on `config`, `formats`,
`math` (it does: `package.json`). Must not import `game`, `server`,
renderers, or anything upstream. DOM-free; runs in browser, worker, Node.
