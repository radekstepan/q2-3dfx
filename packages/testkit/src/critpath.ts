// @q2/testkit — trustworthy critical-path measurement helpers (PERF-FINISH-C).
//
// TIMEBASE (read before reporting numbers):
//   - Every duration this module records is measured on the CALLER with
//     `process.hrtime.bigint()` (monotonic nanoseconds, ONE clock, one
//     origin). Cross-side subtraction is never performed: worker threads
//     share no comparable epoch with the caller in this harness, and
//     message-arrival delays are SCHEDULING (wakeups, creation, notify
//     latency), not per-worker compute durations. Reporting a postMessage
//     arrival delta as "worker N took X ms" is the exact confusion the
//     perf ledger flags (attribution vs additive whole-frame); this module
//     refuses to do it.
//   - What IS reported per job: dispatch-to-completion latency on the
//     caller (kick → all-bands-done fence), keyed by
//     frame/sequence + job type + stable band identity (band index and its
//     y-range, which never move for a fixed W×H×workers config).
//   - What is NOT measurable without renderer-side clocks (read-only from
//     this lane — the renderer owns its worker loop): per-worker execution
//     durations and the true critical-path max across bands. The shapes for
//     those counters live here (`BandExecSample`, `summarizeBandExec`) so
//     the bench consumes them the day the renderer publishes an in-worker
//     timestamp region; until then the bench reports dispatch-to-completion
//     + the main-thread band proxy + staged/admitted counts and says so.
//   - Instrumented vs uninstrumented are kept apart: phase medians
//     (GEO/DRAW/alias) are attribution-only diagnostics (sums of medians,
//     never a frame total). The acceptance metric is always a whole
//     production frame timed TOGETHER per rep. "Presented FPS" is a
//     browser/CDP metric (perf-ledger soak rows), never a Node number:
//     bench frameMs is production-frame-no-present.
//
// Stage vocabulary (all through public renderer test hooks, read-only):
//   staged   = batches routed to the pool (testRGBWorkerStats)
//   inline   = batches drawn on the caller (unpooled or fallback)
//   kicks    = completed worker kicks since the last beginFrame
//   cover    = framebuffer pixels the RGB composite marked (inspected by
//              the composite; the closest "pixels inspected" counter free
//              of new renderer plumbing)
//   skipped  = classic spans / foreground draws elided by the
//              RGB-authoritative skip (eliminated duplicate work)
//   inspected vs staged: cover (composite input) vs staged batches
//              (worker input); per-descriptor luxel/span byte totals need
//              renderer counters — reported as a documented gap, with
//              chain/plane bytes that ARE observable reported instead.

/** One clock for every duration: caller monotonic nanoseconds. */
export function nowNs(): bigint {
  try {
    if (typeof process !== 'undefined' && typeof process.hrtime === 'function') {
      return process.hrtime.bigint();
    }
  } catch {
    /* fall through to Date.now */
  }
  return BigInt(Date.now()) * 1000000n;
}

/** Nanoseconds → milliseconds (float). Single timebase; no cross-clock math. */
export function nsToMs(ns: bigint): number {
  return Number(ns) / 1e6;
}

/** Job types the bench can kick and fence on the caller (stable per frame).
 * PERF-NEXT-4: the production worker loop also runs world, foreground and
 * resolve jobs — the same vocabulary names them so caller fences and
 * worker-local execution samples join on (frame, seq, job, band). */
export type CritJobKind = 'rgb' | 'scanout' | 'indexed-resolve' | 'indexed-frame' | 'world' | 'foreground' | 'resolve';

/**
 * One fenced job: dispatch-to-completion latency measured on the caller.
 * `frame` counts production frames in this config; `seq` counts kicks of
 * this job kind within the frame (both caller-assigned, same timebase).
 * `band`/`y0`/`y1` is the stable band identity (the caller's own band for
 * the inline drain, or "all" for the pooled fence). `execMs` is present
 * ONLY when the duration was measured where the work ran (main-thread
 * inline drain timed around the call, or a future in-worker timestamp
 * region) — never a message-arrival delta.
 */
export interface KickSample {
  frame: number;
  seq: number;
  job: CritJobKind;
  workers: number;
  bands: number;
  band: number | 'all';
  y0: number;
  y1: number;
  latencyMs: number;
  ok: boolean;
  execMs: number | null;
  pixels: number;
  spans: number;
}

/** Distribution over kick latencies (the critical-path max is `max`). */
export interface LatencySummary {
  n: number;
  med: number;
  p95: number;
  max: number;
  min: number;
}

/** Median/p95/max over caller-clock latencies (pure; unit-tested). */
export function summarizeLatencies(xs: number[]): LatencySummary {
  if (xs.length === 0) return { n: 0, med: 0, p95: 0, max: 0, min: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const med = s[s.length >> 1]!;
  const p95 = s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
  return { n: s.length, med, p95, max: s[s.length - 1]!, min: s[0]! };
}

function fmt(v: number): string {
  return v.toFixed(2);
}

/** One-line kick distribution (dispatch-to-completion, caller clock). */
export function formatLatency(label: string, s: LatencySummary): string {
  if (s.n === 0) return `${label}[n=0]`;
  return `${label}[n=${s.n} med=${fmt(s.med)} p95=${fmt(s.p95)} max=${fmt(s.max)} min=${fmt(s.min)}]`;
}

/**
 * Future renderer-side per-band execution sample (in-worker clock, shared
 * epoch or explicit per-side durations + fence). CONSUMER-READY ONLY: no
 * producer exists in this lane (renderer owns its worker loop). The bench
 * reports dispatch-to-completion until the renderer publishes these.
 */
export interface BandExecSample {
  frame: number;
  seq: number;
  job: CritJobKind;
  band: number;
  y0: number;
  y1: number;
  execMs: number;
  pixels: number;
  spans: number;
}

/** Critical-path max across bands once BandExecSample exists (pure). */
export function summarizeBandExec(xs: BandExecSample[]): LatencySummary {
  return summarizeLatencies(xs.map((x) => x.execMs));
}

/** Structural renderer test-hook surface (SoftwareRenderer satisfies it). */
export interface StageCounterSource {
  testRGBStats(): {
    enabled: boolean; used: boolean;
    hits: number; misses: number; size: number; coverPixels: number;
  };
  testRGBWorkerStats(): { staged: number; inline: number; kicks: number };
  testRGBPending(): number;
  testClassicSkipStats(): {
    classicSpansSkipped: number; classicFgSkipped: number; skipArmed: boolean;
  };
  testTranslucentSpans(): number;
  testCacheStats(): {
    hits: number; misses: number; evictions: number; used: number; size: number; hitRate: number;
  };
  testRGBCacheStats(): {
    hits: number; misses: number; size: number; hitRate: number;
    evictions: number;
    chainHits: number; chainMisses: number; chainSize: number;
    chainUsed: number; chainEvictions: number;
  };
  testRGBChainAccounting(): {
    chainUsed: number; chainMapBytes: number; orphanChainBytes: number;
    retiredChainBytes?: number; retainedChainBytes: number; rgbEntries: number; budget: number;
  };
}

/** Per-frame staging/skip/cache counters (one beginFrame→endFrame window). */
export interface StageCounts {
  rgbUsed: boolean;
  coverPixels: number;
  stagedBatches: number;
  inlineBatches: number;
  kicks: number;
  pending: number;
  classicSpansSkipped: number;
  classicFgSkipped: number;
  skipArmed: boolean;
  translucentSpans: number;
  cacheHits: number;
  cacheMisses: number;
  cacheEvictions: number;
  rgbChainUsedBytes: number;
  rgbRetainedChainBytes: number;
  rgbOrphanChainBytes: number;
  rgbChainEvictions: number;
}

/** Read every staging counter through public hooks (no behavior change). */
export function collectStageCounters(r: StageCounterSource): StageCounts {
  const rgb = r.testRGBStats();
  const wst = r.testRGBWorkerStats();
  const skip = r.testClassicSkipStats();
  const cache = r.testCacheStats();
  const rc = r.testRGBCacheStats();
  const acct = r.testRGBChainAccounting();
  return {
    rgbUsed: rgb.used,
    coverPixels: rgb.coverPixels,
    stagedBatches: wst.staged,
    inlineBatches: wst.inline,
    kicks: wst.kicks,
    pending: r.testRGBPending(),
    classicSpansSkipped: skip.classicSpansSkipped,
    classicFgSkipped: skip.classicFgSkipped,
    skipArmed: skip.skipArmed,
    translucentSpans: r.testTranslucentSpans(),
    cacheHits: cache.hits,
    cacheMisses: cache.misses,
    cacheEvictions: cache.evictions,
    rgbChainUsedBytes: rc.chainUsed,
    rgbRetainedChainBytes: acct.retainedChainBytes,
    rgbOrphanChainBytes: acct.orphanChainBytes,
    rgbChainEvictions: rc.chainEvictions,
  };
}

/** One-line staging ledger (proof that pooled work actually staged). */
export function formatStageCounts(s: StageCounts): string {
  return (
    `stage[used=${s.rgbUsed} cover=${s.coverPixels} ` +
    `staged=${s.stagedBatches} inline=${s.inlineBatches} kicks=${s.kicks} pending=${s.pending}] ` +
    `skip[armed=${s.skipArmed} spans=${s.classicSpansSkipped} fg=${s.classicFgSkipped}] ` +
    `trans=${s.translucentSpans} ` +
    `cache[hits=${s.cacheHits} miss=${s.cacheMisses} evict=${s.cacheEvictions}] ` +
    `chain[used=${s.rgbChainUsedBytes} retained=${s.rgbRetainedChainBytes} orphan=${s.rgbOrphanChainBytes} evict=${s.rgbChainEvictions}]`
  );
}

/**
 * Main-thread segment split for ONE production frame, all segments timed
 * on the same caller clock in the same rep: begin + render + end + scanout
 * + the scheduling gap between them. `gapMs` is measured per rep
 * (frame minus the summed segments of THAT rep: GC, allocator, timer and
 * fence slack between segments), never a median-of-medians subtraction —
 * summarize per-rep gaps with summarizeLatencies.
 */
export interface FrameSplit {
  beginMs: number;
  renderMs: number;
  endMs: number;
  scanoutMs: number;
  frameMs: number;
  gapMs: number;
}

/** Build one rep's split from its segment walls (pure; gap reconciles). */
export function frameSplit(
  beginMs: number, renderMs: number, endMs: number, scanoutMs: number, frameMs: number,
): FrameSplit {
  return {
    beginMs, renderMs, endMs, scanoutMs, frameMs,
    gapMs: frameMs - (beginMs + renderMs + endMs + scanoutMs),
  };
}

/** Median split over reps (each rep reconciles first — never median math). */
export function summarizeSplits(splits: FrameSplit[]): {
  begin: number; render: number; end: number; scanout: number;
  frame: number; gap: number;
} {
  const pick = (f: (s: FrameSplit) => number): number =>
    summarizeLatencies(splits.map(f)).med;
  return {
    begin: pick((s) => s.beginMs),
    render: pick((s) => s.renderMs),
    end: pick((s) => s.endMs),
    scanout: pick((s) => s.scanoutMs),
    frame: pick((s) => s.frameMs),
    gap: pick((s) => s.gapMs),
  };
}

/**
 * Stable band identity for a W×H×workers config. Same tiling as the
 * pool's `splitBands` (even split, last band takes the rest): the caller
 * owns the last band, workers take the rest. Band index + y-range never
 * move for a fixed config, so kick records keyed by them are comparable
 * across reps and builds.
 */
export function bandRanges(h: number, workers: number): Array<{ band: number; y0: number; y1: number }> {
  const H = Math.max(0, Math.floor(h));
  const n = Math.max(1, Math.floor(workers) + 1);
  const base = Math.floor(H / n);
  const out: Array<{ band: number; y0: number; y1: number }> = [];
  let y = 0;
  for (let b = 0; b < n; b++) {
    const extra = b === n - 1 ? H - y : base;
    out.push({ band: b, y0: y, y1: y + extra });
    y += extra;
  }
  return out;
}

/** Compact band-identity ledger (`bands=4:[0-120,120-240,…]`, main = last). */
export function formatBandRanges(h: number, workers: number): string {
  const rs = bandRanges(h, workers);
  return `bands=${rs.length}:[${rs.map((r) => `${r.y0}-${r.y1}`).join(',')}]`;
}
