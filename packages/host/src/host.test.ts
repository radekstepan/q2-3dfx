import { describe, expect, it } from 'vitest';
import { Host, VIEWMODEL_FORWARD } from './index.js';
import type { HostDriver } from './index.js';
import { calcViewOrigin } from '@q2/client';
import { NullRefresh } from '@q2/renderer-api';
import type { Entity, Framebuffer, FrameStats, Refresh, RefDef, WorldModel } from '@q2/renderer-api';

/** Minimal Refresh that captures the camera origin of each rendered view. */
class CaptureRefresh implements Refresh {
  lastOrigin: [number, number, number] | null = null;
  lastAngles: [number, number, number] | null = null;
  lastEntities: Entity[] | null = null;
  init(_fb: Framebuffer): void {}
  beginFrame(): void {}
  renderView(view: RefDef, _world: WorldModel, entities: Entity[]): FrameStats {
    this.lastOrigin = [view.origin[0]!, view.origin[1]!, view.origin[2]!];
    this.lastAngles = [view.angles[0]!, view.angles[1]!, view.angles[2]!];
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

    // Residual velocity below PM_Friction's speed<1 zeroing threshold with
    // released inputs: the zero-velocity snap in CL_PredictPmove holds the
    // snapshot origin exactly instead of sweeping forward on stale residue.
    const driftDriver: HostDriver = {
      spawn: () => ({ origin: [100, 0, 0] }),
      step: () => {},
      snapshot: (t: number) => ({
        serverTime: t,
        entities: [{ id: 1, origin: [100, 0, 0] as [number, number, number], velocity: [0.5, 0, 0] as [number, number, number] }],
      }),
    };
    const driftRefresh = new CaptureRefresh();
    const driftHost = new Host({ refresh: driftRefresh, width: 64, height: 48, driver: driftDriver });
    let dnow = 0;
    driftHost.frame(dnow);
    const dxs: number[] = [];
    for (let i = 1; i <= 30; i++) {
      dnow += 16;
      driftHost.frame(dnow);
      dxs.push(driftRefresh.lastOrigin![0]);
    }
    for (const x of dxs) expect(x).toBeCloseTo(100, 3);
  });

  it('viewmodel sits at the eye with full view angles (CL_AddViewWeapon)', () => {
    // Eye-anchored gun with full view angles: the origin is the view
    // origin at every pitch/yaw/roll (no forward push, no orbit), the
    // angles are the live view angles, and the entity carries the
    // RF_DEPTHHACK bias flag. Breech-behind-eye visibility is the alias
    // backend's job (near-plane Sutherland clip, pinned in sw-renderer).
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
    const gunAt = (pitch: number, yaw: number, roll: number): Entity => {
      host.lastCmd = { msec: 16, angles: [pitch, yaw, roll], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
      host.renderCurrentView();
      const gun = refresh.lastEntities!.find((e) => e.model === 5);
      expect(gun).toBeDefined();
      return gun!;
    };
    for (const [pitch, yaw, roll] of [[0, 45, 0], [-30, 45, 0], [-30, 135, 0], [10, 270, 5]] as const) {
      const gun = gunAt(pitch, yaw, roll);
      // Full view angles inherited — the gun pitches/rolls with the view.
      expect(Array.from(gun.angles)).toEqual([pitch, yaw, roll]);
      expect(gun.skin).toBe(2);
      expect(gun.frame).toBe(9);
      expect(gun.depthHack).toBe(true);
      // Eye anchor: exactly at the view origin, whatever the angles.
      for (let k = 0; k < 3; k++) {
        expect(gun.origin[k]!).toBeCloseTo(eye[k]!, 5);
      }
    }
    // No push: distance from the eye is VIEWMODEL_FORWARD (0).
    const gun = gunAt(-30, 45, 0);
    const dist = Math.hypot(
      gun.origin[0]! - eye[0]!, gun.origin[1]! - eye[1]!, gun.origin[2]! - eye[2]!,
    );
    expect(dist).toBeCloseTo(VIEWMODEL_FORWARD, 5);
  });

  it('viewKick offsets the camera for one tick, gun rides the kicked view + sway', () => {
    // RF/gunoffset-lite: viewKick adds a one-tick camera offset (p_weapon.c
    // kick via p_view.c SV_CalcGunOffset) to the RefDef angles/origin; the
    // driver clears it next tick. gunAnglesDelta adds sway/turn-lag to the
    // eye-anchored viewmodel entity angles. Absent hooks render as before.
    let kicks = 0;
    const driver: HostDriver = {
      spawn: () => ({ origin: [0, 0, 0] }),
      step: () => {},
      snapshot: (t: number) => ({
        serverTime: t,
        entities: [{ id: 1, origin: [0, 0, 0] as [number, number, number], velocity: [0, 0, 0] as [number, number, number] }],
      }),
      viewModel: () => ({ model: 5, skin: 2, frame: 9 }),
      viewKick: () => {
        kicks += 1;
        return kicks === 1 ? { angles: [-2, 1, 0], origin: [0, 0, 1] } : null;
      },
      gunAnglesDelta: () => [1, 2, 3],
    };
    const refresh = new CaptureRefresh();
    const host = new Host({ refresh, width: 64, height: 48, driver });
    host.lastCmd = { msec: 16, angles: [10, 20, 30], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
    const eye = calcViewOrigin([0, 0, 0]);

    host.renderCurrentView();
    // RefDef = base view + kick.
    expect(refresh.lastAngles!).toEqual([8, 21, 30]);
    expect(refresh.lastOrigin![0]).toBeCloseTo(eye[0]!, 5);
    expect(refresh.lastOrigin![1]).toBeCloseTo(eye[1]!, 5);
    expect(refresh.lastOrigin![2]).toBeCloseTo(eye[2]! + 1, 5);
    // Gun rides the kicked view: eye anchor + kicked origin, full kicked
    // view angles + sway delta, depthHack set.
    const gun = refresh.lastEntities!.find((e) => e.model === 5);
    expect(gun).toBeDefined();
    expect(Array.from(gun!.angles)).toEqual([9, 23, 33]);
    expect(gun!.depthHack).toBe(true);
    for (let k = 0; k < 3; k++) {
      expect(gun!.origin[k]!).toBeCloseTo(refresh.lastOrigin![k]!, 5);
    }

    // Driver cleared the kick: next frame is the unkicked base view, but the
    // sway delta still applies to the gun.
    host.renderCurrentView();
    expect(refresh.lastAngles!).toEqual([10, 20, 30]);
    expect(refresh.lastOrigin![2]).toBeCloseTo(eye[2]!, 5);
    const gun2 = refresh.lastEntities!.find((e) => e.model === 5);
    expect(Array.from(gun2!.angles)).toEqual([11, 22, 33]);
    expect(gun2!.depthHack).toBe(true);
  });

  it('viewmodel frame morph rides the gun entity (RF_FRAMELERP pair + frac weight)', () => {
    // id CL_AddViewWeapon: gun.oldframe = ops->gunframe with the sub-tick
    // frac as the new-frame weight, so the 10Hz poses glide at display
    // rate. Drivers without oldframe render unlerped, exactly as before.
    const withMorph: HostDriver = {
      spawn: () => ({ origin: [0, 0, 0] }),
      step: () => {},
      snapshot: (t: number) => ({
        serverTime: t,
        entities: [{ id: 1, origin: [0, 0, 0] as [number, number, number], velocity: [0, 0, 0] as [number, number, number] }],
      }),
      viewModel: () => ({ model: 5, skin: 2, frame: 10, oldframe: 9 }),
    };
    const refresh = new CaptureRefresh();
    const host = new Host({ refresh, width: 64, height: 48, driver: withMorph });
    host.lastCmd = { msec: 16, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
    host.renderCurrentView();
    const gun = refresh.lastEntities!.find((e) => e.model === 5);
    expect(gun).toBeDefined();
    expect(gun!.frame).toBe(10);
    expect(gun!.oldframe).toBe(9);
    expect(gun!.backlerp).toBeGreaterThanOrEqual(0);
    expect(gun!.backlerp).toBeLessThanOrEqual(1);

    const plain: HostDriver = {
      spawn: () => ({ origin: [0, 0, 0] }),
      step: () => {},
      snapshot: (t: number) => ({
        serverTime: t,
        entities: [{ id: 1, origin: [0, 0, 0] as [number, number, number], velocity: [0, 0, 0] as [number, number, number] }],
      }),
      viewModel: () => ({ model: 5, skin: 2, frame: 10 }),
    };
    const refresh2 = new CaptureRefresh();
    const host2 = new Host({ refresh: refresh2, width: 64, height: 48, driver: plain });
    host2.lastCmd = { msec: 16, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
    host2.renderCurrentView();
    const gun2 = refresh2.lastEntities!.find((e) => e.model === 5);
    expect(gun2).toBeDefined();
    expect(gun2!.frame).toBe(10);
    expect(gun2!.oldframe).toBeUndefined();
    expect(gun2!.backlerp).toBeUndefined();
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

describe('extraEntities RF_FRAMELERP/alpha forwarding', () => {
  it('forwards oldframe/backlerp/alpha when set, omits when unset', () => {
    const snap = (t: number) => ({
      serverTime: t,
      entities: [{ id: 1, origin: [0, 0, 32] as [number, number, number], velocity: [0, 0, 0] as [number, number, number] }],
    });
    const withExtras: HostDriver = {
      spawn: () => ({ origin: [0, 0, 0] }),
      step: () => {},
      snapshot: snap,
      extraEntities: () => [
        { origin: [1, 2, 3], model: 5, skin: 6, frame: 7, oldframe: 6, backlerp: 0.5, alpha: 0.25 },
        { origin: [4, 5, 6] },
      ],
    };
    const refresh = new CaptureRefresh();
    const host = new Host({ refresh, width: 64, height: 48, driver: withExtras });
    host.ingestSnapshot({ serverTime: 1.0, entities: [{ id: 1, origin: [0, 0, 32], velocity: [0, 0, 0] }] });
    host.lastCmd = { msec: 16, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
    host.renderCurrentView();
    const boom = refresh.lastEntities!.find((e) => e.origin[0] === 1)!;
    expect(boom.oldframe).toBe(6);
    expect(boom.backlerp).toBe(0.5);
    expect(boom.alpha).toBe(0.25);
    // Legacy extras stay unlerped + opaque (fields omitted, not zeroed).
    const plain = refresh.lastEntities!.find((e) => e.origin[0] === 4)!;
    expect(plain.oldframe).toBeUndefined();
    expect(plain.backlerp).toBeUndefined();
    expect(plain.alpha).toBeUndefined();
    expect(plain.glow).toBeUndefined();
  });

  it('forwards glow when set (RF_GLOW pickup pulse)', () => {
    const snap = (t: number) => ({
      serverTime: t,
      entities: [{ id: 1, origin: [0, 0, 32] as [number, number, number], velocity: [0, 0, 0] as [number, number, number] }],
    });
    const withGlow: HostDriver = {
      spawn: () => ({ origin: [0, 0, 0] }),
      step: () => {},
      snapshot: snap,
      extraEntities: () => [
        { origin: [9, 9, 9], model: 3, skin: 4, frame: 0, glow: true },
      ],
    };
    const refresh = new CaptureRefresh();
    const host = new Host({ refresh, width: 64, height: 48, driver: withGlow });
    host.ingestSnapshot({ serverTime: 1.0, entities: [{ id: 1, origin: [0, 0, 32], velocity: [0, 0, 0] }] });
    host.lastCmd = { msec: 16, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
    host.renderCurrentView();
    const item = refresh.lastEntities!.find((e) => e.origin[0] === 9)!;
    expect(item.glow).toBe(true);
  });
});
