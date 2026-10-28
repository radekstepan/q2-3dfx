// RGB mip-UV scaling: every RGB sampler must read the selected mip level
// with UVs scaled into that level (us = u / 2^lvl), not with full-resolution
// UVs. fillPerspTriRGB picked lvl>0 but sampled t.data with full-res u/v, so
// a 4x4-base / 2x2-mip1 chain read texel (u mod 2) instead of (u/2): at
// u=2.0 it returned the (0,0) texel (green) instead of (1,0) (red). The
// world span loops (runSubdivRGBRepeat/Clamp/Generic) share the defect: their
// fixed-point UVs are full-res but wrapped/clamped into the shrunken mip
// dims. All four tests below fail before the fix (green where red expected)
// and pass after.
import { describe, expect, it } from 'vitest';
import { fillPerspTriRGB } from './alias.js';
import {
  runSubdivRGBClamp, runSubdivRGBGeneric, runSubdivRGBRepeat,
  type RGBMaterial, type RGBMipLevel,
} from './spans.js';

const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 255, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const WHITE: [number, number, number] = [255, 255, 255];

function paint(data: Uint8Array, w: number, x: number, y: number, c: [number, number, number]): void {
  data[(y * w + x) * 3] = c[0];
  data[(y * w + x) * 3 + 1] = c[1];
  data[(y * w + x) * 3 + 2] = c[2];
}

/** 4x4 all-red base + 2x2 mip1 with (0,0)=GREEN, (1,0)=RED. Masks opaque. */
function twoLevelChain(): RGBMipLevel[] {
  const base = new Uint8Array(4 * 4 * 3);
  for (let i = 0; i < 16; i++) paint(base, 4, i % 4, (i / 4) | 0, RED);
  const mip1 = new Uint8Array(2 * 2 * 3);
  paint(mip1, 2, 0, 0, GREEN);
  paint(mip1, 2, 1, 0, RED);
  paint(mip1, 2, 0, 1, BLUE);
  paint(mip1, 2, 1, 1, WHITE);
  return [
    { data: base, width: 4, height: 4, mask: new Uint8Array(16).fill(1) },
    { data: mip1, width: 2, height: 2, mask: new Uint8Array(4).fill(1) },
  ];
}

function testMat(levels: RGBMipLevel[], addressS: 'repeat' | 'clamp', addressT: 'repeat' | 'clamp'): RGBMaterial {
  return {
    levels,
    addressS, addressT,
    light: null,
    overbright: false,
    lodBias: 25, // force the coarse pick (rho~0 -> log2(eps)+25 clamps to maxLevel)
    mipDither: false,
    bilinear: false, // point sample: exact texel, no blend ambiguity
    zbits: 0,
    blend: 'opaque',
    alpha: 1,
    warp: false,
    turbPhase: 0,
    flatColor: null,
    alphaTest: null,
    depthWrite: true,
    opaqueMask: false,
  };
}

const RED565 = 0xf800;
const GREEN565 = 0x07e0;

describe('mip UV scaling (alias + world share the defect)', () => {
  it('fillPerspTriRGB samples the picked mip with scaled UVs', () => {
    // Repeat addressing isolates the scale bug from the clamp policy.
    // Full-res u=2.0 -> mip1 coord 1.0 -> texel (1,0) = RED. Unscaled u=2.0
    // wraps into the 2-wide mip at (0,0) = GREEN.
    const W = 64, H = 64;
    const q = new Uint16Array(W * H);
    const cover = new Uint8Array(W * H);
    const depth = new Uint16Array(W * H).fill(0xffff);
    const mat = testMat(twoLevelChain(), 'repeat', 'repeat');
    const v = (x: number, y: number) => ({ x, y, iz: 1, uiz: 2, viz: 0, r: 1, g: 1, b: 1 });
    const n = fillPerspTriRGB(q, cover, depth, W, H,
      v(8, 8), v(56, 8), v(8, 56), mat, 256, 'opaque', true, null);
    expect(n).toBeGreaterThan(0);
    // Interior pixel, far from edges so coverage is not in doubt.
    const o = 20 * W + 20;
    expect(cover[o]).toBe(1);
    expect(q[o]).toBe(RED565);
  });

  it('runSubdivRGBRepeat scales UVs into the picked mip', () => {
    const W = 4;
    const q = new Uint16Array(W);
    const cover = new Uint8Array(W);
    const depth = new Uint16Array(W).fill(0xffff);
    const mat = testMat(twoLevelChain(), 'repeat', 'repeat');
    // Constant full-res u=2.0 -> mip1 coord 1.0 -> texel (1,0) = RED.
    runSubdivRGBRepeat(q, cover, depth, 0, W, 0, 0,
      1, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, mat, 1, 1, null);
    for (let i = 0; i < W; i++) {
      expect(cover[i]).toBe(1);
      expect(q[i]).toBe(RED565);
    }
  });

  it('runSubdivRGBClamp scales UVs into the picked mip', () => {
    const W = 4;
    const q = new Uint16Array(W);
    const cover = new Uint8Array(W);
    const depth = new Uint16Array(W).fill(0xffff);
    const levels = twoLevelChain();
    paint(levels[1]!.data, 2, 0, 0, RED);
    paint(levels[1]!.data, 2, 1, 0, GREEN);
    const matC = testMat(levels, 'clamp', 'clamp');
    runSubdivRGBClamp(q, cover, depth, 0, W, 0, 0,
      1, 0, 1.5, 0, 0, 0, 1.5, 0, 0, 0, 0, matC, 1, 1, null);
    for (let i = 0; i < W; i++) {
      expect(cover[i]).toBe(1);
      expect(q[i]).toBe(RED565);
    }
  });

  it('runSubdivRGBGeneric scales UVs into the picked mip', () => {
    const W = 4;
    const q = new Uint16Array(W);
    const cover = new Uint8Array(W);
    const depth = new Uint16Array(W).fill(0xffff);
    const mat = testMat(twoLevelChain(), 'repeat', 'repeat');
    runSubdivRGBGeneric(q, cover, depth, 0, W, 0, 0,
      1, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, mat, 1, 1, 'opaque', 256, null, 0, null);
    for (let i = 0; i < W; i++) {
      expect(cover[i]).toBe(1);
      expect(q[i]).toBe(RED565);
    }
  });
});
