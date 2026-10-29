// @q2/renderer-api — GPU scene/backend boundary (GPU-PROOF-2).
//
// Additive only: the §5 frozen contracts (Refresh/Framebuffer/RefDef/Entity)
// are untouched. A GPU backend implements GpuRenderer, never Refresh: it
// must NOT populate a CPU framebuffer or read pixels back every frame just
// to satisfy Refresh.
//
// DOM-free by construction: the GL context is an opaque generic parameter
// (`GpuRenderer<WebGL2RenderingContext>` binds it in @q2/webgl-renderer —
// the only package besides browser integration allowed browser graphics
// types). Nothing here imports `dom` lib types.
import type { RefDef } from './index.js';

/** Experimental GPU backend id. The only GPU value `vid_renderer` accepts. */
export type GpuBackendId = 'webgl2-experimental';

/** Every renderer selection the shell can resolve to. */
export type ResolvedBackend = 'software' | 'voodoo' | GpuBackendId;

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
 * Pure selection resolver: exact `software`/`voodoo`/`webgl2-experimental`
 * strings map directly (GPU only when capable); anything else — including a
 * GPU request without capability — resolves to `software` with an explicit
 * warning. No silent CPU fallback, no exceptions, no IO.
 */
export function resolveRendererSelection(requested: string, gpu: GpuCapability): ResolvedSelection {
  if (requested === 'software') return { active: 'software', warning: null };
  if (requested === 'voodoo') return { active: 'voodoo', warning: null };
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
}

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
