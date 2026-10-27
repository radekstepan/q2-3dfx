// M8.1 browser lane: frameAsync is a line-for-line async twin of
// Host.frame + Host.renderCurrentView. These headless pins prove the twin
// stays pixel- and sim-identical on scripted input (devroom, no pak), and
// that the browser pool factory stays null without DOM/SAB/isolation.
import { describe, expect, it } from 'vitest';
import {
  attachBrowserPool,
  bootPlay,
  createAsyncLoopState,
  frameAsync,
} from './play.js';
import { browserPoolAvailable } from './render-workers.js';

function driveBoot(useAsync: boolean) {
  const boot = bootPlay({});
  const st = createAsyncLoopState();
  const step = async (nowMs: number): Promise<void> => {
    if (useAsync) {
      await frameAsync(boot, st, nowMs);
    } else {
      boot.host.frame(nowMs);
    }
  };
  return { boot, step };
}

describe('frameAsync differential (async twin of Host.frame)', () => {
  it('pixels, origin and time match host.frame on scripted input', async () => {
    const a = driveBoot(false);
    const b = driveBoot(true);
    let t = 0;
    for (let f = 0; f < 30; f++) {
      t += 16.7;
      // Identical scripted look input on both boots (yaw sweep).
      const yaw = (f * 7) % 360;
      for (const { boot } of [a, b]) {
        boot.host.input.angles = [0, yaw, 0];
      }
      await a.step(t);
      await b.step(t);
    }
    expect(b.boot.host.serverTime).toBe(a.boot.host.serverTime);
    expect([...b.boot.host.playerOrigin]).toEqual([...a.boot.host.playerOrigin]);
    expect([...b.boot.host.playerVelocity]).toEqual([...a.boot.host.playerVelocity]);
    // Classic path renders into the host framebuffer planes on both.
    expect(b.boot.host.fb.color).toEqual(a.boot.host.fb.color);
    expect(b.boot.host.fb.index!).toEqual(a.boot.host.fb.index!);
  });

  it('movement + ticks stay identical (forward walk over tick boundaries)', async () => {
    const a = driveBoot(false);
    const b = driveBoot(true);
    let t = 0;
    for (let f = 0; f < 60; f++) {
      t += 33.4;
      for (const { boot } of [a, b]) {
        boot.host.input.angles = [0, (f * 3) % 360, 0];
      }
      await a.step(t);
      await b.step(t);
    }
    expect(b.boot.host.serverTime).toBe(a.boot.host.serverTime);
    expect([...b.boot.host.playerOrigin]).toEqual([...a.boot.host.playerOrigin]);
    expect(b.boot.host.fb.color).toEqual(a.boot.host.fb.color);
  });
});

describe('browser pool factory (headless)', () => {
  it('is unavailable without DOM/SAB/isolation', () => {
    expect(browserPoolAvailable()).toBe(false);
  });

  it('attachBrowserPool returns null headless (single-threaded stays)', () => {
    const boot = bootPlay({});
    expect(attachBrowserPool(boot)).toBeNull();
  });
});
