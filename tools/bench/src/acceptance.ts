// q2-bench acceptance gate (item-9 benchmark checklist).
//
// Timing-sensitive budget enforcement lives HERE — not in vitest. Unit
// tests assert correctness only (hashes, pure logic); this command runs
// warmed, repeated, uninstrumented production frames on the documented
// reference config (640x480 spawn-north, Q2_PAK base1) and exits non-zero
// when a budget is missed:
//
//   exit 0 — parity holds AND all budgets pass
//   exit 1 — hard failure: stale dist, missing assets, serial/pooled or
//            odd-dims parity mismatch, worker-fallback divergence
//   exit 2 — budgets missed (parity held; the numbers are the gap record)
//
// Gates:
//   A. software reference: spawn-north fixed software serial frame ≤ 16ms
//   B. voodoo reference serial: spawn-north fixed rgb serial frame ≤ 16ms
//   C. voodoo pooled production: spawn-north combat rgb pooled (max sweep
//      workers) production frame ≤ 16ms
//   D. parity (correctness): pooled display == serial display, pooled
//      idx/color == serial, on every swept config + odd-dimensions smoke.
//   E. worker-failure fallback: a disposed pool renders serial-identical.
//
// Worker sweep: RGB_ACCEPT_WORKERS (default "0,1,3,7"). Expensive configs
// run SEQUENTIALLY in one process on a quiet machine; serial/pooled
// scanout legs interleave back-to-back per rep inside runAttrConfig so
// both share thermal state. Fidelity/resolution/workload are pinned
// (pinPerfCvars + fixed cameras + fixed entity sets) and recorded with
// every run, with commit + build freshness + hardware + runtime.

import { createRequire } from 'node:module';
import { createFramebuffer } from '@q2/renderer-api';
import {
  SoftwareRenderer, createDevroom, BandWorkerPool,
} from '@q2/sw-renderer';
import {
  machineJson,
  checkBudget, formatBudget,
  PERF_BUDGET_SOFTWARE_640_MS, PERF_BUDGET_VOODOO_640_MS,
} from '@q2/testkit';
import {
  distFreshness,
  loadRgbAttrWorld,
  pinPerfCvars,
  runRgbAttr,
  runAttrConfig,
  swRendererEsmPath,
  type AttrRow,
} from './rgbattr.js';

export interface AcceptOptions {
  warmup: number;
  reps: number;
  workers: number[];
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

function findRow(rows: AttrRow[], mode: 'software' | 'rgb', ent: 'fixed' | 'combat', workers: number): AttrRow {
  const r = rows.find((x) => x.scene === 'spawn-north' && x.res === '640x480' && x.mode === mode && x.entities === ent && x.workers === workers);
  if (!r || r.frameMs === null) throw new Error(`acceptance: missing row mode=${mode} ent=${ent} w=${workers}`);
  return r;
}

function hashIdxOf(r: SoftwareRenderer): string {
  const idx = r.getFramebuffer().index!;
  let h = 2166136261;
  for (let i = 0; i < idx.length; i++) {
    h ^= idx[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Odd-dimensions smoke: serial-vs-pooled parity at an odd W×H (SAB-align regression). */
async function oddDimsSmoke(pakPath: string, warmup: number, reps: number): Promise<boolean> {
  const W = 639, H = 479;
  const fw = loadRgbAttrWorld(pakPath);
  const serial = await runAttrConfig(fw, 'spawn-north', W, H, 'fixed', 'rgb', 0, warmup, reps);
  const pooled = await runAttrConfig(fw, 'spawn-north', W, H, 'fixed', 'rgb', 3, warmup, reps);
  const ok = serial.idxHash === pooled.idxHash &&
    serial.colorHash === pooled.colorHash &&
    serial.displaySerialHash === pooled.displaySerialHash &&
    pooled.displayHash === pooled.displaySerialHash;
  console.log(
    `odd-dims ${W}x${H} rgb fixed w=0 vs w=3: ` +
    `${ok ? 'IDENTICAL' : `MISMATCH idx ${serial.idxHash}/${pooled.idxHash} disp ${pooled.displayHash}/${pooled.displaySerialHash}`} ` +
    `(frame serial ${serial.frameMs?.toFixed(2)}ms pooled-prod ${pooled.frameMs?.toFixed(2)}ms)`,
  );
  return ok;
}

/** Worker-failure fallback: a disposed pool must render serial-identical. */
function deadPoolFallback(pakPath: string): boolean {
  void pakPath;
  pinPerfCvars();
  const W = 320, H = 240;
  const renderOnce = (withDeadPool: boolean): string => {
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(new Uint8Array(768).fill(128));
    r.setRGBWorldEnabled(false);
    if (withDeadPool) {
      const require = createRequire(process.cwd() + '/');
      const cjs = require.resolve('@q2/sw-renderer');
      void cjs;
      const pool = BandWorkerPool.create(1, W, H, { indexJsPath: swRendererEsmPath() });
      if (pool) {
        r.attachWorkerPool(pool);
        void pool.dispose();
      }
    }
    const view = {
      origin: new Float32Array([-168, 0, 136]),
      angles: new Float32Array([0, 0, 0]),
      fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
    };
    r.beginFrame();
    r.renderView(view, { name: 'devroom', data: createDevroom() }, []);
    r.endFrame();
    return hashIdxOf(r);
  };
  const a = renderOnce(false);
  const b = renderOnce(true);
  const ok = a === b;
  console.log(`dead-pool fallback devroom 320x240: ${ok ? `IDENTICAL ${a}` : `MISMATCH ${a} vs ${b}`}`);
  return ok;
}

export async function runAcceptance(pakPath: string, opts: Partial<AcceptOptions> = {}): Promise<number> {
  const warmup = opts.warmup ?? Number(process.env.RGB_ACCEPT_WARMUP ?? 5);
  const reps = opts.reps ?? Number(process.env.RGB_ACCEPT_REPS ?? 10);
  const workers = opts.workers ?? acceptWorkers();
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
  const { rows } = await runRgbAttr(pakPath, {
    warmup, reps, scenes: ['spawn-north'], entities: ['fixed', 'combat'], workers,
  });

  // Gate D — parity on every swept config (correctness, exit 1).
  let parityOk = true;
  for (const row of rows) {
    if (row.workers === 0) continue;
    if (row.mode === 'rgb' && row.displayHash !== row.displaySerialHash) {
      console.error(`PARITY FAIL ${row.res} ${row.mode} ent=${row.entities} w=${row.workers}: pooled scanout ${row.displayHash} != serial ${row.displaySerialHash}`);
      parityOk = false;
    }
  }
  const serialByKey = new Map<string, AttrRow>();
  for (const row of rows) {
    if (row.workers === 0) serialByKey.set(`${row.scene} ${row.res} ${row.mode} ${row.entities}`, row);
  }
  for (const row of rows) {
    if (row.workers === 0) continue;
    const s = serialByKey.get(`${row.scene} ${row.res} ${row.mode} ${row.entities}`);
    if (s && (s.idxHash !== row.idxHash || s.colorHash !== row.colorHash)) {
      console.error(`PARITY FAIL ${row.res} ${row.mode} ent=${row.entities} w=${row.workers}: idx/color vs serial mismatch`);
      parityOk = false;
    }
  }
  const oddOk = await oddDimsSmoke(pakPath, warmup, reps);
  const poolOk = deadPoolFallback(pakPath);
  if (!parityOk || !oddOk || !poolOk) {
    console.error('FAIL(correctness): parity/fallback mismatch — see PARITY FAIL lines above.');
    return 1;
  }
  console.log('parity: serial/pooled identical on all swept configs + odd-dims + dead-pool fallback');

  // Gates A–C — budgets (exit 2 on miss; the printed numbers record the gap).
  const maxW = Math.max(...workers);
  const gateA = findRow(rows, 'software', 'fixed', 0);
  const gateB = findRow(rows, 'rgb', 'fixed', 0);
  const gateC = findRow(rows, 'rgb', 'combat', maxW);
  const cA = checkBudget(gateA.frameMs!, PERF_BUDGET_SOFTWARE_640_MS);
  const cB = checkBudget(gateB.frameMs!, PERF_BUDGET_VOODOO_640_MS);
  const cC = checkBudget(gateC.frameMs!, PERF_BUDGET_VOODOO_640_MS);
  console.log(formatBudget('gate A software fixed serial frame', cA));
  console.log(formatBudget('gate B rgb fixed serial frame', cB));
  console.log(formatBudget(`gate C rgb combat pooled(w=${maxW}) production frame`, cC));
  const allPass = cA.pass && cB.pass && cC.pass;
  if (!allPass) {
    console.error('FAIL(budget): one or more gates missed the ≤16ms/frame @640x480 budget.');
    return 2;
  }
  console.log('acceptance: ALL GATES PASS');
  return 0;
}
