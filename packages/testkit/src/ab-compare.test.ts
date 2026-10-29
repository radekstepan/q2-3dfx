// ab-compare harness pins (PERF-NEXT-6 Lane C, asset-free).
//
// 1. measureABPair interleaves reps (A_i, B_i per rep index) on one box and
//    reports paired deltas + medians — same build, two configs.
// 2. Settings-match verification voids incomparable legs (dimensions,
//    rep-0 camera, scanout shape) — a void pair is never a result.
// 3. Output parity is reported, not gated: identical workloads must stay
//    bit-identical; different workloads may differ legitimately.
// 4. Execution proof rides per leg (a pooled leg that only fell back is
//    UNPROVEN, never a pass).
import { describe, expect, it } from 'vitest';
import type { Framebuffer, FrameStats, RefDef, WorldModel } from '@q2/renderer-api';
import {
  formatABEvidence,
  measureABPair,
  snapshotFidelity,
  verifyABSettings,
  type ABLeg,
} from './ab-compare.js';

function viewFor(origin: number[] = [0, 0, 0]): RefDef {
  return {
    origin: new Float32Array(origin),
    angles: new Float32Array([0, 90, 0]),
    fovX: 90,
    time: 1.5,
    lightStyles: new Float32Array(256).fill(1),
  };
}

/** Stub production renderer: deterministic planes filled from a seed. */
function stubRenderer(seed: number, W: number, H: number): ABLeg['renderer'] {
  const color = new Uint32Array(W * H).fill(seed);
  const index = new Uint8Array(W * H).fill(seed & 0xff);
  const fb: Framebuffer = { width: W, height: H, color, index, depth: new Float32Array(W * H) };
  return {
    beginFrame(): void {},
    renderView(): FrameStats {
      return { spans: 1, pixels: W * H, overdraw: 1, ms: 0 };
    },
    endFrame(): void {},
    getFramebuffer(): Framebuffer {
      return fb;
    },
  };
}

function leg(label: string, seed: number, W = 32, H = 24, scanout: ABLeg['scanout'] = null, origin: number[] = [0, 0, 0]): ABLeg {
  return {
    label,
    renderer: stubRenderer(seed, W, H),
    world: {} as unknown as WorldModel,
    width: W,
    height: H,
    viewFor: () => viewFor(origin),
    entitiesFor: () => [],
    scanout,
  };
}

function serialScanout(W: number, H: number): ABLeg['scanout'] {
  const serial = new Uint32Array(W * H);
  return {
    pool: null,
    resolveSerialInto: (color: Uint32Array, display: Uint32Array): void => {
      display.set(color.subarray(0, display.length));
      void serial;
    },
  };
}

describe('verifyABSettings', () => {
  it('matches identical legs', () => {
    const { settingsMatch, mismatchReasons } = verifyABSettings(leg('a', 1), leg('b', 1), 3);
    expect(settingsMatch).toBe(true);
    expect(mismatchReasons).toEqual([]);
  });
  it('voids dimension, camera and rep mismatches — never the mechanism', () => {
    expect(verifyABSettings(leg('a', 1, 32, 24), leg('b', 1, 64, 48), 3).settingsMatch).toBe(false);
    expect(verifyABSettings(leg('a', 1, 32, 24, null), leg('b', 1, 64, 48, serialScanout(64, 48)), 3).settingsMatch).toBe(false);
    expect(verifyABSettings(leg('a', 1), leg('b', 1), 0).settingsMatch).toBe(false);
    const cam = verifyABSettings(leg('a', 1, 32, 24, null, [0, 0, 0]), leg('b', 1, 32, 24, null, [8, 0, 0]), 3);
    expect(cam.settingsMatch).toBe(false);
    expect(cam.mismatchReasons.join(' ')).toMatch(/camera/);
    // Pooled-vs-serial of the same workload is the experiment, not a mismatch.
    expect(verifyABSettings(
      leg('a', 1, 32, 24, serialScanout(32, 24)),
      { ...leg('b', 1, 32, 24, serialScanout(32, 24)), label: 'b-pooled' },
      3,
    ).settingsMatch).toBe(true);
  });
  it('snapshotFidelity records the live pinned profile shape', () => {
    expect(typeof snapshotFidelity()).toBe('object');
  });
});

describe('measureABPair', () => {
  it('interleaves reps and reports paired deltas with parity', () => {
    const e = measureABPair(
      leg('serial', 7, 32, 24, serialScanout(32, 24)),
      leg('serial-too', 7, 32, 24, serialScanout(32, 24)),
      { warmup: 1, reps: 3 },
    );
    expect(e.pairs).toHaveLength(3);
    expect(e.pairs.map((p) => p.rep)).toEqual([0, 1, 2]);
    expect(e.settingsMatch).toBe(true);
    expect(e.outputParity).toBe(true);
    expect(e.execProvenA).toBe(true);
    expect(e.execProvenB).toBe(true);
    expect(e.framesA).toHaveLength(3);
    expect(e.framesB).toHaveLength(3);
    expect(formatABEvidence(e)).toMatch(/settings=MATCH parity=SAME/);
  });
  it('reports (not gates) output divergence for different workloads', () => {
    const e = measureABPair(
      leg('a', 7, 32, 24, serialScanout(32, 24)),
      leg('b', 8, 32, 24, serialScanout(32, 24)),
      { warmup: 0, reps: 2 },
    );
    expect(e.settingsMatch).toBe(true);
    expect(e.outputParity).toBe(false);
    expect(formatABEvidence(e)).toMatch(/parity=DIFFER/);
  });
  it('marks pooled legs with only fallbacks UNPROVEN', () => {
    const deadPool = {
      pool: {
        flushScanout: (): boolean => false,
        scanoutPlanes: { scanDisplay: new Uint32Array(32 * 24) },
      },
      resolveSerialInto: (color: Uint32Array, display: Uint32Array): void => {
        display.set(color.subarray(0, display.length));
      },
    } as ABLeg['scanout'];
    const e = measureABPair(leg('a', 7, 32, 24, deadPool), leg('b', 7, 32, 24, deadPool), { warmup: 0, reps: 2 });
    expect(e.execProvenA).toBe(false);
    expect(e.execProvenB).toBe(false);
    expect(formatABEvidence(e)).toMatch(/UNPROVEN/);
  });
});
