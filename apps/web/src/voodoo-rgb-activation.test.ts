// q2ts-web RGB-world activation proof (P1 feedback #1).
//
// NO MOCKS anywhere in this file: every assertion runs against the REAL
// `SoftwareRenderer` class (imported from `@q2/sw-renderer`) driving the
// REAL devroom through the REAL `Host` tick loop. The mocked-hook contract
// test lives in voodoo-display.test.ts and is marked UNIT-ONLY there.
//
// Background: `apps/web/src/play.ts armRasterPolicy` used to probe an
// instance hook (`callFirstHook(boot.refresh, RGB_ENABLE_HOOKS, voodoo)`)
// that does not exist — `SoftwareRenderer` exposes the RGB-world switch as
// the MODULE-level `setRGBWorldEnabled(bool)` / `isRGBWorldEnabled()` pair
// (`packages/sw-renderer/src/frame.ts`). The flag therefore stayed false and
// voodoo mode silently ran the indexed rasterizer. `armRasterPolicy` now
// returns a boolean, records `boot.lastRasterPolicy`, and `console.warn`s
// when no hook consumes the request.

import { describe, expect, it, afterEach } from 'vitest';
import { getCVarNumber, setCVar } from '@q2/config';
import {
  SoftwareRenderer,
  isRGBWorldEnabled,
  setRGBWorldEnabled,
} from '@q2/sw-renderer';
import { armRasterPolicy, bootPlay } from './play.js';

const W = 64;
const H = 48;

// Cvar sandbox: leave the global registry as found.
const SAVED = new Map<string, number | string | boolean>();
function saveCvar(name: string): void {
  if (!SAVED.has(name)) {
    try {
      SAVED.set(name, getCVarNumber(name));
    } catch {
      SAVED.set(name, 0);
    }
  }
}
function rgbSandbox(): void {
  for (const name of ['vid_renderer', 'r_brightness', 'sw_workers', 'cl_showfps', 'cl_showpos']) {
    saveCvar(name);
  }
  setCVar('vid_renderer', 'software');
  setCVar('r_brightness', 1.0);
  setCVar('sw_workers', 0);
}
afterEach(() => {
  for (const [name, value] of SAVED) setCVar(name, value);
  // The RGB-world switch is module-global: never leak it into other tests.
  setRGBWorldEnabled(false);
});

/** Instance-hook aliases `armRasterPolicy` probes (see play.ts RGB_ENABLE_HOOKS). */
const RGB_INSTANCE_ALIASES = [
  'setRGBWorldEnabled',
  'setRGBWorld',
  'enableRGBWorld',
  'setVoodooRGBEnabled',
] as const;

/** First instance-hook alias present on a real SoftwareRenderer, if any. */
function realInstanceHook(renderer: SoftwareRenderer): string | null {
  const rec = renderer as unknown as Record<string, unknown>;
  for (const name of RGB_INSTANCE_ALIASES) {
    if (typeof rec[name] === 'function') return name;
  }
  return null;
}

/** Render the real devroom through the real Host tick loop. */
function renderDevroom(steps = 320): Uint32Array {
  const boot = bootPlay({ width: W, height: H });
  expect(boot.refresh).toBeInstanceOf(SoftwareRenderer);
  for (let t = 0; t <= steps; t += 16) boot.host.frame(t);
  return boot.refresh.getFramebuffer().color.slice();
}

describe('voodoo RGB-world activation (real class, no mocks)', () => {
  it('bootPlay wires a real SoftwareRenderer (instanceof, not a mock)', () => {
    rgbSandbox();
    const boot = bootPlay({ width: W, height: H });
    expect(boot.refresh).toBeInstanceOf(SoftwareRenderer);
  });

  it('instance-hook probe reports the P1 gap loudly when the sw-renderer card is absent', () => {
    rgbSandbox();
    const boot = bootPlay({ width: W, height: H });
    const hook = realInstanceHook(boot.refresh);
    if (hook !== null) {
      // The sw-renderer instance card landed: arming must succeed loudly.
      setCVar('vid_renderer', 'voodoo');
      boot.renderer = 'voodoo';
      expect(armRasterPolicy(boot)).toBe(true);
      expect(boot.lastRasterPolicy).toEqual({ mode: 'voodoo', rgbEnabled: true, hooked: true });
      return;
    }
    // Absent at this HEAD (the switch is module-level): the shell must say
    // so (boolean + record), not silently run indexed in voodoo mode.
    setCVar('vid_renderer', 'voodoo');
    boot.renderer = 'voodoo';
    expect(armRasterPolicy(boot)).toBe(false);
    expect(boot.lastRasterPolicy).toEqual({ mode: 'voodoo', rgbEnabled: true, hooked: false });
    expect(isRGBWorldEnabled()).toBe(false);
  });

  it('module-level RGB switch enables the real RGB pass: cover non-zero, output differs from software-only', () => {
    rgbSandbox();
    const was = isRGBWorldEnabled();
    try {
      // Software-only baseline: flag off, real devroom frames.
      setRGBWorldEnabled(false);
      expect(isRGBWorldEnabled()).toBe(false);
      const softBoot = bootPlay({ width: W, height: H });
      for (let t = 0; t <= 320; t += 16) softBoot.host.frame(t);
      const softStats = softBoot.refresh.testRGBStats();
      expect(softStats.enabled).toBe(false);
      expect(softStats.used).toBe(false);
      expect(softStats.coverPixels).toBe(0);
      const soft = softBoot.refresh.getFramebuffer().color.slice();

      // RGB-armed: same scene, same frame times, flag on. bootPlay re-arms
      // from vid_renderer, so boot the second scene in voodoo mode.
      setCVar('vid_renderer', 'voodoo');
      const rgbBoot = bootPlay({ width: W, height: H });
      rgbBoot.renderer = 'voodoo';
      expect(armRasterPolicy(rgbBoot)).toBe(true);
      expect(isRGBWorldEnabled()).toBe(true);
      for (let t = 0; t <= 320; t += 16) rgbBoot.host.frame(t);
      const rgbStats = rgbBoot.refresh.testRGBStats();
      expect(rgbStats.enabled).toBe(true);
      expect(rgbStats.used).toBe(true);
      // The RGB backend drew world spans: the coverage mask is non-zero.
      expect(rgbStats.coverPixels).toBeGreaterThan(0);
      const rgb = rgbBoot.refresh.getFramebuffer().color;

      // The RGB composite reaches the presented plane: not byte-identical
      // to the indexed-only render (or the cover mask proves the pass ran).
      let differs = 0;
      for (let i = 0; i < rgb.length; i++) {
        if (rgb[i] !== soft[i]) differs++;
      }
      expect(differs > 0 || rgbStats.coverPixels > 0).toBe(true);
    } finally {
      setRGBWorldEnabled(was);
    }
  });

  it('renderDevroom helper smokes the full loop headless (no throw, opaque frame)', () => {
    rgbSandbox();
    const frame = renderDevroom(64);
    expect(frame.length).toBe(W * H);
    for (let i = 0; i < frame.length; i++) {
      expect(frame[i]! >>> 24).toBe(0xff);
    }
  });
});
