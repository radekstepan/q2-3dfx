// GPU-FOLLOW-3A production sky replay (apps/web only).
//
// Proves the map sky leaves the pak and reaches the GPU on cold boot,
// CPU→GPU selection and context restore — with per-face dims (never the
// strip total) — and that a deliberately omitted registration fails the
// sky-image check even though the page stays nonblack/colorful. Headless:
// stub DOM/GL (recording); real-pak legs are Q2_PAK-gated.
import { describe, expect, it, afterEach, vi } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { selectGpuScene } from '@q2/webgl-renderer';
import type { RefDef } from '@q2/renderer-api';
import {
  applyRendererCvar,
  bootPlay,
  rebootPlay,
  syncGpuSky,
} from './play.js';
import type { WebPak } from './pak.js';
import {
  skyBackendViolations,
  skyDrawViolations,
  skyStripViolations,
} from '@q2/testkit';
import { GPU_CANVAS_ID } from './gpu-canvas.js';

const WEB_Q2_PAK = process.env.Q2_PAK;

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g['document'];
  vi.unstubAllGlobals();
});

// --- stub DOM/GL (minimal recording pair, mirrors gpu-lifecycle.test.ts) ---

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
        // Record draws + sampler state (the sky-box contract); everything
        // else is noise the production draw path also emits.
        if (prop === 'drawElements') {
          const mode = args[0] === 4 ? 'TRIANGLES' : String(args[0]);
          log.push(`drawElements ${mode} ${String(args[1])} @${String(args[5] ?? 0)}`);
          return undefined;
        }
        if (prop === 'uniform1i') {
          const loc = args[0] as Record<string, unknown> | null;
          const name = (loc as { __name?: string } | null)?.__name;
          if (name === 'uTextured') log.push(`uniform1i uTextured ${String(args[1])}`);
          else log.push(`uniform1i ${String(name ?? '?')} ${String(args[1])}`);
          return undefined;
        }
        log.push(String(prop));
        void args;
        switch (prop) {
          case 'getShaderParameter':
          case 'getProgramParameter':
            return true;
          case 'getAttribLocation':
            return 0;
          case 'getUniformLocation':
            return { __name: String(args[1] ?? '?') };
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
  parentNode: { inserted: unknown[]; children: unknown[]; insertBefore(c: unknown, r: unknown): void; removeChild(c: unknown): void } | null;
  listeners: Map<string, ListenerFn[]>;
  setAttribute(k: string, v: string): void;
  getContext(kind: string): unknown;
  addEventListener(t: string, fn: ListenerFn): void;
  removeEventListener(t: string, fn: ListenerFn): void;
  dispatchEvent(t: string, ev?: unknown): void;
  remove(): void;
}
interface StubDoc {
  log: string[];
  all: StubCanvas[];
  glCanvases: Set<StubCanvas>;
  drawLog: string[];
}

function installStubDoc(): StubDoc {
  const g = globalThis as unknown as Record<string, unknown>;
  const drawLog: string[] = [];
  const gl = makeStubGL(drawLog);
  const doc: StubDoc = { log: [], all: [], glCanvases: new Set(), drawLog };
  const parentNode: NonNullable<StubCanvas['parentNode']> = {
    inserted: [],
    children: [],
    insertBefore(c: unknown, ref: unknown): void {
      parentNode.inserted.push([c, ref]);
      parentNode.children.push(c);
      (c as StubCanvas).parentNode = parentNode;
      if ((c as StubCanvas).id === GPU_CANVAS_ID) doc.glCanvases.add(c as StubCanvas);
    },
    removeChild(c: unknown): void {
      parentNode.children = parentNode.children.filter((x) => x !== c);
      if ((c as StubCanvas).id === GPU_CANVAS_ID) doc.glCanvases.delete(c as StubCanvas);
      (c as StubCanvas).parentNode = null;
    },
  };
  const hud = { id: 'q2', style: {} as Record<string, string>, parentNode };
  const dom = {
    createElement: (tag: string): unknown => {
      if (tag !== 'canvas') return {};
      const canvas: StubCanvas = {
        id: '',
        width: 0,
        height: 0,
        style: {},
        parentNode: null,
        listeners: new Map(),
        setAttribute(k: string, v: string): void { if (k === 'id') canvas.id = v; },
        getContext: (kind: string): unknown => (kind === 'webgl2' ? gl : null),
        addEventListener: (t: string, fn: ListenerFn): void => {
          const arr = canvas.listeners.get(t) ?? [];
          arr.push(fn);
          canvas.listeners.set(t, arr);
        },
        removeEventListener: (t: string, fn: ListenerFn): void => {
          canvas.listeners.set(t, (canvas.listeners.get(t) ?? []).filter((f) => f !== fn));
        },
        dispatchEvent: (t: string, ev: unknown = {}): void => {
          for (const fn of [...(canvas.listeners.get(t) ?? [])]) fn(ev);
        },
        remove: (): void => {
          try { canvas.parentNode?.removeChild(canvas); } catch { /* best-effort */ }
          doc.glCanvases.delete(canvas);
        },
      };
      doc.all.push(canvas);
      return canvas;
    },
    getElementById: (id: string): unknown => {
      if (id === 'q2') return hud;
      if (id === GPU_CANVAS_ID) {
        for (const c of doc.glCanvases) if (c.id === GPU_CANVAS_ID) return c;
        return null;
      }
      return null;
    },
    body: { appendChild: (): void => undefined },
  };
  g['document'] = dom;
  return doc;
}

function liveGlCanvas(doc: StubDoc): StubCanvas {
  for (const c of doc.glCanvases) if (c.id === GPU_CANVAS_ID) return c;
  const found = doc.all.find((c) => c.id === GPU_CANVAS_ID);
  expect(found).toBeDefined();
  return found!;
}

async function readRealPak(): Promise<WebPak> {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  return ingestPak(buf);
}

/** Turned-spawn view with sky refs (probed in FOLLOW-3: F0 spawn-north has none). */
function skyView(): RefDef {
  return {
    origin: new Float32Array([128, -320, 54]),
    angles: new Float32Array([0, 270, 0]),
    fovX: 90,
    time: 1.5,
    lightStyles: new Float32Array(256).fill(1),
  };
}

/** Render one sky-facing selection through the production backend; returns stub draws. */
function renderSkyView(boot: ReturnType<typeof bootPlay>, drawLog: string[]): { sceneSky: number; opaque: number } {
  drawLog.length = 0;
  const gpu = boot.gpu!.gpu;
  const view = skyView();
  const scene = selectGpuScene(boot.driver.mini, [], view, 64, 48);
  const sceneSky = scene.surfaces.filter((r) => r.material === 'sky').length;
  const opaque = scene.surfaces.filter((r) => !r.transparent && r.material !== 'sky').length;
  gpu.setScene(scene);
  gpu.setEntities([], undefined);
  gpu.renderFrame({ view, scene, time: 1.5 });
  return { sceneSky, opaque };
}

describe.runIf(!!WEB_Q2_PAK)('GPU-FOLLOW-3A production sky replay (Q2_PAK)', () => {
  it('cold boot retains the map sky with per-face dims and registers it', { timeout: 180000 }, async () => {
    installStubDoc();
    const pak = await readRealPak();
    setCVar('vid_renderer', 'webgl2-experimental');
    const boot = bootPlay({ width: 96, height: 72, pak });
    expect(boot.renderer).toBe('webgl2-experimental');
    expect(boot.gpu).not.toBeNull();
    // Retained once, never per-frame: real unit1_ art, per-face 256x256.
    expect(boot.sky).not.toBeNull();
    expect(boot.sky!.name).toBe('unit1_');
    expect(boot.sky!.tileW).toBe(256);
    expect(boot.sky!.tileH).toBe(256);
    expect(boot.skyWarning).toBeNull();
    // Known textured region (face rt): real art, not a flat fill.
    expect(skyStripViolations(boot.sky!)).toEqual([]);
    // Production registration happened (per-face dims, not strip height 1536).
    const dims = boot.gpu!.gpu.testSkyStrip();
    expect(dims).toEqual({ tileW: 256, tileH: 256 });
    expect(skyBackendViolations(boot.gpu!.gpu, boot.sky!)).toEqual([]);
  });

  it('sky-facing view draws the textured box with opaque occlusion before/after switch+restore', { timeout: 180000 }, async () => {
    const doc = installStubDoc();
    const pak = await readRealPak();
    setCVar('vid_renderer', 'webgl2-experimental');
    const boot = bootPlay({ width: 96, height: 72, pak });
    const check = (label: string): void => {
      const { sceneSky, opaque } = renderSkyView(boot, doc.drawLog);
      expect(sceneSky, `${label}: scene has sky refs`).toBeGreaterThan(0);
      expect(opaque, `${label}: opaque world occludes`).toBeGreaterThan(0);
      expect(skyDrawViolations(doc.drawLog, true), `${label}: ${doc.drawLog.join(' | ')}`).toEqual([]);
    };
    check('cold boot');
    // CPU→GPU switch replays the retained sky without re-reading the pak.
    setCVar('vid_renderer', 'software');
    expect(applyRendererCvar(boot)).toBe('software');
    expect(boot.gpu).toBeNull();
    setCVar('vid_renderer', 'webgl2-experimental');
    expect(applyRendererCvar(boot)).toBe('webgl2-experimental');
    expect(boot.gpu!.gpu.testSkyStrip()).toEqual({ tileW: 256, tileH: 256 });
    check('after CPU->GPU switch');
    // Loss freezes; restore replays the retained sky under the same handles.
    // The wired canvas listeners drive notify* (dispatch is the production
    // event flow, not a direct call).
    liveGlCanvas(doc).dispatchEvent('webglcontextlost', { preventDefault: () => undefined });
    expect(boot.gpu!.contextLost).toBe(true);
    liveGlCanvas(doc).dispatchEvent('webglcontextrestored', {});
    expect(boot.gpu!.contextLost).toBe(false);
    expect(boot.gpu!.gpu.testSkyStrip()).toEqual({ tileW: 256, tileH: 256 });
    check('after loss+restore');
  });

  it('negative control: omitted registration fails the sky check on a nonblack page', { timeout: 180000 }, async () => {
    const doc = installStubDoc();
    const pak = await readRealPak();
    setCVar('vid_renderer', 'webgl2-experimental');
    const boot = bootPlay({ width: 96, height: 72, pak });
    // Sanity: the production leg passes.
    renderSkyView(boot, doc.drawLog);
    expect(skyDrawViolations(doc.drawLog, true)).toEqual([]);
    expect(skyBackendViolations(boot.gpu!.gpu, boot.sky!)).toEqual([]);
    // Deliberately omit the replay: clear the strip (the flat fallback).
    boot.gpu!.gpu.clearSkyStrip();
    expect(boot.gpu!.gpu.testSkyStrip()).toBeNull();
    // The sky-image check now fails — even though the page still draws
    // (nonblack: hull sky + opaque world draws remain).
    expect(skyBackendViolations(boot.gpu!.gpu, boot.sky!).length).toBeGreaterThan(0);
    renderSkyView(boot, doc.drawLog);
    expect(doc.drawLog.filter((c) => c.startsWith('drawElements')).length).toBeGreaterThan(0);
    expect(skyDrawViolations(doc.drawLog, true).length).toBeGreaterThan(0);
    expect(skyDrawViolations(doc.drawLog, false)).toEqual([]);
    // Re-sync restores the textured sky (idempotent replay).
    expect(syncGpuSky(boot)).toBe(true);
    expect(boot.gpu!.gpu.testSkyStrip()).toEqual({ tileW: 256, tileH: 256 });
    renderSkyView(boot, doc.drawLog);
    expect(skyDrawViolations(doc.drawLog, true)).toEqual([]);
  });

  it('map change replaces the sky: devroom reboot clears to the flat fallback', { timeout: 180000 }, async () => {
    installStubDoc();
    const pak = await readRealPak();
    setCVar('vid_renderer', 'webgl2-experimental');
    const first = bootPlay({ width: 96, height: 72, pak });
    expect(first.sky).not.toBeNull();
    expect(first.gpu!.gpu.testSkyStrip()).not.toBeNull();
    // Menu map_source → devroom rebuilds a fresh boot: no retained sky, and
    // the fresh backend never sees the previous map's strip.
    setCVar('map_source', 'devroom');
    const second = rebootPlay(first);
    expect(second.sky).toBeNull();
    expect(second.skyWarning).not.toBeNull();
    if (second.gpu) {
      expect(second.gpu.gpu.testSkyStrip()).toBeNull();
    }
  });
});
