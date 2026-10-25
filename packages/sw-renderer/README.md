# @q2/sw-renderer

Software 8-bit palettised renderer — the `ref_soft` port (BRAIN.md §7.1, M3.1–M3.4).
Spans, surface cache, BSP traversal, alias models, sprites, particles.
Writes into handed buffers; no DOM types (`src/index.ts:1-3`).

Entry point: `src/index.ts`. `SoftwareRenderer` / `SoftwareBackend` live in `src/frame.ts`.

## Public API

- `SoftwareRenderer` (`src/frame.ts:122`) — implements `Refresh`: `init(fb)` (`:159`), `beginFrame()` (`:200`), `renderView(view, world, entities)` (`:209`), `endFrame()` palette-expand (`:395`), `setPalette`, `registerModel`, `registerSkin`.
- `SoftwareBackend` (`src/frame.ts:44`) — monomorphic `RasterBackend`: `drawSpans` branches on span kind outside the pixel loop.
- `sortBatchByRow(...)` (`src/frame.ts:74`), `MAX_SPANS` (`src/frame.ts:32`) — per-surface row z-sort batching.
- Spans (`src/spans.ts`, re-exported `src/index.ts:5-15`): `SPAN_OPAQUE/SPAN_TURBULENT/SPAN_FLAT`, `runSubdiv16`, `drawSpansSoftware`, `drawSpansTurbulent`.
- `SurfaceCache` (`src/index.ts:22-26`), `buildLightMap`, `DLightState` (`:28-32`), camera `setupCamera`, `boxOnFrustumCulled` (`:34`), edges `projectClippedPoly`, `emitSpansForPoly` (`:36-40`), traversal `collectVisibleSurfaces`, `findLeaf` (`:42-48`).
- Alias/sprites/particles: `drawAliasInstance`, `createBoxMesh` (`:49-54`), `drawSprite` (`:56`), `drawParticles` (`:58`).
- `createDevroom()`, `createDevSkins()`, `getDevMesh()`, `DEVROOM_CAMERA` (`src/devroom.ts:118,196,110,9`) — procedural asset-free map.
- `bspToMiniWorld(map, opts)`, `BspTexelSource` (`src/index.ts:62-67`) — WIRE bridge for real BSP38 maps.

## How it is used

Consumed via the `Refresh` contract by `@q2/testkit` (`src/base1-render.test.ts:12-14`)
and any `Refresh` host (headless harness, bench, web shell).

```ts
import { SoftwareRenderer } from '@q2/sw-renderer';
import { createFramebuffer } from '@q2/renderer-api';
const fb = createFramebuffer(320, 240, true);
const r = new SoftwareRenderer();
r.init(fb); r.setPalette(pal); r.beginFrame();
const stats = r.renderView(view, { name: 'devroom', data: createDevroom() }, []);
r.endFrame(); // fb.color now holds 0xAABBGGRR
```

## Testing

- `yarn workspace @q2/sw-renderer test` — vitest, incl. `src/golden.test.ts:44`: fixed-camera devroom 320x240 render pinned to hash `8f61c755`; determinism, dynamic-light invalidation, 100% steady-state cache-hit tests.
- `yarn workspace @q2/sw-renderer golden` is a stub; real-map WIRE test lives in testkit (`Q2_PAK=...` gated, 4.0x overdraw ceiling).
- `node ./bench.mjs` — headless perf run.

## Overdraw attribution (M3.3, option b)

The 1.15x budget assumed span-level occlusion, which `ref_soft` never had: it
buckets with PVS + frustum + backface and lets the z-buffer absorb everything
in-frustum-but-occluded. Per-span occluder clipping would be new,
non-C-faithful work for zero visible-output change, so the budget — not the
renderer — was wrong. `src/overdraw.ts` + `SoftwareRenderer.testMeasureOverdraw`
prove it with per-view accounting (every PVS-admitted surface lands in exactly
one bucket; emitted span pixels reconcile with depth-written pixels):

| view @640x480 | surf | pvs | emit | cull f/b/c/d | candidate | written | z-rejected (share) | overdraw |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| spawn-north | 7905 | 4495 | 1802 | 1003/1366/261/63 | 725725 | 307200 | 418525 (57.7%) | 2.362 |
| spawn-west | 7905 | 2822 | 1079 | 790/764/156/33 | 556121 | 307200 | 248921 (44.8%) | 1.810 |
| lowroad-west | 7905 | 1280 | 583 | 283/317/72/25 | 671615 | 307200 | 364415 (54.3%) | 2.186 |
| trench-east | 7905 | 5113 | 1977 | 608/1890/579/59 | 594689 | 307200 | 287489 (48.3%) | 1.936 |
| devroom @320x240 | 11 | 11 | 6 | 1/4/0/0 | 101960 | 76800 | 25160 (24.7%) | 1.328 |

(`src/overdraw.test.ts`, `Q2_PAK`-gated for base1; run:
`yarn workspace @q2/sw-renderer test --run src/overdraw.test.ts`.)

Reading: PVS cuts 7905 surfaces to 1280–5113 admitted; frustum + backface name
every admitted-but-unemitted surface (zero unaccounted bucketing waste); screen
coverage is exactly 1.000 on all four views while 44.8–57.7% of span fill loses
the depth test — in-frustum occluded spans, by construction. Front-to-back BSP
order + the strict `>` test mean each pixel is written at most once
(`written <= area` asserted), so the residual is hidden-surface removal, not
re-draw. Armed-vs-plain renders are byte-identical, and base1 hashes match the
pre-change ledger (`fbf00c26`, `3cb12e30`, `0eb44f33`, `a64faa42`).

Recommended budget (coordinator to apply in BRAIN.md): replace the
`overdraw ≤1.15x` M3.3 done-when with a `≤2.5x` ceiling at 640x480 on base1's
opening room (worst measured 2.362, margin ~6%).

## Constraints

- Dependency direction (BRAIN.md §4): above `bsp`/`formats`/`math`, below `renderer-api` consumers; must never import `dom` types (worker + Node safe).
- Platform: DOM-free, zero allocation per frame (scratch buffers on the instance); color is `Uint32Array 0xAABBGGRR`, index `Uint8Array`, depth `Float32Array 1/z`.
