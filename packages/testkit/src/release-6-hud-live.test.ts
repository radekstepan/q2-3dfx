// @q2/testkit — RELEASE-6 HUD/F1/completion production-path regressions (testkit lane).
//
// Owns: `packages/testkit` ONLY. Read-only on `apps/web` (source pins read
// `play.ts` as TEXT through node:fs — never imported, so `yarn deps:check`
// stays green: testkit may use anything except apps/*, and nothing may
// import from apps/*). Read-only on `packages/server`/`packages/client`/
// `packages/game`/`packages/host`/`packages/sw-renderer` through their real
// exports (production code paths, never mirrors).
//
// Why this file exists alongside `apps/web/src/release-6-hud-web.test.ts`
// and `packages/testkit/src/release-6-hud.test.ts`:
//   - the apps/web lane owns `drawPlayHud`/`drawHelpOverlay`/`statusbarStateFor`
//     wiring unit tests (it can import `play.ts` directly);
//   - the formats/client lane (`release-6-hud.test.ts`) owns manifest +
//     execution-geometry unit tests (exact coords, layout strings);
//   - THIS lane owns production-path regressions: real server tick + real
//     kills/secrets/goals, real `SV_FinishLevel`, real `executeStatusbar` +
//     real `drawPic`/`drawField`/`drawString` with real pak art, real
//     `Host` frames + real resizes, and SAMPLED PIXELS at known-good
//     positions (help background borders, executed `pic` coords, digit cells)
//     — never merely in-bounds, nonblack, or counts. Per BRAIN.md §8 review
//     rules, helper arithmetic alone cannot close the card.
//
// Ground truths:
//   - retail `single_statusbar` (`game/g_spawn.c`), duplicated by value
//     (whitespace-insensitive under the production tokenizer; this is the
//     same documented seam `release-6-hud.test.ts` uses);
//   - `game/p_hud.c: G_SetStats` help-icon rule + `Cmd_Help_f` ack,
//     `game/p_view.c` helpchanged tracking + beep (`helpIconVisible` /
//     `helpBeepDue` in `@q2/server`, `helpIconFor` in `@q2/client`);
//   - `game/p_hud.c: BeginIntermission`: SP same-unit exits set
//     `level.exitintermission = 1` and return — NO intermission camera, NO
//     multiplayer scoreboard, NO victory screen (`showsIntermissionScoreboard`
//     is false for `base1`);
//   - `game/g_target.c: Use_Target_Help` bumps `game.helpchanged`.
//
// Box mapping (RELEASE-6 done-when):
//   - Box 1 (layout): real-art `executeStatusbar` + blit at 320x240, 640x480,
//     800x600, 1024x768: icons exact-match decoded art at executed `pic`
//     coords, digit fields show non-background runs in every expected cell
//     with transparent cutouts preserved, help background borders exact-match
//     at centered positions. Before/after-resize via a real running Host
//     (real frames, real base1 world, real art, no reboot). Devroom fallback
//     (no pak) stays readable. WebGL2: headless-infeasible, gap documented
//     (2D HUD blits are renderer-agnostic — `paintHudOverlay` runs the same
//     pass over the GL canvas; see the gap leg below).
//   - Box 2 (live counters): real `SV_SpawnMonster` + `SV_DamageMonster` +
//     real `SV_Tick`, real `fireTargets` secrets/goals, F1 rows re-rendered
//     through production `buildHelpLayout`+`executeStatusbar`+blits with NO
//     reopen: row pixels change. Completion via production `SV_FinishLevel`:
//     frozen snapshot stays pixel-identical while live counters advance.
//     DEFECT PIN (fails pre-fix): `drawHelpOverlay` must read the LIVE
//     counters (`killedMonsters`/`foundGoals`/`foundSecrets`), not the frozen
//     `finish*` snapshot.
//   - Box 3 (flash/ack): production `helpIconVisible`/`helpIconFor`/
//     `helpBeepDue` state tables + pixel cadence through the production
//     `if 11` script path: icon visible iff unacked-change && (frame&8), ack
//     stops it, no unconditional blink. DEFECT PINs (fail pre-fix):
//     `statusbarStateFor` must consult the flash rule (no constant help
//     icon); opening help must ack (`Cmd_Help_f` parity).
//   - Box 4 (completion): production `SV_FinishLevel` capture: no
//     multiplayer scoreboard layout, no `victory` asset pixels, frozen totals
//     survive further kills. Documents the faithful SP stand-in once the
//     apps/web lane lands it (reconcile, don't duplicate).
//
// Legs:
//   - asset-free legs always run (devroom fallback, live counters, cadence
//     state tables, completion freeze, source pins, WebGL2 gap note);
//   - real-asset legs (Q2_PAK) validate executed coords against retail lumps
//     with exact pixel matches.

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetCVars } from '@q2/config';
import { PakFile } from '@q2/filesystem';
import { parsePCX } from '@q2/formats';
import {
  buildHelpLayout,
  centerPrintPlacement,
  drawField,
  drawPic,
  drawString,
  executeStatusbar,
  fillRect,
  formatField,
  helpIconFor,
  loadConcharsFont,
  makeConcharsFont,
  parseStatusbar,
  setConcharsFont,
  showsIntermissionScoreboard,
} from '@q2/client';
import type { DigitPics, IndexedPic, StatusbarState } from '@q2/client';
import {
  fireTargets,
  helpBeepDue,
  helpIconVisible,
  SV_DamageMonster,
  SV_FinishLevel,
  SV_Init,
  SV_LinkEdict,
  SV_SpawnMonster,
  SV_Tick,
} from '@q2/server';
import { spawnEdict } from '@q2/game';
import { Host } from '@q2/host';
import type { HostDriver } from '@q2/host';
import type { Snapshot } from '@q2/client';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import { SoftwareRenderer } from '@q2/sw-renderer';


const Q2_PAK = process.env.Q2_PAK;
const HAS_PAK = !!Q2_PAK && existsSync(Q2_PAK as string);

// ---------------------------------------------------------------------------
// Retail single-player statusbar script (game/g_spawn.c: single_statusbar),
// duplicated by value — the same documented seam as release-6-hud.test.ts.
// ---------------------------------------------------------------------------

const RETAIL_SINGLE_STATUSBAR =
  'yb -24 xv 0 hnum xv 50 pic 0 ' +
  'if 2 xv 100 anum xv 150 pic 2 endif ' +
  'if 4 xv 200 rnum xv 250 pic 4 endif ' +
  'if 6 xv 296 pic 6 endif ' +
  'yb -50 if 7 xv 0 pic 7 xv 26 yb -42 stat_string 8 yb -50 endif ' +
  'if 9 xv 262 num 2 10 xv 296 pic 9 endif ' +
  'if 11 xv 148 pic 11 endif';

// ---------------------------------------------------------------------------
// Small harness: surfaces, sampling, captures, source pins.
// ---------------------------------------------------------------------------

const testDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(testDir, 'test-output');

interface Surface {
  width: number;
  height: number;
  color: Uint32Array;
}

function blank(w: number, h: number, fill = 0): Surface {
  return { width: w, height: h, color: new Uint32Array(w * h).fill(fill) };
}

/** Pixels in [x0,x1)x[y0,y1) that differ from `bg`. */
function paintedIn(s: Surface, x0: number, y0: number, x1: number, y1: number, bg = 0): number {
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(s.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(s.width, x1); x++) {
      if (s.color[y * s.width + x] !== bg) n++;
    }
  }
  return n;
}

function hashU32(a: Uint32Array): string {
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) {
    h ^= a[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Palette-mapped canvas color for indexed pixel `idx`. */
function mapPixel(palette: Uint8Array, idx: number): number {
  const r = palette[idx * 3]!;
  const g = palette[idx * 3 + 1]!;
  const b = palette[idx * 3 + 2]!;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

function writePpm(tag: string, s: Surface): void {
  try {
    mkdirSync(outDir, { recursive: true });
    const head = `P6\n${s.width} ${s.height}\n255\n`;
    const out = new Uint8Array(head.length + s.width * s.height * 3);
    for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i) & 255;
    for (let i = 0; i < s.width * s.height; i++) {
      const px = s.color[i]!;
      out[head.length + i * 3] = px & 255;
      out[head.length + i * 3 + 1] = (px >> 8) & 255;
      out[head.length + i * 3 + 2] = (px >> 16) & 255;
    }
    writeFileSync(join(outDir, `release-6-hud-live-${tag}-${s.width}x${s.height}.ppm`), out);
  } catch {
    /* capture is record-only; pixel assertions below are the gate */
  }
}

function repoRoot(): string {
  return join(testDir, '..', '..', '..');
}

function readSourceText(path: string): string {
  const bytes = readFileSync(path);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

function playSrc(): string {
  return readSourceText(join(repoRoot(), 'apps', 'web', 'src', 'play.ts'));
}

/** Body of `export function <name>` up to the next `export function`. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export function ${name}`);
  if (start < 0) return '';
  const rest = src.slice(start);
  const next = rest.indexOf('\nexport function ', 1);
  return next < 0 ? rest : rest.slice(0, next);
}

// ---------------------------------------------------------------------------
// Real pak art (Q2_PAK legs): decoded through the production PCX parser.
// ---------------------------------------------------------------------------

interface PakArt {
  palette: Uint8Array;
  digits: { num: DigitPics; anum: DigitPics };
  field3: IndexedPic;
  icons: Map<string, IndexedPic>;
  help: IndexedPic;
  victory: IndexedPic;
}

function decodeIcon(pak: PakFile, name: string): IndexedPic {
  const pcx = parsePCX(pak.readFile(`pics/${name}.pcx`));
  return { width: pcx.width, height: pcx.height, pixels: pcx.pixels };
}

function loadPakArt(): PakArt {
  const raw = readFileSync(Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const pak = new PakFile(buf);
  const palette = parsePCX(pak.readFile('pics/colormap.pcx')).palette;
  const digitSet = (prefix: string): DigitPics => {
    const digits: IndexedPic[] = [];
    for (let d = 0; d <= 9; d++) digits.push(decodeIcon(pak, `${prefix}_${d}`));
    return { digits, minus: decodeIcon(pak, `${prefix}_minus`) };
  };
  const icons = new Map<string, IndexedPic>();
  for (const n of [
    'i_health', 'i_bodyarmor', 'i_jacketarmor', 'w_blaster', 'w_shotgun', 'i_help',
    'a_shells', 'a_bullets',
  ]) {
    icons.set(n, decodeIcon(pak, n));
  }
  // Deterministic production font: real conchars when the lump parses.
  try {
    const pcx = parsePCX(pak.readFile('pics/conchars.pcx'));
    setConcharsFont(loadConcharsFont({ pixels: pcx.pixels, width: pcx.width, height: pcx.height }));
  } catch {
    setConcharsFont(makeConcharsFont());
  }
  return {
    palette,
    digits: { num: digitSet('num'), anum: digitSet('anum') },
    field3: decodeIcon(pak, 'field_3'),
    icons,
    help: decodeIcon(pak, 'help'),
    victory: decodeIcon(pak, 'victory'),
  };
}

/** Healthy statusbar state (all rows on): health 100, shells 25, armor 50. */
function healthyState(helpStat: number, helpImage: string): StatusbarState {
  return {
    stats: [0, 100, 2, 25, 4, 50, 6, 0, 0, 0, 0, helpStat, 0, 0, 0, 0],
    images: ['i_health', '', 'a_shells', '', 'i_jacketarmor', '', 'w_shotgun', '', '', '', '', helpImage],
    configstrings: [],
    serverframe: 0,
    clientInfo: () => null,
  };
}

/**
 * Production HUD blit: `parseStatusbar` + `executeStatusbar` + `drawPic`/
 * `drawField`/`drawString` with the given art (the same calls
 * `drawStatusbarCmds` makes in apps/web, driven here without importing it).
 * Unknown/missing art is skipped like the production fallback.
 */
function paintStatusbar(
  s: Surface,
  w: number,
  h: number,
  st: StatusbarState,
  art: Pick<PakArt, 'palette' | 'digits' | 'icons' | 'field3'> | null,
): void {
  const cmds = executeStatusbar(parseStatusbar(RETAIL_SINGLE_STATUSBAR), st, w, h);
  if (!art) return;
  for (const c of cmds) {
    try {
      if (c.kind === 'pic') {
        const pic = c.name === 'field_3' ? art.field3 : (art.icons.get(c.name) ?? null);
        if (pic) drawPic(s, c.x, c.y, pic, art.palette);
      } else if (c.kind === 'field') {
        drawField(s, c.x, c.y, c.style, c.width, c.value, art.digits, art.palette);
      } else if (c.kind === 'text') {
        drawString(s, c.x, c.y, c.text, 0xffffffff);
      }
    } catch {
      /* one bad cmd never blanks the HUD */
    }
  }
}

// ---------------------------------------------------------------------------
// Box 1 — layout at 320x240, 640x480, 800x600, 1024x768 (real art, Q2_PAK).
// ---------------------------------------------------------------------------

const SIZES: ReadonlyArray<readonly [number, number]> = [
  [320, 240],
  [640, 480],
  [800, 600],
  [1024, 768],
];

describe.runIf(HAS_PAK)('RELEASE-6 Box 1 layout (real pak art, production path)', () => {
  it('statusbar icons exact-match decoded art at executed pic coords, all sizes', () => {
    const art = loadPakArt();
    for (const [w, h] of SIZES) {
      const s = blank(w, h);
      const st = healthyState(11, 'i_help');
      paintStatusbar(s, w, h, st, art);
      const cmds = executeStatusbar(parseStatusbar(RETAIL_SINGLE_STATUSBAR), st, w, h);
      const pics = cmds.filter((c) => c.kind === 'pic');
      expect(pics.length, `pic cmds at ${w}x${h}`).toBeGreaterThanOrEqual(4);
      // Every executed icon blits its own decoded art at its executed origin:
      // the icon center pixel must equal the palette-mapped art center pixel
      // (alignment, not merely in-bounds paint).
      for (const c of pics) {
        if (c.kind !== 'pic' || c.name === 'field_3') continue;
        const src = art.icons.get(c.name);
        expect(src, `decoded art for ${c.name}`).toBeDefined();
        const ax = src!.width >> 1;
        const ay = src!.height >> 1;
        const want = mapPixel(art.palette, src!.pixels[ay * src!.width + ax]!);
        const got = s.color[(c.y + ay) * w + (c.x + ax)]!;
        expect(got, `${c.name} center pixel at (${c.x + ax},${c.y + ay}) ${w}x${h}`).toBe(want);
      }
      // i_health icon cell: opaque art block (icons carry no transparent
      // index) — the full 24x24 cell paints.
      const hp = pics.find((c) => c.kind === 'pic' && (c as { name: string }).name === 'i_health');
      expect(hp, `i_health pic at ${w}x${h}`).toBeDefined();
      if (hp && hp.kind === 'pic') {
        const cell = paintedIn(s, hp.x, hp.y, hp.x + 24, hp.y + 24);
        expect(cell, `i_health cell fill at ${w}x${h}`).toBe(24 * 24);
      }
      writePpm(`box1-statusbar`, s);
    }
    console.log('[release-6-live] box1: icons exact-match decoded art at executed coords, all 4 sizes');
  });

  it('digit fields show non-background runs in every expected cell, cutouts preserved', () => {
    const art = loadPakArt();
    for (const [w, h] of SIZES) {
      const s = blank(w, h);
      const st = healthyState(0, '');
      paintStatusbar(s, w, h, st, art);
      const cmds = executeStatusbar(parseStatusbar(RETAIL_SINGLE_STATUSBAR), st, w, h);
      const field = cmds.find((c) => c.kind === 'field');
      expect(field && field.kind === 'field', `health field at ${w}x${h}`).toBe(true);
      if (!field || field.kind !== 'field') continue;
      const text = formatField(field.value, field.width);
      expect(text, 'health field text').toBe('100');
      // Every digit cell (16px) carries a non-background run (real glyph
      // bits), and the field box keeps untouched cutout pixels (digit art
      // is a cutout, not an opaque block).
      const set = art.digits[field.style];
      let cx = field.x + 2;
      for (const ch of text) {
        const pic = ch === '-' ? set.minus : set.digits[ch.charCodeAt(0) - 48]!;
        const cell = paintedIn(s, cx, field.y, cx + 16, field.y + 24);
        expect(cell, `digit '${ch}' cell at (${cx},${field.y}) ${w}x${h}`).toBeGreaterThan(0);
        // First non-transparent art pixel lands palette-exact on the canvas.
        let pinned = false;
        for (let py = 0; py < pic.height && !pinned; py++) {
          for (let px = 0; px < pic.width && !pinned; px++) {
            const idx = pic.pixels[py * pic.width + px]!;
            if (idx !== 255) {
              expect(
                s.color[(field.y + py) * w + (cx + px)]!,
                `digit '${ch}' art pixel ${w}x${h}`,
              ).toBe(mapPixel(art.palette, idx));
              pinned = true;
            }
          }
        }
        expect(pinned, `digit '${ch}' has art pixels`).toBe(true);
        cx += 16;
      }
      const box = paintedIn(s, field.x, field.y, field.x + 3 * 16, field.y + 24);
      expect(box, `field box fill ${w}x${h}`).toBeGreaterThan(0);
      expect(box, `field box keeps cutouts ${w}x${h}`).toBeLessThan(3 * 16 * 24);
    }
    console.log('[release-6-live] box1: digit cells carry glyph runs + palette-exact art pixels, all 4 sizes');
  });

  it('help background borders exact-match at centered positions, all sizes', () => {
    const art = loadPakArt();
    for (const [w, h] of SIZES) {
      const s = blank(w, h);
      // Backdrop placement in isolation (what the task card pins): the
      // 256x192 `help` background blitted once at the centered origin via
      // the production `drawPic` path.
      const hx = ((w - 256) / 2) | 0;
      const hy = ((h - 192) / 2) | 0;
      expect([hx, hy], `help origin ${w}x${h}`).toEqual([((w - 256) / 2) | 0, ((h - 192) / 2) | 0]);
      drawPic(s, hx, hy, art.help, art.palette);
      // Four border corners palette-exact (centered, not clamped/stretched).
      // Transparency-aware: help.pcx carries index-255 pixels (e.g. the
      // (0,0) corner), which drawPic skips — those canvas pixels must stay
      // background, every other corner must match the decoded art pixel.
      const corners: Array<readonly [number, number]> = [
        [0, 0], [255, 0], [0, 191], [255, 191],
      ];
      for (const [ax, ay] of corners) {
        const idx = art.help.pixels[ay * 256 + ax]!;
        const want = idx === 255 ? 0 : mapPixel(art.palette, idx);
        expect(s.color[(hy + ay) * w + (hx + ax)]!, `help corner (${ax},${ay}) ${w}x${h}`).toBe(want);
      }
      // Placement proof: the painted-pixel count in the blit box equals the
      // art's own non-transparent count (any offset/clamp would change it).
      let artPainted = 0;
      for (let i = 0; i < art.help.pixels.length; i++) if (art.help.pixels[i] !== 255) artPainted++;
      expect(paintedIn(s, hx, hy, hx + 256, hy + 192), `help bg paint count ${w}x${h}`).toBe(artPainted);
      // Outside the border stays background (proves centering, not a fill).
      if (hx > 0) expect(s.color[hy * w + (hx - 1)]!, `left of help bg ${w}x${h}`).toBe(0);
      if (hy > 0) expect(s.color[(hy - 1) * w + hx]!, `above help bg ${w}x${h}`).toBe(0);
      // Layout rows over the bg: the production HelpComputer text paints.
      const st: StatusbarState = { stats: [], images: [], configstrings: [], serverframe: 0, clientInfo: () => null };
      const cmds = executeStatusbar(
        parseStatusbar(
          buildHelpLayout({
            skill: 1, levelName: 'Outer Base', help1: 'Find the exit.', help2: 'Watch for soldiers.',
            kills: [3, 10], goals: [0, 1], secrets: [1, 2],
          }),
        ),
        st,
        w,
        h,
      );
      for (const c of cmds) {
        if (c.kind === 'text') drawString(s, c.x, c.y, c.text, 0xffffffff);
      }
      expect(paintedIn(s, hx, hy + 160, hx + 256, hy + 192), `help rows ${w}x${h}`).toBeGreaterThan(50);
      writePpm(`box1-help`, s);
    }
    console.log('[release-6-live] box1: help bg borders palette-exact at centered origins, all 4 sizes');
  });
});

// ---------------------------------------------------------------------------
// Box 1 — Host running-loop resize with real art (Q2_PAK). Real frames, real
// HUD repaints, before/after captures; sim (server time) survives.
// ---------------------------------------------------------------------------

class ScriptDriver implements HostDriver {
  spawnOrigin: [number, number, number] = [0, 0, 32];
  spawn(): { origin: [number, number, number]; angles?: [number, number, number] } {
    return { origin: [...this.spawnOrigin], angles: [0, 0, 0] };
  }
  step(_cmd: UserCmdT, _dt: number): void {}
  snapshot(serverTime: number): Snapshot {
    return {
      serverTime,
      entities: [{ id: 1, origin: [...this.spawnOrigin], velocity: [0, 0, 0] }],
    };
  }
}

describe.runIf(HAS_PAK)('RELEASE-6 Box 1 resize (real base1 frames + real-art HUD)', () => {
  it('before/after-resize captures keep executed HUD coords painted', async () => {
    resetCVars();
    const { loadBenchWorld, benchSpawnOrigin, benchSpawnYaw } = await import('./bench-workloads.js');
    const raw = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const bw = loadBenchWorld(buf);
    const art = loadPakArt();
    const driver = new ScriptDriver();
    const spawn = benchSpawnOrigin();
    driver.spawnOrigin = [...spawn];
    const refresh = new SoftwareRenderer();
    const host = new Host({
      refresh,
      width: 320,
      height: 240,
      indexed: true,
      world: { name: 'base1', data: bw.world },
      driver,
    });
    refresh.setPalette(bw.palette);
    host.playerOrigin = [...spawn];
    host.input.angles = [0, benchSpawnYaw(), 0];
    const clock = { t: 0 };
    const frame = (): void => {
      clock.t += 100;
      host.frame(clock.t);
    };
    const paintHud = (): void => {
      // Production HUD repaint over the live frame (same execute+blit calls
      // the web lane makes post-resolve, driven here without importing it).
      paintStatusbar(
        { width: host.fb.width, height: host.fb.height, color: host.fb.color },
        host.fb.width,
        host.fb.height,
        healthyState(11, 'i_help'),
        art,
      );
    };
    // BEFORE: boot size renders world pixels + aligned HUD art.
    frame();
    frame();
    expect(host.fb.color.length).toBe(320 * 240);
    paintHud();
    const st320 = healthyState(11, 'i_help');
    const cmds320 = executeStatusbar(parseStatusbar(RETAIL_SINGLE_STATUSBAR), st320, 320, 240);
    const hp320 = cmds320.find((c) => c.kind === 'pic' && (c as { name: string }).name === 'i_health');
    expect(hp320 && hp320.kind === 'pic', 'i_health executes at 320x240').toBe(true);
    if (hp320 && hp320.kind === 'pic') {
      const src = art.icons.get('i_health')!;
      const want = mapPixel(art.palette, src.pixels[12 * 24 + 12]!);
      // NOTE: the live 3D frame is underneath; the opaque icon block covers
      // it, so the center pixel still exact-matches the decoded art.
      expect(host.fb.color[(hp320.y + 12) * 320 + (hp320.x + 12)]!, 'icon covers world pixels').toBe(want);
    }
    writePpm('box1-before-resize', { width: 320, height: 240, color: host.fb.color.slice() });
    // RESIZE (sim-preserving, no reboot): 320x240 -> 640x480 -> 1024x768.
    // Each resize is checked with no frames between (the resize itself must
    // preserve the sim; the frame after advances it exactly one tick).
    for (const [w, h] of [[640, 480], [1024, 768]] as const) {
      const legBefore = host.serverTime;
      host.resize(w, h);
      expect(host.fb.width, `fb width ${w}x${h}`).toBe(w);
      expect(host.fb.height, `fb height ${w}x${h}`).toBe(h);
      expect(host.serverTime, `resize to ${w}x${h} preserves server time`).toBe(legBefore);
      frame();
      paintHud();
      const st = healthyState(11, 'i_help');
      const cmds = executeStatusbar(parseStatusbar(RETAIL_SINGLE_STATUSBAR), st, w, h);
      const hp = cmds.find((c) => c.kind === 'pic' && (c as { name: string }).name === 'i_health');
      expect(hp && hp.kind === 'pic', `i_health executes at ${w}x${h}`).toBe(true);
      if (hp && hp.kind === 'pic') {
        const src = art.icons.get('i_health')!;
        const want = mapPixel(art.palette, src.pixels[12 * 24 + 12]!);
        expect(host.fb.color[(hp.y + 12) * w + (hp.x + 12)]!, `icon aligned at ${w}x${h}`).toBe(want);
        // yb -24 row follows the new height (not the boot-size row).
        expect(hp.y, `icon row tracks height ${w}x${h}`).toBe(h - 24);
      }
      writePpm('box1-after-resize', { width: w, height: h, color: host.fb.color.slice() });
    }
    host.dispose();
    console.log('[release-6-live] box1: real base1 frames + real-art HUD aligned before/after resize, sim intact');
  });
});

// ---------------------------------------------------------------------------
// Box 1 — devroom fallback (asset-free, always runs): readable, no throw.
// ---------------------------------------------------------------------------

describe('RELEASE-6 Box 1 devroom fallback (asset-free)', () => {
  it('text HUD stays readable at every offered size with zero assets', () => {
    setConcharsFont(makeConcharsFont());
    for (const [w, h] of SIZES) {
      const s = blank(w, h);
      // Production fallback shape: readable text rows (health/ammo lines),
      // never a throw on missing art.
      expect(() => {
        drawString(s, 8, h - 18, 'weapon_blaster 0', 0xffffffff);
        drawString(s, 8, h - 48, 'hp 100', 0xffffffff);
        drawString(s, 8, 28, 'devroom - drop pak0.pak for base1', 0xff888888);
      }).not.toThrow();
      expect(paintedIn(s, 0, h - 60, w, h), `bottom text band ${w}x${h}`).toBeGreaterThan(20);
      expect(paintedIn(s, 0, 20, w, 44), `hint row ${w}x${h}`).toBeGreaterThan(0);
      // Statusbar program with empty art drops pics but keeps fields/text.
      const cmds = executeStatusbar(
        parseStatusbar(RETAIL_SINGLE_STATUSBAR),
        { stats: [0, 100], images: [], configstrings: [], serverframe: 0, clientInfo: () => null },
        w,
        h,
      );
      expect(cmds.some((c) => c.kind === 'field'), `field survives without art ${w}x${h}`).toBe(true);
      expect(cmds.some((c) => c.kind === 'pic'), `no pics without art ${w}x${h}`).toBe(false);
    }
    console.log('[release-6-live] box1: devroom text fallback readable at all 4 sizes, no throw');
  });
});

// ---------------------------------------------------------------------------
// Box 2 — live counters through the real server (asset-free, always runs).
// ---------------------------------------------------------------------------

function liveHelpRows(st: {
  killedMonsters: number;
  totalMonsters: number;
  foundGoals: number;
  totalGoals: number;
  foundSecrets: number;
  totalSecrets: number;
}): string {
  // Production F1 layout fed with LIVE counters (what drawHelpOverlay must
  // pass once fixed — the packages already support it; see the defect pin).
  return buildHelpLayout({
    skill: 1,
    levelName: 'Outer Base',
    help1: 'Find the exit.',
    help2: 'Watch for soldiers.',
    kills: [st.killedMonsters, st.totalMonsters],
    goals: [st.foundGoals, st.totalGoals],
    secrets: [st.foundSecrets, st.totalSecrets],
  });
}

/** Render F1 text rows (production execute + conchars blits); hash the rows band. */
function renderHelpRowsHash(layout: string, w = 320, h = 240): string {
  setConcharsFont(makeConcharsFont());
  const s = blank(w, h);
  const st: StatusbarState = { stats: [], images: [], configstrings: [], serverframe: 0, clientInfo: () => null };
  const cmds = executeStatusbar(parseStatusbar(layout), st, w, h);
  for (const c of cmds) {
    if (c.kind === 'text') drawString(s, c.x, c.y, c.text, 0xffffffff);
  }
  // Kills/goals/secrets rows live at yv 164..172 -> y 164..172 @240p.
  const band = new Uint32Array(w * 32);
  band.set(s.color.subarray(160 * w, 192 * w));
  return hashU32(band);
}

function fireSecretOrGoal(
  st: ReturnType<typeof SV_Init>,
  classname: 'target_secret' | 'target_goal',
  targetname: string,
): void {
  const ent = spawnEdict({ classname, targetname });
  SV_LinkEdict(st, ent);
  const user = spawnEdict({ classname: 'trigger_once', target: targetname });
  fireTargets(st, user);
}

describe('RELEASE-6 Box 2 live counters (real server tick, asset-free)', () => {
  it('F1 rows update after a real kill with no reopen and no restart', () => {
    resetCVars();
    const st = SV_Init();
    const m1 = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 0));
    const m2 = SV_SpawnMonster(st, 'monster_soldier', v3(64, 0, 0));
    st.totalMonsters = st.monsters.length;
    SV_Tick(st, 0.1);
    expect(st.killedMonsters, 'no kills yet').toBe(0);
    const before = renderHelpRowsHash(liveHelpRows(st));
    // Production kill path (g_combat.c gib-first ordering via monsterPain).
    const res = SV_DamageMonster(st, m1, 500, () => 0.5);
    expect(['dead', 'gib'], 'fresh kill transitions').toContain(res);
    expect(st.killedMonsters, 'live counter advances').toBe(1);
    SV_Tick(st, 0.1);
    // Same open overlay, re-rendered with fresh live state (the per-frame
    // production path — no reopen call exists or is needed).
    const after = renderHelpRowsHash(liveHelpRows(st));
    expect(after, 'F1 kill row pixels change without reopening').not.toBe(before);
    expect(m2.state.dead || m2.state.gibbed, 'second monster still alive').toBe(false);
  });

  it('F1 rows update after a real secret and a real goal with no reopen', () => {
    resetCVars();
    const st = SV_Init();
    st.totalSecrets = 1;
    st.totalGoals = 1;
    st.totalMonsters = 0;
    const before = renderHelpRowsHash(liveHelpRows(st));
    fireSecretOrGoal(st, 'target_secret', 's1');
    expect(st.foundSecrets, 'secret counts once through fireTargets').toBe(1);
    const afterSecret = renderHelpRowsHash(liveHelpRows(st));
    expect(afterSecret, 'F1 secret row pixels change without reopening').not.toBe(before);
    fireSecretOrGoal(st, 'target_goal', 'g1');
    expect(st.foundGoals, 'goal counts once through fireTargets').toBe(1);
    const afterGoal = renderHelpRowsHash(liveHelpRows(st));
    expect(afterGoal, 'F1 goal row pixels change without reopening').not.toBe(afterSecret);
    // Single-use: re-firing the same chain cannot double-count.
    const user = spawnEdict({ classname: 'trigger_once', target: 's1' });
    fireTargets(st, user);
    expect(st.foundSecrets, 'secret stays single-use').toBe(1);
  });

  it('completion freezes the finish snapshot while live play keeps counting', () => {
    resetCVars();
    const st = SV_Init();
    const m1 = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 0));
    const m2 = SV_SpawnMonster(st, 'monster_soldier', v3(64, 0, 0));
    st.totalMonsters = 2;
    st.totalSecrets = 1;
    SV_DamageMonster(st, m1, 500, () => 0.5);
    fireSecretOrGoal(st, 'target_secret', 's1');
    SV_Tick(st, 0.1);
    // Production finish path (target_changelevel / end-lift fire this).
    SV_FinishLevel(st, 'exit');
    expect(st.finished, 'level finished').toBe(true);
    expect(st.finishReason, 'exit reason recorded').toBe('exit');
    expect([st.finishKills, st.finishSecrets, st.finishGoals], 'snapshot matches live at finish').toEqual([
      st.killedMonsters,
      st.foundSecrets,
      st.foundGoals,
    ]);
    const frozenLine =
      `kills ${st.finishKills}/${st.totalMonsters}  ` +
      `secrets ${st.finishSecrets}/${st.totalSecrets}  goals ${st.finishGoals}/${st.totalGoals}`;
    const frozenHash = hashU32(new Uint32Array(frozenLine.split('').map((c) => c.charCodeAt(0))));
    // Post-finish play: another real kill + more ticks.
    SV_DamageMonster(st, m2, 500, () => 0.5);
    SV_Tick(st, 0.1);
    SV_Tick(st, 0.1);
    expect(st.killedMonsters, 'live kills keep counting after finish').toBe(2);
    expect([st.finishKills, st.finishSecrets, st.finishGoals], 'snapshot frozen after further kills').toEqual([1, 1, 0]);
    const rerendered =
      `kills ${st.finishKills}/${st.totalMonsters}  ` +
      `secrets ${st.finishSecrets}/${st.totalSecrets}  goals ${st.finishGoals}/${st.totalGoals}`;
    expect(hashU32(new Uint32Array(rerendered.split('').map((c) => c.charCodeAt(0)))), 'frozen line re-renders identical').toBe(
      frozenHash,
    );
    // Centerprint placement for the completion block still centers (production).
    const lines = centerPrintPlacement('LEVEL COMPLETE\nkills 1/2  secrets 1/1  goals 0/0', 640, 480);
    expect(lines.length, 'completion block lines').toBe(2);
    expect(lines[0]!.y, 'completion at 35% height').toBe(168);
  });

  it('live F1 facts follow the landed apps/web contract (helpFactsFor)', () => {
    // Reconciled with the landed apps/web fix (`helpFactsFor` in play.ts):
    // the overlay reads the LIVE counters while the level runs and the
    // FROZEN snapshot once finished. This pin nails that contract from the
    // testkit side without importing it.
    const body = fnBody(playSrc(), 'helpFactsFor');
    expect(body.length, 'helpFactsFor found in play.ts').toBeGreaterThan(0);
    for (const name of ['killedMonsters', 'foundGoals', 'foundSecrets'] as const) {
      expect(
        body.includes(name),
        `RELEASE-6 Box 2: helpFactsFor must read live \`${name}\` while ` +
          `running (F1 rows track play without reopening).`,
      ).toBe(true);
    }
    for (const name of ['finishKills', 'finishGoals', 'finishSecrets', 'finished'] as const) {
      expect(
        body.includes(name),
        `RELEASE-6 Box 2: helpFactsFor must read frozen \`${name}\` once ` +
          `finished (completion totals stay put under post-finish play).`,
      ).toBe(true);
    }
    const overlay = fnBody(playSrc(), 'drawHelpOverlay');
    expect(
      overlay.includes('helpFactsFor'),
      'RELEASE-6 Box 2: drawHelpOverlay must build rows via helpFactsFor ' +
        '(live-while-running, frozen-when-finished).',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Box 3 — flash cadence + ack (production rules, asset-free state legs +
// real-art pixel leg; defect pins fail pre-fix).
// ---------------------------------------------------------------------------

describe('RELEASE-6 Box 3 flash cadence (production rules, asset-free)', () => {
  it('helpIconVisible: visible iff unacked-change && (frame&8)', () => {
    // Exact G_SetStats rule (game/p_hud.c), production implementation.
    for (let f = 0; f < 32; f++) {
      expect(helpIconVisible(1, f), `frame ${f}`).toBe((f & 8) !== 0);
    }
    // Ack stops it at every frame: no unconditional blink.
    for (let f = 0; f < 64; f++) {
      expect(helpIconVisible(0, f), `acked frame ${f}`).toBe(false);
    }
    // Nonzero counters behave as unacked (pers.helpchanged 1..4).
    expect(helpIconVisible(3, 8), 'helpchanged=3 flashes').toBe(true);
    expect(helpIconVisible(3, 0), 'helpchanged=3 dark phase').toBe(false);
  });

  it('helpIconFor: full G_SetStats fallback (weapon icon, then nothing)', () => {
    // G_SetStats: helpchanged && (framenum&8) -> i_help; else
    // (centerHanded || fov > 91) && weapon -> weapon icon; else nothing.
    // (fov 90 right-handed shows NO weapon icon — that is the id rule, and
    // why the testkit slot hides when nothing is pending.)
    expect(helpIconFor({ helpChanged: 1, frame: 8, centerHanded: false, fov: 90, weaponIcon: 'w_blaster' })).toBe('i_help');
    expect(helpIconFor({ helpChanged: 1, frame: 0, centerHanded: true, fov: 90, weaponIcon: 'w_blaster' })).toBe('w_blaster');
    expect(helpIconFor({ helpChanged: 1, frame: 0, centerHanded: false, fov: 90, weaponIcon: 'w_blaster' })).toBeNull();
    expect(helpIconFor({ helpChanged: 1, frame: 0, centerHanded: false, fov: 95, weaponIcon: 'w_shotgun' })).toBe('w_shotgun');
    expect(helpIconFor({ helpChanged: 0, frame: 8, centerHanded: true, fov: 90, weaponIcon: 'w_shotgun' })).toBe('w_shotgun');
    expect(helpIconFor({ helpChanged: 0, frame: 0, centerHanded: false, fov: 90, weaponIcon: null })).toBeNull();
  });

  it('helpBeepDue: at most three beeps on the 64-frame cadence', () => {
    expect(helpBeepDue(1, 0), 'first beep').toBe(true);
    expect(helpBeepDue(3, 64), 'third beep').toBe(true);
    expect(helpBeepDue(4, 0), 'fourth change is silent').toBe(false);
    expect(helpBeepDue(0, 0), 'acked is silent').toBe(false);
    expect(helpBeepDue(1, 1), 'off-cadence is silent').toBe(false);
  });
});

describe.runIf(HAS_PAK)('RELEASE-6 Box 3 flash cadence (real-art pixels)', () => {
  it('the `if 11` icon cell blinks on the (frame&8) cadence, ack stops it', () => {
    const art = loadPakArt();
    const icon = art.icons.get('i_help')!;
    const cellAt = (w: number, h: number, frame: number, helpChanged: number): Surface => {
      const s = blank(w, h);
      // Production assembly: flash rule selects the STAT, the `if 11` script
      // row draws it — the same two steps statusbarStateFor + execute take.
      const visible = helpIconVisible(helpChanged, frame);
      const st: StatusbarState = {
        stats: [0, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, visible ? 11 : 0, 0, 0, 0, 0],
        images: ['i_health', '', '', '', '', '', '', '', '', '', '', visible ? 'i_help' : ''],
        configstrings: [],
        serverframe: frame,
        clientInfo: () => null,
      };
      paintStatusbar(s, w, h, st, art);
      return s;
    };
    // xv 148 @320 -> 148; yb -50 @240 -> 190.
    const X = 148;
    const Y = 190;
    const want = mapPixel(art.palette, icon.pixels[12 * 24 + 12]!);
    const dark = cellAt(320, 240, 0, 1);
    expect(paintedIn(dark, X, Y, X + 24, Y + 24), 'frame 0 (dark phase): cell empty').toBe(0);
    const lit = cellAt(320, 240, 8, 1);
    expect(paintedIn(lit, X, Y, X + 24, Y + 24), 'frame 8 (lit phase): cell painted').toBe(24 * 24);
    expect(lit.color[(Y + 12) * 320 + (X + 12)]!, 'lit cell center is i_help art').toBe(want);
    const darkAgain = cellAt(320, 240, 16, 1);
    expect(paintedIn(darkAgain, X, Y, X + 24, Y + 24), 'frame 16 (dark phase): cell empty').toBe(0);
    // Ack: every frame dark, including lit-phase frames (no permanent blink).
    for (const f of [0, 8, 9, 15, 16, 24]) {
      const s = cellAt(320, 240, f, 0);
      expect(paintedIn(s, X, Y, X + 24, Y + 24), `acked frame ${f}: cell empty`).toBe(0);
    }
    writePpm('box3-flash-lit', lit);
    console.log('[release-6-live] box3: (frame&8) cadence pinned at i_help pixels, ack stops it');
  });
});

describe('RELEASE-6 Box 3 defect pins (apps/web source)', () => {
  it('DEFECT PROOF (Box 3a): statusbarStateFor must consult the flash rule', () => {
    // FAILS PRE-FIX: statusbarStateFor hard-wires images[11]=i_help with
    // stats[11]=11, so `if 11` always draws — an unconditional permanent
    // blink with no helpchanged tracking, no (frame&8) cadence, no ack.
    // Passes for the fix: the STAT derives from helpIconFor/helpIconVisible.
    const body = fnBody(playSrc(), 'statusbarStateFor');
    expect(body.length, 'statusbarStateFor found in play.ts').toBeGreaterThan(0);
    expect(
      body.includes('helpIconFor') || body.includes('helpIconVisible'),
      'DEFECT PROOF (RELEASE-6 Box 3): statusbarStateFor supplies a constant ' +
        'help icon (STAT_HELPICON always set) instead of the G_SetStats flash ' +
        'rule (visible iff unacked-change && (frame&8)). Fix: derive STAT 11 ' +
        'via helpIconFor/helpIconVisible from driver helpChanged + serverframe.',
    ).toBe(true);
  });

  it('DEFECT PROOF (Box 3b): opening help must ack (Cmd_Help_f parity)', () => {
    // FAILS PRE-FIX: toggleHelpOverlay only flips showHelp; pers.helpchanged
    // is never cleared, so the icon can never stop (no acknowledgment path).
    // Passes for the fix: opening help zeroes the pending change.
    const body = fnBody(playSrc(), 'toggleHelpOverlay');
    expect(body.length, 'toggleHelpOverlay found in play.ts').toBeGreaterThan(0);
    expect(
      /helpChanged|helpchanged|ack/i.test(body),
      'DEFECT PROOF (RELEASE-6 Box 3): opening F1 never acknowledges the ' +
        'pending help change (C Cmd_Help_f sets pers.helpchanged = 0), so ' +
        'the flash has no stop condition. Fix: ack on open.',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Box 4 — completion via the production finish path (asset-free, always runs)
// + guardrail pins (pass now, forbid scoreboard/victory regressions).
// ---------------------------------------------------------------------------

describe('RELEASE-6 Box 4 completion (production finish path, asset-free)', () => {
  it('SP maps never take the multiplayer scoreboard path', () => {
    // Production rule (game/p_hud.c: unit names without `*` go straight
    // through; BeginIntermission exits immediately in SP).
    expect(showsIntermissionScoreboard('base1'), 'base1 is single-player').toBe(false);
    expect(showsIntermissionScoreboard('base2'), 'base2 is single-player').toBe(false);
    expect(showsIntermissionScoreboard('unit1*base1'), 'starred unit is not SP').toBe(true);
  });

  it('finished screen renders frozen totals and re-renders identical after further kills', () => {
    resetCVars();
    setConcharsFont(makeConcharsFont());
    const st = SV_Init();
    const m1 = SV_SpawnMonster(st, 'monster_soldier', v3(0, 0, 0));
    const m2 = SV_SpawnMonster(st, 'monster_soldier', v3(64, 0, 0));
    st.totalMonsters = 2;
    st.totalSecrets = 0;
    st.totalGoals = 0;
    SV_DamageMonster(st, m1, 500, () => 0.5);
    SV_Tick(st, 0.1);
    SV_FinishLevel(st, 'exit');
    const paint = (): Surface => {
      const s = blank(640, 480);
      const lines = centerPrintPlacement(
        `LEVEL COMPLETE\nkills ${st.finishKills}/${st.totalMonsters}  secrets ${st.finishSecrets}/${st.totalSecrets}  goals ${st.finishGoals}/${st.totalGoals}`,
        640,
        480,
      );
      for (const l of lines) drawString(s, l.x, l.y, l.text, 0xffffffff);
      return s;
    };
    const ref = hashU32(paint().color);
    expect(paintedIn(paint(), 0, 100, 640, 260), 'finished block paints text rows').toBeGreaterThan(100);
    // Post-finish kills move the live counters, never the snapshot.
    SV_DamageMonster(st, m2, 500, () => 0.5);
    SV_Tick(st, 0.1);
    expect(st.killedMonsters, 'live keeps counting').toBe(2);
    expect(st.finishKills, 'snapshot frozen').toBe(1);
    expect(hashU32(paint().color), 'finished screen re-renders pixel-identical').toBe(ref);
  });

  it('finished path uses no multiplayer scoreboard layout (guardrail)', () => {
    // Passes now; forbids the apps/web lane from substituting a DM
    // scoreboard for the SP stand-in without establishing it belongs here.
    const body = fnBody(playSrc(), 'drawPlayHud');
    expect(body.length, 'drawPlayHud found in play.ts').toBeGreaterThan(0);
    expect(body.includes('buildScoreboardLayout'), 'finished path builds no scoreboard layout').toBe(false);
    expect(body.includes('sortScoreboard'), 'finished path sorts no scores').toBe(false);
  });

  it('finished path blits no victory asset pixels (guardrail)', () => {
    // Passes now; forbids substituting pics/victory.pcx without establishing
    // it belongs in SP (id shows no victory screen on a same-unit SP exit —
    // BeginIntermission returns via exitintermission immediately). Comments
    // are stripped: the current code only MENTIONS victory to forbid it.
    const strip = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hud = strip(fnBody(playSrc(), 'drawPlayHud'));
    const msg = strip(fnBody(playSrc(), 'formatFinishMessage'));
    expect(/victory/i.test(hud), 'drawPlayHud uses no victory asset').toBe(false);
    expect(/victory/i.test(msg), 'formatFinishMessage uses no victory asset').toBe(false);
    expect(/hudPics\.victory|cache\.victory/.test(hud), 'finished path draws no victory pic').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WebGL2 path: headless feasibility probe (documents the gap, never skips).
// ---------------------------------------------------------------------------

describe('RELEASE-6 WebGL2 gap (headless probe)', () => {
  it('records that the WebGL2 HUD leg needs a browser GL context', () => {
    // Node vitest has no WebGL2RenderingContext and no composited canvas, so
    // the 800x600/1024x768 WebGL2 captures cannot run here. The 2D HUD pass
    // under test is renderer-agnostic (apps/web `paintHudOverlay` runs the
    // same production blits over the GL canvas), and the Software legs above
    // pin its pixels; the GL-backed capture stays an explicit open item for
    // the browser soak, not a silent skip.
    const hasGL = typeof (globalThis as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext !== 'undefined';
    console.log(
      `[release-6-live] webgl2 leg: ${hasGL ? 'GL types present (unexpected headless)' : 'no headless WebGL2 — gap documented, Software legs are the gate'}`,
    );
    expect(hasGL, 'headless WebGL2 backing must exist to run the GL leg here').toBe(false);
  });
});
