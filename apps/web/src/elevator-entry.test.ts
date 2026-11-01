import { afterEach, describe, expect, it } from 'vitest';
import { resetCVars } from '@q2/config';
import { BUTTON_USE } from '@q2/input';
import { v3 } from '@q2/math';
import { SV_SetPlayerHealth } from '@q2/server';
import { bootPlay, drawHelpOverlay, drawPlayHud } from './play.js';

const pak = process.env.Q2_PAK;
afterEach(() => resetCVars());

describe.runIf(!!pak)('Outer Base elevator entry', () => {
  it('walks aboard and finishes only after using the back button', { timeout: 180000 }, async () => {
    const { readFileSync } = await import('fs');
    const { ingestPak } = await import('./pak.js');
    const raw = readFileSync(pak!);
    const bytes = new Uint8Array(raw).buffer;
    const boot = await bootPlay({ width: 96, height: 72, pak: ingestPak(bytes) });
    const { driver } = boot;
    const plug = driver.server.movers.find(m => m.ent.model === '*31')!;
    const button = driver.server.movers.find(m => m.ent.model === '*34')!;
    const startHeight = plug.ent.origin[2]!;
    driver.pm.origin = v3(-1560, 1536, 150);
    driver.pm.velocity = v3();
    const step = (forwardmove: number, angles: [number, number, number], buttons = 0) => {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step({ msec: 100, angles, forwardmove, sidemove: 0, upmove: 0, buttons }, 0.1);
    };
    for (let i = 0; i < 120 && driver.pm.origin[0]! > -1780; i++) {
      step(200, [0, 180, 0]);
      expect(driver.server.finished).toBe(false);
      expect(plug.ent.origin[2]).toBe(startHeight);
    }
    for (let i = 0; i < 10 && driver.pm.groundEntity !== plug.ent.num; i++) step(0, [0, 180, 0]);
    expect(driver.pm.origin[0]!).toBeLessThan(-1750);
    expect(driver.pm.groundEntity).toBe(plug.ent.num);
    expect(driver.server.finished).toBe(false);
    for (let i = 0; i < 40; i++) step(0, [0, 180, 0]);
    expect(plug.ent.origin[2]).toBe(startHeight);
    expect(driver.server.finished).toBe(false);
    const boardingHeight = driver.pm.origin[2]!;
    const b = driver.server.moverBounds.get(button.ent.num)!;
    const dx = (b.mins[0]! + b.maxs[0]!) / 2 - driver.pm.origin[0]!;
    const dy = (b.mins[1]! + b.maxs[1]!) / 2 - driver.pm.origin[1]!;
    const dz = (b.mins[2]! + b.maxs[2]!) / 2 - (driver.pm.origin[2]! + driver.pm.viewheight);
    const aim: [number, number, number] = [Math.atan2(-dz, Math.hypot(dx, dy)) * 180 / Math.PI, Math.atan2(dy, dx) * 180 / Math.PI, 0];
    expect(Math.hypot(dx, dy, dz)).toBeLessThan(96);
    step(0, aim, BUTTON_USE);
    let sawClosing = false;
    let sawDescent = false;
    for (let i = 0; i < 150 && !driver.server.finished; i++) {
      step(0, aim);
      if (driver.server.exitElevator === 'closing') {
        sawClosing = true;
        expect(plug.ent.origin[2]).toBe(startHeight);
      }
      if (driver.server.exitElevator === 'descending') {
        sawDescent = true;
        const doors = driver.server.movers.filter(m => m.ent.model === '*32' || m.ent.model === '*33');
        expect(doors.every(m => m.state === 'bottom')).toBe(true);
      }
    }
    expect(sawClosing).toBe(true);
    expect(sawDescent).toBe(true);
    expect(plug.ent.origin[2]!).toBeLessThan(startHeight - 100);
    expect(driver.pm.origin[2]!).toBeLessThan(boardingHeight - 100);
    expect(driver.server.finished).toBe(true);
    expect(driver.server.finishReason).toBe('lift');
    expect(driver.events).toContain('finished');
    expect(driver.message).toContain('LEVEL COMPLETE');
    const target = { width: 320, height: 240, color: new Uint32Array(320 * 240) };
    const expected = { width: 320, height: 240, color: new Uint32Array(320 * 240) };
    drawPlayHud(target, boot, { fps: 0, frame: 1 });
    drawHelpOverlay(expected, boot);
    expect(target.color).toEqual(expected.color);
    expect(target.color.some(pixel => pixel !== 0)).toBe(true);
    // With the same counters, completion must not draw extra text over F1.
    driver.server.finished = false;
    const live = { width: 320, height: 240, color: new Uint32Array(320 * 240) };
    drawHelpOverlay(live, boot);
    driver.server.finished = true;
    expect(target.color).toEqual(live.color);
    const endTime = driver.server.time;
    const endPosition = [...driver.pm.origin];
    step(200, aim);
    expect(driver.server.time).toBe(endTime);
    expect([...driver.pm.origin]).toEqual(endPosition);
  });
});
