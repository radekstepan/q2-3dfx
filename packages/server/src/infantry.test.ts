// Infantry combat sim (m_infantry.c), sky-hit silent free (g_weapon.c
// blaster_touch), Machinegun_Fire kick walk (p_weapon.c) and melee/grenade
// sound names (m_infantry.c, m_gunner.c) — server-side pins.
import { describe, expect, it } from 'vitest';
import {
  GUNNER_GRENADE_SOUND,
  INFANTRY_C,
  INFANTRY_COCK_SOUND,
  INFANTRY_GUN_SOUND,
  INFANTRY_MELEE_SOUND,
  MONSTER_HULL_MAXS,
  MONSTER_HULL_MINS,
  MONSTER_MELEE_SOUND_ALIAS,
  MZ2_INFANTRY_MACHINEGUN_1,
  MZ2_INFANTRY_MACHINEGUN_2,
  SURF_SKY,
  infantryDeathSprayAngles,
  monsterFlashOffset,
  monsterPain,
  mulberry32,
  projectSource,
  resetEdictNums,
} from '@q2/game';
import type { TraceFn } from '@q2/game';
import { AngleVectors, v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  MASK_OPAQUE_C,
  SERVER_ENEMY_TRACER_LENGTH,
  SV_DamageMonster,
  SV_Init,
  SV_MonsterTick,
  SV_PlayerFire,
  SV_SetSkill,
  SV_SpawnEntities,
  SV_SpawnMonster,
  SV_Tick,
  dmOnlyInSP,
  inhibitedBySkill,
  monsterKindOf,
} from './index.js';
import type { SVGameTick } from './index.js';

/** Open-room stub: every trace free, never startsolid. */
function openTrace(surfaceFlags = 0): TraceFn {
  return (start: Vec3, _mins: Vec3, _maxs: Vec3, end: Vec3) => ({
    fraction: 1,
    endpos: v3(end[0], end[1], end[2]),
    planeNormal: v3(0, 0, 1),
    allsolid: false,
    startsolid: false,
    entityNum: -1,
    contents: 0,
    surfaceFlags,
  });
}

/** Fully blocked stub: every trace reports a mid-segment wall hit. */
function blockedTrace(surfaceFlags = 0): TraceFn {
  return (start: Vec3, _mins: Vec3, _maxs: Vec3, end: Vec3) => ({
    fraction: 0.5,
    endpos: v3(
      (start[0]! + end[0]!) / 2,
      (start[1]! + end[1]!) / 2,
      (start[2]! + end[2]!) / 2,
    ),
    planeNormal: v3(-1, 0, 0),
    allsolid: false,
    startsolid: false,
    entityNum: 0,
    contents: 1,
    surfaceFlags,
  });
}

/** Open room with a floor at z = -mins.z (hull-aware: monsters rest at z=24). */
function floorTrace(): TraceFn {
  return (start: Vec3, mins: Vec3, _maxs: Vec3, end: Vec3) => {
    const plane = -mins[2]!;
    if (start[2]! >= plane && end[2]! >= plane) {
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
    }
    if (start[2]! >= plane) {
      const f = (start[2]! - plane) / (start[2]! - end[2]!);
      return {
        fraction: Math.max(0, Math.min(1, f)),
        endpos: v3(
          start[0]! + (end[0]! - start[0]!) * f,
          start[1]! + (end[1]! - start[1]!) * f,
          plane,
        ),
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
      startsolid: true,
      entityNum: -1,
      contents: 0,
      surfaceFlags: 0,
    };
  };
}

function playerAt(x: number, y = 0, z = 24): SVGameTick['player'] {
  return {
    pos: v3(x, y, z),
    mins: v3(-16, -16, -24),
    maxs: v3(16, 16, 32),
    view: 22,
  };
}

describe('infantry sim (m_infantry.c lite def)', () => {
  it('monsterKindOf maps monster_infantry onto the lite def', () => {
    expect(monsterKindOf('monster_infantry')).toBe('infantry');
    expect(monsterKindOf('monster_soldier')).toBe('soldier');
    expect(monsterKindOf('monster_gunner')).toBe('gunner');
    expect(monsterKindOf('monster_berserk')).toBeNull();
  });

  it('synthetic infantry spawns simulated: 100hp, thinks, chases, fires', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
    expect(m.kind).toBe('infantry');
    expect(m.state.health).toBe(100);
    expect(m.state.move).toBe('stand');
    // Player at 300u with open LOS, facing the player: the chase plants
    // the attack1 machinegun strafe (FacingIdeal gate needs ±45°).
    m.state.yaw = 0;
    const trace = openTrace();
    let fired = false;
    for (let i = 0; i < 40 && !fired; i++) {
      st.time += 0.1; // direct ticks advance the 10Hz clock (SV_Tick live)
      for (const ev of SV_MonsterTick(st, playerAt(300).pos, trace, null, mulberry32(i + 1))) {
        if (ev.attack === 'machinegun' && ev.move === 'attack1') fired = true;
      }
    }
    expect(fired).toBe(true);
    // The strafe resolves through the infantry bullet table with the real
    // gun sound (infatck1.wav), never the legacy placeholder.
    resetEdictNums();
    const st2 = SV_Init();
    const m2 = SV_SpawnMonster(st2, 'monster_infantry', v3(0, 0, 24));
    m2.state.yaw = 0;
    m2.state.move = 'attack1';
    m2.state.frame = 10; // InfantryMachineGun frame (attak111)
    SV_Tick(st2, 0.1, { player: playerAt(300), trace, rand: mulberry32(7) });
    const names = st2.sounds.map((s) => s.name);
    expect(names).toContain(INFANTRY_GUN_SOUND);
    expect(names).not.toContain(MONSTER_MELEE_SOUND_ALIAS);
  });

  it('ambush infantry holds until LOS latches, then closes like soldier', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
    m.ambush = true;
    m.seen = false;
    const blocked = blockedTrace();
    const at0 = [...m.edict.origin];
    for (let i = 0; i < 5; i++) {
      st.time += 0.1; // direct ticks advance the 10Hz clock (SV_Tick live)
      SV_MonsterTick(st, playerAt(300).pos, blocked, null, mulberry32(i));
    }
    expect(m.seen).toBe(false);
    expect([...m.edict.origin]).toEqual(at0);
    expect(m.state.move).toBe('stand');
    // LOS opens: seen latches on the first tick, then it closes in run.
    const open = openTrace();
    SV_MonsterTick(st, playerAt(300).pos, open, null, mulberry32(99));
    expect(m.seen).toBe(true);
    const d0 = Math.hypot(m.edict.origin[0]! - 300, m.edict.origin[1]!);
    for (let i = 0; i < 30; i++) {
      st.time += 0.1; // direct ticks advance the 10Hz clock (SV_Tick live)
      SV_MonsterTick(st, playerAt(300).pos, open, null, () => 0.99);
    }
    const d1 = Math.hypot(m.edict.origin[0]! - 300, m.edict.origin[1]!);
    expect(d1).toBeLessThan(d0 - 5);
  });

  it('infantry climbs stairs via the same SV_movestep wrapper as soldier', () => {
    // Floor z=0 for x<0, step deck z=18 for x>=0 (hull-origin rest 24/42).
    const ground = (x: number): number => (x < 0 ? 0 : 18);
    const trace: TraceFn = (start: Vec3, mins: Vec3, _maxs: Vec3, end: Vec3) => {
      const rest = (x: number): number => ground(x) + 24;
      const dz = end[2]! - start[2]!;
      if (Math.abs(dz) < 1e-9) {
        const crosses = start[0]! < 0 !== end[0]! < 0;
        if (crosses && start[2]! + mins[2]! < 18) {
          const f = (0 - start[0]!) / (end[0]! - start[0]!);
          return { fraction: f, endpos: v3(0, start[1], start[2]), planeNormal: v3(-1, 0, 0), allsolid: false, startsolid: false, entityNum: 0, contents: 1 };
        }
        return { fraction: 1, endpos: v3(end[0], end[1], end[2]), planeNormal: v3(0, 0, 1), allsolid: false, startsolid: false, entityNum: 0, contents: 0 };
      }
      const r = rest(end[0]!);
      if (start[2]! <= r && end[2]! <= r) {
        return { fraction: 0, endpos: v3(start[0], start[1], start[2]), planeNormal: v3(0, 0, 1), allsolid: false, startsolid: true, entityNum: 0, contents: 1 };
      }
      if (end[2]! >= r) {
        return { fraction: 1, endpos: v3(end[0], end[1], end[2]), planeNormal: v3(0, 0, 1), allsolid: false, startsolid: false, entityNum: 0, contents: 0 };
      }
      const f = (start[2]! - r) / (start[2]! - end[2]!);
      return { fraction: f, endpos: v3(end[0], end[1], r), planeNormal: v3(0, 0, 1), allsolid: false, startsolid: false, entityNum: 0, contents: 1 };
    };
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(-60, 0, 24));
    m.state.yaw = 0;
    const player = playerAt(120, 0, 42);
    // 0.99 never commits to an attack, so every tick is pure chase
    // locomotion up the same stair wrapper soldiers use.
    for (let i = 0; i < 40; i++) {
      st.time += 0.1; // direct ticks advance the 10Hz clock (SV_Tick live)
      SV_MonsterTick(st, player.pos, trace, null, () => 0.99);
    }
    // Crossed the riser and settled onto the deck (rest 42), not wedged.
    expect(m.edict.origin[0]!).toBeGreaterThan(0);
    expect(m.edict.origin[2]!).toBeCloseTo(42, 6);
  });

  it('infantry gibs at -40 through the shared gib-first path', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
    expect(SV_DamageMonster(st, m, 200, mulberry32(3))).toBe('gib');
    expect(m.state.gibbed).toBe(true);
    expect(st.sounds.map((s) => s.name)).toContain('misc/udeath.wav');
    expect(st.gibs.length).toBeGreaterThan(0);
  });
});

describe('melee/grenade sound names (m_infantry.c, m_gunner.c)', () => {
  it('infantry smack resolves 5+(rand%5) with melee2.wav, never the placeholder', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
    m.state.yaw = 0;
    m.state.move = 'attack2';
    m.state.frame = 5; // infantry_smack frame
    const before = st.playerHealth;
    SV_Tick(st, 0.1, { player: playerAt(50), trace: openTrace(), rand: mulberry32(11) });
    const dealt = before - st.playerHealth;
    expect(dealt).toBeGreaterThanOrEqual(5);
    expect(dealt).toBeLessThanOrEqual(9);
    const names = st.sounds.map((s) => s.name);
    expect(names).toContain(INFANTRY_MELEE_SOUND);
    expect(names).not.toContain(MONSTER_MELEE_SOUND_ALIAS);
  });

  it('soldier/gunner point-blank events resolve as gunfire (C melee is NULL)', () => {
    for (const [classname, move, frame, sound] of [
      ['monster_soldier', 'attack1', 2, 'soldier/solatck1.wav'],
      ['monster_gunner', 'attack_chain', 0, 'gunner/gunatck2.wav'],
    ] as Array<[string, string, number, string]>) {
      resetEdictNums();
      const st = SV_Init();
      const m = SV_SpawnMonster(st, classname, v3(0, 0, 24));
      m.state.yaw = 0;
      m.state.move = move;
      m.state.frame = frame;
      SV_Tick(st, 0.1, { player: playerAt(50), trace: openTrace(), rand: mulberry32(5) });
      const names = st.sounds.map((s) => s.name);
      expect(names).toContain(sound);
      expect(names).not.toContain(MONSTER_MELEE_SOUND_ALIAS);
      expect(names).not.toContain(INFANTRY_MELEE_SOUND);
    }
  });

  it('gunner grenade frames emit the C grenade fire sound', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_gunner', v3(0, 0, 24));
    m.state.yaw = 0;
    m.state.move = 'attack_grenade';
    m.state.frame = 7; // C grenade frame (attak108)
    SV_Tick(st, 0.1, { player: playerAt(300), trace: openTrace(), rand: mulberry32(21) });
    expect(st.sounds.map((s) => s.name)).toContain(GUNNER_GRENADE_SOUND);
    expect(GUNNER_GRENADE_SOUND).toBe('gunner/gunatck3.wav');
  });
});

describe('sky-hit silent free (g_weapon.c blaster_touch)', () => {
  function skyGame(surfaceFlags: number | undefined): { st: ReturnType<typeof SV_Init>; game: SVGameTick } {
    const st = SV_Init();
    st.bolts.push({
      pos: v3(0, 0, 100),
      dir: v3(1, 0, 0),
      life: 2,
      damage: 10,
      speed: 1000,
      foe: false,
      born: 0,
    });
    const trace: TraceFn = (start: Vec3, _mins: Vec3, _maxs: Vec3, end: Vec3) => ({
      fraction: 0.5,
      endpos: v3(
        (start[0]! + end[0]!) / 2,
        (start[1]! + end[1]!) / 2,
        (start[2]! + end[2]!) / 2,
      ),
      planeNormal: v3(-1, 0, 0),
      allsolid: false,
      startsolid: false,
      entityNum: 0,
      contents: 1,
      ...(surfaceFlags === undefined ? {} : { surfaceFlags }),
    });
    return { st, game: { player: playerAt(9000), trace, rand: mulberry32(2) } };
  }

  it('a sky-flagged trace frees the bolt with zero explosions/sparks/sounds', () => {
    const { st, game } = skyGame(SURF_SKY);
    SV_Tick(st, 0.1, game);
    expect(st.bolts).toHaveLength(0);
    expect(st.explosions).toHaveLength(0);
    expect(st.sparks).toHaveLength(0);
    expect(st.sounds).toHaveLength(0);
    expect(st.muzzles).toHaveLength(0);
    expect(st.tracers).toHaveLength(0);
  });

  it('control: the same hit without the sky flag detonates (flash + sparks + sound)', () => {
    for (const flags of [0, undefined]) {
      const { st, game } = skyGame(flags);
      SV_Tick(st, 0.1, game);
      expect(st.bolts).toHaveLength(0);
      expect(st.explosions).toHaveLength(1);
      expect(st.explosions[0]!.kind).toBe('blaster');
      expect(st.sparks.length).toBeGreaterThan(0);
      expect(st.sounds.map((s) => s.name)).toContain('weapons/lashit.wav');
    }
  });
});

describe('machinegun kick walk in SV_PlayerFire (p_weapon.c)', () => {
  it('latches shots 0..9 with per-shot kick vectors', () => {
    resetEdictNums();
    const st = SV_Init();
    let shots = 0;
    let prevAngles: Vec3 | null = null;
    for (let pull = 0; pull < 12; pull++) {
      const res = SV_PlayerFire(st, 'weapon_machinegun', {
        eye: v3(0, 0, 46),
        feet: v3(0, 0, 24),
        angles: v3(0, 0, 0),
        viewheight: 22,
        ammo: 50,
        trace: openTrace(),
        rand: mulberry32(100 + pull),
        machinegunShots: shots,
      });
      expect(res.fired).toBe(true);
      const want = Math.min(shots + 1, 9);
      expect(res.machinegunShots).toBe(want);
      expect(res.kickOrigin).toBeDefined();
      expect(res.kickAngles).toBeDefined();
      // pitch kick grows with the pre-trigger burst: shots * -1.5.
      expect(res.kickAngles![0]).toBeCloseTo(shots * -1.5, 5);
      if (prevAngles) expect([...res.kickAngles!]).not.toEqual([...prevAngles]);
      prevAngles = res.kickAngles!;
      shots = res.machinegunShots!;
    }
    expect(shots).toBe(9);
  });

  it('unfired and non-machinegun shots echo the counter with no kick', () => {
    resetEdictNums();
    const st = SV_Init();
    const dry = SV_PlayerFire(st, 'weapon_machinegun', {
      eye: v3(0, 0, 46),
      feet: v3(0, 0, 24),
      angles: v3(0, 0, 0),
      viewheight: 22,
      ammo: 0, // no ammo: no fire, counter echoes
      trace: openTrace(),
      rand: mulberry32(1),
      machinegunShots: 4,
    });
    expect(dry.fired).toBe(false);
    expect(dry.machinegunShots).toBe(4);
    expect(dry.kickOrigin).toBeUndefined();
    const shell = SV_PlayerFire(st, 'weapon_shotgun', {
      eye: v3(0, 0, 46),
      feet: v3(0, 0, 24),
      angles: v3(0, 0, 0),
      viewheight: 22,
      ammo: 50,
      trace: openTrace(),
      rand: mulberry32(2),
    });
    expect(shell.fired).toBe(true);
    expect(shell.machinegunShots).toBe(0);
    expect(shell.kickOrigin).toBeUndefined();
  });
});

describe('infantry spin/cock combat loop (m_infantry.c cock_gun + fire + death2)', () => {
  it('attack1 pass: cock sound arms the burst, then N>1 fire events at 10Hz cadence', () => {
    // C order (m_infantry.c): infantry_cock_gun at attak104 (spin/crank,
    // infatck3.wav, pausetime = level.time + ((rand&15)+3+7) * FRAMETIME =
    // 1.0-2.5s), then infantry_fire at attak111 (single aimed bullet) with
    // AI_HOLD_FRAME (g_monster.c M_MoveFrame) re-firing the frozen frame
    // every 0.1s until the pausetime expires. The tick owns the C loop:
    // the cock frame emits the sound + arms, the fire frame freezes and
    // re-emits (gated by the same canSee rule as live fire).
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
    m.state.yaw = 0;
    m.state.move = 'attack1';
    m.state.frame = 0;
    const trace = openTrace();
    const fired: number[] = [];
    const tickOf: number[] = [];
    let firstFireTime = -1;
    for (let i = 0; i < 40; i++) {
      st.time += 0.1; // direct ticks advance the 10Hz clock (SV_Tick live)
      for (const ev of SV_MonsterTick(st, playerAt(300).pos, trace, null, () => 0.99)) {
        if (ev.move === 'attack1') {
          expect(ev.attack).toBe('machinegun');
          fired.push(ev.frame);
          tickOf.push(i);
          if (firstFireTime < 0) firstFireTime = st.time;
        }
      }
    }
    // rand 0.99: cock n = 10 + floor(0.99*16) = 25 frames (2.5s); the fire
    // frame (7 frames after the cock) holds for the remainder, firing
    // through the expiry tick like C (thinkfunc tail): n-6 = 19
    // single-bullet rounds, all on the C fire frame (attak111, md2 194).
    expect(fired).toHaveLength(19);
    expect(fired.every((f) => f === 10)).toBe(true);
    // 10Hz cadence: one round per consecutive tick.
    for (let k = 1; k < tickOf.length; k++) expect(tickOf[k]! - tickOf[k - 1]!).toBe(1);
    expect(tickOf[0]).toBe(10); // first shot on the attak111 pass
    // The cock armed the hold (pausetime in the future at the fire frame).
    expect(m.burstUntil).toBeGreaterThan(0);
    // ... and the cock sound preceded the first shot (anim-committed C:
    // the move was entered with LOS, so the cock always plays).
    const cocks = st.sounds.filter((s) => s.name === INFANTRY_COCK_SOUND);
    expect(cocks).toHaveLength(1);
    expect(cocks[0]!.born).toBeLessThan(firstFireTime);
  });

  it('attack1 fire frame resolves one C bullet (muzzle + tracer + infatck1)', () => {
    // The resolved volley carries the C ballistics: muzzle + tracer +
    // infatck1.wav through the skin-gun pipeline.
    resetEdictNums();
    const st2 = SV_Init();
    const m2 = SV_SpawnMonster(st2, 'monster_infantry', v3(0, 0, 24));
    m2.state.yaw = 0;
    m2.state.move = 'attack1';
    m2.state.frame = 10;
    const trace = openTrace();
    SV_Tick(st2, 0.1, { player: playerAt(300), trace, rand: () => 0.99 });
    expect(st2.muzzles.filter((z) => z.foe)).toHaveLength(1);
    expect(st2.tracers).toHaveLength(1);
    expect(st2.sounds.map((s) => s.name)).toContain(INFANTRY_GUN_SOUND);
    expect(st2.playerHealth).toBe(100); // 0.99 never beats pHit: no damage
    // C muzzle: attak111 always fires flash MZ2_INFANTRY_MACHINEGUN_1
    // (m_flash.c [26.6, 7.1, 13.1]) off the live body yaw — never the
    // frozen hold-frame index as a flash row (that parked the muzzle ~16u
    // forward / ~8u sideways / ~12u up at flash 36).
    const fwd = v3();
    const right = v3();
    AngleVectors(v3(0, m2.state.yaw, 0), fwd, right);
    // Post-tick body pose: locomotion steps the attack frame's dist before
    // the resolver runs, so the muzzle keys off the live origin.
    const wantMuzzle = projectSource(
      v3(m2.edict.origin[0], m2.edict.origin[1], m2.edict.origin[2]),
      monsterFlashOffset(MZ2_INFANTRY_MACHINEGUN_1),
      fwd,
      right,
    );
    const mz = st2.muzzles.find((z) => z.foe)!;
    expect(mz.pos[0]!).toBeCloseTo(wantMuzzle[0]!, 9);
    expect(mz.pos[1]!).toBeCloseTo(wantMuzzle[1]!, 9);
    expect(mz.pos[2]!).toBeCloseTo(wantMuzzle[2]!, 9);
    // The tracer is a short muzzle-origin streak toward the player hull:
    // same origin, aimed (not eye-ending — length 48 << the ~300u gap).
    const t = st2.tracers[0]!;
    expect(t.origin[0]!).toBeCloseTo(wantMuzzle[0]!, 9);
    expect(t.origin[1]!).toBeCloseTo(wantMuzzle[1]!, 9);
    expect(t.origin[2]!).toBeCloseTo(wantMuzzle[2]!, 9);
    expect(t.length).toBe(SERVER_ENEMY_TRACER_LENGTH);
    expect(t.color).toBe(225);
    const eye = v3(300, 0, 24 + 22);
    const wantDir = v3(eye[0]! - wantMuzzle[0]!, eye[1]! - wantMuzzle[1]!, eye[2]! - wantMuzzle[2]!);
    const wl = Math.hypot(wantDir[0]!, wantDir[1]!, wantDir[2]!) || 1;
    const tl = Math.hypot(t.dir[0]!, t.dir[1]!, t.dir[2]!) || 1;
    expect(t.dir[0]! / tl).toBeCloseTo(wantDir[0]! / wl, 9);
    expect(t.dir[1]! / tl).toBeCloseTo(wantDir[1]! / wl, 9);
    expect(t.dir[2]! / tl).toBeCloseTo(wantDir[2]! / wl, 9);
    const gap = Math.hypot(eye[0]! - t.origin[0]!, eye[1]! - t.origin[1]!, eye[2]! - t.origin[2]!);
    expect(t.length).toBeLessThan(gap);
  });

  it('burst tracers originate at the live muzzle every 10Hz tick', () => {
    // Sustained-fire hold (AI_HOLD_FRAME): one bullet per tick through the
    // expiry tick. Every round's tracer must leave the CURRENT gun muzzle
    // (frozen holds fire in place now — C M_MoveFrame runs the aifunc with
    // dist 0, so the origin only moves on non-hold frames) — never a stale
    // first-tick origin, never more than one round per tick, never the
    // cock frame (no fabricated bullet). Floored trace (combat.test.ts
    // pattern): the stub floor holds the body at z=24 so the C dist>1000
    // resolver cutoff never trips mid-burst.
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
    m.state.yaw = 0;
    m.state.move = 'attack1';
    m.state.frame = 0;
    const game = { player: playerAt(300), trace: floorTrace(), rand: () => 0.99 };
    // Run the full attack1 pass + hold (40 ticks cover the 2.5s max hold).
    const origins: Vec3[] = [];
    let rounds = 0;
    for (let i = 0; i < 40; i++) {
      SV_Tick(st, 0.1, game);
      // At most one bullet per tick — the hold never fans.
      expect(st.tracers.length).toBeLessThanOrEqual(1);
      if (st.tracers.length === 1) {
        rounds++;
        const t = st.tracers[0]!;
        // Live muzzle for THIS tick's body pose (yaw may have turned,
        // origin stepped — recompute, don't reuse tick 0).
        const fwd = v3();
        const right = v3();
        AngleVectors(v3(0, m.state.yaw, 0), fwd, right);
        const want = projectSource(
          v3(m.edict.origin[0], m.edict.origin[1], m.edict.origin[2]),
          monsterFlashOffset(MZ2_INFANTRY_MACHINEGUN_1),
          fwd,
          right,
        );
        expect(t.origin[0]!).toBeCloseTo(want[0]!, 9);
        expect(t.origin[1]!).toBeCloseTo(want[1]!, 9);
        expect(t.origin[2]!).toBeCloseTo(want[2]!, 9);
        expect(t.length).toBe(SERVER_ENEMY_TRACER_LENGTH);
        origins.push(v3(t.origin[0], t.origin[1], t.origin[2]));
        st.tracers.length = 0; // drain per tick: the queue never accumulates
      } else {
        st.tracers.length = 0;
      }
    }
    // rand 0.99 → 19 single-bullet rounds (n-6, see the pass test above).
    expect(rounds).toBe(19);
    // The streak never ends at the eye: length 48 << muzzle→eye gap.
    const eye = v3(300, 0, 24 + 22);
    for (const o of origins) {
      const gap = Math.hypot(eye[0]! - o[0]!, eye[1]! - o[1]!, eye[2]! - o[2]!);
      expect(SERVER_ENEMY_TRACER_LENGTH).toBeLessThan(gap);
    }
  });

  it('death2 spray: InfantryMachineGun on death211-222 (md2 155-166)', () => {
    // "Off with his head" (m_infantry.c death211-222): the corpse sprays 12
    // blind rounds. death1/death3 frames are all NULL and stay silent.
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(200, 0, 24));
    expect(monsterPain(m.state, 120, mulberry32(3))).toBe('dead');
    expect(m.state.dead).toBe(true);
    expect(m.state.gibbed).toBe(false);
    m.state.move = 'death2';
    m.state.frame = 0;
    const trace = openTrace();
    const fired: number[] = [];
    for (let t = 0; t < 30; t++) {
      st.time += 0.1;
      for (const ev of SV_MonsterTick(st, playerAt(0).pos, trace, null, mulberry32(t))) {
        expect(ev.attack).toBe('machinegun');
        expect(ev.move).toBe('death2');
        fired.push(ev.frame);
      }
    }
    expect(fired).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  });

  it('death spray resolves to foe tracers + muzzles + infatck1 + C damage', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(200, 0, 24));
    expect(monsterPain(m.state, 120, mulberry32(3))).toBe('dead');
    m.state.move = 'death2';
    m.state.frame = 0;
    const before = st.playerHealth;
    // Floor under the fall: the fully-open stub has no ground, and the dead
    // branch now runs gravity (id ai_move + M_walkmove ground handling) —
    // without a floor the body would probe-fall 50u/tick and take the spray
    // with it. Rest z at the 24 spawn height like the other floor suites.
    const floor: TraceFn = (start, mins, maxs, end) => {
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
      return openTrace()(start, mins, maxs, end);
    };
    // Muzzle basis per spray round: the dying body slides its death2 dists
    // (id ai_move runs inside every death frame), so each round leaves the
    // gun where the body stands that tick — not the kill spot. The dead
    // branch steps dist[pre] then advances to pre+1 (the event frame), so
    // rounds (event frames 10-21) ride the post-step origin of pre 9-20.
    const muzzleBases: Vec3[] = [];
    for (let t = 0; t < 30; t++) {
      const f = m.state.frame;
      SV_Tick(st, 0.1, { player: playerAt(0), trace: floor, rand: () => 0 });
      if (f >= 9 && f <= 20) muzzleBases.push(v3(m.edict.origin[0], m.edict.origin[1], m.edict.origin[2]));
    }
    expect(muzzleBases).toHaveLength(12);
    // The fall travels (death2 opens 0,1,5,-1,...): the spray walks with it.
    expect(muzzleBases[0]![0]).not.toBeCloseTo(200, 9);
    // Unconditional like C (no LOS gate): all 12 rounds leave the gun.
    expect(st.muzzles.filter((z) => z.foe)).toHaveLength(12);
    expect(st.tracers).toHaveLength(12);
    expect(st.sounds.filter((s) => s.name === INFANTRY_GUN_SOUND)).toHaveLength(12);
    // rand 0 always beats pHit: 12 hits x INFANTRY_C.bulletDamage (3).
    expect(st.playerHealth).toBe(before - 12 * INFANTRY_C.bulletDamage);
    expect(st.playerHealth).toBe(before - 36);
    // C flash walk (m_infantry.c death211-222): round i leaves flash
    // MZ2_INFANTRY_MACHINEGUN_2+i — the corpse's own MD2 rows, never the
    // attack1 gun flash and never a wraparound.
    const fwd = v3();
    const right = v3();
    AngleVectors(v3(0, m.state.yaw, 0), fwd, right);
    expect(m.state.yaw).toBe(0); // corpses never turn: the yaw basis is fixed
    const foes = st.muzzles.filter((z) => z.foe);
    for (let i = 0; i < 12; i++) {
      const want = projectSource(muzzleBases[i]!, monsterFlashOffset(MZ2_INFANTRY_MACHINEGUN_2 + i), fwd, right);
      expect(foes[i]!.pos[0]!).toBeCloseTo(want[0]!, 9);
      expect(foes[i]!.pos[1]!).toBeCloseTo(want[1]!, 9);
      expect(foes[i]!.pos[2]!).toBeCloseTo(want[2]!, 9);
      // The tracer shares the round's muzzle and flies the blind spray
      // (angles - aimangles[]), not at the player hull.
      const t = st.tracers[i]!;
      expect(t.origin[0]!).toBeCloseTo(want[0]!, 9);
      expect(t.origin[1]!).toBeCloseTo(want[1]!, 9);
      expect(t.origin[2]!).toBeCloseTo(want[2]!, 9);
      const sprayFwd = v3();
      AngleVectors(infantryDeathSprayAngles(0, 10 + i), sprayFwd);
      const sl = Math.hypot(sprayFwd[0]!, sprayFwd[1]!, sprayFwd[2]!) || 1;
      const tl = Math.hypot(t.dir[0]!, t.dir[1]!, t.dir[2]!) || 1;
      expect(t.dir[0]! / tl).toBeCloseTo(sprayFwd[0]! / sl, 9);
      expect(t.dir[1]! / tl).toBeCloseTo(sprayFwd[1]! / sl, 9);
      expect(t.dir[2]! / tl).toBeCloseTo(sprayFwd[2]! / sl, 9);
      expect(t.length).toBe(SERVER_ENEMY_TRACER_LENGTH);
    }
    // Blind, not aimed: the opening round sprays downrange (+X, away from
    // the player at the origin) instead of tracking the hull.
    const eye = v3(0, 0, 24 + 22);
    const t0 = st.tracers[0]!;
    const eyeDir = v3(eye[0]! - t0.origin[0]!, eye[1]! - t0.origin[1]!, eye[2]! - t0.origin[2]!);
    const el = Math.hypot(eyeDir[0]!, eyeDir[1]!, eyeDir[2]!) || 1;
    const tl0 = Math.hypot(t0.dir[0]!, t0.dir[1]!, t0.dir[2]!) || 1;
    const dot = (t0.dir[0]! / tl0) * (eyeDir[0]! / el) + (t0.dir[1]! / tl0) * (eyeDir[1]! / el) + (t0.dir[2]! / tl0) * (eyeDir[2]! / el);
    expect(dot).toBeLessThan(0.5);
  });
});

describe('DM-only items stay out of SP (g_spawn.c skill inhibit)', () => {
  const TEXT = [
    '{"classname" "worldspawn"}',
    '{"classname" "weapon_machinegun" "origin" "0 0 0" "spawnflags" "1792"}',
    '{"classname" "item_quad" "origin" "10 0 0" "spawnflags" "1792"}',
    '{"classname" "ammo_bullets" "origin" "20 0 0" "spawnflags" "1792"}',
    '{"classname" "item_health" "origin" "30 0 0"}',
    '{"classname" "weapon_shotgun" "origin" "40 0 0" "spawnflags" "2048"}',
  ].join('\n');

  it('dmOnlyInSP pins 1792 (NOT_EASY|NOT_MEDIUM|NOT_HARD) and nothing else', () => {
    expect(dmOnlyInSP(1792)).toBe(true);
    expect(dmOnlyInSP(0)).toBe(false);
    expect(dmOnlyInSP(2048)).toBe(false);
    expect(dmOnlyInSP(256)).toBe(false);
    // inhibitedBySkill matches the C g_spawn.c SP branch exactly.
    expect(inhibitedBySkill(1792, 0)).toBe(true);
    expect(inhibitedBySkill(1792, 1)).toBe(true);
    expect(inhibitedBySkill(1792, 2)).toBe(true);
    expect(inhibitedBySkill(1792, 3)).toBe(true);
    expect(inhibitedBySkill(2048, 1)).toBe(false); // NOT_DEATHMATCH: DM branch only
  });

  it('1792-spawnflags items are absent from the world at skills 0-3', () => {
    for (const skill of [0, 1, 2, 3]) {
      resetEdictNums();
      const st = SV_Init();
      SV_SetSkill(st, skill);
      const edicts = SV_SpawnEntities(st, TEXT);
      const names = edicts.map((e) => e.classname);
      expect(names).not.toContain('weapon_machinegun');
      expect(names).not.toContain('item_quad');
      expect(names).not.toContain('ammo_bullets');
      // SP-kept controls: plain items always spawn, NOT_DEATHMATCH spawns
      // outside deathmatch (g_spawn.c DM branch checks that bit alone).
      expect(names).toContain('item_health');
      expect(names).toContain('weapon_shotgun');
      // The NOT bits strip after the check, exactly like C.
      for (const e of edicts) expect(e.spawnflags & 1792).toBe(0);
    }
  });
});
