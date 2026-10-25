// @q2/game/weapons — blaster/shotgun/machinegun (game/p_weapon.c, g_weapon.c).
// Spread values are id's DEFAULT_* constants; damage/ammo/pellet counts match
// the non-deathmatch player weapons. Spread sampling is caller-seeded:
// pass a `rand()` in [0,1) so firing is fully deterministic in tests.

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
  damage: 15,
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
    return { fired: false, reason: 'no ammo', pellets: [], ammoLeft: ammo };
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
  return {
    fired: true,
    reason: 'ok',
    pellets,
    ammoLeft: def.ammoKind ? ammo - def.ammoPerShot : ammo,
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
