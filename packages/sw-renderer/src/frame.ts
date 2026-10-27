// @q2/sw-renderer frame — r_main.c equivalent: R_SetupFrame, viewcluster,
// per-surface batching (surface cache -> edge emit -> row z-sort -> spans),
// alias/sprite/particle draws, palette resolve. Zero allocation per frame:
// every scratch buffer lives on the renderer instance.

import type {
  Entity, Framebuffer, FrameStats, Model, ModelHandle, RefDef, Refresh, TextureHandle, WorldModel,
} from '@q2/renderer-api';
import type { MiniLightmap } from './worldNodes.js';import { DLightState, LIGHT_OVERBRIGHT, LIGHT_STYLE_UNUSED, buildLightMap, luxelWorldPositions, type DynamicLight, type SurfaceBounds } from './light.js';
import { SurfaceCache, hashLightStyles, type SurfaceBlock } from './surfaceCache.js';
import { setupCamera, setupCameraInto, culledByFlatFrustum, type Camera } from './camera.js';
import {
  collectVisibleSurfaces, findLeaf, isMiniWorld,
  type MiniSurf, type MiniWorld,
} from './worldNodes.js';
import {
  countWrittenZb, createOverdrawDetail,
  type OverdrawDetail,
} from './overdraw.js';
import {
  createEdgeScratch, emitSpansForPoly, projectClippedPoly,
  type EdgeScratch, type EmitFlat, type PolyInput,
} from './edges.js';
import {
  SPAN_OPAQUE, SPAN_TURBULENT, SPAN_FLAT, SPAN_TRANS33, SPAN_TRANS66, buildTurbTable, createSpan,
  drawSpansTranslucent, drawSpansTurbulent, SoftwareBackend, translucencyModeFromCvars,
  type LightBlock, type RasterBackend, type Span, type SpanList, type Texture,
} from './spans.js';
import { WasmSpanBackend, wasmRequestedByCvar } from './wasmSpans.js';
import {
  BandedSoftwareBackend, createBandBuffers, sabAvailable, workersRequestedByCvar,
  accumRequestedByCvar,
  type BandDispatcher,
} from './bands.js';
import {
  buildANorms, buildShadeDots, createBoxMesh, createGunMesh, createGunSkin, createSoldierMesh, createSoldierSkin, md2ToAliasMesh, DEPTHHACK_SCALE, type AliasMesh,
} from './alias.js';
import { drawAliasInstance } from './alias.js';
import { drawTracerBeam, TRACER_DEFAULT_COLOR, TRACER_DEFAULT_LENGTH, TRACER_POOL_SIZE, TRACER_CORE_COLOR } from './tracer.js';
import { isValidSkySize, SKY_BOX_CORNERS, SKY_BOX_HALF, skyUvOnFace } from './sky.js';
import { AngleVectors } from '@q2/math';
import { drawSprite } from './sprites.js';
import { drawParticles, projectParticles, type ScreenParticle } from './particles.js';
import { buildColormap, buildAlphamapPair, defaultPalette, extractAlphamap33, extractAlphamap66, COLORMAP_PCX_PIXELS } from './colormap.js';
import { createDevroom, getDevMesh } from './devroom.js';

export const MAX_SPANS = 16384;
const MAX_ROW = 4096;

function isAliasMesh(data: unknown): data is AliasMesh {
  if (!data || typeof data !== 'object') return false;
  const m = data as Record<string, unknown>;
  return m.frames instanceof Float32Array && m.tris instanceof Uint16Array
    && typeof m.numVerts === 'number' && typeof m.numTris === 'number'
    && m.st instanceof Float32Array && m.normals instanceof Uint8Array;
}

/**
 * Per-phase frame attribution (M8.1 job §1): geometry (traversal +
 * surface-cache + project + emit + sort) vs spanfill vs resolve. Armed
 * only via testMeasurePhases(); the hot loop pays one null check per
 * surface when disarmed and output is identical either way.
 */
export interface FramePhases {
  /** Frame setup before the surface loop (camera, bounds fill, mark). */
  setup: number;
  /** R_MarkLeaves + dlight invalidation (world traversal setup). */
  mark: number;
  /** PVS walk + frustum/backface admission (collectVisibleSurfaces). */
  traverse: number;
  /** Surface-cache get + buildSurfaceBlock on miss. */
  cache: number;
  /** Per-surface frustum/backface/dist/mip/style checks + view writes. */
  cull: number;
  /** projectClippedPoly per admitted surface. */
  project: number;
  /** emitSpansForPoly + span kind/ord tagging. */
  emit: number;
  /** sortBatchByRow per batch. */
  sort: number;
  /** backend.drawSpans (spanfill: opaque + turbulent + flat passes). */
  draw: number;
  /** Alias/sprite/particle/tracer draws (world-placed + entities). */
  alias: number;
}

/** Sub-millisecond clock for phase probes. performance.now exists in Node
 *  16+ and browsers; falls back to Date.now where it does not. Only called
 *  while a measurement is armed, so the lookup costs nothing per frame. */
export function phaseNow(): number {
  try {
    const g = globalThis as { performance?: { now?: () => number } };
    if (g.performance && typeof g.performance.now === 'function') return g.performance.now();
  } catch {
    /* fall through */
  }
  return Date.now();
}

/** Zeroed phase accumulators (reused, no per-frame allocation). */
export function createFramePhases(): FramePhases {
  return { setup: 0, mark: 0, traverse: 0, cull: 0, cache: 0, project: 0, emit: 0, sort: 0, draw: 0, alias: 0 };
}

/** In-place per-row z-sort of a span batch: rows ascending, 1/z descending,
 *  BSP traversal order ascending (R_ScanEdges semantics, coplanar-stable).
 *
 *  M8.1 fast path: world-surface batches arrive from emitSpansForPoly in
 *  strictly increasing y with one span per row, so the counting sort is a
 *  proven no-op for them. A min/max pass finds the touched rows and a
 *  counting pass over that range verifies every bucket holds at most one
 *  span; when it does, rows are provably disjoint and order across rows
 *  cannot affect any pixel (or the drawn counts), so the function returns
 *  early. Anything else falls through to the exact legacy path below, over
 *  the same restricted range — output is identical in all cases. */
export function sortBatchByRow(
  spans: Span[], start: number, count: number, H: number,
  rowBase: Int32Array, tmp: Span[],
): void {
  if (count <= 1 || H <= 0) return;
  const h = H > MAX_ROW ? MAX_ROW : H;
  let ymin = h - 1, ymax = 0;
  for (let i = 0; i < count; i++) {
    let y = spans[start + i]!.y;
    if (y < 0) y = 0;
    else if (y >= h) y = h - 1;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  rowBase.fill(0, ymin, ymax + 2);
  let single = true;
  for (let i = 0; i < count; i++) {
    let y = spans[start + i]!.y;
    if (y < 0) y = 0;
    else if (y >= h) y = h - 1;
    const c = rowBase[y + 1]! + 1;
    rowBase[y + 1] = c;
    if (c > 1) single = false;
  }
  if (single) return;
  for (let y = ymin; y <= ymax; y++) rowBase[y + 1] += rowBase[y]!;
  for (let i = 0; i < count; i++) {
    let y = spans[start + i]!.y;
    if (y < 0) y = 0;
    else if (y >= h) y = h - 1;
    tmp[rowBase[y]++] = spans[start + i]!;
  }
  // tmp now holds spans grouped by row at [0, count); insertion-sort rows.
  let runStart = 0;
  // rowBase[y] was advanced; recompute boundaries via recount is wasteful:
  // instead sort by scanning runs of equal y.
  while (runStart < count) {
    const y = tmp[runStart]!.y;
    let runEnd = runStart + 1;
    while (runEnd < count && tmp[runEnd]!.y === y) runEnd++;
    for (let i = runStart + 1; i < runEnd; i++) {
      const t = tmp[i]!;
      const tiz = t.iz, tord = t.ord;
      let j = i - 1;
      while (j >= runStart && (tmp[j]!.iz < tiz || (tmp[j]!.iz === tiz && tmp[j]!.ord > tord))) {
        tmp[j + 1] = tmp[j]!;
        j--;
      }
      tmp[j + 1] = t;
    }
    runStart = runEnd;
  }
  for (let i = 0; i < count; i++) spans[start + i] = tmp[i]!;
}

interface RegisteredModel {
  kind: string;
  data: unknown;
  /** True when data is the procedural gun fallback (unknown md2 payload). */
  fallback: boolean;
}

/** Next power of two >= n (n >= 1). */
export function nextPot(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Resolve a lightmap's valid style scales into `out` (id faces carry up to
 * 4 slots, 255 = "no more styles"). Returns the valid count. Module scope
 * (not a per-surface closure) so the frame loop stays allocation-free.
 */
export function countValidStyles(
  lm: MiniLightmap, lightStyles: Float32Array, out: Float32Array,
): number {
  let nValid = 0;
  const maxStyles = Math.min(lm.styles.length, out.length);
  for (let k = 0; k < maxStyles; k++) {
    const idx = lm.styles[k]!;
    if (idx === LIGHT_STYLE_UNUSED) continue;
    out[nValid++] = lightStyles[idx] ?? 0;
  }
  return nValid;
}

export class SoftwareRenderer implements Refresh {
  private fbW = 0;
  private fbH = 0;
  private idx: Uint8Array = new Uint8Array(0);
  private zb: Float32Array = new Float32Array(0);
  private color: Uint32Array = new Uint32Array(0);
  private palette: Uint8Array = defaultPalette();
  private colormap: Uint8Array = buildColormap(this.palette);
  /**
   * Translucency blend tables (ref_soft vid.alphamap, one per ratio, both
   * indexed [(dst << 8) + src] — see colormap.ts). Rebuilt lazily from the
   * palette on the first translucent frame, or installed exactly from a
   * real colormap.pcx via setAlphamapFromColormapPcx (C-exact). Shared by
   * reference with nothing (renderer-owned); devroom never builds them
   * (no translucent surfaces), so the golden path pays nothing.
   */
  private alpha33: Uint8Array = new Uint8Array(0);
  private alpha66: Uint8Array = new Uint8Array(0);
  private alphaReady = false;
  /** Deferred alpha-pass spans drawn this frame (testTranslucentSpans). */
  private transSpans = 0;
  private readonly tsBackend = new SoftwareBackend();
  private backend: SoftwareBackend = this.tsBackend;
  private wasmBackend: WasmSpanBackend | null = null;
  private readonly bandBackend = new BandedSoftwareBackend();
  private bandSab: SharedArrayBuffer | null = null;
  private hostFb: Framebuffer | null = null;
  private cache = new SurfaceCache();
  private dlights = new DLightState();
  private lastDynSerial = 0;
  private models: RegisteredModel[] = [];
  private skins: Texture[] = [];
  private skinNames: string[] = [];
  private scratch: EdgeScratch = createEdgeScratch(64);
  private pool: Span[] = [];
  private spanList: SpanList = { spans: [], count: 0 };
  private spriteScratch: SpanList = { spans: [], count: 0 };
  private tmpSort: Span[] = [];
  private rowBase = new Int32Array(MAX_ROW + 1);
  private visSurfs: number[] = [];
  private visOrder: number[] = [];
  private surfBounds: SurfaceBounds[] = [];
  /** World the surfBounds mirror (identity + length checked per frame). */
  /**
   * Hoisted frustum planes (M8.1 hot path): 5× [nx,ny,nz,dist], refilled
   * once per renderView so the per-surface cull avoids the Camera record +
   * Float32Array property chasing (see culledByFlatFrustum). Zero alloc.
   */
  private frustumFlat = new Float64Array(20);
  /**
   * Per-lightmap style-hash memo (M8.1 hot path): the style hash depends
   * only on (lightId, lightStyles-for-this-frame), so surfaces sharing a
   * lightmap skip the style loop + FNV. Stamped by render frame; grown on
   * demand, never reallocated in steady state. A memo hit leaves
   * styleScratch holding another surface's scales, so a cache miss after a
   * hit refills it (scalesRefilled flag) before building the block.
   */
  private styleHashMemo = new Int32Array(0);
  private styleHashStamp = new Int32Array(0);
  /**
   * lightStyles array the memo was computed against (identity + frame must
   * both match for a hit: two views in one frame must not share hashes when
   * their style values differ).
   */
  private styleHashStyles: Float32Array | null = null;
  private boundsWorld: MiniWorld | null = null;
  private polyInput: PolyInput = {
    verts: new Float32Array(0), uvs: new Float32Array(0), lux: new Float32Array(0), n: 0,
  };
  private anorms = buildANorms();
  private shadeDots = buildShadeDots(this.anorms);
  private partPool: ScreenParticle[] = [];
  private partOrigins = new Float32Array(3 * 256);
  private partColors = new Uint8Array(256);
  /** Renderer-owned scratch camera (M8.1: setupCamera allocates per call). */
  private camMemo: Camera | null = null;
  /**
   * Reusable fused-emission descriptor (M8.1: emitSpansForPoly packs flat
   * spans while fields are L1-hot; no per-batch allocation). Only valid
   * for the batch it was built for — commitFlat consumes or drops it.
   */
  private emitFlat: EmitFlat = {
    F: new Float64Array(0), I: new Int32Array(0),
    base: -1, cap: 0, kind: 0, ord: 0,
    light: null, dlight: null, lv: null, written: -1,
  };
  private alphaDeferredSi: Int32Array = new Int32Array(0);
  private alphaDeferredOrd: Int32Array = new Int32Array(0);
  /** Per-recorded-surface dlight bits (resolved at deferral; read post-kick). */
  private alphaDeferredBits: Int32Array = new Int32Array(0);
  private frame = 0;
  private fallbackMesh = createBoxMesh(20);
  /** Procedural gun fallback (registerModel md2 without real data). Lazy. */
  private gunMeshMemo: AliasMesh | null = null;
  private gunSkinMemo: Texture | null = null;
  /** Olive-drab fallback skin for real MD2s with a missing skin handle. Lazy. */
  private soldierSkinMemo: Texture | null = null;
  /** Procedural soldier silhouette (missing-MD2 fallback shape). Lazy. */
  private soldierMeshMemo: AliasMesh | null = null;
  /** Palette index of the flat sky fill (recomputed per palette). */
  private skyIndex = 0;
  /**
   * Packed skybox strip for textured SURF_SKY (see sky.ts packing
   * contract): one tile per env/ suffix stacked vertically. Null = no
   * texture yet -> the flat-fill fallback (never the orange checker).
   */
  private skyTex: { width: number; height: number; texels: Uint8Array } | null = null;
  /** Per-vertex skybox UV scratch (grown on demand, reused per frame). */
  private skyUv = new Float32Array(64);
  /** Single box-face quad scratch (R_EmitSkyBox path: 4 verts, one face). */
  private skyBoxVerts = new Float32Array(12);
  private skyBoxUv = new Float32Array(8);
  private skyBoxLux = new Float32Array(8);
  /** Box already emitted this frame (id r_skyframe guard). Reset per render. */
  private skyBoxEmitted = false;
  /** Reusable sky UV out-param (no per-frame allocation). */
  private skyTmp = { u: 0, v: 0 };
  /** Reusable box-emission counters (no per-frame allocation). */
  private skyEmitAcc = { spans: 0, max: 0 };
  /** Renderer-owned tracer beams (spawnTracer ring, fixed pool, zero alloc). */
  private tracerSegs = new Float32Array(TRACER_POOL_SIZE * 6);
  private tracerColors = new Uint8Array(TRACER_POOL_SIZE);
  private tracerCores = new Uint8Array(TRACER_POOL_SIZE).fill(TRACER_CORE_COLOR);
  private tracerTtl = new Uint8Array(TRACER_POOL_SIZE);
  private tracerCursor = 0;
  private tracerFwd = new Float32Array(3);
  private tracerRight = new Float32Array(3);
  private tracerUp = new Float32Array(3);
  private lightBlockScratch: Uint8Array = new Uint8Array(0);
  /** Reusable per-luxel world-pos grid for dlight falloff (grown on demand). */
  private dluxScratch: Float32Array = new Float32Array(0);
  private styleScratch = new Float32Array(8);
  private frameStats: FrameStats = { spans: 0, pixels: 0, overdraw: 0, ms: 0 };
  /**
   * Stats partials stashed by renderView for finishStats() (see above).
   * Instance scratch — zero allocation, never read across frames.
   */
  private stSpansEmitted = 0;
  private stPixelsBase = 0;
  private stT0 = 0;
  /**
   * Async-render foreground deferral (browser lane): renderViewAsync runs
   * the world pass with `skipForeground` set (planes still owned by the
   * deferred pool kick), then draws the entity foreground after the kick
   * completes. The kick's lazy per-band clear would otherwise wipe direct
   * plane writes (alias/entities incl. the depthHack viewmodel, sprites,
   * particles, tracer beams, translucent alpha). Sync path unaffected (flag
   * defaults false). `fgCam`/`fgWorld`/`fgDyn`/`fgTMode`/`fgAlphaCount` are
   * the phase-1 refs (no allocation, never read across frames; the path is
   * non-reentrant by contract).
   */
  private skipForeground = false;
  private fgCam: Camera | null = null;
  private fgWorld: MiniWorld | null = null;
  private fgDyn: DynamicLight[] | null = null;
  private fgTMode = 0;
  private fgAlphaCount = 0;
  /**
   * Overdraw-attribution counters (M3.3 option b). Null unless a diagnostic
   * measurement is armed via testMeasureOverdraw(); the per-surface loop only
   * pays one null check per surface when disarmed, and output is identical
   * either way. R_MarkLeaves traversal and the strict `>` depth test below
   * are untouched.
   */
  private diagAcc: OverdrawDetail = createOverdrawDetail();
  private diagArmed = false;
  /**
   * Phase-timing accumulators (M8.1 attribution). Null unless a measurement
   * is armed via testMeasurePhases(); zero allocation when armed (reused
   * object), one null check per surface when disarmed.
   */
  private phaseAcc: FramePhases = createFramePhases();
  private phaseArmed = false;

  init(fb: Framebuffer): void {
    this.fbW = fb.width;
    this.fbH = fb.height;
    this.hostFb = fb;
    // Fresh init always returns to the classic planes (BRAIN.md §6); the
    // operator re-enables banded/wasm paths via the sync*FromCvar hooks.
    this.bandBackend.dispatcher = null;
    this.bandSab = null;
    this.backend = this.tsBackend;
    if (!fb.index) fb.index = new Uint8Array(fb.width * fb.height);
    this.idx = fb.index;
    this.zb = fb.depth;
    this.color = fb.color;
    this.pickSkyIndex();
    for (let i = 0; i < MAX_SPANS; i++) this.pool.push(createSpan());
    for (let i = 0; i < MAX_SPANS; i++) this.tmpSort.push(this.pool[i]!);
    this.spanList = { spans: this.pool, count: 0 };
    this.backend.attach(this.idx, this.zb, this.fbW, this.fbH, this.colormap);
  }

  /**
   * Build the WASM span backend for the current framebuffer size (M9.1).
   * Synchronous (module is ~1KB, compile is sub-millisecond) and infallible:
   * returns false when wasm is unavailable — the TS path stays active.
   * Must be called after init().
   */
  initWasm(): boolean {
    if (this.fbW <= 0 || this.fbH <= 0 || this.wasmBackend) return this.wasmBackend !== null;
    try {
      const wb = WasmSpanBackend.create(this.fbW, this.fbH);
      if (!wb) return false;
      wb.colormap = this.colormap;
      this.wasmBackend = wb;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Switch the active span backend. TS is the default (prime directive:
   * main stays green); the wasm backend is only used after initWasm().
   * Returns true when the requested backend is now active.
   */
  setWasmEnabled(on: boolean): boolean {
    if (on) {
      if (!this.wasmBackend && !this.initWasm()) return false;
      const wb = this.wasmBackend!;
      wb.attach(wb.idx, wb.zb, this.fbW, this.fbH, this.colormap);
      wb.time = this.backend.time;
      this.backend = wb;
      this.idx = wb.idx;
      this.zb = wb.zb;
      return true;
    }
    if (this.hostFb?.index) {
      this.backend = this.tsBackend;
      this.idx = this.hostFb.index;
      this.zb = this.hostFb.depth;
      this.backend.attach(this.idx, this.zb, this.fbW, this.fbH, this.colormap);
    }
    return !this.isWasmActive();
  }

  /** True when frames are currently rasterised by the wasm backend. */
  isWasmActive(): boolean {
    return this.backend instanceof WasmSpanBackend;
  }

  /**
   * Honour the `sw_wasm` cvar / `wasmSpans` feature flag: build the backend
   * (if needed) and switch to it when requested, back to TS otherwise.
   * Hosts call this after init(); safe to call every frame (no allocation
   * once the backend exists).
   */
  syncWasmFromCvar(): boolean {
    if (this.isWorkersActive()) return false;
    return this.setWasmEnabled(wasmRequestedByCvar());
  }

  /**
   * Honour the `sw_workers` cvar (M8.1): N > 0 selects the banded SAB path
   * (N horizontal bands over one SharedArrayBuffer, inline sequential
   * spanfill reusing the TS loop); 0 (default) restores the classic planes.
   * Never throws and never spawns threads: the pool is attached explicitly
   * (bench/headless parallel proof), browsers without SAB fall back here.
   * Call after init(); safe to call every frame (SAB reused across calls).
   */
  syncWorkersFromCvar(): boolean {
    try {
      const n = workersRequestedByCvar();
      if (!(n > 0) || this.fbW <= 0 || this.fbH <= 0 || !sabAvailable()) {
        this.disableBanded();
        return false;
      }
      if (this.isWasmActive()) this.setWasmEnabled(false);
      this.enableBanded(n);
      return true;
    } catch {
      this.disableBanded();
      return false;
    }
  }

  /** True when frames rasterise into SAB bands (inline or pool-driven). */
  isWorkersActive(): boolean {
    return this.backend === this.bandBackend;
  }

  /**
   * Attach (or detach with null) a thread pool for band batches. On attach
   * the renderer adopts the pool's shared planes (zero copy); the pool must
   * have been created for this W×H or the attach is ignored. Unsuitable
   * batches still run inline, so output stays bit-identical either way.
   */
  attachWorkerPool(pool: BandDispatcher | null): void {
    this.bandBackend.dispatcher = pool;
    if (pool && pool.planes && this.isWorkersActive()) {
      const p = pool.planes;
      if (p.idx.length === this.fbW * this.fbH && p.zb.length === this.fbW * this.fbH &&
        p.color.length === this.fbW * this.fbH &&
        p.idx.buffer === p.zb.buffer && p.idx.buffer === p.color.buffer) {
        this.idx = p.idx;
        this.zb = p.zb;
        this.color = p.color;
        this.bandBackend.attach(this.idx, this.zb, this.fbW, this.fbH, this.colormap);
      }
    }
  }

  /** Observability for bench/golden (BRAIN.md §10.3). */
  testWorkerStats(): { active: boolean; bands: number; pooled: boolean; spans: number; pixels: number } {
    return {
      active: this.isWorkersActive(),
      bands: this.isWorkersActive() ? this.bandBackend.bandCount : 1,
      pooled: this.isWorkersActive() && this.bandBackend.dispatcher !== null,
      spans: this.bandBackend.spansDrawn,
      pixels: this.bandBackend.pixelsDrawn,
    };
  }

  private enableBanded(n: number): void {
    const buf = createBandBuffers(this.fbW, this.fbH, this.bandSab);
    this.bandSab = buf.sab;
    this.idx = buf.idx;
    this.zb = buf.zb;
    this.bandBackend.attach(this.idx, this.zb, this.fbW, this.fbH, this.colormap);
    this.bandBackend.setBandCount(n);
    this.bandBackend.accumEnabled = accumRequestedByCvar();
    this.bandBackend.time = this.backend.time;
    this.backend = this.bandBackend;
  }

  private disableBanded(): void {
    this.bandBackend.dispatcher = null;
    if (this.backend === this.bandBackend) {
      this.backend = this.tsBackend;
      if (this.hostFb?.index) {
        this.idx = this.hostFb.index;
        this.zb = this.hostFb.depth;
        this.color = this.hostFb.color;
        this.backend.attach(this.idx, this.zb, this.fbW, this.fbH, this.colormap);
      }
    }
  }

  /** Live framebuffer views (wasm views when the wasm backend is active). */
  getFramebuffer(): Framebuffer {
    return {
      width: this.fbW, height: this.fbH,
      color: this.color, index: this.idx, depth: this.zb,
    };
  }

  setPalette(p: Uint8Array): void {
    this.palette = p.length >= 768 ? p.slice(0, 768) : defaultPalette();
    this.colormap = buildColormap(this.palette);
    this.pickSkyIndex();
    this.backend.colormap = this.colormap;
    if (this.wasmBackend) this.wasmBackend.colormap = this.colormap;
    this.bandBackend.colormap = this.colormap;
    // Blend tables follow the palette (lazily rebuilt on the next
    // translucent frame; a real colormap.pcx install is dropped too).
    this.alphaReady = false;
    this.alpha33 = new Uint8Array(0);
    this.alpha66 = new Uint8Array(0);
  }

  /**
   * Install the C-exact blend tables from parsed `pics/colormap.pcx`
   * pixels (shade rows + 256x256 alphamap, 81920 pixels for the 256x320
   * file). Internal extension like setSkyTexture (the frozen Refresh keeps
   * setPalette only). Returns false (keeping the procedural fallback) when
   * the pixels are too short — never throws, so headless/pak-less paths
   * stay green.
   */
  setAlphamapFromColormapPcx(pixels: Uint8Array): boolean {
    if (pixels.length < COLORMAP_PCX_PIXELS) return false;
    try {
      this.alpha33 = extractAlphamap33(pixels);
      this.alpha66 = extractAlphamap66(pixels);
      this.alphaReady = true;
      return true;
    } catch {
      return false;
    }
  }

  /** True once blend tables are installed or lazily built (test hook). */
  testAlphamapReady(): boolean {
    return this.alphaReady;
  }

  /** Lazily build the procedural blend pair (once per palette). */
  private ensureAlphamap(): void {
    if (this.alphaReady) return;
    const pair = buildAlphamapPair(this.palette);
    this.alpha33 = pair.a33;
    this.alpha66 = pair.a66;
    this.alphaReady = true;
  }

  registerModel(m: Model): ModelHandle {
    if (m.kind === 'md2') {
      // Real data wins: AliasMesh passes through, parsed MD2 output
      // (frames/normals/st/tris) converts via weld; anything else keeps the
      // procedural gun silhouette so enemies/weapons stay visible in devroom
      // instead of vanishing (the old unchecked path drew nothing).
      if (isAliasMesh(m.data)) {
        this.models.push({ kind: m.kind, data: m.data, fallback: false });
      } else {
        const conv = md2ToAliasMesh(m.data);
        if (conv) this.models.push({ kind: m.kind, data: conv, fallback: false });
        else this.models.push({ kind: m.kind, data: this.getGunMesh(), fallback: true });
      }
    } else {
      this.models.push({ kind: m.kind, data: m.data, fallback: false });
    }
    return this.models.length - 1;
  }

  registerSkin(name: string): TextureHandle {
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const size = 32;
    const texels = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const c = (((x >> 3) + (y >> 3) + (h & 7)) & 1) === 0 ? 200 : 90;
        texels[y * size + x] = (c + ((h >> (x & 7)) & 15)) & 255;
      }
    }
    this.skins.push({ width: size, height: size, texels });
    this.skinNames.push(name);
    return this.skins.length - 1;
  }

  /**
   * Register real texture data (WAL mip-0 texels or PCX pixels — both are
   * palette indices): stored directly instead of the checker fallback.
   * Non-power-of-two dims (e.g. soldier skin 288 wide) are expanded to POT
   * by edge repeat, since the affine sampler indexes with masks; st stays
   * in texel units so MD2 coords need no remap. Invalid input falls back
   * to the checker path and still returns a valid handle — never breaks.
   * Internal extension: the frozen Refresh keeps registerSkin(name) only.
   */
  registerSkinData(name: string, texels: Uint8Array, width: number, height: number): TextureHandle {
    const ok = Number.isInteger(width) && Number.isInteger(height)
      && width >= 1 && height >= 1 && width <= 1024 && height <= 1024
      && texels.length === width * height;
    if (!ok) return this.registerSkin(name);
    const pw = nextPot(width), ph = nextPot(height);
    let owned: Uint8Array;
    if (pw === width && ph === height) {
      owned = texels.slice();
    } else {
      owned = new Uint8Array(pw * ph);
      for (let y = 0; y < height; y++) {
        owned.set(texels.subarray(y * width, (y + 1) * width), y * pw);
        const edge = texels[y * width + width - 1]!;
        for (let x = width; x < pw; x++) owned[y * pw + x] = edge;
      }
      for (let y = height; y < ph; y++) {
        owned.set(owned.subarray((height - 1) * pw, height * pw), y * pw);
      }
    }
    this.skins.push({ width: pw, height: ph, texels: owned });
    this.skinNames.push(name);
    return this.skins.length - 1;
  }

  /** PCX-pixel alias of registerSkinData (both are palette indices). */
  registerSkinPixels(name: string, pixels: Uint8Array, width: number, height: number): TextureHandle {
    return this.registerSkinData(name, pixels, width, height);
  }

  /** Procedural gun fallback mesh (registerModel md2 without real data). */
  getGunMesh(): AliasMesh {
    if (!this.gunMeshMemo) this.gunMeshMemo = createGunMesh();
    return this.gunMeshMemo;
  }

  /** Flat gunmetal skin for the fallback gun mesh. */
  getGunSkin(): Texture {
    if (!this.gunSkinMemo) {
      const g = createGunSkin();
      this.gunSkinMemo = { width: g.width, height: g.height, texels: g.texels };
    }
    return this.gunSkinMemo;
  }

  /** Olive-drab fallback skin for real MD2s with a missing skin handle. */
  getSoldierSkin(): Texture {
    if (!this.soldierSkinMemo) {
      const g = createSoldierSkin();
      this.soldierSkinMemo = { width: g.width, height: g.height, texels: g.texels };
    }
    return this.soldierSkinMemo;
  }

  /** Procedural soldier silhouette (missing-data fallback shape, asset-free). */
  getSoldierMesh(): AliasMesh {
    if (!this.soldierMeshMemo) this.soldierMeshMemo = createSoldierMesh();
    return this.soldierMeshMemo;
  }

  /**
   * Pick the flat-sky palette index: the bluest bright entry. Recomputed
   * per palette (setPalette + init) so the sky reads sky-blue under both
   * the procedural test palette and the real `colormap.pcx` palette.
   */
  private pickSkyIndex(): void {
    const pal = this.palette;
    let best = 0, bs = -Infinity;
    for (let i = 0; i < 256; i++) {
      const r = pal[i * 3]!, g = pal[i * 3 + 1]!, b = pal[i * 3 + 2]!;
      const s = 2 * b - r - g + (r + g + b) / 32;
      if (s > bs) { bs = s; best = i; }
    }
    this.skyIndex = best;
  }

  /** Live flat-sky palette index (observability, test hook). */
  testSkyIndex(): number {
    return this.skyIndex;
  }

  /**
   * Set the packed skybox strip sampled by SURF_SKY surfaces (the web side
   * resolves `env/<sky><suffix>.pcx` from the pak and packs them; the
   * renderer never touches the pak).
   *
   * PACKING CONTRACT (see sky.ts — do not deviate, a parallel agent wires
   * the web side to exactly this):
   * - ONE texture: 6 tiles stacked VERTICALLY, top-to-bottom in filename
   *   suffix order [rt, bk, lf, ft, up, dn] (id `suf` in R_SetSky).
   * - tex.width = ONE tile wide, power of two (256 for real env/ PCX).
   * - tex.height = 6 * tileH, tileH = height/6 any positive int (256 real).
   * - 8-bit palette indices, top row = v 0 (PCX row order), unlit sample
   *   (D_SkySurf has no lightmap: colormap grade 63 = identity).
   * Invalid sizes and null clear the texture -> graceful flat-fill
   * fallback (current skyIndex). Never throws, copies the texels.
   */
  setSkyTexture(tex: { texels: Uint8Array; width: number; height: number } | null): void {
    if (!tex || !isValidSkySize(tex.width, tex.height) ||
      tex.texels.length !== tex.width * tex.height) {
      this.skyTex = null;
      return;
    }
    this.skyTex = { width: tex.width, height: tex.height, texels: tex.texels.slice() };
  }

  /**
   * Spawn a renderer-owned tracer beam (blaster bolt / shotgun pellet):
   * origin + direction + length + palette-index color, drawn with a 1/z
   * depth test for ttlFrames renders, then expires. Fixed pool (ring
   * overwrite when full), zero allocation. Internal extension — game code
   * feature-detects it exactly like testAddDynamicLight; entities with a
   * kind-'tracer' model are the contract-free alternative (see renderView).
   */
  spawnTracer(
    origin: ArrayLike<number>,
    dir: ArrayLike<number>,
    color = TRACER_DEFAULT_COLOR,
    length = TRACER_DEFAULT_LENGTH,
    ttlFrames = 3,
    core = TRACER_CORE_COLOR,
  ): boolean {
    const dx = dir[0] ?? 0, dy = dir[1] ?? 0, dz = dir[2] ?? 0;
    const len0 = Math.hypot(dx, dy, dz);
    if (!(len0 > 0)) return false;
    const inv = 1 / len0;
    const len = length > 0 ? Math.min(length, 1024) : TRACER_DEFAULT_LENGTH;
    const ox = origin[0] ?? 0, oy = origin[1] ?? 0, oz = origin[2] ?? 0;
    let slot = -1;
    for (let i = 0; i < TRACER_POOL_SIZE; i++) {
      const s = (this.tracerCursor + i) % TRACER_POOL_SIZE;
      if (this.tracerTtl[s] === 0) { slot = s; break; }
    }
    if (slot < 0) {
      slot = this.tracerCursor;
      this.tracerCursor = (this.tracerCursor + 1) % TRACER_POOL_SIZE;
    } else {
      this.tracerCursor = (slot + 1) % TRACER_POOL_SIZE;
    }
    const o = slot * 6;
    this.tracerSegs[o] = ox;
    this.tracerSegs[o + 1] = oy;
    this.tracerSegs[o + 2] = oz;
    this.tracerSegs[o + 3] = ox + dx * inv * len;
    this.tracerSegs[o + 4] = oy + dy * inv * len;
    this.tracerSegs[o + 5] = oz + dz * inv * len;
    this.tracerColors[slot] = color & 255;
    this.tracerCores[slot] = core & 255;
    this.tracerTtl[slot] = Math.max(1, Math.min(ttlFrames | 0, 255));
    return true;
  }

  /** Live renderer-owned tracer count (observability, test hook). */
  testTracerCount(): number {
    let n = 0;
    for (let i = 0; i < TRACER_POOL_SIZE; i++) if (this.tracerTtl[i] !== 0) n++;
    return n;
  }

  beginFrame(): void {
    this.frame++;
    this.cache.nextFrame();
    // Pooled band path: bands clear lazily per frame generation (parallel
    // clear, no serial fill); every other path fills here as before.
    const pooled = this.backend === this.bandBackend ? this.bandBackend.dispatcher : null;
    if (pooled) {
      pooled.beginFrame();
      pooled.stagePalette(this.palette);
      this.bandBackend.batchesDrawn = 0;
      // A new frame stages from empty regions: the deferred inline-rest
      // latch from any previous frame must not leak into this one.
      this.bandBackend.deferredInlineRest = false;
    } else {
      this.idx.fill(0);
      this.zb.fill(0);
    }
    this.backend.spansDrawn = 0;
    this.backend.pixelsDrawn = 0;
    this.backend.time = 0;
    this.transSpans = 0;
  }

  renderView(view: RefDef, world: WorldModel, entities: Entity[]): FrameStats {
    const t0 = Date.now();
    const ph = this.phaseArmed ? this.phaseAcc : null;
    let pt = ph ? phaseNow() : 0;
    const worldData = isMiniWorld(world.data) ? world.data : createDevroom();
    // Reuse the scratch camera across frames (allocation-free steady state;
    // bit-identical to a fresh setupCamera — see setupCameraInto).
    const cam = this.camMemo
      ? setupCameraInto(this.camMemo, view.origin, view.angles, view.fovX, this.fbW, this.fbH)
      : (this.camMemo = setupCamera(view.origin, view.angles, view.fovX, this.fbW, this.fbH));
    this.backend.time = view.time;
    // Renderer-owned dynamic lights (muzzle flashes) age out on their own:
    // expire before the serial check so a stale flash invalidates the cache
    // exactly once and the scene returns to baseline even when the caller
    // never calls clear (M6.1 muzzle-leak fix, renderer side). A live flash
    // is re-added every frame, so expiry only drops abandoned lights.
    this.dlights.expireStaleLights();
    // Skybox emission guard (id r_skyframe): at most one box per frame no
    // matter how many SURF_SKY surfaces are visible.
    this.skyBoxEmitted = false;
    // dynamic lights -> cache invalidation (serial change = add/remove)
    if (this.dlights.serial !== this.lastDynSerial) {
      this.cache.invalidateAll();
      this.lastDynSerial = this.dlights.serial;
    }
    const nSurfs = worldData.surfaces.length;
    // R_MarkLeaves input: mirror (id, mins, maxs) per surface. Worlds are
    // static per level, so refill only when the world identity or surface
    // count changes (movers mutate contents in place through the same
    // Float32Array refs, which stay valid). Saves ~8K×3 stores/frame.
    const bounds = this.surfBounds;
    if (this.boundsWorld !== worldData || bounds.length !== nSurfs) {
      bounds.length = 0;
      while (bounds.length < nSurfs) {
        bounds.push({ id: 0, mins: new Float32Array(3), maxs: new Float32Array(3) });
      }
      for (let i = 0; i < nSurfs; i++) {
        const s = worldData.surfaces[i]!;
        const b = bounds[i]!;
        b.id = s.id;
        b.mins = s.mins;
        b.maxs = s.maxs;
      }
      this.boundsWorld = worldData;
    }
    const dyn: DynamicLight[] = this.dlights.lights.length > 0
      ? this.dlights.lights
      : worldData.dynamicLights;
    if (ph) { ph.setup += phaseNow() - pt; pt = phaseNow(); }
    // Hoist the frustum once per frame into the flat scratch (the
    // per-surface cull below reads these locals, not the Camera record).
    {
      const fp = this.frustumFlat;
      const fr = cam.frustum;
      for (let i = 0; i < 5; i++) {
        const p = fr[i]!;
        fp[i * 4] = p.normal[0]!;
        fp[i * 4 + 1] = p.normal[1]!;
        fp[i * 4 + 2] = p.normal[2]!;
        fp[i * 4 + 3] = p.dist;
      }
    }
    // Style-hash memo: sized to the world's lightmap count (grown on
    // demand). Stamps use the render frame, so no per-frame clearing.
    if (this.styleHashMemo.length < worldData.lightmaps.length) {
      this.styleHashMemo = new Int32Array(worldData.lightmaps.length);
      this.styleHashStamp = new Int32Array(worldData.lightmaps.length);
    }
    const dlState = this.dlights;
    const savedLights = dlState.lights;
    dlState.lights = dyn;
    const affected = dlState.markLights(bounds, nSurfs);
    dlState.lights = savedLights;
    if (affected.length > 0) this.cache.invalidateSurfaces(affected);
    const hasRendererLights = savedLights.length > 0;
    const dlightFrameBits = (id: number): number => {
      if (hasRendererLights) return dlState.bitsFor(id);
      // world-embedded lights always affect bit 0 when marked this frame.
      // `affected` is sorted ascending (markLights), so binary search.
      let lo = 0, hi = affected.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const v = affected[mid]!;
        if (v === id) return 1;
        if (v < id) lo = mid + 1;
        else hi = mid;
      }
      return 0;
    };
    if (ph) { ph.mark += phaseNow() - pt; pt = phaseNow(); }

    // viewcluster + traversal
    const leaf = worldData.nodes.length === 0 ? 0 : findLeaf(worldData.nodes, view.origin);
    const viewCluster = worldData.leafs[leaf]?.cluster ?? 0;
    while (this.visSurfs.length < worldData.surfaces.length) {
      this.visSurfs.push(0);
      this.visOrder.push(0);
    }
    const nvis = collectVisibleSurfaces(worldData, cam, viewCluster, this.visSurfs, this.visOrder);
    if (ph) { ph.traverse += phaseNow() - pt; pt = phaseNow(); }

    let spansEmitted = 0;
    let candidatePixels = 0;
    // Diagnostic only: attribute every PVS-admitted surface to exactly one
    // bucket (degenerate / frustum / backface / clip / emitted).
    const d = this.diagArmed ? this.diagAcc : null;
    if (d) {
      d.surfaces = worldData.surfaces.length;
      d.pvsVisible = nvis;
      d.degenerate = 0;
      d.frustumCulled = 0;
      d.backfaceCulled = 0;
      d.clipRejected = 0;
      d.emitted = 0;
      d.maxBatchSpans = 0;
      d.candidatePixels = 0;
    }
    // per-surface batches: cache -> emit -> row z-sort -> draw
    const pixelsBase = this.backend.pixelsDrawn;
    // Translucency (SURF_TRANS33/66): C draws alpha surfaces AFTER all
    // opaque geometry (R_DrawAlphaSurfaces, depth-tested, never
    // depth-writing, back-to-front). SINGLE WALK: the main loop below admits
    // each visible surface once (frustum/backface cull runs a single time)
    // and records translucent surfaces into the deferred alpha list; the
    // alpha loop after it draws them in reverse traversal order through the
    // same cache/emit/sort pipeline via drawSpansTranslucent.
    // r_translucency = 0 collapses to one loop with translucent surfaces
    // drawn opaque (pre-port behaviour).
    const tMode = translucencyModeFromCvars();
    if (this.alphaDeferredSi.length < nvis) {
      this.alphaDeferredSi = new Int32Array(Math.max(16, nvis));
      this.alphaDeferredOrd = new Int32Array(Math.max(16, nvis));
      this.alphaDeferredBits = new Int32Array(Math.max(16, nvis));
    }
    let nAlpha = 0;
    for (let i = 0; i < nvis; i++) {
      const si = this.visSurfs[i]!;
      const order = this.visOrder[i]!;
      const surf = worldData.surfaces[si]!;
      // degenerate (NODRAW) placeholders from BSP conversion carry no geometry.
      if (surf.n < 3) { if (d) d.degenerate++; if (ph) { ph.cull += phaseNow() - pt; pt = phaseNow(); } continue; }
      if (culledByFlatFrustum(this.frustumFlat, surf.mins, surf.maxs)) { if (d) d.frustumCulled++; if (ph) { ph.cull += phaseNow() - pt; pt = phaseNow(); } continue; }
      // backface cull for single-sided world polys (id draws these too and
      // lets the z-buffer reject them; skipping is output-identical and
      // saves the span work). Turbulent (water) and sky stay double-sided:
      // sky hulls face outward, so culling would erase the sky.
      if (!surf.turbulent && !surf.sky) {
        const dx = cam.origin[0]! - surf.center[0]!;
        const dy = cam.origin[1]! - surf.center[1]!;
        const dz = cam.origin[2]! - surf.center[2]!;
        if (surf.fn[0]! * dx + surf.fn[1]! * dy + surf.fn[2]! * dz < 0) {
          if (d) d.backfaceCulled++;
          if (ph) { ph.cull += phaseNow() - pt; pt = phaseNow(); }
          continue;
        }
      }
      // Translucent deferral (R_RenderFace queues SURF_TRANS33/66 into
      // r_alpha_surfaces): count the surface as emitted (so the M3.3 diag
      // buckets still sum to PVS-visible) and record it for the alpha loop.
      // Sky+translucent (never in practice) follows the alpha path, matching
      // C's TRANS-first check.
      const trRaw = surf.translucent ?? 0;
      const tr = trRaw === 2 ? 2 : trRaw === 1 ? 1 : 0;
      if (tMode !== 0 && tr !== 0) {
        if (d) d.emitted++;
        this.alphaDeferredSi[nAlpha] = si;
        this.alphaDeferredOrd[nAlpha] = order;
        // Resolve dlight bits now (the closure reads phase-1 light state);
        // the alpha loop runs post-kick in drawForeground.
        this.alphaDeferredBits[nAlpha] = dlightFrameBits(surf.id);
        nAlpha++;
        continue;
      }
      if (surf.sky) {
        const sky = this.skyTex;
        if (sky) {
          // Textured skybox (faithful R_EmitSkyBox/D_SkySurf): world SURF_SKY
          // polys are NEVER rasterised — id discards them and emits the 6
          // single-face box quads around the view origin instead, so span
          // interpolation can never sweep UVs across tile boundaries (the
          // black-lava streak: bk/lf black bands dragged over orange faces).
          // Emitted once per frame no matter how many sky surfaces are
          // visible; each face samples its own tile, unlit grade 63,
          // cache-free. The box sits far beyond any real geometry, so it
          // depth-tests as background without a depth override (the
          // perspective span math stays exact).
          if (!this.skyBoxEmitted) {
            this.skyBoxEmitted = true;
            if (ph) pt = phaseNow();
            this.emitSkyBox(cam, order, this.skyEmitAcc);
            if (ph) { ph.draw += phaseNow() - pt; pt = phaseNow(); }
            spansEmitted += this.skyEmitAcc.spans;
            if (d) {
              d.emitted++;
              if (this.skyEmitAcc.max > d.maxBatchSpans) d.maxBatchSpans = this.skyEmitAcc.max;
            }
          }
          continue;
        }
        // Sky hull: flat depth-tested fill, no texture / lightmap / cache
        // entry (previously these rendered with the orange fallback checker).
        // The palette color rides each span (s.light) so every backend
        // (classic, banded, wasm, pooled) draws it through its normal
        // batch path; texView/lightView are ignored for SPAN_FLAT.
        this.polyInput.verts = surf.verts;
        this.polyInput.uvs = surf.uvs;
        this.polyInput.lux = surf.lux;
        this.polyInput.n = surf.n;
        if (ph) { ph.cull += phaseNow() - pt; pt = phaseNow(); }
        const nproj = projectClippedPoly(this.polyInput, cam, this.fbW, this.fbH, this.scratch);
        if (ph) { ph.project += phaseNow() - pt; pt = phaseNow(); }
        if (nproj < 3) { if (d) d.clipRejected++; continue; }
        const start = this.spanList.count;
        const flat = this.flatForEmit(SPAN_FLAT, order, this.skyIndex, 0, null);
        const endCount = emitSpansForPoly(
          this.scratch.poly, nproj, order, this.pool, start, MAX_SPANS, 63, 0, this.fbH,
          flat,
        );
        if (endCount <= start) { if (d) d.clipRejected++; continue; }
        if (!this.commitFlat(flat, endCount - start)) {
          for (let i = start; i < endCount; i++) {
            const sp = this.pool[i]!;
            sp.kind = SPAN_FLAT;
            sp.ord = order;
            sp.light = this.skyIndex;
            sp.dlight = 0;
          }
        }
        if (ph) { ph.emit += phaseNow() - pt; pt = phaseNow(); }
        sortBatchByRow(this.pool, start, endCount - start, this.fbH, this.rowBase, this.tmpSort);
        if (ph) { ph.sort += phaseNow() - pt; pt = phaseNow(); }
        this.spanList.count = endCount;
        this.backend.drawSpans(this.spanList, texView, lightView);
        if (ph) { ph.draw += phaseNow() - pt; pt = phaseNow(); }
        this.spanList.count = 0;
        spansEmitted += endCount - start;
        if (d) {
          d.emitted++;
          const batchSpans = endCount - start;
          if (batchSpans > d.maxBatchSpans) d.maxBatchSpans = batchSpans;
        }
        continue;
      }
      const dist = Math.sqrt(
        (surf.center[0]! - view.origin[0]!) ** 2 +
        (surf.center[1]! - view.origin[1]!) ** 2 +
        (surf.center[2]! - view.origin[2]!) ** 2,
      );
      const mip = dist < 320 ? 0 : dist < 640 ? 1 : dist < 1280 ? 2 : 3;
      const lightId = surf.lightId % worldData.lightmaps.length;
      const lm = worldData.lightmaps[lightId]!;
      // Style-hash memo: the hash depends only on (lightId, this frame's
      // lightStyles), so lightmap-sharing surfaces skip the style loop +
      // FNV. nValid is recomputed on the miss path (misses are rare), so a
      // memo hit never pays the style loop at all. Bit-identical: the memo
      // stores the exact hash the direct path computes.
      let stylesHash: number;
      let nValid = -1;
      if (this.styleHashStamp[lightId] === this.frame && this.styleHashStyles === view.lightStyles) {
        stylesHash = this.styleHashMemo[lightId]!;
      } else {
        // id faces carry up to 4 style slots with 255 = "no more styles":
        // resolve only the valid ones (test and devroom paths have none).
        // Single-style surfaces resolve to exactly one scale, so the static
        // baseline (devroom golden) is bit-identical to the old [0]-only path.
        nValid = countValidStyles(lm, view.lightStyles, this.styleScratch);
        stylesHash = hashLightStyles(this.styleScratch, nValid);
        this.styleHashMemo[lightId] = stylesHash;
        this.styleHashStamp[lightId] = this.frame;
        this.styleHashStyles = view.lightStyles;
      }
      if (ph) { ph.cull += phaseNow() - pt; pt = phaseNow(); }
      let block = this.cache.get(surf.id, stylesHash, mip);
      if (!block) {
        // copy the style scales out of scratch (build is a miss-only path)
        if (nValid < 0) nValid = countValidStyles(lm, view.lightStyles, this.styleScratch);
        const scalesCopy: number[] = [];
        for (let k = 0; k < nValid; k++) scalesCopy.push(this.styleScratch[k]!);
        if (scalesCopy.length === 0) scalesCopy.push(1);
        block = this.buildSurfaceBlock(worldData, surf, mip, scalesCopy, dyn, dlightFrameBits(surf.id));
        this.cache.put(surf.id, stylesHash, mip, block);
      }
      const tex = texView;
      tex.width = block.bw;
      tex.height = block.bh;
      tex.texels = block.texels;
      const lb = lightView;
      lb.width = block.luxW;
      lb.height = block.luxH;
      lb.values = block.light;
      if (ph) { ph.cache += phaseNow() - pt; pt = phaseNow(); }
      // emit
      this.polyInput.verts = surf.verts;
      this.polyInput.uvs = surf.uvs;
      this.polyInput.lux = surf.lux;
      this.polyInput.n = surf.n;
      const nproj = projectClippedPoly(this.polyInput, cam, this.fbW, this.fbH, this.scratch);
      if (ph) { ph.project += phaseNow() - pt; pt = phaseNow(); }
      if (nproj < 3) { if (d) d.clipRejected++; continue; }
      const start = this.spanList.count;
      const flat = this.flatForEmit(
        surf.turbulent ? SPAN_TURBULENT : SPAN_OPAQUE, order, null, null, null,
      );
      const endCount = emitSpansForPoly(
        this.scratch.poly, nproj, order, this.pool, start, MAX_SPANS, 63, 0, this.fbH,
        flat,
      );
      if (endCount <= start) { if (d) d.clipRejected++; continue; }
      if (!this.commitFlat(flat, endCount - start)) {
        for (let i = start; i < endCount; i++) {
          const sp = this.pool[i]!;
          sp.kind = surf.turbulent ? SPAN_TURBULENT : SPAN_OPAQUE;
          sp.ord = order;
        }
      }
      if (ph) { ph.emit += phaseNow() - pt; pt = phaseNow(); }
      sortBatchByRow(this.pool, start, endCount - start, this.fbH, this.rowBase, this.tmpSort);
      if (ph) { ph.sort += phaseNow() - pt; pt = phaseNow(); }
      this.spanList.count = endCount;
      this.backend.drawSpans(this.spanList, tex, lb);
      if (ph) { ph.draw += phaseNow() - pt; pt = phaseNow(); }
      this.spanList.count = 0;
      spansEmitted += endCount - start;
      if (d) {
        d.emitted++;
        const batchSpans = endCount - start;
        if (batchSpans > d.maxBatchSpans) d.maxBatchSpans = batchSpans;
      }
    }

    // Frame accumulation (M8.1 async-render step 1): geometry captured every
    // batch above; complete the frame with ONE pool kick here, before any
    // direct plane writes (alias/sprites/particles depth-test against the
    // world). Unpooled / accum-disabled: no-op, batches already drew inline.
    // candidatePixels finalises from the backend counters either way (the
    // per-batch deltas telescoped to the same total).
    if (this.backend === this.bandBackend && this.bandBackend.dispatcher &&
      this.bandBackend.accumEnabled && !this.bandBackend.flushDeferred) {
      if (ph) pt = phaseNow();
      this.bandBackend.flushAccum();
      if (ph) { ph.draw += phaseNow() - pt; pt = phaseNow(); }
    }
    candidatePixels = this.backend.pixelsDrawn - pixelsBase;

    // Stash the foreground inputs for the async path (refs only): the
    // deferred world kick must complete before any direct plane writes
    // (its lazy per-band clear would wipe them — see drawForeground).
    this.fgCam = cam;
    this.fgWorld = worldData;
    this.fgDyn = dyn;
    this.fgTMode = tMode;
    this.fgAlphaCount = nAlpha;
    if (!this.skipForeground) spansEmitted += this.drawForeground(cam, worldData, view, dyn, entities);
    // Foreground draws (alpha) tally into the backend counters: finalise
    // the candidate count after them so it reconciles with finishStats.
    candidatePixels = this.backend.pixelsDrawn - pixelsBase;
    if (d) d.candidatePixels = candidatePixels;
    // Stash the stats partials: finishStats() reads the backend counters,
    // which are only complete after the (possibly async) frame kick.
    // The sync path's counters are already complete, so its stats are
    // unchanged; the async path re-runs finishStats() after the kick.
    this.stSpansEmitted = spansEmitted;
    this.stPixelsBase = pixelsBase;
    this.stT0 = t0;
    return this.finishStats();
  }

  /**
   * Entity foreground: deferred translucent alpha (R_DrawAlphaSurfaces)
   * first — it must land after the pool kick (the kick would wipe these
   * direct plane writes), then world-placed alias / sprites / particles
   * (M3.4), game entities (MD2 alias incl. the depthHack viewmodel,
   * sprites, tracer beams) and renderer-owned tracer beams, then dlight
   * aging. Alpha stays ahead of entities exactly like the old pre-kick
   * order (relative compositing unchanged); only its position vs the kick
   * moved. Bit-identical either way: world-first, foreground-second, all
   * writes depth-guarded. Zero allocation (phase timing uses the armed
   * scratch). Returns the alpha spans emitted (feeds the stats stash).
   */
  private drawForeground(cam: Camera, worldData: MiniWorld, view: RefDef, dyn: DynamicLight[], entities: Entity[]): number {
    const ph = this.phaseArmed ? this.phaseAcc : null;
    let pt = ph ? phaseNow() : 0;
    const d = this.diagArmed ? this.diagAcc : null;
    let alphaSpans = 0;
    // Translucent alpha draw (R_DrawAlphaSurfaces): the recorded surfaces
    // draw here in reverse traversal order (back-to-front), blended through
    // the classic TS backend into the live planes, so the pooled/wasm paths
    // need no TRANS plumbing. Runs FIRST in the foreground (after the pool
    // kick): the kick would wipe these direct plane writes. Counters merge
    // into the active backend, keeping frameStats and the M3.3 attribution
    // exact (buckets were counted at deferral time; only maxBatchSpans is
    // updated here). Tables build lazily on the first translucent frame, so
    // translucent-free worlds never pay for them.
    for (let a = this.fgAlphaCount - 1; a >= 0; a--) {
      const si = this.alphaDeferredSi[a]!;
      const order = this.alphaDeferredOrd[a]!;
      const surf = worldData.surfaces[si]!;
      const trRaw = surf.translucent ?? 0;
      const tr = trRaw === 2 ? 2 : trRaw === 1 ? 1 : 0;
      const dist = Math.sqrt(
        (surf.center[0]! - view.origin[0]!) ** 2 +
        (surf.center[1]! - view.origin[1]!) ** 2 +
        (surf.center[2]! - view.origin[2]!) ** 2,
      );
      const mip = dist < 320 ? 0 : dist < 640 ? 1 : dist < 1280 ? 2 : 3;
      const lightId = surf.lightId % worldData.lightmaps.length;
      const lm = worldData.lightmaps[lightId]!;
      let stylesHash: number;
      let nValid = -1;
      if (this.styleHashStamp[lightId] === this.frame && this.styleHashStyles === view.lightStyles) {
        stylesHash = this.styleHashMemo[lightId]!;
      } else {
        nValid = countValidStyles(lm, view.lightStyles, this.styleScratch);
        stylesHash = hashLightStyles(this.styleScratch, nValid);
        this.styleHashMemo[lightId] = stylesHash;
        this.styleHashStamp[lightId] = this.frame;
        this.styleHashStyles = view.lightStyles;
      }
      if (ph) { ph.cull += phaseNow() - pt; pt = phaseNow(); }
      let block = this.cache.get(surf.id, stylesHash, mip);
      if (!block) {
        if (nValid < 0) nValid = countValidStyles(lm, view.lightStyles, this.styleScratch);
        const scalesCopy: number[] = [];
        for (let k = 0; k < nValid; k++) scalesCopy.push(this.styleScratch[k]!);
        if (scalesCopy.length === 0) scalesCopy.push(1);
        block = this.buildSurfaceBlock(worldData, surf, mip, scalesCopy, dyn, this.alphaDeferredBits[a]!);
        this.cache.put(surf.id, stylesHash, mip, block);
      }
      const tex = texView;
      tex.width = block.bw;
      tex.height = block.bh;
      tex.texels = block.texels;
      const lb = lightView;
      lb.width = block.luxW;
      lb.height = block.luxH;
      lb.values = block.light;
      if (ph) { ph.cache += phaseNow() - pt; pt = phaseNow(); }
      this.polyInput.verts = surf.verts;
      this.polyInput.uvs = surf.uvs;
      this.polyInput.lux = surf.lux;
      this.polyInput.n = surf.n;
      const nproj = projectClippedPoly(this.polyInput, cam, this.fbW, this.fbH, this.scratch);
      if (ph) { ph.project += phaseNow() - pt; pt = phaseNow(); }
      if (nproj < 3) continue;
      const start = this.spanList.count;
      const endCount = emitSpansForPoly(
        this.scratch.poly, nproj, order, this.pool, start, MAX_SPANS, 63, 0, this.fbH,
        undefined,
      );
      if (endCount <= start) continue;
      for (let i = start; i < endCount; i++) {
        const sp = this.pool[i]!;
        sp.kind = tr === 2 ? SPAN_TRANS66 : SPAN_TRANS33;
        sp.ord = order;
      }
      if (ph) { ph.emit += phaseNow() - pt; pt = phaseNow(); }
      sortBatchByRow(this.pool, start, endCount - start, this.fbH, this.rowBase, this.tmpSort);
      if (ph) { ph.sort += phaseNow() - pt; pt = phaseNow(); }
      this.spanList.count = endCount;
      this.ensureAlphamap();
      const tb = this.tsBackend;
      if (this.backend !== tb) tb.attach(this.idx, this.zb, this.fbW, this.fbH, this.colormap);
      const t = drawSpansTranslucent(this.idx, this.zb, this.fbW, this.fbH, this.spanList,
        tex, lb, this.colormap, this.alpha33, this.alpha66,
        surf.turbulent ? tb.turbTable : null, view.time, this.fgTMode === 2);
      this.transSpans += t.spans;
      if (this.backend === tb) {
        tb.spansDrawn += t.spans;
        tb.pixelsDrawn += t.pixels;
      } else {
        this.backend.spansDrawn += t.spans;
        this.backend.pixelsDrawn += t.pixels;
      }
      if (ph) { ph.draw += phaseNow() - pt; pt = phaseNow(); }
      this.spanList.count = 0;
      alphaSpans += endCount - start;
      if (d) {
        const batchSpans = endCount - start;
        if (batchSpans > d.maxBatchSpans) d.maxBatchSpans = batchSpans;
      }
    }

    // world-placed alias / sprites / particles (M3.4 in the devroom)
    // Pooled path with zero span batches (degenerate frame): planes were
    // never cleared lazily, so fill once before direct plane writes.
    if (this.backend === this.bandBackend && this.bandBackend.dispatcher &&
      this.bandBackend.batchesDrawn === 0) {
      this.idx.fill(0);
      this.zb.fill(0);
    }
    if (ph) pt = phaseNow();
    for (const pa of worldData.alias) {
      const mesh = getDevMeshSafe(pa.meshId, this.fallbackMesh);
      const skin = worldData.textures[pa.skinId % worldData.textures.length]!;
      drawAliasInstance(this.idx, this.zb, this.fbW, this.fbH, {
        mesh, origin: pa.origin, angles: pa.angles,
        frameA: pa.frameA, frameB: pa.frameB, lerp: pa.lerp,
        lightAngle: ((pa.angles[1]! * 256) / 360) & 255,
      }, skin, cam, this.anorms, this.shadeDots, this.colormap);
    }
    for (const ps of worldData.sprites) {
      const tex = worldData.textures[ps.skinId % worldData.textures.length]!;
      drawSprite(this.idx, this.zb, this.fbW, this.fbH,
        { origin: ps.origin, width: ps.size, height: ps.size, texId: 0, grade: 60 },
        [{ width: tex.width, height: tex.height, texels: tex.texels }],
        emptyLight, this.colormap, cam, this.spriteScratch, 1024);
    }
    if (worldData.particles.length > 0) {
      const n = Math.min(worldData.particles.length, 256);
      for (let i = 0; i < n; i++) {
        const wp = worldData.particles[i]!;
        this.partOrigins[i * 3] = wp.origin[0]!;
        this.partOrigins[i * 3 + 1] = wp.origin[1]!;
        this.partOrigins[i * 3 + 2] = wp.origin[2]!;
        this.partColors[i] = wp.color;
      }
      const np = projectParticles(
        this.partOrigins, this.partColors, n,
        cam.origin, cam.forward, cam.right, cam.up,
        cam.xCenter, cam.yCenter, cam.focalX, cam.focalY, cam.near,
        this.partPool,
      );
      drawParticles(this.idx, this.zb, this.fbW, this.fbH, this.partPool, 0, np);
    }

    // entities (game-driven; model kind selects the M3.4 path)
    for (let ei = 0; ei < entities.length; ei++) {
      const e = entities[ei]!;
      const m = this.models[e.model];
      if (!m) continue;
      if (m.kind === 'md2' && isAliasMesh(m.data)) {
        // Missing skin: gun fallback keeps its gunmetal; a real MD2 keeps
        // an olive-drab soldier tone so a wired-but-skinless monster still
        // reads as a soldier instead of a checker-textured box.
        const skin = this.skins[e.skin] ?? (m.fallback ? this.getGunSkin() : this.getSoldierSkin());
        // Real MD2s carry hundreds of frames; wrap game-provided indices.
        // RF_FRAMELERP (Entity.oldframe/backlerp): oldframe -> frame by
        // backlerp (cl_tent.c explosion smoothing). Unset oldframe means no
        // lerp (frameA == frameB, blend 0) — bit-identical to the old path.
        const nf = m.data.numFrames > 0 ? m.data.numFrames : 1;
        const wrap = (f: number): number => ((f % nf) + nf) % nf;
        const fr = wrap(e.frame);
        const hasOld = e.oldframe !== undefined && Number.isFinite(e.oldframe);
        const frA = hasOld ? wrap(e.oldframe as number) : fr;
        let lerp = e.backlerp ?? 0;
        if (!Number.isFinite(lerp)) lerp = 0;
        if (lerp < 0) lerp = 0; else if (lerp > 1) lerp = 1;
        if (!hasOld) lerp = 0;
        // Entity.alpha (default opaque): screen-door translucency for fading
        // explosions; fully transparent entities are skipped entirely.
        let alpha = e.alpha ?? 1;
        if (!Number.isFinite(alpha)) alpha = 1;
        if (alpha <= 0) continue;
        if (alpha > 1) alpha = 1;
        drawAliasInstance(this.idx, this.zb, this.fbW, this.fbH, {
          mesh: m.data, origin: e.origin, angles: e.angles,
          frameA: frA, frameB: fr, lerp,
          lightAngle: ((e.angles[1]! * 256) / 360) & 255,
          // First-person viewmodel (Entity.depthHack = RF_DEPTHHACK):
          // bias stored 1/z so the eye-anchored gun wins vs nearby walls.
          depthScale: e.depthHack === true ? DEPTHHACK_SCALE : 1,
          alpha: alpha >= 1 ? undefined : alpha,
        }, skin, cam, this.anorms, this.shadeDots, this.colormap);
      } else if (m.kind === 'sp2') {
        const skin = this.skins[e.skin] ?? devSkin0(worldData);
        drawSprite(this.idx, this.zb, this.fbW, this.fbH,
          { origin: e.origin, width: 48, height: 48, texId: 0, grade: 60 },
          [skin], emptyLight, this.colormap, cam, this.spriteScratch, 1024);
      } else if (m.kind === 'tracer') {
        // Contract-free beam convention (renderer-internal): origin is the
        // beam start, angles its direction, frame the length in world units
        // (default 96), skin a raw palette index (NOT a skin handle).
        // Lets game code emit blaster/shotgun tracers through plain
        // entities; spawnTracer() is the pooled equivalent with ttl.
        AngleVectors(e.angles, this.tracerFwd, this.tracerRight, this.tracerUp);
        const len = e.frame > 0 ? Math.min(e.frame, 1024) : TRACER_DEFAULT_LENGTH;
        const col = e.skin >= 0 && e.skin <= 255 ? e.skin & 255 : TRACER_DEFAULT_COLOR;
        drawTracerBeam(this.idx, this.zb, this.fbW, this.fbH, cam,
          e.origin[0]!, e.origin[1]!, e.origin[2]!,
          e.origin[0]! + this.tracerFwd[0]! * len,
          e.origin[1]! + this.tracerFwd[1]! * len,
          e.origin[2]! + this.tracerFwd[2]! * len,
          col);
      }
    }

    // Renderer-owned tracer beams (spawnTracer pool): drawn with the same
    // 1/z-tested line path, then aged one render. No allocation.
    for (let ti = 0; ti < TRACER_POOL_SIZE; ti++) {
      if (this.tracerTtl[ti] === 0) continue;
      const o = ti * 6;
      drawTracerBeam(this.idx, this.zb, this.fbW, this.fbH, cam,
        this.tracerSegs[o]!, this.tracerSegs[o + 1]!, this.tracerSegs[o + 2]!,
        this.tracerSegs[o + 3]!, this.tracerSegs[o + 4]!, this.tracerSegs[o + 5]!,
        this.tracerColors[ti]!, this.tracerCores[ti]!);
      this.tracerTtl[ti]--;
    }
    if (ph) { ph.alias += phaseNow() - pt; pt = phaseNow(); }

    // Age renderer-owned lights once per rendered view: a flash that is not
    // re-added expires after DEFAULT_DLIGHT_TTL_FRAMES renders (swept at the
    // top of the next renderView, with one serial bump / one cache rebuild).
    this.dlights.ageFrame();
    return alphaSpans;
  }

  /**
   * Finalise frame stats from the stashed partials + live backend
   * counters. Called once at the end of renderView (sync path, counters
   * complete) and again at the end of renderViewAsync (after the async
   * frame kick completes the counters). Pure recompute: identical values
   * either way. Zero allocation.
   */
  finishStats(): FrameStats {
    const area = this.fbW * this.fbH;
    const candidatePixels = this.backend.pixelsDrawn - this.stPixelsBase;
    const ms = Date.now() - this.stT0;
    this.frameStats = {
      spans: this.stSpansEmitted + this.backend.spansDrawn,
      pixels: this.backend.pixelsDrawn,
      overdraw: area > 0 ? candidatePixels / area : 0,
      ms,
    };
    return this.frameStats;
  }

  /**
   * Async render (M8.1 browser lane): the world span pass runs synchronously
   * exactly like renderView (deferring only the pooled frame kick), then the
   * single frame kick completes without blocking the calling thread
   * (message-driven worker completion), and the entity foreground draws
   * AFTER the kick — the kick lazily clears every band it touches, so
   * foreground drawn before it (alias/entities incl. the depthHack
   * viewmodel, sprites, particles, tracer beams) would be wiped. This is
   * exactly the sync order (kick, then foreground), hence bit-identical to
   * renderView; the old "draw first, converge by depth test" claim was wrong
   * on pooled paths (the clear is not depth-guarded). Stats recompute from
   * the same counters. Non-reentrant (uses the stats stash); await the
   * result before starting the next frame. Falls back to the sync path
   * with no pool.
   */
  async renderViewAsync(view: RefDef, world: WorldModel, entities: Entity[]): Promise<FrameStats> {
    const banded = this.backend === this.bandBackend ? this.bandBackend : null;
    const prevDefer = banded ? banded.flushDeferred : false;
    const prevSkip = this.skipForeground;
    if (banded) banded.flushDeferred = true;
    this.skipForeground = true;
    try {
      // Premature stats discarded; partials stashed for finishStats().
      this.renderView(view, world, entities);
    } finally {
      this.skipForeground = prevSkip;
      if (banded) banded.flushDeferred = prevDefer;
    }
    if (banded && banded.dispatcher && banded.accumEnabled) {
      await banded.flushAccumAsync();
    }
    // World kick complete (planes valid) — now the direct plane writes.
    const fgCam = this.fgCam;
    const fgWorld = this.fgWorld;
    const fgDyn = this.fgDyn;
    if (fgCam && fgWorld && fgDyn) {
      this.stSpansEmitted += this.drawForeground(fgCam, fgWorld, view, fgDyn, entities);
      // The foreground (alpha) tallies into the backend counters after the
      // phase-1 stash: refresh the diag candidate count to match finishStats.
      if (this.diagArmed) this.diagAcc.candidatePixels = this.backend.pixelsDrawn - this.stPixelsBase;
    }
    return this.finishStats();
  }

  endFrame(): void {
    if (this.backend === this.bandBackend && this.bandBackend.dispatcher) {
      // Pooled path: palette-expand via one resolve kick (workers + the
      // main band drain the color plane in parallel; identical math to the
      // serial loop below). Timeout/dead pool falls back to the serial
      // expand inside resolveAccum. The zero-batch guard keeps the resolve
      // input defined (mirrors the pre-alias guard in renderView).
      if (this.bandBackend.batchesDrawn === 0) {
        this.idx.fill(0);
        this.zb.fill(0);
      }
      this.bandBackend.resolveAccum(this.palette, this.color);
    } else {
      // palette expand to 0xAABBGGRR (classic / wasm / banded-inline paths)
      const pal = this.palette;
      const n = this.fbW * this.fbH;
      for (let i = 0; i < n; i++) {
        const c = this.idx[i]! * 3;
        const r = pal[c]!, g = pal[c + 1]!, b = pal[c + 2]!;
        this.color[i] = (0xff << 24) | (b << 16) | (g << 8) | r;
      }
    }
    this.mirrorIndexPlane();
  }

  /**
   * Async end-of-frame (M8.1 browser lane): the pooled resolve kick
   * completes without blocking the calling thread; every other path runs
   * the identical serial expand. Bit-identical to endFrame.
   */
  async endFrameAsync(): Promise<void> {
    if (this.backend === this.bandBackend && this.bandBackend.dispatcher) {
      if (this.bandBackend.batchesDrawn === 0) {
        this.idx.fill(0);
        this.zb.fill(0);
      }
      await this.bandBackend.resolveAccumAsync(this.palette, this.color);
    } else {
      this.endFrame();
      return;
    }
    this.mirrorIndexPlane();
  }

  /** Mirror the wasm index plane back to the host framebuffer (see endFrame). */
  private mirrorIndexPlane(): void {
    // wasm mode draws into wasm-memory views: mirror the index plane back so
    // host code reading fb.index directly stays correct (testkit's harness
    // uses getFramebuffer(), which already returns the live views).
    const hb = this.hostFb?.index;
    if (hb && hb !== this.idx) hb.set(this.idx.subarray(0, hb.length));
  }

  /** Test hook: renderer-owned dynamic lights (R_MarkLights input).
   * ttlFrames (default DEFAULT_DLIGHT_TTL_FRAMES = 2) is how many renders
   * the light survives without being re-added; a live flash re-pumps every
   * frame, so expiry only drops abandoned lights. Back-compat: the old
   * single-arg call keeps working. */
  testAddDynamicLight(l: DynamicLight, ttlFrames?: number): void {
    this.dlights.addLight(l, ttlFrames);
  }

  testClearDynamicLights(): void {
    this.dlights.clear();
  }

  /**
   * End all current flash requests now (same sweep renderView runs for
   * ttl-expired lights, but immediate). Probed by the web muzzle pump, which
   * calls this every frame before its conditional re-add: idle frames are
   * free (no serial bump, cache stays hot); a live flash is dropped so the
   * re-add is the only light and nothing accumulates. Headless tests that
   * add directly without pumping rely on the ttl path instead. Returns the
   * removed count. No allocation.
   */
  testExpireDynamicLights(): number {
    return this.dlights.expireAll();
  }

  /** Live renderer-owned light count (muzzle-leak observability, test hook). */
  testDynamicLightCount(): number {
    return this.dlights.count;
  }

  /** Observability for bench/golden (BRAIN.md §10.3: cache hit rate). */
  testCacheStats(): { hits: number; misses: number; evictions: number; used: number; size: number; hitRate: number } {
    const c = this.cache;
    return { hits: c.hits, misses: c.misses, evictions: c.evictions, used: c.used, size: c.size, hitRate: c.hitRate() };
  }

  /** Deferred alpha-pass spans drawn by the last renderView (0 when the
   * view sees no TRANS33/66 glass; observability for the glass golden). */
  testTranslucentSpans(): number {
    return this.transSpans;
  }

  /** WASM backend batch stats (M9.1): null unless initWasm() succeeded. */
  testWasmStats(): { active: boolean; wasmBatches: number; fallbackBatches: number } | null {
    if (!this.wasmBackend) return null;
    return {
      active: this.isWasmActive(),
      wasmBatches: this.wasmBackend.wasmBatches,
      fallbackBatches: this.wasmBackend.fallbackBatches,
    };
  }

  testResetCacheStats(): void {
    this.cache.resetStats();
  }

  /**
   * M8.1 attribution: render one frame with phase timing armed and return
   * stats + the geometry/spanfill split (see FramePhases). The drawn output
   * (index + depth planes) is identical to a plain beginFrame/renderView
   * pair — arming only fills counters (phaseNow() while armed).
   */
  testMeasurePhases(
    view: RefDef, world: WorldModel, entities: Entity[],
  ): { stats: FrameStats; phases: FramePhases } {
    this.phaseAcc = createFramePhases();
    this.phaseArmed = true;
    this.beginFrame();
    const stats = this.renderView(view, world, entities);
    this.phaseArmed = false;
    return { stats, phases: { ...this.phaseAcc } };
  }

  /**
   * M3.3 option (b): render one frame with overdraw attribution armed and
   * return stats + the full stage accounting (see overdraw.ts). The drawn
   * output (index + depth planes) is identical to a plain
   * beginFrame/renderView pair — arming only fills counters.
   *
   * The written/zRejected split is exact for world-only frames (no
   * entities/alias/sprites/particles writing the depth plane; the base1
   * MiniWorld harness satisfies this, its placed arrays are empty).
   */
  testMeasureOverdraw(
    view: RefDef, world: WorldModel, entities: Entity[],
  ): { stats: FrameStats; detail: OverdrawDetail } {
    this.diagAcc = createOverdrawDetail();
    this.diagArmed = true;
    this.beginFrame();
    const stats = this.renderView(view, world, entities);
    this.diagArmed = false;
    const acc = this.diagAcc;
    const area = this.fbW * this.fbH;
    acc.writtenPixels = countWrittenZb(this.zb, area);
    acc.zRejectedPixels = acc.candidatePixels - acc.writtenPixels;
    acc.area = area;
    acc.overdraw = stats.overdraw;
    acc.visibleCoverage = area > 0 ? acc.writtenPixels / area : 0;
    acc.occludedShare = acc.candidatePixels > 0 ? acc.zRejectedPixels / acc.candidatePixels : 0;
    return { stats, detail: { ...acc } };
  }

  /**
   * Build the fused-emission descriptor for one batch (M8.1): points the
   * reusable emitFlat at the pool's current flat cursor. The caller passes
   * it to emitSpansForPoly, then commitFlat validates + stages it.
   * Returns undefined when unfused (classic / unpooled / accum off).
   */
  private flatForEmit(
    kind: number, ord: number,
    light: number | null, dlight: number | null, lv: number | null,
  ): EmitFlat | undefined {
    const banded = this.backend === this.bandBackend ? this.bandBackend : null;
    const d = banded?.dispatcher;
    if (!banded || !d || !banded.accumEnabled) return undefined;
    const cur = d.flatCursor();
    if (!cur || cur.cap <= 0) return undefined;
    const f = this.emitFlat;
    f.F = cur.F; f.I = cur.I; f.base = cur.base; f.cap = cur.cap;
    f.kind = kind; f.ord = ord;
    f.light = light; f.dlight = dlight; f.lv = lv;
    f.written = -1;
    return f;
  }

  /**
   * Consume a fused emission (M8.1): when the flat copy matches the object
   * batch exactly, stage it for the frame kick (backend.pendingFlat) and
   * report true so the caller skips its tagging loop (objects already carry
   * the final state); otherwise drop it so drawSpans falls back to the
   * inline path (objects are always complete, so output stays identical).
   * Always call after emit, even when flat is undefined.
   */
  private commitFlat(flat: EmitFlat | undefined, emitted: number): boolean {
    const banded = this.backend === this.bandBackend ? this.bandBackend : null;
    if (!banded) return false;
    if (flat && emitted > 0 && flat.written === emitted) {
      banded.pendingFlat.base = flat.base;
      banded.pendingFlat.count = emitted;
      return true;
    }
    banded.pendingFlat.base = -1;
    banded.pendingFlat.count = 0;
    return false;
  }

  /**
   * R_EmitSkyBox port: rasterise the 6 single-face box quads around the view
   * origin (SKY_BOX_CORNERS at SKY_BOX_HALF), each with its own strip tile
   * via skyUvOnFace (the same view-locked box_vecs mapping id uses),
   * unlit grade 63, cache-free. The 6 faces tile the direction sphere, so
   * every background pixel samples exactly its pierced face — span
   * interpolation can never sweep across tile boundaries. Fills `acc`
   * (total spans + max single-face batch) for frame accounting; the caller
   * derives pixels from pixelsDrawn. No allocation.
   */
  private emitSkyBox(cam: Camera, order: number, acc: { spans: number; max: number }): void {
    const sky = this.skyTex!;
    const tileH = sky.height / 6;
    texView.width = sky.width;
    texView.height = sky.height;
    texView.texels = sky.texels;
    const ox = cam.origin[0]!, oy = cam.origin[1]!, oz = cam.origin[2]!;
    const tmp = this.skyTmp;
    acc.spans = 0;
    acc.max = 0;
    for (let face = 0; face < 6; face++) {
      const c = SKY_BOX_CORNERS[face]!;
      for (let k = 0; k < 4; k++) {
        const rx = c[k * 3]!, ry = c[k * 3 + 1]!, rz = c[k * 3 + 2]!;
        this.skyBoxVerts[k * 3] = ox + rx * SKY_BOX_HALF;
        this.skyBoxVerts[k * 3 + 1] = oy + ry * SKY_BOX_HALF;
        this.skyBoxVerts[k * 3 + 2] = oz + rz * SKY_BOX_HALF;
        skyUvOnFace(rx, ry, rz, face, sky.width, tileH, tmp);
        this.skyBoxUv[k * 2] = tmp.u;
        this.skyBoxUv[k * 2 + 1] = tmp.v;
      }
      this.skyBoxLux.fill(0);
      this.polyInput.verts = this.skyBoxVerts;
      this.polyInput.uvs = this.skyBoxUv;
      this.polyInput.lux = this.skyBoxLux;
      this.polyInput.n = 4;
      const nproj = projectClippedPoly(this.polyInput, cam, this.fbW, this.fbH, this.scratch);
      if (nproj < 3) continue;
      const start = this.spanList.count;
      const flat = this.flatForEmit(SPAN_OPAQUE, order, 63, 0, -1);
      const endCount = emitSpansForPoly(
        this.scratch.poly, nproj, order, this.pool, start, MAX_SPANS, 63, 0, this.fbH,
        flat,
      );
      if (endCount <= start) continue;
      if (!this.commitFlat(flat, endCount - start)) {
        for (let i = start; i < endCount; i++) {
          const sp = this.pool[i]!;
          sp.kind = SPAN_OPAQUE;
          sp.ord = order;
          sp.light = 63;
          sp.dlight = 0;
          sp.lv = -1;
        }
      }
      sortBatchByRow(this.pool, start, endCount - start, this.fbH, this.rowBase, this.tmpSort);
      this.spanList.count = endCount;
      this.backend.drawSpans(this.spanList, texView, lightView);
      this.spanList.count = 0;
      const batch = endCount - start;
      acc.spans += batch;
      if (batch > acc.max) acc.max = batch;
    }
  }

  private buildSurfaceBlock(
    world: MiniWorld, surf: MiniSurf, mip: number,
    scales: number[], dyn: DynamicLight[], dlightBits: number,
  ): SurfaceBlock {
    const src = world.textures[surf.texId % world.textures.length]!;
    const shift = mip > 3 ? 3 : mip;
    const bw = Math.max(1, src.width >> shift);
    const bh = Math.max(1, src.height >> shift);
    const texels = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        texels[y * bw + x] = src.texels[(y << shift) * src.width + (x << shift)]!;
      }
    }
    const lm = world.lightmaps[surf.lightId % world.lightmaps.length]!;
    const n = lm.luxW * lm.luxH;
    if (this.lightBlockScratch.length < n) this.lightBlockScratch = new Uint8Array(n);
    // NOTE: lightBlockScratch is reused then copied; the cache owns the copy.
    // Per-luxel dlight falloff (R_AddDynamicLights): fit world-space luxel
    // centers from the surface geometry. Only when a light actually affects
    // this surface — otherwise pass nothing and keep the legacy center path
    // bit-identical (devroom golden has no dlights).
    let luxelPos: Float32Array | null = null;
    if (dyn.length > 0 && dlightBits !== 0) {
      const need3 = n * 3;
      if (this.dluxScratch.length < need3) this.dluxScratch = new Float32Array(need3);
      luxelWorldPositions(surf.verts, surf.lux, surf.n, lm.luxW, lm.luxH, surf.center, this.dluxScratch);
      luxelPos = this.dluxScratch;
    }
    buildLightMap(this.lightBlockScratch, lm.samples, lm.luxW, lm.luxH, scales, dyn, surf.center, dlightBits, LIGHT_OVERBRIGHT, luxelPos);
    return {
      texels, bw, bh,
      light: this.lightBlockScratch.slice(0, n),
      luxW: lm.luxW, luxH: lm.luxH,
    };
  }
}

function getDevMeshSafe(id: number, fallback: AliasMesh): AliasMesh {
  try {
    return getDevMesh(id);
  } catch {
    return fallback;
  }
}

const texView: Texture = { width: 0, height: 0, texels: new Uint8Array(0) };
const lightView: LightBlock = { width: 1, height: 1, values: new Uint8Array(0) };
const emptyLight: LightBlock = { width: 1, height: 1, values: new Uint8Array([63]) };

let devSkinMemo: Texture | null = null;

function devSkin0(world: MiniWorld): Texture {
  if (!devSkinMemo) {
    const t = world.textures[0] ?? { texels: new Uint8Array(1024), width: 32, height: 32 };
    devSkinMemo = { width: t.width, height: t.height, texels: t.texels };
  }
  return devSkinMemo;
}
