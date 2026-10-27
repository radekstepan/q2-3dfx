// M8.1 browser lane: renderViewAsync/endFrameAsync are bit-identical to
// the sync path (deferred world kick converges via depth-guarded writes;
// stats recompute from the same counters). Asset-free devroom pins run
// everywhere; base1 + pooled variants are Q2_PAK/dist-gated like the
// existing pooled gates in bands.test.ts.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { createFramebuffer } from '@q2/renderer-api';
import {
  BandWorkerPool,
  SW_ACCUM_CVAR,
  SW_WORKERS_CVAR,
  SoftwareRenderer,
  bspToMiniWorld,
  createDevroom,
  DEVROOM_CAMERA,
  type BspTexelSource,
} from './index.js';
import { loadBsp } from '@q2/bsp';
import { parsePCX, parseWAL } from '@q2/formats';
import { v3 } from '@q2/math';

function devPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = (i * 5) & 255;
    pal[i * 3 + 1] = (i * 3 + 40) & 255;
    pal[i * 3 + 2] = (i * 2 + 80) & 255;
  }
  return pal;
}

function hashIdx(idx: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < idx.length; i++) {
    h ^= idx[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function devView() {
  return {
    origin: DEVROOM_CAMERA.origin,
    angles: DEVROOM_CAMERA.angles,
    fovX: DEVROOM_CAMERA.fovX,
    time: 1.5,
    lightStyles: new Float32Array(256).fill(1),
  };
}

describe('async render (renderViewAsync/endFrameAsync)', () => {
  it('classic path: async matches sync bit-for-bit', async () => {
    const W = 320, H = 240;
    const mk = () => {
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(devPalette());
      return { fb, r };
    };
    const world = { name: 'devroom', data: createDevroom() };
    const a = mk();
    a.r.beginFrame();
    const syncStats = a.r.renderView(devView(), world, []);
    a.r.endFrame();
    const b = mk();
    b.r.beginFrame();
    const asyncStats = await b.r.renderViewAsync(devView(), world, []);
    await b.r.endFrameAsync();
    expect(hashIdx(b.fb.index!)).toBe(hashIdx(a.fb.index!));
    expect(b.fb.color).toEqual(a.fb.color);
    expect(asyncStats.spans).toBe(syncStats.spans);
    expect(asyncStats.pixels).toBe(syncStats.pixels);
    expect(asyncStats.overdraw).toBe(syncStats.overdraw);
  });

  it('async renderView twice in a row matches two sync renders', async () => {
    const W = 320, H = 240;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(devPalette());
    const world = { name: 'devroom', data: createDevroom() };
    r.beginFrame();
    r.renderView(devView(), world, []);
    r.endFrame();
    const h1 = hashIdx(fb.index!);
    r.beginFrame();
    await r.renderViewAsync(devView(), world, []);
    await r.endFrameAsync();
    const h2 = hashIdx(fb.index!);
    expect(h2).toBe(h1);
    expect(h2).toBe('8f61c755');
  });

  it('deferred flag restores after async render (sync path unaffected)', async () => {
    const W = 320, H = 240;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(devPalette());
    const world = { name: 'devroom', data: createDevroom() };
    r.beginFrame();
    await r.renderViewAsync(devView(), world, []);
    await r.endFrameAsync();
    // A sync render after an async one still matches the golden.
    r.beginFrame();
    r.renderView(devView(), world, []);
    r.endFrame();
    expect(hashIdx(fb.index!)).toBe('8f61c755');
  });
});

describe.runIf(!!process.env.Q2_PAK)('async pooled render on real base1 (Q2_PAK)', () => {
  it('pooled async matches pooled sync on 4 views', { timeout: 300000 }, async () => {
    const distUrl = new URL('../dist/index.mjs', import.meta.url);
    if (!existsSync(distUrl)) {
      console.log('SKIP pooled async base1 test: dist not built (run yarn build first)');
      return;
    }
    const { resetCVars, setCVar } = await import('@q2/config');
    const pakPath = process.env.Q2_PAK as string;
    const pakReadFile = (name: string): ArrayBuffer => {
      const data = readFileSync(pakPath);
      if (data.subarray(0, 4).toString() !== 'PACK') throw new Error('not a pak file');
      const dirofs = data.readUInt32LE(4);
      const dirlen = data.readUInt32LE(8);
      for (let o = dirofs; o < dirofs + dirlen; o += 64) {
        const entry = data.subarray(o, o + 56).toString().replace(/\0.*$/, '');
        if (entry === name) {
          const off = data.readUInt32LE(o + 56);
          const len = data.readUInt32LE(o + 60);
          return data.buffer.slice(data.byteOffset + off, data.byteOffset + off + len) as ArrayBuffer;
        }
      }
      throw new Error(`pak entry missing: ${name}`);
    };
    const bsp = loadBsp(pakReadFile('maps/base1.bsp'));
    const walCache = new Map<string, BspTexelSource | null>();
    const texelFor = (walName: string): BspTexelSource | null => {
      if (walCache.has(walName)) return walCache.get(walName)!;
      let src: BspTexelSource | null = null;
      try {
        const wal = parseWAL(pakReadFile(`textures/${walName}.wal`));
        src = { texels: wal.mips[0] as Uint8Array, width: wal.width, height: wal.height };
      } catch { src = null; }
      walCache.set(walName, src);
      return src;
    };
    const world = bspToMiniWorld(bsp, { texelFor });
    const pcx = parsePCX(pakReadFile('pics/colormap.pcx'));
    const W = 640, H = 480;
    const views = [
      { origin: [128, -320, 54], angles: [0, 90, 0], label: 'spawn-north' },
      { origin: [128, -320, 54], angles: [0, 180, 0], label: 'spawn-west' },
      { origin: [-944, 1552, 0], angles: [0, 180, 0], label: 'lowroad-west' },
      { origin: [-1648, 1544, 16], angles: [0, 0, 0], label: 'trench-east' },
    ];
    for (const v of views) {
      const refdef = {
        origin: new Float32Array(v.origin),
        angles: new Float32Array(v.angles),
        fovX: 90, time: 1.5,
        lightStyles: new Float32Array(256).fill(1),
      };
      const renderMode = async (useAsync: boolean): Promise<{ idx: string; spans: number; pixels: number }> => {
        resetCVars();
        const fb = createFramebuffer(W, H, true);
        const r = new SoftwareRenderer();
        r.init(fb);
        r.setPalette(pcx.palette);
        setCVar(SW_WORKERS_CVAR, 4);
        setCVar(SW_ACCUM_CVAR, 1);
        if (!r.syncWorkersFromCvar()) throw new Error('banded path unavailable');
        const pool = BandWorkerPool.create(3, W, H, { indexJsPath: distUrl.pathname });
        if (!pool) throw new Error('pool unavailable (need worker_threads + SAB + Atomics.wait)');
        r.attachWorkerPool(pool);
        try {
          r.beginFrame();
          const stats = useAsync
            ? await r.renderViewAsync(refdef, { name: 'base1', data: world }, [])
            : r.renderView(refdef, { name: 'base1', data: world }, []);
          if (useAsync) await r.endFrameAsync();
          else r.endFrame();
          const g = r.getFramebuffer();
          return { idx: hashIdx(g.index!), spans: stats.spans, pixels: stats.pixels };
        } finally {
          await pool.dispose();
        }
      };
      const sync = await renderMode(false);
      const async = await renderMode(true);
      console.log(`base1 ${v.label} pooled sync=${sync.idx} async=${async.idx}`);
      expect(async.idx).toBe(sync.idx);
      expect(async.spans).toBe(sync.spans);
      expect(async.pixels).toBe(sync.pixels);
    }
    resetCVars();
  });
});
