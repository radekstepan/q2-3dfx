import { describe, expect, it, vi } from 'vitest';
import { keyDown, keyUp, BUTTON_ATTACK } from '@q2/input';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import type { Entity } from '@q2/renderer-api';
import { getConcharsFont, makeConcharsFont } from '@q2/client';
import { bootPlay, drawPlayHud, pumpMuzzleLight, pumpBoltLights, pumpExplosionLights, pumpTracers, loadConcharsFont, concharsFontFromPCX, VIEWMODEL_FIRE_FRAME, usesViewModel3D } from './play.js';
import { findWeapon, monsterPain, BOLT_LIFE } from '@q2/game';
import { SV_SpawnMonster, SV_AddBarrel } from '@q2/server';
import type { LocalDriver } from './play.js';

function runFrames(host: { frame(nowMs: number): unknown }, fromMs: number, toMs: number, step = 16): void {
  for (let t = fromMs; t <= toMs; t += step) host.frame(t);
}

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

function stepDriver(driver: LocalDriver, cmd: UserCmdT, n: number): void {
  for (let i = 0; i < n; i++) driver.step(cmd, 0.1);
}

describe('play driver (devroom, headless)', () => {
  it('spawns on the devroom floor and settles', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    expect(boot.source).toBe('devroom');
    const { host } = boot;
    expect(host.playerOrigin).toEqual([-168, 0, 32]);
    runFrames(host, 0, 1000);
    // Feet on the floor: origin z == 24 (hull mins -24).
    expect(host.playerOrigin[2]).toBeCloseTo(24, 0);
  });

  it('walks forward and is stopped by the pillar', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { host } = boot;
    keyDown(host.input, 'forward');
    runFrames(host, 0, 3000);
    keyUp(host.input, 'forward');
    // Facing +X from x=-168: moved, but the pillar (expanded to x=-64) blocks.
    expect(host.playerOrigin[0]).toBeGreaterThan(-168);
    expect(host.playerOrigin[0]).toBeLessThanOrEqual(-60);
    expect(host.playerOrigin[2]).toBeCloseTo(24, 0);
  });

  it('strafes around and jumps', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { host } = boot;
    runFrames(host, 0, 500);
    keyDown(host.input, 'moveright');
    runFrames(host, 516, 1500);
    keyUp(host.input, 'moveright');
    // Facing +X, strafe right is -Y in Quake coords.
    expect(host.playerOrigin[1]).toBeLessThan(0);
    keyDown(host.input, 'jump');
    runFrames(host, 1516, 1700);
    keyUp(host.input, 'jump');
    // Airborne shortly after pressing jump.
    expect(host.playerOrigin[2]).toBeGreaterThan(26);
    runFrames(host, 1716, 3000);
    expect(host.playerOrigin[2]).toBeCloseTo(24, 0);
  });

  it('fires the blaster and renders real frames', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { host, driver } = boot;
    runFrames(host, 0, 500);
    keyDown(host.input, 'attack');
    runFrames(host, 516, 1200);
    keyUp(host.input, 'attack');
    expect(driver.events).toContain('shot');
    const stats = host.frame(1216);
    expect(stats.pixels).toBeGreaterThan(0);
  });

  it('M6.1/M7.2 follow-up: muzzle flash is one-shot, no dlight leak', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { host, driver } = boot;
    runFrames(host, 0, 500);
    let adds = 0;
    const origAdd = boot.refresh.testAddDynamicLight.bind(boot.refresh);
    boot.refresh.testAddDynamicLight = (l): void => {
      adds++;
      origAdd(l);
    };
    const fbSum = (): number => {
      const c = host.fb.color;
      let s = 0;
      for (let i = 0; i < c.length; i++) s += c[i]! & 0xffffff;
      return s;
    };
    // Fire once: exactly one dlight add for the shot.
    driver.pm.viewAngles = v3(0, 0, 0);
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.events).toContain('shot');
    expect(driver.muzzleLit()).toBe(true);
    expect(pumpMuzzleLight(boot)).toBe(true);
    expect(adds).toBe(1);
    // Lit frame is brighter than the cleared baseline; cleared frames are
    // byte-stable (no accumulation across frames). One pump per frame: the
    // pump clears first, so a second pump without a new shot adds nothing.
    host.frame(516);
    const lit = host.fb.color.slice();
    const litSum = fbSum();
    expect(pumpMuzzleLight(boot)).toBe(false);
    expect(adds).toBe(1);
    host.frame(532);
    const base = host.fb.color.slice();
    const baseSum = fbSum();
    expect(pumpMuzzleLight(boot)).toBe(false);
    expect(adds).toBe(1);
    host.frame(548);
    expect(litSum).toBeGreaterThan(baseSum);
    expect(Array.from(host.fb.color)).toEqual(Array.from(base));
    // Past the flash window the pump stays quiet (expiry drops the request).
    stepDriver(driver, neutralCmd(), 5);
    expect(driver.muzzleLit()).toBe(false);
    expect(pumpMuzzleLight(boot)).toBe(false);
    expect(adds).toBe(1);
    // Renderer-side observability when present: no live lights remain.
    const countHook = (boot.refresh as unknown as { testDynamicLightCount?: () => number }).testDynamicLightCount;
    if (typeof countHook === 'function') expect(countHook.call(boot.refresh)).toBe(0);
  });

  it('tracers: blaster fires a flying bolt (no hitscan beam), impact explodes', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { host, driver } = boot;
    runFrames(host, 0, 500);
    expect(driver.pendingTracers).toBe(0);
    // Fire once: authentic fire_blaster spawns one flying bolt, NOT a
    // muzzle->impact beam (only the railgun draws TE_RAILTRAIL).
    driver.pm.viewAngles = v3(0, 0, 0);
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.events).toContain('shot');
    expect(driver.events).toContain('bolt');
    expect(driver.bolts.length).toBe(1);
    expect(driver.pendingTracers).toBe(0);
    expect(pumpTracers(boot)).toBe(0);
    // Fly the bolt into the devroom pillar: trail + TE_BLASTER impact
    // (40-spark burst + explosion flash + lashit), bolt consumed.
    for (let i = 0; i < 10 && driver.bolts.length > 0; i++) {
      stepDriver(driver, neutralCmd(), 1);
    }
    expect(driver.bolts.length).toBe(0);
    expect(driver.mini.particles.length).toBeGreaterThan(10);
    expect(driver.explosions.length + driver.events.filter((e) => e === 'explosion').length).toBeGreaterThan(0);
    void host;
    // Empty queue pumps nothing (and never throws without shots).
    expect(pumpTracers(boot)).toBe(0);
  });

  it('selected weapon changes the visible view model', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    const { driver } = boot;
    const draw = (): Uint32Array => {
      const target = { width: 160, height: 120, color: new Uint32Array(160 * 120) };
      drawPlayHud(target, boot, { fps: 60, frame: 1 });
      return target.color;
    };
    const blaster = draw();
    driver.weapon = findWeapon('weapon_shotgun')!;
    const shotgun = draw();
    expect(Array.from(shotgun)).not.toEqual(Array.from(blaster));
    driver.weapon = findWeapon('weapon_machinegun')!;
    const machinegun = draw();
    expect(Array.from(machinegun)).not.toEqual(Array.from(blaster));
    expect(Array.from(machinegun)).not.toEqual(Array.from(shotgun));
  });

  it('conchars: procedural fallback without a pak, loader null-safe', () => {
    expect(loadConcharsFont(null)).toBeNull();
    expect(concharsFontFromPCX({ width: 64, height: 64, pixels: new Uint8Array(4096), palette: new Uint8Array(768) })).toBeNull();
    // Transparent index (id TRANSPARENT_COLOR 255) maps to 0, all else to 1.
    const clear = concharsFontFromPCX({ width: 128, height: 128, pixels: new Uint8Array(16384).fill(255), palette: new Uint8Array(768) });
    expect(clear).not.toBeNull();
    expect(clear!.every((b) => b === 0)).toBe(true);
    const ink = concharsFontFromPCX({ width: 128, height: 128, pixels: new Uint8Array(16384), palette: new Uint8Array(768) });
    expect(ink).not.toBeNull();
    expect(ink!.length).toBe(16384);
    expect(ink!.every((b) => b === 1)).toBe(true);
    bootPlay({ width: 32, height: 24 });
    expect(getConcharsFont()).toEqual(makeConcharsFont());
  });

  it('A: no 3D view model without a pak (2D silhouette path)', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    expect(boot.driver.viewModel()).toBeNull();
    expect(usesViewModel3D(boot)).toBe(false);
    expect(boot.driver.entityFrame(12345)).toBe(0);
    expect(boot.driver.models).toBeNull();
  });

  it('B: monsters animate MD2 frames and walk toward the player', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { host, driver } = boot;
    // Devroom ships no monsters; place a synthetic soldier east of the
    // pillar (player spawn is west at -168, 0) so the pillar blocks LOS and
    // the chase selector holds the run move (frame0 dist 10/tick) instead of
    // committing to a standing attack. It must still walk toward the player.
    const m = SV_SpawnMonster(driver.server, 'monster_soldier', v3(100, 0, 32));
    m.state.move = 'run';
    m.state.frame = 0;
    const x0 = m.edict.origin[0]!;
    stepDriver(driver, neutralCmd(), 5);
    // monsterThink advanced the state machine...
    expect(m.state.frame).toBeGreaterThan(0);
    expect(m.state.move).toBe('run');
    // ...the move table maps to a nonzero MD2 frame (run first=99)...
    expect(driver.entityFrame(m.edict.num)).toBe(99 + m.state.frame);
    expect(driver.entityFrame(m.edict.num)).toBeGreaterThan(0);
    // ...the monster walked toward the player (west spawn is at -168)...
    expect(m.edict.origin[0]!).toBeLessThan(x0);
    // ...it stays in the authoritative snapshot...
    expect(driver.snapshot(driver.server.time).entities.some((e) => e.id === m.edict.num)).toBe(true);
    // ...and the Host renders it with that MD2 frame (not frame 0).
    // Warm the snapshot stream first (snapshots ingest on host ticks).
    runFrames(host, 0, 500);
    let rendered: Entity[] = [];
    const orig = boot.refresh.renderView.bind(boot.refresh);
    vi.spyOn(boot.refresh, 'renderView').mockImplementation((view, world, entities) => {
      rendered = [...entities];
      return orig(view, world, entities);
    });
    host.frame(600);
    const byOrigin = rendered.filter((e) => Math.abs(e.origin[0]! - m.edict.origin[0]!) < 3);
    expect(byOrigin.length).toBe(1);
    expect(byOrigin[0]!.frame).toBe(driver.entityFrame(m.edict.num));
    expect(byOrigin[0]!.frame).toBeGreaterThan(0);
  });

  it('C: camera settles monotonically after stopping (no oscillation)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { host } = boot;
    const ys: number[] = [];
    const orig = boot.refresh.renderView.bind(boot.refresh);
    vi.spyOn(boot.refresh, 'renderView').mockImplementation((view, world, entities) => {
      ys.push(view.origin[1]!);
      return orig(view, world, entities);
    });
    runFrames(host, 0, 500);
    // Face +Y (open room, no pillar) and run at full speed for 0.6s.
    host.input.angles[1] = 90;
    keyDown(host.input, 'forward');
    let t = 516;
    for (; t <= 1116; t += 16) host.frame(t);
    keyUp(host.input, 'forward');
    expect(ys[ys.length - 1]!).toBeGreaterThan(50);
    // Release for 1s: friction-exact pmove prediction must settle forward
    // monotonically — no stale-velocity overshoot past the final tick, no
    // sign flips (the old linear-extrapolation path stepped back/forth).
    ys.length = 0;
    for (; t <= 2116; t += 16) host.frame(t);
    expect(ys.length).toBeGreaterThan(30);
    // The bulk of the friction settling happens right after release...
    const head = ys.slice(0, 30);
    expect(head[head.length - 1]! - head[0]!).toBeGreaterThan(5);
    // ...then the tail sits flat on the final tick: no backward steps, no
    // overshoot beyond the settled position.
    const tail = ys.slice(-30);
    for (let i = 1; i < tail.length; i++) {
      expect(tail[i]! - tail[i - 1]!).toBeGreaterThanOrEqual(-0.001);
    }
    const last = tail[tail.length - 1]!;
    expect(last).toBeGreaterThanOrEqual(tail[0]! - 0.01);
    for (const y of tail) expect(y).toBeLessThanOrEqual(last + 0.01); // never overshoots
  });

  it('D: fired blaster bolt flies, trails, and impacts with TE_BLASTER', () => {
    // Authentic fire_blaster: a 1000 u/s projectile with an EF_BLASTER
    // particle trail, resolved on touch (wall => TE_BLASTER burst +
    // explosion flash + lashit; flesh => damage). No muzzle->impact beam.
    const boot = bootPlay({ width: 96, height: 72 });
    const { host, driver } = boot;
    runFrames(host, 0, 500);
    driver.pm.viewAngles = v3(0, 0, 0);
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.events).toContain('shot');
    expect(driver.bolts.length).toBe(1);
    expect(driver.pendingTracers).toBe(0);
    expect(driver.viewModel()).toBeNull(); // devroom: no 3D gun (see pak test)
    const count0 = driver.mini.particles.length;
    // Fly to the pillar: trail along the path, then TE_BLASTER burst +
    // flash on touch; the bolt is consumed.
    for (let i = 0; i < 10 && driver.bolts.length > 0; i++) stepDriver(driver, neutralCmd(), 1);
    expect(driver.bolts.length).toBe(0);
    expect(driver.mini.particles.length).toBeGreaterThan(count0);
    host.frame(532);
    expect(driver.events).toContain('explosion');
  });

  it('M7.2: death respawns at the spawn point, view model + muzzle light draw', () => {
    const boot = bootPlay({ width: 160, height: 120 });
    const { driver } = boot;
    stepDriver(driver, neutralCmd(), 10);
    expect(driver.playerHealth).toBe(100);
    // Scripted lethal damage -> death parks a 2s respawn timer.
    driver.damagePlayer(200);
    expect(driver.playerDead).toBe(true);
    expect(driver.events).toContain('death');
    stepDriver(driver, neutralCmd(), 25);
    expect(driver.playerDead).toBe(false);
    expect(driver.playerHealth).toBe(100);
    expect(driver.events).toContain('respawn');
    expect(driver.pm.origin[0]).toBeCloseTo(-168, 0);
    // Fire once: muzzle flash window opens, pump delivers a real dlight.
    driver.pm.viewAngles = v3(0, 0, 0);
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.events).toContain('shot');
    expect(driver.muzzleLit()).toBe(true);
    expect(pumpMuzzleLight(boot)).toBe(true);
    // View model draws bottom-right gun + flash pixels post-resolve.
    const target = { width: 160, height: 120, color: new Uint32Array(160 * 120) };
    drawPlayHud(target, boot, { fps: 60, frame: 1 });
    let gunPixels = 0;
    for (let y = 120 - 40; y < 120; y++) {
      for (let x = 160 - 80; x < 160; x++) {
        if (target.color[y * 160 + x] !== 0) gunPixels++;
      }
    }
    expect(gunPixels).toBeGreaterThan(50);
    // Per-channel mixer: local player pain is full volume, far doors attenuate.
    driver.mixer.setListener([0, 0, 0], [0, 1, 0]);
    driver.mixer.startSound({
      origin: [500, 0, 0], fixedOrigin: true, entnum: 0,
      attenuation: 1, masterVol: 1, loop: false, name: 'doors/door.wav',
    });
    const mixed = driver.mixer.mix();
    const door = mixed.find((c) => c.name === 'doors/door.wav');
    expect(door).toBeDefined();
    expect((door!.left + door!.right) / 2).toBeLessThan(1);
    expect((door!.left + door!.right) / 2).toBeGreaterThan(0);
  });

  it('E: blaster bolt life is exactly 2s on server time; trail sparks expire', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    // Devroom ships static torch-flame particles: the sweep must preserve them.
    const staticCount = driver.mini.particles.length;
    expect(staticCount).toBeGreaterThan(0);
    // Aim straight up (pitch -90 = up, pitch positive is down): the analytic
    // room has no ceiling, so the bolt never touches and can only die by fuse.
    driver.pm.viewAngles = v3(-90, 0, 0);
    driver.step({ ...neutralCmd([-90, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.events).toContain('bolt');
    expect(driver.bolts.length).toBe(1);
    expect(driver.bolts[0]!.life).toBe(BOLT_LIFE);
    expect(driver.bolts[0]!.life).toBe(2);
    // 1s of ticks: still flying, trail behind it.
    stepDriver(driver, neutralCmd(), 10);
    expect(driver.bolts.length).toBe(1);
    expect(driver.mini.particles.length).toBeGreaterThan(staticCount);
    // 3s total: fuse spent on server time, bolt gone; its trail (SPARK_TTL)
    // fully aged out; only the static particles remain, no stray explosion.
    stepDriver(driver, neutralCmd(), 20);
    expect(driver.bolts.length).toBe(0);
    expect(driver.mini.particles.length).toBe(staticCount);
    expect(driver.explosions.length).toBe(0);
    expect(driver.events).not.toContain('explosion');
  });

  it('F: TE_BLASTER impact flash is brief (~0.1s), never a stuck light', () => {    const boot = bootPlay({ width: 64, height: 48 });
    const { host, driver } = boot;
    runFrames(host, 0, 500);
    driver.pm.viewAngles = v3(0, 0, 0);
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.bolts.length).toBe(1);
    // Fly into the devroom pillar: bolt consumed, TE_BLASTER burst + flash.
    for (let i = 0; i < 10 && driver.bolts.length > 0; i++) stepDriver(driver, neutralCmd(), 1);
    expect(driver.bolts.length).toBe(0);
    expect(driver.events).toContain('explosion');
    // The impact flash pumps exactly one dlight...
    expect(pumpExplosionLights(boot)).toBeGreaterThan(0);
    // ...and is gone 0.5s later: the drain window drops it, the renderer ttl reaps it.
    stepDriver(driver, neutralCmd(), 6);
    expect(pumpExplosionLights(boot)).toBe(0);
    expect(driver.drainExplosions()).toEqual([]);
    host.frame(600);
    host.frame(616);
    host.frame(632);
    const countHook = (boot.refresh as unknown as { testDynamicLightCount?: () => number }).testDynamicLightCount;
    if (typeof countHook === 'function') expect(countHook.call(boot.refresh)).toBe(0);
    // The un-pumped muzzle request from the shot expired with its window:
    // the one-shot gate stays quiet instead of sticking a light on later.
    expect(driver.muzzleLit()).toBe(false);
    expect(pumpMuzzleLight(boot)).toBe(false);
  });

  it('G: blaster matches G_ProjectSource/CL_MuzzleFlash/CL_BlasterTrail ground truth', () => {    // Ground truth (g_weapon.c fire_blaster/blaster_touch, p_weapon.c
    // Weapon_Blaster_Fire, cl_ents.c EF_BLASTER, cl_fx.c trail/impact,
    // G_ProjectSource in g_utils.c; SP damage 10):
    // - spawn = feet + fwd*24 + right*8, z += viewheight-8 (22-8 = 14);
    // - muzzle = feet + fwd*18 + right*16, 200+(rand&31), pure yellow;
    // - in-flight: 200 yellow dlight + trail step 5u at fixed 0xe0.
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    driver.pm.origin = v3(-168, 0, 24);
    driver.pm.velocity = v3();
    driver.pm.viewAngles = v3(0, 0, 0);
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.events).toContain('bolt');
    expect(driver.bolts.length).toBe(1);
    // SP damage (deathmatch 15 does not apply: our game is SP-only).
    expect(driver.bolts[0]!.damage).toBe(10);
    // Facing +X: fwd=(1,0,0), right=(0,-1,0) — spawn off the gun muzzle,
    // not the eye: feet + (24,-8,14).
    const bolt = driver.bolts[0]!;
    expect(bolt.pos[0]).toBeCloseTo(-168 + 24, 6);
    expect(bolt.pos[1]).toBeCloseTo(0 - 8, 6);
    expect(bolt.pos[2]).toBeCloseTo(24 + 14, 6);
    // Muzzle dlight: feet + fwd*18 + right*16, 200+(rand&31), pure yellow.
    const seen: Array<{ origin: Float32Array; intensity: number; color: Float32Array }> = [];
    const origAdd = boot.refresh.testAddDynamicLight.bind(boot.refresh);
    boot.refresh.testAddDynamicLight = (l): void => {
      seen.push(l);
      origAdd(l);
    };
    expect(pumpMuzzleLight(boot)).toBe(true);
    expect(seen.length).toBe(1);
    expect(seen[0]!.origin[0]).toBeCloseTo(-168 + 18, 6);
    expect(seen[0]!.origin[1]).toBeCloseTo(0 - 16, 6);
    expect(seen[0]!.origin[2]).toBeCloseTo(24, 6);
    expect(seen[0]!.intensity).toBeGreaterThanOrEqual(200);
    expect(seen[0]!.intensity).toBeLessThanOrEqual(231);
    expect(Array.from(seen[0]!.color)).toEqual([1, 1, 0]);
    // In-flight: one 200-intensity pure-yellow dlight per live bolt.
    seen.length = 0;
    expect(pumpBoltLights(boot)).toBe(1);
    expect(seen.length).toBe(1);
    expect(seen[0]!.intensity).toBe(200);
    expect(Array.from(seen[0]!.color)).toEqual([1, 1, 0]);
    expect(seen[0]!.origin[0]).toBeCloseTo(bolt.pos[0]!, 6);
    expect(seen[0]!.origin[1]).toBeCloseTo(bolt.pos[1]!, 6);
    expect(seen[0]!.origin[2]).toBeCloseTo(bolt.pos[2]!, 6);
    // Trail sparks are the fixed palette color 0xe0 (impact keeps rand&7).
    // Fire upward (pitch -90 = up, no ceiling): pure trail, no touch burst.
    const boot2 = bootPlay({ width: 64, height: 48 });
    const d2 = boot2.driver;
    const staticCount = d2.mini.particles.length;
    d2.pm.origin = v3(-168, 0, 24);
    d2.pm.velocity = v3();
    d2.pm.viewAngles = v3(-90, 0, 0);
    d2.step({ ...neutralCmd([-90, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    expect(d2.bolts.length).toBe(1);
    stepDriver(d2, neutralCmd(), 1);
    expect(d2.bolts.length).toBe(1); // still flying: fuse is 2s on server time
    const fresh = d2.mini.particles.slice(staticCount) as Array<{ color: number }>;
    expect(fresh.length).toBeGreaterThan(0);
    for (const p of fresh) expect(p.color).toBe(0xe0);
  });

  it('H: gunframe walks fire-first to idle-first (blaster 5→9, p_weapon.c)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    // READY holds the idle-first frame (Weapon_Blaster 9..52).
    expect(driver.gunFrame).toBe(9);
    driver.pm.viewAngles = v3(0, 0, 0);
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.events).toContain('shot');
    // Firing starts at FIRE_FIRST (activate 4 + 1); the per-tick stepper
    // walks it to IDLE_FIRST+1 (fire 8 + 2) — never a frozen fire frame.
    expect(driver.gunFrame).toBe(5);
    stepDriver(driver, neutralCmd(), 1);
    expect(driver.gunFrame).toBe(6);
    stepDriver(driver, neutralCmd(), 3);
    expect(driver.gunFrame).toBe(9);
    // READY holds idle-first (does not stick at 10 or wrap to 0).
    stepDriver(driver, neutralCmd(), 3);
    expect(driver.gunFrame).toBe(9);
  });

  it('H: firing kick is visible for exactly one tick (blaster -2/-1)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    expect(driver.viewKick()).toBeNull();
    driver.pm.viewAngles = v3(0, 0, 0);
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    // Facing +X: kickOrigin = -2*fwd, pitch kick -1 (Blaster_Fire).
    const kick = driver.viewKick();
    expect(kick).not.toBeNull();
    expect(kick!.angles).toEqual([-1, 0, 0]);
    expect(kick!.origin[0]).toBeCloseTo(-2, 6);
    expect(kick!.origin[1]).toBeCloseTo(0, 6);
    expect(kick!.origin[2]).toBeCloseTo(0, 6);
    // Exactly one 10Hz tick: the next step clears it (compute-then-clear).
    stepDriver(driver, neutralCmd(), 1);
    expect(driver.viewKick()).toBeNull();
  });

  it('H: shotgun kick is -2/-2 (weapon_shotgun_fire)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    driver.ps.weapons.push('weapon_shotgun');
    driver.selectWeapon('weapon_shotgun');
    driver.shells = 5;
    driver.pm.viewAngles = v3(0, 0, 0);
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.events).toContain('shot');
    const kick = driver.viewKick();
    expect(kick).not.toBeNull();
    expect(kick!.angles).toEqual([-2, 0, 0]);
    expect(kick!.origin[0]).toBeCloseTo(-2, 6);
    stepDriver(driver, neutralCmd(), 1);
    expect(driver.viewKick()).toBeNull();
  });

  it('H: sway is zeros when still, turn-lag + bob when moving (p_view.c)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    stepDriver(driver, neutralCmd(), 3);
    // Static (xyspeed < 5): gunoffset stays 0, sway zeros.
    expect(driver.gunAnglesDelta()).toEqual([0, 0, 0]);
    // Run facing +Y (open room, no pillar): bob sway builds (xyspeed-scaled,
    // sign flips per bobcycle).
    const run: UserCmdT = { msec: 100, angles: [0, 90, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 };
    let peak = 0;
    for (let i = 0; i < 8; i++) {
      driver.step(run, 0.1);
      const g = driver.gunAnglesDelta()!;
      peak = Math.max(peak, Math.abs(g[0]!) + Math.abs(g[1]!) + Math.abs(g[2]!));
    }
    expect(peak).toBeGreaterThan(0.01);
    // Snap-turn 60° while moving: turn lag 0.2*clamped(-45) dominates yaw.
    driver.step({ ...run, angles: [0, 150, 0] }, 0.1);
    const turned = driver.gunAnglesDelta()!;
    expect(turned[1]!).toBeLessThan(-4);
  });

  it('I: lethal barrel hit schedules a 0.2s fuse, then explosion + 14 debris', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    driver.pm.origin = v3(-144, -16, 24);
    driver.pm.velocity = v3();
    driver.pm.viewAngles = v3(-90, 0, 0);
    SV_AddBarrel(driver.server, v3(-144, -16, 100));
    driver.step({ ...neutralCmd([-90, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.bolts.length).toBe(1);
    // Bolt climbs 100u/tick into the barrel hull: lethal hit, fuse set, and
    // the TE_BLASTER touch flash (no big boom yet — barrel_delay fuse).
    stepDriver(driver, neutralCmd(), 1);
    expect(driver.bolts.length).toBe(0);
    const barrel = driver.barrels[0]!;
    // C barrel_delay: the brush stays live + solid during the 0.2s fuse —
    // freed + clip-drop happen atomically at the blow, never at damage time.
    expect(barrel.edict.freed).toBe(false);
    expect(driver.pendingFuses).toBe(1);
    expect(driver.explosions.some((e) => e.kind === 'explosion1')).toBe(false);
    expect(driver.debris.length).toBe(0);
    // One more tick (0.1s) is still inside the 0.2s fuse.
    stepDriver(driver, neutralCmd(), 1);
    expect(driver.pendingFuses).toBe(1);
    expect(driver.explosions.some((e) => e.kind === 'explosion1')).toBe(false);
    // Fuse blows: 256-spark boom + T_RadiusDamage (attacker-half hurts us).
    const hpBefore = driver.playerHealth;
    stepDriver(driver, neutralCmd(), 2);
    expect(driver.pendingFuses).toBe(0);
    // Fuse blew: freed + clip-drop on the same tick (no freed-but-solid window).
    expect(driver.barrels[0]!.edict.freed).toBe(true);
    expect(driver.events).toContain('barrel');
    expect(driver.events).toContain('explosion');
    const big = driver.explosions.find((e) => e.kind === 'explosion1');
    expect(big).toBeDefined();
    expect(driver.debris.length).toBe(14);
    expect(driver.debris.filter((d) => d.kind === 'debris1').length).toBe(2);
    expect(driver.debris.filter((d) => d.kind === 'debris2').length).toBe(8);
    expect(driver.debris.filter((d) => d.kind === 'debris3').length).toBe(4);
    expect(driver.mini.particles.length).toBeGreaterThan(256);
    expect(driver.playerHealth).toBeLessThan(hpBefore);
  });

  it('I: func_explosive debris follows the mass formula (mass/100 cap 8 + mass/25 cap 16)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    driver.ps.health = 1000;
    driver.pm.origin = v3(-144, -16, 24);
    driver.pm.velocity = v3();
    driver.pm.viewAngles = v3(-90, 0, 0);
    SV_AddBarrel(driver.server, v3(-144, -16, 100), { health: 100, dmg: 0, mass: 400, isFunc: true });
    // Bolt damage 10 × 10 hits to burn through 100hp: refire-limited, so
    // step attack until the fuse is lit (bolt hits every ~3 ticks).
    for (let i = 0; i < 40 && driver.pendingFuses === 0; i++) {
      driver.step({ ...neutralCmd([-90, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    }
    expect(driver.pendingFuses).toBe(1);
    for (let i = 0; i < 5 && driver.pendingFuses === 1; i++) stepDriver(driver, neutralCmd(), 1);
    expect(driver.pendingFuses).toBe(0);
    expect(driver.debris.filter((d) => d.kind === 'debris1').length).toBe(4);
    expect(driver.debris.filter((d) => d.kind === 'debris2').length).toBe(16);
    expect(driver.debris.filter((d) => d.kind === 'debris3').length).toBe(0);
  });

  it('J: re-hitting a corpse minces it (gibs + udeath, then unhittable)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    driver.pm.origin = v3(-168, 100, 24);
    driver.pm.velocity = v3();
    driver.pm.viewAngles = v3(0, 0, 0);
    const m = SV_SpawnMonster(driver.server, 'monster_soldier', v3(100, 92, 24));
    // Kill cleanly (30hp exactly: dead, not gibbed since 0 > gibHealth -30).
    expect(monsterPain(m.state, 30, () => 0.5)).toBe('dead');
    expect(m.state.dead).toBe(true);
    expect(m.state.gibbed).toBe(false);
    // Fire blaster bolts downrange: each bolt impact re-hits the corpse
    // (no dead-skip) until the gib-health check minces it (3×10dmg: 0→-30).
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    stepDriver(driver, neutralCmd(), 5);
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    stepDriver(driver, neutralCmd(), 5);
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    stepDriver(driver, neutralCmd(), 8);
    expect(m.state.gibbed).toBe(true);
    expect(driver.events).toContain('gib');
    expect(driver.gibs.length).toBe(5);
    expect(driver.gibs.filter((g) => g.kind === 'meat').length).toBe(3);
    // Gibbed is DEAD_DEAD unhittable: further fire changes nothing, and the
    // snapshot drops the minced body (normal corpses persist instead).
    const gibEvents = driver.events.filter((e) => e === 'gib').length;
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    stepDriver(driver, neutralCmd(), 6);
    expect(driver.events.filter((e) => e === 'gib').length).toBe(gibEvents);
    expect(driver.gibs.length).toBe(5);
    expect(driver.snapshot(driver.server.time).entities.some((e) => e.id === m.edict.num)).toBe(false);
  });

  it('K: monster fire frames spawn tracers (hitscan) and foe bolts (blaster)', () => {    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    // Soldier off to the side (open LOS past the pillar) at ~224u: NEAR
    // range, so chase commits attack1/attack2 once it faces the player.
    SV_SpawnMonster(driver.server, 'monster_soldier', v3(32, 100, 24));
    let sawTracer = false;
    let sawBolt = false;
    let sawFlash = false;
    for (let i = 0; i < 90; i++) {
      stepDriver(driver, neutralCmd(), 1);
      if (driver.pendingTracers > 0) sawTracer = true;
      if (driver.bolts.length > 0) sawBolt = true;
      if (driver.drainEnemyMuzzle().length > 0) sawFlash = true;
      if (driver.events.includes('monshot') && (sawTracer || sawBolt) && sawFlash) break;
    }
    // Fire-gated return fire happened on a 'fire' frame (not the old timer).
    expect(driver.events).toContain('monshot');
    expect(sawTracer || sawBolt).toBe(true);
    // Every monster shot carries its 200+(rand&31) yellow muzzle dlight.
    expect(sawFlash).toBe(true);
  });

  it('L: rendered monster closes on a live player (driver + renderView)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { host, driver } = boot;
    // Soldier east with the pillar between it and the spawn: no LOS, so the
    // first leg is a blind chase — C ai_checkattack refuses without
    // enemy_vis (g_ai.c `if (!enemy_vis) return false`), so the chase holds
    // `run` every tick (never an attack plant) while locomotion walks it at
    // the last sighting. The sweep (C SV_NewChaseDir-lite) then rounds the
    // pillar end, LOS latches, and M_CheckAttack commits to an attack move:
    // closes-then-engages, exactly the C ai_run narrative.
    const m = SV_SpawnMonster(driver.server, 'monster_soldier', v3(200, 0, 32));
    const distToPlayer = (): number =>
      Math.hypot(m.edict.origin[0]! - driver.pm.origin[0]!, m.edict.origin[1]! - driver.pm.origin[1]!, m.edict.origin[2]! - driver.pm.origin[2]!);
    const d0 = distToPlayer();
    expect(d0).toBeGreaterThan(300);
    stepDriver(driver, neutralCmd(), 15);
    // Still blind (pressing the pillar face): running, closing, no shot.
    expect(m.state.move).toBe('run');
    const dMid = distToPlayer();
    expect(dMid).toBeLessThan(d0 - 50);
    expect(driver.events).not.toContain('monshot');
    stepDriver(driver, neutralCmd(), 25);
    // Rounded the pillar and engaged: an attack move is playing (attack1 vs
    // attack2 is the C soldier_attack coin flip at NEAR — accept either).
    expect(['attack1', 'attack2']).toContain(m.state.move);
    expect(driver.events).toContain('monshot');
    // The volley left fire evidence (tracer and/or enemy muzzle queued).
    const tracers = driver.drainTracers();
    const flashes = driver.drainEnemyMuzzle();
    expect(tracers.length + flashes.length).toBeGreaterThan(0);
    const d1 = distToPlayer();
    expect(d1).toBeLessThan(d0 - 50);
    // The authoritative snapshot carries the closed-in origin…
    expect(driver.snapshot(driver.server.time).entities.some((e) => e.id === m.edict.num)).toBe(true);
    // …and the Host actually submits it to renderView (not PVS/frustum-
    // culled away): captured entity rides within 5u of the driver origin and
    // is strictly closer to the player than at spawn.
    runFrames(host, 0, 500);
    let rendered: Entity[] = [];
    const orig = boot.refresh.renderView.bind(boot.refresh);
    vi.spyOn(boot.refresh, 'renderView').mockImplementation((view, world, entities) => {
      rendered = [...entities];
      return orig(view, world, entities);
    });
    host.frame(600);
    const near = rendered.filter((e) => Math.hypot(e.origin[0]! - m.edict.origin[0]!, e.origin[1]! - m.edict.origin[1]!, e.origin[2]! - m.edict.origin[2]!) < 5);
    expect(near.length).toBe(1);
    expect(near[0]!.frame).toBe(driver.entityFrame(m.edict.num));
    const rd = Math.hypot(
      near[0]!.origin[0]! - host.playerOrigin[0]!,
      near[0]!.origin[1]! - host.playerOrigin[1]!,
      near[0]!.origin[2]! - host.playerOrigin[2]!,
    );
    expect(rd).toBeLessThan(d0 - 50);
  });
});

const WEB_Q2_PAK = process.env.Q2_PAK;

describe.runIf(!!WEB_Q2_PAK)('play driver (real base1, Q2_PAK)', () => {
  it('boots base1, walks, and fires', { timeout: 180000 }, async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const pak = ingestPak(buf);
    const boot = bootPlay({ width: 96, height: 72, pak });
    expect(boot.source).toBe('pak');
    expect(boot.driver.monsters.length).toBeGreaterThan(0);
    const { host, driver } = boot;
    const start: [number, number, number] = [...host.playerOrigin] as [number, number, number];
    // Spawn is the lump info_player_start, feet slightly above the floor.
    expect(host.playerOrigin[2]).toBeGreaterThan(0);
    runFrames(host, 0, 500);
    // Settled onto the floor.
    expect(host.playerOrigin[2]).toBeLessThan(start[2]);
    keyDown(host.input, 'forward');
    runFrames(host, 516, 5500);
    keyUp(host.input, 'forward');
    const posA: [number, number, number] = [...host.playerOrigin] as [number, number, number];
    const legA = Math.hypot(posA[0]! - start[0]!, posA[1]! - start[1]!);
    // Spawn faces a wall ~48 units out: the first leg must move, then stop.
    expect(legA).toBeGreaterThan(20);
    // Turn around and walk back: proves sustained locomotion, not drift.
    host.input.angles[1]! += 180;
    keyDown(host.input, 'forward');
    runFrames(host, 5516, 10500);
    keyUp(host.input, 'forward');
    const legB = Math.hypot(host.playerOrigin[0]! - posA[0]!, host.playerOrigin[1]! - posA[1]!);
    expect(legB).toBeGreaterThan(100);
    keyDown(host.input, 'attack');
    runFrames(host, 10516, 11500);
    keyUp(host.input, 'attack');
    expect(driver.events).toContain('shot');
    const stats = host.frame(11516);
    expect(stats.pixels).toBeGreaterThan(0);
  });

  it('M7.2: damage, shotgun pickup, monster kill, exit', { timeout: 180000 }, async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const pak = ingestPak(buf);
    const boot = bootPlay({ width: 96, height: 72, pak });
    expect(boot.source).toBe('pak');
    const { driver } = boot;
    expect(driver.monsters.length).toBeGreaterThan(0);
    stepDriver(driver, neutralCmd([0, 135, 0]), 10);
    // 1. Scripted damage: monsters fight back, so the player can be hurt.
    //    Here the script deals it directly; the melee exchange below proves
    //    the monster side independently.
    const hpBefore = driver.playerHealth;
    driver.damagePlayer(30);
    expect(driver.playerHealth).toBe(hpBefore - 30);
    expect(driver.events).toContain('pain');
    const mixedPain = driver.mixer.mix();
    // Real pak pain sound (C P_DamageFeedback band: 70hp -> pain75_*).
    expect(mixedPain.some((c) => c.name.startsWith('player/male/pain75_') && c.left === 1)).toBe(true);
    // 2. Shotgun pickup: base1's weapon_shotgun sits at (800,-96,-168).
    expect(driver.hasWeapon('weapon_shotgun')).toBe(false);
    driver.pm.origin = v3(800, -96, -144);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 5);
    expect(driver.hasWeapon('weapon_shotgun')).toBe(true);
    expect(driver.events).toContain('pickup');
    driver.selectWeapon('weapon_shotgun');
    expect(driver.weapon.classname).toBe('weapon_shotgun');
    const mixedPickup = driver.mixer.mix().map((c) => c.name);
    expect(mixedPickup).toContain('items/pkup.wav');
    // 3. Monster kill: stand next to a soldier in its own cell (same room,
    //    clear line of sight), aim dead-on, fire the blaster until it dies.
    //    The soldier melees back every ~1s, proving fight-back damage.
    //    The first plain (shotgun-skin) soldier keeps the pre-skin-roster
    //    geometry this script was tuned against (an enclosed cell where bolt
    //    wall-splash chips the target); lights live in the open.
    const target = driver.server.monsters.find((m) => m.edict.extra['skinnum'] === '2') ?? driver.server.monsters[0]!;
    let killed = false;
    for (const [ox, oy] of [[48, 0], [-48, 0], [0, 48], [0, -48]] as const) {
      if (target.state.dead) {
        killed = true;
        break;
      }
      driver.pm.origin = v3(target.edict.origin[0]! + ox, target.edict.origin[1]! + oy, target.edict.origin[2]! + 24);
      driver.pm.velocity = v3();
      const yaw = (Math.atan2(target.edict.origin[1]! - driver.pm.origin[1]!, target.edict.origin[0]! - driver.pm.origin[0]!) * 180) / Math.PI;
      const atk: UserCmdT = { msec: 100, angles: [0, yaw, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_ATTACK };
      for (let i = 0; i < 60 && !target.state.dead; i++) driver.step(atk, 0.1);
      if (target.state.dead) killed = true;
    }
    expect(killed).toBe(true);
    expect(driver.events).toContain('kill');
    // Corpses persist in the snapshot, holding the last death frame.
    expect(driver.snapshot(driver.server.time).entities.some((e) => e.id === target.edict.num)).toBe(true);
    expect(driver.entityFrame(target.edict.num)).toBeGreaterThan(0);
    // 4. Exit: drop into the *27 pit volume; the brush trigger fires t37.
    driver.pm.origin = v3(-1776, 1544, -32);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 5);
    expect(driver.exited).toBe(true);
    expect(driver.message).toContain('LEVEL COMPLETE');
  });

  it('M7.2 follow-up: pak registers real MD2 models + PCX skins', async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const pak = ingestPak(buf);
    const boot = bootPlay({ width: 96, height: 72, pak });
    expect(boot.models).not.toBeNull();
    // Soldier first: the Host's hardcoded model:0/skin:0 entities render it.
    expect(boot.models!.monster).toBe(0);
    expect(boot.models!.skins[0]).toBe(0);
    expect(boot.models!.gunner).toBeGreaterThan(0);
    expect(boot.models!.weapons['weapon_blaster']).toBeGreaterThan(0);
    expect(boot.models!.weapons['weapon_shotgun']).toBeGreaterThan(0);
    expect(boot.models!.weapons['weapon_machinegun']).toBeGreaterThan(0);
    expect(boot.models!.bolt).toBeGreaterThan(0);
    // The registered soldier mesh actually draws (frame renders monsters).
    const stats = boot.host.frame(100);
    expect(stats.pixels).toBeGreaterThan(0);
  });

  it('A+B: pak 3D view model renders camera-attached, monsters animate, no 2D icon', async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const pak = ingestPak(buf);
    const boot = bootPlay({ width: 160, height: 120, pak });
    expect(boot.source).toBe('pak');
    const { host, driver } = boot;
    // 3D path active with the real v_blast MD2 handle + skin.
    expect(usesViewModel3D(boot)).toBe(true);
    const vm = driver.viewModel();
    expect(vm).not.toBeNull();
    expect(vm!.model).toBe(boot.models!.weapons['weapon_blaster']);
    expect(vm!.skin).toBe(boot.models!.weaponSkins['weapon_blaster']);
    expect(vm!.frame).toBe(9); // blaster idle-first (Weapon_Blaster 9..52)
    // Muzzle-lit → fire anim frame (renderer wraps; v_blast has 56).
    driver.pm.viewAngles = v3(0, 0, 0);
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.events).toContain('shot');
    expect(driver.viewModel()!.frame).toBe(VIEWMODEL_FIRE_FRAME);
    // Render: the gun entity rides the camera (close, same angles).
    runFrames(host, 0, 500);
    let rendered: Entity[] = [];
    const orig = boot.refresh.renderView.bind(boot.refresh);
    vi.spyOn(boot.refresh, 'renderView').mockImplementation((view, world, entities) => {
      rendered = [...entities];
      return orig(view, world, entities);
    });
    host.frame(516);
    const gun = rendered.find((e) => e.model === vm!.model);
    expect(gun).toBeDefined();
    expect(gun!.skin).toBe(vm!.skin);
    const dg = Math.hypot(
      gun!.origin[0]! - host.playerOrigin[0]!,
      gun!.origin[1]! - host.playerOrigin[1]!,
      gun!.origin[2]! - host.playerOrigin[2]!,
    );
    expect(dg).toBeLessThan(60);
    // No 2D icon double-draw: the blaster silhouette body color never
    // paints the bottom-right HUD region on the 3D path.
    const target = { width: 160, height: 120, color: new Uint32Array(160 * 120) };
    drawPlayHud(target, boot, { fps: 60, frame: 1 });
    let icon = 0;
    for (let y = 120 - 44; y < 120; y++) {
      for (let x = 160 - 92; x < 160; x++) {
        if (target.color[y * 160 + x] === 0xff3a3f44) icon++;
      }
    }
    expect(icon).toBe(0);
    // Monster frames advance through the move table (nonzero MD2 frame).
    stepDriver(driver, neutralCmd(), 3);
    const m0 = driver.server.monsters[0]!;
    expect(driver.entityFrame(m0.edict.num)).toBeGreaterThan(0);
  });

  it('sky: env/unit1_ strip loads and the renderer takes it', async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const { loadSkyStrip, skyNameForMap } = await import('./play.js');
    const pak = ingestPak(buf);
    const boot = bootPlay({ width: 96, height: 72, pak });
    expect(skyNameForMap(boot.driver.map)).toBe('unit1_');
    const { readPakEntry } = await import('./pak.js');
    const { parsePCX } = await import('@q2/formats');
    const mainPalette = parsePCX(readPakEntry(pak, 'pics/colormap.pcx')).palette;
    const strip = loadSkyStrip(pak, 'unit1_', mainPalette);
    expect(strip).not.toBeNull();
    // Six 256x256 faces stacked vertically.
    expect(strip!.width).toBe(256);
    expect(strip!.height).toBe(256 * 6);
    expect(strip!.texels.length).toBe(256 * 256 * 6);
    // Real art, not a flat fill: many distinct indices.
    expect(new Set(strip!.texels).size).toBeGreaterThan(16);
  });

  it('M6.1 follow-up: real conchars.pcx replaces the procedural font', async () => {    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const { loadConcharsFont: loadFont } = await import('./play.js');
    const { getConcharsFont: getFont, makeConcharsFont: makeFont } = await import('@q2/client');
    const pak = ingestPak(buf);
    const font = loadFont(pak);
    expect(font).not.toBeNull();
    expect(font!.length).toBe(256 * 64);
    // Real glyphs carry ink; the all-zero synthetic font does not.
    expect(font!.some((b) => b === 1)).toBe(true);
    expect(font).not.toEqual(makeFont());
    // Pak boot wires it as the active HUD font (headless-safe, no DOM/IDB).
    bootPlay({ width: 32, height: 24, pak });
    expect(getFont()).toEqual(font!);
  });

  it('G: start-room exploboxes parsed, kept, and exposed in the snapshot', { timeout: 180000 }, async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const pak = ingestPak(buf);
    const boot = bootPlay({ width: 96, height: 72, pak });
    const { driver } = boot;
    // base1 lump inventory (verified by dumping the entities lump): 9
    // misc_explobox + 2 func_explosive (*20 and its twin).
    expect(driver.barrels.length).toBe(11);
    // True spawn is the untargeted info_player_start (128,-320,32); the two
    // start-room exploboxes rest on the floor ~300-360 units out, origins
    // kept exactly as the mapper placed them (id M_droptofloor outcome).
    const near = driver.barrels.filter(
      (b) => Math.hypot(b.origin[0]! - 128, b.origin[1]! + 320) < 400,
    );
    expect(near.length).toBe(2);
    // C M_droptofloor outcome (server-spawned): +1/32 contact epsilon over
    // the lump origins — the server barrel test pins the same rounding.
    const rounded = near.map((x) => [Math.round(x.origin[0]!), Math.round(x.origin[1]!), Math.round(x.origin[2]!)]);
    expect(rounded).toContainEqual([136, 40, 0]);
    expect(rounded).toContainEqual([184, -24, 0]);
    // Snapshot stays player + monsters; live barrels ride the Host
    // extraEntities hook with their own barrel MD2 handles (appended after
    // the bolt so every pre-existing handle is stable).
    const snap = driver.snapshot(driver.server.time);
    expect(snap.entities.every((e) => e.id === 1 || driver.server.monsters.some((m) => m.edict.num === e.id))).toBe(true);
    const extras = driver.extraEntities();
    expect(extras).not.toBeNull();
    // Barrels ride 1:1 for genuine exploboxes (plus pickups/ships/banners/
    // corpses on the same hook since M7.1 — filter by the barrel handle for
    // the barrel assertions). func_explosive NEVER rides the barrel MD2
    // (brush geometry via the graft), so the count is exploboxes only.
    const barrelX = extras!.filter((x) => x.model === boot.models!.barrel);
    expect(barrelX.length).toBe(driver.barrels.filter((b) => !b.isFunc).length);
    const roundedX = barrelX.map((x) => [Math.round(x.origin![0]!), Math.round(x.origin![1]!), Math.round(x.origin![2]!)]);
    expect(roundedX).toContainEqual([136, 40, 0]);
    expect(roundedX).toContainEqual([184, -24, 0]);
    for (const x of barrelX) {
      expect(x.skin).toBe(boot.models!.barrelSkin);
    }
    // Snapshot pairing hooks: soldiers resolve to their per-skin handles
    // (first lump monster is a light: skin_lt, not the default), unknown
    // ids to null (Host default), monster facing rides entityAngles.
    const m0 = driver.server.monsters[0]!;
    expect(driver.entityModel(m0.edict.num)).toEqual({ model: boot.models!.monster, skin: driver.soldierSkinFor(driver.monsterSkin(m0)) });
    expect(driver.soldierSkinFor(driver.monsterSkin(m0))).toBe(boot.models!.soldierLightSkin);
    expect(driver.entityModel(999999)).toBeNull();
    const yaw0 = ((m0.state.yaw % 360) + 360) % 360;
    expect(driver.entityAngles(m0.edict.num)).toEqual([0, yaw0, 0]);
    expect(driver.entityAngles(999999)).toBeNull();
    // No trigger_always targets a target_explosion (t148/t142/t134 fire
    // strogg-ship flybys, t91 a secret/train/button): the boot itself fires
    // no premature blast. The tick-0 showcase (trigger_once *16 -> relay
    // t70 -> t151, distant flashes) is server-side map scripting, visible
    // by design — not a consumed secret.
    expect(driver.events).not.toContain('explosion');
    expect(driver.explosions.length).toBe(0);
    // Fired bolts ride the same hook with the laser MD2 + flight angles.
    driver.pm.viewAngles = v3(0, 135, 0);
    driver.step({ ...neutralCmd([0, 135, 0]), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.bolts.length).toBe(1);
    const withBolt = driver.extraEntities()!;
    expect(withBolt.filter((x) => x.model === boot.models!.barrel).length).toBe(
      driver.barrels.filter((b) => !b.edict.freed && !b.isFunc).length,
    );
    const boltX = withBolt.find((x) => x.model === boot.models!.bolt)!;
    expect(boltX).toBeDefined();
    expect(boltX.model).toBe(boot.models!.bolt);
    expect(boltX.skin).toBe(boot.models!.boltSkin);
    expect(boltX.angles![0]).toBeCloseTo(0, 0);
    expect(boltX.angles![1]).toBeCloseTo(135, 0);
    // ...and the Host actually renders them: extras flow into renderView.
    let rendered: Entity[] = [];
    const orig = boot.refresh.renderView.bind(boot.refresh);
    vi.spyOn(boot.refresh, 'renderView').mockImplementation((view, world, entities) => {
      rendered = [...entities];
      return orig(view, world, entities);
    });
    boot.host.frame(100);
    expect(rendered.some((e) => e.model === boot.models!.barrel)).toBe(true);
    expect(rendered.some((e) => e.model === boot.models!.bolt)).toBe(true);
  });

  it('M7.1 ships: flybys submit live train positions every frame, models registered', { timeout: 180000 }, async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const pak = ingestPak(buf);
    const boot = bootPlay({ width: 96, height: 72, pak });
    const { driver } = boot;
    // Ship MD2 + skin registered (never -1/unregistered).
    expect(boot.models!.ship).toBeGreaterThanOrEqual(0);
    expect(boot.models!.shipSkin).toBeGreaterThanOrEqual(0);
    const ships = driver.server.trains.filter((t) => t.ship);
    expect(ships.length).toBe(3);
    // All three flybys trigger_always-started server-side (C behaviour).
    expect(ships.every((t) => t.started)).toBe(true);
    const shipOrigins = (): Array<[number, number, number]> =>
      driver.extraEntities()!.filter((x) => x.model === boot.models!.ship).map((x) => [...x.origin!] as [number, number, number]);
    // 1:1 with the server roster — no missing ship, no double-submit.
    expect(shipOrigins().length).toBe(ships.length);
    // Advance ticks: origins move along the path_corner loops.
    const before = shipOrigins();
    for (let i = 0; i < 5; i++) driver.step(neutralCmd(), 0.1);
    const after = shipOrigins();
    expect(after.length).toBe(ships.length);
    let moved = 0;
    for (let i = 0; i < before.length; i++) {
      moved += Math.hypot(after[i]![0] - before[i]![0], after[i]![1] - before[i]![1], after[i]![2] - before[i]![2]);
    }
    expect(moved).toBeGreaterThan(10);
    // View-side robustness: submits come from live train positions
    // regardless of started-gating mistakes — even a missed trigger_always
    // can never hide the flybys.
    for (const t of ships) t.started = false;
    try {
      expect(driver.extraEntities()!.filter((x) => x.model === boot.models!.ship).length).toBe(ships.length);
    } finally {
      for (const t of ships) t.started = true;
    }
    // …and the Host actually renders them: ship submits reach renderView.
    let rendered: Entity[] = [];
    const orig = boot.refresh.renderView.bind(boot.refresh);
    vi.spyOn(boot.refresh, 'renderView').mockImplementation((view, world, entities) => {
      rendered = [...entities];
      return orig(view, world, entities);
    });
    boot.host.frame(100);
    expect(rendered.some((e) => e.model === boot.models!.ship)).toBe(true);
  });

  it('M7.1 barrels: bases sit on the floor, exactly two near spawn, no doubles', { timeout: 180000 }, async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const { readPakEntry } = await import('./pak.js');
    const { parseMD2 } = await import('@q2/formats');
    const pak = ingestPak(buf);
    const boot = bootPlay({ width: 96, height: 72, pak });
    const { driver } = boot;
    // Pivot audit: the barrel MD2 pivot really is the box bottom — every
    // frame's min-z ≈ 0, so rendering at the lump origin plants the base on
    // the floor with no view-side offset to apply.
    const md2 = parseMD2(readPakEntry(pak, 'models/objects/barrels/tris.md2'));
    expect(md2.numFrames).toBeGreaterThan(0);
    for (let f = 0; f < md2.numFrames; f++) {
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let v = 0; v < md2.numVerts; v++) {
        const z = md2.frames[(f * md2.numVerts + v) * 3 + 2]!;
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
      console.log(`barrel frame ${f}: min-z ${minZ.toFixed(3)} max-z ${maxZ.toFixed(3)}`);
      expect(minZ).toBeCloseTo(0, 0);
    }
    // Exactly two live barrels near spawn at the lump origins.
    const near = driver.barrels.filter(
      (b) => !b.edict.freed && Math.hypot(b.origin[0]! - 128, b.origin[1]! + 320) < 400,
    );
    expect(near.length).toBe(2);
    expect(near.every((b) => !b.isFunc)).toBe(true);
    // Rendered extras mirror the roster 1:1 (no double-submit) at bottom
    // bases: misc origins ARE the floor (z=0). func_explosive NEVER rides
    // the barrel MD2 — the *20 glass window / *30 slab render as grafted
    // brush geometry (DoorSync), so the barrel roster here is explobox-only.
    const extras = driver.extraEntities()!;
    const barrelX = extras.filter((x) => x.model === boot.models!.barrel);
    expect(barrelX.length).toBe(driver.barrels.filter((b) => !b.edict.freed && !b.isFunc).length);
    const keys = barrelX.map((x) => [Math.round(x.origin![0]!), Math.round(x.origin![1]!), Math.round(x.origin![2]!)].join(','));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('136,40,0');
    expect(keys).toContain('184,-24,0');
    for (const b of driver.barrels) {
      if (b.edict.freed || b.isFunc) continue;
      const found = barrelX.find((x) => Math.round(x.origin![0]!) === Math.round(b.origin[0]!) && Math.round(x.origin![1]!) === Math.round(b.origin[1]!));
      expect(found).toBeDefined();
      expect(found!.origin![2]).toBeCloseTo(b.origin[2]!, 1);
      expect(found!.skin).toBe(boot.models!.barrelSkin);
    }
    // func_explosive brushes are DoorSync'd, not MD2-proxied: *20/*30 rest
    // at the closed pose and their faces are in the graft (332 = 232 +
    // 17 + 83), with no barrel MD2 at either brush.
    for (const model of ['*20', '*30']) {
      expect(driver.doorRenderOffset(model)).not.toBeNull();
      expect(driver.graftedFacesSorted().length).toBeGreaterThan(232);
    }
    expect(driver.graftedFaceCount()).toBe(332);
    // Spawn pair bases sit exactly at the floor.
    for (const key of ['136,40,0', '184,-24,0']) {
      const found = barrelX.find((x) => [Math.round(x.origin![0]!), Math.round(x.origin![1]!), Math.round(x.origin![2]!)].join(',') === key)!;
      expect(found).toBeDefined();
      // Floor-resting: the C droptofloor epsilon (1/32) is contact, not float.
      expect(found.origin![2]).toBeCloseTo(0, 1);
    }
  });

  it('M7.1 follow: rendered base1 monster closes on a live player', { timeout: 180000 }, async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const pak = ingestPak(buf);
    const boot = bootPlay({ width: 96, height: 72, pak });
    const { driver } = boot;
    // Phase 0 single sim: the old driver-side chase (no ambush) is gone;
    // ambush soldiers hold stand until eye-to-eye LOS latches `seen` (id
    // visible()), then chase through the server tick. The chase obeys the
    // C cadence (HuntTarget 1s hold, M_CheckAttack chance table): the
    // runner closes from sight-latch range, then PLANTS volleys at melee —
    // M_CheckAttack's MELEE branch commits every frame (no roll, no
    // cooldown), so a soldier with LOS at <80 fires its skin gun instead
    // of walking (soldier melee is NULL in C). Closes-then-engages, the
    // same narrative as the devroom L test, on the real BSP.
    const spawn = v3(128, -320, 32);
    const sim = driver.server.monsters.filter((m) => !m.triggered && m.kind);
    const A = sim.sort(
      (x, y) =>
        Math.hypot(x.edict.origin[0]! - spawn[0]!, x.edict.origin[1]! - spawn[1]!) -
        Math.hypot(y.edict.origin[0]! - spawn[0]!, y.edict.origin[1]! - spawn[1]!),
    )[0]!;
    for (let i = 0; i < 10; i++) driver.step(neutralCmd(), 0.1);
    expect(A.seen).toBe(false);
    driver.pm.origin = v3(440, -500, 100);
    driver.pm.velocity = v3();
    const distNow = (): number =>
      Math.hypot(A.edict.origin[0]! - driver.pm.origin[0]!, A.edict.origin[1]! - driver.pm.origin[1]!, A.edict.origin[2]! - driver.pm.origin[2]!);
    let guard = 0;
    while (!A.seen && guard++ < 40) driver.step(neutralCmd(), 0.1);
    expect(A.seen).toBe(true);
    const dSeen = distNow(); // sight-latch range: the chase starts here
    stepDriver(driver, neutralCmd(), 10); // settle the fall
    const d0 = distNow();
    expect(d0).toBeGreaterThan(60);
    for (let i = 0; i < 60; i++) driver.step(neutralCmd(), 0.1);
    // Engaged at melee: an attack move is playing (attack1 vs attack2 is
    // the C soldier_attack coin flip — accept either) and the volley
    // fired, instead of the body walking past gun range.
    expect(['attack1', 'attack2']).toContain(A.state.move);
    expect(driver.events).toContain('monshot');
    const d1 = distNow();
    // Closed in from the sight latch, then planted at melee range.
    expect(d1).toBeLessThan(dSeen - 20);
    expect(d1).toBeLessThan(80);
    // The authoritative snapshot carries the closed-in origin…
    const snap = driver.snapshot(driver.server.time);
    const sent = snap.entities.find((e) => e.id === A.edict.num)!;
    expect(sent).toBeDefined();
    expect(Math.hypot(sent.origin[0]! - A.edict.origin[0]!, sent.origin[1]! - A.edict.origin[1]!)).toBeLessThan(1);
    // …and the Host submits it to renderView with the live MD2 frame.
    // Warm the snapshot stream first (snapshots ingest on host ticks).
    runFrames(boot.host, 0, 2000);
    let rendered: Entity[] = [];
    const orig = boot.refresh.renderView.bind(boot.refresh);
    vi.spyOn(boot.refresh, 'renderView').mockImplementation((view, world, entities) => {
      rendered = [...entities];
      return orig(view, world, entities);
    });
    boot.host.frame(2100);
    const near = rendered.filter((e) => Math.hypot(e.origin[0]! - A.edict.origin[0]!, e.origin[1]! - A.edict.origin[1]!) < 8);
    expect(near.length).toBeGreaterThan(0);
    const rd = Math.hypot(
      near[0]!.origin[0]! - boot.host.playerOrigin[0]!,
      near[0]!.origin[1]! - boot.host.playerOrigin[1]!,
    );
    expect(rd).toBeLessThan(dSeen - 20);
  });
});

describe.runIf(!!WEB_Q2_PAK)('sweep gameplay: emitted channel names resolve to decodable pak lumps', () => {
  // Feedback item 1: every channel name the driver/server can start must
  // name a real pak lump whose wav header parses (no silent synth fallback).
  // The curated list below is the full emission surface (play.ts emitSound
  // call sites + server st.sounds pushes, C-cited in the sweep changeset);
  // the session tail then asserts the M7.2 bot run's heardSounds all
  // resolve too, so a new emission without a lump fails here.
  const EMITTED = [
    // doors/buttons (C g_func.c SP_func_door/SP_func_button sounds)
    'doors/dr1_strt.wav',
    'doors/dr1_end.wav',
    'switches/butn2.wav',
    // pickups + suit fade (C g_items.c pickup_sound, p_view.c blend)
    'items/pkup.wav',
    'items/airout.wav',
    // weapons (C g_weapon.c fire_* names)
    'weapons/blastf1a.wav',
    'weapons/shotgf1b.wav',
    'weapons/machgf1b.wav',
    'weapons/noammo.wav',
    'weapons/lashit.wav',
    // explosions (C cl_tent.c TE_ paths)
    'world/explod1.wav',
    // gibs (C g_misc.c ThrowGib/ThrowHead over misc/udeath.wav)
    'misc/udeath.wav',
    // secrets + goals (C g_target.c use_target_secret/use_target_goal
    // default noise — counted server-side, single-use)
    'misc/secret.wav',
    // monster fire (C m_soldier.c/m_gunner.c/m_infantry.c sound_* names)
    'soldier/solatck1.wav',
    'soldier/solatck2.wav',
    'soldier/solatck3.wav',
    'gunner/gunatck2.wav',
    'gunner/gunatck3.wav',
    'infantry/infatck1.wav',
    'infantry/melee2.wav',
    // player pain bands + death (C p_view.c P_DamageFeedback, p_client.c
    // player_die — `*` sexed prefix resolved to the default male lumps)
    'player/male/pain25_1.wav',
    'player/male/pain25_2.wav',
    'player/male/pain50_1.wav',
    'player/male/pain50_2.wav',
    'player/male/pain75_1.wav',
    'player/male/pain75_2.wav',
    'player/male/pain100_1.wav',
    'player/male/pain100_2.wav',
    'player/male/death1.wav',
    'player/male/death2.wav',
    'player/male/death3.wav',
    'player/male/death4.wav',
    // drown gurps (C `*gurpN` → S_RegisterSexedSound male fallback)
    'player/male/gurp1.wav',
    'player/male/gurp2.wav',
    // water hooks (C p_view.c P_WorldEffects)
    'player/watr_in.wav',
    'player/watr_out.wav',
    'player/watr_un.wav',
    'player/gasp1.wav',
    'player/gasp2.wav',
    'player/drown1.wav',
    'player/lava_in.wav',
    'player/burn1.wav',
    'player/burn2.wav',
    // suit breath (C P_WorldEffects breather block)
    'player/u_breath1.wav',
    'player/u_breath2.wav',
  ];

  it('every curated emission resolves + decodes', { timeout: 60000 }, async () => {
    const { readFileSync } = await import('fs');
    const { parseWavHeader } = await import('@q2/formats');
    const { ingestPak, findPakSoundEntry, readPakEntry } = await import('./pak.js');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const pak = ingestPak(buf);
    for (const name of EMITTED) {
      const entry = findPakSoundEntry(pak, name);
      expect(entry, name).not.toBeNull();
      const wav = readPakEntry(pak, entry!.name);
      expect(() => parseWavHeader(wav), name).not.toThrow();
      expect(parseWavHeader(wav).rate).toBeGreaterThan(0);
    }
  });

  it('the M7.2 bot session emits nothing outside the resolvable set', { timeout: 180000 }, async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak, findPakSoundEntry } = await import('./pak.js');
    const pak = ingestPak(buf);
    const boot = bootPlay({ width: 96, height: 72, pak });
    expect(boot.source).toBe('pak');
    const { driver } = boot;
    // Damage (pain), shotgun pickup, a kill, exit — the same beats as M7.2.
    driver.damagePlayer(30);
    driver.pm.origin = v3(800, -96, -144);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 5);
    const target = driver.server.monsters.find((m) => m.edict.extra['skinnum'] === '2') ?? driver.server.monsters[0]!;
    for (let i = 0; i < 60 && !target.state.dead; i++) {
      driver.pm.origin = v3(target.edict.origin[0]! + 48, target.edict.origin[1]!, target.edict.origin[2]! + 24);
      driver.pm.velocity = v3();
      const yaw = (Math.atan2(target.edict.origin[1]! - driver.pm.origin[1]!, target.edict.origin[0]! - driver.pm.origin[0]!) * 180) / Math.PI;
      driver.step({ msec: 100, angles: [0, yaw, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_ATTACK }, 0.1);
    }
    expect(driver.heardSounds.length).toBeGreaterThan(0);
    for (const name of new Set(driver.heardSounds)) {
      expect(findPakSoundEntry(pak, name), name).not.toBeNull();
    }
  });
});

describe('sweep gameplay: yaw-lerp between 10Hz ticks (devroom, headless)', () => {
  it('entityAngles walks the short arc monotonically, then converges', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    const m = SV_SpawnMonster(driver.server, 'monster_soldier', v3(0, 0, 24));
    // Tick with the body held at 0: prev snapshot pins 0.
    m.state.yaw = 0;
    driver.step(neutralCmd(), 0.1);
    m.state.yaw = 0;
    driver.step(neutralCmd(), 0.1);
    // Live jumps 0 -> 90 after the tick (as if the tick turned it).
    m.state.yaw = 90;
    const got: number[] = [];
    for (let i = 0; i < 6; i++) got.push(driver.entityAngles(m.edict.num)![1]);
    for (let i = 1; i < got.length; i++) expect(got[i]!).toBeGreaterThan(got[i - 1]!);
    expect(got[0]!).toBeGreaterThan(0);
    expect(got[5]!).toBeCloseTo(90, 9);
    // Wrap: 350 -> 10 steps +20 through 360, never backwards.
    m.state.yaw = 350;
    driver.step(neutralCmd(), 0.1);
    m.state.yaw = 350;
    driver.step(neutralCmd(), 0.1);
    m.state.yaw = 10;
    const wrap: number[] = [];
    for (let i = 0; i < 6; i++) wrap.push(driver.entityAngles(m.edict.num)![1]);
    for (let i = 1; i < wrap.length; i++) expect(wrap[i]!).toBeGreaterThan(wrap[i - 1]!);
    for (const w of wrap) {
      expect(w).toBeGreaterThan(350);
      expect(w).toBeLessThanOrEqual(370);
    }
    expect(((wrap[5]! % 360) + 360) % 360).toBeCloseTo(10, 9);
    // Converged: the next tick pins prev = live, renders hold it exactly.
    driver.step(neutralCmd(), 0.1);
    m.state.yaw = 10;
    expect(driver.entityAngles(m.edict.num)).toEqual([0, 10, 0]);
    expect(driver.entityAngles(999999)).toBeNull();
  });
});

describe.runIf(!!WEB_Q2_PAK)('sweep gameplay: corpse overkill mince (base1, Q2_PAK)', () => {
  it('re-hitting a deadsoldier past -80 minces it: gibs + udeath, corpse persists', { timeout: 180000 }, async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const boot = bootPlay({ width: 96, height: 72, pak: ingestPak(buf) });
    expect(boot.source).toBe('pak');
    const { driver } = boot;
    expect(boot.models!.corpse).toBeGreaterThanOrEqual(0);
    // Pick a corpse with no live monster nearby so the gib attribution
    // below (gibs within 40u of the corpse) is unambiguous.
    const corpses = driver.server.entities.filter((e) => !e.freed && e.classname === 'misc_deadsoldier');
    expect(corpses.length).toBe(12);
    const target = corpses.find(
      (c) =>
        !driver.server.monsters.some(
          (m) =>
            !m.state.gibbed &&
            Math.hypot(m.edict.origin[0]! - c.origin[0]!, m.edict.origin[1]! - c.origin[1]!) < 150,
        ),
    )!;
    expect(target).toBeDefined();
    const gibsNear = (): number =>
      driver.server.gibs.filter(
        (g) => Math.hypot(g.origin[0]! - target!.origin[0]!, g.origin[1]! - target!.origin[1]!) < 40,
      ).length;
    expect(gibsNear()).toBe(0);
    // Park 80u off at corpse height + 24 and drill it with aimed blaster
    // fire (3D aim: pitch positive = down). ~6 connecting bolts (15dmg)
    // cross the C -80 threshold.
    const eye = (): [number, number, number] => [
      driver.pm.origin[0]!,
      driver.pm.origin[1]!,
      driver.pm.origin[2]! + driver.pm.viewheight,
    ];
    const aimAt = (to: [number, number, number]): [number, number, number] => {
      const e = eye();
      const dx = to[0] - e[0];
      const dy = to[1] - e[1];
      const dz = to[2] - e[2];
      return [
        (-Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI,
        (Math.atan2(dy, dx) * 180) / Math.PI,
        0,
      ];
    };
    const heart: [number, number, number] = [target!.origin[0]!, target!.origin[1]!, target!.origin[2]! + 8];
    const side: [number, number, number] = [target!.origin[0]! + 80, target!.origin[1]!, target!.origin[2]! + 24];
    for (let i = 0; i < 120 && gibsNear() < 5; i++) {
      driver.pm.origin = v3(side[0], side[1], side[2]);
      driver.pm.velocity = v3();
      driver.step({ msec: 100, angles: aimAt(heart), forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_ATTACK }, 0.1);
    }
    // Overkill minced: 4x meat + head near the corpse, udeath heard, the
    // driver 'gib' event fired — and C keeps the corpse (no G_FreeEdict):
    // still standing in the roster and in the render extras.
    expect(gibsNear()).toBeGreaterThanOrEqual(5);
    expect(driver.heardSounds).toContain('misc/udeath.wav');
    expect(driver.events).toContain('gib');
    expect(target!.freed).toBe(false);
    expect(target!.health).toBeLessThanOrEqual(-80);
    const rendered = driver.extraEntities()!.filter((x) => x.model === boot.models!.corpse);
    expect(rendered.length).toBe(12);
  });
});
