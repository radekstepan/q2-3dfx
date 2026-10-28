// @q2/sw-renderer bands — M8.1 SharedArrayBuffer banding (BRAIN.md §2 step 4).
//
// The framebuffer index + depth planes live in ONE SharedArrayBuffer split
// into N horizontal bands. Spanfill is partitioned by scanline row, so bands
// are independent: the same TS loop (spans.ts, reused op-for-op here) runs
// per band, either inline on the calling thread (sequential, always
// available) or in worker threads (bandPool.ts) operating directly on the
// shared views — zero copy, no per-frame allocation.
//
// Correctness argument: every write is depth-guarded (`iz > zb[o]`) and the
// subdivision chain is a pure function of the span gradients, so processing
// a row subset in any order — or re-processing it after a partial run —
// converges to the identical planes. Differential tests pin this.

import { Com_Error, getCVarNumber, registerCVar } from '@q2/config';
import {
  SPAN_OPAQUE, SPAN_TURBULENT, SPAN_FLAT, SUBDIV, SoftwareBackend, RGBWorldBackend,
  buildTurbTable,
  runSubdiv16, runSubdivTurbulent, runSpanFlat, sampleLightBlock, textureMasks,
  runSubdivRGBRepeat, runSubdivRGBClamp, runSubdivRGBGeneric, runSpanFlatRGB,
  rgbMipLevel,
  type LightBlock, type RasterBackend, type RGBLightmap, type RGBMaterial, type RGBMipLevel, type RGBWindow, type Span, type SpanList, type Texture,
} from './spans.js';
import { COLORMAP_SIZE } from './colormap.js';

/** Cvar gating the banded path. 0 = classic single buffer (default); N > 0 = N bands. */
export const SW_WORKERS_CVAR = 'sw_workers';
/**
 * Cvar gating frame-level batch accumulation (M8.1 async-render step 1):
 * 1 (default) coalesces a frame's ~10^3 per-surface batches into ONE pool
 * kick; 0 keeps the legacy per-batch dispatch. Output is identical either
 * way (same spans, same order, depth-guarded convergence).
 */
export const SW_ACCUM_CVAR = 'sw_accum';
/** Hard cap on bands/workers (control slots are preallocated for this many). */
export const MAX_WORKERS = 8;
/** Max packed spans per pool dispatch; larger batches use the inline path. */
export const MAX_BAND_SPANS = 4096;
/**
 * Batches shading fewer pixels than this stay inline: the pack + notify +
 * wait round-trip costs more than the per-pixel win on tiny batches (real
 * frames issue ~10^3 surface batches; the synth bench has one huge batch).
 */
export const MIN_BAND_PIXELS = 256;

// Flat-span field counts live in spans.ts (shared with edges.ts emission);
// re-exported here so pool callers keep a single import path.
import { F_PER_SPAN, I_PER_SPAN } from './spans.js';
export { F_PER_SPAN, I_PER_SPAN };

/** Surface texel / light-block staging caps (bytes) inside shared memory. */
export const TEX_CAP = 65536; // 256x256, matches vd_maxtexsize
export const LIGHT_CAP = 65536;
const TURB_SIZE = 1024;

// --- control block (Int32Array) ---

export const CTL_SEQ = 0; // job generation; -1 = shutdown
export const CTL_COUNT = 1; // packed spans in this job
export const CTL_TEXW = 2;
export const CTL_TEXH = 3;
export const CTL_LIGHTW = 4;
export const CTL_LIGHTH = 5;
export const CTL_WSHIFT = 6;
export const CTL_WMASK = 7;
export const CTL_HMASK = 8;
export const CTL_TURBPHASE = 9;
export const CTL_FBW = 10;
export const CTL_FBH = 11;
export const CTL_DONE = 12; // workers completed for the current seq
export const CTL_PIXELS = 13; // base; +MAX_WORKERS per-worker pixel counts
export const CTL_SPANS = CTL_PIXELS + MAX_WORKERS; // base; +MAX_WORKERS span counts
export const CTL_READY = CTL_SPANS + MAX_WORKERS; // workers entered the wait loop
export const CTL_FCOUNT = CTL_READY + 1; // frame-accum descriptors for the current kick (0 = single-batch job)
export const CTL_JOB = CTL_FCOUNT + 1; // kick type: 0 = rasterise, 1 = resolve (palette expand), 2 = RGB raster
export const CTL_FRAME = CTL_JOB + 1; // frame generation (lazy per-band clear)
export const CTL_RGBCOUNT = CTL_FRAME + 1; // RGB descriptors for the current kick (JOB_RGB only)
export const CTL_LEN = CTL_RGBCOUNT + 1;

/** Kick types for CTL_JOB ( rasterise spans vs resolve the color plane vs RGB rasterise). */
export const JOB_RASTER = 0;
export const JOB_RESOLVE = 1;
/**
 * RGB raster kick (PERF-2 RGB workers): every RGB descriptor staged this
 * frame, drained by all bands in order. Workers write the shared RGB
 * planes (rgb565/cover/rgbDepth); the main thread adopts the same views,
 * so the serial clear in beginFrame + seed/composite stay valid. Output is
 * bit-identical to the inline banded RGB path: bands are disjoint row
 * ranges, descriptors run sequentially in pack order within a band, every
 * write is depth-guarded, and dither/LOD use absolute screen coords.
 */
export const JOB_RGB = 2;
/**
 * Voodoo scanout kick (Track A parallel scanout): fused pack→recon→gamma
 * over the shared color plane into shared scanout buffers. Bands are
 * disjoint row ranges; the halo row for 2x2 reconstruction is packed locally
 * per band (no cross-band barrier), inputs are immutable for the kick,
 * outputs are disjoint, dither uses absolute screen coords. Byte-identical
 * to the serial voodoo resolveFusedFrame.
 */
export const JOB_SCANOUT = 3;

/** Clamped worker/band count requested by the operator (0 = classic path). */
export function workersRequestedByCvar(): number {
  try {
    registerCVar(SW_WORKERS_CVAR, 0, 'banded SAB spanfill: N horizontal bands (M8.1, default 0 = single-threaded)');
    const n = Math.floor(getCVarNumber(SW_WORKERS_CVAR));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(n, MAX_WORKERS);
  } catch {
    return 0;
  }
}

/** True when per-surface batches should coalesce into one frame kick. */
export function accumRequestedByCvar(): boolean {
  try {
    registerCVar(SW_ACCUM_CVAR, 1, 'coalesce frame span batches into one pool kick (M8.1, default 1 = on)');
    return getCVarNumber(SW_ACCUM_CVAR) !== 0;
  } catch {
    return true;
  }
}

let sabMemo: boolean | null = null;

/** True when this runtime can share pixels between threads. Never throws. */
export function sabAvailable(): boolean {
  if (sabMemo !== null) return sabMemo;
  try {
    const sab = new SharedArrayBuffer(8);
    sabMemo = sab.byteLength === 8;
  } catch {
    sabMemo = false;
  }
  return sabMemo;
}

let waitMemo: boolean | null = null;

/**
 * True when the calling thread may block on shared memory (Node main
 * thread). Browsers throw on main-thread Atomics.wait, so the sync pool is
 * Node-only; browsers use the inline banded path (same hashes).
 */
export function syncWaitAllowed(): boolean {
  if (waitMemo !== null) return waitMemo;
  try {
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const r = Atomics.wait(flag, 0, 0, 0);
    waitMemo = r === 'timed-out' || r === 'ok' || r === 'not-equal';
  } catch {
    waitMemo = false;
  }
  return waitMemo;
}

export interface Band {
  y0: number;
  y1: number;
}

/** Even horizontal tiling of H rows into n bands (last band takes the rest). */
export function splitBands(h: number, n: number): Band[] {
  const count = Math.max(1, Math.min(Math.floor(n) || 1, MAX_WORKERS));
  const rows = Math.max(0, Math.floor(h));
  const out: Band[] = [];
  const base = Math.floor(rows / count);
  let y = 0;
  for (let i = 0; i < count; i++) {
    const extra = i === count - 1 ? rows - y : base;
    out.push({ y0: y, y1: y + extra });
    y += extra;
  }
  return out;
}

export interface BandLayout {
  total: number;
  idxOff: number;
  zbOff: number;
  texOff: number;
  lightOff: number;
  cmapOff: number;
  spansFOff: number;
  spansIOff: number;
  ctlOff: number;
}

/** Byte layout of one SAB holding planes + staging + packed spans + control. */
export function bandLayout(w: number, h: number): BandLayout {
  const n = Math.max(1, Math.floor(w) * Math.floor(h));
  const zbOff = (n + 3) & ~3;
  const texOff = zbOff + n * 4;
  const lightOff = texOff + TEX_CAP;
  const cmapOff = lightOff + LIGHT_CAP;
  const spansFOff = (cmapOff + COLORMAP_SIZE + 7) & ~7;
  const spansIOff = spansFOff + MAX_BAND_SPANS * F_PER_SPAN * 8;
  const ctlOff = spansIOff + MAX_BAND_SPANS * I_PER_SPAN * 4;
  const total = ctlOff + CTL_LEN * 4;
  return {
    total, idxOff: 0, zbOff, texOff, lightOff, cmapOff, spansFOff, spansIOff, ctlOff,
  };
}

/** Total SAB bytes for a W×H pool layout (planes + staging + control). */
export function bandTotal(w: number, h: number): number {
  return bandLayout(w, h).total;
}

/** Views over one band-layout SAB. turb is built once (deterministic). */
export interface BandViews {
  idx: Uint8Array;
  zb: Float32Array;
  texels: Uint8Array;
  light: Uint8Array;
  colormap: Uint8Array;
  turb: Uint8Array;
  spansF: Float64Array;
  spansI: Int32Array;
  ctl: Int32Array;
}

/** Attach typed views to a SAB sized by bandLayout(w, h). Throws on undersize. */
export function attachBandShared(sab: SharedArrayBuffer, w: number, h: number): { views: BandViews; ctl: Int32Array; layout: BandLayout } {
  const layout = bandLayout(w, h);
  if (sab.byteLength < layout.total) {
    Com_Error('drop', `attachBandShared: SAB ${sab.byteLength} < ${layout.total} for ${w}x${h}`);
  }
  const n = w * h;
  const views: BandViews = {
    idx: new Uint8Array(sab, layout.idxOff, n),
    zb: new Float32Array(sab, layout.zbOff, n),
    texels: new Uint8Array(sab, layout.texOff, TEX_CAP),
    light: new Uint8Array(sab, layout.lightOff, LIGHT_CAP),
    colormap: new Uint8Array(sab, layout.cmapOff, COLORMAP_SIZE),
    turb: buildTurbTable(),
    spansF: new Float64Array(sab, layout.spansFOff, MAX_BAND_SPANS * F_PER_SPAN),
    spansI: new Int32Array(sab, layout.spansIOff, MAX_BAND_SPANS * I_PER_SPAN),
    ctl: new Int32Array(sab, layout.ctlOff, CTL_LEN),
  };
  return { views, ctl: views.ctl, layout };
}

/** Allocate (or reuse) one SAB backing the index + depth planes. */
export function createBandBuffers(
  w: number, h: number, reuse: SharedArrayBuffer | null,
): { sab: SharedArrayBuffer; idx: Uint8Array; zb: Float32Array } {
  const need = bandLayout(w, h).total;
  const sab = reuse && reuse.byteLength >= need ? reuse : new SharedArrayBuffer(need);
  const n = w * h;
  return {
    sab,
    idx: new Uint8Array(sab, 0, n),
    zb: new Float32Array(sab, (n + 3) & ~3, n),
  };
}

// --- frame-level accumulation (M8.1 async-render step 1) ---
//
// Per-surface batches (~10^3/frame, most below MIN_BAND_PIXELS) Amdahl-bound
// the pool: 1806 kicks x (pack + notify + wait) with no single batch big
// enough to matter. The frame path packs every batch into bump-allocated
// regions of ONE SAB during geometry, then kicks ONCE; each worker drains
// the whole descriptor table for its band. Order is preserved (descriptors
// are sequential; bands are disjoint row ranges), so output is
// bit-identical to the per-batch path.

/** Max flat-packed spans per frame (measured worst base1 frame ~31K). */
export const MAX_FRAME_SPANS = 65536;
/** Bump-region caps for per-frame staged surface data (measured worst
 *  base1 frame ~1.9MB texels + 64KB light; the textured sky strip adds
 *  ~384KB and fits comfortably). */
export const FRAME_TEX_CAP = 4 * 1024 * 1024;
export const FRAME_LIGHT_CAP = 256 * 1024;
/** Max batch descriptors per frame kick (measured worst ~2K batches). */
export const MAX_FRAME_BATCHES = 2048;

/** Int32 fields per batch descriptor in the SAB table. */
export const D_SPAN_BASE = 0;
export const D_SPAN_COUNT = 1;
export const D_TEX_OFF = 2;
export const D_TEX_W = 3;
export const D_TEX_H = 4;
export const D_LIGHT_OFF = 5;
export const D_LIGHT_W = 6;
export const D_LIGHT_H = 7;
export const D_WSHIFT = 8;
export const D_WMASK = 9;
export const D_HMASK = 10;
export const D_TURBPHASE = 11;
export const D_PER_BATCH = 12;

/** Palette bytes staged for worker-side resolve (8-bit RGB palette). */
export const PALETTE_BYTES = 768;

export interface FrameAccumLayout {
  total: number;
  spansFOff: number;
  spansIOff: number;
  texOff: number;
  lightOff: number;
  descOff: number;
  colorOff: number;
  palOff: number;
}

/** Byte layout of the frame-accum regions appended after a bandLayout SAB. */
export function frameAccumLayout(w: number, h: number): FrameAccumLayout {
  const n = Math.max(1, Math.floor(w) * Math.floor(h));
  const base = (bandLayout(w, h).total + 7) & ~7;
  const spansFOff = base;
  const spansIOff = spansFOff + MAX_FRAME_SPANS * F_PER_SPAN * 8;
  const texOff = spansIOff + MAX_FRAME_SPANS * I_PER_SPAN * 4;
  const lightOff = texOff + FRAME_TEX_CAP;
  const descOff = lightOff + FRAME_LIGHT_CAP;
  const colorOff = (descOff + MAX_FRAME_BATCHES * D_PER_BATCH * 4 + 3) & ~3;
  const palOff = colorOff + n * 4;
  const total = palOff + PALETTE_BYTES;
  return { total, spansFOff, spansIOff, texOff, lightOff, descOff, colorOff, palOff };
}

/** Total SAB bytes for a pool backing planes + frame-accum regions. */
export function frameAccumTotal(w: number, h: number): number {
  return frameAccumLayout(w, h).total;
}

export interface FrameAccumViews {
  base: BandViews;
  ctl: Int32Array;
  fSpansF: Float64Array;
  fSpansI: Int32Array;
  fTex: Uint8Array;
  fLight: Uint8Array;
  desc: Int32Array;
  /** Shared 0xAABBGGRR color plane (worker-resolved, adopted by the renderer). */
  fColor: Uint32Array;
  /** Staged palette (768 RGB bytes) for worker-side resolve. */
  fPal: Uint8Array;
}

/** Attach frame-accum views to a SAB sized by frameAccumTotal(w, h). */
export function attachFrameAccum(
  sab: SharedArrayBuffer, w: number, h: number,
): { views: FrameAccumViews; ctl: Int32Array } {
  const n = Math.max(1, Math.floor(w) * Math.floor(h));
  const layout = frameAccumLayout(w, h);
  if (sab.byteLength < layout.total) {
    Com_Error('drop', `attachFrameAccum: SAB ${sab.byteLength} < ${layout.total} for ${w}x${h}`);
  }
  const { views, ctl } = attachBandShared(sab, w, h);
  return {
    views: {
      base: views,
      ctl,
      fSpansF: new Float64Array(sab, layout.spansFOff, MAX_FRAME_SPANS * F_PER_SPAN),
      fSpansI: new Int32Array(sab, layout.spansIOff, MAX_FRAME_SPANS * I_PER_SPAN),
      fTex: new Uint8Array(sab, layout.texOff, FRAME_TEX_CAP),
      fLight: new Uint8Array(sab, layout.lightOff, FRAME_LIGHT_CAP),
      desc: new Int32Array(sab, layout.descOff, MAX_FRAME_BATCHES * D_PER_BATCH),
      fColor: new Uint32Array(sab, layout.colorOff, n),
      fPal: new Uint8Array(sab, layout.palOff, PALETTE_BYTES),
    },
    ctl,
  };
}

// --- RGB worker staging (PERF-2 RGB workers) --------------------------------
//
// World RGB batches (opaque/turbulent world spans, textured skybox faces,
// flat sky fills) are staged per frame into these SAB regions and drained by
// ONE worker kick (JOB_RGB), in descriptor order per band. Foreground RGB
// (alias, sprites, particles, tracers, translucent alpha) stays inline on
// the calling thread after the kick (same ordering rule as the indexed
// foreground deferral), so this staging covers exactly the serial DRAW bulk.
//
// Staging (main thread, per frame):
// - Spans: copied from the emitted SpanList slice into rgbSpansF/I (a
//   private bump region — never aliased with the indexed fSpansF/I, whose
//   bump counters reset on indexed flushes mid-frame).
// - Chains: each used RGBMaterial's mip levels copied ONCE per frame into
//   the chain bump region (deduped by the stager via chain identity), with a
//   directory entry per chain + per-level (offset, w, h). Base1's working
//   set (~2.4MB) fits RGB_CHAIN_CAP with headroom; overflow falls back to
//   the inline path (identical output).
// - Luxels: per-batch RGB luxel blocks copied into the lux bump region.
// - Descriptors: one fixed-size record per batch (span range, chain slot,
//   luxel range, packed flags). Only repeat/clamp-addressed opaque materials
//   are staged (the world + sky materials); anything else runs inline.
// Workers resolve chain levels as subarray views (no copy) and run the same
// subdiv cores as the serial path (runSubdivRGBRepeat/Clamp/Generic,
// runSpanFlatRGB) with absolute screen coords, so dither phase, LOD,
// band seams and same-row order are bit-identical to serial.
//
// Planes (rgb565/cover/rgbDepth) live in the SAB when pooled (adopted by
// the renderer like idx/zb/color) and are cleared serially in beginFrame —
// no lazy-clear generation protocol, no worker-side clearing.

/** Bump-region cap for per-frame staged RGB mip chains (base1 ~2.4MB
 * world + ~2MB skybox strip; the packed sky strip is the in-engine case
 * the indexed path refuses to stage — RGB stages it, so the cap covers
 * both with headroom. Overflow falls back to the inline path). */
export const RGB_CHAIN_CAP = 8 * 1024 * 1024;
/** Bump-region cap for per-frame staged RGB luxel blocks (live frames). */
export const RGB_LUX_CAP = 2 * 1024 * 1024;
/** Max RGB batches staged per frame kick (live gameplay opens more surfaces than frozen benchmarks). */
export const MAX_RGB_BATCHES = 4096;
/** Max chains addressable per frame (directory). */
export const RGB_MAX_CHAINS = 256;
/** Max mip levels addressable per frame (level table). */
export const RGB_MAX_LEVELS = 2048;

/** Int32 fields per RGB batch descriptor. */
export const R_SPAN_BASE = 0; // base into rgbSpansF/I
export const R_SPAN_COUNT = 1; // packed span count
export const R_CHAIN = 2; // chain directory slot
export const R_LUX_OFF = 3; // byte offset into the lux region
export const R_LUX_W = 4;
export const R_LUX_H = 5;
export const R_FLAGS = 6; // bitmask (see R_FLAG_* below)
export const R_ZBITS = 7;
export const R_TURBPHASE = 8;
export const R_FLATRGB = 9; // packed 0xRRGGBB (valid when R_FLAG_FLAT)
export const R_YMIN = 10; // inclusive min span row (band-cull, PERF-5)
export const R_YMAX = 11; // exclusive max span row (band-cull, PERF-5)
export const R_PER_BATCH = 12;

/** R_FLAGS bits. */
export const R_FLAG_WARP = 1; // turbulent water (generic effect path)
export const R_FLAG_BILINEAR = 2; // vd_bilinear point-sample off when clear
export const R_FLAG_MIPDITHER = 4; // single-TMU mip dithering
export const R_FLAG_OVERBRIGHT = 8; // x2 modulate + clamp
export const R_FLAG_DEPTHWRITE = 16; // depth writes (always set for staged)
/** Addressing is repeat (world); clear = clamp (skybox). */
export const R_FLAG_REPEAT = 32;
/** Staged batch carries an RGB luxel block (clear = unlit, e.g. sky). */
export const R_FLAG_LIGHT = 64;
/** SPAN_FLAT solid fill (flatColor in R_FLATRGB). */
export const R_FLAG_FLAT = 128;

/** Int32 fields per chain directory entry. */
export const C_LEVEL_BASE = 0; // base into the level table
export const C_LEVEL_COUNT = 1;
export const C_PER_CHAIN = 2;

/** Int32 fields per level table entry. */
export const L_DATA_OFF = 0; // byte offset of RGB triplets in the chain region
export const L_MASK_OFF = 1; // byte offset of the opacity mask in the chain region
export const L_W = 2;
export const L_H = 3;
export const L_PER_LEVEL = 4;

/** Max flat-packed RGB spans per frame (mirrors MAX_FRAME_SPANS; live frames exceed frozen-benchmark counts). */
export const MAX_RGB_SPANS = 131072;

/** Scanout kick params (Float64, shared): gamma, dither, ditherMode, postfilter,
 *  reconmode, maxR, maxG, maxB, quantise. RGB kicks reuse [0..2] only. */
export const SCAN_KICK_LEN = 16;

export interface RGBAccumLayout {
  total: number;
  rgb565Off: number;
  coverOff: number;
  rgbDepthOff: number;
  spansFOff: number;
  spansIOff: number;
  chainOff: number;
  chainDirOff: number;
  levelOff: number;
  luxOff: number;
  rgbDescOff: number;
  kickOff: number; // Float64 kick params (RGB: near, far, lodBias; scanout: 9 params)
  scan565Off: number; // shared 565 scanout target (Track A)
  scanDisplayOff: number; // shared display scanout plane (Track A)
}

/** Byte layout of the RGB worker regions appended after frameAccumTotal. */
export function rgbAccumLayout(w: number, h: number): RGBAccumLayout {
  const n = Math.max(1, Math.floor(w) * Math.floor(h));
  const base = (frameAccumTotal(w, h) + 7) & ~7;
  const rgb565Off = base;
  const coverOff = rgb565Off + n * 2;
  const rgbDepthOff = (coverOff + n + 1) & ~1;
  const spansFOff = (rgbDepthOff + n * 2 + 7) & ~7;
  const spansIOff = spansFOff + MAX_RGB_SPANS * F_PER_SPAN * 8;
  const chainOff = spansIOff + MAX_RGB_SPANS * I_PER_SPAN * 4;
  const chainDirOff = chainOff + RGB_CHAIN_CAP;
  const levelOff = chainDirOff + RGB_MAX_CHAINS * C_PER_CHAIN * 4;
  const luxOff = levelOff + RGB_MAX_LEVELS * L_PER_LEVEL * 4;
  const rgbDescOff = luxOff + RGB_LUX_CAP;
  const kickOff = (rgbDescOff + MAX_RGB_BATCHES * R_PER_BATCH * 4 + 7) & ~7;
  // Scanout buffers (Track A parallel scanout): shared 565 target + display
  // plane. The shell adopts these when pooled so workers write the presented
  // frame directly (zero copy); the serial path ignores them.
  const scan565Off = (kickOff + SCAN_KICK_LEN * 8 + 7) & ~7;
  const scanDisplayOff = (scan565Off + n * 2 + 7) & ~7;
  const total = scanDisplayOff + n * 4;
  return {
    total, rgb565Off, coverOff, rgbDepthOff, spansFOff, spansIOff,
    chainOff, chainDirOff, levelOff, luxOff, rgbDescOff, kickOff,
    scan565Off, scanDisplayOff,
  };
}

/** Total SAB bytes for a pool backing planes + frame-accum + RGB regions. */
export function rgbAccumTotal(w: number, h: number): number {
  return rgbAccumLayout(w, h).total;
}

export interface RGBAccumViews {
  rgb565: Uint16Array;
  cover: Uint8Array;
  rgbDepth: Uint16Array;
  spansF: Float64Array;
  spansI: Int32Array;
  chainData: Uint8Array;
  chainDir: Int32Array;
  levelTab: Int32Array;
  lux: Uint8Array;
  rgbDesc: Int32Array;
  /** Per-kick float params (RGB: near/far/lodBias; scanout: 9 params, len 16). */
  kick: Float64Array;
  /** Shared 565 scanout target (Track A parallel scanout). */
  scan565: Uint16Array;
  /** Shared display scanout plane (Track A parallel scanout). */
  scanDisplay: Uint32Array;
}

/** Attach RGB worker views to a SAB sized by rgbAccumTotal(w, h). */
export function attachRGBAccum(
  sab: SharedArrayBuffer, w: number, h: number,
): { views: RGBAccumViews } {
  const n = Math.max(1, Math.floor(w) * Math.floor(h));
  const layout = rgbAccumLayout(w, h);
  if (sab.byteLength < layout.total) {
    Com_Error('drop', `attachRGBAccum: SAB ${sab.byteLength} < ${layout.total} for ${w}x${h}`);
  }
  return {
    views: {
      rgb565: new Uint16Array(sab, layout.rgb565Off, n),
      cover: new Uint8Array(sab, layout.coverOff, n),
      rgbDepth: new Uint16Array(sab, layout.rgbDepthOff, n),
      spansF: new Float64Array(sab, layout.spansFOff, MAX_RGB_SPANS * F_PER_SPAN),
      spansI: new Int32Array(sab, layout.spansIOff, MAX_RGB_SPANS * I_PER_SPAN),
      chainData: new Uint8Array(sab, layout.chainOff, RGB_CHAIN_CAP),
      chainDir: new Int32Array(sab, layout.chainDirOff, RGB_MAX_CHAINS * C_PER_CHAIN),
      levelTab: new Int32Array(sab, layout.levelOff, RGB_MAX_LEVELS * L_PER_LEVEL),
      lux: new Uint8Array(sab, layout.luxOff, RGB_LUX_CAP),
      rgbDesc: new Int32Array(sab, layout.rgbDescOff, MAX_RGB_BATCHES * R_PER_BATCH),
      kick: new Float64Array(sab, layout.kickOff, SCAN_KICK_LEN),
      scan565: new Uint16Array(sab, layout.scan565Off, n),
      scanDisplay: new Uint32Array(sab, layout.scanDisplayOff, n),
    },
  };
}

/** Serialize the raster-relevant spans of a batch into flat SAB staging. */
export function packBandSpans(
  list: SpanList, F: Float64Array, I: Int32Array,
): { count: number; est: number } | null {
  return packFrameSpans(list, F, I, 0, 0, MAX_BAND_SPANS);
}

/**
 * Offset-capable packer (single-batch and frame-accum share this loop, so
 * both pack paths produce identical flat data). Appends at (fBase, iBase),
 * refuses when the batch would exceed cap spans past the base. `start`
 * skips the first spans (RGB staging packs an emitted slice of the shared
 * pool); defaults to 0 (whole list, the indexed path).
 */
export function packFrameSpans(
  list: SpanList, F: Float64Array, I: Int32Array,
  fBase: number, iBase: number, cap: number, start = 0,
): { count: number; est: number } | null {
  const spans = list.spans;
  const total = list.count < spans.length ? list.count : spans.length;
  let p = 0;
  let est = 0;
  for (let i = start; i < total; i++) {
    const s = spans[i]!;
    if (s.kind !== SPAN_OPAQUE && s.kind !== SPAN_TURBULENT && s.kind !== SPAN_FLAT) continue;
    if (p >= cap) return null; // oversize -> inline fallback
    const o = (fBase + p) * F_PER_SPAN;
    F[o] = s.iz; F[o + 1] = s.diz; F[o + 2] = s.uz; F[o + 3] = s.duz;
    F[o + 4] = s.vz; F[o + 5] = s.dvz; F[o + 6] = s.light;
    F[o + 7] = s.dlight; F[o + 8] = s.lu; F[o + 9] = s.lv; F[o + 10] = s.dlu;
    // Vertical LOD footprint rides the flat copy (F_PER_SPAN = 13); the
    // indexed raster core below ignores [o+11, o+12] (horizontal-only LOD
    // there is unchanged), while the RGB path reads them per span.
    F[o + 11] = s.dudy; F[o + 12] = s.dvdy;
    const q = (iBase + p) * I_PER_SPAN;
    I[q] = s.kind; I[q + 1] = s.y; I[q + 2] = s.x0; I[q + 3] = s.x1; I[q + 4] = s.turb | 0;
    est += s.x1 - s.x0;
    p++;
  }
  return { count: p, est };
}

export interface BandJob {
  fbW: number; fbH: number;
  count: number;
  texW: number; texH: number; lightW: number; lightH: number;
  wshift: number; wmask: number; hmask: number;
  turbPhase: number;
  y0: number; y1: number;
}

/** Read the current job descriptor out of the control block. */
export function readBandJob(ctl: Int32Array, y0: number, y1: number): BandJob {
  return {
    fbW: ctl[CTL_FBW]!, fbH: ctl[CTL_FBH]!,
    count: ctl[CTL_COUNT]!,
    texW: ctl[CTL_TEXW]!, texH: ctl[CTL_TEXH]!,
    lightW: ctl[CTL_LIGHTW]!, lightH: ctl[CTL_LIGHTH]!,
    wshift: ctl[CTL_WSHIFT]!, wmask: ctl[CTL_WMASK]!, hmask: ctl[CTL_HMASK]!,
    turbPhase: ctl[CTL_TURBPHASE]!,
    y0, y1,
  };
}

/** Publish a job descriptor into the control block (main side, pre-notify). */
export function writeBandJob(
  ctl: Int32Array, count: number,
  fbW: number, fbH: number,
  texW: number, texH: number, lightW: number, lightH: number,
  wshift: number, wmask: number, hmask: number, turbPhase: number,
): void {
  ctl[CTL_COUNT] = count;
  ctl[CTL_FBW] = fbW; ctl[CTL_FBH] = fbH;
  ctl[CTL_TEXW] = texW; ctl[CTL_TEXH] = texH;
  ctl[CTL_LIGHTW] = lightW; ctl[CTL_LIGHTH] = lightH;
  ctl[CTL_WSHIFT] = wshift; ctl[CTL_WMASK] = wmask; ctl[CTL_HMASK] = hmask;
  ctl[CTL_TURBPHASE] = turbPhase;
}

// Reused per-job texture/light descriptors (workers are single-threaded;
// no allocation per batch). Mirrors the frame.ts texView/lightView pattern.
const jobTex: Texture = { width: 0, height: 0, texels: new Uint8Array(0) };
const jobLight: LightBlock = { width: 1, height: 1, values: new Uint8Array(0) };

/**
 * Shared packed-span raster core: draws flat spans [start, start+count) of
 * one (tex, light) setup into the [y0, y1) band. Setup math mirrors
 * drawSpansSoftware/drawSpansTurbulent op-for-op (same imports, same order);
 * the y-range filter is the only addition, so output is bit-identical to
 * the single-threaded path restricted to the band. Used by processBandJob
 * (one packed batch) and processFrameJob (one descriptor of a frame kick).
 */
export function rasterizePackedRange(
  idx: Uint8Array, zb: Float32Array, fbW: number, fbH: number,
  spansF: Float64Array, spansI: Int32Array, start: number, count: number,
  tex: Texture, light: LightBlock,
  wshift: number, wmask: number, hmask: number,
  colormap: Uint8Array, turbTable: Uint8Array, turbPhase: number,
  y0: number, y1: number,
): { pixels: number; spans: number } {
  const tmask = turbTable.length - 1;
  let pixels = 0;
  let drawn = 0;
  for (let i = start; i < start + count; i++) {
    const q = i * I_PER_SPAN;
    const kind = spansI[q]!;
    const y = spansI[q + 1]!;
    const origX0 = spansI[q + 2]!;
    const origX1 = spansI[q + 3]!;
    const turb = spansI[q + 4]!;
    if (kind !== SPAN_OPAQUE && kind !== SPAN_TURBULENT && kind !== SPAN_FLAT) continue;
    if (y < y0 || y >= y1) continue;
    if (y < 0 || y >= fbH) continue;
    let x0 = origX0, x1 = origX1;
    if (x0 < 0) x0 = 0;
    if (x1 > fbW) x1 = fbW;
    const n = x1 - x0;
    if (n <= 0) continue;
    const o = i * F_PER_SPAN;
    const diz = spansF[o + 1]!;
    const duz = spansF[o + 3]!;
    const dvz = spansF[o + 5]!;
    const skip = x0 - origX0;
    let iz = spansF[o]! + diz * skip;
    let uz = spansF[o + 2]! + duz * skip;
    let vz = spansF[o + 4]! + dvz * skip;
    const dlight = spansF[o + 7]!;
    const lu = spansF[o + 8]!;
    const lv = spansF[o + 9]!;
    const dlu = spansF[o + 10]!;
    if (kind === SPAN_FLAT) {
      // Flat fill: palette color rides F[o+6] (frame.ts stores the sky
      // index in s.light); no texture or light state is touched.
      runSpanFlat(idx, zb, y * fbW + x0, n, iz, diz, (spansF[o + 6]! | 0) & 255);
      pixels += n;
      drawn++;
      continue;
    }
    if (kind === SPAN_OPAQUE) {
      let lz = spansF[o + 6]!;
      let dlz = dlight;
      if (lv >= 0) {
        const l0 = sampleLightBlock(light, lu, lv);
        const l1 = sampleLightBlock(light, lu + dlu * n, lv);
        lz = l0;
        dlz = (l1 - l0) / n;
      }
      let u0 = uz / iz, v0 = vz / iz;
      let oo = y * fbW + x0;
      let remaining = n;
      while (remaining > 0) {
        const m = remaining >= 16 ? 16 : remaining;
        const r = runSubdiv16(idx, zb, oo, m, iz, diz, uz, duz, vz, dvz,
          u0, v0, lz, dlz, tex.texels, wshift, wmask, hmask, colormap);
        iz = r.iz; lz = r.light;
        uz += duz * m; vz += dvz * m;
        u0 = r.u1; v0 = r.v1;
        oo += m; remaining -= m;
      }
    } else {
      let lz = spansF[o + 6]!;
      let u0 = uz / iz, v0 = vz / iz;
      let oo = y * fbW + x0;
      let remaining = n;
      const phase = (turbPhase + turb) & tmask;
      while (remaining > 0) {
        const m = remaining >= 16 ? 16 : remaining;
        const r = runSubdivTurbulent(idx, zb, oo, m, iz, diz, uz, duz, vz, dvz,
          u0, v0, lz, dlight, tex.texels, wshift, wmask, hmask,
          colormap, turbTable, phase);
        iz = r.iz; lz = r.light;
        uz += duz * m; vz += dvz * m;
        u0 = r.u1; v0 = r.v1;
        oo += m; remaining -= m;
      }
    }
    pixels += n;
    drawn++;
  }
  return { pixels, spans: drawn };
}

/**
 * Rasterise one band's share of a packed batch. Setup math mirrors
 * drawSpansSoftware/drawSpansTurbulent op-for-op (same imports, same order);
 * the y-range filter is the only addition, so output is bit-identical to
 * the single-threaded path restricted to [y0, y1).
 */
export function processBandJob(v: BandViews, job: BandJob): { pixels: number; spans: number } {
  const { idx, zb, spansF, spansI } = v;
  const { fbW, fbH, count } = job;
  jobTex.width = job.texW; jobTex.height = job.texH; jobTex.texels = v.texels;
  jobLight.width = job.lightW; jobLight.height = job.lightH; jobLight.values = v.light;
  const { wshift, wmask, hmask } = job;
  return rasterizePackedRange(
    idx, zb, fbW, fbH, spansF, spansI, 0, count,
    jobTex, jobLight, wshift, wmask, hmask,
    v.colormap, v.turb, job.turbPhase, job.y0, job.y1,
  );
}

// --- worker-side RGB raster core (PERF-2 RGB workers) ------------------------
//
// rasterizePackedRGBRange mirrors drawSpansRGB (spans.ts) op-for-op over
// flat-packed spans: same kind dispatch, clip, skip-adjusted perspective
// start, per-span LOD (rgbMipLevel over the packed dudy/dvdy), the same
// hot-opaque vs effect-path split, and the same subdiv cores with the same
// arguments. The ONLY additions are the y-range band filter and the
// material resolved from staged SAB data instead of a JS object — both
// provably output-neutral (bands partition rows; the material views alias
// the identical bytes). Differentially pinned vs the serial path
// (rgbWorkers.test.ts: worker kick vs inline banded vs serial).

/** Worker-resolved RGB material (views into SAB staging, no copies). */
export interface RGBWorkerMaterial {
  levels: RGBMipLevel[];
  light: RGBLightmap | null;
  overbright: boolean;
  lodBias: number;
  mipDither: boolean;
  bilinear: boolean;
  zbits: number;
  blend: 'opaque';
  alpha: number;
  warp: boolean;
  turbPhase: number;
  flatColor: Uint8Array | null;
  depthWrite: boolean;
  repeat: boolean;
}

/** Adapt a worker material to the shared RGBMaterial shape (subdiv input). */
export function workerMaterialToRGB(m: RGBWorkerMaterial): RGBMaterial {
  return {
    levels: m.levels,
    addressS: m.repeat ? 'repeat' : 'clamp',
    addressT: m.repeat ? 'repeat' : 'clamp',
    light: m.light,
    overbright: m.overbright,
    lodBias: m.lodBias,
    mipDither: m.mipDither,
    bilinear: m.bilinear,
    zbits: m.zbits,
    blend: m.blend,
    alpha: m.alpha,
    warp: m.warp,
    turbPhase: m.turbPhase,
    flatColor: m.flatColor,
    alphaTest: null,
    depthWrite: m.depthWrite,
  };
}

const rgbTurbTable = buildTurbTable();

/**
 * Draw one band's share of flat-packed RGB spans [start, start+count).
 * Mirrors drawSpansRGB exactly (same order, same args, same chaining).
 */
export function rasterizePackedRGBRange(
  rgb565: Uint16Array, cover: Uint8Array, rgbDepth: Uint16Array,
  fbW: number, fbH: number,
  spansF: Float64Array, spansI: Int32Array, start: number, count: number,
  mat: RGBMaterial,
  repeat: boolean,
  warp: boolean,
  turbPhase: number,
  winNear: number, winFar: number,
  y0: number, y1: number,
): { pixels: number; spans: number } {
  const levels = mat.levels;
  if (levels.length < 1) {
    Com_Error('error', 'rasterizePackedRGBRange: material has no mip levels');
  }
  const maxLevel = levels.length - 1;
  const win = matWin;
  win.near = winNear;
  win.far = winFar;
  let pixels = 0;
  let drawn = 0;
  for (let i = start; i < start + count; i++) {
    const q = i * I_PER_SPAN;
    const kind = spansI[q]!;
    const y = spansI[q + 1]!;
    const origX0 = spansI[q + 2]!;
    const origX1 = spansI[q + 3]!;
    const turb = spansI[q + 4]!;
    if (kind !== SPAN_OPAQUE && kind !== SPAN_TURBULENT && kind !== SPAN_FLAT) {
      Com_Error('error', 'rasterizePackedRGBRange: unsupported span kind in RGB worker kick');
    }
    if (y < y0 || y >= y1) continue;
    if (y < 0 || y >= fbH) continue;
    let x0 = origX0, x1 = origX1;
    if (x0 < 0) x0 = 0;
    if (x1 > fbW) x1 = fbW;
    const n = x1 - x0;
    if (n <= 0) continue;
    if (kind === SPAN_FLAT) {
      const fc = mat.flatColor;
      if (!fc) {
        Com_Error('error', 'rasterizePackedRGBRange: FLAT span without flatColor');
      }
      const o = i * F_PER_SPAN;
      runSpanFlatRGB(rgb565, cover, rgbDepth, y * fbW + x0, n,
        spansF[o]! + spansF[o + 1]! * (x0 - origX0), spansF[o + 1]!,
        fc[0]!, fc[1]!, fc[2]!, mat.depthWrite, win, mat.zbits);
      pixels += n;
      drawn++;
      continue;
    }
    const o = i * F_PER_SPAN;
    const sDiz = spansF[o + 1]!;
    const sDuz = spansF[o + 3]!;
    const sDvz = spansF[o + 5]!;
    const sDlu = spansF[o + 10]!;
    const skip = x0 - origX0;
    let iz = spansF[o]! + sDiz * skip;
    let uz = spansF[o + 2]! + sDuz * skip;
    let vz = spansF[o + 4]! + sDvz * skip;
    let lux = spansF[o + 8]! + sDlu * skip;
    const sLv = spansF[o + 9]!;
    let u0 = uz / iz, v0 = vz / iz;
    const sDudy = spansF[o + 11]!;
    const sDvdy = spansF[o + 12]!;
    const dudx = (sDuz - u0 * sDiz) / iz;
    const dvdx = (sDvz - v0 * sDiz) / iz;
    let rho = dudx < 0 ? -dudx : dudx;
    const avd = dvdx < 0 ? -dvdx : dvdx;
    if (avd > rho) rho = avd;
    const audy = sDudy < 0 ? -sDudy : sDudy;
    if (audy > rho) rho = audy;
    const avdy = sDvdy < 0 ? -sDvdy : sDvdy;
    if (avdy > rho) rho = avdy;
    const spanLod = rgbMipLevel(rho, mat.lodBias, maxLevel);
    const useWarp = kind === SPAN_TURBULENT && warp;
    let oo = y * fbW + x0;
    let remaining = n;
    let xRun = x0;
    if (!useWarp) {
      while (remaining > 0) {
        const m = remaining >= SUBDIV ? SUBDIV : remaining;
        let r: { iz: number; lux: number; u1: number; v1: number };
        if (repeat) {
          r = runSubdivRGBRepeat(
            rgb565, cover, rgbDepth, oo, m, xRun, y,
            iz, sDiz, uz, sDuz, vz, sDvz, u0, v0, lux, sDlu, sLv,
            mat, spanLod, maxLevel, win);
        } else {
          r = runSubdivRGBClamp(
            rgb565, cover, rgbDepth, oo, m, xRun, y,
            iz, sDiz, uz, sDuz, vz, sDvz, u0, v0, lux, sDlu, sLv,
            mat, spanLod, maxLevel, win);
        }
        iz = r.iz;
        lux = r.lux;
        uz += sDuz * m;
        vz += sDvz * m;
        u0 = r.u1;
        v0 = r.v1;
        oo += m;
        xRun += m;
        remaining -= m;
      }
    } else {
      const turbT = rgbTurbTable;
      while (remaining > 0) {
        const m = remaining >= SUBDIV ? SUBDIV : remaining;
        const r = runSubdivRGBGeneric(
          rgb565, cover, rgbDepth, oo, m, xRun, y,
          iz, sDiz, uz, sDuz, vz, sDvz, u0, v0, lux, sDlu, sLv,
          mat, spanLod, maxLevel, 'opaque', 256, turbT,
          (turbPhase + turb) & (turbT.length - 1),
          win);
        iz = r.iz;
        lux = r.lux;
        uz += sDuz * m;
        vz += sDvz * m;
        u0 = r.u1;
        v0 = r.v1;
        oo += m;
        xRun += m;
        remaining -= m;
      }
    }
    pixels += n;
    drawn++;
  }
  return { pixels, spans: drawn };
}

// --- Track A parallel scanout (banded fused pack→recon→gamma) --------------
//
// Byte-identical to voodoo resolveFusedFrame for the same options. Tables
// are recomputed with the same formulas as voodoo/bayer.ts (no import:
// sw-renderer must not depend on voodoo per deps:check). Dither uses
// absolute screen coords; bands write disjoint dst565/display rows; the one
// halo row needed by 2x2 reconstruction is packed locally per band (no
// cross-band barrier, no shared writes). Inputs are immutable for the kick.

export interface ScanoutBandOptions {
  gamma: number;
  dither: boolean;
  /** 0 = 4x4, 1 = 2x2 */
  ditherMode: number;
  postfilter: boolean;
  /** 0 = legacy, 1 = 2x2sub+2x2box, 2 = 4x4sub+4x1 */
  reconmode: number;
  maxR: number; maxG: number; maxB: number;
  quantise: boolean;
}

const SCAN_BAYER4 = new Uint8Array([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
const SCAN_BAYER2 = new Uint8Array([0, 2, 3, 1]);

function scanOffset4(amp: number): Int8Array {
  const t = new Int8Array(16);
  for (let p = 0; p < 16; p++) t[p] = Math.round((SCAN_BAYER4[p]! - 7.5) * amp / 8);
  return t;
}
function scanOffset2(amp: number): Int8Array {
  const t = new Int8Array(4);
  for (let p = 0; p < 4; p++) t[p] = Math.round((SCAN_BAYER2[p]! - 1.5) * amp / 2);
  return t;
}
const SCAN_RB4 = scanOffset4(4);
const SCAN_G4 = scanOffset4(2);
const SCAN_RB2 = scanOffset2(4);
const SCAN_G2 = scanOffset2(2);

let scanGammaCached = Number.NaN;
let scanGammaLUT: Uint8Array = new Uint8Array(256);
function scanGamma(gamma: number): Uint8Array {
  if (gamma === scanGammaCached) return scanGammaLUT;
  const lut = new Uint8Array(256);
  const inv = 1 / gamma;
  for (let i = 0; i < 256; i++) lut[i] = Math.min(255, Math.round(255 * Math.pow(i / 255, inv)));
  scanGammaCached = gamma;
  scanGammaLUT = lut;
  return lut;
}

function scanQuantise(r: number, g: number, b: number): number {
  return (((r & 0xf8) << 8) | ((g & 0xfc) << 3) | ((b & 0xf8) >> 3)) & 0xffff;
}

function scanPackRow(
  src: Uint32Array, dst565: Uint16Array, w: number, y: number,
  dither: boolean, rbW: Int8Array, gW: Int8Array, xmW: number, ymW: number, shW: number,
): void {
  const rowPh = (y & ymW) << shW;
  let i = y * w;
  for (let x = 0; x < w; x++, i++) {
    const px = src[i]!;
    let r = px & 255;
    let g = (px >> 8) & 255;
    let b = (px >> 16) & 255;
    if (dither) {
      const p = rowPh | (x & xmW);
      r += rbW[p]!;
      g += gW[p]!;
      b += rbW[p]!;
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;
    }
    dst565[i] = scanQuantise(r, g, b);
  }
}

/**
 * Banded fused scanout for rows [y0, y1): byte-identical to the serial fused
 * path. Disjoint writes (dst565 + display rows y0..y1-1); halo packed
 * locally; absolute dither phase; global gamma LUT.
 */
export function processScanoutBand(
  src: Uint32Array, dst565: Uint16Array, display: Uint32Array,
  w: number, h: number, o: ScanoutBandOptions,
  y0: number, y1: number,
): void {
  if (y0 < 0) y0 = 0;
  if (y1 > h) y1 = h;
  if (y1 <= y0) return;
  if (src.length < w * h || dst565.length < w * h || display.length < w * h) {
    Com_Error('drop', '[scanout] buffer too small');
  }
  const lut = o.gamma !== 1 ? scanGamma(o.gamma) : null;
  if (!o.quantise) {
    // RGB888 debug bypass: gamma-lifted copy, no dither/recon.
    for (let y = y0; y < y1; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const px = src[i]!;
        let r = px & 255;
        let g = (px >> 8) & 255;
        let b = (px >> 16) & 255;
        if (lut !== null) {
          r = lut[r]!;
          g = lut[g]!;
          b = lut[b]!;
        }
        // dst565 still packed (round-to-nearest compat, mirrors voodoo).
        const r5 = (r + 4) >> 3;
        const g6 = (g + 2) >> 2;
        const b5 = (b + 4) >> 3;
        dst565[i] = ((r5 > 31 ? 31 : r5) << 11) | ((g6 > 63 ? 63 : g6) << 5) | (b5 > 31 ? 31 : b5);
        display[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      }
    }
    return;
  }
  const twoW = o.ditherMode === 1;
  const rbW = twoW ? SCAN_RB2 : SCAN_RB4;
  const gW = twoW ? SCAN_G2 : SCAN_G4;
  const xmW = twoW ? 1 : 3;
  const ymW = twoW ? 1 : 3;
  const shW = twoW ? 1 : 2;
  const dither = o.dither;

  if (!o.postfilter) {
    for (let y = y0; y < y1; y++) {
      scanPackRow(src, dst565, w, y, dither, rbW, gW, xmW, ymW, shW);
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const v = dst565[i]!;
        const r5 = (v >> 11) & 31, g6 = (v >> 5) & 63, b5 = v & 31;
        let r = (r5 << 3) | (r5 >> 2);
        let g = (g6 << 2) | (g6 >> 4);
        let b = (b5 << 3) | (b5 >> 2);
        if (lut !== null) {
          r = lut[r]!;
          g = lut[g]!;
          b = lut[b]!;
        }
        display[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      }
    }
    return;
  }

  if (o.reconmode === 2) {
    const subOn = dither;
    const rbS = SCAN_RB4, gS = SCAN_G4;
    const mdR = o.maxR | 0, mdG = o.maxG | 0, mdB = o.maxB | 0;
    const gateOff = mdR === 0 && mdG === 0 && mdB === 0;
    for (let y = y0; y < y1; y++) {
      scanPackRow(src, dst565, w, y, dither, rbW, gW, xmW, ymW, shW);
      const row = y * w;
      const ph = (y & 3) << 2;
      for (let x = 0; x < w; x++) {
        const xa = x - 1 < 0 ? 0 : x - 1;
        const xb = x;
        const xc = x + 1 < w ? x + 1 : x;
        const xd = x + 2 < w ? x + 2 : xc;
        const va = dst565[row + xa]!, vb = dst565[row + xb]!;
        const vc = dst565[row + xc]!, vd = dst565[row + xd]!;
        let ra = (((va >> 11) & 31) << 3) | (((va >> 11) & 31) >> 2);
        let ga = (((va >> 5) & 63) << 2) | (((va >> 5) & 63) >> 4);
        let ba = ((va & 31) << 3) | ((va & 31) >> 2);
        let rb = (((vb >> 11) & 31) << 3) | (((vb >> 11) & 31) >> 2);
        let gb = (((vb >> 5) & 63) << 2) | (((vb >> 5) & 63) >> 4);
        let bb = ((vb & 31) << 3) | ((vb & 31) >> 2);
        let rc = (((vc >> 11) & 31) << 3) | (((vc >> 11) & 31) >> 2);
        let gc = (((vc >> 5) & 63) << 2) | (((vc >> 5) & 63) >> 4);
        let bc = ((vc & 31) << 3) | ((vc & 31) >> 2);
        let rd = (((vd >> 11) & 31) << 3) | (((vd >> 11) & 31) >> 2);
        let gd = (((vd >> 5) & 63) << 2) | (((vd >> 5) & 63) >> 4);
        let bd = ((vd & 31) << 3) | ((vd & 31) >> 2);
        if (subOn) {
          const sa = rbS[ph | (xa & 3)]!, sb = rbS[ph | (xb & 3)]!;
          const sc = rbS[ph | (xc & 3)]!, sd = rbS[ph | (xd & 3)]!;
          const ta = gS[ph | (xa & 3)]!, tb = gS[ph | (xb & 3)]!;
          const tc = gS[ph | (xc & 3)]!, td = gS[ph | (xd & 3)]!;
          ra = ra - sa < 0 ? 0 : ra - sa > 255 ? 255 : ra - sa;
          ga = ga - ta < 0 ? 0 : ga - ta > 255 ? 255 : ga - ta;
          ba = ba - sa < 0 ? 0 : ba - sa > 255 ? 255 : ba - sa;
          rb = rb - sb < 0 ? 0 : rb - sb > 255 ? 255 : rb - sb;
          gb = gb - tb < 0 ? 0 : gb - tb > 255 ? 255 : gb - tb;
          bb = bb - sb < 0 ? 0 : bb - sb > 255 ? 255 : bb - sb;
          rc = rc - sc < 0 ? 0 : rc - sc > 255 ? 255 : rc - sc;
          gc = gc - tc < 0 ? 0 : gc - tc > 255 ? 255 : gc - tc;
          bc = bc - sc < 0 ? 0 : bc - sc > 255 ? 255 : bc - sc;
          rd = rd - sd < 0 ? 0 : rd - sd > 255 ? 255 : rd - sd;
          gd = gd - td < 0 ? 0 : gd - td > 255 ? 255 : gd - td;
          bd = bd - sd < 0 ? 0 : bd - sd > 255 ? 255 : bd - sd;
        }
        let pass = gateOff;
        if (!pass) {
          const rs = Math.max(ra, rb, rc, rd) - Math.min(ra, rb, rc, rd);
          if (rs <= mdR) {
            const gs = Math.max(ga, gb, gc, gd) - Math.min(ga, gb, gc, gd);
            if (gs <= mdG) {
              const bs = Math.max(ba, bb, bc, bd) - Math.min(ba, bb, bc, bd);
              if (bs <= mdB) pass = true;
            }
          }
        }
        let r: number, g: number, b: number;
        if (pass) {
          r = (ra + rb + rc + rd + 2) >> 2;
          g = (ga + gb + gc + gd + 2) >> 2;
          b = (ba + bb + bc + bd + 2) >> 2;
        } else {
          r = rb; g = gb; b = bb;
        }
        if (lut !== null) {
          r = lut[r]!;
          g = lut[g]!;
          b = lut[b]!;
        }
        display[row + x] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      }
    }
    return;
  }

  if (o.reconmode === 0) {
    // Legacy unconditional 2x2 box. Pack all own rows first, halo locally.
    for (let y = y0; y < y1; y++) scanPackRow(src, dst565, w, y, dither, rbW, gW, xmW, ymW, shW);
    let halo: Uint16Array | null = null;
    if (y1 < h) {
      halo = new Uint16Array(w);
      const rowPh = (y1 & ymW) << shW;
      for (let x = 0; x < w; x++) {
        const i = y1 * w + x;
        const px = src[i]!;
        let r = px & 255, g = (px >> 8) & 255, b = (px >> 16) & 255;
        if (dither) {
          const p = rowPh | (x & xmW);
          r += rbW[p]!; g += gW[p]!; b += rbW[p]!;
          r = r < 0 ? 0 : r > 255 ? 255 : r;
          g = g < 0 ? 0 : g > 255 ? 255 : g;
          b = b < 0 ? 0 : b > 255 ? 255 : b;
        }
        halo[x] = scanQuantise(r, g, b);
      }
    }
    for (let y = y0; y < y1; y++) {
      const y1row = y + 1 < h ? y + 1 : y;
      const row0 = y * w;
      const useHalo = y + 1 === y1 && halo !== null && y1 < h;
      for (let x = 0; x < w; x++) {
        const x1 = x + 1 < w ? x + 1 : x;
        const a = dst565[row0 + x]!;
        const bq = dst565[row0 + x1]!;
        let c: number, dq: number;
        if (useHalo) {
          c = halo![x]!;
          dq = halo![x1]!;
        } else {
          const row1 = y1row * w;
          c = dst565[row1 + x]!;
          dq = dst565[row1 + x1]!;
        }
        const ar5 = (a >> 11) & 31, br5 = (bq >> 11) & 31;
        const cr5 = (c >> 11) & 31, dr5 = (dq >> 11) & 31;
        const ag6 = (a >> 5) & 63, bg6 = (bq >> 5) & 63;
        const cg6 = (c >> 5) & 63, dg6 = (dq >> 5) & 63;
        const ab5 = a & 31, bb5 = bq & 31, cb5 = c & 31, db5 = dq & 31;
        const rSum = ((ar5 << 3) | (ar5 >> 2)) + ((br5 << 3) | (br5 >> 2)) + ((cr5 << 3) | (cr5 >> 2)) + ((dr5 << 3) | (dr5 >> 2));
        const gSum = ((ag6 << 2) | (ag6 >> 4)) + ((bg6 << 2) | (bg6 >> 4)) + ((cg6 << 2) | (cg6 >> 4)) + ((dg6 << 2) | (dg6 >> 4));
        const bSum = ((ab5 << 3) | (ab5 >> 2)) + ((bb5 << 3) | (bb5 >> 2)) + ((cb5 << 3) | (cb5 >> 2)) + ((db5 << 3) | (db5 >> 2));
        let r = (rSum + 2) >> 2;
        let g = (gSum + 2) >> 2;
        let b = (bSum + 2) >> 2;
        if (lut !== null) {
          r = lut[r]!;
          g = lut[g]!;
          b = lut[b]!;
        }
        display[row0 + x] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      }
    }
    return;
  }

  // Matched 2x2sub+2x2box: pack own rows, halo locally, subtract mode's 2x2
  // pattern, 2x2 box with edge rejection.
  for (let y = y0; y < y1; y++) scanPackRow(src, dst565, w, y, dither, rbW, gW, xmW, ymW, shW);
  let halo2: Uint16Array | null = null;
  if (y1 < h) {
    halo2 = new Uint16Array(w);
    const rowPh = (y1 & ymW) << shW;
    for (let x = 0; x < w; x++) {
      const i = y1 * w + x;
      const px = src[i]!;
      let r = px & 255, g = (px >> 8) & 255, b = (px >> 16) & 255;
      if (dither) {
        const p = rowPh | (x & xmW);
        r += rbW[p]!; g += gW[p]!; b += rbW[p]!;
        r = r < 0 ? 0 : r > 255 ? 255 : r;
        g = g < 0 ? 0 : g > 255 ? 255 : g;
        b = b < 0 ? 0 : b > 255 ? 255 : b;
      }
      halo2[x] = scanQuantise(r, g, b);
    }
  }
  const sub2 = dither;
  const rbS = SCAN_RB2, gS = SCAN_G2;
  const xmS = 1, ymS = 1, shS = 1;
  const mdR = o.maxR | 0, mdG = o.maxG | 0, mdB = o.maxB | 0;
  const gateOff = mdR === 0 && mdG === 0 && mdB === 0;
  for (let y = y0; y < y1; y++) {
    const y1abs = y + 1 < h ? y + 1 : y;
    const useHalo = y + 1 === y1 && halo2 !== null && y1 < h;
    const ph0 = (y & ymS) << shS;
    const ph1 = (y1abs & ymS) << shS;
    const row0 = y * w;
    for (let x = 0; x < w; x++) {
      const x1 = x + 1 < w ? x + 1 : x;
      const v00 = dst565[row0 + x]!;
      const v10 = dst565[row0 + x1]!;
      let v01: number, v11: number;
      if (useHalo) {
        v01 = halo2![x]!;
        v11 = halo2![x1]!;
      } else {
        const row1 = y1abs * w;
        v01 = dst565[row1 + x]!;
        v11 = dst565[row1 + x1]!;
      }
      let r0 = (((v00 >> 11) & 31) << 3) | (((v00 >> 11) & 31) >> 2);
      let g0 = (((v00 >> 5) & 63) << 2) | (((v00 >> 5) & 63) >> 4);
      let b0 = ((v00 & 31) << 3) | ((v00 & 31) >> 2);
      let r1 = (((v10 >> 11) & 31) << 3) | (((v10 >> 11) & 31) >> 2);
      let g1 = (((v10 >> 5) & 63) << 2) | (((v10 >> 5) & 63) >> 4);
      let b1 = ((v10 & 31) << 3) | ((v10 & 31) >> 2);
      let r2 = (((v01 >> 11) & 31) << 3) | (((v01 >> 11) & 31) >> 2);
      let g2 = (((v01 >> 5) & 63) << 2) | (((v01 >> 5) & 63) >> 4);
      let b2 = ((v01 & 31) << 3) | ((v01 & 31) >> 2);
      let r3 = (((v11 >> 11) & 31) << 3) | (((v11 >> 11) & 31) >> 2);
      let g3 = (((v11 >> 5) & 63) << 2) | (((v11 >> 5) & 63) >> 4);
      let b3 = ((v11 & 31) << 3) | ((v11 & 31) >> 2);
      if (sub2) {
        const d00 = rbS[ph0 | (x & xmS)]!, d10 = rbS[ph0 | (x1 & xmS)]!;
        const d01 = rbS[ph1 | (x & xmS)]!, d11 = rbS[ph1 | (x1 & xmS)]!;
        const e00 = gS[ph0 | (x & xmS)]!, e10 = gS[ph0 | (x1 & xmS)]!;
        const e01 = gS[ph1 | (x & xmS)]!, e11 = gS[ph1 | (x1 & xmS)]!;
        r0 = r0 - d00 < 0 ? 0 : r0 - d00 > 255 ? 255 : r0 - d00;
        g0 = g0 - e00 < 0 ? 0 : g0 - e00 > 255 ? 255 : g0 - e00;
        b0 = b0 - d00 < 0 ? 0 : b0 - d00 > 255 ? 255 : b0 - d00;
        r1 = r1 - d10 < 0 ? 0 : r1 - d10 > 255 ? 255 : r1 - d10;
        g1 = g1 - e10 < 0 ? 0 : g1 - e10 > 255 ? 255 : g1 - e10;
        b1 = b1 - d10 < 0 ? 0 : b1 - d10 > 255 ? 255 : b1 - d10;
        r2 = r2 - d01 < 0 ? 0 : r2 - d01 > 255 ? 255 : r2 - d01;
        g2 = g2 - e01 < 0 ? 0 : g2 - e01 > 255 ? 255 : g2 - e01;
        b2 = b2 - d01 < 0 ? 0 : b2 - d01 > 255 ? 255 : b2 - d01;
        r3 = r3 - d11 < 0 ? 0 : r3 - d11 > 255 ? 255 : r3 - d11;
        g3 = g3 - e11 < 0 ? 0 : g3 - e11 > 255 ? 255 : g3 - e11;
        b3 = b3 - d11 < 0 ? 0 : b3 - d11 > 255 ? 255 : b3 - d11;
      }
      let r: number, g: number, b: number;
      if (gateOff) {
        r = (r0 + r1 + r2 + r3 + 2) >> 2;
        g = (g0 + g1 + g2 + g3 + 2) >> 2;
        b = (b0 + b1 + b2 + b3 + 2) >> 2;
      } else {
        const rs = Math.max(r0, r1, r2, r3) - Math.min(r0, r1, r2, r3);
        if (rs > mdR) {
          r = r0; g = g0; b = b0;
        } else {
          const gs = Math.max(g0, g1, g2, g3) - Math.min(g0, g1, g2, g3);
          if (gs > mdG) {
            r = r0; g = g0; b = b0;
          } else {
            const bs = Math.max(b0, b1, b2, b3) - Math.min(b0, b1, b2, b3);
            if (bs > mdB) {
              r = r0; g = g0; b = b0;
            } else {
              r = (r0 + r1 + r2 + r3 + 2) >> 2;
              g = (g0 + g1 + g2 + g3 + 2) >> 2;
              b = (b0 + b1 + b2 + b3 + 2) >> 2;
            }
          }
        }
      }
      if (lut !== null) {
        r = lut[r]!;
        g = lut[g]!;
        b = lut[b]!;
      }
      display[row0 + x] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
}

/** Reused window record for the worker RGB core (workers are single-threaded). */
const matWin: RGBWindow = { near: 4, far: 32768 };

/**
 * Drain one band's share of an RGB frame kick: every RGB descriptor in
 * order, each with its staged chain + luxels. Bands are disjoint row
 * ranges so cross-band order cannot affect any pixel; within a band the
 * descriptors run sequentially in pack order, exactly like the serial
 * drawSpansRGB calls the staging replaced. Bit-identical to serial.
 */
export function processRGBFrameJob(
  rgb: RGBAccumViews,
  fbW: number, fbH: number, descCount: number,
  y0: number, y1: number,
): { pixels: number; spans: number } {
  const near = rgb.kick[0]!;
  const far = rgb.kick[1]!;
  const lodBias = rgb.kick[2]!;
  // Per-kick chain-slot -> level-view cache (subarray views, no copies).
  // Built lazily only for descriptors intersecting this band (PERF-5
  // band-cull): out-of-band batches skip material + span scans entirely.
  const chainCache = new Map<number, RGBMipLevel[]>();
  const levelFor = (slot: number): RGBMipLevel[] => {
    const hit = chainCache.get(slot);
    if (hit) return hit;
    const d = slot * C_PER_CHAIN;
    const levelBase = rgb.chainDir[d + C_LEVEL_BASE]!;
    const levelCount = rgb.chainDir[d + C_LEVEL_COUNT]!;
    const levels: RGBMipLevel[] = [];
    for (let l = 0; l < levelCount; l++) {
      const t = (levelBase + l) * L_PER_LEVEL;
      const dataOff = rgb.levelTab[t + L_DATA_OFF]!;
      const maskOff = rgb.levelTab[t + L_MASK_OFF]!;
      const w = rgb.levelTab[t + L_W]!;
      const h = rgb.levelTab[t + L_H]!;
      levels.push({
        data: rgb.chainData.subarray(dataOff, dataOff + w * h * 3),
        width: w,
        height: h,
        mask: rgb.chainData.subarray(maskOff, maskOff + w * h),
      });
    }
    chainCache.set(slot, levels);
    return levels;
  };
  // Reused per-descriptor records (no per-batch allocation on the hot path).
  const reuseLight: RGBLightmap = { samples: new Uint8Array(0), luxW: 0, luxH: 0 };
  const reuseFlat = new Uint8Array(3);
  const reuseMat: RGBMaterial = {
    levels: [],
    addressS: 'repeat',
    addressT: 'repeat',
    light: null,
    overbright: false,
    lodBias,
    mipDither: false,
    bilinear: true,
    zbits: 16,
    blend: 'opaque',
    alpha: 1,
    warp: false,
    turbPhase: 0,
    flatColor: null,
    alphaTest: null,
    depthWrite: true,
  };
  let pixels = 0;
  let drawn = 0;
  for (let b = 0; b < descCount; b++) {
    const d = b * R_PER_BATCH;
    const spanCount = rgb.rgbDesc[d + R_SPAN_COUNT]!;
    if (spanCount <= 0) continue;
    // Band-cull: descriptors carry their staged span y-range; bands with no
    // overlap skip material resolution + span scans. Legacy descriptors with
    // an empty range (ymax <= ymin) fall through to the raster core's own
    // per-span y filter so output stays identical.
    const ymin = rgb.rgbDesc[d + R_YMIN]!;
    const ymax = rgb.rgbDesc[d + R_YMAX]!;
    if (ymax > ymin && (ymax <= y0 || ymin >= y1)) continue;
    const spanBase = rgb.rgbDesc[d + R_SPAN_BASE]!;
    const slot = rgb.rgbDesc[d + R_CHAIN]!;
    const luxOff = rgb.rgbDesc[d + R_LUX_OFF]!;
    const luxW = rgb.rgbDesc[d + R_LUX_W]!;
    const luxH = rgb.rgbDesc[d + R_LUX_H]!;
    const flags = rgb.rgbDesc[d + R_FLAGS]!;
    const zbits = rgb.rgbDesc[d + R_ZBITS]!;
    const turbPhase = rgb.rgbDesc[d + R_TURBPHASE]!;
    const flatRGB = rgb.rgbDesc[d + R_FLATRGB]!;
    const hasLight = (flags & R_FLAG_LIGHT) !== 0;
    const hasFlat = (flags & R_FLAG_FLAT) !== 0;
    const repeat = (flags & R_FLAG_REPEAT) !== 0;
    reuseMat.levels = levelFor(slot);
    reuseMat.addressS = repeat ? 'repeat' : 'clamp';
    reuseMat.addressT = repeat ? 'repeat' : 'clamp';
    if (hasLight) {
      reuseLight.samples = rgb.lux.subarray(luxOff, luxOff + luxW * luxH * 3);
      reuseLight.luxW = luxW;
      reuseLight.luxH = luxH;
      reuseMat.light = reuseLight;
    } else {
      reuseMat.light = null;
    }
    reuseMat.overbright = (flags & R_FLAG_OVERBRIGHT) !== 0;
    reuseMat.lodBias = lodBias;
    reuseMat.mipDither = (flags & R_FLAG_MIPDITHER) !== 0;
    reuseMat.bilinear = (flags & R_FLAG_BILINEAR) !== 0;
    reuseMat.zbits = zbits;
    reuseMat.warp = (flags & R_FLAG_WARP) !== 0;
    reuseMat.turbPhase = turbPhase;
    if (hasFlat) {
      reuseFlat[0] = (flatRGB >> 16) & 255;
      reuseFlat[1] = (flatRGB >> 8) & 255;
      reuseFlat[2] = flatRGB & 255;
      reuseMat.flatColor = reuseFlat;
    } else {
      reuseMat.flatColor = null;
    }
    reuseMat.depthWrite = (flags & R_FLAG_DEPTHWRITE) !== 0;
    const r = rasterizePackedRGBRange(
      rgb.rgb565, rgb.cover, rgb.rgbDepth, fbW, fbH,
      rgb.spansF, rgb.spansI, spanBase, spanCount,
      reuseMat,
      repeat,
      (flags & R_FLAG_WARP) !== 0,
      turbPhase,
      near, far,
      y0, y1,
    );
    pixels += r.pixels;
    drawn += r.spans;
  }
  return { pixels, spans: drawn };
}

/**
 * Rasterise one band's share of a frame kick: every descriptor in order,
 * each with its own staged (tex, light) setup. Bands are disjoint row
 * ranges so cross-band order cannot affect any pixel; within a band the
 * descriptors run sequentially in pack order, exactly like the equivalent
 * per-batch kicks. Bit-identical to the single-threaded path.
 */
export function processFrameJob(
  fv: FrameAccumViews, fbW: number, fbH: number, descCount: number,
  y0: number, y1: number,
): { pixels: number; spans: number } {
  const { base, fSpansF, fSpansI, fTex, fLight, desc } = fv;
  const colormap = base.colormap;
  const turbTable = base.turb;
  let pixels = 0;
  let drawn = 0;
  for (let b = 0; b < descCount; b++) {
    const d = b * D_PER_BATCH;
    const spanBase = desc[d + D_SPAN_BASE]!;
    const spanCount = desc[d + D_SPAN_COUNT]!;
    if (spanCount <= 0) continue;
    const texOff = desc[d + D_TEX_OFF]!;
    const texW = desc[d + D_TEX_W]!;
    const texH = desc[d + D_TEX_H]!;
    const lightOff = desc[d + D_LIGHT_OFF]!;
    const lightW = desc[d + D_LIGHT_W]!;
    const lightH = desc[d + D_LIGHT_H]!;
    jobTex.width = texW; jobTex.height = texH;
    // NOTE: subarray views are per-descriptor (not per-pixel) short-lived
    // objects — the pixel loop itself allocates nothing. The alternative
    // (copying each staged block into a scratch slot) costs a memcpy per
    // descriptor per worker; views keep the zero-copy SAB design. The main
    // thread's geometry path stages offsets only, no views.
    jobTex.texels = fTex.subarray(texOff, texOff + texW * texH);
    jobLight.width = lightW; jobLight.height = lightH;
    jobLight.values = fLight.subarray(lightOff, lightOff + lightW * lightH);
    const r = rasterizePackedRange(
      base.idx, base.zb, fbW, fbH, fSpansF, fSpansI, spanBase, spanCount,
      jobTex, jobLight,
      desc[d + D_WSHIFT]!, desc[d + D_WMASK]!, desc[d + D_HMASK]!,
      colormap, turbTable, desc[d + D_TURBPHASE]!,
      y0, y1,
    );
    pixels += r.pixels;
    drawn += r.spans;
  }
  return { pixels, spans: drawn };
}

/**
 * Palette-expand rows [y0, y1) into the shared color plane (M8.1 parallel
 * resolve): identical math to SoftwareRenderer.endFrame
 * (0xAABBGGRR from the 8-bit palette), partitioned by band so the pool
 * drains it in the resolve kick. No allocation, no branches in the loop.
 */
export function resolveBand(
  color: Uint32Array, pal: Uint8Array, idx: Uint8Array,
  y0: number, y1: number, fbW: number, fbH: number,
): void {
  if (y0 < 0) y0 = 0;
  if (y1 > fbH) y1 = fbH;
  for (let y = y0; y < y1; y++) {
    const row = y * fbW;
    const end = row + fbW;
    for (let o = row; o < end; o++) {
      const c = idx[o]! * 3;
      const r = pal[c]!, g = pal[c + 1]!, b = pal[c + 2]!;
      color[o] = (0xff << 24) | (b << 16) | (g << 8) | r;
    }
  }
}

/**
 * Fused palette-expand + RGB composite for rows [y0, y1) (PERF-5 pooled
 * end-frame fusion): bit-identical to the serial fused endFrame path —
 * pixels the RGB overlay covered expand from the packed RGB565 authority
 * plane (top-bit replication), everything else from the indexed plane.
 * Disjoint pixel sets, no cross-pixel dependencies. When cover is all zero
 * (RGB disabled/unused) this is exactly resolveBand. No allocation.
 */
export function resolveBandFused(
  color: Uint32Array, pal: Uint8Array, idx: Uint8Array,
  rgb565: Uint16Array | null, cover: Uint8Array | null,
  y0: number, y1: number, fbW: number, fbH: number,
): void {
  if (y0 < 0) y0 = 0;
  if (y1 > fbH) y1 = fbH;
  if (!rgb565 || !cover || rgb565.length < fbW * fbH || cover.length < fbW * fbH) {
    resolveBand(color, pal, idx, y0, y1, fbW, fbH);
    return;
  }
  for (let y = y0; y < y1; y++) {
    const row = y * fbW;
    const end = row + fbW;
    for (let o = row; o < end; o++) {
      if (cover[o]) {
        const v = rgb565[o]!;
        const r5 = (v >> 11) & 31, g6 = (v >> 5) & 63, b5 = v & 31;
        color[o] = (0xff000000 |
          ((((b5 << 3) | (b5 >> 2)) << 16) |
            (((g6 << 2) | (g6 >> 4)) << 8) |
            ((r5 << 3) | (r5 >> 2)))) >>> 0;
      } else {
        const c = idx[o]! * 3;
        const r = pal[c]!, g = pal[c + 1]!, b = pal[c + 2]!;
        color[o] = (0xff << 24) | (b << 16) | (g << 8) | r;
      }
    }
  }
}

/** Minimal sink for worker completion posts (worker_threads / Web Worker). */
export interface BandPort {
  postMessage(msg: unknown): void;
}

/**
 * Worker main loop (runs INSIDE the worker thread). Announces readiness,
 * then blocks on the job generation counter, rasterises this worker's
 * band, publishes per-band counts, and wakes the dispatcher. All shared
 * state lives in the SAB; `waitSeq` is injected so the same loop serves
 * Atomics.wait (Node) and waitAsync/message-driven (browser) dispatch.
 *
 * `rgb` carries the RGB worker views (null when the SAB predates the RGB
 * regions — only pools created via rgbAccumTotal kick JOB_RGB, so a null
 * here with a raster/resolve kick is fine; a JOB_RGB kick with null views
 * is a loud Com_Error, never a silent fallback).
 */
export function bandWorkerLoop(
  fav: FrameAccumViews, rgb: RGBAccumViews | null, ctl: Int32Array,
  y0: number, y1: number, band: number, fbW: number,
  waitSeq: (seq: number) => void,
  port: BandPort,
): void {
  const views = fav.base;
  // NOTE: seq is sampled BEFORE announcing readiness. The dispatcher only
  // publishes job 1 after every worker is ready, so SEQ is still 0 here by
  // construction — a worker can never miss its first wakeup (missed wakeups
  // desynchronise the DONE counting and stall a dispatch).
  let seq = Atomics.load(ctl, CTL_SEQ);
  let lastFrame = 0;
  try {
    port.postMessage({ ready: true, band });
  } catch {
    /* async dispatch unavailable; the sync path polls CTL_READY */
  }
  try {
    Atomics.add(ctl, CTL_READY, 1);
  } catch {
    /* ignore */
  }
  try {
    Atomics.notify(ctl, CTL_READY, 1);
  } catch {
    /* ignore */
  }
  for (;;) {
    waitSeq(seq);
    const s = Atomics.load(ctl, CTL_SEQ);
    if (s < 0) return; // shutdown
    if (s === seq) continue; // spurious wakeup
    seq = s;
    const frame = Atomics.load(ctl, CTL_FRAME);
    const fbWNow = Atomics.load(ctl, CTL_FBW);
    const fbHNow = Atomics.load(ctl, CTL_FBH);
    const job = Atomics.load(ctl, CTL_JOB);
    // Resolve kicks must never clear: they only read the planes (palette
    // expand), and on all-inline / zero-batch frames no raster kick ran this
    // generation — clearing here would wipe the finished frame (the browser
    // doll-house: black world + surviving foreground). Freshness is owned by
    // raster kicks and main-thread full clears, never by the resolve.
    // RGB kicks must never clear either: they run AFTER the indexed world
    // kick whose planes the foreground seed still reads.
    // Scanout kicks must never clear: they only read the finished color
    // plane into disjoint scanout buffers.
    if (frame !== lastFrame && job !== JOB_RESOLVE && job !== JOB_RGB && job !== JOB_SCANOUT) {
      views.idx.fill(0, y0 * fbW, y1 * fbW);
      views.zb.fill(0, y0 * fbW, y1 * fbW);
      lastFrame = frame;
    }
    let r: { pixels: number; spans: number };
    if (job === JOB_RESOLVE) {
      // Resolve kick (M8.1 parallel resolve + PERF-5 fused composite): expand
      // the final index plane into the shared color plane, compositing the
      // RGB overlay where covered. No tally contribution by construction
      // (spans/pixels count spanfill, which this kick does not do). Fused
      // when RGB views exist (cover zero => plain expand, bit-identical).
      const pal = fav.fPal;
      if (rgb) resolveBandFused(fav.fColor, pal, views.idx, rgb.rgb565, rgb.cover, y0, y1, fbWNow, fbHNow);
      else resolveBand(fav.fColor, pal, views.idx, y0, y1, fbWNow, fbHNow);
      r = { pixels: 0, spans: 0 };
    } else if (job === JOB_RGB) {
      // RGB raster kick (PERF-2 RGB workers): drain every staged RGB
      // descriptor for this band. No lazy clear: beginFrame clears the RGB
      // planes serially on the main thread (planes adopted, kick runs
      // after), so every band starts clean without a parallel clear.
      if (!rgb) {
        Com_Error('error', 'bandWorkerLoop: JOB_RGB without RGB views');
      }
      r = processRGBFrameJob(
        rgb, fbWNow, fbHNow, Atomics.load(ctl, CTL_RGBCOUNT), y0, y1,
      );
    } else if (job === JOB_SCANOUT) {
      // Scanout kick (Track A): fused pack→recon→gamma from the finished
      // shared color plane into shared scanout buffers. Disjoint rows,
      // immutable input, absolute dither phase — byte-identical to serial.
      if (!rgb) {
        Com_Error('error', 'bandWorkerLoop: JOB_SCANOUT without RGB views');
      }
      const k = rgb.kick;
      processScanoutBand(
        fav.fColor, rgb.scan565, rgb.scanDisplay, fbWNow, fbHNow,
        {
          gamma: k[0]!, dither: k[1]! !== 0, ditherMode: k[2]! | 0,
          postfilter: k[3]! !== 0, reconmode: k[4]! | 0,
          maxR: k[5]! | 0, maxG: k[6]! | 0, maxB: k[7]! | 0,
          quantise: k[8]! !== 0,
        },
        y0, y1,
      );
      r = { pixels: 0, spans: 0 };
    } else {
      const fcount = Atomics.load(ctl, CTL_FCOUNT);
      r = fcount > 0
        ? processFrameJob(fav, fbWNow, fbHNow, fcount, y0, y1)
        : processBandJob(views, readBandJob(ctl, y0, y1));
    }
    Atomics.store(ctl, CTL_PIXELS + band, r.pixels);
    Atomics.store(ctl, CTL_SPANS + band, r.spans);
    Atomics.add(ctl, CTL_DONE, 1);
    try {
      Atomics.notify(ctl, CTL_DONE, 1);
    } catch {
      /* notify is best-effort; the dispatcher also polls on timeout */
    }
    try {
      port.postMessage({ seq: s, band, pixels: r.pixels, spans: r.spans });
    } catch {
      /* async dispatch unavailable; the sync path already woke via notify */
    }
  }
}

/**
 * Dispatch surface for one packed batch. Implemented by BandWorkerPool
 * (real threads); the banded backend falls back to inline spanfill when it
 * returns null (batch unsuitable) or when no pool is attached.
 */
export interface BandDispatcher {
  readonly bandCount: number;
  /** Live shared planes (adopted by the renderer when this pool is attached). */
  readonly planes: { idx: Uint8Array; zb: Float32Array; color: Uint32Array } | null;
  /** Current frame generation (lazy per-band clear coordination). */
  frame(): number;
  /** Bump the frame generation (lazy per-band clear on the next batch). */
  beginFrame(): void;
  dispatch(
    list: SpanList, tex: Texture, light: LightBlock,
    colormap: Uint8Array, time: number,
    fbW: number, fbH: number, idx: Uint8Array, zb: Float32Array,
  ): { pixels: number; spans: number } | null;
  /**
   * Frame-accumulation surface (M8.1 async-render step 1): capture one
   * batch into the frame kick (true) or demand an immediate inline run
   * (false — caller flushes first so batch order is preserved).
   */
  flatCursor(): { F: Float64Array; I: Int32Array; base: number; cap: number } | null;
  packBatched(
    spanBase: number, spanCount: number,
    tex: Texture, light: LightBlock,
    colormap: Uint8Array, time: number,
  ): boolean;
  /** Pending accumulated batches. */
  accumPending(): number;
  /** Kick one frame covering every accumulated batch (blocking). */
  flushFrame(): { pixels: number; spans: number } | null;
  /** Same as flushFrame but message-driven (browser async completion). */
  flushFrameAsync(): Promise<{ pixels: number; spans: number } | null>;
  /** Full-frame inline replay of the accumulated batches (fallback). */
  drawInlineAll(): { pixels: number; spans: number };
  /** Stage the palette for worker-side resolve (once per frame). */
  stagePalette(palette: Uint8Array): void;
  /**
   * Resolve kick (M8.1 parallel resolve): palette-expand the final index
   * plane into the shared color plane across the pool (blocking). True
   * unless the pool is dead or the wait times out (caller expands inline).
   */
  resolveFrame(): boolean;
  /** Same as resolveFrame but message-driven (browser async completion). */
  resolveFrameAsync(): Promise<boolean>;

  // --- RGB worker staging (PERF-2 RGB workers) ---
  //
  // World RGB batches (opaque/turbulent world spans, skybox faces, flat
  // sky) stage here per frame and drain in ONE worker kick (JOB_RGB).
  // Staging copies: spans (from the emitted SpanList slice), the material's
  // mip chain (deduped per frame), and the luxel block. Only
  // repeat/clamp-addressed opaque materials stage (the world + sky
  // materials); foreground RGB stays inline after the kick.
  /** Live shared RGB planes (adopted by the renderer when this pool is attached). */
  readonly rgbPlanes: { rgb565: Uint16Array; cover: Uint8Array; rgbDepth: Uint16Array } | null;
  /**
   * Stage one world RGB batch (spans + chain + luxels + flags). Returns
   * false when the batch must run inline immediately (no pool, regions
   * exhausted, unsupported material) — the caller replays pending batches
   * inline first so global batch order is preserved.
   */
  stageRGB(
    list: SpanList, spanStart: number, spanCount: number,
    levels: import('./spans.js').RGBMipLevel[],
    luxels: Uint8Array | null, luxW: number, luxH: number,
    flags: number, zbits: number, turbPhase: number, flatRGB: number,
  ): boolean;
  /** Pending staged RGB batches. */
  rgbPending(): number;
  /** Kick one RGB frame covering every staged batch (blocking). Null = replay inline. */
  flushRGBFrame(near: number, far: number, lodBias: number): { pixels: number; spans: number } | null;
  /** Same as flushRGBFrame but message-driven (browser async completion). */
  flushRGBFrameAsync(near: number, far: number, lodBias: number): Promise<{ pixels: number; spans: number } | null>;
  /** Full-frame inline replay of the staged RGB batches (fallback). */
  drawInlineRGBAll(near: number, far: number, lodBias: number): { pixels: number; spans: number };
  /** Drop the persistent RGB chain upload cache (palette/world change). */
  clearRGBChains(): void;
}

const BAND_CHUNK = 4096;

function createScratchSpan(): Span {
  return {
    kind: SPAN_OPAQUE,
    y: 0, x0: 0, x1: 0,
    iz: 0, diz: 0, uz: 0, duz: 0, vz: 0, dvz: 0,
    light: 63, dlight: 0, lu: 0, lv: -1, dlu: 0, turb: 0, ord: 0,
    dudy: 0, dvdy: 0,
  };
}

/**
 * RasterBackend over SAB bands. Sequential inline spanfill reusing the
 * monomorphic spans.ts loops — golden-identical to SoftwareBackend by
 * construction (same functions, rows partitioned). Attach an optional
 * BandDispatcher for true thread-parallel batches; unsuitable batches
 * always run inline, so output can never diverge.
 */
export class BandedSoftwareBackend extends SoftwareBackend implements RasterBackend {
  bandCount = 1;
  bands: Band[] = [{ y0: 0, y1: 0 }];
  dispatcher: BandDispatcher | null = null;
  /**
   * Frame accumulation (M8.1 async-render step 1): when true and pooled,
   * drawSpans captures the batch into the frame kick instead of dispatching
   * per batch. Set from the sw_accum cvar; identical output either way.
   */
  accumEnabled = true;
  /**
   * Deferred async-render mode (M8.1 browser lane): when true, the
   * end-of-geometry kick is skipped — `flushAccumAsync` completes the frame
   * later without blocking the calling thread. A mid-loop sequencing break
   * still replays staged batches inline immediately (ordering), so the
   * deferred kick only ever covers later batches; every write stays
   * depth-guarded, hence output-identical. Set by renderViewAsync.
   */
  flushDeferred = false;
  /**
   * Deferred inline rest-of-frame (async-break rule): once an inline plane
   * write happened inside a deferred frame (break replay, unsuitable batch),
   * the deferred final kick must never run — its lazy worker clear would
   * wipe the inline work. Set by the drawSpans funnel, reset per frame in
   * beginFrame-adjacent staging reset (see frame.ts beginFrame), read by the
   * funnel and by flushAccumAsync's early-out (pending stays empty).
   */
  deferredInlineRest = false;
  /**
   * Fused-emission staging for the CURRENT batch (M8.1): the renderer sets
   * this from the pool's flatCursor() before emitSpansForPoly runs, so
   * drawSpans can record the descriptor without re-packing. base < 0 means
   * no fused data — drawSpans falls back to the legacy per-batch path.
   * Backend-owned (mutated in place, never reallocated).
   */
  readonly pendingFlat: { base: number; count: number } = { base: -1, count: 0 };
  /** drawSpans calls this frame (renderer resets per frame when banded). */
  batchesDrawn = 0;
  private clearedFrame = -1;
  private scratch: Span[] = [];
  private readonly bandList: SpanList = { spans: [], count: 0 };
  /**
   * Monomorphic RGB overlay backend (perf-2 lane): owns the renderer's RGB
   * planes (color/cover/rgbZb) when banded. Workers only handle the indexed
   * planes, so RGB always runs inline per band on the calling thread; the
   * single global composite in endFrame merges the planes afterwards.
   */
  private readonly rgb = new RGBWorldBackend();

  setBandCount(n: number): void {
    const c = Math.floor(n);
    this.bandCount = !Number.isFinite(c) || c < 1 ? 1 : Math.min(c, MAX_WORKERS);
    this.bands = splitBands(this.fbH, this.bandCount);
  }

  override attach(idx: Uint8Array, zb: Float32Array, w: number, h: number, colormap: Uint8Array): void {
    super.attach(idx, zb, w, h, colormap);
    while (this.scratch.length < BAND_CHUNK) this.scratch.push(createScratchSpan());
    this.bandList.spans = this.scratch;
    this.bandList.count = 0;
    this.bands = splitBands(h, this.bandCount);
  }

  override drawSpans(list: SpanList, tex: Texture, light: LightBlock): void {
    this.batchesDrawn++;
    if (this.bandCount <= 1 || this.fbH <= 0) {
      super.drawSpans(list, tex, light);
      return;
    }
    if (this.dispatcher && this.accumEnabled) {
      // Deferred inline rest-of-frame (async-break rule): once an inline
      // plane write happened in a deferred frame, the deferred kick must
      // never run (its lazy worker clear would wipe the inline work), so
      // every later batch also goes inline and the final kick finds nothing
      // pending. All writes stay depth-guarded: identical output.
      if (this.flushDeferred && this.deferredInlineRest) {
        this.runInline(list, tex, light);
        return;
      }
      // Fused path: spans were packed during emission (pendingFlat); record
      // the descriptor. Anything off (no fused data, sequencing break,
      // exhausted regions) flushes pending work first (preserving global
      // batch order) and runs this batch inline.
      const pfBase = this.pendingFlat.base;
      const pfCount = this.pendingFlat.count;
      this.pendingFlat.base = -1;
      this.pendingFlat.count = 0;
      if (pfBase >= 0 && pfCount >= 0 &&
        this.dispatcher.packBatched(
          pfBase, pfCount, tex, light, this.colormap, this.time,
        )) {
        return;
      }
      if (this.flushDeferred) {
        // Async frame: a sync kick would block the calling thread, so
        // replay staged batches inline now (ordering preserved) and run
        // this batch inline after them. Latch inline-rest: the deferred
        // final kick must not run afterwards (it would clear these inline
        // writes), so the rest of the frame stays inline and the kick
        // finds nothing pending. Depth-guarded convergence: identical output.
        this.flushAccumInline();
        this.deferredInlineRest = true;
      } else {
        this.flushAccum();
      }
      this.runInline(list, tex, light);
      return;
    }
    if (this.dispatcher) {
      // Deferred inline rest-of-frame (same rule as the accum path): an
      // inline batch followed by a per-batch kick would be wiped by the
      // kick's lazy clear, so once inline in a deferred frame, stay inline.
      if (this.flushDeferred && this.deferredInlineRest) {
        this.runInline(list, tex, light);
        return;
      }
      const r = this.dispatcher.dispatch(
        list, tex, light, this.colormap, this.time,
        this.fbW, this.fbH, this.idx, this.zb,
      );
      if (r) {
        this.spansDrawn += r.spans;
        this.pixelsDrawn += r.pixels;
        // The kick lazily cleared every band, so the planes are fully
        // valid: a later inline batch must NOT wipe them (M8.1 real-frame
        // divergence fix — per-batch pool output is golden-identical now).
        this.clearedFrame = this.dispatcher.frame();
        return;
      }
      // Dispatched path unavailable for this batch: make sure the planes
      // are clear for the inline run (workers clear lazily per band, but
      // inline batches never reach them).
      const f = this.dispatcher.frame();
      if (f !== this.clearedFrame) {
        this.idx.fill(0);
        this.zb.fill(0);
        this.clearedFrame = f;
      }
      if (this.flushDeferred) this.deferredInlineRest = true;
    }
    this.runInline(list, tex, light);
  }

  /**
   * Complete the frame kick (blocking): one kick for every accumulated
   * batch, tallied into the backend counters. No-op without accumulation.
   * Timeout/pool failure replays inline via the dispatcher (identical).
   * On success the planes are fully drawn, so the lazy-clear guard is
   * marked satisfied (a later inline batch must NOT wipe the kick).
   */
  flushAccum(): void {    const d = this.dispatcher;
    if (!d || !this.accumEnabled || d.accumPending() === 0) return;
    const r = d.flushFrame();
    if (r) {
      this.spansDrawn += r.spans;
      this.pixelsDrawn += r.pixels;
      this.clearedFrame = d.frame();
      return;
    }
    const q = d.drawInlineAll();
    this.spansDrawn += q.spans;
    this.pixelsDrawn += q.pixels;
    this.clearedFrame = d.frame();
  }

  /**
   * Inline replay of every staged batch on the calling thread (ordering
   * fallback for the deferred async path, which must never block): clears
   * and replays in pack order, tallies into the backend counters. Identical
   * output via depth-guarded convergence.
   */
  flushAccumInline(): void {
    const d = this.dispatcher;
    if (!d || !this.accumEnabled || d.accumPending() === 0) return;
    const q = d.drawInlineAll();
    this.spansDrawn += q.spans;
    this.pixelsDrawn += q.pixels;
    this.clearedFrame = d.frame();
  }

  /**
   * Same as flushAccum but message-driven (browser async-render completion:
   * no Atomics.wait on the calling thread). Falls back to inline replay.
   */
  async flushAccumAsync(): Promise<void> {
    const d = this.dispatcher;
    if (!d || !this.accumEnabled || d.accumPending() === 0) return;
    const r = await d.flushFrameAsync();
    if (r) {
      this.spansDrawn += r.spans;
      this.pixelsDrawn += r.pixels;
      this.clearedFrame = d.frame();
      return;
    }
    const q = d.drawInlineAll();
    this.spansDrawn += q.spans;
    this.pixelsDrawn += q.pixels;
    this.clearedFrame = d.frame();
  }

  /**
   * Complete the resolve kick (M8.1 parallel resolve + PERF-5 fused
   * composite): the pool expands the final index plane into the shared
   * color plane, compositing RGB where covered. Falls back to an identical
   * serial fused expand on timeout/dead pool. `color` is the destination
   * plane (pool-adopted when pooled), `palette` the 768-byte RGB palette.
   * No-op without a dispatcher (caller expands serially instead).
   */
  resolveAccum(palette: Uint8Array, color: Uint32Array): void {
    const d = this.dispatcher;
    if (d && d.resolveFrame()) return;
    if (!d) return;
    resolveBandFused(color, palette, this.idx, this.rgb.rgb565, this.rgb.cover, 0, this.fbH, this.fbW, this.fbH);
  }

  /**
   * Same as resolveAccum but message-driven (browser async completion).
   */
  async resolveAccumAsync(palette: Uint8Array, color: Uint32Array): Promise<void> {
    const d = this.dispatcher;
    if (d && await d.resolveFrameAsync()) return;
    if (!d) return;
    resolveBandFused(color, palette, this.idx, this.rgb.rgb565, this.rgb.cover, 0, this.fbH, this.fbW, this.fbH);
  }

  /** Inline single-pass spanfill (PERF-2 A fused core). */
  private runInline(list: SpanList, tex: Texture, light: LightBlock): void {

    if (this.dispatcher) {
      const f = this.dispatcher.frame();
      if (f !== this.clearedFrame) {
        this.idx.fill(0);
        this.zb.fill(0);
        this.clearedFrame = f;
      }
    }
    // Single kind-dispatched scan over the batch: replaces the old band
    // pre-filter scan plus the opaque/turbulent/flat triple scan per band.
    // Per-span setup mirrors
    // drawSpansSoftware/drawSpansTurbulent/drawSpansFlatPerSpan op-for-op
    // (clip, light resolve, skip-adjusted perspective start, 16-px
    // subdivision chain), so output is identical for the homogeneous
    // per-surface batches the frame loop emits, and matches the pooled
    // rasterizePackedRange list order otherwise. Bands need no partition
    // here: planes are shared, writes are depth-guarded, and spans on one
    // row keep list order exactly like the per-band filtered path.
    const idx = this.idx, zb = this.zb, fbW = this.fbW, fbH = this.fbH;
    const colormap = this.colormap;
    const texels = tex.texels;
    const { wshift, wmask, hmask } = textureMasks(tex);
    const turbTable = this.turbTable;
    const tmask = turbTable.length - 1;
    const phase = ((this.time * 64) | 0) & tmask;
    const spans = list.spans;
    const total = list.count < spans.length ? list.count : spans.length;
    let pixels = 0;
    let drawn = 0;
    for (let si = 0; si < total; si++) {
      const s = spans[si]!;
      const kind = s.kind;
      if (kind !== SPAN_OPAQUE && kind !== SPAN_TURBULENT && kind !== SPAN_FLAT) continue;
      if (s.y < 0 || s.y >= fbH) continue;
      let x0 = s.x0, x1 = s.x1;
      if (x0 < 0) x0 = 0;
      if (x1 > fbW) x1 = fbW;
      const count = x1 - x0;
      if (count <= 0) continue;
      if (kind === SPAN_FLAT) {
        // Flat fill mirrors drawSpansFlatPerSpan (sky index in s.light).
        runSpanFlat(idx, zb, s.y * fbW + x0, count, s.iz + s.diz * (x0 - s.x0), s.diz, s.light & 255);
        pixels += count;
        drawn++;
        continue;
      }
      const skip = x0 - s.x0;
      let iz = s.iz + s.diz * skip;
      let uz = s.uz + s.duz * skip;
      let vz = s.vz + s.dvz * skip;
      let u0 = uz / iz, v0 = vz / iz;
      let o = s.y * fbW + x0;
      let remaining = count;
      if (kind === SPAN_OPAQUE) {
        let lz = s.light, dlz = s.dlight;
        if (s.lv >= 0) {
          const l0 = sampleLightBlock(light, s.lu, s.lv);
          const l1 = sampleLightBlock(light, s.lu + s.dlu * count, s.lv);
          lz = l0;
          dlz = (l1 - l0) / count;
        }
        while (remaining > 0) {
          const m = remaining >= SUBDIV ? SUBDIV : remaining;
          const r = runSubdiv16(idx, zb, o, m, iz, s.diz, uz, s.duz, vz, s.dvz,
            u0, v0, lz, dlz, texels, wshift, wmask, hmask, colormap);
          iz = r.iz; lz = r.light;
          uz += s.duz * m; vz += s.dvz * m;
          u0 = r.u1; v0 = r.v1;
          o += m; remaining -= m;
        }
      } else {
        let lz = s.light;
        const tphase = (phase + s.turb) & tmask;
        while (remaining > 0) {
          const m = remaining >= SUBDIV ? SUBDIV : remaining;
          const r = runSubdivTurbulent(idx, zb, o, m, iz, s.diz, uz, s.duz, vz, s.dvz,
            u0, v0, lz, s.dlight, texels, wshift, wmask, hmask, colormap, turbTable, tphase);
          iz = r.iz; lz = r.light;
          uz += s.duz * m; vz += s.dvz * m;
          u0 = r.u1; v0 = r.v1;
          o += m; remaining -= m;
        }
      }
      pixels += count;
      drawn++;
    }
    this.spansDrawn += drawn;
    this.pixelsDrawn += pixels;
    this.bandList.count = 0;
  }

  /**
   * Bind the renderer's RGB overlay planes (packed RGB565 authority +
   * window-Z Uint16 depth + coverage; the Uint32 resolve scratch is
   * optional). Called every enabled frame (see SoftwareRenderer.beginFrame);
   * workers never touch these planes, so no SAB staging is involved.
   */
  attachRGB(rgb565: Uint16Array, cover: Uint8Array, rgbDepth: Uint16Array, w: number, h: number, color?: Uint32Array | null): void {
    this.rgb.attach(rgb565, cover, rgbDepth, w, h, color ?? null);
    this.bands = splitBands(h, this.bandCount);
  }

  /**
   * RGB span pass over the bands (perf-2 lane): one fused full-range call
   * when the bands contiguously partition the RGB frame (the splitBands
   * steady state), falling back to one kind-dispatched scan per band
   * otherwise. Both forms run the same monomorphic RGB loop as the serial
   * path (absolute screen coords ride the call — s.y, x from the absolute
   * x0 — so the Bayer mip-dither phase and band-seam rows are bit-identical
   * to serial either way) and draw the identical pixel set:
   * - every span touches exactly one row (y is constant per span) and all
   *   plane effects (rgb565 / cover / rgbDepth) are per-pixel reads+writes
   *   at o = y*fbW+x, so any two spans on different rows commute — even
   *   alpha/additive blends, which only read the destination pixel they
   *   also write, and even depth ties, which resolve per pixel;
   * - same-row spans keep list order in both forms (the band filter
   *   preserves order; the fused call is list order), so same-row overlap
   *   (opaque ties, alpha over opaque) resolves identically;
   * - the fused call covers exactly [0, rgbH): bands partitioning that
   *   range (checked per call, <=8 integer compares, no allocation) draw
   *   each in-range span once with identical parameters; out-of-range
   *   spans are skipped by the same guard in both forms.
   * Runs inline on the calling thread (workers only handle the indexed
   * planes); the single global composite in endFrame merges the planes
   * afterwards. Zero allocation.
   */
  drawSpansRGB(list: SpanList, mat: RGBMaterial, win?: RGBWindow | null): void {
    if (this.bandCount <= 1 || this.fbH <= 0) {
      this.rgb.drawSpansRGB(list, mat, win ?? null);
      return;
    }
    // Fused single-range call: one full-list scan draws the identical pixel
    // set as the per-band fan-out (proof above), saving (B-1) skip scans +
    // (B-1) per-batch call setups per batch. The partition check makes the
    // fallback airtight under any stale-band state (old behavior preserved).
    if (this.rgbBandsPartitionFrame()) {
      this.rgb.drawSpansRGB(list, mat, win ?? null);
      return;
    }
    const w = win ?? null;
    for (let b = 0; b < this.bands.length; b++) {
      const band = this.bands[b]!;
      this.rgb.drawSpansRGB(list, mat, w, band.y0, band.y1);
    }
  }

  /**
   * True when the bands contiguously partition [0, rgbFbH): band 0 starts at
   * row 0, each band starts where the previous ended, and the last ends at
   * the RGB frame height. splitBands establishes this by construction (last
   * band takes the remainder, so odd heights and bandCount > height stay
   * covered); the check guards stale bands after an asymmetric attach.
   */
  private rgbBandsPartitionFrame(): boolean {
    const H = this.rgb.fbH;
    if (H <= 0 || this.bands.length === 0) return false;
    if (this.bands[0]!.y0 !== 0) return false;
    let hi = 0;
    for (let b = 0; b < this.bands.length; b++) {
      const band = this.bands[b]!;
      if (band.y0 !== hi) return false;
      hi = band.y1;
    }
    return hi === H;
  }
}
