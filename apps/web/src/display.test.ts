import { describe, expect, it } from 'vitest';
import { setCVar, getCVarString } from '@q2/config';
import {
  applyBrightness,
  bootPlay,
  BRIGHTNESS_DEFAULT,
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  drawPlayHud,
  fpsHudAnchor,
  FPS_GREEN,
  getBrightness,
  resolveDisplay,
} from './play.js';
import { cvarControlKind, cvarOptions, renderCvarPanel } from './dom.js';

function runFrames(host: { frame(nowMs: number): unknown }, fromMs: number, toMs: number, step = 16): void {
  for (let t = fromMs; t <= toMs; t += step) host.frame(t);
}

function meanRGB(buf: Uint32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) {
    const px = buf[i]!;
    s += (px & 255) + ((px >> 8) & 255) + ((px >> 16) & 255);
  }
  return s / (buf.length * 3);
}

describe('display path (fps anchor, brightness, cvar controls)', () => {
  it('fpsHudAnchor is a legacy top-left helper (DOM overlay owns the counter)', () => {
    const text = 'fps 60';
    const a = fpsHudAnchor(160, text);
    expect(a).toEqual({ x: 8, y: 8 });
    // Tiny screens clamp the same way (still top-left, never negative).
    expect(fpsHudAnchor(40, text)).toEqual({ x: 8, y: 8 });
    // Same input, same anchor (pure).
    expect(fpsHudAnchor(160, text)).toEqual(a);
  });

  it('FPS_GREEN is an opaque readable green in 0xAABBGGRR (legacy canvas colour)', () => {
    expect(FPS_GREEN).toBe(0xff00ff00);
  });

  it('canvas never draws fps text (DOM #q2-fps overlay owns the counter)', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    // Enabled or gated: the canvas stays fps-free either way.
    for (const v of [1, 0]) {
      setCVar('cl_showfps', v);
      try {
        const target = { width: 160, height: 120, color: new Uint32Array(160 * 120) };
        drawPlayHud(target, boot, { fps: 60, frame: 1 });
        expect(target.color.some((c) => c === FPS_GREEN)).toBe(false);
      } finally {
        setCVar('cl_showfps', 1);
      }
    }
  });

  it('getBrightness defaults to 2.0, clamps, and persists via cvar', () => {
    expect(BRIGHTNESS_DEFAULT).toBe(2.0);
    expect(getBrightness()).toBe(BRIGHTNESS_DEFAULT);
    setCVar('r_brightness', 1.5);
    try {
      expect(getBrightness()).toBe(1.5);
      expect(getCVarString('r_brightness')).toBe('1.5');
      setCVar('r_brightness', 99);
      expect(getBrightness()).toBe(BRIGHTNESS_MAX);
      setCVar('r_brightness', -3);
      expect(getBrightness()).toBe(BRIGHTNESS_MIN);
    } finally {
      setCVar('r_brightness', BRIGHTNESS_DEFAULT);
    }
  });

  it('applyBrightness is identity at 1.0, brighter above, clamps at 255', () => {
    const buf = new Uint32Array([0xff102030, 0xcc804020, 0xff000000, 0xffffffff]);
    const before = buf.slice();
    applyBrightness(buf, 1);
    expect(Array.from(buf)).toEqual(Array.from(before));
    applyBrightness(buf, 2);
    // 0x10->0x20, 0x20->0x40, 0x30->0x60; alpha untouched.
    expect(buf[0]).toBe(0xff204060);
    // 0x20*2=0x40, 0x40*2=0x80, 0x80*2 clamps to 0xff; alpha 0xcc kept.
    expect(buf[1]).toBe(0xccff8040);
    // Black stays black; white clamps (no wrap); alpha kept.
    expect(buf[2]).toBe(0xff000000);
    expect(buf[3]).toBe(0xffffffff);
  });

  it('resolveDisplay at 1.0 is byte-identical; >1.0 is strictly brighter', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    runFrames(boot.host, 0, 500);
    setCVar('r_brightness', 1.0);
    try {
      const plain = resolveDisplay(boot);
      // Same buffer, untouched: byte-identical to the engine framebuffer.
      expect(plain).toBe(boot.host.fb.color);
      const base = plain.slice();
      setCVar('r_brightness', 1.5);
      const lifted = resolveDisplay(boot);
      expect(lifted).not.toBe(boot.host.fb.color);
      expect(meanRGB(lifted)).toBeGreaterThan(meanRGB(base));
      // The engine buffer itself is never mutated by the lift.
      expect(Array.from(boot.host.fb.color)).toEqual(Array.from(base));
    } finally {
      setCVar('r_brightness', BRIGHTNESS_DEFAULT);
    }
  });

  it('brightness lifts the scene but never clips HUD text', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    runFrames(boot.host, 0, 500);
    setCVar('r_brightness', 2.0);
    try {
      const target = resolveDisplay(boot);
      drawPlayHud({ width: 160, height: 120, color: target }, boot, { fps: 60, frame: 1 });
      // HUD text is drawn post-lift: the hp row keeps its authored colour…
      expect(target.some((c) => c === 0xffffffff)).toBe(true);
      // …and the crosshair centre pixel keeps full white.
      expect(target[60 * 160 + 80]).toBe(0xffffffff);
    } finally {
      setCVar('r_brightness', BRIGHTNESS_DEFAULT);
    }
  });

  it('cvar panel uses <select> for known domains, text otherwise', () => {
    expect(cvarControlKind('vid_renderer')).toBe('select');
    expect(cvarOptions('vid_renderer')).toEqual(['software', 'voodoo']);
    expect(cvarControlKind('sw_workers')).toBe('select');
    expect(cvarOptions('sw_workers')).toEqual(['0', '2', '4']);
    expect(cvarControlKind('cl_showfps')).toBe('select');
    expect(cvarControlKind('r_brightness')).toBe('select');
    expect(cvarOptions('r_brightness')).toContain('1.25');
    expect(cvarOptions('r_brightness')).toContain('2.0');
    expect(cvarControlKind('sensitivity')).toBe('text');
    expect(cvarOptions('sensitivity')).toBeNull();
    expect(cvarControlKind('no_such_cvar')).toBe('text');
  });

  it('renderCvarPanel binds the brightness cvar (Node: names only)', () => {
    expect(typeof document).toBe('undefined');
    const names = renderCvarPanel(null);
    expect(names).toContain('r_brightness');
    expect(names).toContain('vid_renderer');
    expect(names).toContain('cl_showfps');
  });
});
