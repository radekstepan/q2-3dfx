// weaponAnim pins (game/p_weapon.c Weapon_Generic + Weapon_Grenade tables).
import { describe, expect, it } from 'vitest';
import {
  GUN_FIRE_FRAMES,
  GUN_PAUSE_FRAMES,
  gunFireFrames,
  gunPauseFrames,
  isGunFireFrame,
  stepGunReady,
} from './weaponAnim.js';

describe('Weapon_Generic idle tables', () => {
  it('blaster pauses at 19/32 and fires on 5 (4,8,52,55)', () => {
    expect(gunPauseFrames('weapon_blaster')).toEqual([19, 32]);
    expect(gunFireFrames('weapon_blaster')).toEqual([5]);
  });
  it('shotgun/machinegun/chaingun tables match their call sites', () => {
    expect(gunPauseFrames('weapon_shotgun')).toEqual([22, 28, 34]);
    expect(gunFireFrames('weapon_shotgun')).toEqual([8, 9]);
    expect(gunPauseFrames('weapon_machinegun')).toEqual([23, 45]);
    expect(gunFireFrames('weapon_machinegun')).toEqual([4, 5]);
    expect(gunPauseFrames('weapon_chaingun')).toEqual([38, 43, 51, 61]);
    expect(GUN_FIRE_FRAMES['weapon_chaingun']!.length).toBe(17);
    expect(GUN_FIRE_FRAMES['weapon_chaingun']![0]).toBe(5);
    expect(GUN_FIRE_FRAMES['weapon_chaingun']![16]).toBe(21);
  });
  it('grenades use the custom Weapon_Grenade pauses (29/34/39/48)', () => {
    expect(gunPauseFrames('weapon_grenades')).toEqual([29, 34, 39, 48]);
  });
  it('unknown weapons read empty (no holds, no pauses)', () => {
    expect(gunPauseFrames('weapon_bogus')).toEqual([]);
    expect(gunFireFrames('weapon_bogus')).toEqual([]);
  });
  it('pause table lengths match source (spot check)', () => {
    expect(GUN_PAUSE_FRAMES['weapon_bfg']).toEqual([39, 45, 50, 55]);
    expect(gunFireFrames('weapon_bfg')).toEqual([9, 17]);
    expect(gunPauseFrames('weapon_hyperblaster')).toEqual([]);
    expect(gunPauseFrames('weapon_railgun')).toEqual([56]);
  });
});

describe('stepGunReady (WEAPON_READY branch)', () => {
  it('walks IDLE_FIRST..IDLE_LAST then wraps (blaster 9..52)', () => {
    expect(stepGunReady(9, 9, 52, [19, 32], false)).toBe(10);
    expect(stepGunReady(51, 9, 52, [19, 32], false)).toBe(52);
    expect(stepGunReady(52, 9, 52, [19, 32], false)).toBe(9);
  });
  it('holds on pause frames iff the rand bit holds (C rand()&15)', () => {
    expect(stepGunReady(19, 9, 52, [19, 32], true)).toBe(19);
    expect(stepGunReady(19, 9, 52, [19, 32], false)).toBe(20);
    expect(stepGunReady(32, 9, 52, [19, 32], true)).toBe(32);
    // Non-pause frames ignore the hold bit.
    expect(stepGunReady(20, 9, 52, [19, 32], true)).toBe(21);
  });
  it('clamps stale frames into the idle range', () => {
    expect(stepGunReady(0, 9, 52, [19, 32], false)).toBe(9);
  });
});

describe('isGunFireFrame (WEAPON_FIRING hold)', () => {
  it('matches the fire-frame lists', () => {
    expect(isGunFireFrame(5, [5])).toBe(true);
    expect(isGunFireFrame(6, [5])).toBe(false);
    expect(isGunFireFrame(9, [8, 9])).toBe(true);
  });
});
