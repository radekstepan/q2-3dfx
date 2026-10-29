// @q2/testkit — per-frame reconciled GEO phase attribution (PERF-NEXT-6, Lane C).
//
// The eight geometry phases (setup/mark/traverse/cull/cache/project/emit/
// sort) are measured by the renderer's `testMeasurePhases()` hook — read here
// STRUCTURALLY (no renderer import; the producer shape is validated
// field-by-field, absent/malformed reads null, never a fake zero).
//
// RECONCILIATION RULE (frameSplit pattern, never summed medians): every rep
// records its own eight phases plus the instrumented wall around the same
// rep. Per-rep derived values reconcile first:
//   geoTotalMs_i = sum of the 8 GEO phases for rep i (a per-rep total),
//   gapMs_i      = wallMs_i - sum of ALL 10 phases for rep i (phase-clock
//                  slack + uninstrumented regions inside the measured wall).
// Summaries take medians OVER REPS of per-rep values (median of totals, median
// of gaps) — never a sum of phase medians. A sum of medians is reported
// nowhere by this module (that shape is the known-diagnostic legacy on
// stationary AttrRows, not a frame total).
//
// Separate from the production frame: the instrumented wall runs the same
// workload (same view/entities/world) with phase probes armed. The drawn
// output is identical either way (producer contract); the acceptance metric
// stays the uninstrumented whole production frame measured together per rep.
import { summarizeLatencies } from './critpath.js';

/** The eight geometry phases, in pipeline order. Units: ms. */
export const GEO_PHASE_NAMES = [
  'setup',
  'mark',
  'traverse',
  'cull',
  'cache',
  'project',
  'emit',
  'sort',
] as const;

/** One of the eight geometry phase names. */
export type GeoPhaseName = (typeof GEO_PHASE_NAMES)[number];

/** Eight per-rep geometry phase durations (ms). */
export type GeoPhases = Record<GeoPhaseName, number>;

/**
 * One instrumented rep: the eight GEO phases plus the draw/alias phases and
 * the wall around the same instrumented render. All values are durations on
 * one clock (ms); derived totals reconcile per rep, never across medians.
 */
export interface GeoRep {
  rep: number;
  /** Wall around the instrumented render (same rep as the phases below). */
  wallMs: number;
  phases: GeoPhases;
  /** Spanfill phase (kept for the gap, not mixed into the GEO total). */
  drawMs: number;
  /** Alias/sprite/particle/tracer phase (kept for the gap). */
  aliasMs: number;
  /** Per-rep GEO total: sum of the 8 phases for THIS rep. */
  geoTotalMs: number;
  /**
   * Per-rep gap: wall minus all 10 phase durations for THIS rep
   * (phase-clock slack + uninstrumented regions — GC/allocator/frame
   * bookkeeping inside the wall, never a median subtraction).
   */
  gapMs: number;
}

/** Structural producer shape (`testMeasurePhases()` return). */
interface MeasuredPhases {
  stats: unknown;
  phases: Record<string, unknown>;
}

function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Validate a raw `testMeasurePhases()` return structurally. Returns the ten
 * phase durations when every phase is a finite non-negative number, else
 * null (hook absent or malformed — the caller reports unknown, never zero).
 */
export function readMeasuredPhases(raw: unknown): (GeoPhases & { draw: number; alias: number }) | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const phases = (raw as MeasuredPhases).phases;
  if (typeof phases !== 'object' || phases === null) return null;
  const rec = phases as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const name of [...GEO_PHASE_NAMES, 'draw', 'alias'] as const) {
    const v = rec[name];
    if (!isFiniteNonNegative(v)) return null;
    out[name] = v;
  }
  return out as GeoPhases & { draw: number; alias: number };
}

/** Build one reconciled per-rep record (pure): totals derived per rep. */
export function geoRep(rep: number, wallMs: number, measured: GeoPhases & { draw: number; alias: number }): GeoRep {  let geoTotalMs = 0;
  for (const name of GEO_PHASE_NAMES) geoTotalMs += measured[name];
  const allTotalMs = geoTotalMs + measured.draw + measured.alias;
  return {
    rep,
    wallMs,
    phases: {
      setup: measured.setup, mark: measured.mark, traverse: measured.traverse,
      cull: measured.cull, cache: measured.cache, project: measured.project,
      emit: measured.emit, sort: measured.sort,
    },
    drawMs: measured.draw,
    aliasMs: measured.alias,
    geoTotalMs,
    gapMs: wallMs - allTotalMs,
  };
}

/** Median summary over per-rep records (medians of per-rep values only). */
export interface GeoSummary {
  n: number;
  /** Per-phase medians (diagnostic attribution, never summed). */
  phases: GeoPhases;
  /** Median of the per-rep GEO totals (NOT a sum of phase medians). */
  geoTotalMs: number;
  drawMs: number;
  aliasMs: number;
  /** Median of the per-rep gaps (reconciled per rep first). */
  gapMs: number;
}

/** Summarize instrumented reps (pure): medians over reps, never sums. */
export function summarizeGeoReps(reps: GeoRep[]): GeoSummary {
  const med = (pick: (r: GeoRep) => number): number =>
    summarizeLatencies(reps.map(pick)).med;
  const phases = {} as GeoPhases;
  for (const name of GEO_PHASE_NAMES) phases[name] = med((r) => r.phases[name]);
  return {
    n: reps.length,
    phases,
    geoTotalMs: med((r) => r.geoTotalMs),
    drawMs: med((r) => r.drawMs),
    aliasMs: med((r) => r.aliasMs),
    gapMs: med((r) => r.gapMs),
  };
}

/** One-line GEO ledger (unknown renders as —, never 0). */
export function formatGeoSummary(s: GeoSummary): string {
  if (s.n === 0) return 'geo[n=0: unpublished]';
  const p = s.phases;
  const f = (v: number): string => v.toFixed(2);
  return (
    `geo[n=${s.n} total=${f(s.geoTotalMs)} ` +
    `setup=${f(p.setup)} mark=${f(p.mark)} traverse=${f(p.traverse)} cull=${f(p.cull)} ` +
    `cache=${f(p.cache)} project=${f(p.project)} emit=${f(p.emit)} sort=${f(p.sort)} ` +
    `draw=${f(s.drawMs)} alias=${f(s.aliasMs)} gap=${f(s.gapMs)}]`
  );
}

/**
 * Structural `testMeasurePhases()` probe: run one instrumented rep through
 * the producer hook and reconcile it (wall + per-rep totals + gap). The
 * view/world/entities are passed through untouched (unknown-typed — the
 * producer owns them). Returns null when the hook is absent or malformed
 * (unknown, never zero) or when the wall clock is unavailable. Never throws.
 */
export function collectGeoRep(
  source: object, rep: number, view: unknown, world: unknown, entities: unknown,
): GeoRep | null {
  const rec = source as unknown as {
    testMeasurePhases?(view: unknown, world: unknown, entities: unknown): unknown;
  };
  if (typeof rec.testMeasurePhases !== 'function') return null;
  let wallMs = 0;
  try {
    if (typeof process !== 'undefined' && typeof process.hrtime === 'function') {
      const t0 = process.hrtime.bigint();
      const raw = rec.testMeasurePhases.call(source, view, world, entities);
      wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
      const measured = readMeasuredPhases(raw);
      return measured ? geoRep(rep, wallMs, measured) : null;
    }
    const t0 = Date.now();
    const raw = rec.testMeasurePhases.call(source, view, world, entities);
    wallMs = Date.now() - t0;
    const measured = readMeasuredPhases(raw);
    return measured ? geoRep(rep, wallMs, measured) : null;
  } catch {
    return null;
  }
}
