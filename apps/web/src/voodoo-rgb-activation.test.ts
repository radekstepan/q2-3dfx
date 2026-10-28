// q2ts-web RGB-world activation proof.
//
// NO MOCKS anywhere in this file: every assertion runs against the REAL
// `SoftwareRenderer` class (imported from `@q2/sw-renderer`) driving the
// REAL devroom through the REAL `Host` tick loop.
//
// Background: `apps/web/src/play.ts armRasterPolicy` probes the instance
// hook `setRGBWorldEnabled(bool)` on the renderer (with module-level
// `setRGBWorldEnabled` / `isRGBWorldEnabled` fallback pair in
// `packages/sw-renderer/src/frame.ts`). The instance method sets the shared
// module flag AND drops the renderer's RGB caches + coverage, so arming
// records `hooked: true` on `boot.lastRasterPolicy` and the RGB world pass
// runs inside the very next renderView.

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

  it('instance hook is present on the real class: arming succeeds loudly (hooked:true)', () => {
    rgbSandbox();
    const boot = bootPlay({ width: W, height: H });
    // The sw-renderer instance card landed: SoftwareRenderer.prototype
    // ships setRGBWorldEnabled (per-renderer state + cache drop). Probe
    // the REAL class — no mocks in this file, ever.
    expect(boot.refresh).toBeInstanceOf(SoftwareRenderer);
    expect(typeof boot.refresh.setRGBWorldEnabled).toBe('function');
    expect(realInstanceHook(boot.refresh)).toBe('setRGBWorldEnabled');
    setCVar('vid_renderer', 'voodoo');
    boot.renderer = 'voodoo';
    expect(armRasterPolicy(boot)).toBe(true);
    expect(boot.lastRasterPolicy).toEqual({ mode: 'voodoo', rgbEnabled: true, hooked: true });
    expect(boot.refresh.isRGBWorldEnabled()).toBe(true);
    expect(isRGBWorldEnabled()).toBe(true);
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
      // to the indexed-only render (the pass visibly changes output) and
      // the cover mask proves the pass ran.
      let differs = 0;
      for (let i = 0; i < rgb.length; i++) {
        if (rgb[i] !== soft[i]) differs++;
      }
      expect(rgbStats.coverPixels).toBeGreaterThan(0);
      expect(differs).toBeGreaterThan(0);
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
