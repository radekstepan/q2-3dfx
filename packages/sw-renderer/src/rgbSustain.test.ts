// RGB sustained-performance ownership: shared chains + surgical dlight
// invalidation + bounded resources (all asset-free, devroom).
//
// Covers the confirmed FPS-decline mechanism on real maps:
// 1. Per-surface full-chain expansion thrashed the 4MB RGBLightCache (0%
//    hits, full rebuild + megabytes of garbage per frame). Chains are now
//    shared per texture (upload-time cost, VRAM-like budget): a second frame
//    is all-hits with zero evictions.
// 2. Every dlight serial bump used to invalidateAll both caches (a muzzle
//    flash = full rebuild per combat frame). Invalidation is now the union
//    of last-frame-touched and current-affected surfaces: untouched
//    surfaces stay hot across serial bumps, and an expired light returns
//    its surfaces to baseline exactly once (no stale luxels, no leak of
//    never-read old-serial entries — the keys carry no serial).
// 3. Sustained identical frames are pixel-identical (determinism) with
//    bounded cache sizes and zero evictions.
import { describe, expect, it, afterEach } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import { SoftwareRenderer, setRGBWorldEnabled } from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';

afterEach(() => {
  setRGBWorldEnabled(false);
});

const W = 160, H = 120;

function renderDevroom(r: SoftwareRenderer, time: number): void {
  const styles = new Float32Array(256).fill(1);
  r.beginFrame();
  r.renderView(
    {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time, lightStyles: styles,
    },
    { name: 'devroom', data: createDevroom() },
    [],
  );
  r.endFrame();
}

function fnvU8(a: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) {
    h ^= a[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

describe('RGB cache ownership under sustained rendering', () => {
  it('second identical frame is all-hits with zero evictions', () => {
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = (i * 5) & 255;
      pal[i * 3 + 1] = (i * 3 + 40) & 255;
      pal[i * 3 + 2] = (i * 2 + 80) & 255;
    }
    r.setPalette(pal);
    setRGBWorldEnabled(true);
    renderDevroom(r, 1.5);
    const cold = r.testRGBCacheStats();
    expect(cold.misses).toBeGreaterThan(0);
    expect(cold.chainMisses).toBeGreaterThan(0);
    const chainSizeCold = cold.chainSize;
    renderDevroom(r, 1.5);
    const hot = r.testRGBCacheStats();
    // luxel hits dominate (only style/mip variants miss, if any); chains
    // serve every surface with zero new builds and zero evictions
    expect(hot.hits).toBeGreaterThan(cold.hits);
    expect(hot.misses).toBe(cold.misses);
    expect(hot.chainMisses).toBe(cold.chainMisses);
    expect(hot.chainSize).toBe(chainSizeCold);
    expect(hot.evictions).toBe(0);
    expect(hot.chainEvictions).toBe(0);
  });

  it('dlight serial churn keeps untouched surfaces hot; expiry restores baseline', () => {
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = (i * 5) & 255;
      pal[i * 3 + 1] = (i * 3 + 40) & 255;
      pal[i * 3 + 2] = (i * 2 + 80) & 255;
    }
    r.setPalette(pal);
    setRGBWorldEnabled(true);
    renderDevroom(r, 1.5);
    const baseline = fnvU8(new Uint8Array(fb.color.buffer));
    // flash near the critter: only nearby surfaces rebuild
    r.testAddDynamicLight({
      origin: new Float32Array([60, -90, 60]),
      intensity: 200,
      color: new Float32Array([1, 1, 0]),
    });
    renderDevroom(r, 1.6);
    const lit = fnvU8(new Uint8Array(fb.color.buffer));
    expect(lit).not.toBe(baseline);
    const during = r.testRGBCacheStats();
    // churn frames: re-add every frame (like the muzzle pump) — misses stay
    // confined to touched surfaces instead of the whole map
    for (let f = 0; f < 5; f++) {
      r.testExpireDynamicLights();
      r.testAddDynamicLight({
        origin: new Float32Array([60, -90, 60]),
        intensity: 200,
        color: new Float32Array([1, 1, 0]),
      });
      renderDevroom(r, 1.7 + f * 0.1);
    }
    const churned = r.testRGBCacheStats();
    const churnMisses = churned.misses - during.misses;
    // touched-set rebuilds only: far below a full-map rebuild per frame
    expect(churnMisses).toBeLessThan(5 * 200);
    expect(churned.evictions).toBe(0);
    expect(churned.chainEvictions).toBe(0);
    // drop the light (ttl expiry path): surfaces return to baseline exactly
    // (same timestamp: turbulent water phase is time-driven)
    r.testExpireDynamicLights();
    renderDevroom(r, 1.5);
    renderDevroom(r, 1.5);
    expect(fnvU8(new Uint8Array(fb.color.buffer))).toBe(baseline);
  });

  it('200 identical frames: pixel-identical with bounded resources', () => {
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = (i * 5) & 255;
      pal[i * 3 + 1] = (i * 3 + 40) & 255;
      pal[i * 3 + 2] = (i * 2 + 80) & 255;
    }
    r.setPalette(pal);
    setRGBWorldEnabled(true);
    renderDevroom(r, 1.5);
    const first = fnvU8(new Uint8Array(fb.color.buffer));
    for (let f = 0; f < 200; f++) renderDevroom(r, 1.5);
    expect(fnvU8(new Uint8Array(fb.color.buffer))).toBe(first);
    const st = r.testRGBCacheStats();
    const sc = r.testCacheStats();
    // bounded: devroom needs a handful of chains/luxels, nothing grows
    expect(st.chainSize).toBeLessThanOrEqual(16);
    expect(st.size).toBeLessThanOrEqual(64);
    expect(st.evictions).toBe(0);
    expect(st.chainEvictions).toBe(0);
    expect(sc.evictions).toBe(0);
  });
});
