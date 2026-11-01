// RELEASE-13 live patrol beats (Q2_PAK, real base1 lump, real tick loop).
//
// Complements the synthetic-chain timing tests in
// packages/server/src/release-13.test.ts (which pin the arrival-corner wait
// through SV_MonsterTick directly). This file verifies the beats the user
// actually sees in the running game through the production driver:
//
// - the nine base1 beat cops (eight soldiers + the north infantry) spawn
//   with their target/path_corner chain, walk it with live walk frames,
//   rest on the hull-trace floor, stand out no spurious wait (no base1
//   monster-route corner carries one) and ride the submitted snapshot;
// - a rear approach with jumping stays silent under the original
//   g_ai.c FindTarget rules (no omnidirectional detection): the t5/t6
//   hallway cop at y=336 never acquires a jumping player 100u behind it,
//   acquires inside melee range behind, hears gunfire from behind
//   (noise/show_hostile, never damage), and acquires a frontal player;
// - sight hands off to combat (the beat is abandoned, never resumed).
//
// Routes (lump coords, Quake units): the t6 cop spawns at (-672,336)
// walking the t5(-576,336)<->t6(-780,336) hallway; the t16 cop spawns at
// (-904,976) walking (-904,856)<->(-904,1416); the t7-loop cop spawns at
// (-704,632) walking t7(-584,632)->t8(-584,776)->t9(-784,776)->
// t10(-784,632)->t7.
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars } from '@q2/config';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  MONSTER_HULL_MAXS,
  MONSTER_HULL_MINS,
  monsterMoveOf,
} from '@q2/game';
import {
  MASK_OPAQUE_C,
  MASK_PLAYERSOLID_C,
  SV_ClipTrace,
  SV_TraceFor,
} from '@q2/server';
import type { BspMap } from '@q2/bsp';
import { bootPlay } from './play.js';

const WEB_Q2_PAK = process.env.Q2_PAK;

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

function stepDriver(driver: { step(cmd: UserCmdT, dt: number): void }, cmd: UserCmdT, n: number): void {
  for (let i = 0; i < n; i++) driver.step(cmd, 0.1);
}

async function bootBase1(width = 96, height = 72): Promise<ReturnType<typeof bootPlay>> {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  return bootPlay({ width, height, pak: ingestPak(buf) });
}

/** World-bounds check (same box as the base1 gate). */
function expectInWorld(origin: Vec3, map: BspMap): void {
  const mins = [...map.modelsMins.slice(0, 3)];
  const maxs = [...map.modelsMaxs.slice(0, 3)];
  for (let i = 0; i < 3; i++) {
    expect(origin[i]!).toBeGreaterThanOrEqual(mins[i]! - 32);
    expect(origin[i]!).toBeLessThanOrEqual(maxs[i]! + 32);
  }
}

/** C visible(): eye-to-eye (monster +25, player +22) against opaque (glass-free) trace. */
function losClear(
  map: BspMap,
  from: [number, number, number],
  to: [number, number, number],
): boolean {
  const sight = SV_TraceFor(map, MASK_OPAQUE_C);
  const t = sight(
    v3(from[0], from[1], from[2]! + 25),
    v3(0, 0, 0),
    v3(0, 0, 0),
    v3(to[0], to[1], to[2]! + 22),
  );
  return t.fraction === 1 && !t.startsolid;
}

/** Facing unit vector from a yaw in degrees. */
function yawDir(yaw: number): [number, number] {
  const a = (yaw * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a)];
}

afterEach(() => {
  resetCVars();
});

describe.runIf(!!WEB_Q2_PAK)('RELEASE-13 live patrol beats (Q2_PAK)', () => {
  it('all nine beat cops walk the live map: chain, frames, floor, snapshot', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const map = driver.map!;
    // Spawn target/path chain on the LIVE server: the same nine the lump
    // audit pins (eight soldiers + the north infantry).
    const expected: Array<[string, string]> = [
      ['-904,976', 't16'],
      ['-232,840', 't47'],
      ['-1248,1744', 't18'],
      ['792,32', 't36'],
      ['1088,328', 't29'],
      ['-48,576', 't11'],
      ['-704,632', 't7'],
      ['-672,336', 't6'],
      ['-1960,1464', 't21'],
    ];
    const beats = driver.server.monsters.filter((m) => m.patrolCorner !== '');
    expect(beats.length).toBe(expected.length);
    const at = new Map(beats.map((m) => [`${m.edict.origin[0]},${m.edict.origin[1]}`, m]));
    for (const [spot, corner] of expected) {
      expect(at.get(spot)?.patrolCorner, `beat at ${spot}`).toBe(corner);
    }
    const starts = new Map(beats.map((m) => [m.edict.num, [...m.edict.origin] as [number, number, number]]));
    // Park the live player at spawn; the start room is enclosed, so every
    // beat cop stays unseen while it walks (probed: HP stays 100).
    driver.pm.origin = v3(128, -320, 32);
    driver.pm.velocity = v3();
    const frames = new Map<number, Set<number>>();
    const furthest = new Map<number, number>(beats.map((m) => [m.edict.num, 0]));
    for (let i = 0; i < 300; i++) {
      driver.step(neutralCmd(), 0.1);
      // Rendered walk motion every tick: the sampling period must not alias
      // the 12/33-frame walk cycles (every-30th-tick sampling reads only 2
      // distinct infantry frames).
      for (const m of beats) {
        if (!frames.get(m.edict.num)) frames.set(m.edict.num, new Set());
        frames.get(m.edict.num)!.add(driver.entityFrame(m.edict.num));
      }
      if (i % 30 === 0) {
        for (const m of beats) {
          // No spurious waits: no base1 monster-route corner carries one,
          // so the beat never stands the patrol out.
          expect(m.patrolWaitUntil).toBe(0);
          expect(m.seen).toBe(false);
          expect(m.state.move === 'walk1' || m.state.move === 'walk').toBe(true);
          const mv = monsterMoveOf(m.state);
          const f = driver.entityFrame(m.edict.num);
          // Rendered walk motion: the submitted MD2 frame rides the live
          // move table (advancement pinned by the every-tick sample above).
          expect(f).toBeGreaterThanOrEqual(mv.first);
          expect(f).toBeLessThanOrEqual(mv.first + mv.frames.length - 1);
          // Ping-pong legs return near spawn, so track the furthest the
          // beat carries the body from its lump spot, not the endpoint.
          const s0 = starts.get(m.edict.num)!;
          const out = Math.hypot(m.edict.origin[0]! - s0[0]!, m.edict.origin[1]! - s0[1]!);
          if (out > (furthest.get(m.edict.num) ?? 0)) furthest.set(m.edict.num, out);
        }
      }
    }
    expect(driver.playerHealth).toBe(100);
    const trace = SV_ClipTrace(driver.server, SV_TraceFor(map));
    const snap = driver.snapshot(driver.server.time);
    for (const m of beats) {
      // The beat actually travelled (corner ping-pong covers 100u+ legs;
      // furthest-from-spawn survives out-and-back cycles).
      expect(furthest.get(m.edict.num)!).toBeGreaterThan(20);
      expect(frames.get(m.edict.num)!.size).toBeGreaterThan(2);
      // Collision: the hull rests on the C-mask floor, in world bounds.
      const drop = trace(
        v3(m.edict.origin[0], m.edict.origin[1], m.edict.origin[2]! + 1),
        MONSTER_HULL_MINS,
        MONSTER_HULL_MAXS,
        v3(m.edict.origin[0], m.edict.origin[1], m.edict.origin[2]! - 256),
      );
      expect(drop.endpos[2]!).toBeCloseTo(m.edict.origin[2]!, 1);
      expectInWorld(m.edict.origin, map);
      // Visibility: the authoritative snapshot carries the live origin.
      const sent = snap.entities.find((e) => e.id === m.edict.num)!;
      expect(sent).toBeDefined();
      expect(Math.hypot(sent.origin[0]! - m.edict.origin[0]!, sent.origin[1]! - m.edict.origin[1]!)).toBeLessThan(1);
    }
  });

  it('rear approach + jumping stays silent; melee behind acquires and hunts', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const map = driver.map!;
    // The t6 hallway cop spawns at (-672,336) heading west down y=336.
    const cop = driver.server.monsters.find(
      (m) => m.edict.origin[0] === -672 && m.edict.origin[1] === 336,
    )!;
    expect(cop.patrolCorner).toBe('t6');
    // Park at spawn until the cop walks mid-segment heading west, so 100u
    // directly behind it stays on the walked hallway.
    driver.pm.origin = v3(128, -320, 32);
    driver.pm.velocity = v3();
    let staged = false;
    for (let i = 0; i < 600 && !staged; i++) {
      driver.step(neutralCmd(), 0.1);
      const yaw = ((cop.state.yaw % 360) + 360) % 360;
      const west = Math.abs(yaw - 180) < 30;
      if (!cop.seen && west && cop.edict.origin[0]! < -690 && cop.edict.origin[0]! > -730) staged = true;
    }
    expect(staged).toBe(true);
    // Phase 1 (RANGE_NEAR behind, no hostile): jump around 100u behind the
    // beat for 15 ticks. g_ai.c FindTarget needs facing at near range, so
    // the original stays silent — no omnidirectional detection.
    let jumped = false;
    const restZ = cop.edict.origin[2]!;
    for (let t = 0; t < 15; t++) {
      const [dx, dy] = yawDir(cop.state.yaw);
      const px = cop.edict.origin[0]! - dx * 100;
      const py = cop.edict.origin[1]! - dy * 100;
      expect(
        losClear(map, [cop.edict.origin[0]!, cop.edict.origin[1]!, cop.edict.origin[2]!], [px, py, restZ]),
        `rear lane open at tick ${t}`,
      ).toBe(true);
      driver.pm.origin = v3(px, py, restZ);
      driver.pm.velocity = v3();
      driver.step({ ...neutralCmd(), upmove: 400 }, 0.1);
      if (driver.pm.origin[2]! > restZ + 4) jumped = true;
      expect(cop.seen, `silent from behind at tick ${t}`).toBe(false);
    }
    expect(jumped).toBe(true); // the approach really did jump
    expect(cop.state.move).toBe('walk1'); // still on its beat
    // Phase 2 (RANGE_MELEE behind): close to 60u behind — C acquires even
    // with the back turned, and the beat hands off to combat (no return).
    let acquired = false;
    for (let t = 0; t < 8 && !acquired; t++) {
      const [dx, dy] = yawDir(cop.state.yaw);
      driver.pm.origin = v3(cop.edict.origin[0]! - dx * 60, cop.edict.origin[1]! - dy * 60, restZ);
      driver.pm.velocity = v3();
      driver.step(neutralCmd(), 0.1);
      acquired = cop.seen;
    }
    expect(acquired).toBe(true);
    for (let t = 0; t < 30; t++) driver.step(neutralCmd(), 0.1);
    expect(cop.seen).toBe(true);
    expect(cop.state.move).not.toBe('walk1'); // hunting, never back on patrol
    expect(driver.playerHealth).toBeGreaterThanOrEqual(0);
  });

  it('gunfire behind wakes (hearing kept); frontal sight acquires', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const map = driver.map!;
    // Part A (legitimate hearing): the t6 hallway cop spawns non-ambush, so
    // gunfire within earshot wakes it through the noise path even with its
    // back turned (g_ai.c heardit + show_hostile branches). Fire AWAY so no
    // bolt can touch it: a wake with full health is hearing, not damage.
    const cop = driver.server.monsters.find(
      (m) => m.edict.origin[0] === -672 && m.edict.origin[1] === 336,
    )!;
    const hp0 = cop.state.health;
    // Capture the t7-loop cop by reference now: after hundreds of ticks it
    // has walked off its lump spot, so a spawn-origin lookup would miss.
    const cop2 = driver.server.monsters.find(
      (m) => m.edict.origin[0] === -704 && m.edict.origin[1] === 632,
    )!;
    expect(cop2.seen).toBe(false);
    driver.pm.origin = v3(128, -320, 32);
    driver.pm.velocity = v3();
    let staged = false;
    for (let i = 0; i < 600 && !staged; i++) {
      driver.step(neutralCmd(), 0.1);
      const yaw = ((cop.state.yaw % 360) + 360) % 360;
      if (!cop.seen && Math.abs(yaw - 180) < 30 && cop.edict.origin[0]! < -676 && cop.edict.origin[0]! > -730) {
        staged = true;
      }
    }
    expect(staged).toBe(true);
    const [bx, by] = yawDir(cop.state.yaw);
    const restZ = cop.edict.origin[2]!;
    driver.pm.origin = v3(cop.edict.origin[0]! - bx * 100, cop.edict.origin[1]! - by * 100, restZ);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 2); // settle onto the hallway floor
    const shotsBefore = driver.events.filter((e) => e === 'shot').length;
    let woken = false;
    // Face east (yaw 0), away from the cop west of the muzzle: the bolt can
    // never connect, so only noise/hostile may wake it.
    for (let t = 0; t < 10 && !woken; t++) {
      driver.step({ msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 1 }, 0.1);
      woken = cop.seen;
    }
    expect(woken).toBe(true);
    expect(driver.events.filter((e) => e === 'shot').length).toBeGreaterThan(shotsBefore);
    expect(cop.state.health).toBe(hp0); // unwounded: hearing woke it, not a hit
    // Part B (frontal sight): the t7-loop cop acquires a player standing
    // ahead of its facing inside 500u with a clear lane (infront gate).
    expect(cop2.seen).toBe(false);
    let framed = false;
    for (let i = 0; i < 600 && !framed; i++) {
      driver.step(neutralCmd(), 0.1);
      if (cop2.seen || !cop2.patrolGoal) continue;
      const gap = Math.hypot(
        cop2.patrolGoal[0]! - cop2.edict.origin[0]!,
        cop2.patrolGoal[1]! - cop2.edict.origin[1]!,
      );
      if (gap > 160) {
        const [fx, fy] = yawDir(cop2.state.yaw);
        const px = cop2.edict.origin[0]! + fx * 150;
        const py = cop2.edict.origin[1]! + fy * 150;
        if (
          losClear(
            map,
            [cop2.edict.origin[0]!, cop2.edict.origin[1]!, cop2.edict.origin[2]!],
            [px, py, cop2.edict.origin[2]!],
          )
        ) {
          driver.pm.origin = v3(px, py, cop2.edict.origin[2]!);
          driver.pm.velocity = v3();
          framed = true;
        }
      }
    }
    expect(framed).toBe(true);
    let met = false;
    for (let t = 0; t < 10 && !met; t++) {
      driver.step(neutralCmd(), 0.1);
      met = cop2.seen;
    }
    expect(met).toBe(true);
  });
});
