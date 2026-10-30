// @q2/testkit — GPU-FOLLOW-3A sky validator pins (no Q2_PAK required).
import { describe, expect, it } from 'vitest';
import { skyBackendViolations, skyDrawViolations, skyStripViolations, skyTileViolations } from './gpu-sky.js';

function flatStrip(tileW = 8, tileH = 8): { texels: Uint8Array; tileW: number; tileH: number } {
  return { texels: new Uint8Array(tileW * tileH * 6).fill(3), tileW, tileH };
}

function texturedStrip(tileW = 8, tileH = 8): { texels: Uint8Array; tileW: number; tileH: number } {
  const texels = new Uint8Array(tileW * tileH * 6);
  for (let i = 0; i < texels.length; i++) texels[i] = i % 64;
  return { texels, tileW, tileH };
}

describe('gpu-sky validators', () => {
  it('rejects flat fills and accepts textured strips', () => {
    expect(skyStripViolations(flatStrip()).length).toBeGreaterThan(0);
    expect(skyStripViolations(texturedStrip())).toEqual([]);
    expect(skyTileViolations(texturedStrip(), 0)).toEqual([]);
  });

  it('backend without a strip always violates (negative control)', () => {
    const backend = { testSkyStrip: () => null, testWarnings: () => [] as string[] };
    expect(skyBackendViolations(backend, texturedStrip()).length).toBeGreaterThan(0);
  });

  it('backend dims must be per-face, not the strip total height', () => {
    const expected = texturedStrip(8, 8);
    const backend = { testSkyStrip: () => ({ tileW: 8, tileH: 48 }), testWarnings: () => [] as string[] };
    expect(skyBackendViolations(backend, expected).join('\n')).toMatch(/total-height/);
  });

  it('textured draws require six per-face 6-index boxes; fallback legs must not draw them', () => {
    const textured = [
      ...Array(6).fill('drawElements TRIANGLES 6 @0'),
      'uniform1i uTextured 1',
    ];
    expect(skyDrawViolations(textured, true)).toEqual([]);
    expect(skyDrawViolations(['drawElements TRIANGLES 36 @0', 'uniform1i uTextured 1'], true).length).toBeGreaterThan(0);
    expect(skyDrawViolations(['drawElements TRIANGLES 10 @0'], true).length).toBeGreaterThan(0);
    // A bare 6-index draw without the textured sampler is a hull
    // coincidence, not a textured box — no violation on the fallback leg.
    expect(skyDrawViolations(['drawElements TRIANGLES 6 @0'], false)).toEqual([]);
    expect(skyDrawViolations([...Array(6).fill('drawElements TRIANGLES 6 @0'), 'uniform1i uTextured 1'], false).length).toBeGreaterThan(0);
    expect(skyDrawViolations(['drawElements TRIANGLES 36 @0'], false).length).toBeGreaterThan(0);
    expect(skyDrawViolations(['drawElements TRIANGLES 10 @0'], false)).toEqual([]);
  });
});
