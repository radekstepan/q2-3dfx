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
  CTL_DONE,
  CTL_FBH,
  CTL_FBW,
  CTL_FCOUNT,
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
  D_SPAN_BASE,
  D_SPAN_COUNT,
  D_TEX_H,
  D_TEX_OFF,
  D_TEX_W,
  D_TURBPHASE,
  D_WMASK,
  D_WSHIFT,
  FRAME_LIGHT_CAP,
  FRAME_TEX_CAP,
  JOB_RASTER,
  JOB_RESOLVE,
  MAX_FRAME_BATCHES,
  MAX_FRAME_SPANS,
  MAX_WORKERS,
  attachFrameAccum,
  frameAccumTotal,
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

/** Per-batch wait budget in ms (mirrors the Node pool default). */
export const BROWSER_POOL_TIMEOUT_MS = 30000;

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
  private readonly views: FrameAccumViews;
  private readonly base: BandViews;
  private readonly ctl: Int32Array;
  private readonly bands: Band[];
  private readonly timeoutMs: number;
  private readonly fbW: number;
  private readonly fbH: number;
  private seq = 0;
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
    for (const w of workers) {
      this.workers.push(w);
      w.onmessage = (ev: MessageEvent): void => {
        const msg = ev.data as { seq?: unknown; ready?: unknown };
        if (!msg || typeof msg !== 'object') return;
        if (msg.ready === true) this.readyCount += 1;
        if (typeof msg.seq === 'number') {
          const done = this.pending.get(msg.seq);
          if (done) done();
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

  /** Bump the frame generation; bands clear lazily on the next batch. */
  beginFrame(): void {
    if (this.disposed) return;
    this.frameGen += 1;
    this.resetAccum();
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
   * inline via drawInlineAll, converging to identical planes.
   */
  async flushFrameAsync(): Promise<{ pixels: number; spans: number } | null> {
    if (this.disposed || this.workers.length === 0) return null;
    if (this.descCount === 0) return { pixels: 0, spans: 0 };
    if (!(await this.awaitReadyAsync())) return null;
    this.publishFrame();
    const seq = this.seq;
    const finished = this.awaitWorkerMessages(seq, this.workers.length);
    if (!this.kick(seq)) {
      this.pending.delete(seq);
      return null;
    }
    // Calling thread owns the last band: drain it inline while the workers
    // drain theirs, then await the workers. Same math, golden-identical.
    const mainBand = this.bands[this.bands.length - 1]!;
    this.clearMainBand(mainBand, this.fbW);
    const main = processFrameJob(
      this.views, this.fbW, this.fbH, this.descCount, mainBand.y0, mainBand.y1,
    );
    const ok = await finished;
    if (!ok) return null;
    const tally = this.tally();
    tally.pixels += main.pixels;
    tally.spans += main.spans;
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
    if (!(await this.awaitReadyAsync())) return false;
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

  /** Await every worker's completion message for one kick (async path). */
  private awaitWorkerMessages(seq: number, need: number): Promise<boolean> {
    let seen = 0;
    return new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(seq);
        resolve(false);
      }, this.timeoutMs);
      this.pending.set(seq, () => {
        seen += 1;
        if (seen >= need) {
          this.pending.delete(seq);
          window.clearTimeout(timer);
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
  private kick(seq: number): boolean {
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
    // CTL_PIXELS + i / CTL_SPANS + i per-worker tallies (see bands.ts layout).
    let pixels = 0;
    let spans = 0;
    for (let i = 0; i < this.workers.length; i++) {
      pixels += this.ctl[CTL_PIXELS + i]!;
      spans += this.ctl[CTL_SPANS + i]!;
    }
    return { pixels, spans };
  }
}
