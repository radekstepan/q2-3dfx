// worker-timing harness pins (bench/testkit lane, asset-free unless noted).
//
// 1. KickJournal: caller-clock dispatch-to-completion per kick with stable
//    band identity; the critical-path max is `max`.
// 2. workerBandLedger: caller owns the last band, workers the rest.
// 3. collectWorkerExec: null while the renderer publishes no in-worker
//    timestamps (current state — documented gap, not a silent zero);
//    validates shape and rejects negative/non-finite durations.
// 4. Timebase honesty: caller dispatch-to-completion and worker execution
//    stay in separate fields; execMs is present only when measured where
//    the work ran (main-thread inline drain), never a message-arrival delta.
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
  KickJournal,
  collectWorkerExec,
  workerBandLedger,
  workerExecCriticalPath,
  type WorkerExecSample,
} from './worker-timing.js';
import { nowNs, nsToMs } from './critpath.js';

describe('KickJournal', () => {
  it('summarizes dispatch-to-completion per job; the max is the critical path', () => {
    const j = new KickJournal();
    expect(j.size).toBe(0);
    expect(j.summarizeAll()).toEqual({ n: 0, med: 0, p95: 0, max: 0, min: 0 });
    j.record({ frame: 0, seq: 0, job: 'scanout', workers: 3, band: 'all', y0: 0, y1: 240, latencyMs: 2, ok: true, execMs: null, pixels: 76800, spans: 0 });
    j.record({ frame: 0, seq: 1, job: 'scanout', workers: 3, band: 'all', y0: 0, y1: 240, latencyMs: 9, ok: true, execMs: null, pixels: 76800, spans: 0 });
    j.record({ frame: 0, seq: 0, job: 'rgb', workers: 3, band: 3, y0: 180, y1: 240, latencyMs: 5, ok: true, execMs: 4.5, pixels: 19200, spans: 100 });
    expect(j.size).toBe(3);
    const scan = j.summarize('scanout');
    expect(scan.n).toBe(2);
    expect(scan.max).toBe(9);
    // Caller-fenced kicks carry no worker execution duration by default.
    expect(j.entries()[0]!.execMs).toBeNull();
    // The main-thread band drain timed around the call MAY carry one.
    expect(j.entries()[2]!.execMs).toBe(4.5);
    expect(j.summarize('rgb').max).toBe(5);
  });

  it('bandsSeen reports stable band coverage for forensics', () => {
    const j = new KickJournal();
    j.record({ frame: 0, seq: 0, job: 'scanout', workers: 1, band: 0, y0: 0, y1: 120, latencyMs: 1, ok: true, execMs: null, pixels: 1, spans: 0 });
    j.record({ frame: 0, seq: 0, job: 'scanout', workers: 1, band: 1, y0: 120, y1: 240, latencyMs: 1, ok: true, execMs: null, pixels: 1, spans: 0 });
    expect(j.bandsSeen()).toEqual([
      { band: 0, y0: 0, y1: 120 },
      { band: 1, y0: 120, y1: 240 },
    ]);
  });
});

describe('workerBandLedger', () => {
  it('assigns workers to bands and the caller to the last band', () => {
    expect(workerBandLedger(240, 3)).toEqual([
      { worker: 0, band: 0, y0: 0, y1: 60 },
      { worker: 1, band: 1, y0: 60, y1: 120 },
      { worker: 2, band: 2, y0: 120, y1: 180 },
      { worker: 'caller', band: 3, y0: 180, y1: 240 },
    ]);
  });
});

describe('collectWorkerExec (renderer in-worker timestamps)', () => {
  it('returns null while the renderer publishes nothing (documented gap)', () => {
    resetCVars();
    const fb = createFramebuffer(160, 120, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(new Uint8Array(768).fill(128));
    setRGBWorldEnabled(true);
    try {
      r.beginFrame();
      r.renderView(
        {
          origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
          fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
        },
        { name: 'devroom', data: createDevroom() },
        [],
      );
      r.endFrame();
      expect(collectWorkerExec(r)).toBeNull();
    } finally {
      setRGBWorldEnabled(false);
      resetCVars();
    }
  });

  it('rejects malformed samples instead of laundering them', () => {
    expect(collectWorkerExec(null)).toBeNull();
    expect(collectWorkerExec({})).toBeNull();
    const negative = {
      testBandExecStats: () => ([
        { frame: 0, seq: 0, job: 'rgb', worker: 0, band: 0, y0: 0, y1: 60, execMs: -1, pixels: 1, spans: 1 },
      ]),
    };
    expect(collectWorkerExec(negative)).toBeNull();
    const good: { testBandExecStats: () => WorkerExecSample[] } = {
      testBandExecStats: () => ([
        { frame: 0, seq: 0, job: 'rgb', worker: 0, band: 0, y0: 0, y1: 60, execMs: 2.5, pixels: 100, spans: 10 },
        { frame: 0, seq: 0, job: 'rgb', worker: 1, band: 1, y0: 60, y1: 120, execMs: 7.5, pixels: 100, spans: 10 },
      ]),
    };
    const samples = collectWorkerExec(good);
    expect(samples).not.toBeNull();
    // Critical-path compute max across bands, separate from any caller fence.
    expect(workerExecCriticalPath(samples!)).toMatchObject({ n: 2, max: 7.5 });
  });
});

describe('caller dispatch-to-completion on a real frame', () => {
  it('fences a production frame on one caller clock; execMs stays null', () => {
    resetCVars();
    const W = 160, H = 120;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(new Uint8Array(768).fill(128));
    setRGBWorldEnabled(true);
    try {
      const journal = new KickJournal();
      const tF = nowNs();
      r.beginFrame();
      r.renderView(
        {
          origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
          fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
        },
        { name: 'devroom', data: createDevroom() },
        [],
      );
      r.endFrame();
      const frameMs = nsToMs(nowNs() - tF);
      journal.record({
        frame: 0, seq: 0, job: 'indexed-frame', workers: 0, band: 'all',
        y0: 0, y1: H, latencyMs: frameMs, ok: true, execMs: null,
        pixels: W * H, spans: r.testTranslucentSpans(),
      });
      const s = journal.summarize('indexed-frame');
      expect(s.n).toBe(1);
      expect(s.max).toBe(frameMs);
      // The serial frame ran on the caller — but this record fenced the
      // whole frame, not one band's compute, so no per-band exec claim.
      expect(journal.entries()[0]!.execMs).toBeNull();
    } finally {
      setRGBWorldEnabled(false);
      resetCVars();
    }
  });
});
