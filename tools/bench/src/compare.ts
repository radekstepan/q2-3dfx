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
  readBandExecStats, readForegroundAttribution, detailTimingEnabled, summarizeLatencies, summarizeSplits,
  summarizeWorkerImbalance, KickJournal,
  collectGeoRep, summarizeGeoReps, formatGeoSummary,
  readKickSizes, readLastKickDescs, formatKickSizes, formatLastKickDescs,
  type FrameSplit, type WorkerExecSample, type WorkerImbalance,
  type GeoRep, type KickSizeEntry, type KickSizeSummary, type LastKickDescs,
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
  /**
   * PERF-NEXT-5 corrected foreground split (last rep, nullable = unknown):
   * worker-band vs calling-thread-band shares of the completed foreground
   * kick plus the combined totals (combined == worker + main) and the
   * fallback replay counters. Units: spans/pixels/tris. Serial configs
   * report real zeros (no kick ran); pooled configs report actuals.
   */
  fgWorkerSpans: number | null;
  fgWorkerPixels: number | null;
  fgWorkerTris: number | null;
  fgMainSpans: number | null;
  fgMainPixels: number | null;
  fgMainTris: number | null;
  fgCombinedSpans: number | null;
  fgCombinedPixels: number | null;
  fgCombinedTris: number | null;
  fgReplayedSpans: number | null;
  fgReplayedPixels: number | null;
  fgReplayedTris: number | null;
  fgRecoveryCount: number | null;
  heapDeltaKB: number;
  bandId: string;
  /**
   * PERF-NEXT-6 GEO phase attribution (instrumented loop, same views and
   * entities as the production frames below): per-phase medians over reps
   * (diagnostic, never summed), geoMs = median of the per-rep GEO totals
   * (reconciled per rep FIRST — never a sum of phase medians), geoGapMs =
   * median per-rep instrumented-wall gap. 'unavailable' when the producer
   * hook is absent (software configs without the probe never report zero).
   */
  setupMs: number | null;
  markMs: number | null;
  traverseMs: number | null;
  cullMs: number | null;
  cacheMs: number | null;
  projectMs: number | null;
  emitMs: number | null;
  sortMs: number | null;
  geoMs: number | null;
  geoGapMs: number | null;
  geoDetail: 'measured' | 'unavailable';
  /**
   * PERF-NEXT-6 kick-size histogram (last production frame): per-kick
   * completed spans/pixels/tris with drain order, band counts and exec
   * maxes (from the producer's per-band execution samples — worker, FG
   * flushes, resolve and scanout kicks). emptyKicks counts kicks whose
   * bands all completed zero work (the empty-suffix-kick finding,
   * first-class: emptyKickIds carries frame:seq:job identity).
   * Null while the producer publishes nothing (serial/detail-off).
   */
  kickSizes: KickSizeEntry[] | null;
  emptyKicks: number | null;
  emptyKickIds: string[] | null;
  /**
   * Newest kick right after renderView (before endFrame's resolve kick
   * overwrites the slot): the FG suffix flush's drained descriptor range
   * (kickBase > 0 marks a foreground-only suffix kick) plus completed
   * work and the empty flag. Null when unpublished.
   */
  suffixKick: LastKickDescs | null;
  /**
   * PERF-NEXT-4: detailed-timing state + per-band worker compute for the
   * production scanout kick (null while the renderer publishes no
   * in-worker timestamps, or detail is off). Max-vs-median straggler
   * analysis, never summed medians.
   */
  timingDetail: 'enabled' | 'disabled';
  workerComputeMs: number[] | null;
  workerImbalance: {
    groups: number; bands: number; bandMed: number; bandMax: number;
    critMax: number; gapMs: number; ratio: number | null;
    straggler: string | null;
    byGroup: Array<{ job: string; seq: number; n: number; med: number; max: number }>;
  } | null;
  fenceIdleMs: number | null;
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

/**
 * One clean report line per worker count in a sweep (PERF-NEXT-6 Lane C):
 * serial configs name the inline path; pooled configs name the band tiling
 * with the calling-thread band marked (last band). Pure — the matrix
 * header and the browser sweep procedure share this vocabulary.
 */
export function describeWorkerSweep(workers: number[], h: number): string[] {
  return workers.map((w) =>
    w === 0
      ? `w=0: serial (no pool — inline path, execution proven by construction)`
      : `w=${w}: ${formatBandRanges(h, w)} (caller owns last band)`,
  );
}

/** Moving-camera sweep: exported for the gated test-only probe (no gate use). */
export async function runMovingConfig(
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
  // PERF-NEXT-6 GEO attribution: instrumented loop over the same deterministic
  // views/entities as production (production frames below stay
  // uninstrumented — the acceptance metric is never probe-armed). Per-rep
  // GEO totals + gaps reconcile per rep first; summaries are medians over
  // reps, never sums of phase medians.
  const geoReps: GeoRep[] = [];
  for (let i = 0; i < reps; i++) {
    pumpCombatLights(r, bv.origin, baseYaw);
    const rec = collectGeoRep(r, i, viewFor(i), worldArg, entitiesFor());
    if (rec) geoReps.push(rec);
    r.endFrame();
  }
  const geo = summarizeGeoReps(geoReps);
  const geoDetail: 'measured' | 'unavailable' = geoReps.length > 0 ? 'measured' : 'unavailable';
  const frameMs: number[] = [];
  const splits: FrameSplit[] = [];
  const frameHashes: string[] = [];
  const displayHashes: Array<string | null> = [];
  const journal = new KickJournal();
  let lastSuffixKick: LastKickDescs | null = null;
  let kickSummary: KickSizeSummary | null = null;
  let staged = 0, inline = 0, kicks = 0, scanoutFallbacks = 0, coverPx = 0;
  let fgWorkerSpans: number | null = null, fgWorkerPixels: number | null = null,
    fgWorkerTris: number | null = null;
  let fgMainSpans: number | null = null, fgMainPixels: number | null = null,
    fgMainTris: number | null = null;
  let fgCombinedSpans: number | null = null, fgCombinedPixels: number | null = null,
    fgCombinedTris: number | null = null;
  let fgReplayedSpans: number | null = null, fgReplayedPixels: number | null = null,
    fgReplayedTris: number | null = null, fgRecoveryCount: number | null = null;
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
  // PERF-NEXT-6 suffix-kick drain: the newest kick right after renderView
    // is the frame's last foreground flush (endFrame's resolve kick would
    // overwrite the slot). Falls into the per-rep gap, never a segment.
    if (i === reps - 1 && pool) {
      try {
        lastSuffixKick = readLastKickDescs(pool);
      } catch {
        lastSuffixKick = null;
      }
    }
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
      // PERF-NEXT-5 corrected split (last rep): worker/main/combined plus
      // replay — null while the producer publishes nothing (unknown).
      try {
        const a = readForegroundAttribution(r);
        if (a) {
          fgWorkerSpans = a.kick.workerSpans;
          fgWorkerPixels = a.kick.workerPixels;
          fgWorkerTris = a.kick.workerTris;
          fgMainSpans = a.kick.mainSpans;
          fgMainPixels = a.kick.mainPixels;
          fgMainTris = a.kick.mainTris;
          fgCombinedSpans = a.kick.spans;
          fgCombinedPixels = a.kick.pixels;
          fgCombinedTris = a.kick.tris;
          fgReplayedSpans = a.replayedSpans;
          fgReplayedPixels = a.replayedPixels;
          fgReplayedTris = a.replayedTris;
          fgRecoveryCount = a.recoveryCount;
        }
      } catch {
        /* corrected split stays null; batch legs above still report */
      }
      // PERF-NEXT-6 kick-size histogram (last production frame, pooled only):
      // per-kick completed work + empty-kick counter. Null while the
      // producer publishes nothing (serial/detail-off) — unknown, never 0.
      try {
        kickSummary = pool ? readKickSizes(pool) : null;
      } catch {
        kickSummary = null;
      }
    }
  }
  if (pool) await pool.dispose();
  setRGBWorldEnabled(false);
  const scan = summarizeLatencies(frameMs);
  const sp = summarizeSplits(splits);
  // PERF-NEXT-4: per-band worker compute for the production scanout kicks
  // (feature-detected; dispatch latencies above are the always-on fence).
  const detail: 'enabled' | 'disabled' = detailTimingEnabled() ? 'enabled' : 'disabled';
  let workerComputeMs: number[] | null = null;
  let workerImbalance: MovingRow['workerImbalance'] = null;
  let fenceIdleMs: number | null = null;
  if (detail === 'enabled' && pool && mode === 'rgb') {
    let samples: WorkerExecSample[] | null = null;
    try {
      samples = readBandExecStats(pool);
    } catch {
      samples = null;
    }
    if (samples && samples.length > 0) {
      const imb: WorkerImbalance = summarizeWorkerImbalance(samples);
      const s = imb.straggler;
      workerComputeMs = samples.map((x) => x.execMs);
      workerImbalance = {
        groups: imb.groups, bands: imb.bands, bandMed: imb.bandMed, bandMax: imb.bandMax,
        critMax: imb.critPathMax, gapMs: imb.imbalanceMs, ratio: imb.imbalanceRatio,
        straggler: s ? `band${s.band}(${s.job} f${s.frame}s${s.seq} ${s.execMs.toFixed(2)}ms)` : null,
        byGroup: imb.byGroup.map((g) => ({ job: g.job, seq: g.seq, n: g.n, med: g.med, max: g.max })),
      };
      const kickMax = journal.summarize('scanout').max;
      fenceIdleMs = Math.max(0, kickMax - imb.critPathMax);
    }
  }
  const execPart = workerComputeMs
    ? ` compute[${workerComputeMs.map((v) => v.toFixed(2)).join('/')}] gap=${workerImbalance!.gapMs.toFixed(2)} straggler=${workerImbalance!.straggler} groups[${workerImbalance!.byGroup.map((g) => `${g.job}s${g.seq}:${g.n}b med=${g.med.toFixed(2)} max=${g.max.toFixed(2)}`).join(' ')}] fenceIdle=${fenceIdleMs!.toFixed(2)}`
    : detail === 'disabled' ? ' compute[detail-off]' : ' compute[unpublished:no-in-worker-timestamps]';
  const geoPart = geoDetail === 'measured'
    ? ` ${formatGeoSummary(geo)}`
    : ' geo[unavailable:no-testMeasurePhases]';
  const kickSizesSummary = kickSummary
    ? ` ${formatKickSizes(kickSummary)}`
    : ' kickSizes[unpublished:serial-or-detail-off]';
  const suffixPart = lastSuffixKick ? ` ${formatLastKickDescs(lastSuffixKick)}` : '';
  console.log(
    `moving ${W}x${H} ent=combat ${mode} w=${workers}: ` +
    `frame(production,Node)=${scan.med.toFixed(2)}(p95 ${scan.p95.toFixed(2)} max ${scan.max.toFixed(2)}) ` +
    `split[begin=${sp.begin.toFixed(2)} render=${sp.render.toFixed(2)} end=${sp.end.toFixed(2)} ` +
    `scanout=${sp.scanout.toFixed(2)} gap=${sp.gap.toFixed(2)}] ` +
    `hash0=${frameHashes[0]} hashN=${frameHashes[frameHashes.length - 1]} ` +
    `stage[staged=${staged} inline=${inline} kicks=${kicks} fb=${scanoutFallbacks}] ` +
    `fgExec[worker=${fgWorkerSpans ?? '—'}sp/${fgWorkerPixels ?? '—'}px/${fgWorkerTris ?? '—'}tr ` +
    `main=${fgMainSpans ?? '—'}sp/${fgMainPixels ?? '—'}px/${fgMainTris ?? '—'}tr ` +
    `combined=${fgCombinedSpans ?? '—'}sp/${fgCombinedPixels ?? '—'}px/${fgCombinedTris ?? '—'}tr ` +
    `replayed=${fgReplayedSpans ?? '—'}sp recovery=${fgRecoveryCount ?? '—'}] ` +
    `cover=${coverPx} heapΔ=${(heapKB() - heapBeforeKB).toFixed(0)}KB ${formatBandRanges(H, workers)}` +
    `${execPart} detail=${detail}${geoPart}${kickSizesSummary}${suffixPart}`,
  );
  const geoMed = (pick: (r: GeoRep) => number): number | null =>
    geoDetail === 'measured' ? summarizeLatencies(geoReps.map(pick)).med : null;
  return {
    workload: 'moving', res: `${W}x${H}`, mode, workers,
    frameMs, split: splits, frameHashes, displayHashes,
    kicks, staged, inline, scanoutKind, scanoutFallbacks, coverPx,
    fgWorkerSpans, fgWorkerPixels, fgWorkerTris,
    fgMainSpans, fgMainPixels, fgMainTris,
    fgCombinedSpans, fgCombinedPixels, fgCombinedTris,
    fgReplayedSpans, fgReplayedPixels, fgReplayedTris, fgRecoveryCount,
    heapDeltaKB: heapKB() - heapBeforeKB,
    bandId: formatBandRanges(H, workers),
    timingDetail: detail, workerComputeMs, workerImbalance, fenceIdleMs,
    setupMs: geoMed((r) => r.phases.setup),
    markMs: geoMed((r) => r.phases.mark),
    traverseMs: geoMed((r) => r.phases.traverse),
    cullMs: geoMed((r) => r.phases.cull),
    cacheMs: geoMed((r) => r.phases.cache),
    projectMs: geoMed((r) => r.phases.project),
    emitMs: geoMed((r) => r.phases.emit),
    sortMs: geoMed((r) => r.phases.sort),
    geoMs: geoMed((r) => r.geoTotalMs),
    geoGapMs: geoMed((r) => r.gapMs),
    geoDetail,
    kickSizes: kickSummary ? kickSummary.kicks : null,
    emptyKicks: kickSummary ? kickSummary.emptyKicks : null,
    emptyKickIds: kickSummary ? kickSummary.emptyKickIds : null,
    suffixKick: lastSuffixKick,
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
  // PERF-NEXT-6 worker-count sweep: every count 0..8 parses; report the
  // band tiling per count so a partial sweep reads cleanly. The browser
  // lane runs the same list (see tools/bench/README.md sweep procedure).
  for (const line of describeWorkerSweep(workers, 480)) console.log(`compare-run: sweep ${line}`);
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

/**
 * Minimal structural shape carrying the PERF-NEXT-5 corrected foreground
 * split (AttrRow and MovingRow both satisfy it; older run JSONs simply
 * omit the fields and skip the check).
 */
export interface FgSplitLike {
  fgKicks?: number | null;
  fgWorkerSpans?: number | null;
  fgWorkerPixels?: number | null;
  fgWorkerTris?: number | null;
  fgMainSpans?: number | null;
  fgMainPixels?: number | null;
  fgMainTris?: number | null;
  fgCombinedSpans?: number | null;
  fgCombinedPixels?: number | null;
  fgCombinedTris?: number | null;
}

/**
 * PERF-NEXT-5 foreground reconcile note for one stationary row: '' when the
 * corrected split reconciles (combined == worker + main wherever all three
 * are published; no worker-completed work on zero-kick rows) or when the row
 * predates the split (fields absent — skipped, never defaulted). Otherwise
 * a void-execution-proof note.
 */
export function fgReconcileNote(h: FgSplitLike): string {
  const triple = (
    label: string, combined: number | null | undefined,
    worker: number | null | undefined, main: number | null | undefined,
  ): string => {
    if (combined != null && worker != null && main != null && combined !== worker + main) {
      return `FG ${label} ${combined} != worker(${worker})+main(${main})`;
    }
    return '';
  };
  const notes = [
    triple('spans', h.fgCombinedSpans, h.fgWorkerSpans, h.fgMainSpans),
    triple('pixels', h.fgCombinedPixels, h.fgWorkerPixels, h.fgMainPixels),
    triple('tris', h.fgCombinedTris, h.fgWorkerTris, h.fgMainTris),
  ].filter((s) => s !== '');
  if (h.fgKicks === 0) {
    for (const [label, v] of [
      ['workerSpans', h.fgWorkerSpans],
      ['workerPixels', h.fgWorkerPixels],
      ['workerTris', h.fgWorkerTris],
    ] as Array<[string, number | null | undefined]>) {
      if (v != null && v !== 0) notes.push(`FG ${label}=${v} with kicks=0`);
    }
  }
  return notes.join('; ');
}

/** Diff two runs; settings MUST match or the comparison is void. */
export function diffComparison(base: CompareRun, head: CompareRun): { lines: DiffLine[]; settingsMatch: boolean } {  const settingsMatch =
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
    // PERF-NEXT-5: when both rows carry the corrected foreground split,
    // the combined totals must reconcile (combined == worker + main) and
    // zero-kick rows must carry no worker-completed work — otherwise the
    // row's execution proof is void even when hashes match. Rows from older
    // runs lack the fields and skip this leg (guarded, never defaulted).
    const fgNote = fgReconcileNote(h);
    const deltaPct = b.frameMs !== null && h.frameMs !== null && b.frameMs > 0
      ? ((h.frameMs - b.frameMs) / b.frameMs) * 100 : null;
    lines.push({
      key, baseFrame: b.frameMs, headFrame: h.frameMs, deltaPct, parity,
      execProof: execProof && fgNote === '',
      note: [parity ? '' : `OUTPUT CHANGED idx ${b.idxHash}/${h.idxHash} full ${b.colorFull}/${h.colorFull}`, fgNote].filter((s) => s !== '').join(' '),
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
