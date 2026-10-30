// @q2/testkit — shared foreground attribution taxonomy (PERF-NEXT-5).
//
// ONE vocabulary for testkit readers, bench rows, and (via the browser
// lane) browser stats. Units and sentinels are fixed here; every consumer
// imports this module instead of redefining them.
//
// VOCABULARY (per primitive class — alias/viewmodel, alpha spans, sprites,
// particles, beams):
//   - staged:    offered to a worker kick (spans, draws, tris, particles —
//                the unit is named on every field, never mixed).
//   - worker-completed: actually executed on worker bands (actual completion,
//                never staging, never dispatch counts).
//   - main-completed:    actually executed on the calling-thread band.
//                Absent per-kick split fields imply the calling-thread band
//                ran inline — the producer attributes that work to main,
//                never to worker-completed.
//   - inline:    deliberately drawn inline (serial path, refused staging).
//   - replayed:  fallback replay after a declined/timed-out/failed kick
//                (recovery/quarantine path). Never worker-completed.
//   - combined:  worker-completed + main-completed. Must reconcile exactly;
//                `reconcileForegroundAttribution()` enforces it.
//
// SENTINELS:
//   - Every count is `number | null`. `null` = unknown/unpublished (hook or
//     field absent, per-class split not tracked). NEVER a fake zero, NEVER
//     staged-as-completed, NEVER combined-as-worker.
//   - Browser `Q2Stats` uses `-1` for the same unknown (different transport,
//     same meaning — see apps/web `dom.ts`); testkit/bench use `null`.
//   - A genuine zero (hook present, field published as 0, e.g. no kick ran)
//     is a real zero and reconciles as such.
//
// PRODUCER CONTRACT (renderer + browser lanes publish it):
//   - Node `BandWorkerPool.flushRGBFrame[_Async]` returns combined totals
//     plus the worker-band split (`workerSpans/workerPixels/workerTris`)
//     and/or the calling-thread split (`mainSpans/mainPixels/mainTris`);
//     main share = combined − worker. A kick result WITHOUT the split maps
//     to the calling-thread band (main = combined, worker = 0) — absent
//     fields imply the calling-thread band ran inline and are NEVER
//     reported as worker-completed.
//   - `SoftwareRenderer.testForegroundStats()` accumulates kick-level
//     `worker*Completed`/`main*Completed` from actual completions only,
//     per-class staged/inline in native units (staged draws + staged spans
//     + inline draws + inline spans per class), and replayed/recovery
//     counters on the fallback path.
//   - Per-class worker/main completion splits are unpublished BY
//     CONSTRUCTION (one kick mixes alpha + sprite + particle + beam spans
//     and alias tris; the pool reports only the global split) — they read
//     null (unknown), never inferred from staged batches. The optional
//     per-class fields below are accepted if a future producer publishes
//     them; while unpublished they read null.
//   - This reader cannot correct a lying producer — it pins the contract:
//     reconciliation mismatches (e.g. worker > 0 with zero completed kicks)
//     are REPORTED, never laundered.
import { readForegroundStats } from './renderer-hooks.js';

/** One count in the taxonomy: a real zero reconciles, null is unknown. */
export type AttributedCount = number | null;

/**
 * Kick-level completion attribution: combined totals worked on every band
 * plus the worker-band / calling-thread-band split. Units: spans, pixels,
 * screen tris (a tri straddling a band boundary fills disjoint rows in
 * both bands and counts once per band, so tris can slightly exceed staged).
 */
export interface KickAttribution {
  /** Combined completed totals (worker + calling-thread band). */
  spans: AttributedCount;
  pixels: AttributedCount;
  tris: AttributedCount;
  /** Worker-band share of the completed totals (actual execution only). */
  workerSpans: AttributedCount;
  workerPixels: AttributedCount;
  workerTris: AttributedCount;
  /** Calling-thread band share of the completed totals. */
  mainSpans: AttributedCount;
  mainPixels: AttributedCount;
  mainTris: AttributedCount;
}

/**
 * Foreground attribution for one beginFrame→endFrame window, in explicit
 * units. `null` = the producer publishes no such split (unknown) — never
 * inferred from staged batches, never a fake zero.
 */
export interface ForegroundAttribution {
  /** Completed kicks (completions, never dispatches). */
  kicks: AttributedCount;
  /** Batches offered to worker kicks. Unit: batches. */
  stagedBatches: AttributedCount;
  /** Batches drawn inline. Unit: batches. */
  inlineBatches: AttributedCount;
  /** Kick-level completion (worker + main + combined, reconciling). */
  kick: KickAttribution;
  /** Deferred TRANS alpha spans offered to the kick. Unit: spans. */
  alphaSpansStaged: AttributedCount;
  /** Deferred TRANS alpha spans drawn inline. Unit: spans. */
  alphaSpansInline: AttributedCount;
  /** Alpha spans executed on worker bands. Unit: spans (null = untracked). */
  alphaSpansWorkerCompleted: AttributedCount;
  /** Alpha spans executed on the calling-thread band. Unit: spans. */
  alphaSpansMainCompleted: AttributedCount;
  /** World/entity sprite spans offered to the kick. Unit: spans. */
  spriteSpansStaged: AttributedCount;
  /** Sprite spans drawn inline (pooled staging-refusal path). Unit: spans. */
  spriteSpansInline: AttributedCount;
  /** Sprite draws executed inline. Unit: draws. */
  spriteDrawsInline: AttributedCount;
  /** Sprite spans executed on worker bands. Unit: spans (null = untracked). */
  spriteSpansWorkerCompleted: AttributedCount;
  /** Sprite spans executed on the calling-thread band. Unit: spans. */
  spriteSpansMainCompleted: AttributedCount;
  /** Alias draws executed inline (incl. serial viewmodel). Unit: draws. */
  aliasDrawsInline: AttributedCount;
  /** Alias instances offered to the kick (incl. the viewmodel gun). Unit: draws. */
  aliasDrawsStaged: AttributedCount;
  /** Alias triangles executed inline (incl. serial viewmodel). Unit: tris. */
  aliasTrisInline: AttributedCount;
  /** Alias screen tris offered to the kick. Unit: tris. */
  trisStaged: AttributedCount;
  /** Alias tris executed on worker bands. Unit: tris (null = untracked). */
  aliasTrisWorkerCompleted: AttributedCount;
  /** Alias tris executed on the calling-thread band. Unit: tris. */
  aliasTrisMainCompleted: AttributedCount;
  /** Particle draws executed inline. Unit: draws. */
  particleDrawsInline: AttributedCount;
  /** Particles drawn inline. Unit: particles. */
  particlesInline: AttributedCount;
  /** Particle spans offered to the kick. Unit: spans. */
  particleSpansStaged: AttributedCount;
  /** Particle spans drawn inline (pooled staging-refusal path). Unit: spans. */
  particleSpansInline: AttributedCount;
  /** Particle spans executed on worker bands. Unit: spans (null = untracked). */
  particleSpansWorkerCompleted: AttributedCount;
  /** Particle spans executed on the calling-thread band. Unit: spans. */
  particleSpansMainCompleted: AttributedCount;
  /** Tracer-beam draws executed inline. Unit: draws. */
  beamDrawsInline: AttributedCount;
  /** Beam spans offered to the kick. Unit: spans. */
  beamSpansStaged: AttributedCount;
  /** Beam spans drawn inline (pooled staging-refusal path). Unit: spans. */
  beamSpansInline: AttributedCount;
  /** Beam spans executed on worker bands. Unit: spans (null = untracked). */
  beamSpansWorkerCompleted: AttributedCount;
  /** Beam spans executed on the calling-thread band. Unit: spans. */
  beamSpansMainCompleted: AttributedCount;
  /** Foreground spans replayed by fallback recovery. Unit: spans. */
  replayedSpans: AttributedCount;
  /** Foreground pixels replayed by fallback recovery. Unit: pixels. */
  replayedPixels: AttributedCount;
  /** Foreground tris replayed by fallback recovery. Unit: tris. */
  replayedTris: AttributedCount;
  /** Complete-frame recovery replays (staging refusals + kick failures). */
  recoveryCount: AttributedCount;
  /** Wall time of the entity-foreground pass. Unit: ms. */
  entityMs: AttributedCount;
  /** Un-retained inline writes happened (later blends refuse staging). */
  directInlineWrites: boolean | null;
}

/** Null-filled attribution: the producer hook is absent (all unknown). */
export function unknownForegroundAttribution(): ForegroundAttribution {
  const u: AttributedCount = null;
  return {
    kicks: u, stagedBatches: u, inlineBatches: u,
    kick: {
      spans: u, pixels: u, tris: u,
      workerSpans: u, workerPixels: u, workerTris: u,
      mainSpans: u, mainPixels: u, mainTris: u,
    },
    alphaSpansStaged: u, alphaSpansInline: u,
    alphaSpansWorkerCompleted: u, alphaSpansMainCompleted: u,
    spriteSpansStaged: u, spriteSpansInline: u, spriteDrawsInline: u,
    spriteSpansWorkerCompleted: u, spriteSpansMainCompleted: u,
    aliasDrawsInline: u, aliasDrawsStaged: u, aliasTrisInline: u, trisStaged: u,
    aliasTrisWorkerCompleted: u, aliasTrisMainCompleted: u,
    particleDrawsInline: u, particlesInline: u, particleSpansStaged: u,
    particleSpansInline: u,
    particleSpansWorkerCompleted: u, particleSpansMainCompleted: u,
    beamDrawsInline: u, beamSpansStaged: u, beamSpansInline: u,
    beamSpansWorkerCompleted: u, beamSpansMainCompleted: u,
    replayedSpans: u, replayedPixels: u, replayedTris: u,
    recoveryCount: u, entityMs: u, directInlineWrites: null,
  };
}

/**
 * Optional per-class completion-split producer fields (renderer lane may
 * publish them; absent = untracked = null, never inferred). Validated as
 * finite non-negative numbers when present; a present-but-malformed field
 * rejects the whole read (never laundered into a zero).
 */
const PER_CLASS_SPLIT_KEYS = [
  'alphaSpansWorkerCompleted', 'alphaSpansMainCompleted',
  'spriteSpansWorkerCompleted', 'spriteSpansMainCompleted',
  'aliasTrisWorkerCompleted', 'aliasTrisMainCompleted',
  'particleSpansWorkerCompleted', 'particleSpansMainCompleted',
  'beamSpansWorkerCompleted', 'beamSpansMainCompleted',
] as const;

function readOptionalCount(raw: Record<string, unknown>, key: string): AttributedCount | 'malformed' {
  const v = raw[key];
  if (v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 'malformed';
  return v;
}

/**
 * Read the corrected foreground attribution through the renderer's public
 * `testForegroundStats()` hook. Null when the hook is absent or malformed
 * (caller skips clearly — never a fake zero).
 *
 * Projection rules (PERF-NEXT-5 corrected semantics):
 * - worker and main kick totals come ONLY from the producer's accumulated
 *   actual-completion counters. Absent split fields read null (unknown).
 * - Kick-level worker tris prefer the producer's `workerTrisCompleted` /
 *   `mainTrisCompleted` split when published; otherwise derive
 *   worker = `trisCompleted` − `trisMainCompleted` — both are
 *   completion-side counters, so the difference is still actual execution,
 *   never staging inference.
 * - Per-class worker/main completion splits read null while the producer
 *   publishes none — staged batches are NEVER reported as worker-completed.
 */
export function readForegroundAttribution(source: object): ForegroundAttribution | null {
  const stats = readForegroundStats(source);
  if (!stats) return null;
  const rec = source as unknown as Record<string, unknown>;
  let raw: Record<string, unknown> | null = null;
  try {
    const fn = rec['testForegroundStats'] as () => unknown;
    const v = fn.call(source);
    if (typeof v === 'object' && v !== null) raw = v as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw) return null;
  const out = unknownForegroundAttribution();
  out.kicks = stats.kicks;
  out.stagedBatches = stats.stagedBatches;
  out.inlineBatches = stats.inlineBatches;
  out.kick.spans = stats.workerSpansCompleted + stats.mainSpansCompleted;
  out.kick.pixels = stats.workerPixelsCompleted + stats.mainPixelsCompleted;
  out.kick.workerSpans = stats.workerSpansCompleted;
  out.kick.workerPixels = stats.workerPixelsCompleted;
  out.kick.mainSpans = stats.mainSpansCompleted;
  out.kick.mainPixels = stats.mainPixelsCompleted;
  // Kick-level tris: prefer the explicit worker/main split; else reconcile
  // worker = total − main (both completion-side — never staging).
  const wTris = readOptionalCount(raw, 'workerTrisCompleted');
  const mTris = readOptionalCount(raw, 'mainTrisCompleted');
  if (wTris === 'malformed' || mTris === 'malformed') return null;
  const tTotal = stats.trisCompleted ?? null;
  const legacyMain = stats.trisMainCompleted ?? null;
  if (wTris !== null && mTris !== null) {
    out.kick.workerTris = wTris;
    out.kick.mainTris = mTris;
    out.kick.tris = tTotal ?? wTris + mTris;
  } else if (tTotal !== null && legacyMain !== null) {
    out.kick.tris = tTotal;
    out.kick.mainTris = legacyMain;
    out.kick.workerTris = tTotal - legacyMain;
  } else {
    out.kick.tris = tTotal;
    out.kick.mainTris = legacyMain;
    out.kick.workerTris = null;
  }
  out.alphaSpansStaged = stats.alphaSpansStaged;
  out.alphaSpansInline = stats.alphaSpansInline;
  out.spriteSpansStaged = stats.spriteSpansStaged;
  out.spriteSpansInline = stats.spriteSpansInline ?? null;
  out.spriteDrawsInline = stats.spriteDrawsInline;
  out.aliasDrawsInline = stats.aliasDrawsInline;
  out.aliasDrawsStaged = stats.aliasDrawsStaged ?? null;
  out.aliasTrisInline = stats.aliasTrisInline;
  out.trisStaged = stats.trisStaged ?? null;
  out.particleDrawsInline = stats.particleDrawsInline;
  out.particlesInline = stats.particlesInline;
  out.particleSpansStaged = stats.particleSpansStaged ?? null;
  out.particleSpansInline = stats.particleSpansInline ?? null;
  out.beamDrawsInline = stats.beamDrawsInline;
  out.beamSpansStaged = stats.beamSpansStaged ?? null;
  out.beamSpansInline = stats.beamSpansInline ?? null;
  out.replayedSpans = stats.replayedSpans;
  out.replayedPixels = stats.replayedPixels;
  out.replayedTris = stats.trisReplayed ?? null;
  out.recoveryCount = stats.recoveryCount;
  out.entityMs = stats.entityMs;
  out.directInlineWrites = stats.directInlineWrites ?? null;
  for (const key of PER_CLASS_SPLIT_KEYS) {
    const v = readOptionalCount(raw, key);
    if (v === 'malformed') return null;
    (out as unknown as Record<string, AttributedCount>)[key] = v;
  }
  return out;
}

/**
 * Reconcile one attribution: combined kick totals must equal worker + main
 * exactly wherever all three are published; zero completed kicks must not
 * carry worker-completed work (failure/replay is never successful worker
 * execution). Returns mismatch descriptions (empty = reconciles). Pure.
 *
 * Per-class completion splits are null BY DESIGN while the producer
 * publishes none (see readForegroundAttribution) — but a producer that DOES
 * publish one is held to the same zero-kick rule: a nonzero per-class
 * worker/main completion on a zero-kick frame is failure staged as
 * execution, exactly like the kick-level triple.
 */
export function reconcileForegroundAttribution(a: ForegroundAttribution): string[] {
  const bad: string[] = [];
  const triple = (
    label: string, combined: AttributedCount,
    worker: AttributedCount, main: AttributedCount,
  ): void => {
    if (combined !== null && worker !== null && main !== null) {
      if (combined !== worker + main) {
        bad.push(`${label}: combined=${combined} != worker(${worker})+main(${main})`);
      }
    }
  };
  triple('spans', a.kick.spans, a.kick.workerSpans, a.kick.mainSpans);
  triple('pixels', a.kick.pixels, a.kick.workerPixels, a.kick.mainPixels);
  triple('tris', a.kick.tris, a.kick.workerTris, a.kick.mainTris);
  if (a.kicks === 0) {
    for (const [label, v] of [
      ['workerSpans', a.kick.workerSpans],
      ['workerPixels', a.kick.workerPixels],
      ['workerTris', a.kick.workerTris],
    ] as Array<[string, AttributedCount]>) {
      if (v !== null && v !== 0) bad.push(`${label}=${v} with kicks=0 (failure staged as execution)`);
    }
    // Same rule for published per-class completion splits (unpublished =
    // null = skipped; a published nonzero on a zero-kick frame is the same
    // misattribution, flagged with its field name, never laundered).
    for (const [label, v] of [
      ['alphaSpansWorkerCompleted', a.alphaSpansWorkerCompleted],
      ['alphaSpansMainCompleted', a.alphaSpansMainCompleted],
      ['spriteSpansWorkerCompleted', a.spriteSpansWorkerCompleted],
      ['spriteSpansMainCompleted', a.spriteSpansMainCompleted],
      ['aliasTrisWorkerCompleted', a.aliasTrisWorkerCompleted],
      ['aliasTrisMainCompleted', a.aliasTrisMainCompleted],
      ['particleSpansWorkerCompleted', a.particleSpansWorkerCompleted],
      ['particleSpansMainCompleted', a.particleSpansMainCompleted],
      ['beamSpansWorkerCompleted', a.beamSpansWorkerCompleted],
      ['beamSpansMainCompleted', a.beamSpansMainCompleted],
    ] as Array<[string, AttributedCount]>) {
      if (v !== null && v !== 0) bad.push(`${label}=${v} with kicks=0 (failure staged as execution)`);
    }
  }
  return bad;
}

/** One-line attribution ledger (unknown renders as —, never 0). */
export function formatForegroundAttribution(a: ForegroundAttribution): string {
  const f = (v: AttributedCount): string => (v === null ? '—' : `${v}`);
  const b = (v: boolean | null): string => (v === null ? '—' : `${v}`);
  return (
    `fg[kicks=${f(a.kicks)} staged=${f(a.stagedBatches)} inline=${f(a.inlineBatches)} ` +
    `worker=${f(a.kick.workerSpans)}sp/${f(a.kick.workerPixels)}px/${f(a.kick.workerTris)}tr ` +
    `main=${f(a.kick.mainSpans)}sp/${f(a.kick.mainPixels)}px/${f(a.kick.mainTris)}tr ` +
    `combined=${f(a.kick.spans)}sp/${f(a.kick.pixels)}px/${f(a.kick.tris)}tr ` +
    `alpha=${f(a.alphaSpansStaged)}sp/${f(a.alphaSpansInline)}in ` +
    `sprite=${f(a.spriteSpansStaged)}sp/${f(a.spriteSpansInline)}spin/${f(a.spriteDrawsInline)}in ` +
    `alias=${f(a.trisStaged)}st/${f(a.aliasDrawsStaged)}stdraws/${f(a.aliasDrawsInline)}in+${f(a.aliasTrisInline)}tr ` +
    `part=${f(a.particleSpansStaged)}sp/${f(a.particleSpansInline)}spin/${f(a.particleDrawsInline)}in+${f(a.particlesInline)}p ` +
    `beam=${f(a.beamSpansStaged)}sp/${f(a.beamSpansInline)}spin/${f(a.beamDrawsInline)}in ` +
    `replayed=${f(a.replayedSpans)}sp/${f(a.replayedPixels)}px/${f(a.replayedTris)}tr ` +
    `recovery=${f(a.recoveryCount)} entityMs=${f(a.entityMs)} directInline=${b(a.directInlineWrites)}]`
  );
}
