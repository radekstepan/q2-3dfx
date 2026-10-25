// M7.2 regression: "soldier at 50 units with LOS deals damage within 2s".
//
// monsterCombat itself lives in apps/web (outside this package), but every
// decision it makes comes from this package: monsterRange thresholds,
// selectAttack choice, spawnMonster/lastAttack init, and the ~1/s
// rate-limit documented in play.ts. This test pins that contract at the
// game-logic layer so a future change here (e.g. selectAttack returning
// 'none'/'idle'/null at close range, or a MELEE_DISTANCE shrink) fails here
// instead of silently making the player invincible.
import { describe, expect, it } from 'vitest';
import {
  MELEE_DISTANCE,
  RANGE_MELEE,
  monsterRange,
  selectAttack,
  spawnMonster,
} from './monsters.js';
import { mulberry32 } from './weapons.js';

describe('monster fight-back contract (M7.2 regression)', () => {
  it('50 units is melee range', () => {
    expect(monsterRange(50)).toBe(RANGE_MELEE);
    expect(50).toBeLessThan(MELEE_DISTANCE);
  });

  it("selectAttack never idles at close range (no null/'idle'/'none')", () => {
    for (const dist of [10, 50, MELEE_DISTANCE - 1]) {
      expect(selectAttack('soldier', dist, mulberry32(0x51ab))).toBe('melee');
      expect(selectAttack('gunner', dist, mulberry32(0x51ab))).toBe('melee');
    }
    // Just outside melee the soldier still fires (never 'none' inside 1000).
    for (const dist of [MELEE_DISTANCE, 200, 500, 999]) {
      const s = selectAttack('soldier', dist, mulberry32(7));
      expect(s === 'shotgun' || s === 'blaster').toBe(true);
    }
  });

  it('soldier at 50 units with LOS deals damage within 2s', () => {
    // Mirrors the documented monsterCombat decision in apps/web/src/play.ts:
    // clear LOS, range gate <= 1000, ~1/s per-monster rate limit, melee
    // always lands, ranged uses the near 0.6 hit chance. Uses only game
    // primitives (the driver itself is web-owned and cannot be imported
    // here without violating the package dependency graph).
    const rand = mulberry32(0x51ab);
    const state = spawnMonster('soldier');
    expect(state.dead).toBe(false);
    let lastAttack = -10; // play.ts placeMonsters init
    let time = 0;
    let damage = 0;
    const dist = 50;
    for (let tick = 0; tick < 20; tick++) {
      time += 0.1; // SV_Tick 10Hz quantum
      if (time - lastAttack < 1.0) continue; // id ~1/s rate limit
      if (dist > 1000) continue; // range gate
      // LOS clear (stubbed: caller traceShot fraction === 1)
      const choice = selectAttack(state.kind, dist, rand);
      if (choice === 'melee') {
        lastAttack = time;
        damage += 10; // soldier touch damage in monsterCombat
      } else if (choice === 'shotgun' || choice === 'blaster') {
        lastAttack = time;
        if (rand() < 0.6) damage += 5;
      } else {
        throw new Error(`soldier at 50 must attack, got ${String(choice)}`);
      }
    }
    expect(damage).toBeGreaterThan(0);
    // Melee always commits: two rate-limited hits land in 2s (10 + 10).
    expect(damage).toBe(20);
  });
});
