// @q2/sw-renderer colormap — colormap.pcx equivalent (BRAIN.md §7.1).
// 64 shade grades x 256 palette entries. Row 63 = fullbright (identity),
// row 0 = black. Indexed as colormap[(grade << 8) + texel], grade 0..63.

export const COLORMAP_GRADES = 64;
export const COLORMAP_SIZE = 64 * 256;

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
