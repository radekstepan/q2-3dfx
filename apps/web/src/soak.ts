// q2ts-web soak hook (GPU-PROOF-5, measurement only).
//
// URL-param autoboot for the headless browser soak: `?q2pak=<url>&q2renderer=<id>&q2soak=1`
// fetches pak bytes, boots base1 at 640x480 through the REAL production loop
// (`bootPlay` + `startPlayLoop`), and publishes extended per-frame observability
// (`window.__q2soak` status + `window.__q2soakFrames` rAF timestamp ring).
//
// Normal boot is untouched: this module runs ONLY when `q2soak=1` is present
// (see the index.ts auto-boot branch). Scripted movement/combat intervals are
// driven from CDP key events by the bench runner, never from page code — the
// page only exposes state readers (`__q2soakState`, `__q2soakCvars`) so the
// runner can verify inputs took effect. No renderer/backend/policy changes.
import { getCVarString, setCVarFromString } from '@q2/config';
import { startPlayLoop } from './dom.js';
import type { PlayBoot } from './play.js';
import { bootPlay, getGpuStatus, playerPosText } from './play.js';
import { ingestPak } from './pak.js';

/** Soak framebuffer geometry (GPU-PROOF-1 gate resolution, both legs). */
export const SOAK_WIDTH = 640;
export const SOAK_HEIGHT = 480;

/** Renderer ids accepted by the soak hook (mirrors the vid_renderer domain). */
export const SOAK_RENDERERS = ['software', 'voodoo', 'webgl2-experimental'] as const;

/** Soak renderer request (validated against SOAK_RENDERERS). */
export type SoakRenderer = (typeof SOAK_RENDERERS)[number];

/** Parsed soak query params (null = no soak requested / invalid → normal boot). */
export interface SoakParams {
  /** Absolute URL the page fetches raw pak bytes from. */
  pakUrl: string;
  /** Requested renderer backend. */
  renderer: SoakRenderer;
  /** Extra cvar overrides (`q2cvars=a:1,b:x`) applied before boot. */
  cvars: Record<string, string>;
}

/** Cvar-name allowlist shape for overrides (letters/digits/underscore, leading letter). */
const CVAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse `key:value;key:value` cvar overrides (pairs split on `;` because
 * values like `vd_rgbmaxdelta` contain commas). Malformed pairs are skipped
 * (never throw on harness input); names must match CVAR_NAME_RE.
 */
export function parseCvarOverrides(raw: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!CVAR_NAME_RE.test(name) || value.length === 0) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Parse the soak query params from a location.search string. Returns null
 * when `q2soak=1` is absent, `q2pak` is missing, or the renderer is unknown —
 * every case means "run the normal boot".
 */
export function parseSoakParams(search: string): SoakParams | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  if (params.get('q2soak') !== '1') return null;
  const pakUrl = (params.get('q2pak') ?? '').trim();
  if (pakUrl.length === 0) return null;
  const rawRenderer = (params.get('q2renderer') ?? 'software').trim();
  if (!(SOAK_RENDERERS as readonly string[]).includes(rawRenderer)) return null;
  return {
    pakUrl,
    renderer: rawRenderer as SoakRenderer,
    cvars: parseCvarOverrides(params.get('q2cvars')),
  };
}

/** Live soak status published to `window.__q2soak` (runner-owned observability). */
export interface SoakStatus {
  soak: true;
  booted: boolean;
  requestedRenderer: string;
  actualRenderer: string;
  warning: string | null;
  width: number;
  height: number;
  /** UNMASKED_RENDERER_WEBGL string (null when WebGL2 is unavailable). */
  glRenderer: string | null;
  /** Fatal boot error (null on a healthy boot). */
  error: string | null;
  /** performance.now() at status install (ms). */
  t0: number;
}

/** Point-in-time soak debug snapshot for input verification (runner polls). */
export interface SoakState {
  frame: number;
  fps: number;
  keys: string[];
  buttons: number;
  yawDeg: number;
  pos: string | null;
  gpuActive: boolean;
  renderer: string;
  warning: string | null;
  glRenderer: string | null;
  /**
   * GPU proof-of-submission (GPU-PROOF-5 routing pin): real on-canvas
   * submissions + persistent uploads, null when no GPU backend is attached.
   * The runner asserts these ADVANCE per interval — a live GPU leg that never
   * submits (e.g. the pooled CPU path shadowing frameGpuPlay) fails closed
   * here instead of reporting CPU numbers as GPU success.
   */
  framesSubmitted: number | null;
  uploads: number | null;
}

/** Cap for the `__q2soakFrames` rAF timestamp ring (oldest slice evicted past it). */
export const SOAK_FRAME_RING_CAP = 120000;

/** Probe the UNMASKED_RENDERER_WEBGL string (null when unavailable; never throws). */
export function probeGlRenderer(): string | null {
  try {
    const g = globalThis as unknown as {
      document?: { createElement?: (tag: string) => unknown };
    };
    const doc = typeof document !== 'undefined' ? document : g.document;
    if (!doc || typeof doc.createElement !== 'function') return null;
    const canvas = doc.createElement('canvas') as {
      getContext?: (kind: string) => unknown;
    };
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    const gl = canvas.getContext('webgl2') as {
      getExtension?: (name: string) => unknown;
      getParameter?: (p: number) => unknown;
    } | null;
    if (!gl || typeof gl.getExtension !== 'function' || typeof gl.getParameter !== 'function') return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info') as {
      UNMASKED_RENDERER_WEBGL?: number;
    } | null;
    if (!ext || typeof ext.UNMASKED_RENDERER_WEBGL !== 'number') return null;
    const s = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    return typeof s === 'string' && s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

/**
 * Apply soak cvars BEFORE boot: pin 640x480 + the requested renderer, then
 * the runner-supplied `vd_*`/`sw_*` overrides. Unknown cvars are skipped
 * (recorded in the returned list, never a boot failure).
 */
export function applySoakCvars(params: SoakParams): { applied: string[]; skipped: string[] } {
  const applied: string[] = [];
  const skipped: string[] = [];
  const set = (name: string, value: string): void => {
    try {
      setCVarFromString(name, value);
      applied.push(name);
    } catch {
      skipped.push(name);
    }
  };
  set('vid_resolution', `${SOAK_WIDTH}x${SOAK_HEIGHT}`);
  set('vid_renderer', params.renderer);
  for (const [name, value] of Object.entries(params.cvars)) set(name, value);
  return applied.length > 0 ? { applied, skipped } : { applied, skipped };
}

/** Read back a cvar snapshot (runner records the effective fidelity profile). */
export function readSoakCvarSnapshot(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    try {
      out[name] = getCVarString(name);
    } catch {
      out[name] = '<unreadable>';
    }
  }
  return out;
}

/** Cvar names the runner pins + reads back (GPU-PROOF-1 fidelity profile keys). */
export const SOAK_CVAR_SNAPSHOT_KEYS = [
  'vid_renderer',
  'vid_resolution',
  'sw_workers',
  'sw_accum',
  'vd_gamma',
  'vd_dither',
  'vd_16bit',
  'vd_postfilter',
  'vd_bilinear',
  'vd_mipdither',
  'vd_lodbias',
  'vd_fog',
  'vd_overbright',
  'vd_palettetex',
  'vd_maxtexsize',
  'vd_zbits',
  'vd_dithermode',
  'vd_reconmode',
  'vd_rgbmaxdelta',
];

/**
 * Build the initial (pre-boot) soak status record. Pure: the boot path fills
 * in the live fields afterwards.
 */
export function collectSoakStatus(params: SoakParams, glRenderer: string | null, nowMs: number): SoakStatus {
  return {
    soak: true,
    booted: false,
    requestedRenderer: params.renderer,
    actualRenderer: params.renderer,
    warning: null,
    width: SOAK_WIDTH,
    height: SOAK_HEIGHT,
    glRenderer,
    error: null,
    t0: nowMs,
  };
}

declare global {
  interface Window {
    __q2soak?: SoakStatus;
    __q2soakFrames?: number[];
    __q2soakState?: () => SoakState;
    __q2soakCvars?: () => Record<string, string>;
  }
}

/** The live boot behind the soak readers (module-scoped, soak-mode only). */
let soakBoot: PlayBoot | null = null;

/** Read the live soak state (input echo + renderer proof for the runner). */
function readSoakState(status: SoakStatus): SoakState {
  const g = globalThis as unknown as {
    __q2stats?: { frame?: unknown; fps?: unknown };
  };
  const stats = g.__q2stats;
  const frame = typeof stats?.frame === 'number' ? stats.frame : 0;
  const fps = typeof stats?.fps === 'number' ? stats.fps : 0;
  const boot = soakBoot;
  let keys: string[] = [];
  let buttons = 0;
  let yawDeg = 0;
  let pos: string | null = null;
  let gpuActive = false;
  let renderer = status.actualRenderer;
  let warning = status.warning;
  let framesSubmitted: number | null = null;
  let uploads: number | null = null;
  if (boot) {
    try {
      keys = [...boot.host.input.keys];
    } catch {
      keys = [];
    }
    try {
      buttons = boot.host.input.buttons | 0;
    } catch {
      buttons = 0;
    }
    try {
      yawDeg = boot.host.input.angles[1] ?? 0;
    } catch {
      yawDeg = 0;
    }
    try {
      pos = playerPosText(boot.driver);
    } catch {
      pos = null;
    }
    try {
      gpuActive = boot.gpu !== null;
      renderer = boot.renderer;
      warning = boot.lastRendererWarning;
      if (boot.gpu) {
        framesSubmitted = boot.gpu.gpu.getStatus().framesSubmitted;
        uploads = boot.gpu.gpu.testUploadStats().uploads;
      }
    } catch {
      /* keep status fallbacks */
    }
  }
  return {
    frame, fps, keys, buttons, yawDeg, pos, gpuActive, renderer, warning,
    glRenderer: status.glRenderer, framesSubmitted, uploads,
  };
}

/** Now-ms (performance.now when available, Date.now fallback; never throws). */
function nowMs(): number {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch {
    /* fallback below */
  }
  return Date.now();
}

/**
 * Run the soak boot: fetch pak bytes, boot base1 at 640x480 through the
 * production loop, and install the `__q2soak*` observability. Errors are
 * recorded on the status (never thrown past the auto-boot caller).
 */
export async function runSoakBoot(params: SoakParams): Promise<void> {
  const w = globalThis as unknown as { window?: Window };
  const win = typeof window !== 'undefined' ? window : w.window;
  const status = collectSoakStatus(params, probeGlRenderer(), nowMs());
  try {
    if (win) win.__q2soak = status;
  } catch {
    /* headless without window: status stays local */
  }
  try {
    applySoakCvars(params);
    let bytes: ArrayBuffer;
    try {
      const res = await fetch(params.pakUrl);
      if (!res.ok) throw new Error(`pak fetch HTTP ${res.status}`);
      bytes = await res.arrayBuffer();
    } catch (e) {
      throw new Error(`pak fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const pak = ingestPak(bytes);
    const boot = bootPlay({ width: SOAK_WIDTH, height: SOAK_HEIGHT, renderer: params.renderer, pak });
    soakBoot = boot;
    const gpuStatus = getGpuStatus(boot);
    status.actualRenderer = gpuStatus.active;
    status.warning = gpuStatus.warning;
    const doc = typeof document !== 'undefined' ? document : null;
    const canvas = doc?.querySelector?.('#q2') ?? null;
    if (canvas) {
      startPlayLoop(canvas, boot, { pak });
    } else {
      status.error = 'no #q2 canvas for the soak loop';
      return;
    }
    status.booted = true;
    // rAF timestamp ring: the runner slices index ranges per interval to
    // derive per-frame intervals (p50/p95/p99, cadence, dropped beats).
    const frames: number[] = [];
    try {
      if (win) win.__q2soakFrames = frames;
    } catch {
      /* reader-only fallback below */
    }
    const tick = (): void => {
      try {
        frames.push(nowMs());
        if (frames.length > SOAK_FRAME_RING_CAP) frames.splice(0, frames.length - SOAK_FRAME_RING_CAP);
      } catch {
        /* a sampler fault must never break the game loop */
      }
      try {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
      } catch {
        /* loop ends without DOM rAF */
      }
    };
    try {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
    } catch {
      /* sampler unavailable headless without rAF */
    }
    try {
      if (win) {
        win.__q2soakState = () => readSoakState(status);
        win.__q2soakCvars = () => readSoakCvarSnapshot(SOAK_CVAR_SNAPSHOT_KEYS);
      }
    } catch {
      /* readers best-effort */
    }
  } catch (e) {
    status.error = e instanceof Error ? e.message : String(e);
    try {
      if (win) win.__q2soak = status;
    } catch {
      /* ignore */
    }
  }
}
