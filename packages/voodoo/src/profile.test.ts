// Approximation-profile pin test: every non-hardware-calibrated setting is
// listed in VOODOO_APPROX_PROFILE with a manual anchor or an explicit
// approximation/preset tag. Nothing here is "hardware-calibrated".
import { describe, expect, it } from 'vitest';
import { VOODOO_APPROX_PROFILE, type ApproxSource } from './index.js';

const ALLOWED: ReadonlySet<string> = new Set([
  'manual:fbzMode',
  'manual:vidProcCfg',
  'manual:tLOD',
  'approx:chosen',
  'preset:appearance',
]);

describe('VOODOO_APPROX_PROFILE', () => {
  it('is frozen and pins every setting with a valid source tag', () => {
    expect(Object.isFrozen(VOODOO_APPROX_PROFILE)).toBe(true);
    expect(VOODOO_APPROX_PROFILE.length).toBe(19);
    const settings = VOODOO_APPROX_PROFILE.map((e) => e.setting);
    // No duplicates, stable order.
    expect(new Set(settings).size).toBe(settings.length);
    expect(settings).toEqual([
      'dither.modes',
      'dither.weights-phase',
      'scanout.order',
      'scanout.matched-pairs',
      'scanout.tap-alignment',
      'scanout.rgbMaxDelta-register',
      'scanout.rgbMaxDelta-values',
      'scanout.legacy-default',
      'gamma.curve',
      'gamma.value',
      'gamma.stage',
      'lod.bias-sign',
      'lod.dither-mean',
      'lod.compensation',
      'lod.bias-value',
      'upload.repeat-nonpot',
      'upload.clamp-nonpot',
      'depth.z16',
      'depth.wbuffer',
    ]);
    for (const e of VOODOO_APPROX_PROFILE) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(e.setting.length).toBeGreaterThan(0);
      expect(e.value.length).toBeGreaterThan(0);
      expect(e.note.length).toBeGreaterThan(0);
      expect(ALLOWED.has(e.source satisfies ApproxSource)).toBe(true);
    }
  });
  it('anchors manual behavior to the guide, approximations to chosen/preset tags', () => {
    const by = (s: string) => VOODOO_APPROX_PROFILE.find((e) => e.setting === s)!;
    expect(by('scanout.order').source).toBe('manual:vidProcCfg');
    expect(by('scanout.matched-pairs').source).toBe('manual:vidProcCfg');
    expect(by('lod.bias-sign').source).toBe('manual:tLOD');
    expect(by('lod.dither-mean').source).toBe('manual:tLOD');
    expect(by('dither.modes').source).toBe('manual:fbzMode');
    expect(by('gamma.value').source).toBe('preset:appearance');
    expect(by('gamma.value').value).toContain('1.3');
    expect(by('lod.bias-value').source).toBe('preset:appearance');
    expect(by('lod.bias-value').value).toContain('-0.35');
    expect(by('depth.wbuffer').value).toBe('W-buffer NOT implemented');
    expect(by('scanout.legacy-default').source).toBe('approx:chosen');
  });
});
