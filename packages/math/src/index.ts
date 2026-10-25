// @q2/math — vec3/mat4/angles/plane/fixed-point, Q2 conventions.
//
// Coordinate system (§5): +X forward, +Y left, +Z up. 1 unit ≈ 1 inch.
// Angles are [pitch, yaw, roll] in degrees, pitch positive = down.
//
// Ports quake-2 `game/q_shared.c` (AngleVectors, BoxOnPlaneSide, LerpAngle,
// anglemod, ProjectPointOnPlane, PerpendicularVector, RotatePointAroundVector),
// `qcommon/qfiles.h` plane types, and `ref_soft/r_misc.c` view/frustum setup
// (R_SetupFrame, R_ViewChanged, R_TransformFrustum). ref_gl uses the same
// basis through its own glRotatef chain.
//
// Layout: Mat4 is column-major Float32Array(16) (OpenGL/ref_gl convention:
// m[col*4+row]). The view matrix (m4view) and frustum (FrustumFromView) live
// in Q2 *view space*: x = dot(d, right), y = dot(d, up), z = dot(d, forward),
// i.e. id's TransformVector, NOT OpenGL eye space. See each function.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Degrees → radians multiplier. */
export const DEG2RAD = Math.PI / 180;

/** Lightmap luxels are every 16 texels (§5). Mirrors @q2/config LUXEL. */
export const LUXEL = 16;

// BSP plane types (qcommon/qfiles.h): 0-2 axial, 3-5 non-axial (dominant axis).
export const PLANE_X = 0;
export const PLANE_Y = 1;
export const PLANE_Z = 2;
export const PLANE_ANYX = 3;
export const PLANE_ANYY = 4;
export const PLANE_ANYZ = 5;

// ---------------------------------------------------------------------------
// Vec3
// ---------------------------------------------------------------------------

/** 3-component vector. Always a Float32Array of length 3, never an object. */
export type Vec3 = Float32Array; // length 3

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return new Float32Array([x, y, z]);
}

/** Write components into an existing vector (no allocation). */
export function v3set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

/** Allocating copy: out = a. */
export function v3copy(a: Vec3): Vec3 {
  return new Float32Array(a);
}

/** Copy src into existing dst (no allocation). Returns dst. */
export function v3copyTo(src: Vec3, dst: Vec3): Vec3 {
  dst[0] = src[0]; dst[1] = src[1]; dst[2] = src[2];
  return dst;
}

/** out = a + b (id VectorAdd). */
export function v3add(a: Vec3, b: Vec3, out?: Vec3): Vec3 {
  const o = out ?? v3();
  o[0] = a[0]! + b[0]!; o[1] = a[1]! + b[1]!; o[2] = a[2]! + b[2]!;
  return o;
}

/** out = a - b (id VectorSubtract). */
export function v3sub(a: Vec3, b: Vec3, out?: Vec3): Vec3 {
  const o = out ?? v3();
  o[0] = a[0]! - b[0]!; o[1] = a[1]! - b[1]!; o[2] = a[2]! - b[2]!;
  return o;
}

/** out = a * s (id VectorScale). */
export function v3scale(a: Vec3, s: number, out?: Vec3): Vec3 {
  const o = out ?? v3();
  o[0] = a[0]! * s; o[1] = a[1]! * s; o[2] = a[2]! * s;
  return o;
}

/** out = a + scale * b (id VectorMA). */
export function v3ma(a: Vec3, scale: number, b: Vec3, out?: Vec3): Vec3 {
  const o = out ?? v3();
  o[0] = a[0]! + scale * b[0]!;
  o[1] = a[1]! + scale * b[1]!;
  o[2] = a[2]! + scale * b[2]!;
  return o;
}

/** out = -a (id VectorNegate). */
export function v3negate(a: Vec3, out?: Vec3): Vec3 {
  const o = out ?? v3();
  o[0] = -a[0]!; o[1] = -a[1]!; o[2] = -a[2]!;
  return o;
}

/** Zero all components in place (id VectorClear). Returns v. */
export function v3clear(v: Vec3): Vec3 {
  v[0] = 0; v[1] = 0; v[2] = 0;
  return v;
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

/** Squared length (avoids sqrt for comparisons). */
export function v3lengthSq(a: Vec3): number {
  return a[0]! * a[0]! + a[1]! * a[1]! + a[2]! * a[2]!;
}

export function normalize(a: Vec3, out?: Vec3): Vec3 {
  const o = out ?? v3();
  const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1;
  o[0] = a[0]! / l; o[1] = a[1]! / l; o[2] = a[2]! / l;
  return o;
}

/** Euclidean length (id VectorLength). */
export function v3length(a: Vec3): number {
  return Math.hypot(a[0]!, a[1]!, a[2]!);
}

/** Distance between two points. */
export function v3dist(a: Vec3, b: Vec3): number {
  const dx = a[0]! - b[0]!, dy = a[1]! - b[1]!, dz = a[2]! - b[2]!;
  return Math.hypot(dx, dy, dz);
}

/** Component-wise equality within eps (default 1e-6). */
export function v3equals(a: Vec3, b: Vec3, eps = 1e-6): boolean {
  return (
    Math.abs(a[0]! - b[0]!) <= eps &&
    Math.abs(a[1]! - b[1]!) <= eps &&
    Math.abs(a[2]! - b[2]!) <= eps
  );
}

// ---------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------

/**
 * id's AngleVectors. angles=[pitch,yaw,roll] degrees, pitch positive = down.
 * Any of forward/right/up may be omitted (pass undefined).
 */
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

/** id's anglemod: wrap to [0, 360). */
export function anglemod(a: number): number {
  return (360.0 / 65536) * (Math.trunc(a * (65536 / 360.0)) & 65535);
}

/** id's LerpAngle: shortest-arc interpolation. Note arg order (a2, a1, frac). */
export function lerpAngle(a2: number, a1: number, frac: number): number {
  let from = a1;
  if (from - a2 > 180) from -= 360;
  if (from - a2 < -180) from += 360;
  return a2 + frac * (from - a2);
}

/**
 * Direction → [pitch, yaw, 0] in Q2 conventions (pitch positive = down,
 * yaw in [0, 360)). Inverse of AngleVectors for the forward vector.
 */
export function dirToAngles(dir: Vec3, out?: Vec3): Vec3 {
  const o = out ?? v3();
  const xy = Math.hypot(dir[0]!, dir[1]!);
  let yaw = Math.atan2(dir[1]!, dir[0]!) / DEG2RAD;
  if (yaw < 0) yaw += 360;
  o[0] = Math.atan2(-dir[2]!, xy) / DEG2RAD;
  o[1] = yaw;
  o[2] = 0;
  return o;
}

/**
 * id's ProjectPointOnPlane. out = p projected onto the plane through the
 * origin with the given (not necessarily unit) normal. Handles non-unit
 * normals via the inverse-denominator scaling, exactly like the C version.
 */
export function PlanePoint(point: Vec3, normal: Vec3, out?: Vec3): Vec3 {
  const o = out ?? v3();
  const invDenom = 1.0 / dot(normal, normal);
  const d = dot(normal, point) * invDenom;
  const nx = normal[0]! * invDenom;
  const ny = normal[1]! * invDenom;
  const nz = normal[2]! * invDenom;
  o[0] = point[0]! - d * nx;
  o[1] = point[1]! - d * ny;
  o[2] = point[2]! - d * nz;
  return o;
}

/**
 * id's PerpendicularVector. Returns a unit vector perpendicular to src.
 * src should be normalized (as in the C code).
 */
export function perpendicularVector(src: Vec3, out?: Vec3): Vec3 {
  const o = out ?? v3();
  // Find the smallest-magnitude axially aligned vector.
  let pos = 0;
  let minelem = 1.0;
  for (let i = 0; i < 3; i++) {
    const v = Math.abs(src[i]!);
    if (v < minelem) {
      pos = i;
      minelem = v;
    }
  }
  const tmp = v3();
  tmp[pos] = 1.0;
  PlanePoint(tmp, src, o);
  return normalize(o, o);
}

/** 3x3 rotation concatenation (id R_ConcatRotations). out = a * b. */
function concatRot3(a: Float32Array, b: Float32Array, out: Float32Array): Float32Array {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return out;
}

/**
 * id's RotatePointAroundVector. Rotates point around the unit axis dir by
 * degrees (right-hand rule). out = rotated point.
 */
export function rotatePointAroundVector(dir: Vec3, point: Vec3, degrees: number, out?: Vec3): Vec3 {
  const o = out ?? v3();
  const vr = perpendicularVector(dir);
  const vup = cross(vr, dir);
  const vf = v3copy(dir);
  // m rows: [vr, vup, vf]
  const m = new Float32Array([vr[0], vup[0], vf[0], vr[1], vup[1], vf[1], vr[2], vup[2], vf[2]]);
  // im = transpose(m)
  const im = new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
  const rad = degrees * DEG2RAD;
  const c = Math.cos(rad), s = Math.sin(rad);
  const zrot = new Float32Array([c, s, 0, -s, c, 0, 0, 0, 1]);
  const tmp = concatRot3(m, zrot, new Float32Array(9));
  const rot = concatRot3(tmp, im, new Float32Array(9));
  o[0] = rot[0]! * point[0]! + rot[1]! * point[1]! + rot[2]! * point[2]!;
  o[1] = rot[3]! * point[0]! + rot[4]! * point[1]! + rot[5]! * point[2]!;
  o[2] = rot[6]! * point[0]! + rot[7]! * point[1]! + rot[8]! * point[2]!;
  return o;
}

// ---------------------------------------------------------------------------
// Mat4 — column-major (OpenGL/ref_gl convention: m[col*4+row])
// ---------------------------------------------------------------------------

/** 4x4 matrix, column-major Float32Array(16). View space is Q2 view space. */
export type Mat4 = Float32Array; // length 16

/** Identity matrix. Writes into out if given (no allocation). */
export function m4identity(out?: Mat4): Mat4 {
  const o = out ?? new Float32Array(16);
  o[0] = 1; o[1] = 0; o[2] = 0; o[3] = 0;
  o[4] = 0; o[5] = 1; o[6] = 0; o[7] = 0;
  o[8] = 0; o[9] = 0; o[10] = 1; o[11] = 0;
  o[12] = 0; o[13] = 0; o[14] = 0; o[15] = 1;
  return o;
}

/** out = a * b (column-vector convention). Safe for in-place (out===a/b). */
export function m4multiply(a: Mat4, b: Mat4, out?: Mat4): Mat4 {
  const o = out ?? new Float32Array(16);
  const tmp = out === undefined || out === a || out === b ? new Float32Array(16) : out;
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      tmp[c * 4 + r] =
        a[r]! * b[c * 4]! +
        a[4 + r]! * b[c * 4 + 1]! +
        a[8 + r]! * b[c * 4 + 2]! +
        a[12 + r]! * b[c * 4 + 3]!;
    }
  }
  if (tmp !== o) o.set(tmp);
  return o;
}

/**
 * Standard OpenGL perspective matrix (fovY in degrees, maps z to NDC [-1,1]).
 * Requires 0 < near < far. Column-major.
 */
export function m4perspective(fovYDeg: number, aspect: number, near: number, far: number, out?: Mat4): Mat4 {
  const o = out ?? new Float32Array(16);
  const f = 1 / Math.tan((fovYDeg * DEG2RAD) / 2);
  o[0] = f / aspect; o[1] = 0; o[2] = 0; o[3] = 0;
  o[4] = 0; o[5] = f; o[6] = 0; o[7] = 0;
  o[8] = 0; o[9] = 0; o[10] = (far + near) / (near - far); o[11] = -1;
  o[12] = 0; o[13] = 0; o[14] = (2 * far * near) / (near - far); o[15] = 0;
  return o;
}

/**
 * View matrix matching Q2's ref setup (R_SetupFrame): derived from the
 * camera origin + [pitch,yaw,roll] via AngleVectors. Result maps world
 * points into Q2 view space (x=right, y=up, z=forward — id TransformVector),
 * i.e. out * (p,1) = (dot(p-origin,right), dot(p-origin,up),
 * dot(p-origin,forward), 1). NOT OpenGL eye space.
 */
export function m4view(origin: Vec3, angles: Vec3, out?: Mat4): Mat4 {
  const o = out ?? new Float32Array(16);
  const pitch = angles[0]! * DEG2RAD;
  const yaw = angles[1]! * DEG2RAD;
  const roll = angles[2]! * DEG2RAD;
  const sp = Math.sin(pitch), cp = Math.cos(pitch);
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const sr = Math.sin(roll), cr = Math.cos(roll);
  // Same basis as AngleVectors, inlined so this allocates nothing but out.
  const fx = cp * cy, fy = cp * sy, fz = -sp;
  const rx = -sr * sp * cy + cr * sy;
  const ry = -sr * sp * sy - cr * cy;
  const rz = -sr * cp;
  const ux = cr * sp * cy + sr * sy;
  const uy = cr * sp * sy - sr * cy;
  const uz = cr * cp;
  o[0] = rx; o[1] = ux; o[2] = fx; o[3] = 0;
  o[4] = ry; o[5] = uy; o[6] = fy; o[7] = 0;
  o[8] = rz; o[9] = uz; o[10] = fz; o[11] = 0;
  o[12] = -(origin[0]! * rx + origin[1]! * ry + origin[2]! * rz);
  o[13] = -(origin[0]! * ux + origin[1]! * uy + origin[2]! * uz);
  o[14] = -(origin[0]! * fx + origin[1]! * fy + origin[2]! * fz);
  o[15] = 1;
  return o;
}

/** Transform a point (w=1, perspective divide). Requires w != 0. */
export function m4transformPoint(m: Mat4, p: Vec3, out?: Vec3): Vec3 {
  const o = out ?? v3();
  const x = p[0]!, y = p[1]!, z = p[2]!;
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  const iw = 1 / w;
  o[0] = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) * iw;
  o[1] = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) * iw;
  o[2] = (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) * iw;
  return o;
}

/** Transform a direction (rotation only: ignores translation, no divide). */
export function m4transformDir(m: Mat4, d: Vec3, out?: Vec3): Vec3 {
  const o = out ?? v3();
  const x = d[0]!, y = d[1]!, z = d[2]!;
  o[0] = m[0]! * x + m[4]! * y + m[8]! * z;
  o[1] = m[1]! * x + m[5]! * y + m[9]! * z;
  o[2] = m[2]! * x + m[6]! * y + m[10]! * z;
  return o;
}

// ---------------------------------------------------------------------------
// Planes — id cplane_t: dot(p, normal) = dist, inward-facing for frustums
// ---------------------------------------------------------------------------

/** Plane with precomputed axial type + signbits for fast side tests. */
export interface Plane {
  /** Unit-length normal. */
  normal: Vec3;
  /** Plane offset: dot(p, normal) = dist. */
  dist: number;
  /** 0/1/2 axial, else 3 + dominant axis (qfiles.h PLANE_*). */
  type: number;
  /** Bit j set when normal[j] < 0 (CM_LoadMapPlanes). */
  signbits: number;
}

/** signbits for a normal: bit j set iff normal[j] < 0. */
export function planeSignbits(normal: Vec3): number {
  return (
    (normal[0]! < 0 ? 1 : 0) |
    (normal[1]! < 0 ? 2 : 0) |
    (normal[2]! < 0 ? 4 : 0)
  );
}

/**
 * Axial type 0/1/2 when the normal is exactly a unit axis, else 3 +
 * dominant-axis index. Ties resolve to the first (lowest) axis.
 */
export function planeTypeForNormal(normal: Vec3): number {
  const nx = normal[0]!, ny = normal[1]!, nz = normal[2]!;
  if ((nx === 1 || nx === -1) && ny === 0 && nz === 0) return PLANE_X;
  if ((ny === 1 || ny === -1) && nx === 0 && nz === 0) return PLANE_Y;
  if ((nz === 1 || nz === -1) && nx === 0 && ny === 0) return PLANE_Z;
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (ax >= ay && ax >= az) return PLANE_ANYX;
  if (ay >= az) return PLANE_ANYY;
  return PLANE_ANYZ;
}

/** Build a Plane from a (unit-length) normal + dist. Copies the normal. */
export function makePlane(normal: Vec3, dist: number, out?: Plane): Plane {
  const n = out?.normal ?? v3();
  v3copyTo(normal, n);
  const plane: Plane = out ?? { normal: n, dist, type: 0, signbits: 0 };
  plane.normal = n;
  plane.dist = dist;
  plane.type = planeTypeForNormal(n);
  plane.signbits = planeSignbits(n);
  return plane;
}

/**
 * Signed distance from point to plane (Q1 PlaneDiff + axial fast path from
 * CM_* point tests). >= 0 is front/inside.
 */
export function PlaneDiff(point: Vec3, plane: Plane): number {
  if (plane.type < 3) return point[plane.type]! - plane.dist;
  return dot(point, plane.normal) - plane.dist;
}

/**
 * id's BoxOnPlaneSide (slow general version): 1 = front, 2 = back,
 * 3 = spanning. Kept signature-compatible; Plane-based callers use boxOnPlane.
 */
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

/**
 * Fast BoxOnPlaneSide for a classified Plane: axial fast path from the
 * BOX_ON_PLANE_SIDE macro plus the signbits switch from the C general case.
 * 1 = front, 2 = back, 3 = spanning.
 */
export function boxOnPlane(mins: Vec3, maxs: Vec3, plane: Plane): 1 | 2 | 3 {
  // Fast axial cases (BOX_ON_PLANE_SIDE).
  if (plane.type < 3) {
    if (plane.dist <= mins[plane.type]!) return 1;
    if (plane.dist >= maxs[plane.type]!) return 2;
    return 3;
  }
  // General case: pick near/far corners by signbits (q_shared.c BoxOnPlaneSide).
  const nx = plane.normal[0]!, ny = plane.normal[1]!, nz = plane.normal[2]!;
  const minx = mins[0]!, miny = mins[1]!, minz = mins[2]!;
  const maxx = maxs[0]!, maxy = maxs[1]!, maxz = maxs[2]!;
  let dist1: number, dist2: number;
  switch (plane.signbits) {
    case 0: dist1 = nx * maxx + ny * maxy + nz * maxz; dist2 = nx * minx + ny * miny + nz * minz; break;
    case 1: dist1 = nx * minx + ny * maxy + nz * maxz; dist2 = nx * maxx + ny * miny + nz * minz; break;
    case 2: dist1 = nx * maxx + ny * miny + nz * maxz; dist2 = nx * minx + ny * maxy + nz * minz; break;
    case 3: dist1 = nx * minx + ny * miny + nz * maxz; dist2 = nx * maxx + ny * maxy + nz * minz; break;
    case 4: dist1 = nx * maxx + ny * maxy + nz * minz; dist2 = nx * minx + ny * miny + nz * maxz; break;
    case 5: dist1 = nx * minx + ny * maxy + nz * minz; dist2 = nx * maxx + ny * miny + nz * maxz; break;
    case 6: dist1 = nx * maxx + ny * miny + nz * minz; dist2 = nx * minx + ny * maxy + nz * maxz; break;
    default: dist1 = nx * minx + ny * miny + nz * minz; dist2 = nx * maxx + ny * maxy + nz * maxz; break;
  }
  let sides = 0;
  if (dist1 >= plane.dist) sides = 1;
  if (dist2 < plane.dist) sides |= 2;
  if (sides === 1) return 1;
  if (sides === 2) return 2;
  return 3;
}

/** True when the box is at least partly inside every plane (not culled). */
export function boxInFrustum(mins: Vec3, maxs: Vec3, planes: Plane[]): boolean {
  for (let i = 0; i < planes.length; i++) {
    if (boxOnPlane(mins, maxs, planes[i]!) === 2) return false;
  }
  return true;
}

/**
 * Build the 4 inward-facing view frustum planes [left, right, top, bottom]
 * from a camera, porting R_ViewChanged (screenedge) + R_TransformFrustum:
 * the view-space edge normals are permuted/negated into world space and the
 * plane passes through origin (dist = dot(origin, normal)).
 * fovXDeg/fovYDeg are full horizontal/vertical fields of view in degrees.
 */
export function FrustumFromView(
  origin: Vec3,
  angles: Vec3,
  fovXDeg: number,
  fovYDeg: number,
  out?: Plane[],
): Plane[] {
  const forward = v3(), right = v3(), up = v3();
  AngleVectors(angles, forward, right, up);
  const hfov = 2 * Math.tan(((fovXDeg * DEG2RAD) / 2));
  const vfov = 2 * Math.tan(((fovYDeg * DEG2RAD) / 2));
  // View-space screen edge normals (r_misc.c R_ViewChanged, xOrigin=yOrigin=0.5).
  const ex = 1 / (0.5 * hfov);
  const ey = 1 / (0.5 * vfov);
  const edge: Array<[number, number, number]> = [
    [-ex, 0, 1],
    [ex, 0, 1],
    [0, -ey, 1],
    [0, ey, 1],
  ];
  const planes: Plane[] = out ?? [];
  for (let i = 0; i < 4; i++) {
    const n = edge[i]!;
    // R_TransformFrustum permutation (note the negated x).
    const v0 = n[2], v1 = -n[0], v2 = n[1];
    const wx = v1 * right[0]! + v2 * up[0]! + v0 * forward[0]!;
    const wy = v1 * right[1]! + v2 * up[1]! + v0 * forward[1]!;
    const wz = v1 * right[2]! + v2 * up[2]! + v0 * forward[2]!;
    const len = Math.hypot(wx, wy, wz) || 1;
    let plane = planes[i];
    if (plane === undefined) {
      plane = { normal: v3(), dist: 0, type: 0, signbits: 0 };
      planes[i] = plane;
    }
    v3set(plane.normal, wx / len, wy / len, wz / len);
    plane.dist = dot(origin, plane.normal);
    plane.type = planeTypeForNormal(plane.normal);
    plane.signbits = planeSignbits(plane.normal);
  }
  return planes;
}

// ---------------------------------------------------------------------------
// 16.16 fixed point (d_scan.c)
// ---------------------------------------------------------------------------

export const FIX_SHIFT = 16;
export const FIX_ONE = 1 << FIX_SHIFT;
/** 0.5 in 16.16. */
export const FIX_HALF = FIX_ONE >> 1;
/** Fractional mask: fix & FIX_MASK isolates the fraction. */
export const FIX_MASK = FIX_ONE - 1;

export function floatToFix(x: number): number { return (x * FIX_ONE) | 0; }
export function fixToFloat(x: number): number { return x / FIX_ONE; }
export function fixMul(a: number, b: number): number { return ((a * b) / FIX_ONE) | 0; }

/** Fixed-point division: (a / b) in 16.16. b must be nonzero. */
export function fixDiv(a: number, b: number): number { return ((a * FIX_ONE) / b) | 0; }

/** Clamp a fixed-point value to [lo, hi]. */
export function fixClamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
