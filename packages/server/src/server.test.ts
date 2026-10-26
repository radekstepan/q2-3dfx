// M5.2 server: 10Hz tick + scripted base1-logic scenario.
import { describe, expect, it } from 'vitest';
import { findByClassname, moverUse, spawnEdict, spawnTrigger } from '@q2/game';
import type { Vec3 } from '@q2/math';
import { v3 } from '@q2/math';
import {
  SV_CarryRiders,
  SV_ConsumePickup,
  SV_Init,
  SV_LinkEdict,
  SV_MonsterTick,
  SV_SetSkill,
  SV_SpawnEntities,
  SV_SpawnTrigger,
  SV_Tick,
  SV_TouchDoorsAt,
  SV_TouchTriggersAt,
  SV_UseMover,
  SV_UseTargetname,
  fireTargets,
  inhibitedBySkill,
  monsterKindOf,
  skillMultiplier,
} from './index.js';
import { GUNNER, mulberry32, resetEdictNums } from '@q2/game';
import type { TraceFn } from '@q2/game';
import type { RiderBody } from './index.js';

const BASE1_LOGIC = `
{
"classname" "worldspawn"
}
{
"classname" "func_door"
"targetname" "door1"
"angle" "0"
"distance" "128"
"speed" "100"
"wait" "-1"
"lip" "8"
}
{
"classname" "func_button"
"targetname" "btn1"
"target" "door1"
"angle" "0"
}
{
"classname" "trigger_once"
"target" "door1"
}
`;

describe('server tick (M5.2)', () => {
  it('advances level.time by 0.1 per tick at 10Hz', () => {
    const st = SV_Init();
    expect(st.time).toBe(0);
    SV_Tick(st);
    expect(st.time).toBeCloseTo(0.1, 10);
    for (let i = 0; i < 9; i++) SV_Tick(st);
    expect(st.time).toBeCloseTo(1.0, 10);
    SV_Tick(st, 0.05);
    expect(st.time).toBeCloseTo(1.05, 10);
  });

  it('scripted base1-logic: button use drives door to end pos', () => {
    const st = SV_Init();
    SV_SpawnEntities(st, BASE1_LOGIC);
    const doorMover = st.movers.find((m) => m.ent.targetname === 'door1')!;
    expect(doorMover).toBeDefined();
    expect(doorMover.state).toBe('bottom');

    // press the button: use its target (door1)
    const btn = findByClassname(st.entities, 'func_button')[0]!;
    fireTargets(st, btn);
    expect(doorMover.state).toBe('going_up');

    // run the in-process tick until the door completes its leg
    for (let i = 0; i < 100 && doorMover.state !== 'top'; i++) SV_Tick(st);
    expect(doorMover.state).toBe('top');
    expect(doorMover.ent.origin[0]).toBeCloseTo(doorMover.pos2[0]!, 6);
    expect(st.time).toBeGreaterThan(0);
  });

  it('trigger_once fires the door exactly once via touch', () => {
    const st = SV_Init();
    SV_SpawnEntities(st, BASE1_LOGIC);
    const player = spawnEdict({ classname: 'player' });
    SV_LinkEdict(st, player);
    // walk the player onto the trigger (same origin => within radius)
    player.origin[0] = 0;
    player.origin[1] = 0;
    player.origin[2] = 0;
    SV_TouchTriggersAt(st, 'player', player);
    const doorMover = st.movers.find((m) => m.ent.targetname === 'door1')!;
    expect(doorMover.state).toBe('going_up');
    const firesAfterFirst = st.firedThisTick.length;
    expect(firesAfterFirst).toBeGreaterThan(0);
    SV_TouchTriggersAt(st, 'player', player);
    // trigger_once consumed: no further movement retrigger needed; door keeps going
    expect(doorMover.state).toBe('going_up');
  });

  it('SV_UseTargetname opens a TOGGLE door and closes it again', () => {
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{ "classname" "func_door" "targetname" "d" "spawnflags" "32" "speed" "1000" "wait" "-1" }`,
    );
    SV_UseTargetname(st, 'd');
    for (let i = 0; i < 20; i++) SV_Tick(st);
    const m = st.movers[0]!;
    expect(m.state).toBe('top');
    SV_UseTargetname(st, 'd');
    for (let i = 0; i < 20; i++) SV_Tick(st);
    expect(m.state).toBe('bottom');
  });
});

describe('M7.4 completions: respawn + pusher carrying', () => {
  it('consumed pickups hide and respawn on the id timer via SV_Tick', () => {
    const st = SV_Init();
    const ents = SV_SpawnEntities(
      st,
      `{ "classname" "worldspawn" }\n` +
        `{ "classname" "weapon_shotgun" "origin" "0 0 0" }\n` +
        `{ "classname" "item_armor_combat" "origin" "64 0 0" }\n`,
    );
    const gun = ents.find((e) => e.classname === 'weapon_shotgun')!;
    const armor = ents.find((e) => e.classname === 'item_armor_combat')!;
    // consume both at t=0 (Touch_Item take path, grant is app-side)
    expect(SV_ConsumePickup(st, gun)).toBe(30);
    expect(SV_ConsumePickup(st, armor)).toBe(20);
    expect(gun.solid).toBe(0); // SOLID_NOT: hidden, skipped by touch checks
    for (let i = 0; i < 199; i++) SV_Tick(st); // t=19.9
    expect(armor.solid).toBe(0);
    expect(gun.solid).toBe(0);
    SV_Tick(st); // t=20.0: armor (20s id delay) re-materializes
    expect(armor.solid).toBe(1); // SOLID_TRIGGER
    expect(armor.state).toBe('respawned');
    expect(gun.solid).toBe(0);
    for (let i = 0; i < 100; i++) SV_Tick(st); // t=30.0
    expect(gun.solid).toBe(1);
  });

  it('SV_CarryRiders moves bodies standing on displaced movers', () => {
    const st = SV_Init();
    SV_SpawnEntities(st, `{ "classname" "func_door" "angle" "-2" "speed" "100" "wait" "-1" }`);
    const m = st.movers[0]!;
    const rider: RiderBody = {
      origin: v3(0, 0, 32),
      mins: v3(-16, -16, -24),
      maxs: v3(16, 16, 32),
      groundEntity: m.ent.num,
      onGround: true,
    };
    const walker: RiderBody = {
      origin: v3(500, 0, 32),
      mins: v3(-16, -16, -24),
      maxs: v3(16, 16, 32),
      groundEntity: -1,
      onGround: true,
    };
    // idle tick: no displacement, nobody moves
    SV_Tick(st);
    expect(st.moverDeltas.size).toBe(0);
    SV_CarryRiders(st, [rider, walker]);
    expect(rider.origin[2]).toBe(32);
    // open the door (downward at 100 u/s => -10 z per tick); the displacement
    // is recorded and the rider rides it while the walker is untouched
    moverUse(m, st.time);
    SV_Tick(st);
    expect(st.moverDeltas.get(m.ent.num)?.[2]).toBeCloseTo(-10, 6);
    SV_CarryRiders(st, [rider, walker]);
    expect(rider.origin[2]).toBeCloseTo(22, 6);
    expect(walker.origin[0]).toBe(500);
    expect(walker.origin[2]).toBe(32);
  });
});

describe('exit-spurious-fire fix: brush volumes, relays, mover targets', () => {
  it('brush trigger without registered bounds never fires (no world-origin guess)', () => {
    const st = SV_Init();
    SV_SpawnEntities(st, `{ "classname" "worldspawn" }\n{ "classname" "trigger_multiple" "model" "*99" "target" "t37" }`);
    expect(st.triggers).toHaveLength(1);
    expect(st.triggerBounds.size).toBe(0);
    const player = spawnEdict({ classname: 'player' });
    SV_LinkEdict(st, player);
    // park the player exactly on the brush edict origin (0,0,0): the old
    // point hook fired here; now it must stay silent.
    player.origin = v3(0, 0, 0);
    SV_Tick(st, 0.1);
    SV_TouchTriggersAt(st, 'player', player);
    expect(st.firedThisTick).toHaveLength(0);
  });

  it('brush trigger with bounds fires only on real volume overlap', () => {
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{ "classname" "worldspawn" }\n` +
        `{ "classname" "trigger_multiple" "model" "*7" "target" "t37" }\n` +
        `{ "classname" "trigger_relay" "targetname" "t37" "target" "nowhere" }`,
    );
    const t = st.triggers[0]!;
    SV_SpawnTrigger(st, t, {
      mins: new Float32Array([-1840, 1448, -24]),
      maxs: new Float32Array([-1712, 1640, 32]),
    });
    const player = spawnEdict({ classname: 'player' });
    SV_LinkEdict(st, player);
    // far away at the world origin: silent (this fired pre-fix)
    player.origin = v3(0, 0, 32);
    SV_Tick(st, 0.1);
    SV_TouchTriggersAt(st, 'player', player);
    expect(st.firedThisTick).not.toContain('t37');
    // real pit-floor overlap: fires (id G_TouchTriggers parity)
    player.origin = v3(-1776, 1544, -56);
    SV_Tick(st, 0.1);
    SV_TouchTriggersAt(st, 'player', player);
    expect(st.firedThisTick).toContain('t37');
  });

  it('point triggers keep the legacy proximity hook', () => {
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{ "classname" "worldspawn" }\n` +
        `{ "classname" "trigger_once" "origin" "100 0 0" "target" "door1" }\n` +
        `{ "classname" "trigger_relay" "targetname" "door1" "target" "nowhere" }`,
    );
    const player = spawnEdict({ classname: 'player' });
    SV_LinkEdict(st, player);
    player.origin = v3(100, 0, 0);
    SV_Tick(st, 0.1);
    SV_TouchTriggersAt(st, 'player', player);
    expect(st.firedThisTick).toContain('door1');
  });

  it('button reaching the top fires its target (id button_wait)', () => {
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{ "classname" "worldspawn" }\n` +
        `{ "classname" "func_door" "targetname" "door1" "angle" "0" "distance" "128" "speed" "100" "wait" "-1" "lip" "8" }\n` +
        `{ "classname" "func_button" "targetname" "btn1" "target" "door1" "angle" "0" }`,
    );
    SV_UseTargetname(st, 'btn1'); // press: button starts moving, door still shut
    const door = st.movers.find((m) => m.ent.targetname === 'door1')!;
    expect(door.state).toBe('bottom');
    for (let i = 0; i < 20 && door.state === 'bottom'; i++) SV_Tick(st);
    // the button arrived at the top and fired door1 on its own — no explicit
    // fireTargets call needed (id button_wait semantics).
    expect(door.state).toBe('going_up');
  });

  it('relay chains cascade through fireTargets (id G_UseTargets)', () => {
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{ "classname" "worldspawn" }\n` +
        `{ "classname" "func_door" "targetname" "door1" "angle" "0" "distance" "128" "speed" "100" "wait" "-1" "lip" "8" }\n` +
        `{ "classname" "trigger_relay" "targetname" "r1" "target" "r2" }\n` +
        `{ "classname" "trigger_relay" "targetname" "r2" "target" "door1" }`,
    );
    SV_UseTargetname(st, 'r1');
    const door = st.movers.find((m) => m.ent.targetname === 'door1')!;
    expect(door.state).toBe('going_up');
    expect(st.firedThisTick).toContain('r2');
    expect(st.firedThisTick).toContain('door1');
  });

  it('using a door fires the door target at use time (id door_go_up)', () => {
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{ "classname" "worldspawn" }\n` +
        `{ "classname" "func_door" "targetname" "door1" "target" "lit" "angle" "0" "distance" "128" "speed" "100" "wait" "-1" "lip" "8" }\n` +
        `{ "classname" "trigger_relay" "targetname" "lit" "target" "nowhere" }`,
    );
    SV_UseTargetname(st, 'door1');
    expect(st.firedThisTick).toContain('lit');
  });
});

describe('skill cvar + spawn gating (g_spawn.c, g_combat.c)', () => {
  it('SV_SetSkill floors and clamps to 0-3 (id skill cvar)', () => {
    const st = SV_Init();
    expect(st.skill).toBe(1); // C default: skill 1 (medium)
    expect(SV_SetSkill(st, 2)).toBe(2);
    expect(st.skill).toBe(2);
    expect(SV_SetSkill(st, 2.9)).toBe(2);
    expect(SV_SetSkill(st, -1)).toBe(0);
    expect(SV_SetSkill(st, 9)).toBe(3);
    expect(SV_SetSkill(st, Number.NaN)).toBe(1);
  });

  it('skillMultiplier halves damage to the player on easy (g_combat.c)', () => {
    expect(skillMultiplier(0)).toBe(0.5);
    expect(skillMultiplier(1)).toBe(1);
    expect(skillMultiplier(2)).toBe(1);
    expect(skillMultiplier(3)).toBe(1);
  });

  it('inhibitedBySkill matches the NOT_* roster rule (g_spawn.c)', () => {
    expect(inhibitedBySkill(256, 0)).toBe(true);
    expect(inhibitedBySkill(256, 1)).toBe(false);
    expect(inhibitedBySkill(512, 0)).toBe(false);
    expect(inhibitedBySkill(512, 1)).toBe(true);
    expect(inhibitedBySkill(1024, 1)).toBe(false);
    expect(inhibitedBySkill(1024, 2)).toBe(true);
    expect(inhibitedBySkill(1024, 3)).toBe(true);
    expect(inhibitedBySkill(1792, 0)).toBe(true);
    expect(inhibitedBySkill(1792, 1)).toBe(true);
    expect(inhibitedBySkill(1792, 2)).toBe(true);
    expect(inhibitedBySkill(1792, 3)).toBe(true); // DM-only
    expect(inhibitedBySkill(0, 0)).toBe(false);
  });

  it('skill gates the roster at spawn (NOT_EASY vs NOT_HARD items)', () => {
    const lump =
      `{ "classname" "worldspawn" }\n` +
      `{ "classname" "ammo_shells" "origin" "0 0 0" "spawnflags" "256" }\n` +
      `{ "classname" "ammo_bullets" "origin" "64 0 0" "spawnflags" "1024" }\n` +
      `{ "classname" "weapon_shotgun" "origin" "-64 0 0" }\n`;
    const easy = SV_Init();
    SV_SetSkill(easy, 0);
    const easyEnts = SV_SpawnEntities(easy, lump);
    expect(easyEnts.map((e) => e.classname).sort()).toEqual(['ammo_bullets', 'weapon_shotgun', 'worldspawn']);
    const hard = SV_Init();
    SV_SetSkill(hard, 2);
    const hardEnts = SV_SpawnEntities(hard, lump);
    expect(hardEnts.map((e) => e.classname).sort()).toEqual(['ammo_shells', 'weapon_shotgun', 'worldspawn']);
  });

  it('monsterKindOf: soldiers map, gunner maps, infantry stays unmapped', () => {
    // SP_monster_soldier_light is a soldier with a different skin; infantry
    // has no lite def yet (needs an INFANTRY table in monsters.ts — reported).
    expect(monsterKindOf('monster_soldier')).toBe('soldier');
    expect(monsterKindOf('monster_soldier_light')).toBe('soldier');
    expect(monsterKindOf('monster_gunner')).toBe('gunner');
    expect(monsterKindOf('monster_infantry')).toBeNull();
  });

  it('doors spawn closed (no START_OPEN), open on touch, auto-close when clear', () => {
    // C SP_func_door: without START_OPEN the slab rests at pos1 in STATE_BOTTOM;
    // door_hit_top schedules door_go_down after `wait`, door_hit_bottom ends
    // at STATE_BOTTOM. Touch_DoorTrigger debounce is implicit: moverUse only
    // re-fires from bottom/waiting (re-touch refreshes the wait, like C's
    // door_go_up-on-TOP nextthink reset), so a clear area always returns to pos1.
    const lump =
      `{ "classname" "worldspawn" }\n` +
      `{ "classname" "func_door" "model" "*1" "angle" "0" "distance" "128" "speed" "100" "wait" "3" }\n`;
    const bounds = { mins: new Float32Array([-32, -32, 0]), maxs: new Float32Array([32, 32, 96]) };
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(st, lump, (m) => (m === '*1' ? bounds : null));
    expect(st.movers).toHaveLength(1);
    const door = st.movers[0]!;
    // initial state: closed at pos1 (this is the M5.2 pin — a spawn at pos2
    // with state bottom would render open while reading closed).
    expect(door.state).toBe('bottom');
    expect([...door.ent.origin]).toEqual([...door.pos1]);
    // touch the trigger volume (brush bounds +60 x/y) as the player.
    const used = SV_TouchDoorsAt(st, {
      origin: v3(0, 0, 32),
      mins: v3(-16, -16, -24),
      maxs: v3(16, 16, 32),
    });
    expect(used).toHaveLength(1);
    expect(door.state).toBe('going_up');
    // run with the area clear (no further touches): must reach pos2 ...
    let sawTop = false;
    for (let i = 0; i < 40 && door.state !== 'bottom'; i++) {
      SV_Tick(st);
      if (door.ent.origin[0] === door.pos2[0] && door.ent.origin[2] === door.pos2[2]) sawTop = true;
    }
    expect(sawTop).toBe(true);
    // ... then come back down and latch at pos1/bottom (3s wait + 1.2s legs).
    for (let i = 0; i < 200 && door.state !== 'bottom'; i++) SV_Tick(st);
    expect(door.state).toBe('bottom');
    expect([...door.ent.origin]).toEqual([...door.pos1]);
  });

  it('NOMONSTER doors ignore monster touches but open for the player', () => {
    // id Touch_DoorTrigger (g_func.c): (owner.spawnflags & DOOR_NOMONSTER) &&
    // toucher is monster -> return. Base1 sliders *32/*33 carry flag 8.
    const lump =
      `{ "classname" "worldspawn" }\n` +
      `{ "classname" "func_door" "model" "*1" "angle" "90" "distance" "72" "speed" "50" "spawnflags" "8" }\n`;
    const bounds = { mins: new Float32Array([-8, -48, 0]), maxs: new Float32Array([8, 48, 64]) };
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(st, lump, (m) => (m === '*1' ? bounds : null));
    const door = st.movers[0]!;
    const body = { origin: v3(0, 0, 32), mins: v3(-16, -16, -24), maxs: v3(16, 16, 32) };
    expect(SV_TouchDoorsAt(st, body, 'monster')).toHaveLength(0);
    expect(door.state).toBe('bottom');
    expect(SV_TouchDoorsAt(st, body, 'player')).toHaveLength(1);
    expect(door.state).toBe('going_up');
  });

  it('soldier spawn stashes the C skinnum for the render lane', () => {
    // m_soldier.c: SP_monster_soldier_light -> skin 0 (blaster),
    // SP_monster_soldier -> skin 2 (shotgun), SP_monster_soldier_ss -> 4
    // (machinegun). selectSoldierAttack keys the weapon off the same skins.
    const lump =
      `{ "classname" "worldspawn" }\n` +
      `{ "classname" "monster_soldier_light" "origin" "0 0 0" }\n` +
      `{ "classname" "monster_soldier" "origin" "64 0 0" }\n` +
      `{ "classname" "monster_soldier_ss" "origin" "128 0 0" }\n`;
    resetEdictNums();
    const st = SV_Init();
    const ents = SV_SpawnEntities(st, lump);
    const skin = (cls: string): string =>
      ents.find((e) => e.classname === cls)!.extra['skinnum'] as string;
    expect(skin('monster_soldier_light')).toBe('0');
    expect(skin('monster_soldier')).toBe('2');
    expect(skin('monster_soldier_ss')).toBe('4');
  });

  it('gunner-lite tables match m_gunner.c move structure', () => {
    // gcc -c ground truth: attack_chain 7f -> fire_chain, fire_chain 8f ->
    // endfire_chain (via gunner_refire_chain), endfire_chain 7f -> run,
    // attack_grenade 21f -> run; health 175 / gib -70 / mass 200.
    const st = SV_Init();
    const ents = SV_SpawnEntities(
      st,
      `{ "classname" "worldspawn" }\n{ "classname" "monster_gunner" "origin" "0 0 24" }\n`,
    );
    expect(st.monsters).toHaveLength(1);
    const m = st.monsters[0]!;
    expect(m.kind).toBe('gunner');
    expect(m.state.health).toBe(175);
    expect(ents).toHaveLength(2);
    expect(GUNNER.moves['attack_chain']!.frames).toHaveLength(7);
    expect(GUNNER.moves['attack_chain']!.end).toBe('fire_chain');
    expect(GUNNER.moves['fire_chain']!.frames).toHaveLength(8);
    expect(GUNNER.moves['endfire_chain']!.frames).toHaveLength(7);
    expect(GUNNER.moves['endfire_chain']!.end).toBe('run');
    expect(GUNNER.moves['attack_grenade']!.frames).toHaveLength(21);
    expect(GUNNER.health).toBe(175);
    expect(GUNNER.gibHealth).toBe(-70);
    expect(GUNNER.mass).toBe(200);
    expect(GUNNER.moves['runandshoot']!.frames.every((f) => f.action === 'fire')).toBe(true);
  });

  it('synthetic gunner chases and fires the chaingun with clear LOS', () => {
    // No BSP needed: stub trace reports clear LOS and unclamped motion.
    const st = SV_Init();
    resetEdictNums();
    SV_SpawnEntities(st, `{ "classname" "worldspawn" }\n{ "classname" "monster_gunner" "origin" "0 0 24" }\n`);
    const gunner = st.monsters[0]!;
    const player = v3(300, 0, 24);
    const trace: TraceFn = (start, mins, _maxs, end) => {
      void start;
      void mins;
      return { fraction: 1, endpos: v3(end[0], end[1], end[2]), planeNormal: v3(0, 0, 1), allsolid: false, startsolid: false, entityNum: -1, contents: 0 };
    };
    const d0 = Math.hypot(gunner.edict.origin[0]! - player[0]!, gunner.edict.origin[1]! - player[1]!);
    const rand = mulberry32(1234);
    let fires = 0;
    const attacks = new Set<string>();
    for (let i = 0; i < 40; i++) {
      for (const ev of SV_MonsterTick(st, player, trace, null, rand)) {
        fires++;
        attacks.add(ev.attack);
        expect(ev.dmgScale).toBe(1);
      }
    }
    const d1 = Math.hypot(gunner.edict.origin[0]! - player[0]!, gunner.edict.origin[1]! - player[1]!);
    expect(d1).toBeLessThan(d0); // closed in (run/runandshoot dist > 0)
    expect(fires).toBeGreaterThan(0); // ranged attack wired, not static
    expect([...attacks].some((a) => a === 'chaingun' || a === 'grenade')).toBe(true);
  });

  it('door touch volume opens a vertical door and fires its target (Touch_DoorTrigger)', () => {
    // Synthetic *7-analogue: 64x64x128 brush, angle -1 (straight up, id VEC_UP).
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{ "classname" "worldspawn" }\n` +
        `{ "classname" "func_door" "model" "*7" "angle" "-1" "target" "lit" "wait" "-1" }\n` +
        `{ "classname" "trigger_relay" "targetname" "lit" }\n`,
      (model) =>
        model === '*7'
          ? { mins: new Float32Array([0, 0, 0]), maxs: new Float32Array([64, 64, 128]) }
          : null,
    );
    const m = st.movers[0]!;
    // travel = |up| . size - lip = 128 - 8; pos2 straight above pos1.
    expect(m.pos2[0]! - m.pos1[0]!).toBeCloseTo(0, 6);
    expect(m.pos2[1]! - m.pos1[1]!).toBeCloseTo(0, 6);
    expect(m.pos2[2]! - m.pos1[2]!).toBeCloseTo(120, 6);
    const used = SV_TouchDoorsAt(st, {
      origin: v3(32, 32, 24),
      mins: v3(-16, -16, -24),
      maxs: v3(16, 16, 32),
    });
    expect(used).toHaveLength(1);
    expect(m.state).toBe('going_up');
    expect(st.firedThisTick).toContain('lit'); // door_go_up fires on opening
    for (let i = 0; i < 30 && m.state !== 'top'; i++) SV_Tick(st);
    expect(m.state).toBe('top');
    expect(m.ent.origin[2]!).toBeCloseTo(120, 3); // slid along +Z by travel
  });
});
