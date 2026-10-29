// @q2/testkit — typed structural readers for landing renderer hooks.
//
// The renderer lane is implementing TASK items 1–3 (retained-frame recovery,
// per-class foreground counters) in `packages/sw-renderer` right now. Those
// hooks exist in the runtime dist but their `.d.ts` may lag (or predate)
// this lane's build. Every reader below is therefore STRUCTURAL: it probes
// the live object through `unknown` casts (no `any` anywhere), validates
// the full shape, and returns null when the hook is absent or malformed.
// Tests assert strictly when a hook is present and skip clearly when it is
// not — never silently passing on a missing producer.
import type { WorkerExecSample } from './worker-timing.js';
import { collectWorkerExec } from './worker-timing.js';

export interface ForegroundStats {
  stagedBatches: number;
  inlineBatches: number;
  kicks: number;
  alphaSpansStaged: number;
  alphaSpansInline: number;
  spriteSpansStaged: number;
  spriteDrawsInline: number;
  aliasDrawsInline: number;
  aliasTrisInline: number;
  particleDrawsInline: number;
  particlesInline: number;
  beamDrawsInline: number;
  workerSpansCompleted: number;
  workerPixelsCompleted: number;
  mainSpansCompleted: number;
  mainPixelsCompleted: number;
  replayedSpans: number;
  replayedPixels: number;
  recoveryCount: number;
  entityMs: number;
  /** Optional newer producer fields (PERF-NEXT-4/5 taxonomy): present only
   *  when the renderer publishes them — never required, never defaulted to
   *  a fake zero by the reader (undefined = unpublished). PERF-NEXT-5 adds
   *  the kick-level worker/main tri split plus per-class worker/main
   *  completion splits; while a split is unpublished the attribution reader
   *  reports it as unknown (null), never inferred from staged batches. */
  trisStaged?: number;
  trisCompleted?: number;
  trisMainCompleted?: number;
  trisReplayed?: number;
  particleSpansStaged?: number;
  beamSpansStaged?: number;
  /** Kick-level worker/main tri split (PERF-NEXT-5 corrected taxonomy). */
  workerTrisCompleted?: number;
  mainTrisCompleted?: number;
  /**
   * PERF-NEXT-5 per-class staged/inline pairs (renderer lane publishes
   * these; absent on older builds = unknown, never zeroed by the reader):
   * - `aliasDrawsStaged`: alias instances (incl. the depthHack viewmodel
   *   gun) successfully staged for the kick. Unit: draws/instances.
   * - `spriteSpansInline` / `particleSpansInline` / `beamSpansInline`:
   *   spans drawn inline for the class on the pooled staging-refusal path.
   *   Unit: spans (matches the staged spans, never mixed with draws).
   * Per-class worker/main completion splits are NOT published by
   * construction (one kick mixes alpha + sprite + particle + beam spans
   * and alias tris; the pool reports only the global split) — per-class
   * attribution stops at staged/inline, and completion reads unknown.
   */
  spriteSpansInline?: number;
  aliasDrawsStaged?: number;
  particleSpansInline?: number;
  beamSpansInline?: number;
  /** Per-class worker/main completion splits (accepted when published;
   * the current producer publishes none — see above). */
  alphaSpansWorkerCompleted?: number;
  alphaSpansMainCompleted?: number;
  spriteSpansWorkerCompleted?: number;
  spriteSpansMainCompleted?: number;
  aliasTrisWorkerCompleted?: number;
  aliasTrisMainCompleted?: number;
  particleSpansWorkerCompleted?: number;
  particleSpansMainCompleted?: number;
  beamSpansWorkerCompleted?: number;
  beamSpansMainCompleted?: number;
  directInlineWrites?: boolean;
}

const FG_KEYS: Array<keyof ForegroundStats> = [
  'stagedBatches', 'inlineBatches', 'kicks',
  'alphaSpansStaged', 'alphaSpansInline',
  'spriteSpansStaged', 'spriteDrawsInline',
  'aliasDrawsInline', 'aliasTrisInline',
  'particleDrawsInline', 'particlesInline',
  'beamDrawsInline',
  'workerSpansCompleted', 'workerPixelsCompleted',
  'mainSpansCompleted', 'mainPixelsCompleted',
  'replayedSpans', 'replayedPixels', 'recoveryCount',
  'entityMs',
];

/**
 * Read the per-class foreground breakdown (TASK item 3 taxonomy) when the
 * renderer publishes it. Null when absent — the caller skips clearly.
 */
export function readForegroundStats(r: object): ForegroundStats | null {
  const rec = r as unknown as Record<string, unknown>;
  if (typeof rec['testForegroundStats'] !== 'function') return null;
  let raw: unknown;
  try {
    raw = (rec['testForegroundStats'] as () => unknown).call(r);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const src = raw as Record<string, unknown>;
  const out = {} as Record<string, number>;
  for (const k of FG_KEYS) {
    const v = src[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    out[k] = v;
  }
  // Optional newer producer fields: accept when valid, leave undefined
  // when unpublished. A present-but-malformed optional rejects (never
  // laundered into a zero that would read as "no work").
  const FG_OPT_NUM: Array<'trisStaged' | 'trisCompleted' | 'trisMainCompleted' | 'trisReplayed' |
    'particleSpansStaged' | 'beamSpansStaged' |
    'workerTrisCompleted' | 'mainTrisCompleted' |
    'spriteSpansInline' | 'aliasDrawsStaged' |
    'particleSpansInline' | 'beamSpansInline' |
    'alphaSpansWorkerCompleted' | 'alphaSpansMainCompleted' |
    'spriteSpansWorkerCompleted' | 'spriteSpansMainCompleted' |
    'aliasTrisWorkerCompleted' | 'aliasTrisMainCompleted' |
    'particleSpansWorkerCompleted' | 'particleSpansMainCompleted' |
    'beamSpansWorkerCompleted' | 'beamSpansMainCompleted'> = [
    'trisStaged', 'trisCompleted', 'trisMainCompleted', 'trisReplayed',
    'particleSpansStaged', 'beamSpansStaged',
    'workerTrisCompleted', 'mainTrisCompleted',
    'spriteSpansInline', 'aliasDrawsStaged',
    'particleSpansInline', 'beamSpansInline',
    'alphaSpansWorkerCompleted', 'alphaSpansMainCompleted',
    'spriteSpansWorkerCompleted', 'spriteSpansMainCompleted',
    'aliasTrisWorkerCompleted', 'aliasTrisMainCompleted',
    'particleSpansWorkerCompleted', 'particleSpansMainCompleted',
    'beamSpansWorkerCompleted', 'beamSpansMainCompleted',
  ];
  for (const k of FG_OPT_NUM) {
    const v = src[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    out[k] = v;
  }
  const diw = src['directInlineWrites'];
  if (diw !== undefined) {
    if (typeof diw !== 'boolean') return null;
    (out as unknown as Record<string, unknown>)['directInlineWrites'] = diw;
  }
  return out as unknown as ForegroundStats;
}

export type RGBFailureClass = 'clean' | 'partial' | null;

/**
 * Last RGB flush outcome when the pool publishes it: 'clean' (nothing ran),
 * 'partial' (workers may have written), null (success/none), or 'absent'
 * when the hook does not exist in this build.
 */
export function readLastRGBFailure(pool: object): RGBFailureClass | 'absent' {
  const rec = pool as unknown as Record<string, unknown>;
  if (typeof rec['lastRGBFailure'] !== 'function') return 'absent';
  try {
    const v = (rec['lastRGBFailure'] as () => unknown).call(pool);
    if (v === 'clean' || v === 'partial') return v;
    return null;
  } catch {
    return 'absent';
  }
}

/** Applied-prefix watermark when published, else null. */
export function readRgbFlushed(pool: object): number | null {
  const rec = pool as unknown as Record<string, unknown>;
  if (typeof rec['rgbFlushed'] !== 'function') return null;
  try {
    const v = (rec['rgbFlushed'] as () => unknown).call(pool);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export interface InlineReplayTally {
  pixels: number;
  spans: number;
}

/**
 * Complete-frame recovery replay when published: clears planes, applies
 * the retained range exactly once. Null when the hook is absent.
 */
export function recoverInlineAll(
  pool: object, seed: () => void, near: number, far: number, lodBias: number,
): InlineReplayTally | null {
  const rec = pool as unknown as Record<string, unknown>;
  if (typeof rec['recoverInlineRGBAll'] !== 'function') return null;
  try {
    const fn = rec['recoverInlineRGBAll'] as (
      seed: () => void, near: number, far: number, lodBias: number,
    ) => unknown;
    const res = fn.call(pool, seed, near, far, lodBias) as Record<string, unknown>;
    if (typeof res !== 'object' || res === null) return null;
    if (typeof res['pixels'] !== 'number' || typeof res['spans'] !== 'number') return null;
    return { pixels: res['pixels'] as number, spans: res['spans'] as number };
  } catch {
    return null;
  }
}

/** End-of-frame retention drop when published. False when absent. */
export function commitPoolRGB(pool: object): boolean {
  const rec = pool as unknown as Record<string, unknown>;
  if (typeof rec['commitRGB'] !== 'function') return false;
  try {
    (rec['commitRGB'] as () => unknown).call(pool);
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-band worker-local execution samples through the public hook the
 * renderer/browser lanes publish (PERF-NEXT-4 shape:
 * `testBandExecStats()` returning WorkerExecSample[] — implemented by the
 * Node `BandWorkerPool` and the browser `BrowserBandPool`). Feature-detected:
 * null while the producer publishes nothing (timing disabled, legacy shape,
 * or no kick yet) — the caller keeps fencing dispatch-to-completion. Never throws.
 */
export function readBandExecStats(source: object): WorkerExecSample[] | null {
  return collectWorkerExec(source);
}

/**
 * Browser last-kick diagnostic snapshot (apps/web `DiagSnapshot`):
 * main-thread `performance.now()` dispatch-to-completion arrivals plus
 * worker-local `workerExecMs` durations (-1 per arrival when the worker
 * build omitted `execMs`), band identity and tallies parallel to arrivals.
 * Structural read for bench browser reports — null when the pool is
 * disarmed/absent or the shape is malformed. Arrivals and execution stay
 * in separate fields, never fused (different clocks, different meaning).
 */
export interface DiagSnapshotRead {
  kicks: number;
  frame: number;
  seq: number;
  job: string;
  bands: number;
  mainMs: number;
  arrivals: number[];
  bandIds: number[];
  pixels: number[];
  spans: number[];
  workerExecMs: number[];
  slowestMs: number;
}

/** Parse a browser DiagSnapshot structurally; null when absent/malformed. */
export function readDiagSnapshot(source: object): DiagSnapshotRead | null {
  const rec = source as unknown as Record<string, unknown>;
  if (typeof rec['diagSnapshot'] !== 'function') return null;
  let raw: unknown;
  try {
    raw = (rec['diagSnapshot'] as () => unknown).call(source);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const num = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v);
  if (!num(s['kicks']) || !num(s['frame']) || !num(s['seq']) ||
    typeof s['job'] !== 'string' || !num(s['bands']) || !num(s['mainMs']) ||
    !num(s['slowestMs'])) return null;
  const arr = (v: unknown): number[] | null => {
    if (!Array.isArray(v)) return null;
    const out: number[] = [];
    for (const e of v) {
      if (!num(e)) return null;
      out.push(e);
    }
    return out;
  };
  const arrivals = arr(s['arrivals']);
  const bandIds = arr(s['bandIds']);
  const pixels = arr(s['pixels']);
  const spans = arr(s['spans']);
  const workerExecMs = arr(s['workerExecMs']);
  if (!arrivals || !bandIds || !pixels || !spans || !workerExecMs) return null;
  if (bandIds.length !== arrivals.length || pixels.length !== arrivals.length ||
    spans.length !== arrivals.length || workerExecMs.length !== arrivals.length) return null;
  for (const e of workerExecMs) {
    if (!(e === -1 || e >= 0)) return null;
  }
  return {
    kicks: s['kicks'] as number, frame: s['frame'] as number, seq: s['seq'] as number,
    job: s['job'] as string, bands: s['bands'] as number, mainMs: s['mainMs'] as number,
    arrivals, bandIds, pixels, spans, workerExecMs, slowestMs: s['slowestMs'] as number,
  };
}

/**
 * Material-cache GC cost probe (PERF-NEXT-4 assumed shape): the renderer
 * may publish `testMaterialGcMs()` (ms spent in chain/material eviction
 * + rebuild accounting this frame window) alongside the byte/eviction
 * counters `collectStageCounters` already reads. Feature-detected: null
 * while unpublished — the bench reports chain bytes + eviction counts and
 * says the ms cost is unknown, never zero.
 */
export function readMaterialGcMs(source: object): number | null {
  const rec = source as unknown as Record<string, unknown>;
  if (typeof rec['testMaterialGcMs'] !== 'function') return null;
  try {
    const v = (rec['testMaterialGcMs'] as () => unknown).call(source);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    return v;
  } catch {
    return null;
  }
}
