// @q2/renderer-api — GPU boundary selection resolver (GPU-PROOF-2 interface-first).
import { describe, expect, it } from 'vitest';
import {
  resolveRendererSelection,
  type GpuCapability,
} from './gpu.js';

const CAPABLE: GpuCapability = {
  backend: 'webgl2-experimental',
  available: true,
  reason: 'WebGL2 (test stub)',
};

const INCAPABLE: GpuCapability = {
  backend: 'webgl2-experimental',
  available: false,
  reason: 'no WebGL2 context (test stub)',
};

describe('gpu selection resolver', () => {
  it('honors exact software/voodoo requests without warnings', () => {
    expect(resolveRendererSelection('software', INCAPABLE)).toEqual({ active: 'software', warning: null });
    expect(resolveRendererSelection('voodoo', INCAPABLE)).toEqual({ active: 'voodoo', warning: null });
  });

  it('honors a capable webgl2-experimental request', () => {
    expect(resolveRendererSelection('webgl2-experimental', CAPABLE)).toEqual({
      active: 'webgl2-experimental',
      warning: null,
    });
  });

  it('falls back to software WITH an explicit warning when the GPU is unavailable', () => {
    const sel = resolveRendererSelection('webgl2-experimental', INCAPABLE);
    expect(sel.active).toBe('software');
    expect(sel.warning).toContain('webgl2-experimental requested but unavailable');
    expect(sel.warning).toContain('no WebGL2 context');
  });

  it('falls back to software WITH an explicit warning for unknown values (never silent)', () => {
    const sel = resolveRendererSelection('webgl3', CAPABLE);
    expect(sel.active).toBe('software');
    expect(sel.warning).toContain('unknown vid_renderer');
  });
});
