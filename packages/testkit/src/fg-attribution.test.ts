// Foreground attribution audit (PERF-NEXT-5, testkit lane).
//
// Pins the CORRECTED worker/main-thread attribution taxonomy through REAL
// execution (real built Node worker threads, never synthetic execMs):
//
//   - Browser results must return workerSpans/workerPixels/workerTris
//     separately from combined totals with Node semantics: combined ==
//     worker + main. Absent split fields imply the calling-thread band ran
//     inline — never reported as worker-completed.
//   - Every primitive class (alias/viewmodel, alpha spans, sprites,
//     particles, beams) reports prepared/staged, actually completed,
//     main-band, inline and replayed work in explicit units. Unavailable
//     per-class completion splits read unknown (null), never zero, never
//     staged-as-worker.
//   - A nonempty main band plus worker bands execute for real; staged-but-
//     failed jobs (timeout) report zero worker-completed with the work in
//     replay/inline counters; serial viewmodel work is main/inline, never
//     worker; fallback frames reconcile combined totals.
//   - Failure/replay is never reported as successful worker execution
//     (`reconcileForegroundAttribution` fails the test otherwise).
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
  setRGBWorldEnabled,
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
  it('pooled alpha water: worker bands + nonempty main band execute; combined reconciles', async () => {
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
      setRGBWorldEnabled(true);
      try {
        renderDevroom(r, W, H, view, world, []);
      } finally {
        setRGBWorldEnabled(false);
      }
      const a = readForegroundAttribution(r);
      expect(a).not.toBeNull();
      const attr = a as ForegroundAttribution;
      // One completed kick; staged alpha spans are real spans offered.
      expect(attr.kicks).toBe(1);
      expect(attr.alphaSpansStaged).toBeGreaterThan(0);
      // No staging refusals: staged work is never double-counted inline.
      expect(attr.alphaSpansInline).toBe(0);
      expect(attr.spriteSpansInline).toBe(0);
      expect(attr.particleSpansInline).toBe(0);
      expect(attr.beamSpansInline).toBe(0);
      // Worker bands AND the nonempty calling-thread (main) band executed.
      expect(attr.kick.workerSpans).toBeGreaterThan(0);
      expect(attr.kick.mainSpans).toBeGreaterThan(0);
      expect(attr.kick.workerPixels).toBeGreaterThan(0);
      expect(attr.kick.mainPixels).toBeGreaterThan(0);
      // Combined totals reconcile exactly: combined == worker + main.
      expect(reconcileForegroundAttribution(attr)).toEqual([]);
      expect(attr.kick.spans).toBe(
        (attr.kick.workerSpans as number) + (attr.kick.mainSpans as number),
      );
      expect(attr.kick.pixels).toBe(
        (attr.kick.workerPixels as number) + (attr.kick.mainPixels as number),
      );
      // Per-class completion splits are untracked: unknown (null) — the
      // staged alpha batches above are NEVER reported as worker-completed.
      expect(attr.alphaSpansWorkerCompleted).toBeNull();
      expect(attr.alphaSpansMainCompleted).toBeNull();
      // Nothing failed: no replay, no recovery.
      expect(attr.replayedSpans).toBe(0);
      expect(attr.recoveryCount).toBe(0);
    } finally {
      await pool.dispose();
      resetCVars();
    }
  });

  it('pooled combat: staged vs completed vs main vs inline in explicit units', async () => {
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
      setRGBWorldEnabled(true);
      try {
        r.beginFrame();
        r.renderView(
          {
            origin: new Float32Array(origin), angles: new Float32Array([0, 0, 0]),
            fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
          },
          world, ents,
        );
        r.endFrame();
      } finally {
        setRGBWorldEnabled(false);
      }
      const a = readForegroundAttribution(r);
      expect(a).not.toBeNull();
      const attr = a as ForegroundAttribution;
      // Staged work per class, explicit units: tris + draws for alias
      // (draws = staged instances, incl. the viewmodel gun), spans for
      // sprites and beams.
      expect(attr.trisStaged).toBeGreaterThan(0);
      expect(attr.aliasDrawsStaged).toBeGreaterThan(0);
      expect(attr.spriteSpansStaged).toBeGreaterThan(0);
      expect(attr.beamSpansStaged).toBeGreaterThan(0);
      // No staging refusals in this scene: staged work is never
      // double-counted inline (units: spans).
      expect(attr.spriteSpansInline).toBe(0);
      expect(attr.particleSpansInline).toBe(0);
      expect(attr.beamSpansInline).toBe(0);
      // Actual completion on both sides; the calling-thread band is nonempty
      // (pixels + tris even where its span share is zero).
      expect(attr.kicks).toBeGreaterThan(0);
      expect(attr.kick.workerSpans).toBeGreaterThan(0);
      expect(attr.kick.workerPixels).toBeGreaterThan(0);
      expect(attr.kick.mainPixels).toBeGreaterThan(0);
      expect(attr.kick.mainTris).toBeGreaterThan(0);
      expect(reconcileForegroundAttribution(attr)).toEqual([]);
      // Per-class completion splits are untracked: unknown, never worker.
      expect(attr.spriteSpansWorkerCompleted).toBeNull();
      expect(attr.beamSpansWorkerCompleted).toBeNull();
      expect(attr.aliasTrisWorkerCompleted).toBeNull();
      expect(attr.particleSpansWorkerCompleted).toBeNull();
    } finally {
      await pool.dispose();
      resetCVars();
    }
  });

  it('serial combat viewmodel: main-thread inline work, never worker', () => {
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
    resetCVars();
    const fb = createFramebuffer(320, 240, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(palette);
    const gunMd2 = parseMD2(pak.readFile('models/weapons/v_blast/tris.md2').slice(0));
    const gunSkin = parsePCX(pak.readFile('models/weapons/v_blast/skin.pcx'));
    const gh = r.registerModel({ name: 'v-blast', kind: 'md2', data: gunMd2 });
    const gs = r.registerSkinPixels('v-blast-skin', gunSkin.pixels, gunSkin.width, gunSkin.height);
    const origin: [number, number, number] = [-168, 0, 136];
    setRGBWorldEnabled(true);
    try {
      r.beginFrame();
      r.renderView(
        {
          origin: new Float32Array(origin), angles: new Float32Array([0, 0, 0]),
          fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
        },
        world,
        [{
          model: gh, origin: new Float32Array(origin),
          angles: new Float32Array([0, 0, 0]), frame: 4, skin: gs, depthHack: true,
        }],
      );
      r.endFrame();
    } finally {
      setRGBWorldEnabled(false);
      resetCVars();
    }
    const a = readForegroundAttribution(r);
    expect(a).not.toBeNull();
    const attr = a as ForegroundAttribution;
    // No kick ran: no completion anywhere — the serial viewmodel is visible
    // in INLINE draws (unit: draws) and tris (unit: triangles), never as
    // worker-completed.
    expect(attr.kicks).toBe(0);
    expect(attr.kick.workerSpans).toBe(0);
    expect(attr.kick.workerPixels).toBe(0);
    expect(attr.kick.workerTris).toBe(0);
    expect(attr.kick.spans).toBe(0);
    expect(attr.kick.pixels).toBe(0);
    expect(attr.aliasDrawsInline).toBeGreaterThan(0);
    expect(attr.aliasTrisInline).toBeGreaterThan(0);
    // Serial path stages nothing: the viewmodel is main-thread inline work
    // (draws + pre-clip mesh tris), never staged, never worker-completed.
    expect(attr.aliasDrawsStaged).toBe(0);
    expect(attr.trisStaged).toBe(0);
    expect(reconcileForegroundAttribution(attr)).toEqual([]);
  });

  it('staged-but-failed (timeout): failed kick completes nothing; replay carries the work', async () => {
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
      setRGBWorldEnabled(true);
      try {
        renderDevroom(r, W, H, view, world, []);
      } finally {
        setRGBWorldEnabled(false);
      }
      // The heavy world kick (~30ms pooled at 640x480) cannot complete
      // inside a 1ms budget: work WAS staged, nothing completed — staging
      // is never reported as execution.
      const wst = r.testRGBWorkerStats();
      expect(wst.staged).toBeGreaterThan(0);
      expect(wst.kicks).toBe(0);
      const a = readForegroundAttribution(r);
      expect(a).not.toBeNull();
      const attr = a as ForegroundAttribution;
      // The recovery replay ran instead of a worker completion (units:
      // spans/pixels), counted as recovery — never as a worker completion.
      // (A tiny foreground group may legitimately complete first on a fast
      // machine; that completion is truthful and reconciles — see below.)
      expect(attr.recoveryCount).toBeGreaterThan(0);
      expect(attr.replayedSpans).toBeGreaterThan(0);
      expect(attr.replayedPixels).toBeGreaterThan(0);
      // Whatever completed reconciles exactly: combined == worker + main,
      // and a zero-kick row would carry zero worker work (the reconcile
      // rule flags failure staged as execution).
      expect(reconcileForegroundAttribution(attr)).toEqual([]);
      // NOTE (renderer-lane follow-up, PERF-NEXT-5): pixel identity across
      // the quarantine path is NOT asserted here. Intermittently (quarantine
      // signature rec=2/fgkicks=0 — mid-flight timeout + terminate + replay)
      // the recovered frame hashes 65cf87ee/3c53a7c5 instead of the serial
      // f674729a, deterministically per outcome. Repro:
      //   node /tmp/opencode/probe-fgc.mjs 10
      // (counters stay truthful in every outcome: wst.kicks==0, recovery>0,
      // reconcile clean). Double-recovery overlap (world + foreground
      // replays over the same retained range) is the suspected mechanism —
      // renderer lane to root-cause; pixel identity for this scenario stays
      // pinned by the fg-counters staged-but-failed leg.
    } finally {
      await pool.dispose();
      resetCVars();
    }
  });

  it('fallback after pool disposal: combined totals reconcile, nothing reported as worker', async () => {
    const W = 320, H = 240;
    const view = devView();
    // Pooled frame 1: real worker + main execution. NOTE: in banded mode
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
      setRGBWorldEnabled(true);
      try {
        renderDevroom(r1, W, H, view, { name: 'devroom', data: createDevroom() }, []);
      } finally {
        setRGBWorldEnabled(false);
      }
      const a1 = readForegroundAttribution(r1);
      expect(a1).not.toBeNull();
      const pooled = a1 as ForegroundAttribution;
      expect((pooled.kick.workerSpans as number) + (pooled.kick.workerPixels as number)).toBeGreaterThan(0);
      expect(reconcileForegroundAttribution(pooled)).toEqual([]);
      pooledFull = hashColorFull(r1.getFramebuffer().color);
    } finally {
      await pool.dispose();
      resetCVars();
    }
    // Fallback frame 2: fresh serial renderer, fresh world, same scene —
    // output must match, with no completion attributed to workers.
    resetCVars();
    const r2 = new SoftwareRenderer();
    r2.init(createFramebuffer(W, H, true));
    r2.setPalette(new Uint8Array(768).fill(128));
    setRGBWorldEnabled(true);
    try {
      renderDevroom(r2, W, H, view, { name: 'devroom', data: createDevroom() }, []);
    } finally {
      setRGBWorldEnabled(false);
      resetCVars();
    }
    const a2 = readForegroundAttribution(r2);
    expect(a2).not.toBeNull();
    const serial = a2 as ForegroundAttribution;
    expect(serial.kicks).toBe(0);
    expect(serial.kick.workerSpans).toBe(0);
    expect(serial.kick.workerPixels).toBe(0);
    expect(serial.kick.workerTris).toBe(0);
    expect(reconcileForegroundAttribution(serial)).toEqual([]);
    expect(hashColorFull(r2.getFramebuffer().color)).toBe(pooledFull);
  });

  it('declined staging (disposed pool): zero worker-completed, work goes inline; output == serial', async () => {
    const W = 320, H = 240;
    const view = devView();
    // Serial oracle.
    resetCVars();
    const r0 = new SoftwareRenderer();
    r0.init(createFramebuffer(W, H, true));
    r0.setPalette(new Uint8Array(768).fill(128));
    setRGBWorldEnabled(true);
    try {
      renderDevroom(r0, W, H, view, { name: 'devroom', data: createDevroom() }, []);
    } finally {
      setRGBWorldEnabled(false);
      resetCVars();
    }
    const oracle = hashColorFull(r0.getFramebuffer().color);
    // Attach a pool, then dispose it BEFORE rendering: every stage declines
    // (capacity gone) and the frame drains inline on the calling thread.
    resetCVars();
    const r = new SoftwareRenderer();
    r.init(createFramebuffer(W, H, true));
    r.setPalette(new Uint8Array(768).fill(128));
    const pool = attachPool(r, W, H, 3);
    if (!pool) return;
    await pool.dispose();
    setRGBWorldEnabled(true);
    try {
      renderDevroom(r, W, H, view, { name: 'devroom', data: createDevroom() }, []);
    } finally {
      setRGBWorldEnabled(false);
      resetCVars();
    }
    const a = readForegroundAttribution(r);
    expect(a).not.toBeNull();
    const attr = a as ForegroundAttribution;
    // Declined staging is never worker-completed: zero kicks, zero worker
    // shares — the work is visible in the inline counters instead.
    expect(attr.kicks).toBe(0);
    expect(attr.kick.workerSpans).toBe(0);
    expect(attr.kick.workerPixels).toBe(0);
    expect(attr.kick.workerTris).toBe(0);
    expect(attr.kick.spans).toBe(0);
    expect(attr.kick.pixels).toBe(0);
    expect((attr.inlineBatches as number)).toBeGreaterThan(0);
    expect(reconcileForegroundAttribution(attr)).toEqual([]);
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
