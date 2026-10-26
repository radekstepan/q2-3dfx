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

/**
 * Structural subset of the `@q2/formats` Md2 parse output that
 * md2ToAliasMesh needs. Declared locally (no runtime import) so the
 * conversion stays a pure function of typed arrays; every real Md2 is
 * assignable to it.
 */
export interface Md2Like {
  skinWidth: number;
  skinHeight: number;
  numFrames: number;
  numVerts: number;
  numSt: number;
  numTris: number;
  /** numSt*2 shorts: (s, t) per st vert, in skin-texel units. */
  st: Int16Array;
  /** numTris*3 vertex indices into frames. */
  trisXyz: Uint16Array;
  /** numTris*3 st indices into st. */
  trisSt: Uint16Array;
  /** numFrames*numVerts*3 decoded positions (v*scale+translate). */
  frames: Float32Array;
  /** numFrames*numVerts shade-dot normal indices. */
  normals: Uint8Array;
}

/** Lightweight shape check: does `data` look like parsed MD2 output? */
export function isMd2Data(data: unknown): data is Md2Like {
  if (!data || typeof data !== 'object') return false;
  const m = data as Record<string, unknown>;
  return typeof m.skinWidth === 'number' && typeof m.skinHeight === 'number'
    && typeof m.numFrames === 'number' && typeof m.numVerts === 'number'
    && typeof m.numSt === 'number' && typeof m.numTris === 'number'
    && m.st instanceof Int16Array
    && m.trisXyz instanceof Uint16Array && m.trisSt instanceof Uint16Array
    && m.frames instanceof Float32Array && m.normals instanceof Uint8Array;
}

/** Hard caps mirrored from qcommon/qfiles.h (MD2_MAX_*). */
export const MD2_CONVERT_MAX_TRIS = 4096;
export const MD2_CONVERT_MAX_VERTS = 2048;
export const MD2_CONVERT_MAX_FRAMES = 512;

/**
 * Convert parsed MD2 output to a renderer AliasMesh.
 *
 * MD2 triangles index vertex positions and texture coords independently
 * (`trisXyz`/`trisSt`), while AliasMesh carries one st per vert — so corners
 * are welded on the (xyz, st) pair: shared pairs reuse a vert, seam splits
 * duplicate one. Positions arrive dequantised (`v*scale+translate`) and st
 * arrives in skin-texel units, clamped to the skin dims. Triangle indices
 * are range-validated; anything out of range (or insane counts) returns
 * null and the caller keeps the gun-mesh fallback.
 *
 * Register-time only: allocates. The frame loop never calls this.
 */
export function md2ToAliasMesh(md2: unknown): AliasMesh | null {
  if (!isMd2Data(md2)) return null;
  const { numFrames, numVerts, numSt, numTris, skinWidth, skinHeight } = md2;
  if (!(numFrames >= 1 && numFrames <= MD2_CONVERT_MAX_FRAMES)) return null;
  if (!(numVerts >= 1 && numVerts <= MD2_CONVERT_MAX_VERTS)) return null;
  if (!(numSt >= 1 && numSt <= MD2_CONVERT_MAX_VERTS * 2)) return null;
  if (!(numTris >= 1 && numTris <= MD2_CONVERT_MAX_TRIS)) return null;
  if (!(skinWidth >= 1 && skinHeight >= 1)) return null;
  if (md2.st.length !== numSt * 2) return null;
  if (md2.trisXyz.length !== numTris * 3 || md2.trisSt.length !== numTris * 3) return null;
  if (md2.frames.length !== numFrames * numVerts * 3) return null;
  if (md2.normals.length !== numFrames * numVerts) return null;
  // Range-check every corner before writing anything.
  for (let i = 0; i < numTris * 3; i++) {
    if (md2.trisXyz[i]! >= numVerts || md2.trisSt[i]! >= numSt) return null;
  }
  // Weld (xyz, st) pairs across all triangles.
  const weld = new Map<number, number>();
  const vertXyz = new Uint16Array(numTris * 3);
  const vertSt = new Uint16Array(numTris * 3);
  let nv = 0;
  for (let i = 0; i < numTris * 3; i++) {
    const x = md2.trisXyz[i]!, s = md2.trisSt[i]!;
    const key = x * numSt + s;
    let w = weld.get(key);
    if (w === undefined) {
      w = nv++;
      weld.set(key, w);
      vertXyz[w] = x;
      vertSt[w] = s;
    }
  }
  const tris = new Uint16Array(numTris * 3);
  for (let i = 0; i < numTris * 3; i++) {
    tris[i] = weld.get(md2.trisXyz[i]! * numSt + md2.trisSt[i]!)!;
  }
  const st = new Float32Array(nv * 2);
  for (let w = 0; w < nv; w++) {
    const s = vertSt[w]!;
    let u = md2.st[s * 2]!, v = md2.st[s * 2 + 1]!;
    if (u < 0) u = 0; else if (u > skinWidth - 1) u = skinWidth - 1;
    if (v < 0) v = 0; else if (v > skinHeight - 1) v = skinHeight - 1;
    st[w * 2] = u;
    st[w * 2 + 1] = v;
  }
  const frames = new Float32Array(numFrames * nv * 3);
  const normals = new Uint8Array(numFrames * nv);
  for (let f = 0; f < numFrames; f++) {
    for (let w = 0; w < nv; w++) {
      const x = vertXyz[w]!;
      frames[(f * nv + w) * 3] = md2.frames[(f * numVerts + x) * 3]!;
      frames[(f * nv + w) * 3 + 1] = md2.frames[(f * numVerts + x) * 3 + 1]!;
      frames[(f * nv + w) * 3 + 2] = md2.frames[(f * numVerts + x) * 3 + 2]!;
      normals[f * nv + w] = md2.normals[f * numVerts + x]!;
    }
  }
  return { frames, normals, numVerts: nv, numFrames, tris, numTris, st };
}

/**
 * Procedural gun silhouette used as the registerModel fallback for kind
 * 'md2' when no real data is present (devroom / missing pak): receiver +
 * barrel + grip + sight, pointing +X, per-face duplicated verts so the
 * shade dots give flat facet shading. Two frames: frame 1 kicks back 1.5
 * units (recoil). createBoxMesh is intentionally untouched — the devroom
 * golden pins its exact pixels.
 */
export function createGunMesh(): AliasMesh {
  return meshFromBoxes([
    [0, 0, 0, 13, 3.5, 4.5],
    [20, 0, 1, 8, 1.6, 1.6],
    [-6, 0, -8, 3, 2.5, 5],
    [2, 0, 6, 4, 1, 1.5],
  ], 1.5);
}

/**
 * Procedural soldier silhouette (boxy humanoid ~51 units tall facing +X:
 * torso, head, two legs, two arms) with the same per-face facet normals as
 * the gun mesh. Register-time fallback so a monster with real MD2 geometry
 * but no skin yet still reads as a soldier instead of a box critter; the
 * boot path is expected to replace it with parsed `tris.md2` via
 * md2ToAliasMesh + registerSkinData (see TODO(M1.2 follow-up)). Two
 * identical frames (no recoil). Asset-free.
 */
export function createSoldierMesh(): AliasMesh {
  return meshFromBoxes([
    [0, 0, 32, 7, 5, 10],      // torso  (z 22..42)
    [1, 0, 47, 4, 4, 4],       // head   (z 43..51)
    [0, -3.5, 11, 4, 2.5, 11], // left leg  (z 0..22)
    [0, 3.5, 11, 4, 2.5, 11],  // right leg
    [0, -8.5, 31, 3.5, 2.5, 9],// left arm  (z 22..40)
    [0, 8.5, 31, 3.5, 2.5, 9], // right arm
  ], 0);
}

/**
 * Build an AliasMesh out of axis-aligned boxes (cx, cy, cz, sx, sy, sz),
 * one duplicated-vert cube per box face so shade dots give flat facet
 * shading. Frame 1 shifts -recoilX on x (gun recoil; 0 = static pose).
 * Register-time only: allocates.
 */
function meshFromBoxes(boxes: number[][], recoilX: number): AliasMesh {
  const anorms = buildANorms();
  const best = (x: number, y: number, z: number): number => {
    let bi = 0, bd = -Infinity;
    for (let i = 0; i < ANORM_COUNT; i++) {
      const d = anorms[i * 3]! * x + anorms[i * 3 + 1]! * y + anorms[i * 3 + 2]! * z;
      if (d > bd) { bd = d; bi = i; }
    }
    return bi;
  };
  // Face normals in box-local order: -z, +z, -y, +x, +y, -x.
  const faceNormals = [best(0, 0, -1), best(0, 0, 1), best(0, -1, 0), best(1, 0, 0), best(0, 1, 0), best(-1, 0, 0)];
  // Box corner offsets, same layout as createBoxMesh.
  const corners = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): number[] => [
    cx - sx, cy - sy, cz - sz, cx + sx, cy - sy, cz - sz, cx + sx, cy + sy, cz - sz, cx - sx, cy + sy, cz - sz,
    cx - sx, cy - sy, cz + sz, cx + sx, cy - sy, cz + sz, cx + sx, cy + sy, cz + sz, cx - sx, cy + sy, cz + sz,
  ];
  // Faces as corner quads (pairs of tris follow the createBoxMesh table).
  const faces = [
    { c: [0, 1, 2, 0, 2, 3], n: 0 }, { c: [4, 6, 5, 4, 7, 6], n: 1 },
    { c: [0, 4, 5, 0, 5, 1], n: 2 }, { c: [1, 5, 6, 1, 6, 2], n: 3 },
    { c: [2, 6, 7, 2, 7, 3], n: 4 }, { c: [3, 7, 4, 3, 4, 0], n: 5 },
  ];
  const pos: number[] = [];
  const nrm: number[] = [];
  const tri: number[] = [];
  const uv: number[] = [];
  for (const [cx, cy, cz, sx, sy, sz] of boxes) {
    const cn = corners(cx, cy, cz, sx, sy, sz);
    for (const f of faces) {
      const base = pos.length / 3;
      for (const ci of f.c) {
        pos.push(cn[ci * 3]!, cn[ci * 3 + 1]!, cn[ci * 3 + 2]!);
        nrm.push(faceNormals[f.n]!);
        uv.push(ci % 2 === 0 ? 0 : 63, (ci >> 1) % 2 === 0 ? 0 : 63);
      }
      for (let k = 0; k < f.c.length; k += 3) {
        tri.push(base + k, base + k + 1, base + k + 2);
      }
    }
  }
  const nv = pos.length / 3;
  const nt = tri.length / 3;
  const frames = new Float32Array([...pos, ...pos.map((v, i) => (i % 3 === 0 ? v - recoilX : v))]);
  return {
    frames,
    normals: new Uint8Array([...nrm, ...nrm]),
    numVerts: nv,
    numFrames: 2,
    tris: new Uint16Array(tri),
    numTris: nt,
    st: new Float32Array(uv),
  };
}

/**
 * Flat gunmetal skin for the fallback gun mesh (64x64): vertical gradient
 * with a top highlight row. Indices are palette-relative like every other
 * skin — any reasonable palette shades it.
 */
export function createGunSkin(): { texels: Uint8Array; width: number; height: number } {
  const w = 64, h = 64;
  const texels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 96 + ((y * 44) / (h - 1)) | 0;
      if (y < 6) v += 34; // top highlight
      if (x >= 8 && x < 22 && y >= 40) v -= 26; // grip shadow
      texels[y * w + x] = v & 255;
    }
  }
  return { texels, width: w, height: h };
}

/**
 * Olive-drab fallback skin for real MD2 monsters whose skin handle is
 * missing (64x64): vertical uniform gradient with a helmet highlight band
 * and dark limb shadows. Palette-relative like every other skin, so a
 * wired-but-skinless soldier still reads as a soldier instead of a
 * checker-textured box.
 */
export function createSoldierSkin(): { texels: Uint8Array; width: number; height: number } {
  const w = 64, h = 64;
  const texels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 100 + ((y * 40) / (h - 1)) | 0;
      if (y < 8) v += 22; // helmet highlight
      if ((x < 12 || x >= w - 12) && y >= 28) v -= 26; // arm shadows
      if (x >= 24 && x < 40 && y >= 44) v -= 18; // leg shadow
      texels[y * w + x] = v & 255;
    }
  }
  return { texels, width: w, height: h };
}

export interface AliasInstance {
  mesh: AliasMesh;
  origin: Float32Array;
  angles: Float32Array;
  frameA: number; frameB: number; lerp: number;
  /** yaw-quantised light angle 0..255 */
  lightAngle: number;
  /**
   * Depth-bias multiplier on stored 1/z (Entity.depthHack feeds
   * DEPTHHACK_SCALE here; default 1 = unbiased). Screen x/y projection
   * always uses the true 1/vz — only the depth value is scaled.
   */
  depthScale?: number;
}

/**
 * RF_DEPTHHACK bias (ref_soft `s_ziscale *= 3`, r_alias.c): the
 * eye-anchored viewmodel's stored 1/z is tripled so the gun wins the
 * depth test against walls it would otherwise sit inside. Larger stored
 * 1/z = nearer (fillAffineTri keeps `iz > zb`).
 */
export const DEPTHHACK_SCALE = 3;

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
  ensureAliasScratch(nv);
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
  const depthScale = inst.depthScale ?? 1;
  // Hoisted: identical for every vert of this instance (was recomputed
  // per vert with the same result).
  const shadeFrame = t < 0.5 ? inst.frameA : inst.frameB;
  let pixels = 0;
  const tv: TriVert[] = aliasTri;
  for (let ti = 0; ti < mesh.numTris; ti++) {
    // To view space first (no projection yet); u/v + shade grade ride
    // along so the near-plane clip below can interpolate them.
    let allIn = true;
    for (let k = 0; k < 3; k++) {
      const vi = mesh.tris[ti * 3 + k]!;
      // to view space
      const px = wx[vi]! - cam.origin[0]!;
      const py = wy[vi]! - cam.origin[1]!;
      const pz = wz[vi]! - cam.origin[2]!;
      const vx = px * cam.right[0]! + py * cam.right[1]! + pz * cam.right[2]!;
      const vy = px * cam.up[0]! + py * cam.up[1]! + pz * cam.up[2]!;
      const vz2 = px * cam.forward[0]! + py * cam.forward[1]! + pz * cam.forward[2]!;
      clipIX[k] = vx; clipIY[k] = vy; clipIZ[k] = vz2;
      clipIU[k] = mesh.st[vi * 2]!;
      clipIV[k] = mesh.st[vi * 2 + 1]!;
      const ni = mesh.normals[(shadeFrame * nv + vi) % mesh.normals.length]! % ANORM_COUNT;
      clipIG[k] = shadeDots[row + ni]!;
      if (vz2 < cam.near) allIn = false;
    }
    if (allIn) {
      // Fast path (bit-identical to the old project-then-draw): no vert
      // near the plane, so no clipping. Devroom/world geometry always
      // lands here — the clip below only triggers for eye-anchored
      // viewmodel tris straddling vz = near.
      for (let k = 0; k < 3; k++) {
        const v = tv[k]!;
        const iz = 1 / clipIZ[k]!;
        v.x = cam.xCenter + clipIX[k]! * cam.focalX * iz;
        v.y = cam.yCenter - clipIY[k]! * cam.focalY * iz;
        v.iz = iz * depthScale;
        v.u = clipIU[k]!;
        v.v = clipIV[k]!;
        v.grade = clipIG[k]!;
      }
      pixels += fillAffineTri(idx, zb, fbW, fbH, tv[0]!, tv[1]!, tv[2]!, skin, colormap);
      continue;
    }
    // Straddler: Sutherland clip the view-space polygon at vz = near
    // (r_aclip.c R_ClipPolyPlane / ALIAS_Z_CLIP_PLANE semantics — keep the
    // visible part, never drop the whole tri), then project the cut verts
    // with the same focal math and emit 1-2 tris. Backface cull applies
    // per emitted tri inside fillAffineTri.
    const m = clipPolyNear(cam.near);
    if (m < 3) continue;
    for (let k = 0; k < m; k++) {
      const c = aliasClipped[k]!;
      const iz = 1 / clipOZ[k]!;
      c.x = cam.xCenter + clipOX[k]! * cam.focalX * iz;
      c.y = cam.yCenter - clipOY[k]! * cam.focalY * iz;
      c.iz = iz * depthScale;
      c.u = clipOU[k]!;
      c.v = clipOV[k]!;
      c.grade = clipOG[k]!;
    }
    pixels += fillAffineTri(idx, zb, fbW, fbH,
      aliasClipped[0]!, aliasClipped[1]!, aliasClipped[2]!, skin, colormap);
    if (m === 4) {
      pixels += fillAffineTri(idx, zb, fbW, fbH,
        aliasClipped[0]!, aliasClipped[2]!, aliasClipped[3]!, skin, colormap);
    }
  }
  return pixels;
}

let aliasScratchX = new Float32Array(4096);
let aliasScratchY = new Float32Array(4096);
let aliasScratchZ = new Float32Array(4096);

/** Grow world-vert scratch for meshes larger than the default 4096 verts
 * (register-time-sized real MD2s). Amortised: allocates only on a new max. */
function ensureAliasScratch(nv: number): void {
  if (nv <= aliasScratchX.length) return;
  aliasScratchX = new Float32Array(nv);
  aliasScratchY = new Float32Array(nv);
  aliasScratchZ = new Float32Array(nv);
}
const aliasTri: TriVert[] = [
  { x: 0, y: 0, iz: 0, u: 0, v: 0, grade: 0 },
  { x: 0, y: 0, iz: 0, u: 0, v: 0, grade: 0 },
  { x: 0, y: 0, iz: 0, u: 0, v: 0, grade: 0 },
];

/**
 * View-space near-plane clip scratch (Sutherland against the single plane
 * vz = near, r_aclip.c R_ClipPolyPlane semantics). Input polygon = the
 * tri (3 verts); output = up to 4 verts. Module-scope so the frame loop
 * never allocates. Float64: the projection math consumes full float64
 * intermediates exactly like the old direct path, so the all-inside fast
 * path stays bit-identical (Float32 rounding here changed the golden).
 */
const clipIX = new Float64Array(4);
const clipIY = new Float64Array(4);
const clipIZ = new Float64Array(4);
const clipIU = new Float64Array(4);
const clipIV = new Float64Array(4);
const clipIG = new Float64Array(4);
const clipOX = new Float64Array(4);
const clipOY = new Float64Array(4);
const clipOZ = new Float64Array(4);
const clipOU = new Float64Array(4);
const clipOV = new Float64Array(4);
const clipOG = new Float64Array(4);
const aliasClipped: TriVert[] = [
  { x: 0, y: 0, iz: 0, u: 0, v: 0, grade: 0 },
  { x: 0, y: 0, iz: 0, u: 0, v: 0, grade: 0 },
  { x: 0, y: 0, iz: 0, u: 0, v: 0, grade: 0 },
  { x: 0, y: 0, iz: 0, u: 0, v: 0, grade: 0 },
];

/**
 * Sutherland clip of the tri in (clipIX..clipIG) against vz >= near,
 * emitting the kept polygon into (clipOX..clipOG). Returns the kept
 * vert count (0..4). Cut verts linearly interpolate every carried
 * channel (view coords + u/v + shade grade) at the plane crossing;
 * vertex order is preserved so the quad fan (0,1,2)+(0,2,3) keeps the
 * original winding.
 */
function clipPolyNear(near: number): number {
  let m = 0;
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const zin = clipIZ[i]! >= near;
    const zjn = clipIZ[j]! >= near;
    if (zin && zjn) {
      clipOX[m] = clipIX[j]!; clipOY[m] = clipIY[j]!; clipOZ[m] = clipIZ[j]!;
      clipOU[m] = clipIU[j]!; clipOV[m] = clipIV[j]!; clipOG[m] = clipIG[j]!;
      m++;
    } else if (zin !== zjn) {
      // Mixed edge: exactly one endpoint inside (denominator nonzero —
      // equal depths would put both endpoints on the same side).
      const tt = (near - clipIZ[i]!) / (clipIZ[j]! - clipIZ[i]!);
      clipOX[m] = clipIX[i]! + (clipIX[j]! - clipIX[i]!) * tt;
      clipOY[m] = clipIY[i]! + (clipIY[j]! - clipIY[i]!) * tt;
      clipOZ[m] = near;
      clipOU[m] = clipIU[i]! + (clipIU[j]! - clipIU[i]!) * tt;
      clipOV[m] = clipIV[i]! + (clipIV[j]! - clipIV[i]!) * tt;
      clipOG[m] = clipIG[i]! + (clipIG[j]! - clipIG[i]!) * tt;
      m++;
      if (!zin && zjn) {
        clipOX[m] = clipIX[j]!; clipOY[m] = clipIY[j]!; clipOZ[m] = clipIZ[j]!;
        clipOU[m] = clipIU[j]!; clipOV[m] = clipIV[j]!; clipOG[m] = clipIG[j]!;
        m++;
      }
    }
  }
  return m;
}

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
