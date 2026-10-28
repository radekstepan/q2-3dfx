// P2 pin: texture-chain eviction must not leave retained-but-unbudgeted
// chains behind. Chains are shared by reference with RGBLightCache
// materials, so evicting a chain without dropping its dependents kept the
// bytes alive (retained >> chainUsed, plus a duplicate chain on the next
// miss for the same texture). Eviction now invalidates dependents
// surgically; this churn test pins retained == accounted <= budget.
import { describe, expect, it } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import { SoftwareRenderer } from './frame.js';
import { RGBLightCache } from './surfaceCache.js';
import type { RGBMipLevel } from './spans.js';
import type { MiniWorld } from './worldNodes.js';

interface ChainHarness {
  rgbChainFor(
    texId: number,
    src: { width: number; height: number; texels: Uint8Array },
    world: MiniWorld,
  ): RGBMipLevel[] | null;
  rgbCache: RGBLightCache;
}

function testPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = (i * 5) & 255;
    pal[i * 3 + 1] = (i * 3 + 40) & 255;
    pal[i * 3 + 2] = (i * 2 + 80) & 255;
  }
  return pal;
}

/** One pinning RGB entry sharing `chain` (mirrors buildRGBEntry linkage). */
function pinEntry(chain: RGBMipLevel[]) {
  const rgb = new Uint8Array(3 * 4 * 4).fill(7);
  return {
    block: {
      texels: new Uint8Array([1]), bw: 1, bh: 1,
      light: new Uint8Array([63]), luxW: 1, luxH: 1, rgb,
    },
    material: {
      levels: chain, addressS: 'repeat' as const, addressT: 'repeat' as const,
      light: { samples: rgb, luxW: 4, luxH: 4 },
      overbright: false, lodBias: 0, mipDither: false, bilinear: true,
      zbits: 0, blend: 'opaque' as const, alphaTest: null, depthWrite: true,
      alpha: 1, warp: false, turbPhase: 0, flatColor: null,
    },
  };
}

const TEX_W = 256, TEX_H = 256, TEX_COUNT = 90;

function churn(harness: ChainHarness, world: MiniWorld, first: number, n: number): void {
  for (let k = 0; k < n; k++) {
    const id = first + k;
    const texels = new Uint8Array(TEX_W * TEX_H);
    for (let i = 0; i < texels.length; i++) texels[i] = (i + id * 13) & 255;
    const chain = harness.rgbChainFor(id, { width: TEX_W, height: TEX_H, texels }, world);
    expect(chain).not.toBeNull();
    harness.rgbCache.put(id, 1, 0, pinEntry(chain!));
  }
}

describe('RGB texture-chain eviction ownership (P2)', () => {
  it('churn past budget: evictions fire, retained == accounted <= budget', () => {
    const fb = createFramebuffer(64, 64, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    const harness = r as unknown as ChainHarness;
    const world = { brand: 'miniworld' } as unknown as MiniWorld;

    churn(harness, world, 0, TEX_COUNT);
    const st = r.testRGBCacheStats();
    // 256x256 chains are ~0.33 MiB; 90 of them (~30 MiB) must overflow 16 MiB.
    expect(st.chainEvictions).toBeGreaterThan(0);
    expect(st.chainUsed).toBeLessThanOrEqual(16 * 1024 * 1024);

    const acc = r.testRGBChainAccounting();
    expect(acc.chainMapBytes).toBe(acc.chainUsed);
    expect(acc.orphanChainBytes).toBe(0);
    expect(acc.retainedChainBytes).toBe(acc.chainUsed);
    // Dependents of evicted chains drop with them: one entry per live chain.
    expect(acc.rgbEntries).toBe(st.chainSize);
  });

  it('re-request of an evicted texture rebuilds once, accounting stays exact', () => {
    const fb = createFramebuffer(64, 64, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    const harness = r as unknown as ChainHarness;
    const world = { brand: 'miniworld' } as unknown as MiniWorld;

    churn(harness, world, 0, TEX_COUNT);
    const before = r.testRGBCacheStats();
    expect(before.chainEvictions).toBeGreaterThan(0);

    // Tex 0 was evicted long ago (with its dependent); re-request rebuilds
    // the chain (miss) and re-links a single entry — no duplicate beside a
    // pinned original, so accounting stays exact after another churn wave.
    const texels = new Uint8Array(TEX_W * TEX_H);
    for (let i = 0; i < texels.length; i++) texels[i] = (i + 0 * 13) & 255;
    const rebuilt = harness.rgbChainFor(0, { width: TEX_W, height: TEX_H, texels }, world);
    expect(rebuilt).not.toBeNull();
    harness.rgbCache.put(0, 1, 0, pinEntry(rebuilt!));
    expect(r.testRGBCacheStats().chainMisses).toBe(before.chainMisses + 1);

    churn(harness, world, TEX_COUNT, TEX_COUNT);
    const acc = r.testRGBChainAccounting();
    expect(acc.orphanChainBytes).toBe(0);
    expect(acc.retainedChainBytes).toBe(acc.chainUsed);
    expect(acc.chainUsed).toBeLessThanOrEqual(acc.budget);
  });

  it('RGBLightCache.invalidateChain drops only the sharing entries', () => {
    const c = new RGBLightCache(1 << 20);
    const texels = new Uint8Array([9]);
    const mkEntry = (levels: RGBMipLevel[]) => ({
      block: {
        texels, bw: 1, bh: 1,
        light: new Uint8Array([63]), luxW: 1, luxH: 1,
        rgb: new Uint8Array([1, 2, 3]),
      },
      material: {
        levels, addressS: 'repeat' as const, addressT: 'repeat' as const,
        light: null, overbright: false, lodBias: 0, mipDither: false,
        bilinear: true, zbits: 0, blend: 'opaque' as const, alphaTest: null,
        depthWrite: true, alpha: 1, warp: false, turbPhase: 0, flatColor: null,
      },
    });
    const chainA = [{} as RGBMipLevel];
    const chainB = [{} as RGBMipLevel];
    const entryA = mkEntry(chainA);
    const entryB = mkEntry(chainB);
    c.put(1, 1, 0, entryA);
    c.put(2, 1, 0, entryA);
    c.put(3, 1, 0, entryB);
    expect(c.size).toBe(3);
    expect(c.referencedChains()).toHaveLength(2);
    expect(c.invalidateChain(chainA)).toBe(2);
    expect(c.size).toBe(1);
    expect(c.get(3, 1, 0)).toBe(entryB);
    expect(c.referencedChains()).toEqual([chainB]);
  });
});
