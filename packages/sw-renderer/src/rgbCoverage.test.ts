// astra step 3: full RGB material coverage (models, viewmodel depth-hack,
// sprites, particles, sky, beams, turbulent water, translucent ordering).
// PERF-FINISH-A item A: the RGB overlay is the production authority, so the
// redundant classic draws underneath are skipped by default — the classic
// index plane is NO LONGER bit-identical with the flag on (only the
// displayed RGB composite is). The cvar-0 oracle path preserves the old
// software identity exactly; these tests pin oracle-vs-software identity
// AND authoritative-vs-oracle display identity.
import { afterEach, describe, expect, it } from 'vitest';
import { createFramebuffer, type Entity } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import {
  SoftwareRenderer, setRGBWorldEnabled, SW_RGB_SKIP_CLASSIC_CVAR,
} from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import { setupCamera } from './camera.js';
import {
  buildANorms, buildShadeDots, createBoxMesh, drawAliasInstanceRGB,
  type AliasMesh,
} from './alias.js';
import {
  SPAN_FLAT, SPAN_OPAQUE, SPAN_TRANS33, SPAN_TRANS66, SPAN_TURBULENT,
  buildRGBMaterial, createSpan, drawSpansRGB,
  windowDepth01, windowDepthQ16, DEFAULT_RGB_FAR, DEFAULT_RGB_NEAR,
  type SpanList,
} from './spans.js';
import { drawParticlesRGB } from './particles.js';
import { drawSpriteRGB } from './sprites.js';
import { drawTracerBeamRGB } from './tracer.js';
import type { MiniSurf, MiniWorld } from './worldNodes.js';

afterEach(() => {
  setRGBWorldEnabled(false);
  resetCVars();
});

function grayPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = i;
    pal[i * 3 + 1] = i;
    pal[i * 3 + 2] = i;
  }
  return pal;
}

function fnv(idx: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < idx.length; i++) {
    h ^= idx[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
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

/** Fresh 565 authority planes (depth cleared to all-ones = far). */
function mkPlanes(n: number): { q: Uint16Array; cover: Uint8Array; depth: Uint16Array } {
  return { q: new Uint16Array(n), cover: new Uint8Array(n), depth: new Uint16Array(n).fill(0xffff) };
}

/** Expand one stored 565 quantum to 8:8:8 (matches the endFrame resolve). */
function expandQ(q: Uint16Array, i: number): [number, number, number] {
  const v = q[i]!;
  const r5 = (v >> 11) & 31, g6 = (v >> 5) & 63, b5 = v & 31;
  return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)];
}

/** 1x2 run: constant u/v/depth, no lightmap (lv < 0). */
function flatSpan(u: number, kind = SPAN_OPAQUE): ReturnType<typeof createSpan> {
  const s = createSpan();
  s.kind = kind;
  s.y = 0; s.x0 = 0; s.x1 = 2;
  s.iz = 1; s.diz = 0;
  s.uz = u; s.duz = 0;
  s.vz = 0; s.dvz = 0;
  s.light = 40; s.dlight = 0;
  s.lu = 0; s.lv = -1; s.dlu = 0;
  s.ord = 0;
  return s;
}

describe('transparent texels (index 255)', () => {
  it('opaque spans skip 255 holes: no color, no depth, no cover', () => {
    const pal = grayPalette();
    const texels = new Uint8Array([10, 255]);
    const mat = buildRGBMaterial(texels, 2, 1, pal, null,
      { overbright: false, lodBias: 0, mipDither: false });
    // u = 1 lands on the 255 texel
    const pl = mkPlanes(2);
    const list: SpanList = { spans: [flatSpan(1)], count: 1 };
    const r = drawSpansRGB(pl.q, pl.cover, pl.depth, 2, 1, list, mat);
    expect(r.spans).toBe(1);
    expect([...pl.cover]).toEqual([0, 0]);
    expect(pl.depth[0]).toBe(0xffff);
    expect(pl.depth[1]).toBe(0xffff);
    // u = 0 lands on texel 10 -> drawn with the palette color, depth written
    const pl2 = mkPlanes(2);
    const list2: SpanList = { spans: [flatSpan(0)], count: 1 };
    drawSpansRGB(pl2.q, pl2.cover, pl2.depth, 2, 1, list2, mat);
    expect([...pl2.cover]).toEqual([1, 1]);
    expect(pl2.depth[0]).not.toBe(0xffff);
    // 8-bit 10 quantises to 8 through RGB565 (10>>3=1 -> 8)
    expect(expandQ(pl2.q, 0)).toEqual([8, 8, 8]);
  });

  it('translucent spans skip 255 holes too (no blended fringe, no depth)', () => {
    const pal = grayPalette();
    const mat = buildRGBMaterial(new Uint8Array([10, 255]), 2, 1, pal, null,
      { blend: 'alpha', alpha: 0.5, overbright: false, lodBias: 0, mipDither: false });
    const pl = mkPlanes(2);
    pl.q[0] = 0x4242; pl.q[1] = 0x4242;
    const list: SpanList = { spans: [flatSpan(1, SPAN_TRANS33)], count: 1 };
    drawSpansRGB(pl.q, pl.cover, pl.depth, 2, 1, list, mat);
    expect([...pl.cover]).toEqual([0, 0]);
    expect(pl.depth[0]).toBe(0xffff);
    expect(pl.q[0]).toBe(0x4242);
  });
});

describe('alpha ordering + blend ratios', () => {
  // 8-bit (50,50,50) background, stored + blended as RGB565: (49,48,49)
  const BG565 = (((50 >> 3) << 11) | ((50 >> 2) << 5) | (50 >> 3)) & 0xffff;

  function coloredMats(): { red: ReturnType<typeof buildRGBMaterial>; blue: ReturnType<typeof buildRGBMaterial> } {
    const pal = new Uint8Array(768);
    pal[1 * 3] = 200; pal[1 * 3 + 1] = 10; pal[1 * 3 + 2] = 10;
    pal[2 * 3] = 10; pal[2 * 3 + 1] = 10; pal[2 * 3 + 2] = 200;
    const opts = { blend: 'alpha' as const, alpha: 0.5, overbright: false, lodBias: 0, mipDither: false };
    return {
      red: buildRGBMaterial(new Uint8Array([1]), 1, 1, pal, null, opts),
      blue: buildRGBMaterial(new Uint8Array([2]), 1, 1, pal, null, opts),
    };
  }

  function drawOne(mat: ReturnType<typeof buildRGBMaterial>, q: Uint16Array, depth: Uint16Array): void {
    const cover = new Uint8Array(1);
    drawSpansRGB(q, cover, depth, 1, 1, { spans: [flatSpan(0)], count: 1 }, mat);
  }

  it('back-to-front over-blend matches the manual composite exactly', () => {
    const { red, blue } = coloredMats();
    // each draw takes a fresh cleared depth plane (same near iz), like the
    // old test; only the 565 color plane carries over
    const q = new Uint16Array([BG565]);
    drawOne(red, q, new Uint16Array([0xffff]));   // far: red 0.5 over bg
    drawOne(blue, q, new Uint16Array([0xffff]));  // near: blue 0.5 over that
    // red over bg565 (49,48,49): (125,29,30) -> 565 -> (123,28,24);
    // blue over that: (67,19,112) -> 565 -> (66,16,115)
    expect(expandQ(q, 0)).toEqual([66, 16, 115]);
  });

  it('reversed draw order gives a different (wrong-order) result', () => {
    const { red, blue } = coloredMats();
    const q = new Uint16Array([BG565]);
    drawOne(blue, q, new Uint16Array([0xffff]));
    drawOne(red, q, new Uint16Array([0xffff]));
    // blue over bg first, then red: (112,19,67) -> 565 -> (115,16,66)
    expect(expandQ(q, 0)).toEqual([115, 16, 66]);
  });

  it('TRANS66 uses the 66 ratio and never writes depth', () => {
    const pal = new Uint8Array(768);
    pal[1 * 3] = 200; pal[1 * 3 + 1] = 10; pal[1 * 3 + 2] = 10;
    const mat = buildRGBMaterial(new Uint8Array([1]), 1, 1, pal, null,
      { blend: 'opaque', overbright: false, lodBias: 0, mipDither: false });
    const q = new Uint16Array([BG565]);
    const cover = new Uint8Array(1);
    const depth = new Uint16Array([0xffff]);
    drawSpansRGB(q, cover, depth, 1, 1, { spans: [flatSpan(0, SPAN_TRANS66)], count: 1 }, mat);
    expect([...cover]).toEqual([1]);
    expect(depth[0]).toBe(0xffff);
    // 169/256 over bg565 (49,48,49): (149,23,23) -> 565 -> (148,20,16)
    expect(expandQ(q, 0)).toEqual([148, 20, 16]);
  });
});

describe('flat spans + unsupported combos', () => {
  it('SPAN_FLAT fills the solid color and writes depth', () => {
    const pal = grayPalette();
    const mat = buildRGBMaterial(new Uint8Array([0]), 1, 1, pal, null,
      { flatColor: new Uint8Array([10, 20, 30]) });
    const pl = mkPlanes(2);
    drawSpansRGB(pl.q, pl.cover, pl.depth, 2, 1, { spans: [flatSpan(0, SPAN_FLAT)], count: 1 }, mat);
    expect([...pl.cover]).toEqual([1, 1]);
    // iz = 1 is nearer than the default window near (4): depth01 clamps to
    // 0 (nearest quantum), written on the pass
    expect(pl.depth[0]).toBe(0);
    // (10,20,30) -> 565 (r5=1,g6=5,b5=3) -> (8,20,24)
    expect(expandQ(pl.q, 0)).toEqual([8, 20, 24]);
  });

  it('FLAT without flatColor Com_Errors (never silent wrong pixels)', () => {
    const pal = grayPalette();
    const mat = buildRGBMaterial(new Uint8Array([7]), 1, 1, pal, null, {});
    const pl = mkPlanes(1);
    expect(() => drawSpansRGB(pl.q, pl.cover, pl.depth, 1, 1,
      { spans: [flatSpan(0, SPAN_FLAT)], count: 1 }, mat)).toThrow();
  });

  it('unknown span kind Com_Errors', () => {
    const pal = grayPalette();
    const mat = buildRGBMaterial(new Uint8Array([7]), 1, 1, pal, null, {});
    const s = flatSpan(0);
    s.kind = 99;
    const pl = mkPlanes(1);
    expect(() => drawSpansRGB(pl.q, pl.cover, pl.depth, 1, 1,
      { spans: [s], count: 1 }, mat)).toThrow();
  });
});

/** Two-tris mesh (both windings — one always front-faces) at x = 100. */
function triMesh(): AliasMesh {
  const frames = new Float32Array([
    100, -40, -40, 100, 40, -40, 100, 0, 40,
    100, -40, -40, 100, 0, 40, 100, 40, -40,
  ]);
  return {
    frames,
    normals: new Uint8Array(6),
    numVerts: 6,
    numFrames: 1,
    tris: new Uint16Array([0, 1, 2, 3, 4, 5]),
    numTris: 2,
    st: new Float32Array([0, 0, 32, 0, 16, 32, 0, 0, 16, 32, 32, 0]),
  };
}

function graySkin(): { texels: Uint8Array; width: number; height: number } {
  return { texels: new Uint8Array(32 * 32).fill(100), width: 32, height: 32 };
}

describe('alias RGB: viewmodel depth-hack + colored lights', () => {
  const anorms = buildANorms();
  const dots = buildShadeDots(anorms);

  function renderTri(opts: {
    depthScale?: number; dlights?: { origin: Float32Array; intensity: number; color: Float32Array }[] | null;
    wallIz?: number;
  }): { cover: Uint8Array; q: Uint16Array; depth: Uint16Array } {
    const W = 64, H = 64;
    const cam = setupCamera(
      new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90, W, H);
    const pal = grayPalette();
    const skin = graySkin();
    const mat = buildRGBMaterial(skin.texels, skin.width, skin.height, pal, null,
      { addressS: 'clamp', addressT: 'clamp', overbright: false, lodBias: 0, mipDither: false });
    // wall pre-fill as a window-Z quantum (mat.zbits 0 = full-precision
    // float compare path, stored rounded to 16 bits like the filler does)
    const wallIz = opts.wallIz ?? 0;
    const wallQ = wallIz > 0
      ? Math.round(windowDepth01(wallIz, cam.near, cam.far) * 65535) & 0xffff
      : 0xffff;
    const pl = mkPlanes(W * H);
    if (wallIz > 0) pl.depth.fill(wallQ);
    drawAliasInstanceRGB(pl.q, pl.cover, pl.depth, W, H, {
      mesh: triMesh(),
      origin: new Float32Array([0, 0, 0]),
      angles: new Float32Array([0, 0, 0]),
      frameA: 0, frameB: 0, lerp: 0, lightAngle: 0,
      depthScale: opts.depthScale ?? 1,
    }, mat, cam, anorms, dots, opts.dlights ?? null, { near: cam.near, far: cam.far });
    return { cover: pl.cover, q: pl.q, depth: pl.depth };
  }

  it('depth-hack scale wins vs a nearer wall (viewmodel semantics)', () => {
    // wall at 1/z = 0.02 (50 units); tri at 100 units (iz = 0.01)
    const plain = renderTri({ wallIz: 0.02, depthScale: 1 });
    expect(plain.cover.reduce((a, b) => a + b, 0)).toBe(0);
    const hacked = renderTri({ wallIz: 0.02, depthScale: 3 });
    const n = hacked.cover.reduce((a, b) => a + b, 0);
    expect(n).toBeGreaterThan(100);
    // stored depth is the window-Z quantum of the SCALED 1/z (like the
    // classic depthScale path, mapped through the projection window)
    let scaled = -1;
    for (let i = 0; i < hacked.depth.length; i++) {
      if (hacked.cover[i] === 1) { scaled = hacked.depth[i]!; break; }
    }
    const cam = setupCamera(new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90, 64, 64);
    const wantQ = windowDepthQ16(windowDepth01(0.01 * 3, cam.near, cam.far), 0);
    expect(scaled).toBe(wantQ);
  });

  it('red/blue dynamic lights keep hues on the model', () => {
    const red = renderTri({
      dlights: [{ origin: new Float32Array([100, 0, 0]), intensity: 200, color: new Float32Array([1, 0, 0]) }],
    });
    let rn = 0;
    for (let i = 0; i < red.cover.length; i++) {
      if (red.cover[i] !== 1) continue;
      const [r, g, b] = expandQ(red.q, i);
      expect(r).toBeGreaterThan(g + 40);
      expect(r).toBeGreaterThan(b + 40);
      rn++;
    }
    expect(rn).toBeGreaterThan(100);
    const blue = renderTri({
      dlights: [{ origin: new Float32Array([100, 0, 0]), intensity: 200, color: new Float32Array([0, 0, 1]) }],
    });
    let bn = 0;
    for (let i = 0; i < blue.cover.length; i++) {
      if (blue.cover[i] !== 1) continue;
      const [r, g, b] = expandQ(blue.q, i);
      expect(b).toBeGreaterThan(r + 40);
      expect(b).toBeGreaterThan(g + 40);
      bn++;
    }
    expect(bn).toBeGreaterThan(100);
  });

  it('unlit model pixels are achromatic (no hue shift without dynamics)', () => {
    const lit = renderTri({});
    let n = 0;
    for (let i = 0; i < lit.cover.length; i++) {
      if (lit.cover[i] !== 1) continue;
      const [r, g, b] = expandQ(lit.q, i);
      // 565 grey ramps expand achromatically up to the 5/6-bit rounding:
      // r/b (5-bit) expand identically, g (6-bit) stays within 4
      expect(r).toBe(b);
      expect(Math.abs(g - r)).toBeLessThanOrEqual(4);
      n++;
    }
    expect(n).toBeGreaterThan(100);
  });
});

describe('sprite / particle / beam RGB', () => {
  it('sprite draws the billboard, skips the 255 hole', () => {
    const W = 32, H = 32;
    const cam = setupCamera(
      new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90, W, H);
    const pal = grayPalette();
    const texels = new Uint8Array(4 * 4).fill(7);
    texels[2 * 4 + 2] = 255;
    const mat = buildRGBMaterial(texels, 4, 4, pal, null,
      { addressS: 'clamp', addressT: 'clamp', overbright: false, lodBias: 0, mipDither: false });
    const pl = mkPlanes(W * H);
    const n = drawSpriteRGB(pl.q, pl.cover, pl.depth, W, H,
      { origin: new Float32Array([20, 0, 0]), width: 8, height: 8, texId: 0, grade: 60 },
      [{ width: 4, height: 4, texels }], mat, cam, { spans: [], count: 0 }, 1024);
    expect(n).toBeGreaterThan(0);
    const total = pl.cover.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    // billboard bbox is fully spanned, so a hole must leave zeros inside it
    let minX = W, maxX = -1, minY = H, maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (pl.depth[y * W + x]! !== 0xffff) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const area = (maxX - minX + 1) * (maxY - minY + 1);
    expect(total).toBeLessThan(area);
  });

  it('particles expand the palette and depth-test', () => {
    const W = 8, H = 8;
    const pal = grayPalette();
    const pl = mkPlanes(W * H);
    const n = drawParticlesRGB(pl.q, pl.cover, pl.depth, W, H,
      [{ x: 3, y: 4, iz: 0.5, color: 200 }], 0, 1, pal);
    expect(n).toBe(1);
    expect(pl.cover[4 * W + 3]).toBe(1);
    // window-Z quantum of iz = 0.5 under the default 4..4096 window
    expect(pl.depth[4 * W + 3]).toBe(
      windowDepthQ16(windowDepth01(0.5, DEFAULT_RGB_NEAR, DEFAULT_RGB_FAR), 16));
    // 8-bit 200 quantises to 206 through RGB565 (200>>3=25 -> 206)
    expect(expandQ(pl.q, 4 * W + 3)[0]).toBe(206);
    // farther fragment (smaller iz -> larger window-Z) -> skipped
    const n2 = drawParticlesRGB(pl.q, pl.cover, pl.depth, W, H,
      [{ x: 3, y: 4, iz: 0.25, color: 100 }], 0, 1, pal);
    expect(n2).toBe(0);
    expect(expandQ(pl.q, 4 * W + 3)[0]).toBe(206);
  });

  it('beams add onto the plane, depth-tested', () => {
    const W = 64, H = 64;
    const cam = setupCamera(
      new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90, W, H);
    const pal = grayPalette();
    const pl = mkPlanes(W * H);
    const n = drawTracerBeamRGB(pl.q, pl.cover, pl.depth, W, H, cam,
      10, -5, 0, 10, 5, 0, 200, pal);
    expect(n).toBeGreaterThan(0);
    expect(pl.cover.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    // fully behind the near plane -> nothing
    const pl2 = mkPlanes(W * H);
    const n2 = drawTracerBeamRGB(pl2.q, pl2.cover, pl2.depth, W, H, cam,
      1, 0, 0, 2, 0, 0, 200, pal);
    expect(n2).toBe(0);
    expect(pl2.cover.reduce((a, b) => a + b, 0)).toBe(0);
  });
});

/** One quad facing -X (normal -1,0,0), 64x64 texel space, 4x4 luxels. */
function facingQuad(opts: { turbulent?: boolean; sky?: boolean; translucent?: number }): MiniSurf {
  const verts = new Float32Array([50, -32, 32, 50, 32, 32, 50, 32, 96, 50, -32, 96]);
  const bb = {
    mins: new Float32Array([50, -32, 32]),
    maxs: new Float32Array([50, 32, 96]),
    center: new Float32Array([50, 0, 64]),
  };
  return {
    id: 0,
    verts,
    uvs: new Float32Array([0, 0, 64, 0, 64, 64, 0, 64]),
    lux: new Float32Array([0, 0, 4, 0, 4, 4, 0, 4]),
    n: 4,
    texId: 0,
    lightId: 0,
    center: bb.center,
    radius: 64,
    mins: bb.mins,
    maxs: bb.maxs,
    turbulent: opts.turbulent ?? false,
    sky: opts.sky ?? false,
    translucent: opts.translucent,
    fn: new Float32Array([-1, 0, 0]),
  };
}

function singleQuadWorld(surf: MiniSurf): MiniWorld {
  const texels = new Uint8Array(64 * 64);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) texels[y * 64 + x] = ((x >> 3) + (y >> 3)) & 1 ? 60 : 120;
  }
  const samples = new Uint8Array(4 * 4 * 3).fill(180);
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 1 }],
    pvs: [new Uint8Array([1])],
    clusterCount: 1,
    surfaces: [surf],
    textures: [{ texels, width: 64, height: 64 }],
    lightmaps: [{ samples, luxW: 4, luxH: 4, styles: [0] }],
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
}

function quadView(time = 0): {
  origin: Float32Array; angles: Float32Array; fovX: number; time: number; lightStyles: Float32Array;
} {
  return {
    origin: new Float32Array([0, 0, 64]),
    angles: new Float32Array([0, 0, 0]),
    fovX: 90,
    time,
    lightStyles: new Float32Array(256).fill(1),
  };
}

describe('frame-level RGB: water, sky, software identity', () => {
  function renderAll(world: MiniWorld, W: number, H: number, rgb: boolean, pal: Uint8Array, skip = true): {
    idxHash: string; colorHash: string; coverPixels: number; used: boolean;
    classicSpansSkipped: number; classicFgSkipped: number;
  } {
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(pal);
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, skip ? 1 : 0);
    setRGBWorldEnabled(rgb);
    r.beginFrame();
    r.renderView(quadView(), { name: 'quad', data: world }, []);
    r.endFrame();
    const st = r.testRGBStats();
    const sk = r.testClassicSkipStats();
    const live = r.getFramebuffer();
    return {
      idxHash: fnv(fb.index!),
      colorHash: fnv(new Uint8Array(live.color.buffer, live.color.byteOffset, W * H * 4)),
      coverPixels: st.coverPixels, used: st.used,
      classicSpansSkipped: sk.classicSpansSkipped, classicFgSkipped: sk.classicFgSkipped,
    };
  }

  it('turbulent water draws warped RGB; oracle keeps software identity, authoritative keeps display identity', () => {
    const pal = testPalette();
    const world = singleQuadWorld(facingQuad({ turbulent: true }));
    const off = renderAll(world, 160, 120, false, pal);
    const oracle = renderAll(world, 160, 120, true, pal, false);
    const on = renderAll(world, 160, 120, true, pal);
    // Oracle (cvar 0): classic draws underneath, software identity holds.
    expect(oracle.used).toBe(true);
    expect(oracle.idxHash).toBe(off.idxHash);
    expect(oracle.classicSpansSkipped).toBe(0);
    // Authoritative (default): display-identical, classic work eliminated.
    expect(on.used).toBe(true);
    expect(on.coverPixels).toBeGreaterThan(1000);
    expect(on.colorHash).toBe(oracle.colorHash);
    expect(on.classicSpansSkipped).toBeGreaterThan(0);
  });

  it('glass draws blended RGB (no stipple); oracle keeps software identity, authoritative keeps display identity', () => {
    const pal = testPalette();
    const world = singleQuadWorld(facingQuad({ translucent: 2 }));
    const off = renderAll(world, 160, 120, false, pal);
    const oracle = renderAll(world, 160, 120, true, pal, false);
    const on = renderAll(world, 160, 120, true, pal);
    expect(oracle.used).toBe(true);
    expect(oracle.idxHash).toBe(off.idxHash);
    expect(on.used).toBe(true);
    expect(on.coverPixels).toBeGreaterThan(1000);
    expect(on.colorHash).toBe(oracle.colorHash);
    expect(on.classicSpansSkipped).toBeGreaterThan(0);
  });

  it('textured skybox draws clamped RGB; oracle keeps software identity, authoritative keeps display identity', () => {
    const pal = testPalette();
    const world = singleQuadWorld(facingQuad({ sky: true }));
    const W = 160, H = 120;
    // valid packed strip: 64 wide, 6 x 64 tiles
    const sky = { texels: new Uint8Array(64 * 384).fill(77), width: 64, height: 384 };
    const run = (rgb: boolean, skip: boolean): { idxHash: string; colorHash: string; coverPixels: number; classicSpansSkipped: number } => {
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(pal);
      r.setSkyTexture(sky);
      setCVar(SW_RGB_SKIP_CLASSIC_CVAR, skip ? 1 : 0);
      setRGBWorldEnabled(rgb);
      r.beginFrame();
      r.renderView(quadView(), { name: 'skyquad', data: world }, []);
      r.endFrame();
      const live = r.getFramebuffer();
      return {
        idxHash: fnv(fb.index!),
        colorHash: fnv(new Uint8Array(live.color.buffer, live.color.byteOffset, W * H * 4)),
        coverPixels: r.testRGBStats().coverPixels,
        classicSpansSkipped: r.testClassicSkipStats().classicSpansSkipped,
      };
    };
    const off = run(false, true);
    const oracle = run(true, false);
    const on = run(true, true);
    expect(oracle.idxHash).toBe(off.idxHash);
    expect(on.coverPixels).toBeGreaterThan(1000);
    expect(on.colorHash).toBe(oracle.colorHash);
    expect(on.classicSpansSkipped).toBeGreaterThan(0);
  });

  it('devroom: oracle index plane matches software; authoritative RGB matches oracle display', () => {
    const pal = testPalette();
    const styles = new Float32Array(256).fill(1);
    const run = (rgb: boolean, skip: boolean): { idx: string; color: string } => {
      const fb = createFramebuffer(160, 120, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(pal);
      setCVar(SW_RGB_SKIP_CLASSIC_CVAR, skip ? 1 : 0);
      setRGBWorldEnabled(rgb);
      r.beginFrame();
      r.renderView(
        { origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles, fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: styles },
        { name: 'devroom', data: createDevroom() },
        [],
      );
      r.endFrame();
      const live = r.getFramebuffer();
      return {
        idx: fnv(fb.index!),
        color: fnv(new Uint8Array(live.color.buffer, live.color.byteOffset, 160 * 120 * 4)),
      };
    };
    const off = run(false, true);
    const oracle = run(true, false);
    const on = run(true, true);
    expect(off.idx).toBeTruthy();
    expect(oracle.idx).toBe(off.idx);
    expect(on.color).toBe(oracle.color);
    expect(on.idx).not.toBe(off.idx);
  });
});

describe('frame-level RGB: filtered explosions (no stipple)', () => {
  function checkerSkin(): { texels: Uint8Array; width: number; height: number } {
    // checker with no 255 (fully opaque mask)
    const t = new Uint8Array(32 * 32);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) t[y * 32 + x] = (((x >> 3) + (y >> 3)) & 1) === 0 ? 60 : 150;
    }
    return { texels: t, width: 32, height: 32 };
  }

  function renderExplosion(rgb: boolean, skip = true): {
    idxHash: string; colorHash: string; coverPixels: number; entityBoxCover: number; entityBoxArea: number;
    classicFgSkipped: number;
  } {
    const W = 160, H = 120;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    const pal = testPalette();
    r.setPalette(pal);
    const model = r.registerModel({ name: 'boom', kind: 'md2', data: createBoxMesh(8) });
    const skinData = checkerSkin();
    const skin = r.registerSkinData('boom', skinData.texels, skinData.width, skinData.height);
    const e: Entity = {
      model,
      origin: new Float32Array([-88, 0, 100]),
      angles: new Float32Array([0, 0, 0]),
      frame: 0,
      skin,
      alpha: 0.5,
    };
    const styles = new Float32Array(256).fill(1);
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, skip ? 1 : 0);
    setRGBWorldEnabled(rgb);
    r.beginFrame();
    r.renderView(
      { origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles, fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: styles },
      { name: 'devroom', data: createDevroom() },
      [e],
    );
    r.endFrame();
    // project the entity center with the same camera to find its screen box
    const cam = setupCamera(DEVROOM_CAMERA.origin, DEVROOM_CAMERA.angles, DEVROOM_CAMERA.fovX, W, H);
    const rx = -88 - cam.origin[0]!, ry = 0 - cam.origin[1]!, rz = 100 - cam.origin[2]!;
    const cx = rx * cam.right[0]! + ry * cam.right[1]! + rz * cam.right[2]!;
    const cy = rx * cam.up[0]! + ry * cam.up[1]! + rz * cam.up[2]!;
    const cz = rx * cam.forward[0]! + ry * cam.forward[1]! + rz * cam.forward[2]!;
    const iz = 1 / cz;
    const px = cam.xCenter + cx * cam.focalX * iz;
    const py = cam.yCenter - cy * cam.focalY * iz;
    // 8-unit half box at ~80 units with focal ~80 -> ~8px half-size; pad it
    const x0 = Math.max(0, Math.floor(px - 7)), x1 = Math.min(W - 1, Math.ceil(px + 7));
    const y0 = Math.max(0, Math.floor(py - 7)), y1 = Math.min(H - 1, Math.ceil(py + 7));
    const st = r.testRGBStats();
    const sk = r.testClassicSkipStats();
    const boxCover = rgb ? r.testRGBBoxCover(x0, y0, x1, y1) : 0;
    const live = r.getFramebuffer();
    return {
      idxHash: fnv(fb.index!),
      colorHash: fnv(new Uint8Array(live.color.buffer, live.color.byteOffset, W * H * 4)),
      coverPixels: st.coverPixels,
      entityBoxCover: boxCover,
      entityBoxArea: (x1 - x0 + 1) * (y1 - y0 + 1),
      classicFgSkipped: sk.classicFgSkipped,
    };
  }

  it('explosion entity: oracle keeps classical visibility, authoritative keeps RGB display', () => {
    // visibility pre-check: the entity changes indexed pixels vs no entity
    const pal = testPalette();
    const styles = new Float32Array(256).fill(1);
    const runBare = (): string => {
      const fb = createFramebuffer(160, 120, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(pal);
      r.beginFrame();
      r.renderView(
        { origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles, fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: styles },
        { name: 'devroom', data: createDevroom() },
        [],
      );
      r.endFrame();
      return fnv(fb.index!);
    };
    const bare = runBare();
    const oracle = renderExplosion(true, false);
    const on = renderExplosion(true);
    const off = renderExplosion(false);
    expect(off.idxHash).not.toBe(bare);
    // Oracle (cvar 0): classic entity draw preserved exactly.
    expect(oracle.idxHash).toBe(off.idxHash);
    expect(oracle.classicFgSkipped).toBe(0);
    // Authoritative (default): display-identical, classic entity draw gone.
    expect(on.colorHash).toBe(oracle.colorHash);
    expect(on.classicFgSkipped).toBeGreaterThan(0);
    expect(on.coverPixels).toBeGreaterThan(1000);
    // dense alpha-blended cover in the entity box: stipple would leave
    // holes (alpha 0.5 keeps ~50%); smooth RGB fills the silhouette.
    expect(on.entityBoxArea).toBeGreaterThan(0);
    expect(on.entityBoxCover / on.entityBoxArea).toBeGreaterThan(0.75);
  });
});
