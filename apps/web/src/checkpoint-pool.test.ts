// PERF-NEXT-3: pooled RGB checkpoints — no steady-state allocation per
// kick, bounded retention, identical recovery.
//
// What this pins (apps/web only, same in-thread SAB protocol as the
// PERF-NEXT-2 live-writer tests):
//  - successful kicks reuse ONE spare: N kicks after warmup allocate zero
//    snapshot storage (allocs stays 1); copied bytes per kick stay the
//    full frame × 5 B/px (15,360 B at 64×48 — dirty ranges evaluated and
//    rejected, see render-workers.ts), not a discarded-and-reallocated
//    copy.
//  - pooled restore converges after a timeout with blends: the retained
//    full-frame snapshot + recoverInlineRGBAll matches the serial
//    reference across RGB565, depth, coverage and full-RGBA display
//    (exactly-once alpha/additive preserved), for blend and opaque-only
//    suffixes, with exactly one spare allocation each.
//  - refused-before-dispatch keeps every PERF-NEXT-2 guarantee (clean,
//    pending intact, no fallback, pool alive) and allocates the spare
//    exactly once on the next success.
//  - retention is bounded: one spare of the current size class, freed on
//    dispose; a resize-shaped reboot (new pool) allocates exactly once;
//    a 20-frame soak never allocates again.
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
const BYTES_PER_PX = 2 + 1 + 2;

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

function makeSpan(y: number, kind: number, iz: number, w: number): Span {
  const s = createSpan();
  s.kind = kind;
  s.y = y;
  s.x0 = 0;
  s.x1 = w;
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

function stageWorld(pool: BrowserBandPool, w: number, h: number): void {
  const world: Span[] = [];
  for (let y = 0; y < h; y++) world.push(makeSpan(y, SPAN_OPAQUE, 0.2, w));
  expect(pool.stageRGB({ spans: world, count: world.length }, 0, world.length,
    tinyChain(7), LUX, 1, 1, WORLD_FLAGS, 0, 0, 0)).toBe(true);
}

/** Narrow translucent + additive foreground bands (rows y0..y1, y2..y3). */
function stageNarrowFG(pool: BrowserBandPool, w: number, y0: number, y1: number, y2: number, y3: number): void {
  const fg: Span[] = [];
  for (let y = y0; y < y1; y++) fg.push(makeSpan(y, SPAN_TRANS66, 0.24, w));
  expect(pool.stageRGB({ spans: fg, count: fg.length }, 0, fg.length,
    tinyChain(200), LUX, 1, 1, FG_FLAGS, 0, 0, 0)).toBe(true);
  const add: Span[] = [];
  for (let y = y2; y < y3; y++) add.push(makeSpan(y, SPAN_ADD, 0.26, w));
  expect(pool.stageRGB({ spans: add, count: add.length }, 0, add.length,
    tinyChain(45), LUX, 1, 1, ADD_FLAGS, 0, 0, 0)).toBe(true);
}

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

function resolveDisplayOf(pool: BrowserBandPool, pal: Uint8Array, h: number, w: number): Uint32Array {
  const p = pool.planes;
  const rp = pool.rgbPlanes;
  const color = Uint32Array.from(p.color);
  resolveBandFused(color, pal, p.idx, rp.rgb565, rp.cover, 0, h, w, h);
  return color;
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

const liveFakes = new Set<{ forceStop: () => void }>();

class LiveBase {
  onmessage: ((ev: { data: FakeMsg }) => void) | null = null;
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
    this.forceStop();
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

/** Well-behaved worker: real band execution, immediate ack. */
class QuickWorker extends LiveBase {
  protected override poll(): void {
    const seq = this.readSeq();
    if (seq === this.lastSeq || seq <= 0 || !this.ctl || !this.rgb) return;
    this.lastSeq = seq;
    const s = seq;
    const job = Atomics.load(this.ctl, CTL_JOB);
    this.later(() => {
      if (this.dead || !this.ctl || !this.rgb) return;
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
      const b = this.band;
      if (!this.dead) this.onmessage?.({ data: { seq: s, band: b, pixels, spans } });
    }, 1);
  }
}

/** Never-acking worker (ready only): kicks hang until timeout. */
class SilentWorker extends LiveBase {
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

describe('PERF-NEXT-3 pooled RGB checkpoints', () => {
  it('successful kicks reuse one spare: zero steady-state allocation, full-frame copies', { timeout: 30000 }, async () => {
    installFakeDom(QuickWorker);
    try {
      const pool = BrowserBandPool.create(2, W, H, { timeoutMs: 5000 });
      expect(pool).not.toBeNull();
      try {
        expect(pool!.checkpointStats()).toEqual({
          allocs: 0, snapshots: 0, restores: 0,
          copiedBytes: 0, lastBytes: 0, lastRows: 0, spareBytes: 0,
        });
        // Warmup: full-frame world kick allocates the single spare.
        pool!.beginFrame();
        recClear(pool!);
        stageWorld(pool!, W, H);
        const out = await pool!.flushRGBFrameAsync(4, 32768, 0);
        expect(out).not.toBeNull();
        expect(pool!.kickStats().kicks.rgb).toBe(1);
        const fullBytes = H * W * BYTES_PER_PX;
        expect(fullBytes).toBe(15360);
        let st = pool!.checkpointStats();
        expect(st.allocs).toBe(1);
        expect(st.snapshots).toBe(1);
        expect(st.restores).toBe(0);
        expect(st.lastBytes).toBe(fullBytes);
        expect(st.lastRows).toBe(H);
        expect(st.copiedBytes).toBe(fullBytes);
        expect(st.spareBytes).toBe(fullBytes);
        // Narrow foreground kick: same spare, full-frame copy (dirty ranges
        // rejected — see render-workers.ts; the copy cost is per-kick
        // bytes, the allocation cost is zero).
        stageNarrowFG(pool!, W, 10, 20, 30, 36);
        const out2 = await pool!.flushRGBFrameAsync(4, 32768, 0);
        expect(out2).not.toBeNull();
        expect(pool!.kickStats().kicks.rgb).toBe(2);
        // Copies stay full-frame even for a narrow suffix (dirty ranges
        // rejected — see render-workers.ts); the allocation cost is zero.
        const narrowBytes = fullBytes;
        st = pool!.checkpointStats();
        expect(st.allocs).toBe(1);
        expect(st.snapshots).toBe(2);
        expect(st.lastBytes).toBe(narrowBytes);
        expect(st.lastRows).toBe(H);
        expect(st.copiedBytes).toBe(fullBytes + narrowBytes);
        expect(st.spareBytes).toBe(fullBytes);
        // Zero-span batch: kick succeeds, snapshot still refreshes the
        // full-frame spare (no special-casing on the recovery path).
        expect(pool!.stageRGB({ spans: [], count: 0 }, 0, 0,
          tinyChain(7), null, 0, 0, 0, 16, 0, 0)).toBe(true);
        const out3 = await pool!.flushRGBFrameAsync(4, 32768, 0);
        expect(out3).not.toBeNull();
        st = pool!.checkpointStats();
        expect(st.allocs).toBe(1);
        expect(st.snapshots).toBe(3);
        expect(st.lastBytes).toBe(fullBytes);
        expect(st.lastRows).toBe(H);
        expect(st.spareBytes).toBe(fullBytes);
        // Soak-shaped: 5 more frames, still exactly one spare allocation.
        for (let f = 0; f < 5; f++) {
          pool!.beginFrame();
          recClear(pool!);
          stageWorld(pool!, W, H);
          const r = await pool!.flushRGBFrameAsync(4, 32768, 0);
          expect(r).not.toBeNull();
        }
        st = pool!.checkpointStats();
        expect(st.allocs).toBe(1);
        expect(st.snapshots).toBe(8);
        expect(st.restores).toBe(0);
        expect(st.spareBytes).toBe(fullBytes);
        expect(pool!.kickStats().kicks.rgb).toBe(8);
        expect(pool!.kickStats().fallbacks.rgb).toBe(0);
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });

  it('pooled restore converges after timeout (blend + opaque-only suffixes)', { timeout: 30000 }, async () => {
    const pal = testPalette();
    // Case A: blend suffix in rows 0..36 (alpha + additive over clear).
    installFakeDom(QuickWorker);
    const refA = BrowserBandPool.create(2, W, H, { timeoutMs: 5000 });
    expect(refA).not.toBeNull();
    refA!.beginFrame();
    recClear(refA!);
    seedForTest(refA!, SEED);
    stageNarrowFG(refA!, W, Math.floor(H / 4), Math.floor((3 * H) / 4), 0, Math.floor(H / 4));
    refA!.drawInlineRGBAll(4, 32768, 0);
    const expectedA = copyPlanes(refA!);
    expect(expectedA.c.some((v) => v !== 0)).toBe(true);
    const expectedDisplayA = resolveDisplayOf(refA!, pal, H, W);
    await refA!.dispose();
    // Case B: opaque-only suffix in rows 10..20 (in-place suffix replay).
    const refB = BrowserBandPool.create(2, W, H, { timeoutMs: 5000 });
    expect(refB).not.toBeNull();
    refB!.beginFrame();
    recClear(refB!);
    seedForTest(refB!, SEED);
    const narrowOpaque: Span[] = [];
    for (let y = 10; y < 20; y++) narrowOpaque.push(makeSpan(y, SPAN_OPAQUE, 0.2, W));
    expect(refB!.stageRGB({ spans: narrowOpaque, count: narrowOpaque.length }, 0, narrowOpaque.length,
      tinyChain(7), LUX, 1, 1, WORLD_FLAGS, 0, 0, 0)).toBe(true);
    refB!.drawInlineRGBAll(4, 32768, 0);
    const expectedB = copyPlanes(refB!);
    const expectedDisplayB = resolveDisplayOf(refB!, pal, H, W);
    await refB!.dispose();
    removeFakeDom();

    installFakeDom(SilentWorker);
    try {
      // Case A: blend suffix -> quarantine -> pooled full-frame restore ->
      // blend-path replay matches serial (exactly-once blends).
      const poolA = BrowserBandPool.create(2, W, H, { timeoutMs: 60 });
      expect(poolA).not.toBeNull();
      try {
        poolA!.beginFrame();
        recClear(poolA!);
        seedForTest(poolA!, SEED);
        stageNarrowFG(poolA!, W, Math.floor(H / 4), Math.floor((3 * H) / 4), 0, Math.floor(H / 4));
        const rA = await poolA!.flushRGBFrameAsync(4, 32768, 0);
        expect(rA).toBeNull();
        expect(poolA!.lastRGBFailure()).toBe('partial');
        expect(poolA!.recoveryEpoch()).toBe(1);
        const stA = poolA!.checkpointStats();
        expect(stA.allocs).toBe(1);
        expect(stA.restores).toBe(1);
        expect(stA.lastBytes).toBe(H * W * BYTES_PER_PX);
        expect(stA.lastRows).toBe(H);
        const tallyA = poolA!.recoverInlineRGBAll(() => seedForTest(poolA!, SEED), 4, 32768, 0);
        expect(tallyA.spans).toBeGreaterThan(0);
        expectPlanesEqual(copyPlanes(poolA!), expectedA);
        expect(Array.from(resolveDisplayOf(poolA!, pal, H, W))).toEqual(Array.from(expectedDisplayA));
        expect(poolA!.checkpointStats().allocs).toBe(1);
      } finally {
        await poolA!.dispose();
      }
      // Case B: opaque-only suffix -> quarantine -> pooled full-frame
      // restore -> in-place suffix replay matches serial.
      const poolB = BrowserBandPool.create(2, W, H, { timeoutMs: 60 });
      expect(poolB).not.toBeNull();
      try {
        poolB!.beginFrame();
        recClear(poolB!);
        seedForTest(poolB!, SEED);
        const narrowOpaqueB: Span[] = [];
        for (let y = 10; y < 20; y++) narrowOpaqueB.push(makeSpan(y, SPAN_OPAQUE, 0.2, W));
        expect(poolB!.stageRGB({ spans: narrowOpaqueB, count: narrowOpaqueB.length }, 0, narrowOpaqueB.length,
          tinyChain(7), LUX, 1, 1, WORLD_FLAGS, 0, 0, 0)).toBe(true);
        const rB = await poolB!.flushRGBFrameAsync(4, 32768, 0);
        expect(rB).toBeNull();
        expect(poolB!.lastRGBFailure()).toBe('partial');
        const stB = poolB!.checkpointStats();
        expect(stB.allocs).toBe(1);
        expect(stB.restores).toBe(1);
        expect(stB.lastBytes).toBe(H * W * BYTES_PER_PX);
        expect(stB.lastRows).toBe(H);
        const tallyB = poolB!.recoverInlineRGBAll(() => seedForTest(poolB!, SEED), 4, 32768, 0);
        expect(tallyB.spans).toBeGreaterThan(0);
        expectPlanesEqual(copyPlanes(poolB!), expectedB);
        expect(Array.from(resolveDisplayOf(poolB!, pal, H, W))).toEqual(Array.from(expectedDisplayB));
      } finally {
        await poolB!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });

  it('refused-before-dispatch keeps PERF-NEXT-2 guarantees and allocates the spare exactly once', { timeout: 30000 }, async () => {
    installFakeDom(QuickWorker);
    try {
      const pool = BrowserBandPool.create(2, W, H, { timeoutMs: 1000 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        recClear(pool!);
        stageWorld(pool!, W, H);
        (pool as unknown as { testDropSnapshot?: boolean }).testDropSnapshot = true;
        const t0 = Date.now();
        const r = await pool!.flushRGBFrameAsync(4, 32768, 0);
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(r).toBeNull();
        // Refused outcome: nothing dispatched ('clean'), pending intact,
        // NOT a fallback, NOT quarantined, workers alive, epoch unmoved.
        expect(pool!.lastRGBFailure()).toBe('clean');
        expect(pool!.rgbPending()).toBe(1);
        const ks = pool!.kickStats();
        expect(ks.fallbacks.rgb).toBe(0);
        expect(ks.kicks.rgb).toBe(0);
        expect(ks.quarantined).toBe(false);
        expect(pool!.recoveryEpoch()).toBe(0);
        // The probe freed the (nonexistent) spare: no storage retained.
        let st = pool!.checkpointStats();
        expect(st.allocs).toBe(0);
        expect(st.spareBytes).toBe(0);
        // Next kick succeeds and allocates the single spare once; further
        // kicks reuse it.
        const ok = await pool!.flushRGBFrameAsync(4, 32768, 0);
        expect(ok).not.toBeNull();
        st = pool!.checkpointStats();
        expect(st.allocs).toBe(1);
        expect(st.spareBytes).toBe(H * W * BYTES_PER_PX);
        for (let f = 0; f < 3; f++) {
          pool!.beginFrame();
          recClear(pool!);
          stageWorld(pool!, W, H);
          const rr = await pool!.flushRGBFrameAsync(4, 32768, 0);
          expect(rr).not.toBeNull();
        }
        expect(pool!.checkpointStats().allocs).toBe(1);
        expect(pool!.kickStats().fallbacks.rgb).toBe(0);
      } finally {
        await pool!.dispose();
      }
    } finally {
      removeFakeDom();
    }
  });

  it('bounded retention: dispose frees the spare, resize-shaped reboot allocates once, soak stays flat', { timeout: 30000 }, async () => {
    installFakeDom(QuickWorker);
    try {
      const pool = BrowserBandPool.create(2, W, H, { timeoutMs: 5000 });
      expect(pool).not.toBeNull();
      try {
        pool!.beginFrame();
        recClear(pool!);
        stageWorld(pool!, W, H);
        expect(await pool!.flushRGBFrameAsync(4, 32768, 0)).not.toBeNull();
        expect(pool!.checkpointStats().spareBytes).toBe(H * W * BYTES_PER_PX);
      } finally {
        await pool!.dispose();
        // Freed: no retained buffers across the pool lifetime.
        expect(pool!.checkpointStats().spareBytes).toBe(0);
      }
      // Resize is a new pool (dimensions are fixed per pool): exactly one
      // spare of the new size class, never the stale one.
      const W2 = 96;
      const H2 = 40;
      const pool2 = BrowserBandPool.create(2, W2, H2, { timeoutMs: 5000 });
      expect(pool2).not.toBeNull();
      try {
        expect(pool2!.checkpointStats().spareBytes).toBe(0);
        pool2!.beginFrame();
        recClear(pool2!);
        stageWorld(pool2!, W2, H2);
        expect(await pool2!.flushRGBFrameAsync(4, 32768, 0)).not.toBeNull();
        let st = pool2!.checkpointStats();
        expect(st.allocs).toBe(1);
        expect(st.spareBytes).toBe(H2 * W2 * BYTES_PER_PX);
        // 20-frame soak with narrow + full kicks: still one allocation,
        // spare size constant.
        for (let f = 0; f < 20; f++) {
          pool2!.beginFrame();
          recClear(pool2!);
          if (f % 2 === 0) {
            stageWorld(pool2!, W2, H2);
          } else {
            const fg: Span[] = [];
            for (let y = 5; y < 15; y++) fg.push(makeSpan(y, SPAN_TRANS66, 0.24, W2));
            expect(pool2!.stageRGB({ spans: fg, count: fg.length }, 0, fg.length,
              tinyChain(200), LUX, 1, 1, FG_FLAGS, 0, 0, 0)).toBe(true);
          }
          const r = await pool2!.flushRGBFrameAsync(4, 32768, 0);
          expect(r).not.toBeNull();
        }
        st = pool2!.checkpointStats();
        expect(st.allocs).toBe(1);
        expect(st.spareBytes).toBe(H2 * W2 * BYTES_PER_PX);
        expect(st.restores).toBe(0);
        expect(pool2!.kickStats().kicks.rgb).toBe(21);
        expect(pool2!.kickStats().fallbacks.rgb).toBe(0);
      } finally {
        await pool2!.dispose();
        expect(pool2!.checkpointStats().spareBytes).toBe(0);
      }
    } finally {
      removeFakeDom();
    }
  });
});
