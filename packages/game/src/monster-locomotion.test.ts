// monsterLocomotion (exit-fix follow-up): pure headless locomotion contract.
import { describe, expect, it } from 'vitest';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  MONSTER_FALL_PROBE,
  monsterLocomotion,
  spawnMonster,
} from './monsters.js';

type Trace = (start: Vec3, end: Vec3) => { fraction: number; endpos: Vec3 };

function hit(fraction: number, endpos: Vec3): { fraction: number; endpos: Vec3 } {
  return { fraction, endpos };
}

/** Open space: never blocks. */
const openTrace: Trace = (_s, e) => hit(1, v3(e[0], e[1], e[2]));

/** Flat floor at z=0 for any segment (point-in-origin-space semantics). */
function floorTrace(floorZ = 0): Trace {
  return (s, e) => {
    if (e[2]! >= floorZ) return hit(1, v3(e[0], e[1], e[2]));
    const f = (s[2]! - floorZ) / (s[2]! - e[2]!);
    return hit(Math.max(0, Math.min(1, f)), v3(
      s[0]! + (e[0]! - s[0]!) * f,
      s[1]! + (e[1]! - s[1]!) * f,
      floorZ,
    ));
  };
}

/** Vertical wall at x=wallX (blocks +x travel past it). */
function wallTrace(wallX: number, inner: Trace = openTrace): Trace {
  return (s, e) => {
    if (s[0]! <= wallX && e[0]! > wallX) {
      const f = (wallX - s[0]!) / (e[0]! - s[0]!);
      return hit(Math.max(0, f), v3(wallX, s[1]! + (e[1]! - s[1]!) * f, s[2]!));
    }
    return inner(s, e);
  };
}

describe('monsterLocomotion (pure, headless)', () => {
  it('advances toward the player by the current frame dist (run frame0 = 10)', () => {
    const ms = spawnMonster('soldier');
    ms.move = 'run'; // dist 10 on frame 0 (id m_soldier.c)
    ms.frame = 0;
    const origin = v3(0, 0, 0);
    monsterLocomotion(ms, origin, v3(100, 0, 0), floorTrace());
    expect(origin[0]).toBeCloseTo(10, 6);
    expect(origin[1]).toBeCloseTo(0, 6);
    expect(origin[2]).toBeCloseTo(0, 6); // gravity holds the floor
    expect(ms.frame).toBe(0); // locomotion never advances the frame
  });

  it('yaws diagonally: movement direction faces the player', () => {
    const ms = spawnMonster('soldier');
    ms.move = 'run';
    ms.frame = 0;
    const origin = v3(0, 0, 0);
    monsterLocomotion(ms, origin, v3(0, 100, 0), floorTrace());
    expect(origin[0]).toBeCloseTo(0, 6);
    expect(origin[1]).toBeCloseTo(10, 6);
  });

  it('stand frames (dist 0) do not translate', () => {
    const ms = spawnMonster('soldier'); // stand1, dist 0
    const origin = v3(10, 20, 0);
    monsterLocomotion(ms, origin, v3(100, 100, 0), floorTrace());
    expect([...origin]).toEqual([10, 20, 0]);
  });

  it('corpses never move', () => {
    const ms = spawnMonster('soldier');
    ms.dead = true;
    ms.move = 'run';
    const origin = v3(0, 0, 50);
    monsterLocomotion(ms, origin, v3(100, 0, 0), openTrace);
    expect([...origin]).toEqual([0, 0, 50]);
  });

  it('walls clamp the step via trace (no pass-through)', () => {
    const ms = spawnMonster('soldier');
    ms.move = 'run';
    ms.frame = 0;
    const origin = v3(0, 0, 0);
    monsterLocomotion(ms, origin, v3(100, 0, 0), wallTrace(5, floorTrace()));
    expect(origin[0]).toBeCloseTo(5, 6); // clamped at the wall face
    expect(origin[0]).toBeLessThanOrEqual(5);
  });

  it('gravity drops bodies to the floor and holds them there', () => {
    const ms = spawnMonster('soldier'); // stand: no horizontal drift
    const origin = v3(0, 0, 50);
    monsterLocomotion(ms, origin, v3(100, 0, 0), floorTrace());
    // one bounded fall probe per tick (falls, never hovers)
    expect(origin[2]).toBeCloseTo(50 - MONSTER_FALL_PROBE, 6);
    monsterLocomotion(ms, origin, v3(100, 0, 0), floorTrace());
    expect(origin[2]).toBeCloseTo(0, 6);
    // resting contact is stable across ticks (no sink, no jitter)
    monsterLocomotion(ms, origin, v3(100, 0, 0), floorTrace());
    expect(origin[2]).toBeCloseTo(0, 6);
  });

  it('step-downs within the probe stick instead of hovering', () => {
    const ms = spawnMonster('soldier');
    ms.move = 'run';
    // frame 3 dists 16 clears the x=10 ledge edge (frame0 lands exactly on it)
    ms.frame = 3;
    const origin = v3(0, 0, 0);
    // ledge: floor drops 10 past x=10 (within MONSTER_STEP_HEIGHT reach)
    const ledge: Trace = (s, e) => {
      const floor = e[0]! > 10 || s[0]! > 10 ? -10 : 0;
      return floorTrace(floor)(s, e);
    };
    monsterLocomotion(ms, origin, v3(100, 0, 0), ledge);
    expect(origin[0]).toBeCloseTo(16, 6);
    // horizontal step stayed level; gravity snapped down to the lower floor
    expect(origin[2]).toBeCloseTo(-10, 6);
  });
});
