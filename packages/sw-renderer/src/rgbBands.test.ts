// perf-2 lane: banded/pooled backends respect the RGB flag (worker bands).
//
// - Banded-inline (2..8 bands, no pool) vs serial: identical color/index
//   planes. Spans are single-row so no span crosses a band seam, but the
//   Bayer mip-dither pick uses ABSOLUTE screen coords (x run from the span's
//   absolute x0, y from s.y) — any relative-coord regression would flip the
//   dither phase on every row and break the color hash.
// - Pooled (real worker threads, dist-gated): the classic planes go through
//   the pool while RGB spans route per band inline; the single global
//   composite in endFrame merges them. Pooled + serial RGB must be
//   byte-identical.
// - WASM backend + RGB flag is an explicit Com_Error (never silent
//   software); the full WASM RGB port is out of scope.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { createFramebuffer } from '@q2/renderer-api';
import { SoftwareRenderer, setRGBWorldEnabled } from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import { BandWorkerPool } from './index.js';
import {
  BandedSoftwareBackend, SW_ACCUM_CVAR, SW_WORKERS_CVAR, splitBands,
} from './bands.js';
import {
  SPAN_FLAT, SPAN_OPAQUE, SPAN_TRANS33, SPAN_TRANS66, SPAN_TURBULENT,
  buildRGBMaterial, createSpan, drawSpansRGB,
  type RGBMaterial, type RGBWindow, type Span, type SpanList,
} from './spans.js';

afterEach(() => {
  setRGBWorldEnabled(false);
});

function testPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = (i * 5) & 255;
    pal[i * 3 + 1] = (i * 3 + 40) & 255;
    pal[i * 3 + 2] = (i * 2 + 80) & 255;
  }
  return pal;
}

function fnvU8(a: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) {
    h ^= a[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface RGBFrame {
  colorHash: string;
  indexHash: string;
  cover: number;
  used: boolean;
}

function renderRGBSerial(W: number, H: number): RGBFrame {
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(testPalette());
  setRGBWorldEnabled(true);
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
  setRGBWorldEnabled(false);
  // NOTE: hash the LIVE framebuffer (getFramebuffer): pooled mode adopts
  // the pool's shared color plane, so fb.color goes stale after init — and
  // the view must be hashed by (buffer, byteOffset, byteLength), never the
  // whole SAB.
  const live = r.getFramebuffer();
  return {
    colorHash: fnvU8(new Uint8Array(live.color.buffer, live.color.byteOffset, live.color.byteLength)),
    indexHash: fnvU8(live.index!),
    cover: r.testRGBStats().coverPixels,
    used: r.testRGBStats().used,
  };
}

async function renderRGBBanded(W: number, H: number, bands: number): Promise<RGBFrame> {
  const { resetCVars, setCVar } = await import('@q2/config');
  try {
    resetCVars();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    setCVar(SW_WORKERS_CVAR, bands);
    expect(r.syncWorkersFromCvar()).toBe(true);
    expect(r.isWorkersActive()).toBe(true);
    setRGBWorldEnabled(true);
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
    setRGBWorldEnabled(false);
    const st = r.testRGBStats();
    // Live framebuffer: pooled mode adopts the pool's shared color plane.
    const live = r.getFramebuffer();
    return {
      colorHash: fnvU8(new Uint8Array(live.color.buffer, live.color.byteOffset, live.color.byteLength)),
      indexHash: fnvU8(live.index!),
      cover: st.coverPixels,
      used: st.used,
    };
  } finally {
    resetCVars();
  }
}

describe('banded vs serial RGB equivalence (dither phase + seam rows)', () => {
  it('serial RGB pins hold (step-5 hash, regression anchor)', () => {
    const a = renderRGBSerial(160, 120);
    expect(a.used).toBe(true);
    expect(a.cover).toBe(160 * 120);
    // True-565 + window-Z re-pin (was 3534624e) + alias-LOD re-pin (was
    // a9988ff4): see rgbPerf.test.ts — the devroom box critter now samples
    // the correct mip instead of the coarsest. Index pin unchanged.
    // Gutter-LOD re-pin (was 436fe0c5): alias ALIAS_LOD_BIAS_DELTA +
    // clamp-addressed taps (see rgbPerf.test.ts); critter pixels only.
    // Mip-UV-scale + bias-removal re-pin (was 206e1dad): RGB samplers scale
    // UVs into the picked mip and alias tracks the shared bias (delta 0);
    // see rgbPerf.test.ts. Index pin unchanged.
    expect(a.colorHash).toBe('68b22dea');
    expect(a.indexHash).toBe('58e0ecf1');
  });

  it('banded-inline matches serial for 2..8 bands at 160x120', async () => {
    const serial = renderRGBSerial(160, 120);
    for (const bands of [2, 3, 4, 5, 8]) {
      const banded = await renderRGBBanded(160, 120, bands);
      expect(banded.used).toBe(true);
      expect(banded.colorHash).toBe(serial.colorHash);
      expect(banded.indexHash).toBe(serial.indexHash);
      expect(banded.cover).toBe(serial.cover);
    }
  });

  it('banded-inline matches serial at 320x240 incl. seam rows', async () => {
    const serial = renderRGBSerial(320, 240);
    expect(serial.cover).toBe(320 * 240);
    for (const bands of [2, 4, 7]) {
      const banded = await renderRGBBanded(320, 240, bands);
      expect(banded.colorHash).toBe(serial.colorHash);
      expect(banded.indexHash).toBe(serial.indexHash);
      expect(banded.cover).toBe(serial.cover);
    }
  });

  it('banded-inline matches serial on odd dims (PERF-2 A y-range)', async () => {
    const serial = renderRGBSerial(161, 121);
    expect(serial.used).toBe(true);
    for (const bands of [2, 3, 5, 8]) {
      const banded = await renderRGBBanded(161, 121, bands);
      expect(banded.colorHash).toBe(serial.colorHash);
      expect(banded.indexHash).toBe(serial.indexHash);
      expect(banded.cover).toBe(serial.cover);
    }
  });

  it('pooled + serial RGB are byte-identical (dist-gated)', { timeout: 120000 }, async () => {
    const distUrl = new URL('../dist/index.mjs', import.meta.url);
    if (!existsSync(distUrl)) {
      console.log('SKIP pooled RGB test: dist not built (run yarn build first)');
      return;
    }
    const { resetCVars, setCVar } = await import('@q2/config');
    try {
      const renderPooled = async (accum: boolean): Promise<RGBFrame> => {
        resetCVars();
        const W = 320, H = 240;
        const fb = createFramebuffer(W, H, true);
        const r = new SoftwareRenderer();
        r.init(fb);
        r.setPalette(testPalette());
        setCVar(SW_WORKERS_CVAR, 4);
        setCVar(SW_ACCUM_CVAR, accum ? 1 : 0);
        expect(r.syncWorkersFromCvar()).toBe(true);
        const pool = BandWorkerPool.create(3, W, H, { indexJsPath: distUrl.pathname });
        expect(pool).not.toBeNull();
        try {
          r.attachWorkerPool(pool);
          setRGBWorldEnabled(true);
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
          setRGBWorldEnabled(false);
          const st = r.testRGBStats();
          // Live framebuffer: pooled mode adopts the pool's shared planes.
          const live = r.getFramebuffer();
          return {
            colorHash: fnvU8(new Uint8Array(live.color.buffer, live.color.byteOffset, live.color.byteLength)),
            indexHash: fnvU8(live.index!),
            cover: st.coverPixels,
            used: st.used,
          };
        } finally {
          await pool!.dispose();
        }
      };
      const serial = renderRGBSerial(320, 240);
      const withAccum = await renderPooled(true);
      const perBatch = await renderPooled(false);
      for (const [name, f] of [['accum', withAccum], ['per-batch', perBatch]] as const) {
        expect(f.used).toBe(true);
        expect(f.cover).toBe(serial.cover);
        expect(f.colorHash).toBe(serial.colorHash);
        expect(f.indexHash).toBe(serial.indexHash);
      }
      // software planes stay pinned under pooling too
      expect(withAccum.indexHash).toBe('8f61c755');
    } finally {
      resetCVars();
    }
  });
});

describe('wasm backend + RGB flag (explicit-unsupported)', () => {
  it('setWasmEnabled(true) Com_Errors while the RGB flag is on', async () => {
    const { resetCVars } = await import('@q2/config');
    try {
      resetCVars();
      const fb = createFramebuffer(64, 48, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      setRGBWorldEnabled(true);
      expect(() => r.setWasmEnabled(true)).toThrow();
      expect(r.isWasmActive()).toBe(false);
      // flag off -> the opt-in still works where wasm exists
      setRGBWorldEnabled(false);
    } finally {
      resetCVars();
    }
  });
});

// RASTER lane (fused RGB band call): the single full-range call draws the
// identical pixel set as the per-band fan-out. Proof under test here:
// - every span touches exactly one row (y constant per span) and all plane
//   effects are per-pixel (o = y*fbW+x), so different-row spans commute —
//   including alpha/additive blends (read+write the same destination pixel)
//   and depth ties (resolved per pixel, first wins);
// - same-row spans keep list order in both forms (band filter preserves
//   order; the fused call is list order), so same-row overlap (opaque tie,
//   alpha-over-opaque, opaque-in-front-of-alpha) resolves identically;
// - absolute coords ride the call in both forms (x from the absolute x0,
//   Bayer pick from xAbs/yAbs), so the dither phase cannot shift.
// The adversarial list below exercises all of it at once: unsorted rows,
// out-of-range rows, clipped/empty x, every span kind, same-row overlap in
// both orders, depth ties, zero/negative iz, warp, and five materials
// (opaque lit/unlit/clamp/point, alpha-warp, additive-warp, flat).
describe('fused RGB band call == per-band loop (order-independence proof)', () => {
  const W = 17, H = 11;
  const WIN: RGBWindow = { near: 4, far: 32768 };

  function grayPalette(): Uint8Array {
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = (i * 7 + 11) & 255;
      pal[i * 3 + 1] = (i * 3 + 40) & 255;
      pal[i * 3 + 2] = (i * 5 + 80) & 255;
    }
    return pal;
  }

  function mkPlanes(): { q: Uint16Array; cover: Uint8Array; depth: Uint16Array } {
    return { q: new Uint16Array(W * H), cover: new Uint8Array(W * H), depth: new Uint16Array(W * H).fill(0xffff) };
  }

  function texels16(): Uint8Array {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) t[i] = (i * 13 + 7) & 255;
    t[0] = 255; // transparent hole (mask skip) somewhere in range
    return t;
  }

  function mkSpan(
    kind: number, y: number, x0: number, x1: number, iz: number,
    extra?: Partial<Span>,
  ): Span {
    const s = createSpan();
    s.kind = kind;
    s.y = y; s.x0 = x0; s.x1 = x1;
    s.iz = iz; s.diz = 0.001;
    s.uz = 2.5; s.duz = 0.11;
    s.vz = 3.5; s.dvz = -0.07;
    s.light = 40; s.dlight = 0.5;
    s.lu = 0.25; s.lv = 0.5; s.dlu = 0.02;
    s.dudy = 0.13; s.dvdy = -0.09;
    s.turb = 7;
    Object.assign(s, extra);
    return s;
  }

  /** Unsorted rows, OOR rows, clipped/empty x, all kinds, same-row overlap. */
  function adversarialList(): SpanList {
    const spans: Span[] = [
      mkSpan(SPAN_OPAQUE, 8, 0, W, 1.0),
      // same row 8, behind the first (loses depth everywhere)
      mkSpan(SPAN_OPAQUE, 8, 2, 12, 0.5),
      // same row 8, translucent over both (alpha blend over stored quantum)
      mkSpan(SPAN_TRANS33, 8, 1, 15, 2.0),
      // row 2: opaque tie — first wins, second must not overwrite
      mkSpan(SPAN_OPAQUE, 2, 0, W, 1.25),
      mkSpan(SPAN_OPAQUE, 2, 0, W, 1.25),
      // row 5: alpha first, then opaque in FRONT overwrites it
      mkSpan(SPAN_TRANS66, 5, 0, W, 1.1),
      mkSpan(SPAN_OPAQUE, 5, 3, 14, 1.6),
      mkSpan(SPAN_TURBULENT, 10, -4, W + 3, 0.9),
      mkSpan(SPAN_FLAT, 0, 0, W, 1.4),
      // out-of-range rows (skipped by the same guard in every form)
      mkSpan(SPAN_OPAQUE, -2, 0, W, 1.0),
      mkSpan(SPAN_OPAQUE, H + 1, 0, W, 1.0),
      // clipped / empty x
      mkSpan(SPAN_OPAQUE, 3, -6, 4, 0.8),
      mkSpan(SPAN_OPAQUE, 3, 12, W + 9, 0.85),
      mkSpan(SPAN_OPAQUE, 7, 5, 5, 1.0),
      mkSpan(SPAN_OPAQUE, 7, 9, 6, 1.0),
      // degenerate depth (draws nothing, must not trap or diverge)
      mkSpan(SPAN_OPAQUE, 1, 0, W, 0, { diz: 0 }),
      mkSpan(SPAN_OPAQUE, 9, 0, W, -1.0, { diz: 0 }),
      // unlit fallback grade path (lv < 0) + zero lux slope
      mkSpan(SPAN_OPAQUE, 4, 0, W, 1.1, { lv: -1, light: 55, dlight: 0, lu: 0, dlu: 0 }),
      mkSpan(SPAN_TURBULENT, 6, 0, W, 1.05),
      mkSpan(SPAN_TRANS33, 6, 4, 13, 1.3),
    ];
    return { spans, count: spans.length };
  }

  function materials(pal: Uint8Array, tex: Uint8Array): Array<{ name: string; mat: RGBMaterial }> {
    const light = { samples: new Uint8Array([200, 40, 30, 60, 220, 90, 30, 90, 210, 250, 250, 250]), luxW: 2, luxH: 2 };
    const flat = new Uint8Array([10, 200, 90]);
    return [
      {
        name: 'opaque-lit-dither-z16',
        mat: buildRGBMaterial(tex, 16, 16, pal, light, {
          overbright: true, lodBias: -0.35, mipDither: true, bilinear: true,
          zbits: 16, blend: 'opaque', flatColor: flat,
        }),
      },
      {
        name: 'opaque-unlit-clamp-point-z0',
        mat: buildRGBMaterial(tex, 16, 16, pal, null, {
          addressS: 'clamp', addressT: 'clamp', overbright: false, lodBias: 0.5,
          mipDither: false, bilinear: false, zbits: 0, blend: 'opaque', flatColor: flat,
        }),
      },
      {
        name: 'alpha-warp',
        mat: buildRGBMaterial(tex, 16, 16, pal, light, {
          overbright: true, lodBias: -1, mipDither: true, bilinear: true,
          zbits: 16, blend: 'alpha', alpha: 0.37, warp: true, turbPhase: 41, flatColor: flat,
        }),
      },
      {
        name: 'additive-warp',
        mat: buildRGBMaterial(tex, 16, 16, pal, light, {
          overbright: false, lodBias: 0.25, mipDither: true, bilinear: false,
          zbits: 0, blend: 'additive', warp: true, turbPhase: 999, flatColor: flat,
        }),
      },
      {
        name: 'opaque-flatcolor-nolight-nodither',
        mat: buildRGBMaterial(tex, 16, 16, pal, null, {
          overbright: true, lodBias: 2, mipDither: false, bilinear: true,
          zbits: 16, blend: 'opaque', depthWrite: true, flatColor: flat,
        }),
      },
    ];
  }

  function snap(p: { q: Uint16Array; cover: Uint8Array; depth: Uint16Array }): string {
    let h = 2166136261;
    const mix = (v: number): void => { h ^= v & 0xffff; h = Math.imul(h, 16777619); };
    for (let i = 0; i < p.q.length; i++) { mix(p.q[i]!); mix(p.cover[i]!); mix(p.depth[i]!); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  it('serial full-range == per-band loop == BandedSoftwareBackend for 1..8 bands', () => {
    const pal = grayPalette();
    const tex = texels16();
    const list = adversarialList();
    for (const { name, mat } of materials(pal, tex)) {
      for (const B of [1, 2, 3, 4, 5, 7, 8]) {
        for (const win of [WIN, undefined] as const) {
          // (a) serial: one full-range call (the bandCount<=1 path).
          const a = mkPlanes();
          const ra = drawSpansRGB(a.q, a.cover, a.depth, W, H, list, mat, win ?? null);
          // (b) reference: the old per-band fan-out, band by band.
          const b = mkPlanes();
          let spans = 0, pixels = 0;
          for (const band of splitBands(H, B)) {
            const r = drawSpansRGB(b.q, b.cover, b.depth, W, H, list, mat, win ?? null,
              undefined, undefined, band.y0, band.y1);
            spans += r.spans;
            pixels += r.pixels;
          }
          expect(spans, `${name} B=${B} spans`).toBe(ra.spans);
          expect(pixels, `${name} B=${B} pixels`).toBe(ra.pixels);
          expect(snap(b), `${name} B=${B} win=${win ? 'set' : 'default'} loop==serial`).toBe(snap(a));
          // (c) the changed method: BandedSoftwareBackend.drawSpansRGB.
          const c = mkPlanes();
          const bb = new BandedSoftwareBackend();
          bb.attach(new Uint8Array(W * H), new Float32Array(W * H), W, H, new Uint8Array(64 * 256));
          bb.setBandCount(B);
          bb.attachRGB(c.q, c.cover, c.depth, W, H);
          bb.drawSpansRGB(list, mat, win ?? null);
          expect(snap(c), `${name} B=${B} win=${win ? 'set' : 'default'} backend==serial`).toBe(snap(a));
        }
      }
    }
  });

  it('stale-band fallback draws without throwing (old behavior preserved)', () => {
    const pal = grayPalette();
    const tex = texels16();
    const { mat } = materials(pal, tex)[0]!;
    const list = adversarialList();
    const c = mkPlanes();
    const bb = new BandedSoftwareBackend();
    // Classic height 7 vs RGB height 11: bands no longer partition the RGB
    // frame, so the partition check fails and the per-band loop runs.
    bb.attach(new Uint8Array(17 * 7), new Float32Array(17 * 7), 17, 7, new Uint8Array(64 * 256));
    bb.setBandCount(4);
    bb.attachRGB(c.q, c.cover, c.depth, W, H);
    expect(() => bb.drawSpansRGB(list, mat, WIN)).not.toThrow();
  });
});
