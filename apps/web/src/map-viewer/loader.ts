// apps/web map-viewer loader: standalone .bsp + .pak ingest and texture resolution.
//
// All files stay local to the browser; nothing is uploaded or bundled. A BSP
// that parses but lacks textures/palette/lightmaps/visibility/spawn data
// still loads: each gap is reported once in `missingAssets` and the renderer
// falls back to checker/procedural art (see bspToMiniWorld's texelFor).

import { loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { parsePCX, parseWAL } from '@q2/formats';
import { parseEntities } from '@q2/game';
import { parsePakEntries, readPakEntry } from '../pak.js';
import type { WebPak } from '../pak.js';
import { listPakMaps } from './pak-view.js';

export { listPakMaps };

/** One decoded mip-0 texture for the software renderer (`bspToMiniWorld` shape). */
export interface Texel {
  texels: Uint8Array;
  width: number;
  height: number;
}

/** Texture lookup by texinfo name; null = missing (checker fallback). */
export type TexelFor = (walName: string) => Texel | null;

/** A BSP ready to view, plus a one-per-gap summary of what fell back. */
export interface LoadedMap {
  /** Short name: file stem or maps/*.bsp lump without directory/extension. */
  name: string;
  /** Where it came from: `file:<name>` or `pak:<lump>`. */
  source: string;
  bsp: BspMap;
  /** e.g. `texture:e1u1/floor1`, `palette:pics/colormap.pcx`, `vis:empty`. */
  missingAssets: string[];
}

/** Parse + validate raw BSP bytes. Throws a plain Error with the cause kept. */
export function validateBsp(buf: ArrayBuffer): BspMap {
  if (!(buf instanceof ArrayBuffer)) {
    throw new Error('invalid BSP: expected an ArrayBuffer');
  }
  try {
    return loadBsp(buf);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid BSP: ${detail}`);
  }
}

/** Normalize a texinfo texture name to its `textures/<base>.wal` lump. */
function walLumpFor(walName: string): string | null {
  let base = walName.trim().toLowerCase().replace(/\\/g, '/');
  if (base.startsWith('textures/')) base = base.slice('textures/'.length);
  if (base.endsWith('.wal')) base = base.slice(0, -'.wal'.length);
  if (!base) return null;
  return `textures/${base}.wal`;
}

/**
 * Build a texture callback over user-supplied asset PAKs. First-listed PAK
 * wins ties (consistent with the game's lookup order); an unparseable WAL in
 * an earlier PAK falls through to the next one. Null = checker fallback.
 */
export function resolveTexelFor(assetPaks: WebPak[]): TexelFor {
  const paks = assetPaks.slice();
  return (walName: string): Texel | null => {
    const lump = walLumpFor(walName);
    if (!lump) return null;
    for (const pak of paks) {
      let bytes: ArrayBuffer | null = null;
      try {
        bytes = readPakEntry(pak, lump);
      } catch {
        continue;
      }
      try {
        const wal = parseWAL(bytes);
        const mip0 = wal.mips[0];
        if (!mip0) continue;
        return { texels: mip0, width: wal.width, height: wal.height };
      } catch {
        continue;
      }
    }
    return null;
  };
}

/** True when any of the asset PAKs carries the lump (exact-lowercase). */
export function hasAssetLump(assetPaks: WebPak[], lump: string): boolean {
  const lower = lump.toLowerCase();
  return assetPaks.some((pak) => pak.entries.some((e) => e.name === lower));
}

/** Palette lump the viewer resolves for indexed art (mirrors play.ts). */
export const PALETTE_LUMP = 'pics/colormap.pcx';

/** Very light grey target for the sky stand-in (contrasts with the model). */
const GREY_SKY_RGB: [number, number, number] = [224, 224, 224];

/**
 * Flat light-grey sky stand-in: the viewer hides sky surfaces behind a
 * uniform very-light-grey fill so openings read as contrast against the
 * model instead of sky art or the engine's flat-blue fallback. Built from
 * the installed palette via nearest-match (indices are palette-relative),
 * packed as the renderer's 6-tile strip contract (4x1 tiles). Returns null
 * without a usable palette — the caller then keeps the flat fallback.
 * Pure, never throws.
 */
export function buildGreySkyStrip(palette: Uint8Array | null): {
  texels: Uint8Array;
  width: number;
  height: number;
} | null {
  if (!palette || palette.length < 768) return null;
  try {
    const [tr, tg, tb] = GREY_SKY_RGB;
    let best = 0, bd = Infinity;
    for (let j = 0; j < 256; j++) {
      const dr = palette[j * 3]! - tr, dg = palette[j * 3 + 1]! - tg, db = palette[j * 3 + 2]! - tb;
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    return { texels: new Uint8Array(4 * 6).fill(best), width: 4, height: 6 };
  } catch {
    return null;
  }
}


/** Decoded colormap: 768-byte RGB palette + raw pixels for C-exact blend tables. */
export interface ColormapPcx {
  palette: Uint8Array;
  pixels: Uint8Array;
}

/**
 * Resolve `pics/colormap.pcx` for the software renderer's palette.
 * First-listed asset PAK wins (consistent with texture lookup), then the
 * map's own PAK. Returns null when no PAK carries a parseable colormap —
 * the renderer keeps its procedural fallback. Never throws: an unparseable
 * lump falls through to the next PAK instead of failing the load.
 */
export function resolveColormapPcx(assetPaks: WebPak[], mapPak?: WebPak | null): ColormapPcx | null {
  const paks: WebPak[] = [...assetPaks];
  if (mapPak) paks.push(mapPak);
  for (const pak of paks) {
    let bytes: ArrayBuffer | null = null;
    try {
      bytes = readPakEntry(pak, PALETTE_LUMP);
    } catch {
      continue;
    }
    try {
      const pcx = parsePCX(bytes);
      if (pcx.palette.length !== 768) continue;
      return { palette: pcx.palette, pixels: pcx.pixels };
    } catch {
      continue;
    }
  }
  return null;
}

export interface MissingOpts {
  texelFor?: TexelFor;
  /** True when a usable palette was found (asset PAK or map PAK). */
  hasPalette?: boolean;
}

/**
 * One-per-gap summary of what the renderer must fake. Never throws: entity
 * parsing is tolerant and every other check is a length test, so a hostile
 * lump degrades to "missing" instead of crashing the viewer.
 */
export function collectMissingAssets(bsp: BspMap, opts?: MissingOpts): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const raw of bsp.texinfoNames) {
    const name = (raw ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (opts?.texelFor && opts.texelFor(name) !== null) continue;
    missing.push(`texture:${name}`);
  }
  if (!opts?.hasPalette) missing.push(`palette:${PALETTE_LUMP}`);
  if (bsp.lighting.length === 0) missing.push('lighting:empty (unlit fallback)');
  if (bsp.visibility.length === 0 || bsp.numClusters === 0) {
    missing.push('vis:empty (all visible)');
  }
  let hasSpawn = false;
  try {
    for (const dict of parseEntities(bsp.entities)) {
      if (dict['classname'] === 'info_player_start') {
        hasSpawn = true;
        break;
      }
    }
  } catch {
    hasSpawn = false;
  }
  if (!hasSpawn) missing.push('spawn:no info_player_start (bounds fallback)');
  return missing;
}

/** Strip directory + .bsp for display. */
function stemOf(fileName: string): string {
  const slash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  const base = slash >= 0 ? fileName.slice(slash + 1) : fileName;
  return base.toLowerCase().endsWith('.bsp') ? base.slice(0, -'.bsp'.length) : base;
}

/**
 * Load a standalone .bsp dropped or picked by the user. Optional asset PAKs
 * resolve textures/palette (first-listed wins); without them every texture
 * and the palette land in `missingAssets` as checker/procedural fallbacks.
 */
export async function loadStandaloneBsp(file: File, assetPaks: WebPak[] = []): Promise<LoadedMap> {
  const buf = await file.arrayBuffer();
  const bsp = validateBsp(buf);
  const texelFor = resolveTexelFor(assetPaks);
  return {
    name: stemOf(file.name),
    source: `file:${file.name}`,
    bsp,
    missingAssets: collectMissingAssets(bsp, {
      texelFor,
      hasPalette: hasAssetLump(assetPaks, PALETTE_LUMP),
    }),
  };
}

/** Parse a user-supplied .pak file. Throws a filename-tagged Error when bad. */
export async function parsePakFile(file: File): Promise<WebPak> {
  const buf = await file.arrayBuffer();
  try {
    return { entries: parsePakEntries(buf), data: buf };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid PAK ${file.name}: ${detail}`);
  }
}

/**
 * Load one maps/*.bsp lump out of an already-parsed PAK. Textures and palette
 * resolve from the same PAK; anything absent lands in `missingAssets`.
 */
export function loadPakMap(pak: WebPak, name: string): LoadedMap {
  let bytes: ArrayBuffer;
  try {
    bytes = readPakEntry(pak, name);
  } catch {
    throw new Error(`map not in PAK: ${name}`);
  }
  const bsp = validateBsp(bytes);
  const texelFor = resolveTexelFor([pak]);
  return {
    name: stemOf(name),
    source: `pak:${name.toLowerCase()}`,
    bsp,
    missingAssets: collectMissingAssets(bsp, {
      texelFor,
      hasPalette: hasAssetLump([pak], PALETTE_LUMP),
    }),
  };
}
