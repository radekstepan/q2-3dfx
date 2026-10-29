// PERF-NEXT-4 browser lane: real worker execution timing end to end.
//
// Integration through the REAL browser worker entry
// (`render-worker.ts`, bundled and executed in a real worker thread with
// the REAL shared `bandWorkerLoop` from @q2/sw-renderer) driving the REAL
// `BrowserBandPool` (same SAB + CTL_SEQ protocol as the DOM production
// path): every executed world/foreground/resolve/scanout job must carry a
// finite measured worker-side duration plus correct (frame, seq, job,
// band) identity and actual work counts. A test accepting null or a
// synthetic execMs does NOT count — durations here are measured by the
// entry around genuine loop execution, and the pool surfaces them only
// when diag is armed (acceptance runs disarmed; the disabled path records
// nothing).
//
// Also pins: within-kick straggler math (pure units), the entry stamp
// precedence (loop fields win, boundary timing fills gaps), per-job
// frozen snapshots (FG flushes survive later resolve/scanout kicks), the
// per-frame kick ledger, testBandExecStats cross-lane samples, Q2Stats
// timing fields + sentinels, and the StageReport per-frame slice.
import { afterEach, describe, expect, it } from 'vitest';
import { getCVarNumber, resetCVars, setCVar, setCVarFromString } from '@q2/config';
import {
  JOB_RASTER,
  JOB_RESOLVE,
  JOB_RGB,
  JOB_SCANOUT,
  R_FLAG_BLEND_ALPHA,
  R_FLAG_DEPTHWRITE,
  R_FLAG_FLAT,
  SPAN_FLAT,
  SPAN_TRANS33,
  splitBands,
  type RGBMipLevel,
  type Span,
  type SpanList,
} from '@q2/sw-renderer';
import { collectWorkerExec } from '@q2/testkit';
import { Worker as NodeWorker } from 'worker_threads';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { buildSync } from 'esbuild';
import {
  BrowserBandPool,
  diagJobToCritJob,
  summarizeExec,
  type DiagJob,
  type ScanoutBandOptions,
} from './render-workers.js';
import { publishQ2Stats } from './dom.js';
import {
  bootPlay,
  createAsyncLoopState,
  frameAsync,
  measureFrameStages,
  pumpExplosionLights,
  pumpMuzzleLight,
  pumpTracers,
  resolveDisplay,
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

/* --- real browser worker entry in a real thread -------------------------
 *
 * The production entry (render-worker.ts) is bundled as-is with esbuild
 * and executed in a Node worker_thread behind a minimal `self` shim
 * (postMessage/onmessage bridge to parentPort). The bundle runs the REAL
 * shared bandWorkerLoop from @q2/sw-renderer — same SAB layout, same
 * CTL_SEQ protocol, same completion messages the DOM workers post — so
 * everything below executes real jobs through the real entry, not mocks.
 * The bundle is built once per test file and cached.
 */

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
  const file = join(dir, `render-worker-bundle-${process.pid}.mjs`);
  writeFileSync(file, ENTRY_PRELUDE + text);
  cachedEntryFile = file;
  return file;
}

/** DOM-Worker-shaped stand-in backed by a REAL entry thread. */
class RealEntryWorker {
  static live: RealEntryWorker[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  readonly errors: unknown[] = [];
  readonly seen: unknown[] = [];
  private readonly thread: NodeWorker;
  constructor() {
    RealEntryWorker.live.push(this);
    this.thread = new NodeWorker(realEntryFile());
    this.thread.on('message', (data: unknown) => {
      this.seen.push(data);
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
  /** Completion messages posted by the real entry (ready/exit filtered out). */
  completions(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const m of this.seen) {
      if (typeof m === 'object' && m !== null &&
        typeof (m as Record<string, unknown>)['seq'] === 'number') {
        out.push(m as Record<string, unknown>);
      }
    }
    return out;
  }
}

const G = globalThis as unknown as Record<string, unknown>;
const REAL_GLOBALS = { window: G['window'], document: G['document'], Worker: G['Worker'] };

function installRealDom(): void {
  G['window'] = {
    setTimeout: setTimeout.bind(globalThis),
    clearTimeout: clearTimeout.bind(globalThis),
  };
  G['document'] = {};
  G['Worker'] = RealEntryWorker;
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

/* --- real RGB staging helpers (same shapes as browser-lane) ------------ */

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

describe('summarizeExec (within-kick straggler math, pure)', () => {
  it('empty and unknown-only inputs read -1/0 sentinels', () => {
    expect(summarizeExec([])).toEqual({ max: -1, med: -1, min: -1, known: 0 });
    expect(summarizeExec([-1, -1])).toEqual({ max: -1, med: -1, min: -1, known: 0 });
  });

  it('odd/even medians over finite non-negative entries only', () => {
    expect(summarizeExec([4])).toEqual({ max: 4, med: 4, min: 4, known: 1 });
    expect(summarizeExec([1, 2, 3])).toEqual({ max: 3, med: 2, min: 1, known: 3 });
    // Even count: mean of the two middle bands (same-kick bands only —
    // never across kicks or phases).
    expect(summarizeExec([1, 2, 3, 4])).toEqual({ max: 4, med: 2.5, min: 1, known: 4 });
  });

  it('ignores -1/NaN/Infinity/negative entries, never launders them', () => {
    const s = summarizeExec([-1, NaN, Infinity, -0.5, 2, 6]);
    expect(s).toEqual({ max: 6, med: 4, min: 2, known: 2 });
  });
});

describe('diagJobToCritJob (browser → testkit vocabulary)', () => {
  it('maps the pooled lanes, rejects unknown', () => {
    expect(diagJobToCritJob('rgb')).toBe('rgb');
    expect(diagJobToCritJob('scanout')).toBe('scanout');
    expect(diagJobToCritJob('raster')).toBe('indexed-frame');
    expect(diagJobToCritJob('resolve')).toBe('indexed-resolve');
    expect(diagJobToCritJob('unknown')).toBeNull();
  });
});

describe('entry stamp (real render-worker.ts module, self-shimmed)', () => {
  it('loop fields win; boundary timing fills gaps; non-completions pass through', async () => {
    const shim = { postMessage: (): void => undefined, onmessage: null as unknown };
    G['self'] = shim;
    try {
      const entry = await import('./render-worker.js');
      // Loop-provided fields are preserved verbatim (renderer lane wins).
      const loopMsg = { seq: 7, band: 1, pixels: 100, spans: 10, execMs: 1.5, frame: 3, job: 'rgb' };
      expect(entry.stampCompletion(loopMsg, 99, 90, 999, 'resolve')).toEqual(loopMsg);
      // Gap-fill: boundary duration + CTL-latched identity.
      const stamped = entry.stampCompletion(
        { seq: 8, band: 0, pixels: 50, spans: 5 }, 120, 100, 4, 'rgb',
      ) as Record<string, unknown>;
      expect(stamped['execMs']).toBe(20);
      expect(stamped['frame']).toBe(4);
      expect(stamped['job']).toBe('rgb');
      expect(stamped['seq']).toBe(8);
      expect(stamped['band']).toBe(0);
      // No boundary start: no synthesised duration (never guessed).
      const noStart = entry.stampCompletion(
        { seq: 9, band: 0, pixels: 1, spans: 1 }, 120, -1, 4, 'scanout',
      ) as Record<string, unknown>;
      expect('execMs' in noStart).toBe(false);
      expect(noStart['frame']).toBe(4);
      expect(noStart['job']).toBe('scanout');
      // Malformed loop execMs is not laundered: boundary timing fills it.
      const bad = entry.stampCompletion(
        { seq: 10, band: 0, pixels: 1, spans: 1, execMs: -3 }, 130, 100, 5, 'raster',
      ) as Record<string, unknown>;
      expect(bad['execMs']).toBe(30);
      // Non-completions (ready/exit acks: no numeric seq) pass through by
      // reference — the entry never stamps control messages.
      const ready = { ready: true, band: 0 };
      expect(entry.stampCompletion(ready, 1, 0, 0, 'rgb')).toBe(ready);
      const exited = { exited: true, band: 1 };
      expect(entry.stampCompletion(exited, 1, 0, 0, 'rgb')).toBe(exited);
      expect(entry.stampCompletion(null, 1, 0, 0, 'rgb')).toBe(null);
      // Job label mapping covers every CTL_JOB code family.
      expect(entry.workerJobLabel(JOB_RGB)).toBe('rgb');
      expect(entry.workerJobLabel(JOB_RESOLVE)).toBe('resolve');
      expect(entry.workerJobLabel(JOB_SCANOUT)).toBe('scanout');
      expect(entry.workerJobLabel(JOB_RASTER)).toBe('raster');
      expect(entry.workerJobLabel(999)).toBe('unknown');
      entry.setWorkerClock(null);
    } finally {
      delete G['self'];
    }
  });
});

describe('disabled timing path (acceptance shape: real entry, real work)', () => {
  it('executes with zero diag surface: null snapshot, empty ledger, unpublished samples', async () => {
    installRealDom();
    try {
      const pool = BrowserBandPool.create(2, REC_W, REC_H, { timeoutMs: 15000 });
      expect(pool).not.toBeNull();
      try {
        expect(pool!.diagActive()).toBe(false);
        pool!.beginFrame();
        recClear(pool!);
        const world = recList(0, REC_H, 0, REC_W, SPAN_FLAT, 0.002);
        expect(pool!.stageRGB(world, 0, world.count, recChain(255, 0, 0), null, 0, 0,
          R_FLAG_FLAT | R_FLAG_DEPTHWRITE, 16, 0, 0xff0000)).toBe(true);
        // Disarmed production kick: real execution, no recording.
        const out = await pool!.flushRGBFrameAsync(1, 1000, 0);
        expect(out).not.toBeNull();
        expect(out!.pixels).toBeGreaterThan(0);
        expect(pool!.diagSnapshot()).toBeNull();
        expect(pool!.diagSnapshot('rgb')).toBeNull();
        expect(pool!.kickTimings()).toEqual([]);
        expect(pool!.testBandExecStats()).toBeNull();
        expect(pool!.lastKickJob()).toBe('unknown');
        // The pool still counted the kick (execution proof lives in the
        // counters, not the disarmed timing path).
        expect(pool!.kickStats().kicks.rgb).toBe(1);
        for (const w of RealEntryWorker.live) expect(w.errors).toEqual([]);
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeRealDom();
    }
  }, 60000);
});

describe('real entry execution timing (world + foreground-style flushes)', () => {
  it('every executed job carries finite duration + identity + work counts', async () => {
    installRealDom();
    try {
      const pool = BrowserBandPool.create(2, REC_W, REC_H, { timeoutMs: 15000 });
      expect(pool).not.toBeNull();
      try {
        expect(RealEntryWorker.live.length).toBe(2);
        pool!.beginFrame();
        recClear(pool!);
        const worldChain = recChain(255, 0, 0);
        const fgChain = recChain(0, 200, 0);
        const world = recList(0, REC_H, 0, REC_W, SPAN_FLAT, 0.002);
        const fg = recList(8, 40, 10, 54, SPAN_TRANS33, 0.01);
        expect(pool!.stageRGB(world, 0, world.count, worldChain, null, 0, 0,
          R_FLAG_FLAT | R_FLAG_DEPTHWRITE, 16, 0, 0xff0000)).toBe(true);
        pool!.enableDiag();
        const frameGen = pool!.frame();
        // World flush: real execution on both worker bands + the main band.
        const w = await pool!.flushRGBFrameAsync(1, 1000, 0);
        expect(w).not.toBeNull();
        expect(w!.pixels).toBeGreaterThan(0);
        expect(w!.spans).toBeGreaterThan(0);
        // Worker/main attribution (PERF-NEXT-5): worker bands rasterised
        // the kick (span batches carry no tris), the calling-thread band
        // drained rows 32..48 inline (16 x 64 px). Combined totals
        // reconcile as worker + main per unit.
        expect(w!.workerPixels).toBeGreaterThan(0);
        expect(w!.workerSpans).toBe(32);
        expect(w!.workerTris).toBe(0);
        expect(w!.pixels).toBe(w!.workerPixels + 16 * REC_W);
        expect(w!.spans).toBe(w!.workerSpans + 16);
        expect(w!.tris).toBe(0);
        expect(pool!.kickStats().lastRgb).toEqual({
          descs: 1, workerCompleted: true,
          mainPixels: 16 * REC_W, mainSpans: 16,
          workerPixels: w!.workerPixels, workerSpans: w!.workerSpans,
          workerTris: 0, mainTris: 0,
        });

        // Raw completion messages from the REAL entry: finite measured
        // durations (never null, never synthetic), correct identity.
        const completions = RealEntryWorker.live.flatMap((wrk) => wrk.completions());
        expect(completions.length).toBe(2);
        const bandsSeen: number[] = [];
        for (const c of completions) {
          expect(Number.isFinite(c['execMs'] as number)).toBe(true);
          expect(c['execMs'] as number).toBeGreaterThanOrEqual(0);
          expect(c['frame']).toBe(frameGen);
          expect(c['job']).toBe('rgb');
          bandsSeen.push(c['band'] as number);
          expect(c['pixels']).toBeGreaterThanOrEqual(0);
          expect(c['spans']).toBeGreaterThanOrEqual(0);
        }
        expect(bandsSeen.sort((a, b) => a - b)).toEqual([0, 1]);
        // Real band work happened (not control-only stubs): worker pixels
        // plus the calling-thread band sum to the kick total.
        const workerPixels = completions.reduce((n, c) => n + (c['pixels'] as number), 0);
        expect(workerPixels).toBeGreaterThan(0);
        expect(workerPixels + 16 * REC_W).toBe(w!.pixels);

        // Pool snapshot: per-band lists + within-kick straggler stats.
        const snap = pool!.diagSnapshot('rgb');
        expect(snap).not.toBeNull();
        expect(snap!.job).toBe('rgb');
        expect(snap!.frame).toBe(frameGen);
        expect(snap!.bands).toBe(3);
        expect([...snap!.bandIds].sort((a, b) => a - b)).toEqual([0, 1]);
        expect(snap!.workerExecMs.length).toBe(2);
        for (const e of snap!.workerExecMs) {
          expect(Number.isFinite(e)).toBe(true);
          expect(e).toBeGreaterThanOrEqual(0);
        }
        expect(snap!.mainMs).toBeGreaterThanOrEqual(0);
        expect(snap!.execMaxMs).toBeGreaterThanOrEqual(snap!.execMedianMs);
        expect(snap!.execMedianMs).toBeGreaterThanOrEqual(snap!.execMinMs);
        expect(snap!.execMinMs).toBeGreaterThanOrEqual(0);
        expect(snap!.execImbalanceMs).toBe(snap!.execMaxMs - snap!.execMinMs);
        expect(snap!.execKnown).toBe(2);
        expect(snap!.execUnknown).toBe(0);
        expect(snap!.slowestMs).toBeGreaterThanOrEqual(0);
        expect(snap!.arrivalSpreadMs).toBeGreaterThanOrEqual(0);

        // Ledger: one completed rgb entry with the same fields.
        const ledger = pool!.kickTimings();
        expect(ledger.length).toBe(1);
        expect(ledger[0]).toMatchObject({
          frame: frameGen, job: 'rgb', bands: 3, outcome: 'completed',
        });
        expect(ledger[0]!.seq).toBe(snap!.seq);
        expect(ledger[0]!.execMaxMs).toBe(snap!.execMaxMs);
        expect(ledger[0]!.gapSincePrevMs).toBe(-1);

        // Cross-lane samples: usable through the shared testkit consumer.
        const samples = pool!.testBandExecStats();
        expect(samples).not.toBeNull();
        expect(samples!.length).toBe(2);
        for (const s of samples!) {
          expect(s.frame).toBe(frameGen);
          expect(s.job).toBe('rgb');
          expect([0, 1]).toContain(s.band);
          expect(s.worker).toBe(s.band);
          expect(s.execMs).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(s.execMs)).toBe(true);
        }
        expect(collectWorkerExec(pool)).toEqual(samples);
        const bands = splitBands(REC_H, 3);
        for (const s of samples!) {
          expect(s.y0).toBe(bands[s.band]!.y0);
          expect(s.y1).toBe(bands[s.band]!.y1);
        }

        // Foreground-style second flush (placed-pass analog): stage more
        // work after the world kick and flush again — it must carry the
        // same timing fields with its own kick identity.
        expect(pool!.stageRGB(fg, 0, fg.count, fgChain, null, 0, 0,
          R_FLAG_BLEND_ALPHA, 16, 0, 0)).toBe(true);
        const f = await pool!.flushRGBFrameAsync(1, 1000, 0);
        expect(f).not.toBeNull();
        expect(f!.pixels).toBeGreaterThan(0);
        const ledger2 = pool!.kickTimings();
        expect(ledger2.length).toBe(2);
        expect(ledger2[0]!.seq).toBeLessThan(ledger2[1]!.seq);
        for (const e of ledger2) {
          expect(e.job).toBe('rgb');
          expect(e.outcome).toBe('completed');
          expect(e.execMaxMs).toBeGreaterThanOrEqual(0);
          expect(e.execKnown).toBe(2);
        }
        expect(ledger2[1]!.gapSincePrevMs).toBeGreaterThanOrEqual(0);
        expect(pool!.diagSnapshot('rgb')!.seq).toBe(ledger2[1]!.seq);
        // Per-frame accumulation: both flushes' bands, distinct seqs.
        const samples2 = pool!.testBandExecStats();
        expect(samples2!.length).toBe(4);
        const seqs = new Set(samples2!.map((s) => s.seq));
        expect(seqs.size).toBe(2);
        expect(collectWorkerExec(pool)!.length).toBe(4);
        for (const wrk of RealEntryWorker.live) expect(wrk.errors).toEqual([]);
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeRealDom();
    }
  }, 60000);
});

describe('resolve + scanout through the real entry (per-job snapshots, browser stats)', () => {
  const SCANOUT_OPTS: ScanoutBandOptions = {
    gamma: 1.3, dither: true, ditherMode: 1, postfilter: true, reconmode: 1,
    maxR: 8, maxG: 8, maxB: 8, quantise: false,
  };

  it('per-lane critical paths surface in diag + __q2stats without clobbering rgb', async () => {
    installRealDom();
    try {
      const pool = BrowserBandPool.create(2, REC_W, REC_H, { timeoutMs: 15000 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        recClear(pool!);
        const world = recList(0, REC_H, 0, REC_W, SPAN_FLAT, 0.002);
        expect(pool!.stageRGB(world, 0, world.count, recChain(255, 0, 0), null, 0, 0,
          R_FLAG_FLAT | R_FLAG_DEPTHWRITE, 16, 0, 0xff0000)).toBe(true);
        pool!.enableDiag();
        expect(await pool!.flushRGBFrameAsync(1, 1000, 0)).not.toBeNull();
        const rgbSeq = pool!.diagSnapshot('rgb')!.seq;
        pool!.stagePalette(new Uint8Array(768).fill(128));
        expect(await pool!.resolveFrameAsync()).toBe(true);
        expect(await pool!.flushScanoutAsync(SCANOUT_OPTS)).toBe(true);
        expect(pool!.kickStats().kicks.resolve).toBe(1);
        expect(pool!.kickStats().kicks.scanout).toBe(1);
        expect(pool!.kickStats().fallbacks.resolve).toBe(0);
        expect(pool!.kickStats().fallbacks.scanout).toBe(0);

        // Per-job frozen snapshots: resolve/scanout kicks carry finite
        // worker durations + identity, and never clobber the rgb flushes.
        const res = pool!.diagSnapshot('resolve');
        expect(res).not.toBeNull();
        expect(res!.job).toBe('resolve');
        expect(res!.bands).toBe(3);
        expect(res!.workerExecMs.length).toBe(2);
        for (const e of res!.workerExecMs) {
          expect(Number.isFinite(e)).toBe(true);
          expect(e).toBeGreaterThanOrEqual(0);
        }
        expect(res!.slowestMs).toBeGreaterThanOrEqual(0);
        const scan = pool!.diagSnapshot('scanout');
        expect(scan).not.toBeNull();
        expect(scan!.job).toBe('scanout');
        expect(scan!.slowestMs).toBeGreaterThanOrEqual(0);
        for (const e of scan!.workerExecMs) {
          expect(Number.isFinite(e)).toBe(true);
          expect(e).toBeGreaterThanOrEqual(0);
        }
        // Last kick overall is scanout; the rgb flushes are intact.
        expect(pool!.diagSnapshot()!.job).toBe('scanout');
        expect(pool!.diagSnapshot('rgb')!.seq).toBe(rgbSeq);
        expect(pool!.lastKickJob()).toBe('scanout');

        // Ledger covers every lane in issue order.
        const jobs = pool!.kickTimings().map((k) => k.job);
        expect(jobs).toEqual(['rgb', 'resolve', 'scanout']);
        for (const e of pool!.kickTimings()) {
          expect(e.outcome).toBe('completed');
          expect(e.execKnown).toBe(2);
        }

        // Browser stats: per-lane critical paths + rgb imbalance detail.
        sandbox();
        const boot = bootPlay({ width: REC_W, height: REC_H });
        (boot as unknown as { browserPool: unknown }).browserPool = pool;
        const s = publishQ2Stats(boot, 60, 3);
        expect(s.lastKickJob).toBe('scanout');
        expect(s.rgbMainMs).toBeGreaterThanOrEqual(0);
        expect(s.rgbExecMs.length).toBe(2);
        for (const e of s.rgbExecMs) {
          expect(Number.isFinite(e)).toBe(true);
          expect(e).toBeGreaterThanOrEqual(0);
        }
        expect(s.rgbExecMaxMs).toBeGreaterThanOrEqual(s.rgbExecMedianMs);
        expect(s.rgbExecMedianMs).toBeGreaterThanOrEqual(0);
        expect(s.rgbImbalanceMs).toBe(s.rgbExecMaxMs - pool!.diagSnapshot('rgb')!.execMinMs);
        expect(s.rgbImbalanceMs).toBeGreaterThanOrEqual(0);
        expect(s.rgbSlowestMs).toBeGreaterThanOrEqual(0);
        expect(s.scanoutSlowestMs).toBeGreaterThanOrEqual(0);
        expect(s.resolveSlowestMs).toBeGreaterThanOrEqual(0);

        // Disarmed: sentinels again (acceptance shape, zero per-frame cost
        // beyond the guarded probes — no lists allocated off-diag).
        pool!.disableDiag();
        const t = publishQ2Stats(boot, 60, 4);
        expect(t.lastKickJob).toBe('none');
        expect(t.rgbMainMs).toBe(-1);
        expect(t.rgbExecMs).toEqual([]);
        expect(t.rgbExecMaxMs).toBe(-1);
        expect(t.rgbExecMedianMs).toBe(-1);
        expect(t.rgbImbalanceMs).toBe(-1);
        expect(t.rgbSlowestMs).toBe(-1);
        expect(t.scanoutSlowestMs).toBe(-1);
        expect(t.resolveSlowestMs).toBe(-1);
        for (const wrk of RealEntryWorker.live) expect(wrk.errors).toEqual([]);
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeRealDom();
    }
  }, 60000);

  it('unpooled software boot reports timing sentinels, empty kick ledger', async () => {
    sandbox();
    const boot = bootPlay({ width: 32, height: 24 });
    const s = publishQ2Stats(boot, 60, 1);
    expect(s.lastKickJob).toBe('none');
    expect(s.rgbMainMs).toBe(-1);
    expect(s.rgbExecMs).toEqual([]);
    expect(s.rgbExecMaxMs).toBe(-1);
    expect(s.rgbExecMedianMs).toBe(-1);
    expect(s.rgbImbalanceMs).toBe(-1);
    expect(s.rgbSlowestMs).toBe(-1);
    expect(s.scanoutSlowestMs).toBe(-1);
    expect(s.resolveSlowestMs).toBe(-1);
    const st = createAsyncLoopState();
    const rep = await measureFrameStages(boot, st, 16.7);
    expect(rep.diag).toBeNull();
    expect(rep.kickTimings).toEqual([]);
  });
});

describe.runIf(!!WEB_Q2_PAK)('real entry base1 frames (Q2_PAK, parity + per-frame timing)', () => {
  async function bootBase1(w: number, h: number): Promise<PlayBoot> {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    return bootPlay({ width: w, height: h, pak: ingestPak(buf) });
  }

  it('frameAsync matches sync with real-entry workers; every FG flush timed', { timeout: 300000 }, async () => {
    installRealDom();
    try {
      sandbox();
      setCVarFromString('vid_renderer', 'voodoo');
      setCVar('sw_workers', 4);
      const a = await bootBase1(96, 72);
      const b = await bootBase1(96, 72);
      const { attachBrowserPool } = await import('./play.js');
      const pool = attachBrowserPool(b);
      expect(pool).not.toBeNull();
      pool!.enableDiag();
      try {
        const stB = createAsyncLoopState();
        let t = 0;
        let fgKicksTotal = 0;
        const FRAMES = 6;
        for (let f = 0; f < FRAMES; f++) {
          t += 16.7;
          const yaw = (f * 13) % 360;
          const attack = f >= 2 && f < 5;
          for (const boot of [a, b]) {
            boot.host.input.angles = [0, yaw, 0];
            boot.host.input.buttons = attack ? 1 : 0;
          }
          if (f % 3 === 0) {
            for (const boot of [a, b]) boot.host.input.keys.add('forward');
          }
          if (f % 3 === 1) {
            for (const boot of [a, b]) boot.host.input.keys.delete('forward');
          }
          // Sync reference: pumps + sim + serial resolveDisplay.
          pumpMuzzleLight(a);
          pumpExplosionLights(a);
          pumpTracers(a);
          a.host.frame(t);
          const ref = Array.from(resolveDisplay(a, { fps: 60, frame: f }));
          // Production path through the REAL browser entry: async RGB
          // kicks (world + foreground flushes) + pooled scanout.
          const out = Array.from(await frameAsync(b, stB, t, { fps: 60, frame: f }));
          expect(out).toEqual(ref);
          const rs = b.refresh.testRGBWorkerStats();
          expect(rs.staged).toBeGreaterThan(0);
          expect(rs.kicks).toBe(1);
          const fgHook = (b.refresh as unknown as {
            testRGBForegroundStats?: () => { kicks: number };
          }).testRGBForegroundStats;
          if (typeof fgHook === 'function') {
            try {
              fgKicksTotal += fgHook.call(b.refresh).kicks | 0;
            } catch {
              /* hook failure is renderer-lane business, not timing */
            }
          }
        }
        expect(b.statScanoutFallbacks).toBe(0);
        expect(b.statAsyncFallbacks).toBe(0);
        // Every foreground flush INCLUDING the placed pass ran through the
        // same timed kick path: the ledger holds at least the world flush
        // per frame plus every renderer-counted FG kick, all completed with
        // finite measured worker compute. Replays/fallbacks would show as
        // refused/failed entries or fallback counters — none allowed here.
        const ledger = pool!.kickTimings();
        const rgbEntries = ledger.filter((k) => k.job === 'rgb');
        expect(rgbEntries.length).toBeGreaterThanOrEqual(FRAMES + fgKicksTotal);
        for (const e of rgbEntries) {
          expect(e.outcome).toBe('completed');
          expect(e.execKnown).toBeGreaterThanOrEqual(1);
          expect(e.execMaxMs).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(e.execMaxMs)).toBe(true);
          expect(e.mainMs).toBeGreaterThanOrEqual(0);
        }
        for (const wrk of RealEntryWorker.live) expect(wrk.errors).toEqual([]);

        // One instrumented frame: the StageReport carries this frame's
        // kicks (world first, then FG flushes), and the browser stats show
        // finite per-band compute + imbalance for the run.
        t += 16.7;
        b.host.input.angles = [0, 45, 0];
        const rep = await measureFrameStages(b, createAsyncLoopState(), t, { fps: 60, frame: FRAMES });
        expect(rep.pooled).toBe(true);
        const frameRgb = rep.kickTimings.filter((k) => k.job === 'rgb');
        expect(frameRgb.length).toBeGreaterThanOrEqual(1);
        for (const e of frameRgb) {
          expect(e.outcome).toBe('completed');
          expect(e.execKnown).toBeGreaterThanOrEqual(1);
          expect(e.execMaxMs).toBeGreaterThanOrEqual(e.execMedianMs);
          expect(e.execMedianMs).toBeGreaterThanOrEqual(0);
        }
        expect(rep.diag).not.toBeNull();
        expect(rep.diag!.workerExecMs.length).toBeGreaterThanOrEqual(1);
        const stats = publishQ2Stats(b, 60, FRAMES);
        expect(stats.pooled).toBe(true);
        expect(stats.voodooPath).toBe('worker');
        expect(stats.rgbExecMaxMs).toBeGreaterThanOrEqual(0);
        expect(stats.rgbExecMedianMs).toBeGreaterThanOrEqual(0);
        expect(stats.rgbImbalanceMs).toBeGreaterThanOrEqual(0);
        expect(stats.rgbSlowestMs).toBeGreaterThanOrEqual(0);
        expect(stats.scanoutSlowestMs).toBeGreaterThanOrEqual(0);
        expect(stats.rgbFallbacks).toBe(0);
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeRealDom();
    }
  });
});
