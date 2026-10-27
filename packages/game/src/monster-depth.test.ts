// M5.3 depth: player-trail ring (p_trail.c) + M_CheckAttack (g_ai.c) +
// soldier dodge/duck odds + skill aggression (sight delay, burst refire).
// Algorithm ports — our naming. Deterministic: every rand is seeded.
import { describe, expect, it } from 'vitest';
import { v3 } from '@q2/math';
import {
  RANGE_MELEE,
  RANGE_NEAR,
  RANGE_MID,
  RANGE_FAR,
  burstRefire,
  checkAttack,
  checkDodgeGate,
  monsterChaseMove,
  monsterHasMelee,
  sightReactionDelay,
  soldierDodgeChoice,
  spawnMonster,
  MONSTER_HULL_MAXS_DUCKED,
  MONSTER_HULL_MAXS,
} from './monsters.js';
import {
  trailAdd,
  trailInit,
  trailLastSpot,
  trailPickFirst,
  trailPickNext,
  trailNext,
  trailPrev,
  TRAIL_LENGTH,
} from './trail.js';
import { mulberry32 } from './weapons.js';

/** Constant-sequence rand (C tests step random() per draw). */
function seq(...vs: number[]): () => number {
  let i = 0;
  return () => vs[Math.min(i++, vs.length - 1)]!;
}

describe('player trail ring (p_trail.c)', () => {
  it('inactive trail is all no-ops/null (deathmatch C path)', () => {
    const t = trailInit(false);
    trailAdd(t, v3(1, 2, 3), 1);
    expect(trailLastSpot(t)).toBeNull();
    expect(trailPickFirst(t, 0, () => true)).toBeNull();
    expect(trailPickNext(t, 0)).toBeNull();
  });

  it('add stores spot + time and yaws toward the delta', () => {
    const t = trailInit(true);
    trailAdd(t, v3(100, 0, 0), 1);
    expect(t.head).toBe(1);
    const last = trailLastSpot(t)!;
    expect([...last.origin]).toEqual([100, 0, 0]);
    expect(last.timestamp).toBe(1);
    // delta from (0,0,0) to (100,0,0) faces +X: yaw 0.
    expect(last.yaw).toBeCloseTo(0, 9);
    trailAdd(t, v3(100, 100, 0), 2);
    expect(trailLastSpot(t)!.yaw).toBeCloseTo(90, 9); // +Y is left: yaw 90
  });

  it('ring wraps at TRAIL_LENGTH', () => {
    expect(TRAIL_LENGTH).toBe(8);
    expect(trailNext(7)).toBe(0);
    expect(trailPrev(0)).toBe(7);
    const t = trailInit(true);
    for (let i = 0; i < 10; i++) trailAdd(t, v3(i, 0, 0), i + 1);
    expect(t.head).toBe(2);
    expect(trailLastSpot(t)!.origin[0]).toBe(9);
  });

  it('PickFirst skips stale markers, prefers visible, else newest', () => {
    const t = trailInit(true);
    trailAdd(t, v3(10, 0, 0), 1);
    trailAdd(t, v3(20, 0, 0), 2);
    trailAdd(t, v3(30, 0, 0), 3);
    // trail_time 2: the ts<=2 markers skip, newest (30) returns when visible.
    expect(trailPickFirst(t, 2, () => true)!.origin[0]).toBe(30);
    // newest invisible, previous visible: falls back to the previous.
    const pick = trailPickFirst(t, 2, (s) => s[0]! < 30);
    expect(pick!.origin[0]).toBe(20);
    // nothing visible: still returns the newest (C always returns non-null).
    expect(trailPickFirst(t, 2, () => false)!.origin[0]).toBe(30);
    // PickNext ignores visibility: newest past trail_time.
    expect(trailPickNext(t, 2)!.origin[0]).toBe(30);
    // everything stale: full circle back to head (C behaviour).
    expect(trailPickNext(t, 99)).not.toBeNull();
  });
});

describe('M_CheckAttack chance/as-state table (g_ai.c)', () => {
  const base = {
    canSee: true,
    standGround: false,
    attackFinished: 0,
    time: 5,
    skill: 1,
    hasAttack: true,
    hasMelee: false,
  };

  it('needs a clear shot (C inline trace failed)', () => {
    const r = checkAttack({ ...base, range: RANGE_NEAR, canSee: false, rand: () => 0 });
    expect(r).toEqual({ attack: false, attackState: 'straight', attackFinished: 0 });
  });

  it('melee always commits past easy (AS_MELEE iff melee callback)', () => {
    const melee = checkAttack({ ...base, range: RANGE_MELEE, hasMelee: true, rand: () => 0.99 });
    expect(melee.attack).toBe(true);
    expect(melee.attackState).toBe('melee');
    const gun = checkAttack({ ...base, range: RANGE_MELEE, hasMelee: false, rand: () => 0.99 });
    expect(gun.attack).toBe(true);
    expect(gun.attackState).toBe('missile'); // soldier/gunner melee is NULL
  });

  it('easy melee gate fails 3/4 (rand()&3)', () => {
    let fails = 0;
    for (let i = 0; i < 4; i++) {
      // floor(r*4) != 0 for r in {0.25, 0.5, 0.75} → fail; r=0 passes.
      const r = checkAttack({ ...base, range: RANGE_MELEE, skill: 0, hasMelee: true, rand: () => i / 4 });
      if (!r.attack) fails++;
    }
    expect(fails).toBe(3);
  });

  it('attack_finished + FAR reject (no attack callback / cooldown)', () => {
    expect(checkAttack({ ...base, range: RANGE_FAR, rand: () => 0 }).attack).toBe(false);
    expect(checkAttack({ ...base, range: RANGE_NEAR, hasAttack: false, rand: () => 0 }).attack).toBe(false);
    expect(checkAttack({ ...base, range: RANGE_NEAR, attackFinished: 99, rand: () => 0 }).attack).toBe(false);
  });

  it('range/stand-ground chance table with skill scaling', () => {
    // roll 0 always passes any nonzero chance; roll 0.99 fails all.
    for (const range of [RANGE_NEAR, RANGE_MID]) {
      expect(checkAttack({ ...base, range, rand: () => 0 }).attack).toBe(true);
      expect(checkAttack({ ...base, range, rand: () => 0.99 }).attack).toBe(false);
    }
    // stand ground quadruples the near odds (0.4): roll 0.3 passes.
    expect(checkAttack({ ...base, range: RANGE_NEAR, standGround: true, rand: () => 0.3 }).attack).toBe(true);
    expect(checkAttack({ ...base, range: RANGE_NEAR, standGround: false, rand: () => 0.3 }).attack).toBe(false);
    // easy halves (near 0.05: 0.06 fails), hard doubles (near 0.2: 0.15 passes).
    expect(checkAttack({ ...base, range: RANGE_NEAR, skill: 0, rand: () => 0.06 }).attack).toBe(false);
    expect(checkAttack({ ...base, range: RANGE_NEAR, skill: 3, rand: () => 0.15 }).attack).toBe(true);
    // success sets the C cooldown attack_finished = time + 2*rand.
    const ok = checkAttack({ ...base, range: RANGE_NEAR, rand: () => 0 });
    expect(ok.attackFinished).toBeCloseTo(5, 9); // second draw is 0 here
  });

  it('cooldown distribution is C-shaped (time + 2*rand)', () => {
    const rand = mulberry32(42);
    let sum = 0;
    const n = 200;
    for (let i = 0; i < n; i++) {
      const r = checkAttack({ ...base, range: RANGE_NEAR, time: 0, rand });
      if (r.attack) sum += r.attackFinished;
    }
    // mean of 2*rand over the successes ≈ 1.0 (uniform 0..2).
    expect(sum / n).toBeGreaterThan(0.05); // ~10% succeed at near/skill1
  });
});

describe('skill-scaled aggression (sight delay, dodge, burst)', () => {
  it('sight delay: easy slowest, nightmare fastest, medium is the C 1s', () => {
    expect(sightReactionDelay(0)).toBeGreaterThan(sightReactionDelay(1));
    expect(sightReactionDelay(1)).toBe(1.0);
    expect(sightReactionDelay(2)).toBeLessThan(1.0);
    expect(sightReactionDelay(3)).toBeLessThan(sightReactionDelay(2));
  });

  it('monsterHasMelee: infantry only (soldier/gunner melee is NULL)', () => {
    expect(monsterHasMelee('infantry')).toBe(true);
    expect(monsterHasMelee('soldier')).toBe(false);
    expect(monsterHasMelee('gunner')).toBe(false);
  });

  it('check_dodge easy gate: quarter checks at skill 0, always above', () => {
    expect(checkDodgeGate(0, () => 0.2)).toBe(true);
    expect(checkDodgeGate(0, () => 0.3)).toBe(false);
    expect(checkDodgeGate(1, () => 0.99)).toBe(true);
    expect(checkDodgeGate(3, () => 0.99)).toBe(true);
  });

  it('soldier_dodge odds: 25% react; easy ducks, higher ducks-and-shoots', () => {
    // no reaction three quarters of the time, every skill.
    for (const skill of [0, 1, 2, 3]) {
      expect(soldierDodgeChoice(skill, () => 0.5)).toBe('none');
    }
    // reacting quarter: easy always ducks.
    expect(soldierDodgeChoice(0, seq(0.1, 0.9))).toBe('duck');
    // skill 1: second draw > 0.33 ducks, else duck-and-shoots (attack3).
    expect(soldierDodgeChoice(1, seq(0.1, 0.5))).toBe('duck');
    expect(soldierDodgeChoice(1, seq(0.1, 0.2))).toBe('duckShoot');
    // skill 3: second draw > 0.66 ducks, else duck-and-shoots.
    expect(soldierDodgeChoice(3, seq(0.1, 0.7))).toBe('duck');
    expect(soldierDodgeChoice(3, seq(0.1, 0.5))).toBe('duckShoot');
  });

  it('duck hull shrinks the full C 32 (standing 32 -> ducked 0)', () => {
    expect(MONSTER_HULL_MAXS[2]).toBe(32);
    expect(MONSTER_HULL_MAXS_DUCKED[2]).toBe(0);
    expect(MONSTER_HULL_MAXS_DUCKED[0]).toBe(MONSTER_HULL_MAXS[0]);
  });

  it('burst refire: skill 3 machinegun-class only, coin flip', () => {
    expect(burstRefire(2, true, () => 0)).toBe(false);
    expect(burstRefire(3, false, () => 0)).toBe(false);
    expect(burstRefire(3, true, () => 0.4)).toBe(true);
    expect(burstRefire(3, true, () => 0.6)).toBe(false);
  });
});

describe('chase integrates the C gate (replaces the flat 0.7 roll)', () => {
  const nav = {
    graph: new Map([[0, [1]]]),
    positions: new Map([[0, v3(0, 0, 24)], [1, v3(200, 0, 24)]]),
  };

  it('cooldown holsters the attack (attack_finished in the future)', () => {
    const ms = spawnMonster('soldier');
    ms.yaw = 0;
    const res = monsterChaseMove(ms, v3(0, 0, 24), v3(200, 0, 24), nav, true, seq(0, 0.4), {
      time: 5,
      skill: 1,
    });
    // roll 0 passes the 0.1 chance: attack1, cooldown stamped (5 + 2*0.4).
    expect(res.move).toBe('attack1');
    expect(ms.attackFinished).toBe(5.8);
    expect(ms.attackState).toBe('missile');
  });

  it('goal steers while range still keys off the enemy', () => {
    const ms = spawnMonster('soldier');
    // blind: no attack even point-blank; steers at the goal instead.
    const goalNav = {
      graph: new Map([[0, [1]], [1, [0]]]),
      positions: new Map([[0, v3(0, 0, 24)], [1, v3(0, 200, 24)]]),
    };
    const res = monsterChaseMove(ms, v3(0, 0, 24), v3(10, 0, 24), goalNav, false, () => 0, {
      time: 5,
      skill: 1,
      goal: v3(0, 200, 24),
    });
    expect(res.move).toBe('run');
    expect(ms.attackState).toBe('straight');
    expect(res.target?.[1]).toBe(200);
  });

  it('standGround runs the 0.4 table (combat-point hold plants shots)', () => {
    const ms = spawnMonster('soldier');
    ms.yaw = 0;
    const res = monsterChaseMove(ms, v3(0, 0, 24), v3(200, 0, 24), nav, true, () => 0.3, {
      time: 5,
      skill: 1,
      standGround: true,
    });
    expect(res.move).toBe('attack1'); // 0.3 < 0.4 passes; fails unplanted
  });
});
