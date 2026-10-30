// @q2/webgl-renderer FOLLOW-2 tests — moving-camera world visibility + draw order.
//
// Fail-before contract (GPU-FOLLOW-2): the persistent full-map geometry store
// must be separate from the current-camera draw selection. Turning the camera
// 180 degrees, translating across PVS clusters, or moving past transparent
// surfaces must change the submitted selection AND the executed draw calls
// without rebuilding the whole mesh (uploads stay 1 per static generation).
//
// The per-view selector (selectGpuScene) was already correct in isolation —
// the defect is the frozen spawn subset (play.ts cached it, renderer.ts baked
// batches from it). So the fail-before assertions live at the renderer
// (draws follow the new selection) and play (frameGpuPlay re-selects) levels,
// plus semantic hole/occlusion checks on the real base1 map.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { loadBsp } from '@q2/bsp';
import {
  bspToMiniWorld,
  createBoxMesh,
  culledByFrustum,
  setupCamera,
  type MiniSurf,
  type MiniWorld,
} from '@q2/sw-renderer';
import type { Entity, GpuSurfaceRef, RefDef } from '@q2/renderer-api';
import {
  cameraCluster,
  fullWorldRefs,
  refreshGpuScene,
  selectGpuScene,
  type GpuEntityModelKind,
} from './scene.js';
import { WebGLRenderer } from './renderer.js';
import { stubGLFull } from './proof3.test.js';

const W = 640;
const H = 480;

function refDef(origin: [number, number, number], yaw: number): RefDef {
  return {
    origin: new Float32Array(origin),
    angles: new Float32Array([0, yaw, 0]),
    fovX: 90,
    time: 0,
    lightStyles: new Float32Array(256).fill(1),
  };
}

function emptyWorld(): MiniWorld {
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [],
    pvs: [],
    clusterCount: 0,
    surfaces: [],
    textures: [],
    lightmaps: [],
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
}

function wallSurf(
  id: number,
  center: [number, number, number],
  fn: [number, number, number],
  extra: Partial<MiniSurf> = {},
): MiniSurf {
  const [cx, cy, cz] = center;
  return {
    id,
    verts: new Float32Array([cx - 10, cy - 1, cz - 10, cx + 10, cy - 1, cz - 10, cx + 10, cy + 1, cz + 10]),
    uvs: new Float32Array(6),
    lux: new Float32Array(6),
    n: 3,
    texId: 0,
    lightId: id,
    center: new Float32Array(center),
    radius: 20,
    mins: new Float32Array([cx - 10, cy - 10, cz - 10]),
    maxs: new Float32Array([cx + 10, cy + 10, cz + 10]),
    turbulent: false,
    translucent: 0,
    sky: false,
    fn: new Float32Array(fn),
    ...extra,
  };
}

function worldIds(refs: GpuSurfaceRef[]): number[] {
  return refs.filter((r) => r.transformIndex === 0).map((r) => r.surfaceId).sort((a, b) => a - b);
}

/** Two rooms behind opposite frustum halves: north wall faces -Y, south wall faces +Y. */
function turnWorld(): MiniWorld {
  const w = emptyWorld();
  w.leafs = [{ cluster: 0, firstSurf: 0, numSurfs: 0, faceList: [0, 1] }];
  w.pvs = [new Uint8Array([1])];
  w.clusterCount = 1;
  w.surfaces = [
    wallSurf(0, [0, 100, 0], [0, -1, 0]), // north wall: front faces the spawn camera
    wallSurf(1, [0, -100, 0], [0, 1, 0]), // south wall: behind the spawn camera
  ];
  w.textures = [{ texels: new Uint8Array(64).fill(3), width: 8, height: 8 }];
  return w;
}

/** Two PVS clusters: leaf 0 (x<0) sees only cluster 0, leaf 1 (x>=0) only cluster 1. */
function clusterWorld(): MiniWorld {
  const w = emptyWorld();
  // Root plane x=0: front (x>=0) -> leaf 1, back (x<0) -> leaf 0.
  w.nodes = [{
    nx: 1, ny: 0, nz: 0, dist: 0, front: -2, back: -1,
    mins: new Float32Array([-200, -200, -50]), maxs: new Float32Array([200, 200, 50]),
    firstSurf: 0, numSurfs: 0,
  }];
  w.leafs = [
    { cluster: 0, firstSurf: 0, numSurfs: 0, faceList: [0] },
    { cluster: 1, firstSurf: 0, numSurfs: 0, faceList: [1] },
  ];
  w.pvs = [new Uint8Array([0b01]), new Uint8Array([0b10])];
  w.clusterCount = 2;
  // Small walls in front of each room camera (yaw 90 looks +Y).
  w.surfaces = [
    wallSurf(0, [-100, 20, 0], [0, -1, 0]),
    wallSurf(1, [100, 20, 0], [0, -1, 0]),
  ];
  w.textures = [{ texels: new Uint8Array(64).fill(3), width: 8, height: 8 }];
  return w;
}

/** Two overlapping translucent-water surfaces on the +Y axis for order-flip checks. */
function glassWorld(): MiniWorld {
  const w = emptyWorld();
  w.leafs = [{ cluster: 0, firstSurf: 0, numSurfs: 0, faceList: [0, 1] }];
  w.pvs = [new Uint8Array([1])];
  w.clusterCount = 1;
  w.surfaces = [
    // Turbulent + translucent (base1 water rule, GPU-FOLLOW-3): double-sided
    // like the CPU (`!turbulent && !sky` culls), so both walls stay visible
    // from either side and the blend order genuinely flips with the camera.
    wallSurf(0, [0, 60, 0], [0, -1, 0], { translucent: 1, turbulent: true }),
    wallSurf(1, [0, 140, 0], [0, -1, 0], { translucent: 2, turbulent: true }),
  ];
  w.textures = [{ texels: new Uint8Array(64).fill(3), width: 8, height: 8 }];
  return w;
}

describe('FOLLOW-2 per-view world selection (synthetic, always run)', () => {
  it('180-degree turn: hidden wall becomes drawable, facing wall drops (no permanent omission)', () => {
    const w = turnWorld();
    const spawn = selectGpuScene(w, [], refDef([0, 0, 0], 90), W, H);
    const turned = selectGpuScene(w, [], refDef([0, 0, 0], 270), W, H);
    expect(worldIds(spawn.surfaces)).toEqual([0]);
    expect(worldIds(turned.surfaces)).toEqual([1]);
    // Neither view permanently omits geometry: the union is the full inventory.
    const union = [...new Set([...worldIds(spawn.surfaces), ...worldIds(turned.surfaces)])].sort((a, b) => a - b);
    expect(union).toEqual(worldIds(fullWorldRefs(w)));
  });

  it('refreshGpuScene re-selects per frame with the same rules (not a frozen tail)', () => {
    const w = turnWorld();
    const a = refreshGpuScene(w, [], refDef([0, 0, 0], 90), W, H);
    const b = refreshGpuScene(w, [], refDef([0, 0, 0], 270), W, H);
    expect(worldIds(a.surfaces)).toEqual([0]);
    expect(worldIds(b.surfaces)).toEqual([1]);
    // Combined transparent/entity ordering still far->near.
    const blend = b.surfaces.filter((r) => r.transparent);
    for (let i = 1; i < blend.length; i++) {
      expect(blend[i - 1]!.order).toBeGreaterThanOrEqual(blend[i]!.order);
    }
  });

  it('translation across PVS clusters swaps the visible set', () => {
    const w = clusterWorld();
    expect(cameraCluster(w, new Float32Array([-100, 0, 0]))).toBe(0);
    expect(cameraCluster(w, new Float32Array([100, 0, 0]))).toBe(1);
    // Cameras look +Y (yaw 90): each room's wall faces its own camera.
    const west = selectGpuScene(w, [], refDef([-100, -40, 0], 90), W, H);
    const east = selectGpuScene(w, [], refDef([100, -40, 0], 90), W, H);
    expect(worldIds(west.surfaces)).toContain(0);
    expect(worldIds(east.surfaces)).toContain(1);
    expect(worldIds(west.surfaces)).not.toContain(1);
    expect(worldIds(east.surfaces)).not.toContain(0);
    expect(west.surfaces.length).toBeGreaterThan(0);
    expect(east.surfaces.length).toBeGreaterThan(0);
  });

  it('transparent overlap: nearer/farther order flips when the camera moves past', () => {
    const w = glassWorld();
    const near = selectGpuScene(w, [], refDef([0, 0, 0], 90), W, H);
    const far = selectGpuScene(w, [], refDef([0, 200, 0], 270), W, H);
    const orderOf = (refs: GpuSurfaceRef[], id: number): number =>
      refs.find((r) => r.surfaceId === id)!.order;
    // From the south, surface 1 (y=140) is farther than surface 0 (y=60).
    expect(orderOf(near.surfaces, 1)).toBeGreaterThan(orderOf(near.surfaces, 0));
    // From the north the ranking flips.
    expect(orderOf(far.surfaces, 0)).toBeGreaterThan(orderOf(far.surfaces, 1));
    for (const sel of [near, far]) {
      const blend = sel.surfaces.filter((r) => r.transparent);
      expect(blend.length).toBe(2);
      expect(blend[0]!.order).toBeGreaterThanOrEqual(blend[1]!.order);
    }
  });

  it('stripped leaf faces (blown func_explosive contract) drop from selection, never from inventory', () => {
    const w = turnWorld();
    // Mimic hideFreedBrushes: the blown brush leaves every leaf facelist.
    for (const leaf of w.leafs) {
      if (leaf.faceList) leaf.faceList = leaf.faceList.filter((f) => f !== 0);
    }
    const sel = selectGpuScene(w, [], refDef([0, 0, 0], 90), W, H);
    expect(worldIds(sel.surfaces)).toEqual([]);
    // The persistent inventory still holds it (upload set is stable; the
    // draw pass just never selects it again).
    expect(fullWorldRefs(w).map((r) => r.surfaceId)).toContain(0);
  });
});

function rampPalette(): Uint8Array {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    p[i * 3] = i;
    p[i * 3 + 1] = (i * 2) & 255;
    p[i * 3 + 2] = (i * 3) & 255;
  }
  return p;
}

function renderWithScene(
  r: WebGLRenderer, state: ReturnType<typeof stubGLFull>, scene: ReturnType<typeof selectGpuScene>,
): string[] {
  const before = state.calls.length;
  r.setEntities([], undefined);
  r.renderFrame({ view: refDef([0, 0, 0], 90), scene, time: 0 });
  return state.calls.slice(before);
}

describe('FOLLOW-2 draws follow the updated selection without re-upload (stub GL)', () => {
  it('re-selecting after a 180-degree turn changes draw calls, uploads stay 1', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, W, H);
    const w = turnWorld();
    r.attachWorld(w);
    r.setPalette(rampPalette());
    const spawn = selectGpuScene(w, [], refDef([0, 0, 0], 90), W, H);
    r.setScene(spawn);
    const first = renderWithScene(r, state, spawn);
    const drawsFirst = first.filter((c) => c.startsWith('drawElements'));
    expect(drawsFirst.length).toBeGreaterThan(0);
    expect(r.testUploadStats()).toEqual({ uploads: 1 });

    // Same static generation, new camera selection: no re-upload ...
    const turned = selectGpuScene(w, [], refDef([0, 0, 0], 270), W, H);
    expect(turned.staticGeneration).toBe(spawn.staticGeneration);
    r.setScene(turned);
    expect(r.testUploadStats()).toEqual({ uploads: 1 });
    const second = renderWithScene(r, state, turned);
    const drawsSecond = second.filter((c) => c.startsWith('drawElements'));
    expect(drawsSecond.length).toBeGreaterThan(0);
    // ... but the executed draws follow the NEW selection (fail-before: the
    // frozen spawn-subset renderer repeats the identical draw sequence).
    expect(drawsSecond).not.toEqual(drawsFirst);
  });

  it('transparent world re-sort changes blend draw order without re-upload', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, W, H);
    const w = glassWorld();
    r.attachWorld(w);
    r.setPalette(rampPalette());
    const near = selectGpuScene(w, [], refDef([0, 0, 0], 90), W, H);
    r.setScene(near);
    renderWithScene(r, state, near);
    const far = selectGpuScene(w, [], refDef([0, 200, 0], 270), W, H);
    r.setScene(far);
    expect(r.testUploadStats()).toEqual({ uploads: 1 });
    const before = state.calls.length;
    renderWithScene(r, state, far);
    const draws = state.calls.slice(before).filter((c) => c.startsWith('drawElements'));
    // Both transparent surfaces still draw (nothing permanently omitted) ...
    expect(draws.length).toBe(2);
    // ... in far->near order for the NEW view: surface 0 (y=60) is now
    // farther than surface 1 (y=140), so its draw comes first.
    expect(draws[0]).not.toBe(draws[1]);
  });

  it('interleaved blend re-binds the lit program for every world range', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, W, H);
    const w = glassWorld();
    r.attachWorld(w);
    r.setPalette(rampPalette());
    r.registerModelData(0, 'md2', createBoxMesh());
    r.registerSkinPixels(0, new Uint8Array(8 * 8).fill(11), 8, 8);
    // Transparent alias midway between the two glass walls: the submitted
    // blend order interleaves world, alias, world by distance.
    const entities: Entity[] = [
      { model: 0, origin: new Float32Array([0, 100, 0]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0, alpha: 0.5 },
    ];
    const kinds = new Map<number, GpuEntityModelKind>([[0, 'md2']]);
    const scene = refreshGpuScene(w, entities, refDef([0, 0, 0], 90), W, H, kinds);
    const blend = scene.surfaces.filter((s) => s.transparent);
    expect(blend.length).toBe(3);
    expect(blend[0]!.surfaceId).toBe(1); // glass y=140, farthest
    expect(blend[1]!.surfaceId).toBe(-1); // alias y=100
    expect(blend[2]!.surfaceId).toBe(0); // glass y=60, nearest
    r.setScene(scene);
    r.setEntities(entities, kinds);
    const before = state.calls.length;
    r.renderFrame({ view: refDef([0, 0, 0], 90), scene, time: 0 });
    const log = state.calls.slice(before);
    const blendOn = log.findIndex((c) => c === 'enable BLEND');
    const blendOff = log.findIndex((c) => c === 'disable BLEND');
    expect(blendOn).toBeGreaterThan(-1);
    expect(blendOff).toBeGreaterThan(blendOn);
    const window = log.slice(blendOn, blendOff);
    // 2 world ranges + 1 alias draw, all executed ...
    expect(window.filter((c) => c.startsWith('drawElements')).length).toBe(3);
    // ... and every world-range draw re-binds the lit program (an earlier
    // revision drew post-alias world ranges with the alias program bound).
    const litPid = state.programs[0];
    const litBinds = window.filter((c) => c === `useProgram ${litPid}`).length;
    expect(litBinds).toBeGreaterThanOrEqual(2);
  });

  it('moved brush verts re-sync positions without a generation bump or rebuild', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, W, H);
    const w = turnWorld();
    r.attachWorld(w);
    r.setPalette(rampPalette());
    const spawn = selectGpuScene(w, [], refDef([0, 0, 0], 90), W, H);
    r.setScene(spawn);
    renderWithScene(r, state, spawn);
    renderWithScene(r, state, spawn);
    // Steady state: uploads pinned to the single generation.
    expect(r.testUploadStats()).toEqual({ uploads: 1 });

    // Simulate a brush mover (DoorSync): shift surface 0 by +40 in x.
    const s = w.surfaces[0]!;
    for (let i = 0; i < s.verts.length; i += 3) s.verts[i]! += 40;
    const before = new Map([...state.uploads].map(([id, list]) => [id, list.length] as const));
    renderWithScene(r, state, spawn);
    expect(r.testUploadStats()).toEqual({ uploads: 1 });
    // Exactly one extra upload happened: the whole position buffer re-sync
    // (no per-surface rebuild, no generation bump).
    const totalExtra = [...state.uploads].reduce(
      (n, [id, list]) => n + (list.length - (before.get(id) ?? 0)), 0,
    );
    expect(totalExtra).toBe(1);
    // Steady again afterwards: no further re-uploads without motion.
    const afterMove = new Map([...state.uploads].map(([id, list]) => [id, list.length] as const));
    renderWithScene(r, state, spawn);
    for (const [id, list] of state.uploads) {
      expect(list.length).toBe(afterMove.get(id));
    }
  });
});

// --- Real base1 (Q2_PAK-gated) ------------------------------------------------

function pakReadFile(pakPath: string, name: string): ArrayBuffer {
  const data = readFileSync(pakPath);
  const dirofs = data.readUInt32LE(4);
  const dirlen = data.readUInt32LE(8);
  for (let o = dirofs; o < dirofs + dirlen; o += 64) {
    const entry = data.subarray(o, o + 56).toString().replace(/\0.*$/, '');
    if (entry === name) {
      const off = data.readUInt32LE(o + 56);
      const len = data.readUInt32LE(o + 60);
      return data.buffer.slice(data.byteOffset + off, data.byteOffset + off + len) as ArrayBuffer;
    }
  }
  throw new Error(`pak entry missing: ${name}`);
}

describe.runIf(!!process.env.Q2_PAK)('FOLLOW-2 real base1 visibility (Q2_PAK)', () => {
  it('turn + cluster move: previously hidden surfaces become drawable, selection stays valid', { timeout: 180000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const map = loadBsp(pakReadFile(pakPath, 'maps/base1.bsp'));
    const world = bspToMiniWorld(map, { texelFor: () => null });
    expect(world.surfaces.length).toBeGreaterThan(1000);

    // Persistent inventory covers every triangulable surface.
    const full = fullWorldRefs(world);
    const fullIds = new Set(full.map((r) => r.surfaceId));
    expect(full.length).toBeGreaterThan(1000);

    // Spawn-north anchor (GPU-PROOF-1 route) vs the 180-degree turn.
    const spawnView = refDef([128, -320, 54], 90);
    const turnView = refDef([128, -320, 54], 270);
    const spawn = selectGpuScene(world, [], spawnView, W, H);
    const turned = selectGpuScene(world, [], turnView, W, H);
    const spawnIds = new Set(worldIds(spawn.surfaces));
    const turnedIds = new Set(worldIds(turned.surfaces));
    expect(spawn.surfaces.length).toBeGreaterThan(0);
    expect(turned.surfaces.length).toBeGreaterThan(0);
    // The turn reveals surfaces the spawn frustum/backface culled ...
    const newlyVisible = [...turnedIds].filter((id) => !spawnIds.has(id));
    expect(newlyVisible.length).toBeGreaterThan(0);
    // ... and drops surfaces that now face away (selection actually changes).
    const dropped = [...spawnIds].filter((id) => !turnedIds.has(id));
    expect(dropped.length).toBeGreaterThan(0);
    // Nothing outside the persistent inventory ever appears.
    for (const id of [...spawnIds, ...turnedIds]) expect(fullIds.has(id)).toBe(true);

    // Occlusion semantic: every selected world surface re-passes an
    // independent frustum check, and every single-sided one faces the camera
    // (front side visible). Sky hulls and turbulent water are double-sided
    // (CPU frame.ts: cull iff !turbulent && !sky); translucent glass IS
    // culled from behind like opaque.
    for (const [view, sel] of [[spawnView, spawn], [turnView, turned]] as const) {
      const cam = setupCamera(view.origin, view.angles, view.fovX, W, H);
      for (const ref of sel.surfaces) {
        if (ref.transformIndex !== 0) continue;
        const s = world.surfaces[ref.surfaceId]!;
        expect(culledByFrustum(cam, s.mins, s.maxs), `surface ${ref.surfaceId} frustum`).toBe(false);
        // Single-sided (opaque + translucent glass) faces the camera;
        // sky + turbulent water are double-sided and exempt.
        if (ref.material === 'opaque' || ref.material === 'transparent') {
          const dx = view.origin[0]! - s.center[0]!;
          const dy = view.origin[1]! - s.center[1]!;
          const dz = view.origin[2]! - s.center[2]!;
          expect(
            s.fn[0]! * dx + s.fn[1]! * dy + s.fn[2]! * dz,
            `surface ${ref.surfaceId} backface`,
          ).toBeGreaterThan(0);
        }
      }
    }

    // Transparent world order is far->near for BOTH views.
    for (const sel of [spawn, turned]) {
      const blend = sel.surfaces.filter((r) => r.transparent && r.transformIndex === 0);
      for (let i = 1; i < blend.length; i++) {
        expect(blend[i - 1]!.order).toBeGreaterThanOrEqual(blend[i]!.order);
      }
    }

    // Cluster translation: grid-search two camera spots in different PVS
    // clusters with non-empty selections; both must differ from spawn.
    const spots: Array<{ origin: [number, number, number]; cluster: number }> = [];
    const root = world.nodes[0];
    if (root) {
      for (let gx = root.mins[0]! + 40; gx < root.maxs[0]!; gx += 160) {
        for (let gy = root.mins[1]! + 40; gy < root.maxs[1]!; gy += 160) {
          const o = new Float32Array([gx, gy, 54]);
          const c = cameraCluster(world, o);
          if (c >= 0 && !spots.some((s) => s.cluster === c)) {
            spots.push({ origin: [gx, gy, 54], cluster: c });
            if (spots.length >= 2) break;
          }
        }
        if (spots.length >= 2) break;
      }
    }
    expect(spots.length).toBe(2);
    expect(spots[0]!.cluster).not.toBe(spots[1]!.cluster);
    const selA = selectGpuScene(world, [], refDef(spots[0]!.origin, 90), W, H);
    const selB = selectGpuScene(world, [], refDef(spots[1]!.origin, 90), W, H);
    expect(selA.surfaces.length).toBeGreaterThan(0);
    expect(selB.surfaces.length).toBeGreaterThan(0);
    expect(JSON.stringify(worldIds(selA.surfaces))).not.toBe(JSON.stringify(worldIds(selB.surfaces)));
    console.log(
      `FOLLOW-2 base1: full=${full.length} spawn=${spawn.surfaces.length} ` +
        `turned=${turned.surfaces.length} newlyVisible=${newlyVisible.length} ` +
        `dropped=${dropped.length} clusters=${spots[0]!.cluster}/${spots[1]!.cluster} ` +
        `selA=${selA.surfaces.length} selB=${selB.surfaces.length}`,
    );
  });

  it('entity refs keep working through a re-selection (kinds + transparent bit)', { timeout: 180000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const map = loadBsp(pakReadFile(pakPath, 'maps/base1.bsp'));
    const world = bspToMiniWorld(map, { texelFor: () => null });
    const entities: Entity[] = [
      { model: 1, origin: new Float32Array([128, -272, 24]), angles: new Float32Array([0, 270, 0]), frame: 4, skin: 7 },
      { model: 2, origin: new Float32Array([128, -260, 34]), angles: new Float32Array([0, 270, 0]), frame: 0, skin: 8, alpha: 0.5 },
    ];
    const kinds = new Map<number, GpuEntityModelKind>([[1, 'md2'], [2, 'sp2']]);
    const view = refDef([128, -320, 54], 90);
    const out = refreshGpuScene(world, entities, view, W, H, kinds);
    const entRefs = out.surfaces.filter((r) => r.transformIndex >= 1);
    expect(entRefs.length).toBe(2);
    expect(entRefs.find((r) => r.transformIndex === 1)!.material).toBe('alias');
    const sprite = entRefs.find((r) => r.transformIndex === 2)!;
    expect(sprite.material).toBe('sprite');
    expect(sprite.transparent).toBe(true);
    expect(out.transforms.length).toBe(3);
  });
});
