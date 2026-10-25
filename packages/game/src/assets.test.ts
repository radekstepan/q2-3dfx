// Asset tables (pak-verified names) + blaster bolt/muzzle specs.
import { describe, expect, it } from 'vitest';
import {
  BOLT_LIFE,
  BOLT_MODEL,
  BOLT_SKIN,
  BOLT_SPEED,
  EF_BLASTER,
  MUZZLE_LIGHT_COLOR,
  MUZZLE_LIGHT_INTENSITY,
  WEAPON_BLASTER,
  WEAPON_MACHINEGUN,
  WEAPON_SHOTGUN,
  fireWeapon,
  modelForBolt,
  modelForMonster,
  modelForWeapon,
  monsterFrameFor,
  monsterKindForClassname,
  mulberry32,
  resolvePakAsset,
  skinForBolt,
  skinForMonster,
  skinForWeaponModel,
  skinsForMonster,
  viewModelForWeapon,
  worldModelForWeapon,
} from './index.js';

describe('model/skin asset tables (pak-verified)', () => {
  it('monster models match the C precache strings', () => {
    expect(modelForMonster('soldier')).toBe('models/monsters/soldier/tris.md2');
    expect(modelForMonster('gunner')).toBe('models/monsters/gunner/tris.md2');
  });

  it('monster skins match pak0.pak (default + pain)', () => {
    expect(skinForMonster('soldier')).toBe('models/monsters/soldier/skin.pcx');
    expect(skinForMonster('soldier', 'pain')).toBe('models/monsters/soldier/pain.pcx');
    expect(skinForMonster('gunner')).toBe('models/monsters/gunner/skin.pcx');
    expect(skinForMonster('gunner', 'pain')).toBe('models/monsters/gunner/pain.pcx');
    expect(skinsForMonster('soldier')).toContain('models/monsters/soldier/skin_lt.pcx');
    expect(skinsForMonster('gunner')).toHaveLength(2);
  });

  it('monster frames resolve to move first-frames, null when unknown', () => {
    expect(monsterFrameFor('soldier', 'run')).toBe(99);
    expect(monsterFrameFor('soldier', 'attack1')).toBe(0);
    expect(monsterFrameFor('gunner', 'attack_chain')).toBe(137);
    expect(monsterFrameFor('gunner', 'nope')).toBe(null);
  });

  it('classnames map to lite kinds, null otherwise', () => {
    expect(monsterKindForClassname('monster_soldier')).toBe('soldier');
    expect(monsterKindForClassname('monster_gunner')).toBe('gunner');
    expect(monsterKindForClassname('monster_berserk')).toBe(null);
    expect(monsterKindForClassname('player')).toBe(null);
  });

  it('weapon view/world models match g_items.c', () => {
    expect(modelForWeapon('weapon_blaster')).toBe('models/weapons/v_blast/tris.md2');
    expect(modelForWeapon('weapon_shotgun')).toBe('models/weapons/v_shotg/tris.md2');
    expect(modelForWeapon('weapon_machinegun')).toBe('models/weapons/v_machn/tris.md2');
    expect(modelForWeapon('weapon_railgun')).toBe(null);
    expect(viewModelForWeapon('weapon_shotgun')).toBe('models/weapons/v_shotg/tris.md2');
    expect(worldModelForWeapon('weapon_shotgun')).toBe('models/weapons/g_shotg/tris.md2');
    expect(worldModelForWeapon('weapon_blaster')).toBe('models/weapons/g_blast/tris.md2');
    expect(worldModelForWeapon('weapon_nope')).toBe(null);
  });

  it('weapon skins follow the sibling convention incl. the g_blast base.pcx exception', () => {
    expect(skinForWeaponModel('models/weapons/v_blast/tris.md2')).toBe('models/weapons/v_blast/skin.pcx');
    expect(skinForWeaponModel('models/weapons/v_shotg/tris.md2')).toBe('models/weapons/v_shotg/skin.pcx');
    expect(skinForWeaponModel('models/weapons/v_machn/tris.md2')).toBe('models/weapons/v_machn/skin.pcx');
    expect(skinForWeaponModel('models/weapons/g_blast/tris.md2')).toBe('models/weapons/g_blast/base.pcx');
    expect(skinForWeaponModel('models/weapons/g_shotg/tris.md2')).toBe('models/weapons/g_shotg/skin.pcx');
  });

  it('bolt model/skin/speed/life match id fire_blaster', () => {
    expect(modelForBolt()).toBe('models/objects/laser/tris.md2');
    expect(skinForBolt()).toBe('models/objects/laser/skin.pcx');
    expect(BOLT_MODEL).toBe('models/objects/laser/tris.md2');
    expect(BOLT_SKIN).toBe('models/objects/laser/skin.pcx');
    expect(BOLT_SPEED).toBe(1000);
    expect(BOLT_LIFE).toBe(2);
    expect(EF_BLASTER).toBe(0x08);
  });

  it('resolvePakAsset falls back devroom-safe without throwing', () => {
    const has = (n: string): boolean => n === 'models/monsters/soldier/tris.md2';
    expect(resolvePakAsset('models/monsters/soldier/tris.md2', has, 'monster')).toBe(
      'models/monsters/soldier/tris.md2',
    );
    expect(resolvePakAsset('models/monsters/boss/tris.md2', has, 'monster')).toBe('monster');
    const throwing = (): boolean => {
      throw new Error('no fs');
    };
    expect(resolvePakAsset('models/monsters/soldier/tris.md2', throwing, 'monster')).toBe('monster');
  });
});

describe('blaster bolt + muzzle dlight (M7.2 driver contract)', () => {
  it('firing blaster emits exactly one bolt + one dlight request', () => {
    const r = fireWeapon(WEAPON_BLASTER, 0, mulberry32(4), false);
    expect(r.fired).toBe(true);
    expect(r.pellets.length).toBe(1);
    // exactly one bolt
    expect(r.bolt).not.toBe(null);
    expect(r.bolt!.model).toBe('models/objects/laser/tris.md2');
    expect(r.bolt!.skin).toBe('models/objects/laser/skin.pcx');
    expect(r.bolt!.speed).toBe(1000);
    expect(r.bolt!.life).toBe(2);
    expect(r.bolt!.effect).toBe(0x08);
    expect(r.bolt!.damage).toBe(15);
    // exactly one dlight request
    expect(r.muzzle).not.toBe(null);
    expect(r.muzzle!.intensity).toBe(200);
    expect(r.muzzle!.color).toEqual([1, 1, 0]);
    expect(MUZZLE_LIGHT_INTENSITY).toBe(200);
    expect(MUZZLE_LIGHT_COLOR).toEqual([1, 1, 0]);
  });

  it('quad scales the bolt damage like the pellet damage', () => {
    const r = fireWeapon(WEAPON_BLASTER, 0, mulberry32(4), true);
    expect(r.bolt!.damage).toBe(60);
    expect(r.pellets[0]!.damage).toBe(60);
  });

  it('hitscan weapons emit a dlight but no bolt', () => {
    const s = fireWeapon(WEAPON_SHOTGUN, 10, mulberry32(1), false);
    expect(s.fired).toBe(true);
    expect(s.bolt).toBe(null);
    expect(s.muzzle).not.toBe(null);
    expect(s.muzzle!.intensity).toBe(200);
    const m = fireWeapon(WEAPON_MACHINEGUN, 5, mulberry32(5), false);
    expect(m.bolt).toBe(null);
    expect(m.muzzle).not.toBe(null);
  });

  it('unfired shots emit neither bolt nor dlight', () => {
    const r = fireWeapon(WEAPON_SHOTGUN, 0, mulberry32(3), false);
    expect(r.fired).toBe(false);
    expect(r.bolt).toBe(null);
    expect(r.muzzle).toBe(null);
  });
});
