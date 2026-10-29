// PERF-FINISH-C critical-path harness pins (bench/testkit lane, asset-free).
//
// 1. summarizeLatencies: median/p95/max over caller-clock samples (pure).
// 2. frameSplit: the per-rep scheduling gap reconciles (frame minus THAT
//    rep's segments) — never median-of-medians subtraction.
// 3. Timebase rule: KickSample.execMs stays null unless measured where the
//    work ran; message-arrival deltas must never be stored as execMs.
// 4. collectStageCounters: serial devroom RGB shows used + cover with
//    staged == kicks == 0 (execution proof reads through public hooks).
import { describe, expect, it } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import { resetCVars } from '@q2/config';
import {
  SoftwareRenderer,
  createDevroom,
  DEVROOM_CAMERA,
  setRGBWorldEnabled,
} from '@q2/sw-renderer';
import {
  bandRanges,
  collectStageCounters,
  formatBandRanges,
  formatLatency,
  frameSplit,
  summarizeBandExec,
  summarizeLatencies,
} from './critpath.js';

describe('summarizeLatencies', () => {
  it('reports median/p95/max over caller-clock samples', () => {
    const s = summarizeLatencies([5, 1, 3, 2, 4]);
    expect(s.n).toBe(5);
    expect(s.med).toBe(3);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.p95).toBe(5);
  });

  it('is empty-safe (no NaN into the ledger)', () => {
    const s = summarizeLatencies([]);
    expect(s).toEqual({ n: 0, med: 0, p95: 0, max: 0, min: 0 });
  });

  it('formats the critical-path max alongside the median', () => {
    expect(formatLatency('scanout', summarizeLatencies([1, 2, 9]))).toContain('max=9.00');
  });
});

describe('frameSplit', () => {
  it('reconciles the gap per rep (frame minus that rep segments)', () => {
    const s = frameSplit(0.1, 10, 1, 5, 17.1);
    expect(s.gapMs).toBeCloseTo(1.0, 9);
  });
});

describe('summarizeBandExec', () => {
  it('takes the critical-path max across bands when renderer counters exist', () => {
    const s = summarizeBandExec([
      { frame: 0, seq: 0, job: 'scanout', band: 0, y0: 0, y1: 60, execMs: 2, pixels: 1, spans: 1 },
      { frame: 0, seq: 0, job: 'scanout', band: 1, y0: 60, y1: 120, execMs: 7, pixels: 1, spans: 1 },
    ]);
    expect(s.n).toBe(2);
    expect(s.max).toBe(7);
  });
});

describe('bandRanges', () => {
  it('partitions the frame into stable band identities', () => {
    expect(bandRanges(240, 3)).toEqual([
      { band: 0, y0: 0, y1: 60 },
      { band: 1, y0: 60, y1: 120 },
      { band: 2, y0: 120, y1: 180 },
      { band: 3, y0: 180, y1: 240 },
    ]);
    expect(formatBandRanges(240, 3)).toBe('bands=4:[0-60,60-120,120-180,180-240]');
  });
});

describe('collectStageCounters (asset-free devroom serial RGB)', () => {
  it('reads execution proof through public hooks: used + cover, staged == kicks == 0', () => {
    resetCVars();
    const W = 160, H = 120;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(new Uint8Array(768).fill(128));
    setRGBWorldEnabled(true);
    try {
      r.beginFrame();
      r.renderView(
        {
          origin: DEVROOM_CAMERA.origin,
          angles: DEVROOM_CAMERA.angles,
          fovX: DEVROOM_CAMERA.fovX,
          time: 1.5,
          lightStyles: new Float32Array(256).fill(1),
        },
        { name: 'devroom', data: createDevroom() },
        [],
      );
      r.endFrame();
      const s = collectStageCounters(r);
      expect(s.rgbUsed).toBe(true);
      expect(s.coverPixels).toBeGreaterThan(0);
      expect(s.stagedBatches).toBe(0);
      expect(s.kicks).toBe(0);
      expect(s.pending).toBe(0);
    } finally {
      setRGBWorldEnabled(false);
      resetCVars();
    }
  });
});
