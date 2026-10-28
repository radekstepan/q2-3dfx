// PERF-2 RGB workers: real RGB raster jobs on workers (JOB_RGB), not just
// indexed planes. Differential pins: pooled worker kicks (sync + async)
// are byte-identical to the serial path — same spans, same order per band,
// absolute dither coords, same-row ties, foreground drawn inline after the
// kick. Covers odd dimensions, band seams, worker-count sweeps including
// zero/serial fallback, dead-pool fallback, determinism, and real base1
// views with fixed entities (alias/sprite/tracer foreground ordering).
//
// Worker threads boot from the BUILT bundle (dist-gated like the other
// pooled tests); the serial reference always runs from source.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { createFramebuffer } from '@q2/renderer-api';
import type { Entity } from '@q2/renderer-api';
import { SoftwareRenderer, setRGBWorldEnabled } from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import { BandWorkerPool } from './bandPool.js';
import { SW_ACCUM_CVAR, SW_WORKERS_CVAR } from './bands.js';
import { bspToMiniWorld, type BspTexelSource, type MiniWorld } from './index.js';
import { loadBsp } from '@q2/bsp';
import { parseMD2, parsePCX, parseWAL } from '@q2/formats';

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

/** Full-RGBA FNV-1a (all 4 bytes — stronger than the R+G harness hash). */
function fnvRGBA(color: Uint32Array): string {
  let h = 2166136261;
  for (let i = 0; i < color.length; i++) {
    const px = color[i]!;
    h ^= px & 0xff; h = Math.imul(h, 16777619);
    h ^= (px >>> 8) & 0xff; h = Math.imul(h, 16777619);
    h ^= (px >>> 16) & 0xff; h = Math.imul(h, 16777619);
    h ^= (px >>> 24) & 0xff; h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
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

function frameOf(r: SoftwareRenderer): RGBFrame {
  const live = r.getFramebuffer();
  const st = r.testRGBStats();
  return {
    colorHash: fnvRGBA(new Uint32Array(live.color.buffer, live.color.byteOffset, live.color.byteLength / 4)),
    indexHash: fnvU8(live.index!),
    cover: st.coverPixels,
    used: st.used,
  };
}

function devView(W: number, H: number) {
  void W; void H;
  return {
    origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
    fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
  };
}

function renderDevroomSerial(W: number, H: number): RGBFrame {
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(testPalette());
  setRGBWorldEnabled(true);
  r.beginFrame();
  r.renderView(devView(W, H), { name: 'devroom', data: createDevroom() }, []);
  r.endFrame();
  setRGBWorldEnabled(false);
  return frameOf(r);
}

function distOrSkip(): string | null {
  const distUrl = new URL('../dist/index.mjs', import.meta.url);
  if (!existsSync(distUrl)) {
    console.log('SKIP RGB worker test: dist not built (run yarn build first)');
    return null;
  }
  return distUrl.pathname;
}

async function renderDevroomPooled(W: number, H: number, workers: number): Promise<RGBFrame> {
  const dist = distOrSkip();
  if (!dist) throw new Error('no dist');
  const { resetCVars, setCVar } = await import('@q2/config');
  try {
    resetCVars();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    setCVar(SW_WORKERS_CVAR, 4);
    setCVar(SW_ACCUM_CVAR, 1);
    if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
    const pool = BandWorkerPool.create(workers, W, H, { indexJsPath: dist });
    if (!pool) throw new Error('pool create failed');
    try {
      r.attachWorkerPool(pool);
      setRGBWorldEnabled(true);
      r.beginFrame();
      r.renderView(devView(W, H), { name: 'devroom', data: createDevroom() }, []);
      r.endFrame();
      setRGBWorldEnabled(false);
      return frameOf(r);
    } finally {
      await pool.dispose();
    }
  } finally {
    resetCVars();
  }
}

describe('RGB worker kicks are byte-identical to serial', () => {
  it('devroom worker kick matches serial at 1/3/7 workers (320x240)', { timeout: 180000 }, async () => {
    if (!distOrSkip()) return;
    const serial = renderDevroomSerial(320, 240);
    expect(serial.used).toBe(true);
    expect(serial.cover).toBe(320 * 240);
    for (const workers of [1, 3, 7]) {
      const pooled = await renderDevroomPooled(320, 240, workers);
      expect(pooled.used).toBe(true);
      expect(pooled.cover).toBe(serial.cover);
      expect(pooled.colorHash).toBe(serial.colorHash);
      expect(pooled.indexHash).toBe(serial.indexHash);
    }
  });

  it('devroom worker kick matches serial on odd dims (161x121, seams)', { timeout: 180000 }, async () => {
    if (!distOrSkip()) return;
    const serial = renderDevroomSerial(161, 121);
    expect(serial.used).toBe(true);
    for (const workers of [1, 7]) {
      const pooled = await renderDevroomPooled(161, 121, workers);
      expect(pooled.cover).toBe(serial.cover);
      expect(pooled.colorHash).toBe(serial.colorHash);
      expect(pooled.indexHash).toBe(serial.indexHash);
    }
  });

  it('worker kick is deterministic across runs', { timeout: 180000 }, async () => {
    if (!distOrSkip()) return;
    const a = await renderDevroomPooled(320, 240, 3);
    const b = await renderDevroomPooled(320, 240, 3);
    expect(a.colorHash).toBe(b.colorHash);
    expect(a.indexHash).toBe(b.indexHash);
    expect(a.cover).toBe(b.cover);
  });

  it('dead-pool fallback matches serial (dispose before render)', { timeout: 120000 }, async () => {
    if (!distOrSkip()) return;
    const { resetCVars, setCVar } = await import('@q2/config');
    const dist = distOrSkip() as string;
    try {
      resetCVars();
      const W = 320, H = 240;
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(testPalette());
      setCVar(SW_WORKERS_CVAR, 4);
      setCVar(SW_ACCUM_CVAR, 1);
      if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
      const pool = BandWorkerPool.create(3, W, H, { indexJsPath: dist });
      if (!pool) throw new Error('pool create failed');
      r.attachWorkerPool(pool);
      await pool.dispose();
      setRGBWorldEnabled(true);
      r.beginFrame();
      r.renderView(devView(W, H), { name: 'devroom', data: createDevroom() }, []);
      r.endFrame();
      setRGBWorldEnabled(false);
      const serial = renderDevroomSerial(W, H);
      const f = frameOf(r);
      expect(f.cover).toBe(serial.cover);
      expect(f.colorHash).toBe(serial.colorHash);
      expect(f.indexHash).toBe(serial.indexHash);
    } finally {
      resetCVars();
    }
  });

  it('async RGB kick (renderViewAsync) matches sync pooled + serial', { timeout: 180000 }, async () => {
    if (!distOrSkip()) return;
    const { resetCVars, setCVar } = await import('@q2/config');
    const dist = distOrSkip() as string;
    try {
      resetCVars();
      const W = 320, H = 240;
      const renderAsync = async (): Promise<RGBFrame> => {
        resetCVars();
        const fb = createFramebuffer(W, H, true);
        const r = new SoftwareRenderer();
        r.init(fb);
        r.setPalette(testPalette());
        setCVar(SW_WORKERS_CVAR, 4);
        setCVar(SW_ACCUM_CVAR, 1);
        if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
        const pool = BandWorkerPool.create(3, W, H, { indexJsPath: dist });
        if (!pool) throw new Error('pool create failed');
        try {
          r.attachWorkerPool(pool);
          setRGBWorldEnabled(true);
          r.beginFrame();
          await r.renderViewAsync(devView(W, H), { name: 'devroom', data: createDevroom() }, []);
          r.endFrame();
          setRGBWorldEnabled(false);
          return frameOf(r);
        } finally {
          await pool.dispose();
        }
      };
      const serial = renderDevroomSerial(W, H);
      const a = await renderAsync();
      expect(a.cover).toBe(serial.cover);
      expect(a.colorHash).toBe(serial.colorHash);
      expect(a.indexHash).toBe(serial.indexHash);
    } finally {
      resetCVars();
    }
  });
});

// --- real base1 views (Q2_PAK-gated): world kick + foreground-after-kick ---

function pakReadFile(pakPath: string, name: string): ArrayBuffer {
  const data = readFileSync(pakPath);
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
}

interface PakWorld {
  world: MiniWorld;
  palette: Uint8Array;
  soldierMd2: ArrayBuffer;
  soldierSkin: { pixels: Uint8Array; width: number; height: number };
}

function loadPakWorld(pakPath: string): PakWorld {
  const bsp = loadBsp(pakReadFile(pakPath, 'maps/base1.bsp'));
  const walCache = new Map<string, BspTexelSource | null>();
  const texelFor = (walName: string): BspTexelSource | null => {
    if (walCache.has(walName)) return walCache.get(walName)!;
    let src: BspTexelSource | null = null;
    try {
      const wal = parseWAL(pakReadFile(pakPath, `textures/${walName}.wal`));
      src = { texels: wal.mips[0] as Uint8Array, width: wal.width, height: wal.height };
    } catch { src = null; }
    walCache.set(walName, src);
    return src;
  };
  const skin = parsePCX(pakReadFile(pakPath, 'models/monsters/soldier/skin.pcx'));
  return {
    world: bspToMiniWorld(bsp, { texelFor }),
    palette: parsePCX(pakReadFile(pakPath, 'pics/colormap.pcx')).palette,
    soldierMd2: pakReadFile(pakPath, 'models/monsters/soldier/tris.md2'),
    soldierSkin: { pixels: skin.pixels, width: skin.width, height: skin.height },
  };
}

/** Fixed in-frustum entities (mirrors the bench fixed set: alias + sprite + tracer). */
function fixedEntities(
  r: SoftwareRenderer, fw: PakWorld,
  origin: [number, number, number], yawDeg: number,
): Entity[] {
  const yaw = (yawDeg * Math.PI) / 180;
  const fx = Math.cos(yaw), fy = Math.sin(yaw);
  const rx = -fy, ry = fx;
  const [ox, oy, oz] = origin;
  const md2 = parseMD2(fw.soldierMd2.slice(0));
  const mh = r.registerModel({ name: 'soldier', kind: 'md2', data: md2 });
  const sh = r.registerSkinPixels('soldier-skin', fw.soldierSkin.pixels, fw.soldierSkin.width, fw.soldierSkin.height);
  const th = r.registerModel({ name: 'tracer', kind: 'tracer' as unknown as 'sp2', data: null });
  const sx = ox + fx * 48, sy = oy + fy * 48;
  const sp2 = r.registerModel({ name: 'shot-sprite', kind: 'sp2', data: null });
  return [
    {
      model: mh, origin: new Float32Array([sx, sy, oz - 30]),
      angles: new Float32Array([0, yawDeg + 180, 0]), frame: 4, skin: sh,
    },
    {
      model: sp2, origin: new Float32Array([sx, sy, oz + 18]),
      angles: new Float32Array([0, 0, 0]), frame: 0, skin: sh,
    },
    {
      model: th,
      origin: new Float32Array([ox + fx * 40 + rx * 25, oy + fy * 40 + ry * 25, oz - 10]),
      angles: new Float32Array([0, yawDeg + 90, 0]), frame: 96, skin: 231,
    },
  ];
}

const BASE1_VIEWS = [
  { origin: [128, -320, 54] as [number, number, number], yaw: 90, label: 'spawn-north' },
  { origin: [-1648, 1544, 16] as [number, number, number], yaw: 0, label: 'trench-east' },
];

describe.runIf(!!process.env.Q2_PAK)('RGB workers on real base1 (Q2_PAK)', () => {
  it('worker kick matches serial on 2 views, with and without entities', { timeout: 300000 }, async () => {
    const dist = distOrSkip();
    if (!dist) return;
    const { resetCVars, setCVar } = await import('@q2/config');
    const pakPath = process.env.Q2_PAK as string;
    const fw = loadPakWorld(pakPath);
    const W = 320, H = 240;
    for (const v of BASE1_VIEWS) {
      for (const withEnt of [false, true]) {
        const refdef = {
          origin: new Float32Array(v.origin), angles: new Float32Array([0, v.yaw, 0]),
          fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
        };
        const renderMode = async (workers: number): Promise<RGBFrame> => {
          resetCVars();
          const fb = createFramebuffer(W, H, true);
          const r = new SoftwareRenderer();
          r.init(fb);
          r.setPalette(fw.palette);
          const entities = withEnt ? fixedEntities(r, fw, v.origin, v.yaw) : [];
          let pool: BandWorkerPool | null = null;
          if (workers > 0) {
            setCVar(SW_WORKERS_CVAR, 4);
            setCVar(SW_ACCUM_CVAR, 1);
            if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
            pool = BandWorkerPool.create(workers, W, H, { indexJsPath: dist });
            if (!pool) throw new Error('pool create failed');
            r.attachWorkerPool(pool);
          }
          try {
            setRGBWorldEnabled(true);
            r.beginFrame();
            r.renderView(refdef, { name: 'base1', data: fw.world }, entities);
            r.endFrame();
            setRGBWorldEnabled(false);
            return frameOf(r);
          } finally {
            if (pool) await pool.dispose();
          }
        };
        const serial = await renderMode(0);
        expect(serial.used).toBe(true);
        for (const workers of [1, 7]) {
          const pooled = await renderMode(workers);
          expect(pooled.cover).toBe(serial.cover);
          expect(pooled.colorHash).toBe(serial.colorHash);
          expect(pooled.indexHash).toBe(serial.indexHash);
        }
      }
    }
  });
});
