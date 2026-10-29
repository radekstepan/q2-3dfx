// PERF-NEXT-2 Lane B (browser): recovery is safe against genuinely live
// writers.
//
// The pre-existing recovery tests use scripted workers that have already
// stopped (DONE never arrives, nothing writes). These tests close the real
// gap: a REAL in-thread worker keeps issuing shared-plane writes through
// the timeout/quarantine/recovery window (it ignores terminate() until its
// acknowledged stop, like a worker stuck mid-raster until the OS thread
// actually dies), while the pool must still converge to the serial planes.
// What the tests prove:
//  - timeout with a hammering writer: quarantine isolates the planes onto a
//    replacement SAB (fence epoch bumps, pool views move) BEFORE any
//    restore/replay; recovery then converges to the uninterrupted serial
//    reference across RGB565, depth, coverage and full-RGBA display.
//  - a slow kick worker whose band write lands AFTER the timeout (during
//    the recovery window): the late write hits the ABANDONED buffer only
//    (proved by observing it there), the late completion is ignored by the
//    stale-completion guard, and the recovered planes match serial.
//  - disposal in flight resolves fast without quarantining; never-ready /
//    disposed / quarantined flushes are clean failures (nothing dispatched);
//    checkpoint allocation failure is a refused outcome selected BEFORE
//    dispatch (pool stays alive, later kicks succeed, replay is exact).
//  - renderer-level dimensions: opaque world + translucent alpha + ADDITIVE
//    spans (destination-dependent like alpha: the double-apply control must
//    differ), main-band completion, capacity refusal before dispatch, and
//    the next frame (rebooted pool converges; quarantined pool refuses fast).
//  - successful-path overhead is measured (per-kick wall time + checkpoint
//    bytes), not just recovery latency; the fence adds no work to the
//    success path by construction (one null-check on a present snapshot).
//
// Faithfulness note: in-thread fakes run the REAL shared-SAB protocol
// (real processRGBFrameJob band writes, real CTL_SEQ/CTL_DONE/tally slots,
// real completion/exit message shapes) but serialize with the main thread
// instead of racing on a true second thread. The fenced properties -
// isolation before restore/replay, epoch fencing of completions, exactly-once
// replay - are what the tests pin; true thread parallelism is covered by
// the integrator's browser soak, not here.
import { describe, expect, it, afterEach } from 'vitest';
import {
  attachFrameAccum,
  attachRGBAccum,
  CTL_DONE,
  CTL_JOB,
  CTL_PIXELS,
  CTL_RGBBASE,
  CTL_RGBCOUNT,
  CTL_SEQ,
  CTL_SPANS,
  createSpan,
  JOB_RGB,
  processRGBFrameJob,
  resolveBandFused,
  rgbAccumTotal,
  RGB_MAX_CHAINS,
  R_FLAG_ADDITIVE,
  R_FLAG_BLEND_ALPHA,
  R_FLAG_DEPTHWRITE,
  R_FLAG_LIGHT,
  R_FLAG_OPAQUE,
  R_FLAG_REPEAT,
  SPAN_ADD,
  SPAN_OPAQUE,
  SPAN_TRANS66,
  type RGBAccumViews,
  type RGBMipLevel,
  type Span,
} from '@q2/sw-renderer';
import { BrowserBandPool } from './render-workers.js';

const W = 64;
const H = 48;
const SEED = 0x8410;

/* --- scene (mirrors the Node lane's live-writer scene, browser dims) --- */

function testPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = (i * 5) & 255;
    pal[i * 3 + 1] = (i * 3 + 40) & 255;
    pal[i * 3 + 2] = (i * 2 + 80) & 255;
  }
  return pal;
}

function tinyChain(palIndex: number): RGBMipLevel[] {
  const pal = testPalette();
  const r = pal[palIndex * 3]!;
  const g = pal[palIndex * 3 + 1]!;
  const b = pal[palIndex * 3 + 2]!;
  const data = new Uint8Array([r, g, b, r, g, b, r, g, b, r, g, b]);
  const mask = new Uint8Array([255, 255, 255, 255]);
  return [{ data, width: 2, height: 2, mask }];
}

const LUX = new Uint8Array([200, 200, 200]);
const WORLD_FLAGS = R_FLAG_REPEAT | R_FLAG_DEPTHWRITE | R_FLAG_LIGHT | R_FLAG_OPAQUE;
const FG_FLAGS = R_FLAG_REPEAT | R_FLAG_LIGHT | R_FLAG_BLEND_ALPHA;
const ADD_FLAGS = R_FLAG_REPEAT | R_FLAG_DEPTHWRITE | R_FLAG_LIGHT | R_FLAG_ADDITIVE;

function makeSpan(y: number, kind: number, iz: number): Span {
  const s = createSpan();
  s.kind = kind;
  s.y = y;
  s.x0 = 0;
  s.x1 = W;
  s.iz = iz;
  s.diz = 0;
  s.uz = 8;
  s.duz = 0;
  s.vz = 8;
  s.dvz = 0;
  s.light = 200;
  s.dlight = 0;
  s.lu = 0;
  s.lv = 0;
  s.dlu = 0;
  s.turb = 0;
  s.ord = 0;
  s.dudy = 0;
  s.dvdy = 0;
  return s;
}

/** Stage opaque world + translucent FG + additive FG (all front blends). */
function stageScene(pool: BrowserBandPool): void {
  const chain = tinyChain(7);
  const fgChain = tinyChain(200);
  const addChain = tinyChain(45);
  const world: Span[] = [];
  for (let y = 0; y < H; y++) world.push(makeSpan(y, SPAN_OPAQUE, 0.2));
  expect(pool.stageRGB({ spans: world, count: world.length }, 0, world.length,
    chain, LUX, 1, 1, WORLD_FLAGS, 0, 0, 0)).toBe(true);
  const fg: Span[] = [];
  for (let y = Math.floor(H / 4); y < Math.floor((3 * H) / 4); y++) {
    fg.push(makeSpan(y, SPAN_TRANS66, 0.24));
  }
  expect(pool.stageRGB({ spans: fg, count: fg.length }, 0, fg.length,
    fgChain, LUX, 1, 1, FG_FLAGS, 0, 0, 0)).toBe(true);
  const add: Span[] = [];
  for (let y = 0; y < Math.floor(H / 4); y++) add.push(makeSpan(y, SPAN_ADD, 0.26));
  expect(pool.stageRGB({ spans: add, count: add.length }, 0, add.length,
    addChain, LUX, 1, 1, ADD_FLAGS, 0, 0, 0)).toBe(true);
}

/** Renderer beginFrame clear when pooled: cover 0, depth far, black. */
function recClear(pool: BrowserBandPool): void {
  const p = pool.rgbPlanes;
  p.cover.fill(0);
  p.rgbDepth.fill(0xffff);
  p.rgb565.fill(0);
}

function seedForTest(pool: BrowserBandPool, v: number): void {
  const p = pool.rgbPlanes;
  for (let i = 0; i < p.rgb565.length; i++) {
    if (p.cover[i] === 0) p.rgb565[i] = v;
  }
}

function copyPlanes(pool: BrowserBandPool): { q: Uint16Array; c: Uint8Array; d: Uint16Array } {
  const p = pool.rgbPlanes;
  return {
    q: Uint16Array.from(p.rgb565),
    c: Uint8Array.from(p.cover),
    d: Uint16Array.from(p.rgbDepth),
  };
}

function expectPlanesEqual(a: { q: Uint16Array; c: Uint8Array; d: Uint16Array },
  b: { q: Uint16Array; c: Uint8Array; d: Uint16Array }): void {
  expect(Array.from(a.q)).toEqual(Array.from(b.q));
  expect(Array.from(a.c)).toEqual(Array.from(b.c));
  expect(Array.from(a.d)).toEqual(Array.from(b.d));
}

/** Serial full-RGBA display resolve of a pool's current planes (non-mutating). */
function resolveDisplayOf(pool: BrowserBandPool, pal: Uint8Array): Uint32Array {
  const p = pool.planes;
  const rp = pool.rgbPlanes;
  const color = Uint32Array.from(p.color);
  resolveBandFused(color, pal, p.idx, rp.rgb565, rp.cover, 0, H, W, H);
  return color;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor timed out: ${what}`);
    await sleep(5);
  }
}

/* --- fake DOM wiring (same SAB/CTL_SEQ protocol as the real workers) --- */

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
  execMs?: number;
  exited?: boolean;
}

const G = globalThis as unknown as Record<string, unknown>;
const REAL = { window: G['window'], document: G['document'], Worker: G['Worker'] };

function installFakeDom(worker: new () => unknown): void {
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

/** Live-worker registry: every fake stops here even if a test fails. */
const liveFakes = new Set<{ forceStop: () => void }>();

/** Shared fake skeleton: ready-ack + CTL_SEQ poll + liveness registry. */
class LiveBase {
  onmessage: ((ev: { data: FakeMsg }) => void) | null = null;
  terminateCount = 0;
  protected ctl: Int32Array | null = null;
  protected rgb: RGBAccumViews | null = null;
  protected w = 0;
  protected h = 0;
  protected y0 = 0;
  protected y1 = 0;
  protected band = -1;
  protected lastSeq = -1;
  protected dead = false;
  protected pollTimer: ReturnType<typeof setInterval> | null = null;
  protected pendingTimers: ReturnType<typeof setTimeout>[] = [];

  constructor() {
    liveFakes.add(this);
  }

  postMessage(msg: FakeMsg): void {
    if (msg.sab === undefined || typeof msg.w !== 'number' || typeof msg.h !== 'number') return;
    const { ctl } = attachFrameAccum(msg.sab, msg.w, msg.h);
    const { views } = attachRGBAccum(msg.sab, msg.w, msg.h);
    this.ctl = ctl;
    this.rgb = views;
    this.w = msg.w;
    this.h = msg.h;
    this.y0 = typeof msg.y0 === 'number' ? msg.y0 : 0;
    this.y1 = typeof msg.y1 === 'number' ? msg.y1 : 0;
    this.band = typeof msg.band === 'number' ? msg.band : -1;
    this.later(() => {
      if (!this.dead) this.onmessage?.({ data: { ready: true } });
    }, 0);
    this.pollTimer = setInterval(() => {
      if (!this.dead) this.poll();
    }, 2);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  forceStop(): void {
    this.dead = true;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const t of this.pendingTimers) clearTimeout(t);
    this.pendingTimers = [];
    liveFakes.delete(this);
  }

  protected later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      const i = this.pendingTimers.indexOf(t);
      if (i >= 0) this.pendingTimers.splice(i, 1);
      fn();
    }, ms);
    this.pendingTimers.push(t);
  }

  protected poll(): void {
    // Subclass hook: observe CTL_SEQ.
  }

  protected readSeq(): number {
    try {
      if (!this.ctl) return -1;
      return Atomics.load(this.ctl, CTL_SEQ);
    } catch {
      return -1;
    }
  }
}

/**
 * Genuinely-live rogue worker: once it observes a kick, it hammers garbage
 * over its OWN band rows of the shared RGB planes (like a worker writing a
 * stale/garbage band through the timeout), never acks the kick and never
 * reaches DONE - every kick times out. It IGNORES terminate() until stop()
 * runs the acknowledged stop (exit ack + halt), like a worker stuck
 * mid-raster until the OS thread actually dies. Band-local scribbles keep
 * the pre-kick planes and the main-thread band deterministic while the
 * worker-band rows carry the live-writer threat through timeout, isolation
 * and recovery.
 */
class HammerWorker extends LiveBase {
  private scribbleTimer: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;
  stopped = false;

  protected override poll(): void {
    const seq = this.readSeq();
    if (seq === this.lastSeq || seq <= 0 || !this.rgb) return;
    this.lastSeq = seq;
    if (this.scribbleTimer !== null || this.dead) return;
    const rgb = this.rgb;
    const y0 = this.y0;
    const y1 = this.y1;
    const rowW = this.w;
    const n = Math.max(1, y1 - y0) * rowW;
    this.scribbleTimer = setInterval(() => {
      if (this.dead) return;
      const q = rgb.rgb565;
      const cv = rgb.cover;
      const dp = rgb.rgbDepth;
      // Dense sequential coverage: a full band pass per tick, so every
      // band pixel carries live-writer garbage within milliseconds.
      for (let k = 0; k < 1024; k++) {
        const idx = y0 * rowW + ((this.cursor + k) % n);
        q[idx] = 0xf800;
        cv[idx] = 1;
        dp[idx] = 0;
      }
      this.cursor = (this.cursor + 1024) % n;
    }, 1);
  }

  override terminate(): void {
    // Ignored until the acknowledged stop: kill latency simulation. The
    // count still proves the pool attempted termination.
    this.terminateCount += 1;
  }

  stop(): void {
    this.stopped = true;
    if (this.scribbleTimer !== null) clearInterval(this.scribbleTimer);
    this.scribbleTimer = null;
    const b = this.band;
    this.later(() => {
      this.onmessage?.({ data: { exited: true, band: b } });
      this.forceStop();
    }, 1);
  }

  override forceStop(): void {
    if (this.scribbleTimer !== null) clearInterval(this.scribbleTimer);
    this.scribbleTimer = null;
    super.forceStop();
  }
}

/**
 * Slow-but-live kick worker: observes the kick, waits past the pool
 * timeout, then performs its REAL band write (real processRGBFrameJob into
 * the shared SAB, real CTL tallies + DONE) and posts the late completion.
 * Ignores terminate() for the in-flight band (kill-latency simulation -
 * the scheduled write still lands), then exits with the ack handshake.
 */
class SlowWorker extends LiveBase {
  /** Kick delays longer than the pool timeout: writes land post-timeout. */
  static delayMs = 80;
  wroteLate = false;

  protected override poll(): void {
    const seq = this.readSeq();
    if (seq === this.lastSeq || seq <= 0 || !this.ctl || !this.rgb) return;
    this.lastSeq = seq;
    const s = seq;
    const job = Atomics.load(this.ctl, CTL_JOB);
    this.later(() => {
      if (this.dead || !this.ctl || !this.rgb) return;
      const t0 = performance.now();
      let pixels = 0;
      let spans = 0;
      if (job === JOB_RGB) {
        const count = Atomics.load(this.ctl!, CTL_RGBCOUNT);
        const base = Atomics.load(this.ctl!, CTL_RGBBASE);
        const r = processRGBFrameJob(this.rgb!, this.w, this.h, count, this.y0, this.y1, base);
        pixels = r.pixels;
        spans = r.spans;
        try {
          Atomics.store(this.ctl!, CTL_PIXELS + this.band, pixels);
          Atomics.store(this.ctl!, CTL_SPANS + this.band, spans);
          Atomics.add(this.ctl!, CTL_DONE, 1);
        } catch {
          /* control torn down: bands still wrote */
        }
      }
      const execMs = performance.now() - t0;
      this.wroteLate = true;
      const b = this.band;
      this.onmessage?.({ data: { seq: s, band: b, pixels, spans, execMs } });
      // Kill-latency complete: exit with the acknowledged-stop handshake.
      this.later(() => {
        if (!this.dead) this.onmessage?.({ data: { exited: true, band: b } });
      }, 1);
    }, SlowWorker.delayMs);
  }

  override terminate(): void {
    // Ignored for the in-flight band (the scheduled write still lands,
    // like a worker stuck mid-raster); further kicks never come.
    this.terminateCount += 1;
  }
}

/**
 * Well-behaved quick worker: real band execution, immediate ack, honest
 * exit on terminate (models a healthy production worker for the
 * successful-path measurements).
 */
class QuickWorker extends LiveBase {
  protected override poll(): void {
    const seq = this.readSeq();
    if (seq === this.lastSeq || seq <= 0 || !this.ctl || !this.rgb) return;
    this.lastSeq = seq;
    const s = seq;
    const job = Atomics.load(this.ctl, CTL_JOB);
    this.later(() => {
      if (this.dead || !this.ctl || !this.rgb) return;
      const t0 = performance.now();
      let pixels = 0;
      let spans = 0;
      if (job === JOB_RGB) {
        const count = Atomics.load(this.ctl!, CTL_RGBCOUNT);
        const base = Atomics.load(this.ctl!, CTL_RGBBASE);
        const r = processRGBFrameJob(this.rgb!, this.w, this.h, count, this.y0, this.y1, base);
        pixels = r.pixels;
        spans = r.spans;
        try {
          Atomics.store(this.ctl!, CTL_PIXELS + this.band, pixels);
          Atomics.store(this.ctl!, CTL_SPANS + this.band, spans);
          Atomics.add(this.ctl!, CTL_DONE, 1);
        } catch {
          /* ignore */
        }
      }
      const execMs = performance.now() - t0;
      const b = this.band;
      if (!this.dead) this.onmessage?.({ data: { seq: s, band: b, pixels, spans, execMs } });
    }, 1);
  }

  override terminate(): void {
    this.terminateCount += 1;
    const b = this.band;
    this.later(() => {
      if (!this.dead) this.onmessage?.({ data: { exited: true, band: b } });
      this.forceStop();
    }, 1);
  }
}

/** Never-acking variant (ready only): kicks hang until timeout/dispose. */
class SilentWorker extends LiveBase {
}

/** Mute variant (never even ready): awaitReady times out. */
class MuteWorker extends LiveBase {
  override postMessage(_msg: FakeMsg): void {
    // Never attaches, never acks: the pool can never become ready.
  }
}

afterEach(() => {
  for (const f of Array.from(liveFakes)) {
    try {
      f.forceStop();
    } catch {
      /* ignore */
    }
  }
  liveFakes.clear();
  removeFakeDom();
});

function seedPools(pools: BrowserBandPool[]): void {
  for (const p of pools) {
    p.beginFrame();
    recClear(p);
  }
}

describe('PERF-NEXT-2 browser: recovery against a genuinely live writer', () => {
  it('hammering writer through timeout: isolate-then-restore converges to serial RGB565/depth/coverage/RGBA, stays stable, stops clean', { timeout: 30000 }, async () => {
    // Serial reference under well-behaved workers (never scribbled).
    installFakeDom(QuickWorker);
    const pal = testPalette();
    const ref = BrowserBandPool.create(2, W, H, { timeoutMs: 5000 });
    expect(ref).not.toBeNull();
    try {
      seedPools([ref!]);
      // Uninterrupted serial reference (opaque + translucent + additive).
      stageScene(ref!);
      seedForTest(ref!, SEED);
      ref!.drawInlineRGBAll(4, 32768, 0);
      const expected = copyPlanes(ref!);
      expect(expected.c.some((v) => v !== 0)).toBe(true);
      const expectedDisplay = resolveDisplayOf(ref!, pal);
      // Double-apply control (no clear): additive + alpha apply twice, so
      // it MUST differ - proves the comparison sees exactly-once
      // violations instead of vacuous equality.
      {
        const sab = ref!.rgbPlanes.rgb565.buffer as SharedArrayBuffer;
        const views = attachRGBAccum(sab, W, H).views;
        processRGBFrameJob(views, W, H, 3, 0, H, 1);
        const doubled = copyPlanes(ref!);
        expect(doubled.q).not.toEqual(Array.from(expected.q));
      }
      // Recovery case under genuinely-live rogue band workers.
      installFakeDom(HammerWorker);
      const pool = BrowserBandPool.create(2, W, H, { timeoutMs: 50 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        recClear(pool!);

        // Recovery case: capacity-refusal probe first (refused outcome is
        // selected BEFORE dispatch), then the hammer races everything.
        stageScene(pool!);
        const savedSlots = (pool as unknown as Record<string, unknown>)['rgbChainSlots'];
        (pool as unknown as Record<string, unknown>)['rgbChainSlots'] = RGB_MAX_CHAINS;
        const otherChain: RGBMipLevel[] = [{
          data: new Uint8Array(12).fill(9), width: 2, height: 2, mask: new Uint8Array(4).fill(255),
        }];
        expect(pool!.stageRGB(
          { spans: [makeSpan(0, SPAN_OPAQUE, 0.2)], count: 1 }, 0, 1,
          otherChain, LUX, 1, 1, WORLD_FLAGS, 0, 0, 0)).toBe(false);
        expect(pool!.rgbPending()).toBe(3);
        expect(pool!.kickStats().refusals.rgb).toBeGreaterThanOrEqual(1);
        (pool as unknown as Record<string, unknown>)['rgbChainSlots'] = savedSlots;
        seedForTest(pool!, SEED);

        // Liveness DURING the kick: the rogues start scribbling their band
        // rows once they observe the kick (never before - the pre-kick
        // planes, checkpoint and main-band rows stay deterministic).
        const oldQ = pool!.rgbPlanes.rgb565;
        const oldCover = pool!.rgbPlanes.cover;
        const oldBuf = oldQ.buffer;
        expect(oldBuf instanceof SharedArrayBuffer).toBe(true);
        const inFlight = pool!.flushRGBFrameAsync(4, 32768, 0);
        await waitFor(() => oldCover[5 * W + 5] === 1, 5000, 'hammer never wrote during the kick');

        // Kick proceeds (ready acked): the calling-thread band runs, no
        // completion ever arrives -> timeout -> 'partial' + quarantine +
        // isolation onto a replacement SAB before any restore/replay.
        const t0 = Date.now();
        const r = await inFlight;
        expect(Date.now() - t0).toBeLessThan(15000);
        expect(r).toBeNull();
        expect(pool!.lastRGBFailure()).toBe('partial');
        const ks = pool!.kickStats();
        expect(ks.fallbacks.rgb).toBe(1);
        expect(ks.kicks.rgb).toBe(0);
        expect(ks.quarantined).toBe(true);
        expect(ks.lastRgb).not.toBeNull();
        expect(ks.lastRgb!.workerCompleted).toBe(false);
        expect(ks.lastRgb!.descs).toBe(3);
        // Main-band completion proof: the calling thread really ran.
        expect(ks.lastRgb!.mainPixels).toBeGreaterThan(0);
        // Fence proof: isolation moved the pool (epoch bumped, fresh SAB).
        expect(pool!.recoveryEpoch()).toBe(1);
        expect(ks.epoch).toBe(1);
        expect(pool!.rgbPlanes.rgb565.buffer).not.toBe(oldBuf);
        // No cooperative exits: the hammer is STILL running on the old
        // buffer (no ack - isolation is the fence, not termination).
        expect(pool!.kickStats().exits).toBe(0);
        // Threat proof: the rogues really scribbled their band rows on the
        // ABANDONED buffer (garbage where the serial result has real
        // pixels), while the isolated planes carry the recovered result.
        expect(oldQ[5 * W + 5]).toBe(0xf800);

        // Recovery converges while the writer is STILL hammering the old
        // buffer: RGB565, depth, coverage and full-RGBA display match.
        const tally = pool!.recoverInlineRGBAll(() => seedForTest(pool!, SEED), 4, 32768, 0);
        expect(tally.spans).toBeGreaterThan(0);
        expectPlanesEqual(copyPlanes(pool!), expected);
        expect(Array.from(resolveDisplayOf(pool!, pal))).toEqual(Array.from(expectedDisplay));

        // Stable with the writer still live: no late mutation, no
        // shared-buffer reuse race.
        const calm = copyPlanes(pool!);
        const calmDisplay = resolveDisplayOf(pool!, pal);
        await sleep(150);
        expectPlanesEqual(copyPlanes(pool!), calm);
        expectPlanesEqual(copyPlanes(pool!), expected);
        expect(Array.from(resolveDisplayOf(pool!, pal))).toEqual(Array.from(calmDisplay));

        // Acknowledged stop: the writer was alive through recovery and now
        // provably stops (exit acks observed, bounded, no hang).
        const hammers = Array.from(liveFakes).filter(
          (f): f is HammerWorker => f instanceof HammerWorker);
        expect(hammers.length).toBe(2);
        for (const hm of hammers) {
          expect(hm.terminateCount).toBeGreaterThanOrEqual(1);
          hm.stop();
        }
        await waitFor(() => pool!.kickStats().exits === 2, 5000, 'exit acks never arrived');
        await sleep(50);
        expectPlanesEqual(copyPlanes(pool!), expected);
      } finally {
        await pool!.dispose();
        await ref!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });

  it('slow kick worker writes AFTER the timeout: late write fenced to the abandoned buffer, late ack ignored, replay exact', { timeout: 30000 }, async () => {
    installFakeDom(SlowWorker);
    SlowWorker.delayMs = 80;
    const pal = testPalette();
    try {
      const pool = BrowserBandPool.create(2, W, H, { timeoutMs: 50 });
      const ref = BrowserBandPool.create(2, W, H, { timeoutMs: 5000 });
      expect(pool).not.toBeNull();
      expect(ref).not.toBeNull();
      try {
        seedPools([pool!, ref!]);
        stageScene(ref!);
        seedForTest(ref!, SEED);
        ref!.drawInlineRGBAll(4, 32768, 0);
        const expected = copyPlanes(ref!);
        const expectedDisplay = resolveDisplayOf(ref!, pal);

        stageScene(pool!);
        seedForTest(pool!, SEED);
        const oldQ = pool!.rgbPlanes.rgb565;
        const oldCover = pool!.rgbPlanes.cover;
        const oldBuf = oldQ.buffer;

        // Both workers are slower than the kick timeout: timeout fires at
        // ~50ms, their real band writes land at ~80ms - DURING the recovery
        // window - onto the abandoned buffer.
        const r = await pool!.flushRGBFrameAsync(4, 32768, 0);
        expect(r).toBeNull();
        expect(pool!.lastRGBFailure()).toBe('partial');
        expect(pool!.recoveryEpoch()).toBe(1);
        expect(pool!.rgbPlanes.rgb565.buffer).not.toBe(oldBuf);

        // Fence proof: the late band writes really landed - but on the OLD
        // buffer (worker rows outside the main band gain coverage there).
        await waitFor(() => oldCover[5 * W + 5] === 1, 5000, 'late worker write never landed');
        // The recovered planes converge to serial anyway.
        const tally = pool!.recoverInlineRGBAll(() => seedForTest(pool!, SEED), 4, 32768, 0);
        expect(tally.spans).toBeGreaterThan(0);
        expectPlanesEqual(copyPlanes(pool!), expected);
        expect(Array.from(resolveDisplayOf(pool!, pal))).toEqual(Array.from(expectedDisplay));

        // Cooperative exits arrive (kill-latency complete); the late
        // completions for the dead kick are ignored (stale-completion
        // guard): no state change, still quarantined.
        await waitFor(() => pool!.kickStats().exits === 2, 5000, 'exit acks never arrived');
        const after = pool!.kickStats();
        expect(after.fallbacks.rgb).toBe(1);
        expect(after.kicks.rgb).toBe(0);
        expect(after.quarantined).toBe(true);
        expect(after.lastRgb!.workerCompleted).toBe(false);
        expect(after.lastRgb!.mainPixels).toBeGreaterThan(0);
      } finally {
        await pool!.dispose();
        await ref!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });

  it('disposal in flight resolves fast without quarantining (teardown, not wedged workers)', { timeout: 15000 }, async () => {
    installFakeDom(SilentWorker);
    try {
      const pool = BrowserBandPool.create(2, W, H, { timeoutMs: 5000 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        recClear(pool!);
        const world: Span[] = [];
        for (let y = 0; y < H; y++) world.push(makeSpan(y, SPAN_OPAQUE, 0.2));
        expect(pool!.stageRGB({ spans: world, count: world.length }, 0, world.length,
          tinyChain(7), LUX, 1, 1, WORLD_FLAGS, 0, 0, 0)).toBe(true);
        const t0 = Date.now();
        const pending = pool!.flushRGBFrameAsync(4, 32768, 0);
        await sleep(20);
        await pool!.dispose();
        await expect(pending).resolves.toBeNull();
        expect(Date.now() - t0).toBeLessThan(2000);
        // Teardown aborts as 'partial' (writes may have been in flight)
        // WITHOUT quarantining and WITHOUT isolating (epoch stays 0).
        expect(pool!.lastRGBFailure()).toBe('partial');
        expect(pool!.kickStats().quarantined).toBe(false);
        expect(pool!.recoveryEpoch()).toBe(0);
        // The dead timer never quarantines after the fact.
        await sleep(120);
        expect(pool!.kickStats().quarantined).toBe(false);
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });

  it('failure before writes: never-ready, disposed and quarantined flushes are clean refusals', { timeout: 30000 }, async () => {
    // Never-ready: awaitReady times out, nothing dispatched.
    installFakeDom(MuteWorker);
    try {
      const pool = BrowserBandPool.create(2, W, H, { timeoutMs: 60 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        recClear(pool!);
        const world: Span[] = [];
        for (let y = 0; y < H; y++) world.push(makeSpan(y, SPAN_OPAQUE, 0.2));
        expect(pool!.stageRGB({ spans: world, count: world.length }, 0, world.length,
          tinyChain(7), LUX, 1, 1, WORLD_FLAGS, 0, 0, 0)).toBe(true);
        await expect(pool!.flushRGBFrameAsync(4, 32768, 0)).resolves.toBeNull();
        expect(pool!.lastRGBFailure()).toBe('clean');
        expect(pool!.rgbPending()).toBe(1);
        const ks = pool!.kickStats();
        expect(ks.fallbacks.rgb).toBe(0);
        expect(ks.kicks.rgb).toBe(0);
        expect(ks.quarantined).toBe(false);
        expect(pool!.recoveryEpoch()).toBe(0);
        // Disposed pool: failure before dispatch, fast.
        await pool!.dispose();
        const t0 = Date.now();
        await expect(pool!.flushRGBFrameAsync(4, 32768, 0)).resolves.toBeNull();
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(pool!.lastRGBFailure()).toBe('clean');
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeFakeDom();
    }
    // Quarantined pool refuses fast (no second wait): terminal by design,
    // the next frame runs on a rebooted pool.
    installFakeDom(SilentWorker);
    try {
      const pool = BrowserBandPool.create(2, W, H, { timeoutMs: 60 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        recClear(pool!);
        expect(pool!.stageRGB({ spans: [], count: 0 }, 0, 0,
          tinyChain(7), null, 0, 0, 0, 16, 0, 0)).toBe(true);
        await expect(pool!.flushRGBFrameAsync(4, 32768, 0)).resolves.toBeNull();
        expect(pool!.kickStats().quarantined).toBe(true);
        const t0 = Date.now();
        await expect(pool!.flushRGBFrameAsync(4, 32768, 0)).resolves.toBeNull();
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(pool!.lastRGBFailure()).toBe('clean');
        expect(pool!.stageRGB({ spans: [], count: 0 }, 0, 0,
          tinyChain(7), null, 0, 0, 0, 16, 0, 0)).toBe(false);
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });

  it('checkpoint allocation failure refuses BEFORE dispatch: pool stays alive, replay exact, next kick succeeds', { timeout: 30000 }, async () => {
    installFakeDom(QuickWorker);
    const pal = testPalette();
    try {
      const pool = BrowserBandPool.create(2, W, H, { timeoutMs: 1000 });
      const ref = BrowserBandPool.create(2, W, H, { timeoutMs: 5000 });
      expect(pool).not.toBeNull();
      expect(ref).not.toBeNull();
      try {
        seedPools([pool!, ref!]);
        stageScene(ref!);
        seedForTest(ref!, SEED);
        ref!.drawInlineRGBAll(4, 32768, 0);
        const expected = copyPlanes(ref!);
        const expectedDisplay = resolveDisplayOf(ref!, pal);

        stageScene(pool!);
        seedForTest(pool!, SEED);
        // Force the checkpoint allocation failure (deterministic seam).
        (pool as unknown as { testDropSnapshot?: boolean }).testDropSnapshot = true;
        const t0 = Date.now();
        const r = await pool!.flushRGBFrameAsync(4, 32768, 0);
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(r).toBeNull();
        // Refused outcome: nothing dispatched ('clean'), pending intact,
        // NOT a fallback, NOT quarantined, workers alive, epoch unmoved.
        expect(pool!.lastRGBFailure()).toBe('clean');
        expect(pool!.rgbPending()).toBe(3);
        const ks = pool!.kickStats();
        expect(ks.fallbacks.rgb).toBe(0);
        expect(ks.kicks.rgb).toBe(0);
        expect(ks.quarantined).toBe(false);
        expect(pool!.recoveryEpoch()).toBe(0);
        // The exact retained replay converges (translucent + additive
        // exactly once), incl. full-RGBA display.
        const tally = pool!.recoverInlineRGBAll(() => seedForTest(pool!, SEED), 4, 32768, 0);
        expect(tally.spans).toBeGreaterThan(0);
        expectPlanesEqual(copyPlanes(pool!), expected);
        expect(Array.from(resolveDisplayOf(pool!, pal))).toEqual(Array.from(expectedDisplay));
        // The pool is unharmed: the next kick dispatches and succeeds on
        // workers (no best-effort replay over partial writes happened).
        pool!.beginFrame();
        recClear(pool!);
        stageScene(pool!);
        const ok = await pool!.flushRGBFrameAsync(4, 32768, 0);
        expect(ok).not.toBeNull();
        expect(pool!.kickStats().kicks.rgb).toBe(1);
        expect(pool!.kickStats().lastRgb!.workerCompleted).toBe(true);
        expect(pool!.kickStats().quarantined).toBe(false);
        expect(pool!.recoveryEpoch()).toBe(0);
        pool!.commitRGB();
      } finally {
        await pool!.dispose();
        await ref!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });

  it('successful-path overhead: no isolation churn, per-kick cost + checkpoint bytes reported', { timeout: 60000 }, async () => {
    installFakeDom(QuickWorker);
    try {
      const pool = BrowserBandPool.create(2, W, H, { timeoutMs: 2000 });
      const ref = BrowserBandPool.create(2, W, H, { timeoutMs: 5000 });
      expect(pool).not.toBeNull();
      expect(ref).not.toBeNull();
      try {
        const N = 8;
        const kickMs: number[] = [];
        const firstBuf = pool!.rgbPlanes.rgb565.buffer;
        for (let i = 0; i < N; i++) {
          pool!.beginFrame();
          recClear(pool!);
          stageScene(pool!);
          seedForTest(pool!, SEED);
          const t0 = performance.now();
          const r = await pool!.flushRGBFrameAsync(4, 32768, 0);
          kickMs.push(performance.now() - t0);
          expect(r).not.toBeNull();
          pool!.commitRGB();
          // No successful-path isolation churn: same SAB every kick.
          expect(pool!.rgbPlanes.rgb565.buffer).toBe(firstBuf);
        }
        // Serial parity on the last frame (pooled workers == inline).
        ref!.beginFrame();
        recClear(ref!);
        stageScene(ref!);
        seedForTest(ref!, SEED);
        ref!.drawInlineRGBAll(4, 32768, 0);
        expectPlanesEqual(copyPlanes(pool!), copyPlanes(ref!));
        const ks = pool!.kickStats();
        expect(ks.kicks.rgb).toBe(N);
        expect(ks.fallbacks.rgb).toBe(0);
        expect(ks.quarantined).toBe(false);
        expect(ks.epoch).toBe(0);
        const sorted = [...kickMs].sort((a, b) => a - b);
        const mean = kickMs.reduce((a, b) => a + b, 0) / kickMs.length;
        const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
        const checkpointBytes = W * H * (2 + 1 + 2);
        const staged = pool!.kickBytes();
        console.log(
          `[web-recovery-overhead] ${W}x${H} ${N} pooled RGB kicks: ` +
          `mean=${mean.toFixed(2)}ms p95=${p95.toFixed(2)}ms ` +
          `checkpoint=${checkpointBytes}B/kick ` +
          `staged=${staged ? staged.total : -1}B/kick ` +
          `(isolate-before-restore adds no success-path copies: one null-check)`,
        );
      } finally {
        await pool!.dispose();
        await ref!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });

  it('next frame: rebooted pool converges exactly, quarantined pool refuses fast without hanging', { timeout: 30000 }, async () => {
    installFakeDom(HammerWorker);
    try {
      const pool = BrowserBandPool.create(2, W, H, { timeoutMs: 50 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        recClear(pool!);
        stageScene(pool!);
        seedForTest(pool!, SEED);
        const oldCover = pool!.rgbPlanes.cover;
        const inFlight = pool!.flushRGBFrameAsync(4, 32768, 0);
        await waitFor(() => oldCover[5 * W + 5] === 1, 5000, 'hammer never wrote during the kick');
        await expect(inFlight).resolves.toBeNull();
        expect(pool!.kickStats().quarantined).toBe(true);
        pool!.recoverInlineRGBAll(() => seedForTest(pool!, SEED), 4, 32768, 0);
        const recovered = copyPlanes(pool!);
        // Quarantined pool: next frame refuses fast and clean, no hang, no
        // shared-buffer reuse (planes untouched by the refused frame).
        pool!.beginFrame();
        expect(pool!.rgbPending()).toBe(0);
        const t0 = Date.now();
        await expect(pool!.flushRGBFrameAsync(4, 32768, 0)).resolves.toBeNull();
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(pool!.lastRGBFailure()).toBe('clean');
        expectPlanesEqual(copyPlanes(pool!), recovered);
      } finally {
        await pool!.dispose();
      }
      // Rebooted pool (fresh SAB + workers): the next frame converges.
      removeFakeDom();
      installFakeDom(QuickWorker);
      const pool2 = BrowserBandPool.create(2, W, H, { timeoutMs: 2000 });
      const ref = BrowserBandPool.create(2, W, H, { timeoutMs: 5000 });
      expect(pool2).not.toBeNull();
      expect(ref).not.toBeNull();
      try {
        pool2!.beginFrame();
        recClear(pool2!);
        stageScene(pool2!);
        seedForTest(pool2!, SEED);
        const r = await pool2!.flushRGBFrameAsync(4, 32768, 0);
        expect(r).not.toBeNull();
        ref!.beginFrame();
        recClear(ref!);
        stageScene(ref!);
        seedForTest(ref!, SEED);
        ref!.drawInlineRGBAll(4, 32768, 0);
        expectPlanesEqual(copyPlanes(pool2!), copyPlanes(ref!));
        expect(pool2!.rgbFlushed()).toBe(3);
        pool2!.commitRGB();
        expect(pool2!.rgbPending()).toBe(0);
      } finally {
        await pool2!.dispose();
        await ref!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });
});

/** Sanity: the shared-accum layout helper sizes the isolation copy. */
describe('recovery isolation sizing', () => {
  it('rgbAccumTotal covers the full shared SAB the fence copies', () => {
    // Three RGB planes per kick checkpoint: rgb565 (2B) + cover (1B) +
    // depth (2B) per pixel - the PERF-NEXT-3 input number at 640x480 is
    // 1536000 B/kick; the quarantine-time isolation copy is one SAB, not
    // per-kick churn (assert the layout, not the policy).
    expect(rgbAccumTotal(W, H)).toBeGreaterThan(W * H * 5);
    expect(W * H * 5).toBe(64 * 48 * 5);
    expect(640 * 480 * 5).toBe(1536000);
  });
});
