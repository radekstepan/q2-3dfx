// geo-attribution harness pins (PERF-NEXT-6 Lane C, asset-free).
//
// 1. readMeasuredPhases validates the producer shape structurally (finite
//    non-negative every phase; absent/malformed reads null, never zero).
// 2. geoRep reconciles per rep FIRST (geo total + gap from the same rep's
//    wall) — never across medians.
// 3. summarizeGeoReps takes medians OVER REPS of per-rep values: the GEO
//    total is the median of per-rep totals, NOT a sum of phase medians
//    (pinned to differ on skewed input).
import { describe, expect, it } from 'vitest';
import {
  collectGeoRep,
  formatGeoSummary,
  geoRep,
  readMeasuredPhases,
  summarizeGeoReps,
  type GeoPhases,
  type GeoRep,
} from './geo-attribution.js';

type Measured = GeoPhases & { draw: number; alias: number };

function measured(over: Partial<Measured> = {}): Measured {
  return {
    setup: 1, mark: 1, traverse: 1, cull: 1, cache: 1, project: 1, emit: 1, sort: 1,
    draw: 2, alias: 3, ...over,
  };
}

describe('readMeasuredPhases', () => {
  it('accepts a complete finite non-negative producer shape', () => {
    const m = readMeasuredPhases({ stats: {}, phases: measured() });
    expect(m).not.toBeNull();
    expect(m!.setup).toBe(1);
    expect(m!.draw).toBe(2);
    expect(m!.alias).toBe(3);
  });
  it('rejects absent/malformed producers as unknown (never zero)', () => {
    expect(readMeasuredPhases(null)).toBeNull();
    expect(readMeasuredPhases({})).toBeNull();
    expect(readMeasuredPhases({ phases: null })).toBeNull();
    expect(readMeasuredPhases({ phases: measured({ setup: Number.NaN }) })).toBeNull();
    expect(readMeasuredPhases({ phases: measured({ sort: -1 }) })).toBeNull();
    expect(readMeasuredPhases({ phases: measured({ draw: Infinity }) })).toBeNull();
    const full = measured();
    const partial: Record<string, unknown> = { ...full };
    delete partial.cache;
    expect(readMeasuredPhases({ phases: partial })).toBeNull();
  });
});

describe('geoRep reconciliation', () => {
  it('derives per-rep totals and gap from the same rep', () => {
    const r = geoRep(0, 20, measured());
    // 8 GEO phases x 1 + draw 2 + alias 3 = 13; wall 20 -> gap 7.
    expect(r.geoTotalMs).toBe(8);
    expect(r.gapMs).toBe(7);
    expect(r.drawMs).toBe(2);
    expect(r.aliasMs).toBe(3);
  });
  it('gap can go negative when the wall under-reads (reported, not clamped)', () => {
    const r = geoRep(0, 5, measured());
    expect(r.gapMs).toBe(5 - 13);
  });
});

describe('summarizeGeoReps', () => {
  it('reports median of per-rep totals, not sum of phase medians', () => {
    // Skewed reps: rep totals are 8, 8, 80. Median of totals = 8.
    // A sum-of-medians would report setup med (1) x 8 = 8 here too — skew
    // one phase instead: reps carry setup 1,1,73 (med 1) with the rest 1.
    const reps: GeoRep[] = [
      geoRep(0, 100, measured()),
      geoRep(1, 100, measured()),
      geoRep(2, 100, measured({ setup: 73 })),
    ];
    const s = summarizeGeoReps(reps);
    expect(s.n).toBe(3);
    expect(s.geoTotalMs).toBe(8);
    expect(s.phases.setup).toBe(1);
    expect(s.phases.mark).toBe(1);
    // Median gap over per-rep gaps (100-13, 100-13, 100-85).
    expect(s.gapMs).toBe(87);
  });
  it('empty input summarizes to n=0', () => {
    const s = summarizeGeoReps([]);
    expect(s.n).toBe(0);
    expect(formatGeoSummary(s)).toMatch(/n=0/);
  });
  it('formats one line with totals and per-phase medians', () => {
    const s = summarizeGeoReps([geoRep(0, 20, measured())]);
    expect(formatGeoSummary(s)).toBe(
      'geo[n=1 total=8.00 setup=1.00 mark=1.00 traverse=1.00 cull=1.00 ' +
      'cache=1.00 project=1.00 emit=1.00 sort=1.00 draw=2.00 alias=3.00 gap=7.00]',
    );
  });
});

describe('collectGeoRep', () => {
  it('probes testMeasurePhases structurally and reconciles the rep', () => {
    const source = {
      testMeasurePhases: (): unknown => ({ stats: {}, phases: measured() }),
    };
    const r = collectGeoRep(source, 2, {}, {}, []);
    expect(r).not.toBeNull();
    expect(r!.rep).toBe(2);
    expect(r!.geoTotalMs).toBe(8);
    expect(r!.wallMs).toBeGreaterThanOrEqual(0);
  });
  it('returns null when the hook is absent or malformed', () => {
    expect(collectGeoRep({}, 0, {}, {}, [])).toBeNull();
    expect(collectGeoRep({
      testMeasurePhases: (): unknown => ({ stats: {}, phases: { setup: 1 } }),
    }, 0, {}, {}, [])).toBeNull();
    expect(collectGeoRep({
      testMeasurePhases: (): unknown => { throw new Error('nope'); },
    }, 0, {}, {}, [])).toBeNull();
  });
});
