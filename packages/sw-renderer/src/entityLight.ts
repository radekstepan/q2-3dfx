// @q2/sw-renderer entityLight — R_LightPoint + R_AliasSetupLighting equivalent.
//
// Original ref_soft lights alias models by sampling the static lightmap at
// the entity origin (RecursiveLightPoint: straight down 2048 units, first
// lit face wins, styles scale the sample) plus dynamic lights by distance
// (R_LightPoint), then maps the averaged sample through the
// ambient/shade/clamp chain in R_AliasSetupLighting and the per-vertex
// colormap lookup in R_AliasTransformFinalVerts. The static sample is the
// Mod_LoadLighting mono value (brightest of the luxel's RGB channels).
//
// The previous port shaded every entity with a fixed table
// (buildShadeDots: ambient 12 + directional 0..51, 45-degree elevation,
// yaw-only) so two barrels at different distances from a light read
// identically. This module restores the position-dependent term, keeping
// id's colormap-row semantics: shade row r carries brightness
// (255-4r)/128 (row 32 ~= 1.0, row 0 ~= 2x overbright, row 63 near
// black — measured byte-exact against pics/colormap.pcx), so our 0..63
// grade is round(63 * (255-4r)/128).
//
// Backend split (matches the originals): the software path folds the
// static RGB sample through entityMonoSample (ref_soft mono) and the
// ambient/shade clamps; the WebGL path (ref_gl emulation) keeps the full
// RGB sample and shades per channel with a gentle directional factor
// (see webgl-renderer aliasShadeBase) — no clamps, no inversion.

import type { MiniWorld } from './worldNodes.js';
import type { DynamicLight } from './light.js';
import { LIGHT_STYLE_UNUSED } from './light.js';

/** Lowest light value id allows (r_alias.c LIGHT_MIN). */
export const ENTITY_LIGHT_MIN = 5;

/** Spatial index cell size (world units) for the downward light trace. */
export const ENTITY_LIGHT_CELL = 256;
/** Surfaces covering more than this many cells ride the always-checked list. */
const ENTITY_LIGHT_LARGE_CELLS = 64;

interface EntityLightIndex {
  minCX: number; minCY: number;
  sizeX: number; sizeY: number;
  cells: number[][];
  large: number[];
}

const lightIndexCache = new WeakMap<MiniWorld, EntityLightIndex>();

function lightIndexFor(world: MiniWorld): EntityLightIndex | null {
  const hit = lightIndexCache.get(world);
  if (hit) return hit;
  const surfs = world.surfaces;
  if (!surfs || surfs.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < surfs.length; i++) {
    const s = surfs[i]!;
    if (s.n < 3 || s.sky || s.turbulent) continue;
    if (s.mins[0]! < minX) minX = s.mins[0]!;
    if (s.mins[1]! < minY) minY = s.mins[1]!;
    if (s.maxs[0]! > maxX) maxX = s.maxs[0]!;
    if (s.maxs[1]! > maxY) maxY = s.maxs[1]!;
  }
  if (!Number.isFinite(minX)) return null;
  const minCX = Math.floor(minX / ENTITY_LIGHT_CELL);
  const minCY = Math.floor(minY / ENTITY_LIGHT_CELL);
  const sizeX = Math.floor(maxX / ENTITY_LIGHT_CELL) - minCX + 1;
  const sizeY = Math.floor(maxY / ENTITY_LIGHT_CELL) - minCY + 1;
  if (sizeX <= 0 || sizeY <= 0 || sizeX > 256 || sizeY > 256) return null;
  const cells: number[][] = new Array(sizeX * sizeY);
  for (let i = 0; i < cells.length; i++) cells[i] = [];
  const large: number[] = [];
  for (let si = 0; si < surfs.length; si++) {
    const s = surfs[si]!;
    if (s.n < 3 || s.sky || s.turbulent) continue;
    const cx0 = Math.floor(s.mins[0]! / ENTITY_LIGHT_CELL) - minCX;
    const cx1 = Math.floor(s.maxs[0]! / ENTITY_LIGHT_CELL) - minCX;
    const cy0 = Math.floor(s.mins[1]! / ENTITY_LIGHT_CELL) - minCY;
    const cy1 = Math.floor(s.maxs[1]! / ENTITY_LIGHT_CELL) - minCY;
    const w = cx1 - cx0 + 1, h = cy1 - cy0 + 1;
    if (w * h > ENTITY_LIGHT_LARGE_CELLS) { large.push(si); continue; }
    for (let cy = Math.max(0, cy0); cy <= Math.min(sizeY - 1, cy1); cy++) {
      for (let cx = Math.max(0, cx0); cx <= Math.min(sizeX - 1, cx1); cx++) {
        cells[cy * sizeX + cx]!.push(si);
      }
    }
  }
  const idx: EntityLightIndex = { minCX, minCY, sizeX, sizeY, cells, large };
  lightIndexCache.set(world, idx);
  return idx;
}

/** Test hook: clear the per-world light-trace index (forces a rebuild). */
export function testClearEntityLightIndex(): void {
  // WeakMap has no clear; callers drop worlds. Kept for API symmetry.
}

/** Fixed world-space light direction id uses for alias shading. */
export const ENTITY_LIGHTVEC = [-1, 0, 0] as const;

/** RF_* bits we honour without a contract change (q_shared.h). */
export const RF_MINLIGHT_BIT = 1;
export const RF_FULLBRIGHT_BIT = 8;
export const RF_GLOW_BIT = 512;

/**
 * Static lightmap sample at an entity origin (RecursiveLightPoint core).
 * Straight-down segment p -> p-(0,0,2048); first non-sky/non-warp face
 * containing the XY and pierced by the segment wins. Luxel coords come
 * from an affine solve off the first non-collinear vertex triple (same
 * convention as luxelWorldPositions: lux is linear in world position, so
 * this reproduces id's direct texinfo evaluation at the hit point and
 * covers concave polygons fully). A luxel-invalid nearest hit is skipped
 * in favour of farther faces (id's `continue`), and an indexed miss falls
 * back to a full scan (id always walks the whole BSP). Styles scale the
 * single stored block (consistent with buildLightMap: one block x summed
 * style scales). Miss (or empty world) reads black, exactly like id
 * (pointcolor stays zero when r == -1 is not taken).
 */
export function sampleStaticEntityLight(
  world: MiniWorld,
  origin: Float32Array,
  lightStyles: Float32Array,
  out?: Float32Array,
): Float32Array {
  const rgb = out ?? new Float32Array(3);
  rgb[0] = 0; rgb[1] = 0; rgb[2] = 0;
  const surfs = world.surfaces;
  if (!surfs || surfs.length === 0) return rgb;
  const ox = origin[0]!, oy = origin[1]!, oz = origin[2]!;
  const endZ = oz - 2048;
  // Candidate set from the XY spatial index (plus the large-surface list);
  // falls back to a full scan when the index is unavailable (tiny worlds).
  const idx = lightIndexFor(world);
  let cand: number[] | null = null;
  if (idx) {
    const cx = Math.floor(ox / ENTITY_LIGHT_CELL) - idx.minCX;
    const cy = Math.floor(oy / ENTITY_LIGHT_CELL) - idx.minCY;
    if (cx < 0 || cy < 0 || cx >= idx.sizeX || cy >= idx.sizeY) {
      // Outside the indexed bounds: only huge surfaces can still cover us.
      cand = null;
    } else {
      cand = idx.cells[cy * idx.sizeX + cx]!;
    }
  }
  const visit = (si: number): boolean => {
    const s = surfs[si]!;
    if (s.n < 3) return false;
    if (s.sky || s.turbulent) return false;
    const mins = s.mins, maxs = s.maxs;
    if (ox < mins[0]! || ox > maxs[0]!) return false;
    if (oy < mins[1]! || oy > maxs[1]!) return false;
    if (maxs[2]! < endZ || mins[2]! > oz) return false;
    return true;
  };
  let bestT = Infinity;
  let bestDs = 0;
  let bestDt = 0;
  let bestSurf = -1;
  const testSurf = (si: number): void => {
    const s = surfs[si]!;
    if (!visit(si)) return;
    const fn = s.fn;
    const d0 = fn[0]! * s.verts[0]! + fn[1]! * s.verts[1]! + fn[2]! * s.verts[2]!;
    const ds = fn[0]! * ox + fn[1]! * oy + fn[2]! * oz - d0;
    const de = fn[0]! * ox + fn[1]! * oy + fn[2]! * endZ - d0;
    if (ds > 0 && de > 0) return;
    if (ds < 0 && de < 0) return;
    const denom = ds - de;
    if (denom === 0) return;
    const t = ds / denom;
    if (!(t >= 0 && t <= 1)) return;
    if (t >= bestT) return;
    // Project onto the dominant plane for the inside + lux tests.
    // drop 0 (X): 2D=(y,z); drop 1 (Y): 2D=(x,z); drop 2 (Z): 2D=(x,y).
    const ax = Math.abs(fn[0]!), ay = Math.abs(fn[1]!), az = Math.abs(fn[2]!);
    let drop: 0 | 1 | 2;
    if (ax >= ay && ax >= az) drop = 0;
    else if (ay >= ax && ay >= az) drop = 1;
    else drop = 2;
    const hxx = drop === 0 ? oy : ox;
    const hyy = drop === 2 ? oy : oz - 2048 * t;
    const n = s.n;
    const verts = s.verts;
    // Even-odd inside test in the projected frame.
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const vix = drop === 0 ? verts[i * 3 + 1]! : verts[i * 3]!;
      const viy = drop === 2 ? verts[i * 3 + 1]! : verts[i * 3 + 2]!;
      const vjx = drop === 0 ? verts[j * 3 + 1]! : verts[j * 3]!;
      const vjy = drop === 2 ? verts[j * 3 + 1]! : verts[j * 3 + 2]!;
      if ((viy > hyy) !== (vjy > hyy)) {
        const xt = vix + ((hyy - viy) / (vjy - viy)) * (vjx - vix);
        if (hxx < xt) inside = !inside;
      }
    }
    if (!inside) return;
    // Affine luxel solve from the first non-collinear vertex triple in the
    // projected frame (same convention as luxelWorldPositions in light.ts):
    // lux is linear in world position on the plane, so this reproduces id's
    // direct texinfo evaluation at the hit point up to float error — and,
    // unlike the old vert-0 fan triangulation, it covers concave polygons
    // fully instead of blacking out entities over a reflex vertex.
    const lux = s.lux;
    const x0 = drop === 0 ? verts[1]! : verts[0]!;
    const y0 = drop === 2 ? verts[1]! : verts[2]!;
    const l0s = lux[0]!, l0t = lux[1]!;
    let ls = 0, lt = 0;
    let found = false;
    for (let a = 1; a < n && !found; a++) {
      const xax = (drop === 0 ? verts[a * 3 + 1]! : verts[a * 3]!) - x0;
      const yax = (drop === 2 ? verts[a * 3 + 1]! : verts[a * 3 + 2]!) - y0;
      const esa = lux[a * 2]! - l0s, eta = lux[a * 2 + 1]! - l0t;
      for (let b = a + 1; b < n; b++) {
        const xbx = (drop === 0 ? verts[b * 3 + 1]! : verts[b * 3]!) - x0;
        const ybx = (drop === 2 ? verts[b * 3 + 1]! : verts[b * 3 + 2]!) - y0;
        const esb = lux[b * 2]! - l0s, etb = lux[b * 2 + 1]! - l0t;
        const det = xax * ybx - xbx * yax;
        const m1 = xax * xax + yax * yax, m2 = xbx * xbx + ybx * ybx;
        if (!(det * det > 1e-12 * m1 * m2)) continue;
        const inv = 1 / det;
        const u = ((hxx - x0) * ybx - (hyy - y0) * xbx) * inv;
        const v = (xax * (hyy - y0) - yax * (hxx - x0)) * inv;
        ls = l0s + u * esa + v * esb;
        lt = l0t + u * eta + v * etb;
        found = true;
        break;
      }
    }
    if (!found) return;
    // Luxel-range gate BEFORE accepting the hit: id's RecursiveLightPoint
    // `continue`s past out-of-extents surfaces to farther ones instead of
    // going black. Accept only the nearest luxel-valid surface.
    const lm = world.lightmaps[s.lightId % world.lightmaps.length]!;
    if (lm.luxW < 1 || lm.luxH < 1) return;
    if (!(ls >= 0 && lt >= 0 && ls < lm.luxW && lt < lm.luxH)) return;
    bestT = t;
    bestDs = ls;
    bestDt = lt;
    bestSurf = si;
  };
  if (idx && cand) {
    for (let k = 0; k < cand.length; k++) testSurf(cand[k]!);
    const large = idx.large;
    for (let k = 0; k < large.length; k++) testSurf(large[k]!);
    // Outside-index fallback is covered by the large list; a null cand with
    // no index means a tiny world — scan everything.
    if (cand.length === 0 && idx.large.length === 0) {
      for (let si = 0; si < surfs.length; si++) testSurf(si);
    }
  } else if (idx) {
    const large = idx.large;
    for (let k = 0; k < large.length; k++) testSurf(large[k]!);
  } else {
    for (let si = 0; si < surfs.length; si++) testSurf(si);
  }
  if (bestSurf < 0) return rgb;
  const surf = surfs[bestSurf]!;
  const lm = world.lightmaps[surf.lightId % world.lightmaps.length]!;
  const luxW = lm.luxW, luxH = lm.luxH;
  // +1e-4 before floor: float interpolation lands exact luxel boundaries at
  // x.9999999 where C int truncation reads x+1 (observed off-by-one on
  // base1 face 4316). Interior fractions are unaffected.
  const ix = Math.floor(bestDs + 1e-4), iy = Math.floor(bestDt + 1e-4);
  if (ix < 0 || iy < 0 || ix >= luxW || iy >= luxH) return rgb;
  const o = (iy * luxW + ix) * 3;
  // Summed style scales (single stored block, like buildLightMap).
  let scale = 0;
  let valid = 0;
  for (let k = 0; k < lm.styles.length; k++) {
    const st = lm.styles[k]!;
    if (st === LIGHT_STYLE_UNUSED) continue;
    scale += lightStyles[st] ?? 0;
    valid++;
  }
  if (valid === 0) scale = 1;
  rgb[0] = (lm.samples[o]! / 255) * scale;
  rgb[1] = (lm.samples[o + 1]! / 255) * scale;
  rgb[2] = (lm.samples[o + 2]! / 255) * scale;
  return rgb;
}

/**
 * Reduce a per-channel static sample to the mono value id's software
 * renderer uses (r_model.c Mod_LoadLighting converts the 24-bit lighting
 * lump to 8-bit by taking the brightest component of each luxel; the
 * R_LightPoint sample is that mono byte / 255, scaled by the style).
 * The GL backend keeps all three channels (gl_mesh.c shades per channel);
 * only the software path folds through here.
 */
export function entityMonoSample(rgb: Float32Array): number {
  const r = rgb[0]!, g = rgb[1]!, b = rgb[2]!;
  return r >= g ? (r >= b ? r : b) : (g >= b ? g : b);
}

/**
 * Add R_LightPoint dynamic lights at the entity origin (linear falloff
 * (intensity - dist) / 256, id r_light.c). Mutates/returns out.
 */
export function addEntityDynamicLights(
  rgb: Float32Array,
  origin: Float32Array,
  dlights: DynamicLight[],
  out?: Float32Array,
): Float32Array {
  const o = out ?? rgb;
  if (o !== rgb) { o[0] = rgb[0]!; o[1] = rgb[1]!; o[2] = rgb[2]!; }
  for (let i = 0; i < dlights.length; i++) {
    const dl = dlights[i]!;
    const dx = origin[0]! - dl.origin[0]!;
    const dy = origin[1]! - dl.origin[1]!;
    const dz = origin[2]! - dl.origin[2]!;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const add = (dl.intensity - dist) / 256;
    if (add > 0) {
      o[0]! += add * dl.color[0]!;
      o[1]! += add * dl.color[1]!;
      o[2]! += add * dl.color[2]!;
    }
  }
  return o;
}

/**
 * R_AliasSetupLighting ambient/shade chain (r_alias.c). j is the averaged
 * sample x255; fullbright/minlight/glow adjust the sample first; the
 * 128/192 clamps follow.
 */
export function aliasAmbientShade(
  sample: Float32Array,
  opts: { fullbright?: boolean; minlight?: boolean; glow?: boolean; time?: number } = {},
): { ambient: number; shade: number } {
  let r = sample[0]!, g = sample[1]!, b = sample[2]!;
  if (opts.fullbright) { r = 1; g = 1; b = 1; }
  if (opts.minlight) {
    if (r < 0.1) r = 0.1;
    if (g < 0.1) g = 0.1;
    if (b < 0.1) b = 0.1;
  }
  if (opts.glow) {
    const t = opts.time ?? 0;
    const s = 0.1 * Math.sin(t * 7);
    let m = r * 0.8; r += s; if (r < m) r = m;
    m = g * 0.8; g += s; if (g < m) g = m;
    m = b * 0.8; b += s; if (b < m) b = m;
  }
  const j = ((r + g + b) * 0.3333) * 255;
  let ambient = j, shade = j;
  if (ambient > 128) ambient = 128;
  if (ambient + shade > 192) shade = 192 - ambient;
  return { ambient, shade };
}

/**
 * Rotate id's fixed (-1,0,0) alias lightvec into the entity model frame
 * (r_alias.c tail of R_AliasSetupLighting). Basis from AngleVectors.
 */
export function plightvecForAngles(angles: Float32Array, out?: Float32Array): Float32Array {
  const p = (angles[0]! * Math.PI) / 180;
  const y = (angles[1]! * Math.PI) / 180;
  const r = (angles[2]! * Math.PI) / 180;
  const sp = Math.sin(p), cp = Math.cos(p);
  const sy = Math.sin(y), cy = Math.cos(y);
  const sr = Math.sin(r), cr = Math.cos(r);
  const fx = cp * cy, fy = cp * sy, fz = -sp;
  const rx = -sr * sp * cy + cr * sy;
  const ry = -sr * sp * sy - cr * cy;
  const rz = -sr * cp;
  const ux = cr * sp * cy + sr * sy;
  const uy = cr * sp * sy - sr * cy;
  const uz = cr * cp;
  // lightvec (-1,0,0): [dot(L,F), -dot(L,R), dot(L,U)] = [-fx, rx, -ux].
  const o = out ?? new Float32Array(3);
  o[0] = -fx; o[1] = rx; o[2] = -ux;
  void fy; void fz; void ry; void rz; void uy; void uz;
  return o;
}

/**
 * Map an R_AliasTransformFinalVerts light value to our 0..63 colormap
 * grade. temp is the C integer (r_ambient + trunc(shade*cos), clamped
 * >= 0); r = temp>>8 is the id colormap row (0 = brightest). Measured
 * against pics/colormap.pcx, id row r carries brightness (255-4r)/128,
 * so the grade is round(63 * (255-4r)/128), clamped — the same luma rule
 * as the world surface cache (grade = round(luma*63)). Rows at/above
 * 1.0 (r <= 31) saturate to fullbright, like the world path's luma clamp.
 */
export function aliasGradeFromTemp(temp: number): number {
  const r = temp >> 8;
  const l = 255 - 4 * r;
  if (l <= 0) return 0;
  if (l >= 128) return 63;
  return Math.round((63 * l) / 128);
}

/**
 * Per-vertex colormap grade 0..63 for one normal under an ambient/shade
 * pair (R_AliasSetupLighting + R_AliasTransformFinalVerts integer path,
 * mapped through aliasGradeFromTemp). Bit-faithful to the C truncation:
 * temp starts at (255-ambient)<<6 with LIGHT_MIN clamps, adds
 * trunc(shade*64*cos) when the normal faces away from the lightvec.
 */
export function aliasGradeForNormal(
  ambient: number,
  shade: number,
  plight: Float32Array,
  nx: number, ny: number, nz: number,
): number {
  let ra = ambient;
  if (ra < ENTITY_LIGHT_MIN) ra = ENTITY_LIGHT_MIN;
  ra = (255 - ra) * 64;
  if (ra < ENTITY_LIGHT_MIN) ra = ENTITY_LIGHT_MIN;
  let rs = shade;
  if (rs < 0) rs = 0;
  rs *= 64;
  const cos = nx * plight[0]! + ny * plight[1]! + nz * plight[2]!;
  let temp = ra;
  if (cos < 0) {
    temp += Math.trunc(rs * cos);
    if (temp < 0) temp = 0;
  }
  return aliasGradeFromTemp(temp);
}
