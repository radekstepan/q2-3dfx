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
  CTL_COUNT, CTL_DONE, CTL_FBH, CTL_FBW, CTL_FCOUNT, CTL_FRAME, CTL_HMASK, CTL_JOB, CTL_LIGHTH, CTL_LIGHTW,
  CTL_PIXELS, CTL_READY, CTL_RGBCOUNT, CTL_SEQ, CTL_SPANS, CTL_TEXH, CTL_TEXW, CTL_TURBPHASE,
  CTL_WMASK, CTL_WSHIFT, D_HMASK, D_LIGHT_H, D_LIGHT_OFF, D_LIGHT_W,
  D_PER_BATCH, D_SPAN_BASE, D_SPAN_COUNT, D_TEX_H, D_TEX_OFF, D_TEX_W,
  D_TURBPHASE, D_WMASK, D_WSHIFT, FRAME_LIGHT_CAP, FRAME_TEX_CAP,
  JOB_RASTER, JOB_RESOLVE, JOB_RGB,
  LIGHT_CAP, MAX_FRAME_BATCHES, MAX_FRAME_SPANS, MAX_WORKERS, MIN_BAND_PIXELS, TEX_CAP,
  MAX_RGB_BATCHES, MAX_RGB_SPANS, RGB_CHAIN_CAP, RGB_LUX_CAP, RGB_MAX_CHAINS, RGB_MAX_LEVELS,
  C_LEVEL_BASE, C_LEVEL_COUNT, C_PER_CHAIN, L_DATA_OFF, L_H, L_MASK_OFF, L_PER_LEVEL, L_W,
  R_CHAIN, R_FLAGS, R_FLATRGB, R_LUX_H, R_LUX_OFF, R_LUX_W, R_PER_BATCH,
  R_SPAN_BASE, R_SPAN_COUNT, R_TURBPHASE, R_YMAX, R_YMIN, R_ZBITS,
  attachFrameAccum, attachRGBAccum, frameAccumTotal, rgbAccumTotal, packBandSpans, packFrameSpans,
  processBandJob, processFrameJob, processRGBFrameJob, readBandJob, resolveBand, resolveBandFused,
  sabAvailable, splitBands, syncWaitAllowed, writeBandJob, I_PER_SPAN,
  type Band,
  type BandDispatcher, type BandViews, type FrameAccumViews, type RGBAccumViews,
} from './bands.js';
import { textureMasks, type LightBlock, type SpanList, type Texture, type RGBMipLevel } from './spans.js';

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
}

/**
 * Fixed worker pool: worker i owns band i. Created synchronously; returns
 * null (silent fallback) when threads, SAB, or blocking waits are missing.
 */
export class BandWorkerPool implements BandDispatcher {
  readonly bandCount: number;
  private readonly workers: WorkerLike[] = [];
  private readonly views: FrameAccumViews;
  private readonly rgbViews: RGBAccumViews;
  private readonly base: BandViews;
  private readonly ctl: Int32Array;
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
  /** RGB staging bump offsets (reset by beginFrame/flushRGB): packed spans,
   *  chain bytes, luxel bytes, descriptor count, per-frame chain slots. */
  private rgbSpansUsed = 0;
  private rgbChainUsed = 0;
  private rgbChainLevels = 0;
  private rgbChainSlots = 0;
  private rgbLuxUsed = 0;
  private rgbDescCount = 0;
  private rgbChainMap = new Map<RGBMipLevel[], number>();

  private constructor(
    bandCount: number, views: FrameAccumViews, rgbViews: RGBAccumViews, ctl: Int32Array,
    bands: Band[],
    workers: WorkerLike[], timeoutMs: number, fbW: number, fbH: number,
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
    for (const w of workers) {
      this.workers.push(w);
      try {
        w.on('message', (msg: unknown) => {
          if (msg && typeof msg === 'object') {
            const rec = msg as { seq?: unknown; ready?: unknown };
            if (rec.ready === true) this.readyCount += 1;
            if (typeof rec.seq === 'number') {
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
      return new BandWorkerPool(workers + 1, views, rgbViews, ctl, bands, spawned, opts.timeoutMs ?? 30000, w, h);
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
  ): { pixels: number; spans: number } | null {
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
    const main = processBandJob(this.base, readBandJob(this.ctl, mainBand.y0, mainBand.y1));
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
  ): Promise<{ pixels: number; spans: number } | null> {
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
    const main = processBandJob(this.base, readBandJob(this.ctl, mainBand.y0, mainBand.y1));
    const ok = await finished;
    if (!ok) {
      Com_Warn(`bandPool: async batch timeout after ${this.timeoutMs}ms, redrawing inline`);
      return null;
    }
    const tally = this.tally();
    tally.pixels += main.pixels;
    tally.spans += main.spans;
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
  flushFrame(): { pixels: number; spans: number } | null {
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
    const main = processFrameJob(
      this.views, this.fbW, this.fbH, this.descCount, mainBand.y0, mainBand.y1,
    );
    const ok = this.awaitDoneSync();
    if (!ok) {
      Com_Warn(`bandPool: frame timeout after ${this.timeoutMs}ms, redrawing inline`);
      return null;
    }
    const tally = this.tally();
    tally.pixels += main.pixels;
    tally.spans += main.spans;
    this.resetAccum();
    return tally;
  }

  /**
   * Same as flushFrame but awaits worker completion messages instead of
   * blocking (for threads that forbid Atomics.wait — the browser
   * async-render completion path). Resolves null on timeout or dead pool.
   */
  async flushFrameAsync(): Promise<{ pixels: number; spans: number } | null> {
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
    const main = processFrameJob(
      this.views, this.fbW, this.fbH, this.descCount, mainBand.y0, mainBand.y1,
    );
    const ok = await finished;
    if (!ok) {
      Com_Warn(`bandPool: async frame timeout after ${this.timeoutMs}ms, redrawing inline`);
      return null;
    }
    const tally = this.tally();
    tally.pixels += main.pixels;
    tally.spans += main.spans;
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
    return this.awaitDoneSync();
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
        // Working set changed (new texture/palette/world): drop the whole
        // persistent upload cache once and retry. Stale chain identity refs
        // are also dropped on palette/world changes via clearRGBChains, so
        // this path only triggers on genuine growth.
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
    // are few, total cost is one integer pass over the frame's spans.
    let ymin = 0, ymax = 0;
    if (spanCount > 0) {
      ymin = 0x7fffffff;
      ymax = -0x80000000;
      for (let s = 0; s < spanCount; s++) {
        const y = this.rgbViews.spansI[(this.rgbSpansUsed + s) * I_PER_SPAN + 1]!;
        if (y < ymin) ymin = y;
        if (y + 1 > ymax) ymax = y + 1;
      }
      if (!(ymax > ymin)) { ymin = 0; ymax = 0; }
    }
    this.rgbViews.rgbDesc[d + R_YMIN] = ymin;
    this.rgbViews.rgbDesc[d + R_YMAX] = ymax;
    this.rgbSpansUsed += spanCount;
    this.rgbDescCount += 1;
    return true;
  }

  /** Pending staged RGB batches (observability for the renderer/tests). */
  rgbPending(): number {
    return this.rgbDescCount;
  }

  /**
   * Kick ONE RGB frame covering every staged batch and block for the
   * workers. Resolves null when the pool is dead or the wait times out —
   * the caller replays inline via drawInlineRGBAll (identical planes: every
   * write is depth-guarded and the planes were cleared in beginFrame).
   */
  flushRGBFrame(near: number, far: number, lodBias: number): { pixels: number; spans: number } | null {
    if (this.disposed || this.workers.length === 0) return null;
    if (this.rgbDescCount === 0) return { pixels: 0, spans: 0 };
    if (!this.awaitReadySync()) {
      Com_Warn('bandPool: workers never became ready, replaying RGB inline');
      return null;
    }
    this.publishRGB(near, far, lodBias);
    const seq = this.seq;
    if (!this.kick(seq)) return null;
    // The calling thread owns the last band: drain it inline while the
    // workers drain theirs, then collect. Same math, golden-identical.
    const mainBand = this.bands[this.bands.length - 1]!;
    const main = processRGBFrameJob(
      this.rgbViews, this.fbW, this.fbH, this.rgbDescCount, mainBand.y0, mainBand.y1,
    );
    const ok = this.awaitDoneSync();
    if (!ok) {
      Com_Warn(`bandPool: RGB frame timeout after ${this.timeoutMs}ms, replaying inline`);
      return null;
    }
    const tally = this.tally();
    tally.pixels += main.pixels;
    tally.spans += main.spans;
    this.resetRGB();
    return tally;
  }

  /**
   * Same as flushRGBFrame but awaits worker completion messages instead of
   * blocking (for threads that forbid Atomics.wait).
   */
  async flushRGBFrameAsync(near: number, far: number, lodBias: number): Promise<{ pixels: number; spans: number } | null> {
    if (this.disposed || this.workers.length === 0) return null;
    if (this.rgbDescCount === 0) return { pixels: 0, spans: 0 };
    if (!(await this.awaitReadyAsync())) {
      Com_Warn('bandPool: workers never became ready, replaying RGB inline');
      return null;
    }
    this.publishRGB(near, far, lodBias);
    const seq = this.seq;
    const finished = this.awaitWorkerMessages(seq, this.workers.length);
    if (!this.kick(seq)) {
      this.pending.delete(seq);
      return null;
    }
    const mainBand = this.bands[this.bands.length - 1]!;
    const main = processRGBFrameJob(
      this.rgbViews, this.fbW, this.fbH, this.rgbDescCount, mainBand.y0, mainBand.y1,
    );
    const ok = await finished;
    if (!ok) {
      Com_Warn(`bandPool: async RGB frame timeout after ${this.timeoutMs}ms, replaying inline`);
      return null;
    }
    const tally = this.tally();
    tally.pixels += main.pixels;
    tally.spans += main.spans;
    this.resetRGB();
    return tally;
  }

  /**
   * Full-frame inline replay of the staged RGB batches on the calling
   * thread (timeout fallback). The planes were cleared in beginFrame and a
   * timed-out kick may have left bands partially drawn, so a full replay
   * from the staged data converges back to the identical planes.
   */
  drawInlineRGBAll(near: number, far: number, lodBias: number): { pixels: number; spans: number } {
    this.rgbViews.cover.fill(0);
    this.rgbViews.rgbDepth.fill(0xffff);
    this.publishRGB(near, far, lodBias);
    const r = processRGBFrameJob(
      this.rgbViews, this.fbW, this.fbH, this.rgbDescCount, 0, this.fbH,
    );
    this.resetRGB();
    return r;
  }

  /** Publish an RGB-kick descriptor (main side, pre-notify). */
  private publishRGB(near: number, far: number, lodBias: number): void {
    try {
      Atomics.store(this.ctl, CTL_FBW, this.fbW);
      Atomics.store(this.ctl, CTL_FBH, this.fbH);
      Atomics.store(this.ctl, CTL_JOB, JOB_RGB);
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

  /** Drop staged RGB batches (beginFrame + post-kick reset). */
  private resetRGB(): void {
    // PERF-5 persistent uploads: the chain region + directory/level tables
    // + identity map are a stable cross-frame cache (copy-on-first-use).
    // Only the per-frame bump regions reset here (spans/lux/descriptors).
    this.rgbSpansUsed = 0;
    this.rgbLuxUsed = 0;
    this.rgbDescCount = 0;
    try {
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

  private tally(): { pixels: number; spans: number } {
    let pixels = 0;
    let spans = 0;
    for (let i = 0; i < this.workers.length; i++) {
      pixels += this.ctl[CTL_PIXELS + i]!;
      spans += this.ctl[CTL_SPANS + i]!;
    }
    return { pixels, spans };
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
    '  parentPort);',
  ].join('\n');
}
