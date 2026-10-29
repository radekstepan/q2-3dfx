// @q2/testkit — interleaved candidate-A/B helper (PERF-NEXT-6, Lane C).
//
// Compares config X vs config Y back-to-back INTERLEAVED on the same box:
// warm up both legs, then alternate timed reps (A_i, B_i per rep) so both
// legs share thermal state rep-by-rep. Complements (never duplicates)
// compare-run/compare-diff, which diff BASE vs HEAD builds sequentially in
// separate processes: this helper diffs two CONFIGS (e.g. workers 7 vs 3,
// pooled vs serial) of the SAME build in ONE process.
//
// Whole-frame semantics (same as frame-evidence.ts, shared helpers): every
// rep measures the full production frame together on one caller clock with
// the reconciled per-rep split; the per-rep scanout control rides along
// for pooled legs. Settings-match verification voids the comparison when
// the legs are not comparable (dimensions, rep-0 camera, mid-run fidelity
// drift — the scanout-leg shape is the experiment, never a mismatch);
// output parity across legs is REPORTED (worker-count legs must stay
// bit-identical; genuinely different workloads may differ legitimately) —
// never gated.
//
// No renderer import: legs satisfy the structural EvidenceRenderer /
// EvidenceScanout interfaces from frame-evidence.ts (bench builds real
// legs; tests use stubs).
import {
  fnvColorFull,
  fnvIndex,
  type EvidenceRenderer,
  type EvidenceScanout,
  type ProductionRep,
} from './frame-evidence.js';
import { fidelityCvarSnapshot } from './bench-workloads.js';
import {
  frameSplit,
  nsToMs,
  nowNs,
  summarizeLatencies,
} from './critpath.js';

/** One A/B leg: a full production config (cf. MeasureProductionFramesOptions). */
export interface ABLeg {
  label: string;
  renderer: EvidenceRenderer;
  world: Parameters<EvidenceRenderer['renderView']>[1];
  width: number;
  height: number;
  viewFor: (rep: number) => Parameters<EvidenceRenderer['renderView']>[0];
  entitiesFor: (rep: number) => Parameters<EvidenceRenderer['renderView']>[2];
  pump?: (rep: number) => void;
  scanout?: EvidenceScanout | null;
}

/** One interleaved rep pair: same rep index, both legs, shared thermals. */
export interface ABRepPair {
  rep: number;
  aMs: number;
  bMs: number;
  deltaMs: number;
  deltaPct: number | null;
}

/** Interleaved A/B evidence for one leg pair. */
export interface ABPairEvidence {
  labelA: string;
  labelB: string;
  width: number;
  height: number;
  warmup: number;
  reps: number;
  pairs: ABRepPair[];
  medA: number;
  medB: number;
  deltaMedMs: number;
  deltaMedPct: number | null;
  /** False when the legs are not comparable (see mismatchReasons). */
  settingsMatch: boolean;
  mismatchReasons: string[];
  /**
   * Cross-leg output parity on the last rep (color + index + display):
   * true = bit-identical (required for worker-count legs), false = outputs
   * differ (legitimate for different workloads, fatal for same-workload
   * worker sweeps). Null when a leg exposes no comparable plane.
   */
  outputParity: boolean | null;
  /** Per-leg execution proof (false = a number in disguise — never a pass). */
  execProvenA: boolean;
  execProvenB: boolean;
  framesA: ProductionRep[];
  framesB: ProductionRep[];
}

function warmupLeg(leg: ABLeg, warmup: number): Uint32Array | null {
  const serialDisplay = leg.scanout ? new Uint32Array(leg.width * leg.height) : null;
  for (let i = 0; i < warmup; i++) {
    leg.pump?.(i);
    leg.renderer.beginFrame();
    leg.renderer.renderView(leg.viewFor(i), leg.world, leg.entitiesFor(i));
    leg.renderer.endFrame();
    if (leg.scanout && serialDisplay) {
      if (leg.scanout.pool) {
        if (!leg.scanout.pool.flushScanout(leg.scanout.scanoutOpts)) {
          leg.scanout.resolveSerialInto(leg.renderer.getFramebuffer().color, serialDisplay);
        }
      } else {
        leg.scanout.resolveSerialInto(leg.renderer.getFramebuffer().color, serialDisplay);
      }
    }
  }
  return serialDisplay;
}

function timedRep(leg: ABLeg, serialDisplay: Uint32Array | null, rep: number, parityIn: boolean | null): { frame: ProductionRep; parity: boolean | null } {
  leg.pump?.(rep);
  const tF = nowNs();
  let t = nowNs();
  leg.renderer.beginFrame();
  const bM = nsToMs(nowNs() - t);
  t = nowNs();
  leg.renderer.renderView(leg.viewFor(rep), leg.world, leg.entitiesFor(rep));
  const rM = nsToMs(nowNs() - t);
  t = nowNs();
  leg.renderer.endFrame();
  const eM = nsToMs(nowNs() - t);
  t = nowNs();
  let sM = 0;
  let disp: Uint32Array | null = null;
  let pooledFull: string | null = null;
  let serialFull: string | null = null;
  let kind: ProductionRep['scanoutKind'] = 'none';
  let ok = true;
  let parity = parityIn;
  if (leg.scanout && serialDisplay) {
    if (leg.scanout.pool) {
      ok = leg.scanout.pool.flushScanout(leg.scanout.scanoutOpts);
      sM = nsToMs(nowNs() - t);
      if (ok) {
        kind = 'pooled';
        disp = leg.scanout.pool.scanoutPlanes.scanDisplay.slice(0, leg.width * leg.height);
        pooledFull = fnvColorFull(disp);
        leg.scanout.resolveSerialInto(leg.renderer.getFramebuffer().color, serialDisplay);
        serialFull = fnvColorFull(serialDisplay);
        const same = pooledFull === serialFull;
        parity = parity === null ? same : parity && same;
      } else {
        kind = 'serial-fallback';
        const tS = nowNs();
        leg.scanout.resolveSerialInto(leg.renderer.getFramebuffer().color, serialDisplay);
        sM += nsToMs(nowNs() - tS);
        disp = serialDisplay;
        serialFull = fnvColorFull(serialDisplay);
      }
    } else {
      leg.scanout.resolveSerialInto(leg.renderer.getFramebuffer().color, serialDisplay);
      sM = nsToMs(nowNs() - t);
      kind = 'serial';
      disp = serialDisplay;
      serialFull = fnvColorFull(serialDisplay);
    }
  }
  const fM = nsToMs(nowNs() - tF);
  const fb = leg.renderer.getFramebuffer();
  return {
    frame: {
      rep,
      frameMs: fM,
      split: frameSplit(bM, rM, eM, sM, fM),
      indexHash: fb.index ? fnvIndex(fb.index) : null,
      colorFull: fnvColorFull(fb.color),
      displayFull: disp ? fnvColorFull(disp) : null,
      pooledFull,
      serialFull,
      scanoutKind: kind,
      scanoutOk: ok,
    },
    parity,
  };
}

/**
 * Verify two legs are comparable (void otherwise, mirroring
 * compare-diff's settings-match). Dimensions, rep count and the rep-0
 * camera must agree; the live fidelity cvar profile must match (one global
 * profile — a mid-run cvar change voids the pair). The scanout-leg shape
 * (pooled vs serial vs none) is the experiment, never a mismatch.
 */
export function verifyABSettings(legA: ABLeg, legB: ABLeg, reps: number): { settingsMatch: boolean; mismatchReasons: string[] } {
  const reasons: string[] = [];
  if (legA.width !== legB.width || legA.height !== legB.height) {
    reasons.push(`dimensions ${legA.width}x${legA.height} vs ${legB.width}x${legB.height}`);
  }
  if (!Number.isInteger(reps) || reps < 1) reasons.push(`reps=${reps} (need >= 1)`);
  // NOTE: scanout shape (pooled vs serial vs none) is the EXPERIMENT, never
  // a mismatch — pooled-vs-serial of the same workload is the core PERF-NEXT-6
  // question, and pooled-display vs serial-display hashes stay comparable
  // through the per-rep serial control. Leg labels carry the mechanism.
  try {
    const va = legA.viewFor(0);
    const vb = legB.viewFor(0);
    const eq = (a: ArrayLike<number>, b: ArrayLike<number>): boolean =>
      a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
    if (!eq(va.origin, vb.origin) || !eq(va.angles, vb.angles) || va.fovX !== vb.fovX) {
      reasons.push('rep-0 camera differs (origin/angles/fovX)');
    }
  } catch {
    reasons.push('rep-0 view unreadable');
  }
  return { settingsMatch: reasons.length === 0, mismatchReasons: reasons };
}

/** Live fidelity profile snapshot (global cvars — drift mid-run voids the pair). */
export function snapshotFidelity(): Record<string, string> {
  return fidelityCvarSnapshot();
}

/**
 * Measure an interleaved A/B pair SEQUENTIALLY in this process (never
 * concurrent — benchmarks run on a quiet machine). Warmup runs leg by leg;
 * timed reps alternate A_i, B_i per rep index. Returns per-rep paired
 * deltas plus medians, settings verification and output parity.
 */
export function measureABPair(legA: ABLeg, legB: ABLeg, opts: { warmup?: number; reps?: number } = {}): ABPairEvidence {
  const warmup = opts.warmup ?? 3;
  const reps = opts.reps ?? 5;
  const fidelityBefore = snapshotFidelity();
  const { settingsMatch: shapeMatch, mismatchReasons } = verifyABSettings(legA, legB, reps);
  const serialA = warmupLeg(legA, warmup);
  const serialB = warmupLeg(legB, warmup);
  const framesA: ProductionRep[] = [];
  const framesB: ProductionRep[] = [];
  let parityA: boolean | null = null;
  let parityB: boolean | null = null;
  let fallbacksA = 0, fallbacksB = 0;
  for (let i = 0; i < reps; i++) {
    const ra = timedRep(legA, serialA, i, parityA);
    parityA = ra.parity;
    if (ra.frame.scanoutKind === 'serial-fallback') fallbacksA++;
    framesA.push(ra.frame);
    const rb = timedRep(legB, serialB, i, parityB);
    parityB = rb.parity;
    if (rb.frame.scanoutKind === 'serial-fallback') fallbacksB++;
    framesB.push(rb.frame);
  }
  const pairs: ABRepPair[] = framesA.map((fa, i) => {    const fb = framesB[i]!;
    const deltaMs = fb.frameMs - fa.frameMs;
    return {
      rep: i, aMs: fa.frameMs, bMs: fb.frameMs, deltaMs,
      deltaPct: fa.frameMs > 0 ? (deltaMs / fa.frameMs) * 100 : null,
    };
  });
  const latA = summarizeLatencies(framesA.map((f) => f.frameMs));
  const latB = summarizeLatencies(framesB.map((f) => f.frameMs));
  const deltaMedMs = latB.med - latA.med;
  // Fidelity drift check: the cvar profile is global — a mid-run change
  // (leaked pinPerfCvars, a concurrent writer) voids the pair.
  const fidelityAfter = snapshotFidelity();
  const drifted = Object.keys(fidelityBefore).filter((k) => fidelityBefore[k] !== fidelityAfter[k]);
  for (const k of drifted) mismatchReasons.push(`fidelity drift mid-run: ${k} (${fidelityBefore[k]} -> ${fidelityAfter[k]})`);
  const settingsMatch = shapeMatch && drifted.length === 0;
  const lastA = framesA[framesA.length - 1]!;
  const lastB = framesB[framesB.length - 1]!;
  const samePlanes =
    lastA.indexHash !== null && lastB.indexHash !== null &&
    lastA.displayFull !== null && lastB.displayFull !== null;
  const outputParity = !samePlanes ? null : (
    lastA.indexHash === lastB.indexHash &&
    lastA.colorFull === lastB.colorFull &&
    lastA.displayFull === lastB.displayFull
  );
  const pooledA = framesA.some((f) => f.scanoutKind === 'pooled');
  const pooledB = framesB.some((f) => f.scanoutKind === 'pooled');
  return {
    labelA: legA.label, labelB: legB.label,
    width: legA.width, height: legA.height, warmup, reps, pairs,
    medA: latA.med, medB: latB.med,
    deltaMedMs, deltaMedPct: latA.med > 0 ? (deltaMedMs / latA.med) * 100 : null,
    settingsMatch, mismatchReasons, outputParity,
    execProvenA: legA.scanout?.pool ? pooledA && fallbacksA === 0 : true,
    execProvenB: legB.scanout?.pool ? pooledB && fallbacksB === 0 : true,
    framesA, framesB,
  };
}

/** One-line A/B ledger (paired medians + settings verdict + output parity). */
export function formatABEvidence(e: ABPairEvidence): string {
  const d = e.deltaMedPct === null ? 'n/a' : `${e.deltaMedPct >= 0 ? '+' : ''}${e.deltaMedPct.toFixed(1)}%`;
  const parity = e.outputParity === null ? 'parity=n/a' : `parity=${e.outputParity ? 'SAME' : 'DIFFER'}`;
  const exec = `execA=${e.execProvenA ? 'proven' : 'UNPROVEN'} execB=${e.execProvenB ? 'proven' : 'UNPROVEN'}`;
  return (
    `ab ${e.labelA}=${e.medA.toFixed(2)}ms vs ${e.labelB}=${e.medB.toFixed(2)}ms ` +
    `Δ=${e.deltaMedMs >= 0 ? '+' : ''}${e.deltaMedMs.toFixed(2)}ms (${d}) ` +
    `settings=${e.settingsMatch ? 'MATCH' : `MISMATCH(${e.mismatchReasons.join('; ')})`} ` +
    `${parity} ${exec}`
  );
}
