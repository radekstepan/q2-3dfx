// M5.3 depth server pins: combat points, soldier dodge/duck, trail
// pursuit, separation, sight delay + burst refire at the tick level.
// Deterministic: seeded or sequence rands throughout.
import { describe, expect, it } from 'vitest';
import {
  MONSTER_HULL_MAXS,
  MONSTER_HULL_MAXS_DUCKED,
  mulberry32,
  resetEdictNums,
} from '@q2/game';
import type { TraceFn, TraceResult } from '@q2/game';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  SV_Init,
  SV_MonsterTick,
  SV_PlayerFire,
  SV_SetSkill,
  SV_SpawnEntities,
  SV_SpawnMonster,
  SV_Tick,
  SV_UseMonster,
  SV_UseTargetname,
} from './index.js';
import {
  arriveCombatPoint,
  duckHoldFrozen,
  monsterHullMaxs,
  monsterSeesPoint,
  pursueGoal,
  resolveCombatPoint,
  separationOffset,
  skinOf,
} from './monster-ai.js';

/** Floor-aware open room: horizontal free, ground rests at z=24. */
function floorTrace(): TraceFn {
  return (start: Vec3, _mins: Vec3, _maxs: Vec3, end: Vec3): TraceResult => {
    if (end[2]! < 24) {
      return {
        fraction: 0,
        endpos: v3(start[0], start[1], 24),
        planeNormal: v3(0, 0, 1),
        allsolid: false,
        startsolid: false,
        entityNum: -1,
        contents: 0,
      };
    }
    return {
      fraction: 1,
      endpos: v3(end[0], end[1], end[2]),
      planeNormal: v3(0, 0, 1),
      allsolid: false,
      startsolid: false,
      entityNum: -1,
      contents: 0,
    };
  };
}

function playerAt(x: number, z = 24): { pos: Vec3; mins: Vec3; maxs: Vec3; view: number } {
  return { pos: v3(x, 0, z), mins: v3(-16, -16, -24), maxs: v3(16, 16, 32), view: 22 };
}

function seq(...vs: number[]): () => number {
  let i = 0;
  return () => vs[Math.min(i++, vs.length - 1)]!;
}

describe('combat points (point_combat / combattarget)', () => {
  const TEXT =
    `{ "classname" "worldspawn" }\n` +
    `{ "classname" "point_combat" "targetname" "t67" "target" "t68" "origin" "0 100 24" }\n` +
    `{ "classname" "point_combat" "targetname" "t68" "spawnflags" "1" "origin" "0 200 24" }\n` +
    `{ "classname" "monster_soldier" "origin" "0 0 24" "combattarget" "t67" }\n` +
    `{ "classname" "monster_soldier" "origin" "300 0 24" }\n`;

  it('lump spawns markers with hold/target links', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(st, TEXT);
    expect(st.combatPoints.map((c) => c.targetname)).toEqual(['t67', 't68']);
    expect(st.combatPoints[0]!.target).toBe('t68');
    expect(st.combatPoints[0]!.hold).toBe(false);
    expect(st.combatPoints[1]!.hold).toBe(true);
  });

  it('acquire installs the combat goal one-shot; the plain soldier hunts', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(st, TEXT);
    const linked = st.monsters.find((m) => m.edict.extra['combattarget'] === 't67')!;
    const plain = st.monsters.find((m) => !m.edict.extra['combattarget'])!;
    linked.seen = true;
    plain.seen = true;
    expect(resolveCombatPoint(st, linked)).toBe(true);
    expect([...linked.combatGoal!]).toEqual([0, 100, 24]);
    expect(linked.combatHold).toBe(false);
    expect(resolveCombatPoint(st, plain)).toBe(false);
    expect(plain.combatGoal).toBeNull();
    // one-shot: second call keeps the goal, never re-resolves.
    expect(resolveCombatPoint(st, linked)).toBe(true);
  });

  it('arrival chains t67 -> t68, then hold keeps the stand', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(st, TEXT);
    const linked = st.monsters.find((m) => m.edict.extra['combattarget'] === 't67')!;
    linked.seen = true;
    resolveCombatPoint(st, linked);
    // walk the goal onto the marker: arrival advances the chain.
    linked.edict.origin = v3(0, 100, 24);
    expect(arriveCombatPoint(st, linked)).toBeNull(); // t68 has no pathtarget
    expect([...linked.combatGoal!]).toEqual([0, 200, 24]);
    expect(linked.combatHold).toBe(true); // t68 hold flag
    // arriving at the hold point clears the run but keeps combatHold.
    linked.edict.origin = v3(0, 200, 24);
    arriveCombatPoint(st, linked);
    expect(linked.combatGoal).toBeNull();
    expect(linked.combatHold).toBe(true);
  });

  it('combat goal steers the tick and holsters attacks en route', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(st, TEXT);
    const linked = st.monsters.find((m) => m.edict.extra['combattarget'] === 't67')!;
    const trace = floorTrace();
    const player = v3(0, -300, 24); // visible behind the start
    linked.seen = true;
    const rand = mulberry32(5);
    let fired = 0;
    // Run only until the first point is reached: combat runs never consider
    // attacks (C COMBAT_POINT: M_MoveToGoal + return), so the whole leg is
    // silent. The t67 arrival chains onto the hold point and stops the leg
    // before the hold behaviour (pinned below) takes over.
    for (let i = 0; i < 40 && !linked.combatHold; i++) {
      st.time += 0.1;
      fired += SV_MonsterTick(st, player, trace, null, rand, { sightTrace: trace }).length;
    }
    expect(linked.combatHold).toBe(true); // the chain advanced past t67
    // headed for the point (arrival radius 24 of t67), never fired en route.
    expect(linked.edict.origin[1]!).toBeGreaterThan(50);
    expect(fired).toBe(0);
  });
});

describe('soldier dodge/duck on incoming blaster fire', () => {
  /**
   * One aimed blaster pull. The rand stream burns 3 draws before the dodge
   * rolls (fireWeapon spread r/u + muzzle radius), so dodge scripts prefix
   * three throwaways: seq(…, …, …, react, choice).
   */
  function aimedShot(st: ReturnType<typeof SV_Init>, rand: () => number): void {
    const eye = v3(200, 0, 46);
    SV_PlayerFire(st, 'weapon_blaster', {
      eye,
      feet: v3(200, 0, 24),
      angles: v3(0, 180, 0), // facing -X at the soldier at x=0
      viewheight: 22,
      ammo: 0,
      trace: floorTrace(),
      rand,
    });
  }

  it('a soldier in the shot line ducks (skill 1, forced react + duck)', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 24));
    m.state.yaw = 0; // faces +X: the shooter at +X is in front (infront)
    // react draw 0.1 (< 0.25), then skill-1 duck draw 0.5 (> 0.33) = duck.
    aimedShot(st, seq(0.9, 0.9, 0.9, 0.1, 0.5));
    expect(m.state.move).toBe('duck');
    expect(m.state.frame).toBe(0);
    expect(m.duckUntil).toBeGreaterThan(st.time);
    expect(m.duckShoot).toBe(false);
    expect(monsterHullMaxs(m)).toBe(MONSTER_HULL_MAXS_DUCKED);
  });

  it('skill 1 can duck-and-shoot instead (attack3, fires mid-duck)', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 24));
    m.state.yaw = 0;
    // react 0.1, skill-1 second draw 0.2 (< 0.33) = duckShoot.
    aimedShot(st, seq(0.9, 0.9, 0.9, 0.1, 0.2));
    expect(m.state.move).toBe('duck');
    expect(m.duckShoot).toBe(true);
    // run the duck to its fire frame with LOS: one skin-gun event. The duck
    // hold freezes frame 1 while pausetime runs, so the 5-frame move needs
    // ~8 ticks to play out.
    const trace = floorTrace();
    let fired = 0;
    for (let i = 0; i < 10; i++) {
      st.time += 0.1;
      for (const ev of SV_MonsterTick(st, v3(200, 0, 24), trace, null, mulberry32(9), { sightTrace: trace })) {
        if (ev.move === 'attack2') fired++;
      }
    }
    expect(fired).toBe(1);
    expect(m.state.move).not.toBe('duck'); // the duck played out and exited
  });

  it('duck hold freezes the hold frame while pausetime runs', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 24));
    m.state.move = 'duck';
    m.state.frame = 1;
    m.duckUntil = 10;
    expect(duckHoldFrozen(m, 5)).toBe(true);
    expect(duckHoldFrozen(m, 10)).toBe(false);
    m.state.frame = 2;
    expect(duckHoldFrozen(m, 5)).toBe(false);
  });

  it('easy reacts less (check_dodge quarter-gate) and hitscan never dodges', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SetSkill(st, 0);
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 24));
    m.state.yaw = 0;
    // gate draw 0.5 (> 0.25): no dodge at all on easy.
    aimedShot(st, seq(0.9, 0.9, 0.9, 0.5));
    expect(m.state.move).not.toBe('duck');
    // shotgun (instant weapon) never triggers check_dodge, even aimed.
    const eye = v3(200, 0, 46);
    SV_PlayerFire(st, 'weapon_shotgun', {
      eye,
      feet: v3(200, 0, 24),
      angles: v3(0, 180, 0),
      viewheight: 22,
      ammo: 10,
      trace: floorTrace(),
      rand: seq(0.01, 0.01),
    });
    expect(m.state.move).not.toBe('duck');
  });

  it('skinOf + monsterSeesPoint face the dodge the C way', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 24));
    expect(skinOf(m)).toBe(2);
    m.state.yaw = 0;
    expect(monsterSeesPoint(m, v3(200, 0, 24))).toBe(true); // ahead
    expect(monsterSeesPoint(m, v3(-200, 0, 24))).toBe(false); // behind
  });
});

describe('trail pursuit at the tick level', () => {
  it('blind seen monsters head for the last sighting, then the trail', () => {
    resetEdictNums();
    const st = SV_Init();
    const trace = floorTrace();
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 24));
    // seen with sight: lastSighting latches the player spot.
    m.state.yaw = 0;
    const vis = v3(150, 0, 24);
    st.time += 0.1;
    SV_MonsterTick(st, vis, trace, null, mulberry32(3), { sightTrace: trace });
    // now blind (blocked sight): the goal is the last sighting, not the player.
    const blocked: TraceFn = (s, _m, _x, e) => ({
      fraction: 0.5,
      endpos: v3((s[0]! + e[0]!) / 2, (s[1]! + e[1]!) / 2, (s[2]! + e[2]!) / 2),
      planeNormal: v3(-1, 0, 0),
      allsolid: false,
      startsolid: false,
      entityNum: 0,
      contents: 1,
    });
    const hidden = v3(150, 150, 24);
    const goal = pursueGoal(st, m, hidden, false, blocked, 10);
    expect(goal[0]).toBeCloseTo(150, 9);
    expect(goal[1]).toBeCloseTo(0, 9);
    expect(m.state.lostSight).toBe(true);
  });

  it('separation nudges crowded packmates sideways, alternately', () => {
    resetEdictNums();
    const st = SV_Init();
    const a = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 24));
    SV_SpawnMonster(st, 'monster_soldier', v3(20, 0, 24));
    const goal = v3(200, 0, 24);
    const nudged = separationOffset(st, a, goal);
    // lateral (y) offset of 32u; parity of the edict num picks the side.
    expect(Math.abs(nudged[1]! - goal[1]!)).toBe(32);
    expect(nudged[0]).toBe(goal[0]);
    // alone: no nudge.
    resetEdictNums();
    const st2 = SV_Init();
    const solo = SV_SpawnMonster(st2, 'monster_soldier', v3(0, 0, 24));
    expect(separationOffset(st2, solo, goal)).toBe(goal);
  });
});

describe('sight delay + burst refire at the tick level', () => {
  it('fresh acquire holsters attacks until reactionAt (skill-scaled)', () => {
    resetEdictNums();
    const st = SV_Init(); // skill 1: 1.0s delay
    const trace = floorTrace();
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 24));
    m.seen = false; // lump-style: acquire on first sight
    m.state.yaw = 0;
    const player = v3(200, 0, 24);
    st.time += 0.1;
    SV_MonsterTick(st, player, trace, null, () => 0, { sightTrace: trace });
    expect(m.seen).toBe(true);
    const readyAt = m.reactionAt;
    expect(readyAt).toBeCloseTo(st.time + 1.0, 9);
    // attack rolls of 0 still holstered before the delay expires.
    let fires = 0;
    for (let i = 0; i < 5; i++) {
      st.time += 0.1;
      fires += SV_MonsterTick(st, player, trace, null, () => 0, { sightTrace: trace }).length;
    }
    expect(st.time).toBeLessThan(readyAt);
    expect(fires).toBe(0);
    // past the delay the same rolls fire.
    for (let i = 0; i < 30 && fires === 0; i++) {
      st.time += 0.1;
      fires += SV_MonsterTick(st, player, trace, null, () => 0, { sightTrace: trace }).length;
    }
    expect(fires).toBeGreaterThan(0);
  });

  it('woken bodies stamp the delay on the next tick (use carries no clock)', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 24));
    m.triggered = true;
    m.woken = false;
    SV_UseMonster(m, true);
    expect(m.reactionAt).toBe(-1);
    st.time += 0.1;
    SV_MonsterTick(st, v3(100, 0, 24), floorTrace(), null, () => 0.99, { sightTrace: floorTrace() });
    expect(m.reactionAt).toBeCloseTo(st.time + 1.0, 9);
  });

  it('combat-hold monsters plant and still fire when visible', () => {
    resetEdictNums();
    const st = SV_Init();
    const trace = floorTrace();
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 24));
    m.seen = true;
    m.combatHold = true; // arrived at a hold point
    m.state.yaw = 0;
    const player = v3(300, 0, 24);
    // run move would walk; hold keeps the stand pose while engaging.
    const before = [...m.edict.origin];
    for (let i = 0; i < 5; i++) {
      st.time += 0.1;
      SV_MonsterTick(st, player, trace, null, () => 0.99, { sightTrace: trace });
    }
    expect(m.state.move).toBe('stand1');
    expect([...m.edict.origin]).toEqual(before);
    // ...but a firing roll still enters the attack (hold fires, never chases).
    st.time += 0.1;
    SV_MonsterTick(st, player, trace, null, () => 0, { sightTrace: trace });
    expect(m.state.move === 'attack1' || m.state.move === 'attack2').toBe(true);
  });
});
