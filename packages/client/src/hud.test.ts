import { describe, expect, it } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import { drawChar, drawString, fillRect, getConcharsFont, makeConcharsFont, stringWidth } from './hud.js';

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
});
