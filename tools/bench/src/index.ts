// q2-bench: headless perf runs, writes to the perf ledger (BRAIN.md §11).
// Prints a ledger row: | date | commit | path | res | fps | Mpixel/s | overdraw | notes |
import { runBench, syntheticFill, formatLedgerRow, machineJson } from '@q2/testkit';
import { createFramebuffer } from '@q2/renderer-api';

export interface BenchOptions {
  width?: number;
  height?: number;
  iterations?: number;
  path?: 'software' | 'voodoo';
  notes?: string;
}

export {
  runFrameBench, loadBase1World, attributeView, poolCompareView,
  swRendererEsmPath, BASE1_VIEWS,
  type AttribView, type FrameWorld, type PhaseRow, type PoolRow,
} from './frame.js';
export {
  runRgbAttr, runAttrConfig, loadRgbAttrWorld, pinPerfCvars, fixedEntities, combatEntities,
  pumpCombatLights, scanoutOptsFromState, distFreshness, repoRoot,
  PLAYBENCH_FRESHNESS_PKGS,
  rgbBenchWorkers, rgbBenchEnts,
  RGB_ATTR_RESS, RGB_ATTR_SCENES, RGB_ATTR_ENTS,
  type RgbAttrScene, type RgbAttrEntities, type RgbAttrMode,
  type RgbAttrWorld, type RgbAttrOptions, type AttrRow,
  type DistFreshness,
} from './rgbattr.js';
export { playBench, type PlayBenchRow } from './playbench.js';
export { runAcceptance, acceptWorkers, type AcceptOptions } from './acceptance.js';
export {
  runComparisonMatrix, diffComparison, formatDiff, compareWorkers, checkQuietMachine,
  describeWorkerSweep,
  type CompareMeta, type CompareRun, type DiffLine, type MovingRow,
} from './compare.js';
export {
  runInterleavedAB, parseABLegSpec, emitABEvidence, abLedgerHint,
  type ABLegSpec, type ABEmitOptions,
} from './ab.js';
export {
  GPU_PROOF_WIDTH, GPU_PROOF_HEIGHT, GPU_PROOF_RESOLUTION,
  GPU_PROOF_VD_KEYS, GPU_PROOF_SW_KEYS, GPU_PROOF_FIDELITY_KEYS, GPU_PROOF_LODBIAS,
  GPU_PROOF_ORIGIN, GPU_PROOF_YAW_DEG, GPU_PROOF_TIME_S, GPU_PROOF_FOV_X,
  GPU_PROOF_FRAMES, GPU_PROOF_PERF_FRAMES, GPU_PROOF_PERF_YAW_STEP_DEG,
  GPU_PROOF_GATE, validateGpuProofBrowserRecord, formatGpuProofGateReport,
  summarizeGpuProofNode,
  type GpuProofFrame, type GpuProofGate, type GpuProofBrowserRecord,
  type GpuProofGateMeasurement, type GpuProofNodeSummary,
} from './gpu-proof.js';
export {
  EVIDENCE_MANIFEST_VERSION, BROWSER_SOAK_SCHEMA_VERSION, PROVENANCE_ENV_ALLOWLIST,
  evidenceDir, evidenceRawDir, provenanceEnv, pakIdentity, collectFidelityProfile,
  collectMachine, collectNodeProvenance, defaultResultPath, defaultManifestPath,
  buildNodeManifest, writeEvidenceManifest, summarizeAttrRows, summarizeCompare,
  ledgerHintFor, validateBrowserSoak, importBrowserSoak,
  type EvidenceKind, type BrowserCompositor, type PakIdentity, type FidelityProfile,
  type ProvenanceCommand, type BrowserInfo, type AttrLike, type MovingLike,
  type EvidenceCore, type EvidenceManifest, type BrowserSoakRecord,
  type SoakImportResult, type SoakImportOpts, type ProvenanceOpts,
} from './evidence.js';

export async function runBenchTool(opts: BenchOptions = {}): Promise<string> {
  const width = opts.width ?? 640;
  const height = opts.height ?? 480;
  const iterations = opts.iterations ?? 60;
  const fb = createFramebuffer(width, height, true);
  const sample = runBench('fill', width * height, iterations, () => syntheticFill(fb.color, 0x12345678));
  const commit = await gitCommit();
  const path = opts.path ?? 'software';
  const notes = opts.notes ?? `fill-loop ${width}x${height}`;
  const row = formatLedgerRow(sample, commit, path, notes);
  const machine = await machineJson().catch(() => ({ node: process.version }));
  console.log(row);
  console.log(JSON.stringify({ machine, msPerFrame: sample.msTotal / sample.iterations }, null, 2));
  return row;
}

async function gitCommit(): Promise<string> {
  try {
    const cp = await import('child_process');
    return cp.execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const invoked = typeof process !== 'undefined' && process.argv[1] != null;
if (invoked && /bench\/dist\/index\.(js|mjs|cjs)$/.test(process.argv[1]!)) {
  void runBenchTool();
}
