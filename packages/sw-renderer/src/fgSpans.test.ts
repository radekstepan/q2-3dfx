// TASK item 2 (renderer lane): foreground point/line primitives as spans.
//
// Particles (1px opaque points) and tracer beams (additive DDA lines) are
// staged into the RGB worker kick as spans instead of drawing inline.
// These tests pin the emission to be EXACTLY the serial draws BEFORE any
// worker is involved: emitParticleSpans == drawParticlesRGB and
// emitTracerSpans == drawTracerBeamRGB on identical planes, including
// depth ties, clipping, odd dims and fuzzed inputs. The kick itself then
// reuses the pinned span path (processRGBFrameJob), so worker execution
// inherits the equality.
import { describe, expect, it } from 'vitest';
import { setupCamera } from './camera.js';
import { DEVROOM_CAMERA } from './devroom.js';
import {
  buildRGBMaterial, createSpan, drawSpansRGB,
  type RGBMaterial, type SpanList,
} from './spans.js';
import {
  drawParticlesRGB, emitParticleSpans, projectParticles, type ScreenParticle,
} from './particles.js';
import {
  drawTracerBeamRGB, emitTracerSpans, projectTracerBeam,
  TRACER_CORE_COLOR, TRACER_DEFAULT_COLOR,
} from './tracer.js';

function testPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = (i * 5) & 255;
    pal[i * 3 + 1] = (i * 3 + 40) & 255;
    pal[i * 3 + 2] = (i * 2 + 80) & 255;
  }
  return pal;
}

function rampTexels(): Uint8Array {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = i;
  return t;
}

function particleMat(pal: Uint8Array): RGBMaterial {
  return buildRGBMaterial(rampTexels(), 256, 1, pal, null, {
    addressS: 'clamp', addressT: 'clamp',
    overbright: false, lodBias: 0, mipDither: false,
    bilinear: false, zbits: 16, blend: 'opaque',
    depthWrite: true, opaqueMask: true,
  });
}

function beamMat(pal: Uint8Array): RGBMaterial {
  return buildRGBMaterial(rampTexels(), 256, 1, pal, null, {
    addressS: 'clamp', addressT: 'clamp',
    overbright: false, lodBias: 0, mipDither: false,
    bilinear: false, zbits: 16, blend: 'additive',
    depthWrite: true, opaqueMask: true,
  });
}

function mkPlanes(W: number, H: number): {
  q: Uint16Array; cover: Uint8Array; depth: Uint16Array;
} {
  return {
    q: new Uint16Array(W * H),
    cover: new Uint8Array(W * H),
    depth: new Uint16Array(W * H).fill(0xffff),
  };
}

function seedPlanes(
  p: { q: Uint16Array; cover: Uint8Array; depth: Uint16Array }, v: number,
): void {
  p.q.fill(v);
}

function snapPlanes(p: { q: Uint16Array; cover: Uint8Array; depth: Uint16Array }): string {
  let h = 2166136261;
  const mix = (v: number): void => { h ^= v & 0xffff; h = Math.imul(h, 16777619); };
  for (let i = 0; i < p.q.length; i++) { mix(p.q[i]!); mix(p.cover[i]!); mix(p.depth[i]!); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function testCam() {
  return setupCamera(DEVROOM_CAMERA.origin, DEVROOM_CAMERA.angles, DEVROOM_CAMERA.fovX, 96, 72);
}

const WIN = { near: 4, far: 32768 };

describe('particle spans equal direct point draws', () => {
  it('devroom-like particle set: emitted spans match drawParticlesRGB exactly', () => {
    const W = 96, H = 72;
    const pal = testPalette();
    const cam = testCam();
    const origins = new Float32Array([
      60, 40, 130, 66, 44, 136, 54, 36, 142, 63, 47, 124, 57, 33, 133, 70, 38, 145,
    ]);
    const colors = new Uint8Array([250, 248, 246, 244, 242, 240]);
    const pool: ScreenParticle[] = [];
    const n = projectParticles(
      origins, colors, 6, cam.origin, cam.forward, cam.right, cam.up,
      cam.xCenter, cam.yCenter, cam.focalX, cam.focalY, cam.near, pool);
    expect(n).toBeGreaterThan(0);
    const a = mkPlanes(W, H);
    seedPlanes(a, 0x8410);
    const da = drawParticlesRGB(a.q, a.cover, a.depth, W, H, pool, 0, n, pal, WIN, 16);
    expect(da).toBeGreaterThan(0);
    const spans: SpanList = { spans: [], count: 0 };
    const ne = emitParticleSpans(pool, 0, n, W, H, spans, 1024);
    expect(ne).toBe(n);
    const b = mkPlanes(W, H);
    seedPlanes(b, 0x8410);
    const mat = particleMat(pal);
    const db = drawSpansRGB(b.q, b.cover, b.depth, W, H, spans, mat, WIN);
    // Span tallies count coverage, not passes (a same-pixel tie still
    // processes its span); the planes prove the tie resolved identically.
    expect(db.spans).toBe(ne);
    expect(snapPlanes(b)).toBe(snapPlanes(a));
  });

  it('fuzzed particles incl. off-screen and ties match', () => {
    const pal = testPalette();
    const mat = particleMat(pal);
    let seed = 12345;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (const [W, H] of [[64, 48], [61, 45], [33, 17]] as const) {
      const cam = setupCamera(new Float32Array([0, 0, 64]), new Float32Array([0, 0, 0]), 90, W, H);
      const pool: ScreenParticle[] = [];
      for (let i = 0; i < 40; i++) {
        pool.push({
          x: Math.floor(rnd() * (W + 8)) - 4,
          y: Math.floor(rnd() * (H + 8)) - 4,
          iz: 0.05 + rnd() * 0.2,
          color: Math.floor(rnd() * 256),
        });
      }
      const a = mkPlanes(W, H);
      seedPlanes(a, 0x1234);
      drawParticlesRGB(a.q, a.cover, a.depth, W, H, pool, 0, pool.length, pal, WIN, 16);
      const spans: SpanList = { spans: [], count: 0 };
      emitParticleSpans(pool, 0, pool.length, W, H, spans, 1024);
      const b = mkPlanes(W, H);
      seedPlanes(b, 0x1234);
      drawSpansRGB(b.q, b.cover, b.depth, W, H, spans, mat, WIN);
      expect(snapPlanes(b)).toBe(snapPlanes(a));
    }
  });
});

describe('tracer spans equal direct DDA draws', () => {
  function checkBeam(
    W: number, H: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    color: number, core: number, seedQ: number,
  ): void {
    const pal = testPalette();
    const cam = setupCamera(new Float32Array([0, 0, 64]), new Float32Array([0, 0, 0]), 90, W, H);
    const a = mkPlanes(W, H);
    seedPlanes(a, seedQ);
    const da = drawTracerBeamRGB(a.q, a.cover, a.depth, W, H, cam,
      ax, ay, az, bx, by, bz, color, pal, core, WIN, 16);
    const proj = projectTracerBeam(cam, ax, ay, az, bx, by, bz, color, core);
    const spans: SpanList = { spans: [], count: 0 };
    const ne = proj ? emitTracerSpans(proj, W, H, spans, 4096) : 0;
    const b = mkPlanes(W, H);
    seedPlanes(b, seedQ);
    const mat = beamMat(pal);
    const db = drawSpansRGB(b.q, b.cover, b.depth, W, H, spans, mat, WIN);
    if (da === 0) {
      expect(ne).toBe(0);
      expect(db.pixels).toBe(0);
    } else {
      expect(ne).toBeGreaterThan(0);
      // Span tallies count coverage, not passes; the planes prove ties
      // resolved identically (a revisited pixel still processes its span).
      expect(db.spans).toBe(ne);
    }
    expect(snapPlanes(b)).toBe(snapPlanes(a));
  }

  it('axis beams, diagonals, sub-pixel, near-clip and off-screen match', () => {
    const W = 96, H = 72;
    const cases: [number, number, number, number, number, number, number, number, number][] = [
      [1, 0, 0, 30, 5, 2, TRACER_DEFAULT_COLOR, TRACER_CORE_COLOR, 0x8410],
      [0, 0, 0, -20, -10, 5, 200, 215, 0x0000],
      [5, 5, 5, 6, 6, 6, 100, 150, 0xffff],
      [0, 0, 3.9, 10, 10, 30, 225, 215, 0x1234],
      [0, 0, 100, 200, -200, 100, 225, 215, 0x8410],
      [-50, -50, 20, 50, 50, 20, 30, 40, 0x0000],
      [10, 20, 30, 10, 20, 30, 225, 215, 0x8410],
    ];
    for (const [ax, ay, az, bx, by, bz, c, co, sq] of cases) {
      checkBeam(W, H, ax, ay, az, bx, by, bz, c, co, sq);
    }
  });

  it('fuzzed beams incl. odd dims match', () => {
    let seed = 987654321;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (const [W, H] of [[64, 48], [61, 45], [33, 17]] as const) {
      for (let i = 0; i < 25; i++) {
        const ax = rnd() * 120 - 60, ay = rnd() * 120 - 60, az = rnd() * 120 - 20;
        const bx = rnd() * 120 - 60, by = rnd() * 120 - 60, bz = rnd() * 120 - 20;
        checkBeam(W, H, ax, ay, az, bx, by, bz,
          Math.floor(rnd() * 256), Math.floor(rnd() * 256), 0x1234);
      }
    }
  });

  it('createSpan pool reuse: emission is allocation-free across calls', () => {
    const spans: SpanList = { spans: [], count: 0 };
    const cam = testCam();
    const proj = projectTracerBeam(cam, 1, 0, 0, 30, 5, 2, 225, 215);
    expect(proj).not.toBeNull();
    const n1 = emitTracerSpans(proj!, 96, 72, spans, 4096);
    const allocated = spans.spans.length;
    const n2 = emitTracerSpans(proj!, 96, 72, spans, 4096);
    expect(n1).toBe(n2);
    expect(spans.spans.length).toBe(allocated);
  });
});
