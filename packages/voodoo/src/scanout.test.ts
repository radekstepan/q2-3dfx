// Scanout reconstruction + depth-plane tests (astra step 4).
//
// Covers: 2x2 dither tables, 2x2-vs-4x4 write switch, dither-subtract wiring,
// threshold edge-vs-gradient fixture (proves the gate is not a blanket blur),
// 4x1 reconstruction, quantized depth plane (ties/coplanar), fog zero gate,
// and the full vd_* combo freshness sweep.
import { describe, expect, it } from 'vitest';
import { getCVarString, setCVar } from '@q2/config';
import {
  applyPostFilter,
  applyReconstruction2x2,
  applyReconstruction4x1,
  bayerThreshold2,
  clearDepth16,
  createDepth16,
  defaultVoodooState,
  depthClearValue,
  ditherOffsetG2,
  ditherOffsetRB2,
  expandRGB565,
  fogContribution,
  modulateLightmap,
  parseDitherMode,
  parseReconMode,
  parseRgbMaxDelta,
  passesReconstructionThreshold,
  passesReconstructionThresholdRow,
  quantiseRGB565,
  readVoodooState,
  resolveFrame,
  resolveRGB565,
  shadePixel,
  testAndWriteDepth16,
} from './index.js';

describe('2x2 ordered dither (fbzMode approximation)', () => {
  it('has period 2 in x and y', () => {
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < 6; x++) {
        expect(ditherOffsetRB2(x, y)).toBe(ditherOffsetRB2(x + 2, y));
        expect(ditherOffsetRB2(x, y)).toBe(ditherOffsetRB2(x, y + 2));
        expect(ditherOffsetG2(x, y)).toBe(ditherOffsetG2(x + 2, y));
        expect(ditherOffsetG2(x, y)).toBe(ditherOffsetG2(x, y + 2));
      }
  });
  it('spans [-3,+3] on R/B and [-1,+2] on G (same +/-0.5 LSB model)', () => {
    let minRB = 99;
    let maxRB = -99;
    let minG = 99;
    let maxG = -99;
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) {
        const rb = ditherOffsetRB2(x, y);
        const g = ditherOffsetG2(x, y);
        if (rb < minRB) minRB = rb;
        if (rb > maxRB) maxRB = rb;
        if (g < minG) minG = g;
        if (g > maxG) maxG = g;
      }
    expect(minRB).toBe(-3);
    expect(maxRB).toBe(3);
    expect(minG).toBe(-1);
    expect(maxG).toBe(2);
  });
  it('endpoints sit on bayer 0 and 3', () => {
    expect(bayerThreshold2(0, 0)).toBe(0);
    expect(bayerThreshold2(1, 0)).toBe(2);
    expect(bayerThreshold2(0, 1)).toBe(3);
    expect(bayerThreshold2(1, 1)).toBe(1);
    expect(ditherOffsetRB2(0, 0)).toBe(-3);
    expect(ditherOffsetRB2(0, 1)).toBe(3);
    expect(ditherOffsetG2(0, 0)).toBe(-1);
    expect(ditherOffsetG2(0, 1)).toBe(2);
  });
});

describe('ditherMode write switch', () => {
  it('2x2 vs 4x4 produce different 565 output on a flat field', () => {
    // v=12 grey: pixel (3,3) sits on 4x4 phase p15 (offset +4 -> r5=2) and
    // 2x2 phase p3 (offset -1 -> r5=1). Deterministic by construction.
    const w = 8;
    const h = 8;
    const src = new Uint32Array(w * h).fill((0xff0c0c0c) >>> 0);
    const a = new Uint16Array(w * h);
    const b = new Uint16Array(w * h);
    resolveRGB565(src, a, w, h, { gamma: 1, dither: true, ditherMode: '4x4', quantise: true });
    resolveRGB565(src, b, w, h, { gamma: 1, dither: true, ditherMode: '2x2', quantise: true });
    expect(a[3 * w + 3]).not.toBe(b[3 * w + 3]);
    let differ = 0;
    for (let i = 0; i < w * h; i++) if (a[i] !== b[i]) differ++;
    expect(differ).toBeGreaterThan(0);
  });
  it('omitted ditherMode is bit-exact legacy 4x4', () => {
    const w = 8;
    const h = 8;
    const src = new Uint32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const v = (i * 37 + 11) & 255;
      src[i] = (0xff000000 | (v << 16) | (v << 8) | v) >>> 0;
    }
    const a = new Uint16Array(w * h);
    const b = new Uint16Array(w * h);
    resolveRGB565(src, a, w, h, { gamma: 1.3, dither: true, quantise: true });
    resolveRGB565(src, b, w, h, { gamma: 1.3, dither: true, ditherMode: '4x4', quantise: true });
    expect(a).toEqual(b);
  });
  it('dither off ignores the matrix entirely', () => {
    const w = 4;
    const h = 4;
    const src = new Uint32Array(w * h).fill((0xff7b4a2d) >>> 0);
    const a = new Uint16Array(w * h);
    const b = new Uint16Array(w * h);
    resolveRGB565(src, a, w, h, { gamma: 1, dither: false, ditherMode: '4x4', quantise: true });
    resolveRGB565(src, b, w, h, { gamma: 1, dither: false, ditherMode: '2x2', quantise: true });
    expect(a).toEqual(b);
  });
});

describe('dither subtract wiring', () => {
  const q = quantiseRGB565(100, 150, 200);
  const ref = expandRGB565(q);
  it('legacy box on a uniform field reproduces the expanded tap everywhere', () => {
    const src = new Uint16Array(16).fill(q);
    const dst = new Uint32Array(16);
    applyPostFilter(src, dst, 4, 4);
    for (let i = 0; i < 16; i++) expect(dst[i]).toBe(ref);
  });
  it('subtract on a uniform field varies by phase (pattern removed per-pixel)', () => {
    const src = new Uint16Array(16).fill(q);
    const dst = new Uint32Array(16);
    applyReconstruction2x2(src, dst, 4, 4, { r: 0, g: 0, b: 0 }, '2x2');
    let varied = false;
    for (let i = 1; i < 16; i++) if (dst[i] !== dst[0]) varied = true;
    expect(varied).toBe(true); // legacy gives all-equal; subtract does not
    for (let i = 0; i < 16; i++) {
      const r = Math.abs((dst[i]! & 255) - (ref & 255));
      const g = Math.abs((((dst[i]! >> 8) & 255) - ((ref >> 8) & 255)));
      const b = Math.abs((((dst[i]! >> 16) & 255) - ((ref >> 16) & 255)));
      expect(r).toBeLessThanOrEqual(4);
      expect(g).toBeLessThanOrEqual(4);
      expect(b).toBeLessThanOrEqual(4);
    }
  });
  it('subtract=null with zero thresholds is bit-exact legacy box', () => {
    const src = new Uint16Array(48);
    for (let i = 0; i < 48; i++) src[i] = quantiseRGB565((i * 53) & 255, (i * 97) & 255, (i * 31) & 255);
    const a = new Uint32Array(48);
    const b = new Uint32Array(48);
    applyPostFilter(src, a, 8, 6);
    applyReconstruction2x2(src, b, 8, 6, { r: 0, g: 0, b: 0 }, null);
    expect(b).toEqual(a);
  });
  it('2x2sub and 4x4sub differ (patterns are not interchangeable)', () => {
    const src = new Uint16Array(64).fill(q);
    const a = new Uint32Array(64);
    const b = new Uint32Array(64);
    applyReconstruction2x2(src, a, 8, 8, { r: 0, g: 0, b: 0 }, '2x2');
    applyReconstruction2x2(src, b, 8, 8, { r: 0, g: 0, b: 0 }, '4x4');
    let differ = 0;
    for (let i = 0; i < 64; i++) if (a[i] !== b[i]) differ++;
    expect(differ).toBeGreaterThan(0);
  });
});

describe('reconstruction threshold: edge vs gradient (vidProcCfg/rgbMaxDelta)', () => {
  // 8x4 frame: cols 0-3 smooth green ramp (g6 20..23 -> expanded 81,85,89,93,
  // adjacent spread 4), col 4 one-pixel black edge, cols 5-7 white.
  const W = 8;
  const H = 4;
  function buildFrame(): Uint16Array {
    const s = new Uint16Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let v: number;
        if (x <= 3) v = (20 + x) << 5;
        else if (x === 4) v = 0x0000;
        else v = 0xffff;
        s[y * W + x] = v;
      }
    return s;
  }
  const GATE = { r: 8, g: 8, b: 8 };
  const OFF = { r: 0, g: 0, b: 0 };
  it('threshold passes the gradient (box average, not centre copy)', () => {
    const dst = new Uint32Array(W * H);
    applyReconstruction2x2(buildFrame(), dst, W, H, GATE, null);
    // Pixel (1,1): taps green {85,89,85,89} -> (85+89+85+89+2)>>2 = 87.
    expect(dst[1 * W + 1]).toBe((0xff000000 | (87 << 8)) >>> 0);
  });
  it('threshold keeps the one-pixel edge sharp', () => {
    const dst = new Uint32Array(W * H);
    applyReconstruction2x2(buildFrame(), dst, W, H, GATE, null);
    expect(dst[1 * W + 4]).toBe(0xff000000); // black centre kept, not blurred
    expect(dst[1 * W + 5]).toBe(0xffffffff); // white past the edge untouched
  });
  it('gate off (0,0,0) blurs the same edge to grey (blanket box)', () => {
    const dst = new Uint32Array(W * H);
    applyReconstruction2x2(buildFrame(), dst, W, H, OFF, null);
    expect(dst[1 * W + 4]).toBe((0xff808080) >>> 0);
    // And the gradient blurs identically under both settings:
    expect(dst[1 * W + 1]).toBe((0xff000000 | (87 << 8)) >>> 0);
  });
  it('passesReconstructionThreshold: zero disables, nonzero rejects per channel', () => {
    expect(passesReconstructionThreshold(0xff000000, 0xffffffff, 0xff000000, 0xffffffff, OFF)).toBe(true);
    expect(passesReconstructionThreshold(0xff000000, 0xffffffff, 0xff000000, 0xffffffff, GATE)).toBe(false);
    expect(passesReconstructionThreshold(0xff005000, 0xff005500, 0xff005000, 0xff005500, GATE)).toBe(true);
    expect(passesReconstructionThresholdRow(0xff000000, 0xff000000, 0xffffffff, 0xff000000, OFF)).toBe(true);
    expect(passesReconstructionThresholdRow(0xff000000, 0xff000000, 0xffffffff, 0xff000000, GATE)).toBe(false);
    expect(passesReconstructionThresholdRow(0xff005000, 0xff005500, 0xff005000, 0xff005500, GATE)).toBe(true);
  });
});

describe('applyReconstruction4x1 (4x4sub+4x1)', () => {
  // 4x1 row, pure-red taps with expanded reds {0, 82, 173, 255}.
  const taps = [quantiseRGB565(0, 0, 0), quantiseRGB565(82, 0, 0), quantiseRGB565(173, 0, 0), quantiseRGB565(255, 0, 0)];
  function buildRow(): Uint16Array {
    return new Uint16Array(taps);
  }
  it('gate off averages the centered [x-1,x+2] window', () => {
    const dst = new Uint32Array(4);
    applyReconstruction4x1(buildRow(), dst, 4, 1, { r: 0, g: 0, b: 0 }, null);
    expect(dst[0]).toBe((0xff000040) >>> 0); // (0+0+82+173+2)>>2 = 64
    expect(dst[1]).toBe((0xff000080) >>> 0); // (0+82+173+255+2)>>2 = 128
    expect(dst[2]).toBe((0xff0000bf) >>> 0); // (82+173+255+255+2)>>2 = 191
    expect(dst[3]).toBe((0xff0000eb) >>> 0); // (173+255+255+255+2)>>2 = 235
  });
  it('gate on keeps centres sharp on the same row', () => {
    const dst = new Uint32Array(4);
    applyReconstruction4x1(buildRow(), dst, 4, 1, { r: 8, g: 8, b: 8 }, null);
    expect(dst[0]).toBe((0xff000000) >>> 0);
    expect(dst[1]).toBe((0xff000052) >>> 0); // 82
    expect(dst[2]).toBe((0xff0000ad) >>> 0); // 173
    expect(dst[3]).toBe((0xff0000ff) >>> 0);
  });
  it('uniform field passes through (subtract varies phase like 2x2)', () => {
    const src = new Uint16Array(16).fill(0x7bef);
    const legacy = new Uint32Array(16);
    const recon = new Uint32Array(16);
    applyReconstruction4x1(src, legacy, 4, 4, { r: 0, g: 0, b: 0 }, null);
    for (let i = 0; i < 16; i++) expect(legacy[i]).not.toBe(0xdeadbeef);
    applyReconstruction4x1(src, recon, 4, 4, { r: 0, g: 0, b: 0 }, '4x4');
    let varied = false;
    for (let i = 1; i < 16; i++) if (recon[i] !== recon[0]) varied = true;
    expect(varied).toBe(true);
  });
});

describe('quantized depth plane (Z-operation, pre-test)', () => {
  it('creates cleared-to-far and writes with LESS + tie-keeps-stored', () => {
    const plane = createDepth16(4, 2);
    expect(plane.length).toBe(8);
    for (let i = 0; i < 8; i++) expect(plane[i]).toBe(0xffff);
    expect(testAndWriteDepth16(plane, 4, 2, 1, 1, 0.5)).toBe(true);
    expect(plane[1 * 4 + 1]).toBe(32768); // round(0.5 * 65535)
    expect(testAndWriteDepth16(plane, 4, 2, 1, 1, 0.5)).toBe(false); // tie: first writer wins
    expect(plane[1 * 4 + 1]).toBe(32768);
    expect(testAndWriteDepth16(plane, 4, 2, 1, 1, 0.4)).toBe(true); // nearer wins
    expect(plane[1 * 4 + 1]).toBe(26214); // round(0.4 * 65535)
    expect(testAndWriteDepth16(plane, 4, 2, 1, 1, 0.6)).toBe(false); // farther loses
    expect(plane[1 * 4 + 1]).toBe(26214);
  });
  it('far fragments fail on a fresh plane; near always passes', () => {
    const plane = createDepth16(2, 1);
    expect(testAndWriteDepth16(plane, 2, 1, 0, 0, 1.0)).toBe(false); // tie with clear
    expect(plane[0]).toBe(0xffff);
    expect(testAndWriteDepth16(plane, 2, 1, 0, 0, 0.0)).toBe(true);
    expect(plane[0]).toBe(0);
  });
  it('clearDepth16 restores far; custom bit depth works', () => {
    const plane = createDepth16(2, 1, 8);
    expect(depthClearValue(8)).toBe(255);
    expect(depthClearValue(16)).toBe(0xffff);
    for (let i = 0; i < 2; i++) expect(plane[i]).toBe(255);
    expect(testAndWriteDepth16(plane, 2, 1, 0, 0, 0.5, 8)).toBe(true);
    expect(plane[0]).toBe(128); // round(0.5 * 255)
    clearDepth16(plane, 8);
    expect(plane[0]).toBe(255);
  });
  it('rejects OOB pixels and non-finite depth loudly', () => {
    const plane = createDepth16(2, 2);
    expect(() => testAndWriteDepth16(plane, 2, 2, 2, 0, 0.5)).toThrow();
    expect(() => testAndWriteDepth16(plane, 2, 2, 0, -1, 0.5)).toThrow();
    expect(() => testAndWriteDepth16(plane, 2, 2, 0, 0, Number.NaN)).toThrow();
  });
});

describe('fog zero-contribution gate (base1 has no scene fog)', () => {
  it('fogContribution is zero unless a stage explicitly enables it', () => {
    expect(fogContribution(true, 0)).toBe(0);
    expect(fogContribution(false, 255)).toBe(0);
    expect(fogContribution(true, 255)).toBe(255);
  });
  it('shadePixel with factor 0 returns the lit colour untouched', () => {
    const st = { ...defaultVoodooState(), fog: true };
    const lit = modulateLightmap(200, 100, 50, 255, 128, 64, true);
    expect(shadePixel(200, 100, 50, 255, 128, 64, 0, 0, 0, 0, st)).toBe(lit);
  });
});

describe('profile cvar parsing', () => {
  it('parses vd_dithermode / vd_reconmode / vd_rgbmaxdelta with legacy fallbacks', () => {
    expect(parseDitherMode('2x2')).toBe('2x2');
    expect(parseDitherMode('4x4')).toBe('4x4');
    expect(parseDitherMode('bogus')).toBe('4x4');
    expect(parseReconMode('2x2sub+2x2box')).toBe('2x2sub+2x2box');
    expect(parseReconMode('4x4sub+4x1')).toBe('4x4sub+4x1');
    expect(parseReconMode('legacy')).toBe('legacy');
    expect(parseReconMode('nope')).toBe('legacy');
    expect(parseRgbMaxDelta('8,4,8')).toEqual({ r: 8, g: 4, b: 8 });
    expect(parseRgbMaxDelta('0,0,0')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseRgbMaxDelta('junk')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseRgbMaxDelta('8,4')).toEqual({ r: 8, g: 4, b: 0 });
    expect(parseRgbMaxDelta('300,-5,8')).toEqual({ r: 255, g: 0, b: 8 });
  });
  it('readVoodooState snapshots the profile cvars', () => {
    const saved = new Map<string, string>([
      ['vd_dithermode', getCVarString('vd_dithermode')],
      ['vd_reconmode', getCVarString('vd_reconmode')],
      ['vd_rgbmaxdelta', getCVarString('vd_rgbmaxdelta')],
    ]);
    try {
      setCVar('vd_dithermode', '2x2');
      setCVar('vd_reconmode', '4x4sub+4x1');
      setCVar('vd_rgbmaxdelta', '8,4,8');
      const st = readVoodooState();
      expect(st.dithermode).toBe('2x2');
      expect(st.reconmode).toBe('4x4sub+4x1');
      expect(st.rgbmaxdelta).toEqual({ r: 8, g: 4, b: 8 });
    } finally {
      for (const [k, v] of saved) setCVar(k, v);
    }
  });
});

describe('resolve freshness across every vd_16bit/vd_dither/vd_postfilter/vd_dithermode/vd_reconmode combo', () => {
  it('rewrites every display pixel (no stale) and stays deterministic', () => {
    const w = 6;
    const h = 5;
    const src = new Uint32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const v = (i * 37 + 11) & 255;
      src[i] = (0xff000000 | (v << 16) | (v << 8) | v) >>> 0;
    }
    const keys = ['vd_16bit', 'vd_dither', 'vd_postfilter', 'vd_dithermode', 'vd_reconmode'] as const;
    const saved = new Map<string, string>();
    for (const k of keys) saved.set(k, getCVarString(k));
    try {
      for (const bit16 of [0, 1])
        for (const dither of [0, 1])
          for (const post of [0, 1])
            for (const dmode of ['4x4', '2x2'])
              for (const recon of ['legacy', '2x2sub+2x2box', '4x4sub+4x1']) {
                setCVar('vd_16bit', bit16);
                setCVar('vd_dither', dither);
                setCVar('vd_postfilter', post);
                setCVar('vd_dithermode', dmode);
                setCVar('vd_reconmode', recon);
                const st = readVoodooState();
                expect(st.dithermode).toBe(dmode);
                expect(st.reconmode).toBe(recon);
                const dst565 = new Uint16Array(w * h);
                const display = new Uint32Array(w * h).fill(0xdeadbeef);
                resolveFrame(src, dst565, display, w, h, st);
                for (let i = 0; i < w * h; i++) {
                  expect(display[i]).not.toBe(0xdeadbeef);
                }
                const display2 = new Uint32Array(w * h);
                const dst2 = new Uint16Array(w * h);
                resolveFrame(src, dst2, display2, w, h, st);
                expect(display).toEqual(display2);
                expect(dst565).toEqual(dst2);
              }
    } finally {
      for (const [k, v] of saved) setCVar(k, v);
    }
  });
});
