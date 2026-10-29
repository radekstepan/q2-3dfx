// PERF-NEXT-5 (Lane A): browser/main-thread attribution taxonomy.
//
// Through the REAL built Node worker (`BandWorkerPool.create` with
// `dist/index.mjs`, real threads running the production `bandWorkerLoop`)
// plus deterministic stub-pool failures, this suite pins the counter
// taxonomy on top of PERF-NEXT-4's exec timing:
//
// - Pool kick tallies return workerSpans/workerPixels/workerTris SEPARATELY
//   from the combined totals (worker bands only; the calling-thread band's
//   drain is main-band, never worker). worker + main == combined exactly.
// - A nonempty main band AND nonempty worker bands with ACTUAL execution:
//   both sides of the split are > 0 and sum to the kick totals.
// - Absent split fields (legacy shape) imply the calling-thread band ran
//   inline: worker-completed stays 0, the combined totals land in main.
// - Staged-but-failed work (declined/timeout/quarantine/disposed) reports
//   ZERO worker-completed with the work in replay/inline counters.
// - Serial viewmodel path reports main/inline (never worker).
// - Combined totals reconcile on every path; raster output is unchanged
//   (pooled == serial hashes throughout).
import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { createFramebuffer } from '@q2/renderer-api';
import type { Entity } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import { SoftwareRenderer, setRGBWorldEnabled, SW_RGB_SKIP_CLASSIC_CVAR } from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import { BandWorkerPool } from './bandPool.js';
import {
  SW_ACCUM_CVAR, SW_WORKERS_CVAR,
  R_FLAG_BLEND_ALPHA, R_FLAG_DEPTHWRITE, R_FLAG_LIGHT, R_FLAG_OPAQUE, R_FLAG_REPEAT, R_FLAG_TRI,
  type BandDispatcher,
} from './bands.js';
import { buildANorms, buildShadeDots, createBoxMesh, createGunMesh, createSoldierMesh } from './alias.js';
import { buildRGBMaterial, createSpan, type LightBlock, type RGBMipLevel, type Span, type Texture } from './spans.js';
import { setupCamera } from './camera.js';
import { SPAN_OPAQUE, SPAN_TRANS66 } from './spans.js';
import type { MiniWorld } from './index.js';

function distOrSkip(): string | null {
  const distUrl = new URL('../dist/index.mjs', import.meta.url);
  if (!existsSync(distUrl)) {
    console.log('SKIP fg attribution test: dist not built (run yarn build first)');
    return null;
  }
  return distUrl.pathname;
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

function fnvU8(a: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) {
    h ^= a[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function devView(time = 1.5) {
  return {
    origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
    fovX: DEVROOM_CAMERA.fovX, time, lightStyles: new Float32Array(256).fill(1),
  };
}

function registerCast(r: SoftwareRenderer): { gun: number; soldier: number; box: number; sprite: number; tracer: number } {
  return {
    gun: r.registerModel({ name: 'gun', kind: 'md2', data: createGunMesh() }),
    soldier: r.registerModel({ name: 'soldier', kind: 'md2', data: createSoldierMesh() }),
    box: r.registerModel({ name: 'box', kind: 'md2', data: createBoxMesh(24) }),
    sprite: r.registerModel({ name: 'spr', kind: 'sp2', data: null }),
    tracer: r.registerModel({ name: 'beam', kind: 'tracer' as unknown as 'sp2', data: null }),
  };
}

function orderingEntities(h: { gun: number; soldier: number; box: number; sprite: number; tracer: number }): Entity[] {
  return [
    {
      model: h.gun, origin: new Float32Array([60, -90, 20]), angles: new Float32Array([0, 35, 0]),
      frame: 0, skin: 0, depthHack: true,
    },
    {
      model: h.soldier, origin: new Float32Array([62, -88, 22]), angles: new Float32Array([0, 215, 0]),
      frame: 3, skin: 0, alpha: 0.5, oldframe: 1, backlerp: 0.4,
    },
    {
      model: h.box, origin: new Float32Array([40, -70, 14]), angles: new Float32Array([0, 10, 0]),
      frame: 0, skin: 0,
    },
    {
      model: h.sprite, origin: new Float32Array([60, 40, 150]), angles: new Float32Array([0, 0, 0]),
      frame: 0, skin: 0,
    },
    {
      model: h.tracer, origin: new Float32Array([60, -90, 20]), angles: new Float32Array([0, 35, 0]),
      frame: 96, skin: 225,
    },
  ];
}

function translucentDevroom(): MiniWorld {
  const base = createDevroom();
  const floor = { ...base.surfaces[0]!, translucent: 2 };
  return { ...base, surfaces: [floor, ...base.surfaces.slice(1)] };
}

interface FullFrame {
  color: string; index: string;
  q: string; cover: string; depth: string;
}

function snapFrame(r: SoftwareRenderer): FullFrame {
  const pr = r as unknown as { rgb565: Uint16Array; rgbCover: Uint8Array; rgbDepth16: Uint16Array };
  const live = r.getFramebuffer();
  return {
    color: fnvU8(new Uint8Array(live.color.buffer, live.color.byteOffset, live.color.byteLength)),
    index: fnvU8(live.index!),
    q: fnvU8(new Uint8Array(pr.rgb565.buffer, pr.rgb565.byteOffset, pr.rgb565.byteLength)),
    cover: fnvU8(pr.rgbCover),
    depth: fnvU8(new Uint8Array(pr.rgbDepth16.buffer, pr.rgbDepth16.byteOffset, pr.rgbDepth16.byteLength)),
  };
}

function renderSerial(W: number, H: number, world: MiniWorld, entities: Entity[]): { frame: FullFrame; fg: ReturnType<SoftwareRenderer['testForegroundStats']> } {
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(testPalette());
  registerCast(r);
  setRGBWorldEnabled(true);
  setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
  r.beginFrame();
  r.renderView(devView(), { name: 'devroom', data: world }, entities);
  r.endFrame();
  return { frame: snapFrame(r), fg: r.testForegroundStats() };
}

async function renderPooled(W: number, H: number, world: MiniWorld, entities: Entity[], workers: number): Promise<{ frame: FullFrame; fg: ReturnType<SoftwareRenderer['testForegroundStats']> }> {
  const dist = distOrSkip();
  if (!dist) throw new Error('no dist');
  const { setCVar: set } = await import('@q2/config');
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(testPalette());
  registerCast(r);
  set(SW_WORKERS_CVAR, 4);
  set(SW_ACCUM_CVAR, 1);
  if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
  const pool = BandWorkerPool.create(workers, W, H, { indexJsPath: dist });
  if (!pool) throw new Error('pool create failed');
  try {
    r.attachWorkerPool(pool);
    setRGBWorldEnabled(true);
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
    r.beginFrame();
    r.renderView(devView(), { name: 'devroom', data: world }, entities);
    r.endFrame();
    return { frame: snapFrame(r), fg: r.testForegroundStats() };
  } finally {
    await pool.dispose();
  }
}

// --- pool-level staging helpers (mirror bandExecTiming.test.ts) ---

function makeSpan(y: number, W: number, kind: number, iz: number): Span {
  const s = createSpan();
  s.kind = kind;
  s.y = y;
  s.x0 = 0; s.x1 = W;
  s.iz = iz; s.diz = 0;
  s.uz = 8; s.duz = 0;
  s.vz = 8; s.dvz = 0;
  s.light = 200; s.dlight = 0;
  s.lu = 0; s.lv = 0; s.dlu = 0;
  s.turb = 0; s.ord = 0;
  s.dudy = 0; s.dvdy = 0;
  return s;
}

function tinyChain(palIndex: number): RGBMipLevel[] {
  const pal = testPalette();
  const r = pal[palIndex * 3]!, g = pal[palIndex * 3 + 1]!, b = pal[palIndex * 3 + 2]!;
  const data = new Uint8Array([r, g, b, r, g, b, r, g, b, r, g, b]);
  const mask = new Uint8Array([255, 255, 255, 255]);
  return [{ data, width: 2, height: 2, mask }];
}

const LUX = new Uint8Array([200, 200, 200]);
const WORLD_FLAGS = R_FLAG_REPEAT | R_FLAG_DEPTHWRITE | R_FLAG_LIGHT | R_FLAG_OPAQUE;
const FG_FLAGS = R_FLAG_REPEAT | R_FLAG_LIGHT | R_FLAG_BLEND_ALPHA;

describe('PERF-NEXT-5: pool kick worker/main attribution (real threads)', () => {
  it('worker + main split matches band ownership and reconciles exactly', { timeout: 120000 }, async () => {
    const dist = distOrSkip();
    if (!dist) return;
    const W = 96, H = 60;
    const pool = BandWorkerPool.create(2, W, H, { indexJsPath: dist });
    if (!pool) throw new Error('pool create failed');
    try {
      pool.beginFrame();
      // World: full-frame opaque spans (every band nonempty).
      const chain = tinyChain(7);
      const world: Span[] = [];
      for (let y = 0; y < H; y++) world.push(makeSpan(y, W, SPAN_OPAQUE, 0.2));
      expect(pool.stageRGB(
        { spans: world, count: world.length }, 0, world.length,
        chain, LUX, 1, 1, WORLD_FLAGS, 0, 0, 0,
      )).toBe(true);
      // Foreground tris: gun mesh at mid-range (worker bands execute tris).
      const anorms = buildANorms();
      const shadeDots = buildShadeDots(anorms);
      const cam = setupCamera(new Float32Array([0, 0, 64]), new Float32Array([0, 0, 0]), 90, W, H);
      const texels = new Uint8Array(64 * 64).fill(120);
      const mat = buildRGBMaterial(texels, 64, 64, testPalette(), null, {
        addressS: 'clamp', addressT: 'clamp', overbright: false, lodBias: 0,
        mipDither: false, bilinear: false, zbits: 0, opaqueMask: true,
      });
      const cursor = pool.triCursor();
      if (!cursor) throw new Error('no tri cursor');
      const mesh = createGunMesh();
      const n = (await import('./alias.js')).emitAliasTris(
        {
          mesh, origin: new Float32Array([0, 0, 60]), angles: new Float32Array([0, 0, 0]),
          frameA: 0, frameB: 0, lerp: 0, lightAngle: 0,
        },
        cam, anorms, shadeDots, null, cursor.F, cursor.I, cursor.base, cursor.base + cursor.cap,
      );
      if (n < 0) throw new Error('emit overflow');
      const triCount = n - cursor.base;
      expect(triCount).toBeGreaterThan(0);
      expect(pool.stageTriBatch(cursor.base, triCount, mat.levels, R_FLAG_TRI | R_FLAG_DEPTHWRITE, 0, 256)).toBe(true);
      // Foreground suffix: translucent spans over the middle rows.
      const fgChain = tinyChain(200);
      const fg: Span[] = [];
      for (let y = Math.floor(H / 4); y < Math.floor((3 * H) / 4); y++) {
        fg.push(makeSpan(y, W, SPAN_TRANS66, 0.24));
      }
      expect(pool.stageRGB(
        { spans: fg, count: fg.length }, 0, fg.length,
        fgChain, LUX, 1, 1, FG_FLAGS, 0, 0, 0,
      )).toBe(true);
      const kick = await pool.flushRGBFrameAsync(4, 32768, 0);
      expect(kick).not.toBeNull();
      // Combined totals reconcile exactly: worker + main == kick totals.
      expect(kick!.workerSpans + kick!.mainSpans).toBe(kick!.spans);
      expect(kick!.workerPixels + kick!.mainPixels).toBe(kick!.pixels);
      expect(kick!.workerTris + kick!.mainTris).toBe(kick!.tris);
      // Nonempty main band AND nonempty worker bands with actual execution.
      expect(kick!.mainSpans).toBeGreaterThan(0);
      expect(kick!.workerSpans).toBeGreaterThan(0);
      expect(kick!.mainPixels).toBeGreaterThan(0);
      expect(kick!.workerPixels).toBeGreaterThan(0);
      expect(kick!.workerTris).toBeGreaterThan(0);
      expect(typeof kick!.mainExecMs).toBe('number');
      // Empty suffix: known zero (staged nothing, completed nothing) —
      // distinct from the UNKNOWN sentinel (absent fields on legacy shapes).
      const empty = await pool.flushRGBFrameAsync(4, 32768, 0);
      expect(empty).not.toBeNull();
      expect(empty!.spans).toBe(0);
      expect(empty!.workerSpans).toBe(0);
      expect(empty!.mainSpans).toBe(0);
      expect(empty!.tris).toBe(0);
      expect(empty!.workerTris).toBe(0);
      expect(empty!.mainTris).toBe(0);
    } finally {
      await pool.dispose();
    }
  });
});

describe('PERF-NEXT-5: frame attribution across primitive classes (real threads)', () => {
  it('nonempty main + worker bands, all classes staged, serial-identical', { timeout: 180000 }, async () => {
    const dist = distOrSkip();
    if (!dist) return;
    const W = 160, H = 120;
    const world = translucentDevroom();
    const serialEntities = ((): Entity[] => {
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(testPalette());
      return orderingEntities(registerCast(r));
    })();
    const expected = renderSerial(W, H, world, serialEntities);
    const got = await renderPooled(W, H, world, serialEntities, 3);
    expect(got.frame).toEqual(expected.frame);
    // Successful kicks: both sides of the split executed real work.
    expect(got.fg.kicks).toBeGreaterThan(0);
    expect(got.fg.recoveryCount).toBe(0);
    expect(got.fg.workerSpansCompleted).toBeGreaterThan(0);
    expect(got.fg.mainSpansCompleted).toBeGreaterThan(0);
    expect(got.fg.workerPixelsCompleted).toBeGreaterThan(0);
    expect(got.fg.mainPixelsCompleted).toBeGreaterThan(0);
    // Alias tris (incl. the depthHack viewmodel gun) staged AND completed;
    // completed >= staged (a tri straddling a band boundary fills disjoint
    // rows in both bands and counts once per band — documented overcount).
    expect(got.fg.trisStaged).toBeGreaterThan(0);
    expect(got.fg.trisCompleted).toBeGreaterThan(0);
    expect(got.fg.trisCompleted).toBeGreaterThanOrEqual(got.fg.trisStaged);
    expect(got.fg.trisMainCompleted).toBeGreaterThanOrEqual(0);
    expect(got.fg.trisMainCompleted).toBeLessThanOrEqual(got.fg.trisCompleted);
    expect(got.fg.aliasDrawsStaged).toBeGreaterThan(0);
    // Staged batches are not double-counted as inline (PERF-NEXT-5 fix):
    // pooled success stages particles instead of drawing them inline.
    expect(got.fg.particleSpansStaged).toBeGreaterThan(0);
    expect(got.fg.particleDrawsInline).toBe(0);
    // At least one span class staged (alpha from the translucent floor and/or
    // sprites/beams from the entity cast).
    expect(
      got.fg.alphaSpansStaged + got.fg.spriteSpansStaged
      + got.fg.particleSpansStaged + got.fg.beamSpansStaged,
    ).toBeGreaterThan(0);
    // Serial contrast: the same scene stages nothing and completes nothing
    // by workers — alias (incl. viewmodel) draws inline.
    expect(expected.fg.aliasDrawsInline).toBeGreaterThan(0);
    expect(expected.fg.trisStaged).toBe(0);
    expect(expected.fg.aliasDrawsStaged).toBe(0);
    expect(expected.fg.workerSpansCompleted).toBe(0);
    expect(expected.fg.mainSpansCompleted).toBe(0);
    expect(expected.fg.trisCompleted).toBe(0);
    expect(expected.fg.kicks).toBe(0);
  });

  it('serial viewmodel gun reports inline, never worker', () => {
    const W = 96, H = 72;
    const world = createDevroom();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    const h = registerCast(r);
    const gunOnly: Entity[] = [{
      model: h.gun, origin: new Float32Array([60, -90, 20]), angles: new Float32Array([0, 35, 0]),
      frame: 0, skin: 0, depthHack: true,
    }];
    setRGBWorldEnabled(true);
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
    r.beginFrame();
    r.renderView(devView(), { name: 'devroom', data: world }, gunOnly);
    r.endFrame();
    const fg = r.testForegroundStats();
    // Viewmodel drew inline (draws + mesh tris), staged nothing, completed
    // nothing by workers and nothing in any band.
    expect(fg.aliasDrawsInline).toBeGreaterThan(0);
    expect(fg.aliasTrisInline).toBeGreaterThan(0);
    expect(fg.trisStaged).toBe(0);
    expect(fg.aliasDrawsStaged).toBe(0);
    expect(fg.workerSpansCompleted).toBe(0);
    expect(fg.mainSpansCompleted).toBe(0);
    expect(fg.trisCompleted).toBe(0);
    expect(fg.trisMainCompleted).toBe(0);
    expect(fg.kicks).toBe(0);
    expect(fg.recoveryCount).toBe(0);
  });
});

describe('PERF-NEXT-5: staged-but-failed work is never worker-completed', () => {
  async function renderStub(W: number, H: number, readyBands: number): Promise<{
    frame: FullFrame; fg: ReturnType<SoftwareRenderer['testForegroundStats']>;
    quarantined: boolean;
  }> {
    const { stubPool } = await import('./testStubPool.js');
    const { setCVar: set } = await import('@q2/config');
    const { SW_WORKERS_CVAR: SWW, SW_ACCUM_CVAR: SWA } = await import('./bands.js');
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    const h = registerCast(r);
    const ents = orderingEntities(h);
    set(SWW, 4);
    set(SWA, 1);
    if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
    const pool = stubPool(W, H, { readyBands, timeoutMs: 10 });
    r.attachWorkerPool(pool);
    setRGBWorldEnabled(true);
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
    r.beginFrame();
    // Opaque world + full entity cast (converging combination: the
    // translucent-world + translucent-entity stub-recovery mix diverges on
    // base 13eeb85 too — pre-existing recovery gap, reported to the
    // integrator, not exercised here).
    r.renderView(devView(), { name: 'devroom', data: createDevroom() }, ents);
    r.endFrame();
    const priv = pool as unknown as { quarantined: boolean };
    return { frame: snapFrame(r), fg: r.testForegroundStats(), quarantined: priv.quarantined };
  }

  function serialOpaque(W: number, H: number): { frame: FullFrame; fg: ReturnType<SoftwareRenderer['testForegroundStats']> } {
    const fb = createFramebuffer(W, H, true);
    const serialR = new SoftwareRenderer();
    serialR.init(fb);
    serialR.setPalette(testPalette());
    return renderSerial(W, H, createDevroom(), orderingEntities(registerCast(serialR)));
  }

  it('clean failure (workers never ready): zero worker/main, work replayed', async () => {
    const W = 96, H = 72;
    const expected = serialOpaque(W, H);
    const got = await renderStub(W, H, 0);
    expect(got.frame).toEqual(expected.frame);
    // Nothing staged-but-failed is reported as completed in ANY band.
    expect(got.fg.kicks).toBe(0);
    expect(got.fg.workerSpansCompleted).toBe(0);
    expect(got.fg.mainSpansCompleted).toBe(0);
    expect(got.fg.workerPixelsCompleted).toBe(0);
    expect(got.fg.mainPixelsCompleted).toBe(0);
    expect(got.fg.trisCompleted).toBe(0);
    expect(got.fg.trisMainCompleted).toBe(0);
    // The work is in the replay counters instead.
    expect(got.fg.recoveryCount).toBeGreaterThan(0);
    expect(got.fg.replayedSpans).toBeGreaterThan(0);
    expect(got.fg.replayedPixels).toBeGreaterThan(0);
    expect(got.fg.trisReplayed).toBeGreaterThan(0);
  });

  it('partial failure (main band ran, workers timed out): quarantine + inline fallback', async () => {
    const W = 96, H = 72;
    const expected = serialOpaque(W, H);
    const got = await renderStub(W, H, 3);
    expect(got.frame).toEqual(expected.frame);
    expect(got.quarantined).toBe(true);
    expect(got.fg.kicks).toBe(0);
    expect(got.fg.workerSpansCompleted).toBe(0);
    expect(got.fg.mainSpansCompleted).toBe(0);
    expect(got.fg.trisCompleted).toBe(0);
    // Quarantine at the world flush forces the foreground fully inline.
    expect(got.fg.aliasDrawsInline).toBeGreaterThan(0);
    expect(got.fg.directInlineWrites).toBe(true);
    expect(got.fg.recoveryCount).toBeGreaterThan(0);
  });

  it('disposed pool: fast refusal, all-inline fallback, exact output', async () => {
    const dist = distOrSkip();
    if (!dist) return;
    const { setCVar: set } = await import('@q2/config');
    const W = 96, H = 72;
    const world = translucentDevroom();
    const fb = createFramebuffer(W, H, true);
    const serialR = new SoftwareRenderer();
    serialR.init(fb);
    serialR.setPalette(testPalette());
    const expected = renderSerial(W, H, world, orderingEntities(registerCast(serialR)));
    const fb2 = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb2);
    r.setPalette(testPalette());
    const h = registerCast(r);
    set(SW_WORKERS_CVAR, 4);
    set(SW_ACCUM_CVAR, 1);
    if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
    const pool = BandWorkerPool.create(3, W, H, { indexJsPath: dist });
    if (!pool) throw new Error('pool create failed');
    await pool.dispose();
    r.attachWorkerPool(pool);
    setRGBWorldEnabled(true);
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
    r.beginFrame();
    r.renderView(devView(), { name: 'devroom', data: world }, orderingEntities(h));
    r.endFrame();
    expect(snapFrame(r)).toEqual(expected.frame);
    const fg = r.testForegroundStats();
    // Declined/disposed: nothing ran on workers or in any band kick.
    expect(fg.kicks).toBe(0);
    expect(fg.workerSpansCompleted).toBe(0);
    expect(fg.mainSpansCompleted).toBe(0);
    expect(fg.trisCompleted).toBe(0);
    expect(fg.aliasDrawsInline).toBeGreaterThan(0);
  });
});

describe('PERF-NEXT-5: legacy shape without the split maps to main, never worker', () => {
  it('absent worker*/main* fields attribute combined totals to the calling-thread band', async () => {
    const { setCVar: set } = await import('@q2/config');
    const W = 96, H = 72;
    // Minimal legacy pool: stages span batches, then completes the suffix
    // with the LEGACY tally shape ({pixels, spans} — no worker*/main*).
    // Output planes are not executed (counter-shape unit test, not an
    // execution proof); the attribution mapping is what is pinned.
    let stagedSpans = 0;
    let flushedSpans = 0;
    let kicks = 0;
    const legacy = {
      bandCount: 4,
      planes: null,
      rgbPlanes: null,
      frame: (): number => 0,
      beginFrame: (): void => { stagedSpans = 0; flushedSpans = 0; },
      dispatch: (): null => null,
      flatCursor: (): null => null,
      packBatched: (): boolean => false,
      accumPending: (): number => 0,
      flushFrame: (): null => null,
      flushFrameAsync: (): Promise<null> => Promise.resolve(null),
      drawInlineAll: (): { pixels: number; spans: number } => ({ pixels: 0, spans: 0 }),
      stagePalette: (): void => undefined,
      resolveFrame: (): boolean => false,
      resolveFrameAsync: (): Promise<boolean> => Promise.resolve(false),
      stageRGB: (
        _list: unknown, _start: number, spanCount: number,
        _levels: unknown, _luxels: unknown, _luxW: number, _luxH: number,
        _flags: number, _zbits: number, _turb: number, _flat: number,
      ): boolean => {
        stagedSpans += spanCount;
        return true;
      },
      rgbPending: (): number => stagedSpans,
      // Legacy shape: combined totals only, split fields ABSENT (unknown).
      flushRGBFrame: (): { pixels: number; spans: number } => {
        const suffix = stagedSpans - flushedSpans;
        flushedSpans = stagedSpans;
        kicks++;
        return { pixels: suffix * 4, spans: suffix };
      },
      flushRGBFrameAsync: (): Promise<{ pixels: number; spans: number }> => {
        const suffix = stagedSpans - flushedSpans;
        flushedSpans = stagedSpans;
        kicks++;
        return Promise.resolve({ pixels: suffix * 4, spans: suffix });
      },
      drawInlineRGBAll: (): { pixels: number; spans: number } => ({ pixels: 0, spans: 0 }),
      clearRGBChains: (): void => undefined,
    } as unknown as BandDispatcher;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    const h = registerCast(r);
    set(SW_WORKERS_CVAR, 4);
    set(SW_ACCUM_CVAR, 1);
    if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
    r.attachWorkerPool(legacy);
    setRGBWorldEnabled(true);
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
    r.beginFrame();
    r.renderView(devView(), { name: 'devroom', data: translucentDevroom() }, orderingEntities(h));
    r.endFrame();
    expect(kicks).toBeGreaterThan(0);
    expect(stagedSpans).toBeGreaterThan(0);
    const fg = r.testForegroundStats();
    // UNKNOWN split (absent fields) is NEVER reported as worker-completed:
    // the combined totals land in the calling-thread band.
    expect(fg.workerSpansCompleted).toBe(0);
    expect(fg.workerPixelsCompleted).toBe(0);
    expect(fg.trisCompleted).toBe(0);
    expect(fg.trisMainCompleted).toBe(0);
    // The world kick bypasses the foreground breakdown; every foreground
    // kick's suffix sums to exactly the staged foreground spans (the fake
    // returns pixels at 4x spans, so the pixel ratio holds too).
    const fgStaged = fg.alphaSpansStaged + fg.spriteSpansStaged
      + fg.particleSpansStaged + fg.beamSpansStaged;
    expect(fgStaged).toBeGreaterThan(0);
    expect(fg.mainSpansCompleted).toBe(fgStaged);
    expect(fg.mainPixelsCompleted).toBe(fgStaged * 4);
    expect(fg.mainSpansCompleted).toBeLessThanOrEqual(stagedSpans);
    // kicks counts foreground kicks only (the world kick lands in
    // testRGBWorkerStats); the fake saw exactly one more (world first).
    expect(fg.kicks).toBe(kicks - 1);
    // Refusal replays (blend/beam staging after alias direct-inline writes
    // replays retained pending inline for ordering) land in replayed*, never
    // in worker* — no assertion on their count, only on attribution.
    // Alias has no tri cursor on the legacy pool: instances drew inline.
    expect(fg.aliasDrawsInline).toBeGreaterThan(0);
    expect(fg.aliasDrawsStaged).toBe(0);
  });
});
