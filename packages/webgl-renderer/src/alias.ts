// @q2/webgl-renderer alias — per-model GPU meshes + per-frame interpolation.
//
// MD2 parsing lives in @q2/formats (NOT a dependency of this package: the
// dep allowlist is integrator-owned). Like sw-renderer/alias.ts, the mesh
// conversion consumes parsed MD2 output structurally (Md2Like): indices come
// from the weld over (xyz, st) pairs — the same triangle index order the CPU
// path uses — so winding matches and no GL culling assumption is needed.
//
// Per-frame interpolation (frameA -> frameB by backlerp) runs on the CPU
// into a DYNAMIC vertex buffer. The route's dynamic set is tiny (gun +
// soldier); GPU skinning (vertex texture fetch / uniform-frame upload) is
// the documented deferred optimization, not this card.
//
// Per-vertex directional factor (ref_gl anormtab.h mirror, see
// aliasDotFactorGL) times the per-entity RGB shade level in the
// uShadeBase uniform (see aliasShadeLightGL). Dynamic lights ride the
// alias fragment shader as per-pixel uniforms (shared with the world
// program). Node-less worlds (devroom/stub) keep the legacy fixed table
// (shadeDots[(lightAngle & 255) * 162 + normal] / 63) with a unit base.

import {
  buildANorms,
  buildShadeDots,
  md2ToAliasMesh,
  ANORM_COUNT,
  type AliasMesh,
} from '@q2/sw-renderer';
import { clampBacklerp } from '@q2/sw-renderer';

export type { AliasMesh };

/** Shade-dot table (module memo: the table is constant). */
let shadeDotsMemo: Float32Array | null = null;

function shadeDots(): Float32Array {
  if (!shadeDotsMemo) shadeDotsMemo = buildShadeDots(buildANorms());
  return shadeDotsMemo;
}

/** Averaged-normals table (module memo: constant, shared with shadeDots). */
let anormsMemo: Float32Array | null = null;

function anorms(): Float32Array {
  if (!anormsMemo) anormsMemo = buildANorms();
  return anormsMemo;
}

/**
 * Convert parsed MD2 output (or an AliasMesh) to a GPU-ready alias mesh.
 * Null on anything else (caller warns + skips the entity, never crashes).
 */
export function gpuMeshFromMd2(data: unknown): AliasMesh | null {
  if (!data || typeof data !== 'object') return null;
  if (isAliasMeshData(data)) return data;
  return md2ToAliasMesh(data);
}

function isAliasMeshData(data: object): data is AliasMesh {
  const m = data as Record<string, unknown>;
  return m.frames instanceof Float32Array
    && m.normals instanceof Uint8Array
    && m.tris instanceof Uint16Array
    && m.st instanceof Float32Array
    && typeof m.numVerts === 'number'
    && typeof m.numFrames === 'number';
}

/**
 * Wrap a frame index like the CPU (real MD2s carry hundreds of frames;
 * game-provided indices wrap). Mirrors frame.ts exactly.
 */
export function wrapAliasFrame(f: number, numFrames: number): number {
  const nf = numFrames > 0 ? numFrames : 1;
  return ((f % nf) + nf) % nf;
}

/** Resolve (frameA, frameB, lerp) from an entity, mirroring frame.ts. */
export function resolveAliasLerp(
  frame: number,
  oldframe: number | undefined,
  backlerp: number | undefined,
  numFrames: number,
): { frameA: number; frameB: number; lerp: number } {
  const fr = wrapAliasFrame(Math.trunc(frame), numFrames);
  const hasOld = oldframe !== undefined && Number.isFinite(oldframe);
  const frA = hasOld ? wrapAliasFrame(Math.trunc(oldframe as number), numFrames) : fr;
  let lerp = clampBacklerp(backlerp);
  if (!hasOld) lerp = 0;
  return { frameA: frA, frameB: fr, lerp };
}

/**
 * Interpolate one alias mesh frameA -> frameB by lerp into out (nv*3).
 * Bit-mirror of drawAliasInstance's world-lerp line:
 * out = A + (B - A) * t. Deterministic: same inputs -> identical bytes.
 */
export function interpolateAliasFrame(
  mesh: AliasMesh,
  frameA: number,
  frameB: number,
  lerp: number,
  out: Float32Array,
): Float32Array {
  const nv = mesh.numVerts;
  const fA = mesh.frames.subarray(frameA * nv * 3, (frameA + 1) * nv * 3);
  const fB = mesh.frames.subarray(frameB * nv * 3, (frameB + 1) * nv * 3);
  for (let i = 0; i < nv * 3; i++) {
    out[i] = fA[i]! + (fB[i]! - fA[i]!) * lerp;
  }
  return out;
}

/**
 * Procedural mirror of ref_gl's r_avertexnormal_dots (anormtab.h): the
 * per-vertex directional factor for one normal under the entity-yaw light.
 * ref_gl's table spans [0.7, 2.0] (mean 1.11) — a gentle modulation around
 * the sample, never a crush — with the light elevated 45 degrees
 * (shadevector (cos(-yaw), sin(-yaw), 1), normalized). A global linear fit
 * of the 16x256 table against dot(n, shadevector) gives
 * l = 1.175 + 0.65*dot (worst residual 0.18), clamped to the table's
 * observed bounds, so no id table data is copied into the repo.
 */
export function aliasDotFactorGL(nx: number, ny: number, nz: number, yawRad: number): number {
  const inv = 1 / Math.SQRT2;
  const sx = Math.cos(-yawRad) * inv;
  const sy = Math.sin(-yawRad) * inv;
  const sz = inv;
  const d = nx * sx + ny * sy + nz * sz;
  let l = 1.175 + 0.65 * d;
  if (l < 0.7) l = 0.7;
  else if (l > 2.0) l = 2.0;
  return l;
}

/**
 * Per-channel static shadelight for the WebGL (ref_gl) path
 * (gl_mesh.c: R_LightPoint sample, then RF_MINLIGHT / RF_GLOW). Unlike
 * ref_soft there are no ambient/shade clamps and no inversion: the
 * sample rides through almost verbatim. ref_gl MINLIGHT is
 * all-or-nothing (only when every channel reads below 0.1 do all three
 * jump to 0.1); GLOW pulses per channel. Dynamics are NOT folded in
 * here — the alias fragment shader adds them per pixel.
 */
export function aliasShadeLightGL(
  staticRGB: Float32Array,
  opts: { minlight?: boolean; glow?: boolean; time?: number } = {},
  out?: Float32Array,
): Float32Array {
  const o = out ?? new Float32Array(3);
  o[0] = staticRGB[0]!; o[1] = staticRGB[1]!; o[2] = staticRGB[2]!;
  if (opts.minlight) {
    if (o[0]! < 0.1 && o[1]! < 0.1 && o[2]! < 0.1) {
      o[0] = 0.1; o[1] = 0.1; o[2] = 0.1;
    }
  }
  if (opts.glow) {
    const t = opts.time ?? 0;
    const s = 0.1 * Math.sin(t * 7);
    for (let k = 0; k < 3; k++) {
      const m = o[k]! * 0.8;
      o[k] = o[k]! + s;
      if (o[k]! < m) o[k] = m;
    }
  }
  return o;
}

/**
 * Per-vertex directional factor for one instance (ref_gl rule).
 * shadeFrame picks frameA/frameB at the t<0.5 boundary, like the CPU.
 * When `gl` is present (real BSP worlds) out[] receives the procedural
 * anormtab mirror per normal instead of the fixed shadeDots table; the
 * per-entity RGB level rides the uShadeBase uniform (see drawAlias), so
 * this buffer stays one float per vertex. The fragment-shader dynamic
 * lights stay per-pixel, so the uniform must EXCLUDE dynamics (the CPU
 * software path folds them into its base — no per-pixel stage there).
 */
export function aliasShadeBase(
  mesh: AliasMesh,
  frameA: number,
  frameB: number,
  lerp: number,
  lightAngle: number,
  out: Float32Array,
  gl?: { yaw: number; base: Float32Array },
): Float32Array {
  const shadeFrame = lerp < 0.5 ? frameA : frameB;
  const nv = mesh.numVerts;
  if (gl) {
    // Normals table for the per-normal dot (module memo, same as CPU).
    const an = anorms();
    for (let i = 0; i < nv; i++) {
      const ni = mesh.normals[(shadeFrame * nv + i) % mesh.normals.length]! % ANORM_COUNT;
      out[i] = aliasDotFactorGL(an[ni * 3]!, an[ni * 3 + 1]!, an[ni * 3 + 2]!, gl.yaw);
    }
    return out;
  }
  const dots = shadeDots();
  const row = ((lightAngle | 0) & 255) * ANORM_COUNT;
  for (let i = 0; i < nv; i++) {
    const ni = mesh.normals[(shadeFrame * nv + i) % mesh.normals.length]! % ANORM_COUNT;
    out[i] = dots[row + ni]! / 63;
  }
  return out;
}
