// q2ts-web browser band pool (M8.1 browser lane).
//
// Web-Worker implementation of the sw-renderer BandDispatcher contract:
// frame-level batch accumulation captured on the main thread during
// geometry, drained by N workers + the main thread in ONE kick per frame
// (flushFrameAsync), plus a parallel resolve kick (resolveFrameAsync).
// The SAB layout, descriptor protocol and worker loop are shared with the
// Node pool (attachFrameAccum, processFrameJob, resolveBand,
// bandWorkerLoop in @q2/sw-renderer) — only the thread management differs
// (DOM Workers + message-driven completion instead of worker_threads +
// Atomics.wait, which is forbidden on the main thread).
//
// Headless-safe: create() returns null anywhere Workers, SAB or
// cross-origin isolation are missing (Node/vitest, non-COOP/COEP pages),
// and every caller falls back to the inline banded path with identical
// output. Sync kick methods (dispatch/flushFrame/resolveFrame) return
// null/false — the renderer replays inline; only the Async methods kick.

import {
  CTL_COUNT,
  CTL_DONE,
  CTL_FBH,
  CTL_FBW,  CTL_FCOUNT,
  CTL_FRAME,
  CTL_JOB,
  CTL_PIXELS,
  CTL_READY,
  CTL_RGBBASE,
  CTL_RGBCOUNT,
  CTL_SEQ,
  CTL_SPANS,
  CTL_TRIS,
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
  JOB_RGB,
  JOB_SCANOUT,
  MAX_FRAME_BATCHES,
  MAX_FRAME_SPANS,
  MAX_WORKERS,
  MAX_RGB_BATCHES,
  MAX_RGB_SPANS,
  RGB_CHAIN_CAP,
  RGB_LUX_CAP,
  RGB_MAX_CHAINS,
  RGB_MAX_LEVELS,
  C_LEVEL_BASE,
  C_LEVEL_COUNT,
  C_PER_CHAIN,
  L_DATA_OFF,
  L_H,
  L_MASK_OFF,
  L_PER_LEVEL,
  L_W,
  R_CHAIN,
  R_FLAGS,
  R_FLAG_ADDITIVE,
  R_FLAG_BLEND_ALPHA,
  R_FLAG_TRI,
  R_ALPHAQ,
  R_FLATRGB,
  R_LUX_H,
  R_LUX_OFF,
  R_LUX_W,
  R_ORDERED,
  R_PER_BATCH,
  R_SPAN_BASE,
  R_SPAN_COUNT,
  R_TURBPHASE,
  R_YMAX,
  R_YMIN,
  R_ZBITS,
  I_PER_SPAN,
  attachFrameAccum,
  attachRGBAccum,
  frameAccumTotal,
  rgbAccumTotal,
  packFrameSpans,
  processFrameJob,
  processRGBFrameJob,
  processScanoutBand,
  resolveBand,
  resolveBandFused,
  sabAvailable,
  splitBands,
  textureMasks,
  type Band,
  type BandDispatcher,
  type BandViews,
  type FrameAccumViews,
  type RGBAccumViews,
  type ScanoutBandOptions,
  type LightBlock,
  type SpanList,
  type Texture,
  type RGBMipLevel,
  TRI_I_PER_TRI,
  TRI_MAX_TRIS,
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
export type { ScanoutBandOptions } from '@q2/sw-renderer';
import { readVoodooState } from '@q2/voodoo';
import type { VoodooState } from '@q2/voodoo';

/** Per-batch wait budget in ms (mirrors the Node pool default). */
export const BROWSER_POOL_TIMEOUT_MS = 30000;

/** Job kinds the browser pool can kick (labels the diag snapshot). */
export type DiagJob = 'raster' | 'rgb' | 'resolve' | 'scanout' | 'unknown';

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
 * equal in-worker compute: true per-worker compute durations need
 * worker-side timestamps, which only the renderer lane can add — the
 * worker loop in `@q2/sw-renderer` owns the compute section.
 * `workerExecMs` carries those worker-local compute durations when the
 * worker build posts them (`execMs` on the completion message — a
 * duration, so it is comparable across time origins without clock
 * sync); -1 per arrival when the message omitted it (older builds or
 * control-only stubs). `bandIds`, `pixels` and `spans` parallel
 * `arrivals` with the band identity + tallies the worker message carried
 * (-1 when the message omitted them). `slowestMs` is the critical path
 * (dispatch → last completion).
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
  // four at a replacement SAB when quarantine abandons a buffer that live
  // workers may still be scribbling (mirrors the Node pool).
  private views: FrameAccumViews;
  private rgbViews: RGBAccumViews;
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
  private diagKickStart = 0;
  private diagMainMs = -1;
  private diagArrivalsSeen = 0;
  private diagKicks = 0;
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
  private readonly statKicks = { raster: 0, rgb: 0, resolve: 0, scanout: 0 };
  private readonly statFallbacks = { raster: 0, rgb: 0, resolve: 0, scanout: 0 };
  /** Staging refusals before dispatch (pool alive, regions exhausted — the
   *  caller replays pending inline first, so order is preserved). Monotonic;
   *  read via kickStats().refusals. Dead-pool declines are NOT counted. */
  private statRgbRefusals = 0;
  /** Most recent RGB kick outcome (null until the first RGB kick starts).
   *  `descs` = staged batches the kick covered; `workerCompleted` = every
   *  worker acked its band (true only then — staging is never counted as
   *  execution); `mainPixels`/`mainSpans` = the calling thread's own band
   *  contribution to the same kick. Lets the shell attribute execution
   *  without mistaking staging for proof. */
  private lastRgbKick: {
    descs: number; workerCompleted: boolean; mainPixels: number; mainSpans: number;
  } | null = null;
  /**
   * Span entries actually inspected by successful pool kicks (Goal B):
   * worker-band sums from the CTL_SCAN slots (present post-rebuild —
   * see ctlScanOff) plus the main band's compute return. Raster + RGB
   * lanes only; inline fallbacks are counted in rgbInline/fallbacks, not
   * here. Compare against staged spans (stagingBytes/kickBytes) to prove
   * ordered subranges skip non-owned rows.
   */
  private readonly statScanned = { raster: 0, rgb: 0 };
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
   * timeout does, since only it implies in-flight writes. The RGB async
   * path additionally joins completed termination (bounded, best-effort
   * proof the doomed workers are gone); other paths rely on the isolation
   * fence alone.
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
    rgbSpans: number; rgbChains: number; rgbLux: number; rgbDescs: number;
    total: number;
  } | null = null;
  /** Frame-accum bump offsets (reset by beginFrame/flush): packed spans,
   *  staged texels/light, descriptor count. Main thread only. */
  private spansUsed = 0;
  private texUsed = 0;
  private lightUsed = 0;
  private descCount = 0;
  /** RGB staging bump offsets (reset by beginFrame/commitRGB). */
  private rgbSpansUsed = 0;
  private rgbChainUsed = 0;
  private rgbChainLevels = 0;
  private rgbChainSlots = 0;
  private rgbLuxUsed = 0;
  private rgbDescCount = 0;
  private rgbTriUsed = 0;
  private rgbChainMap = new Map<RGBMipLevel[], number>();
  /** Retained-frame watermark: descriptors [0, flushed) hold plane writes. */
  private rgbFlushedCount = 0;
  /** Last RGB flush outcome: 'clean' = refused/clean-failure (staging
   *  refusal, checkpoint allocation failure, never-ready, declined or
   *  pre-dispatch dispose — nothing was dispatched), 'partial' =
   *  partial-failure (timeout or mid-flight dispose — writes may have
   *  landed; quarantined first except the dispose teardown path), null =
   *  success or no kick yet. Mirrors the Node pool vocabulary. */
  private rgbFailure: 'clean' | 'partial' | null = null;
  /**
   * RGB checkpoint/restore (foreground-recovery design, TASK item 1):
   * owned CPU-side copies of the shared RGB planes taken synchronously on
   * the main thread BEFORE each RGB kick notifies workers (so no worker
   * write can precede the snapshot). On kick failure AFTER possible
   * partial writes (timeout, lost completion) the pool restores the
   * pre-kick planes, keeps the still-pending descriptors, and returns
   * null — the caller's `drawInlineRGBAll` then replays the failed kick's
   * batches exactly once on top of the committed earlier kicks (world
   * intact, blend order kept, alpha applied once).
   *
   * Why a checkpoint instead of replay-all: the pending descriptors cover
   * only the batches staged since the last successful kick (earlier kicks
   * already reset the staging), so a plain replay would lose the committed
   * world; re-running the world would double its cost every recovery.
   * Why not just drop the clear: that alone does not undo partial worker
   * writes (already-blended translucent pixels would blend twice).
   *
   * `gen` is the frame generation at snapshot time; restore is refused
   * when the generation moved on (stale recovery racing the next frame).
   * Allocated lazily on the first RGB kick; discarded on beginFrame,
   * successful kicks, and inline replays.
   */
  private rgbSnap: {
    rgb565: Uint16Array; cover: Uint8Array; rgbDepth: Uint16Array;
    gen: number;
  } | null = null;

  private constructor(
    bandCount: number, views: FrameAccumViews, rgbViews: RGBAccumViews, ctl: Int32Array,
    bands: Band[], workers: Worker[], timeoutMs: number, fbW: number, fbH: number,
  ) {
    this.bandCount = bandCount;
    this.views = views;
    this.rgbViews = rgbViews;
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
    for (let i = 0; i < workers.length; i++) {
      this.workers.push(workers[i]!);
      const w = workers[i]!;
      w.onmessage = (ev: MessageEvent): void => {
        const msg = ev.data as {
          seq?: unknown; ready?: unknown;
          band?: unknown; pixels?: unknown; spans?: unknown; execMs?: unknown;
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
      const sab = new SharedArrayBuffer(rgbAccumTotal(w, h));
      const { views, ctl } = attachFrameAccum(sab, w, h);
      const { views: rgbViews } = attachRGBAccum(sab, w, h);
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
      return new BrowserBandPool(workers + 1, views, rgbViews, ctl, bands, spawned, opts.timeoutMs ?? BROWSER_POOL_TIMEOUT_MS, w, h);
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

  /** Begin the frame: bump generation, drop both accumulations. */
  beginFrame(): void {
    if (this.disposed) return;
    this.frameGen += 1;
    this.resetAccum();
    this.resetRGB();
    // A new frame clears the planes (renderer-owned clear): any checkpoint
    // from the previous frame is stale by construction (generation guard
    // would refuse it anyway — drop it eagerly).
    this.discardSnapshot();
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
    if (!(await this.awaitReadyAsync())) return null;
    this.snapKick();
    this.publishFrame();
    const seq = this.seq;
    const finished = this.awaitWorkerMessages(seq, this.workers.length);
    if (!this.kick(seq, 'raster')) {
      this.pending.delete(seq);
      this.statFallbacks.raster += 1;
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

  /** Resolve kick (parallel palette expand + fused RGB composite): message-driven completion. */
  async resolveFrameAsync(): Promise<boolean> {
    if (this.disposed || this.workers.length === 0) return false;
    if (!(await this.awaitReadyAsync())) return false;
    this.publishResolve();
    const seq = this.seq;
    const finished = this.awaitWorkerMessages(seq, this.workers.length);
    if (!this.kick(seq, 'resolve')) {
      this.pending.delete(seq);
      this.statFallbacks.resolve += 1;
      return false;
    }
    const mainBand = this.bands[this.bands.length - 1]!;
    const diagT0 = this.diagOn ? performance.now() : 0;
    resolveBandFused(this.views.fColor, this.views.fPal, this.base.idx, this.rgbViews.rgb565, this.rgbViews.cover, mainBand.y0, mainBand.y1, this.fbW, this.fbH);
    if (this.diagOn) this.diagMainMs = performance.now() - diagT0;
    const outcome = await finished;
    if (outcome === 'completed') this.statKicks.resolve += 1;
    else this.statFallbacks.resolve += 1;
    return outcome === 'completed';
  }

  /** Live shared RGB planes (the renderer adopts these when banded + attached). */
  get rgbPlanes(): { rgb565: Uint16Array; cover: Uint8Array; rgbDepth: Uint16Array } {
    return {
      rgb565: this.rgbViews.rgb565,
      cover: this.rgbViews.cover,
      rgbDepth: this.rgbViews.rgbDepth,
    };
  }

  /** Live shared scanout buffers (Track A: workers write the presented frame directly). */
  get scanoutPlanes(): { scan565: Uint16Array; scanDisplay: Uint32Array } {
    return {
      scan565: this.rgbViews.scan565,
      scanDisplay: this.rgbViews.scanDisplay,
    };
  }

  /** Sync scanout unsupported in the browser (would block): false. */
  flushScanout(): boolean {
    return false;
  }

  /**
   * Parallel scanout kick (Track A, message-driven): fused pack→recon→gamma
   * from the finished shared color plane into the shared scanout buffers.
   * False when dead/timed out (caller runs the serial voodoo path).
   */
  async flushScanoutAsync(opts: ScanoutBandOptions): Promise<boolean> {
    if (this.disposed || this.workers.length === 0) return false;
    if (!(await this.awaitReadyAsync())) return false;
    this.publishScanout(opts);
    const seq = this.seq;
    const finished = this.awaitWorkerMessages(seq, this.workers.length);
    if (!this.kick(seq, 'scanout')) {
      this.pending.delete(seq);
      this.statFallbacks.scanout += 1;
      return false;
    }
    const mainBand = this.bands[this.bands.length - 1]!;
    const diagT0 = this.diagOn ? performance.now() : 0;
    processScanoutBand(
      this.views.fColor, this.rgbViews.scan565, this.rgbViews.scanDisplay,
      this.fbW, this.fbH, opts, mainBand.y0, mainBand.y1,
    );
    if (this.diagOn) this.diagMainMs = performance.now() - diagT0;
    const outcome = await finished;
    if (outcome === 'completed') this.statKicks.scanout += 1;
    else this.statFallbacks.scanout += 1;
    return outcome === 'completed';
  }

  /** Publish a scanout kick (main side, pre-notify). */
  private publishScanout(o: ScanoutBandOptions): void {
    try {
      Atomics.store(this.ctl, CTL_FBW, this.fbW);
      Atomics.store(this.ctl, CTL_FBH, this.fbH);
      Atomics.store(this.ctl, CTL_JOB, JOB_SCANOUT);
    } catch {
      /* ignore */
    }
    const k = this.rgbViews.kick;
    k[0] = o.gamma;
    k[1] = o.dither ? 1 : 0;
    k[2] = o.ditherMode;
    k[3] = o.postfilter ? 1 : 0;
    k[4] = o.reconmode;
    k[5] = o.maxR;
    k[6] = o.maxG;
    k[7] = o.maxB;
    k[8] = o.quantise ? 1 : 0;
    this.seq += 1;
  }

  /**
   * Stage one world RGB batch into the SAB (main side). Same contract as
   * the Node pool's stageRGB (spans + persistent chain cache + luxels +
   * flags + y-range); false = run inline. Never throws.
   *
   * Foreground-protocol note (Goal A): at this HEAD the renderer stages
   * WORLD batches only (opaque world + skybox/flat-sky) and draws the
   * entity foreground inline AFTER the kick completes (world-before-
   * foreground ordering, depth-hack gun, translucent ordering — see
   * drawForeground in `packages/sw-renderer/src/frame.ts`). If the
   * renderer lane ever stages foreground work, it arrives through this
   * same path (same descriptor layout, same JOB_RGB kick, same drain-
   * before-inline-foreground ordering) or a new BandDispatcher method
   * this pool will surface with identical serial + worker-failure
   * fallbacks. Either way this pool never changes raster math — transport
   * only — and any unrecognised future kick still converges: the worker
   * loop routes unknown JOB codes to the ordered raster path, and every
   * flush here falls back to the bit-identical inline replay.
   */
  stageRGB(
    list: SpanList, spanStart: number, spanCount: number,
    levels: RGBMipLevel[],
    luxels: Uint8Array | null, luxW: number, luxH: number,
    flags: number, zbits: number, turbPhase: number, flatRGB: number,
  ): boolean {
    if (this.disposed || this.workers.length === 0) return false;
    // (a) refusal before dispatch: the pool is alive but the regions are
    // exhausted. Pending staging is untouched — the caller replays it
    // inline first, so global batch order is preserved. Counted (never
    // silent) via kickStats().refusals.
    if (this.rgbDescCount >= MAX_RGB_BATCHES) {
      this.statRgbRefusals += 1;
      return false;
    }
    if (!(spanCount >= 0)) return false;
    if (levels.length < 1 || levels.length > 32) return false;
    if (spanCount > 0) {
      if (spanStart < 0 || spanCount > MAX_RGB_SPANS - this.rgbSpansUsed) {
        this.statRgbRefusals += 1;
        return false;
      }
      const packed = packFrameSpans(
        list, this.rgbViews.spansF, this.rgbViews.spansI,
        this.rgbSpansUsed, this.rgbSpansUsed,
        MAX_RGB_SPANS - this.rgbSpansUsed, spanStart,
      );
      if (!packed || packed.count !== spanCount) {
        this.statRgbRefusals += 1;
        return false;
      }
    }
    let slot = this.rgbChainMap.get(levels);
    if (slot === undefined) {
      const allocChain = (): number | undefined => {
        if (this.rgbChainSlots >= RGB_MAX_CHAINS) return undefined;
        let bytes = 0;
        for (let l = 0; l < levels.length; l++) {
          const lv = levels[l]!;
          if (!(lv.width >= 1 && lv.height >= 1)) return undefined;
          if (lv.data.length < lv.width * lv.height * 3) return undefined;
          if (lv.mask.length < lv.width * lv.height) return undefined;
          bytes += lv.data.length + lv.mask.length;
        }
        if (bytes > RGB_CHAIN_CAP - this.rgbChainUsed) return undefined;
        if (levels.length > RGB_MAX_LEVELS - this.rgbChainLevels) return undefined;
        const s = this.rgbChainSlots;
        const levelBase = this.rgbChainLevels;
        for (let l = 0; l < levels.length; l++) {
          const lv = levels[l]!;
          const dataBytes = lv.data.length;
          const maskBytes = lv.mask.length;
          const dataOff = this.rgbChainUsed;
          this.rgbViews.chainData.set(lv.data, dataOff);
          const maskOff = dataOff + dataBytes;
          this.rgbViews.chainData.set(lv.mask, maskOff);
          const t = (levelBase + l) * L_PER_LEVEL;
          this.rgbViews.levelTab[t + L_DATA_OFF] = dataOff;
          this.rgbViews.levelTab[t + L_MASK_OFF] = maskOff;
          this.rgbViews.levelTab[t + L_W] = lv.width;
          this.rgbViews.levelTab[t + L_H] = lv.height;
          this.rgbChainUsed += dataBytes + maskBytes;
        }
        const dd = s * C_PER_CHAIN;
        this.rgbViews.chainDir[dd + C_LEVEL_BASE] = levelBase;
        this.rgbViews.chainDir[dd + C_LEVEL_COUNT] = levels.length;
        this.rgbChainLevels += levels.length;
        this.rgbChainSlots += 1;
        this.rgbChainMap.set(levels, s);
        return s;
      };
      let s = allocChain();
      if (s === undefined) {
        // Ownership fix (Phase 0, mirrors the Node pool): staged descriptors
        // hold slot indices into the persistent chain region. Evicting while
        // batches are pending would reuse those slots and corrupt their
        // bytes. Refuse to stage when pending (caller replays inline first);
        // evict-and-retry only when nothing is pending.
        if (this.rgbDescCount > 0) {
          this.statRgbRefusals += 1;
          return false;
        }
        this.clearRGBChains();
        s = allocChain();
        if (s === undefined) {
          this.statRgbRefusals += 1;
          return false;
        }
      }
      slot = s;
    }
    let luxOff = 0;
    if (luxels && luxW > 0 && luxH > 0) {
      const need = luxW * luxH * 3;
      if (luxels.length < need) return false;
      if (need > RGB_LUX_CAP - this.rgbLuxUsed) {
        this.statRgbRefusals += 1;
        return false;
      }
      luxOff = this.rgbLuxUsed;
      this.rgbViews.lux.set(luxels.subarray(0, need), luxOff);
      this.rgbLuxUsed += need;
    }
    const d = this.rgbDescCount * R_PER_BATCH;
    this.rgbViews.rgbDesc[d + R_SPAN_BASE] = this.rgbSpansUsed;
    this.rgbViews.rgbDesc[d + R_SPAN_COUNT] = spanCount;
    this.rgbViews.rgbDesc[d + R_CHAIN] = slot;
    this.rgbViews.rgbDesc[d + R_LUX_OFF] = luxOff;
    this.rgbViews.rgbDesc[d + R_LUX_W] = luxW;
    this.rgbViews.rgbDesc[d + R_LUX_H] = luxH;
    this.rgbViews.rgbDesc[d + R_FLAGS] = flags;
    this.rgbViews.rgbDesc[d + R_ZBITS] = zbits;
    this.rgbViews.rgbDesc[d + R_TURBPHASE] = turbPhase;
    this.rgbViews.rgbDesc[d + R_FLATRGB] = flatRGB;
    let ymin = 0, ymax = 0;
    let rOrdered = 1;
    if (spanCount > 0) {
      ymin = 0x7fffffff;
      ymax = -0x80000000;
      let prevY = -0x80000000;
      for (let s = 0; s < spanCount; s++) {
        const y = this.rgbViews.spansI[(this.rgbSpansUsed + s) * I_PER_SPAN + 1]!;
        if (y < ymin) ymin = y;
        if (y + 1 > ymax) ymax = y + 1;
        if (y < prevY) rOrdered = 0;
        prevY = y;
      }
      if (!(ymax > ymin)) { ymin = 0; ymax = 0; }
    }
    this.rgbViews.rgbDesc[d + R_YMIN] = ymin;
    this.rgbViews.rgbDesc[d + R_YMAX] = ymax;
    this.rgbViews.rgbDesc[d + R_ORDERED] = spanCount > 0 ? rOrdered : 0;
    this.rgbSpansUsed += spanCount;
    this.rgbDescCount += 1;
    return true;
  }

  /** Pending staged RGB batches (observability for the renderer/tests). */
  rgbPending(): number {
    return this.rgbDescCount;
  }

  /* --- PERF-FINISH-B kick diagnostics (instrumented-only) ----------------
   *
   * `enableDiag` arms per-kick timing; `disableDiag` (default state)
   * leaves the production path untouched — a single boolean check per
   * kick/message, zero steady-state allocation. The harness (CDP stage
   * capture, Node report-only benches) enables it around measured frames
   * only; acceptance FPS is always measured with it off.
   *
   * Worker completion messages carry the band index + tallies (see the
   * worker loop's postMessage in `@q2/sw-renderer`), so arrivals are BOTH
   * rank-ordered (arrivals[0] = first worker done, arrivals[last] =
   * slowest-band wait for the kick) AND band-attributed (bandIds[i] names
   * the worker that produced arrivals[i]). Unknown stubs that omit the
   * fields read -1 — rank order still holds. `workerExecMs` carries the
   * worker-local compute durations when the worker build posts them
   * (`execMs` on the completion message — a duration, comparable across
   * time origins); -1 per arrival otherwise. Dispatch-to-completion
   * latency and worker-local execution are reported side by side, never
   * fused (different clocks, different meaning).
   *
   * `stagingBytes` reads the live bump offsets (mid-frame view);
   * `kickBytes` returns the snapshot each indexed/RGB flush takes BEFORE
   * draining (the drain resets the offsets, so post-kick live reads are
   * zeros). Both are pure integer reads — safe on the hot path, no
   * allocation. The snapshot splits the per-frame transient upload
   * (spans/tex/light/lux, freed after the kick) from the persistent chain
   * cache (copy-on-first-use; steady-state upload is transient only). */

  /** Arm per-kick timing (harness only; production stays disarmed). */
  enableDiag(): void {
    this.diagOn = true;
    this.diagArrivalsSeen = 0;
    this.diagMainMs = -1;
    this.diagKicks = 0;
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
   * Last-kick diagnostic snapshot (null when disarmed or no kick ran yet).
   * Allocates (diag path only, never the production frame). See
   * DiagSnapshot for the clock-comparability contract: arrivals are
   * dispatch-to-completion latencies (scheduling included), NOT in-worker
   * compute durations; workerExecMs carries the worker-local durations
   * when posted (-1 per arrival otherwise).
   */
  diagSnapshot(): DiagSnapshot | null {
    if (!this.diagOn || this.diagKicks === 0) return null;
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
    };
  }

  /**
   * Monotonic kick outcomes per job kind (successes + counted fallbacks)
   * plus the quarantine flag. Fresh small object per call (observability
   * path only — publishQ2Stats / StageReport sample it once per frame, not
   * per pixel). Fallbacks are counted, never silent: any nonzero fallback
   * with healthy output proves the inline/serial path executed.
   *
   * `scanned` accumulates span entries actually inspected by successful
   * raster/RGB kicks (workers + main band); `scannedAvailable` reports
   * whether the build exposes the counters at all (false on older
   * builds — then `scanned` reads 0 and must NOT be mistaken for proof).
   *
   * `refusals.rgb` counts staging refusals before dispatch (pool alive,
   * regions exhausted — pending preserved for the inline replay).
   * `lastRgb` is the most recent RGB kick outcome (null until the first
   * RGB kick): staged-batch count + whether every worker completed the
   * kick + the calling thread's own band contribution. Staging is never
   * reported as execution — only `workerCompleted: true` proves workers
   * rasterised the kick.
   *
   * `epoch` is the fence epoch (see recoveryEpoch): 0 until the first
   * quarantine isolation moves the pool onto a replacement SAB.
   *
   * `exits` counts cooperative worker exits observed (`{ exited: true }`
   * after the shutdown signal) - the acknowledged-stop proof the bounded
   * join waits for. 0 until a quarantine arms the join.
   */
  kickStats(): {
    kicks: { raster: number; rgb: number; resolve: number; scanout: number };
    fallbacks: { raster: number; rgb: number; resolve: number; scanout: number };
    scanned: { raster: number; rgb: number };
    scannedAvailable: boolean;
    quarantined: boolean;
    refusals: { rgb: number };
    lastRgb: { descs: number; workerCompleted: boolean; mainPixels: number; mainSpans: number } | null;
    epoch: number;
    exits: number;
  } {
    return {
      kicks: { ...this.statKicks },
      fallbacks: { ...this.statFallbacks },
      scanned: { ...this.statScanned },
      scannedAvailable: this.scannedObserved,
      quarantined: this.quarantined,
      refusals: { rgb: this.statRgbRefusals },
      lastRgb: this.lastRgbKick === null ? null : { ...this.lastRgbKick },
      epoch: this.recoveryEpoch(),
      exits: this.exitAcks,
    };
  }

  /**
   * Bytes staged for the current (unflushed) frame kick, both lanes.
   * Pure reads — safe to sample per frame with no behavior change.
   * Span slots are F_PER_SPAN f64 + I_PER_SPAN i32 (124 B); tex/light/lux
   * are exact bump bytes; chains are exact chain-region bytes.
   * NOTE: post-kick the offsets are reset, so this reads zeros then — use
   * `kickBytes()` for the last completed kick.
   */
  stagingBytes(): {
    idxSpans: number; idxTex: number; idxLight: number; idxDescs: number;
    rgbSpans: number; rgbChains: number; rgbLux: number; rgbDescs: number;
    total: number;
  } {
    return snapshotStaging(
      this.spansUsed, this.texUsed, this.lightUsed, this.descCount,
      this.rgbSpansUsed, this.rgbChainUsed, this.rgbLuxUsed, this.rgbDescCount,
    );
  }

  /**
   * Last completed kick's staging snapshot (null until the first
   * indexed/RGB flush). Same shape as `stagingBytes`; frozen at flush
   * time, so post-kick sampling still reports the real per-frame upload.
   */
  kickBytes(): {
    idxSpans: number; idxTex: number; idxLight: number; idxDescs: number;
    rgbSpans: number; rgbChains: number; rgbLux: number; rgbDescs: number;
    total: number;
  } | null {
    return this.lastKick;
  }

  /** Freeze the current staging offsets as the last-kick snapshot. */
  private snapKick(): void {
    this.lastKick = snapshotStaging(
      this.spansUsed, this.texUsed, this.lightUsed, this.descCount,
      this.rgbSpansUsed, this.rgbChainUsed, this.rgbLuxUsed, this.rgbDescCount,
    );
  }

  /**
   * Sync RGB flush is unsupported in the browser (would block): always
   * null, so the caller replays inline via drawInlineRGBAll. The async
   * frame path uses flushRGBFrameAsync instead.
   */
  flushRGBFrame(): { pixels: number; spans: number } | null {
    return null;
  }

  /**
   * Kick ONE RGB frame covering every staged batch and await worker
   * completion messages (never Atomics.wait — main-thread safe). Resolves
   * null when the pool is dead or the wait times out; the caller replays
   * inline via recoverInlineRGBAll, converging to identical planes.
   *
   * Recovery semantics (explicit, mirroring the Node pool outcome
   * vocabulary — 'refused' / 'clean-failure' / 'partial-failure'):
   * (a) refusal before dispatch (dead pool, nothing staged, workers never
   *     ready, kick declined, checkpoint allocation failure) — no worker
   *     or main-band write happened, so the pending staging is left intact
   *     for the inline replay ('clean');
   * (b) failure before any writes — same as (a) ('clean');
   * (c) failure after partial execution (timeout / lost completion after
   *     the main band and some workers already wrote) — the timeout path
   *     quarantines FIRST (shutdown signal + replacement-buffer isolation
   *     + termination, so no straggler write can race what follows), the
   *     async path joins completed termination (bounded), and only then is
   *     the pre-kick checkpoint restored (undoing every partial write of
   *     THIS kick on the isolated planes while keeping committed earlier
   *     kicks). Null is returned so the caller replays the failed kick
   *     exactly once ('partial');
   * (d) disposal in flight — the dispose path terminates every worker
   *     (best-effort kill happens-before the restore below) and resolves
   *     in-flight kicks as failures WITHOUT quarantining (teardown, not
   *     wedged workers) ('partial': writes may have landed).
   */
  async flushRGBFrameAsync(near: number, far: number, lodBias: number): Promise<{ pixels: number; spans: number } | null> {
    if (this.disposed || this.workers.length === 0 || this.quarantined) { this.rgbFailure = 'clean'; return null; }
    if (this.rgbDescCount <= this.rgbFlushedCount) return { pixels: 0, spans: 0 };
    if (!(await this.awaitReadyAsync())) { this.rgbFailure = 'clean'; return null; }
    this.snapKick();
    // Checkpoint BEFORE any write of this kick: on a partial failure the
    // restore undoes this kick's writes while keeping committed earlier
    // kicks. Allocation failure is a 'refused' outcome selected BEFORE
    // dispatch - without a checkpoint there is no safe replay over partial
    // writes, so nothing is dispatched and the pending staging is left
    // intact for the exact inline replay.
    this.snapshotRGB();
    const descs = this.rgbDescCount;
    if (!this.rgbSnap || this.rgbSnap.gen !== this.frameGen) {
      this.discardSnapshot();
      this.lastRgbKick = { descs, workerCompleted: false, mainPixels: 0, mainSpans: 0 };
      this.rgbFailure = 'clean';
      return null;
    }
    this.publishRGB(near, far, lodBias);
    const seq = this.seq;
    const finished = this.awaitWorkerMessages(seq, this.workers.length);
    if (!this.kick(seq, 'rgb')) {
      this.pending.delete(seq);
      this.statFallbacks.rgb += 1;
      this.discardSnapshot();
      this.lastRgbKick = { descs, workerCompleted: false, mainPixels: 0, mainSpans: 0 };
      this.rgbFailure = 'clean';
      return null;
    }
    // Calling thread owns the last band: drain its share of the SUFFIX
    // inline while the workers drain theirs, then await the workers.
    const mainBand = this.bands[this.bands.length - 1]!;
    const diagT0 = this.diagOn ? performance.now() : 0;
    const main = processRGBFrameJob(
      this.rgbViews, this.fbW, this.fbH, this.rgbDescCount, mainBand.y0, mainBand.y1,
      this.rgbFlushedCount,
    );
    if (this.diagOn) this.diagMainMs = performance.now() - diagT0;
    const outcome = await finished;
    if (outcome !== 'completed') {
      this.statFallbacks.rgb += 1;
      // Fence order: writers were already stopped/isolated (timeout
      // quarantined in the waiter; dispose terminated in teardown) - join
      // completed termination when the pool is NOT being torn down
      // (dispose aborts as a failure without quarantining), and only then
      // restore the checkpoint onto the isolated planes.
      // Never restore-then-quarantine: live workers could still write the
      // planes being restored/replayed.
      if (!this.disposed) {
        await this.quarantineWorkersAsync();
      }
      this.restoreSnapshot();
      this.lastRgbKick = { descs, workerCompleted: false, mainPixels: main.pixels, mainSpans: main.spans };
      this.rgbFailure = 'partial';
      return null;
    }
    this.statKicks.rgb += 1;
    const tally = this.tally();
    tally.pixels += main.pixels;
    tally.spans += main.spans;
    const mScan = scannedOf(main);
    if (mScan.present || this.ctlScanOff() >= 0) this.scannedObserved = true;
    tally.scanned += mScan.value;
    const mTris = (main as unknown as { tris?: unknown }).tris;
    const mainTris = typeof mTris === 'number' && Number.isFinite(mTris) ? mTris : 0;
    tally.tris += mainTris;
    this.statScanned.rgb += tally.scanned;
    this.lastRgbKick = { descs, workerCompleted: true, mainPixels: main.pixels, mainSpans: main.spans };
    this.discardSnapshot();
    this.rgbFlushedCount = this.rgbDescCount;
    this.rgbFailure = null;
    return tally;
  }

  /**
    * Full-frame inline replay of the staged RGB batches on the calling
    * thread (sync fallback). Never clears: the planes may hold committed
    * earlier kicks (world) that this replay must preserve, and a failed
    * kick already restored its checkpoint — so replaying the still-pending
    * descriptors on top converges depth-guarded to the identical planes.
   * (The old unconditional clear destroyed world coverage on foreground
   * recovery and double-blended partial alpha writes.)
   */
  drawInlineRGBAll(near: number, far: number, lodBias: number): { pixels: number; spans: number } {
    this.publishRGB(near, far, lodBias);
    const r = processRGBFrameJob(
      this.rgbViews, this.fbW, this.fbH, this.rgbDescCount, 0, this.fbH, this.rgbFlushedCount,
    );
    this.discardSnapshot();
    this.rgbFlushedCount = this.rgbDescCount;
    this.rgbFailure = null;
    return r;
  }

  /**
   * Checkpoint the shared RGB planes (main thread, pre-kick). Never throws.
   * A missing checkpoint after this returns (allocation/copy failure) is a
   * 'refused' outcome: the kick must NOT be dispatched, because a partial
   * failure without a checkpoint could never replay exactly once. The
   * caller (flushRGBFrameAsync) checks and refuses before dispatch.
   */
  private snapshotRGB(): void {
    // Deterministic test seam for the checkpoint-allocation-failure path:
    // set `testDropSnapshot` to force the refused outcome without an OOM.
    // Same `as unknown as` probe pattern as the play.ts feature-detects;
    // never set in production (no exported surface, no behavior change).
    const probe = this as unknown as { testDropSnapshot?: boolean };
    if (probe.testDropSnapshot === true) {
      probe.testDropSnapshot = false;
      this.rgbSnap = null;
      return;
    }
    try {
      const n = this.fbW * this.fbH;
      let snap = this.rgbSnap;
      if (!snap || snap.rgb565.length !== n) {
        snap = {
          rgb565: new Uint16Array(n),
          cover: new Uint8Array(n),
          rgbDepth: new Uint16Array(n),
          gen: this.frameGen,
        };
        this.rgbSnap = snap;
      }
      snap.rgb565.set(this.rgbViews.rgb565);
      snap.cover.set(this.rgbViews.cover);
      snap.rgbDepth.set(this.rgbViews.rgbDepth);
      snap.gen = this.frameGen;
    } catch {
      // Allocation/copy failure: drop the checkpoint. The kick is refused
      // before dispatch (see flushRGBFrameAsync), so no partial-write
      // failure can ever need the missing checkpoint.
      this.rgbSnap = null;
    }
  }

  /**
   * Restore the pre-kick RGB planes when the generation still matches.
   * Runs on the CURRENT (possibly isolated) pool views, and only AFTER
   * writers were stopped/isolated (timeout quarantined in the waiter,
   * dispose terminated in teardown) - never before. Stale generations
   * (recovery racing the next frame) refuse the restore.
   */
  private restoreSnapshot(): void {
    const snap = this.rgbSnap;
    if (!snap || snap.gen !== this.frameGen) return;
    try {
      this.rgbViews.rgb565.set(snap.rgb565);
      this.rgbViews.cover.set(snap.cover);
      this.rgbViews.rgbDepth.set(snap.rgbDepth);
    } catch {
      /* best effort: the inline replay still converges depth-guarded */
    }
  }

  /** Drop the checkpoint (success, inline replay, or new frame). */
  private discardSnapshot(): void {
    this.rgbSnap = null;
  }

  /** Publish an RGB-kick descriptor (main side, pre-notify): suffix [flushed, descCount). */
  private publishRGB(near: number, far: number, lodBias: number): void {
    try {
      Atomics.store(this.ctl, CTL_FBW, this.fbW);
      Atomics.store(this.ctl, CTL_FBH, this.fbH);
      Atomics.store(this.ctl, CTL_JOB, JOB_RGB);
      Atomics.store(this.ctl, CTL_RGBBASE, this.rgbFlushedCount);
      Atomics.store(this.ctl, CTL_RGBCOUNT, this.rgbDescCount);
    } catch {
      /* ignore */
    }
    this.rgbViews.kick[0] = near;
    this.rgbViews.kick[1] = far;
    this.rgbViews.kick[2] = lodBias;
    this.rgbViews.kick[3] = 0;
    this.seq += 1;
  }

  /** Publish a full-range RGB descriptor (inline recovery replays [0, descCount) / suffix-aware). */
  private publishRGBFull(near: number, far: number, lodBias: number): void {
    try {
      Atomics.store(this.ctl, CTL_FBW, this.fbW);
      Atomics.store(this.ctl, CTL_FBH, this.fbH);
      Atomics.store(this.ctl, CTL_JOB, JOB_RGB);
      Atomics.store(this.ctl, CTL_RGBBASE, 0);
      Atomics.store(this.ctl, CTL_RGBCOUNT, this.rgbDescCount);
    } catch {
      /* ignore */
    }
    this.rgbViews.kick[0] = near;
    this.rgbViews.kick[1] = far;
    this.rgbViews.kick[2] = lodBias;
    this.rgbViews.kick[3] = 0;
    this.seq += 1;
  }

  /**
   * Transfer the frame's single VoodooState snapshot to every band (astra
   * §5): the SAME `st` values go to all workers with absolute y0/y1, so a
   * future worker-side voodoo backend rasterises with global dither phase.
   * Fire-and-forget per worker (the raster kick below is the barrier the
   * shell waits on); per-worker try/catch so one dead worker degrades to
   * the inline-convergent path instead of throwing. Returns workers
   * messaged (0 when disposed/workerless). The current raster loop ignores
   * the stash (scanout stays global-serial after ALL bands complete).
   */
  broadcastVoodooState(st: VoodooState): number {
    if (this.disposed || this.workers.length === 0) return 0;
    const msgs = voodooBandMessages(st, this.bands, this.fbW, this.fbH);
    let sent = 0;
    for (let i = 0; i < this.workers.length; i++) {
      try {
        this.workers[i]!.postMessage(msgs[i]);
        sent += 1;
      } catch {
        /* worker gone: the frame kick below still converges inline */
      }
    }
    return sent;
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
   * is harmless: recovery restores the checkpoint + replays deterministically.
   * Never throws; on any failure the pool keeps the old buffer (termination
   * still proceeds - best effort, never silent about the quarantine flag).
   */
  private isolateSharedPlanes(): void {
    try {
      const oldCtl = this.ctl;
      if (!oldCtl || !(oldCtl.buffer instanceof SharedArrayBuffer)) return;
      const oldBuf = oldCtl.buffer as SharedArrayBuffer;
      const size = rgbAccumTotal(this.fbW, this.fbH);
      if (!(size > 0) || oldBuf.byteLength < size) return;
      const fresh = new SharedArrayBuffer(size);
      new Uint8Array(fresh).set(new Uint8Array(oldBuf));
      const { views } = attachFrameAccum(fresh, this.fbW, this.fbH);
      const { views: rgbViews } = attachRGBAccum(fresh, this.fbW, this.fbH);
      this.views = views;
      this.rgbViews = rgbViews;
      this.base = views.base;
      this.ctl = views.ctl;
      try {
        Atomics.store(this.ctl, CTL_SEQ, this.seq);
        Atomics.store(this.ctl, CTL_DONE, 0);
        Atomics.store(this.ctl, CTL_READY, 0);
        Atomics.store(this.ctl, CTL_FRAME, this.frameGen);
        Atomics.store(this.ctl, CTL_FCOUNT, 0);
        Atomics.store(this.ctl, CTL_COUNT, 0);
        Atomics.store(this.ctl, CTL_JOB, JOB_RGB);
        Atomics.store(this.ctl, CTL_RGBBASE, this.rgbFlushedCount);
        Atomics.store(this.ctl, CTL_RGBCOUNT, this.rgbDescCount);
      } catch {
        /* ignore */
      }
      // Discard the copied partial plane writes: recovery restores the
      // checkpoint + replays deterministically from staging.
      try {
        this.base.idx.fill(0);
        this.base.zb.fill(0);
        this.views.fColor.fill(0);
        this.rgbViews.rgb565.fill(0);
        this.rgbViews.cover.fill(0);
        this.rgbViews.rgbDepth.fill(0xffff);
        this.rgbViews.scan565.fill(0);
        this.rgbViews.scanDisplay.fill(0);
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
    // NOTE: RGB staging is NOT reset here (PERF-2 RGB workers) — indexed
    // flushes must not wipe staged RGB batches. RGB resets in beginFrame
    // and the RGB flush paths only.
    try {
      Atomics.store(this.ctl, CTL_FCOUNT, 0);
      Atomics.store(this.ctl, CTL_JOB, JOB_RASTER);
    } catch {
      /* ignore */
    }
  }

  /** Drop staged RGB batches (beginFrame + commitRGB reset). */
  private resetRGB(): void {
    this.rgbSpansUsed = 0;
    this.rgbLuxUsed = 0;
    this.rgbDescCount = 0;
    this.rgbTriUsed = 0;
    this.rgbFlushedCount = 0;
    this.rgbFailure = null;
    try {
      Atomics.store(this.ctl, CTL_RGBCOUNT, 0);
      Atomics.store(this.ctl, CTL_RGBBASE, 0);
    } catch {
      /* ignore */
    }
  }

  /** Flat-tri staging cursor (mirrors Node pool): current bump base + cap. */
  triCursor(): { F: Float64Array; I: Int32Array; base: number; cap: number } | null {
    if (this.disposed || this.workers.length === 0 || this.quarantined) return null;
    return {
      F: this.rgbViews.triF, I: this.rgbViews.triI,
      base: this.rgbTriUsed, cap: TRI_MAX_TRIS - this.rgbTriUsed,
    };
  }

  /** Record one entity's prepared tri batch (mirrors Node pool semantics). */
  stageTriBatch(
    triBase: number, triCount: number,
    levels: RGBMipLevel[],
    flags: number, zbits: number, alphaQ: number,
  ): boolean {
    if (this.disposed || this.workers.length === 0 || this.quarantined) return false;
    if (this.rgbDescCount >= MAX_RGB_BATCHES) { this.statRgbRefusals += 1; return false; }
    if (!(triCount >= 0)) return false;
    if (levels.length < 1 || levels.length > 32) return false;
    if (triCount > 0) {
      if (triBase < 0 || triCount > TRI_MAX_TRIS - this.rgbTriUsed) { this.statRgbRefusals += 1; return false; }
      if (triBase !== this.rgbTriUsed) return false;
    }
    let slot = this.rgbChainMap.get(levels);
    if (slot === undefined) {
      const allocChain = (): number | undefined => {
        if (this.rgbChainSlots >= RGB_MAX_CHAINS) return undefined;
        let bytes = 0;
        for (let l = 0; l < levels.length; l++) {
          const lv = levels[l]!;
          if (!(lv.width >= 1 && lv.height >= 1)) return undefined;
          if (lv.data.length < lv.width * lv.height * 3) return undefined;
          if (lv.mask.length < lv.width * lv.height) return undefined;
          bytes += lv.data.length + lv.mask.length;
        }
        if (bytes > RGB_CHAIN_CAP - this.rgbChainUsed) return undefined;
        if (levels.length > RGB_MAX_LEVELS - this.rgbChainLevels) return undefined;
        const s = this.rgbChainSlots;
        const levelBase = this.rgbChainLevels;
        for (let l = 0; l < levels.length; l++) {
          const lv = levels[l]!;
          const dataBytes = lv.data.length;
          const maskBytes = lv.mask.length;
          const dataOff = this.rgbChainUsed;
          this.rgbViews.chainData.set(lv.data, dataOff);
          const maskOff = dataOff + dataBytes;
          this.rgbViews.chainData.set(lv.mask, maskOff);
          const t = (levelBase + l) * L_PER_LEVEL;
          this.rgbViews.levelTab[t + L_DATA_OFF] = dataOff;
          this.rgbViews.levelTab[t + L_MASK_OFF] = maskOff;
          this.rgbViews.levelTab[t + L_W] = lv.width;
          this.rgbViews.levelTab[t + L_H] = lv.height;
          this.rgbChainUsed += dataBytes + maskBytes;
        }
        const dd = s * C_PER_CHAIN;
        this.rgbViews.chainDir[dd + C_LEVEL_BASE] = levelBase;
        this.rgbViews.chainDir[dd + C_LEVEL_COUNT] = levels.length;
        this.rgbChainLevels += levels.length;
        this.rgbChainSlots += 1;
        this.rgbChainMap.set(levels, s);
        return s;
      };
      let s = allocChain();
      if (s === undefined) {
        if (this.rgbDescCount > 0) { this.statRgbRefusals += 1; return false; }
        this.clearRGBChains();
        s = allocChain();
        if (s === undefined) { this.statRgbRefusals += 1; return false; }
      }
      slot = s;
    }
    let ymin = 0, ymax = 0;
    if (triCount > 0) {
      ymin = 0x7fffffff;
      ymax = -0x80000000;
      for (let t = 0; t < triCount; t++) {
        const q = (triBase + t) * TRI_I_PER_TRI;
        const ty0 = this.rgbViews.triI[q]!;
        const ty1 = this.rgbViews.triI[q + 1]!;
        if (ty0 < ymin) ymin = ty0;
        if (ty1 > ymax) ymax = ty1;
      }
      if (!(ymax > ymin)) { ymin = 0; ymax = 0; }
    }
    const d = this.rgbDescCount * R_PER_BATCH;
    this.rgbViews.rgbDesc[d + R_SPAN_BASE] = triBase;
    this.rgbViews.rgbDesc[d + R_SPAN_COUNT] = triCount;
    this.rgbViews.rgbDesc[d + R_CHAIN] = slot;
    this.rgbViews.rgbDesc[d + R_LUX_OFF] = 0;
    this.rgbViews.rgbDesc[d + R_LUX_W] = 0;
    this.rgbViews.rgbDesc[d + R_LUX_H] = 0;
    this.rgbViews.rgbDesc[d + R_FLAGS] = flags;
    this.rgbViews.rgbDesc[d + R_ZBITS] = zbits;
    this.rgbViews.rgbDesc[d + R_TURBPHASE] = 0;
    this.rgbViews.rgbDesc[d + R_FLATRGB] = 0;
    this.rgbViews.rgbDesc[d + R_YMIN] = ymin;
    this.rgbViews.rgbDesc[d + R_YMAX] = ymax;
    this.rgbViews.rgbDesc[d + R_ORDERED] = 0;
    this.rgbViews.rgbDesc[d + R_ALPHAQ] = alphaQ;
    this.rgbTriUsed += triCount;
    this.rgbDescCount += 1;
    return true;
  }

  /** Applied prefix length: descriptors [0, flushed) already hold plane writes. */
  rgbFlushed(): number {
    return this.rgbFlushedCount;
  }

  /** End-of-frame: drop all retained RGB descriptors (spans/lux/descs/flushed). */
  commitRGB(): void {
    this.resetRGB();
  }

  /**
   * Last RGB flush outcome: 'clean' = refused/clean-failure (nothing was
   * dispatched), 'partial' = partial-failure (writes may have landed;
   * quarantined first except the dispose teardown path), null = success
   * or no kick yet. Observability only (mirrors the Node pool).
   */
  lastRGBFailure(): 'clean' | 'partial' | null {
    return this.rgbFailure;
  }

  /**
   * Complete-frame recovery replay (mirrors Node pool): selective by suffix.
   * Opaque-only suffix replays in place (no clear); blend suffix clears,
   * replays prefix, runs seed, replays suffix. Must be called only after
   * quarantine when writes may have been in flight - the timeout path
   * quarantines (shutdown signal + replacement-buffer isolation +
   * termination) and the renderer re-adopts the pool's current planes
   * before this runs, so the replay targets the live buffer, never the
   * abandoned one a live worker may still be scribbling.
   */
  recoverInlineRGBAll(seed: () => void, near: number, far: number, lodBias: number): { pixels: number; spans: number; scanned?: number; tris: number } {
    const flushed = this.rgbFlushedCount < 0 ? 0
      : this.rgbFlushedCount > this.rgbDescCount ? this.rgbDescCount
      : this.rgbFlushedCount;
    let suffixBlends = false;
    const desc = this.rgbViews.rgbDesc;
    for (let b = flushed; b < this.rgbDescCount; b++) {
      const f = desc[b * R_PER_BATCH + R_FLAGS]!;
      if ((f & (R_FLAG_BLEND_ALPHA | R_FLAG_ADDITIVE)) !== 0) { suffixBlends = true; break; }
    }
    this.publishRGBFull(near, far, lodBias);
    if (!suffixBlends) {
      const r = this.rgbDescCount > flushed
        ? processRGBFrameJob(this.rgbViews, this.fbW, this.fbH, this.rgbDescCount, 0, this.fbH, flushed)
        : { pixels: 0, spans: 0, scanned: 0, tris: 0 };
      this.discardSnapshot();
      this.rgbFlushedCount = this.rgbDescCount;
      this.rgbFailure = null;
      return r;
    }
    this.rgbViews.cover.fill(0);
    this.rgbViews.rgbDepth.fill(0xffff);
    const pre = flushed > 0
      ? processRGBFrameJob(this.rgbViews, this.fbW, this.fbH, flushed, 0, this.fbH)
      : { pixels: 0, spans: 0, scanned: 0, tris: 0 };
    try { seed(); } catch { /* seed must not wedge recovery */ }
    const post = this.rgbDescCount > flushed
      ? processRGBFrameJob(this.rgbViews, this.fbW, this.fbH, this.rgbDescCount, 0, this.fbH, flushed)
      : { pixels: 0, spans: 0, scanned: 0, tris: 0 };
    this.discardSnapshot();
    this.rgbFlushedCount = this.rgbDescCount;
    this.rgbFailure = null;
    return {
      pixels: pre.pixels + post.pixels,
      spans: pre.spans + post.spans,
      scanned: (pre.scanned ?? 0) + (post.scanned ?? 0),
      tris: (pre.tris ?? 0) + (post.tris ?? 0),
    };
  }

  /** Drop the persistent RGB chain upload cache (palette/world change). */
  clearRGBChains(): void {
    this.rgbChainUsed = 0;
    this.rgbChainLevels = 0;
    this.rgbChainSlots = 0;
    this.rgbChainMap.clear();
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

  private tally(): { pixels: number; spans: number; scanned: number; tris: number } {
    // CTL_PIXELS + i / CTL_SPANS + i per-worker tallies (see bands.ts layout).
    // CTL_SCAN + i per-worker inspected-span counts + CTL_TRIS + i tri counts.
    let pixels = 0;
    let spans = 0;
    let scanned = 0;
    let tris = 0;
    const off = this.ctlScanOff();
    for (let i = 0; i < this.workers.length; i++) {
      pixels += this.ctl[CTL_PIXELS + i]!;
      spans += this.ctl[CTL_SPANS + i]!;
      if (off >= 0) {
        const s = this.ctl[off + i]!;
        if (typeof s === 'number' && Number.isFinite(s) && s >= 0) scanned += s;
      }
      try {
        const t = this.ctl[CTL_TRIS + i];
        if (typeof t === 'number' && Number.isFinite(t) && t >= 0) tris += t;
      } catch { /* older SAB without tri slots */ }
    }
    return { pixels, spans, scanned, tris };
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
 * post-rebuild `processFrameJob`/`processRGBFrameJob` returns carry span
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
  rgbSpansUsed: number, rgbChainUsed: number, rgbLuxUsed: number, rgbDescCount: number,
): {
  idxSpans: number; idxTex: number; idxLight: number; idxDescs: number;
  rgbSpans: number; rgbChains: number; rgbLux: number; rgbDescs: number;
  total: number;
} {
  const perSpan = F_PER_SPAN * 8 + I_PER_SPAN * 4;
  const idxSpans = spansUsed * perSpan;
  const rgbSpans = rgbSpansUsed * perSpan;
  const total = idxSpans + texUsed + lightUsed +
    rgbSpans + rgbChainUsed + rgbLuxUsed;
  return {
    idxSpans, idxTex: texUsed, idxLight: lightUsed,
    idxDescs: descCount,
    rgbSpans, rgbChains: rgbChainUsed, rgbLux: rgbLuxUsed,
    rgbDescs: rgbDescCount,
    total,
  };
}

/* --- V2d voodoo band contract (astra §5) ---------------------------------
 *
 * Worker bands rasterise software spans; the voodoo SCANOUT stays global:
 * after flushFrameAsync drains EVERY band, the shell runs one serial
 * `resolveFrame` over the full frame, so the 2×2 reconstruction filter
 * taps cross band boundaries and the ordered dither uses absolute screen
 * coordinates (never a per-band phase restart). Until a worker/WASM voodoo
 * backend exists, the supported path is selected EXPLICITLY (serial) —
 * never a silent software fallback (see selectVoodooBandPath).
 *
 * Per-frame state flow (shell side, all in apps/web):
 *   1. `frameAsync` (play.ts) snapshots ONE VoodooState via
 *      `snapshotVoodooState` and hands it to `broadcastBandVoodoo`, which
 *      feature-detects `BrowserBandPool.broadcastVoodooState` and posts the
 *      SAME snapshot values to every band with absolute y0/y1
 *      (`voodooBandMessages` below). The worker entry (render-worker.ts)
 *      stashes the envelope for the future backend; the current raster loop
 *      ignores it and scanout stays global-serial on the main thread.
 *   2. The same snapshot object threads into `resolveDisplay` as
 *      `frameState`, so bands and the global resolve can never disagree
 *      mid-frame (no second `readVoodooState()` per frame on that path).
 *
 * TODO(worker-rgb-backend): when the worker/WASM RGB backend lands, consume
 * the stashed envelope worker-side. Assumed hook names (never imported
 * directly — feature-detect with `as unknown as`):
 *   worker entry: `renderVoodooBand(envelope)` in render-worker.ts
 *   wasm export:  `voodoo_raster_band(...)` / `voodoo_resolve_band(...)`
 * Until then `selectVoodooBandPath` stays `serial` (see below).
 */

/** Supported voodoo scanout paths. `worker` is reserved for the future
 * worker/WASM voodoo backend; nothing selects it at this HEAD. */
export type VoodooBandPath = 'serial' | 'worker';

/**
 * Explicit voodoo path selection (Track A parallel scanout): `worker` when a
 * band pool is active (pooled scanout kick drains all bands in parallel with
 * disjoint outputs + halo handling, byte-identical to serial), `serial`
 * otherwise. Callers record the result (PlayBoot.lastVoodooPath) instead of
 * branching on backend folklore. Pure/headless-safe.
 */
export function selectVoodooBandPath(poolActive: boolean): VoodooBandPath {
  return poolActive ? 'worker' : 'serial';
}

/**
 * Convert a frame VoodooState snapshot to band scanout kick params (Track A):
 * numbers only, no per-pixel cvar reads in workers. reconmode maps to
 * 0 = legacy, 1 = 2x2sub+2x2box, 2 = 4x4sub+4x1. Pure.
 */
export function voodooStateToScanoutOpts(st: VoodooState): ScanoutBandOptions {
  return {
    gamma: st.gamma,
    dither: st.dither,
    ditherMode: st.dithermode === '2x2' ? 1 : 0,
    postfilter: st.postfilter,
    reconmode: st.reconmode === 'legacy' ? 0 : st.reconmode === '4x4sub+4x1' ? 2 : 1,
    maxR: st.rgbmaxdelta.r | 0,
    maxG: st.rgbmaxdelta.g | 0,
    maxB: st.rgbmaxdelta.b | 0,
    quantise: st.quantise,
  };
}

/**
 * Snapshot the frame's VoodooState ONCE per frame (V2d/astra §5): the same
 * object is shared by every band envelope below and by the global resolve,
 * so no band ever calls `readVoodooState()` per pixel/span.
 */
export function snapshotVoodooState(): VoodooState {
  return readVoodooState();
}

/** Per-band voodoo envelope: the SHARED frame snapshot + the band's slice
 * in ABSOLUTE screen coordinates (full-frame y0/y1), so dither phase and
 * LOD stay stable across band boundaries and camera motion. */
export interface VoodooBandEnvelope {
  /** The frame's single shared snapshot (same reference for every band). */
  state: VoodooState;
  /** Band slice in absolute screen rows [y0, y1). */
  y0: number;
  y1: number;
  /** Full-frame dimensions (dither/reconstruction address this space). */
  width: number;
  height: number;
}

/**
 * Build one envelope per band sharing a single `st` snapshot (pure). The
 * future worker-side voodoo backend consumes these; today they document +
 * pin the transfer contract (same state, absolute coords) while scanout
 * stays global-serial.
 */
export function voodooBandEnvelopes(
  st: VoodooState,
  bands: Band[],
  width: number,
  height: number,
): VoodooBandEnvelope[] {
  return bands.map((b) => ({ state: st, y0: b.y0, y1: b.y1, width, height }));
}

/**
 * Per-band voodoo state message posted to each worker (astra §5 shell
 * side): the SAME frame snapshot object for every band plus the band's
 * ABSOLUTE screen slice (full-frame y0/y1) and full-frame dimensions, so
 * dither phase and LOD stay stable across band boundaries and camera
 * motion. `voodooState` is the identical reference in every message on the
 * sending side (structured-clone copies the same values per worker).
 * The current bandWorkerLoop ignores these (scanout stays global-serial);
 * the future worker/WASM voodoo backend consumes them (see TODO above).
 */
export interface VoodooBandMessage {
  /** The frame's single shared snapshot (same reference in every message). */
  voodooState: VoodooState;
  /** Band slice in absolute screen rows [y0, y1). */
  y0: number;
  /** Band slice end in absolute screen rows. */
  y1: number;
  /** Full-frame width (dither/reconstruction address this space). */
  width: number;
  /** Full-frame height (dither/reconstruction address this space). */
  height: number;
  /** Band index (matches the worker's slice assignment). */
  band: number;
}

/**
 * Build one state message per band sharing a single `st` snapshot (pure).
 * Contiguous full-frame coverage: messages[i] spans the same absolute
 * rows as bands[i]; every message carries the identical `st` reference.
 */
export function voodooBandMessages(
  st: VoodooState,
  bands: Band[],
  width: number,
  height: number,
): VoodooBandMessage[] {
  return bands.map((b, i) => ({
    voodooState: st, y0: b.y0, y1: b.y1, width, height, band: i,
  }));
}
