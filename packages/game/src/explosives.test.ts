// Explosives data (g_misc.c / g_target.c): id defaults + entity-lump parsing.
// Fixture lump models base1's opening-room barrels (misc_explobox with no
// explicit health/dmg keys, as shipped in base1.bsp).
import { describe, expect, it } from 'vitest';
import { v3 } from '@q2/math';
import {
  BARREL_DEBRIS_BIG,
  BARREL_DEBRIS_CORNER,
  BARREL_DEBRIS_SMALL,
  BARREL_DEBRIS_TOTAL,
  BARREL_FUSE_DELAY,
  BIG_BOOM_MODEL,
  BIG_BOOM_MODEL_BIG,
  BIG_BOOM_MODEL_FRAMES,
  BIG_BOOM_MODEL_SKINS,
  BLASTER_IMPACT_MODEL,
  BLASTER_IMPACT_MODEL_FRAMES,
  BLASTER_SPARK_COUNT,
  BLASTER_SPARK_DIR_SPEED,
  BLASTER_SPARK_FORWARD_MAX,
  BLASTER_SPARK_JITTER,
  BLASTER_SPARK_SPREAD,
  BLASTER_SPARK_TTL_MAX,
  BLASTER_SPARK_TTL_MIN,
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
  EXPLOSION_SPARK_SPREAD,
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
  MULTICAST_PHS,
  MULTICAST_PVS,
  PARTICLE_GRAVITY,
  SPARK_COLOR_BASE,
  SPARK_COLOR_JITTER,
  TARGET_EXPLOSION_DEFAULT_DELAY,
  TARGET_EXPLOSION_DEFAULT_DMG,
  TEMP_ENTITY_CULLING,
  TEMP_ENTITY_INVENTORY,
  TE_BLASTER_SOUND,
  TE_EXPLOSION1_SOUND,
  TE_EXPLOSION2_SOUND,
  TE_EXPLOSION_WATER_SOUND,
  barrelDebrisSpeeds,
  barrelExplosionKind,
  barrelFuseAt,
  blasterImpactAngles,
  explosionAlpha,
  explosionBaseframe,
  explosionFrames,
  explosionLerp,
  explosionLifetime,
  explosionSkin,
  explosionSound,
  funcExplosiveBlast,
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
  tempEntityInfo,
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

describe('TE client-presentation tables (RELEASE-9 boxes 1-2, C-exact pins)', () => {
  it('impact/boom model lumps match CL_RegisterTEntModels (pak frame counts)', () => {
    expect(BLASTER_IMPACT_MODEL).toBe('models/objects/explode/tris.md2');
    expect(BIG_BOOM_MODEL).toBe('models/objects/r_explode/tris.md2');
    expect(BIG_BOOM_MODEL_BIG).toBe('models/objects/r_explode2/tris.md2');
    // parseMD2 of pak0.pak: explode ships 5 frames, the TE plays 4
    expect(BLASTER_IMPACT_MODEL_FRAMES).toBe(5);
    expect(EXPLOSION_FRAMES['blaster']).toBe(4);
    // r_explode ships 49f/7skins: covers base-30+19f (max frame 44) and skins 0..6
    expect(BIG_BOOM_MODEL_FRAMES).toBe(49);
    expect(BIG_BOOM_MODEL_SKINS).toBe(7);
  });

  it('TE sounds match CL_RegisterTEntSounds + the ParseTEnt case blocks', () => {
    expect(TE_BLASTER_SOUND).toBe('weapons/lashit.wav');
    expect(TE_EXPLOSION1_SOUND).toBe('weapons/rocklx1a.wav');
    expect(TE_EXPLOSION2_SOUND).toBe('weapons/grenlx1a.wav');
    expect(TE_EXPLOSION_WATER_SOUND).toBe('weapons/xpld_wat.wav');
    // blaster always lashit (no water variant); booms pick water vs family
    expect(explosionSound('blaster', false)).toBe('weapons/lashit.wav');
    expect(explosionSound('blaster', true)).toBe('weapons/lashit.wav');
    expect(explosionSound('explosion1', false)).toBe('weapons/rocklx1a.wav');
    expect(explosionSound('explosion2', false)).toBe('weapons/grenlx1a.wav');
    expect(explosionSound('explosion1', true)).toBe('weapons/xpld_wat.wav');
    expect(explosionSound('explosion2', true)).toBe('weapons/xpld_wat.wav');
  });

  it('barrel TE choice follows groundedness (barrel_explode BecomeExplosion*)', () => {
    expect(barrelExplosionKind(true)).toBe('explosion2');
    expect(barrelExplosionKind(false)).toBe('explosion1');
    // func_explosive only blasts when it deals damage, always TE_EXPLOSION1
    expect(funcExplosiveBlast(150)).toBe('explosion1');
    expect(funcExplosiveBlast(0)).toBe(null);
  });

  it('visual life is (frames-1)*100ms (freed when f >= frames-1)', () => {
    expect(explosionLifetime('blaster')).toBeCloseTo(0.3, 9);
    expect(explosionLifetime('explosion1')).toBeCloseTo(1.4, 9);
    expect(explosionLifetime('explosion2')).toBeCloseTo(1.8, 9);
  });

  it('framelerp follows ent->frame = base+f+1, oldframe = base+f, backlerp = 1-lerpfrac', () => {
    // grounded boom mid-life at render fraction 0.25
    expect(explosionLerp(30, 5, 0.25)).toEqual({ frame: 36, oldframe: 35, backlerp: 0.75 });
    // first tick at full lerp: frame base+1 over base+0
    expect(explosionLerp(0, 0, 0)).toEqual({ frame: 1, oldframe: 0, backlerp: 1 });
    // backlerp clamps per the renderer-api Entity contract
    expect(explosionLerp(15, 3, 1).backlerp).toBe(0);
    expect(explosionLerp(15, 3, 2).backlerp).toBe(0);
    expect(explosionLerp(15, 3, -1).backlerp).toBe(1);
  });

  it('ex_poly skin stepping picks up TRANSLUCENT at frame 10', () => {
    expect(explosionSkin('explosion1', 0)).toEqual({ skinnum: 0, translucent: false });
    expect(explosionSkin('explosion1', 8)).toEqual({ skinnum: 4, translucent: false });
    expect(explosionSkin('explosion1', 10)).toEqual({ skinnum: 5, translucent: true });
    expect(explosionSkin('explosion1', 12)).toEqual({ skinnum: 5, translucent: true });
    expect(explosionSkin('explosion1', 13)).toEqual({ skinnum: 6, translucent: true });
    // blaster flash is translucent from frame 0 with no skin stepping
    expect(explosionSkin('blaster', 0)).toEqual({ skinnum: 0, translucent: true });
    expect(explosionSkin('blaster', 3)).toEqual({ skinnum: 0, translucent: true });
  });

  it('blaster alpha is continuous in frac (cl_tent.c:1627), ex_poly floored', () => {
    // C ex_misc: 1.0 - frac/(frames-1) — half-frame is not 1.0
    expect(explosionAlpha('blaster', 0.5)).toBeCloseTo(1 - 0.5 / 3, 9);
    expect(explosionAlpha('blaster', 1.5)).toBeCloseTo(0.5, 9);
    expect(explosionAlpha('blaster', 0)).toBeCloseTo(1, 9);
    expect(explosionAlpha('blaster', 3)).toBe(0);
    // C ex_poly: (16-f)/16 on the floored index — fractions match the floor
    expect(explosionAlpha('explosion1', 8.5)).toBe(explosionAlpha('explosion1', 8));
  });

  it('blaster impact angles face along the impact normal (cl_tent.c:807-818)', () => {
    const v = (x: number, y: number, z: number) => v3(x, y, z);
    // floor hit (normal +Z): flat, yaw 0
    expect(blasterImpactAngles(v(0, 0, 1))).toEqual({ pitch: 0, yaw: 0 });
    // ceiling hit: pitched 180
    const ceil = blasterImpactAngles(v(0, 0, -1));
    expect(ceil.pitch).toBeCloseTo(180, 9);
    // wall hits: pitched 90, yaw follows atan2 (incl. the dir[0]==0 fallbacks)
    expect(blasterImpactAngles(v(1, 0, 0))).toEqual({ pitch: 90, yaw: 0 });
    expect(blasterImpactAngles(v(0, 1, 0))).toEqual({ pitch: 90, yaw: 90 });
    expect(blasterImpactAngles(v(0, -1, 0))).toEqual({ pitch: 90, yaw: 270 });
    expect(blasterImpactAngles(v(-1, 0, 0)).yaw).toBeCloseTo(180, 9);
    // pitched hit: 45-degree normal yields a 45-degree pitch
    const inv = Math.SQRT1_2;
    const pitched = blasterImpactAngles(v(0, inv, inv));
    expect(pitched.pitch).toBeCloseTo(45, 5); // Float32 normal, not exact
    expect(pitched.yaw).toBeCloseTo(90, 5);
  });

  it('blaster spark recipe matches CL_BlasterParticles (count/vel/ttl/gravity)', () => {
    expect(BLASTER_SPARK_COUNT).toBe(40);
    expect(BLASTER_SPARK_DIR_SPEED).toBe(30); // vel = dir*30 + crand*40
    expect(BLASTER_SPARK_JITTER).toBe(40);
    expect(BLASTER_SPARK_SPREAD).toBe(4); // org += (rand&7)-4 + d*dir
    expect(BLASTER_SPARK_FORWARD_MAX).toBe(15); // d = rand&15
    // ttl = -1/alphavel = 0.5 + frand*0.3
    expect(BLASTER_SPARK_TTL_MIN).toBeCloseTo(0.5, 9);
    expect(BLASTER_SPARK_TTL_MAX).toBeCloseTo(0.8, 9);
    expect(PARTICLE_GRAVITY).toBe(40);
    expect(EXPLOSION_SPARK_SPREAD).toBe(16); // (rand%32)-16
  });

  it('occlusion rule: barrel/func blasts PVS, target_explosion PHS', () => {
    expect(MULTICAST_PHS).toBe(1);
    expect(MULTICAST_PVS).toBe(2);
    expect(TEMP_ENTITY_CULLING['barrel']).toBe(MULTICAST_PVS);
    expect(TEMP_ENTITY_CULLING['func_explosive']).toBe(MULTICAST_PVS);
    expect(TEMP_ENTITY_CULLING['target_explosion']).toBe(MULTICAST_PHS);
  });

  it('TE inventory covers every q_shared.h id with cl_tent.c line refs', () => {
    // q_shared.h temp_event_t: TE_GUNSHOT = 0 .. TE_FLECHETTE = 55
    expect(TEMP_ENTITY_INVENTORY.length).toBe(56);
    expect(TEMP_ENTITY_INVENTORY[0]).toMatchObject({ id: 0, name: 'TE_GUNSHOT' });
    expect(TEMP_ENTITY_INVENTORY[55]).toMatchObject({ id: 55, name: 'TE_FLECHETTE' });
    expect(tempEntityInfo(2)).toMatchObject({ name: 'TE_BLASTER', clTent: 798, status: 'tabled' });
    expect(tempEntityInfo(5)).toMatchObject({ name: 'TE_EXPLOSION1', clTent: 880, status: 'tabled' });
    expect(tempEntityInfo(6)).toMatchObject({ name: 'TE_EXPLOSION2', clTent: 834, status: 'tabled' });
    expect(tempEntityInfo(46)).toMatchObject({ name: 'TE_ELECTRIC_SPARKS', clTent: 1158, status: 'missing' });
    expect(tempEntityInfo(999)).toBe(null);
    // ids are dense 0..55 and every cased TE carries its case line
    const ids = TEMP_ENTITY_INVENTORY.map((row) => row.id);
    expect(ids).toEqual([...Array(56).keys()]);
    for (const row of TEMP_ENTITY_INVENTORY) {
      if (row.clTent !== -1) expect(row.clTent).toBeGreaterThan(0);
    }
    // only the box 1-2 audit scope is tabled; the rest is explicit
    const tabled = TEMP_ENTITY_INVENTORY.filter((row) => row.status === 'tabled').map((row) => row.id);
    expect(tabled).toEqual([2, 5, 6]);
  });
});
