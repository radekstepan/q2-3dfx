// q2-bench play-level attribution (perf lane, job §1): the BROWSER-
// equivalent inline-path split beyond raw renderer phases — sim
// (driver.step: SV_Tick + monsterThink + DoorSync graft + pickups), pumps,
// production host render (host.renderCurrentView: predicted entities +
// monsters + extraEntities + eye-anchored depthHack viewmodel gun — the
// exact submit the shipped sync rAF tick renders), production scanout
// (resolveDisplay: serial fused scanout in Node; pre-scanout HUD in strict
// voodoo, exactly like dom.ts finishFrame), HUD/conchars blits, and the
// canvas-upload copy loop estimate. Headless-safe (no DOM); run with Q2_PAK
// like the frame bench.
//
// Methodology: INSTRUMENTED stage medians (sim/pumps/render/resolve/HUD/
// blit timed separately) are attribution only. The ACCEPTANCE metric is
// frameMs: whole production frames (step+pumps+render+endFrame+
// resolveDisplay+HUD+blit-copy) measured TOGETHER per rep in a separate
// loop — never a sum of stage medians. Env: PLAYBENCH_RENDERER
// (software|voodoo, default voodoo — the scanout under test),
// PLAYBENCH_W/H, PLAYBENCH_ITERS.
import { readFileSync } from 'node:fs';
import { getCVarString, resetCVars, setCVar, setCVarFromString } from '@q2/config';
// NOTE: web is imported via its ESM bundle ('web/dist/index.mjs'), NOT the
// package main (CJS). The CJS graph loads a SECOND @q2/config store, so
// cvars set here would be invisible to the CJS web bundle (silent
// software-branch resolve while the row says voodoo — caught by the
// freshness/parity probes, never by eye). Single module universe:
// bench-ESM + web-ESM + config-ESM. Contract need filed to the integrator.
import {
  applyRendererCvar,
  bootPlay,
  drawPlayHud,
  pumpExplosionLights,
  pumpMuzzleLight,
  pumpTracers,
  resolveDisplay,
} from 'web/dist/index.mjs';
import { ingestPak } from 'web/dist/index.mjs';
import type { WebPak } from 'web/dist/index.mjs';
import { distFreshness, PLAYBENCH_FRESHNESS_PKGS } from './rgbattr.js';

export interface PlayBenchRow {
  renderer: string;
  pooled: boolean;
  /** True when HUD is composed pre-scanout (strict voodoo, inside resolve). */
  hudPreScanout: boolean;
  stepMs: number;
  pumpsMs: number;
  renderMs: number;
  resolveMs: number;
  hudMs: number;
  blitCopyMs: number;
  /** Acceptance: full production frame measured together per rep (median). */
  frameMs: number;
  /** Acceptance p95 over the same reps. */
  frameP95: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
}

function nowMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

/**
 * Full play-loop split at W×H on a real base1 boot (grafted world, live
 * server sim). Prints one section; returns medians over iters frames plus
 * the directly-measured full-frame acceptance metric.
 */
export function playBench(pakPath: string, W = 640, H = 480, iters = 10): PlayBenchRow {
  resetCVars();
  setCVar('vid_resolution', `${W}x${H}`);
  const renderer = process.env.PLAYBENCH_RENDERER ?? 'voodoo';
  setCVarFromString('vid_renderer', renderer);
  const pakBytes = readFileSync(pakPath);
  const buf = pakBytes.buffer.slice(
    pakBytes.byteOffset, pakBytes.byteOffset + pakBytes.byteLength,
  ) as ArrayBuffer;
  const pak: WebPak = ingestPak(buf);
  const boot = bootPlay({ width: W, height: H, pak });
  // Arm the renderer backend for the latched vid_renderer (voodoo arms the
  // sw-renderer RGB world path; without this the cvar and backend disagree).
  applyRendererCvar(boot);
  const { host, driver } = boot;
  const strictVoodoo = (boot as unknown as { strictVoodoo?: boolean }).strictVoodoo === true;
  const hudPreScanout = renderer === 'voodoo' && strictVoodoo;
  // Playbench loads the web shell: validate its bundle too (WARN when the
  // concurrent tree is ahead of the built dist — numbers then describe the
  // dist, not the tree).
  distFreshness(PLAYBENCH_FRESHNESS_PKGS);

  // Representative combat input: walk forward + fire every other tick so
  // monsterThink, bolt touch, muzzle pumps and tracer queues are all live.
  const mkCmd = (attack: boolean) => ({
    msec: 100,
    angles: [0, 90, 0] as [number, number, number],
    forwardmove: 200,
    sidemove: 0,
    upmove: 0,
    buttons: attack ? 1 : 0,
  });

  // Warm up: advance the sim, fill the surface cache, settle monsters.
  // NOTE: driver.step runs the 10Hz server tick (SV_Tick + monsterThink +
  // DoorSync graft). The rAF loop calls it at most once per 100ms, so the
  // per-frame sim share is step/6 at 60fps, step/2 at 20fps — the step row
  // below is one full tick, not one frame.
  for (let i = 0; i < 12; i++) {
    driver.step(mkCmd(i % 2 === 0), 0.1);
    host.frame(i * 16.7);
  }

  const step: number[] = [];
  const pumps: number[] = [];
  const render: number[] = [];
  const resolve: number[] = [];
  const hud: number[] = [];
  const blit: number[] = [];
  for (let i = 0; i < iters; i++) {
    const cmd = mkCmd(i % 2 === 0);
    const hudArg = { fps: 60, frame: i };
    let t = nowMs();
    driver.step(cmd, 0.1);
    step.push(nowMs() - t);

    t = nowMs();
    pumpMuzzleLight(boot);
    pumpExplosionLights(boot);
    pumpTracers(boot);
    pumps.push(nowMs() - t);

    // INSTRUMENTED attribution legs (stage split, not the gate). Render is
    // the production submit (viewmodel gun included via renderCurrentView);
    // resolve is the production scanout (serial in Node).
    t = nowMs();
    host.renderCurrentView();
    render.push(nowMs() - t);

    t = nowMs();
    const target = resolveDisplay(boot, hudArg);
    resolve.push(nowMs() - t);

    // HUD exactly like dom.ts finishFrame: strict voodoo already composed
    // it pre-scanout (inside resolve above) — painting again would double.
    t = nowMs();
    if (!hudPreScanout) {
      drawPlayHud({ width: W, height: H, color: target }, boot, hudArg);
    }
    hud.push(nowMs() - t);

    // Canvas-upload copy-loop estimate: blitToCanvas (apps/web dom.ts)
    // rebytes 0xAABBGGRR -> RGBA per pixel before putImageData. Headless
    // has no canvas, so time the identical loop into a scratch buffer
    // (excludes createImageData + putImageData — real upload costs more).
    const src = new Uint8Array(target.buffer, target.byteOffset, target.length * 4);
    const dst = new Uint8Array(src.length);
    t = nowMs();
    for (let k = 0, j = 0; k < src.length; k += 4, j += 4) {
      dst[j] = src[k]!;
      dst[j + 1] = src[k + 1]!;
      dst[j + 2] = src[k + 2]!;
      dst[j + 3] = src[k + 3]!;
    }
    blit.push(nowMs() - t);
  }
  const cs = (boot.refresh as unknown as {
    testCacheStats(): { hits: number; misses: number; hitRate: number };
  }).testCacheStats();
  console.log(
    `play cache: hits=${cs.hits} misses=${cs.misses} hitRate=${(cs.hitRate * 100).toFixed(1)}% ` +
      `(combat input invalidates via muzzle/bolt dlights; quiescent renderView in the frame section above is the hot-cache case)`,
  );
  // UNINSTRUMENTED acceptance loop: whole production frames (same tick as
  // dom.ts tickSync) measured together per rep.
  const frames: number[] = [];
  for (let i = 0; i < iters; i++) {
    const hudArg = { fps: 60, frame: i };
    const t = nowMs();
    driver.step(mkCmd(i % 2 === 0), 0.1);
    pumpMuzzleLight(boot);
    pumpExplosionLights(boot);
    pumpTracers(boot);
    host.renderCurrentView();
    const target = resolveDisplay(boot, hudArg);
    if (!hudPreScanout) {
      drawPlayHud({ width: W, height: H, color: target }, boot, hudArg);
    }
    const src = new Uint8Array(target.buffer, target.byteOffset, target.length * 4);
    const dst = new Uint8Array(src.length);
    for (let k = 0, j = 0; k < src.length; k += 4, j += 4) {
      dst[j] = src[k]!;
      dst[j + 1] = src[k + 1]!;
      dst[j + 2] = src[k + 2]!;
      dst[j + 3] = src[k + 3]!;
    }
    frames.push(nowMs() - t);
  }
  const pooled = (boot.refresh as unknown as {
    testWorkerStats(): { pooled: boolean };
  }).testWorkerStats().pooled;
  const row: PlayBenchRow = {
    renderer: getCVarString('vid_renderer'),
    pooled,
    hudPreScanout,
    stepMs: median(step),
    pumpsMs: median(pumps),
    renderMs: median(render),
    resolveMs: median(resolve),
    hudMs: median(hud),
    blitCopyMs: median(blit),
    frameMs: median(frames),
    frameP95: p95(frames),
  };
  const total = row.stepMs + row.pumpsMs + row.renderMs + row.resolveMs + row.hudMs + row.blitCopyMs;
  console.log(
    `play ${W}x${H} ${row.renderer}${row.pooled ? ' pooled' : ' serial'} (base1 spawn, combat input): ` +
      `step=${row.stepMs.toFixed(2)}ms pumps=${row.pumpsMs.toFixed(2)}ms ` +
      `render=${row.renderMs.toFixed(2)}ms resolve=${row.resolveMs.toFixed(2)}ms ` +
      `hud=${row.hudMs.toFixed(2)}ms blitCopy~=${row.blitCopyMs.toFixed(2)}ms ` +
      `stages~=${total.toFixed(2)}ms/frame (attribution only, blitCopy excludes createImageData+putImageData)`,
  );
  console.log(
    `play ${W}x${H} ${row.renderer} ACCEPTANCE frame=${row.frameMs.toFixed(2)}ms ` +
      `(p95 ${row.frameP95.toFixed(2)}ms, measured together per rep, N=${iters})`,
  );
  return row;
}
