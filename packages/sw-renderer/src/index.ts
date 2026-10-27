// @q2/sw-renderer — ref_soft port (BRAIN.md §7.1). M3.1..M3.4.
// Software 8-bit palettised renderer: spans, surface cache, BSP traversal,
// alias models, sprites, particles. No DOM types; writes into handed buffers.

export {
  SUBDIV,
  SPAN_OPAQUE, SPAN_TURBULENT, SPAN_FLAT, SPAN_TRANS33, SPAN_TRANS66,
  TRANSLUCENCY_CVAR, STIPPLE_ALPHA_CVAR, translucencyModeFromCvars,
  createSpan,
  runSubdiv16, runSubdivTurbulent, runSpanFlat,
  runSubdivTranslucent, runSubdivTranslucentWarp, runSubdivStipple33, runSubdivStipple66,
  drawSpansFlatPerSpan,
  sampleLightBlock, textureMasks,
  drawSpansSoftware, drawSpansTurbulent, drawSpansFlat, drawSpansTranslucent,
  drawSpans16, SoftwareBackend,
  buildTurbTable, spanListView,
  rgbMipLevel, rgbPickMipLevel, rgbSampleTexture, rgbSampleLightmap,
  rgbModulate, expandPaletteRGB, buildRGBMaterial,
  runSubdivRGBRepeat, runSubdivRGBClamp,
  drawSpansRGB, RGBWorldBackend,
  type Span, type SpanList, type Texture, type LightBlock, type RasterBackend,
  type RGBAddressMode, type RGBBlend, type RGBMipLevel, type RGBLightmap, type RGBMaterial,
} from './spans.js';

export {
  WasmSpanBackend, wasmRequestedByCvar, buildSpanModuleBytes, wasmMemoryLayout,
  SW_WASM_CVAR, MAX_WASM_SPANS,
  type DrawOpaqueFn, type WasmMemoryLayout,
} from './wasmSpans.js';

export {
  SW_WORKERS_CVAR, SW_ACCUM_CVAR, MAX_WORKERS, MAX_BAND_SPANS, MIN_BAND_PIXELS,
  TEX_CAP, LIGHT_CAP,
  F_PER_SPAN, I_PER_SPAN,
  CTL_SEQ, CTL_COUNT, CTL_TEXW, CTL_TEXH, CTL_LIGHTW, CTL_LIGHTH,
  CTL_WSHIFT, CTL_WMASK, CTL_HMASK, CTL_TURBPHASE, CTL_FBW, CTL_FBH,
  CTL_DONE, CTL_PIXELS, CTL_SPANS, CTL_READY, CTL_FCOUNT, CTL_JOB, CTL_FRAME, CTL_LEN,
  JOB_RASTER, JOB_RESOLVE,
  workersRequestedByCvar, accumRequestedByCvar, sabAvailable, syncWaitAllowed,
  splitBands, bandLayout, bandTotal, attachBandShared, createBandBuffers,
  packBandSpans, packFrameSpans, readBandJob, writeBandJob,
  processBandJob, rasterizePackedRange, processFrameJob, resolveBand, bandWorkerLoop,
  MAX_FRAME_SPANS, FRAME_TEX_CAP, FRAME_LIGHT_CAP, MAX_FRAME_BATCHES, PALETTE_BYTES,
  D_SPAN_BASE, D_SPAN_COUNT, D_TEX_OFF, D_TEX_W, D_TEX_H,
  D_LIGHT_OFF, D_LIGHT_W, D_LIGHT_H, D_WSHIFT, D_WMASK, D_HMASK,
  D_TURBPHASE, D_PER_BATCH,
  frameAccumLayout, frameAccumTotal, attachFrameAccum,
  BandedSoftwareBackend,
  type Band, type BandLayout, type BandViews, type BandJob, type BandPort,
  type BandDispatcher, type FrameAccumLayout, type FrameAccumViews,
} from './bands.js';

export { BandWorkerPool, type PoolOptions } from './bandPool.js';

export {
  COLORMAP_GRADES, COLORMAP_SIZE,
  ALPHAMAP_HEAD, ALPHAMAP_SIZE, COLORMAP_PCX_PIXELS,
  buildColormap, buildAlphamapPair, defaultPalette,
  extractAlphamap33, extractAlphamap66,
} from './colormap.js';

export {
  SURFACE_CACHE_BUDGET,
  SurfaceCache, surfaceCacheKey, hashLightStyles,
  RGBLightCache, rgbCacheKey,
  type SurfaceBlock, type RGBCachedBlock,
} from './surfaceCache.js';

export {
  buildLightMap, buildRGBLightMap, combineStyleScales, bboxDistance, luxelWorldPositions,
  LIGHT_STYLE_UNUSED, LIGHT_OVERBRIGHT, DEFAULT_DLIGHT_TTL_FRAMES,
  DLightState,
  type DynamicLight, type SurfaceBounds,
} from './light.js';

export { setupCamera, setupCameraInto, buildFrustum, boxOnFrustumSide, culledByFrustum, culledByFlatFrustum, type Camera } from './camera.js';

export {
  createEdgeScratch, projectClippedPoly,
  emitSpansForPoly, sortRowSpans,
  type EdgeScratch, type EmitFlat, type PolyInput, type ProjectedVert, type RowSpan,
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
  createBoxMesh, createGunMesh, createGunSkin,
  createSoldierMesh, createSoldierSkin,
  isMd2Data, md2ToAliasMesh,
  MD2_CONVERT_MAX_TRIS, MD2_CONVERT_MAX_VERTS, MD2_CONVERT_MAX_FRAMES,
  drawAliasInstance, fillAffineTri, DEPTHHACK_SCALE,
  clampBacklerp, aliasAlphaKeeps,
  type AliasMesh, type AliasInstance, type AliasSkin, type Md2Like,
} from './alias.js';

export { drawSprite, type SpriteDef, type Scissor } from './sprites.js';

export {
  drawTracerBeam,
  TRACER_DEFAULT_LENGTH, TRACER_DEFAULT_COLOR, TRACER_CORE_COLOR, TRACER_MAX_STEPS, TRACER_POOL_SIZE,
} from './tracer.js';

export { drawParticles, projectParticles, type ScreenParticle } from './particles.js';

export { createDevroom, createDevSkins, getDevMesh, DEVROOM_CAMERA } from './devroom.js';

export {
  bspToMiniWorld,
  bspModelBounds,
  SURF_SKY, SURF_WARP, SURF_TRANS33, SURF_TRANS66, SURF_NODRAW,
  translucencyOfFlags,
  type BspTexelSource, type BspWorldOptions,
} from './bspWorld.js';

export {
  SoftwareRenderer, sortBatchByRow, nextPot, MAX_SPANS,
  setRGBWorldEnabled, isRGBWorldEnabled,
} from './frame.js';
export {
  createFramePhases, phaseNow,
  type FramePhases,
} from './frame.js';

export {
  SKY_TILE_SUFFIXES, SKY_SIDE_IMAGE, SKY_BOX_HALF, SKY_BOX_CORNERS,
  skyFaceForDir, skyUvForDir, skyUvOnFace, computeSkyUvs, isValidSkySize,
} from './sky.js';

export {
  createOverdrawDetail, countWrittenZb, formatOverdrawLine,
  type OverdrawDetail,
} from './overdraw.js';
