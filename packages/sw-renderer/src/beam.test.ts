// Blaster-beam look proof: the player beam must read as id's yellow/orange
// bolt — a bright near-white core with an orange surround — and actually
// land bright pixels on screen at 320x240. Renders a full eye->impact
// horizontal beam through spawnTracer and counts what lands along its path.
import { describe, expect, it } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import { SoftwareRenderer } from './frame.js';
import { TRACER_CORE_COLOR } from './tracer.js';
import { defaultPalette } from './colormap.js';
import type { MiniWorld } from './worldNodes.js';

/** Empty world: no occluders, background index 0 everywhere. */
function emptyWorld(): MiniWorld {
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 0 }],
    pvs: [new Uint8Array([1])],
    clusterCount: 1,
    surfaces: [],
    textures: [{ texels: new Uint8Array(16).fill(7), width: 4, height: 4 }],
    lightmaps: [{ samples: new Uint8Array([128, 128, 128]), luxW: 1, luxH: 1, styles: [0] }],
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
}

const BEAM_GLOW = 225; // blaster orange surround (BLASTER_TRACER_COLOR)

function renderBeam(length: number): { idx: Uint8Array; pal: Uint8Array } {
  const W = 320, H = 240;
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  const pal = defaultPalette();
  r.init(fb);
  r.setPalette(pal);
  // Long horizontal beam broadside to the camera: eye at x=100-...,
  // impact 120 world units along +Y at depth 100, centered vertically.
  expect(r.spawnTracer(new Float32Array([100, -60, 0]), new Float32Array([0, 1, 0]), BEAM_GLOW, length, 3)).toBe(true);
  r.beginFrame();
  r.renderView(
    {
      origin: new Float32Array([0, 0, 0]), angles: new Float32Array([0, 0, 0]),
      fovX: 90, time: 0, lightStyles: new Float32Array(256).fill(1),
    },
    { name: 'beam', data: emptyWorld() },
    [],
  );
  r.endFrame();
  return { idx: fb.index!, pal };
}

describe('blaster beam look (yellow core + orange surround)', () => {
  it('lands a bright core + halo along the full eye->impact path', () => {
    const W = 320, H = 240;
    const { idx, pal } = renderBeam(120);
    // Only beam pixels differ from background.
    expect(new Set(idx)).toEqual(new Set([0, TRACER_CORE_COLOR, BEAM_GLOW]));
    // Peak core row = the beam path; everything lands in a tight band.
    let peak = 0, peakN = -1;
    for (let y = 0; y < H; y++) {
      let n = 0;
      for (let x = 0; x < W; x++) if (idx[y * W + x] === TRACER_CORE_COLOR) n++;
      if (n > peakN) { peakN = n; peak = y; }
    }
    expect(peakN).toBeGreaterThan(100); // ~192px beam, 1px core
    let core = 0, halo = 0, bright = 0;
    let minX = W, maxX = -1;
    const lum = (c: number): number => pal[c * 3]! + pal[c * 3 + 1]! + pal[c * 3 + 2]!;
    for (let y = peak - 2; y <= peak + 2; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = 0; x < W; x++) {
        const c = idx[y * W + x]!;
        if (c === TRACER_CORE_COLOR) { core++; if (x < minX) minX = x; if (x > maxX) maxX = x; }
        else if (c === BEAM_GLOW) halo++;
        if (c !== 0 && lum(c) > 400) bright++;
      }
    }
    expect(core).toBeGreaterThan(120);
    expect(halo).toBeGreaterThan(200); // 3-wide bolt: 2 halo rows
    // Full length lands: the 120-unit beam spans most of the screen width.
    expect(minX).toBeLessThan(100);
    expect(maxX).toBeGreaterThan(220);
    // Proof it reads bright on screen (both core and surround resolve hot).
    expect(lum(TRACER_CORE_COLOR)).toBeGreaterThan(400);
    expect(lum(BEAM_GLOW)).toBeGreaterThan(400);
    expect(bright).toBeGreaterThan(300);
  });

  it('beam length controls the on-screen extent (eye->impact, not a stub)', () => {
    const countCore = (length: number): number => {
      const W = 320, H = 240;
      const { idx } = renderBeam(length);
      let n = 0;
      for (let i = 0; i < idx.length; i++) if (idx[i] === TRACER_CORE_COLOR) n++;
      return n;
    };
    // Longer beams land strictly more core pixels (no truncation).
    expect(countCore(120)).toBeGreaterThan(countCore(30) + 40);
  });

  it('a spawned beam expires after its ttl frames (no lingering bolts)', () => {
    const W = 320, H = 240;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(defaultPalette());
    const view = {
      origin: new Float32Array([0, 0, 0]), angles: new Float32Array([0, 0, 0]),
      fovX: 90, time: 0, lightStyles: new Float32Array(256).fill(1),
    };
    const world = { name: 'beam', data: emptyWorld() };
    const frame = (): void => {
      r.beginFrame();
      r.renderView(view, world, []);
      r.endFrame();
    };
    const beamPixels = (): number => {
      let n = 0;
      const idx = fb.index!;
      for (let i = 0; i < idx.length; i++) {
        if (idx[i] === TRACER_CORE_COLOR || idx[i] === BEAM_GLOW) n++;
      }
      return n;
    };
    // ttl 6 (TRACER_TTL_FRAMES): drawn for 6 renders, gone by the 7th.
    expect(r.spawnTracer(new Float32Array([100, -60, 0]), new Float32Array([0, 1, 0]), BEAM_GLOW, 120, 6)).toBe(true);
    for (let i = 0; i < 5; i++) {
      frame();
      expect(r.testTracerCount()).toBe(1);
      expect(beamPixels()).toBeGreaterThan(100);
    }
    frame(); // 6th render: still drawn (ttl 1 -> 0), pool empty afterwards
    expect(beamPixels()).toBeGreaterThan(100);
    expect(r.testTracerCount()).toBe(0);
    frame(); // 7th render: fully expired, nothing lands
    expect(r.testTracerCount()).toBe(0);
    expect(beamPixels()).toBe(0);
    frame();
    expect(r.testTracerCount()).toBe(0);
    expect(beamPixels()).toBe(0);
  });
});
