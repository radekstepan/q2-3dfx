// Soldier fire color + machinegun behavior (M7.2 batch #5, game-side).
//
// TRACER COLOR NOTE — why no soldier shot is ever green, and what the web
// lane must consume:
//
// * Palette ground truth (real pak0.pak pics/colormap.pcx, last-769-byte
//   VGA palette): 208-214 (0xd0-0xd6) are GREEN — 208 itself is pure
//   (0,255,0); 215 (0xd7) is the near-white (255,255,255) beam core; the
//   0xe0-0xe7 ramp is yellow-orange (0xe0 = (255,171,7)) darkening to
//   red-orange at 0xe8+ ((155,31,0)).
// * C ground truth (external/quake-2-source, read-only): machinegun/shotgun
//   are HITSCAN (g_weapon.c fire_lead -> TE_GUNSHOT/TE_SHOTGUN temp
//   entities, never a projectile); only the blaster spawns a bolt entity
//   (fire_blaster, EF_BLASTER, cl_fx.c trail fixed 0xe0). Q2 tracers/impacts
//   live in the yellow-orange family; 0xd0 green is teleport/BFG/login FX.
// * The bug: apps/web/src/play.ts PELLET_TRACER_COLOR = 208 (green) is used
//   at the monster return-fire call site (queueTracer, monsterFire ~:1516)
//   and the player shotgun queue call site (~:1880s), so basic soldiers
//   (shotgun skins) drew green "laser" streaks. The web lane owns that file
//   (out of this lock) and must switch those two call sites to
//   HITSCAN_TRACER_COLOR below (225 = 0xe1 = (255,147,0), the same orange
//   the blaster beam already uses as BLASTER_TRACER_COLOR).
// * Game-side contract pinned here: every soldier fire path resolves
//   through soldierFireEvent(); hitscan weapons (shotgun, machinegun)
//   carry tracerColor HITSCAN_TRACER_COLOR, the blaster carries boltTrail
//   0xe0 and firesBolt, and NOTHING anywhere in this package emits 208-214
//   as a bolt or tracer color. isGreenBoltColor() is the ban predicate.
// * Machinegun soldiers (base1 HAS them — its "machine gunners" are
//   monster_soldier_ss skins, and base1 contains ZERO monster_gunner):
//   m_soldier.c soldier_fire picks by skinnum (<=1 blaster bolt 5dmg@600,
//   <=3 shotgun 2dmg x12, else machinegun bullet 2dmg kick4 spread
//   300/500), single bullet per trigger with an AI_HOLD_FRAME burst hold
//   of (3+rand%8) frames, solatck3.wav. SOLDIER_WEAPON_STATS pins it.
import { describe, expect, it } from 'vitest';
import {
  BLASTER_TRAIL_COLOR,
  DEFAULT_BULLET_HSPREAD,
  DEFAULT_BULLET_VSPREAD,
  DEFAULT_SHOTGUN_COUNT,
  DEFAULT_SHOTGUN_HSPREAD,
  DEFAULT_SHOTGUN_VSPREAD,
  GREEN_COLOR_BASE,
  GREEN_COLOR_END,
  HITSCAN_TRACER_COLOR,
  SOLDIER_COCK_SOUND,
  SOLDIER_MACHINEGUN_BURST_MAX_FRAMES,
  SOLDIER_MACHINEGUN_BURST_MIN_FRAMES,
  SOLDIER_WEAPON_STATS,
  YELLOW_COLOR_BASE,
  YELLOW_COLOR_END,
  attackFiresBolt,
  attackMoveFor,
  isAttackMove,
  isGreenBoltColor,
  monsterMoveOf,
  selectAttack,
  selectSoldierAttack,
  soldierFireEvent,
  soldierMachinegunBurstFrames,
  soldierWeaponForSkin,
  spawnMonster,
  mulberry32,
} from './index.js';

describe('hitscan tracer color (green-bolt fix source of truth)', () => {
  it('HITSCAN_TRACER_COLOR is C-correct orange 225, never green', () => {
    expect(HITSCAN_TRACER_COLOR).toBe(225); // 0xe1 = (255,147,0) per pak palette
    expect(isGreenBoltColor(HITSCAN_TRACER_COLOR)).toBe(false);
    expect(HITSCAN_TRACER_COLOR).toBeGreaterThanOrEqual(YELLOW_COLOR_BASE);
    expect(HITSCAN_TRACER_COLOR).toBeLessThan(YELLOW_COLOR_END);
    expect(HITSCAN_TRACER_COLOR).toBeGreaterThanOrEqual(0xe0);
    // the banned range is exactly the pak-verified green ramp + exclusive end
    expect(GREEN_COLOR_BASE).toBe(0xd0);
    expect(GREEN_COLOR_END).toBe(0xd7);
  });

  it('no soldier fire event ever carries a green bolt/tracer color', () => {
    for (let skin = 0; skin <= 7; skin++) {
      for (const dist of [10, 79, 80, 100, 200, 500, 999, 1000, 5000]) {
        for (let seed = 0; seed < 8; seed++) {
          const ev = soldierFireEvent(skin, dist, mulberry32(seed));
          if (ev.tracerColor !== null) {
            expect(isGreenBoltColor(ev.tracerColor)).toBe(false);
            expect(ev.tracerColor).toBe(HITSCAN_TRACER_COLOR);
          }
          if (ev.boltTrail !== null) {
            expect(isGreenBoltColor(ev.boltTrail)).toBe(false);
            expect(ev.boltTrail).toBe(BLASTER_TRAIL_COLOR);
          }
          // bolt and tracer are mutually exclusive: bolt has no beam, hitscan has no bolt
          expect(ev.firesBolt).toBe(ev.boltTrail !== null);
          expect(ev.firesBolt).toBe(ev.tracerColor === null && ev.weapon === 'blaster');
        }
      }
    }
  });

  it('machinegun soldiers fire hitscan bullet events (no bolt entity)', () => {
    for (const skin of [4, 5, 6, 7]) {
      expect(soldierWeaponForSkin(skin)).toBe('machinegun');
      const ev = soldierFireEvent(skin, 200, mulberry32(1));
      expect(ev.weapon).toBe('machinegun');
      expect(ev.firesBolt).toBe(false);
      expect(attackFiresBolt('soldier', 'machinegun')).toBe(false);
      expect(ev.tracerColor).toBe(HITSCAN_TRACER_COLOR);
      expect(ev.boltTrail).toBe(null);
    }
  });

  it('blaster soldiers fire bolts with 0xe0 trail (m_soldier.c monster_fire_blaster)', () => {
    for (const skin of [0, 1]) {
      const ev = soldierFireEvent(skin, 200, mulberry32(1));
      expect(ev.weapon).toBe('blaster');
      expect(ev.firesBolt).toBe(true);
      expect(ev.boltTrail).toBe(0xe0);
      expect(ev.boltTrail).toBe(BLASTER_TRAIL_COLOR);
      expect(ev.tracerColor).toBe(null); // projectiles draw no muzzle->eye beam
    }
  });

  it('shotgun soldiers are hitscan: orange tracer, never a bolt', () => {
    for (const skin of [2, 3]) {
      expect(soldierWeaponForSkin(skin)).toBe('shotgun');
      const ev = soldierFireEvent(skin, 200, mulberry32(1));
      expect(ev.weapon).toBe('shotgun');
      expect(ev.firesBolt).toBe(false);
      expect(ev.tracerColor).toBe(HITSCAN_TRACER_COLOR);
    }
  });
});

describe('soldierWeaponForSkin covers every lump skin present', () => {
  it('all shipped skinnums map (light 0-1 / plain 2-3 / ss 4-5, pain odds included)', () => {
    // pak0.pak ships skin.pcx (0) skin_lt/ltp (0/1 family) skin_ss/ssp
    // (4/5 family); pain/death sets skinnum|1 so odds must map identically.
    expect(soldierWeaponForSkin(0)).toBe('blaster');
    expect(soldierWeaponForSkin(1)).toBe('blaster');
    expect(soldierWeaponForSkin(2)).toBe('shotgun');
    expect(soldierWeaponForSkin(3)).toBe('shotgun');
    expect(soldierWeaponForSkin(4)).toBe('machinegun');
    expect(soldierWeaponForSkin(5)).toBe('machinegun');
    // out-of-lump skinnums still resolve (never undefined/a bolt surprise)
    expect(soldierWeaponForSkin(6)).toBe('machinegun');
    expect(soldierWeaponForSkin(99)).toBe('machinegun');
  });

  it('skin-aware selection never crosses weapons at any range it fights', () => {
    for (const [skin, weapon] of [[0, 'blaster'], [1, 'blaster'], [2, 'shotgun'], [3, 'shotgun'], [4, 'machinegun'], [5, 'machinegun']] as const) {
      for (const dist of [80, 200, 500, 999]) {
        expect(selectSoldierAttack(skin, dist, mulberry32(3))).toBe(weapon);
        expect(soldierFireEvent(skin, dist, mulberry32(3)).weapon).toBe(weapon);
      }
      expect(selectSoldierAttack(skin, 10, mulberry32(3))).toBe('melee');
      expect(selectSoldierAttack(skin, 5000, mulberry32(3))).toBe('none');
    }
  });
});

describe('machinegun soldier fire pattern (m_soldier.c soldier_fire)', () => {
  it('per-trigger stats match C: 1 bullet, dmg 2, kick 4, spread 300/500', () => {
    const mg = SOLDIER_WEAPON_STATS['machinegun'];
    expect(mg.pellets).toBe(1); // fire_bullet: single fire_lead, not a pellet loop
    expect(mg.damage).toBe(2);
    expect(mg.kick).toBe(4);
    expect(mg.hspread).toBe(DEFAULT_BULLET_HSPREAD);
    expect(mg.hspread).toBe(300);
    expect(mg.vspread).toBe(DEFAULT_BULLET_VSPREAD);
    expect(mg.vspread).toBe(500);
    expect(mg.boltSpeed).toBe(0); // hitscan: no projectile
    // siblings for contrast (C monster_fire_* args, NOT player weapon values)
    expect(SOLDIER_WEAPON_STATS['blaster']).toMatchObject({ damage: 5, pellets: 1, boltSpeed: 600 });
    expect(SOLDIER_WEAPON_STATS['shotgun']).toMatchObject({
      damage: 2,
      kick: 1,
      pellets: DEFAULT_SHOTGUN_COUNT,
      hspread: DEFAULT_SHOTGUN_HSPREAD,
      vspread: DEFAULT_SHOTGUN_VSPREAD,
    });
    expect(DEFAULT_SHOTGUN_COUNT).toBe(12);
    expect(DEFAULT_SHOTGUN_HSPREAD).toBe(1000);
    expect(DEFAULT_SHOTGUN_VSPREAD).toBe(500);
  });

  it('burst hold is C AI_HOLD_FRAME: (3+rand%8) frames of single shots', () => {
    expect(SOLDIER_MACHINEGUN_BURST_MIN_FRAMES).toBe(3);
    expect(SOLDIER_MACHINEGUN_BURST_MAX_FRAMES).toBe(10);
    for (let seed = 0; seed < 200; seed++) {
      const n = soldierMachinegunBurstFrames(mulberry32(seed));
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(10);
    }
    // deterministic per seed; endpoints reachable
    expect(soldierMachinegunBurstFrames(() => 0)).toBe(3);
    expect(soldierMachinegunBurstFrames(() => 0.99999)).toBe(10);
  });

  it('sounds match the C precache (solatck1/2/3 per skin family + cock)', () => {
    expect(SOLDIER_WEAPON_STATS['blaster']!.sound).toBe('soldier/solatck2.wav');
    expect(SOLDIER_WEAPON_STATS['shotgun']!.sound).toBe('soldier/solatck1.wav');
    expect(SOLDIER_WEAPON_STATS['machinegun']!.sound).toBe('soldier/solatck3.wav');
    expect(SOLDIER_COCK_SOUND).toBe('infantry/infatck3.wav');
    // the fire event carries the family sound; silent when not firing
    expect(soldierFireEvent(4, 200, mulberry32(1)).sound).toBe('soldier/solatck3.wav');
    expect(soldierFireEvent(2, 200, mulberry32(1)).sound).toBe('soldier/solatck1.wav');
    expect(soldierFireEvent(0, 200, mulberry32(1)).sound).toBe('soldier/solatck2.wav');
    expect(soldierFireEvent(4, 5000, mulberry32(1)).sound).toBe(null);
    expect(soldierFireEvent(4, 10, mulberry32(1)).sound).toBe(null); // melee: no gun sound
  });

  it('machinegun choice routes to the C attack4 strafe (never attack2)', () => {
    // C soldier_attack picks soldier_move_attack4 for skinnum 4+
    // (m_soldier.c: attack4, 6 frames, soldier_fire4 at index 2 = attak403,
    // flash machinegun_flash[3]). attack2 is the bolt move in both lanes
    // (web monsterFire spawns the foe bolt on attack2; server attackOfMove
    // maps attack2 -> blaster) — the mg strafe must never route there.
    const move = attackMoveFor('soldier', 'machinegun');
    expect(move).toBe('attack4');
    expect(move).not.toBe('attack2');
    expect(isAttackMove(move)).toBe(true);
    const mv = monsterMoveOf({ ...spawnMonster('soldier'), move });
    expect(mv.first).toBe(39); // id FRAME_attak401
    expect(mv.frames).toHaveLength(6); // FRAME_attak401-406
    expect(mv.frames.map((f) => f.action)).toEqual([
      'move', 'move', 'fire', 'move', 'move', 'move',
    ]); // soldier_fire4 at index 2 = attak403
    expect(mv.end).toBe('run');
  });

  it('ss skins commit to the machinegun; lighter skins keep the 1/2 roll', () => {
    // C soldier_attack (m_soldier.c): skinnum 4+ always attack4; lighter
    // skins roll attack1/attack2 (same skin gun, different anim).
    expect(selectAttack('soldier', 200, mulberry32(1), 4)).toBe('machinegun');
    expect(selectAttack('soldier', 200, mulberry32(1), 5)).toBe('machinegun');
    expect(selectAttack('soldier', 200, mulberry32(1), 99)).toBe('machinegun');
    for (const skin of [0, 1, 2, 3]) {
      const c = selectAttack('soldier', 200, mulberry32(7), skin);
      expect(c === 'shotgun' || c === 'blaster').toBe(true);
    }
    // default (no skin) is the normal shotgun-skin class
    const c = selectAttack('soldier', 200, mulberry32(7));
    expect(c === 'shotgun' || c === 'blaster').toBe(true);
    // point-blank is still the skin gun for soldiers (C soldier_attack has
    // no range branch; soldier melee is NULL) — ss commits to machinegun
    expect(selectAttack('soldier', 10, mulberry32(7), 4)).toBe('machinegun');
  });
});
