// @q2/voodoo — Voodoo texture-upload + addressing policy (astra V2b/step-4).
//
// TEXEL-CENTRE CONVENTION (stated once, here — every voodoo sampler follows it):
// u/v are TEXEL coordinates: integer u addresses the CENTRE of texel column u,
// i.e. texel (i, j) spans [i - 0.5, i + 0.5) x [j - 0.5, j + 0.5). Normalized
// coordinates convert as u_texel = un * w - 0.5 (same for v). Callers pass
// texel coordinates; samplers apply NO hidden +0.5/-0.5 of their own, so there
// is exactly one -0.5 between normalized and texel space. NEVER apply it twice.
//
// Upload policy (textureMode §9.3.58):
// - Load original WAL assets. Keep WAL mip levels where present and fitting the
//   cap, else generate missing levels by 2x2 box filtering (completeMipChainRGB
//   halves with halveRGB; indexed sources must be expanded first — see below).
// - Cap each upload to vd_maxtexsize (default 256) preserving aspect ratio via
//   capTextureSize, then handle power-of-two (POT) dimensions per ADDRESSING
//   POLICY (application/driver choice, NOT hardware-mandated — real hardware
//   wants POT; which emulation applies is chosen by the material's addressing):
//   - REPEAT (tiled world textures): REALLY resample the texels with
//     resampleTexture (box filter) to the capped/POT size. Padding cannot
//     emulate repeat: a padded edge would break wrap seams. Halving keeps POT
//     inputs POT; non-POT inputs stay non-POT until the caller resamples — a
//     documented approximation (real hardware wants POT). The returned uvScale
//     maps original texel-space UVs onto the resampled image:
//     u' = u * uvScaleS, v' = v * uvScaleT.
//   - CLAMP (lightmaps, sprites/UI): PAD to POT with padTextureToPOT (edge
//     replication, texels preserved byte-exact, no filtering blur) + UV scale
//     adjust (uvScaleS = srcW/padW for normalized-UV callers; texel-space
//     callers address the original region directly, clamp pins the edge).
// - NEVER average palette indices numerically: indexed resampling expands each
//   tap through the palette first and filters the resulting COLORS, then maps
//   the average back to the nearest non-transparent palette entry. Index
//   `transparentIndex` (WAL default 255) is transparent: taps carrying it are
//   EXCLUDED from the average; an all-transparent footprint uploads as
//   transparentIndex (transparency preserved, no opaque fringe averaged in).
// - Addressing (repeat vs clamp) is per-TAP (wrapTap): repeat wraps EACH of the
//   four bilinear taps, not just the centre coordinate, so tiled world textures
//   stay seamless. Clamp (lightmaps, sprites/UI) keeps edge texels.
//
// Allocation: sampling helpers (wrapTap) allocate nothing. Upload-time helpers
// (resampleTexture/halveRGB/completeMipChainRGB) allocate their documented
// outputs — uploads happen on cache rebuild, never in the inner loop.

/** Per-axis texture addressing: tiled world textures repeat, lightmaps clamp. */
export type TextureAddress = 'repeat' | 'clamp';

/**
 * Address a single integer bilinear tap for one axis.
 * repeat: wraps into [0, size) — apply to EACH of the 4 taps (x0, x1, y0, y1),
 *   not just the sample centre, or repeated filtering still shows seams.
 * clamp: pins to [0, size - 1] (edge texel replicated).
 * size <= 1 collapses to tap 0. Fractional input is truncated (taps are ints).
 */
export function wrapTap(tap: number, size: number, mode: TextureAddress): number {
  const t = Math.trunc(tap);
  if (size <= 1) return 0;
  if (mode === 'repeat') {
    const r = t % size;
    return r < 0 ? r + size : r;
  }
  return t < 0 ? 0 : t >= size ? size - 1 : t;
}

export interface ResampleOptions {
  /**
   * 768-byte RGB palette. Presence selects INDEXED input (1 byte/texel);
   * absence selects expanded RGB input (3 bytes/texel triplets).
   */
  palette?: Uint8Array;
  /** Transparent palette index, excluded from filter averages (default 255). */
  transparentIndex?: number;
  /** Optional scratch for the output (dstW*dstH*bpp bytes); allocated if absent. */
  out?: Uint8Array;
}

export interface ResampledTexture {
  data: Uint8Array;
  w: number;
  h: number;
  /**
   * UV scale of this upload vs the source: multiply stored texel-space UVs by
   * it (u' = u * uvScaleS, v' = v * uvScaleT) to sample the resampled image.
   */
  uvScaleS: number;
  uvScaleT: number;
}

/** One mip level: RGB triplets (upload-time expanded) or palette indices. */
export interface MipLevel {
  data: Uint8Array;
  w: number;
  h: number;
}

function checkDims(srcW: number, srcH: number, dstW: number, dstH: number): void {
  for (const [name, v] of [
    ['srcW', srcW],
    ['srcH', srcH],
    ['dstW', dstW],
    ['dstH', dstH],
  ] as const) {
    if (!Number.isInteger(v) || v <= 0) {
      throw new Error(`[voodoo] resampleTexture: ${name} must be a positive int, got ${v}`);
    }
  }
}

/** Nearest palette entry to (r, g, b), skipping `skip` (transparent). Squared RGB distance. */
function nearestPaletteEntry(
  palette: Uint8Array,
  r: number,
  g: number,
  b: number,
  skip: number,
): number {
  let best = skip === 0 ? 1 : 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 256; i++) {
    if (i === skip) continue;
    const dr = palette[i * 3]! - r;
    const dg = palette[i * 3 + 1]! - g;
    const db = palette[i * 3 + 2]! - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
      if (d === 0) break;
    }
  }
  return best;
}

function resampleRGBInto(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  out: Uint8Array,
): void {
  for (let dy = 0; dy < dstH; dy++) {
    let iy0 = (dy * srcH) / dstH | 0;
    let iy1 = Math.ceil(((dy + 1) * srcH) / dstH) - 1;
    if (iy1 < iy0) iy1 = iy0;
    if (iy0 < 0) iy0 = 0;
    if (iy1 >= srcH) iy1 = srcH - 1;
    for (let dx = 0; dx < dstW; dx++) {
      let ix0 = (dx * srcW) / dstW | 0;
      let ix1 = Math.ceil(((dx + 1) * srcW) / dstW) - 1;
      if (ix1 < ix0) ix1 = ix0;
      if (ix0 < 0) ix0 = 0;
      if (ix1 >= srcW) ix1 = srcW - 1;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let sy = iy0; sy <= iy1; sy++) {
        const row = sy * srcW;
        for (let sx = ix0; sx <= ix1; sx++) {
          const p = (row + sx) * 3;
          sr += src[p]!;
          sg += src[p + 1]!;
          sb += src[p + 2]!;
          n++;
        }
      }
      const half = n >> 1;
      const d = (dy * dstW + dx) * 3;
      out[d] = ((sr + half) / n) | 0;
      out[d + 1] = ((sg + half) / n) | 0;
      out[d + 2] = ((sb + half) / n) | 0;
    }
  }
}

function resampleIndexedInto(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  palette: Uint8Array,
  transparent: number,
  dstW: number,
  dstH: number,
  out: Uint8Array,
): void {
  for (let dy = 0; dy < dstH; dy++) {
    let iy0 = (dy * srcH) / dstH | 0;
    let iy1 = Math.ceil(((dy + 1) * srcH) / dstH) - 1;
    if (iy1 < iy0) iy1 = iy0;
    if (iy0 < 0) iy0 = 0;
    if (iy1 >= srcH) iy1 = srcH - 1;
    for (let dx = 0; dx < dstW; dx++) {
      let ix0 = (dx * srcW) / dstW | 0;
      let ix1 = Math.ceil(((dx + 1) * srcW) / dstW) - 1;
      if (ix1 < ix0) ix1 = ix0;
      if (ix0 < 0) ix0 = 0;
      if (ix1 >= srcW) ix1 = srcW - 1;
      // Filter COLORS, never indices: expand each tap, skip transparent.
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let sy = iy0; sy <= iy1; sy++) {
        const row = sy * srcW;
        for (let sx = ix0; sx <= ix1; sx++) {
          const idx = src[row + sx]!;
          if (idx === transparent) continue;
          const p = idx * 3;
          sr += palette[p]!;
          sg += palette[p + 1]!;
          sb += palette[p + 2]!;
          n++;
        }
      }
      const d = dy * dstW + dx;
      if (n === 0) {
        out[d] = transparent; // all-transparent footprint stays transparent
      } else {
        const half = n >> 1;
        out[d] = nearestPaletteEntry(
          palette,
          ((sr + half) / n) | 0,
          ((sg + half) / n) | 0,
          ((sb + half) / n) | 0,
          transparent,
        );
      }
    }
  }
}

/**
 * REAL texel resampling for texture upload (textureMode §9.3.58) — the
 * companion to capTextureSize, which only computes smaller DIMENSIONS. Box
 * filter from srcW/srcH to dstW/dstH, preserving aspect when the caller passes
 * capped dimensions (typical: `const {w,h} = capTextureSize(srcW,srcH,max)`).
 * RGB input averages triplets; indexed input (opts.palette) expands through
 * the palette and filters COLORS — palette indices are never averaged
 * numerically — with opts.transparentIndex (default 255) excluded from the
 * average and preserved on all-transparent footprints. Returns the pixels plus
 * uvScaleS/uvScaleT to remap stored texel-space UVs onto the upload.
 */
export function resampleTexture(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  opts: ResampleOptions = {},
): ResampledTexture {
  checkDims(srcW, srcH, dstW, dstH);
  const indexed = opts.palette !== undefined;
  const bpp = indexed ? 1 : 3;
  if (src.length < srcW * srcH * bpp) {
    throw new Error(
      `[voodoo] resampleTexture: src too small (${src.length} < ${srcW * srcH * bpp})`,
    );
  }
  let out = opts.out;
  if (out === undefined) {
    out = new Uint8Array(dstW * dstH * bpp);
  } else if (out.length < dstW * dstH * bpp) {
    throw new Error(`[voodoo] resampleTexture: out scratch too small`);
  }
  if (indexed) {
    const palette = opts.palette!;
    if (palette.length < 768) {
      throw new Error(`[voodoo] resampleTexture: palette too small (${palette.length} < 768)`);
    }
    const transparent = opts.transparentIndex ?? 255;
    if (!Number.isInteger(transparent) || transparent < 0 || transparent > 255) {
      throw new Error(
        `[voodoo] resampleTexture: transparentIndex must be 0..255, got ${transparent}`,
      );
    }
    resampleIndexedInto(src, srcW, srcH, palette, transparent, dstW, dstH, out);
  } else {
    resampleRGBInto(src, srcW, srcH, dstW, dstH, out);
  }
  return { data: out, w: dstW, h: dstH, uvScaleS: dstW / srcW, uvScaleT: dstH / srcH };
}

/**
 * Halve an expanded-RGB image by 2x2 box filtering (one mip step down;
 * profile 'texture.mip-kernel': PG describes driver-provided chains only —
 * the box kernel is the deterministic stand-in).
 * Odd dimensions cover the full footprint (3x1 halves to the average of all
 * three, not just the first two). Minimum 1x1; 1x1 input returns a 1x1 copy.
 * Upload-time allocation. Indexed sources: expand first (never average indices).
 */
export function halveRGB(src: Uint8Array, srcW: number, srcH: number): MipLevel {
  const w = srcW > 1 ? srcW >> 1 : 1;
  const h = srcH > 1 ? srcH >> 1 : 1;
  if (src.length < srcW * srcH * 3) {
    throw new Error(`[voodoo] halveRGB: src too small (${src.length} < ${srcW * srcH * 3})`);
  }
  const data = new Uint8Array(w * h * 3);
  resampleRGBInto(src, srcW, srcH, w, h, data);
  return { data, w, h };
}

/**
 * WAL mip-chain policy: KEEP the provided levels (WAL's own chain) where
 * present, GENERATE the missing tail by repeated 2x2 box halving from the
 * last present level (profile 'texture.mip-kernel'). Truncates to wantLevels when more are present. Throws on
 * an empty chain or non-positive wantLevels. Stops early at 1x1 (a chain can
 * never be longer than log2(max(w,h)) + 1). Levels are RGB-triplet MipLevels;
 * indexed WAL chains must be expanded at upload before generating.
 */
export function completeMipChainRGB(present: MipLevel[], wantLevels: number): MipLevel[] {
  if (present.length === 0) {
    throw new Error(`[voodoo] completeMipChainRGB: need at least the base level`);
  }
  if (!Number.isInteger(wantLevels) || wantLevels <= 0) {
    throw new Error(`[voodoo] completeMipChainRGB: wantLevels must be > 0, got ${wantLevels}`);
  }
  const chain = present.slice(0, wantLevels);
  while (chain.length < wantLevels) {
    const last = chain[chain.length - 1]!;
    if (last.w === 1 && last.h === 1) break;
    chain.push(halveRGB(last.data, last.w, last.h));
  }
  return chain;
}

// --- Non-POT padded upload (CLAMPED texture policy) ----------------------------
//
// CLAMPED textures (lightmaps, sprites/UI) with non-power-of-two dimensions
// upload via PAD-TO-POT + UV SCALE ADJUST: the source texels are preserved
// byte-exact (no filtering blur) in the top-left of a next-POT buffer, the
// padding replicates the edge texel (clamp semantics), and normalized-UV
// callers scale by uvScaleS/srcW (u' = u * srcW/padW) to address the padded
// upload. Texel-space callers (this package's sampler convention) address the
// original region directly — no scaling, clamp addressing pins the edge.
//
// POLICY CHOICE (application/driver, not hardware-mandated): REPEAT textures
// use resampleTexture (true resampled texels — padding would break wrap
// seams); CLAMPED textures use this pad helper (exact texels — resampling
// would blur). Upload-time allocation; never called in the inner loop.

/** Next power of two >= n. Throws on non-integer n < 1. */
export function nextPOT(n: number): number {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`[voodoo] nextPOT: n must be a positive int, got ${n}`);
  }
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export interface PaddedTexture {
  /** Padded upload pixels (padW*padH*bpp bytes; bpp = 1 indexed, 3 RGB). */
  data: Uint8Array;
  /** Padded upload dimensions (each a POT >= the matching source dimension). */
  w: number;
  h: number;
  /** Source dimensions (the original region inside the padded upload). */
  srcW: number;
  srcH: number;
  /**
   * UV scale of this upload vs the source for NORMALIZED-UV callers:
   * multiply normalized u/v (0..1 over the ORIGINAL image) by
   * uvScaleS/uvScaleT (srcW/w, srcH/h) to sample the padded upload.
   * Texel-space callers need no scaling (original region is at the origin).
   */
  uvScaleS: number;
  uvScaleT: number;
}

/**
 * Pad a non-POT texture to POT for CLAMPED addressing (textureMode §9.3.58): edge-replicate into a next-POT buffer, preserving every source
 * texel byte-exact. RGB input (default) pads triplets; indexed input
 * (opts.palette present) pads indices — padding replicates the EDGE index
 * as-is, so transparentIndex texels on the border stay transparent (no
 * filtering, no nearest-match lookup). Already-POT inputs still copy into a
 * fresh buffer with uvScale 1. Returns the pixels plus dimensions and the
 * normalized-UV scale (srcW/w, srcH/h).
 */
export function padTextureToPOT(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  opts: ResampleOptions = {},
): PaddedTexture {
  checkDims(srcW, srcH, srcW, srcH);
  const indexed = opts.palette !== undefined;
  const bpp = indexed ? 1 : 3;
  if (src.length < srcW * srcH * bpp) {
    throw new Error(
      `[voodoo] padTextureToPOT: src too small (${src.length} < ${srcW * srcH * bpp})`,
    );
  }
  if (indexed && opts.palette!.length < 768) {
    throw new Error(`[voodoo] padTextureToPOT: palette too small (${opts.palette!.length} < 768)`);
  }
  const w = nextPOT(srcW);
  const h = nextPOT(srcH);
  const data = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const sy = y < srcH ? y : srcH - 1;
    for (let x = 0; x < w; x++) {
      const sx = x < srcW ? x : srcW - 1;
      const s = (sy * srcW + sx) * bpp;
      const d = (y * w + x) * bpp;
      for (let c = 0; c < bpp; c++) data[d + c] = src[s + c]!;
    }
  }
  return { data, w, h, srcW, srcH, uvScaleS: srcW / w, uvScaleT: srcH / h };
}
