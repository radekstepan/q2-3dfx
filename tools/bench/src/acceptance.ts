// q2-bench acceptance gate (item-9 benchmark checklist).
//
// Timing-sensitive budget enforcement lives HERE — not in vitest. Unit
// tests assert correctness only (hashes, pure logic); this command runs
// warmed, repeated, uninstrumented production frames on the documented
// reference config (640x480 spawn-north, Q2_PAK base1) and exits non-zero
// when a budget is missed:
//
//   exit 0 — parity holds AND all budgets pass
//   exit 1 — hard failure: stale dist, missing assets, serial/pooled
//            parity mismatch
//   exit 2 — budgets missed (parity held; the numbers are the gap record)
//
// RELEASE-8: the legacy CPU Voodoo execution legs are retired, so the gate
// is software-only:
//
//   A. software reference: spawn-north fixed software serial frame ≤ 16ms
//   D. parity (correctness): pooled == serial (FULL-RGBA idx/colorFull) on
//      every swept config + odd-dimensions software smoke.
//      Instrumented phase medians (GEO/DRAW/alias) are DIAGNOSTIC ONLY.
//      Critical-path detail (per-rep scanout-kick dispatch-to-completion
//      with frame/seq/job/band identity + same-rep main-thread split +
//      staging/skip/byte counters) is REPORTED for every gate but never
//      gated: budgets compare only whole production frames.
//
// The retired rgb gates (B: rgb fixed serial, C: rgb combat pooled) and the
// rgb-only checks (pooled execution proof, dead-pool fallback) are gone
// with the legs they gated. Old run JSONs still load (AttrRow keeps the
// rgb shape for comparability).
//
// Worker sweep: RGB_ACCEPT_WORKERS (default "0,1,3,7"). Expensive configs
// run SEQUENTIALLY in one process on a quiet machine; serial/pooled
// scanout legs interleave back-to-back per rep inside runAttrConfig so
// both share thermal state. Fidelity/resolution/workload are pinned
// (pinPerfCvars + fixed cameras + fixed entity sets) and recorded with
// every run, with commit + build freshness + hardware + runtime.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  machineJson,
  checkBudget, formatBudget,
  PERF_BUDGET_SOFTWARE_640_MS,
} from '@q2/testkit';
import {
  distFreshness,
  loadRgbAttrWorld,
  runRgbAttr,
  runAttrConfig,
  type AttrRow,
} from './rgbattr.js';
import {
  buildNodeManifest,
  collectNodeProvenance,
  defaultManifestPath,
  defaultResultPath,
  ledgerHintFor,
  summarizeAttrRows,
  writeEvidenceManifest,
} from './evidence.js';

export interface AcceptOptions {
  warmup: number;
  reps: number;
  workers: number[];
  /**
   * Durable evidence (PERF-NEXT-1): full rows JSON + committed manifest.
   * On by default (the gate is a CLI tool); set emitEvidence: false to opt
   * out. Paths default to tools/bench/evidence/{raw/} (env ACCEPT_OUT /
   * ACCEPT_MANIFEST_OUT override).
   */
  emitEvidence?: boolean;
  resultPath?: string;
  manifestPath?: string;
}

export function acceptWorkers(): number[] {
  const raw = process.env.RGB_ACCEPT_WORKERS ?? '0,1,3,7';
  const out: number[] = [];
  for (const part of raw.split(',')) {
    const n = Math.floor(Number(part));
    if (Number.isFinite(n) && n >= 0 && n <= 8 && !out.includes(n)) out.push(n);
  }
  return out.length > 0 ? out : [0, 1, 3, 7];
}

function findRow(rows: AttrRow[], ent: 'fixed' | 'combat', workers: number): AttrRow {
  const r = rows.find((x) => x.scene === 'spawn-north' && x.res === '640x480' && x.mode === 'software' && x.entities === ent && x.workers === workers);
  if (!r || r.frameMs === null) throw new Error(`acceptance: missing row ent=${ent} w=${workers}`);
  return r;
}

/**
 * Odd-dimensions smoke (software): serial-vs-pooled full-RGBA parity at an
 * odd W×H (SAB-align regression). The rgb pooled-execution proof and the
 * scanout display legs retired with the Voodoo legs (RELEASE-8).
 */
async function oddDimsSmoke(pakPath: string, warmup: number, reps: number): Promise<boolean> {
  const W = 639, H = 479;
  const fw = loadRgbAttrWorld(pakPath);
  const serial = await runAttrConfig(fw, 'spawn-north', W, H, 'fixed', 'software', 0, warmup, reps);
  const pooled = await runAttrConfig(fw, 'spawn-north', W, H, 'fixed', 'software', 3, warmup, reps);
  const ok = serial.idxHash === pooled.idxHash &&
    serial.colorFull === pooled.colorFull;
  console.log(
    `odd-dims ${W}x${H} software fixed w=0 vs w=3: ` +
    `${ok ? `IDENTICAL full=${pooled.colorFull}` : `MISMATCH idx ${serial.idxHash}/${pooled.idxHash} full ${serial.colorFull}/${pooled.colorFull}`} ` +
    `(frame serial ${serial.frameMs?.toFixed(2)}ms pooled-prod ${pooled.frameMs?.toFixed(2)}ms)`,
  );
  return ok;
}

/**
 * Durable evidence for an acceptance run (PERF-NEXT-1): the full rows
 * (with raw frameReps per config) go to evidence/raw/ (gitignored), the
 * committed manifest points at them and carries provenance + summary.
 * Written for pass AND fail exits — a missed budget is evidence too.
 */
async function emitAcceptEvidence(
  pakPath: string,
  rows: AttrRow[],
  ctx: { warmup: number; reps: number; workers: number[]; commit: string; opts: Partial<AcceptOptions> },
): Promise<{ resultFile: string; manifestFile: string }> {
  const provenance = await collectNodeProvenance('node-accept', {
    pakPath, warmup: ctx.warmup, reps: ctx.reps, workers: ctx.workers,
  });
  const machine = await machineJson().catch(() => ({ node: process.version }));
  const resultFile = ctx.opts.resultPath ?? process.env.ACCEPT_OUT ?? defaultResultPath('node-accept', ctx.commit);
  mkdirSync(dirname(resultFile), { recursive: true });
  writeFileSync(resultFile, JSON.stringify({ rows, machine, commit: ctx.commit, provenance }, null, 2));
  const summary = summarizeAttrRows(rows);
  // PERF-NEXT-4: record that the accept gate ran with detailed timing
  // disabled (per-band worker exec reads null by design in these rows).
  summary['timingDetail'] = rows.length > 0 && rows.every((r) => r.timingDetail === 'disabled')
    ? 'disabled'
    : 'mixed';
  const manifestOut = ctx.opts.manifestPath
    ?? process.env.ACCEPT_MANIFEST_OUT
    ?? defaultManifestPath('node-accept', ctx.commit);
  const manifest = buildNodeManifest(provenance, {
    resultFile,
    summary,
    ledgerHint: ledgerHintFor('node-accept', ctx.commit, summary, manifestOut),
  });
  const manifestFile = writeEvidenceManifest(manifest, manifestOut);
  console.log(`ledger hint: ${manifest.ledgerHint}`);
  return { resultFile, manifestFile };
}

export async function runAcceptance(pakPath: string, opts: Partial<AcceptOptions> = {}): Promise<number> {
  const warmup = opts.warmup ?? Number(process.env.RGB_ACCEPT_WARMUP ?? 5);
  const reps = opts.reps ?? Number(process.env.RGB_ACCEPT_REPS ?? 10);
  const workers = opts.workers ?? acceptWorkers();
  // PERF-NEXT-4 done-when 5: the accept gate ALWAYS runs with detailed
  // timing disabled — per-band exec/imbalance/material-GC-ms collection is
  // skipped (null in the rows) and the gate compares only whole
  // production frames + parity. The disabled state is recorded in the
  // rows, the console and the evidence manifest.
  process.env.Q2_DETAIL_TIMING = '0';
  const fresh = distFreshness();
  if (!fresh.fresh) {
    console.error(
      `FAIL(stale dist): tools/bench/dist predates ${fresh.newestSrcFile} — run yarn build first, then re-run acceptance.`,
    );
    return 1;
  }
  let commit = 'unknown';
  try {
    const cp = await import('child_process');
    commit = cp.execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch { /* offline */ }
  const machine = await machineJson().catch(() => ({ node: process.version }));
  console.log(`acceptance: reference 640x480 spawn-north, warmup=${warmup} reps=${reps} workers=${workers.join(',')}`);
  console.log(JSON.stringify({ machine, node: process.version, commit, warmup, reps, workers }, null, 2));

  // Sequential worker sweep on the reference scene (expensive configs run
  // one at a time in this process; each config warms up before measuring).
  // RELEASE-8: software fixed only (rgb legs retired — no combat sweep leg
  // remains; gate C is gone with it).
  const { rows } = await runRgbAttr(pakPath, {
    warmup, reps, scenes: ['spawn-north'], entities: ['fixed'], workers,
  });

  // Gate D — serial/pooled full-RGBA parity on every swept config (exit 1).
  // Full-RGBA hashes are the authority (legacy R+G cannot see blue-only
  // or alpha-only divergence). The rgb pooled-execution proof retired with
  // the Voodoo legs (RELEASE-8).
  let parityOk = true;
  const serialByKey = new Map<string, AttrRow>();
  for (const row of rows) {
    if (row.workers === 0) serialByKey.set(`${row.scene} ${row.res} ${row.mode} ${row.entities}`, row);
  }
  for (const row of rows) {
    if (row.workers === 0) continue;
    const s = serialByKey.get(`${row.scene} ${row.res} ${row.mode} ${row.entities}`);
    if (s && (s.idxHash !== row.idxHash || s.colorFull !== row.colorFull)) {
      console.error(`PARITY FAIL ${row.res} ${row.mode} ent=${row.entities} w=${row.workers}: full-RGBA idx/color vs serial mismatch`);
      parityOk = false;
    }
  }
  const oddOk = await oddDimsSmoke(pakPath, warmup, reps);
  const parityFail = !parityOk || !oddOk;
  if (opts.emitEvidence !== false) {
    const ev = await emitAcceptEvidence(pakPath, rows, { warmup, reps, workers, commit, opts });
    console.log(`acceptance: evidence rows ${ev.resultFile}`);
    console.log(`acceptance: manifest ${ev.manifestFile}`);
  }
  if (parityFail) {
    console.error('FAIL(correctness): serial/pooled parity mismatch — see PARITY FAIL lines above.');
    return 1;
  }
  console.log('parity: serial/pooled full-RGBA identical on all swept configs + software odd-dims');

  // Gate A — budget (exit 2 on miss; the printed numbers record the gap).
  const gateA = findRow(rows, 'fixed', 0);
  // Critical-path detail per gate (reported, never gated): stable band
  // identity, same-rep main-thread split + scheduling gap, scanout-kick
  // dispatch-to-completion (med/p95/max — the max is the scanout critical
  // path), staging/skip/byte ledger, foreground proof (serial alias +
  // elided classic fg). Per-worker exec durations + imbalance +
  // material-GC ms need renderer in-worker timestamps AND detail on —
  // acceptance runs detail OFF, so the rows below read null by design
  // (the gate budget compares only whole production frames).
  console.log('timing detail DISABLED for acceptance (PERF-NEXT-4): per-band worker exec/imbalance/material-GC read null by design; budgets compare whole production frames only.');
  for (const [label, row] of [['gate A', gateA]] as const) {
    const rs = (v: number | null): string => v === null ? '—' : v.toFixed(2);
    const fgLine = `fg[kicks=${row.fgKicks ?? '—'}(alpha+placed+entity) staged=${row.fgStaged ?? '—'} inline=${row.fgInline ?? '—'} ` +
      `alpha=${row.fgAlphaSpans ?? '—'} sprites=${row.fgSpriteSpans ?? '—'} tris=${row.fgTrisStaged ?? '—'} ` +
      `aliasIn=${row.fgAliasDrawsInline ?? '—'} partIn=${row.fgParticlesInline ?? '—'} beamIn=${row.fgBeamsInline ?? '—'} ` +
      `entityMs=${rs(row.fgEntityMs)} matGcMs=${rs(row.materialGcMs)}]`;
    const execLine = row.workerComputeMs
      ? `workerExec[compute[${row.workerComputeMs.map((v) => v.toFixed(2)).join('/')}] gap=${row.workerImbalance?.gapMs.toFixed(2)} straggler=${row.workerImbalance?.straggler} fenceIdle=${rs(row.fenceIdleMs)}]`
      : 'workerExec[detail-off:null-by-design]';
    console.log(
      `crit ${label} ${row.res} ${row.mode} ent=${row.entities} w=${row.workers} ${row.bandId} detail=${row.timingDetail}: ` +
      `split[begin=${rs(row.splitBeginMs)} render=${rs(row.splitRenderMs)} end=${rs(row.splitEndMs)} ` +
      `scanout=${rs(row.splitScanoutMs)} gap=${rs(row.splitGapMs)}] ` +
      `scanoutKick[${row.scanoutKind ?? 'n/a'} med=${rs(row.scanoutMs)} p95=${rs(row.scanoutP95)} max=${rs(row.scanoutMaxMs)} serialCtl=${rs(row.scanoutSerialMs)}] ` +
      `frameMax=${rs(row.frameMaxMs)} ` +
      `stage[cover=${row.coverPx} staged=${row.rgbStaged} inline=${row.rgbInline} kicks=${row.rgbKicks} fb=${row.scanoutFallbacks} ` +
      `skipSpans=${row.classicSpansSkipped} skipFg=${row.classicFgSkipped} armed=${row.skipArmed} trans=${row.translucentSpans}] ` +
      `${fgLine} ` +
      `fg[alias=${rs(row.aliasMs)} serial] ` +
      `${execLine} ` +
      `bytes[planes=${row.planeBytes} scan=${row.scanBytes ?? 'n/a'} chain=${row.chainUsedBytes} retained=${row.retainedChainBytes} orphan=${row.orphanChainBytes}] ` +
      `heapΔ=${row.heapDeltaKB.toFixed(0)}KB`,
    );
  }
  console.log('note: frame() is production-frame-no-present (Node); presented FPS is a browser/CDP soak metric (perf-ledger soak rows). Per-band worker exec is measured in-worker (see detail-enabled compare/rgbattr rows); acceptance runs with it disabled by design.');
  const cA = checkBudget(gateA.frameMs!, PERF_BUDGET_SOFTWARE_640_MS);
  console.log(formatBudget('gate A software fixed serial frame', cA));
  if (!cA.pass) {
    console.error('FAIL(budget): gate A missed the ≤16ms/frame @640x480 budget.');
    return 2;
  }
  console.log('acceptance: ALL GATES PASS');
  return 0;
}
