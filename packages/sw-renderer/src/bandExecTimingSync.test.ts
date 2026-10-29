// PERF-NEXT-4 (integrator): sync-kick exec harvest from shared memory.
//
// The sync pool path blocks the main thread in Atomics.wait, so completion
// messages queue unread — but every executed band wrote its worker-local
// duration into CTL_EXEC before the DONE fence. `harvestSyncExec` feeds the
// identical samples from shared memory. Proves, through the REAL built
// worker bundle on real threads:
// - sync flushFrame publishes finite execMs + identity via testBandExecStats
// - queued completion posts arriving later do NOT double-feed accumulation
// - disabled timing (workerTiming:false) publishes nothing (legacy shape)
import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { BandWorkerPool } from './bandPool.js';
import {
  buildColormap, defaultPalette,
  packFrameSpans, splitBands,
  R_FLAG_REPEAT, R_FLAG_DEPTHWRITE, R_FLAG_LIGHT, R_FLAG_OPAQUE,
  type Span, type Texture, type LightBlock,
} from './index.js';
import { SPAN_OPAQUE, createSpan } from './spans.js';

function distOrSkip(): string | null {
  const distUrl = new URL('../dist/index.mjs', import.meta.url);
  if (!existsSync(distUrl)) {
    console.log('SKIP sync exec harvest test: dist not built (run yarn build first)');
    return null;
  }
  return distUrl.pathname;
}

function makeSpan(y: number, W: number): Span {
  const s = createSpan();
  s.kind = SPAN_OPAQUE;
  s.y = y;
  s.x0 = 0; s.x1 = W;
  s.iz = 0.05; s.diz = 0;
  s.uz = 8; s.duz = 0;
  s.vz = 8; s.dvz = 0;
  s.light = 200; s.dlight = 0;
  s.lu = 0; s.lv = 0; s.dlu = 0;
  s.turb = 0; s.ord = 0;
  s.dudy = 0; s.dvdy = 0;
  return s;
}

describe('PERF-NEXT-4: sync kicks harvest worker exec from shared memory', () => {
  it('sync flushFrame: finite execMs + identity, exactly once per band', { timeout: 120000 }, async () => {
    const dist = distOrSkip();
    if (!dist) return;
    const W = 96, H = 60;
    const pool = BandWorkerPool.create(2, W, H, { indexJsPath: dist });
    if (!pool) throw new Error('pool create failed (need worker_threads + SAB + Atomics.wait)');
    try {
      expect(pool.testBandExecStats()).toBeNull();
      pool.beginFrame();
      const colormap = buildColormap(defaultPalette());
      const cursor = pool.flatCursor();
      if (!cursor) throw new Error('no flat cursor');
      const spans: Span[] = [];
      for (let y = 0; y < H; y++) spans.push(makeSpan(y, W));
      const packed = packFrameSpans(
        { spans, count: spans.length }, cursor.F, cursor.I, cursor.base, cursor.base, cursor.cap,
      );
      if (!packed) throw new Error('pack failed');
      const tex: Texture = { width: 4, height: 4, texels: new Uint8Array(16).fill(7) };
      const light: LightBlock = { width: 1, height: 1, values: new Uint8Array([200]) };
      expect(pool.packBatched(cursor.base, packed.count, tex, light, colormap, 0)).toBe(true);
      const r = pool.flushFrame();
      expect(r).not.toBeNull();
      expect(r!.pixels).toBe(W * H);
      const samples = pool.testBandExecStats();
      expect(samples).not.toBeNull();
      expect(samples!.length).toBe(2);
      const bands = splitBands(H, 3);
      for (const s of samples!) {
        expect(typeof s.execMs).toBe('number');
        expect(Number.isFinite(s.execMs)).toBe(true);
        expect(s.execMs).toBeGreaterThanOrEqual(0);
        expect(s.job).toBe('indexed-frame');
        expect(s.y0).toBe(bands[s.band]!.y0);
        expect(s.y1).toBe(bands[s.band]!.y1);
        expect(s.pixels + 0).toBeGreaterThan(0);
      }
      const seqs = new Set(samples!.map((s) => s.seq));
      expect(seqs.size).toBe(1);
      // Yield to the event loop so any queued completion posts dispatch;
      // the slot-harvest mark must drop them (exactly-once accumulation).
      const n0 = samples!.length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const again = pool.testBandExecStats();
      expect(again).not.toBeNull();
      expect(again!.length).toBe(n0);
    } finally {
      await pool.dispose();
    }
  });

  it('disabled timing: sync kick publishes nothing (legacy shape)', { timeout: 120000 }, async () => {
    const dist = distOrSkip();
    if (!dist) return;
    const W = 64, H = 48;
    const pool = BandWorkerPool.create(1, W, H, { indexJsPath: dist, workerTiming: false });
    if (!pool) throw new Error('pool create failed');
    try {
      pool.beginFrame();
      const r = pool.flushFrame();
      expect(r).not.toBeNull();
      expect(pool.lastWorkerExec()).toBeNull();
      expect(pool.testBandExecStats()).toBeNull();
      expect(r!.mainExecMs).toBeUndefined();
    } finally {
      await pool.dispose();
    }
  });
});
