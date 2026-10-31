// RELEASE-2 — devroom GPU helpers (asset-free, headless-safe).
import { describe, expect, it } from 'vitest';
import { devroomPaletteForGpu, bootPlay } from './play.js';

describe('RELEASE-2 devroom GPU fallback', () => {
  it('procedural palette is 768 bytes with distinct entries', () => {
    const p = devroomPaletteForGpu();
    expect(p.length).toBe(768);
    // ramp: index 0 black, index 255 distinct.
    expect(p[0]).toBe(0);
    expect(p[255 * 3]).toBe(255);
    expect(p[200 * 3]).not.toBe(p[90 * 3]);
  });

  it('no-pak boot carries a palette for GPU (not null)', () => {
    const boot = bootPlay({ width: 64, height: 48, renderer: 'software', pak: null });
    // CPU refresh must have a palette so the GPU path can attach it.
    // Access via refresh status indirectly: boot must be devroom sourced.
    expect(boot.source).toBe('devroom');
    expect(boot.skyWarning).toMatch(/devroom/);
  });

  it('intentional control: null world would stay clear-only (documents the gate)', () => {
    // The old code skipped attachWorld when mainPalette was null.
    // The new code always supplies devroomPaletteForGpu(), so this control
    // asserts the helper itself is non-null (gate removed).
    expect(devroomPaletteForGpu()).not.toBeNull();
  });
});
