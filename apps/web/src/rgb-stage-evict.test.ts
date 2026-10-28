// Phase 0 cache-capacity ownership regression (browser BrowserBandPool).
// Mirrors packages/sw-renderer/src/rgbStageEvict.test.ts: stageRGB must not
// evict the persistent chain cache while descriptors are pending.
import { describe, expect, it } from 'vitest';
import {
  attachRGBAccum,
  rgbAccumTotal,
  type RGBMipLevel,
  type SpanList,
} from '@q2/sw-renderer';
import { BrowserBandPool } from './render-workers.js';

const W = 64;
const H = 64;

function emptySpans(): SpanList {
  return { spans: [], count: 0 } as unknown as SpanList;
}

function makeChain(seed: number, w = 256, h = 256): RGBMipLevel[] {
  const data = new Uint8Array(w * h * 3);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = (i + seed) & 255;
  mask.fill(255);
  return [{ data, width: w, height: h, mask }];
}

function stagingPool(): BrowserBandPool {
  const sab = new SharedArrayBuffer(rgbAccumTotal(W, H));
  const { views: rgbViews } = attachRGBAccum(sab, W, H);
  const pool = Object.create(BrowserBandPool.prototype) as unknown as Record<string, unknown>;
  pool['disposed'] = false;
  pool['workers'] = [{}];
  pool['rgbViews'] = rgbViews;
  pool['rgbSpansUsed'] = 0;
  pool['rgbChainUsed'] = 0;
  pool['rgbChainLevels'] = 0;
  pool['rgbChainSlots'] = 0;
  pool['rgbLuxUsed'] = 0;
  pool['rgbDescCount'] = 0;
  pool['rgbChainMap'] = new Map();
  return pool as unknown as BrowserBandPool;
}

describe('browser stageRGB chain ownership (Phase 0)', () => {
  it('refuses to evict while batches are pending; pending bytes stay intact', () => {
    const pool = stagingPool() as unknown as {
      stageRGB(list: SpanList, s: number, c: number, lv: RGBMipLevel[], lx: null, lw: number, lh: number, f: number, z: number, t: number, fr: number): boolean;
      rgbPending(): number;
      rgbViews: ReturnType<typeof attachRGBAccum>['views'];
    } & Record<string, number | Map<unknown, unknown>>;
    const chains: RGBMipLevel[][] = [];
    for (let k = 0; k < 32; k++) {
      const lv = makeChain(k);
      chains.push(lv);
      expect(pool.stageRGB(emptySpans(), 0, 0, lv, null, 0, 0, 16, 16, 0, 0)).toBe(true);
    }
    expect(pool.rgbPending()).toBe(32);
    const usedBefore = pool['rgbChainUsed'] as number;
    const before = pool.rgbViews.chainData.slice(0, 1024);
    const extra = makeChain(9999);
    expect(pool.stageRGB(emptySpans(), 0, 0, extra, null, 0, 0, 16, 16, 0, 0)).toBe(false);
    expect(pool.rgbPending()).toBe(32);
    expect(pool['rgbChainUsed'] as number).toBe(usedBefore);
    expect(Array.from(pool.rgbViews.chainData.slice(0, 1024))).toEqual(Array.from(before));
    expect((pool['rgbChainMap'] as Map<RGBMipLevel[], number>).has(extra)).toBe(false);
    for (const lv of chains) {
      expect((pool['rgbChainMap'] as Map<RGBMipLevel[], number>).has(lv)).toBe(true);
    }
  });

  it('evict-and-retry succeeds once nothing is pending (next frame)', () => {
    const pool = stagingPool() as unknown as {
      stageRGB(list: SpanList, s: number, c: number, lv: RGBMipLevel[], lx: null, lw: number, lh: number, f: number, z: number, t: number, fr: number): boolean;
      rgbPending(): number;
    } & Record<string, number | Map<unknown, unknown>>;
    for (let k = 0; k < 32; k++) {
      expect(pool.stageRGB(emptySpans(), 0, 0, makeChain(k), null, 0, 0, 16, 16, 0, 0)).toBe(true);
    }
    pool['rgbDescCount'] = 0;
    pool['rgbSpansUsed'] = 0;
    pool['rgbLuxUsed'] = 0;
    const extra = makeChain(4242);
    expect(pool.stageRGB(emptySpans(), 0, 0, extra, null, 0, 0, 16, 16, 0, 0)).toBe(true);
    expect(pool.rgbPending()).toBe(1);
  });
});
