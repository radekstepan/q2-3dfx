// @q2/math — vec3/mat4/angles/plane/fixed-point, Q2 conventions.
// +X forward, +Y left, +Z up. Angles [pitch, yaw, roll] in degrees, pitch positive = down.
// Full port + 100% AngleVectors coverage is M1.1's job; this is the contract surface.
export type Vec3 = Float32Array; // length 3

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return new Float32Array([x, y, z]);
}

export function v3copy(a: Vec3): Vec3 {
  return new Float32Array(a);
}

export function dot(a: Vec3 | Float32Array, b: Vec3 | Float32Array): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

export function cross(a: Vec3, b: Vec3, out?: Vec3): Vec3 {
  const o = out ?? v3();
  o[0] = a[1]! * b[2]! - a[2]! * b[1]!;
  o[1] = a[2]! * b[0]! - a[0]! * b[2]!;
  o[2] = a[0]! * b[1]! - a[1]! * b[0]!;
  return o;
}

export function normalize(a: Vec3, out?: Vec3): Vec3 {
  const o = out ?? v3();
  const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1;
  o[0] = a[0]! / l; o[1] = a[1]! / l; o[2] = a[2]! / l;
  return o;
}

/** id's AngleVectors. angles=[pitch,yaw,roll] degrees. */
export function AngleVectors(angles: Vec3 | Float32Array, forward?: Vec3, right?: Vec3, up?: Vec3): void {
  const pitch = ((angles[0]! * Math.PI) / 180);
  const yaw = ((angles[1]! * Math.PI) / 180);
  const roll = ((angles[2]! * Math.PI) / 180);
  const sp = Math.sin(pitch), cp = Math.cos(pitch);
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const sr = Math.sin(roll), cr = Math.cos(roll);
  if (forward) { forward[0] = cp * cy; forward[1] = cp * sy; forward[2] = -sp; }
  if (right) { right[0] = -sr * sp * cy + cr * sy; right[1] = -sr * sp * sy - cr * cy; right[2] = -sr * cp; }
  if (up) { up[0] = cr * sp * cy + sr * sy; up[1] = cr * sp * sy - sr * cy; up[2] = cr * cp; }
}

/** id's BoxOnPlaneSide: 1 front, 2 back, 3 spanning. */
export function BoxOnPlaneSide(mins: Vec3 | Float32Array, maxs: Vec3 | Float32Array, normal: Vec3 | Float32Array, dist: number): 1 | 2 | 3 {
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

// --- 16.16 fixed point (d_scan.c) ---
export const FIX_SHIFT = 16;
export const FIX_ONE = 1 << FIX_SHIFT;
export function floatToFix(x: number): number { return (x * FIX_ONE) | 0; }
export function fixToFloat(x: number): number { return x / FIX_ONE; }
export function fixMul(a: number, b: number): number { return ((a * b) / FIX_ONE) | 0; }
