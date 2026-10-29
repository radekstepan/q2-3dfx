// @q2/sw-renderer frame — r_main.c equivalent: R_SetupFrame, viewcluster,
// per-surface batching (surface cache -> edge emit -> row z-sort -> spans),
// alias/sprite/particle draws, palette resolve. Zero allocation per frame:
// every scratch buffer lives on the renderer instance.

import type {
  Entity, Framebuffer, FrameStats, Model, ModelHandle, RefDef, Refresh, TextureHandle, WorldModel,
} from '@q2/renderer-api';
import { Com_Error, getCVarNumber, registerCVar } from '@q2/config';
import type { MiniLightmap } from './worldNodes.js';import { DLightState, LIGHT_OVERBRIGHT, LIGHT_STYLE_UNUSED, buildLightMap, buildRGBLightMap, luxelWorldPositions, type DynamicLight, type SurfaceBounds } from './light.js';
import { SurfaceCache, hashLightStyles, RGBLightCache, type RGBCachedBlock, type SurfaceBlock } from './surfaceCache.js';
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
  buildRGBChain, buildRGBMaterial, RGBWorldBackend,
  type LightBlock, type RasterBackend, type RGBMaterial, type RGBMipLevel, type Span, type SpanList, type Texture,
} from './spans.js';
import { WasmSpanBackend, wasmRequestedByCvar } from './wasmSpans.js';
import {
  BandedSoftwareBackend, createBandBuffers, sabAvailable, workersRequestedByCvar,
  accumRequestedByCvar,
  R_FLAG_BILINEAR, R_FLAG_BLEND_ALPHA, R_FLAG_DEPTHWRITE, R_FLAG_FLAT, R_FLAG_LIGHT,
  R_FLAG_MIPDITHER, R_FLAG_OPAQUE, R_FLAG_OVERBRIGHT, R_FLAG_REPEAT, R_FLAG_WARP,
  type BandDispatcher,
} from './bands.js';
import {
  buildANorms, buildShadeDots, createBoxMesh, createGunMesh, createGunSkin, createSoldierMesh, createSoldierSkin, md2ToAliasMesh, DEPTHHACK_SCALE, drawAliasInstanceRGB, type AliasMesh,
} from './alias.js';
import { drawAliasInstance } from './alias.js';
import { drawTracerBeam, drawTracerBeamRGB, TRACER_DEFAULT_COLOR, TRACER_DEFAULT_LENGTH, TRACER_POOL_SIZE, TRACER_CORE_COLOR } from './tracer.js';
import { isValidSkySize, SKY_BOX_CORNERS, SKY_BOX_HALF, skyUvOnFace } from './sky.js';
import { AngleVectors } from '@q2/math';
import { drawSprite, drawSpriteRGB, emitSpriteSpans } from './sprites.js';
import { drawParticles, drawParticlesRGB, projectParticles, type ScreenParticle } from './particles.js';
import { buildColormap, buildAlphamapPair, defaultPalette, extractAlphamap33, extractAlphamap66, COLORMAP_PCX_PIXELS } from './colormap.js';
import { createDevroom, getDevMesh } from './devroom.js';

export const MAX_SPANS = 16384;
const MAX_ROW = 4096;

/**
 * Serial RGB (voodoo-policy) pass selector (astra V2a/V2c + step 3).
 * Default OFF: software output is bit-identical whether the RGB code exists
 * or not (the classic path pays one flag check per surface when off, and
 * nothing else). ON routes the serial classic backend through BOTH the
 * indexed path (always drawn, so `index` + the software depth plane stay
 * bit-identical) and the RGB overlay (opaque world, turbulent water,
 * sky/skybox, translucent glass/water, alias/MD2 incl. the depth-hack
 * viewmodel, sprites, particles, tracer beams) into a packed RGB565 plane
 * + window-Z Uint16 depth plane + coverage mask, composited (565 expanded
 * to 8:8:8) in endFrame. The RGB path owns SEPARATE planes: sharing the
 * software zb would perturb indexed draws after it, and sharing an 888
 * color plane would hide the hardware 565 quantise (blends must read the
 * quantized destination). Pooled (banded) backends route the same RGB
 * spans per band (inline, absolute screen coords) and merge them in the
 * single global endFrame composite; the wasm backend has no RGB pass and
 * errors explicitly when the flag is on (never silent software output).
 */
let rgbWorldEnabled = false;

/**
 * Select the serial RGB world pass. For the apps/web agent: prefer the
 * `SoftwareRenderer.setRGBWorldEnabled` instance method (it also drops the
 * renderer's RGB caches + coverage so no stale frame survives a switch);
 * this module-level flag exists so headless tests and backend probes can
 * arm the pass without a renderer instance. No stale color survives a
 * switch: the coverage mask is cleared every enabled frame and the
 * composite is skipped entirely while disabled.
 */
export function setRGBWorldEnabled(on: boolean): void {
  rgbWorldEnabled = on === true;
}

/** Observability hook for the RGB world flag (default false). */
export function isRGBWorldEnabled(): boolean {
  return rgbWorldEnabled;
}

/**
 * Cvar gating the PERF-FINISH-A authoritative RGB skip (default 1 = on):
 * world-surface batches that draw an RGB overlay skip the redundant classic
 * indexed drawSpans call (sky-flat, opaque / turbulent world batches,
 * skybox faces), and the entity foreground skips its redundant classic
 * draws (alias, sprites, particles, tracer beams, deferred alpha) wherever
 * the RGB twin drew. The RGB planes (packed 565 + window-Z + coverage) are
 * the production authority in Voodoo mode; the classic planes then carry
 * only what the RGB path did not cover, for the uncovered-pixel composite
 * in endFrame.
 *
 * Why this is sound (no translucency/stipple/depth carve-outs needed):
 * - Every skipped classic write lands on a pixel the RGB overlay covered,
 *   and endFrame resolves covered pixels from the RGB planes — the classic
 *   value there is never displayed.
 * - Every classic *read* of the skipped planes (foreground depth tests,
 *   translucent blend background, stipple source) is skipped together with
 *   the write: the foreground RGB twins depth-test against the RGB
 *   window-Z plane and blend against the seeded RGB background, so no
 *   skipped classic value is ever consumed.
 * - The residual vs the classic oracle (cvar 0): float-1/z vs quantised
 *   window-Z can disagree on depth-tie pixels, so a pixel the RGB path
 *   rejects but classic would accept composites background instead of the
 *   classic foreground texel. Measured tiny on real base1 views (see
 *   PERF-FINISH-A report); the cvar-0 oracle path is kept for comparison.
 * With RGB disabled (software mode) the skip never arms — software output
 * is bit-identical with the flag on or off.
 */
export const SW_RGB_SKIP_CLASSIC_CVAR = 'sw_rgb_skip_classic';

/** True unless the operator explicitly restored the classic oracle (cvar 0). */
export function skipClassicRequested(): boolean {
  try {
    registerCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1, 'skip redundant classic spanfill where the RGB overlay drew (PERF-FINISH-A authoritative default 1 = on, 0 = classic oracle)');
    return getCVarNumber(SW_RGB_SKIP_CLASSIC_CVAR) !== 0;
  } catch {
    return true;
  }
}

/**
 * Per-frame Voodoo fidelity snapshot for the RGB world pass (M4.1 resolve
 * chain). Read from the `vd_*` cvars (see docs/renderers.md + the @q2/config
 * defaults) once per renderView — never per pixel. A @q2/voodoo import is
 * deliberately NOT used here: the enforced dependency rules
 * (math<-formats<-bsp<-{sw-renderer,voodoo}) forbid sw-renderer depending on
 * voodoo, so the snapshot reads the same cvar names directly. Unset cvars
 * fall back to the compiled-in Voodoo3 profile (the values the hardcoded
 * RGB path always used); vd_zbits falls back to 0 (off) when unset or out
 * of range so direct unit-test renders without cvar setup stay legacy.
 */
export interface RGBFidelity {
  /** vd_overbright: lightmap modulate x2 + clamp. */
  overbright: boolean;
  /** vd_lodbias: added to log2(rho). */
  lodBias: number;
  /** vd_mipdither: per-pixel Bayer n/n+1 pick. */
  mipDither: boolean;
  /** vd_bilinear: bilinear taps (false = nearest point sample). */
  bilinear: boolean;
  /** vd_zbits: depth precision 1..23, 0 = off (legacy raw-1/z test). */
  zbits: number;
}

/** Read the current fidelity snapshot (pure, no allocation, sanitised). */
export function readRGBFidelity(): RGBFidelity {
  const lodRaw = getCVarNumber('vd_lodbias');
  const zRaw = getCVarNumber('vd_zbits');
  return {
    overbright: getCVarNumber('vd_overbright') !== 0,
    lodBias: Number.isFinite(lodRaw) ? lodRaw : -0.35,
    mipDither: getCVarNumber('vd_mipdither') !== 0,
    bilinear: getCVarNumber('vd_bilinear') !== 0,
    zbits: Number.isInteger(zRaw) && zRaw >= 1 && zRaw <= 23 ? zRaw : 0,
  };
}

/** True when two fidelity snapshots select identical RGB behaviour. */
export function sameRGBFidelity(a: RGBFidelity, b: RGBFidelity): boolean {
  return a.overbright === b.overbright && a.lodBias === b.lodBias &&
    a.mipDither === b.mipDither && a.bilinear === b.bilinear &&
    a.zbits === b.zbits;
}

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

/**
 * Emitter-order validator (perf remediation item 3, PERF-FINISH-A item D):
 * emitSpansForPoly emits strictly increasing y with one span per row, which
 * is exactly the order the row z-sort establishes — so the world / sky-fill
 * / skybox call sites in renderView trust the invariant with ZERO scans
 * (no validation, no sort). This function is retained as the guard for
 * that trust: emitOrder.test.ts fuzzes the emitter (convex polys, near
 * clip, viewport clip, degenerate inputs) and asserts every emitted batch
 * satisfies it, and the deferred translucent alpha loop keeps the general
 * sorter (back-to-front ordering must be established, not assumed).
 * Anything non-emitter-ordered fails the check and must go through
 * sortBatchByRow — output is identical in all cases. Clipping preserves
 * the invariant (it only drops rows, never reorders). Single linear pass,
 * no allocation.
 */
export function spansBatchIsRowOrdered(pool: Span[], start: number, count: number): boolean {
  if (count <= 1) return true;
  let prev = pool[start]!.y;
  for (let i = 1; i < count; i++) {
    const y = pool[start + i]!.y;
    if (y <= prev) return false;
    prev = y;
  }
  return true;
}

interface RegisteredModel {
  kind: string;
  data: unknown;
  /** True when data is the procedural gun fallback (unknown md2 payload). */
  fallback: boolean;
}

/**
 * Conservative model-space bounding sphere (perf remediation item 1):
 * center + radius covering EVERY frame of the mesh (union over frames, so
 * RF_FRAMELERP interpolation can never escape it). The world-space test
 * uses origin + (|center| + radius), which is rotation-invariant (the
 * entity basis is orthonormal), translation-exact, and — unlike
 * origin-only culling — can never cull a large/rotated model whose origin
 * is off-screen but whose geometry is visible. Depth-hack viewmodels are
 * exempt from culling entirely (eye-anchored by contract).
 */
export interface ModelBounds {
  cx: number; cy: number; cz: number; r: number;
}

/** Model-space sphere covering all frames of an alias mesh (register-time). */
export function aliasModelBounds(mesh: AliasMesh): ModelBounds {
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  const f = mesh.frames;
  const total = mesh.numFrames * mesh.numVerts * 3;
  for (let i = 0; i < total; i += 3) {
    const x = f[i]!, y = f[i + 1]!, z = f[i + 2]!;
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (z < minz) minz = z;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
    if (z > maxz) maxz = z;
  }
  if (!(minx <= maxx)) return { cx: 0, cy: 0, cz: 0, r: 0 };
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, cz = (minz + maxz) / 2;
  let r = 0;
  for (let i = 0; i < total; i += 3) {
    const dx = f[i]! - cx, dy = f[i + 1]! - cy, dz = f[i + 2]! - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > r) r = d;
  }
  return { cx, cy, cz, r };
}

/**
 * Sphere-vs-frustum test on the hoisted flat planes (perf remediation item
 * 1): true when the world-space sphere (center + radius) is entirely
 * outside any frustum plane or fully behind the near plane. Conservative:
 * touching/intersecting spheres always draw. Rotation/interp/near-plane/
 * large-model safe by construction (the radius covers all frames and the
 * worst-case center rotation).
 */
export function sphereCulledByFlatFrustum(
  fp: Float64Array,
  ox: number, oy: number, oz: number,
  fwdx: number, fwdy: number, fwdz: number,
  near: number,
  cx: number, cy: number, cz: number,
  r: number,
): boolean {
  // Fully behind the near plane (1/z would be negative — unprojectable).
  if ((cx - ox) * fwdx + (cy - oy) * fwdy + (cz - oz) * fwdz + r < near) return true;
  for (let p = 0; p < 20; p += 4) {
    const d = fp[p]! * cx + fp[p + 1]! * cy + fp[p + 2]! * cz - fp[p + 3]!;
    if (d < -r) return true;
  }
  return false;
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

/**
 * VRAM-like budget for the shared per-texture RGB mip chains (upload-time
 * expansion, retained across frames). Base1's chain working set is ~7-15MB;
 * LRU eviction only bites on texture churn (cvar/palette flips clear it).
 */
export const RGB_TEXCHAIN_BUDGET = 16 * 1024 * 1024;

/**
 * Extra LOD bias for alias (MD2) RGB materials, added to the `vd_lodbias`
 * fidelity value. Deliberately ZERO since the mip-UV-scale fix (P1):
 * fillPerspTriRGB and the world span loops used to sample the picked mip
 * with full-resolution UVs, so any coarse pick wrapped deep into the black
 * gutter around thin MD2 skin islands (barrel 37%, soldier 47% index-127
 * black) and the shadow side rendered flat black (soldier yaw90 @120u 29.4%
 * pure-black pre-resolve, blaster bolt @40u 64.5%). The -3.3 content bias
 * hid that sampling bug by pinning alias to L0. Re-measured post-fix on
 * real skins with production sampling (clamp, dither, bilinear): soldier
 * @120u 1.7% black, @300u 2.5%, v_blast @40u 4.4%, synthetic thin island
 * 91% of L0 with 0% black — all flat across the bias sweep (-0.35..-3.65),
 * i.e. no bias-sensitive gutter collapse remains. A nonzero delta would
 * pin alias to L0 (no minification filtering, distant shimmer, diverging
 * from the real-Voodoo behavior the RGB path emulates) for zero measured
 * benefit, so alias now tracks the shared bias exactly like world
 * textures. Close-range viewmodels (rho < 1, L0 either way) are unaffected
 * in kind. Kept as a named hook (instead of inlining 0) so a future
 * real-Voodoo3 capture review (M4.1) can re-tune content bias against
 * hardware with one knob.
 */
export const ALIAS_LOD_BIAS_DELTA = 0;

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
  /**
   * Surfaces the previous frame's lights touched (sorted, reused array).
   * dropTouchedSurfaces invalidates the union of this and the current
   * frame's affected set on both caches, then this becomes the current set.
   * The union is the completeness argument for serial-free cache keys: a
   * surface whose lighting changed is always in one of the two sets (a live
   * light marks it now; a removed/expired light marked it last frame), so no
   * stale luxels survive and no global invalidation is ever needed.
   */
  private lastTouched: number[] = [];
  /** Reused union scratch for dropTouchedSurfaces (no per-frame allocation). */
  private touchScratch: number[] = [];
  /**
   * Serial RGB world pass state (astra V2a/V2c + true-565 window-Z). Planes
   * are sized in init() and re-attached every enabled frame so backend
   * switches (wasm/banded) can never leave a stale depth view behind. All
   * no-ops while the module flag is off.
   */
  private readonly rgbBackend = new RGBWorldBackend();
  /**
   * Packed RGB565 authority plane (5:6:5, the ONLY RGB color target). Every
   * opaque write quantises 8:8:8 -> 565 on write; translucent/alpha/additive
   * expand the stored quantum, blend in 8-bit, and re-quantise.
   */
  private rgb565: Uint16Array = new Uint16Array(0);
  private rgbCover: Uint8Array = new Uint8Array(0);
  /**
   * RGB-owned window-Z depth plane (Voodoo3 hardware model): normalized
   * depth01 quanta, integer LESS wins, ties keep stored (first wins),
   * cleared to 0xFFFF (far) every enabled frame. The always-drawn classic
   * path keeps bit-identical depth decisions whether the flag is on or off
   * (it never reads this plane).
   */
  private rgbDepth16: Uint16Array = new Uint16Array(0);
  /**
   * Renderer-owned RGB plane backups (init-sized): attachWorkerPool
   * repoints the live fields at pool SAB views; detach/disable restores
   * these so the serial clear never writes a dead pool's buffer.
   */
  private rgbOwned565: Uint16Array = new Uint16Array(0);
  private rgbOwnedCover: Uint8Array = new Uint8Array(0);
  private rgbOwnedDepth: Uint16Array = new Uint16Array(0);
  /**
   * RGB inline-rest latch (PERF-2 RGB workers): once an RGB batch goes
   * inline in a staged frame (staging miss, unsuitable material), the
   * deferred RGB kick must never run — its planes already hold inline
   * writes. Every later world RGB batch goes inline and the final flush
   * finds nothing pending. Depth-guarded convergence: identical output.
   * Reset per frame in beginFrame (pooled path).
   */
  private rgbInlineRest = false;
  /** RGB worker observability counters (reset per frame in beginFrame). */
  private rgbStagedBatches = 0;
  private rgbInlineBatches = 0;
  private rgbKicks = 0;
  /**
   * Foreground worker observability (renderer lane task 1): span-based
   * foreground batches (deferred alpha, world sprites) staged into the
   * RGB worker kick vs drawn inline, and foreground kicks completed.
   * Per-pixel/triangle foreground (alias, particles, tracers, entities)
   * stays inline — see the drawForeground doc.
   */
  private fgStagedBatches = 0;
  private fgInlineBatches = 0;
  private fgKicks = 0;
  /**
   * Classic work avoided by the RGB-first probe (renderer lane task 3):
   * scalar surface-block builds skipped on RGB cache hits while the
   * authoritative skip is armed, and the estimated texel+luxel bytes those
   * builds would have allocated/copied. Reset per frame in beginFrame.
   */
  private classicAvoidedBuilds = 0;
  private classicAvoidedBytes = 0;
  /**
   * Worker span entries actually inspected this frame (renderer lane task
   * 2): summed from every pool kick tally (indexed + world RGB +
   * foreground RGB), main band included. Compare against staged spans to
   * prove subranges skip non-owned rows.
   */
  private rangeScanned = 0;
  /**
   * EndFrame resolve scratch only (expanded from rgb565 where covered).
   * Nothing blends against it mid-frame.
   */
  private rgbColor: Uint32Array = new Uint32Array(0);
  /** Projection window for this frame's window-Z mapping (from the Camera). */
  private rgbWin: { near: number; far: number } = { near: 4, far: 32768 };
  /**
   * Fidelity snapshot for this frame's RGB materials (M4.1 resolve chain):
   * refreshed from the vd_* cvars once per renderView; any change drops the
   * RGB cache + palette-baked skin/sky memos so toggling a cvar rebuilds
   * instead of serving stale materials.
   */
  private rgbFidelity: RGBFidelity = readRGBFidelity();
  private rgbCache = new RGBLightCache();
  /**
   * Per-texture shared RGB mip chains (upload-time expansion, like GL
   * texture upload to VRAM): texId -> expanded chain, shared by every
   * surface using that texture. buildRGBEntry used to expand a FULL chain
   * per (surface, serial) entry, so the real-map working set (hundreds of
   * surfaces x full chains) permanently thrashed the 4MB RGBLightCache
   * (0% hits, full rebuild + megabytes of garbage per frame). Chains depend
   * only on (world, texels, palette) — never on lighting, styles, mip or
   * the vd_* fidelity snapshot — so they survive dlight serial bumps,
   * style changes and cvar toggles; only the small per-surface luxel block
   * rebuilds (same cost profile as the scalar cache). Budgeted VRAM-like
   * (RGB_TEXCHAIN_BUDGET) with frame-stamp LRU; guarded by world identity
   * (a new world clears chains AND the surface caches, whose ids are
   * world-relative). Cleared on setPalette / setRGBWorldEnabled /
   * invalidateCaches (palette is baked in), NOT on fidelity changes.
   */
  private rgbTexChains = new Map<number, { chain: RGBMipLevel[]; bytes: number; used: number }>();
  private rgbTexUsed = 0;
  private rgbTexWorld: MiniWorld | null = null;
  private rgbTexHits = 0;
  private rgbTexMisses = 0;
  private rgbTexEvictions = 0;
  private rgbUsedThisFrame = false;
  /**
   * Skin/sky/flat RGB materials (step 3, serial RGB only): palette-baked
   * mip chains, so every entry is dropped on setPalette (and sky entries
   * on setSkyTexture). Keyed by the Texture object identity for skins
   * (renderer-owned stable refs), single-slot for sky/flat.
   */
  private rgbSkinMats = new Map<Texture, RGBMaterial>();
  /**
   * Opaque RGB materials for alias (MD2) models, keyed by Texture identity
   * like rgbSkinMats but built with opaqueMask (index 255 draws opaque).
   * ref_soft's alias path (r_polyse/D_DrawPoly) has no TRANSPARENT_COLOR
   * check and ref_gl draws meshes opaque (blend only under RF_TRANSLUCENT,
   * which rides Entity.alpha instead) — only sprites/HUD pics honor 255
   * (r_spr8.asm, r_draw.c). A separate map because the SAME Texture object
   * can back both an alias skin and a sprite, and the mask is baked into
   * the mip chain at upload. Cleared everywhere rgbSkinMats is.
   */
  private rgbAliasMats = new Map<Texture, RGBMaterial>();
  private rgbSkyMat: { tex: { width: number; height: number; texels: Uint8Array }; mat: RGBMaterial } | null = null;
  private rgbFlatSky: { index: number; mat: RGBMaterial } | null = null;
  private models: RegisteredModel[] = [];
  /**
   * Parallel model-space bounds (perf remediation item 1): modelBounds[h]
   * covers models[h] for kind-'md2' alias meshes, null when the kind has
   * no precomputable bounds (sprites billboard per frame, tracers are
   * segments). Kept in lockstep with `models` (pushed in registerModel).
   */
  private modelBounds: (ModelBounds | null)[] = [];
  /**
   * Per-frame entity cull counters (perf remediation item 1): culled =
   * instances skipped by the sphere test (zero expensive work: no setup,
   * no projection, no fill), drawn = instances that reached a draw call.
   * Reset at the top of renderView; read via testEntityCullStats().
   */
  private fgCulled = 0;
  private fgDrawn = 0;
  /**
   * Memoised dev-mesh bounds for world-placed alias (same sphere rule as
   * modelBounds, keyed by dev-mesh id; dev meshes are static).
   */
  private devMeshBounds = new Map<number, ModelBounds | null>();
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
  /** Reusable RGB luxel block for the RGB miss path (grown on demand). */
  private rgbLightScratch: Uint8Array = new Uint8Array(0);
  /** Reusable per-luxel world-pos grid for dlight falloff (grown on demand). */
  private dluxScratch: Float32Array = new Float32Array(0);
  private styleScratch = new Float32Array(8);
  /** Reusable style-scale array for the scalar/RGB miss paths (task 6:
   * the per-miss `scalesCopy`/`scales` allocations showed up as steady
   * garbage on dlight-churn frames; the builders consume the scales
   * synchronously and never retain them, so one shared scratch is exact).
   * Grown on demand, never reallocated in steady state. */
  private scalesScratch: number[] = [];
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
  /**
   * Stashed authoritative-skip decision for the async path (PERF-FINISH-A
   * item A): phase-1 renderView records it with the other foreground
   * inputs; phase-2 drawForeground applies the same foreground classic
   * skips so both halves agree.
   */
  private fgSkipClassic = false;
  /**
   * PERF-FINISH-A item A observability: classic work eliminated by the
   * authoritative skip this frame. `classicSpansSkipped` counts world /
   * sky / skybox / deferred-alpha spans whose classic draw was elided
   * where the RGB overlay drew; `classicFgSkipped` counts entity
   * foreground classic draws elided (alias / sprite / particle / tracer
   * calls). Reset in beginFrame, read via testClassicSkipStats. Software
   * mode (RGB off) leaves both at zero — the skip never arms there.
   */
  private classicSpansSkipped = 0;
  private classicFgSkipped = 0;
  private fgCam: Camera | null = null;  private fgWorld: MiniWorld | null = null;
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
    this.rgb565 = new Uint16Array(fb.width * fb.height);
    this.rgbCover = new Uint8Array(fb.width * fb.height);
    this.rgbDepth16 = new Uint16Array(fb.width * fb.height);
    this.rgbColor = new Uint32Array(fb.width * fb.height);
    this.rgbOwned565 = this.rgb565;
    this.rgbOwnedCover = this.rgbCover;
    this.rgbOwnedDepth = this.rgbDepth16;
    this.rgbBackend.attach(this.rgb565, this.rgbCover, this.rgbDepth16, this.fbW, this.fbH, this.rgbColor);
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
      // No silent software fallback: the wasm kernel only implements the
      // indexed opaque-span loop, so an armed RGB flag is an explicit error
      // (a full WASM RGB port is out of scope — see spans.ts PORT-DIFF).
      if (rgbWorldEnabled) {
        Com_Error('error', 'sw-renderer: WASM backend has no RGB world pass (call setRGBWorldEnabled(false) first) — refusing to render silent software output');
      }
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
   * RGB planes are adopted alongside the indexed planes when the pool
   * exposes them (PERF-2 RGB workers); the serial beginFrame clear then
   * owns them exactly like the renderer-owned buffers.
   */
  attachWorkerPool(pool: BandDispatcher | null): void {
    this.bandBackend.dispatcher = pool;
    if (!pool) {
      this.restoreOwnedRGBPlanes();
      return;
    }
    if (pool.planes && this.isWorkersActive()) {
      const p = pool.planes;
      if (p.idx.length === this.fbW * this.fbH && p.zb.length === this.fbW * this.fbH &&
        p.color.length === this.fbW * this.fbH &&
        p.idx.buffer === p.zb.buffer && p.idx.buffer === p.color.buffer) {
        this.idx = p.idx;
        this.zb = p.zb;
        this.color = p.color;
        this.bandBackend.attach(this.idx, this.zb, this.fbW, this.fbH, this.colormap);
        const rp = pool.rgbPlanes;
        if (rp && rp.rgb565.length === this.fbW * this.fbH &&
          rp.cover.length === this.fbW * this.fbH &&
          rp.rgbDepth.length === this.fbW * this.fbH &&
          rp.rgb565.buffer === rp.cover.buffer) {
          this.rgb565 = rp.rgb565;
          this.rgbCover = rp.cover;
          this.rgbDepth16 = rp.rgbDepth;
        }
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

  /**
   * Observability for RGB worker execution (PERF-2): batches staged for
   * the worker kick vs batches drawn inline, and worker kicks completed,
   * since the last beginFrame. `staged` counts batches routed to the pool;
   * `inline` counts world batches drawn inline (unpooled or fallback);
   * `kicks` counts completed RGB kicks (sync or async). A pooled Voodoo
   * frame shows staged > 0 and kicks > 0; serial shows staged = kicks = 0.
   * Read-only, zero behavior change.
   */
  testRGBWorkerStats(): { staged: number; inline: number; kicks: number } {
    return {
      staged: this.rgbStagedBatches,
      inline: this.rgbInlineBatches,
      kicks: this.rgbKicks,
    };
  }

  /**
   * Foreground worker observability (renderer lane task 1): span-based
   * foreground batches (deferred alpha, world sprites) staged for the
   * worker kick vs drawn inline, and foreground kicks completed, since
   * the last beginFrame. Per-pixel/triangle foreground (alias, particles,
   * tracers, entities) always counts inline — it never stages.
   */
  testForegroundWorkerStats(): { staged: number; inline: number; kicks: number } {
    return {
      staged: this.fgStagedBatches,
      inline: this.fgInlineBatches,
      kicks: this.fgKicks,
    };
  }

  /**
   * Classic work avoided by the RGB-first probe (renderer lane task 3):
   * scalar surface-block builds skipped on RGB cache hits while the
   * authoritative skip was armed, and the estimated texel+luxel bytes
   * those builds would have copied, since the last beginFrame. Zero in
   * software mode and under the classic oracle (cvar 0).
   */
  testClassicAvoidStats(): { builds: number; bytes: number } {
    return {
      builds: this.classicAvoidedBuilds,
      bytes: this.classicAvoidedBytes,
    };
  }

  /**
   * Worker span-entry proof (renderer lane task 2): entries actually
   * inspected by pool kicks (indexed + world RGB + foreground RGB, main
   * band included) since the last beginFrame. Compare against staged
   * spans to prove subranges skip non-owned rows.
   */
  testWorkerRangeStats(): { scanned: number } {
    return { scanned: this.rangeScanned };
  }

  /** Pending staged RGB batches (observability for the browser soak). */
  testRGBPending(): number {
    const pool = this.backend === this.bandBackend ? this.bandBackend.dispatcher : null;
    return pool ? pool.rgbPending() : 0;
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
      this.restoreOwnedRGBPlanes();
    }
  }

  /**
   * Restore the renderer-owned RGB planes after a pool detach (adoption in
   * attachWorkerPool repoints the live fields at SAB views; the owned
   * buffers stay allocated and are simply re-adopted here).
   */
  private restoreOwnedRGBPlanes(): void {
    if (this.rgbOwned565.length === this.fbW * this.fbH &&
      this.rgbOwnedCover.length === this.fbW * this.fbH &&
      this.rgbOwnedDepth.length === this.fbW * this.fbH) {
      this.rgb565 = this.rgbOwned565;
      this.rgbCover = this.rgbOwnedCover;
      this.rgbDepth16 = this.rgbOwnedDepth;
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
    // The RGB world pass bakes palette colors into its mip chain at upload,
    // so a palette change drops the whole RGB cache (serial-keyed entries
    // would otherwise serve stale color).
    this.alphaReady = false;
    this.alpha33 = new Uint8Array(0);
    this.alpha66 = new Uint8Array(0);
    this.rgbCache.invalidateAll();
    this.rgbSkinMats.clear();
    this.rgbAliasMats.clear();
    this.clearRGBTextureChains();
    this.rgbSkyMat = null;
    this.rgbFlatSky = null;
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
      // Bounds (item 1) are computed at registration, covering all frames.
      if (isAliasMesh(m.data)) {
        this.models.push({ kind: m.kind, data: m.data, fallback: false });
        this.modelBounds.push(aliasModelBounds(m.data));
      } else {
        const conv = md2ToAliasMesh(m.data);
        if (conv) {
          this.models.push({ kind: m.kind, data: conv, fallback: false });
          this.modelBounds.push(aliasModelBounds(conv));
        } else {
          this.models.push({ kind: m.kind, data: this.getGunMesh(), fallback: true });
          this.modelBounds.push(aliasModelBounds(this.getGunMesh()));
        }
      }
    } else {
      this.models.push({ kind: m.kind, data: m.data, fallback: false });
      this.modelBounds.push(null);
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
   * Conservative instance sphere cull (perf remediation item 1): the
   * world-space sphere covers the model under any rotation (|center| +
   * radius around the entity origin), so rotation, frame lerp (bounds
   * union all frames), near-plane straddlers, large models and the
   * depth-hack gun (explicitly exempt — eye-anchored by contract) are all
   * handled without origin-only shortcuts. Entities carry no
   * leaf/cluster association, so PVS is not consulted for them (the
   * world-surface traversal already applies PVS where it is reliable);
   * frustum-only is the exact, reliable rule here. True = skip all setup,
   * projection and fill work for this instance.
   */
  private sphereCulledAt(
    ox: number, oy: number, oz: number, b: ModelBounds, cam: Camera,
  ): boolean {
    const r = Math.sqrt(b.cx * b.cx + b.cy * b.cy + b.cz * b.cz) + b.r;
    return sphereCulledByFlatFrustum(
      this.frustumFlat,
      cam.origin[0]!, cam.origin[1]!, cam.origin[2]!,
      cam.forward[0]!, cam.forward[1]!, cam.forward[2]!, cam.near,
      ox, oy, oz, r);
  }

  /** Entity wrapper: depth-hack viewmodels always draw (see above). */
  private entityCulled(e: Entity, b: ModelBounds | null, cam: Camera): boolean {
    if (!b || e.depthHack === true) return false;
    return this.sphereCulledAt(e.origin[0]!, e.origin[1]!, e.origin[2]!, b, cam);
  }

  /** Memoised dev-mesh bounds for world-placed alias (see devMeshBounds). */
  private devBoundsFor(id: number): ModelBounds | null {
    const hit = this.devMeshBounds.get(id);
    if (hit !== undefined) return hit;
    let b: ModelBounds | null = null;
    try {
      b = aliasModelBounds(getDevMesh(id));
    } catch {
      b = null;
    }
    this.devMeshBounds.set(id, b);
    return b;
  }

  /** Per-frame entity cull counters (item 1 observability, test hook). */
  testEntityCullStats(): { culled: number; drawn: number } {
    return { culled: this.fgCulled, drawn: this.fgDrawn };
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
      this.rgbSkyMat = null;
      return;
    }
    this.skyTex = { width: tex.width, height: tex.height, texels: tex.texels.slice() };
    this.rgbSkyMat = null;
  }

  /**
   * True when this frame may take the RGB overlay path: the module flag is
   * on AND the active backend is the serial classic or the banded one (the
   * banded backend routes RGB spans per band; see drawRGBSpans). The wasm
   * backend has no RGB pass and refuses to enable while the flag is on.
   */
  /**
   * Select the serial RGB world pass for THIS renderer (what
   * `apps/web/src/play.ts` probes as `setRGBWorldEnabled` on the instance):
   * sets the shared module flag AND drops this renderer's RGB state
   * (coverage, both depth planes, RGB cache, palette-baked skin/sky memos)
   * so no stale frame survives the switch in either direction. Disabling
   * additionally marks the frame unused so endFrame skips the composite.
   */
  setRGBWorldEnabled(on: boolean): void {
    rgbWorldEnabled = on === true;
    this.rgbUsedThisFrame = false;
    if (this.rgbCover.length > 0) this.rgbCover.fill(0);
    // Window-Z clear value is all-ones (far) under the LESS-wins convention.
    if (this.rgbDepth16.length > 0) this.rgbDepth16.fill(0xffff);
    this.rgbCache.invalidateAll();
    this.rgbSkinMats.clear();
    this.rgbAliasMats.clear();
    this.clearRGBTextureChains();
    this.rgbSkyMat = null;
    this.rgbFlatSky = null;
  }

  /** Instance view of the shared RGB world flag (default false). */
  isRGBWorldEnabled(): boolean {
    return rgbWorldEnabled;
  }

  /**
   * Drop every cached raster (scalar surface cache, RGB light cache, and
   * the palette-baked skin/sky material memos). Palette changes and cvar
   * toggles funnel here; the next renderView rebuilds from source. Frame
   * planes are untouched (beginFrame clears those).
   */
  invalidateCaches(): void {
    this.cache.invalidateAll();
    this.lastTouched.length = 0;
    this.rgbCache.invalidateAll();
    this.rgbSkinMats.clear();
    this.rgbAliasMats.clear();
    this.clearRGBTextureChains();
    this.rgbSkyMat = null;
    this.rgbFlatSky = null;
  }

  /**
   * Surgical dlight invalidation: invalidate the union of the previous
   * frame's touched set and the current frame's affected set (both sorted
   * ascending — markLights sorts, and lastTouched is always a copy of a
   * past affected), deduped via a linear merge into the reused scratch.
   * Then lastTouched becomes the current set (copied, still sorted).
   * Zero allocation beyond the reused arrays' amortised growth.
   */
  private dropTouchedSurfaces(affected: number[]): void {
    const prev = this.lastTouched;
    if (prev.length === 0 && affected.length === 0) return;
    const scratch = this.touchScratch;
    scratch.length = 0;
    let i = 0, j = 0;
    while (i < affected.length && j < prev.length) {
      const a = affected[i]!, p = prev[j]!;
      if (a === p) { scratch.push(a); i++; j++; }
      else if (a < p) { scratch.push(a); i++; }
      else { scratch.push(p); j++; }
    }
    while (i < affected.length) scratch.push(affected[i++]!);
    while (j < prev.length) scratch.push(prev[j++]!);
    if (scratch.length > 0) {
      this.cache.invalidateSurfaces(scratch);
      this.rgbCache.invalidateSurfaces(scratch);
    }
    prev.length = 0;
    for (let k = 0; k < affected.length; k++) prev.push(affected[k]!);
  }

  /**
   * Refresh the per-frame fidelity snapshot (M4.1): read the vd_* cvars
   * once per renderView; on any change drop the RGB cache + memos so the
   * new policy rebuilds instead of serving stale materials. The shared
   * texture chains SURVIVE (they depend only on texels+palette, never on
   * the fidelity snapshot), so a cvar toggle re-links luxels without
   * re-expanding every texture. Also re-clears
   * the 16-bit plane when the zbits selection changed mid-stream (beginFrame
   * already cleared for the frame-start snapshot).
   */
  private syncRGBFidelity(): void {
    const snap = readRGBFidelity();
    if (sameRGBFidelity(snap, this.rgbFidelity)) return;
    const zChanged = snap.zbits !== this.rgbFidelity.zbits;
    this.rgbFidelity = snap;
    this.rgbCache.invalidateAll();
    this.rgbSkinMats.clear();
    this.rgbAliasMats.clear();
    this.rgbSkyMat = null;
    this.rgbFlatSky = null;
    if (zChanged && rgbWorldEnabled && this.rgbDepth16.length > 0) {
      this.rgbDepth16.fill(0xffff);
    }
  }

  private rgbOverlayActive(): boolean {
    return rgbWorldEnabled && (this.backend === this.tsBackend || this.backend === this.bandBackend);
  }

  /**
   * Route one RGB span batch (perf-2 lane): the serial classic backend draws
   * through the renderer's RGB backend, the banded backend partitions the
   * same spans per row band (absolute coords, bit-identical dither phase).
   * The caller runs inside rgbOverlayActive(); marks the frame used so
   * endFrame runs the single global composite.
   */
  private drawRGBSpans(list: SpanList, mat: RGBMaterial): void {
    if (this.backend === this.bandBackend) this.bandBackend.drawSpansRGB(list, mat, this.rgbWin);
    else this.rgbBackend.drawSpansRGB(list, mat, this.rgbWin);
    this.rgbUsedThisFrame = true;
  }

  /**
   * Stage one world RGB batch for the worker kick (PERF-2 RGB workers).
   * Only opaque, depth-writing world materials stage (the world + sky
   * materials: repeat or uniform-clamp addressing, always with a mip
   * chain); everything else (including any future translucent world use)
   * runs inline. Returns true when staged; false means the caller must
   * draw inline (no pool, inline-rest latch, staging miss, unsupported
   * material). On the first miss with batches already pending, pending
   * work replays inline first so global batch order is preserved, then
   * the rest of the frame stays inline (rgbInlineRest). All writes stay
   * depth-guarded: identical output either way. Never throws.
   */
  private stageRGBSpans(list: SpanList, mat: RGBMaterial): boolean {
    this.rgbUsedThisFrame = true;
    const pool = this.backend === this.bandBackend ? this.bandBackend.dispatcher : null;
    if (!pool || this.rgbInlineRest) {
      this.drawRGBSpans(list, mat);
      return false;
    }
    if (mat.blend !== 'opaque' || !mat.depthWrite) {
      this.drawInlineRGBRest(list, mat);
      return false;
    }
    const repeatS = mat.addressS === 'repeat';
    const repeatT = mat.addressT === 'repeat';
    if (repeatS !== repeatT) {
      this.drawInlineRGBRest(list, mat);
      return false;
    }
    let flags = 0;
    if (mat.warp) flags |= R_FLAG_WARP;
    if (mat.bilinear !== false) flags |= R_FLAG_BILINEAR;
    if (mat.mipDither) flags |= R_FLAG_MIPDITHER;
    if (mat.overbright) flags |= R_FLAG_OVERBRIGHT;
    // Upload-time opacity proof (perf remediation item 4): the worker core
    // skips the mask tap + hole branch for these batches.
    if (mat.opaqueMask) flags |= R_FLAG_OPAQUE;
    flags |= R_FLAG_DEPTHWRITE;
    if (repeatS) flags |= R_FLAG_REPEAT;
    let luxels: Uint8Array | null = null;
    let luxW = 0, luxH = 0;
    if (mat.light) {
      luxels = mat.light.samples;
      luxW = mat.light.luxW;
      luxH = mat.light.luxH;
      if (!(luxW > 0 && luxH > 0) || luxels.length < luxW * luxH * 3) {
        this.drawInlineRGBRest(list, mat);
        return false;
      }
      flags |= R_FLAG_LIGHT;
    }
    let flatRGB = 0;
    if (mat.flatColor) {
      if (mat.flatColor.length < 3) {
        this.drawInlineRGBRest(list, mat);
        return false;
      }
      flags |= R_FLAG_FLAT;
      flatRGB = ((mat.flatColor[0]! & 255) << 16) | ((mat.flatColor[1]! & 255) << 8) | (mat.flatColor[2]! & 255);
    }
    const count = list.count < list.spans.length ? list.count : list.spans.length;
    const ok = pool.stageRGB(
      list, 0, count, mat.levels, luxels, luxW, luxH,
      flags, mat.zbits, mat.turbPhase, flatRGB,
    );
    if (!ok) {
      this.drawInlineRGBRest(list, mat);
      return false;
    }
    this.rgbStagedBatches++;
    return true;
  }

  /**
   * Inline fallback for an RGB batch that could not stage: replay any
   * pending staged work inline first (ordering), draw this batch inline,
   * and latch the rest of the frame inline (the deferred kick must not
   * wipe these direct plane writes). Identical output via depth-guarded
   * convergence. `fg` selects the foreground counters (task 1) instead of
   * the world counters; the latch is shared (one inline write anywhere
   * pins the rest of the frame inline).
   */
  private drawInlineRGBRest(list: SpanList, mat: RGBMaterial, fg = false): void {
    const pool = this.backend === this.bandBackend ? this.bandBackend.dispatcher : null;
    if (pool && pool.rgbPending() > 0) {
      const q = pool.drawInlineRGBAll(this.rgbWin.near, this.rgbWin.far, this.rgbFidelity.lodBias);
      this.rgbBackend.spansDrawn += q.spans;
      this.rgbBackend.pixelsDrawn += q.pixels;
      this.rangeScanned += q.scanned ?? 0;
    }
    this.rgbInlineRest = true;
    if (fg) this.fgInlineBatches++;
    else this.rgbInlineBatches++;
    this.drawRGBSpans(list, mat);
  }

  /**
   * Complete the staged RGB frame (blocking): one worker kick, tallied
   * into the RGB backend counters for observability. Timeout/pool failure
   * replays inline via the dispatcher (identical). No-op without staged
   * work or once the inline-rest latch tripped. Frame stats intentionally
   * track the classic path only, so counters here are observability-only.
   */
  private flushRGB(): void {
    const pool = this.backend === this.bandBackend ? this.bandBackend.dispatcher : null;
    if (!pool || this.rgbInlineRest || pool.rgbPending() === 0) return;
    const r = pool.flushRGBFrame(this.rgbWin.near, this.rgbWin.far, this.rgbFidelity.lodBias);
    if (r) {
      this.rgbBackend.spansDrawn += r.spans;
      this.rgbBackend.pixelsDrawn += r.pixels;
      this.rangeScanned += r.scanned ?? 0;
      this.rgbKicks++;
      return;
    }
    const q = pool.drawInlineRGBAll(this.rgbWin.near, this.rgbWin.far, this.rgbFidelity.lodBias);
    this.rgbBackend.spansDrawn += q.spans;
    this.rgbBackend.pixelsDrawn += q.pixels;
    this.rangeScanned += q.scanned ?? 0;
  }

  /**
   * Same as flushRGB but message-driven (browser async completion: no
   * Atomics.wait on the calling thread). Falls back to inline replay.
   */
  private async flushRGBAsync(): Promise<void> {
    const pool = this.backend === this.bandBackend ? this.bandBackend.dispatcher : null;
    if (!pool || this.rgbInlineRest || pool.rgbPending() === 0) return;
    const r = await pool.flushRGBFrameAsync(this.rgbWin.near, this.rgbWin.far, this.rgbFidelity.lodBias);
    if (r) {
      this.rgbBackend.spansDrawn += r.spans;
      this.rgbBackend.pixelsDrawn += r.pixels;
      this.rangeScanned += r.scanned ?? 0;
      this.rgbKicks++;
      return;
    }
    const q = pool.drawInlineRGBAll(this.rgbWin.near, this.rgbWin.far, this.rgbFidelity.lodBias);
    this.rgbBackend.spansDrawn += q.spans;
    this.rgbBackend.pixelsDrawn += q.pixels;
    this.rangeScanned += q.scanned ?? 0;
  }

  /**
   * World RGB batch route (PERF-2 RGB workers): stage for the worker kick
   * when pooled, draw inline otherwise. Foreground RGB always uses
   * drawRGBSpans directly (inline after the kick completes).
   */
  private drawWorldRGBSpans(list: SpanList, mat: RGBMaterial): void {
    const pooled = this.backend === this.bandBackend ? this.bandBackend.dispatcher : null;
    if (pooled) {
      this.stageRGBSpans(list, mat);
      return;
    }
    this.rgbInlineBatches++;
    this.drawRGBSpans(list, mat);
  }

  /**
   * Stage one foreground RGB batch for the worker kick (renderer lane task
   * 1). Accepts exactly the serial foreground span draws: opaque,
   * depth-writing batches (world-placed sprites) and alpha-blended,
   * non-depth-writing batches (deferred TRANS33/66 glass). Addressing must
   * be uniform (repeat or clamp on both axes — the staged protocol carries
   * one bit); FLAT fills and per-pixel/triangle foreground (alias,
   * particles, tracers, entities) stay inline. World-before-foreground
   * order is preserved by descriptor order per band: the world kick (or
   * the inline-rest replay) always drains before any foreground stage, and
   * each foreground group flushes before the next inline direct write (see
   * drawForeground). Every write stays depth-guarded: identical output
   * either way. Never throws. Returns true when staged.
   */
  private stageForegroundRGBSpans(list: SpanList, mat: RGBMaterial): boolean {
    this.rgbUsedThisFrame = true;
    const pool = this.backend === this.bandBackend ? this.bandBackend.dispatcher : null;
    if (!pool || this.rgbInlineRest) {
      this.fgInlineBatches++;
      this.drawRGBSpans(list, mat);
      return false;
    }
    const blendAlpha = mat.blend === 'alpha';
    const opaqueOk = mat.blend === 'opaque' && mat.depthWrite;
    const alphaOk = blendAlpha && !mat.depthWrite;
    if (!opaqueOk && !alphaOk) {
      this.drawInlineRGBRest(list, mat, true);
      return false;
    }
    const repeatS = mat.addressS === 'repeat';
    const repeatT = mat.addressT === 'repeat';
    if (repeatS !== repeatT) {
      this.drawInlineRGBRest(list, mat, true);
      return false;
    }
    let flags = 0;
    if (mat.warp) flags |= R_FLAG_WARP;
    if (mat.bilinear !== false) flags |= R_FLAG_BILINEAR;
    if (mat.mipDither) flags |= R_FLAG_MIPDITHER;
    if (mat.overbright) flags |= R_FLAG_OVERBRIGHT;
    if (mat.opaqueMask) flags |= R_FLAG_OPAQUE;
    if (mat.depthWrite) flags |= R_FLAG_DEPTHWRITE;
    if (repeatS) flags |= R_FLAG_REPEAT;
    if (blendAlpha) flags |= R_FLAG_BLEND_ALPHA;
    let luxels: Uint8Array | null = null;
    let luxW = 0, luxH = 0;
    if (mat.light) {
      luxels = mat.light.samples;
      luxW = mat.light.luxW;
      luxH = mat.light.luxH;
      if (!(luxW > 0 && luxH > 0) || luxels.length < luxW * luxH * 3) {
        this.drawInlineRGBRest(list, mat, true);
        return false;
      }
      flags |= R_FLAG_LIGHT;
    }
    if (mat.flatColor) {
      this.drawInlineRGBRest(list, mat, true);
      return false;
    }
    const count = list.count < list.spans.length ? list.count : list.spans.length;
    const ok = pool.stageRGB(
      list, 0, count, mat.levels, luxels, luxW, luxH,
      flags, mat.zbits, mat.turbPhase, 0,
    );
    if (!ok) {
      this.drawInlineRGBRest(list, mat, true);
      return false;
    }
    this.fgStagedBatches++;
    return true;
  }

  /**
   * Foreground RGB batch route (task 1): stage span-based foreground
   * (deferred alpha, world sprites) for the worker kick when pooled, draw
   * inline otherwise. Per-pixel/triangle foreground always draws inline
   * via drawRGBSpans (alias, particles, tracers, entities).
   */
  private drawForegroundRGBSpans(list: SpanList, mat: RGBMaterial): void {
    const pooled = this.backend === this.bandBackend ? this.bandBackend.dispatcher : null;
    if (pooled) {
      this.stageForegroundRGBSpans(list, mat);
      return;
    }
    this.fgInlineBatches++;
    this.drawRGBSpans(list, mat);
  }

  /**
   * Complete staged foreground RGB work (blocking): one worker kick over
   * the batches staged since the last flush, tallied into the RGB backend
   * counters. Called at each point where staged foreground must become
   * visible before a subsequent inline direct write (alpha before alias,
   * sprites before particles) — this is what preserves the serial order
   * with mixed inline/staged foreground. Timeout/pool failure replays
   * inline (identical). No-op without staged work or once the inline-rest
   * latch tripped.
   */
  private flushForegroundRGB(): void {
    const pool = this.backend === this.bandBackend ? this.bandBackend.dispatcher : null;
    if (!pool || this.rgbInlineRest || pool.rgbPending() === 0) return;
    const r = pool.flushRGBFrame(this.rgbWin.near, this.rgbWin.far, this.rgbFidelity.lodBias);
    if (r) {
      this.rgbBackend.spansDrawn += r.spans;
      this.rgbBackend.pixelsDrawn += r.pixels;
      this.rangeScanned += r.scanned ?? 0;
      this.fgKicks++;
      return;
    }
    const q = pool.drawInlineRGBAll(this.rgbWin.near, this.rgbWin.far, this.rgbFidelity.lodBias);
    this.rgbBackend.spansDrawn += q.spans;
    this.rgbBackend.pixelsDrawn += q.pixels;
    this.rangeScanned += q.scanned ?? 0;
  }

  /**
   * Same as flushForegroundRGB but message-driven (browser async
   * completion: no Atomics.wait on the calling thread), used at the same
   * two flush points by drawForegroundAsync. The browser pool's sync flush
   * always declines (null) and its async flush runs the staged batches on
   * workers; the Node pool serves both. Async decline/timeout/failure
   * falls back to the sync flush (identical inline replay). No-op without
   * staged work or once the inline-rest latch tripped.
   */
  private async flushForegroundRGBAsync(): Promise<void> {
    const pool = this.backend === this.bandBackend ? this.bandBackend.dispatcher : null;
    if (!pool || this.rgbInlineRest || pool.rgbPending() === 0) return;
    try {
      const r = await pool.flushRGBFrameAsync(this.rgbWin.near, this.rgbWin.far, this.rgbFidelity.lodBias);
      if (r) {
        this.rgbBackend.spansDrawn += r.spans;
        this.rgbBackend.pixelsDrawn += r.pixels;
        this.rangeScanned += r.scanned ?? 0;
        this.fgKicks++;
        return;
      }
    } catch {
      /* fall through to the sync flush below */
    }
    this.flushForegroundRGB();
  }

  /**
   * Seed the packed RGB565 plane from the indexed framebuffer (palette
   * expand + 8:8:8 -> 565 quantise) before any RGB foreground/alpha draws.
   * Alpha/additive RGB composites read the STORED 565 quantum as their
   * destination, so the seed gives them the exact software background
   * (opaque world already drawn classically); opaque RGB writes overwrite
   * it. Pixels the world RGB pass already covered are spared (their
   * filtered color survives); uncovered pixels composite from the identical
   * indexed expand in endFrame either way. Called once at the top of
   * drawForeground (covers world + foreground).
   */
  private seedRGBBackground(): void {
    const pal = this.palette;
    const src = this.idx;
    const dst = this.rgb565;
    const cover = this.rgbCover;
    const n = this.fbW * this.fbH;
    for (let i = 0; i < n; i++) {
      if (cover[i] !== 0) continue;
      const c = src[i]! * 3;
      const r = pal[c]!, g = pal[c + 1]!, b = pal[c + 2]!;
      const rr = r < 0 ? 0 : r > 255 ? 255 : r | 0;
      const gg = g < 0 ? 0 : g > 255 ? 255 : g | 0;
      const bb = b < 0 ? 0 : b > 255 ? 255 : b | 0;
      dst[i] = (((rr >> 3) << 11) | ((gg >> 2) << 5) | (bb >> 3)) & 0xffff;
    }
  }

  /**
   * Palette-baked RGB material for an entity/placed skin (unlit: alias and
   * sprite lighting rides vertex colors / fullbright, not a lightmap).
   * Cached by Texture identity; cleared on setPalette, cvar toggles and
   * renderer enable/disable. Sampling policy comes from the per-frame
   * fidelity snapshot (overbright is inert here — no lightmap to modulate).
   * Sprites keep the 255-hole mask (masked); alias models are opaque.
   */
  private rgbMaterialForSkin(skin: Texture): RGBMaterial {
    const fid = this.rgbFidelity;
    let mat = this.rgbSkinMats.get(skin);
    if (!mat) {
      mat = buildRGBMaterial(skin.texels, skin.width, skin.height, this.palette, null, {
        addressS: 'clamp', addressT: 'clamp',
        overbright: fid.overbright, lodBias: fid.lodBias, mipDither: fid.mipDither,
        bilinear: fid.bilinear, zbits: fid.zbits,
      });
      this.rgbSkinMats.set(skin, mat);
    }
    return mat;
  }

  /**
   * Opaque palette-baked RGB material for alias (MD2) models: identical to
   * rgbMaterialForSkin except opaqueMask (index 255 draws opaque, never a
   * hole — see the rgbAliasMats field doc for the id-source audit) plus the
   * ALIAS_LOD_BIAS_DELTA hook (currently 0: the mip-UV-scale fix removed
   * the gutter collapse that motivated the old -3.3 content bias — see its
   * doc comment). Separate cache because the mask is baked into the mip
   * chain at upload.
   */
  private rgbMaterialForAlias(skin: Texture): RGBMaterial {
    const fid = this.rgbFidelity;
    let mat = this.rgbAliasMats.get(skin);
    if (!mat) {
      mat = buildRGBMaterial(skin.texels, skin.width, skin.height, this.palette, null, {
        addressS: 'clamp', addressT: 'clamp',
        overbright: fid.overbright, lodBias: fid.lodBias + ALIAS_LOD_BIAS_DELTA, mipDither: fid.mipDither,
        bilinear: fid.bilinear, zbits: fid.zbits, opaqueMask: true,
      });
      this.rgbAliasMats.set(skin, mat);
    }
    return mat;
  }

  /** Palette-baked RGB material for the packed skybox strip (clamp, unlit). */
  private rgbMaterialForSky(): RGBMaterial | null {
    const sky = this.skyTex;
    if (!sky) return null;
    const cached = this.rgbSkyMat;
    if (cached && cached.tex.width === sky.width && cached.tex.height === sky.height &&
      cached.tex.texels.length === sky.texels.length) {
      return cached.mat;
    }    const fid = this.rgbFidelity;
    const mat = buildRGBMaterial(sky.texels, sky.width, sky.height, this.palette, null, {
      addressS: 'clamp', addressT: 'clamp',
      overbright: fid.overbright, lodBias: fid.lodBias, mipDither: fid.mipDither,
      bilinear: fid.bilinear, zbits: fid.zbits, opaqueMask: true,
    });
    this.rgbSkyMat = { tex: { width: sky.width, height: sky.height, texels: sky.texels }, mat };
    return mat;
  }

  /** Palette-baked flat RGB material for untextured sky (solid sky color). */
  private rgbMaterialForFlatSky(): RGBMaterial {
    const cached = this.rgbFlatSky;
    if (cached && cached.index === this.skyIndex) return cached.mat;
    const c = this.skyIndex * 3;
    const flat = new Uint8Array([
      this.palette[c] ?? 0, this.palette[c + 1] ?? 0, this.palette[c + 2] ?? 0,
    ]);
    const fid = this.rgbFidelity;
    const mat = buildRGBMaterial(new Uint8Array([0]), 1, 1, this.palette, null, {
      flatColor: flat, opaqueMask: true,
      overbright: fid.overbright, lodBias: fid.lodBias, mipDither: fid.mipDither,
      bilinear: fid.bilinear, zbits: fid.zbits,
    });
    this.rgbFlatSky = { index: this.skyIndex, mat };
    return mat;
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
      this.rgbInlineRest = false;
    } else {
      this.idx.fill(0);
      this.zb.fill(0);
    }
    this.backend.spansDrawn = 0;
    this.backend.pixelsDrawn = 0;
    this.backend.time = 0;
    this.transSpans = 0;
    // RGB plane binding follows the live depth plane (backend switches swap
    // this.zb; re-attaching here keeps the RGB backend on the active one).
    // Cover clears only while enabled — disabled frames skip the composite
    // so the extra fill costs nothing and output is untouched.
    this.rgbBackend.spansDrawn = 0;
    this.rgbBackend.pixelsDrawn = 0;
    this.rgbUsedThisFrame = false;
    this.rgbStagedBatches = 0;
    this.rgbInlineBatches = 0;
    this.rgbKicks = 0;
    this.fgStagedBatches = 0;
    this.fgInlineBatches = 0;
    this.fgKicks = 0;
    this.classicAvoidedBuilds = 0;
    this.classicAvoidedBytes = 0;
    this.rangeScanned = 0;
    this.classicSpansSkipped = 0;
    this.classicFgSkipped = 0;
    if (rgbWorldEnabled) {
      this.rgbBackend.attach(this.rgb565, this.rgbCover, this.rgbDepth16, this.fbW, this.fbH, this.rgbColor);
      this.rgbCover.fill(0);
      // Window-Z clear value is all-ones (far) under the LESS-wins
      // convention (see the field doc).
      this.rgbDepth16.fill(0xffff);
      // The banded backend partitions RGB spans per row band over the same
      // planes (workers never touch them); binding follows the live planes
      // like the serial backend above.
      if (this.backend === this.bandBackend) {
        this.bandBackend.attachRGB(this.rgb565, this.rgbCover, this.rgbDepth16, this.fbW, this.fbH, this.rgbColor);
      }
    }
    this.rgbCache.nextFrame();
  }

  renderView(view: RefDef, world: WorldModel, entities: Entity[]): FrameStats {
    const t0 = Date.now();
    // M4.1: fidelity snapshot once per view (cvar toggles invalidate below).
    this.syncRGBFidelity();
    // Perf remediation item 1: per-frame entity cull counters (drawForeground
    // accumulates; the async path's phase-1 renderView resets before the
    // phase-2 drawForeground counts).
    this.fgCulled = 0;
    this.fgDrawn = 0;
    const ph = this.phaseArmed ? this.phaseAcc : null;
    let pt = ph ? phaseNow() : 0;
    const worldData = isMiniWorld(world.data) ? world.data : createDevroom();
    // Reuse the scratch camera across frames (allocation-free steady state;
    // bit-identical to a fresh setupCamera — see setupCameraInto).
    const cam = this.camMemo
      ? setupCameraInto(this.camMemo, view.origin, view.angles, view.fovX, this.fbW, this.fbH)
      : (this.camMemo = setupCamera(view.origin, view.angles, view.fovX, this.fbW, this.fbH));
    // Thread the projection window (near/far) into every RGB draw this
    // frame: the window-Z mapping derives normalized depth from it.
    this.rgbWin = { near: cam.near, far: cam.far };
    this.rgbBackend.setWindow(cam.near, cam.far);
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
    // Surgical dlight invalidation (ownership fix): drop every surface the
    // lights touched LAST frame or touch THIS frame, on both caches. The
    // union covers expiry/removal — a gone light's surfaces were touched
    // last frame, so they rebuild to baseline exactly once — while surfaces
    // no light ever reaches keep hot entries across serial bumps (a muzzle
    // flash used to invalidateAll both caches every frame: full rebuild +
    // megabytes of garbage per combat frame). The keys carry no global
    // serial (it would miss for every surface on every bump and leak
    // never-read old-serial entries); completeness of the union is the
    // correctness argument (see the lastTouched field doc). Reused array,
    // no per-frame allocation beyond markLights' own.
    this.dropTouchedSurfaces(affected);
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
    // PERF-FINISH-A item A (authoritative RGB skip, default on): elide the
    // redundant classic world spanfill wherever the RGB overlay drew. The
    // gate is the overlay itself, not the translucency mode: every skipped
    // classic write lands on an RGB-covered pixel (resolved from the RGB
    // planes in endFrame), and every classic *read* of the skipped planes
    // is skipped together with it (the foreground RGB twins test against
    // the RGB window-Z plane and blend against the seeded RGB background;
    // covered in detail on SW_RGB_SKIP_CLASSIC_CVAR). Per-batch: classic
    // still runs wherever no RGB material drew (unusable lightmap), so
    // uncovered pixels keep exact classic values. Software mode (overlay
    // off) never skips. Frame stats intentionally still track the classic
    // path, so they undercount while the skip is armed.
    const skipClassicWorld = skipClassicRequested() && this.rgbOverlayActive();
    this.fgSkipClassic = skipClassicWorld;
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
        // Task 3: skip the unused classic flat-span packing when the
        // classic fill below is elided (RGB stager packs from the objects).
        const flat = skipClassicWorld ? undefined : this.flatForEmit(SPAN_FLAT, order, this.skyIndex, 0, null);
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
        // PERF-FINISH-A item D (zero-scan): the sky fill batch came straight
        // from emitSpansForPoly (one span per row, strictly ascending y —
        // the emitter invariant, guarded by the fuzz test in
        // emitOrder.test.ts), which is exactly the order the row z-sort
        // establishes. No validation scan, no sort: both were proven
        // no-ops here. The general sorter (sortBatchByRow) is retained for
        // non-emitter batches (deferred alpha loop, manual spans).
        if (ph) { ph.sort += phaseNow() - pt; pt = phaseNow(); }
        this.spanList.count = endCount;
        // Authoritative skip (item A): elide the redundant classic fill
        // where the RGB overlay drew (always does here — flat sky always
        // builds its material); count the eliminated spans.
        if (skipClassicWorld) {
          this.classicSpansSkipped += endCount - start;
        } else {
          this.backend.drawSpans(this.spanList, texView, lightView);
        }
        if (this.rgbOverlayActive()) {
          this.drawWorldRGBSpans(this.spanList, this.rgbMaterialForFlatSky());
        }
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
      // PERF-FINISH-A item D: squared-distance mip select — sqrt is
      // strictly monotonic on [0, inf), so `d2 < T*T` selects exactly the
      // same mip as `sqrt(d2) < T` (boundary equality included), while
      // saving one sqrt per admitted surface (~8K/frame on base1).
      const d2 =
        (surf.center[0]! - view.origin[0]!) ** 2 +
        (surf.center[1]! - view.origin[1]!) ** 2 +
        (surf.center[2]! - view.origin[2]!) ** 2;
      const mip = d2 < 102400 ? 0 : d2 < 409600 ? 1 : d2 < 1638400 ? 2 : 3;
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
      // Task 3 (block-free RGB): while the authoritative skip is armed the
      // scalar block has no consumer (classic is elided wherever the RGB
      // material draws), so RGB hits skip it untouched and RGB misses build
      // the material without it (validation from the source dims; the entry
      // stores the shared empty scalar sentinel — never rasterised). The
      // scalar block builds only when RGB fails (classic fallback) or
      // under the oracle. One scalar lookup per surface either way, so the
      // cache stats below are not double-counted. Cache keys + invalidation
      // are unchanged (both caches drop together in dropTouchedSurfaces),
      // so a later oracle frame simply rebuilds scalar entries the RGB
      // frames skipped.
      let block: SurfaceBlock | null = null;
      let rgbMat: RGBMaterial | null = null;
      let scalarFetched = false;
      if (skipClassicWorld && !surf.sky) {
        const rgbHit = this.rgbCache.get(surf.id, stylesHash, mip, 0);
        if (rgbHit) {
          rgbMat = rgbHit.material;
          // Warp phase is frame state, not cached state (see below).
          if (rgbMat.warp) rgbMat.turbPhase = (((this.backend.time * 64) | 0) & 1023);
        } else {
          block = this.cache.get(surf.id, stylesHash, mip);
          scalarFetched = true;
          if (block === null) {
            rgbMat = this.buildRGBEntry(
              worldData, surf, null, stylesHash, mip,
              view.lightStyles, dyn, dlightFrameBits(surf.id),
              { variant: 0 },
            );
            if (rgbMat) {
              if (rgbMat.warp) rgbMat.turbPhase = (((this.backend.time * 64) | 0) & 1023);
              this.classicAvoidedBuilds++;
              const srcT = worldData.textures[surf.texId % worldData.textures.length]!;
              const shift = mip > 3 ? 3 : mip;
              this.classicAvoidedBytes += Math.max(1, srcT.width >> shift) *
                Math.max(1, srcT.height >> shift) + lm.luxW * lm.luxH;
            }
          } else {
            rgbMat = this.buildRGBEntry(
              worldData, surf, block, stylesHash, mip,
              view.lightStyles, dyn, dlightFrameBits(surf.id),
              { variant: 0 },
            );
            if (rgbMat && rgbMat.warp) rgbMat.turbPhase = (((this.backend.time * 64) | 0) & 1023);
          }
        }
      }
      if (!rgbMat) {
        if (!scalarFetched) block = this.cache.get(surf.id, stylesHash, mip);
        if (!block) {
          // copy the style scales out of scratch (build is a miss-only path;
          // the shared scratch is exact: buildSurfaceBlock consumes the
          // scales synchronously and never retains them).
          if (nValid < 0) nValid = countValidStyles(lm, view.lightStyles, this.styleScratch);
          const scalesCopy = this.scalesScratch;
          scalesCopy.length = 0;
          for (let k = 0; k < nValid; k++) scalesCopy.push(this.styleScratch[k]!);
          if (scalesCopy.length === 0) scalesCopy.push(1);
          block = this.buildSurfaceBlock(worldData, surf, mip, scalesCopy, dyn, dlightFrameBits(surf.id));
          this.cache.put(surf.id, stylesHash, mip, block);
        }
        texView.width = block.bw;
        texView.height = block.bh;
        texView.texels = block.texels;
        lightView.width = block.luxW;
        lightView.height = block.luxH;
        lightView.values = block.light;
      }
      if (ph) { ph.cache += phaseNow() - pt; pt = phaseNow(); }
      // RGB (voodoo-policy) binding for the world pass (oracle order: the
      // skip-armed path above already resolved or fell back to scalar).
      // Null (unusable lightmap, pooled/wasm backend, flag off) falls back
      // to the scalar backend alone.
      if (!rgbMat && this.rgbOverlayActive() && !surf.sky && block && !skipClassicWorld) {
        const rgbHit = this.rgbCache.get(surf.id, stylesHash, mip, 0);
        rgbMat = rgbHit
          ? rgbHit.material
          : this.buildRGBEntry(
            worldData, surf, block, stylesHash, mip,
            view.lightStyles, dyn, dlightFrameBits(surf.id),
            { variant: 0 },
          );
        // Warp phase is frame state, not cached state: refresh the shared
        // material every frame so turbulent water scrolls instead of
        // freezing on its build frame.
        if (rgbMat && rgbMat.warp) rgbMat.turbPhase = (((this.backend.time * 64) | 0) & 1023);
      }
      // emit (skip the fused classic flat-span packing when the classic
      // draw below is elided — the RGB stager packs from the span objects,
      // so the SAB flat copy would be unused staging writes).
      const willSkipClassic = skipClassicWorld && rgbMat !== null;
      this.polyInput.verts = surf.verts;
      this.polyInput.uvs = surf.uvs;
      this.polyInput.lux = surf.lux;
      this.polyInput.n = surf.n;
      const nproj = projectClippedPoly(this.polyInput, cam, this.fbW, this.fbH, this.scratch);
      if (ph) { ph.project += phaseNow() - pt; pt = phaseNow(); }
      if (nproj < 3) { if (d) d.clipRejected++; continue; }
      const start = this.spanList.count;
      const flat = willSkipClassic ? undefined : this.flatForEmit(
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
      // PERF-FINISH-A item D (zero-scan): single-poly world batch straight
      // from emitSpansForPoly — emitter-ordered by construction, no
      // validation scan, no sort (see the sky-fill site above).
      if (ph) { ph.sort += phaseNow() - pt; pt = phaseNow(); }
      this.spanList.count = endCount;
      // Authoritative skip (item A): elide the classic draw only where an
      // RGB material drew (unusable lightmaps fall back to classic, so
      // uncovered pixels keep exact values); count eliminated spans.
      // Frame stats intentionally track the classic path only.
      if (skipClassicWorld && rgbMat) {
        this.classicSpansSkipped += endCount - start;
      } else {
        this.backend.drawSpans(this.spanList, texView, lightView);
      }
      if (rgbMat) {
        this.drawWorldRGBSpans(this.spanList, rgbMat);
      }
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
      this.rangeScanned += this.bandBackend.flushAccum();
      if (ph) { ph.draw += phaseNow() - pt; pt = phaseNow(); }
    }
    // RGB worker kick (PERF-2): drain staged world RGB batches before any
    // direct RGB plane write. The foreground seed reads the indexed planes
    // (finished above) and writes rgb565 for uncovered pixels; foreground
    // RGB draws inline after it. Unpooled / nothing staged / inline-rest:
    // no-op, batches already drew inline. Deferred in the async path (the
    // async driver awaits flushRGBAsync after the indexed kick instead —
    // a blocking kick here would serialize the browser main thread).
    // No zb backfill: under the authoritative skip (item A) no classic
    // read of the skipped planes survives — the foreground RGB twins test
    // against the RGB window-Z plane — so the lossy quantised->float
    // reconstruction is gone, not just unused.
    if (this.rgbUsedThisFrame &&
      !(this.backend === this.bandBackend && this.bandBackend.flushDeferred)) {
      if (ph) pt = phaseNow();
      this.flushRGB();
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
   * Foreground segment 1: RGB background seed + deferred translucent alpha
   * (R_DrawAlphaSurfaces) pass. Split from drawForeground for async
   * orchestration (see drawForeground): the body is unchanged, ends
   * immediately before the alpha flush point. Returns the alpha spans
   * emitted (feeds the stats stash).
   */
  private drawForegroundAlphaPass(cam: Camera, worldData: MiniWorld, view: RefDef, dyn: DynamicLight[]): number {
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
    // RGB background seed (step 3): alpha/additive RGB foreground draws
    // composite against the current plane pixel, so seed the plane with the
    // exact software background (opaque world, classically drawn above)
    // before any RGB foreground write. Opaque RGB writes overwrite it.
    const rgbActive = this.rgbOverlayActive();
    if (rgbActive) this.seedRGBBackground();
    // Authoritative skip (item A): the foreground RGB twins below are the
    // displayed values in Voodoo mode, so the redundant classic draws are
    // elided and counted. The RGB depth tests run against the RGB
    // window-Z plane and blends against the seeded background — no skipped
    // classic value is ever read.
    const fgSkip = this.fgSkipClassic && rgbActive;
    for (let a = this.fgAlphaCount - 1; a >= 0; a--) {
      const si = this.alphaDeferredSi[a]!;
      const order = this.alphaDeferredOrd[a]!;
      const surf = worldData.surfaces[si]!;
      const trRaw = surf.translucent ?? 0;
      const tr = trRaw === 2 ? 2 : trRaw === 1 ? 1 : 0;
      // PERF-FINISH-A item D: squared-distance mip select — sqrt is
      // strictly monotonic on [0, inf), so `d2 < T*T` selects exactly the
      // same mip as `sqrt(d2) < T` (boundary equality included), while
      // saving one sqrt per admitted surface (~8K/frame on base1).
      const d2 =
        (surf.center[0]! - view.origin[0]!) ** 2 +
        (surf.center[1]! - view.origin[1]!) ** 2 +
        (surf.center[2]! - view.origin[2]!) ** 2;
      const mip = d2 < 102400 ? 0 : d2 < 409600 ? 1 : d2 < 1638400 ? 2 : 3;
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
      // Task 3 (block-free RGB, alpha variant): same contract as the world
      // pass above — RGB hits skip the scalar block untouched, RGB misses
      // build the alpha material without it, and the scalar block builds
      // only when RGB fails (classic fallback) or under the oracle.
      let block: SurfaceBlock | null = null;
      let alphaRgbMat: RGBMaterial | null = null;
      let alphaScalarFetched = false;
      if (fgSkip) {
        const rgbHit = this.rgbCache.get(surf.id, stylesHash, mip, 1);
        if (rgbHit) {
          alphaRgbMat = rgbHit.material;
          if (alphaRgbMat.warp) alphaRgbMat.turbPhase = (((this.backend.time * 64) | 0) & 1023);
        } else {
          const got = this.cache.get(surf.id, stylesHash, mip);
          alphaScalarFetched = true;
          if (got === null) {
            alphaRgbMat = this.buildRGBEntry(
              worldData, surf, null, stylesHash, mip,
              view.lightStyles, dyn, this.alphaDeferredBits[a]!,
              { blend: 'alpha', depthWrite: false, variant: 1 },
            );
            if (alphaRgbMat) {
              if (alphaRgbMat.warp) alphaRgbMat.turbPhase = (((this.backend.time * 64) | 0) & 1023);
              this.classicAvoidedBuilds++;
              const srcT = worldData.textures[surf.texId % worldData.textures.length]!;
              const shift = mip > 3 ? 3 : mip;
              this.classicAvoidedBytes += Math.max(1, srcT.width >> shift) *
                Math.max(1, srcT.height >> shift) + lm.luxW * lm.luxH;
            }
          } else {
            block = got;
            alphaRgbMat = this.buildRGBEntry(
              worldData, surf, block, stylesHash, mip,
              view.lightStyles, dyn, this.alphaDeferredBits[a]!,
              { blend: 'alpha', depthWrite: false, variant: 1 },
            );
            if (alphaRgbMat && alphaRgbMat.warp) alphaRgbMat.turbPhase = (((this.backend.time * 64) | 0) & 1023);
          }
        }
      }
      if (!alphaRgbMat) {
        if (!alphaScalarFetched) block = this.cache.get(surf.id, stylesHash, mip);
        if (!block) {
          // Shared scratch (task 6, same contract as the world miss path).
          if (nValid < 0) nValid = countValidStyles(lm, view.lightStyles, this.styleScratch);
          const scalesCopy = this.scalesScratch;
          scalesCopy.length = 0;
          for (let k = 0; k < nValid; k++) scalesCopy.push(this.styleScratch[k]!);
          if (scalesCopy.length === 0) scalesCopy.push(1);
          block = this.buildSurfaceBlock(worldData, surf, mip, scalesCopy, dyn, this.alphaDeferredBits[a]!);
          this.cache.put(surf.id, stylesHash, mip, block);
        }
        texView.width = block.bw;
        texView.height = block.bh;
        texView.texels = block.texels;
        lightView.width = block.luxW;
        lightView.height = block.luxH;
        lightView.values = block.light;
      }
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
      // RGB overlay (oracle order: the skip-armed path above already
      // resolved or fell back to scalar): same spans, true alpha blend
      // (never the screen-door stipple — the RGB path has no stipple),
      // warped when the surface is turbulent, never depth-writing. Reverse
      // traversal order is preserved (back-to-front over-blend). Resolved
      // first so the authoritative skip below can test coverage. Staged
      // into the RGB worker kick when pooled (task 1), drawn inline
      // otherwise.
      if (!alphaRgbMat && this.rgbOverlayActive() && block && !fgSkip) {
        const rgbHit = this.rgbCache.get(surf.id, stylesHash, mip, 1);
        alphaRgbMat = rgbHit
          ? rgbHit.material
          : this.buildRGBEntry(
            worldData, surf, block, stylesHash, mip,
            view.lightStyles, dyn, this.alphaDeferredBits[a]!,
            { blend: 'alpha', depthWrite: false, variant: 1 },
          );
        if (alphaRgbMat) {
          if (alphaRgbMat.warp) alphaRgbMat.turbPhase = (((this.backend.time * 64) | 0) & 1023);
          this.drawForegroundRGBSpans(this.spanList, alphaRgbMat);
        }
      } else if (alphaRgbMat) {
        this.drawForegroundRGBSpans(this.spanList, alphaRgbMat);
      }
      // Authoritative skip (item A): elide the redundant classic blend
      // where the RGB overlay drew (its blend is the displayed value);
      // count the eliminated spans. Falls back to classic when no RGB
      // material exists (degenerate lightmap), so output shape is kept.
      if (this.fgSkipClassic && alphaRgbMat) {
        this.classicSpansSkipped += endCount - start;
      } else {
        this.ensureAlphamap();
        const tb = this.tsBackend;
        if (this.backend !== tb) tb.attach(this.idx, this.zb, this.fbW, this.fbH, this.colormap);
        const t = drawSpansTranslucent(this.idx, this.zb, this.fbW, this.fbH, this.spanList,
          texView, lightView, this.colormap, this.alpha33, this.alpha66,
          surf.turbulent ? tb.turbTable : null, view.time, this.fgTMode === 2);
        this.transSpans += t.spans;
        if (this.backend === tb) {
          tb.spansDrawn += t.spans;
          tb.pixelsDrawn += t.pixels;
        } else {
          this.backend.spansDrawn += t.spans;
          this.backend.pixelsDrawn += t.pixels;
        }
      }
      if (ph) { ph.draw += phaseNow() - pt; pt = phaseNow(); }
      this.spanList.count = 0;
      alphaSpans += endCount - start;
      if (d) {
        const batchSpans = endCount - start;
        if (batchSpans > d.maxBatchSpans) d.maxBatchSpans = batchSpans;
      }
    }
    return alphaSpans;
  }

  /**
   * Foreground segment 2: world-placed alias + world sprites (M3.4).
   * Identical body, split from drawForeground for async orchestration (see
   * drawForeground): ends immediately before the sprite flush point. Owns
   * its own phase-timing cursor; segment time stays in the alias bucket via
   * the end accumulation (diagnostic-only either way).
   */
  private drawForegroundPlacedPass(cam: Camera, worldData: MiniWorld, view: RefDef, dyn: DynamicLight[]): void {
    const ph = this.phaseArmed ? this.phaseAcc : null;
    let pt = ph ? phaseNow() : 0;
    const rgbActive = this.rgbOverlayActive();
    const fgSkip = this.fgSkipClassic && rgbActive;
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
      // Perf remediation item 1: frustum sphere cull — fully off-screen
      // critters skip setup, projection and fill entirely. Conservative:
      // intersecting spheres always draw; output unchanged (culled
      // instances rasterise zero pixels).
      const db = this.devBoundsFor(pa.meshId);
      if (db && this.sphereCulledAt(pa.origin[0]!, pa.origin[1]!, pa.origin[2]!, db, cam)) {
        this.fgCulled++;
        continue;
      }
      this.fgDrawn++;
      if (fgSkip) {
        this.classicFgSkipped++;
      } else {
        drawAliasInstance(this.idx, this.zb, this.fbW, this.fbH, {
          mesh, origin: pa.origin, angles: pa.angles,
          frameA: pa.frameA, frameB: pa.frameB, lerp: pa.lerp,
          lightAngle: ((pa.angles[1]! * 256) / 360) & 255,
        }, skin, cam, this.anorms, this.shadeDots, this.colormap);
      }
      if (rgbActive) {
        this.rgbBackend.pixelsDrawn += drawAliasInstanceRGB(
          this.rgb565, this.rgbCover, this.rgbDepth16, this.fbW, this.fbH, {
            mesh, origin: pa.origin, angles: pa.angles,
            frameA: pa.frameA, frameB: pa.frameB, lerp: pa.lerp,
            lightAngle: ((pa.angles[1]! * 256) / 360) & 255,
          }, this.rgbMaterialForAlias(skin), cam, this.anorms, this.shadeDots, dyn, this.rgbWin);
        this.rgbUsedThisFrame = true;
      }
    }
    for (const ps of worldData.sprites) {
      const tex = worldData.textures[ps.skinId % worldData.textures.length]!;
      // Item 1: billboard sphere cull (half-diagonal + margin: exact for a
      // screen-aligned quad under any orientation, so never over-culls).
      if (sphereCulledByFlatFrustum(this.frustumFlat,
        cam.origin[0]!, cam.origin[1]!, cam.origin[2]!,
        cam.forward[0]!, cam.forward[1]!, cam.forward[2]!, cam.near,
        ps.origin[0]!, ps.origin[1]!, ps.origin[2]!, ps.size * 0.72)) {
        this.fgCulled++;
        continue;
      }
      this.fgDrawn++;
      if (fgSkip) {
        this.classicFgSkipped++;
      } else {
        drawSprite(this.idx, this.zb, this.fbW, this.fbH,
          { origin: ps.origin, width: ps.size, height: ps.size, texId: 0, grade: 60 },
          [{ width: tex.width, height: tex.height, texels: tex.texels }],
          emptyLight, this.colormap, cam, this.spriteScratch, 1024);
      }
      if (rgbActive) {
        const pooledFg = this.backend === this.bandBackend
          ? this.bandBackend.dispatcher
          : null;
        if (pooledFg) {
          // Task 1: stage the emitted billboard spans into the foreground
          // RGB kick (ascending-y emission, ordered) instead of drawing
          // them inline — identical spans, material and order; the flush
          // after this loop lands them before the particle writes below.
          const n = emitSpriteSpans(
            { origin: ps.origin, width: ps.size, height: ps.size, texId: 0, grade: 60 },
            [tex], cam, this.fbW, this.fbH, this.spriteScratch, 1024);
          if (n > 0) {
            this.spriteScratch.count = n;
            const fgMat = this.rgbMaterialForSkin(tex);
            this.stageForegroundRGBSpans(this.spriteScratch, fgMat);
            this.spriteScratch.count = 0;
            this.rgbUsedThisFrame = true;
          }
        } else {
          this.fgInlineBatches++;
          this.rgbBackend.pixelsDrawn += drawSpriteRGB(
            this.rgb565, this.rgbCover, this.rgbDepth16, this.fbW, this.fbH,
            { origin: ps.origin, width: ps.size, height: ps.size, texId: 0, grade: 60 },
            [tex], this.rgbMaterialForSkin(tex), cam, this.spriteScratch, 1024, undefined, this.rgbWin);
          this.rgbUsedThisFrame = true;
        }
      }
    }
    if (ph) { ph.alias += phaseNow() - pt; pt = phaseNow(); }
  }

  /**
   * Foreground segment 3: particles, game entities (MD2 alias incl. the
   * depthHack viewmodel, sprites, tracer beams), renderer-owned tracer
   * beams and dlight aging. Identical body, split from drawForeground for
   * async orchestration (see drawForeground). Owns its own phase-timing
   * cursor; the alias bucket total is preserved together with segment 2's
   * end accumulation (diagnostic-only either way).
   */
  private drawForegroundEntityPass(cam: Camera, worldData: MiniWorld, view: RefDef, dyn: DynamicLight[], entities: Entity[]): void {
    const ph = this.phaseArmed ? this.phaseAcc : null;
    let pt = ph ? phaseNow() : 0;
    const rgbActive = this.rgbOverlayActive();
    const fgSkip = this.fgSkipClassic && rgbActive;
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
      if (fgSkip) {
        this.classicFgSkipped++;
      } else {
        drawParticles(this.idx, this.zb, this.fbW, this.fbH, this.partPool, 0, np);
      }
      if (rgbActive) {
        this.rgbBackend.pixelsDrawn += drawParticlesRGB(
          this.rgb565, this.rgbCover, this.rgbDepth16, this.fbW, this.fbH,
          this.partPool, 0, np, this.palette, this.rgbWin);
        this.rgbUsedThisFrame = true;
      }
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
        // Perf remediation item 1: model-bounds frustum cull. The sphere
        // unions all frames (RF_FRAMELERP-safe), is rotation-invariant, and
        // exempts the depth-hack viewmodel — so culled instances provably
        // rasterise zero pixels and output is unchanged. No origin-only
        // shortcut: large models with off-screen origins still draw.
        if (this.entityCulled(e, this.modelBounds[e.model] ?? null, cam)) {
          this.fgCulled++;
          continue;
        }
        this.fgDrawn++;
        if (fgSkip) {
          this.classicFgSkipped++;
        } else {
          drawAliasInstance(this.idx, this.zb, this.fbW, this.fbH, {
            mesh: m.data, origin: e.origin, angles: e.angles,
            frameA: frA, frameB: fr, lerp,
            lightAngle: ((e.angles[1]! * 256) / 360) & 255,
            // First-person viewmodel (Entity.depthHack = RF_DEPTHHACK):
            // bias stored 1/z so the eye-anchored gun wins vs nearby walls.
            depthScale: e.depthHack === true ? DEPTHHACK_SCALE : 1,
            alpha: alpha >= 1 ? undefined : alpha,
          }, skin, cam, this.anorms, this.shadeDots, this.colormap);
        }
        // RGB overlay (step 3): perspective-correct twin — same traversal,
        // frame lerp and depthHack scale, true alpha blend for fading
        // explosions (no screen-door stipple in the RGB path).
        if (rgbActive) {
          this.rgbBackend.pixelsDrawn += drawAliasInstanceRGB(
            this.rgb565, this.rgbCover, this.rgbDepth16, this.fbW, this.fbH, {
              mesh: m.data, origin: e.origin, angles: e.angles,
              frameA: frA, frameB: fr, lerp,
              lightAngle: ((e.angles[1]! * 256) / 360) & 255,
              depthScale: e.depthHack === true ? DEPTHHACK_SCALE : 1,
              alpha: alpha >= 1 ? undefined : alpha,
            }, this.rgbMaterialForAlias(skin), cam, this.anorms, this.shadeDots, dyn, this.rgbWin);
          this.rgbUsedThisFrame = true;
        }
      } else if (m.kind === 'sp2') {
        const skin = this.skins[e.skin] ?? devSkin0(worldData);
        // Item 1: sprite-entity billboard cull (48px quad, same rule as
        // world sprites above).
        if (sphereCulledByFlatFrustum(this.frustumFlat,
          cam.origin[0]!, cam.origin[1]!, cam.origin[2]!,
          cam.forward[0]!, cam.forward[1]!, cam.forward[2]!, cam.near,
          e.origin[0]!, e.origin[1]!, e.origin[2]!, 48 * 0.72)) {
          this.fgCulled++;
          continue;
        }
        this.fgDrawn++;
        if (fgSkip) {
          this.classicFgSkipped++;
        } else {
          drawSprite(this.idx, this.zb, this.fbW, this.fbH,
            { origin: e.origin, width: 48, height: 48, texId: 0, grade: 60 },
            [skin], emptyLight, this.colormap, cam, this.spriteScratch, 1024);
        }
        if (rgbActive) {
          this.rgbBackend.pixelsDrawn += drawSpriteRGB(
            this.rgb565, this.rgbCover, this.rgbDepth16, this.fbW, this.fbH,
            { origin: e.origin, width: 48, height: 48, texId: 0, grade: 60 },
            [skin], this.rgbMaterialForSkin(skin), cam, this.spriteScratch, 1024, undefined, this.rgbWin);
          this.rgbUsedThisFrame = true;
        }
      } else if (m.kind === 'tracer') {
        // Contract-free beam convention (renderer-internal): origin is the
        // beam start, angles its direction, frame the length in world units
        // (default 96), skin a raw palette index (NOT a skin handle).
        // Lets game code emit blaster/shotgun tracers through plain
        // entities; spawnTracer() is the pooled equivalent with ttl.
        AngleVectors(e.angles, this.tracerFwd, this.tracerRight, this.tracerUp);
        const len = e.frame > 0 ? Math.min(e.frame, 1024) : TRACER_DEFAULT_LENGTH;
        const col = e.skin >= 0 && e.skin <= 255 ? e.skin & 255 : TRACER_DEFAULT_COLOR;
        // Item 1: beam-segment sphere cull (midpoint + half-length + margin
        // covers the whole segment under any orientation).
        {
          const ex = e.origin[0]! + this.tracerFwd[0]! * len;
          const ey = e.origin[1]! + this.tracerFwd[1]! * len;
          const ez = e.origin[2]! + this.tracerFwd[2]! * len;
          if (sphereCulledByFlatFrustum(this.frustumFlat,
            cam.origin[0]!, cam.origin[1]!, cam.origin[2]!,
            cam.forward[0]!, cam.forward[1]!, cam.forward[2]!, cam.near,
            (e.origin[0]! + ex) / 2, (e.origin[1]! + ey) / 2, (e.origin[2]! + ez) / 2,
            len / 2 + 2)) {
            this.fgCulled++;
            continue;
          }
          this.fgDrawn++;
        }
        if (fgSkip) {
          this.classicFgSkipped++;
        } else {
          drawTracerBeam(this.idx, this.zb, this.fbW, this.fbH, cam,
            e.origin[0]!, e.origin[1]!, e.origin[2]!,
            e.origin[0]! + this.tracerFwd[0]! * len,
            e.origin[1]! + this.tracerFwd[1]! * len,
            e.origin[2]! + this.tracerFwd[2]! * len,
            col);
        }
        if (rgbActive) {
          this.rgbBackend.pixelsDrawn += drawTracerBeamRGB(
            this.rgb565, this.rgbCover, this.rgbDepth16, this.fbW, this.fbH, cam,
            e.origin[0]!, e.origin[1]!, e.origin[2]!,
            e.origin[0]! + this.tracerFwd[0]! * len,
            e.origin[1]! + this.tracerFwd[1]! * len,
            e.origin[2]! + this.tracerFwd[2]! * len,
            col, this.palette, TRACER_CORE_COLOR, this.rgbWin);
          this.rgbUsedThisFrame = true;
        }
      }
    }

    // Renderer-owned tracer beams (spawnTracer pool): drawn with the same
    // 1/z-tested line path, then aged one render. No allocation.
    for (let ti = 0; ti < TRACER_POOL_SIZE; ti++) {
      if (this.tracerTtl[ti] === 0) continue;
      const o = ti * 6;
      // Item 1: pooled-beam segment cull (same midpoint rule as entities).
      {
        const ax = this.tracerSegs[o]!, ay = this.tracerSegs[o + 1]!, az = this.tracerSegs[o + 2]!;
        const bx = this.tracerSegs[o + 3]!, by = this.tracerSegs[o + 4]!, bz = this.tracerSegs[o + 5]!;
        const dx = bx - ax, dy = by - ay, dz = bz - az;
        const hl = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2 + 2;
        if (sphereCulledByFlatFrustum(this.frustumFlat,
          cam.origin[0]!, cam.origin[1]!, cam.origin[2]!,
          cam.forward[0]!, cam.forward[1]!, cam.forward[2]!, cam.near,
          (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, hl)) {
          this.fgCulled++;
          this.tracerTtl[ti]--;
          continue;
        }
        this.fgDrawn++;
      }
      if (fgSkip) {
        this.classicFgSkipped++;
      } else {
        drawTracerBeam(this.idx, this.zb, this.fbW, this.fbH, cam,
          this.tracerSegs[o]!, this.tracerSegs[o + 1]!, this.tracerSegs[o + 2]!,
          this.tracerSegs[o + 3]!, this.tracerSegs[o + 4]!, this.tracerSegs[o + 5]!,
          this.tracerColors[ti]!, this.tracerCores[ti]!);
      }
      if (rgbActive) {
        this.rgbBackend.pixelsDrawn += drawTracerBeamRGB(
          this.rgb565, this.rgbCover, this.rgbDepth16, this.fbW, this.fbH, cam,
          this.tracerSegs[o]!, this.tracerSegs[o + 1]!, this.tracerSegs[o + 2]!,
          this.tracerSegs[o + 3]!, this.tracerSegs[o + 4]!, this.tracerSegs[o + 5]!,
          this.tracerColors[ti]!, this.palette, this.tracerCores[ti]!, this.rgbWin);
        this.rgbUsedThisFrame = true;
      }
      this.tracerTtl[ti]--;
    }
    if (ph) { ph.alias += phaseNow() - pt; pt = phaseNow(); }

    // Age renderer-owned lights once per rendered view: a flash that is not
    // re-added expires after DEFAULT_DLIGHT_TTL_FRAMES renders (swept at the
    // top of the next renderView, with one serial bump / one cache rebuild).
    this.dlights.ageFrame();
  }

  /**
   * Entity foreground orchestrator (sync path): deferred translucent alpha
   * (R_DrawAlphaSurfaces) first — it must land after the pool kick (the
   * kick would wipe these direct plane writes), then world-placed alias /
   * sprites / particles (M3.4), game entities (MD2 alias incl. the
   * depthHack viewmodel, sprites, tracer beams) and renderer-owned tracer
   * beams, then dlight aging. Alpha stays ahead of entities exactly like
   * the old pre-kick order (relative compositing unchanged); only its
   * position vs the kick moved. Bit-identical either way: world-first,
   * foreground-second, all writes depth-guarded. The two flush points
   * preserve the exact serial order: staged blends land before the next
   * inline direct RGB write. Zero allocation (phase timing uses the armed
   * scratch). Returns the alpha spans emitted (feeds the stats stash).
   */
  private drawForeground(cam: Camera, worldData: MiniWorld, view: RefDef, dyn: DynamicLight[], entities: Entity[]): number {
    const ph = this.phaseArmed ? this.phaseAcc : null;
    const alphaSpans = this.drawForegroundAlphaPass(cam, worldData, view, dyn);
    // Task 1: staged alpha blends must land before the next inline direct
    // RGB write (alias entities below) — flush the foreground kick here so
    // the serial world-alpha-foreground order holds exactly.
    let pt = ph ? phaseNow() : 0;
    this.flushForegroundRGB();
    if (ph) { ph.draw += phaseNow() - pt; pt = phaseNow(); }
    this.drawForegroundPlacedPass(cam, worldData, view, dyn);
    // Task 1: staged sprite blends must land before the next inline direct
    // RGB write (particles below) — flush the foreground kick here.
    this.flushForegroundRGB();
    this.drawForegroundEntityPass(cam, worldData, view, dyn, entities);
    return alphaSpans;
  }

  /**
   * Entity foreground orchestrator (async path): the same three segments
   * in the same order with the same two flush points, but the flushes are
   * message-driven (no Atomics.wait on the calling thread), so staged
   * foreground batches execute on workers in the browser instead of
   * replaying inline. Bit-identical to drawForeground: world-first,
   * foreground-second, all writes depth-guarded, serial + failure
   * fallbacks intact (see flushForegroundRGBAsync).
   */
  private async drawForegroundAsync(cam: Camera, worldData: MiniWorld, view: RefDef, dyn: DynamicLight[], entities: Entity[]): Promise<number> {
    const ph = this.phaseArmed ? this.phaseAcc : null;
    const alphaSpans = this.drawForegroundAlphaPass(cam, worldData, view, dyn);
    let pt = ph ? phaseNow() : 0;
    await this.flushForegroundRGBAsync();
    if (ph) { ph.draw += phaseNow() - pt; pt = phaseNow(); }
    this.drawForegroundPlacedPass(cam, worldData, view, dyn);
    await this.flushForegroundRGBAsync();
    this.drawForegroundEntityPass(cam, worldData, view, dyn, entities);
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
      this.rangeScanned += await banded.flushAccumAsync();
    }
    // RGB worker kick (message-driven): staged world RGB batches drain
    // before the foreground seed + inline foreground RGB draws below.
    // No zb backfill (item A): the foreground classic reads are skipped
    // with the writes, so nothing consumes the skipped planes.
    if (this.rgbUsedThisFrame) {
      await this.flushRGBAsync();
    }
    // World kick complete (planes valid) — now the direct plane writes.
    const fgCam = this.fgCam;
    const fgWorld = this.fgWorld;
    const fgDyn = this.fgDyn;
    if (fgCam && fgWorld && fgDyn) {
      this.stSpansEmitted += await this.drawForegroundAsync(fgCam, fgWorld, view, fgDyn, entities);
      // The foreground (alpha) tallies into the backend counters after the
      // phase-1 stash: refresh the diag candidate count to match finishStats.
      if (this.diagArmed) this.diagAcc.candidatePixels = this.backend.pixelsDrawn - this.stPixelsBase;
    }
    return this.finishStats();
  }

  endFrame(): void {
    if (this.backend === this.bandBackend && this.bandBackend.dispatcher) {
      // Pooled path: fused palette-expand + RGB composite via one resolve
      // kick (workers + the main band drain the color plane in parallel;
      // bit-identical to the serial fused loop below). Timeout/dead pool
      // falls back to the serial fused expand inside resolveAccum. The
      // zero-batch guard keeps the resolve input defined (mirrors the
      // pre-alias guard in renderView). No second compositeRGB pass: the
      // kick already composited (PERF-5 pooled end-frame fusion).
      if (this.bandBackend.batchesDrawn === 0) {
        this.idx.fill(0);
        this.zb.fill(0);
      }
      this.bandBackend.resolveAccum(this.palette, this.color);
    } else {
      // Palette expand to 0xAABBGGRR (classic / wasm / banded-inline paths).
      // PERF-2 C fused single pass: pixels the RGB overlay covered expand
      // from the packed RGB565 authority plane (top-bit replication into
      // the resolve scratch, exactly like compositeRGB below), everything
      // else from the indexed plane. Disjoint pixel sets, no cross-pixel
      // dependencies: bit-identical to expand-then-composite, minus one
      // full-frame idx+color read/write pass. Skipped cover branch while
      // disabled, so classic output is untouched.
      const pal = this.palette;
      const n = this.fbW * this.fbH;
      if (!this.rgbUsedThisFrame) {
        for (let i = 0; i < n; i++) {
          const c = this.idx[i]! * 3;
          const r = pal[c]!, g = pal[c + 1]!, b = pal[c + 2]!;
          this.color[i] = (0xff << 24) | (b << 16) | (g << 8) | r;
        }
      } else {
        const q = this.rgb565, cover = this.rgbCover, rgb = this.rgbColor;
        for (let i = 0; i < n; i++) {
          if (cover[i]) {
            const v = q[i]!;
            const r5 = (v >> 11) & 31, g6 = (v >> 5) & 63, b5 = v & 31;
            rgb[i] = (0xff000000 |
              ((((b5 << 3) | (b5 >> 2)) << 16) |
                (((g6 << 2) | (g6 >> 4)) << 8) |
                ((r5 << 3) | (r5 >> 2)))) >>> 0;
            this.color[i] = rgb[i]!;
          } else {
            const c = this.idx[i]! * 3;
            const r = pal[c]!, g = pal[c + 1]!, b = pal[c + 2]!;
            this.color[i] = (0xff << 24) | (b << 16) | (g << 8) | r;
          }
        }
      }
    }
    this.mirrorIndexPlane();
  }

  /**
   * Merge the RGB overlay over the resolved color plane wherever the
   * coverage mask is set (the single global reconstruct for the pooled
   * backend; the serial/banded-inline paths fuse the identical math into
   * the endFrame expand pass in one scan — see there). The source is the
   * packed RGB565 authority plane, expanded to 8:8:8 into the resolve
   * scratch (5/6-bit upscale replicates the top bits into the low bits).
   */
  private compositeRGB(): void {
    const q = this.rgb565, cover = this.rgbCover, rgb = this.rgbColor;
    const n = this.fbW * this.fbH;
    for (let i = 0; i < n; i++) {
      if (cover[i]) {
        const v = q[i]!;
        const r5 = (v >> 11) & 31, g6 = (v >> 5) & 63, b5 = v & 31;
        rgb[i] = (0xff000000 |
          ((((b5 << 3) | (b5 >> 2)) << 16) |
            (((g6 << 2) | (g6 >> 4)) << 8) |
            ((r5 << 3) | (r5 >> 2)))) >>> 0;
        this.color[i] = rgb[i]!;
      }
    }
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

  /**
   * PERF-FINISH-A item A observability: classic work eliminated by the
   * authoritative skip in the last renderView. `classicSpansSkipped`
   * counts world / sky / skybox / deferred-alpha spans whose classic draw
   * was elided where the RGB overlay drew; `classicFgSkipped` counts
   * elided entity-foreground classic draws (alias / sprite / particle /
   * tracer calls). Both are zero with the cvar-0 oracle or in software
   * mode (RGB off) — the skip never arms there. `skipArmed` reports the
   * phase-1 decision for the last frame.
   */
  testClassicSkipStats(): {
    classicSpansSkipped: number; classicFgSkipped: number; skipArmed: boolean;
  } {
    return {
      classicSpansSkipped: this.classicSpansSkipped,
      classicFgSkipped: this.classicFgSkipped,
      skipArmed: this.fgSkipClassic,
    };
  }

  /**
   * Observability for the RGB pass (astra V2a/V2c + step-3 test hook):
   * whether the module flag is on, whether any draw took the RGB backend
   * this frame, RGB cache hit/miss/size, and how many framebuffer pixels
   * the coverage mask marks for the RGB888 composite. Zero unless the
   * flag was enabled for the last renderView.
   */
  testRGBStats(): {
    enabled: boolean; used: boolean;
    hits: number; misses: number; size: number; coverPixels: number;
  } {
    let coverPixels = 0;
    if (this.rgbUsedThisFrame) {
      const c = this.rgbCover;
      for (let i = 0; i < c.length; i++) coverPixels += c[i]!;
    }
    const cc = this.rgbCache;
    return {
      enabled: rgbWorldEnabled,
      used: this.rgbUsedThisFrame,
      hits: cc.hits,
      misses: cc.misses,
      size: cc.size,
      coverPixels,
    };
  }

  /** Live RGB cache hit rate (bench/ledger observability). */
  testRGBCacheStats(): {
    hits: number; misses: number; size: number; hitRate: number;
    evictions: number;
    chainHits: number; chainMisses: number; chainSize: number;
    chainUsed: number; chainEvictions: number;
  } {
    const c = this.rgbCache;
    return {
      hits: c.hits, misses: c.misses, size: c.size, hitRate: c.hitRate(),
      evictions: c.evictions,
      chainHits: this.rgbTexHits, chainMisses: this.rgbTexMisses,
      chainSize: this.rgbTexChains.size, chainUsed: this.rgbTexUsed,
      chainEvictions: this.rgbTexEvictions,
    };
  }

  /**
   * Eviction-accounting probe (P2 pin): real chain retention vs the
   * budgeted `chainUsed`. `retainedChainBytes` walks the chain map plus
   * every DISTINCT chain still referenced by RGBLightCache materials;
   * `orphanChainBytes` is the unbudgeted part (chains evicted from the map
   * but pinned alive by surviving materials). Coordinated eviction keeps
   * orphans at zero, so `retainedChainBytes === chainUsed <= BUDGET`.
   * Byte formula matches rgbChainFor (64 + data + mask per level).
   */
  testRGBChainAccounting(): {
    chainUsed: number; chainMapBytes: number; orphanChainBytes: number;
    retainedChainBytes: number; rgbEntries: number; budget: number;
  } {
    let mapBytes = 0;
    const live = new Set<RGBMipLevel[]>();
    for (const e of this.rgbTexChains.values()) {
      mapBytes += e.bytes;
      live.add(e.chain);
    }
    let orphan = 0;
    for (const ch of this.rgbCache.referencedChains()) {
      if (live.has(ch)) continue;
      let b = 64;
      for (const lvl of ch) b += lvl.data.length + lvl.mask.length;
      orphan += b;
    }
    return {
      chainUsed: this.rgbTexUsed,
      chainMapBytes: mapBytes,
      orphanChainBytes: orphan,
      retainedChainBytes: mapBytes + orphan,
      rgbEntries: this.rgbCache.size,
      budget: RGB_TEXCHAIN_BUDGET,
    };
  }

  /**
   * RGB cover count inside a screen rect (step-3 test hook: dense-cover
   * asserts for filtered explosions — stipple would leave holes). Clamped
   * to the framebuffer. Zero unless the flag was enabled for the last
   * renderView.
   */
  testRGBBoxCover(x0: number, y0: number, x1: number, y1: number): number {
    let n = 0;
    const xa = Math.max(0, Math.floor(x0)), xb = Math.min(this.fbW - 1, Math.ceil(x1));
    const ya = Math.max(0, Math.floor(y0)), yb = Math.min(this.fbH - 1, Math.ceil(y1));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        if (this.rgbCover[y * this.fbW + x] !== 0) n++;
      }
    }
    return n;
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
    // Authoritative skip (item A): same unified gate as the world pass
    // (fgSkipClassic is set by renderView before any skybox emission; the
    // world tMode gate is gone, so sky and world share one policy).
    const skipClassicSky = this.fgSkipClassic;
    texView.width = sky.width;
    texView.height = sky.height;
    texView.texels = sky.texels;
    // Task 3: resolve once per frame (not per face) and skip the unused
    // classic flat-span packing when the classic face fill is elided.
    const skyMatAll = this.rgbOverlayActive() ? this.rgbMaterialForSky() : null;
    const skipSkyFlat = skipClassicSky && skyMatAll !== null;
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
      const flat = skipSkyFlat ? undefined : this.flatForEmit(SPAN_OPAQUE, order, 63, 0, -1);
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
      // PERF-FINISH-A item D (zero-scan): each skybox face is one
      // emitSpansForPoly batch (one span per row, ascending) — no scan,
      // no sort (see the sky-fill site in renderView).
      this.spanList.count = endCount;
      // Authoritative skip (item A): elide the classic face fill where the
      // RGB sky material drew; count the eliminated spans.
      if (skipClassicSky && skyMatAll) {
        this.classicSpansSkipped += endCount - start;
      } else {
        this.backend.drawSpans(this.spanList, texView, lightView);
      }
      if (skyMatAll) {
        this.drawWorldRGBSpans(this.spanList, skyMatAll);
      }
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

  /**
   * Drop the shared per-texture RGB chains (palette/world change).
   * Coordinated ownership (P2): chains are shared by reference with
   * RGBLightCache materials, so the drop also invalidates the light
   * cache — otherwise evicted/cleared chains stay alive through
   * `material.levels` with no accounting trace. All callers already
   * invalidate the light cache too; the second clear is a harmless no-op
   * that keeps the pairing enforceable in one place. Also drops the pool's
   * persistent SAB upload cache (PERF-5), so stale chain bytes can never
   * serve after a palette/world change.
   */
  private clearRGBTextureChains(): void {
    this.rgbCache.invalidateAll();
    this.rgbTexChains.clear();
    this.rgbTexUsed = 0;
    try {
      this.bandBackend.dispatcher?.clearRGBChains();
    } catch {
      /* pool gone: next attach re-uploads */
    }
  }

  /**
   * Get-or-build the shared expanded mip chain for one world texture
   * (upload-time cost, amortised across every surface using it). Frame-stamp
   * LRU inside RGB_TEXCHAIN_BUDGET; a world-identity change drops chains
   * AND the surface caches (surface ids are world-relative). Returns null
   * only for unusable texture data (caller falls back to the scalar block).
   */
  private rgbChainFor(texId: number, src: Texture, worldData: MiniWorld): RGBMipLevel[] | null {
    if (this.rgbTexWorld !== worldData) {
      this.clearRGBTextureChains();
      this.rgbTexWorld = worldData;
      this.lastTouched.length = 0;
      this.rgbCache.invalidateAll();
    }
    const hit = this.rgbTexChains.get(texId);
    if (hit) {
      hit.used = this.frame;
      this.rgbTexHits++;
      return hit.chain;
    }
    this.rgbTexMisses++;
    if (!(src.width >= 1 && src.height >= 1) || src.texels.length < src.width * src.height) return null;
    const chain = buildRGBChain(src.texels, src.width, src.height, this.palette, false);
    let bytes = 64;
    for (const lvl of chain) bytes += lvl.data.length + lvl.mask.length;
    while (this.rgbTexUsed + bytes > RGB_TEXCHAIN_BUDGET && this.rgbTexChains.size > 0) {
      let victim: number | undefined;
      let victimAge = -1;
      for (const [k, e] of this.rgbTexChains) {
        const age = (this.frame - e.used) >>> 0;
        if (age > victimAge) {
          victimAge = age;
          victim = k;
          if (age > 0) break;
        }
      }
      if (victim === undefined) break;
      const e = this.rgbTexChains.get(victim)!;
      this.rgbTexChains.delete(victim);
      this.rgbTexUsed -= e.bytes;
      this.rgbTexEvictions++;
      // Coordinated ownership (P2): entries whose material shares this
      // chain would otherwise pin the evicted bytes alive (retention above
      // budget, plus a duplicate chain on the next miss for the texture).
      // Drop only that texture's dependents; the next access rebuilds both
      // the chain and the small luxel blocks.
      this.rgbCache.invalidateChain(e.chain);
    }
    this.rgbTexChains.set(texId, { chain, bytes, used: this.frame });
    this.rgbTexUsed += bytes;
    return chain;
  }

  /**
   * RGB miss path: build the cached binding for one surface from the
   * SHARED per-texture mip chain (see rgbChainFor: expanded once per
   * texture, reused by every surface) plus a fresh per-channel luxel block
   * (buildRGBLightMap). Returns null when the lightmap or texture is
   * unusable; the caller then draws the scalar block/backend alone, so
   * output shape never changes. The entry shares the chain with every
   * other surface on the same texture and owns only the RGB luxels, so the
   * RGBLightCache budget covers thousands of surfaces (scalar-style
   * discipline); only lighting/serial changes rebuild luxels. Turbulent
   * surfaces get a warp material; `extra` lets the deferred alpha loop
   * request the blended, non-depth-writing variant for TRANS33/66 (the main
   * loop always draws opaque). Sampling policy comes from the per-frame
   * fidelity snapshot; a cvar change invalidates the per-surface luxels in
   * syncRGBFidelity but keeps the shared chains (fidelity-independent), so
   * the next frame re-links without re-expanding textures.
   *
   * `block` may be null (task 3): while the authoritative skip is armed
   * the scalar block has no consumer (classic is elided, and the cached
   * entry's scalar copy is never rasterised — it only feeds budget
   * accounting, which the luxels below already cover), so the miss path
   * validates against the source dims and stores a shared empty scalar
   * sentinel. A null RGB result (unusable lightmap/texture) still falls
   * back to the scalar path, which builds the block on demand.
   */
  private buildRGBEntry(
    world: MiniWorld, surf: MiniSurf, block: SurfaceBlock | null,
    stylesHash: number, mip: number,
    lightStyles: Float32Array, dyn: DynamicLight[], dlightBits: number,
    extra?: { blend?: 'opaque' | 'alpha' | 'additive'; depthWrite?: boolean; variant?: number },
  ): RGBMaterial | null {
    const lm = world.lightmaps[surf.lightId % world.lightmaps.length]!;
    if (!lm || lm.luxW < 1 || lm.luxH < 1) return null;
    if (lm.samples.length < lm.luxW * lm.luxH * 3) return null;
    if (block) {
      if (block.texels.length < block.bw * block.bh || block.bw < 1 || block.bh < 1) return null;
    }
    // Full-res mip source (see doc above): the cache key keeps `mip`, so
    // entries filed under different scalar mips share the identical chain.
    const src = world.textures[surf.texId % world.textures.length]!;
    if (!src || src.width < 1 || src.height < 1) return null;
    if (src.texels.length < src.width * src.height) return null;
    const n = lm.luxW * lm.luxH;
    const need = n * 3;
    if (this.rgbLightScratch.length < need) this.rgbLightScratch = new Uint8Array(need);
    // Per-luxel dlight falloff (same grid fit as the scalar miss path).
    let luxelPos: Float32Array | null = null;
    if (dyn.length > 0 && dlightBits !== 0) {
      const need3 = n * 3;
      if (this.dluxScratch.length < need3) this.dluxScratch = new Float32Array(need3);
      luxelWorldPositions(surf.verts, surf.lux, surf.n, lm.luxW, lm.luxH, surf.center, this.dluxScratch);
      luxelPos = this.dluxScratch;
    }
    const nValid = countValidStyles(lm, lightStyles, this.styleScratch);
    // Shared scratch (task 6): buildRGBLightMap consumes the scales
    // synchronously and never retains them (the entry owns the luxels).
    const scales = this.scalesScratch;
    scales.length = 0;
    for (let k = 0; k < nValid; k++) scales.push(this.styleScratch[k]!);
    if (scales.length === 0) scales.push(1);
    buildRGBLightMap(
      this.rgbLightScratch, lm.samples, lm.luxW, lm.luxH,
      scales, dyn, surf.center, dlightBits, LIGHT_OVERBRIGHT, luxelPos,
    );
    const rgb = this.rgbLightScratch.slice(0, need);
    // Shared chain (one expansion per texture, reused by every surface on
    // it) + per-surface luxels. The material shell is small and cached with
    // the luxels; the chain lives in the texture cache (own budget).
    const texId = surf.texId % world.textures.length;
    const chain = this.rgbChainFor(texId, src, world);
    if (!chain) return null;
    const fid = this.rgbFidelity;
    const material: RGBMaterial = {
      levels: chain,
      addressS: 'repeat', addressT: 'repeat',
      light: { samples: rgb, luxW: lm.luxW, luxH: lm.luxH },
      overbright: fid.overbright, lodBias: fid.lodBias, mipDither: fid.mipDither,
      bilinear: fid.bilinear, zbits: fid.zbits,
      blend: extra?.blend ?? 'opaque',
      alphaTest: null,
      depthWrite: extra?.depthWrite ?? true,
      alpha: 1,
      // World chains are NOT opacity-proven (WAL texels may carry index
      // 255 in test palettes), so the mask tap stays — alias/sky materials
      // set this via buildRGBMaterial's opaqueMask option instead.
      opaqueMask: false,
      warp: surf.turbulent,
      turbPhase: surf.turbulent ? (((this.backend.time * 64) | 0) & 1023) : 0,
      flatColor: null,
    };
    const entry: RGBCachedBlock = {
      block: block
        ? {
          texels: block.texels, bw: block.bw, bh: block.bh,
          light: block.light, luxW: block.luxW, luxH: block.luxH, rgb,
        }
        : {
          // Task 3 scalar-free entry: no consumer reads the scalar copy
          // (classic is elided while the skip is armed), so store the
          // shared empty sentinel. Budget accounting is unchanged: it
          // counts the owned luxels (`rgb`) plus the entry overhead, like
          // the scalar-carrying entry above.
          texels: RGB_EMPTY_BLOCK.texels, bw: 0, bh: 0,
          light: RGB_EMPTY_BLOCK.light, luxW: lm.luxW, luxH: lm.luxH, rgb,
        },
      material,
    };
    this.rgbCache.put(surf.id, stylesHash, mip, entry, extra?.variant ?? 0);
    return material;
  }
}

/** Shared empty scalar copy for scalar-free RGB entries (task 3). */
const RGB_EMPTY_BLOCK: { texels: Uint8Array; light: Uint8Array } = {
  texels: new Uint8Array(0), light: new Uint8Array(0),
};

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
