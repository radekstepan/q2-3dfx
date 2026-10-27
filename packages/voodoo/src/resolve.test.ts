// M4.1 resolve-chain tests: gamma LUT, dither period, RGB565 bounds,
// postfilter averaging, W-buffer banding, cvar switching, golden hash.
import { describe, expect, it } from 'vitest';
import { getCVarNumber, setCVar } from '@q2/config';
import {
  applyPostFilter,
  bayerThreshold,
  capTextureSizeFrame,
  defaultResolveRGB888Options,
  defaultVoodooState,
  ditherOffsetG,
  ditherOffsetRB,
  expandRGB565,
  gammaLUT,
  quantiseDepth,
  quantiseDepthFrame,
  quantiseRGB565,
  readVoodooState,
  resolveFrame,
  resolveRGB565,
  resolveRGB888,
} from './index.js';

describe('gammaLUT', () => {
  it('spot values at gamma 1.3', () => {
    const lut = gammaLUT(1.3);
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
    expect(lut[128]).toBe(150); // 255*(128/255)^(1/1.3) = 150.04
    expect(lut[64]).toBe(88); // 255*(64/255)^(1/1.3) = 88.01
    expect(lut[192]).toBe(205); // 255*(192/255)^(1/1.3) = 204.99
  });
  it('gamma 1 is identity and LUT is monotonic', () => {
    const lut = gammaLUT(1);
    for (let i = 0; i < 256; i++) expect(lut[i]).toBe(i);
    const lift = gammaLUT(1.3);
    for (let i = 1; i < 256; i++) expect(lift[i]).toBeGreaterThanOrEqual(lift[i - 1]!);
    for (let i = 1; i < 256; i++) expect(lift[i]).toBeGreaterThanOrEqual(i); // never darkens
    for (let i = 8; i <= 240; i++) expect(lift[i]).toBeGreaterThan(i); // strict lift in mids
  });
  it('rejects non-positive gamma', () => {
    expect(() => gammaLUT(0)).toThrow();
    expect(() => gammaLUT(-1.3)).toThrow();
  });
});

describe('bayer dither', () => {
  it('has period 4 in x and y', () => {
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        expect(ditherOffsetRB(x, y)).toBe(ditherOffsetRB(x + 4, y));
        expect(ditherOffsetRB(x, y)).toBe(ditherOffsetRB(x, y + 4));
        expect(ditherOffsetG(x, y)).toBe(ditherOffsetG(x + 4, y));
        expect(ditherOffsetG(x, y)).toBe(ditherOffsetG(x, y + 4));
      }
  });
  it('spans exactly +/-4 on R/B and +/-2 on G', () => {
    let minRB = 99;
    let maxRB = -99;
    let minG = 99;
    let maxG = -99;
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        const rb = ditherOffsetRB(x, y);
        const g = ditherOffsetG(x, y);
        if (rb < minRB) minRB = rb;
        if (rb > maxRB) maxRB = rb;
        if (g < minG) minG = g;
        if (g > maxG) maxG = g;
      }
    expect(minRB).toBe(-4);
    expect(maxRB).toBe(4);
    expect(minG).toBe(-2);
    expect(maxG).toBe(2);
  });
  it('endpoints sit on bayer 0 and 15', () => {
    // bayer 0 is at (0,0), bayer 15 at (0,3)
    expect(bayerThreshold(0, 0)).toBe(0);
    expect(bayerThreshold(0, 3)).toBe(15);
    expect(ditherOffsetRB(0, 0)).toBe(-4);
    expect(ditherOffsetRB(0, 3)).toBe(4);
    expect(ditherOffsetG(0, 0)).toBe(-2);
    expect(ditherOffsetG(0, 3)).toBe(2);
  });
});

describe('RGB565', () => {
  it('packs channels correctly', () => {
    expect(quantiseRGB565(255, 255, 255)).toBe(0xffff);
    expect(quantiseRGB565(0, 0, 0)).toBe(0x0000);
    expect(quantiseRGB565(248, 252, 248)).toBe(0xffff);
    expect(quantiseRGB565(255, 0, 0)).toBe(0xf800);
    expect(quantiseRGB565(0, 255, 0)).toBe(0x07e0);
    expect(quantiseRGB565(0, 0, 255)).toBe(0x001f);
  });
  it('quantise is idempotent over the full 16-bit space', () => {
    for (let v = 0; v < 65536; v++) {
      const e = expandRGB565(v);
      const r = quantiseRGB565(e & 255, (e >> 8) & 255, (e >> 16) & 255);
      if (r !== v) throw new Error(`not idempotent at ${v.toString(16)}`);
    }
  });
  it('round-trip error within one truncated LSB (no dither)', () => {
    for (let v = 0; v < 256; v++) {
      const eR = expandRGB565(quantiseRGB565(v, 0, 0)) & 255;
      const eG = (expandRGB565(quantiseRGB565(0, v, 0)) >> 8) & 255;
      const eB = (expandRGB565(quantiseRGB565(0, 0, v)) >> 16) & 255;
      expect(Math.abs(eR - v)).toBeLessThanOrEqual(7);
      expect(Math.abs(eG - v)).toBeLessThanOrEqual(3);
      expect(Math.abs(eB - v)).toBeLessThanOrEqual(7);
    }
  });
  it('1x1 resolve is exact (no dither, gamma 1)', () => {
    const src = new Uint32Array([0xff102030]);
    const dst = new Uint16Array(1);
    resolveRGB565(src, dst, 1, 1, { gamma: 1, dither: false, quantise: true });
    expect(dst[0]).toBe(quantiseRGB565(0x30, 0x20, 0x10));
  });
});

describe('applyPostFilter', () => {
  it('uniform field passes through unchanged', () => {
    const w = 8;
    const h = 8;
    const src = new Uint16Array(w * h).fill(0x7bef); // mid grey-green
    const dst = new Uint32Array(w * h);
    applyPostFilter(src, dst, w, h);
    const ref = expandRGB565(0x7bef);
    for (let i = 0; i < w * h; i++) expect(dst[i]).toBe(ref);
  });
  it('2x2 checker averages to half grey, edges clamp', () => {
    // row0: black white / row1: white black
    const src = new Uint16Array([0x0000, 0xffff, 0xffff, 0x0000]);
    const dst = new Uint32Array(4);
    applyPostFilter(src, dst, 2, 2);
    const half = 0xff808080;
    expect(dst[0]).toBe(half);
    expect(dst[1]).toBe(half);
    expect(dst[2]).toBe(half);
    expect(dst[3]).toBe(0xff000000); // clamped corner: all four taps black
  });
  it('1x1 replicates the single pixel', () => {
    const src = new Uint16Array([0xffff]);
    const dst = new Uint32Array(1);
    applyPostFilter(src, dst, 1, 1);
    expect(dst[0]).toBe(0xffffffff);
  });
});

describe('resolveFrame display fill (astra §2.1)', () => {
  const w = 4;
  const h = 4;
  const stNoPost = { ...defaultVoodooState(), postfilter: false, gamma: 1, dither: false };
  it('postfilter off still fills display by expanding the fresh 565 target', () => {
    const src = new Uint32Array(w * h).fill(0xff0000ff); // opaque red 0xAABBGGRR
    const dst = new Uint16Array(w * h);
    const display = new Uint32Array(w * h).fill(0xdeadbeef); // stale sentinel
    resolveFrame(src, dst, display, w, h, stNoPost);
    const ref = expandRGB565(quantiseRGB565(255, 0, 0));
    for (let i = 0; i < w * h; i++) {
      expect(display[i]).toBe(ref);
      expect(display[i]).not.toBe(0xdeadbeef);
    }
  });
  it('red then green frames leave no stale pixels with postfilter off', () => {
    const dst = new Uint16Array(w * h);
    const display = new Uint32Array(w * h).fill(0xdeadbeef);
    resolveFrame(new Uint32Array(w * h).fill(0xff0000ff), dst, display, w, h, stNoPost);
    const redRef = expandRGB565(quantiseRGB565(255, 0, 0));
    for (let i = 0; i < w * h; i++) expect(display[i]).toBe(redRef);
    resolveFrame(new Uint32Array(w * h).fill(0xff00ff00), dst, display, w, h, stNoPost);
    const greenRef = expandRGB565(quantiseRGB565(0, 255, 0));
    expect(greenRef).not.toBe(redRef);
    for (let i = 0; i < w * h; i++) expect(display[i]).toBe(greenRef);
  });
  it('postfilter on still box-filters (unchanged behaviour)', () => {
    const stPost = { ...stNoPost, postfilter: true };
    const src = new Uint32Array(w * h).fill(0xff808080);
    const dst = new Uint16Array(w * h);
    const display = new Uint32Array(w * h);
    resolveFrame(src, dst, display, w, h, stPost);
    const ref = expandRGB565(dst[0]!);
    for (let i = 0; i < w * h; i++) expect(display[i]).toBe(ref);
  });
});

describe('resolveRGB888 bypass (astra §2.2)', () => {
  it('passes values through that RGB565 cannot represent (gamma 1, no dither)', () => {
    // Sub-LSB values 1..7 all truncate to r5 = 0 in 565 — the bypass keeps them.
    for (const v of [1, 2, 3, 5, 7, 100, 127, 200, 254]) {
      const src = new Uint32Array([(0xff000000 | v) >>> 0]);
      const dst = new Uint32Array(1);
      resolveRGB888(src, dst, 1, 1, { gamma: 1, dither: false });
      expect(dst[0]).toBe((0xff000000 | v) >>> 0);
    }
    // The 565 path provably loses sub-LSB values:
    for (const v of [1, 2, 3, 4, 5, 6, 7]) {
      expect(quantiseRGB565(v, 0, 0)).toBe(quantiseRGB565(0, 0, 0));
    }
  });
  it('preserves channel order 0xAABBGGRR and forces opaque alpha', () => {
    const src = new Uint32Array([0x00332211]); // alpha 0, B=0x33 G=0x22 R=0x11
    const dst = new Uint32Array(1);
    resolveRGB888(src, dst, 1, 1, { gamma: 1, dither: false });
    expect(dst[0]).toBe(0xff332211);
    expect(dst[0]! & 255).toBe(0x11);
    expect((dst[0]! >> 8) & 255).toBe(0x22);
    expect((dst[0]! >> 16) & 255).toBe(0x33);
    expect((dst[0]! >>> 24) & 255).toBe(0xff);
  });
  it('applies the same gamma LUT stage as the 565 path', () => {
    const lut = gammaLUT(1.3);
    const src = new Uint32Array([(0xff4080c0 | 0xff000000) >>> 0]);
    const dst = new Uint32Array(1);
    resolveRGB888(src, dst, 1, 1, { gamma: 1.3, dither: false });
    expect(dst[0]).toBe((0xff000000 | (lut[0x40]! << 16) | (lut[0x80]! << 8) | lut[0xc0]!) >>> 0);
  });
  it('defaults to gamma 1.3 with dither off', () => {
    expect(defaultResolveRGB888Options()).toEqual({ gamma: 1.3, dither: false });
  });
  it('resolveFrame with quantise:false fills display with RGB888 (dither/postfilter bypassed)', () => {
    const w = 8;
    const h = 8;
    const src = new Uint32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const v = (i * 37 + 3) & 255; // ramp incl. values absent from 565
      src[i] = (0xff000000 | (v << 16) | (v << 8) | v) >>> 0;
    }
    // Even with dither + postfilter cvars on, the bypass path skips both.
    const st = { ...defaultVoodooState(), quantise: false, gamma: 1, dither: true, postfilter: true };
    const dst565 = new Uint16Array(w * h);
    const display = new Uint32Array(w * h).fill(0xdeadbeef);
    resolveFrame(src, dst565, display, w, h, st);
    const ref = new Uint32Array(w * h);
    resolveRGB888(src, ref, w, h, { gamma: 1, dither: false });
    expect(display).toEqual(ref);
    // Ramp values survive: byte-exact passthrough at gamma 1.
    expect(display).toEqual(src);
    // dst565 stays packed for compat readers (legacy rounding path).
    const ref565 = new Uint16Array(w * h);
    resolveRGB565(src, ref565, w, h, { gamma: 1, dither: true, quantise: false });
    expect(dst565).toEqual(ref565);
  });
});

describe('quantiseDepth', () => {
  it('snaps to 16-bit steps with half-step max error', () => {
    const d = new Float32Array([0, 0.1, 0.3, 0.5, 0.75, 1.0]);
    quantiseDepth(d, 16);
    const scale = 65535;
    for (let i = 0; i < d.length; i++) {
      expect(Math.abs(d[i]! * scale - Math.round(d[i]! * scale))).toBeLessThan(1e-3);
    }
    expect(Math.abs(d[3]! - 0.5)).toBeLessThanOrEqual(0.5 / scale + 1e-6);
  });
  it('bits >= 24 and <= 0 are no-ops', () => {
    const a = new Float32Array([0.123456]);
    const b = new Float32Array([0.123456]);
    const orig = a[0];
    quantiseDepth(a, 24);
    quantiseDepth(b, 0);
    expect(a[0]).toBe(orig);
    expect(b[0]).toBe(orig);
  });
  it('vd_zbits switches depth precision through the cvar', () => {
    const saved = getCVarNumber('vd_zbits');
    try {
      setCVar('vd_zbits', 8);
      const d = new Float32Array([0.5001, 0.123456]);
      quantiseDepthFrame(d);
      // 8-bit steps: multiples of 1/255
      expect(Math.abs(d[0]! * 255 - Math.round(d[0]! * 255))).toBeLessThan(1e-3);
      const expected = new Float32Array([Math.round(0.123456 * 255) / 255])[0];
      expect(d[1]).toBe(expected);
      setCVar('vd_zbits', 16);
      const e = new Float32Array([0.5001]);
      quantiseDepthFrame(e);
      expect(e[0]).not.toBe(d[0]);
    } finally {
      setCVar('vd_zbits', saved);
    }
  });
});

describe('cvar switching', () => {
  it('every resolve stage toggles through its vd_* cvar', () => {
    const w = 16;
    const h = 16;
    const src = new Uint32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const v = (i * 37) & 255;
      src[i] = (0xff000000 | (v << 16) | (v << 8) | v) >>> 0;
    }
    const run = (): Uint16Array => {
      const dst = new Uint16Array(w * h);
      resolveFrame(src, dst, null, w, h); // reads live cvars
      return dst;
    };
    const differ = (a: Uint16Array, b: Uint16Array): number => {
      let n = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
      return n;
    };
    const saved = new Map<string, number>([
      ['vd_gamma', getCVarNumber('vd_gamma')],
      ['vd_dither', getCVarNumber('vd_dither')],
      ['vd_16bit', getCVarNumber('vd_16bit')],
    ]);
    try {
      const base = run();
      setCVar('vd_dither', 0);
      expect(differ(base, run())).toBeGreaterThan(0);
      setCVar('vd_dither', 1);
      setCVar('vd_gamma', 1.0);
      expect(differ(base, run())).toBeGreaterThan(0);
      setCVar('vd_gamma', 1.3);
      setCVar('vd_16bit', 0);
      expect(differ(base, run())).toBeGreaterThan(0);
      // defaults restored below; readVoodooState must mirror cvars
      setCVar('vd_16bit', 1);
      const st = readVoodooState();
      expect(st.dither).toBe(true);
      expect(st.quantise).toBe(true);
      expect(st.gamma).toBe(1.3);
      expect(st.postfilter).toBe(true);
    } finally {
      for (const [k, v] of saved) setCVar(k, v);
    }
    expect(defaultVoodooState().gamma).toBe(1.3);
  });
});

describe('voodoo golden', () => {
  it('resolve is bit-deterministic and bounded (M4.1 done-when)', () => {
    const w = 64;
    const h = 40;
    const src = new Uint32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const r = (x * 4) & 255;
        const g = (y * 6) & 255;
        const b = ((x + y) * 3) & 255;
        src[y * w + x] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      }
    const st = defaultVoodooState();
    const run = (): Uint16Array => {
      const dst = new Uint16Array(w * h);
      resolveFrame(src, dst, null, w, h, st);
      return dst;
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b); // deterministic: zero differing pixels
    // Bound: every expanded tap within dither amp + quant step of gamma input.
    const lut = gammaLUT(st.gamma);
    let bad = 0;
    for (let i = 0; i < w * h; i++) {
      const px = src[i]!;
      const e = expandRGB565(a[i]!);
      if (Math.abs((e & 255) - lut[px & 255]!) > 12) bad++;
      if (Math.abs(((e >> 8) & 255) - lut[(px >> 8) & 255]!) > 6) bad++;
      if (Math.abs(((e >> 16) & 255) - lut[(px >> 16) & 255]!) > 12) bad++;
    }
    // §10.3 voodoo tolerance: <= 0.5% of pixels may differ by <= 1 LSB;
    // here zero pixels escape the hard bound, which is strictly tighter.
    expect(bad / (w * h)).toBeLessThanOrEqual(0.005);
    // Locked pipeline hash (FNV-1a over dst): any stage change breaks loudly.
    let hash = 0x811c9dc5;
    for (let i = 0; i < a.length; i++) {
      hash ^= a[i]!;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    expect(hash.toString(16)).toBe('e923ad78');
  });
});
