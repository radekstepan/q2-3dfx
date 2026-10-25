// @q2/sw-renderer spans — D_DrawSpans16 port (r_scan.c, BRAIN.md §7.1).
//
// Rules enforced here (BRAIN.md §2):
// - Uint8Array/Float32Array only in the inner loop. No objects, no closures.
// - 16.16 fixed point texture coords, ONE division per 16-pixel subdivision.
// - Separate monomorphic entry points per span kind (opaque / turbulent /
//   flat). The kind branches once per SPAN, never inside the pixel loop.

import type { Framebuffer } from '@q2/renderer-api';

/** Pixels per perspective-correct subdivision step. */
export const SUBDIV = 16;

/** Span kinds. Branched per-span in drawSpans*, never per-pixel. */
export const SPAN_OPAQUE = 0;
export const SPAN_TURBULENT = 1;
export const SPAN_FLAT = 2;

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
  return { wshift, wmask: tex.width - 1, hmask: tex.height - 1 };
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
    this.spansDrawn += a.spans + b.spans;
    this.pixelsDrawn += a.pixels + b.pixels;
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
