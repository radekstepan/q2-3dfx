// @q2/sw-renderer worldNodes — r_bsp.c equivalent: recursive node walk,
// PVS + frustum reject, surface marking, BSP-order span collection.
//
// Operates on a minimal flat world (MiniWorld). Real BSP38 loading is M2.1's
// job; the procedural devroom (devroom.ts) builds a MiniWorld so the whole
// pipeline runs asset-free. Unknown WorldModel payloads fall back to devroom.

import { boxOnFrustumSide, culledByFrustum, type Camera } from './camera.js';

/** Flat BSP node: child >= 0 node index, < 0 leaf code -(leaf+1). */
export interface MiniNode {
  nx: number; ny: number; nz: number; dist: number;
  front: number; back: number;
  mins: Float32Array; maxs: Float32Array;
  firstSurf: number; numSurfs: number;
}

export interface MiniLeaf {
  cluster: number;
  firstSurf: number; numSurfs: number;
}

export interface MiniTexture {
  texels: Uint8Array;
  width: number; height: number;
}

export interface MiniLightmap {
  /** RGB luxel samples */
  samples: Uint8Array;
  luxW: number; luxH: number;
  /** lightstyle indices (into RefDef.lightStyles) */
  styles: number[];
}

export interface MiniSurf {
  id: number;
  /** world-space xyz, n*3 */
  verts: Float32Array;
  /** texture texels u,v per vert, n*2 */
  uvs: Float32Array;
  /** luxel coords per vert, n*2 */
  lux: Float32Array;
  n: number;
  texId: number;
  lightId: number;
  center: Float32Array;
  radius: number;
  mins: Float32Array;
  maxs: Float32Array;
  turbulent: boolean;
}

export interface MiniWorld {
  brand: 'miniworld';
  nodes: MiniNode[];
  leafs: MiniLeaf[];
  /** per-cluster visibility bitsets (clusterCount bytes each, raw, no RLE) */
  pvs: Uint8Array[];
  clusterCount: number;
  surfaces: MiniSurf[];
  textures: MiniTexture[];
  lightmaps: MiniLightmap[];
  dynamicLights: { origin: Float32Array; intensity: number; color: Float32Array }[];
  alias: PlacedAlias[];
  sprites: PlacedSprite[];
  particles: PlacedParticle[];
}

export interface PlacedAlias {
  meshId: number;
  origin: Float32Array;
  angles: Float32Array;
  frameA: number; frameB: number; lerp: number;
  skinId: number;
}

export interface PlacedSprite {
  origin: Float32Array;
  size: number;
  skinId: number;
}

export interface PlacedParticle {
  origin: Float32Array;
  color: number;
}

export function isMiniWorld(data: unknown): data is MiniWorld {
  if (!data || typeof data !== 'object') return false;
  return (data as { brand?: unknown }).brand === 'miniworld';
}

/** pointLeaf equivalent: descend the node tree to the containing leaf. */
export function findLeaf(nodes: MiniNode[], p: Float32Array): number {
  if (nodes.length === 0) return 0;
  let i = 0;
  while (i >= 0) {
    const n = nodes[i]!;
    const d = p[0]! * n.nx + p[1]! * n.ny + p[2]! * n.nz - n.dist;
    i = d >= 0 ? n.front : n.back;
  }
  return -i - 1;
}

/** Raw (non-RLE) PVS row for a cluster; null cluster = everything visible. */
export function clusterVisible(world: MiniWorld, cluster: number, target: number): boolean {
  if (cluster < 0 || target < 0) return true;
  const row = world.pvs[cluster];
  if (!row) return true;
  return ((row[target >> 3]! >> (target & 7)) & 1) === 1;
}

/**
 * Recursive node walk: PVS + frustum reject, surfaces collected front-to-back
 * (BSP order). Returns visible surface indices and the traversal order tag
 * per surface (lower = nearer; coplanar ties resolve by this order).
 */
export function collectVisibleSurfaces(
  world: MiniWorld,
  cam: Camera,
  viewCluster: number,
  outSurfs: number[],
  outOrder: number[],
): number {
  let count = 0;
  let order = 0;
  const nodes = world.nodes;
  if (nodes.length === 0) {
    // single-leaf world: all surfaces, PVS-gated
    for (let li = 0; li < world.leafs.length; li++) {
      const leaf = world.leafs[li]!;
      if (!clusterVisible(world, viewCluster, leaf.cluster)) continue;
      for (let i = 0; i < leaf.numSurfs; i++) {
        outSurfs[count] = leaf.firstSurf + i;
        outOrder[count] = order++;
        count++;
      }
    }
    return count;
  }
  // Recursive front-to-back walk (depth is tiny for our worlds; the
  // traversal order tag gives BSP-order coplanar resolution).
  const r = walkNode(world, cam, viewCluster, 0, outSurfs, outOrder, 0, 0);
  return r.count;
}

function walkNode(
  world: MiniWorld, cam: Camera, viewCluster: number, ni: number,
  outSurfs: number[], outOrder: number[], count: number, order: number,
): { count: number; order: number } {
  if (ni < 0) {
    const leaf = world.leafs[-ni - 1];
    if (!leaf || !clusterVisible(world, viewCluster, leaf.cluster)) return { count, order };
    for (let i = 0; i < leaf.numSurfs; i++) {
      outSurfs[count] = leaf.firstSurf + i;
      outOrder[count] = order++;
      count++;
    }
    return { count, order };
  }
  const n = world.nodes[ni]!;
  if (culledByFrustum(cam, n.mins, n.maxs)) return { count, order };
  const d = cam.origin[0]! * n.nx + cam.origin[1]! * n.ny + cam.origin[2]! * n.nz - n.dist;
  const first = d >= 0 ? n.front : n.back;
  const second = d >= 0 ? n.back : n.front;
  ({ count, order } = walkNode(world, cam, viewCluster, first, outSurfs, outOrder, count, order));
  for (let i = 0; i < n.numSurfs; i++) {
    outSurfs[count] = n.firstSurf + i;
    outOrder[count] = order++;
    count++;
  }
  ({ count, order } = walkNode(world, cam, viewCluster, second, outSurfs, outOrder, count, order));
  return { count, order };
}

/** Frustum-only surface cull helper (used for node-surface fast path). */
export function surfFrustumCulled(cam: Camera, s: MiniSurf): boolean {
  return culledByFrustum(cam, s.mins, s.maxs);
}

/** node bounds vs a single plane (BoxOnPlaneSide export for tests). */
export function nodePlaneSide(
  mins: Float32Array, maxs: Float32Array,
  nx: number, ny: number, nz: number, dist: number,
): 1 | 2 | 3 {
  const n = planeNormalCache;
  n[0] = nx; n[1] = ny; n[2] = nz;
  return boxOnFrustumSide(mins, maxs, n, dist);
}

const planeNormalCache = new Float32Array(3);
