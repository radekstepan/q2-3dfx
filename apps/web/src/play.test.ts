import { describe, expect, it, vi } from 'vitest';
import { keyDown, keyUp, BUTTON_ATTACK } from '@q2/input';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import type { Entity } from '@q2/renderer-api';
import { getConcharsFont, makeConcharsFont } from '@q2/client';
import { bootPlay, drawPlayHud, pumpMuzzleLight, pumpExplosionLights, pumpTracers, loadConcharsFont, concharsFontFromPCX, VIEWMODEL_FIRE_FRAME, usesViewModel3D } from './play.js';
import { findWeapon, spawnMonster, BOLT_LIFE } from '@q2/game';
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
    driver.monsters.push({ id: 99, origin: [100, 0, 32], state: spawnMonster('soldier'), lastAttack: -10 });
    const m = driver.monsters[0]!;
    m.state.move = 'run';
    m.state.frame = 0;
    const x0 = m.origin[0]!;
    stepDriver(driver, neutralCmd(), 5);
    // monsterThink advanced the state machine...
    expect(m.state.frame).toBeGreaterThan(0);
    expect(m.state.move).toBe('run');
    // ...the move table maps to a nonzero MD2 frame (run first=99)...
    expect(driver.entityFrame(99)).toBe(99 + m.state.frame);
    expect(driver.entityFrame(99)).toBeGreaterThan(0);
    // ...the monster walked toward the player (west spawn is at -168)...
    expect(m.origin[0]!).toBeLessThan(x0);
    // ...it stays in the authoritative snapshot...
    expect(driver.snapshot(driver.server.time).entities.some((e) => e.id === 99)).toBe(true);
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
    const byOrigin = rendered.filter((e) => Math.abs(e.origin[0]! - m.origin[0]!) < 3);
    expect(byOrigin.length).toBe(1);
    expect(byOrigin[0]!.frame).toBe(driver.entityFrame(99));
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

  it('F: TE_BLASTER impact flash is brief (~0.1s), never a stuck light', () => {
    const boot = bootPlay({ width: 64, height: 48 });
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
    expect(mixedPain.some((c) => c.name === 'player/pain.wav' && c.left === 1)).toBe(true);
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
    expect(mixedPickup).toContain('items/pickup.wav');
    // 3. Monster kill: stand next to a soldier in its own cell (same room,
    //    clear line of sight), aim dead-on, fire the blaster until it dies.
    //    The soldier melees back every ~1s, proving fight-back damage.
    const target = driver.monsters[0]!;
    let killed = false;
    for (const [ox, oy] of [[48, 0], [-48, 0], [0, 48], [0, -48]] as const) {
      if (target.state.dead) {
        killed = true;
        break;
      }
      driver.pm.origin = v3(target.origin[0]! + ox, target.origin[1]! + oy, target.origin[2]! + 24);
      driver.pm.velocity = v3();
      const yaw = (Math.atan2(target.origin[1]! - driver.pm.origin[1]!, target.origin[0]! - driver.pm.origin[0]!) * 180) / Math.PI;
      const atk: UserCmdT = { msec: 100, angles: [0, yaw, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_ATTACK };
      for (let i = 0; i < 60 && !target.state.dead; i++) driver.step(atk, 0.1);
      if (target.state.dead) killed = true;
    }
    expect(killed).toBe(true);
    expect(driver.events).toContain('kill');
    // Dead monsters are removed from the snapshot (no longer rendered).
    expect(driver.snapshot(driver.server.time).entities.some((e) => e.id === target.id)).toBe(false);
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
    const m0 = driver.monsters[0]!;
    expect(driver.entityFrame(m0.id)).toBeGreaterThan(0);
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
    expect(near.map((b) => [...b.origin])).toContainEqual([136, 40, 0]);
    expect(near.map((b) => [...b.origin])).toContainEqual([184, -24, 0]);
    // Snapshot stays player + monsters; live barrels ride the Host
    // extraEntities hook with their own barrel MD2 handles (appended after
    // the bolt so every pre-existing handle is stable).
    const snap = driver.snapshot(driver.server.time);
    expect(snap.entities.every((e) => e.id === 1 || driver.monsters.some((m) => m.id === e.id))).toBe(true);
    const extras = driver.extraEntities();
    expect(extras).not.toBeNull();
    expect(extras!.length).toBe(driver.barrels.length);
    expect(extras!.map((x) => [...x.origin])).toContainEqual([136, 40, 0]);
    expect(extras!.map((x) => [...x.origin])).toContainEqual([184, -24, 0]);
    for (const x of extras!) {
      expect(x.model).toBe(boot.models!.barrel);
      expect(x.skin).toBe(boot.models!.barrelSkin);
    }
    // Snapshot pairing hooks: soldier resolves to its own handles, unknown
    // ids to null (Host default), monster facing stays legacy [0,0,0].
    const m0 = driver.monsters[0]!;
    expect(driver.entityModel(m0.id)).toEqual({ model: boot.models!.monster, skin: boot.models!.monsterSkin });
    expect(driver.entityModel(999999)).toBeNull();
    expect(driver.entityAngles(m0.id)).toBeNull();
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
    expect(withBolt.length).toBe(driver.barrels.length + 1);
    const boltX = withBolt[withBolt.length - 1]!;
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
});
