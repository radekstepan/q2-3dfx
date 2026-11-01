// @q2/renderer-api — GPU scene/backend boundary (GPU-PROOF-2, RELEASE-8 vocab retirement).
//
// RELEASE-8 is a BREAKING change to the selection vocabulary: `voodoo` is
// removed from `ResolvedBackend` (now `software | webgl2-experimental`); a
// persisted `voodoo` request migrates one-time to `software` with an explicit
// warning, never auto-promoted to webgl2. The §5 frozen contracts
// (Refresh/Framebuffer/RefDef/Entity) are untouched: a GPU backend implements
// GpuRenderer, never Refresh — it must NOT populate a CPU framebuffer or read
// pixels back every frame just to satisfy Refresh.
//
// DOM-free by construction: the GL context is an opaque generic parameter
// (`GpuRenderer<WebGL2RenderingContext>` binds it in @q2/webgl-renderer —
// the only package besides browser integration allowed browser graphics
// types). Nothing here imports `dom` lib types.
import type { RefDef } from './index.js';
import type { Vec3 } from '@q2/math';

/** Experimental GPU backend id. The only GPU value `vid_renderer` accepts. */
export type GpuBackendId = 'webgl2-experimental';

/** Every renderer selection the shell can resolve to. */
export type ResolvedBackend = 'software' | GpuBackendId;

/**
 * Capability/failure report for the experimental GPU backend. Explicit, never
 * silent: `available: false` always carries the blocking reason, and every
 * fallback resolved from it carries a warning string.
 */
export interface GpuCapability {
  backend: GpuBackendId;
  available: boolean;
  /** Human-readable: GL version/driver when available, blocking reason when not. */
  reason: string;
}

/** Selection outcome: a GPU request that cannot be honored stays on CPU WITH a warning. */
export interface ResolvedSelection {
  active: ResolvedBackend;
  /** Null when the request was honored; non-null explains every fallback (never silent). */
  warning: string | null;
}

/**
 * Pure selection resolver: exact `software`/`webgl2-experimental` strings map
 * directly (GPU only when capable); the retired `voodoo` id migrates one-time
 * to `software` with an explicit warning (never auto-promoted to webgl2);
 * anything else — including a GPU request without capability — resolves to
 * `software` with an explicit warning. No silent CPU fallback, no exceptions,
 * no IO.
 */
export function resolveRendererSelection(requested: string, gpu: GpuCapability): ResolvedSelection {
  if (requested === 'software') return { active: 'software', warning: null };
  if (requested === 'voodoo') {
    return {
      active: 'software',
      warning:
        'vid_renderer "voodoo" was retired (RELEASE-8); migrated to software (never auto-promoted to webgl2-experimental)',
    };
  }
  if (requested === 'webgl2-experimental') {
    if (gpu.available) return { active: 'webgl2-experimental', warning: null };
    return {
      active: 'software',
      warning: `webgl2-experimental requested but unavailable (${gpu.reason}); staying on software`,
    };
  }
  return {
    active: 'software',
    warning: `unknown vid_renderer ${JSON.stringify(requested)}; staying on software`,
  };
}

/**
 * Material class for one GPU scene surface. Classification only — sampling/
 * fog/quantization policy lives in GPU-PROOF-4. Mirrors the CPU surface
 * classes (opaque world, SURF_TRANS33/66, SURF_SKY, SURF_WARP) plus the
 * foreground classes the route needs (viewmodel/entities are `alias`).
 */
export type GpuMaterialKind =
  | 'opaque'
  | 'transparent'
  | 'sky'
  | 'turbulent'
  | 'sprite'
  | 'alias'
  | 'beam'
  | 'particle';

/**
 * One visible surface reference for GPU upload. Persistent-triangle input,
 * never CPU-generated scanline/pixel spans: the backend turns these into
 * vertex/index buffers once and reuses them until `staticGeneration` bumps.
 */
export interface GpuSurfaceRef {
  /** Index-stable CPU surface id (MiniWorld surface index). */
  surfaceId: number;
  material: GpuMaterialKind;
  /** Asset handle from the shared registry (WAL texId / skin id); -1 for flat fills. */
  materialHandle: number;
  /** Ordering bit: false draws in the opaque batch, true in the sorted blend pass. */
  transparent: boolean;
  /** Blend-pass sort key, larger = farther (far-to-near draw); ignored by the opaque batch. */
  order: number;
  /** Index into GpuSceneInput.transforms; 0 is identity (world geometry). */
  transformIndex: number;
}

/**
 * Persistent scene input: uploaded once, reused across frames. Static
 * geometry is never rebuilt/re-uploaded per frame; `staticGeneration`
 * bumps only on map change or explicit invalidation.
 */
export interface GpuSceneInput {
  surfaces: GpuSurfaceRef[];
  /** Column-major 4x4 per dynamic transform; index 0 is identity (world geometry). */
  transforms: Float32Array[];
  /** Bumps whenever static geometry must be re-uploaded (map change, invalidation). */
  staticGeneration: number;
}

/** Per-frame GPU submission: view + the persistent scene (no CPU framebuffer). */
export interface GpuFrameInput {
  view: RefDef;
  scene: GpuSceneInput;
  /** Level time in seconds (matches RefDef.time; carried for shader uniforms). */
  time: number;
  /**
   * Dynamic lights for this frame (world-space origin, linear-RGB color,
   * intensity = radius in world units, R_MarkLights falloff spirit). Optional
   * (absent = unlit beyond the baked lightmap) so existing callers keep
   * compiling; the backend clamps to MAX_GPU_LIGHTS (8), first-come wins.
   */
  lights?: GpuLight[];
  /**
   * Underwater eye state (DIVERGENCE from ref_gl, user-requested): when
   * `submerged` is true the WebGL appearance pass applies the fullscreen
   * sine warp (ref_soft D_WarpScreen mirror) before the Voodoo resolve.
   * Optional (absent = dry, no warp) so existing callers keep compiling.
   * The play layer derives this from `driver.underwaterOverlay()?.submerged`
   * (SV_CalcBlend contents + RDF_UNDERWATER rule); the tint itself still
   * rides the 2D overlay (`paintHudOverlay`), so ordering stays warp-then-tint
   * like software (D_WarpScreen, then R_CalcPalette).
   */
  underwater?: { submerged: boolean };
}

/**
 * One GPU dynamic light (GPU-PROOF-3 additive input). Mirrors the
 * sw-renderer DynamicLight shape (origin/intensity/color) in renderer-api
 * vocabulary so backends stay DOM-free. The fragment shader evaluates
 * (radius - dist) / radius per pixel; intensity doubles as the radius.
 */
export interface GpuLight {
  /** World-space origin. */
  origin: Vec3;
  /** Linear-RGB color (already multiplied by any per-light scale). */
  color: Vec3;
  /** Radius in world units (also the brightness falloff range). */
  intensity: number;
}

/** Maximum dynamic lights the GPU backend evaluates per frame (uniform array size). */
export const MAX_GPU_LIGHTS = 8;

/**
 * Lifecycle + submission observability. `framesSubmitted` counts real
 * on-canvas submissions (a clear counts; a no-op or fallback never does).
 * `lastError` is the most recent explicit failure, null when clean.
 */
export interface GpuRendererStatus {
  initialized: boolean;
  width: number;
  height: number;
  contextLost: boolean;
  framesSubmitted: number;
  lastError: string | null;
}

/**
 * Minimal GPU backend boundary. `GL` is opaque here so this package stays
 * DOM-free; the WebGL2 backend binds `GpuRenderer<WebGL2RenderingContext>`.
 * Browser glue owns canvas/context acquisition and forwards context
 * loss/restoration; the backend owns buffers, textures, programs and render
 * targets. Normal rendering never reads pixels back (capture is allowed in
 * tests only, through a backend-specific hook — never this interface).
 */
export interface GpuRenderer<GL = unknown> {
  init(gl: GL, width: number, height: number): void;
  resize(width: number, height: number): void;
  /** Persistent upload: static geometry uploads once per `staticGeneration`. */
  setScene(scene: GpuSceneInput): void;
  /** Submit one frame to the canvas (PROOF-2: context/target proof; scenes land in PROOF-3). */
  renderFrame(input: GpuFrameInput): void;
  dispose(): void;
  getStatus(): GpuRendererStatus;
  /** Browser glue forwards canvas context events here; backend re-creates targets. */
  handleContextLost(): void;
  handleContextRestored(gl: GL): void;
}
