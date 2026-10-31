// Renderer lane: true per-band span subranges for the indexed path.
//
// - Task 2: ordered batches expose D_ORDERED once at staging;
//   workers binary-search owned subranges instead of rescanning overlapping
//   batches. Tall batches crossing many bands must not cause
//   workers*spanCount inspections. Output stays byte-identical; unordered /
//   legacy / manual descriptors keep the full-scan fallback.
// (RGB/scanout execution was retired under RELEASE-8; only the indexed
// worker path remains.)
import { describe, expect, it } from 'vitest';
import {
  attachFrameAccum, frameAccumTotal,
  splitBands, processFrameJob,
  D_PER_BATCH, D_SPAN_BASE, D_SPAN_COUNT, D_TEX_OFF, D_TEX_W, D_TEX_H,
  D_LIGHT_OFF, D_LIGHT_W, D_LIGHT_H, D_WSHIFT, D_WMASK, D_HMASK,
  D_TURBPHASE, D_YMIN, D_YMAX, D_ORDERED,
  type FrameAccumViews,
} from './bands.js';
import {
  SPAN_OPAQUE, F_PER_SPAN, I_PER_SPAN,
} from './spans.js';

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
