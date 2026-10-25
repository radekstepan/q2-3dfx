// @q2/voodoo — M4.2 sampler: bilinear, mip LOD + mip-dithering, table fog,
// lightmap modulate x2, palettised textures, 256x256 cap.
//
// All texture data stays palettised (Uint8 indices, GL_EXT_shared_texture_palette
// style); expansion through the 256-entry palette happens at sample time.
// Fixed-point 8-bit fractional weights, clamp-to-edge, zero-alloc.

import { BAYER4 } from './bayer.js';

// --- Bilinear ------------------------------------------------------------

/**
 * 4-tap bilinear on a byte texture. u/v are texel coordinates (integer =
 * texel centre), clamp-to-edge. Fractional parts use 8-bit fixed-point
 * weights: acc = w00*a + w01*b + w10*c + w11*d, result (acc + 32768) >> 16
 * with the 16-bit weight products summed exactly.
 */
export function sampleBilinear(tex: Uint8Array, w: number, h: number, u: number, v: number): number {
  const uc = u < 0 ? 0 : u > w - 1 ? w - 1 : u;
  const vc = v < 0 ? 0 : v > h - 1 ? h - 1 : v;
  const x0 = uc | 0;
  const y0 = vc | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fu = Math.round((uc - x0) * 256);
  const fv = Math.round((vc - y0) * 256);
  const w00 = (256 - fu) * (256 - fv);
  const w10 = fu * (256 - fv);
  const w01 = (256 - fu) * fv;
  const w11 = fu * fv;
  const acc =
    w00 * tex[y0 * w + x0]! +
    w10 * tex[y0 * w + x1]! +
    w01 * tex[y1 * w + x0]! +
    w11 * tex[y1 * w + x1]!;
  return (acc + 32768) >> 16;
}

/** Nearest texel (point sample), clamp-to-edge. */
export function sampleNearest(tex: Uint8Array, w: number, h: number, u: number, v: number): number {
  let x = Math.round(u);
  let y = Math.round(v);
  x = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  return tex[y * w + x]!;
}

// --- Palettised textures ---------------------------------------------------

/** Expand one palette index through a 768-byte RGB palette into out[off..off+2]. */
export function expandPalette(
  index: number,
  palette: Uint8Array,
  out: Uint8Array,
  off: number,
): void {
  const p = (index & 255) * 3;
  out[off] = palette[p]!;
  out[off + 1] = palette[p + 1]!;
  out[off + 2] = palette[p + 2]!;
}

const _svA = new Uint8Array(3);
const _svB = new Uint8Array(3);
const _svC = new Uint8Array(3);
const _svD = new Uint8Array(3);

function expandInto(index: number, palette: Uint8Array, tmp: Uint8Array): void {
  const p = (index & 255) * 3;
  tmp[0] = palette[p]!;
  tmp[1] = palette[p + 1]!;
  tmp[2] = palette[p + 2]!;
}

/**
 * Sample a palettised texture, expanding through the palette at sample time.
 * bilinear=true filters AFTER expansion (what the Voodoo does with
 * GL_EXT_shared_texture_palette); false = point sample. Writes RGB to
 * out[off..off+2]. Module scratch only (no per-call allocation).
 */
export function samplePalette(
  indices: Uint8Array,
  palette: Uint8Array,
  w: number,
  h: number,
  u: number,
  v: number,
  out: Uint8Array,
  off: number,
  bilinear = true,
): void {
  const uc = u < 0 ? 0 : u > w - 1 ? w - 1 : u;
  const vc = v < 0 ? 0 : v > h - 1 ? h - 1 : v;
  const x0 = uc | 0;
  const y0 = vc | 0;
  if (!bilinear) {
    // Point sample: round to nearest texel centre (matches sampleNearest).
    let nx = Math.round(uc);
    let ny = Math.round(vc);
    nx = nx < 0 ? 0 : nx > w - 1 ? w - 1 : nx;
    ny = ny < 0 ? 0 : ny > h - 1 ? h - 1 : ny;
    expandPalette(indices[ny * w + nx]!, palette, out, off);
    return;
  }
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fu = Math.round((uc - x0) * 256);
  const fv = Math.round((vc - y0) * 256);
  expandInto(indices[y0 * w + x0]!, palette, _svA);
  expandInto(indices[y0 * w + x1]!, palette, _svB);
  expandInto(indices[y1 * w + x0]!, palette, _svC);
  expandInto(indices[y1 * w + x1]!, palette, _svD);
  const w00 = (256 - fu) * (256 - fv);
  const w10 = fu * (256 - fv);
  const w01 = (256 - fu) * fv;
  const w11 = fu * fv;
  for (let c = 0; c < 3; c++) {
    out[off + c] =
      (w00 * _svA[c]! + w10 * _svB[c]! + w01 * _svC[c]! + w11 * _svD[c]! + 32768) >> 16;
  }
}

// --- Mip LOD + mip-dithering ------------------------------------------------

/**
 * Screen-space footprint of a texel: max column/row gradient length.
 * rho = max(|dudx| + |dvdx|... ) — Voodoo uses per-pixel LOD; the Glide
 * form is rho = max(sqrt(dudx^2+dvdx^2), sqrt(dudy^2+dvdy^2)).
 */
export function mipRho(dudx: number, dvdx: number, dudy: number, dvdy: number): number {
  const rx = Math.sqrt(dudx * dudx + dvdx * dvdx);
  const ry = Math.sqrt(dudy * dudy + dvdy * dvdy);
  return rx > ry ? rx : ry;
}

/**
 * Mipmap LOD: lod = log2(rho) - bias (BRAIN.md §7.2; Glide default bias
 * vd_lodbias = -0.35). Clamped to >= 0. Throws on non-positive rho.
 */
export function mipLevel(rho: number, bias: number): number {
  if (!(rho > 0) || !Number.isFinite(rho)) {
    throw new Error(`[voodoo] mipLevel: rho must be positive finite, got ${rho}`);
  }
  const lod = Math.log2(rho) - bias;
  return lod < 0 ? 0 : lod;
}

/**
 * Single-TMU "trilinear": per-pixel pick of LOD n or n+1 by comparing the
 * fractional LOD against the Bayer threshold (b/16) at this pixel.
 *   f * 16 <= bayer(x, y) ? n : n + 1
 * f = 0 always picks n, f -> 1 always picks n+1. With mipDither=false this
 * degrades to round-to-nearest. maxLevel clamps (mip chain length - 1).
 */
export function pickMipLevel(
  lod: number,
  x: number,
  y: number,
  mipDither = true,
  maxLevel = 16,
): number {
  const clamped = lod < 0 ? 0 : lod;
  const n = clamped | 0;
  const f = clamped - n;
  let level: number;
  if (!mipDither) {
    level = f < 0.5 ? n : n + 1;
  } else {
    const b = BAYER4[((y & 3) << 2) | (x & 3)]!;
    level = f * 16 <= b ? n : n + 1;
  }
  return level > maxLevel ? maxLevel : level;
}

// --- Table fog (64 entries, exp^2) ------------------------------------------

/** Cached fog table so the per-frame path allocates nothing. */
let cachedDensity = Number.NaN;
let cachedFog: Uint8Array = new Uint8Array(64);

/**
 * 64-entry exp^2 fog table. entry[i] = round(255 * (1 - exp(-(d*t)^2))),
 * t = i / 63. Endpoints: [0] = 0 (no fog), [63] = 255 (fully fogged)
 * for any density >= ~2.5 (default 3.0).
 */
export function buildFogTable(density = 3.0): Uint8Array {
  if (!(density >= 0) || !Number.isFinite(density)) {
    throw new Error(`[voodoo] buildFogTable: density must be finite >= 0, got ${density}`);
  }
  if (density === cachedDensity) return cachedFog;
  const t = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const x = (density * i) / 63;
    t[i] = Math.min(255, Math.round(255 * (1 - Math.exp(-x * x))));
  }
  cachedDensity = density;
  cachedFog = t;
  return t;
}

/**
 * Fog blend factor 0..255 for normalised depth w01 in [0, 1].
 * The hardware addresses the table with the high bits of 1/W; here the
 * caller maps its depth to [0, 1] first. Clamp-to-edge.
 */
export function fogFactor(w01: number, table: Uint8Array = buildFogTable()): number {
  if (!(w01 > 0)) return table[0]!;
  if (w01 >= 1) return table[63]!;
  return table[(w01 * 64) | 0]!;
}

/**
 * Blend src RGB toward fog colour by factor f (0..255):
 * out = ((255 - f) * src + f * fog + 127) / 255. Endpoints exact:
 * f = 0 -> src, f = 255 -> fog colour.
 */
export function applyFog(
  r: number,
  g: number,
  b: number,
  fr: number,
  fg: number,
  fb: number,
  f: number,
): number {
  const inv = 255 - f;
  const ro = ((inv * r + f * fr + 127) / 255) | 0;
  const go = ((inv * g + f * fg + 127) / 255) | 0;
  const bo = ((inv * b + f * fb + 127) / 255) | 0;
  return (0xff000000 | (bo << 16) | (go << 8) | ro) >>> 0;
}

// --- Lightmap modulate x2 ---------------------------------------------------

/**
 * No per-pixel overbright on Voodoo: diffuse x lightmap x (overbright ? 2 : 1),
 * clamped — highlights clip like the real thing. Inputs/outputs 0..255.
 * Returns packed 0xFFBBGGRR.
 */
export function modulateLightmap(
  tr: number,
  tg: number,
  tb: number,
  lr: number,
  lg: number,
  lb: number,
  overbright = true,
): number {
  const m = overbright ? 2 : 1;
  let r = (((tr * lr * m + 127) / 255) | 0);
  let g = (((tg * lg * m + 127) / 255) | 0);
  let b = (((tb * lb * m + 127) / 255) | 0);
  r = r > 255 ? 255 : r;
  g = g > 255 ? 255 : g;
  b = b > 255 ? 255 : b;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

// --- 256x256 texture cap -----------------------------------------------------

/**
 * Voodoo3 max texture size helper (vd_maxtexsize, default 256): repeatedly
 * halve until both dimensions fit. max <= 0 disables the cap.
 */
export function capTextureSize(w: number, h: number, max = 256): { w: number; h: number } {
  if (!(max > 0)) return { w, h };
  while (w > max || h > max) {
    w = w > 1 ? w >> 1 : 1;
    h = h > 1 ? h >> 1 : 1;
  }
  return { w, h };
}
