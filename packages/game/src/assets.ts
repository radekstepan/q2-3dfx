// @q2/game/assets — pak entry names for monster/weapon/bolt models + skins.
//
// Ports the gi.modelindex precache strings from the C game:
// m_soldier.c (`models/monsters/soldier/tris.md2`), m_gunner.c
// (`models/monsters/gunner/tris.md2`), g_items.c (weapon view/world
// models), g_weapon.c fire_blaster (`models/objects/laser/tris.md2`).
//
// Pure data tables: no parsing, no filesystem access (per BRAIN.md §4 the
// game package must not depend on @q2/filesystem). Callers (apps/web) load
// the lumps via parseMD2/parsePCX, hand the decoded data to
// Refresh.registerModel/registerSkin as kind 'md2', and drive entity
// frame/skin from the M5.3 move tables (SOLDIER/GUNNER first/last frames
// already match the MD2 frame numbers). When the pak lacks an entry
// (devroom fallback), resolvePakAsset picks the placeholder instead.

import type { MonsterKind } from './monsters.js';
import { monsterDef } from './monsters.js';

/** Pak model lump for each lite monster (m_soldier.c / m_gunner.c / m_infantry.c). */
export const MONSTER_MODELS: Record<MonsterKind, string> = {
  soldier: 'models/monsters/soldier/tris.md2',
  gunner: 'models/monsters/gunner/tris.md2',
  infantry: 'models/monsters/infantry/tris.md2',
};

/** Pak skin lumps per monster. `default` is skin 0; soldier variants and
 * pain skins follow the skinnum logic in m_soldier.c / m_gunner.c
 * (soldier skin_lt/ss = guard/shotgun variants, skin 1 = pain flash;
 * gunner skinnum 1 = pain). */
export const MONSTER_SKINS: Record<MonsterKind, { default: string; pain: string; variants: string[] }> = {
  soldier: {
    default: 'models/monsters/soldier/skin.pcx',
    pain: 'models/monsters/soldier/pain.pcx',
    variants: [
      'models/monsters/soldier/skin.pcx',
      'models/monsters/soldier/skin_lt.pcx',
      'models/monsters/soldier/skin_ltp.pcx',
      'models/monsters/soldier/skin_ss.pcx',
      'models/monsters/soldier/skin_ssp.pcx',
      'models/monsters/soldier/pain.pcx',
    ],
  },
  gunner: {
    default: 'models/monsters/gunner/skin.pcx',
    pain: 'models/monsters/gunner/pain.pcx',
    variants: ['models/monsters/gunner/skin.pcx', 'models/monsters/gunner/pain.pcx'],
  },
  infantry: {
    default: 'models/monsters/infantry/skin.pcx',
    pain: 'models/monsters/infantry/pain.pcx',
    variants: ['models/monsters/infantry/skin.pcx', 'models/monsters/infantry/pain.pcx'],
  },
};

/** Pak model lump for the blaster bolt (g_weapon.c fire_blaster). */
export const BOLT_MODEL = 'models/objects/laser/tris.md2';
/** Skin for the blaster bolt (same dir as the bolt model). */
export const BOLT_SKIN = 'models/objects/laser/skin.pcx';
/** Bolt speed from Blaster_Fire (p_weapon.c: fire_blaster(..., 1000, ...)). */
export const BOLT_SPEED = 1000;
/** Bolt lifetime: think = G_FreeEdict at level.time + 2 (g_weapon.c). */
export const BOLT_LIFE = 2;
/** EF_BLASTER trail flag (q_shared.h): red light + blaster trail. */
export const EF_BLASTER = 0x00000008;

/** View (v_weap) model lumps per player weapon (g_items.c). */
export const WEAPON_VIEW_MODELS: Record<string, string> = {
  weapon_blaster: 'models/weapons/v_blast/tris.md2',
  weapon_shotgun: 'models/weapons/v_shotg/tris.md2',
  weapon_machinegun: 'models/weapons/v_machn/tris.md2',
};

/** World (g_weap) model lumps per player weapon (g_items.c world_model). */
export const WEAPON_WORLD_MODELS: Record<string, string> = {
  weapon_blaster: 'models/weapons/g_blast/tris.md2',
  weapon_shotgun: 'models/weapons/g_shotg/tris.md2',
  weapon_machinegun: 'models/weapons/g_machn/tris.md2',
};

/** Pak model lump for a monster kind (verified against pak0.pak). */
export function modelForMonster(kind: MonsterKind): string {
  return MONSTER_MODELS[kind];
}

/** Pak skin lump for a monster kind (`default` = skin 0, `pain` = pain flash). */
export function skinForMonster(kind: MonsterKind, variant: 'default' | 'pain' = 'default'): string {
  return variant === 'pain' ? MONSTER_SKINS[kind]!.pain : MONSTER_SKINS[kind]!.default;
}

/** Every skin lump shipped for a monster kind (for precache/register loops). */
export function skinsForMonster(kind: MonsterKind): string[] {
  return [...MONSTER_SKINS[kind]!.variants];
}

/**
 * First MD2 frame number of a lite state-machine move (SOLDIER/GUNNER
 * first/last already match the model frame numbers). Null for unknown
 * moves. Lets the driver set Entity.frame/skin without hardcoding paths.
 */
export function monsterFrameFor(kind: MonsterKind, move: string): number | null {
  const mv = monsterDef(kind).moves[move];
  return mv ? mv.first : null;
}

/** Map a BSP classname to its lite monster kind; null when not a monster. */
export function monsterKindForClassname(classname: string): MonsterKind | null {
  if (classname === 'monster_soldier') return 'soldier';
  if (classname === 'monster_gunner') return 'gunner';
  if (classname === 'monster_infantry') return 'infantry';
  return null;
}

/** View (v_weap) model lump for a player weapon classname; null when unknown. */
export function viewModelForWeapon(classname: string): string | null {
  return WEAPON_VIEW_MODELS[classname] ?? null;
}

/** World (g_weap) model lump for a player weapon classname; null when unknown. */
export function worldModelForWeapon(classname: string): string | null {
  return WEAPON_WORLD_MODELS[classname] ?? null;
}

/** Pak model lump for a player weapon classname (the view model); null when unknown. */
export function modelForWeapon(classname: string): string | null {
  return viewModelForWeapon(classname);
}

/**
 * Skin lump for a weapon model lump. Weapon skins live next to their
 * model as skin.pcx, except g_blast which ships base.pcx (verified in
 * pak0.pak). Unknown models fall back to the sibling skin.pcx convention.
 */
export function skinForWeaponModel(modelPath: string): string {
  if (modelPath === 'models/weapons/g_blast/tris.md2') return 'models/weapons/g_blast/base.pcx';
  const slash = modelPath.lastIndexOf('/');
  const dir = slash >= 0 ? modelPath.slice(0, slash) : '';
  return dir ? `${dir}/skin.pcx` : 'skin.pcx';
}

/** Pak model lump for the blaster bolt (id fire_blaster). */
export function modelForBolt(): string {
  return BOLT_MODEL;
}

/** Pak skin lump for the blaster bolt. */
export function skinForBolt(): string {
  return BOLT_SKIN;
}

/**
 * Devroom-safe resolution: return the requested pak entry when the pak
 * has it, else the caller-supplied placeholder (e.g. the registered
 * box-critter/dev-mesh handle name). `has` is typically
 * `(n) => pak.has(n)` (PakFile) or the web WebPak equivalent — the game
 * package never touches the filesystem itself. Never throws.
 */
export function resolvePakAsset(
  requested: string,
  has: (name: string) => boolean,
  fallback: string,
): string {
  try {
    return has(requested) ? requested : fallback;
  } catch {
    return fallback;
  }
}
