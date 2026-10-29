// q2-bench GPU-PROOF-1 lane tests (pure/hermetic: no pak, no workers,
// no wall-clock budgets — timing gates live in bench:accept, never vitest).
import { describe, expect, it } from 'vitest';
import {
  GPU_PROOF_FIDELITY_KEYS,
  GPU_PROOF_FRAMES,
  GPU_PROOF_GATE,
  GPU_PROOF_HEIGHT,
  GPU_PROOF_PERF_FRAMES,
  GPU_PROOF_PERF_YAW_STEP_DEG,
  GPU_PROOF_RESOLUTION,
  GPU_PROOF_SW_KEYS,
  GPU_PROOF_VD_KEYS,
  GPU_PROOF_WIDTH,
  formatGpuProofGateReport,
  summarizeGpuProofNode,
  validateGpuProofBrowserRecord,
  type GpuProofBrowserRecord,
} from './gpu-proof.js';
import type { AttrLike } from './evidence.js';

function validRecord(): GpuProofBrowserRecord {
  return {
    schemaVersion: 1,
    commitShort: 'abc1234',
    commitFull: null,
    date: new Date().toISOString(),
    browser: { name: 'Chromium', version: '131.0.6778.0', headless: false },
    compositor: 'hardware',
    compositorDetail: 'ANGLE (NVIDIA GeForce, Direct3D11)',
    hardwareBacked: true,
    page: 'http://localhost:5173/?map=base1&renderer=webgl2',
    resolution: '640x480',
    width: 640,
    height: 480,
    renderer: 'webgl2-experimental',
    workers: [7],
    durationS: 300,
    samples: 18000,
    presentedFpsMedian: 60,
    frameP50Ms: 16.6,
    frameP95Ms: 17.1,
    frameMaxMs: 19.4,
    workloads: ['stationary', 'moving', 'combat'],
    notes: 'hardware-backed proof leg',
    rawFile: null,
    refreshHz: 60,
    vsync: true,
    droppedFrames: 3,
    cpuFallback: false,
  };
}

describe('GPU_PROOF_GATE', () => {
  it('predeclares the box-6 thresholds (16ms / 59fps / 20ms, hardware required)', () => {
    expect(GPU_PROOF_GATE.medianFrameMsMax).toBe(16);
    expect(GPU_PROOF_GATE.minFps).toBe(59);
    expect(GPU_PROOF_GATE.p95FrameIntervalMsMax).toBe(20);
    expect(GPU_PROOF_GATE.resolution).toBe('640x480');
    expect(GPU_PROOF_GATE.hardwareBackedRequired).toBe(true);
  });
  it('pins 640x480 resolution and the fidelity key lists', () => {
    expect(GPU_PROOF_WIDTH).toBe(640);
    expect(GPU_PROOF_HEIGHT).toBe(480);
    expect(GPU_PROOF_RESOLUTION).toBe('640x480');
    expect([...GPU_PROOF_VD_KEYS]).toEqual([
      'vd_gamma', 'vd_lodbias', 'vd_dither', 'vd_postfilter', 'vd_fog',
      'vd_16bit', 'vd_bilinear', 'vd_mipdither', 'vd_overbright', 'vd_palettetex',
      'vd_maxtexsize', 'vd_zbits', 'vd_dithermode', 'vd_reconmode', 'vd_rgbmaxdelta',
    ]);
    expect([...GPU_PROOF_SW_KEYS]).toEqual(['sw_workers', 'sw_accum']);
    expect([...GPU_PROOF_FIDELITY_KEYS]).toEqual([...GPU_PROOF_VD_KEYS, ...GPU_PROOF_SW_KEYS]);
  });
  it('duplicates the 3-frame proof route + 60-frame perf route by value', () => {
    expect(GPU_PROOF_FRAMES).toEqual([
      { index: 0, label: 'stationary', yawOffsetDeg: 0, combat: false },
      { index: 1, label: 'combat', yawOffsetDeg: 0, combat: true },
      { index: 2, label: 'moving-combat', yawOffsetDeg: 6, combat: true },
    ]);
    expect(GPU_PROOF_PERF_FRAMES).toBe(60);
    expect(GPU_PROOF_PERF_YAW_STEP_DEG).toBe(1);
  });
});

describe('validateGpuProofBrowserRecord', () => {
  it('accepts a well-formed hardware-backed record', () => {
    expect(validateGpuProofBrowserRecord(validRecord())).toEqual({ ok: true, errors: [] });
  });
  it('rejects swiftshader/software/unknown compositors explicitly', () => {
    for (const compositor of ['swiftshader', 'software', 'unknown'] as const) {
      const v = validateGpuProofBrowserRecord({ ...validRecord(), compositor });
      expect(v.ok).toBe(false);
      expect(v.errors.join('\n')).toMatch(/compositor must be 'hardware'/);
    }
  });
  it('rejects hardwareBacked=false and cpuFallback=true (fallback voids the leg)', () => {
    const hw = validateGpuProofBrowserRecord({ ...validRecord(), hardwareBacked: false });
    expect(hw.ok).toBe(false);
    expect(hw.errors.join('\n')).toMatch(/hardwareBacked must be true/);
    const fb = validateGpuProofBrowserRecord({ ...validRecord(), cpuFallback: true });
    expect(fb.ok).toBe(false);
    expect(fb.errors.join('\n')).toMatch(/cpuFallback must be false/);
  });
  it('rejects wrong resolution / dimensions / renderer', () => {
    const res = validateGpuProofBrowserRecord({ ...validRecord(), resolution: '320x240', width: 320, height: 240 });
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toMatch(/640x480/);
    const rend = validateGpuProofBrowserRecord({ ...validRecord(), renderer: 'software' });
    expect(rend.ok).toBe(false);
    expect(rend.errors.join('\n')).toMatch(/webgl2-experimental/);
  });
  it('rejects missing refreshHz/vsync info with explicit errors', () => {
    const { refreshHz: _dropHz, vsync: _dropVsync, ...rest } = validRecord();
    void _dropHz;
    void _dropVsync;
    const v = validateGpuProofBrowserRecord(rest);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(/refreshHz required/);
    expect(v.errors.join('\n')).toMatch(/vsync required/);
  });
  it('rejects bad droppedFrames, missing workloads and non-objects', () => {
    expect(validateGpuProofBrowserRecord({ ...validRecord(), droppedFrames: -1 }).ok).toBe(false);
    expect(validateGpuProofBrowserRecord({ ...validRecord(), workloads: ['stationary'] }).ok).toBe(false);
    expect(validateGpuProofBrowserRecord(null).ok).toBe(false);
    expect(validateGpuProofBrowserRecord('soak').ok).toBe(false);
  });
});

describe('formatGpuProofGateReport', () => {
  it('reports PASS for a within-gate leg and FAIL when a threshold misses', () => {
    const pass = formatGpuProofGateReport(validRecord(), {
      medianFrameMs: 12.4, completedFps: 60, p95FrameIntervalMs: 17.1,
    });
    expect(pass).toMatch(/verdict: PASS/);
    const fail = formatGpuProofGateReport(validRecord(), {
      medianFrameMs: 21.5, completedFps: 60, p95FrameIntervalMs: 17.1,
    });
    expect(fail).toMatch(/verdict: FAIL/);
    expect(fail).toMatch(/median complete-frame 21.50ms/);
  });
  it('reports VOID for a CPU-fallback leg and never lets Node numbers pass', () => {
    const voided = formatGpuProofGateReport(
      { ...validRecord(), cpuFallback: true },
      { medianFrameMs: 1.0, completedFps: 1000, p95FrameIntervalMs: 1.0 },
    );
    expect(voided).toMatch(/VOID/);
    expect(voided).toMatch(/NEVER satisfy/);
  });
});

describe('summarizeGpuProofNode', () => {
  function row(res: string, mode: string, entities: string, workers: number, frameMs: number | null): AttrLike {
    return { scene: 'spawn-north', res, entities, mode, workers, frameMs };
  }
  it('picks the proof-route medians (software fixed serial, rgb fixed serial, rgb combat pooled-max)', () => {
    const rows: AttrLike[] = [
      row('640x480', 'software', 'fixed', 0, 20.48),
      row('640x480', 'rgb', 'fixed', 0, 123.59),
      row('640x480', 'rgb', 'combat', 0, 200.0),
      row('640x480', 'rgb', 'combat', 7, 50.35),
      row('320x240', 'rgb', 'combat', 7, 9.99),
    ];
    expect(summarizeGpuProofNode(rows)).toEqual({
      swFixedSerial640: 20.48,
      rgbFixedSerial640: 123.59,
      rgbCombatPooled640: 50.35,
    });
  });
  it('yields nulls when the proof rows are absent (never defaults)', () => {
    expect(summarizeGpuProofNode([])).toEqual({
      swFixedSerial640: null,
      rgbFixedSerial640: null,
      rgbCombatPooled640: null,
    });
  });
  it('accepts evidence AttrLike rows (structural compatibility)', () => {
    const erow: AttrLike = {
      scene: 'spawn-north', res: '640x480', entities: 'fixed', mode: 'software', workers: 0, frameMs: 21.49,
    };
    expect(summarizeGpuProofNode([erow]).swFixedSerial640).toBe(21.49);
  });
});
