// kick-histogram harness pins (PERF-NEXT-6 Lane C, asset-free).
//
// 1. summarizeKickSizes groups per-band samples by (frame, seq, job) into
//    per-kick totals with drain order, band counts and exec maxes.
// 2. Empty kicks (every band zero spans+pixels+tris) are first-class:
//    counted plus their frame:seq:job identity recorded — not grep.
// 3. readLastKickDescs reads the newest kick's descriptor drain
//    (kickBase/kickDescs/descs) structurally; absent/malformed is null.
// 4. Browser-pool shapes (string jobs incl. 'unknown'-mapped producers)
//    flow through the same consumer vocabulary.
import { describe, expect, it } from 'vitest';
import {
  formatKickSizes,
  formatLastKickDescs,
  readKickSizes,
  readLastKickDescs,
  summarizeKickSizes,
  type KickSizeSummary,
} from './kick-histogram.js';
import type { WorkerExecSample } from './worker-timing.js';

function sample(over: Partial<WorkerExecSample> = {}): WorkerExecSample {
  return {
    frame: 0, seq: 0, job: 'rgb', worker: 0, band: 0, y0: 0, y1: 120,
    execMs: 1.5, pixels: 100, spans: 10, tris: 2, ...over,
  };
}

describe('summarizeKickSizes', () => {
  it('groups bands into per-kick totals with drain order', () => {
    const s = summarizeKickSizes([
      sample({ seq: 0, band: 0, spans: 10, pixels: 100, tris: 2, execMs: 1.5 }),
      sample({ seq: 0, band: 1, spans: 20, pixels: 200, tris: 4, execMs: 2.5 }),
      sample({ seq: 1, band: 0, spans: 5, pixels: 50, tris: 1, execMs: 0.5 }),
      sample({ seq: 1, band: 1, spans: 5, pixels: 50, tris: 1, execMs: 0.7 }),
    ]);
    expect(s.totalKicks).toBe(2);
    expect(s.emptyKicks).toBe(0);
    expect(s.kicks[0]).toMatchObject({ seq: 0, order: 0, bands: 2, spans: 30, pixels: 300, tris: 6, execMaxMs: 2.5 });
    expect(s.kicks[1]).toMatchObject({ seq: 1, order: 1, bands: 2, spans: 10, pixels: 100, tris: 2, execMaxMs: 0.7 });
    expect(s.byJob).toHaveLength(1);
    expect(s.byJob[0]).toMatchObject({ job: 'rgb', kicks: 2, emptyKicks: 0, bands: 2 });
  });
  it('flags empty kicks first-class with identity, not grep', () => {
    const s = summarizeKickSizes([
      sample({ frame: 3, seq: 7, band: 0, spans: 0, pixels: 0, tris: 0 }),
      sample({ frame: 3, seq: 7, band: 1, spans: 0, pixels: 0, tris: 0 }),
      sample({ frame: 3, seq: 8, band: 0, spans: 4, pixels: 40 }),
    ]);
    expect(s.totalKicks).toBe(2);
    expect(s.emptyKicks).toBe(1);
    expect(s.emptyKickIds).toEqual(['f3s7:rgb']);
    expect(s.kicks[0]!.empty).toBe(true);
    expect(s.kicks[1]!.empty).toBe(false);
    expect(formatKickSizes(s)).toMatch(/empty=1 \(f3s7:rgb\)/);
  });
  it('never flags resolve/scanout kicks empty (they carry no spans by construction)', () => {
    const s = summarizeKickSizes([
      sample({ job: 'indexed-resolve', spans: 0, pixels: 0, tris: 0, execMs: 0.4 }),
      sample({ job: 'scanout', spans: 0, pixels: 0, tris: 0, execMs: 5 }),
      sample({ job: 'rgb', spans: 0, pixels: 0, tris: 0, execMs: 0.01 }),
    ]);
    expect(s.totalKicks).toBe(3);
    expect(s.emptyKicks).toBe(1);
    expect(s.emptyKickIds).toEqual(['f0s0:rgb']);
    expect(s.byJob.find((g) => g.job === 'scanout')!.emptyKicks).toBe(0);
  });
  it('a kick with only pixels is not empty (alpha seed writes count)', () => {
    const s = summarizeKickSizes([sample({ spans: 0, pixels: 64, tris: 0 })]);
    expect(s.emptyKicks).toBe(0);
  });
  it('empty input summarizes to zero kicks', () => {
    const s: KickSizeSummary = summarizeKickSizes([]);
    expect(s.totalKicks).toBe(0);
    expect(s.emptyKicks).toBe(0);
    expect(formatKickSizes(s)).toBe('kicks[n=0]');
  });
});

describe('readKickSizes', () => {
  it('returns null when the producer publishes nothing (never zero)', () => {
    expect(readKickSizes({})).toBeNull();
    expect(readKickSizes({ testBandExecStats: (): null => null })).toBeNull();
    expect(readKickSizes({ testBandExecStats: (): unknown[] => [] })).toBeNull();
  });
  it('summarizes published samples through the hook', () => {
    const s = readKickSizes({
      testBandExecStats: (): unknown => [
        { frame: 0, seq: 0, job: 'scanout', worker: 0, band: 0, y0: 0, y1: 240, execMs: 2, pixels: 76800, spans: 0 },
      ],
    });
    expect(s?.totalKicks).toBe(1);
    expect(s?.byJob[0]?.job).toBe('scanout');
  });
});

describe('readLastKickDescs', () => {
  const newest = [
    { frame: 5, seq: 9, job: 'rgb', band: 0, y0: 0, y1: 120, execMs: 1, pixels: 0, spans: 0, tris: 0, descs: 0, kickBase: 41, kickDescs: 0 },
    { frame: 5, seq: 9, job: 'rgb', band: 1, y0: 120, y1: 240, execMs: 1, pixels: 0, spans: 0, tris: 0, descs: 0, kickBase: 41, kickDescs: 0 },
  ];
  it('reads the newest kick drain with the empty flag', () => {
    const k = readLastKickDescs({ lastWorkerExec: (): unknown => newest });
    expect(k).toMatchObject({ frame: 5, seq: 9, job: 'rgb', bands: 2, kickBase: 41, kickDescs: 0, empty: true });
    expect(formatLastKickDescs(k!)).toMatch(/base=41 descs=0.*EMPTY/);
  });
  it('reports a working suffix kick as non-empty with its range', () => {
    const k = readLastKickDescs({
      lastWorkerExec: (): unknown => [
        { frame: 5, seq: 8, job: 'rgb', band: 0, y0: 0, y1: 120, execMs: 2, pixels: 500, spans: 12, tris: 3, descs: 2, kickBase: 39, kickDescs: 2 },
      ],
    });
    expect(k).toMatchObject({ kickBase: 39, kickDescs: 2, empty: false });
  });
  it('nulls mixed ranges instead of laundering one', () => {
    const k = readLastKickDescs({
      lastWorkerExec: (): unknown => [
        { frame: 5, seq: 8, job: 'rgb', band: 0, y0: 0, y1: 120, execMs: 2, pixels: 1, spans: 1, descs: 1, kickBase: 39, kickDescs: 2 },
        { frame: 5, seq: 8, job: 'rgb', band: 1, y0: 120, y1: 240, execMs: 2, pixels: 1, spans: 1, descs: 1, kickBase: 40, kickDescs: 1 },
      ],
    });
    expect(k?.kickBase).toBeNull();
    expect(k?.kickDescs).toBeNull();
  });
  it('rejects absent hooks, nulls and malformed entries', () => {
    expect(readLastKickDescs({})).toBeNull();
    expect(readLastKickDescs({ lastWorkerExec: (): null => null })).toBeNull();
    expect(readLastKickDescs({ lastWorkerExec: (): unknown[] => [] })).toBeNull();
    expect(readLastKickDescs({
      lastWorkerExec: (): unknown => [{ frame: 0, seq: 0, job: 'rgb', descs: -1, kickBase: 0, kickDescs: 0, spans: 0, pixels: 0 }],
    })).toBeNull();
    expect(readLastKickDescs({
      lastWorkerExec: (): unknown => [{ frame: 0, seq: 0, job: 'rgb', descs: 1, kickBase: 0, kickDescs: 1, spans: 1, pixels: 1, tris: 'x' }],
    })).toBeNull();
  });
});
