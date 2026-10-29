// @q2/testkit — GPU-PROOF-1 lane: deterministic GPU proof route + CPU
// reference capture harness + image-difference metrics.
//
// The GPU fidelity contract is declared here BEFORE any GPU result exists:
// a fixed real base1 camera plus a short deterministic movement/combat
// route (gun, lightmaps, dynamic lights, overlapping transparent surfaces),
// the pinned fidelity profile, and the comparison tolerances. CPU-to-CPU
// parity stays exact (full-RGBA hash equality via fnvColorFull); the
// tolerances below are REVIEW GATES for GPU-vs-CPU display comparison only
// and never auto-pass unexplained differences — human side-by-side review
// of gun, silhouettes, seams, fog and transparency is required.
//
// Fidelity profile: shared BY REFERENCE with the bench profile
// (GPU_PROOF_FIDELITY_CVARS === BENCH_FIDELITY_CVARS). Never diverged,
// never copied by value: if the bench lane moves the profile, the proof
// route moves with it in the same change and reference hashes are
// re-recorded.
//
// This module is IO-free (no fs): slot path helpers build the layout and
// writeGpuProofReference serializes through an injected writer, so the
// Node-only fs writes stay in the test file and the browser bundle stays
// DOM-free.

import type { Entity, RefDef } from '@q2/renderer-api';
import type { SoftwareRenderer } from '@q2/sw-renderer';
import {
  BENCH_FIDELITY_CVARS,
  benchSpawnOrigin,
  benchSpawnView,
  benchSpawnYaw,
  combatBenchEntities,
  fixedBenchEntities,
  pumpBenchLights,
  type BenchWorld,
} from './bench-workloads.js';
import { fnvColorFull } from './frame-evidence.js';

/** GPU proof acceptance resolution (matches the bench acceptance size). */
export const GPU_PROOF_WIDTH = 640;
/** GPU proof acceptance resolution (matches the bench acceptance size). */
export const GPU_PROOF_HEIGHT = 480;
/** Fixed field of view shared by every proof frame. */
export const GPU_PROOF_FOV = 90;

/**
 * Pinned fidelity profile for the proof route. Shared BY REFERENCE with
 * the bench profile — never diverged, never copied by value.
 */
export const GPU_PROOF_FIDELITY_CVARS: Record<string, string> = BENCH_FIDELITY_CVARS;

/** Proof workloads: subset of the bench workload vocabulary. */
export type GpuProofWorkload = 'stationary' | 'combat' | 'moving';

/** One deterministic proof frame: pure function of its route index. */
export interface GpuProofFrame {
  index: number;
  label: string;
  workload: GpuProofWorkload;
  rep: number;
  yawDeg: number;
}

/** Yaw step for the 3-frame route (F2 = rep 3 → +6deg). */
export const GPU_PROOF_YAW_STEP_DEG = 2;
/** Yaw step for the 60-frame perf route (GPU-PROOF-5 reuse). */
export const GPU_PROOF_PERF_YAW_STEP_DEG = 1;
/** Length of the 60-frame perf route (GPU-PROOF-5 reuse). */
export const GPU_PROOF_PERF_REPS = 60;

// --- Deterministic route ----------------------------------------------------

/**
 * Fixed 3-frame proof route (pure function of index):
 *   F0 stationary spawn-north (fixed camera, fixed entity set);
 *   F1 combat, same camera (adds the depthHack viewmodel gun, muzzle/boom
 *      dlights and the spark particle cloud);
 *   F2 moving combat at rep 3, yawStep 2 → yaw +6deg from spawn.
 */
export function gpuProofRoute(): GpuProofFrame[] {
  const yaw = benchSpawnYaw();
  return [
    { index: 0, label: 'gpu-proof-f0-stationary', workload: 'stationary', rep: 0, yawDeg: yaw },
    { index: 1, label: 'gpu-proof-f1-combat', workload: 'combat', rep: 0, yawDeg: yaw },
    {
      index: 2, label: 'gpu-proof-f2-moving', workload: 'moving', rep: 3,
      yawDeg: yaw + 3 * GPU_PROOF_YAW_STEP_DEG,
    },
  ];
}

/**
 * 60-frame moving-combat perf route for GPU-PROOF-5 reuse (pure function
 * of index): reps 0..59, yawStep 1deg from the spawn yaw.
 */
export function gpuProofPerfRoute(): GpuProofFrame[] {
  const yaw = benchSpawnYaw();
  const out: GpuProofFrame[] = [];
  for (let i = 0; i < GPU_PROOF_PERF_REPS; i++) {
    out.push({
      index: i,
      label: `gpu-proof-perf-${String(i).padStart(2, '0')}`,
      workload: 'moving',
      rep: i,
      yawDeg: yaw + i * GPU_PROOF_PERF_YAW_STEP_DEG,
    });
  }
  return out;
}

/**
 * Fixed RefDef for a proof frame. The frame's yawDeg is authoritative (the
 * route and perf-route constructors already encode their yaw steps), so the
 * rendered camera always matches the recorded frame — no route-dependent
 * step parameter to get wrong at the call site.
 */
export function gpuProofViewFor(frame: GpuProofFrame): RefDef {
  const view = benchSpawnView();
  if (view.fovX !== GPU_PROOF_FOV) {
    throw new Error(`[testkit] gpuProofViewFor: spawn fov ${view.fovX} != GPU_PROOF_FOV ${GPU_PROOF_FOV}`);
  }
  const angles = view.angles.slice() as Float32Array;
  angles[1] = frame.yawDeg;
  view.angles = angles;
  return view;
}

// --- Entity / light fixtures (reuse bench-workloads placement math) ---------

/**
 * Entity set for a proof frame. Stationary reuses the fixed set (alias
 * soldier frame 4 + sprite + tracer beam); combat/moving reuse the combat
 * set (fixed set + eye-anchored depthHack viewmodel gun). No duplicated
 * placement math — origin anchors and offsets live in bench-workloads.
 */
export function gpuProofEntitiesFor(
  renderer: SoftwareRenderer,
  benchWorld: BenchWorld,
  frame: GpuProofFrame,
): Entity[] {
  const origin = benchSpawnOrigin();
  return frame.workload === 'stationary'
    ? fixedBenchEntities(renderer, benchWorld, origin, frame.yawDeg)
    : combatBenchEntities(renderer, benchWorld, origin, frame.yawDeg);
}

/**
 * Per-frame light pump for a proof frame. Combat/moving re-pump the
 * muzzle/boom dlights (expire-then-add, mirroring the live loop);
 * stationary pumps nothing. Placement math lives in bench-workloads;
 * `yawDeg` is the placement yaw (normally frame.yawDeg).
 */
export function gpuProofPumpFor(
  renderer: SoftwareRenderer,
  origin: [number, number, number],
  yawDeg: number,
  frame: GpuProofFrame,
): void {
  if (frame.workload === 'stationary') return;
  pumpBenchLights(renderer, origin, yawDeg);
}

// --- Image-difference metrics (predeclared review gates) --------------------

/**
 * Tolerances for GPU-vs-CPU display comparison. REVIEW GATES, not
 * auto-pass: a frame inside tolerance still needs human side-by-side
 * review (gun, silhouettes, seams, fog, transparency) before acceptance;
 * anything outside tolerance is never accepted by loosening the numbers.
 * CPU-to-CPU parity is NOT judged by these — same-renderer re-renders must
 * be hash-exact (fnvColorFull equality).
 */
export interface GpuProofTolerances {
  /** Fail when diff/compared exceeds this (GPU-vs-CPU display gate). */
  maxFractionDiff: number;
  /** Per-channel LSB forgiveness (RGB565 quantization + dither noise). */
  perChannelLsb: number;
  /** Largest single-channel delta above this is flagged for review. */
  maxAbsDeltaWarn: number;
  /** Border rows/columns excluded (raster edge/depth-tie differences). */
  edgeExcludePx: number;
}

/**
 * Proposed review gate: fraction <= 0.02 at lsb <= 3 for GPU-vs-CPU
 * display, 1px edge exclusion, max-delta review flag at 24. Strict
 * CPU-to-CPU parity stays hash-exact and never touches this gate.
 */
export const GPU_PROOF_TOLERANCES: GpuProofTolerances = {
  maxFractionDiff: 0.02,
  perChannelLsb: 3,
  maxAbsDeltaWarn: 24,
  edgeExcludePx: 1,
};

/** Outcome of one GPU-proof frame comparison. */
export interface GpuProofDiff {
  /** Pixels differing by more than perChannelLsb in any channel. */
  diff: number;
  /** Pixels compared (total minus edge-excluded). */
  compared: number;
  /** diff / compared (0 when nothing was compared). */
  fraction: number;
  /** Largest single-channel |actual - reference| over the frame. */
  maxAbsDelta: number;
  /** fraction <= maxFractionDiff (review gate, never an auto-accept). */
  pass: boolean;
  /** Border pixels skipped via edgeExcludePx (0 when width unknown). */
  edgeExcluded: number;
}

/**
 * Compare a GPU display buffer against the CPU reference with the
 * predeclared tolerances. `width` enables the edge exclusion (border rows
 * and columns are skipped and reported in edgeExcluded); pass 0 (or a
 * width that does not divide the buffers) to compare every pixel. Length
 * mismatch counts every extra pixel as diff. Pure; no IO.
 */
export function compareGpuProofFrames(
  actual: Uint32Array,
  reference: Uint32Array,
  tolerances: GpuProofTolerances = GPU_PROOF_TOLERANCES,
  width = 0,
): GpuProofDiff {
  const lsb = tolerances.perChannelLsb;
  const edge = Math.max(0, Math.floor(tolerances.edgeExcludePx));
  const n = Math.max(actual.length, reference.length);
  const w = Math.floor(width);
  const even = actual.length === reference.length;
  const h = w > 0 && even && actual.length % w === 0 ? actual.length / w : 0;
  const useEdge = edge > 0 && w > 0 && h > 0;
  let diff = 0;
  let maxAbsDelta = 0;
  let excluded = 0;
  for (let i = 0; i < n; i++) {
    if (useEdge) {
      const x = i % w;
      const y = Math.floor(i / w);
      if (x < edge || y < edge || x >= w - edge || y >= h - edge) {
        excluded++;
        continue;
      }
    }
    const a = i < actual.length ? actual[i]! : 0;
    const b = i < reference.length ? reference[i]! : 0;
    if (a === b) continue;
    const dr = Math.abs((a & 255) - (b & 255));
    const dg = Math.abs(((a >> 8) & 255) - ((b >> 8) & 255));
    const db = Math.abs(((a >> 16) & 255) - ((b >> 16) & 255));
    const m = Math.max(dr, dg, db);
    if (m > maxAbsDelta) maxAbsDelta = m;
    if (dr <= lsb && dg <= lsb && db <= lsb) continue;
    diff++;
  }
  const compared = n - excluded;
  const fraction = compared === 0 ? 0 : diff / compared;
  return {
    diff,
    compared,
    fraction,
    maxAbsDelta,
    pass: fraction <= tolerances.maxFractionDiff,
    edgeExcluded: excluded,
  };
}

/** One-line human report, e.g. `gpu-proof-f1-combat: 12/306720 px (0.004%) maxΔ5 PASS`. */
export function formatGpuProofReport(
  name: string,
  d: GpuProofDiff,
  tolerances: GpuProofTolerances = GPU_PROOF_TOLERANCES,
): string {
  const pct = (d.fraction * 100).toFixed(3);
  const warn = d.maxAbsDelta > tolerances.maxAbsDeltaWarn ? ' REVIEW-MAXDELTA' : '';
  const edge = d.edgeExcluded > 0 ? ` edge-excluded=${d.edgeExcluded}` : '';
  return `${name}: ${d.diff}/${d.compared} px (${pct}%) maxΔ${d.maxAbsDelta}${edge} ${d.pass ? 'PASS' : 'FAIL'}${warn}`;
}

// --- Reference slot layout (IO-free; fs writes stay in the test file) --------

/** Fixed frame slot names (the 3-frame route labels). */
export function gpuProofSlotNames(): string[] {
  return gpuProofRoute().map((f) => f.label);
}

/** Slot file layout: `<slotDir>/<name>.rgba` + `<slotDir>/<name>.json`. */
export function gpuProofSlotPaths(slotDir: string, name: string): { rgbaPath: string; jsonPath: string } {
  return {
    rgbaPath: `${slotDir}/${name}.rgba`,
    jsonPath: `${slotDir}/${name}.json`,
  };
}

/** Provenance recorded alongside every CPU reference capture. */
export interface GpuProofReferenceMeta {
  width: number;
  height: number;
  label: string;
  workload: GpuProofWorkload;
  rep: number;
  yawDeg: number;
  /** Which leg produced the stored display plane. */
  display: 'voodoo-resolve' | 'raw-color';
  /** Pinned fidelity profile snapshot (must equal GPU_PROOF_FIDELITY_CVARS). */
  fidelity: Record<string, string>;
}

/**
 * Injected file writer (Node `fs.writeFileSync` in the test file). Keeps
 * this module IO-free while still performing the slot write end to end.
 */
export type GpuProofFileWriter = (path: string, data: Uint8Array | string) => void;

/**
 * Write one CPU reference slot: the display plane as raw RGBA bytes plus a
 * JSON sidecar (provenance + full-RGBA hashes of BOTH the raster color
 * plane and the stored display plane, so later comparisons can cite exact
 * CPU-to-CPU parity). Throws on a size mismatch (programmer error). The
 * writer performs the actual IO — this function stays IO-free.
 */
export function writeGpuProofReference(
  writeFile: GpuProofFileWriter,
  slotDir: string,
  name: string,
  color: Uint32Array,
  display: Uint32Array,
  meta: GpuProofReferenceMeta,
): string[] {
  if (display.length !== meta.width * meta.height) {
    throw new Error(
      `[testkit] writeGpuProofReference: display ${display.length} != ${meta.width}x${meta.height}`,
    );
  }
  const { rgbaPath, jsonPath } = gpuProofSlotPaths(slotDir, name);
  const rgba = new Uint8Array(display.length * 4);
  rgba.set(new Uint8Array(display.buffer, display.byteOffset, display.byteLength));
  const body = {
    name,
    ...meta,
    colorHash: fnvColorFull(color),
    displayHash: fnvColorFull(display),
  };
  writeFile(rgbaPath, rgba);
  writeFile(jsonPath, JSON.stringify(body, null, 2));
  return [rgbaPath, jsonPath];
}
