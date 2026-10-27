// TRANS33/TRANS66 software translucency (r_poly.c R_DrawAlphaSurfaces port).
// Unit: blend index orders vs C (33: alphamap[src + dst*256], 66:
// alphamap[src*256 + dst]), texel-255 skip, no depth write, stipple parity
// lattices, warp equivalence. Integration: deferred alpha pass ordering,
// r_translucency=0 opaque fallback, real-pcx table install.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCVarNumber, resetCVars, setCVar } from '@q2/config';
import { createFramebuffer } from '@q2/renderer-api';
import {
  SPAN_TRANS33, SPAN_TRANS66, TRANSLUCENCY_CVAR, STIPPLE_ALPHA_CVAR,
  createSpan, drawSpansTranslucent,
  translucencyModeFromCvars,
  type Span, type SpanList,
} from './spans.js';
import {
  ALPHAMAP_HEAD, ALPHAMAP_SIZE, COLORMAP_PCX_PIXELS,
  buildAlphamapPair, extractAlphamap33, extractAlphamap66,
} from './colormap.js';
import { SoftwareRenderer } from './frame.js';
import type { MiniWorld } from './worldNodes.js';

/** Grade-ignoring colormap: lit index == texel (isolates blend math). */
function texelColormap(): Uint8Array {
  const c = new Uint8Array(64 * 256);
  for (let g = 0; g < 64; g++) {
    for (let t = 0; t < 256; t++) c[g * 256 + t] = t;
  }
  return c;
}

function flatTex(w: number, h: number, v: number): Uint8Array {
  return new Uint8Array(w * h).fill(v);
}

/** One TRANS span: constant texel, constant depth, constant grade. */
function transSpan(kind: number, y: number, x0: number, x1: number, iz: number): Span {
  const s = createSpan();
  s.kind = kind;
  s.y = y; s.x0 = x0; s.x1 = x1;
  s.iz = iz; s.diz = 0;
  s.uz = 0; s.duz = 0;
  s.vz = 0; s.dvz = 0;
  s.light = 20; s.dlight = 0;
  s.lu = 0; s.lv = -1; s.dlu = 0;
  s.turb = 0;
  s.ord = 0;
  return s;
}

function drawOne(
  kind: number, texel: number, behind: number, zbInit: number,
  alpha33: Uint8Array, alpha66: Uint8Array,
  opts: { y?: number; iz?: number; stipple?: boolean; turb?: Uint8Array | null; time?: number } = {},
): { idx: Uint8Array; zb: Float32Array } {
  const W = 8, H = (opts.y ?? 0) + 1;
  const idx = new Uint8Array(W * H).fill(behind);
  const zb = new Float32Array(W * H).fill(zbInit);
  const list: SpanList = { spans: [transSpan(kind, opts.y ?? 0, 0, W, opts.iz ?? 0.5)], count: 1 };
  const tex = { width: 8, height: 8, texels: flatTex(8, 8, texel) };
  const light = { width: 1, height: 1, values: new Uint8Array([63]) };
  drawSpansTranslucent(idx, zb, W, H, list, tex, light, texelColormap(),
    alpha33, alpha66, opts.turb ?? null, opts.time ?? 0, opts.stipple ?? false);
  return { idx: idx.slice((opts.y ?? 0) * W, ((opts.y ?? 0) + 1) * W), zb: zb.slice((opts.y ?? 0) * W, ((opts.y ?? 0) + 1) * W) };
}

describe('translucency blend core (C spanlet orders)', () => {
  it('TRANS33 blends alphamap[src + dst*256] (C R_DrawSpanlet33 order)', () => {
    const a33 = new Uint8Array(65536);
    const a66 = new Uint8Array(65536);
    for (let dst = 0; dst < 256; dst++) {
      for (let src = 0; src < 256; src++) {
        a33[(dst << 8) + src] = (src + dst) & 255;
        a66[(dst << 8) + src] = (src * dst) & 255;
      }
    }
    // texel 30 lit (texel colormap), behind 100, depth wins (0.5 > 0)
    const { idx, zb } = drawOne(SPAN_TRANS33, 30, 100, 0, a33, a66);
    expect([...idx]).toEqual(new Array(8).fill((30 + 100) & 255));
    // no depth write (C blended spanlets never touch the zbuffer)
    expect([...zb]).toEqual(new Array(8).fill(0));
  });

  it('TRANS66 blends alphamap[src*256 + dst] via the transposed table', () => {
    const a33 = new Uint8Array(65536);
    const a66 = new Uint8Array(65536);
    for (let dst = 0; dst < 256; dst++) {
      for (let src = 0; src < 256; src++) {
        a33[(dst << 8) + src] = (src + dst) & 255;
        a66[(dst << 8) + src] = (src * dst) & 255;
      }
    }
    const { idx, zb } = drawOne(SPAN_TRANS66, 30, 100, 0, a33, a66);
    expect([...idx]).toEqual(new Array(8).fill((30 * 100) & 255));
    expect([...zb]).toEqual(new Array(8).fill(0));
  });

  it('texel 255 stays transparent and depth losers keep the background', () => {
    const a = new Uint8Array(65536).fill(7);
    const clear = drawOne(SPAN_TRANS33, 255, 100, 0, a, a);
    expect([...clear.idx]).toEqual(new Array(8).fill(100));
    const lost = drawOne(SPAN_TRANS33, 30, 100, 0.9, a, a);
    expect([...lost.idx]).toEqual(new Array(8).fill(100));
    for (const z of lost.zb) expect(z).toBeCloseTo(0.9, 6);
  });

  it('zero warp table renders exactly like the plain path', () => {
    const a = new Uint8Array(65536);
    for (let i = 0; i < 65536; i++) a[i] = (i * 7 + 3) & 255;
    const plain = drawOne(SPAN_TRANS33, 41, 17, 0, a, a);
    const warped = drawOne(SPAN_TRANS33, 41, 17, 0, a, a, { turb: new Uint8Array(1024), time: 1.5 });
    expect([...warped.idx]).toEqual([...plain.idx]);
  });

  it('stipple33 draws even columns of odd rows only (C parity 0)', () => {
    const a = new Uint8Array(65536);
    const odd = drawOne(SPAN_TRANS33, 44, 100, 0, a, a, { y: 1, stipple: true });
    expect([...odd.idx]).toEqual([44, 100, 44, 100, 44, 100, 44, 100]);
    expect([...odd.zb]).toEqual(new Array(8).fill(0));
    const even = drawOne(SPAN_TRANS33, 44, 100, 0, a, a, { y: 0, stipple: true });
    expect([...even.idx]).toEqual(new Array(8).fill(100));
  });

  it('stipple66 draws all of even rows + even columns of odd rows', () => {
    const a = new Uint8Array(65536);
    const odd = drawOne(SPAN_TRANS66, 44, 100, 0, a, a, { y: 1, stipple: true });
    expect([...odd.idx]).toEqual([44, 100, 44, 100, 44, 100, 44, 100]);
    const even = drawOne(SPAN_TRANS66, 44, 100, 0, a, a, { y: 0, stipple: true });
    expect([...even.idx]).toEqual(new Array(8).fill(44));
    expect([...even.zb]).toEqual(new Array(8).fill(0));
  });
});

describe('alphamap tables (colormap.pcx layout)', () => {
  it('extract pair pins the C index orders', () => {
    const pixels = new Uint8Array(COLORMAP_PCX_PIXELS);
    for (let i = 0; i < COLORMAP_PCX_PIXELS - ALPHAMAP_HEAD; i++) {
      pixels[ALPHAMAP_HEAD + i] = i & 255;
    }
    const t33 = extractAlphamap33(pixels);
    const t66 = extractAlphamap66(pixels);
    // 33: T33[(dst<<8)+src] = file[src + dst*256] (C: alphamap[btemp + dst*256])
    expect(t33[(5 << 8) + 9]).toBe(pixels[ALPHAMAP_HEAD + 9 + 5 * 256]);
    // 66: T66[(dst<<8)+src] = file[src*256 + dst] (C: alphamap[btemp*256 + dst])
    expect(t66[(5 << 8) + 9]).toBe(pixels[ALPHAMAP_HEAD + 9 * 256 + 5]);
    expect(t66[(200 << 8) + 7]).toBe(pixels[ALPHAMAP_HEAD + 7 * 256 + 200]);
  });

  it('procedural pair blends toward the source at 0.30 / 0.60', () => {
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = i; pal[i * 3 + 1] = i; pal[i * 3 + 2] = i;
    }
    const { a33, a66 } = buildAlphamapPair(pal);
    // greyscale palette is exact: nearest(0.3*200 + 0.7*100) = 130
    expect(a33[(100 << 8) + 200]).toBe(130);
    expect(a66[(100 << 8) + 200]).toBe(160);
    expect(a33.length).toBe(ALPHAMAP_SIZE);
  });
});

describe('cvar gating', () => {
  beforeEach(() => resetCVars());
  afterEach(() => resetCVars());

  it('default is blend (1); r_translucency=0 disables; sw_stipplealpha=1 stipples', () => {
    expect(translucencyModeFromCvars()).toBe(1);
    expect(getCVarNumber(TRANSLUCENCY_CVAR)).toBe(1);
    setCVar(TRANSLUCENCY_CVAR, 0);
    expect(translucencyModeFromCvars()).toBe(0);
    setCVar(TRANSLUCENCY_CVAR, 1);
    setCVar(STIPPLE_ALPHA_CVAR, 1);
    expect(translucencyModeFromCvars()).toBe(2);
  });
});

/** Two quads: opaque backdrop at x=100, glass at x=50 (both face -X). */
function twoQuadWorld(warpedGlass = false): MiniWorld {
  const quad = (
    id: number, x: number, texId: number, lightId: number,
    translucent: number, turbulent: boolean,
  ) => ({
    id,
    verts: new Float32Array([x, -32, -8, x, 32, -8, x, 32, 8, x, -32, 8]),
    uvs: new Float32Array([0, 0, 32, 0, 32, 16, 0, 16]),
    lux: new Float32Array([0, 0, 4, 0, 4, 1, 0, 1]),
    n: 4, texId, lightId,
    center: new Float32Array([x, 0, 0]), radius: 40,
    mins: new Float32Array([x, -32, -8]), maxs: new Float32Array([x, 32, 8]),
    turbulent, sky: false, translucent,
    fn: new Float32Array([-1, 0, 0]),
  });
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 2 }],
    pvs: [new Uint8Array([1])],
    clusterCount: 1,
    surfaces: [
      quad(0, 100, 0, 0, 0, false),
      quad(1, 50, 1, 1, warpedGlass ? 2 : 1, warpedGlass),
    ],
    textures: [
      { texels: new Uint8Array(32 * 16).fill(90), width: 32, height: 16 },
      { texels: new Uint8Array(32 * 16).fill(200), width: 32, height: 16 },
    ],
    lightmaps: [
      { samples: new Uint8Array(4 * 1 * 3).fill(200), luxW: 4, luxH: 1, styles: [0] },
      { samples: new Uint8Array(4 * 1 * 3).fill(200), luxW: 4, luxH: 1, styles: [0] },
    ],
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
}

function greyPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = i; pal[i * 3 + 1] = i; pal[i * 3 + 2] = i;
  }
  return pal;
}

function renderWorld(world: MiniWorld): Uint8Array {
  const fb = createFramebuffer(160, 120, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(greyPalette());
  const view = {
    origin: new Float32Array([0, 0, 0]), angles: new Float32Array([0, 0, 0]),
    fovX: 90, time: 0, lightStyles: new Float32Array(256).fill(1),
  };
  r.beginFrame();
  r.renderView(view, { name: 'glass', data: world }, []);
  r.endFrame();
  return fb.index!;
}

function countNonZero(arr: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] !== 0) n++;
  return n;
}

describe('deferred alpha pass (renderView integration)', () => {
  beforeEach(() => resetCVars());
  afterEach(() => resetCVars());

  it('glass blends over the backdrop (mode 1 differs from opaque fallback)', () => {
    const world = twoQuadWorld();
    const blended = renderWorld(world);
    setCVar(TRANSLUCENCY_CVAR, 0);
    const opaque = renderWorld(world);
    expect([...blended]).not.toEqual([...opaque]);
    // opaque fallback == the same geometry built fully opaque
    const allOpaque = twoQuadWorld();
    allOpaque.surfaces[1]!.translucent = 0;
    const reference = renderWorld(allOpaque);
    expect([...opaque]).toEqual([...reference]);
  });

  it('translucent draws without depth writes (glass over void)', () => {
    const fb = createFramebuffer(160, 120, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(greyPalette());
    const world = twoQuadWorld();
    world.leafs = [{ cluster: 0, firstSurf: 1, numSurfs: 1 }];
    const view = {
      origin: new Float32Array([0, 0, 0]), angles: new Float32Array([0, 0, 0]),
      fovX: 90, time: 0, lightStyles: new Float32Array(256).fill(1),
    };
    r.beginFrame();
    r.renderView(view, { name: 'glass', data: world }, []);
    const idx = fb.index!, zb = fb.depth;
    let drawn = 0, zbClean = 0;
    for (let i = 0; i < idx.length; i++) {
      if (idx[i] !== 0) {
        drawn++;
        if (zb[i] === 0) zbClean++;
      }
    }
    expect(drawn).toBeGreaterThan(100);
    expect(zbClean).toBe(drawn);
    r.endFrame();
  });

  it('stipple is an exact screen-door: drawn lattice = opaque, gaps = backdrop', () => {
    const world = twoQuadWorld();
    const backOnly = twoQuadWorld();
    backOnly.leafs = [{ cluster: 0, firstSurf: 0, numSurfs: 1 }];
    const backdrop = renderWorld(backOnly);
    setCVar(TRANSLUCENCY_CVAR, 0);
    const opaque = renderWorld(world);
    setCVar(TRANSLUCENCY_CVAR, 1);
    const blended = renderWorld(world);
    setCVar(STIPPLE_ALPHA_CVAR, 1);
    const stipple = renderWorld(world);
    const nOpaque = countNonZero(opaque);
    const nBlend = countNonZero(blended);
    const nStipple = countNonZero(stipple);
    expect(nStipple).toBeGreaterThan(0);
    expect(nStipple).toBeLessThan(nBlend);
    expect(nStipple).toBeLessThan(nOpaque);
    // every stipple pixel is either the opaque glass texel (lattice point)
    // or the pass-0 backdrop showing through the screen-door gap
    for (let i = 0; i < opaque.length; i++) {
      expect(stipple[i] === opaque[i] || stipple[i] === backdrop[i]).toBe(true);
    }
  });

  it('constant real-pcx tables blend every covered pixel to the table value', () => {
    const world = twoQuadWorld();
    const fb = createFramebuffer(160, 120, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(greyPalette());
    const pixels = new Uint8Array(COLORMAP_PCX_PIXELS);
    pixels.fill(7, ALPHAMAP_HEAD);
    expect(r.setAlphamapFromColormapPcx(pixels)).toBe(true);
    expect(r.testAlphamapReady()).toBe(true);
    const view = {
      origin: new Float32Array([0, 0, 0]), angles: new Float32Array([0, 0, 0]),
      fovX: 90, time: 0, lightStyles: new Float32Array(256).fill(1),
    };
    r.beginFrame();
    r.renderView(view, { name: 'glass', data: world }, []);
    r.endFrame();
    // the glass covers the whole backdrop: every covered pixel reads table 7
    let glass = 0;
    for (const v of fb.index!) if (v === 7) glass++;
    expect(glass).toBeGreaterThan(100);
    expect(r.setAlphamapFromColormapPcx(new Uint8Array(10))).toBe(false);
  });

  it('warped translucent water renders deterministically', () => {
    const world = twoQuadWorld(true);
    const a = renderWorld(world);
    const b = renderWorld(world);
    expect([...a]).toEqual([...b]);
    expect(countNonZero(a)).toBeGreaterThan(100);
  });
});
