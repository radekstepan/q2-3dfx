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
import { v3 } from '@q2/math';
import {
  MELEE_DISTANCE,
  MONSTER_YAW_SPEED,
  RANGE_MELEE,
  INFANTRY_C,
  SOLDIER,
  SOLDIER_GIB_HEALTH,
  SOLDIER_HP,
  attackMoveFor,
  changeYaw,
  corpseHittable,
  entityAngles,
  isAttackMove,
  monsterChaseMove,
  monsterFrameNumber,
  monsterMoveOf,
  monsterRange,
  selectAttack,
  soldierHealthForSkin,
  spawnMonster,
  yawDiff,
} from './monsters.js';
import { gibModelsFor, GIB_SOUND, GIB_DEADFLAG } from './explosives.js';
import { monsterPain, monsterThink } from './monsters.js';
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

describe('soldier/gunner animation + facing regressions (M7.2 batch #3)', () => {
  it('authentic attack frames: soldier attack1 0-11 fires at idx 2, attack2 12-29 at idx 4', () => {
    const s = spawnMonster('soldier');
    s.move = 'attack1';
    const a1 = monsterMoveOf(s);
    expect(a1.first).toBe(0); // id FRAME_attak101
    expect(a1.last).toBe(11); // id FRAME_attak112
    expect(a1.frames.map((f) => f.action)).toEqual([
      'move', 'move', 'fire', 'move', 'move', 'move',
      'move', 'move', 'move', 'move', 'move', 'move',
    ]);
    s.move = 'attack2';
    const a2 = monsterMoveOf(s);
    expect(a2.first).toBe(12); // id FRAME_attak201
    expect(a2.last).toBe(29); // id FRAME_attak218
    expect(a2.frames[4]!.action).toBe('fire');
    expect(a2.frames.filter((f) => f.action === 'fire').length).toBe(1);
  });

  it('gunner chains: attack_chain 7f -> fire_chain 8f all-fire -> endfire_chain 7f', () => {
    const g = spawnMonster('gunner');
    g.move = 'attack_chain';
    expect(monsterMoveOf(g).frames.length).toBe(7);
    expect(monsterMoveOf(g).frames.every((f) => f.action === 'fire')).toBe(true);
    g.move = 'fire_chain';
    const fc = monsterMoveOf(g);
    expect(fc.frames.length).toBe(8);
    expect(fc.frames.every((f) => f.action === 'fire')).toBe(true);
    g.move = 'endfire_chain';
    expect(monsterMoveOf(g).frames.length).toBe(7);
    expect(isAttackMove('endfire_chain')).toBe(true);
  });

  it('monsterFrameNumber is first+frame clamped to the move (MD2 index)', () => {
    const s = spawnMonster('soldier');
    s.move = 'run'; // first 99, 6 frames
    s.frame = 0;
    expect(monsterFrameNumber(s)).toBe(99);
    s.frame = 5;
    expect(monsterFrameNumber(s)).toBe(104);
    // overrun frames clamp instead of walking off the model
    s.frame = 500;
    expect(monsterFrameNumber(s)).toBe(monsterMoveOf(s).last);
    expect(monsterFrameNumber(s)).toBeLessThan(475); // soldier MD2 bound
  });

  it('death move holds the last frame (corpses persist, never wrap to dead)', () => {
    const s = spawnMonster('soldier');
    monsterPain(s, 1000, () => 0);
    expect(s.move).toBe('death1');
    for (let i = 0; i < 200; i++) monsterThink(s);
    const mv = monsterMoveOf(s);
    expect(s.move).toBe('death1'); // never enters the 'dead' end name
    expect(s.frame).toBe(mv.frames.length - 1);
    expect(monsterFrameNumber(s)).toBe(mv.last); // held on the fallen pose
  });

  it('attack latches mid-move: chase never re-rolls or resets the frame', () => {
    const s = spawnMonster('soldier');
    s.move = 'attack2';
    s.frame = 6;
    const nav = { graph: new Map([[0, [1]]]), positions: new Map([[0, v3(0, 0, 0)], [1, v3(5, 0, 0)]]) };
    const res = monsterChaseMove(s, v3(0, 0, 0), v3(5, 0, 0), nav, true, mulberry32(1));
    expect(res.move).toBe('attack2');
    expect(s.frame).toBe(6);
  });

  it('FacingIdeal gate: attacks only within ±45°, else run while yaw clamps', () => {
    const nav = { graph: new Map([[0, [1]]]), positions: new Map([[0, v3(0, 0, 0)], [1, v3(0, 200, 0)]]) };
    const away = spawnMonster('soldier'); // yaw 0, player north (ideal 90): diff 90
    expect(Math.abs(yawDiff(90, away.yaw))).toBeGreaterThan(45);
    expect(monsterChaseMove(away, v3(0, 0, 0), v3(0, 200, 0), nav, true, () => 0).move).toBe('run');
    const facing = spawnMonster('soldier');
    facing.yaw = 80; // diff 10: gate passes, shotgun attack1
    expect(monsterChaseMove(facing, v3(0, 0, 0), v3(0, 200, 0), nav, true, () => 0).move).toBe('attack1');
    // boundary: exactly ±45 commits
    const edge = spawnMonster('soldier');
    edge.yaw = 45;
    const r = monsterChaseMove(edge, v3(0, 0, 0), v3(0, 200, 0), nav, true, () => 0);
    expect(r.move).toBe(attackMoveFor('soldier', 'shotgun'));
  });

  it('yaw clamps per-tick via M_ChangeYaw (speed 20), entityAngles returns stored yaw', () => {
    expect(MONSTER_YAW_SPEED['soldier']).toBe(20);
    expect(MONSTER_YAW_SPEED['gunner']).toBe(20);
    expect(changeYaw(0, 90, 20)).toBeCloseTo(20, 1);
    const s = spawnMonster('soldier');
    s.yaw = 135;
    expect(entityAngles(s)).toEqual([0, 135, 0]);
    s.yaw = changeYaw(s.yaw, 180, 20);
    expect(entityAngles(s)[1]).toBeCloseTo(155, 1);
  });
});

describe('shooting dead: corpses hittable, overkill gibs (M7.2 batch #4)', () => {
  it('corpses stay hittable until gibbed; gibbed bodies are gone', () => {
    const s = spawnMonster('soldier'); // health 30, gibHealth -30
    expect(corpseHittable(s)).toBe(false); // alive: not a corpse
    expect(monsterPain(s, 40, () => 0)).toBe('dead'); // health -10: dead, not minced
    expect(s.dead).toBe(true);
    expect(s.gibbed).toBe(false);
    expect(corpseHittable(s)).toBe(true); // takedamage YES: re-hits can mince
    // a light re-hit short of gib-health stays a corpse (never revives)
    expect(monsterPain(s, 1, () => 0)).toBe('dead');
    expect(s.dead).toBe(true);
    expect(corpseHittable(s)).toBe(true);
  });

  it('overkill re-hit gibs the corpse: sm_meat/chest/head + udeath + DEAD_DEAD', () => {
    const s = spawnMonster('soldier');
    monsterPain(s, 40, () => 0); // dead, health -10
    const res = monsterPain(s, 25, () => 0); // health -35 <= gibHealth -30
    expect(res).toBe('gib');
    expect(s.gibbed).toBe(true);
    expect(corpseHittable(s)).toBe(false); // DEAD_DEAD: unhittable from now on
    expect(monsterPain(s, 1000, () => 0)).toBe('none'); // gibbed: no further damage
    expect([...gibModelsFor('soldier')]).toEqual(['sm_meat', 'sm_meat', 'sm_meat', 'chest', 'head2']);
    expect(GIB_SOUND).toBe('misc/udeath.wav');
    expect(GIB_DEADFLAG).toBe('DEAD_DEAD');
  });

  it('gib-first ordering: a single massive hit gibs outright (never plain dead)', () => {
    const g = spawnMonster('gunner'); // health 175, gibHealth -70
    expect(monsterPain(g, 1000, () => 0)).toBe('gib');
    expect(g.gibbed).toBe(true);
  });
});

describe('Phase 2 C HP/damage tables (m_soldier.c, m_infantry.c)', () => {
  it('soldier spawn HP is skin-determined: 20 / 30 / 40 (gib -30 throughout)', () => {
    // m_soldier.c SP_ funcs: light (skin 0) 20hp, normal (skin 2) 30hp,
    // super-shot (skin 4) 40hp; every skin gibs at -30.
    expect(soldierHealthForSkin(0)).toBe(20);
    expect(soldierHealthForSkin(1)).toBe(20);
    expect(soldierHealthForSkin(2)).toBe(30);
    expect(soldierHealthForSkin(3)).toBe(30);
    expect(soldierHealthForSkin(4)).toBe(40);
    expect(soldierHealthForSkin(5)).toBe(40);
    expect(soldierHealthForSkin(99)).toBe(40);
    expect(SOLDIER_HP).toEqual({ blaster: 20, shotgun: 30, machinegun: 40 });
    expect(SOLDIER_GIB_HEALTH).toBe(-30);
    // the shared lite def stays the normal (shotgun-skin) class
    expect(SOLDIER.health).toBe(30);
    expect(SOLDIER.gibHealth).toBe(-30);
  });

  it('soldier skin damage matches the m_soldier.c monster_fire_* args', () => {
    // soldier_fire: blaster 5dmg@600 (skin<=1), shotgun 2dmg x12 kick 1
    // (skin<=3), machinegun bullet 2dmg kick 4 (else). Damage lives in
    // SOLDIER_WEAPON_STATS (pinned in soldier-fire.test.ts); the HP table
    // keys off the same skin families.
    expect(SOLDIER_HP.blaster).toBe(20);
    expect(SOLDIER_HP.shotgun).toBe(30);
    expect(SOLDIER_HP.machinegun).toBe(40);
  });

  it('infantry C numbers back the lite def (m_infantry.c, now simulated)', () => {
    // SP_monster_infantry: 100hp, gib -40, mass 200. InfantryMachineGun ->
    // monster_fire_bullet dmg 3 kick 4 spread 300/500; infantry_smack ->
    // fire_hit dmg 5+(rand%5) kick 50.
    expect(INFANTRY_C.health).toBe(100);
    expect(INFANTRY_C.gibHealth).toBe(-40);
    expect(INFANTRY_C.mass).toBe(200);
    expect(INFANTRY_C.bulletDamage).toBe(3);
    expect(INFANTRY_C.bulletKick).toBe(4);
    expect(INFANTRY_C.bulletHspread).toBe(300);
    expect(INFANTRY_C.bulletVspread).toBe(500);
    expect(INFANTRY_C.meleeDamageMin).toBe(5);
    expect(INFANTRY_C.meleeDamageMax).toBe(9);
    expect(INFANTRY_C.meleeKick).toBe(50);
  });
});
