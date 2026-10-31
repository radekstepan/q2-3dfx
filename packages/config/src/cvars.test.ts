import { beforeEach, describe, expect, it } from 'vitest';
import {
  S_VOLUME_DEFAULT,
  S_VOLUME_REFERENCE_GAIN,
  clampNormalizedVolume,
  getCVarBool,
  getCVarNumber,
  getCVarString,
  listCVars,
  registerCVar,
  resetCVars,
  setCVar,
  setCVarFromString,
  sVolumeToOutputGain,
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

  it('profile-data keys default to matched scanout (hardware path)', () => {
    expect(getCVarString('vd_dithermode')).toBe('4x4');
    expect(getCVarString('vd_reconmode')).toBe('2x2sub+2x2box');
    expect(getCVarString('vd_rgbmaxdelta')).toBe('8,8,8');
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

describe('RELEASE-1 quiet volume scale (config side)', () => {
  it('default 1 equals old quiet gain 0.05; max cannot exceed 0.05', () => {
    expect(getCVarNumber('s_volume')).toBe(S_VOLUME_DEFAULT);
    expect(S_VOLUME_DEFAULT).toBe(1);
    expect(S_VOLUME_REFERENCE_GAIN).toBe(0.05);
    expect(sVolumeToOutputGain(getCVarNumber('s_volume'))).toBeCloseTo(0.05, 9);
    expect(sVolumeToOutputGain(1)).toBeCloseTo(0.05, 9);
  });

  it('s_volume ships a mapping doc so the gain is applied exactly once', () => {
    const def = listCVars().find((c) => c.name === 's_volume')!;
    expect(def.doc.length).toBeGreaterThan(0);
    expect(def.doc).toMatch(/0\.05/);
  });

  it('clamps finite values; invalid/legacy config mutes or maps quiet', () => {
    expect(sVolumeToOutputGain(0)).toBe(0);
    expect(sVolumeToOutputGain(5)).toBeCloseTo(0.05, 9);
    expect(sVolumeToOutputGain(-2)).toBe(0);
    expect(sVolumeToOutputGain(Number.NaN)).toBe(0);
    expect(sVolumeToOutputGain(Number.POSITIVE_INFINITY)).toBe(0);
    expect(sVolumeToOutputGain('loud')).toBe(0);
    expect(sVolumeToOutputGain(undefined)).toBe(0);
    // Legacy old-scale 0.8 is treated as normalized: quiet 0.04, never 0.8*0.05*0.05.
    expect(sVolumeToOutputGain(0.8)).toBeCloseTo(0.04, 9);
    expect(clampNormalizedVolume(0.8)).toBeCloseTo(0.8, 9);
  });

  it('console coercion flows through the same capped mapping', () => {
    setCVarFromString('s_volume', '3');
    expect(sVolumeToOutputGain(getCVarNumber('s_volume'))).toBeCloseTo(0.05, 9);
    setCVarFromString('s_volume', 'not-a-number');
    expect(sVolumeToOutputGain(getCVarNumber('s_volume'))).toBe(0);
    setCVar('s_volume', 0);
    expect(sVolumeToOutputGain(getCVarNumber('s_volume'))).toBe(0);
  });
});
