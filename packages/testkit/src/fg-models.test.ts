// Exact model/gun worker rasterization harness (PERF-FINISH follow-up
// item 2, bench/testkit lane).
//
// The foreground worker protocol for per-pixel/triangle foreground (alias
// incl. the viewmodel, particles, entity sprites, tracers) does NOT exist in
// the renderer yet (no JOB_FG/tri-descriptor path, no model-worker stats
// hook — verified by grep over packages/sw-renderer/src). This file therefore
// does two things:
//
//   1. Serial oracle pins (run now, Q2_PAK-gated): the exact serial behavior
//      the future worker path must reproduce — determinism, animated frame
//      interpolation, dynamic lighting, gun-vs-no-gun, overlapping
//      models, odd dimensions. These are self-consistency pins, not new
//      goldens: they compare runs against each other, never a baked hash.
//   2. Worker parity suite (written now, SKIPPED clearly until the renderer
//      publishes its protocol): full-RGBA + coverage vs serial, overlapping
//      models, gun vs walls/near-plane, animation + dynamic lights, odd
//      dims/seams, worker counts 1/3/7, primitive ordering, partial-job
//      recovery with the new protocol, real thread-pool execution.
//
// Feature detection is structural (no version sniffing): the worker suite
// runs only when SoftwareRenderer exposes a model-worker stats hook. The
// integrator aligning the renderer protocol must keep that hook shape or
// update the probe below — the skip message says exactly what is missing.
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
  setRGBWorldEnabled,
  type BspTexelSource,
  type MiniWorld,
} from '@q2/sw-renderer';
import { loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { PakFile } from '@q2/filesystem';
import { parseMD2, parsePCX, parseWAL } from '@q2/formats';
import { hashColorFull } from './index.js';

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

/**
 * Model/gun worker protocol probe. Present only when the renderer publishes
 * per-triangle foreground worker execution with this stats hook shape.
 */
export function modelWorkerProtocolAvailable(): boolean {
  const proto = SoftwareRenderer.prototype as unknown as Record<string, unknown>;
  return typeof proto['testModelWorkerStats'] === 'function';
}

export interface ModelWorkerStats {
  stagedTris: number;
  completedTris: number;
  kicks: number;
  inlineTris: number;
}

/** Structural read of the future hook; null when the protocol is absent. */
export function readModelWorkerStats(r: SoftwareRenderer): ModelWorkerStats | null {
  if (!modelWorkerProtocolAvailable()) return null;
  const hook = (r as unknown as Record<string, unknown>)['testModelWorkerStats'];
  if (typeof hook !== 'function') return null;
  const bound = (hook as () => unknown).bind(r)() as Record<string, unknown>;
  if (
    typeof bound['stagedTris'] !== 'number' || typeof bound['completedTris'] !== 'number' ||
    typeof bound['kicks'] !== 'number' || typeof bound['inlineTris'] !== 'number'
  ) return null;
  return {
    stagedTris: bound['stagedTris'] as number,
    completedTris: bound['completedTris'] as number,
    kicks: bound['kicks'] as number,
    inlineTris: bound['inlineTris'] as number,
  };
}

interface WorldBundle {
  world: { name: string; data: MiniWorld };
  palette: Uint8Array;
  soldierMd2: ArrayBuffer;
  soldierSkin: { pixels: Uint8Array; width: number; height: number };
  gunMd2: ArrayBuffer;
  gunSkin: { pixels: Uint8Array; width: number; height: number };
}

function loadWorldBundle(): WorldBundle {
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
  const skin = parsePCX(pak.readFile('models/monsters/soldier/skin.pcx'));
  const gunSkin = parsePCX(pak.readFile('models/weapons/v_blast/skin.pcx'));
  return {
    world: { name: 'base1', data: bspToMiniWorld(map, { texelFor }) },
    palette: parsePCX(pak.readFile('pics/colormap.pcx')).palette,
    soldierMd2: pak.readFile('models/monsters/soldier/tris.md2'),
    soldierSkin: { pixels: skin.pixels, width: skin.width, height: skin.height },
    gunMd2: pak.readFile('models/weapons/v_blast/tris.md2'),
    gunSkin: { pixels: gunSkin.pixels, width: gunSkin.width, height: gunSkin.height },
  };
}

const SPAWN: { origin: [number, number, number]; yaw: number } = {
  // spawn-north fixed camera (matches tools/bench base1Views).
  origin: [-168, 0, 136],
  yaw: 0,
};

function spawnView(yawExtra = 0): {
  origin: Float32Array; angles: Float32Array; fovX: number; time: number; lightStyles: Float32Array;
} {
  return {
    origin: new Float32Array(SPAWN.origin),
    angles: new Float32Array([0, SPAWN.yaw + yawExtra, 0]),
    fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
  };
}

/** Camera-relative entity row: soldier + sprite + tracer + optional gun. */
function sceneEntities(r: SoftwareRenderer, b: WorldBundle, opts: { gun?: boolean; frame?: number; overlap?: boolean } = {}): Entity[] {
  const [ox, oy, oz] = SPAWN.origin;
  const yaw = (SPAWN.yaw * Math.PI) / 180;
  const fx = Math.cos(yaw), fy = Math.sin(yaw);
  const rx = -fy, ry = fx;
  const frame = opts.frame ?? 4;
  const md2 = parseMD2(b.soldierMd2.slice(0));
  const mh = r.registerModel({ name: 'soldier', kind: 'md2', data: md2 });
  const sh = r.registerSkinPixels('soldier-skin', b.soldierSkin.pixels, b.soldierSkin.width, b.soldierSkin.height);
  const sp2 = r.registerModel({ name: 'shot-sprite', kind: 'sp2', data: null });
  const th = r.registerModel({ name: 'tracer', kind: 'tracer' as unknown as 'sp2', data: null });
  const sx = ox + fx * 48, sy = oy + fy * 48;
  const out: Entity[] = [
    {
      model: mh, origin: new Float32Array([sx, sy, oz - 30]),
      angles: new Float32Array([0, SPAWN.yaw + 180, 0]), frame, skin: sh,
    },
    {
      model: sp2, origin: new Float32Array([sx, sy, oz + 18]),
      angles: new Float32Array([0, 0, 0]), frame: 0, skin: sh,
    },
    {
      model: th,
      origin: new Float32Array([ox + fx * 40 + rx * 25, oy + fy * 40 + ry * 25, oz - 10]),
      angles: new Float32Array([0, SPAWN.yaw + 90, 0]), frame: 96, skin: 231,
    },
  ];
  if (opts.overlap) {
    const md2b = parseMD2(b.soldierMd2.slice(0));
    const mh2 = r.registerModel({ name: 'soldier-b', kind: 'md2', data: md2b });
    out.push({
      model: mh2, origin: new Float32Array([sx + 6, sy - 4, oz - 28]),
      angles: new Float32Array([0, SPAWN.yaw + 160, 0]), frame, skin: sh, alpha: 0.5,
    });
  }
  if (opts.gun) {
    // NOTE: v_blast frame 0 at the eye is degenerate from head-on (zero
    // covered pixels); frame 4 is the representative visible pose.
    const gunMd2 = parseMD2(b.gunMd2.slice(0));
    const gh = r.registerModel({ name: 'v-blast', kind: 'md2', data: gunMd2 });
    const gs = r.registerSkinPixels('v-blast-skin', b.gunSkin.pixels, b.gunSkin.width, b.gunSkin.height);
    out.push({
      model: gh, origin: new Float32Array([ox, oy, oz]),
      angles: new Float32Array([0, SPAWN.yaw, 0]), frame: 4, skin: gs,
      depthHack: true,
    });
  }
  return out;
}

function renderSerial(
  W: number, H: number, b: WorldBundle, entities: Entity[],
  mutate?: (r: SoftwareRenderer) => void,
): { full: string; cover: number } {
  resetCVars();
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(b.palette);
  setRGBWorldEnabled(true);
  try {
    mutate?.(r);
    r.beginFrame();
    r.renderView(spawnView(), b.world, entities);
    r.endFrame();
    return { full: hashColorFull(r.getFramebuffer().color), cover: r.testRGBStats().coverPixels };
  } finally {
    setRGBWorldEnabled(false);
    resetCVars();
  }
}

// --- Serial oracle pins (run now) -------------------------------------------

describe.runIf(!!Q2_PAK)('fg model/gun serial oracle (worker parity target)', () => {
  it('serial combat scene is deterministic across runs', () => {
    const b = loadWorldBundle();
    const mk = (): { full: string; cover: number } => {
      resetCVars();
      const fb = createFramebuffer(320, 240, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(b.palette);
      setRGBWorldEnabled(true);
      try {
        const ents = sceneEntities(r, b, { gun: true });
        r.beginFrame();
        r.renderView(spawnView(), b.world, ents);
        r.endFrame();
        return { full: hashColorFull(r.getFramebuffer().color), cover: r.testRGBStats().coverPixels };
      } finally {
        setRGBWorldEnabled(false);
        resetCVars();
      }
    };
    const a = mk();
    const c = mk();
    expect(c.full).toBe(a.full);
    expect(c.cover).toBe(a.cover);
    expect(a.cover).toBeGreaterThan(0);
  });

  it('animated frame interpolation changes the frame', () => {
    const b = loadWorldBundle();
    const f0 = (() => {
      resetCVars();
      const fb = createFramebuffer(320, 240, true);
      const r = new SoftwareRenderer();
      r.init(fb); r.setPalette(b.palette);
      setRGBWorldEnabled(true);
      try {
        const ents = sceneEntities(r, b, { frame: 0 });
        r.beginFrame(); r.renderView(spawnView(), b.world, ents); r.endFrame();
        return hashColorFull(r.getFramebuffer().color);
      } finally { setRGBWorldEnabled(false); resetCVars(); }
    })();
    const f9 = (() => {
      resetCVars();
      const fb = createFramebuffer(320, 240, true);
      const r = new SoftwareRenderer();
      r.init(fb); r.setPalette(b.palette);
      setRGBWorldEnabled(true);
      try {
        const ents = sceneEntities(r, b, { frame: 9 });
        r.beginFrame(); r.renderView(spawnView(), b.world, ents); r.endFrame();
        return hashColorFull(r.getFramebuffer().color);
      } finally { setRGBWorldEnabled(false); resetCVars(); }
    })();
    expect(f9).not.toBe(f0);
  });

  it('dynamic light changes the frame; gun is visible in pixels', () => {
    const b = loadWorldBundle();
    const renderEnts = (gunFrame: number | null, light: boolean): { full: string; cover: number } => {
      resetCVars();
      const fb = createFramebuffer(320, 240, true);
      const r = new SoftwareRenderer();
      r.init(fb); r.setPalette(b.palette);
      setRGBWorldEnabled(true);
      try {
        const ents = sceneEntities(r, b, gunFrame === null ? {} : { gun: true });
        if (gunFrame !== null) ents[ents.length - 1]!.frame = gunFrame;
        if (light) {
          r.testExpireDynamicLights();
          r.testAddDynamicLight({
            origin: new Float32Array([SPAWN.origin[0] + 48, SPAWN.origin[1], SPAWN.origin[2] - 20]),
            intensity: 250, color: new Float32Array([1, 0.55, 0.15]),
          });
        }
        r.beginFrame(); r.renderView(spawnView(), b.world, ents); r.endFrame();
        return { full: hashColorFull(r.getFramebuffer().color), cover: r.testRGBStats().coverPixels };
      } finally { setRGBWorldEnabled(false); resetCVars(); }
    };
    // Gun pose frame 4 changes pixels vs the same scene without the gun
    // (no dlight either way — the difference is the viewmodel alone).
    // Frame 0 is degenerate head-on (zero covered pixels) and must NOT be
    // used as the visibility probe.
    const noGun = renderEnts(null, false);
    const gun4 = renderEnts(4, false);
    expect(gun4.full).not.toBe(noGun.full);
    expect(gun4.cover).toBeGreaterThan(0);
    // Dynamic light changes the frame with entities held fixed.
    const gun4Lit = renderEnts(4, true);
    expect(gun4Lit.full).not.toBe(gun4.full);
  });

  it('overlapping translucent model is deterministic; odd dims render', () => {
    const b = loadWorldBundle();
    const mkOdd = (): string => {
      resetCVars();
      const fb = createFramebuffer(321, 241, true);
      const r = new SoftwareRenderer();
      r.init(fb); r.setPalette(b.palette);
      setRGBWorldEnabled(true);
      try {
        const ents = sceneEntities(r, b, { gun: true, overlap: true });
        r.beginFrame(); r.renderView(spawnView(), b.world, ents); r.endFrame();
        return hashColorFull(r.getFramebuffer().color);
      } finally { setRGBWorldEnabled(false); resetCVars(); }
    };
    expect(mkOdd()).toBe(mkOdd());
  });
});

// --- Worker parity suite (runs when the renderer lands the protocol) --------

const WORKER_COUNTS = [1, 3, 7];

describe.runIf(!!Q2_PAK && modelWorkerProtocolAvailable())('fg model/gun worker parity (protocol present)', () => {
  it.each(WORKER_COUNTS)('w=%i: combat scene full-RGBA + coverage vs serial', async (workers) => {
    const esm = swRendererEsmPath();
    expect(esm).not.toBeNull();
    const b = loadWorldBundle();
    const serialOf = (): { full: string; cover: number } => {
      resetCVars();
      const fb = createFramebuffer(320, 240, true);
      const r = new SoftwareRenderer();
      r.init(fb); r.setPalette(b.palette);
      setRGBWorldEnabled(true);
      try {
        const ents = sceneEntities(r, b, { gun: true, overlap: true });
        r.testExpireDynamicLights();
        r.testAddDynamicLight({
          origin: new Float32Array([SPAWN.origin[0] + 48, SPAWN.origin[1], SPAWN.origin[2] - 20]),
          intensity: 250, color: new Float32Array([1, 0.55, 0.15]),
        });
        r.beginFrame(); r.renderView(spawnView(), b.world, ents); r.endFrame();
        return { full: hashColorFull(r.getFramebuffer().color), cover: r.testRGBStats().coverPixels };
      } finally { setRGBWorldEnabled(false); resetCVars(); }
    };
    const ref = serialOf();
    resetCVars();
    const fb = createFramebuffer(320, 240, true);
    const r = new SoftwareRenderer();
    r.init(fb); r.setPalette(b.palette);
    setCVar(SW_WORKERS_CVAR, workers + 1);
    setCVar(SW_ACCUM_CVAR, 1);
    expect(r.syncWorkersFromCvar()).toBe(true);
    const pool = BandWorkerPool.create(workers, 320, 240, { indexJsPath: esm as string });
    expect(pool).not.toBeNull();
    r.attachWorkerPool(pool);
    try {
      setRGBWorldEnabled(true);
      try {
        const ents = sceneEntities(r, b, { gun: true, overlap: true });
        r.testExpireDynamicLights();
        r.testAddDynamicLight({
          origin: new Float32Array([SPAWN.origin[0] + 48, SPAWN.origin[1], SPAWN.origin[2] - 20]),
          intensity: 250, color: new Float32Array([1, 0.55, 0.15]),
        });
        r.beginFrame(); r.renderView(spawnView(), b.world, ents); r.endFrame();
      } finally { setRGBWorldEnabled(false); }
      expect(hashColorFull(r.getFramebuffer().color)).toBe(ref.full);
      expect(r.testRGBStats().coverPixels).toBe(ref.cover);
      const stats = readModelWorkerStats(r);
      expect(stats).not.toBeNull();
      expect(stats!.completedTris).toBeGreaterThan(0);
      expect(stats!.kicks).toBeGreaterThan(0);
      expect(r.testRGBPending()).toBe(0);
    } finally {
      await pool!.dispose();
      resetCVars();
    }
  });

  it('odd dims + band seams: 639x479 worker vs serial', async () => {
    const esm = swRendererEsmPath();
    expect(esm).not.toBeNull();
    const b = loadWorldBundle();
    const W = 639, H = 479;
    resetCVars();
    const sfb = createFramebuffer(W, H, true);
    const s = new SoftwareRenderer();
    s.init(sfb); s.setPalette(b.palette);
    setRGBWorldEnabled(true);
    let ref = '';
    try {
      const ents = sceneEntities(s, b, { gun: true });
      s.beginFrame(); s.renderView(spawnView(), b.world, ents); s.endFrame();
      ref = hashColorFull(s.getFramebuffer().color);
    } finally { setRGBWorldEnabled(false); resetCVars(); }
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb); r.setPalette(b.palette);
    setCVar(SW_WORKERS_CVAR, 4);
    setCVar(SW_ACCUM_CVAR, 1);
    expect(r.syncWorkersFromCvar()).toBe(true);
    const pool = BandWorkerPool.create(3, W, H, { indexJsPath: esm as string });
    expect(pool).not.toBeNull();
    r.attachWorkerPool(pool);
    try {
      setRGBWorldEnabled(true);
      try {
        const ents = sceneEntities(r, b, { gun: true });
        r.beginFrame(); r.renderView(spawnView(), b.world, ents); r.endFrame();
      } finally { setRGBWorldEnabled(false); }
      expect(hashColorFull(r.getFramebuffer().color)).toBe(ref);
      expect(r.testRGBPending()).toBe(0);
    } finally {
      await pool!.dispose();
      resetCVars();
    }
  });

  it('partial-job recovery with the model protocol falls back to serial-identical', async () => {
    const esm = swRendererEsmPath();
    expect(esm).not.toBeNull();
    const b = loadWorldBundle();
    resetCVars();
    const sfb = createFramebuffer(320, 240, true);
    const s = new SoftwareRenderer();
    s.init(sfb); s.setPalette(b.palette);
    setRGBWorldEnabled(true);
    let ref = '';
    try {
      const ents = sceneEntities(s, b, { gun: true, overlap: true });
      s.beginFrame(); s.renderView(spawnView(), b.world, ents); s.endFrame();
      ref = hashColorFull(s.getFramebuffer().color);
    } finally { setRGBWorldEnabled(false); resetCVars(); }
    const fb = createFramebuffer(320, 240, true);
    const r = new SoftwareRenderer();
    r.init(fb); r.setPalette(b.palette);
    setCVar(SW_WORKERS_CVAR, 4);
    setCVar(SW_ACCUM_CVAR, 1);
    expect(r.syncWorkersFromCvar()).toBe(true);
    const pool = BandWorkerPool.create(3, 320, 240, { indexJsPath: esm as string, timeoutMs: 1 });
    expect(pool).not.toBeNull();
    r.attachWorkerPool(pool);
    try {
      setRGBWorldEnabled(true);
      try {
        const ents = sceneEntities(r, b, { gun: true, overlap: true });
        r.beginFrame(); r.renderView(spawnView(), b.world, ents); r.endFrame();
      } finally { setRGBWorldEnabled(false); }
      expect(hashColorFull(r.getFramebuffer().color)).toBe(ref);
      expect(r.testRGBPending()).toBe(0);
      const stats = readModelWorkerStats(r);
      if (stats) expect(stats.kicks).toBe(0);
    } finally {
      await pool!.dispose();
      resetCVars();
    }
  });
});

describe('fg model/gun worker protocol status', () => {
  it('reports the protocol gap honestly when absent', () => {
    if (!Q2_PAK) {
      console.log('SKIP fg model/gun suite: Q2_PAK not set (needs real soldier/v_blast MD2)');
      return;
    }
    if (!modelWorkerProtocolAvailable()) {
      console.log(
        'SKIP fg model/gun worker parity: renderer publishes no model-worker ' +
        'protocol yet (testModelWorkerStats absent) — serial oracles above ' +
        'pin the target; browser real-worker proof stays open (apps/web lane)',
      );
      return;
    }
  });
});
