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
  R_FLATRGB,
  R_LUX_H,
  R_LUX_OFF,
  R_LUX_W,
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
} from '@q2/sw-renderer';
export type { ScanoutBandOptions } from '@q2/sw-renderer';
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
  private readonly pending = new Map<number, (ok: boolean) => void>();
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
  private diagKickStart = 0;
  private diagMainMs = -1;
  private diagArrivalsSeen = 0;
  private diagKicks = 0;
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
    this.diagArrivals = new Float64Array(Math.max(1, workers.length));
    for (let i = 0; i < workers.length; i++) {
      this.workers.push(workers[i]!);
      const w = workers[i]!;
      w.onmessage = (ev: MessageEvent): void => {
        const msg = ev.data as { seq?: unknown; ready?: unknown };
        if (!msg || typeof msg !== 'object') return;
        if (msg.ready === true) this.readyCount += 1;
        if (typeof msg.seq === 'number') {
          if (this.diagOn && this.diagArrivalsSeen < this.diagArrivals.length) {
            this.diagArrivals[this.diagArrivalsSeen++] = performance.now() - this.diagKickStart;
          }
          const done = this.pending.get(msg.seq);
          if (done) done(true);
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
    // Worker-owned band-cull range (mirrors Node BandPool.packBatched):
    // one integer pass over this batch's staged spans at staging time.
    // The emitter writes strictly increasing y, so this is a pure bound
    // read; workers reject non-overlapping descriptors BEFORE material/view
    // setup with no rescan. Zero range = unknown/legacy (correct fallback:
    // visit everywhere), never staged here since spanCount > 0 always
    // reaches this point.
    let ymin = 0x7fffffff;
    let ymax = -0x80000000;
    for (let s = 0; s < spanCount; s++) {
      const y = fv.fSpansI[(spanBase + s) * I_PER_SPAN + 1]!;
      if (y < ymin) ymin = y;
      if (y + 1 > ymax) ymax = y + 1;
    }
    if (!(ymax > ymin)) { ymin = 0; ymax = 0; }
    fv.desc[dd + D_YMIN] = ymin;
    fv.desc[dd + D_YMAX] = ymax;
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
    this.snapKick();
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
    const diagT0 = this.diagOn ? performance.now() : 0;
    const main = processFrameJob(
      this.views, this.fbW, this.fbH, this.descCount, mainBand.y0, mainBand.y1,
    );
    if (this.diagOn) this.diagMainMs = performance.now() - diagT0;
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

  /** Resolve kick (parallel palette expand + fused RGB composite): message-driven completion. */
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
    const diagT0 = this.diagOn ? performance.now() : 0;
    resolveBandFused(this.views.fColor, this.views.fPal, this.base.idx, this.rgbViews.rgb565, this.rgbViews.cover, mainBand.y0, mainBand.y1, this.fbW, this.fbH);
    if (this.diagOn) this.diagMainMs = performance.now() - diagT0;
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
    if (!this.kick(seq)) {
      this.pending.delete(seq);
      return false;
    }
    const mainBand = this.bands[this.bands.length - 1]!;
    const diagT0 = this.diagOn ? performance.now() : 0;
    processScanoutBand(
      this.views.fColor, this.rgbViews.scan565, this.rgbViews.scanDisplay,
      this.fbW, this.fbH, opts, mainBand.y0, mainBand.y1,
    );
    if (this.diagOn) this.diagMainMs = performance.now() - diagT0;
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
   * Stage one world RGB batch into the SAB (main side). Same contract as
   * the Node pool's stageRGB (spans + persistent chain cache + luxels +
   * flags + y-range); false = run inline. Never throws.
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

  /* --- PERF-FINISH-B kick diagnostics (instrumented-only) ----------------
   *
   * `enableDiag` arms per-kick timing; `disableDiag` (default state)
   * leaves the production path untouched — a single boolean check per
   * kick/message, zero steady-state allocation. The harness (CDP stage
   * capture, Node report-only benches) enables it around measured frames
   * only; acceptance FPS is always measured with it off.
   *
   * Worker messages carry no band index (renderer protocol), so arrivals
   * are rank-ordered: arrivals[0] = first worker done, arrivals[last] =
   * slowest-band wait for the kick.
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
   * Allocates (diag path only, never the production frame).
   */
  diagSnapshot(): {
    kicks: number;
    mainMs: number;
    arrivals: number[];
    slowestMs: number;
  } | null {
    if (!this.diagOn || this.diagKicks === 0) return null;
    const arrivals: number[] = [];
    for (let i = 0; i < this.diagArrivalsSeen; i++) arrivals.push(this.diagArrivals[i]!);
    return {
      kicks: this.diagKicks,
      mainMs: this.diagMainMs,
      arrivals,
      slowestMs: arrivals.length > 0 ? arrivals[arrivals.length - 1]! : -1,
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
   * inline via drawInlineRGBAll, converging to identical planes.
   */
  async flushRGBFrameAsync(near: number, far: number, lodBias: number): Promise<{ pixels: number; spans: number } | null> {
    if (this.disposed || this.workers.length === 0) return null;
    if (this.rgbDescCount === 0) return { pixels: 0, spans: 0 };
    if (!(await this.awaitReadyAsync())) return null;
    this.snapKick();
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
    const diagT0 = this.diagOn ? performance.now() : 0;
    const main = processRGBFrameJob(
      this.rgbViews, this.fbW, this.fbH, this.rgbDescCount, mainBand.y0, mainBand.y1,
    );
    if (this.diagOn) this.diagMainMs = performance.now() - diagT0;
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

  /** Shut workers down; safe to call twice.
   *
   * In-flight kicks resolve `false` immediately (callers fall back to the
   * identical inline replay) instead of hanging until the kick timeout:
   * reboot/stop between frames can never wedge the loop for `timeoutMs`. */
  async dispose(): Promise<void> {    if (this.disposed) return;
    this.disposed = true;
    for (const done of this.pending.values()) {
      try {
        done(false);
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

  /** Await every worker's completion message for one kick (async path). */
  private awaitWorkerMessages(seq: number, need: number): Promise<boolean> {
    let seen = 0;
    let failed = false;
    return new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(seq);
        resolve(false);
      }, this.timeoutMs);
      this.pending.set(seq, (ok: boolean) => {
        if (!ok) failed = true;
        seen += 1;
        if (seen >= need) {
          this.pending.delete(seq);
          window.clearTimeout(timer);
          resolve(!failed);
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
    this.rgbLuxUsed = 0;
    this.rgbDescCount = 0;
    try {
      Atomics.store(this.ctl, CTL_RGBCOUNT, 0);
    } catch {
      /* ignore */
    }
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
  private kick(seq: number): boolean {
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
