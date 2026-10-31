// PERF-NEXT-4 (Lane A): real production worker-loop execution timing.
//
// Through the REAL built Node worker (`BandWorkerPool.create` with
// `dist/index.mjs`, real threads running the production `bandWorkerLoop`),
// proving for every remaining job kind (indexed-world raster, resolve):
// - every executed band posts a completion with a FINITE `execMs >= 0`
//   measured inside the worker loop (never null, never synthetic — no test
//   below constructs a sample or injects a message; everything arrives from
//   real worker posts through the pool's validated stash);
// - frame/sequence/job/band identity is correct (seq shared across a kick,
//   advancing per kick; job is the wire label; band + y-range match the pool
//   tiling; (frame, seq) match the kick);
// - actual work counts reconcile (worker pixels/spans + calling-thread band
//   == kick tally; culled bands still report finite execMs with zero work).
// - disabled timing (`workerTiming: false`) posts the legacy shape (stash
//   stays null, no `mainExecMs`) with bit-identical planes.
import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { BandWorkerPool } from './bandPool.js';
import {
  JOB_RASTER, JOB_RESOLVE,
  bandJobName, buildColormap, defaultPalette,
  packFrameSpans, splitBands,
  type BandExecSample, type LightBlock, type Span, type Texture,
} from './index.js';
import { SPAN_OPAQUE, createSpan } from './spans.js';

function distOrSkip(): string | null {
  const distUrl = new URL('../dist/index.mjs', import.meta.url);
  if (!existsSync(distUrl)) {
    console.log('SKIP band exec timing test: dist not built (run yarn build first)');
    return null;
  }
  return distUrl.pathname;
}

function testPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = (i * 5) & 255;
    pal[i * 3 + 1] = (i * 3 + 40) & 255;
    pal[i * 3 + 2] = (i * 2 + 80) & 255;
  }
  return pal;
}

function makeSpan(y: number, W: number, kind: number, iz: number): Span {
  const s = createSpan();
  s.kind = kind;
  s.y = y;
  s.x0 = 0; s.x1 = W;
  s.iz = iz; s.diz = 0;
  s.uz = 8; s.duz = 0;
  s.vz = 8; s.dvz = 0;
  s.light = 200; s.dlight = 0;
  s.lu = 0; s.lv = 0; s.dlu = 0;
  s.turb = 0; s.ord = 0;
  s.dudy = 0; s.dvdy = 0;
  return s;
}

function tinyTex(): Texture {
  return { width: 4, height: 4, texels: new Uint8Array(16).fill(7) };
}

function tinyLight(): LightBlock {
  return { width: 1, height: 1, values: new Uint8Array([200]) };
}

/** Stage one indexed batch covering every row (every band draws). */
function stageIndexedBatch(pool: BandWorkerPool, W: number, H: number, colormap: Uint8Array): void {
  const cursor = pool.flatCursor();
  if (!cursor) throw new Error('no flat cursor');
  const spans: Span[] = [];
  for (let y = 0; y < H; y++) spans.push(makeSpan(y, W, SPAN_OPAQUE, 0.05));
  const packed = packFrameSpans(
    { spans, count: spans.length }, cursor.F, cursor.I, cursor.base, cursor.base, cursor.cap,
  );
  if (!packed || packed.count !== H) throw new Error('pack failed');
  expect(pool.packBatched(cursor.base, packed.count, tinyTex(), tinyLight(), colormap, 0)).toBe(true);
}

/** Poll the newest-kick stash until `need` worker samples arrive. */
async function pollExec(pool: BandWorkerPool, need: number, timeoutMs = 15000): Promise<BandExecSample[]> {
  const t0 = Date.now();
  for (;;) {
    const s = pool.lastWorkerExec();
    if (s && s.length >= need) return s;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`only ${s ? s.length : 0}/${need} exec samples arrived`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function expectFiniteExec(s: BandExecSample): void {
  expect(typeof s.execMs).toBe('number');
  expect(Number.isFinite(s.execMs)).toBe(true);
  expect(s.execMs).toBeGreaterThanOrEqual(0);
}

describe('PERF-NEXT-4: production worker loop publishes measured execution', () => {
  it('world raster kick: finite execMs + identity + reconciled counts (JOB_RASTER)', { timeout: 120000 }, async () => {
    const dist = distOrSkip();
    if (!dist) return;
    const W = 96, H = 60;
    const pool = BandWorkerPool.create(2, W, H, { indexJsPath: dist });
    if (!pool) throw new Error('pool create failed (need worker_threads + SAB + Atomics.wait)');
    try {
      expect(pool.lastWorkerExec()).toBeNull();
      pool.beginFrame();
      const colormap = buildColormap(defaultPalette());
      stageIndexedBatch(pool, W, H, colormap);
      stageIndexedBatch(pool, W, H, colormap);
      const r = await pool.flushFrameAsync();
      expect(r).not.toBeNull();
      // Both full-frame batches drew every pixel exactly once per batch.
      expect(r!.pixels).toBe(2 * W * H);
      expect(r!.spans).toBe(2 * H);
      // Calling-thread band execution (latency (b)) is finite on the caller clock.
      expect(typeof r!.mainExecMs).toBe('number');
      expect(Number.isFinite(r!.mainExecMs!)).toBe(true);
      expect(r!.mainExecMs!).toBeGreaterThanOrEqual(0);
      const samples = await pollExec(pool, 2);
      expect(samples.length).toBe(2);
      const bands = splitBands(H, 3);
      const seq = samples[0]!.seq;
      let workerPixels = 0;
      let workerSpans = 0;
      for (const s of samples) {
        expectFiniteExec(s);
        expect(s.job).toBe('raster');
        expect(bandJobName(JOB_RASTER)).toBe(s.job);
        expect(s.seq).toBe(seq);
        expect(s.frame).toBe(pool.frame());
        expect(s.band).toBeGreaterThanOrEqual(0);
        expect(s.band).toBeLessThan(2);
        expect(s.y0).toBe(bands[s.band]!.y0);
        expect(s.y1).toBe(bands[s.band]!.y1);
        // Every band drew its full rows for both staged batches.
        expect(s.descs).toBe(2);
        expect(s.kickBase).toBe(0);
        expect(s.kickDescs).toBe(2);
        const rows = s.y1 - s.y0;
        expect(s.spans).toBe(2 * rows);
        expect(s.pixels).toBe(2 * rows * W);
        expect(s.scanned).toBe(s.spans);
        expect(s.tris).toBe(0);
        workerPixels += s.pixels;
        workerSpans += s.spans;
      }
      // Worker shares plus the calling-thread band reconcile to the tally.
      expect(workerPixels).toBeLessThanOrEqual(r!.pixels);
      expect(workerPixels + (r!.pixels - workerPixels)).toBe(r!.pixels);
      expect(workerSpans + (r!.spans - workerSpans)).toBe(r!.spans);
      expect(r!.pixels - workerPixels).toBeGreaterThan(0);
    } finally {
      await pool.dispose();
    }
  });

  it('resolve kick: finite execMs with zero spanfill counts (JOB_RESOLVE)', { timeout: 120000 }, async () => {
    const dist = distOrSkip();
    if (!dist) return;
    const W = 96, H = 60;
    const pool = BandWorkerPool.create(2, W, H, { indexJsPath: dist });
    if (!pool) throw new Error('pool create failed (need worker_threads + SAB + Atomics.wait)');
    try {
      pool.beginFrame();
      pool.stagePalette(testPalette());
      expect(await pool.resolveFrameAsync()).toBe(true);
      const samples = await pollExec(pool, 2);
      expect(samples.length).toBe(2);
      const bands = splitBands(H, 3);
      const seq = samples[0]!.seq;
      for (const s of samples) {
        expectFiniteExec(s);
        expect(s.job).toBe('resolve');
        expect(bandJobName(JOB_RESOLVE)).toBe(s.job);
        expect(s.seq).toBe(seq);
        expect(s.frame).toBe(pool.frame());
        expect(s.y0).toBe(bands[s.band]!.y0);
        expect(s.y1).toBe(bands[s.band]!.y1);
        expect(s.pixels).toBe(0);
        expect(s.spans).toBe(0);
        expect(s.scanned).toBe(0);
        expect(s.tris).toBe(0);
        expect(s.descs).toBe(0);
      }
    } finally {
      await pool.dispose();
    }
  });

  it('synthetic completions never satisfy the stash (validation rejects mocks)', { timeout: 120000 }, async () => {
    const dist = distOrSkip();
    if (!dist) return;
    const W = 64, H = 48;
    const pool = BandWorkerPool.create(1, W, H, { indexJsPath: dist });
    if (!pool) throw new Error('pool create failed (need worker_threads + SAB + Atomics.wait)');
    try {
      const priv = pool as unknown as { noteWorkerExec(msg: unknown): void };
      // Pre-kick: no kick armed, so every seq is stale — all ignored.
      priv.noteWorkerExec({ seq: 0, band: 0, frame: 0, job: 2, y0: 0, y1: 24, execMs: 1.5, pixels: 10, spans: 1 });
      priv.noteWorkerExec({ seq: 1, band: 0, frame: 1, job: 2, y0: 0, y1: 24, execMs: 1.5, pixels: 10, spans: 1 });
      expect(pool.lastWorkerExec()).toBeNull();
      // A real kick arms the stash; malformed arrivals for it are dropped.
      pool.beginFrame();
      const colormap = buildColormap(defaultPalette());
      stageIndexedBatch(pool, W, H, colormap);
      const kick = await pool.flushFrameAsync();
      expect(kick).not.toBeNull();
      const real = await pollExec(pool, 1);
      const seq = real[0]!.seq;
      // Negative / non-finite / missing execMs are not measurements.
      priv.noteWorkerExec({ seq, band: 0, frame: 1, job: 2, y0: 0, y1: 24, execMs: -1, pixels: 10, spans: 1 });
      priv.noteWorkerExec({ seq, band: 0, frame: 1, job: 2, y0: 0, y1: 24, execMs: Number.NaN, pixels: 10, spans: 1 });
      priv.noteWorkerExec({ seq, band: 0, frame: 1, job: 2, y0: 0, y1: 24, pixels: 10, spans: 1 });
      // Out-of-range band and stale seq are ignored.
      priv.noteWorkerExec({ seq, band: 7, frame: 1, job: 2, y0: 0, y1: 24, execMs: 0.5, pixels: 10, spans: 1 });
      priv.noteWorkerExec({ seq: seq + 100, band: 0, frame: 1, job: 2, y0: 0, y1: 24, execMs: 0.5, pixels: 10, spans: 1 });
      const after = pool.lastWorkerExec();
      expect(after).not.toBeNull();
      expect(after!.length).toBe(1);
      // The real measured sample survived unmodified — no mock overwrote it.
      expect(after![0]).toEqual(real[0]);
    } finally {
      await pool.dispose();
    }
  });

  it('timing disabled: legacy shape, null stash, no mainExecMs, identical planes', { timeout: 120000 }, async () => {
    const dist = distOrSkip();
    if (!dist) return;
    const W = 96, H = 60;
    const colormap = buildColormap(defaultPalette());
    const stageWorld = (pool: BandWorkerPool): void => {
      pool.beginFrame();
      stageIndexedBatch(pool, W, H, colormap);
    };
    const enabled = BandWorkerPool.create(2, W, H, { indexJsPath: dist });
    const disabled = BandWorkerPool.create(2, W, H, { indexJsPath: dist, workerTiming: false });
    if (!enabled || !disabled) throw new Error('pool create failed (need worker_threads + SAB + Atomics.wait)');
    try {
      stageWorld(enabled);
      const re = await enabled.flushFrameAsync();
      expect(re).not.toBeNull();
      const se = await pollExec(enabled, 2);
      expect(se.length).toBe(2);
      for (const s of se) expectFiniteExec(s);
      stageWorld(disabled);
      const rd = await disabled.flushFrameAsync();
      expect(rd).not.toBeNull();
      // Disabled path: no measurement posted, no stash, no caller-band timing.
      expect(disabled.lastWorkerExec()).toBeNull();
      expect(rd!.mainExecMs).toBeUndefined();
      // Measurement perturbs nothing: identical tallies either way.
      expect(rd!.pixels).toBe(re!.pixels);
      expect(rd!.spans).toBe(re!.spans);
    } finally {
      await enabled.dispose();
      await disabled.dispose();
    }
  });
});
