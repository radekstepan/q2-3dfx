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
    // C-correct engagement cadence (g_ai.c): HuntTarget holds the first
    // attack for 1s (AttackFinished(self, 1)) while the soldier closes at
    // ~122u/s (m_soldier.c run dists), and M_CheckAttack's NEAR 0.1/frame
    // rarely commits in the ~2-frame window before melee — so the opener
    // lands at MELEE range (<80), where C fires the skin gun point-blank
    // (soldier melee is NULL: the MELEE branch sets AS_MISSILE, g_ai.c).
    // At that range the foe bolt crosses the ~50u muzzle→eye gap within its
    // 60u first step (G_RunFrame moves spawned edicts the same frame,
    // g_main.c), so the volley reads as muzzle + blaster sound + impact —
    // a live cross-tick bolt only exists for longer-range volleys.
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    const m = SV_SpawnMonster(driver.server, 'monster_soldier_light', v3(32, 100, 24));
    const d0 = Math.hypot(
      32 - driver.pm.origin[0]!,
      100 - driver.pm.origin[1]!,
      24 - driver.pm.origin[2]!,
    );
    expect(d0).toBeGreaterThan(200); // C RANGE_NEAR spawn, like the old pin
    const hp0 = driver.playerHealth;
    let sawBolt = false;
    let sawMuzzle = false;
    let dFire: number | null = null;
    for (let i = 0; i < 120; i++) {
      driver.step(neutralCmd(), 0.1);
      // Never hitscan: every queued beam must avoid the 208–214 green band
      // — here, no beam is ever queued at all.
      expect(driver.drainTracers()).toEqual([]);
      if (driver.drainEnemyMuzzle().length > 0) sawMuzzle = true;
      if (driver.bolts.length > 0) sawBolt = true;
      if (dFire === null && driver.events.includes('monshot')) {
        dFire = Math.hypot(
          m.edict.origin[0]! - driver.pm.origin[0]!,
          m.edict.origin[1]! - driver.pm.origin[1]!,
          m.edict.origin[2]! - driver.pm.origin[2]!,
        );
      }
    }
    expect(driver.events).toContain('monshot');
    // Closes-then-engages: the first volley fires from MELEE range, not
    // from the 200u spawn.
    expect(dFire).not.toBeNull();
    expect(dFire!).toBeLessThan(80);
    expect(dFire!).toBeLessThan(d0 - 50);
    // The volley is blaster gunfire: muzzle flash + the blaster sound
    // (solatck2 — shotgun would be solatck1, machinegun solatck3), and the
    // foe bolt either flies (live this tick) or already impacted (bolt
    // explosion + player damage on the fire tick).
    expect(sawMuzzle).toBe(true);
    const names = driver.mixer.mix().map((c) => c.name);
    expect(names).toContain('soldier/solatck2.wav');
    expect(names).not.toContain('soldier/solatck1.wav');
    expect(names).not.toContain('soldier/solatck3.wav');
    const impacted = driver.events.includes('explosion') && driver.playerHealth < hp0;
    expect(sawBolt || impacted).toBe(true);
  });

  it('enemy hitscan is a short muzzle streak, never a beam ending at the eye', () => {
    // Face-flame fix (M7.1): C draws NO beam for monster hitscan (only the
    // railgun draws TE_RAILTRAIL) — the old full muzzle→eye beam filled the
    // screen at close range. Every enemy hitscan round is now a short
    // muzzle-origin streak (ENEMY_TRACER_LENGTH, same 225 yellow) whose
    // endpoint stays well clear of the eye, plus the small muzzle dlight.
    //
    // Engagement timing is the C cadence (g_ai.c HuntTarget 1s hold +
    // M_CheckAttack NEAR 0.1/frame against a ~122u/s close): the monster
    // closes from its 200u spawn to NEAR/melee before the first volley, so
    // the streak starts near the eye — the old ">100u away" pin described
    // the pre-depth flat-0.7 instant opener, not C. What stays invariant:
    // the streak is SHORT (its length, not the muzzle→eye gap) and stops
    // short of the eye by exactly its un-flown remainder.
    for (const skin of [2, 4]) {
      const boot = bootPlay({ width: 64, height: 48 });
      const { driver } = boot;
      const m = SV_SpawnMonster(driver.server, skin <= 1 ? 'monster_soldier_light' : skin <= 3 ? 'monster_soldier' : 'monster_soldier_ss', v3(32, 100, 24));
      const d0 = Math.hypot(
        32 - driver.pm.origin[0]!,
        100 - driver.pm.origin[1]!,
        24 - driver.pm.origin[2]!,
      );
      expect(d0).toBeGreaterThan(200);
      let beams = 0;
      for (let i = 0; i < 200 && beams === 0; i++) {
        driver.step(neutralCmd(), 0.1);
        const got = driver.drainTracers();
        if (got.length === 0) continue;
        const dFire = Math.hypot(
          m.edict.origin[0]! - driver.pm.origin[0]!,
          m.edict.origin[1]! - driver.pm.origin[1]!,
          m.edict.origin[2]! - driver.pm.origin[2]!,
        );
        // Closes-then-engages: the first volley fires well inside the
        // spawn range (C reaction + chance cadence), never from afar.
        expect(dFire).toBeLessThan(d0 - 50);
        const eye = v3(driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + 22);
        const eyeDist0 = Math.hypot(eye[0]! - got[0]!.origin[0]!, eye[1]! - got[0]!.origin[1]!, eye[2]! - got[0]!.origin[2]!);
        // The muzzle closed with the body: the gap is now short (the old
        // pin demanded >100u — the pre-depth opener geometry).
        expect(eyeDist0).toBeLessThan(100);
        for (const t of got) {
          beams++;
          expect(t.color).toBe(HITSCAN_TRACER_COLOR);
          expect(isGreenBoltColor(t.color)).toBe(false);
          // Short muzzle streak, never a beam to the eye: the streak is
          // far shorter than the muzzle→eye gap (a full beam would span
          // the whole gap and end AT the eye).
          expect(t.length).toBe(ENEMY_TRACER_LENGTH);
          expect(t.length).toBeLessThanOrEqual(64);
          expect(t.length).toBeLessThan(eyeDist0);
          const dl = Math.hypot(t.dir[0]!, t.dir[1]!, t.dir[2]!) || 1;
          const end = v3(
            t.origin[0]! + (t.dir[0]! / dl) * t.length,
            t.origin[1]! + (t.dir[1]! / dl) * t.length,
            t.origin[2]! + (t.dir[2]! / dl) * t.length,
          );
          const endDist = Math.hypot(end[0]! - eye[0]!, end[1]! - eye[1]!, end[2]! - eye[2]!);
          // The streak flies at the eye and stops short by exactly its
          // un-flown remainder — never overshooting onto the eye. (The
          // ss machinegun fires a 3-round ±40 fan, so the exact pin only
          // holds for the aimed shotgun round; the fan rounds still
          // shorten the gap substantially and stop well clear.)
          if (skin === 2) expect(endDist).toBeCloseTo(eyeDist0 - t.length, 0);
          else expect(endDist).toBeLessThan(eyeDist0);
          expect(endDist).toBeGreaterThan(10);
          // The aimed round shortens the gap by about its own streak (a
          // full muzzle→eye beam would end AT the eye, gap ≈ 0); fan
          // rounds shorten it strictly but less.
          if (skin === 2) {
            expect(eyeDist0 - endDist).toBeGreaterThan(20);
            expect(eyeDist0 - endDist).toBeLessThan(60);
          }
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
    // Awake bodies only: the dormant t55 pair is SVF_NOCLIENT until the
    // shotgun pickup wakes it (not in the snapshot before then).
    const awake = driver.monsters.filter((m) => !(m.triggered && !m.woken));
    const light = awake.find((m) => m.edict.extra['skinnum'] === '0')!;
    const plain = awake.find((m) => m.edict.extra['skinnum'] === '2')!;
    expect(light).toBeDefined();
    expect(plain).toBeDefined();
    // Exercise the snapshot→Host path (frames + origins flow as before).
    const snap = driver.snapshot(driver.server.time);
    expect(snap.entities.some((e) => e.id === light.edict.num)).toBe(true);
    expect(snap.entities.some((e) => e.id === plain.edict.num)).toBe(true);
    const stats = host.frame(100);
    expect(stats.pixels).toBeGreaterThan(0);
  });

  it('infantry renders on the infantry mesh, not the soldier mesh', { timeout: 180000 }, async () => {
    const boot = await bootPak();
    const { driver } = boot;
    const models = boot.models!;
    // Skill 1 spawns 3 base1 infantries; all render their own MD2 + skin.
    const infantries = driver.monsters.filter((m) => m.state.kind === 'infantry');
    expect(infantries.length).toBeGreaterThan(0);
    expect(models.infantry).toBeGreaterThanOrEqual(0);
    expect(models.infantry).not.toBe(models.monster);
    for (const inf of infantries) {
      expect(driver.entityModel(inf.edict.num)).toEqual({ model: models.infantry, skin: models.infantrySkin });
      // Infantry frame numbers play on the infantry mesh (the old fallback
      // read them as soldier frames — wrong poses on the wrong skeleton).
      expect(driver.entityFrame(inf.edict.num)).toBeGreaterThanOrEqual(0);
    }
    // Soldier contract intact: mesh handle 0, per-skin skins.
    const plain = driver.monsters.find((m) => m.edict.extra['skinnum'] === '2')!;
    expect(driver.entityModel(plain.edict.num)).toEqual({ model: models.monster, skin: models.monsterSkin });
  });
});

describe('dormant monsters stay out of the snapshot (SVF_NOCLIENT)', () => {
  it('triggered-unwoken bodies are not submitted; waking re-submits them', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    const m = SV_SpawnMonster(driver.server, 'monster_soldier', v3(32, 100, 24));
    m.triggered = true;
    m.woken = false;
    m.seen = false;
    let snap = driver.snapshot(driver.server.time);
    expect(snap.entities.some((e) => e.id === m.edict.num)).toBe(false);
    expect(driver.entityFrame(m.edict.num)).toBeGreaterThanOrEqual(0); // frame math still safe
    driver.server.monsters.find((x) => x.edict.num === m.edict.num)!.woken = true;
    snap = driver.snapshot(driver.server.time);
    expect(snap.entities.some((e) => e.id === m.edict.num)).toBe(true);
  });
});
