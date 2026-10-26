// q2ts-web play driver: server-authoritative local play (M7.1+).
//
// Headless-safe (no DOM here; the rAF loop lives in dom.ts). Two modes:
// - devroom: procedural MiniWorld visuals + analytic room collision.
// - pak: real base1.bsp (BSP collision, WAL textures, PCX palette,
//   doors/triggers/movers, static soldier/gunner placeholders you can shoot).
import { Host } from '@q2/host';
import type { ExtraRenderable, HostDriver } from '@q2/host';
import { BUTTON_ATTACK, isDuckHeld } from '@q2/input';
import type { UserCmdT } from '@q2/input';
import type { Snapshot } from '@q2/client';
import {
  drawString,
  fillRect,
  makeConcharsFont,
  setConcharsFont,
  stringWidth,
  loadConcharsFont as loadConcharsPixels,
} from '@q2/client';
import type { ConcharsFont } from '@q2/client';
import {
  SoftwareRenderer,
  createDevroom,
  bspToMiniWorld,
  getDevMesh,
} from '@q2/sw-renderer';
import type { MiniWorld, MiniSurf } from '@q2/sw-renderer';
import { loadBsp, MODEL_EXTRA_STRIDE } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import {
  parseEntities,
  parseFloat,
  spawnEdict,
  makePmoveState,
  pmoveFull,
  PMF_DUCKED,
  setPmoveWorld,
  bspTraceFor,
  setPmoveWorldFromBsp,
  findWeapon,
  fireWeapon,
  mulberry32,
  BOLT_SPEED,
  WEAPON_BLASTER,
  spawnMonster,
  monsterChaseMove,
  monsterLocomotion,
  MONSTER_HULL_MINS,
  MONSTER_HULL_MAXS,
  monsterMoveOf,
  monsterThink,
  monsterPain,
  makePlayerState,
  pickupItem,
  triggerTouch,
  moverUse,
  modelForMonster,
  skinForMonster,
  viewModelForWeapon,
  worldModelForWeapon,
  modelForBolt,
  skinForBolt,
  skinForWeaponModel,
  spawnExplosive,
  soldierWeaponForSkin,
  monsterFlashOffset,
  projectSource,
  MZ2_SOLDIER_SHOTGUN_1,
  MZ2_SOLDIER_BLASTER_1,
  MZ2_SOLDIER_MACHINEGUN_1,
  MZ2_GUNNER_MACHINEGUN_1,
  MZ2_GUNNER_GRENADE_1,
} from '@q2/game';
import type {
  PmoveState,
  UserCmd,
  Edict,
  Mover,
  MonsterState,
  Trigger,
  WeaponDef,
  TraceResult,
  PlayerState,
} from '@q2/game';
import { SV_Init, SV_SetSkill, SV_SpawnEntities, SV_Tick, SV_TouchTriggersAt, fireTargets } from '@q2/server';
import type { ServerState } from '@q2/server';
import { ATTN_NORM, Mixer } from '@q2/sound';
import { parseMD2, parseWAL, parsePCX } from '@q2/formats';
import type { Pcx } from '@q2/formats';
import { resolveFrame } from '@q2/voodoo';
import { AngleVectors, v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import { getCVar, getCVarNumber, getCVarString, registerCVar } from '@q2/config';
import { readPakEntry } from './pak.js';
import type { WebPak } from './pak.js';

export type RendererKind = 'software' | 'voodoo';

// --- display-only brightness (M7.1 feedback) ---
//
// `r_brightness` is a pure presentation lift applied post-resolve in
// `resolveDisplay` (0xAABBGGRR scale + clamp). It never touches lightmaps,
// the palette, the pak, or the renderer internals — the framebuffer the
// engine produced is unchanged. Registered here (apps/web owns the display
// path); `getBrightness` treats an absent cvar (e.g. after `resetCVars()` in
// tests) as the default so headless boots stay deterministic.
export const BRIGHTNESS_DEFAULT = 2.0;
export const BRIGHTNESS_MIN = 0.5;
export const BRIGHTNESS_MAX = 2.0;

registerCVar('r_brightness', BRIGHTNESS_DEFAULT, 'display-only post-resolve brightness lift 0.5..2.0');

/** Clamped `r_brightness` (absent/non-finite cvar → default). Self-healing:
 * re-registers the default when a test `resetCVars()` wiped it, so the panel
 * keeps listing it and headless boots stay deterministic. */
export function getBrightness(): number {
  let raw = getCVar('r_brightness');
  if (raw === undefined) {
    registerCVar('r_brightness', BRIGHTNESS_DEFAULT, 'display-only post-resolve brightness lift 0.5..2.0');
    raw = BRIGHTNESS_DEFAULT;
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) return BRIGHTNESS_DEFAULT;
  return Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, v));
}

/**
 * Scale a 0xAABBGGRR buffer by `brightness` in place (alpha preserved,
 * channels rounded + clamped to 255). `brightness === 1` is a no-op so the
 * 1.0 path stays byte-identical. Zero-alloc; display-only, never pak data.
 */
export function applyBrightness(dst: Uint32Array, brightness: number): void {
  if (brightness === 1) return;
  for (let i = 0; i < dst.length; i++) {
    const px = dst[i]!;
    let r = (px & 255) * brightness;
    let g = ((px >> 8) & 255) * brightness;
    let b = ((px >> 16) & 255) * brightness;
    r = r > 255 ? 255 : Math.round(r);
    g = g > 255 ? 255 : Math.round(g);
    b = b > 255 ? 255 : Math.round(b);
    dst[i] = (px & 0xff000000) | (b << 16) | (g << 8) | r;
  }
}

// --- skill (difficulty; M7.1 menu) ---
//
// id `skill` cvar (game/g_save.c, CVAR_LATCH, default 1 = medium): 0 easy,
// 1 medium, 2 hard, 3 nightmare. The web menu exposes it as a labeled
// dropdown (see SKILL_LABELS in dom.ts); the value persists via setCVar and
// is latched at boot — the menu re-calls the boot path on change
// (rebootPlay), so unlike id's wait-for-next-map latch the new skill
// applies to the current level at once. The driver hands it to
// `SV_SetSkill` before spawning so the server applies the C SpawnEntities
// filter (g_spawn.c): edicts carrying SPAWNFLAG_NOT_EASY (256) are inhibited
// on skill 0, NOT_MEDIUM (512) on skill 1, NOT_HARD (1024) on skill 2/3.
// (Damage scaling stays in @q2/server, outside this package.)
export const SKILL_DEFAULT = 1;
export const SKILL_MIN = 0;
export const SKILL_MAX = 3;

registerCVar('skill', SKILL_DEFAULT, 'difficulty 0 easy 1 medium 2 hard 3 nightmare (latched at boot)');

/** Clamped `skill` (absent/non-finite cvar → default). Self-healing like getBrightness. */
export function getSkill(): number {
  let raw = getCVar('skill');
  if (raw === undefined) {
    registerCVar('skill', SKILL_DEFAULT, 'difficulty 0 easy 1 medium 2 hard 3 nightmare (latched at boot)');
    raw = SKILL_DEFAULT;
  }
  const v = Math.floor(Number(raw));
  if (!Number.isFinite(v)) return SKILL_DEFAULT;
  return Math.min(SKILL_MAX, Math.max(SKILL_MIN, v));
}

/**
 * id SpawnEntities skill test (game/g_spawn.c): does this spawnflags word
 * inhibit the edict at the given (already clamped) skill? Worldspawn is
 * exempt by the caller, mirroring `ent != g_edicts`.
 */
export function skillInhibits(spawnflags: number, skill: number): boolean {
  const f = spawnflags | 0;
  if (skill <= 0) return (f & 256) !== 0; // SPAWNFLAG_NOT_EASY
  if (skill === 1) return (f & 512) !== 0; // SPAWNFLAG_NOT_MEDIUM
  return (f & 1024) !== 0; // SPAWNFLAG_NOT_HARD (skill 2 and 3)
}

/** Parse a lump `spawnflags` key the way spawnEdict does (absent → 0). */
export function parseSpawnflags(dict: Record<string, string>): number {
  const v = parseInt(dict['spawnflags'] ?? '0', 10);
  return Number.isFinite(v) ? v : 0;
}

// --- resolution (M7.1 menu) ---
//
// Internal framebuffer size (`vid_resolution`, latched like skill: changing
// it reboots the level at the new size). The 2D canvas is CSS-upscaled ×2
// from the framebuffer (see startPlayLoop), so this only changes the render
// resolution, never the presentation scale.

/** Internal framebuffer sizes offered in the menu (CSS upscale stays ×2). */
export const RESOLUTION_OPTIONS = ['320x240', '640x480', '800x600', '1024x768'] as const;
/** Default internal resolution (software path, matches the 60fps sign-off rig). */
export const RESOLUTION_DEFAULT = '320x240';

registerCVar('vid_resolution', RESOLUTION_DEFAULT, 'internal framebuffer WxH (latched: changing it reboots the level)');

/** Parse a 'WxH' resolution string; null when malformed or non-positive. */
export function parseResolution(value: string): { width: number; height: number } | null {
  const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/.exec(value);
  if (!m) return null;
  const width = Number.parseInt(m[1]!, 10);
  const height = Number.parseInt(m[2]!, 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/** Current internal resolution (absent/malformed cvar → default). Self-healing. */
export function getResolution(): { width: number; height: number } {
  const raw = getCVar('vid_resolution');
  if (typeof raw === 'string') {
    const parsed = parseResolution(raw);
    if (parsed) return parsed;
  }
  registerCVar('vid_resolution', RESOLUTION_DEFAULT, 'internal framebuffer WxH (latched: changing it reboots the level)');
  return parseResolution(RESOLUTION_DEFAULT)!;
}

// --- crouch (M7.1 UX) ---
//
// The browser binding lives in @q2/input (KeyC → 'crouch' logical key,
// BUTTON_DUCK on the built UserCmdT; attachToCanvas wires it with zero
// web-side code). This package only translates + advertises it: step()
// maps the cmd duck bit onto PMF_DUCKED before pmoveFull (the documented
// input→driver convention), so the hull shrinks (maxs 32 → 4, viewheight
// 22 → 12). Note: the host camera stays at +22 (calcViewOrigin is
// host-owned), so the eye does not dip — collision (fitting under low
// ceilings) is the part that works. HUD/help advertise the binding.

/** One-line controls reference drawn in the HUD and mirrored in index.html. */
export const CONTROLS_HINT = 'move WASD - crouch C - jump Space - use E - attack click - guns 1/2/3';

// --- pickup / scenery world models (M7.1 view) ---
//
// C world-model lumps for base1 pickups (game/g_items.c, verified against
// pak0.pak): items render as their spinning world models (EF_ROTATE), never
// as boxes. Weapon world models come from the game table
// (worldModelForWeapon); item/ammo models live in this table. Skins sit next
// to their model as skin.pcx (all verified present).
const ITEM_WORLD_MODELS: Record<string, string> = {
  item_armor_shard: 'models/items/armor/shard/tris.md2',
  item_armor_jacket: 'models/items/armor/jacket/tris.md2',
  item_armor_combat: 'models/items/armor/combat/tris.md2',
  item_armor_body: 'models/items/armor/body/tris.md2',
  item_health_small: 'models/items/healing/stimpack/tris.md2',
  item_health: 'models/items/healing/medium/tris.md2',
  item_health_large: 'models/items/healing/large/tris.md2',
  item_health_mega: 'models/items/mega_h/tris.md2',
  ammo_shells: 'models/items/ammo/shells/medium/tris.md2',
  ammo_bullets: 'models/items/ammo/bullets/medium/tris.md2',
  ammo_grenades: 'models/items/ammo/grenades/medium/tris.md2',
  ammo_cells: 'models/items/ammo/cells/medium/tris.md2',
  ammo_rockets: 'models/items/ammo/rockets/medium/tris.md2',
  ammo_slugs: 'models/items/ammo/slugs/medium/tris.md2',
  item_quad: 'models/items/quaddama/tris.md2',
  item_invulnerability: 'models/items/invulner/tris.md2',
  item_silencer: 'models/items/silencer/tris.md2',
  item_breather: 'models/items/breather/tris.md2',
  item_enviro: 'models/items/enviro/tris.md2',
  item_adrenaline: 'models/items/adrenal/tris.md2',
  item_band: 'models/items/band/tris.md2',
  item_pack: 'models/items/pack/tris.md2',
};

const WEAPON_WORLD_CLASSES = [
  'weapon_blaster',
  'weapon_shotgun',
  'weapon_supershotgun',
  'weapon_machinegun',
  'weapon_chaingun',
  'weapon_grenadelauncher',
  'weapon_rocketlauncher',
  'weapon_hyperblaster',
  'weapon_railgun',
  'weapon_bfg',
];

/** World-model lump for a pickup classname (weapons via the game table). */
export function worldModelForPickup(classname: string): string | null {
  return worldModelForWeapon(classname) ?? ITEM_WORLD_MODELS[classname] ?? null;
}

/** Skin lump next to an item/weapon world model (sibling skin.pcx). */
export function skinForItemModel(modelPath: string): string {
  const slash = modelPath.lastIndexOf('/');
  const dir = slash >= 0 ? modelPath.slice(0, slash) : '';
  return dir ? `${dir}/skin.pcx` : 'skin.pcx';
}

/** C model lumps for the courtyard dressing (game/g_misc.c, verified vs pak). */
export const SHIP_MODEL = 'models/ships/strogg1/tris.md2';
export const SHIP_SKIN = 'models/ships/strogg1/skin.pcx';
export const BANNER_MODEL = 'models/objects/banner/tris.md2';
export const BANNER_SKIN = 'models/objects/banner/skin.pcx';

const PLAYER_ID = 1;
/** Eye height above the pm origin (matches PmoveState.viewheight). */
const EYE = 22;
/** id pellet spread basis: r/u are world units at 8192 range. */
const PELLET_RANGE = 8192;
const MONSTER_MINS: [number, number, number] = [-16, -16, -24];
const MONSTER_MAXS: [number, number, number] = [16, 16, 32];

const REFIRE: Record<string, number> = {
  weapon_blaster: 0.25,
  weapon_shotgun: 0.9,
  weapon_machinegun: 0.1,
};

// --- devroom analytic collision (floor z=0, walls +-256, center pillar) ---

interface Box {
  mins: [number, number, number];
  maxs: [number, number, number];
}

const DEV_BOXES: Box[] = [
  { mins: [-256, -256, -8], maxs: [256, 256, 0] }, // floor slab
  { mins: [256, -256, 0], maxs: [272, 256, 256] }, // +x wall
  { mins: [-272, -256, 0], maxs: [-256, 256, 256] }, // -x wall
  { mins: [-256, 256, 0], maxs: [256, 272, 256] }, // +y wall
  { mins: [-256, -272, 0], maxs: [256, -256, 256] }, // -y wall
  { mins: [-48, -48, 0], maxs: [48, 48, 192] }, // pillar
];

/** Contact epsilon, mirroring the C engine's DIST_EPSILON (1/32). */
const CONTACT_EPS = 1 / 32;

function sweepBoxVsBoxes(
  start: Vec3,
  mins: Vec3,
  maxs: Vec3,
  end: Vec3,
  boxes: Box[],
): { fraction: number; normal: Vec3; startsolid: boolean; allsolid: boolean } {
  const d = [end[0]! - start[0]!, end[1]! - start[1]!, end[2]! - start[2]!];
  let best = 1;
  let bestAxis = -1;
  let bestSign = 0;
  let startsolid = false;
  // Push-out normal when starting inside geometry (least penetration axis).
  let pushAxis = -1;
  let pushSign = 0;
  let pushDepth = Infinity;
  for (const b of boxes) {
    // Minkowski-expand the obstacle by the player extents.
    const lo = [b.mins[0]! - maxs[0]!, b.mins[1]! - maxs[1]!, b.mins[2]! - maxs[2]!];
    const hi = [b.maxs[0]! - mins[0]!, b.maxs[1]! - mins[1]!, b.maxs[2]! - mins[2]!];
    let tEnter = -Infinity;
    let tExit = Infinity;
    let axis = -1;
    let sign = 0;
    let ok = true;
    // Strict-epsilon containment: resting exactly on a face is contact,
    // not penetration (mirrors the C engine's DIST_EPSILON handling).
    let contained = true;
    for (let k = 0; k < 3; k++) {
      const s = start[k]!;
      const dk = d[k]!;
      if (s <= lo[k]! + CONTACT_EPS || s >= hi[k]! - CONTACT_EPS) contained = false;
      if (dk === 0) {
        if (s < lo[k]! || s > hi[k]!) {
          ok = false;
          break;
        }
        continue;
      }
      let t0 = (lo[k]! - s) / dk;
      let t1 = (hi[k]! - s) / dk;
      if (t0 > t1) {
        const t = t0;
        t0 = t1;
        t1 = t;
      }
      if (t0 > tEnter) {
        tEnter = t0;
        axis = k;
        sign = dk < 0 ? 1 : -1;
      }
      if (t1 < tExit) tExit = t1;
      if (tEnter > tExit) {
        ok = false;
        break;
      }
    }
    if (!ok || tExit < 0 || tEnter > 1) continue;
    if (contained) {
      // Penetration: report startsolid with a least-penetration push normal.
      startsolid = true;
      for (let k = 0; k < 3; k++) {
        const s = start[k]!;
        const penLo = s - lo[k]!;
        const penHi = hi[k]! - s;
        if (penLo < pushDepth) {
          pushDepth = penLo;
          pushAxis = k;
          pushSign = -1;
        }
        if (penHi < pushDepth) {
          pushDepth = penHi;
          pushAxis = k;
          pushSign = 1;
        }
      }
      continue;
    }
    if (tEnter > 0) {
      // Approaching from outside: genuine entry hit.
      if (tEnter < best) {
        best = tEnter;
        bestAxis = axis;
        bestSign = sign;
      }
      continue;
    }
    // Touching contact (entry in the past or right now): find the nearest
    // face by proximity and only hit when moving into it. Sliding along or
    // away from a resting contact must not zero the whole fraction.
    let contactAxis = -1;
    let contactSign = 0;
    let contactDist = Infinity;
    for (let k = 0; k < 3; k++) {
      const s = start[k]!;
      const distLo = s - lo[k]!;
      const distHi = hi[k]! - s;
      if (distLo < contactDist) {
        contactDist = distLo;
        contactAxis = k;
        contactSign = -1;
      }
      if (distHi < contactDist) {
        contactDist = distHi;
        contactAxis = k;
        contactSign = 1;
      }
    }
    if (contactAxis >= 0 && contactDist <= CONTACT_EPS && d[contactAxis]! * contactSign < 0) {
      if (0 < best) {
        best = 0;
        bestAxis = contactAxis;
        bestSign = contactSign;
      }
    }
  }
  const endInside = boxes.some((b) => {
    const lo = [b.mins[0]! - maxs[0]!, b.mins[1]! - maxs[1]!, b.mins[2]! - maxs[2]!];
    const hi = [b.maxs[0]! - mins[0]!, b.maxs[1]! - mins[1]!, b.maxs[2]! - mins[2]!];
    return (
      end[0]! >= lo[0]! && end[0]! <= hi[0]! &&
      end[1]! >= lo[1]! && end[1]! <= hi[1]! &&
      end[2]! >= lo[2]! && end[2]! <= hi[2]!
    );
  });
  const normal = v3();
  if (bestAxis >= 0) {
    normal[bestAxis] = bestSign;
    return { fraction: best, normal, startsolid, allsolid: startsolid && endInside };
  }
  if (startsolid && pushAxis >= 0) normal[pushAxis] = pushSign;
  return { fraction: startsolid ? 0 : best, normal, startsolid, allsolid: startsolid && endInside };
}

function devroomTrace(start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3): TraceResult {
  const r = sweepBoxVsBoxes(start, mins, maxs, end, DEV_BOXES);
  const endpos = v3(
    start[0]! + (end[0]! - start[0]!) * r.fraction,
    start[1]! + (end[1]! - start[1]!) * r.fraction,
    start[2]! + (end[2]! - start[2]!) * r.fraction,
  );
  const hit = r.startsolid || r.fraction < 1;
  return {
    fraction: r.fraction,
    endpos,
    planeNormal: r.normal,
    allsolid: r.allsolid,
    startsolid: r.startsolid,
    // No entity numbers in the analytic room: miss => -1 (airborne).
    entityNum: hit ? 0 : -1,
    contents: 0,
  };
}

// --- driver ---

export interface PlacedMonster {
  id: number;
  origin: [number, number, number];
  state: MonsterState;
  /**
   * id skinnum (m_soldier.c SP_ funcs): 0 = light (blaster), 2 = shotgun,
   * 4 = ss (machinegun); odd = pain flash of the even base. Drives the
   * per-skin mesh skin, fire sound, and weapon (skin-determined per
   * soldierWeaponForSkin, never random). Gunners ignore this (skin 0).
   */
  skin: number;
  /** last server time this monster attacked (id rate-limits to ~1/s). */
  lastAttack: number;
}

/**
 * One queued beam for the renderer's `spawnTracer` pool: origin + direction
 * (need not be normalized — the renderer normalizes) + palette-index color +
 * world-unit length. Queued by the driver in step(), drained by
 * pumpTracers() before the frame renders. Blaster bolts and shotgun pellets
 * both travel this path; impact sparks stay on the mini.particles path.
 */
export interface TracerBeam {
  origin: [number, number, number];
  dir: [number, number, number];
  color: number;
  length: number;
}

/** Full-bright palette index for the blaster bolt beam (matches id's EF_BLASTER look). */
export const BLASTER_TRACER_COLOR = 225;
/**
 * Hitscan tracer color (shotgun/machinegun pellets + monster return fire).
 *
 * Game-lane audit (@q2/game weapons.ts: GREEN 208–214 banned via
 * `isGreenBoltColor` — that range is GREEN on the engine palette, the
 * reported green-laser bug): 225 (0xe1, near-white yellow core in the
 * 0xe0–0xe8 yellow band, same as the blaster beam) is the C-correct
 * hitscan color. Never 208–214.
 */
export const HITSCAN_TRACER_COLOR = 225;
/** Hot yellow pellet streak for shotgun/machinegun + monster return fire. */
export const PELLET_TRACER_COLOR = HITSCAN_TRACER_COLOR;
/**
 * Authentic v_weap anim frames (game/p_weapon.c Weapon_Generic tables):
 * Blaster (4,8,52,55) fires on gunframe 5, idles 9..52; Shotgun
 * (7,18,36,39) fires on 8..9, idles 19..36; Machinegun (3,5,45,49) fires
 * on 4..5, idles 6..45. Frame 0 was the half-raised active pose, never the
 * idle — that is why the gun read as a small hand-held toy.
 * VIEWMODEL_FIRE_FRAME stays as the blaster alias (back-compat for tests).
 */
export const VIEWMODEL_FIRE_FRAME = 5;
export const VIEWMODEL_IDLE_FRAMES: Record<string, number> = {
  weapon_blaster: 9,
  weapon_shotgun: 19,
  weapon_machinegun: 6,
};
export const VIEWMODEL_FIRE_FRAMES: Record<string, number> = {
  weapon_blaster: 5,
  weapon_shotgun: 8,
  weapon_machinegun: 4,
};

/**
 * Weapon_Generic frame bounds per weapon (p_weapon.c Weapon_* calls:
 * Weapon_Generic(ent, ACTIVATE_LAST, FIRE_LAST, IDLE_LAST, DEACTIVATE_LAST)).
 * FIRE_FIRST = ACTIVATE_LAST+1, IDLE_FIRST = FIRE_LAST+1. The driver walks
 * gunframe FIRE_FIRST..IDLE_FIRST+1 while firing, then holds IDLE_FIRST
 * (READY) — viewModel() reports the live gunframe, not a frozen fire frame.
 */
const GUN_BOUNDS: Record<string, { activate: number; fire: number; idle: number; deactivate: number }> = {
  weapon_blaster: { activate: 4, fire: 8, idle: 52, deactivate: 55 },
  weapon_shotgun: { activate: 7, fire: 18, idle: 36, deactivate: 39 },
  weapon_machinegun: { activate: 3, fire: 5, idle: 45, deactivate: 49 },
};

function gunBoundsFor(classname: string): { activate: number; fire: number; idle: number; deactivate: number } {
  return GUN_BOUNDS[classname] ?? { activate: 4, fire: 8, idle: 52, deactivate: 55 };
}

/** Authentic blaster projectile (g_weapon.c fire_blaster): 1000 u/s, 2s life. */
export interface Bolt {
  pos: Vec3;
  dir: Vec3; // normalized
  life: number;
  damage: number;
  /** Units/second (1000 player blaster, 600 soldier monster blaster). */
  speed: number;
  /** True for monster return fire (damages the player, never its owner). */
  foe: boolean;
  /** Server time the bolt was spawned (life expires on server time, not frame dt). */
  born: number;
}

/**
 * Trail/impact spark lifetime in server seconds. id's CL_BlasterParticles
 * fade in a fraction of a second; the old path never expired them (cap-only
 * ring), so every bolt left a permanent spark line. The sweep in step()
 * keeps world-seeded particles (devroom torch flame, born +Infinity) forever.
 */
export const SPARK_TTL = 0.4;

/**
 * Impact-flash dlight window in server seconds. TE_BLASTER / TE_EXPLOSION1
 * are brief flashes (id adds a short yellow light on touch); the old 0.3s
 * drain window lit the whole tile noticeably longer than the authentic
 * impact. The renderer's own light ttl still bounds each add to ~2 renders.
 */
export const EXPLOSION_LIGHT_WINDOW = 0.1;

/** Pak lump for shootable barrels (g_misc.c SP_misc_explobox, origin at the box bottom). */
export const BARREL_MODEL = 'models/objects/barrels/tris.md2';
export const BARREL_SKIN = 'models/objects/barrels/skin.pcx';
/** Authentic explobox hull (g_misc.c: mins -16,-16,0 / maxs 16,16,40). */
export const BARREL_MINS: [number, number, number] = [-16, -16, 0];
export const BARREL_MAXS: [number, number, number] = [16, 16, 40];

/** Shootable explosive (misc_explobox / func_explosive-lite). */
export interface Barrel {
  origin: Vec3;
  health: number;
  dmg: number;
  /** Debris mass class (400 explobox, 75 func_explosive default). */
  mass: number;
  /** Hull size for debris corners (explobox 32,32,40; brush otherwise). */
  size: Vec3;
  /** True for brush func_explosive (mass-formula debris), false for explobox. */
  isFunc: boolean;
  dead: boolean;
}

/** Explosion kind (cl_tent.c): big barrel/func/target blast, grounded blast,
 * or the 4-frame blaster touch flash (ex_misc, smoke model). */
export type ExplosionKind = 'explosion1' | 'explosion2' | 'blaster';

/** Explosion flash (TE_EXPLOSION1/2, TE_BLASTER): particles + dlight + sound.
 * Visual frame steps as baseframe + elapsed/100ms (cl_tent.c CL_AddExplosions):
 * explosion1 15f (base 15 or 0 by rand), explosion2 19f grounded (base 30),
 * blaster 4f ex_misc. yaw is the random facing (rand % 360). */
export interface Explosion {
  pos: Vec3;
  born: number;
  kind: ExplosionKind;
  baseframe: number;
  yaw: number;
}

/** Frames an explosion visual lives (100ms each, cl_tent.c frac stepping). */
export function explosionFrames(kind: ExplosionKind): number {
  return kind === 'blaster' ? 4 : kind === 'explosion2' ? 19 : 15;
}

/** Thrown chunk (g_misc.c ThrowDebris: MOVETYPE_BOUNCE, backoff 1.5). */
export interface Debris {
  origin: Vec3;
  vel: Vec3;
  avel: Vec3;
  born: number;
  life: number;
  kind: 'debris1' | 'debris2' | 'debris3';
  /** Resting on the floor (SV_Physics_Toss floor rule): no further motion. */
  rest: boolean;
}

/** Gib chunk (g_misc.c ThrowGib/ThrowHead: MOVETYPE_TOSS, backoff 1.0,
 * 10-20s life, EF_GIB). No permanent scorch (Q2 has none). */
export interface Gib {
  origin: Vec3;
  vel: Vec3;
  avel: Vec3;
  born: number;
  life: number;
  kind: 'meat' | 'chest' | 'bone' | 'head';
  rest: boolean;
}

/** Pending 0.2s barrel fuse / target_explosion delay (barrel_delay,
 * use_target_explosion), stepped on server time. Barrel fuses carry the
 * debris recipe so the burst matches the exploded kind. */
interface Fuse {
  pos: Vec3;
  dmg: number;
  at: number;
  barrel?: { origin: Vec3; size: Vec3; mass: number; dmg: number; isFunc: boolean };
}

/** id PARTICLE_GRAVITY (client/cl_fx.c): ballistic spark falloff. */
const SPARK_GRAVITY = 40;
/** id sv_gravity default for tossed debris/gibs (g_phys.c SV_AddGravity). */
const TOSS_GRAVITY = 800;

interface DoorSync {
  ent: Edict;
  /**
   * Rest origin the baked verts correspond to: mover pos1 for doors/buttons,
   * the lump origin (usually 0,0,0 for brush models) for func_trains. The
   * rendered offset is always `ent.origin - rest`, matching the C brush-model
   * convention (faces baked at mapper coords, shifted by the entity origin).
   */
  rest: Vec3;
  model: number;
  faces: MiniSurf[];
  baseVerts: Float32Array[];
  baseCenter: Float32Array[];
  baseMins: Float32Array[];
  baseMaxs: Float32Array[];
}

function tryPakEntry(pak: WebPak, name: string): ArrayBuffer | null {
  try {
    return readPakEntry(pak, name);
  } catch {
    return null;
  }
}

export class LocalDriver implements HostDriver {
  readonly source: 'devroom' | 'pak';
  readonly pm: PmoveState = makePmoveState();
  readonly server: ServerState = SV_Init();
  /** Q2 player state: health/armor/ammo/weapons. Pickups go through pickupItem. */
  readonly ps: PlayerState = makePlayerState();
  /** Per-channel positional sound: dom.ts syncs mix() gains to BrowserMixer. */
  readonly mixer = new Mixer();
  readonly mini: MiniWorld;
  readonly map: BspMap | null;
  readonly playerEdict: Edict;
  readonly monsters: PlacedMonster[] = [];
  readonly events: string[] = [];
  readonly changeTargets = new Set<string>();
  message = '';
  exited = false;
  weapon: WeaponDef = WEAPON_BLASTER;
  shells = 0;
  bullets = 0;
  readonly rand = mulberry32(0x51ab);
  private lastShotAt = -10;
  private doors: DoorSync[] = [];
  /** Live submodel face indices the graft appended (unique, for the test hook). */
  private graftedFaces: number[] = [];
  private bspTrace: ((start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => TraceResult) | null = null;
  /** Muzzle flash expiry (server time) + world pos for the dlight/HUD flash. */
  private flashUntil = -10;
  private flashPos: Vec3 = v3();
  /** Muzzle dlight radius for the pending flash (id CL_MuzzleFlash 200+(rand&31)). */
  private flashIntensity = 200;
  /** One-shot pump gate: true only between a shot and its single drain. */
  private flashPending = false;
  /** Queued tracer beams (see TracerBeam): drained by pumpTracers(). */
  private tracerQueue: TracerBeam[] = [];
  /** Flying blaster bolts (authentic fire_blaster projectiles, not hitscan). */
  readonly bolts: Bolt[] = [];
  /** Shootable explosive barrels (misc_explobox) + breakables. */
  readonly barrels: Barrel[] = [];
  /** Thrown debris chunks (barrel/func_explosive, SV_Physics_Toss-lite). */
  readonly debris: Debris[] = [];
  /** Gib chunks (minced monsters, MOVETYPE_TOSS-lite, 10-20s life). */
  readonly gibs: Gib[] = [];
  /** Scripted explosion targets (target_explosion) by targetname. */
  private explosionTargets = new Map<string, { origin: Vec3; dmg: number; delay: number }>();
  /** Pending barrel fuses / target_explosion delays (server-time stepped). */
  private fuses: Fuse[] = [];
  /** Recent explosion flashes (TE_EXPLOSION1/2, TE_BLASTER visuals). */
  readonly explosions: Explosion[] = [];
  /** Enemy muzzle flashes (200+(rand&31) yellow, drained via the dlight pump). */
  private enemyFlashes: Array<{ pos: Vec3; intensity: number }> = [];
  /**
   * Per-particle birth (server time), parallel to `mini.particles`.
   * World-seeded particles (devroom torch flame) start at +Infinity and
   * never expire (`time - Infinity = -Infinity`, never past the ttl);
   * driver-pushed sparks expire per their own ttl below.
   */
  private particleBorn: number[] = [];
  /**
   * Per-particle ballistic velocity (parallel to `mini.particles`; null for
   * static puffs) + individual ttl in seconds (parallel). Big-boom sparks
   * (256-count, CL_ExplosionParticles) fly with PARTICLE_GRAVITY and live
   * 0.625-1.0s (alphavel -0.8/(0.5+rand*0.3)); blaster puffs stay at
   * SPARK_TTL. World-seeded particles have null vel + infinite ttl.
   */
  private particleVel: (Vec3 | null)[] = [];
  private particleTtl: number[] = [];
  /** Weapon_Generic-lite gunframe (p_weapon.c): walks fire→idle while firing. */
  private gunframe = 0;
  private firing = false;
  /**
   * Firing kick (p_weapon.c Blaster_Fire/weapon_shotgun_fire): kickOrigin =
   * -2*fwd, kickAngles [-1,0,0] blaster / [-2,0,0] shotgun. Set on the firing
   * tick, visible via viewKick() for exactly one 10Hz tick, then cleared at
   * the top of the next step (compute-then-clear ordering).
   * TODO(machinegun): per-shot crandom walk + raise (Machinegun_Fire).
   */
  private kickOrigin: Vec3 = v3();
  private kickAngles: Vec3 = v3();
  private kickPending = false;
  /** SV_CalcGunOffset-lite bob clock (p_view.c ClientEndServerFrame). */
  private bobtime = 0;
  private bobcycle = 0;
  private bobfracsin = 0;
  /** Previous-tick view angles for the turn-lag term (oldviewangles). */
  private oldview: Vec3 = v3();
  /** Player death/respawn. */
  private deadUntil = -1;
  private spawnPoints: Array<{ origin: Vec3; yaw: number }> = [];
  /** mover state snapshot for door-move sound edges. */
  private moverStates = new Map<Mover, string>();
  private soundBorn = new Map<number, number>();
  /**
   * Real-pak MD2/skin handles (set by bootPlay after registerPakModels).
   * Null in devroom: viewModel() hides the 3D gun, HUD keeps the 2D icon.
   */
  models: PakModelHandles | null = null;

  constructor(pak: WebPak | null) {
    if (pak && pak.entries.some((e) => e.name === 'maps/base1.bsp')) {
      const built = buildBase1(pak);
      this.source = 'pak';
      this.map = built.map;
      this.mini = built.mini;
      setPmoveWorldFromBsp(built.map);
      this.bspTrace = bspTraceFor(built.map);
      // Skill latch (id CVAR_LATCH, g_spawn.c): the server filters spawns,
      // damage scale, and the roster from st.skill — set it before spawning.
      SV_SetSkill(this.server, getSkill());
      SV_SpawnEntities(this.server, built.map.entities, (model) => modelBounds(built.map, model));
      this.playerEdict = spawnEdict({ classname: 'player' });
      this.spawnFromLump(built.map);
      this.placeMonsters(built.map);
      this.parseExplosives(built.map);
      this.snapshotDoorBases();
      // Brush faces are invisible to the stock traversal (submodel faces sit
      // in no node range or leaf list): graft movers/trains/func_walls into
      // the leaves they intersect so doors render CLOSED at spawn and glass
      // renders at all. Must run after snapshotDoorBases (same faces).
      this.graftBrushModels();
      // id SP_trigger_always: fire at spawn (level-start flybys/relays).
      // Flyby visuals are out of scope; explosion targets fire for real.
      this.fireTriggerAlways(built.map);
      for (const e of this.server.entities) {
        if (e.classname === 'target_changelevel' && e.targetname) this.changeTargets.add(e.targetname);
      }
    } else {
      this.source = 'devroom';
      this.map = null;
      this.mini = createDevroom();
      setPmoveWorld(devroomTrace, () => 0);
      this.playerEdict = spawnEdict({ classname: 'player' });
      this.pm.origin = v3(-168, 0, 32);
      this.pm.velocity = v3();
      this.spawnPoints = [{ origin: v3(-168, 0, 32), yaw: 0 }];
    }
    this.playerEdict.origin = v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]);
    // World-seeded particles predate the driver: they never expire. Prepend
    // (not overwrite): fireTriggerAlways may already have pushed spawn
    // sparks with real births above.
    while (this.particleBorn.length < this.mini.particles.length) this.particleBorn.unshift(Infinity);
    while (this.particleVel.length < this.mini.particles.length) this.particleVel.unshift(null);
    while (this.particleTtl.length < this.mini.particles.length) this.particleTtl.unshift(Infinity);
    this.oldview = v3(this.pm.viewAngles[0], this.pm.viewAngles[1], this.pm.viewAngles[2]);
    this.gunframe = gunBoundsFor(this.weapon.classname).fire + 1;
    this.syncAmmo();
    this.updateMixerListener();
  }

  spawn(): { origin: [number, number, number]; angles?: [number, number, number] } {
    return {
      origin: [this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]!],
      angles: [this.pm.viewAngles[0]!, this.pm.viewAngles[1]!, this.pm.viewAngles[2]!],
    };
  }

  step(cmd: UserCmdT, dt: number): void {
    // Firing kick from the previous tick expires here: the host consumed it
    // via viewKick() during the last tick (compute-then-clear ordering), so
    // a kick is visible for exactly one 10Hz tick.
    this.kickPending = false;
    // Previous tick's final angles (id oldviewangles): copied BEFORE this
    // tick's cmd overwrites pm.viewAngles, so gunAnglesDelta() reads the
    // real per-tick turn delta after the step (C computes gun angles before
    // the end-of-frame copy in ClientEndServerFrame).
    this.oldview = v3(this.pm.viewAngles[0], this.pm.viewAngles[1], this.pm.viewAngles[2]);
    const msec = Math.max(1, Math.round(dt * 1000));
    const gcmd: UserCmd = {
      msec,
      angles: new Float32Array(cmd.angles) as Vec3,
      forwardmove: cmd.forwardmove,
      sidemove: cmd.sidemove,
      upmove: cmd.upmove,
      buttons: cmd.buttons,
    };
    // Dead players keep no momentum and can't move until respawn.
    if (this.ps.health <= 0 && this.deadUntil > 0 && this.server.time < this.deadUntil) {
      this.pm.velocity = v3();
    } else {
      this.pm.viewAngles = new Float32Array(cmd.angles) as Vec3;
      // Duck translation (@q2/input convention): the KeyC 'crouch' key sets
      // BUTTON_DUCK on the built cmd (Host → driver untouched); the driver
      // owns PMF_DUCKED until @q2/game wires it into PM_CheckDuck.
      if (isDuckHeld(gcmd)) this.pm.pmFlags |= PMF_DUCKED;
      else this.pm.pmFlags &= ~PMF_DUCKED;
      pmoveFull(this.pm, gcmd);
    }
    this.playerEdict.origin = v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]);
    for (const m of this.server.movers) this.moverStates.set(m, m.state);
    SV_Tick(this.server, dt);
    SV_TouchTriggersAt(this.server, 'player', this.playerEdict);
    this.syncDoors();
    this.updateBob();
    this.stepGunframe();
    for (const m of this.monsters) {
      if (m.state.dead) {
        if (m.state.gibbed) continue;
        // Corpses persist: keep advancing the death move to its last frame
        // (monsterThink holds it there) so the snapshot keeps rendering the
        // fallen body instead of freezing on frame 0.
        monsterThink(m.state);
        continue;
      }
      // Steering (id walkmonster_start/run logic): chase the player along a
      // trivial 2-node graph (self -> player) with line-of-sight, so idle
      // stand flips to run/attack and locomotion has a nonzero dist to play.
      // Uses the tested monsterChaseMove selector; pathfinding on the real
      // node graph arrives with M5.3 full AI.
      const eyeForSee = v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]! + EYE);
      const chestSee = v3(m.origin[0]!, m.origin[1]!, m.origin[2]! + 8);
      const seen = this.traceShot(chestSee, eyeForSee).fraction >= 1;
      try {
        monsterChaseMove(
          m.state,
          v3(m.origin[0], m.origin[1], m.origin[2]),
          v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]),
          {
            graph: new Map([[0, [1]], [1, [0]]]),
            positions: new Map([[0, v3(m.origin[0], m.origin[1], m.origin[2])], [1, v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2])]]),
          },
          seen,
          this.rand,
        );
      } catch {
        // Unknown move names from older saves stay put; locomotion still runs.
      }
      // Locomotion BEFORE think (id ai_move runs inside the frame): yaw
      // toward the player, advance by the current frame's dist,
      // collision-clamped + gravity-settled by the helper. `think` then
      // steps the frame counter.
      const body = v3(m.origin[0], m.origin[1], m.origin[2]);
      monsterLocomotion(m.state, body, this.pm.origin, (start, end) =>
        this.bspTrace
          ? this.bspTrace(start, MONSTER_HULL_MINS, MONSTER_HULL_MAXS, end)
          : devroomTrace(start, MONSTER_HULL_MINS, MONSTER_HULL_MAXS, end),
      );
      m.origin[0] = body[0]!;
      m.origin[1] = body[1]!;
      m.origin[2] = body[2]!;
      // Fire gating (m_soldier.c/m_gunner.c fire-tagged frames): return-fire
      // damage resolves when the move plays its 'fire' frame (the muzzle
      // flash), never on a wall-clock timer. The old ~1/s timer drift is
      // gone; attack anims set their own cadence.
      const playedIdx = m.state.frame;
      const action = monsterThink(m.state);
      if (action === 'fire' && !m.state.dead && !m.state.gibbed) this.monsterFire(m, playedIdx);
    }
    this.checkDoorTouch();
    this.checkBrushTriggers();
    this.emitDoorSounds();
    // Exit scan runs after every firing path (point + brush triggers):
    // each pushes the relay targetname into firedThisTick.
    for (const t of this.server.firedThisTick) {
      if (this.changeTargets.has(t) && !this.exited) {
        this.exited = true;
        this.message = 'LEVEL COMPLETE — base2 is not shipped yet. Thanks for playing!';
        this.events.push('exit');
      }
    }
    this.checkScriptedExplosions();
    this.stepFuses();
    this.stepSparks(dt);
    this.stepTossed(dt);
    this.stepBolts(dt);
    this.checkPickups();
    this.handleAttack(cmd);
    this.expireSounds();
    this.updateMixerListener();
    if (this.ps.health <= 0 && this.deadUntil > 0 && this.server.time >= this.deadUntil) {
      this.respawn();
    }
  }

  snapshot(serverTime: number): Snapshot {
    const entities: Snapshot['entities'] = [
      {
        id: PLAYER_ID,
        origin: [this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]!],
        velocity: [this.pm.velocity[0]!, this.pm.velocity[1]!, this.pm.velocity[2]!],
      },
    ];
    for (const m of this.monsters) {
      if (m.state.gibbed) continue;
      // Corpses persist in the snapshot (id keeps the dead edict rendering
      // its last death frame); the host draws them via entityFrame, which
      // clamps to the held final frame of the death move.
      entities.push({
        id: m.id,
        origin: [m.origin[0]!, m.origin[1]!, m.origin[2]!],
        velocity: [0, 0, 0],
      });
    }
    return { serverTime, entities };
  }

  /**
   * Extra world entities the snapshot omits (HostDriver pairing: the Host
   * appends these to its renderables with explicit model/skin/angles, so
   * bolts/barrels/blasts render as their own MD2s the moment a pak is present
   * — no host change needed, the hook already landed there). Null when
   * there is nothing live (devroom at rest). Bolt flight orientation rides
   * along as yaw/pitch (id convention pitch positive = down). Explosion
   * frames step as baseframe + elapsed/100ms (cl_tent.c CL_AddExplosions).
   * Debris/gib/explosion extras need real pak models, so they are emitted
   * only when models are registered (devroom keeps the legacy rendering).
   */
  extraEntities(): ExtraRenderable[] | null {
    const out: ExtraRenderable[] = [];
    for (const b of this.barrels) {
      if (b.dead) continue;
      out.push({
        origin: [b.origin[0]!, b.origin[1]!, b.origin[2]!],
        angles: [0, 0, 0],
        model: this.models?.barrel ?? 0,
        skin: this.models?.barrelSkin ?? 0,
        frame: 0,
      });
    }
    for (const bolt of this.bolts) {
      const yaw = (Math.atan2(bolt.dir[1]!, bolt.dir[0]!) * 180) / Math.PI;
      const z = Math.max(-1, Math.min(1, bolt.dir[2]!));
      const pitch = -(Math.asin(z) * 180) / Math.PI;
      out.push({
        origin: [bolt.pos[0]!, bolt.pos[1]!, bolt.pos[2]!],
        angles: [pitch, yaw, 0],
        model: this.models?.bolt ?? 0,
        skin: this.models?.boltSkin ?? 0,
        frame: 0,
      });
    }
    if (this.models) {
      for (const e of this.explosions) {
        const age = this.server.time - e.born;
        const frames = explosionFrames(e.kind);
        if (age < 0 || age >= frames * 0.1) continue;
        const f = Math.floor(age / 0.1);
        // TE_EXPLOSION1/2 render the r_explode MD2 (cl_mod_explo4, 15f/19f);
        // TE_BLASTER's 4f ex_misc renders the explode MD2 (cl_mod_explode).
        const isBlast = e.kind === 'blaster';
        out.push({
          origin: [e.pos[0]!, e.pos[1]!, e.pos[2]!],
          angles: [0, e.yaw, 0],
          model: isBlast ? this.models.blast : this.models.explode,
          skin: isBlast ? this.models.blastSkin : this.models.explodeSkin,
          frame: e.baseframe + f,
        });
      }
      for (const d of this.debris) {
        const model = d.kind === 'debris1' ? this.models.debris1 : d.kind === 'debris2' ? this.models.debris2 : this.models.debris3;
        const skin = d.kind === 'debris1' ? this.models.debris1Skin : d.kind === 'debris2' ? this.models.debris2Skin : this.models.debris3Skin;
        out.push({
          origin: [d.origin[0]!, d.origin[1]!, d.origin[2]!],
          angles: [0, 0, 0],
          model,
          skin,
          frame: 0,
        });
      }
      for (const g of this.gibs) {
        const model = g.kind === 'meat' ? this.models.gibMeat : g.kind === 'chest' ? this.models.gibChest : g.kind === 'bone' ? this.models.gibBone : this.models.gibHead;
        const skin = g.kind === 'meat' ? this.models.gibMeatSkin : g.kind === 'chest' ? this.models.gibChestSkin : g.kind === 'bone' ? this.models.gibBoneSkin : this.models.gibHeadSkin;
        out.push({
          origin: [g.origin[0]!, g.origin[1]!, g.origin[2]!],
          angles: [0, 0, 0],
          model,
          skin,
          frame: 0,
        });
      }
      // Pickups: live (unpicked, skill-kept) item/weapon/ammo edicts render
      // as their C world models with the EF_ROTATE spin; picked-up (freed)
      // or skill-inhibited ones stay hidden, exactly matching the pickup
      // logic in checkPickups. This is what makes the low-hole armor
      // shards visible: entity submits have no PVS/frustum cull in the
      // renderer (z-test only), so a shard at z=-216 renders like any other.
      for (const e of this.server.entities) {
        if (e.freed) continue;
        const h = this.models.items[e.classname];
        if (!h) continue;
        out.push({
          origin: [e.origin[0]!, e.origin[1]!, e.origin[2]!],
          angles: [0, (this.server.time * 90) % 360, 0],
          model: h.model,
          skin: h.skin,
          frame: 0,
        });
      }
      // Banners wave through MD2 frames 0..15 at 10Hz (misc_banner_think);
      // the C start frame is random, ours walks from 0 (deterministic).
      // Read from the server roster (plain edicts) so skill filtering applies.
      if (this.models.banner >= 0) {
        const bf = Math.floor(this.server.time / 0.1) % 16;
        for (const e of this.server.entities) {
          if (e.freed || e.classname !== 'misc_banner') continue;
          out.push({
            origin: [e.origin[0]!, e.origin[1]!, e.origin[2]!],
            angles: [0, parseFloat(e.extra['angle'] ?? '0', 0), 0],
            model: this.models.banner,
            skin: this.models.bannerSkin,
            frame: bf,
          });
        }
      }
      // Ships ride the server trains (func_train_find + train_next): the
      // position is authoritative and moves every tick, so a parked lump
      // origin would desync within a second. `started` is the SVF_NOCLIENT
      // gate (trigger_spawned until a use — trigger_always at boot for all
      // three base1 flybys); unstarted trains stay hidden like in C.
      if (this.models.ship >= 0) {
        for (const tr of this.server.trains) {
          if (!tr.ship || !tr.started) continue;
          out.push({
            origin: [tr.ent.origin[0]!, tr.ent.origin[1]!, tr.ent.origin[2]!],
            angles: [0, parseFloat(tr.ent.extra['angle'] ?? '0', 0), 0],
            model: this.models.ship,
            skin: this.models.shipSkin,
            frame: 0,
          });
        }
      }
    }
    return out.length > 0 ? out : null;
  }

  /** Test hook: live pickup extras (unpicked, skill-kept item/weapon/ammo). */
  livePickupCount(): number {
    if (!this.models) return 0;
    let n = 0;
    for (const e of this.server.entities) {
      if (!e.freed && this.models.items[e.classname]) n++;
    }
    return n;
  }

  /** Test hook: started ship trains (trigger_spawned visibility gate). */
  startedShips(): number {
    let n = 0;
    for (const tr of this.server.trains) {
      if (tr.ship && tr.started) n++;
    }
    return n;
  }

  selectWeapon(classname: string): void {
    if (!this.ps.weapons.includes(classname)) {
      this.message = 'NO WEAPON';
      this.events.push('empty');
      return;
    }
    const def = findWeapon(classname);
    if (def) {
      this.weapon = def;
      // Fresh weapon raises at the idle pose (Weapon_Generic READY state).
      this.firing = false;
      this.gunframe = gunBoundsFor(classname).fire + 1;
      this.events.push('weapon');
    }
  }

  hasWeapon(classname: string): boolean {
    return this.ps.weapons.includes(classname);
  }

  get aliveMonsters(): number {
    return this.monsters.filter((m) => !m.state.dead).length;
  }

  get playerHealth(): number {
    return this.ps.health;
  }

  get playerDead(): boolean {
    return this.ps.health <= 0;
  }

  /** Muzzle flash lit while server time is inside the post-shot window. */
  muzzleLit(): boolean {
    return this.server.time < this.flashUntil;
  }

  /** Current Weapon_Generic-lite gunframe (test hook; viewModel() is the
   * render path and needs registered pak models, this exposes the raw walk). */
  get gunFrame(): number {
    return this.gunframe;
  }

  /**
   * First-person 3D weapon view model (HostDriver contract): the registered
   * `v_weap` MD2 handle + its PCX skin for the selected weapon. Reports the
   * live Weapon_Generic-lite gunframe (fire frame on the firing tick, then
   * +1 per server tick until idle-first holds READY) — never a frozen fire
   * frame. Null without a pak — the caller falls back to the 2D silhouette.
   * The 0.09s muzzleLit window is dlight/HUD-only (flash + 2D icon glow).
   */
  viewModel(): { model: number; skin: number; frame: number } | null {
    const model = this.models?.weapons[this.weapon.classname];
    const skin = this.models?.weaponSkins[this.weapon.classname];
    if (model === undefined || skin === undefined) return null;
    return { model, skin, frame: this.gunframe };
  }

  /**
   * Firing view kick (HostDriver pairing, exact shape): p_weapon.c sets
   * kickOrigin = -2*fwd and kickAngles = [-1,0,0] (blaster) / [-2,0,0]
   * (shotgun); SV_CalcViewOffset adds kick_angles to the view. Non-null for
   * exactly the one 10Hz tick that fired, then null (cleared at the top of
   * the next step). The host adds `angles` to its view and `origin` to the
   * view offset; gunAnglesDelta (sway) stays separate.
   */
  viewKick(): { angles: [number, number, number]; origin: [number, number, number] } | null {
    if (!this.kickPending) return null;
    return {
      angles: [this.kickAngles[0]!, this.kickAngles[1]!, this.kickAngles[2]!],
      origin: [this.kickOrigin[0]!, this.kickOrigin[1]!, this.kickOrigin[2]!],
    };
  }

  /**
   * Gun sway (HostDriver pairing, exact shape): SV_CalcGunOffset-lite
   * (p_view.c). Turn lag 0.2*deltaAngle per axis (deltas wrapped to ±180,
   * clamped to ±45, yaw delta also rolls 0.1×) plus speed-scaled bob sway
   * (xyspeed*bobfracsin*0.005 pitch / 0.01 yaw / 0.005 roll, yaw+roll sign
   * flipped on odd bobcycle). Static when still (xyspeed < 5 → zeros);
   * gunoffset stays 0 (gun_x/y/z are 0 dev tools in SP).
   */
  gunAnglesDelta(): [number, number, number] | null {
    const vx = this.pm.velocity[0]!;
    const vy = this.pm.velocity[1]!;
    const xyspeed = Math.hypot(vx, vy);
    if (xyspeed < 5) return [0, 0, 0];
    let pitch = xyspeed * this.bobfracsin * 0.005;
    let yaw = xyspeed * this.bobfracsin * 0.01;
    let roll = xyspeed * this.bobfracsin * 0.005;
    if (this.bobcycle & 1) {
      yaw = -yaw;
      roll = -roll;
    }
    const cur = this.pm.viewAngles;
    const deltas = [this.oldview[0]! - cur[0]!, this.oldview[1]! - cur[1]!, this.oldview[2]! - cur[2]!];
    const out = [pitch, yaw, roll];
    for (let i = 0; i < 3; i++) {
      let delta = deltas[i]!;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      if (delta > 45) delta = 45;
      if (delta < -45) delta = -45;
      if (i === 1) out[2] = out[2]! + 0.1 * delta;
      out[i] = out[i]! + 0.2 * delta;
    }
    return [out[0]!, out[1]!, out[2]!];
  }

  /**
   * Bob clock (p_view.c ClientEndServerFrame): xyspeed from the planar
   * velocity; below 5 the cycle restarts, otherwise grounded motion steps
   * 0.25/0.125/0.0625 by speed band. Ducked ×4 omitted (no crouch anim
   * state here). Runs once per server tick, before gunAnglesDelta reads it.
   */
  private updateBob(): void {
    const xyspeed = Math.hypot(this.pm.velocity[0]!, this.pm.velocity[1]!);
    if (xyspeed < 5) {
      this.bobtime = 0;
    } else if (this.pm.onGround) {
      this.bobtime += xyspeed > 210 ? 0.25 : xyspeed > 100 ? 0.125 : 0.0625;
    }
    this.bobcycle = Math.trunc(this.bobtime);
    this.bobfracsin = Math.abs(Math.sin(this.bobtime * Math.PI));
  }

  /** Advance the Weapon_Generic-lite gunframe one step per server tick. */
  private stepGunframe(): void {
    if (!this.firing) return;
    const b = gunBoundsFor(this.weapon.classname);
    this.gunframe++;
    if (this.gunframe >= b.fire + 2) {
      // Reached IDLE_FIRST+1 (blaster 10): READY, hold the idle-first frame.
      this.firing = false;
      this.gunframe = b.fire + 1;
    }
  }

  /**
   * MD2 frame for a snapshot entity (HostDriver contract): the move table's
   * `first` frame number (already matching the MD2 frame names) plus the
   * state's frame offset. Unknown ids map to 0; the renderer wraps.
   */
  entityFrame(id: number): number {
    const m = this.monsters.find((m) => m.id === id);
    if (!m) return 0;
    try {
      const mv = monsterMoveOf(m.state);
      const idx = Math.min(m.state.frame, Math.max(0, mv.frames.length - 1));
      return mv.first + Math.max(0, idx);
    } catch {
      return 0;
    }
  }

  /**
   * Registered model/skin for a snapshot entity (HostDriver pairing:
   * same optional-method shape as entityFrame). Soldier and gunner resolve
   * to their own MD2 + PCX handles (registration order pins soldier skin 0
   * / mesh 0); unknown ids return null for the Host default. Null without
   * a pak — devroom keeps the legacy model-0 rendering.
   *
   * Soldiers are per-skin (m_soldier.c skinnum): light (0) renders the
   * skin_lt guard look, plain (2) the default skin, ss (4+) the skin_ss
   * machinegun look — same mesh, distinct skin handle, so machinegun
   * soldiers read differently from shotgun/light at a glance.
   */
  entityModel(id: number): { model: number; skin: number } | null {
    const m = this.monsters.find((m) => m.id === id);
    if (!m || !this.models) return null;
    if (m.state.kind === 'gunner') return { model: this.models.gunner, skin: this.models.gunnerSkin };
    return { model: this.models.monster, skin: this.soldierSkinFor(m.skin) };
  }

  /**
   * Skin handle for a soldier skinnum (even base 0/2/4+; odd pain skins fall
   * back to their even base — the pain flash is a code path, not a handle,
   * in this driver). Unknown models (no pak) → 0 for the Host default.
   */
  soldierSkinFor(skin: number): number {
    if (!this.models) return 0;
    const base = skin & ~1;
    if (base <= 0) return this.models.soldierLightSkin;
    if (base >= 4) return this.models.soldierSsSkin;
    return this.models.monsterSkin;
  }

  /**
   * World orientation for a snapshot entity (HostDriver pairing). Monsters
   * report the locomotion-maintained yaw (id M_ChangeYaw, shortest-arc
   * clamped per tick) so the host renders them facing the player instead of
   * the legacy yaw-0 snap. Bolt flight orientation rides on the extras
   * themselves (see extraEntities). Headless-safe pure math. Unknown ids
   * return null for the Host default.
   * TODO(interp): LerpAngle between snapshots (client/cl_ents.c) + frame
   * vertex lerp via oldframe/backlerp (RF_FRAMELERP) keyed off
   * serverAcc/SERVER_DT. Needs an Entity contract change (frozen BRAIN.md
   * §6), so yaw/frames still step at 10Hz for now.
   */
  entityAngles(id: number): [number, number, number] | null {
    const m = this.monsters.find((m) => m.id === id);
    if (!m) return null;
    return [0, ((m.state.yaw % 360) + 360) % 360, 0];
  }

  /** Drain the one-shot muzzle-flash dlight request (dom tick pumps it). */
  drainFlash(): Vec3 | null {
    if (!this.flashPending) return null;
    if (!this.muzzleLit()) {
      // Window expired before the pump ran: drop the request so a stale
      // pos can never brighten a later frame.
      this.flashPending = false;
      return null;
    }
    this.flashPending = false;
    return this.flashPos;
  }

  /**
   * Pending muzzle-flash radius (id CL_MuzzleFlash 200+(rand&31), rolled at
   * fire time so the stream stays caller-seeded deterministic). Read after
   * drainFlash() by the dlight pump; 200 before the first shot.
   */
  peekFlashIntensity(): number {
    return this.flashIntensity;
  }

  /**
   * Queue a beam from `origin` along `dir` (unnormalized ok) with palette
   * `color`, `length` world units. Called for every fired pellet/bolt and
   * every monster ranged shot; pumpTracers() moves them into the renderer's
   * spawnTracer pool before the frame renders. Zero-alloc per call aside
   * from the queue entry itself (capped below).
   */
  queueTracer(origin: Vec3, dir: Vec3, color: number, length: number): void {
    if (this.tracerQueue.length >= 64) this.tracerQueue.shift();
    this.tracerQueue.push({
      origin: [origin[0]!, origin[1]!, origin[2]!],
      dir: [dir[0]!, dir[1]!, dir[2]!],
      color: color & 255,
      length,
    });
  }

  /** Live queued beams (observability, test hook). */
  get pendingTracers(): number {
    return this.tracerQueue.length;
  }

  /** Drain the queued beams (pumpTracers moves them to the renderer). */
  drainTracers(): TracerBeam[] {
    if (this.tracerQueue.length === 0) return [];
    const out = this.tracerQueue;
    this.tracerQueue = [];
    return out;
  }

  hudAmmo(): string {
    if (!this.weapon.ammoKind) return '∞';
    return String(this.weapon.ammoKind === 'shells' ? this.shells : this.bullets);
  }

  /** Compat sync: legacy shells/bullets ints mirror PlayerState ammo. */
  private syncAmmo(): void {
    this.shells = this.ps.ammo['shells'] ?? 0;
    this.bullets = this.ps.ammo['bullets'] ?? 0;
  }

  private emitSound(name: string, origin: Vec3, attn = ATTN_NORM, masterVol = 1): number {
    const id = this.mixer.startSound({
      origin: [origin[0]!, origin[1]!, origin[2]!],
      fixedOrigin: false,
      entnum: PLAYER_ID,
      attenuation: attn,
      masterVol,
      loop: false,
      name,
    });
    this.soundBorn.set(id, this.server.time);
    return id;
  }

  /** Drop one-shot channels ~1s after they fire (mix() would hold them). */
  private expireSounds(): void {
    for (const [id, born] of this.soundBorn) {
      if (this.server.time - born > 1.0) {
        this.mixer.stopSound(id);
        this.soundBorn.delete(id);
      }
    }
  }

  private updateMixerListener(): void {
    const fwd = v3();
    const right = v3();
    const up = v3();
    AngleVectors(this.pm.viewAngles, fwd, right, up);
    const eye = v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]! + EYE);
    this.mixer.setListener(eye, right);
  }

  private emitDoorSounds(): void {
    for (const m of this.server.movers) {
      const prev = this.moverStates.get(m);
      if (prev !== undefined && prev !== m.state && (m.state === 'going_up' || m.state === 'going_down')) {
        this.emitSound(
          m.ent.classname === 'func_button' ? 'buttons/button.wav' : 'doors/door.wav',
          m.ent.origin,
        );
        this.events.push('door');
      }
    }
  }

  private playerBox(): { mins: Vec3; maxs: Vec3 } {
    return { mins: v3(-16, -16, -24), maxs: v3(16, 16, 32) };
  }

  /**
   * Door touch (Touch_DoorTrigger, id g_func.c): walking into a door's
   * expanded volume uses it. The web driver can't rely on the C brush-touch
   * path, so the 60-unit expanded AABB check from the WIRE bot is the play
   * path here too — this is what actually opens doors in the browser.
   */
  private checkDoorTouch(): void {
    if (!this.map || this.playerDead) return;
    const { mins, maxs } = this.playerBox();
    for (const m of this.server.movers) {
      if (m.ent.classname !== 'func_door') continue;
      const b = modelBounds(this.map, m.ent.model);
      if (!b) continue;
      const ox = m.ent.origin[0]! - m.pos1[0]!;
      const oy = m.ent.origin[1]! - m.pos1[1]!;
      const oz = m.ent.origin[2]! - m.pos1[2]!;
      const tmins = new Float32Array([b.mins[0]! + ox - 60, b.mins[1]! + oy - 60, b.mins[2]! + oz]);
      const tmaxs = new Float32Array([b.maxs[0]! + ox + 60, b.maxs[1]! + oy + 60, b.maxs[2]! + oz]);
      if (!boxOverlap(this.pm.origin, mins, maxs, tmins, tmaxs)) continue;
      if (m.state === 'bottom' || m.state === 'waiting') {
        moverUse(m, this.server.time);
      }
    }
  }

  /**
   * Brush trigger volumes (trigger_once/multiple on model *N): real AABB
   * overlap — the point-proximity hook in SV_TouchTriggersAt can't see brush
   * models (their edict origin is 0,0,0). This is the exit path: the *27 pit
   * volume fires t37 -> target_changelevel when the player body arrives.
   */
  private checkBrushTriggers(): void {
    if (!this.map || this.playerDead) return;
    const { mins, maxs } = this.playerBox();
    for (const t of this.server.triggers) {
      const n = brushModelNum(t.ent.model);
      if (n === null) continue;
      const b = modelBounds(this.map, t.ent.model);
      if (!b) continue;
      if (!boxOverlap(this.pm.origin, mins, maxs, b.mins, b.maxs)) continue;
      const pseudo: Edict = { ...t.ent };
      triggerTouch(t, this.server.time, 'player', () => fireTargets(this.server, pseudo));
    }
  }

  /**
   * Return fire gated on the move's fire-tagged frame (m_soldier.c
   * soldier_fire / m_gunner.c GunnerFire+GunnerGrenade): the step loop calls
   * this only when monsterThink returns 'fire', so shots land on the muzzle
   * flash. `playedIdx` is the move-frame index that just played (grenades
   * only leave the tube on the C frames 105/108/111/114 → idx 4/7/10/13).
   *
   * The soldier weapon is skin-determined (m_soldier.c soldier_fire via
   * soldierWeaponForSkin, never random): blaster skins (0) spawn a real foe
   * Bolt (600 u/s, reused stepBolts/blasterImpact path), shotgun skins (2)
   * draw one yellow tracer muzzle→eye and roll id's pHit, machinegun skins
   * (4+) burst three fanned yellow tracers (id monster_fire_bullet × the
   * HOLD_FRAME repeat). Every shot adds an enemy muzzle dlight
   * (200+(rand&31) yellow) and impact sparks at the eye on hit.
   * TODO(melee-sound): 'monster/melee.wav' is a placeholder (no in-pak
   * match); TODO(grenade-sound): C plays no explicit fire sound here,
   * 'gunner/gunatck3.wav' is the closest in-pak family match.
   */
  private monsterFire(m: PlacedMonster, playedIdx: number): void {
    if (this.playerDead) return;
    const eye = v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]! + EYE);
    const dx = eye[0]! - m.origin[0]!;
    const dy = eye[1]! - m.origin[1]!;
    const dz = eye[2]! - m.origin[2]!;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > 1000) return;
    const chest = v3(m.origin[0]!, m.origin[1]!, m.origin[2]! + 32);
    if (this.traceShot(chest, eye).fraction < 1) return;
    // Skin-determined soldier weapon (m_soldier.c soldier_fire): blaster /
    // shotgun / machinegun by skinnum. Gunners keep their move-based table.
    const skinWeapon = m.state.kind === 'soldier' ? soldierWeaponForSkin(m.skin) : null;
    // Muzzle via G_ProjectSource (soldier_fire/GunnerFire): monster origin +
    // fwd*offset + right*offset from the m_flash table, yaw-facing.
    const fwd = v3();
    const right = v3();
    AngleVectors(v3(0, m.state.yaw, 0), fwd, right, v3());
    const move = m.state.move;
    let flashId = MZ2_SOLDIER_SHOTGUN_1;
    if (m.state.kind === 'soldier') {
      if (skinWeapon === 'blaster') flashId = MZ2_SOLDIER_BLASTER_1;
      else if (skinWeapon === 'machinegun') flashId = MZ2_SOLDIER_MACHINEGUN_1 + (playedIdx % 2);
      else flashId = MZ2_SOLDIER_SHOTGUN_1;
    } else if (move === 'attack_grenade') flashId = MZ2_GUNNER_GRENADE_1 + (playedIdx % 4);
    else if (m.state.kind === 'gunner') flashId = MZ2_GUNNER_MACHINEGUN_1 + (playedIdx % 8);
    const muzzle = projectSource(
      v3(m.origin[0]!, m.origin[1]!, m.origin[2]!),
      monsterFlashOffset(flashId),
      fwd,
      right,
    );
    this.enemyFlashes.push({ pos: muzzle, intensity: 200 + ((this.rand() * 32) | 0) });
    const dirToEye = v3(eye[0]! - muzzle[0]!, eye[1]! - muzzle[1]!, eye[2]! - muzzle[2]!);
    const dirLen = Math.hypot(dirToEye[0]!, dirToEye[1]!, dirToEye[2]!) || 1;
    // Soldier blaster skin: a real projectile, not a damage roll.
    if (skinWeapon === 'blaster') {
      this.bolts.push({
        pos: muzzle,
        dir: v3(dirToEye[0]! / dirLen, dirToEye[1]! / dirLen, dirToEye[2]! / dirLen),
        life: 2,
        damage: 5,
        speed: 600,
        foe: true,
        born: this.server.time,
      });
      this.emitSound('soldier/solatck2.wav', v3(m.origin[0]!, m.origin[1]!, m.origin[2]! + 32));
      this.events.push('monshot');
      return;
    }
    // Grenade leaves the tube only on its C frames.
    if (move === 'attack_grenade' && playedIdx !== 4 && playedIdx !== 7 && playedIdx !== 10 && playedIdx !== 13) {
      this.enemyFlashes.pop();
      return;
    }
    // Melee commits at close range through the attack move (attack1 for the
    // soldier, attack_chain for the gunner).
    if (dist < 96 && (move === 'attack1' || move === 'attack_chain')) {
      this.damagePlayer(m.state.kind === 'gunner' ? 15 : 10, m.origin);
      this.emitSound('monster/melee.wav', v3(m.origin[0]!, m.origin[1]!, m.origin[2]!));
      this.events.push('monshot');
      return;
    }
    const pHit = dist < 500 ? 0.6 : 0.25;
    // Soldier machinegun skin: 3-round burst (id monster_fire_bullet dmg 2
    // × the HOLD_FRAME repeat), fanned ±40u at 8192 like the pellet spread
    // basis; each round rolls pHit independently and draws its own tracer.
    if (skinWeapon === 'machinegun') {
      for (let b = -1; b <= 1; b++) {
        const fan = v3(dirToEye[0]! + b * 40, dirToEye[1]! - b * 40, dirToEye[2]!);
        const fanLen = Math.hypot(fan[0]!, fan[1]!, fan[2]!) || 1;
        this.queueTracer(muzzle, fan, PELLET_TRACER_COLOR, fanLen);
        if (this.rand() < pHit) {
          this.damagePlayer(2, m.origin);
          this.pushSpark(eye);
        }
      }
      this.emitSound('soldier/solatck3.wav', v3(m.origin[0]!, m.origin[1]!, m.origin[2]! + 32));
      this.events.push('monshot');
      return;
    }
    let dmg = 5;
    let sound = 'soldier/solatck1.wav';
    if (m.state.kind === 'gunner') {
      dmg = move === 'attack_grenade' ? 12 : 6;
      sound = move === 'attack_grenade' ? 'gunner/gunatck3.wav' : 'gunner/gunatck2.wav';
    }
    this.queueTracer(muzzle, dirToEye, PELLET_TRACER_COLOR, dirLen);
    this.emitSound(sound, v3(m.origin[0]!, m.origin[1]!, m.origin[2]! + 32));
    this.events.push('monshot');
    if (this.rand() < pHit) {
      this.damagePlayer(dmg, m.origin);
      this.pushSpark(eye);
    }
  }

  /** Drain pending enemy muzzle flashes (pumped as yellow dlights). */
  drainEnemyMuzzle(): Array<{ pos: Vec3; intensity: number }> {
    if (this.enemyFlashes.length === 0) return [];
    const out = this.enemyFlashes;
    this.enemyFlashes = [];
    return out;
  }

  /** T_Damage on a monster (g_combat.c gib-first ordering via monsterPain).
   * Corpses re-hit short of gibbing stay corpses; gibbing spawns meat/chest/
   * head extras + misc/udeath and marks DEAD_DEAD (unhittable from then on).
   */
  private painMonster(m: PlacedMonster, damage: number): void {
    const res = monsterPain(m.state, damage, this.rand);
    if (res === 'none') return;
    if (res === 'gib') {
      this.events.push('gib');
      this.message = `${m.state.kind} minced`;
      this.emitSound('misc/udeath.wav', v3(m.origin[0]!, m.origin[1]!, m.origin[2]!));
      this.spawnGibs(v3(m.origin[0]!, m.origin[1]!, m.origin[2]!), damage);
      return;
    }
    this.events.push(m.state.dead ? 'kill' : 'hit');
    if (m.state.dead) this.message = `${m.state.kind} down`;
  }

  /**
   * Mince a monster (m_soldier.c soldier_die gib branch: 3×sm_meat, chest,
   * head2, GIB_ORGANIC). Velocities mirror ThrowGib: self vel (0 here) +
   * 0.5×VelocityForDamage, clipped to [-300,300]×[200,500] up.
   */
  private spawnGibs(pos: Vec3, damage: number): void {
    const kinds: Gib['kind'][] = ['meat', 'meat', 'meat', 'chest', 'head'];
    for (const kind of kinds) {
      const scale = damage < 50 ? 0.7 : 1.2;
      const v = v3(
        100 * (this.rand() * 2 - 1) * scale * 0.5,
        100 * (this.rand() * 2 - 1) * scale * 0.5,
        (200 + 100 * this.rand()) * scale * 0.5,
      );
      v[0] = Math.max(-300, Math.min(300, v[0]!));
      v[1] = Math.max(-300, Math.min(300, v[1]!));
      v[2] = Math.max(200, Math.min(500, v[2]!));
      this.gibs.push({
        origin: v3(
          pos[0]! + (this.rand() * 2 - 1) * 16,
          pos[1]! + (this.rand() * 2 - 1) * 16,
          pos[2]! + (this.rand() * 2 - 1) * 16,
        ),
        vel: v,
        avel: v3(this.rand() * 600, this.rand() * 600, this.rand() * 600),
        born: this.server.time,
        life: 10 + this.rand() * 10,
        kind,
        rest: false,
      });
    }
  }

  /** Apply damage to the player; death parks a 2s respawn timer. */
  damagePlayer(dmg: number, from?: Vec3 | [number, number, number]): void {
    if (this.playerDead || this.exited) return;
    void from;
    this.ps.health -= dmg;
    this.events.push('pain');
    this.emitSound('player/pain.wav', v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]!));
    if (this.ps.health <= 0) {
      this.ps.health = 0;
      this.message = 'YOU DIED — respawning…';
      this.events.push('death');
      this.emitSound('player/death.wav', v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]!));
      this.deadUntil = this.server.time + 2;
    }
  }

  private respawn(): void {
    const sp = this.spawnPoints[0];
    if (sp) {
      this.pm.origin = v3(sp.origin[0], sp.origin[1], sp.origin[2]);
      this.pm.viewAngles = v3(0, sp.yaw, 0);
    } else {
      this.pm.origin = v3(0, 0, 32);
      this.pm.viewAngles = v3();
    }
    this.pm.velocity = v3();
    this.ps.health = this.ps.maxHealth;
    this.deadUntil = -1;
    // A new life is vulnerable again: without this, a completed level left
    // `exited` set forever (spurious or real), and damagePlayer's
    // `exited` guard made the player permanently invincible.
    this.exited = false;
    this.message = '';
    this.events.push('respawn');
    this.playerEdict.origin = v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]);
  }

  /** Walk-over pickups: item/weapon/ammo edicts grant via pickupItem. */
  private checkPickups(): void {
    if (this.playerDead) return;
    const px = this.pm.origin[0]!;
    const py = this.pm.origin[1]!;
    const pz = this.pm.origin[2]!;
    for (const e of this.server.entities) {
      if (e.freed) continue;
      const c = e.classname;
      if (!c.startsWith('item_') && !c.startsWith('weapon_') && !c.startsWith('ammo_')) continue;
      const dx = Math.abs(px - e.origin[0]!);
      const dy = Math.abs(py - e.origin[1]!);
      const dz = pz - e.origin[2]!;
      if (dx > 40 || dy > 40 || dz < -24 || dz > 64) continue;
      const res = pickupItem(this.ps, c);
      if (!res.picked) continue;
      e.freed = true;
      this.syncAmmo();
      this.events.push('pickup');
      this.message = c.replace(/_/g, ' ');
      this.emitSound('items/pickup.wav', v3(px, py, pz));
      if (res.reason === 'weapon' && (c === 'weapon_shotgun' || c === 'weapon_machinegun')) {
        const def = findWeapon(c);
        if (def) {
          this.weapon = def;
          this.events.push('weapon');
        }
      }
    }
  }

  private spawnFromLump(map: BspMap): void {
    // id SelectSpawnPoint (SP): the first info_player_start WITHOUT a
    // targetname. base1's lump leads with a targeted ("base2") start in the
    // exit room for back-travel from base2 — spawning there would drop the
    // player on top of the exit volume and instantly "complete" the level.
    const starts = parseEntities(map.entities).filter(
      (d) => d['classname'] === 'info_player_start' && !d['targetname'],
    );
    this.spawnPoints = starts.map((d) => {
      const yaw = parseFloat(d['angle'], 0);
      let origin = v3(128, -320, 32);
      if (d['origin']) {
        const o = d['origin']!.trim().split(/\s+/).map(Number);
        origin = v3(o[0] ?? 0, o[1] ?? 0, o[2] ?? 32);
      }
      return { origin, yaw };
    });
    const first = this.spawnPoints[0];
    if (first) {
      this.pm.origin = v3(first.origin[0], first.origin[1], first.origin[2]);
      this.pm.viewAngles = v3(0, first.yaw, 0);
    } else {
      this.pm.origin = v3(128, -320, 32);
      this.pm.viewAngles = v3(0, 0, 0);
    }
    this.pm.velocity = v3();
  }

  private placeMonsters(map: BspMap): void {
    let id = 2;
    const skill = getSkill();
    for (const d of parseEntities(map.entities)) {
      if (skillInhibits(parseSpawnflags(d), skill)) continue;
      const cls = d['classname'];
      if (cls !== 'monster_soldier' && cls !== 'monster_soldier_light' && cls !== 'monster_soldier_ss' && cls !== 'monster_gunner') continue;
      // base1 ships 14 soldiers (8 plain + 6 light); keep every placed
      // monster instead of silently dropping the tail.
      if (this.monsters.length >= 16) break;
      // id skinnum per SP_ func (m_soldier.c): light 0 (blaster), plain 2
      // (shotgun), ss 4 (machinegun). Unknown/DM classnames default to the
      // plain shotgun skin. Gunner ignores this (skin 0).
      const skin = cls === 'monster_soldier_light' ? 0 : cls === 'monster_soldier_ss' ? 4 : cls === 'monster_gunner' ? 0 : 2;
      const o = (d['origin'] ?? '0 0 0').trim().split(/\s+/).map(Number);
      let origin: [number, number, number] = [o[0] ?? 0, o[1] ?? 0, o[2] ?? 0];
      // id walkmonster_start_go + M_droptofloor: the lump origin is the
      // entity origin 24 above the feet; drop the hull to the floor so a
      // map-placed origin floating above ground rests correctly instead of
      // hovering, and clamp startsolid Luton setups onto the floor.
      if (this.bspTrace) {
        const start = v3(origin[0], origin[1], origin[2] + 1);
        const end = v3(origin[0], origin[1], origin[2] - 256);
        try {
          const tr = this.bspTrace(start, MONSTER_HULL_MINS, MONSTER_HULL_MAXS, end);
          if (!tr.allsolid) origin = [tr.endpos[0]!, tr.endpos[1]!, tr.endpos[2]!];
        } catch {
          // Keep the lump origin on trace failure (devroom-style fallback).
        }
      }
      this.monsters.push({
        id: id++,
        origin,
        state: spawnMonster(cls === 'monster_gunner' ? 'gunner' : 'soldier'),
        skin,
        lastAttack: -10,
      });
    }
  }

  private snapshotDoorBases(): void {
    if (!this.map) return;
    const snap = (ent: Edict, rest: Vec3): void => {
      const model = ent.model;
      if (!model || !model.startsWith('*')) return;
      const n = Number.parseInt(model.slice(1), 10);
      if (!Number.isFinite(n)) return;
      const count = this.map!.modelsExtra.length / MODEL_EXTRA_STRIDE;
      if (n < 0 || n >= count) return;
      const first = this.map!.modelsExtra[n * MODEL_EXTRA_STRIDE + 1]!;
      const num = this.map!.modelsExtra[n * MODEL_EXTRA_STRIDE + 2]!;
      const faces: MiniSurf[] = [];
      const baseVerts: Float32Array[] = [];
      const baseCenter: Float32Array[] = [];
      const baseMins: Float32Array[] = [];
      const baseMaxs: Float32Array[] = [];
      for (let f = first; f < first + num; f++) {
        const s = this.mini.surfaces[f];
        if (!s || s.n === 0) continue;
        faces.push(s);
        baseVerts.push(new Float32Array(s.verts));
        baseCenter.push(new Float32Array(s.center));
        baseMins.push(new Float32Array(s.mins));
        baseMaxs.push(new Float32Array(s.maxs));
      }
      if (faces.length > 0) {
        this.doors.push({ ent, rest, model: n, faces, baseVerts, baseCenter, baseMins, baseMaxs });
      }
    };
    for (const m of this.server.movers) snap(m.ent, m.pos1);
    // func_train brushes ride the server trains (train_next): snapshot them
    // the same way so the exit-train brush follows the authoritative origin.
    // Point ships (misc_strogg_ship) render as MD2 entities, not brush faces.
    for (const tr of this.server.trains) {
      if (tr.ship) continue;
      const o = (tr.ent.extra['origin'] ?? '0 0 0').trim().split(/\s+/).map(Number);
      snap(tr.ent, v3(o[0] ?? 0, o[1] ?? 0, o[2] ?? 0));
    }
  }

  /** Test hook: how many brush models the DoorSync covers (doors + trains). */
  doorSyncCount(): number {
    return this.doors.length;
  }

  /**
   * Brush-model graft (view-side): QBSP submodel faces (*1..*N — doors,
   * buttons, trains, func_walls) are referenced by NEITHER the world node
   * face ranges NOR any leaf facelist, so the stock world traversal never
   * collects them and every brush entity renders invisible. The fix owns
   * only this MiniWorld instance (fresh per boot): append each rendered
   * brush model's live faces to the facelists of the leaves its mapper
   * bounds intersect (movers/trainds unioned over their full travel so an
   * open door or a running train never leaves its leaves). Frustum,
   * backface, and z culling still apply per surface; PVS is bypassed for
   * these faces (a few hundred extra stamp checks per frame).
   *
   * Excluded on purpose: func_explosive brushes (rendered as the barrel
   * MD2 through extraEntities — grafting would double-draw) and trigger
   * volumes (SURF_NODRAW, degenerate n=0, invisible in C too).
   */
  private graftBrushModels(): void {
    if (!this.map) return;
    const map = this.map;
    const modelCount = map.modelsExtra.length / MODEL_EXTRA_STRIDE;
    // model -> union bounds (mapper space) the brush can ever occupy.
    const unions = new Map<number, { mins: Float32Array; maxs: Float32Array }>();
    const include = (n: number, dx: number, dy: number, dz: number): void => {
      if (n < 0 || n >= modelCount) return;
      const b = modelBounds(map, `*${n}`);
      if (!b) return;
      const lo = [b.mins[0]! + dx, b.mins[1]! + dy, b.mins[2]! + dz];
      const hi = [b.maxs[0]! + dx, b.maxs[1]! + dy, b.maxs[2]! + dz];
      const u = unions.get(n);
      if (!u) {
        unions.set(n, { mins: new Float32Array(lo), maxs: new Float32Array(hi) });
        return;
      }
      for (let k = 0; k < 3; k++) {
        if (lo[k]! < u.mins[k]!) u.mins[k] = lo[k]!;
        if (hi[k]! > u.maxs[k]!) u.maxs[k] = hi[k]!;
      }
    };
    // Movers ride ent.origin - pos1 (0 at spawn) out to pos2 - pos1.
    for (const m of this.server.movers) {
      const n = brushModelNum(m.ent.model);
      if (n === null) continue;
      include(n, 0, 0, 0);
      include(n, m.pos2[0]! - m.pos1[0]!, m.pos2[1]! - m.pos1[1]!, m.pos2[2]! - m.pos1[2]!);
    }
    // Brush trains ride corner - base - rest over every path corner.
    for (const tr of this.server.trains) {
      if (tr.ship) continue;
      const n = brushModelNum(tr.ent.model);
      if (n === null) continue;
      const o = (tr.ent.extra['origin'] ?? '0 0 0').trim().split(/\s+/).map(Number);
      const rx = o[0] ?? 0, ry = o[1] ?? 0, rz = o[2] ?? 0;
      include(n, tr.ent.origin[0]! - rx, tr.ent.origin[1]! - ry, tr.ent.origin[2]! - rz);
      for (const c of tr.corners) {
        include(n, c.pos[0]! - tr.base[0]! - rx, c.pos[1]! - tr.base[1]! - ry, c.pos[2]! - tr.base[2]! - rz);
      }
    }
    // func_wall statics never move: mapper bounds only.
    for (const e of this.server.entities) {
      if (e.freed || e.classname !== 'func_wall' || !e.model) continue;
      const n = brushModelNum(e.model);
      if (n === null) continue;
      include(n, 0, 0, 0);
    }
    if (unions.size === 0) return;
    // Resolve live faces per model once (skip degenerate NODRAW placeholders).
    const facesByModel = new Map<number, number[]>();
    for (const n of unions.keys()) {
      const first = map.modelsExtra[n * MODEL_EXTRA_STRIDE + 1]!;
      const num = map.modelsExtra[n * MODEL_EXTRA_STRIDE + 2]!;
      const list: number[] = [];
      for (let f = first; f < first + num; f++) {
        const s = this.mini.surfaces[f];
        if (s && s.n > 0) list.push(f);
      }
      if (list.length > 0) facesByModel.set(n, list);
    }
    const added = new Set<number>();
    for (const list of facesByModel.values()) {
      for (const f of list) added.add(f);
    }
    this.graftedFaces = [...added].sort((a, b) => a - b);
    // Append each model's faces to the intersecting leaves (BspMap leaf
    // bounds: LEAF_STRIDE=13 ints, mins at +3, maxs at +6).
    const LEAF_STRIDE = 13;
    for (let li = 0; li < map.leafs.length / LEAF_STRIDE; li++) {
      const b = li * LEAF_STRIDE;
      const lmins = [map.leafs[b + 3]!, map.leafs[b + 4]!, map.leafs[b + 5]!];
      const lmaxs = [map.leafs[b + 6]!, map.leafs[b + 7]!, map.leafs[b + 8]!];
      const leaf = this.mini.leafs[li];
      if (!leaf) continue;
      for (const [n, u] of unions) {
        if (u.maxs[0]! < lmins[0]! || u.mins[0]! > lmaxs[0]!) continue;
        if (u.maxs[1]! < lmins[1]! || u.mins[1]! > lmaxs[1]!) continue;
        if (u.maxs[2]! < lmins[2]! || u.mins[2]! > lmaxs[2]!) continue;
        const list = facesByModel.get(n);
        if (!list) continue;
        if (!leaf.faceList) leaf.faceList = [];
        for (const f of list) leaf.faceList.push(f);
      }
    }
  }

  /** Test hook: live submodel faces the graft appended (unique indices). */
  graftedFaceCount(): number {
    return this.graftedFaces.length;
  }

  /** Test hook: the grafted face indices (sorted, unique). */
  graftedFacesSorted(): number[] {
    return [...this.graftedFaces];
  }

  private syncDoors(): void {
    for (const d of this.doors) {
      const ox = d.ent.origin[0]! - d.rest[0]!;
      const oy = d.ent.origin[1]! - d.rest[1]!;
      const oz = d.ent.origin[2]! - d.rest[2]!;
      if (ox === 0 && oy === 0 && oz === 0) continue;
      for (let i = 0; i < d.faces.length; i++) {
        const s = d.faces[i]!;
        const bv = d.baseVerts[i]!;
        for (let k = 0; k < bv.length; k += 3) {
          s.verts[k] = bv[k]! + ox;
          s.verts[k + 1] = bv[k + 1]! + oy;
          s.verts[k + 2] = bv[k + 2]! + oz;
        }
        const bc = d.baseCenter[i]!;
        s.center[0] = bc[0]! + ox;
        s.center[1] = bc[1]! + oy;
        s.center[2] = bc[2]! + oz;
        const bn = d.baseMins[i]!;
        const bx = d.baseMaxs[i]!;
        s.mins[0] = bn[0]! + ox;
        s.mins[1] = bn[1]! + oy;
        s.mins[2] = bn[2]! + oz;
        s.maxs[0] = bx[0]! + ox;
        s.maxs[1] = bx[1]! + oy;
        s.maxs[2] = bx[2]! + oz;
      }
    }
  }

  private handleAttack(cmd: UserCmdT): void {
    if (!(cmd.buttons & BUTTON_ATTACK)) return;
    if (this.playerDead) return;
    const t = this.server.time;
    const refire = REFIRE[this.weapon.classname] ?? 0.25;
    if (t - this.lastShotAt < refire) return;
    const ammo = this.weapon.ammoKind === 'shells' ? this.shells : this.bullets;
    const res = fireWeapon(this.weapon, ammo, this.rand, false);
    if (!res.fired) {
      this.message = 'NO AMMO';
      this.events.push('empty');
      this.emitSound('weapons/noammo.wav', v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]!));
      this.lastShotAt = t;
      return;
    }
    if (this.weapon.ammoKind === 'shells') this.ps.ammo['shells'] = res.ammoLeft;
    if (this.weapon.ammoKind === 'bullets') this.ps.ammo['bullets'] = res.ammoLeft;
    this.syncAmmo();
    this.lastShotAt = t;
    this.message = '';
    this.events.push('shot');
    // Weapon_Generic-lite: firing starts at FIRE_FIRST (activate+1); the
    // per-tick stepper walks it to IDLE_FIRST+1 (READY). viewModel() reports
    // this live gunframe; muzzleLit stays dlight/HUD-only.
    this.gunframe = gunBoundsFor(this.weapon.classname).activate + 1;
    this.firing = true;
    const eye = v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]! + EYE);
    this.emitSound(
      this.weapon.classname === 'weapon_shotgun'
        ? 'weapons/shotgf1b.wav'
        : this.weapon.classname === 'weapon_machinegun'
          ? 'weapons/machgf1b.wav'
          : 'weapons/blastf1a.wav',
      eye,
    );
    // Muzzle flash: HUD glow + a real dlight the renderer understands.
    // id CL_MuzzleFlash: origin = feet + fwd*18 + right*16 (full 3D fwd/
    // right via G_ProjectSource, no up vector), radius 200+(rand&31),
    // pure yellow, single frame.
    this.flashUntil = t + 0.09;
    this.flashPending = true;
    this.flashIntensity = 200 + ((this.rand() * 32) | 0);
    const fwd0 = v3();
    const right0 = v3();
    const up0 = v3();
    AngleVectors(new Float32Array(cmd.angles) as Vec3, fwd0, right0, up0);
    const feet0 = this.pm.origin;
    this.flashPos = v3(
      feet0[0]! + fwd0[0]! * 18 + right0[0]! * 16,
      feet0[1]! + fwd0[1]! * 18 + right0[1]! * 16,
      feet0[2]! + fwd0[2]! * 18 + right0[2]! * 16,
    );
    // Firing kick (p_weapon.c Blaster_Fire/weapon_shotgun_fire): origin
    // -2*fwd, pitch -1 (blaster) / -2 (shotgun). Machinegun has its own
    // per-shot crandom walk (TODO) and sets no kick here.
    if (this.weapon.classname === 'weapon_blaster') {
      this.kickOrigin = v3(-2 * fwd0[0]!, -2 * fwd0[1]!, -2 * fwd0[2]!);
      this.kickAngles = v3(-1, 0, 0);
      this.kickPending = true;
    } else if (this.weapon.classname === 'weapon_shotgun') {
      this.kickOrigin = v3(-2 * fwd0[0]!, -2 * fwd0[1]!, -2 * fwd0[2]!);
      this.kickAngles = v3(-2, 0, 0);
      this.kickPending = true;
    }
    const fwd = v3();
    const right = v3();
    const up = v3();
    AngleVectors(new Float32Array(cmd.angles) as Vec3, fwd, right, up);
    // Authentic split (g_weapon.c): the blaster is a PROJECTILE weapon
    // (fire_blaster bolt edict, 1000 u/s, 2s life, EF_BLASTER trail) — never
    // hitscan, never a muzzle->impact beam. Hitscan weapons (shotgun /
    // machinegun, fire_lead) are instant traces with impact sparks only;
    // only the railgun draws a beam (TE_RAILTRAIL, not in v1).
    if (this.weapon.classname === 'weapon_blaster' && res.bolt) {
      // G_ProjectSource (g_utils.c) from the feet origin: start = feet +
      // fwd*24 + right*8 (full 3D fwd/right), then start.z += viewheight-8
      // (22-8 = 14). No up vector. The bolt leaves the gun muzzle, not the eye.
      const feet = this.pm.origin;
      const start = v3(
        feet[0]! + fwd[0]! * 24 + right[0]! * 8,
        feet[1]! + fwd[1]! * 24 + right[1]! * 8,
        feet[2]! + fwd[2]! * 24 + right[2]! * 8 + (EYE - 8),
      );
      const dir = v3(fwd[0]!, fwd[1]!, fwd[2]!);
      const dl = Math.hypot(dir[0]!, dir[1]!, dir[2]!) || 1;
      this.bolts.push({
        pos: start,
        dir: v3(dir[0]! / dl, dir[1]! / dl, dir[2]! / dl),
        life: res.bolt.life,
        damage: res.bolt.damage,
        speed: BOLT_SPEED,
        foe: false,
        born: this.server.time,
      });
      this.events.push('bolt');
      return;
    }
    for (const pl of res.pellets) {
      const dir = v3(
        fwd[0]! * PELLET_RANGE + right[0]! * pl.r + up[0]! * pl.u,
        fwd[1]! * PELLET_RANGE + right[1]! * pl.r + up[1]! * pl.u,
        fwd[2]! * PELLET_RANGE + right[2]! * pl.r + up[2]! * pl.u,
      );
      const len = Math.hypot(dir[0]!, dir[1]!, dir[2]!) || 1;
      // Pellet spread basis: r/u are world units at PELLET_RANGE (id convention).
      const far = v3(
        eye[0]! + ((dir[0]! / len) * PELLET_RANGE),
        eye[1]! + ((dir[1]! / len) * PELLET_RANGE),
        eye[2]! + ((dir[2]! / len) * PELLET_RANGE),
      );
      const wall = this.traceShot(eye, far);
      let bestT = wall.fraction;
      let hitMonster: PlacedMonster | null = null;
      const seg = v3(far[0]! - eye[0]!, far[1]! - eye[1]!, far[2]! - eye[2]!);
      for (const m of this.monsters) {
        if (m.state.gibbed) continue;
        // No dead-skip: corpses stay hittable (takedamage YES) so re-hitting
        // them minces (g_combat.c T_Damage gib-first ordering in painMonster).
        const mmins: [number, number, number] = [
          m.origin[0]! + MONSTER_MINS[0],
          m.origin[1]! + MONSTER_MINS[1],
          m.origin[2]! + MONSTER_MINS[2],
        ];
        const mmaxs: [number, number, number] = [
          m.origin[0]! + MONSTER_MAXS[0],
          m.origin[1]! + MONSTER_MAXS[1],
          m.origin[2]! + MONSTER_MAXS[2],
        ];
        const tHit = segmentAabb(eye, seg, mmins, mmaxs);
        if (tHit !== null && tHit < bestT) {
          bestT = tHit;
          hitMonster = m;
        }
      }
      const hitPos = v3(
        eye[0]! + seg[0]! * bestT,
        eye[1]! + seg[1]! * bestT,
        eye[2]! + seg[2]! * bestT,
      );
      // Barrels are shootable (misc_explobox takes T_Damage): test the bolt
      // path against live barrels before resolving the wall/monster hit.
      const hitBarrel = this.barrelAT(eye, seg, bestT);
      if (hitBarrel && !hitBarrel.dead) {
        this.damageBarrel(hitBarrel, pl.damage);
      } else if (hitMonster) {
        this.painMonster(hitMonster, pl.damage);
      } else if (bestT < 1) {
        // TE_GUNSHOT / TE_SHOTGUN impact: gray sparks + smoke, no beam.
        this.pushSpark(hitPos);
      }
    }
  }

  /** Parse shootable/scripted explosives from the entities lump (base1).
   *
   * Canonical id defaults come from @q2/game spawnExplosive (g_misc.c /
   * g_target.c): misc_explobox health 10 / dmg 150 / mass 400, func_explosive
   * health 100 / dmg 0 / mass 75, target_explosion dmg 0 / delay 0.
   * misc_explobox origins are kept as the mapper placed them (verified
   * against real base1.bsp: the lump origins already rest on the floor — a
   * hull drop moves them by exactly CONTACT_EPS — matching id's
   * M_droptofloor outcome, since the origin is the box bottom). No drop.
   */
  private parseExplosives(map: BspMap): void {
    const skill = getSkill();
    for (const d of parseEntities(map.entities)) {
      if (skillInhibits(parseSpawnflags(d), skill)) continue;
      const ex = spawnExplosive(d);
      if (!ex) continue;
      if (ex.kind === 'misc_explobox') {
        this.barrels.push({
          origin: v3(ex.origin[0], ex.origin[1], ex.origin[2]),
          health: ex.health,
          dmg: ex.dmg,
          mass: ex.mass,
          size: v3(32, 32, 40),
          isFunc: false,
          dead: false,
        });
      } else if (ex.kind === 'func_explosive') {
        const b = ex.model ? modelBounds(map, ex.model) : null;
        if (!b) continue;
        const cx = (b.mins[0]! + b.maxs[0]!) / 2;
        const cy = (b.mins[1]! + b.maxs[1]!) / 2;
        const cz = (b.mins[2]! + b.maxs[2]!) / 2;
        this.barrels.push({
          origin: v3(cx, cy, cz),
          health: ex.health,
          dmg: ex.dmg,
          mass: ex.mass,
          size: v3(b.maxs[0]! - b.mins[0]!, b.maxs[1]! - b.mins[1]!, b.maxs[2]! - b.mins[2]!),
          isFunc: true,
          dead: false,
        });
      } else if (ex.targetname) {
        this.explosionTargets.set(ex.targetname, {
          origin: v3(ex.origin[0], ex.origin[1], ex.origin[2]),
          dmg: ex.dmg,
          delay: ex.delay,
        });
      }
    }
  }

  /** id SP_trigger_always: fire at spawn (base1 level-start relays). */
  private fireTriggerAlways(map: BspMap): void {
    const skill = getSkill();
    for (const d of parseEntities(map.entities)) {
      if (d['classname'] !== 'trigger_always' || !d['target']) continue;
      if (skillInhibits(parseSpawnflags(d), skill)) continue;
      // Explosion targets only: ships/trains/relays already fired server-side
      // (SV_SpawnEntities runs its own trigger_always pass and starts them).
      for (const t of d['target']!.trim().split(/\s+/)) this.fireExplosionTarget(t);
    }
  }

  /** Scripted corridor blasts: trigger_once/relay chains fire target_explosion. */
  private checkScriptedExplosions(): void {
    for (const t of this.server.firedThisTick) this.fireExplosionTarget(t);
  }

  /** Fire one target_explosion: immediate, or delayed via the fuse list
   * (use_target_explosion: think = explode at level.time + delay). */
  private fireExplosionTarget(targetname: string): void {
    const ex = this.explosionTargets.get(targetname);
    if (!ex) return;
    if (ex.delay > 0) {
      this.fuses.push({ pos: v3(ex.origin[0], ex.origin[1], ex.origin[2]), dmg: ex.dmg, at: this.server.time + ex.delay });
      return;
    }
    this.spawnExplosion(ex.origin, ex.dmg);
  }

  /** Step pending barrel fuses / target_explosion delays on server time. */
  private stepFuses(): void {
    for (let i = this.fuses.length - 1; i >= 0; i--) {
      const f = this.fuses[i]!;
      if (this.server.time < f.at) continue;
      this.fuses.splice(i, 1);
      if (f.barrel) {
        this.spawnBarrelDebris(f.barrel);
      }
      this.spawnExplosion(f.pos, f.dmg);
    }
  }

  /**
   * Explosion visual + sound + radius damage (TE_EXPLOSION1 barrel/func/
   * target, TE_BLASTER touch flash). Big booms emit the 256-count ballistic
   * burst (CL_ExplosionParticles, gravity + 0.625-1.0s ttl); the blaster
   * flash keeps its 40-spark burst (added by blasterImpact, not here).
   * Grounded booms render as explosion2 (BecomeExplosion2), airborne as
   * explosion1 (BecomeExplosion1). Keeps world/explod1.wav as the documented
   * pak fallback (the authentic rocklx1a/grenlx1a lumps are absent from
   * pak0.pak) and lashit for blaster.
   */
  private spawnExplosion(pos: Vec3, dmg: number, kind: ExplosionKind = 'explosion1'): void {
    let baseframe = 0;
    if (kind === 'explosion1') {
      // Grounded barrels burst against the floor (BecomeExplosion2),
      // airborne ones hang (BecomeExplosion1).
      const grounded = this.traceShot(v3(pos[0], pos[1], pos[2] + 1), v3(pos[0], pos[1], pos[2] - 8)).fraction < 1;
      if (grounded) kind = 'explosion2';
      if (kind === 'explosion2') baseframe = 30;
      else if (this.rand() < 0.5) baseframe = 15;
    } else if (kind === 'explosion2') {
      baseframe = 30;
    }
    this.explosions.push({
      pos: v3(pos[0], pos[1], pos[2]),
      born: this.server.time,
      kind,
      baseframe,
      yaw: (this.rand() * 360) | 0,
    });
    if (kind === 'blaster') return;
    for (let i = 0; i < 256; i++) {
      const ox = (this.rand() * 32 - 16) | 0;
      const oy = (this.rand() * 32 - 16) | 0;
      const oz = (this.rand() * 32 - 16) | 0;
      this.pushBallisticSpark(
        v3(pos[0]! + ox, pos[1]! + oy, pos[2]! + oz),
        v3((this.rand() * 384 - 192) | 0, (this.rand() * 384 - 192) | 0, (this.rand() * 384 - 192) | 0),
        0xe0 + ((this.rand() * 8) | 0),
      );
    }
    this.emitSound('world/explod1.wav', v3(pos[0], pos[1], pos[2]));
    this.events.push('explosion');
    if (dmg > 0) this.damageRadius(pos, dmg);
  }

  /**
   * id T_RadiusDamage (g_combat.c): distance is measured from the entity's
   * bbox CENTER (mins+maxs)/2, points = dmg - 0.5*len, the attacker takes
   * half, and CanDamage (LOS) must pass or the entity is skipped. Barrels
   * chain through the 0.2s fuse (damageBarrel). Corpses keep their skip
   * (radius never minces — only direct fire does).
   */
  private damageRadius(pos: Vec3, dmg: number): void {
    const radius = dmg + 40;
    if (!(radius > 0)) return;
    for (const m of this.monsters) {
      if (m.state.dead) continue;
      const center = v3(
        m.origin[0]! + (MONSTER_MINS[0]! + MONSTER_MAXS[0]!) / 2,
        m.origin[1]! + (MONSTER_MINS[1]! + MONSTER_MAXS[1]!) / 2,
        m.origin[2]! + (MONSTER_MINS[2]! + MONSTER_MAXS[2]!) / 2,
      );
      const len = Math.hypot(center[0]! - pos[0]!, center[1]! - pos[1]!, center[2]! - pos[2]!);
      if (len >= radius) continue;
      if (!this.canDamage(center, pos)) continue;
      this.painMonster(m, Math.max(1, Math.round(dmg - 0.5 * len)));
    }
    const pcenter = v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]! + 4);
    const pd = Math.hypot(pcenter[0]! - pos[0]!, pcenter[1]! - pos[1]!, pcenter[2]! - pos[2]!);
    if (pd < radius && this.canDamage(pcenter, pos)) {
      // The attacker (us, who shot the barrel) takes half damage.
      this.damagePlayer(Math.max(1, Math.round((dmg - 0.5 * pd) * 0.5)), [pos[0]!, pos[1]!, pos[2]!]);
    }
    for (const b of this.barrels) {
      if (b.dead) continue;
      const bcenter = v3(b.origin[0]! + b.size[0]! / 2, b.origin[1]! + b.size[1]! / 2, b.origin[2]! + b.size[2]! / 2);
      const bd = Math.hypot(bcenter[0]! - pos[0]!, bcenter[1]! - pos[1]!, bcenter[2]! - pos[2]!);
      if (bd >= radius) continue;
      if (!this.canDamage(bcenter, pos)) continue;
      this.damageBarrel(b, Math.max(1, Math.round(dmg - 0.5 * bd)));
    }
  }

  /** id CanDamage (g_combat.c): point-trace LOS from inflictor to target. */
  private canDamage(target: Vec3, from: Vec3): boolean {
    return this.traceShot(from, target).fraction >= 1;
  }

  /** Step flying blaster bolts (player 1000 u/s, soldier monster 600 u/s, 2s life).
   *
   * Life expires on SERVER time (`server.time - born >= life`, id's
   * `G_FreeEdict at level.time + 2`): the old `life -= dt` tied the 2s fuse
   * to whatever dt the step happened to carry, so a non-tick dt stretched
   * or shrank the bolt's life. Movement still integrates the passed tick
   * quantum (always SERVER_DT from Host.serverTick).
   *
   * Foe bolts (soldier return fire) test the player box and damage the
   * player; player bolts test monsters. Gibbed monsters are skipped, but
   * corpses are NOT (takedamage YES — re-hit minces via painMonster).
   */
  private stepBolts(dt: number): void {
    if (this.bolts.length === 0) return;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const bolt = this.bolts[i]!;
      const stepLen = bolt.speed * dt;
      const next = v3(
        bolt.pos[0]! + bolt.dir[0]! * stepLen,
        bolt.pos[1]! + bolt.dir[1]! * stepLen,
        bolt.pos[2]! + bolt.dir[2]! * stepLen,
      );
      // EF_BLASTER trail (cl_fx.c CL_BlasterTrail): yellow puffs every ~5
      // units at the fixed palette color 0xe0 (no jitter — the impact
      // burst below is where the 0xe0+(rand&7) spread lives).
      const trailSteps = Math.min(8, Math.max(1, Math.round(stepLen / 5)));
      for (let k = 1; k <= trailSteps; k++) {
        const f = k / (trailSteps + 1);
        this.pushColoredSpark(
          v3(
            bolt.pos[0]! + (next[0]! - bolt.pos[0]!) * f,
            bolt.pos[1]! + (next[1]! - bolt.pos[1]!) * f,
            bolt.pos[2]! + (next[2]! - bolt.pos[2]!) * f,
          ),
          0xe0,
        );
      }
      let dead = this.server.time - bolt.born >= bolt.life;
      if (!dead) {
        // Wall touch (blaster_touch: sky frees silently, wall explodes).
        // TODO(sky): TraceResult exposes no SURF_SKY flag, so sky hits
        // explode here; free the bolt silently once the trace carries the
        // surface flag (id blaster_touch).
        const wall = this.traceShot(bolt.pos, next);
        if (wall.fraction < 1) {
          const hitPos = v3(
            bolt.pos[0]! + (next[0]! - bolt.pos[0]!) * wall.fraction,
            bolt.pos[1]! + (next[1]! - bolt.pos[1]!) * wall.fraction,
            bolt.pos[2]! + (next[2]! - bolt.pos[2]!) * wall.fraction,
          );
          this.blasterImpact(hitPos, bolt.damage, null);
          dead = true;
        } else if (bolt.foe) {
          // Soldier return fire: test the player box (feet + viewheight eye
          // band, same hull the world collides with).
          const seg = v3(next[0]! - bolt.pos[0]!, next[1]! - bolt.pos[1]!, next[2]! - bolt.pos[2]!);
          const { mins, maxs } = this.playerBox();
          const pmins: [number, number, number] = [
            this.pm.origin[0]! + mins[0]!,
            this.pm.origin[1]! + mins[1]!,
            this.pm.origin[2]! + mins[2]!,
          ];
          const pmaxs: [number, number, number] = [
            this.pm.origin[0]! + maxs[0]!,
            this.pm.origin[1]! + maxs[1]!,
            this.pm.origin[2]! + maxs[2]!,
          ];
          const tHit = segmentAabb(bolt.pos, seg, pmins, pmaxs);
          if (tHit !== null) {
            const hitPos = v3(bolt.pos[0]! + seg[0]! * tHit, bolt.pos[1]! + seg[1]! * tHit, bolt.pos[2]! + seg[2]! * tHit);
            this.blasterImpact(hitPos, bolt.damage, null);
            if (!this.playerDead) {
              this.damagePlayer(bolt.damage, [hitPos[0]!, hitPos[1]!, hitPos[2]!]);
              this.pushSpark(v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]! + EYE));
            }
            dead = true;
          }
        } else {
          // Flesh touch: monsters first (T_Damage ENERGY), then barrels.
          const seg = v3(next[0]! - bolt.pos[0]!, next[1]! - bolt.pos[1]!, next[2]! - bolt.pos[2]!);
          let hitMonster: PlacedMonster | null = null;
          let bestT = 1;
          for (const m of this.monsters) {
            if (m.state.gibbed) continue;
            const tHit = segmentAabb(
              bolt.pos, seg,
              [m.origin[0]! + MONSTER_MINS[0], m.origin[1]! + MONSTER_MINS[1], m.origin[2]! + MONSTER_MINS[2]],
              [m.origin[0]! + MONSTER_MAXS[0], m.origin[1]! + MONSTER_MAXS[1], m.origin[2]! + MONSTER_MAXS[2]],
            );
            if (tHit !== null && tHit < bestT) {
              bestT = tHit;
              hitMonster = m;
            }
          }
          if (hitMonster) {
            const hitPos = v3(
              bolt.pos[0]! + seg[0]! * bestT,
              bolt.pos[1]! + seg[1]! * bestT,
              bolt.pos[2]! + seg[2]! * bestT,
            );
            this.blasterImpact(hitPos, bolt.damage, hitMonster);
            dead = true;
          } else {
            const hb = this.barrelSegmentAT(bolt.pos, seg);
            if (hb && !hb.dead) {
              this.damageBarrel(hb, bolt.damage);
              this.blasterImpact(v3(hb.origin[0], hb.origin[1], hb.origin[2]), bolt.damage, null);
              dead = true;
            }
          }
        }
      }
      if (dead) this.bolts.splice(i, 1);
      else bolt.pos = next;
    }
  }

  /** TE_BLASTER impact: sparks + explosion flash + lashit + flesh damage. */
  private blasterImpact(pos: Vec3, damage: number, hitMonster: PlacedMonster | null): void {
    for (let i = 0; i < 40; i++) {
      const ox = (this.rand() * 16 - 8) | 0;
      const oy = (this.rand() * 16 - 8) | 0;
      const oz = (this.rand() * 16 - 8) | 0;
      this.pushColoredSpark(v3(pos[0]! + ox, pos[1]! + oy, pos[2]! + oz), 0xe0 + ((this.rand() * 8) | 0));
    }
    this.spawnExplosion(pos, 0, 'blaster');
    this.events.push('explosion');
    this.emitSound('weapons/lashit.wav', v3(pos[0], pos[1], pos[2]));
    if (hitMonster) this.painMonster(hitMonster, damage);
  }

  /** Live barrels whose authentic hull the hitscan segment reaches first. */
  private barrelAT(eye: Vec3, seg: Vec3, bestT: number): Barrel | null {
    let best: Barrel | null = null;
    let bt = bestT;
    for (const b of this.barrels) {
      if (b.dead) continue;
      const tHit = segmentAabb(
        eye, seg,
        [b.origin[0]! + BARREL_MINS[0], b.origin[1]! + BARREL_MINS[1], b.origin[2]! + BARREL_MINS[2]],
        [b.origin[0]! + BARREL_MAXS[0], b.origin[1]! + BARREL_MAXS[1], b.origin[2]! + BARREL_MAXS[2]],
      );
      if (tHit !== null && tHit < bt) {
        bt = tHit;
        best = b;
      }
    }
    return best;
  }

  /** Live barrel along a bolt step segment (point-box test). */
  private barrelSegmentAT(start: Vec3, seg: Vec3): Barrel | null {
    return this.barrelAT(start, seg, 1);
  }

  /**
   * T_Damage on a barrel (g_misc.c barrel_delay): the first lethal hit sets
   * takedamage NO + a 0.2s fuse (think = barrel_explode at level.time + 2
   * frames), then barrel_explode runs T_RadiusDamage + BecomeExplosion.
   * Chained hits (damageRadius chains) re-enter through the same fuse.
   */
  private damageBarrel(b: Barrel, dmg: number): void {
    if (b.dead) return;
    b.health -= dmg;
    if (b.health > 0) return;
    b.dead = true;
    this.events.push('barrel');
    this.fuses.push({
      pos: v3(b.origin[0], b.origin[1], b.origin[2]),
      dmg: b.dmg,
      at: this.server.time + 0.2,
      barrel: { origin: v3(b.origin[0], b.origin[1], b.origin[2]), size: v3(b.size[0], b.size[1], b.size[2]), mass: b.mass, dmg: b.dmg, isFunc: b.isFunc },
    });
  }

  /** Live fuse count (test hook). */
  get pendingFuses(): number {
    return this.fuses.length;
  }

  /**
   * Debris for one exploded barrel (g_misc.c barrel_explode): 2 big
   * (debris1, spd 1.5*dmg/200 at the center), 4 bottom corners (debris3,
   * spd 1.75*dmg/200 at the absmin corners), 8 small (debris2, spd
   * 2*dmg/200 at the center). func_explosive instead uses its mass class
   * (mass/100 cap 8 big + mass/25 cap 16 small).
   */
  private spawnBarrelDebris(b: { origin: Vec3; size: Vec3; mass: number; dmg: number; isFunc: boolean }): void {
    const center = v3(b.origin[0]! + b.size[0]! / 2, b.origin[1]! + b.size[1]! / 2, b.origin[2]! + b.size[2]! / 2);
    if (b.isFunc) {
      const big = Math.min(8, Math.floor(b.mass / 100));
      for (let i = 0; i < big; i++) {
        this.pushDebris('debris1', this.jitterVec(center, b.size), 1);
      }
      const small = Math.min(16, Math.floor(b.mass / 25));
      for (let i = 0; i < small; i++) {
        this.pushDebris('debris2', this.jitterVec(center, b.size), 2);
      }
      return;
    }
    const spd = b.dmg / 200;
    for (let i = 0; i < 2; i++) this.pushDebris('debris1', this.jitterVec(center, b.size), 1.5 * spd);
    for (let cx = 0; cx < 2; cx++) {
      for (let cy = 0; cy < 2; cy++) {
        this.pushDebris(
          'debris3',
          v3(b.origin[0]! + cx * b.size[0]!, b.origin[1]! + cy * b.size[1]!, b.origin[2]!),
          1.75 * spd,
        );
      }
    }
    for (let i = 0; i < 8; i++) this.pushDebris('debris2', this.jitterVec(center, b.size), 2 * spd);
  }

  private jitterVec(center: Vec3, size: Vec3): Vec3 {
    return v3(
      center[0]! + (this.rand() * 2 - 1) * size[0]!,
      center[1]! + (this.rand() * 2 - 1) * size[1]!,
      center[2]! + (this.rand() * 2 - 1) * size[2]!,
    );
  }

  /** One ThrowDebris chunk (g_misc.c): 100*crandom planar, 100+100*rand up,
   * scaled by speed, random spin, 5+rand*5s life. Deterministic via rand. */
  private pushDebris(kind: Debris['kind'], origin: Vec3, speed: number): void {
    this.debris.push({
      origin: v3(origin[0], origin[1], origin[2]),
      vel: v3(
        100 * (this.rand() * 2 - 1) * speed,
        100 * (this.rand() * 2 - 1) * speed,
        (100 + 100 * this.rand()) * speed,
      ),
      avel: v3(this.rand() * 600, this.rand() * 600, this.rand() * 600),
      born: this.server.time,
      life: 5 + this.rand() * 5,
      kind,
      rest: false,
    });
  }

  /**
   * Step debris + gibs (g_phys.c SV_Physics_Toss-lite): gravity, point-trace
   * move, ClipVelocity backoff (1.5 bounce debris / 1.0 toss gibs), floor rest
   * when vz < 60 and the plane normal is floor-like (> 0.7), life expiry
   * (5+rand*5 debris, 10+rand*10 gibs). Headless-deterministic (driver rand
   * only for spawns; stepping is pure math).
   */
  private stepTossed(dt: number): void {
    this.stepChunks(this.debris, dt, 1.5);
    this.stepChunks(this.gibs, dt, 1.0);
  }

  private stepChunks(items: Array<Debris | Gib>, dt: number, backoff: number): void {
    for (let i = items.length - 1; i >= 0; i--) {
      const c = items[i]!;
      if (this.server.time - c.born >= c.life) {
        items.splice(i, 1);
        continue;
      }
      if (c.rest) continue;
      c.vel[2] = c.vel[2]! - TOSS_GRAVITY * dt;
      const next = v3(
        c.origin[0]! + c.vel[0]! * dt,
        c.origin[1]! + c.vel[1]! * dt,
        c.origin[2]! + c.vel[2]! * dt,
      );
      const hit = this.traceShot(c.origin, next);
      if (hit.fraction >= 1) {
        c.origin = next;
        continue;
      }
      c.origin = v3(
        c.origin[0]! + (next[0]! - c.origin[0]!) * hit.fraction,
        c.origin[1]! + (next[1]! - c.origin[1]!) * hit.fraction,
        c.origin[2]! + (next[2]! - c.origin[2]!) * hit.fraction,
      );
      // TraceResult carries the hit plane normal (bsp trace or analytic).
      const n = (hit as { planeNormal?: Vec3 }).planeNormal ?? v3(0, 0, 1);
      const d = (c.vel[0]! * n[0]! + c.vel[1]! * n[1]! + c.vel[2]! * n[2]!) * backoff;
      c.vel = v3(c.vel[0]! - n[0]! * d, c.vel[1]! - n[1]! * d, c.vel[2]! - n[2]! * d);
      if (n[2]! > 0.7 && (backoff < 1.5 || c.vel[2]! < 60)) {
        c.vel = v3();
        c.rest = true;
      }
    }
  }

  /**
   * Drain live explosion flashes for the dlight pump. Blaster flashes are
   * brief (EXPLOSION_LIGHT_WINDOW); big booms burn over their frame life
   * with alpha fade (ex_poly 16-frame alpha, ex_misc linear). Returns pos +
   * kind + alpha so the pump can pick the authentic light per kind.
   */
  drainExplosions(): Array<{ pos: Vec3; kind: ExplosionKind; alpha: number }> {
    const out: Array<{ pos: Vec3; kind: ExplosionKind; alpha: number }> = [];
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i]!;
      const age = this.server.time - e.born;
      const frames = explosionFrames(e.kind);
      // Visuals live their full frame life (baseframe + f at 100ms); the
      // light dies earlier for blaster (brief TE_BLASTER window).
      if (age < 0 || age >= frames * 0.1) {
        this.explosions.splice(i, 1);
        continue;
      }
      const lit = e.kind === 'blaster' ? age < EXPLOSION_LIGHT_WINDOW : age < (frames - 1) * 0.1;
      if (!lit) continue;
      const f = Math.floor(age / 0.1);
      const alpha = e.kind === 'blaster' ? 1 - age / EXPLOSION_LIGHT_WINDOW : (16 - f) / 16;
      out.push({ pos: e.pos, kind: e.kind, alpha: Math.max(0, Math.min(1, alpha)) });
    }
    return out;
  }

  private traceShot(eye: Vec3, far: Vec3): { fraction: number } {
    const zero = v3();
    if (this.bspTrace) return this.bspTrace(eye, zero, zero, far);
    return devroomTrace(eye, zero, zero, far);
  }

  private pushSpark(pos: Vec3): void {
    this.pushColoredSpark(pos, 200 + ((this.rand() * 55) | 0));
  }

  private pushColoredSpark(pos: Vec3, color: number): void {
    const parts = this.mini.particles as { origin: Vec3; color: number }[];
    parts.push({ origin: v3(pos[0], pos[1], pos[2]), color });
    this.particleBorn.push(this.server.time);
    this.particleVel.push(null);
    this.particleTtl.push(SPARK_TTL);
    this.capParticles(parts);
  }

  /**
   * One ballistic boom spark (cl_fx.c CL_ExplosionParticles): fixed palette
   * color, random velocity, PARTICLE_GRAVITY falloff, ttl from alphavel
   * (-0.8/(0.5+rand*0.3) → 0.625-1.0s). Blaster puffs stay static with
   * SPARK_TTL.
   */
  private pushBallisticSpark(pos: Vec3, vel: Vec3, color: number): void {
    const parts = this.mini.particles as { origin: Vec3; color: number }[];
    parts.push({ origin: v3(pos[0], pos[1], pos[2]), color });
    this.particleBorn.push(this.server.time);
    this.particleVel.push(vel);
    this.particleTtl.push(0.625 + this.rand() * 0.375);
    this.capParticles(parts);
  }

  /** Particle pool cap (boom bursts are 256-count; trail/impact add more). */
  private capParticles(parts: { origin: Vec3; color: number }[]): void {
    while (parts.length > 1024) {
      parts.shift();
      this.particleBorn.shift();
      this.particleVel.shift();
      this.particleTtl.shift();
    }
  }

  /**
   * Step driver-pushed sparks: ballistic ones integrate PARTICLE_GRAVITY and
   * expire per their own ttl; static puffs expire after SPARK_TTL.
   * World-seeded particles (born +Infinity, null vel, infinite ttl) are
   * preserved; the length guards realign if the world ships more seeded
   * particles than the driver has births for, or vice versa. Called every
   * server tick before stepBolts so fresh impact sparks (age 0) survive.
   */
  private stepSparks(dt: number): void {
    const parts = this.mini.particles;
    while (this.particleBorn.length < parts.length) this.particleBorn.unshift(Infinity);
    while (this.particleBorn.length > parts.length) this.particleBorn.shift();
    while (this.particleVel.length < parts.length) this.particleVel.unshift(null);
    while (this.particleVel.length > parts.length) this.particleVel.shift();
    while (this.particleTtl.length < parts.length) this.particleTtl.unshift(Infinity);
    while (this.particleTtl.length > this.particleBorn.length) this.particleTtl.shift();
    for (let i = parts.length - 1; i >= 0; i--) {
      const vel = this.particleVel[i];
      if (vel) {
        vel[2] = vel[2]! - SPARK_GRAVITY * dt;
        const o = parts[i]!.origin;
        o[0] = o[0]! + vel[0]! * dt;
        o[1] = o[1]! + vel[1]! * dt;
        o[2] = o[2]! + vel[2]! * dt;
      }
      if (this.server.time - this.particleBorn[i]! > this.particleTtl[i]!) {
        parts.splice(i, 1);
        this.particleBorn.splice(i, 1);
        this.particleVel.splice(i, 1);
        this.particleTtl.splice(i, 1);
      }
    }
  }
}

function segmentAabb(
  origin: Vec3,
  delta: Vec3,
  mins: [number, number, number],
  maxs: [number, number, number],
): number | null {
  let tEnter = 0;
  let tExit = 1;
  for (let k = 0; k < 3; k++) {
    const o = origin[k]!;
    const d = delta[k]!;
    if (d === 0) {
      if (o < mins[k]! || o > maxs[k]!) return null;
      continue;
    }
    let t0 = (mins[k]! - o) / d;
    let t1 = (maxs[k]! - o) / d;
    if (t0 > t1) {
      const t = t0;
      t0 = t1;
      t1 = t;
    }
    if (t0 > tEnter) tEnter = t0;
    if (t1 < tExit) tExit = t1;
    if (tEnter > tExit) return null;
  }
  if (tEnter > 1 || tExit < 0) return null;
  return tEnter;
}

function modelBounds(
  map: BspMap,
  model: string,
): { mins: Float32Array; maxs: Float32Array } | null {
  const n = brushModelNum(model);
  if (n === null) return null;
  const count = map.modelsExtra.length / MODEL_EXTRA_STRIDE;
  if (n < 0 || n >= count) return null;
  return {
    mins: map.modelsMins.slice(n * 3, n * 3 + 3),
    maxs: map.modelsMaxs.slice(n * 3, n * 3 + 3),
  };
}

/** Parse a brush-model ref ('*27') to its model number; null otherwise. */
function brushModelNum(model: string): number | null {
  if (!model.startsWith('*')) return null;
  const n = Number.parseInt(model.slice(1), 10);
  return Number.isFinite(n) ? n : null;
}

/** Inclusive AABB overlap of the player box with brush bounds (C G_TouchTriggers). */
function boxOverlap(
  o: Vec3,
  mins: Vec3, maxs: Vec3,
  bmins: Float32Array, bmaxs: Float32Array,
): boolean {
  for (let i = 0; i < 3; i++) {
    if (o[i]! + mins[i]! > bmaxs[i]! || o[i]! + maxs[i]! < bmins[i]!) return false;
  }
  return true;
}

function buildBase1(pak: WebPak): { map: BspMap; mini: MiniWorld } {
  const bspBytes = readPakEntry(pak, 'maps/base1.bsp');
  const map = loadBsp(bspBytes);
  const texelFor = (walName: string): { texels: Uint8Array; width: number; height: number } | null => {
    const walBytes = tryPakEntry(pak, `textures/${walName}.wal`);
    if (!walBytes) return null;
    try {
      const wal = parseWAL(walBytes);
      return { texels: wal.mips[0]!, width: wal.width, height: wal.height };
    } catch {
      return null;
    }
  };
  const mini = bspToMiniWorld(map, { texelFor });
  return { map, mini };
}

// --- boot + HUD ---

/**
 * Convert a parsed `pics/conchars.pcx` into @q2/client 1bpp font bytes.
 * Passes straight through the @q2/client loader (`loadConcharsFont`, which
 * owns the 128x128 16x16-grid layout + TRANSPARENT_COLOR 255 rule); a lump
 * of the wrong shape (or a loader throw) yields null and the caller keeps
 * the procedural fallback. Pure function: headless/Node safe.
 */
export function concharsFontFromPCX(pcx: Pcx): ConcharsFont | null {
  try {
    return loadConcharsPixels(pcx);
  } catch {
    return null;
  }
}

/**
 * Load the HUD font from a pak (`pics/conchars.pcx` via parsePCX).
 * Returns null when the pak is absent or the lump is missing/unparseable —
 * the caller falls back to the procedural font. Headless/Node safe
 * (no IndexedDB/DOM; parsePCX + setConcharsFont are pure).
 */
export function loadConcharsFont(pak: WebPak | null): ConcharsFont | null {
  if (!pak) return null;
  const bytes = tryPakEntry(pak, 'pics/conchars.pcx');
  if (!bytes) return null;
  try {
    return concharsFontFromPCX(parsePCX(bytes));
  } catch {
    return null;
  }
}

/**
 * Nearest-color remap of 8-bit `pixels` from lump palette `src` to the
 * engine's global palette `dst` (both 768-byte RGB). Fast path: identical
 * palettes (the common case — id art shares one palette) return the input
 * untouched. Else a 256-entry LUT is built once per face (65k distance
 * evaluations) and applied. Pure, headless-safe.
 */
export function remapToPalette(pixels: Uint8Array, src: Uint8Array, dst: Uint8Array): Uint8Array {
  let identical = src.length === dst.length;
  if (identical) {
    for (let i = 0; i < src.length; i++) {
      if (src[i] !== dst[i]) {
        identical = false;
        break;
      }
    }
  }
  if (identical) return pixels;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const r = src[i * 3]!, g = src[i * 3 + 1]!, b = src[i * 3 + 2]!;
    let best = 0, bd = Infinity;
    for (let j = 0; j < 256; j++) {
      const dr = dst[j * 3]! - r, dg = dst[j * 3 + 1]! - g, db = dst[j * 3 + 2]! - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    lut[i] = best;
  }
  const out = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) out[i] = lut[pixels[i]!]!;
  return out;
}

/** Face suffixes in the renderer's strip packing order (top-to-bottom). */
const SKY_SUFFIXES = ['rt', 'bk', 'lf', 'ft', 'up', 'dn'] as const;

/** Worldspawn `sky` key for a map (base1 = "unit1_"), null when absent. */
export function skyNameForMap(map: BspMap | null): string | null {
  if (!map) return null;
  for (const d of parseEntities(map.entities)) {
    if (d['classname'] === 'worldspawn') {
      const s = (d['sky'] ?? '').trim();
      return s ? s : null;
    }
  }
  return null;
}

/**
 * Load id's six `env/<sky>{rt,bk,lf,ft,up,dn}.pcx` sky faces and pack them
 * into the renderer's single-texture contract: vertical strip of 6 tiles,
 * top-to-bottom in suffix order (see `setSkyTexture` in sw-renderer/sky.ts).
 * Returns null when any face is missing/unparseable or sizes disagree — the
 * renderer then keeps its flat-fill fallback. Indices are remapped onto the
 * engine palette (normally a no-op: id art shares one palette).
 */
export function loadSkyStrip(
  pak: WebPak,
  sky: string,
  mainPalette: Uint8Array,
): { texels: Uint8Array; width: number; height: number } | null {
  const faces: Pcx[] = [];
  for (const suf of SKY_SUFFIXES) {
    const bytes = tryPakEntry(pak, `env/${sky}${suf}.pcx`);
    if (!bytes) return null;
    try {
      faces.push(parsePCX(bytes));
    } catch {
      return null;
    }
  }
  const w = faces[0]!.width, h = faces[0]!.height;
  if (w <= 0 || h <= 0) return null;
  for (const f of faces) {
    if (f.width !== w || f.height !== h || f.pixels.length !== w * h) return null;
  }
  const strip = new Uint8Array(w * h * 6);
  for (let i = 0; i < 6; i++) {
    strip.set(remapToPalette(faces[i]!.pixels, faces[i]!.palette, mainPalette), i * w * h);
  }
  return { texels: strip, width: w, height: h * 6 };
}

export interface PlayBoot {
  host: Host;
  driver: LocalDriver;
  refresh: SoftwareRenderer;
  renderer: RendererKind;
  source: 'devroom' | 'pak';
  display: Uint32Array;
  fb565: Uint16Array;
  /** Real-pak MD2/skin handles (null without a pak). */
  models: PakModelHandles | null;
  /** The pak this boot was built from (null = devroom): reboot reuses it. */
  pak: WebPak | null;
}

/**
 * Register the real pak MD2 view/monster/bolt models + PCX skins
 * (TODO(M1.2 follow-up) wiring). Tables come from `@q2/game/assets`
 * (`modelForMonster`, `viewModelForWeapon`, …), parsing from `@q2/formats`
 * (`parseMD2`/`parsePCX`), storage from the renderer's `registerModel` MD2
 * path + `registerSkinData/Pixels`.
 *
 * Registration ORDER is the contract: the soldier skin is skin handle 0 and
 * the soldier mesh is model handle 0, because `Host.renderCurrentView`
 * hardcodes `model: 0, skin: 0` for every snapshot entity (packages/host —
 * outside this package's ownership, so per-kind entity models and skins
 * still share the soldier handles). Per-entity MD2 frames DO vary: the
 * driver maps them through the move tables via the HostDriver entityFrame
 * contract. First-person gun: the 3D view model renders camera-attached via
 * the HostDriver viewModel contract, and the 2D silhouette is skipped when
 * a pak view model is registered (see usesViewModel3D).
 * Until per-kind model selection lands, every monster renders as the
 * soldier mesh/skin. Per-file fallback is the box-critter so one corrupt
 * lump can never shift later handles or break the boot.
 */
export interface PakModelHandles {
  /** Model handle 0: soldier MD2 (or box-critter fallback). */
  monster: number;
  /** PCX skin handle for the soldier MD2 (handle 0, registered first). */
  monsterSkin: number;
  /** PCX skin for monster_soldier_light (skin_lt.pcx, skinnum 0, blaster). */
  soldierLightSkin: number;
  /** PCX skin for monster_soldier_ss (skin_ss.pcx, skinnum 4+, machinegun). */
  soldierSsSkin: number;
  gunner: number;
  /** PCX skin handle for the gunner MD2. */
  gunnerSkin: number;
  weapons: Record<string, number>;
  /** PCX skin handle per weapon classname (parallel to `weapons`). */
  weaponSkins: Record<string, number>;
  bolt: number;
  /** PCX skin handle for the laser-bolt MD2. */
  boltSkin: number;
  /** Shootable explobox (g_misc.c `models/objects/barrels/tris.md2`). */
  barrel: number;
  /** PCX skin for the barrel MD2. */
  barrelSkin: number;
  /** r_explode MD2 for TE_EXPLOSION1/2 (cl_mod_explo4, 15f/19f ex_poly). */
  explode: number;
  /** r_explode skin (skin1.pcx; the MD2 cycles skin1-7 by frame in C). */
  explodeSkin: number;
  /** explode MD2 for the TE_BLASTER 4f ex_misc flash (cl_mod_explode). */
  blast: number;
  /** PCX skin for the blaster-flash MD2. */
  blastSkin: number;
  /** ThrowDebris chunks (debris1 big / debris2 small / debris3 corner). */
  debris1: number;
  debris1Skin: number;
  debris2: number;
  debris2Skin: number;
  debris3: number;
  debris3Skin: number;
  /** Gib chunks (ThrowGib/ThrowHead: sm_meat, chest, bone, head2). */
  gibMeat: number;
  gibMeatSkin: number;
  gibChest: number;
  gibChestSkin: number;
  gibBone: number;
  gibBoneSkin: number;
  gibHead: number;
  gibHeadSkin: number;
  /** Pickup world models (spinning EF_ROTATE items/weapons/ammo) by classname. */
  items: Record<string, { model: number; skin: number }>;
  /** Strogg flyby ship (misc_strogg_ship, trigger_spawned). */
  ship: number;
  shipSkin: number;
  /** Waving courtyard banner (misc_banner, frames 0..15). */
  banner: number;
  bannerSkin: number;
  skins: number[];
}

export function registerPakModels(refresh: SoftwareRenderer, pak: WebPak): PakModelHandles {
  createDevroom(); // guarantees getDevMesh(0) exists for per-file fallbacks
  const skins: number[] = [];
  const ext = refresh as unknown as {
    registerSkinData?: (name: string, texels: Uint8Array, width: number, height: number) => number;
  };
  const loadSkin = (path: string): number => {
    try {
      const bytes = tryPakEntry(pak, path);
      if (bytes && typeof ext.registerSkinData === 'function') {
        const pcx = parsePCX(bytes);
        const h = ext.registerSkinData(path, pcx.pixels, pcx.width, pcx.height);
        skins.push(h);
        return h;
      }
    } catch {
      /* fall through to the checker fallback */
    }
    const h = refresh.registerSkin(path);
    skins.push(h);
    return h;
  };
  const loadModel = (path: string): number => {
    try {
      const bytes = tryPakEntry(pak, path);
      if (bytes) return refresh.registerModel({ name: path, kind: 'md2', data: parseMD2(bytes) });
    } catch {
      /* fall through to the box-critter fallback */
    }
    return refresh.registerModel({ name: path, kind: 'md2', data: getDevMesh(0) });
  };
  // Soldier first: skin handle 0 + model handle 0 (see contract above).
  const monsterSkin = loadSkin(skinForMonster('soldier'));
  const monster = loadModel(modelForMonster('soldier'));
  // Per-skin soldier looks (m_soldier.c skinnum): skin_lt (light/blaster)
  // and skin_ss (ss/machinegun) registered right after, same mesh. Appended
  // here so every later handle stays stable (gunner onward shifts by +2
  // skins vs the old table — no numeric handle is pinned except 0).
  const soldierLightSkin = loadSkin('models/monsters/soldier/skin_lt.pcx');
  const soldierSsSkin = loadSkin('models/monsters/soldier/skin_ss.pcx');
  const gunnerSkin = loadSkin(skinForMonster('gunner'));
  const gunner = loadModel(modelForMonster('gunner'));
  const weapons: Record<string, number> = {};
  const weaponSkins: Record<string, number> = {};
  for (const cls of ['weapon_blaster', 'weapon_shotgun', 'weapon_machinegun']) {
    const mdl = viewModelForWeapon(cls);
    if (!mdl) continue;
    weaponSkins[cls] = loadSkin(skinForWeaponModel(mdl));
    weapons[cls] = loadModel(mdl);
  }
  const boltSkin = loadSkin(skinForBolt());
  const bolt = loadModel(modelForBolt());
  // Barrel last: appending keeps every existing handle stable (soldier 0,
  // gunner, weapons, bolt). Missing lump → box-critter fallback, never a
  // shifted handle.
  const barrelSkin = loadSkin(BARREL_SKIN);
  const barrel = loadModel(BARREL_MODEL);
  // Explosion + debris + gib models (cl_tent.c CL_RegisterTEntModels,
  // g_misc.c ThrowDebris/ThrowGib): appended after everything above, same
  // stability rule. r_explode carries skins skin1..7 (C cycles by frame);
  // skin1 is registered (the renderer has no per-frame skin switch).
  const explodeSkin = loadSkin('models/objects/r_explode/skin1.pcx');
  const explode = loadModel('models/objects/r_explode/tris.md2');
  const blastSkin = loadSkin('models/objects/explode/skin.pcx');
  const blast = loadModel('models/objects/explode/tris.md2');
  const debris1Skin = loadSkin('models/objects/debris1/skin.pcx');
  const debris1 = loadModel('models/objects/debris1/tris.md2');
  const debris2Skin = loadSkin('models/objects/debris2/skin.pcx');
  const debris2 = loadModel('models/objects/debris2/tris.md2');
  const debris3Skin = loadSkin('models/objects/debris3/skin.pcx');
  const debris3 = loadModel('models/objects/debris3/tris.md2');
  const gibMeatSkin = loadSkin('models/objects/gibs/sm_meat/skin.pcx');
  const gibMeat = loadModel('models/objects/gibs/sm_meat/tris.md2');
  const gibChestSkin = loadSkin('models/objects/gibs/chest/skin.pcx');
  const gibChest = loadModel('models/objects/gibs/chest/tris.md2');
  const gibBoneSkin = loadSkin('models/objects/gibs/bone/skin.pcx');
  const gibBone = loadModel('models/objects/gibs/bone/tris.md2');
  const gibHeadSkin = loadSkin('models/objects/gibs/head2/skin.pcx');
  const gibHead = loadModel('models/objects/gibs/head2/tris.md2');
  // Pickup world models (g_items.c EF_ROTATE items/weapons/ammo, appended
  // after everything above, same stability rule): keyed by classname so the
  // driver maps live edicts to handles without hardcoding paths. Missing
  // lump → box-critter/checker fallback, never a shifted handle.
  const items: Record<string, { model: number; skin: number }> = {};
  for (const cls of Object.keys(ITEM_WORLD_MODELS)) {
    const mdl = ITEM_WORLD_MODELS[cls]!;
    items[cls] = { model: loadModel(mdl), skin: loadSkin(skinForItemModel(mdl)) };
  }
  for (const cls of WEAPON_WORLD_CLASSES) {
    if (items[cls] !== undefined) continue;
    const mdl = worldModelForWeapon(cls);
    if (!mdl) continue;
    items[cls] = { model: loadModel(mdl), skin: loadSkin(skinForWeaponModel(mdl)) };
  }
  // Courtyard dressing (g_misc.c): strogg flyby ship + waving banner.
  // The banner skin is the red eagle art (models/objects/banner/skin.pcx).
  const shipSkin = loadSkin(SHIP_SKIN);
  const ship = loadModel(SHIP_MODEL);
  const bannerSkin = loadSkin(BANNER_SKIN);
  const banner = loadModel(BANNER_MODEL);
  return {
    monster, monsterSkin, soldierLightSkin, soldierSsSkin, gunner, gunnerSkin, weapons, weaponSkins, bolt, boltSkin, barrel, barrelSkin,
    explode, explodeSkin, blast, blastSkin,
    debris1, debris1Skin, debris2, debris2Skin, debris3, debris3Skin,
    gibMeat, gibMeatSkin, gibChest, gibChestSkin, gibBone, gibBoneSkin, gibHead, gibHeadSkin,
    items, ship, shipSkin, banner, bannerSkin,
    skins,
  };
}

export function bootPlay(opts: {
  width?: number;
  height?: number;
  renderer?: RendererKind;
  pak?: WebPak | null;
}): PlayBoot {
  // Latch the menu resolution when the caller passes no explicit size:
  // changing vid_resolution reboots at the new framebuffer size.
  const res = getResolution();
  const width = opts.width ?? res.width;
  const height = opts.height ?? res.height;
  const renderer = opts.renderer ?? 'software';
  const driver = new LocalDriver(opts.pak ?? null);
  const refresh = new SoftwareRenderer();
  let mainPalette: Uint8Array | null = null;
  if (opts.pak) {
    const pcxBytes = tryPakEntry(opts.pak, 'pics/colormap.pcx');
    if (pcxBytes) {
      try {
        mainPalette = parsePCX(pcxBytes).palette;
        refresh.setPalette(mainPalette);
      } catch {
        /* procedural palette fallback */
      }
    }
    // Original Quake II sky: six env/ faces packed as one strip (id mapping).
    // Missing/unparseable art → renderer keeps its flat-fill fallback.
    if (driver.map && mainPalette) {
      const sky = skyNameForMap(driver.map);
      if (sky) {
        const strip = loadSkyStrip(opts.pak, sky, mainPalette);
        if (strip) {
          try {
            refresh.setSkyTexture(strip);
          } catch {
            /* flat-fill fallback stays active */
          }
        }
      }
    }
  }
  // HUD font: real `pics/conchars.pcx` when the pak ships it, procedural
  // xorshift fallback otherwise (deterministic per boot so tests are
  // order-independent despite the global active font).
  try {
    setConcharsFont(loadConcharsFont(opts.pak ?? null) ?? makeConcharsFont());
  } catch {
    /* procedural font already active via getConcharsFont() */
  }
  const host = new Host({
    refresh,
    width,
    height,
    indexed: true,
    world: { name: driver.source === 'pak' ? 'maps/base1' : 'maps/devroom', data: driver.mini },
    driver,
  });
  // M8.1: opt into SAB banding when the operator set sw_workers (cvar panel
  // or console). Silent fallback to the single-threaded path everywhere the
  // banded path is unavailable (default cvar 0, no SAB, Node/vitest).
  try {
    refresh.syncWorkersFromCvar();
  } catch {
    /* single-threaded path stays active */
  }
  // Monster placeholder mesh must be handle 0: register before anything else.
  // With a pak, register the real MD2s + PCX skins (soldier first so the
  // Host's hardcoded model:0/skin:0 entities render as the real mesh);
  // without one, keep the procedural box-critter exactly as before.
  let models: PakModelHandles | null = null;
  if (opts.pak) {
    models = registerPakModels(refresh, opts.pak);
    driver.models = models;
  } else if (driver.monsters.length > 0) {
    createDevroom();
    host.refresh.registerModel({ name: 'monster', kind: 'md2', data: getDevMesh(0) });
  }
  const n = width * height;
  return { host, driver, refresh, renderer, source: driver.source, display: new Uint32Array(n), fb565: new Uint16Array(n), models, pak: opts.pak ?? null };
}

/**
 * Reboot a boot at the CURRENT cvar values (skill + vid_resolution): the
 * menu path for "changing the dropdown reboots the level". Same pak and
 * renderer as the previous boot, fresh driver/server/mini (DoorSync bases
 * re-baked, skill filter re-applied before spawning). Headless-safe.
 */
export function rebootPlay(prev: PlayBoot): PlayBoot {
  return bootPlay({ renderer: prev.renderer, pak: prev.pak });
}

/** Resolve the software framebuffer for display (voodoo post chain or direct).
 *
 * Display-only `r_brightness` lift (see `getBrightness`) is applied to the
 * scene copy here, *before* `drawPlayHud` paints on top — so HUD text keeps
 * its full authored colour and is never dimmed or clipped by the lift.
 * At 1.0 the software path returns the engine buffer untouched
 * (byte-identical, same reference).
 */
export function resolveDisplay(boot: PlayBoot): Uint32Array {
  const { host } = boot;
  const brightness = getBrightness();
  if (getCVarString('vid_renderer') === 'voodoo') {
    resolveFrame(host.fb.color, boot.fb565, boot.display, host.fb.width, host.fb.height);
    applyBrightness(boot.display, brightness);
    return boot.display;
  }
  if (brightness === 1) return host.fb.color;
  boot.display.set(host.fb.color);
  applyBrightness(boot.display, brightness);
  return boot.display;
}

/**
 * Pump the one-shot muzzle-flash dynamic light into the renderer. Call
 * before the frame renders (the dom rAF tick does this; headless tests call
 * it directly). Clears the renderer's dlight list first so the flash can
 * never accumulate — exactly one add per shot, baseline restored on expiry.
 * The clear hook is feature-detected (a future expiry hook wins when
 * present). No-op once the flash window expires or was already drained.
 */
export function pumpMuzzleLight(boot: PlayBoot): boolean {
  const hooks = boot.refresh as unknown as {
    testExpireDynamicLights?: () => void;
    testClearDynamicLights?: () => void;
  };
  if (typeof hooks.testExpireDynamicLights === 'function') {
    hooks.testExpireDynamicLights();
  } else if (typeof hooks.testClearDynamicLights === 'function') {
    hooks.testClearDynamicLights();
  }
  const pos = boot.driver.drainFlash();
  let pumped = false;
  if (pos) {
    boot.refresh.testAddDynamicLight({
      origin: new Float32Array([pos[0]!, pos[1]!, pos[2]!]),
      intensity: boot.driver.peekFlashIntensity(),
      color: new Float32Array([1, 1, 0]),
    });
    pumped = true;
  }
  // Enemy return-fire muzzles (200+(rand&31) yellow, drained one-shot like
  // the player flash so they can never accumulate either).
  for (const f of boot.driver.drainEnemyMuzzle()) {
    boot.refresh.testAddDynamicLight({
      origin: new Float32Array([f.pos[0]!, f.pos[1]!, f.pos[2]!]),
      intensity: f.intensity,
      color: new Float32Array([1, 1, 0]),
    });
    pumped = true;
  }
  return pumped;
}

/**
 * Pump one in-flight dlight per live blaster bolt (id CL_BlasterTrail /
 * V_AddLight: 200-intensity pure yellow every frame). Same
 * testAddDynamicLight path as the muzzle/explosion pumps; call alongside
 * them before the frame renders. The dom tick wires muzzle + explosion;
 * wire this next to them when the tick is next touched (dom.ts is outside
 * this change's file lock, so headless/tests pump it explicitly).
 */
export function pumpBoltLights(boot: PlayBoot): number {
  let n = 0;
  for (const bolt of boot.driver.bolts) {
    boot.refresh.testAddDynamicLight({
      origin: new Float32Array([bolt.pos[0]!, bolt.pos[1]!, bolt.pos[2]!]),
      intensity: 200,
      color: new Float32Array([1, 1, 0]),
    });
    n++;
  }
  return n;
}

/** Pump explosion/bolt-impact dlights (cl_tent.c CL_AddExplosions:
 * ex_poly 350*[1,.5,.5]*alpha over the 15/19f life, ex_misc blaster
 * 150 yellow*alpha over its brief window). */
export function pumpExplosionLights(boot: PlayBoot): number {
  const flashes = boot.driver.drainExplosions();
  let n = 0;
  for (const f of flashes) {
    const isBlast = f.kind === 'blaster';
    boot.refresh.testAddDynamicLight({
      origin: new Float32Array([f.pos[0]!, f.pos[1]!, f.pos[2]!]),
      intensity: (isBlast ? 150 : 350) * f.alpha,
      color: isBlast ? new Float32Array([1, 1, 0]) : new Float32Array([1, 0.5, 0.5]),
    });
    n++;
  }
  return n;
}

/** Renderer-owned tracer ttl in frames (~0.1s at 60fps). */
export const TRACER_TTL_FRAMES = 6;

/**
 * Pump queued driver beams into the renderer's `spawnTracer` pool. Call
 * before the frame renders (the dom rAF tick does this, next to
 * pumpMuzzleLight; headless tests call it directly). Feature-detected like
 * the muzzle pump: without `spawnTracer` the queue is still drained (so it
 * can never grow across frames) and 0 is returned. Returns beams accepted.
 */
export function pumpTracers(boot: PlayBoot): number {
  const hooks = boot.refresh as unknown as {
    spawnTracer?: (
      origin: ArrayLike<number>,
      dir: ArrayLike<number>,
      color?: number,
      length?: number,
      ttlFrames?: number,
    ) => boolean;
  };
  const queued = boot.driver.drainTracers();
  if (typeof hooks.spawnTracer !== 'function') return 0;
  let n = 0;
  for (const t of queued) {
    if (hooks.spawnTracer(t.origin, t.dir, t.color, t.length, TRACER_TTL_FRAMES)) n++;
  }
  return n;
}

export interface HudState {
  fps: number;
  frame: number;
}

/** In-canvas fps readout colour: readable green, 0xAABBGGRR like all HUD. */
export const FPS_GREEN = 0xff00ff00;

/**
 * Pure anchor for the in-canvas fps readout: top-right, 8px margins, using
 * the active conchars font metrics (real pak glyphs when present, procedural
 * fallback otherwise — both are 8px-advance via `stringWidth`). No
 * background rect is ever drawn behind the text.
 */
export function fpsHudAnchor(width: number, text: string): { x: number; y: number } {
  return { x: Math.max(0, width - stringWidth(text) - 8), y: 8 };
}

/** `cl_showfps` gates the in-canvas fps readout too (default 1 when absent). */
function showInCanvasFps(): boolean {
  if (getCVar('cl_showfps') === undefined) return true;
  return getCVarNumber('cl_showfps') !== 0;
}

/** Draw crosshair + status lines onto a 0xAABBGGRR buffer (runs post-resolve). */
export function drawPlayHud(
  target: { width: number; height: number; color: Uint32Array },
  boot: PlayBoot,
  hud: HudState,
): void {
  const white = 0xffffffff;
  const dim = 0xff888888;
  const cx = (target.width / 2) | 0;
  const cy = (target.height / 2) | 0;
  fillRect(target, cx - 4, cy, 9, 1, dim);
  fillRect(target, cx, cy - 4, 1, 9, dim);
  fillRect(target, cx, cy, 1, 1, white);
  // 3D view model (pak) replaces the 2D silhouette — never double-draw.
  if (usesViewModel3D(boot)) drawDeathBars(target, boot);
  else drawViewModel(target, boot);
  const o = boot.driver.pm.origin;
  const hp = boot.driver.playerHealth;
  const hpColor = boot.driver.playerDead ? 0xffff3333 : hp <= 25 ? 0xffff9933 : white;
  if (showInCanvasFps()) {
    const fpsText = `fps ${hud.fps.toFixed(0)}`;
    const anchor = fpsHudAnchor(target.width, fpsText);
    drawString(target, anchor.x, anchor.y, fpsText, FPS_GREEN);
  }
  drawString(target, 8, 18, `${o[0]!.toFixed(0)} ${o[1]!.toFixed(0)} ${o[2]!.toFixed(0)}`, dim);
  drawString(target, 8, target.height - 18, `${boot.driver.weapon.classname} ${boot.driver.hudAmmo()}`, white);
  drawString(target, 8, target.height - 48, `hp ${hp}`, hpColor);
  if (boot.driver.message) {
    const msg = boot.driver.message.slice(0, 48);
    drawString(target, 8, target.height - 30, msg, 0xffffff00);
  }
  if (boot.source === 'devroom') {
    drawString(target, 8, 28, 'devroom - drop pak0.pak for base1', dim);
  }
  // Controls reference (M7.1 crouch UX): dim single line above the hp row
  // (h-48), clear of the weapon (h-18) and message (h-30) rows. Clipped away
  // on tiny buffers; the same text lives in index.html #q2-help.
  drawString(target, 8, target.height - 62, CONTROLS_HINT, dim);
}

/**
 * Whether the first-person gun renders as a real 3D `v_weap` MD2 (via the
 * HostDriver viewModel contract) instead of the 2D `fillRect` silhouette.
 * True exactly when the selected weapon has a registered pak view model.
 */
export function usesViewModel3D(boot: PlayBoot): boolean {
  return boot.models?.weapons[boot.driver.weapon.classname] !== undefined;
}

/** Red edge bars while dead (extracted so they survive the 2D-gun removal). */
function drawDeathBars(
  target: { width: number; height: number; color: Uint32Array },
  boot: PlayBoot,
): void {
  if (!boot.driver.playerDead) return;
  const w = target.width;
  const h = target.height;
  fillRect(target, 0, 0, w, 3, 0xffff2222);
  fillRect(target, 0, h - 3, w, 3, 0xffff2222);
}
/**
 * 2D `fillRect` gun silhouette bottom-right + muzzle flash rect — the
 * fallback when no 3D `v_weap` MD2 is registered for the selected weapon
 * (devroom / missing lump; see usesViewModel3D). With a pak the Host
 * renders the real camera-attached MD2 via the viewModel contract and this
 * icon is skipped (no double-draw).
 * Per-weapon body size/shape/caption already differ (blaster 52px,
 * machinegun 66px, shotgun 78px), so the selected weapon changes the
 * visible model. The 3D muzzle dlight is pumped separately via
 * drainFlash(), and bolt/pellet beams via pumpTracers().
 * Drawn post-resolve in HUD space (the software renderer has no
 * screen-space sprite path).
 *
 * The silhouette is a side-view breakdown — stepped wooden/polymer stock,
 * receiver with top highlight + bottom shade, thin barrel with muzzle ring,
 * grip, trigger guard, and sights — so it reads as an intentional low-res
 * sprite rather than stacked blobs. `fillRect` only (2D nicety, no MD2).
 */
function drawViewModel(
  target: { width: number; height: number; color: Uint32Array },
  boot: PlayBoot,
): void {
  const w = target.width;
  const h = target.height;
  const cls = boot.driver.weapon.classname;
  const isShotgun = cls === 'weapon_shotgun';
  const isMachinegun = cls === 'weapon_machinegun';
  const gunW = isShotgun ? 78 : isMachinegun ? 66 : 52;
  const gx = w - gunW - 10;
  const gy = h - 36;
  if (w < 120 || h < 100) return;
  const body = isShotgun ? 0xff6b4a26 : isMachinegun ? 0xff4a4a52 : 0xff3a3f44;
  const dark = 0xff1c1c20;
  const edge = 0xff101014;
  const gripC = 0xff2a2018;
  const wood = 0xff7a4d22;
  const steel = 0xff777782;
  const lite = 0xff9a9aa2;
  const muzzleX = gx + gunW - 2;
  // Stock: stepped taper toward the butt (left), wood on shotgun, dark else.
  const stockC = isShotgun ? wood : dark;
  fillRect(target, gx, gy + 14, 10, 10, stockC);
  fillRect(target, gx + 10, gy + 11, 8, 13, stockC);
  fillRect(target, gx, gy + 14, 18, 1, lite);
  // Receiver: main block with top highlight and bottom shade line.
  fillRect(target, gx + 18, gy + 9, 24, 13, body);
  fillRect(target, gx + 18, gy + 9, 24, 1, lite);
  fillRect(target, gx + 18, gy + 21, 24, 1, edge);
  // Barrel: thin steel tube + darker muzzle ring at the tip.
  fillRect(target, gx + 42, gy + 11, gunW - 48, 5, steel);
  fillRect(target, gx + 42, gy + 11, gunW - 48, 1, lite);
  fillRect(target, muzzleX - 3, gy + 10, 3, 7, dark);
  // Grip + trigger guard below the receiver.
  fillRect(target, gx + 22, gy + 22, 7, 7, gripC);
  fillRect(target, gx + 31, gy + 22, 6, 2, edge);
  // Rear notch + front post sights above the top line.
  fillRect(target, gx + 20, gy + 6, 2, 3, edge);
  fillRect(target, muzzleX - 5, gy + 7, 2, 4, edge);
  if (isShotgun) {
    // Wooden pump under the barrel.
    fillRect(target, gx + 46, gy + 17, 14, 5, wood);
    fillRect(target, gx + 46, gy + 17, 14, 1, lite);
  } else if (isMachinegun) {
    // Boxy magazine + top carry handle.
    fillRect(target, gx + 30, gy + 22, 9, 8, dark);
    fillRect(target, gx + 30, gy + 22, 9, 1, lite);
    fillRect(target, gx + 22, gy + 6, 14, 3, dark);
  } else {
    // Blaster: side cooling fins + glowing tip.
    fillRect(target, gx + 26, gy + 9, 2, 13, edge);
    fillRect(target, gx + 32, gy + 9, 2, 13, edge);
    fillRect(target, muzzleX - 1, gy + 12, 2, 3, 0xff66eeff);
  }
  if (boot.driver.muzzleLit()) {
    // Flash star at the muzzle + a soft glow wash over the gun.
    const bcy = gy + 13;
    fillRect(target, muzzleX - 8, bcy - 7, 18, 15, 0xffffee88);
    fillRect(target, muzzleX - 12, bcy - 2, 26, 5, 0xffffee88);
    fillRect(target, muzzleX - 6, bcy - 4, 14, 9, 0xffffffff);
    fillRect(target, gx, gy + 6, gunW, 24, 0x66ffdd66);
  }
  if (boot.driver.playerDead) {
    drawDeathBars(target, boot);
  }
  // Placeholder caption: short weapon name above the silhouette.
  const short = cls.replace(/^weapon_/, '');
  if (w >= 120 && h >= 100) drawString(target, gx, gy - 10, short, 0xffbbbbbb);
}
