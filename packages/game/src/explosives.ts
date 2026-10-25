// @q2/game/explosives — shootable/scripted explosion data (g_misc.c, g_target.c).
// Ports the SP_ spawn defaults for misc_explobox (barrel_delay), func_explosive
// (func_explosive_explode) and target_explosion (use_target_explosion) as pure
// data: no spawning, no linking, no level.time — callers (the web driver)
// already parse the entities lump and only need the canonical id defaults
// (verified against base1.bsp: 9 misc_explobox with no explicit health/dmg,
// 2 func_explosive with explicit keys, 12 target_explosion with dmg 1).

import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import type { EntDict } from './entities.js';
import { parseFloat, parseInt, parseVec3 } from './entities.js';

/** Pak model for the exploding barrel (SP_misc_explobox). */
export const EXPLOBOX_MODEL = 'models/objects/barrels/tris.md2';

/** Barrel hull in origin space (VectorSet mins -16,-16,0 / maxs 16,16,40). */
export const EXPLOBOX_MINS: Vec3 = v3(-16, -16, 0);
export const EXPLOBOX_MAXS: Vec3 = v3(16, 16, 40);

/** id SP_misc_explobox defaults (QUAKED: mass 400, health 80 sic, dmg 150;
 * the C falls back to health 10 when the key is absent). */
export const EXPLOBOX_DEFAULT_MASS = 400;
export const EXPLOBOX_DEFAULT_HEALTH = 10;
export const EXPLOBOX_DEFAULT_DMG = 150;

/** id SP_func_explosive defaults: health 100 when shootable, dmg 0 (no
 * radius damage unless set), mass 75 at explode time (debris counts). */
export const FUNC_EXPLOSIVE_DEFAULT_MASS = 75;
export const FUNC_EXPLOSIVE_DEFAULT_HEALTH = 100;
export const FUNC_EXPLOSIVE_DEFAULT_DMG = 0;

/** id SP_target_explosion defaults (QUAKED: dmg defaults to 0, no delay). */
export const TARGET_EXPLOSION_DEFAULT_DMG = 0;
export const TARGET_EXPLOSION_DEFAULT_DELAY = 0;

export type ExplosiveKind = 'misc_explobox' | 'func_explosive' | 'target_explosion';

export interface Explosive {
  kind: ExplosiveKind;
  origin: Vec3;
  /** Hit points before barrel_delay/func_explosive_explode runs. */
  health: number;
  /** Radius damage (T_RadiusDamage dmg, +40 falloff radius). */
  dmg: number;
  /** Debris mass class (barrel 400, explosive 75). */
  mass: number;
  /** Model lump for point-sized barrels; '' for brush/scripted entries. */
  model: string;
  targetname: string;
  target: string;
  /** target_explosion fuse (use_target_explosion delay). */
  delay: number;
}

/** True for the three explosive classnames (parse gate). */
export function isExplosiveClassname(classname: string | undefined): boolean {
  return classname === 'misc_explobox' || classname === 'func_explosive' || classname === 'target_explosion';
}

function numKey(dict: EntDict, keys: string[], fallback: number): number {
  for (const k of keys) {
    const raw = dict[k];
    if (raw === undefined) continue;
    const v = k === 'health' || k === 'mass' ? parseInt(raw, NaN) : parseFloat(raw, NaN);
    if (Number.isFinite(v)) return v;
  }
  return fallback;
}

/**
 * Build the id-authentic explosive record for an entities-lump dict.
 * Returns null for non-explosive classnames. Explicit `health`/`dmg`/
 * (`damage` legacy alias)/`mass`/`delay` keys override the C defaults;
 * non-finite values fall back to the defaults (never NaN).
 */
export function spawnExplosive(dict: EntDict): Explosive | null {
  const classname = dict['classname'];
  if (!isExplosiveClassname(classname)) return null;
  const kind = classname as ExplosiveKind;
  const origin = parseVec3(dict['origin'], v3());
  const targetname = dict['targetname'] ?? '';
  const target = dict['target'] ?? '';
  if (kind === 'misc_explobox') {
    return {
      kind,
      origin,
      health: numKey(dict, ['health'], EXPLOBOX_DEFAULT_HEALTH),
      dmg: numKey(dict, ['dmg', 'damage'], EXPLOBOX_DEFAULT_DMG),
      mass: numKey(dict, ['mass'], EXPLOBOX_DEFAULT_MASS),
      model: EXPLOBOX_MODEL,
      targetname,
      target,
      delay: TARGET_EXPLOSION_DEFAULT_DELAY,
    };
  }
  if (kind === 'func_explosive') {
    return {
      kind,
      origin,
      health: numKey(dict, ['health'], FUNC_EXPLOSIVE_DEFAULT_HEALTH),
      dmg: numKey(dict, ['dmg', 'damage'], FUNC_EXPLOSIVE_DEFAULT_DMG),
      mass: numKey(dict, ['mass'], FUNC_EXPLOSIVE_DEFAULT_MASS),
      model: dict['model'] ?? '',
      targetname,
      target,
      delay: TARGET_EXPLOSION_DEFAULT_DELAY,
    };
  }
  return {
    kind,
    origin,
    health: 0,
    dmg: numKey(dict, ['dmg', 'damage'], TARGET_EXPLOSION_DEFAULT_DMG),
    mass: 0,
    model: '',
    targetname,
    target,
    delay: numKey(dict, ['delay'], TARGET_EXPLOSION_DEFAULT_DELAY),
  };
}
