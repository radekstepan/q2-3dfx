// q2-bench play-level attribution (perf lane, job §1): the BROWSER-
// equivalent inline-path split beyond raw renderer phases — sim
// (driver.step: SV_Tick + monsterThink + DoorSync graft + pickups), pumps,
// host render, HUD/conchars blits, and the canvas-upload copy loop
// estimate. Headless-safe (no DOM); run with Q2_PAK like the frame bench.
import { readFileSync } from 'node:fs';
import { resetCVars, setCVar } from '@q2/config';
import {
  bootPlay,
  drawPlayHud,
  pumpExplosionLights,
  pumpMuzzleLight,
  pumpTracers,
} from 'web';
import { ingestPak } from 'web';
import type { WebPak } from 'web';

export interface PlayBenchRow {
  stepMs: number;
  pumpsMs: number;
  renderMs: number;
  resolveMs: number;
  hudMs: number;
  blitCopyMs: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

function nowMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

/**
 * Full play-loop split at W×H on a real base1 boot (grafted world, live
 * server sim). Prints one section; returns medians over iters frames.
 */
export function playBench(pakPath: string, W = 640, H = 480, iters = 10): PlayBenchRow {
  resetCVars();
  setCVar('vid_resolution', `${W}x${H}`);
  const pakBytes = readFileSync(pakPath);
  const buf = pakBytes.buffer.slice(
    pakBytes.byteOffset, pakBytes.byteOffset + pakBytes.byteLength,
  ) as ArrayBuffer;
  const pak: WebPak = ingestPak(buf);
  const boot = bootPlay({ width: W, height: H, pak });
  const { host, driver } = boot;

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
    let t = nowMs();
    driver.step(cmd, 0.1);
    step.push(nowMs() - t);

    t = nowMs();
    pumpMuzzleLight(boot);
    pumpExplosionLights(boot);
    pumpTracers(boot);
    pumps.push(nowMs() - t);

    t = nowMs();
    host.renderCurrentView();
    render.push(nowMs() - t);

    t = nowMs();
    host.refresh.endFrame();
    resolve.push(nowMs() - t);

    // HUD/conchars blits on the resolved buffer (same call the rAF tick
    // makes, pre-blit pass).
    const target = boot.display;
    target.set(host.fb.color);
    t = nowMs();
    drawPlayHud({ width: W, height: H, color: target }, boot, { fps: 60, frame: i });
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
  const row: PlayBenchRow = {
    stepMs: median(step),
    pumpsMs: median(pumps),
    renderMs: median(render),
    resolveMs: median(resolve),
    hudMs: median(hud),
    blitCopyMs: median(blit),
  };
  const total = row.stepMs + row.pumpsMs + row.renderMs + row.resolveMs + row.hudMs + row.blitCopyMs;
  console.log(
    `play ${W}x${H} (base1 spawn, combat input): ` +
      `step=${row.stepMs.toFixed(2)}ms pumps=${row.pumpsMs.toFixed(2)}ms ` +
      `render=${row.renderMs.toFixed(2)}ms resolve=${row.resolveMs.toFixed(2)}ms ` +
      `hud=${row.hudMs.toFixed(2)}ms blitCopy~=${row.blitCopyMs.toFixed(2)}ms ` +
      `total~=${total.toFixed(2)}ms/frame (blitCopy excludes createImageData+putImageData)`,
  );
  return row;
}
