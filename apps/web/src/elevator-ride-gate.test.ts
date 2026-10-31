// RELEASE-4 ELEVATOR APPROACH GATE (box 3, apps/web lane — map-truth revision).
//
// Extends the real-base1 play-verified gate along the final-lift approach:
// walk from outside through the doorway with normal locomotion (no teleports,
// no noclip), clear the walkway guard, and advance to the shaft's west rock
// face. The waiting *12 deck itself is NOT boardable in the original map:
// its track is entombed in world rock (hull-face at x=-2048, z 0..190+),
// its SP call button *13 is entombed under the walkway, and its autostart
// (trigger_always → t91) is skill-inhibited in SP — all verified against the
// lump/brush data (see probes in the lane report). Boarding/riding the deck
// therefore cannot be proven without altering id's map, and is recorded as
// the box-3 prerequisite (BRAIN.md §8) instead of being faked.
//
// What this gate DOES prove with real ticks: the full walkable approach
// (legs 1-2, guard kill), the documented western limit (hull stops on WORLD
// rock — entityNum 0, never a mover clip — so no future "fix" may delete
// mover collision or teleport to pass), no premature departure (train
// parked/frozen throughout), no spurious finish, and a live sim (walks back
// east afterwards). Rider-carry mechanics once aboard are proven separately
// by the server pmove-rider test (setup teleport, real ticks after).
//
// Intended-control evidence (lump + target chain, cf. packages/server/src/
// base1.test.ts WIRE-EXIT notes): *12 func_train targetname t91 target t88
// speed 40, corners t88→t89 (wait .5)→t90 one-way; *13 func_button target t91
// wait -1 health 1 (no touch — E-use or shot only). Only the aimed *13 use
// runs the lift (gate (v) no-fan-out pattern).
//
// Route (BFS-validated walkable at feet 96, pins in this file): the hall
// entry doors (*32/*33) open by touch but the targetname'd *31 plug owns no
// trigger (C SP_func_door) and stays shut — the C-correct dead end. The live
// route rounds the complex south (hall → south corridor → west → north to
// the walkway), which ends at the shaft's west rock face. The *12 deck slot
// past that face is world rock in the original map (no doorway, no opening),
// so the walk stops at the hull-face with the lift parked — the documented
// limit pinned below. Finish fires on the t91 press (server SV_FinishLevel
// 'lift', incl. its target_secret); the ride completes under the finished
// screen (intermission-lite: input frozen, sim keeps ticking).
//
// Leg verdicts are rendered/sim state (snapshot/offsets/message/HUD), never
// bare internals for the pass/fail. Setup teleports to leg starts (file
// convention); every leg itself moves only via the driver's normal
// locomotion/step path. The documented western limit below FAILS OPEN if the
// rock is ever altered: the blocker-entity assert pins world rock (ent 0),
// so deleting mover collision cannot pass it, and no teleport is used.
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars } from '@q2/config';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import type { BspMap } from '@q2/bsp';
import { SV_SetPlayerHealth, SV_ClipTrace, SV_TraceFor } from '@q2/server';
import { bootPlay } from './play.js';
import type { LocalDriver } from './play.js';

const WEB_Q2_PAK = process.env.Q2_PAK;

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

function attackCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 1 };
}

function yawAt(from: [number, number], to: [number, number]): number {
  return (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
}

function mag3(o: [number, number, number]): number {
  return Math.hypot(o[0]!, o[1]!, o[2]!);
}

function expectInWorld(origin: Vec3, map: BspMap): void {
  const mins = [...map.modelsMins.slice(0, 3)];
  const maxs = [...map.modelsMaxs.slice(0, 3)];
  for (let i = 0; i < 3; i++) {
    expect(origin[i]!).toBeGreaterThanOrEqual(mins[i]! - 32);
    expect(origin[i]!).toBeLessThanOrEqual(maxs[i]! + 32);
  }
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

interface WalkReport {
  reached: boolean;
  ticks: number;
  /** ticks with <0.5u movement (beyond pusher grace these fail the leg) */
  stuckFrames: number;
  track: Array<[number, number, number]>;
}

/** Steer the driver toward (tx,ty) with normal locomotion (yaw + forward). */
function walkTo(
  driver: LocalDriver,
  tx: number,
  ty: number,
  cap: number,
  arriveRadius = 24,
): WalkReport {
  const track: Array<[number, number, number]> = [[driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]!]];
  let stuckFrames = 0;
  let last: [number, number] = [driver.pm.origin[0]!, driver.pm.origin[1]!];
  let ticks = 0;
  let reached = false;
  while (ticks++ < cap) {
    SV_SetPlayerHealth(driver.server, 100); // setup: hold the walker alive
    const yaw = yawAt([driver.pm.origin[0]!, driver.pm.origin[1]!], [tx, ty]);
    driver.step({ msec: 100, angles: [0, yaw, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
    const px = driver.pm.origin[0]!;
    const py = driver.pm.origin[1]!;
    if (Math.hypot(px - last[0]!, py - last[1]!) < 0.5) stuckFrames++;
    last = [px, py];
    if (ticks % 10 === 0) track.push([px, py, driver.pm.origin[2]!]);
    if (Math.hypot(px - tx, py - ty) < arriveRadius) {
      reached = true;
      track.push([px, py, driver.pm.origin[2]!]);
      break;
    }
  }
  return { reached, ticks, stuckFrames, track };
}

/** Kill the nearest live blocker within radius (aimed blaster, bounded). */
function killNear(driver: LocalDriver, x: number, y: number, radius: number, cap = 60): boolean {
  for (let i = 0; i < cap; i++) {
    const live = driver.server.monsters.filter(
      (m) => !m.state.dead && !m.state.gibbed && !(m.triggered && !m.woken) &&
        Math.hypot(m.edict.origin[0]! - x, m.edict.origin[1]! - y) < radius,
    );
    if (live.length === 0) return true;
    const target = live.sort(
      (a, b) =>
        Math.hypot(a.edict.origin[0]! - x, a.edict.origin[1]! - y) -
        Math.hypot(b.edict.origin[0]! - x, b.edict.origin[1]! - y),
    )[0]!;
    SV_SetPlayerHealth(driver.server, 100);
    const e = [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + 22];
    const ducked = target.state.move === 'duck';
    const c = [target.edict.origin[0]!, target.edict.origin[1]!, target.edict.origin[2]! + (ducked ? -12 : 4)];
    const dx = c[0]! - e[0]!;
    const dy = c[1]! - e[1]!;
    const dz = c[2]! - e[2]!;
    const l = Math.hypot(dx, dy) || 1;
    driver.step(attackCmd([(Math.atan2(-dz, l) * 180) / Math.PI, (Math.atan2(dy, dx) * 180) / Math.PI, 0]), 0.1);
  }
  return driver.server.monsters.every(
    (m) => m.state.dead || m.state.gibbed || (m.triggered && !m.woken) ||
      Math.hypot(m.edict.origin[0]! - x, m.edict.origin[1]! - y) >= radius,
  );
}

describe.runIf(!!WEB_Q2_PAK)('RELEASE-4 elevator approach (Q2_PAK)', () => {
  it('hall -> doorway -> walkway -> documented rock-face limit', { timeout: 300000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const map = driver.map!;
    const route: Record<string, Array<[number, number, number]>> = {};

    // ---- intended-control + parked-lift pins (lump truth, WIRE-EXIT §) ----
    const train = driver.server.trains.find((t) => !t.ship)!;
    expect(train.ent.model).toBe('*12');
    expect(train.ent.targetname).toBe('t91');
    expect(train.ent.target).toBe('t88');
    expect(train.speed).toBe(40);
    expect(train.corners.map((c) => c.name)).toEqual(['t88', 't89', 't90']);
    expect(train.corners[1]!.wait).toBeCloseTo(0.5, 1);
    const btn13 = driver.server.movers.find((m) => m.ent.model === '*13')!;
    expect(btn13.ent.target).toBe('t91');
    expect(btn13.wait).toBe(-1);
    expect([...train.ent.origin]).toEqual([0, 0, 0]);
    expect(train.started).toBe(false);
    expect(train.arrived).toBe(false);
    expect(driver.doorRenderOffset('*12')).toEqual([0, 0, 0]);
    const seg0 = train.seg;

    // ---- leg 1: hall through the entry doorway (touch opens *32/*33) ----
    driver.pm.origin = v3(-1560, 1536, 150);
    driver.pm.velocity = v3();
    const off = (m: string): [number, number, number] => driver.doorRenderOffset(m)!;
    let doorCycle = 0;
    const leg1Start: [number, number, number] = [...driver.pm.origin] as [number, number, number];
    {
      let lastX = driver.pm.origin[0]!;
      let stuck = 0;
      // Walk into the slot (past the slab east face -1680); the C-correct
      // plug stops further travel, so the leg ends at the crossing.
      for (let i = 0; i < 200 && driver.pm.origin[0]! > -1681; i++) {
        SV_SetPlayerHealth(driver.server, 100);
        driver.step({ msec: 100, angles: [0, 180, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
        doorCycle = Math.max(doorCycle, mag3(off('*32')), mag3(off('*33')));
        // no premature departure while the entry doors cycle
        expect(train.started).toBe(false);
        expect(train.seg).toBe(seg0);
        expect([...train.ent.origin]).toEqual([0, 0, 0]);
        if (Math.abs(driver.pm.origin[0]! - lastX) < 0.5) stuck++;
        lastX = driver.pm.origin[0]!;
      }
      route['leg1-hall-doors'] = [leg1Start, [...driver.pm.origin] as [number, number, number]];
      // Non-vacuous: the doors genuinely cycled open by touch on the walk-in.
      // The crosser outruns the 64u slabs, so hold the slot (the camp parks
      // them open — gate (t) pattern) until the travel is unambiguous.
      for (let i = 0; i < 100 && doorCycle <= 30; i++) {
        SV_SetPlayerHealth(driver.server, 100);
        driver.step(neutralCmd(), 0.1);
        doorCycle = Math.max(doorCycle, mag3(off('*32')), mag3(off('*33')));
        expect(train.started).toBe(false);
        expect(train.seg).toBe(seg0);
        expect([...train.ent.origin]).toEqual([0, 0, 0]);
      }
      expect(doorCycle).toBeGreaterThan(30);
      // Entered the doorway slot (past the slab east face); the targetname'd
      // *31 plug owns no touch trigger and stays shut behind it (C-correct).
      expect(driver.pm.origin[0]!).toBeLessThanOrEqual(-1680);
      expect(driver.pm.origin[0]!).toBeGreaterThan(-1720);
      expect(stuck).toBeLessThanOrEqual(10); // forward progress, pusher grace
      expect(train.started).toBe(false);
    }

    // ---- leg 2: round the complex south to the walkway (BFS waypoints) ----
    const wps: Array<[number, number]> = [
      [-1603, 1413],
      [-1689, 1327],
      [-1817, 1327],
      [-1945, 1327],
      [-1962, 1362],
      [-1975, 1410],
      [-1977, 1455],
      [-1977, 1519],
    ];
    route['leg2-south'] = [[...driver.pm.origin] as [number, number, number]];
    for (const [wx, wy] of wps) {
      const rep = walkTo(driver, wx, wy, 300);
      console.log(`LEG2 leg to [${wx},${wy}]: reached=${rep.reached} stuck=${rep.stuckFrames}`);
      route['leg2-south'].push(...rep.track);
      expect(rep.reached).toBe(true);
      // forward progress per leg (small pusher/monster grace, never a stall)
      expect(rep.stuckFrames).toBeLessThanOrEqual(15);
      expect(train.started).toBe(false);
      expect(train.seg).toBe(seg0);
      expect([...train.ent.origin]).toEqual([0, 0, 0]);
      expectInWorld(driver.pm.origin, map);
    }
    const walkway: [number, number, number] = [...driver.pm.origin] as [number, number, number];
    expect(Math.hypot(walkway[0]! + 1977, walkway[1]! - 1519)).toBeLessThan(30);
    expect(driver.pm.onGround).toBe(true);

    // ---- leg 3: clear the walkway guard, advance to the documented limit ----
    // The exit guard hunts the walkway and body-blocks the west end: kill it
    // with normal fire first.
    expect(killNear(driver, walkway[0]!, walkway[1]!, 160)).toBe(true);
    const approachFrom: [number, number, number] = [...driver.pm.origin] as [number, number, number];
    const leg3track: Array<[number, number, number]> = [approachFrom];
    // Walk due west toward the shaft at walkway level. Map truth (brush
    // data): the *12 deck slot past x=-2048 is world rock (z 0..190+), so a
    // live body must stop at the hull-face with the lift still parked.
    const repWest = walkTo(driver, -2060, 1519, 300);
    leg3track.push(...repWest.track);
    console.log('LEG3 track: ' + leg3track.map((p) => `[${p.map((v) => v.toFixed(1)).join(',')}]`).join(' '));
    console.log(`LEG3 final=[${[...driver.pm.origin].map((v: number) => v.toFixed(1))}] onGround=${driver.pm.onGround} reached=${repWest.reached}`);
    // The documented western limit: the walk ends at the rock hull-face
    // (origin -2032 = face -2048 + hull 16, ±8 probe tolerance), grounded,
    // with the lift parked — never departed, never finished.
    expect(repWest.reached).toBe(false);
    expect(driver.pm.origin[0]!).toBeGreaterThan(-2045);
    expect(driver.pm.origin[0]!).toBeLessThan(-2015);
    expect(driver.pm.onGround).toBe(true);
    expect(train.started).toBe(false);
    expect(train.seg).toBe(seg0);
    expect([...train.ent.origin]).toEqual([0, 0, 0]);
    expect(driver.doorRenderOffset('*12')).toEqual([0, 0, 0]);
    expect(driver.server.finished).toBe(false);
    expect(driver.server.finishReason).toBe('');
    // Blocker identity (production clip trace, same construction as the
    // driver's own traces): the stop is WORLD rock (entityNum 0) with a -X
    // face normal — never a mover/train clip. Deleting mover collision or
    // teleporting past cannot satisfy this leg.
    {
      const clip = SV_ClipTrace(driver.server, SV_TraceFor(map));
      const o = driver.pm.origin;
      const hit = clip(
        v3(o[0]!, o[1]!, o[2]!),
        v3(-16, -16, -24),
        v3(16, 16, 32),
        v3(o[0]! - 64, o[1]!, o[2]!),
      );
      expect(hit.fraction).toBeLessThan(1);
      expect(hit.entityNum).toBe(0);
      // Westward ray strikes an east-facing (+X) world face: the wall face
      // at x=-2048 whose hull stops the walk at origin -2032.
      expect(hit.planeNormal[0]!).toBeGreaterThan(0.9);
    }
    // The sim stays live at the limit: walking back east recovers distance
    // (no glued/all-solid state, no RangeError across the exchange).
    const backX = driver.pm.origin[0]! + 60;
    const back = walkTo(driver, backX, 1519, 200);
    expect(back.reached).toBe(true);
    expect(driver.server.finished).toBe(false);
    expect(train.started).toBe(false);

    // ---- route capture for the record ----
    route['leg3-approach'] = leg3track;
    console.log('ROUTE leg1-hall-doors: ' + route['leg1-hall-doors']!.map((p) => `[${p.map((v) => v.toFixed(1))}]`).join(' '));
    console.log('ROUTE walkway: ' + walkway.map((v) => v.toFixed(1)));
    console.log('ROUTE leg2-south: ' + route['leg2-south']!.map((p) => `[${p.map((v) => v.toFixed(1))}]`).join(' '));
    console.log('ROUTE leg3-approach: ' + route['leg3-approach']!.map((p) => `[${p.map((v) => v.toFixed(1))}]`).join(' '));
    console.log(`ROUTE limit: originX=${driver.pm.origin[0]!.toFixed(1)} trainParked=${!train.started} finished=${driver.server.finished}`);
    expectInWorld(driver.pm.origin, map);
  });
});
