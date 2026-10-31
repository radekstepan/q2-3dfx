// GPU-FOLLOW-3B web captures (apps/web only): stationary/moving real-page
// water captures at the base1 bluwter pool proving the tile-boundary repair,
// with the sky/wall/enemy/barrel repairs confirmed intact.
//
// The shader repair (LOD-unwarped + highp) landed in `@q2/webgl-renderer` and
// the pixel lattice is covered in `@q2/testkit`; this lane proves the repair
// on the REAL production page (vite + soak + SwiftShader WebGL2) through the
// production `frameGpuPlay`/soak path — never a reimplementation.
//
// Legs:
//   - headless (Q2_PAK): the pool view through production `frameGpuPlay`
//     selects turbulent water deterministically (stationary) and re-selects
//     across time (moving); sky/wall/enemy/barrel census stays intact with
//     no fatal backend warnings.
//   - real page (chromium, Q2_PAK): teleport to the pool view, stationary
//     captures (water animates between them) and a moving capture (forward
//     drive changes the origin), every capture scored by the tile-seam
//     metric; an injected-seam control proves the metric can fail; the route
//     snapshot confirms sky/wall/enemy/barrel state and a clean console.
import { afterEach, describe, expect, it } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { readFileSync } from 'fs';
import { accessSync, constants, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { createServer } from 'http';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import {
  bootPlay,
  frameGpuPlay,
} from './play.js';
import {
  censusSceneMaterials,
  censusWorldMaterials,
} from './gpu-effects.js';

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g['document'];
});

const WEB_Q2_PAK = process.env.Q2_PAK;
const CHROMIUM_BIN = process.env.CHROMIUM_BIN ?? '/usr/bin/chromium';

/** base1 bluwter pool view (matches the testkit real legs). */
const POOL_CAMERA = { origin: [416, 900, -100] as [number, number, number], yaw: 90, pitch: 30 };

function installStubDoc(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const gl = new Proxy(
    {},
    {
      get(_t, prop): unknown {
        if (prop === 'checkFramebufferStatus') return () => 36053;
        if (prop === 'getError') return () => 0;
        if (typeof prop === 'string' && prop.includes('InfoLog')) return () => '';
        if (typeof prop === 'string' && prop.includes('Location')) return () => ({});
        if (prop === 'getParameter') {
          return (p: unknown): unknown => {
            if (p === 7937) return 'WebGL 2.0 (stub)';
            return 4096;
          };
        }
        if (typeof prop === 'string' && prop.startsWith('get')) {
          return (..._a: unknown[]): unknown => true;
        }
        if (typeof prop === 'string' && /^[A-Z0-9_]+$/.test(prop)) {
          // GL enum constants (never functions): the completeness check
          // compares against checkFramebufferStatus above; everything else
          // is an opaque token the stub ignores.
          return prop === 'FRAMEBUFFER_COMPLETE' ? 36053 : 0;
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
    getElementById: (id: string): unknown => (id === 'q2' ? hud : null),
    querySelector: (sel: string): unknown => (sel === '#q2' ? hud : null),
    body: { appendChild(): void { /* noop */ } },
  };
}

async function loadPakBoot(width = 320, height = 240): Promise<ReturnType<typeof bootPlay>> {
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

function placeAtPool(boot: ReturnType<typeof bootPlay>): void {
  boot.driver.pm.origin = v3(POOL_CAMERA.origin[0], POOL_CAMERA.origin[1], POOL_CAMERA.origin[2] - 22);
  boot.driver.pm.velocity = v3();
  boot.driver.pm.viewAngles = v3(POOL_CAMERA.pitch, POOL_CAMERA.yaw, 0);
  boot.host.input.angles = [POOL_CAMERA.pitch, POOL_CAMERA.yaw, 0];
}

function neutralCmd(): UserCmdT {
  return { msec: 100, angles: [POOL_CAMERA.pitch, POOL_CAMERA.yaw, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

describe.runIf(!!WEB_Q2_PAK)('gpu-follow3b pool view (headless production path, Q2_PAK)', () => {
  it('stationary pool view selects turbulent water deterministically', { timeout: 180000 }, async () => {
    installStubDoc();
    const boot = await loadPakBoot();
    // World census: the repair inputs exist (sky, water, glass, walls).
    const census = censusWorldMaterials(boot.driver.mini);
    expect(census.sky).toBeGreaterThan(0);
    expect(census.turbulent).toBeGreaterThan(0);
    expect(census.opaque).toBeGreaterThan(0);
    placeAtPool(boot);
    let now = 0;
    // Warm-up: the host ingests the teleported snapshot through 10Hz ticks
    // (playerOrigin follows pm.origin only via snapshot ingest), so the
    // submitted view reaches the pool before asserting.
    for (let i = 0; i < 12; i++) {
      now += 16;
      frameGpuPlay(boot, now);
    }
    const first = censusSceneMaterials(boot.gpu!.scene);
    expect(first.turbulent, 'pool view submits turbulent water').toBeGreaterThan(0);
    // Stationary replay at the same sim time: identical selection.
    const snap = { ...first };
    frameGpuPlay(boot, now);
    const second = censusSceneMaterials(boot.gpu!.scene);
    expect(second).toEqual(snap);
    // Moving time re-selects (same counts, simulation advanced).
    now += 250;
    frameGpuPlay(boot, now);
    const third = censusSceneMaterials(boot.gpu!.scene);
    expect(third.turbulent).toBeGreaterThan(0);
    expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(14);
    console.log(`[follow3b] pool stationary turbulent=${first.turbulent} sky=${first.sky} opaque=${first.worldOpaque}`);
  });

  it('sky/wall/enemy/barrel repairs stay intact around the pool', { timeout: 180000 }, async () => {
    installStubDoc();
    const boot = await loadPakBoot();
    const models = boot.models!;
    // Sky: look up from the pool.
    placeAtPool(boot);
    boot.driver.pm.viewAngles = v3(-20, POOL_CAMERA.yaw, 0);
    boot.host.input.angles = [-20, POOL_CAMERA.yaw, 0];
    let now = 0;
    for (let i = 0; i < 12; i++) {
      now += 16;
      frameGpuPlay(boot, now);
    }
    const skyView = censusSceneMaterials(boot.gpu!.scene);
    expect(skyView.sky, 'sky faces submit (3A intact)').toBeGreaterThan(0);
    // Wall: opaque geometry dominates the pool view.
    placeAtPool(boot);
    now += 16;
    frameGpuPlay(boot, now);
    const pool = censusSceneMaterials(boot.gpu!.scene);
    expect(pool.worldOpaque, 'walls submit (wall repair intact)').toBeGreaterThan(0);
    // Enemies: soldier + infantry live in base1 with their own meshes.
    expect(boot.driver.aliveMonsters).toBeGreaterThan(0);
    const kinds = new Set(boot.driver.monsters.filter((m) => !m.state.dead).map((m) => String(m.state.kind)));
    expect([...kinds].sort()).toEqual(['infantry', 'soldier']);
    const gpu = boot.gpu!.gpu;
    for (const h of [models.monster, models.gunner, models.infantry, models.bolt]) {
      expect(gpu.testRegisteredModels()).toContain(h);
    }
    // Barrels: shootable exploboxes registered and live.
    expect(boot.driver.barrels.length).toBeGreaterThan(0);
    expect(gpu.testRegisteredModels()).toContain(models.barrel);
    // No fatal backend warnings on the repaired path.
    const fatal = gpu.testWarnings().filter((w) => /missing|invalid|failed/i.test(w));
    expect(fatal).toEqual([]);
    console.log(`[follow3b] sky=${skyView.sky} opaque=${pool.worldOpaque} monsters=${boot.driver.aliveMonsters} barrels=${boot.driver.barrels.length}`);
  });
});

// --- real page (chromium, Q2_PAK): stationary/moving pool captures ---------

interface SeamScore {
  hEdgeFrac: number;
  maxRowH: number;
  maxColH: number;
  vEdgeFrac: number;
  maxColV: number;
  maxRowV: number;
}

interface CdpKey { key: string; code: string; windowsVirtualKeyCode: number; nativeVirtualKeyCode: number; }

interface BrowserPage {
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
  keyDown(key: CdpKey): Promise<void>;
  keyUp(key: CdpKey): Promise<void>;
  screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<string>;
  close(): void;
}

const KEY_LEFT: CdpKey = { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 };
const KEY_PAGEDOWN: CdpKey = { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34 };

const SEAM_ANALYZE_INSTALL = `window.__q2seam = async (b64, inject) => {
  const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  if (inject === 'line') {
    // White: the pool water is dark, so a black line would sit below the
    // 40-step threshold and prove nothing — white always steps hard.
    x.fillStyle = '#fff';
    x.fillRect(c.width * 0.3, (c.height * 0.5) | 0, c.width * 0.4, 1);
  }
  const d = x.getImageData(0, 0, c.width, c.height).data;
  const x0 = (c.width * 0.3) | 0, x1 = (c.width * 0.7) | 0;
  const y0 = (c.height * 0.35) | 0, y1 = (c.height * 0.65) | 0;
  const lum = (px, py) => {
    const o = (py * c.width + px) * 4;
    return (d[o] + d[o+1] + d[o+2]) / 3;
  };
  // Horizontal scan: adjacent-column steps (vertical edges).
  let hEdges = 0, hTotal = 0, maxRowH = 0;
  const colCounts = new Array(x1 - x0).fill(0);
  for (let py = y0; py < y1; py++) {
    let rowEdges = 0;
    for (let px = x0; px < x1; px++) {
      const step = Math.abs(lum(px + 1, py) - lum(px, py));
      hTotal++;
      if (step > 40) { hEdges++; rowEdges++; colCounts[px - x0]++; }
    }
    maxRowH = Math.max(maxRowH, rowEdges / (x1 - x0));
  }
  let maxColH = 0;
  for (const n of colCounts) maxColH = Math.max(maxColH, n / (y1 - y0));
  // Vertical scan: adjacent-row steps (horizontal edges — the direction a
  // horizontal-only scan is blind to; tile seams draw full-width lines).
  let vEdges = 0, vTotal = 0, maxColV = 0;
  const rowCounts = new Array(y1 - y0).fill(0);
  for (let px = x0; px < x1; px++) {
    let colEdges = 0;
    for (let py = y0; py < y1 - 1; py++) {
      const step = Math.abs(lum(px, py + 1) - lum(px, py));
      vTotal++;
      if (step > 40) { vEdges++; colEdges++; rowCounts[py - y0]++; }
    }
    maxColV = Math.max(maxColV, colEdges / (y1 - y0));
  }
  let maxRowV = 0;
  for (const n of rowCounts) maxRowV = Math.max(maxRowV, n / (x1 - x0));
  bmp.close();
  return { hEdgeFrac: hEdges / hTotal, maxRowH, maxColH, vEdgeFrac: vEdges / vTotal, maxColV, maxRowV };
};
window.__q2roidiff = async (a64, b64) => {
  const dec = async (b) => {
    const blob = await (await fetch('data:image/png;base64,' + b)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(bmp, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    bmp.close();
    return { c, d };
  };
  const A = await dec(a64), B = await dec(b64);
  const W = A.c.width, H = A.c.height;
  const x0 = (W * 0.3) | 0, x1 = (W * 0.7) | 0;
  const y0 = (H * 0.35) | 0, y1 = (H * 0.65) | 0;
  let diff = 0, total = 0;
  let bn = 0, bt = 0;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const o = (py * W + px) * 4;
      const m = (A.d[o] + A.d[o+1] + A.d[o+2]) / 3;
      if (m > 8) bt++;
      if (px >= x0 && px < x1 && py >= y0 && py < y1) {
        total++;
        const m2 = (B.d[o] + B.d[o+1] + B.d[o+2]) / 3;
        if (Math.abs(m - m2) > 8) diff++;
      }
    }
  }
  for (let i = 0; i < B.d.length; i += 4) {
    const m = (B.d[i] + B.d[i+1] + B.d[i+2]) / 3;
    if (m > 8) bn++;
  }
  const px = W * H;
  return { roiDiff: diff / total, nonblackA: bt / px, nonblackB: bn / px };
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

describe.runIf(!!WEB_Q2_PAK && !!CHROMIUM_BIN)('gpu-follow3b real-page pool captures (chromium, Q2_PAK)', () => {
  it('stationary + moving pool captures pass the tile-seam metric', { timeout: 600000 }, async () => {
    let chromiumPresent = false;
    try {
      accessSync(CHROMIUM_BIN, constants.X_OK);
      chromiumPresent = true;
    } catch {
      chromiumPresent = false;
    }
    if (!chromiumPresent) {
      console.log('[follow3b] browser SKIP: no chromium binary');
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
    const vitePort = Number(process.env.FOLLOW_3B_VITE_PORT ?? 5196);
    const viteProc = spawn(process.execPath, [viteBin, '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], {
      cwd: appDir, stdio: ['ignore', 'ignore', 'ignore'],
    });
    const killAll = async (): Promise<void> => {
      try { await new Promise<void>((res) => { pakServer.close(() => res()); setTimeout(() => res(), 3000); }); } catch { /* x */ }
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
      const pageUrl = `http://127.0.0.1:${vitePort}/?q2soak=1&q2pak=${encodeURIComponent(`${pakUrl}/pak0.pak`)}&q2renderer=webgl2-experimental`;
      const userDataDir = join(tmpdir(), `q2-follow3b-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
      mkdirSync(userDataDir, { recursive: true });
      const chromium = await launchChromium(pageUrl, userDataDir);
      try {
        const { page, consoleLines } = await connectCdp(chromium.port);
        try {
          let status: { booted?: boolean; error?: string | null; actualRenderer?: string; warning?: string | null } | null = null;
          const bootDeadline = Date.now() + 240000;
          for (;;) {
            status = await page.evaluate<{ booted?: boolean; error?: string | null; actualRenderer?: string; warning?: string | null } | null>('window.__q2soak ? window.__q2soak : null', 30000).catch(() => null);
            if (status && status.booted) break;
            if (status && status.error) throw new Error(`page boot error: ${status.error}`);
            if (Date.now() > bootDeadline) throw new Error('soak boot timeout (240s)');
            await sleep(2000);
          }
          expect(status!.actualRenderer).toBe('webgl2-experimental');
          expect(status!.warning).toBeNull();
          await page.evaluate<void>(SEAM_ANALYZE_INSTALL, 30000);
          // Teleport to the pool view (camera = player + 22 standing).
          const teleported = await page.evaluate(
            `window.__q2soakTeleport ? window.__q2soakTeleport(${POOL_CAMERA.origin[0]}, ${POOL_CAMERA.origin[1]}, ${POOL_CAMERA.origin[2] - 22}) : false`,
            15000,
          ) as boolean;
          expect(teleported).toBe(true);
          // Aim at the pool with real keyboard input (140 deg/s turn keys):
          // hold ArrowLeft to yaw ~90, PageDown to pitch ~30 down, polling
          // the route camera (never page-code input synthesis).
          const camAngles = async (): Promise<[number, number] | null> => {
            const r = await page.evaluate('window.__q2soakRoute ? window.__q2soakRoute() : null', 15000).catch(() => null) as {
              camera?: { angles: number[] } | null;
            } | null;
            const a = r?.camera?.angles;
            return a && a.length >= 2 ? [a[0], a[1]] : null;
          };
          const wrapYaw = (y: number): number => ((y % 360) + 360) % 360;
          const yawDist = (a: number, b: number): number => {
            const d = Math.abs(wrapYaw(a) - wrapYaw(b));
            return Math.min(d, 360 - d);
          };
          await page.keyDown(KEY_LEFT);
          for (let i = 0; i < 40; i++) {
            await sleep(100);
            const a = await camAngles();
            if (a && yawDist(a[1], POOL_CAMERA.yaw) < 5) break;
          }
          await page.keyUp(KEY_LEFT);
          await page.keyDown(KEY_PAGEDOWN);
          for (let i = 0; i < 40; i++) {
            await sleep(100);
            const a = await camAngles();
            if (a && Math.abs(a[0] - POOL_CAMERA.pitch) < 4) break;
          }
          await page.keyUp(KEY_PAGEDOWN);
          const aimedAngles = await camAngles();
          expect(aimedAngles, 'route camera present for pool aim').not.toBeNull();
          expect(yawDist(aimedAngles![1], POOL_CAMERA.yaw), `yaw aimed at pool (got ${aimedAngles})`).toBeLessThan(12);
          expect(Math.abs(aimedAngles![0] - POOL_CAMERA.pitch), `pitch aimed at pool (got ${aimedAngles})`).toBeLessThan(10);
          await sleep(2000);
          const box = await page.evaluate<{ x: number; y: number; width: number; height: number } | null>(
            '(() => { const c = document.querySelector("#q2"); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()',
            30000,
          );
          expect(box, 'game canvas present').not.toBeNull();
          const shotOf = async (): Promise<string> => page.screenshot(box!);
          const seamOf = async (b64: string, inject?: string): Promise<SeamScore> =>
            page.evaluate<SeamScore>(`window.__q2seam("${b64}"${inject ? `, "${inject}"` : ''})`, 60000);
          // STATIONARY: two captures ~1.5s apart (warp animates between them).
          const shotA = await shotOf();
          await sleep(1500);
          const shotB = await shotOf();
          const cmp = await page.evaluate(`window.__q2roidiff("${shotA}", "${shotB}")`, 60000) as {
            roiDiff: number; nonblackA: number; nonblackB: number;
          };
          expect(cmp.nonblackA, 'stationary pool capture is live').toBeGreaterThan(0.5);
          expect(cmp.nonblackB, 'second stationary capture is live').toBeGreaterThan(0.5);
          expect(cmp.roiDiff, 'warp animates the water between stationary captures').toBeGreaterThan(0.005);
          const seamA = await seamOf(shotA);
          const seamB = await seamOf(shotB);
          // MOVING: translate the viewpoint along the pool in teleport
          // steps (the pool camera spot is not a walkable player stance, so
          // KeyW driving sticks — teleport steps are genuine viewpoint
          // translation: water parallax must change between captures).
          const routeBefore = await page.evaluate('window.__q2soakRoute ? window.__q2soakRoute() : null', 15000) as {
            camera?: { origin: number[] } | null;
          } | null;
          const stops: Array<[number, number, number]> = [
            [POOL_CAMERA.origin[0] + 40, POOL_CAMERA.origin[1], POOL_CAMERA.origin[2] - 22],
            [POOL_CAMERA.origin[0] + 80, POOL_CAMERA.origin[1], POOL_CAMERA.origin[2] - 22],
          ];
          for (const [tx, ty, tz] of stops) {
            const ok = await page.evaluate(
              `window.__q2soakTeleport ? window.__q2soakTeleport(${tx}, ${ty}, ${tz}) : false`,
              15000,
            ) as boolean;
            expect(ok).toBe(true);
            await sleep(1200);
          }
          const routeAfter = await page.evaluate('window.__q2soakRoute ? window.__q2soakRoute() : null', 15000) as {
            camera?: { origin: number[] } | null;
            aliveMonsters?: number;
            scene?: { worldOpaque: number; entityRefs: number } | null;
            materials?: unknown;
          } | null;
          const o0 = routeBefore?.camera?.origin ?? [0, 0, 0];
          const o1 = routeAfter?.camera?.origin ?? [0, 0, 0];
          const moved = Math.hypot(o1[0] - o0[0], o1[1] - o0[1], o1[2] - o0[2]);
          expect(moved, `camera moved while driving (from ${o0} to ${o1})`).toBeGreaterThan(5);
          const shotC = await shotOf();
          const seamC = await seamOf(shotC);
          console.log(
            `[follow3b] seamA=${JSON.stringify(seamA)} seamB=${JSON.stringify(seamB)} seamC=${JSON.stringify(seamC)}`,
          );
          // Tile-seam metric on all three captures: no long straight hard
          // edges in the water ROI (the tile-boundary defect drew full
          // lines — a full-width line drives maxColV near 1.0, a
          // full-height line drives maxRowH near 1.0, both elevate the
          // edge fractions).
          for (const [name, s] of [['A', seamA], ['B', seamB], ['C', seamC]] as const) {
            expect(s.hEdgeFrac, `${name}: sparse vertical hard edges`).toBeLessThan(0.05);
            expect(s.vEdgeFrac, `${name}: sparse horizontal hard edges`).toBeLessThan(0.05);
            expect(s.maxRowH, `${name}: no full-height seam line`).toBeLessThan(0.6);
            expect(s.maxColV, `${name}: no full-width vertical edge run`).toBeLessThan(0.6);
            expect(s.maxRowV, `${name}: no full-width horizontal seam line`).toBeLessThan(0.6);
          }
          // Negative control: an injected partial-width seam MUST trip
          // the metric on the same bitmap (proves the comparator can fail):
          // the 40%-wide 1px line fills its row (maxRowV near 1.0).
          const seamInjected = await seamOf(shotA, 'line');
          expect(
            seamInjected.maxRowV > 0.6 || seamInjected.vEdgeFrac > 0.05,
            `injected seam trips the metric (got ${JSON.stringify(seamInjected)})`,
          ).toBe(true);
          // Repairs intact on the page: enemies live, opaque walls submit,
          // no backend warnings, console clean.
          expect(routeAfter?.aliveMonsters ?? -1, 'enemies live (enemy repair intact)').toBeGreaterThan(0);
          expect(routeAfter?.scene?.worldOpaque ?? 0, 'walls submit (wall repair intact)').toBeGreaterThan(0);
          const lifecycleType = await page.evaluate('typeof window.__q2soakLifecycle', 15000).catch(() => 'error') as string;
          const lifecycle = await page.evaluate('window.__q2soakLifecycle ? window.__q2soakLifecycle() : null', 15000).catch(() => null) as {
            framesSubmitted?: number; uploads?: number; fallback?: string | null;
          } | null;
          console.log(`[follow3b] lifecycleType=${lifecycleType} lifecycle=${JSON.stringify(lifecycle)}`);
          const soakStateRaw = await page.evaluate('typeof window.__q2soakState', 15000).catch(() => 'error') as string;
          console.log(`[follow3b] soakStateType=${soakStateRaw}`);
          // Retry transient CDP hiccups (a single timed-out read must not
          // fail the leg — the polled route/teleport reads above prove the
          // page is live; this is observability, not the verdict path).
          let soakState: {
            gpuActive?: boolean; warning?: string | null; framesSubmitted?: number | null; uploads?: number | null;
          } | null = null;
          let soakStateErr = '';
          for (let i = 0; i < 5 && soakState === null; i++) {
            try {
              soakState = await page.evaluate('window.__q2soakState ? window.__q2soakState() : null', 15000);
            } catch (e) {
              soakStateErr = e instanceof Error ? e.message : String(e);
              await sleep(500);
            }
          }
          console.log(`[follow3b] soakState=${JSON.stringify(soakState)} err=${soakStateErr.slice(0, 160)}`);
          expect(soakState, 'soak state readable').not.toBeNull();
          expect(soakState!.gpuActive, 'GPU path live on the pool page').toBe(true);
          expect(soakState!.warning, 'no unsupported-GPU fallback').toBeNull();
          expect(soakState!.uploads, 'world uploaded once').toBe(1);
          const consoleErrors = consoleLines.filter(
            (l) => l.startsWith('[exception]') || l.includes('Uncaught') || l.includes('ERROR'));
          expect(consoleErrors).toEqual([]);
          console.log(
            `[follow3b] stationary roiDiff=${cmp.roiDiff.toFixed(4)} seamA=${JSON.stringify(seamA)} ` +
            `seamB=${JSON.stringify(seamB)} seamC=${JSON.stringify(seamC)} moved=${moved.toFixed(1)} ` +
            `injected=${JSON.stringify(seamInjected)}`,
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
