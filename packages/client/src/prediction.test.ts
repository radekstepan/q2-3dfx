import { describe, expect, it } from 'vitest';
import {
  CL_Interpolate,
  CL_Predict,
  extrapolateOrigin,
  interpFraction,
  lerpOrigin,
  Predictor,
} from './prediction.js';
import type { Snapshot } from './prediction.js';

const snap = (t: number, x: number): Snapshot => ({
  serverTime: t,
  entities: [{ id: 1, origin: [x, 0, 0], velocity: [10, 0, 0] }],
});

describe('interp math (10Hz samples -> smooth render origins)', () => {
  it('midpoints lerp exactly', () => {
    expect(lerpOrigin([0, 0, 0], [10, 0, 0], 0.5)).toEqual([5, 0, 0]);
  });

  it('fraction clamps outside the window (hold nearest, no jitter)', () => {
    expect(interpFraction(0, 0.1, -1)).toBe(0);
    expect(interpFraction(0, 0.1, 99)).toBe(1);
    expect(interpFraction(0.1, 0.1, 0.1)).toBe(0);
  });

  it('CL_Interpolate lerps entities present in both snapshots', () => {
    const out = CL_Interpolate(snap(0, 0), snap(0.1, 10), 0.05);
    expect(out).toHaveLength(1);
    expect(out[0]!.origin[0]).toBeCloseTo(5, 9);
  });

  it('CL_Interpolate holds entities missing from one side', () => {
    const prev: Snapshot = { serverTime: 0, entities: [{ id: 7, origin: [3, 0, 0], velocity: [0, 0, 0] }] };
    const next: Snapshot = { serverTime: 0.1, entities: [] };
    expect(CL_Interpolate(prev, next, 0.05)[0]!.origin).toEqual([3, 0, 0]);
    const back = CL_Interpolate(next, prev, 0.05);
    expect(back[0]!.origin).toEqual([3, 0, 0]);
  });

  it('CL_Predict extrapolates the local player forward', () => {
    const predicted = CL_Predict(snap(1.0, 100), 1, 0.05);
    expect(predicted![0]).toBeCloseTo(100.5, 9);
  });

  it('CL_Predict returns null for unknown ids', () => {
    expect(CL_Predict(snap(1.0, 0), 999, 0.05)).toBeNull();
  });

  it('extrapolateOrigin integrates velocity', () => {
    expect(extrapolateOrigin([1, 2, 3], [10, 0, -5], 0.1)).toEqual([2, 2, 2.5]);
  });

  it('Predictor renders lerped remotes + predicted local without jitter', () => {
    const p = new Predictor();
    p.pushSnapshot(snap(0, 0));
    p.pushSnapshot(snap(0.1, 10));
    // Server time at newest + half tick; interp delay 0.1 -> renderTime 0.05.
    const ents = p.renderEntities(0.1, 1);
    expect(ents).toHaveLength(1);
    // Local player is predicted from newest (dt=0 -> newest origin).
    expect(ents[0]!.origin[0]).toBeCloseTo(10, 9);
    // A remote entity would sit at the lerp midpoint instead:
    const remote = CL_Interpolate(snap(0, 0), snap(0.1, 10), 0.05);
    expect(remote[0]!.origin[0]).toBeCloseTo(5, 9);
  });

  it('Predictor ignores out-of-order snapshots', () => {
    const p = new Predictor();
    p.pushSnapshot(snap(0.1, 10));
    p.pushSnapshot(snap(0, 0));
    expect(p.next!.serverTime).toBe(0.1);
  });
});
