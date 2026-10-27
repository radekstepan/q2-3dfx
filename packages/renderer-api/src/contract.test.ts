// @q2/renderer-api contract test: Entity RF_FRAMELERP/alpha evolution.
// The §6 Entity contract grew three ADDITIVE optional fields (oldframe,
// backlerp, alpha). Old literals without them must still compile and mean
// opaque + unlerped; new literals must round-trip through the type.
import { describe, expect, it } from 'vitest';
import type { Entity } from './index.js';

describe('Entity contract (frozen + additive evolution)', () => {
  it('legacy literals without the new fields still typecheck (opaque, unlerped)', () => {
    const e: Entity = {
      model: 0,
      origin: new Float32Array([0, 0, 0]) as Entity['origin'],
      angles: new Float32Array([0, 0, 0]) as Entity['angles'],
      frame: 3,
      skin: 0,
    };
    expect(e.oldframe).toBeUndefined();
    expect(e.backlerp).toBeUndefined();
    expect(e.alpha).toBeUndefined();
    expect(e.depthHack).toBeUndefined();
  });

  it('new optional fields round-trip (explosion smoothing contract)', () => {
    const e: Entity = {
      model: 1,
      origin: new Float32Array([1, 2, 3]) as Entity['origin'],
      angles: new Float32Array([0, 90, 0]) as Entity['angles'],
      frame: 5,
      skin: 2,
      oldframe: 4,
      backlerp: 0.5,
      alpha: 0.75,
      depthHack: true,
    };
    expect(e.oldframe).toBe(4);
    expect(e.backlerp).toBe(0.5);
    expect(e.alpha).toBe(0.75);
  });
});
