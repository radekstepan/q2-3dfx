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
import { createRequire } from 'node:module';
import { existsSync } from 'fs';
import { Worker } from 'node:worker_threads';
import { createFramebuffer } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import {
  BandWorkerPool,
  SoftwareRenderer,
  SW_ACCUM_CVAR,
  SW_WORKERS_CVAR,
  createDevroom,
  DEVROOM_CAMERA,
} from '@q2/sw-renderer';
import {
  KickJournal,
  collectWorkerExec,
  detailTimingEnabled,
  formatWorkerImbalance,
  readCompletionMessage,
  summarizeWorkerImbalance,
  workerBandLedger,
  workerExecCriticalPath,
  type WorkerExecSample,
} from './worker-timing.js';
import { readBandExecStats, readDiagSnapshot, readMaterialGcMs } from './renderer-hooks.js';
import { nowNs, nsToMs } from './critpath.js';

const require = createRequire(process.cwd() + '/');

/** Built @q2/sw-renderer ESM bundle (real worker bootstrap source). */
function swRendererEsmPath(): string | null {
  try {
    const cjs = require.resolve('@q2/sw-renderer');
    const esm = cjs.replace(/index\.js$/, 'index.mjs');
    return existsSync(esm) ? esm : null;
  } catch {
    return null;
  }
}

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
    resetCVars();
    expect(collectWorkerExec(r)).toBeNull();
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
    resetCVars();
  });
});

describe('detailTimingEnabled (PERF-NEXT-4 kill-switch)', () => {
  it('defaults on; Q2_DETAIL_TIMING=0 disables', () => {
    const prev = process.env['Q2_DETAIL_TIMING'];
    try {
      delete process.env['Q2_DETAIL_TIMING'];
      expect(detailTimingEnabled()).toBe(true);
      process.env['Q2_DETAIL_TIMING'] = '0';
      expect(detailTimingEnabled()).toBe(false);
      process.env['Q2_DETAIL_TIMING'] = 'off';
      expect(detailTimingEnabled()).toBe(false);
      process.env['Q2_DETAIL_TIMING'] = '1';
      expect(detailTimingEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['Q2_DETAIL_TIMING'];
      else process.env['Q2_DETAIL_TIMING'] = prev;
    }
  });
});

describe('readCompletionMessage (worker completion protocol)', () => {
  it('parses band identity + tallies; execMs null when the build omits it', () => {
    // Legacy production shape (current bandWorkerLoop postMessage).
    const legacy = readCompletionMessage({ seq: 4, band: 1, pixels: 76800, spans: 12 });
    expect(legacy).toMatchObject({ seq: 4, band: 1, pixels: 76800, spans: 12, execMs: null });
    const full = readCompletionMessage({
      seq: 4, band: 1, frame: 7, job: 'scanout', y0: 120, y1: 240,
      pixels: 76800, spans: 0, tris: 3, execMs: 2.5,
    });
    expect(full).toMatchObject({
      seq: 4, band: 1, frame: 7, job: 'scanout', y0: 120, y1: 240,
      pixels: 76800, spans: 0, tris: 3, execMs: 2.5,
    });
  });

  it('rejects malformed messages instead of laundering them', () => {
    expect(readCompletionMessage(null)).toBeNull();
    expect(readCompletionMessage({})).toBeNull();
    expect(readCompletionMessage({ seq: 0, band: 0, pixels: 1, spans: 0, execMs: -1 })).toBeNull();
    expect(readCompletionMessage({ seq: 0, band: 0, pixels: 1, spans: 0, execMs: NaN })).toBeNull();
    expect(readCompletionMessage({ seq: 0, band: 0, pixels: -1, spans: 0 })).toBeNull();
    expect(readCompletionMessage({ seq: 0, band: 0, pixels: 1, spans: 0, job: 'nope' })).toBeNull();
  });
});

describe('summarizeWorkerImbalance (PERF-NEXT-6 straggler input)', () => {
  it('reports the worst within-group max-vs-median gap with straggler identity', () => {
    const xs: WorkerExecSample[] = [
      { frame: 0, seq: 0, job: 'scanout', worker: 0, band: 0, y0: 0, y1: 80, execMs: 2, pixels: 1, spans: 0 },
      { frame: 0, seq: 0, job: 'scanout', worker: 1, band: 1, y0: 80, y1: 160, execMs: 3, pixels: 1, spans: 0 },
      { frame: 0, seq: 0, job: 'scanout', worker: 2, band: 2, y0: 160, y1: 240, execMs: 9, pixels: 1, spans: 0 },
      { frame: 0, seq: 1, job: 'scanout', worker: 0, band: 0, y0: 0, y1: 80, execMs: 3, pixels: 1, spans: 0 },
      { frame: 0, seq: 1, job: 'scanout', worker: 1, band: 1, y0: 80, y1: 160, execMs: 3, pixels: 1, spans: 0 },
      { frame: 0, seq: 1, job: 'scanout', worker: 2, band: 2, y0: 160, y1: 240, execMs: 4, pixels: 1, spans: 0 },
    ];
    const w = summarizeWorkerImbalance(xs);
    expect(w.groups).toBe(2);
    expect(w.bands).toBe(6);
    expect(w.critPathMax).toBe(9);
    // Worst group (seq 0): sorted [2,3,9], med 3, max 9 — the gap is
    // within-group, never a sum of medians.
    expect(w.imbalanceMs).toBe(9 - 3);
    expect(w.imbalanceRatio).toBeCloseTo(9 / 3, 10);
    expect(w.straggler).toMatchObject({ frame: 0, seq: 0, job: 'scanout', band: 2, execMs: 9 });
    expect(formatWorkerImbalance(w)).toContain('straggler=band2(scanout f0s0 9.00ms)');
    expect(formatWorkerImbalance(w)).toContain('gap=6.00');
  });

  it('is empty-clean with no samples', () => {
    const w = summarizeWorkerImbalance([]);
    expect(w).toMatchObject({ groups: 0, bands: 0, straggler: null });
    expect(formatWorkerImbalance(w)).toContain('producer unpublished');
  });
});

describe('real built Node worker (PERF-NEXT-4 integration)', () => {
  it('executes a real indexed resolve band in a real worker thread with measured execMs + identity', async () => {
    const esm = swRendererEsmPath();
    if (!esm) {
      console.log('SKIP real-worker exec: sw-renderer dist not built (run yarn build first)');
      return;
    }
    const W = 320, H = 240, y0 = 120, y1 = 240;
    const frame = 7, seq = 3, band = 1;
    // The worker imports the REAL built bundle and runs the REAL indexed
    // resolve band kernel (palette expand over a real index plane),
    // timing the job where it runs. No synthetic durations: execMs is an
    // hrtime delta around actual work.
    const src = `
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.esm).then((m) => {
        const W = workerData.W, H = workerData.H;
        const idx = new Uint8Array(W * H);
        for (let i = 0; i < idx.length; i++) idx[i] = (i * 7 + (i >> 8)) & 255;
        const pal = new Uint8Array(768);
        for (let i = 0; i < 256; i++) {
          pal[i * 3] = (i * 5) & 255; pal[i * 3 + 1] = (i * 3 + 40) & 255; pal[i * 3 + 2] = (i * 2 + 80) & 255;
        }
        const color = new Uint32Array(W * H);
        m.resolveBand(color, pal, idx, workerData.y0, workerData.y1, W, H);
        const t0 = process.hrtime.bigint();
        m.resolveBand(color, pal, idx, workerData.y0, workerData.y1, W, H);
        const execMs = Number(process.hrtime.bigint() - t0) / 1e6;
        let h = 2166136261;
        for (let i = 0; i < color.length; i++) {
          const px = color[i];
          h ^= px & 255; h = Math.imul(h, 16777619);
          h ^= (px >>> 8) & 255; h = Math.imul(h, 16777619);
          h ^= (px >>> 16) & 255; h = Math.imul(h, 16777619);
          h ^= (px >>> 24) & 255; h = Math.imul(h, 16777619);
        }
        parentPort.postMessage({
          seq: workerData.seq, band: workerData.band, frame: workerData.frame,
          job: 'resolve', y0: workerData.y0, y1: workerData.y1,
          pixels: W * (workerData.y1 - workerData.y0), spans: 0, execMs,
          hash: (h >>> 0).toString(16).padStart(8, '0'),
        });
      }).catch((e) => { parentPort.postMessage({ error: String((e && e.stack) || e) }); });
    `;
    const worker = new Worker(src, {
      eval: true,
      workerData: { esm, W, H, y0, y1, frame, seq, band },
    });
    try {
      const msg = await new Promise<unknown>((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('real worker timed out')), 30000);
        worker.once('message', (m: unknown) => { clearTimeout(to); resolve(m); });
        worker.once('error', (e: unknown) => { clearTimeout(to); reject(e); });
      });
      const rec = msg as Record<string, unknown>;
      if (typeof rec['error'] === 'string') throw new Error(`real worker failed: ${rec['error']}`);
      // Correct identity: the exact frame/seq/job/band the kick dispatched.
      const c = readCompletionMessage(msg);
      expect(c).not.toBeNull();
      expect(c).toMatchObject({ seq, band, frame, job: 'indexed-resolve', y0, y1, pixels: W * (y1 - y0), spans: 0 });
      // Finite measured duration for the executed job — not null, not
      // synthetic: an hrtime delta around the real kernel in the worker.
      expect(c!.execMs).not.toBeNull();
      expect(Number.isFinite(c!.execMs!)).toBe(true);
      expect(c!.execMs!).toBeGreaterThanOrEqual(0);
      // Real work proof: the worker's color hash matches the same kernel
      // run serially on the caller over identical inputs.
      const esmMod = await import(esm) as {
        resolveBand(
          color: Uint32Array, pal: Uint8Array, idx: Uint8Array,
          y0: number, y1: number, w: number, h: number,
        ): void;
      };
      const s2 = new Uint8Array(W * H);
      for (let i = 0; i < s2.length; i++) s2[i] = (i * 7 + (i >> 8)) & 255;
      const pal2 = new Uint8Array(768);
      for (let i = 0; i < 256; i++) {
        pal2[i * 3] = (i * 5) & 255; pal2[i * 3 + 1] = (i * 3 + 40) & 255; pal2[i * 3 + 2] = (i * 2 + 80) & 255;
      }
      const cc = new Uint32Array(W * H);
      esmMod.resolveBand(cc, pal2, s2, y0, y1, W, H);
      let h = 2166136261;
      for (let i = 0; i < cc.length; i++) {
        const px = cc[i]!;
        h ^= px & 255; h = Math.imul(h, 16777619);
        h ^= (px >>> 8) & 255; h = Math.imul(h, 16777619);
        h ^= (px >>> 16) & 255; h = Math.imul(h, 16777619);
        h ^= (px >>> 24) & 255; h = Math.imul(h, 16777619);
      }
      expect(rec['hash']).toBe((h >>> 0).toString(16).padStart(8, '0'));
      // And the measured sample flows through the consumer validator.
      const samples = collectWorkerExec({
        testBandExecStats: () => ([{
          frame, seq, job: 'resolve', worker: band, band, y0, y1,
          execMs: c!.execMs!, pixels: c!.pixels, spans: c!.spans,
        }]),
      });
      expect(samples).not.toBeNull();
      expect(workerExecCriticalPath(samples!).max).toBe(c!.execMs!);
    } finally {
      await worker.terminate();
    }
  });

  it('real BandWorkerPool pooled kick: finite dispatch fence + stable identity; exec stats feature-detected', async () => {
    const esm = swRendererEsmPath();
    if (!esm) {
      console.log('SKIP pooled exec: sw-renderer dist not built (run yarn build first)');
      return;
    }
    const W = 320, H = 240;
    resetCVars();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(new Uint8Array(768).fill(128));
    setCVar(SW_WORKERS_CVAR, 2);
    setCVar(SW_ACCUM_CVAR, 1);
    if (!r.syncWorkersFromCvar()) {
      console.log('SKIP pooled exec: worker sync unavailable');
      resetCVars();
      return;
    }
    const pool = BandWorkerPool.create(1, W, H, { indexJsPath: esm });
    if (!pool) {
      console.log('SKIP pooled exec: pool unavailable (need worker_threads + SAB + Atomics.wait)');
      resetCVars();
      return;
    }
    r.attachWorkerPool(pool);
    try {
      const view = {
        origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
        fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
      };
      const journal = new KickJournal();
      const t0 = nowNs();
      r.beginFrame();
      r.renderView(view, { name: 'devroom', data: createDevroom() }, []);
      r.endFrame();
      const latencyMs = nsToMs(nowNs() - t0);
      // Real pooled execution proof through public hooks (staging, not
      // message arrival): the indexed raster kick drew spans/pixels.
      const wst = r.testWorkerStats();
      expect(wst.active).toBe(true);
      expect(wst.pooled).toBe(true);
      expect(wst.spans).toBeGreaterThan(0);
      expect(wst.pixels).toBeGreaterThan(0);
      expect(Number.isFinite(latencyMs)).toBe(true);
      journal.record({
        frame: 0, seq: 0, job: 'indexed-frame', workers: 1, band: 'all',
        y0: 0, y1: H, latencyMs, ok: true, execMs: null, pixels: W * H, spans: wst.spans,
      });
      expect(journal.summarize('indexed-frame').n).toBe(1);
      expect(journal.bandsSeen()).toEqual([{ band: 'all', y0: 0, y1: H }]);
      // Worker-local exec: the renderer lane owns the producer. When it
      // publishes, every sample must carry finite durations + identity;
      // while it does not, the gap is explicit (null) — never a fake zero.
      const laneExec = readBandExecStats(pool) ?? collectWorkerExec(r);
      if (laneExec !== null) {
        expect(laneExec.length).toBeGreaterThan(0);
        for (const s of laneExec) {
          expect(Number.isFinite(s.execMs)).toBe(true);
          expect(s.execMs).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(s.frame)).toBe(true);
          expect(Number.isFinite(s.band)).toBe(true);
        }
      } else {
        expect(laneExec).toBeNull();
      }
      // Material GC ms: same feature-detection contract (bytes + eviction
      // counts are already reported; the ms cost reads null until published).
      const gcMs = readMaterialGcMs(r);
      if (gcMs !== null) expect(gcMs).toBeGreaterThanOrEqual(0);
    } finally {
      await pool.dispose();
      resetCVars();
    }
  });

  it('browser-entry contract without DOM: real completion message + diag snapshot shape', () => {
    // testkit cannot instantiate the browser worker entry (DOM + SAB +
    // COOP/COEP isolation live in apps/web) — what it CAN pin without DOM
    // is the completion protocol the browser entry posts: the same
    // readCompletionMessage parser the Node worker message above flowed
    // through, plus the DiagSnapshot structural read the bench browser
    // report consumes. Full browser-entry execution (render-worker.ts in a
    // real Worker) must run in apps/web (browser-lane.test.ts), not here.
    const measured = {
      seq: 9, band: 2, frame: 4, job: 'scanout', y0: 160, y1: 240,
      pixels: 25600, spans: 0, execMs: 1.75,
    };
    const c = readCompletionMessage(measured);
    expect(c).toMatchObject({ seq: 9, band: 2, frame: 4, job: 'scanout', execMs: 1.75 });
    // A diag snapshot carrying worker-local durations alongside (never
    // fused with) caller-clock arrivals parses; -1 marks unpublished exec.
    const snap = readDiagSnapshot({
      diagSnapshot: () => ({
        kicks: 1, frame: 4, seq: 9, job: 'scanout', bands: 4, mainMs: 0.5,
        arrivals: [1.2, 2.4], bandIds: [0, 1], pixels: [25600, 25600],
        spans: [0, 0], workerExecMs: [1.1, -1], slowestMs: 2.4,
      }),
    });
    expect(snap).not.toBeNull();
    expect(snap!.arrivals).toEqual([1.2, 2.4]);
    expect(snap!.workerExecMs).toEqual([1.1, -1]);
    expect(snap!.slowestMs).toBe(2.4);
    expect(readDiagSnapshot({})).toBeNull();
    expect(readDiagSnapshot({
      diagSnapshot: () => ({
        kicks: 1, frame: 0, seq: 0, job: 'x', bands: 2, mainMs: 0,
        arrivals: [1], bandIds: [0, 1], pixels: [1], spans: [0],
        workerExecMs: [1], slowestMs: 1,
      }),
    })).toBeNull();
  });
});
