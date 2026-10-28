// @q2/sw-renderer spans — D_DrawSpans16 port (r_scan.c, BRAIN.md §7.1).
//
// Rules enforced here (BRAIN.md §2):
// - Uint8Array/Float32Array only in the inner loop. No objects, no closures.
// - 16.16 fixed point texture coords, ONE division per 16-pixel subdivision.
// - Separate monomorphic entry points per span kind (opaque / turbulent /
//   flat / translucent33 / translucent66). The kind branches once per SPAN,
//   never inside the pixel loop.

import type { Framebuffer } from '@q2/renderer-api';
import { Com_Error, getCVarNumber, registerCVar } from '@q2/config';

/** Pixels per perspective-correct subdivision step. */
export const SUBDIV = 16;

/** Span kinds. Branched per-span in drawSpans*, never per-pixel. */
export const SPAN_OPAQUE = 0;
export const SPAN_TURBULENT = 1;
export const SPAN_FLAT = 2;
/**
 * Translucent span kinds (ref_soft SURF_TRANS33/SURF_TRANS66, r_poly.c
 * R_DrawAlphaSurfaces). Drawn after all opaque geometry, depth-tested but
 * never depth-writing, blended through the 256x256 alphamap (or
 * screen-door stipple when sw_stipplealpha is set). Texel 255 stays
 * transparent, exactly like C's `if (btemp != 255)` guard.
 */
export const SPAN_TRANS33 = 3;
export const SPAN_TRANS66 = 4;

/** Master switch for the translucent-surface path (default 1 = blend like C). */
export const TRANSLUCENCY_CVAR = 'r_translucency';
/** Screen-door stipple instead of alphamap blend (ref_soft sw_stipplealpha). */
export const STIPPLE_ALPHA_CVAR = 'sw_stipplealpha';

/**
 * Resolve the translucency mode from cvars (same lazy-register pattern as
 * workersRequestedByCvar): 0 = draw translucent surfaces opaque (safety
 * fallback, matches the pre-port behaviour), 1 = alphamap blend (C
 * default), 2 = screen-door stipple (C sw_stipplealpha = 1).
 */
export function translucencyModeFromCvars(): 0 | 1 | 2 {
  try {
    registerCVar(TRANSLUCENCY_CVAR, 1, 'translucent surfaces: 0 = opaque fallback, 1 = alphamap blend (ref_soft default)');
    if (getCVarNumber(TRANSLUCENCY_CVAR) === 0) return 0;
    registerCVar(STIPPLE_ALPHA_CVAR, 0, 'screen-door stipple for translucency (ref_soft sw_stipplealpha, default 0 = blend)');
    return getCVarNumber(STIPPLE_ALPHA_CVAR) !== 0 ? 2 : 1;
  } catch {
    return 1;
  }
}

/** Doubles packed per span: iz diz uz duz vz dvz light dlight lu lv dlu. */
export const F_PER_SPAN = 11;
/** Ints packed per span: kind y x0 x1 turb. */
export const I_PER_SPAN = 5;

export interface Span {
  kind: number;
  /** scanline + [x0, x1) in pixels */
  y: number; x0: number; x1: number;
  /** 1/z at x0 + per-pixel step (depth test: iz > zb wins) */
  iz: number; diz: number;
  /** u/z, v/z at x0 + per-pixel steps (perspective correct) */
  uz: number; duz: number;
  vz: number; dvz: number;
  /**
   * Colormap grade 0..63 + per-pixel step. Used when lv < 0.
   * When lv >= 0 the grade is sampled from the span's LightBlock row
   * (lu -> lu + dlu*count at row lv) and light/dlight are the fallback.
   */
  light: number; dlight: number;
  lu: number; lv: number; dlu: number;
  /** turbulence phase for SPAN_TURBULENT */
  turb: number;
  /** BSP front-to-back order (coplanar tie-break, lower = nearer) */
  ord: number;
}

export interface SpanList {
  /** Preallocated pool; only [0, count) is active. Never truncate. */
  spans: Span[];
  count: number;
}

/** Wrap a pool array as a list view (no allocation if reused by caller). */
export function spanListView(pool: Span[], count: number, out: SpanList): SpanList {
  out.spans = pool;
  out.count = count;
  return out;
}

export interface Texture {
  width: number; height: number;
  texels: Uint8Array;
}

export interface LightBlock {
  width: number; height: number;
  /** per-luxel colormap grade 0..63 */
  values: Uint8Array;
}

/** Frozen-contract backend shape (BRAIN.md §6). Holds frame state. */
export interface RasterBackend {
  drawSpans(list: SpanList, tex: Texture, light: LightBlock): void;
}

/** Allocate a reusable span (renderer span pool owns these). */
export function createSpan(): Span {
  return {
    kind: SPAN_OPAQUE,
    y: 0, x0: 0, x1: 0,
    iz: 0, diz: 0, uz: 0, duz: 0, vz: 0, dvz: 0,
    light: 63, dlight: 0, lu: 0, lv: -1, dlu: 0, turb: 0, ord: 0,
  };
}

/**
 * Normative 16-pixel affine subdivision (BRAIN.md §7.1).
 * One division per call; fixed-point stepping inside.
 * Returns the trailing (iz, light, u1, v1) so the caller chains the next
 * subdivision exactly (C `snext` semantics).
 */
export function runSubdiv16(
  idx: Uint8Array,
  zb: Float32Array,
  o0: number,
  n: number,
  iz: number,
  diz: number,
  uz: number,
  duz: number,
  vz: number,
  dvz: number,
  u0: number,
  v0: number,
  light: number,
  dlight: number,
  texels: Uint8Array,
  wshift: number,
  wmask: number,
  hmask: number,
  colormap: Uint8Array,
): { iz: number; light: number; u1: number; v1: number } {
  // per 16-pixel subdivision: ONE division, then fixed-point stepping
  const z1 = 1 / (iz + diz * n);
  const u1 = (uz + duz * n) * z1, v1 = (vz + dvz * n) * z1;
  let tu = (u0 * 65536) | 0, tv = (v0 * 65536) | 0;
  const dtu = (((u1 - u0) / n) * 65536) | 0, dtv = (((v1 - v0) / n) * 65536) | 0;
  for (let i = 0, o = o0; i < n; i++, o++) {
    if (iz > zb[o]) {
      zb[o] = iz;
      idx[o] = colormap[(light << 8) + texels[(((tv >> 16) & hmask) << wshift) + ((tu >> 16) & wmask)]]!;
    }
    tu += dtu; tv += dtv; iz += diz; light += dlight;
  }
  return { iz, light, u1, v1 };
}

/** Turbulent variant (water warp): separate monomorphic loop, no mode branch. */
export function runSubdivTurbulent(
  idx: Uint8Array,
  zb: Float32Array,
  o0: number,
  n: number,
  iz: number,
  diz: number,
  uz: number,
  duz: number,
  vz: number,
  dvz: number,
  u0: number,
  v0: number,
  light: number,
  dlight: number,
  texels: Uint8Array,
  wshift: number,
  wmask: number,
  hmask: number,
  colormap: Uint8Array,
  turbTable: Uint8Array,
  turbPhase: number,
): { iz: number; light: number; u1: number; v1: number } {
  const z1 = 1 / (iz + diz * n);
  const u1 = (uz + duz * n) * z1, v1 = (vz + dvz * n) * z1;
  let tu = (u0 * 65536) | 0, tv = (v0 * 65536) | 0;
  const dtu = (((u1 - u0) / n) * 65536) | 0, dtv = (((v1 - v0) / n) * 65536) | 0;
  const tmask = turbTable.length - 1;
  for (let i = 0, o = o0; i < n; i++, o++) {
    if (iz > zb[o]) {
      zb[o] = iz;
      const wu = (tu + (turbTable[((tv >> 16) + turbPhase) & tmask]! << 16)) >> 16;
      const wv = (tv + (turbTable[((tu >> 16) + turbPhase) & tmask]! << 16)) >> 16;
      idx[o] = colormap[(light << 8) + texels[((wv & hmask) << wshift) + (wu & wmask)]]!;
    }
    tu += dtu; tv += dtv; iz += diz; light += dlight;
  }
  return { iz, light, u1, v1 };
}

/** Flat variant: constant palette index, depth tested. Separate loop. */
export function runSpanFlat(
  idx: Uint8Array,
  zb: Float32Array,
  o0: number,
  n: number,
  iz: number,
  diz: number,
  color: number,
): number {
  let z = iz;
  for (let i = 0, o = o0; i < n; i++, o++) {
    if (z > zb[o]) {
      zb[o] = z;
      idx[o] = color;
    }
    z += diz;
  }
  return z;
}

/** Bilinear sample of a luxel grade block. Per-span setup only. */
export function sampleLightBlock(lb: LightBlock, lu: number, lv: number): number {
  const w = lb.width, h = lb.height;
  const v = lb.values;
  let x0 = lu | 0, y0 = lv | 0;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  let x1 = x0 + 1, y1 = y0 + 1;
  if (x1 > w - 1) x1 = w - 1;
  if (y1 > h - 1) y1 = h - 1;
  if (x0 > w - 1) x0 = w - 1;
  if (y0 > h - 1) y0 = h - 1;
  const fx = lu - (lu | 0) < 0 ? 0 : lu - (lu | 0) > 1 ? 1 : lu - (lu | 0);
  const fy = lv - (lv | 0) < 0 ? 0 : lv - (lv | 0) > 1 ? 1 : lv - (lv | 0);
  const a = v[y0 * w + x0]!, b = v[y0 * w + x1]!, c = v[y1 * w + x0]!, d = v[y1 * w + x1]!;
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export function textureMasks(tex: Texture): { wshift: number; wmask: number; hmask: number } {
  let wshift = 0;
  while ((1 << wshift) < tex.width) wshift++;
  // Height need not be POT: the packed sky strip is 6*tileH (e.g. 64x384,
  // 256x1536 for real art). height-1 would strip bit 7 for v in [128,256)
  // (136&383=8), aliasing sky tiles 2..3 onto tiles 0..1. Mask up to the next
  // POT instead so every in-range v passes through untouched; POT heights are
  // exactly what height-1 gave. Widths stay POT (enforced at registration).
  let hbits = 0;
  while ((1 << hbits) < tex.height) hbits++;
  return { wshift, wmask: tex.width - 1, hmask: (1 << hbits) - 1 };
}

/**
 * Software span rasteriser: opaque lit textured spans (d_scan.c D_DrawSpans16).
 * Monomorphic typed-array loop; zero allocation.
 */
export function drawSpansSoftware(
  idx: Uint8Array,
  zb: Float32Array,
  fbW: number,
  fbH: number,
  list: SpanList,
  tex: Texture,
  light: LightBlock,
  colormap: Uint8Array,
): { pixels: number; spans: number } {
  const texels = tex.texels;
  const { wshift, wmask, hmask } = textureMasks(tex);
  const spans = list.spans;
  const n = list.count < spans.length ? list.count : spans.length;
  let pixels = 0;
  let drawn = 0;
  for (let si = 0; si < n; si++) {
    const s = spans[si]!;
    if (s.kind !== SPAN_OPAQUE) continue;
    if (s.y < 0 || s.y >= fbH) continue;
    let x0 = s.x0, x1 = s.x1;
    if (x0 < 0) x0 = 0;
    if (x1 > fbW) x1 = fbW;
    const count = x1 - x0;
    if (count <= 0) continue;
    // Per-span setup (outside the pixel loop): resolve the light gradient.
    let lz = s.light, dlz = s.dlight;
    if (s.lv >= 0) {
      const l0 = sampleLightBlock(light, s.lu, s.lv);
      const l1 = sampleLightBlock(light, s.lu + s.dlu * count, s.lv);
      lz = l0;
      dlz = (l1 - l0) / count;
    }
    // Clip-adjusted perspective start: advance gradients for clipped pixels.
    const skip = x0 - s.x0;
    let iz = s.iz + s.diz * skip;
    let uz = s.uz + s.duz * skip;
    let vz = s.vz + s.dvz * skip;
    let u0 = uz / iz, v0 = vz / iz;
    let o = s.y * fbW + x0;
    let remaining = count;
    while (remaining > 0) {
      const n = remaining >= SUBDIV ? SUBDIV : remaining;
      const r = runSubdiv16(idx, zb, o, n, iz, s.diz, uz, s.duz, vz, s.dvz,
        u0, v0, lz, dlz, texels, wshift, wmask, hmask, colormap);
      iz = r.iz; lz = r.light;
      uz += s.duz * n; vz += s.dvz * n;
      u0 = r.u1; v0 = r.v1;
      o += n; remaining -= n;
    }
    pixels += count;
    drawn++;
  }
  return { pixels, spans: drawn };
}

/** Turbulent span pass (water). Separate function, same subdivision math. */
export function drawSpansTurbulent(
  idx: Uint8Array,
  zb: Float32Array,
  fbW: number,
  fbH: number,
  list: SpanList,
  tex: Texture,
  colormap: Uint8Array,
  turbTable: Uint8Array,
  time: number,
): { pixels: number; spans: number } {
  const texels = tex.texels;
  const { wshift, wmask, hmask } = textureMasks(tex);
  const spans = list.spans;
  const phase = ((time * 64) | 0) & (turbTable.length - 1);
  const tn = list.count < spans.length ? list.count : spans.length;
  let pixels = 0;
  let drawn = 0;
  for (let si = 0; si < tn; si++) {
    const s = spans[si]!;
    if (s.kind !== SPAN_TURBULENT) continue;
    if (s.y < 0 || s.y >= fbH) continue;
    let x0 = s.x0, x1 = s.x1;
    if (x0 < 0) x0 = 0;
    if (x1 > fbW) x1 = fbW;
    const count = x1 - x0;
    if (count <= 0) continue;
    const skip = x0 - s.x0;
    let iz = s.iz + s.diz * skip;
    let uz = s.uz + s.duz * skip;
    let vz = s.vz + s.dvz * skip;
    let u0 = uz / iz, v0 = vz / iz;
    let lz = s.light;
    let o = s.y * fbW + x0;
    let remaining = count;
    while (remaining > 0) {
      const n = remaining >= SUBDIV ? SUBDIV : remaining;
      const r = runSubdivTurbulent(idx, zb, o, n, iz, s.diz, uz, s.duz, vz, s.dvz,
        u0, v0, lz, s.dlight, texels, wshift, wmask, hmask, colormap, turbTable, (phase + s.turb) & (turbTable.length - 1));
      iz = r.iz; lz = r.light;
      uz += s.duz * n; vz += s.dvz * n;
      u0 = r.u1; v0 = r.v1;
      o += n; remaining -= n;
    }
    pixels += count;
    drawn++;
  }
  return { pixels, spans: drawn };
}

/** Flat span pass with a per-span palette color in `s.light` (sky fills).
 * Monomorphic like drawSpansFlat; the color rides the span (not the pixel
 * loop) so one mixed list can carry several flat surfaces. */
export function drawSpansFlatPerSpan(
  idx: Uint8Array,
  zb: Float32Array,
  fbW: number,
  fbH: number,
  list: SpanList,
): { pixels: number; spans: number } {
  const spans = list.spans;
  const n = list.count < spans.length ? list.count : spans.length;
  let pixels = 0;
  let drawn = 0;
  for (let si = 0; si < n; si++) {
    const s = spans[si]!;
    if (s.kind !== SPAN_FLAT) continue;
    if (s.y < 0 || s.y >= fbH) continue;
    let x0 = s.x0, x1 = s.x1;
    if (x0 < 0) x0 = 0;
    if (x1 > fbW) x1 = fbW;
    const count = x1 - x0;
    if (count <= 0) continue;
    runSpanFlat(idx, zb, s.y * fbW + x0, count, s.iz + s.diz * (x0 - s.x0), s.diz, s.light & 255);
    pixels += count;
    drawn++;
  }
  return { pixels, spans: drawn };
}

/** Flat-shaded span pass (sky, solid fills). Separate function. */
export function drawSpansFlat(
  idx: Uint8Array,
  zb: Float32Array,
  fbW: number,
  fbH: number,
  list: SpanList,
  color: number,
): { pixels: number; spans: number } {
  const spans = list.spans;
  const n = list.count < spans.length ? list.count : spans.length;
  let pixels = 0;
  let drawn = 0;
  for (let si = 0; si < n; si++) {
    const s = spans[si]!;
    if (s.kind !== SPAN_FLAT) continue;
    if (s.y < 0 || s.y >= fbH) continue;
    let x0 = s.x0, x1 = s.x1;
    if (x0 < 0) x0 = 0;
    if (x1 > fbW) x1 = fbW;
    const count = x1 - x0;
    if (count <= 0) continue;
    runSpanFlat(idx, zb, s.y * fbW + x0, count, s.iz + s.diz * (x0 - s.x0), s.diz, color);
    pixels += count;
    drawn++;
  }
  return { pixels, spans: drawn };
}

/**
 * Frozen-shape entry point: draws a mixed SpanList through the software path.
 * Dispatches per span kind (branch on the span, never in the pixel loop).
 */
export function drawSpans16(
  fb: Framebuffer,
  list: SpanList,
  tex: Texture,
  light: LightBlock,
  colormap: Uint8Array,
): void {
  const idx = fb.index ?? fallbackIndex(fb);
  const zb = fb.depth;
  const W = fb.width, H = fb.height;
  drawSpansSoftware(idx, zb, W, H, list, tex, light, colormap);
}

/** Monomorphic backend: owns framebuffer views, dispatches per span kind. */
export class SoftwareBackend implements RasterBackend {
  idx: Uint8Array = new Uint8Array(0);
  zb: Float32Array = new Float32Array(0);
  fbW = 0;
  fbH = 0;
  colormap: Uint8Array = new Uint8Array(0);
  turbTable: Uint8Array = buildTurbTable();
  time = 0;
  spansDrawn = 0;
  pixelsDrawn = 0;

  attach(idx: Uint8Array, zb: Float32Array, w: number, h: number, colormap: Uint8Array): void {
    this.idx = idx;
    this.zb = zb;
    this.fbW = w;
    this.fbH = h;
    this.colormap = colormap;
  }

  /** Branch on the span kind, never in the pixel loop (BRAIN.md §2). */
  drawSpans(list: SpanList, tex: Texture, light: LightBlock): void {
    const a = drawSpansSoftware(this.idx, this.zb, this.fbW, this.fbH, list, tex, light, this.colormap);
    const b = drawSpansTurbulent(this.idx, this.zb, this.fbW, this.fbH, list, tex, this.colormap, this.turbTable, this.time);
    const c = drawSpansFlatPerSpan(this.idx, this.zb, this.fbW, this.fbH, list);
    this.spansDrawn += a.spans + b.spans + c.spans;
    this.pixelsDrawn += a.pixels + b.pixels + c.pixels;
  }
}

const scratchIndex = new Map<number, Uint8Array>();

function fallbackIndex(fb: Framebuffer): Uint8Array {
  const n = fb.width * fb.height;
  let b = scratchIndex.get(n);
  if (!b) {
    b = new Uint8Array(n);
    scratchIndex.set(n, b);
  }
  return b;
}

/** Preallocated sine warp table (r_scan.c sintable equivalent), 1024 entries. */
export function buildTurbTable(): Uint8Array {
  const t = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) {
    t[i] = Math.round(16 + 15 * Math.sin((i / 1024) * Math.PI * 2)) & 255;
  }
  return t;
}

// --- Translucent spans (SURF_TRANS33/TRANS66, r_poly.c R_DrawAlphaSurfaces) ---
//
// C draws alpha surfaces AFTER all opaque geometry through R_ClipAndDrawPoly
// with alpha 0.30 (TRANS33) or 0.60 (TRANS66). The blended spanlets
// (R_DrawSpanlet33/66) depth-test (`*pz <= izi`, i.e. strict-greater wins,
// like the opaque loop here) but never write depth, skip texel 255, and
// blend the LIT source index with the destination through vid.alphamap:
// 33 uses alphamap[src + dst*256], 66 uses alphamap[src*256 + dst].
//
// Both tables below are stored in ONE index order, [(dst << 8) + src], so a
// single monomorphic loop serves both ratios (the ratio lives in the table,
// selected per span). extractAlphamap33/66 in colormap.ts perform the
// matching slice/transpose from a real colormap.pcx.

/** One blended subdivision (TRANS33/66, non-warped). Chains like runSubdiv16. */
export function runSubdivTranslucent(
  idx: Uint8Array,
  zb: Float32Array,
  o0: number,
  n: number,
  iz: number,
  diz: number,
  uz: number,
  duz: number,
  vz: number,
  dvz: number,
  u0: number,
  v0: number,
  light: number,
  dlight: number,
  texels: Uint8Array,
  wshift: number,
  wmask: number,
  hmask: number,
  colormap: Uint8Array,
  alpha: Uint8Array,
): { iz: number; light: number; u1: number; v1: number } {
  const z1 = 1 / (iz + diz * n);
  const u1 = (uz + duz * n) * z1, v1 = (vz + dvz * n) * z1;
  let tu = (u0 * 65536) | 0, tv = (v0 * 65536) | 0;
  const dtu = (((u1 - u0) / n) * 65536) | 0, dtv = (((v1 - v0) / n) * 65536) | 0;
  for (let i = 0, o = o0; i < n; i++, o++) {
    const texel = texels[(((tv >> 16) & hmask) << wshift) + ((tu >> 16) & wmask)]!;
    if (texel !== 255 && iz > zb[o]) {
      const lit = colormap[(light << 8) + texel]!;
      idx[o] = alpha[(idx[o]! << 8) + lit]!;
    }
    tu += dtu; tv += dtv; iz += diz; light += dlight;
  }
  return { iz, light, u1, v1 };
}

/** Blended subdivision with water warp (R_DrawSpanletTurbulentBlended33/66). */
export function runSubdivTranslucentWarp(
  idx: Uint8Array,
  zb: Float32Array,
  o0: number,
  n: number,
  iz: number,
  diz: number,
  uz: number,
  duz: number,
  vz: number,
  dvz: number,
  u0: number,
  v0: number,
  light: number,
  dlight: number,
  texels: Uint8Array,
  wshift: number,
  wmask: number,
  hmask: number,
  colormap: Uint8Array,
  alpha: Uint8Array,
  turbTable: Uint8Array,
  turbPhase: number,
): { iz: number; light: number; u1: number; v1: number } {
  const z1 = 1 / (iz + diz * n);
  const u1 = (uz + duz * n) * z1, v1 = (vz + dvz * n) * z1;
  let tu = (u0 * 65536) | 0, tv = (v0 * 65536) | 0;
  const dtu = (((u1 - u0) / n) * 65536) | 0, dtv = (((v1 - v0) / n) * 65536) | 0;
  const tmask = turbTable.length - 1;
  for (let i = 0, o = o0; i < n; i++, o++) {
    const wu = (tu + (turbTable[((tv >> 16) + turbPhase) & tmask]! << 16)) >> 16;
    const wv = (tv + (turbTable[((tu >> 16) + turbPhase) & tmask]! << 16)) >> 16;
    const texel = texels[((wv & hmask) << wshift) + (wu & wmask)]!;
    if (texel !== 255 && iz > zb[o]) {
      const lit = colormap[(light << 8) + texel]!;
      idx[o] = alpha[(idx[o]! << 8) + lit]!;
    }
    tu += dtu; tv += dtv; iz += diz; light += dlight;
  }
  return { iz, light, u1, v1 };
}

/**
 * Screen-door stipple subdivisions (R_DrawSpanlet33Stipple/66Stipple with
 * the world path's stipple_parity = 0): opaque lit texels on a fixed
 * parity lattice, no depth write. 33 draws even columns of odd rows (1/4);
 * 66 draws all of even rows + even columns of odd rows (3/4). xAbs is the
 * absolute screen x of the subdivision start, y the absolute scanline.
 */
export function runSubdivStipple33(
  idx: Uint8Array,
  zb: Float32Array,
  o0: number,
  n: number,
  xAbs: number,
  y: number,
  iz: number,
  diz: number,
  uz: number,
  duz: number,
  vz: number,
  dvz: number,
  u0: number,
  v0: number,
  light: number,
  dlight: number,
  texels: Uint8Array,
  wshift: number,
  wmask: number,
  hmask: number,
  colormap: Uint8Array,
): { iz: number; light: number; u1: number; v1: number } {
  const oddRow = (y & 1) === 1;
  const z1 = 1 / (iz + diz * n);
  const u1 = (uz + duz * n) * z1, v1 = (vz + dvz * n) * z1;
  let tu = (u0 * 65536) | 0, tv = (v0 * 65536) | 0;
  const dtu = (((u1 - u0) / n) * 65536) | 0, dtv = (((v1 - v0) / n) * 65536) | 0;
  for (let i = 0, o = o0; i < n; i++, o++) {
    if (oddRow && (((xAbs + i) & 1) === 0)) {
      const texel = texels[(((tv >> 16) & hmask) << wshift) + ((tu >> 16) & wmask)]!;
      if (texel !== 255 && iz > zb[o]) {
        idx[o] = colormap[(light << 8) + texel]!;
      }
    }
    tu += dtu; tv += dtv; iz += diz; light += dlight;
  }
  return { iz, light, u1, v1 };
}

export function runSubdivStipple66(
  idx: Uint8Array,
  zb: Float32Array,
  o0: number,
  n: number,
  xAbs: number,
  y: number,
  iz: number,
  diz: number,
  uz: number,
  duz: number,
  vz: number,
  dvz: number,
  u0: number,
  v0: number,
  light: number,
  dlight: number,
  texels: Uint8Array,
  wshift: number,
  wmask: number,
  hmask: number,
  colormap: Uint8Array,
): { iz: number; light: number; u1: number; v1: number } {
  const evenRow = (y & 1) === 0;
  const z1 = 1 / (iz + diz * n);
  const u1 = (uz + duz * n) * z1, v1 = (vz + dvz * n) * z1;
  let tu = (u0 * 65536) | 0, tv = (v0 * 65536) | 0;
  const dtu = (((u1 - u0) / n) * 65536) | 0, dtv = (((v1 - v0) / n) * 65536) | 0;
  for (let i = 0, o = o0; i < n; i++, o++) {
    if (evenRow || (((xAbs + i) & 1) === 0)) {
      const texel = texels[(((tv >> 16) & hmask) << wshift) + ((tu >> 16) & wmask)]!;
      if (texel !== 255 && iz > zb[o]) {
        idx[o] = colormap[(light << 8) + texel]!;
      }
    }
    tu += dtu; tv += dtv; iz += diz; light += dlight;
  }
  return { iz, light, u1, v1 };
}

/**
 * Translucent span pass (R_DrawAlphaSurfaces equivalent): per-span kind
 * selects the blend table (TRANS33 vs TRANS66); the warp/stipple variants
 * are chosen once per span, never per pixel. Honors the [start, count)
 * batch window like the other passes.
 */
export function drawSpansTranslucent(
  idx: Uint8Array,
  zb: Float32Array,
  fbW: number,
  fbH: number,
  list: SpanList,
  tex: Texture,
  light: LightBlock,
  colormap: Uint8Array,
  alpha33: Uint8Array,
  alpha66: Uint8Array,
  turbTable: Uint8Array | null,
  time: number,
  stipple: boolean,
): { pixels: number; spans: number } {
  const texels = tex.texels;
  const { wshift, wmask, hmask } = textureMasks(tex);
  const spans = list.spans;
  const n = list.count < spans.length ? list.count : spans.length;
  const tmask = turbTable ? turbTable.length - 1 : 0;
  const timePhase = turbTable ? (((time * 64) | 0) & tmask) : 0;
  let pixels = 0;
  let drawn = 0;
  for (let si = 0; si < n; si++) {
    const s = spans[si]!;
    if (s.kind !== SPAN_TRANS33 && s.kind !== SPAN_TRANS66) continue;
    if (s.y < 0 || s.y >= fbH) continue;
    let x0 = s.x0, x1 = s.x1;
    if (x0 < 0) x0 = 0;
    if (x1 > fbW) x1 = fbW;
    const count = x1 - x0;
    if (count <= 0) continue;
    let lz = s.light, dlz = s.dlight;
    if (s.lv >= 0) {
      const l0 = sampleLightBlock(light, s.lu, s.lv);
      const l1 = sampleLightBlock(light, s.lu + s.dlu * count, s.lv);
      lz = l0;
      dlz = (l1 - l0) / count;
    }
    const skip = x0 - s.x0;
    let iz = s.iz + s.diz * skip;
    let uz = s.uz + s.duz * skip;
    let vz = s.vz + s.dvz * skip;
    let u0 = uz / iz, v0 = vz / iz;
    let o = s.y * fbW + x0;
    let remaining = count;
    const alpha = s.kind === SPAN_TRANS66 ? alpha66 : alpha33;
    const phase = turbTable ? (timePhase + s.turb) & tmask : 0;
    while (remaining > 0) {
      const m = remaining >= SUBDIV ? SUBDIV : remaining;
      if (stipple && s.kind === SPAN_TRANS66) {
        const r = runSubdivStipple66(idx, zb, o, m, x0 + (count - remaining), s.y,
          iz, s.diz, uz, s.duz, vz, s.dvz, u0, v0, lz, dlz,
          texels, wshift, wmask, hmask, colormap);
        iz = r.iz; lz = r.light;
        uz += s.duz * m; vz += s.dvz * m;
        u0 = r.u1; v0 = r.v1;
      } else if (stipple) {
        const r = runSubdivStipple33(idx, zb, o, m, x0 + (count - remaining), s.y,
          iz, s.diz, uz, s.duz, vz, s.dvz, u0, v0, lz, dlz,
          texels, wshift, wmask, hmask, colormap);
        iz = r.iz; lz = r.light;
        uz += s.duz * m; vz += s.dvz * m;
        u0 = r.u1; v0 = r.v1;
      } else if (turbTable) {
        const r = runSubdivTranslucentWarp(idx, zb, o, m,
          iz, s.diz, uz, s.duz, vz, s.dvz, u0, v0, lz, dlz,
          texels, wshift, wmask, hmask, colormap, alpha, turbTable, phase);
        iz = r.iz; lz = r.light;
        uz += s.duz * m; vz += s.dvz * m;
        u0 = r.u1; v0 = r.v1;
      } else {
        const r = runSubdivTranslucent(idx, zb, o, m,
          iz, s.diz, uz, s.duz, vz, s.dvz, u0, v0, lz, dlz,
          texels, wshift, wmask, hmask, colormap, alpha);
        iz = r.iz; lz = r.light;
        uz += s.duz * m; vz += s.dvz * m;
        u0 = r.u1; v0 = r.v1;
      }
      o += m; remaining -= m;
    }
    pixels += count;
    drawn++;
  }
  return { pixels, spans: drawn };
}

// --- RGB world backend (astra V2a/V2c, serial voodoo-policy path) ---------
//
// Internal to @q2/sw-renderer: NOT part of the frozen RasterBackend
// contract (BRAIN.md §5). drawSpansRGB takes an RGBMaterial binding, which
// carries the mip chain + RGB lightmap + blend/depth state the scalar
// drawSpans signature cannot express. The software path above is untouched;
// when the RGB flag is off this code never runs and software pixels are
// bit-identical.
//
// Sampler math (bilinear RGB taps, LOD + bias, Bayer mip-dither pick,
// lightmap modulate) is ported from @q2/voodoo sampler.ts (pure functions,
// identical integer behavior). A direct @q2/voodoo import is deliberately
// NOT used: the enforced dependency rules (tools/asset-cooker dep check)
// allow sw-renderer only bsp/config/formats/math/renderer-api, and widening
// that allowlist is outside this change — so the helpers live here until a
// follow-up moves them somewhere both packages may depend on. Deviations
// from the voodoo originals are marked PORT-DIFF below.

/** Texture addressing per axis (world textures repeat, lightmaps clamp). */
export type RGBAddressMode = 'repeat' | 'clamp';

/**
 * RGB blend mode. Opaque world writes texel x light directly; alpha blends
 * against the current RGB plane (translucent glass/water, fading alias
 * explosions); additive adds and clamps (tracer beams, particles/glow).
 * Invalid strings from JS callers Com_Error at draw time, never silently
 * draw wrong pixels.
 */
export type RGBBlend = 'opaque' | 'alpha' | 'additive';

/** One expanded-RGB mip level (w*h triplets, 8:8:8). */
export interface RGBMipLevel {
  data: Uint8Array;
  width: number;
  height: number;
  /**
   * Per-texel opacity mask (w*h bytes, 1 = opaque). Base level marks index
   * 255 texels as holes; each halve keeps a texel opaque only when ALL four
   * sources are opaque, so filtered edges erode toward transparency instead
   * of smearing opaque black fringes. Levels of an opaqueMask material are
   * all-ones. The transparent-hole skip never writes depth.
   */
  mask: Uint8Array;
}

/** RGB light samples in luxel space (bilinear sampling like LightBlock). */
export interface RGBLightmap {
  /** w*h*3 bytes 0..255, row-major */
  samples: Uint8Array;
  luxW: number;
  luxH: number;
}

/**
 * Internal RGB material binding (kept inside sw-renderer, NOT renderer-api).
 * Built per surface from the MiniWorld texture (indices expanded through
 * the palette at upload) + the bspWorld RGB luxels + style/dlight state.
 */
export interface RGBMaterial {
  /** Mip chain, [0] full res (box-filtered halves until 1x1). */
  levels: RGBMipLevel[];
  addressS: RGBAddressMode;
  addressT: RGBAddressMode;
  /** RGB luxel block + luxel dims; null = unlit (textured sky): texel as-is. */
  light: RGBLightmap | null;
  /** x2 modulate + clamp (vd_overbright policy). */
  overbright: boolean;
  /** Added to log2(rho); negative favours finer levels (voodoo tLOD sign). */
  lodBias: number;
  /** Per-pixel Bayer choice between level n / n+1 (single-TMU trilinear). */
  mipDither: boolean;
  /**
   * Blend policy for this material. 'opaque' replaces the plane pixel;
   * 'alpha' blends with `alpha` (0..1, clamped; TRANS span kinds override
   * with their 33/66 ratio); 'additive' adds and clamps. Depth-test always
   * applies; depth writes follow `depthWrite` except TRANS kinds, which
   * never write (R_DrawAlphaSurfaces semantics).
   */
  blend: RGBBlend;
  /**
   * Blend factor for blend:'alpha' on non-TRANS spans (alias fade, sprite
   * fade). Clamped to [0,1]; NaN -> 0 (fully transparent, still covered).
   */
  alpha: number;
  /** Warp texture coords through the turbulence table (water surfaces). */
  warp: boolean;
  /** Turbulence phase 0..1023 for this frame (time*64 & 1023). */
  turbPhase: number;
  /**
   * Solid fill color for SPAN_FLAT (flat sky, 3 bytes RGB). Null with a FLAT
   * span in the list is an unsupported combo and Com_Errors at draw time.
   */
  flatColor: Uint8Array | null;
  /**
   * Skip transparent texels (index 255 holes). Always on: the mask lives
   * per mip level (see RGBMipLevel.mask). `opaqueMask` materials (skybox)
   * carry all-ones masks so the check is a cheap constant.
   */
  alphaTest: number | null;
  /** Write 1/z on a passed depth test (false for translucent surfaces). */
  depthWrite: boolean;
}

/** Row-major 4x4 Bayer matrix, values 0..15 (voodoo bayer.ts port). */
const RGB_BAYER4 = new Uint8Array([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]);

/**
 * Mipmap LOD: lod = log2(rho) + bias, clamped to [0, maxLevel] (voodoo
 * mipLevel port). PORT-DIFF: total (never throws — the hot loop must not
 * trap): non-positive/NaN rho clamps to epsilon, non-finite bias to 0.
 */
export function rgbMipLevel(rho: number, bias: number, maxLevel: number): number {
  const r = rho > 0 ? rho : 1e-6;
  const b = Number.isFinite(bias) ? bias : 0;
  const lod = Math.log2(r) + b;
  if (!(lod > 0)) return 0;
  const cap = maxLevel < 0 ? 0 : maxLevel;
  return lod > cap ? cap : lod;
}

/**
 * Single-TMU "trilinear": per-pixel pick of LOD n or n+1 by comparing the
 * fractional LOD against the Bayer threshold (voodoo pickMipLevel port).
 */
export function rgbPickMipLevel(
  lod: number,
  x: number,
  y: number,
  mipDither: boolean,
  maxLevel: number,
): number {
  const clamped = lod < 0 ? 0 : lod;
  const n = clamped | 0;
  const f = clamped - n;
  let level: number;
  if (!mipDither) {
    level = f < 0.5 ? n : n + 1;
  } else {
    const bx = (x | 0) & 3, by = (y | 0) & 3;
    level = f * 16 <= RGB_BAYER4[(by << 2) | bx]! ? n : n + 1;
  }
  return level > maxLevel ? maxLevel : level;
}

/**
 * Bilinear sample of an expanded-RGB texture level into out[off..off+2]
 * (voodoo sampleRGBTexture port: 8-bit fixed-point weights, integer
 * channel math — no floats per channel in the inner loop). Integer u/v =
 * texel centre, matching the software floor(u) convention at integers.
 * PORT-DIFF: per-axis repeat/clamp addressing (voodoo clamps; world
 * textures repeat — each tap wraps so bilinear seams stay sealed).
 */
export function rgbSampleTexture(
  tex: Uint8Array,
  w: number,
  h: number,
  u: number,
  v: number,
  out: Uint8Array,
  off: number,
  wrapS: boolean,
  wrapT: boolean,
): void {
  let x0: number, y0: number, x1: number, y1: number, fu: number, fv: number;
  if (wrapS || wrapT) {
    const uw = wrapS ? (((u % w) + w) % w) : (u < 0 ? 0 : u > w - 1 ? w - 1 : u);
    const vw = wrapT ? (((v % h) + h) % h) : (v < 0 ? 0 : v > h - 1 ? h - 1 : v);
    x0 = uw | 0;
    y0 = vw | 0;
    x1 = wrapS ? (x0 + 1) % w : (x0 + 1 < w ? x0 + 1 : x0);
    y1 = wrapT ? (y0 + 1) % h : (y0 + 1 < h ? y0 + 1 : y0);
    fu = Math.round((uw - x0) * 256);
    fv = Math.round((vw - y0) * 256);
  } else {
    const uc = u < 0 ? 0 : u > w - 1 ? w - 1 : u;
    const vc = v < 0 ? 0 : v > h - 1 ? h - 1 : v;
    x0 = uc | 0;
    y0 = vc | 0;
    x1 = x0 + 1 < w ? x0 + 1 : x0;
    y1 = y0 + 1 < h ? y0 + 1 : y0;
    fu = Math.round((uc - x0) * 256);
    fv = Math.round((vc - y0) * 256);
  }
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

/**
 * Bilinear sample of an RGB luxel block in luxel space (light is always
 * clamp-addressed). Integer channel math like the texture sampler.
 */
export function rgbSampleLightmap(
  lb: RGBLightmap,
  lu: number,
  lv: number,
  out: Uint8Array,
  off: number,
): void {
  const w = lb.luxW, h = lb.luxH, v = lb.samples;
  const uc = lu < 0 ? 0 : lu > w - 1 ? w - 1 : lu;
  const vc = lv < 0 ? 0 : lv > h - 1 ? h - 1 : lv;
  const x0 = uc | 0, y0 = vc | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fu = Math.round((uc - x0) * 256);
  const fv = Math.round((vc - y0) * 256);
  const w00 = (256 - fu) * (256 - fv);
  const w10 = fu * (256 - fv);
  const w01 = (256 - fu) * fv;
  const w11 = fu * fv;
  const pa = (y0 * w + x0) * 3;
  const pb = (y0 * w + x1) * 3;
  const pc = (y1 * w + x0) * 3;
  const pd = (y1 * w + x1) * 3;
  for (let c = 0; c < 3; c++) {
    out[off + c] =
      ((w00 * v[pa + c]! + w10 * v[pb + c]! + w01 * v[pc + c]! + w11 * v[pd + c]! + 32768) >> 16);
  }
}

/**
 * Diffuse x lightmap x (overbright ? 2 : 1), clamped (voodoo
 * modulateLightmap port). Inputs/outputs 0..255, integer math.
 * PORT-DIFF: channels out via out[off..off+2] instead of a packed pixel
 * (the span loop packs once, in target 0xAABBGGRR order).
 */
export function rgbModulate(
  tr: number,
  tg: number,
  tb: number,
  lr: number,
  lg: number,
  lb: number,
  overbright: boolean,
  out: Uint8Array,
  off: number,
): void {
  const m = overbright ? 2 : 1;
  let r = (((tr * lr * m + 127) / 255) | 0);
  let g = (((tg * lg * m + 127) / 255) | 0);
  let b = (((tb * lb * m + 127) / 255) | 0);
  r = r > 255 ? 255 : r;
  g = g > 255 ? 255 : g;
  b = b > 255 ? 255 : b;
  out[off] = r;
  out[off + 1] = g;
  out[off + 2] = b;
}

/** Expand palette indices to 8:8:8 triplets (upload-time expansion). */
export function expandPaletteRGB(
  texels: Uint8Array,
  w: number,
  h: number,
  palette: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(w * h * 3);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const p = (texels[i]! & 255) * 3;
    out[i * 3] = palette[p] ?? 0;
    out[i * 3 + 1] = palette[p + 1] ?? 0;
    out[i * 3 + 2] = palette[p + 2] ?? 0;
  }
  return out;
}

/** One box-filtered (2x2 average) halve step for the mip chain. */
/** One box-filtered (2x2 average) halve step for the mip chain, with the
 * opacity mask: a child texel stays opaque only when ALL four sources are
 * opaque (edges erode toward transparency instead of fringing). */
function halveRGBLevel(
  src: Uint8Array, sw: number, sh: number, srcMask: Uint8Array,
): RGBMipLevel {
  const w = Math.max(1, sw >> 1), h = Math.max(1, sh >> 1);
  const data = new Uint8Array(w * h * 3);
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(x * 2, sw - 1), sy = Math.min(y * 2, sh - 1);
      const x1 = Math.min(sx + 1, sw - 1), y1 = Math.min(sy + 1, sh - 1);
      const opaque = srcMask[sy * sw + sx]! & srcMask[sy * sw + x1]! &
        srcMask[y1 * sw + sx]! & srcMask[y1 * sw + x1]!;
      mask[y * w + x] = opaque;
      for (let c = 0; c < 3; c++) {
        const a = src[(sy * sw + sx) * 3 + c]!;
        const b = src[(sy * sw + x1) * 3 + c]!;
        const d = src[(y1 * sw + sx) * 3 + c]!;
        const e = src[(y1 * sw + x1) * 3 + c]!;
        data[(y * w + x) * 3 + c] = (a + b + d + e + 2) >> 2;
      }
    }
  }
  return { data, width: w, height: h, mask };
}

/**
 * Build an RGBMaterial from indexed texels + an optional RGB luxel block.
 * The mip chain is expanded once here (upload-time cost); the span loop
 * only reads. levels is never empty (invalid dims fall back to 1x1 black).
 * The base opacity mask marks index-255 texels as holes, so transparent
 * texels never write color or depth at any mip; `opaqueMask: true` (skybox,
 * whose PCX art must sample verbatim) forces an all-opaque mask instead.
 */
export function buildRGBMaterial(
  texels: Uint8Array,
  w: number,
  h: number,
  palette: Uint8Array,
  light: RGBLightmap | null,
  opts?: {
    addressS?: RGBAddressMode; addressT?: RGBAddressMode;
    overbright?: boolean; lodBias?: number; mipDither?: boolean;
    blend?: RGBBlend; alphaTest?: number | null; depthWrite?: boolean;
    alpha?: number; warp?: boolean; turbPhase?: number;
    flatColor?: Uint8Array | null; opaqueMask?: boolean;
  },
): RGBMaterial {
  const levels: RGBMipLevel[] = [];
  if (w >= 1 && h >= 1 && texels.length >= w * h) {
    const base = expandPaletteRGB(texels.subarray(0, w * h), w, h, palette);
    const baseMask = new Uint8Array(w * h);
    if (opts?.opaqueMask === true) {
      baseMask.fill(1);
    } else {
      for (let i = 0; i < w * h; i++) baseMask[i] = texels[i]! === 255 ? 0 : 1;
    }
    levels.push({ data: base, width: w, height: h, mask: baseMask });
    let cw = w, ch = h;
    let cur: Uint8Array = base;
    let curMask: Uint8Array = baseMask;
    while (cw > 1 || ch > 1) {
      const next = halveRGBLevel(cur, cw, ch, curMask);
      levels.push(next);
      cur = next.data;
      curMask = next.mask;
      cw = next.width;
      ch = next.height;
    }
  } else {
    levels.push({ data: new Uint8Array(3), width: 1, height: 1, mask: new Uint8Array([1]) });
  }
  const alphaRaw = opts?.alpha ?? 1;
  const alpha = Number.isFinite(alphaRaw) ? (alphaRaw < 0 ? 0 : alphaRaw > 1 ? 1 : alphaRaw) : 1;
  return {
    levels,
    addressS: opts?.addressS ?? 'repeat',
    addressT: opts?.addressT ?? 'repeat',
    light,
    overbright: opts?.overbright ?? true,
    lodBias: opts?.lodBias ?? -0.35,
    mipDither: opts?.mipDither ?? true,
    blend: opts?.blend ?? 'opaque',
    alphaTest: opts?.alphaTest ?? null,
    depthWrite: opts?.depthWrite ?? true,
    alpha,
    warp: opts?.warp ?? false,
    turbPhase: (opts?.turbPhase ?? 0) & 1023,
    flatColor: opts?.flatColor ? opts.flatColor.slice(0, 3) : null,
  };
}

// Module scratch for the RGB pixel loop (serial path only, no allocation).
const _rgbTex = new Uint8Array(3);
const _rgbLit = new Uint8Array(3);
/** Shared turbulence table for warped RGB spans (same table as software). */
const _rgbTurb = buildTurbTable();

/**
 * One 16-pixel RGB subdivision (repeat-addressed texture). Mirrors
 * runSubdiv16: ONE division, fixed-point u/v stepping, float luxel stepping;
 * samples the per-pixel mip level, bilinear RGB texel x bilinear RGB
 * luxel, integer modulate, 1/z depth test + write. Returns the chaining
 * tuple (iz, lux, u1, v1) so the caller chains subdivisions exactly.
 */
export function runSubdivRGBRepeat(
  color: Uint32Array,
  cover: Uint8Array,
  zb: Float32Array,
  o0: number,
  n: number,
  xAbs: number,
  yAbs: number,
  iz: number,
  diz: number,
  uz: number,
  duz: number,
  vz: number,
  dvz: number,
  u0: number,
  v0: number,
  lux0: number,
  dlux: number,
  lv: number,
  mat: RGBMaterial,
  spanLod: number,
  maxLevel: number,
): { iz: number; lux: number; u1: number; v1: number } {
  const levels = mat.levels;
  const lb = mat.light;
  const overbright = mat.overbright;
  const mipDither = mat.mipDither;
  const z1 = 1 / (iz + diz * n);
  const u1 = (uz + duz * n) * z1, v1 = (vz + dvz * n) * z1;
  let tu = (u0 * 65536) | 0, tv = (v0 * 65536) | 0;
  const dtu = (((u1 - u0) / n) * 65536) | 0, dtv = (((v1 - v0) / n) * 65536) | 0;
  let lux = lux0;
  for (let i = 0, o = o0; i < n; i++, o++) {
    if (iz > zb[o]!) {
      const lvl = rgbPickMipLevel(spanLod, xAbs + i, yAbs, mipDither, maxLevel);
      const t = levels[lvl]!;
      // Nearest-tap opacity mask: index-255 holes never write color or
      // depth (no opaque black fringes). Same wrap convention as the
      // bilinear tap below so the hole test agrees with the sample.
      const mxr = rgbWrapCoord(tu >> 16, t.width, true);
      const myr = rgbWrapCoord(tv >> 16, t.height, true);
      if (t.mask[myr * t.width + mxr]! !== 0) {
        rgbSampleTexture(t.data, t.width, t.height, tu / 65536, tv / 65536, _rgbTex, 0, true, true);
        let r = _rgbTex[0]!, g = _rgbTex[1]!, b = _rgbTex[2]!;
        if (lb) {
          rgbSampleLightmap(lb, lux, lv, _rgbLit, 0);
          rgbModulate(r, g, b, _rgbLit[0]!, _rgbLit[1]!, _rgbLit[2]!, overbright, _rgbLit, 0);
          r = _rgbLit[0]!;
          g = _rgbLit[1]!;
          b = _rgbLit[2]!;
        }
        zb[o] = iz;
        color[o] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
        cover[o] = 1;
      }
    }
    tu += dtu; tv += dtv; iz += diz; lux += dlux;
  }
  return { iz, lux, u1, v1 };
}

/**
 * Clamp-addressed twin of runSubdivRGBRepeat (reserved for clamp materials
 * such as sky tiles; the wired world pass uses repeat). Separate
 * monomorphic loop so the address mode branches per span, never per pixel.
 */
export function runSubdivRGBClamp(
  color: Uint32Array,
  cover: Uint8Array,
  zb: Float32Array,
  o0: number,
  n: number,
  xAbs: number,
  yAbs: number,
  iz: number,
  diz: number,
  uz: number,
  duz: number,
  vz: number,
  dvz: number,
  u0: number,
  v0: number,
  lux0: number,
  dlux: number,
  lv: number,
  mat: RGBMaterial,
  spanLod: number,
  maxLevel: number,
): { iz: number; lux: number; u1: number; v1: number } {
  const levels = mat.levels;
  const lb = mat.light;
  const overbright = mat.overbright;
  const mipDither = mat.mipDither;
  const z1 = 1 / (iz + diz * n);
  const u1 = (uz + duz * n) * z1, v1 = (vz + dvz * n) * z1;
  let tu = (u0 * 65536) | 0, tv = (v0 * 65536) | 0;
  const dtu = (((u1 - u0) / n) * 65536) | 0, dtv = (((v1 - v0) / n) * 65536) | 0;
  let lux = lux0;
  for (let i = 0, o = o0; i < n; i++, o++) {
    if (iz > zb[o]!) {
      const lvl = rgbPickMipLevel(spanLod, xAbs + i, yAbs, mipDither, maxLevel);
      const t = levels[lvl]!;
      const mxc = rgbWrapCoord(tu >> 16, t.width, false);
      const myc = rgbWrapCoord(tv >> 16, t.height, false);
      if (t.mask[myc * t.width + mxc]! !== 0) {
        rgbSampleTexture(t.data, t.width, t.height, tu / 65536, tv / 65536, _rgbTex, 0, false, false);
        let r = _rgbTex[0]!, g = _rgbTex[1]!, b = _rgbTex[2]!;
        if (lb) {
          rgbSampleLightmap(lb, lux, lv, _rgbLit, 0);
          rgbModulate(r, g, b, _rgbLit[0]!, _rgbLit[1]!, _rgbLit[2]!, overbright, _rgbLit, 0);
          r = _rgbLit[0]!;
          g = _rgbLit[1]!;
          b = _rgbLit[2]!;
        }
        zb[o] = iz;
        color[o] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
        cover[o] = 1;
      }
    }
    tu += dtu; tv += dtv; iz += diz; lux += dlux;
  }
  return { iz, lux, u1, v1 };
}

/**
 * Nearest-tap coordinate fold for the opacity mask (integer texel units).
 * Repeat wraps (negative-safe); clamp pins to the edge. Mirrors the float
 * convention in rgbSampleTexture so the hole test agrees with the sample.
 */
export function rgbWrapCoord(c: number, size: number, wrap: boolean): number {
  if (wrap) {
    let m = c % size;
    if (m < 0) m += size;
    return m;
  }
  if (c < 0) return 0;
  if (c > size - 1) return size - 1;
  return c;
}

/**
 * Composite one RGB source pixel over the plane (voodoo alpha/additive
 * blend stages, integer math, no floats per channel). Opaque replaces;
 * alpha blends src*a + dst*(1-a) with a = alphaQ/256; additive adds and
 * clamps. `cover` is always marked by the caller on a passed depth test.
 */
export function rgbBlendPixel(
  color: Uint32Array,
  o: number,
  r: number, g: number, b: number,
  blend: RGBBlend,
  alphaQ: number,
): void {
  if (blend === 'opaque') {
    color[o] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    return;
  }
  const dst = color[o]!;
  const dr = dst & 255, dg = (dst >> 8) & 255, db = (dst >> 16) & 255;
  if (blend === 'additive') {
    const ar = dr + r > 255 ? 255 : dr + r;
    const ag = dg + g > 255 ? 255 : dg + g;
    const ab = db + b > 255 ? 255 : db + b;
    color[o] = (0xff000000 | (ab << 16) | (ag << 8) | ar) >>> 0;
    return;
  }
  const a = alphaQ < 0 ? 0 : alphaQ > 256 ? 256 : alphaQ;
  const ia = 256 - a;
  color[o] = (0xff000000 |
    (((db * ia + b * a + 128) >> 8) << 16) |
    (((dg * ia + g * a + 128) >> 8) << 8) |
    ((dr * ia + r * a + 128) >> 8)) >>> 0;
}

/**
 * Generic RGB subdivision: optional turbulence warp, per-pixel mip pick,
 * opacity-mask skip, then opaque/alpha/additive composite. Separate from
 * the two hot opaque loops above (which stay monomorphic for the world
 * pass); the per-pixel mode flags here serve turbulent water, glass and
 * other effect spans where warp/blend vary per span, never in steady
 * opaque world fill. PORT-DIFF vs voodoo sampler.ts: warp + mask + blend
 * stages are renderer-side policy; the tap math (fixed-point weights) is
 * the same integer formulation.
 */
export function runSubdivRGBGeneric(
  color: Uint32Array,
  cover: Uint8Array,
  zb: Float32Array,
  o0: number,
  n: number,
  xAbs: number,
  yAbs: number,
  iz: number,
  diz: number,
  uz: number,
  duz: number,
  vz: number,
  dvz: number,
  u0: number,
  v0: number,
  lux0: number,
  dlux: number,
  lv: number,
  mat: RGBMaterial,
  spanLod: number,
  maxLevel: number,
  blend: RGBBlend,
  alphaQ: number,
  turbTable: Uint8Array | null,
  turbPhase: number,
): { iz: number; lux: number; u1: number; v1: number } {
  const levels = mat.levels;
  const lb = mat.light;
  const overbright = mat.overbright;
  const mipDither = mat.mipDither;
  const wrapS = mat.addressS === 'repeat';
  const wrapT = mat.addressT === 'repeat';
  const writeDepth = blend === 'opaque' ? mat.depthWrite : false;
  const z1 = 1 / (iz + diz * n);
  const u1 = (uz + duz * n) * z1, v1 = (vz + dvz * n) * z1;
  let tu = (u0 * 65536) | 0, tv = (v0 * 65536) | 0;
  const dtu = (((u1 - u0) / n) * 65536) | 0, dtv = (((v1 - v0) / n) * 65536) | 0;
  const tmask = turbTable ? turbTable.length - 1 : 0;
  let lux = lux0;
  for (let i = 0, o = o0; i < n; i++, o++) {
    if (iz > zb[o]!) {
      let fu = tu, fv = tv;
      if (turbTable) {
        const wu = (tu + (turbTable[((tv >> 16) + turbPhase) & tmask]! << 16)) >> 16;
        const wv = (tv + (turbTable[((tu >> 16) + turbPhase) & tmask]! << 16)) >> 16;
        fu = wu << 16;
        fv = wv << 16;
      }
      const lvl = rgbPickMipLevel(spanLod, xAbs + i, yAbs, mipDither, maxLevel);
      const t = levels[lvl]!;
      const mx = rgbWrapCoord(fu >> 16, t.width, wrapS);
      const my = rgbWrapCoord(fv >> 16, t.height, wrapT);
      if (t.mask[my * t.width + mx]! !== 0) {
        rgbSampleTexture(t.data, t.width, t.height, fu / 65536, fv / 65536, _rgbTex, 0, wrapS, wrapT);
        let r = _rgbTex[0]!, g = _rgbTex[1]!, b = _rgbTex[2]!;
        if (lb) {
          rgbSampleLightmap(lb, lux, lv, _rgbLit, 0);
          rgbModulate(r, g, b, _rgbLit[0]!, _rgbLit[1]!, _rgbLit[2]!, overbright, _rgbLit, 0);
          r = _rgbLit[0]!;
          g = _rgbLit[1]!;
          b = _rgbLit[2]!;
        }
        if (writeDepth) zb[o] = iz;
        rgbBlendPixel(color, o, r, g, b, blend, alphaQ);
        cover[o] = 1;
      }
    }
    tu += dtu; tv += dtv; iz += diz; lux += dlux;
  }
  return { iz, lux, u1, v1 };
}

/** Flat RGB span fill (flat sky): depth-tested solid color, no texture. */
export function runSpanFlatRGB(
  color: Uint32Array,
  cover: Uint8Array,
  zb: Float32Array,
  o0: number,
  n: number,
  iz: number,
  diz: number,
  r: number, g: number, b: number,
  depthWrite: boolean,
): number {
  let z = iz;
  for (let i = 0, o = o0; i < n; i++, o++) {
    if (z > zb[o]!) {
      if (depthWrite) zb[o] = z;
      color[o] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      cover[o] = 1;
    }
    z += diz;
  }
  return z;
}

/**
 * RGB span rasteriser (drawSpansSoftware twin + effect coverage). Reuses
 * traversal/clipping: perspective-correct UVs (uz/vz/iz), lightmap bilinear
 * in luxel space (lu + dlu*x at constant lv, exactly the software gradient
 * convention). Writes 0xAABBGGRR into `color`, 1/z into `zb` (the RGB
 * path owns a separate depth plane; Framebuffer.depth semantics untouched),
 * and marks `cover` per written pixel so endFrame can composite over the
 * indexed resolve. Per-span-kind dispatch (branch on the span, never in
 * the pixel loop):
 * - SPAN_OPAQUE: textured, opaque/alpha/additive per material.
 * - SPAN_TURBULENT: water-warped texture, blend per material.
 * - SPAN_TRANS33/TRANS66: glass/water alpha (33/66 ratios, or additive
 *   when the material selects it), never depth-writing.
 * - SPAN_FLAT: solid fill from mat.flatColor (flat sky).
 * Anything else (unknown kind, FLAT without flatColor, empty mip chain,
 * unknown blend string) is an unsupported combo and Com_Errors — never
 * silent wrong pixels. Zero allocation.
 */
export function drawSpansRGB(
  color: Uint32Array,
  cover: Uint8Array,
  zb: Float32Array,
  fbW: number,
  fbH: number,
  list: SpanList,
  mat: RGBMaterial,
): { pixels: number; spans: number } {
  const blend = mat.blend;
  if (blend !== 'opaque' && blend !== 'alpha' && blend !== 'additive') {
    Com_Error('error', 'drawSpansRGB: unsupported blend (step-3 coverage pending)');
  }
  if (mat.levels.length < 1) {
    Com_Error('error', 'drawSpansRGB: material has no mip levels');
  }
  const repeat = mat.addressS === 'repeat' && mat.addressT === 'repeat';
  const levels = mat.levels;
  const maxLevel = levels.length - 1;
  const alphaQ = Math.round(mat.alpha * 256);
  const spans = list.spans;
  const n = list.count < spans.length ? list.count : spans.length;
  let pixels = 0;
  let drawn = 0;
  for (let si = 0; si < n; si++) {
    const s = spans[si]!;
    const kind = s.kind;
    if (kind !== SPAN_OPAQUE && kind !== SPAN_TURBULENT &&
      kind !== SPAN_TRANS33 && kind !== SPAN_TRANS66 && kind !== SPAN_FLAT) {
      Com_Error('error', 'drawSpansRGB: unsupported span kind (step-3 coverage pending)');
    }
    if (s.y < 0 || s.y >= fbH) continue;
    let x0 = s.x0, x1 = s.x1;
    if (x0 < 0) x0 = 0;
    if (x1 > fbW) x1 = fbW;
    const count = x1 - x0;
    if (count <= 0) continue;
    if (kind === SPAN_FLAT) {
      const fc = mat.flatColor;
      if (!fc) {
        Com_Error('error', 'drawSpansRGB: FLAT span without flatColor');
      }
      runSpanFlatRGB(color, cover, zb, s.y * fbW + x0, count,
        s.iz + s.diz * (x0 - s.x0), s.diz, fc[0]!, fc[1]!, fc[2]!, mat.depthWrite);
      pixels += count;
      drawn++;
      continue;
    }
    // Clip-adjusted perspective start (same as the software path).
    const skip = x0 - s.x0;
    let iz = s.iz + s.diz * skip;
    let uz = s.uz + s.duz * skip;
    let vz = s.vz + s.dvz * skip;
    let lux = s.lu + s.dlu * skip;
    let u0 = uz / iz, v0 = vz / iz;
    // Per-span LOD from the screen-space texture footprint (x-gradients;
    // y-derivatives are ignored — serial-milestone approximation, the
    // per-pixel Bayer dither still varies the chosen level within the row).
    const dudx = (s.duz - u0 * s.diz) / iz;
    const dvdx = (s.dvz - v0 * s.diz) / iz;
    const aud = dudx < 0 ? -dudx : dudx;
    const avd = dvdx < 0 ? -dvdx : dvdx;
    const spanLod = rgbMipLevel(aud > avd ? aud : avd, mat.lodBias, maxLevel);
    const isTrans = kind === SPAN_TRANS33 || kind === SPAN_TRANS66;
    const useWarp = kind === SPAN_TURBULENT || (isTrans && mat.warp);
    const useBlend: RGBBlend = isTrans
      ? (blend === 'additive' ? 'additive' : 'alpha')
      : blend;
    const useAlphaQ = isTrans && useBlend === 'alpha'
      ? (kind === SPAN_TRANS66 ? 169 : 85)
      : alphaQ;
    let o = s.y * fbW + x0;
    let remaining = count;
    if (!useWarp && useBlend === 'opaque' && mat.depthWrite) {
      // Hot opaque path: monomorphic repeat/clamp loops (mask skip inside).
      while (remaining > 0) {
        const m = remaining >= SUBDIV ? SUBDIV : remaining;
        let r: { iz: number; lux: number; u1: number; v1: number };
        if (repeat) {
          r = runSubdivRGBRepeat(
            color, cover, zb, o, m, x0 + (count - remaining), s.y,
            iz, s.diz, uz, s.duz, vz, s.dvz, u0, v0, lux, s.dlu, s.lv,
            mat, spanLod, maxLevel);
        } else {
          r = runSubdivRGBClamp(
            color, cover, zb, o, m, x0 + (count - remaining), s.y,
            iz, s.diz, uz, s.duz, vz, s.dvz, u0, v0, lux, s.dlu, s.lv,
            mat, spanLod, maxLevel);
        }
        iz = r.iz;
        lux = r.lux;
        uz += s.duz * m;
        vz += s.dvz * m;
        u0 = r.u1;
        v0 = r.v1;
        o += m;
        remaining -= m;
      }
    } else {
      // Effect path: warped and/or blended spans (water, glass).
      const turb = useWarp ? _rgbTurb : null;
      while (remaining > 0) {
        const m = remaining >= SUBDIV ? SUBDIV : remaining;
        const r = runSubdivRGBGeneric(
          color, cover, zb, o, m, x0 + (count - remaining), s.y,
          iz, s.diz, uz, s.duz, vz, s.dvz, u0, v0, lux, s.dlu, s.lv,
          mat, spanLod, maxLevel, useBlend, useAlphaQ, turb,
          turb ? (mat.turbPhase + s.turb) & (turb.length - 1) : 0);
        iz = r.iz;
        lux = r.lux;
        uz += s.duz * m;
        vz += s.dvz * m;
        u0 = r.u1;
        v0 = r.v1;
        o += m;
        remaining -= m;
      }
    }
    pixels += count;
    drawn++;
  }
  return { pixels, spans: drawn };
}

/**
 * Monomorphic RGB backend: owns the RGB888 work plane + coverage mask,
 * dispatches the opaque world pass. Framebuffer.depth keeps 1/z semantics
 * (same strict-greater test as the software loop); 16-bit depth
 * quantization at test/write is deferred to step 4 (target/depth).
 */
export class RGBWorldBackend {
  color: Uint32Array = new Uint32Array(0);
  cover: Uint8Array = new Uint8Array(0);
  zb: Float32Array = new Float32Array(0);
  fbW = 0;
  fbH = 0;
  spansDrawn = 0;
  pixelsDrawn = 0;

  attach(
    color: Uint32Array, cover: Uint8Array, zb: Float32Array, w: number, h: number,
  ): void {
    this.color = color;
    this.cover = cover;
    this.zb = zb;
    this.fbW = w;
    this.fbH = h;
  }

  /** Opaque RGB world pass (counts mirror SoftwareBackend accounting). */
  drawSpansRGB(list: SpanList, mat: RGBMaterial): { pixels: number; spans: number } {
    const r = drawSpansRGB(
      this.color, this.cover, this.zb, this.fbW, this.fbH, list, mat,
    );
    this.spansDrawn += r.spans;
    this.pixelsDrawn += r.pixels;
    return r;
  }
}
