// Pure render-math tests for the rotating-door graft (apps/web play.ts):
// rotateDoorVert must be the identity at rest and rotate baked verts about
// the door pivot by Quake delta angles. No pak needed (no boot).

import { describe, expect, it } from 'vitest';
import { v3 } from '@q2/math';
import { rotateDoorVert } from './play.js';

describe('rotateDoorVert (func_door_rotating render graft)', () => {
  it('is the identity for a closed door', () => {
    const out = rotateDoorVert(v3(37, -41, 12), v3(0, 0, 0), v3(0, 0, 0));
    expect(out[0]!).toBeCloseTo(37, 12);
    expect(out[1]!).toBeCloseTo(-41, 12);
    expect(out[2]!).toBeCloseTo(12, 12);
  });

  it('swings +X to +Y under +90 yaw about the pivot', () => {
    const pivot = v3(10, 20, 30);
    const out = rotateDoorVert(v3(11, 20, 30), pivot, v3(0, 90, 0));
    expect(out[0]!).toBeCloseTo(10, 9);
    expect(out[1]!).toBeCloseTo(21, 9);
    expect(out[2]!).toBeCloseTo(30, 9);
    // +Y (left) swings to -X, same rotation.
    const out2 = rotateDoorVert(v3(10, 21, 30), pivot, v3(0, 90, 0));
    expect(out2[0]!).toBeCloseTo(9, 9);
    expect(out2[1]!).toBeCloseTo(20, 9);
    expect(out2[2]!).toBeCloseTo(30, 9);
  });

  it('pitches +X down under +90 pitch', () => {
    const out = rotateDoorVert(v3(1, 0, 0), v3(0, 0, 0), v3(90, 0, 0));
    expect(out[0]!).toBeCloseTo(0, 9);
    expect(out[1]!).toBeCloseTo(0, 9);
    expect(out[2]!).toBeCloseTo(-1, 9);
  });

  it('leaves the pivot fixed for any swing', () => {
    const pivot = v3(-7, 3, 100);
    const out = rotateDoorVert(pivot, pivot, v3(12, 200, -45));
    expect(out[0]!).toBeCloseTo(-7, 9);
    expect(out[1]!).toBeCloseTo(3, 9);
    expect(out[2]!).toBeCloseTo(100, 9);
  });

  it('round-trips +90 then -90 yaw', () => {
    const pivot = v3(4, 5, 6);
    const base = v3(9, -2, 44);
    const mid = rotateDoorVert(base, pivot, v3(0, 90, 0));
    const back = rotateDoorVert(mid, pivot, v3(0, -90, 0));
    expect(back[0]!).toBeCloseTo(base[0]!, 9);
    expect(back[1]!).toBeCloseTo(base[1]!, 9);
    expect(back[2]!).toBeCloseTo(base[2]!, 9);
  });
});
