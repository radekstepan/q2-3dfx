import { describe, expect, it } from 'vitest';
import { Host } from './index.js';
import type { HostDriver } from './index.js';
import { NullRefresh } from '@q2/renderer-api';
import type { Entity, Framebuffer, FrameStats, Refresh, RefDef, WorldModel } from '@q2/renderer-api';

/** Minimal Refresh that captures the camera origin of each rendered view. */
class CaptureRefresh implements Refresh {
  lastOrigin: [number, number, number] | null = null;
  init(_fb: Framebuffer): void {}
  beginFrame(): void {}
  renderView(view: RefDef, _world: WorldModel, _entities: Entity[]): FrameStats {
    this.lastOrigin = [view.origin[0]!, view.origin[1]!, view.origin[2]!];
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
    // each tick interval and then jump ~10 units. Smooth interpolation
    // advances every frame by ~SPEED*0.016 = 1.6 units.
    expect(new Set(xs).size).toBe(xs.length);
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i]! - xs[i - 1]!;
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(SPEED * 0.1);
    }
    expect(xs[xs.length - 1]! - xs[0]!).toBeCloseTo(SPEED * 0.016 * (xs.length - 1), 0);
  });
});
