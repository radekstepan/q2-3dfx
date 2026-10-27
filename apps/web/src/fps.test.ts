import { describe, expect, it } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { stringWidth } from '@q2/client';
import { bootPlay, drawPlayHud, fpsHudAnchor, fpsVisible, FPS_GREEN } from './play.js';
import { formatFps, showFpsEnabled, updateFpsOverlay } from './dom.js';

describe('fps counter', () => {
  it('formatFps is pure: fps + ms/frame', () => {
    expect(formatFps(60)).toBe('fps 60 · 16.7 ms');
    expect(formatFps(30.4)).toContain('30');
    expect(formatFps(30.4)).toContain('ms');
    // Degenerate inputs never produce NaN/Infinity text.
    expect(formatFps(0)).toBe('fps --');
    expect(formatFps(-5)).toBe('fps --');
    expect(formatFps(Number.NaN)).toBe('fps --');
    expect(formatFps(Number.POSITIVE_INFINITY)).toBe('fps --');
  });

  it('overlay helper is DOM-guarded (Node has no document)', () => {
    expect(typeof document).toBe('undefined');
    // Null / non-DOM input just returns the text, never throws.
    // (Legacy helper: no longer wired — the in-canvas HUD owns the counter.)
    expect(updateFpsOverlay(null, 60)).toBe(formatFps(60));
    expect(updateFpsOverlay(undefined, 60)).toBe(formatFps(60));
  });

  it('overlay helper writes text and toggles visibility on stub nodes', () => {
    const shown = { textContent: '', style: { display: 'none' } };
    const text = updateFpsOverlay(shown, 60, true);
    expect(shown.textContent).toBe(text);
    expect(shown.textContent).toContain('fps 60');
    expect(shown.style.display).toBe('');
    const hidden = { textContent: 'fps 60', style: { display: '' } };
    updateFpsOverlay(hidden, 60, false);
    expect(hidden.style.display).toBe('none');
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

  it('fpsHudAnchor is top-left in-view (never over the controls panel)', () => {
    expect(fpsHudAnchor(160, 'fps 60')).toEqual({ x: 8, y: 8 });
    expect(fpsHudAnchor(40, 'fps 60')).toEqual({ x: 8, y: 8 });
  });

  it('drawPlayHud draws green `fps N` top-left when enabled, nothing when gated', () => {
    resetCVars();
    try {
      const boot = bootPlay({ width: 160, height: 120 });
      // Enabled (default): fps text paints FPS_GREEN pixels top-left.
      const target = { width: 160, height: 120, color: new Uint32Array(160 * 120) };
      drawPlayHud(target, boot, { fps: 60, frame: 1 });
      const text = 'fps 60';
      const { x, y } = fpsHudAnchor(target.width, text);
      expect(x).toBe(8);
      expect(y).toBe(8);
      let green = 0;
      for (let py = y; py < y + 8; py++) {
        for (let px = x; px < x + stringWidth(text); px++) {
          if (target.color[py * target.width + px] === FPS_GREEN) green++;
        }
      }
      expect(green).toBeGreaterThan(0);
      // Crosshair still draws (the HUD keeps world/crosshair/weapon/hp).
      expect(target.color[60 * 160 + 80]).toBe(0xffffffff);
      // Gated: no green anywhere.
      setCVar('cl_showfps', 0);
      const off = { width: 160, height: 120, color: new Uint32Array(160 * 120) };
      drawPlayHud(off, boot, { fps: 60, frame: 1 });
      expect(off.color.some((c) => c === FPS_GREEN)).toBe(false);
    } finally {
      resetCVars();
    }
  });
});
