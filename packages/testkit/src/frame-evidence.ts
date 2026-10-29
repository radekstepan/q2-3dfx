// @q2/testkit — whole-production-frame measurement + full-channel evidence (PERF-NEXT-1).
//
// Whole-frame semantics (never sum independent medians): every rep measures
// renderView + endFrame + the fused resolve together on ONE caller clock
// (process.hrtime, same helpers as critpath), with same-rep segment splits
// whose gap reconciles per rep (GC/allocator/fence slack). Full-channel
// output hashes per rep: index-plane FNV + full-RGBA color FNV +
// full-RGBA display FNV. Fallback/quarantine/counter capture rides along via
// the public renderer hooks (renderer-hooks.ts + critpath stage counters) —
// reported, never summed into frame totals.
//
// Worker sweep: the pool is structural (EvidenceScanoutPool), so serial,
// 1/3/7-worker and disposed-pool configs all flow through one helper with
// no hard-coded worker counts. The display resolve is injected
// (resolveSerialInto) because @q2/voodoo is not a testkit dependency — the
// bench passes its production resolveFrame; tests pass a probe.
//
// Hash note: fnvIndex/fnvColorFull duplicate index.ts hashFrame/hashColorFull
// by value (same FNV-1a, byte-wise so endianness can never hide a channel)
// to avoid an index.ts ↔ frame-evidence.ts import cycle. bench-evidence.test.ts
// pins equality between the duplicates and the canonical exports.

import type { Entity, Framebuffer, FrameStats, RefDef, WorldModel } from '@q2/renderer-api';
import {
  collectStageCounters,
  frameSplit,
  nsToMs,
  nowNs,
  summarizeLatencies,
  type FrameSplit,
  type StageCounts,
} from './critpath.js';
import {
  readForegroundStats,
  readLastRGBFailure,
  readRgbFlushed,
  type ForegroundStats,
} from './renderer-hooks.js';

/** FNV-1a over raw bytes (index plane). Same algorithm as index.ts hashFrame. */
export function fnvIndex(idx: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < idx.length; i++) {
    h ^= idx[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Full-RGBA FNV-1a (all 4 bytes per pixel, R+G+B+A order). Same algorithm as
 * index.ts hashColorFull — the parity authority for raster AND display.
 */
export function fnvColorFull(color: Uint32Array): string {
  let h = 2166136261;
  for (let i = 0; i < color.length; i++) {
    const px = color[i]!;
    h ^= px & 0xff;
    h = Math.imul(h, 16777619);
    h ^= (px >>> 8) & 0xff;
    h = Math.imul(h, 16777619);
    h ^= (px >>> 16) & 0xff;
    h = Math.imul(h, 16777619);
    h ^= (px >>> 24) & 0xff;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Structural production renderer (SoftwareRenderer satisfies this). Test
 * hooks are read structurally — never required — so serial-only builds and
 * NullRefresh-style heads measure fine with counters reported as null.
 */
export interface EvidenceRenderer {
  beginFrame(): void;
  renderView(view: RefDef, world: WorldModel, entities: Entity[]): FrameStats;
  endFrame(): void;
  getFramebuffer(): Framebuffer;
}

/** Structural pooled scanout (BandWorkerPool satisfies this). */
export interface EvidenceScanoutPool {
  flushScanout(opts: unknown): boolean;
  scanoutPlanes: { scanDisplay: Uint32Array };
}

/**
 * Display-resolve leg. `resolveSerialInto` runs the production fused
 * serial resolve (bench: voodoo resolveFrame) from the live color plane
 * into scratch; `scanoutOpts` is passed untouched to pool.flushScanout.
 */
export interface EvidenceScanout {
  pool?: EvidenceScanoutPool | null;
  scanoutOpts?: unknown;
  resolveSerialInto: (color: Uint32Array, display: Uint32Array) => void;
}

/** Which display leg produced this rep's presented plane. */
export type ScanoutKind = 'none' | 'serial' | 'pooled' | 'serial-fallback';

/** One measured production frame: walls, splits and full-channel hashes. */
export interface ProductionRep {
  rep: number;
  frameMs: number;
  split: FrameSplit;
  indexHash: string | null;
  colorFull: string;
  displayFull: string | null;
  /** Pooled-leg display hash when both legs ran (parity input). */
  pooledFull: string | null;
  /** Serial-control display hash when both legs ran (parity input). */
  serialFull: string | null;
  scanoutKind: ScanoutKind;
  scanoutOk: boolean;
}

export interface MeasureProductionFramesOptions {
  renderer: EvidenceRenderer;
  world: WorldModel;
  width: number;
  height: number;
  /** RefDef per rep (moving: pure function of rep — comparable hashes). */
  viewFor: (rep: number) => RefDef;
  /** Entities per rep (close over a prebuilt array for fixed workloads). */
  entitiesFor: (rep: number) => Entity[];
  /** Per-frame light pump (combat dlights); skipped when absent. */
  pump?: (rep: number) => void;
  warmup?: number;
  reps?: number;
  /** Null = raster-only leg (software path has no scanout stage). */
  scanout?: EvidenceScanout | null;
}

/** Whole-config evidence: per-rep records + medians + fallback/counter capture. */
export interface ProductionEvidence {
  width: number;
  height: number;
  warmup: number;
  reps: number;
  frames: ProductionRep[];
  frameMed: number;
  frameP95: number;
  frameMax: number;
  /** Pooled-vs-serial display parity across reps (null when no pooled leg ran). */
  displayParitySerialVsPooled: boolean | null;
  scanoutFallbacks: number;
  scanoutKinds: ScanoutKind[];
  foreground: ForegroundStats | null;
  stage: StageCounts | null;
  lastRGBFailure: 'clean' | 'partial' | null;
  rgbFlushed: number | null;
  /**
   * Execution proof: pooled configs must show staged > 0 + kicks > 0 with
   * zero fallbacks; serial configs are proven by construction. False means
   * the number is a serial number in disguise — never gate on it as a pass.
   */
  execProven: boolean;
}

/**
 * Measure whole production frames for one config, SEQUENTIALLY in this
 * process (never concurrent — benchmarks run on a quiet machine). Warmup
 * reps run untimed; timed reps record walls + splits + full-channel hashes.
 * Stage/foreground counters are captured after the last rep through public
 * hooks only (null when the build publishes nothing).
 */
export function measureProductionFrames(opts: MeasureProductionFramesOptions): ProductionEvidence {
  const { renderer, world, width, height, viewFor, entitiesFor, pump } = opts;
  const warmup = opts.warmup ?? 3;
  const reps = opts.reps ?? 5;
  const scanout = opts.scanout ?? null;

  const serialDisplay = scanout ? new Uint32Array(width * height) : null;

  for (let i = 0; i < warmup; i++) {
    pump?.(i);
    renderer.beginFrame();
    renderer.renderView(viewFor(i), world, entitiesFor(i));
    renderer.endFrame();
    if (scanout) {
      if (scanout.pool) {
        if (!scanout.pool.flushScanout(scanout.scanoutOpts)) {
          scanout.resolveSerialInto(renderer.getFramebuffer().color, serialDisplay!);
        }
      } else {
        scanout.resolveSerialInto(renderer.getFramebuffer().color, serialDisplay!);
      }
    }
  }

  const frames: ProductionRep[] = [];
  let scanoutFallbacks = 0;
  let parity: boolean | null = null;
  for (let i = 0; i < reps; i++) {
    pump?.(i);
    const tF = nowNs();
    let t = nowNs();
    renderer.beginFrame();
    const bM = nsToMs(nowNs() - t);
    t = nowNs();
    renderer.renderView(viewFor(i), world, entitiesFor(i));
    const rM = nsToMs(nowNs() - t);
    t = nowNs();
    renderer.endFrame();
    const eM = nsToMs(nowNs() - t);
    t = nowNs();
    let sM = 0;
    let disp: Uint32Array | null = null;
    let pooledFull: string | null = null;
    let serialFull: string | null = null;
    let kind: ScanoutKind = 'none';
    let ok = true;
    if (scanout) {
      if (scanout.pool) {
        ok = scanout.pool.flushScanout(scanout.scanoutOpts);
        sM = nsToMs(nowNs() - t);
        if (ok) {
          kind = 'pooled';
          disp = scanout.pool.scanoutPlanes.scanDisplay.slice(0, width * height);
          pooledFull = fnvColorFull(disp);
          // Serial control on the same live frame (shared thermal state).
          scanout.resolveSerialInto(renderer.getFramebuffer().color, serialDisplay!);
          serialFull = fnvColorFull(serialDisplay!);
          const same = pooledFull === serialFull;
          parity = parity === null ? same : parity && same;
        } else {
          kind = 'serial-fallback';
          scanoutFallbacks++;
          const tS = nowNs();
          scanout.resolveSerialInto(renderer.getFramebuffer().color, serialDisplay!);
          sM += nsToMs(nowNs() - tS);
          disp = serialDisplay;
          serialFull = fnvColorFull(serialDisplay!);
        }
      } else {
        scanout.resolveSerialInto(renderer.getFramebuffer().color, serialDisplay!);
        sM = nsToMs(nowNs() - t);
        kind = 'serial';
        disp = serialDisplay;
        serialFull = fnvColorFull(serialDisplay!);
      }
    }
    const fM = nsToMs(nowNs() - tF);
    const fb = renderer.getFramebuffer();
    frames.push({
      rep: i,
      frameMs: fM,
      split: frameSplit(bM, rM, eM, sM, fM),
      indexHash: fb.index ? fnvIndex(fb.index) : null,
      colorFull: fnvColorFull(fb.color),
      displayFull: disp ? fnvColorFull(disp) : null,
      pooledFull,
      serialFull,
      scanoutKind: kind,
      scanoutOk: ok,
    });
  }

  const lat = summarizeLatencies(frames.map((f) => f.frameMs));
  const scanoutKinds = frames.map((f) => f.scanoutKind);
  const last = frames[frames.length - 1];
  if (!last) throw new Error('testkit: measureProductionFrames needs reps >= 1');

  // Counter capture after the last rep (public hooks only; null when absent).
  let stage: StageCounts | null = null;
  try {
    stage = collectStageCounters(renderer as unknown as Parameters<typeof collectStageCounters>[0]);
  } catch {
    stage = null;
  }
  const foreground = readForegroundStats(renderer);
  const lastRGBFailure = scanout?.pool ? readLastRGBFailure(scanout.pool) : null;
  const rgbFlushed = scanout?.pool ? readRgbFlushed(scanout.pool) : null;

  const pooledRan = scanoutKinds.includes('pooled');
  const poolPresent = scanout !== null && !!scanout.pool;
  // A pool-present config is proven ONLY when pooled legs actually ran with
  // staged work and zero fallbacks — an all-fallback config is a serial
  // config in disguise and must report UNPROVEN. Serial/raster-only configs
  // are proven by construction.
  const execProven = !poolPresent
    ? true
    : pooledRan && stage !== null && stage.rgbUsed && stage.coverPixels > 0 &&
      stage.stagedBatches > 0 && stage.kicks > 0 && scanoutFallbacks === 0;

  return {
    width, height, warmup, reps, frames,
    frameMed: lat.med, frameP95: lat.p95, frameMax: lat.max,
    displayParitySerialVsPooled: pooledRan ? (parity ?? false) : null,
    scanoutFallbacks, scanoutKinds,
    foreground, stage,
    lastRGBFailure: lastRGBFailure === 'absent' ? null : lastRGBFailure,
    rgbFlushed,
    execProven,
  };
}

/** One-line human rendering of config evidence (for logs, not the ledger). */
export function formatProductionEvidence(label: string, e: ProductionEvidence): string {
  const last = e.frames[e.frames.length - 1]!;
  const kinds = [...new Set(e.scanoutKinds)].join('|');
  const st = e.stage
    ? ` staged=${e.stage.stagedBatches} inline=${e.stage.inlineBatches} kicks=${e.stage.kicks} cover=${e.stage.coverPixels}`
    : ' counters=n/a';
  const parity = e.displayParitySerialVsPooled === null
    ? 'parity=n/a'
    : `parity=${e.displayParitySerialVsPooled ? 'SAME' : 'CHANGED'}`;
  return (
    `${label} ${e.width}x${e.height} frame=${e.frameMed.toFixed(2)}` +
    `(p95 ${e.frameP95.toFixed(2)} max ${e.frameMax.toFixed(2)}) ` +
    `scanout[${kinds}] fb=${e.scanoutFallbacks} exec=${e.execProven ? 'proven' : 'UNPROVEN'} ` +
    `color=${last.colorFull} disp=${last.displayFull ?? '—'} ${parity}${st}`
  );
}
