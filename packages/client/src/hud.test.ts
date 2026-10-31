import { describe, expect, it } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import { drawChar, drawString, fillRect, fillRectAlpha, getConcharsFont, makeConcharsFont, stringWidth } from './hud.js';

describe('conchars HUD text renderer', () => {
  it('font is deterministic and non-blank', () => {
    const a = makeConcharsFont();
    const b = makeConcharsFont();
    expect(a).toEqual(b);
    expect(a.length).toBe(256 * 64);
    // Glyph 'A' has lit pixels; space is blank.
    expect(a.slice(65 * 64, 66 * 64).some((v) => v === 1)).toBe(true);
    expect(a.slice(32 * 64, 33 * 64).every((v) => v === 0)).toBe(true);
  });

  it('drawString advances 8px per char and paints pixels', () => {
    const fb = createFramebuffer(64, 16, true);
    const w = drawString(fb, 0, 0, 'AB', 0xffffffff);
    expect(w).toBe(16);
    expect(stringWidth('AB')).toBe(16);
    expect(fb.color.some((v) => v === 0xffffffff)).toBe(true);
  });

  it('fallback font is baked and legible (no noise frames)', () => {
    const font = makeConcharsFont();
    expect(font.length).toBe(256 * 64);
    expect(font.every((v) => v === 0 || v === 1)).toBe(true);
    // Space/NUL/DEL stay blank.
    for (const c of [0, 32, 127]) {
      expect(font.slice(c * 64, (c + 1) * 64).every((v) => v === 0)).toBe(true);
    }
    // Every A-Z0-9 glyph is non-blank and pairwise distinct.
    const codes = [
      ...Array.from({ length: 10 }, (_, i) => 48 + i),
      ...Array.from({ length: 26 }, (_, i) => 65 + i),
    ];
    const seen = new Set<string>();
    for (const c of codes) {
      const glyph = font.slice(c * 64, (c + 1) * 64);
      expect(glyph.some((v) => v === 1)).toBe(true);
      const key = Array.from(glyph).join('');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // No glyph is a full outer border frame.
    for (let c = 0; c < 256; c++) {
      let ring = true;
      for (let x = 0; x < 8 && ring; x++) {
        if (!font[c * 64 + x] || !font[c * 64 + 7 * 8 + x]) ring = false;
      }
      for (let y = 0; y < 8 && ring; y++) {
        if (!font[c * 64 + y * 8] || !font[c * 64 + y * 8 + 7]) ring = false;
      }
      expect(ring).toBe(false);
    }
    // Lowercase mirrors uppercase so 'fps 60 HP 100' is fully legible.
    for (let c = 97; c <= 122; c++) {
      expect(font.slice(c * 64, (c + 1) * 64)).toEqual(
        font.slice((c - 32) * 64, (c - 32) * 64 + 64),
      );
    }
  });

  it("drawString 'fps 60 HP 100' paints exactly the struck pixels", () => {
    const font = makeConcharsFont();
    const text = 'fps 60 HP 100';
    const fb = createFramebuffer(text.length * 8, 8, false);
    drawString(fb, 0, 0, text, 0xffffffff, font);
    let painted = 0;
    for (const v of fb.color) if (v === 0xffffffff) painted++;
    let struck = 0;
    for (const ch of text) {
      const glyph = (ch.charCodeAt(0) & 255) * 64;
      for (let k = 0; k < 64; k++) if (font[glyph + k]) struck++;
    }
    expect(struck).toBeGreaterThan(0);
    expect(painted).toBe(struck);
  });
  it('drawChar clips at the edges without throwing', () => {
    const fb = createFramebuffer(8, 8, false);
    expect(() => drawChar(fb, -4, -4, 65, 0xffffffff, getConcharsFont())).not.toThrow();
    expect(() => drawString(fb, 100, 100, 'offscreen', 1)).not.toThrow();
  });

  it('fillRect paints exactly the rectangle', () => {
    const fb = createFramebuffer(16, 16, false);
    fillRect(fb, 2, 2, 4, 4, 0xff112233);
    let count = 0;
    for (const v of fb.color) if (v === 0xff112233) count++;
    expect(count).toBe(16);
  });
  it('fillRectAlpha composites red at 0.2 over black like the damage floor', () => {
    const fb = createFramebuffer(4, 4, false);
    fb.color.fill(0xff000000);
    fillRectAlpha(fb, 0, 0, 4, 4, 255, 0, 0, 0.2);
    // 255*0.2 = 51 = 0x33 in the R lane (0xAABBGGRR), alpha stays opaque.
    expect(fb.color[0]).toBe(0xff000033);
  });
  it('fillRectAlpha with zero alpha leaves the buffer untouched', () => {
    const fb = createFramebuffer(4, 4, false);
    fb.color.fill(0xff445566);
    fillRectAlpha(fb, 0, 0, 4, 4, 255, 0, 0, 0);
    expect(fb.color[0]).toBe(0xff445566);
  });
});
