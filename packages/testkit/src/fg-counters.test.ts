// Foreground counter truthfulness (PERF-FINISH follow-up item 3,
// bench/testkit lane).
//
// The renderer publishes the per-class foreground breakdown through
// `testForegroundStats()` (prepared/staged vs worker-completed vs
// calling-thread vs deliberately inline vs fallback/replayed, in native
// units — never mixed). These tests pin the corrected semantics:
//
//   - serial viewmodel rendering is visible in INLINE counters
//     (aliasDrawsInline/aliasTrisInline > 0 while staged == 0, kicks == 0,
//     worker-completed == 0);
//   - successful worker execution is visible in COMPLETED counters
//     (workerSpansCompleted/workerPixelsCompleted > 0 with kicks > 0 —
//     kicks count completions, not dispatches);
//   - staged-but-failed work is NOT reported as worker-rendered: after a
//     forced timeout the world kick counts zero completions while
//     recoveryCount/replayedSpans prove the replay ran instead.
//
// The breakdown hook is landing with the renderer lane: every strict leg
// reads it through `readForegroundStats()` and skips clearly when absent;
// the legacy batch legs (testRGBWorkerStats/testForegroundWorkerStats)
// always run so the file still guards the old contract on older builds.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'fs';
import { createFramebuffer } from '@q2/renderer-api';
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
import { hashColorFull, pngDiff, readForegroundStats } from './index.js';

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
    console.log('SKIP pooled counters: sw-renderer dist not built (run yarn build first)');
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

describe('fg counter truthfulness', () => {
  it('serial devroom RGB: inline counted, staged/kicks/worker-completed zero', () => {
    const W = 160, H = 120;
    resetCVars();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(new Uint8Array(768).fill(128));
    setRGBWorldEnabled(true);
    try {
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
      const wst = r.testRGBWorkerStats();
      const fg = r.testForegroundWorkerStats();
      // Serial foreground work (the world sprite) is VISIBLE in inline —
      // never silently zero while pixels were drawn.
      expect(fg.inline).toBeGreaterThan(0);
      expect(fg.staged).toBe(0);
      expect(fg.kicks).toBe(0);
      expect(wst.staged).toBe(0);
      expect(wst.kicks).toBe(0);
      expect(r.testRGBStats().coverPixels).toBeGreaterThan(0);
      const stats = readForegroundStats(r);
      if (!stats) {
        console.log('SKIP per-class legs: testForegroundStats absent in this dist');
        return;
      }
      expect(stats.stagedBatches).toBe(0);
      expect(stats.kicks).toBe(0);
      expect(stats.workerSpansCompleted).toBe(0);
      expect(stats.workerPixelsCompleted).toBe(0);
      expect(stats.recoveryCount).toBe(0);
      expect(stats.replayedSpans).toBe(0);
      expect(stats.spriteDrawsInline).toBeGreaterThan(0);
    } finally {
      setRGBWorldEnabled(false);
      resetCVars();
    }
  });

  it('pooled devroom RGB: staged work completed on workers is counted', async () => {
    const W = 320, H = 240;
    resetCVars();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(new Uint8Array(768).fill(128));
    const pool = attachPool(r, W, H, 3);
    if (!pool) return;
    try {
      setRGBWorldEnabled(true);
      try {
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
      } finally {
        setRGBWorldEnabled(false);
      }
      const wst = r.testRGBWorkerStats();
      const fg = r.testForegroundWorkerStats();
      expect(wst.staged).toBeGreaterThan(0);
      expect(wst.kicks).toBeGreaterThan(0);
      expect(fg.staged).toBeGreaterThan(0);
      expect(fg.kicks).toBeGreaterThan(0);
      const stats = readForegroundStats(r);
      if (!stats) {
        console.log('SKIP per-class legs: testForegroundStats absent in this dist');
        return;
      }
      // Actual completion — not staging — is what the worker counters prove.
      expect(stats.workerSpansCompleted).toBeGreaterThan(0);
      expect(stats.workerPixelsCompleted).toBeGreaterThan(0);
      expect(stats.kicks).toBeGreaterThan(0);
      expect(stats.recoveryCount).toBe(0);
      expect(stats.spriteSpansStaged).toBeGreaterThan(0);
      // (No absolute-pending assert: the retained-frame protocol keeps
      // descriptors until commitRGB; health is proven by next-frame tests
      // in fg-recovery.test.ts.)
    } finally {
      await pool.dispose();
      resetCVars();
    }
  });

  it('staged-but-failed work is NOT counted as worker-rendered', async () => {
    const W = 640, H = 480;
    const world = { name: 'devroom', data: createDevroom() };
    const view = {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
    };
    // Serial oracle for the consistency leg below.
    resetCVars();
    const serial = (() => {
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(new Uint8Array(768).fill(128));
      setRGBWorldEnabled(true);
      try {
        r.beginFrame();
        r.renderView(view, world, []);
        r.endFrame();
        return { full: hashColorFull(r.getFramebuffer().color), color: r.getFramebuffer().color.slice() };
      } finally {
        setRGBWorldEnabled(false);
        resetCVars();
      }
    })();
    resetCVars();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(new Uint8Array(768).fill(128));
    const pool = attachPool(r, W, H, 3, 1);
    if (!pool) return;
    try {
      setRGBWorldEnabled(true);
      try {
        r.beginFrame();
        r.renderView(view, world, []);
        r.endFrame();
      } finally {
        setRGBWorldEnabled(false);
      }
      const wst = r.testRGBWorkerStats();
      const fg = r.testForegroundWorkerStats();
      // The heavy world kick (~30ms pooled at 640x480) cannot complete
      // inside a 1ms budget: work WAS staged, nothing completed — staging
      // is never reported as execution. (A tiny FG group may legitimately
      // complete first; that completion is truthful and converges to the
      // same planes — see the consistency leg.)
      expect(wst.staged).toBeGreaterThan(0);
      expect(wst.kicks).toBe(0);
      const stats = readForegroundStats(r);
      if (!stats) {
        console.log('SKIP per-class legs: testForegroundStats absent in this dist');
      } else {
        // The replay ran (and did real work) instead of a worker completion.
        expect(stats.recoveryCount).toBeGreaterThan(0);
        expect(stats.replayedSpans).toBeGreaterThan(0);
        expect(stats.kicks).toBe(fg.kicks);
      }
      const live = r.getFramebuffer().color;
      const diff = pngDiff(live, serial.color);
      if (diff !== 0) console.log(`failed-kick output diff: ${diff}/${live.length} pixels vs serial`);
      expect(hashColorFull(live)).toBe(serial.full);
    } finally {
      await pool.dispose();
      resetCVars();
    }
  });

  it.runIf(!!Q2_PAK)('serial viewmodel combat scene counts inline (nothing hidden)', () => {
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
    const world: { name: string; data: MiniWorld } = {
      name: 'base1', data: bspToMiniWorld(map, { texelFor }),
    };
    const palette = parsePCX(pak.readFile('pics/colormap.pcx')).palette;
    const origin: [number, number, number] = [-168, 0, 136];
    const mk = (gun: boolean): { full: string; fgInline: number; staged: number; kicks: number } => {
      resetCVars();
      const fb = createFramebuffer(320, 240, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(palette);
      const gunMd2 = parseMD2(pak.readFile('models/weapons/v_blast/tris.md2').slice(0));
      const gunSkin = parsePCX(pak.readFile('models/weapons/v_blast/skin.pcx'));
      const gh = r.registerModel({ name: 'v-blast', kind: 'md2', data: gunMd2 });
      const gs = r.registerSkinPixels('v-blast-skin', gunSkin.pixels, gunSkin.width, gunSkin.height);
      // A world sprite alongside the gun: the sprite is span-based (drives
      // the legacy fg.inline leg unpooled) while the gun is per-pixel alias
      // (drives the per-class alias legs).
      const sp2 = r.registerModel({ name: 'shot-sprite', kind: 'sp2', data: null });
      setRGBWorldEnabled(true);
      try {
        // v_blast frame 4: the representative visible pose (frame 0 is
        // degenerate head-on — zero covered pixels, see fg-models.test.ts).
        const ents = gun ? [{
          model: gh, origin: new Float32Array(origin),
          angles: new Float32Array([0, 0, 0]), frame: 4, skin: gs,
          depthHack: true,
        },
        {
          model: sp2, origin: new Float32Array([origin[0] + 48, origin[1], origin[2] + 18]),
          angles: new Float32Array([0, 0, 0]), frame: 0, skin: gs,
        }] : [];
        r.beginFrame();
        r.renderView(
          {
            origin: new Float32Array(origin), angles: new Float32Array([0, 0, 0]),
            fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
          },
          world, ents,
        );
        r.endFrame();
        const fg = r.testForegroundWorkerStats();
        const wst = r.testRGBWorkerStats();
        const stats = readForegroundStats(r);
        if (gun && stats) {
          // The serial viewmodel (per-pixel alias, depthHack) and the
          // entity sprite are VISIBLE in the per-class inline counters —
          // expensive work never hides. (Legacy batch counters read ZERO
          // here by design: they track span batches only, never
          // per-pixel/triangle draws — the item-3 gap this taxonomy closes.)
          expect(stats.aliasDrawsInline).toBeGreaterThan(0);
          expect(stats.aliasTrisInline).toBeGreaterThan(0);
          expect(stats.spriteDrawsInline).toBeGreaterThan(0);
          expect(stats.workerSpansCompleted).toBe(0);
          expect(stats.workerPixelsCompleted).toBe(0);
          expect(stats.kicks).toBe(0);
        } else if (gun) {
          console.log('SKIP per-class legs: testForegroundStats absent in this dist (legacy batch counters cannot see per-pixel alias/sprite work)');
        }
        return {
          full: hashColorFull(r.getFramebuffer().color),
          fgInline: fg.inline, staged: wst.staged + fg.staged, kicks: wst.kicks + fg.kicks,
        };
      } finally {
        setRGBWorldEnabled(false);
        resetCVars();
      }
    };
    const withGun = mk(true);
    const withoutGun = mk(false);
    // The gun + sprite are visible (frame differs) yet no worker completion
    // is ever reported for serial work.
    expect(withGun.full).not.toBe(withoutGun.full);
    expect(withGun.kicks).toBe(0);
    expect(withGun.staged).toBe(0);
  });
});
