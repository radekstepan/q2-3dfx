// PERF-FINISH-B browser lane: pool diagnostics, extended __q2stats,
// instrumented stage frames.
//
// - Pool kick diagnostics are instrumented-only (disarmed by default: one
//   boolean check per kick/message, zero steady-state allocation) and
//   headless-coverable through a fake in-thread Worker (same SAB +
//   CTL_SEQ protocol the real DOM workers speak).
// - `measureFrameStages` is the instrumented twin of `frameAsync`
//   (production tick never calls it): pixel parity + sane counters here.
// - `publishQ2Stats` extensions (bands/spans/pixels/pending/stageBytes,
//   fgInline -1 until the renderer publishes a foreground counter).
import { afterEach, describe, expect, it } from 'vitest';
import { getCVarNumber, resetCVars, setCVar, setCVarFromString } from '@q2/config';
import {
  attachFrameAccum,
  CTL_JOB,
  CTL_SEQ,
  type RGBMipLevel,
  type SpanList,
} from '@q2/sw-renderer';
import { BrowserBandPool } from './render-workers.js';
import { publishQ2Stats } from './dom.js';
import {
  bootPlay,
  createAsyncLoopState,
  frameAsync,
  measureFrameStages,
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
  seq?: number;
  ready?: boolean;
}

/** Minimal DOM-Worker stand-in: ready-acks init, completion-acks kicks by
 * polling the shared CTL_SEQ (never does band work — control flow only,
 * never pixel assertions). */
class FakeWorker {
  onmessage: ((ev: { data: FakeMsg }) => void) | null = null;
  private ctl: Int32Array | null = null;
  private lastSeq = -1;
  private done = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  postMessage(msg: FakeMsg): void {
    if (msg.sab && typeof msg.w === 'number' && typeof msg.h === 'number') {
      this.ctl = attachFrameAccum(msg.sab, msg.w, msg.h).ctl;
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
          setTimeout(() => {
            if (!self.done) self.onmessage?.({ data: { seq: s } });
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
        const snap = pool!.diagSnapshot();
        expect(snap).not.toBeNull();
        // Two fake workers acked: two rank-ordered arrivals, main-band timed.
        expect(snap!.arrivals.length).toBe(2);
        expect(snap!.arrivals[0]!).toBeGreaterThanOrEqual(0);
        expect(snap!.arrivals[1]!).toBeGreaterThanOrEqual(snap!.arrivals[0]!);
        expect(snap!.slowestMs).toBe(snap!.arrivals[1]);
        expect(snap!.mainMs).toBeGreaterThanOrEqual(0);
        expect(snap!.kicks).toBe(1);
        // Frozen last-kick snapshot survives the post-kick offset reset:
        // live descs read drained (0), the snapshot keeps the kick (1).
        // (Chains persist by design — copy-on-first-use — so totals agree.)
        const kb = pool!.kickBytes();
        expect(kb).not.toBeNull();
        expect(kb!.rgbDescs).toBe(1);
        expect(kb!.rgbChains).toBe(4 * 4 * 3 + 4 * 4);
        expect(pool!.stagingBytes().rgbDescs).toBe(0);
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
    // Foreground counter comes from the renderer's skip hook when present
    // (classicFgSkipped, 0 with the skip disarmed), -1 on older renderers
    // — the shell never guesses.
    expect(s.fgInline).toBe(expectedFg(boot));
    expect(s.classicSkipped).toBe(0);
    expect(s.skipArmed).toBe(false);
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
    const s = publishQ2Stats(boot, 60, 3);
    expect(s.bands).toBe(1);
    expect(s.poolSpans).toBe(0);
    expect(s.rgbStaged).toBe(0);
    expect(s.fgInline).toBe(-1);
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
