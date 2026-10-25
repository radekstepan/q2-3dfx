// @q2/sw-renderer — ref_soft port (BRAIN.md §7.1). M3.1..M3.4.
// Software 8-bit palettised renderer: spans, surface cache, BSP traversal,
// alias models, sprites, particles. No DOM types; writes into handed buffers.

export {
  SUBDIV,
  SPAN_OPAQUE, SPAN_TURBULENT, SPAN_FLAT,
  createSpan,
  runSubdiv16, runSubdivTurbulent, runSpanFlat,
  sampleLightBlock, textureMasks,
  drawSpansSoftware, drawSpansTurbulent, drawSpansFlat,
  drawSpans16, SoftwareBackend,
  buildTurbTable, spanListView,
  type Span, type SpanList, type Texture, type LightBlock, type RasterBackend,
} from './spans.js';

export {
  WasmSpanBackend, wasmRequestedByCvar, buildSpanModuleBytes, wasmMemoryLayout,
  SW_WASM_CVAR, MAX_WASM_SPANS,
  type DrawOpaqueFn, type WasmMemoryLayout,
} from './wasmSpans.js';

export {
  COLORMAP_GRADES, COLORMAP_SIZE,
  buildColormap, defaultPalette,
} from './colormap.js';

export {
  SURFACE_CACHE_BUDGET,
  SurfaceCache, surfaceCacheKey, hashLightStyles,
  type SurfaceBlock,
} from './surfaceCache.js';

export {
  buildLightMap, combineStyleScales, bboxDistance,
  DLightState,
  type DynamicLight, type SurfaceBounds,
} from './light.js';

export { setupCamera, buildFrustum, boxOnFrustumSide, culledByFrustum, type Camera } from './camera.js';

export {
  createEdgeScratch, projectClippedPoly,
  emitSpansForPoly, sortRowSpans,
  type EdgeScratch, type PolyInput, type ProjectedVert, type RowSpan,
} from './edges.js';

export {
  collectVisibleSurfaces, findLeaf, clusterVisible, surfFrustumCulled, nodePlaneSide,
  isMiniWorld,
  type MiniNode, type MiniLeaf, type MiniTexture, type MiniLightmap, type MiniSurf,
  type MiniWorld, type PlacedAlias, type PlacedSprite, type PlacedParticle,
} from './worldNodes.js';

export {
  ANORM_COUNT,
  buildANorms, buildShadeDots,
  createBoxMesh, drawAliasInstance, fillAffineTri,
  type AliasMesh, type AliasInstance, type AliasSkin,
} from './alias.js';

export { drawSprite, type SpriteDef, type Scissor } from './sprites.js';

export { drawParticles, projectParticles, type ScreenParticle } from './particles.js';

export { createDevroom, createDevSkins, getDevMesh, DEVROOM_CAMERA } from './devroom.js';

export {
  bspToMiniWorld,
  bspModelBounds,
  SURF_SKY, SURF_WARP, SURF_NODRAW,
  type BspTexelSource, type BspWorldOptions,
} from './bspWorld.js';

export { SoftwareRenderer, sortBatchByRow, MAX_SPANS } from './frame.js';
