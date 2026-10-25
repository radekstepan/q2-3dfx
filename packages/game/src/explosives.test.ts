// Explosives data (g_misc.c / g_target.c): id defaults + entity-lump parsing.
// Fixture lump models base1's opening-room barrels (misc_explobox with no
// explicit health/dmg keys, as shipped in base1.bsp).
import { describe, expect, it } from 'vitest';
import {
  EXPLOBOX_DEFAULT_DMG,
  EXPLOBOX_DEFAULT_HEALTH,
  EXPLOBOX_DEFAULT_MASS,
  EXPLOBOX_MODEL,
  FUNC_EXPLOSIVE_DEFAULT_DMG,
  FUNC_EXPLOSIVE_DEFAULT_HEALTH,
  FUNC_EXPLOSIVE_DEFAULT_MASS,
  TARGET_EXPLOSION_DEFAULT_DELAY,
  TARGET_EXPLOSION_DEFAULT_DMG,
  isExplosiveClassname,
  parseEntities,
  spawnExplosive,
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
