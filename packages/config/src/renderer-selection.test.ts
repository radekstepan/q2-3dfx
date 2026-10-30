// @q2/config — GPU-FOLLOW-4: vid_renderer selection states + fallback labels.
//
// Additive/label-only: the default stays 'software', GPU stays experimental
// (GPU_EXPERIMENTAL === true) until FOLLOW-7 evidence. Mirrors the
// `resolveRendererSelection` vocabulary in @q2/renderer-api BY VALUE.
import { describe, expect, it } from 'vitest';
import {
  describeRendererSelection,
  getCVarString,
  GPU_EXPERIMENTAL,
  GPU_EXPERIMENTAL_BACKEND,
  isExperimentalRenderer,
  isKnownRendererId,
  rendererFallbackWarning,
  rendererSelectionLabel,
  resetCVars,
  VID_RENDERER_DEFAULT,
} from './index.js';

describe('vid_renderer selection states (FOLLOW-4, label-only)', () => {
  it('default stays software; GPU stays experimental (no default promotion)', () => {
    resetCVars();
    expect(getCVarString('vid_renderer')).toBe('software');
    expect(VID_RENDERER_DEFAULT).toBe('software');
    expect(GPU_EXPERIMENTAL_BACKEND).toBe('webgl2-experimental');
    expect(GPU_EXPERIMENTAL).toBe(true);
  });

  it('software/voodoo requests are honored with no fallback and no warning', () => {
    for (const id of ['software', 'voodoo'] as const) {
      const sel = describeRendererSelection(id, false);
      expect(sel.active).toBe(id);
      expect(sel.fallback).toBe(false);
      expect(sel.experimental).toBe(false);
      expect(sel.warning).toBeNull();
      expect(rendererFallbackWarning(sel)).toBeNull();
      expect(isKnownRendererId(id)).toBe(true);
      expect(isExperimentalRenderer(id)).toBe(false);
    }
  });

  it('capable GPU request is honored and tagged experimental', () => {
    const sel = describeRendererSelection('webgl2-experimental', true, 'WebGL 2.0 (test)');
    expect(sel.active).toBe('webgl2-experimental');
    expect(sel.fallback).toBe(false);
    expect(sel.experimental).toBe(true);
    expect(sel.warning).toBeNull();
    expect(isExperimentalRenderer(sel.active)).toBe(true);
    expect(rendererSelectionLabel(sel)).toContain('[EXPERIMENTAL]');
    expect(rendererSelectionLabel(sel)).not.toContain('FALLBACK');
  });

  it('incapable GPU request falls back to software WITH an explicit warning', () => {
    const sel = describeRendererSelection('webgl2-experimental', false, 'no WebGL2 context');
    expect(sel.active).toBe('software');
    expect(sel.fallback).toBe(true);
    expect(sel.experimental).toBe(false);
    expect(sel.warning).toContain('webgl2-experimental requested but unavailable');
    expect(sel.warning).toContain('no WebGL2 context');
    expect(sel.warning).toContain('staying on software');
    expect(rendererFallbackWarning(sel)).toBe(sel.warning);
    const label = rendererSelectionLabel(sel);
    expect(label).toContain('FALLBACK');
    expect(label).toContain('software');
  });

  it('unknown ids fall back to software WITH an explicit warning (never silent)', () => {
    const sel = describeRendererSelection('gl-fancy', true);
    expect(sel.active).toBe('software');
    expect(sel.fallback).toBe(true);
    expect(sel.experimental).toBe(false);
    expect(isKnownRendererId('gl-fancy')).toBe(false);
    expect(sel.warning).toContain('unknown vid_renderer');
    expect(rendererSelectionLabel(sel)).toContain('FALLBACK');
  });
});
