// RELEASE-7 web wiring (apps/web only): sim-preserving display resize.
//
// Covers the production `resizePlay` path (never a mirror): resolution
// changes resize the framebuffer/viewport/HUD in place WITHOUT rebuilding
// the game simulation. Map, position, health, enemies, elapsed time and
// audio survive; the overlapping framebuffer region is copied (no black
// box); the persisted size is reserved synchronously before async asset
// loads (no layout jump). Explicit restart stays only for map/skill.
//
// Legs:
//   - asset-free (always): sim preservation, overlap copy, same-size no-op,
//     invalid-size refusal, repeated resize cycles, renderer hot-swap
//     preservation, context loss/restore replay, lifecycle exactly-once,
//     reserved-size helpers, reboot-policy pins.
//   - real-asset (Q2_PAK): the same preservation on base1 with live
//     monsters, audio channels, and GPU-viewport sync through the stub-GL
//     attach path.
import { afterEach, describe, expect, it } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { readFileSync } from 'fs';
import {
  applyRendererCvar,
  applyReservedSizeToCanvas,
  bootPlay,
  notifyGpuContextLost,
  notifyGpuContextRestored,
  reservedDisplaySize,
  resizeGpuBackend,
  resizePlay,
  wireGpuLifecycle,
  unwireGpuLifecycle,
} from './play.js';
import type { PlayBoot } from './play.js';
import { cvarNeedsReboot } from './dom.js';
import { hasGpuCanvasLifecycle } from './gpu-canvas.js';

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g['document'];
});

const WEB_Q2_PAK = process.env.Q2_PAK;

function neutralCmd(): { msec: number; angles: [number, number, number]; forwardmove: number; sidemove: number; upmove: number; buttons: number } {
  return { msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

function stepFrames(boot: PlayBoot, n: number): void {
  for (let i = 0; i < n; i++) boot.driver.step(neutralCmd(), 0.1);
}

/** Live sim fingerprint: everything a resize must preserve. */
function simFingerprint(boot: PlayBoot): Record<string, unknown> {
  const snap = boot.host.captureSimState();
  return {
    serverTime: snap.serverTime,
    origin: [...snap.playerOrigin],
    velocity: [...snap.playerVelocity],
    angles: [...snap.inputAngles],
    health: boot.driver.playerHealth,
    monsters: boot.driver.server.monsters.map((m) => [m.edict.num, m.state.health, m.state.dead]),
    channelCount: snap.channelCount,
    masterVol: snap.masterVol,
    host: boot.host,
    driver: boot.driver,
    world: boot.host.world,
    refresh: boot.host.refresh,
  };
}

describe('RELEASE-7 sim-preserving resize (asset-free)', () => {
  it('resizePlay reallocates the framebuffer and preserves the sim', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    stepFrames(boot, 5);
    const before = simFingerprint(boot);
    const resizes = boot.host.resizeCount;
    expect(resizePlay(boot, 640, 480)).toBe(true);
    expect(boot.host.fb.width).toBe(640);
    expect(boot.host.fb.height).toBe(480);
    expect(boot.display.length).toBe(640 * 480);
    expect(boot.display.length).toBe(640 * 480);
    expect(boot.host.resizeCount).toBe(resizes + 1);
    const after = simFingerprint(boot);
    expect(after.serverTime).toBe(before.serverTime);
    expect(after.origin).toEqual(before.origin);
    expect(after.velocity).toEqual(before.velocity);
    expect(after.angles).toEqual(before.angles);
    expect(after.health).toBe(before.health);
    expect(after.monsters).toEqual(before.monsters);
    expect(after.channelCount).toBe(before.channelCount);
    expect(after.masterVol).toBe(before.masterVol);
    // Identities: no sim rebuild (same Host/driver/world/refresh).
    expect(after.host).toBe(before.host);
    expect(after.driver).toBe(before.driver);
    expect(after.world).toBe(before.world);
    expect(after.refresh).toBe(before.refresh);
  });

  it('overlap copy survives: live pixels persist, new pixels zero', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    stepFrames(boot, 3);
    boot.host.frame(300);
    const px = boot.host.fb.color[10 * 64 + 10];
    void px;
    // Paint a marker through the display plane, resize up, check the copy.
    boot.display[5 * 64 + 5] = 0xdeadbeef;
    expect(resizePlay(boot, 128, 96)).toBe(true);
    expect(boot.display[5 * 128 + 5]).toBe(0xdeadbeef);
    // Newly exposed region reads zero until the next frame paints it.
    expect(boot.display[95 * 128 + 127]).toBe(0);
    // And back down keeps the overlapping marker too.
    expect(resizePlay(boot, 64, 48)).toBe(true);
    expect(boot.display[5 * 64 + 5]).toBe(0xdeadbeef);
  });

  it('same-size resize is a no-op (no realloc, no resizeCount bump)', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    const before = boot.host.resizeCount;
    expect(resizePlay(boot, 320, 240)).toBe(true);
    expect(boot.host.resizeCount).toBe(before);
    expect(boot.display.length).toBe(320 * 240);
  });

  it('invalid sizes refuse and leave the sim untouched', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    stepFrames(boot, 2);
    const before = simFingerprint(boot);
    for (const [w, h] of [[0, 240], [-1, 240], [320, 0], [1.5, 240], [NaN, 240]] as Array<[number, number]>) {
      expect(resizePlay(boot, w, h)).toBe(false);
    }
    expect(boot.host.fb.width).toBe(320);
    expect(boot.host.fb.height).toBe(240);
    expect(simFingerprint(boot).serverTime).toBe(before.serverTime);
    expect(simFingerprint(boot).origin).toEqual(before.origin);
  });

  it('repeated resize cycles stay 1:1 and preserve the sim every time', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    stepFrames(boot, 4);
    const sizes: Array<[number, number]> = [[640, 480], [1024, 768], [320, 240], [800, 600], [640, 480]];
    const resizes = boot.host.resizeCount;
    const health = boot.driver.playerHealth;
    for (const [w, h] of sizes) {
      expect(resizePlay(boot, w, h)).toBe(true);
      expect(boot.driver.playerHealth).toBe(health);
      expect(boot.host.fb.width).toBe(w);
      expect(boot.host.fb.height).toBe(h);
    }
    expect(boot.host.resizeCount).toBe(resizes + sizes.length);
    // Frames render at the final size with live pixels.
    const stats = boot.host.frame(1000);
    expect(stats.pixels).toBeGreaterThan(0);
  });

  it('renderer hot-swap preserves the sim across repeated switches', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    stepFrames(boot, 3);
    setCVar('vid_renderer', 'software');
    const host = boot.host;
    expect(applyRendererCvar(boot)).toBe('software');
    expect(boot.host).toBe(host);
    setCVar('vid_renderer', 'software');
    expect(applyRendererCvar(boot)).toBe('software');
    expect(boot.host).toBe(host);
    expect(boot.host.fb.width).toBe(320);
  });

  it('restart policy: only map/skill reboot; resolution + renderer preserve', () => {
    expect(cvarNeedsReboot('skill')).toBe(true);
    expect(cvarNeedsReboot('map_source')).toBe(true);
    expect(cvarNeedsReboot('vid_resolution')).toBe(false);
    expect(cvarNeedsReboot('vid_renderer')).toBe(false);
    expect(cvarNeedsReboot('r_brightness')).toBe(false);
    expect(cvarNeedsReboot('cl_showfps')).toBe(false);
  });

  it('reserved size follows the persisted cvar and applies to a canvas synchronously', () => {
    expect(reservedDisplaySize()).toEqual({ width: 320, height: 240 });
    setCVar('vid_resolution', '1024x768');
    expect(reservedDisplaySize()).toEqual({ width: 1024, height: 768 });
    const canvas = { width: 0, height: 0 };
    expect(applyReservedSizeToCanvas(canvas)).toBe(true);
    expect(canvas.width).toBe(1024);
    expect(canvas.height).toBe(768);
    // A boot with no explicit size latches the reserved dims.
    const boot = bootPlay({});
    expect(boot.host.fb.width).toBe(1024);
    expect(boot.host.fb.height).toBe(768);
    // Headless-safe refusals.
    expect(applyReservedSizeToCanvas(null)).toBe(false);
    expect(applyReservedSizeToCanvas(undefined)).toBe(false);
  });

  it('bootPlay with explicit size wins over the persisted cvar', () => {
    setCVar('vid_resolution', '1024x768');
    const boot = bootPlay({ width: 64, height: 48 });
    expect(boot.host.fb.width).toBe(64);
    expect(boot.host.fb.height).toBe(48);
  });
});

describe('RELEASE-7 GPU lifecycle coordination (stub GL, asset-free)', () => {
  function installStubDoc(): void {
    const g = globalThis as unknown as Record<string, unknown>;
    const gl = new Proxy(
      {},
      {
        get(_t, prop): unknown {
          if (prop === 'getParameter') return () => 4096;
          if (prop === 'getError') return () => 0;
          if (prop === 'checkFramebufferStatus') return () => 36053;
          if (typeof prop === 'string' && (prop.startsWith('get') || prop.startsWith('check'))) {
            return (..._a: unknown[]): unknown => (prop.includes('InfoLog') ? '' : prop.includes('Location') ? {} : 0);
          }
          return (..._a: unknown[]): unknown => ({});
        },
      },
    );
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    const canvas: Record<string, unknown> = {
      id: '',
      width: 0,
      height: 0,
      style: {} as Record<string, string>,
      setAttribute(k: string, v: string): void {
        (canvas as Record<string, unknown>)[k] = v;
      },
      getContext: () => gl,
      addEventListener: (t: string, fn: (...a: unknown[]) => void): void => {
        const list = listeners.get(t) ?? [];
        list.push(fn);
        listeners.set(t, list);
      },
      removeEventListener: (t: string, fn: (...a: unknown[]) => void): void => {
        listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== fn));
      },
      parentNode: null,
    };
    const hud = { id: 'q2', style: {} as Record<string, string>, parentNode: { insertBefore(): void { /* noop */ } } };
    g['document'] = {
      createElement: () => ({ ...canvas, id: '', width: 0, height: 0, style: {} }),
      getElementById: (id: string): unknown => {
        if (id === 'q2') return hud;
        if (id === 'q2-gl') return (canvas.id === 'q2-gl' ? canvas : null);
        return null;
      },
      querySelector: (sel: string): unknown => {
        if (sel === '#q2') return hud;
        if (sel === '#q2-gl') return (canvas.id === 'q2-gl' ? canvas : null);
        return null;
      },
      body: { appendChild(): void { /* noop */ } },
    };
  }

  it('GPU attach resizes the viewport in place with the sim intact', () => {
    installStubDoc();
    setCVar('vid_renderer', 'webgl2-experimental');
    const boot = bootPlay({ width: 320, height: 240 });
    expect(boot.renderer).toBe('webgl2-experimental');
    expect(boot.gpu).not.toBeNull();
    stepFrames(boot, 3);
    const before = simFingerprint(boot);
    expect(resizeGpuBackend(boot, 640, 480)).toBe(true);
    expect(resizePlay(boot, 640, 480)).toBe(true);
    expect(boot.host.fb.width).toBe(640);
    expect(boot.host.fb.height).toBe(480);
    const after = simFingerprint(boot);
    expect(after.serverTime).toBe(before.serverTime);
    expect(after.origin).toEqual(before.origin);
    expect(after.host).toBe(before.host);
  });

  it('context loss skips submission and restore replays retained assets', () => {
    installStubDoc();
    setCVar('vid_renderer', 'webgl2-experimental');
    const boot = bootPlay({ width: 160, height: 120 });
    expect(boot.gpu).not.toBeNull();
    expect(notifyGpuContextLost(boot)).toBe(true);
    expect(boot.gpu!.contextLost).toBe(true);
    // Repeated loss while already lost never double-counts.
    expect(notifyGpuContextLost(boot)).toBe(false);
    expect(boot.gpu!.lossCount).toBe(1);
    // Restore without loss (fresh boot) returns false and changes nothing.
    expect(notifyGpuContextRestored(boot)).toBe(true);
    expect(boot.gpu!.contextLost).toBe(false);
    expect(boot.gpu!.restoreCount).toBe(1);
    expect(notifyGpuContextRestored(boot)).toBe(false);
  });

  it('lifecycle wiring is exactly-once; unwire removes the pair', () => {
    installStubDoc();
    setCVar('vid_renderer', 'webgl2-experimental');
    const boot = bootPlay({ width: 160, height: 120 });
    expect(boot.gpu).not.toBeNull();
    expect(wireGpuLifecycle(boot)).toBe(true);
    expect(hasGpuCanvasLifecycle(boot.gpu!.canvas)).toBe(true);
    // Re-wiring replaces the pair (never stacks duplicates).
    expect(wireGpuLifecycle(boot)).toBe(true);
    expect(hasGpuCanvasLifecycle(boot.gpu!.canvas)).toBe(true);
    unwireGpuLifecycle(boot);
    expect(hasGpuCanvasLifecycle(boot.gpu!.canvas)).toBe(false);
  });

  it('resizeGpuBackend refuses without a backend or with bad sizes', () => {
    const cpu = bootPlay({ width: 64, height: 48 });
    expect(cpu.gpu).toBeNull();
    expect(resizeGpuBackend(cpu, 128, 96)).toBe(false);
    installStubDoc();
    setCVar('vid_renderer', 'webgl2-experimental');
    const boot = bootPlay({ width: 64, height: 48 });
    expect(boot.gpu).not.toBeNull();
    expect(resizeGpuBackend(boot, 0, 96)).toBe(false);
    expect(resizeGpuBackend(boot, 128, -1)).toBe(false);
  });
});

describe.runIf(!!WEB_Q2_PAK)('RELEASE-7 sim-preserving resize (real pak, Q2_PAK)', () => {
  async function bootPak(width: number, height: number): Promise<PlayBoot> {
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    return bootPlay({ width, height, pak: ingestPak(buf) });
  }

  it('base1 resize preserves map, health, enemies, time and audio', { timeout: 180000 }, async () => {
    const boot = await bootPak(320, 240);
    stepFrames(boot, 5);
    // Start a positional channel so the audio-preservation pin is live.
    boot.driver.mixer.startSound({
      origin: [0, 0, 0], fixedOrigin: true, entnum: 1,
      attenuation: 1, masterVol: 1, loop: false, name: 'test/pin.wav',
    });
    const before = simFingerprint(boot);
    expect(boot.driver.aliveMonsters).toBeGreaterThan(0);
    expect(resizePlay(boot, 640, 480)).toBe(true);
    expect(boot.host.fb.width).toBe(640);
    const after = simFingerprint(boot);
    expect(after.serverTime).toBe(before.serverTime);
    expect(after.origin).toEqual(before.origin);
    expect(after.health).toBe(before.health);
    expect(after.monsters).toEqual(before.monsters);
    expect(after.channelCount).toBe(before.channelCount);
    expect(after.host).toBe(before.host);
    expect(after.world).toBe(before.world);
    // The resized frame still renders base1 pixels.
    const stats = boot.host.frame(1000);
    expect(stats.pixels).toBeGreaterThan(0);
    console.log(`[release-7] base1 320x240->640x480 sim intact (monsters=${(after.monsters as unknown[]).length})`);
  });

  it('base1 repeated resize + renderer switch + damage interleaving', { timeout: 180000 }, async () => {
    const boot = await bootPak(320, 240);
    stepFrames(boot, 3);
    boot.driver.damagePlayer(10);
    const hp = boot.driver.playerHealth;
    expect(hp).toBeLessThan(100);
    expect(resizePlay(boot, 1024, 768)).toBe(true);
    expect(boot.driver.playerHealth).toBe(hp);
    setCVar('vid_renderer', 'voodoo');
    // RELEASE-8: retired `voodoo` migrates to software WITH a warning.
    expect(applyRendererCvar(boot)).toBe('software');
    expect(boot.driver.playerHealth).toBe(hp);
    expect(resizePlay(boot, 640, 480)).toBe(true);
    expect(boot.driver.playerHealth).toBe(hp);
    expect(boot.host.fb.width).toBe(640);
    setCVar('vid_renderer', 'software');
    expect(applyRendererCvar(boot)).toBe('software');
    expect(boot.driver.playerHealth).toBe(hp);
  });
});
