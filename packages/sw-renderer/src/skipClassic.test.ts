// PERF-2 B: gated classic-skip (sw_rgb_skip_classic, default OFF).
//
// - Default state is off and byte-identical (existing goldens prove it).
// - Flag ON + RGB OFF: the software path is untouched (same index hash as
//   flag OFF) — the skip only applies where an RGB material drew.
// - Flag ON + RGB ON: the frame completes with RGB coverage (smoke only —
//   output intentionally differs, so no golden pin here).
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

function renderDevroom(W: number, H: number): { idxHash: string; cover: number; used: boolean } {
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
  return { idxHash: (h >>> 0).toString(16).padStart(8, '0'), cover: st.coverPixels, used: st.used };
}

describe('PERF-2 B gated classic skip', () => {
  it('defaults to off', () => {
    resetCVars();
    expect(skipClassicRequested()).toBe(false);
  });

  it('flag ON with RGB OFF leaves the software index plane untouched', () => {
    const off = renderDevroom(160, 120);
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
    expect(skipClassicRequested()).toBe(true);
    const on = renderDevroom(160, 120);
    expect(on.idxHash).toBe(off.idxHash);
    expect(on.used).toBe(false);
  });

  it('flag ON with RGB ON still completes with coverage (smoke, no golden)', () => {
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
    setRGBWorldEnabled(true);
    const on = renderDevroom(160, 120);
    expect(on.used).toBe(true);
    expect(on.cover).toBeGreaterThan(0);
  });
});
