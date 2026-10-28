// M4.1 voodoo resolve chain: instance enable methods, fidelity snapshot,
// 16-bit depth, nearest sampling, vertical-aware LOD.
import { afterEach, describe, expect, it } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import { getCVarNumber, setCVar } from '@q2/config';
import {
  SoftwareRenderer, setRGBWorldEnabled, isRGBWorldEnabled,
  readRGBFidelity, sameRGBFidelity,
} from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import {
  SPAN_FLAT, SPAN_OPAQUE,
  buildRGBMaterial, createSpan, drawSpansRGB, quantiseIz, quantiseIzInt,
  windowDepth01, windowDepthQ16, DEFAULT_RGB_FAR, DEFAULT_RGB_NEAR,
  type SpanList,
} from './spans.js';

/** Expand one stored 565 quantum to 8:8:8 (matches the endFrame resolve). */
function expandQ(q: Uint16Array, i: number): [number, number, number] {
  const v = q[i]!;
  const r5 = (v >> 11) & 31, g6 = (v >> 5) & 63, b5 = v & 31;
  return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)];
}

/** Fresh 565 authority planes (depth cleared to all-ones = far). */
function mkPlanes(n: number): { q: Uint16Array; cover: Uint8Array; depth: Uint16Array } {
  return { q: new Uint16Array(n), cover: new Uint8Array(n), depth: new Uint16Array(n).fill(0xffff) };
}

const VD_CVARS = ['vd_overbright', 'vd_lodbias', 'vd_mipdither', 'vd_bilinear', 'vd_zbits'];

function saveCvars(): number[] {
  return VD_CVARS.map((n) => getCVarNumber(n));
}

function restoreCvars(saved: number[]): void {
  for (let i = 0; i < VD_CVARS.length; i++) setCVar(VD_CVARS[i]!, saved[i]!);
}

afterEach(() => {
  setRGBWorldEnabled(false);
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

/** 2-wide opaque span: constant u/v/depth, unlit. */
function flatSpanU(u: number): ReturnType<typeof createSpan> {
  const s = createSpan();
  s.kind = SPAN_OPAQUE;
  s.y = 0; s.x0 = 0; s.x1 = 2;
  s.iz = 1; s.diz = 0;
  s.uz = u; s.duz = 0;
  s.vz = 0; s.dvz = 0;
  s.light = 40; s.dlight = 0;
  s.lu = 0; s.lv = -1; s.dlu = 0;
  s.ord = 0;
  return s;
}

function renderDevroomRGB(W = 160, H = 120): { colorHash: string; cover: number; misses: number } {
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(grayPalette());
  r.beginFrame();
  r.renderView(
    {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
    },
    { name: 'devroom', data: createDevroom() },
    [],
  );
  r.endFrame();
  let h = 2166136261;
  const px = new Uint8Array(fb.color.buffer);
  for (let i = 0; i < px.length; i++) {
    h ^= px[i]!;
    h = Math.imul(h, 16777619);
  }
  const st = r.testRGBStats();
  return { colorHash: (h >>> 0).toString(16).padStart(8, '0'), cover: st.coverPixels, misses: st.misses };
}

describe('readRGBFidelity', () => {
  it('matches the compiled-in Voodoo3 profile by default', () => {
    const saved = saveCvars();
    try {
      const f = readRGBFidelity();
      expect(f.overbright).toBe(true);
      expect(f.lodBias).toBeCloseTo(-0.35, 10);
      expect(f.mipDither).toBe(true);
      expect(f.bilinear).toBe(true);
      expect(f.zbits).toBe(16);
    } finally {
      restoreCvars(saved);
    }
  });

  it('follows cvar toggles and sanitises garbage', () => {
    const saved = saveCvars();
    try {
      setCVar('vd_overbright', 0);
      setCVar('vd_lodbias', 1.5);
      setCVar('vd_mipdither', 0);
      setCVar('vd_bilinear', 0);
      setCVar('vd_zbits', 8);
      const f = readRGBFidelity();
      expect(f.overbright).toBe(false);
      expect(f.lodBias).toBe(1.5);
      expect(f.mipDither).toBe(false);
      expect(f.bilinear).toBe(false);
      expect(f.zbits).toBe(8);
      expect(sameRGBFidelity(f, readRGBFidelity())).toBe(true);
      setCVar('vd_zbits', 99);
      expect(readRGBFidelity().zbits).toBe(0);
      setCVar('vd_lodbias', Number.NaN);
      expect(readRGBFidelity().lodBias).toBeCloseTo(-0.35, 10);
    } finally {
      restoreCvars(saved);
    }
  });
});

describe('quantiseIz', () => {
  it('is identity when off or out of range', () => {
    expect(quantiseIz(0.123456, 0)).toBe(0.123456);
    expect(quantiseIz(0.123456, 24)).toBe(0.123456);
    expect(quantiseIz(0.123456, -1)).toBe(0.123456);
  });

  it('rounds 1/z to 16-bit steps', () => {
    const scale = 65535;
    expect(quantiseIz(0.5, 16)).toBe(Math.round(0.5 * scale) / scale);
    expect(quantiseIz(2.5, 16)).toBe(Math.round(2.5 * scale) / scale);
    // sub-step neighbours tie
    expect(quantiseIz(0.5, 16)).toBe(quantiseIz(0.5 + 1e-6, 16));
    expect(quantiseIz(0.5, 16)).not.toBe(quantiseIz(0.5 + 1e-3, 16));
  });

  it('quantiseIzInt matches the float round-trip steps', () => {
    expect(quantiseIzInt(0.5, 16)).toBe(Math.round(0.5 * 65535));
    expect(quantiseIzInt(-1, 16)).toBe(0);
    expect(quantiseIzInt(99, 16)).toBe(65535);
    expect(quantiseIzInt(0.5, 0)).toBe(0);
  });
});

describe('instance enable methods', () => {
  it('instance set/is delegate to the shared module flag', () => {
    const fb = createFramebuffer(8, 8, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    expect(r.isRGBWorldEnabled()).toBe(false);
    r.setRGBWorldEnabled(true);
    expect(r.isRGBWorldEnabled()).toBe(true);
    expect(isRGBWorldEnabled()).toBe(true);
    r.setRGBWorldEnabled(false);
    expect(isRGBWorldEnabled()).toBe(false);
  });

  it('toggling drops RGB state: no used frame, caches rebuilt', () => {
    const saved = saveCvars();
    try {
      const W = 160, H = 120;
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      const view = {
        origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
        fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
      };
      const world = { name: 'devroom', data: createDevroom() };
      r.setRGBWorldEnabled(true);
      r.setPalette(grayPalette());
      r.beginFrame();
      r.renderView(view, world, []);
      r.endFrame();
      const m1 = r.testRGBStats().misses;
      expect(m1).toBeGreaterThan(0);
      // disable -> the composite is skipped
      r.setRGBWorldEnabled(false);
      expect(r.testRGBStats().used).toBe(false);
      // re-enable -> caches were dropped, so misses grow again
      r.setRGBWorldEnabled(true);
      r.beginFrame();
      r.renderView(view, world, []);
      r.endFrame();
      expect(r.testRGBStats().misses).toBeGreaterThan(m1);
    } finally {
      restoreCvars(saved);
    }
  });

  it('invalidateCaches drops scalar + RGB caches without touching planes', () => {
    const saved = saveCvars();
    try {
      const fb = createFramebuffer(160, 120, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setRGBWorldEnabled(true);
      r.setPalette(grayPalette());
      const view = {
        origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
        fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
      };
      const world = { name: 'devroom', data: createDevroom() };
      r.beginFrame();
      r.renderView(view, world, []);
      r.endFrame();
      const m1 = r.testRGBStats().misses;
      expect(m1).toBeGreaterThan(0);
      r.invalidateCaches();
      expect(r.testCacheStats().size).toBe(0);
      expect(r.testRGBStats().size).toBe(0);
      r.beginFrame();
      r.renderView(view, world, []);
      r.endFrame();
      expect(r.testRGBStats().misses).toBeGreaterThan(m1);
    } finally {
      restoreCvars(saved);
    }
  });
});

describe('fidelity snapshot per renderView', () => {
  function renderThrice(): { hashes: string[]; misses: number[] } {
    const fb = createFramebuffer(160, 120, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setRGBWorldEnabled(true);
    r.setPalette(grayPalette());
    const view = {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
    };
    const world = { name: 'devroom', data: createDevroom() };
    const hashes: string[] = [];
    const misses: number[] = [];
    const once = (): void => {
      r.beginFrame();
      r.renderView(view, world, []);
      r.endFrame();
      let h = 2166136261;
      const px = new Uint8Array(fb.color.buffer);
      for (let i = 0; i < px.length; i++) {
        h ^= px[i]!;
        h = Math.imul(h, 16777619);
      }
      hashes.push((h >>> 0).toString(16).padStart(8, '0'));
      misses.push(r.testRGBStats().misses);
    };
    once();
    once();
    setCVar('vd_lodbias', 2.0);
    once();
    return { hashes, misses };
  }

  it('toggling a vd_* cvar invalidates RGB materials (misses grow)', () => {
    const saved = saveCvars();
    try {
      setRGBWorldEnabled(true);
      const { hashes, misses } = renderThrice();
      expect(misses[1]).toBe(misses[0]); // cache hit: no new misses
      expect(hashes[1]).toBe(hashes[0]);
      expect(misses[2]).toBeGreaterThan(misses[1]); // cvar toggle rebuilt
    } finally {
      restoreCvars(saved);
    }
  });

  it('vd_overbright=0 dims lit RGB output', () => {
    const saved = saveCvars();
    try {
      setRGBWorldEnabled(true);
      const a = renderDevroomRGB();
      setCVar('vd_overbright', 0);
      const b = renderDevroomRGB();
      expect(b.colorHash).not.toBe(a.colorHash);
    } finally {
      restoreCvars(saved);
    }
  });
});

describe('vd_bilinear nearest sampling', () => {
  it('point-samples the centre texel when bilinear is false', () => {
    const pal = grayPalette();
    // texels chosen to stay distinct through the RGB565 write quantise
    // (8 -> 8, 248 -> 252, 50/50 average 128 -> 132)
    const texels = new Uint8Array([8, 248]);
    const lin = buildRGBMaterial(texels, 2, 1, pal, null,
      { overbright: false, lodBias: 0, mipDither: false, bilinear: true });
    const near = buildRGBMaterial(texels, 2, 1, pal, null,
      { overbright: false, lodBias: 0, mipDither: false, bilinear: false });
    // u = 0.5 lands exactly between the two texels
    const draw = (mat: ReturnType<typeof buildRGBMaterial>): number => {
      const pl = mkPlanes(2);
      const list: SpanList = { spans: [flatSpanU(0.5)], count: 1 };
      drawSpansRGB(pl.q, pl.cover, pl.depth, 2, 1, list, mat);
      return expandQ(pl.q, 0)[0];
    };
    expect(draw(lin)).toBe(132);
    expect(draw(near)).toBe(8);
  });

  it('defaults to bilinear when the option is omitted', () => {
    const pal = grayPalette();
    const mat = buildRGBMaterial(new Uint8Array([10, 20]), 2, 1, pal, null,
      { overbright: false, lodBias: 0, mipDither: false });
    expect(mat.bilinear).toBe(true);
    expect(mat.zbits).toBe(0);
  });
});

describe('vd_zbits visibility', () => {
  function flatDraw(zbits: number, iz: number, flat: [number, number, number]): { q: Uint16Array; cover: Uint8Array; depth: Uint16Array } {
    const pal = grayPalette();
    const mat = buildRGBMaterial(new Uint8Array([0]), 1, 1, pal, null, {
      overbright: false, lodBias: 0, mipDither: false, flatColor: new Uint8Array(flat),
      opaqueMask: true, zbits,
    });
    const s = createSpan();
    s.kind = SPAN_FLAT;
    s.y = 0; s.x0 = 0; s.x1 = 1;
    s.iz = iz; s.diz = 0;
    s.ord = 0;
    const pl = mkPlanes(1);
    drawSpansRGB(pl.q, pl.cover, pl.depth, 1, 1, { spans: [s], count: 1 }, mat);
    return pl;
  }

  it('coplanar-ish fragments tie at 16 bits but not in the legacy path', () => {
    // 50 units out (in front of the near plane: window-Z is live here,
    // not clamped): the pair shares one 16-bit step but differs as floats
    const iz1 = 0.02;
    const iz2 = 0.02 + 2e-7; // same 16-bit window-Z step, strictly nearer as float
    // window-Z mapping: normalized depth ties at 16 bits for this pair
    const d1 = windowDepthQ16(windowDepth01(iz1, DEFAULT_RGB_NEAR, DEFAULT_RGB_FAR), 16);
    const d2 = windowDepthQ16(windowDepth01(iz2, DEFAULT_RGB_NEAR, DEFAULT_RGB_FAR), 16);
    expect(d1).toBe(d2);
    // legacy (zbits 0 = full-precision float compare): the strictly nearer
    // (blue) fragment wins over red
    const legacy = flatDraw(0, iz1, [200, 0, 0]);
    const redLegacy = legacy.q[0]!;
    // 8-bit 200 quantises to 206 through RGB565 (200>>3=25 -> 206)
    expect(expandQ(legacy.q, 0)).toEqual([206, 0, 0]);
    const blueLegacyMat = buildRGBMaterial(new Uint8Array([0]), 1, 1, grayPalette(), null, {
      overbright: false, lodBias: 0, mipDither: false,
      flatColor: new Uint8Array([0, 0, 200]), opaqueMask: true, zbits: 0,
    });
    const sLegacy = createSpan();
    sLegacy.kind = SPAN_FLAT;
    sLegacy.y = 0; sLegacy.x0 = 0; sLegacy.x1 = 1;
    sLegacy.iz = iz2; sLegacy.diz = 0;
    drawSpansRGB(legacy.q, new Uint8Array(1), legacy.depth, 1, 1,
      { spans: [sLegacy], count: 1 }, blueLegacyMat);
    expect(expandQ(legacy.q, 0)).toEqual([0, 0, 206]);
    // quantised: the tie keeps the first (red) writer; the depth plane
    // holds the window-Z quantum
    const tied = flatDraw(16, iz1, [200, 0, 0]);
    expect(tied.q[0]!).toBe(redLegacy);
    expect(tied.depth[0]).toBe(windowDepthQ16(windowDepth01(iz1, DEFAULT_RGB_NEAR, DEFAULT_RGB_FAR), 16));
    const blueTiedMat = buildRGBMaterial(new Uint8Array([0]), 1, 1, grayPalette(), null, {
      overbright: false, lodBias: 0, mipDither: false,
      flatColor: new Uint8Array([0, 0, 200]), opaqueMask: true, zbits: 16,
    });
    const sTied = createSpan();
    sTied.kind = SPAN_FLAT;
    sTied.y = 0; sTied.x0 = 0; sTied.x1 = 1;
    sTied.iz = iz2; sTied.diz = 0;
    drawSpansRGB(tied.q, new Uint8Array(1), tied.depth, 1, 1,
      { spans: [sTied], count: 1 }, blueTiedMat);
    expect(tied.q[0]!).toBe(redLegacy);
  });
});

describe('full-res mip source (M4.1)', () => {
  /** One head-on quad at mip-2 distance with a 1-texel checker texture. */
  function checkerWorld(): { name: string; data: import('./worldNodes.js').MiniWorld } {
    const S = 64;
    const texels = new Uint8Array(S * S);
    // Opaque checker (indices 10/200 — never the transparent 255): the old
    // point-subsampled source aliases to solid index-10, while the full-res
    // chain box-filters to the ~105 mean at coarse levels.
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) texels[y * S + x] = ((x + y) & 1) === 0 ? 10 : 200;
    }
    const X = 900; // camera-to-wall distance: mip 2 (640..1280)
    const H = 128;
    const verts = new Float32Array([X, -H, 0, X, H, 0, X, H, 2 * H, X, -H, 2 * H]);
    const cx = X, cy = 0, cz = H;
    const data: import('./worldNodes.js').MiniWorld = {
      brand: 'miniworld',
      nodes: [],
      leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 1 }],
      pvs: [new Uint8Array([1])],
      clusterCount: 1,
      surfaces: [{
        id: 0, verts,
        uvs: new Float32Array([0, 0, S, 0, S, S, 0, S]),
        lux: new Float32Array([0, 0, 4, 0, 4, 4, 0, 4]),
        n: 4, texId: 0, lightId: 0,
        center: new Float32Array([cx, cy, cz]), radius: Math.sqrt(H * H + H * H),
        mins: new Float32Array([X, -H, 0]), maxs: new Float32Array([X, H, 2 * H]),
        turbulent: false, fn: new Float32Array([-1, 0, 0]), sky: false,
      }],
      textures: [{ texels, width: S, height: S }],
      lightmaps: [{
        samples: new Uint8Array(4 * 4 * 3).fill(128),
        luxW: 4, luxH: 4, styles: [0],
      }],
      dynamicLights: [],
      alias: [],
      sprites: [],
      particles: [],
    };
    return { name: 'checker', data };
  }

  function renderChecker(): { center: number; cover: number } {
    const W = 160, H = 120;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(grayPalette());
    setRGBWorldEnabled(true);
    try {
      r.beginFrame();
      r.renderView(
        {
          origin: new Float32Array([0, 0, 64]),
          angles: new Float32Array([0, 0, 0]),
          fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
        },
        checkerWorld(),
        [],
      );
      r.endFrame();
      const cx = (W / 2) | 0, cy = (H / 2) | 0;
      const px = fb.color[cy * W + cx]!;
      const st = r.testRGBStats();
      return { center: px & 255, cover: st.coverPixels };
    } finally {
      setRGBWorldEnabled(false);
    }
  }

  it('minified 1-texel checker resolves to box-filtered gray, not aliased extremes', () => {
    // Old subsampled source: every-4th-texel point pick lands all phase-0
    // (solid index 10 -> r ~10 after the flat-128 lightmap x2 modulate).
    // Full-res chain: the minified footprint box-filters to the ~105 mean.
    // Either extreme (~10 or ~200) means the mip source regressed.
    const a = renderChecker();
    expect(a.cover).toBeGreaterThan(300);
    expect(a.center).toBeGreaterThan(60);
    expect(a.center).toBeLessThan(160);
    const b = renderChecker();
    expect(b.center).toBe(a.center);
  });
});

describe('vertical-aware LOD', () => {
  it('explicit dudy/dvdy widen rho to a coarser level', () => {
    const pal = grayPalette();
    // 4x4 ramp: level 0 varies, 1x1 average is ~8
    const texels = new Uint8Array(16);
    for (let i = 0; i < 16; i++) texels[i] = i;
    const mat = buildRGBMaterial(texels, 4, 4, pal, null,
      { overbright: false, lodBias: 0, mipDither: false });
    const draw = (dudy?: number, dvdy?: number): number => {
      const pl = mkPlanes(2);
      const list: SpanList = { spans: [flatSpanU(0)], count: 1 };
      drawSpansRGB(pl.q, pl.cover, pl.depth, 2, 1, list, mat, null, dudy, dvdy);
      return expandQ(pl.q, 0)[0];
    };
    const base = draw();
    expect(base).toBe(0); // level 0 texel (0,0)
    // omitted verticals default to horizontal (isotropic): identical output
    expect(draw(0, 0)).toBe(base);
    // steep vertical footprint -> coarser mip -> the 1x1 average, not texel 0
    const steep = draw(8, 8);
    expect(steep).not.toBe(base);
    expect(steep).toBeGreaterThan(4);
  });
});
