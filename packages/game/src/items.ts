// @q2/game/items — item definitions + pickup semantics (g_items.c).
// Covers what base1 needs: health, ammo, weapons, armor basics.

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
