// GPU-FOLLOW-0 presentation regression (apps/web only).
//
// Stub-DOM pins for the black-browser fix: the HUD canvas (#q2) stylesheet
// background (#000) used to paint black OVER the GL canvas (#q2-gl) because
// the transparent overlay ImageData cannot remove a CSS background. The fix
// syncs GL CSS geometry to the HUD displayed size, toggles the HUD inline
// background transparent in GPU mode ('' on CPU), and removes/hides the GL
// canvas on CPU fallback.
import { describe, expect, it, afterEach, vi } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import {
  acquireGpuCanvas,
  GPU_CANVAS_ID,
  hideGpuCanvas,
  removeGpuCanvas,
  setHudTransparent,
  syncGpuCanvasToHud,
} from './gpu-canvas.js';
import { applyRendererCvar, bootPlay } from './play.js';

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g['document'];
});

interface StubCanvas {
  id: string;
  width: number;
  height: number;
  style: Record<string, string>;
  parentNode: { inserted: unknown[]; removed: unknown[] } | null;
  setAttribute(k: string, v: string): void;
  getContext(kind: string, attrs?: unknown): unknown;
  remove(): void;
}

interface StubDoc {
  hud: StubCanvas;
  canvases: StubCanvas[];
  glNull: boolean;
}

function makeGL(): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(t, prop): unknown {
      if (typeof prop === 'symbol') return undefined;
      if (prop in t) return Reflect.get(t, prop);
      return (...args: unknown[]): unknown => {
        void args;
        switch (prop) {
          case 'getShaderParameter':
          case 'getProgramParameter':
            return true;
          case 'getShaderInfoLog':
          case 'getProgramInfoLog':
            return '';
          case 'getAttribLocation':
            return 0;
          case 'getUniformLocation':
            return {};
          case 'getError':
            return 0;
          case 'checkFramebufferStatus':
            return 36053;
          case 'createShader':
          case 'createProgram':
          case 'createBuffer':
          case 'createTexture':
          case 'createRenderbuffer':
          case 'createFramebuffer':
          case 'createVertexArray':
            return {};
          case 'getParameter':
            return 1024;
          default:
            return undefined;
        }
      };
    },
  };
  return new Proxy(target, handler);
}

function installStub(opts: { glNull?: boolean } = {}): StubDoc {
  const g = globalThis as unknown as Record<string, unknown>;
  const gl = opts.glNull === true ? null : makeGL();
  const canvases: StubCanvas[] = [];
  const hud: StubCanvas = {
    id: 'q2',
    width: 64,
    height: 48,
    style: {},
    parentNode: { inserted: [], removed: [] },
    setAttribute(k: string, v: string): void {
      if (k === 'id') hud.id = v;
    },
    getContext(): unknown {
      return null;
    },
    remove(): void {
      hud.style['display'] = 'none';
    },
  };
  const parent = hud.parentNode as {
    inserted: unknown[];
    removed: unknown[];
    insertBefore?: (n: unknown, ref: unknown) => void;
    removeChild?: (n: unknown) => void;
  };
  parent.insertBefore = (c: unknown, ref: unknown): void => {
    parent.inserted.push([c, ref]);
    const cc = c as StubCanvas;
    cc.parentNode = hud.parentNode;
  };
  parent.removeChild = (c: unknown): void => {
    parent.removed.push(c);
    const cc = c as StubCanvas;
    cc.parentNode = null;
  };
  const factory = (): StubCanvas => {
    const canvas: StubCanvas = {
      id: '',
      width: 0,
      height: 0,
      style: {},
      parentNode: null,
      setAttribute(k: string, v: string): void {
        if (k === 'id') canvas.id = v;
      },
      getContext(kind: string): unknown {
        return kind === 'webgl2' ? gl : null;
      },
      remove(): void {
        canvas.style['display'] = 'none';
        canvas.parentNode = null;
      },
    };
    canvases.push(canvas);
    return canvas;
  };
  const doc = {
    createElement: (tag: string): unknown => (tag === 'canvas' ? factory() : {}),
    getElementById: (id: string): unknown => {
      if (id === 'q2') return hud;
      if (id === GPU_CANVAS_ID) return canvases.find((c) => c.id === GPU_CANVAS_ID) ?? null;
      return null;
    },
    body: { appendChild: (): void => undefined },
  };
  g['document'] = doc;
  return { hud, canvases, glNull: opts.glNull === true };
}

function capableBoot(): ReturnType<typeof bootPlay> {
  setCVar('vid_renderer', 'webgl2-experimental');
  return bootPlay({ width: 64, height: 48 });
}

describe('GPU-FOLLOW-0 canvas presentation (gpu-canvas.ts)', () => {
  it('headless-safe: helpers return false, never throw without DOM', () => {
    expect(() => syncGpuCanvasToHud(undefined)).not.toThrow();
    expect(() => setHudTransparent(undefined, true)).not.toThrow();
    expect(() => removeGpuCanvas(undefined)).not.toThrow();
    expect(() => hideGpuCanvas(undefined)).not.toThrow();
    expect(syncGpuCanvasToHud(undefined)).toBe(false);
    expect(setHudTransparent(undefined, true)).toBe(false);
    expect(removeGpuCanvas(undefined)).toBe(false);
    expect(hideGpuCanvas(undefined)).toBe(false);
  });

  it('acquire stacks GL under HUD with aligned offsets and matching CSS size', () => {
    const stub = installStub();
    stub.hud.style['width'] = '128px';
    stub.hud.style['height'] = '96px';
    const acquired = acquireGpuCanvas(undefined, 64, 48);
    expect(acquired).not.toBeNull();
    const gl = stub.canvases.find((c) => c.id === GPU_CANVAS_ID)!;
    expect(gl.style['position']).toBe('absolute');
    expect(gl.style['left']).toBe('0');
    expect(gl.style['top']).toBe('0');
    expect(gl.style['zIndex']).toBe('0');
    expect(gl.style['width']).toBe('128px');
    expect(gl.style['height']).toBe('96px');
    expect(stub.hud.style['zIndex']).toBe('1');
    expect(gl.width).toBe(64);
    expect(gl.height).toBe(48);
  });

  it('sync copies HUD displayed size onto GL and keeps stacking', () => {
    const stub = installStub();
    stub.hud.style['width'] = '128px';
    stub.hud.style['height'] = '96px';
    acquireGpuCanvas(undefined, 64, 48);
    const gl = stub.canvases.find((c) => c.id === GPU_CANVAS_ID)!;
    stub.hud.style['width'] = '640px';
    stub.hud.style['height'] = '480px';
    expect(syncGpuCanvasToHud(undefined)).toBe(true);
    expect(gl.style['width']).toBe('640px');
    expect(gl.style['height']).toBe('480px');
    expect(gl.style['left']).toBe('0');
    expect(gl.style['top']).toBe('0');
    expect(gl.style['zIndex']).toBe('0');
    expect(stub.hud.style['zIndex']).toBe('1');
    // Explicit-hud calling convention also works.
    stub.hud.style['width'] = '320px';
    expect(syncGpuCanvasToHud(undefined, stub.hud)).toBe(true);
    expect(gl.style['width']).toBe('320px');
  });

  it('sync falls back to backing*2 when no HUD CSS size is set', () => {
    const stub = installStub();
    acquireGpuCanvas(undefined, 64, 48);
    const gl = stub.canvases.find((c) => c.id === GPU_CANVAS_ID)!;
    expect(gl.style['width']).toBe('128px');
    expect(gl.style['height']).toBe('96px');
  });

  it('setHudTransparent toggles inline background transparent vs empty', () => {
    installStub();
    expect(setHudTransparent(undefined, true)).toBe(true);
    const g = globalThis as unknown as { document: { getElementById(id: string): StubCanvas } };
    expect(g.document.getElementById('q2').style['background']).toBe('transparent');
    expect(setHudTransparent(undefined, false)).toBe(true);
    expect(g.document.getElementById('q2').style['background']).toBe('');
  });

  it('removeGpuCanvas removes the GL node and restores HUD stacking', () => {
    const stub = installStub();
    stub.hud.style['width'] = '128px';
    stub.hud.style['height'] = '96px';
    acquireGpuCanvas(undefined, 64, 48);
    setHudTransparent(undefined, true);
    expect(stub.hud.parentNode!.inserted.length).toBe(1);
    expect(removeGpuCanvas(undefined)).toBe(true);
    expect(stub.hud.parentNode!.removed.length).toBe(1);
    expect(stub.hud.style['zIndex']).toBe('');
    expect(stub.hud.style['position']).toBe('');
  });
});

describe('GPU-FOLLOW-0 attach/detach presentation (play.ts)', () => {
  it('GPU boot: transparent HUD on, GL aligned under HUD with matching CSS size', () => {
    const stub = installStub();
    const boot = capableBoot();
    expect(boot.renderer).toBe('webgl2-experimental');
    expect(boot.gpu).not.toBeNull();
    expect(stub.hud.style['background']).toBe('transparent');
    const gl = stub.canvases.find((c) => c.id === GPU_CANVAS_ID)!;
    expect(gl.style['zIndex']).toBe('0');
    expect(stub.hud.style['zIndex']).toBe('1');
    expect(gl.style['width']).toBe(stub.hud.style['width'] || '128px');
    expect(gl.style['height']).toBe(stub.hud.style['height'] || '96px');
  });

  it('leaving GPU restores CPU presentation: opaque HUD, GL removed, backend disposed', () => {
    const stub = installStub();
    const boot = capableBoot();
    expect(boot.gpu).not.toBeNull();
    const gpu = boot.gpu!.gpu;
    const disposeSpy = vi.spyOn(gpu, 'dispose');
    setCVar('vid_renderer', 'software');
    expect(applyRendererCvar(boot)).toBe('software');
    expect(boot.gpu).toBeNull();
    expect(disposeSpy).toHaveBeenCalled();
    expect(stub.hud.style['background']).toBe('');
    expect(stub.hud.style['zIndex']).toBe('');
    // GL node removed from the HUD parent (or hidden when removal unsupported).
    const gl = stub.canvases.find((c) => c.id === GPU_CANVAS_ID)!;
    expect(stub.hud.parentNode!.removed.length + (gl.style['display'] === 'none' ? 1 : 0)).toBeGreaterThan(0);
    disposeSpy.mockRestore();
  });

  it('failed GPU attach falls back to software WITH warning and CPU presentation', () => {
    installStub({ glNull: true });
    setCVar('vid_renderer', 'webgl2-experimental');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const boot = bootPlay({ width: 64, height: 48 });
      expect(boot.renderer).toBe('software');
      expect(boot.gpu).toBeNull();
      expect(boot.lastRendererWarning).not.toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
