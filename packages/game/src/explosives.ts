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
 * (16-f)/16 on the FLOORED frame index (cl_tent.c:1644); ex_misc blaster
 * flashes fade linearly on the CONTINUOUS frac clock
 * (1.0-frac/(frames-1), cl_tent.c:1627). `f` accepts fractional frames so
 * both paths are C-exact; integer callers are unchanged.
 */
export function explosionAlpha(kind: ExplosionVisual, f: number): number {
  const frames = EXPLOSION_FRAMES[kind];
  if (kind === 'blaster') {
    if (f >= frames - 1) return 0;
    return Math.max(0, Math.min(1, 1 - f / (frames - 1)));
  }
  const fi = Math.floor(f);
  if (fi >= frames - 1) return 0;
  return Math.max(0, Math.min(1, (16 - fi) / 16));
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

// --- TE client-presentation tables (client/cl_tent.c, client/cl_fx.c) -------
//
// Canonical C-exact temporary-entity parameters both renderers consume.
// Pure tables/helpers only: no spawning, no rendering, no sim flow.
// C refs are to ../external/quake-2-source (sibling of the repo).

/** Pak lump for the TE_BLASTER touch flash (cl_mod_explode, cl_tent.c:174).
 * The pak model ships 5 frames (parseMD2 of pak0.pak); the TE plays 4
 * (ex->frames = 4, cl_tent.c:823). */
export const BLASTER_IMPACT_MODEL = 'models/objects/explode/tris.md2';
/** Pak lump for TE_EXPLOSION1/2 big booms (cl_mod_explo4, cl_tent.c:180).
 * The pak model ships 49 frames / 7 skins (parseMD2 of pak0.pak): exactly
 * covering grounded base-30 + 19 frames (max entity frame 30+13+1 = 44)
 * and the ex_poly skin stepping 0..4 then 5, 6 (cl_tent.c:1646-1660). */
export const BIG_BOOM_MODEL = 'models/objects/r_explode/tris.md2';
/** Pak lump for TE_EXPLOSION1_BIG (Rogue cl_mod_explo4_big, cl_tent.c:201):
 * absent from pak0.pak (mission-pack content), so the id branch can never
 * render from the shareware pak. */
export const BIG_BOOM_MODEL_BIG = 'models/objects/r_explode2/tris.md2';
/** Frames shipped by the pak models above (parseMD2 of pak0.pak). */
export const BLASTER_IMPACT_MODEL_FRAMES = 5;
export const BIG_BOOM_MODEL_FRAMES = 49;
export const BIG_BOOM_MODEL_SKINS = 7;

/** id TE sound lumps (S_RegisterSound, cl_tent.c:136-143). */
export const TE_BLASTER_SOUND = 'weapons/lashit.wav';
export const TE_EXPLOSION1_SOUND = 'weapons/rocklx1a.wav';
export const TE_EXPLOSION2_SOUND = 'weapons/grenlx1a.wav';
export const TE_EXPLOSION_WATER_SOUND = 'weapons/xpld_wat.wav';

/**
 * id TE explosion sound by visual kind (cl_tent.c CL_ParseTEnt): TE_BLASTER
 * always plays lashit (:824); TE_EXPLOSION2/grenade plays watrexp in water
 * (:854) else grenexp (:856); TE_EXPLOSION1/rocket plays watrexp in water
 * (:907) else rockexp (:909).
 */
export function explosionSound(kind: ExplosionVisual, water: boolean): string {
  if (kind === 'blaster') return TE_BLASTER_SOUND;
  if (water) return TE_EXPLOSION_WATER_SOUND;
  return kind === 'explosion2' ? TE_EXPLOSION2_SOUND : TE_EXPLOSION1_SOUND;
}

/**
 * id barrel TE choice (g_misc.c barrel_explode): a grounded barrel becomes
 * TE_EXPLOSION2 (BecomeExplosion2), an airborne one TE_EXPLOSION1
 * (BecomeExplosion1).
 */
export function barrelExplosionKind(grounded: boolean): ExplosionVisual {
  return grounded ? 'explosion2' : 'explosion1';
}

/**
 * id func_explosive TE choice (g_misc.c func_explosive_explode): brush
 * bombs with dmg become TE_EXPLOSION1 (BecomeExplosion1); dmg-0 ones free
 * silently with debris only (no TE at all).
 */
export function funcExplosiveBlast(dmg: number): ExplosionVisual | null {
  return dmg ? 'explosion1' : null;
}

/**
 * id explosion visual life in seconds (cl_tent.c CL_AddExplosions: the
 * explosion is freed when f >= frames-1 at 100ms/frame, :1616-1625):
 * blaster 0.3s, explosion1 1.4s, explosion2 1.8s.
 */
export function explosionLifetime(kind: ExplosionVisual): number {
  return (EXPLOSION_FRAMES[kind] - 1) * 0.1;
}

/** One frame-lerped explosion entity pose (cl_tent.c:1687-1689). */
export interface ExplosionLerp {
  /** ent->frame = baseframe + f + 1. */
  frame: number;
  /** ent->oldframe = baseframe + f. */
  oldframe: number;
  /** ent->backlerp = 1 - lerpfrac (clamped per the renderer-api contract). */
  backlerp: number;
}

/**
 * id RF_FRAMELERP smoothing (cl_tent.c CL_AddExplosions :1687-1689):
 * `f` is the floored 100ms frame index, `lerpfrac` the client render
 * fraction. Pure, headless-testable.
 */
export function explosionLerp(baseframe: number, f: number, lerpfrac: number): ExplosionLerp {
  return {
    frame: baseframe + f + 1,
    oldframe: baseframe + f,
    backlerp: Math.max(0, Math.min(1, 1 - lerpfrac)),
  };
}

/** ex_poly skin/flag step for one frame index (cl_tent.c:1646-1660). */
export interface ExplosionSkin {
  /** ent->skinnum: f>>1 while f < 10, 5 while f < 13, else 6. */
  skinnum: number;
  /** RF_TRANSLUCENT: always set for ex_misc flashes, set for f >= 10. */
  translucent: boolean;
}

/**
 * id ex_poly fade stepping (cl_tent.c:1646-1660): skinnum walks f>>1 (0..4)
 * for the first 10 frames, then 5 (frames 10-12), then 6, picking up
 * RF_TRANSLUCENT at frame 10. ex_misc blaster flashes are translucent from
 * frame 0 with no skin stepping (flags set once at :813-814).
 */
export function explosionSkin(kind: ExplosionVisual, f: number): ExplosionSkin {
  if (kind === 'blaster') return { skinnum: 0, translucent: true };
  const fi = Math.max(0, Math.floor(f));
  if (fi < 10) return { skinnum: fi >> 1, translucent: false };
  return { skinnum: fi < 13 ? 5 : 6, translucent: true };
}

/**
 * id TE_BLASTER impact orientation (cl_tent.c:807-818, PMM pitch fix):
 * pitch faces along the impact normal via acos(dir[2]), yaw via
 * atan2(dir[1], dir[0]) with the axis-degenerate fallbacks. `dir` is the
 * server-sent impact normal (unit length); the acos input is clamped so
 * degenerate normals yield a pose instead of NaN (C would produce NaN).
 */
export function blasterImpactAngles(dir: Vec3): { pitch: number; yaw: number } {
  const clamped = Math.max(-1, Math.min(1, dir[2]!));
  const pitch = (Math.acos(clamped) / Math.PI) * 180;
  let yaw: number;
  if (dir[0] !== 0) yaw = (Math.atan2(dir[1]!, dir[0]!) / Math.PI) * 180;
  else if (dir[1]! > 0) yaw = 90;
  else if (dir[1]! < 0) yaw = 270;
  else yaw = 0;
  return { pitch, yaw };
}

/** id CL_BlasterParticles recipe (client/cl_fx.c:1242-1275). */
export const BLASTER_SPARK_TTL_MIN = 0.5; // -1/alphavel: 0.5 + frand*0.3
export const BLASTER_SPARK_TTL_MAX = 0.8;
export const BLASTER_SPARK_DIR_SPEED = 30; // vel = dir*30 + crand*40
export const BLASTER_SPARK_JITTER = 40;
export const BLASTER_SPARK_SPREAD = 4; // org += (rand&7)-4 + d*dir
export const BLASTER_SPARK_FORWARD_MAX = 15; // d = rand&15
/** id CL_ExplosionParticles origin spread (cl_fx.c:1177: (rand%32)-16). */
export const EXPLOSION_SPARK_SPREAD = 16;
/** id PARTICLE_GRAVITY (client/client.h:372, cl_fx.c:882): spark accel. */
export const PARTICLE_GRAVITY = 40;

/** gi.multicast destination class (q_shared.h multicast_t). */
export const MULTICAST_PHS = 1;
export const MULTICAST_PVS = 2;

/**
 * Occlusion rule per explosive producer (which broadcast scope the TE
 * uses): barrel/func-explosive blasts are PVS-culled (BecomeExplosion1/2,
 * g_misc.c:314-331); target_explosion blasts are PHS-culled
 * (target_explosion_explode, g_target.c:232-234).
 */
export const TEMP_ENTITY_CULLING: Record<'barrel' | 'func_explosive' | 'target_explosion', number> = {
  barrel: MULTICAST_PVS,
  func_explosive: MULTICAST_PVS,
  target_explosion: MULTICAST_PHS,
};

/** Game-side coverage of one id temp-entity id (q_shared.h temp_event_t). */
export type TempEntityStatus = 'tabled' | 'shared-branch' | 'missing';
export interface TempEntityInfo {
  /** Numeric TE_ id (q_shared.h order, TE_GUNSHOT = 0). */
  id: number;
  /** C enum name. */
  name: string;
  /** cl_tent.c CL_ParseTEnt case line. */
  clTent: number;
  /** Whether packages/game/src pins this TE's parameters. */
  status: TempEntityStatus;
  note: string;
}

/**
 * Box-4 inventory: every id TE id against the game-side tables. `tabled`
 * ids have full parameter tables here; `shared-branch` ids reuse a tabled
 * branch (same case block); `missing` ids have no game table (deliberately
 * deferred — no follow-up card claims them yet).
 */
export const TEMP_ENTITY_INVENTORY: TempEntityInfo[] = [
  { id: 0, name: 'TE_GUNSHOT', clTent: 715, status: 'missing', note: 'hitscan wall impact; no game table' },
  { id: 1, name: 'TE_BLOOD', clTent: 709, status: 'missing', note: 'bullet hitting flesh; no game table' },
  { id: 2, name: 'TE_BLASTER', clTent: 798, status: 'tabled', note: 'impact model/frames/orientation/fade/light/particles/sound' },
  { id: 3, name: 'TE_RAILTRAIL', clTent: 827, status: 'missing', note: 'railgun not in v1 (weaponFiresBeam)' },
  { id: 4, name: 'TE_SHOTGUN', clTent: 753, status: 'missing', note: 'hitscan wall impact; no game table' },
  { id: 5, name: 'TE_EXPLOSION1', clTent: 880, status: 'tabled', note: 'frames/baseframe/lerp/fade/light/particles/sound/culling' },
  { id: 6, name: 'TE_EXPLOSION2', clTent: 834, status: 'tabled', note: 'frames/baseframe/lerp/fade/light/particles/sound/culling' },
  { id: 7, name: 'TE_ROCKET_EXPLOSION', clTent: 882, status: 'shared-branch', note: 'same case block as TE_EXPLOSION1' },
  { id: 8, name: 'TE_GRENADE_EXPLOSION', clTent: 835, status: 'shared-branch', note: 'same case block as TE_EXPLOSION2' },
  { id: 9, name: 'TE_SPARKS', clTent: 716, status: 'missing', note: 'bullet sparks; no game table' },
  { id: 10, name: 'TE_SPLASH', clTent: 760, status: 'missing', note: 'water impact; no game table' },
  { id: 11, name: 'TE_BUBBLETRAIL', clTent: 938, status: 'missing', note: 'water-only; no game table' },
  { id: 12, name: 'TE_SCREEN_SPARKS', clTent: 741, status: 'missing', note: 'no game table' },
  { id: 13, name: 'TE_SHIELD_SPARKS', clTent: 742, status: 'missing', note: 'no game table' },
  { id: 14, name: 'TE_BULLET_SPARKS', clTent: 717, status: 'missing', note: 'same case block as TE_SPARKS; no game table' },
  { id: 15, name: 'TE_LASER_SPARKS', clTent: 783, status: 'missing', note: 'no game table' },
  { id: 16, name: 'TE_PARASITE_ATTACK', clTent: 944, status: 'missing', note: 'monster not in v1; no game table' },
  { id: 17, name: 'TE_ROCKET_EXPLOSION_WATER', clTent: 883, status: 'shared-branch', note: 'same case block as TE_EXPLOSION1 (water sound)' },
  { id: 18, name: 'TE_GRENADE_EXPLOSION_WATER', clTent: 836, status: 'shared-branch', note: 'same case block as TE_EXPLOSION2 (water sound)' },
  { id: 19, name: 'TE_MEDIC_CABLE_ATTACK', clTent: 945, status: 'missing', note: 'monster not in v1; no game table' },
  { id: 20, name: 'TE_BFG_EXPLOSION', clTent: 912, status: 'missing', note: 'BFG not in base1 path; no game table' },
  { id: 21, name: 'TE_BFG_BIGEXPLOSION', clTent: 929, status: 'missing', note: 'BFG not in base1 path; no game table' },
  { id: 22, name: 'TE_BOSSTPORT', clTent: 949, status: 'missing', note: 'boss effect; no game table' },
  { id: 23, name: 'TE_BFG_LASER', clTent: 934, status: 'missing', note: 'BFG not in base1 path; no game table' },
  { id: 24, name: 'TE_GRAPPLE_CABLE', clTent: 955, status: 'missing', note: 'CTF-only; no game table' },
  { id: 25, name: 'TE_WELDING_SPARKS', clTent: 960, status: 'missing', note: 'no game table' },
  { id: 26, name: 'TE_GREENBLOOD', clTent: 982, status: 'missing', note: 'no game table' },
  { id: 27, name: 'TE_BLUEHYPERBLASTER', clTent: 792, status: 'shared-branch', note: 'CL_BlasterParticles only, no ex flash/sound' },
  { id: 28, name: 'TE_PLASMA_EXPLOSION', clTent: 860, status: 'missing', note: 'Rogue; no game table' },
  { id: 29, name: 'TE_TUNNEL_SPARKS', clTent: 989, status: 'missing', note: 'no game table' },
  { id: 30, name: 'TE_BLASTER2', clTent: 1000, status: 'missing', note: 'Rogue green blaster; no game table' },
  { id: 31, name: 'TE_RAILTRAIL2', clTent: -1, status: 'missing', note: 'Rogue; no case in CL_ParseTEnt switch (Com_Error); no game table' },
  { id: 32, name: 'TE_FLAME', clTent: -1, status: 'missing', note: 'Rogue; no case in CL_ParseTEnt switch (Com_Error); no game table' },
  { id: 33, name: 'TE_LIGHTNING', clTent: 1050, status: 'missing', note: 'no game table' },
  { id: 34, name: 'TE_DEBUGTRAIL', clTent: 1055, status: 'missing', note: 'no game table' },
  { id: 35, name: 'TE_PLAIN_EXPLOSION', clTent: 1061, status: 'missing', note: 'no game table' },
  { id: 36, name: 'TE_FLASHLIGHT', clTent: 1084, status: 'missing', note: 'no game table' },
  { id: 37, name: 'TE_FORCEWALL', clTent: 1090, status: 'missing', note: 'no game table' },
  { id: 38, name: 'TE_HEATBEAM', clTent: 1097, status: 'missing', note: 'Rogue; no game table' },
  { id: 39, name: 'TE_MONSTER_HEATBEAM', clTent: 1101, status: 'missing', note: 'Rogue; no game table' },
  { id: 40, name: 'TE_STEAM', clTent: 1133, status: 'missing', note: 'no game table' },
  { id: 41, name: 'TE_BUBBLETRAIL2', clTent: 1137, status: 'missing', note: 'Rogue; no game table' },
  { id: 42, name: 'TE_MOREBLOOD', clTent: 1146, status: 'missing', note: 'no game table' },
  { id: 43, name: 'TE_HEATBEAM_SPARKS', clTent: 1105, status: 'missing', note: 'Rogue; no game table' },
  { id: 44, name: 'TE_HEATBEAM_STEAM', clTent: 1119, status: 'missing', note: 'Rogue; no game table' },
  { id: 45, name: 'TE_CHAINFIST_SMOKE', clTent: 1152, status: 'missing', note: 'Rogue; no game table' },
  { id: 46, name: 'TE_ELECTRIC_SPARKS', clTent: 1158, status: 'missing', note: 'door-spark candidate (box 3 server lane); no game table yet' },
  { id: 47, name: 'TE_TRACKER_EXPLOSION', clTent: 1167, status: 'missing', note: 'Rogue; no game table' },
  { id: 48, name: 'TE_TELEPORT_EFFECT', clTent: 1175, status: 'missing', note: 'no game table' },
  { id: 49, name: 'TE_DBALL_GOAL', clTent: 1176, status: 'missing', note: 'CTF; no game table' },
  { id: 50, name: 'TE_WIDOWBEAMOUT', clTent: 1181, status: 'missing', note: 'Rogue boss; no game table' },
  { id: 51, name: 'TE_NUKEBLAST', clTent: 1185, status: 'missing', note: 'Rogue; no game table' },
  { id: 52, name: 'TE_WIDOWSPLASH', clTent: 1189, status: 'missing', note: 'Rogue boss; no game table' },
  { id: 53, name: 'TE_EXPLOSION1_BIG', clTent: 881, status: 'shared-branch', note: 'same case block as TE_EXPLOSION1; r_explode2.md2 absent from pak0.pak' },
  { id: 54, name: 'TE_EXPLOSION1_NP', clTent: 884, status: 'shared-branch', note: 'same case block as TE_EXPLOSION1, no particles' },
  { id: 55, name: 'TE_FLECHETTE', clTent: 1001, status: 'missing', note: 'Rogue flechette; no game table' },
];

/** Look up one TE inventory row by numeric id; null when unknown. */
export function tempEntityInfo(id: number): TempEntityInfo | null {
  return TEMP_ENTITY_INVENTORY.find((row) => row.id === id) ?? null;
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
