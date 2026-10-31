// Pure-policy pins for @q2/voodoo (RELEASE-8: frame driver removed).
// Keeps the deterministic pins for the retained pure functions: gamma LUT,
// Bayer/dither tables, RGB565 quantise/expand, profile parsing, threshold
// gates, depth policy and the fog zero-gate. Frame-execution legs
// (resolve/scanout/fused/capture) are retired with the CPU driver.
import { describe, expect, it } from 'vitest';
import { getCVarNumber, getCVarString, setCVar } from '@q2/config';
import {
  bayerThreshold,
  bayerThreshold2,
  clearDepth16,
  createDepth16,
  defaultVoodooState,
  depthClearValue,
  ditherOffsetG,
  ditherOffsetG2,
  ditherOffsetRB,
  ditherOffsetRB2,
  expandRGB565,
  fogContribution,
  gammaLUT,
  modulateLightmap,
  parseDitherMode,
  parseReconMode,
  parseRgbMaxDelta,
  passesReconstructionThreshold,
  passesReconstructionThresholdRow,
  quantiseDepth,
  quantiseDepthFrame,
  quantiseRGB565,
  readVoodooState,
  shadePixel,
  testAndWriteDepth16,
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
});

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

describe('reconstruction threshold gates (vidProcCfg/rgbMaxDelta)', () => {
  const GATE = { r: 8, g: 8, b: 8 };
  const OFF = { r: 0, g: 0, b: 0 };
  it('zero disables, nonzero rejects per channel', () => {
    expect(passesReconstructionThreshold(0xff000000, 0xffffffff, 0xff000000, 0xffffffff, OFF)).toBe(true);
    expect(passesReconstructionThreshold(0xff000000, 0xffffffff, 0xff000000, 0xffffffff, GATE)).toBe(false);
    expect(passesReconstructionThreshold(0xff005000, 0xff005500, 0xff005000, 0xff005500, GATE)).toBe(true);
    expect(passesReconstructionThresholdRow(0xff000000, 0xff000000, 0xffffffff, 0xff000000, OFF)).toBe(true);
    expect(passesReconstructionThresholdRow(0xff000000, 0xff000000, 0xffffffff, 0xff000000, GATE)).toBe(false);
    expect(passesReconstructionThresholdRow(0xff005000, 0xff005500, 0xff005000, 0xff005500, GATE)).toBe(true);
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
  it('parses vd_dithermode / vd_reconmode / vd_rgbmaxdelta with matched-mode fallbacks', () => {
    expect(parseDitherMode('2x2')).toBe('2x2');
    expect(parseDitherMode('4x4')).toBe('4x4');
    expect(parseDitherMode('bogus')).toBe('4x4');
    expect(parseReconMode('2x2sub+2x2box')).toBe('2x2sub+2x2box');
    expect(parseReconMode('4x4sub+4x1')).toBe('4x4sub+4x1');
    expect(parseReconMode('legacy')).toBe('legacy');
    expect(parseReconMode('nope')).toBe('2x2sub+2x2box');
    expect(parseRgbMaxDelta('8,4,8')).toEqual({ r: 8, g: 4, b: 8 });
    expect(parseRgbMaxDelta('0,0,0')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseRgbMaxDelta('junk')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseRgbMaxDelta('8,4')).toEqual({ r: 8, g: 4, b: 0 });
    expect(parseRgbMaxDelta('300,-5,8')).toEqual({ r: 255, g: 0, b: 8 });
  });
  it('defaults are the matched hardware-correct profile (2x2sub+2x2box, 8,8,8)', () => {
    expect(parseReconMode('')).toBe('2x2sub+2x2box');
    expect(defaultVoodooState().reconmode).toBe('2x2sub+2x2box');
    expect(defaultVoodooState().rgbmaxdelta).toEqual({ r: 8, g: 8, b: 8 });
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
