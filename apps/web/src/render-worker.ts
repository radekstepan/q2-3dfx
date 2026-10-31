// q2ts-web render worker entry (M8.1 browser lane, RELEASE-8 indexed only).
//
// Runs INSIDE a Web Worker (module). Receives its slice assignment once via
// postMessage, attaches the shared frame-accum views, then enters the SAME
// bandWorkerLoop the Node pool uses (single source of truth in
// @q2/sw-renderer/bands): Atomics.wait is legal in workers, so the wakeup
// side stays Atomics-only while completion flows back via postMessage (the
// main thread can never block). Spawned by BrowserBandPool
// (render-workers.ts); never imported by the main thread directly.
import {
  CTL_FRAME,
  CTL_JOB,
  CTL_SEQ,
  JOB_RASTER,
  JOB_RESOLVE,
  attachFrameAccum,
  bandWorkerLoop,
} from '@q2/sw-renderer';
import type { DiagJob } from './render-workers.js';

interface InitMsg {
  sab: SharedArrayBuffer;
  w: number;
  h: number;
  y0: number;
  y1: number;
  band: number;
  /** Absolute slice / full-frame dims travelling with a state refresh. */
  width?: unknown;
  height?: unknown;
}

const scope = self as unknown as {
  postMessage(msg: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
};

/**
 * Worker-side monotonic clock (PERF-NEXT-4 entry plumbing).
 *
 * The shared `bandWorkerLoop` owns the production compute section; this
 * entry owns the worker-side timebase. The default clock is the worker
 * global `performance.now()` (monotonic, per-worker epoch — durations only,
 * never cross-origin timestamps); `Date.now()` is the fallback where
 * `performance` is unavailable. `setWorkerClock` injects a test clock
 * (harness only, never production).
 */
export type WorkerClock = () => number;

function defaultWorkerClock(): number {
  try {
    const p = (globalThis as unknown as { performance?: { now?: unknown } }).performance;
    if (p && typeof p.now === 'function') {
      const t = (p.now as () => unknown)();
      if (typeof t === 'number' && Number.isFinite(t)) return t;
    }
  } catch {
    /* fall through to Date.now */
  }
  return Date.now();
}

let workerClock: WorkerClock = defaultWorkerClock;

/** Inject the worker-side clock (harness only; production keeps the default). */
export function setWorkerClock(clock: WorkerClock | null): void {
  workerClock = clock ?? defaultWorkerClock;
}

/**
 * Map a numeric CTL_JOB code to its DiagJob label (transport only — the
 * pool attributes arrivals by rank AND this label; unknown codes stay
 * 'unknown' instead of guessing).
 */
export function workerJobLabel(job: unknown): DiagJob {
  if (job === JOB_RESOLVE) return 'resolve';
  if (job === JOB_RASTER) return 'raster';
  return 'unknown';
}

/**
 * Stamp one worker-loop completion message with execution identity +
 * duration (pure; unit-covered).
 *
 * The shared loop posts `{ seq, band, pixels, spans }` and — once the
 * renderer lane lands — may also post its own in-loop `execMs`/`frame`/
 * `job` (see the assumed shape below). This stamp runs at the entry
 * boundary, AFTER the work completed on this thread:
 * - `execMs`: the loop's own value wins when finite and >= 0 (it excludes
 *   notify/post overhead); otherwise `now - kickStart` (worker-side
 *   boundary timing: waitSeq returned → completion posted, one clock,
 *   epoch-free duration). Omitted when neither is available — never
 *   synthesised, never a cross-origin delta.
 * - `frame`/`job`: the loop's values win when valid; otherwise the CTL
 *   values latched at post time (same shared control the kick published).
 * - Non-completion messages (ready/exit acks: no numeric `seq`) pass
 *   through untouched by reference.
 *
 * Assumed renderer-lane shape (for the integrator): the loop measures
 * execution around the job body and posts `{ seq, band, pixels, spans,
 * execMs, frame, job }` with finite `execMs` for executed world and
 * resolve jobs; the entry preserves those fields verbatim and only fills
 * gaps. `now`/`kickStart`/`frameNow`/`jobNow` are the entry's boundary
 * observations for the gap-fill.
 */
export function stampCompletion(
  msg: unknown,
  now: number,
  kickStart: number,
  frameNow: number,
  jobNow: DiagJob,
): unknown {
  if (typeof msg !== 'object' || msg === null) return msg;
  const m = msg as Record<string, unknown>;
  if (typeof m['seq'] !== 'number') return msg;
  const stamped: Record<string, unknown> = { ...(m as Record<string, unknown>) };
  const loopExec = m['execMs'];
  if (typeof loopExec === 'number' && Number.isFinite(loopExec) && loopExec >= 0) {
    stamped['execMs'] = loopExec;
  } else if (
    typeof now === 'number' && Number.isFinite(now) &&
    typeof kickStart === 'number' && Number.isFinite(kickStart) && kickStart >= 0
  ) {
    const d = now - kickStart;
    if (Number.isFinite(d) && d >= 0) stamped['execMs'] = d;
  }
  const loopFrame = m['frame'];
  if (typeof loopFrame === 'number' && Number.isFinite(loopFrame)) {
    stamped['frame'] = loopFrame;
  } else if (typeof frameNow === 'number' && Number.isFinite(frameNow)) {
    stamped['frame'] = frameNow;
  }
  const loopJob = m['job'];
  if (typeof loopJob === 'string' && loopJob.length > 0) {
    stamped['job'] = loopJob;
  } else {
    stamped['job'] = jobNow;
  }
  return stamped;
}

scope.onmessage = (ev: MessageEvent): void => {
  const init = ev.data as InitMsg;
  if (init.sab === undefined) return;
  const shared = attachFrameAccum(init.sab, init.w, init.h);
  // PERF-NEXT-2 acknowledged-stop handshake: the pool quarantines with a
  // cooperative shutdown signal (CTL_SEQ < 0) before terminating. When the
  // loop observes it and returns, report the exit so the pool's bounded
  // completed-termination join can prove this worker is gone. The finally
  // covers abnormal loop exits too (a throwing loop still cannot write
  // after it stops). Stale exits (no quarantine armed) are ignored.
  const band = typeof init.band === 'number' ? init.band : -1;
  // PERF-NEXT-4 entry-side kick-boundary timing (no loop fork): the shared
  // loop owns the compute section; this entry owns the worker-side
  // timebase. `kickStart` latches when the wait below returns (the kick
  // the loop is about to drain); the port wrapper below stamps
  // `now - kickStart` onto the completion UNLESS the loop posted its own
  // in-loop execMs (renderer lane wins — see stampCompletion). One clock,
  // epoch-free durations; two clock reads per kick per worker (noise next
  // to multi-ms band work, never per-pixel).
  let kickStart = -1;
  const waitKick = (s: number): void => {
    try {
      Atomics.wait(shared.ctl, CTL_SEQ, s);
    } catch {
      /* dispatcher tore down; the loop exits on the next SEQ check */
    }
    kickStart = workerClock();
  };
  // The injectable clock is ALSO forwarded to the shared loop as an
  // optional trailing argument (pass-through, not a fork): the current
  // loop ignores the extra argument (plain JS semantics); a
  // renderer-lane loop with an optional trailing `now?: () => number`
  // consumes it for in-loop timing. Same call either way.
  const loopWithClock = bandWorkerLoop as unknown as (
    fav: Parameters<typeof bandWorkerLoop>[0],
    ctl: Parameters<typeof bandWorkerLoop>[1],
    y0: number, y1: number, band: number, fbW: number,
    waitSeq: (seq: number) => void,
    port: { postMessage(msg: unknown): void },
    now?: WorkerClock,
  ) => void;
  const completionPort = {
    postMessage: (msg: unknown): void => {
      let frameNow = -1;
      try {
        frameNow = Atomics.load(shared.ctl, CTL_FRAME);
      } catch {
        /* control gone; the stamp omits frame */
      }
      let jobNow: DiagJob = 'unknown';
      try {
        jobNow = workerJobLabel(Atomics.load(shared.ctl, CTL_JOB));
      } catch {
        /* control gone; the stamp keeps 'unknown' */
      }
      scope.postMessage(stampCompletion(msg, workerClock(), kickStart, frameNow, jobNow));
    },
  };
  try {
    loopWithClock(
      shared.views,
      shared.ctl,
      init.y0,
      init.y1,
      init.band,
      init.w,
      waitKick,
      completionPort,
      workerClock,
    );
  } finally {
    try {
      scope.postMessage({ exited: true, band });
    } catch {
      /* dispatcher gone */
    }
  }
};
