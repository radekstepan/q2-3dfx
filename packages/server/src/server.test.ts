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
  SV_SpawnEntities,
  SV_SpawnTrigger,
  SV_Tick,
  SV_TouchTriggersAt,
  SV_UseMover,
  SV_UseTargetname,
  fireTargets,
} from './index.js';
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
