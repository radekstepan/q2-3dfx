// Item pickup gaps + monster solidity + infantry roster + exit-lift audit.
//
// 1. base1 fields item_silencer (flags 0, target t76) and SP-kept
//    ammo_grenades (2048 NOT_DEATHMATCH), but packages/game knew neither, so
//    pickupItem returned picked:false and the driver left them on the floor.
//    Spawned items must also link SOLID_TRIGGER (C droptofloor) with the DM
//    skill inhibit respected (1792-flagged ones never spawn in SP).
// 2. Monsters spawned SOLID_NOT (the spawn never set solid), so the player
//    walked through live bodies. C sets SOLID_BBOX + MOVETYPE_STEP in the
//    SP_ funcs, SOLID_NOT + MOVETYPE_NONE for TRIGGER_SPAWN dormants
//    (monster_triggered_start), SOLID_BBOX on wake (monster_triggered_spawn)
//    and SVF_DEADMONSTER (movement skip) on death. SV_ClipTrace now runs the
//    C SV_ClipMoveToEntities monster pass over the same hulls.
// 3. base1 infantry roster: 2x spawnflags 769 (NOT_EASY|NOT_MEDIUM|ambush)
//    spawn only at skill 2/3; t39 (target t40) + t40 + t21 (flags 1, ambush)
//    always spawn. Killing t39 fires t40 via monster_death_use (alert only —
//    no post-kill spawn).
// 4. Final elevator: *12 func_train (targetname t91, target t88) waits for a
//    use; *13 button (target t91, wait -1) fires it; doors *32 (dangling t75)
//    / *33 (no target) carry no train target, so door-open target fire can
//    never auto-start the lift (C door_go_up G_UseTargets reaches only named
//    entities).
import { describe, expect, it } from 'vitest';
import {
  MONSTER_HULL_MAXS,
  MONSTER_HULL_MINS,
  SOLID_BBOX,
  SOLID_NOT,
  SOLID_TRIGGER,
  mulberry32,
} from '@q2/game';
import type { TraceFn } from '@q2/game';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  SV_ClipTrace,
  SV_DamageMonster,
  SV_Init,
  SV_MonsterClipBox,
  SV_SetSkill,
  SV_SpawnEntities,
  SV_SpawnMonster,
  SV_Tick,
  SV_UseMonster,
  SV_UseMover,
  SV_UseTargetname,
  playerFireSound,
} from './index.js';

/** Open-room stub: every world trace free, never startsolid. */
function openTrace(): TraceFn {
  return (start: Vec3, _mins: Vec3, _maxs: Vec3, end: Vec3) => ({
    fraction: 1,
    endpos: v3(end[0], end[1], end[2]),
    planeNormal: v3(0, 0, 1),
    allsolid: false,
    startsolid: false,
    entityNum: -1,
    contents: 0,
  });
}

const PLAYER_MINS = v3(-16, -16, -24);
const PLAYER_MAXS = v3(16, 16, 32);

describe('item spawn solidity + skill inhibit (g_items.c droptofloor / g_spawn.c)', () => {
  const TEXT = [
    '{"classname" "worldspawn"}',
    // Base1's under-stairs secret silencer (flags 0, fires t76 on take).
    '{"classname" "item_silencer" "origin" "-408 704 -112" "target" "t76"}',
    // SP-kept grenades (NOT_DEATHMATCH spawns outside deathmatch).
    '{"classname" "ammo_grenades" "origin" "1056 888 -216" "spawnflags" "2048"}',
    // DM-only cache rows: never in SP at any skill.
    '{"classname" "ammo_grenades" "origin" "-40 264 -40" "spawnflags" "1792"}',
    '{"classname" "weapon_bfg" "origin" "1072 888 -216" "spawnflags" "1792"}',
    '{"classname" "item_quad" "origin" "-2152 1536 -32" "spawnflags" "1792"}',
  ].join('\n');

  it('SP-kept items spawn SOLID_TRIGGER at skills 0-3, DM-only never spawn', () => {
    for (const skill of [0, 1, 2, 3]) {
      const st = SV_Init();
      SV_SetSkill(st, skill);
      const edicts = SV_SpawnEntities(st, TEXT);
      const names = edicts.map((e) => e.classname);
      expect(names).toContain('item_silencer');
      expect(names.filter((n) => n === 'ammo_grenades')).toHaveLength(1);
      expect(names).not.toContain('weapon_bfg');
      expect(names).not.toContain('item_quad');
      for (const e of edicts) {
        if (e.classname === 'item_silencer' || e.classname === 'ammo_grenades') {
          expect(e.solid).toBe(SOLID_TRIGGER);
        }
      }
    }
  });
});

describe('monster solidity (SP_ SOLID_BBOX / triggered SOLID_NOT / dead skip)', () => {
  const LIVE = ['{"classname" "worldspawn"}', '{"classname" "monster_soldier" "origin" "0 0 0"}'].join('\n');
  const DORMANT = ['{"classname" "worldspawn"}', '{"classname" "monster_soldier" "origin" "0 0 0" "spawnflags" "2"}'].join(
    '\n',
  );

  it('live lump monsters spawn SOLID_BBOX, dormants SOLID_NOT', () => {
    const st = SV_Init();
    SV_SpawnEntities(st, LIVE);
    expect(st.monsters).toHaveLength(1);
    expect(st.monsters[0]!.edict.solid).toBe(SOLID_BBOX);

    const st2 = SV_Init();
    SV_SpawnEntities(st2, DORMANT);
    expect(st2.monsters).toHaveLength(1);
    expect(st2.monsters[0]!.triggered).toBe(true);
    expect(st2.monsters[0]!.woken).toBe(false);
    expect(st2.monsters[0]!.edict.solid).toBe(SOLID_NOT);
  });

  it('synthetic spawns are solid (SV_SpawnMonster parity with the lump path)', () => {
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 0));
    expect(m.edict.solid).toBe(SOLID_BBOX);
  });

  it('wake re-solidifies, death de-solidifies (triggered_spawn / Killed)', () => {
    const st = SV_Init();
    SV_SpawnEntities(st, DORMANT);
    const m = st.monsters[0]!;
    SV_UseMonster(m, true);
    expect(m.woken).toBe(true);
    expect(m.edict.solid).toBe(SOLID_BBOX);
    SV_DamageMonster(st, m, 10000, mulberry32(1));
    expect(m.state.dead || m.state.gibbed).toBe(true);
    expect(m.edict.solid).toBe(SOLID_NOT);
  });

  it('SV_ClipTrace stops a player hull on a live monster (C ClipMoveToEntities)', () => {
    const st = SV_Init();
    SV_SpawnEntities(st, LIVE);
    const m = st.monsters[0]!;
    // Opt-in pass: the shared driver trace keeps monsters out (self-clip
    // would freeze every mover inside its own hull); pmove-only callers
    // enable it explicitly.
    const trace = SV_ClipTrace(st, openTrace(), -1, true);
    const hit = trace(v3(-100, 0, 0), PLAYER_MINS, PLAYER_MAXS, v3(100, 0, 0));
    expect(hit.fraction).toBeLessThan(1);
    expect(hit.fraction).toBeGreaterThan(0);
    expect(hit.entityNum).toBe(m.edict.num);
  });

  it('dormant and dead bodies never clip; ignoreNum skips self', () => {
    const st = SV_Init();
    SV_SpawnEntities(st, DORMANT);
    const m = st.monsters[0]!;
    expect(SV_MonsterClipBox(m)).toBe(null);
    let trace = SV_ClipTrace(st, openTrace(), -1, true);
    expect(trace(v3(-100, 0, 0), PLAYER_MINS, PLAYER_MAXS, v3(100, 0, 0)).fraction).toBe(1);

    SV_UseMonster(m, true);
    expect(SV_MonsterClipBox(m)).not.toBe(null);
    SV_DamageMonster(st, m, 10000, mulberry32(2));
    expect(SV_MonsterClipBox(m)).toBe(null);
    trace = SV_ClipTrace(st, openTrace(), -1, true);
    expect(trace(v3(-100, 0, 0), PLAYER_MINS, PLAYER_MAXS, v3(100, 0, 0)).fraction).toBe(1);

    const st2 = SV_Init();
    SV_SpawnEntities(st2, LIVE);
    const live = st2.monsters[0]!;
    const selfTrace = SV_ClipTrace(st2, openTrace(), live.edict.num, true);
    expect(selfTrace(v3(-100, 0, 0), PLAYER_MINS, PLAYER_MAXS, v3(100, 0, 0)).fraction).toBe(1);
  });
});

describe('base1 infantry roster (769 = NOT_EASY|NOT_MEDIUM|ambush)', () => {
  // Verbatim lump rows (origins/flags/targets), worldspawn-led.
  const INFANTRY_LUMP = [
    '{"classname" "worldspawn"}',
    '{"classname" "monster_infantry" "origin" "-1824 1288 120" "target" "t20" "spawnflags" "769"}',
    '{"classname" "monster_infantry" "origin" "-1240 1320 -24" "angle" "135" "spawnflags" "769"}',
    '{"classname" "monster_infantry" "origin" "-1768 1296 -8" "targetname" "t40" "angle" "270" "spawnflags" "1"}',
    '{"classname" "monster_infantry" "origin" "-1376 1404 -8" "target" "t40" "targetname" "t39" "angle" "90" "spawnflags" "1"}',
    '{"classname" "monster_infantry" "origin" "-1960 1464 120" "target" "t21" "spawnflags" "1"}',
  ].join('\n');

  it('skills 0/1 field 3 infantries, skills 2/3 field 5', () => {
    for (const skill of [0, 1]) {
      const st = SV_Init();
      SV_SetSkill(st, skill);
      SV_SpawnEntities(st, INFANTRY_LUMP);
      const inf = st.monsters.filter((m) => m.edict.classname === 'monster_infantry');
      expect(inf).toHaveLength(3);
      expect(st.totalMonsters).toBe(3);
    }
    for (const skill of [2, 3]) {
      const st = SV_Init();
      SV_SetSkill(st, skill);
      SV_SpawnEntities(st, INFANTRY_LUMP);
      const inf = st.monsters.filter((m) => m.edict.classname === 'monster_infantry');
      expect(inf).toHaveLength(5);
      expect(st.totalMonsters).toBe(5);
    }
  });

  it('killing t39 alerts t40 via death_use and spawns nothing (no post-kill spawn bug)', () => {
    const st = SV_Init();
    SV_SetSkill(st, 2);
    SV_SpawnEntities(st, INFANTRY_LUMP);
    const killer = st.monsters.find((m) => m.edict.targetname === 't39')!;
    const next = st.monsters.find((m) => m.edict.targetname === 't40')!;
    expect(killer.edict.target).toBe('t40');
    expect(next.seen).toBe(false);
    const before = st.monsters.length;
    const killedBefore = st.killedMonsters;
    SV_DamageMonster(st, killer, 10000, mulberry32(7));
    expect(killer.state.dead || killer.state.gibbed).toBe(true);
    expect(st.killedMonsters).toBe(killedBefore + 1);
    // monster_death_use fires the target (alert), exactly once, and creates
    // no edict: the roster is fixed at spawn (C level.total_monsters).
    expect(st.monsters.length).toBe(before);
    expect(st.totalMonsters).toBe(before);
    expect(next.seen).toBe(true);
    const countAfter = st.monsters.length;
    SV_DamageMonster(st, killer, 10000, mulberry32(8));
    expect(st.monsters.length).toBe(countAfter);
  });
});

describe('exit lift never auto-starts on door open (base1 *12/*13/*32/*33)', () => {
  // Base1 wiring, distilled: named train waits for t91; one door carries a
  // dangling target (t75 names nothing), the other carries none.
  const LIFT = [
    '{"classname" "worldspawn"}',
    '{"classname" "path_corner" "targetname" "t88" "target" "t89" "origin" "0 0 0"}',
    '{"classname" "path_corner" "targetname" "t89" "target" "t90" "origin" "100 0 0"}',
    '{"classname" "path_corner" "targetname" "t90" "origin" "200 0 0"}',
    '{"classname" "func_train" "targetname" "t91" "target" "t88" "speed" "40"}',
    '{"classname" "func_door" "targetname" "dA" "target" "t75" "angle" "270" "distance" "64" "speed" "50"}',
    '{"classname" "func_door" "targetname" "dB" "angle" "90" "distance" "64" "speed" "50"}',
  ].join('\n');

  it('opening dangling-target and untargeted doors leaves the train parked', () => {
    const st = SV_Init();
    SV_SpawnEntities(st, LIFT);
    const train = st.trains[0]!;
    expect(train.started).toBe(false);
    const dA = st.movers.find((m) => m.ent.targetname === 'dA')!;
    const dB = st.movers.find((m) => m.ent.targetname === 'dB')!;
    SV_UseMover(st, dA);
    SV_UseMover(st, dB);
    for (let i = 0; i < 50; i++) SV_Tick(st);
    expect(train.started).toBe(false);
    expect(train.arrived).toBe(false);
    // The terminal behavior is use-driven only: firing t91 starts the leg.
    SV_UseTargetname(st, 't91');
    expect(train.started).toBe(true);
  });
});

describe('player fire sounds for the full arsenal (cl_fx.c MZ_* cases)', () => {
  it('every findable weapon resolves to a real pak fire sound', () => {
    const rand = mulberry32(3);
    expect(playerFireSound('weapon_shotgun', rand)).toBe('weapons/shotgf1b.wav');
    expect(playerFireSound('weapon_supershotgun', rand)).toBe('weapons/sshotf1b.wav');
    expect(playerFireSound('weapon_machinegun', rand)).toBe('weapons/machgf1b.wav');
    expect(playerFireSound('weapon_grenadelauncher', rand)).toBe('weapons/grenlf1a.wav');
    expect(playerFireSound('weapon_rocketlauncher', rand)).toBe('weapons/rocklf1a.wav');
    expect(playerFireSound('weapon_hyperblaster', rand)).toBe('weapons/hyprbf1a.wav');
    expect(playerFireSound('weapon_railgun', rand)).toBe('weapons/railgf1a.wav');
    expect(playerFireSound('weapon_bfg', rand)).toBe('weapons/bfg__f1y.wav');
    expect(playerFireSound('weapon_blaster', rand)).toBe('weapons/blastf1a.wav');
  });

  it('chaingun rotates machgf1-5b like C (Com_sprintf rand()%5 + 1)', () => {
    const seen = new Set<string>();
    const rand = mulberry32(11);
    for (let i = 0; i < 40; i++) seen.add(playerFireSound('weapon_chaingun', rand));
    for (const s of seen) expect(s).toMatch(/^weapons\/machgf[1-5]b\.wav$/);
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('monster hull constants used by the clip pass', () => {
  it('infantry hull matches the C walkmonster box', () => {
    expect(MONSTER_HULL_MINS[0]).toBe(-16);
    expect(MONSTER_HULL_MAXS[2]).toBe(32);
  });
});
