# @q2/webgl-renderer — WebGL2 backend (GPU-PROOF-2: boundary + resource ownership)

Experimental GPU renderer for fast gameplay with a reviewed Voodoo-style
appearance. This package owns the GPU scene/backend boundary and GPU
resource lifetime. Browser glue (canvas/context acquisition) lives in
`apps/web`; this package only ever receives an injected context.

> PROOF-2 scope: NO scene drawing, NO appearance policy (PROOF-3/4).
> `renderFrame` proves context/target ownership with a viewport + clear;
> real scene buffers land in PROOF-3.

## What PROOF-2 owns

- `src/scene.ts` (pure, GL-free, DOM-free): `selectGpuScene` reuses the
  software asset/BSP front end (`MiniWorld`, `setupCamera`,
  `findLeaf`/`clusterVisible`) and emits `GpuSceneInput` — visible
  surfaces (PVS-gated leaf faceLists, deduped; frustum-culled by bbox;
  backface-culled when opaque non-sky), material classification
  (sky/turbulent/transparent/opaque), entity refs (md2→alias, sp2→sprite,
  tracer→beam via a caller-supplied kinds map; transparent when
  `(alpha ?? 1) < 1`; translation + yaw-rotation transforms), transparent
  blend-pass order (far→near, larger order = farther), `transforms[0]` =
  identity world slot, `staticGeneration` starting at 1. Runs on
  map/view change, never per frame — per-build garbage is acceptable.
  Entity kind resolution needs the model registry, which the pure
  selector cannot see: the optional `modelKinds` seam carries it
  (unknown handles default to `alias`); PROOF-3 threads the real registry.
  The owning glue MUST bump `staticGeneration` on map change — a fresh
  map also builds at 1, so the renderer only re-uploads on change.
- `src/capability.ts`: `describeGpuCapability` — null → unavailable +
  reason; live context → available + GL VERSION string; throwing context
  → unavailable + error reason. Never throws.
- `src/renderer.ts`: `WebGLRenderer implements
  GpuRenderer<WebGL2RenderingContext>` — owns the injected context, the
  DEFAULT framebuffer target (viewport + clear color), and
  per-generation upload bookkeeping (`uploadedGeneration`, counted via
  `testUploadStats()`). `init`/`resize`/`setScene`/`renderFrame`/
  `dispose`/`handleContextLost`/`handleContextRestored`/`getStatus` per
  the `GpuRenderer` contract. Wrong-state use records `lastError` AND
  throws `Com_Error`. Normal rendering never reads pixels back
  (no `readPixels` in `src/`).

## What PROOF-3 / PROOF-4 will add

- PROOF-3: real drawing from the stored scene — persistent vertex/index
  buffers uploaded once per `staticGeneration`, texture/lightmap upload,
  depth testing, batching by material without disturbing transparent
  order, animated viewmodel/entities, browser integration compiling real
  shaders.
- PROOF-4: the Voodoo appearance contract (sampling/mip policy, fog,
  RGB565 quantization, ordered dither, reconstruction, gamma, HUD
  ordering) in shader/target passes, with shared policy reuse from
  `@q2/voodoo` where pure.

## Dependency rationale

- `@q2/renderer-api`: the `GpuRenderer`/`GpuSceneInput`/`GpuCapability`
  boundary this package implements (additive GPU-PROOF-2 types).
- `@q2/sw-renderer`: reuses the proven CPU front end — `MiniWorld`
  geometry, `setupCamera`/`culledByFrustum`, `findLeaf`/`clusterVisible`
  PVS traversal — so selection agrees with the software reference on
  what is visible. No span/raster code is touched.
- `@q2/math`: `Vec3` coordinate types for the pure transform helpers.
- `@q2/config`: `Com_Error` engine error convention (never silent).
- `@q2/bsp`: world-source asset loading (`loadBsp` for the real-base1
  selection tests; world conversion itself reuses `bspToMiniWorld`).
- Browser graphics types (`WebGL2RenderingContext`) appear ONLY in this
  package and `apps/web`; `src/scene.ts` stays GL-free and DOM-free.
