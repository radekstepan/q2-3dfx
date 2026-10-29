// @q2/sw-renderer sprites — d_sprite.c equivalent: per-span clipped sprites.
// Billboards projected to screen quads, clipped to the viewport (and an
// optional scissor rect), rasterised with the shared perspective span path.

import type { Camera } from './camera.js';
import { SPAN_OPAQUE, createSpan, drawSpansRGB, drawSpansSoftware, type RGBMaterial, type RGBWindow, type SpanList, type Texture } from './spans.js';
import type { LightBlock } from './spans.js';

export interface SpriteDef {
  origin: Float32Array;
  /** world-space width/height */
  width: number; height: number;
  texId: number;
  grade: number;
}

export interface Scissor {
  x0: number; y0: number; x1: number; y1: number;
}

/**
 * Project a camera-facing billboard into renderer-owned span scratch and
 * return the emitted span count (pool.count is set; the caller draws then
 * resets it). Shared by the indexed path (drawSprite) and the RGB path
 * (drawSpriteRGB) so both rasterise the same quad through the same
 * perspective span math. Returns 0 when fully off-screen/behind near.
 */
/**
 * Emit one camera-facing billboard's spans into `pool` (ascending y, one
 * span per row). Exported for the foreground worker stager (frame.ts),
 * which stages the emitted spans into the RGB kick instead of drawing
 * them inline — identical spans, identical material, identical order.
 */
export function emitSpriteSpans(
  sprite: SpriteDef,
  textures: Texture[],
  cam: Camera,
  fbW: number,
  fbH: number,
  pool: SpanList,
  maxSpans: number,
  scissor?: Scissor,
): number {
  const tex = textures[sprite.texId % textures.length]!;
  const ox = sprite.origin[0]! - cam.origin[0]!;
  const oy = sprite.origin[1]! - cam.origin[1]!;
  const oz = sprite.origin[2]! - cam.origin[2]!;
  const cz = ox * cam.forward[0]! + oy * cam.forward[1]! + oz * cam.forward[2]!;
  if (cz < cam.near) return 0;
  const cx = ox * cam.right[0]! + oy * cam.right[1]! + oz * cam.right[2]!;
  const cyv = ox * cam.up[0]! + oy * cam.up[1]! + oz * cam.up[2]!;
  const hw = sprite.width / 2, hh = sprite.height / 2;
  const iz = 1 / cz;
  // view-space corners of the billboard quad
  const corners = spriteCorners;
  corners[0] = cx - hw; corners[1] = cyv + hh; corners[2] = cz;
  corners[3] = cx + hw; corners[4] = cyv + hh; corners[5] = cz;
  corners[6] = cx + hw; corners[7] = cyv - hh; corners[8] = cz;
  corners[9] = cx - hw; corners[10] = cyv - hh; corners[11] = cz;
  const w = tex.width, h = tex.height;
  const uvs = spriteUVs;
  uvs[0] = 0; uvs[1] = 0; uvs[2] = w; uvs[3] = 0;
  uvs[4] = w; uvs[5] = h; uvs[6] = 0; uvs[7] = h;
  // project
  const px = spriteProj;
  for (let i = 0; i < 4; i++) {
    const vx = corners[i * 3]!, vy = corners[i * 3 + 1]!, vz = corners[i * 3 + 2]!;
    const q = 1 / vz;
    px[i * 5] = cam.xCenter + vx * cam.focalX * q;
    px[i * 5 + 1] = cam.yCenter - vy * cam.focalY * q;
    px[i * 5 + 2] = q;
    px[i * 5 + 3] = uvs[i * 2]! * q;
    px[i * 5 + 4] = uvs[i * 2 + 1]! * q;
  }
  const sx0 = scissor ? scissor.x0 : 0;
  const sy0 = scissor ? scissor.y0 : 0;
  const sx1 = scissor ? scissor.x1 : fbW;
  const sy1 = scissor ? scissor.y1 : fbH;
  const spans = pool.spans;
  let cursor = 0;
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < 4; i++) {
    if (px[i * 5]! < minX) minX = px[i * 5]!;
    if (px[i * 5]! > maxX) maxX = px[i * 5]!;
    if (px[i * 5 + 1]! < minY) minY = px[i * 5 + 1]!;
    if (px[i * 5 + 1]! > maxY) maxY = px[i * 5 + 1]!;
  }
  const yA = Math.max(sy0, Math.ceil(minY - 0.5));
  const yB = Math.min(Math.min(sy1, fbH) - 1, Math.floor(maxY - 0.5));
  const xA = Math.max(sx0, Math.ceil(minX - 0.5));
  const xB = Math.min(Math.min(sx1, fbW) - 1, Math.floor(maxX - 0.5));
  if (yB < yA || xB < xA) return 0;
  // The billboard is planar at constant depth: iz is uniform, u runs
  // 0..w across the row, v is constant per row. Clipping only moves x0.
  // Vertical footprint for the Voodoo LOD: u is constant down columns
  // (du/dy = 0), v spans 0..h over (maxY - minY) rows.
  const q = iz;
  const fullW = Math.max(1, maxX - minX);
  const dvdyS = h / Math.max(1e-6, maxY - minY);
  for (let y = yA; y <= yB; y++) {
    if (cursor >= maxSpans) break;
    while (spans.length <= cursor) spans.push(createSpan());
    const yc = y + 0.5;
    const t = (yc - minY) / (Math.max(1e-6, maxY - minY));
    const vv = t * h * q;
    const s = spans[cursor++]!;
    s.kind = SPAN_OPAQUE;
    s.y = y;
    s.x0 = xA;
    s.x1 = xB + 1;
    s.iz = q;
    s.diz = 0;
    // uz at xA: fraction across the quad times w, scaled by q
    s.uz = ((xA + 0.5 - minX) / fullW) * w * q;
    s.duz = (w * q) / fullW;
    s.vz = vv;
    s.dvz = 0;
    s.light = sprite.grade;
    s.dlight = 0;
    s.lu = 0; s.lv = -1; s.dlu = 0; s.ord = 0;
    s.dudy = 0; s.dvdy = dvdyS;
    s.turb = 0;
  }
  pool.count = cursor;
  return cursor;
}

/**
 * Rasterise a camera-facing sprite. Returns pixel count. Writes nothing
 * outside [scissor ∩ framebuffer]. `pool`/`list` are renderer-owned scratch.
 */
export function drawSprite(
  idx: Uint8Array,
  zb: Float32Array,
  fbW: number,
  fbH: number,
  sprite: SpriteDef,
  textures: Texture[],
  light: LightBlock,
  colormap: Uint8Array,
  cam: Camera,
  pool: SpanList,
  maxSpans: number,
  scissor?: Scissor,
): number {
  const tex = textures[sprite.texId % textures.length]!;
  const n = emitSpriteSpans(sprite, textures, cam, fbW, fbH, pool, maxSpans, scissor);
  if (n === 0) return 0;
  const r = drawSpansSoftware(idx, zb, fbW, fbH, pool, tex, light, colormap);
  pool.count = 0;
  return r.pixels;
}

/**
 * RGB (voodoo-policy) twin of drawSprite: the same emitted billboard spans
 * go through drawSpansRGB with the caller's material (unlit sprite texture,
 * transparent-255 holes skipped, per-material blend/depthWrite). Writes
 * only the RGB565 + window-Z planes + coverage, so the indexed path stays
 * bit-identical. PORT-DIFF vs @q2/voodoo sampler.ts: same tap math via
 * drawSpansRGB; the billboard emission above is reused verbatim.
 */
export function drawSpriteRGB(
  rgb565: Uint16Array,
  cover: Uint8Array,
  rgbDepth: Uint16Array,
  fbW: number,
  fbH: number,
  sprite: SpriteDef,
  textures: Texture[],
  mat: RGBMaterial,
  cam: Camera,
  pool: SpanList,
  maxSpans: number,
  scissor?: Scissor,
  win?: RGBWindow | null,
): number {
  const n = emitSpriteSpans(sprite, textures, cam, fbW, fbH, pool, maxSpans, scissor);
  if (n === 0) return 0;
  const r = drawSpansRGB(rgb565, cover, rgbDepth, fbW, fbH, pool, mat, win ?? null);
  pool.count = 0;
  return r.pixels;
}

const spriteCorners = new Float32Array(12);
const spriteUVs = new Float32Array(8);
const spriteProj = new Float32Array(20);
