// @q2/sw-renderer particles — r_part.c equivalent: single-pixel particles.
// Depth-tested point writes; the caller projects (or passes screen space).

import {
  packRGB565, windowDepthQ16,
  SPAN_OPAQUE, createSpan,
  DEFAULT_RGB_FAR, DEFAULT_RGB_NEAR, type RGBWindow, type SpanList,
} from './spans.js';

export interface ScreenParticle {
  x: number; y: number;
  /** 1/z depth */
  iz: number;
  color: number;
}

/**
 * Draw screen-space particles. One pixel each, `iz > zb` wins.
 * Clipped to the framebuffer. Returns drawn count.
 */
export function drawParticles(
  idx: Uint8Array,
  zb: Float32Array,
  fbW: number,
  fbH: number,
  parts: ScreenParticle[] | { list: ScreenParticle[]; count: number },
  start: number,
  end: number,
): number {
  const list = Array.isArray(parts) ? parts : parts.list;
  let drawn = 0;
  const s = Math.max(0, start);
  const e = Math.min(end, list.length);
  for (let i = s; i < e; i++) {
    const p = list[i]!;
    const x = p.x | 0, y = p.y | 0;
    if (x < 0 || y < 0 || x >= fbW || y >= fbH) continue;
    const o = y * fbW + x;
    if (p.iz > zb[o]) {
      zb[o] = p.iz;
      idx[o] = p.color;
      drawn++;
    }
  }
  return drawn;
}

/** Project world-space points to screen particles (writes into `out`). */
export function projectParticles(
  origins: Float32Array,
  colors: Uint8Array,
  n: number,
  origin: Float32Array,
  forward: Float32Array,
  right: Float32Array,
  up: Float32Array,
  xCenter: number,
  yCenter: number,
  focalX: number,
  focalY: number,
  near: number,
  out: ScreenParticle[],
): number {
  let count = 0;
  for (let i = 0; i < n; i++) {
    const px = origins[i * 3]! - origin[0]!;
    const py = origins[i * 3 + 1]! - origin[1]!;
    const pz = origins[i * 3 + 2]! - origin[2]!;
    const dz = px * forward[0]! + py * forward[1]! + pz * forward[2]!;
    if (dz < near) continue;
    const dx = px * right[0]! + py * right[1]! + pz * right[2]!;
    const dy = px * up[0]! + py * up[1]! + pz * up[2]!;
    const iz = 1 / dz;
    while (out.length <= count) {
      out.push({ x: 0, y: 0, iz: 0, color: 0 });
    }
    const p = out[count++]!;
    p.x = Math.round(xCenter + dx * focalX * iz);
    p.y = Math.round(yCenter - dy * focalY * iz);
    p.iz = iz;
    p.color = colors[i]!;
  }
  return count;
}

/**
 * RGB (voodoo-policy) twin of drawParticles: one palette-expanded pixel
 * each, window-Z depth-tested (LESS wins, ties keep stored; clear 0xFFFF
 * = far) and depth-writing into the RGB-owned depth plane. The color
 * quantises 8:8:8 -> 565 on write (the 565 plane is the authority, like
 * every other RGB path). Writes only the RGB565 + depth planes, so the
 * software path stays bit-identical. PORT-DIFF vs @q2/voodoo policy: point
 * sprites have no filtered footprint; expansion is the upload-time palette
 * applied per point (no voodoo import per the sw-renderer dep allowlist).
 * `zbits` follows the vd_zbits policy (0 = full-precision float compare).
 */
export function drawParticlesRGB(
  rgb565: Uint16Array,
  cover: Uint8Array,
  rgbDepth: Uint16Array,
  fbW: number,
  fbH: number,
  parts: ScreenParticle[] | { list: ScreenParticle[]; count: number },
  start: number,
  end: number,
  palette: Uint8Array,
  win?: RGBWindow | null,
  zbits = 16,
): number {
  const list = Array.isArray(parts) ? parts : parts.list;
  const winN = win !== null && win !== undefined && win.near > 0 ? win.near : DEFAULT_RGB_NEAR;
  const winF = win !== null && win !== undefined && win.far > winN ? win.far : DEFAULT_RGB_FAR;
  const winA = winF / (winF - winN);
  const winB = (winF * winN) / (winF - winN);
  const zOff = !Number.isInteger(zbits) || zbits < 1 || zbits > 23;
  let drawn = 0;
  const s = Math.max(0, start);
  const e = Math.min(end, list.length);
  for (let i = s; i < e; i++) {
    const p = list[i]!;
    const x = p.x | 0, y = p.y | 0;
    if (x < 0 || y < 0 || x >= fbW || y >= fbH) continue;
    const o = y * fbW + x;
    const dRaw = winA - winB * p.iz;
    const d01 = dRaw < 0 ? 0 : dRaw > 1 ? 1 : (dRaw === dRaw ? dRaw : 1);
    const qo = rgbDepth[o]!;
    let qn: number;
    let pass: boolean;
    if (zOff) {
      qn = Math.round(d01 * 65535) & 0xffff;
      pass = qo === 0xffff ? d01 < 1 : d01 < qo / 65535;
    } else {
      qn = windowDepthQ16(d01, zbits);
      pass = qn < qo;
    }
    if (pass) {
      rgbDepth[o] = qn;
      const c = (p.color & 255) * 3;
      const r = palette[c] ?? 0, g = palette[c + 1] ?? 0, b = palette[c + 2] ?? 0;
      rgb565[o] = packRGB565(r, g, b);
      cover[o] = 1;
      drawn++;
    }
  }
  return drawn;
}

/**
 * Emit screen particles as 1x1 opaque spans into `pool` (TASK item 2:
 * particles ride the RGB worker kick exactly like other spans). Each span
 * samples the palette chain at (color, 0) with point sampling — the same
 * quantum drawParticlesRGB writes — and depth-tests/writes identically.
 * Emission order matches drawParticlesRGB's pixel order, so same-pixel
 * ties resolve the same way. Returns the emitted span count (pool.count
 * is set; the caller draws or stages then resets it), or -1 when the
 * batch does not fit in maxSpans (caller draws inline instead; order is
 * preserved either way). Unlit, opaque, depth-writing; UVs ride the span
 * (u = color + 0.5, v = 0.5).
 */
export function emitParticleSpans(
  parts: ScreenParticle[] | { list: ScreenParticle[]; count: number },
  start: number,
  end: number,
  fbW: number,
  fbH: number,
  pool: SpanList,
  maxSpans: number,
): number {
  const list = Array.isArray(parts) ? parts : parts.list;
  const s = Math.max(0, start);
  const e = Math.min(end, list.length);
  const spans = pool.spans;
  let cursor = 0;
  for (let i = s; i < e; i++) {
    if (cursor >= maxSpans) { pool.count = 0; return -1; }
    const p = list[i]!;
    const x = p.x | 0, y = p.y | 0;
    if (x < 0 || y < 0 || x >= fbW || y >= fbH) continue;
    while (spans.length <= cursor) spans.push(createSpan());
    const q = p.iz;
    const col = p.color & 255;
    const sq = spans[cursor++]!;
    sq.kind = SPAN_OPAQUE;
    sq.y = y;
    sq.x0 = x;
    sq.x1 = x + 1;
    sq.iz = q;
    sq.diz = 0;
    sq.uz = (col + 0.5) * q;
    sq.duz = 0;
    sq.vz = 0.5 * q;
    sq.dvz = 0;
    sq.light = 63;
    sq.dlight = 0;
    sq.lu = 0; sq.lv = -1; sq.dlu = 0; sq.ord = 0;
    sq.dudy = 0; sq.dvdy = 0;
    sq.turb = 0;
  }
  pool.count = cursor;
  return cursor;
}
