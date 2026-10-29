// @q2/sw-renderer tracer — blaster-bolt / shotgun-pellet beam path.
// A 3D line segment drawn in index space with a 1/z depth test: project both
// endpoints, clip to the near plane, then DDA across screen pixels
// interpolating 1/z. The color is a raw palette index written directly (no
// colormap grade — beams are full-bright, the ref_soft "additive" look).
// Zero allocation: pure function of the handed planes.

import type { Camera } from './camera.js';
import {
  packRGB565, windowDepthQ16,
  SPAN_ADD, createSpan,
  DEFAULT_RGB_FAR, DEFAULT_RGB_NEAR, type RGBWindow, type SpanList,
} from './spans.js';

/** Default beam length in world units (entity `frame` overrides). */
export const TRACER_DEFAULT_LENGTH = 96;
/** Default beam color when the entity carries no palette index. */
export const TRACER_DEFAULT_COLOR = 225;
/**
 * Beam core color: near-white fullbright (real Q2 palette 215 =
 * 255,255,255; bright warm white under the procedural fallback palette).
 * The passed `color` stays the orange surround, so the bolt reads as id's
 * yellow-white core with an orange halo under every palette.
 */
export const TRACER_CORE_COLOR = 215;
/** Screen-step cap: a beam never walks more pixels than this. */
export const TRACER_MAX_STEPS = 2048;
/** Renderer-owned tracer pool size (spawnTracer ring). */
export const TRACER_POOL_SIZE = 64;

/**
 * Projected beam parameters shared by the splat draws and the span
 * emitter (TASK item 2): view-space transform, near-plane clip, screen
 * endpoints, 1/z endpoints, DDA step count, dominant axis and palette
 * indices. `projectTracerBeam` fills the module scratch and returns it
 * (null when fully behind the near plane); the stepping loops stay in
 * each caller so both pixel orders stay identical by construction.
 */
export interface TracerProjection {
  x0: number; y0: number; iz0: number;
  x1: number; y1: number; iz1: number;
  steps: number;
  horizontal: boolean;
  /** Palette indices (0..255): centre core + surrounding glow. */
  core: number;
  glow: number;
}

const tracerProjScratch: TracerProjection = {
  x0: 0, y0: 0, iz0: 0, x1: 0, y1: 0, iz1: 0,
  steps: 0, horizontal: true, core: 0, glow: 0,
};

/**
 * Project a beam segment to screen space with near-plane clipping.
 * Returns the shared scratch (null when fully behind the near plane).
 * Pure function of the inputs; zero allocation.
 */
export function projectTracerBeam(
  cam: Camera,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  color: number,
  core: number = TRACER_CORE_COLOR,
): TracerProjection | null {
  const pax = ax - cam.origin[0]!, pay = ay - cam.origin[1]!, paz = az - cam.origin[2]!;
  const pbx = bx - cam.origin[0]!, pby = by - cam.origin[1]!, pbz = bz - cam.origin[2]!;
  const adx = pax * cam.right[0]! + pay * cam.right[1]! + paz * cam.right[2]!;
  const ady = pax * cam.up[0]! + pay * cam.up[1]! + paz * cam.up[2]!;
  const adz = pax * cam.forward[0]! + pay * cam.forward[1]! + paz * cam.forward[2]!;
  const bdx = pbx * cam.right[0]! + pby * cam.right[1]! + pbz * cam.right[2]!;
  const bdy = pbx * cam.up[0]! + pby * cam.up[1]! + pbz * cam.up[2]!;
  const bdz = pbx * cam.forward[0]! + pby * cam.forward[1]! + pbz * cam.forward[2]!;
  const near = cam.near;
  let t0 = 0, t1 = 1;
  if (adz < near && bdz < near) return null;
  if (adz < near) t0 = (near - adz) / (bdz - adz);
  else if (bdz < near) t1 = (near - adz) / (bdz - adz);
  const s0x = adx + (bdx - adx) * t0;
  const s0y = ady + (bdy - ady) * t0;
  const s0z = adz + (bdz - adz) * t0;
  const s1x = adx + (bdx - adx) * t1;
  const s1y = ady + (bdy - ady) * t1;
  const s1z = adz + (bdz - adz) * t1;
  const p = tracerProjScratch;
  p.x0 = cam.xCenter + s0x * cam.focalX / s0z;
  p.y0 = cam.yCenter - s0y * cam.focalY / s0z;
  p.x1 = cam.xCenter + s1x * cam.focalX / s1z;
  p.y1 = cam.yCenter - s1y * cam.focalY / s1z;
  p.iz0 = 1 / s0z;
  p.iz1 = 1 / s1z;
  const dx = p.x1 - p.x0, dy = p.y1 - p.y0;
  p.steps = Math.min(TRACER_MAX_STEPS, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  p.horizontal = Math.abs(dx) >= Math.abs(dy);
  p.core = core & 255;
  p.glow = color & 255;
  return p;
}

/**
 * Emit a projected beam as 1x1 additive spans into `pool` (TASK item 2:
 * tracers ride the RGB worker kick exactly like other spans). One span
 * per splat in the exact splat order (core pass, then halo pass), so the
 * worker kick resolves same-pixel ties exactly like the serial DDA.
 * Each span samples the palette chain at (color, 0) and adds (Generic
 * additive == splatRGB). Returns the emitted span count (pool.count is
 * set; the caller draws or stages then resets it), or -1 when the beam
 * does not fit in maxSpans (caller draws inline instead; order is
 * preserved either way).
 */
export function emitTracerSpans(
  proj: TracerProjection,
  fbW: number,
  fbH: number,
  pool: SpanList,
  maxSpans: number,
): number {
  const spans = pool.spans;
  let cursor = 0;
  const put = (x: number, y: number, iz: number, color: number): boolean => {
    if (cursor >= maxSpans) return false;
    if (x < 0 || y < 0 || x >= fbW || y >= fbH) return true;
    while (spans.length <= cursor) spans.push(createSpan());
    const sq = spans[cursor++]!;
    sq.kind = SPAN_ADD;
    sq.y = y;
    sq.x0 = x;
    sq.x1 = x + 1;
    sq.iz = iz;
    sq.diz = 0;
    sq.uz = (color + 0.5) * iz;
    sq.duz = 0;
    sq.vz = 0.5 * iz;
    sq.dvz = 0;
    sq.light = 63;
    sq.dlight = 0;
    sq.lu = 0; sq.lv = -1; sq.dlu = 0; sq.ord = 0;
    sq.dudy = 0; sq.dvdy = 0;
    sq.turb = 0;
    return true;
  };
  const dx = proj.x1 - proj.x0, dy = proj.y1 - proj.y0;
  const steps = proj.steps;
  if (steps <= 0) {
    const x = Math.round(proj.x0), y = Math.round(proj.y0);
    const iz = (proj.iz0 + proj.iz1) / 2;
    if (!put(x, y, iz, proj.core)) { pool.count = 0; return -1; }
    if (proj.horizontal) {
      if (!put(x, y - 1, iz, proj.glow)) { pool.count = 0; return -1; }
      if (!put(x, y + 1, iz, proj.glow)) { pool.count = 0; return -1; }
    } else {
      if (!put(x - 1, y, iz, proj.glow)) { pool.count = 0; return -1; }
      if (!put(x + 1, y, iz, proj.glow)) { pool.count = 0; return -1; }
    }
    pool.count = cursor;
    return cursor;
  }
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!put(Math.round(proj.x0 + dx * t), Math.round(proj.y0 + dy * t),
      proj.iz0 + (proj.iz1 - proj.iz0) * t, proj.core)) { pool.count = 0; return -1; }
  }
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(proj.x0 + dx * t), y = Math.round(proj.y0 + dy * t);
    const iz = proj.iz0 + (proj.iz1 - proj.iz0) * t;
    if (proj.horizontal) {
      if (!put(x, y - 1, iz, proj.glow)) { pool.count = 0; return -1; }
      if (!put(x, y + 1, iz, proj.glow)) { pool.count = 0; return -1; }
    } else {
      if (!put(x - 1, y, iz, proj.glow)) { pool.count = 0; return -1; }
      if (!put(x + 1, y, iz, proj.glow)) { pool.count = 0; return -1; }
    }
  }
  pool.count = cursor;
  return cursor;
}

/**
 * Draw a beam from a to b. Returns drawn pixel count. Writes nothing when
 * the segment is fully behind the near plane; occluded pixels fail the
 * depth test individually (the beam disappears behind walls correctly).
 *
 * Two passes (id's yellow-orange bolt read): a 1px near-white `core` line
 * first, then a 3-wide `color` halo (±1 perpendicular, centre pixels
 * untouched so no depth re-test conflict). Both passes are depth-tested.
 */
export function drawTracerBeam(
  idx: Uint8Array,
  zb: Float32Array,
  fbW: number,
  fbH: number,
  cam: Camera,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  color: number,
  core: number = TRACER_CORE_COLOR,
): number {
  // To view space.
  const pax = ax - cam.origin[0]!, pay = ay - cam.origin[1]!, paz = az - cam.origin[2]!;
  const pbx = bx - cam.origin[0]!, pby = by - cam.origin[1]!, pbz = bz - cam.origin[2]!;
  const adx = pax * cam.right[0]! + pay * cam.right[1]! + paz * cam.right[2]!;
  const ady = pax * cam.up[0]! + pay * cam.up[1]! + paz * cam.up[2]!;
  const adz = pax * cam.forward[0]! + pay * cam.forward[1]! + paz * cam.forward[2]!;
  const bdx = pbx * cam.right[0]! + pby * cam.right[1]! + pbz * cam.right[2]!;
  const bdy = pbx * cam.up[0]! + pby * cam.up[1]! + pbz * cam.up[2]!;
  const bdz = pbx * cam.forward[0]! + pby * cam.forward[1]! + pbz * cam.forward[2]!;
  const near = cam.near;
  // Clip the segment to the near plane (depths along forward).
  let t0 = 0, t1 = 1;
  if (adz < near && bdz < near) return 0;
  if (adz < near) t0 = (near - adz) / (bdz - adz);
  else if (bdz < near) t1 = (near - adz) / (bdz - adz);
  // Interpolated view-space endpoints.
  const s0x = adx + (bdx - adx) * t0;
  const s0y = ady + (bdy - ady) * t0;
  const s0z = adz + (bdz - adz) * t0;
  const s1x = adx + (bdx - adx) * t1;
  const s1y = ady + (bdy - ady) * t1;
  const s1z = adz + (bdz - adz) * t1;
  const x0 = cam.xCenter + s0x * cam.focalX / s0z;
  const y0 = cam.yCenter - s0y * cam.focalY / s0z;
  const x1 = cam.xCenter + s1x * cam.focalX / s1z;
  const y1 = cam.yCenter - s1y * cam.focalY / s1z;
  const iz0 = 1 / s0z, iz1 = 1 / s1z;
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.min(TRACER_MAX_STEPS, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  const glow = color & 255;
  const centre = core & 255;
  // Halo runs perpendicular to the beam's dominant screen axis so the
  // bolt is 3px wide (visible at 320x240); core stays 1px.
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  if (steps <= 0) {
    // Sub-pixel beam: depth-tested centre + halo neighbours.
    const x = Math.round(x0), y = Math.round(y0);
    const iz = (iz0 + iz1) / 2;
    let drawn = splat(idx, zb, fbW, fbH, x, y, iz, centre);
    if (horizontal) {
      drawn += splat(idx, zb, fbW, fbH, x, y - 1, iz, glow);
      drawn += splat(idx, zb, fbW, fbH, x, y + 1, iz, glow);
    } else {
      drawn += splat(idx, zb, fbW, fbH, x - 1, y, iz, glow);
      drawn += splat(idx, zb, fbW, fbH, x + 1, y, iz, glow);
    }
    return drawn;
  }
  let drawn = 0;
  // Core pass first; halo pixels are disjoint (offset perpendicular), so
  // the second pass needs no depth re-test workaround.
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    drawn += splat(idx, zb, fbW, fbH,
      Math.round(x0 + dx * t), Math.round(y0 + dy * t), iz0 + (iz1 - iz0) * t, centre);
  }
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(x0 + dx * t), y = Math.round(y0 + dy * t);
    const iz = iz0 + (iz1 - iz0) * t;
    if (horizontal) {
      drawn += splat(idx, zb, fbW, fbH, x, y - 1, iz, glow);
      drawn += splat(idx, zb, fbW, fbH, x, y + 1, iz, glow);
    } else {
      drawn += splat(idx, zb, fbW, fbH, x - 1, y, iz, glow);
      drawn += splat(idx, zb, fbW, fbH, x + 1, y, iz, glow);
    }
  }
  return drawn;
}

/** Single depth-tested index write. Returns 1 when drawn, else 0. */
function splat(
  idx: Uint8Array, zb: Float32Array, fbW: number, fbH: number,
  x: number, y: number, iz: number, c: number,
): number {
  if (x < 0 || y < 0 || x >= fbW || y >= fbH) return 0;
  const o = y * fbW + x;
  if (iz > zb[o]!) {
    zb[o] = iz;
    idx[o] = c;
    return 1;
  }
  return 0;
}

/** Single window-Z-tested additive RGB565 write (beam glow over the RGB plane).
 * The destination expands from the STORED 565 quantum, adds in 8-bit, and
 * re-quantises (transparent effects blend against the quantized destination).
 * LESS wins, ties keep stored, clear 0xFFFF = far. */
function splatRGB(
  rgb565: Uint16Array, cover: Uint8Array, rgbDepth: Uint16Array,
  fbW: number, fbH: number,
  x: number, y: number, iz: number, r: number, g: number, b: number,
  winA: number, winB: number, qn16: (d01: number) => number,
  zOff: boolean,
): number {
  if (x < 0 || y < 0 || x >= fbW || y >= fbH) return 0;
  const o = y * fbW + x;
  const dRaw = winA - winB * iz;
  const d01 = dRaw < 0 ? 0 : dRaw > 1 ? 1 : (dRaw === dRaw ? dRaw : 1);
  const qo = rgbDepth[o]!;
  let qn: number;
  let pass: boolean;
  if (zOff) {
    qn = Math.round(d01 * 65535) & 0xffff;
    pass = qo === 0xffff ? d01 < 1 : d01 < qo / 65535;
  } else {
    qn = qn16(d01);
    pass = qn < qo;
  }
  if (pass) {
    rgbDepth[o] = qn;
    const dst = rgb565[o]!;
    const dr5 = (dst >> 11) & 31, dg6 = (dst >> 5) & 63, db5 = dst & 31;
    const dr = (dr5 << 3) | (dr5 >> 2), dg = (dg6 << 2) | (dg6 >> 4), db = (db5 << 3) | (db5 >> 2);
    const ar = dr + r > 255 ? 255 : dr + r;
    const ag = dg + g > 255 ? 255 : dg + g;
    const ab = db + b > 255 ? 255 : db + b;
    rgb565[o] = packRGB565(ar, ag, ab);
    cover[o] = 1;
    return 1;
  }
  return 0;
}

/**
 * RGB (voodoo-policy) twin of drawTracerBeam: the same clipped 1/z DDA,
 * but palette indices expand through the palette and add onto the packed
 * RGB565 plane (the ref_gl "additive" bolt read) instead of writing an
 * index. Window-Z-tested (LESS wins, ties keep stored; clear 0xFFFF = far)
 * and depth-writing into the RGB-owned depth plane, so occlusion matches
 * the indexed path exactly. Writes only the RGB565 + depth planes.
 * `zbits` follows the vd_zbits policy (0 = full-precision float compare).
 */
export function drawTracerBeamRGB(
  rgb565: Uint16Array,
  cover: Uint8Array,
  rgbDepth: Uint16Array,
  fbW: number,
  fbH: number,
  cam: Camera,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  colorIdx: number,
  palette: Uint8Array,
  coreIdx: number = TRACER_CORE_COLOR,
  win?: RGBWindow | null,
  zbits = 16,
): number {
  const winN = win !== null && win !== undefined && win.near > 0 ? win.near : DEFAULT_RGB_NEAR;
  const winF = win !== null && win !== undefined && win.far > winN ? win.far : DEFAULT_RGB_FAR;
  const winA = winF / (winF - winN);
  const winB = (winF * winN) / (winF - winN);
  const zOff = !Number.isInteger(zbits) || zbits < 1 || zbits > 23;
  const qn16 = (d01: number): number => windowDepthQ16(d01, zbits);
  const proj = projectTracerBeam(cam, ax, ay, az, bx, by, bz, colorIdx, coreIdx);
  if (!proj) return 0;
  const x0 = proj.x0, y0 = proj.y0, iz0 = proj.iz0;
  const x1 = proj.x1, y1 = proj.y1, iz1 = proj.iz1;
  const dx = x1 - x0, dy = y1 - y0;
  const steps = proj.steps;
  const go = (colorIdx & 255) * 3;
  const gr = palette[go] ?? 0, gg = palette[go + 1] ?? 0, gb = palette[go + 2] ?? 0;
  const co = (coreIdx & 255) * 3;
  const cr = palette[co] ?? 0, cg = palette[co + 1] ?? 0, cb = palette[co + 2] ?? 0;
  const horizontal = proj.horizontal;
  if (steps <= 0) {
    const x = Math.round(x0), y = Math.round(y0);
    const iz = (iz0 + iz1) / 2;
    let drawn = splatRGB(rgb565, cover, rgbDepth, fbW, fbH, x, y, iz, cr, cg, cb, winA, winB, qn16, zOff);
    if (horizontal) {
      drawn += splatRGB(rgb565, cover, rgbDepth, fbW, fbH, x, y - 1, iz, gr, gg, gb, winA, winB, qn16, zOff);
      drawn += splatRGB(rgb565, cover, rgbDepth, fbW, fbH, x, y + 1, iz, gr, gg, gb, winA, winB, qn16, zOff);
    } else {
      drawn += splatRGB(rgb565, cover, rgbDepth, fbW, fbH, x - 1, y, iz, gr, gg, gb, winA, winB, qn16, zOff);
      drawn += splatRGB(rgb565, cover, rgbDepth, fbW, fbH, x + 1, y, iz, gr, gg, gb, winA, winB, qn16, zOff);
    }
    return drawn;
  }
  let drawn = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    drawn += splatRGB(rgb565, cover, rgbDepth, fbW, fbH,
      Math.round(x0 + dx * t), Math.round(y0 + dy * t), iz0 + (iz1 - iz0) * t, cr, cg, cb, winA, winB, qn16, zOff);
  }
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(x0 + dx * t), y = Math.round(y0 + dy * t);
    const iz = iz0 + (iz1 - iz0) * t;
    if (horizontal) {
      drawn += splatRGB(rgb565, cover, rgbDepth, fbW, fbH, x, y - 1, iz, gr, gg, gb, winA, winB, qn16, zOff);
      drawn += splatRGB(rgb565, cover, rgbDepth, fbW, fbH, x, y + 1, iz, gr, gg, gb, winA, winB, qn16, zOff);
    } else {
      drawn += splatRGB(rgb565, cover, rgbDepth, fbW, fbH, x - 1, y, iz, gr, gg, gb, winA, winB, qn16, zOff);
      drawn += splatRGB(rgb565, cover, rgbDepth, fbW, fbH, x + 1, y, iz, gr, gg, gb, winA, winB, qn16, zOff);
    }
  }
  return drawn;
}
