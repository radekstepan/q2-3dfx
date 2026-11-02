// Dark-end regression: the silencer crawlspace must stay navigable, never
// a pure-black void (max-component static light + real pcx shade rows +
// WORLD_GRADE_FLOOR in @q2/sw-renderer).
//
// The nook walls carry dim-but-nonzero baked light (max 18-45/255). The old
// Rec.601 luma fold read warm light ~2x darker than id's brightest-component
// rule, and the procedural shade table crushed every dim texel to palette
// black — the nook rendered 100% pure black. It now renders dim but
// structured (id's look, lifted just off zero).
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars } from '@q2/config';
import { BUTTON_DUCK, type UserCmdT } from '@q2/input';
import { bspPointContentsFor, CONTENTS_SOLID } from '@q2/game';
import { v3 } from '@q2/math';
import { bootPlay, buildAsyncView, resolveDisplay, type LocalDriver } from './play.js';

const WEB_Q2_PAK = process.env.Q2_PAK;

async function bootBase1(width = 96, height = 72) {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  return bootPlay({ width, height, pak: ingestPak(buf) });
}

function stepWalk(driver: LocalDriver, cmd: UserCmdT, n: number): void {
  for (let i = 0; i < n; i++) driver.step(cmd, 0.1);
}

afterEach(() => {
  resetCVars();
});

describe.runIf(!!WEB_Q2_PAK)('dark end (Q2_PAK)', () => {
  it('silencer crawlspace reads dim, not pure black', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // Exact pickup recipe (pickups.test.ts): teleport, duck, walk north so
    // the eye is game-validated in-bounds air, not guesswork coordinates.
    driver.pm.origin = v3(-408, 620, -96);
    driver.pm.velocity = v3();
    const duck: UserCmdT = { msec: 100, angles: [0, 90, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_DUCK };
    stepWalk(driver, duck, 10);
    stepWalk(driver, { ...duck, forwardmove: 100 }, 6);
    const eye = v3(
      driver.pm.origin[0]!, driver.pm.origin[1]!,
      driver.pm.origin[2]! + driver.pm.viewheight,
    );
    const contentsAt = bspPointContentsFor(boot.driver.map!);
    expect(contentsAt(eye) & CONTENTS_SOLID).toBe(0);
    const view = {
      origin: eye,
      angles: v3(0, 90, 0),
      fovX: 90,
      time: 3.7,
      lightStyles: new Float32Array(256).fill(1),
    };
    const { renderables } = buildAsyncView(boot.host, 0);
    boot.refresh.beginFrame();
    boot.refresh.renderView(
      view as Parameters<ReturnType<typeof bootPlay>['refresh']['renderView']>[0],
      boot.host.world,
      renderables,
    );
    boot.refresh.endFrame();
    const frame = new Uint32Array(resolveDisplay(boot));
    let black = 0;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
      const p = frame[i]!;
      const r = p & 255, g = (p >> 8) & 255, b = (p >> 16) & 255;
      if (r === 0 && g === 0 && b === 0) black++;
      sum += (r + g + b) / 3;
    }
    const mean = sum / frame.length;
    // Calibrated 2026-11: 28.8% black / mean 11.8 with the fix (was
    // 100% / 0.01). Margins leave room for content drift but fail a
    // return to the black void.
    expect(black / frame.length).toBeLessThan(0.5);
    expect(mean).toBeGreaterThan(4);
  });
});
