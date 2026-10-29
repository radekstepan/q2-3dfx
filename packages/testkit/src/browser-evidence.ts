// @q2/testkit — browser-vs-Node evidence distinction (PERF-NEXT-1, testkit lane).
//
// Node evidence (frameMs, hashes, kick journals) and browser evidence
// (presented FPS, compositor behavior) must be recorded SEPARATELY and never
// compared as if they were the same metric: Node frameMs is
// production-frame-no-present (no rAF, no present, no HUD), while browser
// presented-FPS includes simulation, HUD, rAF cadence and compositing. This
// module provides the shared shapes so browser results (e.g. a
// `window.__q2stats`-shaped object: pooled/staged/kicks/inline, fallbacks,
// presented-fps, compositor info) can be recorded alongside Node evidence
// with the compositing condition attached.
//
// No DOM dependency: every probe goes through globalThis casts, so importing
// this module in Node, workers or the browser bundle is side-effect free.

/**
 * Compositing condition a browser result was recorded under. Software or
 * headless compositing (SwiftShader, headless Chromium) behaves nothing
 * like a hardware-backed page — the ledger must say which one a row is.
 */
export type CompositingKind =
  | 'node'
  | 'software-headless'
  | 'hardware-backed'
  | 'unknown';

/**
 * Browser frame stats in the `window.__q2stats` shape the web shell
 * publishes: pooled execution, staged/kicked/inline batches, fallbacks,
 * presented-frame cadence and compositor info. Every field is optional —
 * the validator accepts partial reports and the recorder marks absent
 * fields unknown rather than inventing them.
 */
export interface BrowserFrameStats {
  pooled?: boolean;
  stagedBatches?: number;
  inlineBatches?: number;
  kicks?: number;
  workerSpansCompleted?: number;
  workerPixelsCompleted?: number;
  mainSpansCompleted?: number;
  mainPixelsCompleted?: number;
  replayedSpans?: number;
  replayedPixels?: number;
  fallbacks?: number;
  presentedFps?: number | null;
  droppedFrames?: number;
  compositor?: string;
}

const NUMERIC_KEYS: Array<keyof BrowserFrameStats> = [
  'stagedBatches', 'inlineBatches', 'kicks',
  'workerSpansCompleted', 'workerPixelsCompleted',
  'mainSpansCompleted', 'mainPixelsCompleted',
  'replayedSpans', 'replayedPixels',
  'fallbacks', 'droppedFrames',
];

/**
 * Structural validator for browser stats payloads (window.__q2stats-shaped).
 * True only for plain objects whose present fields have the right types;
 * unknown-extra fields are ignored. Never throws.
 */
export function isBrowserFrameStats(u: unknown): u is BrowserFrameStats {
  if (typeof u !== 'object' || u === null || Array.isArray(u)) return false;
  const r = u as Record<string, unknown>;
  for (const k of NUMERIC_KEYS) {
    const v = r[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return false;
  }
  if (r['pooled'] !== undefined && typeof r['pooled'] !== 'boolean') return false;
  const pf = r['presentedFps'];
  if (pf !== undefined && pf !== null && (typeof pf !== 'number' || !Number.isFinite(pf) || pf < 0)) return false;
  if (r['compositor'] !== undefined && typeof r['compositor'] !== 'string') return false;
  return true;
}

/** Browser run evidence: stats + the condition they were recorded under. */
export interface BrowserRunEvidence {
  runtime: 'node' | 'browser';
  compositing: CompositingKind;
  userAgent: string | null;
  hardwareConcurrency: number | null;
  devicePixelRatio: number | null;
  presentedFpsMed: number | null;
  stats: BrowserFrameStats | null;
  note: string;
}

/**
 * Describe the current runtime without DOM types: 'browser' when a window
 * object exists, else 'node'. Compositing is 'node' under Node and
 * 'unknown' in a browser unless the caller states otherwise (only the page
 * knows whether it composites in software or on hardware).
 */
export function describeRuntime(): { runtime: 'node' | 'browser'; compositing: CompositingKind } {
  try {
    const g = globalThis as unknown as Record<string, unknown>;
    if (typeof g['window'] !== 'undefined') return { runtime: 'browser', compositing: 'unknown' };
  } catch {
    /* no globalThis access — assume Node */
  }
  return { runtime: 'node', compositing: 'node' };
}

/** Best-effort browser facts (all null outside a browser; never throws). */
export function browserFacts(): {
  userAgent: string | null;
  hardwareConcurrency: number | null;
  devicePixelRatio: number | null;
} {
  const out = { userAgent: null as string | null, hardwareConcurrency: null as number | null, devicePixelRatio: null as number | null };
  try {
    const g = globalThis as unknown as Record<string, unknown>;
    const nav = g['navigator'] as Record<string, unknown> | undefined;
    if (nav && typeof nav['userAgent'] === 'string') out.userAgent = nav['userAgent'] as string;
    if (nav && typeof nav['hardwareConcurrency'] === 'number') {
      out.hardwareConcurrency = nav['hardwareConcurrency'] as number;
    }
    if (typeof g['devicePixelRatio'] === 'number') out.devicePixelRatio = g['devicePixelRatio'] as number;
  } catch {
    /* stay null */
  }
  return out;
}

/**
 * Coerce an unknown payload (e.g. window.__q2stats) into recorded browser
 * evidence with an explicit compositing condition. Returns null when the
 * payload is not stats-shaped (recorded as absent, never invented).
 */
export function coerceBrowserEvidence(
  payload: unknown,
  compositing: CompositingKind,
  note = '',
): BrowserRunEvidence | null {
  if (!isBrowserFrameStats(payload)) return null;
  const { runtime } = describeRuntime();
  const facts = browserFacts();
  return {
    runtime,
    compositing,
    userAgent: facts.userAgent,
    hardwareConcurrency: facts.hardwareConcurrency,
    devicePixelRatio: facts.devicePixelRatio,
    presentedFpsMed: typeof payload.presentedFps === 'number' ? payload.presentedFps : null,
    stats: { ...payload },
    note,
  };
}

/** One-line rendering of browser evidence (for logs next to Node rows). */
export function formatBrowserEvidence(e: BrowserRunEvidence): string {
  const s = e.stats;
  const exec = s
    ? `pooled=${s.pooled ?? '?'} staged=${s.stagedBatches ?? '?'} kicks=${s.kicks ?? '?'} inline=${s.inlineBatches ?? '?'} fb=${s.fallbacks ?? '?'}`
    : 'stats=absent';
  return `runtime=${e.runtime} compositing=${e.compositing} presentedFps=${e.presentedFpsMed ?? 'n/a'} ${exec}${e.note ? ` note=${e.note}` : ''}`;
}
