// @q2/sw-renderer particles — r_part.c equivalent: single-pixel particles.
// Depth-tested point writes; the caller projects (or passes screen space).

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
 * each, depth-tested and depth-writing into the RGB-owned depth plane
 * (matches the indexed path's occlusion, with full color depth instead of
 * the colormap grade). Writes only the RGB planes, so the software path
 * stays bit-identical. PORT-DIFF vs @q2/voodoo policy: point sprites have
 * no filtered footprint; expansion is the upload-time palette applied per
 * point (no voodoo import per the sw-renderer dep allowlist).
 */
export function drawParticlesRGB(
  color: Uint32Array,
  cover: Uint8Array,
  zb: Float32Array,
  fbW: number,
  fbH: number,
  parts: ScreenParticle[] | { list: ScreenParticle[]; count: number },
  start: number,
  end: number,
  palette: Uint8Array,
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
      const c = (p.color & 255) * 3;
      const r = palette[c] ?? 0, g = palette[c + 1] ?? 0, b = palette[c + 2] ?? 0;
      color[o] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      cover[o] = 1;
      drawn++;
    }
  }
  return drawn;
}
