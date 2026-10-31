// @q2/client/hud — conchars-style 8x8 HUD text renderer (M6.1).
//
// Baked hand-authored 8x8 fallback font (public-domain style, no asset
// needed). Each glyph is a solid 1px-stroke pattern inside the 8x8 cell —
// no border frames, no hash noise — so devroom text is legible at 1x.
// `loadConcharsFont` (real `pics/conchars.pcx`) stays the preferred path
// and `setConcharsFont` overrides this fallback unchanged.
import type { Framebuffer } from '@q2/renderer-api';
import { Com_Error } from '@q2/config';

export const GLYPH_W = 8;
export const GLYPH_H = 8;
export const CONCHARS_COUNT = 256;

/** 256 glyphs x 64 bytes (1 byte per pixel, 0/1) — row-major 8x8. */
export type ConcharsFont = Uint8Array;

/** Baked readable 8x8 fallback font (hand-authored 1px-stroke glyphs). */
export function makeConcharsFont(): ConcharsFont {
  const font = new Uint8Array(CONCHARS_COUNT * GLYPH_W * GLYPH_H);
  const put = (ch: number, rows: readonly string[]): void => {
    const dst = (ch & 255) * 64;
    for (let y = 0; y < 8; y++) {
      const row = rows[y] ?? '00000000';
      for (let x = 0; x < 8; x++) font[dst + y * 8 + x] = row[x] === '1' ? 1 : 0;
    }
  };
  // [char code, 8 rows of '0'/'1'] — solid strokes, no border frames.
  const GLYPHS: ReadonlyArray<readonly [number, readonly string[]]> = [
    [48, ['00111100', '01000010', '01000110', '01001010', '01010010', '01100010', '01000010', '00111100']],
    [49, ['00011000', '00111000', '00011000', '00011000', '00011000', '00011000', '00011000', '00111100']],
    [50, ['00111100', '01000010', '00000010', '00000100', '00011000', '00100000', '01000000', '01111110']],
    [51, ['01111100', '00000010', '00000010', '00111100', '00000010', '00000010', '00000010', '01111100']],
    [52, ['00000100', '00001100', '00010100', '00100100', '01000100', '01111110', '00000100', '00000100']],
    [53, ['01111110', '01000000', '01111100', '00000010', '00000010', '00000010', '01000010', '00111100']],
    [54, ['00111100', '01000000', '01000000', '01111100', '01000010', '01000010', '01000010', '00111100']],
    [55, ['01111110', '00000010', '00000100', '00001000', '00010000', '00010000', '00010000', '00010000']],
    [56, ['00111100', '01000010', '01000010', '00111100', '01000010', '01000010', '01000010', '00111100']],
    [57, ['00111100', '01000010', '01000010', '01000010', '00111110', '00000010', '00000010', '00111100']],
    [65, ['00111100', '01000010', '01000010', '01000010', '01111110', '01000010', '01000010', '01000010']],
    [66, ['01111100', '01000010', '01000010', '01111100', '01000010', '01000010', '01000010', '01111100']],
    [67, ['00111100', '01000010', '01000000', '01000000', '01000000', '01000000', '01000010', '00111100']],
    [68, ['01111000', '01000100', '01000010', '01000010', '01000010', '01000010', '01000100', '01111000']],
    [69, ['01111110', '01000000', '01000000', '01111100', '01000000', '01000000', '01000000', '01111110']],
    [70, ['01111110', '01000000', '01000000', '01111100', '01000000', '01000000', '01000000', '01000000']],
    [71, ['00111100', '01000010', '01000000', '01001110', '01000010', '01000010', '01000010', '00111110']],
    [72, ['01000010', '01000010', '01000010', '01111110', '01000010', '01000010', '01000010', '01000010']],
    [73, ['00111100', '00011000', '00011000', '00011000', '00011000', '00011000', '00011000', '00111100']],
    [74, ['00011110', '00000100', '00000100', '00000100', '00000100', '00000100', '01000100', '00111000']],
    [75, ['01000010', '01000100', '01001000', '01110000', '01001000', '01000100', '01000010', '01000010']],
    [76, ['01000000', '01000000', '01000000', '01000000', '01000000', '01000000', '01000000', '01111110']],
    [77, ['01000010', '01100110', '01011010', '01011010', '01000010', '01000010', '01000010', '01000010']],
    [78, ['01000010', '01100010', '01100010', '01010010', '01001010', '01000110', '01000110', '01000010']],
    [79, ['00111100', '01000010', '01000010', '01000010', '01000010', '01000010', '01000010', '00111100']],
    [80, ['01111100', '01000010', '01000010', '01111100', '01000000', '01000000', '01000000', '01000000']],
    [81, ['00111100', '01000010', '01000010', '01000010', '01010010', '01001010', '01000100', '00111010']],
    [82, ['01111100', '01000010', '01000010', '01111100', '01001000', '01000100', '01000010', '01000010']],
    [83, ['00111110', '01000000', '01000000', '00111100', '00000010', '00000010', '00000010', '01111100']],
    [84, ['01111110', '00011000', '00011000', '00011000', '00011000', '00011000', '00011000', '00011000']],
    [85, ['01000010', '01000010', '01000010', '01000010', '01000010', '01000010', '01000010', '00111100']],
    [86, ['01000010', '01000010', '01000010', '01000010', '01000010', '01100110', '00111100', '00011000']],
    [87, ['01000010', '01000010', '01000010', '01000010', '01011010', '01011010', '01100110', '01000010']],
    [88, ['01000010', '01000010', '00100100', '00011000', '00011000', '00100100', '01000010', '01000010']],
    [89, ['01000010', '01000010', '00100100', '00011000', '00011000', '00011000', '00011000', '00011000']],
    [90, ['01111110', '00000010', '00000100', '00011000', '00100000', '01000000', '01000000', '01111110']],
    [33, ['00011000', '00011000', '00011000', '00011000', '00011000', '00000000', '00000000', '00011000']],
    [34, ['00100100', '00100100', '00100100', '00000000', '00000000', '00000000', '00000000', '00000000']],
    [35, ['00100100', '00100100', '01111110', '00100100', '00100100', '01111110', '00100100', '00100100']],
    [36, ['00011100', '00110100', '00100000', '00111100', '00000010', '00010010', '00111000', '00000000']],
    [37, ['01100010', '01100100', '00001000', '00010000', '00100000', '01001100', '01000110', '00000000']],
    [38, ['00110000', '01001000', '01010100', '00100000', '01010100', '01001000', '01001000', '00110110']],
    [39, ['00011000', '00011000', '00000000', '00000000', '00000000', '00000000', '00000000', '00000000']],
    [40, ['00001100', '00010000', '00100000', '00100000', '00100000', '00100000', '00010000', '00001100']],
    [41, ['00110000', '00001000', '00000100', '00000100', '00000100', '00000100', '00001000', '00110000']],
    [42, ['00000000', '01000100', '00111000', '01111100', '00111000', '01000100', '00000000', '00000000']],
    [43, ['00000000', '00011000', '00011000', '01111100', '00011000', '00011000', '00000000', '00000000']],
    [44, ['00000000', '00000000', '00000000', '00000000', '00011000', '00011000', '00100000', '01000000']],
    [45, ['00000000', '00000000', '00000000', '01111100', '00000000', '00000000', '00000000', '00000000']],
    [46, ['00000000', '00000000', '00000000', '00000000', '00000000', '00110000', '00110000', '00000000']],
    [47, ['00000100', '00000100', '00001000', '00010000', '00010000', '00100000', '01000000', '01000000']],
    [58, ['00000000', '00110000', '00110000', '00000000', '00000000', '00110000', '00110000', '00000000']],
    [59, ['00000000', '00110000', '00110000', '00000000', '00000000', '00110000', '00100000', '01000000']],
    [60, ['00001000', '00010000', '00100000', '01000000', '00100000', '00010000', '00001000', '00000000']],
    [61, ['00000000', '00000000', '01111100', '00000000', '00000000', '01111100', '00000000', '00000000']],
    [62, ['00010000', '00001000', '00000100', '00000010', '00000100', '00001000', '00010000', '00000000']],
    [63, ['00111100', '01000010', '00000010', '00000100', '00011000', '00000000', '00011000', '00000000']],
    [64, ['00111100', '01000010', '01011110', '01010110', '01011110', '01000000', '01000010', '00111100']],
    [91, ['00111100', '00100000', '00100000', '00100000', '00100000', '00100000', '00100000', '00111100']],
    [92, ['01000000', '01000000', '00100000', '00010000', '00010000', '00001000', '00000100', '00000100']],
    [93, ['00111100', '00000100', '00000100', '00000100', '00000100', '00000100', '00000100', '00111100']],
    [94, ['00010000', '00111000', '01010100', '00000000', '00000000', '00000000', '00000000', '00000000']],
    [95, ['00000000', '00000000', '00000000', '00000000', '00000000', '00000000', '00000000', '01111110']],
    [96, ['00100000', '00010000', '00000000', '00000000', '00000000', '00000000', '00000000', '00000000']],
    [123, ['00001100', '00010000', '00010000', '00100000', '00100000', '00010000', '00010000', '00001100']],
    [124, ['00011000', '00011000', '00011000', '00011000', '00011000', '00011000', '00011000', '00011000']],
    [125, ['00110000', '00001000', '00001000', '00000100', '00000100', '00001000', '00001000', '00110000']],
    [126, ['00000000', '00110010', '01001100', '00000000', '00000000', '00000000', '00000000', '00000000']],
  ];
  for (const [ch, rows] of GLYPHS) put(ch, rows);
  // Lowercase mirrors uppercase so HUD strings like 'fps 60' stay legible.
  for (let c = 97; c <= 122; c++) {
    const src = (c - 32) * 64;
    const dst = c * 64;
    for (let k = 0; k < 64; k++) font[dst + k] = font[src + k];
  }
  // High half (128-255) mirrors the low half so extended chars stay readable.
  for (let c = 128; c < 256; c++) {
    const src = (c & 127) * 64;
    const dst = c * 64;
    for (let k = 0; k < 64; k++) font[dst + k] = font[src + k];
  }
  // Space (32), NUL (0), DEL (127) stay blank.
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

/**
 * Alpha-composite a solid color rect over the buffer (SRC_OVER, per
 * channel, rounded + clamped; destination alpha stays opaque). Used for
 * the P_DamageFeedback screen blend: id's `SV_AddBlend` damage term is a
 * fullscreen translucent wash, and the 2D HUD path has no other way to
 * apply it without widening the frozen RefDef contract.
 */
export function fillRectAlpha(
  fb: Framebuffer | BlitSurface,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
): void {
  if (!(alpha > 0)) return;
  const a = Math.min(1, alpha);
  const s = toSurface(fb);
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(s.width, x + w);
  const y1 = Math.min(s.height, y + h);
  const sr = Math.max(0, Math.min(255, Math.round(r)));
  const sg = Math.max(0, Math.min(255, Math.round(g)));
  const sb = Math.max(0, Math.min(255, Math.round(b)));
  for (let py = y0; py < y1; py++) {
    const row = py * s.width;
    for (let px = x0; px < x1; px++) {
      const dst = s.color[row + px]!;
      const dr = dst & 255;
      const dg = (dst >> 8) & 255;
      const db = (dst >> 16) & 255;
      const or = Math.min(255, Math.round(sr * a + dr * (1 - a)));
      const og = Math.min(255, Math.round(sg * a + dg * (1 - a)));
      const ob = Math.min(255, Math.round(sb * a + db * (1 - a)));
      s.color[row + px] = 0xff000000 | (ob << 16) | (og << 8) | or;
    }
  }
}

// ---------------------------------------------------------------------------
// Asset-based HUD blitting (RELEASE-6): 8-bit `pics/*.pcx` art expanded
// through the game palette. `drawPic` is the `re.DrawPic` equivalent for
// statusbar icons, digit pics and backgrounds; `drawField` is
// `SCR_DrawField` (digit-pic numbers, 16px `CHAR_WIDTH` cells, `field_3`
// flash background drawn separately by the layout executor).
// ---------------------------------------------------------------------------

/** Palette index id never paints (`TRANSPARENT_COLOR`). */
export const PIC_TRANSPARENT = 255;

/** Width of one statusbar digit cell (`CHAR_WIDTH` in `cl_scrn.c`). */
export const FIELD_DIGIT_W = 16;
/** Height of statusbar digit/icon art. */
export const FIELD_DIGIT_H = 24;
/** Width/height of statusbar icon art (`ICON_WIDTH`/`ICON_HEIGHT`). */
export const ICON_SIZE = 24;
/** Max digits `SCR_DrawField` renders (wider values left-truncate). */
export const FIELD_MAX_WIDTH = 5;

/** Decoded 8-bit pic (structurally matches `Pcx` from `@q2/formats`). */
export interface IndexedPic {
  readonly width: number;
  readonly height: number;
  /** Row-major palette indices, `width * height` entries. */
  readonly pixels: Uint8Array;
}

/** One digit-pic set (`num_*` normal, `anum_*` alert). */
export interface DigitPics {
  /** Pics for '0'-'9'. */
  readonly digits: readonly IndexedPic[];
  readonly minus: IndexedPic;
}

/**
 * Blit 8-bit pic art through a 768-byte RGB palette (0xAABBGGRR output),
 * skipping the transparent index. Out-of-bounds pixels are clipped.
 */
export function drawPic(
  fb: Framebuffer | BlitSurface,
  x: number,
  y: number,
  pic: IndexedPic,
  palette: Uint8Array,
  transparent: number = PIC_TRANSPARENT,
): void {
  if (palette.length < 768) Com_Error('fatal', `drawPic: need 768-byte palette, got ${palette.length}`);
  if (pic.pixels.length < pic.width * pic.height) {
    Com_Error('fatal', `drawPic: only ${pic.pixels.length} pixels for ${pic.width}x${pic.height}`);
  }
  const s = toSurface(fb);
  for (let gy = 0; gy < pic.height; gy++) {
    const py = y + gy;
    if (py < 0 || py >= s.height) continue;
    const srcRow = gy * pic.width;
    const dstRow = py * s.width;
    for (let gx = 0; gx < pic.width; gx++) {
      const px = x + gx;
      if (px < 0 || px >= s.width) continue;
      const idx = pic.pixels[srcRow + gx]!;
      if (idx === transparent) continue;
      const r = palette[idx * 3]!;
      const g = palette[idx * 3 + 1]!;
      const b = palette[idx * 3 + 2]!;
      s.color[dstRow + px] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
  }
}

/**
 * Characters `SCR_DrawField` renders for a value: `%i` text left-truncated to
 * `width` (max 5), so over-wide values keep their leading digits like id.
 */
export function formatField(value: number, width: number): string {
  const w = Math.min(FIELD_MAX_WIDTH, width);
  if (w < 1) return '';
  return `${Math.trunc(value)}`.slice(0, w);
}

/**
 * Draw a statusbar number from digit pics (`SCR_DrawField`): the field is
 * right-aligned in `width` 16px cells with a 2px left inset, `-` uses the
 * minus pic, and each digit advances `FIELD_DIGIT_W`. The `field_3` flash
 * background (health/ammo/armor pickup flash) is a separate `drawPic` call
 * at the same origin, emitted by `executeStatusbar`.
 */
export function drawField(
  fb: Framebuffer | BlitSurface,
  x: number,
  y: number,
  style: 'num' | 'anum',
  width: number,
  value: number,
  pics: { readonly num: DigitPics; readonly anum: DigitPics },
  palette: Uint8Array,
): void {
  const set = style === 'num' ? pics.num : pics.anum;
  if (set.digits.length !== 10) Com_Error('fatal', `drawField: need 10 digit pics, got ${set.digits.length}`);
  const text = formatField(value, width);
  let cx = x + 2 + FIELD_DIGIT_W * (Math.min(FIELD_MAX_WIDTH, Math.max(0, width | 0)) - text.length);
  for (const ch of text) {
    const pic = ch === '-' ? set.minus : set.digits[ch.charCodeAt(0) - 48];
    if (pic) drawPic(fb, cx, y, pic, palette);
    cx += FIELD_DIGIT_W;
  }
}
