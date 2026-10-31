// q2ts-web browser band pool (M8.1 browser lane, RELEASE-8 indexed only).
//
// Web-Worker implementation of the sw-renderer BandDispatcher contract:
// frame-level batch accumulation captured on the main thread during
// geometry, drained by N workers + the main thread in ONE kick per frame
// (flushFrameAsync), plus a parallel palette-expand kick
// (resolveFrameAsync). The SAB layout, descriptor protocol and worker loop
// are shared with the Node pool (attachFrameAccum, processFrameJob,
// resolveBand, bandWorkerLoop in @q2/sw-renderer) — only the thread
// management differs (DOM Workers + message-driven completion instead of
// worker_threads + Atomics.wait, which is forbidden on the main thread).
//
// Headless-safe: create() returns null anywhere Workers, SAB or
// cross-origin isolation are missing (Node/vitest, non-COOP/COEP pages),
// and every caller falls back to the inline banded path with identical
// output. Sync kick methods (dispatch/flushFrame) return
// null/false — the renderer replays inline; only the Async methods kick.

import {
  CTL_COUNT,
  CTL_DONE,
  CTL_FBH,
  CTL_FBW, CTL_FCOUNT,
  CTL_FRAME,
  CTL_JOB,
  CTL_PIXELS,
  CTL_READY,
  CTL_SEQ,
  CTL_SPANS,
  D_HMASK,
  D_LIGHT_H,
  D_LIGHT_OFF,
  D_LIGHT_W,
  D_PER_BATCH,
  D_ORDERED,
  D_SPAN_BASE,
  D_SPAN_COUNT,
  D_TEX_H,
  D_TEX_OFF,
  D_TEX_W,
  D_TURBPHASE,
  D_WMASK,
  D_WSHIFT,
  D_YMAX,
  D_YMIN,
  F_PER_SPAN,
  FRAME_LIGHT_CAP,
  FRAME_TEX_CAP,
  JOB_RASTER,
  JOB_RESOLVE,
  MAX_FRAME_BATCHES,
  MAX_FRAME_SPANS,
  MAX_WORKERS,
  I_PER_SPAN,
  attachFrameAccum,
  frameAccumTotal,
  packFrameSpans,
  processFrameJob,
  resolveBand,
  sabAvailable,
  splitBands,
  textureMasks,
  type Band,
  type BandDispatcher,
  type BandViews,
  type FrameAccumViews,
  type LightBlock,
  type SpanList,
  type Texture,
} from '@q2/sw-renderer';
/**
 * Module-namespace probe for renderer-lane layout additions (CTL_SCAN).
 * Named static imports are pinned to the built dist typings, which lag
 * the in-flight renderer source; the namespace probe degrades to
 * "unavailable" on older builds instead of breaking typecheck. Same
 * `as unknown as` capability-probe family as the renderer-hook probes in
 * play.ts/dom.ts. The offset and the SAB region always come from the same
 * package build at runtime (both via attachFrameAccum's module), so a
 * present offset is always in-bounds.
 */
import * as swRendererNS from '@q2/sw-renderer';
import type { CritJobKind, WorkerExecSample } from '@q2/testkit';

export const BROWSER_POOL_TIMEOUT_MS = 30000;

/**
 * Bounded per-kick timing ledger depth (PERF-NEXT-4): oldest-first,
 * drop-oldest past the cap. A production frame holds at most a handful
 * of kicks (indexed raster + resolve); 16 keeps several frames of history
 * for harness forensics with bounded memory.
 */
export const KICK_TIMING_CAP = 16;

/**
 * Per-frame worker-execution sample cap (testBandExecStats): 7 workers ×
 * ~8 kicks/frame worst case is 56; 256 is headroom that can never fill
 * in practice (append stops at the cap, documented, never throws).
 */
export const FRAME_EXEC_CAP = 256;

/** Job kinds the browser pool can kick (labels the diag snapshot). */
export type DiagJob = 'raster' | 'resolve' | 'unknown';

/**
 * Map a browser kick label to the shared testkit job vocabulary (for
 * `testBandExecStats` cross-lane consumption): indexed raster/resolve
 * kicks are the testkit indexed lanes. 'unknown' has no testkit
 * counterpart (null = unpublished, never a laundered guess).
 */
export function diagJobToCritJob(job: DiagJob): CritJobKind | null {
  if (job === 'raster') return 'indexed-frame';
  if (job === 'resolve') return 'indexed-resolve';
  return null;
}

/**
 * Within-kick worker-compute summary (pure; unit-covered). Inputs are one
 * kick's per-band durations with -1/unknowns already filtered by the
 * caller (see `finiteExecOf`); the medians here are over bands of ONE
 * kick and are never summed across kicks or phases.
 */
export function summarizeExec(execMs: number[]): {
  max: number; med: number; min: number; known: number;
} {
  const xs = execMs.filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  if (xs.length === 0) return { max: -1, med: -1, min: -1, known: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const med = sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { max: sorted[sorted.length - 1]!, med, min: sorted[0]!, known: xs.length };
}

/**
 * One kick's terminal outcome (PERF-NEXT-2 outcome vocabulary, internal):
 * 'completed' (every worker acked — success, flushed advances), 'failed'
 * (timeout with workers running — partial-failure, quarantined first), or
 * 'disposed' (teardown aborted the wait — partial-failure, no quarantine:
 * dispose already tore the workers down). 'refused' outcomes (staging
 * refusal, checkpoint allocation failure, declined dispatch) never reach a
 * waiter — nothing was dispatched, so the pending staging is left intact
 * for the exact inline replay.
 */
type KickOutcome = 'completed' | 'failed' | 'disposed';

/** Waiter signal: per-message ack, or abort (teardown). Internal. */
type KickSignal = 'ack' | 'abort';

/**
 * Last-kick diagnostic snapshot (instrumented-only, never the production
 * frame). All times are main-thread `performance.now()` deltas from the
 * kick fan-out — one clock, always comparable. `arrivals` are
 * dispatch-to-completion latencies per worker in arrival order (they
 * include scheduling + postMessage latency, so they bound but do not
 * equal in-worker compute: true per-worker compute durations arrive as
 * worker-side timestamps — see `workerExecMs` below.
 * `workerExecMs` carries those worker-local compute durations when the
 * worker build posts them (`execMs` on the completion message — a
 * duration, so it is comparable across time origins without clock
 * sync); -1 per arrival when the message omitted it (older builds or
 * control-only stubs). `bandIds`, `pixels` and `spans` parallel
 * `arrivals` with the band identity + tallies the worker message carried
 * (-1 when the message omitted them). `slowestMs` is the critical path
 * (dispatch → last completion).
 *
 * Straggler fields (`execMaxMs`/`execMedianMs`/`execMinMs`/
 * `execImbalanceMs`/`arrivalSpreadMs`/`execKnown`/`execUnknown`) are
 * computed WITHIN this one kick's per-band samples only: max/median/min
 * over the finite `workerExecMs` entries, the max-minus-min gap, and the
 * dispatch-latency spread (slowest minus fastest arrival). Independent
 * medians across kicks or phases are never summed or differenced here —
 * cross-kick aggregation lives in the `KickTiming` ledger (a list of
 * per-kick summaries, never a fused total) and cross-rep analysis in the
 * bench/testkit lanes.
 */
export interface DiagSnapshot {
  kicks: number;
  /** Frame generation + message sequence identifying this kick. */
  frame: number;
  seq: number;
  job: DiagJob;
  /** Band count covered by the kick (workers + the main-thread band). */
  bands: number;
  mainMs: number;
  arrivals: number[];
  bandIds: number[];
  pixels: number[];
  spans: number[];
  /** Worker-local compute durations parallel to arrivals (-1 when unposted). */
  workerExecMs: number[];
  slowestMs: number;
  /** Max finite worker-compute duration across bands (-1 when none known). */
  execMaxMs: number;
  /** Median finite worker-compute duration across bands (-1 when none). */
  execMedianMs: number;
  /** Min finite worker-compute duration across bands (-1 when none known). */
  execMinMs: number;
  /** Worker-compute imbalance: execMaxMs minus execMinMs (-1 when unknown). */
  execImbalanceMs: number;
  /** Dispatch-latency spread: slowest minus fastest arrival (-1 when <1). */
  arrivalSpreadMs: number;
  /** Finite workerExecMs entries consumed by the straggler fields. */
  execKnown: number;
  /** Arrivals without a usable worker-local duration. */
  execUnknown: number;
}

/**
 * One kick's frozen timing summary (PERF-NEXT-4 per-kick/per-frame
 * attribution). Recorded ONLY while diag is armed (see `enableDiag`) —
 * the disabled path records nothing. One entry per kick attempt that
 * reached dispatch identity (completed/failed/disposed) plus
 * pre-dispatch refusals where staging existed; kicks that never started
 * (dead pool, nothing staged) record nothing. Entries are
 * same-clock durations or -1-unknown; independent medians are never
 * summed or subtracted across entries — a frame's story is the LIST
 * (raster flush first, then the resolve kick), and cross-rep
 * medians belong to the bench/testkit lanes.
 */
export interface KickTiming {
  frame: number;
  seq: number;
  job: DiagJob;
  bands: number;
  outcome: 'completed' | 'failed' | 'disposed' | 'refused';
  /** Calling-thread band execution for this kick (-1 when it never ran). */
  mainMs: number;
  /** Max finite per-band worker-compute duration (-1 when none known). */
  execMaxMs: number;
  /** Median finite per-band worker-compute duration (-1 when none known). */
  execMedianMs: number;
  /** Min finite per-band worker-compute duration (-1 when none known). */
  execMinMs: number;
  /** Dispatch → last completion critical path (-1 when unknown). */
  slowestMs: number;
  /** Slowest minus fastest dispatch-to-completion arrival (-1 when <1). */
  spreadMs: number;
  /**
   * Kick fan-out minus the previous kick's completion on the same clock
   * (main-thread barrier/idle between kicks where measurable: dispatch
   * gaps, inline-drain overlaps excluded). -1 for the first recorded
   * kick or when either endpoint is unknown.
   */
  gapSincePrevMs: number;
  /** Finite workerExecMs entries consumed by the exec fields. */
  execKnown: number;
  /** Arrivals without a usable worker-local duration. */
  execUnknown: number;
}

/**
 * Browser-default worker count (M7.1 perf lane): one worker per core minus
 * the main thread, clamped to the pool's valid range. Used by startPlayLoop
 * to latch `sw_workers` when the operator left it at the default 0, so a
 * real browser runs pooled without manual tuning while headless/CI stays
 * single-threaded (browserPoolAvailable() is false there). Pure; falls back
 * to 3 (the historic attach default) without `navigator`.
 */
export function defaultBrowserWorkers(): number {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const hc = nav?.hardwareConcurrency;
    if (typeof hc === 'number' && Number.isFinite(hc) && hc > 0) {
      return Math.max(1, Math.min(7, Math.floor(hc) - 1));
    }
  } catch {
    /* no navigator: historic default below */
  }
  return 3;
}

/** True when the browser can run the worker pool (DOM + SAB + isolation). */
export function browserPoolAvailable(): boolean {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    if (typeof Worker === 'undefined') return false;
    if (!sabAvailable()) return false;
    return true;
  } catch {
    return false;
  }
}

export interface BrowserPoolOptions {
  /** Per-kick wait budget in ms (default BROWSER_POOL_TIMEOUT_MS). */
  timeoutMs?: number;
}

export class BrowserBandPool implements BandDispatcher {
  readonly bandCount: number;
  private readonly workers: Worker[] = [];
  // Mutable (not readonly): the PERF-NEXT-2 isolation fence re-points all
  // three at a replacement SAB when quarantine abandons a buffer that live
  // workers may still be scribbling (mirrors the Node pool).
  private views: FrameAccumViews;
  private base: BandViews;
  private ctl: Int32Array;
  private readonly bands: Band[];
  private readonly timeoutMs: number;
  private readonly fbW: number;
  private readonly fbH: number;
  private seq = 0;
  private lastColormap: Uint8Array | null = null;
  private lastPalette: Uint8Array | null = null;
  private readonly pending = new Map<number, (signal: KickSignal) => void>();
  private readyCount = 0;
  private frameGen = 0;
  private mainLastGen = 0;
  private disposed = false;
  /* --- opt-in kick diagnostics (PERF-FINISH-B, instrumented-only) ---------
   *
   * All fields below are written ONLY while `diagOn` is true (harness /
   * CDP measurement). Production acceptance runs with it false: the only
   * steady-state cost is one boolean check per kick/message. No
   * per-frame allocation in either mode (fixed-size arrival array allocated
   * once at construction).
   *
   * `diagArrivals` records, per kick, the rank-ordered worker completion
   * times in ms since the kick fan-out (arrival[0] = first worker done).
   * Messages carry no band index (renderer protocol), so attribution is by
   * rank, not by band — enough to prove worker execution and expose
   * stragglers (slowest-band wait = last arrival). `diagMainMs` is the
   * calling thread's own band work for the same kick. */
  private diagOn = false;
  private readonly diagArrivals: Float64Array;
  /** Per-arrival worker-local compute durations, parallel to diagArrivals
   *  (-1 when the completion message carried none). Durations need no
   *  clock sync (origin-free); they are reported alongside — never fused
   *  with — the caller-side arrival latencies. */
  private readonly diagExec: Float64Array;
  /** Per-arrival band identity + tallies, parallel to diagArrivals (-1 when
   *  the worker message carries none — the protocol field exists, older
   *  stubs may omit it; rank order is still arrival order). */
  private readonly diagBands: Int32Array;
  private readonly diagPixels: Float64Array;
  private readonly diagSpans: Float64Array;
  /** Per-arrival message-carried identity, parallel to diagArrivals: the
   *  worker entry stamps `frame` + `job` onto each completion (see
   *  stampCompletion in render-worker.ts); the loop's own fields win when
   *  present. -1/'unknown' when the message omitted them — the kick-level
   *  diagFrame/diagJob metadata (same clock, frozen at fan-out) is the
   *  fallback. Kept for `testBandExecStats` per-band identity; the
   *  seq-keyed pending guard already drops stale-kick completions. */
  private readonly diagMsgFrame: Float64Array;
  private readonly diagMsgJob: DiagJob[];
  private diagKickStart = 0;
  private diagMainMs = -1;
  private diagArrivalsSeen = 0;
  private diagKicks = 0;
  /**
   * Frozen last-completed-kick snapshot per job kind (RELEASE-8: raster
   * vs resolve). Frozen at kick completion (diag path only); the live
   * per-kick arrays are reused by the next kick. Only completed kicks
   * freeze — failed kicks are recorded in the ledger + fallback counters.
   */
  private readonly diagFrozen: Record<DiagJob, DiagSnapshot | null> = {
    raster: null, resolve: null, unknown: null,
  };
  /** Last completed-or-failed kick's frozen snapshot (any job). Null until
   *  the first kick end after arming; null whenever disarmed. */
  private diagFrozenLast: DiagSnapshot | null = null;
  /**
   * Bounded per-kick timing ledger (PERF-NEXT-4 per-frame attribution):
   * one frozen KickTiming per kick attempt that reached dispatch
   * identity (completed/failed/disposed) plus staged pre-dispatch
   * refusals, oldest-first, capped at KICK_TIMING_CAP (drop-oldest past
   * the cap — a frame holds at most a handful of kicks). Recorded ONLY
   * while diag is armed (see enableDiag); the disabled path records
   * nothing and `kickTimings()` returns []. Frame/seq/job identity makes
   * nothing and `kickTimings()` returns []. Frame/seq/job identity makes
   * each kick attributable in order (raster flush first, then resolve).
   */
  private readonly kickLedger: KickTiming[] = [];
  /** Previous kick's completion time (same clock as kick fan-out) for
   *  gapSincePrevMs barrier/idle measurement (-1 until the first kick). */
  private diagPrevKickEnd = -1;
  /**
   * Per-band worker-local execution samples accumulated since the last
   * beginFrame (diag path only, capped): the `testBandExecStats()`
   * cross-lane surface (see @q2/testkit WorkerExecSample). Reset per
   * frame — a frame's foreground flushes each append their bands with
   * (frame, seq, job) identity, so world vs FG attribution survives.
   */
  private frameExecSamples: WorkerExecSample[] = [];
  /** Kick identity for the in-flight/last kick (same-clock metadata, always
   *  comparable: frame generation + message sequence + job type + band
   *  count, frozen at kick time). */
  private diagFrame = -1;
  private diagSeq = -1;
  private diagJob: DiagJob = 'unknown';
  private diagBandCount = 0;
  /** Monotonic kick outcomes per job kind (success = worker completion
   *  message for every band; anything else = counted fallback, never
   *  silent). Read via kickStats() for __q2stats / StageReport. */
  private readonly statKicks = { raster: 0, resolve: 0 };
  private readonly statFallbacks = { raster: 0, resolve: 0 };
  /**
   * Span entries actually inspected by successful pool kicks (Goal B):
   * worker-band sums from the CTL_SCAN slots (present post-rebuild —
   * see ctlScanOff) plus the main band's compute return. Raster lane
   * only; inline fallbacks are counted in fallbacks, not here. Compare
   * against staged spans (stagingBytes/kickBytes) to prove ordered
   * subranges skip non-owned rows.
   */
  private readonly statScanned = { raster: 0 };
  /** True once any scanned count was observed (offset or return field). */
  private scannedObserved = false;
  /** Cached CTL_SCAN slot offset, -1 when the build predates it. */
  private scanOff: number | null = null;
  /**
   * Stale-write guard (worker-failure acceptance): a timed-out kick means
   * workers whose shared-plane writes may still be in flight. The timeout
   * path quarantines FIRST - shutdown signal, replacement-buffer isolation
   * (fresh SAB, epoch bump), termination - and only then does the caller
   * restore/replay, so no straggler write can race the recovery or any
   * later frame. A bare `worker.terminate()` is NOT a completion fence
   * (fire-and-forget in browsers too), so the fence is the isolation: from
   * quarantine on, every pool view addresses the fresh SAB and late writes
   * from doomed workers land on the abandoned buffer only. All later
   * kicks refuse fast until reboot recreates the pool. Explicit refusals
   * (dead pool, empty batches) and dispose do NOT quarantine - only the
   * timeout does, since only it implies in-flight writes.
   */
  private quarantined = false;
  /**
   * Fence epoch (PERF-NEXT-2, mirrors the Node pool): incremented every
   * time quarantine isolates the shared planes onto a fresh SAB. The
   * renderer re-adopts the pool's current planes when this moves, so
   * recovery + inline fallback can never write the abandoned buffer a
   * live worker may still be scribbling. Plain counter, main thread only.
   */
  private sabEpoch = 0;
  /**
   * Cooperative-exit join state (acknowledged-stop handshake): the worker
   * entry posts `{ exited: true, band }` when its loop observes the
   * shutdown signal (CTL_SEQ < 0) and returns. `exitNeed` arms at
   * quarantine (doomed-worker count), `exitAcks` counts their exits;
   * quarantineWorkersAsync joins them with a bound (isolation already
   * fenced the planes, so the bound only limits cleanup latency).
   */
  private exitNeed = 0;
  private exitAcks = 0;
  /**
   * Cooperative-exit baseline (PERF-NEXT-2): exitAcks is a lifetime counter
   * that can include stale exits from before the quarantine (e.g. a worker
   * that threw on an earlier kick posts exited without any quarantine
   * armed). The join measures NEW acks only: exitBase snapshots exitAcks
   * when the join arms, so a stale exit can never satisfy the bound early
   * while a doomed worker still runs.
   */
  private exitBase = 0;
  /** Last completed kick's staging snapshot (see kickBytes). */
  private lastKick: {
    idxSpans: number; idxTex: number; idxLight: number; idxDescs: number;
    total: number;
  } | null = null;
  /** Frame-accum bump offsets (reset by beginFrame/flush): packed spans,
   *  staged texels/light, descriptor count. Main thread only. */
  private spansUsed = 0;
  private texUsed = 0;
  private lightUsed = 0;
  private descCount = 0;

  private constructor(
    bandCount: number, views: FrameAccumViews, ctl: Int32Array,
    bands: Band[], workers: Worker[], timeoutMs: number, fbW: number, fbH: number,
  ) {
    this.bandCount = bandCount;
    this.views = views;
    this.base = views.base;
    this.ctl = ctl;
    this.bands = bands;
    this.timeoutMs = timeoutMs;
    this.fbW = fbW;
    this.fbH = fbH;
    this.diagArrivals = new Float64Array(Math.max(1, workers.length));
    this.diagExec = new Float64Array(Math.max(1, workers.length)).fill(-1);
    this.diagBands = new Int32Array(Math.max(1, workers.length));
    this.diagPixels = new Float64Array(Math.max(1, workers.length));
    this.diagSpans = new Float64Array(Math.max(1, workers.length));
    this.diagMsgFrame = new Float64Array(Math.max(1, workers.length)).fill(-1);
    this.diagMsgJob = new Array<DiagJob>(Math.max(1, workers.length)).fill('unknown');
    for (let i = 0; i < workers.length; i++) {
      this.workers.push(workers[i]!);
      const w = workers[i]!;
      w.onmessage = (ev: MessageEvent): void => {
        const msg = ev.data as {
          seq?: unknown; ready?: unknown;
          band?: unknown; pixels?: unknown; spans?: unknown; execMs?: unknown;
          frame?: unknown; job?: unknown;
          exited?: unknown;
        };
        if (!msg || typeof msg !== 'object') return;
        if (msg.ready === true) this.readyCount += 1;
        // Cooperative-exit ack (acknowledged-stop handshake): the worker
        // entry posts this when its loop observes the shutdown signal
        // (CTL_SEQ < 0) and returns. Counts toward the quarantine join;
        // stale exits (no quarantine armed) are harmlessly counted.
        if (msg.exited === true) {
          this.exitAcks += 1;
          return;
        }
        if (typeof msg.seq === 'number') {
          // Stale-completion guard (the generation/epoch fence for
          // completion messages): the seq-keyed pending map holds an entry
          // ONLY for the live kick. A late arrival for a kick the pool
          // already abandoned (timeout quarantined it, dispose tore it
          // down, or the kick already collected) finds no entry and is
          // ignored - it must not resolve anything or pollute the armed
          // diag snapshot. Seqs never repeat (monotonic per pool), so no
          // stale completion can ever resolve a later kick.
          if (!this.pending.has(msg.seq)) return;
          if (this.diagOn && this.diagArrivalsSeen < this.diagArrivals.length) {
            const a = this.diagArrivalsSeen++;
            this.diagArrivals[a] = performance.now() - this.diagKickStart;
            this.diagBands[a] = typeof msg.band === 'number' ? msg.band | 0 : -1;
            this.diagPixels[a] = typeof msg.pixels === 'number' ? msg.pixels : -1;
            this.diagSpans[a] = typeof msg.spans === 'number' ? msg.spans : -1;
            this.diagExec[a] = typeof msg.execMs === 'number' && Number.isFinite(msg.execMs) && msg.execMs >= 0
              ? msg.execMs : -1;
            // Message-carried identity (the worker entry stamps frame + job
            // at post time; the loop's own fields win inside stampCompletion
            // — see render-worker.ts). Kick-level diagFrame/diagJob stay the
            // fallback for older builds that omit these fields.
            this.diagMsgFrame[a] = typeof msg.frame === 'number' && Number.isFinite(msg.frame)
              ? msg.frame : -1;
            this.diagMsgJob[a] = msg.job === 'raster' ||
              msg.job === 'resolve' ? msg.job : 'unknown';
          }
          const done = this.pending.get(msg.seq);
          if (done) done('ack');
        }
      };
    }
  }

  /**
   * Fixed pool: workerCount threads plus the calling thread, each owning
   * one band (workerCount + 1 bands total). Returns null (silent fallback)
   * when Workers, SAB, or cross-origin isolation are missing.
   */
  static create(workerCount: number, w: number, h: number, opts: BrowserPoolOptions = {}): BrowserBandPool | null {
    try {
      const n = Math.floor(workerCount);
      if (!Number.isFinite(n) || n < 1) return null;
      if (!browserPoolAvailable()) return null;
      const workers = Math.min(n, MAX_WORKERS);
      const sab = new SharedArrayBuffer(frameAccumTotal(w, h));
      const { views, ctl } = attachFrameAccum(sab, w, h);
      // The calling thread owns the last band; workers take the rest.
      const bands = splitBands(h, workers + 1);
      const spawned: Worker[] = [];
      try {
        for (let i = 0; i < workers; i++) {
          const b = bands[i]!;
          const worker = new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module' });
          worker.postMessage({ sab, w, h, y0: b.y0, y1: b.y1, band: i });
          spawned.push(worker);
        }
      } catch {
        for (const worker of spawned) {
          try {
            worker.terminate();
          } catch {
            /* already gone */
          }
        }
        return null;
      }
      return new BrowserBandPool(workers + 1, views, ctl, bands, spawned, opts.timeoutMs ?? BROWSER_POOL_TIMEOUT_MS, w, h);
    } catch {
      return null;
    }
  }

  /** Live shared planes (the renderer adopts these when banded + attached). */
  get planes(): { idx: Uint8Array; zb: Float32Array; color: Uint32Array } {
    return { idx: this.base.idx, zb: this.base.zb, color: this.views.fColor };
  }

  frame(): number {
    return this.frameGen;
  }

  /** Begin the frame: bump generation, drop the accumulation. */
  beginFrame(): void {
    if (this.disposed) return;
    this.frameGen += 1;
    this.resetAccum();
    // Per-frame execution samples reset here (testBandExecStats covers one
    // frame: raster first, then the resolve kick). Length-guarded so the
    // disarmed production path allocates nothing.
    if (this.frameExecSamples.length > 0) this.frameExecSamples = [];
    try {
      Atomics.store(this.ctl, CTL_FRAME, this.frameGen);
    } catch {
      /* ignore */
    }
  }

  /**
   * Sync per-batch dispatch is unsupported in the browser (the main thread
   * must never block): always null, so the caller runs the batch inline.
   * Output stays bit-identical either way.
   */
  dispatch(): { pixels: number; spans: number } | null {
    return null;
  }

  /** Same as dispatch (async per-batch is also inline — accumulation wins). */
  async dispatchAsync(): Promise<{ pixels: number; spans: number } | null> {
    return null;
  }

  /**
   * Flat-span staging cursor for fused emission (mirrors the Node pool):
   * the current bump base + remaining cap. Never advances (packBatched
   * owns that). Null when the pool is dead.
   */
  flatCursor(): { F: Float64Array; I: Int32Array; base: number; cap: number } | null {
    if (this.disposed || this.workers.length === 0) return null;
    const fv = this.views;
    return {
      F: fv.fSpansF, I: fv.fSpansI,
      base: this.spansUsed, cap: MAX_FRAME_SPANS - this.spansUsed,
    };
  }

  /**
   * Capture one fused-emitted batch into the frame kick (mirrors the Node
   * pool): spans were packed during emission, so this only stages
   * (tex, light) and records a descriptor. False = run inline immediately.
   * Never throws.
   */
  packBatched(
    spanBase: number, spanCount: number,
    tex: Texture, light: LightBlock,
    colormap: Uint8Array, time: number,
  ): boolean {
    if (this.disposed || this.workers.length === 0) return false;
    if (this.descCount >= MAX_FRAME_BATCHES) return false;
    if (!(spanCount >= 0) || spanBase !== this.spansUsed) return false;
    if (spanBase + spanCount > MAX_FRAME_SPANS) return false;
    if (spanCount === 0) return true;
    const tw = tex.width | 0, th = tex.height | 0;
    const lw = light.width | 0, lh = light.height | 0;
    if (!(tw > 0 && th > 0 && lw > 0 && lh > 0)) return false;
    const texBytes = tw * th, lightBytes = lw * lh;
    if (tex.texels.length < texBytes || light.values.length < lightBytes) return false;
    if (texBytes > FRAME_TEX_CAP - this.texUsed) return false;
    if (lightBytes > FRAME_LIGHT_CAP - this.lightUsed) return false;
    const fv = this.views;
    if (tex.texels.length === texBytes) fv.fTex.set(tex.texels, this.texUsed);
    else fv.fTex.set(tex.texels.subarray(0, texBytes), this.texUsed);
    if (light.values.length === lightBytes) fv.fLight.set(light.values, this.lightUsed);
    else fv.fLight.set(light.values.subarray(0, lightBytes), this.lightUsed);
    this.stageColormap(colormap);
    const masks = textureMasks(tex);
    const phase = ((time * 64) | 0) & (this.base.turb.length - 1);
    const dd = this.descCount * D_PER_BATCH;
    fv.desc[dd + D_SPAN_BASE] = spanBase;
    fv.desc[dd + D_SPAN_COUNT] = spanCount;
    fv.desc[dd + D_TEX_OFF] = this.texUsed;
    fv.desc[dd + D_TEX_W] = tw;
    fv.desc[dd + D_TEX_H] = th;
    fv.desc[dd + D_LIGHT_OFF] = this.lightUsed;
    fv.desc[dd + D_LIGHT_W] = lw;
    fv.desc[dd + D_LIGHT_H] = lh;
    fv.desc[dd + D_WSHIFT] = masks.wshift;
    fv.desc[dd + D_WMASK] = masks.wmask;
    fv.desc[dd + D_HMASK] = masks.hmask;
    fv.desc[dd + D_TURBPHASE] = phase;
    // Worker-owned band-cull range (mirrors Node BandPool.packBatched):
    // one integer pass over this batch's staged spans at staging time.
    // The emitter writes strictly increasing y, so this is a pure bound
    // read; workers reject non-overlapping descriptors BEFORE material/view
    // setup with no rescan. Zero range = unknown/legacy (correct fallback:
    // visit everywhere), never staged here since spanCount > 0 always
    // reaches this point. The same pass records the row-order proof
    // (D_ORDERED): non-decreasing y lets workers binary-search owned
    // subranges with no per-worker validation scan; anything else keeps the
    // full-scan fallback, output-identical.
    let ymin = 0x7fffffff;
    let ymax = -0x80000000;
    let ordered = 1;
    let prevY = -0x80000000;
    for (let s = 0; s < spanCount; s++) {
      const y = fv.fSpansI[(spanBase + s) * I_PER_SPAN + 1]!;
      if (y < ymin) ymin = y;
      if (y + 1 > ymax) ymax = y + 1;
      if (y < prevY) ordered = 0;
      prevY = y;
    }
    if (!(ymax > ymin)) { ymin = 0; ymax = 0; }
    fv.desc[dd + D_YMIN] = ymin;
    fv.desc[dd + D_YMAX] = ymax;
    fv.desc[dd + D_ORDERED] = ordered;
    this.spansUsed += spanCount;
    this.texUsed += texBytes;
    this.lightUsed += lightBytes;
    this.descCount += 1;
    return true;
  }

  /** Pending accumulated batches (observability for the renderer/tests). */
  accumPending(): number {
    return this.descCount;
  }

  /**
   * Sync frame flush is unsupported in the browser (would block): always
   * null, so the caller replays inline via drawInlineAll. The async frame
   * path uses flushFrameAsync instead.
   */
  flushFrame(): { pixels: number; spans: number } | null {
    return null;
  }

  /**
   * Kick ONE frame covering every accumulated batch and await worker
   * completion messages (never Atomics.wait — main-thread safe). Resolves
   * null when the pool is dead or the wait times out; the caller replays
   * inline via drawInlineAll, converging to identical planes. The timeout
   * path quarantines (shutdown signal + replacement-buffer isolation +
   * termination) BEFORE the caller replays, so the clear + replay below
   * runs on planes no live worker can still write.
   */
  async flushFrameAsync(): Promise<{ pixels: number; spans: number } | null> {
    if (this.disposed || this.workers.length === 0) return null;
    if (this.descCount === 0) return { pixels: 0, spans: 0 };
    if (!(await this.awaitReadyAsync())) { this.noteRefused('raster'); return null; }
    this.snapKick();
    this.publishFrame();
    const seq = this.seq;
    const finished = this.awaitWorkerMessages(seq, this.workers.length);
    if (!this.kick(seq, 'raster')) {
      this.pending.delete(seq);
      this.statFallbacks.raster += 1;
      this.noteRefused('raster');
      return null;
    }
    // Calling thread owns the last band: drain it inline while the workers
    // drain theirs, then await the workers. Same math, golden-identical.
    const mainBand = this.bands[this.bands.length - 1]!;
    this.clearMainBand(mainBand, this.fbW);
    const diagT0 = this.diagOn ? performance.now() : 0;
    const main = processFrameJob(
      this.views, this.fbW, this.fbH, this.descCount, mainBand.y0, mainBand.y1,
    );
    if (this.diagOn) this.diagMainMs = performance.now() - diagT0;
    // Timeout/disposal resolve non-'completed' (the waiter already
    // quarantined on timeout - isolation fenced the planes before any
    // caller replay; dispose tore the workers down without quarantining).
    const outcome = await finished;
    this.freezeKick(outcome);
    if (outcome !== 'completed') {
      this.statFallbacks.raster += 1;
      return null;
    }
    this.statKicks.raster += 1;
    const tally = this.tally();
    tally.pixels += main.pixels;
    tally.spans += main.spans;
    const mScan = scannedOf(main);
    if (mScan.present || this.ctlScanOff() >= 0) this.scannedObserved = true;
    tally.scanned += mScan.value;
    this.statScanned.raster += tally.scanned;
    this.resetAccum();
    return tally;
  }

  /**
   * Full-frame inline replay of the accumulated batches on the calling
   * thread (sync fallback). Clears both planes first: a timed-out kick may
   * have left bands partially drawn/cleared, and only a full clear +
   * ordered replay converges back to the identical planes.
   */
  drawInlineAll(): { pixels: number; spans: number } {
    this.base.idx.fill(0);
    this.base.zb.fill(0);
    const r = processFrameJob(this.views, this.fbW, this.fbH, this.descCount, 0, this.fbH);
    resolveBand(this.views.fColor, this.views.fPal, this.base.idx, 0, this.fbH, this.fbW, this.fbH);
    this.resetAccum();
    return r;
  }

  /** Sync resolve is unsupported in the browser (would block): false. */
  resolveFrame(): boolean {
    return false;
  }

  /** Resolve kick (parallel palette expand): message-driven completion. */
  async resolveFrameAsync(): Promise<boolean> {
    if (this.disposed || this.workers.length === 0) return false;
    if (!(await this.awaitReadyAsync())) { this.noteRefused('resolve'); return false; }
    this.publishResolve();
    const seq = this.seq;
    const finished = this.awaitWorkerMessages(seq, this.workers.length);
    if (!this.kick(seq, 'resolve')) {
      this.pending.delete(seq);
      this.statFallbacks.resolve += 1;
      this.noteRefused('resolve');
      return false;
    }
    const mainBand = this.bands[this.bands.length - 1]!;
    const diagT0 = this.diagOn ? performance.now() : 0;
    resolveBand(this.views.fColor, this.views.fPal, this.base.idx, mainBand.y0, mainBand.y1, this.fbW, this.fbH);
    if (this.diagOn) this.diagMainMs = performance.now() - diagT0;
    const outcome = await finished;
    this.freezeKick(outcome);
    if (outcome === 'completed') this.statKicks.resolve += 1;
    else this.statFallbacks.resolve += 1;
    return outcome === 'completed';
  }

  /* --- PERF-FINISH-B kick diagnostics (instrumented-only) ----------------
   *
   * `enableDiag` arms per-kick timing; `disableDiag` (default state)
   * leaves the production path untouched — a single boolean check per
   * kick/message, zero steady-state allocation. The harness (CDP stage
   * capture, Node report-only benches) enables it around measured frames
   * only; acceptance FPS is always measured with it off.
   *
   * Worker completion messages carry the band index + tallies + (since
   * PERF-NEXT-4) the worker-side `execMs` duration and the `frame`/`job`
   * identity the entry stamped at post time (see stampCompletion in
   * render-worker.ts; the renderer's in-loop fields win when present), so
   * arrivals are BOTH rank-ordered (arrivals[0] = first worker done,
   * arrivals[last] = slowest-band wait for the kick) AND band-attributed
   * (bandIds[i] names the worker that produced arrivals[i]). Unknown stubs
   * that omit the fields read -1 — rank order still holds. `workerExecMs`
   * carries the worker-local compute durations when the worker build posts
   * them (`execMs` on the completion message — a duration, comparable
   * across time origins); -1 per arrival otherwise. Dispatch-to-completion
   * latency and worker-local execution are reported side by side, never
   * fused (different clocks, different meaning).
   *
   * Within-kick straggler fields (`execMaxMs`/`execMedianMs`/`execMinMs`/
   * `execImbalanceMs`/`arrivalSpreadMs`) summarize ONE kick's per-band
   * samples only — never across kicks or phases. `diagSnapshot(job)`
   * freezes the last kick per job kind (raster vs resolve);
   * `kickTimings()` lists every kick attempt with
   * (frame, seq, job) identity + outcome for per-frame attribution;
   * `testBandExecStats()` accumulates per-band WorkerExecSample records
   * since the last beginFrame (completed kicks only) for the shared
   * @q2/testkit consumer.
   *
   * `stagingBytes` reads the live bump offsets (mid-frame view);
   * `kickBytes` returns the snapshot each indexed flush takes BEFORE
   * draining (the drain resets the offsets, so post-kick live reads are
   * zeros). Both are pure integer reads — safe on the hot path, no
   * allocation. The snapshot splits the per-frame transient upload
   * (spans/tex/light, freed after the kick). */

  /** Arm per-kick timing (harness only; production stays disarmed). */
  enableDiag(): void {
    this.diagOn = true;
    this.diagArrivalsSeen = 0;
    this.diagMainMs = -1;
    this.diagKicks = 0;
    // Fresh session: drop frozen snapshots (a re-arm must not serve the
    // previous session's kicks). The ledger stays monotonic boot-lifetime
    // evidence (seq-ordered, sliced per frame by consumers).
    this.diagFrozenLast = null;
    this.diagFrozen.raster = null;
    this.diagFrozen.resolve = null;
    this.diagFrozen.unknown = null;
  }

  /** Disarm per-kick timing (production state). */
  disableDiag(): void {
    this.diagOn = false;
  }

  /** True while per-kick timing is armed. */
  diagActive(): boolean {
    return this.diagOn;
  }

  /**
   * Last-kick diagnostic snapshot (null when disarmed or no kick ended
   * yet). With no argument returns the most recent kick of any job (the
   * historical behavior); with a job returns that job's last kick, so a
   * historical behavior); with a job returns that job's last kick. Frozen
   * at kick end (diag path only, never the production frame). See DiagSnapshot
   * for the clock-comparability contract: arrivals are
   * dispatch-to-completion latencies (scheduling included), NOT in-worker
   * compute durations; workerExecMs carries the worker-local durations
   * when posted (-1 per arrival otherwise); the exec and spread fields are
   * within-kick straggler stats over the finite workerExecMs entries.
   */
  diagSnapshot(job?: DiagJob): DiagSnapshot | null {
    if (!this.diagOn) return null;
    if (job === undefined) return this.diagFrozenLast;
    return this.diagFrozen[job] ?? null;
  }

  /** Last kick's job kind ('unknown' until the first armed kick). */
  lastKickJob(): DiagJob {
    return this.diagOn && this.diagKicks > 0 ? this.diagJob : 'unknown';
  }

  /**
   * Bounded per-kick timing ledger, oldest-first (fresh copies,
   * observability path only). Empty when disarmed. Each entry carries
   * (frame, seq, job) identity + outcome, so every foreground flush —
   * world first, then alpha/placed/entity flushes in drawForegroundAsync
   * order — is attributable per frame without summing medians.
   */
  kickTimings(): KickTiming[] {
    if (!this.diagOn) return [];
    return this.kickLedger.map((k) => ({ ...k }));
  }

  /**
   * Per-band worker-local execution samples accumulated since the last
   * beginFrame (fresh copies, observability path only). Null when
   * disarmed (unpublished — the bench keeps fencing dispatch latency);
   * [] when armed but nothing executed yet. Each sample carries
   * (frame, seq, job, worker, band, y0, y1) identity plus the measured
   * worker-side duration and actual work counts — the cross-lane
   * `WorkerExecSample` contract consumed by @q2/testkit's
   * `collectWorkerExec` (completed kicks only: partial-failure arrivals
   * are never execution proof).
   */
  testBandExecStats(): WorkerExecSample[] | null {
    if (!this.diagOn) return null;
    return this.frameExecSamples.map((s) => ({ ...s }));
  }

  /** Build the frozen snapshot for the kick that just ended (diag-gated). */
  private buildDiagSnapshot(): DiagSnapshot {
    const arrivals: number[] = [];
    const bandIds: number[] = [];
    const pixels: number[] = [];
    const spans: number[] = [];
    const workerExecMs: number[] = [];
    for (let i = 0; i < this.diagArrivalsSeen; i++) {
      arrivals.push(this.diagArrivals[i]!);
      bandIds.push(this.diagBands[i]!);
      pixels.push(this.diagPixels[i]!);
      spans.push(this.diagSpans[i]!);
      workerExecMs.push(this.diagExec[i]!);
    }
    const s = summarizeExec(workerExecMs);
    let spread = -1;
    if (arrivals.length > 0) {
      let lo = arrivals[0]!;
      let hi = arrivals[0]!;
      for (let i = 1; i < arrivals.length; i++) {
        const v = arrivals[i]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      spread = hi - lo;
    }
    return {
      kicks: this.diagKicks,
      frame: this.diagFrame,
      seq: this.diagSeq,
      job: this.diagJob,
      bands: this.diagBandCount,
      mainMs: this.diagMainMs,
      arrivals,
      bandIds,
      pixels,
      spans,
      workerExecMs,
      slowestMs: arrivals.length > 0 ? arrivals[arrivals.length - 1]! : -1,
      execMaxMs: s.max,
      execMedianMs: s.med,
      execMinMs: s.min,
      execImbalanceMs: s.max >= 0 && s.min >= 0 ? s.max - s.min : -1,
      arrivalSpreadMs: spread,
      execKnown: s.known,
      execUnknown: arrivals.length - s.known,
    };
  }

  /**
   * Freeze the kick that just ended: per-job + last-kick snapshots, the
   * ledger entry and (completed kicks only) the per-band execution
   * samples. No-op when disarmed — the disabled path records nothing.
   */
  private freezeKick(outcome: 'completed' | 'failed' | 'disposed'): void {
    if (!this.diagOn) return;
    const snap = this.buildDiagSnapshot();
    this.diagFrozenLast = snap;
    this.diagFrozen[this.diagJob] = snap;
    const now = performance.now();
    const gap = this.diagPrevKickEnd >= 0 && Number.isFinite(now) ? now - this.diagPrevKickEnd : -1;
    this.diagPrevKickEnd = Number.isFinite(now) ? now : this.diagPrevKickEnd;
    const entry: KickTiming = {
      frame: snap.frame,
      seq: snap.seq,
      job: snap.job,
      bands: snap.bands,
      outcome,
      mainMs: snap.mainMs,
      execMaxMs: snap.execMaxMs,
      execMedianMs: snap.execMedianMs,
      execMinMs: snap.execMinMs,
      slowestMs: snap.slowestMs,
      spreadMs: snap.arrivalSpreadMs,
      gapSincePrevMs: gap,
      execKnown: snap.execKnown,
      execUnknown: snap.execUnknown,
    };
    this.kickLedger.push(entry);
    if (this.kickLedger.length > KICK_TIMING_CAP) this.kickLedger.splice(0, this.kickLedger.length - KICK_TIMING_CAP);
    if (outcome === 'completed') this.appendExecSamples(snap);
  }

  /**
   * Record a pre-dispatch refusal (staging existed but nothing fanned
   * out — checkpoint failure, never-ready workers, declined notify).
   * No arrivals, no main-band work; identity is (frame, pending seq,
   * job). No-op when disarmed.
   */
  private noteRefused(job: DiagJob): void {
    if (!this.diagOn) return;
    const now = performance.now();
    const gap = this.diagPrevKickEnd >= 0 && Number.isFinite(now) ? now - this.diagPrevKickEnd : -1;
    this.kickLedger.push({
      frame: this.frameGen,
      seq: this.seq,
      job,
      bands: this.bands.length,
      outcome: 'refused',
      mainMs: -1,
      execMaxMs: -1,
      execMedianMs: -1,
      execMinMs: -1,
      slowestMs: -1,
      spreadMs: -1,
      gapSincePrevMs: gap,
      execKnown: 0,
      execUnknown: 0,
    });
    if (this.kickLedger.length > KICK_TIMING_CAP) this.kickLedger.splice(0, this.kickLedger.length - KICK_TIMING_CAP);
  }

  /**
   * Append one completed kick's per-band worker samples to the
   * per-frame accumulation (diag path only). Bands with unusable
   * durations or tallies are skipped (unknown is never execution
   * proof); an unmappable job drops the whole kick (the testkit
   * consumer rejects malformed jobs, so we never emit them).
   */
  private appendExecSamples(snap: DiagSnapshot): void {
    const crit = diagJobToCritJob(snap.job);
    if (crit === null) return;
    for (let i = 0; i < snap.arrivals.length; i++) {
      if (this.frameExecSamples.length >= FRAME_EXEC_CAP) return;
      const band = snap.bandIds[i]!;
      const execMs = snap.workerExecMs[i]!;
      const pixels = snap.pixels[i]!;
      const spans = snap.spans[i]!;
      if (!(band >= 0) || !Number.isInteger(band) || band >= this.bands.length) continue;
      if (!(execMs >= 0) || !Number.isFinite(execMs)) continue;
      if (!(pixels >= 0) || !Number.isFinite(pixels)) continue;
      if (!(spans >= 0) || !Number.isFinite(spans)) continue;
      const b = this.bands[band]!;
      const frame = this.diagMsgFrame[i]! >= 0 ? this.diagMsgFrame[i]! : snap.frame;
      this.frameExecSamples.push({
        frame, seq: snap.seq, job: crit,
        worker: band, band, y0: b.y0, y1: b.y1,
        execMs, pixels, spans,
      });
    }
  }

  /**
   * Monotonic kick outcomes per job kind (successes + counted fallbacks)
   * plus the quarantine flag. Fresh small object per call (observability
   * path only — publishQ2Stats / StageReport sample it once per frame, not
   * per pixel). Fallbacks are counted, never silent: any nonzero fallback
   * with healthy output proves the inline/serial path executed.
   *
   * `scanned` accumulates span entries actually inspected by successful
   * raster kicks (workers + main band); `scannedAvailable` reports
   * whether the build exposes the counters at all (false on older
   * builds — then `scanned` reads 0 and must NOT be mistaken for proof).
   *
   * `epoch` is the fence epoch (see recoveryEpoch): 0 until the first
   * quarantine isolation moves the pool onto a replacement SAB.
   *
   * `exits` counts cooperative worker exits observed (`{ exited: true }`
   * after the shutdown signal) - the acknowledged-stop proof the bounded
   * join waits for. 0 until a quarantine arms the join.
   */
  kickStats(): {
    kicks: { raster: number; resolve: number };
    fallbacks: { raster: number; resolve: number };
    scanned: { raster: number };
    scannedAvailable: boolean;
    quarantined: boolean;
    epoch: number;
    exits: number;
  } {
    return {
      kicks: { ...this.statKicks },
      fallbacks: { ...this.statFallbacks },
      scanned: { ...this.statScanned },
      scannedAvailable: this.scannedObserved,
      quarantined: this.quarantined,
      epoch: this.recoveryEpoch(),
      exits: this.exitAcks,
    };
  }

  /**
   * Bytes staged for the current (unflushed) frame kick (indexed lane).
   * Pure reads — safe to sample per frame with no behavior change.
   * Span slots are F_PER_SPAN f64 + I_PER_SPAN i32 (124 B); tex/light
   * are exact bump bytes.
   * NOTE: post-kick the offsets are reset, so this reads zeros then — use
   * `kickBytes()` for the last completed kick.
   */
  stagingBytes(): {
    idxSpans: number; idxTex: number; idxLight: number; idxDescs: number;
    total: number;
  } {
    return snapshotStaging(
      this.spansUsed, this.texUsed, this.lightUsed, this.descCount,
    );
  }

  /**
   * Last completed kick's staging snapshot (null until the first
   * indexed flush). Same shape as `stagingBytes`; frozen at flush
   * time, so post-kick sampling still reports the real per-frame upload.
   */
  kickBytes(): {
    idxSpans: number; idxTex: number; idxLight: number; idxDescs: number;
    total: number;
  } | null {
    return this.lastKick;
  }

  /** Freeze the current staging offsets as the last-kick snapshot. */
  private snapKick(): void {
    this.lastKick = snapshotStaging(
      this.spansUsed, this.texUsed, this.lightUsed, this.descCount,
    );
  }

  /** Shut workers down; safe to call twice.
   *
   * In-flight kicks resolve as failures immediately (callers fall back to
   * the identical inline replay) instead of hanging until the kick timeout:
   * reboot/stop between frames can never wedge the loop for `timeoutMs`.
   * Dispose terminates WITHOUT quarantining (teardown, not wedged workers):
   * the in-flight failure path restores its checkpoint onto planes whose
   * writers were just torn down.
   */
  async dispose(): Promise<void> {    if (this.disposed) return;
    this.disposed = true;
    for (const done of this.pending.values()) {
      try {
        done('abort');
      } catch {
        /* a throwing waiter must not block teardown */
      }
    }
    this.pending.clear();
    try {
      Atomics.store(this.ctl, CTL_SEQ, -1);
      try {
        Atomics.notify(this.ctl, CTL_SEQ, this.workers.length);
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
    for (const worker of this.workers) {
      try {
        worker.terminate();
      } catch {
        /* already gone */
      }
    }
    this.workers.length = 0;
    this.pending.clear();
  }

  /** Stage the palette for worker-side resolve (change-detected, 768B). */
  stagePalette(palette: Uint8Array): void {
    if (this.disposed) return;
    if (this.lastPalette !== palette) {
      this.views.fPal.set(palette.subarray(0, this.views.fPal.length));
      this.lastPalette = palette;
    }
  }

  /** Await worker readiness without blocking (message-driven). */
  private awaitReadyAsync(): Promise<boolean> {
    if (this.readyCount >= this.workers.length) return Promise.resolve(true);
    if (Atomics.load(this.ctl, CTL_READY) >= this.workers.length) {
      this.readyCount = this.workers.length;
      return Promise.resolve(true);
    }
    const deadline = Date.now() + this.timeoutMs;
    return new Promise<boolean>((resolve) => {
      const poll = (): void => {
        if (this.disposed) {
          resolve(false);
          return;
        }
        if (this.readyCount >= this.workers.length ||
          Atomics.load(this.ctl, CTL_READY) >= this.workers.length) {
          this.readyCount = this.workers.length;
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        window.setTimeout(poll, 10);
      };
      poll();
    });
  }

  /**
   * Await every worker's completion message for one kick (async path).
   * Timeout quarantines the pool FIRST (see `quarantined`: shutdown signal
   * + replacement-buffer isolation + termination) and only then resolves
   * the failure - the caller's restore/replay after this runs on planes no
   * live worker can still write. Dispose aborts in-flight waits as
   * 'disposed' without quarantining (the pool is already being torn down).
   * Completions for any other seq are ignored by the stale-completion guard
   * in onmessage (the seq-keyed pending entry exists only for the live
   * kick), so a late message can never resolve a later kick.
   */
  private awaitWorkerMessages(seq: number, need: number): Promise<KickOutcome> {
    let seen = 0;
    return new Promise<KickOutcome>((resolve) => {
      let timer = 0;
      const finish = (outcome: KickOutcome): void => {
        this.pending.delete(seq);
        window.clearTimeout(timer);
        resolve(outcome);
      };
      timer = window.setTimeout(() => {
        if (this.disposed) {
          finish('disposed');
          return;
        }
        // Fence FIRST: stop/isolate writers before any restore or replay.
        this.quarantineWorkers();
        finish('failed');
      }, this.timeoutMs);
      this.pending.set(seq, (signal: KickSignal) => {
        if (signal === 'abort') {
          finish(this.disposed ? 'disposed' : 'failed');
          return;
        }
        seen += 1;
        if (seen >= need) finish('completed');
      });
    });
  }

  /**
   * Fence epoch for the shared planes (PERF-NEXT-2, mirrors the Node pool):
   * increments whenever quarantine isolates the planes onto a replacement
   * SAB. The renderer re-adopts the pool's current planes when this moves.
   * Monotonic on the main thread; 0 until the first quarantine.
   */
  recoveryEpoch(): number {
    return typeof this.sabEpoch === 'number' ? this.sabEpoch : 0;
  }

  /**
   * Await completed termination of the quarantined workers (bounded join,
   * mirrors the Node pool): resolves once every doomed worker's
   * cooperative exit is observed (`{ exited: true }` after the shutdown
   * signal), or after a bounded wait. Isolation already fenced the shared
   * planes, so the bound only limits cleanup latency, never safety. Never
   * rejects; safe to call twice or without a prior quarantine (runs it).
   * The sync path cannot await - it relies on the isolation fence alone.
   */
  async quarantineWorkersAsync(timeoutMs?: number): Promise<void> {
    this.quarantineWorkers();
    const target = this.exitBase + this.exitNeed;
    if (this.exitNeed <= 0 || this.exitAcks >= target) return;
    let bound = typeof timeoutMs === 'number' && timeoutMs > 0
      ? timeoutMs
      : Math.min(this.timeoutMs, 1000);
    if (!(bound > 0)) bound = 250;
    if (bound > 5000) bound = 5000;
    try {
      const deadline = performance.now() + bound;
      while (this.exitAcks < target) {
        if (this.disposed) return;
        if (performance.now() >= deadline) return;
        await new Promise<void>((r) => {
          window.setTimeout(r, 5);
        });
      }
    } catch {
      /* bounded join only; isolation already fenced the planes */
    }
  }

  /**
   * Terminate every worker and refuse all later kicks fast (see
   * `quarantined`). Called on kick timeout - the one failure mode that
   * implies in-flight worker writes - and by quarantineWorkersAsync.
   * Safe to call twice; never throws.
   *
   * PERF-NEXT-2 fence (mirrors the Node pool): `worker.terminate()` alone
   * is NOT a completion fence - the main thread would restore/replay over
   * shared planes a live worker may still be writing. So this first sends
   * the cooperative shutdown signal (CTL_SEQ < 0 wakes workers blocked in
   * Atomics.wait so they exit instead of draining a stale kick), then
   * isolates the shared planes onto a fresh SAB (staging/descriptors copied
   * verbatim - workers only read those - output planes cleared, control
   * reset, epoch bumped), and only then terminates. Termination of the
   * abandoned buffer's writers is observable via quarantineWorkersAsync;
   * isolation makes the restore/replay safe immediately. One extra SAB is
   * retained until the doomed workers exit (bounded: a pool quarantines at
   * most once, and beginFrame never clears the flag).
   */
  private quarantineWorkers(): void {
    if (this.quarantined && this.workers.length === 0) return;
    this.quarantined = true;
    // Cooperative shutdown signal for workers blocked in Atomics.wait:
    // they observe SEQ < 0 on wake and exit instead of draining a stale
    // kick. Workers mid-raster cannot observe it - isolation covers them.
    try {
      Atomics.store(this.ctl, CTL_SEQ, -1);
      try {
        Atomics.notify(this.ctl, CTL_SEQ, this.workers.length);
      } catch {
        /* workers may already be awake */
      }
    } catch {
      /* ignore */
    }
    const doomed = this.workers.slice();
    this.workers.length = 0;
    this.pending.clear();
    // Arm the cooperative-exit join before terminating. Baseline the
    // lifetime ack counter so only NEW exits satisfy the bound.
    this.exitNeed = doomed.length;
    this.exitBase = this.exitAcks;
    // Replacement-buffer fence BEFORE termination: from here on, every pool
    // view (planes, staging, control) addresses the fresh SAB. Late writes
    // from doomed workers land on the abandoned buffer only.
    this.isolateSharedPlanes();
    for (const worker of doomed) {
      try {
        worker.terminate();
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * Replacement-buffer fence (main thread only, quarantine path; mirrors
   * the Node pool): move the pool onto a fresh SAB, copying the old buffer
   * verbatim, then clearing the output planes and resetting control in the
   * fresh copy. Workers only READ staging/descriptors (stable - the main
   * thread never mutates them mid-kick), so a torn copy of the plane bytes
   * is harmless: the caller replays inline deterministically from staging.
   * Never throws; on any failure the pool keeps the old buffer (termination
   * still proceeds - best effort, never silent about the quarantine flag).
   */
  private isolateSharedPlanes(): void {
    try {
      const oldCtl = this.ctl;
      if (!oldCtl || !(oldCtl.buffer instanceof SharedArrayBuffer)) return;
      const oldBuf = oldCtl.buffer as SharedArrayBuffer;
      const size = frameAccumTotal(this.fbW, this.fbH);
      if (!(size > 0) || oldBuf.byteLength < size) return;
      const fresh = new SharedArrayBuffer(size);
      new Uint8Array(fresh).set(new Uint8Array(oldBuf));
      const { views } = attachFrameAccum(fresh, this.fbW, this.fbH);
      this.views = views;
      this.base = views.base;
      this.ctl = views.ctl;
      try {
        Atomics.store(this.ctl, CTL_SEQ, this.seq);
        Atomics.store(this.ctl, CTL_DONE, 0);
        Atomics.store(this.ctl, CTL_READY, 0);
        Atomics.store(this.ctl, CTL_FRAME, this.frameGen);
        Atomics.store(this.ctl, CTL_FCOUNT, 0);
        Atomics.store(this.ctl, CTL_COUNT, 0);
        Atomics.store(this.ctl, CTL_JOB, JOB_RASTER);
      } catch {
        /* ignore */
      }
      // Discard the copied partial plane writes: the caller replays inline
      // deterministically from staging.
      try {
        this.base.idx.fill(0);
        this.base.zb.fill(0);
        this.views.fColor.fill(0);
      } catch {
        /* ignore */
      }
      // The fresh buffer is fully cleared: the lazy main-band clear must
      // not skip this generation.
      this.mainLastGen = this.frameGen;
      this.sabEpoch = (typeof this.sabEpoch === 'number' ? this.sabEpoch : 0) + 1;
    } catch {
      /* terminate-only fallback */
    }
  }

  /** Lazily clear the calling thread's band once per frame generation. */
  private clearMainBand(mainBand: Band, fbW: number): void {
    if (this.mainLastGen !== this.frameGen) {
      this.base.idx.fill(0, mainBand.y0 * fbW, mainBand.y1 * fbW);
      this.base.zb.fill(0, mainBand.y0 * fbW, mainBand.y1 * fbW);
      this.mainLastGen = this.frameGen;
    }
  }

  /** Drop accumulated batches (beginFrame + post-kick reset). */
  private resetAccum(): void {
    this.spansUsed = 0;
    this.texUsed = 0;
    this.lightUsed = 0;
    this.descCount = 0;
    try {
      Atomics.store(this.ctl, CTL_FCOUNT, 0);
      Atomics.store(this.ctl, CTL_JOB, JOB_RASTER);
    } catch {
      /* ignore */
    }
  }

  /** Stage the colormap once per backing store (surface blocks change, it does not). */
  private stageColormap(colormap: Uint8Array): void {
    if (this.lastColormap !== colormap) {
      this.base.colormap.set(colormap.subarray(0, this.base.colormap.length));
      this.lastColormap = colormap;
    }
  }

  /** Publish the frame-kick descriptor (main side, pre-notify). */
  private publishFrame(): void {
    try {
      Atomics.store(this.ctl, CTL_FBW, this.fbW);
      Atomics.store(this.ctl, CTL_FBH, this.fbH);
      Atomics.store(this.ctl, CTL_JOB, JOB_RASTER);
      Atomics.store(this.ctl, CTL_FCOUNT, this.descCount);
    } catch {
      /* ignore */
    }
    this.seq += 1;
  }

  /** Publish a resolve kick (main side, pre-notify). */
  private publishResolve(): void {
    try {
      Atomics.store(this.ctl, CTL_FBW, this.fbW);
      Atomics.store(this.ctl, CTL_FBH, this.fbH);
      Atomics.store(this.ctl, CTL_JOB, JOB_RESOLVE);
    } catch {
      /* ignore */
    }
    this.seq += 1;
  }

  /** Wake workers for one kick (Atomics-only: workers block in Atomics.wait). */
  private kick(seq: number, job: DiagJob = 'unknown'): boolean {
    try {
      Atomics.store(this.ctl, CTL_DONE, 0);
      Atomics.store(this.ctl, CTL_SEQ, seq);
    } catch {
      return false;
    }
    if (this.diagOn) {
      this.diagKickStart = performance.now();
      this.diagArrivalsSeen = 0;
      this.diagMainMs = -1;
      this.diagKicks += 1;
      this.diagFrame = this.frameGen;
      this.diagSeq = seq;
      this.diagJob = job;
      this.diagBandCount = this.bands.length;
    }
    try {
      Atomics.notify(this.ctl, CTL_SEQ, this.workers.length);
    } catch {
      /* workers may already be awake */
    }
    return true;
  }

  private tally(): { pixels: number; spans: number; scanned: number } {
    // CTL_PIXELS + i / CTL_SPANS + i per-worker tallies (see bands.ts layout).
    // CTL_SCAN + i per-worker inspected-span counts.
    // WORKER BANDS ONLY: the loop sums this pool's worker slots (never the
    // calling-thread band). Callers freeze this worker share BEFORE merging
    // the main-band drain into the combined totals, so the main band can
    // never read as worker-completed.
    let pixels = 0;
    let spans = 0;
    let scanned = 0;
    const off = this.ctlScanOff();
    for (let i = 0; i < this.workers.length; i++) {
      pixels += this.ctl[CTL_PIXELS + i]!;
      spans += this.ctl[CTL_SPANS + i]!;
      if (off >= 0) {
        const s = this.ctl[off + i]!;
        if (typeof s === 'number' && Number.isFinite(s) && s >= 0) scanned += s;
      }
    }
    return { pixels, spans, scanned };
  }

  /**
   * CTL_SCAN slot offset, resolved once via the module-namespace probe
   * (-1 when the build predates the renderer lane's inspected-span
   * counters). Never throws; the offset and the SAB region always come
   * from the same package build at runtime, so a present offset is
   * always in-bounds.
   */
  private ctlScanOff(): number {
    if (this.scanOff === null) {
      let off = -1;
      try {
        const ns = swRendererNS as unknown as Record<string, unknown>;
        const v = ns['CTL_SCAN'];
        if (typeof v === 'number' && Number.isInteger(v) && v > 0) off = v;
      } catch {
        /* older build: scanned aggregation stays off */
      }
      this.scanOff = off;
    }
    return this.scanOff;
  }
}

/**
 * Feature-detected `scanned` on a compute return (renderer lane task 2):
 * post-rebuild `processFrameJob` returns carry span
 * entries actually inspected (workers skip non-owned ordered subranges),
 * older builds return `{ pixels, spans }` only. Never throws.
 */
function scannedOf(r: { pixels: number; spans: number }): { value: number; present: boolean } {
  const s = (r as unknown as { scanned?: unknown }).scanned;
  return typeof s === 'number' && Number.isFinite(s) && s >= 0
    ? { value: s, present: true }
    : { value: 0, present: false };
}

/**
 * Build a staging-bytes snapshot from bump offsets (shared by the live
 * `stagingBytes` view and the frozen per-kick `kickBytes` snapshot).
 * Span slots are F_PER_SPAN f64 + I_PER_SPAN i32 (124 B).
 */
function snapshotStaging(
  spansUsed: number, texUsed: number, lightUsed: number, descCount: number,
): {
  idxSpans: number; idxTex: number; idxLight: number; idxDescs: number;
  total: number;
} {
  const perSpan = F_PER_SPAN * 8 + I_PER_SPAN * 4;
  const idxSpans = spansUsed * perSpan;
  const total = idxSpans + texUsed + lightUsed;
  return {
    idxSpans, idxTex: texUsed, idxLight: lightUsed,
    idxDescs: descCount,
    total,
  };
}
