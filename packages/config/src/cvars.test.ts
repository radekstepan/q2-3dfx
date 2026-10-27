import { beforeEach, describe, expect, it } from 'vitest';
import {
  getCVarBool,
  getCVarNumber,
  getCVarString,
  listCVars,
  registerCVar,
  resetCVars,
  setCVar,
  setCVarFromString,
} from './index.js';

beforeEach(() => resetCVars());

describe('cvar registry', () => {
  it('ships Voodoo + client defaults', () => {
    expect(getCVarNumber('vd_gamma')).toBeCloseTo(1.3, 9);
    expect(getCVarNumber('cl_predict')).toBe(1);
    expect(getCVarString('vid_renderer')).toBe('software');
  });

  it('locks legacy vd_* defaults (preset change needs HW capture approval)', () => {
    expect(getCVarNumber('vd_16bit')).toBe(1);
    expect(getCVarNumber('vd_dither')).toBe(1);
    expect(getCVarNumber('vd_postfilter')).toBe(1);
    expect(getCVarNumber('vd_bilinear')).toBe(1);
    expect(getCVarNumber('vd_mipdither')).toBe(1);
    expect(getCVarNumber('vd_lodbias')).toBeCloseTo(-0.35, 9);
    expect(getCVarNumber('vd_fog')).toBe(1);
    expect(getCVarNumber('vd_gamma')).toBeCloseTo(1.3, 9);
    expect(getCVarNumber('vd_maxtexsize')).toBe(256);
    expect(getCVarNumber('vd_zbits')).toBe(16);
    expect(getCVarNumber('vd_palettetex')).toBe(1);
    expect(getCVarNumber('vd_overbright')).toBe(1);
  });

  it('every vd_* cvar ships a doc string', () => {
    for (const def of listCVars().filter((c) => c.name.startsWith('vd_'))) {
      expect(def.doc.length, def.name).toBeGreaterThan(0);
    }
  });

  it('profile-data keys default to current behavior (read-path only)', () => {
    expect(getCVarString('vd_dithermode')).toBe('4x4');
    expect(getCVarString('vd_reconmode')).toBe('legacy');
    expect(getCVarString('vd_rgbmaxdelta')).toBe('0,0,0');
  });

  it('profile-data keys round-trip set/get', () => {
    setCVar('vd_dithermode', '2x2');
    expect(getCVarString('vd_dithermode')).toBe('2x2');
    setCVar('vd_reconmode', '4x4sub+4x1');
    expect(getCVarString('vd_reconmode')).toBe('4x4sub+4x1');
    setCVar('vd_rgbmaxdelta', '8,4,8');
    expect(getCVarString('vd_rgbmaxdelta')).toBe('8,4,8');
    expect(setCVarFromString('vd_dithermode', '4x4')).toBe('4x4');
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
