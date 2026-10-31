// Final-elevator report repro (driver loop: real lump, real tick loop).
//
// Report: "as door opens elevator rides down". Server audit (real-data, in
// tree): the *12 func_train waits on t91 (target t88 → t89 (wait .5) → t90,
// one-way); the *13 func_button (wait -1) fires t91; the *32/*33 entry doors
// carry no train target (*32's t75 dangles). RELEASE-4 C-parity: the
// targetname'd *31 plug owns NO touch trigger in C SP_func_door, so camping
// the hall opens and parks the *32/*33 sliders while the plug sits at pos1
// (pre-R4 revisions asserting touch opens the plug encoded the bug, not the
// pin). The plug's C-intended opener is the *34 platform button: it rides
// DOWN 156 on t4 and returns after the C-default hold. So the only moving
// "elevator" on door-open is never the lift: the reporter conflated the
// plug with the lift (or saw the plug's C-correct descent). This file pins
// the C-correct behavior in the driver loop:
// - camping the hall parks the sliders, leaves the plug shut, fires no t91,
//   and the *12 sim origin + rendered mesh stay parked while the doors cycle;
// - walking in through *32 cycles the entry doors with the lift parked;
// - the *34 press drops the plug 156, holds ~3s, and returns (default wait),
//   i.e. "ride up and wait for button" = the TRAIN waits for *13; the plug
//   never auto-runs the lift;
// - E-USEing *13 fires t91, the train traverses the full leg (mid-leg motion
//   observed — not a teleport), arrives (-16,0,40), and parks; the wait -1
//   button holds TOP (offset [0,0,4]).
// No driver fan-out was found: no fix, just pins (gates (r)/(t)/(u)/(v) cover
// the same complex and stay green).
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars } from '@q2/config';
import { BUTTON_USE } from '@q2/input';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import type { BspMap } from '@q2/bsp';
import { SV_SetPlayerHealth } from '@q2/server';
import { bootPlay } from './play.js';
import type { LocalDriver } from './play.js';

const WEB_Q2_PAK = process.env.Q2_PAK;

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

function stepDriver(driver: LocalDriver, cmd: UserCmdT, n: number): void {
  for (let i = 0; i < n; i++) driver.step(cmd, 0.1);
}

async function bootBase1(width = 96, height = 72) {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  return bootPlay({ width, height, pak: ingestPak(buf) });
}

function expectInWorld(origin: Vec3, map: BspMap): void {
  const mins = [...map.modelsMins.slice(0, 3)];
  const maxs = [...map.modelsMaxs.slice(0, 3)];
  for (let i = 0; i < 3; i++) {
    expect(origin[i]!).toBeGreaterThanOrEqual(mins[i]! - 32);
    expect(origin[i]!).toBeLessThanOrEqual(maxs[i]! + 32);
  }
}

function mag3(o: [number, number, number]): number {
  return Math.hypot(o[0]!, o[1]!, o[2]!);
}

afterEach(() => {
  resetCVars();
});

describe.runIf(!!WEB_Q2_PAK)('final elevator report repro (Q2_PAK)', () => {
  it('door-open never runs the lift; E-USE *13 runs it once and parks; plug is C-correct', { timeout: 240000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const train = driver.server.trains.find((t) => t.ent.model === '*12')!;
    expect(train).toBeDefined();
    expect(train.ent.target).toBe('t88');
    expect(train.ent.targetname).toBe('t91');
    const btn13 = driver.server.movers.find((m) => m.ent.model === '*13')!;
    expect(btn13.ent.target).toBe('t91');
    const off = (m: string): [number, number, number] => driver.doorRenderOffset(m)!;
    // Parked at spawn: sim origin, mesh offset, unstarted.
    expect([...train.ent.origin]).toEqual([0, 0, 0]);
    expect(train.started).toBe(false);
    expect(off('*12')).toEqual([0, 0, 0]);

    // Phase 1 — camp the hall the way the game does (RELEASE-4 C-parity:
    // the targetname'd *31 plug owns no touch trigger in C SP_func_door,
    // so the body overlaps the *32/*33 rest volumes while the plug sits
    // at pos1 and the lift never starts — pre-R4 revisions of this phase
    // parked at (-1774,1536,104) asserting touch opens the plug, which was
    // the bug, not the pin).
    const fired = new Set<string>();
    driver.pm.origin = v3(-1669, 1514, 120);
    driver.pm.velocity = v3();
    let sliderTravel = 0;
    let plugTravel = 0;
    for (let i = 0; i < 100; i++) {
      SV_SetPlayerHealth(driver.server, 100); // setup: hold the camper alive
      driver.step(neutralCmd(), 0.1);
      for (const t of driver.server.firedThisTick) fired.add(t);
      sliderTravel = Math.max(
        sliderTravel,
        mag3(off('*32')),
        mag3(off('*33')),
      );
      plugTravel = Math.max(plugTravel, mag3(off('*31')));
      // The lift never starts while the doors park.
      expect(train.started).toBe(false);
      expect([...train.ent.origin]).toEqual([0, 0, 0]);
      expect(off('*12')).toEqual([0, 0, 0]);
    }
    // Non-vacuous: the sliders genuinely travelled open (64u sideways) and
    // parked — while the plug never moved a unit and no relay fired.
    expect(sliderTravel).toBeGreaterThan(30);
    expect(plugTravel).toBeLessThan(0.01);
    expect(fired.has('t91')).toBe(false);

    // Phase 2 — walk in through the *32/*33 entry doors (real walk-in).
    driver.pm.origin = v3(-1560, 1536, 150);
    driver.pm.velocity = v3();
    let doorCycle = 0;
    for (let i = 0; i < 120 && driver.playerHealth > 0; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step({ msec: 100, angles: [0, 180, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
      for (const t of driver.server.firedThisTick) fired.add(t);
      doorCycle = Math.max(doorCycle, mag3(off('*32')));
      expect(train.started).toBe(false);
      expect([...train.ent.origin]).toEqual([0, 0, 0]);
      expect(off('*12')).toEqual([0, 0, 0]);
    }
    expect(doorCycle).toBeGreaterThan(30);
    expect(fired.has('t91')).toBe(false);

    // Phase 3 — the C-intended plug opener: press the *34 platform button
    // (gate (t) pattern). The plug drops the full 156 on the press, holds
    // the C-default ~3s at the top, and returns — while the lift sits out
    // the whole cycle. The reported "elevator rides down" is this
    // C-correct plug motion, never the lift.
    const plug = driver.server.movers.find((m) => m.ent.model === '*31')!;
    const btn34 = driver.server.movers.find((m) => m.ent.model === '*34')!;
    expect(btn34.wait).toBe(3); // C SP_func_button default (not 1)
    driver.pm.origin = v3(-1860, 1536, 150);
    driver.pm.velocity = v3();
    let t4seen = false;
    for (let i = 0; i < 10 && !t4seen; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
      for (const t of driver.server.firedThisTick) fired.add(t);
      if (driver.server.firedThisTick.includes('t4')) t4seen = true;
    }
    expect(t4seen, 'the alcove press fired t4').toBe(true);
    expect(btn34.state).not.toBe('bottom');
    // Leave the overlap at once: a parked rider would re-fire t4 every
    // button cycle and stretch the door's hold.
    driver.pm.origin = v3(-1669, 1514, 120);
    driver.pm.velocity = v3();
    let guard = 0;
    while (plug.ent.origin[2]! > -155 && guard++ < 100) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
      for (const t of driver.server.firedThisTick) fired.add(t);
      expect(driver.server.firedThisTick.includes('t4')).toBe(false);
    }
    expect(plug.ent.origin[2]!).toBeCloseTo(-156, 0);
    plugTravel = Math.max(plugTravel, mag3(off('*31')));
    expect(plugTravel).toBeGreaterThan(100);
    expect(train.started).toBe(false);
    expect([...train.ent.origin]).toEqual([0, 0, 0]);
    // Intended wait at the top: the C-default hold (~3s), then the return.
    let holdTicks = 0;
    guard = 0;
    while (plug.state !== 'bottom' && guard++ < 400) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
      for (const t of driver.server.firedThisTick) fired.add(t);
      expect(driver.server.firedThisTick.includes('t4')).toBe(false);
      if (plug.state === 'waiting' || plug.state === 'top') holdTicks++;
      expect(train.started).toBe(false);
    }
    expect(holdTicks).toBeGreaterThanOrEqual(28);
    expect(holdTicks).toBeLessThanOrEqual(32);
    expect([...plug.ent.origin]).toEqual([...plug.pos1]);
    expect(off('*31')).toEqual([0, 0, 0]);
    expect(fired.has('t91')).toBe(false);

    // Phase 4 — E-USE the *13 call button in reach, aimed (gate (v) pattern:
    // reach + facing cone + wall-checked LOS through SV_UseButton).
    driver.pm.origin = v3(-2030, 1536, -24);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 10);
    const aimAt = (tx: number, ty: number, tz: number): [number, number, number] => {
      const e = [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + 22];
      const dx = tx - e[0]!, dy = ty - e[1]!, dz = tz - e[2]!;
      const l = Math.hypot(dx, dy) || 1;
      return [(Math.atan2(-dz, l) * 180) / Math.PI, (Math.atan2(dy, dx) * 180) / Math.PI, 0];
    };
    const eventsBefore = driver.events.length;
    driver.step({ msec: 100, angles: aimAt(-2016, 1536, 80), forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_USE }, 0.1);
    expect(driver.events.slice(eventsBefore)).toContain('use');
    expect(btn13.state).toBe('going_up');
    // The button fires t91 on reaching TOP (id button_wait, one tick later).
    const window91 = new Set<string>();
    stepDriver(driver, neutralCmd(), 3);
    for (const t of driver.server.firedThisTick) window91.add(t);
    // Full leg to arrival: mid-leg traversal observed (not a teleport), the
    // rendered mesh tracking the sim origin bit-exactly every tick.
    let peak = 0;
    let midLeg = false;
    for (let i = 0; i < 60 && !train.arrived; i++) {
      driver.step(neutralCmd(), 0.1);
      const o = train.ent.origin;
      const moved = Math.abs(o[0]!) + Math.abs(o[1]!) + Math.abs(o[2]!);
      peak = Math.max(peak, moved);
      if (moved > 1 && moved < 55) midLeg = true;
      const mesh = off('*12');
      expect(mesh[0]!).toBeCloseTo(o[0]!, 6);
      expect(mesh[1]!).toBeCloseTo(o[1]!, 6);
      expect(mesh[2]!).toBeCloseTo(o[2]!, 6);
    }
    expect(train.started).toBe(true);
    expect(train.arrived).toBe(true);
    expect(peak).toBeGreaterThan(10);
    expect(midLeg).toBe(true);
    // Arrival: far corner t90 (-2080,1472,-8) minus brush-mins base
    // (-2064,1472,-48) = (-16, 0, 40), rendered and simulated identically.
    expect(train.ent.origin[0]!).toBeCloseTo(-16, 6);
    expect(train.ent.origin[1]!).toBeCloseTo(0, 6);
    expect(train.ent.origin[2]!).toBeCloseTo(40, 6);
    // Wait -1 holds the button TOP forever (never returns to BOTTOM).
    expect(btn13.state).toBe('top');
    for (let i = 0; i < 50; i++) driver.step(neutralCmd(), 0.1);
    expect(btn13.state).toBe('top');
    expect(off('*13')).toEqual([0, 0, 4]);
    // Parks with nobody aboard: 100 ticks, zero further motion.
    const endOff = off('*12');
    for (let i = 0; i < 100; i++) {
      driver.step(neutralCmd(), 0.1);
      expect(off('*12')).toEqual(endOff);
    }
    expect(train.arrived).toBe(true);
    expect(driver.events).not.toContain('exit');
    expectInWorld(driver.pm.origin, driver.map!);
  });
});
