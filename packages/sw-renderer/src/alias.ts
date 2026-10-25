// @q2/sw-renderer alias — r_alias.c / d_polyse.c equivalent.
// MD2-style meshes drawn as affine triangles (screen-space linear u,v)
// with per-vertex lighting from shade dots (anorms table).

import type { Camera } from './camera.js';

/** 162-entry averaged-normals table (anorms equivalent, fibonacci sphere). */
export const ANORM_COUNT = 162;

export function buildANorms(): Float32Array {
  const t = new Float32Array(ANORM_COUNT * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < ANORM_COUNT; i++) {
    const y = 1 - ((i + 0.5) / ANORM_COUNT) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    t[i * 3] = Math.cos(th) * r;
    t[i * 3 + 1] = Math.sin(th) * r;
    t[i * 3 + 2] = y;
  }
  return t;
}

/**
 * Shade dots: dots[lightAngle 0..255][normal 0..161], matching
 * r_alias.c `shadedots = r_avertexnormal_dots[angle]` semantics. The light
 * angle quantises the entity yaw; elevation is fixed at 45 degrees above,
 * like the original hand-placed light.
 */
export function buildShadeDots(anorms: Float32Array): Float32Array {
  const dots = new Float32Array(256 * ANORM_COUNT);
  const elev = Math.PI / 4;
  for (let a = 0; a < 256; a++) {
    const yaw = (a / 256) * Math.PI * 2;
    const lx = Math.cos(yaw) * Math.cos(elev);
    const ly = Math.sin(yaw) * Math.cos(elev);
    const lz = Math.sin(elev);
    for (let n = 0; n < ANORM_COUNT; n++) {
      const d = anorms[n * 3]! * lx + anorms[n * 3 + 1]! * ly + anorms[n * 3 + 2]! * lz;
      // quantise to colormap grade: ambient 12 + directional 0..51
      const g = 12 + Math.max(0, (d + 1) / 2) * 51;
      dots[a * ANORM_COUNT + n] = Math.min(63, Math.max(0, Math.round(g)));
    }
  }
  return dots;
}

export interface AliasMesh {
  /** xyz per vert per frame, numFrames*numVerts*3 */
  frames: Float32Array;
  /** normal index per vert per frame, numFrames*numVerts */
  normals: Uint8Array;
  numVerts: number;
  numFrames: number;
  /** vert indices, numTris*3 */
  tris: Uint16Array;
  numTris: number;
  /** st per vert, numVerts*2 (texel units) */
  st: Float32Array;
}

/** Procedural box critter used by tests + devroom (no asset needed). */
export function createBoxMesh(s = 16): AliasMesh {
  const v = [
    -s, -s, -s, s, -s, -s, s, s, -s, -s, s, -s,
    -s, -s, s, s, -s, s, s, s, s, -s, s, s,
  ];
  const frames = new Float32Array([...v, ...v.map((x, i) => (i % 3 === 2 ? x + 4 : x))]);
  const tris = new Uint16Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ]);
  const st = new Float32Array([0, 0, 32, 0, 32, 32, 0, 32, 0, 0, 32, 0, 32, 32, 0, 32]);
  const normals = new Uint8Array(16);
  return { frames, normals, numVerts: 8, numFrames: 2, tris, numTris: 12, st };
}

export interface AliasInstance {
  mesh: AliasMesh;
  origin: Float32Array;
  angles: Float32Array;
  frameA: number; frameB: number; lerp: number;
  /** yaw-quantised light angle 0..255 */
  lightAngle: number;
}

export interface AliasSkin {
  texels: Uint8Array;
  width: number; height: number;
}

interface TriVert {
  x: number; y: number; iz: number; u: number; v: number; grade: number;
}

/**
 * Draw one alias instance with affine texture mapping + shade dots.
 * Screen-space linear (u, v, iz): the d_polyse.c affine look.
 * Returns drawn pixel count.
 */
export function drawAliasInstance(
  idx: Uint8Array,
  zb: Float32Array,
  fbW: number,
  fbH: number,
  inst: AliasInstance,
  skin: AliasSkin,
  cam: Camera,
  anorms: Float32Array,
  shadeDots: Float32Array,
  colormap: Uint8Array,
): number {
  const mesh = inst.mesh;
  const nv = mesh.numVerts;
  // entity basis
  const pitch = (inst.angles[0]! * Math.PI) / 180;
  const yaw = (inst.angles[1]! * Math.PI) / 180;
  const cp = Math.cos(pitch), sp2 = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  // lerp frames
  const fA = mesh.frames.subarray(inst.frameA * nv * 3, (inst.frameA + 1) * nv * 3);
  const fB = mesh.frames.subarray(inst.frameB * nv * 3, (inst.frameB + 1) * nv * 3);
  const t = inst.lerp;
  // world verts (stack scratch, bounded by mesh size)
  const wx = aliasScratchX, wy = aliasScratchY, wz = aliasScratchZ;
  for (let i = 0; i < nv; i++) {
    const lx = fA[i * 3]! + (fB[i * 3]! - fA[i * 3]!) * t;
    const ly = fA[i * 3 + 1]! + (fB[i * 3 + 1]! - fA[i * 3 + 1]!) * t;
    const lz = fA[i * 3 + 2]! + (fB[i * 3 + 2]! - fA[i * 3 + 2]!) * t;
    // yaw then pitch (Quake entity rotation), then translate
    const x1 = cy * lx - sy * ly;
    const y1 = sy * lx + cy * ly;
    const z1 = lz;
    const x2 = x1;
    const y2 = cp * y1 - sp2 * z1;
    const z2 = sp2 * y1 + cp * z1;
    wx[i] = x2 + inst.origin[0]!;
    wy[i] = y2 + inst.origin[1]!;
    wz[i] = z2 + inst.origin[2]!;
  }
  void anorms;
  const row = (inst.lightAngle & 255) * ANORM_COUNT;
  let pixels = 0;
  const tv: TriVert[] = aliasTri;
  for (let ti = 0; ti < mesh.numTris; ti++) {
    for (let k = 0; k < 3; k++) {
      const vi = mesh.tris[ti * 3 + k]!;
      // to view space
      const px = wx[vi]! - cam.origin[0]!;
      const py = wy[vi]! - cam.origin[1]!;
      const pz = wz[vi]! - cam.origin[2]!;
      const vx = px * cam.right[0]! + py * cam.right[1]! + pz * cam.right[2]!;
      const vy = px * cam.up[0]! + py * cam.up[1]! + pz * cam.up[2]!;
      const vz2 = px * cam.forward[0]! + py * cam.forward[1]! + pz * cam.forward[2]!;
      const v = tv[k]!;
      if (vz2 < cam.near) {
        v.iz = -1;
        continue;
      }
      const iz = 1 / vz2;
      v.x = cam.xCenter + vx * cam.focalX * iz;
      v.y = cam.yCenter - vy * cam.focalY * iz;
      v.iz = iz;
      v.u = mesh.st[vi * 2]!;
      v.v = mesh.st[vi * 2 + 1]!;
      const frame = t < 0.5 ? inst.frameA : inst.frameB;
      const ni = mesh.normals[(frame * nv + vi) % mesh.normals.length]! % ANORM_COUNT;
      v.grade = shadeDots[row + ni]!;
    }
    if (tv[0]!.iz < 0 || tv[1]!.iz < 0 || tv[2]!.iz < 0) continue;
    pixels += fillAffineTri(idx, zb, fbW, fbH, tv[0]!, tv[1]!, tv[2]!, skin, colormap);
  }
  return pixels;
}

const aliasScratchX = new Float32Array(4096);
const aliasScratchY = new Float32Array(4096);
const aliasScratchZ = new Float32Array(4096);
const aliasTri: TriVert[] = [
  { x: 0, y: 0, iz: 0, u: 0, v: 0, grade: 0 },
  { x: 0, y: 0, iz: 0, u: 0, v: 0, grade: 0 },
  { x: 0, y: 0, iz: 0, u: 0, v: 0, grade: 0 },
];

/** Affine triangle filler: linear u/v/grade in screen space, 1/z depth test. */
export function fillAffineTri(
  idx: Uint8Array,
  zb: Float32Array,
  fbW: number,
  fbH: number,
  a: TriVert, b: TriVert, c: TriVert,
  skin: AliasSkin,
  colormap: Uint8Array,
): number {
  // backface cull (screen-space winding)
  const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  if (area <= 0) return 0;
  const wmask = skin.width - 1, hmask = skin.height - 1;
  const wshift = Math.round(Math.log2(skin.width));
  let minY = Math.max(0, Math.ceil(Math.min(a.y, b.y, c.y) - 0.5));
  let maxY = Math.min(fbH - 1, Math.floor(Math.max(a.y, b.y, c.y) - 0.5));
  if (maxY < minY) return 0;
  let pixels = 0;
  const inv = 1 / area;
  for (let y = minY; y <= maxY; y++) {
    const yc = y + 0.5;
    // clip x range via edge intersections
    let xa = Infinity, xb = -Infinity;
    const pts = [a, b, c];
    for (let i = 0; i < 3; i++) {
      const p0 = pts[i]!, p1 = pts[(i + 1) % 3]!;
      if ((p0.y <= yc && p1.y > yc) || (p1.y <= yc && p0.y > yc)) {
        const tt = (yc - p0.y) / (p1.y - p0.y);
        const x = p0.x + (p1.x - p0.x) * tt;
        if (x < xa) xa = x;
        if (x > xb) xb = x;
      }
    }
    if (!(xb > xa)) continue;
    const x0 = Math.max(0, Math.ceil(xa - 0.5));
    const x1 = Math.min(fbW - 1, Math.floor(xb - 0.5));
    for (let x = x0; x <= x1; x++) {
      const xc = x + 0.5;
      // barycentric
      const w0 = ((b.x - xc) * (c.y - yc) - (c.x - xc) * (b.y - yc)) * inv;
      const w1 = ((c.x - xc) * (a.y - yc) - (a.x - xc) * (c.y - yc)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const iz = w0 * a.iz + w1 * b.iz + w2 * c.iz;
      const o = y * fbW + x;
      if (iz > zb[o]) {
        const uu = (w0 * a.u + w1 * b.u + w2 * c.u) | 0;
        const vv = (w0 * a.v + w1 * b.v + w2 * c.v) | 0;
        const grade = (w0 * a.grade + w1 * b.grade + w2 * c.grade) | 0;
        const g = grade < 0 ? 0 : grade > 63 ? 63 : grade;
        zb[o] = iz;
        idx[o] = colormap[(g << 8) + skin.texels[((vv & hmask) << wshift) + (uu & wmask)]]!;
        pixels++;
      }
    }
  }
  void minY;
  return pixels;
}
