// M5.3: weapons + monsters + pathfinding.
import { describe, expect, it } from 'vitest';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import type { TraceFn } from './pmove.js';
import {
  BLASTER_DAMAGE_SP,
  BLASTER_INFLIGHT_COLOR,
  BLASTER_INFLIGHT_LIGHT,
  BLASTER_SPAWN_FWD,
  BLASTER_SPAWN_RIGHT,
  BLASTER_TRAIL_COLOR,
  BOLT_EJECT_MAX,
  DEFAULT_SHOTGUN_COUNT,
  DEFAULT_SHOTGUN_HSPREAD,
  DEFAULT_SHOTGUN_VSPREAD,
  DEFAULT_BULLET_HSPREAD,
  DEFAULT_BULLET_VSPREAD,
  GREEN_COLOR_BASE,
  GREEN_COLOR_END,
  GUNNER,
  MELEE_DISTANCE,
  MUZZLE_LIGHT_COLOR,
  MUZZLE_LIGHT_INTENSITY,
  RANGE_FAR,
  RANGE_MELEE,
  RANGE_MID,
  RANGE_NEAR,
  SOLDIER,
  SOLDIER_WEAPON_STATS,
  WEAPON_BLASTER,
  WEAPON_MACHINEGUN,
  WEAPON_SHOTGUN,
  YELLOW_COLOR_BASE,
  YELLOW_COLOR_END,
  attackFiresBolt,
  blasterMuzzle,
  blasterSpawn,
  findPath,
  findWeapon,
  fireWeapon,
  isGreenBoltColor,
  isReachable,
  monsterMoveOf,
  monsterRange,
  monsterThink,
  monsterPain,
  mulberry32,
  muzzleRadius,
  resolveBoltSpawn,
  selectAttack,
  selectSoldierAttack,
  soldierWeaponForSkin,
  spawnMonster,
  weaponFiresBeam,
} from './index.js';

describe('weapons (M5.3)', () => {
  it('has correct damage/ammo/pellet/spread values', () => {
    expect(WEAPON_BLASTER.damage).toBe(10);
    expect(WEAPON_BLASTER.ammoKind).toBe('');
    expect(WEAPON_BLASTER.pellets).toBe(1);
    expect(WEAPON_SHOTGUN.damage).toBe(4);
    expect(WEAPON_SHOTGUN.pellets).toBe(DEFAULT_SHOTGUN_COUNT);
    expect(WEAPON_SHOTGUN.pellets).toBe(12);
    // C weapon_shotgun_fire passes literal 500, 500 (SP and DM) — NOT the
    // 1000 DEFAULT_SHOTGUN_HSPREAD (monster shotgun only).
    expect(WEAPON_SHOTGUN.hspread).toBe(500);
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
      expect(Math.abs(p.r)).toBeLessThanOrEqual(500);
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
    // Corpses keep playing the death move (action of the current death
    // frame), advancing to the last frame and holding — never 'dead'.
    expect(monsterThink(m)).toBe('move');
    expect(m.move).toBe('death');
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

describe('blaster ballistics (M7.2 batch #3 regressions)', () => {
  it('SP damage 10 (15 only in deathmatch), speed 1000, life 2s, 0xe0 trail', () => {
    expect(WEAPON_BLASTER.damage).toBe(10);
    expect(WEAPON_BLASTER.damage).toBe(BLASTER_DAMAGE_SP);
    const r = fireWeapon(WEAPON_BLASTER, 0, mulberry32(1), false);
    expect(r.bolt!.speed).toBe(1000);
    expect(r.bolt!.life).toBe(2);
    expect(r.bolt!.effect).toBe(0x08); // EF_BLASTER
    expect(BLASTER_TRAIL_COLOR).toBe(0xe0);
  });

  it('spawn = G_ProjectSource from feet (+fwd*24 +right*8, z += viewheight-8)', () => {
    expect(BLASTER_SPAWN_FWD).toBe(24);
    expect(BLASTER_SPAWN_RIGHT).toBe(8);
    const feet = v3(128, -320, 32);
    const fwd = v3(1, 0, 0);
    const right = v3(0, 1, 0);
    // eye height 22 (pmove viewheight): z = 32 + 22 - 8
    expect([...blasterSpawn(feet, fwd, right, 22)]).toEqual([152, -312, 46]);
  });

  it('muzzle dlight = feet+fwd*18+right*16, 200+(rand&31), pure yellow', () => {
    const feet = v3(128, -320, 32);
    expect([...blasterMuzzle(feet, v3(1, 0, 0), v3(0, 1, 0))]).toEqual([146, -304, 32]);
    expect(muzzleRadius(() => 0)).toBe(200);
    expect(muzzleRadius(() => 0.9999)).toBe(231);
    expect(MUZZLE_LIGHT_INTENSITY).toBe(200);
    expect(MUZZLE_LIGHT_COLOR).toEqual([1, 1, 0]);
  });

  it('in-flight bolts carry a 200-yellow dlight (EF_BLASTER trail look)', () => {
    expect(BLASTER_INFLIGHT_LIGHT).toBe(200);
    expect(BLASTER_INFLIGHT_COLOR).toEqual([1, 1, 0]);
  });

  it('no beam for blaster/shotgun/machinegun (only railgun draws TE_RAILTRAIL)', () => {
    expect(weaponFiresBeam('weapon_blaster')).toBe(false);
    expect(weaponFiresBeam('weapon_shotgun')).toBe(false);
    expect(weaponFiresBeam('weapon_machinegun')).toBe(false);
  });
});

describe('green soldier bolt regression (M7.2 user report)', () => {
  it('soldier weapon is skin-determined (m_soldier.c soldier_fire), not random', () => {
    expect(soldierWeaponForSkin(0)).toBe('blaster'); // monster_soldier_light
    expect(soldierWeaponForSkin(1)).toBe('blaster');
    expect(soldierWeaponForSkin(2)).toBe('shotgun'); // basic monster_soldier
    expect(soldierWeaponForSkin(3)).toBe('shotgun');
    expect(soldierWeaponForSkin(4)).toBe('machinegun'); // monster_soldier_ss
    expect(soldierWeaponForSkin(5)).toBe('machinegun');
  });

  it('basic (shotgun-skin) soldiers never select the blaster attack', () => {
    for (let seed = 0; seed < 50; seed++) {
      const rand = mulberry32(seed);
      for (const dist of [80, 100, 200, 500, 999]) {
        const choice = selectSoldierAttack(2, dist, rand);
        expect(choice).not.toBe('blaster');
        expect(choice).not.toBe('none');
      }
      // ...and never at any range where they fight
      expect(selectSoldierAttack('shotgun', 200, rand)).toBe('shotgun');
    }
    // melee still commits up close; far targets are closed in on (none)
    expect(selectSoldierAttack(2, 10, mulberry32(1))).toBe('melee');
    expect(selectSoldierAttack(2, 5000, mulberry32(1))).toBe('none');
    // light soldiers keep their authentic bolt; ss soldiers keep bullets
    expect(selectSoldierAttack(0, 200, mulberry32(1))).toBe('blaster');
    expect(selectSoldierAttack(4, 200, mulberry32(1))).toBe('machinegun');
  });

  it('only the soldier blaster attack spawns a bolt entity — hitscan never does', () => {
    expect(attackFiresBolt('soldier', 'blaster')).toBe(true);
    for (const c of ['shotgun', 'machinegun', 'melee', 'none']) {
      expect(attackFiresBolt('soldier', c)).toBe(false);
    }
    for (const c of ['blaster', 'chaingun', 'grenade', 'melee', 'shotgun', 'none']) {
      expect(attackFiresBolt('gunner', c)).toBe(false);
    }
  });

  it('no bolt or tracer color lives in the green 0xd0 range (the reported bug)', () => {
    // yellow family (blaster trail, boom sparks) is 0xe0-0xe7
    expect(YELLOW_COLOR_BASE).toBe(0xe0);
    expect(YELLOW_COLOR_END).toBe(0xe8);
    expect(GREEN_COLOR_BASE).toBe(0xd0);
    expect(GREEN_COLOR_END).toBe(0xd7);
    expect(isGreenBoltColor(0xe0)).toBe(false);
    expect(isGreenBoltColor(0xe1)).toBe(false);
    expect(isGreenBoltColor(225)).toBe(false); // blaster tracer orange
    expect(isGreenBoltColor(215)).toBe(false); // near-white core
    expect(isGreenBoltColor(208)).toBe(true); // the old PELLET green: banned
    expect(isGreenBoltColor(0xd0)).toBe(true);
    expect(isGreenBoltColor(214)).toBe(true); // last green shade (0xd6)
    expect(isGreenBoltColor(0xd7)).toBe(false); // 215 is the near-white core
    expect(BLASTER_TRAIL_COLOR).toBeGreaterThanOrEqual(YELLOW_COLOR_BASE);
    expect(BLASTER_TRAIL_COLOR).toBeLessThan(YELLOW_COLOR_END);
  });
});

describe('Phase 2 combat numbers (C audit)', () => {
  it('player SP shotgun is the tight 500/500 gun, not the monster 1000 spread', () => {
    // p_weapon.c weapon_shotgun_fire: fire_shotgun(..., 500, 500,
    // DEFAULT_SHOTGUN_COUNT, ...) in SP and DM alike. The 1000-wide
    // DEFAULT_SHOTGUN_HSPREAD is the MONSTER shotgun arg (m_soldier.c
    // soldier_fire) — SOLDIER_WEAPON_STATS.shotgun keeps it; the player
    // table must not.
    expect(WEAPON_SHOTGUN.hspread).toBe(500);
    expect(WEAPON_SHOTGUN.vspread).toBe(DEFAULT_SHOTGUN_VSPREAD);
    expect(WEAPON_SHOTGUN.damage).toBe(4);
    expect(WEAPON_SHOTGUN.pellets).toBe(12);
    // monster table for contrast (m_soldier.c: dmg 2, kick 1, 12 pellets)
    expect(SOLDIER_WEAPON_STATS['shotgun']).toMatchObject({
      damage: 2,
      kick: 1,
      pellets: 12,
      hspread: DEFAULT_SHOTGUN_HSPREAD,
    });
    expect(DEFAULT_SHOTGUN_HSPREAD).toBe(1000);
  });

  it('player machinegun is flat 8dmg/2kick (p_weapon.c Machinegun_Fire)', () => {
    expect(WEAPON_MACHINEGUN.damage).toBe(8);
    expect(WEAPON_MACHINEGUN.kick).toBe(2);
    expect(WEAPON_MACHINEGUN.hspread).toBe(DEFAULT_BULLET_HSPREAD);
    expect(WEAPON_MACHINEGUN.vspread).toBe(DEFAULT_BULLET_VSPREAD);
  });

  it('resolveBoltSpawn leaves a free muzzle exactly where it is', () => {
    const clear: TraceFn = (start, _mins, _maxs, end) => ({
      fraction: 1,
      endpos: v3(end[0], end[1], end[2]),
      planeNormal: v3(0, 0, 1),
      allsolid: false,
      startsolid: false,
      entityNum: -1,
      contents: 0,
    });
    const spawn = v3(4, -8, 14);
    const r = resolveBoltSpawn(clear, v3(1, 0, 0), spawn);
    expect(r.embedded).toBe(false);
    expect([...r.pos]).toEqual([...spawn]);
  });

  it('resolveBoltSpawn ejects an embedded muzzle forward to free space', () => {
    // Abutting-slab seam (traceBox semantics): slab A x in [0,8], slab B x
    // in [8,16]. A position test is startsolid inside either; a segment
    // takes the minimum slab-entry fraction, so a step starting inside A
    // and crossing B reports fraction < 1 (the pre-fix muzzle detonation).
    const solid = (p: Vec3): boolean => p[0]! >= 0 && p[0]! <= 16;
    const slabFrac = (s: number, e: number, lo: number, hi: number): number => {
      const d = e - s;
      if (Math.abs(d) < 1e-9) return s >= lo && s <= hi ? 0 : 1;
      let t0 = (lo - s) / d;
      let t1 = (hi - s) / d;
      if (t0 > t1) [t0, t1] = [t1, t0];
      if (t1 < 0 || t0 > 1) return 1;
      return Math.max(0, t0);
    };
    const seam: TraceFn = (start, _mins, _maxs, end) => {
      const f = Math.min(
        slabFrac(start[0]!, end[0]!, 0, 8),
        slabFrac(start[0]!, end[0]!, 8, 16),
      );
      return {
        fraction: f,
        endpos: v3(start[0]! + (end[0]! - start[0]!) * f, end[1], end[2]),
        planeNormal: v3(-1, 0, 0),
        allsolid: false,
        startsolid: solid(start),
        entityNum: -1,
        contents: 0,
      };
    };
    // Muzzle 4u inside the seam: a raw first step detonates at the abutment.
    const raw = seam(v3(4, 0, 0), v3(0, 0, 0), v3(0, 0, 0), v3(104, 0, 0));
    expect(raw.startsolid).toBe(true);
    expect(raw.fraction).toBeLessThan(1);
    // Ejection walks forward out of both slabs; the flight then runs clean.
    const r = resolveBoltSpawn(seam, v3(1, 0, 0), v3(4, 0, 0));
    expect(r.embedded).toBe(false);
    expect(r.pos[0]!).toBeGreaterThan(16);
    expect(r.pos[0]!).toBeLessThanOrEqual(17);
    const flight = seam(r.pos, v3(0, 0, 0), v3(0, 0, 0), v3(r.pos[0]! + 100, 0, 0));
    expect(flight.fraction).toBe(1);
    expect(flight.startsolid).toBe(false);
  });

  it('resolveBoltSpawn reports embedded past the cap (thick wall: C detonates)', () => {
    const deep: TraceFn = (start, _mins, _maxs, end) => ({
      fraction: 1,
      endpos: v3(end[0], end[1], end[2]),
      planeNormal: v3(0, 0, 1),
      allsolid: false,
      // solid everywhere within the cap: a whole wall, not a seam sliver
      startsolid: start[0]! < BOLT_EJECT_MAX + 10,
      entityNum: -1,
      contents: 0,
    });
    const r = resolveBoltSpawn(deep, v3(1, 0, 0), v3(0, 0, 0));
    expect(r.embedded).toBe(true);
  });
});
