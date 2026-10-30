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

  it('textured draws require the 36-index box; fallback legs must not draw it', () => {
    expect(skyDrawViolations(['drawElements TRIANGLES 36 @0', 'uniform1i uTextured 1'], true)).toEqual([]);
    expect(skyDrawViolations(['drawElements TRIANGLES 10 @0'], true).length).toBeGreaterThan(0);
    expect(skyDrawViolations(['drawElements TRIANGLES 36 @0'], false).length).toBeGreaterThan(0);
    expect(skyDrawViolations(['drawElements TRIANGLES 10 @0'], false)).toEqual([]);
  });
});
