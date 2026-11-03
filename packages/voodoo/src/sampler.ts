// @q2/voodoo — M4.2 sampler: bilinear, mip LOD + mip-dithering, table fog,
// lightmap modulate x2, palettised textures, 256x256 cap.
//
// All texture data stays palettised (Uint8 indices, GL_EXT_shared_texture_palette
// style); expansion through the 256-entry palette happens at sample time.
// Fixed-point 8-bit fractional weights, clamp-to-edge, zero-alloc.

import { BAYER4 } from './bayer.js';
import { wrapTap, type TextureAddress } from './upload.js';

/**
 * Map any texel coordinate into [0, size) for repeat addressing. Exact
 * multiples of size land on 0 (fp guard). See upload.ts for the convention.
 */
function wrapCentre(coord: number, size: number): number {
  const c = coord - Math.floor(coord / size) * size;
  return c >= size ? 0 : c;
}

// --- Bilinear ------------------------------------------------------------

/**
 * 4-tap bilinear on a byte texture. u/v are texel coordinates (integer =
 * texel centre — see TEXEL-CENTRE CONVENTION in upload.ts). Fractional parts
 * use 8-bit fixed-point weights: acc = w00*a + w01*b + w10*c + w11*d,
 * result (acc + 32768) >> 16 with the 16-bit weight products summed exactly.
 * Addressing is per-axis (repeat wraps EACH tap via wrapTap; clamp pins to
 * the edge texel); default clamp preserves the historical behaviour.
 */
export function sampleBilinear(
  tex: Uint8Array,
  w: number,
  h: number,
  u: number,
  v: number,
  addressS: TextureAddress = 'clamp',
  addressT: TextureAddress = 'clamp',
): number {
  const uc = addressS === 'repeat' ? wrapCentre(u, w) : u < 0 ? 0 : u > w - 1 ? w - 1 : u;
  const vc = addressT === 'repeat' ? wrapCentre(v, h) : v < 0 ? 0 : v > h - 1 ? h - 1 : v;
  const x0 = uc | 0;
  const y0 = vc | 0;
  const x1 = wrapTap(x0 + 1, w, addressS);
  const y1 = wrapTap(y0 + 1, h, addressT);
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

/** Nearest texel (point sample). Addressing per-axis; default clamp-to-edge. */
export function sampleNearest(
  tex: Uint8Array,
  w: number,
  h: number,
  u: number,
  v: number,
  addressS: TextureAddress = 'clamp',
  addressT: TextureAddress = 'clamp',
): number {
  const cu = addressS === 'repeat' ? wrapCentre(u, w) : u < 0 ? 0 : u > w - 1 ? w - 1 : u;
  const cv = addressT === 'repeat' ? wrapCentre(v, h) : v < 0 ? 0 : v > h - 1 ? h - 1 : v;
  const x = wrapTap(Math.round(cu), w, addressS);
  const y = wrapTap(Math.round(cv), h, addressT);
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
 * out[off..off+2]. Module scratch only (no per-call allocation). Addressing
 * is per-axis (repeat wraps EACH of the 4 taps); default clamp preserves the
 * historical behaviour. u/v are texel coordinates (see upload.ts convention).
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
  addressS: TextureAddress = 'clamp',
  addressT: TextureAddress = 'clamp',
): void {
  const uc = addressS === 'repeat' ? wrapCentre(u, w) : u < 0 ? 0 : u > w - 1 ? w - 1 : u;
  const vc = addressT === 'repeat' ? wrapCentre(v, h) : v < 0 ? 0 : v > h - 1 ? h - 1 : v;
  const x0 = uc | 0;
  const y0 = vc | 0;
  if (!bilinear) {
    // Point sample: round to nearest texel centre (matches sampleNearest).
    const nx = wrapTap(Math.round(uc), w, addressS);
    const ny = wrapTap(Math.round(vc), h, addressT);
    expandPalette(indices[ny * w + nx]!, palette, out, off);
    return;
  }
  const x1 = wrapTap(x0 + 1, w, addressS);
  const y1 = wrapTap(y0 + 1, h, addressT);
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

// --- Expanded RGB textures -------------------------------------------------

/**
 * Sample an expanded RGB(A) texture: tex holds w*h RGB triplets
 * (tex[(y*w+x)*3 + c], c = 0..2 for R,G,B), i.e. palette/WAL data already
 * expanded to 8:8:8 at upload time. Same bilinear/nearest policy as
 * samplePalette — bilinear=true filters the four neighbouring TEXELS'
 * colours (what the Voodoo does with non-paletted textures); false point
 * samples. Writes RGB to out[off..off+2]. Module scratch only.
 *
 * Representation note (astra §2.3): vd_palettetex selects the UPLOAD
 * policy (paletted vs expanded storage), never the filter. Both this and
 * samplePalette obey the same vd_bilinear switch; on identical colours
 * they must produce identical output (see sampler.test.ts). Addressing is
 * per-axis (repeat wraps EACH of the 4 taps); default clamp preserves the
 * historical behaviour. u/v are texel coordinates (see upload.ts convention).
 */
export function sampleRGBTexture(
  tex: Uint8Array,
  w: number,
  h: number,
  u: number,
  v: number,
  out: Uint8Array,
  off: number,
  bilinear = true,
  addressS: TextureAddress = 'clamp',
  addressT: TextureAddress = 'clamp',
): void {
  const uc = addressS === 'repeat' ? wrapCentre(u, w) : u < 0 ? 0 : u > w - 1 ? w - 1 : u;
  const vc = addressT === 'repeat' ? wrapCentre(v, h) : v < 0 ? 0 : v > h - 1 ? h - 1 : v;
  const x0 = uc | 0;
  const y0 = vc | 0;
  if (!bilinear) {
    // Point sample: round to nearest texel centre (matches sampleNearest).
    const nx = wrapTap(Math.round(uc), w, addressS);
    const ny = wrapTap(Math.round(vc), h, addressT);
    const p = (ny * w + nx) * 3;
    out[off] = tex[p]!;
    out[off + 1] = tex[p + 1]!;
    out[off + 2] = tex[p + 2]!;
    return;
  }
  const x1 = wrapTap(x0 + 1, w, addressS);
  const y1 = wrapTap(y0 + 1, h, addressT);
  const fu = Math.round((uc - x0) * 256);
  const fv = Math.round((vc - y0) * 256);
  const pa = (y0 * w + x0) * 3;
  const pb = (y0 * w + x1) * 3;
  const pc = (y1 * w + x0) * 3;
  const pd = (y1 * w + x1) * 3;
  const w00 = (256 - fu) * (256 - fv);
  const w10 = fu * (256 - fv);
  const w01 = (256 - fu) * fv;
  const w11 = fu * fv;
  out[off] = (w00 * tex[pa]! + w10 * tex[pb]! + w01 * tex[pc]! + w11 * tex[pd]! + 32768) >> 16;
  out[off + 1] =
    (w00 * tex[pa + 1]! + w10 * tex[pb + 1]! + w01 * tex[pc + 1]! + w11 * tex[pd + 1]! + 32768) >> 16;
  out[off + 2] =
    (w00 * tex[pa + 2]! + w10 * tex[pb + 2]! + w01 * tex[pc + 2]! + w11 * tex[pd + 2]! + 32768) >> 16;
}

// --- Mip LOD + mip-dithering ------------------------------------------------

/**
 * Screen-space footprint of a texel: max column/row gradient length.
 * rho = max(sqrt(dudx^2+dvdx^2), sqrt(dudy^2+dvdy^2)).
 *
 * Never throws and never returns NaN for finite inputs: constant UVs or
 * magnification (zero gradients) yield rho = 0, which mipLevel clamps to
 * epsilon internally (LOD 0). Non-finite gradients propagate as NaN, which
 * mipLevel rejects loudly — a NaN gradient is a geometry bug, not a level.
 */
export function mipRho(dudx: number, dvdx: number, dudy: number, dvdy: number): number {
  const rx = Math.sqrt(dudx * dudx + dvdx * dvdx);
  const ry = Math.sqrt(dudy * dudy + dvdy * dvdy);
  return rx > ry ? rx : ry;
}

/**
 * LOD bias compensation for textureMode.tloddither (textureMode §9.3.58 bit 4).
 *
 * When the hardware dithers LOD selection between adjacent levels it adds an
 * AVERAGE of +0.375 to the level; a single-level software pick (which is what
 * mipLevel + pickMipLevel(mipDither=true) emulates per-pixel) must add the
 * same +0.375 to match the hardware's average level, or mipped content renders
 * systematically one-third level too sharp. When LOD dithering is OFF, no
 * compensation applies. Pairing rule: mipLevel(..., tlodDither) and
 * pickMipLevel(..., mipDither) must agree — both true (hardware tloddither
 * profile) or both false (crisp single-level profile). This is a documented
 * average-match, NOT PG trilinear (two-pass blend) and NOT anisotropy (both are
 * explicitly out of scope: the game profile is GL_LINEAR_MIPMAP_NEAREST).
 */
export function lodBiasCompensation(tlodDither: boolean): number {
  return tlodDither ? 0.375 : 0;
}

/**
 * Mipmap LOD: lod = log2(rho) + bias [+ 0.375 when tlodDither], clamped to
 * [0, maxLevel].
 *
 * Sign convention follows the Voodoo textureMode lodbias (PG §9.3.58): the bias is ADDED to log2(rho), so a NEGATIVE bias
 * (Glide default vd_lodbias = -0.35) favours FINER detail and a positive
 * bias favours coarser levels. (The previous `- bias` sign was backwards;
 * changed intentionally per astra §2.4 — negative bias now sharpens.)
 *
 * Robustness: rho <= 0 (constant UVs, magnification) clamps to epsilon
 * 1e-6 instead of throwing, yielding LOD 0 after the lower clamp; only
 * non-finite rho/bias (NaN, ±Infinity) throw. maxLevel defaults to
 * +Infinity (no upper clamp); pass the mip chain length - 1 to bound it.
 */
export function mipLevel(
  rho: number,
  bias: number,
  maxLevel = Number.POSITIVE_INFINITY,
  tlodDither = false,
): number {
  if (!Number.isFinite(rho) || !Number.isFinite(bias)) {
    throw new Error(`[voodoo] mipLevel: rho and bias must be finite, got ${rho}, ${bias}`);
  }
  if (Number.isNaN(maxLevel)) {
    throw new Error(`[voodoo] mipLevel: maxLevel must not be NaN`);
  }
  const r = rho <= 0 ? 1e-6 : rho;
  const lod = Math.log2(r) + bias + lodBiasCompensation(tlodDither);
  if (!(lod > 0)) return 0;
  const cap = maxLevel < 0 ? 0 : maxLevel;
  return lod > cap ? cap : lod;
}

/**
 * Dithered single-level selection (NOT PG trilinear = two-pass blend): per-pixel pick of LOD n or n+1 by comparing the
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
 * Fog contribution for the capability gate (vd_fog).
 *
 * vd_fog enables the fog STATE; it must NOT invent fog where the scene has
 * none. Quake II base1 ships no scene/material fog, so with nothing explicitly
 * enabled this returns 0 and shadePixel yields the lit colour untouched. Pass
 * the resolved 0..255 table factor only when a scene/material/profile stage
 * explicitly enables fog; values outside [0, 255] are clamped.
 */
export function fogContribution(fogEnabled: boolean, factor: number): number {
  if (!fogEnabled || !(factor > 0)) return 0;
  if (factor >= 255) return 255;
  return factor;
}

/**
 * Fog blend factor 0..255 for normalised depth w01 in [0, 1], with
 * inter-entry lerp (VOODOO_APPROX_PROFILE 'fog.interpolation', PG §10.3.4:
 * the low 8 bits of 1/W blend between entries to reduce banding).
 * t = w01 * 64 selects entry fi = floor(t) plus the fraction toward fi+1;
 * t >= 63 saturates at table[63] so clamp-to-edge endpoints stay exact.
 * The caller maps its depth to [0, 1] first — the hardware instead indexes
 * raw 1/W bits (see profile 'fog.index-domain').
 */
export function fogFactor(w01: number, table: Uint8Array = buildFogTable()): number {
  return fogFactorLerp(w01, table);
}

/**
 * Explicit inter-entry-lerp form of fogFactor: round(table[fi] * (1-frac) +
 * table[fi+1] * frac). Endpoints exact: w01 <= 0 -> table[0], w01 >= 1 (or
 * t >= 63) -> table[63].
 */
export function fogFactorLerp(w01: number, table: Uint8Array = buildFogTable()): number {
  if (!(w01 > 0)) return table[0]!;
  if (w01 >= 1) return table[63]!;
  const t = w01 * 64;
  if (t >= 63) return table[63]!;
  const fi = t | 0;
  const frac = t - fi;
  return Math.round(table[fi]! + (table[fi + 1]! - table[fi]!) * frac);
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
 * Game-pipeline lightmap lift (NOT a Voodoo combine stage): diffuse x
 * lightmap x (overbright ? 2 : 1), clamped — highlights saturate in the
 * 8-bit pipeline. Inputs/outputs 0..255. Returns packed 0xFFBBGGRR.
 *
 * Provenance (VF-4): no x2/overbright/lightmap scale stage exists in the
 * Voodoo3 combine units (PG §10.3.1 CCU / §10.3.2 ACU / §10.6.1
 * texture-combine: mux/add-local/invert only, no scale stage). id ref_gl
 * ships gl_modulate default 1 (gl_rmain.c:994, declared gl_local.h:226,
 * applied gl_light.c:276,347,509,546) with GL_MODULATE/GL_REPLACE texenvs
 * only (gl_rsurf.c) — no GL_RGB_SCALE/COMBINE, no OVERBRIGHT token (the
 * only "overbright" hit in the id source is an unrelated ref_soft
 * r_alias.c:937 comment). The x2 is a post-id game/driver-pipeline
 * convention (Q3-era overbright / gl_modulate 2 / MiniGL-style lift
 * saturated in 8-bit). Rounding ((m*tr*lr+127)/255)|0 and clamp are this
 * package's deterministic stand-in (profile 'lightmap.overbright-x2'),
 * uncalibrated.
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
