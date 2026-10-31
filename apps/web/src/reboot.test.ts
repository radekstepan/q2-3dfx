import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import type { UserCmdT } from '@q2/input';
import {
  bootPlay,
  rebootPlay,
  applyRendererCvar,
  getResolution,
  parseResolution,
  resizePlay,
  reservedDisplaySize,
  applyReservedSizeToCanvas,
  getMapSource,
  availableMapSources,
  MAP_SOURCE_DEFAULT,
  MAP_SOURCE_DEVROOM,
  MAP_SOURCE_PAK,
  RESOLUTION_OPTIONS,
  RESOLUTION_DEFAULT,
} from './play.js';
import {
  cvarNeedsReboot,
  cvarOptions,
  cvarControlKind,
  cvarOptionLabels,
  setMapSourceHasPak,
  getMapSourceHasPak,
  MAP_SOURCE_LABELS,
  RESOLUTION_LABELS,
} from './dom.js';

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

afterEach(() => {
  resetCVars();
  setMapSourceHasPak(false);
});

describe('menu reboot: skill + resolution (headless)', () => {
  it('skill and map_source reboot; renderer and resolution preserve sim in place', () => {
    expect(cvarNeedsReboot('skill')).toBe(true);
    expect(cvarNeedsReboot('map_source')).toBe(true);
    // RELEASE-7: vid_resolution resizes in place (resizePlay, no sim rebuild)
    // instead of rebooting — Host/LocalDriver/server state survives.
    expect(cvarNeedsReboot('vid_resolution')).toBe(false);
    // vid_renderer hot-swaps in place (no reboot): the resolve path reads
    // the cvar every frame, so Host/LocalDriver/server state survives.
    expect(cvarNeedsReboot('vid_renderer')).toBe(false);
    expect(cvarNeedsReboot('r_brightness')).toBe(false);
    expect(cvarNeedsReboot('cl_showfps')).toBe(false);
  });

  it('vid_renderer hot-swaps in place: no reboot, state preserved', () => {
    setCVar('vid_renderer', 'software');
    const b = bootPlay({});
    expect(b.renderer).toBe('software');
    // Walk a frame so there is live sim state to preserve.
    b.host.frame(100);
    const px = [...b.host.playerOrigin];
    const hp = b.driver.playerHealth;
    const hostRef = b.host;
    const driverRef = b.driver;
    // "Change the dropdown": re-latch only, no boot rebuild.
    // RELEASE-8: the retired `voodoo` id migrates to `software` WITH a
    // warning (never auto-promoted to webgl2-experimental).
    setCVar('vid_renderer', 'voodoo');
    expect(cvarNeedsReboot('vid_renderer')).toBe(false);
    expect(applyRendererCvar(b)).toBe('software');
    expect(b.renderer).toBe('software');
    expect(b.lastRendererWarning).not.toBeNull();
    expect(b.lastRendererWarning).toContain('voodoo');
    expect(b.host).toBe(hostRef);
    expect(b.driver).toBe(driverRef);
    expect([...b.host.playerOrigin]).toEqual(px);
    expect(b.driver.playerHealth).toBe(hp);
    // And back: resolveDisplay follows the cvar live either way.
    setCVar('vid_renderer', 'software');
    expect(applyRendererCvar(b)).toBe('software');
    expect(b.renderer).toBe('software');
    expect(b.host).toBe(hostRef);
  });

  it('bootPlay honors the persisted vid_renderer cvar; rebootPlay keeps it', () => {
    setCVar('vid_renderer', 'webgl2-experimental');
    const b = bootPlay({});
    // Incapable headless boot falls back to software WITH a warning.
    expect(b.renderer).toBe('software');
    expect(b.lastRendererWarning).not.toBeNull();
    const c = rebootPlay(b);
    expect(c.renderer).toBe('software');
    setCVar('vid_renderer', 'software');
    expect(rebootPlay(c).renderer).toBe('software');
  });

  it('persisted cvars are a headless no-op (no DOM in tests)', async () => {
    const dom = await import('./dom.js');
    expect(() => dom.savePersistedCVars()).not.toThrow();
    expect(() => dom.restorePersistedCVars()).not.toThrow();
  });

  it('resolution domain is the four sizes with × labels', () => {
    expect([...RESOLUTION_OPTIONS]).toEqual(['320x240', '640x480', '800x600', '1024x768']);
    expect(cvarOptions('vid_resolution')).toEqual(['320x240', '640x480', '800x600', '1024x768']);
    expect(cvarOptionLabels('vid_resolution')).toEqual(['320×240', '640×480', '800×600', '1024×768']);
    expect([...RESOLUTION_LABELS]).toEqual(['320×240', '640×480', '800×600', '1024×768']);
    expect(RESOLUTION_DEFAULT).toBe('320x240');
  });

  it('parseResolution maps all four, rejects garbage', () => {
    expect(parseResolution('320x240')).toEqual({ width: 320, height: 240 });
    expect(parseResolution('640x480')).toEqual({ width: 640, height: 480 });
    expect(parseResolution('800x600')).toEqual({ width: 800, height: 600 });
    expect(parseResolution('1024x768')).toEqual({ width: 1024, height: 768 });
    expect(parseResolution(' 640x480 ')).toEqual({ width: 640, height: 480 });
    expect(parseResolution('bogus')).toBeNull();
    expect(parseResolution('640')).toBeNull();
    expect(parseResolution('0x480')).toBeNull();
    expect(parseResolution('-1x480')).toBeNull();
    expect(parseResolution('')).toBeNull();
  });

  it('getResolution defaults to 320x240 and follows the persisted cvar', () => {
    expect(getResolution()).toEqual({ width: 320, height: 240 });
    setCVar('vid_resolution', '640x480');
    expect(getResolution()).toEqual({ width: 640, height: 480 });
    setCVar('vid_resolution', 'bogus');
    expect(getResolution()).toEqual({ width: 320, height: 240 });
  });

  it('bootPlay defaults to the menu resolution; rebootPlay keeps live size, resizePlay resizes in place', () => {
    // Untouched cvar: the classic 320x240 internal buffer.
    const a = bootPlay({ width: 64, height: 48 });
    expect(a.host.fb.width).toBe(64);
    expect(a.host.fb.height).toBe(48);
    // No explicit size: the menu resolution cvar decides.
    setCVar('vid_resolution', '640x480');
    const b = bootPlay({});
    expect(b.host.fb.width).toBe(640);
    expect(b.host.fb.height).toBe(480);
    expect(b.display.length).toBe(640 * 480);
    // Reboot keeps the LIVE size while the cvar is unchanged…
    const c = rebootPlay(b);
    expect(c.host.fb.width).toBe(640);
    expect(c.host.fb.height).toBe(480);
    // …and changing the dropdown then rebooting still keeps the live size
    // (RELEASE-7: resolution no longer reboots — it resizes in place).
    setCVar('vid_resolution', '1024x768');
    const d = rebootPlay(c);
    expect(d.host.fb.width).toBe(640);
    expect(d.host.fb.height).toBe(480);
    // The menu resize path is resizePlay: same boot, new framebuffer, sim kept.
    expect(resizePlay(d, 1024, 768)).toBe(true);
    expect(d.host.fb.width).toBe(1024);
    expect(d.host.fb.height).toBe(768);
    expect(d.display.length).toBe(1024 * 768);
    expect(d.display.length).toBe(1024 * 768);
    void neutralCmd;
  });

  it('rebootPlay preserves pak + renderer while re-latching skill', () => {
    setCVar('vid_resolution', '800x600');
    const a = bootPlay({ pak: null });
    expect(a.source).toBe('devroom');
    expect(a.renderer).toBe('software');
    const b = rebootPlay(a);
    expect(b.source).toBe('devroom');
    expect(b.renderer).toBe(a.renderer);
    expect(b.pak).toBeNull();
    expect(b.host.fb.width).toBe(800);
    const frames = b.host.frame(100);
    expect(frames.pixels).toBeGreaterThan(0);
  });

  it('map_source defaults to pak, clamps, and persists via setCVar', () => {
    expect(MAP_SOURCE_DEFAULT).toBe('pak');
    expect(MAP_SOURCE_DEVROOM).toBe('devroom');
    expect(MAP_SOURCE_PAK).toBe('pak');
    expect(getMapSource()).toBe('pak');
    setCVar('map_source', 'devroom');
    expect(getMapSource()).toBe('devroom');
    setCVar('map_source', 'pak');
    expect(getMapSource()).toBe('pak');
    // Garbage latches back to the pak default (graceful: no pak → devroom).
    setCVar('map_source', 'bogus');
    expect(getMapSource()).toBe('pak');
  });

  it('availableMapSources lists devroom always, pak only after a drop', () => {
    expect(availableMapSources(false)).toEqual(['devroom']);
    expect(availableMapSources(true)).toEqual(['devroom', 'pak']);
  });

  it('map_source dropdown is a labeled select gated on pak availability', () => {
    expect(cvarControlKind('map_source')).toBe('select');
    expect(getMapSourceHasPak()).toBe(false);
    // No pak cached: only devroom is listed.
    expect(cvarOptions('map_source')).toEqual(['devroom']);
    expect(cvarOptionLabels('map_source')).toEqual([...MAP_SOURCE_LABELS]);
    expect(MAP_SOURCE_LABELS).toEqual(['Built-in devroom (demomap)', 'Cached pak0.pak (game)']);
    // After a drop the pak appears; clearing hides it again.
    setMapSourceHasPak(true);
    expect(getMapSourceHasPak()).toBe(true);
    expect(cvarOptions('map_source')).toEqual(['devroom', 'pak']);
    expect(cvarOptionLabels('map_source')).toEqual([...MAP_SOURCE_LABELS]);
    setMapSourceHasPak(false);
    expect(cvarOptions('map_source')).toEqual(['devroom']);
  });

  it('rebootPlay honors map_source: devroom selection drops the pak', () => {
    // Headless, no pak: both selections boot devroom (pak request with no
    // pak degrades gracefully instead of throwing).
    const a = bootPlay({ pak: null });
    expect(a.source).toBe('devroom');
    setCVar('map_source', 'devroom');
    const b = rebootPlay(a);
    expect(b.source).toBe('devroom');
    expect(b.pak).toBeNull();
    setCVar('map_source', 'pak');
    const c = rebootPlay(b);
    expect(c.source).toBe('devroom');
    expect(c.pak).toBeNull();
  });
});

const WEB_Q2_PAK = process.env.Q2_PAK;

describe.runIf(!!WEB_Q2_PAK)('menu reboot on base1 (real pak, Q2_PAK)', () => {
  async function bootPak() {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    return bootPlay({ width: 96, height: 72, pak: ingestPak(buf) });
  }

  function infantryCount(boot: { driver: { server: { entities: { classname: string }[] } } }): number {
    return boot.driver.server.entities.filter((e) => e.classname === 'monster_infantry').length;
  }

  it('changing skill then rebooting re-filters the roster (applies at once)', { timeout: 180000 }, async () => {
    setCVar('skill', 0);
    const easy = await bootPak();
    expect(easy.driver.server.skill).toBe(0);
    expect(infantryCount(easy)).toBe(3);
    // "Change the dropdown": the menu sets the cvar and re-calls the boot
    // path (rebootPlay), so the new skill applies to this level immediately
    // instead of waiting for the next map.
    setCVar('skill', 2);
    const hard = rebootPlay(easy);
    expect(hard.pak).not.toBeNull();
    expect(hard.driver.server.skill).toBe(2);
    expect(infantryCount(hard)).toBe(5);
    // And back down: the roster re-filters the other way too.
    setCVar('skill', 1);
    const med = rebootPlay(hard);
    expect(med.driver.server.skill).toBe(1);
    expect(infantryCount(med)).toBe(3);
  });

  it('map_source dropdown reboots between game and devroom (fresh reboot)', { timeout: 180000 }, async () => {
    const game = await bootPak();
    expect(game.source).toBe('pak');
    expect(game.pak).not.toBeNull();
    // Default selection is the pak: a plain reboot keeps the game map.
    expect(getMapSource()).toBe('pak');
    const kept = rebootPlay(game);
    expect(kept.source).toBe('pak');
    expect(kept.pak).not.toBeNull();
    // "Change the dropdown" to devroom: fresh reboot of the demomap even
    // with the pak cached (prev.pak is dropped, like the boot path).
    setCVar('map_source', 'devroom');
    const demo = rebootPlay(game);
    expect(demo.source).toBe('devroom');
    expect(demo.pak).toBeNull();
    expect(demo.driver.server.monsters.length).toBe(0);
    const stats = demo.host.frame(100);
    expect(stats.pixels).toBeGreaterThan(0);
  });
});
