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
  SPAN_OPAQUE, SPAN_TURBULENT, SPAN_FLAT, SPAN_TRANS33, SPAN_TRANS66, SUBDIV, SoftwareBackend,
  buildTurbTable,
  runSubdiv16, runSubdivTurbulent, runSpanFlat, sampleLightBlock, textureMasks,
  type LightBlock, type RasterBackend, type Span, type SpanList, type Texture,
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
export const CTL_JOB = CTL_FCOUNT + 1; // kick type: 0 = rasterise, 1 = resolve (palette expand)
export const CTL_FRAME = CTL_JOB + 1; // frame generation (lazy per-band clear)
export const CTL_SCAN = CTL_FRAME + 1; // base; +MAX_WORKERS per-worker inspected-span counts (subrange proof)
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
export const CTL_EXEC = CTL_SCAN + MAX_WORKERS;
/** Control block length (CTL_EXEC owns the trailing MAX_WORKERS slots). */
export const CTL_LEN = CTL_EXEC + MAX_WORKERS;

/** Kick types for CTL_JOB (rasterise spans vs resolve the color plane). */
export const JOB_RASTER = 0;
export const JOB_RESOLVE = 1;

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

export function packBandSpans(
  list: SpanList, F: Float64Array, I: Int32Array,
): { count: number; est: number } | null {
  return packFrameSpans(list, F, I, 0, 0, MAX_BAND_SPANS);
}

/**
 * Offset-capable packer (single-batch and frame-accum share this loop, so
 * both pack paths produce identical flat data). Appends at (fBase, iBase),
 * refuses when the batch would exceed cap spans past the base. `start`
 * skips the first spans; defaults to 0 (whole list).
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
    // (the indexed raster core below skips TRANS kinds, so indexed output
    // is unchanged by their presence in the pack).
    if (s.kind !== SPAN_OPAQUE && s.kind !== SPAN_TURBULENT && s.kind !== SPAN_FLAT &&
      s.kind !== SPAN_TRANS33 && s.kind !== SPAN_TRANS66) continue;
    if (p >= cap) return null; // oversize -> inline fallback
    const o = (fBase + p) * F_PER_SPAN;
    F[o] = s.iz; F[o + 1] = s.diz; F[o + 2] = s.uz; F[o + 3] = s.duz;
    F[o + 4] = s.vz; F[o + 5] = s.dvz; F[o + 6] = s.light;
    F[o + 7] = s.dlight; F[o + 8] = s.lu; F[o + 9] = s.lv; F[o + 10] = s.dlu;
    // Vertical LOD footprint rides the flat copy (F_PER_SPAN = 13); the
    // indexed raster core below ignores [o+11, o+12] (horizontal-only LOD
    // there is unchanged).
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
export type BandJobLabel = 'raster' | 'resolve' | 'unknown';

/** CTL_JOB code → wire label. */
export function bandJobName(job: number): BandJobLabel {
  if (job === JOB_RASTER) return 'raster';
  if (job === JOB_RESOLVE) return 'resolve';
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
 *   indexed-world raster — single batch or frame-accum flush; 'resolve'),
 *   `frame` (CTL_FRAME generation), `y0`/`y1` (the band's row
 *   range for this kick).
 * - Work counts are what THIS band drained for THIS kick: `pixels`/`spans`
 *   (spanfill writes; 0 for resolve kicks, which still report a
 *   finite `execMs` for the band work they did), `scanned` (entries
 *   inspected — ordered subranges visit only owned rows), `tris`
 *   (always 0 — screen-tri staging was retired with the RGB path),
 *   `descs` (descriptors visited).
 * - `kickBase`/`kickDescs` identify the drained descriptor range so
 *   consumers can attribute individual flushes:
 *   frame kicks drain [0, fcount),
 *   single-batch raster kicks drain one batch (1/1) or nothing (0/0),
 *   resolve drains no descriptors (0/0).
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
 */
export function bandWorkerLoop(
  fav: FrameAccumViews, ctl: Int32Array,
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
    if (frame !== lastFrame && job !== JOB_RESOLVE) {
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
      // Resolve kick (M8.1 parallel resolve): expand the final index plane
      // into the shared color plane. No tally contribution by construction
      // (spans/pixels count spanfill, which this kick does not do).
      const pal = fav.fPal;
      resolveBand(fav.fColor, pal, views.idx, y0, y1, fbWNow, fbHNow);
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
    // whole batch). Zero for resolve kicks, which do no spanfill — the
    // dispatcher sums them only for raster kicks.
    try {
      Atomics.store(ctl, CTL_SCAN + band, drained.scanned);
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
   * Complete the resolve kick (M8.1 parallel resolve): the pool expands the
   * final index plane into the shared color plane. Falls back to an
   * identical serial expand on timeout/dead pool. `color` is the destination
   * plane (pool-adopted when pooled), `palette` the 768-byte RGB palette.
   * No-op without a dispatcher (caller expands serially instead).
   */
  resolveAccum(palette: Uint8Array, color: Uint32Array): void {
    const d = this.dispatcher;
    if (d && d.resolveFrame()) return;
    if (!d) return;
    resolveBand(color, palette, this.idx, 0, this.fbH, this.fbW, this.fbH);
  }

  /**
   * Same as resolveAccum but message-driven (browser async completion).
   */
  async resolveAccumAsync(palette: Uint8Array, color: Uint32Array): Promise<void> {
    const d = this.dispatcher;
    if (d && await d.resolveFrameAsync()) return;
    if (!d) return;
    resolveBand(color, palette, this.idx, 0, this.fbH, this.fbW, this.fbH);
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
}
