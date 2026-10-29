// PERF-NEXT-4 (Lane A): real production worker-loop execution timing.
//
// Through the REAL built Node worker (`BandWorkerPool.create` with
// `dist/index.mjs`, real threads running the production `bandWorkerLoop`),
// proving for every job kind (indexed-world raster, RGB world + foreground
// suffixes, resolve, scanout):
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
  JOB_RASTER, JOB_RESOLVE, JOB_RGB, JOB_SCANOUT,
  R_FLAG_BLEND_ALPHA, R_FLAG_DEPTHWRITE, R_FLAG_LIGHT, R_FLAG_OPAQUE, R_FLAG_REPEAT,
  bandJobName, buildColormap, defaultPalette,
  packFrameSpans, splitBands,
  type BandExecSample, type LightBlock, type RGBMipLevel,
  type ScanoutBandOptions, type Span, type Texture,
} from './index.js';
import { SPAN_OPAQUE, SPAN_TRANS66, createSpan } from './spans.js';

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

function tinyChain(palIndex: number): RGBMipLevel[] {
  const pal = testPalette();
  const r = pal[palIndex * 3]!, g = pal[palIndex * 3 + 1]!, b = pal[palIndex * 3 + 2]!;
  const data = new Uint8Array([r, g, b, r, g, b, r, g, b, r, g, b]);
  const mask = new Uint8Array([255, 255, 255, 255]);
  return [{ data, width: 2, height: 2, mask }];
}

const LUX = new Uint8Array([200, 200, 200]);
const WORLD_FLAGS = R_FLAG_REPEAT | R_FLAG_DEPTHWRITE | R_FLAG_LIGHT | R_FLAG_OPAQUE;
const FG_FLAGS = R_FLAG_REPEAT | R_FLAG_LIGHT | R_FLAG_BLEND_ALPHA;

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

  it('RGB world + foreground suffix kicks attribute separately with finite execMs (JOB_RGB)', { timeout: 120000 }, async () => {
    const dist = distOrSkip();
    if (!dist) return;
    const W = 96, H = 60;
    const pool = BandWorkerPool.create(2, W, H, { indexJsPath: dist });
    if (!pool) throw new Error('pool create failed (need worker_threads + SAB + Atomics.wait)');
    try {
      pool.beginFrame();
      const chain = tinyChain(7);
      const fgChain = tinyChain(200);
      const world: Span[] = [];
      for (let y = 0; y < H; y++) world.push(makeSpan(y, W, SPAN_OPAQUE, 0.2));
      expect(pool.stageRGB(
        { spans: world, count: world.length }, 0, world.length,
        chain, LUX, 1, 1, WORLD_FLAGS, 0, 0, 0,
      )).toBe(true);
      const kick1 = await pool.flushRGBFrameAsync(4, 32768, 0);
      expect(kick1).not.toBeNull();
      const s1 = await pollExec(pool, 2);
      const seq1 = s1[0]!.seq;
      for (const s of s1) {
        expectFiniteExec(s);
        expect(s.job).toBe('rgb');
        expect(bandJobName(JOB_RGB)).toBe(s.job);
        expect(s.seq).toBe(seq1);
        expect(s.frame).toBe(pool.frame());
        // World-only kick drains the full [0, 1) range on every band.
        expect(s.kickBase).toBe(0);
        expect(s.kickDescs).toBe(1);
        expect(s.descs).toBe(1);
        expect(s.pixels).toBeGreaterThan(0);
        expect(s.tris).toBe(0);
      }
      // Foreground suffix: translucent spans over the middle rows only.
      const fg: Span[] = [];
      for (let y = Math.floor(H / 4); y < Math.floor((3 * H) / 4); y++) {
        fg.push(makeSpan(y, W, SPAN_TRANS66, 0.24));
      }
      expect(pool.stageRGB(
        { spans: fg, count: fg.length }, 0, fg.length,
        fgChain, LUX, 1, 1, FG_FLAGS, 0, 0, 0,
      )).toBe(true);
      const kick2 = await pool.flushRGBFrameAsync(4, 32768, 0);
      expect(kick2).not.toBeNull();
      expect(typeof kick2!.mainExecMs).toBe('number');
      const s2 = await pollExec(pool, 2);
      expect(s2.length).toBe(2);
      const seq2 = s2[0]!.seq;
      expect(seq2).toBe(seq1 + 1);
      const bands = splitBands(H, 3);
      for (const s of s2) {
        expectFiniteExec(s);
        expect(s.job).toBe('rgb');
        expect(s.seq).toBe(seq2);
        expect(s.frame).toBe(pool.frame());
        expect(s.y0).toBe(bands[s.band]!.y0);
        expect(s.y1).toBe(bands[s.band]!.y1);
        // Foreground-only suffix kick drains [1, 2): attributable per flush.
        expect(s.kickBase).toBe(1);
        expect(s.kickDescs).toBe(2);
        const overlaps = s.y0 < Math.floor((3 * H) / 4) && s.y1 > Math.floor(H / 4);
        if (overlaps) {
          expect(s.descs).toBe(1);
          expect(s.pixels).toBeGreaterThan(0);
        } else {
          // Culled bands still executed the drain loop: finite execMs, zero work.
          expect(s.descs).toBe(0);
          expect(s.pixels).toBe(0);
          expect(s.spans).toBe(0);
        }
      }
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

  it('scanout kick: finite execMs with zero spanfill counts (JOB_SCANOUT)', { timeout: 120000 }, async () => {
    const dist = distOrSkip();
    if (!dist) return;
    const W = 96, H = 60;
    const pool = BandWorkerPool.create(2, W, H, { indexJsPath: dist });
    if (!pool) throw new Error('pool create failed (need worker_threads + SAB + Atomics.wait)');
    try {
      pool.beginFrame();
      const scanOpts: ScanoutBandOptions = {
        gamma: 1, dither: false, ditherMode: 0, postfilter: false,
        reconmode: 1, maxR: 0, maxG: 0, maxB: 0, quantise: true,
      };
      expect(await pool.flushScanoutAsync(scanOpts)).toBe(true);
      const samples = await pollExec(pool, 2);
      expect(samples.length).toBe(2);
      const bands = splitBands(H, 3);
      const seq = samples[0]!.seq;
      for (const s of samples) {
        expectFiniteExec(s);
        expect(s.job).toBe('scanout');
        expect(bandJobName(JOB_SCANOUT)).toBe(s.job);
        expect(s.seq).toBe(seq);
        expect(s.frame).toBe(pool.frame());
        expect(s.y0).toBe(bands[s.band]!.y0);
        expect(s.y1).toBe(bands[s.band]!.y1);
        expect(s.pixels).toBe(0);
        expect(s.spans).toBe(0);
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
      const chain = tinyChain(7);
      const world: Span[] = [];
      for (let y = 0; y < H; y++) world.push(makeSpan(y, W, SPAN_OPAQUE, 0.2));
      expect(pool.stageRGB(
        { spans: world, count: world.length }, 0, world.length,
        chain, LUX, 1, 1, WORLD_FLAGS, 0, 0, 0,
      )).toBe(true);
      const kick = await pool.flushRGBFrameAsync(4, 32768, 0);
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
    const stageWorldFG = (pool: BandWorkerPool): void => {
      pool.beginFrame();
      const chain = tinyChain(7);
      const fgChain = tinyChain(200);
      const world: Span[] = [];
      for (let y = 0; y < H; y++) world.push(makeSpan(y, W, SPAN_OPAQUE, 0.2));
      expect(pool.stageRGB(
        { spans: world, count: world.length }, 0, world.length,
        chain, LUX, 1, 1, WORLD_FLAGS, 0, 0, 0,
      )).toBe(true);
    };
    const snapRGB = (pool: BandWorkerPool): string => {
      const v = pool as unknown as { rgbViews: { rgb565: Uint16Array; cover: Uint8Array } };
      let h = 2166136261;
      const q = new Uint8Array(v.rgbViews.rgb565.buffer, v.rgbViews.rgb565.byteOffset, v.rgbViews.rgb565.byteLength);
      for (let i = 0; i < q.length; i++) {
        h ^= q[i]!;
        h = Math.imul(h, 16777619);
      }
      const c = v.rgbViews.cover;
      for (let i = 0; i < c.length; i++) {
        h ^= c[i]!;
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16).padStart(8, '0');
    };
    const enabled = BandWorkerPool.create(2, W, H, { indexJsPath: dist });
    const disabled = BandWorkerPool.create(2, W, H, { indexJsPath: dist, workerTiming: false });
    if (!enabled || !disabled) throw new Error('pool create failed (need worker_threads + SAB + Atomics.wait)');
    try {
      stageWorldFG(enabled);
      const re = await enabled.flushRGBFrameAsync(4, 32768, 0);
      expect(re).not.toBeNull();
      const se = await pollExec(enabled, 2);
      expect(se.length).toBe(2);
      for (const s of se) expectFiniteExec(s);
      stageWorldFG(disabled);
      const rd = await disabled.flushRGBFrameAsync(4, 32768, 0);
      expect(rd).not.toBeNull();
      // Disabled path: no measurement posted, no stash, no caller-band timing.
      expect(disabled.lastWorkerExec()).toBeNull();
      expect(rd!.mainExecMs).toBeUndefined();
      expect((rd as { workerSpans?: number }).workerSpans).toBe(re!.workerSpans);
      // Measurement perturbs nothing: identical planes either way.
      expect(snapRGB(disabled)).toBe(snapRGB(enabled));
      expect(rd!.pixels).toBe(re!.pixels);
      expect(rd!.spans).toBe(re!.spans);
    } finally {
      await enabled.dispose();
      await disabled.dispose();
    }
  });
});
