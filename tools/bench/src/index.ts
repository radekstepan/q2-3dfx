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
export { playBench, type PlayBenchRow } from './playbench.js';

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
