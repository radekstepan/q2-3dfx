// V2b/step-4 policy tests: upload resampling, per-tap wrap, LOD compensation,
// pre-test depth, reconstruction threshold, fog gate. Deterministic, no RNG.
import { describe, expect, it } from 'vitest';
import {
  capTextureSize,
  completeMipChainRGB,
  DEPTH_CLEAR_01,
  defaultRgbMaxDelta,
  depthTestLess,
  fogContribution,
  halveRGB,
  lodBiasCompensation,
  mipLevel,
  mipRho,
  passesReconstructionThreshold,
  quantiseDepthBeforeTest,
  resampleTexture,
  sampleBilinear,
  samplePalette,
  sampleRGBTexture,
  wrapTap,
} from './index.js';

function greyPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = i;
    pal[i * 3 + 1] = i;
    pal[i * 3 + 2] = i;
  }
  return pal;
}

describe('wrapTap', () => {
  it('clamps to edge', () => {
    expect(wrapTap(-1, 4, 'clamp')).toBe(0);
    expect(wrapTap(4, 4, 'clamp')).toBe(3);
    expect(wrapTap(2, 4, 'clamp')).toBe(2);
    expect(wrapTap(99, 1, 'clamp')).toBe(0);
  });
  it('wraps each tap for repeat', () => {
    expect(wrapTap(4, 4, 'repeat')).toBe(0);
    expect(wrapTap(-1, 4, 'repeat')).toBe(3);
    expect(wrapTap(5, 4, 'repeat')).toBe(1);
    expect(wrapTap(-5, 4, 'repeat')).toBe(3);
    expect(wrapTap(2, 4, 'repeat')).toBe(2);
    expect(wrapTap(7, 1, 'repeat')).toBe(0);
  });
});

describe('repeat seams vs clamp edges', () => {
  const pal = greyPalette();
  const idx = new Uint8Array([10, 20, 30, 40]); // 2x2
  it('wraps EACH tap: u=1.5 blends texel 1 with texel 0 under repeat', () => {
    const out = new Uint8Array(3);
    samplePalette(idx, pal, 2, 2, 1.5, 0, out, 0, true, 'repeat', 'clamp');
    expect([...out]).toEqual([15, 15, 15]); // (20 + 10) / 2, NOT clamped 20
    samplePalette(idx, pal, 2, 2, 1.5, 0, out, 0, true, 'clamp', 'clamp');
    expect([...out]).toEqual([20, 20, 20]); // clamp pins x1 to x0
  });
  it('negative coordinates wrap seamlessly (u=-0.5 == u=1.5)', () => {
    const a = new Uint8Array(3);
    const b = new Uint8Array(3);
    samplePalette(idx, pal, 2, 2, -0.5, 0, a, 0, true, 'repeat', 'clamp');
    samplePalette(idx, pal, 2, 2, 1.5, 0, b, 0, true, 'repeat', 'clamp');
    expect([...a]).toEqual([...b]);
  });
  it('byte bilinear wraps the centre too (u=2.5 == u=0.5)', () => {
    const tex = new Uint8Array([10, 20, 30, 40]);
    expect(sampleBilinear(tex, 2, 2, 2.5, 0, 'repeat', 'clamp')).toBe(
      sampleBilinear(tex, 2, 2, 0.5, 0, 'clamp', 'clamp'),
    );
    expect(sampleBilinear(tex, 2, 2, 2.5, 0, 'repeat', 'clamp')).toBe(15);
  });
  it('clamp edges still pin (unchanged default)', () => {
    const tex = new Uint8Array([10, 20, 30, 40]);
    expect(sampleBilinear(tex, 2, 2, -5, -5)).toBe(10);
    expect(sampleBilinear(tex, 2, 2, 99, 99)).toBe(40);
  });
  it('expanded-RGB repeat matches paletted repeat on identical colours', () => {
    const rgb = new Uint8Array([10, 10, 10, 20, 20, 20, 30, 30, 30, 40, 40, 40]);
    for (const u of [-0.5, 0.25, 1.5, 2.5]) {
      const a = new Uint8Array(3);
      const b = new Uint8Array(3);
      sampleRGBTexture(rgb, 2, 2, u, 0, a, 0, true, 'repeat', 'clamp');
      samplePalette(idx, pal, 2, 2, u, 0, b, 0, true, 'repeat', 'clamp');
      expect([...a]).toEqual([...b]);
    }
  });
});

describe('palette-adjacent-colour filter (never average indices)', () => {
  it('red/green neighbours filter to yellow-brown, not index-average green', () => {
    const pal = new Uint8Array(768);
    pal[1 * 3] = 255; // index 1 = red
    pal[2 * 3 + 1] = 255; // index 2 = green
    const idx = new Uint8Array([1, 2]); // 2x1
    const out = new Uint8Array(3);
    samplePalette(idx, pal, 2, 1, 0.5, 0, out, 0, true);
    expect([...out]).toEqual([128, 128, 0]); // colour average
    // Numerically averaging the indices (1+2)/2 = 1.5 -> index 2 = pure
    // green would be WRONG; the colour average is not green.
    expect(out[1]).not.toBe(255);
  });
});

describe('resampleTexture (real texel resampling + UV scale)', () => {
  it('box-averages RGB triplets and reports UV scale', () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const r = resampleTexture(rgb, 2, 2, 1, 1);
    expect(r.w).toBe(1);
    expect(r.h).toBe(1);
    expect([...r.data]).toEqual([128, 128, 128]); // (510 + 2) / 4 per channel
    expect(r.uvScaleS).toBe(0.5);
    expect(r.uvScaleT).toBe(0.5);
  });
  it('identity resample copies exactly; aspect preserved with scale', () => {
    const rgb = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const same = resampleTexture(rgb, 2, 2, 2, 2);
    expect([...same.data]).toEqual([...rgb]);
    expect(same.uvScaleS).toBe(1);
    const wide = resampleTexture(new Uint8Array(4 * 2 * 3).fill(7), 4, 2, 2, 1);
    expect(wide.w).toBe(2);
    expect(wide.h).toBe(1);
    expect(wide.uvScaleS).toBe(0.5);
    expect(wide.uvScaleT).toBe(0.5);
    expect([...wide.data]).toEqual([7, 7, 7, 7, 7, 7]);
  });
  it('1x1 upsamples by replication', () => {
    const r = resampleTexture(new Uint8Array([9, 8, 7]), 1, 1, 2, 2);
    expect([...r.data]).toEqual([9, 8, 7, 9, 8, 7, 9, 8, 7, 9, 8, 7]);
  });
  it('honours caller scratch and validates sizes', () => {
    const out = new Uint8Array(3);
    const r = resampleTexture(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 2, 2, 1, 1, {
      out,
    });
    expect(r.data).toBe(out);
    expect(() => resampleTexture(new Uint8Array(3), 2, 2, 1, 1)).toThrow();
    expect(() => resampleTexture(new Uint8Array(12), 0, 2, 1, 1)).toThrow();
    expect(() =>
      resampleTexture(new Uint8Array(4), 2, 2, 1, 1, { palette: new Uint8Array(3) }),
    ).toThrow();
  });
  it('caps through the capTextureSize pipeline (512 -> 256, uvScale 0.5)', () => {
    const { w, h } = capTextureSize(512, 512);
    expect({ w, h }).toEqual({ w: 256, h: 256 });
    const src = new Uint8Array(8 * 8 * 3).fill(42);
    const { w: cw, h: chh } = capTextureSize(8, 8, 4);
    const r = resampleTexture(src, 8, 8, cw, chh);
    expect([r.w, r.h]).toEqual([4, 4]);
    expect(r.uvScaleS).toBe(0.5);
    expect([...r.data].every((v) => v === 42)).toBe(true);
  });
});

describe('indexed resample: transparency preserved, indices never averaged', () => {
  const pal = greyPalette();
  it('excludes index 255 from the average', () => {
    const r = resampleTexture(new Uint8Array([255, 10, 20, 30]), 4, 1, 2, 1, { palette: pal });
    expect([...r.data]).toEqual([10, 25]); // [255,10]->10, [20,30]->25
  });
  it('all-transparent footprint stays 255', () => {
    const r = resampleTexture(new Uint8Array([255, 255]), 2, 1, 1, 1, { palette: pal });
    expect([...r.data]).toEqual([255]);
  });
  it('odd transparent texel does not drag the average toward index 255', () => {
    const r = resampleTexture(new Uint8Array([255, 10]), 2, 1, 1, 1, { palette: pal });
    expect([...r.data]).toEqual([10]);
  });
  it('expanded-RGB parity on a grey ramp (nearest-match is exact)', () => {
    const idx = new Uint8Array(16);
    for (let i = 0; i < 16; i++) idx[i] = i * 16;
    const rgb = new Uint8Array(16 * 3);
    for (let i = 0; i < 16; i++) {
      rgb[i * 3] = idx[i]!;
      rgb[i * 3 + 1] = idx[i]!;
      rgb[i * 3 + 2] = idx[i]!;
    }
    const a = resampleTexture(idx, 4, 4, 2, 2, { palette: pal });
    const b = resampleTexture(rgb, 4, 4, 2, 2);
    const expanded = new Uint8Array(2 * 2 * 3);
    for (let i = 0; i < 4; i++) {
      expanded[i * 3] = pal[a.data[i]! * 3]!;
      expanded[i * 3 + 1] = pal[a.data[i]! * 3 + 1]!;
      expanded[i * 3 + 2] = pal[a.data[i]! * 3 + 2]!;
    }
    expect([...expanded]).toEqual([...b.data]);
  });
});

describe('mip chain: keep WAL levels, generate the missing tail', () => {
  it('halveRGB does a 2x2 box (odd widths cover the full footprint)', () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const m = halveRGB(rgb, 2, 2);
    expect([m.w, m.h]).toEqual([1, 1]);
    expect([...m.data]).toEqual([128, 128, 128]);
    const row = halveRGB(new Uint8Array([10, 10, 10, 20, 20, 20, 30, 30, 30]), 3, 1);
    expect([row.w, row.h]).toEqual([1, 1]);
    expect([...row.data]).toEqual([20, 20, 20]); // all three taps, not just two
  });
  it('completeMipChainRGB keeps present levels and generates the tail', () => {
    const base = new Uint8Array(4 * 4 * 3).fill(64);
    const chain = completeMipChainRGB([{ data: base, w: 4, h: 4 }], 3);
    expect(chain.map((m) => [m.w, m.h])).toEqual([
      [4, 4],
      [2, 2],
      [1, 1],
    ]);
    expect(chain[0]!.data).toBe(base); // kept, not regenerated
    expect([...chain[2]!.data]).toEqual([64, 64, 64]);
  });
  it('truncates, stops at 1x1, and rejects empty chains', () => {
    const base = new Uint8Array([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const kept = completeMipChainRGB(
      [
        { data: base, w: 2, h: 2 },
        { data: new Uint8Array([1, 2, 3]), w: 1, h: 1 },
      ],
      1,
    );
    expect(kept.length).toBe(1);
    expect(kept[0]!.data).toBe(base);
    const tail = completeMipChainRGB([{ data: new Uint8Array([1, 2, 3]), w: 1, h: 1 }], 4);
    expect(tail.length).toBe(1); // cannot subdivide 1x1
    expect(() => completeMipChainRGB([], 2)).toThrow();
    expect(() => completeMipChainRGB([{ data: base, w: 2, h: 2 }], 0)).toThrow();
  });
});

describe('LOD bias compensation (tloddither +0.375)', () => {
  it('is 0 without LOD dither, +0.375 with it', () => {
    expect(lodBiasCompensation(false)).toBe(0);
    expect(lodBiasCompensation(true)).toBe(0.375);
  });
  it('shifts the LOD average without changing selection policy', () => {
    expect(mipLevel(4, 0)).toBe(2);
    expect(mipLevel(4, 0, 16, true)).toBeCloseTo(2.375, 10);
    expect(mipLevel(4, 0, 16, false)).toBe(2);
  });
  it('negative bias still favours finer detail, with or without compensation', () => {
    expect(mipLevel(4, -0.35)).toBeLessThan(mipLevel(4, 0));
    expect(mipLevel(4, -0.35, 16, true)).toBeLessThan(mipLevel(4, 0, 16, true));
    expect(mipLevel(1, -0.35, 16, true)).toBeCloseTo(0.025, 10); // +0.375 lifts it just above 0
    expect(mipLevel(0.5, -0.35, 16, true)).toBe(0); // still clamps when truly negative
  });
  it('constant-UV / magnification footprints stay at LOD 0 without throwing', () => {
    expect(mipRho(0, 0, 0, 0)).toBe(0); // no throw
    expect(mipLevel(mipRho(0, 0, 0, 0), 0)).toBe(0);
    expect(mipLevel(mipRho(0, 0, 0, 0), -0.35, 3, true)).toBe(0);
  });
});

describe('pre-test depth policy (LESS wins, ties keep stored)', () => {
  it('quantises normalized depth to integers before the test', () => {
    expect(DEPTH_CLEAR_01).toBe(1.0);
    expect(quantiseDepthBeforeTest(0)).toBe(0);
    expect(quantiseDepthBeforeTest(1)).toBe(65535);
    expect(quantiseDepthBeforeTest(0.5)).toBe(32768); // round(0.5 * 65535)
    expect(quantiseDepthBeforeTest(1, 8)).toBe(255);
    expect(quantiseDepthBeforeTest(0.5, 8)).toBe(128);
  });
  it('clamps out-of-range depth; rejects NaN and bad bit counts', () => {
    expect(quantiseDepthBeforeTest(-0.5)).toBe(0);
    expect(quantiseDepthBeforeTest(2)).toBe(65535);
    expect(() => quantiseDepthBeforeTest(Number.NaN)).toThrow();
    expect(() => quantiseDepthBeforeTest(0.5, 0)).toThrow();
    expect(() => quantiseDepthBeforeTest(0.5, 25)).toThrow();
    expect(() => quantiseDepthBeforeTest(0.5, 7.5)).toThrow();
  });
  it('LESS wins; coplanar ties keep the stored (first) writer', () => {
    const near = quantiseDepthBeforeTest(0.25);
    const far = quantiseDepthBeforeTest(0.75);
    expect(depthTestLess(near, far)).toBe(true);
    expect(depthTestLess(far, near)).toBe(false);
    expect(depthTestLess(near, near)).toBe(false); // tie: stored wins
    // Coplanar surfaces quantise identically -> deterministic draw-order win.
    const coplanar = quantiseDepthBeforeTest(0.5);
    expect(depthTestLess(coplanar, quantiseDepthBeforeTest(0.5))).toBe(false);
    // Fresh (cleared-to-far) buffer accepts anything nearer than far.
    expect(depthTestLess(near, quantiseDepthBeforeTest(DEPTH_CLEAR_01))).toBe(true);
    expect(depthTestLess(quantiseDepthBeforeTest(1), quantiseDepthBeforeTest(1))).toBe(false);
  });
});

describe('reconstruction threshold (rgbMaxDelta stub)', () => {
  const black = 0xff000000;
  const white = 0xffffffff;
  it('pins placeholder defaults', () => {
    expect(defaultRgbMaxDelta()).toEqual({ r: 8, g: 8, b: 8 });
  });
  it('rejects a one-pixel edge, accepts a smooth gradient', () => {
    const d = defaultRgbMaxDelta();
    expect(passesReconstructionThreshold(black, black, black, white, d)).toBe(false);
    const g00 = (0xff000000 | (100 << 16) | (100 << 8) | 100) >>> 0;
    const g10 = (0xff000000 | (99 << 16) | (101 << 8) | 102) >>> 0;
    const g01 = (0xff000000 | (100 << 16) | (102 << 8) | 101) >>> 0;
    const g11 = (0xff000000 | (103 << 16) | (103 << 8) | 103) >>> 0;
    expect(passesReconstructionThreshold(g00, g10, g01, g11, d)).toBe(true);
    expect(passesReconstructionThreshold(black, black, black, black, d)).toBe(true);
  });
  it('is per-channel: a blue-only spike trips the blue threshold', () => {
    const flat = (0xff000000 | (50 << 16) | (50 << 8) | 50) >>> 0;
    const spike = (0xff000000 | (200 << 16) | (50 << 8) | 50) >>> 0;
    expect(passesReconstructionThreshold(flat, flat, flat, spike, defaultRgbMaxDelta())).toBe(
      false,
    );
    expect(
      passesReconstructionThreshold(flat, flat, flat, spike, { r: 8, g: 8, b: 255 }),
    ).toBe(true);
  });
});

describe('fog gate (base1 stays at zero)', () => {
  it('returns 0 unless fog is explicitly enabled', () => {
    expect(fogContribution(false, 200)).toBe(0);
    expect(fogContribution(false, 0)).toBe(0);
    expect(fogContribution(true, 0)).toBe(0);
    expect(fogContribution(true, 200)).toBe(200);
    expect(fogContribution(true, 300)).toBe(255); // clamped
  });
});
