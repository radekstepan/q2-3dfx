// Renderer lane (PERF-FINISH-A follow-up): true per-band span subranges,
// foreground worker staging, RGB-first classic avoidance.
//
// - Task 2: ordered batches expose R_ORDERED/D_ORDERED once at staging;
//   workers binary-search owned subranges instead of rescanning overlapping
//   batches. Tall batches crossing many bands must not cause
//   workers*spanCount inspections. Output stays byte-identical; unordered /
//   legacy / manual descriptors keep the full-scan fallback.
// - Task 1: span-based foreground (deferred TRANS alpha, world sprites)
//   stages into the same JOB_RGB kick after the world batches; per-band
//   unions are bit-identical to the serial foreground draws.
// - Task 3: with the authoritative skip armed, the RGB cache hit skips the
//   scalar surface-block build (probe-first); the oracle and software mode
//   keep the legacy order with identical output.
import { afterEach, describe, expect, it } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import {
  attachFrameAccum, attachRGBAccum, frameAccumTotal, rgbAccumTotal,
  splitBands, processFrameJob, processRGBFrameJob,
  D_PER_BATCH, D_SPAN_BASE, D_SPAN_COUNT, D_TEX_OFF, D_TEX_W, D_TEX_H,
  D_LIGHT_OFF, D_LIGHT_W, D_LIGHT_H, D_WSHIFT, D_WMASK, D_HMASK,
  D_TURBPHASE, D_YMIN, D_YMAX, D_ORDERED,
  R_PER_BATCH, R_SPAN_BASE, R_SPAN_COUNT, R_YMIN, R_YMAX, R_ORDERED,
  R_FLAG_BLEND_ALPHA, R_FLAG_DEPTHWRITE, R_FLAG_LIGHT, R_FLAG_REPEAT,
  type FrameAccumViews, type RGBAccumViews,
} from './bands.js';
import { BandWorkerPool } from './bandPool.js';
import {
  SPAN_OPAQUE, SPAN_TRANS33, SPAN_TRANS66, F_PER_SPAN, I_PER_SPAN,
  createSpan, buildRGBMaterial, drawSpansRGB,
  type RGBMipLevel, type Span, type SpanList,
} from './spans.js';
import {
  SoftwareRenderer, setRGBWorldEnabled, SW_RGB_SKIP_CLASSIC_CVAR,
} from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';

afterEach(() => {
  setRGBWorldEnabled(false);
  resetCVars();
});

function testPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = (i * 5) & 255;
    pal[i * 3 + 1] = (i * 3 + 40) & 255;
    pal[i * 3 + 2] = (i * 2 + 80) & 255;
  }
  return pal;
}

function fnvU8(a: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) {
    h ^= a[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function fnvRGBA(color: Uint32Array): string {
  let h = 2166136261;
  for (let i = 0; i < color.length; i++) {
    const px = color[i]!;
    h ^= px & 0xff; h = Math.imul(h, 16777619);
    h ^= (px >>> 8) & 0xff; h = Math.imul(h, 16777619);
    h ^= (px >>> 16) & 0xff; h = Math.imul(h, 16777619);
    h ^= (px >>> 24) & 0xff; h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// --- indexed subrange fixtures ---------------------------------------------

function fillIndexedSpan(views: FrameAccumViews, slot: number, W: number, y: number): void {
  const o = slot * F_PER_SPAN;
  views.fSpansF[o] = 1; views.fSpansF[o + 1] = 0;
  views.fSpansF[o + 2] = 8; views.fSpansF[o + 3] = 0;
  views.fSpansF[o + 4] = 8; views.fSpansF[o + 5] = 0;
  views.fSpansF[o + 6] = 63; views.fSpansF[o + 7] = 0;
  views.fSpansF[o + 8] = 0; views.fSpansF[o + 9] = -1;
  views.fSpansF[o + 10] = 0; views.fSpansF[o + 11] = 0; views.fSpansF[o + 12] = 0;
  const q = slot * I_PER_SPAN;
  views.fSpansI[q] = SPAN_OPAQUE; views.fSpansI[q + 1] = y;
  views.fSpansI[q + 2] = 0; views.fSpansI[q + 3] = W; views.fSpansI[q + 4] = 0;
}

function putIndexedDesc(
  views: FrameAccumViews, b: number, base: number, count: number,
  ymin: number, ymax: number, ordered: number,
): void {
  const d = b * D_PER_BATCH;
  views.desc[d + D_SPAN_BASE] = base;
  views.desc[d + D_SPAN_COUNT] = count;
  views.desc[d + D_TEX_OFF] = 0; views.desc[d + D_TEX_W] = 1; views.desc[d + D_TEX_H] = 1;
  views.desc[d + D_LIGHT_OFF] = 0; views.desc[d + D_LIGHT_W] = 1; views.desc[d + D_LIGHT_H] = 1;
  views.desc[d + D_WSHIFT] = 0; views.desc[d + D_WMASK] = 0; views.desc[d + D_HMASK] = 0;
  views.desc[d + D_TURBPHASE] = 0;
  views.desc[d + D_YMIN] = ymin;
  views.desc[d + D_YMAX] = ymax;
  views.desc[d + D_ORDERED] = ordered;
}

describe('task 2: true per-band span subranges (indexed)', () => {
  it('tall ordered batch: bands inspect owned rows only, union is exact', () => {
    for (const [W, H] of [[64, 480], [61, 37]] as Array<[number, number]>) {
      const sab = new SharedArrayBuffer(frameAccumTotal(W, H));
      const { views } = attachFrameAccum(sab, W, H);
      views.fTex[0] = 7;
      views.fLight[0] = 63;
      for (let y = 0; y < H; y++) fillIndexedSpan(views, y, W, y);
      putIndexedDesc(views, 0, 0, H, 0, H, 1);
      const bands = 8;
      const ranges = splitBands(H, bands);
      const full = processFrameJob(views, W, H, 1, 0, H);
      expect(full.spans).toBe(H);
      // Union over bands draws the identical pixels with identical counts.
      let pixels = 0, spans = 0, scanned = 0, descs = 0;
      for (const band of ranges) {
        const r = processFrameJob(views, W, H, 1, band.y0, band.y1);
        pixels += r.pixels;
        spans += r.spans;
        scanned += r.scanned;
        descs += r.descs;
      }
      expect(pixels).toBe(full.pixels);
      expect(spans).toBe(full.spans);
      // Proof: every entry inspected exactly once across all bands —
      // no worker rescanned the overlapping batch (legacy would be
      // bands*H here, asserted below).
      expect(scanned).toBe(H);
      expect(descs).toBe(bands);
      // Legacy fallback (ORDERED=0) visits the whole batch per band with
      // identical output.
      views.desc[D_ORDERED] = 0;
      const refIdx = views.base.idx.slice();
      const refZb = views.base.zb.slice();
      views.base.idx.fill(0);
      views.base.zb.fill(0);
      let legacyScanned = 0, legacyPixels = 0;
      for (const band of ranges) {
        const r = processFrameJob(views, W, H, 1, band.y0, band.y1);
        legacyPixels += r.pixels;
        legacyScanned += r.scanned;
      }
      expect(legacyPixels).toBe(full.pixels);
      expect(legacyScanned).toBe(bands * H);
      expect(views.base.idx).toEqual(refIdx);
      expect(views.base.zb).toEqual(refZb);
    }
  });

  it('sparse rows: bands with no staged row skip setup entirely', () => {
    const W = 64, H = 64;
    const sab = new SharedArrayBuffer(frameAccumTotal(W, H));
    const { views } = attachFrameAccum(sab, W, H);
    views.fTex[0] = 7;
    views.fLight[0] = 63;
    // Spans only at the top/bottom edges (sparse, but row-ordered).
    const rows = [0, 1, H - 2, H - 1];
    rows.forEach((y, slot) => fillIndexedSpan(views, slot, W, y));
    putIndexedDesc(views, 0, 0, rows.length, 0, H, 1);
    const mid = processFrameJob(views, W, H, 1, H / 4, (3 * H) / 4);
    expect(mid.spans).toBe(0);
    expect(mid.pixels).toBe(0);
    expect(mid.descs).toBe(0);
    expect(mid.scanned).toBe(0);
    const lo = processFrameJob(views, W, H, 1, 0, H / 4);
    const hi = processFrameJob(views, W, H, 1, (3 * H) / 4, H);
    expect(lo.spans + hi.spans).toBe(4);
    expect(lo.scanned + hi.scanned).toBe(4);
  });

  it('unordered spans still draw identically (fallback, no reorder)', () => {
    const W = 64, H = 64;
    const sab = new SharedArrayBuffer(frameAccumTotal(W, H));
    const { views } = attachFrameAccum(sab, W, H);
    views.fTex[0] = 7;
    views.fLight[0] = 63;
    const rows = [3, 19, 35, 51, 3, 51];
    rows.forEach((y, slot) => fillIndexedSpan(views, slot, W, y));
    // Covering range but no order proof: every band visits everything.
    putIndexedDesc(views, 0, 0, rows.length, 0, 52, 0);
    const bands = splitBands(H, 4);
    const full = processFrameJob(views, W, H, 1, 0, H);
    let pixels = 0, scanned = 0;
    for (const band of bands) {
      const r = processFrameJob(views, W, H, 1, band.y0, band.y1);
      pixels += r.pixels;
      scanned += r.scanned;
    }
    expect(pixels).toBe(full.pixels);
    expect(scanned).toBe(4 * rows.length);
  });

  it('empty bands and odd dims partition exactly', () => {
    const W = 61, H = 37;
    const sab = new SharedArrayBuffer(frameAccumTotal(W, H));
    const { views } = attachFrameAccum(sab, W, H);
    views.fTex[0] = 7;
    views.fLight[0] = 63;
    for (let y = 0; y < H; y++) fillIndexedSpan(views, y, W, y);
    putIndexedDesc(views, 0, 0, H, 0, H, 1);
    const bands = splitBands(H, 8);
    // 37 rows over 8 bands: several bands hold 4 rows, the last takes 9.
    const full = processFrameJob(views, W, H, 1, 0, H);
    const refIdx = views.base.idx.slice();
    const refZb = views.base.zb.slice();
    views.base.idx.fill(0);
    views.base.zb.fill(0);
    let pixels = 0, scanned = 0, empty = 0;
    for (const band of bands) {
      const r = processFrameJob(views, W, H, 1, band.y0, band.y1);
      pixels += r.pixels;
      scanned += r.scanned;
      if (band.y1 <= band.y0) empty++;
    }
    expect(empty).toBe(0);
    expect(pixels).toBe(full.pixels);
    expect(scanned).toBe(H);
    expect(views.base.idx).toEqual(refIdx);
    expect(views.base.zb).toEqual(refZb);
  });
});

// --- RGB subrange fixtures ---------------------------------------------------

function makeSpan(y: number, W: number, kind: number): Span {
  const s = createSpan();
  s.kind = kind;
  s.y = y;
  s.x0 = 0; s.x1 = W;
  s.iz = 1; s.diz = 0;
  s.uz = 8; s.duz = 0;
  s.vz = 8; s.dvz = 0;
  s.light = 200; s.dlight = 0;
  s.lu = 0; s.lv = 0; s.dlu = 0;
  s.turb = 0; s.ord = 0;
  s.dudy = 0; s.dvdy = 0;
  return s;
}

function spanListOf(spans: Span[]): SpanList {
  return { spans, count: spans.length };
}

/** Build a pool instance without spawning threads (staging only). */
function stagingPool(W: number, H: number): BandWorkerPool {
  const sab = new SharedArrayBuffer(rgbAccumTotal(W, H));
  const { views: rgbViews } = attachRGBAccum(sab, W, H);
  const pool = Object.create(BandWorkerPool.prototype) as unknown as Record<string, unknown>;
  pool['disposed'] = false;
  pool['workers'] = [{}]; // non-empty so stageRGB proceeds; no thread use
  pool['rgbViews'] = rgbViews;
  pool['rgbSpansUsed'] = 0;
  pool['rgbChainUsed'] = 0;
  pool['rgbChainLevels'] = 0;
  pool['rgbChainSlots'] = 0;
  pool['rgbLuxUsed'] = 0;
  pool['rgbDescCount'] = 0;
  pool['rgbChainMap'] = new Map();
  return pool as unknown as BandWorkerPool;
}

function tinyChain(): RGBMipLevel[] {
  // Palette index 7 (uniform 2x2, opaque): the worker chain carries the
  // same expanded triplets buildRGBMaterial derives from these texels, so
  // the serial comparison below samples identical bytes.
  const pal = testPalette();
  const r = pal[7 * 3]!, g = pal[7 * 3 + 1]!, b = pal[7 * 3 + 2]!;
  const data = new Uint8Array([r, g, b, r, g, b, r, g, b, r, g, b]);
  const mask = new Uint8Array([255, 255, 255, 255]);
  return [{ data, width: 2, height: 2, mask }];
}

const TINY_TEXELS = new Uint8Array([7, 7, 7, 7]);

describe('task 2: true per-band span subranges (RGB)', () => {
  it('tall ordered RGB batch: bands inspect owned rows only, union is exact', () => {
    const W = 64, H = 96;
    const pool = stagingPool(W, H);
    const spans: Span[] = [];
    for (let y = 0; y < H; y++) spans.push(makeSpan(y, W, SPAN_OPAQUE));
    const lux = new Uint8Array([200, 200, 200]);
    const ok = pool.stageRGB(
      spanListOf(spans), 0, spans.length, tinyChain(), lux, 1, 1,
      R_FLAG_REPEAT | R_FLAG_DEPTHWRITE | R_FLAG_LIGHT, 0, 0, 0,
    );
    expect(ok).toBe(true);
    const rgbViews = (pool as unknown as { rgbViews: RGBAccumViews }).rgbViews;
    rgbViews.kick[0] = 4;
    rgbViews.kick[1] = 32768;
    rgbViews.kick[2] = 0;
    // Ordered proof staged by stageRGB (same pass as the band-cull scan).
    expect(rgbViews.rgbDesc[R_ORDERED]).toBe(1);
    // Window-Z clear is all-ones (far); a zeroed SAB would reject every
    // depth test and pin empty planes.
    rgbViews.rgbDepth.fill(0xffff);
    const bands = splitBands(H, 8);
    const full = processRGBFrameJob(rgbViews, W, H, 1, 0, H);
    expect(full.spans).toBe(H);
    const ref565 = rgbViews.rgb565.slice();
    const refCover = rgbViews.cover.slice();
    const refDepth = rgbViews.rgbDepth.slice();
    rgbViews.rgb565.fill(0);
    rgbViews.cover.fill(0);
    rgbViews.rgbDepth.fill(0xffff);
    let pixels = 0, scanned = 0;
    for (const band of bands) {
      const r = processRGBFrameJob(rgbViews, W, H, 1, band.y0, band.y1);
      pixels += r.pixels;
      scanned += r.scanned;
    }
    expect(pixels).toBe(full.pixels);
    expect(scanned).toBe(H);
    expect(rgbViews.rgb565).toEqual(ref565);
    expect(rgbViews.cover).toEqual(refCover);
    expect(rgbViews.rgbDepth).toEqual(refDepth);
  });
});

describe('task 1: foreground TRANS spans ride the worker kick', () => {
  it('staged alpha blends are bit-identical per band and to serial', () => {
    const W = 64, H = 64;
    const pool = stagingPool(W, H);
    const spans: Span[] = [];
    for (let y = 8; y < 56; y++) spans.push(makeSpan(y, W, SPAN_TRANS66));
    const lux = new Uint8Array([200, 200, 200]);
    const ok = pool.stageRGB(
      spanListOf(spans), 0, spans.length, tinyChain(), lux, 1, 1,
      R_FLAG_REPEAT | R_FLAG_LIGHT | R_FLAG_BLEND_ALPHA, 0, 0, 0,
    );
    expect(ok).toBe(true);
    expect(pool.rgbPending()).toBe(1);
    const rgbViews = (pool as unknown as { rgbViews: RGBAccumViews }).rgbViews;
    rgbViews.kick[0] = 4;
    rgbViews.kick[1] = 32768;
    rgbViews.kick[2] = 0;
    // Seed the destination (mirrors frame.ts seedRGBBackground over a
    // mid-grey backdrop) so blends have something to read. Window-Z
    // starts cleared (far) like beginFrame.
    rgbViews.rgb565.fill(0x8410);
    rgbViews.rgbDepth.fill(0xffff);
    const bands = splitBands(H, 4);
    const full = processRGBFrameJob(rgbViews, W, H, 1, 0, H);
    expect(full.spans).toBe(48);
    const ref565 = rgbViews.rgb565.slice();
    const refCover = rgbViews.cover.slice();
    rgbViews.rgb565.fill(0x8410);
    rgbViews.cover.fill(0);
    rgbViews.rgbDepth.fill(0xffff);
    let pixels = 0, scanned = 0;
    for (const band of bands) {
      const r = processRGBFrameJob(rgbViews, W, H, 1, band.y0, band.y1);
      pixels += r.pixels;
      scanned += r.scanned;
    }
    expect(pixels).toBe(full.pixels);
    expect(scanned).toBe(48);
    expect(rgbViews.rgb565).toEqual(ref565);
    expect(rgbViews.cover).toEqual(refCover);
    // Serial drawSpansRGB with the equivalent alpha material converges.
    // (Fidelity fields mirror the staged flags exactly: no overbright,
    // lodBias 0, no mip dither, nearest sampling, full-precision depth.)
    const mat = buildRGBMaterial(
      TINY_TEXELS, 2, 2, testPalette(), { samples: lux.slice(), luxW: 1, luxH: 1 },
      {
        addressS: 'repeat', addressT: 'repeat', blend: 'alpha', depthWrite: false,
        overbright: false, lodBias: 0, mipDither: false, bilinear: false, zbits: 0,
      },
    );
    const s565 = new Uint16Array(W * H).fill(0x8410);
    const sCover = new Uint8Array(W * H);
    const sDepth = new Uint16Array(W * H).fill(0xffff);
    drawSpansRGB(s565, sCover, sDepth, W, H, spanListOf(spans), mat, { near: 4, far: 32768 });
    expect(s565).toEqual(ref565);
    expect(sCover).toEqual(refCover);
  });
});

// --- renderer-level: avoid counters + fg counters + parity -------------------

function devView() {
  return {
    origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
    fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
  };
}

function renderDevroomTwice(W: number, H: number): {
  colorA: string; colorB: string; avoidA: number; avoidBytesA: number;
  avoidB: number; avoidBytes: number;
  fgStaged: number; fgInline: number; fgKicks: number; scalarBuildsA: number;
} {
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(testPalette());
  setRGBWorldEnabled(true);
  r.beginFrame();
  r.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
  r.endFrame();
  const colorA = fnvRGBA(new Uint32Array(fb.color.buffer, fb.color.byteOffset, W * H));
  const avoidA = r.testClassicAvoidStats();
  const scalarA = r.testCacheStats().misses;
  r.beginFrame();
  r.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
  r.endFrame();
  const colorB = fnvRGBA(new Uint32Array(fb.color.buffer, fb.color.byteOffset, W * H));
  const avoid = r.testClassicAvoidStats();
  const fg = r.testForegroundWorkerStats();
  setRGBWorldEnabled(false);
  return {
    colorA, colorB, avoidA: avoidA.builds, avoidBytesA: avoidA.bytes,
    avoidB: avoid.builds, avoidBytes: avoid.bytes,
    fgStaged: fg.staged, fgInline: fg.inline, fgKicks: fg.kicks,
    scalarBuildsA: scalarA,
  };
}

describe('task 3: RGB-first probe avoids classic preparation', () => {
  it('skip-armed frames avoid scalar builds; oracle and software build as before', () => {
    const warm = renderDevroomTwice(160, 120);
    // Stationary frames agree with each other...
    expect(warm.colorA).toBe(warm.colorB);
    // ...and the cold skip-armed frame avoided every scalar build it
    // would have done (the RGB materials built block-free instead), while
    // the warm frame finds everything hot (nothing left to avoid).
    expect(warm.avoidA).toBe(warm.scalarBuildsA);
    expect(warm.avoidA).toBeGreaterThan(0);
    expect(warm.avoidBytesA).toBeGreaterThan(0);
    // The classic oracle (cvar 0) keeps the legacy order: no avoidance,
    // identical color output.
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 0);
    const oracle = renderDevroomTwice(160, 120);
    expect(oracle.avoidB).toBe(0);
    expect(oracle.colorB).toBe(warm.colorB);
    // Software mode (RGB off) never avoids: no RGB cache exists.
    resetCVars();
    const fb = createFramebuffer(160, 120, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    r.beginFrame();
    r.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
    r.endFrame();
    r.beginFrame();
    r.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
    r.endFrame();
    expect(r.testClassicAvoidStats().builds).toBe(0);
  });

  it('serial foreground span work counts inline with identical output', () => {
    const warm = renderDevroomTwice(160, 120);
    // No pool attached: the world sprite stages inline (unpooled route).
    expect(warm.fgStaged).toBe(0);
    expect(warm.fgKicks).toBe(0);
    expect(warm.fgInline).toBeGreaterThan(0);
  });

  it('pooled foreground stages over workers with byte-identical output', { timeout: 180000 }, async () => {
    const distUrl = new URL('../dist/index.mjs', import.meta.url);
    const { existsSync } = await import('fs');
    if (!existsSync(distUrl)) {
      console.log('SKIP pooled foreground test: dist not built (run yarn build first)');
      return;
    }
    const { resetCVars: reset, setCVar: set } = await import('@q2/config');
    const { SW_WORKERS_CVAR, SW_ACCUM_CVAR } = await import('./bands.js');
    try {
      reset();
      const W = 320, H = 240;
      const serialFb = createFramebuffer(W, H, true);
      const serial = new SoftwareRenderer();
      serial.init(serialFb);
      serial.setPalette(testPalette());
      setRGBWorldEnabled(true);
      serial.beginFrame();
      serial.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
      serial.endFrame();
      setRGBWorldEnabled(false);
      const serialLive = serial.getFramebuffer();
      const serialColor = fnvRGBA(new Uint32Array(
        serialLive.color.buffer, serialLive.color.byteOffset, W * H));
      reset();
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(testPalette());
      set(SW_WORKERS_CVAR, 4);
      set(SW_ACCUM_CVAR, 1);
      if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
      const pool = BandWorkerPool.create(3, W, H, { indexJsPath: distUrl.pathname });
      if (!pool) throw new Error('pool create failed');
      try {
        r.attachWorkerPool(pool);
        setRGBWorldEnabled(true);
        r.beginFrame();
        r.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
        r.endFrame();
        setRGBWorldEnabled(false);
        const pooledLive = r.getFramebuffer();
        const pooledColor = fnvRGBA(new Uint32Array(
          pooledLive.color.buffer, pooledLive.color.byteOffset, W * H));
        expect(pooledColor).toBe(serialColor);
        // The world sprite staged into a foreground kick (proof the
        // span-based foreground rides workers, in order, after the world).
        const fg = r.testForegroundWorkerStats();
        expect(fg.staged).toBeGreaterThan(0);
        expect(fg.kicks).toBeGreaterThan(0);
        // Subrange proof plumbed through real kicks (indexed + RGB).
        expect(r.testWorkerRangeStats().scanned).toBeGreaterThan(0);
        expect(r.testRGBWorkerStats().staged).toBeGreaterThan(0);
      } finally {
        await pool.dispose();
      }
    } finally {
      reset();
    }
  });

  it('pooled async foreground runs on workers with byte-identical output', { timeout: 180000 }, async () => {
    const distUrl = new URL('../dist/index.mjs', import.meta.url);
    const { existsSync } = await import('fs');
    if (!existsSync(distUrl)) {
      console.log('SKIP pooled async foreground test: dist not built (run yarn build first)');
      return;
    }
    const { resetCVars: reset, setCVar: set } = await import('@q2/config');
    const { SW_WORKERS_CVAR, SW_ACCUM_CVAR } = await import('./bands.js');
    try {
      reset();
      const W = 320, H = 240;
      const mk = () => {
        const fb = createFramebuffer(W, H, true);
        const r = new SoftwareRenderer();
        r.init(fb);
        r.setPalette(testPalette());
        set(SW_WORKERS_CVAR, 4);
        set(SW_ACCUM_CVAR, 1);
        if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
        return { fb, r };
      };
      const world = { name: 'devroom', data: createDevroom() };
      // Sync pooled reference (drawForeground with sync flushes).
      const s = mk();
      const poolS = BandWorkerPool.create(3, W, H, { indexJsPath: distUrl.pathname });
      if (!poolS) throw new Error('pool create failed');
      let syncColor: string;
      try {
        s.r.attachWorkerPool(poolS);
        setRGBWorldEnabled(true);
        s.r.beginFrame();
        s.r.renderView(devView(), world, []);
        s.r.endFrame();
        setRGBWorldEnabled(false);
        syncColor = fnvRGBA(new Uint32Array(
          s.fb.color.buffer, s.fb.color.byteOffset, W * H));
      } finally {
        await poolS.dispose();
      }
      // Async pooled (drawForegroundAsync with message-driven FG flushes).
      reset();
      const a = mk();
      const poolA = BandWorkerPool.create(3, W, H, { indexJsPath: distUrl.pathname });
      if (!poolA) throw new Error('pool create failed');
      try {
        a.r.attachWorkerPool(poolA);
        setRGBWorldEnabled(true);
        a.r.beginFrame();
        await a.r.renderViewAsync(devView(), world, []);
        await a.r.endFrameAsync();
        setRGBWorldEnabled(false);
        const asyncColor = fnvRGBA(new Uint32Array(
          a.fb.color.buffer, a.fb.color.byteOffset, W * H));
        expect(asyncColor).toBe(syncColor);
        // The span-based foreground executed on workers (async FG flush),
        // not the sync inline replay.
        const fg = a.r.testForegroundWorkerStats();
        expect(fg.staged).toBeGreaterThan(0);
        expect(fg.kicks).toBeGreaterThan(0);
      } finally {
        await poolA.dispose();
      }
    } finally {
      reset();
    }
  });
});
