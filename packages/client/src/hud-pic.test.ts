// RELEASE-6: asset HUD blitting (`drawPic`/`drawField`) with real pak art.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { createFramebuffer } from '@q2/renderer-api';
import {
  drawField,
  drawPic,
  FIELD_DIGIT_W,
  formatField,
  type DigitPics,
  type IndexedPic,
} from './hud.js';

const pic = (w: number, h: number, fill: (x: number, y: number) => number): IndexedPic => {
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels[y * w + x] = fill(x, y);
  return { width: w, height: h, pixels };
};

/** Palette mapping index i to grey (i,i,i). */
const greyPalette = (): Uint8Array => {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    p[i * 3] = i;
    p[i * 3 + 1] = i;
    p[i * 3 + 2] = i;
  }
  return p;
};

const RGBA = (i: number): number => (0xff000000 | (i << 16) | (i << 8) | i) >>> 0;

describe('drawPic', () => {
  it('expands indices through the palette and skips the transparent index', () => {
    const fb = createFramebuffer(4, 4, false);
    drawPic(fb, 1, 1, pic(2, 2, (x, y) => (x === 0 && y === 0 ? 255 : x + y * 2 + 1)), greyPalette());
    expect(fb.color[1 * 4 + 1]).toBe(0);
    expect(fb.color[1 * 4 + 2]).toBe(RGBA(2));
    expect(fb.color[2 * 4 + 1]).toBe(RGBA(3));
    expect(fb.color[2 * 4 + 2]).toBe(RGBA(4));
  });

  it('clips at the edges without throwing', () => {
    const fb = createFramebuffer(2, 2, false);
    expect(() => drawPic(fb, -1, -1, pic(4, 4, () => 7), greyPalette())).not.toThrow();
    expect(fb.color.filter((v) => v === RGBA(7)).length).toBe(4);
  });

  it('rejects short palettes and truncated pics', () => {
    const fb = createFramebuffer(2, 2, false);
    expect(() => drawPic(fb, 0, 0, pic(2, 2, () => 1), new Uint8Array(100))).toThrow();
    expect(() =>
      drawPic(fb, 0, 0, { width: 4, height: 4, pixels: new Uint8Array(3) }, greyPalette()),
    ).toThrow();
  });
});

describe('drawField', () => {
  const digits = (f: (d: number) => IndexedPic): DigitPics => ({
    digits: Array.from({ length: 10 }, (_, d) => f(d)),
    minus: pic(16, 24, () => 9),
  });
  const pics = { num: digits((d) => pic(16, 24, () => d + 1)), anum: digits((d) => pic(16, 24, () => d + 50)) };

  it('formats values like SCR_DrawField (truncate left, minus, width clamp)', () => {
    expect(formatField(100, 3)).toBe('100');
    expect(formatField(-5, 3)).toBe('-5');
    expect(formatField(123456, 3)).toBe('123');
    expect(formatField(123456, 9)).toBe('12345');
    expect(formatField(7, 0)).toBe('');
  });

  it('right-aligns digits in 16px cells with a 2px inset', () => {
    const fb = createFramebuffer(64, 24, false);
    drawField(fb, 0, 0, 'num', 3, 7, pics, greyPalette());
    // '7' in the last cell: x = 0+2+16*2 .. +16, ink index 8.
    expect(fb.color[12 * 64 + 34]).toBe(RGBA(8));
    expect(fb.color[0]).toBe(0);
  });

  it('uses the alert set for anum and the minus pic for negatives', () => {
    const fb = createFramebuffer(64, 24, false);
    drawField(fb, 0, 0, 'anum', 2, -1, pics, greyPalette());
    // '-' cell ink 9, '1' cell ink 51.
    expect(fb.color[12 * 64 + 4]).toBe(RGBA(9));
    expect(fb.color[12 * 64 + 20]).toBe(RGBA(51));
  });

  it('rejects digit sets without exactly 10 pics', () => {
    const fb = createFramebuffer(32, 24, false);
    expect(() => drawField(fb, 0, 0, 'num', 1, 1, { num: { digits: [], minus: pics.num.minus }, anum: pics.anum }, greyPalette())).toThrow();
  });
});

// ---------- real-data integration (local PCX shim; client must not depend on @q2/formats) ----------

const Q2_PAK = process.env.Q2_PAK;
const HAVE_PAK = !!Q2_PAK && existsSync(Q2_PAK);

function findLump(name: string): Uint8Array {
  const bytes = readFileSync(Q2_PAK as string);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dirofs = view.getInt32(4, true);
  const dirlen = view.getInt32(8, true);
  for (let i = 0; i < dirlen / 64; i++) {
    const base = dirofs + i * 64;
    let end = base;
    while (end < base + 56 && bytes[end] !== 0) end++;
    let s = '';
    for (let k = base; k < end; k++) s += String.fromCharCode(bytes[k]!);
    if (s.toLowerCase() === name.toLowerCase()) {
      const off = view.getInt32(base + 56, true);
      const len = view.getInt32(base + 60, true);
      return bytes.subarray(off, off + len);
    }
  }
  throw new Error(`lump missing in test pak: ${name}`);
}

function decodePcx(lump: Uint8Array): IndexedPic & { palette: Uint8Array } {
  const view = new DataView(lump.buffer, lump.byteOffset, lump.byteLength);
  const w = view.getUint16(8, true) - view.getUint16(4, true) + 1;
  const h = view.getUint16(10, true) - view.getUint16(6, true) + 1;
  const pixels = new Uint8Array(w * h);
  let pos = 128;
  let p = 0;
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      const b = lump[pos++]!;
      if ((b & 0xc0) === 0xc0) {
        const run = b & 0x3f;
        const v = lump[pos++]!;
        for (let k = 0; k < run; k++) pixels[p++] = v;
        x += run;
      } else {
        pixels[p++] = b;
        x++;
      }
    }
  }
  return { width: w, height: h, pixels, palette: lump.subarray(lump.length - 768) };
}

describe.runIf(HAVE_PAK)('real HUD art blits (Q2_PAK)', () => {
  it('blits a real digit with transparency at 640x480 placement', () => {
    const { width, height, pixels, palette } = decodePcx(findLump('pics/num_0.pcx'));
    expect([width, height]).toEqual([16, 24]);
    const fb = createFramebuffer(640, 480, false);
    // Health field origin for `xv 0 yb -24` at 640x480.
    const ink = pixels.filter((v) => v !== 255).length;
    expect(ink).toBeGreaterThan(0);
    drawPic(fb, 160, 456, { width, height, pixels }, palette);
    let painted = 0;
    for (const v of fb.color) if (v !== 0) painted++;
    expect(painted).toBe(ink);
    // Nothing leaks outside the 16x24 cell.
    expect(fb.color[455 * 640 + 160]).toBe(0);
    expect(fb.color[480 * 640 - 1]).toBe(0);
  });

  it('blits an opaque 24x24 icon fully and distinctly from its neighbor', () => {
    const a = decodePcx(findLump('pics/i_health.pcx'));
    const b = decodePcx(findLump('pics/i_help.pcx'));
    expect(a.pixels.includes(255)).toBe(false);
    const fb = createFramebuffer(320, 240, false);
    drawPic(fb, 50, 216, a, a.palette);
    let painted = 0;
    for (const v of fb.color) if (v !== 0) painted++;
    expect(painted).toBe(24 * 24);
    expect(a.pixels).not.toEqual(b.pixels);
  });

  it('blits the 256x192 help background at the F1 origin', () => {
    const bg = decodePcx(findLump('pics/help.pcx'));
    expect([bg.width, bg.height]).toEqual([256, 192]);
    const fb = createFramebuffer(640, 480, false);
    drawPic(fb, 192, 128, bg, bg.palette);
    // Interior pixel is painted (backgrounds are near-opaque blocks).
    expect(fb.color[200 * 640 + 300]).not.toBe(0);
    // Digit art on top stays legible: blit a digit over the background.
    const d = decodePcx(findLump('pics/num_1.pcx'));
    const ink = d.pixels.filter((v) => v !== 255).length;
    expect(ink).toBeGreaterThan(0);
    let changed = 0;
    const snapshot = fb.color.slice();
    drawPic(fb, 200, 132, d, d.palette);
    for (let yy = 132; yy < 132 + 24; yy++) {
      for (let xx = 200; xx < 200 + 16; xx++) {
        if (fb.color[yy * 640 + xx] !== snapshot[yy * 640 + xx]) changed++;
      }
    }
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThanOrEqual(ink);
  });

  it('drawField renders a real health value from real digit pics', () => {
    const digits: IndexedPic[] = [];
    for (let d = 0; d <= 9; d++) digits.push(decodePcx(findLump(`pics/num_${d}.pcx`)));
    const minus = decodePcx(findLump('pics/num_minus.pcx'));
    const pal = decodePcx(findLump('pics/num_0.pcx')).palette;
    const fb = createFramebuffer(320, 240, false);
    drawField(fb, 0, 216, 'num', 3, 100, { num: { digits, minus }, anum: { digits, minus } }, pal);
    let painted = 0;
    for (const v of fb.color) if (v !== 0) painted++;
    const ink = ['1', '0', '0'].reduce(
      (n, ch) => n + digits[ch.charCodeAt(0) - 48]!.pixels.filter((v) => v !== 255).length,
      0,
    );
    expect(painted).toBe(ink);
    expect(painted).toBeGreaterThan(0);
  });
});
