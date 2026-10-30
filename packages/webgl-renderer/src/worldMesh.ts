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
// grows; >2048 records a warning and skips the overflow into a deliberate
// uniform unlit tile, never a crash and never a silent atlas-origin read).
// Tiles carry 1-texel edge-duplicated gutters and lightUVs address luxel
// centres (CPU bilinear-centre rule); short/unlit blocks expand per-luxel.
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

import type { GpuMaterialKind, GpuSurfaceRef } from '@q2/renderer-api';
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
  /** surface id -> CONTENT rect (gutter-excluded origin, luxel dims). */
  rectOf: Map<number, { x: number; y: number; w: number; h: number }>;
  /**
   * Centre of the reserved uniform unlit tile (neutral mid-gray, no style
   * scaling — a deliberate uniform material, never atlas origin). Surfaces
   * with no lightmap and overflow-skipped surfaces sample here.
   */
  unlitUV: [number, number];
}

/** Neutral unlit luxel value (matches the bspWorld unlit sentinel). */
export const UNLIT_LUXEL = 128;

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
  unlitUV: readonly [number, number],
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
      // Luxel-centre placement (matches the CPU sampleLightBlock rule where
      // integer luxel coords address luxel CENTRES): the GPU LINEAR tap at
      // (rect + lux + 0.5) lands on the luxel centre instead of straddling
      // the texel edge into the neighbour tile.
      b.lightUVs.push((rect.x + 0.5 + s.lux[i * 2]!) / atlasW, (rect.y + 0.5 + s.lux[i * 2 + 1]!) / atlasH);
    } else {
      // Deliberate uniform unlit material (never atlas origin).
      b.lightUVs.push(unlitUV[0], unlitUV[1]);
    }
    b.alphas.push(alpha);
  }
  for (let i = 1; i < s.n - 1; i++) {
    b.indices.push(base, base + i, base + i + 1);
  }
}

/** One uploaded world surface: index range into the shared big buffers. */
export interface FullWorldSurface {
  /** First index in the shared index buffer (in indices, not bytes). */
  indexStart: number;
  /** Index count for this surface. */
  indexCount: number;
  /** First vertex in the shared attribute buffers. */
  vertStart: number;
  /** Vertex count for this surface. */
  vertCount: number;
  /** WAL texture id (diffuse lookup at draw time). */
  texId: number;
  /** Material class (never 'sky': sky lives in FullSkyStore). */
  material: Exclude<GpuMaterialKind, 'sky'>;
  /** True for SURF_TRANS33/66 (blend pass, far->near). */
  transparent: boolean;
}

type GpuSurfaceKind = GpuMaterialKind;

/** Persistent full-map world store: one big buffer set, per-surface ranges. */
export interface FullWorldStore {
  positions: Float32Array;
  uvs: Float32Array;
  lightUVs: Float32Array;
  alphas: Float32Array;
  indices: Uint32Array;
  /** surfaceId -> uploaded range (every triangulable non-sky surface). */
  surfaces: Map<number, FullWorldSurface>;
}

/** Persistent sky store: positions + per-surface index ranges (flat fill). */
export interface FullSkyStore {
  positions: Float32Array;
  indices: Uint32Array;
  /** surfaceId -> index range into the sky buffers. */
  ranges: Map<number, { start: number; count: number; vertStart: number; vertCount: number }>;
}

function classifyForStore(s: MiniSurf): { material: GpuSurfaceKind; transparent: boolean } {
  if (s.sky) return { material: 'sky', transparent: false };
  if (s.turbulent) return { material: 'turbulent', transparent: false };
  const t = s.translucent ?? 0;
  if (t === 1 || t === 2) return { material: 'transparent', transparent: true };
  return { material: 'opaque', transparent: false };
}

/**
 * Pack the FULL world inventory (GPU-FOLLOW-2 storage side) into one shared
 * buffer set plus per-surface index ranges. Every triangulable surface
 * (n >= 3) is packed exactly once in surface-id order — no camera culling —
 * so per-frame draw selection is just a choice of ranges (no rebuild).
 * Per-vertex alpha bakes the SURF_TRANS33/66 rule; lightUVs come from the
 * handed atlas (luxel centres with gutter isolation; missing rects sample
 * the atlas unlit tile, the deliberate uniform fallback).
 */
export function buildFullWorldStore(
  world: MiniWorld,
  atlas: LightAtlas,
): { world: FullWorldStore; sky: FullSkyStore } {
  const pos: number[] = [];
  const uv: number[] = [];
  const luv: number[] = [];
  const alpha: number[] = [];
  const idx: number[] = [];
  const surfaces = new Map<number, FullWorldSurface>();
  const skyPos: number[] = [];
  const skyIdx: number[] = [];
  const skyRanges = new Map<number, { start: number; count: number; vertStart: number; vertCount: number }>();
  for (let si = 0; si < world.surfaces.length; si++) {
    const s = world.surfaces[si];
    if (!s || s.n < 3) continue;
    const cls = classifyForStore(s);
    if (cls.material === 'sky') {
      const vertStart = skyPos.length / 3;
      const start = skyIdx.length;
      for (let i = 0; i < s.n * 3; i++) skyPos.push(s.verts[i]!);
      for (let i = 1; i < s.n - 1; i++) skyIdx.push(vertStart + 0, vertStart + i, vertStart + i + 1);
      skyRanges.set(si, { start, count: skyIdx.length - start, vertStart, vertCount: s.n });
      continue;
    }
    const tex = world.textures[s.texId];
    const texW = tex?.width ?? 1;
    const texH = tex?.height ?? 1;
    const a = cls.transparent ? (s.translucent === 2 ? TRANS66_ALPHA : TRANS33_ALPHA) : 1;
    const rect = atlas.rectOf.get(s.id) ?? null;
    const vertStart = pos.length / 3;
    const start = idx.length;
    for (let i = 0; i < s.n; i++) {
      pos.push(s.verts[i * 3]!, s.verts[i * 3 + 1]!, s.verts[i * 3 + 2]!);
      uv.push(s.uvs[i * 2]! / texW, s.uvs[i * 2 + 1]! / texH);
      if (rect) {
        // Luxel-centre placement (see pushSurfaceTris): integer luxel
        // coords address luxel centres, matching the CPU bilinear rule.
        luv.push((rect.x + 0.5 + s.lux[i * 2]!) / atlas.width, (rect.y + 0.5 + s.lux[i * 2 + 1]!) / atlas.height);
      } else {
        // Deliberate uniform unlit material (never atlas origin).
        luv.push(atlas.unlitUV[0], atlas.unlitUV[1]);
      }
      alpha.push(a);
    }
    for (let i = 1; i < s.n - 1; i++) idx.push(vertStart + 0, vertStart + i, vertStart + i + 1);
    surfaces.set(si, {
      indexStart: start,
      indexCount: idx.length - start,
      vertStart,
      vertCount: s.n,
      texId: s.texId,
      material: cls.material,
      transparent: cls.transparent,
    });
  }
  return {
    world: {
      positions: new Float32Array(pos),
      uvs: new Float32Array(uv),
      lightUVs: new Float32Array(luv),
      alphas: new Float32Array(alpha),
      indices: new Uint32Array(idx),
      surfaces,
    },
    sky: {
      positions: new Float32Array(skyPos),
      indices: new Uint32Array(skyIdx),
      ranges: skyRanges,
    },
  };
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
    pushSurfaceTris(bucket, s, alpha, atlas.rectOf.get(s.id) ?? null, atlas.unlitUV, atlas.width, atlas.height, texW, texH);
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
 * practice on base1; skipped with a recorded warning, never a crash) and
 * the list of ids whose samples were short (filled per-luxel, see below).
 *
 * Tile isolation (FOLLOW-2B): each tile is placed with a 1-texel gutter
 * duplicating its edge texels, and lightUVs address luxel CENTRES
 * (+0.5, matching the CPU sampleLightBlock rule where integer luxel coords
 * hit luxel centres). A bilinear tap at a tile edge therefore blends with
 * the tile's own duplicated edge instead of the neighbour tile. `rectOf`
 * stores the CONTENT origin (gutter-excluded) plus luxel dims.
 *
 * Short samples (FOLLOW-2B): a block shorter than luxW*luxH*3 (the unlit
 * sentinel path) is expanded to EVERY luxel with the neutral mid-gray fill
 * instead of indexing past a 3-byte fallback (which read undefined/NaN and
 * stored black). Recorded in `shortFallback`, never silent.
 *
 * No-light + overflow surfaces (FOLLOW-2B): ids without a rect (missing
 * lightmap, or packed past ATLAS_MAX_DIM) sample the reserved uniform
 * unlit tile (`atlas.unlitUV`) — a deliberate uniform material, never a
 * silent read of whatever tile sits at the atlas origin.
 */
export function packLightAtlas(
  world: MiniWorld,
  surfaceIds: number[],
  lightStyles: Float32Array,
): { atlas: LightAtlas; skipped: number[]; shortFallback: number[] } {
  type Item = { id: number; w: number; h: number; src: Uint8Array; scale: number };
  const items: Item[] = [];
  const shortFallback: number[] = [];
  for (const id of surfaceIds) {
    const surf = world.surfaces[id];
    if (!surf) continue;
    // CPU parity (frame.ts / light.ts): the lightmap block is keyed by
    // surf.lightId % lightmaps.length, NOT by surface id. Procedural tests
    // set lightId == id, hiding divergence; resolve here so a remapped
    // lightId (or % wrap) samples the same block as the CPU reference.
    const lmCount = world.lightmaps.length;
    if (lmCount === 0) continue;
    const lmIdx = ((surf.lightId % lmCount) + lmCount) % lmCount;
    const lm = world.lightmaps[lmIdx];
    if (!lm || lm.luxW < 1 || lm.luxH < 1) continue;
    const need = lm.luxW * lm.luxH * 3;
    let src: Uint8Array;
    if (lm.samples.length >= need) {
      src = lm.samples.subarray(0, need);
    } else {
      // Unlit/short block: neutral fill for EVERY luxel (the bspWorld
      // [128,128,128] sentinel value, replicated — never an OOB read).
      src = new Uint8Array(need).fill(UNLIT_LUXEL);
      shortFallback.push(id);
    }
    items.push({ id, w: lm.luxW, h: lm.luxH, src, scale: combineStyleScales(lm.styles, lightStyles) });
  }
  items.sort((a, b) => b.h - a.h || b.w - a.w);
  const rectOf = new Map<number, { x: number; y: number; w: number; h: number }>();
  const skipped: number[] = [];
  // Shelf pack with 1-texel gutters: padded footprint (w+2, h+2), content
  // origin stored in rectOf. The reserved unlit tile occupies padded (0,0)
  // (content (1,1)); the first shelf row starts at x=3.
  const placed: Array<Item & { x: number; y: number }> = [];
  let shelfY = 0;
  let shelfH = 3;
  let shelfX = 3;
  for (const it of items) {
    const pw = it.w + 2;
    const ph = it.h + 2;
    if (pw > ATLAS_WIDTH || shelfY + Math.max(shelfH, ph) > ATLAS_MAX_DIM) {
      skipped.push(it.id);
      continue;
    }
    if (shelfX + pw > ATLAS_WIDTH) {
      shelfY += shelfH;
      shelfX = 0;
      shelfH = 0;
    }
    if (shelfY + ph > ATLAS_MAX_DIM) {
      skipped.push(it.id);
      continue;
    }
    // Content origin (gutter-excluded).
    placed.push({ ...it, x: shelfX + 1, y: shelfY + 1 });
    rectOf.set(it.id, { x: shelfX + 1, y: shelfY + 1, w: it.w, h: it.h });
    shelfX += pw;
    if (ph > shelfH) shelfH = ph;
  }
  const height = Math.max(3, shelfY + shelfH);
  const pixels = new Uint8Array(ATLAS_WIDTH * height * 3);
  const blit = (dx: number, dy: number, r: number, g: number, b: number): void => {
    const o = (dy * ATLAS_WIDTH + dx) * 3;
    pixels[o] = r;
    pixels[o + 1] = g;
    pixels[o + 2] = b;
  };
  // Reserved uniform unlit tile: content (1,1), gutters duplicated.
  blit(1, 1, UNLIT_LUXEL, UNLIT_LUXEL, UNLIT_LUXEL);
  blit(0, 1, UNLIT_LUXEL, UNLIT_LUXEL, UNLIT_LUXEL);
  blit(2, 1, UNLIT_LUXEL, UNLIT_LUXEL, UNLIT_LUXEL);
  blit(1, 0, UNLIT_LUXEL, UNLIT_LUXEL, UNLIT_LUXEL);
  blit(1, 2, UNLIT_LUXEL, UNLIT_LUXEL, UNLIT_LUXEL);
  blit(0, 0, UNLIT_LUXEL, UNLIT_LUXEL, UNLIT_LUXEL);
  blit(2, 0, UNLIT_LUXEL, UNLIT_LUXEL, UNLIT_LUXEL);
  blit(0, 2, UNLIT_LUXEL, UNLIT_LUXEL, UNLIT_LUXEL);
  blit(2, 2, UNLIT_LUXEL, UNLIT_LUXEL, UNLIT_LUXEL);
  const unlitUV: [number, number] = [1.5 / ATLAS_WIDTH, 1.5 / height];
  for (const p of placed) {
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const si = (y * p.w + x) * 3;
        blit(
          p.x + x, p.y + y,
          clamp255(Math.round(p.src[si]! * p.scale)),
          clamp255(Math.round(p.src[si + 1]! * p.scale)),
          clamp255(Math.round(p.src[si + 2]! * p.scale)),
        );
      }
    }
    // Gutters duplicate the tile edges (bilinear isolation): top/bottom
    // rows, left/right columns, then the four corners.
    const row = (sy: number, dy: number): void => {
      for (let x = 0; x < p.w; x++) {
        const si = (sy * p.w + x) * 3;
        blit(
          p.x + x, dy,
          clamp255(Math.round(p.src[si]! * p.scale)),
          clamp255(Math.round(p.src[si + 1]! * p.scale)),
          clamp255(Math.round(p.src[si + 2]! * p.scale)),
        );
      }
    };
    row(0, p.y - 1);
    row(p.h - 1, p.y + p.h);
    for (let y = 0; y < p.h; y++) {
      const sl = (y * p.w) * 3;
      const sr = (y * p.w + (p.w - 1)) * 3;
      blit(
        p.x - 1, p.y + y,
        clamp255(Math.round(p.src[sl]! * p.scale)),
        clamp255(Math.round(p.src[sl + 1]! * p.scale)),
        clamp255(Math.round(p.src[sl + 2]! * p.scale)),
      );
      blit(
        p.x + p.w, p.y + y,
        clamp255(Math.round(p.src[sr]! * p.scale)),
        clamp255(Math.round(p.src[sr + 1]! * p.scale)),
        clamp255(Math.round(p.src[sr + 2]! * p.scale)),
      );
    }
    const corners: Array<[number, number, number]> = [
      [0, p.x - 1, p.y - 1],
      [p.w - 1, p.x + p.w, p.y - 1],
      [(p.h - 1) * p.w, p.x - 1, p.y + p.h],
      [(p.h - 1) * p.w + (p.w - 1), p.x + p.w, p.y + p.h],
    ];
    for (const [si0, dx, dy] of corners) {
      const si = si0 * 3;
      blit(
        dx, dy,
        clamp255(Math.round(p.src[si]! * p.scale)),
        clamp255(Math.round(p.src[si + 1]! * p.scale)),
        clamp255(Math.round(p.src[si + 2]! * p.scale)),
      );
    }
  }
  return { atlas: { width: ATLAS_WIDTH, height, pixels, rectOf, unlitUV }, skipped, shortFallback };
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
