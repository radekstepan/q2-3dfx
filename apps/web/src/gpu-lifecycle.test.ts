// GPU-FOLLOW-4 app-side lifecycle (apps/web only).
//
// (1) Real canvas `webglcontextlost`/`webglcontextrestored` wiring:
//     prevent-default on loss (restoration opt-in), safe submission stop,
//     exactly-once listeners across repeated cycles.
// (2) CPU→GPU→GPU→CPU switching stays green, extended to actual loss/recovery,
//     unsupported-device fallback (explicitly labelled, never GPU execution),
//     and repeated switch/map/loss cycles with stable resource counts and
//     correct rendered output.
// (3) HUD overlay stays synchronized across resize/switch (FOLLOW-2A replay
//     is reused for restoration; asset migration is never rebuilt here).
// Headless-safe: stub DOM/GL with a recording event target; real-pak legs
// are Q2_PAK-gated. The real-browser context-loss mechanism is exercised
// out-of-band (SwiftShader + WEBGL_lose_context, see the lane report).
import { describe, expect, it, afterEach, vi } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { keyDown, keyUp } from '@q2/input';
import {
  applyRendererCvar,
  bootPlay,
  frameGpuPlay,
  gpuFallbackLabel,
  gpuFramesSubmitted,
  notifyGpuContextLost,
  notifyGpuContextRestored,
  paintHudOverlay,
  rebootPlay,
  replayPakAssetsToGpu,
  resizeGpuBackend,
  unwireGpuLifecycle,
  wireGpuLifecycle,
} from './play.js';
import type { GpuAssetSink, PakModelHandles } from './play.js';
import type { WebPak } from './pak.js';
import {
  attachGpuCanvasLifecycle,
  GPU_CANVAS_ID,
  hasGpuCanvasLifecycle,
  setGpuCanvasSize,
} from './gpu-canvas.js';
import { readSoakGpuLifecycle } from './soak.js';

const WEB_Q2_PAK = process.env.Q2_PAK;

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g['document'];
});

// --- stub DOM/GL (recording event targets) ---------------------------------

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
            return 36053;
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

type ListenerFn = (ev: unknown) => void;

interface StubCanvas {
  id: string;
  width: number;
  height: number;
  style: Record<string, string>;
  parentNode: {
    inserted: unknown[];
    children: unknown[];
    insertBefore(c: unknown, ref: unknown): void;
    removeChild(c: unknown): void;
  } | null;
  listeners: Map<string, ListenerFn[]>;
  setAttribute(k: string, v: string): void;
  getContext(kind: string, attrs?: unknown): unknown;
  addEventListener(type: string, fn: ListenerFn): void;
  removeEventListener(type: string, fn: ListenerFn): void;
  dispatchEvent(type: string, ev?: unknown): void;
  remove(): void;
}

function makeStubCanvas(log: string[], gl: unknown, doc: StubDoc): StubCanvas {
  const canvas: StubCanvas = {
    id: '',
    width: 0,
    height: 0,
    style: {},
    parentNode: null,
    listeners: new Map(),
    setAttribute(k: string, v: string): void {
      if (k === 'id') canvas.id = v;
    },
    getContext(kind: string, attrs?: unknown): unknown {
      log.push(`getContext:${kind}:${JSON.stringify(attrs)}`);
      return kind === 'webgl2' ? gl : null;
    },
    addEventListener(type: string, fn: ListenerFn): void {
      log.push(`addEventListener:${type}`);
      const arr = canvas.listeners.get(type) ?? [];
      arr.push(fn);
      canvas.listeners.set(type, arr);
    },
    removeEventListener(type: string, fn: ListenerFn): void {
      log.push(`removeEventListener:${type}`);
      const arr = canvas.listeners.get(type) ?? [];
      canvas.listeners.set(
        type,
        arr.filter((f) => f !== fn),
      );
    },
    dispatchEvent(type: string, ev: unknown = {}): void {
      for (const fn of [...(canvas.listeners.get(type) ?? [])]) fn(ev);
    },
    remove(): void {
      try {
        canvas.parentNode?.removeChild(canvas);
      } catch {
        /* best-effort */
      }
      doc.glCanvases.delete(canvas);
    },
  };
  return canvas;
}

interface StubDoc {
  log: string[];
  hud: { id: string; style: Record<string, string>; parentNode: StubCanvas['parentNode'] };
  /** Every canvas ever created (probe + GL): creation count stability. */
  all: StubCanvas[];
  /** Live GL canvases by id (mirrors real-DOM lookup after removals). */
  glCanvases: Set<StubCanvas>;
}

/** Install a stub document: capable (stub GL) unless `glNull` (incapable). */
function installStubDoc(opts: { glNull?: boolean } = {}): StubDoc {
  const g = globalThis as unknown as Record<string, unknown>;
  const log: string[] = [];
  const gl = opts.glNull ? null : makeStubGL(log);
  const doc: StubDoc = { log, hud: null as unknown as StubDoc['hud'], all: [], glCanvases: new Set() };
  const parentNode: StubCanvas['parentNode'] = {
    inserted: [],
    children: [],
    insertBefore(c: unknown, ref: unknown): void {
      parentNode!.inserted.push([c, ref]);
      parentNode!.children.push(c);
      (c as StubCanvas).parentNode = parentNode;
      if ((c as StubCanvas).id === GPU_CANVAS_ID) doc.glCanvases.add(c as StubCanvas);
    },
    removeChild(c: unknown): void {
      parentNode!.children = parentNode!.children.filter((x) => x !== c);
      if ((c as StubCanvas).id === GPU_CANVAS_ID) doc.glCanvases.delete(c as StubCanvas);
      (c as StubCanvas).parentNode = null;
    },
  };
  const hud = { id: 'q2', style: {} as Record<string, string>, parentNode };
  doc.hud = hud;
  const dom = {
    createElement: (tag: string): unknown => {
      if (tag !== 'canvas') return {};
      const c = makeStubCanvas(log, gl, doc);
      doc.all.push(c);
      return c;
    },
    getElementById: (id: string): unknown => {
      if (id === 'q2') return hud;
      if (id === GPU_CANVAS_ID) {
        for (const c of doc.glCanvases) {
          if (c.id === GPU_CANVAS_ID) return c;
        }
        return null;
      }
      return null;
    },
    body: { appendChild: (c: unknown): void => { log.push('body.appendChild'); void c; } },
  };
  g['document'] = dom;
  return doc;
}

function capableBoot(width = 64, height = 48): ReturnType<typeof bootPlay> {
  setCVar('vid_renderer', 'webgl2-experimental');
  return bootPlay({ width, height });
}

function liveGlCanvas(doc: StubDoc): StubCanvas {
  // Prefer the live (attached) canvas: after a GPU→CPU removal + re-attach
  // the re-acquire creates a fresh element (the removed one stays detached).
  for (const c of doc.glCanvases) {
    if (c.id === GPU_CANVAS_ID) return c;
  }
  const found = doc.all.find((c) => c.id === GPU_CANVAS_ID);
  expect(found).toBeDefined();
  return found!;
}

function listenerCount(c: StubCanvas, type: string): number {
  return c.listeners.get(type)?.length ?? 0;
}

function makeLossEvent(): { preventDefault: () => void; prevented: () => boolean } {
  let prevented = false;
  return {
    preventDefault: (): void => {
      prevented = true;
    },
    prevented: (): boolean => prevented,
  };
}

/** Snapshot of gameplay state that must survive renderer switches. */
function snapshotGameplay(boot: ReturnType<typeof bootPlay>): string {
  const d = boot.driver;
  return JSON.stringify({
    origin: [...d.pm.origin],
    angles: [...d.pm.viewAngles],
    health: d.ps.health,
    shells: d.shells,
    weapon: d.weapon.classname,
    monsters: d.server.monsters.map((x) => [x.edict.num, x.state.health, [...x.edict.origin]]),
    time: d.server.time,
    models: d.models,
  });
}

async function readRealPak(): Promise<WebPak> {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  return ingestPak(buf);
}

/** Every model handle the registry owns (soldier 0 first, barrel/corpse last). */
function expectedModelHandles(m: PakModelHandles): number[] {
  const out = [
    m.monster, m.gunner, m.infantry, m.bolt, m.barrel,
    m.explode, m.blast, m.debris1, m.debris2, m.debris3,
    m.gibMeat, m.gibChest, m.gibBone, m.gibHead,
    m.ship, m.banner, m.corpse,
    ...Object.values(m.weapons),
    ...Object.values(m.items).map((e) => e.model),
  ];
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Every skin handle (deduped; includes soldier light/ss + weapon/item skins). */
function expectedSkinHandles(m: PakModelHandles): number[] {
  return [...new Set(m.skins)].sort((a, b) => a - b);
}

/** Registry completeness: every retained handle resolves in the GPU backend. */
function expectRegistryComplete(boot: ReturnType<typeof bootPlay>): void {
  const m = boot.models;
  expect(m).not.toBeNull();
  const gpu = boot.gpu?.gpu;
  expect(gpu).toBeDefined();
  const backendModels = new Set(gpu!.testRegisteredModels());
  for (const h of expectedModelHandles(m!)) {
    expect(backendModels.has(h)).toBe(true);
  }
  const backendSkins = new Set(gpu!.testRegisteredSkins());
  for (const h of expectedSkinHandles(m!)) {
    expect(backendSkins.has(h)).toBe(true);
  }
  const meshless = gpu!.testWarnings().filter((w) => /no mesh|mesh-less/i.test(w));
  expect(meshless).toEqual([]);
}

describe('GPU-FOLLOW-4 canvas lifecycle unit (gpu-canvas.ts)', () => {
  it('replace-on-attach: a second attach disposes the first, never stacking', () => {
    installStubDoc();
    // Raw canvas shape (no boot): attach A, then attach B without disposing.
    const g = globalThis as unknown as { document: { createElement(tag: string): unknown } };
    const canvas = g.document.createElement('canvas') as StubCanvas;
    let aLost = 0;
    let bLost = 0;
    let bRestored = 0;
    attachGpuCanvasLifecycle(canvas, {
      onLost: () => { aLost++; },
      onRestored: () => { /* replaced */ },
    });
    expect(hasGpuCanvasLifecycle(canvas)).toBe(true);
    expect(listenerCount(canvas, 'webglcontextlost')).toBe(1);
    expect(listenerCount(canvas, 'webglcontextrestored')).toBe(1);
    attachGpuCanvasLifecycle(canvas, {
      onLost: () => { bLost++; },
      onRestored: () => { bRestored++; },
    });
    // Still exactly one pair active; the stale pair was removed first.
    expect(listenerCount(canvas, 'webglcontextlost')).toBe(1);
    expect(listenerCount(canvas, 'webglcontextrestored')).toBe(1);
    canvas.dispatchEvent('webglcontextlost', makeLossEvent());
    expect(aLost).toBe(0);
    expect(bLost).toBe(1);
    canvas.dispatchEvent('webglcontextrestored', {});
    expect(bRestored).toBe(1);
  });

  it('dispose is idempotent and silences the canvas; non-targets are safe no-ops', () => {
    const g = globalThis as unknown as { document: { createElement(tag: string): unknown } };
    installStubDoc();
    const canvas = g.document.createElement('canvas') as StubCanvas;
    let lost = 0;
    const dispose = attachGpuCanvasLifecycle(canvas, {
      onLost: () => { lost++; },
      onRestored: () => { /* noop */ },
    });
    expect(hasGpuCanvasLifecycle(canvas)).toBe(true);
    expect(() => dispose()).not.toThrow();
    expect(() => dispose()).not.toThrow();
    expect(hasGpuCanvasLifecycle(canvas)).toBe(false);
    canvas.dispatchEvent('webglcontextlost', makeLossEvent());
    expect(lost).toBe(0);
    // Non event-targets / nulls never throw and report detached.
    const noop = attachGpuCanvasLifecycle({}, { onLost: () => undefined, onRestored: () => undefined });
    expect(() => noop()).not.toThrow();
    expect(hasGpuCanvasLifecycle({})).toBe(false);
    expect(hasGpuCanvasLifecycle(null)).toBe(false);
  });

  it('setGpuCanvasSize applies valid sizes, ignores the rest', () => {
    const g = globalThis as unknown as { document: { createElement(tag: string): unknown } };
    installStubDoc();
    const canvas = g.document.createElement('canvas') as StubCanvas;
    expect(setGpuCanvasSize(canvas, 64, 48)).toBe(true);
    expect(canvas.width).toBe(64);
    expect(canvas.height).toBe(48);
    expect(setGpuCanvasSize(canvas, 64, 48)).toBe(true);
    expect(setGpuCanvasSize(canvas, 0, 48)).toBe(false);
    expect(setGpuCanvasSize(canvas, 64, -1)).toBe(false);
    expect(setGpuCanvasSize(canvas, 64.5, 48)).toBe(false);
    expect(setGpuCanvasSize(canvas, Number.NaN, 48)).toBe(false);
    expect(canvas.width).toBe(64);
    expect(canvas.height).toBe(48);
    expect(setGpuCanvasSize(null, 64, 48)).toBe(false);
    expect(setGpuCanvasSize({}, 64, 48)).toBe(false);
  });
});

describe('GPU-FOLLOW-4 loss/restore wiring (stub DOM, no pak)', () => {
  it('wires exactly one lost + one restored listener; re-wire never duplicates', () => {
    const stub = installStubDoc();
    const boot = capableBoot();
    expect(boot.gpu).not.toBeNull();
    const gl = liveGlCanvas(stub);
    expect(listenerCount(gl, 'webglcontextlost')).toBe(1);
    expect(listenerCount(gl, 'webglcontextrestored')).toBe(1);
    expect(hasGpuCanvasLifecycle(gl)).toBe(true);
    // Re-wiring replaces (remove-then-add): active count stays 1.
    expect(wireGpuLifecycle(boot)).toBe(true);
    expect(wireGpuLifecycle(boot)).toBe(true);
    expect(listenerCount(gl, 'webglcontextlost')).toBe(1);
    expect(listenerCount(gl, 'webglcontextrestored')).toBe(1);
    expect(stub.log.filter((l) => l === 'removeEventListener:webglcontextlost').length).toBeGreaterThan(0);
    // One dispatch = one loss, not one per wire call.
    gl.dispatchEvent('webglcontextlost', makeLossEvent());
    expect(boot.gpu!.lossCount).toBe(1);
    expect(notifyGpuContextLost(boot)).toBe(false);
    expect(boot.gpu!.lossCount).toBe(1);
  });

  it('loss prevent-defaults, freezes submission + sim; restore replays and resumes', () => {
    const stub = installStubDoc();
    const boot = capableBoot();
    keyDown(boot.host.input, 'forward');
    for (let f = 0; f < 5; f++) frameGpuPlay(boot, f * 16);
    keyUp(boot.host.input, 'forward');
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(5);
    const timeBefore = boot.host.serverTime;
    const uploadsBefore = boot.gpu!.gpu.testUploadStats().uploads;
    // Real event names through the stub target: preventDefault must run
    // (restoration opt-in where the platform supports it).
    const loss = makeLossEvent();
    liveGlCanvas(stub).dispatchEvent('webglcontextlost', loss);
    expect(loss.prevented()).toBe(true);
    expect(boot.gpu!.contextLost).toBe(true);
    expect(boot.gpu!.lossCount).toBe(1);
    expect(boot.gpu!.gpu.getStatus().contextLost).toBe(true);
    // Safe stop: frames return null, submissions and the sim clock freeze.
    for (let f = 5; f < 8; f++) expect(frameGpuPlay(boot, f * 16)).toBeNull();
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(5);
    expect(boot.host.serverTime).toBe(timeBefore);
    // Restore without a preceding loss is a no-op (returns false, counts kept).
    expect(notifyGpuContextLost(boot)).toBe(false);
    // Restoration: backend targets re-created, HUD re-synced, gate cleared.
    liveGlCanvas(stub).dispatchEvent('webglcontextrestored', {});
    expect(boot.gpu!.contextLost).toBe(false);
    expect(boot.gpu!.restoreCount).toBe(1);
    expect(boot.gpu!.gpu.getStatus().contextLost).toBe(false);
    expect(notifyGpuContextRestored(boot)).toBe(false);
    expect(boot.gpu!.restoreCount).toBe(1);
    // Submission resumes on the same backend; uploads never re-bump
    // (persistent upload bookkeeping survives the restore).
    for (let f = 8; f < 11; f++) frameGpuPlay(boot, f * 16);
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(8);
    expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(uploadsBefore);
    // HUD overlay contract holds across the cycle (HUD above the GL canvas).
    expect(liveGlCanvas(stub).style['zIndex']).toBe('0');
    expect(stub.hud.style['zIndex']).toBe('1');
    const overlay = paintHudOverlay(boot, { fps: 60, frame: 1 });
    expect(overlay.some((px) => px !== 0)).toBe(true);
    expect(overlay.some((px) => (px >>> 24) === 0)).toBe(true);
    // Devroom boots submit the clear-only path (no world/palette attached):
    // viewport + clear ran, nothing read back. Real draws are proven on the
    // Q2_PAK legs below.
    expect(stub.log).toContain('viewport');
    expect(stub.log).toContain('clear');
    expect(stub.log).not.toContain('readPixels');
  });

  it('unwire silences a detached canvas; notify is safe without a backend', () => {
    const stub = installStubDoc();
    const boot = capableBoot();
    const gl = liveGlCanvas(stub);
    unwireGpuLifecycle(boot);
    expect(hasGpuCanvasLifecycle(gl)).toBe(false);
    gl.dispatchEvent('webglcontextlost', makeLossEvent());
    expect(boot.gpu!.lossCount).toBe(0);
    expect(boot.gpu!.contextLost).toBe(false);
    // Frames keep submitting after an unwired (no-op) event.
    for (let f = 0; f < 3; f++) frameGpuPlay(boot, f * 16);
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(3);
    // CPU-only boots: notify/wire/resize are safe no-ops.
    setCVar('vid_renderer', 'software');
    const cpu = bootPlay({ width: 64, height: 48 });
    expect(cpu.gpu).toBeNull();
    expect(notifyGpuContextLost(cpu)).toBe(false);
    expect(notifyGpuContextRestored(cpu)).toBe(false);
    expect(wireGpuLifecycle(cpu)).toBe(false);
    expect(resizeGpuBackend(cpu, 128, 96)).toBe(false);
    expect(gpuFramesSubmitted(cpu)).toBe(0);
  });
});

describe('GPU-FOLLOW-4 unsupported-device fallback (stub DOM, no pak)', () => {
  it('incapable boot is explicit, submits zero GPU frames, leaves no canvas', () => {
    const stub = installStubDoc({ glNull: true });
    setCVar('vid_renderer', 'webgl2-experimental');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const boot = bootPlay({ width: 64, height: 48 });
      expect(boot.renderer).toBe('software');
      expect(boot.gpu).toBeNull();
      // Explicitly labelled: the warning names the requested backend.
      expect(boot.lastRendererWarning).not.toBeNull();
      expect(boot.lastRendererWarning!).toMatch(/webgl2/);
      expect(gpuFallbackLabel(boot)).toBe(boot.lastRendererWarning);
      // Never counted as GPU execution: zero submissions across CPU frames.
      for (let f = 0; f < 10; f++) boot.host.frame(f * 16);
      expect(gpuFramesSubmitted(boot)).toBe(0);
      // No orphan canvas or listener survives the failed acquire.
      expect(stub.glCanvases.size).toBe(0);
      for (const c of stub.all) expect(hasGpuCanvasLifecycle(c)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('hot-swap fallback is explicit and leaves no listeners behind', () => {
    const stub = installStubDoc({ glNull: true });
    setCVar('vid_renderer', 'software');
    const boot = bootPlay({ width: 64, height: 48 });
    expect(boot.gpu).toBeNull();
    expect(gpuFallbackLabel(boot)).toBeNull();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      setCVar('vid_renderer', 'webgl2-experimental');
      expect(applyRendererCvar(boot)).toBe('software');
      expect(boot.gpu).toBeNull();
      expect(gpuFallbackLabel(boot)).not.toBeNull();
      expect(gpuFallbackLabel(boot)!).toMatch(/webgl2/);
      for (let f = 0; f < 10; f++) boot.host.frame(f * 16);
      expect(gpuFramesSubmitted(boot)).toBe(0);
      expect(stub.glCanvases.size).toBe(0);
      for (const c of stub.all) expect(hasGpuCanvasLifecycle(c)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('live GPU boots report no fallback label', () => {
    installStubDoc();
    const boot = capableBoot();
    expect(boot.gpu).not.toBeNull();
    expect(gpuFallbackLabel(boot)).toBeNull();
    for (let f = 0; f < 4; f++) frameGpuPlay(boot, f * 16);
    expect(gpuFramesSubmitted(boot)).toBe(4);
  });
});

describe('GPU-FOLLOW-4 resize sync (stub DOM, no pak)', () => {
  it('resize syncs backing, backend, viewport target and HUD; bad sizes no-op', () => {
    const stub = installStubDoc();
    const boot = capableBoot(64, 48);
    expect(boot.gpu!.gpu.getStatus().width).toBe(64);
    const uploadsBefore = boot.gpu!.gpu.testUploadStats().uploads;
    expect(resizeGpuBackend(boot, 128, 96)).toBe(true);
    const gl = liveGlCanvas(stub);
    expect(gl.width).toBe(128);
    expect(gl.height).toBe(96);
    expect(boot.gpu!.gpu.getStatus().width).toBe(128);
    expect(boot.gpu!.gpu.getStatus().height).toBe(96);
    // HUD pair re-synced: GL below (z 0), overlay above (z 1).
    expect(gl.style['zIndex']).toBe('0');
    expect(stub.hud.style['zIndex']).toBe('1');
    // Rendering continues at the new size with no re-upload and no readback
    // (devroom: clear-only submit — viewport + clear ran, see above).
    for (let f = 0; f < 3; f++) frameGpuPlay(boot, f * 16);
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(3);
    expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(uploadsBefore);
    expect(stub.log).toContain('viewport');
    expect(stub.log).toContain('clear');
    expect(stub.log).not.toContain('readPixels');
    // Invalid sizes are safe no-ops (dims + uploads untouched).
    expect(resizeGpuBackend(boot, 0, 96)).toBe(false);
    expect(resizeGpuBackend(boot, -4, 96)).toBe(false);
    expect(resizeGpuBackend(boot, 128.5, 96)).toBe(false);
    expect(resizeGpuBackend(boot, 128, 96)).toBe(true);
    expect(boot.gpu!.gpu.getStatus().width).toBe(128);
    expect(boot.gpu!.gpu.getStatus().height).toBe(96);
  });
});

describe('GPU-FOLLOW-4 repeated switch cycles (stub DOM, no pak)', () => {
  it('three CPU→GPU→CPU rounds preserve gameplay with one canvas and no leaks', () => {
    const stub = installStubDoc();
    setCVar('vid_renderer', 'software');
    const boot = bootPlay({ width: 64, height: 48 });
    expect(boot.gpu).toBeNull();
    // Play a while on software first.
    keyDown(boot.host.input, 'forward');
    for (let f = 0; f < 10; f++) boot.host.frame(f * 16);
    keyUp(boot.host.input, 'forward');
    for (let round = 0; round < 3; round++) {
      const before = snapshotGameplay(boot);
      // CPU→GPU: same handles, gameplay untouched, listeners live.
      setCVar('vid_renderer', 'webgl2-experimental');
      expect(applyRendererCvar(boot)).toBe('webgl2-experimental');
      expect(boot.gpu).not.toBeNull();
      expect(snapshotGameplay(boot)).toBe(before);
      // Exactly one live GL canvas (re-acquired after the previous removal).
      expect(stub.glCanvases.size).toBe(1);
      expect(hasGpuCanvasLifecycle(liveGlCanvas(stub))).toBe(true);
      for (let f = 0; f < 5; f++) frameGpuPlay(boot, 1000 + round * 100 + f * 16);
      expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(5);
      expect(gpuFramesSubmitted(boot)).toBe(5);
      const canvas = liveGlCanvas(stub);
      // GPU→CPU: backend disposed, listeners removed, CPU intact.
      const oldGpu = boot.gpu!.gpu;
      setCVar('vid_renderer', 'software');
      expect(applyRendererCvar(boot)).toBe('software');
      expect(boot.gpu).toBeNull();
      expect(oldGpu.getStatus().initialized).toBe(false);
      expect(hasGpuCanvasLifecycle(canvas)).toBe(false);
      expect(snapshotGameplay(boot)).toBe(before);
      const stats = boot.host.frame(2000 + round * 100);
      expect(stats.pixels).toBeGreaterThan(0);
      expect(gpuFramesSubmitted(boot)).toBe(0);
      // The removed canvas left the live DOM (no duplicates accumulate).
      expect(stub.glCanvases.size).toBe(0);
    }
    // No listener pile-up on any canvas object ever created, HUD restored.
    for (const c of stub.all) {
      expect(listenerCount(c, 'webglcontextlost')).toBe(0);
      expect(listenerCount(c, 'webglcontextrestored')).toBe(0);
    }
    expect(stub.hud.style['zIndex']).toBe('');
  });
});

describe('GPU-FOLLOW-4 soak lifecycle reader', () => {
  it('returns null before any soak boot lands (safe probe)', () => {
    expect(readSoakGpuLifecycle()).toBeNull();
  });
});

describe('GPU-FOLLOW-4 replay reuse pins (stub DOM, no pak)', () => {
  it('replay entry points stay total: nulls and throwing sinks are contained', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Null handles/sink are safe no-ops (dispose paths, devroom boots).
      expect(replayPakAssetsToGpu(null, null)).toEqual({ models: 0, skins: 0 });
      // An empty retained cache replays to zero without warnings.
      expect(
        replayPakAssetsToGpu({ assets: { models: [], skins: [] } } as unknown as PakModelHandles, {
          registerModelData: (): void => undefined,
          registerSkinPixels: (): number => 0,
        } as GpuAssetSink),
      ).toEqual({ models: 0, skins: 0 });
      const warned = warn.mock.calls.map((c) => String(c[0]));
      expect(warned.filter((m) => m.includes('replayPakAssetsToGpu'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe.runIf(!!WEB_Q2_PAK)('GPU-FOLLOW-4 pak loss/restore + repeated cycles (Q2_PAK)', () => {
  it('loss freezes, restore replays the retained cache: registry complete, uploads stable', { timeout: 180000 }, async () => {
    const stub = installStubDoc();
    const pak = await readRealPak();
    setCVar('vid_renderer', 'webgl2-experimental');
    const boot = bootPlay({ width: 96, height: 72, pak });
    expect(boot.renderer).toBe('webgl2-experimental');
    expect(boot.gpu).not.toBeNull();
    expectRegistryComplete(boot);
    keyDown(boot.host.input, 'attack');
    for (let f = 0; f < 10; f++) frameGpuPlay(boot, f * 16);
    keyUp(boot.host.input, 'attack');
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(10);
    expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
    // Actual event flow: preventDefault runs, submission + sim freeze.
    const loss = makeLossEvent();
    liveGlCanvas(stub).dispatchEvent('webglcontextlost', loss);
    expect(loss.prevented()).toBe(true);
    const submittedAtLoss = boot.gpu!.gpu.getStatus().framesSubmitted;
    for (let f = 10; f < 14; f++) expect(frameGpuPlay(boot, f * 16)).toBeNull();
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(submittedAtLoss);
    // Restoration replays the retained FOLLOW-2A cache under the same handles.
    liveGlCanvas(stub).dispatchEvent('webglcontextrestored', {});
    expect(boot.gpu!.restoreCount).toBe(1);
    expectRegistryComplete(boot);
    expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
    keyDown(boot.host.input, 'attack');
    for (let f = 14; f < 24; f++) frameGpuPlay(boot, f * 16);
    keyUp(boot.host.input, 'attack');
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(20);
    expect(boot.driver.events).toContain('shot');
    // Correct rendered output: real draws, no readback, HUD over transparency.
    expect(stub.log).toContain('drawElements');
    expect(stub.log).not.toContain('readPixels');
    const overlay = paintHudOverlay(boot, { fps: 60, frame: 1 });
    expect(overlay.some((px) => px !== 0)).toBe(true);
    expect(overlay.some((px) => (px >>> 24) === 0)).toBe(true);
    const gl = liveGlCanvas(stub);
    expect(gl.style['zIndex']).toBe('0');
    expect(stub.hud.style['zIndex']).toBe('1');
  });

  it('repeated switch/map/loss cycles: stable counts, one canvas, correct output', { timeout: 240000 }, async () => {
    const stub = installStubDoc();
    const pak = await readRealPak();
    setCVar('vid_renderer', 'webgl2-experimental');
    const boot = bootPlay({ width: 96, height: 72, pak });
    expect(boot.gpu).not.toBeNull();
    let totalLoss = 0;
    let totalRestore = 0;
    for (let round = 0; round < 3; round++) {
      // Combat frames on the live leg.
      keyDown(boot.host.input, 'attack');
      const legStart = boot.gpu!.gpu.getStatus().framesSubmitted;
      for (let f = 0; f < 5; f++) frameGpuPlay(boot, round * 1000 + f * 16);
      keyUp(boot.host.input, 'attack');
      expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(legStart + 5);
      expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
      // Actual loss → actual restore on the same leg.
      liveGlCanvas(stub).dispatchEvent('webglcontextlost', makeLossEvent());
      expect(boot.gpu!.contextLost).toBe(true);
      expect(frameGpuPlay(boot, round * 1000 + 500)).toBeNull();
      liveGlCanvas(stub).dispatchEvent('webglcontextrestored', {});
      expect(boot.gpu!.contextLost).toBe(false);
      // Per-leg counts: this attach saw exactly one loss + one restore.
      expect(boot.gpu!.lossCount).toBe(1);
      expect(boot.gpu!.restoreCount).toBe(1);
      totalLoss++;
      totalRestore++;
      // GPU→CPU→GPU: state preserved, registry complete, uploads pinned to 1.
      const before = snapshotGameplay(boot);
      setCVar('vid_renderer', 'software');
      expect(applyRendererCvar(boot)).toBe('software');
      expect(boot.gpu).toBeNull();
      boot.host.frame(round * 1000 + 900);
      setCVar('vid_renderer', 'webgl2-experimental');
      expect(applyRendererCvar(boot)).toBe('webgl2-experimental');
      expect(snapshotGameplay(boot)).toBe(before);
      expectRegistryComplete(boot);
      expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
    }
    // Stable resources: exactly one live canvas (removed canvases never
    // accumulate in the DOM), one live listener pair, exact HUD sync.
    expect(stub.glCanvases.size).toBe(1);
    const gl = liveGlCanvas(stub);
    expect(listenerCount(gl, 'webglcontextlost')).toBe(1);
    expect(listenerCount(gl, 'webglcontextrestored')).toBe(1);
    // NOTE: lossCount/restoreCount live on the per-attach GpuBootState: the
    // totals prove all three cycles ran; the final leg is a fresh post-switch
    // attach whose own counters start at zero.
    expect(totalLoss).toBe(3);
    expect(totalRestore).toBe(3);
    expect(boot.gpu!.lossCount).toBe(0);
    expect(boot.gpu!.restoreCount).toBe(0);
    expect(gl.style['zIndex']).toBe('0');
    expect(stub.hud.style['zIndex']).toBe('1');
    expect(stub.log).toContain('drawElements');
    expect(stub.log).not.toContain('readPixels');
    const overlay = paintHudOverlay(boot, { fps: 60, frame: 1 });
    expect(overlay.some((px) => px !== 0)).toBe(true);
    expect(stub.log.filter((l) => l === 'addEventListener:webglcontextlost').length).toBeGreaterThanOrEqual(1);
  });

  it('map cycle via reboot reuses the canvas and restores the full registry', { timeout: 180000 }, async () => {
    const stub = installStubDoc();
    const pak = await readRealPak();
    setCVar('vid_renderer', 'webgl2-experimental');
    const first = bootPlay({ width: 96, height: 72, pak });
    expect(first.gpu).not.toBeNull();
    expectRegistryComplete(first);
    for (let f = 0; f < 5; f++) frameGpuPlay(first, f * 16);
    const glBefore = stub.all.filter((c) => c.id === GPU_CANVAS_ID).length;
    expect(glBefore).toBe(1);
    // A fresh map boot (same pak, same renderer) reuses the GL canvas by id
    // and replays the retained cache under the same handles — no duplicates
    // (the +1 canvas is the capability probe every boot performs).
    const allBefore = stub.all.length;
    const second = rebootPlay(first);
    expect(second.renderer).toBe('webgl2-experimental');
    expect(second.gpu).not.toBeNull();
    expect(stub.all.filter((c) => c.id === GPU_CANVAS_ID).length).toBe(1);
    expect(stub.all.length).toBe(allBefore + 1);
    expectRegistryComplete(second);
    expect(second.models!.monster).toBe(0);
    expect(second.models!.monsterSkin).toBe(0);
    for (let f = 0; f < 5; f++) frameGpuPlay(second, f * 16);
    expect(second.gpu!.gpu.getStatus().framesSubmitted).toBe(5);
    expect(second.gpu!.gpu.testUploadStats().uploads).toBe(1);
    expect(stub.log).toContain('drawElements');
  });
});
