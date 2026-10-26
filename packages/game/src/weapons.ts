// @q2/game/weapons — blaster/shotgun/machinegun (game/p_weapon.c, g_weapon.c).
// Spread values are id's DEFAULT_* constants; damage/ammo/pellet counts match
// the SP (non-deathmatch) player weapons: blaster 10 (deathmatch 15).
// Spread sampling is caller-seeded:
// pass a `rand()` in [0,1) so firing is fully deterministic in tests.
//
// Blaster visuals (no renderer contract change): the blaster is id's only
// projectile weapon here (fire_blaster: bolt edict, model
// models/objects/laser/tris.md2, speed 1000, life 2s, EF_BLASTER trail +
// 200-intensity yellow dlight, TE_BLASTER impact particles). Hitscan
// weapons (shotgun/machinegun) have no bolt — the driver draws them as
// instant traces with impact sparks on the existing particle path. Every
// fired shot therefore carries exactly one muzzle dlight request, and a
// blaster shot additionally carries exactly one bolt spec, so apps/web can
// registerModel(modelForBolt()) + pump the dlight without hardcoding paths.

import { BOLT_LIFE, BOLT_MODEL, BOLT_SKIN, BOLT_SPEED, EF_BLASTER } from './assets.js';

export interface WeaponDef {
  classname: string;
  ammoKind: string; // '' = infinite (blaster)
  ammoPerShot: number;
  damage: number;
  kick: number;
  hspread: number;
  vspread: number;
  pellets: number;
  mod: string;
}

export const DEFAULT_BULLET_HSPREAD = 300;
export const DEFAULT_BULLET_VSPREAD = 500;
export const DEFAULT_SHOTGUN_HSPREAD = 1000;
export const DEFAULT_SHOTGUN_VSPREAD = 500;
export const DEFAULT_SHOTGUN_COUNT = 12;

export const WEAPON_BLASTER: WeaponDef = {
  classname: 'weapon_blaster',
  ammoKind: '',
  ammoPerShot: 0,
  damage: 10, // SP (g_weapon.c fire_blaster: 15 only when deathmatch)
  kick: 0,
  hspread: 0,
  vspread: 0,
  pellets: 1,
  mod: 'MOD_BLASTER',
};

export const WEAPON_SHOTGUN: WeaponDef = {
  classname: 'weapon_shotgun',
  ammoKind: 'shells',
  ammoPerShot: 1,
  damage: 4,
  kick: 8,
  hspread: DEFAULT_SHOTGUN_HSPREAD,
  vspread: DEFAULT_SHOTGUN_VSPREAD,
  pellets: DEFAULT_SHOTGUN_COUNT,
  mod: 'MOD_SHOTGUN',
};

export const WEAPON_MACHINEGUN: WeaponDef = {
  classname: 'weapon_machinegun',
  ammoKind: 'bullets',
  ammoPerShot: 1,
  damage: 8,
  kick: 2,
  hspread: DEFAULT_BULLET_HSPREAD,
  vspread: DEFAULT_BULLET_VSPREAD,
  pellets: 1,
  mod: 'MOD_MACHINEGUN',
};

export function findWeapon(classname: string): WeaponDef | null {
  switch (classname) {
    case WEAPON_BLASTER.classname:
      return WEAPON_BLASTER;
    case WEAPON_SHOTGUN.classname:
      return WEAPON_SHOTGUN;
    case WEAPON_MACHINEGUN.classname:
      return WEAPON_MACHINEGUN;
    default:
      return null;
  }
}

export interface Pellet {
  /** right/up offsets in the 0..1000 id spread basis (crandom()*spread) */
  r: number;
  u: number;
  damage: number;
}

export interface FireResult {
  fired: boolean;
  reason: string;
  pellets: Pellet[];
  ammoLeft: number;
  /** Blaster projectile spec (id fire_blaster bolt edict, data-table only:
   * model/skin pak names, speed, life, trail effect, damage). Exactly one
   * per fired blaster shot; null for hitscan weapons and when not fired.
   * The driver spawns it as an md2 entity (modelForBolt) on the existing
   * alias path — no renderer contract change. */
  bolt: BoltSpec | null;
  /** Muzzle dlight request (id CL_MuzzleFlash/V_AddLight: intensity 200,
   * yellow). Exactly one per fired shot; null when not fired. The driver
   * pumps it through its existing dlight path (drainFlash). */
  muzzle: MuzzleSpec | null;
}

/** Visible blaster bolt: id's fire_blaster projectile as pure data. */
export interface BoltSpec {
  /** Pak model lump (models/objects/laser/tris.md2). */
  model: string;
  /** Pak skin lump (models/objects/laser/skin.pcx). */
  skin: string;
  /** Units/second (1000, Blaster_Fire in p_weapon.c). */
  speed: number;
  /** Seconds until G_FreeEdict (2, g_weapon.c). */
  life: number;
  /** Trail/light effect flag (EF_BLASTER, q_shared.h). */
  effect: number;
  /** Damage carried by the bolt (quad-scaled). */
  damage: number;
}

/** Muzzle-flash dynamic light request (id CL_MuzzleFlash). */
export interface MuzzleSpec {
  /** Light intensity (200 for blaster/shotgun/machinegun, cl_ents.c). */
  intensity: number;
  /** Light color (yellow [1,1,0] for these weapons, cl_fx.c MZ_*). */
  color: [number, number, number];
}

/** Muzzle dlight intensity for the three player weapons (cl_ents.c V_AddLight). */
export const MUZZLE_LIGHT_INTENSITY = 200;
/** Muzzle dlight color for blaster/shotgun/machinegun (cl_fx.c MZ_* yellow). */
export const MUZZLE_LIGHT_COLOR: [number, number, number] = [1, 1, 0];

/**
 * Resolve one trigger pull. `ammo` is the current reserve for the weapon's
 * ammoKind (ignored for the blaster). `rand` must return [0,1).
 */
export function fireWeapon(
  def: WeaponDef,
  ammo: number,
  rand: () => number,
  quad: boolean,
): FireResult {
  if (def.ammoKind && ammo < def.ammoPerShot) {
    return { fired: false, reason: 'no ammo', pellets: [], ammoLeft: ammo, bolt: null, muzzle: null };
  }
  const pellets: Pellet[] = [];
  const damage = quad ? def.damage * 4 : def.damage;
  for (let i = 0; i < def.pellets; i++) {
    // id: r = crandom()*hspread; u = crandom()*vspread (crandom = 2*rand-1)
    const spreadScale = def.pellets > 1 && i > 0 ? 1 : 1;
    void spreadScale;
    pellets.push({
      r: (rand() * 2 - 1) * def.hspread,
      u: (rand() * 2 - 1) * def.vspread,
      damage,
    });
  }
  // Blaster is id's projectile weapon: one visible bolt per shot. Hitscan
  // weapons carry pellets only (instant traces + impact sparks, driver-side).
  const bolt: BoltSpec | null =
    def.classname === WEAPON_BLASTER.classname
      ? { model: BOLT_MODEL, skin: BOLT_SKIN, speed: BOLT_SPEED, life: BOLT_LIFE, effect: EF_BLASTER, damage }
      : null;
  return {
    fired: true,
    reason: 'ok',
    pellets,
    ammoLeft: def.ammoKind ? ammo - def.ammoPerShot : ammo,
    bolt,
    muzzle: { intensity: MUZZLE_LIGHT_INTENSITY, color: [...MUZZLE_LIGHT_COLOR] },
  };
}

/** Deterministic PRNG (mulberry32) for tests and scripted playback. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
