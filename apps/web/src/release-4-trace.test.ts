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
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
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
});
