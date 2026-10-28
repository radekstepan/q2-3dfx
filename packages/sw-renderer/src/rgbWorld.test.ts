// astra V2a/V2c fixtures: RGB lightmap hue preservation + RGB world backend.
// - buildRGBLightMap keeps red/blue patches distinct under style/dlight
//   changes (hue-preserving over-range, never scalar grades).
// - drawSpansRGB on a colored-lit wall differs from the indexed resolve.
// - software pixels stay bit-identical when the RGB path is armed but not
//   selected (golden hash pinned with the flag toggled on then off).
import { afterEach, describe, expect, it } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import { SoftwareRenderer, setRGBWorldEnabled, isRGBWorldEnabled } from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import {
  buildLightMap, buildRGBLightMap, LIGHT_OVERBRIGHT,
} from './light.js';
import { RGBLightCache, rgbCacheKey } from './surfaceCache.js';
import {
  SPAN_OPAQUE, SPAN_TURBULENT, createSpan,
  drawSpansSoftware, drawSpansRGB, buildRGBMaterial,
  rgbMipLevel, rgbPickMipLevel, rgbSampleTexture,
  type SpanList,
} from './spans.js';
import { buildColormap, defaultPalette } from './colormap.js';

afterEach(() => {
  setRGBWorldEnabled(false);
});

/** 2x2 wall: gray, red patch, blue patch, gray (row-major RGB luxels). */
function wallSamples(): Uint8Array {
  return new Uint8Array([
    128, 128, 128,
    200, 40, 40,
    40, 40, 200,
    128, 128, 128,
  ]);
}

const CENTER = new Float32Array([0, 0, 0]);

describe('buildRGBLightMap hue preservation (astra V2a)', () => {
  it('keeps red/blue patches distinct under a neutral style', () => {
    const out = new Uint8Array(2 * 2 * 3);
    buildRGBLightMap(out, wallSamples(), 2, 2, [1], [], CENTER, 0);
    const red = [out[3], out[4], out[5]];
    const blue = [out[6], out[7], out[8]];
    // red patch stays red-dominant, blue patch blue-dominant
    expect(red[0]).toBeGreaterThan(red[1]! + 40);
    expect(red[0]).toBeGreaterThan(red[2]! + 40);
    expect(blue[2]).toBeGreaterThan(blue[0]! + 40);
    expect(blue[2]).toBeGreaterThan(blue[1]! + 40);
  });

  it('dims both patches proportionally under a style change (hue kept)', () => {
    const full = new Uint8Array(12);
    const dim = new Uint8Array(12);
    buildRGBLightMap(full, wallSamples(), 2, 2, [1], [], CENTER, 0);
    buildRGBLightMap(dim, wallSamples(), 2, 2, [0.5], [], CENTER, 0);
    // red patch ratios survive the dimming (r/g/b scale together)
    const fr = full[3]! / Math.max(1, full[4]!);
    const dr = dim[3]! / Math.max(1, dim[4]!);
    expect(Math.abs(fr - dr)).toBeLessThan(0.35);
    expect(dim[3]!).toBeLessThan(full[3]!);
    expect(dim[6]!).toBeLessThan(full[6]!);
    // blue still blue-dominant after dimming
    expect(dim[8]).toBeGreaterThan(dim[6]!);
  });

  it('normalizes over-range by the max channel instead of clipping (hue kept)', () => {
    const out = new Uint8Array(12);
    // style 2 pushes red (200,40,40) to (400,80,80): max-channel normalize
    // gives (255,51,51), NOT per-channel-clipped (255,80,80).
    buildRGBLightMap(out, wallSamples(), 2, 2, [2], [], CENTER, 0);
    expect(out[3]).toBe(255);
    expect(out[4]).toBe(out[5]);
    expect(out[4]).toBeLessThan(80);
  });

  it('adds colored dynamic light per channel without touching other hues', () => {
    // local red flash next to the red luxel only (per-luxel positions:
    // red luxel at the origin, everything else 100 units away, radius 10)
    const pos = new Float32Array([
      100, 0, 0,
      0, 0, 0,
      100, 0, 0,
      100, 0, 0,
    ]);
    const dl = [{
      origin: new Float32Array([0, 0, 0]),
      intensity: 10,
      color: new Float32Array([1, 0, 0]),
    }];
    const base = new Uint8Array(12);
    const lit = new Uint8Array(12);
    buildRGBLightMap(base, wallSamples(), 2, 2, [1], [], CENTER, 0);
    buildRGBLightMap(lit, wallSamples(), 2, 2, [1], dl, CENTER, 1, LIGHT_OVERBRIGHT, pos);
    // red channel boosted everywhere; the hue-preserving normalize scales
    // green/blue down together (they stay equal) instead of clipping red
    // alone (which would wash the patch toward pink). Huge radius = uniform
    // falloff, so the check isolates the color math.
    expect(lit[3]).toBe(255);
    expect(lit[4]).toBe(lit[5]);
    expect(lit[4]).toBeLessThan(base[4]!);
    // the wash goes the right way: added pure-red light makes the patch
    // relatively redder ((r-g)/r grows); per-channel clipping would give
    // (255,80,80) — relatively LESS red than the unlit (200,40,40).
    const redness = (lux: Uint8Array, o: number): number =>
      (lux[o]! - Math.max(lux[o + 1]!, lux[o + 2]!)) / lux[o]!;
    expect(redness(lit, 3)).toBeGreaterThan(redness(base, 3));
    // untouched luxels are byte-identical (blue patch keeps its hue, gray
    // stays gray) — the flash is local to the red luxel
    for (const o of [0, 6, 9]) {
      expect(lit[o]).toBe(base[o]);
      expect(lit[o + 1]).toBe(base[o + 1]);
      expect(lit[o + 2]).toBe(base[o + 2]);
    }
    expect(lit[8]).toBeGreaterThan(lit[6]!);
  });

  it('does not reuse scalar grades (red light != its luma)', () => {
    const rgb = new Uint8Array(3);
    const grade = new Uint8Array(1);
    const red = new Uint8Array([220, 30, 30]);
    buildRGBLightMap(rgb, red, 1, 1, [1], [], CENTER, 0);
    buildLightMap(grade, red, 1, 1, [1], [], CENTER, 0);
    // scalar path reduces to luma (~0.36 -> grade ~23); RGB keeps r >> b
    expect(grade[0]).toBeGreaterThan(0);
    expect(grade[0]).toBeLessThan(40);
    expect(rgb[0]).toBeGreaterThan(rgb[2]! + 100);
  });
});

describe('rgb sampler ports', () => {
  it('negative LOD bias favours finer levels (voodoo tLOD sign)', () => {
    expect(rgbMipLevel(4, -0.35, 7)).toBeLessThan(rgbMipLevel(4, 0.35, 7));
    expect(rgbMipLevel(4, -0.35, 7)).toBeCloseTo(1.65, 10);
  });

  it('clamps degenerate rho and caps at maxLevel', () => {
    expect(rgbMipLevel(0, -0.35, 7)).toBe(0);
    expect(rgbMipLevel(1e9, 0, 3)).toBe(3);
    expect(rgbMipLevel(-4, 0, 3)).toBe(0);
  });

  it('mip-dither picks level n at f=0 and clamps to the chain', () => {
    expect(rgbPickMipLevel(0, 7, 7, true, 5)).toBe(0);
    expect(rgbPickMipLevel(99, 0, 0, true, 2)).toBe(2);
    expect(rgbPickMipLevel(1.5, 0, 0, false, 9)).toBe(2);
  });

  it('repeat addressing wraps each tap (no clamp seam)', () => {
    // 2x1 texture: black | white. Bilinear at u=-0.25 wraps to u=1.75,
    // i.e. 3/4 of the way from texel 1 (white) toward wrapped texel 0
    // (black): (64*255 + 192*0 + 32768) >> 16 = 64. Clamp pins to 0.
    const tex = new Uint8Array([0, 0, 0, 255, 255, 255]);
    const out = new Uint8Array(3);
    rgbSampleTexture(tex, 2, 1, -0.25, 0, out, 0, true, false);
    expect(out[0]).toBe(64);
    // clamp would pin to texel 0 (black)
    rgbSampleTexture(tex, 2, 1, -0.25, 0, out, 0, false, false);
    expect(out[0]).toBe(0);
  });

  it('buildRGBMaterial chains 4x4 -> 2x2 -> 1x1 and expands indices', () => {
    const pal = new Uint8Array(768);
    pal[5 * 3] = 10; pal[5 * 3 + 1] = 20; pal[5 * 3 + 2] = 30;
    const mat = buildRGBMaterial(new Uint8Array(16).fill(5), 4, 4, pal, null, {});
    expect(mat.levels.length).toBe(3);
    expect(mat.levels[0]!.width).toBe(4);
    expect(mat.levels[2]!.width).toBe(1);
    expect(mat.levels[0]!.data[0]).toBe(10);
    expect(mat.levels[0]!.data[1]).toBe(20);
    expect(mat.levels[0]!.data[2]).toBe(30);
  });
});

describe('drawSpansRGB vs indexed resolve', () => {
  /** Grayscale palette: any indexed resolve is achromatic by construction. */
  function grayPalette(): Uint8Array {
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = i;
      pal[i * 3 + 1] = i;
      pal[i * 3 + 2] = i;
    }
    return pal;
  }

  /** Fresh 565 authority planes (depth cleared to all-ones = far). */
  function mkPlanes(n: number): { q: Uint16Array; cover: Uint8Array; depth: Uint16Array } {
    return { q: new Uint16Array(n), cover: new Uint8Array(n), depth: new Uint16Array(n).fill(0xffff) };
  }

  /** Expand one stored 565 quantum to 8:8:8 (matches the endFrame resolve). */
  function expandQ(q: Uint16Array, i: number): [number, number, number] {
    const v = q[i]!;
    const r5 = (v >> 11) & 31, g6 = (v >> 5) & 63, b5 = v & 31;
    return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)];
  }

  /** One 4px span, constant u=v=1, constant depth, red luxel light. */
  function redSpan(): ReturnType<typeof createSpan> {
    const s = createSpan();
    s.kind = SPAN_OPAQUE;
    s.y = 0; s.x0 = 0; s.x1 = 4;
    s.iz = 1; s.diz = 0;
    s.uz = 1; s.duz = 0;
    s.vz = 1; s.dvz = 0;
    s.light = 40; s.dlight = 0;
    s.lu = 0; s.lv = 0; s.dlu = 0;
    s.ord = 0;
    return s;
  }

  it('colored-lit wall output differs from the indexed resolve', () => {
    const W = 4, H = 1;
    const pal = grayPalette();
    const texels = new Uint8Array(16).fill(100);
    // --- software path: grade light -> index -> grayscale expand ---
    const idx = new Uint8Array(W * H);
    const zb = new Float32Array(W * H);
    const colormap = buildColormap(defaultPalette());
    const list: SpanList = { spans: [redSpan()], count: 1 };
    const sw = drawSpansSoftware(idx, zb, W, H, list,
      { width: 4, height: 4, texels },
      { width: 1, height: 1, values: new Uint8Array([40]) }, colormap);
    expect(sw.spans).toBe(1);
    // expand through the grayscale palette: achromatic by construction
    const swR = pal[idx[0]! * 3]!;
    expect(swR).toBe(pal[idx[0]! * 3 + 1]);
    expect(swR).toBe(pal[idx[0]! * 3 + 2]);
    // --- RGB path: same wall, red luxel light keeps its hue ---
    const pl = mkPlanes(W * H);
    const mat = buildRGBMaterial(texels, 4, 4, pal,
      { samples: new Uint8Array([255, 0, 0]), luxW: 1, luxH: 1 },
      { overbright: false, lodBias: 0, mipDither: false });
    const rgb = drawSpansRGB(pl.q, pl.cover, pl.depth, W, H, list, mat);
    expect(rgb.spans).toBe(1);
    expect([...pl.cover]).toEqual([1, 1, 1, 1]);
    const [r, g, b] = expandQ(pl.q, 0);
    // gray texel (100,100,100) x red light, no overbright -> (100,0,0)
    // in 8-bit, (99,0,0) after the 565 write quantise (100>>3=12 -> 99)
    expect(r).toBe(99);
    expect(g).toBe(0);
    expect(b).toBe(0);
    // ...which the indexed resolve cannot reproduce (its pixel is gray)
    expect(r).not.toBe(b);
    expect(swR).toBe(pal[idx[0]! * 3]);
  });

  it('overbright doubles before the clamp', () => {
    const W = 2, H = 1;
    const pal = grayPalette();
    const texels = new Uint8Array([100, 100, 100, 100]);
    const s = redSpan();
    s.x1 = 2;
    const list: SpanList = { spans: [s], count: 1 };
    // 8-bit 100/200 quantise to 99/206 through RGB565 (12->99, 25->206)
    for (const [overbright, want] of [[false, 99], [true, 206]] as const) {
      const pl = mkPlanes(W * H);
      const mat = buildRGBMaterial(texels, 2, 2, pal,
        { samples: new Uint8Array([255, 255, 255]), luxW: 1, luxH: 1 },
        { overbright, lodBias: 0, mipDither: false });
      drawSpansRGB(pl.q, pl.cover, pl.depth, W, H, list, mat);
      expect(expandQ(pl.q, 0)[0]).toBe(want);
    }
  });

  it('draws turbulent spans with warp (step-3 material coverage)', () => {
    const W = 4, H = 1;
    const pal = grayPalette();
    const t = redSpan();
    t.kind = SPAN_TURBULENT;
    const list: SpanList = { spans: [t], count: 1 };
    const pl = mkPlanes(W * H);
    const mat = buildRGBMaterial(new Uint8Array(16).fill(100), 4, 4, pal, null, {});
    const r = drawSpansRGB(pl.q, pl.cover, pl.depth, W, H, list, mat);
    expect(r.spans).toBe(1);
    expect([...pl.cover]).toEqual([1, 1, 1, 1]);
  });
});

describe('RGBLightCache keying', () => {
  it('hits within one generation; variant separates loops', () => {
    const c = new RGBLightCache(1024);
    const texels = new Uint8Array([1, 2, 3, 4]);
    const mat = buildRGBMaterial(texels, 2, 2, new Uint8Array(768), null, {});
    const entry = {
      block: {
        texels, bw: 2, bh: 2,
        light: new Uint8Array([63]), luxW: 1, luxH: 1,
        rgb: new Uint8Array([1, 2, 3]),
      },
      material: mat,
    };
    expect(c.get(7, 11, 0)).toBeNull();
    c.put(7, 11, 0, entry);
    expect(c.get(7, 11, 0)).toBe(entry);
    // the deferred alpha loop's variant never serves the opaque binding
    expect(c.get(7, 11, 0, 1)).toBeNull();
    expect(c.hits).toBe(1);
    expect(c.misses).toBe(2);
    expect(rgbCacheKey(7, 11, 0)).toBe(rgbCacheKey(7, 11, 0));
    // serial-free key: dlight generations do NOT miss by themselves —
    // surgical invalidation (dropTouchedSurfaces) owns staleness, so a
    // muzzle flash keeps every untouched surface hot.
    expect(rgbCacheKey(7, 11, 0)).toBe('7:11:0:0');
  });

  it('invalidateSurfaces drops every style/mip/variant of a surface', () => {
    const c = new RGBLightCache(1 << 20);
    const texels = new Uint8Array([9]);
    const mat = buildRGBMaterial(texels, 1, 1, new Uint8Array(768), null, {});
    const entry = {
      block: { texels, bw: 1, bh: 1, light: new Uint8Array(0), luxW: 1, luxH: 1, rgb: new Uint8Array([1, 1, 1]) },
      material: mat,
    };
    c.put(3, 1, 0, entry);
    c.put(3, 2, 1, entry, 1);
    c.put(4, 1, 0, entry);
    expect(c.size).toBe(3);
    c.invalidateSurfaces([3]);
    expect(c.size).toBe(1);
    expect(c.get(4, 1, 0)).toBe(entry);
  });
});

describe('frame-level RGB world wiring', () => {
  function renderOnce(W: number, H: number): { r: SoftwareRenderer; hash: string } {
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = (i * 5) & 255;
      pal[i * 3 + 1] = (i * 3 + 40) & 255;
      pal[i * 3 + 2] = (i * 2 + 80) & 255;
    }
    r.setPalette(pal);
    const styles = new Float32Array(256).fill(1);
    r.beginFrame();
    r.renderView(
      { origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles, fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: styles },
      { name: 'devroom', data: createDevroom() },
      [],
    );
    r.endFrame();
    let h = 2166136261;
    const idx = fb.index!;
    for (let i = 0; i < idx.length; i++) {
      h ^= idx[i]!;
      h = Math.imul(h, 16777619);
    }
    return { r, hash: (h >>> 0).toString(16).padStart(8, '0') };
  }

  it('flag defaults off', () => {
    expect(isRGBWorldEnabled()).toBe(false);
  });

  it('software pixels stay bit-identical when RGB is armed but not selected', () => {
    const a = renderOnce(160, 120);
    expect(a.hash).toBeTruthy();
    // arm (but never select) the RGB path: identical index plane expected
    setRGBWorldEnabled(true);
    setRGBWorldEnabled(false);
    const b = renderOnce(160, 120);
    expect(b.hash).toBe(a.hash);
    expect(b.r.testRGBStats().used).toBe(false);
  });

  it('enabled RGB world pass writes covered RGB pixels and caches', () => {
    const W = 160, H = 120;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(new Uint8Array(768).fill(128));
    const world = { name: 'devroom', data: createDevroom() };
    const view = {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time: 0, lightStyles: new Float32Array(256).fill(1),
    };
    setRGBWorldEnabled(true);
    r.beginFrame();
    r.renderView(view, world, []);
    r.endFrame();
    const st = r.testRGBStats();
    expect(st.enabled).toBe(true);
    expect(st.used).toBe(true);
    expect(st.coverPixels).toBeGreaterThan(1000);
    expect(st.misses).toBeGreaterThan(0);
    // second identical frame: RGB materials come from cache (no new misses)
    const misses = st.misses;
    r.beginFrame();
    r.renderView(view, world, []);
    r.endFrame();
    const st2 = r.testRGBStats();
    expect(st2.misses).toBe(misses);
    expect(st2.coverPixels).toBe(st.coverPixels);
  });

  it('style change rebuilds RGB blocks (no stale color)', () => {
    const W = 160, H = 120;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(new Uint8Array(768).fill(128));
    const world = { name: 'devroom', data: createDevroom() };
    const view = {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time: 0, lightStyles: new Float32Array(256).fill(1),
    };
    setRGBWorldEnabled(true);
    r.beginFrame();
    r.renderView(view, world, []);
    r.endFrame();
    const sm1 = r.testRGBStats().misses;
    expect(sm1).toBeGreaterThan(0);
    // same styles -> hits, no new misses
    r.beginFrame();
    r.renderView(view, world, []);
    r.endFrame();
    const sm2 = r.testRGBStats().misses;
    expect(sm2).toBe(sm1);
    // changed style values -> same key hash differs -> rebuild
    view.lightStyles = new Float32Array(256).fill(0.25);
    r.beginFrame();
    r.renderView(view, world, []);
    r.endFrame();
    expect(r.testRGBStats().misses).toBeGreaterThan(sm2);
  });
});
