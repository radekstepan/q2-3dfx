// @q2/formats — BSP38, WAL, PCX, MD2, SP2, WAV parsers → plain typed arrays.
// M1.2/M2.1 own this. Ports qcommon/qfiles.h structs, ref_soft/r_image.c
// (LoadPCX, R_LoadWal) and client/snd_mem.c (GetWavinfo).
import { Com_Error, Com_Warn } from '@q2/config';

/**
 * BSP38 world header (frozen §6 contract — do NOT add fields here without a
 * major changeset; see the M2.1 report in BRAIN.md).
 *
 * This is intentionally a narrow structural view: planes/nodes/leafs/faces
 * share field names AND packed layouts with the full `@q2/bsp` BspMap
 * (NODE_STRIDE 11 / LEAF_STRIDE 13 / FACE_STRIDE 10 ints), so every BspMap
 * is assignable to Bsp38. DELTA vs BspMap (lives in @q2/bsp, NOT re-pointed
 * here per §12 rule 2 — that is a separate contract-change PR): planeTypes,
 * vertexes, visibility, numClusters, visBitofs, nodeMins/Maxs, texinfo*,
 * lighting, leaffaces, leafbrushes, edges, surfedges, models*,
 * brushes, brushsides, entities, pop, areas, areaportals.
 */
export interface Bsp38 {
  planes: Float32Array;
  nodes: Int32Array;
  leafs: Int32Array;
  faces: Int32Array;
  raw: ArrayBuffer;
}

/** BSP38 stub: the full loader lives in `@q2/bsp` (`loadBsp`). Kept as a
 * stub here per §12 rule 2 — re-pointing it at the bsp loader is a
 * separate contract-change PR owned by a follow-up card. */
export function parseBSP38(_buf: ArrayBuffer): Bsp38 {
  Com_Error('fatal', 'not implemented: parseBSP38');
}

/** Quake II wall texture: 4 mip levels of palette indices. See miptex_t. */
export interface Wal {
  name: string;
  width: number;
  height: number;
  /** 4 mip levels, sizes w*h, w*h/4, w*h/16, w*h/64. */
  mips: Uint8Array[];
  animname: string;
  flags: number;
  contents: number;
  value: number;
}

/** Decoded 8-bit PCX: pixel indices plus the trailing 768-byte RGB palette. */
export interface Pcx {
  width: number;
  height: number;
  pixels: Uint8Array;
  /** 256 RGB triplets. */
  palette: Uint8Array;
}

/** Quake II sprite: flat numeric lump data plus frame art names. */
export interface Sp2 {
  version: number;
  widths: Int32Array;
  heights: Int32Array;
  originX: Int32Array;
  originY: Int32Array;
  names: string[];
}

/** PCM header facts for a .wav lump (client/snd_mem.c GetWavinfo). */
export interface WavInfo {
  rate: number;
  /** Sample width in bytes (1 or 2). */
  width: number;
  channels: number;
  /** Decoded sample count (8-bit samples are unsigned, 16-bit signed LE). */
  samples: number;
  /** Loop start in samples, -1 when the cue chunk is absent. */
  loopstart: number;
  /** Byte offset of the raw sample data from the start of the lump. */
  dataOffset: number;
}

/** Quake II alias model: flat numeric lump data plus skin/frame names. */
export interface Md2 {
  skinWidth: number;
  skinHeight: number;
  numFrames: number;
  /** Vertex count per frame (num_xyz in dmdl_t). */
  numVerts: number;
  /** Texture-coord count (num_st; greater than numVerts when seams exist). */
  numSt: number;
  numTris: number;
  numSkins: number;
  /** DWORD count of the strip/fan command list (parsed but not stored). */
  numGlcmds: number;
  /** Skin art names (MAX_SKINNAME each). */
  skins: string[];
  /** numSt*2 shorts: (s, t) per st vert (dstvert_t). */
  st: Int16Array;
  /** numTris*3 vertex indices into frames (dtriangle_t index_xyz). */
  trisXyz: Uint16Array;
  /** numTris*3 st indices into st (dtriangle_t index_st). */
  trisSt: Uint16Array;
  /** numFrames*numVerts*3 decoded positions: v*scale+translate (daliasframe_t). */
  frames: Float32Array;
  /** numFrames*numVerts shade-dot indices (dtrivertx_t lightnormalindex). */
  normals: Uint8Array;
  /** Frame names (16 chars each). */
  frameNames: string[];
  /** numFrames*3 per-frame scale. */
  scales: Float32Array;
  /** numFrames*3 per-frame translate. */
  translates: Float32Array;
}

/** Magic ident of a Quake II MD2 model: little-endian "IDP2". */
export const MD2_IDENT = 0x32504449;
export const MD2_VERSION = 8;
/** On-disk size of dmdl_t (17 int32). */
export const MD2_HEADER_SIZE = 68;
/** Fixed bytes per skin name (MAX_SKINNAME). */
export const MD2_SKINNAME_SIZE = 64;
/** Fixed-part bytes of daliasframe_t: scale[3]f + translate[3]f + name[16]. */
export const MD2_FRAME_HEADER_SIZE = 40;
/** Bytes per compressed vertex (dtrivertx_t). */
export const MD2_VERT_SIZE = 4;
/** Fixed bytes per frame name. */
export const MD2_FRAME_NAME_SIZE = 16;
/** Upper design bounds from qcommon/qfiles.h. */
export const MD2_MAX_TRIS = 4096;
export const MD2_MAX_VERTS = 2048;
export const MD2_MAX_FRAMES = 512;
export const MD2_MAX_SKINS = 32;

/**
 * Parse an .md2 alias model (dmdl_t). Numeric lump data stays in flat typed
 * arrays; skin/frame names are plain strings. The glcmd strip/fan list is
 * validated to sit inside the file but not stored (the renderer walks tris).
 */
export function parseMD2(buf: ArrayBuffer): Md2 {
  if (buf.byteLength < MD2_HEADER_SIZE) Com_Error('fatal', 'parseMD2: too small for header');
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (view.getInt32(0, true) !== MD2_IDENT) Com_Error('fatal', 'parseMD2: bad ident');
  const version = view.getInt32(4, true);
  if (version !== MD2_VERSION) Com_Error('fatal', `parseMD2: bad version ${version}`);
  const skinWidth = view.getInt32(8, true);
  const skinHeight = view.getInt32(12, true);
  const framesize = view.getInt32(16, true);
  const numSkins = view.getInt32(20, true);
  const numVerts = view.getInt32(24, true);
  const numSt = view.getInt32(28, true);
  const numTris = view.getInt32(32, true);
  const numGlcmds = view.getInt32(36, true);
  const numFrames = view.getInt32(40, true);
  const ofsSkins = view.getInt32(44, true);
  const ofsSt = view.getInt32(48, true);
  const ofsTris = view.getInt32(52, true);
  const ofsFrames = view.getInt32(56, true);
  const ofsGlcmds = view.getInt32(60, true);
  const ofsEnd = view.getInt32(64, true);
  if (skinWidth <= 0 || skinHeight <= 0 || skinWidth > 4096 || skinHeight > 4096) {
    Com_Error('fatal', `parseMD2: bad skin dimensions ${skinWidth}x${skinHeight}`);
  }
  if (numSkins < 0 || numSkins > MD2_MAX_SKINS) Com_Error('fatal', `parseMD2: bad skin count ${numSkins}`);
  if (numVerts <= 0 || numVerts > MD2_MAX_VERTS) Com_Error('fatal', `parseMD2: bad vert count ${numVerts}`);
  if (numSt <= 0 || numSt > MD2_MAX_VERTS * 2) Com_Error('fatal', `parseMD2: bad st count ${numSt}`);
  if (numTris <= 0 || numTris > MD2_MAX_TRIS) Com_Error('fatal', `parseMD2: bad tri count ${numTris}`);
  if (numGlcmds < 0 || numGlcmds > 1 << 20) Com_Error('fatal', `parseMD2: bad glcmd count ${numGlcmds}`);
  if (numFrames <= 0 || numFrames > MD2_MAX_FRAMES) {
    Com_Error('fatal', `parseMD2: bad frame count ${numFrames}`);
  }
  if (framesize !== MD2_FRAME_HEADER_SIZE + numVerts * MD2_VERT_SIZE) {
    Com_Error('fatal', `parseMD2: bad framesize ${framesize}`);
  }
  // Offsets must be ordered skin → st → tris → frames → glcmds → end.
  const ofsets = [ofsSkins, ofsSt, ofsTris, ofsFrames, ofsGlcmds, ofsEnd];
  for (let i = 0; i < ofsets.length; i++) {
    if (ofsets[i]! < MD2_HEADER_SIZE || ofsets[i]! > buf.byteLength) {
      Com_Error('fatal', `parseMD2: offset ${i} out of range`);
    }
    if (i > 0 && ofsets[i]! < ofsets[i - 1]!) Com_Error('fatal', 'parseMD2: offsets out of order');
  }
  const end = (off: number, size: number, what: string): void => {
    if (off + size > buf.byteLength) Com_Error('fatal', `parseMD2: ${what} overruns file`);
  };
  end(ofsSkins, numSkins * MD2_SKINNAME_SIZE, 'skins');
  end(ofsSt, numSt * 4, 'st');
  end(ofsTris, numTris * 12, 'tris');
  end(ofsFrames, numFrames * framesize, 'frames');
  end(ofsGlcmds, numGlcmds * 4, 'glcmds');
  const skins: string[] = new Array(numSkins);
  for (let i = 0; i < numSkins; i++) skins[i] = readName(bytes, ofsSkins + i * MD2_SKINNAME_SIZE, MD2_SKINNAME_SIZE);
  const st = new Int16Array(numSt * 2);
  for (let i = 0; i < numSt; i++) {
    st[i * 2] = view.getInt16(ofsSt + i * 4, true);
    st[i * 2 + 1] = view.getInt16(ofsSt + i * 4 + 2, true);
  }
  const trisXyz = new Uint16Array(numTris * 3);
  const trisSt = new Uint16Array(numTris * 3);
  for (let i = 0; i < numTris; i++) {
    const base = ofsTris + i * 12;
    for (let k = 0; k < 3; k++) {
      const vx = view.getInt16(base + k * 2, true);
      const tx = view.getInt16(base + 6 + k * 2, true);
      if (vx < 0 || vx >= numVerts) Com_Error('fatal', `parseMD2: tri ${i} vert index out of range`);
      if (tx < 0 || tx >= numSt) Com_Error('fatal', `parseMD2: tri ${i} st index out of range`);
      trisXyz[i * 3 + k] = vx;
      trisSt[i * 3 + k] = tx;
    }
  }
  const frames = new Float32Array(numFrames * numVerts * 3);
  const normals = new Uint8Array(numFrames * numVerts);
  const frameNames: string[] = new Array(numFrames);
  const scales = new Float32Array(numFrames * 3);
  const translates = new Float32Array(numFrames * 3);
  for (let f = 0; f < numFrames; f++) {
    const base = ofsFrames + f * framesize;
    const sx = view.getFloat32(base, true);
    const sy = view.getFloat32(base + 4, true);
    const sz = view.getFloat32(base + 8, true);
    const tx = view.getFloat32(base + 12, true);
    const ty = view.getFloat32(base + 16, true);
    const tz = view.getFloat32(base + 20, true);
    scales[f * 3] = sx;
    scales[f * 3 + 1] = sy;
    scales[f * 3 + 2] = sz;
    translates[f * 3] = tx;
    translates[f * 3 + 1] = ty;
    translates[f * 3 + 2] = tz;
    frameNames[f] = readName(bytes, base + 24, MD2_FRAME_NAME_SIZE);
    const vbase = base + MD2_FRAME_HEADER_SIZE;
    for (let v = 0; v < numVerts; v++) {
      const o = vbase + v * MD2_VERT_SIZE;
      frames[(f * numVerts + v) * 3] = bytes[o]! * sx + tx;
      frames[(f * numVerts + v) * 3 + 1] = bytes[o + 1]! * sy + ty;
      frames[(f * numVerts + v) * 3 + 2] = bytes[o + 2]! * sz + tz;
      normals[f * numVerts + v] = bytes[o + 3]!;
    }
  }
  return {
    skinWidth, skinHeight, numFrames, numVerts, numSt, numTris, numSkins, numGlcmds,
    skins, st, trisXyz, trisSt, frames, normals, frameNames, scales, translates,
  };
}

/** Read a NUL-terminated ASCII name out of a fixed-width field. */
function readName(bytes: Uint8Array, start: number, len: number): string {
  let end = start;
  const stop = start + len;
  while (end < stop && bytes[end] !== 0) end++;
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** WAL header size in bytes: 32 name + 2 u32 + 4 u32 offsets + 32 anim + 3 i32. */
export const WAL_HEADER_SIZE = 100;
/** Mip levels stored in every .wal (id MIPLEVELS). */
export const WAL_MIP_LEVELS = 4;

/**
 * Parse a .wal texture (miptex_t). Returns 4 mip levels of palette indices;
 * mip k has dimensions (w>>k) x (h>>k), matching R_LoadWal's contiguous copy.
 */
export function parseWAL(buf: ArrayBuffer): Wal {
  if (buf.byteLength < WAL_HEADER_SIZE) Com_Error('fatal', 'parseWAL: too small for header');
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const name = readName(bytes, 0, 32);
  const width = view.getUint32(32, true);
  const height = view.getUint32(36, true);
  if (width === 0 || height === 0) Com_Error('fatal', `parseWAL: bad dimensions ${width}x${height}`);
  if (width > 4096 || height > 4096) Com_Error('fatal', `parseWAL: dimensions out of range ${width}x${height}`);
  const offsets: number[] = [0, 0, 0, 0];
  for (let k = 0; k < WAL_MIP_LEVELS; k++) offsets[k] = view.getUint32(40 + k * 4, true);
  const animname = readName(bytes, 56, 32);
  const flags = view.getInt32(88, true);
  const contents = view.getInt32(92, true);
  const value = view.getInt32(96, true);
  const area = width * height;
  const mips: Uint8Array[] = new Array(WAL_MIP_LEVELS);
  for (let k = 0; k < WAL_MIP_LEVELS; k++) {
    const size = Math.floor(area / (1 << (2 * k)));
    const off = offsets[k];
    if (off < WAL_HEADER_SIZE || off + size > buf.byteLength) {
      Com_Error('fatal', `parseWAL: mip ${k} out of range`);
    }
    mips[k] = bytes.slice(off, off + size);
  }
  return { name, width, height, mips, animname, flags, contents, value };
}

/** PCX magic values (pcx_t in qcommon/qfiles.h). */
export const PCX_MANUFACTURER = 0x0a;
export const PCX_VERSION = 5;
export const PCX_ENCODING_RLE = 1;
export const PCX_HEADER_SIZE = 128;
/** Trailing palette marker for 256-color PCX files, then 768 RGB bytes. */
export const PCX_PALETTE_MARKER = 0x0c;
export const PCX_PALETTE_SIZE = 768;

/**
 * Parse an 8-bit RLE PCX (ref_soft LoadPCX). Decodes exactly width*height
 * pixels; the palette is the trailing 768 bytes (id copies the tail
 * unconditionally, and 256-color files prefix it with a 0x0C marker).
 */
export function parsePCX(buf: ArrayBuffer): Pcx {
  if (buf.byteLength < PCX_HEADER_SIZE + PCX_PALETTE_SIZE) {
    Com_Error('fatal', 'parsePCX: too small for header + palette');
  }
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  if (bytes[0] !== PCX_MANUFACTURER) Com_Error('fatal', 'parsePCX: bad manufacturer');
  if (bytes[1] !== PCX_VERSION) Com_Error('fatal', 'parsePCX: bad version');
  if (bytes[2] !== PCX_ENCODING_RLE) Com_Error('fatal', 'parsePCX: bad encoding');
  if (bytes[3] !== 8) Com_Error('fatal', 'parsePCX: bad bits per pixel');
  if (bytes[65] !== 1) Com_Error('fatal', 'parsePCX: bad color planes');
  const xmin = view.getUint16(4, true);
  const ymin = view.getUint16(6, true);
  const xmax = view.getUint16(8, true);
  const ymax = view.getUint16(10, true);
  if (xmax < xmin || ymax < ymin) Com_Error('fatal', 'parsePCX: bad dimensions');
  const width = xmax - xmin + 1;
  const height = ymax - ymin + 1;
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
    Com_Error('fatal', `parsePCX: dimensions out of range ${width}x${height}`);
  }
  const pixels = new Uint8Array(width * height);
  let pos = PCX_HEADER_SIZE;
  let p = 0;
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      if (pos >= buf.byteLength) Com_Error('fatal', 'parsePCX: truncated pixel data');
      const b = bytes[pos++];
      let run: number;
      let v: number;
      if ((b & 0xc0) === 0xc0) {
        run = b & 0x3f;
        if (run === 0) Com_Error('fatal', 'parsePCX: zero run length');
        if (pos >= buf.byteLength) Com_Error('fatal', 'parsePCX: truncated run');
        v = bytes[pos++];
      } else {
        run = 1;
        v = b;
      }
      if (x + run > width) Com_Error('fatal', 'parsePCX: run overruns scanline');
      for (let k = 0; k < run; k++) pixels[p++] = v;
      x += run;
    }
  }
  if (buf.byteLength - pos < PCX_PALETTE_SIZE) Com_Error('fatal', 'parsePCX: missing palette');
  if (bytes[buf.byteLength - PCX_PALETTE_SIZE - 1] !== PCX_PALETTE_MARKER) {
    Com_Warn('parsePCX: missing 0x0C palette marker, using trailing 768 bytes');
  }
  const palette = bytes.slice(buf.byteLength - PCX_PALETTE_SIZE, buf.byteLength);
  return { width, height, pixels, palette };
}

/** Shade levels in id's colormap (VID_GRADES, 1 << VID_CBITS). */
export const COLORMAP_SHADES = 64;
/** Palette entries per shade level. */
export const COLORMAP_COLORS = 256;
/** Bytes of the shade table at the head of pics/colormap.pcx pixels. */
export const COLORMAP_SIZE = COLORMAP_SHADES * COLORMAP_COLORS;

/**
 * Extract the 64x256 shade table from a parsed colormap.pcx: the first
 * 16384 pixels index as table[(light >> 8) * 256 + texel], light 0 (row 0)
 * brightest with 2x overbright, row 63 darkest. Requires stride 256.
 */
export function extractColormap(pcx: Pcx): Uint8Array {
  if (pcx.width !== COLORMAP_COLORS) {
    Com_Error('fatal', `extractColormap: need width 256, got ${pcx.width}`);
  }
  if (pcx.pixels.length < COLORMAP_SIZE) Com_Error('fatal', 'extractColormap: pixels too small');
  return pcx.pixels.slice(0, COLORMAP_SIZE);
}

/**
 * Generate a 64x256 shade table from a 768-byte RGB palette by best-match
 * search. Fallback for when pics/colormap.pcx is missing; the engine
 * otherwise parses the lump directly.
 *
 * Reverse-engineered from id's colormap.pcx (87% byte-identical): shade row
 * L scales each channel by light/128 with light = 255 - 4*L (row 32 ~ 1.0,
 * row 0 ~ 2x overbright matching the renderer's x2 light modulate, row 63
 * near black), truncated to byte and clamped, then matched to the nearest
 * palette entry by squared RGB distance. Palette index 0 is never a match
 * target (all exact-black texels resolve to index 127 in id's table, and
 * every in-palette duplicate resolves to its lowest nonzero index), ties
 * keep the lowest index.
 */
export function buildColormap(palette: Uint8Array): Uint8Array {
  if (palette.length !== PCX_PALETTE_SIZE) {
    Com_Error('fatal', `buildColormap: need 768-byte palette, got ${palette.length}`);
  }
  const table = new Uint8Array(COLORMAP_SIZE);
  for (let level = 0; level < COLORMAP_SHADES; level++) {
    const light = 255 - level * 4;
    for (let i = 0; i < COLORMAP_COLORS; i++) {
      const tr = Math.min(255, (palette[i * 3] * light) >> 7);
      const tg = Math.min(255, (palette[i * 3 + 1] * light) >> 7);
      const tb = Math.min(255, (palette[i * 3 + 2] * light) >> 7);
      let best = 1;
      let bestDist = Infinity;
      for (let j = 1; j < COLORMAP_COLORS; j++) {
        const dr = palette[j * 3] - tr;
        const dg = palette[j * 3 + 1] - tg;
        const db = palette[j * 3 + 2] - tb;
        const d = dr * dr + dg * dg + db * db;
        if (d < bestDist) {
          bestDist = d;
          best = j;
        }
      }
      table[level * COLORMAP_COLORS + i] = best;
    }
  }
  return table;
}

/** Magic ident of a Quake II sprite: little-endian "IDS2". */
export const SP2_IDENT = 0x32534449;
export const SP2_VERSION = 2;
/** On-disk size of one dsprframe_t: 4 i32 + 64-byte name. */
export const SP2_FRAME_SIZE = 80;

/**
 * Parse an .sp2 sprite (dsprite_t). Numeric lump data stays in flat
 * typed arrays; frame art names are plain strings.
 */
export function parseSP2(buf: ArrayBuffer): Sp2 {
  if (buf.byteLength < 12) Com_Error('fatal', 'parseSP2: too small for header');
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (view.getInt32(0, true) !== SP2_IDENT) Com_Error('fatal', 'parseSP2: bad ident');
  const version = view.getInt32(4, true);
  if (version !== SP2_VERSION) Com_Error('fatal', `parseSP2: bad version ${version}`);
  const numframes = view.getInt32(8, true);
  if (numframes < 1 || numframes > 1024) Com_Error('fatal', `parseSP2: bad frame count ${numframes}`);
  if (buf.byteLength < 12 + numframes * SP2_FRAME_SIZE) Com_Error('fatal', 'parseSP2: truncated frames');
  const widths = new Int32Array(numframes);
  const heights = new Int32Array(numframes);
  const originX = new Int32Array(numframes);
  const originY = new Int32Array(numframes);
  const names: string[] = new Array(numframes);
  for (let i = 0; i < numframes; i++) {
    const base = 12 + i * SP2_FRAME_SIZE;
    widths[i] = view.getInt32(base, true);
    heights[i] = view.getInt32(base + 4, true);
    originX[i] = view.getInt32(base + 8, true);
    originY[i] = view.getInt32(base + 12, true);
    names[i] = readName(bytes, base + 16, 64);
    if (widths[i] <= 0 || heights[i] <= 0) Com_Error('fatal', `parseSP2: bad frame dimensions ${i}`);
  }
  return { version, widths, heights, originX, originY, names };
}

/**
 * Parse a .wav header (client/snd_mem.c GetWavinfo): RIFF/WAVE with a PCM
 * fmt chunk, optional cue chunk for loopstart, and a data chunk. Returns
 * header facts only; sample bytes stay in the caller's buffer at dataOffset.
 */
export function parseWavHeader(buf: ArrayBuffer): WavInfo {
  const bytes = new Uint8Array(buf);
  if (buf.byteLength < 12) Com_Error('fatal', 'parseWavHeader: too small for RIFF header');
  const tag = (o: number): string =>
    String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') Com_Error('fatal', 'parseWavHeader: missing RIFF/WAVE');
  const view = new DataView(buf);
  const findChunk = (id: string, from: number): number => {
    let o = from;
    while (o + 8 <= buf.byteLength) {
      const len = view.getUint32(o + 4, true);
      if (tag(o) === id) return o;
      o += 8 + len + (len & 1);
    }
    return -1;
  };
  const fmt = findChunk('fmt ', 12);
  if (fmt < 0) Com_Error('fatal', 'parseWavHeader: missing fmt chunk');
  if (view.getUint32(fmt + 4, true) < 16 || fmt + 24 > buf.byteLength) {
    Com_Error('fatal', 'parseWavHeader: truncated fmt chunk');
  }
  if (view.getUint16(fmt + 8, true) !== 1) Com_Error('fatal', 'parseWavHeader: Microsoft PCM format only');
  const channels = view.getUint16(fmt + 10, true);
  const rate = view.getUint32(fmt + 12, true);
  const width = view.getUint16(fmt + 22, true) / 8;
  if (width !== 1 && width !== 2) Com_Error('fatal', `parseWavHeader: bad sample width ${width}`);
  let loopstart = -1;
  let loopSamples = 0;
  const cue = findChunk('cue ', 12);
  if (cue >= 0 && view.getUint32(cue + 4, true) >= 28 && cue + 36 <= buf.byteLength) {
    // id reads the first cue point's sample offset at chunk start + 32.
    loopstart = view.getInt32(cue + 32, true);
    const list = findChunk('LIST', cue);
    if (list >= 0 && list + 32 <= buf.byteLength && tag(list + 28) === 'mark') {
      loopSamples = loopstart + view.getInt32(list + 24, true);
    }
  }
  const data = findChunk('data', 12);
  if (data < 0) Com_Error('fatal', 'parseWavHeader: missing data chunk');
  const dataLen = view.getUint32(data + 4, true);
  const dataOffset = data + 8;
  if (dataOffset + dataLen > buf.byteLength) Com_Error('fatal', 'parseWavHeader: data chunk overruns buffer');
  // id divides by the sample width only (GetWavinfo quirk); stereo lumps are
  // rejected by the mixer, not here.
  const dataSamples = Math.floor(dataLen / Math.max(1, width));
  let samples = dataSamples;
  if (loopSamples > 0) {
    if (dataSamples < loopSamples) Com_Error('error', 'parseWavHeader: bad loop length');
    samples = loopSamples;
  }
  return { rate, width, channels, samples, loopstart, dataOffset };
}
