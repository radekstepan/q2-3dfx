// PERF-NEXT-5 browser lane: correct worker/main-thread attribution.
//
// Covers, through the REAL browser worker entry (esbuild-bundled
// render-worker.ts executed in a real worker thread — same SAB +
// CTL_SEQ protocol as the DOM production path) plus real-asset base1
// frames (Q2_PAK-gated):
// - nonempty main band + worker bands with actual execution: flush
//   results return workerSpans/workerPixels/workerTris (WORKER bands
//   only) separately from the combined totals, with Node-matching
//   semantics; combined totals reconcile as worker + main per unit;
// - staged-but-failed jobs (timeout/quarantine, declined dispatch,
//   checkpoint refusal): null result, zero worker-completed, nothing
//   accumulated in the per-frame completed-work split; the work is
//   recounted by the inline replay path (which carries no worker fields:
//   absent = inline, never worker);
// - serial viewmodel path (unpooled): alias/viewmodel draws run inline
//   (main/inline, never worker);
// - real-browser viewmodel execution with corrected counters: pooled
//   base1 attack frames stage gun tris that complete on workers
//   (workerTris > 0), reconciling with the renderer's per-class audit.
import { afterEach, describe, expect, it } from 'vitest';
import { getCVarNumber, resetCVars, setCVar, setCVarFromString } from '@q2/config';
import {
  R_FLAG_BLEND_ALPHA,
  R_FLAG_DEPTHWRITE,
  R_FLAG_FLAT,
  R_FLAG_TRI,
  SPAN_FLAT,
  SPAN_TRANS33,
  type RGBMipLevel,
  type Span,
  type SpanList,
} from '@q2/sw-renderer';
import { Worker as NodeWorker } from 'worker_threads';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { buildSync } from 'esbuild';
import { BrowserBandPool } from './render-workers.js';
import { publishQ2Stats } from './dom.js';
import {
  attachBrowserPool,
  bootPlay,
  createAsyncLoopState,
  frameAsync,
  measureFrameStages,
  pumpExplosionLights,
  pumpMuzzleLight,
  pumpTracers,
  type PlayBoot,
} from './play.js';

const WEB_Q2_PAK = process.env.Q2_PAK;

const SAVED = new Map<string, number | string | boolean>();
function saveCvar(name: string): void {
  if (!SAVED.has(name)) {
    try {
      SAVED.set(name, getCVarNumber(name));
    } catch {
      SAVED.set(name, 0);
    }
  }
}
function sandbox(): void {
  for (const name of [
    'vid_renderer', 'r_brightness', 'vd_postfilter', 'vd_16bit', 'vd_dither',
    'vd_gamma', 'sw_workers', 'sw_accum', 'cl_showfps', 'cl_showpos',
  ]) {
    saveCvar(name);
  }
  setCVar('sw_workers', 0);
  setCVar('sw_accum', 1);
  setCVar('r_brightness', 1.0);
  setCVar('cl_showfps', 0);
  setCVar('cl_showpos', 0);
}
afterEach(() => {
  for (const [name, value] of SAVED) setCVar(name, value);
  resetCVars();
});

/* --- real browser worker entry in a real thread (worker-timing pattern) -- */

const ENTRY_PRELUDE = `import { parentPort } from 'node:worker_threads';
let __handler = null;
globalThis.self = { postMessage: (msg) => { parentPort.postMessage(msg); } };
Object.defineProperty(globalThis.self, 'onmessage', {
  configurable: true,
  enumerable: true,
  get() { return __handler; },
  set(fn) {
    __handler = typeof fn === 'function' ? fn : null;
    if (__handler) {
      parentPort.on('message', (data) => {
        try { __handler({ data }); } catch {
          /* the entry owns its errors; the thread error event surfaces them */
        }
      });
    }
  },
});
`;

let cachedEntryFile: string | null = null;
function realEntryFile(): string {
  if (cachedEntryFile !== null) return cachedEntryFile;
  const entry = new URL('./render-worker.ts', import.meta.url).pathname;
  const built = buildSync({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
    logLevel: 'silent',
  });
  const text = built.outputFiles?.[0]?.text;
  if (!text) throw new Error('esbuild produced no output for render-worker.ts');
  const dir = join(tmpdir(), 'q2-web-entry');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `render-worker-attr-${process.pid}.mjs`);
  writeFileSync(file, ENTRY_PRELUDE + text);
  cachedEntryFile = file;
  return file;
}

/** DOM-Worker-shaped stand-in backed by a REAL entry thread. */
class RealEntryWorker {
  static live: RealEntryWorker[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  readonly errors: unknown[] = [];
  private readonly thread: NodeWorker;
  constructor() {
    RealEntryWorker.live.push(this);
    this.thread = new NodeWorker(realEntryFile());
    this.thread.on('message', (data: unknown) => {
      try {
        this.onmessage?.({ data });
      } catch {
        /* the pool never throws from onmessage */
      }
    });
    this.thread.on('error', (err: unknown) => {
      this.errors.push(err);
    });
  }
  postMessage(msg: unknown): void {
    this.thread.postMessage(msg);
  }
  terminate(): void {
    void this.thread.terminate();
  }
}

/** Never-acking stand-in (ready only): kicks hang until the pool timeout. */
class SilentWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  postMessage(msg: unknown): void {
    const m = msg as { sab?: unknown };
    if (m.sab !== undefined) {
      const self = this;
      setTimeout(() => {
        self.onmessage?.({ data: { ready: true } });
      }, 0);
    }
  }
  terminate(): void {
    /* nothing to tear down */
  }
}

const G = globalThis as unknown as Record<string, unknown>;
const REAL_GLOBALS = { window: G['window'], document: G['document'], Worker: G['Worker'] };

function installRealDom(worker: new () => RealEntryWorker | SilentWorker = RealEntryWorker): void {
  G['window'] = {
    setTimeout: setTimeout.bind(globalThis),
    clearTimeout: clearTimeout.bind(globalThis),
  };
  G['document'] = {};
  G['Worker'] = worker;
}

function removeRealDom(): void {
  if (REAL_GLOBALS.window === undefined) delete G['window'];
  else G['window'] = REAL_GLOBALS.window;
  if (REAL_GLOBALS.document === undefined) delete G['document'];
  else G['document'] = REAL_GLOBALS.document;
  if (REAL_GLOBALS.Worker === undefined) delete G['Worker'];
  else G['Worker'] = REAL_GLOBALS.Worker;
  RealEntryWorker.live.length = 0;
}

/* --- staging helpers (same shapes as browser-lane/worker-timing) --------- */

const REC_W = 64;
const REC_H = 48;

function recChain(r: number, g: number, b: number): RGBMipLevel[] {
  const data = new Uint8Array(4 * 4 * 3);
  for (let i = 0; i < 4 * 4; i++) {
    data[i * 3] = r;
    data[i * 3 + 1] = g;
    data[i * 3 + 2] = b;
  }
  return [{ data, width: 4, height: 4, mask: new Uint8Array(4 * 4).fill(255) }];
}

function recSpan(y: number, x0: number, x1: number, kind: number, iz: number): Span {
  return {
    kind, y, x0, x1, iz, diz: 0, uz: 0, duz: 0, vz: 0, dvz: 0,
    light: 63, dlight: 0, lu: 0, lv: -1, dlu: 0, turb: 0, ord: 0,
    dudy: 0, dvdy: 0,
  };
}

function recList(y0: number, y1: number, x0: number, x1: number, kind: number, iz: number): SpanList {
  const spans: Span[] = [];
  for (let y = y0; y < y1; y++) spans.push(recSpan(y, x0, x1, kind, iz));
  return { spans, count: spans.length };
}

/** Renderer beginFrame clear when pooled: cover 0, depth far, black. */
function recClear(pool: BrowserBandPool): void {
  const p = pool.rgbPlanes;
  p.cover.fill(0);
  p.rgbDepth.fill(0xffff);
  p.rgb565.fill(0);
}

/**
 * Write one screen-space tri into the pool's tri cursor (24 f64 payload +
 * ymin-inclusive/ymax-exclusive row bounds, mirroring emitAliasTris).
 * Samples the 4x4 chain center at full light; depth 1/iz row-guarded.
 */
function writeTriAt(
  pool: BrowserBandPool, slot: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
  iz: number,
): void {
  const cursor = pool.triCursor();
  if (!cursor) throw new Error('no tri cursor (pool dead)');
  const o = (cursor.base + slot) * 24;
  const u = 2 * iz;
  const v = 2 * iz;
  const F = cursor.F;
  F[o] = ax; F[o + 1] = ay; F[o + 2] = iz; F[o + 3] = u; F[o + 4] = v;
  F[o + 5] = 1; F[o + 6] = 1; F[o + 7] = 1;
  F[o + 8] = bx; F[o + 9] = by; F[o + 10] = iz; F[o + 11] = u; F[o + 12] = v;
  F[o + 13] = 1; F[o + 14] = 1; F[o + 15] = 1;
  F[o + 16] = cx; F[o + 17] = cy; F[o + 18] = iz; F[o + 19] = u; F[o + 20] = v;
  F[o + 21] = 1; F[o + 22] = 1; F[o + 23] = 1;
  const q = (cursor.base + slot) * 2;
  cursor.I[q] = Math.floor(Math.min(ay, by, cy));
  cursor.I[q + 1] = Math.ceil(Math.max(ay, by, cy)) + 1;
}

describe('worker/main attribution through the real entry (PERF-NEXT-5)', () => {
  it('nonempty main band + worker bands execute: worker-only split reconciles with combined totals', async () => {
    installRealDom();
    try {
      const pool = BrowserBandPool.create(2, REC_W, REC_H, { timeoutMs: 15000 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        recClear(pool!);
        // World: opaque flat spans over the full frame (rows 0..48; bands
        // are [0,16)/[16,32)/[32,48), the calling thread owns the last).
        const world = recList(0, REC_H, 0, REC_W, SPAN_FLAT, 0.002);
        expect(pool!.stageRGB(world, 0, world.count, recChain(255, 0, 0), null, 0, 0,
          R_FLAG_FLAT | R_FLAG_DEPTHWRITE, 16, 0, 0xff0000)).toBe(true);
        // Two tris (the alias/viewmodel unit): one fully inside worker
        // band 0 (rows 2..8), one fully inside the main band (rows 34..44).
        writeTriAt(pool!, 0, 10, 2, 50, 2, 30, 8, 0.01);
        writeTriAt(pool!, 1, 12, 34, 52, 34, 32, 44, 0.01);
        expect(pool!.stageTriBatch(0, 2, recChain(0, 0, 255),
          R_FLAG_TRI | R_FLAG_DEPTHWRITE, 16, 256)).toBe(true);
        const out = await pool!.flushRGBFrameAsync(1, 1000, 0);
        expect(out).not.toBeNull();
        // Worker bands really executed (nonempty), the main band really
        // executed (nonempty), and tri batches contribute tris but no spans.
        expect(out!.workerPixels).toBeGreaterThan(0);
        expect(out!.workerSpans).toBe(32);
        expect(out!.workerSpans).toBeGreaterThan(0);
        expect(out!.workerTris).toBeGreaterThan(0);
        // Combined totals reconcile as worker + calling-thread band.
        const ks = pool!.kickStats();
        expect(ks.lastRgb).not.toBeNull();
        expect(ks.lastRgb!.workerCompleted).toBe(true);
        expect(ks.lastRgb!.descs).toBe(2);
        expect(out!.pixels).toBe(out!.workerPixels + ks.lastRgb!.mainPixels);
        expect(out!.spans).toBe(out!.workerSpans + ks.lastRgb!.mainSpans);
        expect(out!.tris).toBe(out!.workerTris + ks.lastRgb!.mainTris);
        expect(out!.pixels).toBe(out!.workerPixels + out!.mainPixels);
        expect(out!.spans).toBe(out!.workerSpans + out!.mainSpans);
        expect(out!.tris).toBe(out!.workerTris + out!.mainTris);
        expect(out!.mainPixels).toBe(ks.lastRgb!.mainPixels);
        expect(out!.mainSpans).toBe(ks.lastRgb!.mainSpans);
        expect(out!.mainTris).toBe(ks.lastRgb!.mainTris);
        expect(ks.lastRgb!.workerPixels).toBe(out!.workerPixels);
        expect(ks.lastRgb!.workerSpans).toBe(out!.workerSpans);
        expect(ks.lastRgb!.workerTris).toBe(out!.workerTris);
        expect(ks.lastRgb!.mainPixels).toBe(out!.pixels - out!.workerPixels);
        // Main band drained its 16 span rows (1024 px) plus the tri in
        // rows 34..44; tri batches contribute pixels but no spans.
        expect(ks.lastRgb!.mainPixels).toBeGreaterThan(16 * REC_W);
        expect(ks.lastRgb!.mainSpans).toBe(16);
        // Per-frame completed-work split matches this kick (the only one).
        expect(ks.frameCompleted.workerPixels).toBe(out!.workerPixels);
        expect(ks.frameCompleted.workerSpans).toBe(out!.workerSpans);
        expect(ks.frameCompleted.workerTris).toBe(out!.workerTris);
        expect(ks.frameCompleted.mainPixels).toBe(ks.lastRgb!.mainPixels);
        expect(ks.frameCompleted.mainSpans).toBe(ks.lastRgb!.mainSpans);
        expect(ks.frameCompleted.mainTris).toBe(ks.lastRgb!.mainTris);
        expect(ks.kicks.rgb).toBe(1);
        expect(ks.fallbacks.rgb).toBe(0);
        // Inspected-span counters are available on this build (workers skip
        // non-owned ordered subranges instead of rescanning; `scanned`
        // counts inspected entries of either kind — the 48 span rows plus
        // the tri descriptor in every overlapping band).
        expect(ks.scannedAvailable).toBe(true);
        expect(ks.scanned.rgb).toBeGreaterThanOrEqual(REC_H);

        // Foreground-style second flush (translucent alpha suffix): the
        // per-frame split accumulates BOTH kicks, and execution samples
        // cover only completed kicks.
        const fg = recList(8, 40, 10, 54, SPAN_TRANS33, 0.01);
        expect(pool!.stageRGB(fg, 0, fg.count, recChain(0, 200, 0), null, 0, 0,
          R_FLAG_BLEND_ALPHA, 16, 0, 0)).toBe(true);
        const f = await pool!.flushRGBFrameAsync(1, 1000, 0);
        expect(f).not.toBeNull();
        expect(f!.workerPixels).toBeGreaterThan(0);
        const ks2 = pool!.kickStats();
        expect(ks2.kicks.rgb).toBe(2);
        expect(ks2.frameCompleted.workerPixels).toBe(out!.workerPixels + f!.workerPixels);
        expect(ks2.frameCompleted.workerSpans).toBe(out!.workerSpans + f!.workerSpans);
        expect(ks2.frameCompleted.mainPixels)
          .toBe(ks.lastRgb!.mainPixels + ks2.lastRgb!.mainPixels);
        // Span-only second kick: scanned grows by exactly the 32 staged
        // rows (band-split 8/16/8), proving subranges skip non-owned rows.
        expect(ks2.scanned.rgb - ks.scanned.rgb).toBe(32);
        for (const w of RealEntryWorker.live) expect(w.errors).toEqual([]);
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeRealDom();
    }
  }, 60000);

  it('staged-but-failed kicks report zero worker-completed; inline replay carries no worker fields', async () => {
    installRealDom(SilentWorker);
    try {
      const pool = BrowserBandPool.create(2, REC_W, REC_H, { timeoutMs: 60 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        recClear(pool!);
        const world = recList(0, REC_H, 0, REC_W, SPAN_FLAT, 0.002);
        expect(pool!.stageRGB(world, 0, world.count, recChain(255, 0, 0), null, 0, 0,
          R_FLAG_FLAT | R_FLAG_DEPTHWRITE, 16, 0, 0xff0000)).toBe(true);
        // Timeout: no worker ever acks. The kick fails; the calling-thread
        // band still ran (main share observed) but nothing counts as
        // worker-completed and nothing accumulates per-frame.
        await expect(pool!.flushRGBFrameAsync(1, 1000, 0)).resolves.toBeNull();
        const ks = pool!.kickStats();
        expect(ks.fallbacks.rgb).toBe(1);
        expect(ks.kicks.rgb).toBe(0);
        expect(ks.quarantined).toBe(true);
        expect(ks.lastRgb).not.toBeNull();
        expect(ks.lastRgb!.workerCompleted).toBe(false);
        expect(ks.lastRgb!.descs).toBe(1);
        expect(ks.lastRgb!.workerPixels).toBe(0);
        expect(ks.lastRgb!.workerSpans).toBe(0);
        expect(ks.lastRgb!.workerTris).toBe(0);
        expect(ks.lastRgb!.mainPixels).toBe(16 * REC_W);
        expect(ks.frameCompleted.workerPixels).toBe(0);
        expect(ks.frameCompleted.workerSpans).toBe(0);
        expect(ks.frameCompleted.workerTris).toBe(0);
        expect(ks.frameCompleted.mainPixels).toBe(0);
        // Quarantined: the next kick refuses fast (declined, not failed —
        // nothing was dispatched) and keeps the zero worker attribution.
        const t0 = Date.now();
        await expect(pool!.flushRGBFrameAsync(1, 1000, 0)).resolves.toBeNull();
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(pool!.kickStats().lastRgb!.workerCompleted).toBe(false);
        expect(pool!.kickStats().lastRgb!.workerPixels).toBe(0);
        // Inline replays carry NO worker fields: absent means the work ran
        // on the calling thread (inline), never on workers.
        const rp = pool!.drawInlineRGBAll(1, 1000, 0);
        expect(rp.pixels).toBeGreaterThan(0);
        expect('workerSpans' in rp).toBe(false);
        expect('workerPixels' in rp).toBe(false);
        expect('workerTris' in rp).toBe(false);
        const rr = pool!.recoverInlineRGBAll(() => undefined, 1, 1000, 0);
        expect('workerSpans' in rr).toBe(false);
        expect('workerPixels' in rr).toBe(false);
        expect('workerTris' in rr).toBe(false);
      } finally {
        await pool!.dispose();
      }

      // Checkpoint-allocation refusal (declined before dispatch): nothing
      // was dispatched, nothing executed anywhere — zero worker-completed,
      // clean failure, counted refusal path (no fallback increment).
      const pool2 = BrowserBandPool.create(2, REC_W, REC_H, { timeoutMs: 5000 });
      expect(pool2).not.toBeNull();
      try {
        pool2!.beginFrame();
        recClear(pool2!);
        const world = recList(0, REC_H, 0, REC_W, SPAN_FLAT, 0.002);
        expect(pool2!.stageRGB(world, 0, world.count, recChain(255, 0, 0), null, 0, 0,
          R_FLAG_FLAT | R_FLAG_DEPTHWRITE, 16, 0, 0xff0000)).toBe(true);
        (pool2 as unknown as { testDropSnapshot: boolean }).testDropSnapshot = true;
        await expect(pool2!.flushRGBFrameAsync(1, 1000, 0)).resolves.toBeNull();
        expect(pool2!.lastRGBFailure()).toBe('clean');
        const ks2 = pool2!.kickStats();
        expect(ks2.kicks.rgb).toBe(0);
        expect(ks2.fallbacks.rgb).toBe(0);
        expect(ks2.lastRgb).not.toBeNull();
        expect(ks2.lastRgb!.workerCompleted).toBe(false);
        expect(ks2.lastRgb!.workerPixels).toBe(0);
        expect(ks2.lastRgb!.workerSpans).toBe(0);
        expect(ks2.lastRgb!.workerTris).toBe(0);
        expect(ks2.lastRgb!.mainPixels).toBe(0);
      } finally {
        await pool2!.dispose();
      }
    } finally {
      removeRealDom();
    }
  }, 60000);

  it('browser stats expose the corrected counters with unknown sentinels', async () => {
    installRealDom();
    try {
      sandbox();
      const pool = BrowserBandPool.create(2, REC_W, REC_H, { timeoutMs: 15000 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        recClear(pool!);
        const world = recList(0, REC_H, 0, REC_W, SPAN_FLAT, 0.002);
        expect(pool!.stageRGB(world, 0, world.count, recChain(255, 0, 0), null, 0, 0,
          R_FLAG_FLAT | R_FLAG_DEPTHWRITE, 16, 0, 0xff0000)).toBe(true);
        writeTriAt(pool!, 0, 10, 2, 50, 2, 30, 8, 0.01);
        expect(pool!.stageTriBatch(0, 1, recChain(0, 0, 255),
          R_FLAG_TRI | R_FLAG_DEPTHWRITE, 16, 256)).toBe(true);
        const out = await pool!.flushRGBFrameAsync(1, 1000, 0);
        expect(out).not.toBeNull();
        const boot = bootPlay({ width: REC_W, height: REC_H });
        (boot as unknown as { browserPool: unknown }).browserPool = pool;
        const s = publishQ2Stats(boot, 60, 3);
        // Pool surface: corrected counters match the kick's split.
        expect(s.pooled).toBe(false);
        expect(s.rgbWorkerSpans).toBe(out!.workerSpans);
        expect(s.rgbWorkerPixels).toBe(out!.workerPixels);
        expect(s.rgbWorkerTris).toBe(out!.workerTris);
        expect(s.rgbMainSpans).toBe(out!.spans - out!.workerSpans);
        expect(s.rgbMainPixels).toBe(out!.pixels - out!.workerPixels);
        expect(s.rgbMainTris).toBe(out!.tris - out!.workerTris);
        // Renderer surface: the per-class audit hook is present on this
        // build (bare boot rendered nothing through it — known zeros).
        expect(s.fgDetail).not.toBeNull();
        expect(s.fgDetail!.workerSpansCompleted).toBe(0);
        expect(s.fgDetail!.trisStaged).toBe(0);
        expect(s.fgDetail!.aliasDrawsStaged).toBe(0);
        expect(s.fgDetail!.spriteSpansInline).toBe(0);
        expect(s.fgDetail!.particleSpansInline).toBe(0);
        expect(s.fgDetail!.beamSpansInline).toBe(0);
        // A throwing hook degrades to the unknown sentinel (null), never
        // a silent zero and never a throw on the present path.
        const rec = boot.refresh as unknown as Record<string, unknown>;
        rec['testForegroundStats'] = (): never => {
          throw new Error('simulated future-renderer hook failure');
        };
        expect(publishQ2Stats(boot, 60, 4).fgDetail).toBeNull();
        // Unpooled boot (no pool probe): unknown sentinels, never
        // worker-completed; the renderer fgDetail still carries the
        // known-zero inline story.
        const bare = bootPlay({ width: REC_W, height: REC_H });
        const t = publishQ2Stats(bare, 60, 5);
        expect(t.rgbWorkerSpans).toBe(-1);
        expect(t.rgbWorkerPixels).toBe(-1);
        expect(t.rgbWorkerTris).toBe(-1);
        expect(t.rgbMainSpans).toBe(-1);
        expect(t.rgbMainPixels).toBe(-1);
        expect(t.rgbMainTris).toBe(-1);
        expect(t.fgDetail).not.toBeNull();
        expect(t.fgDetail!.workerSpansCompleted).toBe(0);
        expect(t.fgDetail!.trisCompleted).toBe(0);
        for (const w of RealEntryWorker.live) expect(w.errors).toEqual([]);
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeRealDom();
    }
  }, 60000);
});

describe.runIf(!!WEB_Q2_PAK)('viewmodel attribution on real base1 frames (Q2_PAK)', () => {
  async function bootBase1(w: number, h: number): Promise<PlayBoot> {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    return bootPlay({ width: w, height: h, pak: ingestPak(buf) });
  }

  function attackInputs(boot: PlayBoot, f: number): void {
    boot.host.input.angles = [0, (f * 13) % 360, 0];
    boot.host.input.buttons = f >= 2 ? 1 : 0;
    if (f % 3 === 0) boot.host.input.keys.add('forward');
    if (f % 3 === 1) boot.host.input.keys.delete('forward');
  }

  it('serial viewmodel path draws inline (main/inline, never worker)', { timeout: 300000 }, async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'voodoo');
    const base = await bootBase1(96, 72);
    const st = createAsyncLoopState();
    let t = 0;
    let sawGun = false;
    for (let f = 0; f < 8; f++) {
      t += 16.7;
      attackInputs(base, f);
      pumpMuzzleLight(base);
      pumpExplosionLights(base);
      pumpTracers(base);
      await frameAsync(base, st, t);
      const fs = (base.refresh as unknown as {
        testForegroundStats(): {
          aliasDrawsInline: number; aliasTrisInline: number;
          workerSpansCompleted: number; workerPixelsCompleted: number;
          trisCompleted: number; trisStaged: number;
        };
      }).testForegroundStats();
      if (f >= 2 && fs.aliasTrisInline > 0) sawGun = true;
      // Unpooled serial frame: nothing completes on workers, ever.
      expect(fs.workerSpansCompleted).toBe(0);
      expect(fs.workerPixelsCompleted).toBe(0);
      expect(fs.trisCompleted).toBe(0);
      const s = publishQ2Stats(base, 60, f);
      expect(s.rgbWorkerSpans).toBe(-1);
      expect(s.rgbWorkerTris).toBe(-1);
      expect(s.fgDetail).not.toBeNull();
      expect(s.fgDetail!.workerSpansCompleted).toBe(0);
      expect(s.fgDetail!.trisCompleted).toBe(0);
    }
    // The gun (viewmodel) really rendered: serial alias tris inline.
    expect(sawGun).toBe(true);
  });

  it('real-browser viewmodel executes on workers with corrected counters', { timeout: 300000 }, async () => {
    installRealDom();
    try {
      sandbox();
      setCVarFromString('vid_renderer', 'voodoo');
      setCVar('sw_workers', 4);
      const boot = await bootBase1(96, 72);
      const pool = attachBrowserPool(boot);
      expect(pool).not.toBeNull();
      pool!.enableDiag();
      try {
        const st = createAsyncLoopState();
        let t = 0;
        let sawWorkerGun = false;
        for (let f = 0; f < 8; f++) {
          t += 16.7;
          attackInputs(boot, f);
          pumpMuzzleLight(boot);
          pumpExplosionLights(boot);
          pumpTracers(boot);
          await frameAsync(boot, st, t, { fps: 60, frame: f });
          const fs = (boot.refresh as unknown as {
            testForegroundStats(): {
              aliasDrawsInline: number; aliasTrisInline: number;
              trisStaged: number; trisCompleted: number; trisMainCompleted: number;
              workerSpansCompleted: number; workerPixelsCompleted: number;
              mainSpansCompleted: number; mainPixelsCompleted: number;
            };
          }).testForegroundStats();
          const fc = pool!.kickStats().frameCompleted;
          if (f >= 2) {
            // The gun staged real tris and workers completed them: the
            // tri unit reconciles across lanes (world stages no tris, so
            // every completed tri is foreground work).
            expect(fs.trisStaged).toBeGreaterThan(0);
            expect(fs.trisCompleted).toBeGreaterThan(0);
            expect(fc.workerTris).toBeGreaterThan(0);
            expect(fs.trisCompleted).toBe(fc.workerTris + fc.mainTris);
            if (fc.workerTris > 0) sawWorkerGun = true;
          }
          const s = publishQ2Stats(boot, 60, f);
          expect(s.pooled).toBe(true);
          expect(s.rgbWorkerTris).toBe(fc.workerTris);
          expect(s.rgbMainTris).toBe(fc.mainTris);
          expect(s.fgDetail).not.toBeNull();
          expect(s.fgDetail!.trisStaged).toBe(fs.trisStaged);
          expect(s.fgDetail!.trisCompleted).toBe(fs.trisCompleted);
        }
        expect(sawWorkerGun).toBe(true);
        expect(pool!.kickStats().fallbacks.rgb).toBe(0);
        expect(boot.statAsyncFallbacks).toBe(0);
        // Same-frame instrumented slice: worker + main reconcile per unit
        // and tris reconcile across the pool/renderer lanes.
        t += 16.7;
        attackInputs(boot, 8);
        const rep = await measureFrameStages(boot, createAsyncLoopState(), t, { fps: 60, frame: 8 });
        expect(rep.pooled).toBe(true);
        expect(rep.rgbFallbacks).toBe(0);
        expect(rep.rgbWorkerTris).toBeGreaterThan(0);
        expect(rep.fgDetail).not.toBeNull();
        expect(rep.fgDetail!.trisCompleted)
          .toBe(rep.rgbWorkerTris + rep.rgbMainTris);
        for (const w of RealEntryWorker.live) expect(w.errors).toEqual([]);
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeRealDom();
    }
  });
});
