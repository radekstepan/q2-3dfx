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
    const { frame, seq, job, worker, band, y0, y1, execMs, pixels, spans } = s;
    if (
      typeof frame !== 'number' || typeof seq !== 'number' ||
      (job !== 'rgb' && job !== 'scanout' && job !== 'indexed-resolve' && job !== 'indexed-frame') ||
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
    out.push({ frame, seq, job, worker, band, y0, y1, execMs, pixels, spans });
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
