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

## Constraints

- Dependency direction (BRAIN.md §4): above `bsp`/`formats`/`math`, below `renderer-api` consumers; must never import `dom` types (worker + Node safe).
- Platform: DOM-free, zero allocation per frame (scratch buffers on the instance); color is `Uint32Array 0xAABBGGRR`, index `Uint8Array`, depth `Float32Array 1/z`.
