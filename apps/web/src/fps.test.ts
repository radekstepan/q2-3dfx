import { describe, expect, it } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
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
    // (The DOM #q2-fps overlay owns the counter; see index.html.)
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

  it('fpsHudAnchor is a legacy top-left helper (DOM overlay owns the counter)', () => {
    expect(fpsHudAnchor(160, 'fps 60')).toEqual({ x: 8, y: 8 });
    expect(fpsHudAnchor(40, 'fps 60')).toEqual({ x: 8, y: 8 });
  });

  it('drawPlayHud never paints fps pixels (DOM #q2-fps owns the counter)', () => {
    resetCVars();
    try {
      const boot = bootPlay({ width: 160, height: 120 });
      // Enabled or gated: the canvas stays fps-free either way.
      for (const v of [1, 0]) {
        setCVar('cl_showfps', v);
        const target = { width: 160, height: 120, color: new Uint32Array(160 * 120) };
        drawPlayHud(target, boot, { fps: 60, frame: 1 });
        expect(target.color.some((c) => c === FPS_GREEN)).toBe(false);
      }
      // Crosshair still draws (the HUD keeps world/crosshair/weapon/hp).
      const target = { width: 160, height: 120, color: new Uint32Array(160 * 120) };
      drawPlayHud(target, boot, { fps: 60, frame: 1 });
      expect(target.color[60 * 160 + 80]).toBe(0xffffffff);
    } finally {
      resetCVars();
    }
  });
});
