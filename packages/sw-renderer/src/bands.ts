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
  SPAN_OPAQUE, SPAN_TURBULENT, SoftwareBackend,
  buildTurbTable, drawSpansSoftware, drawSpansTurbulent,
  runSubdiv16, runSubdivTurbulent, sampleLightBlock, textureMasks,
  type LightBlock, type RasterBackend, type Span, type SpanList, type Texture,
} from './spans.js';
import { COLORMAP_SIZE } from './colormap.js';

/** Cvar gating the banded path. 0 = classic single buffer (default); N > 0 = N bands. */
export const SW_WORKERS_CVAR = 'sw_workers';
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

/** Doubles packed per span: iz diz uz duz vz dvz light dlight lu lv dlu. */
export const F_PER_SPAN = 11;
/** Ints packed per span: kind y x0 x1 turb. */
export const I_PER_SPAN = 5;

/** Surface texel / light-block staging caps (bytes) inside shared memory. */
const TEX_CAP = 65536; // 256x256, matches vd_maxtexsize
const LIGHT_CAP = 65536;
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
export const CTL_FRAME = CTL_READY + 1; // frame generation (lazy per-band clear)
export const CTL_LEN = CTL_FRAME + 1;

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

/** Serialize the raster-relevant spans of a batch into flat SAB staging. */
export function packBandSpans(
  list: SpanList, F: Float64Array, I: Int32Array,
): { count: number; est: number } | null {
  const spans = list.spans;
  const total = list.count < spans.length ? list.count : spans.length;
  let p = 0;
  let est = 0;
  for (let i = 0; i < total; i++) {
    const s = spans[i]!;
    if (s.kind !== SPAN_OPAQUE && s.kind !== SPAN_TURBULENT) continue;
    if (p >= MAX_BAND_SPANS) return null; // oversize -> inline fallback
    const o = p * F_PER_SPAN;
    F[o] = s.iz; F[o + 1] = s.diz; F[o + 2] = s.uz; F[o + 3] = s.duz;
    F[o + 4] = s.vz; F[o + 5] = s.dvz; F[o + 6] = s.light;
    F[o + 7] = s.dlight; F[o + 8] = s.lu; F[o + 9] = s.lv; F[o + 10] = s.dlu;
    const q = p * I_PER_SPAN;
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
  const colormap = v.colormap;
  const turbTable = v.turb;
  const tmask = turbTable.length - 1;
  let pixels = 0;
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    const q = i * I_PER_SPAN;
    const kind = spansI[q]!;
    const y = spansI[q + 1]!;
    const origX0 = spansI[q + 2]!;
    const origX1 = spansI[q + 3]!;
    const turb = spansI[q + 4]!;
    if (kind !== SPAN_OPAQUE && kind !== SPAN_TURBULENT) continue;
    if (y < job.y0 || y >= job.y1) continue;
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
    if (kind === SPAN_OPAQUE) {
      let lz = spansF[o + 6]!;
      let dlz = dlight;
      if (lv >= 0) {
        const l0 = sampleLightBlock(jobLight, lu, lv);
        const l1 = sampleLightBlock(jobLight, lu + dlu * n, lv);
        lz = l0;
        dlz = (l1 - l0) / n;
      }
      let u0 = uz / iz, v0 = vz / iz;
      let oo = y * fbW + x0;
      let remaining = n;
      while (remaining > 0) {
        const m = remaining >= 16 ? 16 : remaining;
        const r = runSubdiv16(idx, zb, oo, m, iz, diz, uz, duz, vz, dvz,
          u0, v0, lz, dlz, jobTex.texels, wshift, wmask, hmask, colormap);
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
      const phase = (job.turbPhase + turb) & tmask;
      while (remaining > 0) {
        const m = remaining >= 16 ? 16 : remaining;
        const r = runSubdivTurbulent(idx, zb, oo, m, iz, diz, uz, duz, vz, dvz,
          u0, v0, lz, dlight, jobTex.texels, wshift, wmask, hmask,
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
 */
export function bandWorkerLoop(
  views: BandViews, ctl: Int32Array,
  y0: number, y1: number, band: number, fbW: number,
  waitSeq: (seq: number) => void,
  port: BandPort,
): void {
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
    if (frame !== lastFrame) {
      views.idx.fill(0, y0 * fbW, y1 * fbW);
      views.zb.fill(0, y0 * fbW, y1 * fbW);
      lastFrame = frame;
    }
    const job = readBandJob(ctl, y0, y1);
    const r = processBandJob(views, job);
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
  readonly planes: { idx: Uint8Array; zb: Float32Array } | null;
  /** Current frame generation (lazy per-band clear coordination). */
  frame(): number;
  /** Bump the frame generation (lazy per-band clear on the next batch). */
  beginFrame(): void;
  dispatch(
    list: SpanList, tex: Texture, light: LightBlock,
    colormap: Uint8Array, time: number,
    fbW: number, fbH: number, idx: Uint8Array, zb: Float32Array,
  ): { pixels: number; spans: number } | null;
}

const BAND_CHUNK = 4096;

function createScratchSpan(): Span {
  return {
    kind: SPAN_OPAQUE,
    y: 0, x0: 0, x1: 0,
    iz: 0, diz: 0, uz: 0, duz: 0, vz: 0, dvz: 0,
    light: 63, dlight: 0, lu: 0, lv: -1, dlu: 0, turb: 0, ord: 0,
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
    if (this.dispatcher) {
      const r = this.dispatcher.dispatch(
        list, tex, light, this.colormap, this.time,
        this.fbW, this.fbH, this.idx, this.zb,
      );
      if (r) {
        this.spansDrawn += r.spans;
        this.pixelsDrawn += r.pixels;
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
    }
    // Inline banded: partition each chunk by row band, reuse the reference
    // loops. Zero allocation (scratch + bandList are backend-owned).
    const spans = list.spans;
    const total = list.count < spans.length ? list.count : spans.length;
    const nb = this.bands.length;
    let base = 0;
    while (base < total) {
      const end = Math.min(total, base + BAND_CHUNK);
      for (let b = 0; b < nb; b++) {
        const band = this.bands[b]!;
        let m = 0;
        for (let i = base; i < end; i++) {
          const s = spans[i]!;
          if (s.y >= band.y0 && s.y < band.y1) this.scratch[m++] = s;
        }
        if (m === 0) continue;
        this.bandList.count = m;
        const a = drawSpansSoftware(this.idx, this.zb, this.fbW, this.fbH, this.bandList, tex, light, this.colormap);
        const t = drawSpansTurbulent(this.idx, this.zb, this.fbW, this.fbH, this.bandList, tex, this.colormap, this.turbTable, this.time);
        this.spansDrawn += a.spans + t.spans;
        this.pixelsDrawn += a.pixels + t.pixels;
      }
      base = end;
    }
    this.bandList.count = 0;
  }
}
