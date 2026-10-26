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

/** id barrel_delay (g_misc.c): lethal hit sets takedamage NO + a 0.2s fuse
 * (think = barrel_explode at level.time + 2 frames of 0.1s). */
export const BARREL_FUSE_DELAY = 0.2;

export type ExplosiveKind = 'misc_explobox' | 'func_explosive' | 'target_explosion';

/** Visual explosion kind (client/cl_tent.c TE_ paths): big barrel/func/
 * target blast, grounded big blast, or the 4-frame blaster touch flash. */
export type ExplosionVisual = 'explosion1' | 'explosion2' | 'blaster';

/** Visual frame life at 100ms/frame (cl_tent.c CL_AddExplosions frac
 * stepping): r_explode 15f (base 15 or 0), grounded 19f base 30,
 * ex_misc 4f. */
export const EXPLOSION_FRAMES: Record<ExplosionVisual, number> = {
  explosion1: 15,
  explosion2: 19,
  blaster: 4,
};

export function explosionFrames(kind: ExplosionVisual): number {
  return EXPLOSION_FRAMES[kind];
}

/** id baseframe (cl_tent.c): explosion2 grounded bursts sit at base 30,
 * explosion1 picks 15 half the time (else 0), blaster ex_misc has none. */
export function explosionBaseframe(kind: ExplosionVisual, rand: () => number): number {
  if (kind === 'explosion2') return 30;
  if (kind === 'explosion1') return rand() < 0.5 ? 15 : 0;
  return 0;
}

/** id dlight radius (cl_tent.c): big booms 350, blaster touch flash 150. */
export const EXPLOSION_LIGHT: Record<ExplosionVisual, number> = {
  explosion1: 350,
  explosion2: 350,
  blaster: 150,
};

/** id dlight color (cl_tent.c): big booms orange (1, 0.5, 0.5), blaster
 * touch flash pure yellow (1, 1, 0 — [2] stays 0 from the alloc). */
export const EXPLOSION_LIGHT_COLOR: Record<ExplosionVisual, [number, number, number]> = {
  explosion1: [1, 0.5, 0.5],
  explosion2: [1, 0.5, 0.5],
  blaster: [1, 1, 0],
};

/**
 * id alpha decay (cl_tent.c CL_AddExplosions): ex_poly big booms fade
 * (16-f)/16; ex_misc blaster flashes fade linearly 1-f/(frames-1).
 * `f` is the 0-based 100ms frame index. Pure, headless-testable.
 */
export function explosionAlpha(kind: ExplosionVisual, f: number): number {
  const frames = EXPLOSION_FRAMES[kind];
  if (kind === 'blaster') {
    if (f >= frames - 1) return 0;
    return Math.max(0, Math.min(1, 1 - f / (frames - 1)));
  }
  if (f >= frames - 1) return 0;
  return Math.max(0, Math.min(1, (16 - f) / 16));
}

/** id CL_ExplosionParticles (cl_fx.c): 256-count ballistic boom burst. */
export const EXPLOSION_SPARK_COUNT = 256;
/** id CL_BlasterParticles (cl_fx.c): 40-spark wall-impact burst. */
export const BLASTER_SPARK_COUNT = 40;
/** Fixed yellow palette base for both bursts + the in-flight trail. */
export const SPARK_COLOR_BASE = 0xe0;
/** Per-spark jitter on the burst colors (0xe0 + (rand&7)). */
export const SPARK_COLOR_JITTER = 8;
/** Big-boom spark velocities: (rand%384)-192 per axis (cl_fx.c). */
export const EXPLOSION_SPARK_SPEED = 192;
/** Big-boom ttl from alphavel -0.8/(0.5+rand*0.3): 0.625–1.0s. */
export const EXPLOSION_SPARK_TTL_MIN = 0.625;
export const EXPLOSION_SPARK_TTL_MAX = 1.0;

/** id barrel_explode debris recipe (g_misc.c): 2 big + 4 bottom-corner +
 * 8 small = 14 bouncing (MOVETYPE_BOUNCE) chunks. */
export const BARREL_DEBRIS_BIG = 2;
export const BARREL_DEBRIS_CORNER = 4;
export const BARREL_DEBRIS_SMALL = 8;
export const BARREL_DEBRIS_TOTAL = BARREL_DEBRIS_BIG + BARREL_DEBRIS_CORNER + BARREL_DEBRIS_SMALL;
export const DEBRIS_MODEL_BIG = 'models/objects/debris1/tris.md2';
export const DEBRIS_MODEL_SMALL = 'models/objects/debris2/tris.md2';
export const DEBRIS_MODEL_CORNER = 'models/objects/debris3/tris.md2';

/** id ThrowDebris (g_misc.c): 100*crandom planar, 100+100*rand up,
 * scaled by speed; 5+rand*5s life; bounce backoff 1.5. */
export const DEBRIS_LIFE_MIN = 5;
export const DEBRIS_LIFE_SPAN = 5;
export const DEBRIS_BOUNCE_BACKOFF = 1.5;
/** id ThrowGib (g_misc.c): MOVETYPE_TOSS, touch, 10+rand*10s life. */
export const GIB_LIFE_MIN = 10;
export const GIB_LIFE_SPAN = 10;
export const GIB_TOSS_BACKOFF = 1.0;

/** Barrel debris speeds as fractions of dmg (barrel_explode): big
 * 1.5*dmg/200 at the center, corners 1.75*dmg/200 at the absmin
 * corners, small 2*dmg/200 at the center. */
export function barrelDebrisSpeeds(dmg: number): { big: number; corner: number; small: number } {
  return { big: (1.5 * dmg) / 200, corner: (1.75 * dmg) / 200, small: (2 * dmg) / 200 };
}

/**
 * id func_explosive_explode debris counts (g_misc.c): one large chunk
 * per 100 of mass (up to 8, only when mass >= 100) and one small chunk
 * per 25 of mass (up to 16). Mass defaults to 75 when unset.
 */
export function funcExplosiveDebris(mass: number): { big: number; small: number } {
  const m = mass || FUNC_EXPLOSIVE_DEFAULT_MASS;
  return {
    big: m >= 100 ? Math.min(8, Math.floor(m / 100)) : 0,
    small: Math.min(16, Math.floor(m / 25)),
  };
}

/** id T_RadiusDamage falloff radius (g_combat.c): dmg + 40. */
export function radiusDamageRadius(dmg: number): number {
  return dmg + 40;
}

/**
 * id T_RadiusDamage points (g_combat.c): distance is measured from the
 * entity's bbox CENTER (mins+maxs)/2 via VectorMA(origin, 0.5, mins+maxs),
 * points = damage - 0.5 * length. The attacker takes half. LOS
 * (CanDamage) must pass — the caller owns the trace, this is pure math.
 */
export function radiusDamagePoints(dmg: number, dist: number): number {
  return dmg - 0.5 * dist;
}

export function radiusDamageAttackerPoints(points: number): number {
  return points * 0.5;
}

/** Gib extras (m_soldier.c soldier_die / m_gunner.c gunner_die gib
 * branch): soldier 3x sm_meat + chest + head2, gunner 2x bone + 4x
 * sm_meat + head2, all GIB_ORGANIC, over misc/udeath.wav, DEAD_DEAD. */
export const GIB_SOUND = 'misc/udeath.wav';
export const GIB_DEADFLAG = 'DEAD_DEAD';
export const SOLDIER_GIB_MODELS = ['sm_meat', 'sm_meat', 'sm_meat', 'chest', 'head2'] as const;
export const GUNNER_GIB_MODELS = ['bone', 'bone', 'sm_meat', 'sm_meat', 'sm_meat', 'sm_meat', 'head2'] as const;

export function gibModelsFor(kind: 'soldier' | 'gunner'): readonly string[] {
  return kind === 'soldier' ? SOLDIER_GIB_MODELS : GUNNER_GIB_MODELS;
}

/** Q2 has no scorch decals — explosions never leave one. */
export function leavesScorch(_kind: ExplosionVisual): boolean {
  return false;
}

/** Fuse scheduling (barrel_delay / use_target_explosion): think runs at
 * level.time + delay on server time. Barrel fuses carry the 0.2s delay. */
export function barrelFuseAt(now: number): number {
  return now + BARREL_FUSE_DELAY;
}

export function targetExplosionFuseAt(now: number, delay: number): number {
  return now + delay;
}

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
