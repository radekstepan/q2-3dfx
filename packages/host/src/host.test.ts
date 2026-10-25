import { describe, expect, it } from 'vitest';
import { Host, VIEWMODEL_FORWARD } from './index.js';
import type { HostDriver } from './index.js';
import { calcViewOrigin } from '@q2/client';
import { NullRefresh } from '@q2/renderer-api';
import type { Entity, Framebuffer, FrameStats, Refresh, RefDef, WorldModel } from '@q2/renderer-api';

/** Minimal Refresh that captures the camera origin of each rendered view. */
class CaptureRefresh implements Refresh {
  lastOrigin: [number, number, number] | null = null;
  lastEntities: Entity[] | null = null;
  init(_fb: Framebuffer): void {}
  beginFrame(): void {}
  renderView(view: RefDef, _world: WorldModel, entities: Entity[]): FrameStats {
    this.lastOrigin = [view.origin[0]!, view.origin[1]!, view.origin[2]!];
    this.lastEntities = entities;
    return { spans: 0, pixels: 0, overdraw: 1, ms: 0 };
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

describe('host loop', () => {
  it('boots, ticks 10Hz snapshots, and renders a frame', () => {
    const host = new Host({ refresh: new NullRefresh(), width: 64, height: 48 });
    host.frame(0);
    const stats = host.frame(250);
    expect(stats.pixels).toBe(64 * 48);
    // Two 10Hz snapshots after 250ms -> interpolation has a pair.
    expect(host.predictor.prev).not.toBeNull();
    expect(host.predictor.next).not.toBeNull();
    expect(host.lastCmd).not.toBeNull();
  });

  it('ingested snapshots flow into render entities', () => {
    const host = new Host({ refresh: new NullRefresh(), width: 32, height: 32 });
    host.ingestSnapshot({ serverTime: 1.0, entities: [{ id: 1, origin: [5, 5, 0], velocity: [0, 0, 0] }] });
    host.ingestSnapshot({ serverTime: 1.1, entities: [{ id: 1, origin: [15, 5, 0], velocity: [0, 0, 0] }] });
    const ents = host.predictor.renderEntities(1.1, 1);
    expect(ents[0]!.id).toBe(1);
  });

  it('driver owns spawn, ticks, and authoritative snapshots', () => {
    const stepped: number[] = [];
    const driver: HostDriver = {
      spawn: () => ({ origin: [10, 20, 30] }),
      step: (_cmd, dt) => {
        stepped.push(dt);
      },
      snapshot: (t: number) => ({
        serverTime: t,
        entities: [{ id: 1, origin: [11, 21, 31] as [number, number, number], velocity: [1, 0, 0] as [number, number, number] }],
      }),
    };
    const host = new Host({ refresh: new NullRefresh(), width: 32, height: 32, driver });
    expect(host.playerOrigin).toEqual([10, 20, 30]);
    host.frame(0);
    host.frame(250);
    // 10Hz ticks stepped the driver; snapshot synced the local origin.
    expect(stepped.length).toBeGreaterThan(0);
    expect(stepped.every((dt) => dt === 0.1)).toBe(true);
    expect(host.playerOrigin).toEqual([11, 21, 31]);
    expect(host.playerVelocity).toEqual([1, 0, 0]);
  });

  it('local view origin advances smoothly between 10Hz ticks (no slideshow)', () => {
    const SPEED = 100; // units/sec along +X at constant velocity
    const driver: HostDriver = {
      spawn: () => ({ origin: [0, 0, 0] }),
      step: () => {},
      snapshot: (t: number) => ({
        serverTime: t,
        entities: [
          {
            id: 1,
            origin: [SPEED * t, 0, 0] as [number, number, number],
            velocity: [SPEED, 0, 0] as [number, number, number],
          },
        ],
      }),
    };
    const refresh = new CaptureRefresh();
    const host = new Host({ refresh, width: 64, height: 48, driver });
    // Sub-tick rAF cadence (16ms) over ~480ms wall = 4 server ticks.
    // The first tick interval has only one snapshot (Predictor holds the
    // sample), so measure past warmup, once prev+next both exist.
    const all: number[] = [];
    let now = 0;
    host.frame(now);
    for (let i = 1; i <= 30; i++) {
      now += 16;
      host.frame(now);
      all.push(refresh.lastOrigin![0]);
    }
    const xs = all.slice(-12);
    // 10Hz stepping would repeat the same origin across the ~6 frames of
    // each tick interval and then jump ~10 units. Owned-cmd pmove replay
    // advances every frame by ~SPEED*0.016 = 1.6 units (a touch under:
    // ground friction bites on the replayed stream).
    expect(new Set(xs).size).toBe(xs.length);
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i]! - xs[i - 1]!;
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(SPEED * 0.1);
    }
    const total = xs[xs.length - 1]! - xs[0]!;
    const linear = SPEED * 0.016 * (xs.length - 1);
    expect(total).toBeGreaterThan(linear * 0.85);
    expect(total).toBeLessThanOrEqual(linear + 0.5);
  });

  it('stages the current frame cmd for pmove prediction (no stop oscillation)', () => {
    // Friction-settled server: origin frozen, velocity zeroed. The render
    // origin must sit exactly on the frozen tick (no stale-velocity
    // overshoot, no snap-back) whether or not cmds are staged.
    const driver: HostDriver = {
      spawn: () => ({ origin: [100, 0, 0] }),
      step: () => {},
      snapshot: (t: number) => ({
        serverTime: t,
        entities: [{ id: 1, origin: [100, 0, 0] as [number, number, number], velocity: [0, 0, 0] as [number, number, number] }],
      }),
    };
    const refresh = new CaptureRefresh();
    const host = new Host({ refresh, width: 64, height: 48, driver });
    let now = 0;
    host.frame(now);
    const xs: number[] = [];
    for (let i = 1; i <= 30; i++) {
      now += 16;
      host.frame(now);
      xs.push(refresh.lastOrigin![0]);
    }
    for (const x of xs) expect(x).toBeCloseTo(100, 3);
  });

  it('viewmodel rides the view axis level: no pitch swing, no yaw orbit', () => {
    // Eye-anchored gun with yaw-only orientation: pitching the view must
    // not swing the gun, and yawing must carry it along the view axis
    // (attached at a fixed forward push, never orbiting a world point).
    const driver: HostDriver = {
      spawn: () => ({ origin: [0, 0, 32] }),
      step: () => {},
      snapshot: (t: number) => ({
        serverTime: t,
        entities: [{ id: 1, origin: [0, 0, 32] as [number, number, number], velocity: [0, 0, 0] as [number, number, number] }],
      }),
      viewModel: () => ({ model: 5, skin: 2, frame: 9 }),
    };
    const refresh = new CaptureRefresh();
    const host = new Host({ refresh, width: 64, height: 48, driver });
    host.ingestSnapshot({
      serverTime: 1.0,
      entities: [{ id: 1, origin: [0, 0, 32], velocity: [0, 0, 0] }],
    });
    const eye = calcViewOrigin([0, 0, 32]);
    const gunAt = (pitch: number, yaw: number): Entity => {
      host.lastCmd = { msec: 16, angles: [pitch, yaw, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
      host.renderCurrentView();
      const gun = refresh.lastEntities!.find((e) => e.model === 5);
      expect(gun).toBeDefined();
      return gun!;
    };
    // id AngleVectors forward for [pitch, yaw, 0], pitch positive = down.
    const fwd = (pitch: number, yaw: number): [number, number, number] => {
      const p = (pitch * Math.PI) / 180;
      const y = (yaw * Math.PI) / 180;
      return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
    };
    for (const [pitch, yaw] of [[0, 45], [-30, 45], [-30, 135], [10, 270]] as const) {
      const gun = gunAt(pitch, yaw);
      // Level: no pitch/roll inheritance — the gun does not swing.
      expect(Array.from(gun.angles)).toEqual([0, yaw, 0]);
      expect(gun.skin).toBe(2);
      expect(gun.frame).toBe(9);
      // Attached: exactly VIEWMODEL_FORWARD out along the live view axis.
      const f = fwd(pitch, yaw);
      for (let k = 0; k < 3; k++) {
        expect(gun.origin[k]!).toBeCloseTo(eye[k]! + f[k]! * VIEWMODEL_FORWARD, 5);
      }
    }
    // Pitch 0 vs -30 at fixed yaw: identical orientation, both on-axis —
    // the gun stays attached instead of rotating away with the view.
    const level = gunAt(0, 45);
    const down = gunAt(-30, 45);
    expect(Array.from(level.angles)).toEqual(Array.from(down.angles));
    const dist = (g: Entity): number =>
      Math.hypot(g.origin[0]! - eye[0]!, g.origin[1]! - eye[1]!, g.origin[2]! - eye[2]!);
    expect(dist(level)).toBeCloseTo(VIEWMODEL_FORWARD, 5);
    expect(dist(down)).toBeCloseTo(VIEWMODEL_FORWARD, 5);
  });

  it('propagates per-entity yaw and model/skin, defaults to legacy zeros', () => {
    const driver: HostDriver = {
      spawn: () => ({ origin: [0, 0, 0] }),
      step: () => {},
      snapshot: (t: number) => ({
        serverTime: t,
        entities: [
          { id: 1, origin: [0, 0, 32] as [number, number, number], velocity: [0, 0, 0] as [number, number, number] },
          { id: 2, origin: [100, 0, 0] as [number, number, number], velocity: [0, 0, 0] as [number, number, number] },
          { id: 3, origin: [200, 0, 0] as [number, number, number], velocity: [0, 0, 0] as [number, number, number] },
        ],
      }),
      entityAngles: (id) => (id === 2 ? [10, 90, 0] : null),
      entityModel: (id) => (id === 2 ? { model: 7, skin: 3 } : null),
      entityFrame: (id) => (id === 2 ? 41 : 0),
    };
    const refresh = new CaptureRefresh();
    const host = new Host({ refresh, width: 64, height: 48, driver });
    host.ingestSnapshot({
      serverTime: 1.0,
      entities: [
        { id: 1, origin: [0, 0, 32], velocity: [0, 0, 0] },
        { id: 2, origin: [100, 0, 0], velocity: [0, 0, 0] },
        { id: 3, origin: [200, 0, 0], velocity: [0, 0, 0] },
      ],
    });
    host.lastCmd = { msec: 16, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
    host.renderCurrentView();
    const wired = refresh.lastEntities!.find((e) => e.model === 7);
    expect(wired).toBeDefined();
    expect(Array.from(wired!.angles)).toEqual([10, 90, 0]);
    expect(wired!.skin).toBe(3);
    expect(wired!.frame).toBe(41);
    // Untouched entity keeps the legacy hardcodes (model/skin 0, no yaw).
    const plain = refresh.lastEntities!.find((e) => e.origin[0] === 200);
    expect(plain).toBeDefined();
    expect(plain!.model).toBe(0);
    expect(plain!.skin).toBe(0);
    expect(Array.from(plain!.angles)).toEqual([0, 0, 0]);
    expect(plain!.frame).toBe(0);
  });

  it('renders driver extraEntities with defaults, stays green without the hook', () => {
    const snap = (t: number) => ({
      serverTime: t,
      entities: [{ id: 1, origin: [0, 0, 32] as [number, number, number], velocity: [0, 0, 0] as [number, number, number] }],
    });
    const withExtras: HostDriver = {
      spawn: () => ({ origin: [0, 0, 0] }),
      step: () => {},
      snapshot: snap,
      extraEntities: () => [
        { origin: [1, 2, 3] },
        { origin: [4, 5, 6], angles: [0, 180, 0], model: 9, skin: 4, frame: 2 },
      ],
    };
    const refresh = new CaptureRefresh();
    const host = new Host({ refresh, width: 64, height: 48, driver: withExtras });
    host.ingestSnapshot({ serverTime: 1.0, entities: [{ id: 1, origin: [0, 0, 32], velocity: [0, 0, 0] }] });
    host.lastCmd = { msec: 16, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
    host.renderCurrentView();
    expect(refresh.lastEntities!.length).toBe(2);
    const bolt = refresh.lastEntities!.find((e) => e.origin[0] === 1);
    expect(bolt).toBeDefined();
    expect(bolt!.model).toBe(0);
    expect(bolt!.skin).toBe(0);
    expect(bolt!.frame).toBe(0);
    expect(Array.from(bolt!.angles)).toEqual([0, 0, 0]);
    const barrel = refresh.lastEntities!.find((e) => e.origin[0] === 4);
    expect(barrel).toBeDefined();
    expect(Array.from(barrel!.angles)).toEqual([0, 180, 0]);
    expect(barrel!.model).toBe(9);
    expect(barrel!.skin).toBe(4);
    expect(barrel!.frame).toBe(2);
    // No hook: local body filtered, nothing extra — renders as before.
    const plain: HostDriver = {
      spawn: () => ({ origin: [0, 0, 0] }),
      step: () => {},
      snapshot: snap,
    };
    const refresh2 = new CaptureRefresh();
    const host2 = new Host({ refresh: refresh2, width: 64, height: 48, driver: plain });
    host2.ingestSnapshot({ serverTime: 1.0, entities: [{ id: 1, origin: [0, 0, 32], velocity: [0, 0, 0] }] });
    host2.lastCmd = { msec: 16, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
    const stats = host2.renderCurrentView();
    expect(refresh2.lastEntities).toEqual([]);
    expect(stats.spans).toBe(0);
  });
});
