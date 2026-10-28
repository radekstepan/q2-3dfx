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
  CTL_FBW,  CTL_FCOUNT,
  CTL_FRAME,
  CTL_JOB,
  CTL_PIXELS,
  CTL_READY,
  CTL_RGBCOUNT,
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
  JOB_RGB,
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
  R_FLATRGB,
  R_LUX_H,
  R_LUX_OFF,
  R_LUX_W,
  R_PER_BATCH,
  R_SPAN_BASE,
  R_SPAN_COUNT,
  R_TURBPHASE,
  R_ZBITS,
  attachFrameAccum,
  attachRGBAccum,
  frameAccumTotal,
  rgbAccumTotal,
  packFrameSpans,
  processFrameJob,
  processRGBFrameJob,
  resolveBand,
  sabAvailable,
  splitBands,
  textureMasks,
  type Band,
  type BandDispatcher,
  type BandViews,
  type FrameAccumViews,
  type RGBAccumViews,
  type LightBlock,
  type SpanList,
  type Texture,
  type RGBMipLevel,
} from '@q2/sw-renderer';
import { readVoodooState } from '@q2/voodoo';
import type { VoodooState } from '@q2/voodoo';

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
  private readonly rgbViews: RGBAccumViews;
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
  /** RGB staging bump offsets (reset by beginFrame/flushRGB). */
  private rgbSpansUsed = 0;
  private rgbChainUsed = 0;
  private rgbChainLevels = 0;
  private rgbChainSlots = 0;
  private rgbLuxUsed = 0;
  private rgbDescCount = 0;
  private rgbChainMap = new Map<RGBMipLevel[], number>();

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

  /** Live shared RGB planes (the renderer adopts these when banded + attached). */
  get rgbPlanes(): { rgb565: Uint16Array; cover: Uint8Array; rgbDepth: Uint16Array } {
    return {
      rgb565: this.rgbViews.rgb565,
      cover: this.rgbViews.cover,
      rgbDepth: this.rgbViews.rgbDepth,
    };
  }

  /**
   * Stage one world RGB batch into the SAB (main side). Same contract as
   * the Node pool's stageRGB (spans + deduped chain + luxels + flags);
   * false = run inline. Never throws.
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
    let slot = this.rgbChainMap.get(levels);
    if (slot === undefined) {
      if (this.rgbChainSlots >= RGB_MAX_CHAINS) return false;
      let bytes = 0;
      for (let l = 0; l < levels.length; l++) {
        const lv = levels[l]!;
        if (!(lv.width >= 1 && lv.height >= 1)) return false;
        if (lv.data.length < lv.width * lv.height * 3) return false;
        if (lv.mask.length < lv.width * lv.height) return false;
        bytes += lv.data.length + lv.mask.length;
      }
      if (bytes > RGB_CHAIN_CAP - this.rgbChainUsed) return false;
      if (levels.length > RGB_MAX_LEVELS - this.rgbChainLevels) return false;
      slot = this.rgbChainSlots;
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
      const d = slot * C_PER_CHAIN;
      this.rgbViews.chainDir[d + C_LEVEL_BASE] = levelBase;
      this.rgbViews.chainDir[d + C_LEVEL_COUNT] = levels.length;
      this.rgbChainLevels += levels.length;
      this.rgbChainSlots += 1;
      this.rgbChainMap.set(levels, slot);
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
    this.rgbSpansUsed += spanCount;
    this.rgbDescCount += 1;
    return true;
  }

  /** Pending staged RGB batches (observability for the renderer/tests). */
  rgbPending(): number {
    return this.rgbDescCount;
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
   * inline via drawInlineRGBAll, converging to identical planes.
   */
  async flushRGBFrameAsync(near: number, far: number, lodBias: number): Promise<{ pixels: number; spans: number } | null> {
    if (this.disposed || this.workers.length === 0) return null;
    if (this.rgbDescCount === 0) return { pixels: 0, spans: 0 };
    if (!(await this.awaitReadyAsync())) return null;
    this.publishRGB(near, far, lodBias);
    const seq = this.seq;
    const finished = this.awaitWorkerMessages(seq, this.workers.length);
    if (!this.kick(seq)) {
      this.pending.delete(seq);
      return null;
    }
    // Calling thread owns the last band: drain it inline while the workers
    // drain theirs, then await the workers. Same math, golden-identical.
    const mainBand = this.bands[this.bands.length - 1]!;
    const main = processRGBFrameJob(
      this.rgbViews, this.fbW, this.fbH, this.rgbDescCount, mainBand.y0, mainBand.y1,
    );
    const ok = await finished;
    if (!ok) return null;
    const tally = this.tally();
    tally.pixels += main.pixels;
    tally.spans += main.spans;
    this.resetRGB();
    return tally;
  }

  /**
   * Full-frame inline replay of the staged RGB batches on the calling
   * thread (sync fallback). The planes were cleared in beginFrame; the
   * replay converges to the identical planes.
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

  /** Shut workers down; safe to call twice. */
  async dispose(): Promise<void> {    if (this.disposed) return;
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

  /** Drop staged RGB batches (beginFrame + post-kick reset). */
  private resetRGB(): void {
    this.rgbSpansUsed = 0;
    this.rgbChainUsed = 0;
    this.rgbChainLevels = 0;
    this.rgbChainSlots = 0;
    this.rgbLuxUsed = 0;
    this.rgbDescCount = 0;
    this.rgbChainMap.clear();
    try {
      Atomics.store(this.ctl, CTL_RGBCOUNT, 0);
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
 * Explicit voodoo path selection (V2d). Always `serial` until a
 * worker/WASM voodoo backend exists — even when a raster pool is active,
 * the pool drains first and scanout runs globally after. Callers record the
 * result (PlayBoot.lastVoodooPath) instead of branching on backend
 * folklore. Pure/headless-safe.
 */
export function selectVoodooBandPath(_poolActive: boolean): VoodooBandPath {
  // No worker/WASM voodoo backend at this HEAD: serial main-thread
  // `resolveFrame` after all bands complete. Revisit when the backend lands.
  return 'serial';
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
