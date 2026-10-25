// @q2/sw-renderer tracer — blaster-bolt / shotgun-pellet beam path.
// A 3D line segment drawn in index space with a 1/z depth test: project both
// endpoints, clip to the near plane, then DDA across screen pixels
// interpolating 1/z. The color is a raw palette index written directly (no
// colormap grade — beams are full-bright, the ref_soft "additive" look).
// Zero allocation: pure function of the handed planes.

import type { Camera } from './camera.js';

/** Default beam length in world units (entity `frame` overrides). */
export const TRACER_DEFAULT_LENGTH = 96;
/** Default beam color when the entity carries no palette index. */
export const TRACER_DEFAULT_COLOR = 225;
/** Screen-step cap: a beam never walks more pixels than this. */
export const TRACER_MAX_STEPS = 2048;
/** Renderer-owned tracer pool size (spawnTracer ring). */
export const TRACER_POOL_SIZE = 64;

/**
 * Draw a beam from a to b. Returns drawn pixel count. Writes nothing when
 * the segment is fully behind the near plane; occluded pixels fail the
 * depth test individually (the beam disappears behind walls correctly).
 */
export function drawTracerBeam(
  idx: Uint8Array,
  zb: Float32Array,
  fbW: number,
  fbH: number,
  cam: Camera,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  color: number,
): number {
  const c = color & 255;
  // To view space.
  const pax = ax - cam.origin[0]!, pay = ay - cam.origin[1]!, paz = az - cam.origin[2]!;
  const pbx = bx - cam.origin[0]!, pby = by - cam.origin[1]!, pbz = bz - cam.origin[2]!;
  const adx = pax * cam.right[0]! + pay * cam.right[1]! + paz * cam.right[2]!;
  const ady = pax * cam.up[0]! + pay * cam.up[1]! + paz * cam.up[2]!;
  const adz = pax * cam.forward[0]! + pay * cam.forward[1]! + paz * cam.forward[2]!;
  const bdx = pbx * cam.right[0]! + pby * cam.right[1]! + pbz * cam.right[2]!;
  const bdy = pbx * cam.up[0]! + pby * cam.up[1]! + pbz * cam.up[2]!;
  const bdz = pbx * cam.forward[0]! + pby * cam.forward[1]! + pbz * cam.forward[2]!;
  const near = cam.near;
  // Clip the segment to the near plane (depths along forward).
  let t0 = 0, t1 = 1;
  if (adz < near && bdz < near) return 0;
  if (adz < near) t0 = (near - adz) / (bdz - adz);
  else if (bdz < near) t1 = (near - adz) / (bdz - adz);
  // Interpolated view-space endpoints.
  const s0x = adx + (bdx - adx) * t0;
  const s0y = ady + (bdy - ady) * t0;
  const s0z = adz + (bdz - adz) * t0;
  const s1x = adx + (bdx - adx) * t1;
  const s1y = ady + (bdy - ady) * t1;
  const s1z = adz + (bdz - adz) * t1;
  const x0 = cam.xCenter + s0x * cam.focalX / s0z;
  const y0 = cam.yCenter - s0y * cam.focalY / s0z;
  const x1 = cam.xCenter + s1x * cam.focalX / s1z;
  const y1 = cam.yCenter - s1y * cam.focalY / s1z;
  const iz0 = 1 / s0z, iz1 = 1 / s1z;
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.min(TRACER_MAX_STEPS, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  if (steps <= 0) {
    // Sub-pixel beam: single depth-tested point.
    const x = Math.round(x0), y = Math.round(y0);
    if (x < 0 || y < 0 || x >= fbW || y >= fbH) return 0;
    const o = y * fbW + x;
    const iz = (iz0 + iz1) / 2;
    if (iz > zb[o]!) {
      zb[o] = iz;
      idx[o] = c;
      return 1;
    }
    return 0;
  }
  let drawn = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(x0 + dx * t), y = Math.round(y0 + dy * t);
    if (x < 0 || y < 0 || x >= fbW || y >= fbH) continue;
    const o = y * fbW + x;
    const iz = iz0 + (iz1 - iz0) * t;
    if (iz > zb[o]!) {
      zb[o] = iz;
      idx[o] = c;
      drawn++;
    }
  }
  return drawn;
}
