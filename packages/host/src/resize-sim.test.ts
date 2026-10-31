import { describe, expect, it } from 'vitest';
import { ComError } from '@q2/config';
import { NullRefresh } from '@q2/renderer-api';
import type { Framebuffer, FrameStats, Refresh, RefDef, WorldModel, Entity } from '@q2/renderer-api';
import { Host, isValidDisplaySize, parseDisplaySize } from './index.js';
import type { HostDriver, HostSimSnapshot } from './index.js';

/** Refresh that paints the fb with position-dependent pixels (overlap checks). */
class PaintRefresh implements Refresh {
  fb: Framebuffer | null = null;
  initCount = 0;
  init(fb: Framebuffer): void {
    this.fb = fb;
    this.initCount++;
  }
  beginFrame(): void {}
  renderView(view: RefDef, _world: WorldModel, entities: Entity[]): FrameStats {
    const fb = this.fb!;
    for (let y = 0; y < fb.height; y++) {
      for (let x = 0; x < fb.width; x++) {
        fb.color[y * fb.width + x] = (0xff000000 | (y * 257 + x)) >>> 0;
        if (fb.index) fb.index[y * fb.width + x] = (x + y) & 255;
        fb.depth[y * fb.width + x] = x * 1000 + y;
      }
    }
    void view;
    void entities;
    return { spans: 0, pixels: fb.width * fb.height, overdraw: 1, ms: 0 };
  }
  endFrame(): void {}
  setPalette(_p: Uint8Array): void {}
  registerModel(_m: never): number {
    return 0;
  }
  registerSkin(_name: string): number {
    return 0;
  }
}

/**
 * Driver with a moving "monster" (id 2) plus the local player (id 1), so a
 * resize must preserve enemies as well as the local origin. The enemy
 * position is pure serverTime so any clock disturbance shows up in pixels.
 */
function movingDriver(): HostDriver & { steps: number } {
  const d = {
    steps: 0,
    spawn: () => ({ origin: [10, 20, 30] as [number, number, number] }),
    step: (_cmd: unknown, _dt: number) => {
      d.steps++;
    },
    snapshot: (t: number) => ({
      serverTime: t,
      entities: [
        { id: 1, origin: [10 + t, 20, 30] as [number, number, number], velocity: [1, 0, 0] as [number, number, number] },
        { id: 2, origin: [500 - 10 * t, 100, 0] as [number, number, number], velocity: [-10, 0, 0] as [number, number, number] },
      ],
    }),
  };
  return d as unknown as HostDriver & { steps: number };
}

function simFingerprint(h: HostSimSnapshot): string {
  return JSON.stringify({
    ...h,
    // Floats must survive exactly (no re-quantization across resize).
    serverTime: h.serverTime.toPrecision(17),
    serverAcc: h.serverAcc.toPrecision(17),
  });
}

describe('display-size helpers', () => {
  it('parses the menu vid_resolution shape, rejects garbage', () => {
    expect(parseDisplaySize('640x480')).toEqual({ width: 640, height: 480 });
    expect(parseDisplaySize(' 1024 x 768 ')).toEqual({ width: 1024, height: 768 });
    for (const bad of ['bogus', '640', '640x', 'x480', '0x480', '640x0', '-1x480', '64.5x48', '', '999999999x999999999']) {
      expect(parseDisplaySize(bad)).toBeNull();
    }
    expect(isValidDisplaySize(320, 240)).toBe(true);
    expect(isValidDisplaySize(0, 240)).toBe(false);
    expect(isValidDisplaySize(320.5, 240)).toBe(false);
  });

  it('constructor reserves the selected size immediately, rejects invalid', () => {
    const host = new Host({ refresh: new NullRefresh(), width: 1024, height: 768 });
    // Loading surface: full-size BEFORE any frame (no small box, no jump).
    expect(host.fb.width).toBe(1024);
    expect(host.fb.height).toBe(768);
    expect(host.fb.color.length).toBe(1024 * 768);
    expect(() => new Host({ refresh: new NullRefresh(), width: 0, height: 48 })).toThrow(ComError);
    expect(() => new Host({ refresh: new NullRefresh(), width: 64.5, height: 48 })).toThrow(ComError);
  });
});

describe('sim-preserving resize', () => {
  it('keeps map/position/enemies/time/audio across vid_resolution sizes', () => {
    const refresh = new PaintRefresh();
    const driver = movingDriver();
    const world = { name: 'maps/base1', data: null };
    const host = new Host({ refresh, width: 320, height: 240, driver, world });
    // Start a looping sound: audio must survive the switch, not restart.
    host.mixer.startSound({
      origin: [100, 0, 0],
      fixedOrigin: false,
      entnum: 1,
      attenuation: 1,
      masterVol: 1,
      loop: true,
      name: 'test/loop.wav',
    });
    host.mixer.setListener([10, 20, 30], [0, -1, 0]);
    host.input.angles = [5, 90, 0];
    let now = 0;
    host.frame(now);
    for (let i = 0; i < 20; i++) {
      now += 50;
      host.frame(now);
    }
    let before = simFingerprint(host.captureSimState());
    let mixBefore = JSON.stringify(host.mixer.mix());
    const worldBefore = host.world;
    const driverBefore = host.driver;
    const refreshBefore = host.refresh;

    for (const [w, h] of [[640, 480], [800, 600], [1024, 768], [320, 240]] as const) {
      host.resize(w, h);
      expect(host.fb.width).toBe(w);
      expect(host.fb.height).toBe(h);
      // The realloc itself touches no sim state ...
      expect(simFingerprint(host.captureSimState())).toBe(before);
      expect(host.world).toBe(worldBefore);
      expect(host.driver).toBe(driverBefore);
      expect(host.refresh).toBe(refreshBefore);
      expect(JSON.stringify(host.mixer.mix())).toBe(mixBefore);
      // The enemy still interpolates at the preserved clock.
      const ents = host.predictor.renderEntities(host.serverTime, host.localPlayerId);
      expect(ents.find((e) => e.id === 2)).toBeDefined();
      // ... and the game keeps ticking from the preserved clock afterwards.
      now += 50;
      host.frame(now);
      expect(host.driver).toBe(driverBefore);
      before = simFingerprint(host.captureSimState());
      mixBefore = JSON.stringify(host.mixer.mix());
    }
    expect(host.resizeCount).toBe(4);
    expect(refresh.initCount).toBe(5); // 1 construction + 4 resizes
  });

  it('carries overlapping pixels across (no black flash), zeroes new area', () => {
    const refresh = new PaintRefresh();
    const host = new Host({ refresh, width: 64, height: 48, driver: movingDriver() });
    host.renderCurrentView();
    const old = host.fb;
    host.resize(128, 96);
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 64; x++) {
        expect(host.fb.color[y * 128 + x]).toBe(old.color[y * 64 + x]);
        expect(host.fb.depth[y * 128 + x]).toBe(old.depth[y * 64 + x]);
        expect(host.fb.index![y * 128 + x]).toBe(old.index![y * 64 + x]);
      }
    }
    // Newly exposed pixels are zero until the next frame paints them.
    expect(host.fb.color[48 * 128 + 64]).toBe(0);
    // Shrinking keeps the top-left overlap too.
    host.renderCurrentView();
    const big = host.fb;
    host.resize(32, 24);
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 32; x++) {
        expect(host.fb.color[y * 32 + x]).toBe(big.color[y * 128 + x]);
      }
    }
  });

  it('rejects invalid sizes without touching fb or sim', () => {
    const host = new Host({ refresh: new NullRefresh(), width: 64, height: 48, driver: movingDriver() });
    host.frame(0);
    host.frame(120);
    const before = simFingerprint(host.captureSimState());
    const fbBefore = host.fb;
    for (const [w, h] of [[0, 48], [-64, 48], [64.5, 48], [64, 0], [1e9, 48]] as const) {
      expect(() => host.resize(w, h)).toThrow(ComError);
    }
    expect(host.fb).toBe(fbBefore);
    expect(simFingerprint(host.captureSimState())).toBe(before);
    expect(host.resizeCount).toBe(0);
  });

  it('same-size resize is a no-op (no re-init, no flash)', () => {
    const refresh = new PaintRefresh();
    const host = new Host({ refresh, width: 64, height: 48 });
    const inits = refresh.initCount;
    host.renderCurrentView();
    const painted = host.fb.color.slice();
    host.resize(64, 48);
    expect(refresh.initCount).toBe(inits);
    expect(host.resizeCount).toBe(0);
    expect(host.fb.color).toEqual(painted);
  });
});

describe('sim snapshot/restore coordination', () => {
  it('round-trips clock/origin/cmd/input/listener/interp pair', () => {
    const host = new Host({ refresh: new NullRefresh(), width: 64, height: 48, driver: movingDriver() });
    host.input.angles = [1, 2, 3];
    host.frame(0);
    host.frame(120);
    host.frame(240);
    const snap = host.captureSimState();
    expect(snap.prevSnapshot).not.toBeNull();
    expect(snap.nextSnapshot).not.toBeNull();
    // Mutate everything, then restore and compare fingerprints.
    host.serverTime += 999;
    host.playerOrigin = [7, 7, 7];
    host.input.angles = [9, 9, 9];
    host.ingestSnapshot({ serverTime: 5000, entities: [{ id: 1, origin: [0, 0, 0], velocity: [0, 0, 0] }] });
    host.restoreSimState(structuredClone(snap));
    expect(simFingerprint(host.captureSimState())).toBe(simFingerprint(snap));
    // Snapshots are deep copies: mutating the capture does not leak live.
    snap.playerOrigin[0] = -1;
    expect(host.playerOrigin[0]).not.toBe(-1);
  });

  it('rejects malformed snapshots without touching live state', () => {
    const host = new Host({ refresh: new NullRefresh(), width: 64, height: 48, driver: movingDriver() });
    host.frame(0);
    const before = simFingerprint(host.captureSimState());
    const bad = { ...host.captureSimState(), serverTime: Number.NaN };
    expect(() => host.restoreSimState(bad)).toThrow(ComError);
    expect(() => host.restoreSimState(null as unknown as HostSimSnapshot)).toThrow(ComError);
    expect(simFingerprint(host.captureSimState())).toBe(before);
  });
});

describe('disposal/listener accounting', () => {
  it('dispose is idempotent, silences the mixer, guards use-after-dispose', () => {
    const host = new Host({ refresh: new NullRefresh(), width: 64, height: 48, driver: movingDriver() });
    host.mixer.startSound({
      origin: [0, 0, 0],
      fixedOrigin: true,
      entnum: 0,
      attenuation: 0,
      masterVol: 1,
      loop: false,
      name: 'x.wav',
    });
    expect(host.mixer.channelCount).toBe(1);
    host.dispose();
    host.dispose(); // idempotent: no throw, no double work
    expect(host.disposed).toBe(true);
    expect(host.mixer.channelCount).toBe(0);
    expect(() => host.frame(0)).toThrow(ComError);
    expect(() => host.renderCurrentView()).toThrow(ComError);
    expect(() => host.resize(320, 240)).toThrow(ComError);
    expect(() => host.ingestSnapshot({ serverTime: 0, entities: [] })).toThrow(ComError);
    expect(() => host.captureSimState()).toThrow(ComError);
  });

  it('frame() stays synchronous and installs no loops/listeners', () => {
    // The Host is caller-driven: no rAF/timers/listeners of its own. Any
    // global registration would show up as new own-properties here.
    const globalsBefore = new Set(Object.getOwnPropertyNames(globalThis));
    const host = new Host({ refresh: new NullRefresh(), width: 64, height: 48, driver: movingDriver() });
    const out = host.frame(0);
    expect(out && typeof out === 'object' && !(out instanceof Promise)).toBe(true);
    host.resize(96, 72);
    host.renderCurrentView();
    host.captureSimState();
    host.dispose();
    const leaked = Object.getOwnPropertyNames(globalThis).filter((k) => !globalsBefore.has(k));
    expect(leaked).toEqual([]);
    // No subscription surface to double-wire: the shell owns DomBindings.
    const surface = host as unknown as Record<string, unknown>;
    for (const name of ['addEventListener', 'removeEventListener', 'subscribe', 'on', 'attach', 'requestAnimationFrame', 'setInterval', 'setTimeout']) {
      expect(surface[name]).toBeUndefined();
    }
  });
});
