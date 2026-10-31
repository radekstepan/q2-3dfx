// RELEASE-6: statusbar layout execution (`SCR_ExecuteLayoutString` semantics).
import { describe, expect, it } from 'vitest';
import {
  FLASH_AMMO,
  FLASH_ARMOR,
  FLASH_HEALTH,
  MAX_CLIENTS,
  MAX_IMAGES,
  STAT_AMMO,
  STAT_ARMOR,
  STAT_FLASHES,
  STAT_HEALTH,
  executeStatusbar,
  layoutX,
  layoutY,
  parseStatusbar,
  type StatusbarState,
  type StatusDrawCmd,
} from './statusbar.js';

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

describe('layout cursor mapping', () => {
  it('maps xv/xr/xl and yv/yb/yt like id integer math', () => {
    expect(layoutX('xl', 10, 640)).toBe(10);
    expect(layoutX('xr', -50, 640)).toBe(590);
    expect(layoutX('xv', 0, 320)).toBe(0);
    expect(layoutX('xv', 0, 640)).toBe(160);
    expect(layoutX('xv', 148, 1024)).toBe(500);
    expect(layoutY('yt', 2, 480)).toBe(2);
    expect(layoutY('yb', -24, 480)).toBe(456);
    expect(layoutY('yb', -24, 768)).toBe(744);
    expect(layoutY('yv', 8, 480)).toBe(128);
    expect(layoutY('yv', 8, 768)).toBe(272);
  });

  it('keeps cursor modes on pos ops (xv 0 is not x 0)', () => {
    const ops = parseStatusbar('xv 10 yb -24 pic 0');
    expect(ops[0]).toEqual({ op: 'pos', x: 10, y: -24, xMode: 'xv', yMode: 'yb' });
    const cmds = executeStatusbar(ops, state({ images: ['i_health'], stats: [0] }), 640, 480);
    expect(cmds).toEqual([{ kind: 'pic', x: 170, y: 456, name: 'i_health' }]);
  });
});

describe('single_statusbar execution', () => {
  const ops = parseStatusbar(SINGLE_STATUSBAR);
  const healthy = (over: Partial<StatusbarState> = {}): StatusbarState =>
    state({
      stats: [0, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      images: ['i_health'],
      ...over,
    });

  it('draws health field + icon at 640x480 with no ammo/armor rows', () => {
    const cmds = executeStatusbar(ops, healthy(), 640, 480);
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

  it('draws the ammo row only when STAT_AMMO_ICON is set', () => {
    // stats[2] doubles as the `if` condition and the CS_IMAGES index.
    const withAmmo = healthy({ stats: [0, 100, 2, 12, 0, 0, 0, 0, 0, 0, 0, 0], images: ['i_health', 'x', 'a_bullets'] });
    const cmds = executeStatusbar(ops, withAmmo, 320, 240);
    expect(cmds).toContainEqual({ kind: 'field', x: 100, y: 216, style: 'num', width: 3, value: 12 });
    expect(cmds).toContainEqual({ kind: 'pic', x: 150, y: 216, name: 'a_bullets' });
  });

  it('flashes low health with field_3 and the alert digit set', () => {
    const stats = [0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, FLASH_HEALTH];
    const blinking = executeStatusbar(ops, healthy({ stats, serverframe: 4 }), 320, 240);
    expect(blinking[0]).toEqual({ kind: 'pic', x: 0, y: 216, name: 'field_3' });
    expect(blinking[1]).toMatchObject({ kind: 'field', style: 'anum', value: 10 });
    const steady = executeStatusbar(ops, healthy({ stats, serverframe: 0 }), 320, 240);
    expect(steady[1]).toMatchObject({ kind: 'field', style: 'num', value: 10 });
  });

  it('skips armor below 1 and negative ammo, shows the pickup string', () => {
    // stats[2]=ammo-icon present but stats[3]=-3 hides anum; stats[4]=no armor
    // icon so the whole armor block is skipped; stats[7]=3 is the image index
    // of the picked-up icon; stats[8]=9 indexes the pickup string.
    const stats = [0, 100, 1, -3, 0, 0, 0, 3, 9, 0, 0, 0];
    const st = healthy({
      stats,
      images: ['i_health', 'x', 'a_cells', 'w_shotgun'],
      configstrings: ['x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'Shells'],
    });
    const cmds = executeStatusbar(ops, st, 320, 240);
    expect(cmds.some((c) => c.kind === 'field' && c.value === -3)).toBe(false);
    expect(cmds).not.toContainEqual(expect.objectContaining({ kind: 'pic', name: 'i_jacketarmor' }));
    expect(cmds).toContainEqual({ kind: 'pic', x: 0, y: 190, name: 'w_shotgun' });
    expect(cmds).toContainEqual({ kind: 'text', x: 26, y: 198, text: 'Shells', alt: false, centerWidth: 0 });
  });

  it('draws rnum and the ammo flash field when set', () => {
    const stats = [0, 100, 1, 3, 1, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, FLASH_AMMO | FLASH_ARMOR];
    const st = healthy({ stats, images: ['i_health', 'x', 'a_cells', 'x', 'i_bodyarmor'], serverframe: 4 });
    const cmds = executeStatusbar(ops, st, 320, 240);
    expect(cmds).toContainEqual({ kind: 'field', x: 100, y: 216, style: 'anum', width: 3, value: 3 });
    expect(cmds).toContainEqual({ kind: 'field', x: 200, y: 216, style: 'num', width: 3, value: 40 });
    expect(cmds.filter((c) => c.kind === 'pic' && c.name === 'field_3')).toHaveLength(2);
  });
});

describe('extended ops and conditionals', () => {
  it('parses and executes picn/string2/cstring2/ctf', () => {
    const ops = parseStatusbar('xv 32 yv 8 picn help xv 0 yv 24 cstring2 "hi" ctf 0 32 3 10 1200');
    expect(ops).toContainEqual({ op: 'picn', name: 'help' });
    expect(ops).toContainEqual({ op: 'cstring2', text: 'hi' });
    const st = state({ clientInfo: () => ({ name: 'p', icon: 'i_fixme' }) });
    const cmds = executeStatusbar(ops, st, 640, 480);
    expect(cmds).toContainEqual({ kind: 'pic', x: 192, y: 128, name: 'help' });
    expect(cmds).toContainEqual({ kind: 'text', x: 160, y: 144, text: 'hi', alt: true, centerWidth: 320 });
    expect(cmds).toContainEqual({ kind: 'ctf', x: 160, y: 152, slot: 3, score: 10, ping: 999 });
  });

  it('evaluates ifnot/ifeq/ifbit with nesting', () => {
    const ops = parseStatusbar('ifnot 2 string a endif ifeq 3 7 string b endif ifbit 4 2 string c endif if 5 if 6 string deep endif endif');
    const st = (s: number[]): StatusbarState => state({ stats: s });
    expect(cmdTexts(executeStatusbar(ops, st([0, 0, 0, 7, 2, 1, 1]), 320, 240))).toEqual(['a', 'b', 'c', 'deep']);
    expect(cmdTexts(executeStatusbar(ops, st([0, 0, 1, 0, 0, 1, 0]), 320, 240))).toEqual([]);
    // Outer false hides the nested true.
    expect(cmdTexts(executeStatusbar(ops, st([0, 0, 1, 0, 0, 0, 1]), 320, 240))).toEqual([]);
  });

  it('skips empty strings and missing pics, errors on bad indices', () => {
    expect(executeStatusbar(parseStatusbar('string "" picn ""'), state(), 320, 240)).toEqual([]);
    expect(executeStatusbar(parseStatusbar('pic 3'), state({ stats: [0, 0, 0, 9], images: [] }), 320, 240)).toEqual([]);
    // The stat VALUE is the image index: 256 pictures in, the value itself is checked.
    expect(() => executeStatusbar(parseStatusbar('pic 0'), state({ stats: [MAX_IMAGES] }), 320, 240)).toThrow();
    expect(() => executeStatusbar(parseStatusbar('stat_string 8'), state({ stats: [0, 0, 0, 0, 0, 0, 0, 0, 99], configstrings: ['a'] }), 320, 240)).toThrow();
    expect(() =>
      executeStatusbar(parseStatusbar(`client 0 32 ${MAX_CLIENTS} 0 0 0`), state({ clientInfo: () => ({ name: 'x', icon: 'y' }) }), 320, 240),
    ).toThrow();
  });

  it('clamps num width to 5 like SCR_DrawField', () => {
    const cmds = executeStatusbar(parseStatusbar('num 9 1'), state({ stats: [0, 123456] }), 320, 240);
    expect(cmds).toEqual([{ kind: 'field', x: 0, y: 0, style: 'num', width: 5, value: 123456 }]);
  });

  it('drops client rows with no client info', () => {
    const cmds = executeStatusbar(parseStatusbar('client 0 32 1 10 20 30'), state(), 320, 240);
    expect(cmds).toEqual([]);
  });
});

function cmdTexts(cmds: StatusDrawCmd[]): string[] {
  return cmds.filter((c) => c.kind === 'text').map((c) => (c.kind === 'text' ? c.text : ''));
}
