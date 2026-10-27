// Synthetic C-parity tests for func_train_find / train_next / train_wait
// (packages/server/src/index.ts train section): teleport-corner link
// following, TOGGLE pause/resume, wait<0 halts, blocked damage, and the
// Think_CalcMoveSpeed team wiring in SV_SpawnEntities. No base1 dependency.

import { describe, expect, it } from 'vitest';
import {
  SV_Init,
  SV_SpawnEntities,
  SV_Tick,
  SV_UseTargetname,
  startTrain,
  trainBlocked,
} from './index.js';

// Brush trains with a model resolve base = brush mins through the hook, so
// the origin tracks corner positions exactly (like base1, which always
// supplies modelSizes).
function spawnWired(text: string): ReturnType<typeof SV_Init> {
  const st = SV_Init();
  SV_SpawnEntities(st, text, () => ({
    mins: new Float32Array(3),
    maxs: new Float32Array([64, 64, 64]),
  }));
  return st;
}

const TRAIN_LUMP = `
{ "classname" "func_train" "model" "*1" "target" "t1" "speed" "100" }
{ "classname" "path_corner" "targetname" "t1" "target" "t2" "origin" "0 0 0" }
{ "classname" "path_corner" "targetname" "t2" "target" "t1" "origin" "100 0 0" }
`;

describe('func_train_find / train_next (C link following)', () => {
  it('places the train on the first corner and runs the chain', () => {
    const st = spawnWired(TRAIN_LUMP);
    expect(st.trains).toHaveLength(1);
    const tr = st.trains[0]!;
    expect([...tr.ent.origin]).toEqual([0, 0, 0]);
    expect(tr.started).toBe(true);
    // 100 units at 100 u/s: arrives after 10 ticks, then wraps t2 -> t1.
    for (let i = 0; i < 10; i++) SV_Tick(st);
    expect(tr.ent.origin[0]!).toBeCloseTo(100, 6);
    for (let i = 0; i < 10; i++) SV_Tick(st);
    expect(tr.ent.origin[0]!).toBeCloseTo(0, 3);
    expect(tr.arrived).toBe(false); // link-back wraps forever
  });

  it('follows teleport corners without a travel leg (goto again)', () => {
    // C train_next teleports THROUGH a teleport corner the moment it picks
    // it: the t1->t2 leg is travelled (t2 normal), arrival advances to t3
    // (teleport: snap to 120, no travel), then t3->t4 is travelled.
    const st = spawnWired(`
{ "classname" "func_train" "model" "*1" "target" "t1" "speed" "100" }
{ "classname" "path_corner" "targetname" "t1" "target" "t2" "origin" "0 0 0" }
{ "classname" "path_corner" "targetname" "t2" "target" "t3" "origin" "40 0 0" }
{ "classname" "path_corner" "targetname" "t3" "target" "t4" "origin" "120 0 0" "spawnflags" "1" }
{ "classname" "path_corner" "targetname" "t4" "origin" "200 0 0" }
`);
    const tr = st.trains[0]!;
    for (let i = 0; i < 4; i++) SV_Tick(st);
    // Leg t1 -> t2 (40u) arrives on tick 4; the teleport snaps to t3 (120)
    // in the same arrival, and the dangling end link stops the chain later.
    expect([...tr.ent.origin][0]!).toBeCloseTo(120, 6);
    expect(tr.arrived).toBe(false);
    for (let i = 0; i < 8; i++) SV_Tick(st);
    expect([...tr.ent.origin][0]!).toBeCloseTo(200, 6);
    expect(tr.arrived).toBe(true);
  });

  it('honours corner waits and fires pathtargets (train_wait)', () => {
    const st = spawnWired(`
{ "classname" "func_train" "model" "*1" "target" "t1" "speed" "100" }
{ "classname" "path_corner" "targetname" "t1" "target" "t2" "origin" "0 0 0" }
{ "classname" "path_corner" "targetname" "t2" "origin" "50 0 0" "wait" "5" "pathtarget" "boom" }
{ "classname" "trigger_relay" "targetname" "boom" }
`);
    const tr = st.trains[0]!;
    for (let i = 0; i < 5; i++) SV_Tick(st);
    expect(tr.ent.origin[0]!).toBeCloseTo(50, 6);
    expect(st.firedThisTick).toContain('boom');
    expect(tr.waitUntil).toBeGreaterThan(st.time);
    const held = tr.ent.origin[0]!;
    for (let i = 0; i < 10; i++) SV_Tick(st);
    expect(tr.ent.origin[0]!).toBeCloseTo(held, 9); // still waiting
    expect(tr.arrived).toBe(false);
    for (let i = 0; i < 60 && !tr.arrived; i++) SV_Tick(st);
    expect(tr.arrived).toBe(true); // t2 has no target: chain ends after wait
  });
});

describe('train TOGGLE + wait<0 (C train_wait/train_use)', () => {
  const holdLump = (flags: string): string => `
{ "classname" "func_train" "model" "*1" "target" "t1" "speed" "100" "spawnflags" "${flags}" }
{ "classname" "path_corner" "targetname" "t1" "target" "t2" "origin" "0 0 0" }
{ "classname" "path_corner" "targetname" "t2" "origin" "100 0 0" "wait" "-1" }
`;

  it('wait<0 without TOGGLE halts the chain dead', () => {
    const st = spawnWired(holdLump('0'));
    const tr = st.trains[0]!;
    for (let i = 0; i < 12; i++) SV_Tick(st);
    expect(tr.ent.origin[0]!).toBeCloseTo(100, 6);
    expect(tr.arrived).toBe(true);
    startTrain(tr, st.time);
    SV_Tick(st);
    expect(tr.arrived).toBe(true); // use is ignored, like C
  });

  it('wait<0 with TOGGLE halts but use resumes', () => {
    const st = spawnWired(holdLump('2'));
    const tr = st.trains[0]!;
    for (let i = 0; i < 12; i++) SV_Tick(st);
    expect(tr.ent.origin[0]!).toBeCloseTo(100, 6);
    expect(tr.arrived).toBe(false);
    expect(tr.halted).toBe(true);
    startTrain(tr, st.time);
    expect(tr.halted).toBe(false);
  });

  it('TOGGLE use pauses a running train mid-leg and resumes it', () => {
    const st = spawnWired(TRAIN_LUMP.replace('"speed" "100"', '"speed" "100" "spawnflags" "2"'));
    const tr = st.trains[0]!;
    for (let i = 0; i < 3; i++) SV_Tick(st);
    expect(tr.ent.origin[0]!).toBeCloseTo(30, 6);
    startTrain(tr, st.time); // C: START_ON + TOGGLE stops mid-leg
    expect(tr.halted).toBe(true);
    SV_Tick(st);
    expect(tr.ent.origin[0]!).toBeCloseTo(30, 9);
    startTrain(tr, st.time); // resume (train_resume)
    for (let i = 0; i < 7; i++) SV_Tick(st);
    expect(tr.ent.origin[0]!).toBeCloseTo(100, 4);
  });

  it('non-TOGGLE use while running is ignored', () => {
    const st = spawnWired(TRAIN_LUMP);
    const tr = st.trains[0]!;
    for (let i = 0; i < 3; i++) SV_Tick(st);
    startTrain(tr, st.time);
    expect(tr.halted).toBe(false);
    SV_Tick(st);
    expect(tr.ent.origin[0]!).toBeCloseTo(40, 6);
  });
});

describe('train_blocked (C damage rules)', () => {
  it('deals dmg debounced at 0.5s; BLOCK_STOPS deals 0; debris crushes', () => {
    const st = spawnWired(TRAIN_LUMP);
    const tr = st.trains[0]!;
    expect(tr.dmg).toBe(100); // C default
    expect(trainBlocked(tr, 'player', 1.0)).toEqual({ dmg: 100, crush: false });
    expect(trainBlocked(tr, 'player', 1.2)).toBeNull();
    expect(trainBlocked(tr, 'monster', 1.6)).toEqual({ dmg: 100, crush: false });
    expect(trainBlocked(tr, 'other', 1.7)).toEqual({ dmg: 100000, crush: true });
    const st2 = spawnWired(TRAIN_LUMP.replace('"speed" "100"', '"speed" "100" "spawnflags" "4"'));
    const tr2 = st2.trains[0]!;
    expect(tr2.dmg).toBe(0);
    expect(trainBlocked(tr2, 'player', 0)).toEqual({ dmg: 0, crush: false });
  });
});

describe('func_door_secret / func_door_rotating spawn wiring', () => {
  it('spawns secret + rotating doors from the lump (C SP_ funcs)', () => {
    const st = spawnWired(`
{ "classname" "func_door_secret" "model" "*1" "targetname" "s1" "angle" "0" }
{ "classname" "func_door_rotating" "targetname" "r1" "spawnflags" "64" }
{ "classname" "func_train" "model" "*1" "target" "t1" "speed" "100" }
{ "classname" "path_corner" "targetname" "t1" "origin" "0 0 0" }
`);
    expect(st.secretDoors).toHaveLength(1);
    expect(st.rotDoors).toHaveLength(1);
    const sm = st.secretDoors[0]!;
    // Sized from the brush hook (64,64,64): back out along -right, slide +fwd.
    expect([...sm.pos1]).toEqual([0, -64, 0]);
    const rm = st.rotDoors[0]!;
    expect([...rm.endAngles]).toEqual([0, 0, 90]); // X_AXIS
    // Use fires the sequence / swing.
    SV_UseTargetname(st, 's1');
    expect(sm.phase).toBe('back');
    SV_UseTargetname(st, 'r1');
    expect(rm.state).toBe('going_up');
    // Ticks advance both through the same SV_Tick all movers use.
    for (let i = 0; i < 5; i++) SV_Tick(st);
    expect(st.moverDeltas.has(sm.ent.num)).toBe(true);
    expect([...rm.ent.angles][2]!).toBeGreaterThan(0);
    expect(st.sounds.length).toBeGreaterThan(0); // rot start sound
  });

  it('unhooked secret doors are degenerate, like C with an empty size', () => {
    const st = SV_Init();
    SV_SpawnEntities(st, `{ "classname" "func_door_secret" "targetname" "s1" "angle" "0" }`);
    expect([...st.secretDoors[0]!.pos1]).toEqual([0, 0, 0]);
  });

  it('Think_CalcMoveSpeed team wiring equalises arrival times', () => {
    const st = spawnWired(`
{ "classname" "func_door" "team" "d1" "angle" "0" "distance" "136" "speed" "100" "wait" "-1" }
{ "classname" "func_door" "team" "d1" "angle" "0" "distance" "72" "speed" "100" "wait" "-1" }
`);
    expect(st.movers).toHaveLength(2);
    const [a, b] = st.movers;
    // travel = distance - lip(8): 128 and 64; min governs: 200 / 100.
    expect(a!.speed).toBeCloseTo(200, 9);
    expect(b!.speed).toBeCloseTo(100, 9);
    expect(128 / a!.speed).toBeCloseTo(64 / b!.speed, 9);
  });
});
