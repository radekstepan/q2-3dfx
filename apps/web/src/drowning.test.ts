// Driver-loop water: browser drowning on the C schedule (BRAIN.md §15).
//
// Boots real base1 through the REAL driver+server tick loop (bootPlay) and
// asserts submitted/exposed state — never sim internals for the verdict:
//   (t1) a submerged head categorizes waterlevel 3 in-browser, airLeft
//        drains from the 12s grace, health drops 4,6,8… (1/s, cap 15),
//        watr_in + per-tick gurp hooks fire; resurfacing recovers air to
//        12 with watr_out + a gasp and no further damage.
//   (t2) the out-of-water vault engages against a real wall in the driver
//        loop (TIME_WATERJUMP + the C 350-80 impulse) — inert before the
//        solid-aware contents wiring, since the SOLID probe was always false.
//
// Water spots surveyed against the real lump (pointLeaf): the low-road pool
// spans x 304..1136 / y 464..816, surface ≈ -250, floor ≈ -320; (430,620)
// is deep, hull-free, and has no monster LOS (sight audit: none of the 19
// monsters sees it, so the damage schedule is pure drowning). The vault
// wall stands south of (640,490,-260) at waterlevel 2 facing -Y.
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars } from '@q2/config';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import { PMF_TIME_WATERJUMP } from '@q2/game';
import { bootPlay } from './play.js';

const WEB_Q2_PAK = process.env.Q2_PAK;

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
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

describe.runIf(!!WEB_Q2_PAK)('driver water: browser drowning (t1+t2)', () => {
  it('(t1) submerged head drowns on the C schedule; resurfacing recovers', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // Spawn is dry: a few ticks latch the C 12s grace (air_finished = now+12
    // whenever the head is out).
    for (let i = 0; i < 5; i++) driver.step(neutralCmd(), 0.1);
    expect(driver.pm.waterlevel).toBe(0);
    expect(driver.playerAirLeft).toBeCloseTo(12, 5);
    const spawn = v3(driver.pm.origin[0], driver.pm.origin[1], driver.pm.origin[2]);
    // Teleport into the deep pool: hull-free, waterlevel 3 (probed against
    // the real lump), no monster LOS so the schedule below is pure drowning.
    driver.pm.origin = v3(430, 620, -280);
    driver.pm.velocity = v3();
    driver.step(neutralCmd(), 0.1);
    // EXPOSED verdict: the browser categorizes water now (legacy solid-less
    // hook left pm.waterlevel at 0 here forever — the reported bug).
    expect(driver.pm.waterlevel).toBe(3);
    expect(driver.heardSounds).toContain('player/watr_in.wav');
    // Swim out the grace: health must hold at 100 until ~12s after the last
    // dry tick, then the C ramp lands at 1/s: 4,6,8… capped at 15.
    const hp: number[] = [driver.playerHealth];
    let firstDmgAt = -1;
    for (let i = 0; i < 200 && driver.playerHealth > 0; i++) {
      driver.step(neutralCmd(), 0.1);
      hp.push(driver.playerHealth);
      if (firstDmgAt < 0 && driver.playerHealth < 100) firstDmgAt = i;
      // Keep sampling past the first ticks to collect the ramp (stop once
      // four drown ticks have landed — enough to pin 4,6,8,10).
      if (firstDmgAt >= 0) {
        let drops = 0;
        for (let k = 1; k < hp.length; k++) if (hp[k]! < hp[k - 1]!) drops++;
        if (drops >= 4) break;
      }
      if (driver.pm.waterlevel !== 3) break; // sank out of the sample? fail below
    }
    // Stayed head-under the whole run (no drift out of the pool).
    expect(driver.pm.waterlevel).toBe(3);
    // Grace held: no damage for ~12s after the last dry tick (≈120 ticks at
    // 10Hz; the settle tick above is included in the count).
    expect(firstDmgAt).toBeGreaterThanOrEqual(100);
    expect(firstDmgAt).toBeLessThan(160);
    // The ramp: first tick 4 (C deals dmg AFTER += 2 from the reset 2), then
    // +2 per second, capped at 15 (p_view.c DROWN_DAMAGE_CAP).
    const drops: number[] = [];
    for (let k = 1; k < hp.length; k++) {
      if (hp[k]! < hp[k - 1]!) drops.push(hp[k - 1]! - hp[k]!);
    }
    expect(drops.length).toBeGreaterThanOrEqual(4);
    expect(drops[0]).toBe(4);
    for (let k = 1; k < drops.length; k++) {
      expect(drops[k]! - drops[k - 1]!).toBeLessThanOrEqual(2);
      expect(drops[k]!).toBeLessThanOrEqual(15);
    }
    // Per-second drown hooks fired while under (gurp on non-lethal ticks).
    expect(
      driver.heardSounds.some((n) => n === '*gurp1.wav' || n === '*gurp2.wav'),
    ).toBe(true);
    // Air drained while under.
    expect(driver.playerAirLeft).toBeLessThan(6);
    // Resurface back at spawn: air returns to grace, exit + gasp hooks fire,
    // and the damage stops (recovery).
    driver.pm.origin = v3(spawn[0], spawn[1], spawn[2]);
    driver.pm.velocity = v3();
    for (let i = 0; i < 10; i++) driver.step(neutralCmd(), 0.1);
    expect(driver.pm.waterlevel).toBe(0);
    expect(driver.playerAirLeft).toBeCloseTo(12, 5);
    expect(driver.heardSounds).toContain('player/watr_out.wav');
    expect(
      driver.heardSounds.some((n) => n === 'player/gasp1.wav' || n === 'player/gasp2.wav'),
    ).toBe(true);
    const hpAfter = driver.playerHealth;
    for (let i = 0; i < 20; i++) driver.step(neutralCmd(), 0.1);
    expect(driver.playerHealth).toBe(hpAfter);
  });

  it('(t2) out-of-water vault engages against a real wall in the driver loop', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // Waterlevel-2 stance against the pool's south wall (probed free-hull
    // against the real lump), facing the wall (-Y, yaw -90).
    driver.pm.origin = v3(640, 490, -260);
    driver.pm.velocity = v3();
    driver.step(neutralCmd([0, -90, 0]), 0.1);
    // First tick categorizes (no vault yet — the check reads the previous
    // tick's level, exactly like C).
    expect(driver.pm.waterlevel).toBe(2);
    expect(driver.pm.pmFlags & PMF_TIME_WATERJUMP).toBe(0);
    driver.step(neutralCmd([0, -90, 0]), 0.1);
    // The vault engaged: C-exact 50u/s shove + 350 gravity impulse, consumed
    // by the same-tick TIME_WATERJUMP branch (350 - 800*0.1 = 270).
    expect(driver.pm.pmFlags & PMF_TIME_WATERJUMP).toBe(PMF_TIME_WATERJUMP);
    expect(driver.pm.pmTime).toBeGreaterThan(0);
    expect(driver.pm.velocity[2]!).toBeCloseTo(270, 0);
  });
});
