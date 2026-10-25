// M3.3 tests: PVS + frustum reject, edge emit, z-sorted spans, coplanar order.
import { describe, expect, it } from 'vitest';
import { setupCamera, culledByFrustum } from './camera.js';
import {
  collectVisibleSurfaces, findLeaf, clusterVisible, surfFrustumCulled,
  type MiniWorld,
} from './worldNodes.js';
import {
  createEdgeScratch, emitSpansForPoly, projectClippedPoly, sortRowSpans,
} from './edges.js';
import { runSpanFlat } from './spans.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';

function facingQuadCam() {
  // camera at origin looking +X, 90deg fov, 64x64
  return setupCamera(new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90, 64, 64);
}

describe('PVS + traversal', () => {
  it('findLeaf descends to the correct leaf', () => {
    const world = createDevroom();
    expect(findLeaf([], new Float32Array([0, 0, 0]))).toBe(0);
    void world;
    const nodes = [{
      nx: 1, ny: 0, nz: 0, dist: 0, front: -1, back: -2,
      mins: new Float32Array([-10, -10, -10]), maxs: new Float32Array([10, 10, 10]),
      firstSurf: 0, numSurfs: 0,
    }];
    expect(findLeaf(nodes, new Float32Array([5, 0, 0]))).toBe(0);
    expect(findLeaf(nodes, new Float32Array([-5, 0, 0]))).toBe(1);
  });

  it('clusterVisible gates by bitset', () => {
    const world = createDevroom();
    expect(clusterVisible(world, 0, 0)).toBe(true);
    expect(clusterVisible(world, -1, 0)).toBe(true);
  });

  it('devroom traversal yields all 11 surfaces front-to-back from inside', () => {
    const world = createDevroom();
    const cam = setupCamera(DEVROOM_CAMERA.origin, DEVROOM_CAMERA.angles, DEVROOM_CAMERA.fovX, 320, 240);
    const surfs: number[] = [];
    const order: number[] = [];
    const n = collectVisibleSurfaces(world, cam, 0, surfs, order);
    expect(n).toBe(world.surfaces.length);
    // traversal order tags are a strict 0..n-1 sequence
    expect([...order].sort((a, b) => a - b)).toEqual(surfs.map((_, i) => i));
  });

  it('frustum reject: looking away from the room culls every surface', () => {
    const world = createDevroom();
    // camera outside the room looking away (+X from x=600, yaw 0 faces +X)
    const cam = setupCamera(new Float32Array([600, 0, 136]), new Float32Array([0, 0, 0]), 90, 320, 240);
    const surfs: number[] = [];
    const order: number[] = [];
    const n = collectVisibleSurfaces(world, cam, 0, surfs, order);
    // PVS still admits them (single leaf); the per-surface frustum stage drops all
    expect(n).toBe(world.surfaces.length);
    let culled = 0;
    for (let i = 0; i < n; i++) {
      if (surfFrustumCulled(cam, world.surfaces[surfs[i]!]!)) culled++;
    }
    expect(culled).toBe(n);
  });

  it('node-level frustum reject prunes a whole subtree', () => {
    const cam = facingQuadCam();
    const backNode = {
      nx: 1, ny: 0, nz: 0, dist: 0, front: -1, back: -2,
      mins: new Float32Array([-10, -10, -10]), maxs: new Float32Array([-5, 10, 10]),
      firstSurf: 0, numSurfs: 0,
    };
    const world: MiniWorld = {
      brand: 'miniworld', nodes: [backNode],
      leafs: [
        { cluster: 0, firstSurf: 0, numSurfs: 0 },
        { cluster: 0, firstSurf: 5, numSurfs: 3 },
      ],
      pvs: [new Uint8Array([1])], clusterCount: 1,
      surfaces: [], textures: [], lightmaps: [], dynamicLights: [],
      alias: [], sprites: [], particles: [],
    };
    const surfs: number[] = [];
    const order: number[] = [];
    // camera looks +X: the back leaf (x<0) subtree is frustum-rejected
    const n = collectVisibleSurfaces(world, cam, 0, surfs, order);
    expect(n).toBe(0);
  });

  it('culledByFrustum rejects a bbox behind the camera', () => {
    const cam = facingQuadCam();
    const mins = new Float32Array([-10, -10, -10]);
    const maxs = new Float32Array([-5, 10, 10]);
    expect(culledByFrustum(cam, mins, maxs)).toBe(true);
    const inMins = new Float32Array([10, -5, -5]);
    const inMaxs = new Float32Array([20, 5, 5]);
    expect(culledByFrustum(cam, inMins, inMaxs)).toBe(false);
    void surfFrustumCulled;
  });
});

describe('edge emit + z-sort', () => {
  it('projects a facing quad to full-height span coverage', () => {
    const cam = facingQuadCam();
    const scratch = createEdgeScratch(16);
    // quad at x=32, y/z in [-32, 32]: fills the 64x64 view exactly
    const input = {
      verts: new Float32Array([32, -32, -32, 32, 32, -32, 32, 32, 32, 32, -32, 32]),
      uvs: new Float32Array([0, 0, 64, 0, 64, 64, 0, 64]),
      lux: new Float32Array([0, 0, 4, 0, 4, 4, 0, 4]),
      n: 4,
    };
    const n = projectClippedPoly(input, cam, 64, 64, scratch);
    expect(n).toBe(4);
    const pool: { kind: number; y: number; x0: number; x1: number; iz: number; diz: number; uz: number; duz: number; vz: number; dvz: number; light: number; dlight: number; lu: number; lv: number; dlu: number; turb: number; ord: number }[] = [];
    const end = emitSpansForPoly(scratch.poly, n, 0, pool, 0, 1024, 63, 0, 64);
    expect(end).toBe(64);
    for (const s of pool) {
      // pre-clip edges may sit one pixel out; the draw stage clips to [0,64)
      expect(s.x0).toBeLessThanOrEqual(0);
      expect(s.x1).toBeGreaterThanOrEqual(64);
    }
  });

  it('near clip removes geometry behind the camera', () => {
    const cam = facingQuadCam();
    const scratch = createEdgeScratch(16);
    const input = {
      verts: new Float32Array([-64, -8, -8, -64, 8, -8, -64, 8, 8, -64, -8, 8]),
      uvs: new Float32Array([0, 0, 8, 0, 8, 8, 0, 8]),
      lux: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      n: 4,
    };
    expect(projectClippedPoly(input, cam, 64, 64, scratch)).toBe(0);
  });

  it('sortRowSpans orders by descending 1/z, BSP order breaks ties', () => {
    const mkS = (iz: number, ord: number) => ({
      span: { kind: 0, y: 5, x0: 0, x1: 2, iz, diz: 0, uz: 0, duz: 0, vz: 0, dvz: 0, light: 0, dlight: 0, lu: 0, lv: -1, dlu: 0, turb: 0, ord },
      order: ord,
    });
    const rows = [mkS(0.1, 2), mkS(0.5, 1), mkS(0.5, 0)];
    const sorted = sortRowSpans(rows);
    expect(sorted[0]!.order).toBe(0);
    expect(sorted[1]!.order).toBe(1);
    expect(sorted[2]!.order).toBe(2);
  });

  it('strict > depth test keeps the first span on coplanar ties', () => {
    const idx = new Uint8Array(2).fill(7);
    const zb = new Float32Array(2).fill(0.5);
    // same iz as stored: second span must NOT overwrite (BSP order wins)
    runSpanFlat(idx, zb, 0, 2, 0.5, 0, 9);
    expect([...idx]).toEqual([7, 7]);
    // nearer span overwrites
    runSpanFlat(idx, zb, 0, 2, 0.75, 0, 9);
    expect([...idx]).toEqual([9, 9]);
  });
});

describe('devroom world', () => {
  it('builds 11 surfaces with pow2 textures and valid lightmaps', () => {
    const world: MiniWorld = createDevroom();
    expect(world.surfaces.length).toBe(11);
    for (const t of world.textures) {
      expect(t.width & (t.width - 1)).toBe(0);
      expect(t.height & (t.height - 1)).toBe(0);
    }
    expect(world.leafs[0]!.numSurfs).toBe(11);
    expect(world.alias.length).toBe(1);
    expect(world.sprites.length).toBe(1);
    expect(world.particles.length).toBe(8);
  });
});
