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
  CTL_COUNT, CTL_DONE, CTL_FBH, CTL_FBW, CTL_FRAME, CTL_HMASK, CTL_LIGHTH, CTL_LIGHTW,
  CTL_PIXELS, CTL_READY, CTL_SEQ, CTL_SPANS, CTL_TEXH, CTL_TEXW, CTL_TURBPHASE,
  CTL_WMASK, CTL_WSHIFT, MAX_WORKERS, MIN_BAND_PIXELS,
  attachBandShared, bandTotal, packBandSpans, processBandJob, readBandJob,
  sabAvailable, splitBands, syncWaitAllowed, writeBandJob,
  type Band,
  type BandDispatcher, type BandViews,
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
  private readonly views: BandViews;
  private readonly ctl: Int32Array;
  private readonly bands: Band[];
  private readonly timeoutMs: number;
  private seq = 0;
  private lastTexels: Uint8Array | null = null;
  private lastLight: Uint8Array | null = null;
  private lastColormap: Uint8Array | null = null;
  private readonly pending = new Map<number, () => void>();
  private readyCount = 0;
  private frameGen = 0;
  private mainLastGen = 0;
  private disposed = false;

  private constructor(
    bandCount: number, views: BandViews, ctl: Int32Array,
    bands: Band[],
    workers: WorkerLike[], timeoutMs: number,
  ) {
    this.bandCount = bandCount;
    this.views = views;
    this.ctl = ctl;
    this.bands = bands;
    this.timeoutMs = timeoutMs;
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
      const { views, ctl } = attachBandShared(new SharedArrayBuffer(bandTotal(w, h)), w, h);
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
      return new BandWorkerPool(workers + 1, views, ctl, bands, spawned, opts.timeoutMs ?? 30000);
    } catch {
      return null;
    }
  }

  /** Live shared planes (the renderer adopts these when banded + attached). */
  get idx(): Uint8Array {
    return this.views.idx;
  }

  get zb(): Float32Array {
    return this.views.zb;
  }

  get planes(): { idx: Uint8Array; zb: Float32Array } {
    return { idx: this.views.idx, zb: this.views.zb };
  }

  frame(): number {
    return this.frameGen;
  }

  /** Bump the frame generation; bands clear lazily on the next batch. */
  beginFrame(): void {
    if (this.disposed) return;
    this.frameGen += 1;
    try {
      Atomics.store(this.ctl, CTL_FRAME, this.frameGen);
    } catch {
      /* ignore */
    }
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
    if (idx !== this.views.idx || zb !== this.views.zb) return null;
    const packed = this.pack(list);
    if (!packed) return null;
    if (packed.count === 0) return { pixels: 0, spans: 0 };
    if (packed.est < MIN_BAND_PIXELS) return null;
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
    const main = processBandJob(this.views, readBandJob(this.ctl, mainBand.y0, mainBand.y1));
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
    if (idx !== this.views.idx || zb !== this.views.zb) return null;
    const packed = this.pack(list);
    if (!packed) return null;
    if (packed.count === 0) return Promise.resolve({ pixels: 0, spans: 0 });
    if (packed.est < MIN_BAND_PIXELS) return null;
    if (!(await this.awaitReadyAsync())) {
      Com_Warn('bandPool: workers never became ready, redrawing inline');
      return null;
    }
    this.publish(tex, light, colormap, time, fbW, fbH, packed.count);
    const seq = this.seq;
    const need = this.workers.length;
    let seen = 0;
    const finished = new Promise<boolean>((resolve) => {
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
    if (!this.kick(seq)) {
      this.pending.delete(seq);
      return null;
    }
    // Main-thread band first (sync), then await the workers.
    const mainBand = this.bands[this.bands.length - 1]!;
    this.clearMainBand(mainBand, fbW);
    const main = processBandJob(this.views, readBandJob(this.ctl, mainBand.y0, mainBand.y1));
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
    return packBandSpans(list, this.views.spansF, this.views.spansI);
  }

  /** Lazily clear the calling thread's band once per frame generation. */
  private clearMainBand(mainBand: Band, fbW: number): void {
    if (this.mainLastGen !== this.frameGen) {
      this.views.idx.fill(0, mainBand.y0 * fbW, mainBand.y1 * fbW);
      this.views.zb.fill(0, mainBand.y0 * fbW, mainBand.y1 * fbW);
      this.mainLastGen = this.frameGen;
    }
  }

  private publish(
    tex: Texture, light: LightBlock,
    colormap: Uint8Array, time: number, fbW: number, fbH: number, count: number,
  ): void {
    this.stage(tex, light, colormap);
    const masks = textureMasks(tex);
    const phase = ((time * 64) | 0) & (this.views.turb.length - 1);
    writeBandJob(
      this.ctl, count, fbW, fbH,
      tex.width | 0, tex.height | 0, light.width | 0, light.height | 0,
      masks.wshift, masks.wmask, masks.hmask, phase,
    );
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
      this.views.texels.set(tex.texels.subarray(0, Math.min(tex.texels.length, this.views.texels.length)));
      this.lastTexels = tex.texels;
    }
    if (this.lastLight !== light.values) {
      this.views.light.set(light.values.subarray(0, Math.min(light.values.length, this.views.light.length)));
      this.lastLight = light.values;
    }
    if (this.lastColormap !== colormap) {
      this.views.colormap.set(colormap.subarray(0, this.views.colormap.length));
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
    'const shared = m.attachBandShared(workerData.sab, workerData.w, workerData.h);',
    'm.bandWorkerLoop(shared.views, shared.ctl,',
    '  workerData.y0, workerData.y1, workerData.band, workerData.w,',
    '  function (s) { Atomics.wait(shared.ctl, m.CTL_SEQ, s); },',
    '  parentPort);',
  ].join('\n');
}
