// RELEASE-6: intermission/scoreboard/centerprint/inventory layout semantics.
import { describe, expect, it } from 'vitest';
import {
  buildScoreboardLayout,
  centerPrintPlacement,
  DISPLAY_ITEMS,
  formatInventoryRow,
  layoutInventory,
  scoreCell,
  scoreTag,
  showsIntermissionScoreboard,
  sortScoreboard,
  type ScoreEntry,
} from './screens.js';
import { executeStatusbar, parseStatusbar, type StatusbarState } from './statusbar.js';

const entry = (over: Partial<ScoreEntry> = {}): ScoreEntry => ({
  slot: 0,
  score: 0,
  ping: 0,
  time: 0,
  self: false,
  killer: false,
  ...over,
});

describe('level completion', () => {
  it('single-player maps go straight through (no * = no scoreboard)', () => {
    expect(showsIntermissionScoreboard('base1')).toBe(false);
    expect(showsIntermissionScoreboard('base2')).toBe(false);
    expect(showsIntermissionScoreboard('unit1*base1')).toBe(true);
  });

  it('completion centerprint sits just above screen center at both resolutions', () => {
    const msg = 'YOU HAVE COMPLETED\nTHE FIRST LEVEL';
    const at640 = centerPrintPlacement(msg, 640, 480);
    expect(at640.map((l) => l.y)).toEqual([168, 176]);
    // 18-char line centered: (640-144)/2.
    expect(at640[0]!.x).toBe(248);
    expect(at640.map((l) => l.text)).toEqual(['YOU HAVE COMPLETED', 'THE FIRST LEVEL']);
    const at1024 = centerPrintPlacement(msg, 1024, 768);
    expect(at1024.map((l) => l.y)).toEqual([268, 276]);
    expect(at1024[0]!.x).toBe(440);
  });

  it('long finale text starts at y=48', () => {
    const lines = centerPrintPlacement('a\nb\nc\nd\ne', 640, 480);
    expect(lines.map((l) => l.y)).toEqual([48, 56, 64, 72, 80]);
    expect(lines[0]!.x).toBe((640 - 8) / 2);
  });
});

describe('deathmatch scoreboard', () => {
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

  it('builds the id scoreboard layout string and it executes', () => {
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
  });
});

describe('inventory screen', () => {
  it('centers the background and headers at 640x480', () => {
    const inv = layoutInventory([], 0, 0, 640, 480);
    expect([inv.picX, inv.picY]).toEqual([192, 128]);
    expect([inv.headerX, inv.headerY]).toEqual([216, 144]);
    expect(inv.rows).toEqual([]);
  });

  it('lists items with bindings, selection highlight and blink cursor', () => {
    const items = [
      { index: 3, count: 12, name: 'Shells', bind: 'q' },
      { index: 5, count: 1, name: 'Shotgun', bind: '' },
    ];
    const on = layoutInventory(items, 5, 0.1, 640, 480);
    expect(on.rows.map((r) => r.text)).toEqual(['     q  12 Shells', '         1 Shotgun']);
    expect(on.rows[0]).toMatchObject({ alt: true, cursor: false });
    expect(on.rows[1]).toMatchObject({ alt: false, cursor: true });
    // Cursor off in the other half of the 10 Hz blink.
    expect(layoutInventory(items, 5, 0.25, 640, 480).rows[1]!.cursor).toBe(false);
  });

  it(`scrolls a long list to a ${DISPLAY_ITEMS}-row window ending at the selection`, () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ index: i + 1, count: i, name: `item${i}`, bind: '' }));
    const inv = layoutInventory(items, 20, 0, 640, 480);
    expect(inv.rows).toHaveLength(DISPLAY_ITEMS);
    expect(inv.rows[0]!.text).toContain('item3');
    expect(inv.rows[DISPLAY_ITEMS - 1]).toMatchObject({ cursor: false, alt: false });
    // First item selected pins the window at the top.
    expect(layoutInventory(items, 1, 0.1, 640, 480).rows[0]!.text).toContain('item0');
  });

  it('formats rows like id (%6s %3i %s)', () => {
    expect(formatInventoryRow('q', 12, 'Shells')).toBe('     q  12 Shells');
    expect(formatInventoryRow('', 1, 'Shotgun')).toBe('         1 Shotgun');
  });
});
