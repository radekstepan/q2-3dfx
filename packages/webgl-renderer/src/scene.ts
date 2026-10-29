// @q2/webgl-renderer scene — pure GPU scene selection (GPU-PROOF-2).
//
// GL-free and DOM-free by construction: this module only reads MiniWorld /
// Entity / RefDef data and emits GpuSceneInput (persistent-triangle input,
// never CPU scanline/span state). It runs on map/view change, never per
// frame, so per-scene-build garbage (the PVS dedupe set, transform arrays)
// is acceptable — no allocation policy beyond the build.
//
// Pipeline (mirrors the CPU R_MarkLeaves + frustum + backface structure):
//   1. setupCamera from the view (same helper as the software renderer).
//   2. Locate the camera leaf with findLeaf (front = d >= 0 convention,
//      matching worldNodes.ts). The hull check below is the honest
//      no-PVS-gating rule: when the camera is outside the root node bounds
//      (or the tree yields no valid leaf) there is no PVS row, so every
//      leaf is treated as visible. A camera inside SOLID space carries
//      cluster -1, which clusterVisible also treats as everything-visible
//      (no row exists); both cases are documented, not silent fallbacks.
//   3. Union the faceLists of PVS-visible leafs, deduped (Set per build).
//      This is the complete visible set: in QBSP-converted worlds every
//      node-owned face is referenced by the mark surfaces of the leafs
//      below it, so leaf faceLists subsume node firstSurf/numSurfs ranges.
//   4. Frustum-cull survivors by bbox (culledByFrustum, same helper).
//   5. Backface-cull OPAQUE non-sky world surfaces via fn·(center-origin):
//      the front side faces the camera iff dot(fn, origin-center) > 0, so
//      dot(fn, center-origin) >= 0 (edge-on included) is culled. Sky,
//      turbulent and translucent surfaces are exempt (sky hulls face
//      outward; water/glass read from both sides).
//   6. Classify: sky -> sky, turbulent -> turbulent, translucent 1/2 ->
//      transparent, else opaque. Degenerate placeholder faces (n < 3, the
//      SURF_NODRAW empties bspToMiniWorld keeps index-stable) are skipped:
//      the GPU consumes triangles and there is nothing to upload.
//   7. Entity refs are appended unconditionally (no entity frustum culling
//      in PROOF-2; PROOF-3 may cull). Kind resolution needs the model
//      registry, which this pure function cannot see: pass modelKinds
//      (handle -> md2/sp2/tracer). Unknown/absent handles default to
//      'alias'. PROOF-3 threads the real registry through this seam.
//
// staticGeneration is the base build generation (1). The owning browser
// glue MUST bump it on map change / explicit invalidation — a fresh map
// also builds at 1, so the renderer only re-uploads when the generation
// it is handed changes. Real invalidation policy lands with PROOF-3.

import type {
  Entity,
  GpuMaterialKind,
  GpuSceneInput,
  GpuSurfaceRef,
  RefDef,
} from '@q2/renderer-api';
import type { Vec3 } from '@q2/math';
import {
  clusterVisible,
  culledByFrustum,
  findLeaf,
  setupCamera,
  type MiniSurf,
  type MiniWorld,
} from '@q2/sw-renderer';

/** Model kinds the pure selector can distinguish (registry seam, PROOF-3). */
export type GpuEntityModelKind = 'md2' | 'sp2' | 'tracer';

/** Base static generation for a freshly built scene (see note above). */
export const GPU_SCENE_GENERATION = 1;

/** Column-major identity 4x4 (transforms[0], the world-geometry slot). */
export function identityTransform(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

/**
 * Column-major 4x4 for one entity: translation + yaw rotation (Quake
 * conventions: yaw rotates in the XY plane about +Z, degrees). Pitch/roll
 * are deferred to PROOF-3; fixtures vary yaw only.
 */
export function entityTransform(origin: Vec3, yawDeg: number): Float32Array {
  const r = (yawDeg * Math.PI) / 180;
  const cy = Math.cos(r);
  const sy = Math.sin(r);
  const m = new Float32Array(16);
  // X column: forward (cy, sy, 0); Y column: (-sy, cy, 0); Z column: up.
  m[0] = cy; m[1] = sy; m[2] = 0; m[3] = 0;
  m[4] = -sy; m[5] = cy; m[6] = 0; m[7] = 0;
  m[8] = 0; m[9] = 0; m[10] = 1; m[11] = 0;
  m[12] = origin[0]!; m[13] = origin[1]!; m[14] = origin[2]!; m[15] = 1;
  return m;
}

/** Euclidean distance between two points (transparent blend-pass order). */
export function orderDistance(
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
): number {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function classifyWorldSurface(s: MiniSurf): { material: GpuMaterialKind; transparent: boolean } {
  if (s.sky) return { material: 'sky', transparent: false };
  if (s.turbulent) return { material: 'turbulent', transparent: false };
  const t = s.translucent ?? 0;
  if (t === 1 || t === 2) return { material: 'transparent', transparent: true };
  return { material: 'opaque', transparent: false };
}

function entityMaterial(
  kind: GpuEntityModelKind | undefined,
): GpuMaterialKind {
  if (kind === 'sp2') return 'sprite';
  if (kind === 'tracer') return 'beam';
  return 'alias';
}

/**
 * Resolve the camera PVS cluster, or -1 when no PVS row exists (camera
 * outside the root hull, empty tree, or solid-space leaf with cluster -1).
 * -1 disables PVS gating via clusterVisible (null cluster = visible).
 */
export function cameraCluster(world: MiniWorld, origin: Vec3): number {
  if (world.nodes.length > 0) {
    const root = world.nodes[0]!;
    if (
      origin[0]! < root.mins[0]! || origin[0]! > root.maxs[0]! ||
      origin[1]! < root.mins[1]! || origin[1]! > root.maxs[1]! ||
      origin[2]! < root.mins[2]! || origin[2]! > root.maxs[2]!
    ) {
      return -1;
    }
  }
  const leaf = findLeaf(world.nodes, origin);
  if (leaf < 0 || leaf >= world.leafs.length) return -1;
  return world.leafs[leaf]!.cluster;
}

/**
 * Build the persistent GPU scene input for one map + view. Pure:
 * GL-free, DOM-free, no renderer state. Per-scene-build garbage only.
 */
export function selectGpuScene(
  world: MiniWorld,
  entities: Entity[],
  view: RefDef,
  width: number,
  height: number,
  modelKinds?: ReadonlyMap<number, GpuEntityModelKind>,
): GpuSceneInput {
  const origin = view.origin;
  const cam = setupCamera(origin, view.angles, view.fovX, width, height);
  const ox = origin[0]!;
  const oy = origin[1]!;
  const oz = origin[2]!;
  const viewCluster = cameraCluster(world, origin);

  // PVS-visible leaf faceList union, deduped (per-build Set is fine).
  const seen = new Set<number>();
  for (const leaf of world.leafs) {
    if (!clusterVisible(world, viewCluster, leaf.cluster)) continue;
    const list = leaf.faceList;
    if (list) {
      for (let i = 0; i < list.length; i++) seen.add(list[i]!);
    } else {
      for (let i = 0; i < leaf.numSurfs; i++) seen.add(leaf.firstSurf + i);
    }
  }

  const opaque: GpuSurfaceRef[] = [];
  const transparent: GpuSurfaceRef[] = [];
  const ids = [...seen].sort((a, b) => a - b);
  for (const si of ids) {
    const s = world.surfaces[si];
    if (!s || s.n < 3) continue; // degenerate/NODRAW placeholder: no triangles
    if (culledByFrustum(cam, s.mins, s.maxs)) continue;
    const cls = classifyWorldSurface(s);
    if (cls.material === 'opaque') {
      // Backface: front faces the camera iff dot(fn, origin-center) > 0.
      const dx = s.center[0]! - ox;
      const dy = s.center[1]! - oy;
      const dz = s.center[2]! - oz;
      if (s.fn[0]! * dx + s.fn[1]! * dy + s.fn[2]! * dz >= 0) continue;
    }
    const ref: GpuSurfaceRef = {
      surfaceId: si,
      material: cls.material,
      materialHandle: cls.material === 'sky' ? -1 : s.texId,
      transparent: cls.transparent,
      order: cls.transparent
        ? orderDistance(s.center[0]!, s.center[1]!, s.center[2]!, ox, oy, oz)
        : 0,
      transformIndex: 0,
    };
    (cls.transparent ? transparent : opaque).push(ref);
  }

  // Entity refs: appended unconditionally (PROOF-2 does no entity culling).
  const transforms: Float32Array[] = [identityTransform()];
  const entityOpaque: GpuSurfaceRef[] = [];
  const entityTransparent: GpuSurfaceRef[] = [];
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]!;
    const material = entityMaterial(modelKinds?.get(e.model));
    const isTransparent = (e.alpha ?? 1) < 1;
    transforms.push(entityTransform(e.origin, e.angles[1]!));
    const ref: GpuSurfaceRef = {
      surfaceId: -1 - i, // entity refs carry no CPU surface id; index-stable slot
      material,
      materialHandle: e.skin,
      transparent: isTransparent,
      order: isTransparent
        ? orderDistance(e.origin[0]!, e.origin[1]!, e.origin[2]!, ox, oy, oz)
        : 0,
      transformIndex: transforms.length - 1,
    };
    (isTransparent ? entityTransparent : entityOpaque).push(ref);
  }

  // Opaque batch first (surface-id order, then entity order), transparent
  // blend pass sorted far -> near (larger order = farther).
  transparent.push(...entityTransparent);
  transparent.sort((a, b) => b.order - a.order);
  return {
    surfaces: [...opaque, ...entityOpaque, ...transparent],
    transforms,
    staticGeneration: GPU_SCENE_GENERATION,
  };
}
