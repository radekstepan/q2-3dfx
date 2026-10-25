// M5.2: entities lump parsing, items, doors/buttons/triggers.
import { describe, expect, it } from 'vitest';
import {
  findByClassname,
  makePlayerState,
  moverThink,
  moverUse,
  parseEntities,
  pickupItem,
  resetEdictNums,
  spawnButton,
  spawnDoor,
  spawnEdict,
  spawnPlat,
  spawnTrigger,
  teleportTo,
  triggerTouch,
  useTargets,
} from './index.js';

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
