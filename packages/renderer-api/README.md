# @q2/renderer-api

Frozen `Refresh` / `Framebuffer` / `RefDef` contracts both renderers implement (BRAIN.md §6).
No engine internals, no renderer code — just the interface plus a headless null backend.

Entry point: `src/index.ts` (frozen `Refresh` side); `src/gpu.ts` holds the
GPU scene/backend boundary (`GpuRenderer`, `GpuSceneInput`, `resolveRendererSelection`).
RELEASE-8 removed `voodoo` from `ResolvedBackend` (now
`software | webgl2-experimental`); persisted `voodoo` requests migrate
one-time to `software` with an explicit warning, never auto-promoted to webgl2.

## Public API

- `Refresh` (`src/index.ts:39`) — frozen: `init(fb)`, `beginFrame()`, `renderView(view, world, entities)`, `endFrame()` (resolve), `setPalette(p)`, `registerModel(m)`, `registerSkin(name)`. Changing it needs a major changeset (BRAIN.md §6).
- `Framebuffer` (`src/index.ts:4`) — `{ width, height, color: Uint32Array 0xAABBGGRR, index?: Uint8Array, depth: Float32Array 1/z }`.
- `createFramebuffer(w, h, indexed)` (`src/index.ts:50`) — allocates color/depth (+ index for software).
- `RefDef` (`src/index.ts:14`) — `{ origin, angles, fovX, time, lightStyles: Float32Array(256) }`; also `Entity` (`:24`), `Model`/`ModelHandle` (`:20-22`), `WorldModel` (`:30`), `FrameStats` (`:35`).
- `NullRefresh` (`src/index.ts:68`) — headless `Refresh`: deterministic gradient + view-dependent checker + 5x5 entity markers; `getFramebuffer()` (`:80`) exposes the buffer for harnesses.
- `devroomWorld()` (`src/index.ts:155`), `devroomView(time)` (`src/index.ts:160`) — asset-free fallback world/camera (BRAIN.md §8).

## How it is used

Imported for types (and `NullRefresh`) by `@q2/sw-renderer` (`src/frame.ts:6-8`),
`@q2/testkit` (`src/index.ts:2`), `@q2/host`, `@q2/client`. Implement `Refresh` to add a backend:

```ts
import { createFramebuffer, NullRefresh, devroomView, devroomWorld } from '@q2/renderer-api';
const r = new NullRefresh();
const fb = createFramebuffer(64, 48, true);
r.init(fb); r.beginFrame();
r.renderView(devroomView(0), devroomWorld(), []);
r.endFrame();
```

## Testing

- `yarn workspace @q2/renderer-api test` — vitest: `src/contract.test.ts` (Entity evolution) and `src/gpu.test.ts` (selection resolver incl. legacy-`voodoo`→`software` migration).

## Constraints

- Dependency direction (BRAIN.md §4): leaf contract above `sw-renderer`, below `host`/`client`; depends only on `@q2/config`, `@q2/math`. Never import `apps/*`.
- Platform: DOM-free, runtime-free types + plain typed arrays; `NullRefresh` runs in browsers, workers, and Node.
