import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars } from '@q2/config';
import { isGreenBoltColor, soldierWeaponForSkin } from '@q2/game';
import { SV_SpawnMonster } from '@q2/server';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import { bootPlay, HITSCAN_TRACER_COLOR, PELLET_TRACER_COLOR, ENEMY_TRACER_LENGTH } from './play.js';

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

afterEach(() => {
  resetCVars();
});

describe('hitscan tracer color (no green lasers)', () => {
  it('hitscan color is the C-correct yellow, never palette green', () => {
    // Game-lane audit (@q2/game weapons.ts): 208–214 is GREEN on the engine
    // palette (the reported green laser); 225 is the near-white yellow core.
    expect(HITSCAN_TRACER_COLOR).toBe(225);
    expect(PELLET_TRACER_COLOR).toBe(HITSCAN_TRACER_COLOR);
    expect(isGreenBoltColor(HITSCAN_TRACER_COLOR)).toBe(false);
    expect(isGreenBoltColor(PELLET_TRACER_COLOR)).toBe(false);
    for (let c = 208; c <= 214; c++) expect(isGreenBoltColor(c)).toBe(true);
  });

  it('soldier weapon is skin-determined (never random)', () => {
    expect(soldierWeaponForSkin(0)).toBe('blaster');
    expect(soldierWeaponForSkin(2)).toBe('shotgun');
    expect(soldierWeaponForSkin(4)).toBe('machinegun');
  });

  it('shotgun-skin return fire queues yellow tracers only, never bolts', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    SV_SpawnMonster(driver.server, 'monster_soldier', v3(32, 100, 24));
    let sawTracer = false;
    for (let i = 0; i < 120 && !sawTracer; i++) {
      driver.step(neutralCmd(), 0.1);
      const got = driver.drainTracers();
      for (const t of got) {
        // Shotgun AND machinegun tracer call sites pin here: every queued
        // beam must avoid the 208–214 green band.
        expect(t.color).toBe(HITSCAN_TRACER_COLOR);
        expect(isGreenBoltColor(t.color)).toBe(false);
        sawTracer = true;
      }
    }
    expect(driver.events).toContain('monshot');
    expect(sawTracer).toBe(true);
    // Shotgun skins never spawn projectile bolts (id soldier_fire).
    expect(driver.bolts.length).toBe(0);
  });

  it('light-skin soldiers fire foe blaster bolts, never hitscan tracers', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    SV_SpawnMonster(driver.server, 'monster_soldier_light', v3(32, 100, 24));
    let sawBolt = false;
    for (let i = 0; i < 120 && !sawBolt; i++) {
      driver.step(neutralCmd(), 0.1);
      expect(driver.drainTracers()).toEqual([]);
      if (driver.bolts.length > 0) sawBolt = true;
    }
    expect(driver.events).toContain('monshot');
    expect(sawBolt).toBe(true);
  });

  it('enemy hitscan is a short muzzle streak, never a beam ending at the eye', () => {
    // Face-flame fix (M7.1): C draws NO beam for monster hitscan (only the
    // railgun draws TE_RAILTRAIL) — the old full muzzle→eye beam filled the
    // screen at close range. Every enemy hitscan round is now a short
    // muzzle-origin streak (ENEMY_TRACER_LENGTH, same 225 yellow) whose
    // endpoint stays far from the eye, plus the small muzzle dlight.
    for (const skin of [2, 4]) {
      const boot = bootPlay({ width: 64, height: 48 });
      const { driver } = boot;
      SV_SpawnMonster(driver.server, skin <= 1 ? 'monster_soldier_light' : skin <= 3 ? 'monster_soldier' : 'monster_soldier_ss', v3(32, 100, 24));
      let beams = 0;
      for (let i = 0; i < 200 && beams === 0; i++) {
        driver.step(neutralCmd(), 0.1);
        const got = driver.drainTracers();
        if (got.length === 0) continue;
        const eye = v3(driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + 22);
        const eyeDist0 = Math.hypot(eye[0]! - got[0]!.origin[0]!, eye[1]! - got[0]!.origin[1]!, eye[2]! - got[0]!.origin[2]!);
        // Engagement is mid-range: a full muzzle→eye beam would reach the eye.
        expect(eyeDist0).toBeGreaterThan(100);
        for (const t of got) {
          beams++;
          expect(t.color).toBe(HITSCAN_TRACER_COLOR);
          expect(isGreenBoltColor(t.color)).toBe(false);
          // Short muzzle streak, never a beam to the eye.
          expect(t.length).toBe(ENEMY_TRACER_LENGTH);
          expect(t.length).toBeLessThanOrEqual(64);
          const dl = Math.hypot(t.dir[0]!, t.dir[1]!, t.dir[2]!) || 1;
          const end = v3(
            t.origin[0]! + (t.dir[0]! / dl) * t.length,
            t.origin[1]! + (t.dir[1]! / dl) * t.length,
            t.origin[2]! + (t.dir[2]! / dl) * t.length,
          );
          const endDist = Math.hypot(end[0]! - eye[0]!, end[1]! - eye[1]!, end[2]! - eye[2]!);
          // The closing monster drifts while aiming, so pin the invariant
          // relatively: the endpoint stays well clear of the eye and the
          // beam shortened the muzzle→eye gap by ~its own length (a full
          // muzzle→eye beam would end AT the eye, gap ≈ 0).
          expect(endDist).toBeGreaterThan(30);
          expect(eyeDist0 - endDist).toBeGreaterThan(20);
          expect(eyeDist0 - endDist).toBeLessThan(60);
        }
      }
      expect(driver.events).toContain('monshot');
      expect(beams).toBeGreaterThan(0);
    }
    // Gunner chain fire obeys the same cap.
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    SV_SpawnMonster(driver.server, 'monster_gunner', v3(32, 100, 24));
    let gbeams = 0;
    for (let i = 0; i < 200 && gbeams === 0; i++) {
      driver.step(neutralCmd(), 0.1);
      const got = driver.drainTracers();
      for (const t of got) {
        gbeams++;
        expect(t.color).toBe(HITSCAN_TRACER_COLOR);
        expect(t.length).toBe(ENEMY_TRACER_LENGTH);
      }
    }
    expect(driver.events).toContain('monshot');
    expect(gbeams).toBeGreaterThan(0);
  });

  it('machinegun-skin soldiers burst yellow tracers with the ss attack sound', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    SV_SpawnMonster(driver.server, 'monster_soldier_ss', v3(32, 100, 24));
    let sawBurst = false;
    for (let i = 0; i < 200 && !sawBurst; i++) {
      driver.step(neutralCmd(), 0.1);
      const got = driver.drainTracers();
      if (got.length >= 3) {
        // One fire event = a 3-round fan (id HOLD_FRAME burst): all yellow.
        for (const t of got) {
          expect(t.color).toBe(HITSCAN_TRACER_COLOR);
          expect(isGreenBoltColor(t.color)).toBe(false);
        }
        sawBurst = true;
      } else {
        expect(got.every((t) => !isGreenBoltColor(t.color))).toBe(true);
      }
    }
    expect(driver.events).toContain('monshot');
    expect(sawBurst).toBe(true);
    // The ss attack sound (verified present in pak0.pak) fires with the burst.
    const names = driver.mixer.mix().map((c) => c.name);
    expect(names).toContain('soldier/solatck3.wav');
    expect(driver.soldierSkinFor(4)).toBe(0); // no pak: Host default
  });
});

const WEB_Q2_PAK = process.env.Q2_PAK;

describe.runIf(!!WEB_Q2_PAK)('per-skin soldier rendering (real pak, Q2_PAK)', () => {
  async function bootPak(width = 160, height = 120) {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    return bootPlay({ width, height, pak: ingestPak(buf) });
  }

  it('light/plain/ss resolve to three distinct skins on the one soldier mesh', { timeout: 180000 }, async () => {
    const boot = await bootPak();
    const { driver } = boot;
    const models = boot.models!;
    expect(models.soldierLightSkin).toBeGreaterThanOrEqual(0);
    expect(models.soldierSsSkin).toBeGreaterThanOrEqual(0);
    expect(new Set([models.monsterSkin, models.soldierLightSkin, models.soldierSsSkin]).size).toBe(3);
    // Registration order contract intact: soldier skin 0 + mesh 0.
    expect(models.monster).toBe(0);
    expect(models.skins[0]).toBe(0);
    // base1 ships 6 lights + 8 plains, and the raised cap keeps all 14.
    expect(driver.monsters.filter((m) => m.edict.extra['skinnum'] === '0').length).toBe(6);
    expect(driver.monsters.filter((m) => m.edict.extra['skinnum'] === '2').length).toBe(8);
    const light = driver.monsters.find((m) => m.edict.extra['skinnum'] === '0')!;
    const plain = driver.monsters.find((m) => m.edict.extra['skinnum'] === '2')!;
    expect(driver.entityModel(light.edict.num)).toEqual({ model: models.monster, skin: models.soldierLightSkin });
    expect(driver.entityModel(plain.edict.num)).toEqual({ model: models.monster, skin: models.monsterSkin });
    // Synthetic ss (no base1 ss): distinct machinegun skin, same mesh.
    const ss = SV_SpawnMonster(driver.server, 'monster_soldier_ss', v3(0, 0, 32));
    expect(driver.entityModel(ss.edict.num)).toEqual({ model: models.monster, skin: models.soldierSsSkin });
    // Odd pain skins fall back to their even base.
    expect(driver.soldierSkinFor(1)).toBe(models.soldierLightSkin);
    expect(driver.soldierSkinFor(5)).toBe(models.soldierSsSkin);
    expect(driver.soldierSkinFor(3)).toBe(models.monsterSkin);
  });

  it('monsters render with their per-skin handles (light ≠ shotgun)', { timeout: 180000 }, async () => {
    const boot = await bootPak();
    const { driver, host } = boot;
    const light = driver.monsters.find((m) => m.edict.extra['skinnum'] === '0')!;
    const plain = driver.monsters.find((m) => m.edict.extra['skinnum'] === '2')!;
    expect(light).toBeDefined();
    expect(plain).toBeDefined();
    // Exercise the snapshot→Host path (frames + origins flow as before).
    const snap = driver.snapshot(driver.server.time);
    expect(snap.entities.some((e) => e.id === light.edict.num)).toBe(true);
    expect(snap.entities.some((e) => e.id === plain.edict.num)).toBe(true);
    const stats = host.frame(100);
    expect(stats.pixels).toBeGreaterThan(0);
  });
});
