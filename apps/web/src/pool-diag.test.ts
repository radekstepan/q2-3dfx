// Production-loop worker diagnostics (item 9, apps/web lane, RELEASE-8).
//
// Shell-level pins for the pooled production path (frameAsync +
// resolveDisplay), complementing the renderer-level parity in
// @q2/sw-renderer:
//  - publishQ2Stats shape + never-throws (the window.__q2stats contract
//    soaks and CDP probes read).
//  - pooled indexed-raster engagement: frameAsync through an attached pool
//    matches the sync sim+resolve pixels, and the stats report pooled.
//  - renderer switching zeroes the shell scratch display.
//  - Q2_PAK-gated base1 frameAsync-vs-sync parity with the pool attached.
//  - long-run pool stability: 60 frames, real pixels, zero async fallbacks.
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

/** Attach a Node worker pool as this boot's browserPool (pool stand-in). */
function attachNodePool(boot: PlayBoot, workers: number): BandWorkerPool {
  const w = boot.host.fb.width;
  const h = boot.host.fb.height;
  const pool = BandWorkerPool.create(workers, w, h, { indexJsPath: DIST });
  if (!pool) throw new Error('pool unavailable (need worker_threads + SAB)');
  boot.refresh.attachWorkerPool(pool as unknown as never);
  (boot as unknown as Record<string, unknown>).browserPool = pool;
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
    expect(s.bands).toBe(1);
    expect(s.poolSpans).toBe(0);
    expect(s.poolPixels).toBe(0);
    expect(s.stageBytes).toBe(-1);
    expect(s.rasterFallbacks).toBe(0);
    expect(s.quarantined).toBe(false);
    expect(s.lastKickJob).toBe('none');
    expect(s.rasterSlowestMs).toBe(-1);
    expect(s.resolveSlowestMs).toBe(-1);
    expect(s.resolveOrder).toBe('none');
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

  it('never throws when renderer stat hooks throw (production present path safe)', () => {
    sandbox();
    const boot = bootPlay({ width: 32, height: 24 });
    const rec = boot.refresh as unknown as Record<string, unknown>;
    rec['testWorkerStats'] = (): never => {
      throw new Error('simulated future-renderer hook failure');
    };
    const s = publishQ2Stats(boot, 60, 3);
    expect(s.pooled).toBe(false);
    expect(s.bands).toBe(1);
    expect(s.poolSpans).toBe(0);
    expect(s.poolPixels).toBe(0);
    expect(s.resolveOrder).toBe(boot.lastResolveOrder);
  });

  it('pooled indexed raster engages through frameAsync: stats report pooled', async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'software');
    setCVar('sw_workers', 4);
    const boot = bootPlay({ width: 64, height: 48 });
    const pool = attachNodePool(boot, 3);
    try {
      const st = createAsyncLoopState();
      const out = await frameAsync(boot, st, 16.7);
      expect(out.some((v) => v !== 0)).toBe(true);
      const s = publishQ2Stats(boot, 60, 1);
      // The attached pool executed the indexed raster (never inferred from
      // the cvar alone).
      expect(s.pooled).toBe(true);
      expect(s.bands).toBeGreaterThan(1);
      expect(s.resolveOrder).toBe('software-passthrough');
      expect(s.rasterFallbacks).toBe(0);
      expect(s.asyncFallbacks).toBe(0);
    } finally {
      await pool.dispose();
    }
  });
});

describe('renderer switching zeroes shell scratch', () => {
  it('applyRendererCvar zeroes display; software resolve returns the live plane', async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'software');
    setCVar('sw_workers', 4);
    const boot = bootPlay({ width: 64, height: 48 });
    const pool = attachNodePool(boot, 3);
    try {
      const live = boot.refresh.getFramebuffer().color;
      live.fill(0xff00ff00);
      resolveDisplay(boot);
      // Re-latch the same renderer: scratch is zeroed, live plane intact.
      applyRendererCvar(boot);
      expect(boot.display.every((v) => v === 0)).toBe(true);
      live.fill(0xff00ff00);
      expect(resolveDisplay(boot)).toBe(live);
      expect(boot.lastResolveOrder).toBe('software-passthrough');
    } finally {
      await pool.dispose();
    }
  });
});

describe.runIf(!!WEB_Q2_PAK)('base1 production-loop parity (Q2_PAK, pooled indexed raster)', () => {
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

  it('frameAsync (pooled) matches sync sim+resolve, pool engaged', { timeout: 300000 }, async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'software');
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
        const ref = Array.from(resolveDisplay(a));
        // Production path: pumps + sim + pooled indexed raster inside.
        const out = Array.from(await frameAsync(b, stb, t));
        expect(out).toEqual(ref);
      }
      expect(b.host.serverTime).toBe(a.host.serverTime);
      expect([...b.host.playerOrigin]).toEqual([...a.host.playerOrigin]);
      expect(b.statAsyncFallbacks).toBe(0);
      // The pool executed the production frames (not inferred from cvar).
      expect(b.refresh.testWorkerStats().pooled).toBe(true);
      const s = publishQ2Stats(b, 60, FRAMES);
      expect(s.pooled).toBe(true);
      expect(s.asyncFallbacks).toBe(0);
    } finally {
      await pa.dispose();
      await pb.dispose();
    }
  });

  it('long-run pool stability: 60 pooled frames, real pixels, zero async fallbacks', { timeout: 300000 }, async () => {
    sandbox();
    setCVarFromString('vid_renderer', 'software');
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
        const out = await frameAsync(boot, st, t);
        if (out.some((v) => v !== 0)) nonzero++;
      }
      // Every frame drew real pixels (no wedged/blank worker output).
      expect(nonzero).toBe(60);
      expect(boot.statAsyncFallbacks).toBe(0);
    } finally {
      await pool.dispose();
    }
  });
});
