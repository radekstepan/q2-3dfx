// M5.2: entities lump parsing, items, doors/buttons/triggers.
import { describe, expect, it } from 'vitest';
import { v3 } from '@q2/math';
import {
  attackMoveFor,
  DoRespawn,
  findByClassname,
  isRespawning,
  makePlayerState,
  monsterChaseMove,
  monsterDef,
  moverThink,
  moverUse,
  mulberry32,
  parseEntities,
  pickupItem,
  respawnDelayFor,
  resetEdictNums,
  SetRespawn,
  SOLID_NOT,
  SOLID_TRIGGER,
  spawnButton,
  spawnDoor,
  spawnEdict,
  spawnMonster,
  spawnPlat,
  spawnTrigger,
  SV_Push,
  teleportTo,
  triggerTouch,
  useTargets,
} from './index.js';
import type { PushRider } from './index.js';

const MINI_LUMP = `
// base1-style entities
{
"classname" "worldspawn"
"message" "base1: Outer Base"
"sky" "unit1_"
}
{
"classname" "func_door"
"targetname" "door1"
"target" "t1"
"angle" "0"
"speed" "100"
"wait" "3"
"lip" "8"
"origin" "0 0 0"
}
{
"classname" "func_button"
"target" "door1"
"angle" "0"
"origin" "64 0 0"
}
{
"classname" "trigger_once"
"target" "door1"
"origin" "32 0 0"
}
`;

describe('entity string parser (M5.2)', () => {
  it('parses key/value blocks like a BSP entities lump', () => {
    resetEdictNums();
    const dicts = parseEntities(MINI_LUMP);
    expect(dicts.length).toBe(4);
    expect(dicts[0]!['classname']).toBe('worldspawn');
    expect(dicts[1]!['angle']).toBe('0');
    expect(dicts[1]!['origin']).toBe('0 0 0');
    const edicts = dicts.map(spawnEdict);
    expect(findByClassname(edicts, 'func_door').length).toBe(1);
    const door = findByClassname(edicts, 'trigger_once')[0]!;
    expect(door.target).toBe('door1');
  });

  it('handles empty input and stray text', () => {
    expect(parseEntities('')).toEqual([]);
    expect(parseEntities('// comment only\n').length).toBe(0);
  });
});

describe('items (M5.2)', () => {
  it('health respects max cap', () => {
    const ps = makePlayerState();
    ps.health = 95;
    const r = pickupItem(ps, 'item_health');
    expect(r.picked).toBe(true);
    expect(ps.health).toBe(100);
    const r2 = pickupItem(ps, 'item_health');
    expect(r2.picked).toBe(false);
  });

  it('ammo accumulates to cap', () => {
    const ps = makePlayerState();
    const r = pickupItem(ps, 'ammo_shells');
    expect(r.picked).toBe(true);
    expect(ps.ammo['shells']).toBe(10);
  });

  it('weapon pickup grants weapon + ammo', () => {
    const ps = makePlayerState();
    const r = pickupItem(ps, 'weapon_shotgun');
    expect(r.picked).toBe(true);
    expect(ps.weapons).toContain('weapon_shotgun');
    expect(ps.ammo['shells']).toBeGreaterThan(0);
  });

  it('rejects unknown items', () => {
    expect(pickupItem(makePlayerState(), 'item_nope').picked).toBe(false);
  });
});

describe('doors, plats, buttons, triggers (M5.2)', () => {
  it('scripted base1-logic: button use drives door to its end pos', () => {
    resetEdictNums();
    const dicts = parseEntities(MINI_LUMP);
    const list = dicts.map(spawnEdict);
    const doorEnt = findByClassname(list, 'func_door')[0]!;
    const door = spawnDoor(doorEnt, 0, 128);
    expect(door.state).toBe('bottom');

    // wire: button.use -> useTargets -> door moverUse
    let now = 0;
    useTargets(list, findByClassname(list, 'func_button')[0]!, (target) => {
      if (target === doorEnt) moverUse(door, now);
    });
    expect(door.state).toBe('going_up');

    // tick at 10Hz until the door reaches the top
    for (let i = 0; i < 40 && door.state !== 'top' && door.state !== 'waiting'; i++) {
      now += 0.1;
      moverThink(door, now);
    }
    expect(door.ent.origin[0]).toBeCloseTo(door.pos2[0]!, 6);
    expect(door.state === 'top' || door.state === 'waiting').toBe(true);
  });

  it('door waits then returns', () => {
    resetEdictNums();
    const e = spawnEdict({ classname: 'func_door', speed: '1000', wait: '0.3' });
    const door = spawnDoor(e, 0, 100);
    moverUse(door, 0);
    let now = 0;
    for (let i = 0; i < 200 && door.state !== 'bottom'; i++) {
      now += 0.1;
      moverThink(door, now);
      if (door.state === 'top' || door.state === 'waiting') break;
    }
    // after wait elapses it heads back down
    for (let i = 0; i < 200 && door.state !== 'bottom'; i++) {
      now += 0.1;
      moverThink(door, now);
    }
    expect(door.state).toBe('bottom');
    expect(door.ent.origin[0]).toBeCloseTo(door.pos1[0]!, 6);
  });

  it('plat rises the full height', () => {
    resetEdictNums();
    const e = spawnEdict({ classname: 'func_plat', speed: '200' });
    const plat = spawnPlat(e, 160);
    moverUse(plat, 0);
    let now = 0;
    for (let i = 0; i < 60 && plat.state !== 'top' && plat.state !== 'waiting'; i++) {
      now += 0.1;
      moverThink(plat, now);
    }
    expect(plat.ent.origin[2]).toBeCloseTo(plat.pos2[2]!, 6);
  });

  it('button fires then resets to bottom', () => {
    resetEdictNums();
    const e = spawnEdict({ classname: 'func_button', speed: '400', wait: '0.2' });
    const btn = spawnButton(e, 0);
    moverUse(btn, 0);
    let now = 0;
    for (let i = 0; i < 100 && btn.state !== 'bottom'; i++) {
      now += 0.1;
      moverThink(btn, now);
    }
    expect(btn.state).toBe('bottom');
  });

  it('trigger_once fires exactly once', () => {
    resetEdictNums();
    const e = spawnEdict({ classname: 'trigger_once', target: 'door1' });
    const t = spawnTrigger(e);
    let fires = 0;
    expect(triggerTouch(t, 0, 'player', () => fires++)).toBe(true);
    expect(triggerTouch(t, 1, 'player', () => fires++)).toBe(false);
    expect(fires).toBe(1);
  });

  it('trigger_multiple refires after wait', () => {
    resetEdictNums();
    const e = spawnEdict({ classname: 'trigger_multiple', wait: '1' });
    const t = spawnTrigger(e);
    let fires = 0;
    expect(triggerTouch(t, 0, 'player', () => fires++)).toBe(true);
    expect(triggerTouch(t, 0.5, 'player', () => fires++)).toBe(false);
    expect(triggerTouch(t, 1.5, 'player', () => fires++)).toBe(true);
    expect(fires).toBe(2);
  });

  it('trigger touch gate matches id Touch_Multi (MONSTER/NOT_PLAYER bits)', () => {
    // id g_trigger.c: players fire unless NOT_PLAYER (2); monsters fire only
    // with MONSTER (1); anything else never fires.
    resetEdictNums();
    const plain = spawnTrigger(spawnEdict({ classname: 'trigger_multiple' }));
    let fires = 0;
    const fire = (): void => {
      fires++;
    };
    expect(triggerTouch(plain, 0, 'player', fire)).toBe(true);
    expect(triggerTouch(plain, 1, 'monster', fire)).toBe(false); // no MONSTER bit
    expect(triggerTouch(plain, 2, 'grenade', fire)).toBe(false);
    resetEdictNums();
    const monstrous = spawnTrigger(spawnEdict({ classname: 'trigger_multiple', spawnflags: '1' }));
    expect(triggerTouch(monstrous, 0, 'monster', fire)).toBe(true);
    resetEdictNums();
    const noPlayers = spawnTrigger(spawnEdict({ classname: 'trigger_multiple', spawnflags: '2' }));
    expect(triggerTouch(noPlayers, 0, 'player', fire)).toBe(false);
    expect(fires).toBe(2);
  });

  it('teleporter relocates the entity', () => {
    resetEdictNums();
    const who = spawnEdict({ classname: 'player', origin: '0 0 0' });
    const dest = spawnEdict({
      classname: 'misc_teleporter_dest',
      origin: '100 200 300',
      angles: '0 90 0',
    });
    teleportTo(who, dest);
    expect(who.origin[0]).toBe(100);
    expect(who.origin[1]).toBe(200);
    expect(who.origin[2]).toBe(310);
    expect(who.velocity[0]).toBe(0);
  });
});

describe('pickup respawn (M7.4, g_items.c DoRespawn/SetRespawn)', () => {
  it('id delay table: 30s weapons/health/ammo, 20s armor', () => {
    expect(respawnDelayFor('weapon_shotgun')).toBe(30);
    expect(respawnDelayFor('weapon_machinegun')).toBe(30);
    expect(respawnDelayFor('ammo_shells')).toBe(30);
    expect(respawnDelayFor('ammo_bullets')).toBe(30);
    expect(respawnDelayFor('item_health')).toBe(30);
    expect(respawnDelayFor('item_health_large')).toBe(30);
    expect(respawnDelayFor('item_armor_combat')).toBe(20);
    expect(respawnDelayFor('item_armor_shard')).toBe(20);
  });

  it('SetRespawn hides, DoRespawn re-materializes on level.time', () => {
    resetEdictNums();
    const e = spawnEdict({ classname: 'weapon_shotgun' });
    const at = SetRespawn(e, respawnDelayFor(e.classname), 100);
    expect(at).toBe(130);
    expect(e.solid).toBe(SOLID_NOT);
    expect(isRespawning(e)).toBe(true);
    // not due yet (tick-based level.time, never wall-clock)
    expect(DoRespawn(e, 129.9)).toBe(false);
    expect(e.solid).toBe(SOLID_NOT);
    expect(DoRespawn(e, 130)).toBe(true);
    expect(e.solid).toBe(SOLID_TRIGGER);
    expect(isRespawning(e)).toBe(false);
    // no timer armed: no-op
    expect(DoRespawn(e, 200)).toBe(false);
  });

  it('armor respawns after 20s', () => {
    resetEdictNums();
    const e = spawnEdict({ classname: 'item_armor_combat' });
    SetRespawn(e, respawnDelayFor(e.classname), 0);
    expect(DoRespawn(e, 19.9)).toBe(false);
    expect(DoRespawn(e, 20)).toBe(true);
  });
});

describe('SV_Push carrying (M7.4, g_phys.c)', () => {
  it('carries riders standing on the pusher, ignores the rest', () => {
    resetEdictNums();
    const door = spawnDoor(spawnEdict({ classname: 'func_door' }), -2, 156);
    const rider: PushRider = {
      origin: v3(0, 0, 276),
      mins: v3(-16, -16, -24),
      maxs: v3(16, 16, 32),
      groundEntity: door.ent.num,
    };
    const bystander: PushRider = {
      origin: v3(500, 0, 0),
      mins: v3(-16, -16, -24),
      maxs: v3(16, 16, 32),
      groundEntity: -1,
    };
    const ok = SV_Push(door, v3(0, 0, -10), [rider, bystander], () => false);
    expect(ok).toBe(true);
    expect(door.ent.origin[2]).toBeCloseTo(-10, 6);
    expect(rider.origin[2]).toBeCloseTo(266, 6);
    expect(bystander.origin[0]).toBe(500);
  });

  it('quantizes the step to 1/8 units like id', () => {
    resetEdictNums();
    const door = spawnDoor(spawnEdict({ classname: 'func_door' }), 0, 128);
    const rider: PushRider = {
      origin: v3(0, 0, 0),
      mins: v3(-16, -16, -24),
      maxs: v3(16, 16, 32),
      groundEntity: door.ent.num,
    };
    SV_Push(door, v3(0.1, 0, 0), [rider], () => false);
    expect(door.ent.origin[0]).toBeCloseTo(0.125, 6);
    expect(rider.origin[0]).toBeCloseTo(0.125, 6);
  });

  it('rolls everything back when a rider ends up stuck', () => {
    resetEdictNums();
    const door = spawnDoor(spawnEdict({ classname: 'func_door' }), -2, 156);
    const rider: PushRider = {
      origin: v3(0, 0, 276),
      mins: v3(-16, -16, -24),
      maxs: v3(16, 16, 32),
      groundEntity: door.ent.num,
    };
    // destination stuck, pre-push spot free: rider stays, pusher still moves
    // (C only vetoes when the rider is stuck at BOTH spots).
    const ok = SV_Push(door, v3(0, 0, -10), [rider], (o) => o[2]! < 276);
    expect(ok).toBe(true);
    expect(door.ent.origin[2]).toBeCloseTo(-10, 6);
    expect(rider.origin[2]).toBeCloseTo(276, 6);
    // stuck at both spots: full rollback, push fails (blocked path).
    const ok2 = SV_Push(door, v3(0, 0, -10), [rider], () => true);
    expect(ok2).toBe(false);
    expect(door.ent.origin[2]).toBeCloseTo(-10, 6);
    expect(rider.origin[2]).toBeCloseTo(276, 6);
  });
});

describe('monster navigation (M7.4, node graph)', () => {
  const positions = new Map([
    [0, v3(0, 0, 0)],
    [1, v3(100, 0, 0)],
    [2, v3(200, 0, 0)],
    [3, v3(200, 100, 0)],
  ]);
  const graph = new Map([
    [0, [1]],
    [1, [0, 2]],
    [2, [1, 3]],
    [3, [2]],
  ]);
  const nav = { graph, positions };

  it('soldier closes along the graph when it cannot see the player', () => {
    const ms = spawnMonster('soldier');
    const res = monsterChaseMove(ms, v3(0, 0, 0), v3(200, 5, 0), nav, false, mulberry32(7));
    expect(res.move).toBe('run');
    expect(ms.move).toBe('run');
    expect(res.path).toEqual([0, 1, 2]);
    expect(res.target?.[0]).toBe(100);
  });

  it('melee range commits to the attack move', () => {
    const ms = spawnMonster('soldier');
    const res = monsterChaseMove(ms, v3(0, 0, 0), v3(10, 0, 0), nav, true, mulberry32(7));
    expect(res.path).toBe(null);
    expect(ms.move).toBe(attackMoveFor('soldier', 'melee'));
    expect(monsterDef('soldier').moves[ms.move]).toBeDefined();
  });

  it('holds stand when the player node is unreachable', () => {
    const ms = spawnMonster('gunner');
    const island = {
      graph: new Map([[9, []]]),
      positions: new Map([[0, v3(0, 0, 0)], [9, v3(900, 0, 0)]]),
    };
    const res = monsterChaseMove(ms, v3(0, 0, 0), v3(900, 0, 0), island, false, mulberry32(7));
    expect(res.move).toBe('stand');
    expect(res.path).toBe(null);
  });

  it('gunner sprays while closing a visible far target', () => {
    const ms = spawnMonster('gunner');
    // dist 700 = MID range (visible but beyond the 0.7 attack-commit roll)
    const res = monsterChaseMove(ms, v3(0, 0, 0), v3(700, 0, 0), nav, true, () => 0.99);
    expect(res.move).toBe('runandshoot');
    expect(res.path).not.toBe(null);
  });
});
