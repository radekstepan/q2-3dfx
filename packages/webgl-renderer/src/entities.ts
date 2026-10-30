// @q2/webgl-renderer entities — per-frame entity dynamics (GPU-PROOF-3).
//
// Pure, GL-free: updateGpuEntities refreshes ONLY the entity-ref tail of a
// scene (world refs are reused by reference — static geometry is never
// rebuilt). Per-frame garbage is small and documented: one surfaces array
// plus one ref per entity plus the transparent sort (in-place on the fresh
// array). Static world refs/buffers are untouched per frame.
//
// The yaw-only scene transforms are NOT consumed by the GPU renderer: model
// matrices are derived per frame from the entities (full pitch/yaw/roll
// basis, buildEntityModel) because alias interpolation needs the entity
// frame/backlerp/angles anyway.
//
// Billboards (sprites/beams) and particle points are computed on the CPU
// per frame into one dynamic batch with per-vertex color/alpha:
//   - sprites: camera-facing quads (right/up basis, 48x48 world units — the
//     CPU SpriteDef), textured with the registered skin;
//   - beams: camera-facing strips along the tracer segment (contract-free
//     beam convention: origin = start, angles = direction, frame = length,
//     skin = palette index). The CPU draws a 1px DDA line with core+glow;
//     the GPU draws one flat quad widened to ~1.5px (documented approx);
//   - particles: gl.POINTS of size 1 (the only guaranteed point size),
//     depth-tested, palette-expanded on the CPU.

import type {
  Entity,
  GpuMaterialKind,
  GpuSceneInput,
  GpuSurfaceRef,
  RefDef,
} from '@q2/renderer-api';
import { AngleVectors } from '@q2/math';
import {
  TRACER_CORE_COLOR,
  TRACER_DEFAULT_COLOR,
  TRACER_DEFAULT_LENGTH,
  type Camera,
  type MiniWorld,
} from '@q2/sw-renderer';
import {
  orderDistance,
  type GpuEntityModelKind,
} from './scene.js';

/** World-space sprite size (matches the CPU SpriteDef 48x48). */
export const GPU_SPRITE_SIZE = 48;
/** Beam quad width in pixels (CPU draws a 1px DDA line; ~1.5px reads the same). */
export const GPU_BEAM_WIDTH_PX = 1.5;

/**
 * Refresh the entity-ref tail of a scene. World refs (transformIndex 0)
 * are reused by reference; entity refs are rebuilt from (entities, view)
 * with the same classification the selector uses (kind from modelKinds,
 * transparent bit from alpha, order = camera distance, blend tail sorted
 * far->near). Returns the full surfaces array.
 */
export function updateGpuEntities(
  scene: GpuSceneInput,
  entities: Entity[],
  view: RefDef,
  modelKinds?: ReadonlyMap<number, GpuEntityModelKind>,
): GpuSurfaceRef[] {
  const ox = view.origin[0]!;
  const oy = view.origin[1]!;
  const oz = view.origin[2]!;
  const worldOpaque: GpuSurfaceRef[] = [];
  const worldTransparent: GpuSurfaceRef[] = [];
  for (const ref of scene.surfaces) {
    if (ref.transformIndex !== 0) continue;
    (ref.transparent ? worldTransparent : worldOpaque).push(ref);
  }
  const entityOpaque: GpuSurfaceRef[] = [];
  const entityTransparent: GpuSurfaceRef[] = [];
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]!;
    const k = modelKinds?.get(e.model);
    const material: GpuMaterialKind = k === 'sp2' ? 'sprite' : k === 'tracer' ? 'beam' : 'alias';
    const isTransparent = (e.alpha ?? 1) < 1;
    // transformIndex 1+i matches the selector layout (identity + yaw-only
    // entity slots); the GPU renderer derives full-basis model matrices
    // from the entities instead of consuming these.
    const ref: GpuSurfaceRef = {
      surfaceId: -1 - i,
      material,
      materialHandle: e.skin,
      transparent: isTransparent,
      order: isTransparent
        ? orderDistance(e.origin[0]!, e.origin[1]!, e.origin[2]!, ox, oy, oz)
        : 0,
      transformIndex: 1 + i,
    };
    (isTransparent ? entityTransparent : entityOpaque).push(ref);
  }
  const blend = [...worldTransparent, ...entityTransparent];
  blend.sort((a, b) => b.order - a.order);
  return [...worldOpaque, ...entityOpaque, ...blend];
}

/** Scratch basis vectors for beam direction (module-scope, reused). */
const beamFwd = new Float32Array(3);
const beamRight = new Float32Array(3);
const beamUp = new Float32Array(3);

/**
 * Resolve the contract-free beam convention for one tracer entity:
 * segment start/end in world space + palette color index.
 */
export function resolveBeam(
  e: Entity,
): { ax: number; ay: number; az: number; bx: number; by: number; bz: number; color: number } {
  AngleVectors(e.angles, beamFwd, beamRight, beamUp);
  const len = e.frame > 0 ? Math.min(e.frame, 1024) : TRACER_DEFAULT_LENGTH;
  const color = e.skin >= 0 && e.skin <= 255 ? e.skin & 255 : TRACER_DEFAULT_COLOR;
  return {
    ax: e.origin[0]!,
    ay: e.origin[1]!,
    az: e.origin[2]!,
    bx: e.origin[0]! + beamFwd[0]! * len,
    by: e.origin[1]! + beamFwd[1]! * len,
    bz: e.origin[2]! + beamFwd[2]! * len,
    color,
  };
}

/** Core beam color (matches the CPU TRACER_CORE_COLOR). */
export const GPU_BEAM_CORE = TRACER_CORE_COLOR;

export interface FlatBatch {
  /** xyz per vert */
  pos: number[];
  /** rgba per vert */
  col: number[];
  /** uv per vert (sprites only; 0 for beams) */
  uv: number[];
  /** indices into the batch verts */
  idx: number[];
}

/** New empty flat batch accumulator. */
export function emptyFlatBatch(): FlatBatch {
  return { pos: [], col: [], uv: [], idx: [] };
}

/**
 * Emit one camera-facing sprite quad (two tris) into the batch. UVs span
 * 0..1 over the skin; color is the palette-expanded RGB + alpha.
 */
export function emitSpriteQuad(
  b: FlatBatch,
  origin: Float32Array,
  cam: Camera,
  skinW: number,
  skinH: number,
  r: number,
  g: number,
  blue: number,
  alpha: number,
  size = GPU_SPRITE_SIZE,
): void {
  void skinW;
  void skinH;
  const hw = size / 2;
  const hh = size / 2;
  const cx = origin[0]!;
  const cy = origin[1]!;
  const cz = origin[2]!;
  const rx = cam.right[0]!;
  const ry = cam.right[1]!;
  const rz = cam.right[2]!;
  const ux = cam.up[0]!;
  const uy = cam.up[1]!;
  const uz = cam.up[2]!;
  const base = b.pos.length / 3;
  // Corners: (-hw,+hh) top-left .. GL y-up; UV v=0 is the texel row 0.
  const corners: Array<[number, number, number, number]> = [
    [-hw, hh, 0, 0],
    [hw, hh, 1, 0],
    [hw, -hh, 1, 1],
    [-hw, -hh, 0, 1],
  ];
  for (const [dx, dy, u, v] of corners) {
    b.pos.push(cx + rx * dx + ux * dy, cy + ry * dx + uy * dy, cz + rz * dx + uz * dy);
    b.col.push(r, g, blue, alpha);
    b.uv.push(u, v);
  }
  b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * Emit one camera-facing beam strip (two tris) into the batch. The strip
 * side is normalize(cross(dir, viewDir)) widened so the strip covers
 * ~GPU_BEAM_WIDTH_PX pixels at the segment midpoint depth. Untextured
 * (uv 0); color is the palette-expanded beam color, alpha 1.
 */
export function emitBeamQuad(
  b: FlatBatch,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cam: Camera,
  r: number,
  g: number,
  blue: number,
  alpha: number,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  const mx = (ax + bx) / 2 - cam.origin[0]!;
  const my = (ay + by) / 2 - cam.origin[1]!;
  const mz = (az + bz) / 2 - cam.origin[2]!;
  const dist = Math.hypot(mx, my, mz) || 1;
  // View direction at the midpoint (camera basis, normalized).
  const vx = mx / dist;
  const vy = my / dist;
  const vz = mz / dist;
  // side = normalize(cross(dir, viewDir)); degenerate (parallel) -> right.
  let sx = uy * vz - uz * vy;
  let sy = uz * vx - ux * vz;
  let sz = ux * vy - uy * vx;
  let sl = Math.hypot(sx, sy, sz);
  if (sl < 1e-6) {
    sx = cam.right[0]!;
    sy = cam.right[1]!;
    sz = cam.right[2]!;
    sl = 1;
  }
  const halfW = ((GPU_BEAM_WIDTH_PX * dist) / cam.focalX / 2) / sl;
  const ox = sx * halfW;
  const oy = sy * halfW;
  const oz = sz * halfW;
  const base = b.pos.length / 3;
  b.pos.push(ax - ox, ay - oy, az - oz, ax + ox, ay + oy, az + oz, bx + ox, by + oy, bz + oz, bx - ox, by - oy, bz - oz);
  for (let i = 0; i < 4; i++) {
    b.col.push(r, g, blue, alpha);
    b.uv.push(0, 0);
  }
  b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * Collect world-space particle points (depth-tested POINTS on the GPU).
 * Colors are palette-expanded on the CPU (12-spark clouds: trivial cost).
 */
export function collectParticlePoints(
  world: MiniWorld,
  palette: Uint8Array,
): { positions: Float32Array; colors: Float32Array } {
  const n = Math.min(world.particles.length, 256);
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = world.particles[i]!;
    positions[i * 3] = p.origin[0]!;
    positions[i * 3 + 1] = p.origin[1]!;
    positions[i * 3 + 2] = p.origin[2]!;
    const c = (p.color & 255) * 3;
    colors[i * 4] = (palette[c] ?? 0) / 255;
    colors[i * 4 + 1] = (palette[c + 1] ?? 0) / 255;
    colors[i * 4 + 2] = (palette[c + 2] ?? 0) / 255;
    colors[i * 4 + 3] = 1;
  }
  return { positions, colors };
}
