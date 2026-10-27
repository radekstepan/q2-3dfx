// @q2/sw-renderer colormap — colormap.pcx equivalent (BRAIN.md §7.1).
// 64 shade grades x 256 palette entries. Row 63 = fullbright (identity),
// row 0 = black. Indexed as colormap[(grade << 8) + texel], grade 0..63.
//
// The same file carries the translucency blend table after the shade rows
// (vid.alphamap = vid.colormap + 64*256 in ref_soft): 256x256 entries,
// indexed [src + dst*256] for TRANS33 and [src*256 + dst] for TRANS66.
// This module stores BOTH tables in one index order, [(dst << 8) + src],
// so a single monomorphic span loop serves both ratios (colormap.ts's
// extract pair performs the matching slice/transpose).

import { Com_Error } from '@q2/config';

export const COLORMAP_GRADES = 64;
export const COLORMAP_SIZE = 64 * 256;
/** Shade-table bytes heading pics/colormap.pcx. */
export const ALPHAMAP_HEAD = 64 * 256;
/** Entries in one 256x256 blend table. */
export const ALPHAMAP_SIZE = 256 * 256;
/** Full colormap.pcx pixel payload: shade rows + blend table. */
export const COLORMAP_PCX_PIXELS = ALPHAMAP_HEAD + ALPHAMAP_SIZE;

/** Build a 64x256 shade table from a 768-byte RGB palette. Deterministic. */
export function buildColormap(palette: Uint8Array): Uint8Array {
  const pal = palette.length >= 768 ? palette : defaultPalette();
  const table = new Uint8Array(COLORMAP_SIZE);
  for (let g = 0; g < COLORMAP_GRADES; g++) {
    const scale = g / (COLORMAP_GRADES - 1);
    const row = g * 256;
    for (let c = 0; c < 256; c++) {
      const r = pal[c * 3]! * scale;
      const gg = pal[c * 3 + 1]! * scale;
      const b = pal[c * 3 + 2]! * scale;
      table[row + c] = nearestPaletteIndex(pal, r, gg, b);
    }
  }
  return table;
}

function nearestPaletteIndex(pal: Uint8Array, r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < 256; i++) {
    const dr = pal[i * 3]! - r;
    const dg = pal[i * 3 + 1]! - g;
    const db = pal[i * 3 + 2]! - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Procedural fallback palette (asset-free boot, BRAIN.md §8).
 * Deterministic 256-entry ramp: greys + warm/cool tint bands, quake-ish.
 */
export function defaultPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    // quake-like: dark browns -> greys -> warm highlights
    const r = Math.min(255, Math.round(64 + 220 * t * t));
    const g = Math.min(255, Math.round(48 + 190 * t * t));
    const b = Math.min(255, Math.round(40 + 150 * t * t));
    pal[i * 3] = r;
    pal[i * 3 + 1] = g;
    pal[i * 3 + 2] = b;
  }
  // entry 0 = black (transparent convention), entry 255 = white
  pal[0] = 0; pal[1] = 0; pal[2] = 0;
  pal[765] = 255; pal[766] = 255; pal[767] = 255;
  return pal;
}

/**
 * Procedural 256x256 blend tables for a palette (asset-free fallback when
 * pics/colormap.pcx is absent). Entry [(dst << 8) + src] is the nearest
 * palette index to src*srcWeight + dst*(1-srcWeight) in RGB — the same
 * source-over-destination weighting C passes to R_ClipAndDrawPoly (0.30 for
 * TRANS33 glass, 0.60 for TRANS66). Both tables build in one pass over the
 * 64K pairs. Deterministic; lazily built once per palette (setPalette only
 * arms, the first translucent frame pays the ~100ms build).
 */
export function buildAlphamapPair(palette: Uint8Array): { a33: Uint8Array; a66: Uint8Array } {
  const pal = palette.length >= 768 ? palette : defaultPalette();
  const a33 = new Uint8Array(ALPHAMAP_SIZE);
  const a66 = new Uint8Array(ALPHAMAP_SIZE);
  for (let dst = 0; dst < 256; dst++) {
    const dr = pal[dst * 3]!, dg = pal[dst * 3 + 1]!, db = pal[dst * 3 + 2]!;
    for (let src = 0; src < 256; src++) {
      const sr = pal[src * 3]!, sg = pal[src * 3 + 1]!, sb = pal[src * 3 + 2]!;
      // 0.30 source weight (TRANS33): mostly background shows through.
      const r33 = sr * 0.3 + dr * 0.7, g33 = sg * 0.3 + dg * 0.7, b33 = sb * 0.3 + db * 0.7;
      // 0.60 source weight (TRANS66): mostly the surface itself.
      const r66 = sr * 0.6 + dr * 0.4, g66 = sg * 0.6 + dg * 0.4, b66 = sb * 0.6 + db * 0.4;
      let best33 = 0, best66 = 0, d33 = Infinity, d66 = Infinity;
      for (let i = 0; i < 256; i++) {
        const pr = pal[i * 3]!, pg = pal[i * 3 + 1]!, pb = pal[i * 3 + 2]!;
        const er = pr - r33, eg = pg - g33, eb = pb - b33;
        const dd33 = er * er + eg * eg + eb * eb;
        if (dd33 < d33) { d33 = dd33; best33 = i; }
        const fr = pr - r66, fg = pg - g66, fb = pb - b66;
        const dd66 = fr * fr + fg * fg + fb * fb;
        if (dd66 < d66) { d66 = dd66; best66 = i; }
      }
      const o = (dst << 8) + src;
      a33[o] = best33;
      a66[o] = best66;
    }
  }
  return { a33, a66 };
}

/**
 * Slice the TRANS33 blend table out of parsed colormap.pcx pixels (the
 * 64K bytes after the shade rows, C's vid.alphamap). Stored [(dst<<8)+src],
 * matching C's alphamap[src + dst*256] indexing with zero copy cost beyond
 * the slice.
 */
export function extractAlphamap33(pixels: Uint8Array): Uint8Array {
  if (pixels.length < COLORMAP_PCX_PIXELS) {
    Com_Error('fatal', `extractAlphamap33: need ${COLORMAP_PCX_PIXELS} pixels, got ${pixels.length}`);
  }
  return pixels.slice(ALPHAMAP_HEAD, ALPHAMAP_HEAD + ALPHAMAP_SIZE);
}

/**
 * The TRANS66 view of the same table: C indexes alphamap[src*256 + dst],
 * so the transpose is built once (64K, at pak-load time) to keep the span
 * loop's [(dst<<8)+src] order monomorphic.
 */
export function extractAlphamap66(pixels: Uint8Array): Uint8Array {
  if (pixels.length < COLORMAP_PCX_PIXELS) {
    Com_Error('fatal', `extractAlphamap66: need ${COLORMAP_PCX_PIXELS} pixels, got ${pixels.length}`);
  }
  const out = new Uint8Array(ALPHAMAP_SIZE);
  const base = ALPHAMAP_HEAD;
  for (let dst = 0; dst < 256; dst++) {
    for (let src = 0; src < 256; src++) {
      out[(dst << 8) + src] = pixels[base + (src << 8) + dst]!;
    }
  }
  return out;
}
