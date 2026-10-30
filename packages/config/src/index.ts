// @q2/config — cvars, feature flags, build-time constants, Com_Error.
// qcommon/ equivalent. See BRAIN.md §5.
export const LUXEL = 16;
export const SERVER_HZ = 10;
export const SERVER_DT = 0.1;
export const MAX_LIGHTSTYLES = 256;

export type ComLevel = 'fatal' | 'error' | 'drop' | 'warn';

export class ComError extends Error {
  level: ComLevel;
  constructor(level: ComLevel, msg: string) {
    super(`[${level}] ${msg}`);
    this.level = level;
  }
}

/** id-style fatal/panic. Never returns for fatal/error. */
export function Com_Error(level: ComLevel, msg: string): never {
  throw new ComError(level, msg);
}

export function Com_Warn(msg: string): void {
  console.warn(`[warn] ${msg}`);
}

export function Com_Printf(msg: string): void {
  console.log(msg);
}

// --- cvars (Voodoo fidelity switches, BRAIN.md §7.2, plus client/sound/input) ---
export interface CVarDef {
  name: string;
  value: number | string | boolean;
  doc: string;
}

export type CVarValue = number | string | boolean;

const DEFAULT_CVARS: ReadonlyArray<[string, CVarValue, string]> = [
  ['vd_16bit', 1, 'RGB565 target quantise on; off = RGB888 debug bypass (gamma on, dither/recon off)'],
  ['vd_dither', 1, '4x4 ordered dither at target writes; independent of mip dithering'],
  ['vd_postfilter', 1, 'scanout reconstruction on output; off still displays current target (no stale)'],
  ['vd_bilinear', 1, 'texture filtering in paletted or expanded storage (independent of vd_palettetex)'],
  ['vd_mipdither', 1, 'single-TMU trilinear approx: per-pixel LOD n/n+1 pick; avg +0.375 needs bias comp'],
  ['vd_lodbias', -0.35, 'added to log2(rho) (tLOD.lodbias convention); negative favours finer'],
  ['vd_fog', 1, 'capability gate for 64-entry table fog; scene contribution zero unless enabled'],
  ['vd_gamma', 1.3, 'display-stage transfer LUT after reconstruction (RAMDAC placement); preset 1.3, not a hw constant'],
  ['vd_maxtexsize', 256, 'upload cap: resample texels preserving aspect (dims helper only; real resample pending)'],
  ['vd_zbits', 16, 'depth precision at test/write (16 = hw profile); frame helper is banding-only approx'],
  ['vd_palettetex', 1, 'texture storage/upload policy (paletted vs expanded); does not gate filtering'],
  ['vd_overbright', 1, 'compat policy: lightmap modulate x2 + clamp (blanket boost; gl_image audit pending)'],
  ['vd_dithermode', '4x4', 'profile data (read-path only): ordered-dither matrix 2x2|4x4; current approx is 4x4'],
  ['vd_reconmode', '2x2sub+2x2box', 'matched scanout: subtract 2x2 dither pattern then 2x2 box with edge rejection; legacy = unconditional box (no subtract)'],
  ['vd_rgbmaxdelta', '8,8,8', 'per-component recon rejection thresholds r,g,b; smooth gradients pass, hard edges stay sharp'],
  ['sw_gamma', 1.0, 'software gamma'],
  ['r_drawworld', 1, 'draw world geometry'],
  ['cl_predict', 1, 'predict local player between 10Hz snapshots'],
  ['cl_interp', 1, 'interpolate remote entities between snapshots'],
  ['s_volume', 0.8, 'master sound volume 0..1'],
  ['sensitivity', 3, 'mouse sensitivity'],
  ['m_yaw', 0.022, 'mouse yaw scale'],
  ['m_pitch', 0.022, 'mouse pitch scale'],
  ['vid_renderer', 'software', 'active refresh backend: software | voodoo | webgl2-experimental (experimental, needs WebGL2; incapable Falls back to software WITH a warning)'],
];

// --- shared store (ESM/CJS unification) ---
//
// `@q2/config` ships dual-format dist (`dist/index.mjs` for `import`,
// `dist/index.js` for `require`). Without this, each module universe gets
// its own module-level `Map`: a cvar set via ESM is invisible via CJS and
// vice versa (renderer selection, worker cvars, and the vd_* scanout
// profile would silently disagree between the bench/host path and the
// renderer path in the same process).
//
// The single source of truth is therefore kept on `globalThis` under
// `__q2_config_store__`, so every ESM/CJS copy of this module in the SAME
// runtime observes the same configuration state. Separate runtimes
// (workers, forked processes, Vitest per-file isolates) each have their
// own `globalThis`, so intentional isolation between them is preserved.
// Browsers share one `globalThis` per page, which is the desired behavior.
//
// Invariants:
// - The store is seeded with defaults exactly once, when it is created.
//   Later module evaluations reuse it WITHOUT re-seeding, so a second
//   universe loading this module never wipes live state.
// - `resetCVars()` still restores compiled-in defaults (used by tests to
//   isolate cases within one runtime).
// - `features` is the same object identity in every universe, so flag
//   reads can never disagree within a runtime (it is only ever read via
//   `featureEnabled`, never reassigned).
interface Q2ConfigSharedState {
  values: Map<string, CVarValue>;
  docs: Map<string, string>;
  features: { workers: boolean; wasmSpans: boolean; voodoo: boolean };
}

declare global {
  // Per-runtime singleton; `undefined` until the first `@q2/config` copy
  // (ESM or CJS) initialises it.
  var __q2_config_store__: Q2ConfigSharedState | undefined;
}

function sharedState(): Q2ConfigSharedState {
  let state = globalThis.__q2_config_store__;
  if (state === undefined) {
    state = {
      values: new Map<string, CVarValue>(),
      docs: new Map<string, string>(),
      features: { workers: false, wasmSpans: false, voodoo: true },
    };
    for (const [name, value, doc] of DEFAULT_CVARS) {
      state.values.set(name, value);
      state.docs.set(name, doc);
    }
    globalThis.__q2_config_store__ = state;
  }
  return state;
}

const shared = sharedState();
const cvars: Map<string, CVarValue> = shared.values;
const cvarDocs: Map<string, string> = shared.docs;

function loadDefaults(): void {
  cvars.clear();
  cvarDocs.clear();
  for (const [name, value, doc] of DEFAULT_CVARS) {
    cvars.set(name, value);
    cvarDocs.set(name, doc);
  }
}

/** Restore all cvars to compiled-in defaults (used by tests). */
export function resetCVars(): void {
  loadDefaults();
}

/** Register a new cvar if absent; returns the current value. */
export function registerCVar(name: string, value: CVarValue, doc = ''): CVarValue {
  if (!cvars.has(name)) {
    cvars.set(name, value);
    cvarDocs.set(name, doc);
  }
  return cvars.get(name) as CVarValue;
}

export function getCVar(name: string): CVarValue | undefined {
  return cvars.get(name);
}

export function getCVarNumber(name: string): number {
  return Number(cvars.get(name) ?? 0);
}

export function getCVarString(name: string): string {
  return String(cvars.get(name) ?? '');
}

export function getCVarBool(name: string): boolean {
  const v = cvars.get(name);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return v === '1' || v === 'true';
}

export function setCVar(name: string, value: number | string | boolean): void {
  cvars.set(name, value);
}

/** Set a cvar from console text, coercing numbers/booleans. Creates it if unknown. */
export function setCVarFromString(name: string, text: string): CVarValue {
  const t = text.trim();
  let value: CVarValue = t;
  if (/^(true|false)$/i.test(t)) value = t.toLowerCase() === 'true';
  else if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) value = Number(t);
  cvars.set(name, value);
  return value;
}

export function listCVars(): CVarDef[] {
  return [...cvars.entries()].map(([name, value]) => ({ name, value, doc: cvarDocs.get(name) ?? '' }));
}

// --- vid_renderer selection states + unsupported-device fallback labels ---
//
// GPU-FOLLOW-4, additive/label-only: the default stays 'software' and the GPU
// backend stays experimental until final evidence (GPU-FOLLOW-7) decides
// otherwise. Canonical selection *resolution* lives in `@q2/renderer-api`
// (`resolveRendererSelection`); the declarations below are the config-side
// cvar vocabulary + human labels for that same contract, mirrored BY VALUE
// so this leaf package never imports `@q2/renderer-api` (dependency rule:
// config is imported by renderer consumers, never the reverse).

/** Every renderer id the `vid_renderer` cvar accepts (cvar vocabulary). */
export type VidRendererId = 'software' | 'voodoo' | 'webgl2-experimental';

/** Compiled-in `vid_renderer` default: software. Never promoted by this module. */
export const VID_RENDERER_DEFAULT: VidRendererId = 'software';

/** The only GPU backend id (experimental until final FOLLOW-7 evidence). */
export const GPU_EXPERIMENTAL_BACKEND: VidRendererId = 'webgl2-experimental';

/**
 * GPU-experimental pin: true while the WebGL2 backend is pre-acceptance.
 * GPU-FOLLOW-7 flips this only with all gates evidenced; nothing here
 * changes selection behavior (label + gate only).
 */
export const GPU_EXPERIMENTAL = true as const;

/** True for an exact known `vid_renderer` value (no coercion, no aliases). */
export function isKnownRendererId(name: string): name is VidRendererId {
  return name === 'software' || name === 'voodoo' || name === 'webgl2-experimental';
}

/** True only for the experimental GPU backend id (never for software/voodoo). */
export function isExperimentalRenderer(name: string): boolean {
  return name === GPU_EXPERIMENTAL_BACKEND;
}

/**
 * Labelled selection outcome: mirrors the `resolveRendererSelection`
 * vocabulary in `@q2/renderer-api` BY VALUE (same honored/fallback mapping).
 * Pure, additive, no behavior change: unknown ids and incapable-GPU requests
 * resolve to software WITH a warning (never a silent CPU fallback).
 */
export interface VidRendererSelection {
  /** Raw `vid_renderer` request as written. */
  requested: string;
  /** Backend that actually runs. */
  active: VidRendererId;
  /** True whenever the request was not honored (every fallback warns). */
  fallback: boolean;
  /** True only when the ACTIVE backend is the experimental GPU one. */
  experimental: boolean;
  /** Null when honored; non-null explains every fallback (never silent). */
  warning: string | null;
}

/**
 * Describe a `vid_renderer` request against GPU capability. Capability false
 * always carries the blocking reason into the warning. GPU honored only when
 * capable; everything unhonorable stays on software with a warning.
 */
export function describeRendererSelection(
  requested: string,
  gpuAvailable: boolean,
  gpuReason = 'no WebGL2 context',
): VidRendererSelection {
  if (requested === 'software' || requested === 'voodoo') {
    return { requested, active: requested, fallback: false, experimental: false, warning: null };
  }
  if (requested === GPU_EXPERIMENTAL_BACKEND) {
    if (gpuAvailable) {
      return { requested, active: requested, fallback: false, experimental: true, warning: null };
    }
    return {
      requested,
      active: 'software',
      fallback: true,
      experimental: false,
      warning: `webgl2-experimental requested but unavailable (${gpuReason}); staying on software`,
    };
  }
  return {
    requested,
    active: 'software',
    fallback: true,
    experimental: false,
    warning: `unknown vid_renderer ${JSON.stringify(requested)}; staying on software`,
  };
}

/** The fallback warning for a selection (null when the request was honored). */
export function rendererFallbackWarning(sel: VidRendererSelection): string | null {
  return sel.fallback ? sel.warning : null;
}

/**
 * One-line human label for logs/overlays, e.g.
 * `vid_renderer="webgl2-experimental" -> software (FALLBACK: <reason>)`.
 * Experimental activity is tagged `[EXPERIMENTAL]`; fallback is always
 * explicit, never a silent rename.
 */
export function rendererSelectionLabel(sel: VidRendererSelection): string {
  const exp = sel.experimental ? ' [EXPERIMENTAL]' : '';
  if (!sel.fallback) return `vid_renderer=${JSON.stringify(sel.requested)} -> ${sel.active}${exp}`;
  return (
    `vid_renderer=${JSON.stringify(sel.requested)} -> ${sel.active} (FALLBACK${exp}: ${sel.warning ?? 'unexplained'})`
  );
}

// --- feature flags (prime directive: land risky work behind a flag) ---
// Shared identity across ESM/CJS copies via the globalThis store (see above).
export const features: {
  readonly workers: boolean;
  readonly wasmSpans: boolean;
  readonly voodoo: boolean;
} = shared.features;
export type FeatureName = keyof typeof features;
export function featureEnabled(name: FeatureName): boolean {
  return features[name];
}
