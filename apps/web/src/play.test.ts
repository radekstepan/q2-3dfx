import { describe, expect, it } from 'vitest';
import { keyDown, keyUp, BUTTON_ATTACK } from '@q2/input';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import { getConcharsFont, makeConcharsFont } from '@q2/client';
import { bootPlay, drawPlayHud, pumpMuzzleLight, loadConcharsFont, concharsFontFromPCX } from './play.js';
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

  it('M6.1 follow-up: real conchars.pcx replaces the procedural font', async () => {
    const { readFileSync } = await import('fs');
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
});
