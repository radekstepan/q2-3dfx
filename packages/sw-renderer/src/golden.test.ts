// M3.1 golden test: fixed-camera devroom render at 320x240 is bit-exact.
// Asset-free (procedural devroom + procedural palette).
import { describe, expect, it } from 'vitest';
import { SoftwareRenderer } from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import { createFramebuffer } from '@q2/renderer-api';

function renderGolden(): { hash: string; spans: number; pixels: number; overdraw: number; distinct: number } {
  const W = 320, H = 240;
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  // deterministic procedural palette (warm ramp)
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = (i * 5) & 255;
    pal[i * 3 + 1] = (i * 3 + 40) & 255;
    pal[i * 3 + 2] = (i * 2 + 80) & 255;
  }
  r.setPalette(pal);
  const styles = new Float32Array(256).fill(1);
  styles[1] = 0.6;
  r.beginFrame();
  const stats = r.renderView(
    { origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles, fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: styles },
    { name: 'devroom', data: createDevroom() },
    [],
  );
  r.endFrame();
  let h = 2166136261;
  const idx = fb.index!;
  for (let i = 0; i < idx.length; i++) {
    h ^= idx[i]!;
    h = Math.imul(h, 16777619);
  }
  return {
    hash: (h >>> 0).toString(16).padStart(8, '0'),
    spans: stats.spans, pixels: stats.pixels, overdraw: stats.overdraw,
    distinct: new Set(idx).size,
  };
}

describe('devroom golden frame', () => {
  it('renders the pinned 320x240 hash', () => {
    const g = renderGolden();
    console.log('GOLDEN', JSON.stringify(g));
    expect(g.hash).toBe('8f61c755');
  });

  it('frame is deterministic across runs', () => {
    const a = renderGolden();
    const b = renderGolden();
    expect(a.hash).toBe(b.hash);
    expect(a.spans).toBeGreaterThan(100);
    expect(a.pixels).toBeGreaterThan(320 * 240 * 0.5);
    expect(a.overdraw).toBeLessThan(4);
    expect(a.distinct).toBeGreaterThan(4);
  });

  it('dynamic lights mark surfaces and invalidate entries (M3.2)', () => {
    const W = 320, H = 240;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(new Uint8Array(768).fill(128));
    const styles = new Float32Array(256).fill(1);
    const view = {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time: 0, lightStyles: styles,
    };
    const world = { name: 'devroom', data: createDevroom() };
    r.beginFrame();
    r.renderView(view, world, []);
    // steady state: all hits
    r.testResetCacheStats();
    r.beginFrame();
    r.renderView(view, world, []);
    expect(r.testCacheStats().misses).toBe(0);
    // blaster bolt next to the pillar: affected surfaces relight every frame
    r.testAddDynamicLight({
      origin: new Float32Array([60, 40, 150]), intensity: 220,
      color: new Float32Array([1, 0.55, 0.25]),
    });
    r.testResetCacheStats();
    r.beginFrame();
    const lit = r.renderView(view, world, []);
    const s1 = r.testCacheStats();
    expect(s1.misses).toBeGreaterThan(0); // serial change -> full rebuild
    expect(lit.pixels).toBeGreaterThan(0);
    r.testResetCacheStats();
    r.beginFrame();
    r.renderView(view, world, []);
    const s2 = r.testCacheStats();
    // PERF-NEXT-6 lane A steady-light memo: the identical light marks the
    // identical set, so the entries built above stay hot (misses convert to
    // hits serving bit-identical luxels — the relight is served, not rebuilt).
    expect(s2.misses).toBe(0);
    expect(s2.hits).toBeGreaterThan(0);
    // Changed light values still invalidate (memo keys on exact values).
    r.testClearDynamicLights();
    r.testAddDynamicLight({
      origin: new Float32Array([60, 40, 150]), intensity: 260,
      color: new Float32Array([1, 0.55, 0.25]),
    });
    r.testResetCacheStats();
    r.beginFrame();
    r.renderView(view, world, []);
    expect(r.testCacheStats().misses).toBeGreaterThan(0); // value change -> rebuild
    // light gone: one rebuild, then steady hits again
    r.testClearDynamicLights();
    r.beginFrame();
    r.renderView(view, world, []);
    r.testResetCacheStats();
    r.beginFrame();
    r.renderView(view, world, []);
    expect(r.testCacheStats().misses).toBe(0);
  });

  it('steady-state cache hit rate is 100% (M3.2)', () => {
    const W = 320, H = 240;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(new Uint8Array(768).fill(128));
    const styles = new Float32Array(256).fill(1);
    const view = {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time: 0, lightStyles: styles,
    };
    const world = { name: 'devroom', data: createDevroom() };
    r.beginFrame();
    r.renderView(view, world, []);
    r.testResetCacheStats();
    r.beginFrame();
    r.renderView(view, world, []);
    const s = r.testCacheStats();
    expect(s.misses).toBe(0);
    expect(s.hits).toBeGreaterThan(0);
    expect(s.hitRate).toBe(1);
    expect(s.used).toBeLessThan(4 * 1024 * 1024);
  });
});

describe('dynamic light expiry (M6.1 muzzle-leak fix, renderer side)', () => {
  function setup() {
    const W = 320, H = 240;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    // deterministic procedural palette (warm ramp, as in renderGolden): the
    // index plane actually resolves light grades, so a live flash changes
    // the frame hash and expiry restores the pinned golden hash.
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = (i * 5) & 255;
      pal[i * 3 + 1] = (i * 3 + 40) & 255;
      pal[i * 3 + 2] = (i * 2 + 80) & 255;
    }
    r.setPalette(pal);
    const styles = new Float32Array(256).fill(1);
    styles[1] = 0.6;
    const view = {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: styles,
    };
    const world = { name: 'devroom', data: createDevroom() };
    const frame = (): void => {
      r.beginFrame();
      r.renderView(view, world, []);
      r.endFrame();
    };
    const hash = (): string => {
      let h = 2166136261;
      const idx = fb.index!;
      for (let i = 0; i < idx.length; i++) {
        h ^= idx[i]!;
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16).padStart(8, '0');
    };
    return { r, frame, hash };
  }

  const flash = () => ({
    origin: new Float32Array([60, 40, 150]), intensity: 220,
    color: new Float32Array([1, 0.55, 0.25]),
  });

  it('an abandoned flash expires: exactly one rebuild, then baseline', () => {
    const { r, frame, hash } = setup();
    frame();
    frame();
    const base = hash();
    expect(base).toBe('8f61c755'); // steady baseline is the pinned golden
    expect(r.testDynamicLightCount()).toBe(0);
    // one-shot add, never re-added, never explicitly cleared
    r.testAddDynamicLight(flash());
    expect(r.testDynamicLightCount()).toBe(1);
    frame(); // ttl 2 -> 1: lit
    const lit = hash();
    expect(lit).not.toBe(base);
    frame(); // ttl 1 -> 0: still lit (deterministic: same hash)
    expect(hash()).toBe(lit);
    expect(r.testDynamicLightCount()).toBe(1);
    // abandoned: the expiry sweep drops it with one serial bump (one full
    // rebuild) and the scene returns to baseline — no permanent brighten.
    r.testResetCacheStats();
    frame(); // ttl 0 -> removed -> invalidateAll -> unlit rebuild
    expect(r.testDynamicLightCount()).toBe(0);
    expect(hash()).toBe(base);
    expect(r.testCacheStats().misses).toBeGreaterThan(0);
    r.testResetCacheStats();
    frame(); // steady again: no further invalidation
    expect(hash()).toBe(base);
    const s = r.testCacheStats();
    expect(s.misses).toBe(0);
    expect(s.hits).toBeGreaterThan(0);
    expect(s.used).toBeLessThan(4 * 1024 * 1024);
  });

  it('sustained pumping does not accumulate; stopping restores baseline', () => {
    const { r, frame, hash } = setup();
    frame();
    frame();
    const base = hash();
    let maxCount = 0;
    for (let i = 0; i < 5; i++) {
      r.testExpireDynamicLights(); // what the web muzzle pump probes first
      r.testAddDynamicLight(flash());
      maxCount = Math.max(maxCount, r.testDynamicLightCount());
      frame();
    }
    // bounded by ttl, not by the number of pumps (old code grew forever)
    expect(maxCount).toBeLessThanOrEqual(3);
    for (let i = 0; i < 4; i++) frame();
    expect(r.testDynamicLightCount()).toBe(0);
    expect(hash()).toBe(base);
    r.testResetCacheStats();
    frame();
    expect(r.testCacheStats().misses).toBe(0);
  });
});
