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
  SPAN_OPAQUE, SPAN_TURBULENT, SPAN_FLAT, SPAN_TRANS33, SPAN_TRANS66, SPAN_ADD, SUBDIV, SoftwareBackend, RGBWorldBackend,
  buildTurbTable,
  runSubdiv16, runSubdivTurbulent, runSpanFlat, sampleLightBlock, textureMasks,
  runSubdivRGBRepeat, runSubdivRGBClamp, runSubdivRGBGeneric, runSpanFlatRGB,
  rgbMipLevel,
  type LightBlock, type RasterBackend, type RGBLightmap, type RGBMaterial, type RGBMipLevel, type RGBWindow, type Span, type SpanList, type Texture,
} from './spans.js';
import {
  fillPerspTriRGB,
  TRI_F_PER_TRI, TRI_I_PER_TRI, TRI_MAX_TRIS,
  type PerspVert,
} from './alias.js';
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
export const CTL_RGBCOUNT = CTL_FRAME + 1; // RGB descriptors staged for the current kick (JOB_RGB only)
/**
 * First RGB descriptor of the current kick (retained-frame recovery
 * protocol, TASK item 1): flushes kick the suffix [RGBBASE, RGBCOUNT) —
 * descriptors the workers have not applied yet — while recovery replays
 * the full retained range [0, RGBCOUNT). Always 0 on legacy pools (which
 * reset descriptors on every flush, so suffix == all). Zero-initialised
 * SABs read 0 here, so older workers that ignore the slot behave exactly
 * like the legacy full-range kick.
 */
export const CTL_RGBBASE = CTL_RGBCOUNT + 1;
export const CTL_SCAN = CTL_RGBBASE + 1; // base; +MAX_WORKERS per-worker inspected-span counts (subrange proof)
/**
 * Base for per-worker completed-tri counts (TASK item 2, worker alias
 * rasterization): +MAX_WORKERS slots mirroring CTL_PIXELS/CTL_SPANS, so
 * the pool can attribute worker-completed tris separately from the
 * calling-thread band (item-3 counters). Zero-initialised SABs read 0 —
 * older workers that never write these slots report zero worker tris.
 */
export const CTL_TRIS = CTL_SCAN + MAX_WORKERS;
/**
 * Base for per-worker compute durations (PERF-NEXT-4 end-to-end timing):
 * +MAX_WORKERS slots mirroring CTL_PIXELS/CTL_SPANS, holding worker-local
 * execution milliseconds × 1000 (integer microseconds; -1 = band did not
 * run this kick). Written by the worker in the timing branch next to the
 * count slots, so the SYNC path — whose completion messages queue unread
 * while the main thread blocks in Atomics.wait — harvests the same
 * measurement from shared memory after the fence instead of depending on
 * message delivery. Zero-initialised SABs read 0 until the first kick
 * clears them to -1 (see `BandWorkerPool.kick`).
 */
export const CTL_EXEC = CTL_TRIS + MAX_WORKERS;
/** Control block length (CTL_EXEC owns the trailing MAX_WORKERS slots). */
export const CTL_LEN = CTL_EXEC + MAX_WORKERS;

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
/**
 * Staged span y-range, inclusive min / exclusive max row (worker-owned
 * band-cull, PERF-FINISH-A item B). Written once at staging time by
 * packBatched (one integer pass over the batch's staged spans — the
 * emitter already guarantees row order, so this is a pure bound read),
 * read by every worker BEFORE any material/view setup. The zero range
 * (ymax <= ymin) means "unknown" — legacy descriptors (older browser
 * pools), manual writers and empty batches fall through to the raster
 * core's own per-span y filter, so output is identical with or without
 * staged bounds.
 */
export const D_YMIN = 12;
export const D_YMAX = 13;
/**
 * Staged row-order proof (PERF-FINISH-A item B follow-up, true per-band
 * subranges): 1 when the batch's staged spans are in non-decreasing y
 * order (the emitter + row-sorter invariant), 0 otherwise. Recorded once
 * at staging time inside the existing ymin/ymax scan (one extra compare
 * per span, no second pass). Workers binary-search [y0, y1) subranges for
 * ordered batches and only iterate those entries; unordered/manual/legacy
 * descriptors (0, including zero-initialised SABs and older browser pools
 * that never wrote this field) take the legacy full-scan fallback, so
 * output is identical either way.
 */
export const D_ORDERED = 14;
export const D_PER_BATCH = 15;

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
export const R_SPAN_BASE = 0; // base into rgbSpansF/I (spans) or triF/triI (tris, R_FLAG_TRI)
export const R_SPAN_COUNT = 1; // packed span count (or tri count for R_FLAG_TRI)
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
/**
 * Staged row-order proof for RGB batches (same contract as D_ORDERED):
 * 1 when the staged spans are non-decreasing in y, else the legacy
 * full-scan fallback. Written by stageRGB inside its band-cull scan.
 */
export const R_ORDERED = 12;
/**
 * Per-batch alpha quantum for tri batches (TASK item 2, entity
 * translucency): 0..256, mirrors the serial alphaQ (256 = opaque).
 * Span batches reuse the per-kind ratio instead and leave this 0.
 */
export const R_ALPHAQ = 13;
export const R_PER_BATCH = 14;

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
/**
 * Upload-time opacity proof (perf remediation item 4): the staged chain's
 * masks are all-opaque, so the raster core skips the mask tap + hole
 * branch. Set by frame.ts from mat.opaqueMask; old writers leave it clear
 * (mask path, identical output).
 */
export const R_FLAG_OPAQUE = 256;
/**
 * Foreground alpha blend (PERF-FINISH-A renderer lane, task 1): the staged
 * batch carries SPAN_TRANS33/66 spans blended with a fixed per-kind ratio
 * (33% = 85/256, 66% = 169/256, mirroring drawSpansRGB's isTrans path),
 * never depth-writing. Set by the foreground stager for deferred-alpha
 * (and any future translucent foreground) batches; world batches leave it
 * clear (opaque path, identical output).
 */
export const R_FLAG_BLEND_ALPHA = 512;
/**
 * Additive blend (TASK item 2: tracer beams as spans). The batch carries
 * SPAN_ADD spans that add the sampled texel onto the stored quantum
 * (mirroring splatRGB) instead of replacing it. Depth-writes like opaque
 * (R_FLAG_DEPTHWRITE, matching the splat path) when set. Additive writes
 * are destination-dependent like alpha: the recovery treats them as
 * blends (suffix scan + blend-after-inline refusal), so they apply
 * exactly once.
 */
export const R_FLAG_ADDITIVE = 1024;
/**
 * Triangle batch (TASK item 2, worker model/gun rasterization): the
 * descriptor carries screen-space triangles (R_FLAG_TRI) instead of
 * spans. The tri payload lives in the triF/triI regions (see TRI_*), the
 * material resolves from the chain slot exactly like span batches, and
 * per-tri alpha rides R_ALPHAQ. Bands are disjoint row ranges, so
 * concurrent bands never share a pixel; within a band, tris run in
 * staged (serial) order — opaque + translucent blending, window-Z ties
 * (first wins) and coverage are bit-identical to the serial fill.
 */
export const R_FLAG_TRI = 2048;

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
  triFOff: number;
  triIOff: number;
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
  const triFOff = (rgbDescOff + MAX_RGB_BATCHES * R_PER_BATCH * 4 + 7) & ~7;
  const triIOff = triFOff + TRI_MAX_TRIS * TRI_F_PER_TRI * 8;
  const kickOff = (triIOff + TRI_MAX_TRIS * TRI_I_PER_TRI * 4 + 7) & ~7;
  // Scanout buffers (Track A parallel scanout): shared 565 target + display
  // plane. The shell adopts these when pooled so workers write the presented
  // frame directly (zero copy); the serial path ignores them.
  const scan565Off = (kickOff + SCAN_KICK_LEN * 8 + 7) & ~7;
  const scanDisplayOff = (scan565Off + n * 2 + 7) & ~7;
  const total = scanDisplayOff + n * 4;
  return {
    total, rgb565Off, coverOff, rgbDepthOff, spansFOff, spansIOff,
    chainOff, chainDirOff, levelOff, luxOff, rgbDescOff, triFOff, triIOff,
    kickOff, scan565Off, scanDisplayOff,
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
  /** Screen-space tri payload (TASK item 2): TRI_MAX_TRIS x TRI_F_PER_TRI f64. */
  triF: Float64Array;
  /** Per-tri row bounds (TASK item 2): TRI_MAX_TRIS x TRI_I_PER_TRI i32. */
  triI: Int32Array;
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
      triF: new Float64Array(sab, layout.triFOff, TRI_MAX_TRIS * TRI_F_PER_TRI),
      triI: new Int32Array(sab, layout.triIOff, TRI_MAX_TRIS * TRI_I_PER_TRI),
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
    // Opaque/turbulent/flat world spans plus translucent foreground spans
    // (deferred alpha stages into JOB_RGB after the world batches; the
    // indexed raster core below skips TRANS kinds, so indexed output is
    // unchanged by their presence in the pack). Additive tracer spans
    // ride along for the RGB kick (same transport; the indexed core below
    // skips them too).
    if (s.kind !== SPAN_OPAQUE && s.kind !== SPAN_TURBULENT && s.kind !== SPAN_FLAT &&
      s.kind !== SPAN_TRANS33 && s.kind !== SPAN_TRANS66 && s.kind !== SPAN_ADD) continue;
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
  /** Upload-time opacity proof: skips the mask tap + hole branch. */
  opaqueMask: boolean;
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
    opaqueMask: m.opaqueMask,
  };
}

const rgbTurbTable = buildTurbTable();

/**
 * Draw one band's share of flat-packed RGB spans [start, start+count).
 * Mirrors drawSpansRGB exactly (same order, same args, same chaining):
 * opaque spans take the hot repeat/clamp loops, warped or blended
 * (translucent foreground) spans take the generic effect path with the
 * same per-kind alpha ratios (TRANS33 = 85/256, TRANS66 = 169/256).
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
    const isTrans = kind === SPAN_TRANS33 || kind === SPAN_TRANS66;
    const isAdd = kind === SPAN_ADD;
    if (kind !== SPAN_OPAQUE && kind !== SPAN_TURBULENT && kind !== SPAN_FLAT && !isTrans && !isAdd) {
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
    // Same kind dispatch as drawSpansRGB's trans path: turbulent water
    // warps; translucent spans warp only when the material says so and
    // blend with the fixed per-kind ratio, never depth-writing (the
    // Generic core derives writeDepth from the blend, like serial).
    const useWarp = kind === SPAN_TURBULENT ? warp : (isTrans && mat.warp);
    const useBlend = isTrans
      ? (mat.blend === 'additive' ? 'additive' : 'alpha')
      : mat.blend;
    const useAlphaQ = isTrans && useBlend === 'alpha'
      ? (kind === SPAN_TRANS66 ? 169 : 85)
      : Math.round(mat.alpha * 256);
    let oo = y * fbW + x0;
    let remaining = n;
    let xRun = x0;
    if (!useWarp && useBlend === 'opaque' && mat.depthWrite) {
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
      // Effect path (warped and/or blended spans): same Generic call as
      // drawSpansRGB's trans path (blend + per-kind ratio, warp table only
      // when warping, phase from the staged turbPhase + span turb).
      const turbT = useWarp ? rgbTurbTable : null;
      while (remaining > 0) {
        const m = remaining >= SUBDIV ? SUBDIV : remaining;
        const r = runSubdivRGBGeneric(
          rgb565, cover, rgbDepth, oo, m, xRun, y,
          iz, sDiz, uz, sDuz, vz, sDvz, u0, v0, lux, sDlu, sLv,
          mat, spanLod, maxLevel, useBlend, useAlphaQ, turbT,
          turbT ? (turbPhase + turb) & (turbT.length - 1) : 0,
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

// Reused per-tri verts (no per-tri allocation on the worker path — workers
// are single-threaded, mirroring the jobTex/jobLight pattern).
const triWA: PerspVert = { x: 0, y: 0, iz: 0, uiz: 0, viz: 0, r: 0, g: 0, b: 0 };
const triWB: PerspVert = { x: 0, y: 0, iz: 0, uiz: 0, viz: 0, r: 0, g: 0, b: 0 };
const triWC: PerspVert = { x: 0, y: 0, iz: 0, uiz: 0, viz: 0, r: 0, g: 0, b: 0 };
// Reused projection window (same matWin pattern as the span core).
const triWin: { near: number; far: number } = { near: 4, far: 32768 };

/**
 * Draw one band's share of flat-packed screen tris [start, start+count).
 * Mirrors the serial alias fill exactly (same fillPerspTriRGB, same args,
 * same material resolution): the ONLY addition is the y-range band filter
 * (per-tri staged ymin/ymax) plus the fill's own row clamp — both provably
 * output-neutral (bands partition rows; the filler is row-independent).
 * Translucent tris blend with the descriptor's alphaQ and never
 * depth-write (like the serial entity path); opaque tris depth-write.
 * No allocation (module scratch triple + window).
 */
export function rasterizePackedTRIRange(
  rgb565: Uint16Array, cover: Uint8Array, rgbDepth: Uint16Array,
  fbW: number, fbH: number,
  triF: Float64Array, triI: Int32Array, start: number, count: number,
  mat: RGBMaterial,
  alphaQ: number,
  winNear: number, winFar: number,
  y0: number, y1: number,
): { pixels: number; tris: number } {
  triWin.near = winNear;
  triWin.far = winFar;
  const blend = mat.blend === 'alpha' ? 'alpha' : 'opaque';
  const depthWrite = blend === 'alpha' ? false : mat.depthWrite;
  let pixels = 0;
  let drawn = 0;
  for (let t = start; t < start + count; t++) {
    const q = t * TRI_I_PER_TRI;
    const ymin = triI[q]!;
    const ymax = triI[q + 1]!;
    if (ymax <= y0 || ymin >= y1) continue;
    const o = t * TRI_F_PER_TRI;
    const A = triWA, B = triWB, C = triWC;
    A.x = triF[o]!; A.y = triF[o + 1]!; A.iz = triF[o + 2]!; A.uiz = triF[o + 3]!;
    A.viz = triF[o + 4]!; A.r = triF[o + 5]!; A.g = triF[o + 6]!; A.b = triF[o + 7]!;
    B.x = triF[o + 8]!; B.y = triF[o + 9]!; B.iz = triF[o + 10]!; B.uiz = triF[o + 11]!;
    B.viz = triF[o + 12]!; B.r = triF[o + 13]!; B.g = triF[o + 14]!; B.b = triF[o + 15]!;
    C.x = triF[o + 16]!; C.y = triF[o + 17]!; C.iz = triF[o + 18]!; C.uiz = triF[o + 19]!;
    C.viz = triF[o + 20]!; C.r = triF[o + 21]!; C.g = triF[o + 22]!; C.b = triF[o + 23]!;
    pixels += fillPerspTriRGB(rgb565, cover, rgbDepth, fbW, fbH,
      A, B, C, mat, alphaQ, blend, depthWrite, triWin, y0, y1);
    drawn++;
  }
  return { pixels, tris: drawn };
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

/**
 * Fused expand + dither-subtract + clamp for the 2x2-subtract recon arm
 * (PERF-NEXT-6): `[phase * 32 + q] = clamp(expand5(q) - SCAN_RB2[phase])`
 * and the G variant `[phase * 64 + s]`. Same transform as
 * `@q2/voodoo` resolveFusedFrame's SUB2_RB/SUB2_G (ingredients are this
 * module's own SCAN tables, value-identical to voodoo's DITHER2 tables;
 * the enforced dependency rules forbid sw-renderer importing voodoo, so
 * the 2KB lives here — see the PORT-DIFF note in spans.ts). One load
 * replaces extract + bit-replicate expand + dither load + subtract +
 * double-clamp per tap-channel. ~2KB total, L1-resident, zero per-frame
 * alloc. Bit-identity is gated by the existing scanout parity tests
 * (fused display hashes + pooled≡serial).
 */
const SCAN_SUB2_RB: Readonly<Uint8Array> = (() => {
  const t = new Uint8Array(4 * 32);
  for (let ph = 0; ph < 4; ph++)
    for (let q = 0; q < 32; q++) {
      const e = (q << 3) | (q >> 2);
      const v = e - SCAN_RB2[ph]!;
      t[ph * 32 + q] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  return t;
})();

/** G-channel variant: `[phase * 64 + s] = clamp(expand6(s) - SCAN_G2[phase])`. */
const SCAN_SUB2_G: Readonly<Uint8Array> = (() => {
  const t = new Uint8Array(4 * 64);
  for (let ph = 0; ph < 4; ph++)
    for (let s = 0; s < 64; s++) {
      const e = (s << 2) | (s >> 4);
      const v = e - SCAN_G2[ph]!;
      t[ph * 64 + s] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  return t;
})();

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
      let r0: number; let g0: number; let b0: number;
      let r1: number; let g1: number; let b1: number;
      let r2: number; let g2: number; let b2: number;
      let r3: number; let g3: number; let b3: number;
      if (sub2) {
        // Fused expand + dither-subtract + clamp (PERF-NEXT-6): one table
        // load replaces extract + bit-replicate expand + dither load +
        // subtract + double-clamp per tap-channel. Phase = row phase | tap
        // column phase, same indexing as the code below replaces.
        // Bit-identical: each load equals that sequence exactly.
        const q00 = (v00 >> 11) & 31, q10 = (v10 >> 11) & 31;
        const q01 = (v01 >> 11) & 31, q11 = (v11 >> 11) & 31;
        const s00 = (v00 >> 5) & 63, s10 = (v10 >> 5) & 63;
        const s01 = (v01 >> 5) & 63, s11 = (v11 >> 5) & 63;
        const u00 = v00 & 31, u10 = v10 & 31;
        const u01 = v01 & 31, u11 = v11 & 31;
        const f00 = ph0 | (x & xmS), f10 = ph0 | (x1 & xmS);
        const f01 = ph1 | (x & xmS), f11 = ph1 | (x1 & xmS);
        r0 = SCAN_SUB2_RB[f00 * 32 + q00]!;
        r1 = SCAN_SUB2_RB[f10 * 32 + q10]!;
        r2 = SCAN_SUB2_RB[f01 * 32 + q01]!;
        r3 = SCAN_SUB2_RB[f11 * 32 + q11]!;
        g0 = SCAN_SUB2_G[f00 * 64 + s00]!;
        g1 = SCAN_SUB2_G[f10 * 64 + s10]!;
        g2 = SCAN_SUB2_G[f01 * 64 + s01]!;
        g3 = SCAN_SUB2_G[f11 * 64 + s11]!;
        b0 = SCAN_SUB2_RB[f00 * 32 + u00]!;
        b1 = SCAN_SUB2_RB[f10 * 32 + u10]!;
        b2 = SCAN_SUB2_RB[f01 * 32 + u01]!;
        b3 = SCAN_SUB2_RB[f11 * 32 + u11]!;
      } else {
        r0 = (((v00 >> 11) & 31) << 3) | (((v00 >> 11) & 31) >> 2);
        g0 = (((v00 >> 5) & 63) << 2) | (((v00 >> 5) & 63) >> 4);
        b0 = ((v00 & 31) << 3) | ((v00 & 31) >> 2);
        r1 = (((v10 >> 11) & 31) << 3) | (((v10 >> 11) & 31) >> 2);
        g1 = (((v10 >> 5) & 63) << 2) | (((v10 >> 5) & 63) >> 4);
        b1 = ((v10 & 31) << 3) | ((v10 & 31) >> 2);
        r2 = (((v01 >> 11) & 31) << 3) | (((v01 >> 11) & 31) >> 2);
        g2 = (((v01 >> 5) & 63) << 2) | (((v01 >> 5) & 63) >> 4);
        b2 = ((v01 & 31) << 3) | ((v01 & 31) >> 2);
        r3 = (((v11 >> 11) & 31) << 3) | (((v11 >> 11) & 31) >> 2);
        g3 = (((v11 >> 5) & 63) << 2) | (((v11 >> 5) & 63) >> 4);
        b3 = ((v11 & 31) << 3) | ((v11 & 31) >> 2);
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
 * Ordered batches (R_ORDERED) binary-search their owned subrange, so an
 * overlapping tall batch costs this band only its own rows; `scanned`
 * counts the entries actually inspected (vs `spansStaged` nominally
 * staged). Foreground alpha batches (R_FLAG_BLEND_ALPHA) ride the same
 * kick after the world batches, preserving world-before-foreground order
 * per band; they take the generic effect path with the serial per-kind
 * blend ratios, never depth-writing.
 */
export function processRGBFrameJob(
  rgb: RGBAccumViews,
  fbW: number, fbH: number, descCount: number,
  y0: number, y1: number,
  descBase = 0,
): { pixels: number; spans: number; descs: number; spansStaged: number; scanned: number; tris: number; trisStaged: number } {
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
    opaqueMask: false,
  };
  let pixels = 0;
  let drawn = 0;
  let descs = 0;
  let spansStaged = 0;
  let scanned = 0;
  let tris = 0;
  let trisStaged = 0;
  const b0 = descBase < 0 ? 0 : descBase;
  for (let b = b0; b < descCount; b++) {
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
    // True per-band subrange (same contract as the indexed path): ordered
    // batches binary-search the entries that can touch this band; sparse
    // rows with an empty intersection skip setup entirely; unordered /
    // legacy ranges fall back to the full scan, output-identical.
    let sBase = spanBase, sCount = spanCount;
    if (rgb.rgbDesc[d + R_ORDERED] === 1) {
      const yA = y0 < 0 ? 0 : y0;
      const yB = y1 > fbH ? fbH : y1;
      if (yB > yA) {
        const lo = lowerBoundRow(rgb.spansI, spanBase, spanCount, yA);
        const hi = lowerBoundRow(rgb.spansI, spanBase, spanCount, yB);
        if (hi <= lo) continue;
        sBase = spanBase + lo;
        sCount = hi - lo;
      } else {
        continue;
      }
    }
    descs++;
    spansStaged += spanCount;
    scanned += sCount;
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
    reuseMat.opaqueMask = (flags & R_FLAG_OPAQUE) !== 0;
    reuseMat.blend = (flags & R_FLAG_ADDITIVE) !== 0 ? 'additive'
      : (flags & R_FLAG_BLEND_ALPHA) !== 0 ? 'alpha' : 'opaque';
    // Triangle batches (TASK item 2): per-tri ymin/ymax band check, then
    // the exact alias filler restricted to this band. Material resolves
    // from the chain slot exactly like span batches; per-batch alpha rides
    // R_ALPHAQ (entity translucency), depthWrite/blend from flags.
    if ((flags & R_FLAG_TRI) !== 0) {
      const triBase = rgb.rgbDesc[d + R_SPAN_BASE]!;
      const triCount = rgb.rgbDesc[d + R_SPAN_COUNT]!;
      const alphaQ = rgb.rgbDesc[d + R_ALPHAQ]!;
      const tr = rasterizePackedTRIRange(
        rgb.rgb565, rgb.cover, rgb.rgbDepth, fbW, fbH,
        rgb.triF, rgb.triI, triBase, triCount,
        reuseMat, alphaQ,
        near, far,
        y0, y1,
      );
      pixels += tr.pixels;
      tris += tr.tris;
      // Unit clarity (item 3): tri batches must not pollute the span
      // counters — move this descriptor's contribution to trisStaged.
      // `scanned` counts inspected entries of either kind (documented).
      spansStaged -= triCount;
      trisStaged += triCount;
      continue;
    }
    const r = rasterizePackedRGBRange(
      rgb.rgb565, rgb.cover, rgb.rgbDepth, fbW, fbH,
      rgb.spansF, rgb.spansI, sBase, sCount,
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
  return { pixels, spans: drawn, descs, spansStaged, scanned, tris, trisStaged };
}

/**
 * First index in [base, base+count) whose staged span row is >= target.
 * Rows must be non-decreasing over the range (the D_ORDERED/R_ORDERED
 * staging proof); unordered ranges must use the legacy full-scan fallback
 * instead — binary search on unsorted rows would silently skip spans.
 * Operates on the flat Int32 staging (y rides slot +1), no allocation.
 */
export function lowerBoundRow(
  spansI: Int32Array, base: number, count: number, target: number,
): number {
  let lo = 0, hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spansI[(base + mid) * I_PER_SPAN + 1]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Rasterise one band's share of a frame kick: every descriptor in order,
 * each with its own staged (tex, light) setup. Bands are disjoint row
 * ranges so cross-band order cannot affect any pixel; within a band the
 * descriptors run sequentially in pack order, exactly like the equivalent
 * per-batch kicks. Bit-identical to the single-threaded path.
 *
 * PERF-FINISH-A item B (worker-owned ranges): each descriptor carries its
 * staged span y-range (D_YMIN/D_YMAX, written once at staging time by
 * packBatched). Bands with no overlap skip material + view setup entirely
 * BEFORE touching texel/light views — no per-worker rescan of the frame's
 * spans. A zero range (ymax <= ymin) means "unknown" (legacy / manual
 * descriptors) and falls through to the raster core's own per-span y
 * filter, so output is identical either way. True per-band subranges
 * (renderer lane task 2): ordered batches (D_ORDERED, staged once — no
 * per-worker validation) binary-search the entries that can touch the
 * band, so overlapping batches cost this band only its owned rows, even
 * with sparse rows; unordered ranges keep the full scan. Tallies add
 * band-cull observability: `descs` counts descriptors actually visited
 * (material resolved), `spansStaged` sums their staged span counts, and
 * `scanned` counts entries actually inspected, so
 * `descCount - descs` (minus empties) were rejected pre-setup.
 */
export function processFrameJob(
  fv: FrameAccumViews, fbW: number, fbH: number, descCount: number,
  y0: number, y1: number,
): { pixels: number; spans: number; descs: number; spansStaged: number; scanned: number } {
  const { base, fSpansF, fSpansI, fTex, fLight, desc } = fv;
  const colormap = base.colormap;
  const turbTable = base.turb;
  const total = descCount < MAX_FRAME_BATCHES ? descCount : MAX_FRAME_BATCHES;
  let pixels = 0;
  let drawn = 0;
  let descs = 0;
  let spansStaged = 0;
  let scanned = 0;
  for (let b = 0; b < total; b++) {
    const d = b * D_PER_BATCH;
    const spanBase = desc[d + D_SPAN_BASE]!;
    const spanCount = desc[d + D_SPAN_COUNT]!;
    if (spanCount <= 0) continue;
    // Worker-owned band-cull: staged bounds reject non-overlapping
    // descriptors BEFORE material + view setup. Unknown (zero) ranges
    // never cull — the raster core's per-span y filter below still
    // restricts them to the band, so output is identical.
    const ymin = desc[d + D_YMIN]!;
    const ymax = desc[d + D_YMAX]!;
    if (ymax > ymin && (ymax <= y0 || ymin >= y1)) continue;
    // True per-band subrange: ordered batches binary-search the entries
    // that can touch this band, so a worker inspects only its own rows
    // instead of rescanning the whole overlapping batch. Sparse rows are
    // exact (an empty intersection skips setup entirely); unordered /
    // legacy ranges fall back to the full scan, output-identical.
    let sBase = spanBase, sCount = spanCount;
    if (desc[d + D_ORDERED] === 1) {
      const yA = y0 < 0 ? 0 : y0;
      const yB = y1 > fbH ? fbH : y1;
      if (yB > yA) {
        const lo = lowerBoundRow(fSpansI, spanBase, spanCount, yA);
        const hi = lowerBoundRow(fSpansI, spanBase, spanCount, yB);
        if (hi <= lo) continue;
        sBase = spanBase + lo;
        sCount = hi - lo;
      } else {
        continue;
      }
    }
    descs++;
    spansStaged += spanCount;
    scanned += sCount;
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
      base.idx, base.zb, fbW, fbH, fSpansF, fSpansI, sBase, sCount,
      jobTex, jobLight,
      desc[d + D_WSHIFT]!, desc[d + D_WMASK]!, desc[d + D_HMASK]!,
      colormap, turbTable, desc[d + D_TURBPHASE]!,
      y0, y1,
    );
    pixels += r.pixels;
    drawn += r.spans;
  }
  return { pixels, spans: drawn, descs, spansStaged, scanned };
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
 * In-worker execution measurement (PERF-NEXT-4, Lane A: producer side).
 *
 * Three latencies, three clocks, never mixed:
 * - (a) worker compute — `BandExecSample.execMs`, measured INSIDE
 *   `bandWorkerLoop` around the band's drain for one kick, on ONE
 *   worker-local clock (`opts.now`, default `defaultBandWorkerNow()`).
 *   An epoch-free duration: comparable across workers as a duration, but
 *   NEVER subtracted from a caller-clock latency and never aligned onto
 *   the caller timeline (no shared epoch exists by design).
 * - (b) calling-thread band execution — `mainExecMs` on the pool's
 *   flush/dispatch tallies, measured on the CALLER clock around the
 *   main-band drain only (the main band runs concurrently with the
 *   workers, so this is not a critical-path term either).
 * - (c) caller dispatch-to-completion — measured by the caller around the
 *   whole kick (fence wait / message join); includes (a) plus scheduling,
 *   wakeup and delivery. Reported side by side with (a)/(b), never fused.
 */
export interface BandWorkerOptions {
  /**
   * Worker-local clock (must be monotonic; both endpoints of the measured
   * region use this same function, so the duration is epoch-free).
   * Defaults to `defaultBandWorkerNow()`. Injected (not imported) so the
   * shared loop stays platform-neutral: no DOM or Node types here.
   */
  now?: () => number;
  /**
   * Measure per-kick execution and post the full `BandExecSample` shape.
   * Default true. False restores the exact legacy completion shape
   * `{ seq, band, pixels, spans }` with zero clock reads (acceptance path).
   */
  timing?: boolean;
}

/**
 * Default worker-local clock: `performance.now` where present (Node 16+
 * workers, DOM workers) else `Date.now`. Resolved ONCE per loop entry and
 * used for both endpoints, so a duration never mixes time origins.
 */
export function defaultBandWorkerNow(): () => number {
  try {
    const g = globalThis as { performance?: { now?: () => number } };
    const perf = g.performance;
    // NOTE: keep the bound receiver: a detached `performance.now`
    // reference throws (needs its Performance receiver).
    if (perf && typeof perf.now === 'function') {
      const nowFn: () => number = perf.now.bind(perf);
      return () => nowFn();
    }
  } catch {
    /* fall through to Date.now */
  }
  return () => Date.now();
}

/**
 * Wire job label carried on `BandExecSample.job` (and preserved verbatim by
 * the browser entry stamper). Produced by `bandJobName()` from the CTL_JOB
 * code at the post site, so every consumer (Node pool stash, browser diag,
 * testkit parser, bench attribution) reads one vocabulary. The numeric CTL
 * code stays available in shared memory (`CTL_JOB`) for anyone who needs
 * it; the message carries the stable label. Unknown codes (forward-compat:
 * workers ignore kicks they do not understand) map to `'unknown'` — never
 * throw on a future code.
 */
export type BandJobLabel = 'raster' | 'resolve' | 'rgb' | 'scanout' | 'unknown';

/** CTL_JOB code → wire label. */
export function bandJobName(job: number): BandJobLabel {
  if (job === JOB_RASTER) return 'raster';
  if (job === JOB_RESOLVE) return 'resolve';
  if (job === JOB_RGB) return 'rgb';
  if (job === JOB_SCANOUT) return 'scanout';
  return 'unknown';
}

/**
 * Worker-local execution sample: the wire shape of the production worker
 * completion message (posted by `bandWorkerLoop` once per kick per worker
 * band when timing is enabled) and of the pool-side stash
 * (`BandDispatcher.lastWorkerExec`).
 *
 * - `execMs` is a FINITE number >= 0 for every executed kick, measured
 *   where the work ran (worker-local clock). Never null here: kicks that
 *   post no measurement (timing disabled, legacy senders) use the legacy
 *   `{ seq, band, pixels, spans }` shape instead, which consumers treat as
 *   "execution unmeasured" rather than zero.
 * - Identity reuses existing names: `seq` (job generation), `band` (worker
 *   band index), `job` (wire label from `bandJobName()`: 'raster' =
 *   indexed-world raster — single batch or frame-accum flush; 'resolve';
 *   'rgb' = RGB raster — world batches plus foreground suffixes and tris;
 *   'scanout'), `frame` (CTL_FRAME generation), `y0`/`y1` (the band's row
 *   range for this kick).
 * - Work counts are what THIS band drained for THIS kick: `pixels`/`spans`
 *   (spanfill writes; 0 for resolve/scanout kicks, which still report a
 *   finite `execMs` for the band work they did), `scanned` (entries
 *   inspected — ordered subranges visit only owned rows), `tris`
 *   (screen tris filled), `descs` (descriptors visited).
 * - `kickBase`/`kickDescs` identify the drained descriptor range so
 *   consumers can attribute individual flushes (e.g. a foreground-only
 *   suffix kick has `kickBase` == the previous kick's applied watermark):
 *   frame kicks drain [0, fcount), RGB kicks drain [rgbBase, rgbCount),
 *   single-batch raster kicks drain one batch (1/1) or nothing (0/0),
 *   resolve/scanout drain no descriptors (0/0).
 */
export interface BandExecSample {
  seq: number;
  band: number;
  frame: number;
  job: BandJobLabel;
  y0: number;
  y1: number;
  execMs: number;
  pixels: number;
  spans: number;
  scanned: number;
  tris: number;
  descs: number;
  kickBase: number;
  kickDescs: number;
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
  opts?: BandWorkerOptions,
): void {
  const views = fav.base;
  // Measurement switch, resolved ONCE per loop entry (not per kick): the
  // disabled path performs zero clock reads and posts the legacy shape.
  // The clock is ONE function for both endpoints of every measured region
  // (default performance.now/Date.now probe, or the injected entry-point
  // clock), so durations never mix time origins.
  const measure = opts === undefined || opts.timing !== false;
  const clock = measure
    ? (opts !== undefined && typeof opts.now === 'function' ? opts.now : defaultBandWorkerNow())
    : null;
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
    let drained: {
      pixels: number; spans: number; scanned: number; tris: number;
      descs: number; kickBase: number; kickDescs: number;
    };
    const t0 = clock !== null ? clock() : 0;
    if (job === JOB_RESOLVE) {
      // Resolve kick (M8.1 parallel resolve + PERF-5 fused composite): expand
      // the final index plane into the shared color plane, compositing the
      // RGB overlay where covered. No tally contribution by construction
      // (spans/pixels count spanfill, which this kick does not do). Fused
      // when RGB views exist (cover zero => plain expand, bit-identical).
      const pal = fav.fPal;
      if (rgb) resolveBandFused(fav.fColor, pal, views.idx, rgb.rgb565, rgb.cover, y0, y1, fbWNow, fbHNow);
      else resolveBand(fav.fColor, pal, views.idx, y0, y1, fbWNow, fbHNow);
      drained = { pixels: 0, spans: 0, scanned: 0, tris: 0, descs: 0, kickBase: 0, kickDescs: 0 };
    } else if (job === JOB_RGB) {
      // RGB raster kick (PERF-2 RGB workers): drain every staged RGB
      // descriptor for this band. No lazy clear: beginFrame clears the RGB
      // planes serially on the main thread (planes adopted, kick runs
      // after), so every band starts clean without a parallel clear.
      if (!rgb) {
        Com_Error('error', 'bandWorkerLoop: JOB_RGB without RGB views');
      }
      const rgbBase = Atomics.load(ctl, CTL_RGBBASE);
      const rgbCount = Atomics.load(ctl, CTL_RGBCOUNT);
      const rr = processRGBFrameJob(
        rgb, fbWNow, fbHNow, rgbCount, y0, y1,
        rgbBase,
      );
      drained = {
        pixels: rr.pixels, spans: rr.spans, scanned: rr.scanned,
        tris: rr.tris, descs: rr.descs, kickBase: rgbBase, kickDescs: rgbCount,
      };
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
      drained = { pixels: 0, spans: 0, scanned: 0, tris: 0, descs: 0, kickBase: 0, kickDescs: 0 };
    } else {
      const fcount = Atomics.load(ctl, CTL_FCOUNT);
      if (fcount > 0) {
        const fr = processFrameJob(fav, fbWNow, fbHNow, fcount, y0, y1);
        drained = {
          pixels: fr.pixels, spans: fr.spans, scanned: fr.scanned,
          tris: 0, descs: fr.descs, kickBase: 0, kickDescs: fcount,
        };
      } else {
        const single = readBandJob(ctl, y0, y1);
        const br = processBandJob(views, single);
        // Single packed batch: the core inspects all `count` staged spans
        // (per-span y filter), so scanned == staged; one descriptor drained
        // when anything was staged.
        drained = {
          pixels: br.pixels, spans: br.spans, scanned: single.count,
          tris: 0, descs: single.count > 0 ? 1 : 0,
          kickBase: 0, kickDescs: single.count > 0 ? 1 : 0,
        };
      }
    }
    const t1 = clock !== null ? clock() : 0;
    // Worker compute duration (latency (a)): one worker-local clock, both
    // endpoints. Non-finite or backward clock steps (Date.now fallback under
    // NTP) clamp to 0 — still finite, never a cross-clock delta.
    let execMs = 0;
    if (clock !== null) {
      const d = t1 - t0;
      execMs = Number.isFinite(d) && d >= 0 ? d : 0;
    }
    Atomics.store(ctl, CTL_PIXELS + band, drained.pixels);
    Atomics.store(ctl, CTL_SPANS + band, drained.spans);
    // Worker-compute duration slot (PERF-NEXT-4): integer microseconds of
    // the same worker-local interval posted on the completion message, so
    // the sync path harvests it from shared memory after the fence. -1 is
    // never written here (the kick clears all slots pre-notify; only an
    // executed band stores); clamps to int32 range.
    if (clock !== null) {
      try {
        const us = Math.round(execMs * 1000);
        Atomics.store(ctl, CTL_EXEC + band, us >= 0 && us <= 2147483647 ? us : 0);
      } catch {
        /* ignore */
      }
    }
    // Subrange proof (task 2): entries actually inspected by this band
    // (ordered subranges visit only owned rows; legacy fallbacks visit the
    // whole batch). Zero slots stay 0 for resolve/scanout kicks, which do
    // no spanfill — the dispatcher sums them only for raster/RGB kicks.
    try {
      Atomics.store(ctl, CTL_SCAN + band, drained.scanned);
    } catch {
      /* ignore */
    }
    // Completed-screen-tri count for the item-3 worker attribution
    // (TASK item 2; zero for span-only kicks).
    try {
      Atomics.store(ctl, CTL_TRIS + band, drained.tris);
    } catch {
      /* ignore */
    }
    Atomics.add(ctl, CTL_DONE, 1);
    try {
      Atomics.notify(ctl, CTL_DONE, 1);
    } catch {
      /* notify is best-effort; the dispatcher also polls on timeout */
    }
    if (clock !== null) {
      // Production completion (timing enabled): finite worker-compute
      // duration plus frame/sequence/job/band identity and actual work
      // counts. Consumers read only the fields they need; unknown fields
      // are ignored by older pools.
      const sample: BandExecSample = {
        seq: s, band, frame, job: bandJobName(job), y0, y1, execMs,
        pixels: drained.pixels, spans: drained.spans,
        scanned: drained.scanned, tris: drained.tris, descs: drained.descs,
        kickBase: drained.kickBase, kickDescs: drained.kickDescs,
      };
      try {
        port.postMessage(sample);
      } catch {
        /* async dispatch unavailable; the sync path already woke via notify */
      }
    } else {
      try {
        port.postMessage({ seq: s, band, pixels: drained.pixels, spans: drained.spans });
      } catch {
        /* async dispatch unavailable; the sync path already woke via notify */
      }
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
  ): { pixels: number; spans: number; mainExecMs?: number } | null;
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
  flushFrame(): { pixels: number; spans: number; scanned?: number; mainExecMs?: number } | null;
  /** Same as flushFrame but message-driven (browser async completion). */
  flushFrameAsync(): Promise<{ pixels: number; spans: number; scanned?: number; mainExecMs?: number } | null>;
  /** Full-frame inline replay of the accumulated batches (fallback). */
  drawInlineAll(): { pixels: number; spans: number; scanned?: number };
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
  /**
   * Kick one RGB frame covering every staged batch (blocking). Null = replay inline.
   *
   * PERF-NEXT-5 attribution taxonomy (both lanes): `pixels`/`spans`/`tris`
   * are the COMBINED kick totals (every band, worker + calling-thread);
   * `workerSpans`/`workerPixels`/`workerTris` count the WORKER bands only;
   * `mainSpans`/`mainPixels`/`mainTris` count the CALLING-THREAD band only
   * (the last band, drained inline while the workers run). Combined ==
   * worker + main exactly (spans/pixels; tris may exceed staged when one
   * tri straddles a band boundary and fills disjoint rows in both bands —
   * documented on the frame read path). Units are explicit per field
   * (spans vs pixels vs tris — never mixed in one field). Absent
   * `worker*`/`main*` fields (undefined) mean UNKNOWN (legacy shape without
   * the split — never 0-implies-nothing-ran and never worker-completed);
   * consumers map absent to the calling-thread band per the PERF-NEXT-5
   * interim rule until the pool mirrors the split.
   */
  flushRGBFrame(near: number, far: number, lodBias: number): { pixels: number; spans: number; scanned?: number; workerSpans?: number; workerPixels?: number; tris?: number; workerTris?: number; mainSpans?: number; mainPixels?: number; mainTris?: number; mainExecMs?: number } | null;
  /** Same as flushRGBFrame but message-driven (browser async completion). */
  flushRGBFrameAsync(near: number, far: number, lodBias: number): Promise<{ pixels: number; spans: number; scanned?: number; workerSpans?: number; workerPixels?: number; tris?: number; workerTris?: number; mainSpans?: number; mainPixels?: number; mainTris?: number; mainExecMs?: number } | null>;
  /**
   * Worker-local execution samples for the most recent kick (latency (a)
   * per worker band; see `BandExecSample`). Newest kick only: returns null
   * once a newer kick is issued until its completions arrive, when timing
   * is disabled, or when no completion posted a measurement (legacy shape).
   * Worker bands only — the calling-thread band share is `mainExecMs` on
   * the flush/dispatch tallies (latency (b)). Optional so legacy pools
   * without completion capture keep compiling.
   */
  lastWorkerExec?(): BandExecSample[] | null;
  /** Full-frame inline replay of the staged RGB batches (fallback). */
  drawInlineRGBAll(near: number, far: number, lodBias: number): { pixels: number; spans: number; scanned?: number; tris?: number };

  // --- Retained-frame RGB recovery protocol (TASK item 1) ---
  //
  // Failure classes (the pool distinguishes, the renderer recovers):
  //   a. Staging refusal before dispatch (stageRGB false: exhausted
  //      regions, unsupported material). Nothing staged ran — the suffix
  //      [flushed, descCount) never executed, so a clear-free ordered
  //      inline replay of the suffix converges. No quarantine needed.
  //   b. Failure before any writes (workers never ready, kick declined,
  //      disposed/quarantined). Same as (a): nothing ran.
  //   c. Failure after partial execution (kick timeout with workers
  //      running: some bands blended, incl. translucent alpha whose
  //      destination pixels are now partially blended). Recovery MUST clear
  //      the planes and replay the FULL retained range [0, descCount) in
  //      order with a background seed between the world prefix and the
  //      foreground suffix — re-blending over partial destinations would
  //      apply alpha twice. Merely skipping the clear is NOT a fix.
  //   d. Disposal/timeout while writes may be in flight: fence (quarantine:
  //      shutdown signal + replacement-buffer isolation + termination,
  //      refusing later kicks) BEFORE the replay, so no straggler SAB write
  //      can race the recovery or later frames. A bare
  //      `void worker.terminate()` is NOT a completion fence — the sync
  //      path relies on the isolation fence (fresh SAB + epoch bump; it
  //      cannot await termination), the async path additionally joins
  //      completed termination (bounded). Shared output planes/buffers must
  //      not be mutated or reused until old workers PROVABLY cannot write
  //      (acknowledged stop, awaited/completed termination, or fence-free
  //      isolated replacement buffers).
  //
  // Outcome vocabulary (both lanes): 'success' (kick applied, flushed
  // advanced), 'refused' (staging refusal — nothing dispatched, class a),
  // 'clean-failure' (dispatched but proven no writes landed: never-ready /
  // declined / pre-dispatch dispose / quarantined — class b), 'partial-failure'
  // (timeout with workers running, or mid-flight dispose — some writes may
  // have landed — class c/d, always quarantined first except the dispose
  // teardown path which already tore the workers down). The pool reports the last outcome via
  // lastRGBFailure ('clean' = refused/clean-failure, 'partial' =
  // partial-failure, null = success/none); checkpoint (chain) allocation
  // failure is a 'refused' outcome selected BEFORE dispatch — never a
  // best-effort replay over partial writes.
  //
  // Design (chosen): complete-frame replay with retained descriptors,
  // selective by suffix content. Descriptors (spans/chains/luxels) are
  // retained across flushes within a frame — flushes kick only the
  // unapplied suffix [flushed, descCount) via CTL_RGBBASE and advance
  // `flushed` on success; commitRGB() at frame end drops the retention.
  // Recovery replays in exact serial order, ending with flushed ==
  // descCount, choosing the replay shape by the suffix: an opaque-only
  // suffix replays in place (no clear — opaque writes are idempotent
  // under depth-guarded rewrite, and skipping the clear preserves inline
  // foreground writes that are not retained and could never be replayed:
  // alias/entities/particles drawn between kicks); a blend-carrying
  // suffix clears, replays the world prefix, re-seeds the background,
  // then replays the suffix (re-blending over partial destinations would
  // apply alpha twice). Checkpoint/restore was rejected (per-flush plane
  // copies cost more than the rare replay), and per-band recovery cannot
  // repair blended destinations without the same full replay. All pool
  // writes stay depth-guarded, so the replay converges to the exact
  // serial planes: world occlusion, coverage, depth, and exactly-once
  // alpha. The blend path clears only when no inline write exists: the
  // renderer refuses to stage blends once direct inline writes happened
  // (rgbDirectInlineWrites in frame.ts), so the clear can never discard
  // un-retained work.
  //
  // BROWSER MIRROR CONTRACT (browser pool owner): implement the three
  // optional methods below with the same semantics (suffix kicks via
  // CTL_RGBBASE, quarantine on timeout — the browser pool already
  // quarantines — retained descriptors until commitRGB, selective recover:
  // opaque-only suffix replays in place, blend suffix clears + replays
  // prefix + seed + suffix). PLUS the PERF-NEXT-2 fence: stop/isolate
  // writers BEFORE restoring or replaying shared planes (remove any
  // restore-before-quarantine ordering); handle timeout, disposal,
  // rejected dispatch and stale completion messages (stale seq completions
  // must never resolve a later kick); distinguish refused / clean-failure /
  // partial-failure per the outcome vocabulary above; select the
  // checkpoint-allocation-failure fallback BEFORE dispatch. Mirror
  // recoveryEpoch (fence epoch, bumped on every isolation) and
  // quarantineWorkersAsync (bounded completed-termination join) so the
  // renderer can re-adopt current planes and prove writers are gone. The
  // renderer feature-detects them: pools without them keep the legacy
  // behaviour (reset-on-flush, full replay of the pending set). Legacy
  // partial-failure recovery still destroys already-flushed world work —
  // that gap closes when the browser pool mirrors this protocol. PLUS the
  // PERF-NEXT-9 fence: a recovery after quarantine isolation must replay
  // the FULL retained range (the applied prefix died with the abandoned
  // buffer) — a suffix-only replay over cleared planes silently drops the
  // prefix. Never change raster math — transport and recovery only.
  //
  // --- end retained-frame recovery protocol ---
  //
  /** Applied prefix length: descriptors [0, flushed) already hold plane writes. Absent = legacy (0 after every flush). */
  rgbFlushed?(): number;
  /**
   * Fence epoch (PERF-NEXT-2): increments whenever quarantine isolates the
   * shared planes onto replacement buffers. Absent = legacy (no isolation).
   */
  recoveryEpoch?(): number;
  /**
   * Bounded completed-termination join for quarantined workers (async
   * path): resolves once doomed workers provably cannot write, or after
   * the bound (isolation already fenced the planes). Never rejects.
   * Absent = fire-and-forget termination (sync isolation only).
   */
  quarantineWorkersAsync?(timeoutMs?: number): Promise<void>;
  /** End-of-frame: drop all retained RGB descriptors (spans/lux/descs/flushed). Chains persist (cross-frame cache). */
  commitRGB?(): void;
  /**
   * Complete-frame recovery replay on the calling thread (classes a-d):
   * re-applies the retained descriptors in order with exactly-once
   * blends, selective by suffix content — an opaque-only unapplied suffix
   * replays in place (no clear, preserving non-retained inline writes);
   * a blend-carrying suffix clears, replays the world prefix, runs
   * `seed`, then replays the suffix. PERF-NEXT-9: after quarantine
   * isolation the applied prefix is gone with the abandoned buffer, so a
   * recovery with the isolation fence set replays the FULL retained range
   * [0, descCount) instead (opaque-only full ranges in place,
   * blend-carrying full ranges via clear + prefix + seed + suffix).
   * Infallible; the pool must already be quarantined when writes may have
   * been in flight (the timeout paths quarantine before returning null —
   * never replay while workers can still write). Ends with flushed ==
   * descCount. Returns the replay tally.
   */
  recoverInlineRGBAll?(seed: () => void, near: number, far: number, lodBias: number): { pixels: number; spans: number; scanned?: number; tris?: number };

  // --- Worker model/gun rasterization (TASK item 2) ---
  //
  // Alias (MD2 incl. viewmodel) triangles stage as R_FLAG_TRI batches
  // into the SAME descriptor table + kick as span batches, in exact serial
  // order (entity order among descriptors, staged order within). The
  // worker loop drains them with the exact serial filler
  // (fillPerspTriRGB) restricted to its band — bit-identical output.
  // BROWSER MIRROR CONTRACT: implement the two optional methods below
  // with the same semantics (tri payload regions, same descriptor layout
  // with R_FLAG_TRI/R_ALPHAQ, same suffix-kick + retained recovery —
  // processRGBFrameJob already handles TRI descriptors, so only staging
  // needs mirroring). The renderer feature-detects them and draws inline
  // when absent (identical output, no workers).
  //
  /** Flat-tri staging cursor: current bump base + remaining cap. Null when dead. Never advances (stageTriBatch owns that). */
  triCursor?(): { F: Float64Array; I: Int32Array; base: number; cap: number } | null;
  /**
   * Record one entity's prepared tri batch (triBase/triCount into the
   * triF/triI regions written via triCursor, chain deduped like span
   * batches, per-batch alpha for translucency). The pool scans the staged
   * tri rows for the descriptor y-range union (worker band-cull). Returns
   * false when the batch must run inline immediately (dead pool,
   * exhausted regions, too many chains/levels, oversized payload) — the
   * caller replays pending batches first so global batch order is
   * preserved. Never throws.
   */
  stageTriBatch?(
    triBase: number, triCount: number,
    levels: import('./spans.js').RGBMipLevel[],
    flags: number, zbits: number, alphaQ: number,
  ): boolean;
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
   * Returns worker span entries actually inspected (task-2 proof; 0 when
   * nothing was pending).
   */
  flushAccum(): number {    const d = this.dispatcher;
    if (!d || !this.accumEnabled || d.accumPending() === 0) return 0;
    const r = d.flushFrame();
    if (r) {
      this.spansDrawn += r.spans;
      this.pixelsDrawn += r.pixels;
      this.clearedFrame = d.frame();
      return r.scanned ?? 0;
    }
    const q = d.drawInlineAll();
    this.spansDrawn += q.spans;
    this.pixelsDrawn += q.pixels;
    this.clearedFrame = d.frame();
    return q.scanned ?? 0;
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
  async flushAccumAsync(): Promise<number> {
    const d = this.dispatcher;
    if (!d || !this.accumEnabled || d.accumPending() === 0) return 0;
    const r = await d.flushFrameAsync();
    if (r) {
      this.spansDrawn += r.spans;
      this.pixelsDrawn += r.pixels;
      this.clearedFrame = d.frame();
      return r.scanned ?? 0;
    }
    const q = d.drawInlineAll();
    this.spansDrawn += q.spans;
    this.pixelsDrawn += q.pixels;
    this.clearedFrame = d.frame();
    return q.scanned ?? 0;
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
