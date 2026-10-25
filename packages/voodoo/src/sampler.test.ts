// M4.2 sampler tests: bilinear exactness, LOD + bias, mip-dither
// determinism, fog table endpoints, overbright clamp, palette, tex cap.
import { describe, expect, it } from 'vitest';
import { setCVar } from '@q2/config';
import {
  applyFog,
  buildFogTable,
  capTextureSize,
  capTextureSizeFrame,
  expandPalette,
  fogFactor,
  mipLevel,
  mipRho,
  modulateLightmap,
  pickMipLevel,
  readVoodooState,
  sampleBilinear,
  sampleNearest,
  samplePalette,
  sampleTexture,
  shadePixel,
} from './index.js';

describe('sampleBilinear', () => {
  // row0: 10 20 / row1: 30 40
  const tex = new Uint8Array([10, 20, 30, 40]);
  it('is exact on a 2x2 texture', () => {
    expect(sampleBilinear(tex, 2, 2, 0, 0)).toBe(10);
    expect(sampleBilinear(tex, 2, 2, 1, 0)).toBe(20);
    expect(sampleBilinear(tex, 2, 2, 0, 1)).toBe(30);
    expect(sampleBilinear(tex, 2, 2, 1, 1)).toBe(40);
    expect(sampleBilinear(tex, 2, 2, 0.5, 0)).toBe(15); // (10+20)/2
    expect(sampleBilinear(tex, 2, 2, 0, 0.5)).toBe(20); // (10+30)/2
    expect(sampleBilinear(tex, 2, 2, 0.5, 0.5)).toBe(25); // avg, .5 rounds down
  });
  it('clamps to edge', () => {
    expect(sampleBilinear(tex, 2, 2, -5, -5)).toBe(10);
    expect(sampleBilinear(tex, 2, 2, 99, 99)).toBe(40);
  });
  it('nearest rounds to texel centres', () => {
    expect(sampleNearest(tex, 2, 2, 0.4, 0.4)).toBe(10);
    expect(sampleNearest(tex, 2, 2, 0.6, 0.1)).toBe(20);
    expect(sampleNearest(tex, 2, 2, -1, 9)).toBe(30);
  });
});

describe('samplePalette', () => {
  it('expands a single index through the palette', () => {
    const pal = new Uint8Array(768);
    pal[7 * 3] = 10;
    pal[7 * 3 + 1] = 20;
    pal[7 * 3 + 2] = 30;
    const out = new Uint8Array(3);
    expandPalette(7, pal, out, 0);
    expect([...out]).toEqual([10, 20, 30]);
  });
  it('filters after expansion (grey ramp equals byte bilinear)', () => {
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = i;
      pal[i * 3 + 1] = i;
      pal[i * 3 + 2] = i;
    }
    const idx = new Uint8Array([0, 255, 255, 0]);
    const out = new Uint8Array(3);
    samplePalette(idx, pal, 2, 2, 0.5, 0.5, out, 0, true);
    expect(out[0]).toBe(sampleBilinear(idx, 2, 2, 0.5, 0.5));
    expect(out[0]).toBe(128); // (0+255+255+0)/4 = 127.5 rounds to 128
    expect(out[1]).toBe(128);
    expect(out[2]).toBe(128);
  });
  it('uniform colour block samples exactly, point path hits nearest', () => {
    const pal = new Uint8Array(768);
    pal[7 * 3] = 10;
    pal[7 * 3 + 1] = 20;
    pal[7 * 3 + 2] = 30;
    const idx = new Uint8Array([7, 7, 7, 7]);
    const out = new Uint8Array(6);
    samplePalette(idx, pal, 2, 2, 0.5, 0.5, out, 0, true);
    expect([...out.slice(0, 3)]).toEqual([10, 20, 30]);
    samplePalette(new Uint8Array([3, 7, 3, 3]), pal, 2, 2, 0.6, 0.1, out, 3, false);
    expect([...out.slice(3, 6)]).toEqual([10, 20, 30]); // nearest is index 7
  });
});

describe('mip LOD', () => {
  it('lod = log2(rho) - bias', () => {
    expect(mipLevel(4, 0)).toBe(2);
    expect(mipLevel(1, 0)).toBe(0);
    expect(mipLevel(4, -0.35)).toBeCloseTo(2.35, 10);
    expect(mipLevel(1, -0.35)).toBeCloseTo(0.35, 10);
    expect(mipLevel(0.5, 0)).toBe(0); // clamped, never negative
  });
  it('rejects non-positive rho', () => {
    expect(() => mipLevel(0, 0)).toThrow();
    expect(() => mipLevel(-2, 0)).toThrow();
    expect(() => mipLevel(Number.NaN, 0)).toThrow();
  });
  it('mipRho takes the max gradient length', () => {
    expect(mipRho(3, 4, 0, 0)).toBe(5);
    expect(mipRho(0, 0, 1, 0)).toBe(1);
    expect(mipRho(1, 0, 0, 2)).toBe(2);
  });
});

describe('pickMipLevel', () => {
  it('is deterministic for identical inputs', () => {
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++)
        for (const lod of [0, 0.35, 1.5, 2.5, 3.99]) {
          expect(pickMipLevel(lod, x, y)).toBe(pickMipLevel(lod, x, y));
        }
  });
  it('fraction 0 always picks n, fraction ~1 always picks n+1', () => {
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        expect(pickMipLevel(2.0, x, y)).toBe(2);
        expect(pickMipLevel(2.99, x, y)).toBe(3);
      }
  });
  it('dither pattern has period 4 and splits 50/50 at f = 0.5', () => {
    let n = 0;
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        expect(pickMipLevel(1.5, x, y)).toBe(pickMipLevel(1.5, x + 4, y + 4));
        if (pickMipLevel(1.5, x, y) === 1) n++;
      }
    expect(n).toBe(8);
  });
  it('falls back to round-to-nearest with mipdither off', () => {
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        expect(pickMipLevel(2.5, x, y, false)).toBe(3);
        expect(pickMipLevel(2.4, x, y, false)).toBe(2);
      }
  });
  it('clamps to maxLevel', () => {
    expect(pickMipLevel(99, 0, 0, true, 3)).toBe(3);
    expect(pickMipLevel(-5, 0, 0)).toBe(0);
  });
});

describe('table fog', () => {
  it('64-entry exp^2 table endpoints', () => {
    const t = buildFogTable();
    expect(t.length).toBe(64);
    expect(t[0]).toBe(0);
    expect(t[63]).toBe(255);
    for (let i = 1; i < 64; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1]!);
  });
  it('fogFactor clamps and hits endpoints', () => {
    expect(fogFactor(0)).toBe(0);
    expect(fogFactor(-3)).toBe(0);
    expect(fogFactor(1)).toBe(255);
    expect(fogFactor(99)).toBe(255);
    const mid = fogFactor(0.5);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(255);
  });
  it('applyFog endpoints are exact', () => {
    expect(applyFog(10, 20, 30, 200, 210, 220, 0)).toBe(0xff1e140a);
    expect(applyFog(10, 20, 30, 200, 210, 220, 255)).toBe(0xffdcd2c8);
    expect(applyFog(0, 0, 0, 255, 255, 255, 128)).toBe(0xff808080);
  });
});

describe('modulateLightmap', () => {
  it('multiplies x2 with clamp (vd_overbright)', () => {
    expect(modulateLightmap(255, 255, 255, 255, 255, 255, true)).toBe(0xffffffff);
    expect(modulateLightmap(128, 128, 128, 128, 128, 128, true)).toBe(0xff818181);
    expect(modulateLightmap(0, 0, 0, 200, 200, 200, true)).toBe(0xff000000);
  });
  it('x1 without overbright', () => {
    expect(modulateLightmap(128, 128, 128, 128, 128, 128, false)).toBe(0xff404040);
    expect(modulateLightmap(255, 200, 100, 255, 255, 255, false)).toBe(0xff64c8ff);
  });
});

describe('capTextureSize', () => {
  it('halves until 256x256 fits', () => {
    expect(capTextureSize(512, 512)).toEqual({ w: 256, h: 256 });
    expect(capTextureSize(256, 256)).toEqual({ w: 256, h: 256 });
    expect(capTextureSize(64, 64)).toEqual({ w: 64, h: 64 });
    expect(capTextureSize(300, 300)).toEqual({ w: 150, h: 150 });
    expect(capTextureSize(1024, 64)).toEqual({ w: 256, h: 16 });
    expect(capTextureSize(512, 512, 0)).toEqual({ w: 512, h: 512 }); // cap off
  });
  it('vd_maxtexsize switches the cap through the cvar', () => {
    const saved = readVoodooState().maxtexsize;
    try {
      setCVar('vd_maxtexsize', 128);
      expect(capTextureSizeFrame(512, 512)).toEqual({ w: 128, h: 128 });
      setCVar('vd_maxtexsize', 256);
      expect(capTextureSizeFrame(512, 512)).toEqual({ w: 256, h: 256 });
    } finally {
      setCVar('vd_maxtexsize', saved);
    }
  });
});

describe('cvar-driven sampler', () => {
  it('vd_bilinear / vd_palettetex force point sampling when off', () => {
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = i;
      pal[i * 3 + 1] = i;
      pal[i * 3 + 2] = i;
    }
    const idx = new Uint8Array([0, 255, 255, 0]);
    const out = new Uint8Array(3);
    try {
      setCVar('vd_bilinear', 1);
      setCVar('vd_palettetex', 1);
      sampleTexture(idx, pal, 2, 2, 0.5, 0.5, out, 0);
      expect(out[0]).toBe(128);
      setCVar('vd_bilinear', 0);
      sampleTexture(idx, pal, 2, 2, 0.5, 0.5, out, 0);
      expect(out[0]).toBe(0); // nearest (1,1) -> index 0
      setCVar('vd_bilinear', 1);
      setCVar('vd_palettetex', 0);
      sampleTexture(idx, pal, 2, 2, 0.5, 0.5, out, 0);
      expect(out[0]).toBe(0);
    } finally {
      setCVar('vd_bilinear', 1);
      setCVar('vd_palettetex', 1);
    }
  });
  it('shadePixel honours vd_fog and vd_overbright', () => {
    const st = readVoodooState();
    expect(st.fog).toBe(true);
    expect(st.overbright).toBe(true);
    // factor 0 -> lit only; factor 255 -> fog colour
    expect(shadePixel(128, 128, 128, 128, 128, 128, 1, 2, 3, 0, st)).toBe(
      modulateLightmap(128, 128, 128, 128, 128, 128, true),
    );
    expect(shadePixel(128, 128, 128, 128, 128, 128, 1, 2, 3, 255, st)).toBe(
      0xff030201,
    );
    const noFog = { ...st, fog: false };
    expect(shadePixel(128, 128, 128, 128, 128, 128, 1, 2, 3, 255, noFog)).toBe(
      modulateLightmap(128, 128, 128, 128, 128, 128, true),
    );
  });
});
