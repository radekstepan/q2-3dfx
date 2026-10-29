// PERF-FINISH-A item A: authoritative RGB skip (sw_rgb_skip_classic,
// default ON).
//
// - Default state is on (skipClassicRequested() true with fresh cvars).
// - Cvar 0 is the classic oracle: RGB output identical to the old
//   always-classic path (existing RGB pins prove it).
// - Flag OFF (oracle) with RGB OFF leaves the software index plane
//   untouched (existing goldens prove it).
// - Flag ON (default) with RGB ON completes with coverage, eliminates
//   classic work (counters > 0), and leaves software mode alone.
// - Software (RGB off) never skips: counters stay zero with the flag on.
import { afterEach, describe, expect, it } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import {
  SoftwareRenderer, setRGBWorldEnabled,
  SW_RGB_SKIP_CLASSIC_CVAR, skipClassicRequested,
} from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';

afterEach(() => {
  setRGBWorldEnabled(false);
  resetCVars();
});

function testPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = (i * 5) & 255;
    pal[i * 3 + 1] = (i * 3 + 40) & 255;
    pal[i * 3 + 2] = (i * 2 + 80) & 255;
  }
  return pal;
}

function renderDevroom(W: number, H: number): {
  idxHash: string; cover: number; used: boolean;
  classicSpansSkipped: number; classicFgSkipped: number; skipArmed: boolean;
} {
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(testPalette());
  r.beginFrame();
  r.renderView(
    {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
    },
    { name: 'devroom', data: createDevroom() },
    [],
  );
  r.endFrame();
  const idx = r.getFramebuffer().index!;
  let h = 2166136261;
  for (let i = 0; i < idx.length; i++) {
    h ^= idx[i]!;
    h = Math.imul(h, 16777619);
  }
  const st = r.testRGBStats();
  const sk = r.testClassicSkipStats();
  return {
    idxHash: (h >>> 0).toString(16).padStart(8, '0'),
    cover: st.coverPixels, used: st.used,
    classicSpansSkipped: sk.classicSpansSkipped,
    classicFgSkipped: sk.classicFgSkipped,
    skipArmed: sk.skipArmed,
  };
}

describe('PERF-FINISH-A authoritative classic skip', () => {
  it('defaults to on', () => {
    resetCVars();
    expect(skipClassicRequested()).toBe(true);
  });

  it('flag OFF (oracle) with RGB OFF leaves the software index plane untouched', () => {
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 0);
    expect(skipClassicRequested()).toBe(false);
    const off = renderDevroom(160, 120);
    expect(off.classicSpansSkipped).toBe(0);
    expect(off.classicFgSkipped).toBe(0);
    expect(off.skipArmed).toBe(false);
    expect(off.used).toBe(false);
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
    expect(skipClassicRequested()).toBe(true);
    const on = renderDevroom(160, 120);
    // Software mode never arms the skip: identical planes, zero counters.
    expect(on.idxHash).toBe(off.idxHash);
    expect(on.classicSpansSkipped).toBe(0);
    expect(on.classicFgSkipped).toBe(0);
    expect(on.used).toBe(false);
  });

  it('default ON with RGB ON completes with coverage and eliminates classic work', () => {
    setRGBWorldEnabled(true);
    const on = renderDevroom(160, 120);
    expect(skipClassicRequested()).toBe(true);
    expect(on.used).toBe(true);
    expect(on.cover).toBeGreaterThan(0);
    expect(on.skipArmed).toBe(true);
    // Devroom draws world spans + world-placed alias critters: both the
    // world-span and foreground-draw counters must prove eliminated work.
    expect(on.classicSpansSkipped).toBeGreaterThan(0);
    expect(on.classicFgSkipped).toBeGreaterThan(0);
  });

  it('oracle (cvar 0) with RGB ON draws everything classically (counters zero)', () => {
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 0);
    setRGBWorldEnabled(true);
    const oracle = renderDevroom(160, 120);
    expect(oracle.used).toBe(true);
    expect(oracle.cover).toBeGreaterThan(0);
    expect(oracle.classicSpansSkipped).toBe(0);
    expect(oracle.classicFgSkipped).toBe(0);
    expect(oracle.skipArmed).toBe(false);
  });
});
