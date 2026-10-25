import { beforeEach, describe, expect, it } from 'vitest';
import { getCVarBool, getCVarNumber, getCVarString, registerCVar, resetCVars, setCVarFromString } from './index.js';

beforeEach(() => resetCVars());

describe('cvar registry', () => {
  it('ships Voodoo + client defaults', () => {
    expect(getCVarNumber('vd_gamma')).toBeCloseTo(1.3, 9);
    expect(getCVarNumber('cl_predict')).toBe(1);
    expect(getCVarString('vid_renderer')).toBe('software');
  });

  it('setCVarFromString coerces types', () => {
    expect(setCVarFromString('x_num', '42')).toBe(42);
    expect(setCVarFromString('x_flag', 'true')).toBe(true);
    expect(setCVarFromString('x_name', 'soldier')).toBe('soldier');
    expect(getCVarBool('x_flag')).toBe(true);
  });

  it('registerCVar keeps first registration', () => {
    registerCVar('x_new', 7, 'doc');
    registerCVar('x_new', 9, 'doc');
    expect(getCVarNumber('x_new')).toBe(7);
  });
});
