// q2-bench GPU-PROOF-5 soak analysis lib (measurement only).
//
// Pure helpers behind `tools/bench/gpu-soak.mjs`: frame-interval percentiles,
// presented-cadence, dropped-beat counting, GL_RENDERER → compositor
// classification, and BrowserSoakRecord / GpuProofBrowserRecord assembly for
// the existing evidence importers. No `any` in exported signatures; no DOM;
// no imports from apps/* (tools/* are leaves).
import type { BrowserSoakRecord } from './evidence.js';
import type { GpuProofBrowserRecord } from './gpu-proof.js';

/** Sorted-copy percentile (linear interpolation not needed: nearest-rank). */
export function percentile(sortedAsc: readonly number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  const qq = Math.min(1, Math.max(0, q));
  const rank = Math.ceil(qq * sortedAsc.length) - 1;
  const v = sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank))];
  return typeof v === 'number' ? v : null;
}

/** Per-frame-interval summary over a timestamp series (ms). */
export interface FrameIntervalSummary {
  /** Frame count the summary covers (intervals = stamps - 1). */
  frames: number;
  /** Median / p95 / p99 / max interval in ms (null when unmeasurable). */
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  /** Mean interval in ms (null when unmeasurable). */
  meanMs: number | null;
}

/** Differences between consecutive stamps (ms), negatives dropped. */
export function frameIntervals(stampsMs: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < stampsMs.length; i++) {
    const a = stampsMs[i - 1];
    const b = stampsMs[i];
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    const d = b - a;
    if (Number.isFinite(d) && d >= 0) out.push(d);
  }
  return out;
}

/**
 * Summarize a raw rAF timestamp series: diffs → sorted → p50/p95/p99/max +
 * mean. Returns nulls (frames = stamp count) when fewer than 2 stamps.
 */
export function summarizeFrameTimes(stampsMs: readonly number[]): FrameIntervalSummary {
  const frames = stampsMs.length;
  const empty: FrameIntervalSummary = { frames, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null, meanMs: null };
  const iv = frameIntervals(stampsMs);
  if (iv.length === 0) return empty;
  const sorted = [...iv].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    frames,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1] ?? null,
    meanMs: sum / sorted.length,
  };
}

/**
 * Presented-frame cadence in FPS from a frame-counter delta over wall-clock
 * seconds (null on non-positive duration or missing counters).
 */
export function cadenceFps(frameStart: number, frameEnd: number, durationS: number): number | null {
  if (!Number.isFinite(frameStart) || !Number.isFinite(frameEnd)) return null;
  if (!Number.isFinite(durationS) || durationS <= 0) return null;
  return (frameEnd - frameStart) / durationS;
}

/**
 * Dropped-beat count: intervals at or above `thresholdMs` (default 34ms =
 * a missed 60Hz beat). Headless has no display vsync; this counts rAF gaps,
 * i.e. scheduling stalls, not compositor drops — the definition is recorded
 * verbatim in every manifest note.
 */
export function countDroppedBeats(intervalsMs: readonly number[], thresholdMs = 34): number {
  let n = 0;
  for (const v of intervalsMs) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= thresholdMs) n++;
  }
  return n;
}

/** GL_RENDERER → compositor classification (honest hardware reporting). */
export function classifyCompositor(glRenderer: string | null): {
  compositor: 'hardware' | 'swiftshader' | 'software' | 'unknown';
  hardwareBacked: boolean;
} {
  if (!glRenderer || glRenderer.trim().length === 0) return { compositor: 'unknown', hardwareBacked: false };
  const s = glRenderer.toLowerCase();
  if (s.includes('swiftshader')) return { compositor: 'swiftshader', hardwareBacked: false };
  if (s.includes('llvmpipe') || s.includes('softpipe') || s.includes('software') || s.includes('basic render')) {
    return { compositor: 'software', hardwareBacked: false };
  }
  if (/angle\s*\((amd|nvidia|intel|qualcomm|arm|apple)/.test(s)) return { compositor: 'hardware', hardwareBacked: true };
  if (/\b(radeon|geforce|nvidia|radeonsi|amdgpu)\b/.test(s) && !s.includes('chromium')) {
    return { compositor: 'hardware', hardwareBacked: true };
  }
  return { compositor: 'unknown', hardwareBacked: false };
}

/** Inputs for record assembly (everything the runner measured for one leg). */
export interface GpuSoakLegInput {
  commitShort: string;
  commitFull: string | null;
  browserName: string;
  browserVersion: string;
  headless: boolean;
  /** Raw UNMASKED_RENDERER_WEBGL string (null when unprobed). */
  glRenderer: string | null;
  renderer: string;
  width: number;
  height: number;
  page: string;
  durationS: number;
  samples: number;
  presentedFpsMedian: number | null;
  frameP50Ms: number | null;
  frameP95Ms: number | null;
  frameMaxMs: number | null;
  workloads: string[];
  notes: string;
  workers: number[];
  dateIso: string;
  /**
   * FOLLOW-1 provenance (all optional; absent values stay null with an
   * explicit limitation instead of a fabricated default).
   */
  /** Pinned vd_* + sw_* fidelity profile measured under (null = unrecorded). */
  fidelity?: { vd: Record<string, string>; sw: Record<string, string> } | null;
  /** Warmup seconds before sampling (null = unrecorded). */
  warmupS?: number | null;
  /** Asset identity (null = unrecorded). */
  pak?: { path: string; bytes: number | null; mtimeMs: number | null; mtimeIso: string | null; missing: boolean } | null;
  /** Host machine descriptor (null = unrecorded). */
  machineDetail?: Record<string, string> | null;
  /** Source tree dirtiness at RUN time (null = unknown). */
  sourceDirty?: boolean | null;
  /** `git status --porcelain` lines at RUN time (null = unrecorded). */
  sourceDirtyFiles?: string[] | null;
  /** Chromium flags used for the leg. */
  chromiumFlags?: string[] | null;
  /** Effective cvar snapshot read back from the page. */
  cvarSnapshot?: Record<string, string> | null;
  /** Measured BeginFrames/rAF rate in Hz (null = unmeasured; NOT a display refresh). */
  refreshHz?: number | null;
  /** True only when vsync-locked presentation was verified (headless: false). */
  vsync?: boolean | null;
  /** Dropped presented frames over the soak (null = uncounted). */
  droppedFrames?: number | null;
  /** Any CPU fallback during a GPU leg voids it (null = unverified). */
  cpuFallback?: boolean | null;
}

/**
 * Per-frame CPU work-split medians (ms) from the page's `__q2soakWork`
 * conveyor (main-thread `performance.now` ring: drains/sim/view/tail/submit
 * /total). All values are CALLER-CLOCK submission work — `submitMs` is time
 * spent submitting GL work plus presentation, NEVER measured GPU execution.
 * Async GPU duration is unavailable in this harness (no disjoint-timer
 * query); it must be reported as unknown, never inferred from submit time.
 */
export interface GpuWorkSplits {
  drainsMs: number | null;
  simMs: number | null;
  viewMs: number | null;
  tailMs: number | null;
  submitMs: number | null;
  totalMs: number | null;
}

/**
 * FOLLOW-1 timing vocabulary (load-bearing labels; use verbatim in reports):
 * - rAF/submission cadence: BeginFrames rate from unthrottled rAF stamps —
 *   measures main-thread frame WORK headroom, not display refresh.
 * - CPU frame work: caller-clock splits (drains/sim/view/tail/submit/total).
 * - async GPU duration: UNKNOWN in this harness (no timer query support).
 * - displayed-frame evidence: requires a visible (non-headless) vsync-locked
 *   leg with recorded refresh/vsync/dropped frames — headless cadence alone
 *   never counts as displayed 60 FPS.
 */
export function describeTimingKinds(): string {
  return [
    'rAF/submission cadence = unthrottled BeginFrames rate (main-thread work headroom, NOT display refresh)',
    'CPU frame work = caller-clock splits drains/sim/view/tail/submit/total (submitMs is submission work, NOT GPU execution)',
    'async GPU duration = unknown in this harness (no disjoint-timer query; never infer from submit time)',
    'displayed-frame evidence = visible headless=false + vsync=true leg with recorded refresh/dropped frames only',
  ].join('\n');
}

/**
 * Assemble the committed BrowserSoakRecord for one leg (CPU legs use this
 * directly via the existing `importBrowserSoak`; the GPU leg extends it).
 * FOLLOW-1 provenance fields ride along when the runner supplies them;
 * absent values stay null with explicit limitations (never fabricated).
 */
export function buildSoakRecord(input: GpuSoakLegInput): BrowserSoakRecord {
  const cls = classifyCompositor(input.glRenderer);
  const limitations: string[] = [];
  if (!input.fidelity) limitations.push('fidelity profile unrecorded (vd_* + sw_* cvars unknown)');
  if (input.warmupS === undefined || input.warmupS === null) limitations.push('warmup unrecorded');
  if (!input.pak || input.pak.missing) limitations.push('asset identity unrecorded (pak bytes/mtime unknown)');
  if (!input.machineDetail || Object.keys(input.machineDetail).length === 0) limitations.push('host machine descriptor unrecorded');
  return {
    schemaVersion: 1,
    commitShort: input.commitShort,
    commitFull: input.commitFull,
    date: input.dateIso,
    browser: { name: input.browserName, version: input.browserVersion, headless: input.headless },
    compositor: cls.compositor,
    compositorDetail: input.glRenderer ?? '(unprobed)',
    hardwareBacked: cls.hardwareBacked,
    page: input.page,
    resolution: `${input.width}x${input.height}`,
    width: input.width,
    height: input.height,
    renderer: input.renderer,
    workers: [...input.workers],
    durationS: input.durationS,
    samples: input.samples,
    presentedFpsMedian: input.presentedFpsMedian,
    frameP50Ms: input.frameP50Ms,
    frameP95Ms: input.frameP95Ms,
    frameMaxMs: input.frameMaxMs,
    workloads: [...input.workloads],
    notes: input.notes,
    rawFile: null,
    fidelity: input.fidelity ?? null,
    warmupS: input.warmupS ?? null,
    pak: input.pak ?? null,
    machineDetail: input.machineDetail ?? null,
    sourceDirty: input.sourceDirty ?? null,
    sourceDirtyFiles: input.sourceDirtyFiles ?? null,
    chromiumFlags: input.chromiumFlags ?? null,
    cvarSnapshot: input.cvarSnapshot ?? null,
    refreshHz: input.refreshHz ?? null,
    vsync: input.vsync ?? null,
    droppedFrames: input.droppedFrames ?? null,
    cpuFallback: input.cpuFallback ?? null,
    limitations: limitations.length > 0 ? limitations : null,
  };
}

/** GPU-leg gate fields (measured refresh/vsync/dropped/cpuFallback). */
export interface GpuSoakGateInput {
  /** Measured BeginFrames/rAF rate in Hz (null = unmeasured). */
  refreshHz: number | null;
  /** True only when vsync-locked presentation was verified (headless: false). */
  vsync: boolean | null;
  droppedFrames: number | null;
  cpuFallback: boolean | null;
}

/**
 * Narrow a soak record to the strict GpuProofBrowserRecord. Returns errors
 * (never throws) when the leg cannot satisfy the gate schema: wrong
 * renderer/resolution, software compositor, missing refresh/vsync/dropped,
 * or any CPU fallback — such legs are VOID, never passes.
 */
export function buildGpuProofRecord(
  record: BrowserSoakRecord,
  gate: GpuSoakGateInput,
): { ok: true; record: GpuProofBrowserRecord } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (record.compositor !== 'hardware' || record.hardwareBacked !== true) {
    errors.push(
      `GPU leg must be hardware-backed (got compositor=${record.compositor} hardwareBacked=${String(record.hardwareBacked)} — SwiftShader/software numbers supplement but NEVER satisfy the gate)`,
    );
  }
  if (record.renderer !== 'webgl2-experimental') {
    errors.push(`GPU leg renderer must be 'webgl2-experimental' (got ${JSON.stringify(record.renderer)})`);
  }
  if (record.width !== 640 || record.height !== 480 || record.resolution !== '640x480') {
    errors.push(`GPU leg resolution must be 640x480 (got ${record.resolution})`);
  }
  if (typeof gate.refreshHz !== 'number' || !Number.isFinite(gate.refreshHz) || gate.refreshHz <= 0) {
    errors.push('refreshHz required: measured display/BeginFrames rate in Hz');
  }
  if (typeof gate.vsync !== 'boolean') errors.push('vsync required: boolean recording vsync-lock verification');
  if (typeof gate.droppedFrames !== 'number' || !Number.isInteger(gate.droppedFrames) || gate.droppedFrames < 0) {
    errors.push('droppedFrames required: non-negative integer count over the soak');
  }
  if (gate.cpuFallback !== false) {
    errors.push('cpuFallback must be false for the GPU leg (any CPU fallback voids the leg)');
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    record: {
      ...record,
      compositor: 'hardware',
      hardwareBacked: true,
      renderer: 'webgl2-experimental',
      resolution: '640x480',
      width: 640,
      height: 480,
      refreshHz: gate.refreshHz as number,
      vsync: gate.vsync as boolean,
      droppedFrames: gate.droppedFrames as number,
      cpuFallback: false,
    },
  };
}

/** One-line per-leg numbers for the final report table. */
export interface GpuSoakLegNumbers {
  leg: string;
  renderer: string;
  glRenderer: string | null;
  hardwareBacked: boolean;
  durationS: number;
  cadenceFps: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  dropped: number;
  heapDeltaMB: number | null;
  errors: number;
}

/** Render the per-leg numbers table (paste into the final report). */
export function renderLegNumbersTable(legs: readonly GpuSoakLegNumbers[]): string {
  const fmt = (v: number | null, digits = 2): string =>
    v === null || !Number.isFinite(v) ? 'n/a' : v.toFixed(digits);
  const head = '| leg | renderer | hw | dur(s) | cadence(fps) | p50(ms) | p95(ms) | p99(ms) | dropped | heapΔ(MB) | errors |';
  const sep = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const rows = legs.map((l) =>
    `| ${l.leg} | ${l.renderer} | ${l.hardwareBacked ? 'yes' : 'no'} | ${l.durationS.toFixed(0)} ` +
    `| ${fmt(l.cadenceFps)} | ${fmt(l.p50Ms)} | ${fmt(l.p95Ms)} | ${fmt(l.p99Ms)} ` +
    `| ${l.dropped} | ${fmt(l.heapDeltaMB, 1)} | ${l.errors} |`,
  );
  return [head, sep, ...rows].join('\n');
}
