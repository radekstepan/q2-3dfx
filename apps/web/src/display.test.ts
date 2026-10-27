import { describe, expect, it } from 'vitest';
import { setCVar, getCVarString } from '@q2/config';
import {
  applyBrightness,
  bootPlay,
  BRIGHTNESS_DEFAULT,
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  drawPlayHud,
  formatFpsText,
  fpsHudAnchor,
  FPS_GREEN,
  getBrightness,
  posHudAnchor,
  POS_GREY,
  resolveDisplay,
} from './play.js';
import { cvarControlKind, cvarOptions, renderCvarPanel, blitCopyRGBA, blitIsLittleEndian } from './dom.js';
import { defaultBrowserWorkers } from './render-workers.js';

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
  it('fpsHudAnchor pins the top-right slot (8px margins, clamped)', () => {
    const text = formatFpsText(60);
    expect(text).toBe('fps 60');
    const a = fpsHudAnchor(160, text);
    expect(a).toEqual({ x: 104, y: 8 });
    // Tiny screens clamp the same way (still top-right, never negative).
    expect(fpsHudAnchor(40, text)).toEqual({ x: 0, y: 8 });
    // Same input, same anchor (pure).
    expect(fpsHudAnchor(160, text)).toEqual(a);
  });

  it('posHudAnchor pins the top-left slot (8px margins)', () => {
    expect(posHudAnchor()).toEqual({ x: 8, y: 8 });
  });

  it('FPS_GREEN is an opaque readable green in 0xAABBGGRR (canvas colour)', () => {
    expect(FPS_GREEN).toBe(0xff00ff00);
  });

  it('POS_GREY is an opaque dim grey in 0xAABBGGRR (canvas colour)', () => {
    expect(POS_GREY).toBe(0xff999999);
  });

  it('canvas draws fps top-right in-canvas when enabled, none when gated', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    // Enabled: green struck pixels land in the top-right readout row.
    setCVar('cl_showfps', 1);
    try {
      const target = { width: 160, height: 120, color: new Uint32Array(160 * 120) };
      drawPlayHud(target, boot, { fps: 60, frame: 1 });
      let green = 0;
      for (let y = 8; y < 16; y++) {
        for (let x = 104; x < 152; x++) {
          if (target.color[y * 160 + x] === FPS_GREEN) green++;
        }
      }
      expect(green).toBeGreaterThan(10);
    } finally {
      setCVar('cl_showfps', 1);
    }
    // Gated: the canvas stays fps-free.
    setCVar('cl_showfps', 0);
    try {
      const target = { width: 160, height: 120, color: new Uint32Array(160 * 120) };
      drawPlayHud(target, boot, { fps: 60, frame: 1 });
      expect(target.color.some((c) => c === FPS_GREEN)).toBe(false);
    } finally {
      setCVar('cl_showfps', 1);
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
    setCVar('cl_showfps', 1);
    setCVar('cl_showpos', 1);
    try {
      const target = resolveDisplay(boot);
      drawPlayHud({ width: 160, height: 120, color: target }, boot, { fps: 60, frame: 1 });
      // HUD text is drawn post-lift: the hp row keeps its authored colour…
      expect(target.some((c) => c === 0xffffffff)).toBe(true);
      // …and the crosshair centre pixel keeps full white.
      expect(target[60 * 160 + 80]).toBe(0xffffffff);
      // …and both in-canvas readouts stay legible with exact colours:
      // fps `fps 60` top-right (green) and pos top-left (dim grey).
      let green = 0;
      for (let y = 8; y < 16; y++) {
        for (let x = 104; x < 152; x++) {
          if (target[y * 160 + x] === FPS_GREEN) green++;
        }
      }
      expect(green).toBeGreaterThan(10);
      let grey = 0;
      for (let y = 8; y < 16; y++) {
        for (let x = 8; x < 160; x++) {
          if (target[y * 160 + x] === POS_GREY) grey++;
        }
      }
      expect(grey).toBeGreaterThan(10);
    } finally {
      setCVar('r_brightness', BRIGHTNESS_DEFAULT);
      setCVar('cl_showfps', 1);
      setCVar('cl_showpos', 1);
    }
  });

  it('cvar panel uses checkboxes for booleans, <select> for known domains, text otherwise', () => {
    expect(cvarControlKind('vid_renderer')).toBe('select');
    expect(cvarOptions('vid_renderer')).toEqual(['software', 'voodoo']);
    expect(cvarControlKind('sw_workers')).toBe('select');
    expect(cvarOptions('sw_workers')).toEqual(['0', '2', '4']);
    expect(cvarControlKind('cl_showfps')).toBe('checkbox');
    expect(cvarControlKind('vd_dither')).toBe('checkbox');
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

  it('blitCopyRGBA bulk path equals explicit LE byte expansion (alpha kept)', () => {
    const src = new Uint32Array(257);
    for (let i = 0; i < src.length; i++) src[i] = (Math.imul(i + 1, 2654435761) >>> 0);
    src[0] = 0x00000000;
    src[1] = 0xffffffff;
    src[2] = 0x80112233;
    const dst = new Uint8Array(src.length * 4);
    blitCopyRGBA(dst, src);
    for (let i = 0; i < src.length; i++) {
      const px = src[i]!;
      expect(dst[i * 4]).toBe(px & 255);
      expect(dst[i * 4 + 1]).toBe((px >> 8) & 255);
      expect(dst[i * 4 + 2]).toBe((px >> 16) & 255);
      expect(dst[i * 4 + 3]).toBe(px >>> 24);
    }
    // The bulk path is only valid where it matters: every real browser is LE.
    expect(blitIsLittleEndian()).toBe(true);
  });

  it('blitCopyRGBA handles empty + oversized destinations without throwing', () => {
    const src = new Uint32Array([0xff112233, 0x00445566]);
    const empty = new Uint8Array(0);
    expect(() => blitCopyRGBA(empty, src)).not.toThrow();
    // Oversized destination: prefix filled, tail untouched (loop fallback).
    const big = new Uint8Array(src.length * 4 + 8).fill(0xaa);
    blitCopyRGBA(big, src);
    expect(big[0]).toBe(0x33);
    expect(big[3]).toBe(0xff);
    expect(big[4]).toBe(0x66);
    expect(big[7]).toBe(0x00);
    expect(big.slice(8).every((b) => b === 0xaa)).toBe(true);
  });

  it('defaultBrowserWorkers stays in the pool range (navigator-capped, sane fallback)', () => {
    const n = defaultBrowserWorkers();
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(7);
  });
});
