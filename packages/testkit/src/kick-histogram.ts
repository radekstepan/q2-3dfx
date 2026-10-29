// @q2/testkit — kick-size histograms + empty-kick counters (PERF-NEXT-6, Lane C).
//
// PERF-NEXT-6 must know how big each kick is (descriptors/spans per kick per
// flush point) and — first-class, not grep — how many kicks run EMPTY (the
// empty-FG-suffix-kick finding: a foreground flush that passes the
// pending>flushed guard yet completes zero work). Both come from EXISTING
// public producer hooks; this module only projects them (no renderer change):
//
// - Per-kick sizes: `testBandExecStats()` accumulates one WorkerExecSample
//   per band per kick since the last beginFrame (world kick, foreground
//   flushes incl. the placed pass, resolve, scanout — job/seq identity on
//   every sample). Grouping by (frame, seq, job) recovers each kick's
//   completed spans/pixels/tris plus the band count and the within-kick
//   execution max. Ordering within one frame's `rgb` job is drain order
//   (world kick first, foreground flushes after) — reported as `order`, a
//   position, never a flush-point name the producer did not publish.
// - Newest-kick descriptors: `lastWorkerExec()` exposes the newest kick's
//   full BandExecSample records INCLUDING `descs`/`kickBase`/`kickDescs`
//   (drained descriptor range — a foreground-only suffix kick has
//   kickBase == the previous kick's applied watermark; a truly empty kick
//   drains kickDescs == 0). Read structurally; absent/disabled/malformed is
//   null (unknown), never zero.
//
// TIMEBASE: execMs durations are worker-local (epoch-free); kick sizes are
// work counts. Dispatch-to-completion latencies live in the KickJournal, not
// here — never fused.
import type { CritJobKind } from './critpath.js';
import { summarizeLatencies } from './critpath.js';
import type { WorkerExecSample } from './worker-timing.js';
import { collectWorkerExec } from './worker-timing.js';

/**
 * Jobs whose bands do spanfill: only these can run "empty". Resolve and
 * scanout kicks never carry spans/pixels/tris by construction (they expand
 * planes into the display) — zero work there is expected execution, never
 * an empty kick. Indexed resolve/frame share the indexed path's vocabulary.
 */
const SPANFILL_JOBS: ReadonlySet<CritJobKind> = new Set([
  'rgb', 'indexed-frame', 'world', 'foreground',
]);

/** One completed kick's size: work summed across its bands. */
export interface KickSizeEntry {  frame: number;
  seq: number;
  job: CritJobKind;
  /** Drain order of this kick among its job kind within the frame (0-based). */
  order: number;
  bands: number;
  spans: number;
  pixels: number;
  tris: number;
  /** Slowest band's worker-local execution (null when unpublished). */
  execMaxMs: number | null;
  /**
   * True when a spanfill-kind kick (rgb/indexed-frame/world/foreground)
   * completed zero spans+pixels+tris on every band. Resolve/scanout kicks
   * never carry spans by construction — their zero is expected execution,
   * never empty (always false there).
   */
  empty: boolean;
}

/** Per-job rollup over one config's kicks (counts + size distribution). */
export interface KickJobSummary {
  job: CritJobKind;
  kicks: number;
  emptyKicks: number;
  bands: number;
  medSpans: number;
  maxSpans: number;
  medPixels: number;
  maxPixels: number;
  medTris: number;
  maxTris: number;
  medExecMs: number | null;
  maxExecMs: number | null;
}

/** Kick-size histogram for one config (last frame's kicks). */
export interface KickSizeSummary {
  /** Per-kick entries, oldest first. */
  kicks: KickSizeEntry[];
  totalKicks: number;
  /** First-class empty-kick counter (all bands zero work). */
  emptyKicks: number;  /** `frame:seq:job` identity of every empty kick (forensics, not grep). */
  emptyKickIds: string[];
  byJob: KickJobSummary[];
}

/**
 * Group per-band execution samples into per-kick sizes (pure). `order` is
 * the kick's position among same-job kicks within its frame (drain order).
 * Empty input summarizes to zero kicks (not null — the caller distinguishes
 * "no samples published" by passing null through instead of calling this).
 */
export function summarizeKickSizes(samples: WorkerExecSample[]): KickSizeSummary {
  const groups = new Map<string, WorkerExecSample[]>();
  for (const s of samples) {
    const k = `${s.frame}:${s.seq}:${s.job}`;
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  const orderSeen = new Map<string, number>();
  const kicks: KickSizeEntry[] = [];
  for (const g of groups.values()) {
    const first = g[0]!;
    const position = `${first.frame}:${first.job}`;
    const order = orderSeen.get(position) ?? 0;
    orderSeen.set(position, order + 1);
    let spans = 0, pixels = 0, tris = 0, execMax: number | null = null;
    for (const s of g) {
      spans += s.spans;
      pixels += s.pixels;
      tris += s.tris ?? 0;
      execMax = execMax === null ? s.execMs : Math.max(execMax, s.execMs);
    }
    kicks.push({
      frame: first.frame, seq: first.seq, job: first.job, order,
      bands: g.length, spans, pixels, tris, execMaxMs: execMax,
      empty: SPANFILL_JOBS.has(first.job) && spans === 0 && pixels === 0 && tris === 0,
    });
  }
  kicks.sort((a, b) => a.frame - b.frame || a.seq - b.seq);
  const emptyKickIds = kicks.filter((k) => k.empty).map((k) => `f${k.frame}s${k.seq}:${k.job}`);
  const byJob: KickJobSummary[] = [];
  const jobs = [...new Set(kicks.map((k) => k.job))];
  for (const job of jobs) {
    const ks = kicks.filter((k) => k.job === job);
    const lat = (pick: (k: KickSizeEntry) => number): { med: number; max: number } => {
      const s = summarizeLatencies(ks.map(pick));
      return { med: s.med, max: s.max };
    };
    const spans = lat((k) => k.spans), pixels = lat((k) => k.pixels), tris = lat((k) => k.tris);
    const execs = ks.map((k) => k.execMaxMs).filter((v): v is number => v !== null);
    const exec = execs.length > 0 ? summarizeLatencies(execs) : null;
    byJob.push({
      job, kicks: ks.length,
      emptyKicks: ks.filter((k) => k.empty).length,
      bands: ks.reduce((m, k) => Math.max(m, k.bands), 0),
      medSpans: spans.med, maxSpans: spans.max,
      medPixels: pixels.med, maxPixels: pixels.max,
      medTris: tris.med, maxTris: tris.max,
      medExecMs: exec?.med ?? null, maxExecMs: exec?.max ?? null,
    });
  }
  return {
    kicks, totalKicks: kicks.length,
    emptyKicks: emptyKickIds.length, emptyKickIds, byJob,
  };
}

/**
 * Read per-band samples through the public hook and summarize them. Null
 * when the producer publishes nothing (timing disabled, serial config, or
 * no kick yet) — the caller reports unknown, never zero.
 */
export function readKickSizes(source: object): KickSizeSummary | null {
  const samples = collectWorkerExec(source);
  if (!samples || samples.length === 0) return null;
  return summarizeKickSizes(samples);
}

/** Newest kick's descriptor drain (FG suffix kick when kickBase > 0). */
export interface LastKickDescs {
  frame: number;
  seq: number;
  job: string;
  bands: number;
  /** Uniform drained range across bands (null when bands disagree). */
  kickBase: number | null;
  kickDescs: number | null;
  descs: number;
  spans: number;
  pixels: number;
  tris: number;
  /** True when the kick drained descriptors yet completed zero work. */
  empty: boolean;
}

/** Structural newest-kick sample (full BandExecSample incl. descs range). */
interface RawNewestSample {
  frame: unknown; seq: unknown; job: unknown;
  descs: unknown; kickBase: unknown; kickDescs: unknown;
  spans: unknown; pixels: unknown; tris: unknown;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function countOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  return n !== null && n >= 0 ? Math.floor(n) : null;
}

/**
 * Read the newest kick's descriptor drain through the public
 * `lastWorkerExec()` hook. Returns null when the hook is absent, returns
 * null/empty, or any entry is malformed (never laundered into zeros).
 * `empty` flags the empty-suffix-kick shape: descriptors drained (or even
 * none drained) with zero completed spans/pixels/tris.
 */
export function readLastKickDescs(source: object): LastKickDescs | null {
  const rec = source as unknown as Record<string, unknown>;
  if (typeof rec['lastWorkerExec'] !== 'function') return null;
  let raw: unknown;
  try {
    raw = (rec['lastWorkerExec'] as () => unknown).call(source);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const samples = raw as RawNewestSample[];
  let frame: number | null = null, seq: number | null = null, job: string | null = null;
  let kickBase: number | null = null, kickDescs: number | null = null;
  let uniformRange = true;
  let descs = 0, spans = 0, pixels = 0, tris = 0;
  for (const s of samples) {
    if (typeof s !== 'object' || s === null) return null;
    const f = countOrNull(s.frame);
    const q = countOrNull(s.seq);
    if (f === null || q === null || typeof s.job !== 'string') return null;
    const d = countOrNull(s.descs);
    const kb = countOrNull(s.kickBase);
    const kd = countOrNull(s.kickDescs);
    const sp = countOrNull(s.spans);
    const px = countOrNull(s.pixels);
    const tr = s.tris === undefined ? 0 : countOrNull(s.tris);
    if (d === null || kb === null || kd === null || sp === null || px === null || tr === null) return null;
    if (frame === null) {
      frame = f; seq = q; job = s.job; kickBase = kb; kickDescs = kd;
    } else if (f !== frame || q !== seq || s.job !== job) {
      return null;
    } else if (kb !== kickBase || kd !== kickDescs) {
      uniformRange = false;
    }
    descs += d; spans += sp; pixels += px; tris += tr;
  }
  if (frame === null || seq === null || job === null) return null;
  return {
    frame, seq, job, bands: samples.length,
    kickBase: uniformRange ? kickBase : null,
    kickDescs: uniformRange ? kickDescs : null,
    descs, spans, pixels, tris,
    empty: spans === 0 && pixels === 0 && tris === 0,
  };
}

/** One-line kick-size ledger (unknown renders as —, never 0). */
export function formatKickSizes(s: KickSizeSummary): string {
  if (s.totalKicks === 0) return 'kicks[n=0]';
  const f = (v: number): string => `${v}`;
  const e = (v: number | null): string => (v === null ? '—' : v.toFixed(2));
  const parts = s.byJob.map((g) =>
    `${g.job}[n=${g.kicks} empty=${g.emptyKicks} bands≤${g.bands} ` +
    `spans med=${f(Math.round(g.medSpans))} max=${f(Math.round(g.maxSpans))} ` +
    `px med=${f(Math.round(g.medPixels))} max=${f(Math.round(g.maxPixels))} ` +
    `tris med=${f(Math.round(g.medTris))} max=${f(Math.round(g.maxTris))} ` +
    `exec med=${e(g.medExecMs)} max=${e(g.maxExecMs)}]`,
  );
  return `kicks[n=${s.totalKicks} empty=${s.emptyKicks}${s.emptyKickIds.length > 0 ? ` (${s.emptyKickIds.join(',')})` : ''} ${parts.join(' ')}]`;
}

/** One-line newest-kick descriptor ledger. */
export function formatLastKickDescs(k: LastKickDescs): string {
  const r = (v: number | null): string => (v === null ? 'mixed' : `${v}`);
  return (
    `lastKick[f${k.frame}s${k.seq}:${k.job} base=${r(k.kickBase)} descs=${r(k.kickDescs)} ` +
    `bands=${k.bands} visited=${k.descs} spans=${k.spans} px=${k.pixels} tris=${k.tris}${k.empty ? ' EMPTY' : ''}]`
  );
}
