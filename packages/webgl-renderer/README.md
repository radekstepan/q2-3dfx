# @q2/webgl-renderer — WebGL2 backend (GPU-PROOF-3: real scene drawing)

Experimental GPU renderer for fast gameplay with a reviewed Voodoo-style
appearance. This package owns the GPU scene/backend boundary and GPU
resource lifetime. Browser glue (canvas/context acquisition) lives in
`apps/web`; this package only ever receives an injected context.

> PROOF-3 scope: real scene drawing in plain linear RGB. Appearance policy
> (dither/RGB565/fog/gamma/mip/LOD) is PROOF-4, explicitly out of scope —
> LINEAR filtering, no mipmaps, no quantization selections here.

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
  throws `Com_Error`. Asset inputs (concrete methods): `attachWorld`,
  `setPalette`, `registerModelData`, `registerSkinPixels`, `setEntities`
  (per-frame entity list, stored by reference). `renderFrame` draws the
  real passes — sky, opaque world (lit), opaque alias + sprites, gun pass
  (depth-hack MVP), POINTS particles, blend pass (transparent world in
  scene order, transparent alias, beams) — or the PROOF-2 clear-only
  submit when no assets are attached (lifecycle contract preserved).
  Normal rendering never reads pixels back (no `readPixels` in `src/`).
- `src/shaders.ts`: production GLSL ES 3.00 sources (exported reviewable
  consts) — lit world, alias, flat vertex-color programs — plus
  `compileProgram` with explicit shader/program info-log errors.
- `src/worldMesh.ts` (pure): fan triangulation, per-texId opaque batches,
  order-preserving transparent runs, sky collection, one-RGB-atlas lightmap
  pack with baked style scales, palette texture expansion.
- `src/alias.ts` (pure): MD2→GPU mesh (same welded index order as the CPU),
  per-frame frameA→frameB lerp + shade-dot base.
- `src/entities.ts` (pure): `updateGpuEntities` (entity-ref tail refresh
  only; world refs reused by reference) + CPU billboard/beam/particle
  emitters.
- `src/matrices.ts` (pure): Quake-camera MVP math (near=4 like the CPU).

## Documented PROOF-3 approximations (ROADMAP to PROOF-4/EXPAND)

- LINEAR filtering, no mipmaps (PROOF-4 owns LOD/bilinear policy).
- Lightmap style scale baked per style-signature (re-baked on change).
- Dynamic lights per-pixel in world + alias shaders (CPU: per-luxel bake).
- Gun depth: NDC z remap (scale 0.02, bias -0.9) — GPU reading of
  RF_DEPTHHACK 1/z x3 (wins except nose-to-wall).
- Beams are ~1.5px camera-facing quads (CPU: 1px DDA core+glow).
- No GL face culling (visibility = selectGpuScene's CPU backface rule).
- Turbulent water draws unwarped (warp deferred to PROOF-4/EXPAND).
- Translucency is true blending (CPU: screen-door on the 8-bit path).
- Non-POT skins upload as-is with a warning (Voodoo 256 cap is PROOF-4).

## What PROOF-4 will add

- The Voodoo appearance contract (sampling/mip policy, fog,
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
- `@q2/formats`: test-only real-asset parsing for the Q2_PAK-gated F1 leg
  (`parseMD2` for soldier/gun meshes, `parseWAL` for diffuse texels,
  `parsePCX` for palette/skins) — mirroring `game`, which also uses
  formats for asset data. Needs the integrator's `deps:check` allowlist
  entry (`'webgl-renderer': [..., 'formats']`, same justification).
- Browser graphics types (`WebGL2RenderingContext`) appear ONLY in this
  package and `apps/web`; `src/scene.ts` stays GL-free and DOM-free.
