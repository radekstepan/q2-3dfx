// RELEASE-6: F1 help-computer layout matches `game/p_hud.c: HelpComputer`.
import { describe, expect, it } from 'vitest';
import { HELP_ICON_PIC, buildHelpLayout, helpIconFor, pad3, skillName, type HelpIconArgs } from './help.js';
import { parseStatusbar } from './statusbar.js';

describe('F1 help computer', () => {
  it('labels skills like id (unknown values are hard+)', () => {
    expect([skillName(0), skillName(1), skillName(2), skillName(3), skillName(99)]).toEqual([
      'easy',
      'medium',
      'hard',
      'hard+',
      'hard+',
    ]);
  });

  it('right-aligns progress counts in 3-wide fields (%3i)', () => {
    expect([pad3(0), pad3(7), pad3(42), pad3(123)]).toEqual(['  0', '  7', ' 42', '123']);
  });

  it('builds the exact HelpComputer layout string', () => {
    const layout = buildHelpLayout({
      skill: 1,
      levelName: 'Base',
      help1: 'Find the exit.',
      help2: 'Shoot.',
      kills: [3, 12],
      goals: [1, 2],
      secrets: [0, 1],
    });
    expect(layout).toBe(
      'xv 32 yv 8 picn help ' +
        'xv 202 yv 12 string2 "medium" ' +
        'xv 0 yv 24 cstring2 "Base" ' +
        'xv 0 yv 54 cstring2 "Find the exit." ' +
        'xv 0 yv 110 cstring2 "Shoot." ' +
        'xv 50 yv 164 string2 " kills     goals    secrets" ' +
        'xv 50 yv 172 string2 "  3/ 12     1/2       0/1" ',
    );
  });

  it('round-trips through the layout parser with asset ops intact', () => {
    const layout = buildHelpLayout({
      skill: 0,
      levelName: 'L',
      help1: 'H1',
      help2: 'H2',
      kills: [0, 0],
      goals: [0, 0],
      secrets: [0, 0],
    });
    const ops = parseStatusbar(layout);
    expect(ops).toContainEqual({ op: 'picn', name: 'help' });
    expect(ops).toContainEqual({ op: 'cstring2', text: 'L' });
    expect(ops).toContainEqual({ op: 'string2', text: 'easy' });
  });

  it('renders LIVE counters verbatim (callers pass live level counters, not finish snapshots)', () => {
    // `HelpComputer` sends `level.killed_monsters/found_goals/found_secrets`
    // live; frozen `SV_FinishLevel` snapshots are for completion only. The
    // layout must echo whatever live values it is given.
    const live = {
      skill: 2,
      levelName: 'Base',
      help1: 'H1',
      help2: 'H2',
      kills: [3, 12] as const,
      goals: [1, 2] as const,
      secrets: [0, 1] as const,
    };
    const before = buildHelpLayout(live);
    expect(before).toContain('  3/ 12     1/2       0/1');
    // A live kill mid-level flows straight through on the next open.
    const after = buildHelpLayout({ ...live, kills: [4, 12] as const });
    expect(after).toContain('  4/ 12     1/2       0/1');
    expect(after).not.toBe(before);
  });

  it('pins the exact C field widths: kills %3i/%3i, goals/secrets bare %i/%i', () => {
    const layout = buildHelpLayout({
      skill: 0,
      levelName: 'L',
      help1: 'H1',
      help2: 'H2',
      kills: [7, 100],
      goals: [12, 20],
      secrets: [3, 30],
    });
    // pad3 on kills only; goals/secrets must NOT be space-padded.
    expect(layout).toContain(`"${pad3(7)}/${pad3(100)}     12/20       3/30"`);
  });
});

describe('help icon flash (G_SetStats STAT_HELPICON)', () => {
  const armed = (over: Partial<HelpIconArgs> = {}): HelpIconArgs => ({
    helpChanged: 1,
    frame: 0,
    centerHanded: true,
    fov: 90,
    weaponIcon: 'w_blaster',
    ...over,
  });

  it('flashes i_help exactly when helpChanged && (frame & 8) across a 16-frame window', () => {
    const seen: (string | null)[] = [];
    for (let frame = 0; frame < 16; frame++) {
      seen.push(helpIconFor(armed({ frame })));
    }
    expect(seen).toEqual([
      'w_blaster', 'w_blaster', 'w_blaster', 'w_blaster',
      'w_blaster', 'w_blaster', 'w_blaster', 'w_blaster',
      HELP_ICON_PIC, HELP_ICON_PIC, HELP_ICON_PIC, HELP_ICON_PIC,
      HELP_ICON_PIC, HELP_ICON_PIC, HELP_ICON_PIC, HELP_ICON_PIC,
    ]);
    expect(HELP_ICON_PIC).toBe('i_help');
  });

  it('never flashes while helpChanged is 0, even on flash-phase frames', () => {
    for (let frame = 0; frame < 16; frame++) {
      expect(helpIconFor(armed({ helpChanged: 0, frame }))).toBe('w_blaster');
    }
    // Unarmed with no pending change: nothing drawn on any frame.
    for (let frame = 0; frame < 16; frame++) {
      expect(helpIconFor(armed({ helpChanged: 0, frame, weaponIcon: null }))).toBeNull();
    }
  });

  it('flash takes priority over the weapon icon', () => {
    expect(helpIconFor(armed({ frame: 8, weaponIcon: 'w_shotgun' }))).toBe('i_help');
    expect(helpIconFor(armed({ frame: 0, weaponIcon: 'w_shotgun' }))).toBe('w_shotgun');
  });

  it('falls back to the weapon icon when center-handed or fov > 91', () => {
    // Off-phase frame: flash arm is dormant, fallback decides.
    expect(helpIconFor(armed({ frame: 0, centerHanded: true, fov: 90 }))).toBe('w_blaster');
    expect(helpIconFor(armed({ frame: 0, centerHanded: false, fov: 90 }))).toBeNull();
    expect(helpIconFor(armed({ frame: 0, centerHanded: false, fov: 92 }))).toBe('w_blaster');
    // Boundary: fov 91 is NOT > 91.
    expect(helpIconFor(armed({ frame: 0, centerHanded: false, fov: 91 }))).toBeNull();
    // Flash-phase frame with no pending change still falls back.
    expect(helpIconFor(armed({ helpChanged: 0, frame: 15, centerHanded: false, fov: 100 }))).toBe(
      'w_blaster',
    );
  });

  it('returns null when unarmed or the icon name is empty', () => {
    expect(helpIconFor(armed({ frame: 0, weaponIcon: null }))).toBeNull();
    expect(helpIconFor(armed({ frame: 0, weaponIcon: undefined }))).toBeNull();
    expect(helpIconFor(armed({ frame: 0, weaponIcon: '' }))).toBeNull();
    expect(helpIconFor(armed({ frame: 0, centerHanded: false, fov: 120, weaponIcon: '' }))).toBeNull();
  });

  it('never throws on degenerate numeric input', () => {
    expect(helpIconFor(armed({ frame: Number.NaN }))).toBe('w_blaster');
    expect(helpIconFor(armed({ helpChanged: 5, frame: 8.9, centerHanded: false, fov: 90 }))).toBe(
      'i_help',
    );
  });
});
