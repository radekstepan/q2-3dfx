// monsterLocomotion (exit-fix follow-up): pure headless locomotion contract.
import { describe, expect, it } from 'vitest';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  MONSTER_FALL_PROBE,
  changeYaw,
  monsterLocomotion,
  monsterMoveOf,
  monsterPain,
  monsterThink,
  monsterYawTo,
  spawnMonster,
  yawDiff,
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

  it('frozen hold (C AI_HOLD_FRAME): yaws but never steps, gravity still holds', () => {
    // g_monster.c M_MoveFrame runs the aifunc with dist 0 while HOLD is set:
    // ai_charge still turns (M_ChangeYaw) but M_walkmove never steps, so a
    // sustained burst fires in place instead of drifting one frame-dist per
    // 10Hz tick.
    const ms = spawnMonster('infantry');
    ms.move = 'attack1';
    ms.frame = 10; // fire frame (dist 1)
    ms.yaw = 90;
    const origin = v3(0, 0, 0);
    monsterLocomotion(ms, origin, v3(100, 0, 0), floorTrace(), undefined, { frozen: true });
    expect(origin[0]).toBeCloseTo(0, 6);
    expect(origin[1]).toBeCloseTo(0, 6);
    expect(origin[2]).toBeCloseTo(0, 6);
    // still turned toward the goal (90 -> ~70 at yaw_speed 20)
    expect(ms.yaw).toBeCloseTo(70, 1);
    // control: unfrozen, the same frame steps its dist
    const ms2 = spawnMonster('infantry');
    ms2.move = 'attack1';
    ms2.frame = 10;
    ms2.yaw = 90;
    const origin2 = v3(0, 0, 0);
    monsterLocomotion(ms2, origin2, v3(100, 0, 0), floorTrace());
    expect(origin2[0]).toBeCloseTo(1, 6);
  });
});

describe('monsterLocomotion SV_NewChaseDir-lite sweep (opt-in)', () => {
  // Blocks only the due-east leg (fraction 0.5), clears everything else.
  const eastBlocked: Trace = (s, e) => {
    const dx = e[0]! - s[0]!;
    const dy = e[1]! - s[1]!;
    if (dx > 0 && Math.abs(dy) < 1e-9) {
      const f = 0.5;
      return hit(f, v3(s[0]! + dx * f, s[1]!, s[2]!));
    }
    return hit(1, v3(e[0], e[1], e[2]));
  };

  it('default off: keeps the press-and-clamp contract (no slide)', () => {
    const ms = spawnMonster('soldier');
    ms.move = 'run'; // frame 0 dist 10
    ms.frame = 0;
    const origin = v3(0, 0, 0);
    const res = monsterLocomotion(ms, origin, v3(100, 0, 0), wallTrace(5, floorTrace()));
    expect(origin[0]).toBeCloseTo(5, 6); // clamped at the wall face
    expect(res).toEqual({ slide: 0, blocked: false });
  });

  it('opt-in: a blocked direct leg takes the first clear side heading', () => {
    const ms = spawnMonster('soldier');
    ms.move = 'run';
    ms.frame = 0;
    const origin = v3(0, 0, 0);
    const res = monsterLocomotion(ms, origin, v3(100, 0, 0), eastBlocked, undefined, {
      newChaseDir: true,
    });
    // +45 off due east clears: 10u at 45 deg.
    expect(origin[0]).toBeCloseTo(10 * Math.cos(Math.PI / 4), 6);
    expect(origin[1]).toBeCloseTo(10 * Math.sin(Math.PI / 4), 6);
    expect(res).toEqual({ slide: 1, blocked: false });
  });

  it('slideSign prefers the committed hand when both sides clear', () => {
    const left = spawnMonster('soldier');
    left.move = 'run';
    left.frame = 0;
    const lo = v3(0, 0, 0);
    const rl = monsterLocomotion(left, lo, v3(100, 0, 0), eastBlocked, undefined, {
      newChaseDir: true,
      slideSign: 1,
    });
    expect(lo[1]).toBeGreaterThan(0);
    expect(rl.slide).toBe(1);
    const right = spawnMonster('soldier');
    right.move = 'run';
    right.frame = 0;
    const ro = v3(0, 0, 0);
    const rr = monsterLocomotion(right, ro, v3(100, 0, 0), eastBlocked, undefined, {
      newChaseDir: true,
      slideSign: -1,
    });
    expect(ro[1]).toBeLessThan(0);
    expect(rr.slide).toBe(-1);
  });

  it('total block keeps the direct partial and reports blocked', () => {
    const boxed: Trace = (s) => hit(0, v3(s[0], s[1], s[2]));
    const ms = spawnMonster('soldier');
    ms.move = 'run';
    ms.frame = 0;
    const origin = v3(0, 0, 0);
    const res = monsterLocomotion(ms, origin, v3(100, 0, 0), boxed, undefined, {
      newChaseDir: true,
    });
    // horizontal leg stands (the stub blocks everything); gravity still
    // applies its probe, which the same stub answers with the start point.
    expect(origin[0]).toBeCloseTo(0, 6);
    expect(origin[1]).toBeCloseTo(0, 6);
    expect(res).toEqual({ slide: 0, blocked: true });
  });

  it('stand frames and corpses report keep-commitment (blocked, no slide)', () => {
    const stand = spawnMonster('soldier'); // stand1, dist 0
    const so = v3(10, 20, 0);
    expect(monsterLocomotion(stand, so, v3(100, 100, 0), floorTrace())).toEqual({
      slide: 0,
      blocked: true,
    });
    expect([...so]).toEqual([10, 20, 0]);
    const dead = spawnMonster('soldier');
    dead.dead = true;
    dead.move = 'run';
    const do_ = v3(0, 0, 50);
    expect(monsterLocomotion(dead, do_, v3(100, 0, 0), openTrace)).toEqual({
      slide: 0,
      blocked: true,
    });
    expect([...do_]).toEqual([0, 0, 50]);
  });
});

describe('M_ChangeYaw clamp (id m_move.c, yaw_speed 20°/tick)', () => {
  // NOTE: precision 1 throughout — the repo's anglemod is id's quantized
  // version (65536ths of a turn, ~0.0055° steps), so exact-20 never survives
  // the wrap. The assertions below pin clamp direction + convergence, which
  // is what the facing gate depends on.
  it('steps toward the ideal on the shortest arc, clamped to speed', () => {
    expect(changeYaw(0, 90, 20)).toBeCloseTo(20, 1);
    expect(changeYaw(0, -90, 20)).toBeCloseTo(340, 1);
    expect(changeYaw(350, 10, 20)).toBeCloseTo(10, 1); // wraps through 0
    expect(changeYaw(0, 180, 20)).toBeCloseTo(340, 1); // id ties go negative
    expect(changeYaw(80, 90, 20)).toBeCloseTo(90, 1); // short remainder, no overshoot
    expect(changeYaw(45, 45, 20)).toBeCloseTo(45, 1);
  });

  it('yawDiff is the signed shortest arc in (-180, 180]', () => {
    expect(yawDiff(90, 0)).toBe(90);
    expect(yawDiff(0, 90)).toBe(-90);
    expect(yawDiff(10, 350)).toBe(20);
    expect(yawDiff(350, 10)).toBe(-20);
    expect(yawDiff(0, 180)).toBe(180);
  });
});

describe('corpse persistence (id holds the last death frame)', () => {
  it('dead think advances the death move to the last frame, then holds', () => {
    const ms = spawnMonster('soldier');
    monsterPain(ms, 1000, () => 0);
    expect(ms.dead).toBe(true);
    expect(ms.move).toBe('death1');
    expect(ms.frame).toBe(0);
    for (let i = 0; i < 100; i++) monsterThink(ms);
    const mv = monsterMoveOf(ms); // still a valid move (never 'dead')
    expect(ms.move).toBe('death1');
    expect(ms.frame).toBe(mv.frames.length - 1);
    expect(monsterThink(ms)).toBe(mv.frames[mv.frames.length - 1]!.action);
    expect(ms.frame).toBe(mv.frames.length - 1);
  });
});
describe('monster facing (Q2 yaw: 0 = +X, 90 = +Y/left)', () => {
  it('monsterYawTo matches id vectoyaw on the cardinals', () => {
    const o = v3(0, 0, 0);
    expect(monsterYawTo(o, v3(100, 0, 0))).toBeCloseTo(0, 9);
    expect(monsterYawTo(o, v3(0, 100, 0))).toBeCloseTo(90, 9);
    expect(monsterYawTo(o, v3(-100, 0, 0))).toBeCloseTo(180, 9);
    expect(monsterYawTo(o, v3(0, -100, 0))).toBeCloseTo(270, 9);
    expect(monsterYawTo(o, v3(100, 100, 0))).toBeCloseTo(45, 9);
  });

  it('locomotion faces the player via M_ChangeYaw clamp (20°/tick), no moonwalk', () => {
    const ms = spawnMonster('soldier'); // stand1, dist 0, yaw 0
    expect(ms.yaw).toBe(0);
    const origin = v3(0, 0, 0);
    monsterLocomotion(ms, origin, v3(0, 100, 0), floorTrace());
    // Ideal is 90 but yaw_speed clamps the first tick to ~20 (id M_ChangeYaw;
    // quantized anglemod, so precision 1).
    expect(ms.yaw).toBeCloseTo(20, 1);
    expect([...origin]).toEqual([0, 0, 0]); // stand frames never translate
    // Four more ticks converge exactly on the ideal (no overshoot).
    for (let i = 0; i < 4; i++) monsterLocomotion(ms, origin, v3(0, 100, 0), floorTrace());
    expect(ms.yaw).toBeCloseTo(90, 1);
  });

  it('locomotion faces along travel on nonzero-dist run frames', () => {
    const ms = spawnMonster('soldier');
    ms.move = 'run'; // frame 0 dist 10
    ms.frame = 0;
    const origin = v3(0, 0, 0);
    monsterLocomotion(ms, origin, v3(0, 100, 0), floorTrace());
    expect(ms.yaw).toBeCloseTo(20, 1); // clamped first step toward 90
    expect(origin[0]).toBeCloseTo(0, 6);
    expect(origin[1]).toBeCloseTo(10, 6);
  });

  it('corpses keep their last yaw and never move', () => {
    const ms = spawnMonster('soldier');
    ms.dead = true;
    ms.yaw = 135;
    const origin = v3(0, 0, 50);
    monsterLocomotion(ms, origin, v3(100, 0, 0), openTrace);
    expect(ms.yaw).toBe(135);
    expect([...origin]).toEqual([0, 0, 50]);
  });

  it('coincident player keeps the last yaw (no NaN facing)', () => {
    const ms = spawnMonster('gunner');
    ms.yaw = 45;
    const origin = v3(10, 10, 0);
    monsterLocomotion(ms, origin, v3(10, 10, 0), floorTrace());
    expect(ms.yaw).toBe(45);
    expect(Number.isFinite(ms.yaw)).toBe(true);
  });

  it('think steps frames; first + offset maps to the MD2 index', () => {
    const ms = spawnMonster('soldier');
    ms.move = 'run'; // id FRAME_run03..run08 = MD2 99..104
    for (let i = 0; i < 6; i++) {
      const mv = monsterMoveOf(ms);
      expect(mv.first + ms.frame).toBe(99 + i);
      monsterThink(ms);
    }
    expect(ms.move).toBe('run'); // the 6-frame run loops
    expect(ms.frame).toBe(0);
  });
});
