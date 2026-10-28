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
import { SW_ACCUM_CVAR, SW_WORKERS_CVAR } from './bands.js';

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
    expect(a.colorHash).toBe('8372b322');
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
