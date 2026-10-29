// Test-only stub pool: REAL pool staging/kick code, fake workers (no threads).
//
// Shared by the recovery/adversarial suites. NOT part of the shipped bundle
// (nothing outside *.test.ts imports it). Kept out of rgbRecovery.test.ts
// so importing it does not re-register that file's suites during collection.
import { BandWorkerPool } from './bandPool.js';
import {
  attachFrameAccum, attachRGBAccum, CTL_READY,
  rgbAccumTotal, splitBands,
  type Band, type RGBAccumViews,
} from './bands.js';

/** Scripted pool: REAL staging/kick code, fake workers (no threads). */
export interface StubPool extends BandWorkerPool {
  __stubViews: RGBAccumViews;
}

export function stubPool(W: number, H: number, opts?: { readyBands?: number; timeoutMs?: number }): StubPool {
  const full = new SharedArrayBuffer(rgbAccumTotal(W, H));
  const { views } = attachFrameAccum(full, W, H);
  const { views: rgbViews } = attachRGBAccum(full, W, H);
  const fakeWorkers = [{}, {}, {}];
  const pool = Object.create(BandWorkerPool.prototype) as unknown as Record<string, unknown>;
  const bands: Band[] = splitBands(H, fakeWorkers.length + 1);
  pool['bandCount'] = bands.length;
  pool['workers'] = fakeWorkers;
  pool['views'] = views;
  pool['rgbViews'] = rgbViews;
  pool['base'] = views.base;
  pool['ctl'] = views.ctl;
  pool['bands'] = bands;
  pool['timeoutMs'] = opts?.timeoutMs ?? 10;
  pool['fbW'] = W;
  pool['fbH'] = H;
  pool['seq'] = 0;
  pool['lastTexels'] = null;
  pool['lastLight'] = null;
  pool['lastColormap'] = null;
  pool['lastPalette'] = null;
  pool['pending'] = new Map();
  pool['readyCount'] = 0;
  pool['frameGen'] = 0;
  pool['mainLastGen'] = 0;
  pool['disposed'] = false;
  pool['spansUsed'] = 0;
  pool['texUsed'] = 0;
  pool['lightUsed'] = 0;
  pool['descCount'] = 0;
  pool['rgbSpansUsed'] = 0;
  pool['rgbChainUsed'] = 0;
  pool['rgbChainLevels'] = 0;
  pool['rgbChainSlots'] = 0;
  pool['rgbLuxUsed'] = 0;
  pool['rgbDescCount'] = 0;
  pool['rgbChainMap'] = new Map();
  pool['rgbTriUsed'] = 0;
  pool['rgbFlushedCount'] = 0;
  pool['rgbFailure'] = null;
  pool['quarantined'] = false;
  pool['sabEpoch'] = 0;
  pool['quarantineSettled'] = null;
  // Readiness: fake workers never signal, so preset the counter the
  // awaitReadySync path polls (ready = kick proceeds, main band runs,
  // DONE never arrives -> deterministic timeout).
  views.ctl[CTL_READY] = opts?.readyBands ?? 0;
  const p = pool as unknown as StubPool;
  p.__stubViews = rgbViews;
  return p;
}
