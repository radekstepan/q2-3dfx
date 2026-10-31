// RELEASE-14: source-faithful damage feedback + strafe view roll.
//
// Deterministic devroom sequences (no pak) pinning the p_view.c port:
// P_DamageFeedback (health flash, red wash, decay, directional kick,
// armor/blood split documented blood-only, immunity/death/reset), the
// SV_CalcViewOffset camera lean (strafe roll sign/magnitude, bob, duck,
// air/water gating vs source) and single-application across the CPU/GPU
// frame builders at multiple resolutions.
import { describe, expect, it } from 'vitest';
import { BUTTON_ATTACK } from '@q2/input';
import type { UserCmdT } from '@q2/input';
import { AngleVectors, v3 } from '@q2/math';
import { executeStatusbar, parseStatusbar } from '@q2/client';
import { bootPlay, buildAsyncView, drawPlayHud, resolveDisplay, statusbarStateFor } from './play.js';
import type { LocalDriver } from './play.js';

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

function stepDriver(driver: LocalDriver, cmd: UserCmdT, n: number): void {
  for (let i = 0; i < n; i++) driver.step(cmd, 0.1);
}

/** Settle pmove (fall to the floor, zero velocity) without rendering. */
function settle(driver: LocalDriver): void {
  stepDriver(driver, neutralCmd(), 8);
}

describe('RELEASE-14 damage feedback', () => {
  it('a hit flashes health, washes red at the C floor, and pains', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    const { driver } = boot;
    settle(driver);
    const before = driver.playerHealth;
    driver.damagePlayer(20);
    expect(driver.playerHealth).toBe(before - 20);
    expect(driver.events).toContain('pain');
    // STAT_FLASHES blood bit latched for exactly this tick.
    expect(driver.damageFlashes() & 1).toBe(1);
    // count 20 -> alpha 0.2, pure-red blood mix (no armor port).
    const ov = driver.damageOverlay();
    expect(ov).not.toBeNull();
    expect(ov!.a).toBeCloseTo(0.2, 9);
    expect(ov!.r).toBeCloseTo(255, 9);
    expect(ov!.g).toBeCloseTo(0, 9);
    expect(ov!.b).toBeCloseTo(0, 9);
  });

  it('repeated hits accumulate to the 0.6 cap, then decay 0.06/tick', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    const { driver } = boot;
    settle(driver);
    driver.damagePlayer(20);
    // Direct second hit: same-tick accumulation is per health mirror, so
    // step once (latch clears, alpha persists) and hit again.
    stepDriver(driver, neutralCmd(), 1);
    expect(driver.damageOverlay()!.a).toBeCloseTo(0.14, 9);
    driver.damagePlayer(20);
    expect(driver.damageOverlay()!.a).toBeCloseTo(0.34, 9);
    driver.damagePlayer(20);
    expect(driver.damageOverlay()!.a).toBeCloseTo(0.54, 9);
    driver.damagePlayer(20);
    expect(driver.damageOverlay()!.a).toBeCloseTo(0.6, 9);
    expect(driver.playerDead).toBe(false);
    stepDriver(driver, neutralCmd(), 10);
    expect(driver.damageOverlay()).toBeNull();
  });

  it('directional kick: frontal hit pitches, side hit rolls (C signs)', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    const { driver } = boot;
    settle(driver);
    driver.pm.viewAngles = v3(0, 0, 0);
    stepDriver(driver, neutralCmd([0, 0, 0]), 1);
    const o = driver.pm.origin;
    const hp0 = driver.playerHealth;
    // Attacker 50u ahead (+X): dir ~ +forward -> pitch = -kick*0.3, no roll.
    driver.damagePlayer(20, v3(o[0]! + 50, o[1]!, o[2]!));
    const applied = hp0 - driver.playerHealth;
    const hp1 = driver.playerHealth;
    const kick = Math.min(50, Math.max((applied * 100) / hp1, applied * 0.5));
    const k = driver.viewKick()!;
    expect(k.angles[0]).toBeCloseTo(-kick * 0.3, 6);
    expect(k.angles[2]).toBeCloseTo(0, 6);
    // Kick decays: one tick later the damage term reads 0.8x.
    stepDriver(driver, neutralCmd([0, 0, 0]), 1);
    expect(driver.viewKick()!.angles[0]).toBeCloseTo(-kick * 0.3 * 0.8, 6);
    // Five more ticks: the 0.5s window lapses, kick reads exactly zero.
    stepDriver(driver, neutralCmd([0, 0, 0]), 5);
    expect(driver.viewKick()).toBeNull();
  });

  it('side hit rolls the view with the C sign (right-hand hit -> +roll)', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    const { driver } = boot;
    settle(driver);
    driver.pm.viewAngles = v3(0, 0, 0);
    stepDriver(driver, neutralCmd([0, 0, 0]), 1);
    const o = driver.pm.origin;
    driver.damagePlayer(20, v3(o[0]!, o[1]! - 50, o[2]!));
    const k = driver.viewKick()!;
    expect(k.angles[2]).toBeGreaterThan(0.5);
    expect(Math.abs(k.angles[0])).toBeLessThan(0.5);
  });

  it('lethal hit blends but kicks nothing, poses the death cam, and resets on respawn', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    const { driver } = boot;
    settle(driver);
    driver.pm.viewAngles = v3(0, 0, 0);
    stepDriver(driver, neutralCmd([0, 0, 0]), 1);
    driver.damagePlayer(500);
    expect(driver.playerHealth).toBe(0);
    expect(driver.events).toContain('death');
    // Lethal blend still lands (C applies it), kick does not (health > 0 gate).
    expect(driver.damageOverlay()).not.toBeNull();
    // Death cam: additive delta to pitch -15 / roll 40 (deadflag branch).
    expect(driver.viewKick()!.angles).toEqual([-15, 0, 40]);
    stepDriver(driver, neutralCmd([0, 0, 0]), 25);
    expect(driver.playerDead).toBe(false);
    expect(driver.playerHealth).toBe(100);
    expect(driver.damageOverlay()).toBeNull();
    expect(driver.damageFlashes()).toBe(0);
    expect(driver.viewKick()).toBeNull();
  });

  it('invulnerability suppresses the pain sound but keeps the event + blend', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    const { driver } = boot;
    settle(driver);
    driver.ps.invulnUntil = driver.server.time + 30;
    const heard = driver.heardSounds.length;
    driver.damagePlayer(20);
    expect(driver.events).toContain('pain');
    expect(driver.heardSounds.length).toBe(heard); // C: no pain sound when invincible
    expect(driver.damageOverlay()).not.toBeNull();
    expect(driver.damageFlashes() & 1).toBe(1);
  });
});

describe('RELEASE-14 strafe view roll (SV_CalcViewOffset lean)', () => {
  it('strafing right rolls +, strafing left rolls - (~1deg at 200u/s)', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    const { driver } = boot;
    settle(driver);
    const strafeRight: UserCmdT = { ...neutralCmd([0, 0, 0]), sidemove: 200 };
    stepDriver(driver, strafeRight, 12);
    expect(Math.abs(driver.pm.velocity[1]!)).toBeGreaterThan(100);
    const kr = driver.viewKick()!;
    // C: side 200 * run_roll 0.005 = 1.0, plus <= 0.4 bob lean.
    expect(kr.angles[2]).toBeGreaterThan(0.4);
    expect(kr.angles[2]).toBeLessThan(1.6);
    const strafeLeft: UserCmdT = { ...neutralCmd([0, 0, 0]), sidemove: -200 };
    stepDriver(driver, strafeLeft, 24);
    const kl = driver.viewKick()!;
    expect(kl.angles[2]).toBeLessThan(-0.4);
    expect(kl.angles[2]).toBeGreaterThan(-1.6);
  });

  it('lean rides the submitted camera on both frame builders, identically', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    const { host, driver } = boot;
    settle(driver);
    stepDriver(driver, { ...neutralCmd([0, 0, 0]), sidemove: 200 }, 12);
    const kick = driver.viewKick()!;
    // buildAsyncView (GPU path) submits base view + the same kick read.
    const { view } = buildAsyncView(host, 0);
    expect(view.angles[2]).toBeCloseTo(kick.angles[2], 6);
    expect(view.angles[0]).toBeCloseTo(kick.angles[0], 6);
    // Host builder agrees: one render, same camera (no double-apply —
    // reads are pure, kick state is untouched by rendering).
    const again = driver.viewKick()!;
    expect(again.angles).toEqual(kick.angles);
    const stats = host.renderCurrentView();
    expect(stats.pixels).toBeGreaterThan(0);
    expect(driver.viewKick()!.angles).toEqual(kick.angles);
  });

  it('lean applies airborne too (C gates none of the velocity term)', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    const { driver } = boot;
    settle(driver);
    driver.pm.onGround = false;
    driver.pm.velocity = v3(0, -200, 0);
    const k = driver.viewKick()!;
    expect(k.angles[2]).toBeGreaterThan(0.4);
  });

  it('lean never feeds back into aim: viewAngles untouched, bolt flies unleaned', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    const { driver } = boot;
    settle(driver);
    const aim: [number, number, number] = [0, 0, 0];
    stepDriver(driver, { ...neutralCmd(aim), sidemove: 200 }, 8);
    const lean = driver.viewKick()!;
    expect(Math.abs(lean.angles[2])).toBeGreaterThan(0.3);
    const before: [number, number, number] = [
      driver.pm.viewAngles[0]!,
      driver.pm.viewAngles[1]!,
      driver.pm.viewAngles[2]!,
    ];
    driver.viewKick();
    buildAsyncView(boot.host, 0);
    expect(Array.from(driver.pm.viewAngles)).toEqual(before);
    // Fire while leaning: the bolt leaves along the unleaned view forward.
    driver.step({ ...neutralCmd(aim), sidemove: 200, buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.bolts.length).toBeGreaterThan(0);
    const fwd = v3();
    AngleVectors(v3(aim[0], aim[1], aim[2]), fwd);
    const dir = driver.bolts[driver.bolts.length - 1]!.dir;
    const dot = dir[0]! * fwd[0]! + dir[1]! * fwd[1]! + dir[2]! * fwd[2]!;
    expect(dot).toBeGreaterThan(Math.cos((0.5 * Math.PI) / 180));
  });
});

describe('RELEASE-14 presentation: one wash, readable HUD, two resolutions', () => {
  /** Blank-target overlay math at two resolutions (resolution-independent). */
  for (const [w, h] of [[160, 120], [320, 240]] as const) {
    it(`red wash composites exactly on a ${w}x${h} buffer, HUD paints after unblended`, () => {
      const boot = bootPlay({ width: w, height: h });
      const { driver } = boot;
      settle(driver);
      driver.damagePlayer(30); // alpha 0.3
      const target = { width: w, height: h, color: new Uint32Array(w * h) };
      drawPlayHud(target, boot, { fps: 0, frame: 1 });
      // Overlay first: a world pixel reads the SRC_OVER red wash...
      const px = target.color[((h / 2 + 20) | 0) * w + (w / 2)]!;
      expect(px & 255).toBeGreaterThan(50); // R lane lifted by 0.3*255
      // ...while the centered crosshair dot still paints full white after it.
      const cx = (w / 2) | 0;
      const cy = (h / 2) | 0;
      expect(target.color[cy * w + cx]).toBe(0xffffffff);
      // Rendering never mutates the wash: a second paint reads the same state.
      const a0 = driver.damageOverlay()!.a;
      drawPlayHud(target, boot, { fps: 0, frame: 1 });
      expect(driver.damageOverlay()!.a).toBe(a0);
    });
  }

  it('world-backed frame: damaged mean-R exceeds control, crosshair identical', () => {
    const renderMean = (hurt: boolean): { meanR: number; cross: number } => {
      const boot = bootPlay({ width: 160, height: 120 });
      const { host, driver } = boot;
      for (let t = 0; t <= 500; t += 16) host.frame(t);
      if (hurt) {
        driver.damagePlayer(30);
        driver.damagePlayer(30); // alpha 0.6 wash, still alive at 40hp
      }
      host.frame(516);
      const live = resolveDisplay(boot);
      const target = { width: 160, height: 120, color: new Uint32Array(live) };
      drawPlayHud(target, boot, { fps: 0, frame: 1 });
      let sum = 0;
      for (const px of target.color) sum += px & 255;
      const cx = 80;
      const cy = 60;
      return { meanR: sum / target.color.length, cross: target.color[cy * 160 + cx]! };
    };
    const ctl = renderMean(false);
    const dmg = renderMean(true);
    expect(dmg.meanR - ctl.meanR).toBeGreaterThan(15);
    expect(dmg.cross).toBe(ctl.cross);
    expect(dmg.cross).toBe(0xffffffff);
  });
});

describe('RELEASE-14 flashes: just-hit field_3 vs low-health blink', () => {
  it('statusbar producer latches one tick, then clears while health stays low', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    const { driver } = boot;
    settle(driver);
    while (driver.playerHealth > 25) driver.damagePlayer(20);
    expect(driver.playerHealth).toBeLessThanOrEqual(25);
    // Just-hit tick: the blood bit is set.
    expect(statusbarStateFor(boot).stats[15]! & 1).toBe(1);
    stepDriver(driver, neutralCmd(), 3);
    // Still low, no fresh hit: latch clear — blink owns the low state now.
    expect(driver.playerHealth).toBeLessThanOrEqual(25);
    expect(statusbarStateFor(boot).stats[15]!).toBe(0);
  });

  it('hnum renders field_3 only on the hit tick, anum blink on low health', () => {
    const ops = parseStatusbar('xv 0 yv 0 hnum');
    const state = (health: number, flashes: number, serverframe: number) => ({
      stats: [0, health, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, flashes],
      images: [] as string[],
      configstrings: [] as string[],
      serverframe,
      clientInfo: () => null,
    });
    // Healthy, no flash: green digits, no background.
    let cmds = executeStatusbar(ops, state(100, 0, 0), 320, 240);
    expect(cmds.some((c) => c.kind === 'pic')).toBe(false);
    expect(cmds.find((c) => c.kind === 'field')).toMatchObject({ style: 'num' });
    // Just-hit at full health: field_3 background, digits stay green.
    cmds = executeStatusbar(ops, state(100, 1, 0), 320, 240);
    expect(cmds.some((c) => c.kind === 'pic' && c.name === 'field_3')).toBe(true);
    expect(cmds.find((c) => c.kind === 'field')).toMatchObject({ style: 'num' });
    // Low health, no fresh hit: red blink digits, NO field_3.
    cmds = executeStatusbar(ops, state(20, 0, 4), 320, 240);
    expect(cmds.some((c) => c.kind === 'pic')).toBe(false);
    expect(cmds.find((c) => c.kind === 'field')).toMatchObject({ style: 'anum', value: 20 });
  });
});
