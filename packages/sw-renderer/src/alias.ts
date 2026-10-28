// @q2/sw-renderer alias — r_alias.c / d_polyse.c equivalent.
// MD2-style meshes drawn as affine triangles (screen-space linear u,v)
// with per-vertex lighting from shade dots (anorms table).

import type { Camera } from './camera.js';
import {
  packRGB565, rgbBlendPixel565, rgbMipLevel, rgbModulate, rgbPickMipLevel,
  rgbSampleTexture, rgbWrapCoord, windowDepthQ16,
  DEFAULT_RGB_FAR, DEFAULT_RGB_NEAR,
  type RGBBlend, type RGBMaterial, type RGBWindow,
} from './spans.js';
import type { DynamicLight } from './light.js';

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
  /**
   * Translucency 0..1 (Entity.alpha; default 1 = opaque). Implemented as
   * deterministic 4x4 Bayer screen-door: pixels whose threshold exceeds
   * alpha are skipped, so fading explosions read as translucent on the
   * 8-bit path without any blending pass. Values clamp to [0,1].
   */
  alpha?: number;
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
  // Entity basis (R_AliasSetUpTransform in ref_soft/r_alias.c): the model
  // frame maps +X to the entity forward vector, so
  //   world = origin + lx*F - ly*R + lz*U
  // (the -R column is id's, not a typo: aliasworldtransform[][1] holds
  // -s_alias_right). The old code did yaw-then-pitch-about-X instead, so at
  // pitch != 0 the hand swung toward the near plane ("cutoff limb above").
  // Formula mirrors @q2/math AngleVectors (q_shared.c: pitch positive =
  // down, +X fwd +Y left +Z up), inlined in float64: AngleVectors writes
  // Float32Array outs, whose rounding would move the pitch-0 path off the
  // old yaw-about-Z bits. At pitch=roll=0 this reduces to it bit-for-bit.
  const pitchR = (inst.angles[0]! * Math.PI) / 180;
  const yawR = (inst.angles[1]! * Math.PI) / 180;
  const rollR = (inst.angles[2]! * Math.PI) / 180;
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
  const eox = inst.origin[0]!, eoy = inst.origin[1]!, eoz = inst.origin[2]!;
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
    // R_AliasSetUpTransform columns (F, -R, U), then translate. Operation
    // order ((lx*F - ly*R) + lz*U) + origin keeps pitch-0/roll-0 bit-identical
    // to the old yaw-about-Z path (mult commutes exactly; +0 is exact).
    wx[i] = lx * fxx - ly * rxx + lz * uxx + eox;
    wy[i] = lx * fxy - ly * rxy + lz * uxy + eoy;
    wz[i] = lx * fxz - ly * rxz + lz * uxz + eoz;
  }
  void anorms;
  const row = (inst.lightAngle & 255) * ANORM_COUNT;
  const depthScale = inst.depthScale ?? 1;
  const alpha = inst.alpha;
  // Fully transparent: no pixels, no depth writes (freed-sky style fade).
  if (alpha !== undefined && alpha <= 0) return 0;
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
      pixels += fillAffineTri(idx, zb, fbW, fbH, tv[0]!, tv[1]!, tv[2]!, skin, colormap, alpha);
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
      aliasClipped[0]!, aliasClipped[1]!, aliasClipped[2]!, skin, colormap, alpha);
    if (m === 4) {
      pixels += fillAffineTri(idx, zb, fbW, fbH,
        aliasClipped[0]!, aliasClipped[2]!, aliasClipped[3]!, skin, colormap, alpha);
    }
  }
  return pixels;
}

/**
 * Clamp an RF_FRAMELERP blend to [0,1]; non-finite -> 0 (no lerp).
 * Pure helper so the frame path and tests share one rule.
 */
export function clampBacklerp(t: number | undefined): number {
  if (!Number.isFinite(t as number)) return 0;
  const v = t as number;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 4x4 Bayer threshold matrix (row-major), scaled to [0,1). */
const BAYER4 = new Float32Array([
  0 / 16, 8 / 16, 2 / 16, 10 / 16,
  12 / 16, 4 / 16, 14 / 16, 6 / 16,
  3 / 16, 11 / 16, 1 / 16, 9 / 16,
  15 / 16, 7 / 16, 13 / 16, 5 / 16,
]);

/**
 * Screen-door keep test for alias translucency (Entity.alpha): opaque when
 * alpha >= 1 (or unset/non-finite), fully skipped when alpha <= 0, else keep
 * the pixel when its 4x4 Bayer threshold is below alpha. Pure + deterministic.
 */
export function aliasAlphaKeeps(x: number, y: number, alpha: number | undefined): boolean {
  if (alpha === undefined) return true;
  if (!Number.isFinite(alpha) || alpha >= 1) return true;
  if (alpha <= 0) return false;
  const t = BAYER4[((y & 3) << 2) + (x & 3)]!;
  return t < alpha;
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

/** Affine triangle filler: linear u/v/grade in screen space, 1/z depth test.
 * Optional `alpha` (Entity.alpha, default opaque): deterministic 4x4 Bayer
 * screen-door — pixels whose threshold exceeds alpha are skipped entirely
 * (no depth write), so fading explosions read as translucent. Opaque fast
 * path (alpha undefined or >= 1) is bit-identical to the old filler. */
export function fillAffineTri(
  idx: Uint8Array,
  zb: Float32Array,
  fbW: number,
  fbH: number,
  a: TriVert, b: TriVert, c: TriVert,
  skin: AliasSkin,
  colormap: Uint8Array,
  alpha?: number,
): number {
  // backface cull (screen-space winding)
  const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  if (area <= 0) return 0;
  if (alpha !== undefined && alpha <= 0) return 0;
  const translucent = alpha !== undefined && Number.isFinite(alpha) && (alpha as number) < 1;
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
      // Screen-door translucency: skip (no depth write) before barycentric.
      if (translucent && !aliasAlphaKeeps(x, y, alpha)) continue;
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

// --- RGB (voodoo-policy) alias path (astra step 3) ----------------------
//
// Same traversal/clipping as drawAliasInstance above (entity basis,
// frame lerp, view-space near clip, DEPTHHACK depth scale), but the filler
// is perspective-correct: u/z, v/z and 1/z interpolate linearly and u/v
// are recovered per pixel (ref_gl gl_mesh.c), replacing the affine look
// the software path keeps. Vertex lighting is per-vertex RGB (shade-dot
// base + colored dynamic lights, ref_gl R_AddDynamicLights spirit) sampled
// through the material mip chain with bilinear filtering, then modulated.
// Entity.alpha blends truly (no screen-door stipple in the RGB path).
// PORT-DIFF vs @q2/voodoo sampler.ts: same fixed-point tap math, reused
// here (rgbSampleTexture/rgbModulate); the perspective setup + Gouraud
// light interpolation are renderer-side (no voodoo import: dep allowlist
// keeps sw-renderer on bsp/config/formats/math/renderer-api).

interface PerspVert {
  x: number; y: number;
  iz: number; uiz: number; viz: number;
  r: number; g: number; b: number;
}

const aliasPersp: PerspVert[] = [
  { x: 0, y: 0, iz: 0, uiz: 0, viz: 0, r: 0, g: 0, b: 0 },
  { x: 0, y: 0, iz: 0, uiz: 0, viz: 0, r: 0, g: 0, b: 0 },
  { x: 0, y: 0, iz: 0, uiz: 0, viz: 0, r: 0, g: 0, b: 0 },
  { x: 0, y: 0, iz: 0, uiz: 0, viz: 0, r: 0, g: 0, b: 0 },
];

/** Scratch for per-vertex RGB light (grows with the mesh, like aliasScratch). */
let aliasLightR = new Float32Array(4096);
let aliasLightG = new Float32Array(4096);
let aliasLightB = new Float32Array(4096);

function ensureAliasLightScratch(nv: number): void {
  if (nv <= aliasLightR.length) return;
  aliasLightR = new Float32Array(nv);
  aliasLightG = new Float32Array(nv);
  aliasLightB = new Float32Array(nv);
}

/**
 * View-space near-plane clip that also carries per-vertex RGB light (RGB
 * alias twin of clipPolyNear). Cut verts interpolate light with the same
 * crossing parameter as position, so straddling tris shade exactly.
 */
const clipILR = new Float64Array(4);
const clipILG = new Float64Array(4);
const clipILB = new Float64Array(4);
const clipOLR = new Float64Array(4);
const clipOLG = new Float64Array(4);
const clipOLB = new Float64Array(4);

const _aliasTex = new Uint8Array(3);
const _aliasLit = new Uint8Array(3);

function clipPolyNearLight(near: number): number {
  let m = 0;
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const zin = clipIZ[i]! >= near;
    const zjn = clipIZ[j]! >= near;
    if (zin && zjn) {
      clipOX[m] = clipIX[j]!; clipOY[m] = clipIY[j]!; clipOZ[m] = clipIZ[j]!;
      clipOU[m] = clipIU[j]!; clipOV[m] = clipIV[j]!;
      clipOLR[m] = clipILR[j]!; clipOLG[m] = clipILG[j]!; clipOLB[m] = clipILB[j]!;
      m++;
    } else if (zin !== zjn) {
      const tt = (near - clipIZ[i]!) / (clipIZ[j]! - clipIZ[i]!);
      clipOX[m] = clipIX[i]! + (clipIX[j]! - clipIX[i]!) * tt;
      clipOY[m] = clipIY[i]! + (clipIY[j]! - clipIY[i]!) * tt;
      clipOZ[m] = near;
      clipOU[m] = clipIU[i]! + (clipIU[j]! - clipIU[i]!) * tt;
      clipOV[m] = clipIV[i]! + (clipIV[j]! - clipIV[i]!) * tt;
      clipOLR[m] = clipILR[i]! + (clipILR[j]! - clipILR[i]!) * tt;
      clipOLG[m] = clipILG[i]! + (clipILG[j]! - clipILG[i]!) * tt;
      clipOLB[m] = clipILB[i]! + (clipILB[j]! - clipILB[i]!) * tt;
      m++;
      if (!zin && zjn) {
        clipOX[m] = clipIX[j]!; clipOY[m] = clipIY[j]!; clipOZ[m] = clipIZ[j]!;
        clipOU[m] = clipIU[j]!; clipOV[m] = clipIV[j]!;
        clipOLR[m] = clipILR[j]!; clipOLG[m] = clipILG[j]!; clipOLB[m] = clipILB[j]!;
        m++;
      }
    }
  }
  return m;
}

/**
 * Perspective-correct triangle filler into the RGB565 authority plane.
 * Backface-culls like fillAffineTri (screen-space winding). Per-pixel: one
 * perspective divide, mip pick from the per-tri LOD, bilinear sample, mask
 * skip, modulate, window-Z depth test (LESS wins, ties keep stored, clear
 * 0xFFFF = far) then opaque-pack or 565 read-modify-write blend. Fully
 * transparent (alpha <= 0) draws nothing and writes no depth. `win` is the
 * projection window (null = default 4..4096); depth precision follows
 * mat.zbits (0 = full-precision float compare).
 */
export function fillPerspTriRGB(
  rgb565: Uint16Array,
  cover: Uint8Array,
  rgbDepth: Uint16Array,
  fbW: number,
  fbH: number,
  a: PerspVert, b: PerspVert, c: PerspVert,
  mat: RGBMaterial,
  alphaQ: number,
  blend: RGBBlend,
  depthWrite: boolean,
  win?: RGBWindow | null,
): number {
  const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  if (area <= 0) return 0;
  const levels = mat.levels;
  if (levels.length < 1) return 0;
  const maxLevel = levels.length - 1;
  // Per-tri LOD: worst texel-per-pixel edge footprint (static per tri, so
  // the per-pixel Bayer dither still varies the chosen level within it).
  // uiz/iz recover level-0 texel units, so du/dv are already texels per
  // pixel (no width multiply — cf. drawSpansRGB's dudx; multiplying by
  // base.width here forced coarse mips and dark edge-repeat averages).
  let rho = 0;
  const edges: Array<[PerspVert, PerspVert]> = [[a, b], [b, c], [c, a]];
  for (let e = 0; e < 3; e++) {
    const p = edges[e]![0], q = edges[e]![1];
    const dx = p.x - q.x, dy = p.y - q.y;
    const pix = Math.sqrt(dx * dx + dy * dy);
    if (!(pix > 0)) continue;
    const pu0 = p.uiz / p.iz, pv0 = p.viz / p.iz;
    const qu0 = q.uiz / q.iz, qv0 = q.viz / q.iz;
    const du = Math.abs(pu0 - qu0) / pix;
    const dv = Math.abs(pv0 - qv0) / pix;
    const r = du > dv ? du : dv;
    if (r > rho) rho = r;
  }
  const lod = rgbMipLevel(rho, mat.lodBias, maxLevel);
  const overbright = mat.overbright;
  const mipDither = mat.mipDither;
  const zbw = mat.zbits;
  // Alias materials are clamp-addressed (frame.ts rgbMaterialForAlias):
  // honor the binding like drawSpansRGB does. The old hardcoded repeat
  // wrapped edge taps (and the hole-test tap) to the opposite skin edge —
  // usually black gutter — fringing every UV-island border dark.
  const wrapS = mat.addressS === 'repeat';
  const wrapT = mat.addressT === 'repeat';
  const zOff = !Number.isInteger(zbw) || zbw < 1 || zbw > 23;
  const winN = win !== null && win !== undefined && win.near > 0 ? win.near : DEFAULT_RGB_NEAR;
  const winF = win !== null && win !== undefined && win.far > winN ? win.far : DEFAULT_RGB_FAR;
  const winA = winF / (winF - winN);
  const winB = (winF * winN) / (winF - winN);
  let minY = Math.max(0, Math.ceil(Math.min(a.y, b.y, c.y) - 0.5));
  const maxY = Math.min(fbH - 1, Math.floor(Math.max(a.y, b.y, c.y) - 0.5));
  if (maxY < minY) return 0;
  let pixels = 0;
  const inv = 1 / area;
  for (let y = minY; y <= maxY; y++) {
    const yc = y + 0.5;
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
      const w0 = ((b.x - xc) * (c.y - yc) - (c.x - xc) * (b.y - yc)) * inv;
      const w1 = ((c.x - xc) * (a.y - yc) - (a.x - xc) * (c.y - yc)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const iz = w0 * a.iz + w1 * b.iz + w2 * c.iz;
      const o = y * fbW + x;
      // Window-Z depth: LESS wins, ties keep stored (first wins).
      const dRaw = winA - winB * iz;
      const d01 = dRaw < 0 ? 0 : dRaw > 1 ? 1 : (dRaw === dRaw ? dRaw : 1);
      const qo = rgbDepth[o]!;
      let qn: number;
      let pass: boolean;
      if (zOff) {
        qn = Math.round(d01 * 65535) & 0xffff;
        pass = qo === 0xffff ? d01 < 1 : d01 < qo / 65535;
      } else {
        qn = windowDepthQ16(d01, zbw);
        pass = qn < qo;
      }
      if (pass) {
        const u = (w0 * a.uiz + w1 * b.uiz + w2 * c.uiz) / iz;
        const v = (w0 * a.viz + w1 * b.viz + w2 * c.viz) / iz;
        const lvl = rgbPickMipLevel(lod, x, y, mipDither, maxLevel);
        const t = levels[lvl]!;
        // UVs arrive in level-0 texel units but the picked mip is 2^lvl
        // times smaller: scale into the selected level before the hole test
        // and the sample, or full-res coords wrap/clamp into the wrong texel
        // (e.g. u=2.0 on a 2-wide mip1 reads (0,0) instead of (1,0)).
        const sc = 1 / (1 << lvl);
        const us = u * sc, vs = v * sc;
        const mx = rgbWrapCoord(us | 0, t.width, wrapS);
        const my = rgbWrapCoord(vs | 0, t.height, wrapT);
        if (t.mask[my * t.width + mx]! === 0) continue;
        rgbSampleTexture(t.data, t.width, t.height, us, vs, _aliasTex, 0, wrapS, wrapT);
        const lr = Math.round((w0 * a.r + w1 * b.r + w2 * c.r) * 255);
        const lg = Math.round((w0 * a.g + w1 * b.g + w2 * c.g) * 255);
        const lb = Math.round((w0 * a.b + w1 * b.b + w2 * c.b) * 255);
        rgbModulate(_aliasTex[0]!, _aliasTex[1]!, _aliasTex[2]!, lr, lg, lb,
          overbright, _aliasLit, 0);
        if (depthWrite) rgbDepth[o] = qn;
        if (blend === 'opaque') rgb565[o] = packRGB565(_aliasLit[0]!, _aliasLit[1]!, _aliasLit[2]!);
        else rgb565[o] = rgbBlendPixel565(rgb565[o]!, _aliasLit[0]!, _aliasLit[1]!, _aliasLit[2]!, blend, alphaQ);
        cover[o] = 1;
        pixels++;
      }
    }
  }
  return pixels;
}

/**
 * Draw one alias instance into the packed RGB565 plane (perspective-
 * correct twin of drawAliasInstance). Traversal, frame lerp, near-plane
 * clip and depthHack scale are identical; only the filler differs
 * (perspective instead of affine) and Entity.alpha blends instead of
 * stippling. `dlights` tint vertices per channel (red/blue patches keep
 * hues); pass null/[] for unlit-by-dynamics. Writes only the RGB565 +
 * window-Z planes + coverage (the caller hands the RGB-owned planes, never
 * the software ones, so the indexed path stays bit-identical).
 */
export function drawAliasInstanceRGB(
  rgb565: Uint16Array,
  cover: Uint8Array,
  rgbDepth: Uint16Array,
  fbW: number,
  fbH: number,
  inst: AliasInstance,
  mat: RGBMaterial,
  cam: Camera,
  anorms: Float32Array,
  shadeDots: Float32Array,
  dlights: DynamicLight[] | null,
  win?: RGBWindow | null,
): number {
  const mesh = inst.mesh;
  const nv = mesh.numVerts;
  ensureAliasScratch(nv);
  ensureAliasLightScratch(nv);
  const alpha = inst.alpha;
  if (alpha !== undefined && alpha <= 0) return 0;
  const translucent = alpha !== undefined && Number.isFinite(alpha) && (alpha as number) < 1;
  const alphaQ = translucent ? Math.round((alpha as number) * 256) : 256;
  const blend: RGBBlend = translucent ? 'alpha' : 'opaque';
  const depthWrite = translucent ? false : mat.depthWrite;
  const pitchR = (inst.angles[0]! * Math.PI) / 180;
  const yawR = (inst.angles[1]! * Math.PI) / 180;
  const rollR = (inst.angles[2]! * Math.PI) / 180;
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
  const eox = inst.origin[0]!, eoy = inst.origin[1]!, eoz = inst.origin[2]!;
  const fA = mesh.frames.subarray(inst.frameA * nv * 3, (inst.frameA + 1) * nv * 3);
  const fB = mesh.frames.subarray(inst.frameB * nv * 3, (inst.frameB + 1) * nv * 3);
  const t = inst.lerp;
  const wx = aliasScratchX, wy = aliasScratchY, wz = aliasScratchZ;
  for (let i = 0; i < nv; i++) {
    const lx = fA[i * 3]! + (fB[i * 3]! - fA[i * 3]!) * t;
    const ly = fA[i * 3 + 1]! + (fB[i * 3 + 1]! - fA[i * 3 + 1]!) * t;
    const lz = fA[i * 3 + 2]! + (fB[i * 3 + 2]! - fA[i * 3 + 2]!) * t;
    wx[i] = lx * fxx - ly * rxx + lz * uxx + eox;
    wy[i] = lx * fxy - ly * rxy + lz * uxy + eoy;
    wz[i] = lx * fxz - ly * rxz + lz * uxz + eoz;
  }
  void anorms;
  const row = (inst.lightAngle & 255) * ANORM_COUNT;
  const depthScale = inst.depthScale ?? 1;
  const shadeFrame = t < 0.5 ? inst.frameA : inst.frameB;
  // Per-vertex RGB light: shade-dot base (achromatic) + colored dynamics.
  for (let i = 0; i < nv; i++) {
    const ni = mesh.normals[(shadeFrame * nv + i) % mesh.normals.length]! % ANORM_COUNT;
    let r = shadeDots[row + ni]! / 63;
    let g = r, b = r;
    if (dlights) {
      for (let d = 0; d < dlights.length; d++) {
        const dl = dlights[d]!;
        const dx = dl.origin[0]! - wx[i]!;
        const dy = dl.origin[1]! - wy[i]!;
        const dz = dl.origin[2]! - wz[i]!;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const rad = dl.intensity;
        if (dist < rad && rad > 0) {
          const f = (rad - dist) / rad;
          r += f * dl.color[0]!;
          g += f * dl.color[1]!;
          b += f * dl.color[2]!;
        }
      }
    }
    aliasLightR[i] = r < 0 ? 0 : r;
    aliasLightG[i] = g < 0 ? 0 : g;
    aliasLightB[i] = b < 0 ? 0 : b;
  }
  let pixels = 0;
  const tv = aliasPersp;
  for (let ti = 0; ti < mesh.numTris; ti++) {
    let allIn = true;
    for (let k = 0; k < 3; k++) {
      const vi = mesh.tris[ti * 3 + k]!;
      const px = wx[vi]! - cam.origin[0]!;
      const py = wy[vi]! - cam.origin[1]!;
      const pz = wz[vi]! - cam.origin[2]!;
      const vx = px * cam.right[0]! + py * cam.right[1]! + pz * cam.right[2]!;
      const vy = px * cam.up[0]! + py * cam.up[1]! + pz * cam.up[2]!;
      const vz2 = px * cam.forward[0]! + py * cam.forward[1]! + pz * cam.forward[2]!;
      clipIX[k] = vx; clipIY[k] = vy; clipIZ[k] = vz2;
      clipIU[k] = mesh.st[vi * 2]!;
      clipIV[k] = mesh.st[vi * 2 + 1]!;
      clipIG[k] = 0;
      clipILR[k] = aliasLightR[vi]!;
      clipILG[k] = aliasLightG[vi]!;
      clipILB[k] = aliasLightB[vi]!;
      if (vz2 < cam.near) allIn = false;
    }
    if (allIn) {
      for (let k = 0; k < 3; k++) {
        const vi = mesh.tris[ti * 3 + k]!;
        const v = tv[k]!;
        const iz = 1 / clipIZ[k]!;
        v.x = cam.xCenter + clipIX[k]! * cam.focalX * iz;
        v.y = cam.yCenter - clipIY[k]! * cam.focalY * iz;
        // Depth bias must not alter UV mapping: the perspective numerators
        // carry the SAME scaled 1/z as v.iz, so u = uiz/iz (and the
        // uiz/iz LOD footprint) is invariant to depthScale. Storing scaled
        // iz with unscaled numerators would compress UVs by depthScale
        // (the depthHack viewmodel sampled at u/3: black + holes).
        const izs = iz * depthScale;
        v.iz = izs;
        v.uiz = clipIU[k]! * izs;
        v.viz = clipIV[k]! * izs;
        v.r = aliasLightR[vi]!;
        v.g = aliasLightG[vi]!;
        v.b = aliasLightB[vi]!;
      }
      pixels += fillPerspTriRGB(rgb565, cover, rgbDepth, fbW, fbH,
        tv[0]!, tv[1]!, tv[2]!, mat, alphaQ, blend, depthWrite, win ?? null);
      continue;
    }
    // Straddler: Sutherland clip carries position + uv + RGB light, then
    // the same projection + 1-2 persp tris as the classic path.
    const m = clipPolyNearLight(cam.near);
    if (m < 3) continue;
    for (let k = 0; k < m; k++) {
      const c = tv[k]!;
      const iz = 1 / clipOZ[k]!;
      c.x = cam.xCenter + clipOX[k]! * cam.focalX * iz;
      c.y = cam.yCenter - clipOY[k]! * cam.focalY * iz;
      // Same depth-bias/UV invariant as the all-inside path above: scale
      // the numerators with the stored 1/z so clipped tris (the
      // eye-anchored viewmodel straddles vz = near) shade identically.
      const izs = iz * depthScale;
      c.iz = izs;
      c.uiz = clipOU[k]! * izs;
      c.viz = clipOV[k]! * izs;
      c.r = clipOLR[k]!;
      c.g = clipOLG[k]!;
      c.b = clipOLB[k]!;
    }
    pixels += fillPerspTriRGB(rgb565, cover, rgbDepth, fbW, fbH,
      tv[0]!, tv[1]!, tv[2]!, mat, alphaQ, blend, depthWrite, win ?? null);
    if (m === 4) {
      pixels += fillPerspTriRGB(rgb565, cover, rgbDepth, fbW, fbH,
        tv[0]!, tv[2]!, tv[3]!, mat, alphaQ, blend, depthWrite, win ?? null);
    }
  }
  return pixels;
}
