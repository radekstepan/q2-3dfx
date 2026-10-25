// M5.3: weapons + monsters + pathfinding.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHOTGUN_COUNT,
  GUNNER,
  MELEE_DISTANCE,
  RANGE_FAR,
  RANGE_MELEE,
  RANGE_MID,
  RANGE_NEAR,
  SOLDIER,
  WEAPON_BLASTER,
  WEAPON_MACHINEGUN,
  WEAPON_SHOTGUN,
  findPath,
  findWeapon,
  fireWeapon,
  isReachable,
  monsterMoveOf,
  monsterRange,
  monsterThink,
  monsterPain,
  mulberry32,
  selectAttack,
  spawnMonster,
} from './index.js';

describe('weapons (M5.3)', () => {
  it('has correct damage/ammo/pellet/spread values', () => {
    expect(WEAPON_BLASTER.damage).toBe(15);
    expect(WEAPON_BLASTER.ammoKind).toBe('');
    expect(WEAPON_BLASTER.pellets).toBe(1);
    expect(WEAPON_SHOTGUN.damage).toBe(4);
    expect(WEAPON_SHOTGUN.pellets).toBe(DEFAULT_SHOTGUN_COUNT);
    expect(WEAPON_SHOTGUN.pellets).toBe(12);
    expect(WEAPON_SHOTGUN.hspread).toBe(1000);
    expect(WEAPON_SHOTGUN.vspread).toBe(500);
    expect(WEAPON_SHOTGUN.ammoKind).toBe('shells');
    expect(WEAPON_MACHINEGUN.damage).toBe(8);
    expect(WEAPON_MACHINEGUN.hspread).toBe(300);
    expect(WEAPON_MACHINEGUN.vspread).toBe(500);
    expect(WEAPON_MACHINEGUN.ammoKind).toBe('bullets');
    expect(findWeapon('weapon_railgun')).toBe(null);
  });

  it('shotgun fires 12 pellets and consumes 1 shell', () => {
    const r = fireWeapon(WEAPON_SHOTGUN, 10, mulberry32(1), false);
    expect(r.fired).toBe(true);
    expect(r.pellets.length).toBe(12);
    expect(r.ammoLeft).toBe(9);
    for (const p of r.pellets) {
      expect(p.damage).toBe(4);
      expect(Math.abs(p.r)).toBeLessThanOrEqual(1000);
      expect(Math.abs(p.u)).toBeLessThanOrEqual(500);
    }
  });

  it('quad damage multiplies pellet damage', () => {
    const r = fireWeapon(WEAPON_SHOTGUN, 10, mulberry32(2), true);
    expect(r.pellets[0]!.damage).toBe(16);
  });

  it('refuses to fire without ammo, blaster is infinite', () => {
    expect(fireWeapon(WEAPON_SHOTGUN, 0, mulberry32(3), false).fired).toBe(false);
    const b = fireWeapon(WEAPON_BLASTER, 0, mulberry32(4), false);
    expect(b.fired).toBe(true);
    expect(b.pellets.length).toBe(1);
    const mg = fireWeapon(WEAPON_MACHINEGUN, 5, mulberry32(5), false);
    expect(mg.fired).toBe(true);
    expect(mg.ammoLeft).toBe(4);
  });

  it('spread is deterministic for a given seed', () => {
    const a = fireWeapon(WEAPON_SHOTGUN, 50, mulberry32(99), false);
    const b = fireWeapon(WEAPON_SHOTGUN, 50, mulberry32(99), false);
    expect(a.pellets).toEqual(b.pellets);
  });
});

describe('monsters (M5.3)', () => {
  it('soldier + gunner tables have stand/walk/run/attack/pain/die frames', () => {
    for (const def of [SOLDIER, GUNNER]) {
      expect(Object.keys(def.moves).length).toBeGreaterThanOrEqual(6);
      for (const mv of Object.values(def.moves)) {
        expect(mv.frames.length).toBe(mv.last - mv.first + 1);
      }
    }
    expect(SOLDIER.health).toBe(30);
    expect(GUNNER.health).toBe(175);
  });

  it('range() thresholds match g_ai.c', () => {
    expect(monsterRange(MELEE_DISTANCE - 1)).toBe(RANGE_MELEE);
    expect(monsterRange(100)).toBe(RANGE_NEAR);
    expect(monsterRange(700)).toBe(RANGE_MID);
    expect(monsterRange(5000)).toBe(RANGE_FAR);
  });

  it('selects melee in melee range, ranged otherwise', () => {
    expect(selectAttack('soldier', 10, mulberry32(1))).toBe('melee');
    expect(selectAttack('gunner', 10, mulberry32(1))).toBe('melee');
    const s = selectAttack('soldier', 200, mulberry32(7));
    expect(s === 'shotgun' || s === 'blaster').toBe(true);
    const g = selectAttack('gunner', 200, mulberry32(7));
    expect(g === 'chaingun' || g === 'grenade').toBe(true);
    expect(selectAttack('soldier', 5000, mulberry32(1))).toBe('none');
  });

  it('monster think advances frames and loops moves', () => {
    const m = spawnMonster('soldier');
    const first = m.move;
    for (let i = 0; i < 30; i++) monsterThink(m);
    // stand1 has 30 frames then loops to itself
    expect(m.move).toBe(first);
  });

  it('pain + death transitions work', () => {
    const m = spawnMonster('gunner');
    monsterPain(m, 10, mulberry32(1));
    expect(m.dead).toBe(false);
    expect(m.health).toBe(165);
    monsterPain(m, 1000, mulberry32(1));
    expect(m.dead).toBe(true);
    expect(monsterThink(m)).toBe('dead');
  });

  it('every move fits inside its MD2 (soldier 475 / gunner 209 frames)', () => {
    // The web driver maps entityFrame = move.first + frameOffset, so first
    // must already be the MD2 frame index and last must stay in the model.
    for (const mv of Object.values(SOLDIER.moves)) {
      expect(mv.last).toBeLessThan(475);
    }
    expect(SOLDIER.moves['death1']!.first).toBe(272); // id FRAME_death101
    for (const mv of Object.values(GUNNER.moves)) {
      expect(mv.last).toBeLessThan(209);
    }
    expect(GUNNER.moves['death']!.last).toBe(200); // id FRAME_death11
  });

  it('gunner fire_chain exits to endfire_chain (no dangling move)', () => {
    const m = spawnMonster('gunner');
    m.move = 'attack_chain';
    for (let i = 0; i < 7; i++) monsterThink(m);
    expect(m.move).toBe('fire_chain');
    for (let i = 0; i < 8; i++) {
      // every frame of the burst must resolve to a known move
      expect(() => monsterMoveOf(m)).not.toThrow();
      monsterThink(m);
    }
    expect(m.move).toBe('endfire_chain');
    expect(() => monsterMoveOf(m)).not.toThrow();
  });
});

describe('pathfinding stub (M5.3)', () => {
  it('BFS finds the shortest path over a portal graph', () => {
    const g = new Map([
      [0, [1, 2]],
      [1, [3]],
      [2, [3]],
      [3, [4]],
      [4, []],
    ]);
    const p = findPath(g, 0, 4);
    expect(p).not.toBe(null);
    expect(p![0]).toBe(0);
    expect(p![p!.length - 1]).toBe(4);
    expect(p!.length).toBe(4);
    expect(isReachable(g, 4, 0)).toBe(false);
    expect(findPath(g, 0, 0)).toEqual([0]);
  });
});
