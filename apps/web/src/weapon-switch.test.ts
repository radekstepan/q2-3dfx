// Weapon_Generic lower/raise switch pins (p_weapon.c Weapon_Generic +
// ChangeWeapon, lite in apps/web play.ts).
//
// C rule: selecting a new gun lowers the OLD gun through its DEACTIVATE
// range (WEAPON_DROPPING), swaps it in at DEACTIVATE_LAST (ChangeWeapon),
// raises the new gun 0..ACTIVATE_LAST (WEAPON_ACTIVATING), then holds READY
// at IDLE_FIRST. Attack is ignored until READY. These run in devroom
// (no pak needed — gunframe is model-free driver state).
import { describe, expect, it } from 'vitest';
import type { UserCmdT } from '@q2/input';
import { bootPlay, gunBoundsFor } from './play.js';
import type { LocalDriver } from './play.js';

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

function attackCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 1 };
}

function stepDriver(driver: LocalDriver, cmd: UserCmdT, n: number): void {
  for (let i = 0; i < n; i++) driver.step(cmd, 0.1);
}

/** Step until the switch completes (cap guards against a stuck switch). */
function waitReady(driver: LocalDriver, cap = 40): number {
  let n = 0;
  while (driver.weaponSwitching && n++ < cap) stepDriver(driver, neutralCmd(), 1);
  return n;
}

describe('weapon lower/raise switch (Weapon_Generic-lite)', () => {
  it('gun bounds match the p_weapon.c call sites for all 11 weapons', () => {
    const c: Record<string, [number, number, number, number]> = {
      weapon_blaster: [4, 8, 52, 55],
      weapon_shotgun: [7, 18, 36, 39],
      weapon_supershotgun: [6, 17, 57, 61],
      weapon_machinegun: [3, 5, 45, 49],
      weapon_chaingun: [4, 31, 61, 64],
      weapon_grenadelauncher: [5, 16, 59, 64],
      weapon_rocketlauncher: [4, 12, 50, 54],
      weapon_hyperblaster: [5, 20, 49, 53],
      weapon_railgun: [3, 18, 56, 61],
      weapon_bfg: [8, 32, 55, 58],
    };
    for (const [cls, [a, f, i, d]] of Object.entries(c)) {
      const b = gunBoundsFor(cls);
      expect([b.activate, b.fire, b.idle, b.deactivate]).toEqual([a, f, i, d]);
    }
    // Hand grenades run the custom Weapon_Grenade (READY 16 = fire+1, throw
    // run-up 1..15, wrap 48): the lite equivalent keeps those landmarks.
    const g = gunBoundsFor('weapon_grenades');
    expect(g.fire + 1).toBe(16);
    expect(g.activate + 1).toBe(1);
  });

  it('blaster->shotgun drops the old gun, swaps at the drop end, raises to READY', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    expect(driver.weapon.classname).toBe('weapon_blaster');
    expect(driver.weaponSwitching).toBe(false);
    driver.ps.weapons.push('weapon_shotgun');
    driver.selectWeapon('weapon_shotgun');
    expect(driver.weaponSwitching).toBe(true);
    expect(driver.events).toContain('weapon');
    // Drop leg: starts at the OUTGOING (blaster) DEACTIVATE_FIRST = idle+1.
    expect(driver.gunFrame).toBe(52 + 1);
    expect(driver.weapon.classname).toBe('weapon_blaster');
    stepDriver(driver, neutralCmd(), 1);
    expect(driver.gunFrame).toBe(54);
    expect(driver.weapon.classname).toBe('weapon_blaster');
    stepDriver(driver, neutralCmd(), 1);
    expect(driver.gunFrame).toBe(55);
    // Reaching DEACTIVATE_LAST swaps the gun in at frame 0 (ChangeWeapon).
    stepDriver(driver, neutralCmd(), 1);
    expect(driver.weapon.classname).toBe('weapon_shotgun');
    expect(driver.gunFrame).toBe(0);
    expect(driver.weaponSwitching).toBe(true);
    // Raise leg: 0..ACTIVATE_LAST (7), then READY at IDLE_FIRST (19).
    for (let i = 0; i < 7; i++) {
      stepDriver(driver, neutralCmd(), 1);
      expect(driver.weapon.classname).toBe('weapon_shotgun');
    }
    expect(driver.gunFrame).toBe(7);
    expect(driver.weaponSwitching).toBe(true);
    stepDriver(driver, neutralCmd(), 1);
    expect(driver.weaponSwitching).toBe(false);
    expect(driver.gunFrame).toBe(18 + 1);
    // READY holds across further ticks.
    stepDriver(driver, neutralCmd(), 3);
    expect(driver.gunFrame).toBe(19);
    expect(driver.message).toContain('shotgun');
  });

  it('fire is blocked mid-switch (drop and raise legs): no shot, no ammo spent', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    driver.ps.weapons.push('weapon_shotgun');
    driver.ps.ammo['shells'] = 8;
    driver.shells = 8;
    driver.selectWeapon('weapon_shotgun');
    // Drop leg: trigger does nothing.
    driver.step(attackCmd(), 0.1);
    expect(driver.events).not.toContain('shot');
    expect(driver.shells).toBe(8);
    expect(driver.weaponSwitching).toBe(true);
    // Raise leg: still nothing (step to the swap, then attack mid-raise).
    stepDriver(driver, neutralCmd(), 2);
    expect(driver.weapon.classname).toBe('weapon_shotgun');
    driver.step(attackCmd(), 0.1);
    expect(driver.events).not.toContain('shot');
    expect(driver.shells).toBe(8);
    // READY: the same trigger fires and spends a shell.
    const n = waitReady(driver);
    expect(driver.weaponSwitching).toBe(false);
    expect(n).toBeLessThanOrEqual(40);
    driver.step(attackCmd(), 0.1);
    expect(driver.events).toContain('shot');
    expect(driver.shells).toBe(7);
  });

  it('re-selecting the raised gun is a no-op; unowned guns stay empty', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    const eventsBefore = driver.events.length;
    const frameBefore = driver.gunFrame;
    driver.selectWeapon('weapon_blaster');
    expect(driver.weaponSwitching).toBe(false);
    expect(driver.gunFrame).toBe(frameBefore);
    expect(driver.events.length).toBe(eventsBefore);
    driver.selectWeapon('weapon_railgun');
    expect(driver.events).toContain('empty');
    expect(driver.message).toBe('NO WEAPON');
    expect(driver.weapon.classname).toBe('weapon_blaster');
  });

  it('selecting mid-fire starts the drop at once (documented ≤2-tick deviation)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    driver.ps.weapons.push('weapon_shotgun');
    driver.ps.ammo['shells'] = 8;
    driver.shells = 8;
    // Fire the blaster (infinite ammo), then switch on the next tick.
    driver.step(attackCmd(), 0.1);
    expect(driver.events).toContain('shot');
    driver.selectWeapon('weapon_shotgun');
    expect(driver.weaponSwitching).toBe(true);
    expect(driver.gunFrame).toBe(53);
    waitReady(driver);
    expect(driver.weapon.classname).toBe('weapon_shotgun');
    expect(driver.weaponSwitching).toBe(false);
  });
});
