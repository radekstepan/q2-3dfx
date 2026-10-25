// @q2/client/hud — conchars-style 8x8 HUD text renderer (M6.1).
//
// Blits 8x8 glyphs into a framebuffer scratch surface. The bundled font is
// procedural (deterministic xorshift glyphs) so HUD text works without
// `pics/conchars.pcx`; when the real asset is available the caller converts
// its 128x128 pixels with `loadConcharsFont` and installs the result via
// `setConcharsFont`. No DOM anywhere.
import type { Framebuffer } from '@q2/renderer-api';
import { Com_Error } from '@q2/config';

export const GLYPH_W = 8;
export const GLYPH_H = 8;
export const CONCHARS_COUNT = 256;

/** 256 glyphs x 64 bytes (1 byte per pixel, 0/1) — row-major 8x8. */
export type ConcharsFont = Uint8Array;

/** Deterministic procedural 8x8 font (xorshift32 hashed per glyph). */
export function makeConcharsFont(): ConcharsFont {
  const font = new Uint8Array(CONCHARS_COUNT * GLYPH_W * GLYPH_H);
  for (let c = 0; c < CONCHARS_COUNT; c++) {
    let s = (c * 2654435761) >>> 0 || 0x9e3779b9;
    const next = (): number => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;
      s >>>= 0;
      return s;
    };
    // Space (32) and NUL stay blank.
    if (c === 0 || c === 32) continue;
    // Border frame for visibility + hashed interior dots.
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const edge = x === 0 || y === 0 || x === 7 || y === 7;
        const bit = edge ? next() % 3 !== 0 : next() % 2 === 0;
        font[(c * 64 + y * 8 + x)] = bit ? 1 : 0;
      }
    }
  }
  return font;
}

let activeFont: ConcharsFont | null = null;

export function setConcharsFont(font: ConcharsFont): void {
  activeFont = font;
}

export function getConcharsFont(): ConcharsFont {
  if (!activeFont) activeFont = makeConcharsFont();
  return activeFont;
}

/**
 * Layout of `pics/conchars.pcx` (ref_soft `Draw_Char` in `r_draw.c`):
 * 128x128 palette indices holding 256 glyphs in a row-major 16x16 grid of
 * 8x8 cells. Glyph `ch` lives at cell column `ch & 15`, row `ch >> 4`, i.e.
 * image offset `(row * 8 + gy) * 128 + col * 8 + gx`. Any pixel equal to the
 * transparent index is background (id `TRANSPARENT_COLOR` 255); every other
 * index is an opaque stroke pixel.
 */
export const CONCHARS_PIC_SIZE = 128;
export const CONCHARS_GRID = 16;
/** id `TRANSPARENT_COLOR`: palette index `Draw_Char` never paints. */
export const CONCHARS_TRANSPARENT = 255;

/**
 * Minimal decoded-image shape accepted by `loadConcharsFont`. Structurally
 * compatible with the `Pcx` interface from `@q2/formats`, so a parsed
 * `pics/conchars.pcx` can be passed directly without this package depending
 * on `@q2/formats` (see BRAIN.md §4 dependency rules).
 */
export interface ConcharsImage {
  readonly width: number;
  readonly height: number;
  /** Row-major palette indices, `width * height` entries. */
  readonly pixels: Uint8Array;
}

/**
 * Convert the real 128x128 `pics/conchars.pcx` pixels into a `ConcharsFont`
 * (256 glyphs x 64 bytes of 0/1, row-major 8x8). Accepts either a decoded
 * image object (`{ width, height, pixels }`, e.g. `parsePCX` output) or raw
 * pre-decoded row-major pixels of length 128*128. Pixels equal to
 * `transparent` (default 255, matching the asset and id's `Draw_Char`) map
 * to 0, all others to 1; the tint is applied later by `drawChar`/`drawString`.
 */
export function loadConcharsFont(
  image: ConcharsImage | Uint8Array,
  transparent: number = CONCHARS_TRANSPARENT,
): ConcharsFont {
  if (!Number.isInteger(transparent) || transparent < 0 || transparent > 255) {
    Com_Error('fatal', `loadConcharsFont: transparent index out of range ${transparent}`);
  }
  const pixels = image instanceof Uint8Array ? image : image.pixels;
  if (!(image instanceof Uint8Array)) {
    if (image.width !== CONCHARS_PIC_SIZE || image.height !== CONCHARS_PIC_SIZE) {
      Com_Error(
        'fatal',
        `loadConcharsFont: need 128x128 conchars, got ${image.width}x${image.height}`,
      );
    }
  }
  if (pixels.length < CONCHARS_PIC_SIZE * CONCHARS_PIC_SIZE) {
    Com_Error('fatal', `loadConcharsFont: need 16384 pixels, got ${pixels.length}`);
  }
  const font = new Uint8Array(CONCHARS_COUNT * GLYPH_W * GLYPH_H);
  for (let ch = 0; ch < CONCHARS_COUNT; ch++) {
    const col = ch & 15;
    const row = ch >> 4;
    const dst = ch * 64;
    for (let gy = 0; gy < 8; gy++) {
      const srcRow = (row * 8 + gy) * CONCHARS_PIC_SIZE + col * 8;
      for (let gx = 0; gx < 8; gx++) {
        font[dst + gy * 8 + gx] = pixels[srcRow + gx] === transparent ? 0 : 1;
      }
    }
  }
  return font;
}

export interface BlitSurface {
  width: number;
  height: number;
  color: Uint32Array; // 0xAABBGGRR
}

function toSurface(fb: Framebuffer | BlitSurface): BlitSurface {
  return fb as BlitSurface;
}

/** Blit one 8x8 glyph. Out-of-bounds pixels are clipped. Returns width (8). */
export function drawChar(
  fb: Framebuffer | BlitSurface,
  x: number,
  y: number,
  ch: number,
  rgba: number,
  font: ConcharsFont = getConcharsFont(),
): number {
  const s = toSurface(fb);
  const glyph = (ch & 255) * 64;
  for (let gy = 0; gy < 8; gy++) {
    const py = y + gy;
    if (py < 0 || py >= s.height) continue;
    for (let gx = 0; gx < 8; gx++) {
      const px = x + gx;
      if (px < 0 || px >= s.width) continue;
      if (font[glyph + gy * 8 + gx]) s.color[py * s.width + px] = rgba;
    }
  }
  return 8;
}

/** Blit a string; `fixed` keeps NUL/space advance (default true). */
export function drawString(
  fb: Framebuffer | BlitSurface,
  x: number,
  y: number,
  text: string,
  rgba: number,
  font?: ConcharsFont,
): number {
  let cx = x;
  for (let i = 0; i < text.length; i++) {
    drawChar(fb, cx, y, text.charCodeAt(i) & 255, rgba, font);
    cx += 8;
  }
  return cx - x;
}

export function stringWidth(text: string): number {
  return text.length * 8;
}

/** Fill a rectangle (panels, console background). */
export function fillRect(
  fb: Framebuffer | BlitSurface,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: number,
): void {
  const s = toSurface(fb);
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(s.width, x + w);
  const y1 = Math.min(s.height, y + h);
  for (let py = y0; py < y1; py++) {
    const row = py * s.width;
    for (let px = x0; px < x1; px++) s.color[row + px] = rgba;
  }
}
