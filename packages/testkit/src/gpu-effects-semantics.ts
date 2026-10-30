// @q2/testkit — GPU-FOLLOW-3 lane C: live arsenal + required-effects coverage.
//
// Owns (testkit ONLY — never edit from another lane's packages):
//   - the supported-inventory catalogs (weapons/enemies/pickups by value from
//     `@q2/game` tables — testkit must NOT import `@q2/game`, see
//     `yarn deps:check`; sources cited per constant);
//   - the live-path observation shape (`Follow3LiveCapture`) the apps/web
//     lane fills per combat leg (coordinate by NAME only — apps/web maps its
//     `SoakRouteSnapshot` fields into this shape, testkit never imports
//     apps/web);
//   - the hermetic single-room effect fixture (`buildEffectFixtureWorld`)
//     with one sprite, particle cluster, beam, translucent explosion and
//     dynamic light against an opaque backdrop;
//   - the CPU oracle (`deriveFollow3EffectOracle`): per-kind visible-pixel
//     floors come from actual `SoftwareRenderer` renders (effect on vs off
//     deltas) and per-kind submitted-geometry floors come from the pure
//     `refreshGpuScene` selector classification — never from GPU/renderer
//     self-agreement on the live path;
//   - the validators (`validateLiveArsenal`, `validateRequiredEffects`,
//     `validateFollow3Coverage`) plus the combat-event drain gate
//     (`validateEffectEventDrain`).
//
// Ownership boundary (BRAIN.md §7: helper/type ownership explicit):
//   - `tools/bench` keeps its own submission/timing measurement; it must NOT
//     duplicate these semantic types — import them from `@q2/testkit`.
//   - `validateSceneCoverage` (gpu-acceptance.ts) is UNCHANGED: the combined
//     `validateFollow3Coverage` wires arsenal + effects + drain results in
//     without touching the frozen submission/capture gate.
//   - Sky / water-warp / turbulent-translucent appearance IMPLEMENTATION
//     belongs to the webgl-renderer + apps/web lanes; this file pins only
//     the arsenal/effects coverage boxes named in the lane task.
//
// GPU-resident HUD is optional by card: `FOLLOW3_HUD_POLICY` records the
// standing policy and `formatFollow3HudNote` reports a measurement line.
// No validator here fails on HUD residency.
//
// No DOM, no fs, no `any` in exported signatures. Pure validators, fixture
// builders and CPU-oracle derivation only (renders run through the public
// `SoftwareRenderer` API, hermetic at 96x72).

import { createFramebuffer, type Entity, type RefDef, type WorldModel } from '@q2/renderer-api';
import {
  createBoxMesh,
  SoftwareRenderer,
  type MiniSurf,
  type MiniWorld,
} from '@q2/sw-renderer';
import { refreshGpuScene, type GpuEntityModelKind } from '@q2/webgl-renderer';
import {
  validateSceneCoverage,
  type GpuAcceptanceVerdict,
  type GpuCoverageEvidence,
} from './gpu-acceptance.js';

// --- Supported-inventory catalogs (by value from @q2/game, never imported) --
//
// Sources (BRAIN.md §3 dependency flow forbids testkit -> game):
//   - weapons: `packages/game/src/weapons.ts` WEAPON_* classnames
//     (`weapon_blaster/shotgun/machinegun` = the three base1 live weapons per
//     BRAIN.md §2 mission; the rest are SP-remnant defs that must exist);
//     view/world model lumps in `packages/game/src/assets.ts`
//     WEAPON_VIEW_MODELS / WEAPON_WORLD_MODELS; `apps/web/src/dom.ts`
//     Digit1/2/3 selects exactly the three live weapons.
//   - enemies: `packages/game/src/assets.ts` MONSTER_MODELS keys
//     (soldier/gunner/infantry); base1 spawns soldier + infantry
//     (apps/web base1-gate legs (f)/(h)), gunner is precached/registered.
//   - pickups: `packages/game/src/items.ts` ITEMS classnames; base1-gate leg
//     (h) proves the `weapon_shotgun` take on the live path.

/** Live-path weapons: every one must be FIRED on the route (not just held). */
export const FOLLOW3_LIVE_WEAPONS: readonly string[] = [
  'weapon_blaster',
  'weapon_shotgun',
  'weapon_machinegun',
];

/** Every known weapon classname (supported inventory incl. SP remnants). */
export const FOLLOW3_KNOWN_WEAPONS: readonly string[] = [
  'weapon_blaster',
  'weapon_shotgun',
  'weapon_machinegun',
  'weapon_supershotgun',
  'weapon_chaingun',
  'weapon_grenades',
  'weapon_grenadelauncher',
  'weapon_rocketlauncher',
  'weapon_hyperblaster',
  'weapon_railgun',
  'weapon_bfg',
];

/** Enemies that must be observed ALIVE on the live route (base1-spawned). */
export const FOLLOW3_REQUIRED_ENEMIES: readonly string[] = ['soldier', 'infantry'];

/** Every supported enemy kind (required + precached/registered, e.g. gunner). */
export const FOLLOW3_SUPPORTED_ENEMIES: readonly string[] = ['soldier', 'gunner', 'infantry'];

/**
 * Pickups that must be TAKEN on the live route. Kept to the gate-proven set
 * (base1-gate leg (h): `weapon_shotgun` take wakes the t55 pair). The apps/web
 * lane extends this list IN THIS FILE as the route proves further takes —
 * this file is the single testkit-owned owner of the required set.
 */
export const FOLLOW3_REQUIRED_PICKUPS: readonly string[] = ['weapon_shotgun'];

/** Every supported pickup classname (taken entries must be members). */
export const FOLLOW3_SUPPORTED_PICKUPS: readonly string[] = [
  'weapon_blaster',
  'weapon_shotgun',
  'weapon_machinegun',
  'ammo_shells',
  'ammo_bullets',
  'ammo_cells',
  'ammo_rockets',
  'ammo_slugs',
  'ammo_grenades',
  'item_health_small',
  'item_health',
  'item_health_large',
  'item_health_mega',
  'item_armor_shard',
  'item_armor_jacket',
  'item_armor_combat',
  'item_armor_body',
  'item_adrenaline',
  'item_silencer',
];

/** Required live-path effect kinds (card box: sprites/particles/beams/explosions/lights). */
export type Follow3EffectKind = 'sprite' | 'particle' | 'beam' | 'explosion' | 'light';
export const FOLLOW3_REQUIRED_EFFECTS: readonly Follow3EffectKind[] = [
  'sprite',
  'particle',
  'beam',
  'explosion',
  'light',
];

/** Drawable effect kinds (visible-pixel attribution applies; lights gate on submission + CPU lit-delta). */
export type Follow3DrawableEffect = 'sprite' | 'particle' | 'beam' | 'explosion';

// --- Live-path observation shape (apps/web lane produces this) --------------
//
// The apps/web FOLLOW-3 lane drives the production page through combat legs
// (fire every live weapon, take the required pickups, trigger impacts +
// explosions + muzzle lights) and records ONE capture per leg. Testkit
// DEFINES this shape; apps/web FILLS it (coordinate by name only — never
// import apps/web here). Field mapping from `SoakRouteSnapshot` (apps/web
// `src/soak.ts`, owned by the apps/web lane):
//   weaponsFired   <- driver weapon-fire log (one entry per weapon class fired)
//   enemiesObserved<- `monsterKinds` (distinct alive kinds) per leg, unioned
//   pickupsTaken   <- driver `pickup` events (item classnames taken)
//   submitted      <- scene census: world sprite/particle counts + entity-ref
//                     material census (beam refs, translucent-alias refs) +
//                     dynamic-light count pumped that leg
//   entityRefs     <- `scene.entityRefs` (healthy-submission-counts anchor)
//   pixels         <- per-kind visible-pixel attribution from composed-page
//                     captures during the combat leg
//   uploadErrors   <- `warnings` GL/upload errors observed (must be 0)
//   missingMeshes  <- backend missing-mesh/skin warnings (must be empty)

/** Submitted-geometry census per required effect kind (live-page evidence). */
export interface Follow3EffectCounts {
  sprites: number;
  particles: number;
  beams: number;
  explosions: number;
  lights: number;
}

/** Visible-pixel attribution per drawable effect kind (composed capture). */
export interface Follow3EffectPixels {
  sprites: number;
  particles: number;
  beams: number;
  explosions: number;
}

/** Submitted-geometry census key per required effect kind (live evidence fields are plural). */
export const FOLLOW3_SUBMITTED_KEY: Record<Follow3EffectKind, keyof Follow3EffectCounts> = {
  sprite: 'sprites',
  particle: 'particles',
  beam: 'beams',
  explosion: 'explosions',
  light: 'lights',
};

/** Visible-pixel attribution key per drawable effect kind. */
export const FOLLOW3_PIXEL_KEY: Record<Follow3DrawableEffect, keyof Follow3EffectPixels> = {
  sprite: 'sprites',
  particle: 'particles',
  beam: 'beams',
  explosion: 'explosions',
};
/** One combat-leg capture: arsenal exercised + effects submitted + visible. */
export interface Follow3LiveCapture {
  coverage: GpuCoverageEvidence;
  weaponsFired: readonly string[];
  enemiesObserved: readonly string[];
  pickupsTaken: readonly string[];
  submitted: Follow3EffectCounts;
  /** Submitted entity-ref tail size (healthy-count anchor next to coverage). */
  entityRefs: number;
  pixels: Follow3EffectPixels;
  /** GL/upload errors observed on the leg (must be 0). */
  uploadErrors: number;
  /** Missing-mesh/skin warnings (must be empty in supported scenes). */
  missingMeshes: readonly string[];
}

// --- Combat-event log (event -> geometry linkage) ----------------------------

/** Combat event kinds the live path must drain in tick order. */
export type Follow3CombatEventKind =
  | 'fire-blaster'
  | 'fire-shotgun'
  | 'fire-machinegun'
  | 'monster-shot'
  | 'bolt-impact'
  | 'hitscan-impact'
  | 'pickup';

/** One drained combat event (server tick order; ids unique per drain). */
export interface Follow3CombatEvent {
  /** Drain-unique id (a repeated id = double-consumed event). */
  id: number;
  kind: Follow3CombatEventKind;
  /** Server tick time in seconds (level.time semantics, never wall-clock). */
  tick: number;
}

function isPlayerFire(kind: Follow3CombatEventKind): boolean {
  return kind === 'fire-blaster' || kind === 'fire-shotgun' || kind === 'fire-machinegun';
}

function isFire(kind: Follow3CombatEventKind): boolean {
  return isPlayerFire(kind) || kind === 'monster-shot';
}

function isImpact(kind: Follow3CombatEventKind): boolean {
  return kind === 'bolt-impact' || kind === 'hitscan-impact';
}

/**
 * Event-drain gate: proves combat events drain in the intended tick order
 * without dropping or double-consuming. FAILs on an empty log (combat never
 * happened), duplicate ids (double-consume), decreasing ticks (order
 * violated), or an impact with no preceding fire (dropped producer).
 * Pure: no rendering, no IO.
 */
export function validateEffectEventDrain(events: readonly Follow3CombatEvent[]): GpuAcceptanceVerdict {
  const reasons: string[] = [];
  if (events.length === 0) {
    return { verdict: 'FAIL', reasons: ['drain FAIL: no combat events recorded (live path never fired)'] };
  }
  const seen = new Set<number>();
  for (const e of events) {
    if (seen.has(e.id)) reasons.push(`drain FAIL: event id ${e.id} consumed twice (double-consume, drain must claim each event once)`);
    seen.add(e.id);
  }
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.tick < events[i - 1]!.tick) {
      reasons.push(
        `drain FAIL: tick order violated at log position ${i} (${events[i - 1]!.tick} -> ${events[i]!.tick}; drains run in intended tick order)`,
      );
      break;
    }
  }
  let fires = 0;
  let playerFires = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (isFire(e.kind)) fires++;
    if (isPlayerFire(e.kind)) playerFires++;
    if (isImpact(e.kind)) {
      let causal = false;
      for (let j = 0; j < i; j++) {
        if (isFire(events[j]!.kind) && events[j]!.tick <= e.tick) {
          causal = true;
          break;
        }
      }
      if (!causal) {
        reasons.push(`drain FAIL: '${e.kind}' id ${e.id} at tick ${e.tick} has no preceding fire event (producer dropped?)`);
      }
    }
  }
  if (fires === 0) reasons.push('drain FAIL: no fire event in the log (impacts without producers prove nothing)');
  if (playerFires === 0) {
    reasons.push('drain FAIL: no player fire event (live path must fire player weapons, not only monster shots)');
  }
  if (reasons.length > 0) return { verdict: 'FAIL', reasons };
  return {
    verdict: 'PASS',
    reasons: [`drain PASS: ${events.length} combat event(s) in tick order, ids unique, every impact causally fired`],
  };
}

// --- Validators --------------------------------------------------------------

/**
 * Arsenal gate: PASS only when every live weapon was fired, every required
 * enemy observed alive, every required pickup taken, every recorded entry is
 * a known-supported classname (unknown = wiring bug, never ignored), and no
 * missing-mesh/skin warnings were recorded in the supported scene.
 */
export function validateLiveArsenal(capture: Follow3LiveCapture): GpuAcceptanceVerdict {
  const reasons: string[] = [];
  for (const w of FOLLOW3_LIVE_WEAPONS) {
    if (!capture.weaponsFired.includes(w)) {
      reasons.push(`arsenal FAIL: live weapon '${w}' never fired on the route (fire every supported weapon, fixtures alone are insufficient)`);
    }
  }
  for (const w of capture.weaponsFired) {
    if (!FOLLOW3_KNOWN_WEAPONS.includes(w)) {
      reasons.push(`arsenal FAIL: unknown weapon '${w}' recorded (not a supported classname — wiring bug?)`);
    }
  }
  for (const k of FOLLOW3_REQUIRED_ENEMIES) {
    if (!capture.enemiesObserved.includes(k)) {
      reasons.push(`arsenal FAIL: enemy '${k}' never observed alive (spawned in base1 — route must visit it)`);
    }
  }
  for (const k of capture.enemiesObserved) {
    if (!FOLLOW3_SUPPORTED_ENEMIES.includes(k)) {
      reasons.push(`arsenal FAIL: unknown enemy kind '${k}' recorded (not a supported kind — wiring bug?)`);
    }
  }
  for (const p of FOLLOW3_REQUIRED_PICKUPS) {
    if (!capture.pickupsTaken.includes(p)) {
      reasons.push(`arsenal FAIL: pickup '${p}' never taken on the route (walk the take, fixtures alone are insufficient)`);
    }
  }
  for (const p of capture.pickupsTaken) {
    if (!FOLLOW3_SUPPORTED_PICKUPS.includes(p)) {
      reasons.push(`arsenal FAIL: unknown pickup '${p}' recorded (not a supported classname — wiring bug?)`);
    }
  }
  if (capture.missingMeshes.length > 0) {
    reasons.push(`arsenal FAIL: missingMeshes=[${capture.missingMeshes.join(', ')}] (required meshes/skins absent in a supported scene)`);
  }
  if (reasons.length > 0) return { verdict: 'FAIL', reasons };
  return {
    verdict: 'PASS',
    reasons: [
      `arsenal PASS: ${FOLLOW3_LIVE_WEAPONS.length} weapon(s) fired, ${FOLLOW3_REQUIRED_ENEMIES.length} enemie(s) observed, ${FOLLOW3_REQUIRED_PICKUPS.length} pickup(s) taken, meshes clean`,
    ],
  };
}

/** CPU-derived oracle: per-kind submitted-geometry and visible-pixel floors. */
export interface Follow3EffectOracle {
  /** Minimum submitted-geometry count per kind (presence gate). */
  minSubmitted: Record<Follow3EffectKind, number>;
  /** Minimum visible pixels per drawable kind (CPU-render-derived). */
  minPixels: Record<Follow3DrawableEffect, number>;
  /** CPU-rendered lit-delta pixels for the dynamic light (report evidence; lights gate on submission). */
  lightDeltaPixels: number;
}

/**
 * Required-effects gate: PASS only when every required kind was submitted at
 * a healthy count (>= CPU-derived floor), every drawable kind reads visible
 * pixels above its CPU floor (combat event -> submitted geometry -> visible
 * pixels), and no upload errors or missing-mesh warnings were recorded.
 * A scene with healthy frames/uploads but zero beam pixels FAILS here.
 */
export function validateRequiredEffects(
  oracle: Follow3EffectOracle,
  capture: Follow3LiveCapture,
): GpuAcceptanceVerdict {
  const reasons: string[] = [];
  const kinds: Follow3EffectKind[] = [...FOLLOW3_REQUIRED_EFFECTS];
  for (const k of kinds) {
    const n = capture.submitted[FOLLOW3_SUBMITTED_KEY[k]];
    if (!(n >= oracle.minSubmitted[k])) {
      reasons.push(
        `effects FAIL: '${k}' submitted ${n} < min ${oracle.minSubmitted[k]} (combat event produced no submitted geometry — drain dropped it?)`,
      );
    }
  }
  const drawables: Follow3DrawableEffect[] = ['sprite', 'particle', 'beam', 'explosion'];
  for (const k of drawables) {
    const px = capture.pixels[FOLLOW3_PIXEL_KEY[k]];
    if (!(px >= oracle.minPixels[k])) {
      reasons.push(
        `effects FAIL: '${k}' reads ${px}px < min ${oracle.minPixels[k]}px (submitted but invisible — upload/classify/blend bug?)`,
      );
    }
  }
  if (!(capture.uploadErrors === 0)) {
    reasons.push(`effects FAIL: uploadErrors=${capture.uploadErrors} (uploads must be clean)`);
  }
  if (capture.missingMeshes.length > 0) {
    reasons.push(`effects FAIL: missingMeshes=[${capture.missingMeshes.join(', ')}] (required effect meshes/skins absent)`);
  }
  if (reasons.length > 0) return { verdict: 'FAIL', reasons };
  return {
    verdict: 'PASS',
    reasons: [`effects PASS: ${kinds.length} required kind(s) submitted and visible, uploads clean`],
  };
}

/**
 * FOLLOW-3 close-out: runs the unchanged submission/capture gate AND the
 * arsenal gate AND the required-effects gate AND the event-drain gate, and
 * PASSes only when all hold. Healthy frames/uploads/screenshots alone can
 * no longer pass it.
 */
export function validateFollow3Coverage(
  capture: Follow3LiveCapture,
  oracle: Follow3EffectOracle,
  events: readonly Follow3CombatEvent[],
): GpuAcceptanceVerdict {
  const cov = validateSceneCoverage(capture.coverage);
  const ars = validateLiveArsenal(capture);
  const eff = validateRequiredEffects(oracle, capture);
  const drn = validateEffectEventDrain(events);
  const reasons = [...cov.reasons, ...ars.reasons, ...eff.reasons, ...drn.reasons];
  if (cov.verdict !== 'PASS' || ars.verdict !== 'PASS' || eff.verdict !== 'PASS' || drn.verdict !== 'PASS') {
    return { verdict: 'FAIL', reasons };
  }
  return { verdict: 'PASS', reasons };
}

// --- HUD policy (optional by card) -------------------------------------------

/** Standing HUD policy: the CPU overlay stays; GPU-resident HUD is optional. */
export const FOLLOW3_HUD_POLICY = 'cpu-overlay-optional' as const;

/**
 * Report-only HUD line. Pass the measured CPU-overlay cost per frame in ms
 * (null = unmeasured). Never a gate: GPU residency is required only when a
 * measured cost demands it, per the card.
 */
export function formatFollow3HudNote(measuredOverlayMs: number | null): string {
  if (measuredOverlayMs === null) {
    return `hud: ${FOLLOW3_HUD_POLICY} (CPU-overlay cost unmeasured — GPU-resident HUD not required)`;
  }
  return `hud: ${FOLLOW3_HUD_POLICY} (measured CPU-overlay cost ${measuredOverlayMs}ms/frame — GPU residency required only if this breaches budget)`;
}

// --- Hermetic single-room effect fixture (known geometry, no pak) -------------
//
// One opaque backdrop wall (x=64, facing -X toward the camera at the
// origin) plus exactly one live instance of every required effect kind:
// a world sprite, a world particle cluster, a renderer-owned tracer beam,
// one translucent-alias explosion entity and one dynamic light. The oracle
// camera matches the FOLLOW-2C `room-a-view` anchor (origin, +X, fovX 90).

/** Oracle render size (hermetic CPU renders only; never an acceptance size). */
export const EFFECT_ORACLE_WIDTH = 96;
/** Oracle render size (hermetic CPU renders only; never an acceptance size). */
export const EFFECT_ORACLE_HEIGHT = 72;

/** Fixture bundle: world + entity set + model-kind registry for the selector. */
export interface Follow3EffectFixture {
  world: MiniWorld;
  /** Camera the CPU oracle renders from (matches room-a-view anchor). */
  camera: { origin: readonly [number, number, number]; angles: readonly [number, number, number]; fovX: number };
  /** Translucent-alias explosion entity (alpha < 1 => blend pass). */
  explosion: { origin: [number, number, number]; angles: [number, number, number] };
  /** Opaque control alias entity (proves the entity path itself renders). */
  control: { origin: [number, number, number]; angles: [number, number, number] };
  /** Renderer-owned beam segment (spawnTracer origin/dir/length). */
  beam: { origin: [number, number, number]; dir: [number, number, number]; length: number };
  /** Model registry seam for refreshGpuScene (handle -> kind). */
  kinds: Map<number, GpuEntityModelKind>;
  /** Registered model handles (explosion, control, beam-tracer). */
  explosionModel: number;
  controlModel: number;
  beamModel: number;
}

function solidEffectTexture(index: number): MiniWorld['textures'][number] {
  return { texels: new Uint8Array(8 * 8).fill(index), width: 8, height: 8 };
}

function flatEffectLight(): MiniWorld['lightmaps'][number] {
  const samples = new Uint8Array(2 * 2 * 3);
  for (let i = 0; i < samples.length; i++) samples[i] = 200;
  return { samples, luxW: 2, luxH: 2, styles: [0, 255, 255, 255] };
}

function effectQuad(
  id: number,
  verts: [number, number, number, number, number, number, number, number, number, number, number, number],
  texId: number,
): MiniSurf {
  const v = new Float32Array(verts);
  const mins = new Float32Array([Infinity, Infinity, Infinity]);
  const maxs = new Float32Array([-Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 3; k++) {
      const c = v[i * 3 + k]!;
      if (c < mins[k]!) mins[k] = c;
      if (c > maxs[k]!) maxs[k] = c;
    }
  }
  const center = new Float32Array([
    (mins[0]! + maxs[0]!) / 2,
    (mins[1]! + maxs[1]!) / 2,
    (mins[2]! + maxs[2]!) / 2,
  ]);
  let r2 = 0;
  for (let i = 0; i < 4; i++) {
    const dx = v[i * 3]! - center[0]!;
    const dy = v[i * 3 + 1]! - center[1]!;
    const dz = v[i * 3 + 2]! - center[2]!;
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return {
    id,
    verts: v,
    uvs: new Float32Array([0, 0, 8, 0, 8, 8, 0, 8]),
    lux: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    n: 4,
    texId,
    lightId: id,
    center,
    radius: Math.sqrt(r2),
    mins,
    maxs,
    turbulent: false,
    sky: false,
    fn: new Float32Array([-1, 0, 0]),
  };
}

/**
 * Build the hermetic effect stage. Surface 0 is the opaque backdrop; every
 * effect instance sits between the camera (origin) and the wall (x=64) so
 * the CPU reference must draw it.
 */
export function buildEffectFixtureWorld(): Follow3EffectFixture {
  const textures = [solidEffectTexture(200), solidEffectTexture(90)];
  const surfaces: MiniSurf[] = [
    effectQuad(0, [64, -32, -32, 64, 32, -32, 64, 32, 32, 64, -32, 32], 0),
  ];
  const lightmaps = [flatEffectLight()];
  // World-carried effects: one muzzle-style sprite + a 6-point impact
  // cluster + one warm dynamic light washing the backdrop wall.
  const world: MiniWorld = {
    brand: 'miniworld',
    nodes: [],
    leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 0, faceList: [0] }],
    pvs: [new Uint8Array([0b1])],
    clusterCount: 1,
    surfaces,
    textures,
    lightmaps,
    dynamicLights: [
      { origin: new Float32Array([40, 0, -6]), intensity: 300, color: new Float32Array([1, 0.8, 0.6]) },
    ],
    alias: [],
    sprites: [{ origin: new Float32Array([48, -8, -14]), size: 16, skinId: 1 }],
    particles: [
      { origin: new Float32Array([48, 6, -12]), color: 225 },
      { origin: new Float32Array([50, 8, -14]), color: 225 },
      { origin: new Float32Array([46, 8, -16]), color: 224 },
      { origin: new Float32Array([50, 5, -17]), color: 225 },
      { origin: new Float32Array([46, 5, -13]), color: 224 },
      { origin: new Float32Array([48, 9, -15]), color: 225 },
    ],
  };
  // Handles are fixture-local (registered on the caller's renderer):
  // 0 = explosion (md2), 1 = control (md2), 2 = beam (tracer).
  const kinds = new Map<number, GpuEntityModelKind>([
    [0, 'md2'],
    [1, 'md2'],
    [2, 'tracer'],
  ]);
  return {
    world,
    camera: { origin: [0, 0, 0], angles: [0, 0, 0], fovX: 90 },
    explosion: { origin: [48, 0, -18], angles: [0, 0, 0] },
    control: { origin: [48, -16, -22], angles: [0, 180, 0] },
    beam: { origin: [48, -20, -10], dir: [0, 1, 0], length: 40 },
    kinds,
    explosionModel: 0,
    controlModel: 1,
    beamModel: 2,
  };
}

// --- CPU oracle derivation ----------------------------------------------------

function effectRefDef(fixture: Follow3EffectFixture): RefDef {
  return {
    origin: new Float32Array(fixture.camera.origin),
    angles: new Float32Array(fixture.camera.angles),
    fovX: fixture.camera.fovX,
    time: 0,
    lightStyles: new Float32Array(256).fill(1),
  };
}

function effectBootCpu(): { r: SoftwareRenderer; fb: ReturnType<typeof createFramebuffer> } {
  const fb = createFramebuffer(EFFECT_ORACLE_WIDTH, EFFECT_ORACLE_HEIGHT, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  const palette = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    palette[i * 3] = i;
    palette[i * 3 + 1] = (i * 2) & 255;
    palette[i * 3 + 2] = (i * 3) & 255;
  }
  r.setPalette(palette);
  return { r, fb };
}

function effectCountDiff(a: Uint32Array, b: Uint32Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

/**
 * Derive the effects oracle from the CPU reference. Pixel floors come from
 * `SoftwareRenderer` renders toggling ONE kind at a time against the bare
 * backdrop (effect on vs off deltas — never GPU agreement); submission
 * floors come from the pure `refreshGpuScene` selector classifying the full
 * fixture (every kind must land on the submitted path). Throws on programmer
 * error (a kind rendering 0px or classifying to nothing) — never silently
 * records an empty expectation.
 */
export function deriveFollow3EffectOracle(fixture: Follow3EffectFixture): Follow3EffectOracle {
  const worldModel: WorldModel = { name: 'effect-fixture', data: fixture.world };
  const refdef = effectRefDef(fixture);

  const renderCpu = (
    world: MiniWorld,
    entities: Entity[],
    tracer: Follow3EffectFixture['beam'] | null,
  ): Uint32Array => {
    const { r, fb } = effectBootCpu();
    const mh = r.registerModel({ name: 'effect-box', kind: 'md2', data: createBoxMesh(8) });
    const sh = r.registerSkinPixels('effect-skin', new Uint8Array(8 * 8).fill(21), 8, 8);
    const withHandles = entities.map((e) => ({ ...e, model: mh, skin: sh }));
    if (tracer !== null) {
      r.spawnTracer(
        new Float32Array(tracer.origin),
        new Float32Array(tracer.dir),
        225,
        tracer.length,
        3,
      );
    }
    r.beginFrame();
    r.renderView(refdef, { name: 'effect-fixture', data: world }, withHandles);
    r.endFrame();
    return fb.color.slice();
  };

  const bareWorld: MiniWorld = { ...fixture.world, dynamicLights: [], sprites: [], particles: [] };
  const bare = renderCpu(bareWorld, [], null);

  const withSprite = renderCpu({ ...bareWorld, sprites: fixture.world.sprites }, [], null);
  const spriteDelta = effectCountDiff(bare, withSprite);

  const withParticles = renderCpu({ ...bareWorld, particles: fixture.world.particles }, [], null);
  const particleDelta = effectCountDiff(bare, withParticles);

  const withBeam = renderCpu(bareWorld, [], fixture.beam);
  const beamDelta = effectCountDiff(bare, withBeam);

  const explosionEntity: Entity = {
    model: -1,
    origin: new Float32Array(fixture.explosion.origin),
    angles: new Float32Array(fixture.explosion.angles),
    frame: 0,
    skin: -1,
    alpha: 0.5,
  };
  const withExplosion = renderCpu(bareWorld, [explosionEntity], null);
  const explosionDelta = effectCountDiff(bare, withExplosion);

  const withLight = renderCpu(fixture.world, [], null);
  const lightDelta = effectCountDiff(bare, withLight);

  const deltas = {
    sprite: spriteDelta,
    particle: particleDelta,
    beam: beamDelta,
    explosion: explosionDelta,
  } as const;
  for (const [kind, delta] of Object.entries(deltas)) {
    if (delta < 1) {
      throw new Error(`[testkit] deriveFollow3EffectOracle: CPU renders 0px '${kind}' delta (fixture/camera broken?)`);
    }
  }
  if (lightDelta < 1) {
    throw new Error('[testkit] deriveFollow3EffectOracle: CPU renders 0px dynamic-light delta (fixture broken?)');
  }

  // Submission side: the pure selector must carry every kind onto the
  // submitted path (world sprites/particles/lights + classified entity refs).
  const beamEntity: Entity = {
    model: fixture.beamModel,
    origin: new Float32Array(fixture.beam.origin),
    angles: new Float32Array([0, 90, 0]),
    frame: fixture.beam.length,
    skin: 0,
  };
  const boomEntity: Entity = {
    model: fixture.explosionModel,
    origin: new Float32Array(fixture.explosion.origin),
    angles: new Float32Array(fixture.explosion.angles),
    frame: 0,
    skin: 0,
    alpha: 0.5,
  };
  const scene = refreshGpuScene(
    fixture.world,
    [beamEntity, boomEntity],
    refdef,
    EFFECT_ORACLE_WIDTH,
    EFFECT_ORACLE_HEIGHT,
    fixture.kinds,
  );
  let beamRefs = 0;
  let explosionRefs = 0;
  for (const s of scene.surfaces) {
    if (s.material === 'beam') beamRefs++;
    if (s.material === 'alias' && s.transparent) explosionRefs++;
  }
  const submittedCounts: Record<Follow3EffectKind, number> = {
    sprite: fixture.world.sprites.length,
    particle: fixture.world.particles.length,
    beam: beamRefs,
    explosion: explosionRefs,
    light: fixture.world.dynamicLights.length,
  };
  for (const [kind, n] of Object.entries(submittedCounts)) {
    if (n < 1) {
      throw new Error(`[testkit] deriveFollow3EffectOracle: selector submits 0 '${kind}' refs (classification broken?)`);
    }
  }
  void worldModel;

  const floorOf = (delta: number): number => Math.max(1, Math.floor(delta * 0.05));
  return {
    minSubmitted: { sprite: 1, particle: 1, beam: 1, explosion: 1, light: 1 },
    minPixels: {
      sprite: floorOf(spriteDelta),
      particle: floorOf(particleDelta),
      beam: floorOf(beamDelta),
      explosion: floorOf(explosionDelta),
    },
    lightDeltaPixels: lightDelta,
  };
}
