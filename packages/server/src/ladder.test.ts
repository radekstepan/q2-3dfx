// RELEASE-12 ladder regression: raw-BSP ladder through the LIVE path.
//
// The live driver feeds pmove a raw-BSP trace (SV_TraceFor with the C player
// mask, wrapped by SV_ClipTrace) plus solid-aware point contents. pmove must
// set st.ladder when that trace hits base1's ladder brush (raw contents
// 0x20000000 LADDER, q_shared.h) — compact-bit mocks (CONTENTS_LADDER = 16)
// cannot cover this boundary, so this suite runs the real base1.bsp lump
// (Q2_PAK-gated, like drowning.test.ts) through the production hookup.
//
// Ladder surveyed against the real lump: brush 197, contents 0x28030000
// (LADDER|DETAIL|PLAYERCLIP|MONSTERCLIP), slab x 368..408 / y 21..31 /
// z -242..-60. The shaft opening is on the north side (drops at y 48..56,
// x 352..416 fall to the lower room at feet -244); the climb lane hugs the
// ladder's north face (stand y ~47 facing -Y / yaw 270).
import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { PakFile } from '@q2/filesystem';
import { loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import {
  bspPointContentsFor,
  makePmoveState,
  pmoveFull,
  resetPmoveWorld,
  setPmoveWorld,
  withPmoveContents,
} from '@q2/game';
import { v3 } from '@q2/math';
import {
  SV_ClipTrace,
  SV_Init,
  SV_TraceFor,
} from './index.js';

const Q2_PAK = process.env.Q2_PAK;

function loadBase1(): BspMap {
  const bytes = readFileSync(Q2_PAK as string);
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return loadBsp(new PakFile(buf).readFile('maps/base1.bsp')) as BspMap;
}

/** Install the exact live driver hookup: raw C-mask trace + clips + contents. */
function installLivePmove(map: BspMap): ReturnType<typeof SV_Init> {
  const st = SV_Init();
  setPmoveWorld(
    withPmoveContents(SV_ClipTrace(st, SV_TraceFor(map), -1, true)),
    bspPointContentsFor(map),
  );
  return st;
}

function cmd(
  angles: [number, number, number],
  forwardmove = 0,
  sidemove = 0,
  upmove = 0,
): { msec: number; angles: Float32Array; forwardmove: number; sidemove: number; upmove: number; buttons: number } {
  return {
    msec: 100,
    angles: new Float32Array(angles),
    forwardmove,
    sidemove,
    upmove,
    buttons: 0,
  };
}

afterEach(() => {
  resetPmoveWorld();
});

describe.runIf(!!Q2_PAK)('RELEASE-12 raw-BSP ladder (live path)', () => {
  it('(t1) ladder flag engages through SV_TraceFor + SV_ClipTrace + pmoveFull', { timeout: 120000 }, () => {
    const map = loadBase1();
    installLivePmove(map);
    // Live-path facts: the C-mask probe from the climb lane hits the ladder
    // brush and reports RAW contents (this passes with or without the fix —
    // it pins the setup, not the bug).
    const raw = SV_TraceFor(map)(
      v3(388, 48, -160), v3(-16, -16, -24), v3(16, 16, 32), v3(388, 47, -160),
    );
    expect(raw.fraction).toBeLessThan(1);
    expect(raw.contents & 0x20000000).not.toBe(0);
    // The bug: pmoveFull must surface that hit as st.ladder (compact-bit
    // probe reads raw bits as 0, so this is false before the fix).
    const pm = makePmoveState();
    pm.origin = v3(388, 48, -160);
    pm.velocity = v3();
    pmoveFull(pm, cmd([0, 270, 0], 100, 0, 0));
    expect(pm.ladder).toBe(true);
  });

  it('(t2) climb up the shaft on upmove, exit onto the upper floor', { timeout: 120000 }, () => {
    const map = loadBase1();
    installLivePmove(map);
    const pm = makePmoveState();
    // Start clear of the face and settle onto the lower-room floor.
    pm.origin = v3(388, 90, -200);
    pm.velocity = v3();
    for (let i = 0; i < 10; i++) pmoveFull(pm, cmd([0, 270, 0]));
    expect(pm.onGround).toBe(true);
    expect(pm.origin[2]!).toBeCloseTo(-220, 0);
    expect(pm.ladder).toBe(false);
    // Walk south into the face through normal input: contact engages.
    let engaged = false;
    for (let i = 0; i < 10 && !engaged; i++) {
      pmoveFull(pm, cmd([0, 270, 0], 400, 0, 0));
      engaged = pm.ladder;
    }
    expect(engaged).toBe(true);
    // Climb: face the ladder (-Y), hold move-up. C rises ~200u/s here.
    // Run to probe release at the ladder top (origin ~-8, past the -60 top).
    const z0 = pm.origin[2]!;
    let sawLadder = false;
    let top = z0;
    for (let i = 0; i < 80; i++) {
      pmoveFull(pm, cmd([0, 270, 0], 0, 0, 200));
      if (pm.ladder) sawLadder = true;
      if (pm.origin[2]! > top) top = pm.origin[2]!;
      expect(Number.isFinite(pm.origin[2]!)).toBe(true);
      if (!pm.ladder && top - z0 > 100) break;
    }
    expect(sawLadder).toBe(true);
    expect(top - z0).toBeGreaterThan(100);
    expect(pm.ladder).toBe(false);
    // Top transition: the shaft mouth is open below (falling back in), so
    // walk SOUTH onto the upper floor (feet -64) / ladder nub (feet -60).
    for (let i = 0; i < 60; i++) {
      pmoveFull(pm, cmd([0, 270, 0], 400, 0, 0));
      if (!pm.ladder && pm.onGround) break;
    }
    expect(pm.ladder).toBe(false);
    expect(pm.onGround).toBe(true);
    // Out of the shaft at the upper level: the upper floor (origin -40),
    // the ladder nub (-36) or the stair tread beside the mouth (-32).
    expect(pm.origin[2]!).toBeGreaterThan(-41);
    expect(pm.origin[2]!).toBeLessThan(-20);
  });

  it('(t3) C-parity pitch climb: look up + forward rises, look down + forward descends', { timeout: 120000 }, () => {
    const map = loadBase1();
    installLivePmove(map);
    const pm = makePmoveState();
    pm.origin = v3(388, 90, -200);
    pm.velocity = v3();
    for (let i = 0; i < 10; i++) pmoveFull(pm, cmd([0, 270, 0]));
    for (let i = 0; i < 10 && !pm.ladder; i++) pmoveFull(pm, cmd([0, 270, 0], 400, 0, 0));
    expect(pm.ladder).toBe(true);
    const z0 = pm.origin[2]!;
    // qcommon/pmove.c PM_AddCurrents: pitch <= -15 (looking up) + forward
    // climbs at 200u/s with no upmove held. Break early: 30 ticks would
    // overshoot the ladder top (~200u/s).
    for (let i = 0; i < 30; i++) {
      pmoveFull(pm, cmd([-45, 270, 0], 400, 0, 0));
      if (pm.origin[2]! - z0 > 40) break;
    }
    expect(pm.origin[2]! - z0).toBeGreaterThan(40);
    // ... and pitch >= 15 (looking down) + forward descends.
    const z1 = pm.origin[2]!;
    for (let i = 0; i < 30; i++) {
      pmoveFull(pm, cmd([45, 270, 0], 400, 0, 0));
      if (z1 - pm.origin[2]! > 40) break;
    }
    expect(pm.origin[2]! - z1).toBeLessThan(-40);
  });

  it('(t4) down-climb, sideways departure and prediction parity', { timeout: 120000 }, () => {
    const map = loadBase1();
    installLivePmove(map);
    const pm = makePmoveState();
    pm.origin = v3(388, 48, -60);
    pm.velocity = v3();
    for (let i = 0; i < 5; i++) pmoveFull(pm, cmd([0, 270, 0]));
    expect(pm.ladder).toBe(true);
    // Down on negative move-up.
    const z0 = pm.origin[2]!;
    for (let i = 0; i < 30; i++) pmoveFull(pm, cmd([0, 270, 0], 0, 0, -200));
    expect(pm.origin[2]! - z0).toBeLessThan(-40);
    // Sideways departure: strafe off the face; ladder releases, hull stays
    // out of solid (never allsolid-teleports).
    for (let i = 0; i < 30; i++) pmoveFull(pm, cmd([0, 270, 0], 0, 400, 0));
    expect(pm.ladder).toBe(false);
    expect(Math.abs(pm.origin[0]! - 388)).toBeGreaterThan(20);
    // Prediction parity: replaying the same cmd stream through pmoveFull on
    // the same hooks (exactly what CL_PredictPmove does) is deterministic.
    const replay = makePmoveState();
    replay.origin = v3(388, 48, -60);
    replay.velocity = v3();
    const check = makePmoveState();
    check.origin = v3(388, 48, -60);
    check.velocity = v3();
    const stream = [
      cmd([0, 270, 0]),
      cmd([0, 270, 0], 0, 0, 200),
      cmd([0, 270, 0], 0, 0, 200),
      cmd([-45, 270, 0], 400, 0, 0),
    ];
    for (const c of stream) {
      pmoveFull(replay, c);
      pmoveFull(check, { ...c, angles: new Float32Array(c.angles) });
    }
    expect(check.origin[0]!).toBe(replay.origin[0]!);
    expect(check.origin[1]!).toBe(replay.origin[1]!);
    expect(check.origin[2]!).toBe(replay.origin[2]!);
  });
});
