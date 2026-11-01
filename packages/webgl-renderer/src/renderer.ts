// @q2/webgl-renderer renderer — WebGL2 scene drawing + Voodoo appearance (GPU-PROOF-4).
//
// Owns: the injected GL context handle, the linear SCENE render target
// (RGBA16F when EXT_color_buffer_float renders it, else an RGBA8 fallback
// with a recorded warning — a capability branch, tested both ways via stub),
// per-generation static uploads (full world inventory, diffuse/lightmap textures
// with CPU-built mip chains, model index/uv caches) and per-frame dynamic
// buffers (alias interpolation, billboards, particles).
//
// Passes per frame (transparent ordering from the submitted selection, far->near):
//   scene target: sky (textured view-centered box when a strip is
//   registered, else the flat fill; no depth write in either case) ->
//   opaque world (lit, warped when turbulent) -> opaque alias + opaque
//   sprites (entity order) -> gun pass (depth-hack MVP) -> POINTS particles
//   (depth write) -> blend (SRC_ALPHA / ONE_MINUS, depth test on, depth
//   write OFF): transparent world (glass + turbulent+translucent water,
//   warped) + translucent alias + transparent sprites + beams interleaved
//   far->near in ONE scene-order pass (the selection carries the combined
//   world/entity order; beams ALWAYS ride the blend pass, even at default
//   alpha 1 — the blend with alpha 1 is color-preserving);
//   appearance: ONE fullscreen pass to the canvas (VS_POST/FS_APPEARANCE):
//   dither -> RGB565 quantize -> reconstruction taps -> display gamma.
//   Output stays resident on GPU through presentation; the normal path
//   never reads back (no readPixels anywhere in src/).
//
// Storage vs selection (GPU-FOLLOW-2): the full world inventory (every
// triangulable surface, no camera culling) uploads ONCE per static
// generation into one shared buffer set; per-frame drawing walks the
// submitted GpuSceneInput selection (fresh world PVS/frustum/backface
// selection + combined transparent order from refreshGpuScene) and draws
// only its ranges — no mesh rebuild, no re-upload on camera moves. Brush
// movers (doors/trains/explosives) mutate MiniWorld verts in place via the
// play-layer DoorSync; the position attribute re-syncs for visibly-changed
// surfaces only (one whole-buffer bufferData on door-move frames, zero in
// steady state). Known dynamic-world limits (not silent): lightmaps stay
// baked in surface space (correct under translation/rotation), but PVS
// membership is the boot-time graft union (a conservative superset) and
// blown func_explosive faces drop via the leaf-list strip.
//   appearance: ONE fullscreen pass to the canvas (VS_POST/FS_APPEARANCE):
//   dither -> RGB565 quantize -> reconstruction taps -> display gamma.
//   Output stays resident on GPU through presentation; the normal path
//   never reads back (no readPixels anywhere in src/).
//
// Documented PROOF-4 appearance policy (PROOF-4.md: full vd_* table + gaps):
//   - scene shaders sample with the single-TMU mip rule (fwidth rho +
//   vd_lodbias + 0.375 dither mean, Bayer n/n+1 pick, textureLod into
//   box-filtered clamp-addressed chains built at upload); lightmaps stay
//   plain LINEAR (documented gap);
//   - dynamic lights per-pixel in world + alias shaders (CPU bakes
//   per-luxel; tolerances cover the difference);
//   - gun depth: NDC z remap (scale 0.02, bias -0.9), the GPU interpretation
//   of RF_DEPTHHACK 1/z x3 (wins except nose-to-wall);
//   - beams are ~1.5px camera-facing quads (CPU: 1px DDA core+glow), always
//     in the blend pass with distance order (even at default alpha);
//   - no GL face culling (visibility = selectGpuScene's CPU backface rule:
//     single-sided for opaque + glass, double-sided for sky + turbulent);
//   - turbulent water warps per pixel (closed-form CPU-turbTable mirror,
//     phase from the frame time; opaque + translucent water warp identically);
//   - sky is a textured view-centered box (single-face quads, own tiles,
//     fullbright mip-0) when a strip is registered, else the flat fill;
//   - translucency is true blending (documented screen-door deviation);
//   - HUD is composited above by the apps/web overlay (already above GL);
//   - vd_palettetex: always expanded-RGB uploads (no paletted textures in
//   WebGL; filtering identical either way); vd_zbits selects the target
//   depth format at creation (pre-test depth, unlike the CPU post-hoc
//   banding helper);
//   - small per-frame CPU garbage is accepted (lerp/scratch arrays for the
//   handful of dynamic entities; static geometry never re-uploads).
//
// Lifecycle/status/loss/restore/dispose semantics (FOLLOW-4 pins):
// renderFrame before init throws Com_Error; loss records + skips with zero
// submissions; empty world (no attached MiniWorld/palette) still clears +
// submits so the boundary contract holds without assets. Same-context
// replacement (uploadStatic generations, resize targets, registry
// re-registration, capacity growth) deletes the obsolete GL objects via
// gl.delete* BEFORE dropping ownership — never drop-and-GC. After context
// loss every handle is invalid: loss/restore/dispose-while-lost drop without
// GL deletes (never counted); dispose with a live context deletes everything.
// Target (re)creation is NOT a texture upload: testUploadStats() counts only
// static-generation uploads (the upload contract stays pinned).
// framesSubmitted is the ONLY GPU-execution counter: a lost frame never
// submits, and the CPU software fallback (outside this backend) never
// touches it — never count fallback as GPU execution.
//
// Normal rendering never reads pixels back (no readPixels anywhere in src/).

import { Com_Error } from '@q2/config';
import type {
  Entity,
  GpuFrameInput,
  GpuLight,
  GpuRenderer,
  GpuRendererStatus,
  GpuSceneInput,
} from '@q2/renderer-api';
import { MAX_GPU_LIGHTS } from '@q2/renderer-api';
import {
  setupCamera,
  SKY_BOX_HALF,
  SKY_SIDE_IMAGE,
  isValidSkySize,
  type Camera,
  type MiniWorld,
} from '@q2/sw-renderer';
import {
  compileProgram,
  FS_ALIAS,
  FS_FLAT,
  FS_LIT,
  VS_ALIAS,
  VS_FLAT,
  VS_LIT,
} from './shaders.js';
import {
  buildFogLUT01,
  buildMipChainRGB,
  ditherModeToInt,
  downsampleToCap,
  FOG_DENSITY,
  FS_APPEARANCE,
  reconModeToInt,
  resolveAppearanceFrame,
  VS_POST,
  type AppearanceFrame,
} from './appearance.js';
import {
  buildEntityModel,
  buildProjectionMatrix,
  buildViewMatrix,
  GPU_FAR,
  GPU_NEAR,
  multiplyMat4,
} from './matrices.js';
import {
  buildFullWorldStore,
  expandPaletteTexture,
  packLightAtlas,
  pickSkyPaletteIndex,
  styleSignature,
  type LightAtlas,
} from './worldMesh.js';
import {
  aliasShadeBase,
  gpuMeshFromMd2,
  interpolateAliasFrame,
  resolveAliasLerp,
  type AliasMesh,
} from './alias.js';
import {
  collectParticlePoints,
  emitBeamQuad,
  emitSkyBoxFace,
  emitSpriteQuad,
  emptyFlatBatch,
  resolveBeam,
  type FlatBatch,
} from './entities.js';
import type { GpuEntityModelKind } from './scene.js';

/** Observability for the persistent-upload contract (test hook). */
export interface WebGLUploadStats {
  uploads: number;
}

/** Gun NDC depth remap (GPU interpretation of RF_DEPTHHACK 1/z x3). */
export const GUN_DEPTH_SCALE = 0.02;
/** Gun NDC depth bias (centers the remapped gun near the near plane). */
export const GUN_DEPTH_BIAS = -0.9;

const CLEAR_R = 0;
const CLEAR_G = 0;
const CLEAR_B = 0;
const CLEAR_A = 1;

interface SkinData {
  texels: Uint8Array;
  width: number;
  height: number;
}

interface ModelData {
  kind: GpuEntityModelKind;
  mesh: AliasMesh | null;
}

interface ModelGL {
  uvBuf: WebGLBuffer;
  idxBuf: WebGLBuffer;
  count: number;
  nv: number;
}

interface ProgLocs {
  prog: WebGLProgram;
  uMVP: WebGLUniformLocation | null;
  uDepthScale: WebGLUniformLocation | null;
  uDepthBias: WebGLUniformLocation | null;
  uDiffuse: WebGLUniformLocation | null;
  uLightmap: WebGLUniformLocation | null;
  uMap: WebGLUniformLocation | null;
  uTextured: WebGLUniformLocation | null;
  uPointSize: WebGLUniformLocation | null;
  uLightPos: WebGLUniformLocation | null;
  uLightColor: WebGLUniformLocation | null;
  uNumLights: WebGLUniformLocation | null;
  uAlpha: WebGLUniformLocation | null;
  uUVScale: WebGLUniformLocation | null;
  // PROOF-4 live-policy uniforms (all set per frame/use; null when the stub
  // or a program lacks them — setVoodooPolicy guards every one).
  uLodBias: WebGLUniformLocation | null;
  uMipDither: WebGLUniformLocation | null;
  uMaxLevel: WebGLUniformLocation | null;
  uOverbright: WebGLUniformLocation | null;
  uFogEnabled: WebGLUniformLocation | null;
  uFogAmount: WebGLUniformLocation | null;
  uFogColor: WebGLUniformLocation | null;
  uFogTable: WebGLUniformLocation | null;
  // FOLLOW-2B test-only diagnostic view (debug-gated; production stays 0).
  uDebugMode: WebGLUniformLocation | null;
  // FOLLOW-3 turbulent warp (FS_LIT only; null on other programs, guarded).
  uWarpOn: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
}

/** Appearance-pass program locations (fullscreen resolve to the canvas). */
interface PostLocs {
  prog: WebGLProgram;
  uScene: WebGLUniformLocation | null;
  uDitherOn: WebGLUniformLocation | null;
  uDitherMode: WebGLUniformLocation | null;
  uPostfilter: WebGLUniformLocation | null;
  uReconMode: WebGLUniformLocation | null;
  uRgbMaxDelta: WebGLUniformLocation | null;
  uGamma: WebGLUniformLocation | null;
  u16bit: WebGLUniformLocation | null;
  uWarpOn: WebGLUniformLocation | null;
  uWarpTime: WebGLUniformLocation | null;
}

/** Linear scene render target (float when renderable, else RGBA8 fallback). */
interface SceneTarget {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  depth: WebGLRenderbuffer;
  w: number;
  h: number;
  /** True when EXT_color_buffer_float rendered the RGBA16F target. */
  float: boolean;
}

export class WebGLRenderer implements GpuRenderer<WebGL2RenderingContext> {
  private gl: WebGL2RenderingContext | null = null;
  private width = 0;
  private height = 0;
  private ready = false;
  private lost = false;
  private submitted = 0;
  private error: string | null = null;
  private scene: GpuSceneInput | null = null;
  private uploadedGeneration: number | null = null;
  private uploadCount = 0;

  // --- PROOF-3 asset inputs (concrete methods; the GpuRenderer boundary is untouched) ---
  private world: MiniWorld | null = null;
  private palette: Uint8Array | null = null;
  private models = new Map<number, ModelData>();
  private skins = new Map<number, SkinData>();
  private entities: Entity[] = [];
  private entityKinds: ReadonlyMap<number, GpuEntityModelKind> | undefined;
  private warnings: string[] = [];

  // --- GL objects (cleared on init/restore/dispose: contexts die) ---
  private progs: { lit: ProgLocs; alias: ProgLocs; flat: ProgLocs } | null = null;
  private postProg: PostLocs | null = null;
  private target: SceneTarget | null = null;
  private floatCap: boolean | null = null;
  private targetFallbackWarned = false;
  private fboUnsupportedWarned = false;
  private apFrame: AppearanceFrame | null = null;
  private fogLUT: Float32Array | null = null;
  /** Forced-fog test hook (production: null => scene contribution 0, base1 rule). */
  private fogOverride: { amount: number; color: [number, number, number] } | null = null;
  /**
   * FOLLOW-2B test-only diagnostic view (debug-gated, never set in
   * production): 0 = final (shipped), 1 = unlit diffuse/skin, 2 = lightmap
   * (world) / shade base (alias). Uploaded per draw by drawWorldRange /
   * drawAlias / setVoodooPolicy; the shaders early-out before lighting/fog.
   */
  private debugView: 0 | 1 | 2 = 0;
  /** Atlas accounting for the current generation (FOLLOW-2B report hook). */
  private atlasStats: { width: number; height: number; rects: number; skipped: number; shortFallback: number } | null = null;
  /** Uploaded chain depth per texture (for the uMaxLevel LOD clamp). */
  private texLevels = new Map<WebGLTexture, number>();
  /** Test-only count of setVoodooPolicy uploads by mipDither value (FOLLOW-2B
   * dither-liveness attribution: proves the toggled cvar reached GL uploads
   * in-browser, distinguishing a CPU/store break from shader invariance). */
  private policyUploads = { on: 0, off: 0 };
  private staticDirty = true;
  // FOLLOW-2 persistent world store: one shared buffer set for the FULL
  // inventory (uploaded once per generation) + per-surface ranges. Draw
  // selection walks the submitted scene and draws only its ranges.
  private worldPosBuf: WebGLBuffer | null = null;
  private worldUVBuf: WebGLBuffer | null = null;
  private worldLUVBuf: WebGLBuffer | null = null;
  private worldAlphaBuf: WebGLBuffer | null = null;
  private worldIdxBuf: WebGLBuffer | null = null;
  private worldRanges = new Map<number, { start: number; count: number; texId: number; transparent: boolean; warped: boolean }>();
  private vertBase = new Map<number, { vStart: number; vCount: number }>();
  /** CPU shadow of the uploaded positions (mover re-sync compare). */
  private worldPositions: Float32Array | null = null;
  /**
   * Animated-texture faces (RELEASE-16 button art): surface ids whose
   * MiniSurf carries a multi-frame animTexIds chain. The play-layer DoorSync
   * writes the picked frame into surf.texId per tick; syncDynamicTexIds
   * mirrors the live texId into worldRanges before draws (no GL re-upload —
   * diffuse binds per range at draw). Rebuilt at uploadStatic.
   */
  private animFaceIds: number[] = [];
  private skyPosBuf: WebGLBuffer | null = null;
  private skyColBuf: WebGLBuffer | null = null;
  private skyIdxBuf: WebGLBuffer | null = null;
  private skyRanges = new Map<number, { start: number; count: number }>();
  /**
   * Packed sky strip (GPU-FOLLOW-3): vertical 6-tile strip in
   * SKY_TILE_SUFFIXES order (rt/bk/lf/ft/up/dn), registered by the play
   * layer from env/<skyname>*.pcx (base1: env/unit1_*.pcx). Null = flat
   * fallback fill (the CPU no-skyTex path). Upload is lazy (first sky
   * draw) and per-face single-level (CPU mip-0 rule for skybox faces):
   * each of the 6 tiles uploads to its OWN face texture with CLAMP, so
   * bilinear taps at face borders can never blend a neighbour face (the
   * old single-strip texture with whole-strip CLAMP bled across internal
   * tile borders). UVs are face-local (see entities.emitSkyBoxFace).
   */
  private skyStrip: { pixels: Uint8Array; tileW: number; tileH: number } | null = null;
  /** Per-face sky textures, indexed by TILE 0..5 in SKY_TILE_SUFFIXES
   * (strip) order (lazy; null = not yet uploaded). Box face f binds tile
   * SKY_SIDE_IMAGE[f] (id r_skysideimage), never tile f. */
  private skyFaceTex: Array<WebGLTexture | null> = [null, null, null, null, null, null];
  /** Last sky-pass mode (test hook: proves the window-background repair). */
  private lastSky: { mode: 'textured-box' | 'flat-hull' | 'none'; refs: number } | null = null;
  private atlasTex: WebGLTexture | null = null;
  private atlas: LightAtlas | null = null;
  private styleSig = 0;
  private diffuseTex = new Map<number, WebGLTexture | null>();
  private skinTex = new Map<number, { tex: WebGLTexture; w: number; h: number } | null>();
  private whiteTex: WebGLTexture | null = null;
  private onesBuf: WebGLBuffer | null = null;
  private modelGL = new Map<number, ModelGL>();
  private dynPos: WebGLBuffer | null = null;
  private dynShade: WebGLBuffer | null = null;
  private dynSize = 0;
  private flatPos: WebGLBuffer | null = null;
  private flatCol: WebGLBuffer | null = null;
  private flatUV: WebGLBuffer | null = null;
  private flatIdx: WebGLBuffer | null = null;
  private flatSize = 0;
  private flatIdxSize = 0;
  private pointPos: WebGLBuffer | null = null;
  private pointCol: WebGLBuffer | null = null;
  private pointCount = 0;

  // --- FOLLOW-4 explicit GL ownership (same-context deletes, never GC) ---
  // Every buffer/texture/FBO/renderbuffer/program the renderer creates is
  // tracked here so replacement (uploadStatic/resize/map switch) deletes the
  // obsolete same-context object via gl.delete* BEFORE dropping the handle.
  // After context loss every handle is invalid: loss paths drop the sets
  // WITHOUT issuing GL deletes (checked via `lost`). All delete* calls are
  // typeof-guarded so minimal stubs without them stay green.
  private ownedTex = new Set<WebGLTexture>();
  private ownedBuf = new Set<WebGLBuffer>();
  private ownedFbo = new Set<WebGLFramebuffer>();
  private ownedRb = new Set<WebGLRenderbuffer>();
  private ownedProg = new Set<WebGLProgram>();
  private deleteCounts = { textures: 0, buffers: 0, framebuffers: 0, renderbuffers: 0, programs: 0 };

  init(gl: WebGL2RenderingContext, width: number, height: number): void {
    this.gl = gl;
    this.width = width;
    this.height = height;
    gl.viewport(0, 0, width, height);
    gl.clearColor(CLEAR_R, CLEAR_G, CLEAR_B, CLEAR_A);
    this.ready = true;
    this.lost = false;
    this.error = null;
    // Fresh context boundary: previous handles belong to the OLD context and
    // are invalid here, so drop them WITHOUT GL deletes (never delete one
    // context's objects through another context's handle).
    this.scene = null;
    this.uploadedGeneration = null;
    this.dropGLCaches();
  }

  resize(width: number, height: number): void {
    // Invalid sizes are ignored WITHOUT mutating state: dims, viewport and
    // the live target stay coherent (warn + early return, never throw, never
    // half-mutate). Precedent is the registry guards (registerSkyStrip /
    // registerSkinPixels warn-and-ignore); the play layer validates first,
    // so this is a renderer-side backstop for direct callers. Same-size is
    // a no-op (no viewport, no target drop, no GL traffic).
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      this.warn(`resize: invalid ${String(width)}x${String(height)} (ignored, kept ${this.width}x${this.height})`);
      return;
    }
    if (width === this.width && height === this.height) return; // no-op
    this.width = width;
    this.height = height;
    // Viewport + drawing-buffer size stay synchronized here; camera aspect
    // (setupCamera/buildProjectionMatrix) and the size-matched scene target
    // re-derive from width/height on the next renderFrame. HUD overlay layout
    // is owned by apps/web (outside this package): it reads the same size
    // via getStatus(); see the FOLLOW-4 report for the wiring note.
    if (this.gl !== null && !this.lost) this.gl.viewport(0, 0, width, height);
    // Size-matched target: delete the obsolete same-context FBO set BEFORE
    // dropping it; the next renderFrame re-creates it at the new size. When
    // lost (handles invalid) or contextless, just drop without GL calls.
    if (this.target !== null) {
      const gl = this.gl;
      if (gl !== null && !this.lost) this.freeTargetObjects(gl, this.target);
      else this.untrackTarget(this.target);
      this.target = null;
    }
  }

  setScene(scene: GpuSceneInput): void {
    this.scene = scene;
    // Persistent upload: re-upload if and only if the static generation
    // changed. Per-frame camera re-selections keep the generation stable, so
    // turning/translating never re-uploads — the draw pass follows the new
    // selection from the already-resident full inventory (FOLLOW-2).
    if (this.uploadedGeneration !== scene.staticGeneration) {
      this.uploadedGeneration = scene.staticGeneration;
      this.uploadCount++;
      this.staticDirty = true;
    }
  }

  /** Attach the world whose surfaces setScene references (test/glue-owned). */
  attachWorld(world: MiniWorld | null): void {
    this.world = world;
    this.staticDirty = true;
  }

  /** Copy the palette (Refresh.setPalette spirit) for texture expansion. */
  setPalette(p: Uint8Array): void {
    this.palette = p.slice();
    this.staticDirty = true;
  }

  /**
   * Register model data for an entity model handle (kind + parsed MD2).
   *
   * Idempotent replay (FOLLOW-2A hot-swap/cold-boot mirror): re-registering
   * the same handle overwrites the stored kind/mesh and drops the GL cache
   * entry so the next draw rebuilds exactly one entry — never a duplicate.
   * Missing/invalid md2 data records an explicit handle/kind-context warning
   * (draws skip that entity, never crash, never silent). sp2/tracer handles
   * carry no mesh by design, so null data for those kinds is expected and
   * stays warning-free.
   */
  registerModelData(handle: number, kind: GpuEntityModelKind, data: unknown): void {
    if (!Number.isInteger(handle) || handle < 0) {
      this.warn(`registerModelData: invalid handle ${String(handle)} kind ${String(kind)} (ignored)`);
      return;
    }
    if (kind !== 'md2' && kind !== 'sp2' && kind !== 'tracer') {
      this.warn(`registerModelData: unknown kind ${String(kind)} for handle ${handle} (ignored)`);
      return;
    }
    let mesh: AliasMesh | null = null;
    if (kind === 'md2') {
      try {
        mesh = gpuMeshFromMd2(data);
      } catch (err) {
        mesh = null;
        this.warn(`registerModelData: md2 convert threw for handle ${handle} (${err instanceof Error ? err.message : String(err)})`);
      }
      if (!mesh) {
        const detail = data === null || data === undefined
          ? 'null/undefined data'
          : `typeof ${typeof data}`;
        this.warn(`registerModelData: model ${handle} kind md2 has no mesh (${detail}, entity draws skip)`);
      }
    }
    this.models.set(handle, { kind, mesh });
    // FOLLOW-4: delete the obsolete same-context uv/index buffers BEFORE
    // dropping the cache entry (never rely on GC). After loss the handles
    // are invalid, so just drop.
    this.freeModelGL(handle);
  }

  /**
   * Register the packed sky strip sampled by SURF_SKY surfaces (GPU-FOLLOW-3,
   * CPU setSkyTexture parity): ONE vertical strip of 6 tiles in filename
   * suffix order [rt, bk, lf, ft, up, dn] (SKY_TILE_SUFFIXES), tileW = strip
   * width (must be a power of two: the affine CPU sampler indexes with
   * u & (tileW-1)), strip height = 6 * tileH. Texels are PALETTE INDICES
   * (like setSkyTexture); expansion uses the current palette at upload.
   * Returns true on success; invalid sizes warn + keep the previous strip
   * (flat fill when none). Idempotent replay: re-registering drops the
   * uploaded GL copy so the next sky draw re-uploads exactly once.
   */
  registerSkyStrip(texels: Uint8Array, tileW: number, tileH: number): boolean {
    if (!Number.isInteger(tileW) || !Number.isInteger(tileH) ||
      !isValidSkySize(tileW, tileH * 6) ||
      texels.length !== tileW * tileH * 6) {
      this.warn(`registerSkyStrip: invalid ${tileW}x${tileH} strip (flat sky fallback)`);
      return false;
    }
    this.skyStrip = { pixels: texels.slice(), tileW, tileH };
    // FOLLOW-4: delete obsolete same-context face textures before dropping
    // them; the next sky draw re-uploads each face exactly once.
    for (let f = 0; f < 6; f++) {
      this.freeTexture(this.skyFaceTex[f]);
      this.skyFaceTex[f] = null;
    }
    return true;
  }

  /** Registered sky strip dims (test hook; null when no strip registered). */
  testSkyStrip(): { tileW: number; tileH: number } | null {
    return this.skyStrip ? { tileW: this.skyStrip.tileW, tileH: this.skyStrip.tileH } : null;
  }

  /** Per-face upload state (test hook: 6 entries, true = GL texture live). */
  testSkyFaces(): boolean[] {
    return this.skyFaceTex.map((t) => t !== null);
  }

  /** Last sky-pass mode (test hook; null before the first scene draw). */
  testLastSky(): { mode: 'textured-box' | 'flat-hull' | 'none'; refs: number } | null {
    return this.lastSky ? { ...this.lastSky } : null;
  }

  /**
   * Drop the registered sky strip (GPU-FOLLOW-3A map-change path): the next
   * sky draw falls back to the flat fill. Deletes the obsolete same-context
   * strip texture before dropping it (never rely on GC); after loss the
   * handle is invalid so it is just dropped. Explicit clears are silent —
   * missing/invalid art diagnostics belong to the play layer, not to this
   * intentional fallback.
   */
  clearSkyStrip(): void {
    for (let f = 0; f < 6; f++) {
      this.freeTexture(this.skyFaceTex[f]);
      this.skyFaceTex[f] = null;
    }
    this.skyStrip = null;
    this.lastSky = null;
  }

  /** Register skin texels (palette indices) for an entity skin handle. */
  registerSkinPixels(handle: number, pixels: Uint8Array, width: number, height: number): number {    if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > 1024 || height > 1024 ||
      pixels.length !== width * height) {
      this.warn(`registerSkinPixels: invalid ${width}x${height} for handle ${handle} (white fallback)`);
      this.skins.delete(handle);
      // FOLLOW-4: an invalid re-registration must not leak a live texture.
      this.freeSkinTex(handle);
      return handle;
    }
    this.skins.set(handle, { texels: pixels.slice(), width, height });
    // FOLLOW-4: delete the obsolete same-context texture before dropping the
    // cache entry; the next draw re-uploads exactly once.
    this.freeSkinTex(handle);
    return handle;
  }

  /** Per-frame entity list (stored by reference; no alloc, no copy). */
  setEntities(entities: Entity[], modelKinds?: ReadonlyMap<number, GpuEntityModelKind>): void {
    this.entities = entities;
    this.entityKinds = modelKinds;
  }

  renderFrame(input: GpuFrameInput): void {
    if (!this.ready || this.gl === null) {
      this.fail('WebGLRenderer.renderFrame: not initialized (init first)');
    }
    if (this.lost) {
      this.error = 'WebGLRenderer.renderFrame: context lost (no submit)';
      return;
    }
    const gl = this.gl as WebGL2RenderingContext;
    // Static path needs world + palette + scene; without them this is the
    // PROOF-2 clear-only submit (lifecycle contract holds without assets,
    // and only viewport/clear/clearColor run — minimal-stub safe).
    if (this.world && this.palette && (this.scene ?? input.scene)) {
      this.ensurePrograms(gl);
      this.noteGlErrorAt(gl, 'ensurePrograms');
      if (this.staticDirty) this.uploadStatic(gl, input);
      this.noteGlErrorAt(gl, 'uploadStatic');
      // Light-style flicker re-bakes the atlas texels only (no re-upload).
      const sig = styleSignature(input.view.lightStyles);
      if (!this.staticDirty && this.atlasTex && this.atlas && sig !== this.styleSig && this.world) {
        this.rebakeAtlas(gl, this.world, input.view.lightStyles, sig);
      }
      if (!this.staticDirty) {
        this.drawScene(gl, input);
        this.submitted++;
        this.error = null;
        return;
      }
      this.warn('renderFrame: static upload deferred (see earlier warnings)');
    }
    gl.viewport(0, 0, this.width, this.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.submitted++;
    this.error = null;
  }

  dispose(): void {
    // Idempotent: releasing twice is safe and never throws. When the context
    // is live (same-context, not lost) delete every owned GL object BEFORE
    // dropping the handles; after loss (or with no context) the handles are
    // invalid/gone, so just drop. All delete* calls are typeof-guarded.
    const gl = this.gl;
    if (gl !== null && !this.lost) this.freeAllGL();
    else this.dropGLCaches();
    this.gl = null;
    this.ready = false;
    this.scene = null;
  }

  getStatus(): GpuRendererStatus {
    return {
      initialized: this.ready,
      width: this.width,
      height: this.height,
      contextLost: this.lost,
      framesSubmitted: this.submitted,
      lastError: this.error,
    };
  }

  handleContextLost(): void {
    // Stop submission safely: renderFrame checks `lost` and submits nothing
    // (framesSubmitted frozen, lastError records the loss). Every GL handle
    // is invalid from here until restoration, so drop the caches WITHOUT GL
    // deletes — deleting invalid handles would misattribute driver errors.
    // Retained assets (world/palette/models/skins/entities/scene/registry)
    // are kept: restoration replays them (FOLLOW-2A), no migration rebuild.
    this.lost = true;
    this.error = 'WebGLRenderer: context lost (no submit)';
    this.dropGLCaches();
    this.staticDirty = true;
  }

  handleContextRestored(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.lost = false;
    // Re-create owned targets: re-apply viewport + clear state. Retained
    // assets replay on the next renderFrame (ensurePrograms recompiles the
    // world/model/skin/appearance programs; uploadStatic re-uploads the
    // stored world + atlas + sky; lazy diffuse/skin/model caches rebuild on
    // first draw from the retained registries — the FOLLOW-2A replay path).
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(CLEAR_R, CLEAR_G, CLEAR_B, CLEAR_A);
    this.dropGLCaches();
    this.staticDirty = true;
    this.error = null;
  }

  /** Upload bookkeeping (test hook): persistent uploads so far. */
  testUploadStats(): WebGLUploadStats {
    return { uploads: this.uploadCount };
  }

  /** Recorded non-fatal warnings (test hook): oversize, caps, fallbacks. */
  testWarnings(): string[] {
    return [...this.warnings];
  }

  /**
   * Registered model handles, sorted (FOLLOW-2A test hook): hot-swap replay
   * observability for the web/testkit lanes — proves every mirrored model
   * reached the backend under its existing handle without reboot.
   */
  testRegisteredModels(): number[] {
    return [...this.models.keys()].sort((a, b) => a - b);
  }

  /** Registered skin handles, sorted (FOLLOW-2A test hook, same contract). */
  testRegisteredSkins(): number[] {
    return [...this.skins.keys()].sort((a, b) => a - b);
  }

  /** Stored kind for one model handle (FOLLOW-2A test hook; null = unknown). */
  testModelKind(handle: number): GpuEntityModelKind | null {
    return this.models.get(handle)?.kind ?? null;
  }

  /**
   * Live per-model GL cache entries (FOLLOW-2A test hook): replay must not
   * accumulate duplicates — after any number of re-registrations + draws this
   * holds at most one entry per drawn md2 handle.
   */
  testModelCacheSize(): number {
    return this.modelGL.size;
  }

  /**
   * Forced-fog test hook (PROOF-4): overrides the scene fog contribution
   * (amount 0..1 scaled over the 64-entry table, color linear RGB).
   * Production never calls this (null => 0 contribution, the base1 rule);
   * capability gating still honors vd_fog. Pass null to clear.
   */
  setFogOverride(amount: number | null, color?: [number, number, number]): void {
    if (amount === null) {
      this.fogOverride = null;
      return;
    }
    this.fogOverride = {
      amount: amount < 0 ? 0 : amount > 1 ? 1 : amount,
      color: color ?? [0.5, 0.5, 0.5],
    };
  }

  /** Scene-target introspection (test hook): float vs RGBA8 branch + size. */
  testTargetInfo(): { float: boolean; w: number; h: number } | null {
    if (!this.target) return null;
    return { float: this.target.float, w: this.target.w, h: this.target.h };
  }

  /**
   * FOLLOW-2B test-only diagnostic view (debug-gated): 0 = final (shipped
   * default), 1 = unlit diffuse (world) / unlit skin (alias), 2 = lightmap
   * block (world) / shade base (alias). Production never calls this; the
   * triage captures (diffuse-only / lightmap-only / final at the same
   * camera) run through it explicitly.
   */
  setDebugView(mode: 0 | 1 | 2): void {
    this.debugView = mode;
  }

  /**
   * Test-only uMipDither upload counts (FOLLOW-2B dither attribution).
   */
  testPolicyUploads(): { on: number; off: number } {
    return { ...this.policyUploads };
  }

  /**
   * Atlas accounting for the current static generation (FOLLOW-2B report
   * hook): atlas dims, packed rect count, overflow-skipped count and
   * short-fallback count. Null before the first static upload.
   */
  testAtlasStats(): { width: number; height: number; rects: number; skipped: number; shortFallback: number } | null {
    return this.atlasStats ? { ...this.atlasStats } : null;
  }

  /**
   * Material/texture counts for the current generation (FOLLOW-2B report
   * hook): live diffuse textures (world WAL uploads), skin textures, atlas
   * presence and recorded warnings. Null entries are skipped handles, never
   * silent origin reads.
   */
  testMaterialStats(): { diffuseTextures: number; skinTextures: number; atlas: boolean; warnings: number } {
    let diffuse = 0;
    for (const t of this.diffuseTex.values()) if (t) diffuse++;
    let skins = 0;
    for (const t of this.skinTex.values()) if (t) skins++;
    return { diffuseTextures: diffuse, skinTextures: skins, atlas: this.atlasTex !== null, warnings: this.warnings.length };
  }

  /**
   * FOLLOW-4 test hooks: live owned GL objects (stable across repeated
   * resize/switch/map/loss cycles) and cumulative same-context deletes.
   * `framesSubmitted` (getStatus) is the ONLY GPU-execution counter: the
   * clear-only path submits on GL, a lost frame never submits, and the CPU
   * software fallback lives outside this backend and never touches it.
   */
  testLiveResources(): { textures: number; buffers: number; framebuffers: number; renderbuffers: number; programs: number } {
    return {
      textures: this.ownedTex.size,
      buffers: this.ownedBuf.size,
      framebuffers: this.ownedFbo.size,
      renderbuffers: this.ownedRb.size,
      programs: this.ownedProg.size,
    };
  }

  /** Cumulative same-context deletes (loss-drops never count: invalid handles). */
  testDeleteCounts(): { textures: number; buffers: number; framebuffers: number; renderbuffers: number; programs: number } {
    return { ...this.deleteCounts };
  }

  private warn(msg: string): void {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  private fail(message: string): never {
    this.error = message;
    Com_Error('error', message);
  }

  // --- FOLLOW-4 ownership primitives (all deletes typeof-guarded) ---

  private trackBuf(buf: WebGLBuffer): WebGLBuffer {
    this.ownedBuf.add(buf);
    return buf;
  }

  private trackTex(tex: WebGLTexture): WebGLTexture {
    this.ownedTex.add(tex);
    return tex;
  }

  private trackFbo(fbo: WebGLFramebuffer): WebGLFramebuffer {
    this.ownedFbo.add(fbo);
    return fbo;
  }

  private trackRb(rb: WebGLRenderbuffer): WebGLRenderbuffer {
    this.ownedRb.add(rb);
    return rb;
  }

  private trackProg(prog: WebGLProgram): WebGLProgram {
    this.ownedProg.add(prog);
    return prog;
  }

  /** Same-context buffer delete (no-op when lost/contextless/missing fn). */
  private freeBuffer(buf: WebGLBuffer | null): void {
    if (!buf) return;
    const tracked = this.ownedBuf.has(buf);
    if (tracked) this.ownedBuf.delete(buf);
    if (this.lost) return; // invalid handle: drop, never delete, never count
    const gl = this.gl;
    if (gl !== null && typeof gl.deleteBuffer === 'function' && tracked) {
      try {
        gl.deleteBuffer(buf);
      } catch {
        /* delete is best-effort */
      }
    }
    if (tracked) this.deleteCounts.buffers++;
  }

  /** Same-context texture delete (drops texLevels; no-op when lost). */
  private freeTexture(tex: WebGLTexture | null): void {
    if (!tex) return;
    this.texLevels.delete(tex);
    const tracked = this.ownedTex.has(tex);
    if (tracked) this.ownedTex.delete(tex);
    if (this.lost) return;
    const gl = this.gl;
    if (gl !== null && typeof gl.deleteTexture === 'function' && tracked) {
      try {
        gl.deleteTexture(tex);
      } catch {
        /* delete is best-effort */
      }
    }
    if (tracked) this.deleteCounts.textures++;
  }

  private freeProgram(prog: WebGLProgram | null): void {
    if (!prog) return;
    const tracked = this.ownedProg.has(prog);
    if (tracked) this.ownedProg.delete(prog);
    if (this.lost) return;
    const gl = this.gl;
    if (gl !== null && typeof gl.deleteProgram === 'function' && tracked) {
      try {
        gl.deleteProgram(prog);
      } catch {
        /* delete is best-effort */
      }
    }
    if (tracked) this.deleteCounts.programs++;
  }

  /** Delete one target's FBO set (same-context only; loss path untracks). */
  private freeTargetObjects(gl: WebGL2RenderingContext, target: SceneTarget): void {
    if (this.ownedFbo.has(target.fbo)) {
      this.ownedFbo.delete(target.fbo);
      if (typeof gl.deleteFramebuffer === 'function') {
        try {
          gl.deleteFramebuffer(target.fbo);
        } catch {
          /* best-effort */
        }
      }
      this.deleteCounts.framebuffers++;
    }
    if (this.ownedTex.has(target.tex)) {
      this.ownedTex.delete(target.tex);
      if (typeof gl.deleteTexture === 'function') {
        try {
          gl.deleteTexture(target.tex);
        } catch {
          /* best-effort */
        }
      }
      this.deleteCounts.textures++;
    }
    if (this.ownedRb.has(target.depth)) {
      this.ownedRb.delete(target.depth);
      if (typeof gl.deleteRenderbuffer === 'function') {
        try {
          gl.deleteRenderbuffer(target.depth);
        } catch {
          /* best-effort */
        }
      }
      this.deleteCounts.renderbuffers++;
    }
  }

  /** Loss/context-boundary untrack (handles invalid: no GL, no counts). */
  private untrackTarget(target: SceneTarget): void {
    this.ownedFbo.delete(target.fbo);
    this.ownedTex.delete(target.tex);
    this.ownedRb.delete(target.depth);
  }

  /** Delete one model cache entry's buffers (same-context; loss just drops). */
  private freeModelGL(handle: number): void {
    const entry = this.modelGL.get(handle);
    if (!entry) return;
    this.freeBuffer(entry.uvBuf);
    this.freeBuffer(entry.idxBuf);
    this.modelGL.delete(handle);
  }

  /** Delete one skin cache entry's texture (same-context; loss just drops). */
  private freeSkinTex(handle: number): void {
    const entry = this.skinTex.get(handle);
    if (entry === undefined) return;
    if (entry) this.freeTexture(entry.tex);
    this.skinTex.delete(handle);
  }

  /**
   * Drop every GL cache WITHOUT deletes: context boundary (init), context
   * loss (handles invalid) and restoration (already empty). Retained assets
   * (world/palette/models/skins/entities/scene/registry + uploadCount) stay.
   */
  private dropGLCaches(): void {
    this.progs = null;
    this.postProg = null;
    this.target = null;
    this.floatCap = null;
    this.texLevels = new Map();
    this.apFrame = null;
    this.fogLUT = null;
    this.staticDirty = true;
    this.worldPosBuf = null;
    this.worldUVBuf = null;
    this.worldLUVBuf = null;
    this.worldAlphaBuf = null;
    this.worldIdxBuf = null;
    this.worldRanges = new Map();
    this.vertBase = new Map();
    this.worldPositions = null;
    this.animFaceIds = [];
    this.skyPosBuf = null;
    this.skyColBuf = null;
    this.skyIdxBuf = null;
    this.skyRanges = new Map();
    this.skyFaceTex = [null, null, null, null, null, null];
    this.lastSky = null;
    this.atlasTex = null;
    this.atlas = null;
    this.diffuseTex = new Map();
    this.skinTex = new Map();
    this.whiteTex = null;
    this.onesBuf = null;
    this.modelGL = new Map();
    this.dynPos = null;
    this.dynShade = null;
    this.dynSize = 0;
    this.flatPos = null;
    this.flatCol = null;
    this.flatUV = null;
    this.flatIdx = null;
    this.flatSize = 0;
    this.flatIdxSize = 0;
    this.pointPos = null;
    this.pointCol = null;
    this.pointCount = 0;
    this.ownedTex = new Set();
    this.ownedBuf = new Set();
    this.ownedFbo = new Set();
    this.ownedRb = new Set();
    this.ownedProg = new Set();
  }

  /**
   * Delete every owned GL object via the live same-context handle (dispose
   * path only: caller guarantees gl !== null && !lost), then drop caches.
   */
  private freeAllGL(): void {
    for (const tex of [...this.diffuseTex.values()]) if (tex) this.freeTexture(tex);
    for (const entry of [...this.skinTex.values()]) if (entry) this.freeTexture(entry.tex);
    for (const handle of [...this.modelGL.keys()]) this.freeModelGL(handle);
    this.freeTexture(this.whiteTex);
    this.freeTexture(this.atlasTex);
    for (let f = 0; f < 6; f++) this.freeTexture(this.skyFaceTex[f]);
    this.freeBuffer(this.worldPosBuf);
    this.freeBuffer(this.worldUVBuf);
    this.freeBuffer(this.worldLUVBuf);
    this.freeBuffer(this.worldAlphaBuf);
    this.freeBuffer(this.worldIdxBuf);
    this.freeBuffer(this.skyPosBuf);
    this.freeBuffer(this.skyColBuf);
    this.freeBuffer(this.skyIdxBuf);
    this.freeBuffer(this.onesBuf);
    this.freeBuffer(this.dynPos);
    this.freeBuffer(this.dynShade);
    this.freeBuffer(this.flatPos);
    this.freeBuffer(this.flatCol);
    this.freeBuffer(this.flatUV);
    this.freeBuffer(this.flatIdx);
    this.freeBuffer(this.pointPos);
    this.freeBuffer(this.pointCol);
    if (this.target && this.gl !== null) this.freeTargetObjects(this.gl, this.target);
    if (this.progs) {
      this.freeProgram(this.progs.lit.prog);
      this.freeProgram(this.progs.alias.prog);
      this.freeProgram(this.progs.flat.prog);
    }
    if (this.postProg) this.freeProgram(this.postProg.prog);
    this.dropGLCaches();
  }

  /**
   * Delete the previous static generation's objects BEFORE uploadStatic
   * replaces them (same-context; caller guarantees a live context).
   */
  private freeStaticGL(): void {
    for (const tex of [...this.diffuseTex.values()]) if (tex) this.freeTexture(tex);
    this.diffuseTex = new Map();
    for (const entry of [...this.skinTex.values()]) if (entry) this.freeTexture(entry.tex);
    this.skinTex = new Map();
    for (const handle of [...this.modelGL.keys()]) this.freeModelGL(handle);
    this.modelGL = new Map();
    this.freeTexture(this.whiteTex);
    this.whiteTex = null;
    this.freeBuffer(this.onesBuf);
    this.onesBuf = null;
    this.freeBuffer(this.worldPosBuf);
    this.freeBuffer(this.worldUVBuf);
    this.freeBuffer(this.worldLUVBuf);
    this.freeBuffer(this.worldAlphaBuf);
    this.freeBuffer(this.worldIdxBuf);
    this.worldPosBuf = null;
    this.worldUVBuf = null;
    this.worldLUVBuf = null;
    this.worldAlphaBuf = null;
    this.worldIdxBuf = null;
    this.freeBuffer(this.skyPosBuf);
    this.freeBuffer(this.skyColBuf);
    this.freeBuffer(this.skyIdxBuf);
    this.skyPosBuf = null;
    this.skyColBuf = null;
    this.skyIdxBuf = null;
    this.freeTexture(this.atlasTex);
    this.atlasTex = null;
  }

  private ensurePrograms(gl: WebGL2RenderingContext): void {
    if (this.progs && this.postProg) return;
    const locs = (vs: string, fs: string): ProgLocs => {
      const prog = this.trackProg(compileProgram(gl, vs, fs));
      const L = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(prog, name);
      return {
        prog,
        uMVP: L('uMVP'),
        uDepthScale: L('uDepthScale'),
        uDepthBias: L('uDepthBias'),
        uDiffuse: L('uDiffuse'),
        uLightmap: L('uLightmap'),
        uMap: L('uMap'),
        uTextured: L('uTextured'),
        uPointSize: L('uPointSize'),
        uLightPos: L('uLightPos[0]'),
        uLightColor: L('uLightColor[0]'),
        uNumLights: L('uNumLights'),
        uAlpha: L('uAlpha'),
        uUVScale: L('uUVScale'),
        uLodBias: L('uLodBias'),
        uMipDither: L('uMipDither'),
        uMaxLevel: L('uMaxLevel'),
        uOverbright: L('uOverbright'),
        uFogEnabled: L('uFogEnabled'),
        uFogAmount: L('uFogAmount'),
        uFogColor: L('uFogColor'),
        uFogTable: L('uFogTable'),
        uDebugMode: L('uDebugMode'),
        uWarpOn: L('uWarpOn'),
        uTime: L('uTime'),
      };
    };
    try {
      if (!this.progs) {
        this.progs = { lit: locs(VS_LIT, FS_LIT), alias: locs(VS_ALIAS, FS_ALIAS), flat: locs(VS_FLAT, FS_FLAT) };
      }
      if (!this.postProg) {
        const prog = this.trackProg(compileProgram(gl, VS_POST, FS_APPEARANCE));
        const L = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(prog, name);
        this.postProg = {
          prog,
          uScene: L('uScene'),
          uDitherOn: L('uDitherOn'),
          uDitherMode: L('uDitherMode'),
          uPostfilter: L('uPostfilter'),
          uReconMode: L('uReconMode'),
          uRgbMaxDelta: L('uRgbMaxDelta'),
          uGamma: L('uGamma'),
          u16bit: L('u16bit'),
          uWarpOn: L('uWarpOn'),
          uWarpTime: L('uWarpTime'),
        };
      }
    } catch (err) {
      this.fail(`WebGLRenderer.ensurePrograms: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Upload all static GL state for the current generation, ONCE: the FULL
   * world inventory (every triangulable surface, no camera culling) into one
   * shared buffer set + per-surface ranges, the full-map light atlas, and
   * the sky fill. Per-frame camera selections never touch this path (the
   * generation only bumps on map change / explicit invalidation).
   */
  private uploadStatic(gl: WebGL2RenderingContext, input: GpuFrameInput): void {
    const world = this.world;
    const palette = this.palette;
    if (!world || !palette) return;
    // Map replacement: delete the previous generation's same-context objects
    // BEFORE replacing ownership (never drop maps/targets and rely on GC).
    this.freeStaticGL();

    // Full inventory: every triangulable surface id (selection-independent).
    const allIds: number[] = [];
    for (let i = 0; i < world.surfaces.length; i++) {
      if (world.surfaces[i] && world.surfaces[i]!.n >= 3) allIds.push(i);
    }
    const sig = styleSignature(input.view.lightStyles);
    const { atlas, skipped, shortFallback } = packLightAtlas(world, allIds, input.view.lightStyles);
    for (const id of skipped) this.warn(`lightmap atlas overflow: surface ${id} unlit (uniform unlit tile)`);
    this.atlasStats = {
      width: atlas.width,
      height: atlas.height,
      rects: atlas.rectOf.size,
      skipped: skipped.length,
      shortFallback: shortFallback.length,
    };
    this.atlas = atlas;
    this.styleSig = sig;
    const store = buildFullWorldStore(world, atlas);

    this.worldRanges = new Map();
    this.vertBase = new Map();
    for (const [id, r] of store.world.surfaces) {
      this.worldRanges.set(id, {
        start: r.indexStart,
        count: r.indexCount,
        texId: r.texId,
        transparent: r.transparent,
        warped: r.material === 'turbulent',
      });
      this.vertBase.set(id, { vStart: r.vertStart, vCount: r.vertCount });
    }
    this.worldPositions = store.world.positions.slice();
    this.worldPosBuf = this.createStaticBuffer(gl, store.world.positions);
    // Animated-texture inventory for the per-frame texId re-sync below.
    this.animFaceIds = [];
    if (this.world) {
      for (let i = 0; i < this.world.surfaces.length; i++) {
        const s = this.world.surfaces[i];
        if (s && s.animTexIds && s.animTexIds.length > 1 && this.worldRanges.has(i)) {
          this.animFaceIds.push(i);
        }
      }
    }
    this.worldUVBuf = this.createStaticBuffer(gl, store.world.uvs);
    this.worldLUVBuf = this.createStaticBuffer(gl, store.world.lightUVs);
    this.worldAlphaBuf = this.createStaticBuffer(gl, store.world.alphas);
    this.worldIdxBuf = this.createStaticIndexBuffer(gl, store.world.indices);

    this.skyRanges = new Map();
    for (const [id, r] of store.sky.ranges) this.skyRanges.set(id, { start: r.start, count: r.count });
    this.skyPosBuf = this.createStaticBuffer(gl, store.sky.positions);
    const skyCol = new Float32Array(store.sky.positions.length / 3 * 4);
    const skyIdx = pickSkyPaletteIndex(palette);
    const sr = (palette[skyIdx * 3] ?? 0) / 255;
    const sg = (palette[skyIdx * 3 + 1] ?? 0) / 255;
    const sb = (palette[skyIdx * 3 + 2] ?? 0) / 255;
    for (let i = 0; i < skyCol.length; i += 4) {
      skyCol[i] = sr; skyCol[i + 1] = sg; skyCol[i + 2] = sb; skyCol[i + 3] = 1;
    }
    this.skyColBuf = this.createStaticBuffer(gl, skyCol);
    this.skyIdxBuf = this.createStaticIndexBuffer(gl, store.sky.indices);
    this.noteGlErrorAt(gl, 'uploadStatic-buffers');
    this.atlasTex = this.uploadTexture(gl, atlas.pixels, atlas.width, atlas.height);
    this.noteGlErrorAt(gl, 'uploadStatic-atlas');
    this.staticDirty = false;
  }

  private createStaticBuffer(gl: WebGL2RenderingContext, data: Float32Array): WebGLBuffer {
    const buf = gl.createBuffer();
    if (!buf) this.fail('WebGLRenderer.uploadStatic: createBuffer returned null');
    this.trackBuf(buf);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return buf;
  }

  private createStaticIndexBuffer(gl: WebGL2RenderingContext, data: Uint32Array): WebGLBuffer {
    const buf = gl.createBuffer();
    if (!buf) this.fail('WebGLRenderer.uploadStatic: createBuffer returned null');
    this.trackBuf(buf);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return buf;
  }

  /**
   * First-submit GL error isolation (FOLLOW-4): poll one error flag after a
   * named stage during the boot frames only (uploadCount<=1, submitted<3).
   * Records a stage-attributed warning instead of letting the flag surface
   * later as a "pre-existing" mystery at the first texture upload. Steady
   * state never polls (no per-frame getError cost).
   */
  private noteGlErrorAt(gl: WebGL2RenderingContext, stage: string): void {
    if (this.uploadCount > 1 || this.submitted >= 3) return;
    if (typeof (gl as unknown as { getError?: unknown }).getError !== 'function') return;
    try {
      // Drain-loop (not a single poll): GL implementations may hold several
      // pending flags and getError clears only one per call. A single poll
      // would leave backlog that a later poll misattributes, so report every
      // drained flag with this stage and clear the queue fully.
      for (let i = 0; i < 8; i++) {
        const err = gl.getError();
        if (err === 0) break;
        this.warn(`first-submit GL error ${err} at ${stage} (isolated, drained here)`);
        if (i === 7) this.warn(`first-submit GL error queue overflow at ${stage} (8+ flags pending)`);
      }
    } catch {
      /* best-effort */
    }
  }

  /**
   * Upload one RGB level with explicit tightly-packed pixel state
   * (FOLLOW-2B): UNPACK_ALIGNMENT 1 + UNPACK_ROW_LENGTH 0 for the upload,
   * restored afterwards; a guarded getError warn makes real-GL upload
   * failures loud instead of silent. Stubs without pixelStorei/getError
   * (typeof-guarded) keep working with default unpack state.
   *
   * GL error flags are sticky: a flag set by an EARLIER call would
   * misattribute to this upload, so the pre-poll distinguishes a flag this
   * texImage2D set itself (actionable: texels may be corrupt) from a
   * pre-existing flag drained here (reported once, not blamed on the upload).
   */
  private uploadPixels(
    gl: WebGL2RenderingContext,
    level: number,
    w: number,
    h: number,
    data: Uint8Array,
  ): void {
    const hasError = typeof (gl as unknown as { getError?: unknown }).getError === 'function';
    let preErr = 0;
    if (hasError) {
      try {
        preErr = gl.getError();
      } catch {
        preErr = 0;
      }
      if (preErr !== gl.NO_ERROR) {
        this.warn(`pre-existing GL error ${preErr} observed at texture upload ${w}x${h} level ${level} (drained, not attributed to this upload)`);
      }
    }
    const hasStore = typeof (gl as unknown as { pixelStorei?: unknown }).pixelStorei === 'function';
    let prevAlign: number | null = null;
    let prevRowLen: number | null = null;
    if (hasStore) {
      try {
        const cur = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
        if (typeof cur === 'number') prevAlign = cur;
      } catch {
        prevAlign = null;
      }
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const rowLenEnum = (gl as unknown as { UNPACK_ROW_LENGTH?: number }).UNPACK_ROW_LENGTH;
      if (typeof rowLenEnum === 'number') {
        try {
          const curRow = gl.getParameter(rowLenEnum) as number;
          if (typeof curRow === 'number') prevRowLen = curRow;
        } catch {
          prevRowLen = null;
        }
        gl.pixelStorei(rowLenEnum, 0);
      }
    }
    try {
      gl.texImage2D(gl.TEXTURE_2D, level, gl.RGB, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, data);
    } finally {
      if (hasStore) {
        try {
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, prevAlign ?? 4);
          const rowLenEnum = (gl as unknown as { UNPACK_ROW_LENGTH?: number }).UNPACK_ROW_LENGTH;
          if (typeof rowLenEnum === 'number' && prevRowLen !== null) {
            gl.pixelStorei(rowLenEnum, prevRowLen);
          }
        } catch {
          /* restore is best-effort on exotic handles */
        }
      }
    }
    if (typeof (gl as unknown as { getError?: unknown }).getError === 'function') {
      try {
        const err = gl.getError();
        if (err !== gl.NO_ERROR) {
          this.warn(`texture upload ${w}x${h} level ${level} GL error ${err} (texels may be corrupt)`);
        }
      } catch {
        /* error polling is best-effort */
      }
    }
  }

  /**
   * Upload a texture with per-kind wrap addressing (FOLLOW-2B): world WAL
   * diffuse uses REPEAT (BSP UVs are unrestricted texel coords, routinely
   * negative/multi-tile); skins, sprites, the lightmap atlas and the white
   * texel use CLAMP_TO_EDGE. Uploads pin the active unit to TEXTURE0 so a
   * lazy first-use upload can never clobber the unit-1 lightmap binding
   * (sampler-unit isolation); every world draw re-binds both units anyway.
   */
  private uploadTextureLevels(
    gl: WebGL2RenderingContext,
    rgb: Uint8Array,
    w: number,
    h: number,
    mips: boolean,
    wrap: 'repeat' | 'clamp',
  ): WebGLTexture {
    const tex = gl.createTexture();
    if (!tex) this.fail('WebGLRenderer.uploadStatic: createTexture returned null');
    this.trackTex(tex);
    const ap = this.apFrame;
    const linear = ap ? ap.bilinear : true;
    const min = linear ? gl.LINEAR : gl.NEAREST;
    const mag = linear ? gl.LINEAR : gl.NEAREST;
    // Pin side effects to unit 0 (see above); draw paths re-bind unit 1.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
    const wrapMode = wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapMode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapMode);
    if (mips) {
      // CPU-built mip chain (Voodoo box-filter rule, clamp addressing):
      // level 0 is the capped base, each step halves to 1x1. MIN stays
      // LINEAR (no inter-level blend — single-TMU spirit); the shader picks
      // the level explicitly via textureLod.
      const chain = buildMipChainRGB(rgb, w, h);
      for (let lvl = 0; lvl < chain.length; lvl++) {
        const m = chain[lvl]!;
        this.uploadPixels(gl, lvl, m.w, m.h, m.data);
      }
      this.texLevels.set(tex, chain.length - 1);
    } else {
      this.uploadPixels(gl, 0, w, h, rgb);
      this.texLevels.set(tex, 0);
    }
    return tex;
  }

  /** Backwards-compatible single-level upload (lightmap atlas, white texel). */
  private uploadTexture(
    gl: WebGL2RenderingContext,
    rgb: Uint8Array,
    w: number,
    h: number,
    wrap: 'repeat' | 'clamp' = 'clamp',
  ): WebGLTexture {
    return this.uploadTextureLevels(gl, rgb, w, h, false, wrap);
  }

  /** Per-draw sampler mode (vd_bilinear is live: no re-upload, just params). */
  private applyFilter(gl: WebGL2RenderingContext, tex: WebGLTexture): void {
    const linear = this.apFrame ? this.apFrame.bilinear : true;
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  }

  /** Diffuse texture for a world texId (expanded via palette; null = skip). */
  private diffuseFor(gl: WebGL2RenderingContext, texId: number): WebGLTexture | null {
    if (this.diffuseTex.has(texId)) return this.diffuseTex.get(texId)!;
    const world = this.world;
    const palette = this.palette;
    const max = this.apFrame ? this.apFrame.maxtexsize : 256;
    let out: WebGLTexture | null = null;
    if (world && palette) {
      const tex = world.textures[texId];
      if (tex) {
        const rgb = expandPaletteTexture(tex.texels, tex.width, tex.height, palette);
        if (!rgb) {
          this.warn(`diffuse texture ${texId} texel mismatch (skipped)`);
        } else {
          // vd_maxtexsize enforced at upload: aspect-preserving box
          // resample + recorded warning (GPU closes the CPU dims-only gap).
          const capped = downsampleToCap(rgb, tex.width, tex.height, max);
          if (capped.capped) {
            this.warn(`diffuse texture ${texId} oversized ${tex.width}x${tex.height} (resampled to ${capped.w}x${capped.h})`);
          }
          out = this.uploadTextureLevels(gl, capped.data, capped.w, capped.h, true, 'repeat');
        }
      }
    }
    this.diffuseTex.set(texId, out);
    return out;
  }

  /** Skin texture for an entity skin handle (capped + resampled; null = fallback). */
  private skinFor(gl: WebGL2RenderingContext, handle: number): { tex: WebGLTexture; w: number; h: number } | null {
    if (this.skinTex.has(handle)) return this.skinTex.get(handle)!;
    const palette = this.palette;
    const max = this.apFrame ? this.apFrame.maxtexsize : 256;
    let out: { tex: WebGLTexture; w: number; h: number } | null = null;
    const skin = this.skins.get(handle);
    if (skin && palette) {
      const rgb = expandPaletteTexture(skin.texels, skin.width, skin.height, palette);
      if (rgb) {
        // UV scale uses ORIGINAL dims (texel-space UVs address the source);
        // the upload below is the capped resample of the same image.
        const capped = downsampleToCap(rgb, skin.width, skin.height, max);
        if (capped.capped) {
          this.warn(`skin ${handle} oversized ${skin.width}x${skin.height} (resampled to ${capped.w}x${capped.h})`);
        }
        out = { tex: this.uploadTextureLevels(gl, capped.data, capped.w, capped.h, true, 'clamp'), w: skin.width, h: skin.height };
      } else {
        this.warn(`skin ${handle} texel mismatch (white fallback)`);
      }
    }
    this.skinTex.set(handle, out);
    return out;
  }

  private whiteFor(gl: WebGL2RenderingContext): WebGLTexture {
    if (!this.whiteTex) {
      this.whiteTex = this.uploadTexture(gl, new Uint8Array([255, 255, 255]), 1, 1);
    }
    return this.whiteTex;
  }

  /**
   * One sky face texture (lazy, single-level, palette-expanded at upload
   * like skinFor). One mip level only: the CPU skybox path samples mip 0
   * with no lightmap, so uMaxLevel clamps to 0 and the mip-dither pick can
   * never leave level 0. Per-face CLAMP addressing: combined with
   * face-local half-texel-inset UVs (entities.emitSkyBoxFace), the bilinear
   * footprint stays inside this face — neighbour tiles are separate GL
   * textures and unreachable. Null without a strip or palette (caller
   * falls back to the flat fill).
   */
  private skyFaceFor(gl: WebGL2RenderingContext, tile: number): WebGLTexture | null {
    if (this.skyFaceTex[tile]) return this.skyFaceTex[tile];
    const strip = this.skyStrip;
    const palette = this.palette;
    if (!strip || !palette) return null;
    const { tileW, tileH } = strip;
    const slice = strip.pixels.subarray(tile * tileW * tileH, (tile + 1) * tileW * tileH);
    const rgb = expandPaletteTexture(slice, tileW, tileH, palette);
    if (!rgb) {
      this.warn(`sky face ${tile} texel mismatch (flat sky fallback)`);
      return null;
    }
    const tex = this.uploadTextureLevels(gl, rgb, tileW, tileH, false, 'clamp');
    this.skyFaceTex[tile] = tex;
    return tex;
  }

  /** 1.0-filled buffer (alias alpha attribute filler). */
  private onesFor(gl: WebGL2RenderingContext): WebGLBuffer | null {
    if (!this.onesBuf) {
      this.onesBuf = gl.createBuffer();
      if (!this.onesBuf) return null;
      this.trackBuf(this.onesBuf);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.onesBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(4096).fill(1), gl.STATIC_DRAW);
    }
    return this.onesBuf;
  }

  /** Re-bake atlas texels for a new style signature (rects/buffers kept). */
  private rebakeAtlas(
    gl: WebGL2RenderingContext,
    world: MiniWorld,
    lightStyles: Float32Array,
    sig: number,
  ): void {
    if (!this.atlas) return;
    // Full inventory (same surface set as the upload: pack order is
    // deterministic, so rects stay valid and lightUV attributes hold).
    const worldIds: number[] = [];
    for (let i = 0; i < world.surfaces.length; i++) {
      if (world.surfaces[i] && world.surfaces[i]!.n >= 3) worldIds.push(i);
    }
    const { atlas, skipped, shortFallback } = packLightAtlas(world, worldIds, lightStyles);
    // Same surface set => same rects (pack order is deterministic); only
    // texels change, so lightUV attributes stay valid.
    for (const id of skipped) this.warn(`lightmap atlas overflow: surface ${id} unlit (uniform unlit tile)`);
    this.atlasStats = {
      width: atlas.width,
      height: atlas.height,
      rects: atlas.rectOf.size,
      skipped: skipped.length,
      shortFallback: shortFallback.length,
    };
    if (this.atlasTex && atlas.width === this.atlas.width && atlas.height === this.atlas.height) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
      this.uploadPixels(gl, 0, atlas.width, atlas.height, atlas.pixels);
      this.atlas.pixels = atlas.pixels;
    } else {
      // Size change: delete the obsolete same-context atlas texture BEFORE
      // replacing ownership (in-place texel path above reuses the object).
      this.freeTexture(this.atlasTex);
      this.atlasTex = this.uploadTexture(gl, atlas.pixels, atlas.width, atlas.height);
      this.atlas = atlas;
    }
    this.styleSig = sig;
  }

  private entityKind(handle: number): GpuEntityModelKind | 'alias' {
    return this.entityKinds?.get(handle) ?? this.models.get(handle)?.kind ?? 'alias';
  }

  private drawScene(gl: WebGL2RenderingContext, input: GpuFrameInput): void {
    const world = this.world;
    const palette = this.palette;
    if (!world || !palette || !this.progs || !this.atlasTex) return;
    // Live per-frame appearance snapshot (uniform updates only — no
    // re-uploads) + the 64-entry fog LUT (uniform, refreshed per frame).
    this.apFrame = resolveAppearanceFrame();
    this.fogLUT = buildFogLUT01(FOG_DENSITY);
    const cam: Camera = setupCamera(input.view.origin, input.view.angles, input.view.fovX, this.width, this.height);
    const V = buildViewMatrix(cam.origin, cam.forward, cam.right, cam.up);
    const P = buildProjectionMatrix(input.view.fovX, this.width, this.height, GPU_NEAR, GPU_FAR);
    const VP = multiplyMat4(P, V);
    const lights = (input.lights ?? []).slice(0, MAX_GPU_LIGHTS);
    if ((input.lights ?? []).length > MAX_GPU_LIGHTS) {
      this.warn(`dynamic lights clamped to ${MAX_GPU_LIGHTS} (first-come wins)`);
    }

    // Scene renders into the linear target; the appearance pass below
    // resolves it to the canvas. Without FBO support (minimal stubs) fall
    // back to direct rendering (documented stub-compat path).
    const useTarget = this.ensureTargets(gl);
    this.noteGlErrorAt(gl, 'drawScene-targets');
    const target = useTarget ? this.target : null;
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(CLEAR_R, CLEAR_G, CLEAR_B, CLEAR_A);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    this.noteGlErrorAt(gl, 'drawScene-clear');

    // FOLLOW-2: draw the SUBMITTED selection (input.scene), not a baked batch
    // set. The play layer refreshes this every frame the camera moves, so
    // turning/translating reveals newly visible surfaces with no re-upload.
    // Brush-mover verts may have shifted since upload: re-sync first.
    const scene = input.scene ?? this.scene;
    if (!scene) return;
    this.syncDynamicVerts(gl, scene);
    this.syncDynamicTexIds();

    // Sky first (flat fill, no depth write so nothing z-fights the hull).
    {
      const flat = this.progs.flat;
      gl.useProgram(flat.prog);
      this.setMVP(gl, flat, VP, 1);
      this.setVoodooPolicy(gl, flat);
      if (flat.uPointSize) gl.uniform1f(flat.uPointSize, 1);
      if (flat.uTextured) gl.uniform1i(flat.uTextured, 0);
      gl.depthMask(false);
      this.noteGlErrorAt(gl, 'drawScene-sky-setup');
      const skyRefs = scene.surfaces.filter((r) => r.material === 'sky' && r.transformIndex === 0).length;
      // FOLLOW-3A window repair: the textured background box draws whenever
      // a strip is retained — NOT gated on selected sky refs. The old
      // hasSky gate left windows black when PVS/frustum selection carried
      // zero sky refs even though exterior sky was visible through glass;
      // the box is depth-tested background (far plane, no depth write), so
      // opaque walls still occlude it and glass still blends over it.
      if (this.skyStrip) {
        const faces: Array<WebGLTexture | null> = [];
        for (let f = 0; f < 6; f++) faces.push(this.skyFaceFor(gl, f));
        if (faces.every((t) => t !== null)) {
          // Textured skybox (CPU emitSkyBox parity): six view-centered
          // single-face quads, each with its own face texture (fullbright);
          // the hull ranges are skipped, like the CPU discarding SURF_SKY.
          // Box face f samples tile SKY_SIDE_IMAGE[f] (id r_skysideimage:
          // face->suffix table), NOT tile f — the strip is packed in
          // filename suffix order [rt,bk,lf,ft,up,dn].
          for (let f = 0; f < 6; f++) {
            const box = emptyFlatBatch();
            emitSkyBoxFace(box, cam.origin, SKY_BOX_HALF, f, this.skyStrip.tileW, this.skyStrip.tileH);
            this.drawFlatBatch(gl, VP, box, faces[SKY_SIDE_IMAGE[f]!]!);
          }
          this.lastSky = { mode: 'textured-box', refs: skyRefs };
        } else {
          for (const ref of scene.surfaces) {
            if (ref.material !== 'sky' || ref.transformIndex !== 0) continue;
            this.drawSkyRange(gl, ref.surfaceId);
          }
          this.lastSky = { mode: 'flat-hull', refs: skyRefs };
        }
      } else {
        for (const ref of scene.surfaces) {
          if (ref.material !== 'sky' || ref.transformIndex !== 0) continue;
          this.drawSkyRange(gl, ref.surfaceId);
        }
        this.lastSky = { mode: scene.surfaces.some((r) => r.material === 'sky' && r.transformIndex === 0) ? 'flat-hull' : 'none', refs: skyRefs };
      }
      gl.depthMask(true);
    }
    this.noteGlErrorAt(gl, 'drawScene-sky');

    // Opaque pass in scene order (world ranges + opaque entities; depth
    // test on, depth write on). Beams always ride the blend pass below, and
    // depth-hacked guns have their own pass — both are skipped here.
    {
      const lit = this.progs.lit;
      gl.useProgram(lit.prog);
      this.setMVP(gl, lit, VP, 1);
      this.setLights(gl, lit, lights);
      this.setVoodooPolicy(gl, lit);
      this.bindLightmap(gl, lit);
      this.noteGlErrorAt(gl, 'drawScene-opaque-setup');
      gl.depthMask(true);
      for (const ref of scene.surfaces) {
        if (ref.transparent || ref.material === 'sky') continue;
        if (ref.transformIndex === 0) {
          if (ref.material !== 'opaque' && ref.material !== 'turbulent') continue;
          this.drawWorldRange(gl, lit, ref.surfaceId, input.time);
          continue;
        }
        const e = this.entities[-1 - ref.surfaceId];
        if (!e) continue;
        const kind = this.entityKind(e.model);
        if (kind === 'tracer') continue; // blend pass owns every beam
        const alpha = clamp01(e.alpha ?? 1);
        if (alpha <= 0) continue;
        if (kind === 'md2') {
          if (alpha >= 1 && e.depthHack !== true) this.drawAlias(gl, V, P, e, false, lights);
        } else if (kind === 'sp2') {
          if (alpha >= 1) this.drawSpriteSingle(gl, VP, e, cam, alpha);
        }
      }
    }

    // Gun pass (eye-anchored viewmodel, depth-hack MVP).
    for (let ei = 0; ei < this.entities.length; ei++) {
      const e = this.entities[ei]!;
      if (e.depthHack !== true) continue;
      if (this.entityKind(e.model) !== 'md2') continue;
      const alpha = clamp01(e.alpha ?? 1);
      if (alpha <= 0 || alpha < 1) continue; // translucent guns ride the blend pass
      this.drawAlias(gl, V, P, e, true, lights);
    }

    // Particles (POINTS, depth-tested, depth-writing).
    {
      const { positions, colors } = collectParticlePoints(world, palette);
      if (positions.length > 0) this.drawPoints(gl, VP, positions, colors);
    }

    // Blend pass: ONE far->near walk over the submitted selection —
    // transparent world ranges + translucent alias + transparent sprites +
    // beams interleaved by the combined order keys refreshGpuScene computed
    // for THIS view (no frozen spawn-subset order). Depth test on, depth
    // write OFF (CPU deferred alpha).
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    {
      const lit = this.progs.lit;
      gl.useProgram(lit.prog);
      this.setMVP(gl, lit, VP, 1);
      this.setLights(gl, lit, lights);
      this.setVoodooPolicy(gl, lit);
      this.bindLightmap(gl, lit);
      for (const ref of scene.surfaces) {
        if (ref.transformIndex === 0) {
          // Blend-pass world: every transparent non-sky ref in scene order
          // (far->near) — glass ('transparent') AND turbulent+translucent
          // water ('turbulent', warped per draw). Sky can never be
          // transparent here (sky+translucent classifies as glass and has no
          // world range), but the guard documents the invariant.
          if (!ref.transparent || ref.material === 'sky') continue;
          this.drawWorldRange(gl, lit, ref.surfaceId, input.time);
          continue;
        }
        const e = this.entities[-1 - ref.surfaceId];
        if (!e) continue;
        const kind = this.entityKind(e.model);
        if (kind === 'tracer') {
          this.drawBeamSingle(gl, VP, e, cam, palette);
          continue;
        }
        const alpha = clamp01(e.alpha ?? 1);
        if (alpha <= 0 || alpha >= 1) continue;
        if (kind === 'md2') {
          this.drawAlias(gl, V, P, e, e.depthHack === true, lights, alpha);
        } else if (kind === 'sp2') {
          this.drawSpriteSingle(gl, VP, e, cam, alpha);
        }
      }
      // Beams whose refs were never selected still draw (the old path drew
      // every tracer every frame): belt-and-braces for entity lists the
      // selection did not cover. Normally empty.
      for (let ei = 0; ei < this.entities.length; ei++) {
        const e = this.entities[ei]!;
        if (this.entityKind(e.model) !== 'tracer') continue;
        if (scene.surfaces.some((r) => r.transformIndex !== 0 && r.surfaceId === -1 - ei)) continue;
        this.drawBeamSingle(gl, VP, e, cam, palette);
      }
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // Appearance resolve: ONE fullscreen pass from the linear scene target
    // to the canvas (underwater warp, then dither -> 565 quantize ->
    // reconstruction -> gamma). Resident on GPU through presentation;
    // never a readback.
    if (target) {
      const warpOn = input.underwater?.submerged === true;
      this.runAppearance(gl, target, warpOn, input.time);
    }
  }

  /**
   * Ensure the linear scene target exists at the current size.
   * RGBA16F when EXT_color_buffer_float renders it, else an RGBA8 fallback
   * with ONE recorded warning (capability branch, tested both ways via
   * stub). Depth format follows vd_zbits at creation time (>= 24 asks for
   * DEPTH_COMPONENT24, else DEPTH_COMPONENT16). Returns false when the GL
   * handle cannot provide FBOs at all (minimal stubs): the caller then
   * renders direct (documented stub-compat path, never production).
   * Target (re)creation is NOT a texture upload (upload contract pinned).
   */
  private ensureTargets(gl: WebGL2RenderingContext): boolean {
    if (
      typeof gl.createFramebuffer !== 'function' ||
      typeof gl.createTexture !== 'function' ||
      typeof gl.createRenderbuffer !== 'function' ||
      typeof gl.getExtension !== 'function' ||
      typeof gl.checkFramebufferStatus !== 'function'
    ) {
      if (!this.fboUnsupportedWarned) {
        this.fboUnsupportedWarned = true;
        this.warn('appearance: no FBO support on this GL handle — direct rendering (stub-compat path)');
      }
      return false;
    }
    if (this.floatCap === null) {
      let ext: unknown = null;
      try {
        ext = gl.getExtension('EXT_color_buffer_float');
      } catch {
        ext = null;
      }
      this.floatCap = ext !== null && ext !== undefined;
      if (!this.floatCap && !this.targetFallbackWarned) {
        this.targetFallbackWarned = true;
        this.warn('appearance: EXT_color_buffer_float unavailable — RGBA8 fallback target');
      }
    }
    const wantFloat = this.floatCap === true;
    if (this.target && this.target.w === this.width && this.target.h === this.height && this.target.float === wantFloat) {
      return true;
    }
    // (Re)create at the current size: delete the obsolete same-context FBO
    // set BEFORE replacing ownership (resize path already freed its target;
    // this covers capability flips and first creation where target is null).
    if (this.target) this.freeTargetObjects(gl, this.target);
    const tex = gl.createTexture();
    const depth = gl.createRenderbuffer();
    const fbo = gl.createFramebuffer();
    if (!tex || !depth || !fbo) this.fail('WebGLRenderer.ensureTargets: target allocation returned null');
    const ap = this.apFrame;
    const zbits = ap ? ap.zbits : 16;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (wantFloat) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.width, this.height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(
      gl.RENDERBUFFER,
      zbits >= 24 ? gl.DEPTH_COMPONENT24 : gl.DEPTH_COMPONENT16,
      this.width,
      this.height,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      this.fail(`WebGLRenderer.ensureTargets: framebuffer incomplete (${status})`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.trackTex(tex);
    this.trackRb(depth);
    this.trackFbo(fbo);
    this.target = { fbo, tex, depth, w: this.width, h: this.height, float: wantFloat };
    return true;
  }

  /** Fullscreen appearance resolve from the scene target to the canvas. */
  private runAppearance(gl: WebGL2RenderingContext, target: SceneTarget, warpOn = false, warpTime = 0): void {
    const post = this.postProg;
    const ap = this.apFrame;
    if (!post || !ap) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(post.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    if (post.uScene) gl.uniform1i(post.uScene, 0);
    if (post.uDitherOn) gl.uniform1i(post.uDitherOn, ap.dither ? 1 : 0);
    if (post.uDitherMode) gl.uniform1i(post.uDitherMode, ditherModeToInt(ap.ditherMode));
    if (post.uPostfilter) gl.uniform1i(post.uPostfilter, ap.postfilter ? 1 : 0);
    if (post.uReconMode) gl.uniform1i(post.uReconMode, reconModeToInt(ap.reconMode));
    if (post.uRgbMaxDelta) {
      gl.uniform3f(post.uRgbMaxDelta, ap.rgbMaxDelta[0], ap.rgbMaxDelta[1], ap.rgbMaxDelta[2]);
    }
    if (post.uGamma) gl.uniform1f(post.uGamma, ap.gamma);
    if (post.u16bit) gl.uniform1i(post.u16bit, ap.use16bit ? 1 : 0);
    if (post.uWarpOn) gl.uniform1i(post.uWarpOn, warpOn ? 1 : 0);
    if (post.uWarpTime) gl.uniform1f(post.uWarpTime, Number.isFinite(warpTime) ? warpTime : 0);
    // Buffer-less fullscreen triangle (gl_VertexID in VS_POST).
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
  }

  /**
   * Per-frame/per-program Voodoo policy uniforms (live vd_* state, no
   * re-uploads). uMaxLevel is set per texture at bind time (bindDiffuse /
   * skin binds), not here.
   */
  private setVoodooPolicy(gl: WebGL2RenderingContext, p: ProgLocs): void {
    const ap = this.apFrame;
    const lut = this.fogLUT;
    if (p.uDebugMode) gl.uniform1i(p.uDebugMode, this.debugView);
    if (!ap || !lut) return;
    if (ap.mipDither) this.policyUploads.on++;
    else this.policyUploads.off++;
    if (p.uLodBias) gl.uniform1f(p.uLodBias, ap.lodBias);
    if (p.uMipDither) gl.uniform1i(p.uMipDither, ap.mipDither ? 1 : 0);
    if (p.uOverbright) gl.uniform1f(p.uOverbright, ap.overbright ? 2 : 1);
    if (p.uFogEnabled) gl.uniform1i(p.uFogEnabled, ap.fogEnabled ? 1 : 0);
    const fog = this.fogOverride;
    if (p.uFogAmount) gl.uniform1f(p.uFogAmount, fog ? fog.amount : 0);
    if (p.uFogColor) {
      const c = fog ? fog.color : ([0, 0, 0] as [number, number, number]);
      gl.uniform3f(p.uFogColor, c[0], c[1], c[2]);
    }
    if (p.uFogTable) gl.uniform1fv(p.uFogTable, lut);
  }

  private drawAlias(
    gl: WebGL2RenderingContext,
    V: Float32Array,
    P: Float32Array,
    e: Entity,
    gun: boolean,
    lights: GpuLight[],
    alphaOverride?: number,
  ): void {
    const progs = this.progs;
    if (!progs) return;
    const reg = this.models.get(e.model);
    const mesh = reg?.mesh ?? null;
    if (!mesh) {
      // Missing-asset skip (FOLLOW-2A observability): the handle/kind context
      // distinguishes this from an absent entity or frustum/PVS occlusion
      // (those never reach drawAlias at all). Recorded, never a crash.
      this.warn(`drawAlias: model ${e.model} kind ${reg?.kind ?? 'unregistered'} has no mesh (skipped)`);
      return;
    }
    const { frameA, frameB, lerp } = resolveAliasLerp(e.frame, e.oldframe, e.backlerp, mesh.numFrames);
    const skin = this.skinFor(gl, e.skin);
    if (!skin) {
      this.warn(`alias entity skin ${e.skin} missing (white fallback)`);
    }
    // Interpolated positions + shade base into the shared dynamic buffers.
    // Small per-frame garbage (two scratch arrays per alias entity) is the
    // documented PROOF-3 cost; static geometry never re-uploads.
    const nv = mesh.numVerts;
    this.ensureDynCapacity(gl, nv);
    const posArr = new Float32Array(nv * 3);
    const shadeArr = new Float32Array(nv);
    interpolateAliasFrame(mesh, frameA, frameB, lerp, posArr);
    aliasShadeBase(mesh, frameA, frameB, lerp, ((e.angles[1]! * 256) / 360) & 255, shadeArr);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynPos);
    gl.bufferData(gl.ARRAY_BUFFER, posArr, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynShade);
    gl.bufferData(gl.ARRAY_BUFFER, shadeArr, gl.DYNAMIC_DRAW);
    const mgl = this.ensureModelGL(gl, e.model, mesh);
    if (!mgl) return;
    const M = buildEntityModel(e.origin, e.angles);
    const MV = multiplyMat4(V, M);
    const MVP = multiplyMat4(P, MV);
    const alias = progs.alias;
    gl.useProgram(alias.prog);
    if (alias.uDebugMode) gl.uniform1i(alias.uDebugMode, this.debugView);
    this.setMVP(gl, alias, MVP, gun ? GUN_DEPTH_SCALE : 1);
    if (alias.uDepthBias) gl.uniform1f(alias.uDepthBias, gun ? GUN_DEPTH_BIAS : 0);
    this.setLights(gl, alias, lights);
    this.setVoodooPolicy(gl, alias);
    this.bindDiffuse(gl, alias, skin?.tex ?? this.whiteFor(gl));
    const alpha = alphaOverride ?? clamp01(e.alpha ?? 1);
    if (alias.uAlpha) gl.uniform1f(alias.uAlpha, alpha);
    // Skin st are texel units; uUVScale normalizes by the ORIGINAL skin dims
    // (upload may be a capped resample of the same image, so original dims
    // keep the mapping exact). CLAMP addressing is equivalent here (CPU wraps
    // with a POT mask; st are pre-clamped to the header dims).
    if (alias.uUVScale) gl.uniform2f(alias.uUVScale, 1 / (skin?.w ?? 1), 1 / (skin?.h ?? 1));
    this.bindAttrib(gl, 0, this.dynPos, 3);
    this.bindAttrib(gl, 1, mgl.uvBuf, 2);
    this.bindAttrib(gl, 2, this.dynShade, 1);
    this.bindAttrib(gl, 3, this.onesFor(gl), 1);
    this.bindIndex(gl, mgl.idxBuf);
    gl.drawElements(gl.TRIANGLES, mgl.count, gl.UNSIGNED_INT, 0);
  }

  private drawSpriteSingle(
    gl: WebGL2RenderingContext,
    VP: Float32Array,
    e: Entity,
    cam: Camera,
    alpha: number,
  ): void {
    const b = emptyFlatBatch();
    this.emitSprite(b, e, cam, alpha);
    if (b.idx.length === 0) return; // missing skin already warned + skipped
    this.drawFlatBatch(gl, VP, b, this.skinFor(gl, e.skin)?.tex ?? null);
  }

  private drawBeamSingle(
    gl: WebGL2RenderingContext,
    VP: Float32Array,
    e: Entity,
    cam: Camera,
    palette: Uint8Array,
  ): void {
    const b = emptyFlatBatch();
    const seg = resolveBeam(e);
    const c = (seg.color & 255) * 3;
    emitBeamQuad(
      b, seg.ax, seg.ay, seg.az, seg.bx, seg.by, seg.bz, cam,
      (palette[c] ?? 0) / 255, (palette[c + 1] ?? 0) / 255, (palette[c + 2] ?? 0) / 255, 1,
    );
    if (b.idx.length > 0) this.drawFlatBatch(gl, VP, b, null);
  }

  private emitSprite(batch: FlatBatch, e: Entity, cam: Camera, alpha: number): void {
    const skin = this.skins.get(e.skin);
    if (!skin) {
      this.warn(`sprite entity skin ${e.skin} missing (skipped)`);
      return;
    }
    // White vertex color: the bound skin texture carries the color.
    emitSpriteQuad(batch, e.origin, cam, skin.width, skin.height, 1, 1, 1, alpha);
  }

  private setMVP(gl: WebGL2RenderingContext, p: ProgLocs, mvp: Float32Array, scale: number): void {
    if (p.uMVP) gl.uniformMatrix4fv(p.uMVP, false, mvp);
    if (p.uDepthScale) gl.uniform1f(p.uDepthScale, scale);
  }

  private setLights(gl: WebGL2RenderingContext, p: ProgLocs, lights: GpuLight[]): void {
    const pos = new Float32Array(MAX_GPU_LIGHTS * 4);
    const col = new Float32Array(MAX_GPU_LIGHTS * 3);
    for (let i = 0; i < lights.length && i < MAX_GPU_LIGHTS; i++) {
      const L = lights[i]!;
      pos[i * 4] = L.origin[0]!;
      pos[i * 4 + 1] = L.origin[1]!;
      pos[i * 4 + 2] = L.origin[2]!;
      pos[i * 4 + 3] = L.intensity;
      col[i * 3] = L.color[0]!;
      col[i * 3 + 1] = L.color[1]!;
      col[i * 3 + 2] = L.color[2]!;
    }
    if (p.uLightPos) gl.uniform4fv(p.uLightPos, pos);
    if (p.uLightColor) gl.uniform3fv(p.uLightColor, col);
    if (p.uNumLights) gl.uniform1i(p.uNumLights, Math.min(lights.length, MAX_GPU_LIGHTS));
  }

  private bindDiffuse(gl: WebGL2RenderingContext, p: ProgLocs, tex: WebGLTexture): void {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this.applyFilter(gl, tex);
    if (p.uDiffuse) gl.uniform1i(p.uDiffuse, 0);
    // LOD clamp follows the uploaded chain depth of THIS texture.
    if (p.uMaxLevel) gl.uniform1i(p.uMaxLevel, this.texLevels.get(tex) ?? 0);
  }

  private bindLightmap(gl: WebGL2RenderingContext, p: ProgLocs): void {
    if (!this.atlasTex) return;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    this.applyFilter(gl, this.atlasTex);
    if (p.uLightmap) gl.uniform1i(p.uLightmap, 1);
  }

  private bindAttrib(gl: WebGL2RenderingContext, loc: number, buf: WebGLBuffer | null, size: number): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  private bindIndex(gl: WebGL2RenderingContext, buf: WebGLBuffer | null): void {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf);
  }

  /**
   * Draw one uploaded world surface range (selection-driven). Missing ranges
   * (degenerate/sky ids, unknown surfaces) are skipped — never crash.
   * Re-binds the lit program every draw + BOTH sampler units (unit 0 diffuse,
   * unit 1 lightmap): blend-pass draws interleave world ranges with
   * alias/sprite/beam draws that switch programs, and a lazy first-use
   * diffuse upload pins TEXTURE0 — per-draw re-bind keeps unit 1 intact.
   * Uploads uDebugMode per draw so triage captures (0/1/2) take effect
   * without a pass restart. Turbulent ranges warp (uWarpOn from the uploaded
   * range flag + uTime from the frame time, the CPU turbPhase rule) in BOTH
   * passes — opaque water and translucent water warp identically
   * (GPU-FOLLOW-3).
   */
  private drawWorldRange(
    gl: WebGL2RenderingContext,
    p: ProgLocs,
    surfaceId: number,
    time: number,
  ): void {
    const range = this.worldRanges.get(surfaceId);
    if (!range) return;
    if (!this.worldPosBuf || !this.worldUVBuf || !this.worldLUVBuf ||
      !this.worldAlphaBuf || !this.worldIdxBuf) return;
    gl.useProgram(p.prog);
    if (p.uDebugMode) gl.uniform1i(p.uDebugMode, this.debugView);
    if (p.uWarpOn) gl.uniform1i(p.uWarpOn, range.warped ? 1 : 0);
    if (p.uTime) gl.uniform1f(p.uTime, time);
    const tex = this.diffuseFor(gl, range.texId) ?? this.whiteFor(gl);
    this.bindDiffuse(gl, p, tex);
    this.bindLightmap(gl, p);
    this.bindAttrib(gl, 0, this.worldPosBuf, 3);
    this.bindAttrib(gl, 1, this.worldUVBuf, 2);
    this.bindAttrib(gl, 2, this.worldLUVBuf, 2);
    this.bindAttrib(gl, 3, this.worldAlphaBuf, 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.worldIdxBuf);
    gl.drawElements(gl.TRIANGLES, range.count, gl.UNSIGNED_INT, range.start * 4);
  }

  /** Draw one uploaded sky surface range (flat fill, no texture). */
  private drawSkyRange(gl: WebGL2RenderingContext, surfaceId: number): void {
    const range = this.skyRanges.get(surfaceId);
    if (!range) return;
    if (!this.skyPosBuf || !this.skyColBuf || !this.skyIdxBuf) return;
    // FOLLOW-4 first-submit isolation: the flat sampler (uMap on unit 0)
    // must see a complete texture even when uTextured==0 — an unbound unit
    // raises INVALID_OPERATION (1282) on SwiftShader at draw time. Bind the
    // 1x1 white fallback so the flat fill never draws with an empty unit.
    const white = this.whiteFor(gl);
    if (white) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, white);
    }
    this.bindAttrib(gl, 0, this.skyPosBuf, 3);
    this.bindAttrib(gl, 1, this.skyColBuf, 4);
    this.bindAttrib(gl, 2, this.onesFor(gl), 2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.skyIdxBuf);
    gl.drawElements(gl.TRIANGLES, range.count, gl.UNSIGNED_INT, range.start * 4);
  }

  /**
   * Re-sync uploaded world positions for selected surfaces whose baked
   * verts moved since upload (brush movers: the play-layer DoorSync rewrites
   * MiniWorld verts/centers/bounds in place). Compares only the current
   * selection against the CPU shadow; re-uploads the whole position buffer
   * once when anything changed, never otherwise. UVs/lightUVs/alpha/indices
   * are topology-fixed and never re-uploaded.
   */
  private syncDynamicVerts(gl: WebGL2RenderingContext, scene: GpuSceneInput): void {
    const world = this.world;
    if (!world || !this.worldPositions || !this.worldPosBuf) return;
    let dirty = false;
    for (const ref of scene.surfaces) {
      if (ref.transformIndex !== 0) continue;
      const base = this.vertBase.get(ref.surfaceId);
      if (!base) continue;
      const s = world.surfaces[ref.surfaceId];
      if (!s) continue;
      const v = s.verts;
      const off = base.vStart * 3;
      let changed = false;
      for (let k = 0; k < v.length; k++) {
        if (v[k] !== this.worldPositions[off + k]) {
          changed = true;
          break;
        }
      }
      if (changed) {
        this.worldPositions.set(v, off);
        dirty = true;
      }
    }
    if (dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.worldPosBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.worldPositions, gl.DYNAMIC_DRAW);
    }
  }

  /**
   * Re-sync uploaded world texIds for animated faces (RELEASE-16 button
   * art; the syncDynamicVerts twin for textures): the play-layer DoorSync
   * writes the picked animation frame into the live MiniSurf texId per tick,
   * and the static worldRanges snapshot would otherwise keep serving the
   * bake-time frame. No GL re-upload — positions/UVs/indices are untouched
   * by animation, and diffuse binds per range at draw (diffuseFor uploads on
   * demand). Steady state is one compare per animated face (a handful).
   */
  private syncDynamicTexIds(): void {
    const world = this.world;
    if (!world || this.animFaceIds.length === 0) return;
    for (const id of this.animFaceIds) {
      const s = world.surfaces[id];
      const range = this.worldRanges.get(id);
      if (!s || !range) continue;
      if (range.texId !== s.texId) range.texId = s.texId;
    }
  }

  private drawFlatBatch(
    gl: WebGL2RenderingContext,
    VP: Float32Array,
    batch: FlatBatch,
    tex: WebGLTexture | null,
  ): void {
    const progs = this.progs;
    if (!progs || batch.idx.length === 0) return;
    const flat = progs.flat;
    gl.useProgram(flat.prog);
    this.setMVP(gl, flat, VP, 1);
    this.setVoodooPolicy(gl, flat);
    if (flat.uPointSize) gl.uniform1f(flat.uPointSize, 1);
    if (flat.uTextured) gl.uniform1i(flat.uTextured, tex ? 1 : 0);
    if (tex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      this.applyFilter(gl, tex);
      if (flat.uMap) gl.uniform1i(flat.uMap, 0);
      if (flat.uMaxLevel) gl.uniform1i(flat.uMaxLevel, this.texLevels.get(tex) ?? 0);
    }
    const n = batch.pos.length / 3;
    this.ensureFlatCapacity(gl, n, batch.idx.length);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatPos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(batch.pos), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatCol);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(batch.col), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatUV);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(batch.uv), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.flatIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(batch.idx), gl.DYNAMIC_DRAW);
    this.bindAttrib(gl, 0, this.flatPos, 3);
    this.bindAttrib(gl, 1, this.flatCol, 4);
    this.bindAttrib(gl, 2, this.flatUV, 2);
    this.bindIndex(gl, this.flatIdx);
    gl.drawElements(gl.TRIANGLES, batch.idx.length, gl.UNSIGNED_INT, 0);
  }

  private drawPoints(
    gl: WebGL2RenderingContext,
    VP: Float32Array,
    positions: Float32Array,
    colors: Float32Array,
  ): void {
    const progs = this.progs;
    if (!progs) return;
    const flat = progs.flat;
    gl.useProgram(flat.prog);
    this.setMVP(gl, flat, VP, 1);
    this.setVoodooPolicy(gl, flat);
    if (flat.uPointSize) gl.uniform1f(flat.uPointSize, 1);
    if (flat.uTextured) gl.uniform1i(flat.uTextured, 0);
    this.ensurePointCapacity(gl, positions.length / 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointPos);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointCol);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    this.bindAttrib(gl, 0, this.pointPos, 3);
    this.bindAttrib(gl, 1, this.pointCol, 4);
    // aUV (loc 2) is don't-care for untextured POINTS: bind the filler.
    this.bindAttrib(gl, 2, this.onesFor(gl), 2);
    gl.drawArrays(gl.POINTS, 0, positions.length / 3);
  }

  private ensureDynCapacity(gl: WebGL2RenderingContext, nv: number): void {
    if (!this.dynPos || !this.dynShade || this.dynSize < nv) {
      // Growth replaces the pair: delete the obsolete same-context buffers
      // BEFORE replacing ownership (per-frame growth must stay bounded).
      this.freeBuffer(this.dynPos);
      this.freeBuffer(this.dynShade);
      this.dynPos = gl.createBuffer();
      this.dynShade = gl.createBuffer();
      if (!this.dynPos || !this.dynShade) this.fail('WebGLRenderer: createBuffer returned null');
      this.trackBuf(this.dynPos);
      this.trackBuf(this.dynShade);
      this.dynSize = Math.max(nv, 64);
    }
  }

  private ensureFlatCapacity(gl: WebGL2RenderingContext, nverts: number, nidx: number): void {
    if (!this.flatPos || !this.flatCol || !this.flatUV || !this.flatIdx ||
      this.flatSize < nverts || this.flatIdxSize < nidx) {
      this.freeBuffer(this.flatPos);
      this.freeBuffer(this.flatCol);
      this.freeBuffer(this.flatUV);
      this.freeBuffer(this.flatIdx);
      this.flatPos = gl.createBuffer();
      this.flatCol = gl.createBuffer();
      this.flatUV = gl.createBuffer();
      this.flatIdx = gl.createBuffer();
      if (!this.flatPos || !this.flatCol || !this.flatUV || !this.flatIdx) {
        this.fail('WebGLRenderer: createBuffer returned null');
      }
      this.trackBuf(this.flatPos);
      this.trackBuf(this.flatCol);
      this.trackBuf(this.flatUV);
      this.trackBuf(this.flatIdx);
      this.flatSize = Math.max(nverts, 16);
      this.flatIdxSize = Math.max(nidx, 16);
    }
  }

  private ensurePointCapacity(gl: WebGL2RenderingContext, n: number): void {
    if (!this.pointPos || !this.pointCol || this.pointCount < n) {
      this.freeBuffer(this.pointPos);
      this.freeBuffer(this.pointCol);
      this.pointPos = gl.createBuffer();
      this.pointCol = gl.createBuffer();
      if (!this.pointPos || !this.pointCol) this.fail('WebGLRenderer: createBuffer returned null');
      this.trackBuf(this.pointPos);
      this.trackBuf(this.pointCol);
      this.pointCount = Math.max(n, 16);
    }
  }

  /** Per-model static UV/index cache (positions interpolate per frame). */
  private ensureModelGL(gl: WebGL2RenderingContext, handle: number, mesh: AliasMesh): ModelGL | null {
    const hit = this.modelGL.get(handle);
    if (hit) return hit;
    const uvBuf = gl.createBuffer();
    const idxBuf = gl.createBuffer();
    if (!uvBuf || !idxBuf) this.fail('WebGLRenderer: createBuffer returned null');
    this.trackBuf(uvBuf);
    this.trackBuf(idxBuf);
    // UVs stay in MD2 texel units here; uUVScale normalizes per draw by the
    // bound skin dims. Indices widen to Uint32 (drawElements UNSIGNED_INT).
    const entry: ModelGL = { uvBuf, idxBuf, count: mesh.tris.length, nv: mesh.numVerts };
    this.modelGL.set(handle, entry);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.st, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(mesh.tris), gl.STATIC_DRAW);
    return entry;
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}