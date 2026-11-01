// map-viewer free camera tests (headless, no DOM): spawn/reset/copy,
// dt-independence, blur/focus-lost, pointer-lock mouse look, vertical + fast.
import { describe, expect, it } from 'vitest';
import {
  BOUNDS_SPAWN_LIFT,
  DEFAULT_SPAWN_ORIGIN,
  boundsFallback,
  createFreeCamera,
  findSpawn,
  type CameraCanvas,
  type CameraEventBus,
  type EntDict,
  type MoveInput,
} from './camera.js';

type Handler = (e: never) => void;

class FakeBus implements CameraEventBus {
  handlers = new Map<string, Handler[]>();
  pointerLockElement: unknown = null;

  addEventListener(type: string, fn: Handler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(fn);
    this.handlers.set(type, list);
  }

  removeEventListener(type: string, fn: Handler): void {
    this.handlers.set(type, (this.handlers.get(type) ?? []).filter((h) => h !== fn));
  }

  dispatch(type: string, event: unknown): void {
    for (const fn of this.handlers.get(type) ?? []) fn(event as never);
  }
}

class FakeCanvas extends FakeBus implements CameraCanvas {
  lockCalls = 0;

  requestPointerLock(): void {
    this.lockCalls += 1;
  }
}

function keyEvent(code: string): unknown {
  return { code, preventDefault(): void { /* fake */ } };
}

function mouseMove(dx: number, dy: number): unknown {
  return { movementX: dx, movementY: dy };
}

describe('findSpawn', () => {
  it('picks the first untargeted info_player_start, skipping targeted ones', () => {
    const ents: EntDict[] = [
      { classname: 'worldspawn', sky: 'unit1_' },
      { classname: 'info_player_start', targetname: 'base2', origin: '0 0 0', angle: '180' },
      { classname: 'info_player_start', origin: '10 20 30', angle: '90' },
      { classname: 'info_player_start', origin: '99 99 99' },
    ];
    expect(findSpawn(ents)).toEqual({ origin: [10, 20, 30], yaw: 90 });
  });

  it('defaults missing origin/angle fields', () => {
    expect(findSpawn([{ classname: 'info_player_start' }])).toEqual({
      origin: [...DEFAULT_SPAWN_ORIGIN],
      yaw: 0,
    });
  });

  it('returns null with no usable start', () => {
    expect(findSpawn([{ classname: 'worldspawn' }])).toBeNull();
    expect(findSpawn([])).toBeNull();
    expect(
      findSpawn([{ classname: 'info_player_start', targetname: 'x', origin: '1 2 3' }]),
    ).toBeNull();
  });
});

describe('resetToSpawn / resetToBounds', () => {
  it('spawns at the untargeted start with yaw, pitch/roll zeroed', () => {
    const cam = createFreeCamera();
    const used = cam.resetToSpawn([
      { classname: 'info_player_start', targetname: 't', origin: '0 0 0', angle: '45' },
      { classname: 'info_player_start', origin: '10 20 30', angle: '270' },
    ]);
    expect(used).toBe(true);
    expect([...cam.pose.origin]).toEqual([10, 20, 30]);
    expect([...cam.pose.angles]).toEqual([0, 270, 0]);
  });

  it('falls back to bounds center + lift without a spawn', () => {
    const cam = createFreeCamera();
    const used = cam.resetToSpawn([{ classname: 'worldspawn' }], {
      mins: [-100, -100, 0],
      maxs: [100, 100, 64],
    });
    expect(used).toBe(false);
    expect([...cam.pose.origin]).toEqual([0, 0, 32 + BOUNDS_SPAWN_LIFT]);
    expect([...cam.pose.angles]).toEqual([0, 0, 0]);
  });

  it('falls back to the game default without spawn or bounds', () => {
    const cam = createFreeCamera();
    expect(cam.resetToSpawn([])).toBe(false);
    expect([...cam.pose.origin]).toEqual([...DEFAULT_SPAWN_ORIGIN]);
  });

  it('resetToBounds centers with lift', () => {
    const cam = createFreeCamera();
    cam.resetToBounds([-10, -20, -30], [10, 20, 30]);
    expect([...cam.pose.origin]).toEqual([0, 0, BOUNDS_SPAWN_LIFT]);
    expect(boundsFallback({ mins: [-10, -20, -30], maxs: [10, 20, 30] })).toEqual([
      0, 0, BOUNDS_SPAWN_LIFT,
    ]);
  });
});

describe('copyable view', () => {
  it('round-trips origin + angles', () => {
    const cam = createFreeCamera();
    cam.pose.origin[0] = 128.5;
    cam.pose.origin[1] = -320.25;
    cam.pose.origin[2] = 32;
    cam.pose.angles[0] = -10;
    cam.pose.angles[1] = 270;
    const s = cam.toCopyable();
    expect(s).toContain('origin');
    expect(s).toContain('angles');
    const cam2 = createFreeCamera();
    expect(cam2.fromCopyable(s)).toBe(true);
    expect([...cam2.pose.origin]).toEqual([128.5, -320.25, 32]);
    expect([...cam2.pose.angles]).toEqual([-10, 270, 0]);
  });

  it('rejects garbage without touching the pose', () => {
    const cam = createFreeCamera();
    cam.resetToBounds([-8, -8, -8], [8, 8, 8]);
    const before = cam.toCopyable();
    expect(cam.fromCopyable('nonsense')).toBe(false);
    expect(cam.fromCopyable('origin 1 2; angles 0 0 0')).toBe(false);
    expect(cam.fromCopyable('')).toBe(false);
    expect(cam.toCopyable()).toBe(before);
  });
});

describe('update', () => {
  const fwd: MoveInput = { forward: true };

  it('is frame-rate independent (dt seconds)', () => {
    const a = createFreeCamera();
    const b = createFreeCamera();
    a.update(0.5, fwd);
    for (let i = 0; i < 30; i++) b.update(1 / 60, fwd);
    for (let k = 0; k < 3; k++) {
      expect(a.pose.origin[k]).toBeCloseTo(b.pose.origin[k]!, 9);
    }
  });

  it('moves along yaw 0 = +x, strafes right = -y, ignores zero dt', () => {
    const cam = createFreeCamera();
    cam.update(1, { forward: true });
    expect(cam.pose.origin[0]).toBeCloseTo(220, 9);
    cam.update(1, { right: true });
    expect(cam.pose.origin[1]).toBeCloseTo(-220, 9);
    const snap: number[] = [...cam.pose.origin];
    cam.update(0, fwd);
    cam.update(-1, fwd);
    expect([...cam.pose.origin]).toEqual(snap);
  });

  it('flies along pitch and lifts with Space/C, Q/E aliases', () => {
    const cam = createFreeCamera();
    cam.pose.angles[0] = -45; // look up: forward gains +z
    cam.update(1, fwd);
    expect(cam.pose.origin[2]).toBeGreaterThan(0);
    const z = cam.pose.origin[2]!;
    cam.update(1, { up: true });
    expect(cam.pose.origin[2]).toBeCloseTo(z + 220, 9);
    cam.update(1, { down: true });
    expect(cam.pose.origin[2]).toBeCloseTo(z, 9);
    expect(cam.readKeys().up).toBe(false); // no keys attached
  });

  it('applies the Shift fast multiplier', () => {
    const a = createFreeCamera();
    const b = createFreeCamera({ moveSpeed: 100, fastMultiplier: 4 });
    a.update(1, fwd);
    b.update(1, { forward: true, fast: true });
    expect(a.pose.origin[0]).toBeCloseTo(220, 9);
    expect(b.pose.origin[0]).toBeCloseTo(400, 9);
  });

  it('addLook turns right on +dx, down on +dy, clamps pitch', () => {
    const cam = createFreeCamera();
    cam.addLook(10, 0); // mouse right -> yaw decreases from 0 -> wraps
    expect(cam.pose.angles[1]).toBeCloseTo(360 - 10 * 0.2, 9);
    cam.addLook(0, 10); // mouse down -> pitch increases (look down)
    expect(cam.pose.angles[0]).toBeCloseTo(2, 9);
    cam.addLook(0, 100000);
    expect(cam.pose.angles[0]).toBe(89);
    cam.addLook(0, -100000);
    expect(cam.pose.angles[0]).toBe(-89);
  });
});

describe('attach (pointer lock + keys + blur)', () => {
  function wired(): { canvas: FakeCanvas; doc: FakeBus; win: FakeBus } {
    return { canvas: new FakeCanvas(), doc: new FakeBus(), win: new FakeBus() };
  }

  it('click captures pointer lock; lock loss clears keys + notifies', () => {
    const { canvas, doc, win } = wired();
    const seen: boolean[] = [];
    const cam = createFreeCamera({ onLockChange: (l) => seen.push(l) });
    const detach = cam.attach(canvas, doc, win);
    try {
      canvas.dispatch('click', {});
      expect(canvas.lockCalls).toBe(1);
      doc.pointerLockElement = canvas;
      doc.dispatch('pointerlockchange', {});
      expect(cam.isLocked()).toBe(true);
      expect(seen).toEqual([true]);
      win.dispatch('keydown', keyEvent('KeyW'));
      expect(cam.readKeys().forward).toBe(true);
      // Escape: browser clears pointerLockElement, fires the event.
      doc.pointerLockElement = null;
      doc.dispatch('pointerlockchange', {});
      expect(cam.isLocked()).toBe(false);
      expect(cam.readKeys().forward).toBe(false);
      expect(seen).toEqual([true, false]);
    } finally {
      detach();
    }
  });

  it('mouse look applies only while locked', () => {
    const { canvas, doc, win } = wired();
    const cam = createFreeCamera();
    const detach = cam.attach(canvas, doc, win);
    try {
      doc.dispatch('mousemove', mouseMove(50, 0));
      expect(cam.pose.angles[1]).toBe(0);
      doc.pointerLockElement = canvas;
      doc.dispatch('pointerlockchange', {});
      doc.dispatch('mousemove', mouseMove(50, 0));
      expect(cam.pose.angles[1]).toBeCloseTo(360 - 50 * 0.2, 9);
    } finally {
      detach();
    }
  });

  it('blur stops all input (stuck-key guard)', () => {
    const { canvas, doc, win } = wired();
    const cam = createFreeCamera();
    cam.pose.origin[0] = 0;
    const detach = cam.attach(canvas, doc, win);
    try {
      win.dispatch('keydown', keyEvent('KeyW'));
      win.dispatch('keydown', keyEvent('Space'));
      cam.update(1, cam.readKeys());
      expect(cam.pose.origin[0]).toBeGreaterThan(0);
      expect(cam.pose.origin[2]).toBeGreaterThan(0);
      const snap: number[] = [...cam.pose.origin];
      win.dispatch('blur', {});
      expect(cam.readKeys()).toEqual({
        forward: false,
        back: false,
        left: false,
        right: false,
        up: false,
        down: false,
        fast: false,
      });
      cam.update(1, cam.readKeys());
      expect([...cam.pose.origin]).toEqual(snap);
    } finally {
      detach();
    }
  });

  it('detach removes listeners and clears state', () => {
    const { canvas, doc, win } = wired();
    const seen: boolean[] = [];
    const cam = createFreeCamera({ onLockChange: (l) => seen.push(l) });
    const detach = cam.attach(canvas, doc, win);
    doc.pointerLockElement = canvas;
    doc.dispatch('pointerlockchange', {});
    expect(cam.isLocked()).toBe(true);
    win.dispatch('keydown', keyEvent('KeyW'));
    detach();
    expect(cam.isLocked()).toBe(false);
    expect(cam.readKeys().forward).toBe(false);
    // Post-detach events are dead: no re-lock, no key tracking.
    doc.dispatch('pointerlockchange', {});
    win.dispatch('keydown', keyEvent('KeyW'));
    expect(cam.isLocked()).toBe(false);
    expect(cam.readKeys().forward).toBe(false);
    expect(seen).toEqual([true, false]);
  });
});
