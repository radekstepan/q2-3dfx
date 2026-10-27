// Phase 3 feedback correctness (BRAIN.md §15): view-side pins for enemy
// muzzle flashes, player muzzle dlight, and the single duck state. All
// devroom (pak-free); the point-blank accumulation bot has a Q2_PAK variant
// further down. The Phase 0 server already emits muzzles at the C m_flash
// offsets with short (48u) muzzle streaks — these tests pin the view
// contract (driver drain → pump → renderer) and the duck chain
// (input bit → pmove → hull → host eye).
import { describe, expect, it, vi } from 'vitest';
import { BUTTON_ATTACK, BUTTON_DUCK, keyDown, keyUp } from '@q2/input';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import {
  isGreenBoltColor,
  HITSCAN_TRACER_COLOR,
  makePmoveState,
  pmoveFull,
  setPmoveWorld,
  PMF_DUCKED,
} from '@q2/game';
import type { TraceResult } from '@q2/game';
import { SV_SetPlayerHealth, SV_SpawnMonster } from '@q2/server';
import {
  bootPlay,
  pumpMuzzleLight,
  pumpExplosionLights,
  pumpTracers,
  ENEMY_TRACER_LENGTH,
} from './play.js';

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

function stepDriver(driver: { step(cmd: UserCmdT, dt: number): void }, cmd: UserCmdT, n: number): void {
  for (let i = 0; i < n; i++) driver.step(cmd, 0.1);
}

/** Player eye from the authoritative driver hull (standing in these tests). */
function playerEye(driver: { pm: { origin: ArrayLike<number>; viewheight: number } }): [number, number, number] {
  return [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + driver.pm.viewheight];
}

/** 2 metres in Quake units (1 unit ≈ 1 inch): the no-eye-ending radius. */
const TWO_METERS = 78.7;

describe('Phase 3: enemy muzzle flash renders at the m_flash offset only', () => {
  for (const cls of ['monster_soldier', 'monster_soldier_ss'] as const) {
    it(`${cls}: hitscan streaks are short, muzzle-origin, never eye-ending`, () => {
      const boot = bootPlay({ width: 64, height: 48 });
      const { driver } = boot;
      // Godmode geometry stability: return fire must not move/respawn us.
      SV_SetPlayerHealth(driver.server, 10000);
      driver.ps.health = 10000;
      const m = SV_SpawnMonster(driver.server, cls, v3(32, 100, 24));
      // C-correct engagement cadence (g_ai.c HuntTarget 1s hold +
      // M_CheckAttack NEAR 0.1/frame against a ~122u/s close): the monster
      // closes from its 200u spawn to NEAR/melee before the first volley —
      // the old ">100u away" pin described the pre-depth instant opener.
      const d0 = Math.hypot(
        32 - driver.pm.origin[0]!,
        100 - driver.pm.origin[1]!,
        24 - driver.pm.origin[2]!,
      );
      expect(d0).toBeGreaterThan(200);
      let tracers = 0;
      let flashes = 0;
      for (let i = 0; i < 150; i++) {
        driver.step(neutralCmd(), 0.1);
        const gotFlashes = driver.drainEnemyMuzzle();
        const got = driver.drainTracers();
        flashes += gotFlashes.length;
        if (got.length === 0) continue;
        // Every streak must pair with a same-tick muzzle flash at the same
        // point: the streak originates AT the muzzle, never chest→eye.
        expect(gotFlashes.length).toBeGreaterThan(0);
        const eye = playerEye(driver);
        const shooter = m.edict.origin;
        // Closes-then-engages: the first volley fires well inside the
        // spawn range, never from afar.
        const dFire = Math.hypot(
          shooter[0]! - driver.pm.origin[0]!,
          shooter[1]! - driver.pm.origin[1]!,
          shooter[2]! - driver.pm.origin[2]!,
        );
        expect(dFire).toBeLessThan(d0 - 50);
        for (const t of got) {
          tracers++;
          expect(t.color).toBe(HITSCAN_TRACER_COLOR);
          expect(isGreenBoltColor(t.color)).toBe(false);
          // Short muzzle streak, never a beam.
          expect(t.length).toBe(ENEMY_TRACER_LENGTH);
          expect(t.length).toBeLessThanOrEqual(48);
          // Origin is the muzzle flash point (m_flash offset, small: near
          // the shooter, near the eye only because the body closed first).
          const paired = gotFlashes.some(
            (f) =>
              Math.hypot(f.pos[0]! - t.origin[0]!, f.pos[1]! - t.origin[1]!, f.pos[2]! - t.origin[2]!) < 0.001,
          );
          expect(paired).toBe(true);
          const muzzleToShooter = Math.hypot(
            t.origin[0]! - shooter[0]!, t.origin[1]! - shooter[1]!, t.origin[2]! - shooter[2]!,
          );
          expect(muzzleToShooter).toBeLessThan(64);
          const gap0 = Math.hypot(
            t.origin[0]! - eye[0]!, t.origin[1]! - eye[1]!, t.origin[2]! - eye[2]!,
          );
          // The muzzle closed with the body (the old pin demanded the
          // pre-depth opener geometry here).
          expect(gap0).toBeLessThan(100);
          // Endpoint: the streak never overshoots toward the eye, and at
          // sane engagement ranges it stays a full 2m clear of the eye.
          const dl = Math.hypot(t.dir[0]!, t.dir[1]!, t.dir[2]!) || 1;
          const end: [number, number, number] = [
            t.origin[0]! + (t.dir[0]! / dl) * t.length,
            t.origin[1]! + (t.dir[1]! / dl) * t.length,
            t.origin[2]! + (t.dir[2]! / dl) * t.length,
          ];
          const endDist = Math.hypot(end[0] - eye[0], end[1] - eye[1], end[2] - eye[2]);
          expect(endDist).toBeGreaterThanOrEqual(gap0 - t.length - 0.5);
          if (gap0 > 130) expect(endDist).toBeGreaterThan(TWO_METERS);
        }
      }
      expect(driver.events).toContain('monshot');
      expect(tracers).toBeGreaterThan(0);
      expect(flashes).toBeGreaterThan(0);
    });
  }

  it('enemy muzzle dlight is small, yellow, one-shot (pumped, never accumulated)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    SV_SetPlayerHealth(driver.server, 10000);
    driver.ps.health = 10000;
    SV_SpawnMonster(driver.server, 'monster_soldier', v3(32, 100, 24));
    const origAdd = boot.refresh.testAddDynamicLight.bind(boot.refresh);
    const adds: Array<{ intensity: number; color: number[] }> = [];
    (boot.refresh as unknown as { testAddDynamicLight: (l: never) => void }).testAddDynamicLight = ((l: {
      origin: Float32Array;
      intensity: number;
      color: ArrayLike<number>;
    }): void => {
      adds.push({ intensity: l.intensity, color: Array.from(l.color) });
      origAdd(l as never);
    }) as never;
    // Step until the server emits an enemy flash, pumping in the same tick
    // (dom order: pump right after step): exactly the yellow adds for that
    // tick's shots, then quiet on the next pump with no new shot.
    let pumped = false;
    for (let i = 0; i < 200 && !pumped; i++) {
      driver.step(neutralCmd(), 0.1);
      pumped = pumpMuzzleLight(boot);
    }
    expect(pumped).toBe(true);
    expect(driver.events).toContain('monshot');
    expect(adds.length).toBeGreaterThanOrEqual(1);
    for (const a of adds) {
      expect(a.color).toEqual([1, 1, 0]);
      expect(a.intensity).toBeGreaterThanOrEqual(200);
      expect(a.intensity).toBeLessThanOrEqual(231);
    }
    // No new shot → next pump is quiet (one-shot, no accumulation).
    const n = adds.length;
    expect(pumpMuzzleLight(boot)).toBe(false);
    expect(adds.length).toBe(n);
  });

  it('pumped renderer beams are short muzzle streaks (spawnTracer lengths ≤ 48)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    SV_SetPlayerHealth(driver.server, 10000);
    driver.ps.health = 10000;
    SV_SpawnMonster(driver.server, 'monster_soldier', v3(32, 100, 24));
    const lengths: number[] = [];
    vi.spyOn(boot.refresh, 'spawnTracer').mockImplementation(
      (
        _origin: ArrayLike<number>,
        _dir: ArrayLike<number>,
        _color?: number,
        length?: number,
      ): boolean => {
        lengths.push(length ?? 0);
        return true;
      },
    );
    for (let i = 0; i < 200 && lengths.length === 0; i++) {
      driver.step(neutralCmd(), 0.1);
      pumpTracers(boot);
    }
    expect(driver.events).toContain('monshot');
    expect(lengths.length).toBeGreaterThan(0);
    for (const l of lengths) expect(l).toBeLessThanOrEqual(48);
  });

  it('player hitscan fires no beam (shotgun pellets: impact sparks only)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    driver.ps.weapons.push('weapon_shotgun');
    driver.ps.ammo['shells'] = 8;
    driver.shells = 8; // compat counter handleAttack reads (syncAmmo mirrors it)
    driver.selectWeapon('weapon_shotgun');
    driver.pm.viewAngles = v3(0, 0, 0);
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.events).toContain('shot');
    // Hitscan resolve: no tracer queued, none pumped (only the railgun
    // draws TE_RAILTRAIL — not in v1).
    expect(driver.pendingTracers).toBe(0);
    expect(pumpTracers(boot)).toBe(0);
    expect(driver.drainTracers()).toEqual([]);
  });
});

describe('Phase 3: player muzzle flash audit (CL_MuzzleFlash ground truth)', () => {
  it('pos = feet+fwd*18+right*16, radius 200+(rand&31), pure yellow, single-frame, re-arms', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    driver.pm.origin = v3(-168, 0, 24);
    driver.pm.velocity = v3();
    driver.pm.viewAngles = v3(0, 0, 0);
    const seen: Array<{ origin: Float32Array; intensity: number; color: Float32Array }> = [];
    const origAdd = boot.refresh.testAddDynamicLight.bind(boot.refresh);
    boot.refresh.testAddDynamicLight = (l): void => {
      seen.push(l);
      origAdd(l);
    };
    const countHook = (boot.refresh as unknown as { testDynamicLightCount?: () => number })
      .testDynamicLightCount;
    // Fire once facing +X: fwd=(1,0,0), right=(0,-1,0).
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.events).toContain('shot');
    expect(driver.muzzleLit()).toBe(true);
    expect(pumpMuzzleLight(boot)).toBe(true);
    expect(seen.length).toBe(1);
    // Feet (-168,0,24) + fwd*18 + right*16 = (-150,-16,24).
    expect(seen[0]!.origin[0]).toBeCloseTo(-150, 6);
    expect(seen[0]!.origin[1]).toBeCloseTo(-16, 6);
    expect(seen[0]!.origin[2]).toBeCloseTo(24, 6);
    expect(seen[0]!.intensity).toBeGreaterThanOrEqual(200);
    expect(seen[0]!.intensity).toBeLessThanOrEqual(231);
    expect(Array.from(seen[0]!.color)).toEqual([1, 1, 0]);
    // Single-frame expiry: the very next pump (no new shot) adds nothing,
    // and the live count returns to baseline — no accumulation.
    expect(pumpMuzzleLight(boot)).toBe(false);
    expect(seen.length).toBe(1);
    stepDriver(driver, neutralCmd(), 5);
    expect(driver.muzzleLit()).toBe(false);
    expect(pumpMuzzleLight(boot)).toBe(false);
    expect(seen.length).toBe(1);
    if (typeof countHook === 'function') expect(countHook.call(boot.refresh)).toBe(0);
    // Re-arms: a second shot pumps exactly one more dlight.
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    expect(pumpMuzzleLight(boot)).toBe(true);
    expect(seen.length).toBe(2);
  });
});

describe('Phase 3: single duck state (input → pmove → hull → host eye)', () => {
  it('hold crouch 60 ticks: hull maxs 4 / viewheight -2 / eye feet+22 every tick', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { host, driver } = boot;
    // Settle onto the devroom floor first (ground categorized, steady z).
    for (let t = 0; t <= 500; t += 16) host.frame(t);
    expect(driver.pm.origin[2]).toBeCloseTo(24, 0);
    const eyes: number[] = [];
    const orig = boot.refresh.renderView.bind(boot.refresh);
    vi.spyOn(boot.refresh, 'renderView').mockImplementation((view, world, entities) => {
      eyes.push(view.origin[2]!);
      return orig(view, world, entities);
    });
    keyDown(host.input, 'crouch');
    let t = 516;
    for (let i = 0; i < 60; i++, t += 16) {
      host.frame(t);
      // Hull: one transition on press, then steady — no per-tick flip-flop.
      expect(driver.pm.pmFlags & PMF_DUCKED).toBe(PMF_DUCKED);
      expect(driver.pm.maxs[2]).toBe(4);
      expect(driver.pm.mins[2]).toBe(-24);
      expect(driver.pm.viewheight).toBe(-2);
    }
    expect(eyes.length).toBe(60);
    for (const z of eyes) {
      // Eye rides the authoritative hull: feet z=24 - 2 every frame.
      // (Standing eye would read 46 — cleanly separated.)
      expect(z).toBeCloseTo(22, 0);
    }
    // Release: stands on the next ticks (open room ⇒ headroom free).
    keyUp(host.input, 'crouch');
    for (let i = 0; i < 10; i++, t += 16) host.frame(t);
    expect(driver.pm.pmFlags & PMF_DUCKED).toBe(0);
    expect(driver.pm.maxs[2]).toBe(32);
    expect(driver.pm.viewheight).toBe(22);
    const lastEye = eyes[eyes.length - 1]!;
    expect(lastEye).toBeCloseTo(46, 0);
  });

  it('release stands only with headroom (PM_CheckDuck keeps duck under a ceiling)', () => {
    // Pinned at the pmove contract level (read-only @q2/game import — the
    // driver/host own the wiring, pmove itself is untouched by this lane).
    const standing = (): TraceResult => ({
      fraction: 1,
      endpos: v3(),
      planeNormal: v3(0, 0, 1),
      allsolid: false,
      startsolid: false,
      entityNum: -1,
      contents: 0,
    });
    const ceiling: TraceResult = {
      fraction: 0,
      endpos: v3(),
      planeNormal: v3(0, 0, -1),
      allsolid: true,
      startsolid: true,
      entityNum: 0,
      contents: 0,
    };
    // Ducked under a low ceiling, hold released: stays ducked.
    setPmoveWorld(() => ceiling);
    const st = makePmoveState();
    st.pmFlags |= PMF_DUCKED;
    st.maxs = v3(16, 16, 4);
    st.viewheight = -2;
    pmoveFull(st, {
      msec: 100,
      angles: v3(),
      forwardmove: 0,
      sidemove: 0,
      upmove: 0,
      buttons: 0,
    });
    expect(st.pmFlags & PMF_DUCKED).toBe(PMF_DUCKED);
    expect(st.maxs[2]).toBe(4);
    expect(st.viewheight).toBe(-2);
    // Same release with headroom: stands.
    setPmoveWorld(() => standing());
    pmoveFull(st, {
      msec: 100,
      angles: v3(),
      forwardmove: 0,
      sidemove: 0,
      upmove: 0,
      buttons: 0,
    });
    expect(st.pmFlags & PMF_DUCKED).toBe(0);
    expect(st.maxs[2]).toBe(32);
    expect(st.viewheight).toBe(22);
    // Restore the world trace for later tests (fresh boot reinstalls it).
    bootPlay({ width: 8, height: 8 });
  });
});

describe('Phase 3: point-blank accumulation bot (dlight count bounded, expiry frame to frame)', () => {
  it('devroom: 100+ shots at the pillar wall — no screen-filling accumulation', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    const countOf = (): number =>
      (
        boot.refresh as unknown as { testDynamicLightCount?: () => number }
      ).testDynamicLightCount?.call(boot.refresh) ?? 0;
    // Nose against the pillar wall, level bead: every bolt impacts.
    driver.pm.origin = v3(-80, 0, 24);
    driver.pm.velocity = v3();
    driver.pm.viewAngles = v3(0, 0, 0);
    let shots = 0;
    for (let i = 0; i < 360; i++) {
      const before = driver.events.filter((e) => e === 'shot').length;
      driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
      shots += driver.events.filter((e) => e === 'shot').length - before;
      // dom-tick pump order: muzzle + explosion every frame.
      pumpMuzzleLight(boot);
      pumpExplosionLights(boot);
      // Bounded: at most the fresh muzzle + a couple of brief impact
      // flashes — never a growing stack.
      expect(countOf()).toBeLessThanOrEqual(4);
    }
    expect(shots).toBeGreaterThanOrEqual(100);
    // Release + settle: everything expires, pumps go quiet, count is zero.
    stepDriver(driver, neutralCmd(), 30);
    expect(driver.muzzleLit()).toBe(false);
    expect(pumpMuzzleLight(boot)).toBe(false);
    expect(pumpExplosionLights(boot)).toBe(0);
    expect(countOf()).toBe(0);
  });
});

const WEB_Q2_PAK = process.env.Q2_PAK;

describe.runIf(!!WEB_Q2_PAK)('Phase 3 (Q2_PAK): base1 wall bot — 100× point-blank, no flash accumulation', () => {
  it('fires at the spawn wall 100×: dlight count bounded, expiry frame to frame', { timeout: 180000 }, async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const pak = ingestPak(buf);
    const boot = bootPlay({ width: 96, height: 72, pak });
    const { driver } = boot;
    const countOf = (): number =>
      (
        boot.refresh as unknown as { testDynamicLightCount?: () => number }
      ).testDynamicLightCount?.call(boot.refresh) ?? 0;
    // Spawn faces a wall ~48u out: settle, then hold fire into it.
    stepDriver(driver, neutralCmd(), 10);
    const yaw = driver.pm.viewAngles[1]!;
    let shots = 0;
    for (let i = 0; i < 400 && shots < 100; i++) {
      const before = driver.events.filter((e) => e === 'shot').length;
      driver.step({ ...neutralCmd([0, yaw, 0]), buttons: BUTTON_ATTACK }, 0.1);
      shots += driver.events.filter((e) => e === 'shot').length - before;
      pumpMuzzleLight(boot);
      pumpExplosionLights(boot);
      expect(countOf()).toBeLessThanOrEqual(4);
    }
    expect(shots).toBeGreaterThanOrEqual(100);
    stepDriver(driver, neutralCmd(), 30);
    expect(driver.muzzleLit()).toBe(false);
    expect(pumpMuzzleLight(boot)).toBe(false);
    expect(pumpExplosionLights(boot)).toBe(0);
    expect(countOf()).toBe(0);
  });
});
