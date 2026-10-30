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
// Shade base per vertex: shadeDots[(lightAngle & 255) * 162 + normal] / 63,
// the CPU rule (buildShadeDots). Dynamic lights ride the alias fragment
// shader as per-pixel uniforms (shared with the world program).

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
 * Per-vertex shade base for one instance (shadeDots grade / 63, the CPU
 * rule). shadeFrame picks frameA/frameB at the t<0.5 boundary, like the CPU.
 */
export function aliasShadeBase(
  mesh: AliasMesh,
  frameA: number,
  frameB: number,
  lerp: number,
  lightAngle: number,
  out: Float32Array,
): Float32Array {
  const dots = shadeDots();
  const row = ((lightAngle | 0) & 255) * ANORM_COUNT;
  const shadeFrame = lerp < 0.5 ? frameA : frameB;
  const nv = mesh.numVerts;
  for (let i = 0; i < nv; i++) {
    const ni = mesh.normals[(shadeFrame * nv + i) % mesh.normals.length]! % ANORM_COUNT;
    out[i] = dots[row + ni]! / 63;
  }
  return out;
}
