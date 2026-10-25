// @q2/game/items — item definitions + pickup semantics (g_items.c).
// Covers what base1 needs: health, ammo, weapons, armor basics.

import { SOLID_NOT, SOLID_TRIGGER } from './entities.js';
import type { Edict } from './entities.js';

export interface ItemDef {
  classname: string;
  kind: 'health' | 'ammo' | 'weapon' | 'armor' | 'key' | 'powerup';
  /** amount granted, or ammo type capacity info for weapons */
  amount: number;
  /** ammo classname consumed/granted (weapons + ammo items) */
  ammoKind: string;
  maxCarry: number;
}

export const MAX_HEALTH = 100;

// --- pickup respawn (g_items.c DoRespawn / SetRespawn) ----------------------
//
// id delays (deathmatch pickup path): weapons 30s (Pickup_Weapon), health
// 30s (Pickup_Health), ammo 30s (Pickup_Ammo), armor 20s (Pickup_Armor),
// powerups item->quantity. id only respawns in deathmatch — single-player
// pickups are freed permanently (Touch_Item -> G_FreeEdict). M7.4 enables
// DM-style timers unconditionally so base1 stays playable end to end;
// the DELAYS below are ported verbatim from the C Pickup_* call sites.
//
// Mechanics (C): SetRespawn hides the edict (SOLID_NOT + SVF_NOCLIENT,
// think = DoRespawn at level.time + delay); DoRespawn re-materializes it
// (SOLID_TRIGGER + EV_ITEM_RESPAWN event). Our edicts have no SVF flags,
// so the pending timer lives in extra['respawnAt'] (level.time seconds)
// and DoRespawn reports readiness to the caller (server tick / driver),
// which re-links the entity (solid TRIGGER) and plays the effect.

export const RESPAWN_DELAY_WEAPON = 30;
export const RESPAWN_DELAY_AMMO = 30;
export const RESPAWN_DELAY_HEALTH = 30;
export const RESPAWN_DELAY_ARMOR = 20;

/** id respawn delay table by classname prefix (g_items.c Pickup_*). */
export function respawnDelayFor(classname: string): number {
  if (classname.startsWith('item_armor')) return RESPAWN_DELAY_ARMOR;
  if (classname.startsWith('item_health')) return RESPAWN_DELAY_HEALTH;
  if (classname.startsWith('weapon_')) return RESPAWN_DELAY_WEAPON;
  if (classname.startsWith('ammo_')) return RESPAWN_DELAY_AMMO;
  if (classname.startsWith('item_')) return RESPAWN_DELAY_HEALTH;
  return RESPAWN_DELAY_WEAPON;
}

const ITEMS: Record<string, ItemDef> = {
  item_health_small: { classname: 'item_health_small', kind: 'health', amount: 2, ammoKind: '', maxCarry: 100 },
  item_health: { classname: 'item_health', kind: 'health', amount: 10, ammoKind: '', maxCarry: 100 },
  item_health_large: { classname: 'item_health_large', kind: 'health', amount: 25, ammoKind: '', maxCarry: 100 },
  item_health_mega: { classname: 'item_health_mega', kind: 'health', amount: 100, ammoKind: '', maxCarry: 200 },
  item_armor_shard: { classname: 'item_armor_shard', kind: 'armor', amount: 2, ammoKind: '', maxCarry: 100 },
  item_armor_jacket: { classname: 'item_armor_jacket', kind: 'armor', amount: 50, ammoKind: '', maxCarry: 50 },
  item_armor_combat: { classname: 'item_armor_combat', kind: 'armor', amount: 100, ammoKind: '', maxCarry: 100 },
  item_armor_body: { classname: 'item_armor_body', kind: 'armor', amount: 200, ammoKind: '', maxCarry: 200 },
  ammo_shells: { classname: 'ammo_shells', kind: 'ammo', amount: 10, ammoKind: 'shells', maxCarry: 100 },
  ammo_bullets: { classname: 'ammo_bullets', kind: 'ammo', amount: 50, ammoKind: 'bullets', maxCarry: 200 },
  ammo_cells: { classname: 'ammo_cells', kind: 'ammo', amount: 50, ammoKind: 'cells', maxCarry: 200 },
  ammo_rockets: { classname: 'ammo_rockets', kind: 'ammo', amount: 5, ammoKind: 'rockets', maxCarry: 50 },
  ammo_slugs: { classname: 'ammo_slugs', kind: 'ammo', amount: 10, ammoKind: 'slugs', maxCarry: 50 },
  weapon_shotgun: { classname: 'weapon_shotgun', kind: 'weapon', amount: 1, ammoKind: 'shells', maxCarry: 1 },
  weapon_machinegun: { classname: 'weapon_machinegun', kind: 'weapon', amount: 1, ammoKind: 'bullets', maxCarry: 1 },
  weapon_blaster: { classname: 'weapon_blaster', kind: 'weapon', amount: 1, ammoKind: '', maxCarry: 1 },
};

export function findItem(classname: string): ItemDef | null {
  return ITEMS[classname] ?? null;
}

export interface PlayerState {
  health: number;
  maxHealth: number;
  armor: number;
  maxArmor: number;
  ammo: Record<string, number>;
  weapons: string[];
}

export function makePlayerState(): PlayerState {
  return { health: 100, maxHealth: MAX_HEALTH, armor: 0, maxArmor: 100, ammo: {}, weapons: ['weapon_blaster'] };
}

export interface PickupResult {
  picked: boolean;
  applied: number;
  reason: string;
}

/**
 * Pickup_Health / Pickup_Ammo / weapon pickup semantics.
 * Megahealth may exceed maxHealth up to its own cap (rot handled by game logic).
 */
export function pickupItem(ps: PlayerState, classname: string): PickupResult {
  const def = findItem(classname);
  if (!def) return { picked: false, applied: 0, reason: 'unknown item' };
  switch (def.kind) {
    case 'health': {
      const cap = classname === 'item_health_mega' ? def.maxCarry : ps.maxHealth;
      if (ps.health >= cap) return { picked: false, applied: 0, reason: 'already full' };
      const want = Math.min(def.amount, cap - ps.health);
      ps.health += want;
      return { picked: true, applied: want, reason: 'health' };
    }
    case 'ammo': {
      const cur = ps.ammo[def.ammoKind] ?? 0;
      if (cur >= def.maxCarry) return { picked: false, applied: 0, reason: 'ammo full' };
      const want = Math.min(def.amount, def.maxCarry - cur);
      ps.ammo[def.ammoKind] = cur + want;
      return { picked: true, applied: want, reason: 'ammo' };
    }
    case 'weapon': {
      if (!ps.weapons.includes(classname)) ps.weapons.push(classname);
      if (def.ammoKind) {
        const cur = ps.ammo[def.ammoKind] ?? 0;
        ps.ammo[def.ammoKind] = Math.min(cur + 10, 200);
      }
      return { picked: true, applied: 1, reason: 'weapon' };
    }
    case 'armor': {
      const cap = Math.max(ps.maxArmor, def.maxCarry);
      if (ps.armor >= cap) return { picked: false, applied: 0, reason: 'armor full' };
      const want = Math.min(def.amount, cap - ps.armor);
      ps.armor += want;
      return { picked: true, applied: want, reason: 'armor' };
    }
    default:
      return { picked: false, applied: 0, reason: 'unhandled kind' };
  }
}

/**
 * SetRespawn (g_items.c): hide a consumed pickup and schedule DoRespawn
 * at level.time + delay. The edict stays allocated (id clears SVF_NOCLIENT
 * instead of freeing); callers must skip intangible edicts (solid NOT).
 * `now` is level.time in seconds — never wall-clock.
 */
export function SetRespawn(ent: Edict, delay: number, now: number): number {
  const at = now + Math.max(0, delay);
  ent.solid = SOLID_NOT;
  ent.extra['respawnAt'] = String(at);
  ent.extra['respawnDelay'] = String(delay);
  return at;
}

/**
 * DoRespawn (g_items.c): re-materialize a hidden pickup whose timer is due.
 * Returns true exactly when the edict becomes tangible again (the caller
 * emits the EV_ITEM_RESPAWN equivalent); otherwise false (still hidden or
 * no timer armed). Ready edicts come back SOLID_TRIGGER.
 */
export function DoRespawn(ent: Edict, now: number): boolean {
  const raw = ent.extra['respawnAt'];
  if (raw === undefined) return false;
  const at = Number(raw);
  if (!Number.isFinite(at) || now < at) return false;
  delete ent.extra['respawnAt'];
  ent.solid = SOLID_TRIGGER;
  ent.state = 'respawned';
  return true;
}

/** True while a SetRespawn timer is armed on the edict (hidden, pending). */
export function isRespawning(ent: Edict): boolean {
  return ent.extra['respawnAt'] !== undefined;
}
