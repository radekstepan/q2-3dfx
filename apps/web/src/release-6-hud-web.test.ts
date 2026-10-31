// RELEASE-6 web wiring (apps/web only): asset-based statusbar/F1/completion.
//
// Covers the production `drawPlayHud` path (never mirrors): the retail
// `single_statusbar` script executes through `executeStatusbar` with real
// `pics/*.pcx` art via `drawPic`/`drawField`/`drawString`, F1 renders
// `buildHelpLayout` over the `help` background, completion renders through
// `centerPrintPlacement`. Devroom keeps the readable text fallback; the
// optional `cl_showfps`/`cl_showpos` diagnostics stay separate top-row
// readouts and never enter the statusbar program.
//
// Legs:
//   - asset-free (always): devroom fallback readable, help overlay without
//     pak, completion + death placement, fps/pos separation, no-throw guards.
//   - real-asset (Q2_PAK): boot base1 at 640x480 and 1024x768, verify real
//     digit/icon art, values, transparency (cutout digits leave the
//     background untouched), scaling (xv/yv remap), death + completion,
//     F1 background + rows, and the fps/pos negative control.
import { afterEach, describe, expect, it } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { readFileSync } from 'fs';
import {
  bootPlay,
  buildHudPicCache,
  drawPlayHud,
  drawStatusbarCmds,
  RETAIL_SINGLE_STATUSBAR,
  statusbarStateFor,
  toggleHelpOverlay,
  FINISH_BLUE,
  FPS_GREEN,
  POS_GREY,
} from './play.js';
import type { PlayBoot } from './play.js';
import {
  buildHelpLayout,
  centerPrintPlacement,
  executeStatusbar,
  parseStatusbar,
} from '@q2/client';

afterEach(() => {
  resetCVars();
});

const WEB_Q2_PAK = process.env.Q2_PAK;

async function bootPak(width: number, height: number): Promise<PlayBoot> {
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  const pak = ingestPak(buf);
  const boot = bootPlay({ width, height, pak });
  expect(boot.source).toBe('pak');
  return boot;
}

function blank(w: number, h: number): { width: number; height: number; color: Uint32Array } {
  return { width: w, height: h, color: new Uint32Array(w * h) };
}

/** Count pixels in a rect that differ from the given background. */
function paintedIn(
  target: { width: number; height: number; color: Uint32Array },
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  bg = 0,
): number {
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(target.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(target.width, x1); x++) {
      if (target.color[y * target.width + x] !== bg) n++;
    }
  }
  return n;
}

describe('RELEASE-6 web HUD (asset-free)', () => {
  it('devroom fallback: readable text, no throw, no asset cache', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    expect(boot.source).toBe('devroom');
    expect(boot.hudPics).toBeNull();
    expect(boot.palette).not.toBeNull();
    const target = blank(320, 240);
    expect(() => drawPlayHud(target, boot, { fps: 60, frame: 1 })).not.toThrow();
    // Text fallback rows are painted (hp + weapon + devroom hint).
    expect(target.color.some((c) => c === 0xffffffff)).toBe(true);
    expect(paintedIn(target, 0, 20, 320, 40)).toBeGreaterThan(0);
  });

  it('fps/pos diagnostics stay separate from the bottom statusbar', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    setCVar('cl_showfps', 0);
    setCVar('cl_showpos', 0);
    const target = blank(320, 240);
    drawPlayHud(target, boot, { fps: 60, frame: 1 });
    expect(target.color.some((c) => c === FPS_GREEN)).toBe(false);
    expect(target.color.some((c) => c === POS_GREY)).toBe(false);
    // The bottom text HUD still paints without the diagnostics.
    expect(paintedIn(target, 0, 190, 320, 240)).toBeGreaterThan(0);
    setCVar('cl_showfps', 1);
    setCVar('cl_showpos', 1);
    const target2 = blank(320, 240);
    drawPlayHud(target2, boot, { fps: 60, frame: 1 });
    expect(target2.color.some((c) => c === FPS_GREEN)).toBe(true);
    expect(target2.color.some((c) => c === POS_GREY)).toBe(true);
  });

  it('statusbar state derives from the live driver (health/ammo/armor/weapon)', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    const st = statusbarStateFor(boot);
    expect(st.stats[1]).toBe(boot.driver.playerHealth);
    expect(st.stats[5]).toBe(boot.driver.ps.armor);
    expect(st.images[0]).toBe('i_health');
    // Blaster has no ammo kind: no ammo row (stat 2 clear).
    expect(st.stats[2]).toBe(0);
  });

  it('F1 help overlay draws without a pak (dim backdrop + text rows)', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    expect(boot.showHelp).toBe(false);
    expect(toggleHelpOverlay(boot)).toBe(true);
    const target = blank(320, 240);
    expect(() => drawPlayHud(target, boot, { fps: 0, frame: 1 })).not.toThrow();
    expect(paintedIn(target, 32, 24, 288, 216)).toBeGreaterThan(200);
    expect(toggleHelpOverlay(boot)).toBe(false);
  });

  it('completion centers through centerPrintPlacement, death keeps the field', () => {
    // Geometry rule (SCR_DrawCenterString): short messages at 35% height.
    const lines = centerPrintPlacement('YOU ARE DEAD', 640, 480);
    expect(lines).toEqual([{ x: 272, y: 168, text: 'YOU ARE DEAD' }]);
    const boot = bootPlay({ width: 320, height: 240 });
    boot.driver.server.finished = true;
    boot.driver.message = 'LEVEL COMPLETE — done\nkills 1/2  secrets 0/3  goals 0/1\ntime 0:42';
    const target = blank(320, 240);
    drawPlayHud(target, boot, { fps: 0, frame: 1 });
    expect(target.color.some((c) => c === FINISH_BLUE)).toBe(true);
    // Death leg: zero health still draws the hp row (id draws hnum always).
    boot.driver.server.finished = false;
    boot.driver.damagePlayer(1000);
    expect(boot.driver.playerDead).toBe(true);
    const target2 = blank(320, 240);
    expect(() => drawPlayHud(target2, boot, { fps: 0, frame: 1 })).not.toThrow();
    expect(target2.color.some((c) => c === 0xffff3333 || c === 0xffffffff)).toBe(true);
  });

  it('drawStatusbarCmds without assets is a safe no-op', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const target = blank(64, 48);
    expect(() => drawStatusbarCmds(target, boot, 64, 48)).not.toThrow();
    expect(target.color.every((c) => c === 0)).toBe(true);
  });

  it('retail script parses and executes (id xv/yb math at both resolutions)', () => {
    const ops = parseStatusbar(RETAIL_SINGLE_STATUSBAR);
    expect(ops.length).toBeGreaterThan(10);
    const boot = bootPlay({ width: 320, height: 240 });
    const st = statusbarStateFor(boot);
    const at640 = executeStatusbar(ops, st, 640, 480);
    expect(at640[0]).toMatchObject({ kind: 'field', x: 160, y: 456, style: 'num' });
    const at1024 = executeStatusbar(ops, st, 1024, 768);
    expect(at1024[0]).toMatchObject({ kind: 'field', x: 352, y: 744, style: 'num' });
  });

  it('F1 layout builds through the production HelpComputer path', () => {
    const layout = buildHelpLayout({
      skill: 1,
      levelName: 'Outer Base',
      help1: 'Find the exit.',
      help2: 'Watch for soldiers.',
      kills: [3, 10],
      goals: [0, 1],
      secrets: [1, 2],
    });
    expect(layout).toContain('xv 32 yv 8 picn help');
    expect(layout).toContain('"medium"');
    const cmds = executeStatusbar(parseStatusbar(layout), statusbarStateFor(bootPlay({ width: 64, height: 48 })), 640, 480);
    expect(cmds).toContainEqual({ kind: 'pic', x: 192, y: 128, name: 'help' });
    expect(cmds.some((c) => c.kind === 'text' && (c as { text: string }).text === 'Outer Base')).toBe(true);
  });
});

describe.runIf(!!WEB_Q2_PAK)('RELEASE-6 web HUD (real pak, Q2_PAK)', () => {
  it('real digit/icon art paints at 640x480 with values, transparency and scaling', { timeout: 180000 }, async () => {
    const boot = await bootPak(640, 480);
    expect(boot.hudPics).not.toBeNull();
    expect(boot.palette).not.toBeNull();
    expect(boot.palette!.length).toBe(768);
    // Icon + digit sets decoded from the real lumps.
    expect(boot.hudPics!.icons.get('i_health')).toMatchObject({ width: 24, height: 24 });
    expect(boot.hudPics!.digits.num.digits).toHaveLength(10);
    const target = blank(640, 480);
    drawPlayHud(target, boot, { fps: 0, frame: 1 });
    // Bottom statusbar band paints real art (health field + icon row).
    const band = paintedIn(target, 0, 420, 640, 480);
    expect(band).toBeGreaterThan(300);
    // Transparency: digit cutouts (transparent index 255) leave background
    // pixels untouched inside the field box — opaque-block rendering would
    // fill every cell pixel.
    const fieldBox = { x0: 160, y0: 456, x1: 160 + 3 * 16, y1: 456 + 24 };
    const filled = paintedIn(target, fieldBox.x0, fieldBox.y0, fieldBox.x1, fieldBox.y1);
    const area = (fieldBox.x1 - fieldBox.x0) * (fieldBox.y1 - fieldBox.y0);
    expect(filled).toBeGreaterThan(0);
    expect(filled).toBeLessThan(area);
    // The top diagnostics are untouched by the statusbar program.
    setCVar('cl_showfps', 0);
    setCVar('cl_showpos', 0);
    const target2 = blank(640, 480);
    drawPlayHud(target2, boot, { fps: 60, frame: 1 });
    expect(target2.color.some((c) => c === FPS_GREEN)).toBe(false);
    expect(paintedIn(target2, 0, 420, 640, 480)).toBeGreaterThan(300);
    setCVar('cl_showfps', 1);
    setCVar('cl_showpos', 1);
  });

  it('same asset HUD scales to 1024x768 (xv/yv remap, not a stretch)', { timeout: 180000 }, async () => {
    const boot = await bootPak(1024, 768);
    const target = blank(1024, 768);
    drawPlayHud(target, boot, { fps: 0, frame: 1 });
    // yb -24 row lands at 744 (not the 640x480 row 456 scaled blindly).
    const st = statusbarStateFor(boot);
    const cmds = executeStatusbar(parseStatusbar(RETAIL_SINGLE_STATUSBAR), st, 1024, 768);
    expect(cmds[0]).toMatchObject({ kind: 'field', x: 352, y: 744 });
    expect(paintedIn(target, 0, 700, 1024, 768)).toBeGreaterThan(300);
    // Health value pixels sit at the executed field origin (1024 row).
    expect(paintedIn(target, 352, 744, 352 + 3 * 16, 744 + 24)).toBeGreaterThan(0);
    console.log(`[release-6] 1024x768 bottom band painted=${paintedIn(target, 0, 700, 1024, 768)}`);
  });

  it('death + completion + F1 render with real art at 640x480', { timeout: 180000 }, async () => {
    const boot = await bootPak(640, 480);
    // Death: zero health still draws the hnum field with real digit pics.
    boot.driver.damagePlayer(1000);
    expect(boot.driver.playerDead).toBe(true);
    const dead = blank(640, 480);
    drawPlayHud(dead, boot, { fps: 0, frame: 1 });
    expect(paintedIn(dead, 160, 456, 160 + 3 * 16, 456 + 24)).toBeGreaterThan(0);
    // Completion: centerPrintPlacement block in FINISH_BLUE.
    boot.driver.server.finished = true;
    boot.driver.server.finishKills = 5;
    boot.driver.message = 'LEVEL COMPLETE — base2 is not shipped yet. Thanks for playing!\nkills 5/12  secrets 1/3  goals 0/1\ntime 3:07';
    const done = blank(640, 480);
    drawPlayHud(done, boot, { fps: 0, frame: 1 });
    expect(done.color.some((c) => c === FINISH_BLUE)).toBe(true);
    // F1: help background + rows over the HUD.
    boot.driver.server.finished = false;
    toggleHelpOverlay(boot);
    const help = blank(640, 480);
    drawPlayHud(help, boot, { fps: 0, frame: 1 });
    // 256x192 help bg centered at ((640-256)/2, (480-192)/2) = (192,144).
    expect(paintedIn(help, 192, 144, 192 + 256, 144 + 192)).toBeGreaterThan(2000);
    toggleHelpOverlay(boot);
  });

  it('buildHudPicCache degrades per-lump (one corrupt pic never blanks the HUD)', { timeout: 180000 }, async () => {
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const pak = ingestPak(buf);
    const cache = buildHudPicCache(pak);
    expect(cache.icons.get('w_blaster')).toMatchObject({ width: 24, height: 24 });
    expect(cache.help).toMatchObject({ width: 256, height: 192 });
    // Simulate a missing lump: drop the health icon — the field still draws.
    cache.icons.delete('i_health');
    const boot = await bootPak(320, 240);
    boot.hudPics = cache;
    const target = blank(320, 240);
    expect(() => drawPlayHud(target, boot, { fps: 0, frame: 1 })).not.toThrow();
    expect(paintedIn(target, 0, 190, 320, 240)).toBeGreaterThan(0);
  });
});
