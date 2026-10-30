// q2-bench GPU-FOLLOW-2C box 5: report-only route-timing mode (measurement only).
//
// Runs the now-complete scene over one FIXED live route — stationary baseline,
// multi-room movement/PVS transitions (translation + turns + strafes through
// doors/lifts), and combat with required effects + viewmodel — and records
// camera positions, visited regions, geometry/effect execution, refresh/vsync,
// p50/p95/p99, and dropped beats. This is NOT an optimization campaign: no
// tuning knobs, no gates, no PASS/FAIL on speed. Numbers are reported with
// the FOLLOW-1 timing vocabulary (see describeTimingKinds in gpu-soak.ts):
// rAF/submission cadence is main-thread work headroom, NOT display refresh;
// framesSubmitted counts real on-canvas GL submissions, NEVER scanout
// presentation; async GPU duration is unknown (no timer query); displayed
// claims on a headless leg are VOID, never passes.
//
// Sampling discipline (never blocks the frame loop): 1 Hz CDP polls read the
// page's `__q2soakState`/`__q2stats`/`__q2soakWork` readers; per-segment
// screenshots (`Page.captureScreenshot`) run ONCE at segment boundaries,
// outside the sampling loop. No per-frame readbacks, no finish/blocking calls
// in the page loop.
//
// No `any` in exported signatures; no DOM; no imports from apps/*.
import {
  cadenceFps,
  countDroppedBeats,
  frameIntervals,
  summarizeFrameTimes,
  type FrameIntervalSummary,
} from './gpu-soak.js';
import {
  formatGpuAcceptanceReport,
  validateDisplayedClaim,
  validateSceneCoverage,
  type GpuAcceptanceVerdict,
} from './gpu-acceptance.js';

/** Fixed live-route segment ids (the route plan is frozen; durations vary). */
export const GPU_ROUTE_SEGMENTS = ['stationary', 'moving', 'combat'] as const;

/** One fixed-route segment id. */
export type GpuRouteSegment = (typeof GPU_ROUTE_SEGMENTS)[number];

/**
 * Scripted CDP input pattern per segment (documentation of record; the
 * runner implements exactly this — page code never drives the route).
 * - stationary: no keys held (loop-advance + submission baseline).
 * - moving (multi-room): W held; every 8 s rotate [straight, +left turn, +right turn,
 *   +strafe-left, +strafe-right] — translation across rooms/PVS changes,
 *   a 180-degree-class turn built from sustained turn holds, door/lift
 *   pushes by collision. Camera/region evidence comes from pos/yaw polls.
 * - combat: W + attack held (verified attack path); alternate turn hold
 *   every 10 s — viewmodel + muzzle/explosion effects while moving.
 */
export const GPU_ROUTE_SCRIPT: Record<GpuRouteSegment, string> = {
  stationary: 'no input held (baseline: loop advance + submission proof)',
  moving: 'hold W; every 8s rotate [W | W+Left | W+Right | W+A | W+D] (translation + turns + strafes; doors/lifts by collision)',
  combat: 'hold W + attack; alternate ArrowLeft/ArrowRight hold every 10s (viewmodel + live effects while moving)',
};

/** One 1 Hz camera/echo poll inside a route segment. */
export interface GpuRouteCameraSample {
  /** Seconds since segment start (wall clock). */
  tS: number;
  /** Raw `pos x y z` text from `__q2soakState` (null when unreadable). */
  pos: string | null;
  /** Yaw degrees from `__q2soakState` (null when unreadable). */
  yawDeg: number | null;
  /** Echoed movement keys (null when unreadable). */
  keys: readonly string[] | null;
  /** Echoed attack buttons bitmask (null when unreadable). */
  buttons: number | null;
  /** GPU framesSubmitted at poll time (null when unobserved/non-GPU). */
  framesSubmitted: number | null;
  /** Persistent uploads at poll time (null when unobserved/non-GPU). */
  uploads: number | null;
}

/** Measured inputs for one route segment (runner-collected). */
export interface GpuRouteSegmentInput {
  segment: GpuRouteSegment;
  durationS: number;
  /** Presented-frame counter at segment start/end (`__q2stats.frame`). */
  frameStart: number;
  frameEnd: number;
  /** rAF timestamp ring slice for the segment (ms). */
  frameStamps: readonly number[];
  /** 1 Hz camera/echo polls. */
  cameras: readonly GpuRouteCameraSample[];
  /** GPU proof-of-submission at segment start/end (null = unobserved). */
  submittedStart: number | null;
  submittedEnd: number | null;
  /** Persistent uploads at segment start/end (null = unobserved). */
  uploadsStart: number | null;
  uploadsEnd: number | null;
  /** Work-split medians for the segment (null = unmeasured). */
  workLine: string | null;
  /** Screenshot path for the segment (null = capture failed). */
  screenshot: string | null;
}

/** Per-segment report (computed from GpuRouteSegmentInput). */
export interface GpuRouteSegmentReport {
  segment: GpuRouteSegment;
  script: string;
  durationS: number;
  frames: string;
  cadenceFps: number | null;
  intervals: FrameIntervalSummary;
  droppedBeats: number;
  /** Camera travel evidence. */
  cameras: number;
  posFirst: string | null;
  posLast: string | null;
  yawFirst: number | null;
  yawLast: number | null;
  yawSpanDeg: number | null;
  distinctCells: number;
  /** Geometry/effect execution evidence. */
  submittedDelta: number | null;
  uploadsLast: number | null;
  workLine: string | null;
  screenshot: string | null;
}

/** Parse `pos x y z` (1-decimal) into components; null when unparseable. */
export function parseRoutePos(pos: string | null): { x: number; y: number; z: number } | null {
  if (typeof pos !== 'string') return null;
  const m = /^pos (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\s*$/.exec(pos.trim());
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  const z = Number(m[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

/**
 * Coarse region-cell key for a camera pos (default 256-unit cells ≈ 21 ft —
 * room-scale, so crossing rooms/PVS boundaries changes cells while jitter
 * within a room does not). Null when the pos is unparseable.
 */
export function regionCellKey(pos: string | null, cellUnits = 256): string | null {
  const p = parseRoutePos(pos);
  if (!p || !(cellUnits > 0)) return null;
  return [p.x, p.y, p.z].map((v) => Math.floor(v / cellUnits).toString()).join(',');
}

/** Distinct region cells visited across camera samples (in first-seen order). */
export function distinctRouteRegions(
  cameras: readonly GpuRouteCameraSample[],
  cellUnits = 256,
): string[] {
  const seen: string[] = [];
  const set = new Set<string>();
  for (const c of cameras) {
    const k = regionCellKey(c.pos, cellUnits);
    if (k !== null && !set.has(k)) {
      set.add(k);
      seen.push(k);
    }
  }
  return seen;
}

/**
 * Minimal angular span covered by yaw samples in degrees: max minus min on
 * the wrapped circle is unknowable from sparse polls, so this reports the
 * unwrapped range (null when fewer than 1 readable yaw). A sustained-turn
 * route must show a span of tens of degrees; a stuck player shows ~0.
 */
export function yawSpanDeg(cameras: readonly GpuRouteCameraSample[]): number | null {
  const yaws: number[] = [];
  for (const c of cameras) {
    if (typeof c.yawDeg === 'number' && Number.isFinite(c.yawDeg)) yaws.push(c.yawDeg);
  }
  if (yaws.length === 0) return null;
  let span = 0;
  let prev = yaws[0] as number;
  for (let i = 1; i < yaws.length; i++) {
    const cur = yaws[i] as number;
    let d = cur - prev;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    span += Math.abs(d);
    prev = cur;
  }
  return span;
}

/** Build the per-segment report (pure; nulls stay null, never fabricated). */
export function buildRouteSegmentReport(input: GpuRouteSegmentInput): GpuRouteSegmentReport {
  const intervals = summarizeFrameTimes(input.frameStamps);
  const first = input.cameras.length > 0 ? input.cameras[0] : undefined;
  const last = input.cameras.length > 0 ? input.cameras[input.cameras.length - 1] : undefined;
  const submittedDelta =
    typeof input.submittedStart === 'number' && typeof input.submittedEnd === 'number'
      ? input.submittedEnd - input.submittedStart
      : null;
  return {
    segment: input.segment,
    script: GPU_ROUTE_SCRIPT[input.segment],
    durationS: input.durationS,
    frames: `${input.frameStart}->${input.frameEnd}`,
    cadenceFps: cadenceFps(input.frameStart, input.frameEnd, input.durationS),
    intervals,
    droppedBeats: countDroppedBeats(frameIntervals(input.frameStamps)),
    cameras: input.cameras.length,
    posFirst: first?.pos ?? null,
    posLast: last?.pos ?? null,
    yawFirst: typeof first?.yawDeg === 'number' ? first.yawDeg : null,
    yawLast: typeof last?.yawDeg === 'number' ? last.yawDeg : null,
    yawSpanDeg: yawSpanDeg(input.cameras),
    distinctCells: distinctRouteRegions(input.cameras).length,
    submittedDelta,
    uploadsLast: typeof input.uploadsEnd === 'number' ? input.uploadsEnd : null,
    workLine: input.workLine,
    screenshot: input.screenshot,
  };
}

/** Whole-route timing rollup over segment reports. */
export interface GpuRouteSummary {
  /**
   * Route duration in seconds: runner wall-clock (includes segment-boundary
   * captures) when supplied, else summed segment durations. The cadence
   * denominator always matches this field — never frames-including-gaps over
   * gaps-excluded time.
   */
  durationS: number;
  cadenceFps: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  droppedBeats: number;
  distinctCells: number;
  yawSpanDeg: number | null;
}

/** Roll up segment reports into whole-route numbers (pure). */
export function summarizeRoute(
  segments: readonly GpuRouteSegmentReport[],
  camerasInOrder: readonly GpuRouteCameraSample[] = [],
  wallDurationS: number | null = null,
): GpuRouteSummary {
  const segDurationS = segments.reduce((s, r) => s + r.durationS, 0);
  // Honest denominator: the frame counter keeps advancing during
  // segment-boundary captures, so cadence must divide by the wall-clock
  // route duration when the runner supplies it — never gap-inclusive
  // frames over gaps-excluded time.
  const durationS =
    typeof wallDurationS === 'number' && Number.isFinite(wallDurationS) && wallDurationS > 0
      ? wallDurationS
      : segDurationS;
  let frameStart = NaN;
  let frameEnd = NaN;
  if (segments.length > 0) {
    const a = /^(\S+)->(\S+)$/.exec(segments[0]!.frames);
    const b = /^(\S+)->(\S+)$/.exec(segments[segments.length - 1]!.frames);
    if (a) frameStart = Number(a[1]);
    if (b) frameEnd = Number(b[2]);
  }
  const nums = (vs: readonly (number | null)[]): number[] =>
    vs.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  // Worst-segment medians: the route is only as smooth as its worst leg.
  // (Report-only upper bounds, never a blended "average smoothness" claim.)
  const max = (vs: number[]): number | null => (vs.length > 0 ? Math.max(...vs) : null);
  return {
    durationS,
    cadenceFps: cadenceFps(frameStart, frameEnd, durationS),
    p50Ms: max(nums(segments.map((r) => r.intervals.p50Ms))),
    p95Ms: max(nums(segments.map((r) => r.intervals.p95Ms))),
    p99Ms: max(nums(segments.map((r) => r.intervals.p99Ms))),
    maxMs: max(nums(segments.map((r) => r.intervals.maxMs))),
    droppedBeats: segments.reduce((s, r) => s + r.droppedBeats, 0),
    // Whole-route distinct cells from the ordered polls (revisits across
    // segments count once); sum-of-segments only when polls are unavailable.
    distinctCells:
      camerasInOrder.length > 0
        ? distinctRouteRegions(camerasInOrder).length
        : segments.reduce((s, r) => s + r.distinctCells, 0),
    yawSpanDeg: yawSpanDeg(camerasInOrder),
  };
}

/**
 * Explicitly worded completed/displayed cadence evidence (load-bearing
 * labels; paste verbatim into reports). `framesSubmittedDelta` is GL
 * submission proof and is NEVER presented as scanout evidence.
 */
export function describeRouteCadenceEvidence(input: {
  completedFrames: number | null;
  durationS: number;
  headless: boolean;
  vsync: boolean | null;
  refreshHz: number | null;
  framesSubmittedDelta: number | null;
}): string {
  const cadence =
    input.completedFrames !== null && input.durationS > 0
      ? `${(input.completedFrames / input.durationS).toFixed(2)} completed frames/s over ${input.durationS.toFixed(1)}s`
      : 'completed-frame cadence unmeasurable (frame counter missing)';
  const submitted =
    input.framesSubmittedDelta === null
      ? 'framesSubmitted unobserved (no GPU submission proof)'
      : input.framesSubmittedDelta > 0
        ? `framesSubmitted advanced by ${input.framesSubmittedDelta} (real on-canvas GL submissions — submission proof ONLY, never scanout presentation)`
        : `framesSubmitted did NOT advance (delta ${input.framesSubmittedDelta} — no GPU execution proven)`;
  const displayed =
    input.headless || input.vsync !== true || input.refreshHz === null
      ? 'displayed/scanout evidence: NONE on this leg (headless and/or vsync unverified and/or refresh unmeasured — completed cadence above is main-thread work headroom, NOT displayed FPS)'
      : `displayed/scanout evidence: visible vsync-locked leg at ${input.refreshHz}Hz (compositor presentation still not directly observed; no scanout claim beyond vsync lock)`;
  return [`completed: ${cadence}.`, `${submitted}.`, `${displayed}.`].join(' ');
}

/**
 * Non-comparative label for multi-leg numbers: legs measured under different
 * renderers, compositors, or browser/headless settings share NO baseline —
 * their medians ride side by side for reporting only and must never be
 * differenced into a speedup/slowdown claim.
 */
export function routeComparabilityNote(
  legs: readonly { renderer: string; glRenderer: string | null; headless: boolean }[],
): string {
  if (legs.length < 2) return 'single-leg route report: no cross-leg comparison applies.';
  const renderers = new Set(legs.map((l) => l.renderer));
  const gls = new Set(legs.map((l) => l.glRenderer ?? '(unprobed)'));
  const heads = new Set(legs.map((l) => (l.headless ? 'headless' : 'visible')));
  const matched = renderers.size === 1 && gls.size === 1 && heads.size === 1;
  if (matched) {
    return 'legs share renderer + GL/compositor string + headless mode: numbers are comparable side-by-side (same settings, same box, sequential runs).';
  }
  return (
    'NON-COMPARATIVE legs (unmatched renderer and/or GL/compositor string and/or headless mode: ' +
    `renderers=[${[...renderers].join('|')}] gl=[${[...gls].join('|')}] mode=[${[...heads].join('|')}]). ` +
    'Per-leg medians are reported side by side ONLY — never difference them into a win/loss claim.'
  );
}

/** Inputs for the whole-route report assembly. */
export interface GpuRouteReportInput {
  renderer: string;
  glRenderer: string | null;
  headless: boolean;
  vsync: boolean | null;
  refreshHz: number | null;
  chromiumFlags: readonly string[];
  cvarsRequested: string;
  warmupS: number;
  attackMethod: string;
  movementEchoOk: boolean;
  segments: readonly GpuRouteSegmentReport[];
  /** All 1 Hz camera polls in route order (whole-route yaw-span proof). */
  camerasInOrder: readonly GpuRouteCameraSample[];
  /** Runner wall-clock route duration in seconds (includes boundary captures). */
  wallDurationS: number | null;
  dateIso: string;
  commitShort: string;
  commitFull: string;
}

/** Whole-route report (JSON-serializable; verdicts computed, never asserted). */
export interface GpuRouteReport {
  kind: 'gpu-route-timings';
  date: string;
  commit: { short: string; full: string };
  renderer: string;
  glRenderer: string | null;
  headless: boolean;
  segments: GpuRouteSegmentReport[];
  summary: GpuRouteSummary;
  coverage: GpuAcceptanceVerdict;
  displayed: GpuAcceptanceVerdict;
  cadenceEvidence: string;
  comparability: string;
  acceptanceReport: string;
}

/**
 * Assemble the whole-route report. Coverage uses first/last submissions and
 * uploads across segments plus per-segment screenshots; displayed uses the
 * leg's headless/vsync/refresh record. Both verdicts are computed by the
 * shared acceptance predicates — this module never hand-rolls PASS/GO.
 */
export function buildRouteReport(input: GpuRouteReportInput): GpuRouteReport {
  const summary = summarizeRoute(input.segments, input.camerasInOrder, input.wallDurationS);
  const lastSeg = input.segments[input.segments.length - 1];
  // Coverage evidence: submission must advance over the whole route; uploads
  // must be observed; every fixed segment needs its screenshot.
  const segList = input.segments;
  let covStart: number | null = null;
  let covEnd: number | null = null;
  let covUploads: number | null = null;
  let shotsOk = true;
  const workloads: string[] = [];
  for (const s of segList) {
    workloads.push(s.segment);
    if (s.screenshot === null) shotsOk = false;
  }
  // submittedDelta sums are not frame-identity comparable across segments,
  // so coverage reuses the combat-segment endpoints when present (the
  // heaviest submission proof) — reported explicitly, never hidden.
  const combat = segList.find((s) => s.segment === 'combat') ?? lastSeg;
  if (combat && combat.submittedDelta !== null) {
    covEnd = combat.submittedDelta;
    covStart = 0;
  }
  const lastWithUploads = [...segList].reverse().find((s) => s.uploadsLast !== null);
  covUploads = lastWithUploads ? lastWithUploads.uploadsLast : null;
  const coverage = validateSceneCoverage({
    framesSubmittedStart: covStart,
    framesSubmittedEnd: covEnd,
    uploads: covUploads,
    screenshotsPresent: shotsOk && segList.length === GPU_ROUTE_SEGMENTS.length,
    workloads,
  });
  const droppedTotal = summary.droppedBeats;
  const displayed = validateDisplayedClaim({
    headless: input.headless,
    vsync: input.vsync,
    refreshHz: input.refreshHz,
    droppedFrames: droppedTotal,
  });
  const completedFrames =
    input.segments.length > 0
      ? (() => {
          const a = /^(\S+)->(\S+)$/.exec(input.segments[0]!.frames);
          const b = /^(\S+)->(\S+)$/.exec(input.segments[input.segments.length - 1]!.frames);
          if (!a || !b) return null;
          const s = Number(a[1]);
          const e = Number(b[2]);
          return Number.isFinite(s) && Number.isFinite(e) ? e - s : null;
        })()
      : null;
  const submittedTotal = segList.reduce(
    (acc: number | null, s) =>
      acc === null || s.submittedDelta === null ? null : acc + s.submittedDelta,
    0 as number | null,
  );
  const cadenceEvidence = describeRouteCadenceEvidence({
    completedFrames,
    durationS: summary.durationS,
    headless: input.headless,
    vsync: input.vsync,
    refreshHz: input.refreshHz,
    framesSubmittedDelta: submittedTotal,
  });
  const acceptanceReport = formatGpuAcceptanceReport({
    fidelity: { fractionDiff: null, maxAbsDelta: null },
    coverage: {
      framesSubmittedStart: covStart,
      framesSubmittedEnd: covEnd,
      uploads: covUploads,
      screenshotsPresent: shotsOk && segList.length === GPU_ROUTE_SEGMENTS.length,
      workloads,
    },
    displayed: {
      headless: input.headless,
      vsync: input.vsync,
      refreshHz: input.refreshHz,
      droppedFrames: droppedTotal,
    },
    headroomLine:
      summary.cadenceFps !== null
        ? `${summary.cadenceFps.toFixed(2)} completed fps, p50<=${summary.p50Ms?.toFixed(2) ?? 'n/a'}ms p95<=${summary.p95Ms?.toFixed(2) ?? 'n/a'}ms (worst-segment medians; report-only, NOT displayed FPS)`
        : 'unmeasurable (frame counters missing)',
  });
  return {
    kind: 'gpu-route-timings',
    date: input.dateIso,
    commit: { short: input.commitShort, full: input.commitFull },
    renderer: input.renderer,
    glRenderer: input.glRenderer,
    headless: input.headless,
    segments: [...input.segments],
    summary,
    coverage,
    displayed,
    cadenceEvidence,
    comparability: routeComparabilityNote([
      { renderer: input.renderer, glRenderer: input.glRenderer, headless: input.headless },
    ]),
    acceptanceReport,
  };
}

/** One-line per-segment numbers for the final report table. */
export function renderRouteTable(segments: readonly GpuRouteSegmentReport[]): string {
  const fmt = (v: number | null, digits = 2): string =>
    v === null || !Number.isFinite(v) ? 'n/a' : v.toFixed(digits);
  const head =
    '| segment | dur(s) | frames | cadence(fps) | p50(ms) | p95(ms) | p99(ms) | dropped | cells | yawSpan(deg) | submitΔ | uploads | shot |';
  const sep = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const rows = segments.map((s) =>
    `| ${s.segment} | ${s.durationS.toFixed(0)} | ${s.frames} ` +
    `| ${fmt(s.cadenceFps)} | ${fmt(s.intervals.p50Ms)} | ${fmt(s.intervals.p95Ms)} | ${fmt(s.intervals.p99Ms)} ` +
    `| ${s.droppedBeats} | ${s.distinctCells} | ${fmt(s.yawSpanDeg, 1)} | ${s.submittedDelta === null ? 'n/a' : s.submittedDelta} ` +
    `| ${s.uploadsLast === null ? 'n/a' : s.uploadsLast} | ${s.screenshot === null ? 'MISS' : 'ok'} |`,
  );
  return [head, sep, ...rows].join('\n');
}
