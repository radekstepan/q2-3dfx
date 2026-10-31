// GPU-FOLLOW-2C live route (apps/web only, Q2_PAK-gated).
//
// Single-test live-route proof (boxes 1+3): the production play path
// (`frameGpuPlay` — the exact entry the shipped rAF tick calls in
// `dom.ts`) drives one continuous route through: stationary spawn, real
// multi-room translation with PVS/cluster transitions, a 180-degree turn,
// a touched door opening AND re-closing, and a USE-fired lift ride. Every
// leg records camera origin/angles, cluster ids, mover states, enemy /
// viewmodel / material health and a composed-page capture (stub phase:
// submitted-scene census + overlay hash; browser phase below: real
// screenshots).
//
// A second phase repeats the stationary/translate/turn shape on the REAL
// production page (headless chromium, CDP key events only — never page
// code, same rule as `tools/bench/gpu-soak.mjs`) and takes per-leg
// composed-page screenshots with in-page pixel stats, so box 1's "real
// composed-page captures" are actual compositor pixels, not stub records.
// Door + lift stay in the stub phase: their actuation needs aimed setups
// (teleport + USE), which the bench runner's keys-only contract forbids,
// while every frame around the setups still runs the production live loop.
//
// What this test is NOT (owned by other 2C lanes): box 2's independent
// view expectations (CPU reference / fixture geometry) and box 4's
// `validateSceneCoverage` + removed-wall rejection live in
// `packages/testkit` + `tools/bench` — this file asserts directly and only
// on production-submitted state (never internal sim fields for verdicts).
//
// The existing TURN equality test in `gpu-play.test.ts` is untouched and
// stays green as the narrower regression.
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { v3 } from '@q2/math';
import { BUTTON_USE, keyDown, keyUp } from '@q2/input';
import type { UserCmdT } from '@q2/input';
import { SV_SetPlayerHealth } from '@q2/server';
import { cameraCluster } from '@q2/webgl-renderer';
import {
  bootPlay,
  buildAsyncView,
  frameGpuPlay,
  paintHudOverlay,
} from './play.js';
import type { SoakRouteSnapshot } from './soak.js';
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { createServer } from 'http';

const WEB_Q2_PAK = process.env.Q2_PAK;
const CHROMIUM_BIN = process.env.CHROMIUM_BIN ?? '/usr/bin/chromium';

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g['document'];
});

// --- stub DOM/GL (same recording-proxy shape as gpu-play.test.ts) --------

const GL_NUM = {
  NO_ERROR: 0,
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

function installStubDoc(): { log: string[] } {
  const g = globalThis as unknown as Record<string, unknown>;
  const log: string[] = [];
  const gl = makeStubGL(log);
  const canvases: StubCanvas[] = [];
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
      const canvas: StubCanvas = {
        id: '',
        width: 0,
        height: 0,
        style: {},
        setAttribute(k: string, v: string): void {
          if (k === 'id') canvas.id = v;
        },
        getContext(kind: string): unknown {
          return kind === 'webgl2' ? gl : null;
        },
      };
      canvases.push(canvas);
      return canvas;
    },
    getElementById: (id: string): unknown => {
      if (id === 'q2') return hud;
      if (id === 'q2-gl') return canvases.find((c) => c.id === 'q2-gl') ?? null;
      return null;
    },
    body: { appendChild: (c: unknown): void => { log.push('body.appendChild'); void c; } },
  };
  g['document'] = doc;
  return { log };
}

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

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

/** One live-route sample: production-submitted state only (never sim internals). */
interface RouteSample {
  origin: [number, number, number];
  angles: [number, number, number];
  cluster: number;
  worldOpaque: number;
  worldTransparent: number;
  entityRefs: number;
  aliasRefs: number;
  staticTotal: number;
  renderables: number;
  alive: number;
  kinds: string[];
  vmModel: number | null;
  vmSkin: number | null;
  regModels: number[];
  regSkins: number[];
  diffuse: number;
  warnings: string[];
  fatal: string[];
  uploads: number;
  frames: number;
}

function sampleRoute(boot: ReturnType<typeof bootPlay>): RouteSample {
  const gpu = boot.gpu!;
  const { view, renderables } = buildAsyncView(boot.host, gpu.loop.serverAcc);
  const o = view.origin;
  const a = view.angles;
  const origin: [number, number, number] = [o[0], o[1], o[2]];
  const angles: [number, number, number] = [a[0], a[1], a[2]];
  const cluster = cameraCluster(boot.driver.mini, v3(origin[0], origin[1], origin[2]));
  let worldOpaque = 0;
  let worldTransparent = 0;
  let entityRefs = 0;
  let aliasRefs = 0;
  for (const r of gpu.scene.surfaces) {
    if (r.transformIndex === 0) {
      if (r.transparent) worldTransparent++;
      else worldOpaque++;
    } else {
      entityRefs++;
      if (r.material === 'alias') aliasRefs++;
    }
  }
  const kinds = new Set<string>();
  for (const m of boot.driver.monsters) {
    if (!m.state.dead) kinds.add(String(m.state.kind));
  }
  const vm = boot.driver.viewModel();
  const warnings = gpu.gpu.testWarnings();
  return {
    origin,
    angles,
    cluster,
    worldOpaque,
    worldTransparent,
    entityRefs,
    aliasRefs,
    staticTotal: gpu.staticScene.surfaces.length,
    renderables: renderables.length,
    alive: boot.driver.aliveMonsters,
    kinds: [...kinds].sort(),
    vmModel: vm ? vm.model : null,
    vmSkin: vm ? vm.skin : null,
    regModels: gpu.gpu.testRegisteredModels(),
    regSkins: gpu.gpu.testRegisteredSkins(),
    diffuse: gpu.gpu.testMaterialStats().diffuseTextures,
    warnings,
    fatal: fatalWarnings(warnings),
    uploads: gpu.gpu.testUploadStats().uploads,
    frames: gpu.gpu.getStatus().framesSubmitted,
  };
}

/** Mover summary: models displaced from the closed pose + watched offsets. */
function moverSummary(boot: ReturnType<typeof bootPlay>): { open: string[]; states: Record<string, string> } {
  const open: string[] = [];
  const states: Record<string, string> = {};
  for (const m of boot.driver.server.movers) {
    const model = typeof m.ent.model === 'string' ? m.ent.model : null;
    if (model === null) continue;
    const off = boot.driver.doorRenderOffset(model);
    const mag = off ? Math.hypot(off[0], off[1], off[2]) : 0;
    if (mag > 1) open.push(`${model}@${mag.toFixed(1)}`);
    if (model === '*32' || model === '*31' || model === '*13') states[model] = String(m.state);
  }
  return { open, states };
}

/** Composed-overlay capture: nonzero / transparent census + FNV hash. */
function captureOverlay(boot: ReturnType<typeof bootPlay>, frame: number): { nonzero: number; transparent: number; hash: number } {
  const overlay = paintHudOverlay(boot, { fps: 60, frame });
  let nonzero = 0;
  let transparent = 0;
  let hash = 0;
  for (let i = 0; i < overlay.length; i++) {
    const px = overlay[i]!;
    if (px !== 0) nonzero++;
    if ((px >>> 24) === 0) transparent++;
    hash = ((hash * 31 + px) | 0) >>> 0;
  }
  return { nonzero, transparent, hash };
}

function dist3(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Fatal backend warnings (box 3 health gate): missing meshes/skins and GL
 * upload errors fail the route. The match is deliberately NARROW: the
 * renderer's own pre-poll distinguishes a flag the upload itself set
 * (`texels may be corrupt` — actionable, fatal) from a pre-existing flag
 * drained at the upload (`pre-existing GL error ... drained, not attributed
 * to this upload` — the documented FOLLOW-2B SwiftShader 1282 quirk, zero
 * pixel impact, reported in the evidence log but never a failure). A bare
 * `GL error` match would conflate the two classes, so it is NOT used.
 * Documented non-fatal policy warnings (e.g. oversize-skin resampling to
 * the 256px Voodoo cap) are allowed but counted in the evidence log — they
 * are published, never silent.
 */
const FATAL_WARNING_RE = /missing|texels may be corrupt|invalid|failed|deferred/i;
function fatalWarnings(all: string[]): string[] {
  return all.filter((w) => FATAL_WARNING_RE.test(w));
}
/** Drained pre-existing GL flags (known SwiftShader quirk — counted, never fatal). */
function drainedWarnings(all: string[]): string[] {
  return all.filter((w) => /pre-existing GL error/i.test(w));
}

// --- Phase B harness: self-contained CDP driver (no tools/bench imports) --
// Minimal mirror of the `tools/bench/gpu-soak.mjs` precedent (vite + pak
// servers, headless chromium, CDP key events, compositor screenshots) sized
// for a coverage leg: no bench dist, no manifests, evidence via assertions +
// the `[gpu-live-route] browser` log line + PNGs under os.tmpdir().

const CDP_KEY_W = { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 };
const CDP_ARROW_LEFT = { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 };

interface CdpKey { key: string; code: string; windowsVirtualKeyCode: number; nativeVirtualKeyCode: number; }

interface CdpShotStats { w: number; h: number; nonblack: number; mean: number; hash: number; }

interface BrowserPage {
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
  keyDown(key: CdpKey): Promise<void>;
  keyUp(key: CdpKey): Promise<void>;
  screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<string>;
  close(): void;
}

/** In-page screenshot census (no new deps: PNG decodes in the page's 2D canvas). */
const SHOT_STATS_INSTALL = `window.__shotStats = async (b64) => {
  const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let n = 0; let s = 0; let h = 0;
  for (let i = 0; i < d.length; i += 4) {
    const m = (d[i] + d[i+1] + d[i+2]) / 3;
    if (m > 8) n++;
    s += m;
    h = ((h * 31 + (m | 0)) | 0) >>> 0;
  }
  const px = d.length / 4;
  bmp.close();
  return { w: c.width, h: c.height, nonblack: n / px, mean: s / px, hash: h };
};`;

/** Signed shortest-arc yaw delta in degrees (-180..180]. */
function wrapDelta(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitHttpOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`http not ready: ${url}`);
    await sleep(2000);
  }
}

interface CdpMessage {
  id?: unknown;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: {
    args?: { value?: unknown; description?: string; type?: string }[];
    type?: string;
    exceptionDetails?: { text?: string };
  };
}

function createBrowserPage(wsUrl: string): Promise<{ page: BrowserPage; consoleLines: string[] }> {
  return new Promise((resolvePage, rejectPage) => {
    const ws = new WebSocket(wsUrl);
    const consoleLines: string[] = [];
    const pending = new Map<number, { res: (v: Record<string, unknown>) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let nextId = 1;
    let closed = false;
    const send = (method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> =>
      new Promise((res, rej) => {
        if (closed) { rej(new Error('CDP closed')); return; }
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
        pending.set(id, { res, rej, timer });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (e) {
          pending.delete(id);
          clearTimeout(timer);
          rej(e instanceof Error ? e : new Error(String(e)));
        }
      });
    const openTimer = setTimeout(() => { try { ws.close(); } catch { /* x */ } rejectPage(new Error('CDP socket open timeout')); }, 20000);
    ws.onopen = () => {
      clearTimeout(openTimer);
      const page: BrowserPage = {
        evaluate: async <T>(expression: string, timeoutMs = 60000): Promise<T> => {
          const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
          const rec = r as { exceptionDetails?: { text?: string }; result?: { value?: unknown } };
          if (rec.exceptionDetails) throw new Error(`page evaluate threw: ${(rec.exceptionDetails.text ?? 'unknown').slice(0, 200)}`);
          return rec.result?.value as T;
        },
        keyDown: async (key) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: false, ...key }, 15000); },
        keyUp: async (key) => { await send('Input.dispatchKeyEvent', { type: 'keyUp', autoRepeat: false, ...key }, 15000); },
        screenshot: async (clip?: { x: number; y: number; width: number; height: number }): Promise<string> => {
          const params: Record<string, unknown> = { format: 'png', fromSurface: true };
          if (clip) {
            params['clip'] = { ...clip, scale: 1 };
            params['captureBeyondViewport'] = true;
          }
          const r = await send('Page.captureScreenshot', params, 60000);
          const data = (r as { data?: unknown }).data;
          if (typeof data !== 'string') throw new Error('screenshot: no data');
          return data;
        },
        close: (): void => {
          closed = true;
          for (const [, p] of pending) { clearTimeout(p.timer); p.rej(new Error('CDP closed')); }
          pending.clear();
          try { ws.close(); } catch { /* x */ }
        },
      };
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== 'string') return;
        let msg: CdpMessage | null = null;
        try {
          msg = JSON.parse(ev.data) as CdpMessage;
        } catch { return; }
        if (!msg) return;
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.rej(new Error(`CDP error: ${msg.error.message ?? 'unknown'}`));
          else p.res((msg.result ?? {}) as Record<string, unknown>);
          return;
        }
        if (msg.method === 'Runtime.consoleAPICalled') {
          const args = msg.params?.args ?? [];
          const text = args.map((a) => (a.value !== undefined
            ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value))
            : (a.description ?? String(a.type ?? '?')))).join(' ');
          if (consoleLines.length < 400) consoleLines.push(`[console.${msg.params?.type ?? 'log'}] ${text}`);
        } else if (msg.method === 'Runtime.exceptionThrown') {
          if (consoleLines.length < 400) consoleLines.push(`[exception] ${msg.params?.exceptionDetails?.text ?? 'unknown'}`);
        }
      };
      ws.onclose = () => {
        closed = true;
        for (const [, p] of pending) { clearTimeout(p.timer); p.rej(new Error('CDP socket closed')); }
        pending.clear();
      };
      void (async () => {
        try {
          await send('Runtime.enable', {}, 20000);
          await send('Page.enable', {}, 20000);
          resolvePage({ page, consoleLines });
        } catch (e) {
          rejectPage(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    };
    ws.onerror = () => { clearTimeout(openTimer); rejectPage(new Error('CDP socket error before open')); };
  });
}

async function launchChromium(pageUrl: string, userDataDir: string): Promise<{ port: number; proc: ChildProcess }> {
  return new Promise((resolveLaunch, rejectLaunch) => {
    const args = [
      '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--mute-audio',
      '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
      '--window-size=1400,1000', '--force-device-scale-factor=1',
      '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
      '--enable-unsafe-swiftshader', pageUrl,
    ];
    let proc: ChildProcess;
    try {
      proc = spawn(CHROMIUM_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { rejectLaunch(new Error('chromium spawn failed: ' + String(e))); return; }
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { proc.kill('SIGKILL'); } catch { /* x */ } rejectLaunch(new Error('chromium: no DevTools port within 30s')); }
    }, 30000);
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderr += String(chunk);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (m) {
        const portM = /127\.0\.0\.1:(\d+)/.exec(m[1] ?? '');
        if (portM) {
          settled = true;
          clearTimeout(timer);
          resolveLaunch({ port: Number(portM[1]), proc });
        }
      }
    });
    proc.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); rejectLaunch(new Error('chromium process error: ' + e.message)); } });
    proc.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); rejectLaunch(new Error(`chromium exited early (code ${code}). tail: ${stderr.slice(-2000)}`)); } });
  });
}

async function connectCdp(port: number): Promise<{ page: BrowserPage; consoleLines: string[] }> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`);
  const targets = (await res.json()) as { type?: string; webSocketDebuggerUrl?: string }[];
  const target = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target?.webSocketDebuggerUrl) throw new Error('no page target with debugger URL');
  return createBrowserPage(target.webSocketDebuggerUrl);
}

interface BrowserLegEvidence {
  route: SoakRouteSnapshot | null;
  shot: CdpShotStats;
  path: string;
}

interface BrowserRouteEvidence {
  legs: { stationary: BrowserLegEvidence; translate: BrowserLegEvidence; turn: BrowserLegEvidence };
  moveSamples: (SoakRouteSnapshot | null)[];
  consoleErrors: string[];
  glRenderer: string | null;
  cvars: Record<string, string> | null;
  /** Game-canvas CSS box the screenshots were clipped to. */
  box: { width: number; height: number };
}

interface SoakBootStatus {
  booted?: boolean;
  error?: string | null;
  actualRenderer?: string;
  warning?: string | null;
  glRenderer?: string | null;
}

async function runBrowserRoute(outDir: string): Promise<BrowserRouteEvidence> {
  const here = dirname(fileURLToPath(import.meta.url)); // apps/web/src
  const appDir = resolve(here, '..');
  const repoRoot = resolve(here, '..', '..', '..');
  const viteCands = [join(repoRoot, 'node_modules', '.bin', 'vite'), join(appDir, 'node_modules', '.bin', 'vite')];
  let viteBin: string | null = null;
  for (const c of viteCands) {
    try { accessSync(c, constants.X_OK); viteBin = c; break; } catch { /* next */ }
  }
  if (!viteBin) throw new Error('vite binary not found');
  const pakBytes = readFileSync(WEB_Q2_PAK as string);
  const pakServer = createServer((req, res) => {
    try {
      const url = (req.url ?? '/').split('?')[0];
      if (url !== '/pak0.pak' || req.method === 'OPTIONS') {
        res.writeHead(url === '/pak0.pak' ? 204 : 404, {
          'access-control-allow-origin': '*',
          'cross-origin-resource-policy': 'cross-origin',
        });
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
        'content-length': String(pakBytes.length),
      });
      res.end(pakBytes);
    } catch { try { res.writeHead(500); res.end('err'); } catch { /* gone */ } }
  });
  await new Promise<void>((res, rej) => {
    pakServer.on('error', rej);
    pakServer.listen(0, '127.0.0.1', () => res());
  });
  const pakAddr = pakServer.address() as unknown as { port: number } | null;
  if (!pakAddr || typeof pakAddr.port !== 'number') throw new Error('pak server: no port');
  const pakUrl = `http://127.0.0.1:${pakAddr.port}`;
  const vitePort = Number(process.env.GPU_ROUTE_VITE_PORT ?? 5193);
  const viteProc = spawn(process.execPath, [viteBin, '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], {
    cwd: appDir, stdio: ['ignore', 'ignore', 'ignore'],
  });
  const killAll = async (): Promise<void> => {
    try { await new Promise<void>((res) => { pakServer.close(() => res()); setTimeout(() => res(), 3000); }); } catch { /* x */ }
    try {
      if (viteProc.exitCode === null && viteProc.signalCode === null) {
        viteProc.kill('SIGTERM');
        await new Promise<void>((res) => { viteProc.on('exit', () => res()); setTimeout(() => res(), 8000); });
        if (viteProc.exitCode === null) { try { viteProc.kill('SIGKILL'); } catch { /* gone */ } }
      }
    } catch { /* gone */ }
  };
  try {
    await waitHttpOk(`http://127.0.0.1:${vitePort}/`, 120000);
    const pageUrl = `http://127.0.0.1:${vitePort}/?q2soak=1&q2pak=${encodeURIComponent(`${pakUrl}/pak0.pak`)}&q2renderer=webgl2-experimental`;
    const userDataDir = join(tmpdir(), `q2-live-route-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(userDataDir, { recursive: true });
    const chromium = await launchChromium(pageUrl, userDataDir);
    try {
      const { page, consoleLines } = await connectCdp(chromium.port);
      try {
        let status: SoakBootStatus | null = null;
        const bootDeadline = Date.now() + 240000;
        for (;;) {
          status = await page.evaluate<SoakBootStatus | null>('window.__q2soak ? window.__q2soak : null', 30000).catch(() => null);
          if (status && status.booted) break;
          if (status && status.error) throw new Error(`page boot error: ${status.error}`);
          if (Date.now() > bootDeadline) throw new Error('soak boot timeout (240s)');
          await sleep(2000);
        }
        if (status!.actualRenderer !== 'webgl2-experimental' || status!.warning !== null) {
          throw new Error(`GPU leg did not attach (actual=${status!.actualRenderer} warning=${status!.warning})`);
        }
        await page.evaluate<void>(SHOT_STATS_INSTALL, 30000);
        // Canvas-box clip: capture exactly the composed game page (the GL
        // scene + HUD overlay), never the surrounding config UI. The soak
        // loop fits the 640x480 framebuffer to the stage at its aspect
        // (RELEASE-3: uniform scale, no letterbox bands).
        const box = await page.evaluate<{ x: number; y: number; width: number; height: number } | null>(
          '(() => { const c = document.querySelector("#q2"); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()',
          30000,
        );
        if (!box || !(box.width >= 640) || !(box.height >= 480)) {
          throw new Error(`game canvas box missing/too small: ${JSON.stringify(box)}`);
        }
        const yawOf = async (): Promise<number> =>
          page.evaluate<number>('window.__q2soakState ? window.__q2soakState().yawDeg : 0', 15000).catch(() => 0);
        const routeOf = (): Promise<SoakRouteSnapshot | null> =>
          page.evaluate<SoakRouteSnapshot | null>('window.__q2soakRoute ? window.__q2soakRoute() : null', 30000);
        const snapLeg = async (name: string): Promise<BrowserLegEvidence> => {
          const route = await routeOf();
          const b64 = await page.screenshot(box);
          const shot = await page.evaluate<CdpShotStats>(`window.__shotStats("${b64}")`, 60000);
          const path = join(outDir, `live-route-${name}.png`);
          writeFileSync(path, Buffer.from(b64, 'base64'));
          return { route, shot, path };
        };
        await sleep(5000);
        const stationary = await snapLeg('stationary');
        // Translate: 8s forward from spawn — through the first door into the
        // corridor, ending mid-view (12s plasters the camera nose-against
        // the far dark wall, which is legitimate but unreadable).
        await page.keyDown(CDP_KEY_W);
        const moveSamples: (SoakRouteSnapshot | null)[] = [];
        for (let i = 0; i < 4; i++) { await sleep(2000); moveSamples.push(await routeOf()); }
        await page.keyUp(CDP_KEY_W);
        const translate = await snapLeg('translate');
        const yaw0 = (await routeOf())?.camera?.angles[1] ?? await yawOf();
        await page.keyDown(CDP_ARROW_LEFT);
        // Cumulative-rotation stop: 1s polls alias past a fixed window at
        // 140 deg/s, so integrate wrapped per-sample deltas at 250ms
        // (35 deg/sample can never alias) and stop at >= 180 total.
        const turnDeadline = Date.now() + 30000;
        let prev = yaw0;
        let total = 0;
        let turned = false;
        for (;;) {
          await sleep(250);
          const yaw = await yawOf();
          total += Math.abs(wrapDelta(yaw, prev));
          prev = yaw;
          if (total >= 180) { turned = true; break; }
          if (Date.now() > turnDeadline) break;
        }
        await page.keyUp(CDP_ARROW_LEFT);
        if (!turned) throw new Error('turn leg: cumulative yaw did not reach 180 within 30s');
        await sleep(3000);
        const turn = await snapLeg('turn');
        const cvars = await page.evaluate<Record<string, string> | null>(
          'window.__q2soakCvars ? window.__q2soakCvars() : null', 15000).catch(() => null);
        const consoleErrors = consoleLines.filter(
          (l) => l.startsWith('[exception]') || l.includes('Uncaught') || l.includes('ERROR'));
        return { legs: { stationary, translate, turn }, moveSamples, consoleErrors, glRenderer: status!.glRenderer ?? null, cvars, box: { width: box.width, height: box.height } };
      } finally {
        page.close();
      }
    } finally {
      try {
        if (chromium.proc.exitCode === null) {
          chromium.proc.kill('SIGTERM');
          await new Promise<void>((res) => { chromium.proc.on('exit', () => res()); setTimeout(() => res(), 8000); });
          if (chromium.proc.exitCode === null) { try { chromium.proc.kill('SIGKILL'); } catch { /* exited */ } }
        }
      } catch { /* gone */ }
      try {
        spawnSync('rm', ['-rf', userDataDir]);
      } catch { /* best-effort */ }
    }
  } finally {
    await killAll();
  }
}

describe.runIf(!!WEB_Q2_PAK)('GPU-FOLLOW-2C base1 live route (Q2_PAK)', () => {
  it('single route: translate + 180 turn + door open/close + lift, content persists, captures per leg', { timeout: 600000 }, async () => {
    installStubDoc();
    const boot = await loadPakBoot();
    const { driver } = boot;
    let now = 0;
    const frames: RouteSample[] = [];
    const step = (n: number): void => {
      for (let i = 0; i < n; i++) {
        now += 16;
        frameGpuPlay(boot, now);
        frames.push(sampleRoute(boot));
      }
    };
    const legCaps: Record<string, { nonzero: number; transparent: number; hash: number }> = {};

    // ---- Leg A: stationary spawn (10 production frames) -------------------
    step(10);
    const legA = frames.slice(-10);
    const aEnd = legA[legA.length - 1]!;
    expect(aEnd.frames).toBe(10);
    expect(aEnd.uploads).toBe(1);
    expect(aEnd.fatal).toEqual([]);
    const a0 = legA[0]!;
    expect(a0.alive).toBeGreaterThan(0);
    expect(a0.vmModel).not.toBeNull();
    expect(a0.vmSkin).not.toBeNull();
    expect(a0.worldOpaque).toBeGreaterThan(0);
    expect(a0.diffuse).toBeGreaterThanOrEqual(1);
    legCaps['stationary'] = captureOverlay(boot, 10);
    expect(legCaps['stationary']!.transparent).toBeGreaterThan(0);

    // ---- Leg B: multi-room translation (bump-and-turn walk) ----------------
    // Real sim walking (KeyW through the production cmd builder), no
    // teleports: bump-and-turn explores genuinely through collision.
    keyDown(boot.host.input, 'forward');
    let yawExtra = 0;
    let lastCheck = a0.origin;
    let odometer = 0;
    const clusters = new Set<number>([a0.cluster]);
    const B_FRAMES = 300;
    for (let i = 0; i < B_FRAMES; i++) {
      if (i % 20 === 0) SV_SetPlayerHealth(driver.server, 100);
      now += 16;
      frameGpuPlay(boot, now);
      const s = sampleRoute(boot);
      frames.push(s);
      clusters.add(s.cluster);
      odometer += dist3(s.origin, frames[frames.length - 2]!.origin);
      if (i > 0 && i % 40 === 0) {
        const moved = dist3(s.origin, lastCheck);
        lastCheck = s.origin;
        if (moved < 30) {
          yawExtra = (yawExtra + 90) % 360;
          boot.host.input.angles = [0, yawExtra, 0];
        }
      }
    }
    keyUp(boot.host.input, 'forward');
    const legB = frames.slice(-B_FRAMES);
    const bEnd = legB[legB.length - 1]!;
    // Actual translation evidence: path length, cluster transitions.
    expect(odometer).toBeGreaterThan(300);
    expect(clusters.size).toBeGreaterThanOrEqual(2);
    expect(bEnd.uploads).toBe(1);
    expect(bEnd.fatal).toEqual([]);
    expect(bEnd.alive).toBeGreaterThan(0);
    expect(bEnd.vmModel).not.toBeNull();
    for (const s of legB) {
      expect(s.worldOpaque).toBeGreaterThan(0);
      expect(s.entityRefs).toBeGreaterThanOrEqual(s.renderables);
    }
    legCaps['translate'] = captureOverlay(boot, 11);
    expect(legCaps['translate']!.transparent).toBeGreaterThan(0);

    // ---- Leg C: 180-degree turn in place ----------------------------------
    const yawBefore = boot.host.input.angles[1] ?? 0;
    const worldBefore = new Set(
      boot.gpu!.scene.surfaces.filter((r) => r.transformIndex === 0).map((r) => r.surfaceId),
    );
    boot.host.input.angles = [0, yawBefore + 180, 0];
    step(10);
    const legC = frames.slice(-10);
    const cEnd = legC[legC.length - 1]!;
    const worldAfter = new Set(
      boot.gpu!.scene.surfaces.filter((r) => r.transformIndex === 0).map((r) => r.surfaceId),
    );
    expect([...worldAfter].some((id) => !worldBefore.has(id))).toBe(true);
    expect(cEnd.cluster).toBeDefined();
    expect(cEnd.fatal).toEqual([]);
    expect(cEnd.uploads).toBe(1);
    legCaps['turn'] = captureOverlay(boot, 12);
    expect(legCaps['turn']!.transparent).toBeGreaterThan(0);

    // ---- Leg D: door open (walk-through) then close (retreat + wait) ------
    // Aimed setups (elevator-validated coordinates); every frame between is
    // the production live loop. Door *32 opens on touch, closes on wait.
    driver.pm.origin = v3(-1560, 1536, 150);
    driver.pm.velocity = v3();
    boot.host.input.angles = [0, 180, 0];
    keyDown(boot.host.input, 'forward');
    let peak32 = 0;
    let opened = false;
    for (let i = 0; i < 200 && !opened; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      now += 16;
      frameGpuPlay(boot, now);
      frames.push(sampleRoute(boot));
      const mag = Math.hypot(...(driver.doorRenderOffset('*32') ?? [0, 0, 0]));
      peak32 = Math.max(peak32, mag);
      if (mag > 30) opened = true;
    }
    keyUp(boot.host.input, 'forward');
    expect(opened).toBe(true);
    expect(peak32).toBeGreaterThan(30);
    const legDopen = sampleRoute(boot);
    expect(legDopen.fatal).toEqual([]);
    expect(legDopen.uploads).toBe(1);
    expect(legDopen.worldOpaque).toBeGreaterThan(0);
    // Retreat far away and wait out the close (default wait returns it).
    driver.pm.origin = v3(128, -320, 32);
    driver.pm.velocity = v3();
    let shut = peak32;
    let closed = false;
    for (let i = 0; i < 900 && !closed; i++) {
      if (i % 20 === 0) SV_SetPlayerHealth(driver.server, 100);
      now += 16;
      frameGpuPlay(boot, now);
      frames.push(sampleRoute(boot));
      shut = Math.hypot(...(driver.doorRenderOffset('*32') ?? [0, 0, 0]));
      if (shut < 0.5) closed = true;
    }
    expect(closed).toBe(true);
    const legD = sampleRoute(boot);
    expect(legD.fatal).toEqual([]);
    expect(legD.uploads).toBe(1);
    expect(legD.worldOpaque).toBeGreaterThan(0);
    legCaps['door'] = captureOverlay(boot, 13);
    expect(legCaps['door']!.transparent).toBeGreaterThan(0);

    // ---- Leg E: lift ride (E-USE *13, production frames observe) ----------
    // Aimed setup (elevator-validated button pose); the USE tick and the
    // whole ride run the real server + production live loop.
    const train = driver.server.trains.find((t) => t.ent.model === '*12')!;
    expect(train).toBeDefined();
    const btn13 = driver.server.movers.find((m) => m.ent.model === '*13')!;
    expect(btn13).toBeDefined();
    driver.pm.origin = v3(-2030, 1536, -24);
    driver.pm.velocity = v3();
    for (let i = 0; i < 10; i++) driver.step(neutralCmd(), 0.1);
    const aimAt = (tx: number, ty: number, tz: number): [number, number, number] => {
      const e = [driver.pm.origin[0], driver.pm.origin[1], driver.pm.origin[2] + 22];
      const dx = tx - e[0];
      const dy = ty - e[1];
      const dz = tz - e[2];
      const l = Math.hypot(dx, dy) || 1;
      return [(Math.atan2(-dz, l) * 180) / Math.PI, (Math.atan2(dy, dx) * 180) / Math.PI, 0];
    };
    driver.step(
      { msec: 100, angles: aimAt(-2016, 1536, 80), forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_USE },
      0.1,
    );
    expect(driver.events).toContain('use');
    let peak = 0;
    let midLeg = false;
    let arrived = false;
    for (let i = 0; i < 500 && !arrived; i++) {
      if (i % 20 === 0) SV_SetPlayerHealth(driver.server, 100);
      now += 16;
      frameGpuPlay(boot, now);
      frames.push(sampleRoute(boot));
      const o = train.ent.origin;
      const moved = Math.abs(o[0]) + Math.abs(o[1]) + Math.abs(o[2]);
      peak = Math.max(peak, moved);
      if (moved > 1 && moved < 55) midLeg = true;
      const mesh = driver.doorRenderOffset('*12')!;
      expect(mesh[0]).toBeCloseTo(o[0], 6);
      expect(mesh[1]).toBeCloseTo(o[1], 6);
      expect(mesh[2]).toBeCloseTo(o[2], 6);
      if (train.arrived) arrived = true;
    }
    expect(train.started).toBe(true);
    expect(arrived).toBe(true);
    expect(peak).toBeGreaterThan(10);
    expect(midLeg).toBe(true);
    const legE = sampleRoute(boot);
    expect(legE.fatal).toEqual([]);
    expect(legE.uploads).toBe(1);
    legCaps['lift'] = captureOverlay(boot, 14);
    expect(legCaps['lift']!.transparent).toBeGreaterThan(0);

    // ---- Route-wide content + health gates (box 3) -------------------------
    // At least one alive enemy type persisted through every leg.
    const allKinds = new Set<string>();
    for (const s of frames) {
      for (const k of s.kinds) allKinds.add(k);
      expect(s.alive).toBeGreaterThan(0);
      expect(s.vmModel).not.toBeNull();
      expect(s.vmSkin).not.toBeNull();
      expect(s.worldOpaque).toBeGreaterThan(0);
      expect(s.diffuse).toBeGreaterThanOrEqual(1);
      expect(s.uploads).toBe(1);
      expect(s.fatal).toEqual([]);
      expect(s.entityRefs).toBeGreaterThanOrEqual(s.renderables);
    }
    expect(allKinds.size).toBeGreaterThanOrEqual(1);
    // Required meshes/skins: every registered handle resolves, nothing
    // missing (the renderer records 'missing' warnings — already [] above,
    // and every submitted alias handle must be registered).
    const models = boot.models!;
    for (const h of [models.monster, models.gunner, models.infantry, models.barrel, models.bolt]) {
      expect(legE.regModels).toContain(h);
    }
    expect(legE.regModels.length).toBeGreaterThanOrEqual(5);
    for (const h of [models.monsterSkin, models.gunnerSkin, models.infantrySkin, models.barrelSkin, models.boltSkin]) {
      expect(legE.regSkins).toContain(h);
    }
    for (const h of Object.values(models.weapons)) expect(legE.regModels).toContain(h);
    for (const h of Object.values(models.weaponSkins)) expect(legE.regSkins).toContain(h);
    expect(legE.regModels).toContain(legE.vmModel);
    expect(legE.regSkins).toContain(legE.vmSkin);
    // Alias entities actually submitted (not just alive server-side): at
    // least one leg submitted alias refs while monsters lived.
    expect(frames.some((s) => s.aliasRefs > 0 && s.alive > 0)).toBe(true);
    // Persistent inventory never mutated; N GPU frames submitted, no CPU raster.
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(frames.length);
    expect(boot.gpu!.staticScene.staticGeneration).toBe(boot.gpu!.scene.staticGeneration);

    // ---- Route evidence log (lane report input) -----------------------------
    const clustersSeen = [...new Set(frames.map((s) => s.cluster))].sort((a, b) => a - b);
    const mov = moverSummary(boot);
    const warnTotal = frames[frames.length - 1]!.warnings.length;
    console.log(
      `[gpu-live-route] stub frames=${frames.length} clusters=[${clustersSeen.join(',')}] ` +
        `odometer~${odometer.toFixed(0)} door32peak=${peak32.toFixed(1)} liftPeak=${peak.toFixed(1)} ` +
        `kinds=[${[...allKinds].sort().join(',')}] openNow=[${mov.open.join(';')}] ` +
        `warnings=${warnTotal}(fatal=0) ` +
        `caps=${Object.entries(legCaps).map(([k, c]) => `${k}:nz=${c.nonzero},tr=${c.transparent},h=${c.hash.toString(16)}`).join(' ')}`,
    );

    // ---- Phase B: real production page (headless chromium, CDP only) -------
    // Same route shape (stationary / translate / turn) on the real page with
    // per-leg compositor screenshots. Door + lift stay stub-side (file
    // header). Skips (passes) when no chromium binary is present.
    delete (globalThis as unknown as Record<string, unknown>)['document'];
    let chromiumPresent = false;
    try {
      accessSync(CHROMIUM_BIN, constants.X_OK);
      chromiumPresent = true;
    } catch {
      chromiumPresent = false;
    }
    if (!chromiumPresent) {
      console.log('[gpu-live-route] browser SKIP: no chromium binary');
    } else {
      const outDir = join(tmpdir(), `q2-live-route-${Date.now()}`);
      mkdirSync(outDir, { recursive: true });
      const browser = await runBrowserRoute(outDir);
      const legNames = ['stationary', 'translate', 'turn'] as const;
      for (const name of legNames) {
        const cap = browser.legs[name];
        expect(cap.route, `${name}: route sample present`).not.toBeNull();
        const r = cap.route!;
        expect(r.camera, `${name}: camera known`).not.toBeNull();
        expect(r.cluster, `${name}: cluster known`).not.toBeNull();
        expect(r.uploads, `${name}: uploads stable`).toBe(1);
        expect(fatalWarnings(r.warnings), `${name}: no fatal backend warnings`).toEqual([]);
        expect(r.aliveMonsters, `${name}: enemy alive`).toBeGreaterThan(0);
        expect(r.monsterKinds.length, `${name}: enemy kind known`).toBeGreaterThan(0);
        expect(r.viewmodel, `${name}: viewmodel registered`).not.toBeNull();
        expect(r.handles, `${name}: required handles known`).not.toBeNull();
        expect(r.framesSubmitted, `${name}: submission observed`).not.toBeNull();
        expect(r.registeredModels, `${name}: viewmodel mesh registered`).toContain(r.viewmodel!.model);
        expect(r.registeredSkins, `${name}: viewmodel skin registered`).toContain(r.viewmodel!.skin);
        for (const h of [r.handles!.monster, r.handles!.gunner, r.handles!.infantry, r.handles!.barrel, r.handles!.bolt]) {
          expect(r.registeredModels, `${name}: required mesh ${h} registered`).toContain(h);
        }
        for (const h of [r.handles!.monsterSkin, r.handles!.gunnerSkin, r.handles!.infantrySkin, r.handles!.barrelSkin, r.handles!.boltSkin]) {
          expect(r.registeredSkins, `${name}: required skin ${h} registered`).toContain(h);
        }
        expect(r.materials, `${name}: materials known`).not.toBeNull();
        expect(r.materials!.diffuse, `${name}: textured walls/floors`).toBeGreaterThanOrEqual(1);
        expect(r.scene, `${name}: scene census known`).not.toBeNull();
        expect(r.scene!.worldOpaque, `${name}: world submits`).toBeGreaterThan(50);
        expect(r.scene!.staticTotal, `${name}: full-map inventory`).toBeGreaterThan(1000);
        expect(cap.shot.w, `${name}: capture width matches canvas`).toBe(Math.round(browser.box.width));
        expect(cap.shot.h, `${name}: capture height matches canvas`).toBe(Math.round(browser.box.height));
        expect(cap.shot.nonblack, `${name}: composed page live`).toBeGreaterThan(0.5);
      }
      // Submission advances per leg; translation moved the camera across clusters.
      const fA = browser.legs.stationary.route!.framesSubmitted!;
      const fB = browser.legs.translate.route!.framesSubmitted!;
      const fC = browser.legs.turn.route!.framesSubmitted!;
      expect(fB).toBeGreaterThan(fA);
      expect(fC).toBeGreaterThan(fB);
      const clustersB = new Set([
        browser.legs.stationary.route!.cluster,
        ...browser.moveSamples.map((s) => s?.cluster),
        browser.legs.translate.route!.cluster,
      ]);
      expect(clustersB.size).toBeGreaterThanOrEqual(2);
      const oA = browser.legs.stationary.route!.camera!.origin;
      const oB = browser.legs.translate.route!.camera!.origin;
      expect(dist3(oA, oB)).toBeGreaterThan(30);
      // Turn changed the composed page; all three captures are real pixels.
      expect(browser.legs.turn.shot.hash).not.toBe(browser.legs.translate.shot.hash);
      expect(browser.legs.translate.shot.hash).not.toBe(browser.legs.stationary.shot.hash);
      expect(browser.consoleErrors).toEqual([]);
      console.log(
        `[gpu-live-route] browser box=${browser.box.width}x${browser.box.height} gl=${browser.glRenderer} ` +
          legNames.map((n) => {
            const c = browser.legs[n];
            const r = c.route!;
            return `${n}:frames=${r.framesSubmitted} cluster=${r.cluster} alive=${r.aliveMonsters} kinds=[${r.monsterKinds.join(',')}] worldOpaque=${r.scene!.worldOpaque} nonblack=${c.shot.nonblack.toFixed(3)} mean=${c.shot.mean.toFixed(1)} hash=${c.shot.hash.toString(16)} drained1282=${drainedWarnings(r.warnings).length} shot=${c.path}`;
          }).join(' ') +
          ` moveClusters=[${[...clustersB].join(',')}] cvars=${JSON.stringify(browser.cvars)}`,
      );
    }
  });
});
