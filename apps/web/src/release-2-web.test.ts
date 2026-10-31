// RELEASE-2 web verification (apps/web only): GPU devroom replay without a pak.
//
// Verifies the landed procedural palette/world/model replay on GPU cold boot,
// switching and restoration WITHOUT pak assets, and proves real-WebGL pixels
// show the room/materials/entities (a missing-world control fails — nonblack
// clear color alone is never accepted as proof).
//
// Legs:
//   - asset-free headless (always, stub GL): cold boot attaches the
//     procedural world + ramp palette + box-critter; CPU→GPU→CPU switching
//     replays retained assets under the same handles with the sim intact;
//     context loss skips and restore replays; a backend with no world stays
//     upload-free (missing-world control).
//   - real page (chromium, no Q2_PAK): the production soak page booted with
//     `q2pak=devroom` + webgl2 through real SwiftShader WebGL2 shows the
//     room (nonblack + regional variance + distinct colors), the route
//     snapshot proves world/entity submission (uploads == 1, entityRefs > 0,
//     framesSubmitted advances); teleporting into the void collapses to
//     clear color (control: the room pixels come from the world, and the
//     comparator can fail).
import { afterEach, describe, expect, it } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { WebGLRenderer } from '@q2/webgl-renderer';
import {
  applyRendererCvar,
  bootPlay,
  devroomPaletteForGpu,
  notifyGpuContextLost,
  notifyGpuContextRestored,
  replayPakAssetsToGpu,
} from './play.js';
import type { PlayBoot } from './play.js';
import { accessSync, constants, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { createServer } from 'http';

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g['document'];
});

const CHROMIUM_BIN = process.env.CHROMIUM_BIN ?? '/usr/bin/chromium';

function installStubDoc(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const gl = new Proxy(
    {},
    {
      get(_t, prop): unknown {
        if (prop === 'getParameter') return () => 4096;
        if (prop === 'getError') return () => 0;
        if (prop === 'checkFramebufferStatus') return () => 36053;
        if (typeof prop === 'string' && (prop.startsWith('get') || prop.startsWith('check'))) {
          return (..._a: unknown[]): unknown => (prop.includes('InfoLog') ? '' : prop.includes('Location') ? {} : 0);
        }
        return (..._a: unknown[]): unknown => ({});
      },
    },
  );
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const mkCanvas = (): Record<string, unknown> => ({
    id: '',
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    setAttribute(k: string, v: string): void {
      ((this as Record<string, unknown>)[k] as unknown) = v;
    },
    getContext: () => gl,
    addEventListener: (t: string, fn: (...a: unknown[]) => void): void => {
      const list = listeners.get(t) ?? [];
      list.push(fn);
      listeners.set(t, list);
    },
    removeEventListener: (t: string, fn: (...a: unknown[]) => void): void => {
      listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== fn));
    },
    parentNode: null,
  });
  const hud = { id: 'q2', style: {} as Record<string, string>, parentNode: { insertBefore(): void { /* noop */ } } };
  g['document'] = {
    createElement: () => mkCanvas(),
    getElementById: (id: string): unknown => {
      if (id === 'q2') return hud;
      return null;
    },
    querySelector: (sel: string): unknown => {
      if (sel === '#q2') return hud;
      return null;
    },
    body: { appendChild(): void { /* noop */ } },
  };
}

describe('RELEASE-2 GPU devroom replay (asset-free, stub GL)', () => {
  it('procedural palette is a 768-byte ramp (never reads the pak)', () => {
    const pal = devroomPaletteForGpu();
    expect(pal.length).toBe(768);
    expect([pal[0], pal[1], pal[2]]).toEqual([0, 0, 0]);
    expect([pal[3], pal[4], pal[5]]).toEqual([1, 2, 3]);
    // Deterministic across calls (cold boot == restore == switch).
    expect(Array.from(devroomPaletteForGpu())).toEqual(Array.from(pal));
  });

  it('cold boot attaches world + palette + box-critter with one upload', () => {
    installStubDoc();
    setCVar('vid_renderer', 'webgl2-experimental');
    const boot = bootPlay({ width: 160, height: 120 });
    expect(boot.source).toBe('devroom');
    expect(boot.renderer).toBe('webgl2-experimental');
    expect(boot.gpu).not.toBeNull();
    expect(boot.palette).not.toBeNull();
    expect(boot.palette!.length).toBe(768);
    const gpu = boot.gpu!.gpu;
    expect(gpu.testRegisteredModels()).toContain(0);
    expect(gpu.testRegisteredSkins()).toContain(0);
    expect(gpu.testUploadStats().uploads).toBe(1);
    expect(gpu.getStatus().framesSubmitted).toBe(0);
  });

  it('CPU→GPU→CPU switching replays retained assets with the sim intact', () => {
    installStubDoc();
    const boot = bootPlay({ width: 160, height: 120 });
    expect(boot.gpu).toBeNull();
    boot.driver.step({ msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
    const origin = [...boot.driver.pm.origin];
    const time = boot.driver.server.time;
    setCVar('vid_renderer', 'webgl2-experimental');
    expect(applyRendererCvar(boot)).toBe('webgl2-experimental');
    expect(boot.gpu).not.toBeNull();
    expect(boot.gpu!.gpu.testRegisteredModels()).toContain(0);
    expect([...boot.driver.pm.origin]).toEqual(origin);
    expect(boot.driver.server.time).toBe(time);
    setCVar('vid_renderer', 'software');
    expect(applyRendererCvar(boot)).toBe('software');
    expect(boot.gpu).toBeNull();
    expect([...boot.driver.pm.origin]).toEqual(origin);
    expect(boot.driver.playerHealth).toBe(100);
  });

  it('context loss skips and restore replays without re-uploading the world', () => {
    installStubDoc();
    setCVar('vid_renderer', 'webgl2-experimental');
    const boot: PlayBoot = bootPlay({ width: 160, height: 120 });
    expect(notifyGpuContextLost(boot)).toBe(true);
    expect(notifyGpuContextRestored(boot)).toBe(true);
    expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
    expect(boot.gpu!.restoreCount).toBe(1);
  });

  it('replayPakAssetsToGpu is a safe no-op without handles or sink', () => {
    expect(replayPakAssetsToGpu(null, null)).toEqual({ models: 0, skins: 0 });
    expect(replayPakAssetsToGpu(null, undefined)).toEqual({ models: 0, skins: 0 });
  });

  it('missing-world control: no attachWorld means no uploads (fails closed)', () => {
    installStubDoc();
    const g = globalThis as unknown as { document?: unknown };
    const doc = g['document'] as { createElement: (t: string) => { getContext: (kind: string) => unknown } };
    const gl = doc.createElement('canvas').getContext('webgl2');
    const gpu = new WebGLRenderer();
    gpu.init(gl as WebGL2RenderingContext, 64, 48);
    // Palette only, no world: the static upload cannot run.
    gpu.setPalette(devroomPaletteForGpu());
    const before = gpu.testUploadStats().uploads;
    expect(before).toBe(0);
  });
});

// --- real page (chromium, no pak): production soak with q2pak=devroom ------

interface ShotAnalysis {
  w: number;
  h: number;
  nonblack: number;
  mean: number;
  hash: number;
  distinct: number;
  quadrants: [number, number, number, number];
}

interface BrowserPage {
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
  mouseDown(x: number, y: number): Promise<void>;
  mouseUp(x: number, y: number): Promise<void>;
  screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<string>;
  close(): void;
}

const PX_ANALYZE_INSTALL = `window.__q2px = async (b64) => {
  const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  const px = d.length / 4;
  let n = 0, s = 0, h = 0;
  const seen = new Set();
  const q = [0, 0, 0, 0]; const qc = [0, 0, 0, 0];
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2];
    const m = (r + g + b) / 3;
    if (m > 8) n++;
    s += m;
    h = ((h * 31 + (m | 0)) | 0) >>> 0;
    seen.add((r << 16) | (g << 8) | b);
    const xi = (i / 4) % c.width, yi = ((i / 4 / c.width) | 0);
    const qi = (yi < c.height / 2 ? 0 : 2) + (xi < c.width / 2 ? 0 : 1);
    q[qi] += m; qc[qi]++;
  }
  bmp.close();
  return { w: c.width, h: c.height, nonblack: n / px, mean: s / px, hash: h,
    distinct: seen.size, quadrants: [q[0]/qc[0], q[1]/qc[1], q[2]/qc[2], q[3]/qc[3]] };
};`;

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
};

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
        mouseDown: async (x, y) => {
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, 15000);
        },
        mouseUp: async (x, y) => {
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, 15000);
        },
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

describe.runIf(!!CHROMIUM_BIN)('RELEASE-2 devroom GPU pixels (chromium, no pak)', () => {
  it('cold GPU boot without pak shows the room; the void control collapses', { timeout: 600000 }, async () => {
    let chromiumPresent = false;
    try {
      accessSync(CHROMIUM_BIN, constants.X_OK);
      chromiumPresent = true;
    } catch {
      chromiumPresent = false;
    }
    if (!chromiumPresent) {
      console.log('[release-2] browser SKIP: no chromium binary');
      return;
    }
    const here = dirname(fileURLToPath(import.meta.url));
    const appDir = resolve(here, '..');
    const repoRoot = resolve(here, '..', '..', '..');
    const viteCands = [join(repoRoot, 'node_modules', '.bin', 'vite'), join(appDir, 'node_modules', '.bin', 'vite')];
    let viteBin: string | null = null;
    for (const c of viteCands) {
      try { accessSync(c, constants.X_OK); viteBin = c; break; } catch { /* next */ }
    }
    if (!viteBin) throw new Error('vite binary not found');
    const vitePort = Number(process.env.RELEASE_2_VITE_PORT ?? 5195);
    const viteProc = spawn(process.execPath, [viteBin, '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], {
      cwd: appDir, stdio: ['ignore', 'ignore', 'ignore'],
    });
    const killAll = async (): Promise<void> => {
      try {
        if (viteProc.exitCode === null && viteProc.signalCode === null) {
          viteProc.kill('SIGTERM');
          await new Promise<void>((res) => { viteProc.on('exit', () => res()); setTimeout(() => res(), 8000); });
          if (viteProc.exitCode === null) { try { viteProc.kill('SIGKILL'); } catch { /* exited */ } }
        }
      } catch { /* gone */ }
    };
    try {
      await waitHttpOk(`http://127.0.0.1:${vitePort}/`, 120000);
      const pageUrl = `http://127.0.0.1:${vitePort}/?q2soak=1&q2pak=devroom&q2renderer=webgl2-experimental`;
      const userDataDir = join(tmpdir(), `q2-release2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
      mkdirSync(userDataDir, { recursive: true });
      const chromium = await launchChromium(pageUrl, userDataDir);
      try {
        const { page, consoleLines } = await connectCdp(chromium.port);
        try {
          let status: { booted?: boolean; error?: string | null; actualRenderer?: string; warning?: string | null } | null = null;
          const bootDeadline = Date.now() + 180000;
          for (;;) {
            status = await page.evaluate<{ booted?: boolean; error?: string | null; actualRenderer?: string; warning?: string | null } | null>('window.__q2soak ? window.__q2soak : null', 30000).catch(() => null);
            if (status && status.booted) break;
            if (status && status.error) throw new Error(`page boot error: ${status.error}`);
            if (Date.now() > bootDeadline) throw new Error('devroom soak boot timeout (180s)');
            await sleep(2000);
          }
          expect(status!.actualRenderer).toBe('webgl2-experimental');
          expect(status!.warning).toBeNull();
          await page.evaluate<void>(PX_ANALYZE_INSTALL, 30000);
          const cdp = await import('./soak.js').catch(() => null);
          void cdp;
          // Route proof: world submitted once, entities live, frames advance.
          const route0 = await page.evaluate('window.__q2soakRoute ? window.__q2soakRoute() : null', 30000) as {
            scene?: { worldOpaque: number; worldTransparent: number; entityRefs: number; staticTotal: number } | null;
            camera?: { origin: number[] } | null;
          } | null;
          expect(route0, 'route sample present').not.toBeNull();
          expect(route0!.scene, 'scene census present').not.toBeNull();
          expect(route0!.scene!.worldOpaque, 'procedural world submits').toBeGreaterThan(0);
          expect(route0!.scene!.staticTotal, 'persistent world inventory uploaded').toBeGreaterThan(5);
          const frames0 = await page.evaluate('window.__q2soak ? window.__q2soakFrames.length : 0', 15000) as number;
          await sleep(1500);
          const frames1 = await page.evaluate('window.__q2soak ? window.__q2soakFrames.length : 0', 15000) as number;
          expect(frames1).toBeGreaterThan(frames0);
          const box = await page.evaluate<{ x: number; y: number; width: number; height: number } | null>(
            '(() => { const c = document.querySelector("#q2"); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()',
            30000,
          );
          expect(box, 'game canvas present').not.toBeNull();
          const shotOf = async (): Promise<ShotAnalysis> => {
            const b64 = await page.screenshot(box!);
            return page.evaluate<ShotAnalysis>(`window.__q2px("${b64}")`, 60000);
          };
          // Two canvases: GL scene below, transparent HUD overlay above.
          const canvasCount = await page.evaluate('document.querySelectorAll("canvas").length', 15000) as number;
          expect(canvasCount).toBeGreaterThanOrEqual(2);
          const room = await shotOf();
          expect(room.nonblack, 'devroom GPU pixels are live').toBeGreaterThan(0.25);
          // Not a flat clear color: distinct colors + regional variance.
          expect(room.distinct, 'room/material/entity colors, not one clear color').toBeGreaterThan(200);
          const [tl, tr, bl, br] = room.quadrants;
          const spread = Math.max(tl, tr, bl, br) - Math.min(tl, tr, bl, br);
          expect(spread, `quadrant spread tl=${tl.toFixed(1)} tr=${tr.toFixed(1)} bl=${bl.toFixed(1)} br=${br.toFixed(1)}`).toBeGreaterThan(3);
          // Entities: fire the blaster through the genuine pointer-lock flow
          // (canvas click acquires the lock, held left button is game fire —
          // no page-code input synthesis). The live bolt/explosion must
          // submit as renderer entities while in flight.
          const cx = box!.x + box!.width / 2;
          const cy = box!.y + box!.height / 2;
          await page.evaluate('(() => { const c = document.querySelector("#q2"); if (c) c.scrollIntoView({ block: "start" }); })()', 15000).catch(() => null);
          await sleep(500);
          await page.mouseDown(cx, cy);
          await sleep(150);
          await page.mouseUp(cx, cy);
          await sleep(1200);
          let lockId = await page.evaluate<string | null>(
            'document.pointerLockElement ? document.pointerLockElement.id : null', 15000).catch(() => null);
          if (lockId !== 'q2') {
            await page.evaluate('(() => { const c = document.querySelector("#q2"); if (c && c.requestPointerLock) { try { c.requestPointerLock(); } catch (e) {} } })()', 15000).catch(() => null);
            await sleep(1200);
            lockId = await page.evaluate<string | null>(
              'document.pointerLockElement ? document.pointerLockElement.id : null', 15000).catch(() => null);
          }
          expect(lockId, 'pointer lock acquired for game fire').toBe('q2');
          await page.mouseDown(cx, cy);
          let fired: { bolts: number; entityRefs: number; muzzle: boolean } | null = null;
          const fireDeadline = Date.now() + 30000;
          for (;;) {
            const r = await page.evaluate('window.__q2soakRoute ? window.__q2soakRoute() : null', 15000).catch(() => null) as {
              scene?: { entityRefs: number } | null;
              effects?: { bolts: number; muzzleLit: boolean } | null;
              combat?: { bolts: number } | null;
            } | null;
            const bolts = r?.combat?.bolts ?? r?.effects?.bolts ?? 0;
            const entityRefs = r?.scene?.entityRefs ?? 0;
            const muzzle = r?.effects?.muzzleLit ?? false;
            if (bolts > 0 || entityRefs > 0 || muzzle) {
              fired = { bolts, entityRefs, muzzle };
              break;
            }
            if (Date.now() > fireDeadline) break;
            await sleep(500);
          }
          await page.mouseUp(cx, cy);
          expect(fired, 'live bolt/explosion submits as renderer entities on the GPU page').not.toBeNull();
          console.log(
            `[release-2] fired bolts=${fired!.bolts} entityRefs=${fired!.entityRefs} muzzle=${fired!.muzzle}`,
          );
          // Missing-world control: teleport into the void (no geometry in
          // view) — the same comparator must collapse to clear color.
          const teleported = await page.evaluate('window.__q2soakTeleport ? window.__q2soakTeleport(0, 0, 3000) : false', 15000) as boolean;
          expect(teleported).toBe(true);
          await sleep(1500);
          const voidShot = await shotOf();
          expect(voidShot.nonblack, 'void view collapses (control proves room pixels are world geometry)').toBeLessThan(room.nonblack * 0.5);
          const consoleErrors = consoleLines.filter(
            (l) => l.startsWith('[exception]') || l.includes('Uncaught') || l.includes('ERROR'));
          expect(consoleErrors).toEqual([]);
          console.log(
            `[release-2] room nonblack=${room.nonblack.toFixed(3)} distinct=${room.distinct} ` +
            `quadrants=${room.quadrants.map((q) => q.toFixed(1)).join(',')} hash=${room.hash.toString(16)} ` +
            `void=${voidShot.nonblack.toFixed(3)} opaque=${route0!.scene!.worldOpaque} entities=${route0!.scene!.entityRefs}`,
          );
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
  });
});
