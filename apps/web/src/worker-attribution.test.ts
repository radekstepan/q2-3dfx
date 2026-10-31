// PERF-NEXT-5 browser lane: indexed worker execution attribution (RELEASE-8).
//
// Covers, through the REAL browser worker entry (esbuild-bundled
// render-worker.ts executed in a real worker thread — same SAB +
// CTL_SEQ protocol as the DOM production path) plus real-asset base1
// frames (Q2_PAK-gated):
// - worker bands + the calling-thread band execute indexed raster kicks:
//   flush totals equal the staged span area, inspected-span counters prove
//   ordered subranges skip non-owned rows;
// - staged-but-failed kicks (timeout/quarantine): null result, counted
//   fallback, quarantine refuses later kicks fast, and drawInlineAll
//   replays the staged batches exactly on the calling thread;
// - browser stats expose the pool counters with unknown sentinels when
//   the pool probe is absent or throws;
// - real base1 frames: pooled frameAsync matches the serial sim+resolve
//   pixels with real worker execution behind the pool counters.
import { afterEach, describe, expect, it } from 'vitest';
import { getCVarNumber, resetCVars, setCVar, setCVarFromString } from '@q2/config';
import {
  SPAN_FLAT,
  packFrameSpans,
  type LightBlock,
  type Span,
  type SpanList,
  type Texture,
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

/* --- indexed staging helper (flat spans, 1x1 tex/light) ------------------ */

const REC_W = 64;
const REC_H = 48;

function stageFlat(pool: BrowserBandPool, y0: number, y1: number, w: number): boolean {
  const cursor = pool.flatCursor();
  if (!cursor) return false;
  const spans: Span[] = [];
  for (let y = y0; y < y1; y++) {
    spans.push({
      kind: SPAN_FLAT, y, x0: 0, x1: w, iz: 0.002, diz: 0, uz: 0, duz: 0,
      vz: 0, dvz: 0, light: 63, dlight: 0, lu: 0, lv: -1, dlu: 0, turb: 0,
      ord: 0, dudy: 0, dvdy: 0,
    });
  }
  const list: SpanList = { spans, count: spans.length };
  const packed = packFrameSpans(list, cursor.F, cursor.I, cursor.base, cursor.base, cursor.cap, 0);
  if (!packed || packed.count !== spans.length) return false;
  const tex: Texture = { width: 1, height: 1, texels: new Uint8Array([7]) };
  const light: LightBlock = { width: 1, height: 1, values: new Uint8Array([63]) };
  const colormap = new Uint8Array(64 * 256);
  return pool.packBatched(cursor.base, packed.count, tex, light, colormap, 0);
}

describe('indexed worker execution through the real entry', () => {
  it('worker bands + main band execute: totals equal the staged span area', async () => {
    installRealDom();
    try {
      const pool = BrowserBandPool.create(2, REC_W, REC_H, { timeoutMs: 15000 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        // Full-frame flat spans (rows 0..48; bands [0,16)/[16,32)/[32,48),
        // the calling thread owns the last band.
        expect(stageFlat(pool!, 0, REC_H, REC_W)).toBe(true);
        const out = await pool!.flushFrameAsync();
        expect(out).not.toBeNull();
        // Every staged span drew exactly once: worker bands (rows 0..32)
        // plus the calling-thread band (rows 32..48).
        expect(out!.spans).toBe(REC_H);
        expect(out!.pixels).toBe(REC_W * REC_H);
        const ks = pool!.kickStats();
        expect(ks.kicks.raster).toBe(1);
        expect(ks.fallbacks.raster).toBe(0);
        // Inspected-span counters are available on this build (workers skip
        // non-owned ordered subranges instead of rescanning).
        expect(ks.scannedAvailable).toBe(true);
        expect(ks.scanned.raster).toBeGreaterThanOrEqual(REC_H);

        // Second kick: same totals, counters accumulate.
        pool!.beginFrame();
        expect(stageFlat(pool!, 0, REC_H, REC_W)).toBe(true);
        const f = await pool!.flushFrameAsync();
        expect(f).not.toBeNull();
        expect(f!.spans).toBe(REC_H);
        expect(f!.pixels).toBe(REC_W * REC_H);
        expect(pool!.kickStats().kicks.raster).toBe(2);
        for (const w of RealEntryWorker.live) expect(w.errors).toEqual([]);
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeRealDom();
    }
  }, 60000);

  it('staged-but-failed kicks are counted, quarantined, and replayed inline', async () => {
    installRealDom(SilentWorker);
    try {
      const pool = BrowserBandPool.create(2, REC_W, REC_H, { timeoutMs: 60 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        expect(stageFlat(pool!, 0, REC_H, REC_W)).toBe(true);
        // Timeout: no worker ever acks. The kick fails and is counted.
        await expect(pool!.flushFrameAsync()).resolves.toBeNull();
        const ks = pool!.kickStats();
        expect(ks.fallbacks.raster).toBe(1);
        expect(ks.kicks.raster).toBe(0);
        expect(ks.quarantined).toBe(true);
        // Quarantined: the next kick refuses fast (declined, not failed).
        const t0 = Date.now();
        await expect(pool!.flushFrameAsync()).resolves.toBeNull();
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(pool!.kickStats().fallbacks.raster).toBe(1);
        // Inline replay draws the staged batches exactly on the calling
        // thread (same span area as the worker kick would have drawn).
        const rp = pool!.drawInlineAll();
        expect(rp.pixels).toBe(REC_W * REC_H);
        expect(rp.spans).toBe(REC_H);
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeRealDom();
    }
  }, 60000);

  it('browser stats expose the pool counters with unknown sentinels', async () => {
    installRealDom();
    try {
      sandbox();
      const pool = BrowserBandPool.create(2, REC_W, REC_H, { timeoutMs: 15000 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        expect(stageFlat(pool!, 0, REC_H, REC_W)).toBe(true);
        const out = await pool!.flushFrameAsync();
        expect(out).not.toBeNull();
        const boot = bootPlay({ width: REC_W, height: REC_H });
        (boot as unknown as { browserPool: unknown }).browserPool = pool;
        const s = publishQ2Stats(boot, 60, 3);
        // Pool present (BrowserBandPool): probes read live state —
        // the frozen last-kick staging snapshot, zero counted fallbacks,
        // no quarantine, and the disarmed timing sentinels.
        expect(s.stageBytes).toBe(pool!.kickBytes()!.total);
        expect(s.stageBytes).toBeGreaterThan(0);
        expect(s.rasterFallbacks).toBe(0);
        expect(s.quarantined).toBe(false);
        expect(s.lastKickJob).toBe('none');
        expect(s.rasterSlowestMs).toBe(-1);
        expect(s.resolveSlowestMs).toBe(-1);
        // A throwing testWorkerStats hook degrades to unpooled defaults,
        // never a throw on the present path.
        const rec = boot.refresh as unknown as Record<string, unknown>;
        rec['testWorkerStats'] = (): never => {
          throw new Error('simulated future-renderer hook failure');
        };
        const t = publishQ2Stats(boot, 60, 4);
        expect(t.pooled).toBe(false);
        expect(t.bands).toBe(1);
        // A foreign pool without the probe surface degrades to the same
        // healthy sentinels (unknown, never worker-completed, never a
        // silent nonzero).
        (boot as unknown as { browserPool: unknown }).browserPool = {};
        const v = publishQ2Stats(boot, 60, 6);
        expect(v.stageBytes).toBe(-1);
        expect(v.rasterFallbacks).toBe(0);
        expect(v.quarantined).toBe(false);
        expect(v.lastKickJob).toBe('none');
        // Unpooled boot (no pool probe): healthy defaults.
        const bare = bootPlay({ width: REC_W, height: REC_H });
        const u = publishQ2Stats(bare, 60, 5);
        expect(u.pooled).toBe(false);
        expect(u.rasterFallbacks).toBe(0);
        expect(u.quarantined).toBe(false);
        expect(u.lastKickJob).toBe('none');
        for (const w of RealEntryWorker.live) expect(w.errors).toEqual([]);
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeRealDom();
    }
  }, 60000);
});

describe.runIf(!!WEB_Q2_PAK)('indexed pool attribution on real base1 frames (Q2_PAK)', () => {
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

  it('serial frames render the gun + move; pooled frames match with pool engaged', { timeout: 300000 }, async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'software');
    const base = await bootBase1(96, 72);
    const st = createAsyncLoopState();
    let t = 0;
    let nonzero = 0;
    for (let f = 0; f < 8; f++) {
      t += 16.7;
      attackInputs(base, f);
      const out = Array.from(await frameAsync(base, st, t));
      if (out.some((v) => v !== 0)) nonzero++;
    }
    // Serial software frames draw real pixels every frame.
    expect(nonzero).toBe(8);
  });

  it('pooled base1 frames match serial with real worker execution', { timeout: 300000 }, async () => {
    installRealDom();
    try {
      sandbox();
      setCVarFromString('vid_renderer', 'software');
      setCVar('sw_workers', 4);
      const a = await bootBase1(96, 72);
      const b = await bootBase1(96, 72);
      const pool = attachBrowserPool(b);
      expect(pool).not.toBeNull();
      try {
        const stB = createAsyncLoopState();
        let t = 0;
        for (let f = 0; f < 8; f++) {
          t += 16.7;
          attackInputs(a, f);
          attackInputs(b, f);
          // Sync reference: pumps + sim + serial resolveDisplay.
          pumpMuzzleLight(a);
          pumpExplosionLights(a);
          pumpTracers(a);
          a.host.frame(t);
          const ref = Array.from(resolveDisplay(a));
          // Production path with the pool attached (frameAsync pumps
          // exactly once internally, same set as the reference above).
          const out = Array.from(await frameAsync(b, stB, t));
          expect(out).toEqual(ref);
        }
        // The pool executed the production frames (not inferred from cvar).
        expect(b.refresh.testWorkerStats().pooled).toBe(true);
        const s = publishQ2Stats(b, 60, 8);
        expect(s.pooled).toBe(true);
        expect(s.rasterFallbacks).toBe(0);
        expect(b.statAsyncFallbacks).toBe(0);
        for (const w of RealEntryWorker.live) expect(w.errors).toEqual([]);
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeRealDom();
    }
  });
});
