// Production-loop worker diagnostics (item 9, apps/web lane).
//
// Shell-level pins for the pooled production path (frameAsync +
// resolveDisplayAsync), complementing the renderer-level parity in
// @q2/sw-renderer (renderAsync/rgbWorkers/scanoutPool tests):
//  - publishQ2Stats shape + never-throws (the window.__q2stats contract
//    soaks and CDP probes read).
//  - pooled scanout kick accounting (statScanoutKicks) and kick-failure
//    fallback accounting (statScanoutFallbacks): fallbacks are counted,
//    never silent, and converge to serial-identical pixels.
//  - odd-dimension pooled scanout parity.
//  - renderer switching with a pool attached (no stale frame).
//  - Q2_PAK-gated base1 frameAsync-vs-sync parity WITH RGB workers engaged
//    (staged/kicks prove the workers executed in the production async path,
//    not just that sw_workers was nonzero).
//  - long-run cache ownership: steady kicks, zero fallbacks, sane output.
import { describe, expect, it, afterEach } from 'vitest';
import { getCVarNumber, resetCVars, setCVar, setCVarFromString } from '@q2/config';
import { BandWorkerPool } from '@q2/sw-renderer';
import {
  applyRendererCvar,
  bootPlay,
  createAsyncLoopState,
  frameAsync,
  pumpExplosionLights,
  pumpMuzzleLight,
  pumpTracers,
  resolveDisplay,
  resolveDisplayAsync,
  type PlayBoot,
} from './play.js';
import { publishQ2Stats, type Q2Stats } from './dom.js';

const DIST = new URL('../../../packages/sw-renderer/dist/index.mjs', import.meta.url).pathname;
const WEB_Q2_PAK = process.env.Q2_PAK;

const SAVED = new Map<string, number | string | boolean>();
function saveCvar(name: string): void {
  if (!SAVED.has(name)) {
    try {
      SAVED.set(name, getCVarNumber(name));
    } catch {
      SAVED.set(name, 0);
    }
  }
}
function sandbox(): void {
  for (const name of [
    'vid_renderer', 'r_brightness', 'vd_postfilter', 'vd_16bit', 'vd_dither',
    'vd_gamma', 'sw_workers', 'sw_accum', 'cl_showfps', 'cl_showpos',
  ]) {
    saveCvar(name);
  }
  setCVar('sw_workers', 0);
  setCVar('sw_accum', 1);
  setCVar('r_brightness', 1.0);
  setCVar('cl_showfps', 0);
  setCVar('cl_showpos', 0);
}
afterEach(() => {
  for (const [name, value] of SAVED) setCVar(name, value);
  resetCVars();
});

/** Smooth gradient stressing dither phase (never flat-field trivial). */
function paintLive(boot: PlayBoot): void {
  const w = boot.host.fb.width;
  const h = boot.host.fb.height;
  const live = boot.refresh.getFramebuffer().color;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.round((x * 255) / Math.max(1, w - 1));
      const g = Math.round((y * 255) / Math.max(1, h - 1));
      const b = Math.round(((x + y) * 255) / Math.max(1, w + h - 2));
      live[y * w + x] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
}

/** Attach a Node worker pool as this boot's browserPool (Track A stand-in). */
function attachNodePool(boot: PlayBoot, workers: number): BandWorkerPool {
  const w = boot.host.fb.width;
  const h = boot.host.fb.height;
  const pool = BandWorkerPool.create(workers, w, h, { indexJsPath: DIST });
  if (!pool) throw new Error('pool unavailable (need worker_threads + SAB)');
  boot.refresh.attachWorkerPool(pool as unknown as never);
  (boot as unknown as Record<string, unknown>).browserPool = pool;
  const sp = pool.scanoutPlanes;
  boot.fb565 = sp.scan565;
  boot.display = sp.scanDisplay;
  return pool;
}

describe('publishQ2Stats (window.__q2stats contract)', () => {
  it('echoes fps/frame with zero counters and software paths on a fresh boot', () => {
    sandbox();
    setCVarFromString('vid_renderer', 'software');
    const boot = bootPlay({ width: 64, height: 48 });
    const before = (globalThis as unknown as { __q2stats?: Q2Stats }).__q2stats;
    const s = publishQ2Stats(boot, 60, 7);
    expect(s.fps).toBe(60);
    expect(s.frame).toBe(7);
    expect(s.pooled).toBe(false);
    expect(s.rgbStaged).toBe(0);
    expect(s.rgbKicks).toBe(0);
    expect(s.rgbInline).toBe(0);
    expect(s.voodooPath).toBe('none');
    expect(s.resolveOrder).toBe('none');
    expect(s.scanoutKicks).toBe(0);
    expect(s.scanoutFallbacks).toBe(0);
    expect(s.asyncFallbacks).toBe(0);
    // After one software resolve the path records the passthrough branch.
    resolveDisplay(boot);
    expect(publishQ2Stats(boot, 60, 7).resolveOrder).toBe('software-passthrough');
    // The live record is published for CDP; the return is a copy.
    const live = (globalThis as unknown as { __q2stats?: Q2Stats }).__q2stats;
    expect(live).toBeDefined();
    expect(live!.frame).toBe(7);
    expect(before === undefined || live !== undefined).toBe(true);
    const copy = publishQ2Stats(boot, 30, 8);
    copy.frame = 999;
    expect((globalThis as unknown as { __q2stats?: Q2Stats }).__q2stats!.frame).toBe(8);
  });

  it('reflects voodoo resolve path + scanout counters after a pooled kick', async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'voodoo');
    setCVar('sw_workers', 4);
    const boot = bootPlay({ width: 64, height: 48 });
    const pool = attachNodePool(boot, 3);
    try {
      paintLive(boot);
      await resolveDisplayAsync(boot);
      expect(boot.lastVoodooPath).toBe('worker');
      expect(boot.statScanoutKicks).toBe(1);
      const s = publishQ2Stats(boot, 60, 1);
      expect(s.pooled).toBe(true);
      expect(s.voodooPath).toBe('worker');
      expect(s.resolveOrder).toBe('strict-hud-first');
      expect(s.scanoutKicks).toBe(1);
      expect(s.scanoutFallbacks).toBe(0);
    } finally {
      await pool.dispose();
    }
  });

  it('never throws when renderer stat hooks throw (production present path safe)', () => {
    sandbox();
    const boot = bootPlay({ width: 32, height: 24 });
    const rec = boot.refresh as unknown as Record<string, unknown>;
    rec['testWorkerStats'] = (): never => {
      throw new Error('simulated future-renderer hook failure');
    };
    const s = publishQ2Stats(boot, 60, 3);
    expect(s.pooled).toBe(false);
    expect(s.rgbStaged).toBe(0);
    expect(s.rgbKicks).toBe(0);
    expect(s.rgbInline).toBe(0);
    expect(s.voodooPath).toBe(boot.lastVoodooPath);
    expect(s.scanoutKicks).toBe(boot.statScanoutKicks);
  });
});

describe('resolveDisplayAsync accounting (kicks counted, fallbacks counted)', () => {
  it('kick-failure (false) falls back to serial-identical pixels and counts once', async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'voodoo');
    setCVar('sw_workers', 4);
    const boot = bootPlay({ width: 64, height: 48 });
    const pool = attachNodePool(boot, 3);
    try {
      paintLive(boot);
      const serial = Array.from(resolveDisplay(boot));
      expect(boot.lastVoodooPath).toBe('serial');
      // Dead pool: every kick refuses, exercising the fallback counter.
      (boot as unknown as Record<string, unknown>).browserPool = {
        flushScanoutAsync: async (): Promise<boolean> => false,
      };
      paintLive(boot);
      const fb = Array.from(await resolveDisplayAsync(boot));
      expect(fb).toEqual(serial);
      expect(boot.lastVoodooPath).toBe('serial');
      expect(boot.lastResolveOrder).toBe('strict-hud-first');
      expect(boot.statScanoutKicks).toBe(0);
      expect(boot.statScanoutFallbacks).toBe(1);
      const s = publishQ2Stats(boot, 60, 2);
      expect(s.scanoutFallbacks).toBe(1);
      expect(s.voodooPath).toBe('serial');
    } finally {
      await pool.dispose();
    }
  });

  it('kick-throw falls back to serial-identical pixels and counts once', async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'voodoo');
    setCVar('sw_workers', 4);
    const boot = bootPlay({ width: 64, height: 48 });
    const pool = attachNodePool(boot, 3);
    try {
      paintLive(boot);
      const serial = Array.from(resolveDisplay(boot));
      (boot as unknown as Record<string, unknown>).browserPool = {
        flushScanoutAsync: async (): Promise<boolean> => {
          throw new Error('simulated dead worker');
        },
      };
      paintLive(boot);
      const fb = Array.from(await resolveDisplayAsync(boot));
      expect(fb).toEqual(serial);
      expect(boot.statScanoutFallbacks).toBe(1);
      expect(boot.statScanoutKicks).toBe(0);
    } finally {
      await pool.dispose();
    }
  });

  it('odd dimensions (65x49) pooled scanout matches serial', async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'voodoo');
    setCVar('sw_workers', 4);
    const boot = bootPlay({ width: 65, height: 49 });
    const pool = attachNodePool(boot, 3);
    try {
      paintLive(boot);
      const serial = Array.from(resolveDisplay(boot));
      paintLive(boot);
      const pooled = Array.from(await resolveDisplayAsync(boot));
      expect(pooled).toEqual(serial);
      expect(boot.lastVoodooPath).toBe('worker');
      expect(boot.statScanoutKicks).toBe(1);
      expect(boot.statScanoutFallbacks).toBe(0);
    } finally {
      await pool.dispose();
    }
  });

  it('renderer switching with a pool zeroes scratch and re-arms the worker path', async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'voodoo');
    setCVar('sw_workers', 4);
    const boot = bootPlay({ width: 64, height: 48 });
    const pool = attachNodePool(boot, 3);
    try {
      paintLive(boot);
      await resolveDisplayAsync(boot);
      expect(boot.lastVoodooPath).toBe('worker');
      // Switch to software: passthrough of the live plane, no voodoo path.
      setCVarFromString('vid_renderer', 'software');
      applyRendererCvar(boot);
      expect(boot.display.every((v) => v === 0)).toBe(true);
      const live = boot.refresh.getFramebuffer().color;
      live.fill(0xff00ff00);
      expect(resolveDisplay(boot)).toBe(live);
      expect(boot.lastVoodooPath).toBe('none');
      // Switch back: the pooled worker path re-arms, scratch was zeroed.
      setCVarFromString('vid_renderer', 'voodoo');
      applyRendererCvar(boot);
      expect(boot.display.every((v) => v === 0)).toBe(true);
      paintLive(boot);
      const serial = Array.from(resolveDisplay(boot));
      paintLive(boot);
      const pooled = Array.from(await resolveDisplayAsync(boot));
      expect(pooled).toEqual(serial);
      expect(boot.lastVoodooPath).toBe('worker');
    } finally {
      await pool.dispose();
    }
  });
});

describe.runIf(!!WEB_Q2_PAK)('base1 production-loop parity (Q2_PAK, RGB workers)', () => {
  async function bootBase1Pooled(w: number, h: number): Promise<{ boot: PlayBoot; pool: BandWorkerPool }> {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const boot = bootPlay({ width: w, height: h, pak: ingestPak(buf) });
    const pool = attachNodePool(boot, 3);
    return { boot, pool };
  }

  it('frameAsync (pooled RGB + pooled scanout) matches sync sim+resolve, RGB kicks engaged', { timeout: 300000 }, async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'voodoo');
    setCVar('sw_workers', 4);
    const { boot: a, pool: pa } = await bootBase1Pooled(96, 72);
    const { boot: b, pool: pb } = await bootBase1Pooled(96, 72);
    try {
      const stb = createAsyncLoopState();
      let t = 0;
      const FRAMES = 20;
      for (let f = 0; f < FRAMES; f++) {
        t += 16.7;
        const yaw = (f * 13) % 360;
        // Attack window mid-run: muzzle flash + tracer + bolt dlights, so
        // the parity covers the dynamic-light foreground, not just the map.
        const attack = f >= 5 && f < 10;
        for (const boot of [a, b]) {
          boot.host.input.angles = [0, yaw, 0];
          boot.host.input.buttons = attack ? 1 : 0;
        }
        // Sync reference: the exact pump set frameAsync runs, then
        // host.frame (sim) + serial resolveDisplay.
        pumpMuzzleLight(a);
        pumpExplosionLights(a);
        pumpTracers(a);
        a.host.frame(t);
        const hud = { fps: 60, frame: f };
        const ref = Array.from(resolveDisplay(a, hud));
        // Production path: pumps + sim + async RGB/scanout kicks inside.
        const out = Array.from(await frameAsync(b, stb, t, hud));
        expect(out).toEqual(ref);
        // RGB workers executed in the production path (not inferred from
        // the cvar): batches staged and exactly one RGB kick this frame.
        const rs = b.refresh.testRGBWorkerStats();
        expect(rs.staged).toBeGreaterThan(0);
        expect(rs.kicks).toBe(1);
      }
      expect(b.host.serverTime).toBe(a.host.serverTime);
      expect([...b.host.playerOrigin]).toEqual([...a.host.playerOrigin]);
      expect(b.statScanoutFallbacks).toBe(0);
      expect(b.statScanoutKicks).toBe(FRAMES);
      expect(b.statAsyncFallbacks).toBe(0);
      const s = publishQ2Stats(b, 60, FRAMES);
      expect(s.pooled).toBe(true);
      expect(s.voodooPath).toBe('worker');
      expect(s.scanoutKicks).toBe(FRAMES);
      expect(s.scanoutFallbacks).toBe(0);
    } finally {
      await pa.dispose();
      await pb.dispose();
    }
  });

  it('long-run cache ownership: 60 pooled frames, steady kicks, zero fallbacks', { timeout: 300000 }, async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'voodoo');
    setCVar('sw_workers', 4);
    const { boot, pool } = await bootBase1Pooled(96, 72);
    try {
      const st = createAsyncLoopState();
      let t = 0;
      let nonzero = 0;
      for (let f = 0; f < 60; f++) {
        t += 16.7;
        boot.host.input.angles = [0, (f * 7) % 360, 0];
        // Combat movement + periodic fire: doors, dlights, tracers, bolts.
        boot.host.input.buttons = f % 10 < 3 ? 1 : 0;
        if (f % 10 === 0) boot.host.input.keys.add('forward');
        if (f % 10 === 5) boot.host.input.keys.delete('forward');
        const out = await frameAsync(boot, st, t, { fps: 60, frame: f });
        const rs = boot.refresh.testRGBWorkerStats();
        expect(rs.staged).toBeGreaterThan(0);
        expect(rs.kicks).toBe(1);
        expect(rs.inline).toBe(0);
        if (out.some((v) => v !== 0)) nonzero++;
      }
      // Every frame drew real pixels (no wedged/blank worker output).
      expect(nonzero).toBe(60);
      expect(boot.statScanoutKicks).toBe(60);
      expect(boot.statScanoutFallbacks).toBe(0);
      expect(boot.statAsyncFallbacks).toBe(0);
    } finally {
      await pool.dispose();
    }
  });
});
