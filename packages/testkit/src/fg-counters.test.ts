// Foreground counter truthfulness (PERF-FINISH follow-up item 3,
// bench/testkit lane).
//
// The per-class foreground breakdown (`testForegroundStats`) retired with
// the RGB composite under RELEASE-8: `readForegroundStats` now reads null
// on the live renderer and the per-class legs below skip clearly. What
// stays pinned on every build:
//
//   - serial indexed rendering is deterministic, draws cover, and runs
//     unpooled (testWorkerStats: active == pooled == false);
//   - successful pooled execution is proven through public hooks
//     (testWorkerStats: active + pooled with spans/pixels > 0) — never
//     pool existence alone — and pooled output is full-RGBA identical to
//     serial for the same scene;
//   - staged-but-failed work still converges: a forced-timeout pooled frame
//     is pixel-identical to the serial oracle (recovery replays inline).
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
  it('serial devroom indexed: deterministic, covered, unpooled', () => {
    const W = 160, H = 120;
    const renderOnce = (): { full: string; cover: number } => {
      resetCVars();
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(new Uint8Array(768).fill(128));
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
      const wst = r.testWorkerStats();
      // Serial foreground work runs unpooled — never silently pooled while
      // pixels were drawn.
      expect(wst.active).toBe(false);
      expect(wst.pooled).toBe(false);
      const live = r.getFramebuffer();
      // Cover = depth-written pixels (the depth plane clears to 0;
      // palette index 0 is a legitimate texel, so the index plane
      // cannot prove coverage).
      let cover = 0;
      for (let i = 0; i < live.depth!.length; i++) if (live.depth![i] !== 0) cover++;
      expect(cover).toBeGreaterThan(0);
      resetCVars();
      return { full: hashColorFull(live.color), cover };
    };
    const a = renderOnce();
    const b = renderOnce();
    expect(b.full).toBe(a.full);
    expect(b.cover).toBe(a.cover);
    const stats = readForegroundStats(new SoftwareRenderer());
    // The per-class producer retired with the RGB composite: the reader
    // must report unknown (null), never a fake zero.
    expect(stats).toBeNull();
  });

  it('pooled devroom indexed: staged work executes on workers; output == serial', async () => {
    const W = 320, H = 240;
    // Serial oracle.
    resetCVars();
    const sfb = createFramebuffer(W, H, true);
    const sr = new SoftwareRenderer();
    sr.init(sfb);
    sr.setPalette(new Uint8Array(768).fill(128));
    sr.beginFrame();
    sr.renderView(
      {
        origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
        fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
      },
      { name: 'devroom', data: createDevroom() },
      [],
    );
    sr.endFrame();
    const oracle = hashColorFull(sr.getFramebuffer().color);
    resetCVars();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(new Uint8Array(768).fill(128));
    const pool = attachPool(r, W, H, 3);
    if (!pool) return;
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
      const wst = r.testWorkerStats();
      // Actual execution — not pool existence — is what the worker hooks prove.
      expect(wst.active).toBe(true);
      expect(wst.pooled).toBe(true);
      expect(wst.spans).toBeGreaterThan(0);
      expect(wst.pixels).toBeGreaterThan(0);
      expect(hashColorFull(r.getFramebuffer().color)).toBe(oracle);
    } finally {
      await pool.dispose();
      resetCVars();
    }
  });

  it('staged-but-failed work still converges to the serial oracle', async () => {
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
      r.beginFrame();
      r.renderView(view, world, []);
      r.endFrame();
      const out = { full: hashColorFull(r.getFramebuffer().color), color: r.getFramebuffer().color.slice() };
      resetCVars();
      return out;
    })();
    resetCVars();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(new Uint8Array(768).fill(128));
    const pool = attachPool(r, W, H, 3, 1);
    if (!pool) return;
    try {
      r.beginFrame();
      r.renderView(view, world, []);
      r.endFrame();
      // The heavy world kick (~30ms pooled at 640x480) cannot complete
      // inside a 1ms budget — the renderer replays inline on timeout, so
      // the recovered frame must still equal serial.
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
    const mk = (gun: boolean): { full: string; pooled: boolean } => {
      resetCVars();
      const fb = createFramebuffer(320, 240, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(palette);
      const gunMd2 = parseMD2(pak.readFile('models/weapons/v_blast/tris.md2').slice(0));
      const gunSkin = parsePCX(pak.readFile('models/weapons/v_blast/skin.pcx'));
      const gh = r.registerModel({ name: 'v-blast', kind: 'md2', data: gunMd2 });
      const gs = r.registerSkinPixels('v-blast-skin', gunSkin.pixels, gunSkin.width, gunSkin.height);
      // A world sprite alongside the gun: the sprite is span-based while
      // the gun is per-pixel alias — both must be visible serially.
      const sp2 = r.registerModel({ name: 'shot-sprite', kind: 'sp2', data: null });
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
      const wst = r.testWorkerStats();
      const out = {
        full: hashColorFull(r.getFramebuffer().color),
        pooled: wst.pooled,
      };
      resetCVars();
      return out;
    };
    const withGun = mk(true);
    const withoutGun = mk(false);
    // The gun + sprite are visible (frame differs) yet nothing is ever
    // pooled for serial work.
    expect(withGun.full).not.toBe(withoutGun.full);
    expect(withGun.pooled).toBe(false);
    expect(withoutGun.pooled).toBe(false);
  });
});
