import { beforeEach, describe, expect, it } from 'vitest';
import { GameConsole } from './console.js';
import { getCVar, resetCVars } from '@q2/config';

beforeEach(() => resetCVars());

describe('in-game console wired to @q2/config', () => {
  it('set/get round-trips numbers, strings and booleans', () => {
    const con = new GameConsole();
    expect(con.exec('set sensitivity 5')).toBe('sensitivity = 5');
    expect(con.exec('get sensitivity')).toBe('sensitivity = 5');
    con.exec('set playername "a b"');
    expect(getCVar('playername')).toBe('a b');
    con.exec('set cl_predict true');
    expect(getCVar('cl_predict')).toBe(true);
  });

  it('toggle flips numeric cvars', () => {
    const con = new GameConsole();
    con.exec('toggle cl_predict');
    expect(String(getCVar('cl_predict'))).toBe('0');
    con.exec('toggle cl_predict');
    expect(String(getCVar('cl_predict'))).toBe('1');
  });

  it('list/help/echo/clear/unknown behave', () => {
    const con = new GameConsole();
    expect(con.exec('list vd_')).toContain('vd_dither');
    expect(con.exec('help')).toContain('get');
    expect(con.exec('echo hi there')).toBe('hi there');
    expect(con.exec('frobnicate')).toContain('unknown command');
    con.exec('clear');
    expect(con.lines).toEqual([]);
  });
});
