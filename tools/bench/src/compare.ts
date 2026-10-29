// q2-bench controlled comparison (PERF-FINISH follow-up items 4–5,
// bench/testkit lane).
//
// Parent-vs-HEAD protocol (sequential, quiet machine, same workloads and
// settings — never concurrent across agents):
//
//   1. Build tree A, run `Q2_PAK=... yarn bench:compare-run` → base.json.
//   2. Build tree B (or `git worktree`), run the same command → head.json.
//   3. `yarn bench:compare-diff` with COMPARE_BASE/COMPARE_HEAD → table.
//
// The two runs NEVER share a process (different code versions), so each
// run file records everything needed to prove comparability: commit,
// freshness, cvars profile, resolution/mode/workload/workers, machine,
// node, and box load. The diff step VERIFIES the settings match and warns
// otherwise — a settings mismatch is a void comparison, not a speedup.
//
// Workloads (all with the real viewmodel gun in combat; 320x240 diagnostic,
// 640x480 acceptance):
//   - stationary: spawn-north fixed camera, fixed entities (runAttrConfig).
//   - combat:     spawn-north fixed camera, combat entities + pumped dlights.
//   - moving:     spawn-north with a deterministic yaw sweep (2 deg/rep,
//                 pure function of the rep index — identical across builds,
//                 so per-frame hashes stay comparable) + combat entities.
// Modes: software (no scanout stage) + rgb (fused resolveFrame serial /
// pooled flushScanout production legs). Workers: COMPARE_WORKERS "0,1,3,7".
//
// Full-channel comparisons everywhere: index FNV + full-RGBA color FNV +
// full-RGBA display FNV (legacy R+G kept for ledger continuity only).
// Per-rep splits (same-rep reconciled gaps), kick journals
// (dispatch-to-completion, never labeled worker compute), and stage/byte
// ledgers ride along; budgets compare only whole production frames.
import { cpus, loadavg } from 'node:os';
import { createFramebuffer } from '@q2/renderer-api';
import type { Entity } from '@q2/renderer-api';
import { setCVar } from '@q2/config';
import {
  SoftwareRenderer, BandWorkerPool, setRGBWorldEnabled,
} from '@q2/sw-renderer';
import {
  base1RefDef, base1Views, hashColorFull, machineJson,
  collectStageCounters, formatBandRanges, frameSplit, nsToMs, nowNs,
  summarizeLatencies, summarizeSplits,
  KickJournal,
  type FrameSplit,
} from '@q2/testkit';
import { readVoodooState, resolveFrame } from '@q2/voodoo';
import {
  combatEntities,
  loadRgbAttrWorld,
  pinPerfCvars,
  pumpCombatLights,
  runAttrConfig,
  scanoutOptsFromState,
  swRendererEsmPath,
  type AttrRow,
  type RgbAttrWorld,
} from './rgbattr.js';

export interface MovingRow {
  workload: 'moving';
  res: string;
  mode: 'software' | 'rgb';
  workers: number;
  /** Whole production frames measured TOGETHER per rep (acceptance metric). */
  frameMs: number[];
  split: FrameSplit[];
  /** Per-frame full-RGBA hashes (deterministic sweep — comparable builds). */
  frameHashes: string[];
  displayHashes: Array<string | null>;
  kicks: number;
  staged: number;
  inline: number;
  scanoutKind: string | null;
  scanoutFallbacks: number;
  coverPx: number;
  heapDeltaKB: number;
  bandId: string;
}

export interface CompareMeta {
  commit: string;
  node: string;
  machine: unknown;
  load1: number;
  cpus: number;
  quietOk: boolean;
  warmup: number;
  reps: number;
  workers: number[];
  yawStepDeg: number;
}

export interface CompareRun {
  meta: CompareMeta;
  stationary: AttrRow[];
  moving: MovingRow[];
}

/** Quiet-machine check: 1-min load vs cpu count (advisory, recorded). */
export function checkQuietMachine(): { load1: number; cpus: number; ok: boolean } {
  const n = Math.max(1, cpus().length);
  const load1 = loadavg()[0] ?? 0;
  return { load1, cpus: n, ok: load1 <= n };
}

async function gitCommit(): Promise<string> {
  try {
    const cp = await import('child_process');
    return cp.execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function compareWorkers(): number[] {
  const raw = process.env.COMPARE_WORKERS ?? '0,1,3,7';
  const out: number[] = [];
  for (const part of raw.split(',')) {
    const n = Math.floor(Number(part));
    if (Number.isFinite(n) && n >= 0 && n <= 8 && !out.includes(n)) out.push(n);
  }
  return out.length > 0 ? out : [0, 1, 3, 7];
}

async function runMovingConfig(
  fw: RgbAttrWorld, W: number, H: number,
  mode: 'software' | 'rgb', workers: number,
  warmup: number, reps: number, yawStepDeg: number,
): Promise<MovingRow> {
  pinPerfCvars();
  const rgb = mode === 'rgb';
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(fw.palette);
  setRGBWorldEnabled(rgb);
  let pool: BandWorkerPool | null = null;
  if (workers > 0) {
    setCVar('sw_workers', Math.min(8, workers + 1));
    setCVar('sw_accum', 1);
    r.syncWorkersFromCvar();
    pool = BandWorkerPool.create(workers, W, H, { indexJsPath: swRendererEsmPath() });
    if (!pool) throw new Error('pool unavailable (need worker_threads + SAB + Atomics.wait)');
    r.attachWorkerPool(pool);
  }
  const bv = base1Views().find((v) => v.label === 'spawn-north')!;
  const base = base1RefDef(bv);
  const baseYaw = bv.angles[1]!;
  const worldArg = { name: 'base1', data: fw.world };
  const entitiesFor = (): Entity[] => combatEntities(r, fw, bv.origin, baseYaw);
  const heapKB = (): number => {
    try { return process.memoryUsage().heapUsed / 1024; } catch { return 0; }
  };
  const heapBeforeKB = heapKB();
  const st = readVoodooState();
  const opts = scanoutOptsFromState(st);
  const serialDst = new Uint16Array(W * H);
  const serialDisp = new Uint32Array(W * H);
  const viewFor = (i: number): typeof base => ({
    ...base,
    origin: new Float32Array(bv.origin),
    angles: new Float32Array([bv.angles[0]!, baseYaw + i * yawStepDeg, bv.angles[2]!]),
  });
  for (let i = 0; i < warmup; i++) {
    pumpCombatLights(r, bv.origin, baseYaw);
    r.beginFrame();
    r.renderView(viewFor(i), worldArg, entitiesFor());
    r.endFrame();
  }
  const frameMs: number[] = [];
  const splits: FrameSplit[] = [];
  const frameHashes: string[] = [];
  const displayHashes: Array<string | null> = [];
  const journal = new KickJournal();
  let staged = 0, inline = 0, kicks = 0, scanoutFallbacks = 0, coverPx = 0;
  let scanoutKind: string | null = mode === 'software' ? null : (pool ? 'pooled' : 'serial');
  for (let i = 0; i < reps; i++) {
    pumpCombatLights(r, bv.origin, baseYaw);
    const tF = nowNs();
    let t = nowNs();
    r.beginFrame();
    const bM = nsToMs(nowNs() - t);
    t = nowNs();
    r.renderView(viewFor(i), worldArg, entitiesFor());
    const rM = nsToMs(nowNs() - t);
    t = nowNs();
    r.endFrame();
    const eM = nsToMs(nowNs() - t);
    t = nowNs();
    let sM = 0;
    let disp: Uint32Array | null = null;
    if (rgb) {
      if (pool) {
        const ok = pool.flushScanout(opts);
        sM = nsToMs(nowNs() - t);
        journal.record({
          frame: i, seq: 0, job: 'scanout', workers, band: 'all',
          y0: 0, y1: H, latencyMs: sM, ok, execMs: null, pixels: W * H, spans: 0,
        });
        if (!ok) {
          scanoutFallbacks++;
          const tS = nowNs();
          resolveFrame(r.getFramebuffer().color, serialDst, serialDisp, W, H, st);
          sM += nsToMs(nowNs() - tS);
          disp = serialDisp;
        } else {
          disp = pool.scanoutPlanes.scanDisplay.slice(0, W * H) as Uint32Array;
        }
      } else {
        resolveFrame(r.getFramebuffer().color, serialDst, serialDisp, W, H, st);
        sM = nsToMs(nowNs() - t);
        journal.record({
          frame: i, seq: 0, job: 'scanout', workers: 0, band: 'all',
          y0: 0, y1: H, latencyMs: sM, ok: true, execMs: sM, pixels: W * H, spans: 0,
        });
        disp = serialDisp;
      }
    }
    const fM = nsToMs(nowNs() - tF);
    frameMs.push(fM);
    splits.push(frameSplit(bM, rM, eM, sM, fM));
    frameHashes.push(hashColorFull(r.getFramebuffer().color));
    displayHashes.push(disp ? hashColorFull(disp) : null);
    if (i === reps - 1) {
      const sc = collectStageCounters(r);
      staged = sc.stagedBatches;
      inline = sc.inlineBatches;
      kicks = sc.kicks;
      coverPx = sc.coverPixels;
    }
  }
  if (pool) await pool.dispose();
  setRGBWorldEnabled(false);
  const scan = summarizeLatencies(frameMs);
  const sp = summarizeSplits(splits);
  console.log(
    `moving ${W}x${H} ent=combat ${mode} w=${workers}: ` +
    `frame(production,Node)=${scan.med.toFixed(2)}(p95 ${scan.p95.toFixed(2)} max ${scan.max.toFixed(2)}) ` +
    `split[begin=${sp.begin.toFixed(2)} render=${sp.render.toFixed(2)} end=${sp.end.toFixed(2)} ` +
    `scanout=${sp.scanout.toFixed(2)} gap=${sp.gap.toFixed(2)}] ` +
    `hash0=${frameHashes[0]} hashN=${frameHashes[frameHashes.length - 1]} ` +
    `stage[staged=${staged} inline=${inline} kicks=${kicks} fb=${scanoutFallbacks}] ` +
    `cover=${coverPx} heapΔ=${(heapKB() - heapBeforeKB).toFixed(0)}KB ${formatBandRanges(H, workers)}`,
  );
  return {
    workload: 'moving', res: `${W}x${H}`, mode, workers,
    frameMs, split: splits, frameHashes, displayHashes,
    kicks, staged, inline, scanoutKind, scanoutFallbacks, coverPx,
    heapDeltaKB: heapKB() - heapBeforeKB,
    bandId: formatBandRanges(H, workers),
  };
}

function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

/** Run the full controlled matrix SEQUENTIALLY in this process. */
export async function runComparisonMatrix(pakPath: string): Promise<CompareRun> {
  const warmup = Number(process.env.COMPARE_WARMUP ?? 3);
  const reps = Number(process.env.COMPARE_REPS ?? 5);
  const workers = compareWorkers();
  const yawStepDeg = Number(process.env.COMPARE_YAWSTEP ?? 2);
  const commit = await gitCommit();
  const machine = await machineJson().catch(() => ({ node: process.version }));
  const { load1, cpus, ok } = checkQuietMachine();
  const meta: CompareMeta = {
    commit, node: process.version, machine, load1, cpus, quietOk: ok, warmup, reps, workers, yawStepDeg,
  };
  console.log(`compare-run: commit=${commit} warmup=${warmup} reps=${reps} workers=${workers.join(',')} yawStep=${yawStepDeg}deg`);
  console.log(JSON.stringify({ machine, node: process.version, load1, cpus, quietOk: ok }, null, 2));
  if (!ok) console.log(`WARN box loaded (load1 ${load1.toFixed(1)} > cpus ${cpus}) — numbers are not a quiet baseline`);
  const fw = loadRgbAttrWorld(pakPath);
  const stationary: AttrRow[] = [];
  for (const [W, H] of [[320, 240], [640, 480]] as Array<[number, number]>) {
    for (const ent of ['fixed', 'combat'] as const) {
      for (const mode of ['software', 'rgb'] as const) {
        for (const w of workers) {
          stationary.push(await runAttrConfig(fw, 'spawn-north', W, H, ent, mode, w, warmup, reps));
        }
      }
    }
  }
  const moving: MovingRow[] = [];
  for (const [W, H] of [[320, 240], [640, 480]] as Array<[number, number]>) {
    for (const mode of ['software', 'rgb'] as const) {
      for (const w of workers) {
        moving.push(await runMovingConfig(fw, W, H, mode, w, warmup, reps, yawStepDeg));
      }
    }
  }
  return { meta, stationary, moving };
}

export interface DiffLine {
  key: string;
  baseFrame: number | null;
  headFrame: number | null;
  deltaPct: number | null;
  parity: boolean;
  execProof: boolean;
  note: string;
}

/** Diff two runs; settings MUST match or the comparison is void. */
export function diffComparison(base: CompareRun, head: CompareRun): { lines: DiffLine[]; settingsMatch: boolean } {
  const settingsMatch =
    base.meta.warmup === head.meta.warmup &&
    base.meta.reps === head.meta.reps &&
    base.meta.yawStepDeg === head.meta.yawStepDeg &&
    JSON.stringify(base.meta.workers) === JSON.stringify(head.meta.workers) &&
    JSON.stringify(base.stationary.map((r) => `${r.res} ${r.mode} ${r.entities} w=${r.workers}`)) ===
    JSON.stringify(head.stationary.map((r) => `${r.res} ${r.mode} ${r.entities} w=${r.workers}`));
  const lines: DiffLine[] = [];
  const hStat = new Map(head.stationary.map((r) => [`${r.res} ${r.mode} ${r.entities} w=${r.workers}`, r]));
  for (const b of base.stationary) {
    const key = `${b.res} ${b.mode} ${b.entities} w=${b.workers}`;
    const h = hStat.get(key);
    if (!h) {
      lines.push({ key, baseFrame: b.frameMs, headFrame: null, deltaPct: null, parity: false, execProof: false, note: 'missing in head' });
      continue;
    }
    const parity = b.idxHash === h.idxHash && b.colorFull === h.colorFull &&
      b.displayFull === h.displayFull;
    const execProof = b.mode === 'software' ? true : (
      h.rgbUsed && h.rgbCover > 0 && h.rgbStaged > 0 && h.rgbKicks > 0 &&
      h.scanoutFallbacks === 0
    ) || (h.workers === 0);
    const deltaPct = b.frameMs !== null && h.frameMs !== null && b.frameMs > 0
      ? ((h.frameMs - b.frameMs) / b.frameMs) * 100 : null;
    lines.push({
      key, baseFrame: b.frameMs, headFrame: h.frameMs, deltaPct, parity, execProof,
      note: parity ? '' : `OUTPUT CHANGED idx ${b.idxHash}/${h.idxHash} full ${b.colorFull}/${h.colorFull}`,
    });
  }
  const hMov = new Map(head.moving.map((r) => [`moving ${r.res} ${r.mode} w=${r.workers}`, r]));
  for (const b of base.moving) {
    const key = `moving ${b.res} ${b.mode} w=${b.workers}`;
    const h = hMov.get(key);
    if (!h) {
      lines.push({ key, baseFrame: med(b.frameMs), headFrame: null, deltaPct: null, parity: false, execProof: false, note: 'missing in head' });
      continue;
    }
    const parity = b.frameHashes.length === h.frameHashes.length &&
      b.frameHashes.every((hh, i) => hh === h.frameHashes[i]);
    const bf = med(b.frameMs), hf = med(h.frameMs);
    lines.push({
      key, baseFrame: bf, headFrame: hf,
      deltaPct: bf > 0 ? ((hf - bf) / bf) * 100 : null,
      parity, execProof: true,
      note: parity ? '' : 'MOVING OUTPUT CHANGED (non-deterministic or real diff)',
    });
  }
  return { lines, settingsMatch };
}

export function formatDiff(lines: DiffLine[], settingsMatch: boolean): string {
  const out: string[] = [];
  out.push(settingsMatch
    ? 'settings: MATCH (same workloads/settings — controlled comparison)'
    : 'settings: MISMATCH — comparison VOID (rerun with identical env)');
  for (const l of lines) {
    const d = l.deltaPct === null ? 'n/a' : `${l.deltaPct >= 0 ? '+' : ''}${l.deltaPct.toFixed(1)}%`;
    out.push(
      `${l.key}: base=${l.baseFrame?.toFixed(2) ?? '—'}ms head=${l.headFrame?.toFixed(2) ?? '—'}ms ` +
      `Δ=${d} parity=${l.parity ? 'SAME' : 'CHANGED'} exec=${l.execProof ? 'proven' : 'UNPROVEN'}${l.note ? ` !! ${l.note}` : ''}`,
    );
  }
  return out.join('\n');
}
