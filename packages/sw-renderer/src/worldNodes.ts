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
  /**
   * Explicit surface list (WIRE: converted BSP leafs use the leaffaces lump,
   * which is non-contiguous). When present it replaces the firstSurf/numSurfs
   * range; traversal dedupes shared faces across leafs (R_MarkLeaves marks).
   */
  faceList?: number[];
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
  /**
   * Animated-texture chain (R_TextureAnimation, r_surf.c): texIds of the
   * texinfo `next` chain starting with this surface's own texture ([0] ===
   * texId at bake). Present only when the chain has >1 frame (base1 button
   * faces like +0btshoot1..3). The submission layer (web DoorSync) writes
   * the picked frame into texId per frame from the mover's fx/frame/time;
   * renderers treat texId as live and invalidate on drift.
   */
  animTexIds?: number[];
  lightId: number;
  center: Float32Array;
  radius: number;
  mins: Float32Array;
  maxs: Float32Array;
  turbulent: boolean;
  /**
   * Translucency class (ref_soft texinfo flags): 0/undefined = opaque,
   * 1 = SURF_TRANS33 (alpha ~0.30, e.g. base1 glass), 2 = SURF_TRANS66
   * (alpha ~0.60, e.g. translucent water). Translucent surfaces skip the
   * edge/span path and draw in a deferred alpha pass after all opaque
   * geometry (R_DrawAlphaSurfaces): depth-tested, never depth-writing.
   * Optional so procedural worlds stay opaque without touching builders.
   */
  translucent?: number;
  /**
   * Sky surface (SURF_SKY): drawn as a flat-shaded fill with no texture,
   * lightmap, or surface-cache entry, and exempt from backface culling
   * (sky hulls face outward). ref_soft drew scrolling sky layers here;
   * the flat fill is the minimal faithful stand-in.
   */
  sky: boolean;
  /**
   * Front-side normal (plane normal corrected for planeback, or the
   * geometric normal for procedural surfs). Used for backface culling;
   * sign only matters.
   */
  fn: Float32Array;
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
 * R_MarkLeaves equivalent (r_bsp.c): mark every node with a PVS-visible
 * descendant, so the walk below can skip whole unmarked subtrees — including
 * their node faces, which in QBSP carry the bulk of all surfaces. Without
 * this, every frame emits the entire map (PVS only dedupes, never reduces).
 * Marks live in a per-world reusable buffer: zero alloc per frame.
 */
const markCache = new WeakMap<MiniWorld, Uint8Array>();

/**
 * PVS-mark memo (perf remediation item 5): PVS marks depend only on
 * (world, viewCluster) — NOT on camera orientation (frustum culling stays
 * live per frame in walkNode via culledByFrustum). Rotating inside one
 * cluster reuses the completed marking with zero traversal; crossing
 * clusters, switching worlds, or a node-count change recomputes. Worlds are
 * static per level, so no other invalidation is needed.
 */
interface MarkMemo {
  cluster: number;
  nodeCount: number;
}
/** Last completed marking per world (not just the buffer — the inputs). */
const markMemo = new WeakMap<MiniWorld, MarkMemo>();
/** Observability for the memo (test hook): hits skip the whole subtree walk. */
let markCacheHits = 0;
let markCacheMisses = 0;

/** Hit/miss counts since the last reset (test hook, zero behavior change). */
export function testMarkCacheStats(): { hits: number; misses: number } {
  return { hits: markCacheHits, misses: markCacheMisses };
}

/** Reset the memo counters (test hook). */
export function testResetMarkCacheStats(): void {
  markCacheHits = 0;
  markCacheMisses = 0;
}

function markSubtree(world: MiniWorld, marks: Uint8Array, ni: number, viewCluster: number): boolean {
  if (ni < 0) {
    const leaf = world.leafs[-ni - 1];
    return !!leaf && clusterVisible(world, viewCluster, leaf.cluster);
  }
  const n = world.nodes[ni]!;
  const visL = markSubtree(world, marks, n.front, viewCluster);
  const visR = markSubtree(world, marks, n.back, viewCluster);
  marks[ni] = visL || visR ? 1 : 0;
  return visL || visR;
}

function markedVisible(world: MiniWorld, viewCluster: number): Uint8Array {
  // Memo hit: identical (world, cluster, node count) — the completed
  // marking is still valid, so skip the recursive walk entirely. The
  // buffer is untouched on this path (never zeroed, never rewritten).
  const memo = markMemo.get(world);
  if (memo && memo.cluster === viewCluster && memo.nodeCount === world.nodes.length) {
    const kept = markCache.get(world);
    if (kept && kept.length >= world.nodes.length) {
      markCacheHits++;
      return kept;
    }
    // Buffer lost or short (should not happen — same world, same count):
    // fall through to the miss path and rebuild it.
  }
  let marks = markCache.get(world);
  if (!marks || marks.length < world.nodes.length) {
    marks = new Uint8Array(world.nodes.length);
    markCache.set(world, marks);
  } else {
    marks.fill(0);
  }
  markSubtree(world, marks, 0, viewCluster);
  markCacheMisses++;
  markMemo.set(world, { cluster: viewCluster, nodeCount: world.nodes.length });
  return marks;
}
/**
 * Recursive node walk: PVS + frustum reject, surfaces collected front-to-back
 * (BSP order). Returns visible surface indices and the traversal order tag
 * per surface (lower = nearer; coplanar ties resolve by this order).
 *
 * Surfaces shared by several visible leafs are emitted once (per-frame mark,
 * like R_MarkLeaves): the stamp array is keyed off the world so repeated
 * frames allocate nothing.
 */
export function collectVisibleSurfaces(
  world: MiniWorld,
  cam: Camera,
  viewCluster: number,
  outSurfs: number[],
  outOrder: number[],
): number {
  const stamp = stampFor(world);
  stamp.tick++;
  const ctx: WalkCtx = { world, cam, viewCluster, outSurfs, outOrder, count: 0, order: 0, stamp, marks: null };
  const nodes = world.nodes;
  if (nodes.length === 0) {
    // single-leaf world: all surfaces, PVS-gated
    for (let li = 0; li < world.leafs.length; li++) {
      const leaf = world.leafs[li]!;
      if (!clusterVisible(world, viewCluster, leaf.cluster)) continue;
      ctx.count = emitLeafSurfaces(leaf, ctx);
    }
    return ctx.count;
  }
  // PVS ancestor marks (R_MarkLeaves): unmarked subtrees are skipped wholesale.
  ctx.marks = markedVisible(world, viewCluster);
  // Recursive front-to-back walk (depth is tiny for our worlds; the
  // traversal order tag gives BSP-order coplanar resolution).
  walkNode(ctx, 0);
  return ctx.count;
}

interface WalkCtx {
  world: MiniWorld;
  cam: Camera;
  viewCluster: number;
  outSurfs: number[];
  outOrder: number[];
  count: number;
  order: number;
  stamp: { ids: Int32Array; tick: number };
  marks: Uint8Array | null;
}

const stampCache = new WeakMap<MiniWorld, { ids: Int32Array; tick: number }>();

function stampFor(world: MiniWorld): { ids: Int32Array; tick: number } {
  let s = stampCache.get(world);
  if (!s || s.ids.length < world.surfaces.length) {
    s = { ids: new Int32Array(Math.max(16, world.surfaces.length)), tick: 0 };
    stampCache.set(world, s);
  }
  if (s.tick === 0x7fffffff) {
    s.ids.fill(0);
    s.tick = 0;
  }
  return s;
}

function emitSurf(ctx: WalkCtx, si: number): void {
  if (si < 0 || si >= ctx.world.surfaces.length) return;
  if (ctx.stamp.ids[si] === ctx.stamp.tick) return;
  ctx.stamp.ids[si] = ctx.stamp.tick;
  ctx.outSurfs[ctx.count] = si;
  ctx.outOrder[ctx.count] = ctx.order++;
  ctx.count++;
}

function emitLeafSurfaces(leaf: MiniLeaf, ctx: WalkCtx): number {
  const list = leaf.faceList;
  if (list) {
    for (let i = 0; i < list.length; i++) emitSurf(ctx, list[i]!);
  } else {
    for (let i = 0; i < leaf.numSurfs; i++) emitSurf(ctx, leaf.firstSurf + i);
  }
  return ctx.count;
}

function walkNode(ctx: WalkCtx, ni: number): void {
  if (ni < 0) {
    const leaf = ctx.world.leafs[-ni - 1];
    if (!leaf || !clusterVisible(ctx.world, ctx.viewCluster, leaf.cluster)) return;
    ctx.count = emitLeafSurfaces(leaf, ctx);
    return;
  }
  // PVS gate first (id R_RecursiveWorldNode): unmarked subtrees — including
  // their node faces — are skipped entirely. Frustum reject second.
  if (ctx.marks && !ctx.marks[ni]) return;
  const n = ctx.world.nodes[ni]!;
  if (culledByFrustum(ctx.cam, n.mins, n.maxs)) return;
  const d = ctx.cam.origin[0]! * n.nx + ctx.cam.origin[1]! * n.ny + ctx.cam.origin[2]! * n.nz - n.dist;
  const first = d >= 0 ? n.front : n.back;
  const second = d >= 0 ? n.back : n.front;
  walkNode(ctx, first);
  for (let i = 0; i < n.numSurfs; i++) {
    emitSurf(ctx, n.firstSurf + i);
  }
  walkNode(ctx, second);
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
