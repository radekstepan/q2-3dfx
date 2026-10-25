import { describe, expect, it } from 'vitest';
import { keyDown, keyUp } from '@q2/input';
import { bootPlay } from './play.js';

function runFrames(host: { frame(nowMs: number): unknown }, fromMs: number, toMs: number, step = 16): void {
  for (let t = fromMs; t <= toMs; t += step) host.frame(t);
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
});
