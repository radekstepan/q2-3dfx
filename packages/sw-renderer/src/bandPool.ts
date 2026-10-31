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
  CTL_PIXELS, CTL_READY, CTL_SCAN, CTL_SEQ, CTL_SPANS, CTL_TEXH, CTL_TEXW, CTL_TURBPHASE,
  CTL_WMASK, CTL_WSHIFT, D_HMASK, D_LIGHT_H, D_LIGHT_OFF, D_LIGHT_W,
  D_PER_BATCH, D_SPAN_BASE, D_SPAN_COUNT, D_TEX_H, D_TEX_OFF, D_TEX_W,
  D_TURBPHASE, D_WMASK, D_WSHIFT, D_YMAX, D_YMIN, D_ORDERED, FRAME_LIGHT_CAP, FRAME_TEX_CAP,
  JOB_RASTER, JOB_RESOLVE,
  LIGHT_CAP, MAX_FRAME_BATCHES, MAX_FRAME_SPANS, MAX_WORKERS, MIN_BAND_PIXELS, TEX_CAP,
  attachFrameAccum, frameAccumTotal, packBandSpans, packFrameSpans,
  processBandJob, processFrameJob, readBandJob, resolveBand,
  sabAvailable, splitBands, syncWaitAllowed, writeBandJob, I_PER_SPAN,
  type Band,
  type BandDispatcher, type BandExecSample, type BandJobLabel, type BandViews, type FrameAccumViews,
} from './bands.js';
import { textureMasks, type LightBlock, type SpanList, type Texture } from './spans.js';

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
  private views: FrameAccumViews;
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
   * kicks (world frame flushes, resolve) and later publishes invalidate
   * the newest-kick gate even
   * when no newer kick ran. Bounded (`FRAME_EXEC_CAP`); oldest-first
   * order. Empty (not null) when timing is disabled or nothing posted.
   */
  private frameExecSamples: BandExecSample[] = [];

  private constructor(
    bandCount: number, views: FrameAccumViews, ctl: Int32Array,
    bands: Band[],
    workers: WorkerLike[], timeoutMs: number, fbW: number, fbH: number,
    timingEnabled: boolean,
  ) {
    this.bandCount = bandCount;
    this.views = views;
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
      const sab = new SharedArrayBuffer(frameAccumTotal(w, h));
      const { views, ctl } = attachFrameAccum(sab, w, h);
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
      return new BandWorkerPool(workers + 1, views, ctl, bands, spawned, opts.timeoutMs ?? 30000, w, h, timingEnabled);
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
   *
   * NOTE (indexed-timeout gap): this indexed timeout does NOT isolate,
   * does NOT isolate, and leaves the workers attached — a worker still
   * mid-raster may keep writing the shared planes while the caller replays
   * inline. Safe today only because every indexed write is depth-guarded
   * (replay converges once stragglers finish). Do not weaken the pin
   * (null, workers retained) silently.
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
   * Resolve kick (M8.1 parallel resolve): palette-expand the final index
   * plane into the shared color plane across the pool. True unless the
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
    resolveBand(this.views.fColor, this.views.fPal, this.base.idx, mainBand.y0, mainBand.y1, this.fbW, this.fbH);
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
    resolveBand(this.views.fColor, this.views.fPal, this.base.idx, mainBand.y0, mainBand.y1, this.fbW, this.fbH);
    return finished;
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
   * `beginFrame` across EVERY kick (world frame flushes, resolve),
   * oldest-first, bounded (256). Wire labels map to the shared job names
   * ('raster'→'indexed-frame', 'resolve'→'indexed-resolve'); 'unknown'
   * kicks are dropped (raw samples stay on `lastWorkerExec`). Structural
   * shape only — no testkit import (dependency direction forbids it);
   * consumers validate field-by-field. Null when timing is disabled or
   * nothing posted yet this frame. Never throws.
   */
  testBandExecStats(): Array<{
    frame: number; seq: number;
    job: 'indexed-resolve' | 'indexed-frame';
    worker: number; band: number; y0: number; y1: number;
    execMs: number; pixels: number; spans: number; tris: number;
  }> | null {
    if (!this.timingEnabled || this.frameExecSamples.length === 0) return null;
    const out: Array<{
      frame: number; seq: number;
      job: 'indexed-resolve' | 'indexed-frame';
      worker: number; band: number; y0: number; y1: number;
      execMs: number; pixels: number; spans: number; tris: number;
    }> = [];
    for (const s of this.frameExecSamples) {
      const job = s.job === 'raster' ? 'indexed-frame'
        : s.job === 'resolve' ? 'indexed-resolve' : null;
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
      (jobRaw === 'raster' || jobRaw === 'resolve' ||
        jobRaw === 'unknown') ? jobRaw : null;
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
    // that drives PERF-NEXT-6.
    if (this.frameExecSamples.length < 256) this.frameExecSamples.push({ ...sample });
  }

  /**
   * Feed one SYNC kick's worker samples from shared memory (PERF-NEXT-4):
   * the sync path blocks the main thread in Atomics.wait, so completion
   * messages queue unread — but every executed band wrote its worker-local
   * duration into CTL_EXEC (+ counts into CTL_PIXELS/SPANS/SCAN)
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
        tris: 0,
        descs: 0, kickBase, kickDescs,
      });
      fed = true;
    }
    if (fed) this.execSlotHarvested = seq;
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
    // measurement). Resolve kicks reset it too — `lastWorkerExec`
    // always describes the most recent kick.
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
    }
    return { pixels, spans, scanned, tris: 0 };
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
    'm.bandWorkerLoop(shared.views, shared.ctl,',
    '  workerData.y0, workerData.y1, workerData.band, workerData.w,',
    '  function (s) { Atomics.wait(shared.ctl, m.CTL_SEQ, s); },',
    '  parentPort,',
    '  { timing: workerData.timing !== false });',
  ].join('\n');
}
