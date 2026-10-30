// @q2/webgl-renderer scene tests — pure selection, no real GL.
//
// Q2_PAK-gated section boots real base1 (loadBsp + bspToMiniWorld with a
// null texel source — selection needs geometry/PVS only, never texels)
// and pins the F0 contract. Pure unit parts always run.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { loadBsp } from '@q2/bsp';
import {
  bspToMiniWorld,
  culledByFrustum,
  setupCamera,
  type MiniSurf,
  type MiniWorld,
} from '@q2/sw-renderer';
import type { Entity, RefDef } from '@q2/renderer-api';
import {
  cameraCluster,
  entityTransform,
  identityTransform,
  orderDistance,
  selectGpuScene,
  type GpuEntityModelKind,
} from './scene.js';

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

function boxSurf(
  id: number,
  center: [number, number, number],
  fn: [number, number, number],
  extra: Partial<MiniSurf> = {},
): MiniSurf {
  const [cx, cy, cz] = center;
  return {
    id,
    verts: new Float32Array([cx - 1, cy, cz - 1, cx + 1, cy, cz - 1, cx + 1, cy, cz + 1]),
    uvs: new Float32Array(6),
    lux: new Float32Array(6),
    n: 3,
    texId: 5,
    lightId: id,
    center: new Float32Array(center),
    radius: 2,
    mins: new Float32Array([cx - 1, cy - 1, cz - 1]),
    maxs: new Float32Array([cx + 1, cy + 1, cz + 1]),
    turbulent: false,
    translucent: 0,
    sky: false,
    fn: new Float32Array(fn),
    ...extra,
  };
}

/** Hand-built single-leaf world: camera at origin looking +Y (yaw 90). */
function fixtureWorld(): MiniWorld {
  const w = emptyWorld();
  w.leafs = [{ cluster: 0, firstSurf: 0, numSurfs: 0, faceList: [0, 1, 2, 3, 4, 5] }];
  w.pvs = [new Uint8Array([1])];
  w.clusterCount = 1;
  w.surfaces = [
    boxSurf(0, [0, 100, 0], [0, -1, 0]), // opaque, front faces camera: kept
    boxSurf(1, [0, 100, 10], [0, 1, 0]), // opaque, back faces camera: culled
    boxSurf(2, [0, 200, 0], [0, -1, 0], { translucent: 1 }), // transparent, order 200
    boxSurf(3, [0, 150, 0], [0, -1, 0], { translucent: 2 }), // transparent, order 150
    boxSurf(4, [0, 120, 40], [0, 1, 0], { sky: true, texId: 9 }), // sky: kept, handle -1
    { ...boxSurf(5, [0, 0, 0], [0, 0, 1]), n: 0, verts: new Float32Array(0) }, // degenerate: skipped
  ];
  return w;
}

function fixtureEntities(): { entities: Entity[]; kinds: Map<number, GpuEntityModelKind> } {
  const entities: Entity[] = [
    { model: 1, origin: new Float32Array([10, 20, 30]), angles: new Float32Array([0, 90, 0]), frame: 4, skin: 7 },
    { model: 2, origin: new Float32Array([0, 50, 0]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 8, alpha: 0.5 },
    { model: 3, origin: new Float32Array([5, 60, 5]), angles: new Float32Array([0, 180, 0]), frame: 0, skin: 9 },
  ];
  const kinds = new Map<number, GpuEntityModelKind>([[1, 'md2'], [2, 'sp2'], [3, 'tracer']]);
  return { entities, kinds };
}

describe('selectGpuScene pure units (always run)', () => {
  it('empty world: no surfaces, identity world slot, generation 1', () => {
    const out = selectGpuScene(emptyWorld(), [], refDef([0, 0, 0], 90), W, H);
    expect(out.surfaces).toEqual([]);
    expect(out.transforms.length).toBe(1);
    expect([...out.transforms[0]!]).toEqual([...identityTransform()]);
    expect(out.staticGeneration).toBe(1);
  });

  it('identity transform is column-major identity', () => {
    expect([...identityTransform()]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('entity transform is translation + yaw rotation', () => {
    const m = entityTransform(new Float32Array([10, 20, 30]), 90);
    const e = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1];
    for (let i = 0; i < 16; i++) expect(m[i]!).toBeCloseTo(e[i]!, 6);
  });

  it('orderDistance is Euclidean', () => {
    expect(orderDistance(0, 0, 0, 3, 4, 0)).toBe(5);
  });

  it('cameraCluster: outside hull and empty tree yield -1 (no PVS gating)', () => {
    const w = emptyWorld();
    expect(cameraCluster(w, new Float32Array([0, 0, 0]))).toBe(-1);
    const hull = emptyWorld();
    hull.nodes = [{
      nx: 1, ny: 0, nz: 0, dist: 0, front: -1, back: -1,
      mins: new Float32Array([0, 0, 0]), maxs: new Float32Array([10, 10, 10]),
      firstSurf: 0, numSurfs: 0,
    }];
    expect(cameraCluster(hull, new Float32Array([100, 5, 5]))).toBe(-1);
  });

  it('fixture: backface culls opaque, sky exempt with handle -1, degenerate skipped', () => {
    const out = selectGpuScene(fixtureWorld(), [], refDef([0, 0, 0], 90), W, H);
    const ids = out.surfaces.filter((r) => r.transformIndex === 0).map((r) => r.surfaceId);
    expect(ids).toContain(0); // front-facing opaque
    expect(ids).not.toContain(1); // back-facing opaque culled
    expect(ids).not.toContain(5); // degenerate placeholder skipped
    const sky = out.surfaces.find((r) => r.surfaceId === 4)!;
    expect(sky.material).toBe('sky');
    expect(sky.materialHandle).toBe(-1);
    expect(sky.transparent).toBe(false);
    expect(out.surfaces.find((r) => r.surfaceId === 0)!.materialHandle).toBe(5);
  });

  it('fixture: transparent sorted far->near, entity refs mapped with transformIndex >= 1', () => {
    const { entities, kinds } = fixtureEntities();
    const out = selectGpuScene(fixtureWorld(), entities, refDef([0, 0, 0], 90), W, H, kinds);
    const transparent = out.surfaces.filter((r) => r.transparent);
    // World 200/150 + default-alpha beam at ~60.4 (FOLLOW-3: tracers always
    // blend with a real distance key) + transparent sprite at 50.
    expect(transparent.length).toBe(4);
    for (let i = 1; i < transparent.length; i++) {
      expect(transparent[i - 1]!.order).toBeGreaterThanOrEqual(transparent[i]!.order);
    }
    expect(transparent.map((r) => r.order)).toEqual([200, 150, Math.sqrt(3650), 50]);
    expect(out.transforms.length).toBe(1 + entities.length);
    expect([...out.transforms[0]!]).toEqual([...identityTransform()]);
    const bySlot = (slot: number) => out.surfaces.find((r) => r.transformIndex === slot)!;
    expect(bySlot(1).material).toBe('alias');
    expect(bySlot(1).transparent).toBe(false);
    expect(bySlot(2).material).toBe('sprite'); // sp2 -> sprite
    expect(bySlot(2).transparent).toBe(true); // alpha 0.5
    expect(bySlot(3).material).toBe('beam'); // tracer -> beam
    expect(bySlot(3).transparent).toBe(true); // FOLLOW-3: default-alpha beams blend
    for (const r of out.surfaces) {
      if (r.transformIndex > 0) expect(r.transformIndex).toBeLessThan(out.transforms.length);
    }
  });

  it('unknown model handles default to alias', () => {
    const entities: Entity[] = [{
      model: 99, origin: new Float32Array([0, 50, 0]),
      angles: new Float32Array([0, 0, 0]), frame: 0, skin: 3,
    }];
    const out = selectGpuScene(fixtureWorld(), entities, refDef([0, 0, 0], 90), W, H);
    expect(out.surfaces.find((r) => r.transformIndex === 1)!.material).toBe('alias');
  });

  it('generation stable across identical calls', () => {
    const { entities, kinds } = fixtureEntities();
    const view = refDef([0, 0, 0], 90);
    const a = selectGpuScene(fixtureWorld(), entities, view, W, H, kinds);
    const b = selectGpuScene(fixtureWorld(), entities, view, W, H, kinds);
    expect(b.staticGeneration).toBe(a.staticGeneration);
    expect(JSON.stringify(b.surfaces)).toBe(JSON.stringify(a.surfaces));
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

describe.runIf(!!process.env.Q2_PAK)('selectGpuScene on real base1 (Q2_PAK)', () => {
  it('F0 selection: non-empty, frustum-clean, ordered, entities present', { timeout: 120000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const map = loadBsp(pakReadFile(pakPath, 'maps/base1.bsp'));
    // Null texel source: selection needs geometry/PVS only, never texels.
    const world = bspToMiniWorld(map, { texelFor: () => null });
    // F0 stationary spawn-north (matches the GPU-PROOF-1 route anchor).
    const view = refDef([128, -320, 54], 90);
    // Camera-relative entity cast: opaque alias, transparent alias, sprite, beam.
    const entities: Entity[] = [
      { model: 1, origin: new Float32Array([128, -272, 24]), angles: new Float32Array([0, 270, 0]), frame: 4, skin: 7 },
      { model: 2, origin: new Float32Array([128, -260, 34]), angles: new Float32Array([0, 270, 0]), frame: 0, skin: 8, alpha: 0.5 },
      { model: 3, origin: new Float32Array([128, -272, 72]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 9 },
      { model: 4, origin: new Float32Array([153, -280, 44]), angles: new Float32Array([0, 180, 0]), frame: 96, skin: 231 },
    ];
    const kinds = new Map<number, GpuEntityModelKind>([[1, 'md2'], [2, 'md2'], [3, 'sp2'], [4, 'tracer']]);
    const out = selectGpuScene(world, entities, view, W, H, kinds);

    // Non-empty world selection.
    const worldRefs = out.surfaces.filter((r) => r.transformIndex === 0);
    expect(worldRefs.length).toBeGreaterThan(0);

    // PVS dedupe: every selected surface id appears exactly once.
    const ids = worldRefs.map((r) => r.surfaceId);
    expect(new Set(ids).size).toBe(ids.length);

    // Independent frustum re-check with a freshly built camera.
    const cam = setupCamera(
      new Float32Array([128, -320, 54]), new Float32Array([0, 90, 0]), 90, W, H,
    );
    for (const ref of worldRefs) {
      const s = world.surfaces[ref.surfaceId]!;
      expect(culledByFrustum(cam, s.mins, s.maxs), `surface ${ref.surfaceId} frustum`).toBe(false);
    }

    // Transparent blend pass sorted far -> near (larger order = farther).
    const transparent = out.surfaces.filter((r) => r.transparent);
    for (let i = 1; i < transparent.length; i++) {
      expect(transparent[i - 1]!.order).toBeGreaterThanOrEqual(transparent[i]!.order);
    }

    // World slot is identity; every entity ref has transformIndex >= 1.
    expect([...out.transforms[0]!]).toEqual([...identityTransform()]);
    expect(out.transforms.length).toBe(1 + entities.length);
    const entityRefs = out.surfaces.filter((r) => r.transformIndex >= 1);
    expect(entityRefs.length).toBe(entities.length);
    const materials = entityRefs.map((r) => r.material).sort();
    expect(materials).toEqual(['alias', 'alias', 'beam', 'sprite']);

    // Generation stable across identical calls (same ids, same order).
    const again = selectGpuScene(world, entities, view, W, H, kinds);
    expect(again.staticGeneration).toBe(out.staticGeneration);
    expect(JSON.stringify(again.surfaces)).toBe(JSON.stringify(out.surfaces));
  });
});
