// Approximation-profile pin test: every non-hardware-calibrated setting is
// listed in VOODOO_APPROX_PROFILE with a manual anchor or an explicit
// approximation/preset tag. Nothing here is "hardware-calibrated".
import { describe, expect, it } from 'vitest';
import { VOODOO_APPROX_PROFILE, type ApproxSource } from './index.js';

const ALLOWED: ReadonlySet<string> = new Set([
  'manual:fbzMode',
  'manual:vidProcCfg',
  'manual:textureMode',
  'manual:fogTable',
  'approx:chosen',
  'preset:appearance',
]);

describe('VOODOO_APPROX_PROFILE', () => {
  it('is frozen and pins every setting with a valid source tag', () => {
    expect(Object.isFrozen(VOODOO_APPROX_PROFILE)).toBe(true);
    expect(VOODOO_APPROX_PROFILE.length).toBe(39);
    const settings = VOODOO_APPROX_PROFILE.map((e) => e.setting);
    // No duplicates, stable order.
    expect(new Set(settings).size).toBe(settings.length);
    expect(settings).toEqual([
      'dither.modes',
      'dither.weights-phase',
      'dither.g-asymmetry',
      'scanout.order',
      'scanout.matched-pairs',
      'scanout.tap-alignment',
      'scanout.rgbMaxDelta-register',
      'scanout.rgbMaxDelta-values',
      'scanout.default',
      'scanout.tap-3bit',
      'scanout.bilinear-11b',
      'gamma.curve',
      'gamma.value',
      'gamma.stage',
      'gamma.table-shape',
      'lod.bias-sign',
      'lod.dither-mean',
      'lod.compensation',
      'lod.pick-mechanism',
      'lod.bias-value',
      'fog.formula',
      'fog.index-domain',
      'fog.interpolation',
      'fog.deltas',
      'fog.dither-zones',
      'upload.repeat-nonpot',
      'upload.clamp-nonpot',
      'texture.bilinear-weights',
      'texture.mip-kernel',
      'lightmap.overbright-x2',
      'depth.z16',
      'depth.wbuffer',
      'pipeline.alpha-test',
      'pipeline.alpha-blend',
      'pipeline.chroma-key',
      'pipeline.depth-bias',
      'pipeline.stipple',
      'pipeline.depth-ops-extra',
      'pipeline.lodmin',
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
    expect(by('scanout.order').source).toBe('approx:chosen');
    expect(by('scanout.matched-pairs').source).toBe('manual:vidProcCfg');
    expect(by('scanout.matched-pairs').value).not.toContain('only');
    expect(by('scanout.matched-pairs').note).toContain('§17.8');
    expect(by('lod.bias-sign').source).toBe('manual:textureMode');
    expect(by('lod.dither-mean').source).toBe('manual:textureMode');
    expect(by('lod.pick-mechanism').source).toBe('approx:chosen');
    expect(by('texture.bilinear-weights').source).toBe('approx:chosen');
    expect(by('texture.mip-kernel').source).toBe('approx:chosen');
    expect(by('dither.modes').source).toBe('manual:fbzMode');
    expect(by('gamma.value').source).toBe('preset:appearance');
    expect(by('gamma.value').value).toContain('1.3');
    expect(by('gamma.table-shape').source).toBe('approx:chosen');
    expect(by('gamma.table-shape').value).toContain('512-entry');
    expect(by('gamma.table-shape').note).toContain('§6.4.4');
    expect(by('dither.g-asymmetry').source).toBe('approx:chosen');
    expect(by('dither.g-asymmetry').value).toContain('+2 vs -1');
    expect(by('dither.weights-phase').note).toContain('fog-XOR');
    expect(by('lod.bias-value').source).toBe('preset:appearance');
    expect(by('lod.bias-value').value).toContain('-0.35');
    expect(by('lod.bias-value').note).toContain('4.2');
    expect(by('depth.wbuffer').value).toBe('W-buffer NOT implemented');
    expect(by('fog.formula').source).toBe('approx:chosen');
    expect(by('fog.index-domain').source).toBe('approx:chosen');
    expect(by('fog.interpolation').source).toBe('manual:fogTable');
    expect(by('fog.deltas').value).toBe('per-entry 6.2 delta factors NOT applied');
    expect(by('fog.dither-zones').source).toBe('approx:chosen');
    expect(by('scanout.default').source).toBe('approx:chosen');
    expect(by('scanout.tap-3bit').source).toBe('approx:chosen');
    expect(by('scanout.tap-3bit').value).toContain('NOT implemented');
    expect(by('scanout.tap-3bit').note).toContain('§17.8');
    expect(by('scanout.bilinear-11b').source).toBe('approx:chosen');
    expect(by('scanout.bilinear-11b').value).toContain('NOT implemented');
    expect(by('scanout.bilinear-11b').note).toContain('11b');
    expect(by('lightmap.overbright-x2').source).toBe('approx:chosen');
    expect(by('lightmap.overbright-x2').value).toContain('overbright ? 2 : 1');
    expect(by('pipeline.alpha-test').source).toBe('approx:chosen');
    expect(by('pipeline.alpha-test').value).toContain('NOT implemented');
    expect(by('pipeline.alpha-test').note).toContain('§10.4.1');
    expect(by('pipeline.alpha-blend').source).toBe('approx:chosen');
    expect(by('pipeline.alpha-blend').value).toContain('NOT implemented');
    expect(by('pipeline.alpha-blend').note).toContain('§10.3.3');
    expect(by('pipeline.chroma-key').source).toBe('approx:chosen');
    expect(by('pipeline.chroma-key').value).toContain('NOT implemented');
    expect(by('pipeline.chroma-key').note).toContain('§10.4.3');
    expect(by('pipeline.depth-bias').source).toBe('approx:chosen');
    expect(by('pipeline.depth-bias').value).toContain('NOT implemented');
    expect(by('pipeline.depth-bias').note).toContain('fbzMode[16]');
    expect(by('pipeline.stipple').source).toBe('approx:chosen');
    expect(by('pipeline.stipple').value).toContain('NOT implemented');
    expect(by('pipeline.stipple').note).toContain('§10.4.4');
    expect(by('pipeline.depth-ops-extra').source).toBe('approx:chosen');
    expect(by('pipeline.depth-ops-extra').value).toContain('LESS only');
    expect(by('pipeline.depth-ops-extra').note).toContain('Table 10.7');
    expect(by('pipeline.lodmin').source).toBe('approx:chosen');
    expect(by('pipeline.lodmin').value).toContain('NOT implemented');
    expect(by('pipeline.lodmin').note).toContain('tLOD');
  });
});
