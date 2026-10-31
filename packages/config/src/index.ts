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
  ['vd_dithermode', '4x4', 'ordered-dither write matrix 2x2|4x4, honored live on WebGL (uDitherMode); software has no dither stage'],
  ['vd_reconmode', '2x2sub+2x2box', 'matched scanout: subtract 2x2 dither pattern then 2x2 box with edge rejection; legacy = unconditional box (no subtract)'],
  ['vd_rgbmaxdelta', '8,8,8', 'per-component recon rejection thresholds r,g,b; smooth gradients pass, hard edges stay sharp'],
  ['sw_gamma', 1.0, 'software gamma'],
  ['r_drawworld', 1, 'draw world geometry'],
  ['cl_predict', 1, 'predict local player between 10Hz snapshots'],
  ['cl_interp', 1, 'interpolate remote entities between snapshots'],
  ['s_volume', 1, 'master sound volume 0..1 normalized (1 = quiet reference output gain 0.05; max output never exceeds 0.05)'],
  ['sensitivity', 3, 'mouse sensitivity'],
  ['m_yaw', 0.022, 'mouse yaw scale'],
  ['m_pitch', 0.022, 'mouse pitch scale'],
  ['vid_renderer', 'software', 'active refresh backend: software | webgl2-experimental (experimental, needs WebGL2; incapable falls back to software WITH a warning). Legacy "voodoo" ids migrate to software with an explicit warning (RELEASE-8 retirement; never auto-promoted to webgl2)'],
];

// --- volume scale (RELEASE-1) ---
//
// `s_volume` is a normalized 0..1 control. It maps to an output gain of
// 0..S_VOLUME_REFERENCE_GAIN (0.05): `output = clamp01(normalized) * 0.05`.
// New default 1 therefore equals the old quiet gain 0.05, and the new
// maximum 1 can never exceed old 0.05.
//
// IMPORTANT: apply the 0.05 factor exactly once, at the audio boundary
// (`@q2/sound` mix + browser blip). Never pre-scale `s_volume` and then
// multiply by 0.05 again. Legacy configs that stored old raw gains
// (e.g. 0.8) are treated as normalized values and thus map to
// 0.8*0.05 = 0.04 — quiet by construction. Non-finite/unknown values
// map to 0 (mute, fail-safe).
export const S_VOLUME_REFERENCE_GAIN = 0.05 as const;
/** Normalized `s_volume` default (1 = reference quiet output 0.05). */
export const S_VOLUME_DEFAULT = 1 as const;

/** Clamp a normalized volume to 0..1; non-finite/unknown -> 0. */
export function clampNormalizedVolume(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/** Map a raw `s_volume` value to the actual output gain 0..0.05. Single scale point. */
export function sVolumeToOutputGain(raw: unknown): number {
  return clampNormalizedVolume(raw) * S_VOLUME_REFERENCE_GAIN;
}

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
  features: { workers: boolean; wasmSpans: boolean };
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
      features: { workers: false, wasmSpans: false },
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
// RELEASE-8: the legacy CPU Voodoo execution mode is retired. The `vid_renderer`
// vocabulary is `software | webgl2-experimental` (the `webgl2` rename is deferred
// per plan). Persisted legacy `voodoo` ids migrate one-time to `software` WITH
// an explicit warning — never silently, never auto-promoted to webgl2.
// The default stays 'software' and the GPU backend stays experimental until
// final evidence (GPU-FOLLOW-7) decides otherwise. Canonical selection
// *resolution* lives in `@q2/renderer-api` (`resolveRendererSelection`); the
// declarations below are the config-side cvar vocabulary + human labels for
// that same contract, mirrored BY VALUE so this leaf package never imports
// `@q2/renderer-api` (dependency rule: config is imported by renderer
// consumers, never the reverse).

/** Every renderer id the `vid_renderer` cvar accepts (cvar vocabulary). */
export type VidRendererId = 'software' | 'webgl2-experimental';

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

/** True for an exact known `vid_renderer` value (no coercion, no aliases, no legacy ids). */
export function isKnownRendererId(name: string): name is VidRendererId {
  return name === 'software' || name === 'webgl2-experimental';
}

/** True only for the experimental GPU backend id (never for software). */
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
 * The retired `voodoo` id migrates one-time to software WITH an explicit
 * warning — never silently, never auto-promoted to webgl2-experimental.
 */
export function describeRendererSelection(
  requested: string,
  gpuAvailable: boolean,
  gpuReason = 'no WebGL2 context',
): VidRendererSelection {
  if (requested === 'software') {
    return { requested, active: requested, fallback: false, experimental: false, warning: null };
  }
  if (requested === 'voodoo') {
    return {
      requested,
      active: 'software',
      fallback: true,
      experimental: false,
      warning: 'vid_renderer "voodoo" was retired (RELEASE-8); migrated to software (never auto-promoted to webgl2-experimental)',
    };
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

// --- renderer capability mapping (RELEASE-10) ---
//
// Single table mapping every panel cvar to the renderers that honor it.
// The panel (`apps/web` settings) disables irrelevant controls with the
// `reason` as the tooltip/disabled label, refreshes on switch/fallback/
// restore, and retains saved values for when the renderer supports them.
//
// "Effective renderer" is `software | webgl2-experimental` AFTER fallback
// resolution: a failed-GPU request (`webgl2-experimental` on an incapable
// device) runs the software path, so it counts as `software` here. Use
// `resolveEffectiveRenderer` (thin wrapper over `describeRendererSelection`)
// or pass `describeRendererSelection(...).active` directly.
//
// Audit truth (verified by grepping consumers, 2026-10-31 — corrections to
// the RELEASE-10 card's draft claims are marked CORRECTION):
// - `vd_*` (except `vd_palettetex`): live consumers are ONLY
//   `packages/webgl-renderer/src/appearance.ts` (live uniforms, upload-time
//   `vd_maxtexsize`, target-creation `vd_zbits`) plus `packages/voodoo`
//   policy/test snapshots (pure policy, never live rendering). The software
//   path reads NO `vd_*` cvar (only comments citing the `vd_maxtexsize`
//   value next to fixed `TEX_CAP` constants) → software-unsupported.
// - `vd_dithermode`/`vd_reconmode`/`vd_zbits`/`vd_rgbmaxdelta` are NOT
//   decorative on WebGL: they drive live uniforms (`uDitherMode`,
//   `uReconMode`, `uRgbMaxDelta`) / depth-target creation. The config
//   "read-path/profile/banding-approx" docs describe the CPU `packages/voodoo`
//   helpers, not the GPU path → webgl-supported, software-unsupported.
// - CORRECTION `vd_palettetex`: decorative on BOTH. `appearance.ts` kind is
//   `policy-note`: WebGL always uploads expanded RGB and filtering is
//   identical either way (never gates filtering); software is always indexed.
//   Toggling it changes no pixels on either renderer.
// - `sw_workers`/`sw_wasm`/`sw_accum`: consumed ONLY by `packages/sw-renderer`
//   (`bands.ts`, `wasmSpans.ts`, `frame.ts`) + `apps/web` pool glue. The GPU
//   path never rasterises on the CPU → webgl-unsupported.
// - CORRECTION `sw_gamma`: read NOWHERE. `appearance.ts` lists it as NOT READ
//   (the GPU uses `vd_gamma` for the same role) and `packages/sw-renderer`
//   has zero gamma code (no `getCVar` gamma read anywhere in the package).
//   Decorative on both renderers — retained so saved values survive.
// - CORRECTION `sw_stipplealpha` / `r_translucency`: NOT read on both sides.
//   `packages/sw-renderer/src/spans.ts` `translucencyModeFromCvars` reads both
//   (mode 0 = opaque fallback, 1 = alphamap blend, 2 = screen-door stipple) and
//   `frame.ts` takes pixel effect from it → software-supported. `appearance.ts`
//   lists both as UNSUPPORTED `policy-note`s (the GPU always true-blends; the
//   CPU stipple path has no GPU equivalent) → webgl-unsupported.
// - CORRECTION `r_drawworld`: read NOWHERE live. `appearance.ts` lists it as
//   an UNSUPPORTED `policy-note` (the GPU always draws the submitted world)
//   and `packages/sw-renderer` never reads it. Decorative on both renderers.
// - CORRECTION `r_brightness`: NOT shared. Only `resolveDisplay` in
//   `apps/web/src/play.ts` applies it (`getBrightness` → post-resolve lift);
//   `frameGpuPlay` never calls it and `packages/webgl-renderer` has no
//   brightness code → software-supported, webgl-unsupported.
// - `cl_showfps`/`cl_showpos`: HUD conchars overlays painted post-resolve on
//   both paths (`drawPlayHud` / `paintHudOverlay`) → shared.
// - `skill`/`map_source`/`vid_resolution`/`vid_renderer`: boot/resize/backend
//   selection, renderer-independent → shared.
// - `cl_predict`: `packages/client/src/prediction.ts` (+ host/play) consume it
//   → shared. CORRECTION `cl_interp`: NO consumer outside config + the dom
//   panel (repo-wide grep) → decorative on both (cvar retained, not removed).
// - `s_volume`/`sensitivity`/`m_yaw`/`m_pitch`: audio/input, no renderer
//   gating → shared.

/** Renderer that actually runs a frame (post-fallback). Failed-GPU fallback counts as software. */
export type EffectiveRenderer = 'software' | 'webgl2-experimental';

/** A cvar name in the capability table (open string: unknown names stay shared, never brick the panel). */
export type CVarName = string;

/** Per-renderer support for one cvar + the short human reason for tooltips/disabled labels. */
export interface CVarRendererSupport {
  software: boolean;
  webgl2: boolean;
  reason: string;
}

export const RENDERER_CVAR_SUPPORT: Record<CVarName, CVarRendererSupport> = Object.freeze({
  // --- WebGL-only Voodoo effects (software reads no vd_*) ---
  vd_16bit: { software: false, webgl2: true, reason: 'WebGL-only Voodoo effect: RGB565 quantise at the GPU resolve; the indexed software path never quantises.' },
  vd_dither: { software: false, webgl2: true, reason: 'WebGL-only Voodoo effect: ordered dither at GPU target writes; software has no dither stage.' },
  vd_postfilter: { software: false, webgl2: true, reason: 'WebGL-only Voodoo effect: scanout reconstruction filter; software presents the palette expand directly.' },
  vd_bilinear: { software: false, webgl2: true, reason: 'WebGL-only Voodoo effect: GPU sampler filtering switch; software span sampling ignores it.' },
  vd_mipdither: { software: false, webgl2: true, reason: 'WebGL-only Voodoo effect: single-TMU trilinear pick; software has no mip-dither stage.' },
  vd_fog: { software: false, webgl2: true, reason: 'WebGL-only Voodoo effect: 64-entry table-fog gate; software never reads it.' },
  vd_gamma: { software: false, webgl2: true, reason: 'WebGL-only Voodoo effect: display-stage transfer LUT; software has no gamma stage.' },
  vd_lodbias: { software: false, webgl2: true, reason: 'WebGL-only Voodoo effect: mip LOD bias uniform; software mip selection never reads it.' },
  vd_overbright: { software: false, webgl2: true, reason: 'WebGL-only Voodoo effect: lightmap x2 modulate + clamp; software lighting ignores it.' },
  vd_maxtexsize: { software: false, webgl2: true, reason: 'WebGL-only Voodoo effect: upload cap enforced at GPU upload; software uses fixed caps and ignores it.' },
  vd_zbits: { software: false, webgl2: true, reason: 'WebGL-only Voodoo effect: depth-target precision (16/24-bit); software depth is not cvar-gated.' },
  vd_dithermode: { software: false, webgl2: true, reason: 'WebGL-only Voodoo effect: write-matrix profile (4x4/2x2 live uniform); software has no dither stage.' },
  vd_reconmode: { software: false, webgl2: true, reason: 'WebGL-only Voodoo effect: scanout reconstruction profile (live uniform); software has no reconstruction stage.' },
  vd_rgbmaxdelta: { software: false, webgl2: true, reason: 'WebGL-only Voodoo effect: reconstruction edge-gate thresholds (live uniform); software has no reconstruction stage.' },
  // --- Software-only span/display controls (GPU path never touches the CPU rasteriser) ---
  sw_workers: { software: true, webgl2: false, reason: 'Software-only span control: banded SAB raster threads; the GPU path never rasterises on the CPU.' },
  sw_wasm: { software: true, webgl2: false, reason: 'Software-only span control: WASM spanfill backend; the GPU path has no CPU spanfill.' },
  sw_accum: { software: true, webgl2: false, reason: 'Software-only span control: coalesced pool span-batch kick; the GPU path has no pool kicks.' },
  r_translucency: { software: true, webgl2: false, reason: 'Software-only world control: opaque-fallback vs alphamap blend; the GPU always blends.' },
  sw_stipplealpha: { software: true, webgl2: false, reason: 'Software-only world control: screen-door stipple; the GPU always true-blends.' },
  r_brightness: { software: true, webgl2: false, reason: 'Software-only display lift: applied post-resolve on the software path; the GPU path never applies it.' },
  // --- Decorative on both (retained cvars, no pixel effect anywhere) ---
  sw_gamma: { software: false, webgl2: false, reason: 'No effect on either renderer: nothing reads it (software has no gamma stage; the GPU uses vd_gamma).' },
  r_drawworld: { software: false, webgl2: false, reason: 'No effect on either renderer: neither backend gates world submission on it.' },
  vd_palettetex: { software: false, webgl2: false, reason: 'No effect on either renderer: storage policy only (GPU always expanded RGB, software always indexed; filtering identical).' },
  cl_interp: { software: false, webgl2: false, reason: 'No effect on either renderer: no consumer reads it (entity interpolation never consults it).' },
  // --- Shared (no renderer gating) ---
  vid_renderer: { software: true, webgl2: true, reason: 'Shared backend selector: picks which renderer runs.' },
  vid_resolution: { software: true, webgl2: true, reason: 'Shared setting: framebuffer size resizes in place on both renderers.' },
  skill: { software: true, webgl2: true, reason: 'Shared setting: difficulty latched at boot, renderer-independent.' },
  map_source: { software: true, webgl2: true, reason: 'Shared setting: level source (reboots the level on both renderers).' },
  cl_showfps: { software: true, webgl2: true, reason: 'Shared HUD overlay: fps readout painted on both renderers.' },
  cl_showpos: { software: true, webgl2: true, reason: 'Shared HUD overlay: position readout painted on both renderers.' },
  cl_predict: { software: true, webgl2: true, reason: 'Shared client setting: local-player prediction between snapshots, renderer-independent.' },
  s_volume: { software: true, webgl2: true, reason: 'Shared audio setting: master volume, renderer-independent.' },
  sensitivity: { software: true, webgl2: true, reason: 'Shared input setting: mouse sensitivity, renderer-independent.' },
  m_yaw: { software: true, webgl2: true, reason: 'Shared input setting: mouse yaw scale, renderer-independent.' },
  m_pitch: { software: true, webgl2: true, reason: 'Shared input setting: mouse pitch scale, renderer-independent.' },
});

/** Generic reason for cvars absent from the table (new cvars stay shared — never brick the panel). */
export const UNKNOWN_CVAR_SUPPORT_REASON =
  'Shared setting: applies to every renderer.' as const;

/**
 * Resolve the renderer that actually runs a frame. Failed-GPU fallback
 * (incapable device, unknown id, retired `voodoo`) runs the software path,
 * so it counts as `software` — capability checks must use this, never the
 * raw `vid_renderer` request. Never throws (unknown input falls back to
 * software via `describeRendererSelection`).
 */
export function resolveEffectiveRenderer(requested: string, gpuAvailable: boolean): EffectiveRenderer {
  try {
    return describeRendererSelection(requested, gpuAvailable).active;
  } catch {
    return 'software';
  }
}

/**
 * True when changing `name` can affect pixels on `effectiveRenderer`.
 * Unknown cvars default to supported/shared (never brick the panel on new
 * cvars). Never throws.
 */
export function isCVarSupportedBy(name: string, effectiveRenderer: EffectiveRenderer): boolean {
  try {
    const entry = RENDERER_CVAR_SUPPORT[name];
    if (entry === undefined) return true;
    return effectiveRenderer === 'software' ? entry.software : entry.webgl2;
  } catch {
    return true;
  }
}

/**
 * Short human explanation for the panel tooltip/disabled label.
 * Unknown cvars get a generic shared reason. Never throws, never empty.
 */
export function supportReason(name: string, effectiveRenderer: EffectiveRenderer): string {
  try {
    const entry = RENDERER_CVAR_SUPPORT[name];
    if (entry === undefined) return UNKNOWN_CVAR_SUPPORT_REASON;
    void effectiveRenderer;
    return entry.reason.length > 0 ? entry.reason : UNKNOWN_CVAR_SUPPORT_REASON;
  } catch {
    return UNKNOWN_CVAR_SUPPORT_REASON;
  }
}
// --- feature flags (prime directive: land risky work behind a flag) ---
// Shared identity across ESM/CJS copies via the globalThis store (see above).
export const features: {
  readonly workers: boolean;
  readonly wasmSpans: boolean;
} = shared.features;
export type FeatureName = keyof typeof features;
export function featureEnabled(name: FeatureName): boolean {
  return features[name];
}
