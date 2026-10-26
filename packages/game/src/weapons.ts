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

import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
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
 * id Blaster_Fire spawn (p_weapon.c) via G_ProjectSource (g_utils.c):
 * start = feet + fwd*24 + right*8, then start.z += viewheight-8
 * (eye 22 - 8 = 14). The bolt leaves the gun muzzle, never the eye.
 * Pure (no I/O), headless-testable.
 */
export const BLASTER_SPAWN_FWD = 24;
export const BLASTER_SPAWN_RIGHT = 8;
export const BLASTER_SPAWN_UP = -8;

export function blasterSpawn(feet: Vec3, fwd: Vec3, right: Vec3, viewheight: number): Vec3 {
  return v3(
    feet[0]! + fwd[0]! * BLASTER_SPAWN_FWD + right[0]! * BLASTER_SPAWN_RIGHT,
    feet[1]! + fwd[1]! * BLASTER_SPAWN_FWD + right[1]! * BLASTER_SPAWN_RIGHT,
    feet[2]! + fwd[2]! * BLASTER_SPAWN_FWD + right[2]! * BLASTER_SPAWN_RIGHT + (viewheight + BLASTER_SPAWN_UP),
  );
}

/**
 * id CL_ParseMuzzleFlash (cl_ents.c): muzzle dlight origin = feet +
 * fwd*18 + right*16 (full 3D fwd/right, no up vector), radius
 * 200+(rand&31), pure yellow. Single frame (die = cl.time).
 */
export const MUZZLE_OFFSET_FWD = 18;
export const MUZZLE_OFFSET_RIGHT = 16;

export function blasterMuzzle(feet: Vec3, fwd: Vec3, right: Vec3): Vec3 {
  return v3(
    feet[0]! + fwd[0]! * MUZZLE_OFFSET_FWD + right[0]! * MUZZLE_OFFSET_RIGHT,
    feet[1]! + fwd[1]! * MUZZLE_OFFSET_FWD + right[1]! * MUZZLE_OFFSET_RIGHT,
    feet[2]! + fwd[2]! * MUZZLE_OFFSET_FWD + right[2]! * MUZZLE_OFFSET_RIGHT,
  );
}

/** id muzzle radius: 200+(rand&31). `rand` returns [0,1). */
export function muzzleRadius(rand: () => number): number {
  return 200 + ((rand() * 32) | 0);
}

/** id EF_BLASTER in-flight dlight (cl_ents.c): 200, pure yellow. */
export const BLASTER_INFLIGHT_LIGHT = 200;
export const BLASTER_INFLIGHT_COLOR: [number, number, number] = [1, 1, 0];

/** id CL_BlasterTrail fixed trail color (cl_fx.c): 0xe0, no jitter. */
export const BLASTER_TRAIL_COLOR = 0xe0;
/** id SP blaster damage (p_weapon.c Weapon_Blaster_Fire: 15 only in DM). */
export const BLASTER_DAMAGE_SP = 10;

/**
 * id beam split (g_weapon.c): the blaster is a PROJECTILE weapon
 * (fire_blaster bolt edict) — never hitscan, never a muzzle->impact
 * beam. Hitscan weapons (shotgun/machinegun, fire_lead) are instant
 * traces with impact sparks only; only the railgun draws a beam
 * (TE_RAILTRAIL, not in v1). So no v1 weapon fires a beam.
 */
export function weaponFiresBeam(classname: string): boolean {
  void classname;
  return false;
}

// --- soldier return-fire kind (green-bolt regression, M7.2) --------------
//
// id m_soldier.c soldier_fire picks the weapon by SKIN, not at random:
// skinnum <= 1 (monster_soldier_light) fires monster_fire_blaster (a real
// 600 u/s foe bolt), skinnum <= 3 (monster_soldier) fires hitscan shotgun,
// the rest fire hitscan machinegun bullets. The lite selectAttack rolls
// shotgun/blaster at random with no skin, so a basic (shotgun-skin)
// soldier could fire a projectile bolt it never should — the "green
// something" users saw. These helpers pin the skin mapping so drivers
// only spawn bolt entities for blaster-skin soldiers; everything else is
// hitscan tracer + yellow dlight, never a green bolt entity.

/** Soldier weapon by skinnum (m_soldier.c SP_ funcs: light 0, plain 2, ss 4+). */
export function soldierWeaponForSkin(skin: number): 'blaster' | 'shotgun' | 'machinegun' {
  if (skin <= 1) return 'blaster';
  if (skin <= 3) return 'shotgun';
  return 'machinegun';
}

export type SoldierSkin = 'blaster' | 'shotgun' | 'machinegun';

/**
 * Skin-aware soldier attack choice: melee in melee range, else the
 * skin's weapon (never a random bolt for a shotgun skin). `rand` is
 * kept for the melee/cadence callers; the weapon itself is fixed.
 */
export function selectSoldierAttack(
  skin: SoldierSkin | number,
  dist: number,
  rand: () => number,
): 'melee' | 'blaster' | 'shotgun' | 'machinegun' | 'none' {
  void rand;
  if (dist < 80) return 'melee';
  const weapon: SoldierSkin = typeof skin === 'number' ? soldierWeaponForSkin(skin) : skin;
  if (weapon === 'blaster') return dist < 1000 ? 'blaster' : 'none';
  if (dist >= 1000) return 'none';
  return weapon;
}

/**
 * True only for a soldier blaster-skin attack — the single case that
 * spawns a foe bolt entity (monster_fire_blaster, EF_BLASTER, yellow
 * 0xe0 trail). Shotgun/machinegun/chaingun/grenade/melee are hitscan
 * tracers or touches: they must never produce a bolt entity, green or
 * otherwise.
 */
export function attackFiresBolt(kind: string, choice: string): boolean {
  return kind === 'soldier' && choice === 'blaster';
}

/** Yellow particle/trail range (cl_fx.c 0xe0 + (rand&7)): bolts and boom
 * sparks live here. */
export const YELLOW_COLOR_BASE = 0xe0;
export const YELLOW_COLOR_END = 0xe8;
/** Green particle range (cl_fx.c 0xd0 + (rand&7) for teleport/BFG — in
 * the pak palette 208-214 are green and 215 (0xd7) is the near-white
 * tracer core): no bolt or tracer halo may ever use 208-214 — that is
 * the "green bolt" bug (PELLET green 208). */
export const GREEN_COLOR_BASE = 0xd0;
export const GREEN_COLOR_END = 0xd7;

export function isGreenBoltColor(color: number): boolean {
  return color >= GREEN_COLOR_BASE && color < GREEN_COLOR_END;
}

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
