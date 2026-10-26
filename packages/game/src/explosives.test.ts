// Explosives data (g_misc.c / g_target.c): id defaults + entity-lump parsing.
// Fixture lump models base1's opening-room barrels (misc_explobox with no
// explicit health/dmg keys, as shipped in base1.bsp).
import { describe, expect, it } from 'vitest';
import {
  BARREL_DEBRIS_BIG,
  BARREL_DEBRIS_CORNER,
  BARREL_DEBRIS_SMALL,
  BARREL_DEBRIS_TOTAL,
  BARREL_FUSE_DELAY,
  BLASTER_SPARK_COUNT,
  DEBRIS_BOUNCE_BACKOFF,
  DEBRIS_LIFE_MIN,
  DEBRIS_LIFE_SPAN,
  DEBRIS_MODEL_BIG,
  DEBRIS_MODEL_CORNER,
  DEBRIS_MODEL_SMALL,
  EXPLOBOX_DEFAULT_DMG,
  EXPLOBOX_DEFAULT_HEALTH,
  EXPLOBOX_DEFAULT_MASS,
  EXPLOBOX_MODEL,
  EXPLOSION_FRAMES,
  EXPLOSION_LIGHT,
  EXPLOSION_LIGHT_COLOR,
  EXPLOSION_SPARK_COUNT,
  EXPLOSION_SPARK_SPEED,
  EXPLOSION_SPARK_TTL_MAX,
  EXPLOSION_SPARK_TTL_MIN,
  FUNC_EXPLOSIVE_DEFAULT_DMG,
  FUNC_EXPLOSIVE_DEFAULT_HEALTH,
  FUNC_EXPLOSIVE_DEFAULT_MASS,
  GIB_DEADFLAG,
  GIB_LIFE_MIN,
  GIB_LIFE_SPAN,
  GIB_SOUND,
  GIB_TOSS_BACKOFF,
  SPARK_COLOR_BASE,
  SPARK_COLOR_JITTER,
  TARGET_EXPLOSION_DEFAULT_DELAY,
  TARGET_EXPLOSION_DEFAULT_DMG,
  barrelDebrisSpeeds,
  barrelFuseAt,
  explosionAlpha,
  explosionBaseframe,
  explosionFrames,
  funcExplosiveDebris,
  gibModelsFor,
  isExplosiveClassname,
  leavesScorch,
  parseEntities,
  radiusDamageAttackerPoints,
  radiusDamagePoints,
  radiusDamageRadius,
  spawnExplosive,
  targetExplosionFuseAt,
} from './index.js';

const START_ROOM_LUMP = `
{
"classname" "worldspawn"
"message" "base1: Outer Base"
"sky" "unit1_"
}
{
"origin" "136 40 0"
"classname" "misc_explobox"
}
{
"origin" "184 -24 0"
"dmg" "150"
"classname" "misc_explobox"
}
{
"model" "*30"
"classname" "func_explosive"
"health" "10"
"dmg" "25"
}
{
"model" "*20"
"classname" "func_explosive"
}
{
"origin" "-648 112 40"
"dmg" "1"
"classname" "target_explosion"
"targetname" "t151"
}
{
"origin" "744 -336 -96"
"classname" "target_explosion"
"targetname" "t152"
}
{
"origin" "128 -320 32"
"classname" "info_player_start"
}
`;

describe('explosives data (id SP_ defaults)', () => {
  it('gates on the three explosive classnames', () => {
    expect(isExplosiveClassname('misc_explobox')).toBe(true);
    expect(isExplosiveClassname('func_explosive')).toBe(true);
    expect(isExplosiveClassname('target_explosion')).toBe(true);
    expect(isExplosiveClassname('monster_soldier')).toBe(false);
    expect(isExplosiveClassname(undefined)).toBe(false);
    expect(spawnExplosive({ classname: 'monster_soldier' })).toBe(null);
  });

  it('start-room barrel with no keys gets id explobox defaults', () => {
    const dicts = parseEntities(START_ROOM_LUMP);
    const barrels = dicts.filter((d) => d['classname'] === 'misc_explobox').map(spawnExplosive);
    expect(barrels.length).toBe(2);
    const bare = barrels[0]!;
    expect(bare.kind).toBe('misc_explobox');
    expect([...bare.origin]).toEqual([136, 40, 0]);
    expect(bare.health).toBe(10);
    expect(bare.health).toBe(EXPLOBOX_DEFAULT_HEALTH);
    expect(bare.dmg).toBe(150);
    expect(bare.dmg).toBe(EXPLOBOX_DEFAULT_DMG);
    expect(bare.mass).toBe(400);
    expect(bare.mass).toBe(EXPLOBOX_DEFAULT_MASS);
    expect(bare.model).toBe(EXPLOBOX_MODEL);
    // explicit dmg survives alongside defaults
    expect(barrels[1]!.dmg).toBe(150);
    expect(barrels[1]!.health).toBe(10);
  });

  it('func_explosive defaults to id health 100 / dmg 0 (shootable brush)', () => {
    const dicts = parseEntities(START_ROOM_LUMP);
    const ex = dicts.filter((d) => d['classname'] === 'func_explosive').map(spawnExplosive);
    expect(ex.length).toBe(2);
    // explicit keys (as shipped in base1) win
    expect(ex[0]!.health).toBe(10);
    expect(ex[0]!.dmg).toBe(25);
    // bare brush falls back to id SP_func_explosive defaults
    expect(ex[1]!.health).toBe(100);
    expect(ex[1]!.health).toBe(FUNC_EXPLOSIVE_DEFAULT_HEALTH);
    expect(ex[1]!.dmg).toBe(0);
    expect(ex[1]!.dmg).toBe(FUNC_EXPLOSIVE_DEFAULT_DMG);
    expect(ex[1]!.mass).toBe(75);
    expect(ex[1]!.mass).toBe(FUNC_EXPLOSIVE_DEFAULT_MASS);
    expect(ex[1]!.model).toBe('*20');
  });

  it('target_explosion defaults to dmg 0 / delay 0, keeps targetname', () => {
    const dicts = parseEntities(START_ROOM_LUMP);
    const tx = dicts.filter((d) => d['classname'] === 'target_explosion').map(spawnExplosive);
    expect(tx.length).toBe(2);
    expect(tx[0]!.dmg).toBe(1);
    expect(tx[0]!.targetname).toBe('t151');
    expect(tx[0]!.delay).toBe(0);
    expect(tx[1]!.dmg).toBe(0);
    expect(tx[1]!.dmg).toBe(TARGET_EXPLOSION_DEFAULT_DMG);
    expect(tx[1]!.delay).toBe(TARGET_EXPLOSION_DEFAULT_DELAY);
    expect(tx[1]!.health).toBe(0);
  });

  it('non-finite values fall back to defaults (never NaN)', () => {
    const e = spawnExplosive({ classname: 'misc_explobox', health: 'abc', dmg: 'xyz' })!;
    expect(e.health).toBe(EXPLOBOX_DEFAULT_HEALTH);
    expect(e.dmg).toBe(EXPLOBOX_DEFAULT_DMG);
    expect(Number.isFinite(e.health)).toBe(true);
    expect(Number.isFinite(e.dmg)).toBe(true);
  });
});

describe('explosion timing/visuals (M7.2 batch #4 regressions)', () => {
  it('barrel fuse is 0.2s (barrel_delay: level.time + 2 frames)', () => {
    expect(BARREL_FUSE_DELAY).toBe(0.2);
    expect(barrelFuseAt(10)).toBeCloseTo(10.2, 9);
  });

  it('target_explosion delay schedules think at level.time + delay', () => {
    expect(targetExplosionFuseAt(7, 0)).toBe(7);
    expect(targetExplosionFuseAt(7, 1.5)).toBeCloseTo(8.5, 9);
    // lump delay survives the parse (use_target_explosion path)
    const e = spawnExplosive({ classname: 'target_explosion', delay: '0.7' })!;
    expect(e.delay).toBeCloseTo(0.7, 9);
  });

  it('visual frames: r_explode 15f / grounded 19f-base30 / ex_misc 4f', () => {
    expect(explosionFrames('explosion1')).toBe(15);
    expect(explosionFrames('explosion2')).toBe(19);
    expect(explosionFrames('blaster')).toBe(4);
    expect(EXPLOSION_FRAMES['explosion1']).toBe(15);
    // grounded bursts sit at base 30 (BecomeExplosion2)
    expect(explosionBaseframe('explosion2', () => 0)).toBe(30);
    expect(explosionBaseframe('explosion2', () => 0.99)).toBe(30);
    // airborne bursts pick base 15 half the time, else 0
    expect(explosionBaseframe('explosion1', () => 0)).toBe(15);
    expect(explosionBaseframe('explosion1', () => 0.99)).toBe(0);
    expect(explosionBaseframe('blaster', () => 0)).toBe(0);
  });

  it('dlights: orange 350 for big booms, yellow 150 for the blaster flash', () => {
    expect(EXPLOSION_LIGHT['explosion1']).toBe(350);
    expect(EXPLOSION_LIGHT['explosion2']).toBe(350);
    expect(EXPLOSION_LIGHT['blaster']).toBe(150);
    expect(EXPLOSION_LIGHT_COLOR['explosion1']).toEqual([1, 0.5, 0.5]);
    expect(EXPLOSION_LIGHT_COLOR['explosion2']).toEqual([1, 0.5, 0.5]);
    expect(EXPLOSION_LIGHT_COLOR['blaster']).toEqual([1, 1, 0]);
    // alpha-decayed (ex_poly 16-frame / ex_misc linear, cl_tent.c)
    expect(explosionAlpha('explosion1', 0)).toBeCloseTo(1, 9);
    expect(explosionAlpha('explosion1', 8)).toBeCloseTo(0.5, 9);
    expect(explosionAlpha('explosion1', 14)).toBe(0);
    expect(explosionAlpha('blaster', 0)).toBeCloseTo(1, 9);
    expect(explosionAlpha('blaster', 3)).toBe(0);
  });

  it('big booms burst 256 ballistic yellow sparks (CL_ExplosionParticles)', () => {
    expect(EXPLOSION_SPARK_COUNT).toBe(256);
    expect(SPARK_COLOR_BASE).toBe(0xe0);
    expect(SPARK_COLOR_JITTER).toBe(8);
    expect(EXPLOSION_SPARK_SPEED).toBe(192); // (rand%384)-192 per axis
    expect(EXPLOSION_SPARK_TTL_MIN).toBeCloseTo(0.625, 9);
    expect(EXPLOSION_SPARK_TTL_MAX).toBeCloseTo(1.0, 9);
    expect(BLASTER_SPARK_COUNT).toBe(40); // wall-impact burst, same yellow
  });

  it('barrels throw 14 bouncing debris chunks (2+4+8, MOVETYPE_BOUNCE)', () => {
    expect(BARREL_DEBRIS_BIG).toBe(2);
    expect(BARREL_DEBRIS_CORNER).toBe(4);
    expect(BARREL_DEBRIS_SMALL).toBe(8);
    expect(BARREL_DEBRIS_TOTAL).toBe(14);
    expect(DEBRIS_MODEL_BIG).toBe('models/objects/debris1/tris.md2');
    expect(DEBRIS_MODEL_SMALL).toBe('models/objects/debris2/tris.md2');
    expect(DEBRIS_MODEL_CORNER).toBe('models/objects/debris3/tris.md2');
    // speeds: 1.5/1.75/2 x dmg/200 (dmg 150 barrel)
    const s = barrelDebrisSpeeds(150);
    expect(s.big).toBeCloseTo(1.125, 9);
    expect(s.corner).toBeCloseTo(1.3125, 9);
    expect(s.small).toBeCloseTo(1.5, 9);
    // debris life 5+rand*5, bounce backoff 1.5 (gibs toss 1.0, 10+rand*10)
    expect(DEBRIS_LIFE_MIN).toBe(5);
    expect(DEBRIS_LIFE_SPAN).toBe(5);
    expect(DEBRIS_BOUNCE_BACKOFF).toBe(1.5);
    expect(GIB_LIFE_MIN).toBe(10);
    expect(GIB_LIFE_SPAN).toBe(10);
    expect(GIB_TOSS_BACKOFF).toBe(1.0);
  });

  it('func_explosive debris follows the mass formula (cap 8 big / 16 small)', () => {
    expect(funcExplosiveDebris(75)).toEqual({ big: 0, small: 3 });
    expect(funcExplosiveDebris(400)).toEqual({ big: 4, small: 16 });
    expect(funcExplosiveDebris(800)).toEqual({ big: 8, small: 16 });
    expect(funcExplosiveDebris(50)).toEqual({ big: 0, small: 2 });
  });

  it('T_RadiusDamage: bbox-center distance, dmg-0.5*len, attacker half, radius dmg+40', () => {
    expect(radiusDamageRadius(150)).toBe(190);
    expect(radiusDamageRadius(0)).toBe(40);
    // points = dmg - 0.5*len (g_combat.c); attacker takes half
    expect(radiusDamagePoints(150, 0)).toBe(150);
    expect(radiusDamagePoints(150, 100)).toBe(100);
    expect(radiusDamagePoints(150, 380)).toBe(-40); // out of radius, skipped
    expect(radiusDamageAttackerPoints(100)).toBe(50);
    // LOS (CanDamage) is the caller's trace — points alone never skip it:
    // a zero-distance target still takes full damage through this helper.
    expect(radiusDamagePoints(150, 0)).toBeGreaterThan(0);
  });

  it('overkill gibs: soldier 3x sm_meat + chest + head, udeath, DEAD_DEAD', () => {
    expect([...gibModelsFor('soldier')]).toEqual(['sm_meat', 'sm_meat', 'sm_meat', 'chest', 'head2']);
    expect(gibModelsFor('gunner')).toContain('head2');
    expect(gibModelsFor('gunner').length).toBe(7);
    expect(GIB_SOUND).toBe('misc/udeath.wav');
    expect(GIB_DEADFLAG).toBe('DEAD_DEAD');
  });

  it('explosions leave no scorch (Q2 has none)', () => {
    expect(leavesScorch('explosion1')).toBe(false);
    expect(leavesScorch('explosion2')).toBe(false);
    expect(leavesScorch('blaster')).toBe(false);
  });
});
