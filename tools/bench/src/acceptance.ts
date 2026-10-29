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
//      (serial is INDEPENDENTLY REQUIRED — no-thread/fallback machines run
//      it; it is both the correctness oracle and a budgeted path, not a
//      mere diagnostic for the pooled number)
//   C. voodoo pooled production: spawn-north combat rgb pooled (max sweep
//      workers) production frame ≤ 16ms — counts ONLY with proven
//      execution (staged > 0, kicks > 0, zero scanout fallbacks)
//   D. parity (correctness): pooled display == serial display (FULL-RGBA),
//      pooled idx/colorFull == serial, on every swept config +
//      odd-dimensions smoke + execution proof on pooled rows.
//      Instrumented phase medians (GEO/DRAW/alias) are DIAGNOSTIC ONLY.
//   E. worker-failure fallback: a disposed pool renders serial-identical
//      (full-RGBA raster AND scanout control) with the kick reporting
//      failure — fallback, not silent success.
//
// Worker sweep: RGB_ACCEPT_WORKERS (default "0,1,3,7"). Expensive configs
// run SEQUENTIALLY in one process on a quiet machine; serial/pooled
// scanout legs interleave back-to-back per rep inside runAttrConfig so
// both share thermal state. Fidelity/resolution/workload are pinned
// (pinPerfCvars + fixed cameras + fixed entity sets) and recorded with
// every run, with commit + build freshness + hardware + runtime.

import { createFramebuffer } from '@q2/renderer-api';
import {
  SoftwareRenderer, createDevroom, BandWorkerPool,
} from '@q2/sw-renderer';
import {
  machineJson, hashColorFull,
  checkBudget, formatBudget,
  PERF_BUDGET_SOFTWARE_640_MS, PERF_BUDGET_VOODOO_640_MS,
} from '@q2/testkit';
import {
  distFreshness,
  loadRgbAttrWorld,
  pinPerfCvars,
  runRgbAttr,
  runAttrConfig,
  scanoutOptsFromState,
  swRendererEsmPath,
  type AttrRow,
} from './rgbattr.js';
import { readVoodooState, resolveFrame } from '@q2/voodoo';

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

/**
 * Odd-dimensions smoke: serial-vs-pooled parity at an odd W×H (SAB-align
 * regression). Full-RGBA raster AND display, plus pooled execution proof
 * (a pooled row with no kicks is a serial row in disguise — rejected).
 */
async function oddDimsSmoke(pakPath: string, warmup: number, reps: number): Promise<boolean> {
  const W = 639, H = 479;
  const fw = loadRgbAttrWorld(pakPath);
  const serial = await runAttrConfig(fw, 'spawn-north', W, H, 'fixed', 'rgb', 0, warmup, reps);
  const pooled = await runAttrConfig(fw, 'spawn-north', W, H, 'fixed', 'rgb', 3, warmup, reps);
  const parityOk = serial.idxHash === pooled.idxHash &&
    serial.colorFull === pooled.colorFull &&
    serial.displaySerialFull === pooled.displaySerialFull &&
    pooled.displayFull === pooled.displaySerialFull;
  const execOk = pooled.rgbUsed && pooled.rgbCover > 0 &&
    pooled.rgbStaged > 0 && pooled.rgbKicks > 0 &&
    pooled.scanoutFallbacks === 0 && pooled.scanoutKind === 'pooled';
  const ok = parityOk && execOk;
  console.log(
    `odd-dims ${W}x${H} rgb fixed w=0 vs w=3: ` +
    `${ok ? `IDENTICAL full=${pooled.colorFull} dispFull=${pooled.displayFull} staged=${pooled.rgbStaged} kicks=${pooled.rgbKicks}` : `MISMATCH parity=${parityOk} exec=${execOk} idx ${serial.idxHash}/${pooled.idxHash} full ${serial.colorFull}/${pooled.colorFull} disp ${pooled.displayFull}/${pooled.displaySerialFull}`} ` +
    `(frame serial ${serial.frameMs?.toFixed(2)}ms pooled-prod ${pooled.frameMs?.toFixed(2)}ms)`,
  );
  return ok;
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

/**
 * Worker-failure fallback: raster AND scanout failure on a disposed pool.
 * RGB-enabled devroom (asset-free): the reference is serial RGB, the
 * fallback must match it full-RGBA on raster AND the serial scanout
 * control, inline (staged == kicks == 0, RGB still used), the scanout kick
 * must REPORT failure (false — the caller runs serial), and a second
 * frame must still match (completion ownership: no use-after-dispose,
 * nothing pending). The old idx-only software check could not see
 * blue/alpha divergence and never kicked scanout.
 */
async function deadPoolFallback(pakPath: string): Promise<boolean> {
  void pakPath;
  pinPerfCvars();
  const W = 320, H = 240;
  const view = {
    origin: new Float32Array([-168, 0, 136]),
    angles: new Float32Array([0, 0, 0]),
    fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
  };
  const renderSerialRGB = (): { idx: string; full: string; dispFull: string; cover: number } => {
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(new Uint8Array(768).fill(128));
    r.setRGBWorldEnabled(true);
    r.beginFrame();
    r.renderView(view, { name: 'devroom', data: createDevroom() }, []);
    r.endFrame();
    const st = r.testRGBStats();
    const color = r.getFramebuffer().color;
    const stVoodoo = readVoodooState();
    const dst565 = new Uint16Array(W * H);
    const disp = new Uint32Array(W * H);
    resolveFrame(color, dst565, disp, W, H, stVoodoo);
    return { idx: hashIdxOf(r), full: hashColorFull(color), dispFull: hashColorFull(disp), cover: st.coverPixels };
  };
  const ref = renderSerialRGB();

  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(new Uint8Array(768).fill(128));
  r.setRGBWorldEnabled(true);
  // ESM-only graph (single config store): the worker bootstrap resolves
  // through the ESM bundle, never the CJS `require` graph.
  const pool = BandWorkerPool.create(1, W, H, { indexJsPath: swRendererEsmPath() });
  if (!pool) {
    console.log('dead-pool fallback: pool unavailable (no threads/SAB) — SKIP (not a pass)');
    return true;
  }
  r.attachWorkerPool(pool);
  await pool.dispose();

  r.beginFrame();
  r.renderView(view, { name: 'devroom', data: createDevroom() }, []);
  r.endFrame();
  const wst = r.testRGBWorkerStats();
  const rst = r.testRGBStats();
  const live = r.getFramebuffer();
  const stVoodoo = readVoodooState();
  const scanOpts = scanoutOptsFromState(stVoodoo);
  const kickOk = pool.flushScanout(scanOpts);
  const dst565 = new Uint16Array(W * H);
  const disp = new Uint32Array(W * H);
  resolveFrame(live.color, dst565, disp, W, H, stVoodoo);
  // Second frame: ownership — no use-after-dispose, still identical.
  r.beginFrame();
  r.renderView(view, { name: 'devroom', data: createDevroom() }, []);
  r.endFrame();
  const live2 = r.getFramebuffer();
  const rasterOk = hashIdxOf(r) === ref.idx &&
    hashColorFull(live.color) === ref.full &&
    hashColorFull(live2.color) === ref.full;
  const inlineOk = wst.staged === 0 && wst.kicks === 0 && rst.used && rst.coverPixels === ref.cover;
  const scanoutOk = hashColorFull(disp) === ref.dispFull;
  const pendingOk = r.testRGBPending() === 0;
  const ok = rasterOk && inlineOk && scanoutOk && pendingOk && kickOk === false;
  console.log(
    `dead-pool fallback devroom RGB 320x240: ` +
    `${ok ? `IDENTICAL full=${ref.full} dispFull=${ref.dispFull}` : `MISMATCH raster=${rasterOk} inline=${inlineOk} scanout=${scanoutOk} pending=${pendingOk} kickReportedFailure=${!kickOk}`}`,
  );
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

  // Gate D — parity + execution proof on every swept config (exit 1).
  // Full-RGBA hashes are the authority (legacy R+G cannot see blue-only
  // or alpha-only divergence). Pooled rgb rows must ALSO prove execution
  // — staged > 0, kicks > 0, RGB used, zero scanout fallbacks — otherwise
  // the pooled number is a serial number in disguise.
  let parityOk = true;
  for (const row of rows) {
    if (row.workers === 0) continue;
    if (row.mode === 'rgb' && row.displayFull !== row.displaySerialFull) {
      console.error(`PARITY FAIL ${row.res} ${row.mode} ent=${row.entities} w=${row.workers}: pooled scanout ${row.displayFull} != serial ${row.displaySerialFull}`);
      parityOk = false;
    }
    if (row.mode === 'rgb') {
      const execOk = row.rgbUsed && row.rgbCover > 0 &&
        row.rgbStaged > 0 && row.rgbKicks > 0 &&
        row.scanoutFallbacks === 0 && row.scanoutKind === 'pooled';
      if (!execOk) {
        console.error(
          `EXEC FAIL ${row.res} ${row.mode} ent=${row.entities} w=${row.workers}: ` +
          `pool existed but execution unproven (used=${row.rgbUsed} cover=${row.rgbCover} ` +
          `staged=${row.rgbStaged} kicks=${row.rgbKicks} fb=${row.scanoutFallbacks} kind=${row.scanoutKind})`,
        );
        parityOk = false;
      }
    }
  }
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
  const poolOk = await deadPoolFallback(pakPath);
  if (!parityOk || !oddOk || !poolOk) {
    console.error('FAIL(correctness): parity/execution/fallback mismatch — see PARITY/EXEC FAIL lines above.');
    return 1;
  }
  console.log('parity: serial/pooled full-RGBA identical + execution proven on all swept configs + odd-dims + dead-pool fallback');

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
