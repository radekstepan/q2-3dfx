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
  drawField,
  drawPic,
  drawString,
  executeStatusbar,
  buildHelpLayout,
  centerPrintPlacement,
  fillRect,
  helpIconFor,
  HELP_ICON_PIC,
  lerpAngle,
  makeConcharsFont,
  parseStatusbar,
  setConcharsFont,
  stringWidth,
  loadConcharsFont as loadConcharsPixels,
} from '@q2/client';
import type { ConcharsFont, DigitPics, HelpFacts, IndexedPic, StatusbarState } from '@q2/client';
import {
  STAT_AMMO,
  STAT_ARMOR,
  STAT_HEALTH,
  STAT_SELECTED_ICON,
  STAT_PICKUP_ICON,
  STAT_PICKUP_STRING,
  STAT_TIMER,
  STAT_HELPICON,
  STAT_FLASHES,
} from '@q2/client';
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
  SV_DrainCenterprints,
  SV_ClearFinished,
  MASK_OPAQUE_C,
} from '@q2/server';
import type { ServerState, ServerMonster, ServerBarrel, ServerBolt, ServerExplosion, ServerDebris, ServerGib } from '@q2/server';
import { ATTN_NORM, Mixer } from '@q2/sound';
import { parseMD2, parseWAL, parsePCX } from '@q2/formats';
import type { Pcx } from '@q2/formats';

import { AngleVectors, v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import { SERVER_DT, getCVar, getCVarNumber, getCVarString, registerCVar } from '@q2/config';
import type { Entity, GpuLight, GpuRendererStatus, GpuSceneInput, RefDef, ResolvedBackend } from '@q2/renderer-api';
import type { GpuCapability } from '@q2/renderer-api';

/**
 * Renderer selection (RELEASE-8): `software` | `webgl2-experimental`
 * (alias of `ResolvedBackend` from `@q2/renderer-api`, the single source
 * of truth — the legacy CPU `voodoo` id migrates to `software` with a
 * warning, never auto-promoted). The GPU id is experimental and
 * capability-gated — see `resolveBootRenderer` in `./gpu-select.ts`.
 */
export type RendererKind = ResolvedBackend;
export { detectGpuCapability, getGpuStatus, resolveBootRenderer };
export type { GpuCapability };
import { readPakEntry } from './pak.js';
import type { WebPak } from './pak.js';
import { BrowserBandPool, browserPoolAvailable } from './render-workers.js';
import type { DiagSnapshot, KickTiming } from './render-workers.js';
import { detectGpuCapability, getGpuStatus, resolveBootRenderer } from './gpu-select.js';
import { acquireGpuCanvas, attachGpuCanvasLifecycle, hasGpuCanvasLifecycle, removeGpuCanvas, setGpuCanvasSize, setHudTransparent, syncGpuCanvasToHud } from './gpu-canvas.js';
import { modelKindsForFrame, synthesizeBeamEntities } from './gpu-effects.js';
import { WebGLRenderer, fullWorldRefs, refreshGpuScene, selectGpuScene } from '@q2/webgl-renderer';

/**
 * Per-frame GPU scene refresh (GPU-FOLLOW-2): the committed `refreshGpuScene`
 * (fresh world PVS/frustum/backface selection + combined transparent order).
 * A static import of a missing export already fails the bundle load; this
 * runtime pin fails loudly with the reason instead of silently falling back
 * to a frozen spawn-view subset (forbidden by the card).
 */
if (typeof refreshGpuScene !== 'function') {
  throw new Error(
    'play(frameGpuPlay): refreshGpuScene missing from @q2/webgl-renderer — refusing frozen-subset rendering (GPU-FOLLOW-2)',
  );
}

/**
 * Which resolve path the last `resolveDisplay` took (observability for
 * tests/debug). RELEASE-8: the CPU software resolve only —
 * `software-passthrough` (brightness 1.0, engine buffer by reference) or
 * `software-lifted` (post-resolve `r_brightness` copy). The legacy CPU
 * voodoo scanout is retired; WebGL2 owns appearance via `vd_*` uniforms.
 */
export type ResolveOrder =
  | 'none'
  | 'software-passthrough'
  | 'software-lifted';

/**
 * Rotate a baked brush-model vertex about a pivot by Quake delta angles
 * (degrees [pitch, yaw, roll]). Render-side twin of the server's angular
 * movers (func_door_rotating): v' = pivot + dx*F - dy*R + dz*U, the
 * R_AliasSetUpTransform basis the alias backend already uses — an identity
 * delta is the identity, so closed rotators render bit-identical to the
 * baked verts. Pure (no sim state); covered by door-rotation.test.ts.
 *
 * Direction-vector form: rotateDoorVert(n, ORIGIN_ZERO, delta) rotates a
 * normal with no translation (R*n). The rotating-door sync uses this for
 * face normals so backface culling stays correct mid-swing.
 */
const ORIGIN_ZERO: Vec3 = (() => {
  const v = v3();
  v[0] = 0;
  v[1] = 0;
  v[2] = 0;
  return v;
})();
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
// engine produced is unchanged. Registered here (apps/web owns the display
// path); `getBrightness`
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

registerCVar('vid_resolution', RESOLUTION_DEFAULT, 'internal framebuffer WxH (resizes in place, no reboot)');

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
  registerCVar('vid_resolution', RESOLUTION_DEFAULT, 'internal framebuffer WxH (resizes in place, no reboot)');
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
 * One sampled explosion step (C cl_tent.c CL_AddExplosions, ex_misc/ex_poly).
 *
 * C mapping, replicated exactly:
 * - visible while `0 <= age < (frames-1)*0.1` (ex_misc frees at f>=3,
 *   ex_poly at f>=frames-1 — one 100ms step SHORTER than the nominal frame
 *   count, so a 15f boom shows f=0..13 as frame/oldframe pairs 1/0..14/13).
 * - `frame = baseframe + f + 1`, `oldframe = baseframe + f` (the visible
 *   pair, never a bare baseframe hold).
 * - blend `backlerp = frac` (0 at the step start = fully oldframe, 1 at the
 *   step end = fully frame). C's wire `backlerp = 1 - cl.lerpfrac` reads
 *   inverted, but BOTH renderers in this repo consume the slot as a
 *   front-lerp (`sw-renderer/frame.ts` RF_FRAMELERP block,
 *   `webgl-renderer/alias.ts` resolveAliasLerp: out = A + (B-A)*t), so the
 *   value emitted here is what renders C-identical on the actual backends.
 *   TODO(renderer-lanes): reconcile the frozen §5 doc ("1 = fully
 *   oldframe") with the front-lerp consumption both backends implement.
 * - alpha: ex_misc `1 - frac/(frames-1)` (linear 1→0 over the 3 live steps);
 *   ex_poly `(16-f)/16` (never fully 0 while visible).
 * - skinnum (ex_poly only, the r_explode skin1..7 cycle): f<10 → f>>1,
 *   f<13 → 5, else 6 (the f>=10 TRANSLUCENT flag rides Entity.alpha here).
 */
export interface ExplosionStep {
  frame: number;
  oldframe: number;
  backlerp: number;
  alpha: number;
  visible: boolean;
  /** ex_poly skin cycle 0..6 (skin1..7); 0 for the single-skin blaster flash. */
  skinnum: number;
}

export function explosionStepFor(kind: ExplosionKind, baseframe: number, age: number): ExplosionStep {
  const frames = explosionFrames(kind);
  const step = age / 0.1;
  const f = Math.floor(step);
  const frac = step - f;
  const visible = age >= 0 && step < frames - 1 - 1e-6;
  if (!visible) {
    return { frame: baseframe + 1, oldframe: baseframe, backlerp: 0, alpha: 0, visible: false, skinnum: 0 };
  }
  const alpha =
    kind === 'blaster'
      ? Math.max(0, Math.min(1, 1 - step / (frames - 1)))
      : Math.max(0, Math.min(1, (16 - f) / 16));
  const skinnum = kind === 'blaster' ? 0 : f < 10 ? f >> 1 : f < 13 ? 5 : 6;
  return {
    frame: baseframe + f + 1,
    oldframe: baseframe + f,
    backlerp: Math.max(0, Math.min(1, frac)),
    alpha,
    visible: true,
    skinnum,
  };
}

/**
 * Trail/impact spark lifetime in server seconds. id's CL_BlasterParticles
 * fade in a fraction of a second; world-seeded particles (devroom torch
 * flame, born +Infinity) never expire.
 */
export const SPARK_TTL = 0.4;

/**
 * C target_splash color table (client/cl_tent.c splash_color[7], indexed by
 * the lump `sounds` byte). Base1 uses 1 (SPARKS, yellow 0xe0) everywhere.
 */
export const SPLASH_COLORS = [0x00, 0xe0, 0xb0, 0x50, 0xd0, 0xe0, 0xe8] as const;

/** Lump `sounds` value selecting the SPARKS (electrical) splash (q_shared.h). */
export const SPLASH_SPARKS = 1;

/** Spark burst sounds (cl_tent.c TE_SPLASH: spark5/6/7 at ATTN_STATIC). */
export const SPLASH_SPARK_SOUNDS = ['world/spark5.wav', 'world/spark6.wav', 'world/spark7.wav'] as const;

/**
 * G_SetMovedir (game/g_utils.c) by value: lump `angle` -1 aims up, -2 aims
 * down, anything else is the forward vector of (pitch 0, yaw angle, roll 0).
 * TODO(server): canonical home is a server-side use_target_splash/func_timer
 * producer; this helper only orients the web-lane ambient replication.
 */
export function splashMovedir(angleDeg: number): Vec3 {
  if (angleDeg === -1) return v3(0, 0, 1);
  if (angleDeg === -2) return v3(0, 0, -1);
  const fwd = v3();
  const right = v3();
  const up = v3();
  AngleVectors(v3(0, angleDeg, 0), fwd, right, up);
  return v3(fwd[0], fwd[1], fwd[2]);
}

/** One ambient splash spark (CL_ParticleEffect distribution, by value). */
export interface SplashSpark {
  pos: Vec3;
  vel: Vec3;
  color: number;
  ttl: number;
}

/**
 * CL_ParticleEffect (client/cl_fx.c) by value: `count` sparks around `pos`,
 * each offset ((rand&7)-4) + d*dir with d=(rand&31), velocity crand*20 per
 * axis (gravity-stepped by the driver's ballistic path), color
 * `colorBase+(rand&7)`, life 0.5+frand*0.3 (alphavel -1/(0.5+frand*0.3)).
 * TODO(server): consume the server lane's target_splash producer once it
 * lands; until then the driver replicates the distribution here.
 */
export function splashBurst(
  rand: () => number,
  pos: Vec3,
  dir: Vec3,
  count: number,
  colorBase: number,
): SplashSpark[] {
  const out: SplashSpark[] = [];
  for (let i = 0; i < count; i++) {
    const d = (rand() * 32) | 0;
    out.push({
      pos: v3(
        pos[0]! + (((rand() * 8) | 0) - 4) + d * dir[0]!,
        pos[1]! + (((rand() * 8) | 0) - 4) + d * dir[1]!,
        pos[2]! + (((rand() * 8) | 0) - 4) + d * dir[2]!,
      ),
      vel: v3((rand() * 2 - 1) * 20, (rand() * 2 - 1) * 20, (rand() * 2 - 1) * 20),
      color: colorBase + ((rand() * 8) | 0),
      ttl: 0.5 + rand() * 0.3,
    });
  }
  return out;
}

/**
 * Impact-flash dlight window in server seconds. TE_BLASTER's ex_misc lives
 * f<3 (cl_tent.c frees at f>=frames-1=3): 0.3s of 150*alpha yellow, not a
 * single 100ms tick — the boom window below matches the same rule.
 */
export const EXPLOSION_LIGHT_WINDOW = 0.3;

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
  /**
   * Rest face normals (FOLLOW-2 winding audit): rotating doors rotate `fn`
   * with the verts, so the CPU backface rule and the frustum test stay
   * correct mid-swing. Translating movers never change normals.
   */
  baseFn: Float32Array[];
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
  /**
   * Severity tag for the transient status line (RELEASE-11
   * `cl_showmessages`): 'status' = cosmetic gameplay one-liners (kills,
   * pickups, weapon swaps, dry-fire); 'alert' = the death notice. The
   * render gate hides ONLY 'status' when the cvar is 0 — death, the
   * finished screen and loading/fallback warnings always draw. Every
   * cosmetic producer passes 'status' explicitly; `setMessage('')` clears
   * reset to 'status', and `respawn()` resets to 'status' with the clear.
   * The finished-screen mirror leaves the kind as-is (that branch never
   * consults the gate — it keys off `server.finished`).
   */
  messageKind: 'status' | 'alert' = 'status';
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
  /**
   * Ambient electrical sparks (RELEASE-9 box 3): base1's 12 target_splash
   * emitters fire on server-side func_timer cadence (START_ON timers target
   * t1/t2/t3/t41/t48..t54), independent of doors — the *19 door and *20
   * glass chains carry no splash (t69 areaportal / t78 glass speaker).
   * Single-sim rule: the SERVER owns the producers (SV_Tick timer think +
   * fireSplashTarget → st.sparks/st.sounds, drained below); the driver only
   * renders. The pure splashBurst/splashMovedir helpers below remain as
   * tested distribution mirrors, never ticked here.
   */
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
    // Finished-screen mirror (RELEASE-11 essential path): the stats screen
    // text updates every tick even while cosmetic messages hide — the
    // render gate keys off `server.finished`, never `messageKind`, so the
    // kind is deliberately left as-is here.
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
    // Ambient func_timer → target_splash sparks/sounds arrive through the
    // same server drains (single-sim: no driver-side replication).
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
   * / clears the screen for the new life). The kind tags the severity for
   * the RELEASE-11 `cl_showmessages` render gate (cosmetic 'status' hides,
   * death 'alert' never does); backward compatible — omitting it keeps the
   * cosmetic default.
   */
  private setMessage(s: string, kind: 'status' | 'alert' = 'status'): void {
    if (!this.server.finished) {
      this.message = s;
      this.messageKind = kind;
    }
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
      // RELEASE-11 essential path: the death notice is 'alert' severity, so
      // the `cl_showmessages` render gate never hides it.
      this.message = 'YOU DIED — respawning…';
      this.messageKind = 'alert';
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
          this.setMessage(`${m.state.kind} minced`, 'status');
        }
      } else if (m.state.dead) {
        if (!this.deadSeen.has(m.edict.num)) {
          this.deadSeen.add(m.edict.num);
          this.events.push('kill');
          this.setMessage(`${m.state.kind} down`, 'status');
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
        this.setMessage('corpse minced', 'status');
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
    // Sparks: impact/trail/boom bursts into the particle pool. A non-empty
    // server spark drain also raises the 'splash' event (ambient timer
    // showers surface here; single-sim: the server owns the producers).
    {
      let n = 0;
      for (const s of SV_DrainSparks(this.server)) {
        if (s.vel) this.pushBallisticSpark(v3(s.pos[0], s.pos[1], s.pos[2]), v3(s.vel[0], s.vel[1], s.vel[2]), s.color, s.ttl);
        else this.pushColoredSpark(v3(s.pos[0], s.pos[1], s.pos[2]), s.color, s.ttl);
        n++;
      }
      if (n > 0) this.events.push('splash');
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
    // Trigger/entity centerprints (R9F-6, G_UseTargets message branch):
    // driver-readable queue → status line (kind 'status', so the RELEASE-11
    // toggle gates these hints like other cosmetic text; death/finish never
    // flow through here). Last line wins, like the status line it shares.
    for (const line of SV_DrainCenterprints(this.server)) {
      this.setMessage(line, 'status');
    }
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
      // C cl_tent.c CL_AddExplosions via explosionStepFor: frame/oldframe =
      // baseframe+f+1/baseframe+f (never a bare baseframe hold), renderer
      // front-lerp backlerp = frac, ex_poly alpha (16-f)/16, ex_misc linear
      // 1→0 over its 3 live steps, r_explode skinnum cycle. Freed-sky bolts
      // never reach this list (the server frees them silently with no
      // explosion record), so no remnant renders here.
      for (const e of this.server.explosions) {
        const age = this.server.time - e.born;
        const step = explosionStepFor(e.kind, e.baseframe, age);
        if (!step.visible) continue;
        // TE_EXPLOSION1/2 render the r_explode MD2 (cl_mod_explo4, 15f/19f);
        // TE_BLASTER's 4f ex_misc renders the explode MD2 (cl_mod_explode).
        const isBlast = e.kind === 'blaster';
        out.push({
          origin: [e.pos[0]!, e.pos[1]!, e.pos[2]!],
          angles: [0, e.yaw, 0],
          model: isBlast ? this.models.blast : this.models.explode,
          skin: isBlast ? this.models.blastSkin : this.explosionSkinFor(step.skinnum),
          frame: step.frame,
          oldframe: step.oldframe,
          backlerp: step.backlerp,
          alpha: step.alpha,
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
      this.setMessage('NO WEAPON', 'status');
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
    this.setMessage(classname.replace(/_/g, ' '), 'status');
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
   * Null once the level finishes (RELEASE-6 intermission-lite: id
   * `MoveClientToIntermission` drops `ps.gunindex` to 0 — gun down, no world
   * interaction; the 2D silhouette honors the same gate in `drawViewModel`).
   * The 0.09s muzzleLit window is dlight/HUD-only (flash + 2D icon glow).
   */
  viewModel(): { model: number; skin: number; frame: number } | null {
    if (this.server.finished) return null;
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
   * Light-style brightness scale for the host RefDef (R9F-3, HostDriver
   * contract): id `CL_SetLightstyle` maps style letters to
   * `(c-'a')/('m'-'a')`, so 'm' is 1 and 'a' is 0; unrecorded styles read
   * 1. The server owns the toggle records; both live view builders
   * (host.frame + frameGpuPlay) resolve through this hook.
   */
  lightStyleScale(style: number): number {
    const rec = this.server.lightStyles[style];
    if (typeof rec !== 'string' || rec.length === 0) return 1;
    return (rec.charCodeAt(0) - 97) / 12;
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
    // RELEASE-1: pull the normalized s_volume into the mixer every tick so
    // no route bypasses the 0..0.05 cap. mix() applies the reference gain once.
    try {
      this.mixer.syncMasterVolFromConfig();
    } catch {
      /* headless/test mixer without config — keep current masterVol */
    }
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
    // New life, clear screen: the kind resets to cosmetic 'status' with it
    // (a stale death 'alert' must never leak into the next life's gating).
    this.message = '';
    this.messageKind = 'status';
    this.events.push('respawn');
    this.playerEdict.origin = v3(this.pm.origin[0], this.pm.origin[1], this.pm.origin[2]);
  }

  /** Walk-over pickups: item/weapon/ammo edicts grant via pickupItem.
   * Skill-inhibited (DM-only 1792 at every SP skill) and freed edicts are
   * skipped, mirroring extraEntities/livePickupCount (spawnflags read from
   * the lump dict in extra — the numeric field is C-stripped post-spawn). */
  private checkPickups(): void {
    if (this.playerDead) return;
    // RELEASE-6 intermission-lite: a finished level takes no more input —
    // id `MoveClientToIntermission` drops the body to SOLID_NOT so touches
    // stop; pickups/items freeze with the stats screen.
    if (this.server.finished) return;
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
      this.setMessage(c.replace(/_/g, ' '), 'status');
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
        this.doors.push({
          ent, rest, restAngles, rotates, model: n, faces,
          baseVerts, baseCenter, baseMins, baseMaxs,
          baseFn: faces.map((s) => new Float32Array(s.fn)),
        });
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
        s.fn.set(d.baseFn[i]!);
      }
      return;
    }
    // Pivot at the door origin: direction vectors rotate about `rest` with
    // no translation component (the pivot is fixed for pure rotation).
    const fnTmp = v3();
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
      // Normals rotate with the verts as pure directions (about the origin:
      // rotateDoorVert(n, 0, delta) == R*n with no translation). Rotating
      // about the door pivot would leak translation into the normal. Without
      // this the CPU backface rule culls the wrong side mid-swing and newly
      // revealed faces stay hidden.
      const bf = d.baseFn[i]!;
      fnTmp[0] = bf[0]!;
      fnTmp[1] = bf[1]!;
      fnTmp[2] = bf[2]!;
      rotateDoorVert(fnTmp, ORIGIN_ZERO, delta, fnTmp);
      s.fn[0] = fnTmp[0]!;
      s.fn[1] = fnTmp[1]!;
      s.fn[2] = fnTmp[2]!;
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
    // RELEASE-6 intermission-lite: no world interaction once finished.
    if (this.server.finished) return;
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
    // RELEASE-6 intermission-lite: the trigger goes dead with the level
    // (gun down via `viewModel`, no shots, no dry-fire, no refire latch).
    if (this.server.finished) return;
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
      this.setMessage('NO AMMO', 'status');
      this.events.push('empty');
      this.lastShotAt = t;
      return;
    }
    if (this.weapon.ammoKind) this.setAmmo(this.weapon.ammoKind, res.ammoLeft);
    this.lastShotAt = t;
    this.setMessage('', 'status');
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
   * Drain live explosion flashes for the dlight pump. Both kinds burn for
   * their full C life ((frames-1)*0.1: 0.3s blaster, 1.4/1.8s booms) with
   * the C alpha fade (ex_poly (16-f)/16, ex_misc linear). Returns pos +
   * kind + alpha so the pump can pick the authentic light per kind. Backed
   * by the server explosion list (pruned server-side by frame life).
   */
  drainExplosions(): Array<{ pos: Vec3; kind: ExplosionKind; alpha: number }> {
    const out: Array<{ pos: Vec3; kind: ExplosionKind; alpha: number }> = [];
    for (const e of this.server.explosions) {
      const step = explosionStepFor(e.kind, e.baseframe, this.server.time - e.born);
      if (!step.visible) continue;
      out.push({ pos: e.pos, kind: e.kind, alpha: step.alpha });
    }
    return out;
  }

  /**
   * r_explode skin for a C ex_poly skinnum (0..6 → skin1..skin7). Degrades to
   * the registered skin1 when the cycle registration is short (fallback
   * pak) or the stub predates explodeSkins (older test fixtures).
   */
  explosionSkinFor(skinnum: number): number {
    if (!this.models) return 0;
    if (skinnum <= 0) return this.models.explodeSkin;
    const cycled = this.models.explodeSkins?.[skinnum - 1];
    return cycled ?? this.models.explodeSkin;
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

  /**
   * Test hook: live ambient splash emitters (target_splash count, off the
   * server roster — single-sim: the server owns the producers).
   */
  ambientSplashSources(): number {
    let n = 0;
    for (const list of this.server.splashes.values()) n += list.length;
    return n;
  }

  /** Test hook: live ambient splash timers (START_ON func_timer count). */
  ambientSplashTimers(): number {
    let n = 0;
    for (const t of this.server.timers) {
      if (!t.ent.freed && (t.ent.spawnflags & 1) !== 0 && t.target) n++;
    }
    return n;
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

/**
 * Derive the retained GPU sky from the pak + map (GPU-FOLLOW-3A): single
 * read of the six `env/<sky>{rt,bk,lf,ft,up,dn}.pcx` faces via `loadSkyStrip`,
 * converted to PER-FACE tile dims for `registerSkyStrip` (which takes the
 * single-face height, not the strip's total height). Returns `{ sky, warning
 * }`: `sky` null = flat-fill fallback with a diagnosable `warning` naming
 * the sky key or the missing/invalid art (devroom/no-pak is also a warning).
 * Never throws; never re-reads per frame (call once per boot/map).
 */
export function retainedSkyFromPak(
  pak: WebPak | null,
  map: BspMap | null,
  mainPalette: Uint8Array | null,
): { sky: RetainedSky | null; warning: string | null } {
  try {
    if (!pak || !map || !mainPalette) {
      return { sky: null, warning: 'no map sky (devroom or missing palette/pak: flat sky fallback)' };
    }
    const name = skyNameForMap(map);
    if (!name) {
      return { sky: null, warning: 'no worldspawn sky key (flat sky fallback)' };
    }
    const strip = loadSkyStrip(pak, name, mainPalette);
    if (!strip) {
      return { sky: null, warning: `sky ${name} missing/invalid env faces (flat sky fallback)` };
    }
    if (!Number.isInteger(strip.height / 6) || strip.width <= 0 || strip.height <= 0) {
      return { sky: null, warning: `sky ${name} has non-divisible strip height ${strip.height} (flat sky fallback)` };
    }
    const tileH = strip.height / 6;
    return {
      sky: { name, texels: strip.texels.slice(), tileW: strip.width, tileH },
      warning: null,
    };
  } catch (err) {
    return { sky: null, warning: `sky load failed (${err instanceof Error ? err.message : String(err)}: flat sky fallback)` };
  }
}

/**
 * Register the boot's retained sky with the live GPU backend (GPU-FOLLOW-3A):
 * textured path calls `registerSkyStrip` with PER-FACE dims; fallback path
 * calls `clearSkyStrip` so a previous map's strip never lingers. Idempotent —
 * re-registering drops the obsolete same-context GL texture once via the
 * backend (lazy re-upload on the next sky draw, never per-frame re-reads).
 * Returns true when a textured sky is active, false on the flat fallback.
 * Never throws (structural probe + try/catch: a backend without the entry
 * points keeps the flat fill).
 */
export function syncGpuSky(boot: PlayBoot): boolean {
  const gpu = boot.gpu?.gpu as unknown as {
    registerSkyStrip?: (texels: Uint8Array, tileW: number, tileH: number) => boolean;
    clearSkyStrip?: () => void;
  } | undefined;
  if (!boot.gpu || !gpu) return false;
  try {
    if (boot.sky) {
      if (typeof gpu.registerSkyStrip === 'function') {
        return gpu.registerSkyStrip(boot.sky.texels, boot.sky.tileW, boot.sky.tileH);
      }
      return false;
    }
    if (typeof gpu.clearSkyStrip === 'function') {
      gpu.clearSkyStrip();
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Retained map sky for the GPU backend (GPU-FOLLOW-3A): the `loadSkyStrip`
 * palette-index strip with PER-FACE tile dims (`registerSkyStrip` takes the
 * single-face height, not the six-face strip's total height). Sliced once at
 * boot from the pak; replayed without re-reading on selection/restore.
 */
export interface RetainedSky {
  /** Map `worldspawn` sky key (base1: `unit1_`). */
  name: string;
  /** Palette-index texels: six vertically stacked tiles (rt/bk/lf/ft/up/dn). */
  texels: Uint8Array;
  /** Single-face tile width (strip width). */
  tileW: number;
  /** Single-face tile height (strip height / 6). */
  tileH: number;
}

/**
 * Retained decoded HUD pics (RELEASE-6, apps/web only): everything the
 * asset-based statusbar/F1/completion screens blit, decoded once at boot
 * from the pak via `parsePCX`. Devroom boots hold null (readable conchars
 * fallback instead — never a throw on missing art).
 */
export interface HudPicCache {
  /** Normal (`num_*`, white) + alert (`anum_*`, red) digit sets. */
  digits: { num: DigitPics; anum: DigitPics };
  /** Damage-flash field (`field_3`, 48x24, drawn behind flashing numbers). */
  field3: IndexedPic | null;
  /** Statusbar icons by short name (`i_health`, `w_blaster`, …). */
  icons: Map<string, IndexedPic>;
  /** F1 `help` + inventory backgrounds (256x192 each). */
  help: IndexedPic | null;
  inventory: IndexedPic | null;
  /** Scoreboard dogtags (`tag1`/`tag2`, 128x32). */
  tag1: IndexedPic | null;
  tag2: IndexedPic | null;
  /**
   * End-of-unit plaque (`victory`, 320x240). Decoded for inventory only —
   * NEVER drawn for single-player completion: it is the coop `victory.pcx`
   * plaque (`sv_init.c` gates it on the coop victory level), not SP
   * presentation (RELEASE-6).
   */
  victory: IndexedPic | null;
}

export interface PlayBoot {
  host: Host;
  driver: LocalDriver;
  refresh: SoftwareRenderer;
  renderer: RendererKind;
  /**
   * Explicit fallback warning from the last selection resolve (GPU-PROOF-2):
   * null when the requested `vid_renderer` was honored; non-null explains
   * every fallback (incapable GPU, unknown value). Recorded by `bootPlay`
   * and `applyRendererCvar`, which also `console.warn` it — fallbacks are
   * never silent (see `getGpuStatus` for the read-out).
   */
  lastRendererWarning: string | null;
  source: 'devroom' | 'pak';
  display: Uint32Array;
  /** Which resolve path the last `resolveDisplay` took (see ResolveOrder). */
  lastResolveOrder: ResolveOrder;
  /**
   * Browser worker pool attached by `attachBrowserPool` (null = sync /
   * single-threaded path: headless, no SAB, or `sw_workers` 0). Set once
   * per boot. The pool carries indexed raster/resolve kicks only
   * (RELEASE-8: no CPU voodoo resolve); WebGL2 owns appearance.
   */
  browserPool: BrowserBandPool | null;
  /**
   * `frameAsync` failures the dom.ts rAF tick absorbed via the classic sync
   * fallback (worker timeout, torn-down pool). Incremented in the tick
   * catch only; a healthy soak keeps this at 0. Never throws.
   */
  statAsyncFallbacks: number;
  /** Real-pak MD2/skin handles (null without a pak). */
  models: PakModelHandles | null;
  /** The pak this boot was built from (null = devroom): reboot reuses it. */
  pak: WebPak | null;
  /**
   * Retained map sky for the GPU backend (GPU-FOLLOW-3A): per-face tile dims
   * derived once from `loadSkyStrip` (strip height / 6), never re-read per
   * frame. Null = flat-fill fallback (missing/invalid art or devroom; see
   * `skyWarning`). Re-registered on cold boot, CPU→GPU selection and context
   * restore; replaced/cleared on map change (reboot builds a fresh boot).
   */
  sky: RetainedSky | null;
  /**
   * Diagnosable sky fallback reason (null when a textured sky is retained):
   * names the map sky key or the missing/invalid faces. Also `console.warn`d
   * at boot — never silent.
   */
  skyWarning: string | null;
  /**
   * Live GPU backend (GPU-PROOF-3): non-null exactly when `renderer` is
   * `webgl2-experimental` AND a GL canvas/context was acquired at boot (or
   * hot-swap). `gpu.gpu` is the committed `WebGLRenderer` (clear-only today —
   * the parallel GL lane makes `renderFrame` draw; this file programs ONLY
   * against the committed `GpuRenderer` interface + `selectGpuScene`, never
   * its internals), `gpu.scene` the last submitted scene, `gpu.loop` the
   * async-loop sim clock for GPU frames. Null on every CPU path.
   */
  gpu: GpuBootState | null;
  /**
   * Engine palette bytes (768-byte RGB, from `pics/colormap.pcx`; devroom
   * uses the procedural ramp). Retained for the asset HUD (`drawPic`/
   * `drawField` expand 8-bit art through this, never a re-parse per frame).
   * Null only when neither source produced one (CPU devroom text fallback).
   */
  palette: Uint8Array | null;
  /**
   * Retained decoded HUD pics (RELEASE-6): digit sets, icons, help/inventory
   * backgrounds, scoreboard tags, victory plaque. Null in devroom (readable
   * conchars fallback instead). Built once at boot from the pak.
   */
  hudPics: HudPicCache | null;
  /**
   * F1 help-computer overlay (RELEASE-6): toggled by the F1 key (see
   * `toggleHelpOverlay`; dom.ts wires the browser key). False = HUD only.
   */
  showHelp: boolean;
  /**
   * RELEASE-6 help-change tracking (id `game.helpchanged` vs
   * `pers.game_helpchanged`, `p_view.c` / `p_hud.c: Cmd_Help_f`):
   * `helpChangedSeq` counts help-content changes published for this boot,
   * `helpSeenSeq` the seq acked by opening F1 (`pers.helpchanged = 0`).
   * The server lane carries no `target_help` producer yet, so the counter
   * stays 0 and the statusbar slot never blinks on its own — `helpIconFor`
   * flashes `i_help` only while the seqs differ, at `(serverframe & 8)`.
   * TODO(RELEASE-6): advance `helpChangedSeq` from the server lane when a
   * `target_help` equivalent lands (plus the `misc/pc_up.wav` ≤3 beep path
   * from `G_SetClientSound`, which has no clean driver-sound route yet).
   */
  helpChangedSeq: number;
  helpSeenSeq: number;
}

/**
 * Owned GPU state for a `webgl2-experimental` boot (see `PlayBoot.gpu`).
 * Browser glue owns `canvas`/`gl` acquisition (see `acquireGpuCanvas`); the
 * backend owns GL resources; the shell owns the submitted scene + sim clock.
 */
export interface GpuBootState {
  /** GL canvas element (HTMLCanvasElement in a browser, stub in tests). */
  canvas: unknown;
  /** WebGL2 context (WebGL2RenderingContext in a browser, stub in tests). */
  gl: unknown;
  /** Committed backend (programs against `GpuRenderer`, never internals). */
  gpu: WebGLRenderer;
  /** Last submitted scene (fresh world selection + entity tail, per frame). */
  scene: GpuSceneInput;
  /**
   * Persistent full-map world inventory (GPU-FOLLOW-2 storage side): the
   * `fullWorldRefs` result from `attachGpuBackend` (every triangulable
   * surface, no camera culling — the upload set). `frameGpuPlay` NEVER
   * derives the submitted scene from this; it re-selects per frame via the
   * committed `refreshGpuScene` (world refs fresh for the current view, so
   * `staticGeneration` never changes and uploads stay 1 across N frames).
   * `scene` above remains the last submitted selection. Never mutated after
   * attach.
   */
  staticScene: GpuSceneInput;
  /** Sim clock for GPU frames (mirrors Host privates, like frameAsync). */
  loop: AsyncLoopState;
  /**
   * Last per-frame appearance snapshot (GPU-PROOF-4 live-loop wiring): the
   * pinned `vd_*` cvar values `frameGpuPlay` read that frame. Null until the
   * first GPU frame. The committed `WebGLRenderer` dist exposes no
   * appearance/uniform-setter method yet, so NOTHING consumes this today —
   * it is the observable proof the cvars are re-read every frame (no stale
   * profile). See `pushGpuAppearance` for the one-call-site follow-up when
   * the parallel GL lane lands its setters.
   */
  appearance: GpuAppearanceSnapshot | null;
  /**
   * True between `webglcontextlost` and `webglcontextrestored` (GPU-FOLLOW-4):
   * the GL context is unusable, so `frameGpuPlay` skips submission (returns
   * null) instead of drawing into a dead context. Set/cleared only by
   * `notifyGpuContextLost` / `notifyGpuContextRestored`.
   */
  contextLost: boolean;
  /**
   * Cumulative loss/restore counts (observability for lifecycle tests and
   * the soak leg): repeated events while already lost/restored never
   * double-count (see the `notify*` idempotence pins).
   */
  lossCount: number;
  restoreCount: number;
  /**
   * Removes the canvas `webglcontextlost`/`webglcontextrestored` listener
   * pair (null when never wired). Cleared by `unwireGpuLifecycle` before the
   * backend is disposed so a detached canvas fires nothing.
   */
  disposeLifecycle: (() => void) | null;
}

/**
 * Pinned appearance cvars wired into the GPU live loop (contract §3: the 15
 * `vd_*` + `sw_*` cvars; the GPU backend honors the `vd_*` subset as its
 * appearance uniforms (RELEASE-8: the CPU voodoo execution path these cvars
 * once drove is retired). Read-only here: this module never
 * registers or writes them, so defaults are untouched.
 */
export const GPU_APPEARANCE_CVARS = [
  'vd_gamma',
  'vd_dither',
  'vd_16bit',
  'vd_postfilter',
  'vd_bilinear',
  'vd_mipdither',
  'vd_lodbias',
  'vd_fog',
  'vd_overbright',
  'vd_palettetex',
  'vd_maxtexsize',
  'vd_zbits',
  'vd_dithermode',
  'vd_reconmode',
  'vd_rgbmaxdelta',
] as const;

/** One frame's appearance inputs (stringified cvar values, observable in tests). */
export type GpuAppearanceSnapshot = Record<string, string>;

/** Snapshot every pinned `vd_*` cvar (same read-every-frame rule the retired CPU path used). */
export function readGpuAppearanceSnapshot(): GpuAppearanceSnapshot {
  const snap: GpuAppearanceSnapshot = {};
  for (const name of GPU_APPEARANCE_CVARS) snap[name] = getCVarString(name);
  return snap;
}

/**
 * Candidate future GL-lane appearance setters, probed in order. The committed
 * `WebGLRenderer` reads `vd_*` cvars directly per frame (`resolveAppearanceFrame`
 * — same practice as the CPU renderer), so NO setter is required and the probe
 * below returns false: the frame keeps the recorded `boot.gpu.appearance`
 * snapshot as the authoritative observable record. The probe stays as a pin:
 * should a real setter ever appear, `pushGpuAppearance` routes through it
 * (single call site; do NOT change cvar defaults).
 */
export const GPU_APPEARANCE_HOOKS = [
  'setAppearance',
  'applyAppearance',
  'setCvars',
] as const;

/** Structural signature of a future appearance setter (narrow — never `any`). */
type GpuAppearanceHook = (snapshot: GpuAppearanceSnapshot) => void;

/**
 * Push the per-frame appearance snapshot into the backend when it exposes a
 * known setter (feature-detected via `in` + `typeof`, structural — never
 * `any`). Returns true when a setter consumed the snapshot, false when the
 * backend has no such method (the snapshot on `boot.gpu.appearance` stays the
 * authoritative record). Never throws: a throwing future hook must not break
 * the frame loop.
 */
export function pushGpuAppearance(gpu: object, snapshot: GpuAppearanceSnapshot): boolean {
  const rec = gpu as unknown as Record<string, unknown>;
  for (const name of GPU_APPEARANCE_HOOKS) {
    if (name in rec && typeof rec[name] === 'function') {
      try {
        (rec[name] as GpuAppearanceHook).call(gpu, snapshot);
      } catch {
        /* backend keeps its last good state; the snapshot stays authoritative */
      }
      return true;
    }
  }
  return false;
}

/* --- GPU-PROOF-4 live-loop gaps (NOT done — none presented as done) ---------
 *
 * The live loop wires cvars + HUD order + submission proof ONLY (no shader
 * work — that is the parallel GL lane's). Everything below is a concrete
 * per-call-site follow-up with its owner:
 * - Appearance uniforms: the backend reads `vd_*` cvars directly per frame
 *   (`resolveAppearanceFrame`); `pushGpuAppearance` above is the single call
 *   site if an explicit setter ever appears (settled PROOF-4 design).
 * - Sprite/particle live-pool mirroring: the renderer supports them and the
 *   page proves them, but the live loop drains only tracer beams per frame
 *   (PROOF-3 report; owner: EXPAND).
 * - Context-loss re-upload: loss records + skips per contract, and the live
 *   loop re-attaches world/palette/models after restore via the retained
 *   FOLLOW-2A replay (`notifyGpuContextRestored`, GPU-FOLLOW-4 app side).
 *   Same-context replacement duplication is the GL lane's (renderer.ts).
 * - Hot-swap asset migration: entering webgl2 mid-session attaches world +
 *   palette AND replays the retained MD2/PCX cache under existing handles
 *   (`replayPakAssetsToGpu`, GPU-FOLLOW-2A) — entities no longer stay
 *   mesh-less after a CPU→GPU switch.
 * - GPU-resident HUD: the overlay stays a CPU `paintHudOverlay` blit above
 *   the GL canvas by design here (owner: EXPAND).
 */

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
  /**
   * r_explode skins skin2..skin7 (the C ex_poly skinnum cycle: f<10 → f>>1,
   * f<13 → 5, else 6). Appended after every pre-existing handle so no
   * numeric handle shifts; may be shorter than 6 on fallback (the lookup
   * degrades to explodeSkin).
   */
  explodeSkins: number[];
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
  /**
   * Retained parsed asset data (GPU-FOLLOW-2A): every successfully parsed
   * MD2/PCX is cached under its existing CPU handle, plus an explicit
   * fallback marker when a lump is missing/unparseable. `bootPlay` and
   * `applyRendererCvar` replay this cache into a (re)attached GPU backend
   * under the SAME handles — no CPU re-registration, no handle drift.
   */
  assets: RetainedPakAssets;
}

/**
 * One retained model asset: parsed data cached under its CPU handle.
 * `fallback` marks the box-critter substitution (explicit `console.warn`
 * at registration); the stored `data` (real MD2 or devmesh) is what the
 * GPU replay uploads, so fallbacks never surface as mesh-less either.
 */
export interface RetainedModelAsset {
  handle: number;
  kind: 'md2' | 'sp2' | 'tracer';
  data: unknown;
  /** Pak lump path (asset/handle context for warnings). */
  path: string;
  fallback: boolean;
}

/**
 * One retained skin asset: parsed texels cached under its CPU handle.
 * `pixels` is null for the CPU checker fallback (no texels to mirror —
 * the GPU backend keeps its white fallback); the registration-time warning
 * keeps that explicit.
 */
export interface RetainedSkinAsset {
  handle: number;
  pixels: Uint8Array | null;
  width: number;
  height: number;
  /** Pak lump path (asset/handle context for warnings). */
  path: string;
  fallback: boolean;
}

/** Retained parsed asset data returned alongside `PakModelHandles`. */
export interface RetainedPakAssets {
  models: RetainedModelAsset[];
  skins: RetainedSkinAsset[];
}

/**
 * GPU asset mirror sink (GPU-PROOF-3 live-loop hookup): the parsed MD2/PCX
 * data `registerPakModels` already holds is registered into the GPU backend
 * under the SAME handles the CPU refresh gets, so live renderables resolve.
 * Fallback data (box-critter mesh, named skins without texels) mirrors too —
 * the backend skips mesh-less models with a recorded warning, never a crash.
 * Structural (not `WebGLRenderer`) so registration stays decoupled.
 */
export interface GpuAssetSink {
  registerModelData(handle: number, kind: 'md2' | 'sp2' | 'tracer', data: unknown): void;
  registerSkinPixels(handle: number, pixels: Uint8Array, width: number, height: number): number;
}

export function registerPakModels(refresh: SoftwareRenderer, pak: WebPak, gpuSink?: GpuAssetSink | null): PakModelHandles {
  createDevroom(); // guarantees getDevMesh(0) exists for per-file fallbacks
  const skins: number[] = [];
  const retainedModels: RetainedModelAsset[] = [];
  const retainedSkins: RetainedSkinAsset[] = [];
  const ext = refresh as unknown as {
    registerSkinData?: (name: string, texels: Uint8Array, width: number, height: number) => number;
  };
  const describeFailure = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  const mirrorSkin = (h: number, path: string, pixels: Uint8Array, width: number, height: number): void => {
    if (!gpuSink) return;
    try {
      gpuSink.registerSkinPixels(h, pixels, width, height);
    } catch (err) {
      console.warn(`[q2ts-web] registerPakModels: GPU skin mirror failed for ${path} (skin ${h}): ${describeFailure(err)}`);
    }
  };
  const mirrorModel = (h: number, path: string, data: unknown): void => {
    if (!gpuSink) return;
    try {
      gpuSink.registerModelData(h, 'md2', data);
    } catch (err) {
      console.warn(`[q2ts-web] registerPakModels: GPU model mirror failed for ${path} (model ${h}): ${describeFailure(err)}`);
    }
  };
  const loadSkin = (path: string): number => {
    let failure: string | null = null;
    let parsed: Pcx | null = null;
    try {
      const bytes = tryPakEntry(pak, path);
      if (!bytes) {
        failure = 'missing in pak';
      } else if (typeof ext.registerSkinData !== 'function') {
        failure = 'no registerSkinData hook';
      } else {
        parsed = parsePCX(bytes);
      }
    } catch (err) {
      failure = `unparseable (${describeFailure(err)})`;
      parsed = null;
    }
    if (parsed && typeof ext.registerSkinData === 'function') {
      const h = ext.registerSkinData(path, parsed.pixels, parsed.width, parsed.height);
      skins.push(h);
      retainedSkins.push({ handle: h, pixels: parsed.pixels.slice(), width: parsed.width, height: parsed.height, path, fallback: false });
      // GPU-PROOF-3 live-loop hookup: mirror parsed texels under the same handle.
      mirrorSkin(h, path, parsed.pixels, parsed.width, parsed.height);
      return h;
    }
    const h = refresh.registerSkin(path);
    skins.push(h);
    retainedSkins.push({ handle: h, pixels: null, width: 0, height: 0, path, fallback: true });
    console.warn(`[q2ts-web] registerPakModels: skin ${path} ${failure ?? 'unavailable'} → checker fallback (skin ${h})`);
    return h;
  };
  const loadModel = (path: string): number => {
    let failure: string | null = null;
    try {
      const bytes = tryPakEntry(pak, path);
      if (bytes) {
        const md2 = parseMD2(bytes);
        const h = refresh.registerModel({ name: path, kind: 'md2', data: md2 });
        retainedModels.push({ handle: h, kind: 'md2', data: md2, path, fallback: false });
        // GPU-PROOF-3 live-loop hookup: mirror parsed MD2 under the same handle.
        mirrorModel(h, path, md2);
        return h;
      }
      failure = 'missing in pak';
    } catch (err) {
      failure = `unparseable (${describeFailure(err)})`;
    }
    const devmesh = getDevMesh(0);
    const h = refresh.registerModel({ name: path, kind: 'md2', data: devmesh });
    retainedModels.push({ handle: h, kind: 'md2', data: devmesh, path, fallback: true });
    console.warn(`[q2ts-web] registerPakModels: model ${path} ${failure ?? 'unavailable'} → box-critter fallback (model ${h})`);
    mirrorModel(h, path, devmesh);
    return h;
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
  // r_explode skin cycle (cl_tent.c ex_poly skinnum): registered LAST so
  // every handle above stays put; the explosion lookup degrades to
  // explodeSkin for any missing/unparseable entry.
  const explodeSkins: number[] = [];
  for (let s = 2; s <= 7; s++) {
    explodeSkins.push(loadSkin(`models/objects/r_explode/skin${s}.pcx`));
  }
  return {
    monster, monsterSkin, soldierLightSkin, soldierSsSkin, gunner, gunnerSkin, infantry, infantrySkin, weapons, weaponSkins, bolt, boltSkin, barrel, barrelSkin,
    explode, explodeSkin, explodeSkins, blast, blastSkin,
    debris1, debris1Skin, debris2, debris2Skin, debris3, debris3Skin,
    gibMeat, gibMeatSkin, gibChest, gibChestSkin, gibBone, gibBoneSkin, gibHead, gibHeadSkin,
    items, ship, shipSkin, banner, bannerSkin, corpse, corpseSkin,
    skins,
    assets: { models: retainedModels, skins: retainedSkins },
  };
}

/**
 * Replay retained parsed asset data into a (re)attached GPU backend under
 * the SAME handles (GPU-FOLLOW-2A): cold boot and CPU→GPU hot-swap share
 * this path, so entities never stay mesh-less and CPU handles never drift
 * (no `registerPakModels` re-run here). Checker-fallback skins carry no
 * texels and stay CPU-only (explicit at registration); every other entry
 * replays via `GpuAssetSink`. Backend exceptions surface with asset/handle
 * context via `console.warn` (never swallowed); a throwing entry is skipped
 * so one bad lump cannot block the rest, and the missing backend handle
 * fails completeness tests loudly.
 */
export function replayPakAssetsToGpu(
  handles: PakModelHandles | null,
  sink: GpuAssetSink | null | undefined,
): { models: number; skins: number } {
  if (!handles || !sink) return { models: 0, skins: 0 };
  let models = 0;
  let skins = 0;
  for (const m of handles.assets.models) {
    try {
      sink.registerModelData(m.handle, m.kind, m.data);
      models++;
    } catch (err) {
      console.warn(`[q2ts-web] replayPakAssetsToGpu: model ${m.path} (model ${m.handle}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const s of handles.assets.skins) {
    if (s.pixels === null) continue; // checker fallback is CPU-only by design
    try {
      sink.registerSkinPixels(s.handle, s.pixels, s.width, s.height);
      skins++;
    } catch (err) {
      console.warn(`[q2ts-web] replayPakAssetsToGpu: skin ${s.path} (skin ${s.handle}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { models, skins };
}

/**
 * Spawn view for the boot-time STATIC GPU scene (`selectGpuScene` needs a
 * `RefDef` for the camera setup/PVS seed; entities are empty at boot). Pure
 * seed only — the per-frame entity tail refreshes in `frameGpuPlay`.
 */
function spawnViewFor(driver: LocalDriver): RefDef {
  const sp = driver.spawn();
  return {
    origin: new Float32Array(sp.origin) as RefDef['origin'],
    angles: new Float32Array(sp.angles ?? [0, 0, 0]) as RefDef['angles'],
    fovX: 90,
    time: 0,
    lightStyles: new Float32Array(256).fill(1),
  };
}

/**
 * Attach the GPU backend for a `webgl2-experimental` boot/hot-swap: acquire
 * the GL canvas (stacked under the 2D/HUD canvas), init the committed
 * `WebGLRenderer`, and upload the STATIC world scene ONCE (empty entities at
 * boot). When retained pak assets are provided (GPU-FOLLOW-2A cold boot via
 * `bootPlay`, hot-swap via `applyRendererCvar`), they are replayed into the
 * backend under their SAME existing handles — entities never stay mesh-less.
 * Returns null when no GL canvas/context is available — the caller falls
 * back to the CPU path WITH a warning, never silently. Never throws.
 */
function attachGpuBackend(
  driver: LocalDriver,
  width: number,
  height: number,
  assets: PakModelHandles | null = null,
): GpuBootState | null {
  const acquired = acquireGpuCanvas(undefined, width, height);
  if (!acquired) return null;
  try {
    const gpu = new WebGLRenderer();
    gpu.init(acquired.gl as unknown as WebGL2RenderingContext, width, height);
    if (assets) replayPakAssetsToGpu(assets, gpu);
    const scene = selectGpuScene(driver.mini, [], spawnViewFor(driver), width, height);
    gpu.setScene(scene);
    // Persistent inventory snapshot (observability only): the full upload
    // set the renderer baked from the world (selection-independent). The
    // per-frame path re-selects from the live world instead of this.
    const inventory = fullWorldRefs(driver.mini);
    const staticScene: GpuSceneInput = {
      surfaces: inventory,
      transforms: scene.transforms,
      staticGeneration: scene.staticGeneration,
    };
    installGpuWorkConveyor();
    try {
      syncGpuCanvasToHud(undefined);
      setHudTransparent(undefined, true);
    } catch {
      /* presentation best-effort: GL scene still submits */
    }
    return { canvas: acquired.canvas, gl: acquired.gl, gpu, scene, staticScene, loop: createAsyncLoopState(), appearance: null, contextLost: false, lossCount: 0, restoreCount: 0, disposeLifecycle: null };
  } catch {
    return null;
  }
}

/* --- GPU-FOLLOW-4 app-side lifecycle (owns: apps/web) ----------------------
 *
 * Canvas events, safe submission gating, retained-asset restore replay,
 * backend resize sync and fallback labelling. The backend owns GL
 * resources (same-context teardown/replacement is the GL lane's); this
 * layer only drives its committed `handleContextLost` / `handleContextRestored`
 * / `resize` / `dispose` entry points and replays the FOLLOW-2A retained
 * cache — asset migration is never rebuilt here.
 */

/**
 * Wire the canvas `webglcontextlost`/`webglcontextrestored` pair for a live
 * GPU boot (GPU-FOLLOW-4 (1)): the lost handler `preventDefault`s (restoration
 * opt-in) and stops submission via `notifyGpuContextLost`; the restored
 * handler replays retained assets and resumes via `notifyGpuContextRestored`.
 * Exactly-once per canvas (re-wire replaces the pair — see
 * `attachGpuCanvasLifecycle`), so repeated boot/switch cycles never stack
 * listeners. Returns false (no-op) without a GPU backend. Never throws.
 */
export function wireGpuLifecycle(boot: PlayBoot): boolean {
  const g = boot.gpu;
  if (!g) return false;
  try {
    if (g.disposeLifecycle) {
      try {
        g.disposeLifecycle();
      } catch {
        /* stale pair removal is best-effort */
      }
      g.disposeLifecycle = null;
    }
    g.disposeLifecycle = attachGpuCanvasLifecycle(g.canvas, {
      onLost: () => {
        notifyGpuContextLost(boot);
      },
      onRestored: () => {
        notifyGpuContextRestored(boot);
      },
    });
    return hasGpuCanvasLifecycle(g.canvas) || g.disposeLifecycle !== null;
  } catch {
    return false;
  }
}

/**
 * Remove the canvas lifecycle pair (GPU→CPU switch / teardown): the disposed
 * backend and removed canvas must fire nothing afterwards. No-op without a
 * GPU backend. Never throws.
 */
export function unwireGpuLifecycle(boot: PlayBoot): void {
  const g = boot.gpu;
  if (!g) return;
  try {
    if (g.disposeLifecycle) {
      try {
        g.disposeLifecycle();
      } catch {
        /* removal is best-effort */
      }
    }
  } catch {
    /* best-effort only */
  }
  g.disposeLifecycle = null;
}

/**
 * Record a real canvas `webglcontextlost` (or a test-injected equivalent):
 * mark the boot lost and tell the backend to record + skip. Idempotent —
 * repeated events while already lost never double-count. Returns false
 * without a GPU backend or when already lost. Never throws.
 */
export function notifyGpuContextLost(boot: PlayBoot): boolean {
  const g = boot.gpu;
  if (!g || g.contextLost) return false;
  g.contextLost = true;
  g.lossCount++;
  try {
    g.gpu.handleContextLost();
  } catch {
    /* the backend records loss per contract; the shell flag still gates */
  }
  // RELEASE-10: refresh the menu mapping (submission is gated while lost).
  refreshPanelAfterRendererChange();
  return true;
}

/**
 * Recover from a real canvas `webglcontextrestored` (or a test-injected
 * equivalent): re-create owned targets on the restored context, replay the
 * retained FOLLOW-2A MD2/PCX cache under the SAME handles (no asset
 * migration rebuild — `replayPakAssetsToGpu` only re-registers the data the
 * backend already retains CPU-side), then re-sync the HUD overlay and clear
 * the lost gate so submission resumes. Idempotent — restores without a
 * preceding loss (or without a GPU backend) return false and change nothing.
 * Never throws.
 */
export function notifyGpuContextRestored(boot: PlayBoot): boolean {
  const g = boot.gpu;
  if (!g || !g.contextLost) return false;
  try {
    g.gpu.handleContextRestored(g.gl as unknown as WebGL2RenderingContext);
  } catch {
    return false;
  }
  // FOLLOW-2A replay reuse: SAME handles, explicit path/handle warnings on
  // failure (never silent), skipped entries keep their backend warning.
  // GPU-FOLLOW-3A: replay the retained map sky (per-face dims) — restoration
  // without it would silently revert to the flat fallback.
  // RELEASE-2: devroom restores the procedural world + palette + box-critter.
  try {
    g.gpu.attachWorld(boot.driver.mini);
    const pal = gpuPaletteFor(boot);
    if (pal) g.gpu.setPalette(pal);
  } catch {
    /* restore best-effort */
  }
  if (boot.models) replayPakAssetsToGpu(boot.models, g.gpu);
  else replayDevroomAssetsToGpu(g.gpu as unknown as Parameters<typeof replayDevroomAssetsToGpu>[0]);
  syncGpuSky(boot);
  try {
    syncGpuCanvasToHud(undefined);
    setHudTransparent(undefined, true);
  } catch {
    /* presentation best-effort: the backend still resumes */
  }
  g.contextLost = false;
  g.restoreCount++;
  // RELEASE-10: the backend is live again — refresh the menu mapping.
  refreshPanelAfterRendererChange();
  return true;
}

/**
 * Resize the live GPU drawing surface (GPU-FOLLOW-4 (4)): canvas backing
 * store + backend viewport/render targets + HUD CSS pair, in that order.
 * Camera aspect follows the host framebuffer every frame in `frameGpuPlay`,
 * so callers keep the backend size at the same aspect as the fb. Returns
 * false (no-op) without a GPU backend or for non-positive integer sizes.
 * Never throws.
 */
export function resizeGpuBackend(boot: PlayBoot, width: number, height: number): boolean {
  const g = boot.gpu;
  if (!g) return false;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return false;
  try {
    setGpuCanvasSize(g.canvas, width, height);
    g.gpu.resize(width, height);
    syncGpuCanvasToHud(undefined);
    setHudTransparent(undefined, true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Explicit unsupported-device fallback label (GPU-FOLLOW-4 (2)): non-null
 * exactly when a `webgl2-experimental` request fell back to a CPU renderer
 * (the recorded `lastRendererWarning` naming webgl2). Null when the GPU path
 * is live or was never requested. Never throws.
 */
export function gpuFallbackLabel(boot: PlayBoot): string | null {
  try {
    if (boot.renderer === 'webgl2-experimental') return null;
    const w = boot.lastRendererWarning;
    if (w === null || !w.includes('webgl2')) return null;
    return w;
  } catch {
    return null;
  }
}

/**
 * GPU frames submitted on this boot (0 when no GPU backend is attached).
 * Fallback legs never count as GPU execution: gate benchmark legs on this
 * (or `getGpuStatus`) instead of the requested cvar alone. Never throws.
 */
export function gpuFramesSubmitted(boot: PlayBoot): number {
  try {
    const n = boot.gpu?.gpu.getStatus().framesSubmitted;
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Procedural palette for the asset-free devroom GPU path (RELEASE-2).
 * Matches the `rampPalette` shape used across webgl-renderer/testkit suites
 * (deterministic, never reads the pak). Without this the GPU backend stays
 * clear-only because `uploadStatic` early-returns when palette is missing.
 */
export function devroomPaletteForGpu(): Uint8Array {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    p[i * 3] = i;
    p[i * 3 + 1] = (i * 2) & 255;
    p[i * 3 + 2] = (i * 3) & 255;
  }
  return p;
}

/**
 * Register the procedural devroom box-critter with a GPU backend (RELEASE-2):
 * model handle 0 + skin handle mirroring the CPU `host.refresh.registerModel`
 * path so devroom entities never stay mesh-less on GPU. Best-effort, never throws.
 */
function replayDevroomAssetsToGpu(
  sink: {
    registerModelData?: (handle: number, kind: string, data: unknown) => void;
    registerSkinPixels?: (handle: number, pixels: Uint8Array, width: number, height: number) => void;
  } | null | undefined,
): void {
  if (!sink) return;
  try {
    if (typeof sink.registerModelData === 'function') {
      try {
        sink.registerModelData(0, 'md2', getDevMesh(0));
      } catch {
        /* entity draws skip */
      }
    }
    if (typeof sink.registerSkinPixels === 'function') {
      try {
        const skins = createDevroom().textures;
        const t = skins[0];
        if (t) sink.registerSkinPixels(0, t.texels.slice(0), t.width, t.height);
      } catch {
        /* white fallback stays */
      }
    }
  } catch {
    /* devroom GPU assets best-effort */
  }
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
  const resolved = resolveBootRenderer(opts.renderer);
  let renderer = resolved.kind;
  let rendererWarning = resolved.warning;
  if (rendererWarning !== null) {
    console.warn(`[q2ts-web] bootPlay: ${rendererWarning}`);
  }
  const driver = new LocalDriver(opts.pak ?? null);
  // GPU-PROOF-3 gameplay integration: when `webgl2-experimental` IS selected
  // and capable, ALSO construct the committed `WebGLRenderer` on an acquired
  // GL canvas (stacked under the 2D/HUD canvas — see gpu-canvas.ts) and build
  // the STATIC world scene ONCE via `selectGpuScene` (empty entities at boot;
  // the per-frame entity tail refreshes in `frameGpuPlay`). Acquisition
  // failure degrades to the CPU path WITH an explicit warning (never silent).
  let gpu: GpuBootState | null = null;
  if (renderer === 'webgl2-experimental') {
    gpu = attachGpuBackend(driver, width, height);
    if (!gpu) {
      renderer = 'software';
      rendererWarning = `webgl2-experimental requested but unavailable (no WebGL2 context); staying on software`;
      console.warn(`[q2ts-web] bootPlay: ${rendererWarning}`);
      try {
        setHudTransparent(undefined, false);
        removeGpuCanvas(undefined);
      } catch {
        /* CPU presentation already correct; best-effort cleanup only */
      }
    }
  }
  // GPU-PROOF-3 gameplay integration (see above): when
  // `webgl2-experimental` IS selected and capable the selection is real
  // (recorded on the boot, observable via `getGpuStatus`) AND the backend is
  // attached (`boot.gpu`, static scene uploaded once). The CPU
  // SoftwareRenderer below stays constructed regardless — it owns the
  // HUD/resolve path (`resolveDisplay`/`drawPlayHud` paint the 2D overlay
  // above the GL canvas), and `host.frame` keeps working for tests/debug. The
  // live rAF loop submits through `frameGpuPlay` (no CPU world raster).
  const refresh = new SoftwareRenderer();
  let mainPalette: Uint8Array | null = null;
  // GPU-FOLLOW-3A: retain the map sky once (single pak read, never per-frame).
  // The CPU path keeps its strip contract; the GPU path replays the retained
  // per-face dims via `syncGpuSky` (cold boot, hot-swap, restore).
  let retainedSky: RetainedSky | null = null;
  let skyWarning: string | null = null;
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
    // Missing/unparseable art → flat-fill fallback with a diagnosable warning.
    const derived = retainedSkyFromPak(opts.pak, driver.map, mainPalette);
    retainedSky = derived.sky;
    skyWarning = derived.warning;
    if (skyWarning !== null) {
      console.warn(`[q2ts-web] bootPlay: ${skyWarning}`);
    }
    if (retainedSky) {
      try {
        refresh.setSkyTexture({
          texels: retainedSky.texels,
          width: retainedSky.tileW,
          height: retainedSky.tileH * 6,
        });
      } catch {
        /* flat-fill fallback stays active */
      }
    }
  } else {
    skyWarning = 'no map sky (devroom or missing palette/pak: flat sky fallback)';
    // RELEASE-2: devroom still needs a palette for the GPU backend.
    // Procedural ramp (never reads the pak); CPU path is unaffected.
    mainPalette = devroomPaletteForGpu();
    try {
      refresh.setPalette(mainPalette);
    } catch {
      /* CPU devroom renders without a palette; GPU uses the ramp below */
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
    // GPU-FOLLOW-2A: CPU registration always runs first and populates the
    // retained asset cache (handle stability: soldier skin 0 + model 0
    // first, no numeric shifts). The GPU backend is fed by the explicit
    // replay below — the same `replayPakAssetsToGpu` path the CPU→GPU
    // hot-swap uses — never by a divergent mirror.
    models = registerPakModels(refresh, opts.pak, null);
    driver.models = models;
  } else if (driver.monsters.length > 0) {
    createDevroom();
    host.refresh.registerModel({ name: 'monster', kind: 'md2', data: getDevMesh(0) });
  }
  const n = width * height;
  // RELEASE-6: retain the decoded HUD pics once (same pak the boot used).
  const hudPics = opts.pak && mainPalette ? buildHudPicCache(opts.pak) : null;
  const boot: PlayBoot = {
    host, driver, refresh, renderer, lastRendererWarning: rendererWarning, source: driver.source,
    display: new Uint32Array(n),
    lastResolveOrder: 'none',
    browserPool: null,
    statAsyncFallbacks: 0,
    models, pak: opts.pak ?? null, sky: retainedSky, skyWarning, gpu,
    palette: mainPalette,
    hudPics,
    showHelp: false,
    helpChangedSeq: 0,
    helpSeenSeq: 0,
  };
  // GPU-FOLLOW-4 (1): wire the real canvas contextlost/restored pair now that
  // the boot exists (no-op without a GPU backend; exactly-once per canvas).
  if (boot.gpu) wireGpuLifecycle(boot);
  // GPU-PROOF-3 live-loop hookup: the backend needs the world + palette for
  // static uploads. GPU-FOLLOW-2A: the retained MD2/PCX cache replays under
  // the SAME handles right after (cold boot shares the hot-swap path).
  // RELEASE-2: devroom boots attach the procedural world + ramp palette and
  // the box-critter so GPU cold boot/switch/restore render real geometry
  // without pak assets. Missing pak sky clears to the flat fallback (3A intact).
  // GPU-FOLLOW-3A: the retained map sky registers here (per-face dims, never
  // the strip's total height); missing art clears to the flat fallback.
  if (boot.gpu && mainPalette) {
    boot.gpu.gpu.attachWorld(driver.mini);
    boot.gpu.gpu.setPalette(mainPalette);
    if (models) {
      replayPakAssetsToGpu(models, boot.gpu.gpu);
    } else {
      replayDevroomAssetsToGpu(boot.gpu.gpu as unknown as Parameters<typeof replayDevroomAssetsToGpu>[0]);
    }
    syncGpuSky(boot);
  }
  return boot;
}

/**
 * Reboot a boot at the CURRENT cvar values (skill + map_source): the menu
 * path for "changing the dropdown reboots the level". Same pak and renderer
 * as the previous boot, fresh driver/server/mini (DoorSync bases re-baked,
 * skill filter re-applied before spawning). map_source decides which world:
 * 'pak' keeps the previous pak (null when the previous boot had none →
 * devroom fallback), anything else boots the asset-free devroom even when a
 * pak is cached. Resolution is NOT latched here: `vid_resolution` resizes in
 * place via `resizePlay` (RELEASE-7, no sim rebuild); reboot keeps the live
 * framebuffer size.
 */
export function rebootPlay(prev: PlayBoot): PlayBoot {
  const pak = getMapSource() === MAP_SOURCE_PAK ? prev.pak : null;
  // Renderer is NOT re-latched here: vid_renderer hot-swaps in place
  // (see applyRendererCvar) without rebuilding Host/LocalDriver/server
  // state. Skill/map reboot through this path; resolution resizes in place.
  const next = bootPlay({ pak, width: prev.host.fb.width, height: prev.host.fb.height });
  // RELEASE-10: a reboot re-resolves the boot (renderer included) — refresh
  // the menu mapping with it.
  refreshPanelAfterRendererChange();
  return next;
}

/* --- RELEASE-7 sim-preserving resize (apps/web only) --------------------
 *
 * `vid_resolution` changes resize the framebuffer/viewport/HUD in place
 * WITHOUT rebuilding the game simulation: map, position, health, enemies,
 * elapsed time and audio survive. The Host owns the framebuffer realloc
 * (`host.resize` preserves sim + copies the overlap so the first post-resize
 * present reuses live pixels instead of flashing black); the shell then
 * reallocates its display planes the same way and syncs the GPU backend
 * viewport (`resizeGpuBackend`). The running loop (dom.ts finishFrame)
 * re-fits the CSS display box the first frame it observes the new dims, and
 * the menu caller re-fits synchronously — this module stays DOM-free. The
 * renderer backend never re-inits and no listener/loop is reinstalled, so
 * repeated resize/switch cycles stay 1:1 with reallocations. Explicit
 * restart stays only for settings that genuinely need a new level
 * (map source, skill).
 */

/**
 * Resize a live boot in place (RELEASE-7): coordinated framebuffer +
 * display-plane + GPU viewport sync, no sim rebuild. Preserved: server
 * time, player origin/velocity, health, mixer channels, world/driver/refresh
 * identities. Returns true when the size applied (same-size is a no-op
 * returning true); false + coherent state on invalid sizes, resize throw,
 * or GPU backend failure (host/display rolled back to the previous size,
 * never success-with-mismatch — the menu caller reboots on false).
 */
export function resizePlay(boot: PlayBoot, width: number, height: number): boolean {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return false;
  try {
    const prev = boot.host.fb;
    if (prev.width === width && prev.height === height) return true;
    const prevDisplay = boot.display;
    const before = boot.host.captureSimState();
    const beforeHost = boot.host;
    const beforeDriver = boot.driver;
    const beforeWorld = boot.host.world;
    const beforeRefresh = boot.host.refresh;
    boot.host.resize(width, height);
    // Shell display planes follow the same overlap-copy rule (no black box).
    const copyW = Math.min(prev.width, width);
    const copyH = Math.min(prev.height, height);
    const nextDisplay = new Uint32Array(width * height);
    for (let y = 0; y < copyH; y++) {
      nextDisplay.set(boot.display.subarray(y * prev.width, y * prev.width + copyW), y * width);
    }
    boot.display = nextDisplay;
    // GPU viewport follows the framebuffer. A backend failure must NOT be
    // reported as success with mismatched state: roll the host + display
    // back to the previous size (Host.resize preserves sim, same overlap
    // rule in reverse) and surface the failure. Best-effort canvas restore
    // keeps the GL backing store paired with whatever size won.
    if (boot.gpu && !resizeGpuBackend(boot, width, height)) {
      try {
        boot.host.resize(prev.width, prev.height);
      } catch {
        /* rollback throw: re-derive the display from the live fb below */
      }
      const fb = boot.host.fb;
      if (fb.width === prev.width && fb.height === prev.height) {
        boot.display = prevDisplay;
      } else {
        // Rollback itself failed: keep the NEW size everywhere (host + fresh
        // display planes) so buffer lengths never disagree; still report
        // failure so the caller reboots instead of trusting the GPU view.
        boot.display = new Uint32Array(fb.width * fb.height);
      }
      resizeGpuBackend(boot, fb.width, fb.height);
      return false;
    }
    try {
      boot.refresh.syncWorkersFromCvar?.();
    } catch {
      /* banding best-effort */
    }
    // Sim-preservation pin: the resize must not have swapped the sim out.
    const after = boot.host.captureSimState();
    if (
      boot.host !== beforeHost || boot.driver !== beforeDriver ||
      boot.host.world !== beforeWorld || boot.host.refresh !== beforeRefresh ||
      after.serverTime !== before.serverTime ||
      after.playerOrigin[0] !== before.playerOrigin[0] ||
      after.playerOrigin[1] !== before.playerOrigin[1] ||
      after.playerOrigin[2] !== before.playerOrigin[2]
    ) {
      return false;
    }
    // RELEASE-10: keep the menu mapping fresh (renderer unchanged here, but
    // the refresh path is the same single re-render — no extra listeners).
    refreshPanelAfterRendererChange();
    return true;
  } catch {
    return false;
  }
}

/**
 * Persisted display size reserved BEFORE any async asset load (RELEASE-7):
 * reads the latched `vid_resolution` cvar synchronously so the loading
 * surface is allocated at the selected size immediately — no small black
 * box or layout jump when assets land. Pure/headless-safe.
 */
export function reservedDisplaySize(): { width: number; height: number } {
  return getResolution();
}

/**
 * Apply the reserved size to a canvas backing store synchronously (before
 * the first async pak/IndexedDB load). Returns true when applied. Never
 * throws; headless-safe (false without a canvas).
 */
export function applyReservedSizeToCanvas(canvas: unknown): boolean {
  try {
    const { width, height } = reservedDisplaySize();
    const c = canvas as { width?: number; height?: number } | null;
    if (!c || typeof c.width !== 'number' || typeof c.height !== 'number') return false;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return false;
    c.width = width;
    c.height = height;
    return true;
  } catch {
    return false;
  }
}

/**
 * Palette for a hot-swapped GPU backend (re-parsed from the pak; the boot
 * path reuses the already-parsed `mainPalette`). Devroom (no pak) returns
 * the procedural ramp so the backend renders real geometry instead of
 * staying clear-only (RELEASE-2). Never throws.
 */
function gpuPaletteFor(boot: PlayBoot): Uint8Array | null {
  try {
    if (!boot.pak) return devroomPaletteForGpu();
    const bytes = tryPakEntry(boot.pak, 'pics/colormap.pcx');
    if (!bytes) return devroomPaletteForGpu();
    return parsePCX(bytes).palette;
  } catch {
    return devroomPaletteForGpu();
  }
}

/* --- RELEASE-10 panel refresh hook (apps/web only) ----------------------
 *
 * Single replaceable callback (never a listener list: no accumulation across
 * boot/switch cycles). The browser boot layer owns the settings panel and
 * installs `() => <re-render the menu>` once; every path that can change the
 * effective renderer — `applyRendererCvar` (switch + failed-GPU fallback),
 * `rebootPlay`, `resizePlay`, `notifyGpuContextLost/Restored` — invokes it
 * best-effort so the panel re-renders with the live capability mapping (no
 * stale labels). Headless/tests: null by default. Never throws.
 */
let panelRefreshHook: (() => void) | null = null;

/** Install (or clear) the panel re-render callback. Single slot, replaceable. */
export function setPanelRefreshHook(fn: (() => void) | null): void {
  panelRefreshHook = fn;
}

/** Invoke the panel hook best-effort: refresh failures never break sim/present. */
function refreshPanelAfterRendererChange(): void {
  if (panelRefreshHook === null) return;
  try {
    panelRefreshHook();
  } catch {
    /* panel refresh is best-effort */
  }
}

/**
 * Hot-swap the renderer backend in place (vid_renderer menu switch without
 * a reboot): re-resolves `boot.renderer` from the cvar via
 * `resolveBootRenderer` (shared with `bootPlay`) and returns it. The
 * resolve path (resolveDisplay) already reads the cvar every frame, so no
 * Host/LocalDriver/server state is touched — player pos, health, ammo and
 * monsters survive the switch. Records the fallback warning on the boot
 * (`lastRendererWarning`, null when honored) and `console.warn`s it —
 * fallbacks are never silent. Headless-safe. The shell-owned display
 * scratch is zeroed so the next frame can never show previous-mode pixels.
 */
export function applyRendererCvar(boot: PlayBoot): RendererKind {
  const resolved = resolveBootRenderer();
  let kind = resolved.kind;
  let warning = resolved.warning;
  // GPU-PROOF-3 hot-swap: entering `webgl2-experimental` attaches the GL
  // backend (same path as boot); leaving it disposes the backend. Attach
  // failure degrades to software WITH a warning, never silently.
  if (kind === 'webgl2-experimental' && !boot.gpu) {
    const attached = attachGpuBackend(boot.driver, boot.host.fb.width, boot.host.fb.height, boot.models);
    if (attached) {
      boot.gpu = attached;
      // Wire the canvas lifecycle pair for the fresh attach (exactly-once:
      // re-wiring replaces any stale pair from an undisposed canvas reuse).
      wireGpuLifecycle(boot);
      // World + palette for the static upload, then the retained MD2/PCX
      // cache replays under the SAME handles (GPU-FOLLOW-2A): no CPU
      // re-registration (no handle drift), no reboot, no reset of the
      // player's game. RELEASE-2: devroom replays the procedural box-critter.
      attached.gpu.attachWorld(boot.driver.mini);
      const pal = gpuPaletteFor(boot);
      if (pal) attached.gpu.setPalette(pal);
      if (boot.models) {
        replayPakAssetsToGpu(boot.models, attached.gpu);
      } else {
        replayDevroomAssetsToGpu(attached.gpu as unknown as Parameters<typeof replayDevroomAssetsToGpu>[0]);
      }
      // (Retained models/skins already replayed inside attachGpuBackend
      // under the same handles — see above.)
      // GPU-FOLLOW-3A: replay the retained map sky (per-face dims) so a
      // CPU→GPU switch shows the textured sky without re-reading the pak.
      // Missing art clears to the flat fallback (never a stale strip).
      syncGpuSky(boot);
      try {
        syncGpuCanvasToHud(undefined);
        setHudTransparent(undefined, true);
      } catch {
        /* presentation best-effort: backend still attached */
      }
    } else {
      kind = 'software';
      warning = `webgl2-experimental requested but unavailable (no WebGL2 context); staying on software`;
      try {
        setHudTransparent(undefined, false);
        removeGpuCanvas(undefined);
      } catch {
        /* CPU presentation already correct; best-effort cleanup only */
      }
    }
  } else if (kind !== 'webgl2-experimental' && boot.gpu) {
    // GPU-FOLLOW-4: unwire the canvas lifecycle pair BEFORE disposing so the
    // detached backend/canvas fire nothing afterwards (no listener leaks
    // across repeated switch cycles).
    unwireGpuLifecycle(boot);
    try {
      boot.gpu.gpu.dispose();
    } catch {
      /* dispose is idempotent by contract; belt-and-braces for hot-swap */
    }
    boot.gpu = null;
    try {
      setHudTransparent(undefined, false);
      removeGpuCanvas(undefined);
    } catch {
      /* CPU presentation already correct; best-effort cleanup only */
    }
  }
  boot.renderer = kind;
  boot.lastRendererWarning = warning;
  if (warning !== null) {
    console.warn(`[q2ts-web] applyRendererCvar: ${warning}`);
  }
  // Shell-owned scratch: zero so the next frame can never show
  // previous-mode pixels (engine planes are repainted by the next render).
  boot.display.fill(0);
  // RELEASE-10: the effective renderer may have changed (or fallen back) —
  // re-render the menu so capability labels cannot go stale.
  refreshPanelAfterRendererChange();
  return boot.renderer;
}

/* --- resolve ownership (RELEASE-8) --------------------------------------
 *
 * SINGLE OWNER: the SHELL owns the presented frame. `SoftwareRenderer.endFrame` /
 * `endFrameAsync` own only the palette expand into the live `color` plane;
 * `resolveDisplay` below applies the display-only `r_brightness` lift (or
 * returns the engine buffer untouched at 1.0). No `@q2/voodoo` code runs on
 * the CPU path; WebGL2 owns appearance via `vd_*` uniforms.
 */

/** Resolve the software framebuffer for display (software path only).
 *
 * Display-only `r_brightness` lift (see `getBrightness`) is applied to the
 * scene copy here, *before* the caller paints HUD on top via `drawPlayHud` —
 * so HUD text keeps its full authored colour and is never dimmed or clipped
 * by the lift. At 1.0 the software path returns the engine buffer untouched
 * (byte-identical, same reference).
 *
 * RELEASE-8: the CPU voodoo scanout is retired. `hud` is accepted for
 * signature compatibility (bench + historical callers) and ignored — HUD
 * is always painted post-resolve by the caller. `frameState` is accepted
 * for the same reason and ignored.
 */
export function resolveDisplay(boot: PlayBoot, hud?: HudState, frameState?: unknown): Uint32Array {
  void hud;
  void frameState;
  const brightness = getBrightness();
  // Source the LIVE renderer color plane, not host.fb.color: with a worker
  // pool attached the renderer adopts the pool's shared color plane (and
  // the wasm backend draws into wasm memory), so host.fb.color is stale
  // there. Classic path: the same array (behaviour unchanged).
  const live = boot.refresh.getFramebuffer().color;
  if (brightness === 1) {
    boot.lastResolveOrder = 'software-passthrough';
    return live;
  }
  boot.lastResolveOrder = 'software-lifted';
  if (boot.display.length !== live.length) {
    // Size skew (e.g. a direct Host.resize bypassing resizePlay's display
    // realloc, or an in-flight async frame across a resize): realloc once
    // so set() below can never throw RangeError and no stale tail pixels
    // survive. Resize frames only, never per-frame steady state.
    boot.display = new Uint32Array(live.length);
  }
  boot.display.set(live);
  applyBrightness(boot.display, brightness);
  return boot.display;
}

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

/**
 * Cvar gate for the transient gameplay status line (`cl_showmessages`,
 * default 1 = ON). Mirrors dom.showMessagesEnabled without importing the
 * DOM layer (this module is headless-safe; dom.ts imports from here, never
 * the reverse). Death ('alert' kind), the finished screen, and
 * loading/fallback warnings never consult this gate.
 */
export function messagesVisible(): boolean {
  if (getCVar('cl_showmessages') === undefined) return true;
  const raw = getCVar('cl_showmessages');
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

/* --- RELEASE-6 asset HUD (apps/web only) -------------------------------
 *
 * The placeholder bottom rows (`weapon ammo` / `hp N` text) are replaced by
 * the original asset-based statusbar when a pak is present: the retail
 * `single_statusbar` script (`game/g_spawn.c`) executed via the production
 * `executeStatusbar` (coordinate mapping, conditionals, flash rules all owned
 * by `@q2/client`), with `drawPic`/`drawField`/`drawString` blitting the real
 * `pics/*.pcx` art through the game palette. F1 uses the original
 * `buildHelpLayout` + `help` background; level completion uses
 * `centerPrintPlacement` (`SCR_DrawCenterString` semantics). Devroom keeps
 * the readable text fallback (never a throw on missing art); the optional
 * `cl_showfps`/`cl_showpos` diagnostics stay separate top-row readouts and
 * never enter the statusbar program.
 */

/** Retail single-player statusbar script (`game/g_spawn.c: single_statusbar`). */
export const RETAIL_SINGLE_STATUSBAR =
  'yb -24 xv 0 hnum xv 50 pic 0 ' +
  'if 2 xv 100 anum xv 150 pic 2 endif ' +
  'if 4 xv 200 rnum xv 250 pic 4 endif ' +
  'if 6 xv 296 pic 6 endif ' +
  'yb -50 if 7 xv 0 pic 7 xv 26 yb -42 stat_string 8 yb -50 endif ' +
  'if 9 xv 262 num 2 10 xv 296 pic 9 endif ' +
  'if 11 xv 148 pic 11 endif';

/** Cached parsed ops for the retail script (parsed once, executed per frame). */
let retailStatusbarOps: ReturnType<typeof parseStatusbar> | null = null;
function retailOps(): ReturnType<typeof parseStatusbar> {
  if (!retailStatusbarOps) retailStatusbarOps = parseStatusbar(RETAIL_SINGLE_STATUSBAR);
  return retailStatusbarOps;
}

/** Short icon name for the selected weapon (`w_*` art). */
function weaponIconFor(classname: string): string {
  const table: Record<string, string> = {
    weapon_blaster: 'w_blaster',
    weapon_shotgun: 'w_shotgun',
    weapon_supershotgun: 'w_sshotgun',
    weapon_machinegun: 'w_machinegun',
    weapon_chaingun: 'w_chaingun',
    weapon_grenadelauncher: 'w_glauncher',
    weapon_rocketlauncher: 'w_rlauncher',
    weapon_hyperblaster: 'w_hyperblaster',
    weapon_railgun: 'w_railgun',
    weapon_bfg: 'w_bfg',
  };
  return table[classname] ?? 'w_blaster';
}

/** Short icon name for an ammo kind (`a_*` art). */
function ammoIconFor(kind: string | null): string | null {
  if (!kind) return null;
  const table: Record<string, string> = {
    shells: 'a_shells',
    bullets: 'a_bullets',
    grenades: 'a_grenades',
    cells: 'a_cells',
    rockets: 'a_rockets',
    slugs: 'a_slugs',
  };
  return table[kind] ?? null;
}

/**
 * Decode one HUD pic from the pak (null when missing/unparseable — the
 * caller falls back to text, never throws inside the frame loop).
 */
function decodeHudPic(pak: WebPak, name: string): IndexedPic | null {
  try {
    const bytes = tryPakEntry(pak, `pics/${name}.pcx`);
    if (!bytes) return null;
    const pcx = parsePCX(bytes);
    return { width: pcx.width, height: pcx.height, pixels: pcx.pixels };
  } catch {
    return null;
  }
}

/**
 * Build the retained HUD pic cache from a pak (once per boot). Missing or
 * unparseable lumps decode to null entries — the frame loop tolerates them
 * (icons/fields skip, text stays readable). Headless-safe.
 */
export function buildHudPicCache(pak: WebPak): HudPicCache {
  const digitSet = (prefix: string): DigitPics => {
    const digits: IndexedPic[] = [];
    for (let d = 0; d <= 9; d++) {
      digits.push(
        decodeHudPic(pak, `${prefix}_${d}`) ?? { width: 16, height: 24, pixels: new Uint8Array(16 * 24) },
      );
    }
    const minus =
      decodeHudPic(pak, `${prefix}_minus`) ?? { width: 16, height: 24, pixels: new Uint8Array(16 * 24) };
    return { digits, minus };
  };
  const icons = new Map<string, IndexedPic>();
  for (const n of [
    'i_health', 'i_bodyarmor', 'i_jacketarmor', 'w_blaster', 'w_shotgun', 'w_sshotgun',
    'w_machinegun', 'w_chaingun', 'w_glauncher', 'w_rlauncher', 'w_hyperblaster',
    'w_railgun', 'w_bfg', 'a_shells', 'a_bullets', 'a_grenades', 'a_cells',
    'a_rockets', 'a_slugs', 'i_help',
  ]) {
    const pic = decodeHudPic(pak, n);
    if (pic) icons.set(n, pic);
  }
  return {
    digits: { num: digitSet('num'), anum: digitSet('anum') },
    field3: decodeHudPic(pak, 'field_3'),
    icons,
    help: decodeHudPic(pak, 'help'),
    inventory: decodeHudPic(pak, 'inventory'),
    tag1: decodeHudPic(pak, 'tag1'),
    tag2: decodeHudPic(pak, 'tag2'),
    victory: decodeHudPic(pak, 'victory'),
  };
}

/**
 * Frame state for the retail statusbar program, derived from the live
 * driver/server (health, ammo, armor, selected weapon, pickup, timer, help).
 * `serverframe` drives the low-health/ammo blink (`(serverframe>>2)&1`).
 *
 * The help slot (stat 11, `if 11 xv 148 pic 11`) follows id `G_SetStats`
 * via the shared `helpIconFor` pure helper (`@q2/client`): `i_help` flashes
 * only while an unacked help change exists (`helpChangedSeq !== helpSeenSeq`,
 * the web stand-in for `pers.helpchanged`) at `(serverframe & 8)` — never an
 * unconditional blink. Frame convention is `Math.floor(serverTime * 10)`,
 * the 10Hz server tick (`HelpIconArgs.frame`). Hand/fov pass the id
 * defaults (right-handed, fov 90, so the slot hides when nothing is pending);
 * TODO(RELEASE-6): forward real hand/fov state if those settings ever land.
 */
export function statusbarStateFor(boot: PlayBoot): StatusbarState {
  const d = boot.driver;
  const ammoKind = d.weapon.ammoKind ? d.weapon.ammoKind : null;
  const ammoIcon = ammoIconFor(ammoKind);
  const ammoCount = ammoKind ? (d.ps.ammo[ammoKind] ?? 0) : 0;
  const hasAmmoRow = ammoKind !== null && ammoCount >= 0;
  const armorIcon = d.ps.armor > 0 ? 'i_bodyarmor' : null;
  const weaponIcon = weaponIconFor(d.weapon.classname);
  const serverframe = Math.floor(boot.host.serverTime * 10);
  const helpPic = helpIconFor({
    helpChanged: boot.helpChangedSeq !== boot.helpSeenSeq ? 1 : 0,
    frame: serverframe,
    centerHanded: false,
    fov: 90,
    weaponIcon,
  });
  const images = [
    'i_health', '', ammoIcon ?? '', '', armorIcon ?? '', '',
    weaponIcon, '', '', '', '', helpPic ?? '',
  ];
  const stats = [
    0, d.playerHealth,
    hasAmmoRow ? 2 : 0, ammoCount,
    armorIcon ? 4 : 0, d.ps.armor,
    6, 0, 0, 0, 0, helpPic ? 11 : 0,
    0, 0, 0, 0,
  ];
  void STAT_SELECTED_ICON; void STAT_PICKUP_ICON; void STAT_PICKUP_STRING;
  void STAT_TIMER; void STAT_HELPICON; void STAT_FLASHES;
  void STAT_AMMO; void STAT_ARMOR; void STAT_HEALTH;
  void HELP_ICON_PIC;
  return {
    stats,
    images,
    configstrings: [],
    serverframe,
    clientInfo: () => null,
  };
}

/**
 * Blit executed statusbar commands with real art: `pic` via drawPic (icons
 * + field_3 background), `field` via drawField (num_/anum_ digit pics),
 * `text` via drawString (conchars). Unknown/missing art is skipped without
 * throwing so one corrupt lump can never blank the HUD.
 */
export function drawStatusbarCmds(
  target: { width: number; height: number; color: Uint32Array },
  boot: PlayBoot,
  w: number,
  h: number,
): void {
  const cache = boot.hudPics;
  const palette = boot.palette;
  if (!cache || !palette) return;
  let cmds;
  try {
    cmds = executeStatusbar(retailOps(), statusbarStateFor(boot), w, h);
  } catch {
    return;
  }
  for (const c of cmds) {
    try {
      if (c.kind === 'pic') {
        const pic = c.name === 'field_3' ? cache.field3 : (cache.icons.get(c.name) ?? null);
        if (pic) drawPic(target, c.x, c.y, pic, palette);
      } else if (c.kind === 'field') {
        drawField(target, c.x, c.y, c.style, c.width, c.value, cache.digits, palette);
      } else if (c.kind === 'text') {
        const x = c.centerWidth > 0 ? c.x + Math.max(0, ((c.centerWidth - stringWidth(c.text)) / 2) | 0) : c.x;
        drawString(target, x, c.y, c.text, c.alt ? 0xff33ff33 : 0xffffffff);
      }
    } catch {
      /* one bad cmd never blanks the HUD */
    }
  }
}

/**
 * F1 help-computer facts (RELEASE-6): id `HelpComputer` (`game/p_hud.c`)
 * sends the LIVE `level.killed_monsters/found_goals/found_secrets` over
 * totals — the `finish*` snapshot (frozen at `SV_FinishLevel`, zero during
 * play) is only for the completion screen. While the level runs this reads
 * the live counters; once finished it reads the frozen snapshot so the
 * totals stay put under post-finish play.
 */
export function helpFactsFor(boot: PlayBoot): HelpFacts {
  const s = boot.driver.server;
  const frozen = s.finished;
  return {
    skill: getSkill(),
    levelName: boot.source === 'pak' ? 'Outer Base' : 'devroom',
    help1: 'Find the exit.',
    help2: 'Watch for soldiers.',
    kills: [frozen ? s.finishKills : s.killedMonsters, s.totalMonsters],
    goals: [frozen ? s.finishGoals : s.foundGoals, s.totalGoals],
    secrets: [frozen ? s.finishSecrets : s.foundSecrets, s.totalSecrets],
  };
}

/**
 * F1 help-computer overlay (RELEASE-6): the 256x192 `help` background
 * centered, plus the `buildHelpLayout` rows executed through the production
 * path (skill label, level name, help text, kills/goals/secrets). Without
 * pak art the readable text rows still draw (devroom fallback).
 */
export function drawHelpOverlay(
  target: { width: number; height: number; color: Uint32Array },
  boot: PlayBoot,
): void {
  const cache = boot.hudPics;
  const palette = boot.palette;
  const w = target.width;
  const h = target.height;
  const hx = Math.max(0, ((w - 256) / 2) | 0);
  const hy = Math.max(0, ((h - 192) / 2) | 0);
  if (cache?.help && palette) {
    try {
      drawPic(target, hx, hy, cache.help, palette);
    } catch {
      /* text rows below still draw */
    }
  } else {
    fillRect(target, hx, hy, 256, 192, 0xcc101010);
  }
  const layout = buildHelpLayout(helpFactsFor(boot));
  let cmds;
  try {
    cmds = executeStatusbar(parseStatusbar(layout), statusbarStateFor(boot), w, h);
  } catch {
    return;
  }
  for (const c of cmds) {
    try {
      if (c.kind === 'pic') {
        const pic = cache?.icons.get(c.name) ?? (c.name === 'help' ? (cache?.help ?? null) : null);
        if (pic && palette) drawPic(target, c.x, c.y, pic, palette);
      } else if (c.kind === 'text') {
        const x = c.centerWidth > 0 ? c.x + Math.max(0, ((c.centerWidth - stringWidth(c.text)) / 2) | 0) : c.x;
        drawString(target, x, c.y, c.text, c.alt ? 0xff33ff33 : 0xffffffff);
      }
    } catch {
      /* skip bad rows */
    }
  }
}

/**
 * Toggle the F1 help-computer overlay (id `Cmd_Help_f`, `game/p_hud.c`):
 * if open AND no help change arrived since it was opened → close; otherwise
 * open + ack (`pers.helpchanged = 0`, i.e. `helpSeenSeq = helpChangedSeq`)
 * + resend the layout (the draw path re-executes `buildHelpLayout` every
 * frame while open, so the resent rows are live on the next present).
 * TODO(RELEASE-6): help-change beep (`misc/pc_up.wav`, ≤3 times at
 * `(framenum & 63) == 0` per `G_SetClientSound`) — no clean driver-sound
 * route exists from this free function (`emitSound` is driver-private, the
 * server sound queue is tick-drained); do not invent audio plumbing until
 * the server lane carries the beep event.
 */
export function toggleHelpOverlay(boot: PlayBoot): boolean {
  if (boot.showHelp && boot.helpSeenSeq >= boot.helpChangedSeq) {
    boot.showHelp = false;
    return boot.showHelp;
  }
  boot.showHelp = true;
  boot.helpSeenSeq = boot.helpChangedSeq;
  return boot.showHelp;
}

/** Draw crosshair + status lines onto a 0xAABBGGRR buffer (runs post-resolve).
 *
 * The play canvas shows world + crosshair + weapon/ammo + hp + message
 * (+ the devroom hint and death bars) + the in-canvas `fps N` counter
 * top-right (gated by `cl_showfps`) + the in-canvas player-position readout
 * top-left (gated by `cl_showpos`, default ON) + the transient gameplay
 * status line (gated by `cl_showmessages`, default ON — cosmetic 'status'
 * one-liners only; death/finish always draw). Both readouts use conchars
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
  // RELEASE-6 asset statusbar (pak + palette + pics): the retail script with
  // real digit/icon art, values, transparency, and xv/yv scaling. Devroom
  // (no pak) keeps the readable text fallback below — never a throw.
  if (boot.hudPics && boot.palette) {
    drawStatusbarCmds(target, boot, target.width, target.height);
  } else {
    const hp = boot.driver.playerHealth;
    const hpColor = boot.driver.playerDead ? 0xffff3333 : hp <= 25 ? 0xffff9933 : white;
    drawString(target, 8, target.height - 18, `${boot.driver.weapon.classname} ${boot.driver.hudAmmo()}`, white);
    drawString(target, 8, target.height - 48, `hp ${hp}`, hpColor);
    if (boot.source === 'devroom') {
      drawString(target, 8, 28, 'devroom - drop pak0.pak for base1', dim);
    }
  }
  if (boot.driver.server.finished) {
    // RELEASE-6 completion (single-player intermission stand-in): id
    // `BeginIntermission` with `level.exitintermission = 1` exits to the next
    // map IMMEDIATELY — no scoreboard/layout screen is ever sent in SP
    // (`MoveClientToIntermission` only uncasts a layout for deathmatch/coop;
    // the totals live in the F1 help computer, frozen here via
    // `helpFactsFor`). base2 is not shipped so there is no next map: the
    // stand-in keeps the player in-world with the frozen `finish*` totals
    // centered in FINISH_BLUE, the gun down (`viewModel` null +
    // `drawViewModel` skipped below), and no world interaction (attack/use/
    // pickup gates on `server.finished`). Deliberate deviations from id:
    // the body keeps its world pose (no intermission-point teleport — there
    // is no intermission spot wired), movement still simulates so the
    // end-lift finishes its leg under a standing rider, and the
    // multiplayer scoreboard is never drawn. `pics/victory.pcx` is never
    // used here: it is the coop end-of-unit plaque (gated in `sv_init.c` on
    // the coop `victory.pcx` level), not SP completion. Asset-free devroom
    // keeps the same text block (no asset dependency).
    const lines = centerPrintPlacement(boot.driver.message, target.width, target.height);
    for (const line of lines) {
      drawString(target, line.x, line.y, line.text, FINISH_BLUE);
    }
  } else if (boot.driver.message) {
    // RELEASE-11 `cl_showmessages`: skip ONLY the transient cosmetic status
    // line (kind 'status') when the cvar is 0. Death ('alert') always draws;
    // the finished screen above never consults this gate. Draw-only: the
    // string, events and stats still update while hidden, and toggling
    // applies immediately (cvar read per frame, no reboot).
    if (messagesVisible() || boot.driver.messageKind !== 'status') {
      const msg = boot.driver.message.slice(0, 48);
      drawString(target, 8, target.height - 30, msg, 0xffffff00);
    }
  }
  // F1 help-computer overlay (toggled by the F1 key, asset bg + layout rows).
  if (boot.showHelp) drawHelpOverlay(target, boot);
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
  // RELEASE-6 intermission-lite: gun down once finished (mirrors the
  // `viewModel` null gate for the 3D path above).
  if (boot.driver.server.finished) return;
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
  // Style scales for this frame (R9F-3): resolved through the driver's
  // lightStyleScale hook (server toggle records); absent → all 1s.
  const gpuLightStyles = new Float32Array(256).fill(1);
  const gpuDriver = host.driver;
  if (gpuDriver && typeof gpuDriver.lightStyleScale === 'function') {
    for (let i = 0; i < 256; i++) {
      const v = gpuDriver.lightStyleScale(i);
      if (Number.isFinite(v)) gpuLightStyles[i] = v;
    }
  }
  const view: RefDef = {
    origin: new Float32Array(eye) as RefDef['origin'],
    angles: new Float32Array(angles) as RefDef['angles'],
    fovX: 90,
    time: host.serverTime,
    lightStyles: gpuLightStyles,
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
 * HUD is always painted post-resolve by the caller (RELEASE-8: no CPU
 * voodoo pre-scanout composition).
 */
export async function frameAsync(boot: PlayBoot, st: AsyncLoopState, nowMs: number, hud?: HudState): Promise<Uint32Array> {
  void hud;
  pumpMuzzleLight(boot);
  pumpExplosionLights(boot);
  pumpTracers(boot);
  stepAsyncSim(boot.host, st, nowMs);
  const { view, renderables } = buildAsyncView(boot.host, st.serverAcc);
  boot.refresh.beginFrame();
  await boot.refresh.renderViewAsync(view, boot.host.world, renderables);
  await boot.refresh.endFrameAsync();
  return resolveDisplay(boot);
}

/* --- GPU-PROOF-5 iteration-1 work-split instrumentation -------------------
 *
 * `frameGpuPlay` timestamps 6 sections per frame with `performance.now()` and
 * records them into the preallocated module-scope ring below. Cost per frame
 * is 7 clock reads + 6 float stores (sub-microsecond against ~17ms frames);
 * the ring is a fixed-size `Float64Array` (pinned capacity, circular index —
 * ZERO allocation per frame, typed arrays only per the hot-path rules). No
 * behavior change: recording never touches sim/render state.
 *
 * Readers (sampled 1Hz by the soak runner / tests, never the frame loop):
 * - `readGpuWorkSplits()` returns medians over the filled ring rows.
 * - `globalThis.__q2soakWork` (installed by `installGpuWorkConveyor`) is the
 *   same reader behind a CDP-evaluable conveyor: the unmodified soak runner
 *   samples it 1Hz without disturbing the loop.
 */

/** Work-split section names, in ring column order. */
export const GPU_WORK_SPLIT_NAMES = ['drains', 'sim', 'view', 'tail', 'submit', 'total'] as const;

/** Ring column count (matches `GPU_WORK_SPLIT_NAMES.length`; pinned). */
export const GPU_WORK_COLS = 6;

/** Ring row capacity (frames retained; oldest evicted past it). */
export const GPU_WORK_RING_CAPACITY = 4096;

/**
 * Work-split ring state. Kept on `globalThis` (like the `@q2/config` store)
 * so the instrumentation survives duplicated module evaluation (vite dev can
 * evaluate the loop entry and the soak entry as separate instances —
 * module-scope state would then silently stay zero for the reader). The
 * ring is allocated once, lazily, and never grows.
 */
interface GpuWorkRingState {
  ring: Float64Array;
  head: number;
  samples: number;
}
declare global {
  var __q2gpuWorkRing__: GpuWorkRingState | undefined;
}
function gpuWorkState(): GpuWorkRingState {
  let s = globalThis.__q2gpuWorkRing__;
  if (s === undefined) {
    s = { ring: new Float64Array(GPU_WORK_RING_CAPACITY * GPU_WORK_COLS), head: 0, samples: 0 };
    globalThis.__q2gpuWorkRing__ = s;
  }
  return s;
}

/** Record one frame's 6 section times (ms). Zero-alloc: 6 stores + index. */
function recordGpuWork(drainsMs: number, simMs: number, viewMs: number, tailMs: number, submitMs: number, totalMs: number): void {
  const st = gpuWorkState();
  const o = st.head * GPU_WORK_COLS;
  st.ring[o] = drainsMs;
  st.ring[o + 1] = simMs;
  st.ring[o + 2] = viewMs;
  st.ring[o + 3] = tailMs;
  st.ring[o + 4] = submitMs;
  st.ring[o + 5] = totalMs;
  st.head = (st.head + 1) % GPU_WORK_RING_CAPACITY;
  if (st.samples < GPU_WORK_RING_CAPACITY) st.samples++;
}

/** Medians over the filled ring rows (ms per section + fill state). */
export interface GpuWorkSplits {
  /** Filled rows (saturates at `capacity` once the ring wraps). */
  samples: number;
  /** Ring capacity (pinned; the backing store never grows). */
  capacity: number;
  drainsMs: number;
  simMs: number;
  viewMs: number;
  tailMs: number;
  submitMs: number;
  totalMs: number;
}

/** Median of a column over the filled rows (scratch alloc: reader path only). */
function gpuWorkMedian(state: GpuWorkRingState, col: number, n: number): number {
  const scratch = new Float32Array(n);
  for (let r = 0; r < n; r++) scratch[r] = state.ring[r * GPU_WORK_COLS + col]!;
  scratch.sort();
  const mid = n >> 1;
  return n % 2 === 1 ? scratch[mid]! : (scratch[mid - 1]! + scratch[mid]!) / 2;
}

/**
 * Medians over the filled work-split ring rows (empty ring → all zeros).
 * Allocates scratch for the medians: call 1Hz from harnesses/CDP or from
 * tests — never from the frame loop.
 */
export function readGpuWorkSplits(): GpuWorkSplits {
  const st = gpuWorkState();
  const n = st.samples;
  if (n <= 0) {
    return { samples: 0, capacity: GPU_WORK_RING_CAPACITY, drainsMs: 0, simMs: 0, viewMs: 0, tailMs: 0, submitMs: 0, totalMs: 0 };
  }
  return {
    samples: n,
    capacity: GPU_WORK_RING_CAPACITY,
    drainsMs: gpuWorkMedian(st, 0, n),
    simMs: gpuWorkMedian(st, 1, n),
    viewMs: gpuWorkMedian(st, 2, n),
    tailMs: gpuWorkMedian(st, 3, n),
    submitMs: gpuWorkMedian(st, 4, n),
    totalMs: gpuWorkMedian(st, 5, n),
  };
}

/**
 * Test/harness-only: clear the work-split ring (never the frame loop).
 * Lets determinism/wrap tests isolate their frames from earlier suites in
 * the same worker (the ring is shared by design — see above).
 */
export function testResetGpuWorkSplits(): void {
  const st = gpuWorkState();
  st.ring.fill(0);
  st.head = 0;
  st.samples = 0;
}

/**
 * Install the `globalThis.__q2soakWork` conveyor (idempotent): the soak
 * runner evaluates `window.__q2soakWork()` at 1Hz to sample section medians
 * without disturbing the loop. Headless-safe (`globalThis`, never `window`).
 */
export function installGpuWorkConveyor(): () => GpuWorkSplits {
  const g = globalThis as unknown as { __q2soakWork?: () => GpuWorkSplits };
  g.__q2soakWork ??= readGpuWorkSplits;
  return g.__q2soakWork;
}

/**
 * One GPU gameplay frame (GPU-PROOF-3): simulation + GPU submission WITHOUT
 * the CPU world span rasterizer.
 *
 * - Simulation, doors, monsters, prediction run unchanged (same Host tick via
 *   `stepAsyncSim`, the documented line-for-line twin of `Host.frame`).
 * - The camera `RefDef` + entity list reuse the EXACT view construction the
 *   CPU path would use (`buildAsyncView`, the same helper `frameAsync` uses).
 * - CRITICAL: `refresh.renderView` is NEVER called here — no CPU world span
 *   rasterization runs in parallel with the GPU submit. HUD painting continues
 *   on the 2D overlay canvas (see `paintHudOverlay`, called by the rAF tick).
 * - World selection (GPU-FOLLOW-2): every frame re-selects the world for
 *   the CURRENT view via the committed `refreshGpuScene` (fresh PVS union,
 *   frustum cull, backface rule, world+entity blend re-sort far->near).
 *   Nothing is ever reused from a spawn-view subset: turning/translating
 *   reveals newly visible surfaces immediately. The passed `generation`
 *   stays the boot one, so persistent uploads stay 1 across N frames, and
 *   the committed `WebGLRenderer` draws only the submitted ranges (no mesh
 *   rebuild). `transforms` carries the fresh `[identity]` + yaw-only entity
 *   slots (the renderer derives full-basis entity matrices per frame from
 *   `setEntities` and never consumes these slots).
 * - Dynamic lights/beams: the one-shot driver queues are drained HERE into
 *   GPU inputs (`lights` + synthesized beam entities) instead of the CPU
 *   pumps — the CPU pools would be purposeless since CPU renderView never
 *   runs. Mappings mirror the CPU pumps exactly (muzzle [1,1,0], explosion
 *   [1,.5,.5]/350, blaster [1,1,0]/150, bolt 200).
 * - Work-split instrumentation (GPU-PROOF-5 iteration 1, always on):
 *   `performance.now()` section timings accumulate into the module-scope
 *   ring (see above); sample via `readGpuWorkSplits()` /
 *   `window.__q2soakWork()`. No behavior change.
 *
 * Returns the live backend status (`framesSubmitted` counts real on-canvas
 * submissions), or null when no GPU backend is attached (caller gates on
 * `boot.gpu`). Returns null (no-op) without a GPU backend.
 */
export function frameGpuPlay(boot: PlayBoot, nowMs: number): GpuRendererStatus | null {
  const g = boot.gpu;
  if (!g) return null;
  // GPU-FOLLOW-4 (1): a lost context submits nothing (safe stop). The sim
  // clock freezes with it — frames resume via notifyGpuContextRestored.
  if (g.contextLost) return null;
  try {
    if (g.gpu.getStatus().contextLost) return null;
  } catch {
    /* a throwing status probe never submits either */
    return null;
  }
  // RELEASE-3: keep the GL backing/viewport in sync with the framebuffer.
  // Reboot creates a matched backend, but a missed resize (or a mid-loop
  // resolution latch) would otherwise offset the scene center from the
  // HUD crosshair. Best-effort self-heal, never throws.
  try {
    const fbW = boot.host.fb.width;
    const fbH = boot.host.fb.height;
    const st = g.gpu.getStatus() as unknown as { width?: number; height?: number };
    if (typeof st.width === 'number' && typeof st.height === 'number') {
      if (st.width !== fbW || st.height !== fbH) resizeGpuBackend(boot, fbW, fbH);
    } else {
      const cv = g.canvas as unknown as { width?: number; height?: number } | undefined;
      if (cv && (cv.width !== fbW || cv.height !== fbH)) resizeGpuBackend(boot, fbW, fbH);
    }
  } catch {
    /* presentation best-effort */
  }
  const tDrain0 = performance.now();
  // GPU-side dynamic drains (mirror pumpMuzzleLight/pumpExplosionLights/
  // pumpBoltLights/pumpTracers mappings; one-shot queues, so the CPU pumps
  // are skipped — CPU renderView never runs in this path).
  const lights: GpuLight[] = [];
  const flash = boot.driver.drainFlash();
  if (flash) {
    lights.push({
      origin: new Float32Array([flash[0]!, flash[1]!, flash[2]!]),
      color: new Float32Array([1, 1, 0]),
      intensity: boot.driver.peekFlashIntensity(),
    });
  }
  for (const f of boot.driver.drainEnemyMuzzle()) {
    lights.push({
      origin: new Float32Array([f.pos[0]!, f.pos[1]!, f.pos[2]!]),
      color: new Float32Array([1, 1, 0]),
      intensity: f.intensity,
    });
  }
  for (const f of boot.driver.drainExplosions()) {
    const isBlast = f.kind === 'blaster';
    lights.push({
      origin: new Float32Array([f.pos[0]!, f.pos[1]!, f.pos[2]!]),
      color: isBlast ? new Float32Array([1, 1, 0]) : new Float32Array([1, 0.5, 0.5]),
      intensity: (isBlast ? 150 : 350) * f.alpha,
    });
  }
  for (const bolt of boot.driver.bolts) {
    lights.push({
      origin: new Float32Array([bolt.pos[0]!, bolt.pos[1]!, bolt.pos[2]!]),
      color: new Float32Array([1, 1, 0]),
      intensity: 200,
    });
  }
  // Live beams: the driver tracer queue drains here into synthesized beam
  // entities (FOLLOW-3 `synthesizeBeamEntities`: origin=start, angles=dir,
  // frame=length, skin=color — the contract-free beam convention
  // `resolveBeam` reads). Negative model handles never collide with registry
  // handles (>= 0). The kind map carries the FULL retained-asset metadata
  // (every registered md2/sp2 handle keeps its kind, not just the tracer
  // entries), so selection and draw dispatch agree without depending on
  // registry fallthrough.
  const beamSyn = synthesizeBeamEntities(boot.driver.drainTracers());
  const beams: Entity[] = beamSyn.entities;
  const modelKinds = modelKindsForFrame(boot.models, beamSyn.kinds.keys());
  const tSim0 = performance.now();
  stepAsyncSim(boot.host, g.loop, nowMs);
  const tView0 = performance.now();
  const { view, renderables } = buildAsyncView(boot.host, g.loop.serverAcc);
  const entities = beams.length > 0 ? [...renderables, ...beams] : renderables;
  // PROOF-4 appearance wiring (no shader work): re-read the pinned vd_*
  // cvars EVERY frame (no stale profile) and make them effective WITHOUT new
  // backend methods. `pushGpuAppearance` feature-detects a future GL-lane
  // setter (none exists in the committed dist — returns false); either way
  // the snapshot lands on `g.appearance`, observable in tests. The GL canvas
  // is the ONLY appearance target: the HUD overlay plane is never touched
  // here (see `paintHudOverlay`).
  const appearance = readGpuAppearanceSnapshot();
  g.appearance = appearance;
  pushGpuAppearance(g.gpu, appearance);
  const tTail0 = performance.now();
  // FOLLOW-2: fresh world selection for the CURRENT view every frame (never
  // a cached spawn-view subset). Generation stays the boot one, so the
  // renderer keeps its persistent uploads and draws the new ranges.
  const scene = refreshGpuScene(
    boot.driver.mini,
    entities,
    view,
    boot.host.fb.width,
    boot.host.fb.height,
    modelKinds.size > 0 ? modelKinds : undefined,
    g.staticScene.staticGeneration,
  );
  const tSubmit0 = performance.now();
  g.gpu.setScene(scene);
  g.gpu.setEntities(entities, modelKinds.size > 0 ? modelKinds : undefined);
  g.scene = scene;
  g.gpu.renderFrame({ view, scene, time: view.time, lights });
  const tEnd = performance.now();
  recordGpuWork(
    tSim0 - tDrain0,
    tView0 - tSim0,
    tTail0 - tView0,
    tSubmit0 - tTail0,
    tEnd - tSubmit0,
    tEnd - tDrain0,
  );
  return g.gpu.getStatus();
}

/**
 * Transparent HUD overlay for the live GPU loop (GPU-PROOF-3): zeroes the
 * shell-owned display plane (transparent black — the GL scene shows through
 * everywhere except the HUD) and paints the SAME `drawPlayHud` pass the CPU
 * path runs post-resolve. The caller blits the returned buffer to the 2D
 * overlay canvas (`blitToCanvas` preserves alpha via putImageData), which sits
 * ABOVE the GL canvas (see `acquireGpuCanvas` ordering) — so HUD presentation
 * is preserved with zero HUD-code changes (no HUD redesign here; any richer
 * GPU-resident HUD composition is a PROOF-4/EXPAND gap, documented in the
 * PROOF-3 report).
 */
export function paintHudOverlay(boot: PlayBoot, hud: HudState): Uint32Array {
  boot.display.fill(0);
  drawPlayHud(
    { width: boot.host.fb.width, height: boot.host.fb.height, color: boot.display },
    boot,
    hud,
  );
  return boot.display;
}

/* --- PERF-FINISH-B instrumented stage capture (never the production loop).
 * `measureFrameStages` twins `frameAsync` with per-stage probes; the rAF
 * tick never calls it. Harnesses only (tests, `__q2bench.measure`). */

/** One instrumented frame's per-stage wall times + frame counters. */
export interface StageReport {
  pumpsMs: number;
  simMs: number;
  viewMs: number;
  beginMs: number;
  renderMs: number;
  /** Renderer-internal renderView clock (FrameStats.ms: GEO+DRAW, no await). */
  renderInternalMs: number;
  endMs: number;
  resolveMs: number;
  /** Post-resolve HUD draw (0 when no HUD was passed). */
  hudMs: number;
  /** Optional blit stage (0 when no blit callback was passed). */
  blitMs: number;
  spans: number;
  pixels: number;
  overdraw: number;
  pooled: boolean;
  bands: number;
  /** Bytes staged for the frame kick (pool probe; -1 when unpooled). */
  stageBytes: number;
  /**
   * Staging breakdown (null when unpooled): transient = per-frame uploads
   * (spans/tex/light, freed after the kick); descs = indexed descriptor
   * count inspected by the kick.
   */
  stageDetail: { transientBytes: number; descs: number } | null;
  /** Pool raster-kick failures across this frame's raster stage (0 healthy). */
  rasterFallbacks: number;
  /**
   * Span entries actually inspected by this frame's successful pool kicks
   * (workers + main band, raster lane). -1 when the build exposes
   * no inspected-span counters (older builds — never mistake 0 for proof;
   * see kickStats.scannedAvailable). Compare against `stageDetail.descs`
   * and `spans` to prove ordered subranges skip non-owned rows.
   */
  scannedSpans: number;
  /**
   * JS heap delta across the instrumented frame in MiB (null without
   * `performance.memory` — Chromium only; harness trend signal, not a
   * budget gate; production frames never sample it).
   */
  heapDeltaMB: number | null;
  /**
   * Last-kick diagnostic snapshot when armed (see DiagSnapshot: frame/seq
   * + job identity, rank-ordered dispatch-to-completion arrivals with band
   * attribution, critical-path slowestMs, within-kick worker-compute
   * max/median/imbalance). Null when disarmed — the production path never
   * allocates it.
   */
  diag: DiagSnapshot | null;
  /**
   * This frame's kick attempts in issue order (empty when disarmed):
   * per-kick (frame, seq, job) identity + outcome + within-kick worker
   * max/median + dispatch critical path + inter-kick gap (raster flush
   * first, then the resolve kick). Independent medians are never summed
   * or subtracted across entries: the frame's story is the list, and
   * cross-rep analysis belongs to the bench/testkit lanes.
   */
  kickTimings: KickTiming[];
  resolveOrder: ResolveOrder;
}

/** Current JS heap in MiB, or null without Chromium's performance.memory. */
function heapNowMB(): number | null {
  try {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize?: unknown } }).memory;
    const used = mem?.usedJSHeapSize;
    if (typeof used === 'number' && Number.isFinite(used)) return used / 1048576;
  } catch {
    /* non-Chromium: no heap signal */
  }
  return null;
}

/** Heap delta in MiB since a heapNowMB baseline (null when either is null). */
function heapDelta(before: number | null): number | null {
  if (before === null) return null;
  const after = heapNowMB();
  return after === null ? null : after - before;
}

/**
 * Run one frame exactly like `frameAsync`, timing each stage. Call from
 * harnesses only (tests, `__q2bench.measure`); never from the rAF tick.
 * Mutates exactly like `frameAsync` plus the optional post-resolve HUD
 * draw and the optional `blit` callback (the harness blits the resolved
 * target to the real canvas to time presentation; production never
 * passes it). RELEASE-8: HUD is always painted post-resolve (no CPU
 * voodoo pre-scanout composition).
 */
export async function measureFrameStages(
  boot: PlayBoot, st: AsyncLoopState, nowMs: number, hud?: HudState,
  blit?: (target: Uint32Array) => void,
): Promise<StageReport> {
  const t00 = performance.now();
  // JS heap baseline (Chromium-only; null everywhere else — see heapDelta).
  const heapBefore = heapNowMB();
  pumpMuzzleLight(boot);
  pumpExplosionLights(boot);
  pumpTracers(boot);
  const t01 = performance.now();
  stepAsyncSim(boot.host, st, nowMs);
  const t02 = performance.now();
  const { view, renderables } = buildAsyncView(boot.host, st.serverAcc);
  const t03 = performance.now();
  // Pool kick outcomes + per-kick timing baseline BEFORE the frame's kicks
  // run (PERF-NEXT-4 true per-frame attribution): the render stage below
  // is where the indexed raster kick happens, so sampling here — not
  // after — makes the deltas below cover exactly this frame.
  // `scanned` needs the same before snapshot (monotonic counters);
  // `kickKeysBefore` identifies this frame's ledger entries by
  // (frame, seq, job, outcome) identity afterward. -1/empty downstream
  // when unavailable or disarmed.
  let rasterFbBefore = 0;
  let scannedBefore = 0;
  let scannedAvailBefore = false;
  let kickKeysBefore: Set<string> | null = null;
  try {
    const pool = boot.browserPool as unknown as {
      kickStats?: () => {
        fallbacks: { raster: number };
        scanned: { raster: number };
        scannedAvailable: boolean;
      };
      kickTimings?: () => Array<{
        frame: number; seq: number; job: string; outcome: string;
      }>;
    } | null;
    if (pool && typeof pool.kickStats === 'function') {
      const ks = pool.kickStats();
      rasterFbBefore = ks.fallbacks.raster | 0;
      scannedBefore = ks.scanned.raster | 0;
      scannedAvailBefore = ks.scannedAvailable === true;
    }
    if (pool && typeof pool.kickTimings === 'function') {
      kickKeysBefore = new Set(
        pool.kickTimings().map((k) => `${k.frame}:${k.seq}:${k.job}:${k.outcome}`),
      );
    }
  } catch { /* unpooled/foreign pool: zeros stand */ }
  boot.refresh.beginFrame();
  const t04 = performance.now();
  const stats = await boot.refresh.renderViewAsync(view, boot.host.world, renderables);
  const t05 = performance.now();
  await boot.refresh.endFrameAsync();
  const t06 = performance.now();
  const target = resolveDisplay(boot);
  const t07 = performance.now();
  let hudMs = 0;
  if (hud !== undefined) {
    const t08 = performance.now();
    drawPlayHud(
      { width: boot.host.fb.width, height: boot.host.fb.height, color: target },
      boot, hud,
    );
    hudMs = performance.now() - t08;
  }
  let blitMs = 0;
  if (blit !== undefined) {
    const t09 = performance.now();
    blit(target);
    blitMs = performance.now() - t09;
  }
  let pooled = false, bands = 1;
  try {
    const ws = boot.refresh.testWorkerStats();
    pooled = ws.pooled; bands = ws.bands;
  } catch { /* single-threaded fallback: defaults stand */ }
  let stageBytes = -1;
  let stageDetail: StageReport['stageDetail'] = null;
  try {
    const pool = boot.browserPool as unknown as {
      kickBytes?: () => {
        total: number; idxSpans: number; idxTex: number; idxLight: number;
        idxDescs: number;
      } | null;
      stagingBytes?: () => {
        total: number; idxSpans: number; idxTex: number; idxLight: number;
        idxDescs: number;
      };
    } | null;
    // Prefer the frozen last-kick snapshot (post-kick live offsets read
    // zeros — the drain resets them); fall back to the live view.
    const sb = (pool && typeof pool.kickBytes === 'function' && pool.kickBytes()) ||
      (pool && typeof pool.stagingBytes === 'function' ? pool.stagingBytes() : null);
    if (sb) {
      stageBytes = sb.total;
      stageDetail = {
        transientBytes: sb.idxSpans + sb.idxTex + sb.idxLight,
        descs: sb.idxDescs | 0,
      };
    }
  } catch { /* unpooled: -1/null stand */ }
  let diag: StageReport['diag'] = null;
  try {
    const pool = boot.browserPool as unknown as {
      diagSnapshot?: () => StageReport['diag'];
    } | null;
    if (pool && typeof pool.diagSnapshot === 'function') {
      diag = pool.diagSnapshot();
    }
  } catch { /* disarmed: null stands */ }
  // Pool raster-kick fallback + inspected-span deltas across this frame's
  // raster stage (0 healthy): the before baselines above ran pre-render,
  // so these deltas cover exactly this frame.
  let rasterFallbacks = 0;
  let scannedSpans = -1;
  // This frame's kick attempts in issue order (PERF-NEXT-4 per-frame
  // attribution): ledger entries absent from the pre-render baseline are
  // this frame's kicks — the raster flush first, then the resolve kick.
  // Empty when disarmed.
  let kickTimings: KickTiming[] = [];
  try {
    const pool = boot.browserPool as unknown as {
      kickStats?: () => {
        fallbacks: { raster: number };
        scanned: { raster: number };
        scannedAvailable: boolean;
      };
      kickTimings?: () => KickTiming[];
    } | null;
    if (pool && typeof pool.kickStats === 'function') {
      const ks = pool.kickStats();
      rasterFallbacks = (ks.fallbacks.raster | 0) - rasterFbBefore;
      if (scannedAvailBefore || ks.scannedAvailable === true) {
        scannedSpans = (ks.scanned.raster | 0) - scannedBefore;
      }
    }
    if (pool && typeof pool.kickTimings === 'function') {
      const after = pool.kickTimings();
      kickTimings = kickKeysBefore === null
        ? after
        : after.filter((k) => !kickKeysBefore.has(`${k.frame}:${k.seq}:${k.job}:${k.outcome}`));
    }
  } catch { /* unpooled/foreign pool: 0/-1/[] stand */ }
  // JS heap delta (Chromium-only performance.memory; harness trend signal,
  // never a budget gate; two same-process samples, no cross-clock math).
  const heapDeltaMB = heapDelta(heapBefore);
  return {
    pumpsMs: t01 - t00, simMs: t02 - t01, viewMs: t03 - t02,
    beginMs: t04 - t03, renderMs: t05 - t04,
    renderInternalMs: stats.ms, endMs: t06 - t05,
    resolveMs: t07 - t06, hudMs, blitMs,
    spans: stats.spans, pixels: stats.pixels, overdraw: stats.overdraw,
    pooled, bands, stageBytes, stageDetail,
    rasterFallbacks,
    scannedSpans,
    diag,
    kickTimings,
    heapDeltaMB,
    resolveOrder: boot.lastResolveOrder,
  };
}
