// GPU-FOLLOW-2A hot-swap asset migration (apps/web only).
//
// Cold GPU boot and CPU→GPU hot-swap must both deliver every retained
// MD2/PCX asset into the GPU backend under the SAME handles — entities never
// stay mesh-less, CPU handles never drift, gameplay state survives switches.
// Headless-safe: stub DOM/GL exactly like gpu-play.test.ts; real-pak legs
// are Q2_PAK-gated. Composed-browser pixels are FOLLOW-2C, not this file.
import { describe, expect, it, afterEach, vi } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { keyDown, keyUp } from '@q2/input';
import { SoftwareRenderer } from '@q2/sw-renderer';
import {
  applyRendererCvar,
  bootPlay,
  frameGpuPlay,
  registerPakModels,
  replayPakAssetsToGpu,
} from './play.js';
import type { GpuAssetSink, PakModelHandles } from './play.js';
import type { WebPak } from './pak.js';
import { GPU_CANVAS_ID } from './gpu-canvas.js';

const WEB_Q2_PAK = process.env.Q2_PAK;

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g['document'];
});

// --- stub DOM/GL (same recording shape as gpu-play.test.ts) -----------------

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

interface StubCanvas {
  id: string;
  width: number;
  height: number;
  style: Record<string, string>;
  setAttribute(k: string, v: string): void;
  getContext(kind: string, attrs?: unknown): unknown;
}

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

function installStubDoc(): StubDoc {
  const g = globalThis as unknown as Record<string, unknown>;
  const log: string[] = [];
  const gl = makeStubGL(log);
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

async function loadRealPak(): Promise<{ ingestPak: (buf: ArrayBuffer) => WebPak }> {
  return (await import('./pak.js')) as unknown as {
    ingestPak: (buf: ArrayBuffer) => WebPak;
  };
}

async function readRealPak(): Promise<WebPak> {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await loadRealPak();
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
  // No mesh-less warnings: required MD2s converted (fallback devmesh counts —
  // those are explicit registration warnings, never silent mesh-less draws).
  const meshless = gpu!.testWarnings().filter((w) => /no mesh|mesh-less/i.test(w));
  expect(meshless).toEqual([]);
}

/** Snapshot of gameplay state that must survive a renderer switch untouched. */
function snapshotGameplay(boot: ReturnType<typeof bootPlay>): string {
  const d = boot.driver;
  return JSON.stringify({
    origin: [...d.pm.origin],
    angles: [...d.pm.viewAngles],
    health: d.ps.health,
    shells: d.shells,
    bullets: d.bullets,
    grenades: d.grenades,
    cells: d.cells,
    rockets: d.rockets,
    slugs: d.slugs,
    weapon: d.weapon.classname,
    monsters: d.server.monsters.map((x) => [x.edict.num, x.state.health, [...x.edict.origin]]),
    barrels: d.server.barrels.map((b) => [[...b.edict.origin], b.edict.freed]),
    time: d.server.time,
    models: d.models,
  });
}

describe('GPU-FOLLOW-2A hermetic asset cache (no pak)', () => {
  it('empty pak: every lump falls back loudly with path/handle, handles stay stable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const refresh = new SoftwareRenderer();
      const emptyPak = { entries: [], data: new ArrayBuffer(0) };
      const models = registerPakModels(refresh, emptyPak, null);
      // Handle contract holds even on total fallback: soldier skin 0 + model 0.
      expect(models.monster).toBe(0);
      expect(models.monsterSkin).toBe(0);
      // Every fallback warned with its lump path (never silent)…
      const warned = warn.mock.calls.map((c) => String(c[0]));
      expect(warned.some((m) => m.includes('models/objects/barrels/tris.md2'))).toBe(true);
      expect(warned.some((m) => m.includes('models/monsters/infantry'))).toBe(true);
      // …and the retained cache marks every entry as fallback under its handle.
      expect(models.assets.models.length).toBeGreaterThan(0);
      expect(models.assets.models.every((e) => e.fallback)).toBe(true);
      expect(models.assets.skins.length).toBeGreaterThan(0);
      expect(models.assets.skins.every((e) => e.fallback && e.pixels === null)).toBe(true);
      const warnHandles = warned.filter((m) => /\(model \d+\)|\(skin \d+\)/.test(m));
      expect(warnHandles.length).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('replay skips checker skins, mirrors fallback meshes, and surfaces sink errors with path/handle', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const refresh = new SoftwareRenderer();
      const emptyPak = { entries: [], data: new ArrayBuffer(0) };
      const models = registerPakModels(refresh, emptyPak, null);
      // A sink that throws for exactly one model handle.
      const victim = models.assets.models[0]!;
      const seen: { models: number[]; skins: number[] } = { models: [], skins: [] };
      const sink: GpuAssetSink = {
        registerModelData(handle: number, kind: 'md2' | 'sp2' | 'tracer', data: unknown): void {
          void kind;
          void data;
          if (handle === victim.handle) throw new Error('boom-upload');
          seen.models.push(handle);
        },
        registerSkinPixels(handle: number, pixels: Uint8Array, width: number, height: number): number {
          void pixels;
          void width;
          void height;
          seen.skins.push(handle);
          return handle;
        },
      };
      const replayed = replayPakAssetsToGpu(models, sink);
      // One bad lump cannot block the rest; checker skins carry no texels.
      expect(replayed.models).toBe(models.assets.models.length - 1);
      expect(replayed.skins).toBe(0);
      expect(seen.skins).toEqual([]);
      expect(seen.models).not.toContain(victim.handle);
      // The failure surfaces with asset path + handle context (never silent).
      const warned = warn.mock.calls.map((c) => String(c[0]));
      const ctx = warned.find((m) => m.includes(victim.path) && m.includes(`(model ${victim.handle})`));
      expect(ctx).toBeDefined();
      // Null handles/sink are safe no-ops (dispose paths, devroom boots).
      expect(replayPakAssetsToGpu(null, sink)).toEqual({ models: 0, skins: 0 });
      expect(replayPakAssetsToGpu(models, null)).toEqual({ models: 0, skins: 0 });
    } finally {
      warn.mockRestore();
    }
  });
});

describe.runIf(!!WEB_Q2_PAK)('GPU-FOLLOW-2A cold boot + hot-swap (Q2_PAK)', () => {
  it('cold GPU boot: registry complete, named regressions present, draws execute', { timeout: 180000 }, async () => {
    const stub = installStubDoc();
    const pak = await readRealPak();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      setCVar('vid_renderer', 'webgl2-experimental');
      const boot = bootPlay({ width: 96, height: 72, pak });
      expect(boot.renderer).toBe('webgl2-experimental');
      expect(boot.gpu).not.toBeNull();
      expect(boot.source).toBe('pak');
      // Handle contract: soldier first, no shifts.
      expect(boot.models!.monster).toBe(0);
      expect(boot.models!.monsterSkin).toBe(0);
      // Full registry resolves in the GPU backend with no mesh-less warnings.
      expectRegistryComplete(boot);
      // Named regressions: barrel + black-infantry handles carry real meshes.
      const gpu = boot.gpu!.gpu;
      expect(gpu.testModelKind(boot.models!.barrel)).toBe('md2');
      expect(gpu.testModelKind(boot.models!.infantry)).toBe('md2');
      expect(gpu.testModelKind(boot.models!.monster)).toBe('md2');
      // No fallback warnings on the real pak (required assets all present).
      const warned = warn.mock.calls.map((c) => String(c[0]));
      expect(warned.filter((m) => m.includes('registerPakModels'))).toEqual([]);
      // Real draw execution, stable uploads, combat advances.
      keyDown(boot.host.input, 'forward');
      keyDown(boot.host.input, 'attack');
      const N = 20;
      for (let f = 0; f < N; f++) frameGpuPlay(boot, f * 16);
      keyUp(boot.host.input, 'forward');
      keyUp(boot.host.input, 'attack');
      expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(N);
      expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
      expect(stub.log).toContain('drawElements');
      expect(stub.log).toContain('bufferData');
      expect(stub.log).not.toContain('readPixels');
      expect(boot.driver.events).toContain('shot');
      // Live enemies + barrels exist behind those handles (missing-enemy
      // path is asset migration, not absent game state).
      expect(boot.driver.server.monsters.length).toBeGreaterThan(0);
      expect(boot.driver.server.barrels.length).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('software→GPU hot-swap: same completeness without reboot, gameplay preserved', { timeout: 180000 }, async () => {
    installStubDoc();
    const pak = await readRealPak();
    setCVar('vid_renderer', 'software');
    const boot = bootPlay({ width: 96, height: 72, pak });
    expect(boot.renderer).toBe('software');
    expect(boot.gpu).toBeNull();
    // Play a while on software: movement + combat + state.
    keyDown(boot.host.input, 'forward');
    keyDown(boot.host.input, 'attack');
    for (let f = 0; f < 30; f++) boot.host.frame(f * 16);
    keyUp(boot.host.input, 'forward');
    keyUp(boot.host.input, 'attack');
    const before = snapshotGameplay(boot);
    const cpuModels = boot.models;
    const registerSpy = vi.spyOn(boot.refresh, 'registerModel');
    const skinSpy = 'registerSkinData' in boot.refresh
      ? vi.spyOn(boot.refresh as unknown as Record<string, unknown>, 'registerSkinData' as never)
      : null;
    try {
      // Hot-swap mid-session: no reboot, no CPU re-registration.
      setCVar('vid_renderer', 'webgl2-experimental');
      expect(applyRendererCvar(boot)).toBe('webgl2-experimental');
      expect(boot.gpu).not.toBeNull();
      expect(registerSpy).not.toHaveBeenCalled();
      if (skinSpy) expect(skinSpy).not.toHaveBeenCalled();
      // Same handles object, same numeric handles (no drift).
      expect(boot.models).toBe(cpuModels);
      expect(boot.models!.monster).toBe(0);
      expect(boot.models!.monsterSkin).toBe(0);
      // Gameplay state untouched by the switch itself.
      expect(snapshotGameplay(boot)).toBe(before);
      // Same completeness as a cold boot, then live frames keep working.
      expectRegistryComplete(boot);
      keyDown(boot.host.input, 'attack');
      const N = 20;
      const submittedBefore = boot.gpu!.gpu.getStatus().framesSubmitted;
      for (let f = 0; f < N; f++) frameGpuPlay(boot, 1000 + f * 16);
      keyUp(boot.host.input, 'attack');
      expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(submittedBefore + N);
      expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
      expect(boot.host.serverTime).toBeGreaterThan(0);
    } finally {
      registerSpy.mockRestore();
      if (skinSpy) (skinSpy as unknown as { mockRestore(): void }).mockRestore();
    }
  });

  it('voodoo→GPU + repeated switches incl. GPU→CPU→GPU keep working', { timeout: 180000 }, async () => {
    installStubDoc();
    const pak = await readRealPak();
    setCVar('vid_renderer', 'voodoo');
    const boot = bootPlay({ width: 96, height: 72, pak });
    expect(boot.renderer).toBe('voodoo');
    for (let f = 0; f < 10; f++) boot.host.frame(f * 16);
    const before = snapshotGameplay(boot);
    // voodoo→GPU: full migration without reboot.
    setCVar('vid_renderer', 'webgl2-experimental');
    expect(applyRendererCvar(boot)).toBe('webgl2-experimental');
    expect(boot.gpu).not.toBeNull();
    expect(snapshotGameplay(boot)).toBe(before);
    expectRegistryComplete(boot);
    for (let f = 0; f < 10; f++) frameGpuPlay(boot, f * 16);
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(10);
    // GPU→CPU: backend disposed, CPU path intact.
    const oldGpu = boot.gpu!.gpu;
    setCVar('vid_renderer', 'software');
    expect(applyRendererCvar(boot)).toBe('software');
    expect(boot.gpu).toBeNull();
    expect(oldGpu.getStatus().initialized).toBe(false);
    const stats = boot.host.frame(100);
    expect(stats.pixels).toBeGreaterThan(0);
    // CPU→GPU again: re-attach + replay without reboot, state preserved.
    const beforeSecond = snapshotGameplay(boot);
    setCVar('vid_renderer', 'webgl2-experimental');
    expect(applyRendererCvar(boot)).toBe('webgl2-experimental');
    expect(boot.gpu).not.toBeNull();
    expect(snapshotGameplay(boot)).toBe(beforeSecond);
    expectRegistryComplete(boot);
    for (let f = 0; f < 10; f++) frameGpuPlay(boot, 2000 + f * 16);
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(10);
    expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
    expect(boot.models!.monster).toBe(0);
  });
});
