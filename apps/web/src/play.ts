// q2ts-web play driver: server-authoritative local play (M7.1+).
//
// Headless-safe (no DOM here; the rAF loop lives in dom.ts). Two modes:
// - devroom: procedural MiniWorld visuals + analytic room collision.
// - pak: real base1.bsp (BSP collision, WAL textures, PCX palette,
//   doors/triggers/movers, static soldier/gunner placeholders you can shoot).
import { Host } from '@q2/host';
import type { ExtraRenderable, HostDriver } from '@q2/host';
import { BUTTON_ATTACK, BUTTON_USE, buildUserCmd, isDuckHeld } from '@q2/input';
import type { UserCmdT } from '@q2/input';
import type { PredictCmd, Snapshot } from '@q2/client';
import {
  calcViewOrigin,
  drawString,
  fillRect,
  lerpAngle,
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
  bspPointContentsFor,
  findWeapon,
  mulberry32,
  WEAPON_BLASTER,
  monsterMoveOf,
  makePlayerState,
  pickupItem,
  modelForMonster,
  skinForMonster,
  viewModelForWeapon,
  worldModelForWeapon,
  modelForBolt,
  skinForBolt,
  skinForWeaponModel,
  HITSCAN_TRACER_COLOR,
  deadsoldierFrameForSpawnflags,
} from '@q2/game';
import type {
  PmoveState,
  UserCmd,
  Edict,
  Mover,
  Trigger,
  WeaponDef,
  TraceResult,
  PointContentsFn,
  PlayerState,
} from '@q2/game';
import {
  SV_CarryRiders,
  SV_Init,
  SV_SetSkill,
  SV_SpawnEntities,
  SV_Tick,
  SV_TouchButtonsAt,
  SV_TouchTriggersAt,
  SV_TouchDoorsAt,
  SV_DropTraceFor,
  SV_TraceFor,
  SV_ClipTrace,
  SV_PlayerFire,
  SV_UseButton,
  SV_UseTargetname,
  SV_DamagePlayer,
  SV_SetPlayerHealth,
  SV_SetPlayerSuit,
  SV_DrainMuzzles,
  SV_DrainTracers,
  SV_DrainSparks,
  SV_DrainSounds,
  SV_ClearFinished,
  MASK_OPAQUE_C,
} from '@q2/server';
import type { ServerState, ServerMonster, ServerBarrel, ServerBolt, ServerExplosion, ServerDebris, ServerGib } from '@q2/server';
import { ATTN_NORM, Mixer } from '@q2/sound';
import { parseMD2, parseWAL, parsePCX } from '@q2/formats';
import type { Pcx } from '@q2/formats';
import { expandRGB565, gammaLUT, readVoodooState, resolveFrame } from '@q2/voodoo';
import type { VoodooState } from '@q2/voodoo';
import { AngleVectors, v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import { SERVER_DT, getCVar, getCVarNumber, getCVarString, registerCVar } from '@q2/config';
import type { Entity, RefDef } from '@q2/renderer-api';
import { readPakEntry } from './pak.js';
import type { WebPak } from './pak.js';
import { BrowserBandPool, browserPoolAvailable } from './render-workers.js';
import { selectVoodooBandPath, snapshotVoodooState } from './render-workers.js';
import type { VoodooBandPath } from './render-workers.js';

export type RendererKind = 'software' | 'voodoo';

/**
 * Which resolve path the last `resolveDisplay` took (observability for
 * tests/debug; V2d). `strict-hud-first` = HUD composed into the emulated
 * pre-scanout target before reconstruction; `legacy-hud-last` = current
 * paint-HUD-after behaviour; `software-*` = direct engine buffer paths.
 */
export type ResolveOrder =
  | 'none'
  | 'strict-hud-first'
  | 'legacy-hud-last'
  | 'software-passthrough'
  | 'software-lifted';

/**
 * Last `armRasterPolicy` outcome (P1 observability: the old hook-probe
 * silently no-oped, leaving voodoo mode on the indexed rasterizer).
 * `mode` echoes the boot renderer the policy armed for, `rgbEnabled` is the
 * requested RGB-world state (true in voodoo mode), and `hooked` reports
 * whether a real renderer hook consumed the request. When `hooked` is false
 * `armRasterPolicy` `console.warn`s and keeps the indexed fallback.
 */
export interface RasterPolicyStatus {
  mode: RendererKind;
  rgbEnabled: boolean;
  hooked: boolean;
}

/**
 * Rotate a baked brush-model vertex about a pivot by Quake delta angles
 * (degrees [pitch, yaw, roll]). Render-side twin of the server's angular
 * movers (func_door_rotating): v' = pivot + dx*F - dy*R + dz*U, the
 * R_AliasSetUpTransform basis the alias backend already uses — an identity
 * delta is the identity, so closed rotators render bit-identical to the
 * baked verts. Pure (no sim state); covered by door-rotation.test.ts.
 */
export function rotateDoorVert(base: Vec3, pivot: Vec3, delta: Vec3, out?: Vec3): Vec3 {
  const fwd = v3();
  const right = v3();
  const up = v3();
  AngleVectors(delta, fwd, right, up);
  const dx = base[0]! - pivot[0]!;
  const dy = base[1]! - pivot[1]!;
  const dz = base[2]! - pivot[2]!;
  const o = out ?? v3();
  o[0] = pivot[0]! + dx * fwd[0]! - dy * right[0]! + dz * up[0]!;
  o[1] = pivot[1]! + dx * fwd[1]! - dy * right[1]! + dz * up[1]!;
  o[2] = pivot[2]! + dx * fwd[2]! - dy * right[2]! + dz * up[2]!;
  return o;
}

// --- display-only brightness (M7.1 feedback) ---
//
// `r_brightness` is a pure presentation lift applied post-resolve in
// `resolveDisplay` (0xAABBGGRR scale + clamp). It never touches lightmaps,
// the palette, the pak, or the renderer internals — the framebuffer the
// engine produced is unchanged. Strict voodoo is EXEMPT (effective 1.0):
// `vd_gamma` inside `resolveFrame` is already the display-gamma stage, so
// stacking the lift would double-apply gamma; legacy voodoo + software keep
// it. Registered here (apps/web owns the display path); `getBrightness`
// treats an absent cvar (e.g. after `resetCVars()` in tests) as the default
// so headless boots stay deterministic.
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

// --- map source (M7.1 config menu) ---
//
// Which world to boot: the built-in procedural devroom (demomap, asset-free)
// or the cached pak0.pak game map (base1). The menu exposes it as a dropdown
// (see MAP_SOURCE_LABELS in dom.ts); the value persists via setCVar and is
// latched at boot — changing it reboots the level (see REBOOT_CVARS), the
// same fresh-reboot path as skill/vid_resolution (rebootPlay).
//
// Default is the pak: a cached drop boots straight into base1 (the M7.3
// cached-first behaviour); with no pak cached the boot degrades gracefully
// to devroom (bootPlay maps a null pak to devroom, and rebootPlay maps a
// pak request with no pak the same way). The no-pak boot path resets the
// cvar to devroom so the menu never shows a stale pak selection.
export const MAP_SOURCE_DEVROOM = 'devroom';
export const MAP_SOURCE_PAK = 'pak';
export type MapSource = typeof MAP_SOURCE_DEVROOM | typeof MAP_SOURCE_PAK;
export const MAP_SOURCE_DEFAULT: MapSource = MAP_SOURCE_PAK;
export const MAP_SOURCE_OPTIONS = [MAP_SOURCE_DEVROOM, MAP_SOURCE_PAK] as const;

registerCVar('map_source', MAP_SOURCE_DEFAULT, 'map source: cached pak0.pak game (pak) or built-in devroom (devroom); changing it reboots the level');

/** Clamped `map_source` (absent/garbage cvar → default). Self-healing like getSkill. */
export function getMapSource(): MapSource {
  const raw = getCVar('map_source');
  if (raw === undefined) {
    registerCVar('map_source', MAP_SOURCE_DEFAULT, 'map source: cached pak0.pak game (pak) or built-in devroom (devroom); changing it reboots the level');
    return MAP_SOURCE_DEFAULT;
  }
  return raw === MAP_SOURCE_DEVROOM ? MAP_SOURCE_DEVROOM : MAP_SOURCE_PAK;
}

/**
 * Dropdown sources for the menu: devroom is always listed; the cached pak
 * appears only after a drop (hasPak). Pure/headless-safe — the DOM panel
 * filters through this (see setMapSourceHasPak in dom.ts).
 */
export function availableMapSources(hasPak: boolean): MapSource[] {
  return hasPak ? [MAP_SOURCE_DEVROOM, MAP_SOURCE_PAK] : [MAP_SOURCE_DEVROOM];
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

// --- crouch (M7.1 UX, Phase 3 single duck state) ---
//
// The browser binding lives in @q2/input (KeyC → 'crouch' logical key,
// BUTTON_DUCK on the built UserCmdT; attachToCanvas wires it with zero
// web-side code). This package translates the hold into PMF_DUCKED and lets
// PM_CheckDuck own it: step() asserts the flag while the hold bit is down
// (immediate engage, including the first tick when ground is not yet
// categorized) and never clears it, so release flows through the
// headroom-checked stand-up (hull maxs 32 → 4, viewheight 22 → -2). The host
// eye follows the authoritative pm.viewheight (host-owned calcViewOrigin
// call) and the mixer listener rides the same height — one transition per
// edge, no per-tick flip-flop while held.

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

/**
 * C world_model lumps (game/g_items.c) for the SP-remnant arsenal the game
 * table does not carry (it stops at blaster/shotgun/machinegun): all
 * verified present in pak0.pak (see WEAPON_WORLD_CLASSES registration).
 * weapon_grenades is intentionally absent: C hand grenades have no g_ world
 * model (the "Grenades" usable IS the ammo_grenades box — v_handgr is
 * view-only), so the ammo box stays the C-identical pickup visual.
 */
const WEAPON_WORLD_FALLBACK: Record<string, string> = {
  weapon_supershotgun: 'models/weapons/g_shotg2/tris.md2',
  weapon_chaingun: 'models/weapons/g_chain/tris.md2',
  weapon_grenadelauncher: 'models/weapons/g_launch/tris.md2',
  weapon_rocketlauncher: 'models/weapons/g_rocket/tris.md2',
  weapon_hyperblaster: 'models/weapons/g_hyperb/tris.md2',
  weapon_railgun: 'models/weapons/g_rail/tris.md2',
  weapon_bfg: 'models/weapons/g_bfg/tris.md2',
};

/**
 * C view_model lumps (game/g_items.c) for the same remnant set, for the
 * first-person view-model registration below (all verified in pak0.pak).
 * weapon_grenades resolves to v_handgr (C "use grenades" view).
 */
const WEAPON_VIEW_FALLBACK: Record<string, string> = {
  weapon_supershotgun: 'models/weapons/v_shotg2/tris.md2',
  weapon_chaingun: 'models/weapons/v_chain/tris.md2',
  weapon_grenades: 'models/weapons/v_handgr/tris.md2',
  weapon_grenadelauncher: 'models/weapons/v_launch/tris.md2',
  weapon_rocketlauncher: 'models/weapons/v_rocket/tris.md2',
  weapon_hyperblaster: 'models/weapons/v_hyperb/tris.md2',
  weapon_railgun: 'models/weapons/v_rail/tris.md2',
  weapon_bfg: 'models/weapons/v_bfg/tris.md2',
};

/**
 * View-model lump for a weapon classname (game table first, C fallback for
 * the remnant arsenal). Null only for unknown classnames.
 */
export function viewModelForPickup(classname: string): string | null {
  return viewModelForWeapon(classname) ?? WEAPON_VIEW_FALLBACK[classname] ?? null;
}

/** World-model lump for a pickup classname (weapons via the game table + C fallback). */
export function worldModelForPickup(classname: string): string | null {
  return worldModelForWeapon(classname) ?? WEAPON_WORLD_FALLBACK[classname] ?? ITEM_WORLD_MODELS[classname] ?? null;
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
/** id pellet spread basis: r/u are world units at 8192 range. */

const REFIRE: Record<string, number> = {
  weapon_blaster: 0.25,
  weapon_shotgun: 0.9,
  weapon_machinegun: 0.1,
  // Lite throttle for the SP-remnant arsenal (C Weapon_Generic fire-frame
  // cadence at 10Hz: supershotgun ~10 ticks, launchers/railgun ~8-9, bfg
  // ~12, chaingun/hyperblaster bursts, hand grenades ~8). Base1 never grants
  // these in SP (all 1792 DM-only), so these only gate DM/synthetic use.
  weapon_supershotgun: 1.0,
  weapon_chaingun: 0.15,
  weapon_grenades: 0.8,
  weapon_grenadelauncher: 0.8,
  weapon_rocketlauncher: 0.9,
  weapon_hyperblaster: 0.15,
  weapon_railgun: 0.9,
  weapon_bfg: 1.2,
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
//
// Phase 0 single sim (BRAIN.md §15): the driver owns NO gameplay state.
// Monsters, barrels, bolts, explosions, debris, gibs, fuses and the player
// health pool live in `packages/server`; this driver renders from server
// state (snapshot/extraEntities) and forwards input (SV_PlayerFire). The
// old private sim (PlacedMonster[], parseExplosives/barrels, bolts,
// monsterFire, damageBarrel, stepBolts, driver door touch) is deleted.

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

/**
 * Enemy hitscan tracer length in world units (M7.1 face-flame fix).
 *
 * Monster return fire is hitscan (m_soldier.c soldier_fire): C draws NO beam
 * for it (only the railgun draws TE_RAILTRAIL) — just the muzzle flash, the
 * damage roll, and impact sparks. The old driver queued a full
 * muzzle→eye beam (up to ~1000u); at close range that beam ends in the
 * player's face and fills the screen. Now every enemy hitscan round draws
 * only a short muzzle-origin streak (muzzle + shot-dir × this length, same
 * 225 yellow) that NEVER reaches the eye, plus the small muzzle dlight.
 */
export const ENEMY_TRACER_LENGTH = 48;
/** Full-bright palette index for the blaster bolt beam (matches id's EF_BLASTER look). */
export const BLASTER_TRACER_COLOR = 225;
/**
 * Hitscan tracer color (shotgun/machinegun pellets + monster return fire).
 *
 * Single source of truth in `@q2/game` (`weapons.ts`): 225 (0xe1,
 * (255,147,0)) is the C-correct hitscan color; 208–214 is GREEN on the
 * engine palette (the reported green-laser bug) and banned via
 * `isGreenBoltColor`. Re-exported here so driver tests keep importing
 * from the play module.
 */
export { HITSCAN_TRACER_COLOR };
/**
 * Renders per 10Hz tick at the 60fps target: the yaw-lerp frac cadence
 * (entityAngles advances 1/6 of the prev→live arc per render, converging
 * by the next tick — monotonic, bounded, deterministic in tests).
 */
export const YAW_LERP_RENDERS_PER_TICK = 6;
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
  weapon_supershotgun: 18,
  weapon_machinegun: 6,
  weapon_chaingun: 32,
  weapon_grenades: 16,
  weapon_grenadelauncher: 17,
  weapon_rocketlauncher: 13,
  weapon_hyperblaster: 21,
  weapon_railgun: 19,
  weapon_bfg: 33,
};
export const VIEWMODEL_FIRE_FRAMES: Record<string, number> = {
  weapon_blaster: 5,
  weapon_shotgun: 8,
  weapon_supershotgun: 7,
  weapon_machinegun: 4,
  weapon_chaingun: 5,
  weapon_grenades: 1,
  weapon_grenadelauncher: 6,
  weapon_rocketlauncher: 5,
  weapon_hyperblaster: 6,
  weapon_railgun: 4,
  weapon_bfg: 9,
};

/**
 * Weapon_Generic frame bounds per weapon (p_weapon.c Weapon_* call sites:
 * Weapon_Generic(ent, ACTIVATE_LAST, FIRE_LAST, IDLE_LAST, DEACTIVATE_LAST)).
 * FIRE_FIRST = ACTIVATE_LAST+1, IDLE_FIRST = FIRE_LAST+1 (READY), FIRST drop
 * frame = IDLE_LAST+1. Blaster (4,8,52,55), Shotgun (7,18,36,39), SuperShotgun
 * (6,17,57,61), Machinegun (3,5,45,49), Chaingun (4,31,61,64), GrenadeLauncher
 * (5,16,59,64), RocketLauncher (4,12,50,54), HyperBlaster (5,20,49,53),
 * Railgun (3,18,56,61), BFG (8,32,55,58). Hand grenades run the custom
 * Weapon_Grenade (READY 16 = fire+1, throw run-up 1..15, wrap 48): the lite
 * (0,15,48,51) is the Generic-shaped equivalent. The driver walks gunframe
 * FIRE_FIRST..IDLE_FIRST+1 while firing, then holds IDLE_FIRST (READY) —
 * viewModel() reports the live gunframe, not a frozen fire frame.
 */
export interface GunBounds {
  activate: number;
  fire: number;
  idle: number;
  deactivate: number;
}

const GUN_BOUNDS: Record<string, GunBounds> = {
  weapon_blaster: { activate: 4, fire: 8, idle: 52, deactivate: 55 },
  weapon_shotgun: { activate: 7, fire: 18, idle: 36, deactivate: 39 },
  weapon_supershotgun: { activate: 6, fire: 17, idle: 57, deactivate: 61 },
  weapon_machinegun: { activate: 3, fire: 5, idle: 45, deactivate: 49 },
  weapon_chaingun: { activate: 4, fire: 31, idle: 61, deactivate: 64 },
  weapon_grenades: { activate: 0, fire: 15, idle: 48, deactivate: 51 },
  weapon_grenadelauncher: { activate: 5, fire: 16, idle: 59, deactivate: 64 },
  weapon_rocketlauncher: { activate: 4, fire: 12, idle: 50, deactivate: 54 },
  weapon_hyperblaster: { activate: 5, fire: 20, idle: 49, deactivate: 53 },
  weapon_railgun: { activate: 3, fire: 18, idle: 56, deactivate: 61 },
  weapon_bfg: { activate: 8, fire: 32, idle: 55, deactivate: 58 },
};

export function gunBoundsFor(classname: string): GunBounds {
  return GUN_BOUNDS[classname] ?? { activate: 4, fire: 8, idle: 52, deactivate: 55 };
}

/** Explosion kind (cl_tent.c): big barrel/func/target blast, grounded blast,
 * or the 4-frame blaster touch flash (ex_misc, smoke model). */
export type ExplosionKind = 'explosion1' | 'explosion2' | 'blaster';

/** Frames an explosion visual lives (100ms each, cl_tent.c frac stepping). */
export function explosionFrames(kind: ExplosionKind): number {
  return kind === 'blaster' ? 4 : kind === 'explosion2' ? 19 : 15;
}

/**
 * Trail/impact spark lifetime in server seconds. id's CL_BlasterParticles
 * fade in a fraction of a second; world-seeded particles (devroom torch
 * flame, born +Infinity) never expire.
 */
export const SPARK_TTL = 0.4;

/**
 * Impact-flash dlight window in server seconds. TE_BLASTER / TE_EXPLOSION1
 * are brief flashes (id adds a short yellow light on touch). The renderer's
 * own light ttl still bounds each add to ~2 renders.
 */
export const EXPLOSION_LIGHT_WINDOW = 0.1;

/** Pak lump for shootable barrels (g_misc.c SP_misc_explobox, origin at the box bottom). */
export const BARREL_MODEL = 'models/objects/barrels/tris.md2';
export const BARREL_SKIN = 'models/objects/barrels/skin.pcx';

/** Pak lump for dead soldiers (g_misc.c SP_misc_deadsoldier: the deadbod dude MD2). */
export const CORPSE_MODEL = 'models/deadbods/dude/tris.md2';
export const CORPSE_SKIN = 'models/deadbods/dude/dead1.pcx';

/** id PARTICLE_GRAVITY (client/cl_fx.c): ballistic spark falloff. */
const SPARK_GRAVITY = 40;

export type { ServerBolt as Bolt, ServerBarrel as Barrel, ServerGib as Gib, ServerDebris as Debris };

interface DoorSync {
  ent: Edict;
  /**
   * Rest origin the baked verts correspond to: mover pos1 for doors/buttons,
   * the lump origin (usually 0,0,0 for brush models) for func_trains. The
   * rendered offset is always `ent.origin - rest`, matching the C brush-model
   * convention (faces baked at mapper coords, shifted by the entity origin).
   */
  rest: Vec3;
  /**
   * Rest angles the baked verts correspond to (rotating doors only). The
   * rendered verts rotate about `rest` by `ent.angles - restAngles`.
   */
  restAngles: Vec3;
  /** True for func_door_rotating: sync rotates instead of translating. */
  rotates: boolean;
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
  readonly events: string[] = [];
  readonly changeTargets = new Set<string>();
  message = '';
  exited = false;
  /** Finish screen already mirrored from the server (event pushed once). */
  private finishShown = false;
  weapon: WeaponDef = WEAPON_BLASTER;
  shells = 0;
  bullets = 0;
  grenades = 0;
  cells = 0;
  rockets = 0;
  slugs = 0;
  readonly rand = mulberry32(0x51ab);
  private lastShotAt = -10;
  private doors: DoorSync[] = [];
  /** Live submodel face indices the graft appended (unique, for the test hook). */
  private graftedFaces: number[] = [];
  /** Brush models already stripped from the leaf facelists after blowing. */
  private freedBrushHidden = new Set<number>();
  /**
   * World trace for gameplay queries (shots, drops, use reach checks): the
   * server C-mask helper (SV_TraceFor, MASK_PLAYERSOLID_C) wrapped with the
   * solid brush clips (SV_ClipTrace) so func_explosive/func_wall block until
   * SV_RemoveBrushClip opens them. Phase 1 fold: no game-side mask-1
   * hookup remains in the driver path (setPmoveWorldFromBsp/bspTraceFor).
   *
   * Live monsters are NOT in this trace (includeMonsters false): the server
   * tick (monster locomotion on game.trace, bolts, explosions) runs on it,
   * and a mover always starts inside its own hull — with the monster pass on,
   * every sub-hull step reads allsolid and bodies freeze in place (see the
   * SV_ClipTrace doc). Shots resolve flesh through the state-based
   * bolt/pellet sweeps, never this trace.
   */
  private worldTrace: (start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => TraceResult;
  /**
   * Pmove body trace: worldTrace PLUS the live-monster hull pass
   * (SV_MonsterClipBox, C SV_ClipMoveToEntities SOLID_BBOX bodies), so the
   * player cannot walk through live enemies. Corpses never block (C Killed
   * sets SVF_DEADMONSTER — SV_MonsterClipBox drops dead/gibbed), dormant
   * TRIGGER_SPAWN bodies pass through until monster_triggered_spawn wakes
   * them (SOLID_NOT → SOLID_BBOX). Installed via setPmoveWorld; the monster
   * tick keeps the monster-free worldTrace above (split traces: pmove sees
   * monsters, monster locomotion never sees self).
   */
  private pmoveTrace: (start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => TraceResult;
  /**
   * Solid-aware point contents for the pmove world AND the server
   * P_WorldEffects sampler (game/p_view.c): `bspPointContentsFor` carries
   * the SOLID bit the legacy `bspContentsFor` dropped. The pmove vault
   * wall probe (`& CONTENTS_SOLID`) and the server drowning sampler read
   * through this; dry-land consumers test MASK_WATER only, so dry-land
   * traces stay bit-identical. Devroom has no water (always dry).
   */
  private worldContents: PointContentsFn = () => 0;
  /** C MASK_OPAQUE sight trace for monster visible() (ignores WINDOW glass). */
  private sightTrace: ((start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => TraceResult) | null = null;
  /** Muzzle flash expiry (server time) + world pos for the dlight/HUD flash. */
  private flashUntil = -10;
  private flashPos: Vec3 = v3();
  /** Muzzle dlight radius for the pending flash (id CL_MuzzleFlash 200+(rand&31)). */
  private flashIntensity = 200;
  /** One-shot pump gate: true only between a shot and its single drain. */
  private flashPending = false;
  /** Queued tracer beams (see TracerBeam): drained by pumpTracers(). */
  private tracerQueue: TracerBeam[] = [];
  /** Enemy muzzle flashes (200+(rand&31) yellow, drained via the dlight pump). */
  private enemyFlashes: Array<{ pos: Vec3; intensity: number }> = [];
  /** Last-tick monster health by edict num (drives kill/gib/hit synthesis). */
  private monHealth = new Map<number, number>();
  /** Monster edicts already reported gibbed/dead (id DEAD_DEAD is terminal). */
  private gibSeen = new Set<number>();
  private deadSeen = new Set<number>();
  /** misc_deadsoldier gib hits already surfaced (per-edict extra counter). */
  private corpseGibSeen = new Map<number, number>();
  /**
   * Tick-start monster yaw per edict (yaw-lerp prev snapshot) + renders
   * consumed this tick (frac numerator). Reset per step(), advanced per
   * entityAngles() render.
   */
  private yawPrev = new Map<number, number>();
  private yawRenders = new Map<number, number>();
  /** Last-tick live explosion count (drives the 'explosion' event). */
  private lastExplosions = 0;
  /** Last-tick freed-barrel count (drives the 'barrel' event). */
  private lastBarrelsDead = 0;
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
   * Lower/raise switch (p_weapon.c Weapon_Generic WEAPON_DROPPING /
   * WEAPON_ACTIVATING + ChangeWeapon): true from selectWeapon (or a
   * first-pickup auto-switch) until the new gun reaches READY. Fire is
   * blocked throughout (see handleAttack). `pendingWeapon` is the gun being
   * raised (swapped in at the drop end), `dropBounds` the OUTGOING gun's
   * bounds (C drops the old gun's DEACTIVATE range), `raising` false while
   * lowering / true while raising 0..ACTIVATE_LAST.
   */
  private switching = false;
  private pendingWeapon: WeaponDef | null = null;
  private dropBounds: GunBounds | null = null;
  private raising = false;
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
      // Phase 1 fold (BRAIN.md §15): every driver trace goes through the
      // server C-mask helpers — SV_TraceFor (MASK_PLAYERSOLID_C, the mask
      // base1's clip decks and glass need) wrapped with the brush clips, and
      // SV_DropTraceFor (MASK_MONSTERSOLID) for spawn grounding. The
      // game-side mask-1 hookup (setPmoveWorldFromBsp/bspTraceFor) is gone
      // from the driver path (it dropped through clip floors into the void).
      this.worldTrace = SV_ClipTrace(this.server, SV_TraceFor(built.map));
      this.pmoveTrace = SV_ClipTrace(this.server, SV_TraceFor(built.map), -1, true);
      this.sightTrace = SV_TraceFor(built.map, MASK_OPAQUE_C);
      // Solid-aware contents (water.ts bspPointContentsFor, NOT the legacy
      // solid-less bspContentsFor): the pmove vault probe (`& CONTENTS_SOLID`)
      // and the server P_WorldEffects sampler both read through this. With
      // the legacy hook the browser never categorized water (no drowning —
      // SV_WorldContents stayed null so the tick sampler early-returned) and
      // the vault stayed inert (the SOLID probe is always false without the
      // bit). Dry-land consumers test MASK_WATER only: bit-identical there.
      this.worldContents = bspPointContentsFor(built.map);
      setPmoveWorld(this.pmoveTrace, this.worldContents);
      // Skill latch (id CVAR_LATCH, g_spawn.c): the server filters spawns,
      // damage scale, and the roster from st.skill — set it before spawning.
      SV_SetSkill(this.server, getSkill());
      SV_SpawnEntities(
        this.server,
        built.map.entities,
        (model) => modelBounds(built.map, model),
        SV_DropTraceFor(built.map),
      );
      this.playerEdict = spawnEdict({ classname: 'player' });
      this.spawnFromLump(built.map);
      this.snapshotDoorBases();
      // Brush faces are invisible to the stock traversal (submodel faces sit
      // in no node range or leaf list): graft movers/trains/func_walls into
      // the leaves they intersect so doors render CLOSED at spawn and glass
      // renders at all. Must run after snapshotDoorBases (same faces).
      this.graftBrushModels();
      for (const e of this.server.entities) {
        if (e.classname === 'target_changelevel' && e.targetname) this.changeTargets.add(e.targetname);
      }
    } else {
      this.source = 'devroom';
      this.map = null;
      this.mini = createDevroom();
      this.worldTrace = devroomTrace;
      // Same split as the pak path (uniform single-sim semantics): devroom
      // synthetics (SV_SpawnMonster SOLID_BBOX) block the body, never the
      // monster tick (which runs on worldTrace).
      this.pmoveTrace = SV_ClipTrace(this.server, devroomTrace, -1, true);
      setPmoveWorld(this.pmoveTrace, this.worldContents);
      this.playerEdict = spawnEdict({ classname: 'player' });
      this.pm.origin = v3(-168, 0, 32);
      this.pm.velocity = v3();
      this.spawnPoints = [{ origin: v3(-168, 0, 32), yaw: 0 }];
    }
    this.playerEdict.origin = v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]);
    // World-seeded particles predate the driver: they never expire.
    while (this.particleBorn.length < this.mini.particles.length) this.particleBorn.unshift(Infinity);
    while (this.particleVel.length < this.mini.particles.length) this.particleVel.unshift(null);
    while (this.particleTtl.length < this.mini.particles.length) this.particleTtl.unshift(Infinity);
    this.oldview = v3(this.pm.viewAngles[0], this.pm.viewAngles[1], this.pm.viewAngles[2]);
    this.gunframe = gunBoundsFor(this.weapon.classname).fire + 1;
    this.syncAmmo();
    this.updateMixerListener();
    this.monHealth = new Map(this.server.monsters.map((m) => [m.edict.num, m.state.health]));
    this.yawPrev = new Map(this.server.monsters.map((m) => [m.edict.num, ((m.state.yaw % 360) + 360) % 360]));
    this.lastExplosions = this.server.explosions.length;
    this.lastBarrelsDead = this.server.barrels.filter((b) => b.edict.freed).length;
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
      // Single duck state (Phase 3): PM_CheckDuck owns PMF_DUCKED. The
      // driver only asserts the flag while the hold bit is down (immediate
      // engage on press, including the first tick when ground is not yet
      // categorized) and never clears it — release flows through
      // PM_CheckDuck's headroom-checked stand-up, so letting go under a low
      // ceiling keeps the hull ducked (C PM_CheckDuck semantics). Clearing
      // here would pre-empt that check and stand up anywhere, unconditionally.
      if (isDuckHeld(gcmd)) this.pm.pmFlags |= PMF_DUCKED;
      pmoveFull(this.pm, gcmd);
    }
    this.playerEdict.origin = v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]);
    for (const m of this.server.movers) this.moverStates.set(m, m.state);
    // Yaw-lerp prev snapshot: tick-start yaws + zeroed render counts (the
    // entityAngles frac runs 1/6..6/6 across this tick's renders).
    for (const m of this.server.monsters) {
      this.yawPrev.set(m.edict.num, ((m.state.yaw % 360) + 360) % 360);
      this.yawRenders.set(m.edict.num, 0);
    }
    // Phase 0 single sim: the server owns ALL gameplay state at 10Hz —
    // monster think (C cadence fire resolution), bolts, fuses, debris/gibs,
    // explosions, monster door touches. The driver only moves its own body
    // (above) and renders server state below.
    SV_Tick(this.server, dt, {
      player: {
        pos: v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]),
        mins: v3(this.pm.mins[0], this.pm.mins[1], this.pm.mins[2]),
        maxs: v3(this.pm.maxs[0], this.pm.maxs[1], this.pm.maxs[2]),
        view: this.pm.viewheight,
      },
      trace: this.worldTrace,
      sightTrace: this.sightTrace ?? this.worldTrace,
      // Solid-aware contents for the P_WorldEffects sampler: without this
      // the tick falls back to SV_WorldContents (null — no map was ever
      // wired through SV_SetPmoveWorldFromBsp in the driver path) and
      // drowning never runs in the browser.
      contents: this.worldContents,
      nav: null,
      rand: this.rand,
    });
    // Pusher carry (id g_phys.c SV_Push rider pass): the platform JUST moved
    // in SV_Tick, so a body standing on it (groundEntity == pusher, linked by
    // pmove's ground trace against the mover clips) rides along NOW — before
    // touches/snapshot/render read the body for this tick. This is the C
    // SV_Physics_Pusher-then-client order (movers displace, riders follow,
    // then the frame is presented). Carrying here (current tick's
    // moverDeltas) ends the step exact; carrying pre-pmove instead would lag
    // one tick behind the platform (measured: -4u at the 40u/s train speed).
    // Without this the platform slides out from under a standing rider and
    // the next ground trace misses — the exit-lift fall-through (the DRIVER
    // path never applied the displacement M7.4 proved server-side).
    SV_CarryRiders(this.server, [
      {
        origin: this.pm.origin,
        mins: this.pm.mins,
        maxs: this.pm.maxs,
        groundEntity: this.pm.groundEntity,
        onGround: this.pm.onGround,
      },
    ]);
    this.playerEdict.origin = v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]);

    this.playerEdict.origin = v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]);
    SV_TouchTriggersAt(this.server, 'player', this.playerEdict);
    // Door touch is server-owned (id Touch_DoorTrigger): the driver's
    // competing checkDoorTouch is deleted; this call opens doors the same
    // way the WIRE bot does (expanded 60in x/y volume, NOMONSTER gated).
    SV_TouchDoorsAt(this.server, {
      origin: v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]),
      mins: v3(this.pm.mins[0], this.pm.mins[1], this.pm.mins[2]),
      maxs: v3(this.pm.maxs[0], this.pm.maxs[1], this.pm.maxs[2]),
    }, 'player');
    // Button touch (id button_touch, g_func.c): walking into a touchable
    // func_button (no targetname, no health) presses it — C button_fire,
    // a no-op while the button is UP/TOP. Buttons own no trigger volumes,
    // so the door path above never reaches them.
    SV_TouchButtonsAt(this.server, {
      origin: v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]),
      mins: v3(this.pm.mins[0], this.pm.mins[1], this.pm.mins[2]),
      maxs: v3(this.pm.maxs[0], this.pm.maxs[1], this.pm.maxs[2]),
    }, 'player');

    this.syncDoors();
    this.hideFreedBrushes();
    this.updateBob();
    this.stepGunframe();
    this.emitDoorSounds();
    // Exit/finish scan runs after every firing path (point + brush triggers,
    // buttons): each pushes the relay targetname into firedThisTick, and the
    // server owns the finished state (SV_FinishLevel on target_changelevel /
    // the end-lift button) — the driver only mirrors it into message/HUD.
    for (const t of this.server.firedThisTick) {
      if (this.changeTargets.has(t) && !this.exited) {
        this.exited = true;
        this.events.push('exit');
      }
    }
    // First tick with server-owned finished state: freeze the stats screen
    // (snapshot counters, so post-finish kills don't move it). The real exit
    // (t37) also sets exited above (invincible, like the old message path);
    // the end-lift press ('lift') only shows the screen — the ride continues.
    if (this.server.finished && !this.finishShown) {
      this.finishShown = true;
      if (this.server.finishReason !== 'exit') this.events.push('finished');
    }
    if (this.server.finished) this.message = formatFinishMessage(this.server);
    this.stepSparks(dt);
    this.checkPickups();
    this.handleAttack(cmd);
    // E-use (driver `use` key / right-mouse): press the aimed func_button
    // within reach inside the facing cone (C button_use semantics via
    // SV_UseButton: UP/TOP no-op, wait/-1 holds TOP, only the aimed button
    // fires). The exit lift is un-ridable without its *13/*34 call buttons.
    if ((cmd.buttons & BUTTON_USE) !== 0) this.pressUseButton();
    // Single drain point: server event queues from the tick AND the fire
    // above (muzzles, tracers, sparks, sounds) become driver cosmetics here.
    this.drainServerEvents();
    this.expireSounds();
    this.updateMixerListener();
    if (this.ps.health <= 0 && this.deadUntil > 0 && this.server.time >= this.deadUntil) {
      this.respawn();
    }
  }

  /**
   * Status-line write (all HUD one-liners funnel here): once the server owns
   * the finished state the stats screen stays put — kills, pickups and empty
   * clicks no longer overwrite it. Death/respawn write directly (more urgent
   * / clears the screen for the new life).
   */
  private setMessage(s: string): void {
    if (!this.server.finished) this.message = s;
  }

  /**
   * Mirror the authoritative server health pool into HUD state, synthesizing
   * the pain/death edges the old driver-side damage path used to emit
   * (pain event + sound, death event + message + 2s respawn timer).
   */
  private syncHealthFromServer(): void {
    const h = this.server.playerHealth;
    if (h < this.ps.health) {
      this.ps.health = h;
      if (!this.exited) {
        this.events.push('pain');
        // C P_DamageFeedback pain band (p_view.c): health<25→25, <50→50,
        // <75→75 else 100; r = 1+(rand&1); the `*` is the C client
        // sexed-sound prefix, resolved here to the default male lump.
        const l = h < 25 ? 25 : h < 50 ? 50 : h < 75 ? 75 : 100;
        const r = 1 + ((this.rand() * 2) | 0);
        this.emitSound(`player/male/pain${l}_${r}.wav`, v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]!));
      }
    } else if (h > this.ps.health) {
      this.ps.health = h;
    }
    if (this.ps.health <= 0 && this.deadUntil <= 0) {
      this.ps.health = 0;
      this.message = 'YOU DIED — respawning…';
      this.events.push('death');
      // C player_die (p_client.c): gibbed past -40hp (udeath only), else
      // the sexed *deathN (rand()%4+1) — resolved to the male lump here.
      const snd = h < -40 ? 'misc/udeath.wav' : `player/male/death${1 + ((this.rand() * 4) | 0)}.wav`;
      this.emitSound(snd, v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]!));
      this.deadUntil = this.server.time + 2;
    }
  }

  /**
   * Consume the server's visual/audio event queues into driver cosmetics:
   * muzzle dlights (player flash window + enemy flashes), tracer beams,
   * particle bursts, positional sounds — plus kill/gib/hit/explosion/barrel
   * event synthesis from server state transitions (tests assert these).
   */
  private drainServerEvents(): void {
    // Monster state transitions → kill/gib/hit (replaces painMonster).
    for (const m of this.server.monsters) {
      const prev = this.monHealth.get(m.edict.num) ?? m.state.health;
      if (m.state.gibbed) {
        if (!this.gibSeen.has(m.edict.num)) {
          this.gibSeen.add(m.edict.num);
          this.events.push('gib');
          this.setMessage(`${m.state.kind} minced`);
        }
      } else if (m.state.dead) {
        if (!this.deadSeen.has(m.edict.num)) {
          this.deadSeen.add(m.edict.num);
          this.events.push('kill');
          this.setMessage(`${m.state.kind} down`);
        }
      } else if (m.state.health < prev) {
        this.events.push('hit');
      }
      this.monHealth.set(m.edict.num, m.state.health);
    }
    // New explosions → 'explosion' (spawnExplosion + TE_BLASTER both land here).
    if (this.server.explosions.length > this.lastExplosions) this.events.push('explosion');
    this.lastExplosions = this.server.explosions.length;
    // Newly freed barrels → 'barrel' (barrel_delay fuse latched).
    const barrelsDead = this.server.barrels.filter((b) => b.edict.freed).length;
    if (barrelsDead > this.lastBarrelsDead) this.events.push('barrel');
    this.lastBarrelsDead = barrelsDead;
    // misc_deadsoldier overkill mince (C misc_deadsoldier_die): the server
    // counts gib hits per edict (the corpse persists and re-gibs — no
    // G_FreeEdict). Surface each new mince as a 'gib' event like the
    // monster path above, so driver tests pin it without reading the gib
    // roster directly.
    for (const e of this.server.entities) {
      if (e.classname !== 'misc_deadsoldier') continue;
      const hits = Number.parseInt(e.extra['gibHits'] ?? '0', 10);
      const seen = this.corpseGibSeen.get(e.num) ?? 0;
      if (Number.isFinite(hits) && hits > seen) {
        this.corpseGibSeen.set(e.num, hits);
        this.events.push('gib');
        this.setMessage('corpse minced');
      }
    }
    // Player damage dealt by the server tick/fire → pain/death edges.
    this.syncHealthFromServer();
    // Muzzles: player flash window + enemy flashes (one-shot dlight pump).
    for (const mz of SV_DrainMuzzles(this.server)) {
      if (mz.foe) {
        this.enemyFlashes.push({ pos: v3(mz.pos[0], mz.pos[1], mz.pos[2]), intensity: mz.intensity });
      } else {
        this.flashUntil = mz.born + 0.09;
        this.flashPos = v3(mz.pos[0], mz.pos[1], mz.pos[2]);
        this.flashIntensity = mz.intensity;
        this.flashPending = true;
      }
    }
    // Tracers: short muzzle streaks into the renderer queue.
    for (const t of SV_DrainTracers(this.server)) {
      this.queueTracer(
        v3(t.origin[0], t.origin[1], t.origin[2]),
        v3(t.dir[0], t.dir[1], t.dir[2]),
        t.color,
        t.length,
      );
    }
    // Sparks: impact/trail/boom bursts into the particle pool.
    for (const s of SV_DrainSparks(this.server)) {
      if (s.vel) this.pushBallisticSpark(v3(s.pos[0], s.pos[1], s.pos[2]), v3(s.vel[0], s.vel[1], s.vel[2]), s.color, s.ttl);
      else this.pushColoredSpark(v3(s.pos[0], s.pos[1], s.pos[2]), s.color, s.ttl);
    }
    // Sounds: positional shots, impacts, gibs, booms.
    let monshot = false;
    for (const s of SV_DrainSounds(this.server)) {
      this.emitSound(s.name, v3(s.pos[0], s.pos[1], s.pos[2]));
      if (
        s.name === 'soldier/solatck1.wav' ||
        s.name === 'soldier/solatck2.wav' ||
        s.name === 'soldier/solatck3.wav' ||
        s.name === 'gunner/gunatck2.wav' ||
        s.name === 'gunner/gunatck3.wav' ||
        s.name === 'infantry/infatck1.wav' ||
        s.name === 'monster/melee.wav'
      ) {
        monshot = true;
      }
    }
    if (monshot) this.events.push('monshot');
  }

  snapshot(serverTime: number): Snapshot {
    const entities: Snapshot['entities'] = [
      {
        id: PLAYER_ID,
        origin: [this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]!],
        velocity: [this.pm.velocity[0]!, this.pm.velocity[1]!, this.pm.velocity[2]!],
        // Seed for CL_PredictPmove: duck/hull must replay from authoritative
        // state or prediction diverges while crouched (Phase 3 report).
        pmFlags: this.pm.pmFlags,
        grounded: this.pm.groundEntity !== -1,
      },
    ];
    // Server-authoritative monsters (Phase 0 single sim): corpses persist
    // (id keeps the dead edict rendering its last death frame); gibbed
    // bodies (DEAD_DEAD) leave the snapshot. Dormant TRIGGER_SPAWN bodies
    // are SVF_NOCLIENT in C (monster_triggered_start) and stay out until
    // a use wakes them.
    for (const m of this.server.monsters) {
      if (m.state.gibbed || (m.triggered && !m.woken)) continue;
      entities.push({
        id: m.edict.num,
        origin: [m.edict.origin[0]!, m.edict.origin[1]!, m.edict.origin[2]!],
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
    // Server-owned barrels (live only): render base sits at the hull
    // bottom — misc_explobox origins already are the box bottom (the barrel
    // MD2 pivot is the box bottom too). func_explosive NEVER renders here:
    // it is brush geometry (the *20 glass window, the *30 slab), grafted
    // into the world leaves like doors/func_walls so it renders CLOSED at
    // spawn and disappears when blown — a barrel MD2 proxy would
    // triple-render the spawn room (the reported "3 barrels" bug).
    for (const b of this.server.barrels) {
      if (b.edict.freed || b.isFunc) continue;
      const baseZ = b.origin[2]!;
      out.push({
        origin: [b.origin[0]!, b.origin[1]!, baseZ],
        angles: [0, 0, 0],
        model: this.models?.barrel ?? 0,
        skin: this.models?.barrelSkin ?? 0,
        frame: 0,
      });
    }
    // Server-owned bolts (player + foe): flight orientation rides along as
    // yaw/pitch (id convention pitch positive = down).
    for (const bolt of this.server.bolts) {
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
      // Server-owned explosion visuals (pruned server-side by frame life).
      // RF_FRAMELERP smoothing: oldframe = previous frame, backlerp =
      // 1 - frac (cl_tent.c frac stepping), so frames interpolate instead
      // of popping; alpha fades over the life (ex_poly 16-frame alpha,
      // ex_misc linear) so the alias backend screen-doors to translucent.
      // Freed-sky bolts never reach this list (the server frees them
      // silently with no explosion record), so no remnant renders here.
      for (const e of this.server.explosions) {
        const age = this.server.time - e.born;
        const frames = explosionFrames(e.kind);
        if (age < 0 || age >= frames * 0.1) continue;
        const f = Math.floor(age / 0.1);
        const frac = age / 0.1 - f;
        // TE_EXPLOSION1/2 render the r_explode MD2 (cl_mod_explo4, 15f/19f);
        // TE_BLASTER's 4f ex_misc renders the explode MD2 (cl_mod_explode).
        const isBlast = e.kind === 'blaster';
        const alpha = isBlast
          ? 1 - age / EXPLOSION_LIGHT_WINDOW
          : (16 - f) / 16;
        out.push({
          origin: [e.pos[0]!, e.pos[1]!, e.pos[2]!],
          angles: [0, e.yaw, 0],
          model: isBlast ? this.models.blast : this.models.explode,
          skin: isBlast ? this.models.blastSkin : this.models.explodeSkin,
          frame: e.baseframe + f,
          oldframe: e.baseframe + Math.max(0, f - 1),
          backlerp: Math.max(0, Math.min(1, 1 - frac)),
          alpha: Math.max(0, Math.min(1, alpha)),
        });
      }
      // Server-owned debris/gibs (SV_Physics_Toss-lite, stepped in SV_Tick).
      for (const d of this.server.debris) {
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
      for (const g of this.server.gibs) {
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
      // DM-only edicts (spawnflags 1792 = NOT_EASY|NOT_MEDIUM|NOT_HARD) are
      // inhibited at every SP skill: the server skips them at spawn AND the
      // driver re-checks the lump spawnflags from extra (the numeric
      // spawnflags field is C-stripped post-spawn, so extra is authoritative).
      for (const e of this.server.entities) {
        if (e.freed) continue;
        if (skillInhibits(parseSpawnflags(e.extra ?? {}), getSkill())) continue;
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
      // Dead soldiers (misc_deadsoldier, g_misc.c SP_misc_deadsoldier): the
      // lump pose (spawnflags bits -> deadbod dude MD2 frame, first match
      // wins) at the lump origin + lump yaw. Read from the server roster
      // (plain edicts) so skill filtering applies; corpses persist (never
      // freed — the server spawn case keeps them as permanent scenery).
      if (this.models.corpse >= 0) {
        for (const e of this.server.entities) {
          if (e.freed || e.classname !== 'misc_deadsoldier') continue;
          out.push({
            origin: [e.origin[0]!, e.origin[1]!, e.origin[2]!],
            angles: [0, parseFloat(e.extra['angle'] ?? '0', 0), 0],
            model: this.models.corpse,
            skin: this.models.corpseSkin,
            frame: deadsoldierFrameForSpawnflags(parseSpawnflags(e.extra ?? {})),
          });
        }
      }
      // Ships ride the server trains (func_train_find + train_next): the
      // position is authoritative and moves every tick, so a parked lump
      // origin would desync within a second. Submitted from the LIVE train
      // origin every frame, unconditionally (C hides unstarted ships behind
      // SVF_NOCLIENT, but the flybys are ambient scenery — a missed
      // trigger_always must never hide them view-side; all three base1
      // flybys are trigger_always-started anyway). Entity submits bypass
      // PVS/frustum culling in the renderer (z-test only), so a flyby
      // renders wherever its loop takes it.
      if (this.models.ship >= 0) {
        for (const tr of this.server.trains) {
          if (!tr.ship) continue;
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
    const skill = getSkill();
    let n = 0;
    for (const e of this.server.entities) {
      if (e.freed) continue;
      if (skillInhibits(parseSpawnflags(e.extra ?? {}), skill)) continue;
      if (this.models.items[e.classname]) n++;
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
      this.setMessage('NO WEAPON');
      this.events.push('empty');
      return;
    }
    const def = findWeapon(classname);
    if (!def) return;
    // Re-selecting the raised gun is a no-op (C ChangeWeapon same-weapon
    // early-out). Anything else lowers the old gun first (WEAPON_DROPPING
    // from DEACTIVATE_FIRST of the OUTGOING bounds) and raises the new one
    // (WEAPON_ACTIVATING 0..ACTIVATE_LAST, C ChangeWeapon) to READY — fire
    // stays blocked until then (see handleAttack). The pickup auto-switch
    // funnels here too, so the gunframe can never go stale across a swap
    // (the old path assigned this.weapon directly and kept it).
    //
    // Feedback: the 'weapon' event fires at the drop start and the status
    // line names the incoming gun. There is no C switch sound (ChangeWeapon
    // is silent; the pickup path already played items/pkup.wav), so none is
    // fabricated here. viewModel() keeps reporting the live gunframe — drop
    // and raise frames are real v_weap frames, never a frozen pose.
    //
    // Deviation (≤2 ticks): C queues newweapon through a firing gun and only
    // starts the drop at READY; the lite starts the drop at once (firing is
    // a 2-tick anim here, queuing would only delay the swap).
    if (!this.switching && this.weapon.classname === classname) return;
    this.pendingWeapon = def;
    this.dropBounds = gunBoundsFor(this.weapon.classname);
    this.switching = true;
    this.raising = false;
    this.firing = false;
    this.gunframe = this.dropBounds.idle + 1; // DEACTIVATE_FIRST
    this.setMessage(classname.replace(/_/g, ' '));
    this.events.push('weapon');
  }

  /**
   * True while a lower/raise weapon switch runs (drop or raise leg): fire is
   * blocked and the gun is not yet READY (test hook + the phase3/H setup
   * waits below).
   */
  get weaponSwitching(): boolean {
    return this.switching;
  }

  hasWeapon(classname: string): boolean {
    return this.ps.weapons.includes(classname);
  }

  get aliveMonsters(): number {
    return this.server.monsters.filter((m) => !m.state.dead).length;
  }

  /** Test hook: live server monsters (replaces the old PlacedMonster[] sim). */
  get monsters(): ServerMonster[] {
    return this.server.monsters;
  }

  /** Test hook: live server bolts (replaces the old driver bolt sim). */
  get bolts(): ServerBolt[] {
    return this.server.bolts;
  }

  /** Test hook: live server barrels (replaces parseExplosives/barrels). */
  get barrels(): ServerBarrel[] {
    return this.server.barrels;
  }

  /** Test hook: live server explosions (replaces the driver flash list). */
  get explosions(): ServerExplosion[] {
    return this.server.explosions;
  }

  /** Test hook: server debris chunks (replaces the driver toss sim). */
  get debris(): ServerDebris[] {
    return this.server.debris;
  }

  /** Test hook: server gib chunks (replaces the driver mince sim). */
  get gibs(): ServerGib[] {
    return this.server.gibs;
  }

  /** Live fuse count (server-owned barrel fuses / target_explosion delays). */
  get pendingFuses(): number {
    return this.server.fuses.length;
  }

  /** Skinnum stashed on a server monster edict (m_soldier.c SP_ funcs). */
  monsterSkin(m: ServerMonster): number {
    const raw = m.edict.extra['skinnum'] ?? '2';
    const v = Number.parseInt(raw, 10);
    return Number.isFinite(v) ? v : 2;
  }

  get playerHealth(): number {
    return this.ps.health;
  }

  /**
   * Seconds of air left (P_WorldEffects air supply, game/p_view.c): 12 at
   * grace, draining toward 0 while the head is under (waterlevel 3), then
   * the C drowning ramp. HUD air-indicator state, exposed only (no HUD
   * text owned here).
   */
  get playerAirLeft(): number {
    return this.server.playerAirLeft;
  }

  /**
   * HUD-exposed suit seconds (rebreather / envirosuit, game/g_items.c +
   * p_view.c): server-authoritative remaining time, expose only — the HUD
   * lane owns rendering, exactly like playerAirLeft above.
   */
  get playerBreatherLeft(): number {
    return this.server.playerBreatherLeft;
  }

  get playerEnviroLeft(): number {
    return this.server.playerEnviroLeft;
  }

  /**
   * Positional sound names emitted this session, in order (test hook):
   * the P_WorldEffects enter/exit/gasp/burn/drown hooks land here via the
   * server sound drain, so driver-loop tests can pin them without touching
   * the mixer or the HUD.
   */
  readonly heardSounds: string[] = [];

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
    if (this.switching) {
      if (!this.raising) {
        // WEAPON_DROPPING: walk the outgoing DEACTIVATE range; reaching
        // DEACTIVATE_LAST swaps the gun in (C ChangeWeapon) and starts the
        // raise at frame 0 (C WEAPON_ACTIVATING).
        const drop = this.dropBounds ?? gunBoundsFor(this.weapon.classname);
        if (this.gunframe >= drop.deactivate) {
          this.weapon = this.pendingWeapon ?? this.weapon;
          this.pendingWeapon = null;
          this.dropBounds = null;
          this.raising = true;
          this.gunframe = 0;
        } else {
          this.gunframe++;
        }
        return;
      }
      // WEAPON_ACTIVATING: 0..ACTIVATE_LAST, then READY at IDLE_FIRST.
      const b = gunBoundsFor(this.weapon.classname);
      if (this.gunframe >= b.activate) {
        this.switching = false;
        this.pendingWeapon = null;
        this.gunframe = b.fire + 1;
      } else {
        this.gunframe++;
      }
      return;
    }
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
    const m = this.server.monsters.find((m) => m.edict.num === id);
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
    const m = this.server.monsters.find((m) => m.edict.num === id);
    if (!m || !this.models) return null;
    if (m.state.kind === 'gunner') return { model: this.models.gunner, skin: this.models.gunnerSkin };
    // Infantry renders its own MD2 (m_infantry.c frames); falling back to
    // the soldier mesh here played infantry frame numbers on soldier
    // geometry (wrong-pose reports) — the handles above fix that.
    if (m.state.kind === 'infantry') return { model: this.models.infantry, skin: this.models.infantrySkin };
    return { model: this.models.monster, skin: this.soldierSkinFor(this.monsterSkin(m)) };
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
   *
   * Yaw interpolates between the last two 10Hz ticks (client/cl_ents.c
   * LerpAngle, q_shared.c): prev-tick yaw → live yaw over the renders of
   * the current tick (YAW_LERP_RENDERS_PER_TICK renders at the 60fps
   * target), monotonic and bounded by the live yaw. Position stays
   * predictor-owned (Host Predictor); frame vertex lerp rides the
   * explosion oldframe/backlerp path (RF_FRAMELERP, frozen §6 Entity —
   * no contract change).
   */
  entityAngles(id: number): [number, number, number] | null {
    const m = this.server.monsters.find((mm) => mm.edict.num === id);
    if (!m) return null;
    const curr = ((m.state.yaw % 360) + 360) % 360;
    const prev = this.yawPrev.get(id) ?? curr;
    const n = (this.yawRenders.get(id) ?? 0) + 1;
    this.yawRenders.set(id, n);
    return [0, lerpAngle(prev, curr, Math.min(1, n / YAW_LERP_RENDERS_PER_TICK)), 0];
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

  /** Drain pending enemy muzzle flashes (pumped as yellow dlights). */
  drainEnemyMuzzle(): Array<{ pos: Vec3; intensity: number }> {
    if (this.enemyFlashes.length === 0) return [];
    const out = this.enemyFlashes;
    this.enemyFlashes = [];
    return out;
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
    return String(this.ammoFor(this.weapon.ammoKind));
  }

  /** Compat counter for the selected weapon's ammo kind (shells/bullets legacy). */
  private ammoFor(kind: string): number {
    switch (kind) {
      case 'shells':
        return this.shells;
      case 'bullets':
        return this.bullets;
      case 'grenades':
        return this.grenades;
      case 'cells':
        return this.cells;
      case 'rockets':
        return this.rockets;
      case 'slugs':
        return this.slugs;
      default:
        return this.ps.ammo[kind] ?? 0;
    }
  }

  /** Write-through ammo grant (PlayerState + compat counters together). */
  private setAmmo(kind: string, v: number): void {
    this.ps.ammo[kind] = v;
    this.syncAmmo();
  }

  /** Compat sync: legacy shells/bullets (+ grenades/cells/rockets/slugs) mirror PlayerState ammo. */
  private syncAmmo(): void {
    this.shells = this.ps.ammo['shells'] ?? 0;
    this.bullets = this.ps.ammo['bullets'] ?? 0;
    this.grenades = this.ps.ammo['grenades'] ?? 0;
    this.cells = this.ps.ammo['cells'] ?? 0;
    this.rockets = this.ps.ammo['rockets'] ?? 0;
    this.slugs = this.ps.ammo['slugs'] ?? 0;
  }

  private emitSound(name: string, origin: Vec3, attn = ATTN_NORM, masterVol = 1): number {
    this.heardSounds.push(name);
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
    const eye = v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]! + this.pm.viewheight);
    this.mixer.setListener(eye, right);
  }

  private emitDoorSounds(): void {
    for (const m of this.server.movers) {
      const prev = this.moverStates.get(m);
      if (prev !== undefined && prev !== m.state && (m.state === 'going_up' || m.state === 'going_down')) {
        // Real pak names (C g_func.c): sliders/rotators/secret doors all
        // default to doors/dr1_strt.wav; buttons to switches/butn2.wav.
        this.emitSound(
          m.ent.classname === 'func_button' ? 'switches/butn2.wav' : 'doors/dr1_strt.wav',
          m.ent.origin,
        );
        this.events.push('door');
      }
    }
  }

  /** Apply damage to the player; death parks a 2s respawn timer. */
  damagePlayer(dmg: number, from?: Vec3 | [number, number, number]): void {
    if (this.playerDead || this.exited) return;
    void from;
    // Authoritative pool lives server-side (skill-scaled there); the driver
    // only mirrors it and synthesizes the pain/death edges.
    SV_DamagePlayer(this.server, dmg);
    this.syncHealthFromServer();
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
    SV_SetPlayerHealth(this.server, this.ps.maxHealth);
    this.ps.health = this.ps.maxHealth;
    // C p_client.c respawn: breather/enviro framenums clear with the rest.
    this.ps.breatherUntil = 0;
    this.ps.enviroUntil = 0;
    SV_SetPlayerSuit(this.server, 0, 0);
    this.deadUntil = -1;
    // A new life is vulnerable again: without this, a completed level left
    // `exited` set forever (spurious or real), and damagePlayer's
    // `exited` guard made the player permanently invincible. The finished
    // screen clears with it (the new life re-opens the level).
    this.exited = false;
    this.finishShown = false;
    SV_ClearFinished(this.server);
    this.message = '';
    this.events.push('respawn');
    this.playerEdict.origin = v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]);
  }

  /** Walk-over pickups: item/weapon/ammo edicts grant via pickupItem.
   * Skill-inhibited (DM-only 1792 at every SP skill) and freed edicts are
   * skipped, mirroring extraEntities/livePickupCount (spawnflags read from
   * the lump dict in extra — the numeric field is C-stripped post-spawn). */
  private checkPickups(): void {
    if (this.playerDead) return;
    const px = this.pm.origin[0]!;
    const py = this.pm.origin[1]!;
    const pz = this.pm.origin[2]!;
    let healed = false;
    const skill = getSkill();
    for (const e of this.server.entities) {
      if (e.freed) continue;
      if (skillInhibits(parseSpawnflags(e.extra ?? {}), skill)) continue;
      const c = e.classname;
      if (!c.startsWith('item_') && !c.startsWith('weapon_') && !c.startsWith('ammo_')) continue;
      const dx = Math.abs(px - e.origin[0]!);
      const dy = Math.abs(py - e.origin[1]!);
      const dz = pz - e.origin[2]!;
      if (dx > 40 || dy > 40 || dz < -24 || dz > 64) continue;
      // C Pickup_Weapon (SP): the FIRST of a kind becomes newweapon (the
      // ChangeWeapon lower/raise); re-pickups only top the ammo gift. Read
      // ownership BEFORE the grant so only genuinely new guns switch.
      const hadWeapon = c.startsWith('weapon_') && this.ps.weapons.includes(c);
      const res = pickupItem(this.ps, c, this.server.time);
      if (!res.picked) continue;
      e.freed = true;
      healed = true;
      // id Touch_Item: a successful grab fires the item's target once
      // (G_UseTargets, ITEM_TARGETS_USED) — base1's shotgun fires t55 and
      // wakes the two TRIGGER_SPAWN soldiers. Once-ever per edict (the
      // server tracks the same bit on its path via SV_ConsumePickup).
      if (e.target && e.extra['targetsUsed'] === undefined) {
        e.extra['targetsUsed'] = '1';
        SV_UseTargetname(this.server, e.target);
      }
      this.syncAmmo();
      this.events.push('pickup');
      this.setMessage(c.replace(/_/g, ' '));
      // Real pak pickup sound (C g_items.c pickup_sound, incl. the suits).
      this.emitSound('items/pkup.wav', v3(px, py, pz));
      // New guns switch through the unified selectWeapon lower/raise (never
      // a direct assignment — that kept a stale gunframe). Unknown
      // weapon_* lumps (no def) grant but never switch.
      if (res.reason === 'weapon' && !hadWeapon && findWeapon(c)) {
        this.selectWeapon(c);
      }
    }
    // Pickups (health) write through the authoritative pool so the next
    // server tick doesn't clobber the grant. Suit timers ride along (the
    // tick owns the immunity, the driver owns the grant — same split).
    if (healed) {
      SV_SetPlayerHealth(this.server, this.ps.health);
      SV_SetPlayerSuit(this.server, this.ps.breatherUntil, this.ps.enviroUntil);
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

  private snapshotDoorBases(): void {
    if (!this.map) return;
    const snap = (ent: Edict, rest: Vec3, restAngles: Vec3, rotates: boolean): void => {
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
        this.doors.push({ ent, rest, restAngles, rotates, model: n, faces, baseVerts, baseCenter, baseMins, baseMaxs });
      }
    };
    for (const m of this.server.movers) snap(m.ent, m.pos1, m.ent.angles, false);
    // Secret doors translate like sliders (rest = spawn origin).
    for (const s of this.server.secretDoors) snap(s.ent, s.origin0, s.ent.angles, false);
    // Rotating doors never translate; their faces rotate about the entity
    // origin by ent.angles - restAngles (see syncDoors).
    for (const r of this.server.rotDoors) snap(r.ent, r.ent.origin, r.ent.angles, true);
    // func_train brushes ride the server trains (train_next): snapshot them
    // the same way so the exit-train brush follows the authoritative origin.
    // Point ships (misc_strogg_ship) render as MD2 entities, not brush faces.
    for (const tr of this.server.trains) {
      if (tr.ship) continue;
      const o = (tr.ent.extra['origin'] ?? '0 0 0').trim().split(/\s+/).map(Number);
      snap(tr.ent, v3(o[0] ?? 0, o[1] ?? 0, o[2] ?? 0), tr.ent.angles, false);
    }
    // func_explosive walls render as brush geometry (the *20 glass window,
    // the *30 slab — never as a barrel MD2 proxy). Snapshot them like
    // static brush models (rest = the lump origin, 0,0,0 for brush models)
    // so DoorSync tracks them and doorRenderOffset can pin the closed pose;
    // hideFreedBrushes strips the graft when one blows.
    for (const e of this.server.entities) {
      if (e.freed || e.classname !== 'func_explosive' || !e.model) continue;
      snap(e, v3(0, 0, 0), e.angles, false);
    }
  }

  /** Test hook: how many brush models the DoorSync covers (doors + trains + func_explosive). */
  doorSyncCount(): number {
    return this.doors.length;
  }

  /**
   * Brush-model graft (view-side): QBSP submodel faces (*1..*N — doors,
   * buttons, trains, func_walls, func_explosive) are referenced by NEITHER
   * the world node face ranges NOR any leaf facelist, so the stock world
   * traversal never collects them and every brush entity renders invisible.
   * The fix owns only this MiniWorld instance (fresh per boot): append each
   * rendered brush model's live faces to the facelists of the leaves its
   * mapper bounds intersect (movers/trainds unioned over their full travel
   * so an open door or a running train never leaves its leaves). Frustum,
   * backface, and z culling still apply per surface; PVS is bypassed for
   * these faces (a few hundred extra stamp checks per frame).
   *
   * func_explosive renders here as brush geometry (the *20 TRANS33 glass
   * window, the *30 slab) — the old barrel-MD2 proxy is retired (it
   * double-drew the spawn room). hideFreedBrushes strips a blown brush
   * from the leaf lists so the wall visibly disappears. Excluded on
   * purpose: trigger volumes (SURF_NODRAW, degenerate n=0, invisible
   * in C too).
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
    // Secret doors translate origin0 -> pos1 -> pos2 (same union pattern).
    for (const s of this.server.secretDoors) {
      const n = brushModelNum(s.ent.model);
      if (n === null) continue;
      include(n, 0, 0, 0);
      include(n, s.pos1[0]! - s.origin0[0]!, s.pos1[1]! - s.origin0[1]!, s.pos1[2]! - s.origin0[2]!);
      include(n, s.pos2[0]! - s.origin0[0]!, s.pos2[1]! - s.origin0[1]!, s.pos2[2]! - s.origin0[2]!);
    }
    // Rotating doors swing about their entity origin: union the rest bounds
    // expanded by the brush diagonal, which contains every swing pose.
    for (const r of this.server.rotDoors) {
      const n = brushModelNum(r.ent.model);
      if (n === null) continue;
      const b = modelBounds(map, `*${n}`);
      if (!b) continue;
      const diag = Math.hypot(
        b.maxs[0]! - b.mins[0]!,
        b.maxs[1]! - b.mins[1]!,
        b.maxs[2]! - b.mins[2]!,
      );
      include(n, 0, 0, 0);
      include(n, diag, diag, diag);
      include(n, -diag, -diag, -diag);
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
    // func_explosive statics render as brush geometry too (the *20 glass
    // window, the *30 slab — C SOLID_BSP until destroyed, never an MD2).
    // Mapper bounds only: explosive brushes never move. Blown on free via
    // hideFreedBrushes (graft runs once at boot, when all are standing).
    for (const e of this.server.entities) {
      if (e.freed || e.classname !== 'func_explosive' || !e.model) continue;
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

  /**
   * Test hook: measured render-side displacement of a brush mover's baked
   * verts (DoorSync baseVerts vs live verts, first face/first vertex). Zero
   * at spawn means the door renders CLOSED; nonzero after a touch means the
   * slab visibly moved. Null when the model has no synced faces.
   */
  doorRenderOffset(model: string): [number, number, number] | null {
    const d = this.doors.find((x) => x.ent.model === model);
    if (!d || d.faces.length === 0) return null;
    const s = d.faces[0]!;
    const b = d.baseVerts[0]!;
    return [s.verts[0]! - b[0]!, s.verts[1]! - b[1]!, s.verts[2]! - b[2]!];
  }

  private syncDoors(): void {
    for (const d of this.doors) {
      if (d.rotates) {
        this.syncRotDoor(d);
        continue;
      }
      const ox = d.ent.origin[0]! - d.rest[0]!;
      const oy = d.ent.origin[1]! - d.rest[1]!;
      const oz = d.ent.origin[2]! - d.rest[2]!;
      // No skip when at rest: the final mover step lands exactly on pos1,
      // and skipping that tick would leave the baked verts holding the last
      // in-flight offset (up to one speed-step visibly open while the sim
      // reads closed). Always re-apply base + displacement instead.
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

  /**
   * Strip blown brush models (func_explosive G_FreeEdict) from the leaf
   * facelists the graft appended them to, so a destroyed wall visibly
   * disappears. Runs every tick after syncDoors; each model is stripped
   * once (freedBrushHidden). Only func_explosive edicts ever free — movers
   * and trains never leave the DoorSync — but the loop is generic.
   */
  private hideFreedBrushes(): void {
    if (!this.map) return;
    for (const d of this.doors) {
      if (!d.ent.freed || this.freedBrushHidden.has(d.model)) continue;
      this.freedBrushHidden.add(d.model);
      const first = this.map.modelsExtra[d.model * MODEL_EXTRA_STRIDE + 1]!;
      const num = this.map.modelsExtra[d.model * MODEL_EXTRA_STRIDE + 2]!;
      for (const leaf of this.mini.leafs) {
        const list = leaf.faceList;
        if (!list || list.length === 0) continue;
        leaf.faceList = list.filter((f) => f < first || f >= first + num);
      }
    }
  }

  /**
   * Render-side twin of func_door_rotating: re-pose the baked faces about
   * the door pivot (`rest`, the static entity origin) by the live angular
   * displacement. An identity delta copies the baked verts exactly, so
   * closed rotators render bit-identical to the mapper geometry. Per-face
   * bounds are rebuilt from the rotated verts (a rotated AABB is not the
   * translated AABB), keeping frustum/backface culling correct mid-swing.
   */
  private syncRotDoor(d: DoorSync): void {
    const delta = v3(
      d.ent.angles[0]! - d.restAngles[0]!,
      d.ent.angles[1]! - d.restAngles[1]!,
      d.ent.angles[2]! - d.restAngles[2]!,
    );
    if (Math.abs(delta[0]!) < 1e-9 && Math.abs(delta[1]!) < 1e-9 && Math.abs(delta[2]!) < 1e-9) {
      for (let i = 0; i < d.faces.length; i++) {
        const s = d.faces[i]!;
        const bv = d.baseVerts[i]!;
        s.verts.set(bv);
        s.center.set(d.baseCenter[i]!);
        s.mins.set(d.baseMins[i]!);
        s.maxs.set(d.baseMaxs[i]!);
      }
      return;
    }
    const tmp = v3();
    for (let i = 0; i < d.faces.length; i++) {
      const s = d.faces[i]!;
      const bv = d.baseVerts[i]!;
      let mnx = Infinity, mny = Infinity, mnz = Infinity;
      let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
      let cx = 0, cy = 0, cz = 0;
      const n = bv.length / 3;
      for (let k = 0; k < bv.length; k += 3) {
        tmp[0] = bv[k]!;
        tmp[1] = bv[k + 1]!;
        tmp[2] = bv[k + 2]!;
        rotateDoorVert(tmp, d.rest, delta, tmp);
        s.verts[k] = tmp[0]!;
        s.verts[k + 1] = tmp[1]!;
        s.verts[k + 2] = tmp[2]!;
        if (tmp[0]! < mnx) mnx = tmp[0]!;
        if (tmp[1]! < mny) mny = tmp[1]!;
        if (tmp[2]! < mnz) mnz = tmp[2]!;
        if (tmp[0]! > mxx) mxx = tmp[0]!;
        if (tmp[1]! > mxy) mxy = tmp[1]!;
        if (tmp[2]! > mxz) mxz = tmp[2]!;
        cx += tmp[0]!;
        cy += tmp[1]!;
        cz += tmp[2]!;
      }
      s.center[0] = cx / n;
      s.center[1] = cy / n;
      s.center[2] = cz / n;
      s.mins[0] = mnx;
      s.mins[1] = mny;
      s.mins[2] = mnz;
      s.maxs[0] = mxx;
      s.maxs[1] = mxy;
      s.maxs[2] = mxz;
    }
  }

  /**
   * E-use a func_button (driver `use` key / right-mouse): the eye sits at
   * the authoritative viewheight and the forward comes from the live view
   * angles; SV_UseButton picks the aimed button (reach + facing cone, wall
   * rejected) and presses it with C button_use semantics. Emits 'use' when
   * a button actually starts moving (drives the gate (v) verdict).
   */
  private pressUseButton(): void {
    if (this.playerDead) return;
    const eye = v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]! + this.pm.viewheight);
    const fwd = v3();
    const right = v3();
    const up = v3();
    AngleVectors(this.pm.viewAngles, fwd, right, up);
    const used = SV_UseButton(this.server, eye, fwd, { trace: this.worldTrace });
    if (used) this.events.push('use');
  }

  /**
   * Fire the selected weapon (Phase 0 single sim): the driver computes the
   * shot (eye/feet/angles from input) but the server applies it via
   * SV_PlayerFire — ammo, muzzle dlight, bolts, hitscan pellet traces,
   * pain/gib/barrel damage, impact sparks and sounds are all server-owned.
   * Muzzle/tracer visuals reach the pump through drainServerEvents (end of
   * step). Weapon_Generic-lite gunframe + view kick stay driver-side
   * (viewmodel cosmetics).
   */
  private handleAttack(cmd: UserCmdT): void {    if (!(cmd.buttons & BUTTON_ATTACK)) return;
    if (this.playerDead) return;
    // Weapon_Generic: WEAPON_DROPPING / WEAPON_ACTIVATING ignore attack —
    // the gun is mid-switch (lower/raise), not READY, so the trigger does
    // nothing (no shot, no dry-fire, no refire latch).
    if (this.switching) return;
    const t = this.server.time;
    const refire = REFIRE[this.weapon.classname] ?? 0.25;
    if (t - this.lastShotAt < refire) return;
    const viewheight = this.pm.viewheight;
    const eye = v3(this.pm.origin[0]!, this.pm.origin[1]!, this.pm.origin[2]! + viewheight);
    const res = SV_PlayerFire(this.server, this.weapon.classname, {
      eye,
      feet: v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]),
      angles: new Float32Array(cmd.angles) as Vec3,
      viewheight,
      ammo: this.ammoFor(this.weapon.ammoKind),
      trace: this.worldTrace,
      rand: this.rand,
    });
    if (!res.fired) {
      this.setMessage('NO AMMO');
      this.events.push('empty');
      this.lastShotAt = t;
      return;
    }
    if (this.weapon.ammoKind) this.setAmmo(this.weapon.ammoKind, res.ammoLeft);
    this.lastShotAt = t;
    this.setMessage('');
    this.events.push('shot');
    if (res.bolt) this.events.push('bolt');
    // Weapon_Generic-lite: firing starts at FIRE_FIRST (activate+1); the
    // per-tick stepper walks it to IDLE_FIRST+1 (READY). viewModel() reports
    // this live gunframe; muzzleLit stays dlight/HUD-only.
    this.gunframe = gunBoundsFor(this.weapon.classname).activate + 1;
    this.firing = true;
    // Firing kick (p_weapon.c Blaster_Fire/weapon_shotgun_fire): origin
    // -2*fwd, pitch -1 (blaster) / -2 (shotgun). Machinegun has its own
    // per-shot crandom walk (TODO) and sets no kick here.
    const fwd0 = v3();
    const right0 = v3();
    const up0 = v3();
    AngleVectors(new Float32Array(cmd.angles) as Vec3, fwd0, right0, up0);
    if (this.weapon.classname === 'weapon_blaster') {
      this.kickOrigin = v3(-2 * fwd0[0]!, -2 * fwd0[1]!, -2 * fwd0[2]!);
      this.kickAngles = v3(-1, 0, 0);
      this.kickPending = true;
    } else if (this.weapon.classname === 'weapon_shotgun') {
      this.kickOrigin = v3(-2 * fwd0[0]!, -2 * fwd0[1]!, -2 * fwd0[2]!);
      this.kickAngles = v3(-2, 0, 0);
      this.kickPending = true;
    }
  }

  /**
   * Drain live explosion flashes for the dlight pump. Blaster flashes are
   * brief (EXPLOSION_LIGHT_WINDOW); big booms burn over their frame life
   * with alpha fade (ex_poly 16-frame alpha, ex_misc linear). Returns pos +
   * kind + alpha so the pump can pick the authentic light per kind. Backed
   * by the server explosion list (pruned server-side by frame life).
   */
  drainExplosions(): Array<{ pos: Vec3; kind: ExplosionKind; alpha: number }> {
    const out: Array<{ pos: Vec3; kind: ExplosionKind; alpha: number }> = [];
    for (const e of this.server.explosions) {
      const age = this.server.time - e.born;
      const frames = explosionFrames(e.kind);
      if (age < 0 || age >= frames * 0.1) continue;
      const lit = e.kind === 'blaster' ? age < EXPLOSION_LIGHT_WINDOW : age < (frames - 1) * 0.1;
      if (!lit) continue;
      const f = Math.floor(age / 0.1);
      const alpha = e.kind === 'blaster' ? 1 - age / EXPLOSION_LIGHT_WINDOW : (16 - f) / 16;
      out.push({ pos: e.pos, kind: e.kind, alpha: Math.max(0, Math.min(1, alpha)) });
    }
    return out;
  }

  private pushColoredSpark(pos: Vec3, color: number, ttl: number = SPARK_TTL, born?: number): void {
    const parts = this.mini.particles as { origin: Vec3; color: number }[];
    parts.push({ origin: v3(pos[0], pos[1], pos[2]), color });
    this.particleBorn.push(born ?? this.server.time);
    this.particleVel.push(null);
    this.particleTtl.push(ttl);
    this.capParticles(parts);
  }

  /**
   * One ballistic boom spark (cl_fx.c CL_ExplosionParticles): fixed palette
   * color, server-stepped velocity, PARTICLE_GRAVITY falloff, server-owned
   * ttl (alphavel -0.8/(0.5+rand*0.3) → 0.625-1.0s).
   */
  private pushBallisticSpark(pos: Vec3, vel: Vec3, color: number, ttl: number): void {
    const parts = this.mini.particles as { origin: Vec3; color: number }[];
    parts.push({ origin: v3(pos[0], pos[1], pos[2]), color });
    this.particleBorn.push(this.server.time);
    this.particleVel.push(vel);
    this.particleTtl.push(ttl);
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
  /**
   * Strict Voodoo presentation (V2d, default ON): HUD is composed into the
   * emulated pre-scanout target BEFORE reconstruction + display gamma
   * (astra §4 pipeline). When false the legacy path paints HUD after
   * resolve (same as the software path). Flip per-boot in tests; the live
   * loop keeps the default.
   */
  strictVoodoo: boolean;
  /** Which resolve path the last `resolveDisplay` took (see ResolveOrder). */
  lastResolveOrder: ResolveOrder;
  /**
   * Explicit raster-policy selection for the last voodoo resolve (V2d):
   * `serial` = supported main-thread `resolveFrame` after all bands
   * completed; never a silent software fallback (see selectVoodooBandPath).
   */
  lastVoodooPath: VoodooBandPath | 'none';
  /**
   * Last `armRasterPolicy` outcome (P1: `{mode, rgbEnabled, hooked}` for
   * tests; `hooked === false` means no renderer hook consumed the request
   * and the indexed fallback is active — see `armRasterPolicy`).
   */
  lastRasterPolicy: RasterPolicyStatus;
  /**
   * Browser worker pool attached by `attachBrowserPool` (null = sync /
   * single-threaded path: headless, no SAB, or `sw_workers` 0). Set once
   * per boot; `frameAsync` feature-detects `broadcastVoodooState` on it to
   * transfer the frame's single VoodooState snapshot to every band.
   */
  browserPool: BrowserBandPool | null;
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
 * soldier mesh/skin (gunner + infantry resolve to their own MD2/skins). Per-file fallback is the box-critter so one corrupt
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
  /** Infantry MD2 (monster_infantry; appended after gunner, same rule). */
  infantry: number;
  /** PCX skin handle for the infantry MD2. */
  infantrySkin: number;
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
  /** Dead-soldier corpse (g_misc.c `models/deadbods/dude/tris.md2`). */
  corpse: number;
  /** PCX skin for the corpse MD2. */
  corpseSkin: number;
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
  const infantrySkin = loadSkin(skinForMonster('infantry'));
  const infantry = loadModel(modelForMonster('infantry'));
  const weapons: Record<string, number> = {};
  const weaponSkins: Record<string, number> = {};
  // Every weapon class with a C view lump (game table + WEAPON_VIEW_FALLBACK,
  // all verified in pak0.pak): the first-person gun renders as a real v_weap
  // MD2 after an auto-equip, never the 2D silhouette. Appended in class
  // order; earlier handles (soldier 0, gunner, infantry) never shift.
  for (const cls of [...WEAPON_WORLD_CLASSES, 'weapon_grenades']) {
    const mdl = viewModelForPickup(cls);
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
  for (const cls of [...WEAPON_WORLD_CLASSES, 'weapon_grenades']) {
    if (items[cls] !== undefined) continue;
    const mdl = worldModelForPickup(cls);
    if (!mdl) continue;
    items[cls] = { model: loadModel(mdl), skin: loadSkin(skinForWeaponModel(mdl)) };
  }
  // Courtyard dressing (g_misc.c): strogg flyby ship + waving banner.
  // The banner skin is the red eagle art (models/objects/banner/skin.pcx).
  const shipSkin = loadSkin(SHIP_SKIN);
  const ship = loadModel(SHIP_MODEL);
  const bannerSkin = loadSkin(BANNER_SKIN);
  const banner = loadModel(BANNER_MODEL);
  // Dead-soldier corpse (misc_deadsoldier, appended last like the banner so
  // every earlier handle stays stable; missing lump → box-critter fallback).
  const corpseSkin = loadSkin(CORPSE_SKIN);
  const corpse = loadModel(CORPSE_MODEL);
  return {
    monster, monsterSkin, soldierLightSkin, soldierSsSkin, gunner, gunnerSkin, infantry, infantrySkin, weapons, weaponSkins, bolt, boltSkin, barrel, barrelSkin,
    explode, explodeSkin, blast, blastSkin,
    debris1, debris1Skin, debris2, debris2Skin, debris3, debris3Skin,
    gibMeat, gibMeatSkin, gibChest, gibChestSkin, gibBone, gibBoneSkin, gibHead, gibHeadSkin,
    items, ship, shipSkin, banner, bannerSkin, corpse, corpseSkin,
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
  const renderer = opts.renderer ?? (getCVarString('vid_renderer') === 'voodoo' ? 'voodoo' : 'software');
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
  const boot: PlayBoot = {
    host, driver, refresh, renderer, source: driver.source,
    display: new Uint32Array(n), fb565: new Uint16Array(n),
    strictVoodoo: true, lastResolveOrder: 'none', lastVoodooPath: 'none',
    lastRasterPolicy: { mode: renderer, rgbEnabled: false, hooked: false },
    browserPool: null,
    models, pak: opts.pak ?? null,
  };
  // Arm the raster policy the cvar selects (RGB path on for voodoo, off for
  // software) so a voodoo boot never starts on the wrong backend.
  armRasterPolicy(boot);
  return boot;
}

/**
 * Reboot a boot at the CURRENT cvar values (skill + vid_resolution +
 * map_source): the menu path for "changing the dropdown reboots the level".
 * Same pak and renderer as the previous boot, fresh driver/server/mini
 * (DoorSync bases re-baked, skill filter re-applied before spawning).
 * map_source decides which world: 'pak' keeps the previous pak (null when
 * the previous boot had none → devroom fallback), anything else boots the
 * asset-free devroom even when a pak is cached.
 */
export function rebootPlay(prev: PlayBoot): PlayBoot {
  const pak = getMapSource() === MAP_SOURCE_PAK ? prev.pak : null;
  // Renderer is NOT re-latched here: vid_renderer hot-swaps in place
  // (see applyRendererCvar) without rebuilding Host/LocalDriver/server
  // state. Skill/resolution/map still reboot through this path.
  return bootPlay({ pak });
}

/**
 * Hot-swap the renderer backend in place (vid_renderer menu switch without
 * a reboot): re-latches `boot.renderer` from the cvar and returns it. The
 * resolve path (resolveDisplay) already reads the cvar every frame, so no
 * Host/LocalDriver/server state is touched — player pos, health, ammo and
 * monsters survive the switch. Pure except for the boot.renderer write;
 * headless-safe.
 *
 * V2d raster policy: the switch also arms/disarms the sw-renderer RGB world
 * path (voodoo ON, software OFF) via the optional hooks below, invalidates
 * incompatible texture/light caches, and zeroes the shell-owned scratch
 * planes so the next frame can never show previous-mode pixels.
 */
export function applyRendererCvar(boot: PlayBoot): RendererKind {
  const next: RendererKind = getCVarString('vid_renderer') === 'voodoo' ? 'voodoo' : 'software';
  boot.renderer = next;
  armRasterPolicy(boot);
  return next;
}

/* --- V2d raster-policy hooks (feature-detected, never imported) ---------
 *
 * The sw-renderer RGB-world switch exists as BOTH the module-level
 * `setRGBWorldEnabled(bool)` / `isRGBWorldEnabled()` pair and the
 * `SoftwareRenderer.setRGBWorldEnabled/isRGBWorldEnabled/invalidateCaches`
 * instance methods (`packages/sw-renderer/src/frame.ts`). The shell probes
 * the instance first (correct per-renderer state + cache drop); the hook
 * names below are probed with `as unknown as` so this file passes with or
 * without future renames. A miss records `hooked: false` and warns LOUDLY
 * instead of silently running the indexed rasterizer in voodoo mode (P1).
 *
 * Hook names (tried in order):
 *   RGB arm/disarm: setRGBWorldEnabled(bool)
 *   cache invalidate: invalidateCaches() | invalidateTextureCaches() |
 *     clearTextureCache() | invalidateLightCaches() | clearCaches()
 *   scanout-done flag: voodooScanoutDone() -> boolean (see resolveDisplay)
 */
const RGB_ENABLE_HOOKS = [
  'setRGBWorldEnabled',
  'setRGBWorld',
  'enableRGBWorld',
  'setVoodooRGBEnabled',
] as const;

const CACHE_INVALIDATE_HOOKS = [
  'invalidateCaches',
  'invalidateTextureCaches',
  'clearTextureCache',
  'invalidateLightCaches',
  'clearCaches',
] as const;

/** Probe an optional no-arg/boolean hook set; call the first one present. */
function callFirstHook(target: object, names: readonly string[], arg?: boolean): boolean {
  const rec = target as unknown as Record<string, unknown>;
  for (const name of names) {
    const fn = rec[name];
    if (typeof fn === 'function') {
      try {
        if (arg === undefined) (fn as () => void).call(target);
        else (fn as (on: boolean) => void).call(target, arg);
      } catch {
        /* a throwing future hook must never break the hot-swap */
      }
      return true;
    }
  }
  return false;
}

/**
 * Arm/disarm the raster policy for `boot.renderer` (shared by bootPlay and
 * applyRendererCvar): voodoo arms the sw-renderer RGB world path, software
 * disarms it. Invalidates incompatible texture/light caches when a hook is
 * present (TODO(V2d): no public cache-invalidate hook exists on
 * SoftwareRenderer yet — `surfaceCache.invalidateAll` is internal — so this
 * currently documents the need; the scratch-plane zeroing below is what
 * guarantees no stale frame today).
 *
 * Returns whether a real renderer hook consumed the request and records the
 * outcome on `boot.lastRasterPolicy` (P1 observability). When no hook is
 * present it `console.warn`s (loud, not silent) and keeps the indexed
 * fallback. Never throws.
 */
export function armRasterPolicy(boot: PlayBoot): boolean {
  const voodoo = boot.renderer === 'voodoo';
  const hooked = callFirstHook(boot.refresh, RGB_ENABLE_HOOKS, voodoo);
  boot.lastRasterPolicy = { mode: boot.renderer, rgbEnabled: voodoo, hooked };
  if (!hooked) {
    console.warn(
      `[q2ts-web] armRasterPolicy(${boot.renderer}): no RGB-world hook on ` +
        `SoftwareRenderer (tried ${RGB_ENABLE_HOOKS.join(', ')}) — indexed ` +
        `fallback stays active until the sw-renderer instance hook lands`,
    );
  }
  // TODO(V2d): call the real texture/light cache invalidate hooks once the
  // sw-renderer card publishes them; no public hook exists at this HEAD.
  callFirstHook(boot.refresh, CACHE_INVALIDATE_HOOKS);
  // Shell-owned scratch: zero so the next resolve can never show
  // previous-mode pixels (engine planes are repainted by the next render).
  boot.display.fill(0);
  boot.fb565.fill(0);
  return hooked;
}

/* --- V2d resolve ownership (astra §5) ------------------------------------
 *
 * SINGLE OWNER: the SHELL owns scanout. `SoftwareRenderer.endFrame` /
 * `endFrameAsync` own only the palette-expand into the live `color` plane
 * (the pre-scanout target for voodoo mode too — no @q2/voodoo call there);
 * `resolveDisplay` below runs the ONE voodoo resolve (`resolveFrame`) per
 * frame. If a future renderer-side voodoo backend ever performs its own
 * scanout it must flag it via the optional `voodooScanoutDone() -> boolean`
 * hook; when present and true the shell skips its resolve so exactly one
 * resolve runs (double-resolve guard).
 *
 * Strict voodoo path (`boot.strictVoodoo`, default ON for voodoo mode):
 * HUD is composed into the emulated target BEFORE scanout reconstruction
 * + display gamma (astra §4 pipeline). Legacy/software path keeps the
 * current paint-HUD-after + `r_brightness` behaviour. The legacy
 * `r_brightness` lift is retained post-scanout in the LEGACY voodoo branch
 * only: strict voodoo skips it (effective brightness 1.0) because
 * `vd_gamma` inside `resolveFrame` is already the display-gamma stage —
 * stacking the lift on top would double-apply gamma.
 */

/** Optional renderer-side scanout-done flag (see ownership note above). */
function rendererDidScanout(boot: PlayBoot): boolean {
  const rec = boot.refresh as unknown as Record<string, unknown>;
  const fn = rec['voodooScanoutDone'];
  if (typeof fn !== 'function') return false;
  try {
    return (fn as () => unknown).call(boot.refresh) === true;
  } catch {
    return false;
  }
}

/**
 * Compose HUD into the live pre-scanout target (strict voodoo only): the
 * same `drawPlayHud` pass the legacy path runs post-resolve, but painted
 * onto the engine `color` plane BEFORE `resolveFrame` so HUD pixels travel
 * through dither/quantise/reconstruction/gamma like the scene. The next
 * renderView repaints the plane, so no HUD ghost survives.
 */
export function paintHudPreScanout(boot: PlayBoot, hud: HudState): void {
  const { host } = boot;
  const live = boot.refresh.getFramebuffer().color;
  drawPlayHud(
    { width: host.fb.width, height: host.fb.height, color: live },
    boot,
    hud,
  );
}

/**
 * True when the shell composes HUD pre-scanout (strict voodoo): callers
 * (dom finishFrame) must NOT paint HUD again post-resolve — that would
 * double-paint and defeat the strict ordering.
 */
export function hudComposedPreScanout(boot: PlayBoot): boolean {
  return getCVarString('vid_renderer') === 'voodoo' && boot.strictVoodoo;
}

/** Resolve the software framebuffer for display (voodoo post chain or direct).
 *
 * Display-only `r_brightness` lift (see `getBrightness`) is applied to the
 * scene copy here, *before* `drawPlayHud` paints on top — so HUD text keeps
 * its full authored colour and is never dimmed or clipped by the lift.
 * At 1.0 the software path returns the engine buffer untouched
 * (byte-identical, same reference).
 *
 * Strict voodoo (`boot.strictVoodoo`, default ON) SKIPS the `r_brightness`
 * post-scanout lift (effective brightness 1.0): `vd_gamma` inside
 * `resolveFrame` is already the display-gamma stage, so stacking the lift
 * would double-apply gamma. The legacy voodoo branch keeps the lift.
 *
 * V2d: `hud` enables the strict-voodoo pre-scanout HUD composition (painted
 * into the emulated target before `resolveFrame`). Omit it (headless/tests)
 * to resolve the scene alone; the legacy post-resolve HUD pass is unchanged.
 *
 * `frameState` is the frame's single VoodooState snapshot (astra §5): when
 * provided (the `frameAsync` path snapshots once per frame and shares it
 * with every band via `broadcastBandVoodoo`) the resolve reuses it instead
 * of taking a second `readVoodooState()`, so bands and scanout can never
 * disagree mid-frame. Omit it and the resolve snapshots itself (sync path).
 */
export function resolveDisplay(boot: PlayBoot, hud?: HudState, frameState?: VoodooState): Uint32Array {
  const { host } = boot;
  const brightness = getBrightness();
  // Source the LIVE renderer color plane, not host.fb.color: with a worker
  // pool attached the renderer adopts the pool's shared color plane (and
  // the wasm backend draws into wasm memory), so host.fb.color is stale
  // there. Classic path: the same array (behaviour unchanged).
  const live = boot.refresh.getFramebuffer().color;
  if (getCVarString('vid_renderer') === 'voodoo') {
    const w = host.fb.width;
    const h = host.fb.height;
    const n = w * h;
    // One VoodooState snapshot per frame, passed explicitly (astra §5): no
    // per-pixel cvar reads inside the resolve, and the same object selects
    // the band envelopes (see render-workers.ts). The async path passes its
    // already-broadcast snapshot in; the sync path snapshots here.
    const st: VoodooState = frameState ?? readVoodooState();
    // Explicit raster-policy selection: until a worker/WASM voodoo backend
    // exists the ONLY supported voodoo path is serial main-thread scanout
    // after every band completes (selectVoodooBandPath documents this and
    // never silently draws software). Recorded for tests/debug.
    const pooled = boot.refresh.testWorkerStats().pooled;
    boot.lastVoodooPath = selectVoodooBandPath(pooled);
    // Double-resolve guard (see ownership note): a renderer-side scanout
    // wins when flagged; the shell resolve below is then skipped.
    if (!rendererDidScanout(boot)) {
      if (boot.strictVoodoo) {
        // STRICT: HUD into the emulated target BEFORE scanout so the
        // reconstruction filter taps cross HUD/scene edges with absolute
        // screen-coordinate dither phase (global frame, never per-band).
        // NO r_brightness post-scanout lift here (effective 1.0): vd_gamma
        // inside resolveFrame is already the display-gamma stage, so
        // stacking the lift would double-apply gamma.
        if (hud !== undefined) paintHudPreScanout(boot, hud);
        boot.lastResolveOrder = 'strict-hud-first';
        resolveFrame(live, boot.fb565, boot.display, w, h, st);
      } else {
        // LEGACY: scanout first, HUD painted after by the caller. Keeps the
        // r_brightness post-scanout lift (compat); strict mode above skips it.
        boot.lastResolveOrder = 'legacy-hud-last';
        // Canary for pre-fix `resolveFrame` (astra §2 defect #1): it only fills
        // `display` when `vd_postfilter` is on, leaving last frame's
        // (HUD-painted) pixels stale when off. The sentinel alpha (0x12) can
        // never occur in real resolve output (always opaque 0xFF), so a
        // surviving sentinel proves `display` was left untouched and the web
        // side backfills the current frame below. Once the voodoo fix lands,
        // `resolveFrame` overwrites the canary with real output (565 expand
        // when `vd_16bit` is on, `resolveRGB888` when off) and the backfill
        // never runs — robust to both behaviours with zero extra passes.
        let canary = false;
        if (getCVarNumber('vd_postfilter') === 0 && n > 0) {
          boot.display[0] = VOODOO_STALE_SENTINEL;
          canary = true;
        }
        resolveFrame(live, boot.fb565, boot.display, w, h, st);
        if (canary && boot.display[0] === VOODOO_STALE_SENTINEL) {
          if (getCVarNumber('vd_16bit') !== 0) {
            for (let i = 0; i < n; i++) boot.display[i] = expandRGB565(boot.fb565[i]!);
          } else {
            backfillRGB888(live, boot.display, n);
          }
        }
      }
    }
    // r_brightness post-scanout lift: LEGACY voodoo branch only. Strict
    // voodoo skips it (vd_gamma is the display-gamma stage there).
    if (!boot.strictVoodoo) applyBrightness(boot.display, brightness);
    return boot.display;
  }
  boot.lastVoodooPath = 'none';
  if (brightness === 1) {
    boot.lastResolveOrder = 'software-passthrough';
    return live;
  }
  boot.lastResolveOrder = 'software-lifted';
  boot.display.set(live);
  applyBrightness(boot.display, brightness);
  return boot.display;
}

/**
 * Sentinel marking an unwritten voodoo display pixel (see `resolveDisplay`).
 * Alpha 0x12 is impossible in resolve output (always opaque), so a survivor
 * unambiguously detects the pre-fix `resolveFrame` stale path.
 */
const VOODOO_STALE_SENTINEL = 0x12345678;

/**
 * Genuine RGB888 backfill for the `vd_16bit`-off + postfilter-off corner
 * under pre-fix `resolveFrame`: gamma-lifted copy of the live frame, no
 * dither, no reconstruction. The bypass keeps the gamma stage and skips the
 * quantiser (astra §2 defect #2), mirroring `resolveRGB888` semantics so the
 * web side converges to the same pixels once the voodoo fix lands.
 * Zero-alloc; display-only, never renderer state.
 */
function backfillRGB888(src: Uint32Array, dst: Uint32Array, n: number): void {
  const gamma = getCVarNumber('vd_gamma');
  const lut = gamma !== 1 && gamma > 0 && Number.isFinite(gamma) ? gammaLUT(gamma) : null;
  for (let i = 0; i < n; i++) {
    const px = src[i]!;
    let r = px & 255;
    let g = (px >> 8) & 255;
    let b = (px >> 16) & 255;
    if (lut !== null) {
      r = lut[r]!;
      g = lut[g]!;
      b = lut[b]!;
    }
    dst[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
}

/* --- V2d strict-voodoo presentation (astra §4) ---------------------------
 *
 * The emulated image presents fixed 640×480 4:3 (the first capture
 * resolution) with a CONTROLLED upscale only: the canvas is blitted with
 * putImageData (exact pixels, never filtered) and CSS-scaled with
 * `image-rendering: pixelated`, so there is no second smoothing pass after
 * the scanout reconstruction filter. Browser debug controls (the cvar
 * panel, menus) are DOM elements OUTSIDE the canvas — never part of the
 * emulated image. Strict mode expects a 4:3 framebuffer (the menu only
 * offers 4:3 sizes); non-4:3 sizes keep the legacy CSS stretch and are
 * reported by isVoodooAspect.
 */

/** Strict-voodoo capture resolution (fixed 4:3 emulated image). */
export const VOODOO_FRAME_WIDTH = 640;
/** Strict-voodoo capture resolution (fixed 4:3 emulated image). */
export const VOODOO_FRAME_HEIGHT = 480;

/**
 * True when a framebuffer is 4:3 within rounding (the strict-voodoo
 * presentation contract). Pure/headless-safe.
 */
export function isVoodooAspect(w: number, h: number): boolean {
  if (!(w > 0) || !(h > 0)) return false;
  return Math.abs((w / h) / (VOODOO_FRAME_WIDTH / VOODOO_FRAME_HEIGHT) - 1) < 0.01;
}

/**
 * Apply the strict-voodoo canvas presentation (pixelated controlled
 * upscale, no smoothing). Feature-detected no-op headless (unknown canvas
 * shape); safe to call every frame (idempotent style writes). Browser
 * debug controls stay DOM-side — this never touches them.
 */
export function applyVoodooPresentation(canvas: unknown): void {
  try {
    const el = canvas as { style?: Record<string, string> } | null;
    if (!el || typeof el !== 'object' || !el.style) return;
    el.style['imageRendering'] = 'pixelated';
  } catch {
    /* headless: presentation is a no-op without DOM */
  }
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

/** In-canvas finished-screen colour: opaque blue in 0xAABBGGRR (canvas
 * colour). The end-of-level stats block renders centered in this tone —
 * the blue status message from the original game.
 */
export const FINISH_BLUE = 0xffff0000;

/**
 * Pure level-time readout: `M:SS` from level.time seconds (float, never
 * wall-clock per BRAIN.md §5). Feeds the finished-screen stats line.
 */
export function formatLevelTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Pure finished-screen text (server-owned snapshot in, lines out):
 * the LEVEL COMPLETE headline plus HelpComputer-lite stats (C p_hud.c:
 * kills / goals / secrets over totals, and the level time). The driver
 * mirrors `server.finished` into `message` with this every tick; the HUD
 * renders it centered in FINISH_BLUE.
 */
export function formatFinishMessage(server: ServerState): string {
  return [
    'LEVEL COMPLETE — base2 is not shipped yet. Thanks for playing!',
    `kills ${server.finishKills}/${server.totalMonsters}  secrets ${server.finishSecrets}/${server.totalSecrets}  goals ${server.finishGoals}/${server.totalGoals}`,
    `time ${formatLevelTime(server.finishTime)}`,
  ].join('\n');
}

/**
 * Pure anchor for one centered HUD line: x so the text sits in the middle
 * of the buffer (clamped to >= 0 so tiny buffers clip instead of wrapping).
 */
export function finishLineAnchor(width: number, text: string): { x: number } {
  return { x: Math.max(0, ((width - stringWidth(text)) / 2) | 0) };
}

/** In-canvas fps readout colour (conchars `drawString`, top-right in-view,
 * gated by `cl_showfps`). Drawn in `drawPlayHud` on the display buffer —
 * the same pre-blit HUD pass as the crosshair — so it matches the game
 * look and is never dimmed by the `r_brightness` scene lift. */
export const FPS_GREEN = 0xff00ff00;

/** In-canvas player-position readout colour (dim neutral grey 0x99 — a step
 * above the HUD `dim` 0x88 crosshair tone so the two never collide in tests
 * or on screen. The retired DOM `#q2-pos` tint was yellow). Drawn in
 * the same pre-blit HUD pass as fps — after the `r_brightness` scene lift —
 * so it keeps its authored colour and stays legible at any brightness. */
export const POS_GREY = 0xff999999;

/**
 * Pure anchor for the in-canvas fps slot: top-right, 8px margins, so the
 * counter never covers the world center or the controls panel. Clamped to
 * x >= 0 so tiny buffers clip instead of wrapping.
 */
export function fpsHudAnchor(width: number, text: string): { x: number; y: number } {
  return { x: Math.max(0, width - stringWidth(text) - 8), y: 8 };
}

/**
 * Pure anchor for the in-canvas player-position slot: top-left, 8px
 * margins (mirrors the fps slot's y so both readouts share one HUD row).
 */
export function posHudAnchor(): { x: number; y: number } {
  return { x: 8, y: 8 };
}

/**
 * Pure in-canvas fps readout text: `fps N` (integer, conchars glyphs).
 */
export function formatFpsText(fps: number): string {
  return `fps ${Math.round(fps)}`;
}

/**
 * Cvar gate for the in-canvas fps readout (`cl_showfps`, default 1).
 * Mirrors dom.showFpsEnabled without importing the DOM layer (this module
 * is headless-safe; dom.ts imports from here, never the reverse).
 */
export function fpsVisible(): boolean {
  if (getCVar('cl_showfps') === undefined) return true;
  const raw = getCVar('cl_showfps');
  return Number(raw) !== 0;
}

/**
 * Cvar gate for the in-canvas position readout (`cl_showpos`, default 1 =
 * ON so users can report issue locations). Mirrors dom.showPosEnabled
 * without importing the DOM layer (headless-safe; dom.ts imports from
 * here).
 */
export function posVisible(): boolean {
  if (getCVar('cl_showpos') === undefined) return true;
  const raw = getCVar('cl_showpos');
  return Number(raw) !== 0;
}

/** Round to 1 decimal, normalising -0 to 0 for stable reports. */
function r1(v: number): string {
  const r = Math.round(v * 10) / 10;
  return (r === 0 ? 0 : r).toFixed(1);
}

/**
 * Pure player-position readout text: `pos x y z`, each rounded to 1 decimal.
 * Drawn in-canvas top-left via conchars glyphs (gated by `cl_showpos`,
 * default ON).
 */
export function formatPlayerPos(x: number, y: number, z: number): string {
  return `pos ${r1(x)} ${r1(y)} ${r1(z)}`;
}

/**
 * Position readout text for a driver (pm.origin, per-frame source).
 * Pure/headless-safe; `drawPlayHud` paints it in-canvas every frame.
 */
export function playerPosText(driver: LocalDriver): string {
  return formatPlayerPos(
    driver.pm.origin[0]!,
    driver.pm.origin[1]!,
    driver.pm.origin[2]!,
  );
}

/** Draw crosshair + status lines onto a 0xAABBGGRR buffer (runs post-resolve).
 *
 * The play canvas shows world + crosshair + weapon/ammo + hp + message
 * (+ the devroom hint and death bars) + the in-canvas `fps N` counter
 * top-right (gated by `cl_showfps`) + the in-canvas player-position readout
 * top-left (gated by `cl_showpos`, default ON). Both readouts use conchars
 * glyphs (`drawString`), drawn in this same pre-blit HUD pass — after the
 * `r_brightness` scene lift — so they keep their authored colours exactly
 * like the crosshair. `hud.fps` feeds the fps counter; `hud.frame` is
 * kept for signature compat and ignored.
 */
export function drawPlayHud(
  target: { width: number; height: number; color: Uint32Array },
  boot: PlayBoot,
  hud: HudState,
): void {
  // In-canvas readouts first, so later HUD rows paint over them on tiny
  // buffers instead of the reverse.
  if (fpsVisible() && Number.isFinite(hud.fps) && hud.fps > 0) {
    const text = formatFpsText(hud.fps);
    const a = fpsHudAnchor(target.width, text);
    drawString(target, a.x, a.y, text, FPS_GREEN);
  }
  if (posVisible()) {
    const a = posHudAnchor();
    drawString(target, a.x, a.y, playerPosText(boot.driver), POS_GREY);
  }
  const white = 0xffffffff;
  const cx = (target.width / 2) | 0;
  const cy = (target.height / 2) | 0;
  const dim = 0xff888888;
  fillRect(target, cx - 4, cy, 9, 1, dim);
  fillRect(target, cx, cy - 4, 1, 9, dim);
  fillRect(target, cx, cy, 1, 1, white);
  // 3D view model (pak) replaces the 2D silhouette — never double-draw.
  if (usesViewModel3D(boot)) drawDeathBars(target, boot);
  else drawViewModel(target, boot);
  const hp = boot.driver.playerHealth;
  const hpColor = boot.driver.playerDead ? 0xffff3333 : hp <= 25 ? 0xffff9933 : white;
  drawString(target, 8, target.height - 18, `${boot.driver.weapon.classname} ${boot.driver.hudAmmo()}`, white);
  drawString(target, 8, target.height - 48, `hp ${hp}`, hpColor);
  if (boot.driver.server.finished) {
    // Finished screen: the multi-line stats block, centered horizontally in
    // FINISH_BLUE (the original's blue status message), stacked just above
    // screen center like C's centerprint. Drawn in the same pre-blit HUD
    // pass as fps/pos — after the `r_brightness` scene lift — so the blue
    // keeps its authored colour at any brightness.
    const lines = boot.driver.message.split('\n');
    const y0 = Math.max(8, ((target.height - lines.length * 8) / 2 - 8) | 0);
    lines.forEach((line, i) => {
      drawString(target, finishLineAnchor(target.width, line).x, y0 + i * 10, line, FINISH_BLUE);
    });
  } else if (boot.driver.message) {
    const msg = boot.driver.message.slice(0, 48);
    drawString(target, 8, target.height - 30, msg, 0xffffff00);
  }
  if (boot.source === 'devroom') {
    drawString(target, 8, 28, 'devroom - drop pak0.pak for base1', dim);
  }
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

/* --- async render (M8.1 browser lane) ------------------------------------
 *
 * The browser main thread can never block (Atomics.wait throws), so the
 * worker-pool frame kick must complete without blocking: beginFrame +
 * geometry run synchronously, then flushFrameAsync/resolveFrameAsync drain
 * the pool message-driven while the main thread drains its own band. The
 * renderer exposes this as renderViewAsync/endFrameAsync
 * (@q2/sw-renderer, bit-identical to the sync path); this module wires it
 * into the play loop as frameAsync, a line-for-line async twin of
 * Host.frame + Host.renderCurrentView (cited below). The sync path is
 * untouched — dom.ts adopts frameAsync with a one-line tick change (see
 * the M7.1 card; dom.ts is outside this change's file lock).
 *
 * Host privates (serverAcc/lastNow/ownedCmds) live here instead, in
 * AsyncLoopState; everything else goes through public Host/Driver APIs so
 * the sim stays canonical. A differential test pins frameAsync ==
 * host.frame pixel-for-pixel on scripted input.
 */

/** Per-boot async-loop state (mirrors Host's private frame accumulators). */
export interface AsyncLoopState {
  lastNow: number;
  serverAcc: number;
  ownedCmds: PredictCmd[];
}

/** Fresh async-loop state (lastNow < 0 latches the first timestamp). */
export function createAsyncLoopState(): AsyncLoopState {
  return { lastNow: -1, serverAcc: 0, ownedCmds: [] };
}

/**
 * Attach a browser worker pool to this boot's renderer (M8.1 async banding
 * for the web lane). Honors `sw_workers` like the sync path: 0 (default)
 * or unavailable (headless, no SAB, no isolation) leaves the
 * single-threaded planes active and returns null. Call once after bootPlay
 * (and after any rebootPlay, which rebuilds the renderer). When `workers`
 * is omitted the pool is sized from the cvar (bands − 1: the calling thread
 * owns the last band); an explicit count overrides it. Never throws and
 * never allocates per frame — the pool (SAB + workers) lives until dispose.
 */
export function attachBrowserPool(boot: PlayBoot, workers?: number): BrowserBandPool | null {
  const { refresh, host } = boot;
  // The boot records the pool (or its absence) so frameAsync can transfer
  // the frame's VoodooState snapshot to every band (see broadcastBandVoodoo).
  const drop = (pool: BrowserBandPool | null): BrowserBandPool | null => {
    boot.browserPool = pool;
    return pool;
  };
  try {
    refresh.syncWorkersFromCvar();
  } catch {
    return drop(null);
  }
  if (!refresh.isWorkersActive()) return drop(null);
  if (!browserPoolAvailable()) return drop(null);
  const bands = Math.floor(getCVarNumber('sw_workers'));
  const want = workers === undefined ? bands - 1 : workers;
  const n = Math.max(1, Math.min(7, Math.floor(want)));
  if (!Number.isFinite(n)) return drop(null);
  const pool = BrowserBandPool.create(n, host.fb.width, host.fb.height);
  if (!pool) return drop(null);
  refresh.attachWorkerPool(pool);
  return drop(pool);
}

/**
 * Transfer the frame's single VoodooState snapshot to every worker band
 * (astra §5 shell side): same snapshot values + absolute y0/y1 per band,
 * so a future worker-side voodoo backend rasterises with global dither
 * phase. Feature-detected (`as unknown as`) so the shell works with or
 * without a pool (or with a pool predating `broadcastVoodooState`):
 * absent/unavailable → 0, never throws. The current raster loop ignores
 * the stash — the shell still waits for ALL bands, then runs the ONE
 * global serial resolve in `resolveDisplay`.
 */
export function broadcastBandVoodoo(boot: PlayBoot, st: VoodooState): number {
  try {
    const pool = boot.browserPool as unknown as {
      broadcastVoodooState?: (state: VoodooState) => unknown;
    } | null;
    const fn = pool?.broadcastVoodooState;
    if (typeof fn !== 'function') return 0;
    const sent = fn.call(pool, st);
    return typeof sent === 'number' && Number.isFinite(sent) ? sent : 0;
  } catch {
    return 0;
  }
}

/**
 * Advance the sim exactly like Host.frame (same dt clamp, same cmd build,
 * same 10Hz ticks, same snapshot ingest, same owned-cmds stream, same
 * offline branch) using only public Host APIs. Cited: @q2/host frame().
 */
export function stepAsyncSim(host: Host, st: AsyncLoopState, nowMs: number): void {
  if (st.lastNow < 0) st.lastNow = nowMs;
  let dt = (nowMs - st.lastNow) / 1000;
  st.lastNow = nowMs;
  if (!(dt >= 0) || dt > 0.25) dt = 0.016;

  const msec = Math.max(1, Math.round(dt * 1000));
  host.lastCmd = buildUserCmd(host.input, msec, {
    sensitivity: getCVarNumber('sensitivity') || 3,
    mYaw: getCVarNumber('m_yaw') || 0.022,
    mPitch: getCVarNumber('m_pitch') || 0.022,
  });

  st.serverAcc += dt;
  while (st.serverAcc >= SERVER_DT) {
    st.serverAcc -= SERVER_DT;
    // Host.serverTick inlined (public fields only): advance time, step the
    // driver with the latest cmd, ingest the authoritative snapshot.
    host.serverTime += SERVER_DT;
    const driver = host.driver;
    if (driver) {
      const cmd: UserCmdT = host.lastCmd ?? {
        msec: Math.max(1, Math.round(SERVER_DT * 1000)),
        angles: [...host.input.angles] as [number, number, number],
        forwardmove: 0,
        sidemove: 0,
        upmove: 0,
        buttons: 0,
      };
      driver.step(cmd, SERVER_DT);
      const snap: Snapshot = driver.snapshot(host.serverTime);
      host.ingestSnapshot(snap);
      const local = snap.entities.find((e) => e.id === host.localPlayerId);
      if (local) {
        host.playerOrigin = [...local.origin] as [number, number, number];
        host.playerVelocity = [...local.velocity] as [number, number, number];
      }
    } else {
      host.ingestSnapshot({
        serverTime: host.serverTime,
        entities: [
          { id: host.localPlayerId, origin: [...host.playerOrigin], velocity: [...host.playerVelocity] },
        ],
      });
    }
  }
  if (host.lastCmd) {
    st.ownedCmds.push({
      msec: host.lastCmd.msec,
      angles: [...host.lastCmd.angles],
      forwardmove: host.lastCmd.forwardmove,
      sidemove: host.lastCmd.sidemove,
      upmove: host.lastCmd.upmove,
      buttons: host.lastCmd.buttons,
    });
    if (st.ownedCmds.length > 120) st.ownedCmds.splice(0, st.ownedCmds.length - 120);
    host.predictor.setPendingCmds(st.ownedCmds);
  }
  if (!host.driver && getCVarNumber('cl_predict') !== 0 && host.lastCmd) {
    const step = msec / 1000;
    host.playerVelocity[0] = host.lastCmd.forwardmove * 0.5;
    host.playerVelocity[1] = host.lastCmd.sidemove * 0.5;
    host.playerOrigin[0] += host.playerVelocity[0] * step;
    host.playerOrigin[1] += host.playerVelocity[1] * step;
  }
}

/**
 * Build the current predicted/interpolated view + renderables exactly like
 * Host.renderCurrentView (same ducked-eye rule, same one-tick kick, same
 * driver hooks, same eye-anchored viewmodel). `remainder` is the async
 * loop's sub-tick remainder (mirrors Host's serverTime + serverAcc render
 * clock). Cited: @q2/host renderCurrentView().
 */
export function buildAsyncView(host: Host, remainder = 0): { view: RefDef; renderables: Entity[] } {
  const now = host.serverTime + remainder;
  const entities = host.predictor.renderEntities(now, host.localPlayerId);
  let base: [number, number, number] = host.playerOrigin;
  if (host.driver) {
    const local = entities.find((e) => e.id === host.localPlayerId);
    if (local) base = local.origin;
  }
  const viewBase: [number, number, number] = host.lastCmd
    ? [host.lastCmd.angles[0], host.lastCmd.angles[1], host.lastCmd.angles[2]]
    : [0, 0, 0];
  const kick = host.driver?.viewKick?.() ?? null;
  const angles: [number, number, number] = kick
    ? [viewBase[0] + kick.angles[0], viewBase[1] + kick.angles[1], viewBase[2] + kick.angles[2]]
    : viewBase;
  const drvPm = (host.driver as unknown as { pm?: { viewheight?: unknown } } | null)?.pm;
  const drvView = typeof drvPm?.viewheight === 'number' ? drvPm.viewheight : null;
  const ducked = drvView !== null ? drvView !== 22 : (host.lastCmd ? (host.lastCmd.buttons & 8) !== 0 || host.lastCmd.upmove < 0 : false);
  let eye = calcViewOrigin(base, ducked);
  if (kick) eye = [eye[0] + kick.origin[0], eye[1] + kick.origin[1], eye[2] + kick.origin[2]];
  const view: RefDef = {
    origin: new Float32Array(eye) as RefDef['origin'],
    angles: new Float32Array(angles) as RefDef['angles'],
    fovX: 90,
    time: host.serverTime,
    lightStyles: new Float32Array(256).fill(1),
  };
  const renderables: Entity[] = entities
    .filter((e) => e.id !== host.localPlayerId)
    .map((e) => {
      const handles = host.driver?.entityModel?.(e.id) ?? null;
      const ea = host.driver?.entityAngles?.(e.id) ?? null;
      return {
        model: handles?.model ?? 0,
        origin: new Float32Array(e.origin) as Entity['origin'],
        angles: new Float32Array(ea ?? [0, 0, 0]) as Entity['angles'],
        frame: host.driver?.entityFrame?.(e.id) ?? 0,
        skin: handles?.skin ?? 0,
      };
    });
  const extras = host.driver?.extraEntities?.() ?? null;
  if (extras) {
    for (const x of extras) {
      renderables.push({
        model: x.model ?? 0,
        origin: new Float32Array(x.origin) as Entity['origin'],
        angles: new Float32Array(x.angles ?? [0, 0, 0]) as Entity['angles'],
        frame: x.frame ?? 0,
        skin: x.skin ?? 0,
        ...(x.oldframe !== undefined ? { oldframe: x.oldframe } : {}),
        ...(x.backlerp !== undefined ? { backlerp: x.backlerp } : {}),
        ...(x.alpha !== undefined ? { alpha: x.alpha } : {}),
      });
    }
  }
  const vm = host.driver?.viewModel?.() ?? null;
  if (vm && view.fovX <= 90) {
    const gunDelta = host.driver?.gunAnglesDelta?.() ?? null;
    const gunAngles: [number, number, number] = gunDelta
      ? [angles[0] + gunDelta[0], angles[1] + gunDelta[1], angles[2] + gunDelta[2]]
      : angles;
    renderables.push({
      model: vm.model,
      origin: new Float32Array(eye) as Entity['origin'],
      angles: new Float32Array(gunAngles) as Entity['angles'],
      frame: vm.frame,
      skin: vm.skin,
      depthHack: true,
    });
  }
  return { view, renderables };
}

/**
 * One async play-loop frame (the browser rAF body): pumps, sim, async
 * render, resolve. Returns the display buffer (same contract as
 * resolveDisplay). The dom tick keeps HUD + blit + sound after the await.
 *
 * V2d: `hud` threads through to `resolveDisplay` for the strict-voodoo
 * pre-scanout HUD composition; omit it (or run legacy/software) and HUD is
 * painted post-resolve by the caller as before.
 *
 * Voodoo modes snapshot ONE VoodooState per frame (astra §5): the snapshot
 * is broadcast to every worker band BEFORE the raster kick
 * (`broadcastBandVoodoo`, absolute y0/y1) and threaded into
 * `resolveDisplay`, so bands and the single global serial scanout share one
 * frame state. Software mode snapshots nothing.
 */
export async function frameAsync(boot: PlayBoot, st: AsyncLoopState, nowMs: number, hud?: HudState): Promise<Uint32Array> {
  const frameState = getCVarString('vid_renderer') === 'voodoo' ? snapshotVoodooState() : undefined;
  if (frameState !== undefined) broadcastBandVoodoo(boot, frameState);
  pumpMuzzleLight(boot);
  pumpExplosionLights(boot);
  pumpTracers(boot);
  stepAsyncSim(boot.host, st, nowMs);
  const { view, renderables } = buildAsyncView(boot.host, st.serverAcc);
  boot.refresh.beginFrame();
  await boot.refresh.renderViewAsync(view, boot.host.world, renderables);
  await boot.refresh.endFrameAsync();
  return resolveDisplay(boot, hud, frameState);
}
