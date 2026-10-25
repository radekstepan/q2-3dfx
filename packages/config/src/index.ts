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
  ['vd_16bit', 1, 'quantise 8:8:8 to RGB565 at resolve'],
  ['vd_dither', 1, '4x4 ordered dither before quantise'],
  ['vd_postfilter', 1, '2x2 "22-bit" RAMDAC post filter'],
  ['vd_bilinear', 1, 'bilinear filtering'],
  ['vd_mipdither', 1, 'single-TMU trilinear via mip dithering'],
  ['vd_lodbias', -0.35, 'Glide LOD bias'],
  ['vd_fog', 1, '64-entry table fog'],
  ['vd_gamma', 1.3, 'Glide gamma lift'],
  ['vd_maxtexsize', 256, '256x256 texture cap'],
  ['vd_zbits', 16, '16-bit depth buffer'],
  ['vd_palettetex', 1, '8-bit palettised textures'],
  ['vd_overbright', 1, 'lightmap modulate x2 with clamp'],
  ['sw_gamma', 1.0, 'software gamma'],
  ['r_drawworld', 1, 'draw world geometry'],
  ['cl_predict', 1, 'predict local player between 10Hz snapshots'],
  ['cl_interp', 1, 'interpolate remote entities between snapshots'],
  ['s_volume', 0.8, 'master sound volume 0..1'],
  ['sensitivity', 3, 'mouse sensitivity'],
  ['m_yaw', 0.022, 'mouse yaw scale'],
  ['m_pitch', 0.022, 'mouse pitch scale'],
  ['vid_renderer', 'software', 'active refresh backend: software | voodoo'],
];

const cvars = new Map<string, CVarValue>();
const cvarDocs = new Map<string, string>();

function loadDefaults(): void {
  cvars.clear();
  cvarDocs.clear();
  for (const [name, value, doc] of DEFAULT_CVARS) {
    cvars.set(name, value);
    cvarDocs.set(name, doc);
  }
}

loadDefaults();

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

// --- feature flags (prime directive: land risky work behind a flag) ---
export const features = {
  workers: false,
  wasmSpans: false,
  voodoo: true,
} as const;
export type FeatureName = keyof typeof features;
export function featureEnabled(name: FeatureName): boolean {
  return features[name];
}
