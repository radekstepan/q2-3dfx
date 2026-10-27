// Synthetic C-parity tests for func_door_secret, func_door_rotating and
// Think_CalcMoveSpeed (packages/server/src/doors.ts). No base1 dependency:
// every mover is built from a hand-made edict, matching the C spawn inputs.

import { describe, expect, it } from 'vitest';
import { spawnDoor, spawnEdict } from '@q2/game';
import { v3 } from '@q2/math';
import {
  CRUSH_DAMAGE,
  DOOR_SOUND_END,
  DOOR_SOUND_START,
  applyTeamMoveSpeeds,
  rotBlocked,
  rotGoDown,
  rotGoUp,
  rotReverse,
  rotThink,
  rotUse,
  secretBlocked,
  secretDie,
  secretThink,
  secretUse,
  spawnRotDoor,
  spawnSecretDoor,
  thinkCalcMoveSpeed,
} from './doors.js';

function secretEdict(extra: Record<string, string> = {}): ReturnType<typeof spawnEdict> {
  return spawnEdict({ classname: 'func_door_secret', ...extra });
}

function rotEdict(extra: Record<string, string> = {}): ReturnType<typeof spawnEdict> {
  return spawnEdict({ classname: 'func_door_rotating', ...extra });
}

/** Step a secret through travel until `phase` changes (guarded). */
function stepSecretTo(
  sm: ReturnType<typeof spawnSecretDoor>,
  phase: string,
  from: number,
): number {
  let now = from;
  for (let i = 0; i < 2000 && sm.phase !== phase; i++) {
    now += 0.1;
    secretThink(sm, now, 0.1);
  }
  expect(sm.phase).toBe(phase);
  return now;
}

describe('Think_CalcMoveSpeed', () => {
  it('scales chained speeds so all parts arrive together', () => {
    const members = [
      { distance: 128, speed: 100 },
      { distance: 64, speed: 100 },
    ];
    thinkCalcMoveSpeed(members);
    // min = 64, time = 0.64: 128/0.64 = 200, 64/0.64 = 100.
    expect(members[0]!.speed).toBeCloseTo(200, 9);
    expect(members[1]!.speed).toBeCloseTo(100, 9);
    expect(128 / members[0]!.speed).toBeCloseTo(64 / members[1]!.speed, 9);
  });

  it('is the identity for a lone door', () => {
    const members = [{ distance: 156, speed: 100 }];
    thinkCalcMoveSpeed(members);
    expect(members[0]!.speed).toBeCloseTo(100, 9);
  });

  it('uses absolute distances and the master speed', () => {
    const members = [
      { distance: 100, speed: 50 },
      { distance: 200, speed: 50 },
    ];
    thinkCalcMoveSpeed(members);
    expect(members[0]!.speed).toBeCloseTo(50, 9);
    expect(members[1]!.speed).toBeCloseTo(100, 9);
  });

  it('groups movers by team key and leaves unteamed speeds alone', () => {
    const a = spawnEdict({ classname: 'func_door', team: 'd1' });
    const b = spawnEdict({ classname: 'func_door', team: 'd1' });
    const c = spawnEdict({ classname: 'func_door' });
    // spawnDoor(ent, angle, distance): travel = distance - lip (lip 8).
    const ma = spawnDoor(a, 0, 136); // travel 128
    const mb = spawnDoor(b, 0, 72); // travel 64
    const mc = spawnDoor(c, 0, 136);
    applyTeamMoveSpeeds([ma, mb, mc]);
    // Team d1 arrives together: 128/200 == 64/100 == 0.64s.
    expect(ma.speed).toBeCloseTo(200, 9);
    expect(mb.speed).toBeCloseTo(100, 9);
    expect(mc.speed).toBe(100);
  });
});

describe('func_door_secret geometry (SP_func_door_secret)', () => {
  it('backs out along +right then slides along +forward for angle 0', () => {
    const sm = spawnSecretDoor(secretEdict(), v3(64, 64, 128));
    // AngleVectors(0,0,0): fwd=(1,0,0) right=(0,-1,0) up=(0,0,1).
    expect([...sm.pos1]).toEqual([0, -64, 0]);
    expect([...sm.pos2]).toEqual([64, -64, 0]);
    expect(sm.speed).toBe(50);
    expect(sm.wait).toBe(5);
    expect(sm.dmg).toBe(2);
  });

  it('1ST_LEFT mirrors the back-out side', () => {
    const sm = spawnSecretDoor(secretEdict({ spawnflags: '2' }), v3(64, 64, 128));
    expect([...sm.pos1]).toEqual([0, 64, 0]);
    expect([...sm.pos2]).toEqual([64, 64, 0]);
  });

  it('1ST_DOWN backs down by the height instead', () => {
    const sm = spawnSecretDoor(secretEdict({ spawnflags: '4' }), v3(64, 64, 128));
    expect([...sm.pos1]).toEqual([0, 0, -128]);
    expect([...sm.pos2]).toEqual([64, 0, -128]);
  });

  it('honours explicit wait and custom dmg', () => {
    const sm = spawnSecretDoor(secretEdict({ wait: '7', dmg: '9' }), v3(64, 64, 64));
    expect(sm.wait).toBe(7);
    expect(sm.dmg).toBe(9);
  });
});

describe('func_door_secret sequence', () => {
  it('runs back, pause, slide, hold, return, pause, close', () => {
    const sm = spawnSecretDoor(secretEdict(), v3(64, 64, 128));
    expect(secretUse(sm, 0)).toBe(true);
    expect(sm.phase).toBe('back');
    let now = stepSecretTo(sm, 'pause1', 0);
    expect([...sm.ent.origin]).toEqual([...sm.pos1]);
    now = stepSecretTo(sm, 'slide', now);
    now = stepSecretTo(sm, 'hold', now);
    expect([...sm.ent.origin]).toEqual([...sm.pos2]);
    // Default hold is 5s: still holding 2s later, returning after 6s.
    secretThink(sm, now + 2, 0.1);
    expect(sm.phase).toBe('hold');
    now = stepSecretTo(sm, 'return', now + 2);
    now = stepSecretTo(sm, 'pause2', now);
    expect([...sm.ent.origin]).toEqual([...sm.pos1]);
    now = stepSecretTo(sm, 'close', now);
    now = stepSecretTo(sm, 'idle', now);
    expect([...sm.ent.origin]).toEqual([...sm.origin0]);
  });

  it('travel legs run at 50 u/s', () => {
    const sm = spawnSecretDoor(secretEdict(), v3(64, 64, 128));
    secretUse(sm, 0);
    secretThink(sm, 0.1, 0.1);
    // 64 units back at 50 u/s = 5u per tick along -Y.
    expect(sm.ent.origin[1]!).toBeCloseTo(-5, 9);
  });

  it('ignores re-fire until fully closed, then re-fires', () => {
    const sm = spawnSecretDoor(secretEdict(), v3(64, 64, 128));
    expect(secretUse(sm, 0)).toBe(true);
    expect(secretUse(sm, 0.1)).toBe(false); // mid-sequence: C ignores
    let now = 0.1;
    for (let i = 0; i < 300 && sm.phase !== 'slide'; i++) {
      now += 0.1;
      secretThink(sm, now, 0.1);
    }
    expect(secretUse(sm, now)).toBe(false); // open, not at rest
    now = stepSecretTo(sm, 'idle', now);
    expect(secretUse(sm, now)).toBe(true); // back at rest: re-fires
  });

  it('wait -1 holds the door open forever', () => {
    const sm = spawnSecretDoor(secretEdict({ wait: '-1' }), v3(64, 64, 128));
    secretUse(sm, 0);
    const now = stepSecretTo(sm, 'open', 0);
    secretThink(sm, now + 60, 0.1);
    expect(sm.phase).toBe('open');
    expect(secretUse(sm, now + 60)).toBe(false);
  });
});

describe('func_door_secret damage', () => {
  it('damages blockers with a 0.5s debounce', () => {
    const sm = spawnSecretDoor(secretEdict(), v3(64, 64, 64));
    const hit = secretBlocked(sm, 'player', 1.0);
    expect(hit).toEqual({ dmg: 2, crush: false });
    expect(secretBlocked(sm, 'monster', 1.2)).toBeNull();
    const hit2 = secretBlocked(sm, 'monster', 1.6);
    expect(hit2).toEqual({ dmg: 2, crush: false });
  });

  it('crushes debris with 100000', () => {
    const sm = spawnSecretDoor(secretEdict(), v3(64, 64, 64));
    expect(secretBlocked(sm, 'other', 0)).toEqual({ dmg: CRUSH_DAMAGE, crush: true });
  });

  it('untargeted doors are shootable; targeted ones need ALWAYS_SHOOT', () => {
    expect(spawnSecretDoor(secretEdict(), v3(8, 8, 8)).shootable).toBe(true);
    const targeted = spawnSecretDoor(secretEdict({ targetname: 's1' }), v3(8, 8, 8));
    expect(targeted.shootable).toBe(false);
    expect(secretDie(targeted, 0)).toBe(false);
    const always = spawnSecretDoor(secretEdict({ targetname: 's1', spawnflags: '1' }), v3(8, 8, 8));
    expect(always.shootable).toBe(true);
    expect(secretDie(always, 0)).toBe(true);
    expect(always.phase).toBe('back');
  });
});

describe('func_door_rotating (SP_func_door_rotating)', () => {
  it('swings 90 degrees about Z by default', () => {
    const rm = spawnRotDoor(rotEdict());
    expect([...rm.endAngles]).toEqual([0, 90, 0]);
    expect(rm.speed).toBe(100);
    expect(rm.state).toBe('bottom');
  });

  it('selects X/Y axes from spawnflags and honours REVERSE + distance', () => {
    const x = spawnRotDoor(rotEdict({ spawnflags: '64', distance: '45' }));
    expect([...x.endAngles]).toEqual([0, 0, 45]);
    const y = spawnRotDoor(rotEdict({ spawnflags: '128' }));
    expect([...y.endAngles]).toEqual([90, 0, 0]);
    const rev = spawnRotDoor(rotEdict({ spawnflags: '2' }));
    expect(rev.endAngles[0]!).toBeCloseTo(0, 9);
    expect(rev.endAngles[1]!).toBeCloseTo(-90, 9);
    expect(rev.endAngles[2]!).toBeCloseTo(0, 9);
  });

  it('START_OPEN rests open and closes when triggered', () => {
    const rm = spawnRotDoor(rotEdict({ spawnflags: '1' }));
    expect([...rm.ent.angles]).toEqual([0, 90, 0]);
    expect([...rm.startAngles]).toEqual([0, 90, 0]);
    expect([...rm.endAngles]).toEqual([0, 0, 0]);
    expect(rotUse(rm, 0)).toBe('opened');
    // Opening from the open rest pose travels toward closed (C reverse op).
    expect(rm.state).toBe('going_up');
  });

  it('travels at speed, tops, waits, then returns', () => {
    const rm = spawnRotDoor(rotEdict());
    expect(rotUse(rm, 0)).toBe('opened');
    let now = 0;
    for (let i = 0; i < 50 && rm.state !== 'top' && rm.state !== 'waiting'; i++) {
      now += 0.1;
      rotThink(rm, now, 0.1);
    }
    expect(rm.state).toBe('waiting');
    expect([...rm.ent.angles]).toEqual([0, 90, 0]);
    for (let i = 0; i < 200 && rm.state !== 'bottom'; i++) {
      now += 0.1;
      rotThink(rm, now, 0.1);
    }
    expect(rm.state).toBe('bottom');
    expect([...rm.ent.angles]).toEqual([0, 0, 0]);
  });

  it('flicks 10 degrees per tick at speed 100', () => {
    const rm = spawnRotDoor(rotEdict());
    rotUse(rm, 0);
    rotThink(rm, 0.1, 0.1);
    expect(rm.ent.angles[1]!).toBeCloseTo(10, 9);
  });

  it('plays start/end sounds unless sounds == 1', () => {
    const rm = spawnRotDoor(rotEdict());
    rotUse(rm, 0);
    expect(rm.silent).toBe(false);
    const quiet = spawnRotDoor(rotEdict({ sounds: '1' }));
    expect(quiet.silent).toBe(true);
    expect(rotThink(quiet, 0.1, 0.1)).toEqual([]);
    // Loud door arrives with the end sound.
    let now = 0;
    const heard: string[] = [];
    for (let i = 0; i < 50 && rm.state !== 'waiting' && rm.state !== 'top'; i++) {
      now += 0.1;
      heard.push(...rotThink(rm, now, 0.1));
    }
    expect(heard).toContain(DOOR_SOUND_END);
    expect(DOOR_SOUND_START).toBe('doors/dr1_strt.wav');
  });

  it('TOGGLE closes from the top without firing targets', () => {
    const rm = spawnRotDoor(rotEdict({ spawnflags: '32' }));
    expect(rotUse(rm, 0)).toBe('opened');
    let now = 0;
    for (let i = 0; i < 50 && rm.state !== 'top'; i++) {
      now += 0.1;
      rotThink(rm, now, 0.1);
    }
    expect(rm.state).toBe('top');
    expect(rotUse(rm, now)).toBe('closed');
    expect(rm.state).toBe('going_down');
  });

  it('resets the TOP wait when used at the top (non-toggle)', () => {
    const rm = spawnRotDoor(rotEdict({ wait: '3' }));
    rotGoUp(rm, 0);
    let now = 0;
    for (let i = 0; i < 50 && rm.state !== 'waiting'; i++) {
      now += 0.1;
      rotThink(rm, now, 0.1);
    }
    const first = rm.waitEnd;
    expect(rotGoUp(rm, first - 1)).toBe(false);
    expect(rm.waitEnd).toBeCloseTo(first - 1 + 3, 9);
  });

  it('blocked damage reverses unless CRUSHER or negative wait', () => {
    const rm = spawnRotDoor(rotEdict());
    rotGoUp(rm, 0);
    const hit = rotBlocked(rm, 'player', 1.0)!;
    expect(hit.dmg).toBe(2);
    expect(hit.crush).toBe(false);
    expect(hit.action).toBe('reverse');
    expect(rotBlocked(rm, 'player', 1.2)).toBeNull();
    rotReverse(rm, 1.6);
    expect(rm.state).toBe('going_down');
    const crusher = spawnRotDoor(rotEdict({ spawnflags: '4' }));
    expect(rotBlocked(crusher, 'monster', 0)!.action).toBe('continue');
    const neg = spawnRotDoor(rotEdict({ wait: '-1' }));
    expect(rotBlocked(neg, 'player', 0)!.action).toBe('continue');
    const debris = rotBlocked(rm, 'other', 5.0)!;
    expect(debris).toEqual({ dmg: CRUSH_DAMAGE, crush: true, action: 'continue' });
  });

  it('rotGoDown/rotGoUp drive the legs directly', () => {
    const rm = spawnRotDoor(rotEdict());
    rotGoDown(rm, 3.0);
    expect(rm.state).toBe('going_down');
    expect(rm.legEnd).toBeCloseTo(3.0, 9); // already at start: zero travel
  });
});
