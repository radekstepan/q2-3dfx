// PERF-FINISH-B browser lane: pool diagnostics, extended __q2stats,
// instrumented stage frames.
//
// - Pool kick diagnostics are instrumented-only (disarmed by default: one
//   boolean check per kick/message, zero steady-state allocation) and
//   headless-coverable through a fake in-thread Worker (same SAB +
//   CTL_SEQ protocol the real DOM workers speak, including the band-
//   attributed completion message `{ seq, band, pixels, spans }`).
// - `measureFrameStages` is the instrumented twin of `frameAsync`
//   (production tick never calls it): pixel parity + sane counters here.
// - `publishQ2Stats` extensions (bands/spans/pixels/pending/stageBytes,
//   fgInline -1 until the renderer publishes a foreground counter).
import { afterEach, describe, expect, it } from 'vitest';
import { getCVarNumber, resetCVars, setCVar, setCVarFromString } from '@q2/config';
import {
  attachFrameAccum,
  attachRGBAccum,
  BandWorkerPool,
  CTL_JOB,
  CTL_PIXELS,
  CTL_RGBCOUNT,
  CTL_SCAN,
  CTL_SEQ,
  CTL_SPANS,
  CTL_TRIS,
  JOB_RGB,
  MAX_RGB_BATCHES,
  processRGBFrameJob,
  R_FLAG_BLEND_ALPHA,
  R_FLAG_DEPTHWRITE,
  R_FLAG_FLAT,
  SPAN_FLAT,
  SPAN_TRANS33,
  type RGBAccumViews,
  type RGBMipLevel,
  type Span,
  type SpanList,
} from '@q2/sw-renderer';
import { BrowserBandPool } from './render-workers.js';
import { installBenchHook } from './index.js';
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

/* --- fake in-thread DOM Worker (same SAB/CTL_SEQ protocol) -------------- */

interface FakeMsg {
  sab?: SharedArrayBuffer;
  w?: number;
  h?: number;
  y0?: number;
  y1?: number;
  seq?: number;
  ready?: boolean;
  band?: number;
  pixels?: number;
  spans?: number;
  /** Worker-local compute duration for the kick (durations need no clock sync). */
  execMs?: number;
}

/** Minimal DOM-Worker stand-in: ready-acks init, completion-acks kicks by
 * polling the shared CTL_SEQ (never does band work — control flow only,
 * never pixel assertions). The completion ack mirrors the real worker-loop
 * message shape (`{ seq, band, pixels, spans }`, honest zero tallies) so
 * diag band attribution is covered, not just rank order. */
class FakeWorker {
  onmessage: ((ev: { data: FakeMsg }) => void) | null = null;
  private ctl: Int32Array | null = null;
  private band = -1;
  private lastSeq = -1;
  private done = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  postMessage(msg: FakeMsg): void {
    if (msg.sab && typeof msg.w === 'number' && typeof msg.h === 'number') {
      this.ctl = attachFrameAccum(msg.sab, msg.w, msg.h).ctl;
      if (typeof msg.band === 'number') this.band = msg.band;
      const self = this;
      setTimeout(() => {
        if (!self.done) self.onmessage?.({ data: { ready: true } });
      }, 0);
      this.timer = setInterval(() => {
        if (self.done || !self.ctl) return;
        const seq = Atomics.load(self.ctl, CTL_SEQ);
        if (seq !== self.lastSeq && seq > 0) {
          self.lastSeq = seq;
          const s = seq;
          const b = self.band;
          setTimeout(() => {
            if (!self.done) self.onmessage?.({ data: { seq: s, band: b, pixels: 0, spans: 0 } });
          }, 3);
        }
      }, 2);
    }
  }
  terminate(): void {
    this.done = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Never-acking variant (ready only): kicks hang until dispose/timeout. */
class SilentWorker extends FakeWorker {
  override postMessage(msg: FakeMsg): void {
    if (msg.sab) {
      const self = this;
      setTimeout(() => {
        self.onmessage?.({ data: { ready: true } });
      }, 0);
    }
  }
}

const G = globalThis as unknown as Record<string, unknown>;
const REAL = { window: G['window'], document: G['document'], Worker: G['Worker'] };

function installFakeDom(worker: new () => FakeWorker = FakeWorker): void {
  G['window'] = {
    setTimeout: setTimeout.bind(globalThis),
    clearTimeout: clearTimeout.bind(globalThis),
  };
  G['document'] = {};
  G['Worker'] = worker;
}

function removeFakeDom(): void {
  if (REAL.window === undefined) delete G['window'];
  else G['window'] = REAL.window;
  if (REAL.document === undefined) delete G['document'];
  else G['document'] = REAL.document;
  if (REAL.Worker === undefined) delete G['Worker'];
  else G['Worker'] = REAL.Worker;
}

function emptySpans(): SpanList {
  return { spans: [], count: 0 } as unknown as SpanList;
}

function tinyChain(): RGBMipLevel[] {
  return [{
    data: new Uint8Array(4 * 4 * 3).fill(7),
    width: 4, height: 4,
    mask: new Uint8Array(4 * 4).fill(255),
  }];
}

describe('BrowserBandPool kick diagnostics (instrumented-only)', () => {
  it('diag disarmed by default: no timing state, null snapshot', () => {
    installFakeDom();
    try {
      const pool = BrowserBandPool.create(2, 64, 48);
      expect(pool).not.toBeNull();
      try {
        expect(pool!.diagActive()).toBe(false);
        expect(pool!.diagSnapshot()).toBeNull();
        const bytes = pool!.stagingBytes();
        expect(bytes).toEqual({
          idxSpans: 0, idxTex: 0, idxLight: 0, idxDescs: 0,
          rgbSpans: 0, rgbChains: 0, rgbLux: 0, rgbDescs: 0,
          total: 0,
        });
      } finally {
        void pool!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });

  it('stagingBytes counts RGB chain bytes after a zero-span stage', () => {
    installFakeDom();
    try {
      const pool = BrowserBandPool.create(2, 64, 48);
      expect(pool).not.toBeNull();
      try {
        // No kick yet: frozen snapshot is null, live view counts staging.
        expect(pool!.kickBytes()).toBeNull();
        pool!.beginFrame();
        expect(pool!.stageRGB(emptySpans(), 0, 0, tinyChain(), null, 0, 0, 0, 16, 0, 0)).toBe(true);
        const bytes = pool!.stagingBytes();
        // 4x4 RGB triplets + 4x4 mask, exact bump bytes; no spans staged.
        expect(bytes.rgbDescs).toBe(1);
        expect(bytes.rgbChains).toBe(4 * 4 * 3 + 4 * 4);
        expect(bytes.rgbSpans).toBe(0);
        expect(bytes.total).toBe(bytes.rgbChains);
        expect(pool!.rgbPending()).toBe(1);
      } finally {
        void pool!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });

  it('armed diag records rank-ordered worker arrivals + main-band work', async () => {
    installFakeDom();
    try {
      const pool = BrowserBandPool.create(2, 64, 48);
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        expect(pool!.stageRGB(emptySpans(), 0, 0, tinyChain(), null, 0, 0, 0, 16, 0, 0)).toBe(true);
        pool!.enableDiag();
        expect(pool!.diagActive()).toBe(true);
        const out = await pool!.flushRGBFrameAsync(1, 1000, 0);
        expect(out).not.toBeNull();
        // The RGB kick succeeded: counted, not silent.
        expect(pool!.kickStats().kicks.rgb).toBe(1);
        expect(pool!.kickStats().fallbacks.rgb).toBe(0);
        expect(pool!.kickStats().quarantined).toBe(false);
        // Zero-span staged batch: nothing inspected anywhere (0 observed in
        // both worlds — the stale-dist slot probe stays off, the main band
        // drew no rows).
        expect(pool!.kickStats().scanned.rgb).toBe(0);
        const snap = pool!.diagSnapshot();
        expect(snap).not.toBeNull();
        // Two fake workers acked: two rank-ordered arrivals, main-band timed.
        expect(snap!.arrivals.length).toBe(2);
        expect(snap!.arrivals[0]!).toBeGreaterThanOrEqual(0);
        expect(snap!.arrivals[1]!).toBeGreaterThanOrEqual(snap!.arrivals[0]!);
        expect(snap!.slowestMs).toBe(snap!.arrivals[1]);
        expect(snap!.mainMs).toBeGreaterThanOrEqual(0);
        expect(snap!.kicks).toBe(1);
        // Kick identity: frame generation + message sequence + job kind +
        // band count (2 workers + the main-thread band), all same-clock.
        expect(snap!.job).toBe('rgb');
        expect(snap!.frame).toBeGreaterThanOrEqual(1);
        expect(snap!.seq).toBeGreaterThanOrEqual(1);
        expect(snap!.bands).toBe(3);
        // Band attribution from the completion messages (arrival order may
        // vary — both worker bands reported exactly once).
        expect([...snap!.bandIds].sort((a, b) => a - b)).toEqual([0, 1]);
        expect(snap!.pixels.length).toBe(2);
        expect(snap!.spans.length).toBe(2);
        // Frozen last-kick snapshot survives the post-kick offset reset:
        // live descs read drained (0), the snapshot keeps the kick (1).
        // (Chains persist by design — copy-on-first-use — so totals agree.)
        const kb = pool!.kickBytes();
        expect(kb).not.toBeNull();
        expect(kb!.rgbDescs).toBe(1);
        expect(kb!.rgbChains).toBe(4 * 4 * 3 + 4 * 4);
        // Retained-frame protocol: success advances flushed, descriptors
        // persist until commitRGB (frame end). Unapplied suffix is empty.
        expect(pool!.stagingBytes().rgbDescs).toBe(1);
        expect(pool!.rgbPending()).toBe(1);
        expect(pool!.rgbFlushed()).toBe(1);
        pool!.commitRGB();
        expect(pool!.rgbPending()).toBe(0);
        pool!.disableDiag();
        expect(pool!.diagActive()).toBe(false);
        expect(pool!.diagSnapshot()).toBeNull();
      } finally {
        void pool!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });

  it('empty RGB flush elides the kick: zero result, no dispatch, no checkpoint', async () => {
    installFakeDom();
    try {
      const pool = BrowserBandPool.create(2, 64, 48, { timeoutMs: 5000 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        pool!.enableDiag();
        // Nothing staged (the empty FG-suffix shape): the fast path returns
        // the zero result WITHOUT dispatch — no CTL_SEQ kick, no worker
        // fan-out, no per-kick checkpoint copy on the main thread, no ledger
        // entry. PERF-NEXT-6 Lane B barrier audit: an empty foreground flush
        // costs two integer compares, never a dispatch round-trip.
        const out = await pool!.flushRGBFrameAsync(1, 1000, 0);
        expect(out).toEqual({
          pixels: 0, spans: 0, scanned: 0, tris: 0,
          workerPixels: 0, workerSpans: 0, workerTris: 0,
          mainPixels: 0, mainSpans: 0, mainTris: 0,
        });
        const ks = pool!.kickStats();
        expect(ks.kicks.rgb).toBe(0);
        expect(ks.fallbacks.rgb).toBe(0);
        expect(ks.quarantined).toBe(false);
        // No dispatch means no barrier was paid: the per-kick ledger and
        // the frozen last-kick snapshot stay empty.
        expect(pool!.kickTimings()).toEqual([]);
        expect(pool!.diagSnapshot()).toBeNull();
        // No checkpoint allocated or copied (5 B/px x 64 x 48 = 15360 B on
        // a real kick): zero main-thread copy bytes on the empty path.
        const st = pool!.checkpointStats();
        expect(st.allocs).toBe(0);
        expect(st.snapshots).toBe(0);
        expect(st.copiedBytes).toBe(0);
        expect(pool!.rgbPending()).toBe(0);
        expect(pool!.lastRGBFailure()).toBeNull();
        pool!.disableDiag();
      } finally {
        void pool!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });

  it('kick timeout quarantines the pool: fails counted, later kicks refuse fast', async () => {
    installFakeDom(SilentWorker);
    try {
      const pool = BrowserBandPool.create(2, 64, 48, { timeoutMs: 60 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        expect(pool!.stageRGB(emptySpans(), 0, 0, tinyChain(), null, 0, 0, 0, 16, 0, 0)).toBe(true);
        // No worker ever acks: the kick times out, terminates the wedged
        // workers BEFORE the inline replay (no straggler write can race
        // it), and counts the failure — never silent.
        const t0 = Date.now();
        await expect(pool!.flushRGBFrameAsync(1, 1000, 0)).resolves.toBeNull();
        expect(Date.now() - t0).toBeLessThan(20000);
        const ks = pool!.kickStats();
        expect(ks.fallbacks.rgb).toBe(1);
        expect(ks.kicks.rgb).toBe(0);
        expect(ks.quarantined).toBe(true);
        // Quarantined: the next kick refuses fast (no second 60s hang for
        // the production loop to absorb).
        const t1 = Date.now();
        await expect(pool!.flushRGBFrameAsync(1, 1000, 0)).resolves.toBeNull();
        expect(Date.now() - t1).toBeLessThan(2000);
      } finally {
        void pool!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });

  it('dispose resolves an in-flight kick immediately (no timeout hang)', async () => {
    installFakeDom(SilentWorker);
    try {
      const pool = BrowserBandPool.create(2, 64, 48, { timeoutMs: 5000 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        expect(pool!.stageRGB(emptySpans(), 0, 0, tinyChain(), null, 0, 0, 0, 16, 0, 0)).toBe(true);
        const t0 = Date.now();
        const pending = pool!.flushRGBFrameAsync(1, 1000, 0);
        await pool!.dispose();
        // Dispose aborts the kick: the waiter resolves false → inline
        // fallback (null), far inside the 5s kick timeout.
        await expect(pending).resolves.toBeNull();
        expect(Date.now() - t0).toBeLessThan(2000);
      } finally {
        void pool!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });
});

describe('publishQ2Stats extensions (bands/spans/staging/fg)', () => {
  /** Expected fgInline for this boot: the skip hook's value, or -1 absent. */
  function expectedFg(boot: PlayBoot): number {
    const hook = (boot.refresh as unknown as {
      testClassicSkipStats?: () => { classicFgSkipped: number };
    }).testClassicSkipStats;
    return typeof hook === 'function' ? hook.call(boot.refresh).classicFgSkipped : -1;
  }

  it('unpooled software boot reports unit defaults + skip-hook fg value', () => {
    sandbox();
    setCVarFromString('vid_renderer', 'software');
    const boot = bootPlay({ width: 32, height: 24 });
    const s = publishQ2Stats(boot, 60, 3);
    expect(s.bands).toBe(1);
    expect(s.poolSpans).toBe(0);
    expect(s.poolPixels).toBe(0);
    expect(s.rgbPending).toBe(0);
    expect(s.stageBytes).toBe(-1);
    expect(s.rgbFallbacks).toBe(0);
    expect(s.quarantined).toBe(false);
    // Foreground counter comes from the renderer's skip hook when present
    // (classicFgSkipped, 0 with the skip disarmed), -1 on older renderers
    // — the shell never guesses.
    expect(s.fgInline).toBe(expectedFg(boot));
    // Foreground worker hook is always present on this renderer build
    // (testForegroundWorkerStats): unpooled software stages nothing, so
    // staged/worker/inline/kicks are healthy zeros — the shell never guesses.
    expect(s.fgStaged).toBe(0);
    expect(s.fgWorker).toBe(0);
    expect(s.fgInlineRgb).toBe(0);
    expect(s.fgKicks).toBe(0);
    expect(s.classicSkipped).toBe(0);
    expect(s.skipArmed).toBe(false);
  });

  it('foreground RGB hook surfaces when present, -1 when throwing', () => {
    sandbox();
    setCVarFromString('vid_renderer', 'voodoo');
    const boot = bootPlay({ width: 32, height: 24 });
    const rec = boot.refresh as unknown as Record<string, unknown>;
    rec['testRGBForegroundStats'] = () => ({
      staged: 12, worker: 10, inline: 2, kicks: 1,
    });
    const s = publishQ2Stats(boot, 60, 3);
    expect(s.fgStaged).toBe(12);
    expect(s.fgWorker).toBe(10);
    expect(s.fgInlineRgb).toBe(2);
    expect(s.fgKicks).toBe(1);
    // A throwing future hook degrades to the absent sentinel, never a
    // broken present path.
    rec['testRGBForegroundStats'] = (): never => {
      throw new Error('simulated future-renderer hook failure');
    };
    const t = publishQ2Stats(boot, 60, 4);
    expect(t.fgStaged).toBe(-1);
    expect(t.fgWorker).toBe(-1);
    expect(t.fgInlineRgb).toBe(-1);
    expect(t.fgKicks).toBe(-1);
  });

  it('pool RGB fallback counts + quarantine surface through __q2stats', () => {
    sandbox();
    const boot = bootPlay({ width: 32, height: 24 });
    (boot as unknown as Record<string, unknown>).browserPool = {
      rgbPending: () => 0,
      kickBytes: () => null,
      kickStats: () => ({
        kicks: { raster: 1, rgb: 2, resolve: 0, scanout: 0 },
        fallbacks: { raster: 0, rgb: 1, resolve: 0, scanout: 0 },
        quarantined: true,
      }),
    };
    const s = publishQ2Stats(boot, 60, 3);
    expect(s.rgbFallbacks).toBe(1);
    expect(s.quarantined).toBe(true);
    // A foreign/older pool without kickStats degrades to healthy zeros.
    (boot as unknown as Record<string, unknown>).browserPool = {
      rgbPending: () => 0,
    };
    const t = publishQ2Stats(boot, 60, 4);
    expect(t.rgbFallbacks).toBe(0);
    expect(t.quarantined).toBe(false);
  });

  it('throws-safe when all probes throw (never breaks the present path)', () => {
    sandbox();
    const boot = bootPlay({ width: 32, height: 24 });
    const rec = boot.refresh as unknown as Record<string, unknown>;
    rec['testWorkerStats'] = (): never => {
      throw new Error('simulated future-renderer hook failure');
    };
    rec['testClassicSkipStats'] = (): never => {
      throw new Error('simulated future-renderer hook failure');
    };
    rec['testRGBForegroundStats'] = (): never => {
      throw new Error('simulated future-renderer hook failure');
    };
    const s = publishQ2Stats(boot, 60, 3);
    expect(s.bands).toBe(1);
    expect(s.poolSpans).toBe(0);
    expect(s.rgbStaged).toBe(0);
    expect(s.fgInline).toBe(-1);
    expect(s.fgStaged).toBe(-1);
    expect(s.fgWorker).toBe(-1);
    expect(s.fgInlineRgb).toBe(-1);
    expect(s.fgKicks).toBe(-1);
    expect(s.rgbFallbacks).toBe(0);
    expect(s.quarantined).toBe(false);
    expect(s.classicSkipped).toBe(0);
    expect(s.skipArmed).toBe(false);
  });
});

const WEB_Q2_PAK = process.env.Q2_PAK;

describe.runIf(!!WEB_Q2_PAK)('base1 640x480 web-layer stage table (Q2_PAK, report-only)', () => {
  async function bootBase1(): Promise<PlayBoot> {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    return bootPlay({ width: 640, height: 480, pak: ingestPak(buf) });
  }

  /** Skip-hook presence on this renderer build (PERF-FINISH-A or older). */
  function hasSkipHook(boot: PlayBoot): boolean {
    return typeof (boot.refresh as unknown as {
      testClassicSkipStats?: unknown;
    }).testClassicSkipStats === 'function';
  }

  it('pooled RGB frame: execution proof, staging, zero fallbacks', { timeout: 300000 }, async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'voodoo');
    setCVar('sw_workers', 8);
    const { BandWorkerPool } = await import('@q2/sw-renderer');
    const dist = new URL('../../../packages/sw-renderer/dist/index.mjs', import.meta.url).pathname;
    const boot = await bootBase1();
    const pool = BandWorkerPool.create(7, 640, 480, { indexJsPath: dist });
    if (!pool) throw new Error('node pool unavailable');
    try {
      boot.refresh.attachWorkerPool(pool as unknown as never);
      (boot as unknown as Record<string, unknown>).browserPool = pool;
      const sp = pool.scanoutPlanes;
      boot.fb565 = sp.scan565;
      boot.display = sp.scanDisplay;
      const st = createAsyncLoopState();
      let t = 0;
      const rows: string[] = [];
      for (let f = 0; f < 6; f++) {
        t += 16.7;
        boot.host.input.angles = [0, (f * 13) % 360, 0];
        const rep = await measureFrameStages(boot, st, t, { fps: 60, frame: f });
        rows.push(
          `f${f} render=${rep.renderMs.toFixed(1)} (internal ${rep.renderInternalMs.toFixed(1)}) ` +
          `end=${rep.endMs.toFixed(1)} resolve=${rep.resolveMs.toFixed(1)} ` +
          `spans=${rep.spans} px=${rep.pixels} od=${rep.overdraw.toFixed(2)} ` +
          `staged=${rep.staged} inline=${rep.inline} kicks=${rep.kicks} ` +
          `scanout=${rep.scanoutKicks}/+${rep.scanoutFallbacks} path=${rep.voodooPath}` +
          (rep.skip ? ` skip=${rep.skip.armed ? 'on' : 'off'}:${rep.skip.classicSkipped}+fg${rep.skip.classicFgSkipped}` : ' skip=n/a') +
          (rep.stageDetail ? ` up=${rep.stageDetail.transientBytes}B cache=${rep.stageDetail.chainBytes}B` : ''),
        );
        expect(rep.pooled).toBe(true);
        expect(rep.bands).toBe(8);
        expect(rep.staged).toBeGreaterThan(0);
        expect(rep.kicks).toBe(1);
        expect(rep.scanoutKicks).toBe(1);
        expect(rep.scanoutFallbacks).toBe(0);
        // Skip-hook contract (PERF-FINISH-A or older): presence matches the
        // renderer build; counts are non-negative either way.
        expect(rep.skip !== null).toBe(hasSkipHook(boot));
        if (rep.skip) {
          expect(rep.skip.classicSkipped).toBeGreaterThanOrEqual(0);
          expect(rep.skip.classicFgSkipped).toBeGreaterThanOrEqual(0);
        }
      }
      console.log(`[web-stage] base1 640x480 pooled-7 stationary\n  ${rows.join('\n  ')}`);
      expect(boot.statScanoutFallbacks).toBe(0);
    } finally {
      await pool.dispose();
    }
  });
});

describe('measureFrameStages (instrumented twin of frameAsync)', () => {
  it('pixels identical to frameAsync; counters sane unpooled', async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'software');
    const a = bootPlay({ width: 64, height: 48 });
    const b = bootPlay({ width: 64, height: 48 });
    const stA = createAsyncLoopState();
    const stB = createAsyncLoopState();
    let t = 0;
    for (let f = 0; f < 10; f++) {
      t += 16.7;
      const yaw = (f * 13) % 360;
      for (const boot of [a, b]) boot.host.input.angles = [0, yaw, 0];
      await frameAsync(a, stA, t);
      const rep = await measureFrameStages(b, stB, t);
      // Identical simulation + render: pixel-identical targets.
      expect(Array.from(b.refresh.getFramebuffer().color))
        .toEqual(Array.from(a.refresh.getFramebuffer().color));
      // Unpooled software: no worker proof, no staging, serial resolve.
      expect(rep.staged).toBe(0);
      expect(rep.kicks).toBe(0);
      expect(rep.pooled).toBe(false);
      expect(rep.bands).toBe(1);
      expect(rep.stageBytes).toBe(-1);
      expect(rep.diag).toBeNull();
      // The foreground worker hook is always present (zeros when nothing
      // stages): staged/worker/inline/kicks 0 is the healthy state. No RGB
      // kick ran, so no RGB fallback. Heap sampling is Chromium-only.
      // No pool, so no inspected-span counters either (-1, not 0).
      expect(rep.fg).toEqual({ staged: 0, worker: 0, inline: 0, kicks: 0 });
      expect(rep.rgbFallbacks).toBe(0);
      expect(rep.scannedSpans).toBe(-1);
      expect(rep.heapDeltaMB === null || typeof rep.heapDeltaMB === 'number').toBe(true);
      expect(rep.voodooPath).toBe('none');
      expect(rep.renderMs).toBeGreaterThanOrEqual(0);
      expect(rep.resolveMs).toBeGreaterThanOrEqual(0);
    }
    expect(b.host.serverTime).toBe(a.host.serverTime);
  });

  it('blit callback times presentation without changing pixels', async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'software');
    const a = bootPlay({ width: 64, height: 48 });
    const b = bootPlay({ width: 64, height: 48 });
    const stA = createAsyncLoopState();
    const stB = createAsyncLoopState();
    const seen: number[] = [];
    await frameAsync(a, stA, 16.7);
    const rep = await measureFrameStages(b, stB, 16.7, undefined, (target) => {
      seen.push(target.length);
    });
    expect(seen).toEqual([64 * 48]);
    expect(rep.blitMs).toBeGreaterThanOrEqual(0);
    expect(Array.from(b.refresh.getFramebuffer().color))
      .toEqual(Array.from(a.refresh.getFramebuffer().color));
  });
});

/* --- RGB foreground recovery: checkpoint/restore + truthful counters ----
 *
 * TASK items 1/3/4 (web side). These tests use an executing fake worker
 * (real processRGBFrameJob writes into the shared SAB, real worker-local
 * execMs durations) so recovery is proven against partial writes — not
 * against control-only stubs that never touch the planes.
 *
 * Recovery design under test (BrowserBandPool, mirroring Node semantics):
 *  (a) staging refusal before dispatch: stageRGB returns false with
 *      pending intact (counted in kickStats().refusals);
 *  (b) failure before any writes: pending intact, no checkpoint needed;
 *  (c) failure after partial execution: the pre-kick checkpoint is
 *      restored (this kick's partial writes undone, committed earlier
 *      kicks kept), pending left for exactly one inline replay;
 *  (d) timeout/disposal in flight: workers terminated BEFORE the replay,
 *      stale completions ignored, dispose resolves without quarantining.
 * `drawInlineRGBAll` never clears: the planes may hold committed earlier
 * kicks (world) that the replay must preserve.
 */

const REC_W = 64;
const REC_H = 48;

/** Fake DOM worker that REALLY executes its band's RGB job on every kick
 *  (same SAB protocol as the production entry): real partial writes,
 *  honest tallies, and a worker-local execMs duration on the completion
 *  message. `dropAckOnce` simulates a lost completion AFTER the writes
 *  landed (failure after partial execution). */
class ExecWorker extends FakeWorker {
  static live: ExecWorker[] = [];
  execMsLast = -1;
  /** Kick sequences this worker actually rasterised (writes landed). */
  wroteSeqs: number[] = [];
  dropAckOnce = false;
  terminateCount = 0;
  private xCtl: Int32Array | null = null;
  private xRgb: RGBAccumViews | null = null;
  private xW = 0;
  private xH = 0;
  private xY0 = 0;
  private xY1 = 0;
  private xBand = -1;
  private xLastSeq = -1;
  private xTimer: ReturnType<typeof setInterval> | null = null;
  private xDone = false;
  override postMessage(msg: FakeMsg): void {
    if (msg.sab !== undefined && typeof msg.w === 'number' && typeof msg.h === 'number') {
      ExecWorker.live.push(this);
      const { ctl } = attachFrameAccum(msg.sab, msg.w, msg.h);
      const { views } = attachRGBAccum(msg.sab, msg.w, msg.h);
      this.xCtl = ctl;
      this.xRgb = views;
      this.xW = msg.w;
      this.xH = msg.h;
      this.xY0 = typeof msg.y0 === 'number' ? msg.y0 : 0;
      this.xY1 = typeof msg.y1 === 'number' ? msg.y1 : 0;
      this.xBand = typeof msg.band === 'number' ? msg.band : -1;
      const self = this;
      setTimeout(() => {
        if (!self.xDone) self.onmessage?.({ data: { ready: true } });
      }, 0);
      this.xTimer = setInterval(() => {
        if (self.xDone || !self.xCtl) return;
        let seq = 0;
        try {
          seq = Atomics.load(self.xCtl, CTL_SEQ);
        } catch {
          return;
        }
        if (seq !== self.xLastSeq && seq > 0) {
          self.xLastSeq = seq;
          const job = Atomics.load(self.xCtl!, CTL_JOB);
          const t0 = performance.now();
          let pixels = 0;
          let spans = 0;
          if (job === JOB_RGB && self.xRgb) {
            const count = Atomics.load(self.xCtl!, CTL_RGBCOUNT);
            const r = processRGBFrameJob(self.xRgb, self.xW, self.xH, count, self.xY0, self.xY1);
            pixels = r.pixels;
            spans = r.spans;
            // Honest tallies (mirrors the real bandWorkerLoop harvest in
            // bands.ts): the pool's worker/main split reads these CTL
            // slots, so a fake that really executes must publish what it
            // drew — including zero-tri span batches and scanned counts.
            try {
              Atomics.store(self.xCtl!, CTL_PIXELS + self.xBand, r.pixels);
              Atomics.store(self.xCtl!, CTL_SPANS + self.xBand, r.spans);
              Atomics.store(self.xCtl!, CTL_SCAN + self.xBand, r.scanned);
              Atomics.store(self.xCtl!, CTL_TRIS + self.xBand, r.tris);
            } catch {
              /* control gone; the completion message still carries pixels/spans */
            }
          }
          const execMs = performance.now() - t0;
          self.execMsLast = execMs;
          self.wroteSeqs.push(seq);
          const drop = self.dropAckOnce;
          self.dropAckOnce = false;
          const s = seq;
          const b = self.xBand;
          setTimeout(() => {
            if (!self.xDone && !drop) self.onmessage?.({ data: { seq: s, band: b, pixels, spans, execMs } });
          }, 1);
        }
      }, 2);
    }
  }
  override terminate(): void {
    this.xDone = true;
    this.terminateCount += 1;
    if (this.xTimer !== null) clearInterval(this.xTimer);
    this.xTimer = null;
  }
}

/** Solid 4x4 chain (flat batches ignore it, sampled batches read texel 0). */
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

/** One-span-per-row list over [y0, y1) x [x0, x1). */
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

function recPlanes(pool: BrowserBandPool): { rgb565: Uint16Array; cover: Uint8Array; rgbDepth: Uint16Array } {
  const p = pool.rgbPlanes;
  return {
    rgb565: Uint16Array.from(p.rgb565),
    cover: Uint8Array.from(p.cover),
    rgbDepth: Uint16Array.from(p.rgbDepth),
  };
}

function expectPlanesEqual(a: BrowserBandPool, b: BrowserBandPool): void {
  const pa = a.rgbPlanes;
  const pb = b.rgbPlanes;
  expect(Array.from(pa.rgb565)).toEqual(Array.from(pb.rgb565));
  expect(Array.from(pa.cover)).toEqual(Array.from(pb.cover));
  expect(Array.from(pa.rgbDepth)).toEqual(Array.from(pb.rgbDepth));
}

describe('RGB foreground recovery (checkpoint/restore, real partial writes)', () => {
  it('failed FG kick after partial worker writes replays exactly once; world preserved', async () => {
    ExecWorker.live.length = 0;
    installFakeDom(ExecWorker);
    try {
      const pool = BrowserBandPool.create(2, REC_W, REC_H, { timeoutMs: 90 });
      const ref = BrowserBandPool.create(2, REC_W, REC_H, { timeoutMs: 5000 });
      expect(pool).not.toBeNull();
      expect(ref).not.toBeNull();
      try {
        expect(ExecWorker.live.length).toBe(4);
        const poolWorkers = ExecWorker.live.slice(0, 2);
        const worldChain = recChain(255, 0, 0);
        const fgChain = recChain(0, 200, 0);
        const world = recList(0, REC_H, 0, REC_W, SPAN_FLAT, 0.002);
        // FG: nearer translucent rows overlapping the world (blend reads
        // the world destination — double-blend would be observable).
        const fg = recList(8, 40, 10, 54, SPAN_TRANS33, 0.01);
        for (const p of [pool, ref] as const) {
          p!.beginFrame();
          recClear(p!);
          expect(p!.stageRGB(world, 0, world.count, worldChain, null, 0, 0,
            R_FLAG_FLAT | R_FLAG_DEPTHWRITE, 16, 0, 0xff0000)).toBe(true);
        }
        // Serial reference world (no kick — pure inline replay).
        ref!.drawInlineRGBAll(1, 1000, 0);
        // Pooled world kick must match serial exactly (worker-executed).
        const w = await pool!.flushRGBFrameAsync(1, 1000, 0);
        expect(w).not.toBeNull();
        expect(pool!.kickStats().kicks.rgb).toBe(1);
        expect(pool!.kickStats().lastRgb).toEqual({
          descs: 1, workerCompleted: true,
          mainPixels: 16 * REC_W, mainSpans: 16,
          workerPixels: w!.workerPixels, workerSpans: w!.workerSpans,
          workerTris: 0, mainTris: 0,
        });
        // Capture the completed world kick's worker split: the failed FG
        // kick below must not add to it (failures never accumulate).
        const worldSplit = { ...pool!.kickStats().frameCompleted };
        // Worker/main split reconciles: span batches carry no tris, the
        // calling-thread band drained the bottom 16 rows inline.
        expect(w!.workerPixels).toBeGreaterThan(0);
        expect(w!.workerSpans).toBe(w!.spans - 16);
        expect(w!.workerTris).toBe(0);
        expect(w!.tris).toBe(0);
        expectPlanesEqual(pool!, ref!);
        const worldSnap = recPlanes(pool!);
        // Stage the FG batch on both pools (identical pending).
        expect(pool!.stageRGB(fg, 0, fg.count, fgChain, null, 0, 0,
          R_FLAG_BLEND_ALPHA, 16, 0, 0)).toBe(true);
        expect(ref!.stageRGB(fg, 0, fg.count, fgChain, null, 0, 0,
          R_FLAG_BLEND_ALPHA, 16, 0, 0)).toBe(true);
        // Fail the FG kick AFTER real partial writes: worker1 rasterises
        // its band (rows 16..32) but its completion is lost; worker0 and
        // the calling-thread main band complete normally.
        poolWorkers[1]!.dropAckOnce = true;
        const bad = await pool!.flushRGBFrameAsync(1, 1000, 0);
        expect(bad).toBeNull();
        // Failure-after-partial proof (not failure-before-writes): the
        // silent worker really rasterised the failed kick, and the main
        // band ran its rows too.
        expect(poolWorkers[1]!.wroteSeqs.length).toBeGreaterThanOrEqual(2);
        const ks = pool!.kickStats();
        expect(ks.fallbacks.rgb).toBe(1);
        expect(ks.kicks.rgb).toBe(1);
        expect(ks.quarantined).toBe(true);
        expect(ks.lastRgb).not.toBeNull();
        expect(ks.lastRgb!.workerCompleted).toBe(false);
        // Retained descriptors: world (1) + FG (1) = 2 total at failure time.
        expect(ks.lastRgb!.descs).toBe(2);
        expect(ks.lastRgb!.mainPixels).toBeGreaterThan(0);
        // Staged-but-failed is never reported as worker-completed: the
        // partial worker writes were fenced (quarantine + checkpoint
        // restore), so the failed kick's worker share reads zero and the
        // per-frame completed-work split still holds only the earlier
        // completed world kick (failures never accumulate).
        expect(ks.lastRgb!.workerPixels).toBe(0);
        expect(ks.lastRgb!.workerSpans).toBe(0);
        expect(ks.lastRgb!.workerTris).toBe(0);
        expect(ks.frameCompleted).toEqual(worldSplit);
        // Quarantine terminated the wedged workers BEFORE any replay.
        expect(poolWorkers[0]!.terminateCount + poolWorkers[1]!.terminateCount)
          .toBeGreaterThanOrEqual(2);
        // The single inline replay converges to the serial reference:
        // committed world kept, FG blended exactly once.
        ref!.drawInlineRGBAll(1, 1000, 0);
        const rp = pool!.drawInlineRGBAll(1, 1000, 0);
        expect(rp.pixels).toBeGreaterThan(0);
        expectPlanesEqual(pool!, ref!);
        // World-only rows (40..48, outside the FG rect) are untouched.
        for (let y = 40; y < REC_H; y++) {
          for (let x = 0; x < REC_W; x++) {
            const i = y * REC_W + x;
            expect(pool!.rgbPlanes.rgb565[i]).toBe(worldSnap.rgb565[i]);
            expect(pool!.rgbPlanes.cover[i]).toBe(worldSnap.cover[i]);
          }
        }
        // FG applied (not just world): a blended pixel differs from the
        // committed world value and matches the serial reference.
        const fi = 20 * REC_W + 30;
        expect(pool!.rgbPlanes.cover[fi]).toBe(1);
        expect(pool!.rgbPlanes.rgb565[fi]).not.toBe(worldSnap.rgb565[fi]);
        // Stale completion for the abandoned kick is ignored (no state
        // change, no diag pollution, still quarantined).
        const before = pool!.kickStats();
        poolWorkers[0]!.onmessage?.({ data: { seq: 2, band: 0, pixels: 999, spans: 999, execMs: 0.5 } });
        await new Promise((r) => setTimeout(r, 10));
        expect(pool!.kickStats()).toEqual(before);
        // Next frame is correct and the loop is not wedged. Quarantine is
        // terminal by design (straggler writes must be impossible), so the
        // quarantined pool refuses staging fast and the next frame runs on
        // a rebooted pool — which must converge exactly.
        expect(pool!.stageRGB(world, 0, world.count, worldChain, null, 0, 0,
          R_FLAG_FLAT | R_FLAG_DEPTHWRITE, 16, 0, 0xff0000)).toBe(false);
        const t0 = Date.now();
        await expect(pool!.flushRGBFrameAsync(1, 1000, 0)).resolves.toBeNull();
        expect(Date.now() - t0).toBeLessThan(2000);
        const pool2 = BrowserBandPool.create(2, REC_W, REC_H, { timeoutMs: 5000 });
        expect(pool2).not.toBeNull();
        try {
          pool2!.beginFrame();
          recClear(pool2!);
          expect(pool2!.stageRGB(world, 0, world.count, worldChain, null, 0, 0,
            R_FLAG_FLAT | R_FLAG_DEPTHWRITE, 16, 0, 0xff0000)).toBe(true);
          ref!.beginFrame();
          recClear(ref!);
          expect(ref!.stageRGB(world, 0, world.count, worldChain, null, 0, 0,
            R_FLAG_FLAT | R_FLAG_DEPTHWRITE, 16, 0, 0xff0000)).toBe(true);
          pool2!.drawInlineRGBAll(1, 1000, 0);
          ref!.drawInlineRGBAll(1, 1000, 0);
          expectPlanesEqual(pool2!, ref!);
          expect(pool2!.rgbFlushed()).toBe(1);
          pool2!.commitRGB();
          expect(pool2!.rgbPending()).toBe(0);
        } finally {
          await pool2!.dispose();
        }
      } finally {
        await pool!.dispose();
        await ref!.dispose();
      }
    } finally {
      removeFakeDom();
      ExecWorker.live.length = 0;
    }
  });

  it('staging exhaustion refuses before dispatch; pending preserved for inline replay', () => {
    installFakeDom();
    try {
      const pool = BrowserBandPool.create(2, REC_W, REC_H);
      const ref = BrowserBandPool.create(2, REC_W, REC_H);
      expect(pool).not.toBeNull();
      expect(ref).not.toBeNull();
      try {
        const worldChain = recChain(255, 0, 0);
        const fillChain = recChain(0, 0, 255);
        const world = recList(0, REC_H, 0, REC_W, SPAN_FLAT, 0.002);
        for (const p of [pool, ref] as const) {
          p!.beginFrame();
          recClear(p!);
          expect(p!.stageRGB(world, 0, world.count, worldChain, null, 0, 0,
            R_FLAG_FLAT | R_FLAG_DEPTHWRITE, 16, 0, 0xff0000)).toBe(true);
        }
        // Fill every remaining descriptor with zero-span batches, then one
        // past the cap must refuse (before dispatch — no kick ran).
        let staged = 1;
        for (let i = 0; i < MAX_RGB_BATCHES + 10; i++) {
          const ok = pool!.stageRGB(emptySpans(), 0, 0, fillChain, null, 0, 0, 0, 16, 0, 0);
          if (!ok) break;
          staged++;
        }
        expect(staged).toBe(MAX_RGB_BATCHES);
        expect(pool!.rgbPending()).toBe(MAX_RGB_BATCHES);
        expect(pool!.kickStats().refusals.rgb).toBeGreaterThanOrEqual(1);
        // No kick ran, nothing executed: replay preserves the earlier
        // world work and matches the world-only serial reference.
        ref!.drawInlineRGBAll(1, 1000, 0);
        pool!.drawInlineRGBAll(1, 1000, 0);
        expectPlanesEqual(pool!, ref!);
        expect(pool!.kickStats().kicks.rgb).toBe(0);
        expect(pool!.kickStats().fallbacks.rgb).toBe(0);
        // Retained-frame protocol: inline replay marks flushed == pending;
        // descriptors persist until commitRGB. The loop unwedges via commit.
        expect(pool!.rgbPending()).toBe(MAX_RGB_BATCHES);
        expect(pool!.rgbFlushed()).toBe(MAX_RGB_BATCHES);
        pool!.commitRGB();
        expect(pool!.rgbPending()).toBe(0);
        expect(pool!.stageRGB(emptySpans(), 0, 0, fillChain, null, 0, 0, 0, 16, 0, 0)).toBe(true);
      } finally {
        void pool!.dispose();
        void ref!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });

  it('calling-thread band runs on a worker-timeout kick; failure counted, replay exact', async () => {
    installFakeDom(SilentWorker);
    try {
      const pool = BrowserBandPool.create(2, REC_W, REC_H, { timeoutMs: 60 });
      const ref = BrowserBandPool.create(2, REC_W, REC_H);
      expect(pool).not.toBeNull();
      expect(ref).not.toBeNull();
      try {
        const worldChain = recChain(255, 0, 0);
        const world = recList(0, REC_H, 0, REC_W, SPAN_FLAT, 0.002);
        for (const p of [pool, ref] as const) {
          p!.beginFrame();
          recClear(p!);
          expect(p!.stageRGB(world, 0, world.count, worldChain, null, 0, 0,
            R_FLAG_FLAT | R_FLAG_DEPTHWRITE, 16, 0, 0xff0000)).toBe(true);
        }
        pool!.enableDiag();
        // No worker ever acks: timeout quarantines; the calling thread's
        // own band (rows 32..48) still ran inline before the wait.
        await expect(pool!.flushRGBFrameAsync(1, 1000, 0)).resolves.toBeNull();
        const ks = pool!.kickStats();
        expect(ks.fallbacks.rgb).toBe(1);
        expect(ks.kicks.rgb).toBe(0);
        expect(ks.quarantined).toBe(true);
        expect(ks.lastRgb).not.toBeNull();
        expect(ks.lastRgb!.workerCompleted).toBe(false);
        expect(ks.lastRgb!.descs).toBe(1);
        expect(ks.lastRgb!.mainPixels).toBe(16 * REC_W);
        // Zero worker-completed on timeout (no worker ever acked); the
        // failed kick contributes nothing to the per-frame split, and the
        // inline replay carries no worker fields (absent = inline).
        expect(ks.lastRgb!.workerPixels).toBe(0);
        expect(ks.lastRgb!.workerSpans).toBe(0);
        expect(ks.lastRgb!.workerTris).toBe(0);
        expect(ks.frameCompleted.workerPixels).toBe(0);
        expect(ks.frameCompleted.mainPixels).toBe(0);
        const snap = pool!.diagSnapshot();
        expect(snap).not.toBeNull();
        expect(snap!.job).toBe('rgb');
        expect(snap!.arrivals).toEqual([]);
        expect(snap!.mainMs).toBeGreaterThanOrEqual(0);
        // Inline replay after the restore converges to serial exactly.
        ref!.drawInlineRGBAll(1, 1000, 0);
        pool!.drawInlineRGBAll(1, 1000, 0);
        expectPlanesEqual(pool!, ref!);
      } finally {
        await pool!.dispose();
        await ref!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });
});

describe('foreground counters: truthful execution attribution (web side)', () => {
  it('successful worker execution is completion-counted with worker-local durations', async () => {
    ExecWorker.live.length = 0;
    installFakeDom(ExecWorker);
    try {
      const pool = BrowserBandPool.create(2, REC_W, REC_H);
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        recClear(pool!);
        const world = recList(0, REC_H, 0, REC_W, SPAN_FLAT, 0.002);
        expect(pool!.stageRGB(world, 0, world.count, recChain(255, 0, 0), null, 0, 0,
          R_FLAG_FLAT | R_FLAG_DEPTHWRITE, 16, 0, 0xff0000)).toBe(true);
        pool!.enableDiag();
        const r = await pool!.flushRGBFrameAsync(1, 1000, 0);
        expect(r).not.toBeNull();
        // Execution proof (not staging proof): the kick completed on workers.
        const ks = pool!.kickStats();
        expect(ks.kicks.rgb).toBe(1);
        expect(ks.fallbacks.rgb).toBe(0);
        expect(ks.lastRgb).not.toBeNull();
        expect(ks.lastRgb!.workerCompleted).toBe(true);
        expect(ks.lastRgb!.descs).toBe(1);
        expect(ks.lastRgb!.mainPixels).toBe(16 * REC_W);
        // Worker/main attribution (PERF-NEXT-5): the executing fake
        // publishes honest CTL tallies, so the worker share is the two
        // worker bands' work and the combined total reconciles as
        // worker + main (span batches carry no tris).
        expect(r!.workerSpans).toBe(r!.spans - 16);
        expect(r!.workerPixels).toBe(r!.pixels - 16 * REC_W);
        expect(r!.workerTris).toBe(0);
        expect(ks.lastRgb!.workerSpans).toBe(r!.workerSpans);
        expect(ks.lastRgb!.workerPixels).toBe(r!.workerPixels);
        expect(ks.lastRgb!.workerTris).toBe(0);
        expect(ks.lastRgb!.mainTris).toBe(0);
        expect(ks.frameCompleted.workerSpans).toBe(r!.workerSpans);
        expect(ks.frameCompleted.mainSpans).toBe(16);
        // Worker-local durations attributed per band/seq alongside (not
        // fused with) the caller-side arrival latencies.
        const snap = pool!.diagSnapshot();
        expect(snap).not.toBeNull();
        expect(snap!.job).toBe('rgb');
        expect(snap!.bands).toBe(3);
        expect([...snap!.bandIds].sort((a, b) => a - b)).toEqual([0, 1]);
        expect(snap!.workerExecMs.length).toBe(2);
        for (const e of snap!.workerExecMs) {
          expect(Number.isFinite(e)).toBe(true);
          expect(e).toBeGreaterThanOrEqual(0);
        }
        expect(snap!.pixels.every((p) => p > 0)).toBe(true);
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeFakeDom();
      ExecWorker.live.length = 0;
    }
  });

  it('staged-but-failed foreground is never reported as worker-rendered', () => {
    sandbox();
    setCVarFromString('vid_renderer', 'software');
    const boot = bootPlay({ width: 32, height: 24 });
    const rec = boot.refresh as unknown as Record<string, unknown>;
    // Legacy renderer hook shape { staged, inline, kicks }: staged work
    // that never completed on workers must NOT surface as worker-rendered.
    rec['testForegroundWorkerStats'] = () => ({ staged: 5, inline: 5, kicks: 0 });
    const s = publishQ2Stats(boot, 60, 3);
    expect(s.fgStaged).toBe(5);
    expect(s.fgKicks).toBe(0);
    expect(s.fgInlineRgb).toBe(5);
    expect(s.fgWorker).toBe(-1);
    // Nothing staged: healthy zero (not unknown).
    rec['testForegroundWorkerStats'] = () => ({ staged: 0, inline: 0, kicks: 0 });
    expect(publishQ2Stats(boot, 60, 4).fgWorker).toBe(0);
  });

  it('serial inline foreground stays visible in inline counters, never as worker work', async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'software');
    const a = bootPlay({ width: 64, height: 48 });
    const b = bootPlay({ width: 64, height: 48 });
    const stA = createAsyncLoopState();
    const stB = createAsyncLoopState();
    // Exercise the entity foreground path (devroom boot spawns no
    // monsters, but the placed/entity segments still run their counting
    // paths through the same hooks the production frame uses).
    let t = 0;
    for (let f = 0; f < 5; f++) {
      t += 16.7;
      await frameAsync(a, stA, t);
      const rep = await measureFrameStages(b, stB, t);
      const fg = rep.fg;
      expect(fg).not.toBeNull();
      // Unpooled serial frame: nothing staged, no kicks, no worker
      // completion — inline holds whatever the renderer drew inline.
      expect(fg!.staged).toBe(0);
      expect(fg!.kicks).toBe(0);
      expect(fg!.worker).toBe(0);
      expect(fg!.inline).toBeGreaterThanOrEqual(0);
    }
  });
});

const FG_AUDIT_DIST = new URL('../../../packages/sw-renderer/dist/index.mjs', import.meta.url).pathname;

/** Attach a Node worker pool as this boot's browserPool (Track A stand-in). */
function attachAuditPool(boot: PlayBoot, workers: number): BandWorkerPool {
  const w = boot.host.fb.width;
  const h = boot.host.fb.height;
  const pool = BandWorkerPool.create(workers, w, h, { indexJsPath: FG_AUDIT_DIST });
  if (!pool) throw new Error('pool unavailable (need worker_threads + SAB)');
  boot.refresh.attachWorkerPool(pool as unknown as never);
  (boot as unknown as Record<string, unknown>).browserPool = pool;
  const sp = pool.scanoutPlanes;
  boot.fb565 = sp.scan565;
  boot.display = sp.scanDisplay;
  return pool;
}

describe.runIf(!!WEB_Q2_PAK)('base1 foreground kick audit (Q2_PAK, report-only)', () => {
  it('per-frame RGB/FG kick accounting: world 1, FG <= 2, zero fallbacks', { timeout: 300000 }, async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'voodoo');
    setCVar('sw_workers', 4);
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const boot = bootPlay({ width: 96, height: 72, pak: ingestPak(buf) });
    const pool = attachAuditPool(boot, 3);
    try {
      const st = createAsyncLoopState();
      let t = 0;
      const rows: string[] = [];
      for (let f = 0; f < 12; f++) {
        t += 16.7;
        boot.host.input.angles = [0, (f * 13) % 360, 0];
        boot.host.input.buttons = f >= 4 && f < 9 ? 1 : 0;
        if (f % 4 === 0) boot.host.input.keys.add('forward');
        if (f % 4 === 2) boot.host.input.keys.delete('forward');
        pumpMuzzleLight(boot);
        pumpExplosionLights(boot);
        pumpTracers(boot);
        boot.host.frame(t);
        const hud = { fps: 60, frame: f };
        resolveDisplay(boot, hud);
        const rs = boot.refresh.testRGBWorkerStats();
        const fs = boot.refresh.testForegroundWorkerStats();
        rows.push(
          `f${f} world staged=${rs.staged} kicks=${rs.kicks} inline=${rs.inline} ` +
          `fg staged=${fs.staged} kicks=${fs.kicks} inline=${fs.inline}`,
        );
        // Exactly one world RGB kick per frame; the two foreground flush
        // points (alpha-before-alias, sprites-before-particles) bound FG
        // kicks at two; nothing falls back to inline.
        expect(rs.kicks).toBe(1);
        expect(rs.staged).toBeGreaterThan(0);
        expect(rs.inline).toBe(0);
        expect(fs.kicks).toBeLessThanOrEqual(2);
        expect(fs.staged).toBeGreaterThanOrEqual(0);
        expect(fs.inline).toBeGreaterThanOrEqual(0);
      }
      console.log(`[web-fg-audit] base1 96x72 combat sweep (movement + firing)\n  ${rows.join('\n  ')}`);
      expect(boot.statAsyncFallbacks).toBe(0);
      expect(boot.statScanoutFallbacks).toBe(0);
    } finally {
      await pool.dispose();
    }
  });
});

describe('__q2bench worker-count sweep legs (reattach/detach)', () => {
  it('reattach(n) arms pooled legs, detach() restores the pool-less serial leg', async () => {
    installFakeDom();
    let boot: PlayBoot | null = null;
    try {
      sandbox();
      // Banded renderer BEFORE boot (reattach only sizes the pool; the
      // renderer latches bands from the cvar at bootPlay).
      setCVar('sw_workers', 3);
      boot = bootPlay({ width: 64, height: 48 });
      expect(boot.refresh.testWorkerStats().active).toBe(true);
      let stopped = false;
      installBenchHook(null, () => boot, () => { stopped = true; });
      const hook = (G['window'] as unknown as { __q2bench?: {
        stopLoop(): void;
        reattach(workers?: number): { pooled: boolean; bands: number };
        detach(): { pooled: boolean; bands: number };
        measure(frames: number): Promise<Array<{ pooled: boolean; bands: number }>>;
      } }).__q2bench;
      expect(hook).toBeDefined();
      hook!.stopLoop();
      expect(stopped).toBe(true);
      // 2-worker pooled leg: renderer bands latch from the cvar (n + 1).
      const r2 = hook!.reattach(2);
      expect(r2).toEqual({ pooled: true, bands: 3 });
      expect(boot.browserPool).not.toBeNull();
      const m2 = await hook!.measure(2);
      expect(m2.length).toBe(2);
      expect(m2[0]!.pooled).toBe(true);
      expect(m2[0]!.bands).toBe(3);
      // Serial leg: pool gone, SAME band geometry (the control isolates
      // worker parallelism from banding), frames still measurable.
      const d = hook!.detach();
      expect(d.pooled).toBe(false);
      expect(boot.browserPool).toBeNull();
      expect(boot.refresh.testWorkerStats().pooled).toBe(false);
      const m0 = await hook!.measure(2);
      expect(m0.length).toBe(2);
      expect(m0[0]!.pooled).toBe(false);
      expect(m0[0]!.bands).toBe(d.bands);
      // Idempotent + re-armable: detach again, then reattach(1).
      expect(hook!.detach().pooled).toBe(false);
      const r1 = hook!.reattach(1);
      expect(r1).toEqual({ pooled: true, bands: 2 });
      expect(boot.browserPool).not.toBeNull();
    } finally {
      try {
        const p = boot?.browserPool as unknown as { dispose?: () => Promise<void> } | null;
        if (p && typeof p.dispose === 'function') await p.dispose();
        if (boot) boot.browserPool = null;
      } catch { /* ignore */ }
      removeFakeDom();
    }
  });
});
