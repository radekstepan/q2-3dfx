import { describe, expect, it, afterEach, vi } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { SoftwareRenderer } from '@q2/sw-renderer';
import {
  applyRendererCvar,
  bootPlay,
  detectGpuCapability,
  getGpuStatus,
  resolveBootRenderer,
  resolveDisplay,
} from './play.js';
import { cvarOptionLabels, cvarOptions, setRendererChoice } from './dom.js';

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as { document?: unknown };
  if ('__q2tsGpuStub' in g) delete g.document;
});

describe('GPU-PROOF-2 selection/plumbing (headless, no real GL)', () => {
  it('detectGpuCapability in vitest (no DOM canvas) is unavailable with a reason, never throws', () => {
    expect(typeof document).toBe('undefined');
    let cap;
    expect(() => {
      cap = detectGpuCapability();
    }).not.toThrow();
    expect(cap!.backend).toBe('webgl2-experimental');
    expect(cap!.available).toBe(false);
    expect(typeof cap!.reason).toBe('string');
    expect(cap!.reason.length).toBeGreaterThan(0);
  });

  it('software requests are honored with no warning; retired voodoo migrates to software WITH a warning', () => {
    setCVar('vid_renderer', 'software');
    expect(resolveBootRenderer()).toEqual({ kind: 'software', warning: null });
    // RELEASE-8: persisted `voodoo` migrates one-time to software WITH an
    // explicit warning — never silently, never auto-promoted to webgl2.
    setCVar('vid_renderer', 'voodoo');
    const sel = resolveBootRenderer();
    expect(sel.kind).toBe('software');
    expect(sel.warning).not.toBeNull();
    expect(sel.warning).toContain('voodoo');
  });

  it('webgl2-experimental + incapable probe falls back to software WITH a recorded warning', () => {
    setCVar('vid_renderer', 'webgl2-experimental');
    // Incapable here: vitest has no DOM canvas (see probe test above).
    expect(detectGpuCapability().available).toBe(false);
    const sel = resolveBootRenderer();
    expect(sel.kind).toBe('software');
    // No silent fallback: the warning is explicit and non-null.
    expect(sel.warning).not.toBeNull();
    expect(sel.warning).toContain('webgl2-experimental');
  });

  it('unknown vid_renderer value falls back to software WITH a warning', () => {
    setCVar('vid_renderer', 'bogus-backend');
    const sel = resolveBootRenderer();
    expect(sel.kind).toBe('software');
    expect(sel.warning).not.toBeNull();
    expect(sel.warning).toContain('bogus-backend');
  });

  it('bootPlay with vid_renderer=webgl2-experimental (incapable) still boots a working CPU frame + warns loudly', () => {
    setCVar('vid_renderer', 'webgl2-experimental');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const boot = bootPlay({ width: 64, height: 48 });
      expect(boot.renderer).toBe('software');
      // Recorded on the boot AND console.warned — never silent.
      expect(boot.lastRendererWarning).not.toBeNull();
      expect(boot.lastRendererWarning).toContain('webgl2-experimental');
      expect(warn).toHaveBeenCalled();
      // Still a working CPU frame: the fallback boots the real renderer.
      expect(boot.refresh).toBeInstanceOf(SoftwareRenderer);
      const stats = boot.host.frame(100);
      expect(stats.pixels).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('applyRendererCvar hot-swap to webgl2-experimental (incapable) records the warning + warns', () => {
    setCVar('vid_renderer', 'software');
    const boot = bootPlay({ width: 64, height: 48 });
    expect(boot.lastRendererWarning).toBeNull();
    setCVar('vid_renderer', 'webgl2-experimental');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(applyRendererCvar(boot)).toBe('software');
      expect(boot.renderer).toBe('software');
      expect(boot.lastRendererWarning).not.toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('software boots and hot-swaps stay warning-free (zero behavior change)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      setCVar('vid_renderer', 'software');
      const boot = bootPlay({ width: 64, height: 48 });
      expect(boot.renderer).toBe('software');
      expect(boot.lastRendererWarning).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      setCVar('vid_renderer', 'software');
      expect(applyRendererCvar(boot)).toBe('software');
      expect(boot.renderer).toBe('software');
      expect(boot.lastRendererWarning).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      // Software boots render a working CPU frame (nonzero resolveDisplay
      // output proves pixels flow through the software resolve).
      for (let t = 0; t <= 500; t += 16) boot.host.frame(t);
      const out = resolveDisplay(boot);
      expect(out.some((px) => px !== 0 && px !== 0xff000000)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("capable webgl2-experimental boot records the selection and wires the GPU backend (PROOF-3 draws on GPU)", () => {
    // Stub a minimal DOM canvas offering a WebGL2 context (no real GL).
    // PROOF-3: the stub context is init/submit-shaped (viewport/clearColor/
    // clear) because bootPlay now actually inits the committed WebGLRenderer
    // on it; pixels for the live loop come from `frameGpuPlay`.
    const g = globalThis as unknown as Record<string, unknown>;
    g['__q2tsGpuStub'] = true;
    g['document'] = {
      createElement: () => ({
        getContext: (kind: string) =>
          kind === 'webgl2'
            ? {
              getParameter: () => 'WebGL 2.0 (stub)',
              VERSION: 7937,
              COLOR_BUFFER_BIT: 16384,
              viewport: () => undefined,
              clearColor: () => undefined,
              clear: () => undefined,
            }
            : null,
      }),
    };
    try {
      const cap = detectGpuCapability();
      expect(cap.available).toBe(true);
      expect(cap.reason).toContain('WebGL 2.0');
      setCVar('vid_renderer', 'webgl2-experimental');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(resolveBootRenderer()).toEqual({ kind: 'webgl2-experimental', warning: null });
        const boot = bootPlay({ width: 64, height: 48 });
        expect(boot.renderer).toBe('webgl2-experimental');
        expect(boot.lastRendererWarning).toBeNull();
        expect(warn).not.toHaveBeenCalled();
        // PROOF-3: the selection is real AND the GPU backend is attached
        // (static scene uploaded once at boot); the CPU SoftwareRenderer
        // stays constructed for the HUD/resolve path.
        expect(boot.gpu).not.toBeNull();
        expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
        expect(boot.refresh).toBeInstanceOf(SoftwareRenderer);
        const stats = boot.host.frame(100);
        expect(stats.pixels).toBeGreaterThan(0);
        // The selection is recorded on the boot (no silent fallback).
        expect(boot.renderer).toBe('webgl2-experimental');
      } finally {
        warn.mockRestore();
      }
    } finally {
      delete g['document'];
      delete g['__q2tsGpuStub'];
    }
  });

  it('getGpuStatus mirrors the boot selection for tests/debug + benchmark gating', () => {
    // Benchmark rule (pinned here): a GPU-labeled leg with
    // active != 'webgl2-experimental' measured the CPU fallback, not the
    // GPU backend — such a leg is VOID.
    setCVar('vid_renderer', 'webgl2-experimental');
    const boot = bootPlay({ width: 64, height: 48 });
    const status = getGpuStatus(boot);
    expect(status.backend).toBe('webgl2-experimental');
    expect(status.active).toBe(boot.renderer);
    expect(status.warning).toBe(boot.lastRendererWarning);
    // Incapable headless boot: active is software WITH a warning → a
    // GPU-labeled benchmark on this box would be VOID.
    expect(status.active).toBe('software');
    expect(status.warning).not.toBeNull();
  });

  it('retired voodoo hot-swap migrates to software WITH a warning (never silent, never GPU)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      setCVar('vid_renderer', 'software');
      const boot = bootPlay({ width: 64, height: 48 });
      expect(boot.lastRendererWarning).toBeNull();
      setCVar('vid_renderer', 'voodoo');
      expect(applyRendererCvar(boot)).toBe('software');
      expect(boot.renderer).toBe('software');
      expect(boot.gpu).toBeNull();
      expect(boot.lastRendererWarning).not.toBeNull();
      expect(boot.lastRendererWarning).toContain('voodoo');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('display panel lists the experimental GPU option with a short experimental label', () => {
    expect(cvarOptions('vid_renderer')).toEqual(['software', 'webgl2-experimental']);
    const labels = cvarOptionLabels('vid_renderer');
    expect(labels).not.toBeNull();
    expect(labels!.length).toBe(2);
    expect(labels![1]).toContain('experimental');
    setRendererChoice('webgl2-experimental');
    expect(cvarOptions('vid_renderer')).toContain('webgl2-experimental');
  });
});
