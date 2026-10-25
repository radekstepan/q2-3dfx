// M9.1 tests: the wasm span backend must be byte-identical to the TS path.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import {
  SPAN_OPAQUE, SPAN_TURBULENT, SPAN_FLAT,
  createSpan, drawSpansSoftware,
  SoftwareBackend,
  type LightBlock, type Span, type SpanList, type Texture,
} from './spans.js';
import {
  WasmSpanBackend, buildSpanModuleBytes,
  type DrawOpaqueFn,
} from './wasmSpans.js';
import { buildColormap, defaultPalette } from './colormap.js';
import { SoftwareRenderer } from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import { createFramebuffer } from '@q2/renderer-api';
import { loadBsp } from '@q2/bsp';
import { parsePCX, parseWAL } from '@q2/formats';
import { bspToMiniWorld, type BspTexelSource } from './bspWorld.js';
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

function runBoth(
  W: number, H: number, spans: Span[], tex: Texture, light: LightBlock, colormap: Uint8Array,
): { tsIdx: Uint8Array; tsZb: Float32Array; wasmIdx: Uint8Array; wasmZb: Float32Array; wasm: boolean } {
  const tsIdx = new Uint8Array(W * H);
  const tsZb = new Float32Array(W * H);
  const ts = new SoftwareBackend();
  ts.attach(tsIdx, tsZb, W, H, colormap);
  const wb = WasmSpanBackend.create(W, H);
  expect(wb).not.toBeNull();
  const wasm = wb!;
  wasm.attach(wasm.idx, wasm.zb, W, H, colormap);
  const mkList = (): SpanList => ({ spans, count: spans.length });
  ts.drawSpans(mkList(), tex, light);
  const before = wasm.wasmBatches;
  wasm.drawSpans(mkList(), tex, light);
  return { tsIdx, tsZb, wasmIdx: wasm.idx.slice(), wasmZb: wasm.zb.slice(), wasm: wasm.wasmBatches > before };
}

/** Random batch exercising clipping, gradients, depth ties, light blocks. */
function fuzzBatch(rand: () => number, W: number, H: number, texW: number, texH: number): Span[] {
  const out: Span[] = [];
  const n = 4 + ((rand() * 12) | 0);
  for (let k = 0; k < n; k++) {
    const s = createSpan();
    const r = rand();
    s.kind = r < 0.75 ? SPAN_OPAQUE : r < 0.9 ? SPAN_TURBULENT : SPAN_FLAT;
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
    // engine-plausible light ramp: the real renderer only produces grades
    // in 0..63 (convex luxel combos), so keep the whole span in range.
    // (Out-of-range light has its own dedicated fallback test below.)
    s.dlight = (rand() - 0.5) * (8 / (1 + s.x1 - s.x0));
    if (rand() < 0.6) {
      s.lv = rand() * 8;
      s.lu = rand() * 10;
      s.dlu = (rand() - 0.5) * 0.5;
    } else {
      s.lv = -1;
      s.lu = 0; s.dlu = 0;
    }
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

describe('wasm module construction', () => {
  it('builds valid bytes with the wasm magic + version', () => {
    const b = buildSpanModuleBytes();
    expect(b.length).toBeGreaterThan(100);
    expect([...b.slice(0, 8)]).toEqual([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  });

  it('instantiates and exports a callable draw_opaque', () => {
    const mod = new WebAssembly.Module(buildSpanModuleBytes());
    const mem = new WebAssembly.Memory({ initial: 1 });
    const inst = new WebAssembly.Instance(mod, { env: { memory: mem } });
    expect(typeof (inst.exports['draw_opaque'] as DrawOpaqueFn)).toBe('function');
  });

  it('create() rejects absurd sizes without throwing', () => {
    expect(WasmSpanBackend.create(0, 240)).toBeNull();
    expect(WasmSpanBackend.create(100000, 100000)).toBeNull();
    const wb = WasmSpanBackend.create(320, 240);
    expect(wb).not.toBeNull();
    expect(wb!.idx.length).toBe(320 * 240);
    expect(wb!.zb.length).toBe(320 * 240);
  });
});

describe('wasm vs TS byte-identity (differential fuzz)', () => {
  it('matches drawSpansSoftware exactly on perspective batches', () => {
    const rand = rng(0xC0FFEE);
    const colormap = gradeColormap();
    let wasmHits = 0;
    for (let iter = 0; iter < 200; iter++) {
      const W = 128 + ((rand() * 256) | 0);
      const H = 16 + ((rand() * 112) | 0);
      const texW = 1 << (2 + ((rand() * 4) | 0)); // 4..64
      const texH = 1 << (2 + ((rand() * 4) | 0));
      const lw = 1 + ((rand() * 12) | 0);
      const lh = 1 + ((rand() * 8) | 0);
      const spans = fuzzBatch(rand, W, H, texW, texH);
      // two guaranteed full-width opaque spans: est >> threshold, so the
      // wasm core (not the TS fallback) runs here. Light stays in the
      // engine-plausible 0..63 band so the range guard does not fire.
      for (let k = 0; k < 2; k++) {
        const s = createSpan();
        s.y = (rand() * H) | 0; s.x0 = 0; s.x1 = W;
        s.iz = 0.01 + rand() * 0.2; s.diz = (rand() - 0.5) * 0.001;
        s.uz = rand() * 2; s.duz = s.iz * (0.5 + rand() * 2);
        s.vz = rand() * 2; s.dvz = (rand() - 0.5) * s.iz;
        s.light = 20 + rand() * 20; s.dlight = (rand() - 0.5) * (8 / W);
        s.lu = rand() * 8; s.lv = -1; s.dlu = 0;
        spans.push(s);
      }
      const { tsIdx, tsZb, wasmIdx, wasmZb, wasm } = runBoth(
        W, H, spans, fuzzTexture(rand, texW, texH), fuzzLight(rand, lw, lh), colormap,
      );
      if (wasm) wasmHits++;
      expect([...wasmIdx]).toEqual([...tsIdx]);
      expect([...wasmZb]).toEqual([...tsZb]);
    }
    // The wasm core must have run on the large majority of fuzz batches
    // (the rest legitimately take the TS fallback on out-of-range light).
    expect(wasmHits).toBeGreaterThan(150);
  });

  it('routes tiny batches through the TS fallback identically', () => {
    const rand = rng(0xBEEF);
    const colormap = gradeColormap();
    let fallbackHits = 0;
    for (let iter = 0; iter < 40; iter++) {
      const W = 8 + ((rand() * 24) | 0);
      const H = 4 + ((rand() * 12) | 0);
      const spans = fuzzBatch(rand, W, H, 8, 8);
      const wb = WasmSpanBackend.create(W, H)!;
      wb.attach(wb.idx, wb.zb, W, H, colormap);
      const tsIdx = new Uint8Array(W * H);
      const tsZb = new Float32Array(W * H);
      const ts = new SoftwareBackend();
      ts.attach(tsIdx, tsZb, W, H, colormap);
      const tex = fuzzTexture(rand, 8, 8);
      const light = fuzzLight(rand, 2, 2);
      ts.drawSpans({ spans, count: spans.length }, tex, light);
      const before = wb.fallbackBatches;
      wb.drawSpans({ spans, count: spans.length }, tex, light);
      if (wb.fallbackBatches > before) fallbackHits++;
      expect([...wb.idx]).toEqual([...tsIdx]);
      expect([...wb.zb]).toEqual([...tsZb]);
    }
    expect(fallbackHits).toBeGreaterThan(0);
  });

  it('matches on non-power-of-two textures and 1-wide blocks', () => {
    const rand = rng(1234);
    const colormap = gradeColormap();
    for (let iter = 0; iter < 30; iter++) {
      const W = 16 + ((rand() * 64) | 0);
      const H = 8 + ((rand() * 32) | 0);
      const texW = 3 + ((rand() * 40) | 0);
      const texH = 5 + ((rand() * 30) | 0);
      const spans = fuzzBatch(rand, W, H, texW, texH);
      const { tsIdx, tsZb, wasmIdx, wasmZb } = runBoth(
        W, H, spans, fuzzTexture(rand, texW, texH), fuzzLight(rand, 1, 1), colormap,
      );
      expect([...wasmIdx]).toEqual([...tsIdx]);
      expect([...wasmZb]).toEqual([...tsZb]);
    }
  });

  it('matches with the real palette-derived colormap', () => {
    const rand = rng(99);
    const colormap = buildColormap(defaultPalette());
    const W = 64, H = 48;
    const spans = fuzzBatch(rand, W, H, 32, 32);
    // force full light-block path on every span
    for (const s of spans) {
      if (s.kind === SPAN_OPAQUE) {
        s.lv = 2.5; s.lu = 3.25; s.dlu = 0.1; s.light = 40; s.dlight = 0.3;
      }
    }
    const { tsIdx, tsZb, wasmIdx, wasmZb } = runBoth(
      W, H, spans, fuzzTexture(rand, 32, 32), fuzzLight(rand, 8, 8), colormap,
    );
    expect([...wasmIdx]).toEqual([...tsIdx]);
    expect([...wasmZb]).toEqual([...tsZb]);
  });

  it('falls back to TS on out-of-range light without diverging', () => {
    const W = 128, H = 16;
    const colormap = gradeColormap();
    const texels = new Uint8Array(32 * 32).fill(7);
    const tex = { width: 32, height: 32, texels };
    const light = { width: 2, height: 2, values: new Uint8Array([10, 20, 30, 40]) };
    // light ramps to grade 70: unreachable in-engine, must take TS fallback.
    const s = createSpan();
    s.y = 3; s.x0 = 0; s.x1 = W; s.iz = 0.1;
    s.uz = 0; s.duz = 0.05; s.vz = 0; s.dvz = 0;
    s.light = 60; s.dlight = 0.5; s.lv = -1;
    const spans = [s];
    const tsIdx = new Uint8Array(W * H);
    const tsZb = new Float32Array(W * H);
    const ts = new SoftwareBackend();
    ts.attach(tsIdx, tsZb, W, H, colormap);
    ts.drawSpans({ spans, count: 1 }, tex, light);
    const wb = WasmSpanBackend.create(W, H)!;
    wb.attach(wb.idx, wb.zb, W, H, colormap);
    const before = wb.fallbackBatches;
    wb.drawSpans({ spans, count: 1 }, tex, light);
    expect(wb.fallbackBatches).toBe(before + 1);
    expect([...wb.idx]).toEqual([...tsIdx]);
    expect([...wb.zb]).toEqual([...tsZb]);
  });

  it('falls back to TS on oversize batches without diverging', () => {
    const W = 64, H = 16;
    const colormap = gradeColormap();
    // oversize texture forces the TS fallback path
    const texels = new Uint8Array(512 * 512).fill(7);
    const tex = { width: 512, height: 512, texels };
    const light = { width: 2, height: 2, values: new Uint8Array([10, 20, 30, 40]) };
    const spans: Span[] = [];
    for (let y = 0; y < H; y++) {
      const s = createSpan();
      s.y = y; s.x0 = 0; s.x1 = W; s.iz = 0.1;
      s.uz = 0; s.duz = 0.05; s.vz = 0; s.dvz = 0;
      s.light = 30; s.lv = -1;
      spans.push(s);
    }
    const { tsIdx, tsZb, wasmIdx, wasmZb } = runBoth(W, H, spans, tex, light, colormap);
    expect([...wasmIdx]).toEqual([...tsIdx]);
    expect([...wasmZb]).toEqual([...tsZb]);
  });

  it('renders the pinned devroom golden hash via the renderer', () => {
    const render = (useWasm: boolean): string => {
      const W = 320, H = 240;
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      if (useWasm) {
        expect(r.initWasm()).toBe(true);
        expect(r.setWasmEnabled(true)).toBe(true);
      }
      const pal = new Uint8Array(768);
      for (let i = 0; i < 256; i++) {
        pal[i * 3] = (i * 5) & 255;
        pal[i * 3 + 1] = (i * 3 + 40) & 255;
        pal[i * 3 + 2] = (i * 2 + 80) & 255;
      }
      r.setPalette(pal);
      const styles = new Float32Array(256).fill(1);
      styles[1] = 0.6;
      r.beginFrame();
      r.renderView(
        { origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles, fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: styles },
        { name: 'devroom', data: createDevroom() },
        [],
      );
      r.endFrame();
      const idx = r.getFramebuffer().index!;
      let h = 2166136261;
      for (let i = 0; i < idx.length; i++) {
        h ^= idx[i]!;
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16).padStart(8, '0');
    };
    expect(render(false)).toBe('8f61c755'); // pinned M3.1 golden, TS path
    expect(render(true)).toBe('8f61c755'); // wasm path byte-identical
  });

  it('can switch back to TS mid-stream without diverging', () => {
    const W = 160, H = 120;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    expect(r.initWasm()).toBe(true);
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = (i * 7) & 255;
      pal[i * 3 + 1] = (i * 5 + 9) & 255;
      pal[i * 3 + 2] = (i * 11 + 3) & 255;
    }
    r.setPalette(pal);
    const styles = new Float32Array(256).fill(1);
    const view = {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time: 0.5, lightStyles: styles,
    };
    const world = { name: 'devroom', data: createDevroom() };
    const hashes: string[] = [];
    for (const wasm of [false, true, false, true]) {
      expect(r.setWasmEnabled(wasm)).toBe(true);
      expect(r.isWasmActive()).toBe(wasm);
      r.beginFrame();
      r.renderView(view, world, []);
      r.endFrame();
      const idx = r.getFramebuffer().index!;
      let h = 2166136261;
      for (let i = 0; i < idx.length; i++) {
        h ^= idx[i]!;
        h = Math.imul(h, 16777619);
      }
      hashes.push((h >>> 0).toString(16).padStart(8, '0'));
      // host fb.index mirrors the live buffer either way
      expect([...fb.index!]).toEqual([...idx]);
    }
    expect(new Set(hashes).size).toBe(1);
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

describe.runIf(!!process.env.Q2_PAK)('wasm vs TS on real base1 (Q2_PAK)', () => {
  it('renders 4 real-map views byte-identical on both backends', { timeout: 300000 }, () => {
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
      const renders: { idx: Uint8Array; zb: Float32Array }[] = [];
      for (const useWasm of [false, true]) {
        const fb = createFramebuffer(W, H, true);
        const r = new SoftwareRenderer();
        r.init(fb);
        r.setPalette(pcx.palette);
        if (useWasm) {
          expect(r.initWasm()).toBe(true);
          expect(r.setWasmEnabled(true)).toBe(true);
        }
        r.beginFrame();
        r.renderView(refdef, { name: 'base1', data: world }, []);
        r.endFrame();
        const live = r.getFramebuffer();
        renders.push({ idx: live.index!.slice(), zb: live.depth!.slice() });
        if (useWasm) {
          const st = r.testWasmStats()!;
          const total = st.wasmBatches + st.fallbackBatches;
          console.log(
            `WASM base1 ${v.label}: wasm=${st.wasmBatches} fallback=${st.fallbackBatches} ` +
            `fast-path=${total > 0 ? ((100 * st.wasmBatches) / total).toFixed(1) : 'n/a'}%`,
          );
        }
      }
      expect([...renders[1]!.idx]).toEqual([...renders[0]!.idx]);
      expect([...renders[1]!.zb]).toEqual([...renders[0]!.zb]);
    }
  });
});

describe('wasm cvar wiring (opt-in, TS default)', () => {
  it('stays TS by default and follows sw_wasm', async () => {
    const { setCVar, resetCVars } = await import('@q2/config');
    const { wasmRequestedByCvar } = await import('./wasmSpans.js');
    try {
      const fb = createFramebuffer(64, 48, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      expect(r.isWasmActive()).toBe(false);
      expect(wasmRequestedByCvar()).toBe(false);
      r.syncWasmFromCvar(); // cvar 0 -> stays TS
      expect(r.isWasmActive()).toBe(false);
      setCVar('sw_wasm', 1);
      expect(wasmRequestedByCvar()).toBe(true);
      expect(r.syncWasmFromCvar()).toBe(true);
      expect(r.isWasmActive()).toBe(true);
      expect(r.testWasmStats()).not.toBeNull();
      setCVar('sw_wasm', 0);
      r.syncWasmFromCvar(); // back to TS
      expect(r.isWasmActive()).toBe(false);
    } finally {
      resetCVars();
    }
  });
});
