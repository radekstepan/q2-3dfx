// q2-bench foreground reconcile unit tests (PERF-NEXT-5, bench lane).
//
// Pure/hermetic: no pak, no workers, no wall-clock budgets. Pins that the
// compare-diff execution proof honors the corrected worker/main/combined
// taxonomy: reconciling splits pass, misattributed splits and
// failure-staged-as-execution void the proof, and rows predating the split
// skip the check (never defaulted).
import { describe, expect, it } from 'vitest';
import { diffComparison, fgReconcileNote, compareWorkers, describeWorkerSweep, type CompareRun } from './compare.js';

function stationaryRow(over: object): Record<string, unknown> {
  return {
    scene: 'spawn-north', res: '640x480', entities: 'combat', mode: 'rgb', workers: 7,
    frameMs: 50, idxHash: 'a', colorHash: 'b', colorFull: 'c',
    displayFull: 'd', rgbUsed: true, rgbCover: 1, rgbStaged: 1, rgbKicks: 1,
    scanoutFallbacks: 0,
    ...over,
  };
}

function compareRun(rows: Array<Record<string, unknown>>): CompareRun {
  return {
    meta: {
      commit: 'x', node: 'v', machine: {}, load1: 0, cpus: 8, quietOk: true,
      warmup: 3, reps: 5, workers: [7], yawStepDeg: 2,
    },
    stationary: rows as unknown as CompareRun['stationary'],
    moving: [],
  };
}

describe('fgReconcileNote', () => {
  it('accepts a reconciling worker/main/combined split', () => {
    expect(fgReconcileNote({
      fgKicks: 1,
      fgWorkerSpans: 60, fgMainSpans: 40, fgCombinedSpans: 100,
      fgWorkerPixels: 600, fgMainPixels: 400, fgCombinedPixels: 1000,
      fgWorkerTris: 6, fgMainTris: 4, fgCombinedTris: 10,
    })).toBe('');
  });
  it('flags combined != worker + main', () => {
    const note = fgReconcileNote({
      fgKicks: 1,
      fgWorkerSpans: 60, fgMainSpans: 30, fgCombinedSpans: 100,
    });
    expect(note).toMatch(/FG spans 100 != worker\(60\)\+main\(30\)/);
  });
  it('flags worker-completed work on a zero-kick row', () => {
    const note = fgReconcileNote({ fgKicks: 0, fgWorkerSpans: 5, fgCombinedSpans: 5, fgMainSpans: 0 });
    expect(note).toMatch(/FG workerSpans=5 with kicks=0/);
  });
  it('skips rows predating the split (fields absent — never defaulted)', () => {
    expect(fgReconcileNote({})).toBe('');
    expect(fgReconcileNote({ fgKicks: 1 })).toBe('');
  });
  it('accepts genuine serial zeros (no kick ran, nothing completed)', () => {
    expect(fgReconcileNote({
      fgKicks: 0,
      fgWorkerSpans: 0, fgMainSpans: 0, fgCombinedSpans: 0,
      fgWorkerPixels: 0, fgMainPixels: 0, fgCombinedPixels: 0,
      fgWorkerTris: 0, fgMainTris: 0, fgCombinedTris: 0,
    })).toBe('');
  });
});

describe('diffComparison foreground execution proof', () => {  it('voids execProof on a misattributed foreground split (hashes still match)', () => {
    const base = compareRun([stationaryRow({})]);
    const head = compareRun([stationaryRow({
      fgKicks: 1,
      fgWorkerSpans: 60, fgMainSpans: 30, fgCombinedSpans: 100,
      fgWorkerPixels: 600, fgMainPixels: 300, fgCombinedPixels: 1000,
      fgWorkerTris: 6, fgMainTris: 3, fgCombinedTris: 10,
    })]);
    const { lines, settingsMatch } = diffComparison(base, head);
    expect(settingsMatch).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.parity).toBe(true);
    expect(lines[0]!.execProof).toBe(false);
    expect(lines[0]!.note).toMatch(/FG spans/);
  });
  it('keeps execProof on a reconciling split', () => {
    const base = compareRun([stationaryRow({})]);
    const head = compareRun([stationaryRow({
      fgKicks: 1,
      fgWorkerSpans: 60, fgMainSpans: 40, fgCombinedSpans: 100,
      fgWorkerPixels: 600, fgMainPixels: 400, fgCombinedPixels: 1000,
      fgWorkerTris: 6, fgMainTris: 4, fgCombinedTris: 10,
    })]);
    const { lines } = diffComparison(base, head);
    expect(lines[0]!.parity).toBe(true);
    expect(lines[0]!.execProof).toBe(true);
    expect(lines[0]!.note).toBe('');
  });
});

describe('compareWorkers sweep parsing (PERF-NEXT-6 Lane C)', () => {
  const withEnv = (v: string | undefined, fn: () => void): void => {
    const prev = process.env.COMPARE_WORKERS;
    try {
      if (v === undefined) delete process.env.COMPARE_WORKERS;
      else process.env.COMPARE_WORKERS = v;
      fn();
    } finally {
      if (prev === undefined) delete process.env.COMPARE_WORKERS;
      else process.env.COMPARE_WORKERS = prev;
    }
  };
  it('parses the full 0/1/2/3/5/6/7 lane-C sweep in order', () => {
    withEnv('0,1,2,3,5,6,7', () => {
      expect(compareWorkers()).toEqual([0, 1, 2, 3, 5, 6, 7]);
    });
  });
  it('clamps to 0..8, dedupes and preserves order', () => {
    withEnv('7,3,3,9,-1,x,1', () => {
      expect(compareWorkers()).toEqual([7, 3, 1]);
    });
  });
  it('falls back to the default sweep when unset; empty string means serial', () => {
    withEnv('', () => {
      expect(compareWorkers()).toEqual([0]);
    });
    withEnv(undefined, () => {
      expect(compareWorkers()).toEqual([0, 1, 3, 7]);
    });
  });
});

describe('describeWorkerSweep reporting', () => {
  it('names the serial path and the band tiling per count', () => {
    const lines = describeWorkerSweep([0, 1, 3], 480);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/w=0: serial/);
    expect(lines[1]).toMatch(/w=1: bands=2:\[0-240,240-480\]/);
    expect(lines[1]).toMatch(/caller owns last band/);
    expect(lines[2]).toMatch(/w=3: bands=4:/);
  });
  it('handles the full lane-C sweep without gaps', () => {
    const lines = describeWorkerSweep([0, 1, 2, 3, 5, 6, 7], 480);
    expect(lines).toHaveLength(7);
    for (const [i, w] of [0, 1, 2, 3, 5, 6, 7].entries()) {
      expect(lines[i]).toMatch(new RegExp(`w=${w}`));
    }
  });
});
