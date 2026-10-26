import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import type { UserCmdT } from '@q2/input';
import {
  bootPlay,
  rebootPlay,
  getResolution,
  parseResolution,
  RESOLUTION_OPTIONS,
  RESOLUTION_DEFAULT,
} from './play.js';
import {
  cvarNeedsReboot,
  cvarOptions,
  cvarOptionLabels,
  RESOLUTION_LABELS,
} from './dom.js';

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

afterEach(() => {
  resetCVars();
});

describe('menu reboot: skill + resolution (headless)', () => {
  it('skill and vid_resolution reboot; nothing else does', () => {
    expect(cvarNeedsReboot('skill')).toBe(true);
    expect(cvarNeedsReboot('vid_resolution')).toBe(true);
    expect(cvarNeedsReboot('vid_renderer')).toBe(false);
    expect(cvarNeedsReboot('r_brightness')).toBe(false);
    expect(cvarNeedsReboot('cl_showfps')).toBe(false);
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

  it('bootPlay defaults to the menu resolution; rebootPlay resizes the framebuffer', () => {
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
    // Reboot keeps the size while the cvar is unchanged…
    const c = rebootPlay(b);
    expect(c.host.fb.width).toBe(640);
    expect(c.host.fb.height).toBe(480);
    // …and resizing the dropdown then rebooting resizes the framebuffer.
    setCVar('vid_resolution', '1024x768');
    const d = rebootPlay(c);
    expect(d.host.fb.width).toBe(1024);
    expect(d.host.fb.height).toBe(768);
    expect(d.display.length).toBe(1024 * 768);
    expect(d.fb565.length).toBe(1024 * 768);
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
});
