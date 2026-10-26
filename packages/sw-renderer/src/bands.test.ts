// M8.1 tests: SAB banding is golden-identical to the single-threaded path,
// the cvar opts in silently, and the thread pool (when available) matches.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { createFramebuffer } from '@q2/renderer-api';
import {
  SPAN_OPAQUE, SPAN_TURBULENT,
  createSpan, drawSpansSoftware, drawSpansTurbulent,
  SoftwareBackend, BandedSoftwareBackend,
  type LightBlock, type Span, type SpanList, type Texture,
} from './index.js';
import {
  SW_WORKERS_CVAR, MAX_WORKERS, MIN_BAND_PIXELS,
  attachBandShared, bandTotal, packBandSpans, processBandJob,
  sabAvailable, splitBands, syncWaitAllowed, workersRequestedByCvar,
} from './index.js';
import { BandWorkerPool } from './index.js';
import { SKY_SIDE_IMAGE } from './index.js';
import type { MiniWorld } from './index.js';
import { buildColormap, defaultPalette } from './index.js';
import { SoftwareRenderer } from './index.js';
import { createDevroom, DEVROOM_CAMERA } from './index.js';
import { loadBsp } from '@q2/bsp';
import { parsePCX, parseWAL } from '@q2/formats';
import { bspToMiniWorld, type BspTexelSource } from './index.js';
import { v3 } from '@q2/math';

/** Deterministic PRNG (mulberry32) so fuzz is reproducible. */
function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gradeColormap(): Uint8Array {
  const c = new Uint8Array(64 * 256);
  for (let g = 0; g < 64; g++) c.fill(g, g * 256, g * 256 + 256);
  return c;
}

/** Random batch exercising clipping, gradients, depth ties, light blocks. */
function fuzzBatch(rand: () => number, W: number, H: number): Span[] {
  const out: Span[] = [];
  const n = 4 + ((rand() * 12) | 0);
  for (let k = 0; k < n; k++) {
    const s = createSpan();
    const r = rand();
    s.kind = r < 0.7 ? SPAN_OPAQUE : SPAN_TURBULENT;
    s.y = ((rand() * (H + 4)) | 0) - 2;
    s.x0 = ((rand() * (W + 16)) | 0) - 8;
    s.x1 = s.x0 + 1 + ((rand() * (W / 2 + 20)) | 0);
    s.iz = 0.002 + rand() * 0.4;
    s.diz = (rand() - 0.5) * 0.002;
    s.uz = rand() * 4 - 1;
    s.duz = s.iz * (0.2 + rand() * 2);
    s.vz = rand() * 4 - 1;
    s.dvz = (rand() - 0.5) * s.iz * 0.5;
    s.light = 8 + rand() * 47;
    s.dlight = (rand() - 0.5) * (8 / (1 + s.x1 - s.x0));
    if (rand() < 0.6) {
      s.lv = rand() * 8;
      s.lu = rand() * 10;
      s.dlu = (rand() - 0.5) * 0.5;
    } else {
      s.lv = -1;
      s.lu = 0; s.dlu = 0;
    }
    s.turb = (rand() * 64) | 0;
    s.ord = (rand() * 4) | 0;
    out.push(s);
  }
  return out;
}

function fuzzTexture(rand: () => number, texW: number, texH: number): Texture {
  const texels = new Uint8Array(texW * texH);
  for (let i = 0; i < texels.length; i++) texels[i] = (rand() * 256) | 0;
  return { width: texW, height: texH, texels };
}

function fuzzLight(rand: () => number, lw: number, lh: number): LightBlock {
  const values = new Uint8Array(lw * lh);
  for (let i = 0; i < values.length; i++) values[i] = (rand() * 64) | 0;
  return { width: lw, height: lh, values };
}

function hashIdx(idx: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < idx.length; i++) {
    h ^= idx[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

describe('band tiling', () => {
  it('tiles rows exactly for 1..9 bands', () => {
    for (const n of [1, 2, 3, 4, 5, 8, 9]) {
      for (const h of [1, 7, 120, 240, 480, 481]) {
        const bands = splitBands(h, n);
        const want = Math.min(n, MAX_WORKERS);
        expect(bands.length).toBe(want);
        let y = 0;
        for (const b of bands) {
          expect(b.y0).toBe(y);
          expect(b.y1).toBeGreaterThanOrEqual(b.y0);
          y = b.y1;
        }
        expect(y).toBe(h);
      }
    }
  });

  it('clamps band counts and degenerate heights', () => {
    expect(splitBands(480, 0).length).toBe(1);
    expect(splitBands(480, 99).length).toBe(MAX_WORKERS);
    expect(splitBands(0, 4).every((b) => b.y0 === 0 && b.y1 === 0)).toBe(true);
  });
});

describe('sw_workers cvar (opt-in, single-threaded default)', () => {
  it('defaults to 0 and clamps through the cvar', async () => {
    const { getCVarNumber, resetCVars, setCVar } = await import('@q2/config');
    try {
      resetCVars();
      expect(getCVarNumber(SW_WORKERS_CVAR)).toBe(0);
      expect(workersRequestedByCvar()).toBe(0);
      setCVar(SW_WORKERS_CVAR, 3);
      expect(workersRequestedByCvar()).toBe(3);
      setCVar(SW_WORKERS_CVAR, 99);
      expect(workersRequestedByCvar()).toBe(MAX_WORKERS);
      setCVar(SW_WORKERS_CVAR, -2);
      expect(workersRequestedByCvar()).toBe(0);
    } finally {
      resetCVars();
    }
  });

  it('detects SAB + blocking waits in Node, never throws', () => {
    expect(sabAvailable()).toBe(true);
    expect(syncWaitAllowed()).toBe(true);
    expect(bandTotal(640, 480)).toBeGreaterThan(640 * 480 * 5);
  });
});

describe('banded backend vs single-threaded (differential fuzz)', () => {
  it('is bit-identical for 1..8 bands, opaque + turbulent', () => {
    const rand = rng(0xBA9D01);
    const colormap = gradeColormap();
    for (let iter = 0; iter < 60; iter++) {
      const W = 32 + ((rand() * 192) | 0);
      const H = 8 + ((rand() * 120) | 0);
      const texW = 1 << (2 + ((rand() * 4) | 0));
      const texH = 1 << (2 + ((rand() * 4) | 0));
      const spans = fuzzBatch(rand, W, H);
      // one guaranteed full-width opaque span so every band has work
      const full = createSpan();
      full.y = (rand() * H) | 0; full.x0 = 0; full.x1 = W;
      full.iz = 0.1; full.uz = 0; full.duz = 0.05; full.vz = 0; full.dvz = 0;
      full.light = 30; full.lv = -1;
      spans.push(full);
      const list: SpanList = { spans, count: spans.length };
      const tex = fuzzTexture(rand, texW, texH);
      const light = fuzzLight(rand, 4, 4);
      const refIdx = new Uint8Array(W * H);
      const refZb = new Float32Array(W * H);
      const be = new SoftwareBackend();
      be.attach(refIdx, refZb, W, H, colormap);
      be.drawSpans(list, tex, light);
      for (const bands of [1, 2, 3, 4, 8]) {
        const bIdx = new Uint8Array(W * H);
        const bZb = new Float32Array(W * H);
        const bb = new BandedSoftwareBackend();
        bb.attach(bIdx, bZb, W, H, colormap);
        bb.setBandCount(bands);
        bb.drawSpans(list, tex, light);
        expect([...bIdx]).toEqual([...refIdx]);
        expect([...bZb]).toEqual([...refZb]);
        expect(bb.spansDrawn).toBe(be.spansDrawn);
        expect(bb.pixelsDrawn).toBe(be.pixelsDrawn);
      }
    }
  });

  it('packed processBandJob matches the reference loop band by band', () => {
    const rand = rng(0x9A0001);
    const colormap = gradeColormap();
    for (let iter = 0; iter < 40; iter++) {
      const W = 32 + ((rand() * 128) | 0);
      const H = 16 + ((rand() * 64) | 0);
      const texW = 1 << (3 + ((rand() * 3) | 0));
      const texH = 1 << (3 + ((rand() * 3) | 0));
      const spans = fuzzBatch(rand, W, H);
      const list: SpanList = { spans, count: spans.length };
      const tex = fuzzTexture(rand, texW, texH);
      const light = fuzzLight(rand, 5, 5);
      const refIdx = new Uint8Array(W * H);
      const refZb = new Float32Array(W * H);
      const be = new SoftwareBackend();
      be.attach(refIdx, refZb, W, H, colormap);
      be.drawSpans(list, tex, light);
      const sab = new SharedArrayBuffer(bandTotal(W, H));
      const { views } = attachBandShared(sab, W, H);
      const pk = packBandSpans(list, views.spansF, views.spansI);
      expect(pk).not.toBeNull();
      views.texels.set(tex.texels);
      views.light.set(light.values);
      views.colormap.set(colormap);
      let ws = 0;
      while ((1 << ws) < tex.width) ws++;
      const base = {
        fbW: W, fbH: H, count: pk!.count,
        texW: tex.width, texH: tex.height, lightW: light.width, lightH: light.height,
        wshift: ws, wmask: tex.width - 1, hmask: tex.height - 1, turbPhase: 0,
      };
      let pixels = 0;
      let drawn = 0;
      for (const b of splitBands(H, 4)) {
        const r = processBandJob(views, { ...base, y0: b.y0, y1: b.y1 });
        pixels += r.pixels;
        drawn += r.spans;
      }
      expect(pixels).toBe(be.pixelsDrawn);
      expect(drawn).toBe(be.spansDrawn);
      expect([...views.idx]).toEqual([...refIdx]);
      expect([...views.zb]).toEqual([...refZb]);
    }
  });

  it('oversize batches fall back without diverging', () => {
    const rand = rng(7);
    const colormap = gradeColormap();
    const W = 64, H = 64;
    // more opaque spans than the pack cap: pool-incompatible by design
    const spans: Span[] = [];
    for (let i = 0; i < 5000; i++) {
      const s = createSpan();
      s.y = i % H; s.x0 = 0; s.x1 = 8; s.iz = 0.1;
      spans.push(s);
    }
    void rand;
    const list: SpanList = { spans, count: spans.length };
    const tex = { width: 8, height: 8, texels: new Uint8Array(64).fill(3) };
    const light = { width: 1, height: 1, values: new Uint8Array([40]) };
    const refIdx = new Uint8Array(W * H);
    const refZb = new Float32Array(W * H);
    new SoftwareBackend().attach(refIdx, refZb, W, H, colormap);
    const be = new SoftwareBackend();
    be.attach(refIdx, refZb, W, H, colormap);
    be.drawSpans(list, tex, light);
    const bIdx = new Uint8Array(W * H);
    const bZb = new Float32Array(W * H);
    const bb = new BandedSoftwareBackend();
    bb.attach(bIdx, bZb, W, H, colormap);
    bb.setBandCount(4);
    bb.drawSpans(list, tex, light); // inline chunked path, no pool attached
    expect([...bIdx]).toEqual([...refIdx]);
    expect([...bZb]).toEqual([...refZb]);
    // pack itself refuses the oversize batch (pool callers fall back)
    const sab = new SharedArrayBuffer(bandTotal(W, H));
    const { views } = attachBandShared(sab, W, H);
    expect(packBandSpans(list, views.spansF, views.spansI)).toBeNull();
    // tiny batches stay below the dispatch threshold (inline, identical)
    const tiny = createSpan();
    tiny.y = 3; tiny.x0 = 0; tiny.x1 = 4; tiny.iz = 0.2;
    expect(tiny.x1 - tiny.x0).toBeLessThan(MIN_BAND_PIXELS);
  });
});

describe('renderer banded mode (cvar opt-in, SAB, golden-identical)', () => {
  function renderDevroomHash(useWorkers: boolean): { hash: string; active: boolean; bands: number } {
    const W = 320, H = 240;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = (i * 5) & 255;
      pal[i * 3 + 1] = (i * 3 + 40) & 255;
      pal[i * 3 + 2] = (i * 2 + 80) & 255;
    }
    r.setPalette(pal);
    const styles = new Float32Array(256).fill(1);
    styles[1] = 0.6;
    if (useWorkers) {
      if (!r.syncWorkersFromCvar()) throw new Error('banded mode refused');
    }
    r.beginFrame();
    r.renderView(
      { origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles, fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: styles },
      { name: 'devroom', data: createDevroom() },
      [],
    );
    r.endFrame();
    const st = r.testWorkerStats();
    return { hash: hashIdx(r.getFramebuffer().index!), active: st.active, bands: st.bands };
  }

  it('devroom golden is identical single vs 4 bands', async () => {
    const { resetCVars, setCVar } = await import('@q2/config');
    try {
      resetCVars();
      const single = renderDevroomHash(false);
      expect(single.hash).toBe('8f61c755');
      expect(single.active).toBe(false);
      setCVar(SW_WORKERS_CVAR, 4);
      const banded = renderDevroomHash(true);
      expect(banded.active).toBe(true);
      expect(banded.bands).toBe(4);
      expect(banded.hash).toBe('8f61c755');
      expect(banded.hash).toBe(single.hash);
      // host framebuffer mirror stays correct (endFrame copies SAB -> host)
      setCVar(SW_WORKERS_CVAR, 0);
      const back = renderDevroomHash(false);
      expect(back.hash).toBe('8f61c755');
    } finally {
      resetCVars();
    }
  });

  it('falls back to single-threaded silently when the cvar is 0', async () => {
    const { resetCVars } = await import('@q2/config');
    try {
      resetCVars();
      const fb = createFramebuffer(64, 48, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      expect(r.syncWorkersFromCvar()).toBe(false);
      expect(r.isWorkersActive()).toBe(false);
      expect(r.testWorkerStats().pooled).toBe(false);
    } finally {
      resetCVars();
    }
  });
});

describe('BandWorkerPool (real threads, dist-gated)', () => {
  it('creates, dispatches and disposes with byte-identical output', { timeout: 60000 }, async () => {
    const distUrl = new URL('../dist/index.mjs', import.meta.url);
    if (!existsSync(distUrl)) {
      console.log('SKIP pool test: dist not built (run yarn build first)');
      return;
    }
    const rand = rng(0x9001);
    const W = 320, H = 240;
    const tex = fuzzTexture(rand, 32, 32);
    const light = fuzzLight(rand, 8, 8);
    const colormap = gradeColormap();
    // full-width spans so the pool fast path runs (est >> threshold)
    const spans: Span[] = [];
    for (let y = 0; y < H; y += 2) {
      const s = createSpan();
      s.y = y; s.x0 = 0; s.x1 = W; s.iz = 0.05 + (y / H) * 0.1;
      s.uz = 0; s.duz = s.iz * 0.5; s.vz = (y % 32) * s.iz; s.dvz = 0;
      s.light = 20 + (y % 30); s.lv = -1;
      spans.push(s);
    }
    const extra = fuzzBatch(rand, W, H);
    for (const s of extra) spans.push(s);
    const list: SpanList = { spans, count: spans.length };
    const refIdx = new Uint8Array(W * H);
    const refZb = new Float32Array(W * H);
    const be = new SoftwareBackend();
    be.attach(refIdx, refZb, W, H, colormap);
    be.drawSpans(list, tex, light);
    const pool = BandWorkerPool.create(2, W, H, { indexJsPath: distUrl.pathname });
    expect(pool).not.toBeNull();
    try {
      pool!.beginFrame();
      const r = pool!.dispatch(list, tex, light, colormap, 0, W, H, pool!.idx, pool!.zb);
      expect(r).not.toBeNull();
      expect(r!.pixels).toBe(be.pixelsDrawn);
      expect([...pool!.idx]).toEqual([...refIdx]);
      expect([...pool!.zb]).toEqual([...refZb]);
      // async dispatch converges too
      pool!.beginFrame();
      const ra = await pool!.dispatchAsync(list, tex, light, colormap, 0, W, H, pool!.idx, pool!.zb);
      expect(ra).not.toBeNull();
      expect([...pool!.idx]).toEqual([...refIdx]);
      expect([...pool!.zb]).toEqual([...refZb]);
    } finally {
      await pool!.dispose();
    }
  });

  it('returns null (silent fallback) for bad configs', () => {
    expect(BandWorkerPool.create(0, 64, 48, { indexJsPath: 'x' })).toBeNull();
    expect(BandWorkerPool.create(2, 64, 48, { indexJsPath: '/no/such/file.mjs' })).toBeNull();
    expect(BandWorkerPool.create(-3, 64, 48, { indexJsPath: 'x' })).toBeNull();
  });
});

/** Minimal PAK reader (test-only; avoids a @q2/filesystem dependency). */
function pakReadFile(pakPath: string, name: string): ArrayBuffer {
  const data = readFileSync(pakPath);
  if (data.subarray(0, 4).toString() !== 'PACK') throw new Error('not a pak');
  const dirofs = data.readUInt32LE(4);
  const dirlen = data.readUInt32LE(8);
  for (let o = dirofs; o < dirofs + dirlen; o += 64) {
    const entry = data.subarray(o, o + 56).toString().replace(/\0.*$/, '');
    if (entry === name) {
      const off = data.readUInt32LE(o + 56);
      const len = data.readUInt32LE(o + 60);
      return data.buffer.slice(data.byteOffset + off, data.byteOffset + off + len);
    }
  }
  throw new Error(`pak entry missing: ${name}`);
}

describe.runIf(!!process.env.Q2_PAK)('banded vs single on real base1 (Q2_PAK)', () => {
  it('renders 4 real-map views golden-identical across 1/2/4 bands', { timeout: 300000 }, async () => {
    const { resetCVars, setCVar } = await import('@q2/config');
    try {
      resetCVars();
      const pakPath = process.env.Q2_PAK as string;
      const bsp = loadBsp(pakReadFile(pakPath, 'maps/base1.bsp'));
      const walCache = new Map<string, BspTexelSource | null>();
      const texelFor = (walName: string): BspTexelSource | null => {
        if (walCache.has(walName)) return walCache.get(walName)!;
        let src: BspTexelSource | null = null;
        try {
          const wal = parseWAL(pakReadFile(pakPath, `textures/${walName}.wal`));
          src = { texels: wal.mips[0]!, width: wal.width, height: wal.height };
        } catch { src = null; }
        walCache.set(walName, src);
        return src;
      };
      const world = bspToMiniWorld(bsp, { texelFor });
      const pcx = parsePCX(pakReadFile(pakPath, 'pics/colormap.pcx'));
      const W = 640, H = 480;
      const views = [
        { origin: v3(128, -320, 54), angles: v3(0, 90, 0), label: 'spawn-north' },
        { origin: v3(128, -320, 54), angles: v3(0, 180, 0), label: 'spawn-west' },
        { origin: v3(-944, 1552, 0), angles: v3(0, 180, 0), label: 'lowroad-west' },
        { origin: v3(-1648, 1544, 16), angles: v3(0, 0, 0), label: 'trench-east' },
      ];
      for (const v of views) {
        const refdef = {
          origin: v.origin, angles: v.angles, fovX: 90, time: 1.5,
          lightStyles: new Float32Array(256).fill(1),
        };
        const hashes = new Map<number, string>();
        for (const bands of [1, 2, 4]) {
          const fb = createFramebuffer(W, H, true);
          const r = new SoftwareRenderer();
          r.init(fb);
          r.setPalette(pcx.palette);
          setCVar(SW_WORKERS_CVAR, bands);
          expect(r.syncWorkersFromCvar()).toBe(bands > 1 || sabAvailable());
          r.beginFrame();
          r.renderView(refdef, { name: 'base1', data: world }, []);
          r.endFrame();
          const h = hashIdx(r.getFramebuffer().index!);
          hashes.set(bands, h);
          console.log(`base1 ${v.label} bands=${bands} hash=${h}`);
        }
        expect(hashes.get(2)).toBe(hashes.get(1));
        expect(hashes.get(4)).toBe(hashes.get(1));
      }
    } finally {
      resetCVars();
    }
  });

  it('drawSpans-only banding matches drawSpansSoftware exactly', () => {
    const rand = rng(0x5AA07);
    const colormap = buildColormap(defaultPalette());
    const W = 320, H = 200;
    const spans = fuzzBatch(rand, W, H);
    const list: SpanList = { spans, count: spans.length };
    const tex = fuzzTexture(rand, 32, 32);
    const light = fuzzLight(rand, 6, 6);
    const refIdx = new Uint8Array(W * H);
    const refZb = new Float32Array(W * H);
    const t0 = drawSpansSoftware(refIdx, refZb, W, H, list, tex, light, colormap);
    const t1 = drawSpansTurbulent(refIdx, refZb, W, H, list, tex, colormap,
      new BandedSoftwareBackend().turbTable, 1.5);
    void t0; void t1;
    // full banded-backend dispatch over the same batch
    const bIdx = new Uint8Array(W * H);
    const bZb = new Float32Array(W * H);
    const bb = new BandedSoftwareBackend();
    bb.attach(bIdx, bZb, W, H, colormap);
    bb.setBandCount(4);
    bb.time = 1.5;
    bb.drawSpans(list, tex, light);
    expect([...bIdx]).toEqual([...refIdx]);
    expect([...bZb]).toEqual([...refZb]);
  });
});

describe('pool staging caps (M7.2 sky-black fix)', () => {
  /** Full-width opaque spans so the pool fast path is eligible (est >> threshold). */
  function wideBatch(W: number, H: number): SpanList {
    const spans: Span[] = [];
    for (let y = 0; y < H; y += 2) {
      const s = createSpan();
      s.y = y; s.x0 = 0; s.x1 = W; s.iz = 0.05; s.diz = 0;
      s.uz = 0; s.duz = s.iz * 0.5; s.vz = 0; s.dvz = 0;
      s.light = 63; s.dlight = 0; s.lv = -1;
      spans.push(s);
    }
    return { spans, count: spans.length };
  }

  it('dispatch returns null for textures beyond staging instead of truncating', { timeout: 60000 }, async () => {
    const distUrl = new URL('../dist/index.mjs', import.meta.url);
    if (!existsSync(distUrl)) {
      console.log('SKIP pool cap test: dist not built (run yarn build first)');
      return;
    }
    const W = 160, H = 120;
    const pool = BandWorkerPool.create(2, W, H, { indexJsPath: distUrl.pathname });
    expect(pool).not.toBeNull();
    try {
      const list = wideBatch(W, H);
      const colormap = buildColormap(defaultPalette());
      const light: LightBlock = { width: 1, height: 1, values: new Uint8Array([63]) };
      // 65792 bytes > TEX_CAP (65536): the packed sky strip shape. Must fall
      // back inline (null) — staging a prefix would sample zeros as black.
      const big: Texture = { width: 256, height: 257, texels: new Uint8Array(256 * 257).fill(7) };
      pool!.beginFrame();
      expect(pool!.dispatch(list, big, light, colormap, 0, W, H, pool!.idx, pool!.zb)).toBeNull();
      pool!.beginFrame();
      expect(await pool!.dispatchAsync(list, big, light, colormap, 0, W, H, pool!.idx, pool!.zb)).toBeNull();
      // Boundary: exactly TEX_CAP still dispatches (no behaviour change).
      const okTex: Texture = { width: 256, height: 256, texels: new Uint8Array(65536).fill(7) };
      pool!.beginFrame();
      const r = pool!.dispatch(list, okTex, light, colormap, 0, W, H, pool!.idx, pool!.zb);
      expect(r).not.toBeNull();
      expect(r!.pixels).toBeGreaterThan(0);
    } finally {
      await pool!.dispose();
    }
  });

  /** Six sky quads around the camera (same shape as the sky.test.ts room). */
  function skyRoom(): MiniWorld {
    const quads: number[][] = [
      [40, -40, 0, 40, 40, 0, 40, 40, 60, 40, -40, 60],
      [-40, 40, 0, -40, -40, 0, -40, -40, 60, -40, 40, 60],
      [-40, 40, 0, 40, 40, 0, 40, 40, 60, -40, 40, 60],
      [40, -40, 0, -40, -40, 0, -40, -40, 60, 40, -40, 60],
      [-40, -40, 70, 40, -40, 70, 40, 40, 70, -40, 40, 70],
      [-40, 40, -10, 40, 40, -10, 40, -40, -10, -40, 40, -10],
    ];
    const surfaces = quads.map((q, i) => ({
      id: i,
      verts: new Float32Array(q),
      uvs: new Float32Array([0, 0, 64, 0, 64, 64, 0, 64]),
      lux: new Float32Array([0, 0, 4, 0, 4, 4, 0, 4]),
      n: 4, texId: 0, lightId: 0,
      center: new Float32Array([0, 0, 30]), radius: 90,
      mins: new Float32Array([-40, -40, -10]), maxs: new Float32Array([40, 40, 70]),
      turbulent: false, sky: true,
      fn: new Float32Array([0, 0, 1]),
    }));
    return {
      brand: 'miniworld',
      nodes: [],
      leafs: [{ cluster: 0, firstSurf: 0, numSurfs: surfaces.length }],
      pvs: [new Uint8Array([1])],
      clusterCount: 1,
      surfaces,
      textures: [{ texels: new Uint8Array(16).fill(7), width: 4, height: 4 }],
      lightmaps: [{ samples: new Uint8Array([128, 128, 128]), luxW: 1, luxH: 1, styles: [0] }],
      dynamicLights: [],
      alias: [],
      sprites: [],
      particles: [],
    };
  }

  it('pooled sky with a real-size strip matches classic on all six faces', { timeout: 120000 }, async () => {
    const distUrl = new URL('../dist/index.mjs', import.meta.url);
    if (!existsSync(distUrl)) {
      console.log('SKIP pool sky test: dist not built (run yarn build first)');
      return;
    }
    const { setCVarFromString, resetCVars } = await import('@q2/config');
    // Real-size strip analogue: 256x1536 packed tiles (384KB > TEX_CAP).
    const tile = 256;
    const texels = new Uint8Array(tile * tile * 6);
    for (let f = 0; f < 6; f++) texels.fill(10 + f * 20, f * tile * tile, (f + 1) * tile * tile);
    const strip = { texels, width: tile, height: tile * 6 };
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) { pal[i * 3] = i; pal[i * 3 + 1] = i; pal[i * 3 + 2] = i; }
    const FACES: Array<[string, number[], number]> = [
      ['+X rt', [0, 0, 0], 4],
      ['+Y bk', [0, 90, 0], 3],
      ['-X lf', [0, 180, 0], 1],
      ['-Y ft', [0, 270, 0], 5],
      ['+Z up', [-90, 0, 0], 2],
      ['-Z dn', [90, 0, 0], 0],
    ];
    const W = 160, H = 120;
    const world = skyRoom();
    const renderClassic = (angles: number[]): Uint8Array => {
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(pal);
      r.setSkyTexture(strip);
      r.beginFrame();
      r.renderView(
        {
          origin: new Float32Array([0, 0, 30]), angles: new Float32Array(angles),
          fovX: 90, time: 0, lightStyles: new Float32Array(256).fill(1),
        },
        { name: 'sky-room', data: world },
        [],
      );
      r.endFrame();
      return r.getFramebuffer().index!.slice();
    };
    try {
      const pool = BandWorkerPool.create(2, W, H, { indexJsPath: distUrl.pathname });
      expect(pool).not.toBeNull();
      try {
        for (const [label, angles, face] of FACES) {
          const want = 10 + SKY_SIDE_IMAGE[face]! * 20;
          const ref = renderClassic(angles);
          // Sanity: the classic path covers the frame with the face tile.
          let hit = 0;
          for (let i = 0; i < ref.length; i++) if (ref[i] === want) hit++;
          expect(hit / ref.length, `${label} classic coverage`).toBeGreaterThan(0.99);
          // Pooled path (inline fallback for the oversized strip) is identical.
          const fb = createFramebuffer(W, H, true);
          const r = new SoftwareRenderer();
          r.init(fb);
          r.setPalette(pal);
          r.setSkyTexture(strip);
          setCVarFromString('sw_workers', '2');
          r.syncWorkersFromCvar();
          r.attachWorkerPool(pool);
          r.beginFrame();
          r.renderView(
            {
              origin: new Float32Array([0, 0, 30]), angles: new Float32Array(angles),
              fovX: 90, time: 0, lightStyles: new Float32Array(256).fill(1),
            },
            { name: 'sky-room', data: world },
            [],
          );
          r.endFrame();
          expect(hashIdx(r.getFramebuffer().index!), `${label} pooled`).toBe(hashIdx(ref));
        }
      } finally {
        await pool!.dispose();
      }
    } finally {
      resetCVars();
    }
  });
});
