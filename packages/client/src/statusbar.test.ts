import { describe, expect, it } from 'vitest';
import { Configstrings, CS_STATUSBAR, parseStatusbar, tokenizeLayout } from './statusbar.js';

describe('statusbar string parsing (configstrings)', () => {
  it('tokenizes quoted strings intact', () => {
    expect(tokenizeLayout('xv 32 string "hello world" yv 10')).toEqual([
      'xv',
      '32',
      'string',
      'hello world',
      'yv',
      '10',
    ]);
  });

  it('parses positions, pics and nums', () => {
    const ops = parseStatusbar('xv 32 yv 144 pic 0 client 0 num 3 10');
    expect(ops).toContainEqual({ op: 'pos', x: 32, y: 144 });
    expect(ops).toContainEqual({ op: 'pic', index: 0 });
    expect(ops).toContainEqual({ op: 'client', index: 0 });
    expect(ops).toContainEqual({ op: 'num', width: 3, index: 10 });
  });

  it('parses hnum/anum/rnum/stat_string/cstring/string', () => {
    const ops = parseStatusbar('hnum anum rnum stat_string 7 cstring "hi" string bye');
    expect(ops).toContainEqual({ op: 'hnum' });
    expect(ops).toContainEqual({ op: 'anum' });
    expect(ops).toContainEqual({ op: 'rnum' });
    expect(ops).toContainEqual({ op: 'stat_string', index: 7 });
    expect(ops).toContainEqual({ op: 'cstring', text: 'hi' });
    expect(ops).toContainEqual({ op: 'string', text: 'bye' });
  });

  it('parses if/endif conditionals', () => {
    const ops = parseStatusbar('if 2 xv 1 pic 4 endif ifeq 3 1 pic 5 endif');
    expect(ops).toContainEqual({ op: 'if', index: 2 });
    expect(ops).toContainEqual({ op: 'ifeq', index: 3, value: 1 });
    expect(ops.filter((o) => o.op === 'endif')).toHaveLength(2);
  });

  it('Configstrings.statusbar() reads CS_STATUSBAR', () => {
    const cs = new Configstrings();
    expect(cs.statusbar()).toEqual([]);
    cs.set(CS_STATUSBAR, 'xv 0 yv 0 pic 1');
    expect(cs.statusbar()).toContainEqual({ op: 'pic', index: 1 });
  });

  it('unknown tokens are preserved, not dropped', () => {
    expect(parseStatusbar('frobnicate 3')).toContainEqual({ op: 'unknown', token: 'frobnicate' });
  });
});
