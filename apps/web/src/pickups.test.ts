// Base1 pickup wiring pins (driver-level bot: real lump, real tick loop).
//
// Prior lanes landed the game-side defs (item_silencer +30 shots,
// ammo_grenades 5/cap 50, 8 weapon defs, quad/invuln/adrenaline/keys) and the
// server spawn (items SOLID_TRIGGER, monsters SOLID_BBOX). This file pins
// the DRIVER half in the same tree:
// - silencer under the stairs (-408,704,-112, target t76) picks up via the
//   walk-over box and banks 30 silencerShots (firing t76, the secret);
// - grenade secret cache (1056,888,-216) picks up (+5 grenades) — the items
//   keep their mapper origins (the sim never tosses/droptofloors); the
//   pickup box (dx/dy 40, dz -24..64) reaches them from the room floor;
// - shotgun pickup auto-switches through the unified selectWeapon
//   lower/raise (no stale gunframe);
// - worldModelForPickup + HUD/ammo plumbing cover every new item/ammo kind.
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars } from '@q2/config';
import { BUTTON_DUCK } from '@q2/input';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import { findWeapon, PMF_DUCKED } from '@q2/game';
import { SV_SetPlayerHealth } from '@q2/server';
import { bootPlay, worldModelForPickup } from './play.js';
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

/** Teleport above a spot and fall in the way the engine does (C +1/32 rest). */
function settleAbove(driver: LocalDriver, x: number, y: number, z: number, n = 15): void {
  driver.pm.origin = v3(x, y, z);
  driver.pm.velocity = v3();
  stepDriver(driver, neutralCmd(), n);
}

afterEach(() => {
  resetCVars();
});

describe.runIf(!!WEB_Q2_PAK)('base1 pickup wiring (Q2_PAK)', () => {
  it('silencer under the stairs picks up: +30 shots, t76 secret, message + sound', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const sil = driver.server.entities.find((e) => e.classname === 'item_silencer')!;
    expect(sil).toBeDefined();
    expect([...sil.origin]).toEqual([-408, 704, -112]);
    expect(sil.target).toBe('t76');
    expect(driver.ps.silencerShots).toBe(0);
    const liveBefore = driver.livePickupCount();
    expect(liveBefore).toBeGreaterThan(0);
    // The nook is a LOW crawl (standing hull never fits — ceiling above the
    // -96 walk line is solid): enter ducked into open air and crouch-walk
    // the corridor north to the item. Mapper origin kept (never
    // droptofloored/tossed); feet -104 vs item -112 → dz +8, in the window.
    driver.pm.origin = v3(-408, 620, -96);
    driver.pm.velocity = v3();
    const duck: UserCmdT = { msec: 100, angles: [0, 90, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_DUCK };
    for (let i = 0; i < 10; i++) {
      SV_SetPlayerHealth(driver.server, 100); // setup: hold the walker alive
      driver.step(duck, 0.1);
    }
    expect(driver.pm.pmFlags & PMF_DUCKED).toBe(PMF_DUCKED);
    expect(driver.pm.onGround).toBe(true);
    let n = 0;
    while (!driver.events.includes('pickup') && n++ < 40) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step({ ...duck, forwardmove: 100 }, 0.1);
    }
    expect(driver.events).toContain('pickup');
    expect(sil.freed).toBe(true);
    expect(driver.ps.silencerShots).toBe(30);
    // The lump chains the grab to t76 (target_secret "You have found a
    // secret."): the driver fires the FULL item-target cascade
    // (fireTargets — C Touch_Item G_UseTargets uses every edict carrying
    // the targetname, including the secret itself), so foundSecrets
    // increments on this path, exactly once (single-use G_FreeEdict: the
    // secret-trace leg in release-6-hud-web.test.ts pins the count).
    expect(driver.server.foundSecrets).toBe(1);
    expect(driver.livePickupCount()).toBe(liveBefore - 1);
    expect(driver.message).toContain('silencer');
    expect(driver.heardSounds).toContain('items/pkup.wav');
    // Rendered: no longer submitted as a spinning pickup.
    const extras = driver.extraEntities() ?? [];
    expect(extras.some((x) => Math.hypot(x.origin![0]! + 408, x.origin![1]! - 704) < 1)).toBe(false);
  });

  it('grenade secret cache picks up: +5 grenades alongside the shards', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const cache = driver.server.entities.find(
      (e) => e.classname === 'ammo_grenades' && Math.abs(e.origin[0]! - 1056) < 2 && Math.abs(e.origin[1]! - 888) < 2,
    )!;
    expect(cache).toBeDefined();
    expect(cache.origin[2]).toBe(-216);
    // Room air starts below the -160 ceiling: drop in open, fall to the
    // -208 floor (feet vs item -216 → dz +8, inside -24..64).
    settleAbove(driver, 1056, 902, -176);
    expect(driver.pm.onGround).toBe(true);
    expect(driver.pm.origin[2]!).toBeCloseTo(-208, 0);
    let n = 0;
    while (!driver.events.includes('pickup') && n++ < 30) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
    }
    expect(driver.events).toContain('pickup');
    expect(cache.freed).toBe(true);
    expect(driver.grenades).toBe(5);
    expect(driver.ps.ammo['grenades']).toBe(5);
    // Several cache items land on the same tick (grenades + shards share the
    // box); the status line names the last one grabbed — any cache item.
    expect(driver.message).toMatch(/grenades|armor shard/);
    // The neighboring shards are walked the same way (armor banks).
    settleAbove(driver, 1078, 910, -176);
    n = 0;
    const pickupsBefore = driver.events.filter((e) => e === 'pickup').length;
    while (driver.events.filter((e) => e === 'pickup').length < pickupsBefore + 1 && n++ < 30) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
    }
    expect(driver.ps.armor).toBeGreaterThan(0);
  });

  it('shotgun pickup auto-switches through lower/raise (no stale gunframe)', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    expect(driver.hasWeapon('weapon_shotgun')).toBe(false);
    expect(driver.weapon.classname).toBe('weapon_blaster');
    // Blaster READY frame before the grab (would be stale after a swap).
    expect(driver.gunFrame).toBe(9);
    // The exact lump origin is open air (gate (h) pattern); falling in from
    // above wedges startsolid in the low ceiling, so footprint it directly.
    driver.pm.origin = v3(800, -96, -168);
    driver.pm.velocity = v3();
    let n = 0;
    while (!driver.events.includes('pickup') && n++ < 20) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
    }
    expect(driver.events).toContain('pickup');
    expect(driver.hasWeapon('weapon_shotgun')).toBe(true);
    // Unified path: the grab routes through selectWeapon, so the switch
    // runs (drop leg of the outgoing blaster) instead of keeping frame 9.
    expect(driver.events).toContain('weapon');
    expect(driver.weaponSwitching).toBe(true);
    expect(driver.gunFrame).not.toBe(9);
    n = 0;
    while (driver.weaponSwitching && n++ < 40) stepDriver(driver, neutralCmd(), 1);
    expect(driver.weaponSwitching).toBe(false);
    expect(driver.weapon.classname).toBe('weapon_shotgun');
    expect(driver.gunFrame).toBe(19); // shotgun IDLE_FIRST (READY)
    // Pickup ammo gift rode along (C Pickup_Weapon shells gift).
    expect(driver.shells).toBeGreaterThan(0);
  });

  it('worldModelForPickup + registration cover every new item (C lumps, pak-verified)', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    expect(worldModelForPickup('item_silencer')).toBe('models/items/silencer/tris.md2');
    expect(worldModelForPickup('ammo_grenades')).toBe('models/items/ammo/grenades/medium/tris.md2');
    expect(worldModelForPickup('ammo_cells')).toBe('models/items/ammo/cells/medium/tris.md2');
    expect(worldModelForPickup('ammo_rockets')).toBe('models/items/ammo/rockets/medium/tris.md2');
    expect(worldModelForPickup('ammo_slugs')).toBe('models/items/ammo/slugs/medium/tris.md2');
    expect(worldModelForPickup('weapon_supershotgun')).toBe('models/weapons/g_shotg2/tris.md2');
    expect(worldModelForPickup('weapon_chaingun')).toBe('models/weapons/g_chain/tris.md2');
    expect(worldModelForPickup('weapon_grenadelauncher')).toBe('models/weapons/g_launch/tris.md2');
    expect(worldModelForPickup('weapon_rocketlauncher')).toBe('models/weapons/g_rocket/tris.md2');
    expect(worldModelForPickup('weapon_hyperblaster')).toBe('models/weapons/g_hyperb/tris.md2');
    expect(worldModelForPickup('weapon_railgun')).toBe('models/weapons/g_rail/tris.md2');
    expect(worldModelForPickup('weapon_bfg')).toBe('models/weapons/g_bfg/tris.md2');
    // Hand grenades show the ammo box (C has no g_ world model for them).
    expect(worldModelForPickup('weapon_grenades')).toBeNull();
    // All spinning world models registered (base1's remnant weapons are
    // DM-inhibited in SP, but DM/ Synthetic grants still render).
    for (const cls of [
      'weapon_supershotgun', 'weapon_chaingun', 'weapon_grenadelauncher',
      'weapon_rocketlauncher', 'weapon_hyperblaster', 'weapon_railgun', 'weapon_bfg',
    ]) {
      expect(boot.models!.items[cls]).toBeDefined();
    }
    expect(boot.models!.items['item_silencer']).toBeDefined();
    expect(boot.models!.items['ammo_grenades']).toBeDefined();
  });

  it('hudAmmo + compat counters read every ammo kind', async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    expect(driver.hudAmmo()).toBe('∞');
    // Compat counters are public/mutable; syncAmmo (private) mirrors
    // PlayerState into them on every real pickup (pinned by the bot tests
    // above: grenades === 5, shells > 0 after genuine grants).
    const setCompat = (kind: string, v: number): void => {
      if (kind === 'shells') driver.shells = v;
      else if (kind === 'bullets') driver.bullets = v;
      else if (kind === 'grenades') driver.grenades = v;
      else if (kind === 'cells') driver.cells = v;
      else if (kind === 'rockets') driver.rockets = v;
      else if (kind === 'slugs') driver.slugs = v;
    };
    const cases: Array<[string, string, number, string]> = [
      ['weapon_shotgun', 'shells', 7, '7'],
      ['weapon_machinegun', 'bullets', 50, '50'],
      ['weapon_supershotgun', 'shells', 3, '3'],
      ['weapon_chaingun', 'bullets', 11, '11'],
      ['weapon_grenades', 'grenades', 5, '5'],
      ['weapon_grenadelauncher', 'grenades', 2, '2'],
      ['weapon_rocketlauncher', 'rockets', 4, '4'],
      ['weapon_hyperblaster', 'cells', 30, '30'],
      ['weapon_railgun', 'slugs', 9, '9'],
      ['weapon_bfg', 'cells', 60, '60'],
    ];
    for (const [cls, kind, v, want] of cases) {
      driver.weapon = findWeapon(cls)!;
      setCompat(kind, v);
      expect(driver.hudAmmo()).toBe(want);
    }
  });
});
