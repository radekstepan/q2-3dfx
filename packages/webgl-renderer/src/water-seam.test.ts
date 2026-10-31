// GPU-FOLLOW-3B — water tile boundary diagnostic (fixed-time, fixed-LOD).
// Reproduces the seam class without requiring a browser: warp must be
// repeat-continuous up to the table step, and mip sampling must not depend
// on derivatives across the wrap. Fails if warp introduces a discontinuity
// larger than the table step at a tile edge.
import { describe, expect, it } from 'vitest';
import { warpPhaseFor, warpTableValue, warpUv } from './appearance.js';

describe('GPU-FOLLOW-3B water repeat diagnostic', () => {
  it('warp phase is deterministic at fixed time', () => {
    expect(warpPhaseFor(1.0)).toBe(64 & 1023);
    expect(warpPhaseFor(1.0)).toBe(warpPhaseFor(1.0));
  });

  it('adjacent texels across a 64-px tile edge warp continuously', () => {
    const t = 1.5;
    // Sample just left and right of a tile boundary (u=63.9 vs 64.1, same v).
    const [wu0, wv0] = warpUv(63.9, 10.2, t);
    const [wu1, wv1] = warpUv(64.1, 10.2, t);
    // Warp adds 1..31 texels; the delta across 0.2 texels must stay small.
    // A seam would appear as a multi-texel jump from the table index flip.
    expect(Math.abs(wu1 - wu0 - 0.2)).toBeLessThan(2.0);
    expect(Math.abs(wv1 - wv0)).toBeLessThan(2.0);
  });

  it('warp table step is bounded (no hidden discontinuity)', () => {
    let maxStep = 0;
    for (let i = 0; i < 1024; i++) {
      const a = warpTableValue(i);
      const b = warpTableValue((i + 1) % 1024);
      maxStep = Math.max(maxStep, Math.abs(b - a));
    }
    // sin step ~0.09; the wrap 1023->0 step must also stay small.
    expect(maxStep).toBeLessThan(1.0);
  });
});
