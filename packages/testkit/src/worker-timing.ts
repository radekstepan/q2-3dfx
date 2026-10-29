// @q2/testkit — worker-local timing harness (PERF-FINISH follow-up item 4,
// bench/testkit lane).
//
// TIMEBASE (read before reporting numbers):
//
//   - Caller-side dispatch-to-completion latency (`KickSample.latencyMs`,
//     measured with `nowNs()` on the caller) INCLUDES worker execution plus
//     scheduling, thread wakeup, and message/notify delivery delay. It is
//     scheduling-aware by construction and must NEVER be labeled "worker N
//     took X ms".
//   - Worker-local execution durations (`BandExecSample.execMs`) are measured
//     where the work runs. A duration measured entirely on ONE clock needs
//     NO cross-origin comparability proof: durations are epoch-free. Only
//     aligning a worker timestamp onto the caller timeline would need a
//     shared epoch — this module never does that.
//   - Until the renderer publishes in-worker timestamps (it owns its worker
//     loop — read-only from this lane), `collectWorkerExec()` returns null
//     and the bench reports dispatch-to-completion + the main-thread band
//     proxy + staged/admitted counts, saying so explicitly.
//
// What IS recorded per job, all caller-clock: frame/sequence + job type +
// stable band/worker identity (band index + y-range never move for a fixed
// WxH×workers config) + primitive/span/pixel counts where the caller knows
// them. Caller latency and worker execution stay in separate fields of
// separate records.
import type { CritJobKind } from './critpath.js';
import { bandRanges, summarizeLatencies, type LatencySummary } from './critpath.js';

/**
 * One caller-fenced kick (dispatch-to-completion on the caller clock).
 * `execMs` is present ONLY when the duration was measured where the work
 * ran (main-thread inline drain timed around the call, or a future
 * in-worker timestamp region) — never a message-arrival delta.
 */
export interface TimedKick {
  frame: number;
  seq: number;
  job: CritJobKind;
  workers: number;
  band: number | 'all';
  y0: number;
  y1: number;
  latencyMs: number;
  ok: boolean;
  execMs: number | null;
  pixels: number;
  spans: number;
}

/** In-order journal of caller-fenced kicks for one config. */
export class KickJournal {
  private readonly kicks: TimedKick[] = [];

  record(k: TimedKick): void {
    this.kicks.push({ ...k });
  }

  get size(): number {
    return this.kicks.length;
  }

  entries(): TimedKick[] {
    return this.kicks.map((k) => ({ ...k }));
  }

  /** Dispatch-to-completion distribution for one job (critical-path max = max). */
  summarize(job: CritJobKind): LatencySummary {
    return summarizeLatencies(this.kicks.filter((k) => k.job === job).map((k) => k.latencyMs));
  }

  summarizeAll(): LatencySummary {
    return summarizeLatencies(this.kicks.map((k) => k.latencyMs));
  }

  /** Executed-band coverage: which stable bands were fenced (forensics). */
  bandsSeen(): Array<{ band: number | 'all'; y0: number; y1: number }> {
    const seen = new Map<string, { band: number | 'all'; y0: number; y1: number }>();
    for (const k of this.kicks) {
      const key = `${k.band}:${k.y0}-${k.y1}`;
      if (!seen.has(key)) seen.set(key, { band: k.band, y0: k.y0, y1: k.y1 });
    }
    return [...seen.values()];
  }
}

/**
 * Stable worker/band identity ledger for a WxH×workers config (same tiling
 * as the pool's splitBands: even split, last band takes the rest, the
 * caller owns the last band). Keyed records stay comparable across reps
 * and builds.
 */
export function workerBandLedger(
  h: number, workers: number,
): Array<{ worker: number | 'caller'; band: number; y0: number; y1: number }> {
  return bandRanges(h, workers).map((b, i, arr) => ({
    worker: i === arr.length - 1 ? ('caller' as const) : i,
    band: b.band,
    y0: b.y0,
    y1: b.y1,
  }));
}

/**
 * Future renderer-side per-band execution sample (in-worker clock).
 * Consumer-ready only: no producer exists in this lane (the renderer owns
 * its worker loop). Durations are epoch-free — no cross-clock proof needed;
 * only timeline alignment would need a shared epoch, which we never do.
 *
 * PERF-NEXT-4 producer shape (renderer/browser lanes): the production
 * worker loop measures execution around the job body and posts `execMs`
 * plus frame/sequence/job/band identity and actual work counts on the
 * completion message; the Node pool (`lastWorkerExec`/`testBandExecStats`)
 * and the browser pool (`testBandExecStats`) surface the collected
 * per-band samples. `tris` is optional — older builds count pixels/spans
 * only. Feature-detected: `collectWorkerExec` accepts samples with or
 * without it.
 */
export interface WorkerExecSample {
  frame: number;
  seq: number;
  job: CritJobKind;
  worker: number;
  band: number;
  y0: number;
  y1: number;
  /** Measured where the work ran (in-worker clock). Epoch-free duration. */
  execMs: number;
  pixels: number;
  spans: number;
  /** Screen tris executed by this band (optional: older builds omit it). */
  tris?: number;
}

/**
 * Read renderer-published worker-local execution samples through a public
 * hook when it exists. Returns null when the renderer publishes nothing
 * (current state) — the caller keeps reporting dispatch-to-completion.
 * Rejects malformed samples (negative durations, non-finite numbers) by
 * returning null rather than laundering cross-clock garbage.
 */
export function collectWorkerExec(source: unknown): WorkerExecSample[] | null {
  if (typeof source !== 'object' || source === null) return null;
  const hook = (source as Record<string, unknown>)['testBandExecStats'];
  if (typeof hook !== 'function') return null;
  let raw: unknown;
  try {
    raw = (hook as () => unknown).call(source);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const out: WorkerExecSample[] = [];
  for (const s of raw as Array<Record<string, unknown>>) {
    if (typeof s !== 'object' || s === null) return null;
    const { frame, seq, job, worker, band, y0, y1, execMs, pixels, spans, tris } = s;
    if (
      typeof frame !== 'number' || typeof seq !== 'number' ||
      (job !== 'rgb' && job !== 'scanout' && job !== 'indexed-resolve' && job !== 'indexed-frame' &&
        job !== 'world' && job !== 'foreground' && job !== 'resolve') ||
      typeof worker !== 'number' || typeof band !== 'number' ||
      typeof y0 !== 'number' || typeof y1 !== 'number' ||
      typeof execMs !== 'number' || typeof pixels !== 'number' || typeof spans !== 'number'
    ) return null;
    if (
      !Number.isFinite(frame) || !Number.isFinite(seq) || !Number.isFinite(worker) ||
      !Number.isFinite(band) || !Number.isFinite(y0) || !Number.isFinite(y1) ||
      !Number.isFinite(execMs) || !Number.isFinite(pixels) || !Number.isFinite(spans)
    ) return null;
    if (execMs < 0 || pixels < 0 || spans < 0) return null;
    if (tris !== undefined) {
      if (typeof tris !== 'number' || !Number.isFinite(tris) || tris < 0) return null;
    }
    const sample: WorkerExecSample = { frame, seq, job, worker, band, y0, y1, execMs, pixels, spans };
    if (tris !== undefined) sample.tris = tris;
    out.push(sample);
  }
  return out;
}

/**
 * Critical-path compute max across worker bands for one (frame, seq, job):
 * the slowest band's execution duration. Kept SEPARATE from caller
 * dispatch-to-completion — reported side by side, never subtracted.
 */
export function workerExecCriticalPath(xs: WorkerExecSample[]): LatencySummary {
  return summarizeLatencies(xs.map((x) => x.execMs));
}

/**
 * Detailed timing kill-switch (PERF-NEXT-4 done-when 5): env-gated so
 * acceptance runs with it DISABLED. `Q2_DETAIL_TIMING=0` (also accepts
 * `off`/`false`) disables per-band exec collection/reporting; anything
 * else (including unset) enables it. No allocation, safe on any clock.
 * The accept gate forces disabled and records that fact in its evidence.
 */
export function detailTimingEnabled(): boolean {
  try {
    const v = typeof process !== 'undefined' ? process.env['Q2_DETAIL_TIMING'] : undefined;
    if (v === undefined) return true;
    const s = v.trim().toLowerCase();
    return !(s === '0' || s === 'off' || s === 'false' || s === 'no');
  } catch {
    return true;
  }
}

/**
 * One worker completion message, parsed structurally (PERF-NEXT-4 assumed
 * producer shape — reconciles the Node `bandWorkerLoop` postMessage and
 * the browser worker entry postMessage, which share the protocol):
 * `{ seq, band, pixels, spans }` today, plus optional `execMs` (finite
 * in-worker duration, epoch-free) and optional frame/job/band-geometry
 * identity plus `tris` work counts when the renderer lane publishes them.
 * Missing `execMs` reads null (the caller keeps fencing); a present but
 * malformed `execMs` rejects the whole message (never laundered).
 */
export interface WorkerCompletion {
  seq: number;
  band: number;
  pixels: number;
  spans: number;
  /** Finite in-worker duration, or null when this build omits it. */
  execMs: number | null;
  frame: number | null;
  job: CritJobKind | null;
  y0: number | null;
  y1: number | null;
  tris: number | null;
}

const COMPLETION_JOBS: CritJobKind[] = [
  'rgb', 'scanout', 'indexed-resolve', 'indexed-frame', 'world', 'foreground', 'resolve',
];

/** Parse one completion message; null when absent or malformed. */
export function readCompletionMessage(msg: unknown): WorkerCompletion | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  const { seq, band, pixels, spans, execMs, frame, job, y0, y1, tris } = m;
  if (
    typeof seq !== 'number' || !Number.isFinite(seq) ||
    typeof band !== 'number' || !Number.isFinite(band) ||
    typeof pixels !== 'number' || !Number.isFinite(pixels) || pixels < 0 ||
    typeof spans !== 'number' || !Number.isFinite(spans) || spans < 0
  ) return null;
  let exec: number | null = null;
  if (execMs !== undefined) {
    if (typeof execMs !== 'number' || !Number.isFinite(execMs) || execMs < 0) return null;
    exec = execMs;
  }
  let fr: number | null = null;
  if (frame !== undefined) {
    if (typeof frame !== 'number' || !Number.isFinite(frame)) return null;
    fr = frame;
  }
  let jb: CritJobKind | null = null;
  if (job !== undefined) {
    // Wire labels (production `bandWorkerLoop` + browser entry stamper):
    // 'raster' = indexed-world raster, 'resolve' = indexed resolve,
    // 'rgb'/'scanout' direct, 'unknown' = accepted with a null job (the
    // sample's execMs/identity still count). Legacy CritJobKind producers
    // ('world'/'foreground'/'resolve' etc.) pass through unchanged.
    if (typeof job !== 'string') return null;
    if (job === 'raster') jb = 'indexed-frame';
    else if (job === 'resolve') jb = 'indexed-resolve';
    else if (job === 'unknown') jb = null;
    else if ((COMPLETION_JOBS as string[]).includes(job)) jb = job as CritJobKind;
    else return null;
  }
  let yA: number | null = null;
  let yB: number | null = null;
  if (y0 !== undefined || y1 !== undefined) {
    if (typeof y0 !== 'number' || !Number.isFinite(y0) ||
      typeof y1 !== 'number' || !Number.isFinite(y1)) return null;
    yA = y0; yB = y1;
  }
  let tr: number | null = null;
  if (tris !== undefined) {
    if (typeof tris !== 'number' || !Number.isFinite(tris) || tris < 0) return null;
    tr = tris;
  }
  return { seq, band, pixels, spans, execMs: exec, frame: fr, job: jb, y0: yA, y1: yB, tris: tr };
}

/**
 * Max-vs-median straggler analysis over per-band execution samples
 * (PERF-NEXT-4 input to PERF-NEXT-6). Samples group by (frame, seq, job);
 * the critical path of each group is its max (slowest band waits fence the
 * kick). Reported: the max of group maxes, the median band compute, and
 * the worst group's max-vs-median gap with the straggler's identity.
 * Independent medians are never summed; the gap is computed WITHIN one
 * group, then the worst group is reported.
 */
export interface WorkerImbalance {
  /** Executed (frame, seq, job) groups covered. */
  groups: number;
  /** Total band samples consumed. */
  bands: number;
  /** Median per-band compute across all samples (diagnostic, not a total). */
  bandMed: number;
  /** Slowest single band compute observed. */
  bandMax: number;
  /** Critical-path max: slowest group max (the fence every kick waits). */
  critPathMax: number;
  /** Worst within-group max-minus-median (the straggler gap). */
  imbalanceMs: number;
  /** Worst within-group max/med ratio (null when the group med is 0). */
  imbalanceRatio: number | null;
  /** Slowest band's full identity (null when no samples). */
  straggler: { frame: number; seq: number; job: CritJobKind; band: number; execMs: number } | null;
  /** Per-kick-group compute (oldest first): job label, worker med/max. */
  byGroup: Array<{ job: CritJobKind; seq: number; n: number; med: number; max: number }>;
}

/** Straggler analysis over worker-local execution samples (pure). */
export function summarizeWorkerImbalance(xs: WorkerExecSample[]): WorkerImbalance {
  const empty: WorkerImbalance = {
    groups: 0, bands: 0, bandMed: 0, bandMax: 0, critPathMax: 0,
    imbalanceMs: 0, imbalanceRatio: null, straggler: null, byGroup: [],
  };
  if (xs.length === 0) return empty;
  const groups = new Map<string, WorkerExecSample[]>();
  for (const x of xs) {
    const k = `${x.frame}:${x.seq}:${x.job}`;
    const g = groups.get(k);
    if (g) g.push(x);
    else groups.set(k, [x]);
  }
  const byGroup: WorkerImbalance['byGroup'] = [];
  const all = summarizeLatencies(xs.map((x) => x.execMs));
  let critPathMax = 0;
  let imbalanceMs = 0;
  let imbalanceRatio: number | null = null;
  let straggler: WorkerImbalance['straggler'] = null;
  for (const g of groups.values()) {
    const s = summarizeLatencies(g.map((x) => x.execMs));
    byGroup.push({ job: g[0]!.job, seq: g[0]!.seq, n: g.length, med: s.med, max: s.max });
    if (s.max > critPathMax) critPathMax = s.max;
    const gap = s.max - s.med;
    if (gap > imbalanceMs) {
      imbalanceMs = gap;
      imbalanceRatio = s.med > 0 ? s.max / s.med : null;
    }
    for (const x of g) {
      if (straggler === null || x.execMs > straggler.execMs) {
        straggler = { frame: x.frame, seq: x.seq, job: x.job, band: x.band, execMs: x.execMs };
      }
    }
  }
  return {
    groups: groups.size, bands: xs.length,
    bandMed: all.med, bandMax: all.max, critPathMax,
    imbalanceMs, imbalanceRatio, straggler, byGroup,
  };
}

/** One-line imbalance ledger (per-band compute + straggler, no summed medians). */
export function formatWorkerImbalance(w: WorkerImbalance): string {
  if (w.bands === 0) return 'workerExec[n=0: producer unpublished]';
  const s = w.straggler!;
  return (
    `workerExec[n=${w.bands} groups=${w.groups} bandMed=${w.bandMed.toFixed(2)} ` +
    `bandMax=${w.bandMax.toFixed(2)} critMax=${w.critPathMax.toFixed(2)} ` +
    `gap=${w.imbalanceMs.toFixed(2)}` +
    `${w.imbalanceRatio !== null ? ` ratio=${w.imbalanceRatio.toFixed(2)}x` : ''} ` +
    `straggler=band${s.band}(${s.job} f${s.frame}s${s.seq} ${s.execMs.toFixed(2)}ms)]`
  );
}
