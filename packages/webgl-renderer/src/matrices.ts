// @q2/webgl-renderer matrices — pure Quake-camera MVP math (GPU-PROOF-3).
//
// GL-free, DOM-free: builds column-major 4x4 matrices from the same camera
// convention the CPU uses (camera.ts: X=right, Y=up, Z=forward view space,
// xCenter/yCenter/focalX/focalY projection, near=4). Entity model matrices
// use the full pitch/yaw/roll basis from drawAliasInstance
// (world = origin + lx*F - ly*R + lz*U), which reduces to entityTransform
// (yaw-only) at pitch=roll=0.
//
// GPU depth convention: NDC z in [-1, 1] maps near->-1 (GL default depth
// range [0,1] puts near at 0). Depth test LESS with clear 1.0 matches the
// CPU's strict `iz > zb` (ties keep the stored value = first wins).

/** Near plane (matches the CPU camera default). */
export const GPU_NEAR = 4;
/** Far plane (matches the CPU camera default). */
export const GPU_FAR = 32768;

/**
 * View matrix (column-major) from a Quake camera basis.
 * view = [dot(p-o, R), dot(p-o, U), dot(p-o, F)].
 */
export function buildViewMatrix(
  origin: Float32Array,
  forward: Float32Array,
  right: Float32Array,
  up: Float32Array,
  out?: Float32Array,
): Float32Array {
  const m = out ?? new Float32Array(16);
  // Rows are the camera basis (view.x = dot(R, p-o), ...); column-major
  // storage transposes the row layout below.
  m[0] = right[0]!; m[1] = up[0]!; m[2] = forward[0]!; m[3] = 0;
  m[4] = right[1]!; m[5] = up[1]!; m[6] = forward[1]!; m[7] = 0;
  m[8] = right[2]!; m[9] = up[2]!; m[10] = forward[2]!; m[11] = 0;
  m[12] = -(right[0]! * origin[0]! + right[1]! * origin[1]! + right[2]! * origin[2]!);
  m[13] = -(up[0]! * origin[0]! + up[1]! * origin[1]! + up[2]! * origin[2]!);
  m[14] = -(forward[0]! * origin[0]! + forward[1]! * origin[1]! + forward[2]! * origin[2]!);
  m[15] = 1;
  return m;
}

/**
 * Projection matrix (column-major) matching the CPU focal math exactly:
 * NDC x = X/(Z*tanX), NDC y = +Y/(Z*tanY) (view-up maps to NDC-up, which
 * the canvas presents at the top — no flip; a minus sign here renders the
 * whole frame vertically flipped vs the CPU reference, caught by the
 * browser placement gates), NDC z = (A*Z + B)/Z with Z=near -> -1,
 * Z=far -> +1.
 */
export function buildProjectionMatrix(
  fovXDeg: number,
  width: number,
  height: number,
  near = GPU_NEAR,
  far = GPU_FAR,
  out?: Float32Array,
): Float32Array {
  const m = out ?? new Float32Array(16);
  const tanX = Math.tan(((fovXDeg * Math.PI) / 180) / 2);
  const tanY = tanX * (height / width);
  const fx = 1 / tanX;
  const fy = 1 / tanY;
  const a = (far + near) / (far - near);
  const b = (-2 * far * near) / (far - near);
  m[0] = fx; m[1] = 0; m[2] = 0; m[3] = 0;
  m[4] = 0; m[5] = fy; m[6] = 0; m[7] = 0;
  m[8] = 0; m[9] = 0; m[10] = a; m[11] = 1;
  m[12] = 0; m[13] = 0; m[14] = b; m[15] = 0;
  return m;
}

/** Column-major 4x4 multiply: out = a * b. */
export function multiplyMat4(a: Float32Array, b: Float32Array, out?: Float32Array): Float32Array {
  const m = out ?? new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      m[c * 4 + r] =
        a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! +
        a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    }
  }
  return m;
}

/**
 * Full entity model matrix (column-major): columns (F, -R, U, e) with the
 * AngleVectors basis — the GPU form of `world = origin + lx*F - ly*R + lz*U`.
 * At pitch=roll=0 this is exactly entityTransform (yaw rotation).
 */
export function buildEntityModel(
  origin: Float32Array,
  angles: Float32Array,
  out?: Float32Array,
): Float32Array {
  const m = out ?? new Float32Array(16);
  const pitchR = (angles[0]! * Math.PI) / 180;
  const yawR = (angles[1]! * Math.PI) / 180;
  const rollR = (angles[2]! * Math.PI) / 180;
  const sp = Math.sin(pitchR), cp = Math.cos(pitchR);
  const sy = Math.sin(yawR), cy = Math.cos(yawR);
  const sr = Math.sin(rollR), cr = Math.cos(rollR);
  const fxx = cp * cy, fxy = cp * sy, fxz = -sp;
  const rxx = -sr * sp * cy + cr * sy;
  const rxy = -sr * sp * sy - cr * cy;
  const rxz = -sr * cp;
  const uxx = cr * sp * cy + sr * sy;
  const uxy = cr * sp * sy - sr * cy;
  const uxz = cr * cp;
  m[0] = fxx; m[1] = fxy; m[2] = fxz; m[3] = 0;
  m[4] = -rxx; m[5] = -rxy; m[6] = -rxz; m[7] = 0;
  m[8] = uxx; m[9] = uxy; m[10] = uxz; m[11] = 0;
  m[12] = origin[0]!; m[13] = origin[1]!; m[14] = origin[2]!; m[15] = 1;
  return m;
}

/** Transform a point by a column-major 4x4 (with perspective divide). */
export function transformPoint(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  return [
    (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w,
    (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w,
    (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w,
  ];
}
