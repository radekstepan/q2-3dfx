// @q2/sw-renderer camera — R_SetupFrame / frustum (r_main.c equivalent).
// Quake conventions: +X forward, +Y left, +Z up; angles [pitch, yaw, roll]
// in degrees, pitch positive = down.

import { AngleVectors } from '@q2/math';

export interface Camera {
  origin: Float32Array;
  forward: Float32Array;
  right: Float32Array;
  up: Float32Array;
  xCenter: number;
  yCenter: number;
  focalX: number;
  focalY: number;
  near: number;
  /** Far plane (depth test limit). */
  far: number;
  /** 4 side planes + near, each {normal: Float32Array(3), dist} inward-facing */
  frustum: { normal: Float32Array; dist: number }[];
}

export function setupCamera(
  origin: Float32Array,
  angles: Float32Array,
  fovX: number,
  width: number,
  height: number,
  near = 4,
  far = 32768,
): Camera {
  const forward = new Float32Array(3);
  const right = new Float32Array(3);
  const up = new Float32Array(3);
  AngleVectors(angles, forward, right, up);
  const halfFovX = ((fovX * Math.PI) / 180) / 2;
  const tanX = Math.tan(halfFovX);
  const tanY = tanX * (height / width);
  const focalX = width / 2 / tanX;
  const focalY = height / 2 / tanY;
  const cam: Camera = {
    origin: new Float32Array(origin),
    forward, right, up,
    xCenter: width / 2 - 0.5,
    yCenter: height / 2 - 0.5,
    focalX, focalY, near,
    far: far > near ? far : 32768,
    frustum: [],
  };
  cam.frustum = buildFrustum(cam);
  return cam;
}

function planeFromPoints(normal: Float32Array, origin: Float32Array): { normal: Float32Array; dist: number } {
  const n = new Float32Array(3);
  const l = Math.hypot(normal[0]!, normal[1]!, normal[2]!) || 1;
  n[0] = normal[0]! / l; n[1] = normal[1]! / l; n[2] = normal[2]! / l;
  return { normal: n, dist: n[0]! * origin[0]! + n[1]! * origin[1]! + n[2]! * origin[2]! };
}

/** 4 inward-facing side planes through the camera origin + the near plane. */
export function buildFrustum(cam: Camera): { normal: Float32Array; dist: number }[] {
  const { forward: f, right: r, up: u, origin: o, near } = cam;
  const cross = (a: Float32Array, b: Float32Array): Float32Array => {
    const o2 = new Float32Array(3);
    o2[0] = a[1]! * b[2]! - a[2]! * b[1]!;
    o2[1] = a[2]! * b[0]! - a[0]! * b[2]!;
    o2[2] = a[0]! * b[1]! - a[1]! * b[0]!;
    return o2;
  };
  const ray = (rx: number, ry: number): Float32Array => {
    const d = new Float32Array(3);
    d[0] = f[0]! + r[0]! * rx + u[0]! * ry;
    d[1] = f[1]! + r[1]! * rx + u[1]! * ry;
    d[2] = f[2]! + r[2]! * rx + u[2]! * ry;
    return d;
  };
  // corner rays at distance 1 in view space
  const tx = (cam.xCenter + 0.5) / cam.focalX;
  const ty = (cam.yCenter + 0.5) / cam.focalY;
  const tl = ray(-tx, ty), tr = ray(tx, ty), bl = ray(-tx, -ty), br = ray(tx, -ty);
  // inward normals: cross products ordered so the normal points inside
  const top = cross(tl, tr);
  const bottom = cross(br, bl);
  const left = cross(bl, tl);
  const rightP = cross(tr, br);
  const planes = [
    planeFromPoints(top, o),
    planeFromPoints(bottom, o),
    planeFromPoints(left, o),
    planeFromPoints(rightP, o),
  ];
  const nn = new Float32Array(f);
  planes.push({ normal: nn, dist: nn[0]! * o[0]! + nn[1]! * o[1]! + nn[2]! * o[2]! + near });
  return planes;
}

/** 1 = front (inside), 2 = back (outside), 3 = spanning. */
export function boxOnFrustumSide(
  mins: Float32Array, maxs: Float32Array,
  normal: Float32Array, dist: number,
): 1 | 2 | 3 {
  let d1 = 0, d2 = 0;
  for (let i = 0; i < 3; i++) {
    const n = normal[i]!;
    if (n > 0) { d1 += n * maxs[i]!; d2 += n * mins[i]!; }
    else { d1 += n * mins[i]!; d2 += n * maxs[i]!; }
  }
  d1 -= dist; d2 -= dist;
  if (d1 >= 0 && d2 >= 0) return 1;
  if (d1 < 0 && d2 < 0) return 2;
  return 3;
}

/**
 * Flat-frustum cull (M8.1 hot path): the 5 planes packed as
 * [nx,ny,nz,dist]×5 in one Float64Array, hoisted once per frame by the
 * caller. Same arithmetic as culledByFrustum (inward normals, outside iff
 * both corners are behind the plane), without the per-surface/per-plane
 * object + Float32Array property chasing and call layers. Bit-identical:
 * the plane packing is exact (f64 stores of f32 values) and the corner
 * selection matches boxOnFrustumSide op-for-op.
 */
export function culledByFlatFrustum(
  fp: Float64Array, mins: Float32Array, maxs: Float32Array,
): boolean {
  const minx = mins[0]!, miny = mins[1]!, minz = mins[2]!;
  const maxx = maxs[0]!, maxy = maxs[1]!, maxz = maxs[2]!;
  for (let p = 0; p < 20; p += 4) {
    const nx = fp[p]!, ny = fp[p + 1]!, nz = fp[p + 2]!, dist = fp[p + 3]!;
    let d1: number, d2: number;
    if (nx > 0) { d1 = nx * maxx; d2 = nx * minx; } else { d1 = nx * minx; d2 = nx * maxx; }
    if (ny > 0) { d1 += ny * maxy; d2 += ny * miny; } else { d1 += ny * miny; d2 += ny * maxy; }
    if (nz > 0) { d1 += nz * maxz; d2 += nz * minz; } else { d1 += nz * minz; d2 += nz * maxz; }
    d1 -= dist; d2 -= dist;
    if (d1 < 0 && d2 < 0) return true;
  }
  return false;
}

/** True when the bbox is entirely outside any frustum plane. */
export function culledByFrustum(cam: Camera, mins: Float32Array, maxs: Float32Array): boolean {
  for (let i = 0; i < cam.frustum.length; i++) {
    const p = cam.frustum[i]!;
    if (boxOnFrustumSide(mins, maxs, p.normal, p.dist) === 2) return true;
  }
  return false;
}

/**
 * Refill a renderer-owned Camera in place (M8.1: setupCamera allocates ~20
 * small objects per frame — vectors, corner rays, plane records. Reusing one
 * Camera keeps the frame loop allocation-free). Bit-identical to
 * setupCamera: same angles, focals, plane normals (normalised the same way)
 * and distances. Never retains the caller's arrays (copies components).
 */
export function setupCameraInto(
  cam: Camera,
  origin: Float32Array,
  angles: Float32Array,
  fovX: number,
  width: number,
  height: number,
  near = 4,
  far = 32768,
): Camera {
  AngleVectors(angles, cam.forward, cam.right, cam.up);
  const halfFovX = ((fovX * Math.PI) / 180) / 2;
  const tanX = Math.tan(halfFovX);
  const tanY = tanX * (height / width);
  cam.origin[0] = origin[0]!; cam.origin[1] = origin[1]!; cam.origin[2] = origin[2]!;
  cam.xCenter = width / 2 - 0.5;
  cam.yCenter = height / 2 - 0.5;
  cam.focalX = width / 2 / tanX;
  cam.focalY = height / 2 / tanY;
  cam.near = near;
  cam.far = far > near ? far : 32768;
  const tx = (cam.xCenter + 0.5) / cam.focalX;
  const ty = (cam.yCenter + 0.5) / cam.focalY;
  const f = cam.forward, r = cam.right, u = cam.up, o = cam.origin;
  // Corner rays at distance 1 in view space (matches buildFrustum order).
  // Components are f32-rounded exactly like buildFrustum's ray(), which
  // returns a Float32Array: Math.fround is bit-identical to that store.
  const F = Math.fround;
  const tlx = F(f[0]! + r[0]! * -tx + u[0]! * ty);
  const tly = F(f[1]! + r[1]! * -tx + u[1]! * ty);
  const tlz = F(f[2]! + r[2]! * -tx + u[2]! * ty);
  const trx = F(f[0]! + r[0]! * tx + u[0]! * ty);
  const try_ = F(f[1]! + r[1]! * tx + u[1]! * ty);
  const trz = F(f[2]! + r[2]! * tx + u[2]! * ty);
  const blx = F(f[0]! + r[0]! * -tx + u[0]! * -ty);
  const bly = F(f[1]! + r[1]! * -tx + u[1]! * -ty);
  const blz = F(f[2]! + r[2]! * -tx + u[2]! * -ty);
  const brx = F(f[0]! + r[0]! * tx + u[0]! * -ty);
  const bry = F(f[1]! + r[1]! * tx + u[1]! * -ty);
  const brz = F(f[2]! + r[2]! * tx + u[2]! * -ty);
  // Inward normals: same cross products as buildFrustum, written in place
  // (top = tl x tr, bottom = br x bl, left = bl x tl, right = tr x br).
  // Cross results are f32-rounded like buildFrustum's cross() output array.
  while (cam.frustum.length < 5) cam.frustum.push({ normal: new Float32Array(3), dist: 0 });
  setPlane(cam.frustum[0]!,
    F(tly * trz - tlz * try_), F(tlz * trx - tlx * trz), F(tlx * try_ - tly * trx), o);
  setPlane(cam.frustum[1]!,
    F(bry * blz - brz * bly), F(brz * blx - brx * blz), F(brx * bly - bry * blx), o);
  setPlane(cam.frustum[2]!,
    F(bly * tlz - blz * tly), F(blz * tlx - blx * tlz), F(blx * tly - bly * tlx), o);
  setPlane(cam.frustum[3]!,
    F(try_ * brz - trz * bry), F(trz * brx - trx * brz), F(trx * bry - try_ * brx), o);
  const nn = cam.frustum[4]!;
  nn.normal[0] = f[0]!; nn.normal[1] = f[1]!; nn.normal[2] = f[2]!;
  nn.dist = f[0]! * o[0]! + f[1]! * o[1]! + f[2]! * o[2]! + near;
  return cam;
}

/** Normalise (x, y, z) into a plane record through the camera origin.
 *  Matches planeFromPoints exactly: the normal is f32-rounded on store and
 *  the distance is computed from the STORED normal, not the f64 quotient. */
function setPlane(
  p: { normal: Float32Array; dist: number },
  x: number, y: number, z: number, o: Float32Array,
): void {
  const l = Math.hypot(x, y, z) || 1;
  p.normal[0] = x / l; p.normal[1] = y / l; p.normal[2] = z / l;
  p.dist = p.normal[0]! * o[0]! + p.normal[1]! * o[1]! + p.normal[2]! * o[2]!;
}
