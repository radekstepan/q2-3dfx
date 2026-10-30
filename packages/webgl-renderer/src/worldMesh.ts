// @q2/webgl-renderer worldMesh — pure CPU-side world batch builders (GPU-PROOF-3).
//
// GL-free, DOM-free: turns (MiniWorld, GpuSurfaceRef[]) into upload-ready
// batches. The renderer owns the GL objects; everything here is plain arrays.
//
// Triangulation: Quake faces are convex, so an n-gon becomes a fan
// (0, i, i+1). Winding is left as-authored and GL face culling stays OFF:
// visibility is exactly selectGpuScene's CPU backface rule, depth-tested.
// (A wrong cull assumption would delete real walls; overdraw is the
// accepted PROOF-3 cost.)
//
// Lightmap atlas: one RGB UNSIGNED_BYTE atlas per static generation packing
// every referenced surface lightmap block (shelf pack, width 1024, height
// grows; >2048 records a warning and skips the overflow, never crashes).
// Style scaling (combineStyleScales, the CPU rule: sum of lightStyles over
// the surface's 4 style slots, 255 = unused) is BAKED into the atlas texels
// using the frame's lightStyles; when the style signature changes the atlas
// is re-baked (re-uploaded). Filtering is LINEAR — the documented
// approximation of the CPU's per-luxel light gradient (PROOF-4 owns the
// exact sampling/mip policy).
//
// Diffuse textures: WAL palette indices expanded to RGB via the palette
// (setPalette, like Refresh). World WALs are <=256 by construction; an
// oversized texture is SKIPPED with a recorded warning, never a crash.
// (Skin textures registered for sprites/alias may exceed 256 — e.g. the
// POT-expanded 288-wide soldier skin — and are uploaded as-is with a
// warning: the Voodoo 256 cap is appearance policy, enforced in PROOF-4.)

import type { GpuSurfaceRef } from '@q2/renderer-api';
import {
  combineStyleScales,
  type MiniSurf,
  type MiniWorld,
} from '@q2/sw-renderer';

/** Opaque-blend alpha for SURF_TRANS33 (85/256, mirrors the CPU alphaQ). */
export const TRANS33_ALPHA = 85 / 256;
/** Opaque-blend alpha for SURF_TRANS66 (169/256, mirrors the CPU alphaQ). */
export const TRANS66_ALPHA = 169 / 256;

/** One upload-ready world batch (concat of 1+ surfaces, one texture). */
export interface WorldBatch {
  kind: 'opaque' | 'transparent';
  texId: number;
  positions: Float32Array;
  uvs: Float32Array;
  lightUVs: Float32Array;
  alphas: Float32Array;
  indices: Uint32Array;
}

/** One sky batch (positions only; flat-shaded by the renderer). */
export interface SkyBatch {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Packed lightmap atlas plus per-surface rects (in atlas texels). */
export interface LightAtlas {
  width: number;
  height: number;
  pixels: Uint8Array;
  rectOf: Map<number, { x: number; y: number; w: number; h: number }>;
}

/** Max atlas dimension before overflow skips (recorded, never crash). */
export const ATLAS_MAX_DIM = 2048;
/** Atlas shelf width. */
export const ATLAS_WIDTH = 1024;

interface MutableBatch {
  positions: number[];
  uvs: number[];
  lightUVs: number[];
  alphas: number[];
  indices: number[];
  kind: 'opaque' | 'transparent';
  texId: number;
}

type AtlasRect = { x: number; y: number; w: number; h: number };

function pushSurfaceTris(
  b: MutableBatch,
  s: MiniSurf,
  alpha: number,
  rect: AtlasRect | null,
  atlasW: number,
  atlasH: number,
  texW: number,
  texH: number,
): void {
  const base = b.positions.length / 3;
  for (let i = 0; i < s.n; i++) {
    b.positions.push(s.verts[i * 3]!, s.verts[i * 3 + 1]!, s.verts[i * 3 + 2]!);
    b.uvs.push(s.uvs[i * 2]! / texW, s.uvs[i * 2 + 1]! / texH);
    if (rect) {
      b.lightUVs.push((rect.x + s.lux[i * 2]!) / atlasW, (rect.y + s.lux[i * 2 + 1]!) / atlasH);
    } else {
      b.lightUVs.push(0, 0);
    }
    b.alphas.push(alpha);
  }
  for (let i = 1; i < s.n - 1; i++) {
    b.indices.push(base, base + i, base + i + 1);
  }
}

/**
 * Build ordered world batches from (world, refs, atlas): opaque merged per
 * texId (order-free), then transparent in scene order with consecutive
 * same-texId runs merged (draw order preserved). Sky surfaces are collected
 * separately (flat fill, no texture). Turbulent surfaces ride the opaque
 * buckets with identical state — the water warp is deferred (PROOF-4/EXPAND
 * inventory), documented here, not silently dropped.
 */
export function buildTexturedWorldBatches(
  world: MiniWorld,
  refs: GpuSurfaceRef[],
  atlas: LightAtlas,
): { opaque: WorldBatch[]; transparent: WorldBatch[]; sky: SkyBatch[] } {
  const scratch = new Map<number, MutableBatch>();
  const order: MutableBatch[] = [];
  const skyPos: number[] = [];
  const skyIdx: number[] = [];
  const getBucket = (kind: 'opaque' | 'transparent', texId: number): MutableBatch => {
    const key = (kind === 'opaque' ? 0 : 1 << 30) + texId;
    const hit = scratch.get(key);
    if (hit && kind === 'opaque') return hit;
    if (hit && kind === 'transparent' && order[order.length - 1] === hit) return hit;
    // New run: opaque buckets merge globally (one per texId); transparent
    // runs merge only with the immediately preceding tail run.
    const tail = order.length > 0 ? order[order.length - 1]! : null;
    if (kind === 'transparent' && tail && tail.kind === 'transparent' && tail.texId === texId) {
      scratch.set(key, tail);
      return tail;
    }
    const b: MutableBatch = { positions: [], uvs: [], lightUVs: [], alphas: [], indices: [], kind, texId };
    scratch.set(key, b);
    order.push(b);
    return b;
  };

  for (const ref of refs) {
    if (ref.transformIndex !== 0) continue; // entities are dynamic, not world batches
    const s = world.surfaces[ref.surfaceId];
    if (!s || s.n < 3) continue;
    if (ref.material === 'sky') {
      const base = skyPos.length / 3;
      for (let i = 0; i < s.n * 3; i++) skyPos.push(s.verts[i]!);
      for (let i = 1; i < s.n - 1; i++) skyIdx.push(base, base + i, base + i + 1);
      continue;
    }
    const tex = world.textures[s.texId];
    const texW = tex?.width ?? 1;
    const texH = tex?.height ?? 1;
    const alpha = ref.transparent ? (s.translucent === 2 ? TRANS66_ALPHA : TRANS33_ALPHA) : 1;
    const bucket = getBucket(ref.transparent ? 'transparent' : 'opaque', s.texId);
    pushSurfaceTris(bucket, s, alpha, atlas.rectOf.get(s.id) ?? null, atlas.width, atlas.height, texW, texH);
  }

  const opaque: WorldBatch[] = [];
  const trans: WorldBatch[] = [];
  for (const b of order) {
    if (b.positions.length === 0) continue;
    const out: WorldBatch = {
      kind: b.kind,
      texId: b.texId,
      positions: new Float32Array(b.positions),
      uvs: new Float32Array(b.uvs),
      lightUVs: new Float32Array(b.lightUVs),
      alphas: new Float32Array(b.alphas),
      indices: new Uint32Array(b.indices),
    };
    (b.kind === 'opaque' ? opaque : trans).push(out);
  }
  const sky: SkyBatch[] = skyPos.length > 0
    ? [{ positions: new Float32Array(skyPos), indices: new Uint32Array(skyIdx) }]
    : [];
  return { opaque, transparent: trans, sky };
}

/**
 * Pack every referenced surface lightmap block into one RGB atlas, baking
 * the CPU style scale (combineStyleScales over the frame's lightStyles).
 * Returns the atlas plus the list of surface ids that did not fit (empty in
 * practice; skipped with a recorded warning, never a crash).
 */
export function packLightAtlas(
  world: MiniWorld,
  surfaceIds: number[],
  lightStyles: Float32Array,
): { atlas: LightAtlas; skipped: number[] } {
  type Item = { id: number; w: number; h: number; src: Uint8Array; scale: number };
  const items: Item[] = [];
  for (const id of surfaceIds) {
    const lm = world.lightmaps[id];
    if (!lm || lm.luxW < 1 || lm.luxH < 1) continue;
    const need = lm.luxW * lm.luxH * 3;
    const src = lm.samples.length >= need ? lm.samples.subarray(0, need) : new Uint8Array([128, 128, 128]);
    items.push({ id, w: lm.luxW, h: lm.luxH, src, scale: combineStyleScales(lm.styles, lightStyles) });
  }
  items.sort((a, b) => b.h - a.h || b.w - a.w);
  const rectOf = new Map<number, { x: number; y: number; w: number; h: number }>();
  const skipped: number[] = [];
  // Shelf pack: rows of ATLAS_WIDTH; height grows on demand.
  let shelfY = 0;
  let shelfH = 0;
  let shelfX = 0;
  const placed: Array<Item & { x: number; y: number }> = [];
  for (const it of items) {
    if (it.w > ATLAS_WIDTH || shelfY + Math.max(shelfH, it.h) > ATLAS_MAX_DIM) {
      skipped.push(it.id);
      continue;
    }
    if (shelfX + it.w > ATLAS_WIDTH) {
      shelfY += shelfH;
      shelfX = 0;
      shelfH = 0;
    }
    if (shelfY + it.h > ATLAS_MAX_DIM) {
      skipped.push(it.id);
      continue;
    }
    placed.push({ ...it, x: shelfX, y: shelfY });
    rectOf.set(it.id, { x: shelfX, y: shelfY, w: it.w, h: it.h });
    shelfX += it.w;
    if (it.h > shelfH) shelfH = it.h;
  }
  const height = Math.max(1, shelfY + shelfH);
  const pixels = new Uint8Array(ATLAS_WIDTH * height * 3);
  for (const p of placed) {
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const si = (y * p.w + x) * 3;
        const di = ((p.y + y) * ATLAS_WIDTH + (p.x + x)) * 3;
        pixels[di] = clamp255(Math.round(p.src[si]! * p.scale));
        pixels[di + 1] = clamp255(Math.round(p.src[si + 1]! * p.scale));
        pixels[di + 2] = clamp255(Math.round(p.src[si + 2]! * p.scale));
      }
    }
  }
  return { atlas: { width: ATLAS_WIDTH, height, pixels, rectOf }, skipped };
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Expand palette-index texels to RGB via the palette (setPalette, like
 * Refresh). Returns null when the texel count mismatches (caller
 * warns + skips, never crashes).
 */
export function expandPaletteTexture(
  texels: Uint8Array,
  width: number,
  height: number,
  palette: Uint8Array,
): Uint8Array | null {
  if (texels.length !== width * height) return null;
  const out = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const p = (texels[i]! & 255) * 3;
    out[i * 3] = palette[p] ?? 0;
    out[i * 3 + 1] = palette[p + 1] ?? 0;
    out[i * 3 + 2] = palette[p + 2] ?? 0;
  }
  return out;
}

/**
 * Change-detection signature over the 256 light styles (atlas re-bake
 * trigger). Pure FNV-1a over quantised values; deterministic.
 */
export function styleSignature(lightStyles: Float32Array): number {
  let h = 2166136261;
  const n = Math.min(256, lightStyles.length);
  for (let i = 0; i < n; i++) {
    h = Math.imul(h ^ (Math.round(lightStyles[i]! * 1024) & 0xffff), 16777619);
  }
  return h >>> 0;
}

/**
 * Mirror of SoftwareRenderer.pickSkyIndex: the bluest bright palette entry.
 * Kept in sync by value (same formula, same inputs).
 */
export function pickSkyPaletteIndex(palette: Uint8Array): number {
  let best = 0;
  let bs = -Infinity;
  for (let i = 0; i < 256; i++) {
    const r = palette[i * 3] ?? 0;
    const g = palette[i * 3 + 1] ?? 0;
    const b = palette[i * 3 + 2] ?? 0;
    const s = 2 * b - r - g + (r + g + b) / 32;
    if (s > bs) { bs = s; best = i; }
  }
  return best;
}
