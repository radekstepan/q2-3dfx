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

// --- cvars (Voodoo fidelity switches, BRAIN.md §7.2) ---
export interface CVarDef {
  name: string;
  value: number | string | boolean;
  doc: string;
}

const cvars = new Map<string, number | string | boolean>([
  ['vd_16bit', 1],
  ['vd_dither', 1],
  ['vd_postfilter', 1],
  ['vd_bilinear', 1],
  ['vd_mipdither', 1],
  ['vd_lodbias', -0.35],
  ['vd_fog', 1],
  ['vd_gamma', 1.3],
  ['vd_maxtexsize', 256],
  ['vd_zbits', 16],
  ['vd_palettetex', 1],
  ['vd_overbright', 1],
  ['sw_gamma', 1.0],
  ['r_drawworld', 1],
  ['cl_predict', 1],
]);

export function getCVarNumber(name: string): number {
  return Number(cvars.get(name) ?? 0);
}

export function getCVarString(name: string): string {
  return String(cvars.get(name) ?? '');
}

export function setCVar(name: string, value: number | string | boolean): void {
  cvars.set(name, value);
}

export function listCVars(): CVarDef[] {
  return [...cvars.entries()].map(([name, value]) => ({ name, value, doc: '' }));
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
