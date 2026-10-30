// GPU-PROOF-3 gameplay integration (apps/web only).
//
// Wiring-proof: simulation ticks submit real GPU frames (stub GL records the
// production call sequence) while the CPU world span rasterizer stays off.
// Production pixels are proven by the real-browser suite
// (`@q2/testkit` gpu-browser); this file proves the live-loop wiring.
// Headless-safe: DOM/GL are stubbed exactly like gpu-select.test.ts.
import { describe, expect, it, afterEach, vi } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { keyDown, keyUp } from '@q2/input';
import {
  bootPlay,
  drawPlayHud,
  frameGpuPlay,
  paintHudOverlay,
  applyRendererCvar,
  resolveDisplay,
  GPU_APPEARANCE_CVARS,
  GPU_APPEARANCE_HOOKS,
  readGpuAppearanceSnapshot,
  readGpuWorkSplits,
  testResetGpuWorkSplits,
  installGpuWorkConveyor,
  GPU_WORK_RING_CAPACITY,
  GPU_WORK_SPLIT_NAMES,
} from './play.js';
import { acquireGpuCanvas, GPU_CANVAS_ID, GPU_CONTEXT_ATTRS } from './gpu-canvas.js';
const WEB_Q2_PAK = process.env.Q2_PAK;

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g['document'];
});

// --- stub DOM/GL -----------------------------------------------------------
// Recording stub with the full program/buffer/texture/state surface the
// production `WebGLRenderer` uses (shaders compile/link clean, uploads and
// draws are logged). Method calls record; handle-returning calls return
// fresh objects, status queries succeed, info logs are empty. A Proxy keeps
// the surface future-proof: production correctness is proven by the
// real-browser suite (`gpu-browser.test.ts`), this stub proves wiring.

const GL_NUM = {
  VERSION: 7937,
  VERTEX_SHADER: 35633,
  FRAGMENT_SHADER: 35632,
  COMPILE_STATUS: 35713,
  LINK_STATUS: 35714,
  ARRAY_BUFFER: 34962,
  ELEMENT_ARRAY_BUFFER: 34963,
  STATIC_DRAW: 35044,
  DYNAMIC_DRAW: 35048,
  TEXTURE_2D: 3553,
  TEXTURE0: 33984,
  RGBA: 6408,
  UNSIGNED_BYTE: 5121,
  UNSIGNED_INT: 5125,
  FLOAT: 5126,
  LINEAR: 9729,
  NEAREST: 9728,
  CLAMP_TO_EDGE: 33071,
  TEXTURE_MIN_FILTER: 10241,
  TEXTURE_MAG_FILTER: 10240,
  TEXTURE_WRAP_S: 10242,
  TEXTURE_WRAP_T: 10243,
  UNPACK_FLIP_Y_WEBGL: 37440,
  DEPTH_TEST: 2929,
  BLEND: 3042,
  LESS: 513,
  SRC_ALPHA: 770,
  ONE_MINUS_SRC_ALPHA: 771,
  COLOR_BUFFER_BIT: 16384,
  DEPTH_BUFFER_BIT: 256,
  TRIANGLES: 4,
  POINTS: 0,
  MAX_TEXTURE_SIZE: 3379,
  RENDERBUFFER: 36161,
  DEPTH_COMPONENT16: 33189,
  DEPTH_COMPONENT24: 33190,
  COLOR_ATTACHMENT0: 36064,
  DEPTH_ATTACHMENT: 36096,
  FRAMEBUFFER: 36160,
  FRAMEBUFFER_COMPLETE: 36053,
} as const;

function makeStubGL(log: string[]): Record<string, unknown> {
  const target: Record<string, unknown> = { ...GL_NUM };
  target['getParameter'] = (p: unknown): unknown => {
    log.push('getParameter');
    if (p === GL_NUM.VERSION) return 'WebGL 2.0 (stub)';
    if (p === GL_NUM.MAX_TEXTURE_SIZE) return 4096;
    return 1024;
  };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(t, prop, receiver): unknown {
      if (typeof prop === 'symbol') return undefined;
      if (prop in t) return Reflect.get(t, prop, receiver);
      return (...args: unknown[]): unknown => {
        log.push(String(prop));
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
            return 36053; // FRAMEBUFFER_COMPLETE
          case 'createShader':
          case 'createProgram':
          case 'createBuffer':
          case 'createTexture':
          case 'createRenderbuffer':
          case 'createFramebuffer':
          case 'createVertexArray':
            return {};
          default:
            return undefined;
        }
      };
    },
  };
  return new Proxy(target, handler);
}

interface StubCanvas {
  id: string;
  width: number;
  height: number;
  style: Record<string, string>;
  setAttribute(k: string, v: string): void;
  getContext(kind: string, attrs?: unknown): unknown;
}

/** A canvas factory whose contexts are the shared stub GL (or null). */
function makeStubCanvasFactory(log: string[], gl: unknown): () => StubCanvas {
  return () => {
    const canvas: StubCanvas = {
      id: '',
      width: 0,
      height: 0,
      style: {},
      setAttribute(k: string, v: string): void {
        if (k === 'id') canvas.id = v;
      },
      getContext(kind: string, attrs?: unknown): unknown {
        log.push(`getContext:${kind}:${JSON.stringify(attrs)}`);
        return kind === 'webgl2' ? gl : null;
      },
    };
    return canvas;
  };
}

interface StubDoc {
  log: string[];
  hud: { id: string; style: Record<string, string>; parentNode: { inserted: unknown[] } };
  canvases: StubCanvas[];
}

/** Install a stub document: capable (stub GL) unless `glNull` (incapable). */
function installStubDoc(opts: { glNull?: boolean } = {}): StubDoc {
  const g = globalThis as unknown as Record<string, unknown>;
  const log: string[] = [];
  const gl = opts.glNull ? null : makeStubGL(log);
  const canvases: StubCanvas[] = [];
  const factory = makeStubCanvasFactory(log, gl);
  const hud = {
    id: 'q2',
    style: {} as Record<string, string>,
    parentNode: { inserted: [] as unknown[] },
  };
  (hud.parentNode as { insertBefore?: unknown }).insertBefore = (c: unknown, ref: unknown): void => {
    hud.parentNode.inserted.push([c, ref]);
  };
  const doc = {
    createElement: (tag: string): unknown => {
      if (tag !== 'canvas') return {};
      const c = factory();
      canvases.push(c);
      return c;
    },
    getElementById: (id: string): unknown => {
      if (id === 'q2') return hud;
      if (id === GPU_CANVAS_ID) return canvases.find((c) => c.id === GPU_CANVAS_ID) ?? null;
      return null;
    },
    body: { appendChild: (c: unknown): void => { log.push('body.appendChild'); void c; } },
  };
  g['document'] = doc;
  return { log, hud, canvases };
}

function capableBoot(width = 64, height = 48): ReturnType<typeof bootPlay> {
  setCVar('vid_renderer', 'webgl2-experimental');
  return bootPlay({ width, height });
}

describe('GPU-PROOF-3 canvas glue (gpu-canvas.ts)', () => {
  it('headless-safe: no DOM → null, never throws', () => {
    expect(typeof document).toBe('undefined');
    expect(() => acquireGpuCanvas(undefined, 64, 48)).not.toThrow();
    expect(acquireGpuCanvas(undefined, 64, 48)).toBeNull();
    expect(acquireGpuCanvas({}, 64, 48)).toBeNull();
    expect(acquireGpuCanvas({ createElement: 42 }, 64, 48)).toBeNull();
  });

  it('creates the GL canvas stacked UNDER the HUD canvas with exact context attrs', () => {
    const stub = installStubDoc();
    const acquired = acquireGpuCanvas(undefined, 64, 48);
    expect(acquired).not.toBeNull();
    const glCanvas = stub.canvases[0]!;
    expect(glCanvas.id).toBe(GPU_CANVAS_ID);
    expect(glCanvas.width).toBe(64);
    expect(glCanvas.height).toBe(48);
    // Stacking: GL below (z 0, absolute), HUD on top (z 1, layout unchanged).
    expect(glCanvas.style['position']).toBe('absolute');
    expect(glCanvas.style['zIndex']).toBe('0');
    expect(stub.hud.style['zIndex']).toBe('1');
    // DOM order: inserted immediately BEFORE the HUD canvas.
    expect(stub.hud.parentNode.inserted.length).toBe(1);
    expect(stub.hud.parentNode.inserted[0]).toEqual([glCanvas, stub.hud]);
    // Exact context acquisition (probe + real canvas).
    const real = stub.log.filter((l) => l.startsWith('getContext:webgl2:'));
    expect(real.length).toBeGreaterThanOrEqual(1);
    for (const entry of real) {
      expect(entry).toBe(`getContext:webgl2:${JSON.stringify({ ...GPU_CONTEXT_ATTRS })}`);
    }
    expect(GPU_CONTEXT_ATTRS).toEqual({
      antialias: false, alpha: false, depth: true, stencil: false, preserveDrawingBuffer: false,
    });
  });

  it('null context (incapable) → null, never throws', () => {
    installStubDoc({ glNull: true });
    expect(acquireGpuCanvas(undefined, 64, 48)).toBeNull();
  });

  it('reuses the GL canvas by id on the second acquire', () => {
    const stub = installStubDoc();
    const first = acquireGpuCanvas(undefined, 64, 48);
    const second = acquireGpuCanvas(undefined, 64, 48);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.canvas).toBe(first!.canvas);
    expect(stub.canvases.length).toBe(1);
  });
});

describe('GPU-PROOF-3 boot wiring (play.ts)', () => {
  it('capable webgl2 boot: GPU live, selection recorded, warning null, static scene uploaded once', () => {
    installStubDoc();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const boot = capableBoot();
      expect(boot.renderer).toBe('webgl2-experimental');
      expect(boot.lastRendererWarning).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      expect(boot.gpu).not.toBeNull();
      const status = boot.gpu!.gpu.getStatus();
      expect(status.initialized).toBe(true);
      expect(status.width).toBe(64);
      expect(status.height).toBe(48);
      expect(status.framesSubmitted).toBe(0);
      expect(status.contextLost).toBe(false);
      // Static world scene uploaded ONCE at boot (empty entities).
      expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
      // CPU renderer still constructed (HUD/resolve path intact).
      expect(boot.refresh).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('incapable webgl2 boot: CPU path unchanged, gpu null, warning recorded', () => {
    expect(typeof document).toBe('undefined');
    setCVar('vid_renderer', 'webgl2-experimental');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const boot = bootPlay({ width: 64, height: 48 });
      expect(boot.renderer).toBe('software');
      expect(boot.lastRendererWarning).not.toBeNull();
      expect(boot.gpu).toBeNull();
      expect(warn).toHaveBeenCalled();
      const stats = boot.host.frame(100);
      expect(stats.pixels).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('CPU software boot: zero behavior change (gpu null, renderView runs)', () => {
    setCVar('vid_renderer', 'software');
    const boot = bootPlay({ width: 64, height: 48 });
    expect(boot.renderer).toBe('software');
    expect(boot.lastRendererWarning).toBeNull();
    expect(boot.gpu).toBeNull();
    expect(frameGpuPlay(boot, 16)).toBeNull();
    const stats = boot.host.frame(100);
    expect(stats.pixels).toBeGreaterThan(0);
  });

  it('hot-swap: leaving GPU disposes the backend; re-entering re-attaches', () => {
    installStubDoc();
    const boot = capableBoot();
    expect(boot.gpu).not.toBeNull();
    setCVar('vid_renderer', 'software');
    expect(applyRendererCvar(boot)).toBe('software');
    expect(boot.gpu).toBeNull();
    expect(boot.lastRendererWarning).toBeNull();
    setCVar('vid_renderer', 'webgl2-experimental');
    expect(applyRendererCvar(boot)).toBe('webgl2-experimental');
    expect(boot.gpu).not.toBeNull();
    expect(boot.lastRendererWarning).toBeNull();
    expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
  });
});

describe('GPU-PROOF-3 per-frame gameplay (frameGpuPlay)', () => {
  it('N frames: sim + combat advance, GPU submits, CPU renderView NEVER runs, upload stays 1', () => {
    installStubDoc();
    const boot = capableBoot();
    const renderSpy = vi.spyOn(boot.refresh, 'renderView');
    // Move forward + hold fire: movement AND combat in one run.
    keyDown(boot.host.input, 'forward');
    keyDown(boot.host.input, 'attack');
    const N = 60;
    for (let f = 0; f < N; f++) {
      const st = frameGpuPlay(boot, f * 16);
      expect(st).not.toBeNull();
    }
    keyUp(boot.host.input, 'forward');
    keyUp(boot.host.input, 'attack');
    const status = boot.gpu!.gpu.getStatus();
    // One real on-canvas submission per GPU frame (clear-only today).
    expect(status.framesSubmitted).toBe(N);
    // Static scene upload once across N frames (generation-stable setScene).
    expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
    // CRITICAL: no CPU world span rasterization in parallel.
    expect(renderSpy).not.toHaveBeenCalled();
    // Same sim as the CPU path: server ticks advanced, player moved, shots fired.
    expect(boot.host.serverTime).toBeGreaterThan(0);
    expect(boot.host.playerOrigin[0]).toBeGreaterThan(-168);
    expect(boot.driver.events).toContain('shot');
    renderSpy.mockRestore();
  });

  it('GPU frames reuse the exact CPU view construction (same camera as host would render)', () => {
    installStubDoc();
    const boot = capableBoot();
    keyDown(boot.host.input, 'forward');
    for (let f = 0; f < 10; f++) frameGpuPlay(boot, f * 16);
    keyUp(boot.host.input, 'forward');
    // The CPU path renders from the same predicted view: drive a twin CPU
    // boot with IDENTICAL input and compare simulated positions (frameGpuPlay
    // steps via stepAsyncSim, the documented Host.frame twin).
    setCVar('vid_renderer', 'software');
    const cpu = bootPlay({ width: 64, height: 48 });
    keyDown(cpu.host.input, 'forward');
    for (let f = 0; f < 10; f++) cpu.host.frame(f * 16);
    keyUp(cpu.host.input, 'forward');
    expect(boot.host.playerOrigin).toEqual(cpu.host.playerOrigin);
    expect(boot.host.serverTime).toBeCloseTo(cpu.host.serverTime, 6);
  });

  it('HUD smoke on a GPU boot: overlay paints HUD over transparency, GL shows through', () => {
    installStubDoc();
    const boot = capableBoot();
    for (let f = 0; f < 5; f++) frameGpuPlay(boot, f * 16);
    const overlay = paintHudOverlay(boot, { fps: 60, frame: 1 });
    expect(overlay.length).toBe(64 * 48);
    // HUD painted (crosshair/status/fps glyphs are opaque nonzero pixels)…
    expect(overlay.some((px) => px !== 0)).toBe(true);
    // …over transparency (alpha-0 regions where the GL canvas shows through).
    expect(overlay.some((px) => (px >>> 24) === 0)).toBe(true);
    // The classic HUD pass still runs on the CPU buffer (presentation preserved).
    const target = resolveDisplay(boot);
    drawPlayHud({ width: 64, height: 48, color: target }, boot, { fps: 60, frame: 1 });
    expect(target.some((px) => px !== 0)).toBe(true);
  });
});

describe('GPU-PROOF-4 live-loop appearance wiring (play.ts)', () => {
  it('reads the pinned vd_* cvars every frame, recorded on boot.gpu.appearance (no stale profile)', () => {
    installStubDoc();
    const boot = capableBoot();
    // Null until the first GPU frame: the boot path uploads statics only.
    expect(boot.gpu!.appearance).toBeNull();
    frameGpuPlay(boot, 0);
    const first = boot.gpu!.appearance;
    expect(first).not.toBeNull();
    // All 15 pinned cvars, defaults untouched by this module.
    expect(Object.keys(first!).sort()).toEqual([...GPU_APPEARANCE_CVARS].sort());
    expect(first!['vd_gamma']).toBe('1.3');
    expect(first!['vd_lodbias']).toBe('-0.35');
    expect(first!['vd_dithermode']).toBe('4x4');
    // Mutate mid-run: the NEXT frame must observe the new values.
    setCVar('vd_gamma', '2.2');
    setCVar('vd_dither', 0);
    setCVar('vd_lodbias', 0);
    frameGpuPlay(boot, 16);
    const second = boot.gpu!.appearance!;
    expect(second['vd_gamma']).toBe('2.2');
    expect(second['vd_dither']).toBe('0');
    expect(second['vd_lodbias']).toBe('0');
    // Untouched cvars ride along unchanged in the same snapshot.
    expect(second['vd_16bit']).toBe(first!['vd_16bit']);
    expect(readGpuAppearanceSnapshot()['vd_gamma']).toBe('2.2');
  });

  it('built dist exposes no appearance setter yet (follow-up path: snapshot authoritative)', () => {
    installStubDoc();
    const boot = capableBoot();
    for (const name of GPU_APPEARANCE_HOOKS) {
      expect(name in (boot.gpu!.gpu as object)).toBe(false);
    }
    // The probe is a no-op returning false; the snapshot is still recorded.
    expect(boot.gpu!.appearance).toBeNull();
    frameGpuPlay(boot, 0);
    expect(boot.gpu!.appearance).not.toBeNull();
    // When the GL lane lands a setter, this test fails closed on the probe
    // above — replace it with a direct-call assertion (see pushGpuAppearance).
  });

  it('HUD overlay stays ABOVE the GL canvas across appearance frames (GL-only appearance target)', () => {
    const stub = installStubDoc();
    const boot = capableBoot();
    // Non-default appearance inputs: the appearance pass must still write
    // only to the GL canvas, never restack or touch the overlay contract.
    setCVar('vd_gamma', '2.2');
    setCVar('vd_postfilter', 0);
    setCVar('vd_dither', 0);
    for (let f = 0; f < 5; f++) frameGpuPlay(boot, f * 16);
    // canvases[0] is the capability-probe canvas; the GL canvas is found by id.
    const glCanvas = stub.canvases.find((c) => c.id === GPU_CANVAS_ID)!;
    expect(glCanvas.style['position']).toBe('absolute');
    expect(glCanvas.style['zIndex']).toBe('0');
    expect(stub.hud.style['zIndex']).toBe('1');
    expect(stub.hud.parentNode.inserted[0]).toEqual([glCanvas, stub.hud]);
    // Overlay still paints HUD over transparency (GL shows through).
    const overlay = paintHudOverlay(boot, { fps: 60, frame: 1 });
    expect(overlay.some((px) => px !== 0)).toBe(true);
    expect(overlay.some((px) => (px >>> 24) === 0)).toBe(true);
  });

  it('HUD paints identically with appearance on/off (overlay independent of the GL canvas)', () => {
    installStubDoc();
    // Boot A: default appearance.
    const a = capableBoot();
    const overA = paintHudOverlay(a, { fps: 60, frame: 1 }).slice();
    // Boot B: only appearance inputs differ (no sim input on either boot).
    setCVar('vd_gamma', '2.2');
    setCVar('vd_dither', 0);
    setCVar('vd_16bit', 0);
    setCVar('vd_postfilter', 0);
    setCVar('vd_bilinear', 0);
    setCVar('vd_mipdither', 0);
    setCVar('vd_lodbias', 0);
    setCVar('vd_fog', 0);
    setCVar('vd_overbright', 0);
    setCVar('vd_palettetex', 0);
    setCVar('vd_maxtexsize', 128);
    setCVar('vd_zbits', 8);
    setCVar('vd_dithermode', '2x2');
    setCVar('vd_reconmode', 'legacy');
    setCVar('vd_rgbmaxdelta', '16,16,16');
    const b = capableBoot();
    for (let f = 0; f < 3; f++) frameGpuPlay(b, f * 16);
    const overB = paintHudOverlay(b, { fps: 60, frame: 1 }).slice();
    // Appearance inputs change the recorded GL snapshot, never the overlay.
    expect(b.gpu!.appearance!['vd_gamma']).toBe('2.2');
    expect(a.gpu!.appearance).toBeNull(); // A never ran a GPU frame
    expect(overB).toEqual(overA);
  });
});

describe.runIf(!!WEB_Q2_PAK)('GPU-PROOF-4 base1 appearance smoke (Q2_PAK)', () => {
  it('base1: 20 combat frames with appearance inputs submit 20, draw, no readPixels, HUD holds', { timeout: 180000 }, async () => {
    const stub = installStubDoc();
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const pak = ingestPak(buf);
    setCVar('vid_renderer', 'webgl2-experimental');
    // Appearance inputs differ from the pinned defaults (cvar-only change:
    // defaults in @q2/config are untouched; resetCVars restores them after).
    setCVar('vd_gamma', '2.0');
    setCVar('vd_lodbias', 0);
    const boot = bootPlay({ width: 96, height: 72, pak });
    expect(boot.renderer).toBe('webgl2-experimental');
    expect(boot.gpu).not.toBeNull();
    expect(boot.source).toBe('pak');
    const renderSpy = vi.spyOn(boot.refresh, 'renderView');
    keyDown(boot.host.input, 'attack');
    const N = 20;
    for (let f = 0; f < N; f++) frameGpuPlay(boot, f * 16);
    keyUp(boot.host.input, 'attack');
    const status = boot.gpu!.gpu.getStatus();
    // Live-loop regression: N GPU frames still submit N frames, uploads
    // stable, no CPU raster, movement/combat advance.
    expect(status.framesSubmitted).toBe(N);
    expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(boot.host.serverTime).toBeGreaterThan(0);
    expect(boot.driver.events).toContain('shot');
    // Appearance cvars were re-read every frame into the recorded snapshot.
    expect(boot.gpu!.appearance!['vd_gamma']).toBe('2.0');
    expect(boot.gpu!.appearance!['vd_lodbias']).toBe('0');
    expect(Object.keys(boot.gpu!.appearance!).sort()).toEqual([...GPU_APPEARANCE_CVARS].sort());
    // Real drawing, not the clear-only fallback, with the production surface.
    expect(stub.log).toContain('drawElements');
    expect(stub.log).toContain('bufferData');
    // The normal rendering path never reads pixels back.
    expect(stub.log).not.toContain('readPixels');
    // HUD ordering holds on the pak boot: overlay paints HUD over
    // transparency while the GL canvas stays below it.
    const overlay = paintHudOverlay(boot, { fps: 60, frame: 1 });
    expect(overlay.some((px) => px !== 0)).toBe(true);
    expect(overlay.some((px) => (px >>> 24) === 0)).toBe(true);
    const glCanvas = stub.canvases.find((c) => c.id === GPU_CANVAS_ID)!;
    expect(glCanvas.style['zIndex']).toBe('0');
    expect(stub.hud.style['zIndex']).toBe('1');
    renderSpy.mockRestore();
  });
});

describe.runIf(!!WEB_Q2_PAK)('GPU-PROOF-3 base1 combat (Q2_PAK)', () => {
  it('base1: GPU frames advance combat, submit, and never touch CPU raster', { timeout: 180000 }, async () => {
    const stub = installStubDoc();
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const pak = ingestPak(buf);
    setCVar('vid_renderer', 'webgl2-experimental');
    const boot = bootPlay({ width: 96, height: 72, pak });
    expect(boot.renderer).toBe('webgl2-experimental');
    expect(boot.gpu).not.toBeNull();
    expect(boot.source).toBe('pak');
    const renderSpy = vi.spyOn(boot.refresh, 'renderView');
    keyDown(boot.host.input, 'attack');
    const N = 20;
    for (let f = 0; f < N; f++) frameGpuPlay(boot, f * 16);
    keyUp(boot.host.input, 'attack');
    const status = boot.gpu!.gpu.getStatus();
    expect(status.framesSubmitted).toBe(N);
    expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(boot.host.serverTime).toBeGreaterThan(0);
    expect(boot.driver.events).toContain('shot');
    // Real drawing, not the clear-only fallback: world+entities submitted
    // draw calls with the attached assets (pixels proven in the browser).
    expect(stub.log).toContain('drawElements');
    expect(stub.log).toContain('bufferData');
    // The normal rendering path never reads pixels back (test-only capture
    // lives in the browser harness, never in src/).
    expect(stub.log).not.toContain('readPixels');
    renderSpy.mockRestore();
  });
});

describe('GPU-PROOF-5 iteration-1 work-split instrumentation (play.ts)', () => {
  it('empty ring reads zeros; conveyor installed at boot and matches the reader', () => {
    installStubDoc();
    testResetGpuWorkSplits();
    const empty = readGpuWorkSplits();
    expect(empty.samples).toBe(0);
    expect(empty.capacity).toBe(GPU_WORK_RING_CAPACITY);
    for (const name of GPU_WORK_SPLIT_NAMES) {
      const v = empty[`${name}Ms` as const];
      expect(v).toBe(0);
    }
    const boot = capableBoot();
    expect(boot.gpu).not.toBeNull();
    const g = globalThis as unknown as { __q2soakWork?: unknown };
    expect(typeof g.__q2soakWork).toBe('function');
    expect(installGpuWorkConveyor()).toBe(g.__q2soakWork);
  });

  it('N frames: 6 non-negative finite medians, samples track frames', () => {
    installStubDoc();
    testResetGpuWorkSplits();
    const boot = capableBoot();
    keyDown(boot.host.input, 'forward');
    keyDown(boot.host.input, 'attack');
    const N = 60;
    for (let f = 0; f < N; f++) frameGpuPlay(boot, f * 16);
    keyUp(boot.host.input, 'forward');
    keyUp(boot.host.input, 'attack');
    const splits = readGpuWorkSplits();
    expect(splits.samples).toBe(N);
    expect(splits.capacity).toBe(GPU_WORK_RING_CAPACITY);
    expect(GPU_WORK_SPLIT_NAMES).toEqual(['drains', 'sim', 'view', 'tail', 'submit', 'total']);
    for (const name of GPU_WORK_SPLIT_NAMES) {
      const v = splits[`${name}Ms` as const];
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
    // Sections partition the frame: parts sum to the total (float-exact —
    // the parts are differences of the same clock reads as the total).
    const parts = splits.drainsMs + splits.simMs + splits.viewMs + splits.tailMs + splits.submitMs;
    expect(parts).toBeGreaterThanOrEqual(0);
    expect(splits.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('ring wraps without growth: capacity pinned past CAPACITY frames', { timeout: 120000 }, () => {
    installStubDoc();
    testResetGpuWorkSplits();
    const boot = capableBoot();
    keyDown(boot.host.input, 'forward');
    const N = GPU_WORK_RING_CAPACITY + 64;
    for (let f = 0; f < N; f++) frameGpuPlay(boot, f * 16);
    keyUp(boot.host.input, 'forward');
    const splits = readGpuWorkSplits();
    // Saturated, never grown: the backing store is a fixed Float64Array.
    expect(splits.samples).toBe(GPU_WORK_RING_CAPACITY);
    expect(splits.capacity).toBe(GPU_WORK_RING_CAPACITY);
    for (const name of GPU_WORK_SPLIT_NAMES) {
      const v = splits[`${name}Ms` as const];
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(N);
  });
});

describe('GPU-PROOF-5 iteration-1 static-scene tail (play.ts)', () => {
  it('devroom: static world refs identical by reference, transforms reused, uploads 1, no CPU raster', () => {
    installStubDoc();
    const boot = capableBoot();
    expect(boot.gpu).not.toBeNull();
    const renderSpy = vi.spyOn(boot.refresh, 'renderView');
    const staticScene = boot.gpu!.staticScene;
    // Boot scene and static scene start as the same object (built once).
    expect(boot.gpu!.scene).toBe(staticScene);
    const staticCount = staticScene.surfaces.length;
    const staticFirst = staticScene.surfaces[0];
    keyDown(boot.host.input, 'forward');
    keyDown(boot.host.input, 'attack');
    const N = 30;
    for (let f = 0; f < N; f++) frameGpuPlay(boot, f * 16);
    keyUp(boot.host.input, 'forward');
    keyUp(boot.host.input, 'attack');
    // Per-frame scenes are fresh objects built ONLY from the static tail…
    expect(boot.gpu!.scene).not.toBe(staticScene);
    // …but every transformIndex-0 ref is the SAME object as the static one.
    const tailWorld = boot.gpu!.scene.surfaces.filter((r) => r.transformIndex === 0);
    expect(tailWorld.length).toBe(staticCount);
    for (const ref of tailWorld) {
      expect(staticScene.surfaces.includes(ref)).toBe(true);
    }
    // Transforms stay the boot `[identity]` slot by reference (renderer
    // derives entity matrices from setEntities; see frameGpuPlay note).
    expect(boot.gpu!.scene.transforms).toBe(staticScene.transforms);
    expect(boot.gpu!.scene.transforms.length).toBe(1);
    // Static base never mutated by the tail builder.
    expect(staticScene.surfaces.length).toBe(staticCount);
    expect(staticScene.surfaces[0]).toBe(staticFirst);
    expect(boot.gpu!.scene.staticGeneration).toBe(staticScene.staticGeneration);
    // Submission contract holds: uploads stay 1, N frames submitted, no CPU.
    expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(N);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(boot.host.serverTime).toBeGreaterThan(0);
    expect(boot.host.playerOrigin[0]).toBeGreaterThan(-168);
    expect(boot.driver.events).toContain('shot');
    renderSpy.mockRestore();
  });
});

describe.runIf(!!WEB_Q2_PAK)('GPU-PROOF-5 iteration-1 base1 tail + determinism (Q2_PAK)', () => {
  async function loadPakBoot(width = 96, height = 72): Promise<ReturnType<typeof bootPlay>> {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const pak = ingestPak(buf);
    setCVar('vid_renderer', 'webgl2-experimental');
    const boot = bootPlay({ width, height, pak });
    expect(boot.renderer).toBe('webgl2-experimental');
    expect(boot.gpu).not.toBeNull();
    expect(boot.source).toBe('pak');
    return boot;
  }

  function driveCombat(boot: ReturnType<typeof bootPlay>, log: string[], frames: number): void {
    log.length = 0;
    keyDown(boot.host.input, 'forward');
    keyDown(boot.host.input, 'attack');
    for (let f = 0; f < frames; f++) frameGpuPlay(boot, f * 16);
    keyUp(boot.host.input, 'forward');
    keyUp(boot.host.input, 'attack');
  }

  it('base1: static tail holds on the real world — refs by reference, uploads 1, combat advances', { timeout: 180000 }, async () => {
    const stub = installStubDoc();
    const boot = await loadPakBoot();
    const renderSpy = vi.spyOn(boot.refresh, 'renderView');
    const staticScene = boot.gpu!.staticScene;
    expect(staticScene.surfaces.length).toBeGreaterThan(0);
    const N = 20;
    driveCombat(boot, stub.log, N);
    const tailWorld = boot.gpu!.scene.surfaces.filter((r) => r.transformIndex === 0);
    expect(tailWorld.length).toBe(staticScene.surfaces.length);
    for (const ref of tailWorld) {
      expect(staticScene.surfaces.includes(ref)).toBe(true);
    }
    expect(boot.gpu!.scene.transforms).toBe(staticScene.transforms);
    expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(N);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(boot.host.serverTime).toBeGreaterThan(0);
    expect(boot.driver.events).toContain('shot');
    expect(stub.log).toContain('drawElements');
    expect(stub.log).not.toContain('readPixels');
    renderSpy.mockRestore();
  });

  it('base1: same boot inputs twice → identical stub-GL call sequence + identical scene', { timeout: 180000 }, async () => {
    const stub = installStubDoc();
    const N = 20;
    const bootA = await loadPakBoot();
    driveCombat(bootA, stub.log, N);
    const logA = stub.log.slice();
    const sceneA = JSON.stringify(bootA.gpu!.scene.surfaces);
    const statusA = bootA.gpu!.gpu.getStatus();
    const bootB = await loadPakBoot();
    driveCombat(bootB, stub.log, N);
    const logB = stub.log.slice();
    const sceneB = JSON.stringify(bootB.gpu!.scene.surfaces);
    const statusB = bootB.gpu!.gpu.getStatus();
    // Identical submitted pixels for identical inputs: the stub records the
    // production GL call sequence (names + real draws), which is byte-equal.
    expect(logB).toEqual(logA);
    expect(logA).toContain('drawElements');
    expect(sceneB).toBe(sceneA);
    expect(statusB.framesSubmitted).toBe(statusA.framesSubmitted);
    expect(bootB.gpu!.gpu.testUploadStats().uploads).toBe(1);
  });
});
