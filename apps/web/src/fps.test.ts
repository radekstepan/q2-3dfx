import { describe, expect, it } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import {
  bootPlay,
  drawPlayHud,
  formatFpsText,
  fpsHudAnchor,
  fpsVisible,
  posHudAnchor,
  FPS_GREEN,
} from './play.js';
import { showFpsEnabled } from './dom.js';

/** Count pixels of one colour inside a rectangle (headless glyph assertion). */
function countIn(
  color: Uint32Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgba: number,
): number {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (color[y * width + x] === rgba) n++;
    }
  }
  return n;
}

describe('fps counter (in-canvas conchars, top-right)', () => {
  it('formatFpsText is pure: `fps N` with integer rounding', () => {
    expect(formatFpsText(60)).toBe('fps 60');
    expect(formatFpsText(59.6)).toBe('fps 60');
    expect(formatFpsText(30.4)).toBe('fps 30');
  });

  it('fpsHudAnchor pins the top-right slot (8px margins, clamped)', () => {
    // 'fps 60' is 6 chars x 8px = 48px wide.
    expect(fpsHudAnchor(160, 'fps 60')).toEqual({ x: 104, y: 8 });
    expect(fpsHudAnchor(320, 'fps 60')).toEqual({ x: 264, y: 8 });
    // Tiny screens clamp instead of wrapping negative.
    expect(fpsHudAnchor(40, 'fps 60')).toEqual({ x: 0, y: 8 });
    // Same input, same anchor (pure).
    expect(fpsHudAnchor(160, 'fps 60')).toEqual({ x: 104, y: 8 });
  });

  it('posHudAnchor pins the top-left slot (8px margins)', () => {
    expect(posHudAnchor()).toEqual({ x: 8, y: 8 });
  });

  it('cl_showfps gates the readout (default 1)', () => {
    resetCVars();
    // Registered by dom.ts import with default 1.
    expect(showFpsEnabled()).toBe(true);
    expect(fpsVisible()).toBe(true);
    setCVar('cl_showfps', 0);
    expect(showFpsEnabled()).toBe(false);
    expect(fpsVisible()).toBe(false);
    setCVar('cl_showfps', 1);
    expect(showFpsEnabled()).toBe(true);
    expect(fpsVisible()).toBe(true);
    resetCVars();
  });

  it('drawPlayHud paints green conchars glyphs top-right when enabled', () => {
    resetCVars();
    try {
      const boot = bootPlay({ width: 320, height: 240 });
      setCVar('cl_showfps', 1);
      const target = { width: 320, height: 240, color: new Uint32Array(320 * 240) };
      drawPlayHud(target, boot, { fps: 60, frame: 1 });
      // 'fps 60' anchored at (264, 8): struck glyph pixels are FPS_GREEN.
      expect(countIn(target.color, 320, 264, 8, 312, 16, FPS_GREEN)).toBeGreaterThan(10);
      // Nothing green leaks outside the readout row.
      expect(countIn(target.color, 320, 0, 16, 320, 240, FPS_GREEN)).toBe(0);
      // Crosshair still draws (the HUD keeps world/crosshair/weapon/hp).
      expect(target.color[120 * 320 + 160]).toBe(0xffffffff);
    } finally {
      resetCVars();
    }
  });

  it('drawPlayHud paints no fps pixels when gated or degenerate', () => {
    resetCVars();
    try {
      const boot = bootPlay({ width: 320, height: 240 });
      // Gated: enabled text never reaches the framebuffer.
      setCVar('cl_showfps', 0);
      for (const fps of [60, 1]) {
        const target = { width: 320, height: 240, color: new Uint32Array(320 * 240) };
        drawPlayHud(target, boot, { fps, frame: 1 });
        expect(target.color.some((c) => c === FPS_GREEN)).toBe(false);
      }
      // Enabled but degenerate fps: nothing painted (no NaN/Infinity text).
      setCVar('cl_showfps', 1);
      for (const fps of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const target = { width: 320, height: 240, color: new Uint32Array(320 * 240) };
        drawPlayHud(target, boot, { fps, frame: 1 });
        expect(target.color.some((c) => c === FPS_GREEN)).toBe(false);
      }
    } finally {
      resetCVars();
    }
  });
});
