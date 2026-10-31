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
  drawHelpOverlay,
  drawHudText,
  drawPlayHud,
  drawStatusbarCmds,
  helpFactsFor,
  resizePlay,
  RETAIL_SINGLE_STATUSBAR,
  statusbarStateFor,
  toggleHelpOverlay,
  FINISH_BLUE,
  FPS_GREEN,
  POS_GREY,
} from './play.js';
import type { PlayBoot } from './play.js';
import type { UserCmdT } from '@q2/input';
import { BUTTON_ATTACK, BUTTON_DUCK } from '@q2/input';
import { v3 } from '@q2/math';
import { spawnEdict } from '@q2/game';
import { SV_LinkEdict, SV_SetPlayerHealth, fireTargets } from '@q2/server';
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

describe('RELEASE-6 web lane (live counters / help ack / completion)', () => {
  const attackCmd: UserCmdT = { msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 1 };

  it('F1 rows read live counters during play, frozen snapshot at completion', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    boot.driver.server.totalMonsters = 12;
    boot.driver.server.killedMonsters = 3;
    boot.driver.server.totalSecrets = 2;
    boot.driver.server.foundSecrets = 1;
    boot.driver.server.totalGoals = 1;
    boot.driver.server.foundGoals = 0;
    // Live during play (id HelpComputer reads level.* — never finish*).
    expect(helpFactsFor(boot).kills).toEqual([3, 12]);
    expect(helpFactsFor(boot).secrets).toEqual([1, 2]);
    expect(helpFactsFor(boot).goals).toEqual([0, 1]);
    // Frozen once finished: post-finish kills don't move the F1 rows.
    boot.driver.server.finished = true;
    boot.driver.server.finishKills = 3;
    boot.driver.server.finishSecrets = 1;
    boot.driver.server.finishGoals = 0;
    boot.driver.server.killedMonsters = 9;
    boot.driver.server.foundSecrets = 2;
    expect(helpFactsFor(boot).kills).toEqual([3, 12]);
    expect(helpFactsFor(boot).secrets).toEqual([1, 2]);
    expect(helpFactsFor(boot).goals).toEqual([0, 1]);
    // The production overlay path renders those rows without throwing.
    toggleHelpOverlay(boot);
    const target = blank(320, 240);
    expect(() => drawPlayHud(target, boot, { fps: 0, frame: 1 })).not.toThrow();
    expect(paintedIn(target, 32, 24, 288, 216)).toBeGreaterThan(200);
  });

  it('help icon flashes only while a change is unacked, at (serverframe & 8)', () => {
    // Real tick path (devroom, no pak): a synthetic target_help fires
    // through fireTargets + driver.step — never hand-set counters (the old
    // revision assigned boot.helpChangedSeq directly, which the production
    // mirror never reads).
    const boot = bootPlay({ width: 320, height: 240 });
    const { driver } = boot;
    const idle: UserCmdT = { msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
    // Cold: nothing pending → slot hidden at every flash phase (no
    // unconditional permanent blink).
    for (const t of [0, 0.8, 1.6, 8.0]) {
      boot.host.serverTime = t;
      const st = statusbarStateFor(boot);
      expect(st.stats[11]).toBe(0);
      expect(st.images[11]).toBe('');
    }
    expect(driver.helpChanged).toBe(0);
    // Fire a help change the C way (G_UseTargets on a target_help).
    SV_LinkEdict(driver.server, spawnEdict({ classname: 'target_help', targetname: 'h1', message: 'Hi.' }));
    fireTargets(driver.server, spawnEdict({ classname: 'trigger_once', target: 'h1' }));
    expect(driver.server.helpChangedSeq).toBe(1);
    driver.step(idle, 0.1);
    expect(driver.helpGameSeen).toBe(1);
    expect(driver.helpChanged).toBe(1);
    // A published change: i_help exactly when (frame & 8), hidden otherwise.
    boot.host.serverTime = 0; // frame 0
    expect(statusbarStateFor(boot).stats[11]).toBe(0);
    boot.host.serverTime = 0.8; // frame 8
    const flashing = statusbarStateFor(boot);
    expect(flashing.stats[11]).toBe(11);
    expect(flashing.images[11]).toBe('i_help');
    boot.host.serverTime = 1.6; // frame 16: (16 & 8) === 0
    expect(statusbarStateFor(boot).stats[11]).toBe(0);
    // Opening F1 acks (pers.helpchanged = 0) → slot hides on flash frames.
    expect(toggleHelpOverlay(boot)).toBe(true);
    expect(driver.helpChanged).toBe(0);
    expect(boot.helpSeenSeq).toBe(1);
    expect(statusbarStateFor(boot).stats[11]).toBe(0);
    // Open + no new change → F1 closes (id Cmd_Help_f).
    expect(toggleHelpOverlay(boot)).toBe(false);
    // A new change re-notifies → F1 stays open + acks again.
    SV_LinkEdict(driver.server, spawnEdict({ classname: 'target_help', targetname: 'h2', message: 'Yo.' }));
    fireTargets(driver.server, spawnEdict({ classname: 'trigger_once', target: 'h2' }));
    driver.step(idle, 0.1);
    expect(driver.helpChanged).toBe(1);
    expect(toggleHelpOverlay(boot)).toBe(true);
    expect(boot.showHelp).toBe(true);
    expect(driver.helpChanged).toBe(0);
    expect(boot.helpSeenSeq).toBe(2);
    expect(statusbarStateFor(boot).stats[11]).toBe(0);
  });

  it('help ack survives respawn and resize; multiline text centers per row', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    const { driver } = boot;
    const idle: UserCmdT = { msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
    // Publish + latch through the real tick.
    SV_LinkEdict(driver.server, spawnEdict({ classname: 'target_help', targetname: 'h1', message: 'Hi.' }));
    fireTargets(driver.server, spawnEdict({ classname: 'trigger_once', target: 'h1' }));
    driver.step(idle, 0.1);
    expect(driver.helpChanged).toBe(1);
    expect(driver.helpGameSeen).toBe(1);
    // Death → respawn keeps the pending notification (C pers survives SP
    // respawn — the new life must still flash until F1).
    driver.damagePlayer(1000);
    expect(driver.playerDead).toBe(true);
    for (let i = 0; i < 30; i++) driver.step(idle, 0.1);
    expect(driver.playerDead).toBe(false);
    expect(driver.helpChanged).toBe(1);
    expect(driver.helpGameSeen).toBe(1);
    // F1 still acks after the new life.
    expect(toggleHelpOverlay(boot)).toBe(true);
    expect(driver.helpChanged).toBe(0);
    toggleHelpOverlay(boot);
    // Resize preserves UI + driver help state and keeps rendering.
    expect(resizePlay(boot, 640, 480)).toBe(true);
    expect(driver.helpGameSeen).toBe(1);
    expect(driver.helpChanged).toBe(0);
    toggleHelpOverlay(boot);
    const target = blank(640, 480);
    expect(() => drawPlayHud(target, boot, { fps: 0, frame: 1 })).not.toThrow();
    expect(paintedIn(target, 192, 144, 192 + 256, 144 + 192)).toBeGreaterThan(200);
    // DrawHUDString parity: embedded newlines split into per-row centered
    // lines (base1's latched help text relies on this).
    const lines = blank(320, 32);
    drawHudText(lines, 0, 0, 'A\nLONGER LINE', 320, 0xffffffff);
    expect(paintedIn(lines, 100, 0, 220, 8)).toBeGreaterThan(0);
    expect(paintedIn(lines, 100, 8, 220, 16)).toBeGreaterThan(0);
  });

  it('completion freezes interaction and drops the gun (intermission-lite)', () => {
    const boot = bootPlay({ width: 320, height: 240 });
    const { driver } = boot;
    setCVar('cl_showfps', 0);
    setCVar('cl_showpos', 0);
    // Sanity: the trigger fires before the finish.
    // The 2D blaster silhouette paints pre-finish (receiver body tone).
    const live = blank(320, 240);
    drawPlayHud(live, boot, { fps: 0, frame: 1 });
    const bodyTone = 0xff3a3f44;
    const countTone = (t: { color: Uint32Array }): number => t.color.filter((c) => c === bodyTone).length;
    expect(countTone(live)).toBeGreaterThan(0);
    driver.step(attackCmd, 0.1);
    expect(driver.events).toContain('shot');
    // Finish: gun down, trigger dead, message frozen.
    driver.server.finished = true;
    driver.server.finishKills = driver.server.killedMonsters;
    driver.server.finishSecrets = driver.server.foundSecrets;
    driver.server.finishGoals = driver.server.foundGoals;
    // Let the step mirror the frozen snapshot, then attack: the screen stays.
    driver.step(
      { msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 },
      0.1,
    );
    const msg = driver.message;
    expect(msg).toContain('LEVEL COMPLETE');
    const eventsBefore = driver.events.length;
    driver.step(attackCmd, 0.1);
    // No new player-input events (in-flight projectiles may still resolve —
    // the sim keeps running; the trigger itself is dead).
    expect(driver.events.slice(eventsBefore)).not.toContain('shot');
    expect(driver.events.slice(eventsBefore)).not.toContain('empty');
    expect(driver.events.slice(eventsBefore)).not.toContain('use');
    expect(driver.message).toBe(msg);
    expect(driver.message).toContain('LEVEL COMPLETE');
    expect(driver.viewModel()).toBeNull();
    const done = blank(320, 240);
    drawPlayHud(done, boot, { fps: 0, frame: 1 });
    expect(countTone(done)).toBe(0);
    expect(done.color.some((c) => c === FINISH_BLUE)).toBe(true);
    setCVar('cl_showfps', 1);
    setCVar('cl_showpos', 1);
  });

  it('HUD/F1/death/completion align at 320x240, 640x480, 800x600 and 1024x768', () => {
    for (const [w, h] of [[320, 240], [640, 480], [800, 600], [1024, 768]] as const) {
      const boot = bootPlay({ width: w, height: h });
      setCVar('cl_showfps', 0);
      setCVar('cl_showpos', 0);
      // HUD: no throw, bottom text band paints (asset-free fallback rows).
      const hud = blank(w, h);
      expect(() => drawPlayHud(hud, boot, { fps: 0, frame: 1 })).not.toThrow();
      expect(paintedIn(hud, 0, h - 60, w, h)).toBeGreaterThan(0);
      // F1: 256x192 backdrop centered ((w-256)/2, (h-192)/2), rows paint.
      toggleHelpOverlay(boot);
      const hx = Math.max(0, ((w - 256) / 2) | 0);
      const hy = Math.max(0, ((h - 192) / 2) | 0);
      const help = blank(w, h);
      expect(() => drawHelpOverlay(help, boot)).not.toThrow();
      expect(paintedIn(help, hx, hy, hx + 256, hy + 192)).toBeGreaterThan(200);
      toggleHelpOverlay(boot);
      // Death keeps the hp row; completion centers FINISH_BLUE text.
      boot.driver.damagePlayer(1000);
      expect(boot.driver.playerDead).toBe(true);
      const dead = blank(w, h);
      expect(() => drawPlayHud(dead, boot, { fps: 0, frame: 1 })).not.toThrow();
      expect(dead.color.some((c) => c === 0xffff3333 || c === 0xffffffff)).toBe(true);
      boot.driver.server.finished = true;
      boot.driver.server.finishKills = 0;
      boot.driver.message = 'LEVEL COMPLETE — done';
      const done = blank(w, h);
      drawPlayHud(done, boot, { fps: 0, frame: 1 });
      expect(done.color.some((c) => c === FINISH_BLUE)).toBe(true);
    }
    setCVar('cl_showfps', 1);
    setCVar('cl_showpos', 1);
  });
});

describe.runIf(!!WEB_Q2_PAK)('RELEASE-6 cold boot + secret trace (real base1, real ticks)', () => {
  function neutralCmd(): UserCmdT {
    return { msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
  }

  function beeps(driver: PlayBoot['driver']): number {
    return driver.heardSounds.filter((s) => s === 'misc/pc_up.wav').length;
  }

  it('cold boot notifies on tick 1 (*16→t70): flash until F1 ack, ≤3 beeps, re-notify', { timeout: 300000 }, async () => {
    const boot = await bootPak(96, 72);
    const { driver } = boot;
    // Cold boot: nothing published, nothing pending, secrets 0/3, the
    // worldspawn map name captured server-side.
    expect(driver.server.helpChangedSeq).toBe(0);
    expect(driver.helpChanged).toBe(0);
    expect(driver.helpGameSeen).toBe(0);
    expect(boot.helpChangedSeq).toBe(0);
    expect(boot.helpSeenSeq).toBe(0);
    expect(driver.server.totalSecrets).toBe(3);
    expect(driver.server.totalGoals).toBe(1);
    expect(driver.server.foundSecrets).toBe(0);
    expect(driver.server.levelName).toBe('Outer Base');
    for (const t of [0, 0.8, 1.6]) {
      boot.host.serverTime = t;
      expect(statusbarStateFor(boot).images[11]).toBe('');
    }
    // Fallback help text before any firing (no target_help latched yet).
    expect(helpFactsFor(boot).help1).toBe('Find the exit.');
    expect(helpFactsFor(boot).help2).toBe('Watch for soldiers.');
    expect(helpFactsFor(boot).levelName).toBe('Outer Base');
    // Tick 1: the spawn volume overlaps *16 → t70 latches both messages
    // (the C startup notification — the player spawns inside the trigger).
    driver.step(neutralCmd(), 0.1);
    expect(driver.server.helpChangedSeq).toBe(2);
    expect(driver.server.helpMessage1).toBe('Establish communication\nlink to command ship.');
    expect(driver.server.helpMessage2).toBe('Locate base installation\nelevator.');
    expect(driver.helpGameSeen).toBe(2);
    expect(driver.helpChanged).toBe(1);
    // Current text/map name flow into F1.
    const facts = helpFactsFor(boot);
    expect(facts.levelName).toBe('Outer Base');
    expect(facts.help1).toBe('Establish communication\nlink to command ship.');
    expect(facts.help2).toBe('Locate base installation\nelevator.');
    // Flash cadence through the production statusbar.
    boot.host.serverTime = 0.8; // frame 8
    const flashing = statusbarStateFor(boot);
    expect(flashing.stats[11]).toBe(11);
    expect(flashing.images[11]).toBe('i_help');
    boot.host.serverTime = 1.6; // frame 16
    expect(statusbarStateFor(boot).stats[11]).toBe(0);
    // Multiline help renders as two rows (DrawHUDString parity): help1 sits
    // on the yv-54 cstring2 row with its second line 8px below. Drawn
    // directly (no toggle — opening F1 would ack before the beep leg).
    const panel = blank(320, 240);
    drawHelpOverlay(panel, boot);
    expect(paintedIn(panel, 0, 50, 320, 62)).toBeGreaterThan(0);
    expect(paintedIn(panel, 0, 62, 320, 72)).toBeGreaterThan(0);
    // Beep: exactly 3 pc_up sounds, then the counter parks at 4 (silent
    // flash until F1). The loop runs until the terminal counter rather
    // than a fixed frame so float tick accumulation cannot flake it.
    let guard = 0;
    while (driver.helpChanged !== 4 && guard++ < 400) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
    }
    expect(driver.helpChanged).toBe(4);
    expect(beeps(driver)).toBe(3);
    // F1 ack stops the flash; the slot stays dark on lit-phase frames.
    expect(toggleHelpOverlay(boot)).toBe(true);
    expect(driver.helpChanged).toBe(0);
    expect(boot.helpSeenSeq).toBe(2);
    boot.host.serverTime = 0.8;
    expect(statusbarStateFor(boot).stats[11]).toBe(0);
    expect(toggleHelpOverlay(boot)).toBe(false);
    // A NEW change re-notifies: counter re-arms and the beep restarts.
    SV_LinkEdict(driver.server, spawnEdict({ classname: 'target_help', targetname: 'h9', message: 'More.' }));
    fireTargets(driver.server, spawnEdict({ classname: 'trigger_once', target: 'h9' }));
    expect(driver.server.helpChangedSeq).toBe(3);
    driver.step(neutralCmd(), 0.1);
    expect(driver.helpGameSeen).toBe(3);
    expect(driver.helpChanged).toBe(1);
    boot.host.serverTime = 0.8;
    expect(statusbarStateFor(boot).images[11]).toBe('i_help');
    guard = 0;
    while (driver.helpChanged !== 2 && guard++ < 120) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
    }
    expect(driver.helpChanged).toBe(2);
    expect(beeps(driver)).toBe(4);
    console.log('[release-6] cold-boot trace: tick-1 *16→t70 notify, 3+1 beeps, ack + re-notify PASS');
  });

  it('secret chain t77 → t76 → t91: immediate, single-use, live F1, frozen finish', { timeout: 300000 }, async () => {
    const boot = await bootPak(96, 72);
    const { driver } = boot;
    expect(driver.server.totalSecrets).toBe(3);
    // One setup tick (fires *16 helps; secrets untouched).
    driver.step(neutralCmd(), 0.1);
    expect(driver.server.foundSecrets).toBe(0);
    // t77: walk into the *14 brush volume — counts on the SAME tick.
    driver.pm.origin = v3(1088, 837, -200);
    driver.pm.velocity = v3();
    SV_SetPlayerHealth(driver.server, 100);
    driver.step(neutralCmd(), 0.1);
    expect(driver.server.foundSecrets).toBe(1);
    // Live F1 with help closed AND open (no reopen needed).
    expect(helpFactsFor(boot).secrets).toEqual([1, 3]);
    toggleHelpOverlay(boot);
    expect(helpFactsFor(boot).secrets).toEqual([1, 3]);
    // Single-use: camping the volume never double-counts.
    for (let i = 0; i < 5; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
    }
    expect(driver.server.foundSecrets).toBe(1);
    // t76: silencer duck-crawl pickup (pickups.test.ts recipe) — the
    // item-target cascade that SV_UseTargetname used to drop.
    driver.pm.origin = v3(-408, 620, -96);
    driver.pm.velocity = v3();
    const duck: UserCmdT = { msec: 100, angles: [0, 90, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_DUCK };
    let n = 0;
    const pickupsBefore = driver.events.filter((e) => e === 'pickup').length;
    while (driver.events.filter((e) => e === 'pickup').length < pickupsBefore + 1 && n++ < 60) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step({ ...duck, forwardmove: 100 }, 0.1);
    }
    expect(driver.events.filter((e) => e === 'pickup').length).toBe(pickupsBefore + 1);
    expect(driver.server.foundSecrets).toBe(2);
    // The already-open overlay re-renders the new count (no reopen).
    expect(boot.showHelp).toBe(true);
    expect(helpFactsFor(boot).secrets).toEqual([2, 3]);
    // t91: shoot *13 from the pit floor (release-4-trace recipe, C
    // button_killed) — counts the secret and takes the lift finish.
    driver.pm.origin = v3(-2030, 1536, 40);
    driver.pm.velocity = v3();
    for (let i = 0; i < 40 && !driver.pm.onGround; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
    }
    const aimDx = -2016 - driver.pm.origin[0]!;
    const aimDy = 1536 - driver.pm.origin[1]!;
    const aimDz = 80 - (driver.pm.origin[2]! + 22);
    const aimL = Math.hypot(aimDx, aimDy) || 1;
    const aim: [number, number, number] = [
      (Math.atan2(-aimDz, aimL) * 180) / Math.PI,
      (Math.atan2(aimDy, aimDx) * 180) / Math.PI,
      0,
    ];
    const attack: UserCmdT = { msec: 100, angles: aim, forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_ATTACK };
    let t91at = -1;
    for (let i = 0; i < 120 && t91at < 0; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(attack, 0.1);
      if (driver.server.firedThisTick.includes('t91')) t91at = i;
    }
    expect(t91at).toBeGreaterThanOrEqual(0);
    expect(driver.server.foundSecrets).toBe(3);
    expect(driver.server.finished).toBe(true);
    expect(driver.server.finishReason).toBe('lift');
    expect(driver.server.finishSecrets).toBe(3);
    // Frozen once finished: post-finish ticks never move the F1 rows.
    expect(helpFactsFor(boot).secrets).toEqual([3, 3]);
    for (let i = 0; i < 10; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
    }
    expect(helpFactsFor(boot).secrets).toEqual([3, 3]);
    console.log('[release-6] secret trace: t77 touch + t76 pickup + t91 shot, single-use, live→frozen PASS');
  });
});
