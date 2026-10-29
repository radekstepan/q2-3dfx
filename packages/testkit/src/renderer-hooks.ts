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
