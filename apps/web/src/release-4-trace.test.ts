// RELEASE-4 TRACE GATE (box 1, apps/web lane).
//
// Traces normal walking from the final doorway toward the actual exit
// platform on REAL base1 (Q2_PAK) and records player/camera, hit
// brush/edict/model, origin/bounds, startsolid/fraction and mover state —
// distinguishing *12/*13 from *31/*34 and the *27/t37 exit trigger instead
// of assuming the wrong elevator.
//
// What this gate proves with real driver ticks (no teleports inside any
// leg; setup places only the leg starts, the file convention):
// - Leg 1 (hall -> plug face): walking west from the final doorway
//   (-1560,1536) the entry sliders (*32/*33) genuinely cycle open by touch
//   (travel > 30), then the walk sticks at the *31 plug east face (origin
//   x ~= -1688: box west -1704 = plug east, hull 16). The production clip
//   names the plug mover edict (entityNum, +X normal, fraction < 1) — a
//   C-correct shut door (targetname t4, owns no touch trigger), NOT a
//   phantom, NOT the *12 train, NOT world rock. Train parked [0,0,0]
//   unstarted throughout; *13 (t91, wait -1) and *34 (t4) never fire; no
//   t91/t4/t37; finished stays false. The waiting/open repair is preserved.
// - Leg 2 (walkway -> east wall): from the walkway (-1977,1519) the east
//   walk toward the *34 alcove sticks on WORLD geometry (entityNum 0) well
//   west of the plug west face — the *34 call button is not reachable by a
//   straight walk; the plug sits out at pos1/bottom throughout.
// - Leg 3 (F1 completion panel): through the production `SV_FinishLevel`
//   path the F1 overlay states the finish explicitly (LEVEL COMPLETE +
//   frozen time) with frozen kills/secrets/goals; the unfinished overlay
//   carries no completion headline (negative control).
//
// Box 3 (board/ride/finish end to end) stays OPEN: these legs pin the two
// documented blockers (shut plug east, walkway world wall) that the
// boarding route must work (plug cycle via *34, plug-top traverse, pit
// entry) rather than teleport past. No leg starts inside any elevator.
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars } from '@q2/config';
import { BUTTON_ATTACK, BUTTON_USE } from '@q2/input';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import type { BspMap } from '@q2/bsp';
import { SV_ClipTrace, SV_FinishLevel, SV_SetPlayerHealth, SV_TraceFor } from '@q2/server';
import {
  bootPlay,
  drawHelpOverlay,
  drawPlayHud,
  FINISH_BLUE,
  formatLevelTime,
  helpFactsFor,
  toggleHelpOverlay,
} from './play.js';
import type { LocalDriver } from './play.js';

const WEB_Q2_PAK = process.env.Q2_PAK;

function blank(w: number, h: number): { width: number; height: number; color: Uint32Array } {
  return { width: w, height: h, color: new Uint32Array(w * h) };
}

async function bootBase1(width = 96, height = 72) {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  return bootPlay({ width, height, pak: ingestPak(buf) });
}

function yawAt(from: [number, number], to: [number, number]): number {
  return (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
}

function mag3(o: [number, number, number]): number {
  return Math.hypot(o[0]!, o[1]!, o[2]!);
}

afterEach(() => {
  resetCVars();
});

function moverNum(driver: LocalDriver, model: string): number {
  return driver.server.movers.find((m) => m.ent.model === model)!.ent.num;
}

function expectInWorld(origin: Vec3, map: BspMap): void {
  const mins = [...map.modelsMins.slice(0, 3)];
  const maxs = [...map.modelsMaxs.slice(0, 3)];
  for (let i = 0; i < 3; i++) {
    expect(origin[i]!).toBeGreaterThanOrEqual(mins[i]! - 32);
    expect(origin[i]!).toBeLessThanOrEqual(maxs[i]! + 32);
  }
}

interface WalkReport {
  reached: boolean;
  ticks: number;
  /** ticks with <0.5u movement */
  stuckFrames: number;
}

/** Steer the driver toward (tx,ty) with normal locomotion (yaw + forward). */
function walkTo(
  driver: LocalDriver,
  tx: number,
  ty: number,
  cap: number,
  note: () => void,
  arriveRadius = 24,
): WalkReport {
  let stuckFrames = 0;
  let last: [number, number] = [driver.pm.origin[0]!, driver.pm.origin[1]!];
  let ticks = 0;
  let reached = false;
  while (ticks++ < cap) {
    SV_SetPlayerHealth(driver.server, 100); // setup: hold the walker alive
    const yaw = yawAt([driver.pm.origin[0]!, driver.pm.origin[1]!], [tx, ty]);
    driver.step({ msec: 100, angles: [0, yaw, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
    note();
    const px = driver.pm.origin[0]!;
    const py = driver.pm.origin[1]!;
    if (Math.hypot(px - last[0]!, py - last[1]!) < 0.5) stuckFrames++;
    last = [px, py];
    if (Math.hypot(px - tx, py - ty) < arriveRadius) {
      reached = true;
      break;
    }
  }
  return { reached, ticks, stuckFrames };
}

/** Kill the nearest live blocker within radius (aimed blaster, bounded). */
function killNear(driver: LocalDriver, x: number, y: number, radius: number, note: () => void, cap = 60): boolean {
  const aimAt = (tx: number, ty: number, tz: number): [number, number, number] => {
    const e = [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + 22];
    const dx = tx - e[0]!, dy = ty - e[1]!, dz = tz - e[2]!;
    const l = Math.hypot(dx, dy) || 1;
    return [(Math.atan2(-dz, l) * 180) / Math.PI, (Math.atan2(dy, dx) * 180) / Math.PI, 0];
  };
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
    const ducked = target.state.move === 'duck';
    const cx = target.edict.origin[0]!, cy = target.edict.origin[1]!;
    const cz = target.edict.origin[2]! + (ducked ? -12 : 4);
    driver.step({ msec: 100, angles: aimAt(cx, cy, cz), forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_ATTACK }, 0.1);
    note();
  }
  return driver.server.monsters.every(
    (m) => m.state.dead || m.state.gibbed || (m.triggered && !m.woken) ||
      Math.hypot(m.edict.origin[0]! - x, m.edict.origin[1]! - y) >= radius,
  );
}

describe.runIf(!!WEB_Q2_PAK)('RELEASE-4 approach trace (Q2_PAK)', () => {
  it('hall walk sticks on the shut *31 plug (mover clip, not a phantom)', { timeout: 300000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const fired = new Set<string>();
    const noteFired = (): void => {
      for (const t of driver.server.firedThisTick) fired.add(t);
    };

    // Lump truth (cf. server base1.test.ts WIRE-EXIT): *31 func_door
    // angle -2 (down) targetname t4; *32/*33 entry sliders; *12 func_train
    // targetname t91; *13 func_button target t91 wait -1; *34 func_button
    // target t4; *27 trigger_multiple target t37.
    const plug = driver.server.movers.find((m) => m.ent.model === '*31')!;
    const train = driver.server.trains.find((t) => !t.ship)!;
    const btn13 = driver.server.movers.find((m) => m.ent.model === '*13')!;
    const btn34 = driver.server.movers.find((m) => m.ent.model === '*34')!;
    expect(plug.ent.targetname).toBe('t4');
    expect(train.ent.model).toBe('*12');
    expect(train.ent.targetname).toBe('t91');
    expect(btn13.ent.target).toBe('t91');
    expect(btn34.ent.target).toBe('t4');
    const plugNum = plug.ent.num;
    const off = (m: string): [number, number, number] => driver.doorRenderOffset(m)!;

    // Settle on the hall floor, then walk due west with normal locomotion.
    driver.pm.origin = v3(-1560, 1536, 150);
    driver.pm.velocity = v3();
    for (let i = 0; i < 20; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step({ msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
      noteFired();
      if (driver.pm.onGround) break;
    }
    expect(driver.pm.onGround).toBe(true);
    expect(driver.pm.origin[2]!).toBeCloseTo(120, 0);

    let doorCycle = 0;
    let stuckTicks = 0;
    for (let i = 0; i < 200; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      const before = driver.pm.origin[0]!;
      driver.step({ msec: 100, angles: [0, 180, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
      noteFired();
      doorCycle = Math.max(doorCycle, mag3(off('*32')), mag3(off('*33')));
      if (Math.abs(driver.pm.origin[0]! - before) < 0.5) stuckTicks++;
      else stuckTicks = 0;
      // The named lift never starts without its button's t91.
      expect(train.started).toBe(false);
      expect([...train.ent.origin]).toEqual([0, 0, 0]);
      if (stuckTicks >= 30) break;
    }
    // Non-vacuous approach: the walk covered ground, the entry sliders
    // genuinely cycled open by touch (waiting/open repair preserved), then
    // stuck hard at the plug east face.
    expect(driver.pm.origin[0]!).toBeLessThan(-1640);
    expect(doorCycle).toBeGreaterThan(30);
    expect(stuckTicks).toBeGreaterThanOrEqual(30);
    const px = driver.pm.origin[0]!;
    // Plug east face -1704 + hull 16 = -1688 (door slabs share the band;
    // tolerance covers the slab-face stop just east of it).
    expect(px).toBeGreaterThan(-1705);
    expect(px).toBeLessThanOrEqual(-1680);
    expect(driver.pm.onGround).toBe(true);

    // Blocker identity on the production clip: the ray west strikes the
    // *31 plug mover (its edict num, east-facing normal), never world rock
    // (0) and never the *12 train clip.
    const clip = SV_ClipTrace(driver.server, SV_TraceFor(driver.map!));
    const o = driver.pm.origin;
    const hit = clip(
      v3(o[0]!, o[1]!, o[2]!),
      v3(-16, -16, -24) as Vec3,
      v3(16, 16, 32) as Vec3,
      v3(o[0]! - 64, o[1]!, o[2]!),
    );
    expect(hit.fraction).toBeLessThan(1);
    expect(hit.startsolid).toBe(false);
    expect(hit.allsolid).toBe(false);
    expect(hit.entityNum).toBe(plugNum);
    expect(hit.planeNormal[0]!).toBeGreaterThan(0.9);
    // The plug sits shut at rest (C SP_func_door: targetname'd, no touch
    // trigger, DOWN only via *34 -> t4); the *12 deck is a different,
    // parked object far west.
    expect([...plug.ent.origin]).toEqual([...plug.pos1]);
    expect(plug.state).toBe('bottom');
    expect(btn13.state).toBe('bottom');
    expect(btn34.state).toBe('bottom');
    expect(fired.has('t91')).toBe(false);
    expect(fired.has('t4')).toBe(false);
    expect(fired.has('t37')).toBe(false);
    expect(driver.server.finished).toBe(false);
    expect(driver.server.finishReason).toBe('');
  });

  it('walkway east walk sticks on world geometry west of the plug', { timeout: 300000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    driver.pm.origin = v3(-1977, 1519, 120);
    driver.pm.velocity = v3();
    for (let i = 0; i < 20; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step({ msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
      if (driver.pm.onGround) break;
    }
    expect(driver.pm.onGround).toBe(true);
    for (let i = 0; i < 150; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      const yaw = yawAt([driver.pm.origin[0]!, driver.pm.origin[1]!], [-1855, 1536]);
      driver.step({ msec: 100, angles: [0, yaw, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
    }
    // Advanced east but stopped well short of the plug west face (-1844):
    // a wall, not a mover, owns the stop.
    expect(driver.pm.origin[0]!).toBeGreaterThan(-1977);
    expect(driver.pm.origin[0]!).toBeLessThan(-1844 - 16);
    const clip = SV_ClipTrace(driver.server, SV_TraceFor(driver.map!));
    const o = driver.pm.origin;
    const hit = clip(
      v3(o[0]!, o[1]!, o[2]!),
      v3(-16, -16, -24) as Vec3,
      v3(16, 16, 32) as Vec3,
      v3(o[0]! + 64, o[1]!, o[2]!),
    );
    expect(hit.fraction).toBeLessThan(1);
    expect(hit.entityNum).toBe(0);
    const plug = driver.server.movers.find((m) => m.ent.model === '*31')!;
    expect([...plug.ent.origin]).toEqual([...plug.pos1]);
    expect(plug.state).toBe('bottom');
    expect(driver.server.finished).toBe(false);
  });

  it('F1 panel states the finish explicitly with frozen counters/time', { timeout: 120000 }, async () => {
    // Presentation leg (no boarding claim): the production finish path
    // freezes the snapshot; the F1 overlay must show it explicitly.
    const boot = await bootBase1();
    const { driver } = boot;
    driver.server.totalMonsters = 12;
    driver.server.killedMonsters = 3;
    driver.server.totalSecrets = 2;
    driver.server.foundSecrets = 1;
    driver.server.totalGoals = 1;
    driver.server.foundGoals = 0;
    // Negative control: the running overlay carries no completion headline.
    toggleHelpOverlay(boot);
    const running = blank(320, 240);
    drawHelpOverlay(running, boot);
    expect(running.color.some((c) => c === FINISH_BLUE)).toBe(false);
    toggleHelpOverlay(boot);
    // Run the clock, then finish through the server-owned path.
    for (let i = 0; i < 30; i++) {
      driver.step({ msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
    }
    expect(driver.server.time).toBeGreaterThan(0);
    SV_FinishLevel(driver.server, 'exit');
    expect(driver.server.finished).toBe(true);
    expect(driver.server.finishReason).toBe('exit');
    // Post-finish play must not move the frozen rows.
    driver.server.killedMonsters = 9;
    driver.server.foundSecrets = 2;
    const facts = helpFactsFor(boot);
    expect(facts.kills).toEqual([3, 12]);
    expect(facts.secrets).toEqual([1, 2]);
    expect(facts.goals).toEqual([0, 1]);
    expect(formatLevelTime(driver.server.finishTime)).toBe('0:03');
    // The F1 overlay now states the finish (headline in FINISH_BLUE plus
    // the frozen time row) on top of the still-rendered help panel.
    toggleHelpOverlay(boot);
    expect(boot.showHelp).toBe(true);
    const done = blank(320, 240);
    drawHelpOverlay(done, boot);
    expect(done.color.some((c) => c === FINISH_BLUE)).toBe(true);
    // The center screen agrees through the production HUD path.
    driver.step({ msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
    expect(driver.message).toContain('LEVEL COMPLETE');
    const hud = blank(320, 240);
    drawPlayHud(hud, boot, { fps: 0, frame: 1 });
    expect(hud.color.some((c) => c === FINISH_BLUE)).toBe(true);
    expect(moverNum(driver, '*31')).toBeGreaterThan(0);
  });

  it('box-3a gate: walk the loading platform to the bridge wall (nothing fires)', { timeout: 300000 }, async () => {
    // Honest end-of-the-walkable-world gate (box-2 audit): hall -> doorway
    // slot -> south loop -> walkway -> bridge, real walking only (setup
    // teleports to the hall start alone). The bridge ends at a rock wall
    // above the entombed deck; the plug stays frozen shut, the pit stays
    // sealed, the *13 call button never fires, and no E-use is sent anywhere.
    // The shot finish lives in box-3b (mechanism setup below the slab).
    const boot = await bootBase1();
    const { driver } = boot;
    const map = driver.map!;
    const fired = new Set<string>();
    const noteFired = (): void => {
      for (const t of driver.server.firedThisTick) fired.add(t);
    };

    // Lump truth: *13 health-gated button (target t91, wait -1); *12 train
    // (targetname t91, target t88, speed 40); *31 plug (targetname t4,
    // frozen shut — *34 entombed, no relay feeds t4); *34 platform button
    // (target t4); *27 trigger_multiple (target t37, sealed pit). The deck
    // itself is unboardable on foot (48 climb vs the 33 C jump, rock slot),
    // so this gate walks the loading platform and pins the silent complex.
    const train = driver.server.trains.find((t) => !t.ship)!;
    const btn13 = driver.server.movers.find((m) => m.ent.model === '*13')!;
    const plug = driver.server.movers.find((m) => m.ent.model === '*31')!;
    const btn34 = driver.server.movers.find((m) => m.ent.model === '*34')!;
    expect(train.ent.model).toBe('*12');
    expect(train.ent.targetname).toBe('t91');
    expect(train.ent.target).toBe('t88');
    expect(train.speed).toBe(40);
    expect(btn13.ent.target).toBe('t91');
    expect(btn13.ent.health).toBe(1);
    expect(btn13.wait).toBe(-1);
    expect(plug.ent.targetname).toBe('t4');
    expect(btn34.ent.target).toBe('t4');
    const off = (m: string): [number, number, number] => driver.doorRenderOffset(m)!;
    expect([...train.ent.origin]).toEqual([0, 0, 0]);
    expect(train.started).toBe(false);
    const parked = (): void => {
      expect(train.started).toBe(false);
      expect([...train.ent.origin]).toEqual([0, 0, 0]);
      expect(off('*12')).toEqual([0, 0, 0]);
    };

    // ---- approach: settle in the hall, walk the slot, round south ----
    driver.pm.origin = v3(-1560, 1536, 150);
    driver.pm.velocity = v3();
    for (let i = 0; i < 20; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step({ msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
      noteFired();
      if (driver.pm.onGround) break;
    }
    expect(driver.pm.onGround).toBe(true);
    expect(driver.pm.origin[2]!).toBeCloseTo(120, 0);
    let doorCycle = 0;
    let stuckTicks = 0;
    for (let i = 0; i < 200; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      const before = driver.pm.origin[0]!;
      driver.step({ msec: 100, angles: [0, 180, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
      noteFired();
      doorCycle = Math.max(doorCycle, mag3(off('*32')), mag3(off('*33')));
      if (Math.abs(driver.pm.origin[0]! - before) < 0.5) stuckTicks++;
      else stuckTicks = 0;
      parked();
      if (stuckTicks >= 30) break;
    }
    // Non-vacuous approach (box-1 leg-1 pattern): ground covered, sliders
    // cycled open by touch, then stuck hard at the plug east face.
    expect(driver.pm.origin[0]!).toBeLessThan(-1640);
    expect(doorCycle).toBeGreaterThan(30);
    expect(stuckTicks).toBeGreaterThanOrEqual(30);
    expect(driver.pm.origin[0]!).toBeGreaterThan(-1705);
    expect(driver.pm.origin[0]!).toBeLessThanOrEqual(-1680);
    expect(driver.pm.onGround).toBe(true);
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
    for (const [wx, wy] of wps) {
      const rep = walkTo(driver, wx, wy, 300, noteFired);
      expect(rep.reached).toBe(true);
      expect(rep.stuckFrames).toBeLessThanOrEqual(15);
      parked();
      expectInWorld(driver.pm.origin, map);
    }
    expect(Math.hypot(driver.pm.origin[0]! + 1977, driver.pm.origin[1]! - 1519)).toBeLessThan(30);
    expect(driver.pm.onGround).toBe(true);

    // ---- bridge: clear the guard with fire, walk west to the rock wall ----
    // The walkway/bridge deck runs at walkway level (origin ~120-144) over
    // the pit and ends at world rock west of the entombed deck slot.
    expect(killNear(driver, driver.pm.origin[0]!, driver.pm.origin[1]!, 160, noteFired)).toBe(true);
    const bridgeWalk = walkTo(driver, -2060, 1519, 300, noteFired);
    expect(bridgeWalk.reached).toBe(false);
    expect(driver.pm.origin[0]!).toBeGreaterThan(-2045);
    expect(driver.pm.origin[0]!).toBeLessThan(-2015);
    expect(driver.pm.onGround).toBe(true);
    expect(driver.pm.origin[2]!).toBeGreaterThan(110);
    expect(driver.pm.origin[2]!).toBeLessThan(160);
    parked();
    expect(driver.server.finished).toBe(false);
    expect(fired.has('t91')).toBe(false);
    expect(fired.has('t4')).toBe(false);
    expect(fired.has('t37')).toBe(false);
    // Blocker identity on the production clip: the westward ray strikes
    // WORLD rock (entityNum 0, +X normal) — the rock face stands ~3 east of
    // the entombed deck face, so the hull never reaches deck clips.
    {
      const clip = SV_ClipTrace(driver.server, SV_TraceFor(map));
      const o = driver.pm.origin;
      const hit = clip(
        v3(o[0]!, o[1]!, o[2]!),
        v3(-16, -16, -24) as Vec3,
        v3(16, 16, 32) as Vec3,
        v3(o[0]! - 64, o[1]!, o[2]!),
      );
      expect(hit.fraction).toBeLessThan(1);
      expect(hit.entityNum).toBe(0);
      expect(hit.planeNormal[0]!).toBeGreaterThan(0.9);
    }

    // ---- mobility sanity: jump on the bridge, land back aboard it ----
    // (Proves the jump itself works; the deck below stays out of reach —
    // the boarding block numbers live in the lane report and box-3b.)
    {
      const floorZ = driver.pm.origin[2]!;
      SV_SetPlayerHealth(driver.server, 100);
      driver.step({ msec: 100, angles: [0, 180, 0], forwardmove: 0, sidemove: 0, upmove: 127, buttons: 0 }, 0.1);
      noteFired();
      let peak = driver.pm.origin[2]!;
      for (let i = 0; i < 30; i++) {
        SV_SetPlayerHealth(driver.server, 100);
        driver.step({ msec: 100, angles: [0, 180, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
        noteFired();
        peak = Math.max(peak, driver.pm.origin[2]!);
      }
      expect(peak).toBeGreaterThan(floorZ + 10); // the jump genuinely left the deck
      expect(driver.pm.onGround).toBe(true);
      expect(Math.abs(driver.pm.origin[2]! - floorZ)).toBeLessThan(4);
      expect(driver.pm.origin[0]!).toBeGreaterThan(-2070);
      expect(driver.pm.origin[0]!).toBeLessThan(-1990);
      parked();
      expect(driver.server.finished).toBe(false);
      expect(fired.has('t91')).toBe(false);
      expect(fired.has('t4')).toBe(false);
      expect(fired.has('t37')).toBe(false);
    }

    // ---- end of the walkable world: frozen plug, sealed pit, silent button ----
    expect([...plug.ent.origin]).toEqual([...plug.pos1]);
    expect(plug.state).toBe('bottom');
    expect(off('*31')).toEqual([0, 0, 0]);
    expect(btn13.state).toBe('bottom');
    expect(btn34.state).toBe('bottom');
    expect(driver.server.finished).toBe(false);
    expect(driver.server.finishReason).toBe('');
    expect(driver.events).not.toContain('use'); // no hidden E-use anywhere
    expectInWorld(driver.pm.origin, map);
  });

  it('box-3b gate: shoot *13 from below (no E-use, never aboard), NO finish (aboard guard)', { timeout: 300000 }, async () => {
    // RELEASE-4 aboard guard: a live player body standing on the pit floor —
    // OUTSIDE the *27 exit volume (volume x -1840..-1712; here x ~= -2030) —
    // fires aimed blaster bolts up at the health-gated *13. The lethal hit
    // fires t91 (C button_killed): the *12 train runs its leg empty and finds
    // its secret — but WITHOUT boarding the train the server must NOT take
    // the 'lift' finish (boarding alone never finishes; outside presses
    // start the train but do NOT finish). This pins the guard; boarding +
    // button completion lives in box-4 (plug lift, walkable in any engine).
    // Feet stay on the world floor (groundEntity is never the train) and the
    // deck is never entered.
    const boot = await bootBase1();
    const { driver } = boot;
    const map = driver.map!;
    const fired = new Set<string>();
    const noteFired = (): void => {
      for (const t of driver.server.firedThisTick) fired.add(t);
    };
    const train = driver.server.trains.find((t) => !t.ship)!;
    const btn13 = driver.server.movers.find((m) => m.ent.model === '*13')!;
    const plug = driver.server.movers.find((m) => m.ent.model === '*31')!;
    expect(btn13.ent.target).toBe('t91');
    expect(btn13.ent.health).toBe(1);
    expect(btn13.wait).toBe(-1);
    const off = (m: string): [number, number, number] => driver.doorRenderOffset(m)!;
    expect([...train.ent.origin]).toEqual([0, 0, 0]);
    expect(train.started).toBe(false);

    // Setup stance on the pit floor (mechanism setup, outside the volume):
    // settle from above the button's brush (never an exact-plane plant, and
    // the health-gated button owns no touch per C SP_func_button).
    driver.pm.origin = v3(-2030, 1536, 40);
    driver.pm.velocity = v3();
    for (let i = 0; i < 40; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step({ msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
      noteFired();
      if (driver.pm.onGround) break;
    }
    expect(driver.pm.onGround).toBe(true);
    expect(Math.abs(driver.pm.origin[2]! + 24)).toBeLessThan(2);
    expect(driver.pm.groundEntity).not.toBe(train.ent.num);
    // Outside the *27 volume: settling here fires no exit relay.
    expect(driver.server.finished).toBe(false);
    expect(fired.has('t37')).toBe(false);
    expect(fired.has('t91')).toBe(false);

    // ---- original-supported finish: SHOOT *13 (C button_killed) ----
    // No E-use anywhere in this session (Q2 has no +use-for-buttons): the
    // aimed blaster kills the health-gated button, t91 runs the train and
    // finds its secret, and the server takes the 'lift' finish.
    expect(driver.events).not.toContain('use');
    const eye0: [number, number, number] = [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + 22];
    {
      const dx = -2016 - eye0[0]!, dy = 1536 - eye0[1]!, dz = 80 - eye0[2]!;
      const l = Math.hypot(dx, dy) || 1;
      const aim: [number, number, number] = [
        (Math.atan2(-dz, l) * 180) / Math.PI,
        (Math.atan2(dy, dx) * 180) / Math.PI,
        0,
      ];
      let t91at = -1;
      for (let i = 0; i < 120 && t91at < 0; i++) {
        SV_SetPlayerHealth(driver.server, 100);
        driver.step({ msec: 100, angles: aim, forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_ATTACK }, 0.1);
        noteFired();
        if (driver.server.firedThisTick.includes('t91')) t91at = i;
      }
      expect(t91at).toBeGreaterThanOrEqual(0); // bolts connected: the button fired
    }
    expect(btn13.state).not.toBe('bottom');
    expect(btn13.ent.health).toBe(1); // C button_killed restores health
    expect(train.started).toBe(true);
    expect(driver.server.foundSecrets).toBe(1); // the t91 secret, via the shot
    expect(driver.server.totalSecrets).toBe(3);
    // RELEASE-4 guard: outside press (never aboard) starts the train and finds
    // the secret (C-correct) but does NOT finish. Boarding alone never
    // finishes either; only aboard activation completes (box-4, plug lift).
    expect(driver.server.finished).toBe(false);
    expect(driver.server.finishReason).toBe('');
    expect(driver.server.finishTime).toBe(0);
    expect(driver.events).not.toContain('finished');
    expect(driver.events).not.toContain('exit');
    expect(driver.events).not.toContain('use');
    expect(driver.exited).toBe(false);
    // The plug/pit complex sat out the finish: frozen shut, no relay.
    expect([...plug.ent.origin]).toEqual([...plug.pos1]);
    expect(plug.state).toBe('bottom');
    expect(off('*31')).toEqual([0, 0, 0]);
    expect(fired.has('t4')).toBe(false);
    expect(fired.has('t37')).toBe(false);

    // ---- ride-out: the train runs its full leg and parks (nobody aboard) ----
    {
      let peak = 0;
      let midLeg = false;
      for (let i = 0; i < 120 && !train.arrived; i++) {
        SV_SetPlayerHealth(driver.server, 100);
        driver.step({ msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
        noteFired();
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
      expect(train.ent.origin[0]!).toBeCloseTo(-16, 6);
      expect(train.ent.origin[1]!).toBeCloseTo(0, 6);
      expect(train.ent.origin[2]!).toBeCloseTo(40, 6);
      // Wait -1 holds the button TOP forever (never returns to BOTTOM).
      expect(btn13.state).toBe('top');
      for (let i = 0; i < 50; i++) {
        SV_SetPlayerHealth(driver.server, 100);
        driver.step({ msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
        noteFired();
      }
      expect(btn13.state).toBe('top');
      expect(off('*13')).toEqual([0, 0, 4]);
      const endOff = off('*12');
      for (let i = 0; i < 50; i++) {
        SV_SetPlayerHealth(driver.server, 100);
        driver.step({ msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
        noteFired();
        expect(off('*12')).toEqual(endOff);
      }
      expect(train.arrived).toBe(true);
      expect(fired.has('t4')).toBe(false);
      expect(fired.has('t37')).toBe(false);
      expect(driver.events).not.toContain('use');
    }

    // ---- F1 negative control (no finish on outside press): live counters ----
    // Outside *13 press starts the train + finds the secret (C-correct) but
    // does NOT finish (aboard guard). The F1 overlay therefore carries no
    // completion headline (negative control, like box-1 running overlay);
    // boarding + aboard press completion lives in box-4 (plug lift).
    {
      expect(driver.server.finished).toBe(false);
      const facts = helpFactsFor(boot);
      // Live (unfrozen) counters: kills 0 <= total, secrets [1,3] (t91 found),
      // goals [0,1]. finish* stay zero (never finished).
      expect(facts.kills[0]).toBeLessThanOrEqual(facts.kills[1]);
      expect(facts.secrets).toEqual([1, 3]);
      expect(facts.goals).toEqual([0, 1]);
      expect(driver.server.finishKills).toBe(0);
      expect(driver.server.finishSecrets).toBe(0);
      expect(driver.server.finishGoals).toBe(0);
      expect(driver.server.finishTime).toBe(0);
      toggleHelpOverlay(boot);
      expect(boot.showHelp).toBe(true);
      const done = blank(320, 240);
      drawHelpOverlay(done, boot);
      expect(done.color.some((c) => c === FINISH_BLUE)).toBe(false);
      expect(driver.message).not.toContain('LEVEL COMPLETE');
      expectInWorld(driver.pm.origin, map);
    }
  });

  it('box-4 gate: visible doorway entry boards plug lift, E-use finishes + F1 (multi-offset)', { timeout: 300000 }, async () => {
    // RELEASE-4 production gate (user-contract, reopened fix):
    // - Visible doorway: hall (-1560,Y) straight west through *32/*33 to the
    //   *31 plug east face. No hidden south slide, no teleport: the *34 housing
    //   sits at the east-face south-gap (-1703..-1694, 1472..1504, center
    //   -1698.5,1488) — 1u east of the shut face (-1704), 6u west of the slider
    //   band (-1688), fully inside the open-slider gap (1472..1600) so it is
    //   drawn visible (not behind the open *32 slab like the old -72 south
    //   end), but 16u south of the central walk (Y 1536) so the straight-in
    //   walk neither touches nor blocks on it. First press is an aimed E-use
    //   from the face (visible, within C 96 reach, facing+LOS); walking west
    //   off the face drops onto the open top (origin 112 == top 88+24,
    //   ge==plug, no fall-through, no finish); second press is an aimed E-use
    //   from aboard and finishes 'lift' exactly once with frozen F1.
    // - Render-vs-collision: the relocated housing must be DRAWN where it
    //   collides (DoorSync/graft shift == server moverBounds shift), not just
    //   present in the server fixture. Without the web shift the visual would
    //   sit at the lump spot (-1848..-1839, inside the shut plug, invisible)
    //   while colliding 145E-48Y away — the reported invisible blockage.
    //   Old side routes (-1688,1488 touch -> -1720,1470 board, 145E+72S;
    //   central touch) are superseded: normal entry now E-uses a visible button.
    // - Multi-offset: Y 1536 (center), 1552 and 1568 (north of center) all
    //   complete without repositioning inside any leg and without directly
    //   firing targets. All three avoid touch (16u+ Y gap, no overlap), so the
    //   first press is always the visible E-use — no hidden contact. Outside/
    //   unrelated/repeat presses never finish.
    // Lump truth: *31 plug targetname t4, *34 button target t4, *12 train
    // targetname t91 (secret, never started here), *13 button target t91
    // wait -1 (never fired here). C travel/TOUCH/shooting intact (pos2 from
    // brush size, touch gated, shooting gated by health); E-use reach is the
    // C 96-unit slop (no 120 extension); first-reason-wins, TOP hold blocks
    // repeats.
    const START_X = -1560;
    const FACE_X = -1688;
    const Y_OFFSETS = [1536, 1552, 1568];
    for (const startY of Y_OFFSETS) {
      const boot = await bootBase1();
      const { driver } = boot;
      const map = driver.map!;
      const fired = new Set<string>();
      const noteFired = (): void => {
        for (const t of driver.server.firedThisTick) fired.add(t);
      };
      const plug = driver.server.movers.find((m) => m.ent.model === '*31')!;
      const btn34 = driver.server.movers.find((m) => m.ent.model === '*34')!;
      const train = driver.server.trains.find((t) => !t.ship)!;
      expect(plug.ent.targetname).toBe('t4');
      expect(btn34.ent.target).toBe('t4');
      expect(train.started).toBe(false);
      const off = (m: string): [number, number, number] => driver.doorRenderOffset(m)!;
      // Collision truth (south-gap housing): -1703..-1694, 1472..1504.
      const b34box = driver.server.moverBounds.get(btn34.ent.num)!;
      expect([...b34box.mins]).toEqual([-1703, 1472, 120]);
      expect([...b34box.maxs]).toEqual([-1694, 1504, 152]);
      // Render-vs-collision: visual bounds (DoorSync, shifted) must equal
      // collision bounds at rest.
      const vis = driver.doorVisualBounds('*34')!;
      expect(vis).not.toBeNull();
      expect(vis.mins[0]!).toBeCloseTo(b34box.mins[0]!, 0);
      expect(vis.mins[1]!).toBeCloseTo(b34box.mins[1]!, 0);
      expect(vis.mins[2]!).toBeCloseTo(b34box.mins[2]!, 0);
      expect(vis.maxs[0]!).toBeCloseTo(b34box.maxs[0]!, 0);
      expect(vis.maxs[1]!).toBeCloseTo(b34box.maxs[1]!, 0);
      expect(vis.maxs[2]!).toBeCloseTo(b34box.maxs[2]!, 0);
      // Visual is east of the shut plug face (not entombed) and inside the
      // open-slider gap (not behind the slab): center X -1698.5 > -1704,
      // center Y 1488 within 1472..1600.

      // ---- approach: settle, walk straight west to the plug face ----
      // Sliders cycle open by touch; the straight walk at Y 1536/1552/1568
      // passes 16u+ north of the south-gap *34 (no touch, no block), so the
      // plug stays shut, no t4, no finish — the visible doorway blockage
      // reproduced (shut plug east face, mover clip, +X normal).
      driver.pm.origin = v3(START_X, startY, 150);
      driver.pm.velocity = v3();
      for (let i = 0; i < 20; i++) {
        SV_SetPlayerHealth(driver.server, 100);
        driver.step({ msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
        noteFired();
        if (driver.pm.onGround) break;
      }
      expect(driver.pm.onGround).toBe(true);
      // After the settle ticks syncDoors has run: the shifted visual sits at
      // rest (offset 0), i.e. drawn where it collides.
      expect(off('*34')).toEqual([0, 0, 0]);
      expect(driver.server.finished).toBe(false);
      {
        const face = walkTo(driver, FACE_X, startY, 200, noteFired);
        expect(face.reached).toBe(true);
        expect(driver.pm.origin[0]!).toBeGreaterThan(-1705);
        expect(driver.pm.origin[0]!).toBeLessThanOrEqual(-1680);
        // No hidden touch: central walk does not press the south-gap button.
        expect(fired.has('t4')).toBe(false);
        expect(btn34.state).toBe('bottom');
        expect(plug.state).toBe('bottom');
        expect(driver.server.finished).toBe(false);
        // Blocker is the shut *31 plug mover (not world rock, not train).
        const clip = SV_ClipTrace(driver.server, SV_TraceFor(driver.map!));
        const o = driver.pm.origin;
        const hit = clip(
          v3(o[0]!, o[1]!, o[2]!),
          v3(-16, -16, -24) as Vec3,
          v3(16, 16, 32) as Vec3,
          v3(o[0]! - 64, o[1]!, o[2]!),
        );
        expect(hit.fraction).toBeLessThan(1);
        expect(hit.entityNum).toBe(plug.ent.num);
        expect(hit.planeNormal[0]!).toBeGreaterThan(0.9);
      }

      // ---- first press: aimed E-use from the face (visible button) ----
      // Eye to south-gap center: ~50u (within C 96), facing cone, LOS over
      // the deck, west of the slider plane. Opens the plug (t4, no finish —
      // not aboard). No touch, no teleport, no direct target fire.
      {
        let t4at = -1;
        for (let i = 0; i < 40 && t4at < 0; i++) {
          const b = driver.server.moverBounds.get(btn34.ent.num)!;
          const center: [number, number, number] = [(b.mins[0]! + b.maxs[0]!) / 2, (b.mins[1]! + b.maxs[1]!) / 2, (b.mins[2]! + b.maxs[2]!) / 2];
          const eye0: [number, number, number] = [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + driver.pm.viewheight];
          const dx = center[0] - eye0[0]!, dy = center[1] - eye0[1]!, dz = center[2] - eye0[2]!;
          const dist = Math.hypot(dx, dy, dz);
          expect(dist).toBeLessThan(96);
          const lh = Math.hypot(dx, dy) || 1;
          const pitch = (Math.atan2(-dz, lh) * 180) / Math.PI;
          const yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
          SV_SetPlayerHealth(driver.server, 100);
          driver.step({ msec: 100, angles: [pitch, yaw, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_USE }, 0.1);
          noteFired();
          if (fired.has('t4')) t4at = i;
          expect(driver.server.finished).toBe(false);
        }
        expect(t4at).toBeGreaterThanOrEqual(0);
        expect(btn34.state).not.toBe('bottom');
        expect(driver.server.finished).toBe(false);
        expect(driver.events).toContain('use');
      }
      // Wait for TOP (open, top 88, offset -156) — boardable.
      for (let i = 0; i < 60 && plug.state !== 'top' && plug.state !== 'waiting'; i++) {
        SV_SetPlayerHealth(driver.server, 100);
        driver.step({ msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
        noteFired();
      }
      expect(['top', 'waiting']).toContain(plug.state);
      expect(off('*31')[2]!).toBeCloseTo(-156, 0);
      expect(driver.server.finished).toBe(false);

      // ---- board: walk west onto the open plug top ----
      // From the face lean west to (-1720,startY): crosses the east face
      // plane, drops onto the open top (origin 112 == top 88+24). Grounded,
      // ge==plug, no fall-through — boarding alone never finishes.
      // WalkTo stops on XY arrival (possibly still airborne from the 8u
      // drop), so settle a few ticks to land before asserting ge/onGround.
      // Arrive radius 6 (not 12) keeps the aboard E-use within C 96 even at
      // the worst stop (Y 1568: dy 80+6, dx 21.5+6 → ~90 <96).
      {
        const board = walkTo(driver, -1720, startY, 200, noteFired, 6);
        expect(board.reached).toBe(true);
        for (let i = 0; i < 10; i++) {
          SV_SetPlayerHealth(driver.server, 100);
          driver.step({ msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
          noteFired();
          if (driver.pm.onGround && driver.pm.groundEntity === plug.ent.num) break;
        }
        expect(driver.server.finished).toBe(false);
        expect(driver.pm.groundEntity).toBe(plug.ent.num);
        expect(driver.pm.onGround).toBe(true);
        expect(driver.pm.origin[2]!).toBeCloseTo(112, 0);
        expect(driver.server.finished).toBe(false);
        expect(driver.server.finishReason).toBe('');
      }

      // ---- finishing press: aimed E-use from aboard → finish 'lift' ----
      // Eye to south-gap center from aboard: within C 96, facing cone,
      // wall-checked LOS over the lowered plug, west of the slider plane.
      // Button cycled (wait 3 returns to BOTTOM); E-use fires t4 on TOP while
      // aboard → 'lift' (first-wins, TOP hold blocks repeats, outside/
      // unrelated never finish here).
      {
        expect(driver.server.finished).toBe(false);
        let finishedAt = -1;
        for (let i = 0; i < 80 && finishedAt < 0; i++) {
          const b = driver.server.moverBounds.get(btn34.ent.num)!;
          const center: [number, number, number] = [(b.mins[0]! + b.maxs[0]!) / 2, (b.mins[1]! + b.maxs[1]!) / 2, (b.mins[2]! + b.maxs[2]!) / 2];
          const eye0: [number, number, number] = [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + driver.pm.viewheight];
          const dx = center[0] - eye0[0]!, dy = center[1] - eye0[1]!, dz = center[2] - eye0[2]!;
          const dist = Math.hypot(dx, dy, dz);
          expect(dist).toBeLessThan(96);
          const lh = Math.hypot(dx, dy) || 1;
          const pitch = (Math.atan2(-dz, lh) * 180) / Math.PI;
          const yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
          SV_SetPlayerHealth(driver.server, 100);
          driver.step({ msec: 100, angles: [pitch, yaw, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_USE }, 0.1);
          noteFired();
          if (driver.server.finished) {
            finishedAt = i;
            break;
          }
        }
        expect(finishedAt).toBeGreaterThanOrEqual(0);
        expect(driver.server.finished).toBe(true);
        expect(driver.server.finishReason).toBe('lift');
        expect(driver.server.finishTime).toBeGreaterThan(0);
        expect(driver.events).toContain('finished');
        expect(driver.events).toContain('use');
        expect(driver.events).not.toContain('exit');
        expect(driver.exited).toBe(false);
        expect(fired.has('t4')).toBe(true);
        expect(fired.has('t91')).toBe(false);
        expect(fired.has('t37')).toBe(false);
        expect(train.started).toBe(false);
        const finishTime = driver.server.finishTime;
        const finishKills = driver.server.finishKills;
        for (let i = 0; i < 20; i++) {
          const b = driver.server.moverBounds.get(btn34.ent.num)!;
          const center: [number, number, number] = [(b.mins[0]! + b.maxs[0]!) / 2, (b.mins[1]! + b.maxs[1]!) / 2, (b.mins[2]! + b.maxs[2]!) / 2];
          const eye0: [number, number, number] = [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + driver.pm.viewheight];
          const dx = center[0] - eye0[0]!, dy = center[1] - eye0[1]!, dz = center[2] - eye0[2]!;
          const lh = Math.hypot(dx, dy) || 1;
          const pitch = (Math.atan2(-dz, lh) * 180) / Math.PI;
          const yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
          SV_SetPlayerHealth(driver.server, 100);
          driver.step({ msec: 100, angles: [pitch, yaw, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_USE }, 0.1);
          noteFired();
        }
        expect(driver.server.finished).toBe(true);
        expect(driver.server.finishTime).toBe(finishTime);
        expect(driver.server.finishKills).toBe(finishKills);
        expect(btn34.state).toBe('waiting');
      }

      // ---- F1 completion: frozen counters, LEVEL COMPLETE ----
      {
        const facts = helpFactsFor(boot);
        expect(facts.kills[0]).toBe(driver.server.finishKills);
        expect(facts.kills[1]).toBe(driver.server.totalMonsters);
        expect(facts.secrets).toEqual([0, 3]);
        expect(facts.goals).toEqual([1, 1]);
        expect(formatLevelTime(driver.server.finishTime)).toMatch(/^\d+:\d\d$/);
        driver.server.killedMonsters = driver.server.totalMonsters;
        driver.server.foundSecrets = 3;
        const frozen = helpFactsFor(boot);
        expect(frozen.kills[0]).toBe(facts.kills[0]);
        expect(frozen.secrets).toEqual([0, 3]);
        expect(frozen.goals).toEqual([1, 1]);
        toggleHelpOverlay(boot);
        expect(boot.showHelp).toBe(true);
        const done = blank(320, 240);
        drawHelpOverlay(done, boot);
        expect(done.color.some((c) => c === FINISH_BLUE)).toBe(true);
        expect(driver.message).toContain('LEVEL COMPLETE');
        expectInWorld(driver.pm.origin, map);
      }
      console.log(`RELEASE-4 box-4 visible offset Y=${startY}: finished lift, F1 frozen`);
    }
  });
});
