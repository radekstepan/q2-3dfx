// Track A: Node pool parallel scanout matches serial (real worker threads).
import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import {
  attachFrameAccum, attachRGBAccum, processScanoutBand, rgbAccumTotal,
  splitBands, type ScanoutBandOptions,
} from './bands.js';
import { BandWorkerPool } from './bandPool.js';

function distOrSkip(): string | null {
  const distUrl = new URL('../dist/index.mjs', import.meta.url);
  if (!existsSync(distUrl)) {
    console.log('SKIP scanout pool test: dist not built');
    return null;
  }
  return distUrl.pathname;
}

function makeColor(w: number, h: number): Uint32Array {
  const c = new Uint32Array(w * h);
  let x = 987654321;
  for (let i = 0; i < c.length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    c[i] = (0xff000000 | ((x & 255) << 16) | (((x >>> 8) & 255) << 8) | ((x >>> 16) & 255)) >>> 0;
  }
  return c;
}

const OPTS: ScanoutBandOptions = {
  gamma: 1.3, dither: true, ditherMode: 0, postfilter: true,
  reconmode: 1, maxR: 8, maxG: 8, maxB: 8, quantise: true,
};

describe('pooled scanout kick (Track A)', () => {
  it('flushScanout matches serial banded scanout', { timeout: 120000 }, () => {
    const dist = distOrSkip();
    if (!dist) return;
    const W = 64, H = 48;
    const n = W * H;
    const color = makeColor(W, H);
    // Serial reference: whole-frame banded scanout from source.
    const ref565 = new Uint16Array(n);
    const refDisp = new Uint32Array(n);
    processScanoutBand(color, ref565, refDisp, W, H, OPTS, 0, H);

    const pool = BandWorkerPool.create(3, W, H, { indexJsPath: dist });
    if (!pool) throw new Error('pool create failed');
    try {
      // Stage the source frame into the pool's shared color plane.
      const planes = pool.planes;
      if (!planes) throw new Error('no shared planes');
      planes.color.set(color);
      const ok = pool.flushScanout(OPTS);
      expect(ok).toBe(true);
      const sp = pool.scanoutPlanes;
      expect(Array.from(sp.scan565)).toEqual(Array.from(ref565));
      expect(Array.from(sp.scanDisplay)).toEqual(Array.from(refDisp));
    } finally {
      void pool.dispose();
    }
  });
});
