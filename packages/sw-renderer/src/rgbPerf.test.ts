// step-5 RGB perf: output-bit-identity pins + inline-math equivalence proofs.
//
// The hot subdiv loops inline five per-pixel helpers (level pick, wrap x2,
// bilinear tap, lightmap tap, modulate). This file proves the inlining is
// bit-identical:
// - frame hash pin: the full RGB composite (fb.color) + index plane for the
//   160x120 devroom view are pinned; ANY output change fails the build.
// - equivalence fuzz: the integer fast paths (POT-mask wrap, integer
//   bilinear weights, hoisted level pick) agree with the exported helpers
//   they replace on every fuzzed input.
import { afterEach, describe, expect, it } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import { SoftwareRenderer, setRGBWorldEnabled } from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import {
  rgbPickMipLevel,
  rgbSampleTexture,
  rgbWrapCoord,
} from './spans.js';

afterEach(() => {
  setRGBWorldEnabled(false);
});

function fnvU8(a: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) {
    h ^= a[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
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

/** Deterministic LCG (no Math.random: the pin must reproduce everywhere). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('step-5 RGB output hash pin (byte-identical before/after)', () => {
  function renderRGB160(): { colorHash: string; indexHash: string; cover: number } {
    const W = 160, H = 120;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    setRGBWorldEnabled(true);
    r.beginFrame();
    r.renderView(
      {
        origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
        fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
      },
      { name: 'devroom', data: createDevroom() },
      [],
    );
    r.endFrame();
    setRGBWorldEnabled(false);
    return {
      colorHash: fnvU8(new Uint8Array(fb.color.buffer)),
      indexHash: fnvU8(fb.index!),
      cover: r.testRGBStats().coverPixels,
    };
  }

  it('RGB composite + index plane match the pinned step-4 hashes', () => {
    const a = renderRGB160();
    expect(a.cover).toBe(160 * 120);
    expect(a.colorHash).toBe('8372b322');
    expect(a.indexHash).toBe('58e0ecf1');
    // second frame is stable (cache hits serve identical color)
    const b = renderRGB160();
    expect(b.colorHash).toBe(a.colorHash);
    expect(b.indexHash).toBe(a.indexHash);
  });
});

describe('step-5 inline-math equivalence (fuzz vs exported helpers)', () => {
  it('integer POT-mask wrap matches rgbWrapCoord on every fuzzed coord', () => {
    const rand = lcg(0x5eED);
    const potOf = (w: number): number => (w & (w - 1)) === 0 ? w - 1 : 0;
    for (let k = 0; k < 20000; k++) {
      const pot = [1, 2, 4, 8, 16, 32, 64, 128, 256][(rand() * 9) | 0]!;
      const nonPot = [3, 5, 6, 12, 24, 48, 96, 100, 192][(rand() * 9) | 0]!;
      const size = k % 2 === 0 ? pot : nonPot;
      const c = ((rand() * 1200) | 0) - 600;
      const want = rgbWrapCoord(c, size, true);
      const mask = potOf(size);
      const got = mask !== 0 ? c & mask : (() => { let m = c % size; if (m < 0) m += size; return m; })();
      // -0 quirk: a negative multiple wraps to -0 via floats but 0 via
      // masking; both index the same slot.
      expect(got === want || (got === 0 && want === 0)).toBe(true);
    }
  });

  it('integer bilinear weights match Math.round on wrapped fractions', () => {
    const rand = lcg(0xB11);
    const outOld = new Uint8Array(3);
    const tex = new Uint8Array(64 * 64 * 3);
    for (let i = 0; i < tex.length; i++) tex[i] = (i * 37 + 11) & 255;
    for (let k = 0; k < 5000; k++) {
      const tu = ((rand() * 0x1000000) | 0) - 0x800000;
      const tv = ((rand() * 0x1000000) | 0) - 0x800000;
      const w = 64, h = 64;
      rgbSampleTexture(tex, w, h, tu / 65536, tv / 65536, outOld, 0, true, true);
      // inline path: integer wrap + integer weights, taps in the same order
      const xi = tu >> 16, yi = tv >> 16;
      const mx = xi & (w - 1), my = yi & (h - 1);
      const fu = ((tu & 0xffff) + 128) >> 8;
      const fv = ((tv & 0xffff) + 128) >> 8;
      const x1 = mx + 1 === w ? 0 : mx + 1;
      const y1 = my + 1 === h ? 0 : my + 1;
      const w00 = (256 - fu) * (256 - fv);
      const w10 = fu * (256 - fv);
      const w01 = (256 - fu) * fv;
      const w11 = fu * fv;
      const pa = (my * w + mx) * 3;
      const pb = (my * w + x1) * 3;
      const pc = (y1 * w + mx) * 3;
      const pd = (y1 * w + x1) * 3;
      for (let c = 0; c < 3; c++) {
        const got = (w00 * tex[pa + c]! + w10 * tex[pb + c]! + w01 * tex[pc + c]! + w11 * tex[pd + c]! + 32768) >> 16;
        expect(got).toBe(outOld[c]);
      }
    }
  });

  it('hoisted spanLod pick matches rgbPickMipLevel per pixel', () => {
    const rand = lcg(0x10D);
    for (let k = 0; k < 5000; k++) {
      const spanLod = rand() * 9.5;
      const mipDither = k % 2 === 0;
      const maxLevel = 8;
      const clampedLod = spanLod < 0 ? 0 : spanLod;
      const lodN = clampedLod | 0;
      const lodF = clampedLod - lodN;
      let base: number, next: number;
      const f16 = lodF * 16;
      if (!mipDither) {
        const lv = lodF < 0.5 ? lodN : lodN + 1;
        base = next = lv > maxLevel ? maxLevel : lv;
      } else {
        base = lodN > maxLevel ? maxLevel : lodN;
        const nx = lodN + 1;
        next = nx > maxLevel ? maxLevel : nx;
      }
      for (let p = 0; p < 16; p++) {
        const x = (rand() * 640) | 0, y = (rand() * 480) | 0;
        const want = rgbPickMipLevel(spanLod, x, y, mipDither, maxLevel);
        const use1 = base !== next && f16 > [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5][(((y | 0) & 3) << 2) | ((x | 0) & 3)]! ? 1 : 0;
        expect(use1 === 0 ? base : next).toBe(want);
      }
    }
  });
});
