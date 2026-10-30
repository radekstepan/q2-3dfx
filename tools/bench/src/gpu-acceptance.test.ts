// q2-bench GPU-FOLLOW-1 acceptance predicate tests (pure/hermetic: no pak,
// no workers, no wall-clock budgets — predicates only, never thresholds).
import { describe, expect, it } from 'vitest';
import {
  GPU_FIDELITY_EDGE_EXCLUDE_PX,
  GPU_FIDELITY_MAX_ABS_DELTA_WARN,
  GPU_FIDELITY_MAX_FRACTION_DIFF,
  GPU_FIDELITY_PER_CHANNEL_LSB,
  formatGpuAcceptanceReport,
  validateDisplayedClaim,
  validateGpuFidelity,
  validateSceneCoverage,
} from './gpu-acceptance.js';

describe('fixed fidelity tolerances', () => {
  it('pins the predeclared contract values (0.02 @3LSB, 1px edge, warn>24)', () => {
    expect(GPU_FIDELITY_MAX_FRACTION_DIFF).toBe(0.02);
    expect(GPU_FIDELITY_PER_CHANNEL_LSB).toBe(3);
    expect(GPU_FIDELITY_EDGE_EXCLUDE_PX).toBe(1);
    expect(GPU_FIDELITY_MAX_ABS_DELTA_WARN).toBe(24);
  });
});

describe('validateGpuFidelity', () => {
  it('FAILS the recorded 0.912-vs-0.02 result and never reclassifies it', () => {
    const v = validateGpuFidelity({ fractionDiff: 0.912, maxAbsDelta: 255 });
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join(' ')).toMatch(/0\.912/);
    expect(v.reasons.join(' ')).toMatch(/never reclassified/);
  });
  it('PASSES a within-gate fraction and FAILS a missing number', () => {
    expect(validateGpuFidelity({ fractionDiff: 0.015, maxAbsDelta: 10 }).verdict).toBe('PASS');
    expect(validateGpuFidelity({ fractionDiff: null, maxAbsDelta: null }).verdict).toBe('FAIL');
    expect(validateGpuFidelity({ fractionDiff: 1.5, maxAbsDelta: null }).verdict).toBe('FAIL');
  });
});

describe('validateSceneCoverage', () => {
  function covered(): { framesSubmittedStart: number | null; framesSubmittedEnd: number | null; uploads: number | null; screenshotsPresent: boolean; workloads: readonly string[] } {
    return {
      framesSubmittedStart: 100,
      framesSubmittedEnd: 70000,
      uploads: 1,
      screenshotsPresent: true,
      workloads: ['stationary', 'moving', 'combat'],
    };
  }
  it('PASSES complete submission + upload + capture evidence', () => {
    expect(validateSceneCoverage(covered()).verdict).toBe('PASS');
  });
  it('rejects stalled submissions, missing uploads, missing captures, skipped workloads', () => {
    expect(validateSceneCoverage({ ...covered(), framesSubmittedEnd: 100 }).verdict).toBe('FAIL');
    expect(validateSceneCoverage({ ...covered(), uploads: 0 }).verdict).toBe('FAIL');
    expect(validateSceneCoverage({ ...covered(), screenshotsPresent: false }).verdict).toBe('FAIL');
    expect(validateSceneCoverage({ ...covered(), workloads: ['stationary'] }).verdict).toBe('FAIL');
    expect(validateSceneCoverage({ ...covered(), framesSubmittedStart: null, framesSubmittedEnd: null }).verdict).toBe('FAIL');
  });
});

describe('validateDisplayedClaim', () => {
  it('VOIDs headless-only cadence as displayed-FPS evidence (never a pass)', () => {
    const v = validateDisplayedClaim({ headless: true, vsync: false, refreshHz: 227.8, droppedFrames: 4 });
    expect(v.verdict).toBe('VOID');
    expect(v.reasons.join(' ')).toMatch(/headless/);
  });
  it('VOIDs unverified vsync / missing refresh / uncounted drops', () => {
    expect(validateDisplayedClaim({ headless: false, vsync: false, refreshHz: 60, droppedFrames: 0 }).verdict).toBe('VOID');
    expect(validateDisplayedClaim({ headless: false, vsync: true, refreshHz: null, droppedFrames: 0 }).verdict).toBe('VOID');
    expect(validateDisplayedClaim({ headless: false, vsync: true, refreshHz: 60, droppedFrames: null }).verdict).toBe('VOID');
  });
  it('PASSES a visible vsync-locked leg with recorded refresh/drops', () => {
    expect(validateDisplayedClaim({ headless: false, vsync: true, refreshHz: 60, droppedFrames: 3 }).verdict).toBe('PASS');
  });
});

describe('formatGpuAcceptanceReport', () => {
  it('separates verdicts and reports NOT ACCEPTED while fidelity fails', () => {
    const text = formatGpuAcceptanceReport({
      fidelity: { fractionDiff: 0.912, maxAbsDelta: 255 },
      coverage: {
        framesSubmittedStart: 100,
        framesSubmittedEnd: 70000,
        uploads: 1,
        screenshotsPresent: true,
        workloads: ['stationary', 'moving', 'combat'],
      },
      displayed: { headless: true, vsync: false, refreshHz: 227.8, droppedFrames: 4 },
      headroomLine: '233.76fps cadence, p50 3.92ms/p95 6.01ms (headless AMD Vega, unthrottled BeginFrames)',
    });
    expect(text).toMatch(/fidelity: FAIL/);
    expect(text).toMatch(/displayed-frame: VOID/);
    expect(text).toMatch(/NOT ACCEPTED/);
    expect(text).toMatch(/headless work headroom/);
  });
  it('reports PASS only when fidelity, coverage, and displayed all pass', () => {
    const text = formatGpuAcceptanceReport({
      fidelity: { fractionDiff: 0.015, maxAbsDelta: 10 },
      coverage: {
        framesSubmittedStart: 100,
        framesSubmittedEnd: 70000,
        uploads: 1,
        screenshotsPresent: true,
        workloads: ['stationary', 'moving', 'combat'],
      },
      displayed: { headless: false, vsync: true, refreshHz: 60, droppedFrames: 3 },
      headroomLine: null,
    });
    expect(text).toMatch(/verdict: PASS/);
  });
});
