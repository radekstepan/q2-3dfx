// Monster collision wiring pins (driver-level bot: real lump, real tick loop).
//
// Prior lane landed the server half (monsters SOLID_BBOX, SOLID_NOT while
// dormant, SOLID_BBOX held through the death fall and SOLID_NOT only when the
// last death frame lands — C soldier_dead/infantry_dead endfunc timing for
// SVF_DEADMONSTER — SV_MonsterClipBox + the opt-in includeMonsters pass
// defaulting off so the shared monster-tick trace never self-freezes).
// This file pins the DRIVER half: pmove runs on a split trace that SEES live
// AND DYING monsters (worldTrace stays monster-free for the monster tick,
// bolts and explosions), so:
// - walking into a live infantry hull is blocked (contact, never penetration);
// - walking into a DYING infantry hull is blocked until its fall completes;
// - dormant TRIGGER_SPAWN bodies pass through until the wake, then block;
// - settled corpses (misc_deadsoldier, C SVF_DEADMONSTER skip) never block;
// - movers still move (the split never starves the mover trace).
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars } from '@q2/config';
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

function gap2D(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);
}

afterEach(() => {
  resetCVars();
});

describe.runIf(!!WEB_Q2_PAK)('base1 monster collision (Q2_PAK)', () => {
  it('live infantry impedes the walk; dead it walks through (hull, not a wall)', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // Live courtyard infantry (skill-1 roster; awake).
    const inf = driver.server.monsters.find((m) => m.edict.num === 367)!;
    expect(inf).toBeDefined();
    expect(inf.triggered).toBe(false);
    expect(inf.state.dead).toBe(false);
    // The chaser beelines at 12-20u/tick and has no player clip (C-authentic:
    // it can step into our cell), so no gap is pinned on live legs — only
    // OUR westward displacement, tracked as the westmost reach (monotonic,
    // immune to shoves). The corpse leg is the wall control.
    const walkWestFrom = (x: number, y: number, z: number, ticks: number): number => {
      driver.pm.origin = v3(x, y, z);
      driver.pm.velocity = v3();
      stepDriver(driver, neutralCmd(), 1);
      expect(driver.pm.onGround).toBe(true);
      let minX = driver.pm.origin[0]!;
      // Park the hull in the lane (setup touch, gate-(i) class): the new
      // per-monster locomotion maneuvers the chaser off the straight lane
      // (it trails north and the walker outruns it), so without parking
      // the live leg measures a footrace, not a hull. The verdict below is
      // OUR displacement against the live SOLID_BBOX hull, which thinks
      // and attacks throughout (heals hold the walker alive).
      const station = v3(inf.edict.origin[0]!, inf.edict.origin[1]!, inf.edict.origin[2]!);
      for (let i = 0; i < ticks; i++) {
        SV_SetPlayerHealth(driver.server, 100); // setup: hold the walker alive
        inf.edict.origin = v3(station[0], station[1], station[2]);
        driver.step({ msec: 100, angles: [0, 180, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
        minX = Math.min(minX, driver.pm.origin[0]!);
      }
      return x - minX;
    };
    // Stage 80u east at rest height (1 settle tick: the chaser closes a
    // little, never onto us), then 12 westward ticks (240u commanded).
    const liveReach = walkWestFrom(inf.edict.origin[0]! + 80, inf.edict.origin[1]!, inf.edict.origin[2]!, 12);
    // First tick always covers ~20u (gap 60+), then the hull stalls us.
    expect(liveReach).toBeGreaterThan(0);
    expect(driver.pm.onGround).toBe(true);
    expectInWorld(driver.pm.origin, driver.map!);
    // Kill it with aimed blaster fire: the corpse persists but drops the
    // clip (C SVF_DEADMONSTER skip).
    let killTicks = 0;
    while (!inf.state.dead && killTicks++ < 80 && driver.playerHealth > 0) {
      SV_SetPlayerHealth(driver.server, 100);
      const e = [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + 22];
      const c = [inf.edict.origin[0]!, inf.edict.origin[1]!, inf.edict.origin[2]! + 4];
      const dx = c[0]! - e[0]!;
      const dy = c[1]! - e[1]!;
      const dz = c[2]! - e[2]!;
      const l = Math.hypot(dx, dy) || 1;
      const aim: [number, number, number] = [(Math.atan2(-dz, l) * 180) / Math.PI, (Math.atan2(dy, dx) * 180) / Math.PI, 0];
      driver.step({ msec: 100, angles: aim, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 1 }, 0.1);
    }
    expect(inf.state.dead).toBe(true);
    // Dying leg: the fall still blocks (C deadflag DEAD_DEAD without
    // SVF_DEADMONSTER yet). Four westward ticks — inside even the shortest
    // fall (death3, 9 frames) — must stall at the hull like the live leg.
    {
      const dying = v3(inf.edict.origin[0]!, inf.edict.origin[1]!, inf.edict.origin[2]!);
      driver.pm.origin = v3(dying[0]! + 80, dying[1]!, dying[2]!);
      driver.pm.velocity = v3();
      stepDriver(driver, neutralCmd(), 1);
      const x0 = driver.pm.origin[0]!;
      let dyingGap = Infinity;
      for (let i = 0; i < 4; i++) {
        SV_SetPlayerHealth(driver.server, 100);
        driver.step({ msec: 100, angles: [0, 180, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
        dyingGap = Math.min(dyingGap, gap2D(driver.pm.origin, inf.edict.origin));
      }
      const dyingReach = x0 - driver.pm.origin[0]!;
      expect(dyingReach).toBeLessThan(liveReach + 40);
      expect(dyingGap).toBeGreaterThanOrEqual(28); // hull contact, no penetration
      expect(driver.pm.onGround).toBe(true);
    }
    // Let the fall complete (the C endfunc drops the hull at the last death
    // frame — up to 25 ticks for death2, plus margin).
    {
      let n = 0;
      while (!inf.state.deadDone && n++ < 60) {
        SV_SetPlayerHealth(driver.server, 100);
        driver.step(neutralCmd(), 0.1);
      }
      expect(inf.state.deadDone).toBe(true);
    }
    // Same walk past the settled corpse: near-free advance straight through
    // the 32-wide box — far beyond the live reach, so the leg-1 stall was
    // the live hull, not a wall.
    const corpse = v3(inf.edict.origin[0]!, inf.edict.origin[1]!, inf.edict.origin[2]!);
    driver.pm.origin = v3(corpse[0]! + 80, corpse[1]!, corpse[2]!);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 1);
    const x1 = driver.pm.origin[0]!;
    let minX = x1;
    let minGap = Infinity;
    for (let i = 0; i < 12; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step({ msec: 100, angles: [0, 180, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
      minX = Math.min(minX, driver.pm.origin[0]!);
      minGap = Math.min(minGap, gap2D(driver.pm.origin, corpse));
    }
    const deadReach = x1 - minX;
    expect(deadReach).toBeGreaterThan(liveReach + 80);
    expect(deadReach).toBeGreaterThan(150);
    expect(minGap).toBeLessThan(20);
    expect(driver.pm.onGround).toBe(true);
    expectInWorld(driver.pm.origin, driver.map!);
  });

  it('dormant t55 body passes through until the shotgun wakes it, then blocks', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // The t55 "pair" shares one targetname from two stations: walk ONE body
    // (305, exit hall — 240u of clear line west). Dormant bodies never move
    // (no think until monster_triggered_spawn_use), so the dormant leg is
    // fully deterministic; the woken leg pins OUR displacement only (the
    // chaser has no player clip, like the infantry leg above).
    const body = driver.server.monsters.find((m) => m.edict.targetname === 't55' && m.edict.num === 305)!;
    expect(body).toBeDefined();
    expect(body.triggered && !body.woken).toBe(true);
    // Dormant station (the body never moves until woken — capture now).
    const station = v3(body.edict.origin[0]!, body.edict.origin[1]!, body.edict.origin[2]!);
    // The sibling station (same targetname, far away — captured so the wake
    // leg can park it back out of the way).
    const other = driver.server.monsters.find((m) => m.edict.targetname === 't55' && m.edict.num !== 305)!;
    expect(other).toBeDefined();
    const otherStation = v3(other.edict.origin[0]!, other.edict.origin[1]!, other.edict.origin[2]!);
    const walkWest = (ticks: number): { reach: number; minGap: number } => {
      driver.pm.origin = v3(body.edict.origin[0]! + 80, body.edict.origin[1]!, body.edict.origin[2]!);
      driver.pm.velocity = v3();
      stepDriver(driver, neutralCmd(), 2);
      expect(driver.pm.onGround).toBe(true);
      const x0 = driver.pm.origin[0]!;
      let minX = x0;
      let minGap = Infinity;
      for (let i = 0; i < ticks; i++) {
        SV_SetPlayerHealth(driver.server, 100);
        driver.step({ msec: 100, angles: [0, 180, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
        minX = Math.min(minX, driver.pm.origin[0]!);
        minGap = Math.min(minGap, gap2D(driver.pm.origin, body.edict.origin));
      }
      return { reach: x0 - minX, minGap };
    };
    // Dormant (SOLID_NOT in C): full advance straight through the hull, and
    // the flat-ground control for the woken leg (no wall here).
    const dormant = walkWest(12);
    expect(dormant.reach).toBeGreaterThan(150);
    expect(dormant.minGap).toBeLessThan(20);
    expectInWorld(driver.pm.origin, driver.map!);
    // Wake it the way the game does: the shotgun pickup fires t55
    // (Touch_Item target — gate (h) pattern, exact lump origin).
    driver.pm.origin = v3(800, -96, -168);
    driver.pm.velocity = v3();
    let n = 0;
    while (!driver.events.includes('pickup') && n++ < 20) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
    }
    expect(driver.events).toContain('pickup');
    expect(body.woken).toBe(true);
    // Both woken bodies chased us across the map while we fetched the gun
    // (either could be hugging our staged cell and wedging the leg), so park
    // each back at its station for an exact-geometry leg (setup touch like
    // gate (i)'s runner placement; the verdict is OUR displacement).
    body.edict.origin = v3(station[0], station[1], station[2]);
    body.state.move = 'run';
    body.state.frame = 0;
    other.edict.origin = v3(otherStation[0], otherStation[1], otherStation[2]);
    other.state.move = 'run';
    other.state.frame = 0;
    // Woken (SOLID_BBOX): the same walk stalls far short of the dormant
    // reach. Either 305 head-on or a hugging chaser (370 trails this hall
    // and can be on the staged cell — also a live hull) stops us where the
    // dormant body let us pass; reach 0 (wedged by a hug) is blocking too,
    // so only the upper bound is pinned, plus never leaving the world.
    const woken = walkWest(8);
    expect(woken.reach).toBeLessThan(dormant.reach - 60);
    expectInWorld(driver.pm.origin, driver.map!);
  });

  it('corpses never block (C SVF_DEADMONSTER skip): walk straight through', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // Door-debris corpse by the start lines (gate (p) roster).
    const corpse = driver.server.entities.find(
      (e) => !e.freed && e.classname === 'misc_deadsoldier' && Math.abs(e.origin[0]! - 40) < 2 && Math.abs(e.origin[1]! - 272) < 2,
    )!;
    expect(corpse).toBeDefined();
    driver.pm.origin = v3(corpse.origin[0]! + 70, corpse.origin[1]!, corpse.origin[2]! + 60);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 10);
    expect(driver.pm.onGround).toBe(true);
    let minGap = Infinity;
    const x0 = driver.pm.origin[0]!;
    for (let i = 0; i < 25; i++) {
      driver.step({ msec: 100, angles: [0, 180, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
      minGap = Math.min(minGap, gap2D(driver.pm.origin, corpse.origin));
    }
    // Passed through the 32-wide corpse box (a live hull would stop at 32).
    expect(minGap).toBeLessThan(20);
    expect(x0 - driver.pm.origin[0]!).toBeGreaterThan(60);
    expect(driver.pm.onGround).toBe(true);
    expectInWorld(driver.pm.origin, driver.map!);
  });

  it('the exit plug *31 never opens on touch (C SP_func_door: sliders open, plug shut)', { timeout: 180000 }, async () => {
    // RELEASE-4 C-parity reroute (base1-gate (r)/(t)): the targetname'd *31
    // plug owns no touch trigger in C SP_func_door, so camping the hall
    // opens and parks the *32/*33 sliders while the plug sits at pos1. The
    // old revision of this test asserted the opposite (plug travels 156 on
    // touch) and failed even pristine — that behavior was the bug, not the
    // pin. The mover split still gets its coverage: the sliders genuinely
    // travel while the plug never moves.
    const boot = await bootBase1();
    const { driver } = boot;
    const mag3 = (o: [number, number, number]): number => Math.hypot(o[0]!, o[1]!, o[2]!);
    expect(mag3(driver.doorRenderOffset('*31')!)).toBeLessThan(0.01);
    // Camp the hall the way the game does: the body overlaps the *32/*33
    // rest volumes (C rest-baked Touch_DoorTrigger), never a *31 trigger
    // (there is none — targetname'd doors skip it in C).
    driver.pm.origin = v3(-1669, 1514, 120);
    driver.pm.velocity = v3();
    let sliderTravel = 0;
    let plugTravel = 0;
    for (let i = 0; i < 120; i++) {
      SV_SetPlayerHealth(driver.server, 100); // setup: hold the camper alive
      driver.step(neutralCmd(), 0.1);
      sliderTravel = Math.max(
        sliderTravel,
        mag3(driver.doorRenderOffset('*32')!),
        mag3(driver.doorRenderOffset('*33')!),
      );
      plugTravel = Math.max(plugTravel, mag3(driver.doorRenderOffset('*31')!));
    }
    // Non-vacuous: the sliders genuinely travelled (64u sideways each) ...
    expect(sliderTravel).toBeGreaterThan(30);
    // ... while the plug never moved a unit (mover trace unaffected by the
    // split: sliders still actuate; the plug simply has no touch path).
    expect(plugTravel).toBeLessThan(0.01);
    expect(mag3(driver.doorRenderOffset('*31')!)).toBeLessThan(0.01);
  });
});
