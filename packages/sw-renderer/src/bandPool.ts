// @q2/sw-renderer bandPool — M8.1 worker-thread pool for SAB band spanfill.
//
// Real threads (Node `node:worker_threads`) running the SAME band loop as
// the inline path (bands.ts `processBandJob`, required from the built CJS
// bundle — single source of truth, no code duplication). The pool owns one
// SAB (planes + staging + packed spans + control); workers block on the job
// generation counter and write directly into the shared planes — zero copy,
// no per-frame allocation.
//
// Sync dispatch uses main-thread Atomics.wait (allowed in Node, forbidden on
// browser main threads), so this pool is Node-only by construction:
// `create()` returns null anywhere threads, SAB, or blocking waits are
// unavailable, and every caller falls back to the inline banded path with
// identical output. Async dispatch (postMessage) is also provided for
// future browser use.

import { Com_Warn } from '@q2/config';
import {
  CTL_COUNT, CTL_DONE, CTL_EXEC, CTL_FBH, CTL_FBW, CTL_FCOUNT, CTL_FRAME, CTL_HMASK, CTL_JOB, CTL_LIGHTH, CTL_LIGHTW,
  CTL_PIXELS, CTL_READY, CTL_RGBBASE, CTL_RGBCOUNT, CTL_SCAN, CTL_SEQ, CTL_SPANS, CTL_TEXH, CTL_TEXW, CTL_TRIS, CTL_TURBPHASE,
  CTL_WMASK, CTL_WSHIFT, D_HMASK, D_LIGHT_H, D_LIGHT_OFF, D_LIGHT_W,
  D_PER_BATCH, D_SPAN_BASE, D_SPAN_COUNT, D_TEX_H, D_TEX_OFF, D_TEX_W,
  D_TURBPHASE, D_WMASK, D_WSHIFT, D_YMAX, D_YMIN, D_ORDERED, FRAME_LIGHT_CAP, FRAME_TEX_CAP,
  JOB_RASTER, JOB_RESOLVE, JOB_RGB, JOB_SCANOUT,
  LIGHT_CAP, MAX_FRAME_BATCHES, MAX_FRAME_SPANS, MAX_WORKERS, MIN_BAND_PIXELS, TEX_CAP,
  MAX_RGB_BATCHES, MAX_RGB_SPANS, RGB_CHAIN_CAP, RGB_LUX_CAP, RGB_MAX_CHAINS, RGB_MAX_LEVELS,
  C_LEVEL_BASE, C_LEVEL_COUNT, C_PER_CHAIN, L_DATA_OFF, L_H, L_MASK_OFF, L_PER_LEVEL, L_W,
  R_CHAIN, R_FLAGS, R_FLAG_BLEND_ALPHA, R_FLAG_ADDITIVE, R_FLATRGB, R_LUX_H, R_LUX_OFF, R_LUX_W, R_PER_BATCH,
  R_SPAN_BASE, R_SPAN_COUNT, R_TURBPHASE, R_YMAX, R_YMIN, R_ORDERED, R_ZBITS, R_ALPHAQ,
  attachFrameAccum, attachRGBAccum, frameAccumTotal, rgbAccumTotal, packBandSpans, packFrameSpans,
  processBandJob, processFrameJob, processRGBFrameJob, processScanoutBand, readBandJob, resolveBand, resolveBandFused,
  sabAvailable, splitBands, syncWaitAllowed, writeBandJob, I_PER_SPAN,
  type Band,
  type BandDispatcher, type BandExecSample, type BandJobLabel, type BandViews, type FrameAccumViews, type RGBAccumViews, type ScanoutBandOptions,
} from './bands.js';
import { textureMasks, type LightBlock, type SpanList, type Texture, type RGBMipLevel } from './spans.js';
import { TRI_MAX_TRIS, TRI_I_PER_TRI } from './alias.js';

interface NodeProcessLike {
  versions?: { node?: string };
  getBuiltinModule?(id: string): unknown;
}

function nodeProcess(): NodeProcessLike | null {
  try {
    const g = globalThis as { process?: NodeProcessLike };
    const p = g.process;
    if (p && p.versions && typeof p.versions.node === 'string') return p;
  } catch {
    /* non-Node runtime */
  }
  return null;
}

interface WorkerLike {
  postMessage(v: unknown): void;
  on(ev: string, cb: (msg: unknown) => void): unknown;
  terminate(): Promise<number>;
  unref(): void;
}

interface WorkerThreadsLike {
  Worker: new (script: string, opts?: { eval?: boolean; workerData?: unknown }) => WorkerLike;
}

interface FsLike {
  existsSync(p: string): boolean;
}

declare function setTimeout(cb: () => void, ms: number): unknown;
declare function clearTimeout(t: unknown): void;

/**
 * Caller-side clock for `mainExecMs` (latency (b)): one function per call
 * site, both endpoints of the measured region. Mirrors the worker-side
 * default without sharing state across threads.
 */
function poolNow(): number {
  try {
    const g = globalThis as { performance?: { now?: () => number } };
    const perf = g.performance;
    // Keep the method call form: a detached `performance.now` throws.
    if (perf && typeof perf.now === 'function') {
      return perf.now();
    }
  } catch {
    /* fall through */
  }
  return Date.now();
}

function loadWorkerThreads(): WorkerThreadsLike | null {
  try {
    const p = nodeProcess();
    if (!p || typeof p.getBuiltinModule !== 'function') return null;
    const wt = p.getBuiltinModule('node:worker_threads') as WorkerThreadsLike | null;
    if (!wt || typeof wt.Worker !== 'function') return null;
    return wt;
  } catch {
    return null;
  }
}

function fileUrlOf(path: string): string {
  try {
    const p = nodeProcess();
    if (p && typeof p.getBuiltinModule === 'function') {
      const url = p.getBuiltinModule('node:url') as { pathToFileURL?(p: string): { href: string } } | null;
      const conv = url && url.pathToFileURL;
      if (typeof conv === 'function') return conv.call(url, path).href;
    }
  } catch {
    /* fall through to the manual prefix */
  }
  return path.startsWith('file://') ? path : `file://${path}`;
}

function pathExists(path: string): boolean {
  try {
    const p = nodeProcess();
    if (!p || typeof p.getBuiltinModule !== 'function') return false;
    const fs = p.getBuiltinModule('node:fs') as FsLike | null;
    return !!fs && typeof fs.existsSync === 'function' && fs.existsSync(path);
  } catch {
    return false;
  }
}

export interface PoolOptions {
  /** Absolute path of the built ESM bundle (dist/index.mjs); required by workers. */
  indexJsPath: string;
  /** Per-batch wait budget in ms (default 30_000). */
  timeoutMs?: number;
  /**
   * In-worker execution measurement (PERF-NEXT-4): forwarded to the worker
   * loop (`BandWorkerOptions.timing`), so production completion messages
   * carry a finite `execMs` plus identity/counts. Default true. False
   * restores the legacy `{ seq, band, pixels, spans }` shape with zero
   * clock reads in workers (acceptance path) and omits `mainExecMs` on
   * tallies.
   */
  workerTiming?: boolean;
}

/**
 * Fixed worker pool: worker i owns band i. Created synchronously; returns
 * null (silent fallback) when threads, SAB, or blocking waits are missing.
 */
export class BandWorkerPool implements BandDispatcher {
  readonly bandCount: number;
  private readonly workers: WorkerLike[] = [];
  // Mutable (not readonly): the PERF-NEXT-2 isolation fence re-points all
  // four at a replacement SAB when quarantine abandons a buffer that live
  // workers may still be scribbling.
  private views: FrameAccumViews;
  private rgbViews: RGBAccumViews;
  private base: BandViews;
  private ctl: Int32Array;
  private readonly bands: Band[];
  private readonly timeoutMs: number;
  private readonly fbW: number;
  private readonly fbH: number;
  private seq = 0;
  private lastTexels: Uint8Array | null = null;
  private lastLight: Uint8Array | null = null;
  private lastColormap: Uint8Array | null = null;
  private lastPalette: Uint8Array | null = null;
  private readonly pending = new Map<number, () => void>();
  private readyCount = 0;
  private frameGen = 0;
  private mainLastGen = 0;
  private disposed = false;
  /** Frame-accum bump offsets (reset by beginFrame/flush): packed spans,
   *  staged texels/light, descriptor count. Main thread only. */
  private spansUsed = 0;
  private texUsed = 0;
  private lightUsed = 0;
  private descCount = 0;
  /** RGB staging bump offsets (reset by beginFrame/commitRGB): packed spans,
   *  chain bytes, luxel bytes, descriptor count, per-frame chain slots,
   *  staged screen tris (TASK item 2). */
  private rgbSpansUsed = 0;
  private rgbChainUsed = 0;
  private rgbChainLevels = 0;
  private rgbChainSlots = 0;
  private rgbLuxUsed = 0;
  private rgbDescCount = 0;
  private rgbTriUsed = 0;
  private rgbChainMap = new Map<RGBMipLevel[], number>();
  /**
   * Retained-frame recovery watermark (TASK item 1): descriptors
   * [0, rgbFlushedCount) already hold plane writes from successful kicks;
   * flushes kick only the suffix [flushed, descCount) via CTL_RGBBASE.
   * commitRGB() (frame end) and beginFrame() reset it with the bumps.
   */
  private rgbFlushedCount = 0;
  /**
   * Last RGB flush outcome for recovery classification: 'clean' (nothing
   * ran — refusal/not-ready/declined/disposed/quarantined: suffix replay
   * without a clear converges) vs 'partial' (timeout with workers running
   * — the planes may hold partial blends, so recovery must clear +
   * full-replay; the timeout path quarantines first). Null after a
   * successful flush or when no RGB flush ran.
   */
  private rgbFailure: 'clean' | 'partial' | null = null;
  /**
   * Stale-write guard (mirrors the browser pool): a timed-out kick means
   * workers whose SAB writes may still be in flight. The timeout path
   * quarantines first — shutdown signal, replacement-buffer isolation
   * (fresh SAB, epoch bump), termination — and only then does the caller
   * replay, so no straggler write can race the recovery or any later frame.
   * All later kicks refuse fast until the pool is recreated. Explicit
   * refusals (dead pool, empty batches) and dispose do NOT quarantine —
   * only the timeout does, since only it implies in-flight writes. The
   * sync path relies on the isolation fence (it cannot await termination);
   * the async path additionally joins completed termination (bounded).
   */
  private quarantined = false;
  /**
   * Fence epoch (PERF-NEXT-2): incremented every time quarantine isolates
   * the shared planes onto a fresh SAB. The renderer re-adopts the pool's
   * current planes when this moves, so recovery + inline fallback can never
   * write the abandoned buffer a live worker may still be scribbling.
   * Plain counter (no atomics needed — main thread only).
   */
  private sabEpoch = 0;
  /**
   * Settled-termination promise for the quarantined workers (async-path
   * join). Null when no quarantine ran or termination needs no join (all
   * fake/scripted workers). Never rejects.
   */
  private quarantineSettled: Promise<void> | null = null;
  /**
   * In-worker execution measurement switch (PERF-NEXT-4): forwarded to the
   * worker loop at spawn. False also omits pool-side `mainExecMs`.
   */
  private readonly timingEnabled: boolean;
  /**
   * Newest kick's worker-local execution samples (PERF-NEXT-4 consumer
   * hook): `execSamples[band]` holds the validated `BandExecSample` that
   * band posted for `execSeq`, or null when it has not arrived yet.
   * Replaced (not grown) on every kick — bounded by the worker count.
   */
  private execSeq = -1;
  private execSamples: (BandExecSample | null)[] | null = null;
  /**
   * Newest slot-harvested kick (PERF-NEXT-4): `harvestSyncExec` marks the
   * seq it fed from shared memory so the workers' queued completion posts
   * — unread while the main thread blocked in Atomics.wait — are dropped
   * on arrival instead of double-feeding the per-frame accumulation.
   * Reset per kick in `kick()`; stale marks are harmless (the newest-kick
   * gate already drops older seqs).
   */
  private execSlotHarvested = -1;
  /**
   * Per-frame accumulation of validated worker samples (PERF-NEXT-4,
   * mirrors the browser pool): every validated `noteWorkerExec` sample is
   * appended here until `beginFrame` resets it. The newest-kick stash
   * above is too narrow for attribution — a production frame drains many
   * kicks (world, foreground flushes incl. the placed pass, resolve,
   * scanout) and later publishes invalidate the newest-kick gate even
   * when no newer kick ran. Bounded (`FRAME_EXEC_CAP`); oldest-first
   * order. Empty (not null) when timing is disabled or nothing posted.
   */
  private frameExecSamples: BandExecSample[] = [];

  private constructor(
    bandCount: number, views: FrameAccumViews, rgbViews: RGBAccumViews, ctl: Int32Array,
    bands: Band[],
    workers: WorkerLike[], timeoutMs: number, fbW: number, fbH: number,
    timingEnabled: boolean,
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
    this.timingEnabled = timingEnabled;
    for (const w of workers) {
      this.workers.push(w);
      try {
        w.on('message', (msg: unknown) => {
          if (msg && typeof msg === 'object') {
            const rec = msg as { seq?: unknown; ready?: unknown };
            if (rec.ready === true) this.readyCount += 1;
            if (typeof rec.seq === 'number') {
              this.noteWorkerExec(rec);
              const done = this.pending.get(rec.seq);
              if (done) done();
            }
          }
        });
      } catch {
        /* message hookup is async-dispatch only; sync path ignores it */
      }
    }
  }

  /**
   * Fixed pool: `workerCount` threads plus the calling thread, each owning
   * one band (`workerCount + 1` bands total). Created synchronously; returns
   * null (silent fallback) when threads, SAB, or blocking waits are missing.
   */
  static create(workerCount: number, w: number, h: number, opts: PoolOptions): BandWorkerPool | null {
    try {
      const n = Math.floor(workerCount);
      if (!Number.isFinite(n) || n < 1) return null;
      const workers = Math.min(n, MAX_WORKERS);
      if (!sabAvailable() || !syncWaitAllowed()) return null;
      if (!opts || typeof opts.indexJsPath !== 'string' || !pathExists(opts.indexJsPath)) return null;
      const wt = loadWorkerThreads();
      if (!wt) return null;
      const sab = new SharedArrayBuffer(rgbAccumTotal(w, h));
      const { views, ctl } = attachFrameAccum(sab, w, h);
      const { views: rgbViews } = attachRGBAccum(sab, w, h);
      // The calling thread owns the last band; workers take the rest.
      const bands = splitBands(h, workers + 1);
      const timingEnabled = opts.workerTiming !== false;
      const bootstrap = poolBootstrapSource();
      const spawned: WorkerLike[] = [];
      try {
        for (let i = 0; i < workers; i++) {
          const b = bands[i]!;
          const worker = new wt.Worker(bootstrap, {
            eval: true,
            workerData: {
              sab: views.ctl.buffer, w, h,
              y0: b.y0, y1: b.y1, band: i,
              indexJsUrl: fileUrlOf(opts.indexJsPath),
              timing: timingEnabled,
            },
          });
          try {
            worker.unref();
          } catch {
            /* unref optional */
          }
          spawned.push(worker);
        }
      } catch {
        for (const worker of spawned) {
          try {
            void worker.terminate();
          } catch {
            /* already gone */
          }
        }
        return null;
      }
      return new BandWorkerPool(workers + 1, views, rgbViews, ctl, bands, spawned, opts.timeoutMs ?? 30000, w, h, timingEnabled);
    } catch {
      return null;
    }
  }

  /** Live shared planes (the renderer adopts these when banded + attached). */
  get idx(): Uint8Array {
    return this.base.idx;
  }

  get zb(): Float32Array {
    return this.base.zb;
  }

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
    this.frameExecSamples = [];
    try {
      Atomics.store(this.ctl, CTL_FRAME, this.frameGen);
    } catch {
      /* ignore */
    }
  }

  /**
   * Staging-fit check for the SAB texture/light slots (mirrors the WASM
   * backend's TEX_CAP/LIGHT_CAP guards in tryWasmOpaque). Oversized or
   * short surface data can never be staged faithfully — stage() would copy
   * a prefix (or leave a stale tail) and workers would sample zeros/stale
   * texels as black. Unsuitable batches run inline instead, so output stays
   * bit-identical either way. The packed sky strip (256x1536 real art) is
   * the in-engine case: it exceeds TEX_CAP and must take the inline path.
   */
  private stagingFits(tex: Texture, light: LightBlock): boolean {
    const tw = tex.width | 0, th = tex.height | 0;
    const lw = light.width | 0, lh = light.height | 0;
    if (!(tw > 0 && th > 0 && lw > 0 && lh > 0)) return false;
    if (tex.texels.length < tw * th || tex.texels.length > TEX_CAP) return false;
    if (light.values.length < lw * lh || light.values.length > LIGHT_CAP) return false;
    return true;
  }

  /**
   * Rasterise one surface batch across the pool (blocking). Returns null
   * when the batch is unsuitable — the caller runs it inline instead.
   * Re-execution safe: all writes are depth-guarded, so a timeout fallback
   * that redraws inline converges to the identical planes.
   */
  dispatch(
    list: SpanList, tex: Texture, light: LightBlock,
    colormap: Uint8Array, time: number,
    fbW: number, fbH: number, idx: Uint8Array, zb: Float32Array,
  ): { pixels: number; spans: number; mainExecMs?: number } | null {
    if (this.disposed || this.workers.length === 0) return null;
    if (idx !== this.base.idx || zb !== this.base.zb) return null;
    const packed = this.pack(list);
    if (!packed) return null;
    if (packed.count === 0) return { pixels: 0, spans: 0 };
    if (packed.est < MIN_BAND_PIXELS) return null;
    if (!this.stagingFits(tex, light)) return null;
    if (!this.awaitReadySync()) {
      Com_Warn('bandPool: workers never became ready, redrawing inline');
      return null;
    }
    this.publish(tex, light, colormap, time, fbW, fbH, packed.count);
    const seq = this.seq;
    const kicked = this.kick(seq);
    if (!kicked) return null;
    // The calling thread owns the last band: rasterise it inline while the
    // workers run theirs, then collect. Same math, golden-identical.
    const mainBand = this.bands[this.bands.length - 1]!;
    this.clearMainBand(mainBand, fbW);
    const m0 = this.timingEnabled ? poolNow() : 0;
    const main = processBandJob(this.base, readBandJob(this.ctl, mainBand.y0, mainBand.y1));
    const m1 = this.timingEnabled ? poolNow() : 0;
    const deadline = Date.now() + this.timeoutMs;
    let done = Atomics.load(this.ctl, CTL_DONE);
    while (done < this.workers.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        Com_Warn(`bandPool: batch timeout after ${this.timeoutMs}ms, redrawing inline`);
        return null;
      }
      try {
        Atomics.wait(this.ctl, CTL_DONE, done, Math.min(remaining, 1000));
      } catch {
        return null; // wait unavailable after all -> inline
      }
      done = Atomics.load(this.ctl, CTL_DONE);
    }
    const tally = this.tally();
    tally.pixels += main.pixels;
    tally.spans += main.spans;
    if (this.timingEnabled) tally.mainExecMs = m1 - m0 >= 0 ? m1 - m0 : 0;
    // Sync-kick exec harvest (PERF-NEXT-4): same worker-local durations
    // the message path would carry, read from CTL_EXEC after the fence.
    this.harvestSyncExec(seq, 'raster', 0, 1);
    return tally;
  }

  /**
   * Same as dispatch but awaits worker completion messages instead of
   * blocking (for threads that forbid Atomics.wait, e.g. a future browser
   * async-render path). Resolves null on timeout or when unsuitable.
   */
  async dispatchAsync(
    list: SpanList, tex: Texture, light: LightBlock,
    colormap: Uint8Array, time: number,
    fbW: number, fbH: number, idx: Uint8Array, zb: Float32Array,
  ): Promise<{ pixels: number; spans: number; mainExecMs?: number } | null> {
    if (this.disposed || this.workers.length === 0) return null;
    if (idx !== this.base.idx || zb !== this.base.zb) return null;
    const packed = this.pack(list);
    if (!packed) return null;
    if (packed.count === 0) return Promise.resolve({ pixels: 0, spans: 0 });
    if (packed.est < MIN_BAND_PIXELS) return null;
    if (!this.stagingFits(tex, light)) return null;
    if (!(await this.awaitReadyAsync())) {
      Com_Warn('bandPool: workers never became ready, redrawing inline');
      return null;
    }
    this.publish(tex, light, colormap, time, fbW, fbH, packed.count);
    const seq = this.seq;
    const finished = this.awaitWorkerMessages(seq, this.workers.length);
    if (!this.kick(seq)) {
      this.pending.delete(seq);
      return null;
    }
    // Main-thread band first (sync), then await the workers.
    const mainBand = this.bands[this.bands.length - 1]!;
    this.clearMainBand(mainBand, fbW);
    const m0 = this.timingEnabled ? poolNow() : 0;
    const main = processBandJob(this.base, readBandJob(this.ctl, mainBand.y0, mainBand.y1));
    const m1 = this.timingEnabled ? poolNow() : 0;
    const ok = await finished;
    if (!ok) {
      Com_Warn(`bandPool: async batch timeout after ${this.timeoutMs}ms, redrawing inline`);
      return null;
    }
    const tally = this.tally();
    tally.pixels += main.pixels;
    tally.spans += main.spans;
    if (this.timingEnabled) tally.mainExecMs = m1 - m0 >= 0 ? m1 - m0 : 0;
    return tally;
  }

  /** Shut workers down; safe to call twice. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
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
        await worker.terminate();
      } catch {
        /* already gone */
      }
    }
    this.workers.length = 0;
    this.pending.clear();
    // Join any quarantine-termination still in flight (bounded by the
    // terminate promises themselves — they resolve once the thread stops).
    // Proves no doomed worker can still write after dispose returns.
    const settled = this.quarantineSettled;
    this.quarantineSettled = null;
    if (settled) {
      try {
        await settled;
      } catch {
        /* already settled */
      }
    }
  }

  /** Block until every worker entered its wait loop (first job only). */
  private awaitReadySync(): boolean {
    const deadline = Date.now() + this.timeoutMs;
    let ready = Atomics.load(this.ctl, CTL_READY);
    while (ready < this.workers.length) {
      if (this.disposed) return false;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      try {
        Atomics.wait(this.ctl, CTL_READY, ready, Math.min(remaining, 1000));
      } catch {
        return false;
      }
      ready = Atomics.load(this.ctl, CTL_READY);
    }
    return true;
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
        setTimeout(poll, 10);
      };
      poll();
    });
  }

  /** Pack spans straight into the shared staging views. */
  private pack(list: SpanList): { count: number; est: number } | null {
    return packBandSpans(list, this.base.spansF, this.base.spansI);
  }

  /**
   * Flat-span staging cursor for fused emission (M8.1): the current bump
   * base + remaining cap. The renderer emits one batch into it, then calls
   * packBatched — same-thread sequencing guarantees the base still matches.
   * Null when the pool is dead. Never advances (packBatched owns that).
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
   * Capture one fused-emitted batch into the frame kick (M8.1): the spans
   * were packed during emission (see EmitFlat), so this only stages
   * (tex, light) and records a descriptor. Returns false when the batch
   * must run inline immediately (sequencing break, exhausted regions, or
   * unsuitable input) — the caller flushes pending batches first, so
   * global batch order (and hence every pixel) is preserved. Never throws.
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
    if (spanCount === 0) return true; // nothing rasterisable; handled
    const tw = tex.width | 0, th = tex.height | 0;
    const lw = light.width | 0, lh = light.height | 0;
    if (!(tw > 0 && th > 0 && lw > 0 && lh > 0)) return false;
    const texBytes = tw * th, lightBytes = lw * lh;
    if (tex.texels.length < texBytes || light.values.length < lightBytes) return false;
    if (texBytes > FRAME_TEX_CAP - this.texUsed) return false;
    if (lightBytes > FRAME_LIGHT_CAP - this.lightUsed) return false;
    const fv = this.views;
    // Stage surface data (exact-size .set copies, no view allocation on the
    // hot path; oversized carriers fall back to a bounded subarray copy).
    if (tex.texels.length === texBytes) fv.fTex.set(tex.texels, this.texUsed);
    else fv.fTex.set(tex.texels.subarray(0, texBytes), this.texUsed);
    if (light.values.length === lightBytes) fv.fLight.set(light.values, this.lightUsed);
    else fv.fLight.set(light.values.subarray(0, lightBytes), this.lightUsed);
    this.stageColormap(colormap);
    const masks = textureMasks(tex);
    const phase = ((time * 64) | 0) & (this.base.turb.length - 1);
    const d = this.descCount * D_PER_BATCH;
    fv.desc[d + D_SPAN_BASE] = spanBase;
    fv.desc[d + D_SPAN_COUNT] = spanCount;
    fv.desc[d + D_TEX_OFF] = this.texUsed;
    fv.desc[d + D_TEX_W] = tw;
    fv.desc[d + D_TEX_H] = th;
    fv.desc[d + D_LIGHT_OFF] = this.lightUsed;
    fv.desc[d + D_LIGHT_W] = lw;
    fv.desc[d + D_LIGHT_H] = lh;
    fv.desc[d + D_WSHIFT] = masks.wshift;
    fv.desc[d + D_WMASK] = masks.wmask;
    fv.desc[d + D_HMASK] = masks.hmask;
    fv.desc[d + D_TURBPHASE] = phase;
    // Worker-owned band-cull range (PERF-FINISH-A item B): one integer pass
    // over this batch's staged spans at staging time. The emitter writes
    // strictly increasing y, so this is a pure bound read; every worker
    // then rejects non-overlapping descriptors BEFORE material/view setup
    // with no rescan. Zero range would mean "unknown" (never staged here —
    // spanCount > 0 always reaches this point). The same pass records the
    // row-order proof (D_ORDERED): the emitter + row sorter emit
    // non-decreasing y, so workers may binary-search owned subranges with
    // no per-worker validation scan; anything else falls back to the full
    // scan, output-identical.
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
    fv.desc[d + D_YMIN] = ymin;
    fv.desc[d + D_YMAX] = ymax;
    fv.desc[d + D_ORDERED] = ordered;
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
   * Kick ONE frame covering every accumulated batch and block for the
   * workers (the async-render completion primitive; the browser path uses
   * flushFrameAsync instead). Resolves null when the pool is dead or the
   * wait times out — the caller replays inline via drawInlineAll, which
   * converges to the identical planes (all writes depth-guarded).
   */
  flushFrame(): { pixels: number; spans: number; mainExecMs?: number } | null {
    if (this.disposed || this.workers.length === 0) return null;
    if (this.descCount === 0) return { pixels: 0, spans: 0 };
    if (!this.awaitReadySync()) {
      Com_Warn('bandPool: workers never became ready, redrawing inline');
      return null;
    }
    this.publishFrame();
    const seq = this.seq;
    if (!this.kick(seq)) return null;
    // The calling thread owns the last band: drain it inline while the
    // workers drain theirs, then collect. Same math, golden-identical.
    const mainBand = this.bands[this.bands.length - 1]!;
    this.clearMainBand(mainBand, this.fbW);
    const m0 = this.timingEnabled ? poolNow() : 0;
    const main = processFrameJob(
      this.views, this.fbW, this.fbH, this.descCount, mainBand.y0, mainBand.y1,
    );
    const m1 = this.timingEnabled ? poolNow() : 0;
    const ok = this.awaitDoneSync();
    if (!ok) {
      Com_Warn(`bandPool: frame timeout after ${this.timeoutMs}ms, redrawing inline`);
      return null;
    }
    const tally = this.tally();
    tally.pixels += main.pixels;
    tally.spans += main.spans;
    tally.scanned += main.scanned;
    if (this.timingEnabled) tally.mainExecMs = m1 - m0 >= 0 ? m1 - m0 : 0;
    // Sync-kick exec harvest (PERF-NEXT-4); descCount still pre-reset here.
    this.harvestSyncExec(seq, 'raster', 0, this.descCount);
    this.resetAccum();
    return tally;
  }

  /**
   * Same as flushFrame but awaits worker completion messages instead of
   * blocking (for threads that forbid Atomics.wait — the browser
   * async-render completion path). Resolves null on timeout or dead pool.
   */
  async flushFrameAsync(): Promise<{ pixels: number; spans: number; mainExecMs?: number } | null> {
    if (this.disposed || this.workers.length === 0) return null;
    if (this.descCount === 0) return { pixels: 0, spans: 0 };
    if (!(await this.awaitReadyAsync())) {
      Com_Warn('bandPool: workers never became ready, redrawing inline');
      return null;
    }
    this.publishFrame();
    const seq = this.seq;
    const finished = this.awaitWorkerMessages(seq, this.workers.length);
    if (!this.kick(seq)) {
      this.pending.delete(seq);
      return null;
    }
    // Main-thread band first (sync), then await the workers.
    const mainBand = this.bands[this.bands.length - 1]!;
    this.clearMainBand(mainBand, this.fbW);
    const m0 = this.timingEnabled ? poolNow() : 0;
    const main = processFrameJob(
      this.views, this.fbW, this.fbH, this.descCount, mainBand.y0, mainBand.y1,
    );
    const m1 = this.timingEnabled ? poolNow() : 0;
    const ok = await finished;
    if (!ok) {
      Com_Warn(`bandPool: async frame timeout after ${this.timeoutMs}ms, redrawing inline`);
      return null;
    }
    const tally = this.tally();
    tally.pixels += main.pixels;
    tally.spans += main.spans;
    tally.scanned += main.scanned;
    if (this.timingEnabled) tally.mainExecMs = m1 - m0 >= 0 ? m1 - m0 : 0;
    this.resetAccum();
    return tally;
  }

  /**
   * Full-frame inline replay of the accumulated batches on the calling
   * thread (timeout fallback). Clears both planes first: a timed-out kick
   * may have left bands partially drawn/cleared, and only a full clear +
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

  /**
   * Resolve kick (M8.1 parallel resolve + PERF-5 fused composite):
   * palette-expand the final index plane into the shared color plane across
   * the pool, compositing the RGB overlay where covered. True unless the
   * pool is dead, a worker never became ready, or the wait times out — the
   * caller expands inline instead (identical).
   */
  resolveFrame(): boolean {
    if (this.disposed || this.workers.length === 0) return false;
    if (!this.awaitReadySync()) {
      Com_Warn('bandPool: workers never became ready, resolving inline');
      return false;
    }
    this.publishResolve();
    const seq = this.seq;
    if (!this.kick(seq)) return false;
    const mainBand = this.bands[this.bands.length - 1]!;
    resolveBandFused(this.views.fColor, this.views.fPal, this.base.idx, this.rgbViews.rgb565, this.rgbViews.cover, mainBand.y0, mainBand.y1, this.fbW, this.fbH);
    const okResolve = this.awaitDoneSync();
    // Sync-kick exec harvest (PERF-NEXT-4): resolve workers measured in-loop.
    if (okResolve) this.harvestSyncExec(seq, 'resolve', 0, 0);
    return okResolve;
  }

  /**
   * Same as resolveFrame but message-driven (browser async completion).
   */
  async resolveFrameAsync(): Promise<boolean> {
    if (this.disposed || this.workers.length === 0) return false;
    if (!(await this.awaitReadyAsync())) {
      Com_Warn('bandPool: workers never became ready, resolving inline');
      return false;
    }
    this.publishResolve();
    const seq = this.seq;
    const finished = this.awaitWorkerMessages(seq, this.workers.length);
    if (!this.kick(seq)) {
      this.pending.delete(seq);
      return false;
    }
    const mainBand = this.bands[this.bands.length - 1]!;
    resolveBandFused(this.views.fColor, this.views.fPal, this.base.idx, this.rgbViews.rgb565, this.rgbViews.cover, mainBand.y0, mainBand.y1, this.fbW, this.fbH);
    return finished;
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

  /**
   * Parallel scanout kick (Track A, blocking): fused pack→recon→gamma from
   * the finished shared color plane into the shared scanout buffers, drained
   * by all bands. Inputs immutable for the kick, outputs disjoint, dither
   * uses absolute coords — byte-identical to the serial voodoo path. True
   * unless the pool is dead or the wait times out (caller runs serial).
   */
  flushScanout(opts: ScanoutBandOptions): boolean {
    if (this.disposed || this.workers.length === 0) return false;
    if (!this.awaitReadySync()) return false;
    this.publishScanout(opts);
    const seq = this.seq;
    if (!this.kick(seq)) return false;
    const mainBand = this.bands[this.bands.length - 1]!;
    processScanoutBand(
      this.views.fColor, this.rgbViews.scan565, this.rgbViews.scanDisplay,
      this.fbW, this.fbH, opts, mainBand.y0, mainBand.y1,
    );
    const okScanout = this.awaitDoneSync();
    // Sync-kick exec harvest (PERF-NEXT-4): scanout workers measured in-loop.
    if (okScanout) this.harvestSyncExec(seq, 'scanout', 0, 0);
    return okScanout;
  }

  /**
   * Same as flushScanout but message-driven (browser async completion).
   */
  async flushScanoutAsync(opts: ScanoutBandOptions): Promise<boolean> {
    if (this.disposed || this.workers.length === 0) return false;
    if (!(await this.awaitReadyAsync())) return false;
    this.publishScanout(opts);
    const seq = this.seq;
    const finished = this.awaitWorkerMessages(seq, this.workers.length);
    if (!this.kick(seq)) {
      this.pending.delete(seq);
      return false;
    }
    const mainBand = this.bands[this.bands.length - 1]!;
    processScanoutBand(
      this.views.fColor, this.rgbViews.scan565, this.rgbViews.scanDisplay,
      this.fbW, this.fbH, opts, mainBand.y0, mainBand.y1,
    );
    return finished;
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
   * Stage one world RGB batch into the SAB (main side). Copies the span
   * slice, the material's mip chain (deduplicated across frames by chain
   * identity — persistent SAB upload, PERF-5) and the luxel block, then
   * records the descriptor (with its span y-range for worker band-culling).
   * Returns false when the batch must run inline (dead pool, exhausted
   * regions, too many chains/levels, oversized chain or luxels) — the caller
   * replays pending batches inline first so global batch order is preserved.
   * Never throws.
   */
  stageRGB(
    list: SpanList, spanStart: number, spanCount: number,
    levels: RGBMipLevel[],
    luxels: Uint8Array | null, luxW: number, luxH: number,
    flags: number, zbits: number, turbPhase: number, flatRGB: number,
  ): boolean {
    if (this.disposed || this.workers.length === 0) return false;
    if (this.quarantined) return false;
    if (this.rgbDescCount >= MAX_RGB_BATCHES) return false;
    if (!(spanCount >= 0)) return false;
    if (levels.length < 1 || levels.length > 32) return false;
    if (spanCount > 0) {
      if (spanStart < 0 || spanCount > MAX_RGB_SPANS - this.rgbSpansUsed) return false;
      const packed = packFrameSpans(
        list, this.rgbViews.spansF, this.rgbViews.spansI,
        this.rgbSpansUsed, this.rgbSpansUsed,
        MAX_RGB_SPANS - this.rgbSpansUsed, spanStart,
      );
      if (!packed || packed.count !== spanCount) return false;
    }
    // Chain dedupe by identity (shared per-texture chains hit every time).
    // Persistent across frames: the SAB chain region is a stable upload
    // cache (copy-on-first-use, retained by resetRGB). Evict-all + retry
    // once when a genuinely new chain does not fit.
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
        // Ownership fix (Phase 0): previously staged descriptors hold slot
        // indices into the persistent chain region. Evicting here would reuse
        // those slots for different chains and silently corrupt pending work.
        // When batches are already pending, refuse to stage (caller replays
        // pending inline first, preserving order); the next frame starts with
        // an empty pending set and may safely evict. Only evict-and-retry
        // when nothing is pending, so no live descriptor references stale
        // bytes. Never throws.
        if (this.rgbDescCount > 0) return false;
        this.clearRGBChains();
        s = allocChain();
        if (s === undefined) return false;
      }
      slot = s;
    }
    let luxOff = 0;
    if (luxels && luxW > 0 && luxH > 0) {
      const need = luxW * luxH * 3;
      if (luxels.length < need) return false;
      if (need > RGB_LUX_CAP - this.rgbLuxUsed) return false;
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
    // Band-cull range: min/max span row staged in this batch. Scans the
    // just-packed flat spans (I_PER_SPAN stride, y at +1); per-batch spans
    // are few, total cost is one integer pass over the frame's spans. The
    // same pass records the row-order proof (R_ORDERED) for the worker
    // subrange search; unordered content keeps the full-scan fallback.
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

  /**
   * Flat-tri staging cursor for alias emission (TASK item 2): the current
   * bump base + remaining cap. The renderer emits one entity's screen tris
   * into it, then calls stageTriBatch — same-thread sequencing guarantees
   * the base still matches. Null when the pool is dead. Never advances
   * (stageTriBatch owns that).
   */
  triCursor(): { F: Float64Array; I: Int32Array; base: number; cap: number } | null {
    if (this.disposed || this.workers.length === 0 || this.quarantined) return null;
    return {
      F: this.rgbViews.triF, I: this.rgbViews.triI,
      base: this.rgbTriUsed, cap: TRI_MAX_TRIS - this.rgbTriUsed,
    };
  }

  /**
   * Record one entity's prepared tri batch into the RGB kick (TASK item 2):
   * the tris were emitted via triCursor (24 doubles each + ymin/ymax),
   * this stages (chain dedup, descriptor with R_FLAG_TRI + per-batch
   * alphaQ). Returns false when the batch must run inline immediately
   * (dead pool, exhausted regions, too many chains/levels, oversized
   * payload) — the caller replays pending batches first so global batch
   * order is preserved (see frame.ts drawInlineRGBRest). Chain eviction
   * refuses while descriptors are retained (same ownership rule as
   * stageRGB). Never throws.
   */
  stageTriBatch(
    triBase: number, triCount: number,
    levels: RGBMipLevel[],
    flags: number, zbits: number, alphaQ: number,
  ): boolean {
    if (this.disposed || this.workers.length === 0 || this.quarantined) return false;
    if (this.rgbDescCount >= MAX_RGB_BATCHES) return false;
    if (!(triCount >= 0)) return false;
    if (levels.length < 1 || levels.length > 32) return false;
    if (triCount > 0) {
      if (triBase < 0 || triCount > TRI_MAX_TRIS - this.rgbTriUsed) return false;
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
        if (this.rgbDescCount > 0) return false;
        this.clearRGBChains();
        s = allocChain();
        if (s === undefined) return false;
      }
      slot = s;
    }
    // Descriptor y-range union + validity scan over the staged tris
    // (one pass; workers band-cull on R_YMIN/YMAX before resolving).
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

  /** Pending staged RGB batches (observability for the renderer/tests). */
  rgbPending(): number {
    return this.rgbDescCount;
  }

  /**
   * Kick ONE RGB frame covering the unapplied suffix and block for the
   * workers. Retained-frame protocol (TASK item 1): descriptors persist
   * across flushes within a frame — this kicks [flushed, descCount) via
   * CTL_RGBBASE and advances `flushed` on success (commitRGB() at frame
   * end drops the retention). Resolves null when the pool is dead or the
   * wait times out — the caller replays via recoverInlineRGBAll (identical
   * planes: recovery clears + replays the full retained range with a
   * background seed, so partial blends apply exactly once). Timeout
   * quarantines first (class 'partial'); pre-dispatch failures (not
   * ready, declined, disposed, quarantined, empty suffix) are class
   * 'clean' — see lastRGBFailure.
   */
  flushRGBFrame(near: number, far: number, lodBias: number): { pixels: number; spans: number; workerSpans: number; workerPixels: number; tris: number; workerTris: number; mainExecMs?: number } | null {
    if (this.disposed || this.workers.length === 0 || this.quarantined) {
      this.rgbFailure = 'clean';
      return null;
    }
    if (this.rgbDescCount <= this.rgbFlushedCount) return { pixels: 0, spans: 0, workerSpans: 0, workerPixels: 0, tris: 0, workerTris: 0 };
    if (!this.awaitReadySync()) {
      Com_Warn('bandPool: workers never became ready, replaying RGB inline');
      this.rgbFailure = 'clean';
      return null;
    }
    this.publishRGB(near, far, lodBias);
    const seq = this.seq;
    if (!this.kick(seq)) {
      this.rgbFailure = 'clean';
      return null;
    }
    // The calling thread owns the last band: drain its share of the SUFFIX
    // inline while the workers drain theirs, then collect. Same math,
    // golden-identical.
    const mainBand = this.bands[this.bands.length - 1]!;
    const m0 = this.timingEnabled ? poolNow() : 0;
    const main = processRGBFrameJob(
      this.rgbViews, this.fbW, this.fbH, this.rgbDescCount, mainBand.y0, mainBand.y1,
      this.rgbFlushedCount,
    );
    const m1 = this.timingEnabled ? poolNow() : 0;
    const ok = this.awaitDoneSync();
    if (!ok) {
      Com_Warn(`bandPool: RGB frame timeout after ${this.timeoutMs}ms, quarantining + replaying inline`);
      this.quarantineWorkers();
      this.rgbFailure = 'partial';
      return null;
    }
    const tally = this.tally();
    tally.pixels += main.pixels;
    tally.spans += main.spans;
    tally.scanned += main.scanned;
    tally.tris += main.tris;
    if (this.timingEnabled) tally.mainExecMs = m1 - m0 >= 0 ? m1 - m0 : 0;
    // Sync-kick exec harvest (PERF-NEXT-4); watermark still pre-advance here.
    this.harvestSyncExec(seq, 'rgb', this.rgbFlushedCount, this.rgbDescCount);
    this.rgbFlushedCount = this.rgbDescCount;
    this.rgbFailure = null;
    return { ...tally, workerSpans: tally.spans - main.spans, workerPixels: tally.pixels - main.pixels, workerTris: tally.tris - main.tris };
  }

  /**
   * Same as flushRGBFrame but awaits worker completion messages instead of
   * blocking (for threads that forbid Atomics.wait). Timeout quarantines
   * first (class 'partial'); pre-dispatch failures are class 'clean'.
   */
  async flushRGBFrameAsync(near: number, far: number, lodBias: number): Promise<{ pixels: number; spans: number; workerSpans: number; workerPixels: number; tris: number; workerTris: number; mainExecMs?: number } | null> {
    if (this.disposed || this.workers.length === 0 || this.quarantined) {
      this.rgbFailure = 'clean';
      return null;
    }
    if (this.rgbDescCount <= this.rgbFlushedCount) return { pixels: 0, spans: 0, workerSpans: 0, workerPixels: 0, tris: 0, workerTris: 0 };
    if (!(await this.awaitReadyAsync())) {
      Com_Warn('bandPool: workers never became ready, replaying RGB inline');
      this.rgbFailure = 'clean';
      return null;
    }
    this.publishRGB(near, far, lodBias);
    const seq = this.seq;
    const finished = this.awaitWorkerMessages(seq, this.workers.length);
    if (!this.kick(seq)) {
      this.pending.delete(seq);
      this.rgbFailure = 'clean';
      return null;
    }
    const mainBand = this.bands[this.bands.length - 1]!;
    const m0 = this.timingEnabled ? poolNow() : 0;
    const main = processRGBFrameJob(
      this.rgbViews, this.fbW, this.fbH, this.rgbDescCount, mainBand.y0, mainBand.y1,
      this.rgbFlushedCount,
    );
    const m1 = this.timingEnabled ? poolNow() : 0;
    const ok = await finished;
    if (!ok) {
      Com_Warn(`bandPool: async RGB frame timeout after ${this.timeoutMs}ms, quarantining + replaying inline`);
      this.quarantineWorkers();
      // Bounded completion join: isolation already fenced the planes, so
      // this only proves the doomed workers are gone before we report.
      await this.quarantineWorkersAsync();
      this.rgbFailure = 'partial';
      return null;
    }
    const tally = this.tally();
    tally.pixels += main.pixels;
    tally.spans += main.spans;
    tally.scanned += main.scanned;
    tally.tris += main.tris;
    if (this.timingEnabled) tally.mainExecMs = m1 - m0 >= 0 ? m1 - m0 : 0;
    this.rgbFlushedCount = this.rgbDescCount;
    this.rgbFailure = null;
    return { ...tally, workerSpans: tally.spans - main.spans, workerPixels: tally.pixels - main.pixels, workerTris: tally.tris - main.tris };
  }

  /**
   * Full-frame inline replay of the staged RGB batches on the calling
   * thread (retained-frame protocol): clears the planes and applies the
   * FULL retained range [0, descCount) in order, then marks it applied.
   * No background seed — the caller seeds where a blend suffix needs it
   * (see recoverInlineRGBAll). Converges to the identical planes when no
   * partial worker writes are outstanding (classes a/b); after a partial
   * run use recoverInlineRGBAll instead (class c/d).
   */
  drawInlineRGBAll(near: number, far: number, lodBias: number): { pixels: number; spans: number } {
    this.rgbViews.cover.fill(0);
    this.rgbViews.rgbDepth.fill(0xffff);
    this.publishRGBFull(near, far, lodBias);
    const r = processRGBFrameJob(
      this.rgbViews, this.fbW, this.fbH, this.rgbDescCount, 0, this.fbH,
    );
    this.rgbFlushedCount = this.rgbDescCount;
    this.rgbFailure = null;
    return r;
  }

  /**
   * Complete-frame recovery replay on the calling thread (classes a-d):
   * re-applies the retained descriptors in exact serial order with
   * exactly-once blends. The replay shape is selected by the unapplied
   * suffix [flushed, descCount):
   * - Suffix has NO blends (opaque/depth-writing only): re-apply the
   *   suffix in place — no clear, no seed. Opaque writes are idempotent
   *   under depth-guarded rewrite (same values over partial worker
   *   output converge), and skipping the clear PRESERVES any inline
   *   foreground writes already on the planes (alias/entities/particles
   *   drawn between kicks are not retained and could never be replayed).
   *   Correct for staging refusal (a: nothing ran), clean failure (b:
   *   nothing ran) and partial opaque failure (c: same values rewritten).
   * - Suffix HAS blends (translucent alpha): clear the planes,
   *   inline-apply the world prefix [0, flushed), run `seed` (renderer
   *   re-seeds the RGB565 background from the final indexed plane for
   *   uncovered pixels), inline-apply the suffix. The clear discards
   *   partial worker blends so they apply exactly once. Safe because a
   *   blend suffix only exists before any inline write (the renderer
   *   refuses to stage blends once direct inline writes happened — see
   *   frame.ts rgbDirectInlineWrites — so the clear can never discard
   *   un-retained work).
   * Infallible. The caller must ensure no worker can still write (the
   * timeout paths quarantine before returning null — never call this
   * while workers are running a kick). Ends with flushed == descCount.
   * Returns the combined replay tally.
   */
  recoverInlineRGBAll(seed: () => void, near: number, far: number, lodBias: number): { pixels: number; spans: number; scanned?: number; tris: number } {
    const flushed = this.rgbFlushedCount < 0 ? 0
      : this.rgbFlushedCount > this.rgbDescCount ? this.rgbDescCount
      : this.rgbFlushedCount;
    // Suffix blend scan (one int32 read per descriptor): blends and
    // additives are destination-dependent (re-applying over partial output
    // blends twice / adds twice), opaque writes are idempotent rewrites.
    let suffixBlends = false;
    const desc = this.rgbViews.rgbDesc;
    for (let b = flushed; b < this.rgbDescCount; b++) {
      const f = desc[b * R_PER_BATCH + R_FLAGS]!;
      if ((f & (R_FLAG_BLEND_ALPHA | R_FLAG_ADDITIVE)) !== 0) {
        suffixBlends = true;
        break;
      }
    }
    this.publishRGBFull(near, far, lodBias);
    if (!suffixBlends) {
      const r = this.rgbDescCount > flushed
        ? processRGBFrameJob(this.rgbViews, this.fbW, this.fbH, this.rgbDescCount, 0, this.fbH, flushed)
        : { pixels: 0, spans: 0, scanned: 0, tris: 0 };
      this.rgbFlushedCount = this.rgbDescCount;
      this.rgbFailure = null;
      return r;
    }
    this.rgbViews.cover.fill(0);
    this.rgbViews.rgbDepth.fill(0xffff);
    const pre = flushed > 0
      ? processRGBFrameJob(this.rgbViews, this.fbW, this.fbH, flushed, 0, this.fbH)
      : { pixels: 0, spans: 0, scanned: 0, tris: 0 };
    try {
      seed();
    } catch {
      /* a throwing seed must not wedge the frame: suffix still replays */
    }
    const post = this.rgbDescCount > flushed
      ? processRGBFrameJob(this.rgbViews, this.fbW, this.fbH, this.rgbDescCount, 0, this.fbH, flushed)
      : { pixels: 0, spans: 0, scanned: 0, tris: 0 };
    this.rgbFlushedCount = this.rgbDescCount;
    this.rgbFailure = null;
    return {
      pixels: pre.pixels + post.pixels,
      spans: pre.spans + post.spans,
      scanned: (pre.scanned ?? 0) + (post.scanned ?? 0),
      tris: (pre.tris ?? 0) + (post.tris ?? 0),
    };
  }

  /** Applied prefix length: descriptors [0, flushed) hold plane writes. */
  rgbFlushed(): number {
    return this.rgbFlushedCount;
  }

  /**
   * End-of-frame: drop all retained RGB descriptors (spans/lux/descs +
   * the applied watermark). The persistent chain upload cache survives
   * (copy-on-first-use across frames). beginFrame() also resets, so a
   * missed commit can never leak one frame's descriptors into the next.
   */
  commitRGB(): void {
    this.resetRGB();
  }

  /** Last RGB flush outcome: 'clean' (nothing ran), 'partial' (workers may have written), null (success/none). */
  lastRGBFailure(): 'clean' | 'partial' | null {
    return this.rgbFailure;
  }

  /**
   * Worker-local execution samples for the most recent kick (PERF-NEXT-4
   * Node-consumer hook; see `BandDispatcher.lastWorkerExec`). Strictly
   * newest-kick: null once a newer kick is issued until its completions
   * arrive, when timing is disabled, or when nothing posted a measurement.
   * Copies (mutating the result never corrupts the stash).
   */
  lastWorkerExec(): BandExecSample[] | null {
    if (this.execSeq !== this.seq) return null;
    const samples = this.execSamples;
    if (!samples) return null;
    const out: BandExecSample[] = [];
    for (const s of samples) {
      if (s !== null) out.push({ ...s });
    }
    return out.length > 0 ? out : null;
  }

  /**
   * Feature-detected timing hook shared with the browser pool
   * (`BrowserBandPool.testBandExecStats`, PERF-NEXT-4): the frame's
   * per-band samples in the consumer vocabulary — worker-local `execMs`,
   * frame/sequence identity, band rows, work counts — accumulated since
   * `beginFrame` across EVERY kick (world, foreground flushes incl. the
   * placed pass, resolve, scanout), oldest-first, bounded (256). Wire
   * labels map to the shared job names ('raster'→'indexed-frame',
   * 'resolve'→'indexed-resolve'; 'rgb'/'scanout' direct); 'unknown' kicks
   * are dropped (raw samples stay on `lastWorkerExec`). Structural shape
   * only — no testkit import (dependency direction forbids it); consumers
   * validate field-by-field. Null when timing is disabled or nothing
   * posted yet this frame. Never throws.
   */
  testBandExecStats(): Array<{
    frame: number; seq: number;
    job: 'rgb' | 'scanout' | 'indexed-resolve' | 'indexed-frame';
    worker: number; band: number; y0: number; y1: number;
    execMs: number; pixels: number; spans: number; tris: number;
  }> | null {
    if (!this.timingEnabled || this.frameExecSamples.length === 0) return null;
    const out: Array<{
      frame: number; seq: number;
      job: 'rgb' | 'scanout' | 'indexed-resolve' | 'indexed-frame';
      worker: number; band: number; y0: number; y1: number;
      execMs: number; pixels: number; spans: number; tris: number;
    }> = [];
    for (const s of this.frameExecSamples) {
      const job = s.job === 'raster' ? 'indexed-frame'
        : s.job === 'resolve' ? 'indexed-resolve'
        : s.job === 'rgb' ? 'rgb'
        : s.job === 'scanout' ? 'scanout' : null;
      if (job === null) continue;
      out.push({
        frame: s.frame, seq: s.seq, job, worker: s.band, band: s.band,
        y0: s.y0, y1: s.y1, execMs: s.execMs, pixels: s.pixels,
        spans: s.spans, tris: s.tris,
      });
    }
    return out.length > 0 ? out : null;
  }

  /**
   * Stash one validated worker completion for the newest kick. Newest-kick
   * only (`seq === this.seq`): a late arrival for an older kick — e.g. a
   * doomed worker's post-timeout partial — never overwrites a newer kick's
   * samples. Legacy `{ seq, band, pixels, spans }` messages carry no
   * `execMs` and are ignored, so the stash holds measured durations only
   * (never nulls, never synthetic values). Kicks harvested from shared
   * memory by `harvestSyncExec` drop their (queued, unread) messages here
   * via the `execSlotHarvested` mark — same samples, never double-fed to
   * the per-frame accumulation. Identity + `execMs` are strictly
   * validated; counts coerce to 0 when absent. Never throws.
   */
  private noteWorkerExec(msg: { seq?: unknown; ready?: unknown }): void {
    if (this.disposed || !this.timingEnabled) return;
    const rec = msg as {
      seq?: unknown; band?: unknown; frame?: unknown; job?: unknown;
      y0?: unknown; y1?: unknown; execMs?: unknown; pixels?: unknown;
      spans?: unknown; scanned?: unknown; tris?: unknown; descs?: unknown;
      kickBase?: unknown; kickDescs?: unknown;
    };
    const seq = rec.seq;
    // Newest-kick gate: only the kick in flight (`execSeq`, armed by
    // `kick()`) is accepted — pre-kick (-1) and stale seqs are ignored, so
    // a synthetic message can never plant samples.
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq !== this.execSeq) return;
    // Slot-harvested kicks already fed the identical samples from shared
    // memory (the sync path harvests after the fence; the workers' posts
    // queue unread and arrive later). Drop them — same values, and the
    // per-frame accumulation must see every band exactly once per kick.
    if (seq === this.execSlotHarvested) return;
    this.ingestExecSample(rec);
  }

  /**
   * Validate + store one worker sample from either transport (message post
   * or shared-memory harvest). Shared by `noteWorkerExec` and
   * `harvestSyncExec`; identical validation, newest-kick stash +
   * per-frame accumulation. Never throws.
   */
  private ingestExecSample(rec: {
    seq?: unknown; band?: unknown; frame?: unknown; job?: unknown;
    y0?: unknown; y1?: unknown; execMs?: unknown; pixels?: unknown;
    spans?: unknown; scanned?: unknown; tris?: unknown; descs?: unknown;
    kickBase?: unknown; kickDescs?: unknown;
  }): void {
    if (this.disposed || !this.timingEnabled) return;
    const seq = rec.seq;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq !== this.execSeq) return;
    const samples = this.execSamples;
    if (!samples) return;
    const band = rec.band;
    if (typeof band !== 'number' || !Number.isInteger(band) || band < 0 || band >= samples.length) return;
    const execMs = rec.execMs;
    if (typeof execMs !== 'number' || !Number.isFinite(execMs) || execMs < 0) return;
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    const frame = num(rec.frame);
    const jobRaw = rec.job;
    const job = typeof jobRaw === 'string' &&
      (jobRaw === 'raster' || jobRaw === 'resolve' || jobRaw === 'rgb' ||
        jobRaw === 'scanout' || jobRaw === 'unknown') ? jobRaw : null;
    const y0 = num(rec.y0);
    const y1 = num(rec.y1);
    if (
      frame === null || job === null || y0 === null || y1 === null ||
      !Number.isInteger(frame) ||
      !Number.isInteger(y0) || !Number.isInteger(y1)
    ) return;
    const count = (v: unknown): number => {
      const n = num(v);
      return n !== null && n >= 0 ? Math.floor(n) : 0;
    };
    const sample: BandExecSample = {
      seq, band, frame, job, y0, y1, execMs,
      pixels: count(rec.pixels), spans: count(rec.spans),
      scanned: count(rec.scanned), tris: count(rec.tris),
      descs: count(rec.descs),
      kickBase: count(rec.kickBase), kickDescs: count(rec.kickDescs),
    };
    samples[band] = sample;
    // Per-frame accumulation for attribution (every kick, not just the
    // newest): bounded, oldest-first; beginFrame resets. Dropped samples
    // (cap reached) keep the earliest kicks — the world/FG attribution
    // that drives PERF-NEXT-6, not the scanout tail.
    if (this.frameExecSamples.length < 256) this.frameExecSamples.push({ ...sample });
  }

  /**
   * Feed one SYNC kick's worker samples from shared memory (PERF-NEXT-4):
   * the sync path blocks the main thread in Atomics.wait, so completion
   * messages queue unread — but every executed band wrote its worker-local
   * duration into CTL_EXEC (+ counts into CTL_PIXELS/SPANS/TRIS/SCAN)
   * before the DONE fence, on the same worker-local clock as the message
   * path (never a cross-clock delta). Call immediately after a successful
   * sync fence with the kick's identity; skipped bands (slot still -1)
   * contribute nothing. Marks `execSlotHarvested` so the queued posts are
   * dropped on arrival (same values, exactly-once accumulation). Never
   * throws. No-op when timing is disabled.
   */
  private harvestSyncExec(seq: number, job: BandJobLabel, kickBase: number, kickDescs: number): void {
    if (this.disposed || !this.timingEnabled) return;
    if (seq !== this.execSeq) return;
    const frame = this.frameGen;
    let fed = false;
    for (let b = 0; b < this.workers.length; b++) {
      let us = -1;
      try {
        us = Atomics.load(this.ctl, CTL_EXEC + b);
      } catch {
        return;
      }
      if (!Number.isInteger(us) || us < 0) continue;
      const band = this.bands[b];
      if (!band) continue;
      this.ingestExecSample({
        seq, band: b, frame, job, y0: band.y0, y1: band.y1,
        execMs: us / 1000,
        pixels: this.ctl[CTL_PIXELS + b],
        spans: this.ctl[CTL_SPANS + b],
        scanned: this.ctl[CTL_SCAN + b],
        tris: this.ctl[CTL_TRIS + b],
        descs: 0, kickBase, kickDescs,
      });
      fed = true;
    }
    if (fed) this.execSlotHarvested = seq;
  }

  /**
   * Fence epoch for the shared planes (PERF-NEXT-2): increments whenever
   * quarantine isolates the planes onto a replacement SAB. The renderer
   * re-adopts the pool's current planes on recovery, so replay + inline
   * fallback target the live buffer, never the abandoned one. Monotonic
   * on the main thread; scripted/stub pools report 0 until they quarantine.
   */
  recoveryEpoch(): number {
    return typeof this.sabEpoch === 'number' ? this.sabEpoch : 0;
  }

  /**
   * Terminate every worker and refuse all later kicks fast (classes c/d:
   * call BEFORE replaying inline, so no straggler SAB write can race the
   * recovery or any later frame). Safe to call twice; never throws. The
   * pool stays usable only after recreation — beginFrame does NOT clear
   * this (a wedged pool must not silently resume mid-frame).
   *
   * PERF-NEXT-2 fence: `void worker.terminate()` alone is NOT a completion
   * fence — the main thread would replay over shared planes a live worker
   * may still be writing. So this first isolates the shared planes onto a
   * fresh SAB (staging/descriptors copied verbatim — workers only read
   * those — output planes cleared, control reset, epoch bumped), THEN
   * terminates. Termination of the abandoned buffer's writers is provable
   * via quarantineWorkersAsync; isolation makes the replay safe immediately,
   * including on the blocking sync path that cannot await termination.
   * One extra SAB is retained until the doomed workers exit (bounded: a
   * pool quarantines at most once).
   */
  quarantineWorkers(): void {
    if (this.quarantined && this.workers.length === 0) return;
    this.quarantined = true;
    // Cooperative shutdown signal for workers blocked in Atomics.wait:
    // they observe SEQ < 0 on wake and exit instead of draining a stale
    // kick. Workers mid-raster cannot observe it — isolation covers them.
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
    // Replacement-buffer fence BEFORE termination: from here on, every pool
    // view (planes, staging, control) addresses the fresh SAB. Late writes
    // from doomed workers land on the abandoned buffer only.
    this.isolateSharedPlanes();
    try {
      const terms: Array<Promise<unknown>> = [];
      for (const worker of doomed) {
        try {
          terms.push(worker.terminate());
        } catch {
          /* already gone / scripted worker without terminate */
        }
      }
      this.quarantineSettled = Promise.allSettled(terms).then(() => undefined);
    } catch {
      this.quarantineSettled = null;
    }
  }

  /**
   * Await completed termination of the quarantined workers (async-path
   * join): resolves once every doomed worker provably cannot write, or
   * after a bounded wait (isolation already fences the shared planes, so
   * the bound only limits cleanup latency, never safety). Never rejects;
   * safe to call twice or without a prior quarantine (runs it). The sync
   * path cannot await — it relies on the isolation fence alone.
   */
  async quarantineWorkersAsync(timeoutMs?: number): Promise<void> {
    this.quarantineWorkers();
    const settled = this.quarantineSettled;
    if (!settled) return;
    let bound = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : this.timeoutMs;
    if (!(bound > 0)) bound = 5000;
    if (bound > 30000) bound = 30000;
    try {
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          setTimeout(resolve, bound);
        }),
      ]);
    } catch {
      /* bounded join only; isolation already fenced the planes */
    }
  }

  /**
   * Replacement-buffer fence (main thread only, quarantine path): move the
   * pool onto a fresh SAB, copying the old buffer verbatim, then clearing
   * the output planes and resetting control in the fresh copy. Workers only
   * READ staging/descriptors (stable — the main thread never mutates them
   * mid-kick), so a torn copy of the plane bytes is harmless: recovery
   * clears + replays deterministically. Never throws; on any failure the
   * pool keeps the old buffer (termination still proceeds).
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
      // Discard the copied partial plane writes: recovery replays
      // deterministically from staging (clear + ordered replay).
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
      this.mainLastGen = this.frameGen;
      this.sabEpoch = (typeof this.sabEpoch === 'number' ? this.sabEpoch : 0) + 1;
    } catch {
      /* terminate-only fallback */
    }
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

  /** Publish a full-range RGB descriptor (inline recovery replays [0, descCount)). */
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

  /** Drop accumulated batches (beginFrame + post-kick reset). */
  private resetAccum(): void {
    this.spansUsed = 0;
    this.texUsed = 0;
    this.lightUsed = 0;
    this.descCount = 0;
    // NOTE: RGB staging is NOT reset here (PERF-2 RGB workers). Indexed
    // flushes (including mid-frame fallback flushes) must not wipe staged
    // RGB batches — the two accumulations drain with independent kicks at
    // frame end. RGB resets in beginFrame and the RGB flush paths only.
    try {
      Atomics.store(this.ctl, CTL_FCOUNT, 0);
      Atomics.store(this.ctl, CTL_JOB, JOB_RASTER);
    } catch {
      /* ignore */
    }
  }

  /** Drop staged RGB batches (beginFrame + commitRGB reset). */
  private resetRGB(): void {
    // PERF-5 persistent uploads: the chain region + directory/level tables
    // + identity map are a stable cross-frame cache (copy-on-first-use).
    // Only the per-frame bump regions reset here (spans/lux/tris/descs +
    // the applied watermark + the failure classification).
    this.rgbSpansUsed = 0;
    this.rgbLuxUsed = 0;
    this.rgbDescCount = 0;
    this.rgbFlushedCount = 0;
    this.rgbFailure = null;
    this.rgbTriUsed = 0;
    try {
      Atomics.store(this.ctl, CTL_RGBBASE, 0);
      Atomics.store(this.ctl, CTL_RGBCOUNT, 0);
    } catch {
      /* ignore */
    }
  }

  /**
   * Drop the persistent RGB chain upload cache (palette/world/renderer
   * change, eviction retry, worker restart). Next staged batch re-uploads.
   */
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

  /** Stage the palette for worker-side resolve (change-detected, 768B). */
  stagePalette(palette: Uint8Array): void {
    if (this.disposed) return;
    if (this.lastPalette !== palette) {
      this.views.fPal.set(palette.subarray(0, this.views.fPal.length));
      this.lastPalette = palette;
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

  /** Block for every worker's DONE (shared by dispatch + flushFrame). */
  private awaitDoneSync(): boolean {
    const deadline = Date.now() + this.timeoutMs;
    let done = Atomics.load(this.ctl, CTL_DONE);
    while (done < this.workers.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      try {
        Atomics.wait(this.ctl, CTL_DONE, done, Math.min(remaining, 1000));
      } catch {
        return false; // wait unavailable after all -> inline
      }
      done = Atomics.load(this.ctl, CTL_DONE);
    }
    return true;
  }

  /** Await every worker's completion message for one kick (async path). */
  private awaitWorkerMessages(seq: number, need: number): Promise<boolean> {
    let seen = 0;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        resolve(false);
      }, this.timeoutMs);
      this.pending.set(seq, () => {
        seen += 1;
        if (seen >= need) {
          this.pending.delete(seq);
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
  }

  /** Lazily clear the calling thread's band once per frame generation. */
  private clearMainBand(mainBand: Band, fbW: number): void {
    if (this.mainLastGen !== this.frameGen) {
      this.base.idx.fill(0, mainBand.y0 * fbW, mainBand.y1 * fbW);
      this.base.zb.fill(0, mainBand.y0 * fbW, mainBand.y1 * fbW);
      this.mainLastGen = this.frameGen;
    }
  }

  private publish(
    tex: Texture, light: LightBlock,
    colormap: Uint8Array, time: number, fbW: number, fbH: number, count: number,
  ): void {
    this.stage(tex, light, colormap);
    const masks = textureMasks(tex);
    const phase = ((time * 64) | 0) & (this.base.turb.length - 1);
    writeBandJob(
      this.ctl, count, fbW, fbH,
      tex.width | 0, tex.height | 0, light.width | 0, light.height | 0,
      masks.wshift, masks.wmask, masks.hmask, phase,
    );
    try {
      Atomics.store(this.ctl, CTL_JOB, JOB_RASTER);
    } catch {
      /* ignore */
    }
    this.seq += 1;
  }

  private kick(seq: number): boolean {
    // Newest-kick exec stash (PERF-NEXT-4): replaced per kick, bounded by
    // the worker count; null when timing is disabled (nothing will post a
    // measurement). Resolve/scanout kicks reset it too — `lastWorkerExec`
    // always describes the most recent kick of any job kind.
    this.execSeq = seq;
    this.execSamples = this.timingEnabled ? new Array<BandExecSample | null>(this.workers.length).fill(null) : null;
    this.execSlotHarvested = -1;
    if (this.timingEnabled) {
      // Freshness fence for the shared exec slots: -1 = band did not run
      // this kick. Without the clear, a worker that never runs (or a
      // wedged kick's leftover) would read back the previous kick's
      // duration. Cleared pre-notify, so every non-negative slot the
      // harvester reads was written by THIS kick.
      try {
        for (let b = 0; b < this.workers.length; b++) Atomics.store(this.ctl, CTL_EXEC + b, -1);
      } catch {
        /* ignore */
      }
    }
    // Wakeup is Atomics-only: workers block in Atomics.wait and never
    // unwind their stack inside bandWorkerLoop, so posted messages would
    // queue unread until shutdown. (Completion posts flow worker -> main,
    // where the stack unwinds between dispatches.)
    try {
      Atomics.store(this.ctl, CTL_DONE, 0);
      Atomics.store(this.ctl, CTL_SEQ, seq);
    } catch {
      return false;
    }
    try {
      Atomics.notify(this.ctl, CTL_SEQ, this.workers.length);
    } catch {
      /* workers may already be awake */
    }
    return true;
  }

  private tally(): { pixels: number; spans: number; scanned: number; tris: number; mainExecMs?: number } {
    let pixels = 0;
    let spans = 0;
    let scanned = 0;
    let tris = 0;
    for (let i = 0; i < this.workers.length; i++) {
      pixels += this.ctl[CTL_PIXELS + i]!;
      spans += this.ctl[CTL_SPANS + i]!;
      scanned += this.ctl[CTL_SCAN + i]!;
      tris += this.ctl[CTL_TRIS + i]!;
    }
    return { pixels, spans, scanned, tris };
  }

  private stage(tex: Texture, light: LightBlock, colormap: Uint8Array): void {
    if (this.lastTexels !== tex.texels) {
      this.base.texels.set(tex.texels.subarray(0, Math.min(tex.texels.length, this.base.texels.length)));
      this.lastTexels = tex.texels;
    }
    if (this.lastLight !== light.values) {
      this.base.light.set(light.values.subarray(0, Math.min(light.values.length, this.base.light.length)));
      this.lastLight = light.values;
    }
    if (this.lastColormap !== colormap) {
      this.base.colormap.set(colormap.subarray(0, this.base.colormap.length));
      this.lastColormap = colormap;
    }
  }
}

/**
 * Eval-bootstrapped worker body. Runs inside the worker thread (ESM eval):
 * dynamic-imports the built ESM bundle (single source of truth) and enters
 * the shared bandWorkerLoop. Kept tiny on purpose — all logic lives in
 * bands.ts.
 */
function poolBootstrapSource(): string {
  return [
    'const { parentPort, workerData } = await import("node:worker_threads");',
    'const m = await import(workerData.indexJsUrl);',
    'const shared = m.attachFrameAccum(workerData.sab, workerData.w, workerData.h);',
    'const rgb = m.attachRGBAccum(workerData.sab, workerData.w, workerData.h);',
    'm.bandWorkerLoop(shared.views, rgb.views, shared.ctl,',
    '  workerData.y0, workerData.y1, workerData.band, workerData.w,',
    '  function (s) { Atomics.wait(shared.ctl, m.CTL_SEQ, s); },',
    '  parentPort,',
    '  { timing: workerData.timing !== false });',
  ].join('\n');
}
