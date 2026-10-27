// Infantry combat sim (m_infantry.c), sky-hit silent free (g_weapon.c
// blaster_touch), Machinegun_Fire kick walk (p_weapon.c) and melee/grenade
// sound names (m_infantry.c, m_gunner.c) — server-side pins.
import { describe, expect, it } from 'vitest';
import {
  GUNNER_GRENADE_SOUND,
  INFANTRY_GUN_SOUND,
  INFANTRY_MELEE_SOUND,
  MONSTER_HULL_MAXS,
  MONSTER_HULL_MINS,
  MONSTER_MELEE_SOUND_ALIAS,
  SURF_SKY,
  mulberry32,
  resetEdictNums,
} from '@q2/game';
import type { TraceFn } from '@q2/game';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  MASK_OPAQUE_C,
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
