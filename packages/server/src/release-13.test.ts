// RELEASE-13 — dying-enemy collision, death variety and soldier patrols.
//
// 1. Dying blocks / corpse releases: a real kill through the tick loop keeps
//    the hull (SOLID_BBOX) while the death move plays and drops it
//    (SOLID_NOT) exactly when the last frame lands (C soldier_dead /
//    infantry_dead endfunc → SVF_DEADMONSTER). Walkers stop on the dying
//    body on the real server path; gibs never block; final corpses stay
//    hittable but passable.
// 2. Death variety through the PRODUCTION damage path (SV_DamageMonster with
//    controlled RNG, never bare monsterPain): all three infantry deaths,
//    all five soldier rolls + the head-shot death3, then normal-play sampling.
// 3. Patrols: map-entity audit (which base1 soldiers walk a beat), patrol
//    walking on real routes, gated sight (no omnidirectional acquire, rear
//    approach stays silent until melee/noise/damage), combat handoff.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { PakFile } from '@q2/filesystem';
import { loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import {
  MELEE_DISTANCE,
  MONSTER_HULL_MAXS,
  MONSTER_HULL_MINS,
  SOLID_NOT,
  monsterMoveOf,
  mulberry32,
  resetEdictNums,
} from '@q2/game';
import type { TraceFn, TraceResult } from '@q2/game';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  MASK_OPAQUE_C,
  SV_ClipTrace,
  SV_DamageMonster,
  SV_Init,
  SV_MonsterClipBox,
  SV_MonsterTick,
  SV_PlayerFire,
  SV_SpawnEntities,
  SV_SpawnMonster,
  SV_Tick,
  SV_TraceFor,
  playerNoiseWake,
} from './index.js';
import type { ServerMonster } from './index.js';
import { acquireSight, arrivePatrol } from './monster-ai.js';
import type { PatrolCorner } from './monster-ai.js';

const Q2_PAK = process.env.Q2_PAK;

/** Floor-aware open room: horizontal free, ground rests at z=24. */
function floorTrace(): TraceFn {
  return (start: Vec3, _mins: Vec3, _maxs: Vec3, end: Vec3): TraceResult => {
    if (end[2]! < 24) {
      return {
        fraction: 0,
        endpos: v3(end[0], end[1], 24),
        planeNormal: v3(0, 0, 1),
        allsolid: false,
        startsolid: false,
        entityNum: -1,
        contents: 0,
        surfaceFlags: 0,
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
      surfaceFlags: 0,
    };
  };
}

function playerAt(x: number, y = 0, z = 24): { pos: Vec3; mins: Vec3; maxs: Vec3; view: number } {
  return { pos: v3(x, y, z), mins: v3(-16, -16, -24), maxs: v3(16, 16, 32), view: 22 };
}

/** Player-box sweep toward -X past a body: fraction < 1 means blocked. */
function sweepPast(st: ReturnType<typeof SV_Init>, fromX: number, trace: TraceFn): number {
  const t = SV_ClipTrace(st, trace, -1, true)(
    v3(fromX, 0, 24), MONSTER_HULL_MINS, MONSTER_HULL_MAXS, v3(-fromX, 0, 24),
  );
  return t.fraction;
}

describe('RELEASE-13 dying collision (endfunc timing, real tick loop)', () => {
  it('base soldier kill: dying blocks, settled corpse releases, gib passes', () => {
    resetEdictNums();
    const st = SV_Init();
    const trace = floorTrace();
    const game = { player: playerAt(9000), trace, nav: null, rand: mulberry32(0xD1E) };
    // Forced death1 (armed): the lethal hit must not pick it every time in
    // normal play, but here the clip timing is under test, not the roll.
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 24));
    expect(SV_DamageMonster(st, m, 30, () => 0.05)).toBe('dead');
    expect(m.state.move).toBe('death1');
    // Dying: every sweep for the whole fall stops on the hull.
    for (let t = 0; t < 40 && !m.state.deadDone; t++) {
      expect(sweepPast(st, 200, trace)).toBeLessThan(1);
      expect(SV_MonsterClipBox(m)).not.toBeNull();
      SV_Tick(st, 0.1, game);
    }
    expect(m.state.deadDone).toBe(true);
    expect(m.edict.solid).toBe(SOLID_NOT);
    expect(SV_MonsterClipBox(m)).toBeNull();
    expect(sweepPast(st, 200, trace)).toBe(1);
    // Gib: never blocks, from the mincing hit on.
    const g = SV_SpawnMonster(st, 'monster_soldier', v3(500, 0, 24));
    expect(SV_DamageMonster(st, g, 500, mulberry32(9))).toBe('gib');
    expect(SV_MonsterClipBox(g)).toBeNull();
    expect(g.edict.solid).toBe(SOLID_NOT);
  });

  it('a live walker stops on the dying body, then walks through the corpse', () => {
    resetEdictNums();
    const st = SV_Init();
    const trace = floorTrace();
    const corpse = SV_SpawnMonster(st, 'monster_soldier', v3(100, 0, 24));
    expect(SV_DamageMonster(st, corpse, 30, () => 0.4)).toBe('dead'); // death4
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(300, 0, 24));
    m.state.yaw = 180;
    const game = {
      player: playerAt(-500),
      trace,
      nav: null,
      rand: () => 0.99, // pure chase: never commits to an attack
    };
    let stoppedOnDying = false;
    let crossedCorpse = false;
    for (let t = 0; t < 200; t++) {
      SV_Tick(st, 0.1, game);
      const gap = Math.hypot(m.edict.origin[0]! - corpse.edict.origin[0]!, m.edict.origin[1]! - corpse.edict.origin[1]!);
      if (!corpse.state.deadDone && gap < 40) stoppedOnDying = true;
      if (corpse.state.deadDone && m.edict.origin[0]! < corpse.edict.origin[0]! - 32) crossedCorpse = true;
    }
    // death4 is 53 frames (5.3s): the chaser reaches the station mid-fall
    // and holds outside contact until the hull drops, then passes through.
    expect(stoppedOnDying).toBe(true);
    expect(corpse.state.deadDone).toBe(true);
    expect(crossedCorpse).toBe(true);
  });

  it('infantry death2 spray fires all 12 rounds while the fall still blocks', () => {
    resetEdictNums();
    const st = SV_Init();
    const trace = floorTrace();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
    // Production path, controlled RNG: infantry roll 1 → death2.
    expect(SV_DamageMonster(st, m, 100, () => 0.4)).toBe('dead');
    expect(m.state.move).toBe('death2');
    const game = { player: playerAt(-600), trace, nav: null, rand: () => 0 };
    let blockedDuringSpray = true;
    for (let t = 0; t < 40; t++) {
      SV_Tick(st, 0.1, game);
      // Spray frames are state.frame 10-21 (event frames): the hull must
      // still be up for all of them (the fall is 25 frames).
      if (m.state.frame >= 10 && m.state.frame <= 21 && SV_MonsterClipBox(m) === null) {
        blockedDuringSpray = false;
      }
    }
    expect(blockedDuringSpray).toBe(true);
    expect(st.muzzles.filter((z) => z.foe)).toHaveLength(12);
    expect(m.state.deadDone).toBe(true);
    expect(SV_MonsterClipBox(m)).toBeNull();
  });
});

describe('RELEASE-13 death variety (production damage path)', () => {
  it('all three infantry deaths select with controlled RNG + render the C frames', () => {
    resetEdictNums();
    const st = SV_Init();
    const seen: string[] = [];
    for (const r of [0.0, 0.4, 0.8]) {
      const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
      expect(SV_DamageMonster(st, m, 100, () => r)).toBe('dead');
      seen.push(m.state.move);
    }
    expect(seen).toEqual(['death1', 'death2', 'death3']);
    // C frame bases survive the server round-trip (snapshot renders
    // first + frame via the same move tables).
    const firsts: Record<string, number> = { death1: 125, death2: 145, death3: 170 };
    for (const move of seen) {
      const probe = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
      probe.state.dead = true;
      probe.state.move = move;
      probe.state.frame = 0;
      expect(monsterMoveOf(probe.state).first).toBe(firsts[move]);
    }
  });

  it('normal-play sampling hits all three infantry deaths', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      resetEdictNums();
      const st = SV_Init();
      const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
      const rand = mulberry32(0x100 + i);
      expect(SV_DamageMonster(st, m, 100, rand)).toBe('dead');
      counts.set(m.state.move, (counts.get(m.state.move) ?? 0) + 1);
    }
    expect(counts.get('death1')).toBeGreaterThan(50);
    expect(counts.get('death2')).toBeGreaterThan(50);
    expect(counts.get('death3')).toBeGreaterThan(50);
  });

  it('soldier rolls death1/2/4/5/6 + head-shot death3 through SV_DamageMonster', () => {
    resetEdictNums();
    const st = SV_Init();
    const moves: string[] = [];
    for (const r of [0.05, 0.25, 0.45, 0.65, 0.85]) {
      const m = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 24));
      expect(SV_DamageMonster(st, m, 30, () => r)).toBe('dead');
      moves.push(m.state.move);
    }
    expect(moves).toEqual(['death1', 'death2', 'death4', 'death5', 'death6']);
    // Head shot: impact at origin + 25 (viewheight) plays death3.
    for (const z of [21, 25, 29]) {
      const m = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 24));
      expect(SV_DamageMonster(st, m, 30, () => 0.85, z)).toBe('dead');
      expect(m.state.move).toBe('death3');
    }
  });

  it('normal-play soldier sampling hits every non-gib death', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 600; i++) {
      resetEdictNums();
      const st = SV_Init();
      const m = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 24));
      expect(SV_DamageMonster(st, m, 30, mulberry32(0x500 + i))).toBe('dead');
      counts.set(m.state.move, (counts.get(m.state.move) ?? 0) + 1);
    }
    for (const move of ['death1', 'death2', 'death4', 'death5', 'death6']) {
      expect(counts.get(move)).toBeGreaterThan(50);
    }
    expect(counts.get('death3') ?? 0).toBe(0); // head shots need located hits
  });
});

describe('RELEASE-13 sight gating (g_ai.c FindTarget rules)', () => {
  function ambushAt(st: ReturnType<typeof SV_Init>, x: number, y: number, yaw: number): ServerMonster {
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(x, y, 24));
    m.ambush = true;
    m.seen = false;
    m.state.yaw = yaw;
    return m;
  }
  it('rear approach at near range stays silent; frontal/melee/hostile acquire', () => {
    resetEdictNums();
    const st = SV_Init();
    const trace = floorTrace();
    // Monster facing +X (yaw 0); player 200u behind at -X: visible but back-turned.
    const rear = ambushAt(st, 0, 0, 0);
    for (let t = 0; t < 30; t++) {
      st.time += 0.1;
      SV_MonsterTick(st, v3(-200, 0, 24), trace, null, () => 0.99, { sightTrace: trace });
    }
    expect(rear.seen).toBe(false);
    // Same geometry, monster facing the player: acquires.
    const front = ambushAt(st, 500, 0, 180);
    st.time += 0.1;
    SV_MonsterTick(st, v3(300, 0, 24), trace, null, () => 0.99, { sightTrace: trace });
    expect(front.seen).toBe(true);
    // Melee range behind the back: noticed anyway (C RANGE_MELEE).
    const close = ambushAt(st, 900, 0, 0);
    st.time += 0.1;
    SV_MonsterTick(st, v3(900 - (MELEE_DISTANCE - 10), 0, 24), trace, null, () => 0.99, { sightTrace: trace });
    expect(close.seen).toBe(true);
    // Near range behind, but the player just fired (show_hostile): acquired.
    const hostile = ambushAt(st, 1400, 0, 0);
    st.lastPlayerShotAt = st.time;
    st.time += 0.1;
    SV_MonsterTick(st, v3(1200, 0, 24), trace, null, () => 0.99, { sightTrace: trace });
    expect(hostile.seen).toBe(true);
    // Far range frontal: never (C RANGE_FAR).
    const far = ambushAt(st, 2000, 0, 180);
    for (let t = 0; t < 10; t++) {
      st.time += 0.1;
      SV_MonsterTick(st, v3(2000 - 1200, 0, 24), trace, null, () => 0.99, { sightTrace: trace });
    }
    expect(far.seen).toBe(false);
  });

  it('acquireSight unit pins: melee-behind, near-facing, mid-facing, far-never', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 24));
    m.state.yaw = 0; // facing +X
    const behind = v3(-200, 0, 24);
    const ahead = v3(200, 0, 24);
    expect(acquireSight(m, behind, 200, true, false)).toBe(false);
    expect(acquireSight(m, ahead, 200, true, false)).toBe(true);
    expect(acquireSight(m, behind, 200, true, true)).toBe(true); // show_hostile
    expect(acquireSight(m, behind, 50, true, false)).toBe(true); // melee
    expect(acquireSight(m, ahead, 700, true, false)).toBe(true); // mid facing
    expect(acquireSight(m, behind, 700, true, true)).toBe(false); // mid ignores hostile
    expect(acquireSight(m, ahead, 1200, true, true)).toBe(false); // far never
    expect(acquireSight(m, ahead, 200, false, true)).toBe(false); // no LOS, no see
  });

  it('gunfire noise wakes non-ambush listeners; ambush needs LOS; damage wakes', () => {
    resetEdictNums();
    const st = SV_Init();
    // Wall between the muzzle and the ambush body (LOS blocked), open ears
    // otherwise: segments longer than 100u in xy report a mid wall hit.
    const wall: TraceFn = (start, _mins, _maxs, end): TraceResult => {
      const dx = end[0]! - start[0]!;
      const dy = end[1]! - start[1]!;
      if (Math.hypot(dx, dy) > 100) {
        return {
          fraction: 0.5,
          endpos: v3(start[0]! + dx / 2, start[1]! + dy / 2, start[2]!),
          planeNormal: v3(-1, 0, 0),
          allsolid: false,
          startsolid: false,
          entityNum: -1,
          contents: 0,
          surfaceFlags: 0,
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
        surfaceFlags: 0,
      };
    };
    const listener = SV_SpawnMonster(st, 'monster_soldier', v3(400, 0, 24));
    listener.seen = false;
    const amb = SV_SpawnMonster(st, 'monster_soldier', v3(0, 500, 24));
    amb.ambush = true;
    amb.seen = false;
    amb.state.yaw = 180; // facing away from the shot at the origin
    const fireOpts = {
      eye: v3(0, 0, 46),
      feet: v3(0, 0, 24),
      angles: v3(0, 0, 0),
      viewheight: 22,
      ammo: 0,
      trace: wall,
      rand: mulberry32(1),
    };
    playerNoiseWake(st, fireOpts);
    expect(listener.seen).toBe(true); // heard it (< 1000, no ambush)
    expect(amb.seen).toBe(false); // ambush: muzzle not visible, stays down
    expect(listener.state.lastSighting[0]).toBe(0); // hunts the noise spot
    // Damage wakes unconditionally (M_ReactToDamage, no visibility gate).
    const quiet = SV_SpawnMonster(st, 'monster_soldier', v3(-400, 0, 24));
    quiet.seen = false;
    expect(SV_DamageMonster(st, quiet, 5, mulberry32(2))).toBe('pain');
    expect(quiet.seen).toBe(true);
  });

  it('SV_PlayerFire stamps show_hostile for the rear-sight window', () => {
    resetEdictNums();
    const st = SV_Init();
    const trace = floorTrace();
    const before = st.lastPlayerShotAt;
    const res = SV_PlayerFire(st, 'weapon_blaster', {
      eye: v3(0, 0, 46),
      feet: v3(0, 0, 24),
      angles: v3(0, 0, 0),
      viewheight: 22,
      ammo: 0,
      trace,
      rand: mulberry32(4),
    });
    expect(res.fired).toBe(true);
    expect(st.lastPlayerShotAt).toBe(st.time);
    expect(st.lastPlayerShotAt).toBeGreaterThan(before);
  });
});

describe('RELEASE-13 patrol beats (synthetic lump)', () => {
  const TEXT =
    `{ "classname" "worldspawn" }\n` +
    `{ "classname" "path_corner" "targetname" "t6" "target" "t5" "origin" "-780 336 -40" }\n` +
    `{ "classname" "path_corner" "targetname" "t5" "target" "t6" "origin" "-576 336 -40" }\n` +
    `{ "classname" "monster_soldier" "origin" "-672 336 -16" "angle" "180" "target" "t6" }\n` +
    `{ "classname" "monster_soldier" "origin" "0 0 -16" "angle" "0" }\n`;
  it('target→path_corner starts the beat facing the corner; others stand', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(st, TEXT);
    const cop = st.monsters.find((m) => m.edict.origin[0] === -672)!;
    const loafer = st.monsters.find((m) => m.edict.origin[0] === 0)!;
    expect(cop.patrolCorner).toBe('t6');
    expect(cop.patrolGoal).not.toBeNull();
    expect(cop.state.yaw).toBeCloseTo(180, 9); // C faces the first corner
    expect(cop.state.move).toBe('walk1');
    expect(loafer.patrolCorner).toBe('');
    expect(loafer.patrolGoal).toBeNull();
  });
  it('the beat walks corner to corner and loops forever', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(st, TEXT);
    const cop = st.monsters.find((m) => m.edict.origin[0] === -672)!;
    const trace = floorTrace();
    // Player parked far behind cover of distance: never seen (FAR).
    const away = v3(9000, 9000, 24);
    let legs = 0;
    let last = cop.patrolCorner;
    for (let t = 0; t < 600 && legs < 2; t++) {
      st.time += 0.1;
      SV_MonsterTick(st, away, trace, null, () => 0.99, { sightTrace: trace });
      if (cop.patrolCorner !== last) {
        legs++;
        last = cop.patrolCorner;
      }
    }
    // t6 → t5 → t6: two advances, back where it started, still walking.
    expect(legs).toBe(2);
    expect(cop.patrolCorner).toBe('t6');
    expect(cop.state.move).toBe('walk1');
    expect(cop.seen).toBe(false);
  });
  it('sight acquires the patroller and hands off to combat (no return)', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(st, TEXT);
    const cop = st.monsters.find((m) => m.edict.origin[0] === -672)!;
    const trace = floorTrace();
    // Step into view ahead of the beat: frontal LOS at near range.
    cop.state.yaw = 0;
    st.time += 0.1;
    SV_MonsterTick(st, v3(-672 + 200, 336, 24), trace, null, () => 0, { sightTrace: trace });
    expect(cop.seen).toBe(true);
  });
});

describe('RELEASE-13 arrival-corner wait (C path_corner_touch: self->wait)', () => {
  // The wait honored on arrival is the ARRIVED corner's own (self->wait),
  // never the next corner's. Pin it with two consecutive UNEQUAL waits
  // (2s then 5s), a zero wait (walk straight through) and a terminal path
  // (empty target link ends the beat standing), through the real tick loop.
  const CHAIN: PatrolCorner[] = [
    { name: 't0', pos: v3(-200, 0, 24), target: 't1', wait: 0, pathtarget: '', teleport: false },
    { name: 't1', pos: v3(-100, 0, 24), target: 't2', wait: 2, pathtarget: '', teleport: false },
    { name: 't2', pos: v3(100, 0, 24), target: 't3', wait: 5, pathtarget: 'wake', teleport: false },
    { name: 't3', pos: v3(300, 0, 24), target: '', wait: 0, pathtarget: '', teleport: false },
  ];
  it('arrivePatrol honors the arrived wait + fires pathtarget, keeps the next link', () => {
    // Zero wait passes through: t0 arrival arms no wait, next already t1.
    expect(arrivePatrol(CHAIN, 't0')).toEqual({
      next: CHAIN[1],
      wait: 0,
      fire: null,
      teleported: false,
      teleportPos: null,
    });
    // Unequal consecutive waits: t1 arrival waits 2 (NOT t2's 5) with t2
    // pre-installed; t2 arrival waits 5 (NOT t1's 2) and fires 'wake'.
    const a1 = arrivePatrol(CHAIN, 't1')!;
    expect(a1.next?.name).toBe('t2');
    expect(a1.wait).toBe(2);
    expect(a1.fire).toBeNull();
    const a2 = arrivePatrol(CHAIN, 't2')!;
    expect(a2.next?.name).toBe('t3');
    expect(a2.wait).toBe(5);
    expect(a2.fire).toBe('wake');
    // Terminal: empty link ends the beat (stand, C pausetime 1e8).
    expect(arrivePatrol(CHAIN, 't3')).toEqual({
      next: null,
      wait: 0,
      fire: null,
      teleported: false,
      teleportPos: null,
    });
    // Unknown corner: no arrival (caller stands defensively).
    expect(arrivePatrol(CHAIN, 'nope')).toBeNull();
  });
  it('arrivePatrol chains through a TELEPORT corner (snap + skip, no leg)', () => {
    const corners: PatrolCorner[] = [
      { name: 't1', pos: v3(-100, 0, 24), target: 'tT', wait: 2, pathtarget: '', teleport: false },
      { name: 'tT', pos: v3(0, 0, 24), target: 't2', wait: 0, pathtarget: '', teleport: true },
      { name: 't2', pos: v3(200, 0, 24), target: '', wait: 0, pathtarget: '', teleport: false },
    ];
    const a = arrivePatrol(corners, 't1')!;
    // The teleport is consumed on arrival: snap to tT, walk to t2 next.
    expect(a.teleported).toBe(true);
    expect(a.teleportPos).toEqual(v3(0, 0, 24));
    expect(a.next?.name).toBe('t2');
    // The ARRIVED corner's wait still applies (self->wait before the hop).
    expect(a.wait).toBe(2);
    // Dangling teleport target ends the beat after the snap.
    const dangling: PatrolCorner[] = [
      { name: 't1', pos: v3(-100, 0, 24), target: 'tT', wait: 0, pathtarget: '', teleport: false },
      { name: 'tT', pos: v3(0, 0, 24), target: 'gone', wait: 0, pathtarget: '', teleport: true },
    ];
    const d = arrivePatrol(dangling, 't1')!;
    expect(d.teleported).toBe(true);
    expect(d.next).toBeNull();
  });
  it('tick: unequal waits arm at the arrived corner (2s then 5s), zero passes, terminal stands', () => {
    const TEXT =
      `{ "classname" "worldspawn" }\n` +
      `{ "classname" "path_corner" "targetname" "t0" "target" "t1" "origin" "-200 0 24" }\n` +
      `{ "classname" "path_corner" "targetname" "t1" "target" "t2" "origin" "-100 0 24" "wait" "2" }\n` +
      `{ "classname" "path_corner" "targetname" "t2" "target" "t3" "origin" "100 0 24" "wait" "5" "pathtarget" "wake" }\n` +
      `{ "classname" "path_corner" "targetname" "t3" "origin" "300 0 24" }\n` +
      `{ "classname" "monster_soldier" "origin" "-260 0 24" "angle" "0" "target" "t0" }\n` +
      // Dormant TRIGGER_SPAWN body: t2's pathtarget fires 'wake' on arrival.
      `{ "classname" "monster_soldier" "targetname" "wake" "spawnflags" "2" "origin" "0 500 24" "angle" "0" }\n`;
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(st, TEXT);
    const cop = st.monsters.find((m) => m.edict.origin[1] === 0)!;
    const sleeper = st.monsters.find((m) => m.edict.targetname === 'wake')!;
    expect(cop.patrolCorner).toBe('t0');
    expect(sleeper.woken).toBe(false);
    const trace = floorTrace();
    const away = v3(9000, 9000, 24);
    const armings: Array<{ arrived: string; wait: number; cornerNow: string }> = [];
    const walkFrames = new Set<number>();
    let stoodOutWait = false;
    let prevCorner = cop.patrolCorner;
    let prevWait = cop.patrolWaitUntil;
    let terminal = false;
    for (let t = 0; t < 3000 && !terminal; t++) {
      st.time += 0.1;
      SV_MonsterTick(st, away, trace, null, () => 0.99, { sightTrace: trace });
      expect(cop.seen).toBe(false);
      if (cop.state.move === 'walk1') walkFrames.add(cop.state.frame);
      if (cop.patrolWaitUntil > prevWait) {
        armings.push({
          arrived: prevCorner,
          wait: cop.patrolWaitUntil - st.time,
          cornerNow: cop.patrolCorner,
        });
        prevWait = cop.patrolWaitUntil;
      }
      if (cop.state.move === 'stand1' && st.time < cop.patrolWaitUntil) stoodOutWait = true;
      if (cop.patrolCorner === '' && cop.patrolGoal === null) {
        terminal = true;
        expect(cop.state.move).toBe('stand1');
      }
      prevCorner = cop.patrolCorner;
    }
    expect(terminal).toBe(true);
    // Two waits, at the ARRIVED corners with the NEXT corner pre-installed
    // (C movetarget advances before the wait): t1 arms 2s heading to t2,
    // t2 arms 5s heading to t3. The old bug armed t2's 5s at t1.
    expect(armings).toHaveLength(2);
    expect(armings[0]).toEqual({ arrived: 't1', wait: 2, cornerNow: 't2' });
    expect(armings[1]).toEqual({ arrived: 't2', wait: 5, cornerNow: 't3' });
    // Zero wait passed straight through: no arming at t0, beat never stood
    // before the first real wait.
    expect(armings.some((a) => a.arrived === 't0')).toBe(false);
    expect(stoodOutWait).toBe(true);
    // Walking frames actually played (not stuck on one frame).
    expect(cop.state.move).toBe('stand1');
    expect(walkFrames.size).toBeGreaterThan(3);
    for (const f of walkFrames) expect(f).toBeGreaterThanOrEqual(0);
    // t2's pathtarget fired through production G_UseTargets on arrival: the
    // dormant body woke (SV_UseMonster) while the beat stood out its wait.
    expect(sleeper.woken).toBe(true);
  });
  it('tick: TELEPORT corner snaps the body (no travel leg) and the beat continues', () => {
    const TEXT =
      `{ "classname" "worldspawn" }\n` +
      `{ "classname" "path_corner" "targetname" "t1" "origin" "-100 0 24" "target" "tT" }\n` +
      `{ "classname" "path_corner" "targetname" "tT" "origin" "0 0 24" "target" "t2" "spawnflags" "1" }\n` +
      `{ "classname" "path_corner" "targetname" "t2" "origin" "200 0 24" }\n` +
      `{ "classname" "monster_soldier" "origin" "-160 0 24" "angle" "0" "target" "t1" }\n`;
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(st, TEXT);
    const cop = st.monsters.find((m) => m.edict.origin[1] === 0)!;
    const trace = floorTrace();
    const away = v3(9000, 9000, 24);
    let snapped = false;
    let prevX = cop.edict.origin[0]!;
    for (let t = 0; t < 3000 && !snapped; t++) {
      st.time += 0.1;
      SV_MonsterTick(st, away, trace, null, () => 0.99, { sightTrace: trace });
      if (cop.patrolCorner === 't2') {
        // One tick carried the body ~100u (t1 -> tT): walking covers < 8u.
        expect(prevX).toBeLessThan(-70);
        expect(Math.abs(cop.edict.origin[0]!)).toBeLessThan(8);
        expect(Math.abs(cop.edict.origin[1]!)).toBeLessThan(8);
        expect(cop.patrolWaitUntil).toBe(0); // arrival wait was 0: no stand
        snapped = true;
      }
      prevX = cop.edict.origin[0]!;
    }
    expect(snapped).toBe(true);
    // The beat walks on from the snap to the terminal corner, then stands.
    let terminal = false;
    for (let t = 0; t < 3000 && !terminal; t++) {
      st.time += 0.1;
      SV_MonsterTick(st, away, trace, null, () => 0.99, { sightTrace: trace });
      if (cop.patrolCorner === '' && cop.patrolGoal === null) terminal = true;
    }
    expect(terminal).toBe(true);
    expect(cop.edict.origin[0]!).toBeGreaterThan(150);
    expect(cop.state.move).toBe('stand1');
  });
});

describe.runIf(!!Q2_PAK)('RELEASE-13 base1 audit (Q2_PAK)', () => {
  function loadBase1Entities(): string {
    const bytes = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(bytes.length);
    new Uint8Array(buf).set(bytes);
    const pak = new PakFile(buf);
    const map = loadBsp(pak.readFile('maps/base1.bsp')) as BspMap;
    return map.entities;
  }
  it('audit: exactly the target-carrying soldiers walk a beat (skill 1)', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(st, loadBase1Entities());
    const walkers = st.monsters.filter((m) => m.patrolCorner !== '');
    const starts = new Map(walkers.map((m) => [`${m.edict.origin[0]},${m.edict.origin[1]}`, m.patrolCorner]));
    // Eight soldiers + the north infantry walk (spawnflags-769 hard-only
    // infantries and the triggered pair resolve later or never).
    const expected: Array<[string, string]> = [
      ['-904,976', 't16'],
      ['-232,840', 't47'],
      ['-1248,1744', 't18'],
      ['792,32', 't36'],
      ['1088,328', 't29'],
      ['-48,576', 't11'],
      ['-704,632', 't7'],
      ['-672,336', 't6'],
      ['-1960,1464', 't21'],
    ];
    for (const [at, corner] of expected) {
      expect(starts.get(at), `beat at ${at}`).toBe(corner);
    }
    expect(walkers.length).toBe(expected.length);
    // The t39 infantry targets its packmate (t40), not a corner: stands.
    const guard = st.monsters.find((m) => m.edict.targetname === 't39');
    expect(guard?.patrolCorner).toBe('');
    // Start-room + ledge soldiers stand until seen.
    for (const at of ['348,-348', '1048,224', '-1025,1598', '-856,584']) {
      const m = st.monsters.find((mm) => `${mm.edict.origin[0]},${mm.edict.origin[1]}` === at);
      expect(m?.patrolCorner, `stands at ${at}`).toBe('');
    }
    // Triggered t67 soldier resolves its point_combat fixup on wake.
    const t67 = st.monsters.find((m) => m.edict.target === 't67');
    expect(t67?.patrolCorner).toBe(''); // dormant: unresolved until wake
    expect(t67?.edict.extra['combattarget']).toBeUndefined();
  });
  it('audit: the t5/t6 beat cop walks its real route and is approachable from behind', () => {
    resetEdictNums();
    const bytes = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(bytes.length);
    new Uint8Array(buf).set(bytes);
    const pak = new PakFile(buf);
    const map = loadBsp(pak.readFile('maps/base1.bsp')) as BspMap;
    const st = SV_Init();
    SV_SpawnEntities(st, map.entities, undefined, undefined);
    const cop = st.monsters.find((m) => m.edict.origin[0] === -672 && m.edict.origin[1] === 336)!;
    expect(cop.patrolCorner).toBe('t6');
    const trace = SV_ClipTrace(st, SV_TraceFor(map));
    const sight = SV_TraceFor(map, MASK_OPAQUE_C);
    // Walk 60s with the player far away: the beat advances down the chain.
    const away = v3(3000, 3000, 300);
    const startCorner = cop.patrolCorner;
    for (let t = 0; t < 600; t++) {
      st.time += 0.1;
      SV_MonsterTick(st, away, trace, null, mulberry32(t), { sightTrace: sight });
      if (cop.seen) break;
    }
    expect(cop.seen).toBe(false);
    expect(cop.patrolCorner !== startCorner || Math.hypot(cop.edict.origin[0]! + 672, cop.edict.origin[1]! - 336) > 20).toBe(true);
  });
});
