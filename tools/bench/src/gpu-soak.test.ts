// q2-bench gpu-soak lib tests (GPU-PROOF-5, measurement only).
import { describe, expect, it } from 'vitest';
import {
  buildGpuProofRecord,
  buildSoakRecord,
  cadenceFps,
  classifyCompositor,
  countDroppedBeats,
  frameIntervals,
  percentile,
  renderLegNumbersTable,
  summarizeFrameTimes,
  type GpuSoakLegInput,
} from './gpu-soak.js';

describe('percentile + frame intervals', () => {
  it('nearest-rank percentiles on a sorted series', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 0.5)).toBe(5);
    expect(percentile(s, 0.95)).toBe(10);
    expect(percentile(s, 0.99)).toBe(10);
    expect(percentile([], 0.5)).toBeNull();
  });

  it('frameIntervals diffs stamps and drops negatives', () => {
    expect(frameIntervals([0, 16.7, 33.4])).toEqual([16.7, 16.7]);
    expect(frameIntervals([100])).toEqual([]);
    expect(frameIntervals([50, 40, 60])).toEqual([20]);
  });

  it('summarizeFrameTimes covers p50/p95/p99/max/mean', () => {
    const stamps: number[] = [0];
    for (let i = 1; i <= 100; i++) stamps.push(i * 16.7);
    const s = summarizeFrameTimes(stamps);
    expect(s.frames).toBe(101);
    expect(s.p50Ms).toBeCloseTo(16.7, 5);
    expect(s.p95Ms).toBeCloseTo(16.7, 5);
    expect(s.p99Ms).toBeCloseTo(16.7, 5);
    expect(s.maxMs).toBeCloseTo(16.7, 5);
    expect(s.meanMs).toBeCloseTo(16.7, 5);
  });

  it('summarizeFrameTimes with <2 stamps returns nulls', () => {
    const s = summarizeFrameTimes([5]);
    expect(s.frames).toBe(1);
    expect(s.p50Ms).toBeNull();
    expect(s.p95Ms).toBeNull();
  });

  it('cadenceFps divides frame deltas by wall-clock', () => {
    expect(cadenceFps(0, 600, 10)).toBe(60);
    expect(cadenceFps(10, 10, 5)).toBe(0);
    expect(cadenceFps(0, 10, 0)).toBeNull();
    expect(cadenceFps(0, 10, -1)).toBeNull();
  });

  it('countDroppedBeats counts gaps >= 34ms by default', () => {
    expect(countDroppedBeats([16.7, 16.7, 50, 16.7, 100])).toBe(2);
    expect(countDroppedBeats([16.7, 33.9])).toBe(0);
    expect(countDroppedBeats([34])).toBe(1);
  });
});

describe('compositor classification', () => {
  it('classifies the verified hardware string as hardware', () => {
    const c = classifyCompositor('ANGLE (AMD, AMD Radeon Vega 11 Graphics (radeonsi raven ACO), OpenGL ES 3.2)');
    expect(c).toEqual({ compositor: 'hardware', hardwareBacked: true });
  });

  it('classifies SwiftShader as software-emulated, never a gate pass', () => {
    const c = classifyCompositor('WebGL 2.0 (OpenGL ES 3.0 Chromium)');
    expect(c.hardwareBacked).toBe(false);
    const c2 = classifyCompositor('WebGL 2.0 (OpenGL ES 3.0 Chromium, SwiftShader Something)');
    expect(c2).toEqual({ compositor: 'swiftshader', hardwareBacked: false });
  });

  it('classifies llvmpipe/software/basic-render as software', () => {
    expect(classifyCompositor('llvmpipe foo').compositor).toBe('software');
    expect(classifyCompositor(null)).toEqual({ compositor: 'unknown', hardwareBacked: false });
    expect(classifyCompositor('')).toEqual({ compositor: 'unknown', hardwareBacked: false });
  });
});

function legInput(over: Partial<GpuSoakLegInput> = {}): GpuSoakLegInput {
  return {
    commitShort: 'abc1234',
    commitFull: 'abc1234full',
    browserName: 'chromium',
    browserVersion: '156.0.8078.47',
    headless: true,
    glRenderer: 'ANGLE (AMD, AMD Radeon Vega 11 Graphics (radeonsi raven ACO), OpenGL ES 3.2)',
    renderer: 'webgl2-experimental',
    width: 640,
    height: 480,
    page: 'http://127.0.0.1:1/?q2soak=1',
    durationS: 320,
    samples: 300,
    presentedFpsMedian: 60,
    frameP50Ms: 8,
    frameP95Ms: 15,
    frameMaxMs: 30,
    workloads: ['stationary', 'moving', 'combat'],
    notes: 'test',
    workers: [7],
    dateIso: '2026-10-29T00:00:00.000Z',
    ...over,
  };
}

describe('record assembly', () => {
  it('buildSoakRecord carries classification + geometry', () => {
    const r = buildSoakRecord(legInput());
    expect(r.compositor).toBe('hardware');
    expect(r.hardwareBacked).toBe(true);
    expect(r.resolution).toBe('640x480');
    expect(r.renderer).toBe('webgl2-experimental');
  });

  it('buildGpuProofRecord passes a clean hardware leg', () => {
    const rec = buildSoakRecord(legInput());
    const out = buildGpuProofRecord(rec, { refreshHz: 60, vsync: false, droppedFrames: 3, cpuFallback: false });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.record.cpuFallback).toBe(false);
      expect(out.record.refreshHz).toBe(60);
    }
  });

  it('buildGpuProofRecord voids SwiftShader legs (never a gate pass)', () => {
    const rec = buildSoakRecord(legInput({ glRenderer: 'WebGL 2.0 (OpenGL ES 3.0 Chromium)' }));
    const out = buildGpuProofRecord(rec, { refreshHz: 60, vsync: false, droppedFrames: 0, cpuFallback: false });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join(' ')).toMatch(/hardware/i);
  });

  it('buildGpuProofRecord voids CPU fallback and missing fields', () => {
    const rec = buildSoakRecord(legInput());
    const fb = buildGpuProofRecord(rec, { refreshHz: 60, vsync: false, droppedFrames: 0, cpuFallback: true });
    expect(fb.ok).toBe(false);
    const missing = buildGpuProofRecord(rec, { refreshHz: null, vsync: false, droppedFrames: 0, cpuFallback: false });
    expect(missing.ok).toBe(false);
  });
});

describe('report table', () => {
  it('renders the per-leg numbers table', () => {
    const t = renderLegNumbersTable([{
      leg: 'gpu', renderer: 'webgl2-experimental', glRenderer: 'ANGLE (AMD)', hardwareBacked: true,
      durationS: 320, cadenceFps: 60, p50Ms: 8, p95Ms: 15, p99Ms: 18, dropped: 3, heapDeltaMB: 4.2, errors: 0,
    }]);
    expect(t).toContain('| gpu |');
    expect(t).toContain('webgl2-experimental');
  });
});
