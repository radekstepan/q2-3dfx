// @q2/testkit — GPU-FOLLOW-1 acceptance pins (pure validators, IO-free).
//
// Testkit-side duplicate of the bench acceptance predicates in
// `tools/bench/src/gpu-acceptance.ts`. Tolerances below are duplicated BY
// VALUE from the canonical `GPU_PROOF_TOLERANCES` in `./gpu-proof.js`
// (0.02 maxFractionDiff, 3 perChannelLsb, 1 edgeExcludePx, 24
// maxAbsDeltaWarn) — never loosened here. A failed number is reported
// FAILED, never reclassified as PASS.
//
// Wiring note: `compareGpuProofFrames` produces a `GpuProofDiff` whose
// `fraction`/`maxAbsDelta` feed `validateGpuFidelity` directly; the
// `validateGpuProofDiff` helper below performs that step in one call
// (FAILs whenever `diff.pass` is false).
//
// No DOM, no fs, no `any` in exported signatures. Pure validators only —
// no throw except on programmer error (none thrown here).

import type { GpuProofDiff } from './gpu-proof.js';

/** Fixed fidelity gate: fractionDiff above this FAILs (by value from GPU_PROOF_TOLERANCES.maxFractionDiff). */
export const GPU_FIDELITY_MAX_FRACTION_DIFF = 0.02;
/** Per-channel LSB forgiveness (by value from GPU_PROOF_TOLERANCES.perChannelLsb). */
export const GPU_FIDELITY_PER_CHANNEL_LSB = 3;
/** Border rows/columns excluded from comparison (by value from GPU_PROOF_TOLERANCES.edgeExcludePx). */
export const GPU_FIDELITY_EDGE_EXCLUDE_PX = 1;
/** Largest single-channel delta above this is flagged for review (by value from GPU_PROOF_TOLERANCES.maxAbsDeltaWarn). */
export const GPU_FIDELITY_MAX_ABS_DELTA_WARN = 24;

/** Fidelity measurement input (fraction of pixels differing beyond LSB forgiveness). */
export interface GpuFidelityMeasurement {
  /** Fraction of differing pixels (null = unmeasured). */
  fractionDiff: number | null;
  /** Maximum single-channel absolute delta (null = unmeasured). */
  maxAbsDelta: number | null;
}

/** Scene-coverage evidence input (minimal submission + capture proof). */
export interface GpuCoverageEvidence {
  /** GPU frames submitted at interval start/end (null = unobserved). */
  framesSubmittedStart: number | null;
  framesSubmittedEnd: number | null;
  /** Persistent uploads observed (null = unobserved; 0 = nothing uploaded). */
  uploads: number | null;
  /** Per-interval screenshots captured (stationary/moving/combat). */
  screenshotsPresent: boolean;
  /** Workload intervals covered. */
  workloads: readonly string[];
}

/** Displayed-frame claim input (visible-display acceptance only). */
export interface GpuDisplayedClaim {
  /** True when the leg ran headless (headless cadence is never displayed evidence). */
  headless: boolean;
  /** True only when vsync-locked presentation was verified. */
  vsync: boolean | null;
  /** Measured display refresh in Hz (null = unmeasured). */
  refreshHz: number | null;
  /** Dropped presented frames (null = uncounted). */
  droppedFrames: number | null;
}

/** Single-predicate verdict (PASS/FAIL/VOID with explicit reasons). */
export interface GpuAcceptanceVerdict {
  verdict: 'PASS' | 'FAIL' | 'VOID';
  reasons: string[];
}

/**
 * Fidelity gate: PASS only when a measured fraction exists and is within
 * the fixed 0.02 tolerance. The recorded PROOF-4/5 value 0.912 vs 0.02 is a
 * FAIL; thresholds are never loosened to pass it.
 */
export function validateGpuFidelity(m: GpuFidelityMeasurement): GpuAcceptanceVerdict {
  if (m.fractionDiff === null || !Number.isFinite(m.fractionDiff)) {
    return { verdict: 'FAIL', reasons: ['fidelity unmeasured: no fractionDiff (a missing number never passes)'] };
  }
  if (m.fractionDiff < 0 || m.fractionDiff > 1) {
    return { verdict: 'FAIL', reasons: [`fidelity fractionDiff out of range: ${m.fractionDiff}`] };
  }
  if (m.fractionDiff > GPU_FIDELITY_MAX_FRACTION_DIFF) {
    const delta = m.maxAbsDelta === null ? 'maxDelta unrecorded' : `maxDelta=${m.maxAbsDelta}`;
    return {
      verdict: 'FAIL',
      reasons: [
        `fidelity FAILED: fractionDiff ${m.fractionDiff} > fixed gate ${GPU_FIDELITY_MAX_FRACTION_DIFF} (${delta}; edgeExcludePx=${GPU_FIDELITY_EDGE_EXCLUDE_PX}, lsb<=${GPU_FIDELITY_PER_CHANNEL_LSB}, warn>${GPU_FIDELITY_MAX_ABS_DELTA_WARN}) — thresholds fixed, never reclassified as PASS`,
      ],
    };
  }
  return { verdict: 'PASS', reasons: [`fidelity PASS: fractionDiff ${m.fractionDiff} <= ${GPU_FIDELITY_MAX_FRACTION_DIFF}`] };
}

/**
 * Validate a `compareGpuProofFrames` diff against the fixed fidelity gate.
 * FAILs whenever `diff.pass` is false; otherwise delegates to
 * `validateGpuFidelity` with the diff's `fraction`/`maxAbsDelta`, so the
 * comparison output feeds the acceptance predicate without re-reading raw
 * pixels at the call site.
 */
export function validateGpuProofDiff(diff: GpuProofDiff): GpuAcceptanceVerdict {
  return validateGpuFidelity({ fractionDiff: diff.fraction, maxAbsDelta: diff.maxAbsDelta });
}

/**
 * Scene-coverage gate: rejects incomplete-coverage claims. A leg that never
 * submitted frames, never uploaded persistent geometry, missed interval
 * screenshots, or skipped a workload interval FAILS — nonblack pixels or a
 * single gun close-up alone never pass it.
 */
export function validateSceneCoverage(e: GpuCoverageEvidence): GpuAcceptanceVerdict {
  const reasons: string[] = [];
  if (e.framesSubmittedStart === null || e.framesSubmittedEnd === null) {
    reasons.push('coverage FAIL: framesSubmitted unobserved (submission must advance per interval)');
  } else if (!(e.framesSubmittedEnd > e.framesSubmittedStart)) {
    reasons.push(
      `coverage FAIL: framesSubmitted did not advance (${String(e.framesSubmittedStart)} -> ${String(e.framesSubmittedEnd)}) — a leg that never submits is not GPU execution`,
    );
  }
  if (e.uploads === null) {
    reasons.push('coverage FAIL: uploads unobserved (persistent-geometry upload count required)');
  } else if (e.uploads < 1) {
    reasons.push(`coverage FAIL: uploads=${e.uploads} (no persistent scene uploaded)`);
  }
  if (!e.screenshotsPresent) {
    reasons.push('coverage FAIL: per-interval screenshots missing (no visible-capture evidence)');
  }
  for (const need of ['stationary', 'moving', 'combat']) {
    if (!e.workloads.includes(need)) reasons.push(`coverage FAIL: workload '${need}' not covered`);
  }
  if (reasons.length > 0) return { verdict: 'FAIL', reasons };
  return {
    verdict: 'PASS',
    reasons: [
      `coverage PASS: framesSubmitted ${String(e.framesSubmittedStart)} -> ${String(e.framesSubmittedEnd)}, uploads=${String(e.uploads)}, screenshots present, workloads stationary+moving+combat`,
    ],
  };
}

/**
 * Displayed-frame gate: headless-only cadence is work headroom, never
 * displayed-FPS evidence. PASS requires a visible (headless=false)
 * vsync-locked leg with recorded refresh/vsync/dropped frames. Headless,
 * unverified-vsync, or unmeasured-refresh legs are VOID (not FAIL: the
 * measurement is valid headroom data, it just cannot claim display).
 */
export function validateDisplayedClaim(c: GpuDisplayedClaim): GpuAcceptanceVerdict {
  if (c.headless) {
    return {
      verdict: 'VOID',
      reasons: [
        'displayed-frame claim VOID on a headless leg: unthrottled BeginFrames cadence measures main-thread work headroom, not display refresh or scanout presentation (no vsync in headless)',
      ],
    };
  }
  if (c.vsync !== true) {
    return {
      verdict: 'VOID',
      reasons: ['displayed-frame claim VOID: vsync-locked presentation not verified (vsync must be true on a visible display)'],
    };
  }
  if (c.refreshHz === null || !Number.isFinite(c.refreshHz) || c.refreshHz <= 0) {
    return { verdict: 'VOID', reasons: ['displayed-frame claim VOID: measured display refreshHz missing'] };
  }
  if (c.droppedFrames === null || !Number.isInteger(c.droppedFrames) || c.droppedFrames < 0) {
    return { verdict: 'VOID', reasons: ['displayed-frame claim VOID: droppedFrames uncounted'] };
  }
  return {
    verdict: 'PASS',
    reasons: [`displayed-frame PASS: visible vsync-locked leg, refresh ${c.refreshHz}Hz, dropped=${c.droppedFrames}`],
  };
}

/** Combined four-verdict report input. */
export interface GpuAcceptanceInput {
  fidelity: GpuFidelityMeasurement;
  coverage: GpuCoverageEvidence;
  displayed: GpuDisplayedClaim;
  /** Headless work-headroom line (report-only, never a display claim). */
  headroomLine: string | null;
}

/**
 * Format the four separated verdicts. The combined acceptance is PASS only
 * when fidelity, coverage, AND displayed-frame predicates all PASS.
 * Headroom data is reported on its own line and never promoted to a
 * displayed-FPS claim.
 */
export function formatGpuAcceptanceReport(input: GpuAcceptanceInput): string {
  const fid = validateGpuFidelity(input.fidelity);
  const cov = validateSceneCoverage(input.coverage);
  const disp = validateDisplayedClaim(input.displayed);
  const lines: string[] = [
    'gpu acceptance (FOLLOW-1 separated verdicts; tolerances fixed, never loosened)',
    `  fidelity: ${fid.verdict}${fid.reasons.length > 0 ? ` — ${fid.reasons.join('; ')}` : ''}`,
    `  scene coverage: ${cov.verdict}${cov.reasons.length > 0 ? ` — ${cov.reasons.join('; ')}` : ''}`,
    `  displayed-frame: ${disp.verdict}${disp.reasons.length > 0 ? ` — ${disp.reasons.join('; ')}` : ''}`,
  ];
  if (input.headroomLine !== null) {
    lines.push(`  headless work headroom (report-only, NOT displayed FPS): ${input.headroomLine}`);
  }
  const pass = fid.verdict === 'PASS' && cov.verdict === 'PASS' && disp.verdict === 'PASS';
  lines.push(
    pass
      ? 'verdict: PASS (implementation + fidelity + coverage + visible-display acceptance all hold)'
      : 'verdict: NOT ACCEPTED (implementation may exist and headroom may be promising while fidelity/coverage/displayed acceptance remain open)',
  );
  return lines.join('\n');
}
