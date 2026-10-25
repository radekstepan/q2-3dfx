// @q2/client/hud — conchars-style 8x8 HUD text renderer (M6.1).
//
// Blits 8x8 glyphs into a framebuffer scratch surface. The font is
// procedural (deterministic xorshift glyphs) so HUD text works without
// `pics/conchars.pcx`; when the real asset is available the caller can pass
// its 128x128 1bpp bytes via `setConcharsFont`. No DOM anywhere.
import type { Framebuffer } from '@q2/renderer-api';

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
