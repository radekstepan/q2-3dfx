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

/** True when the bbox is entirely outside any frustum plane. */
export function culledByFrustum(cam: Camera, mins: Float32Array, maxs: Float32Array): boolean {
  for (let i = 0; i < cam.frustum.length; i++) {
    const p = cam.frustum[i]!;
    if (boxOnFrustumSide(mins, maxs, p.normal, p.dist) === 2) return true;
  }
  return false;
}
