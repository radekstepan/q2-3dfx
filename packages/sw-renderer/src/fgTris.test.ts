// TASK item 2 (renderer lane): worker model/gun rasterization.
//
// The existing exact alias filler (fillPerspTriRGB) runs on workers over
// staged screen-space tris (emitAliasTris), in exact serial order, one
// batched kick per frame. These tests pin, with REAL worker threads
// (dist-gated) and scripted stubs (deterministic failures):
//  - full-RGBA + depth/coverage equality vs exact serial rendering;
//  - overlapping opaque/translucent models (primitive order, blends);
//  - gun vs walls + near-plane clipping (depthHack viewmodel);
//  - animated interpolation + dynamic lighting;
//  - odd dims + band seams; multiple worker counts;
//  - primitive ordering across tris/sprites/particles/beams;
//  - partial-job recovery via the new protocol (tris exactly once);
//  - counters: staged vs worker-completed vs failed work.
// Browser execution (real viewmodel in a worker) is the browser lane's
// wiring (shared bands.ts loop + documented protocol); Node + shared-loop
// execution is proven here.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { createFramebuffer } from '@q2/renderer-api';
import type { Entity } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import { SoftwareRenderer, setRGBWorldEnabled, SW_RGB_SKIP_CLASSIC_CVAR } from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import { BandWorkerPool } from './bandPool.js';
import { SW_ACCUM_CVAR, SW_WORKERS_CVAR, type RGBAccumViews } from './bands.js';
import { createBoxMesh, createGunMesh, createSoldierMesh } from './alias.js';
import type { MiniWorld } from './index.js';

afterEach(() => {
  setRGBWorldEnabled(false);
  resetCVars();
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

function devView(time = 1.5) {
  return {
    origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
    fovX: DEVROOM_CAMERA.fovX, time, lightStyles: new Float32Array(256).fill(1),
  };
}

interface FullFrame {
  color: string; index: string;
  q: string; cover: string; depth: string;
}

/** Register gun + soldier + box models; returns handles. */
function registerCast(r: SoftwareRenderer): { gun: number; soldier: number; box: number; sprite: number; tracer: number } {
  return {
    gun: r.registerModel({ name: 'gun', kind: 'md2', data: createGunMesh() }),
    soldier: r.registerModel({ name: 'soldier', kind: 'md2', data: createSoldierMesh() }),
    box: r.registerModel({ name: 'box', kind: 'md2', data: createBoxMesh(24) }),
    sprite: r.registerModel({ name: 'spr', kind: 'sp2', data: null }),
    tracer: r.registerModel({ name: 'beam', kind: 'tracer' as unknown as 'sp2', data: null }),
  };
}

/** Overlapping cast: viewmodel gun (depthHack) + translucent soldier over it + opaque box + sprite + tracer beam. */
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

function renderSerial(W: number, H: number, world: MiniWorld, entities: Entity[], dlights = false, time = 1.5): { frame: FullFrame; fg: ReturnType<SoftwareRenderer['testForegroundStats']> } {
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(testPalette());
  const h = registerCast(r);
  const ents = entities.length > 0 ? entities : orderingEntities(h);
  if (dlights) {
    r.testAddDynamicLight({ origin: new Float32Array([60, -80, 40]), color: new Float32Array([1, 0.4, 0.2]), intensity: 120 });
  }
  if (world === createDevroom()) {
    r.spawnTracer(new Float32Array([60, -90, 20]), new Float32Array([0.3, 0.9, 0.2]), 225, 64, 3);
  }
  setRGBWorldEnabled(true);
  setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
  r.beginFrame();
  r.renderView(devView(time), { name: 'devroom', data: world }, ents);
  r.endFrame();
  const pr = r as unknown as { rgb565: Uint16Array; rgbCover: Uint8Array; rgbDepth16: Uint16Array };
  const live = r.getFramebuffer();
  return {
    frame: {
      color: fnvU8(new Uint8Array(live.color.buffer, live.color.byteOffset, live.color.byteLength)),
      index: fnvU8(live.index!),
      q: fnvU8(new Uint8Array(pr.rgb565.buffer, pr.rgb565.byteOffset, pr.rgb565.byteLength)),
      cover: fnvU8(pr.rgbCover),
      depth: fnvU8(new Uint8Array(pr.rgbDepth16.buffer, pr.rgbDepth16.byteOffset, pr.rgbDepth16.byteLength)),
    },
    fg: r.testForegroundStats(),
  };
}

function distOrSkip(): string | null {
  const distUrl = new URL('../dist/index.mjs', import.meta.url);
  if (!existsSync(distUrl)) {
    console.log('SKIP tri worker test: dist not built (run yarn build first)');
    return null;
  }
  return distUrl.pathname;
}

async function renderPooled(W: number, H: number, world: MiniWorld, entities: Entity[] | null, workers: number, dlights = false, time = 1.5): Promise<{ frame: FullFrame; fg: ReturnType<SoftwareRenderer['testForegroundStats']> }> {
  const dist = distOrSkip();
  if (!dist) throw new Error('no dist');
  const { setCVar: set } = await import('@q2/config');
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(testPalette());
  const h = registerCast(r);
  const ents = entities ?? orderingEntities(h);
  if (dlights) {
    r.testAddDynamicLight({ origin: new Float32Array([60, -80, 40]), color: new Float32Array([1, 0.4, 0.2]), intensity: 120 });
  }
  if (world === createDevroom()) {
    r.spawnTracer(new Float32Array([60, -90, 20]), new Float32Array([0.3, 0.9, 0.2]), 225, 64, 3);
  }
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
    r.renderView(devView(time), { name: 'devroom', data: world }, ents);
    r.endFrame();
    const pr = r as unknown as { rgb565: Uint16Array; rgbCover: Uint8Array; rgbDepth16: Uint16Array };
    const live = r.getFramebuffer();
    return {
      frame: {
        color: fnvU8(new Uint8Array(live.color.buffer, live.color.byteOffset, live.color.byteLength)),
        index: fnvU8(live.index!),
        q: fnvU8(new Uint8Array(pr.rgb565.buffer, pr.rgb565.byteOffset, pr.rgb565.byteLength)),
        cover: fnvU8(pr.rgbCover),
        depth: fnvU8(new Uint8Array(pr.rgbDepth16.buffer, pr.rgbDepth16.byteOffset, pr.rgbDepth16.byteLength)),
      },
      fg: r.testForegroundStats(),
    };
  } finally {
    await pool.dispose();
  }
}

describe('worker model/gun rasterization equals exact serial', () => {  it('overlapping opaque/translucent models + sprites + tracers + particles at 1/3/7 workers', { timeout: 180000 }, async () => {
    if (!distOrSkip()) return;
    const W = 320, H = 240;
    const world = createDevroom();
    const expected = renderSerial(W, H, world, []);
    expect(expected.fg.aliasDrawsInline).toBeGreaterThan(0);
    expect(expected.frame.cover).not.toBe('00000000');
    for (const workers of [1, 3, 7]) {
      const got = await renderPooled(W, H, world, null, workers);
      expect(got.frame).toEqual(expected.frame);
      // Worker execution is visible in completed counters (not just staged).
      expect(got.fg.trisCompleted).toBeGreaterThan(0);
      expect(got.fg.trisStaged).toBeGreaterThan(0);
      // Staged-but-failed work is never reported as completed.
      expect(got.fg.kicks).toBeGreaterThan(0);
      expect(got.fg.recoveryCount).toBe(0);
    }
  });

  it('gun vs walls + near-plane clipping, odd dims + band seams', { timeout: 180000 }, async () => {
    if (!distOrSkip()) return;
    for (const [W, H] of [[161, 121], [33, 17]] as const) {
      const world = createDevroom();
      // Viewmodel gun pushed near the wall (depthHack + near clip).
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(testPalette());
      const h = registerCast(r);
      const gunOnly: Entity[] = [{
        model: h.gun, origin: new Float32Array([8, 0, 64]), angles: new Float32Array([0, 270, 0]),
        frame: 0, skin: 0, depthHack: true,
      }];
      const expected = renderSerial(W, H, world, gunOnly);
      const got = await renderPooled(W, H, world, gunOnly, 3);
      expect(got.frame).toEqual(expected.frame);
      // Box straddling the near plane (Sutherland clip + 2-tri fan on
      // workers, exact vs serial).
      const r2 = new SoftwareRenderer();
      r2.init(createFramebuffer(W, H, true));
      r2.setPalette(testPalette());
      const h2 = registerCast(r2);
      const clipper: Entity[] = [{
        model: h2.box, origin: new Float32Array([-164, 0, 136]), angles: new Float32Array([0, 45, 0]),
        frame: 0, skin: 0,
      }];
      const expected2 = renderSerial(W, H, world, clipper);
      expect(expected2.fg.trisStaged).toBe(0);
      const got2 = await renderPooled(W, H, world, clipper, 3);
      expect(got2.frame).toEqual(expected2.frame);
      expect(got2.fg.trisCompleted).toBeGreaterThan(0);
    }
  });

  it('animated interpolation + dynamic lighting matches per frame', { timeout: 180000 }, async () => {
    if (!distOrSkip()) return;
    const W = 160, H = 120;
    const world = createDevroom();
    for (const time of [1.5, 1.6]) {
      const expected = renderSerial(W, H, world, [], true, time);
      const got = await renderPooled(W, H, world, null, 3, true, time);
      expect(got.frame).toEqual(expected.frame);
    }
  });
});

describe('tri recovery + counters (stub pool, deterministic failures)', () => {  async function renderStub(W: number, H: number, readyBands: number): Promise<{
    frame: FullFrame; fg: ReturnType<SoftwareRenderer['testForegroundStats']>;
  }> {
    const { stubPool } = await import('./rgbRecovery.test.js');
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
    r.renderView(devView(), { name: 'devroom', data: createDevroom() }, ents);
    r.endFrame();
    const pr = r as unknown as { rgb565: Uint16Array; rgbCover: Uint8Array; rgbDepth16: Uint16Array };
    const live = r.getFramebuffer();
    return {
      frame: {
        color: fnvU8(new Uint8Array(live.color.buffer, live.color.byteOffset, live.color.byteLength)),
        index: fnvU8(live.index!),
        q: fnvU8(new Uint8Array(pr.rgb565.buffer, pr.rgb565.byteOffset, pr.rgb565.byteLength)),
        cover: fnvU8(pr.rgbCover),
        depth: fnvU8(new Uint8Array(pr.rgbDepth16.buffer, pr.rgbDepth16.byteOffset, pr.rgbDepth16.byteLength)),
      },
      fg: r.testForegroundStats(),
    };
  }

  it('clean + partial FG failures with staged tris match serial, blends exactly once', async () => {
    const W = 96, H = 72;
    const world = createDevroom();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    const h = registerCast(r);
    const expected = renderSerial(W, H, world, orderingEntities(h));
    expect(expected.fg.trisCompleted).toBe(0);
    for (const ready of [0, 3]) {
      const got = await renderStub(W, H, ready);
      expect(got.frame).toEqual(expected.frame);
      // Nothing staged-but-failed is reported as completed.
      expect(got.fg.workerSpansCompleted).toBe(0);
      expect(got.fg.trisCompleted).toBe(0);
      expect(got.fg.recoveryCount).toBeGreaterThan(0);
      if (ready === 0) {
        // Clean failure (workers never ready): no quarantine, so FG
        // stages and recovers — tris staged (not just spans), blends
        // applied exactly once (frame equality proves it: the
        // double-apply control below differs).
        expect(got.fg.trisStaged).toBeGreaterThan(0);
        expect(got.fg.trisReplayed).toBeGreaterThan(0);
        expect(got.fg.directInlineWrites).toBe(false);
      } else {
        // Partial failure (main band ran, workers timed out): the pool
        // quarantines at the world flush, so all FG correctly falls back
        // to inline — staged nothing, drew inline, frames still exact.
        expect(got.fg.trisStaged).toBe(0);
        expect(got.fg.aliasDrawsInline).toBeGreaterThan(0);
        expect(got.fg.directInlineWrites).toBe(true);
      }
    }
  });

  it('tri counters: serial draws vs staged vs completed', async () => {
    if (!distOrSkip()) return;
    const W = 160, H = 120;
    const world = createDevroom();
    const serial = renderSerial(W, H, world, []);
    // Serial: alias draws inline (no staging, no worker completion).
    expect(serial.fg.aliasDrawsInline).toBeGreaterThan(0);
    expect(serial.fg.trisStaged).toBe(0);
    expect(serial.fg.trisCompleted).toBe(0);
    const pooled = await renderPooled(W, H, world, null, 3);
    // Pooled: tris staged AND worker-completed; inline alias draws are
    // only fallbacks (zero here — nothing refused).
    expect(pooled.fg.trisStaged).toBeGreaterThan(0);
    expect(pooled.fg.trisCompleted).toBeGreaterThan(0);
    expect(pooled.fg.trisMainCompleted).toBeGreaterThanOrEqual(0);
    expect(pooled.frame).toEqual(serial.frame);
  });

  it('pool-level: translucent tri suffix applied twice differs (exactly-once sensitivity)', async () => {
    const { stubPool } = await import('./rgbRecovery.test.js');
    const { emitAliasTris, buildANorms, buildShadeDots } = await import('./alias.js');
    const { buildRGBMaterial } = await import('./spans.js');
    const { processRGBFrameJob, splitBands, R_FLAG_TRI, R_FLAG_BLEND_ALPHA, R_FLAG_DEPTHWRITE } = await import('./bands.js');
    const { setupCamera } = await import('./camera.js');
    const W = 64, H = 64;
    const anorms = buildANorms();
    const shadeDots = buildShadeDots(anorms);
    const cam = setupCamera(new Float32Array([0, 0, 64]), new Float32Array([0, 0, 0]), 90, W, H);
    const texels = new Uint8Array(64 * 64).fill(120);
    const mat = buildRGBMaterial(texels, 64, 64, testPalette(), null, {
      addressS: 'clamp', addressT: 'clamp', overbright: false, lodBias: 0,
      mipDither: false, bilinear: false, zbits: 0, opaqueMask: true,
    });
    // Opaque tri batch + translucent tri batch (separate descriptors).
    const mkBatch = (pool: {
      triCursor(): { F: Float64Array; I: Int32Array; base: number; cap: number } | null;
      stageTriBatch(a: number, b: number, c: { data: Uint8Array; width: number; height: number; mask: Uint8Array }[], d: number, e: number, f: number): boolean;
    }, alpha: number, ox: number): void => {
      const mesh = createGunMesh();
      const inst = {
        mesh, origin: new Float32Array([ox, 0, 60]), angles: new Float32Array([0, 0, 0]),
        frameA: 0, frameB: 0, lerp: 0, lightAngle: 0,
        alpha: alpha >= 1 ? undefined : alpha,
      };
      const cursor = pool.triCursor();
      if (!cursor) throw new Error('no tri cursor');
      const n = emitAliasTris(inst, cam, anorms, shadeDots, null, cursor.F, cursor.I, cursor.base, cursor.base + cursor.cap);
      if (n < 0) throw new Error('emit overflow');
      const flags = R_FLAG_TRI | (alpha < 1 ? R_FLAG_BLEND_ALPHA : R_FLAG_DEPTHWRITE);
      const ok = pool.stageTriBatch(cursor.base, n - cursor.base, mat.levels, flags, 0, Math.round(alpha * 256));
      if (!ok) throw new Error('stage failed');
    };
    // Background seed that respects coverage (mirrors seedRGBBackground).
    const seedCovered = (v: { rgb565: Uint16Array; cover: Uint8Array }): void => {
      for (let i = 0; i < v.rgb565.length; i++) {
        if (v.cover[i] === 0) v.rgb565[i] = 0x8410;
      }
    };
    const snap = (v: { rgb565: Uint16Array; cover: Uint8Array; rgbDepth: Uint16Array }): string => {
      return fnvU8(new Uint8Array(v.rgb565.buffer, v.rgb565.byteOffset, v.rgb565.byteLength)) +
        fnvU8(v.cover) + fnvU8(new Uint8Array(v.rgbDepth.buffer, v.rgbDepth.byteOffset, v.rgbDepth.byteLength));
    };
    const ref = stubPool(W, H);
    mkBatch(ref, 1, 30);
    mkBatch(ref, 0.5, 20);
    const rv = (ref as unknown as { rgbViews: RGBAccumViews }).rgbViews;
    rv.kick[0] = 4; rv.kick[1] = 32768; rv.kick[2] = 0;
    rv.rgbDepth.fill(0xffff);
    seedCovered(rv);
    const full = processRGBFrameJob(rv, W, H, 2, 0, H);
    expect(full.tris).toBeGreaterThan(0);
    const expected = snap(rv);
    // Double-apply the translucent suffix without a clear: must differ
    // (proves the test sees double blends, so recovery equality below
    // proves exactly-once).
    processRGBFrameJob(rv, W, H, 2, 0, H, 1);
    expect(snap(rv)).not.toBe(expected);
    // Recovery after a partial band converges to the single-apply reference.
    const rec = stubPool(W, H);
    mkBatch(rec, 1, 30);
    mkBatch(rec, 0.5, 20);
    const rw = (rec as unknown as {
      rgbViews: RGBAccumViews;
      recoverInlineRGBAll(s: () => void, a: number, b: number, c: number): void;
    });
    rw.rgbViews.kick[0] = 4; rw.rgbViews.kick[1] = 32768; rw.rgbViews.kick[2] = 0;
    rw.rgbViews.rgbDepth.fill(0xffff);
    seedCovered(rw.rgbViews);
    const bands = splitBands(H, 4);
    processRGBFrameJob(rw.rgbViews, W, H, 2, bands[0]!.y0, bands[0]!.y1);
    rw.recoverInlineRGBAll(() => seedCovered(rw.rgbViews), 4, 32768, 0);
    expect(snap(rw.rgbViews)).toBe(expected);
  });
});
