import { describe, expect, it } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { stringWidth } from '@q2/client';
import { bootPlay, drawPlayHud, fpsHudAnchor, FPS_GREEN } from './play.js';
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

  it('cl_showfps gates the overlay (default 1)', () => {
    resetCVars();
    // Registered by dom.ts import with default 1.
    expect(showFpsEnabled()).toBe(true);
    setCVar('cl_showfps', 0);
    expect(showFpsEnabled()).toBe(false);
    setCVar('cl_showfps', 1);
    expect(showFpsEnabled()).toBe(true);
    resetCVars();
  });

  it('drawPlayHud leaves the canvas fps-free (DOM overlay owns the counter)', () => {
    resetCVars();
    const boot = bootPlay({ width: 160, height: 120 });
    const target = { width: 160, height: 120, color: new Uint32Array(160 * 120) };
    drawPlayHud(target, boot, { fps: 60, frame: 1 });
    // Old behaviour painted `fps 60` green top-right in-canvas; the HUD
    // cleanup removed position readout, controls hint, and that overlay
    // (fps already shows in the DOM #q2-fps overlay via updateFpsOverlay).
    const text = 'fps 60';
    const { x, y } = fpsHudAnchor(target.width, text);
    let lit = 0;
    let green = 0;
    for (let py = y; py < y + 8; py++) {
      for (let px = x; px < x + stringWidth(text); px++) {
        const c = target.color[py * target.width + px]!;
        if (c !== 0) lit++;
        if (c === FPS_GREEN) green++;
      }
    }
    expect(green).toBe(0);
    void lit;
    // Crosshair still draws (the HUD keeps world/crosshair/weapon/hp).
    expect(target.color[60 * 160 + 80]).toBe(0xffffffff);
    resetCVars();
  });
});
