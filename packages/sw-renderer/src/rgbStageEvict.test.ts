// Phase 0 cache-capacity ownership regression (Node BandWorkerPool).
//
// stageRGB's persistent chain cache must never evict while descriptors are
// pending: those descriptors hold slot indices into the chain region, so a
// clear+retry would reuse their slots for different chains and silently
// corrupt pending work. The fix refuses to stage when pending (caller replays
// pending inline first); evict-and-retry is allowed only with no pending
// descriptors. This test fills the 8 MiB chain region while batches are
// pending and proves the failure is safe.
import { describe, expect, it } from 'vitest';
import {
  attachRGBAccum,
  rgbAccumTotal,
} from './bands.js';
import type { RGBMipLevel, SpanList } from './spans.js';
import { BandWorkerPool } from './bandPool.js';

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

/** Build a pool instance without spawning threads (staging only). */
function stagingPool(): BandWorkerPool {
  const sab = new SharedArrayBuffer(rgbAccumTotal(W, H));
  const { views: rgbViews } = attachRGBAccum(sab, W, H);
  const pool = Object.create(BandWorkerPool.prototype) as unknown as Record<string, unknown>;
  pool['disposed'] = false;
  pool['workers'] = [{}]; // non-empty so stageRGB proceeds; no thread use
  pool['rgbViews'] = rgbViews;
  pool['rgbSpansUsed'] = 0;
  pool['rgbChainUsed'] = 0;
  pool['rgbChainLevels'] = 0;
  pool['rgbChainSlots'] = 0;
  pool['rgbLuxUsed'] = 0;
  pool['rgbDescCount'] = 0;
  pool['rgbChainMap'] = new Map();
  return pool as unknown as BandWorkerPool;
}

describe('RGB stageRGB chain ownership (Phase 0)', () => {
  it('refuses to evict while batches are pending; pending bytes stay intact', () => {
    const pool = stagingPool() as unknown as {
      stageRGB(list: SpanList, s: number, c: number, lv: RGBMipLevel[], lx: null, lw: number, lh: number, f: number, z: number, t: number, fr: number): boolean;
      rgbPending(): number;
      rgbViews: ReturnType<typeof attachRGBAccum>['views'];
    } & Record<string, number | Map<unknown, unknown>>;
    const chains: RGBMipLevel[][] = [];
    // 256x256 chains are ~256 KiB each; 32 fill the 8 MiB region.
    for (let k = 0; k < 32; k++) {
      const lv = makeChain(k);
      chains.push(lv);
      const ok = pool.stageRGB(emptySpans(), 0, 0, lv, null, 0, 0, 16, 16, 0, 0);
      expect(ok).toBe(true);
    }
    expect(pool.rgbPending()).toBe(32);
    const usedBefore = pool['rgbChainUsed'] as number;
    expect(usedBefore).toBeGreaterThan(0);
    expect(usedBefore).toBeLessThanOrEqual(8 * 1024 * 1024);
    // Snapshot the first chain's staged bytes (slot 0, offset 0).
    const before = pool.rgbViews.chainData.slice(0, 1024);

    const extra = makeChain(9999);
    const ok = pool.stageRGB(emptySpans(), 0, 0, extra, null, 0, 0, 16, 16, 0, 0);
    // Must NOT evict-and-retry: pending descriptors reference live slots.
    expect(ok).toBe(false);
    expect(pool.rgbPending()).toBe(32);
    expect(pool['rgbChainUsed'] as number).toBe(usedBefore);
    const after = pool.rgbViews.chainData.slice(0, 1024);
    expect(Array.from(after)).toEqual(Array.from(before));
    // The extra chain was not installed.
    expect((pool['rgbChainMap'] as Map<RGBMipLevel[], number>).has(extra)).toBe(false);
    // All 32 pending chains still resolve.
    for (const lv of chains) {
      expect((pool['rgbChainMap'] as Map<RGBMipLevel[], number>).has(lv)).toBe(true);
    }
  });

  it('evict-and-retry succeeds once nothing is pending (next frame)', () => {
    const pool = stagingPool() as unknown as {
      stageRGB(list: SpanList, s: number, c: number, lv: RGBMipLevel[], lx: null, lw: number, lh: number, f: number, z: number, t: number, fr: number): boolean;
      rgbPending(): number;
      rgbViews: ReturnType<typeof attachRGBAccum>['views'];
    } & Record<string, number | Map<unknown, unknown>>;
    for (let k = 0; k < 32; k++) {
      expect(pool.stageRGB(emptySpans(), 0, 0, makeChain(k), null, 0, 0, 16, 16, 0, 0)).toBe(true);
    }
    expect(pool.rgbPending()).toBe(32);
    // Simulate end-of-frame drain that keeps the persistent chain cache but
    // drops per-frame bump state (mirrors resetRGB without clearRGBChains).
    pool['rgbDescCount'] = 0;
    pool['rgbSpansUsed'] = 0;
    pool['rgbLuxUsed'] = 0;
    const extra = makeChain(4242);
    const ok = pool.stageRGB(emptySpans(), 0, 0, extra, null, 0, 0, 16, 16, 0, 0);
    expect(ok).toBe(true);
    expect(pool.rgbPending()).toBe(1);
    expect((pool['rgbChainMap'] as Map<RGBMipLevel[], number>).has(extra)).toBe(true);
  });
});
