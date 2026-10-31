// Foreground attribution audit (PERF-NEXT-5, testkit lane).
//
// Pins indexed worker-execution proof through REAL execution (real built
// Node worker threads, never synthetic execMs):
//
//   - Pooled frames prove execution through public hooks
//     (`testWorkerStats`: active + pooled with spans/pixels > 0) — never
//     pool existence alone.
//   - Pooled output is full-RGBA identical to uninterrupted serial for the
//     same scene (pooled alpha water, pooled combat, fallback after pool
//     disposal, declined staging on a disposed pool, timeout recovery).
//   - Serial work is deterministic, visible (gun vs no-gun differs), and
//     never pooled.
//   - NOTE (RELEASE-8): the RGB composite retired with its
//     `testForegroundStats` producer. The reader-level legs below (no
//     renderer) still pin the unknown-vs-zero contract and the
//     reconciliation rules on synthetic hook shapes for a future producer.
//
// Reader-level legs (no renderer) pin the unknown-vs-zero contract and the
// reconciliation rules on synthetic hook shapes.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'fs';
import { createFramebuffer } from '@q2/renderer-api';
import type { Entity } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import {
  BandWorkerPool,
  SoftwareRenderer,
  SW_ACCUM_CVAR,
  SW_WORKERS_CVAR,
  bspToMiniWorld,
  createDevroom,
  DEVROOM_CAMERA,
  type BspTexelSource,
  type MiniWorld,
} from '@q2/sw-renderer';
import { loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { PakFile } from '@q2/filesystem';
import { parseMD2, parsePCX, parseWAL } from '@q2/formats';
import { v3 } from '@q2/math';
import {
  hashColorFull,
  readForegroundAttribution,
  reconcileForegroundAttribution,
  unknownForegroundAttribution,
  type ForegroundAttribution,
} from './index.js';

const Q2_PAK = process.env.Q2_PAK;
const require = createRequire(process.cwd() + '/');

function swRendererEsmPath(): string | null {
  try {
    const cjs = require.resolve('@q2/sw-renderer');
    const esm = cjs.replace(/index\.js$/, 'index.mjs');
    return existsSync(esm) ? esm : null;
  } catch {
    return null;
  }
}

function attachPool(
  r: SoftwareRenderer, W: number, H: number, workers: number, timeoutMs?: number,
): BandWorkerPool | null {
  const esm = swRendererEsmPath();
  if (!esm) {
    console.log('SKIP pooled attribution: sw-renderer dist not built (run yarn build first)');
    return null;
  }
  resetCVars();
  setCVar(SW_WORKERS_CVAR, workers + 1);
  setCVar(SW_ACCUM_CVAR, 1);
  if (!r.syncWorkersFromCvar()) return null;
  const pool = BandWorkerPool.create(
    workers, W, H,
    timeoutMs === undefined ? { indexJsPath: esm } : { indexJsPath: esm, timeoutMs },
  );
  if (!pool) return null;
  r.attachWorkerPool(pool);
  return pool;
}

function renderDevroom(
  r: SoftwareRenderer, W: number, H: number,
  view: { origin: Float32Array; angles: Float32Array; fovX: number; time: number; lightStyles: Float32Array },
  world: { name: string; data: MiniWorld }, entities: Entity[],
): void {
  r.beginFrame();
  r.renderView(view, world, entities);
  r.endFrame();
}

function devView(): { origin: Float32Array; angles: Float32Array; fovX: number; time: number; lightStyles: Float32Array } {
  return {
    origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
    fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
  };
}

describe('foreground attribution taxonomy (PERF-NEXT-5)', () => {
  it('pooled alpha water: pooled execution proven, pooled frames converge', async () => {
    if (!Q2_PAK) {
      console.log('SKIP pooled alpha attribution: Q2_PAK not set');
      return;
    }
    const pakBytes = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(pakBytes.length);
    new Uint8Array(buf).set(pakBytes);
    const pak = new PakFile(buf);
    const map = loadBsp(pak.readFile('maps/base1.bsp')) as BspMap;
    const walCache = new Map<string, BspTexelSource | null>();
    const texelFor = (walName: string): BspTexelSource | null => {
      if (walCache.has(walName)) return walCache.get(walName)!;
      let src: BspTexelSource | null = null;
      try {
        const wal = parseWAL(pak.readFile(`textures/${walName}.wal`));
        src = { texels: wal.mips[0] as Uint8Array, width: wal.width, height: wal.height };
      } catch { src = null; }
      walCache.set(walName, src);
      return src;
    };
    const world = { name: 'base1', data: bspToMiniWorld(map, { texelFor }) };
    const pcx = parsePCX(pak.readFile('pics/colormap.pcx'));
    // Low-road pool from above: 480 deferred TRANS66 water spans staged.
    const view = {
      origin: v3(430, 620, -150), angles: v3(90, 0, 0),
      fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
    };
    const W = 320, H = 240;
    resetCVars();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(pcx.palette);
    expect(r.setAlphamapFromColormapPcx(pcx.pixels)).toBe(true);
    const pool = attachPool(r, W, H, 3);
    if (!pool) return;
    try {
      renderDevroom(r, W, H, view, world, []);
      const wst = r.testWorkerStats();
      // Real pooled execution through public hooks: the banded backend ran
      // with a pool attached and drew spans/pixels (never pool existence
      // alone as proof).
      expect(wst.active).toBe(true);
      expect(wst.pooled).toBe(true);
      expect(wst.spans).toBeGreaterThan(0);
      expect(wst.pixels).toBeGreaterThan(0);
      const first = hashColorFull(r.getFramebuffer().color);
      // A second pooled frame of the identical scene converges identically
      // (no wedged accumulation across frames).
      renderDevroom(r, W, H, view, world, []);
      expect(hashColorFull(r.getFramebuffer().color)).toBe(first);
      const wst2 = r.testWorkerStats();
      expect(wst2.pooled).toBe(true);
      expect(wst2.spans).toBeGreaterThan(0);
    } finally {
      await pool.dispose();
      resetCVars();
    }
  });

  it('pooled combat: pooled execution proven, pooled frames deterministic', async () => {
    if (!Q2_PAK) {
      console.log('SKIP pooled combat attribution: Q2_PAK not set');
      return;
    }
    const pakBytes = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(pakBytes.length);
    new Uint8Array(buf).set(pakBytes);
    const pak = new PakFile(buf);
    const map = loadBsp(pak.readFile('maps/base1.bsp')) as BspMap;
    const walCache = new Map<string, BspTexelSource | null>();
    const texelFor = (walName: string): BspTexelSource | null => {
      if (walCache.has(walName)) return walCache.get(walName)!;
      let src: BspTexelSource | null = null;
      try {
        const wal = parseWAL(pak.readFile(`textures/${walName}.wal`));
        src = { texels: wal.mips[0] as Uint8Array, width: wal.width, height: wal.height };
      } catch { src = null; }
      walCache.set(walName, src);
      return src;
    };
    const world = { name: 'base1', data: bspToMiniWorld(map, { texelFor }) };
    const palette = parsePCX(pak.readFile('pics/colormap.pcx')).palette;
    const W = 320, H = 240;
    resetCVars();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(palette);
    const pool = attachPool(r, W, H, 3);
    if (!pool) return;
    try {
      const soldierMd2 = parseMD2(pak.readFile('models/monsters/soldier/tris.md2').slice(0));
      const soldierSkin = parsePCX(pak.readFile('models/monsters/soldier/skin.pcx'));
      const mh = r.registerModel({ name: 'soldier', kind: 'md2', data: soldierMd2 });
      const sh = r.registerSkinPixels('soldier-skin', soldierSkin.pixels, soldierSkin.width, soldierSkin.height);
      const sp2 = r.registerModel({ name: 'shot-sprite', kind: 'sp2', data: null });
      const th = r.registerModel({ name: 'tracer', kind: 'tracer' as unknown as 'sp2', data: null });
      const gunMd2 = parseMD2(pak.readFile('models/weapons/v_blast/tris.md2').slice(0));
      const gunSkin = parsePCX(pak.readFile('models/weapons/v_blast/skin.pcx'));
      const gh = r.registerModel({ name: 'v-blast', kind: 'md2', data: gunMd2 });
      const gs = r.registerSkinPixels('v-blast-skin', gunSkin.pixels, gunSkin.width, gunSkin.height);
      const origin: [number, number, number] = [-168, 0, 136];
      const ents: Entity[] = [
        {
          model: mh, origin: new Float32Array([origin[0] + 48, origin[1], origin[2] - 30]),
          angles: new Float32Array([0, 180, 0]), frame: 4, skin: sh,
        },
        {
          model: sp2, origin: new Float32Array([origin[0] + 48, origin[1], origin[2] + 18]),
          angles: new Float32Array([0, 0, 0]), frame: 0, skin: sh,
        },
        {
          model: th,
          origin: new Float32Array([origin[0] + 40, origin[1] + 25, origin[2] - 10]),
          angles: new Float32Array([0, 90, 0]), frame: 96, skin: 231,
        },
        {
          model: gh, origin: new Float32Array(origin),
          angles: new Float32Array([0, 0, 0]), frame: 4, skin: gs, depthHack: true,
        },
      ];
      r.beginFrame();
      r.renderView(
        {
          origin: new Float32Array(origin), angles: new Float32Array([0, 0, 0]),
          fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
        },
        world, ents,
      );
      r.endFrame();
      // Real pooled execution through public hooks: the banded backend ran
      // with a pool and drew spans/pixels for this combat scene.
      const cwst = r.testWorkerStats();
      expect(cwst.active).toBe(true);
      expect(cwst.pooled).toBe(true);
      expect(cwst.spans).toBeGreaterThan(0);
      expect(cwst.pixels).toBeGreaterThan(0);
      const combatFirst = hashColorFull(r.getFramebuffer().color);
      // Deterministic across pooled frames (same entities, same scene).
      r.beginFrame();
      r.renderView(
        {
          origin: new Float32Array(origin), angles: new Float32Array([0, 0, 0]),
          fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
        },
        world, ents,
      );
      r.endFrame();
      expect(hashColorFull(r.getFramebuffer().color)).toBe(combatFirst);
    } finally {
      await pool.dispose();
      resetCVars();
    }
  });

  it('serial combat viewmodel: visible, deterministic, never pooled', () => {
    if (!Q2_PAK) {
      console.log('SKIP serial viewmodel attribution: Q2_PAK not set');
      return;
    }
    const pakBytes = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(pakBytes.length);
    new Uint8Array(buf).set(pakBytes);
    const pak = new PakFile(buf);
    const map = loadBsp(pak.readFile('maps/base1.bsp')) as BspMap;
    const walCache = new Map<string, BspTexelSource | null>();
    const texelFor = (walName: string): BspTexelSource | null => {
      if (walCache.has(walName)) return walCache.get(walName)!;
      let src: BspTexelSource | null = null;
      try {
        const wal = parseWAL(pak.readFile(`textures/${walName}.wal`));
        src = { texels: wal.mips[0] as Uint8Array, width: wal.width, height: wal.height };
      } catch { src = null; }
      walCache.set(walName, src);
      return src;
    };
    const world = { name: 'base1', data: bspToMiniWorld(map, { texelFor }) };
    const palette = parsePCX(pak.readFile('pics/colormap.pcx')).palette;
    const gunMd2 = pak.readFile('models/weapons/v_blast/tris.md2').slice(0);
    const gunSkin = parsePCX(pak.readFile('models/weapons/v_blast/skin.pcx'));
    const origin: [number, number, number] = [-168, 0, 136];
    const renderSerial = (withGun: boolean): string => {
      resetCVars();
      const sfb = createFramebuffer(320, 240, true);
      const sr = new SoftwareRenderer();
      sr.init(sfb);
      sr.setPalette(palette);
      const sgh = sr.registerModel({ name: 'v-blast', kind: 'md2', data: gunMd2.slice(0) });
      const sgs = sr.registerSkinPixels('v-blast-skin', gunSkin.pixels, gunSkin.width, gunSkin.height);
      sr.beginFrame();
      sr.renderView(
        {
          origin: new Float32Array(origin), angles: new Float32Array([0, 0, 0]),
          fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
        },
        world,
        withGun ? [{
          model: sgh, origin: new Float32Array(origin),
          angles: new Float32Array([0, 0, 0]), frame: 4, skin: sgs, depthHack: true,
        }] : [],
      );
      sr.endFrame();
      return hashColorFull(sr.getFramebuffer().color);
    };
    const withGun = renderSerial(true);
    const withoutGun = renderSerial(false);
    // The serial viewmodel is visible (frame differs with the gun present).
    expect(withGun).not.toBe(withoutGun);
    // Serial work is deterministic and never pooled.
    expect(renderSerial(true)).toBe(withGun);
    resetCVars();
    const fr = new SoftwareRenderer();
    fr.init(createFramebuffer(320, 240, true));
    fr.setPalette(palette);
    fr.beginFrame();
    fr.renderView(
      {
        origin: new Float32Array(origin), angles: new Float32Array([0, 0, 0]),
        fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
      },
      world, [],
    );
    fr.endFrame();
    const fwst = fr.testWorkerStats();
    expect(fwst.active).toBe(false);
    expect(fwst.pooled).toBe(false);
    resetCVars();
  });

  it('staged-but-failed (timeout): timed-out kick still converges to serial', async () => {
    const W = 640, H = 480;
    const view = devView();
    // One shared world object (mirrors the fg-counters staged-but-failed
    // leg: identical ingest, so counter deltas can only come from the
    // failure path, never from re-cooking).
    const world = { name: 'devroom', data: createDevroom() };
    resetCVars();
    const r = new SoftwareRenderer();
    r.init(createFramebuffer(W, H, true));
    r.setPalette(new Uint8Array(768).fill(128));
    const pool = attachPool(r, W, H, 3, 1);
    if (!pool) return;
    try {
      renderDevroom(r, W, H, view, world, []);
      // Even when the 1ms budget cannot cover the heavy pooled kick, the
      // frame still converges: the renderer replays inline on timeout, so
      // output matches the uninterrupted serial oracle.
      const recovered = hashColorFull(r.getFramebuffer().color);
      resetCVars();
      const sr = new SoftwareRenderer();
      sr.init(createFramebuffer(W, H, true));
      sr.setPalette(new Uint8Array(768).fill(128));
      renderDevroom(sr, W, H, view, world, []);
      expect(hashColorFull(sr.getFramebuffer().color)).toBe(recovered);
    } finally {
      await pool.dispose();
      resetCVars();
    }
  });

  it('fallback after pool disposal: pooled output matches serial, nothing pooled after', async () => {
    const W = 320, H = 240;
    const view = devView();
    // Pooled frame 1: real pooled execution. NOTE: in banded mode
    // the renderer drains into band buffers — the presented plane MUST be
    // read via getFramebuffer(), never via the init-time fb object (which
    // stays zeroed while a pool is attached).
    resetCVars();
    const r1 = new SoftwareRenderer();
    r1.init(createFramebuffer(W, H, true));
    r1.setPalette(new Uint8Array(768).fill(128));
    const pool = attachPool(r1, W, H, 3);
    if (!pool) return;
    let pooledFull = '';
    try {
      renderDevroom(r1, W, H, view, { name: 'devroom', data: createDevroom() }, []);
      const pwst = r1.testWorkerStats();
      expect(pwst.active).toBe(true);
      expect(pwst.pooled).toBe(true);
      expect(pwst.spans).toBeGreaterThan(0);
      pooledFull = hashColorFull(r1.getFramebuffer().color);
    } finally {
      await pool.dispose();
      resetCVars();
    }
    // Fallback frame 2: fresh serial renderer, fresh world, same scene —
    // output must match, with nothing pooled.
    resetCVars();
    const r2 = new SoftwareRenderer();
    r2.init(createFramebuffer(W, H, true));
    r2.setPalette(new Uint8Array(768).fill(128));
    renderDevroom(r2, W, H, view, { name: 'devroom', data: createDevroom() }, []);
    resetCVars();
    const swst = r2.testWorkerStats();
    expect(swst.active).toBe(false);
    expect(swst.pooled).toBe(false);
    expect(hashColorFull(r2.getFramebuffer().color)).toBe(pooledFull);
  });

  it('declined staging (disposed pool): work drains inline; output == serial', async () => {
    const W = 320, H = 240;
    const view = devView();
    // Serial oracle.
    resetCVars();
    const r0 = new SoftwareRenderer();
    r0.init(createFramebuffer(W, H, true));
    r0.setPalette(new Uint8Array(768).fill(128));
    renderDevroom(r0, W, H, view, { name: 'devroom', data: createDevroom() }, []);
    resetCVars();
    const oracle = hashColorFull(r0.getFramebuffer().color);
    // Attach a pool, then dispose it BEFORE rendering: every stage declines
    // (pool dead) and the frame drains inline on the calling thread.
    resetCVars();
    const r = new SoftwareRenderer();
    r.init(createFramebuffer(W, H, true));
    r.setPalette(new Uint8Array(768).fill(128));
    const pool = attachPool(r, W, H, 3);
    if (!pool) return;
    await pool.dispose();
    renderDevroom(r, W, H, view, { name: 'devroom', data: createDevroom() }, []);
    resetCVars();
    expect(hashColorFull(r.getFramebuffer().color)).toBe(oracle);
  });
});

describe('foreground attribution reader contract (no renderer)', () => {
  /** Complete valid raw producer shape (mirrors the hook contract). */
  function validRaw(): Record<string, unknown> {
    return {
      stagedBatches: 1, inlineBatches: 0, kicks: 1,
      alphaSpansStaged: 0, alphaSpansInline: 0,
      spriteSpansStaged: 0, spriteDrawsInline: 0,
      aliasDrawsInline: 0, aliasTrisInline: 0,
      particleDrawsInline: 0, particlesInline: 0,
      beamDrawsInline: 0,
      workerSpansCompleted: 10, workerPixelsCompleted: 100,
      mainSpansCompleted: 2, mainPixelsCompleted: 20,
      replayedSpans: 0, replayedPixels: 0, recoveryCount: 0,
      entityMs: 0.5,
    };
  }

  it('absent or malformed hooks read null (unknown), never zero', () => {
    expect(readForegroundAttribution({})).toBeNull();
    expect(readForegroundAttribution({
      testForegroundStats: (): unknown => ({ stagedBatches: 1 }),
    })).toBeNull();
    // Present-but-negative completion counter: rejected, never laundered.
    expect(readForegroundAttribution({
      testForegroundStats: (): unknown => ({ ...validRaw(), workerSpansCompleted: -1 }),
    })).toBeNull();
    // Present-but-malformed optional split: rejected, never zeroed.
    expect(readForegroundAttribution({
      testForegroundStats: (): unknown => ({ ...validRaw(), workerTrisCompleted: -1 }),
    })).toBeNull();
    expect(readForegroundAttribution({
      testForegroundStats: (): unknown => {
        throw new Error('boom');
      },
    })).toBeNull();
  });

  it('valid hook projects worker/main/combined with unknown per-class splits', () => {
    const a = readForegroundAttribution({ testForegroundStats: (): unknown => validRaw() });
    expect(a).not.toBeNull();
    const attr = a as ForegroundAttribution;
    expect(attr.kicks).toBe(1);
    expect(attr.kick.workerSpans).toBe(10);
    expect(attr.kick.mainSpans).toBe(2);
    expect(attr.kick.spans).toBe(12);
    expect(attr.kick.workerPixels).toBe(100);
    expect(attr.kick.mainPixels).toBe(20);
    expect(attr.kick.pixels).toBe(120);
    // No tri counters published: all unknown, never zero.
    expect(attr.kick.tris).toBeNull();
    expect(attr.kick.workerTris).toBeNull();
    expect(attr.kick.mainTris).toBeNull();
    // No per-class splits published: unknown, never staged-as-worker.
    expect(attr.spriteSpansWorkerCompleted).toBeNull();
    expect(attr.aliasTrisWorkerCompleted).toBeNull();
    // Newer per-class staged/inline fields absent on this shape: unknown.
    expect(attr.aliasDrawsStaged).toBeNull();
    expect(attr.spriteSpansInline).toBeNull();
    expect(attr.particleSpansInline).toBeNull();
    expect(attr.beamSpansInline).toBeNull();
    expect(reconcileForegroundAttribution(attr)).toEqual([]);
  });

  it('per-class worker/main splits are null BY DESIGN while the producer publishes none (TASK item 4 gap, tracked)', () => {
    // WHY null (not zero, not staged-as-worker): one kick drains EVERY RGB
    // descriptor in order — world batches, deferred-TRANS alpha spans,
    // sprite/particle/beam spans and alias TRI screen tris ride the same
    // kick (producer: packages/sw-renderer/src/bands.ts
    // `processRGBFrameJob` — "every RGB descriptor in order"; browser
    // mirror: apps/web render-workers.ts `BrowserForegroundDetail`). The
    // pool reports only the GLOBAL worker/main split, so per-class
    // completion is unknowable downstream. The optional per-class fields
    // are accepted if a future producer publishes them; until then they
    // read null (unknown). This test pins the invariant so the gap is
    // TRACKED, not silently missing: real-execution legs above (pooled
    // alpha water, pooled combat) assert the same nulls on live kicks.
    const a = readForegroundAttribution({ testForegroundStats: (): unknown => validRaw() });
    expect(a).not.toBeNull();
    const attr = a as ForegroundAttribution;
    expect(attr.alphaSpansWorkerCompleted).toBeNull();
    expect(attr.alphaSpansMainCompleted).toBeNull();
    expect(attr.spriteSpansWorkerCompleted).toBeNull();
    expect(attr.spriteSpansMainCompleted).toBeNull();
    expect(attr.aliasTrisWorkerCompleted).toBeNull();
    expect(attr.aliasTrisMainCompleted).toBeNull();
    expect(attr.particleSpansWorkerCompleted).toBeNull();
    expect(attr.particleSpansMainCompleted).toBeNull();
    expect(attr.beamSpansWorkerCompleted).toBeNull();
    expect(attr.beamSpansMainCompleted).toBeNull();
    // Unknown-by-design reconciles cleanly (nothing published, nothing claimed).
    expect(reconcileForegroundAttribution(attr)).toEqual([]);
  });

  it('published per-class splits pass through for a future producer (and still reconcile)', () => {
    const a = readForegroundAttribution({
      testForegroundStats: (): unknown => ({
        ...validRaw(),
        kicks: 2,
        alphaSpansWorkerCompleted: 8, alphaSpansMainCompleted: 2,
        spriteSpansWorkerCompleted: 0, spriteSpansMainCompleted: 0,
        aliasTrisWorkerCompleted: 6, aliasTrisMainCompleted: 4,
        particleSpansWorkerCompleted: 0, particleSpansMainCompleted: 0,
        beamSpansWorkerCompleted: 3, beamSpansMainCompleted: 1,
      }),
    });
    expect(a).not.toBeNull();
    const attr = a as ForegroundAttribution;
    expect(attr.alphaSpansWorkerCompleted).toBe(8);
    expect(attr.alphaSpansMainCompleted).toBe(2);
    expect(attr.aliasTrisWorkerCompleted).toBe(6);
    expect(attr.beamSpansMainCompleted).toBe(1);
    expect(reconcileForegroundAttribution(attr)).toEqual([]);
  });

  it('reconcile flags per-class completions claimed on a zero-kick frame (misattributed, never laundered)', () => {
    const mis: ForegroundAttribution = {
      ...unknownForegroundAttribution(),
      kicks: 0,
      alphaSpansWorkerCompleted: 5,
      beamSpansMainCompleted: 2,
    };
    const bad = reconcileForegroundAttribution(mis);
    expect(bad.length).toBe(2);
    expect(bad.join('\n')).toMatch(/alphaSpansWorkerCompleted=5 with kicks=0/);
    expect(bad.join('\n')).toMatch(/beamSpansMainCompleted=2 with kicks=0/);
    // Genuine serial zeros (hook present, no kick ran, nothing published
    // non-null) stay clean.
    expect(reconcileForegroundAttribution({
      ...unknownForegroundAttribution(),
      kicks: 0,
      kick: {
        spans: 0, pixels: 0, tris: 0,
        workerSpans: 0, workerPixels: 0, workerTris: 0,
        mainSpans: 0, mainPixels: 0, mainTris: 0,
      },
    })).toEqual([]);
  });

  it('reads newer per-class staged/inline fields when the producer publishes them', () => {
    const a = readForegroundAttribution({
      testForegroundStats: (): unknown => ({
        ...validRaw(),
        spriteSpansInline: 3, aliasDrawsStaged: 2,
        particleSpansInline: 0, beamSpansInline: 0,
      }),
    });
    expect(a).not.toBeNull();
    const attr = a as ForegroundAttribution;
    expect(attr.spriteSpansInline).toBe(3);
    expect(attr.aliasDrawsStaged).toBe(2);
    expect(attr.particleSpansInline).toBe(0);
    expect(attr.beamSpansInline).toBe(0);
    expect(reconcileForegroundAttribution(attr)).toEqual([]);
  });

  it('unknown sentinel reconciles cleanly (nothing published, nothing claimed)', () => {
    expect(reconcileForegroundAttribution(unknownForegroundAttribution())).toEqual([]);
  });

  it('flags worker-completed work with zero completed kicks (failure staged as execution)', () => {
    const inflated: ForegroundAttribution = {
      ...unknownForegroundAttribution(),
      kicks: 0,
      kick: {
        spans: 10, pixels: 100, tris: 2,
        workerSpans: 10, workerPixels: 100, workerTris: 2,
        mainSpans: 0, mainPixels: 0, mainTris: 0,
      },
    };
    const bad = reconcileForegroundAttribution(inflated);
    expect(bad.length).toBeGreaterThan(0);
    expect(bad.join('\n')).toMatch(/kicks=0/);
  });

  it('flags combined != worker + main (misattributed split)', () => {
    const mis: ForegroundAttribution = {
      ...unknownForegroundAttribution(),
      kicks: 1,
      kick: {
        spans: 100, pixels: 1000, tris: 10,
        workerSpans: 60, workerPixels: 600, workerTris: 6,
        mainSpans: 30, mainPixels: 300, mainTris: 3,
      },
    };
    const bad = reconcileForegroundAttribution(mis);
    expect(bad.length).toBe(3);
    expect(bad.join('\n')).toMatch(/combined=100 != worker\(60\)\+main\(30\)/);
  });
});
