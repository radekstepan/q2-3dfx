// q2ts-web worker-band RGB groundwork (astra §5 shell side).
//
// Shell-owned protocol pins: one VoodooState snapshot per frame goes to
// every band with absolute screen coords (same values, never per-pixel
// reads); the shell waits for ALL bands, then runs the ONE global serial
// resolve so filter taps cross band boundaries. Until a worker/WASM voodoo
// backend exists the path stays explicit `serial` (never silent software).
import { describe, expect, it, afterEach } from 'vitest';
import { getCVarNumber, setCVar } from '@q2/config';
import { readVoodooState } from '@q2/voodoo';
import { splitBands } from '@q2/sw-renderer';
import {
  applyRendererCvar,
  bootPlay,
  broadcastBandVoodoo,
  createAsyncLoopState,
  frameAsync,
  resolveDisplay,
  type PlayBoot,
} from './play.js';
import {
  selectVoodooBandPath,
  snapshotVoodooState,
  voodooBandEnvelopes,
  voodooBandMessages,
} from './render-workers.js';
import type { BrowserBandPool } from './render-workers.js';

// Cvar sandbox: every test leaves the global registry as it found it.
const SAVED = new Map<string, number | string | boolean>();
const ABSENT_DEFAULTS: Record<string, number> = {
  sw_workers: 0,
  cl_showfps: 1,
  cl_showpos: 1,
};
const ABSENT = new Set<string>();
function saveCvar(name: string): void {
  if (!SAVED.has(name) && !ABSENT.has(name)) {
    try {
      SAVED.set(name, getCVarNumber(name));
    } catch {
      ABSENT.add(name);
    }
  }
}
function sandbox(): void {
  for (const name of ['vid_renderer', 'r_brightness', 'vd_postfilter', 'vd_16bit', 'vd_dither', 'vd_gamma', 'sw_workers', 'cl_showfps', 'cl_showpos']) {
    saveCvar(name);
  }
  setCVar('vid_renderer', 'voodoo');
  setCVar('r_brightness', 1.0);
  setCVar('cl_showfps', 0);
  setCVar('cl_showpos', 0);
}
afterEach(() => {
  for (const [name, value] of SAVED) setCVar(name, value);
  for (const name of ABSENT) {
    const def = ABSENT_DEFAULTS[name];
    if (def !== undefined) setCVar(name, def);
  }
});

/** Smooth RGB gradient stressing dither phase (never flat-field trivial). */
function paintGradient(boot: PlayBoot): void {
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

describe('voodoo band messages (one snapshot, absolute coords)', () => {
  it('every band shares the identical snapshot reference with full-frame coverage', () => {
    const st = snapshotVoodooState();
    expect(typeof st.gamma).toBe('number');
    const bands = splitBands(48, 4);
    const msgs = voodooBandMessages(st, bands, 64, 48);
    expect(msgs.length).toBe(4);
    for (const m of msgs) {
      expect(m.voodooState).toBe(st);
      expect(m.width).toBe(64);
      expect(m.height).toBe(48);
    }
    expect(msgs[0]!.y0).toBe(0);
    expect(msgs[msgs.length - 1]!.y1).toBe(48);
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i]!.y0).toBe(msgs[i - 1]!.y1);
      expect(msgs[i]!.band).toBe(i);
    }
    // Envelopes agree on the same contract (same ref, absolute rows).
    const envs = voodooBandEnvelopes(st, bands, 64, 48);
    expect(envs.length).toBe(msgs.length);
    for (let i = 0; i < envs.length; i++) {
      expect(envs[i]!.state).toBe(st);
      expect(envs[i]!.y0).toBe(msgs[i]!.y0);
      expect(envs[i]!.y1).toBe(msgs[i]!.y1);
    }
  });

  it('path selection stays explicit serial with or without a pool', () => {
    expect(selectVoodooBandPath(false)).toBe('serial');
    expect(selectVoodooBandPath(true)).toBe('serial');
  });

  it('broadcastBandVoodoo is a no-op without a pool and never throws', () => {
    sandbox();
    const boot = bootPlay({ width: 32, height: 24 });
    expect(boot.browserPool).toBeNull();
    const st = snapshotVoodooState();
    expect(broadcastBandVoodoo(boot, st)).toBe(0);
    // A throwing pool degrades to 0 instead of breaking the frame.
    boot.browserPool = {
      broadcastVoodooState: (): number => {
        throw new Error('dead worker');
      },
    } as unknown as BrowserBandPool;
    expect(broadcastBandVoodoo(boot, st)).toBe(0);
  });

  it('frameAsync broadcasts one snapshot per frame in voodoo mode only', async () => {
    sandbox();
    const boot = bootPlay({ width: 64, height: 48 });
    const seen: unknown[] = [];
    boot.browserPool = {
      broadcastVoodooState: (s: unknown): number => {
        seen.push(s);
        return 3;
      },
    } as unknown as BrowserBandPool;
    const st = createAsyncLoopState();
    setCVar('vid_renderer', 'voodoo');
    await frameAsync(boot, st, 16.7);
    expect(seen.length).toBe(1);
    const sent = seen[0] as Record<string, unknown>;
    expect(typeof sent['gamma']).toBe('number');
    await frameAsync(boot, st, 33.4);
    expect(seen.length).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
    // Software mode snapshots nothing and broadcasts nothing.
    setCVar('vid_renderer', 'software');
    await frameAsync(boot, st, 50.1);
    expect(seen.length).toBe(2);
  });
});

describe('resolve consumes the passed frame snapshot (single snapshot per frame)', () => {
  it('frameState wins over live cvars: bands and scanout cannot disagree', () => {
    sandbox();
    const W = 64;
    const H = 48;
    setCVar('vd_gamma', 1.0);
    setCVar('vd_dither', 1);
    setCVar('vd_postfilter', 1);
    setCVar('vd_16bit', 1);
    const a = bootPlay({ width: W, height: H });
    const b = bootPlay({ width: W, height: H });
    paintGradient(a);
    paintGradient(b);
    // Snapshot under gamma 1.0, then move the live cvar: the resolve that
    // takes the snapshot must match a control resolved live under 1.0.
    const st = readVoodooState();
    const control = Array.from(resolveDisplay(a));
    setCVar('vd_gamma', 2.0);
    const stashed = Array.from(resolveDisplay(b, undefined, st));
    expect(stashed).toEqual(control);
    // And the live-cvar resolve under 2.0 provably differs (test bites).
    const moved = Array.from(resolveDisplay(a));
    expect(moved).not.toEqual(control);
  });
});

describe('banded-vs-serial byte-identical (gradient dither phase + seams)', () => {
  it('gradient resolves identical across the whole frame incl. band boundaries', () => {
    sandbox();
    setCVar('sw_workers', 0);
    const serial = bootPlay({ width: 64, height: 48 });
    setCVar('sw_workers', 4);
    const banded = bootPlay({ width: 64, height: 48 });
    expect(banded.refresh.testWorkerStats().active).toBe(true);
    try {
      setCVar('vid_renderer', 'voodoo');
      setCVar('vd_gamma', 1.3);
      setCVar('vd_dither', 1);
      setCVar('vd_16bit', 1);
      setCVar('vd_postfilter', 1);
      paintGradient(serial);
      paintGradient(banded);
      const a = Array.from(resolveDisplay(serial));
      const b = Array.from(resolveDisplay(banded));
      expect(b).toEqual(a);
      // Explicit seam check: every band-boundary row pair matches, so no
      // per-band dither restart is visible at a seam.
      const bands = splitBands(48, banded.refresh.testWorkerStats().bands);
      expect(bands.length).toBeGreaterThan(1);
      for (const band of bands.slice(1)) {
        const y = band.y0;
        for (let x = 0; x < 64; x++) {
          expect(b[(y - 1) * 64 + x]).toBe(a[(y - 1) * 64 + x]);
          expect(b[y * 64 + x]).toBe(a[y * 64 + x]);
        }
      }
      expect(serial.lastVoodooPath).toBe('serial');
      expect(banded.lastVoodooPath).toBe('serial');
    } finally {
      setCVar('sw_workers', 0);
    }
  });
});

describe('single resolve owner (renderer never scans out)', () => {
  it('endFrame leaves shell scratch untouched; exactly one shell resolve fills it', () => {
    sandbox();
    const boot = bootPlay({ width: 64, height: 48 });
    setCVar('vid_renderer', 'voodoo');
    setCVar('vd_gamma', 1.0);
    setCVar('vd_dither', 0);
    setCVar('vd_postfilter', 0);
    setCVar('vd_16bit', 1);
    applyRendererCvar(boot);
    // Stock renderer exposes no scanout-done flag: the shell must resolve.
    const rec = boot.refresh as unknown as Record<string, unknown>;
    expect(typeof rec['voodooScanoutDone']).not.toBe('function');
    boot.fb565.fill(0);
    boot.display.fill(0);
    let t = 0;
    for (let f = 0; f < 3; f++) {
      t += 16.7;
      boot.host.frame(t);
    }
    // renderView + endFrame painted the engine planes but never the
    // shell-owned post-scanout scratch (palette-expand only, no voodoo).
    expect(boot.fb565.every((v) => v === 0)).toBe(true);
    expect(boot.display.every((v) => v === 0)).toBe(true);
    // The ONE shell resolve fills both planes exactly once.
    const out = resolveDisplay(boot);
    expect(out).toBe(boot.display);
    expect(boot.display.some((v) => v !== 0)).toBe(true);
    expect(boot.fb565.some((v) => v !== 0)).toBe(true);
    expect(boot.lastResolveOrder).toBe('strict-hud-first');
    expect(boot.lastVoodooPath).toBe('serial');
  });
});

describe('mode-switch cache invalidation (no stale frame)', () => {
  it('switching calls the invalidate hooks and zeroes scratch before resolve', () => {
    sandbox();
    const boot = bootPlay({ width: 32, height: 24 });
    const calls: Array<{ hook: string; on?: boolean }> = [];
    const rec = boot.refresh as unknown as Record<string, unknown>;
    rec['setRGBWorldEnabled'] = (on: boolean): void => {
      calls.push({ hook: 'setRGBWorldEnabled', on });
    };
    rec['invalidateCaches'] = (): void => {
      calls.push({ hook: 'invalidateCaches' });
    };
    setCVar('vid_renderer', 'voodoo');
    applyRendererCvar(boot);
    expect(calls).toEqual([
      { hook: 'setRGBWorldEnabled', on: true },
      { hook: 'invalidateCaches' },
    ]);
    expect(boot.display.every((v) => v === 0)).toBe(true);
    expect(boot.fb565.every((v) => v === 0)).toBe(true);
    // Dirty scratch + switch away: zeroed immediately, hooks re-armed.
    boot.display.fill(0xdeadbeef);
    boot.fb565.fill(0x1234);
    setCVar('vid_renderer', 'software');
    applyRendererCvar(boot);
    expect(calls).toEqual([
      { hook: 'setRGBWorldEnabled', on: true },
      { hook: 'invalidateCaches' },
      { hook: 'setRGBWorldEnabled', on: false },
      { hook: 'invalidateCaches' },
    ]);
    expect(boot.display.every((v) => v === 0)).toBe(true);
    expect(boot.fb565.every((v) => v === 0)).toBe(true);
    // Fresh frame after the switch shows current pixels, never stale voodoo.
    setCVar('r_brightness', 1.0);
    const live = boot.refresh.getFramebuffer().color;
    live.fill(0xff00ff00);
    const out = resolveDisplay(boot);
    expect(out).toBe(live);
    expect(boot.lastVoodooPath).toBe('none');
  });
});
