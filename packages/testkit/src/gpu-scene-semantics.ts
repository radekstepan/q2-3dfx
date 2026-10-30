// @q2/testkit — GPU-FOLLOW-2C lane: semantic scene content + occlusion coverage.
//
// Owns (testkit ONLY — never edit from another lane's packages):
//   - the live-route observation shape (`LiveRouteSemanticCapture` /
//     `LiveRouteWaypointSample`) the apps/web lane produces per waypoint
//     (coordinate by NAME only — apps/web fills it, testkit defines it);
//   - the hermetic two-room fixture (`buildSemanticFixtureWorld`) with named
//     wall/floor/ceiling regions, an opaque occluder, one enemy + viewmodel;
//   - the CPU oracle (`deriveSemanticOracle`): expected visible/hidden region
//     SETS come from the CPU traversal (`setupCamera` + `collectVisibleSurfaces`
//     from @q2/sw-renderer) and per-region/actor pixel floors come from actual
//     `SoftwareRenderer` renders — never from GPU/renderer self-agreement;
//   - the validators (`validateSceneSemanticContent`,
//     `validateSceneCoverageAndContent`).
//
// Ownership boundary (BRAIN.md §7: helper/type ownership explicit):
//   - `tools/bench` owns submission/timing measurement and keeps its own
//     `validateSceneCoverage` duplicate BY VALUE (see
//     `tools/bench/src/gpu-acceptance.ts`) — it must NOT duplicate these
//     semantic types; import them from `@q2/testkit` if needed.
//   - `validateSceneCoverage` (gpu-acceptance.ts) is UNCHANGED: the successor
//     `validateSceneCoverageAndContent` below wires semantic results in
//     without touching the frozen submission/capture gate.
//
// No DOM, no fs, no `any` in exported signatures. Pure validators, fixture
// builders and CPU-oracle derivation only (renders run through the public
// `SoftwareRenderer` API, hermetic at 96x72).

import { createFramebuffer, type Entity, type RefDef, type WorldModel } from '@q2/renderer-api';
import {
  collectVisibleSurfaces,
  createBoxMesh,
  findLeaf,
  setupCamera,
  SoftwareRenderer,
  type MiniSurf,
  type MiniWorld,
} from '@q2/sw-renderer';
import {
  validateSceneCoverage,
  type GpuAcceptanceVerdict,
  type GpuCoverageEvidence,
} from './gpu-acceptance.js';

// --- Oracle-side shapes (CPU reference / fixture geometry) ------------------

/** Named region class: every expectation names a wall, floor or ceiling. */
export type SemanticRegionKind = 'wall' | 'floor' | 'ceiling';

/** One named content region bound to CPU-oracle surface ids. */
export interface SemanticRegion {
  /** Stable name used by live-route observations (e.g. 'wall-a'). */
  name: string;
  kind: SemanticRegionKind;
  /** Room the region belongs to (multi-room coverage). */
  room: string;
  /** PVS cluster the region lives in. */
  cluster: number;
  /** Fixture surface ids rendering this region (into `MiniWorld.surfaces`). */
  surfaceIds: readonly number[];
}

/** One hermetic oracle camera (a live-route waypoint anchor). */
export interface SemanticCamera {
  /** Stable label; live-route waypoints match on it. */
  label: string;
  origin: readonly [number, number, number];
  angles: readonly [number, number, number];
  fovX: number;
  /** PVS cluster the camera stands in. */
  cluster: number;
}

/**
 * Opaque-occlusion rule: from `camera`, the opaque `occluder` region must
 * hide the `hidden` region (observed hidden pixels must stay at zero).
 */
export interface OcclusionExpectation {
  camera: string;
  occluder: string;
  hidden: string;
}

/** Actor kinds the route must keep visible (enemy + viewmodel). */
export type SemanticActor = 'enemy' | 'viewmodel';

/**
 * CPU-derived oracle: per-camera visible region sets (from CPU traversal),
 * verified occlusion rules, required actors, and CPU-render-derived pixel
 * floors. `minRegionPixels`/`minActorPixels` are small absolute counts from
 * tiny (96x72) CPU renders — any real capture at >= oracle resolution shows
 * far more, while a removed wall/enemy reads 0 and fails.
 */
export interface SceneSemanticOracle {
  cameras: readonly SemanticCamera[];
  regions: readonly SemanticRegion[];
  /** camera label -> region names the CPU traversal marks visible. */
  visible: Record<string, readonly string[]>;
  occlusions: readonly OcclusionExpectation[];
  requiredActors: readonly SemanticActor[];
  minRegionPixels: number;
  minActorPixels: number;
  /** Occluded regions must read at most this many pixels (always 0). */
  maxHiddenPixels: number;
}

// --- Live-route observation shape (apps/web lane produces this) -------------
//
// The apps/web FOLLOW-2C lane drives the production page through the live
// route (multi-room translation/PVS transitions, 180-degree turn, doors,
// lift) and records ONE sample per waypoint camera: per-region visible pixel
// counts from the composed page plus enemy/viewmodel pixel attribution,
// upload errors and missing-mesh warnings. Testkit DEFINES this shape;
// apps/web FILLS it (coordinate by name only — never import apps/web here).

/** One live-route waypoint observation (composed-page evidence). */
export interface LiveRouteWaypointSample {
  /** Must match a `SemanticCamera.label` in the oracle. */
  label: string;
  /** Room the waypoint stands in (multi-room proof). */
  room: string;
  /** PVS cluster observed at this waypoint. */
  cluster: number;
  /** Mover state at this waypoint (e.g. 'door-closed', 'door-open', 'lift-up'). */
  mover: string;
  /** Region name -> observed visible pixels in the composed capture. */
  regionPixels: Record<string, number>;
  /** Observed enemy pixels (per-entity page attribution). */
  enemyPixels: number;
  /** Observed viewmodel pixels (per-entity page attribution). */
  viewmodelPixels: number;
  /** GL/upload errors observed on the leg (must be 0). */
  uploadErrors: number;
  /** Missing-mesh/skin warnings (must be empty). */
  missingMeshes: readonly string[];
}

/**
 * Whole-route capture: submission/capture evidence (feeds the unchanged
 * `validateSceneCoverage`) plus per-waypoint semantic observations (feeds
 * `validateSceneSemanticContent`).
 */
export interface LiveRouteSemanticCapture {
  coverage: GpuCoverageEvidence;
  waypoints: readonly LiveRouteWaypointSample[];
}

// --- Validators --------------------------------------------------------------

/**
 * Semantic content + occlusion gate: PASS only when every oracle camera has
 * a matching waypoint, every CPU-visible region meets its pixel floor, every
 * occluded region stays hidden, both actors are present, and no upload
 * errors/missing meshes were recorded. A scene with a removed wall/enemy
 * FAILS here even when frames/uploads/screenshots look healthy.
 */
export function validateSceneSemanticContent(
  oracle: SceneSemanticOracle,
  capture: LiveRouteSemanticCapture,
): GpuAcceptanceVerdict {
  const reasons: string[] = [];
  for (const cam of oracle.cameras) {
    const wp = capture.waypoints.find((w) => w.label === cam.label);
    if (!wp) {
      reasons.push(
        `semantic FAIL: no live-route waypoint for oracle camera '${cam.label}' (route must visit every oracle camera)`,
      );
      continue;
    }
    const expected = oracle.visible[cam.label] ?? [];
    for (const name of expected) {
      const px = wp.regionPixels[name] ?? 0;
      if (!(px >= oracle.minRegionPixels)) {
        reasons.push(
          `semantic FAIL: [${cam.label}] region '${name}' reads ${px}px < min ${oracle.minRegionPixels}px (wall/floor/ceiling removed or never uploaded?)`,
        );
      }
    }
    for (const occ of oracle.occlusions) {
      if (occ.camera !== cam.label) continue;
      const px = wp.regionPixels[occ.hidden] ?? 0;
      if (!(px <= oracle.maxHiddenPixels)) {
        reasons.push(
          `semantic FAIL: [${cam.label}] occluder '${occ.occluder}' must hide '${occ.hidden}' but it reads ${px}px (occluder removed or translucency leak?)`,
        );
      }
    }
    if (oracle.requiredActors.includes('enemy') && !(wp.enemyPixels >= oracle.minActorPixels)) {
      reasons.push(
        `semantic FAIL: [${cam.label}] enemy reads ${wp.enemyPixels}px < min ${oracle.minActorPixels}px (enemy removed or never submitted?)`,
      );
    }
    if (oracle.requiredActors.includes('viewmodel') && !(wp.viewmodelPixels >= oracle.minActorPixels)) {
      reasons.push(
        `semantic FAIL: [${cam.label}] viewmodel reads ${wp.viewmodelPixels}px < min ${oracle.minActorPixels}px (gun removed or never submitted?)`,
      );
    }
    if (!(wp.uploadErrors === 0)) {
      reasons.push(`semantic FAIL: [${cam.label}] uploadErrors=${wp.uploadErrors} (uploads must be clean)`);
    }
    if (wp.missingMeshes.length > 0) {
      reasons.push(`semantic FAIL: [${cam.label}] missingMeshes=[${wp.missingMeshes.join(', ')}] (required meshes/skins absent)`);
    }
  }
  if (reasons.length > 0) return { verdict: 'FAIL', reasons };
  return {
    verdict: 'PASS',
    reasons: [
      `semantic PASS: ${oracle.cameras.length} waypoint(s) match CPU-visible sets, occlusions hold, actors present, uploads clean`,
    ],
  };
}

/**
 * Successor to `validateSceneCoverage`: runs the unchanged
 * submission/capture gate AND the semantic content/occlusion gate, and PASSes
 * only when both hold. This is the FOLLOW-2C close-out predicate — healthy
 * frame/upload/screenshot counts alone can no longer pass it.
 */
export function validateSceneCoverageAndContent(
  capture: LiveRouteSemanticCapture,
  oracle: SceneSemanticOracle,
): GpuAcceptanceVerdict {
  const cov = validateSceneCoverage(capture.coverage);
  const sem = validateSceneSemanticContent(oracle, capture);
  const reasons = [...cov.reasons, ...sem.reasons];
  if (cov.verdict !== 'PASS' || sem.verdict !== 'PASS') return { verdict: 'FAIL', reasons };
  return { verdict: 'PASS', reasons };
}

// --- Hermetic two-room fixture (known geometry, no pak) ----------------------
//
// Room A (cluster 0): wall-a + floor-a + ceiling-a + divider (the opaque
// occluder). Room B (cluster 1, behind the divider): wall-b + floor-b +
// ceiling-b. PVS row for cluster 0 sees cluster 0 only (divider opaque);
// cluster 1 sees both (open doorway back). Camera 'room-a-view' must see
// room-A regions + divider and NONE of room B; camera 'room-b-view' (through
// the doorway) must see room-B regions. One box enemy + one depth-hacked
// viewmodel gun ride along as entities.

/** Oracle render size (hermetic CPU renders only; never an acceptance size). */
export const SEMANTIC_ORACLE_WIDTH = 96;
/** Oracle render size (hermetic CPU renders only; never an acceptance size). */
export const SEMANTIC_ORACLE_HEIGHT = 72;

function solidTexture(index: number): MiniWorld['textures'][number] {
  return { texels: new Uint8Array(8 * 8).fill(index), width: 8, height: 8 };
}

function flatLight(): MiniWorld['lightmaps'][number] {
  const samples = new Uint8Array(2 * 2 * 3);
  for (let i = 0; i < samples.length; i++) samples[i] = 200;
  return { samples, luxW: 2, luxH: 2, styles: [0, 255, 255, 255] };
}

function quad(
  id: number,
  verts: [number, number, number, number, number, number, number, number, number, number, number, number],
  texId: number,
  fn: [number, number, number],
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
    fn: new Float32Array(fn),
  };
}

/** Fixture bundle: world + region bindings + oracle cameras + entity set. */
export interface SemanticFixture {
  world: MiniWorld;
  regions: SemanticRegion[];
  cameras: SemanticCamera[];
  /** Enemy entity (box alias, registered on the caller's renderer). */
  enemy: { origin: [number, number, number]; angles: [number, number, number]; frame: number };
  /** Viewmodel entity (eye-anchored depthHack gun). */
  viewmodel: { origin: [number, number, number]; angles: [number, number, number]; frame: number };
}

/**
 * Build the hermetic two-room world. Surface ids are index-stable
 * (surface i == `surfaces[i]`); every region owns exactly one surface.
 */
export function buildSemanticFixtureWorld(): SemanticFixture {
  // Distinct palette indices per region (ramp palette => distinct colors).
  const TEX = { wallA: 200, floorA: 100, ceilA: 150, divider: 90, wallB: 210, floorB: 110, ceilB: 160 };
  const textures = [
    solidTexture(TEX.wallA), solidTexture(TEX.floorA), solidTexture(TEX.ceilA), solidTexture(TEX.divider),
    solidTexture(TEX.wallB), solidTexture(TEX.floorB), solidTexture(TEX.ceilB),
  ];
  const surfaces: MiniSurf[] = [
    // 0 wall-a: x=64 plane facing -X (toward room-A camera).
    quad(0, [64, -32, -32, 64, 32, -32, 64, 32, 32, 64, -32, 32], 0, [-1, 0, 0]),
    // 1 floor-a: z=-32, x in [0,64], facing up.
    quad(1, [0, -32, -32, 64, -32, -32, 64, 32, -32, 0, 32, -32], 1, [0, 0, 1]),
    // 2 ceiling-a: z=+32, facing down.
    quad(2, [0, -32, 32, 0, 32, 32, 64, 32, 32, 64, -32, 32], 2, [0, 0, -1]),
    // 3 divider: x=66 occluder wall facing -X (opaque, hides room B from A).
    quad(3, [66, -40, -40, 66, 40, -40, 66, 40, 40, 66, -40, 40], 3, [-1, 0, 0]),
    // 4 wall-b: x=128 plane facing -X (toward room-B camera).
    quad(4, [128, -32, -32, 128, 32, -32, 128, 32, 32, 128, -32, 32], 4, [-1, 0, 0]),
    // 5 floor-b: z=-32, x in [66,128], facing up.
    quad(5, [66, -32, -32, 128, -32, -32, 128, 32, -32, 66, 32, -32], 5, [0, 0, 1]),
    // 6 ceiling-b: z=+32, facing down.
    quad(6, [66, -32, 32, 66, 32, 32, 128, 32, 32, 128, -32, 32], 6, [0, 0, -1]),
  ];
  const lightmaps = surfaces.map(() => flatLight());
  const world: MiniWorld = {
    brand: 'miniworld',
    // One-node BSP: plane x=67 splits room A (back, leaf 0) from room B
    // (front, leaf 1); the divider is the node's face. `findLeaf` (the same
    // call the renderer uses) therefore resolves each camera to its own
    // cluster and PVS-gates the other room — genuine opaque occlusion.
    nodes: [
      {
        nx: 1, ny: 0, nz: 0, dist: 67, front: -2, back: -1,
        mins: new Float32Array([0, -40, -40]),
        maxs: new Float32Array([128, 40, 40]),
        firstSurf: 3, numSurfs: 1,
      },
    ],
    leafs: [
      { cluster: 0, firstSurf: 0, numSurfs: 0, faceList: [0, 1, 2] },
      { cluster: 1, firstSurf: 0, numSurfs: 0, faceList: [4, 5, 6] },
    ],
    // Cluster 0 (room A) sees only itself: the divider is opaque.
    // Cluster 1 (room B) sees both (open doorway back into A).
    pvs: [new Uint8Array([0b01]), new Uint8Array([0b11])],
    clusterCount: 2,
    surfaces,
    textures,
    lightmaps,
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
  const regions: SemanticRegion[] = [
    { name: 'wall-a', kind: 'wall', room: 'room-a', cluster: 0, surfaceIds: [0] },
    { name: 'floor-a', kind: 'floor', room: 'room-a', cluster: 0, surfaceIds: [1] },
    { name: 'ceiling-a', kind: 'ceiling', room: 'room-a', cluster: 0, surfaceIds: [2] },
    { name: 'divider', kind: 'wall', room: 'room-a', cluster: 0, surfaceIds: [3] },
    { name: 'wall-b', kind: 'wall', room: 'room-b', cluster: 1, surfaceIds: [4] },
    { name: 'floor-b', kind: 'floor', room: 'room-b', cluster: 1, surfaceIds: [5] },
    { name: 'ceiling-b', kind: 'ceiling', room: 'room-b', cluster: 1, surfaceIds: [6] },
  ];
  const cameras: SemanticCamera[] = [
    { label: 'room-a-view', origin: [0, 0, 0], angles: [0, 0, 0], fovX: 90, cluster: 0 },
    { label: 'room-b-view', origin: [80, 0, 0], angles: [0, 0, 0], fovX: 90, cluster: 1 },
  ];
  return {
    world,
    regions,
    cameras,
    enemy: { origin: [48, -10, -20], angles: [0, 180, 0], frame: 0 },
    // Eye-anchored depthHack gun: forward/right/down of the eye so the box
    // sits inside the frustum past the near plane (a box centered exactly
    // at the eye near-clips to nothing — verified during development).
    viewmodel: { origin: [12, 5, -5], angles: [0, 0, 0], frame: 0 },
  };
}

// --- CPU oracle derivation ----------------------------------------------------

function rampPalette(): Uint8Array {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    p[i * 3] = i;
    p[i * 3 + 1] = (i * 2) & 255;
    p[i * 3 + 2] = (i * 3) & 255;
  }
  return p;
}

function refDefFor(cam: SemanticCamera): RefDef {
  return {
    origin: new Float32Array(cam.origin),
    angles: new Float32Array(cam.angles),
    fovX: cam.fovX,
    time: 0,
    lightStyles: new Float32Array(256).fill(1),
  };
}

function bootCpu(width: number, height: number): { r: SoftwareRenderer; fb: ReturnType<typeof createFramebuffer> } {
  const fb = createFramebuffer(width, height, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(rampPalette());
  return { r, fb };
}

function countNonClear(color: Uint32Array, clear: number): number {
  let n = 0;
  for (let i = 0; i < color.length; i++) if (color[i] !== clear) n++;
  return n;
}

/**
 * Derive the semantic oracle from the CPU reference. Visibility SETS come
 * from the CPU traversal (`setupCamera` + `collectVisibleSurfaces` over the
 * fixture PVS — the genuine occlusion mechanism); pixel floors come from
 * tiny `SoftwareRenderer` renders (per-region solo renders + with/without
 * entity deltas). Throws on programmer error (fixture/camera mismatch) —
 * never silently records an empty expectation.
 */
export function deriveSemanticOracle(fixture: SemanticFixture): SceneSemanticOracle {
  const { world, regions, cameras } = fixture;
  const surfToRegion = new Map<number, string>();
  for (const r of regions) for (const s of r.surfaceIds) surfToRegion.set(s, r.name);

  // 1. CPU-traversal visibility sets (PVS + frustum, never GPU agreement).
  // The view cluster comes from `findLeaf` — the exact call the renderer
  // uses — and must agree with the camera's declared cluster.
  const visible: Record<string, readonly string[]> = {};
  for (const cam of cameras) {
    const origin = new Float32Array(cam.origin);
    const viewCluster = findLeaf(world.nodes, origin);
    if (viewCluster !== cam.cluster) {
      throw new Error(
        `[testkit] deriveSemanticOracle: findLeaf gives cluster ${viewCluster} for '${cam.label}', declared ${cam.cluster} (fixture broken?)`,
      );
    }
    const camera = setupCamera(
      origin, new Float32Array(cam.angles), cam.fovX,
      SEMANTIC_ORACLE_WIDTH, SEMANTIC_ORACLE_HEIGHT,
    );
    const outSurfs: number[] = [];
    const outOrder: number[] = [];
    collectVisibleSurfaces(world, camera, viewCluster, outSurfs, outOrder);
    const names = new Set<string>();
    for (const s of outSurfs) {
      const name = surfToRegion.get(s);
      if (name !== undefined) names.add(name);
    }
    const list = [...names].sort();
    if (list.length === 0) {
      throw new Error(`[testkit] deriveSemanticOracle: CPU traversal sees nothing from '${cam.label}' (fixture broken?)`);
    }
    visible[cam.label] = list;
  }

  // 2. Occlusion rules, VERIFIED against the CPU sets (not assumed).
  const candidates: OcclusionExpectation[] = [];
  for (const region of regions) {
    if (region.room === 'room-a') continue;
    candidates.push({ camera: 'room-a-view', occluder: 'divider', hidden: region.name });
  }
  const occlusions: OcclusionExpectation[] = [];
  for (const occ of candidates) {
    const seen = visible[occ.camera] ?? [];
    if (!seen.includes(occ.occluder)) {
      throw new Error(`[testkit] deriveSemanticOracle: occluder '${occ.occluder}' not CPU-visible from '${occ.camera}'`);
    }
    if (seen.includes(occ.hidden)) {
      throw new Error(`[testkit] deriveSemanticOracle: '${occ.hidden}' CPU-visible from '${occ.camera}' — no occlusion to pin`);
    }
    occlusions.push(occ);
  }

  // 3. CPU-render pixel floors (hermetic 96x72 SoftwareRenderer renders).
  const worldModel: WorldModel = { name: 'semantic-fixture', data: world };

  // Per-region solo renders: world copy exposing only that region's leafs.
  let minRegionPixels = 1;
  for (const region of regions) {
    const solo: MiniWorld = {
      ...world,
      leafs: world.leafs.map((leaf) => ({
        ...leaf,
        faceList: (leaf.faceList ?? []).filter((s) => region.surfaceIds.includes(s)),
      })),
    };
    const soloCam = cameras.find((c) => c.cluster === region.cluster) ?? cameras[0]!;
    const rr = bootCpu(SEMANTIC_ORACLE_WIDTH, SEMANTIC_ORACLE_HEIGHT);
    rr.r.beginFrame();
    rr.r.renderView(refDefFor(soloCam), { name: 'semantic-solo', data: solo }, []);
    rr.r.endFrame();
    const n = countNonClear(rr.fb.color, rr.fb.color[0]!);
    if (n < 1) {
      throw new Error(`[testkit] deriveSemanticOracle: CPU renders 0px for region '${region.name}' (fixture/camera broken?)`);
    }
    const floor = Math.max(1, Math.floor(n * 0.05));
    if (floor > minRegionPixels) minRegionPixels = floor;
  }

  // Actor delta renders: room-A world with vs without enemy/viewmodel.
  const enemyMesh = createBoxMesh(16);
  const er = bootCpu(SEMANTIC_ORACLE_WIDTH, SEMANTIC_ORACLE_HEIGHT);
  const mh = er.r.registerModel({ name: 'semantic-enemy', kind: 'md2', data: enemyMesh });
  const sh = er.r.registerSkinPixels('semantic-enemy-skin', new Uint8Array(8 * 8).fill(21), 8, 8);
  const gunMesh = createBoxMesh(8);
  const gh = er.r.registerModel({ name: 'semantic-gun', kind: 'md2', data: gunMesh });
  const gs = er.r.registerSkinPixels('semantic-gun-skin', new Uint8Array(8 * 8).fill(31), 8, 8);
  const enemyEntity: Entity = {
    model: mh,
    origin: new Float32Array(fixture.enemy.origin),
    angles: new Float32Array(fixture.enemy.angles),
    frame: fixture.enemy.frame,
    skin: sh,
  };
  const gunEntity: Entity = {
    model: gh,
    origin: new Float32Array(fixture.viewmodel.origin),
    angles: new Float32Array(fixture.viewmodel.angles),
    frame: fixture.viewmodel.frame,
    skin: gs,
    depthHack: true,
  };
  const roomAView = refDefFor(cameras[0]!);
  er.r.beginFrame();
  er.r.renderView(roomAView, worldModel, []);
  er.r.endFrame();
  const bare = er.fb.color.slice();
  er.r.beginFrame();
  er.r.renderView(roomAView, worldModel, [enemyEntity]);
  er.r.endFrame();
  let enemyDelta = 0;
  for (let i = 0; i < bare.length; i++) if (bare[i] !== er.fb.color[i]) enemyDelta++;
  er.r.beginFrame();
  er.r.renderView(roomAView, worldModel, [enemyEntity, gunEntity]);
  er.r.endFrame();
  let gunDelta = 0;
  for (let i = 0; i < bare.length; i++) if (bare[i] !== er.fb.color[i]) gunDelta++;
  gunDelta = Math.max(0, gunDelta - enemyDelta);
  if (enemyDelta < 1) {
    throw new Error('[testkit] deriveSemanticOracle: CPU renders 0px enemy delta (fixture broken?)');
  }
  if (gunDelta < 1) {
    throw new Error('[testkit] deriveSemanticOracle: CPU renders 0px viewmodel delta (fixture broken?)');
  }
  const minActorPixels = Math.max(1, Math.floor(Math.min(enemyDelta, gunDelta) * 0.05));

  return {
    cameras,
    regions,
    visible,
    occlusions,
    requiredActors: ['enemy', 'viewmodel'],
    minRegionPixels,
    minActorPixels,
    maxHiddenPixels: 0,
  };
}
