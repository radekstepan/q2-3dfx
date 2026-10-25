// M5.2 server: 10Hz tick + scripted base1-logic scenario.
import { describe, expect, it } from 'vitest';
import { findByClassname, spawnEdict } from '@q2/game';
import {
  SV_Init,
  SV_LinkEdict,
  SV_SpawnEntities,
  SV_Tick,
  SV_TouchTriggersAt,
  SV_UseTargetname,
  fireTargets,
} from './index.js';

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
