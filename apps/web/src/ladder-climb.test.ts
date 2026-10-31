// RELEASE-12 driver ladder: the live browser path climbs the real base1
// ladder (Q2_PAK-gated, like drowning.test.ts).
//
// Boots base1 through the REAL driver+server tick loop (bootPlay) and drives
// the shaft climb through normal input: walk south into the ladder's north
// face (contact engages), hold move-up to rise, hold move-down to descend.
// This covers the driver-side pmove hookup (raw C-mask trace + clips, mapped
// to pmove contents at the setPmoveWorld boundary in play.ts) — the layer
// compact-bit mocks cannot reach. Climb geometry: brush 197 slab
// x 368..408 / y 21..31 / z -242..-60; shaft mouth north at y 48..56;
// lower-room floor feet -244. Depth (top exit, pitch climb, departure,
// prediction parity) is pinned server-side in packages/server ladder.test.ts.
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars } from '@q2/config';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import { bootPlay } from './play.js';

const WEB_Q2_PAK = process.env.Q2_PAK;

function ladderCmd(
  angles: [number, number, number],
  forwardmove = 0,
  sidemove = 0,
  upmove = 0,
): UserCmdT {
  return { msec: 100, angles, forwardmove, sidemove, upmove, buttons: 0 };
}

async function bootBase1(width = 96, height = 72) {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  return bootPlay({ width, height, pak: ingestPak(buf) });
}

afterEach(() => {
  resetCVars();
});

describe.runIf(!!WEB_Q2_PAK)('driver ladder: browser climb on the live path', () => {
  it('walks into the face, climbs up on move-up, descends on move-down', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // Teleport clear of the face above the lower-room floor (the drowning
    // suite teleports the same way; walking the whole map is not the point).
    driver.pm.origin = v3(388, 90, -200);
    driver.pm.velocity = v3();
    for (let i = 0; i < 10; i++) driver.step(ladderCmd([0, 270, 0]), 0.1);
    expect(driver.pm.onGround).toBe(true);
    expect(driver.pm.origin[2]!).toBeCloseTo(-220, 0);
    // Walk south into the face: contact engages the ladder.
    let engaged = false;
    for (let i = 0; i < 10 && !engaged; i++) {
      driver.step(ladderCmd([0, 270, 0], 400, 0, 0), 0.1);
      engaged = driver.pm.ladder;
    }
    expect(engaged, 'walking into the ladder face must engage climb').toBe(true);
    // Climb up: C rises ~200u/s on move-up.
    const z0 = driver.pm.origin[2]!;
    let top = z0;
    for (let i = 0; i < 40; i++) {
      driver.step(ladderCmd([0, 270, 0], 0, 0, 200), 0.1);
      if (driver.pm.origin[2]! > top) top = driver.pm.origin[2]!;
      if (top - z0 > 100) break;
    }
    expect(top - z0, 'move-up must rise the shaft').toBeGreaterThan(100);
    // Descend on negative move-up.
    const z1 = driver.pm.origin[2]!;
    for (let i = 0; i < 30; i++) {
      driver.step(ladderCmd([0, 270, 0], 0, 0, -200), 0.1);
      if (z1 - driver.pm.origin[2]! > 40) break;
    }
    expect(z1 - driver.pm.origin[2]!, 'move-down must descend the shaft').toBeGreaterThan(40);
  });
});
