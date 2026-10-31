// @q2/testkit — RELEASE-6 HUD/F1/completion coverage (formats+client lane).
//
// Covers the LANDED formats manifest + client execution/geometry semantics
// through the PRODUCTION code paths (no mirrors, no reimplementation):
//   - 79-pic HUD manifest (digits, field, icons, font, backgrounds,
//     crosshairs, overlays, victory screen) + checkHudPic validator
//   - single-player statusbar script execution at 640x480 and 1024x768,
//     incl. flash/death legs
//   - F1 help layout build + parse/execute round-trip
//   - scoreboard sort/cells/tags + layout build + parse/execute round-trip
//   - centerprint placement (completion + death) at both resolutions
//   - inventory layout geometry (centered pic, rows, scroll, blink cursor)
//
// Legs:
//   - asset-free legs always run (devroom fallback: every builder works with
//     zero pak reads; missing images drop pic cmds without throwing while
//     out-of-range stat values fail closed);
//   - real-asset legs (Q2_PAK) validate every manifest entry against the
//     retail lumps and tie executed pic names back to the manifest.
//
// Ground-truth sources are named per section: `game/g_spawn.c`
// (single_statusbar), `game/p_hud.c` (HelpComputer, scoreboard, intermission),
// `client/cl_scrn.c` (SCR_ExecuteLayoutString, SCR_DrawField, centerprint),
// `client/cl_inv.c` (CL_DrawInventory), verified against the sibling id
// source tree (../external/quake-2-source). Expected coordinates below are
// hand-computed from those algorithms, not from the functions under test.
//
// A task card says "78-pic manifest"; the landed manifest holds 79 entries
// (the count below documents the split). If the card is taken as normative
// the manifest — not this test — must change under a major changeset.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { PakFile } from '@q2/filesystem';
import {
  HUD_PICS,
  PIC_TRANSPARENT,
  checkHudPic,
  digitPicName,
  hudPicByName,
  hudPicTransparentExpected,
  parsePCX,
} from '@q2/formats';
import {
  buildHelpLayout,
  buildScoreboardLayout,
  centerPrintPlacement,
  DISPLAY_ITEMS,
  executeStatusbar,
  FLASH_AMMO,
  FLASH_ARMOR,
  FLASH_FIELD_PIC,
  FLASH_HEALTH,
  formatInventoryRow,
  HELP_H,
  HELP_PIC,
  HELP_W,
  INVENTORY_H,
  INVENTORY_HEADER_1,
  INVENTORY_PIC,
  INVENTORY_W,
  layoutInventory,
  MAX_CLIENTS,
  MAX_IMAGES,
  pad3,
  parseStatusbar,
  scoreCell,
  scoreTag,
  showsIntermissionScoreboard,
  skillName,
  sortScoreboard,
  STAT_FLASHES,
  type ScoreEntry,
  type StatusbarState,
  type StatusDrawCmd,
} from '@q2/client';

// Documented seam: the retail single-player script (`game/g_spawn.c:
// single_statusbar`, duplicated by value — whitespace-insensitive under the
// production tokenizer; verified byte-for-byte against
// ../external/quake-2-source/game/g_spawn.c apart from tab/space runs).
const SINGLE_STATUSBAR =
  'yb -24 xv 0 hnum xv 50 pic 0 ' +
  'if 2 xv 100 anum xv 150 pic 2 endif ' +
  'if 4 xv 200 rnum xv 250 pic 4 endif ' +
  'if 6 xv 296 pic 6 endif ' +
  'yb -50 if 7 xv 0 pic 7 xv 26 yb -42 stat_string 8 yb -50 endif ' +
  'if 9 xv 262 num 2 10 xv 296 pic 9 endif ' +
  'if 11 xv 148 pic 11 endif';

function state(over: Partial<StatusbarState> = {}): StatusbarState {
  return {
    stats: [],
    images: [],
    configstrings: [],
    serverframe: 0,
    clientInfo: () => null,
    ...over,
  };
}

const Q2_PAK = process.env.Q2_PAK;

function loadPak(): PakFile {
  const bytes = readFileSync(Q2_PAK as string);
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return new PakFile(buf);
}

function parsePakPcx(pak: PakFile, name: string): { width: number; height: number; pixels: Uint8Array } {
  const pcx = parsePCX(pak.readFile(name));
  return { width: pcx.width, height: pcx.height, pixels: pcx.pixels };
}

// ---------------------------------------------------------------------------
// Manifest (asset-free)
// ---------------------------------------------------------------------------

describe('RELEASE-6 HUD manifest (asset-free)', () => {
  it('holds 79 entries with unique pak paths', () => {
    // 22 status digits (num+anum incl. minus) + field_3 + 44 icons +
    // conchars font + help/inventory backgrounds + 3 crosshairs +
    // tag1/tag2/net/pause/loading overlays + victory screen = 79.
    expect(HUD_PICS.length).toBe(79);
    expect(new Set(HUD_PICS.map((p) => p.name)).size).toBe(HUD_PICS.length);
    for (const p of HUD_PICS) {
      expect(p.name.startsWith('pics/')).toBe(true);
      expect(p.name.endsWith('.pcx')).toBe(true);
    }
  });

  it('digitPicName round-trips both sets plus the minus sign', () => {
    for (const style of ['num', 'anum'] as const) {
      for (let d = 0; d <= 9; d++) {
        expect(hudPicByName(digitPicName(style, d))).toMatchObject({ width: 16, height: 24 });
      }
      expect(hudPicByName(digitPicName(style, -1))).toMatchObject({ width: 16, height: 24 });
    }
    expect(hudPicByName('pics/nope.pcx')).toBeUndefined();
    // Negative controls: out-of-range digits fail closed (Com_Error).
    expect(() => digitPicName('num', 10)).toThrow();
    expect(() => digitPicName('num', -2)).toThrow();
  });

  it('declares icons, backgrounds, crosshairs, overlays and the victory screen', () => {
    expect(hudPicByName('pics/i_health.pcx')).toMatchObject({ width: 24, height: 24, kind: 'icon' });
    expect(hudPicByName('pics/w_blaster.pcx')).toMatchObject({ width: 24, height: 24, kind: 'icon' });
    expect(hudPicByName('pics/field_3.pcx')).toMatchObject({ width: 48, height: 24, kind: 'field' });
    expect(hudPicByName('pics/conchars.pcx')).toMatchObject({ width: 128, height: 128, kind: 'font' });
    expect(hudPicByName('pics/help.pcx')).toMatchObject({ width: 256, height: 192, kind: 'background' });
    expect(hudPicByName('pics/inventory.pcx')).toMatchObject({ width: 256, height: 192, kind: 'background' });
    expect(hudPicByName('pics/ch1.pcx')).toMatchObject({ width: 8, height: 8, kind: 'crosshair' });
    expect(hudPicByName('pics/tag1.pcx')).toMatchObject({ width: 128, height: 32, kind: 'overlay' });
    expect(hudPicByName('pics/victory.pcx')).toMatchObject({ width: 320, height: 240, kind: 'screen' });
  });

  it('cutout art expects transparency, opaque blocks do not', () => {
    expect(hudPicTransparentExpected('digit')).toBe(true);
    expect(hudPicTransparentExpected('anum')).toBe(true);
    expect(hudPicTransparentExpected('crosshair')).toBe(true);
    expect(hudPicTransparentExpected('overlay')).toBe(true);
    expect(hudPicTransparentExpected('icon')).toBe(false);
    expect(hudPicTransparentExpected('field')).toBe(false);
    expect(hudPicTransparentExpected('font')).toBe(false);
    expect(hudPicTransparentExpected('background')).toBe(false);
    expect(hudPicTransparentExpected('screen')).toBe(false);
  });

  it('checkHudPic is live: flags dimension, coverage and transparency problems', () => {
    const spec = hudPicByName('pics/num_0.pcx')!;
    const good = new Uint8Array(16 * 24).fill(PIC_TRANSPARENT);
    good[0] = 1;
    good[1] = 2;
    expect(checkHudPic(spec, { width: 16, height: 24, pixels: good })).toEqual([]);
    // Wrong dimensions.
    expect(checkHudPic(spec, { width: 8, height: 8, pixels: new Uint8Array(64) }).length).toBeGreaterThan(0);
    // Truncated buffer.
    expect(checkHudPic(spec, { width: 16, height: 24, pixels: new Uint8Array(10) }).length).toBeGreaterThan(0);
    // Flat art (single palette index).
    expect(checkHudPic(spec, { width: 16, height: 24, pixels: new Uint8Array(16 * 24).fill(7) })).toContain(
      'flat art (single palette index)',
    );
    // Cutout without any transparent pixel.
    const opaque = new Uint8Array(16 * 24).fill(7);
    opaque[0] = 8;
    expect(checkHudPic(spec, { width: 16, height: 24, pixels: opaque })).toContain(
      'cutout art has no transparent pixels',
    );
    // Fully transparent.
    expect(
      checkHudPic(spec, { width: 16, height: 24, pixels: new Uint8Array(16 * 24).fill(PIC_TRANSPARENT) }),
    ).toContain('fully transparent');
  });
});

// ---------------------------------------------------------------------------
// Real-asset manifest validation (Q2_PAK)
// ---------------------------------------------------------------------------

describe.runIf(!!Q2_PAK && existsSync(Q2_PAK as string))('RELEASE-6 real HUD pics (Q2_PAK)', () => {
  it('every manifest entry exists with the declared dimensions and valid art', () => {
    const pak = loadPak();
    for (const spec of HUD_PICS) {
      const pic = parsePakPcx(pak, spec.name);
      expect([pic.width, pic.height], spec.name).toEqual([spec.width, spec.height]);
      expect(checkHudPic(spec, pic), spec.name).toEqual([]);
    }
    console.log(`[release-6] validated ${HUD_PICS.length} HUD pics against Q2_PAK`);
  });

  it('alert digits are distinct baked art, icons are opaque blocks', () => {
    const pak = loadPak();
    const n0 = parsePakPcx(pak, 'pics/num_0.pcx');
    const a0 = parsePakPcx(pak, 'pics/anum_0.pcx');
    expect([n0.width, n0.height]).toEqual([a0.width, a0.height]);
    // Same glyph shape class but distinct baked art (not a runtime tint).
    expect(n0.pixels).not.toEqual(a0.pixels);
    for (const name of ['pics/i_health.pcx', 'pics/w_blaster.pcx', 'pics/field_3.pcx']) {
      const pic = parsePakPcx(pak, name);
      expect(pic.pixels.includes(PIC_TRANSPARENT), name).toBe(false);
    }
  });

  it('F1/inventory/completion backgrounds are present at full-screen sizes', () => {
    const pak = loadPak();
    expect([parsePakPcx(pak, 'pics/help.pcx').width, parsePakPcx(pak, 'pics/help.pcx').height]).toEqual([256, 192]);
    expect([parsePakPcx(pak, 'pics/inventory.pcx').width, parsePakPcx(pak, 'pics/inventory.pcx').height]).toEqual([
      256, 192,
    ]);
    const victory = parsePakPcx(pak, 'pics/victory.pcx');
    expect([victory.width, victory.height]).toEqual([320, 240]);
    expect(checkHudPic(hudPicByName('pics/victory.pcx')!, victory)).toEqual([]);
  });

  it('negative control: tampered real art fails the validator', () => {
    const pak = loadPak();
    const real = parsePakPcx(pak, 'pics/num_0.pcx');
    const wiped = new Uint8Array(real.pixels).fill(PIC_TRANSPARENT);
    expect(checkHudPic(hudPicByName('pics/num_0.pcx')!, { ...real, pixels: wiped })).toContain('fully transparent');
    const shrunk = { ...real, width: 8, height: 8, pixels: real.pixels.slice(0, 64) };
    expect(checkHudPic(hudPicByName('pics/num_0.pcx')!, shrunk).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Statusbar execution (asset-free, retail script)
// ---------------------------------------------------------------------------

describe('RELEASE-6 statusbar execution (asset-free)', () => {
  const ops = parseStatusbar(SINGLE_STATUSBAR);
  const healthy = (over: Partial<StatusbarState> = {}): StatusbarState =>
    state({
      stats: [0, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      images: ['i_health'],
      ...over,
    });

  it('draws the health field + icon at 640x480 (id xv/yb math)', () => {
    const cmds = executeStatusbar(ops, healthy(), 640, 480);
    // xv 0 @640 -> 160; yb -24 @480 -> 456; hnum width 3; pic at xv 50 -> 210.
    expect(cmds).toEqual([
      { kind: 'field', x: 160, y: 456, style: 'num', width: 3, value: 100 },
      { kind: 'pic', x: 210, y: 456, name: 'i_health' },
    ]);
  });

  it('places the same rows at 1024x768', () => {
    const cmds = executeStatusbar(ops, healthy(), 1024, 768);
    expect(cmds).toEqual([
      { kind: 'field', x: 352, y: 744, style: 'num', width: 3, value: 100 },
      { kind: 'pic', x: 402, y: 744, name: 'i_health' },
    ]);
  });

  it('draws the ammo row only when the ammo icon stat is set', () => {
    const withAmmo = healthy({ stats: [0, 100, 2, 12, 0, 0, 0, 0, 0, 0, 0, 0], images: ['i_health', 'x', 'a_bullets'] });
    const cmds = executeStatusbar(ops, withAmmo, 320, 240);
    expect(cmds).toContainEqual({ kind: 'field', x: 100, y: 216, style: 'num', width: 3, value: 12 });
    expect(cmds).toContainEqual({ kind: 'pic', x: 150, y: 216, name: 'a_bullets' });
  });

  it('flashes low health with field_3 and the alert digit set (blink pair)', () => {
    const stats = [0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, FLASH_HEALTH];
    const blinking = executeStatusbar(ops, healthy({ stats, serverframe: 4 }), 320, 240);
    expect(blinking[0]).toEqual({ kind: 'pic', x: 0, y: 216, name: 'field_3' });
    expect(blinking[1]).toMatchObject({ kind: 'field', style: 'anum', value: 10 });
    // Negative control: steady frame of the same state keeps the num set.
    const steady = executeStatusbar(ops, healthy({ stats, serverframe: 0 }), 320, 240);
    expect(steady[1]).toMatchObject({ kind: 'field', style: 'num', value: 10 });
  });

  it('death leg: zero health still draws the field (id draws hnum regardless)', () => {
    const cmds = executeStatusbar(ops, healthy({ stats: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }), 640, 480);
    expect(cmds).toContainEqual({ kind: 'field', x: 160, y: 456, style: 'num', width: 3, value: 0 });
    expect(cmds).toContainEqual({ kind: 'pic', x: 210, y: 456, name: 'i_health' });
  });

  it('skips armor below 1 and negative ammo, shows the pickup string', () => {
    const stats = [0, 100, 1, -3, 0, 0, 0, 3, 9, 0, 0, 0];
    const st = healthy({
      stats,
      images: ['i_health', 'x', 'a_cells', 'w_shotgun'],
      configstrings: ['x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'Shells'],
    });
    const cmds = executeStatusbar(ops, st, 320, 240);
    expect(cmds.some((c) => c.kind === 'field' && (c as { value: number }).value === -3)).toBe(false);
    expect(cmds).not.toContainEqual(expect.objectContaining({ kind: 'pic', name: 'i_jacketarmor' }));
    expect(cmds).toContainEqual({ kind: 'pic', x: 0, y: 190, name: 'w_shotgun' });
    expect(cmds).toContainEqual({ kind: 'text', x: 26, y: 198, text: 'Shells', alt: false, centerWidth: 0 });
  });

  it('every pic the retail script emits resolves in the formats manifest', () => {
    // Cross-package production link: client execution output x formats art.
    const toManifest = (name: string): string => `pics/${name}.pcx`;
    const st = healthy({
      stats: [0, 100, 2, 12, 4, 40, 6, 7, 8, 9, 10, 11, 0, 0, 0, FLASH_HEALTH | FLASH_ARMOR],
      images: ['i_health', 'x', 'a_bullets', 'x', 'i_bodyarmor', 'x', 'w_shotgun', 'i_pack', 'x', 'i_help', 'x', 'i_help'],
      configstrings: ['x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'Timer!'],
      serverframe: 4,
    });
    const cmds = executeStatusbar(ops, st, 640, 480);
    const pics = cmds.filter((c) => c.kind === 'pic').map((c) => (c as { name: string }).name);
    expect(pics.length).toBeGreaterThan(2);
    for (const name of pics) {
      expect(hudPicByName(toManifest(name)), name).toBeDefined();
    }
  });

  it('negative controls: bad indices fail closed, empty strings are skipped', () => {
    expect(executeStatusbar(parseStatusbar('string "" picn ""'), state(), 320, 240)).toEqual([]);
    // Stat VALUE is the image index: MAX_IMAGES pictures in, the value is checked.
    expect(() => executeStatusbar(parseStatusbar('pic 0'), state({ stats: [MAX_IMAGES] }), 320, 240)).toThrow();
    expect(() => executeStatusbar(parseStatusbar('stat_string 8'), state({ stats: [0, 0, 0, 0, 0, 0, 0, 0, 99], configstrings: ['a'] }), 320, 240)).toThrow();
    expect(() =>
      executeStatusbar(parseStatusbar(`client 0 32 ${MAX_CLIENTS} 0 0 0`), state({ clientInfo: () => ({ name: 'x', icon: 'y' }) }), 320, 240),
    ).toThrow();
    // Unknown picn art executes without throwing (asset-free fallback tolerates it).
    const st = state({ clientInfo: () => ({ name: 'p', icon: 'i_fixme' }) });
    expect(() => executeStatusbar(parseStatusbar('xv 32 yv 8 picn nope_missing'), st, 640, 480)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// F1 help (asset-free)
// ---------------------------------------------------------------------------

describe('RELEASE-6 F1 help computer (asset-free)', () => {
  it('builds the id HelpComputer layout (background, skill, level, progress)', () => {
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
    expect(layout).toContain('"Outer Base"');
    expect(layout).toContain('kills     goals    secrets');
    // %3i right-aligned kill fraction.
    expect(layout).toContain('  3/ 10');
  });

  it('skill names and %3i padding follow id', () => {
    expect([skillName(0), skillName(1), skillName(2), skillName(3)]).toEqual(['easy', 'medium', 'hard', 'hard+']);
    expect(pad3(3)).toBe('  3');
    expect(pad3(10)).toBe(' 10');
    expect([HELP_PIC, HELP_W, HELP_H]).toEqual(['help', 256, 192]);
  });

  it('the built layout parses and executes through the production path', () => {
    const layout = buildHelpLayout({
      skill: 0,
      levelName: 'L',
      help1: 'H1',
      help2: 'H2',
      kills: [0, 5],
      goals: [0, 0],
      secrets: [0, 0],
    });
    const cmds = executeStatusbar(parseStatusbar(layout), state(), 640, 480);
    // xv 32 @640 -> 192; yv 8 @480 -> 128.
    expect(cmds).toContainEqual({ kind: 'pic', x: 192, y: 128, name: 'help' });
    expect(cmds.some((c) => c.kind === 'text' && (c as { text: string }).text === 'L')).toBe(true);
    // Skill line renders the easy label for skill 0.
    expect(cmds.some((c) => c.kind === 'text' && (c as { text: string }).text === 'easy')).toBe(true);
    // The background pic resolves in the formats manifest.
    expect(hudPicByName('pics/help.pcx')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scoreboard / completion / centerprint / inventory (asset-free)
// ---------------------------------------------------------------------------

describe('RELEASE-6 scoreboard and completion (asset-free)', () => {
  const entry = (over: Partial<ScoreEntry> = {}): ScoreEntry => ({
    slot: 0,
    score: 0,
    ping: 0,
    time: 0,
    self: false,
    killer: false,
    ...over,
  });

  it('single-player maps go straight through (no * = no scoreboard)', () => {
    expect(showsIntermissionScoreboard('base1')).toBe(false);
    expect(showsIntermissionScoreboard('base2')).toBe(false);
    expect(showsIntermissionScoreboard('unit1*base1')).toBe(true);
  });

  it('sorts by score descending, stable on ties, capped at 12', () => {
    const rows = [
      entry({ slot: 1, score: 5 }),
      entry({ slot: 2, score: 20 }),
      entry({ slot: 3, score: 20 }),
      entry({ slot: 4, score: -1 }),
    ];
    expect(sortScoreboard(rows).map((r) => r.slot)).toEqual([2, 3, 1, 4]);
    const many = Array.from({ length: 20 }, (_, i) => entry({ slot: i, score: i }));
    expect(sortScoreboard(many)).toHaveLength(12);
    expect(sortScoreboard(many)[0]!.score).toBe(19);
  });

  it('places two columns of six with self/killer dogtags', () => {
    expect(scoreCell(0)).toEqual({ x: 0, y: 32 });
    expect(scoreCell(5)).toEqual({ x: 0, y: 192 });
    expect(scoreCell(6)).toEqual({ x: 160, y: 32 });
    expect(scoreCell(11)).toEqual({ x: 160, y: 192 });
    expect(scoreTag(entry({ self: true, killer: true }))).toBe('tag1');
    expect(scoreTag(entry({ killer: true }))).toBe('tag2');
    expect(scoreTag(entry())).toBeNull();
  });

  it('builds the id scoreboard layout, executes it, and resolves every pic', () => {
    const layout = buildScoreboardLayout([
      entry({ slot: 0, score: 10, ping: 40, time: 60, self: true }),
      entry({ slot: 1, score: 5, ping: 9999, time: 61, killer: true }),
    ]);
    expect(layout).toBe(
      'xv 32 yv 32 picn tag1 client 0 32 0 10 40 60 xv 32 yv 64 picn tag2 client 0 64 1 5 9999 61 ',
    );
    const st: StatusbarState = {
      stats: [],
      images: [],
      configstrings: [],
      serverframe: 0,
      clientInfo: (slot) => (slot < 2 ? { name: `p${slot}`, icon: 'i_fixme' } : null),
    };
    const cmds = executeStatusbar(parseStatusbar(layout), st, 640, 480);
    expect(cmds).toContainEqual({ kind: 'pic', x: 192, y: 152, name: 'tag1' });
    expect(cmds).toContainEqual({ kind: 'client', x: 160, y: 152, slot: 0, score: 10, ping: 40, time: 60 });
    expect(cmds).toContainEqual({ kind: 'pic', x: 192, y: 184, name: 'tag2' });
    expect(cmds).toContainEqual({ kind: 'client', x: 160, y: 184, slot: 1, score: 5, ping: 9999, time: 61 });
    expect(hudPicByName('pics/tag1.pcx')).toBeDefined();
    expect(hudPicByName('pics/tag2.pcx')).toBeDefined();
  });

  it('completion centerprint sits just above screen center at both resolutions', () => {
    const msg = 'YOU HAVE COMPLETED\nTHE FIRST LEVEL';
    const at640 = centerPrintPlacement(msg, 640, 480);
    expect(at640.map((l) => l.y)).toEqual([168, 176]);
    expect(at640[0]!.x).toBe(248);
    const at1024 = centerPrintPlacement(msg, 1024, 768);
    expect(at1024.map((l) => l.y)).toEqual([268, 276]);
    expect(at1024[0]!.x).toBe(440);
  });

  it('death leg: a short death message centers on the same rule', () => {
    const lines = centerPrintPlacement('YOU ARE DEAD', 640, 480);
    expect(lines).toHaveLength(1);
    // 12 chars x 8px = 96: (640-96)/2 = 272; single line at 35% of 480.
    expect(lines[0]).toEqual({ x: 272, y: 168, text: 'YOU ARE DEAD' });
  });

  it('long finale text starts at y=48', () => {
    const lines = centerPrintPlacement('a\nb\nc\nd\ne', 640, 480);
    expect(lines.map((l) => l.y)).toEqual([48, 56, 64, 72, 80]);
    expect(lines[0]!.x).toBe((640 - 8) / 2);
  });
});

describe('RELEASE-6 inventory screen (asset-free)', () => {
  it('centers the background and headers at 640x480', () => {
    const inv = layoutInventory([], 0, 0, 640, 480);
    expect([inv.picX, inv.picY]).toEqual([192, 128]);
    expect([inv.headerX, inv.headerY]).toEqual([216, 144]);
    expect(inv.rows).toEqual([]);
    expect([INVENTORY_PIC, INVENTORY_W, INVENTORY_H, INVENTORY_HEADER_1]).toEqual([
      'inventory',
      256,
      192,
      'hotkey ### item',
    ]);
  });

  it('centers the background at 1024x768', () => {
    const inv = layoutInventory([], 0, 0, 1024, 768);
    // (1024-256)/2 = 384; boxY = (768-240)/2 = 264, pic 8px in.
    expect([inv.picX, inv.picY]).toEqual([384, 272]);
  });

  it('lists items with bindings, selection highlight and blink cursor pair', () => {
    const items = [
      { index: 3, count: 12, name: 'Shells', bind: 'q' },
      { index: 5, count: 1, name: 'Shotgun', bind: '' },
    ];
    const on = layoutInventory(items, 5, 0.1, 640, 480);
    expect(on.rows.map((r) => r.text)).toEqual(['     q  12 Shells', '         1 Shotgun']);
    expect(on.rows[0]).toMatchObject({ alt: true, cursor: false });
    expect(on.rows[1]).toMatchObject({ alt: false, cursor: true });
    // Negative control: the other half of the 10 Hz blink hides the cursor.
    expect(layoutInventory(items, 5, 0.25, 640, 480).rows[1]!.cursor).toBe(false);
  });

  it(`scrolls a long list to a ${DISPLAY_ITEMS}-row window ending at the selection`, () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ index: i + 1, count: i, name: `item${i}`, bind: '' }));
    const inv = layoutInventory(items, 20, 0, 640, 480);
    expect(inv.rows).toHaveLength(DISPLAY_ITEMS);
    expect(inv.rows[0]!.text).toContain('item3');
    expect(inv.rows[DISPLAY_ITEMS - 1]).toMatchObject({ cursor: false, alt: false });
    expect(layoutInventory(items, 1, 0.1, 640, 480).rows[0]!.text).toContain('item0');
  });

  it('formats rows like id (%6s %3i %s)', () => {
    expect(formatInventoryRow('q', 12, 'Shells')).toBe('     q  12 Shells');
  });
});

// ---------------------------------------------------------------------------
// Devroom fallback: readable with zero assets (asset-free, no Q2_PAK)
// ---------------------------------------------------------------------------

describe('RELEASE-6 devroom fallback (asset-free)', () => {
  it('help, scoreboard, centerprint and inventory build with no pak reads', () => {
    expect(() =>
      buildHelpLayout({ skill: 2, levelName: 'devroom', help1: 'h1', help2: 'h2', kills: [0, 0], goals: [0, 0], secrets: [0, 0] }),
    ).not.toThrow();
    expect(() => buildScoreboardLayout([])).not.toThrow();
    expect(centerPrintPlacement('COMPLETED', 320, 240)).toHaveLength(1);
    expect(layoutInventory([], 0, 0, 320, 240).rows).toEqual([]);
  });

  it('statusbar executes with empty art: pics drop, text/fields stay readable', () => {
    const cmds = executeStatusbar(parseStatusbar(SINGLE_STATUSBAR), state({ stats: [0, 100] }), 320, 240);
    // Missing i_health: the pic cmd is skipped, the health field still draws.
    expect(cmds).toContainEqual({ kind: 'field', x: 0, y: 216, style: 'num', width: 3, value: 100 });
    expect(cmds.some((c: StatusDrawCmd) => c.kind === 'pic')).toBe(false);
    const withString = executeStatusbar(
      parseStatusbar('xv 0 yv 0 string "hi" picn help'),
      state(),
      320,
      240,
    );
    expect(withString.some((c: StatusDrawCmd) => c.kind === 'text')).toBe(true);
  });

  it('negative control: stat values out of range still fail closed without assets', () => {
    // In-range value with no art drops the pic (fallback above); a value at
    // the MAX_IMAGES limit throws (fail-closed boundary, no silent wrap).
    expect(() =>
      executeStatusbar(parseStatusbar('pic 5'), state({ stats: [0, 0, 0, 0, 0, MAX_IMAGES] }), 320, 240),
    ).toThrow();
    expect(executeStatusbar(parseStatusbar('if 2 string x endif'), state({ stats: [0, 0, 0] }), 320, 240)).toEqual([]);
  });
});
