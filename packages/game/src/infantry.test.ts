// INFANTRY lite def (m_infantry.c port) + Machinegun_Fire kick walk +
// melee/grenade sound pins. Frame numbers are MD2 FRAME_* (m_infantry.h),
// dists are the per-frame ai_* values from m_infantry.c.
import { describe, expect, it } from 'vitest';
import {
  INFANTRY,
  INFANTRY_C,
  INFANTRY_GIB_HEALTH,
  INFANTRY_GUN_SOUND,
  INFANTRY_HP,
  INFANTRY_MELEE_SOUND,
  GUNNER_GRENADE_SOUND,
  MACHINEGUN_KICK_MAX_SHOTS,
  MONSTER_YAW_SPEED,
  MONSTER_HULL_MAXS,
  MONSTER_HULL_MINS,
  MELEE_DISTANCE,
  attackMoveFor,
  infantryCockBurstFrames,
  infantryMeleeDamage,
  machinegunKick,
  monsterChaseMove,
  monsterDef,
  monsterFrameNumber,
  monsterLocomotion,
  monsterMoveOf,
  monsterPain,
  monsterRange,
  monsterThink,
  monsterYawTo,
  selectAttack,
  spawnMonster,
  traceHitSky,
  MONSTER_MELEE_SOUND_ALIAS,
  mulberry32,
} from './index.js';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';

function trivialNav(selfPos: Vec3, playerPos: Vec3) {
  return {
    graph: new Map<number, number[]>([
      [0, [1]],
      [1, [0]],
    ]),
    positions: new Map<number, Vec3>([
      [0, v3(selfPos[0], selfPos[1], selfPos[2])],
      [1, v3(playerPos[0], playerPos[1], playerPos[2])],
    ]),
  };
}

/** Open-room trace: everything free, floor rest at z = 24 (hull origin). */
function openTrace() {
  return (start: Vec3, _e: Vec3) => {
    void _e;
    return { fraction: 1, endpos: v3(start[0], start[1], start[2]) };
  };
}

describe('INFANTRY lite def (m_infantry.c)', () => {
  it('carries the C spawn contract: 100hp / gib -40 / mass 200', () => {
    expect(INFANTRY.classname).toBe('monster_infantry');
    expect(INFANTRY.health).toBe(100);
    expect(INFANTRY.gibHealth).toBe(-40);
    expect(INFANTRY.mass).toBe(200);
    expect(INFANTRY_HP).toBe(100);
    expect(INFANTRY_GIB_HEALTH).toBe(-40);
    expect(INFANTRY.health).toBe(INFANTRY_C.health);
    expect(INFANTRY.gibHealth).toBe(INFANTRY_C.gibHealth);
    expect(INFANTRY.mass).toBe(INFANTRY_C.mass);
    expect(MONSTER_YAW_SPEED.infantry).toBe(20);
  });

  it('move tables match the C frame ranges and per-frame dists', () => {
    const dists = (name: string): number[] => INFANTRY.moves[name]!.frames.map((f) => f.dist);
    const firstLast = (name: string): [number, number] => {
      const m = INFANTRY.moves[name]!;
      return [m.first, m.last];
    };
    // C mmove_t bounds (m_infantry.c): stand50-71, walk walk03-14 (74-85),
    // run01-08 (92-99), pain101-110 (100-109), pain201-210 (110-119),
    // duck01-05 (120-124), death101-120 (125-144), death201-225 (145-169),
    // death301-309 (170-178), attak101-115 (184-198), attak201-208 (199-206).
    expect(firstLast('stand')).toEqual([50, 71]);
    expect(dists('stand')).toEqual(new Array(22).fill(0));
    expect(firstLast('walk')).toEqual([74, 85]);
    expect(dists('walk')).toEqual([5, 4, 4, 5, 4, 5, 6, 4, 4, 4, 4, 5]);
    expect(firstLast('run')).toEqual([92, 99]);
    expect(dists('run')).toEqual([10, 20, 5, 7, 30, 35, 2, 6]);
    expect(firstLast('pain1')).toEqual([100, 109]);
    expect(dists('pain1')).toEqual([-3, -2, -1, -2, -1, 1, -1, 1, 6, 2]);
    expect(firstLast('pain2')).toEqual([110, 119]);
    expect(dists('pain2')).toEqual([-3, -3, 0, -1, -2, 0, 0, 2, 5, 2]);
    expect(firstLast('duck')).toEqual([120, 124]);
    expect(dists('duck')).toEqual([-2, -5, 3, 4, 0]);
    expect(firstLast('death1')).toEqual([125, 144]);
    expect(dists('death1')).toEqual([-4, 0, 0, -1, -4, 0, 0, 0, -1, 3, 1, 1, -2, 2, 2, 9, 9, 5, -3, -3]);
    expect(firstLast('death2')).toEqual([145, 169]);
    expect(dists('death2')).toEqual([0, 1, 5, -1, 0, 1, 1, 4, 3, 0, -2, -2, -3, -1, -2, 0, 2, 2, 3, -10, -7, -8, -6, 4, 0]);
    expect(firstLast('death3')).toEqual([170, 178]);
    expect(dists('death3')).toEqual([0, 0, 0, -6, -11, -3, -11, 0, 0]);
    // attack1 (machinegun): cock at frame 4 (attak104 = md2 187,
    // infantry_cock_gun spin + sound_weapon_cock), single InfantryMachineGun
    // fire at frame 11 (attak111 = md2 194); attack2 (melee): swing at
    // frame 3 (attak203 = md2 201, infatck2.wav, no damage), smack at
    // frame 6 (attak206 = md2 204, infantry_smack).
    expect(firstLast('attack1')).toEqual([184, 198]);
    expect(dists('attack1')).toEqual([4, -1, -1, 0, -1, 1, 1, 2, -2, -3, 1, 5, -1, -2, -3]);
    const a1 = INFANTRY.moves['attack1']!.frames;
    expect(a1.filter((f) => f.action === 'fire')).toHaveLength(1);
    expect(a1[3]!.action).toBe('cock');
    expect(a1[10]!.action).toBe('fire');
    expect(firstLast('attack2')).toEqual([199, 206]);
    expect(dists('attack2')).toEqual([3, 6, 0, 8, 5, 8, 6, 3]);
    const a2 = INFANTRY.moves['attack2']!.frames;
    expect(a2[2]!.action).toBe('swing');
    expect(a2[5]!.action).toBe('melee');
    // death2 (md2 145-169, "Off with his head"): C arms InfantryMachineGun
    // on death211-222 (md2 155-166 = lite indices 10-21); death1/death3 are
    // all NULL in C and stay all-'move'.
    const d2 = INFANTRY.moves['death2']!.frames;
    expect(d2.filter((f) => f.action === 'fire')).toHaveLength(12);
    for (let i = 0; i < 25; i++) {
      expect(d2[i]!.action).toBe(i >= 10 && i <= 21 ? 'fire' : 'move');
    }
    for (const name of ['death1', 'death3']) {
      expect(INFANTRY.moves[name]!.frames.every((f) => f.action === 'move')).toBe(true);
    }
    // ends chain back to run/stand (lite: no AI_HOLD_FRAME re-fire loop).
    for (const [name, end] of [['stand', 'stand'], ['walk', 'walk'], ['run', 'run'], ['attack1', 'run'], ['attack2', 'run'], ['pain1', 'run'], ['pain2', 'run'], ['duck', 'run']] as Array<[string, string]>) {
      expect(INFANTRY.moves[name]!.end).toBe(end);
    }
  });

  it('attack1 walks cock (md2 187) then fire (md2 194); death2 sprays md2 155-166', () => {
    // Full attack1 pass through monsterThink: the spin/crank precedes the
    // shot, exactly like the C frame order (cock_gun attak104, fire
    // attak111). monsterFrameNumber reports the rendered MD2 frame.
    const ms = spawnMonster('infantry');
    ms.move = 'attack1';
    ms.frame = 0;
    const actions: string[] = [];
    for (let i = 0; i < 15; i++) actions.push(monsterThink(ms));
    expect(actions[3]).toBe('cock');
    expect(actions[10]).toBe('fire');
    expect(actions.filter((a) => a === 'fire')).toHaveLength(1);
    expect(actions.filter((a) => a === 'cock')).toHaveLength(1);
    const cock = spawnMonster('infantry');
    cock.move = 'attack1';
    cock.frame = 3;
    expect(monsterFrameNumber(cock)).toBe(187); // FRAME_attak104
    const fire = spawnMonster('infantry');
    fire.move = 'attack1';
    fire.frame = 10;
    expect(monsterFrameNumber(fire)).toBe(194); // FRAME_attak111
    // Melee wind-up order: swing (attak203) before smack (attak206).
    const sw = spawnMonster('infantry');
    sw.move = 'attack2';
    sw.frame = 0;
    const melee: string[] = [];
    for (let i = 0; i < 8; i++) melee.push(monsterThink(sw));
    expect(melee[2]).toBe('swing');
    expect(melee[5]).toBe('melee');
    // Death-spray window: md2 155-166 = FRAME_death211-222.
    const d2 = spawnMonster('infantry');
    d2.move = 'death2';
    d2.frame = 10;
    expect(monsterFrameNumber(d2)).toBe(155); // FRAME_death211
    d2.frame = 21;
    expect(monsterFrameNumber(d2)).toBe(166); // FRAME_death222
  });

  it('every move fits inside the infantry MD2 (206 frames)', () => {
    for (const mv of Object.values(INFANTRY.moves)) {
      expect(mv.last).toBeLessThanOrEqual(206);
      expect(mv.last - mv.first + 1).toBe(mv.frames.length);
    }
  });

  it('spawns at full HP on stand, def/move/frame wiring resolves', () => {
    const ms = spawnMonster('infantry');
    expect(ms.kind).toBe('infantry');
    expect(ms.health).toBe(100);
    expect(ms.move).toBe('stand');
    expect(monsterDef('infantry')).toBe(INFANTRY);
    expect(monsterMoveOf(ms).name).toBe('stand');
    expect(monsterFrameNumber(ms)).toBe(50);
    // attack latch membership: attack moves hold to completion in chase.
    ms.move = 'attack1';
    ms.frame = 0;
    expect(monsterMoveOf(ms).first).toBe(184);
  });

  it('selectAttack/attackMoveFor follow m_infantry.c infantry_attack', () => {
    const rand = mulberry32(0x11);
    expect(monsterRange(50)).toBe(0);
    expect(selectAttack('infantry', 50, rand)).toBe('melee');
    for (const dist of [MELEE_DISTANCE, 200, 500, 999]) {
      expect(selectAttack('infantry', dist, rand)).toBe('machinegun');
    }
    expect(selectAttack('infantry', 1500, rand)).toBe('none');
    expect(attackMoveFor('infantry', 'melee')).toBe('attack2');
    expect(attackMoveFor('infantry', 'machinegun')).toBe('attack1');
    expect(attackMoveFor('infantry', 'shotgun')).toBe('attack1');
    expect(attackMoveFor('infantry', 'none')).toBe('run');
  });

  it('monsterPain gibs at -40 and spreads deaths across death1/2/3', () => {
    const gibbed = spawnMonster('infantry');
    expect(monsterPain(gibbed, 200, mulberry32(1))).toBe('gib');
    expect(gibbed.gibbed).toBe(true);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const ms = spawnMonster('infantry');
      // 120 dmg: kills (100hp) but stops short of the -40 gib line.
      expect(monsterPain(ms, 120, mulberry32(seed))).toBe('dead');
      seen.add(ms.move);
    }
    // C infantry_die: n = rand() % 3 across the three death moves.
    expect([...seen].sort()).toEqual(['death1', 'death2', 'death3']);
  });

  it('cock burst window is C AI_HOLD_FRAME: ((rand&15)+3+7) frames', () => {
    // m_infantry.c infantry_cock_gun: n = (rand() & 15) + 3 + 7 -> 10-25
    // frames of 0.1s. The fire frame plays 7 frames after the cock, so the
    // hold re-fires 3-18 single bullets.
    for (let seed = 0; seed < 200; seed++) {
      const n = infantryCockBurstFrames(mulberry32(seed));
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(10);
      expect(n).toBeLessThanOrEqual(25);
    }
    expect(infantryCockBurstFrames(() => 0)).toBe(10);
    expect(infantryCockBurstFrames(() => 0.99999)).toBe(25);
  });

  it('chase closes in run, plants the machinegun strafe at range, smacks in melee', () => {
    const self = v3(0, 0, 24);
    const far = v3(300, 0, 24);
    const ms = spawnMonster('infantry');
    ms.yaw = monsterYawTo(self, far);
    const r1 = monsterChaseMove(ms, self, far, trivialNav(self, far), true, () => 0);
    expect(r1.move).toBe('attack1');
    expect(ms.move).toBe('attack1');
    // out of range with no sight: closes along the graph in run.
    const ms2 = spawnMonster('infantry');
    const away = v3(1500, 0, 24);
    const r2 = monsterChaseMove(ms2, self, away, trivialNav(self, away), false, () => 0.99);
    expect(r2.move).toBe('run');
    expect(r2.path).not.toBeNull();
    // melee range: commits to the smack.
    const ms3 = spawnMonster('infantry');
    ms3.yaw = monsterYawTo(self, v3(50, 0, 24));
    monsterChaseMove(ms3, self, v3(50, 0, 24), trivialNav(self, v3(50, 0, 24)), true, () => 0);
    expect(ms3.move).toBe('attack2');
  });

  it('locomotion walks the run dist toward the player like soldier/gunner', () => {
    const ms = spawnMonster('infantry');
    ms.move = 'run';
    ms.frame = 1; // dist 20 frame
    ms.yaw = 0;
    const origin = v3(0, 0, 24);
    // gravity leg needs a floor: stub rests at z=24, free horizontally.
    const trace = (s: Vec3, e: Vec3) => {
      if (Math.abs(e[2]! - s[2]!) < 1e-9) return { fraction: 1, endpos: v3(e[0], e[1], e[2]) };
      return { fraction: 0, endpos: v3(s[0], s[1], 24) };
    };
    monsterLocomotion(ms, origin, v3(100, 0, 24), trace);
    expect(origin[0]!).toBeCloseTo(20, 9);
    expect(origin[2]!).toBe(24);
  });
});

describe('Machinegun_Fire kick walk (p_weapon.c)', () => {
  it('walks crandom jitter + growing pitch kick, clamps shots at 9', () => {
    // C rand order: kick_origin[1,2], kick_angles[1,2], kick_origin[0].
    const seq = [0.0, 0.25, 0.5, 0.75, 1.0];
    let i = 0;
    const rand = (): number => seq[(i++) % seq.length]!;
    const k = machinegunKick(0, rand);
    // crandom = 2r-1 consumes [-1, -0.5, 0, 0.5, 1]: oy=-0.35, oz=-0.175,
    // ay=0, az=0.35, ox=+0.35 (Float32 storage — compare via v3).
    expect([...k.kickOrigin]).toEqual([...v3(0.35, -0.35, -0.175)]);
    for (const [got, want] of [[k.kickAngles[0]!, 0], [k.kickAngles[1]!, 0], [k.kickAngles[2]!, 0.35]] as Array<[number, number]>) {
      expect(got).toBeCloseTo(want, 6);
    }
    expect(k.shots).toBe(1);
    // pitch kick grows with the held burst: shots * -1.5.
    const k2 = machinegunKick(4, mulberry32(9));
    expect(k2.kickAngles[0]).toBe(-6);
    expect(k2.shots).toBe(5);
    // clamp: 9 stays 9 (the gun is fully raised).
    const k3 = machinegunKick(9, mulberry32(9));
    expect(k3.shots).toBe(9);
    expect(k3.kickAngles[0]).toBe(-13.5);
    expect(MACHINEGUN_KICK_MAX_SHOTS).toBe(9);
  });

  it('deathmatch never latches the burst counter', () => {
    const k = machinegunKick(3, mulberry32(4), true);
    expect(k.shots).toBe(3);
    expect(k.kickAngles[0]).toBe(-4.5);
  });
});

describe('melee/grenade sound names (m_infantry.c, m_gunner.c)', () => {
  it('infantry melee + gunner grenade resolve to real pak sounds', () => {
    expect(INFANTRY_MELEE_SOUND).toBe('infantry/melee2.wav');
    expect(INFANTRY_GUN_SOUND).toBe('infantry/infatck1.wav');
    expect(GUNNER_GRENADE_SOUND).toBe('gunner/gunatck3.wav');
    // The old lite placeholder has NO pak counterpart (lowercased pak
    // listing has no sound/monster/melee.wav); it stays exported only as
    // the web lane's legacy alias, never emitted by the sim.
    expect(MONSTER_MELEE_SOUND_ALIAS).toBe('monster/melee.wav');
    expect(MONSTER_MELEE_SOUND_ALIAS).not.toBe(INFANTRY_MELEE_SOUND);
  });

  it('infantryMeleeDamage spans fire_hit 5+(rand%5)', () => {
    const vals = new Set<number>();
    for (let seed = 0; seed < 200; seed++) vals.add(infantryMeleeDamage(mulberry32(seed)));
    expect([...vals].sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9]);
    expect(infantryMeleeDamage(() => 0)).toBe(5);
    expect(infantryMeleeDamage(() => 0.9999)).toBe(9);
  });
});

describe('traceHitSky (g_weapon.c blaster_touch gate)', () => {
  it('flags SURF_SKY hits, ignores clean and solid traces', () => {
    expect(traceHitSky({ fraction: 0.5, endpos: v3(), planeNormal: v3(0, 0, 1), allsolid: false, startsolid: false, entityNum: 0, contents: 1, surfaceFlags: 4 })).toBe(true);
    expect(traceHitSky({ fraction: 0.5, endpos: v3(), planeNormal: v3(0, 0, 1), allsolid: false, startsolid: false, entityNum: 0, contents: 1, surfaceFlags: 0 })).toBe(false);
    expect(traceHitSky({ fraction: 1, endpos: v3(), planeNormal: v3(0, 0, 1), allsolid: false, startsolid: false, entityNum: -1, contents: 0 })).toBe(false);
  });
});
