// q2-bench GPU-PROOF-1 lane: performance-acceptance schema + Node baseline.
//
// GPU-PROOF-1 (BRAIN.md §8) predeclares the browser performance gate BEFORE
// any GPU implementation exists: 640×480 internal, normal fidelity, the
// fixed proof route, hardware-backed browser; ≤16 ms median complete-frame
// work, ≥59 completed FPS on a nominal 60 Hz display, p95 frame interval
// ≤20 ms; refresh rate / vsync / dropped frames recorded; no CPU fallback
// counted as GPU success.
//
// This module is the bench lane's half of that card:
//
//   - the gate constant (thresholds + resolution + hardware requirement),
//   - the FUTURE hardware-backed browser record schema + strict validator
//     + gate report formatter (no browser leg runs in this lane yet),
//   - the Node CPU baseline summarizer for the fixed proof route.
//
// Supplement-vs-gate rule (load-bearing, repeated in the report formatter):
// Node legs SUPPLEMENT but NEVER satisfy the hardware-backed browser gate.
// Node frameMs is production-frame-no-present on the caller clock; browser
// presented-FPS is a compositor metric. The two must never be mixed, and a
// CPU fallback during a GPU leg VOIDS the leg (it is not a GPU success).
//
// The testkit lane owns the canonical proof route
// (packages/testkit/src/gpu-proof.ts). The route constants below DUPLICATE
// that definition by value so this leaf never imports testkit browser/DOM
// modules; if the canonical route moves, update these values in the same PR.
// tools/* are leaves: nothing here imports from apps/*.
import type { AttrLike, BrowserSoakRecord } from './evidence.js';

/** GPU-PROOF-1 acceptance resolution (internal render size, both legs). */
export const GPU_PROOF_WIDTH = 640;
export const GPU_PROOF_HEIGHT = 480;
export const GPU_PROOF_RESOLUTION = '640x480' as const;

/**
 * vd_* fidelity keys for the proof profile. Duplicated by value from
 * tools/bench/src/evidence.ts (VD_KEYS) — update together.
 */
export const GPU_PROOF_VD_KEYS: readonly string[] = [
  'vd_gamma', 'vd_lodbias', 'vd_dither', 'vd_postfilter', 'vd_fog',
  'vd_16bit', 'vd_bilinear', 'vd_mipdither', 'vd_overbright', 'vd_palettetex',
  'vd_maxtexsize', 'vd_zbits', 'vd_dithermode', 'vd_reconmode', 'vd_rgbmaxdelta',
];

/**
 * sw_* keys for the proof profile. Duplicated by value from
 * tools/bench/src/evidence.ts (SW_KEYS) — update together.
 */
export const GPU_PROOF_SW_KEYS: readonly string[] = ['sw_workers', 'sw_accum'];

/** Combined pinned-profile key list (vd_* + sw_*). */
export const GPU_PROOF_FIDELITY_KEYS: readonly string[] = [...GPU_PROOF_VD_KEYS, ...GPU_PROOF_SW_KEYS];

/** Pinned LOD bias for the proof profile (matches bench pinPerfCvars). */
export const GPU_PROOF_LODBIAS = '-0.35';

/**
 * Fixed proof camera (spawn-north). Duplicated by value from the canonical
 * testkit route: origin [128,-320,54], yaw 90, time 1.5, fov 90, 640×480.
 */
export const GPU_PROOF_ORIGIN: readonly [number, number, number] = [128, -320, 54];
export const GPU_PROOF_YAW_DEG = 90;
export const GPU_PROOF_TIME_S = 1.5;
export const GPU_PROOF_FOV_X = 90;

/** One of the three fixed proof frames (F0 stationary, F1 combat, F2 moving combat). */
export interface GpuProofFrame {
  /** Frame index (0, 1, 2). */
  index: 0 | 1 | 2;
  label: 'stationary' | 'combat' | 'moving-combat';
  /** Yaw offset in degrees relative to GPU_PROOF_YAW_DEG. */
  yawOffsetDeg: number;
  /** True when the combat entity set (gun + dlights + particles) is staged. */
  combat: boolean;
}

/**
 * The three fixed proof frames, duplicated by value from the canonical
 * testkit route (packages/testkit/src/gpu-proof.ts):
 * F0 stationary, F1 combat (gun + muzzle/boom dlights + particles),
 * F2 moving combat (same combat set, yaw +6 deg).
 */
export const GPU_PROOF_FRAMES: readonly GpuProofFrame[] = [
  { index: 0, label: 'stationary', yawOffsetDeg: 0, combat: false },
  { index: 1, label: 'combat', yawOffsetDeg: 0, combat: true },
  { index: 2, label: 'moving-combat', yawOffsetDeg: 6, combat: true },
];

/** Perf route: 60-frame moving-combat sweep, 1 deg yaw step per frame. */
export const GPU_PROOF_PERF_FRAMES = 60;
export const GPU_PROOF_PERF_YAW_STEP_DEG = 1;

/**
 * GPU-PROOF-1 performance gate (box 6, predeclared before optimization).
 * Median complete-frame work ≤16 ms, completed-frame cadence ≥59 FPS on a
 * nominal 60 Hz display, p95 frame interval ≤20 ms — all on a
 * hardware-backed browser at 640×480. Node numbers can never satisfy this.
 */
export interface GpuProofGate {
  medianFrameMsMax: 16;
  minFps: 59;
  p95FrameIntervalMsMax: 20;
  resolution: '640x480';
  hardwareBackedRequired: true;
}

/** The predeclared gate constant. */
export const GPU_PROOF_GATE: GpuProofGate = {
  medianFrameMsMax: 16,
  minFps: 59,
  p95FrameIntervalMsMax: 20,
  resolution: '640x480',
  hardwareBackedRequired: true,
};

/**
 * Browser record for the FUTURE hardware-backed GPU leg. Extends the
 * BrowserSoakRecord shape (tools/bench/src/evidence.ts) with the
 * proof-specific narrowing plus the fields the gate needs:
 *
 * - compositor is exactly 'hardware' (swiftshader/software/unknown void it),
 * - hardwareBacked is exactly true (a CPU fallback is not a GPU success),
 * - renderer is exactly 'webgl2-experimental',
 * - resolution is exactly 640x480,
 * - workloads cover stationary, moving AND combat intervals,
 * - refreshHz: measured display refresh rate in Hz (gate cadence anchor),
 * - vsync: true when vsync-locked presentation was verified for the leg,
 * - droppedFrames: dropped/skipped presented frames over the soak,
 * - cpuFallback: true when ANY frame fell back to CPU rendering — a GPU leg
 *   with cpuFallback set VOIDS the leg (see the validator + report).
 */
export interface GpuProofBrowserRecord extends BrowserSoakRecord {
  compositor: 'hardware';
  hardwareBacked: true;
  renderer: 'webgl2-experimental';
  resolution: '640x480';
  width: 640;
  height: 480;
  /** Measured display refresh rate in Hz (e.g. 60). */
  refreshHz: number;
  /** True when vsync-locked presentation was verified for this leg. */
  vsync: boolean;
  /** Dropped/skipped presented frames over the soak (≥ 0). */
  droppedFrames: number;
  /** Any CPU-fallback frame voids the GPU leg — must be false to pass. */
  cpuFallback: boolean;
}

/** Measured browser-leg numbers compared against GPU_PROOF_GATE. */
export interface GpuProofGateMeasurement {
  /** Median complete-frame work in ms (null = unmeasured). */
  medianFrameMs: number | null;
  /** Completed-frame cadence in FPS (null = unmeasured). */
  completedFps: number | null;
  /** p95 presented-frame interval in ms (null = unmeasured). */
  p95FrameIntervalMs: number | null;
}

/**
 * Strict validator for the FUTURE hardware-backed browser leg. Rejects:
 * non-objects, compositor != 'hardware' (swiftshader/software/unknown each
 * named explicitly), hardwareBacked != true, resolution != 640x480 (or
 * width/height mismatch), renderer != 'webgl2-experimental', missing or
 * non-positive refreshHz, non-boolean vsync, negative/non-integer
 * droppedFrames, cpuFallback != false (a fallback voids the leg), and
 * missing browser identity / workload coverage. Explicit errors, no throws.
 */
export function validateGpuProofBrowserRecord(v: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof v !== 'object' || v === null) return { ok: false, errors: ['record must be an object'] };
  const r = v as Record<string, unknown>;
  const str = (k: string): string | null =>
    typeof r[k] === 'string' && (r[k] as string).length > 0 ? (r[k] as string) : null;
  if (r['compositor'] !== 'hardware') {
    errors.push(`compositor must be 'hardware' for the GPU proof leg (got ${JSON.stringify(r['compositor'])}: no CPU fallback counts as GPU success)`);
  }
  if (r['hardwareBacked'] !== true) {
    errors.push('hardwareBacked must be true for the GPU proof leg (software/headless compositing supplements but never satisfies the gate)');
  }
  if (r['cpuFallback'] !== false) {
    errors.push('cpuFallback must be false for the GPU proof leg (any CPU fallback during a GPU leg voids the leg)');
  }
  const b = r['browser'];
  if (typeof b !== 'object' || b === null) {
    errors.push('browser {name, version, headless} required');
  } else {
    const bb = b as Record<string, unknown>;
    if (typeof bb['name'] !== 'string' || bb['name'].length === 0) errors.push('browser.name required');
    if (typeof bb['version'] !== 'string' || bb['version'].length === 0) {
      errors.push('browser.version required (record the exact build)');
    }
    if (typeof bb['headless'] !== 'boolean') errors.push('browser.headless must be boolean');
  }
  const w = r['width'];
  const h = r['height'];
  if (w !== GPU_PROOF_WIDTH || h !== GPU_PROOF_HEIGHT) {
    errors.push(`width/height must be ${GPU_PROOF_WIDTH}x${GPU_PROOF_HEIGHT} (got ${String(w)}x${String(h)})`);
  }
  if (r['resolution'] !== GPU_PROOF_RESOLUTION) {
    errors.push(`resolution must be '${GPU_PROOF_RESOLUTION}' (got ${JSON.stringify(r['resolution'])})`);
  }
  if (r['renderer'] !== 'webgl2-experimental') {
    errors.push(`renderer must be 'webgl2-experimental' (got ${JSON.stringify(r['renderer'])})`);
  }
  const refreshHz = r['refreshHz'];
  if (typeof refreshHz !== 'number' || !Number.isFinite(refreshHz) || refreshHz <= 0) {
    errors.push('refreshHz required: measured display refresh rate in Hz (must be a finite number > 0)');
  }
  if (typeof r['vsync'] !== 'boolean') {
    errors.push('vsync required: boolean recording whether vsync-locked presentation was verified');
  }
  const dropped = r['droppedFrames'];
  if (typeof dropped !== 'number' || !Number.isInteger(dropped) || dropped < 0) {
    errors.push('droppedFrames required: non-negative integer count over the soak');
  }
  const workloads = r['workloads'];
  if (!Array.isArray(workloads)) {
    errors.push('workloads must be an array covering stationary, moving and combat intervals');
  } else {
    for (const need of ['stationary', 'moving', 'combat']) {
      if (!workloads.includes(need)) errors.push(`workloads must include '${need}'`);
    }
  }
  if (str('date') === null || Number.isNaN(Date.parse(str('date') as string))) {
    errors.push('date must be ISO');
  }
  return { ok: errors.length === 0, errors };
}

function fmtM(v: number | null): string {
  return v === null ? 'n/a' : `${v.toFixed(2)}ms`;
}

function fmtF(v: number | null): string {
  return v === null ? 'n/a' : `${v.toFixed(2)}fps`;
}

/**
 * Render the gate verdict for one hardware-backed browser leg. A leg whose
 * record fails validation (wrong compositor, CPU fallback, wrong
 * resolution, missing refresh/vsync info) reports VOID, never a pass.
 * Node baselines are cited as supplements only — they cannot satisfy this
 * gate by construction (see the supplement-vs-gate rule above).
 */
export function formatGpuProofGateReport(
  record: GpuProofBrowserRecord,
  measured: GpuProofGateMeasurement,
): string {
  const check = validateGpuProofBrowserRecord(record);
  const head = `gpu-proof gate @${GPU_PROOF_RESOLUTION} hw-backed webgl2-experimental`;
  if (!check.ok) {
    return [
      `${head}: VOID (record invalid — no CPU fallback counts as GPU success)`,
      ...check.errors.map((e) => `  - ${e}`),
      'Node CPU baselines supplement but NEVER satisfy this gate.',
    ].join('\n');
  }
  const lines: string[] = [head];
  const medOk = measured.medianFrameMs !== null && measured.medianFrameMs <= GPU_PROOF_GATE.medianFrameMsMax;
  const fpsOk = measured.completedFps !== null && measured.completedFps >= GPU_PROOF_GATE.minFps;
  const p95Ok =
    measured.p95FrameIntervalMs !== null && measured.p95FrameIntervalMs <= GPU_PROOF_GATE.p95FrameIntervalMsMax;
  lines.push(
    `  median complete-frame ${fmtM(measured.medianFrameMs)} <= ${GPU_PROOF_GATE.medianFrameMsMax}ms: ${medOk ? 'PASS' : 'FAIL'}`,
    `  completed cadence ${fmtF(measured.completedFps)} >= ${GPU_PROOF_GATE.minFps}fps: ${fpsOk ? 'PASS' : 'FAIL'}`,
    `  p95 frame interval ${fmtM(measured.p95FrameIntervalMs)} <= ${GPU_PROOF_GATE.p95FrameIntervalMsMax}ms: ${p95Ok ? 'PASS' : 'FAIL'}`,
    `  refresh ${record.refreshHz}Hz vsync=${String(record.vsync)} dropped=${record.droppedFrames} cpuFallback=${String(record.cpuFallback)}`,
  );
  const pass = medOk && fpsOk && p95Ok;
  lines.push(
    `verdict: ${pass ? 'PASS' : 'FAIL'} (hardware-backed browser leg only; Node CPU baselines supplement but NEVER satisfy this gate)`,
  );
  return lines.join('\n');
}

/** Node CPU baseline medians for the proof route at 640×480 (supplement only). */
export interface GpuProofNodeSummary {
  swFixedSerial640: number | null;
  rgbFixedSerial640: number | null;
  rgbCombatPooled640: number | null;
}

/**
 * Find one stationary row by (res, mode, entities, workers). Duplicated by
 * value from tools/bench/src/evidence.ts (findAttr) — zero runtime imports.
 */
function gpuProofFind(
  rows: ReadonlyArray<AttrLike>,
  res: string, mode: string, ent: string, workers: number,
): AttrLike | undefined {
  return rows.find((r) => r.res === res && r.mode === mode && r.entities === ent && r.workers === workers);
}

/**
 * Node CPU baseline summary over stationary rows: acceptance-config medians
 * (640×480 software fixed serial, rgb fixed serial, rgb combat pooled-max).
 * Logic duplicated by value from summarizeAttrRows (tools/bench/src/evidence.ts)
 * so this module keeps zero runtime imports (no import cycle risk).
 *
 * These numbers are production-frame-no-present and SUPPLEMENT the proof:
 * they never satisfy the hardware-backed browser gate and must never be
 * mixed with browser presented-FPS.
 */
export function summarizeGpuProofNode(rows: ReadonlyArray<AttrLike>): GpuProofNodeSummary {
  const maxW = rows.reduce((m, r) => Math.max(m, r.workers), 0);
  const a = gpuProofFind(rows, '640x480', 'software', 'fixed', 0);
  const c = gpuProofFind(rows, '640x480', 'rgb', 'fixed', 0);
  const p = gpuProofFind(rows, '640x480', 'rgb', 'combat', maxW);
  return {
    swFixedSerial640: a?.frameMs ?? null,
    rgbFixedSerial640: c?.frameMs ?? null,
    rgbCombatPooled640: p?.frameMs ?? null,
  };
}
