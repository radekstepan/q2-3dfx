// RELEASE-6: F1 help-computer layout matches `game/p_hud.c: HelpComputer`.
import { describe, expect, it } from 'vitest';
import { buildHelpLayout, pad3, skillName } from './help.js';
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
});
