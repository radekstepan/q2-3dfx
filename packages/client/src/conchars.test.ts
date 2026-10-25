// conchars loader tests (TODO(M6.1)): real `pics/conchars.pcx` conversion.
//
// The synthetic tests run everywhere. The real-asset test reads
// `pics/conchars.pcx` straight out of `Q2_PAK` with a minimal inline
// PACK-dir scan + PCX RLE decode, so this file adds no new cross-package
// dependencies (BRAIN.md §4). Skipped when `Q2_PAK` is absent (BRAIN.md §3).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { createFramebuffer } from '@q2/renderer-api';
import {
  CONCHARS_TRANSPARENT,
  drawChar,
  drawString,
  getConcharsFont,
  loadConcharsFont,
  makeConcharsFont,
  setConcharsFont,
} from './hud.js';

/** 128x128 diagonal-foreground synthetic: pixel (x,y) is ink iff x === y. */
function diagonalPixels(ink = 5, paper: number = CONCHARS_TRANSPARENT): Uint8Array {
  const px = new Uint8Array(128 * 128);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) px[y * 128 + x] = x === y ? ink : paper;
  }
  return px;
}

/** Glyph `ch` of a font as 8 row strings of '0'/'1' (for readable asserts). */
function glyphRows(font: Uint8Array, ch: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 8; y++) {
    let s = '';
    for (let x = 0; x < 8; x++) s += font[ch * 64 + y * 8 + x] ? '1' : '0';
    rows.push(s);
  }
  return rows;
}

describe('loadConcharsFont (synthetic 128x128)', () => {
  it('maps the 16x16 grid of 8x8 cells deterministically', () => {
    const px = diagonalPixels();
    const a = loadConcharsFont(px);
    const b = loadConcharsFont({ width: 128, height: 128, pixels: px });
    expect(a.length).toBe(256 * 64);
    expect(a).toEqual(b);
    // Image x===y diagonal: glyph 0 (cell col 0, row 0) keeps the diagonal…
    expect(glyphRows(a, 0)).toEqual([
      '10000000',
      '01000000',
      '00100000',
      '00010000',
      '00001000',
      '00000100',
      '00000010',
      '00000001',
    ]);
    // …glyph 17 (cell col 1, row 1, base 8,8) too…
    expect(glyphRows(a, 17)).toEqual(glyphRows(a, 0));
    // …but glyph 1 (cell col 1, row 0) never meets the diagonal: blank.
    expect(glyphRows(a, 1).every((r) => r === '00000000')).toBe(true);
  });

  it('emits only 0/1 and honors a custom transparent index', () => {
    const px = diagonalPixels(9, 0);
    const font = loadConcharsFont(px, 0);
    expect(font.every((v) => v === 0 || v === 1)).toBe(true);
    expect(glyphRows(font, 0)[0]).toBe('10000000');
    // Default transparent (255) matches neither ink nor paper: all opaque.
    const inverted = loadConcharsFont(px);
    expect(glyphRows(inverted, 0)[0]).toBe('11111111');
  });

  it('rejects bad dimensions and short buffers', () => {
    expect(() => loadConcharsFont({ width: 64, height: 64, pixels: new Uint8Array(4096) })).toThrow();
    expect(() => loadConcharsFont(new Uint8Array(100))).toThrow();
    expect(() => loadConcharsFont(diagonalPixels(), 256)).toThrow();
  });

  it('loaded fonts still clip and advance 8px in drawChar/drawString', () => {
    const font = loadConcharsFont(diagonalPixels());
    const fb = createFramebuffer(64, 16, false);
    // NUL is glyph 0 and 0x11 is glyph 17: both carry the image diagonal.
    expect(drawString(fb, 0, 0, '\0\x11', 0xffffffff, font)).toBe(16);
    // Only the diagonal pixel at (0,0) is lit in the top-left cell.
    expect(fb.color[0]).toBe(0xffffffff);
    expect(fb.color[1]).toBe(0);
    const tiny = createFramebuffer(8, 8, false);
    expect(() => drawChar(tiny, -4, -4, 65, 0xffffffff, font)).not.toThrow();
    expect(() => drawString(tiny, 100, 100, 'offscreen', 1, font)).not.toThrow();
  });

  it('setConcharsFont installs a loaded font; fallback stays procedural', () => {
    const loaded = loadConcharsFont(diagonalPixels());
    setConcharsFont(loaded);
    expect(getConcharsFont()).toBe(loaded);
    // Fallback generator is untouched: still deterministic procedural noise.
    expect(makeConcharsFont()).toEqual(makeConcharsFont());
    setConcharsFont(makeConcharsFont());
  });
});

// --- real asset: minimal PACK + PCX readers (test-only, no new deps) ---

interface PakEntry {
  name: string;
  offset: number;
  length: number;
}

function readPakEntries(pakPath: string): PakEntry[] {
  const bytes = readFileSync(pakPath);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== 'PACK') throw new Error('not a PACK file');
  const dirOffset = view.getInt32(4, true);
  const dirLength = view.getInt32(8, true);
  const entries: PakEntry[] = [];
  for (let o = dirOffset; o < dirOffset + dirLength; o += 64) {
    let end = o;
    while (end < o + 56 && bytes[end] !== 0) end++;
    const name = bytes.subarray(o, end).toString('latin1');
    entries.push({ name, offset: view.getInt32(o + 56, true), length: view.getInt32(o + 60, true) });
  }
  return entries;
}

/** Decode an 8-bit single-plane RLE PCX lump (mirrors parsePCX). */
function decodePcx(lump: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const view = new DataView(lump.buffer, lump.byteOffset, lump.byteLength);
  const width = view.getUint16(8, true) - view.getUint16(4, true) + 1;
  const height = view.getUint16(10, true) - view.getUint16(6, true) + 1;
  const pixels = new Uint8Array(width * height);
  let pos = 128;
  let p = 0;
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
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
  return { width, height, pixels };
}

const Q2_PAK = process.env.Q2_PAK;
const HAVE_PAK = !!Q2_PAK && existsSync(Q2_PAK);

describe.runIf(HAVE_PAK)('real pics/conchars.pcx (Q2_PAK)', () => {
  it('converts to a 0/1 font with a blank space and a struck A', () => {
    const entries = readPakEntries(Q2_PAK as string);
    const entry = entries.find((e) => e.name === 'pics/conchars.pcx');
    expect(entry).toBeDefined();
    const bytes = readFileSync(Q2_PAK as string);
    const lump = bytes.subarray(entry!.offset, entry!.offset + entry!.length);
    const { width, height, pixels } = decodePcx(lump);
    expect(width).toBe(128);
    expect(height).toBe(128);

    const font = loadConcharsFont({ width, height, pixels });
    expect(font.length).toBe(256 * 64);
    expect(font.every((v) => v === 0 || v === 1)).toBe(true);
    // Not the procedural fallback: real glyphs differ from xorshift noise.
    expect(font).not.toEqual(makeConcharsFont());
    // Space cell is all-transparent; 'A' (65) row 1 is __XXXXX_ per the asset.
    expect(glyphRows(font, 32).every((r) => r === '00000000')).toBe(true);
    expect(glyphRows(font, 65)[1]).toBe('00111110');
    // Most of the 256 cells carry ink; background dominates overall.
    let nonBlank = 0;
    let lit = 0;
    for (let ch = 0; ch < 256; ch++) {
      let cell = 0;
      for (let k = 0; k < 64; k++) {
        if (font[ch * 64 + k]) {
          cell++;
          lit++;
        }
      }
      if (cell > 0) nonBlank++;
    }
    expect(nonBlank).toBeGreaterThan(200);
    expect(lit).toBeGreaterThan(3000);
    expect(lit).toBeLessThan(9000);

    // drawChar with the real font paints exactly the struck pixels.
    const fb = createFramebuffer(8, 8, false);
    drawChar(fb, 0, 0, 65, 0xffffffff, font);
    let painted = 0;
    for (const v of fb.color) if (v === 0xffffffff) painted++;
    const struck = glyphRows(font, 65).join('').split('1').length - 1;
    expect(painted).toBe(struck);
    expect(painted).toBeGreaterThan(0);
  });
});
