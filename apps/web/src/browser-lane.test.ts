// PERF-FINISH-B browser lane: pool diagnostics, extended __q2stats,
// instrumented stage frames (RELEASE-8 indexed only).
//
// - Pool kick diagnostics are instrumented-only (disarmed by default: one
//   boolean check per kick/message, zero steady-state allocation) and
//   headless-coverable through a fake in-thread Worker (same SAB +
//   CTL_SEQ protocol the real DOM workers speak, including the band-
//   attributed completion message `{ seq, band, pixels, spans }`).
// - `measureFrameStages` is the instrumented twin of `frameAsync`
//   (production tick never calls it): pixel parity + sane counters here.
// - `publishQ2Stats` extensions (bands/spans/staging, indexed raster
//   fallbacks/quarantine, per-lane timing sentinels).
import { afterEach, describe, expect, it } from 'vitest';
import { getCVarNumber, resetCVars, setCVar, setCVarFromString } from '@q2/config';
import {
  attachFrameAccum,
  BandWorkerPool,
  CTL_SEQ,
  F_PER_SPAN,
  I_PER_SPAN,
  packFrameSpans,
  SPAN_FLAT,
  type LightBlock,
  type Span,
  type SpanList,
  type Texture,
} from '@q2/sw-renderer';
import { BrowserBandPool } from './render-workers.js';
import { installBenchHook } from './index.js';
import { publishQ2Stats } from './dom.js';
import {
  bootPlay,
  createAsyncLoopState,
  frameAsync,
  measureFrameStages,
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

/* --- indexed staging helper (flat spans, 1x1 tex/light) ------------------ */

const LANE_W = 64;
const LANE_H = 48;

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

describe('BrowserBandPool kick diagnostics (instrumented-only)', () => {
  it('diag disarmed by default: no timing state, null snapshot', () => {
    installFakeDom();
    try {
      const pool = BrowserBandPool.create(2, LANE_W, LANE_H);
      expect(pool).not.toBeNull();
      try {
        expect(pool!.diagActive()).toBe(false);
        expect(pool!.diagSnapshot()).toBeNull();
        const bytes = pool!.stagingBytes();
        expect(bytes).toEqual({
          idxSpans: 0, idxTex: 0, idxLight: 0, idxDescs: 0,
          total: 0,
        });
        expect(pool!.kickBytes()).toBeNull();
      } finally {
        void pool!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });

  it('stagingBytes counts indexed staging after a flat stage', () => {
    installFakeDom();
    try {
      const pool = BrowserBandPool.create(2, LANE_W, LANE_H);
      expect(pool).not.toBeNull();
      try {
        // No kick yet: frozen snapshot is null, live view counts staging.
        expect(pool!.kickBytes()).toBeNull();
        pool!.beginFrame();
        expect(stageFlat(pool!, 0, LANE_H, LANE_W)).toBe(true);
        const bytes = pool!.stagingBytes();
        const perSpan = F_PER_SPAN * 8 + I_PER_SPAN * 4;
        expect(bytes.idxDescs).toBe(1);
        expect(bytes.idxSpans).toBe(LANE_H * perSpan);
        expect(bytes.idxTex).toBe(1);
        expect(bytes.idxLight).toBe(1);
        expect(bytes.total).toBe(bytes.idxSpans + bytes.idxTex + bytes.idxLight);
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
      const pool = BrowserBandPool.create(2, LANE_W, LANE_H);
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        expect(stageFlat(pool!, 0, LANE_H, LANE_W)).toBe(true);
        pool!.enableDiag();
        expect(pool!.diagActive()).toBe(true);
        const out = await pool!.flushFrameAsync();
        expect(out).not.toBeNull();
        // The indexed kick succeeded: counted, not silent.
        expect(pool!.kickStats().kicks.raster).toBe(1);
        expect(pool!.kickStats().fallbacks.raster).toBe(0);
        expect(pool!.kickStats().quarantined).toBe(false);
        // Workers faked zero tallies; the calling-thread band really drew
        // its 16 rows inline (16 x 64 px).
        expect(out!.spans).toBe(16);
        expect(out!.pixels).toBe(16 * LANE_W);
        // Inspected spans: the main band visited its 16 rows (workers
        // acked control-only, contributing nothing).
        expect(pool!.kickStats().scanned.raster).toBe(16);
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
        expect(snap!.job).toBe('raster');
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
        const kb = pool!.kickBytes();
        expect(kb).not.toBeNull();
        expect(kb!.idxDescs).toBe(1);
        expect(pool!.stagingBytes().idxDescs).toBe(0);
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

  it('kick timeout quarantines the pool: fails counted, later kicks refuse fast', async () => {
    installFakeDom(SilentWorker);
    try {
      const pool = BrowserBandPool.create(2, LANE_W, LANE_H, { timeoutMs: 60 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        expect(stageFlat(pool!, 0, LANE_H, LANE_W)).toBe(true);
        // No worker ever acks: the kick times out, terminates the wedged
        // workers BEFORE the inline replay (no straggler write can race
        // it), and counts the failure — never silent.
        const t0 = Date.now();
        await expect(pool!.flushFrameAsync()).resolves.toBeNull();
        expect(Date.now() - t0).toBeLessThan(20000);
        const ks = pool!.kickStats();
        expect(ks.fallbacks.raster).toBe(1);
        expect(ks.kicks.raster).toBe(0);
        expect(ks.quarantined).toBe(true);
        // Quarantined: the next kick refuses fast (no second 60s hang for
        // the production loop to absorb).
        const t1 = Date.now();
        await expect(pool!.flushFrameAsync()).resolves.toBeNull();
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
      const pool = BrowserBandPool.create(2, LANE_W, LANE_H, { timeoutMs: 5000 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        expect(stageFlat(pool!, 0, LANE_H, LANE_W)).toBe(true);
        const t0 = Date.now();
        const pending = pool!.flushFrameAsync();
        await pool!.dispose();
        // Dispose aborts the kick: the waiter resolves as a failure →
        // inline fallback (null), far inside the 5s kick timeout.
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

describe('publishQ2Stats extensions (bands/spans/staging/timing)', () => {
  it('unpooled software boot reports unit defaults', () => {
    sandbox();
    setCVarFromString('vid_renderer', 'software');
    const boot = bootPlay({ width: 32, height: 24 });
    const s = publishQ2Stats(boot, 60, 3);
    expect(s.bands).toBe(1);
    expect(s.poolSpans).toBe(0);
    expect(s.poolPixels).toBe(0);
    expect(s.stageBytes).toBe(-1);
    expect(s.rasterFallbacks).toBe(0);
    expect(s.quarantined).toBe(false);
    expect(s.lastKickJob).toBe('none');
    expect(s.rasterSlowestMs).toBe(-1);
    expect(s.resolveSlowestMs).toBe(-1);
    expect(s.resolveOrder).toBe('none');
    // A software resolve records the passthrough branch.
    resolveDisplay(boot);
    expect(publishQ2Stats(boot, 60, 3).resolveOrder).toBe('software-passthrough');
  });

  it('pool fallback counts + quarantine surface through __q2stats', () => {
    sandbox();
    const boot = bootPlay({ width: 32, height: 24 });
    (boot as unknown as Record<string, unknown>).browserPool = {
      kickBytes: () => null,
      kickStats: () => ({
        kicks: { raster: 1, resolve: 0 },
        fallbacks: { raster: 1, resolve: 0 },
        quarantined: true,
      }),
    };
    const s = publishQ2Stats(boot, 60, 3);
    expect(s.rasterFallbacks).toBe(1);
    expect(s.quarantined).toBe(true);
    // A foreign/older pool without kickStats degrades to healthy zeros.
    (boot as unknown as Record<string, unknown>).browserPool = {};
    const t = publishQ2Stats(boot, 60, 4);
    expect(t.rasterFallbacks).toBe(0);
    expect(t.quarantined).toBe(false);
  });

  it('throws-safe when all probes throw (never breaks the present path)', () => {
    sandbox();
    const boot = bootPlay({ width: 32, height: 24 });
    const rec = boot.refresh as unknown as Record<string, unknown>;
    rec['testWorkerStats'] = (): never => {
      throw new Error('simulated future-renderer hook failure');
    };
    const s = publishQ2Stats(boot, 60, 3);
    expect(s.bands).toBe(1);
    expect(s.poolSpans).toBe(0);
    expect(s.poolPixels).toBe(0);
    expect(s.stageBytes).toBe(-1);
    expect(s.rasterFallbacks).toBe(0);
    expect(s.quarantined).toBe(false);
    expect(s.lastKickJob).toBe('none');
  });
});

const WEB_Q2_PAK = process.env.Q2_PAK;

/** Attach a Node worker pool as this boot's pool (indexed stand-in). */
function attachIndexedPool(boot: PlayBoot, workers: number): BandWorkerPool {
  const w = boot.host.fb.width;
  const h = boot.host.fb.height;
  const dist = new URL('../../../packages/sw-renderer/dist/index.mjs', import.meta.url).pathname;
  const pool = BandWorkerPool.create(workers, w, h, { indexJsPath: dist });
  if (!pool) throw new Error('node pool unavailable');
  boot.refresh.attachWorkerPool(pool as unknown as never);
  (boot as unknown as Record<string, unknown>).browserPool = pool;
  return pool;
}

describe.runIf(!!WEB_Q2_PAK)('base1 640x480 web-layer stage table (Q2_PAK, report-only)', () => {
  async function bootBase1(): Promise<PlayBoot> {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    return bootPlay({ width: 640, height: 480, pak: ingestPak(buf) });
  }

  it('pooled indexed frame: execution proof, staging, zero fallbacks', { timeout: 300000 }, async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'software');
    setCVar('sw_workers', 8);
    const boot = await bootBase1();
    const pool = attachIndexedPool(boot, 7);
    try {
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
          `pooled=${rep.pooled} bands=${rep.bands} ` +
          `rasterFb=${rep.rasterFallbacks} scanned=${rep.scannedSpans} path=${rep.resolveOrder}` +
          (rep.stageDetail ? ` up=${rep.stageDetail.transientBytes}B descs=${rep.stageDetail.descs}` : ''),
        );
        expect(rep.pooled).toBe(true);
        expect(rep.bands).toBe(8);
        expect(rep.rasterFallbacks).toBe(0);
        expect(rep.scannedSpans).toBeGreaterThanOrEqual(0);
      }
      console.log(`[web-stage] base1 640x480 pooled-7 stationary\n  ${rows.join('\n  ')}`);
      expect(boot.statAsyncFallbacks).toBe(0);
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
      // Unpooled software: no worker proof, no staging, software resolve.
      expect(rep.pooled).toBe(false);
      expect(rep.bands).toBe(1);
      expect(rep.stageBytes).toBe(-1);
      expect(rep.diag).toBeNull();
      // No pool, so no inspected-span counters either (-1, not 0) and no
      // raster fallback. Heap sampling is Chromium-only.
      expect(rep.rasterFallbacks).toBe(0);
      expect(rep.scannedSpans).toBe(-1);
      expect(rep.heapDeltaMB === null || typeof rep.heapDeltaMB === 'number').toBe(true);
      expect(rep.resolveOrder).toBe('software-passthrough');
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
