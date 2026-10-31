// Regression wave: explosion smoothing + DM skill inhibit + sky-hit silence.
// Driver renders server state only (BRAIN.md §15): explosions interpolate
// oldframe -> frame by backlerp with alpha fade; DM-only (1792) items are
// never submitted/pickable in SP; freed-sky bolts leave no remnant.
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars } from '@q2/config';
import { spawnEdict } from '@q2/game';
import { v3 } from '@q2/math';
import type { UserCmdT } from '@q2/input';
import {
  applyRendererCvar,
  bootPlay,
  getSkill,
  parseSpawnflags,
  pumpExplosionLights,
  skillInhibits,
} from './play.js';

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

afterEach(() => {
  resetCVars();
});

describe('explosion smoothing (oldframe/backlerp/alpha)', () => {
  it('server explosion extras interpolate with alpha fade', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    // No pak: models are null, so stub the models block minimally (zeros
    // + items map). Only the explosion/pickup paths read it here.
    (driver as unknown as { models: unknown }).models = {
      monster: 0, monsterSkin: 0, soldierLightSkin: 0, soldierSsSkin: 0,
      gunner: 0, gunnerSkin: 0, weapons: {}, weaponSkins: {},
      bolt: 0, boltSkin: 0, barrel: 0, barrelSkin: 0,
      explode: 7, explodeSkin: 8, explodeSkins: [11, 12, 13, 14, 15, 16], blast: 9, blastSkin: 10,
      debris1: 0, debris1Skin: 0, debris2: 0, debris2Skin: 0, debris3: 0, debris3Skin: 0,
      gibMeat: 0, gibMeatSkin: 0, gibChest: 0, gibChestSkin: 0,
      gibBone: 0, gibBoneSkin: 0, gibHead: 0, gibHeadSkin: 0,
      items: {}, ship: -1, shipSkin: 0, banner: -1, bannerSkin: 0, skins: [],
    };
    // Seed one big-boom explosion at t=0 and read it at the step start.
    // C CL_AddExplosions: frame = base+f+1, oldframe = base+f, front-lerp =
    // frac (0 at the step start = fully oldframe), ex_poly alpha (16-f)/16.
    driver.server.explosions.push({
      pos: v3(10, 20, 30), born: driver.server.time, kind: 'explosion1', baseframe: 0, yaw: 0,
    });
    const extras = driver.extraEntities()!;
    const boom = extras.find((x) => x.model === 7)!;
    expect(boom).toBeDefined();
    expect(boom.frame).toBe(1);
    expect(boom.oldframe).toBe(0);
    expect(boom.backlerp).toBeCloseTo(0, 5);
    expect(boom.alpha).toBeCloseTo(1, 5);
    expect(boom.skin).toBe(8);
    // Mid-life: frame advanced, blend partway, alpha faded, skin cycled
    // (f=2 → skinnum 1 → second r_explode skin).
    driver.server.time += 0.25;
    const mid = driver.extraEntities()!.find((x) => x.model === 7)!;
    expect(mid.frame).toBe(3);
    expect(mid.oldframe).toBe(2);
    expect(mid.backlerp).toBeCloseTo(0.5, 5);
    expect(mid.alpha).toBeCloseTo((16 - 2) / 16, 5);
    expect(mid.skin).toBe(11);
    // Aged out: no remnant submitted.
    driver.server.time += 10;
    const gone = (driver.extraEntities() ?? []).filter((x) => x.model === 7);
    expect(gone.length).toBe(0);
  });

  it('drainExplosions only reports live explosions (pruned = silent)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    expect(driver.drainExplosions().length).toBe(0);
    driver.server.explosions.push({
      pos: v3(0, 0, 0), born: driver.server.time, kind: 'blaster', baseframe: 0, yaw: 0,
    });
    expect(driver.drainExplosions().length).toBe(1);
    driver.server.time += 10;
    expect(driver.drainExplosions().length).toBe(0);
  });
});

describe('DM skill inhibit (web side)', () => {
  it('skillInhibits matches the C SpawnEntities filter at every skill', () => {
    for (const skill of [0, 1, 2, 3]) {
      expect(skillInhibits(1792, skill)).toBe(true);
    }
    expect(skillInhibits(0, getSkill())).toBe(false);
    expect(parseSpawnflags({ spawnflags: '1792' })).toBe(1792);
    expect(parseSpawnflags({})).toBe(0);
  });

  it('DM-only (1792) items are not submitted or pickable in SP', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    // Synthetic DM-only armor shard at the player feet (lump-style extra).
    const dm = spawnEdict({ classname: 'item_armor_shard', origin: '0 0 0', spawnflags: '1792' });
    // Synthetic normal shard next to it.
    const normal = spawnEdict({ classname: 'item_armor_shard', origin: '10 0 0' });
    driver.server.entities.push(dm, normal);
    // Submitted: with a models stub carrying the shard handle, only the
    // skill-kept shard renders; the DM-only one stays hidden.
    (driver as unknown as { models: unknown }).models = {
      monster: 0, monsterSkin: 0, soldierLightSkin: 0, soldierSsSkin: 0,
      gunner: 0, gunnerSkin: 0, weapons: {}, weaponSkins: {},
      bolt: 0, boltSkin: 0, barrel: 0, barrelSkin: 0,
      explode: 0, explodeSkin: 0, blast: 0, blastSkin: 0,
      debris1: 0, debris1Skin: 0, debris2: 0, debris2Skin: 0, debris3: 0, debris3Skin: 0,
      gibMeat: 0, gibMeatSkin: 0, gibChest: 0, gibChestSkin: 0,
      gibBone: 0, gibBoneSkin: 0, gibHead: 0, gibHeadSkin: 0,
      items: { item_armor_shard: { model: 41, skin: 42 } }, ship: -1, shipSkin: 0, banner: -1, bannerSkin: 0, skins: [],
    };
    const submitted = (driver.extraEntities() ?? []).filter((x) => x.model === 41);
    expect(submitted.length).toBe(1);
    expect(submitted[0]!.origin![0]).toBe(10);
    expect(driver.livePickupCount()).toBe(1);
    // Pickable: walk over both; the normal one grants, the DM-only stays.
    driver.pm.origin[0] = 5;
    driver.pm.origin[1] = 0;
    driver.pm.origin[2] = 0;
    driver.step(neutralCmd(), 0.1);
    expect(normal.freed).toBe(true);
    expect(dm.freed).toBe(false);
    expect(driver.events).toContain('pickup');
    // After the grant nothing live remains (picked one freed, DM excluded).
    expect(driver.livePickupCount()).toBe(0);
  });
});

describe('sky-hit silent free (web side)', () => {
  it('freed bolts with no explosion leave no tracer/dlight remnant', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    // Fire once so the server owns a live bolt, then simulate the
    // sky-hit silent free: bolt gone, no explosion/spark/tracer queued.
    driver.step({ ...neutralCmd(), buttons: 1 }, 0.1);
    expect(driver.bolts.length).toBeGreaterThan(0);
    driver.server.bolts.length = 0;
    expect(driver.bolts.length).toBe(0);
    // Driver renders live explosions only: nothing to submit or light.
    expect(driver.drainExplosions().length).toBe(0);
    expect(driver.extraEntities()).toBeNull();
    expect(pumpExplosionLights(boot)).toBe(0);
    // Hot-swap helper leaves sim state alone (renderer switch never reboots).
    const hostRef = boot.host;
    expect(applyRendererCvar(boot)).toBe('software');
    expect(boot.host).toBe(hostRef);
  });
});
