// q2-bench gpu-route lib tests (GPU-FOLLOW-2C box 5, report-only).
import { describe, expect, it } from 'vitest';
import {
  buildRouteReport,
  buildRouteSegmentReport,
  describeRouteCadenceEvidence,
  distinctRouteRegions,
  GPU_ROUTE_SCRIPT,
  parseRoutePos,
  regionCellKey,
  renderRouteTable,
  routeComparabilityNote,
  summarizeRoute,
  yawSpanDeg,
  type GpuRouteCameraSample,
  type GpuRouteReportInput,
  type GpuRouteSegmentInput,
} from './gpu-route.js';

function cam(
  over: Partial<GpuRouteCameraSample> & { pos: string | null },
  tS = 0,
): GpuRouteCameraSample {
  return {
    tS,
    yawDeg: null,
    keys: null,
    buttons: null,
    framesSubmitted: null,
    uploads: null,
    ...over,
  };
}

describe('pos parsing + region cells', () => {
  it('parses `pos x y z` and rejects garbage', () => {
    expect(parseRoutePos('pos 120.5 -340.0 24.0')).toEqual({ x: 120.5, y: -340, z: 24 });
    expect(parseRoutePos(null)).toBeNull();
    expect(parseRoutePos('')).toBeNull();
    expect(parseRoutePos('somewhere')).toBeNull();
    expect(parseRoutePos('pos 1 2')).toBeNull();
  });

  it('quantizes to room-scale cells (jitter stays, rooms change)', () => {
    expect(regionCellKey('pos 120.5 30.0 24.0')).toBe(regionCellKey('pos 121.0 31.0 24.0'));
    expect(regionCellKey('pos 120.5 30.0 24.0')).not.toBe(regionCellKey('pos 900.0 30.0 24.0'));
    expect(regionCellKey(null)).toBeNull();
    expect(regionCellKey('garbage')).toBeNull();
  });

  it('distinctRouteRegions counts first-seen cells in order', () => {
    const cells = distinctRouteRegions([
      cam({ pos: 'pos 0.0 0.0 0.0' }),
      cam({ pos: 'pos 1.0 1.0 0.0' }),
      cam({ pos: 'pos 900.0 0.0 0.0' }),
      cam({ pos: null }),
    ]);
    expect(cells).toHaveLength(2);
    expect(cells[0]).toBe('0,0,0');
  });
});

describe('yaw span', () => {
  it('accumulates unwrapped turn travel and reports ~0 when stuck', () => {
    expect(yawSpanDeg([cam({ pos: null, yawDeg: 0 }), cam({ pos: null, yawDeg: 90 }), cam({ pos: null, yawDeg: 180 })])).toBeCloseTo(180, 5);
    expect(yawSpanDeg([cam({ pos: null, yawDeg: 10 }), cam({ pos: null, yawDeg: 10.2 })])).toBeCloseTo(0.2, 5);
    expect(yawSpanDeg([])).toBeNull();
    expect(yawSpanDeg([cam({ pos: null })])).toBeNull();
  });
});

function segInput(): GpuRouteSegmentInput {
  const stamps: number[] = [0];
  for (let i = 1; i <= 60; i++) stamps.push(i * 16.7);
  return {
    segment: 'moving',
    durationS: 10,
    frameStart: 100,
    frameEnd: 700,
    frameStamps: stamps,
    cameras: [
      cam({ pos: 'pos 0.0 0.0 0.0', yawDeg: 0, keys: ['forward'], buttons: 0, framesSubmitted: 50, uploads: 12 }, 0),
      cam({ pos: 'pos 900.0 100.0 0.0', yawDeg: 95, keys: ['forward'], buttons: 0, framesSubmitted: 110, uploads: 12 }, 9),
    ],
    submittedStart: 50,
    submittedEnd: 110,
    uploadsStart: 12,
    uploadsEnd: 12,
    workLine: 'submit~1.2ms',
    screenshot: '/tmp/shot.png',
  };
}

describe('segment report', () => {
  it('carries timing + travel + submission evidence, nulls stay null', () => {
    const r = buildRouteSegmentReport(segInput());
    expect(r.segment).toBe('moving');
    expect(r.script).toBe(GPU_ROUTE_SCRIPT.moving);
    expect(r.cadenceFps).toBeCloseTo(60, 5);
    expect(r.intervals.p50Ms).toBeCloseTo(16.7, 5);
    expect(r.distinctCells).toBe(2);
    expect(r.yawSpanDeg).toBeCloseTo(95, 5);
    expect(r.submittedDelta).toBe(60);
    expect(r.uploadsLast).toBe(12);
    expect(r.screenshot).toBe('/tmp/shot.png');
  });

  it('missing submission proof stays null (never fabricated)', () => {
    const r = buildRouteSegmentReport({ ...segInput(), submittedStart: null, submittedEnd: null, uploadsEnd: null, screenshot: null });
    expect(r.submittedDelta).toBeNull();
    expect(r.uploadsLast).toBeNull();
    expect(r.screenshot).toBeNull();
  });
});

describe('route rollup + cadence wording', () => {
  it('summarizeRoute reports worst-segment medians', () => {
    const a = buildRouteSegmentReport(segInput());
    const b = buildRouteSegmentReport({ ...segInput(), segment: 'combat', frameStamps: [0, 50, 100], frameStart: 700, frameEnd: 703, durationS: 10 });
    const s = summarizeRoute([a, b], [...segInput().cameras]);
    expect(s.durationS).toBe(20);
    expect(s.p50Ms).toBeCloseTo(50, 5);
    expect(s.droppedBeats).toBeGreaterThanOrEqual(0);
  });

  it('cadence evidence never claims scanout from submissions', () => {
    const e = describeRouteCadenceEvidence({
      completedFrames: 600, durationS: 10, headless: true, vsync: false, refreshHz: 60, framesSubmittedDelta: 600,
    });
    expect(e).toMatch(/completed:/i);
    expect(e).toMatch(/submission proof ONLY, never scanout/i);
    expect(e).toMatch(/displayed\/scanout evidence: NONE/i);
    const missing = describeRouteCadenceEvidence({
      completedFrames: null, durationS: 10, headless: true, vsync: null, refreshHz: null, framesSubmittedDelta: null,
    });
    expect(missing).toMatch(/unmeasurable/);
    expect(missing).toMatch(/unobserved/);
  });

  it('comparability labels unmatched legs non-comparative', () => {
    expect(routeComparabilityNote([{ renderer: 'webgl2-experimental', glRenderer: 'ANGLE (AMD)', headless: true }]))
      .toMatch(/no cross-leg comparison/i);
    expect(routeComparabilityNote([
      { renderer: 'software', glRenderer: 'SwiftShader', headless: true },
      { renderer: 'webgl2-experimental', glRenderer: 'ANGLE (AMD)', headless: true },
    ])).toMatch(/NON-COMPARATIVE/);
    expect(routeComparabilityNote([
      { renderer: 'webgl2-experimental', glRenderer: 'ANGLE (AMD)', headless: true },
      { renderer: 'webgl2-experimental', glRenderer: 'ANGLE (AMD)', headless: true },
    ])).toMatch(/comparable side-by-side/);
  });
});

describe('route report assembly', () => {
  function input(): GpuRouteReportInput {
    const r = buildRouteSegmentReport(segInput());
    const combat = buildRouteSegmentReport({ ...segInput(), segment: 'combat' });
    const stationary = buildRouteSegmentReport({
      ...segInput(), segment: 'stationary', submittedStart: 10, submittedEnd: 40,
    });
    return {
      renderer: 'webgl2-experimental',
      glRenderer: 'ANGLE (AMD)',
      headless: true,
      vsync: false,
      refreshHz: 60,
      chromiumFlags: ['--use-angle=gl-egl'],
      cvarsRequested: 'vd_gamma:1.3',
      warmupS: 5,
      attackMethod: 'key-Mouse0',
      movementEchoOk: true,
      segments: [stationary, r, combat],
      camerasInOrder: [...segInput().cameras],
      wallDurationS: null,
      dateIso: '2026-10-29T00:00:00.000Z',
      commitShort: 'abc1234',
      commitFull: 'abc1234full',
    };
  }

  it('computes coverage + displayed verdicts (headless displayed is VOID)', () => {
    const rep = buildRouteReport(input());
    expect(rep.kind).toBe('gpu-route-timings');
    expect(rep.coverage.verdict).toBe('PASS');
    expect(rep.displayed.verdict).toBe('VOID');
    expect(rep.acceptanceReport).toMatch(/NOT ACCEPTED/);
    expect(rep.cadenceEvidence).toMatch(/never scanout/);
  });

  it('renders the per-segment table', () => {
    const rep = buildRouteReport(input());
    const t = renderRouteTable(rep.segments);
    expect(t).toContain('| stationary |');
    expect(t).toContain('| moving |');
    expect(t).toContain('| combat |');
  });

  it('wall-clock duration is the honest cadence denominator; cells dedupe revisits', () => {
    const a = buildRouteSegmentReport({ ...segInput(), segment: 'stationary', frameStart: 0, frameEnd: 600, durationS: 10 });
    const b = buildRouteSegmentReport({ ...segInput(), segment: 'moving', frameStart: 620, frameEnd: 1220, durationS: 10 });
    const summed = summarizeRoute([a, b], [...segInput().cameras, ...segInput().cameras]);
    // Same polls twice = revisits: distinct cells stay 2, not 2+2.
    expect(summed.distinctCells).toBe(2);
    expect(summed.cadenceFps).toBeCloseTo((1220 - 0) / 20, 5);
    const walled = summarizeRoute([a, b], [...segInput().cameras], 25);
    expect(walled.durationS).toBe(25);
    expect(walled.cadenceFps).toBeCloseTo(1220 / 25, 5);
  });
});
