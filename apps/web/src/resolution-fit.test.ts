// RELEASE-3 — real-browser presentation proof at every offered resolution.
//
// Drives the PRODUCTION page (vite dev + headless chromium, normal devroom
// boot — no pak needed) at 640x480, 800x600 and 1024x768 on Software and
// WebGL2 and asserts the composed-page contract the user's retest failed:
//
// - the HUD canvas (#q2) backing equals the framebuffer (no stale size);
// - the CSS display box fits the stage at the framebuffer aspect (uniform
//   scale: aspect preserved, no letterbox bands, no overflow);
// - on GPU legs the GL canvas (#q2-gl) box equals the HUD box within 1px
//   (shared center, shared scale: scene and crosshair cannot drift apart);
// - the whole canvas is inside the viewport with no page scroll (bottom HUD
//   — weapon, hp, fps, pos — is visible, not below the fold);
// - the rendered crosshair sits on the backing center pixel (read back from
//   the live canvas: opaque white center, dim arms) on BOTH backends;
// - the 2D gun silhouette region is non-black (viewmodel present);
// - viewport size, DPR, scroll offsets and a fullscreen attempt are recorded,
//   and per-leg screenshots are kept under test-output/.
//
// The pre-fix code requested framebuffer-x2 CSS pixels unconditionally
// (1600x1200 at 800x600, 2048x1536 at 1024x768): the max-width/height caps
// letterboxed the content (measured 746x960 element boxes for a 640x480
// backing), centering the scene in empty bands and pushing the bottom HUD
// out of view. These legs fail on that shape (aspect mismatch, overflow,
// rect inequality, below-fold HUD) and pass on the fitted shape.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { accessSync, constants, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';

const CHROMIUM_BIN = process.env.CHROMIUM_BIN ?? '/usr/bin/chromium';

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function viteBin(): string | null {
  const cands = [join(repoRoot(), 'node_modules', '.bin', 'vite')];
  for (const c of cands) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      /* next */
    }
  }
  return null;
}

function chromiumPresent(): boolean {
  try {
    accessSync(CHROMIUM_BIN, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const CAN_RUN = chromiumPresent() && viteBin() !== null;

interface CdpPage {
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
  screenshot(): Promise<string>;
  close(): void;
}

interface CdpMsg {
  id?: unknown;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: { args?: { value?: unknown; description?: string }[]; type?: string };
}

function createPage(wsUrl: string): Promise<{ page: CdpPage; consoleLines: string[] }> {
  return new Promise((resolvePage, rejectPage) => {
    const ws = new WebSocket(wsUrl);
    const consoleLines: string[] = [];
    const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let nextId = 1;
    let closed = false;
    const send = (method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> =>
      new Promise((res, rej) => {
        if (closed) {
          rej(new Error('CDP closed'));
          return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`CDP timeout: ${method}`));
        }, timeoutMs);
        pending.set(id, { res: res as (v: unknown) => void, rej, timer });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (e) {
          pending.delete(id);
          clearTimeout(timer);
          rej(e instanceof Error ? e : new Error(String(e)));
        }
      });
    const openTimer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* x */
      }
      rejectPage(new Error('CDP socket open timeout'));
    }, 20000);
    ws.onopen = () => {
      clearTimeout(openTimer);
      const page: CdpPage = {
        evaluate: async <T>(expression: string, timeoutMs = 60000): Promise<T> => {
          const r = (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs)) as {
            exceptionDetails?: { text?: string; exception?: { description?: string } };
            result?: { value?: unknown };
          };
          if (r.exceptionDetails) {
            const detail = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'unknown';
            throw new Error(`page evaluate threw: ${detail.slice(0, 300)}`);
          }
          return r.result?.value as T;
        },
        screenshot: async (): Promise<string> => {
          const r = (await send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 60000)) as { data?: unknown };
          if (typeof r.data !== 'string') throw new Error('screenshot: no data');
          return r.data;
        },
        close: (): void => {
          closed = true;
          for (const [, p] of pending) {
            clearTimeout(p.timer);
            p.rej(new Error('CDP closed'));
          }
          pending.clear();
          try {
            ws.close();
          } catch {
            /* x */
          }
        },
      };
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== 'string') return;
        let msg: CdpMsg | null = null;
        try {
          msg = JSON.parse(ev.data) as CdpMsg;
        } catch {
          return;
        }
        if (!msg) return;
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.rej(new Error(`CDP error: ${msg.error.message ?? 'unknown'}`));
          else p.res(msg.result ?? {});
          return;
        }
        if (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Runtime.exceptionThrown') {
          if (consoleLines.length < 200) consoleLines.push(`[${msg.method}] ${(msg.params?.args ?? []).map((a) => String(a.value ?? a.description ?? '?')).join(' ')}`);
        }
      };
      ws.onclose = () => {
        closed = true;
        for (const [, p] of pending) {
          clearTimeout(p.timer);
          p.rej(new Error('CDP socket closed'));
        }
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
    ws.onerror = () => {
      clearTimeout(openTimer);
      rejectPage(new Error('CDP socket error before open'));
    };
  });
}

async function launchChromium(pageUrl: string, userDataDir: string): Promise<{ port: number; proc: ChildProcess }> {
  return new Promise((resolveLaunch, rejectLaunch) => {
    const args = [
      '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--mute-audio',
      '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
      '--window-size=1500,1000', '--force-device-scale-factor=1',
      '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', pageUrl,
    ];
    let proc: ChildProcess;
    try {
      proc = spawn(CHROMIUM_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      rejectLaunch(new Error('chromium spawn failed: ' + String(e)));
      return;
    }
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          proc.kill('SIGKILL');
        } catch {
          /* x */
        }
        rejectLaunch(new Error('chromium: no DevTools port within 30s'));
      }
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
    proc.on('error', (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectLaunch(new Error('chromium process error: ' + e.message));
      }
    });
    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectLaunch(new Error(`chromium exited early (code ${code}). tail: ${stderr.slice(-2000)}`));
      }
    });
  });
}

async function startVite(): Promise<{ url: string; proc: ChildProcess }> {
  const bin = viteBin()!;
  const port = Number(process.env.RESFIT_VITE_PORT ?? 5197);
  const webRoot = join(repoRoot(), 'apps', 'web');
  return new Promise((resolveStart, rejectStart) => {
    let proc: ChildProcess;
    try {
      proc = spawn(process.execPath, [bin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
        cwd: webRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      rejectStart(new Error('vite spawn failed: ' + String(e)));
      return;
    }
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          proc.kill('SIGKILL');
        } catch {
          /* x */
        }
        rejectStart(new Error('vite: no Local URL within 60s. tail: ' + out.slice(-2000)));
      }
    }, 60000);
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      out += String(chunk);
      const m = /Local:\s+(http:\/\/\S+)/.exec(out);
      if (m) {
        settled = true;
        clearTimeout(timer);
        resolveStart({ url: (m[1] ?? '').replace(/\/$/, ''), proc });
      }
      if (out.length > 200000) out = out.slice(-50000);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectStart(new Error('vite process error: ' + e.message));
      }
    });
    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectStart(new Error(`vite exited early (code ${code}). tail: ` + out.slice(-2000)));
      }
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitHttpOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`http not ready: ${url}`);
    await sleep(2000);
  }
}

// One composed-page observation: rects, backing, style, viewport, DPR,
// scroll, live crosshair/HUD backing pixels, fullscreen attempt outcome.
const PROBE_JS = `
(async function () {
  function rectOf(el) {
    if (!el || !el.getBoundingClientRect) return null;
    var r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  var q2 = document.querySelector('#q2');
  var glc = document.querySelector('#q2-gl');
  var stage = document.querySelector('#q2-stage');
  var bezel = document.querySelector('#q2-bezel');
  function px2d(el, x, y) {
    try {
      var ctx = el.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      var d = ctx.getImageData(Math.max(0, x | 0), Math.max(0, y | 0), 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    } catch (e) { return null; }
  }
  function gunNonBlack(el) {
    try {
      var w = el.width | 0, h = el.height | 0;
      if (!(w > 0) || !(h > 0)) return -1;
      var ctx = el.getContext('2d', { willReadFrequently: true });
      if (!ctx) return -1;
      var gx0 = Math.max(0, (w - 88) | 0), gy0 = Math.max(0, (h - 40) | 0);
      var ww = Math.min(88, w - gx0), hh = Math.min(40, h - gy0);
      if (ww <= 0 || hh <= 0) return -1;
      var d = ctx.getImageData(gx0, gy0, ww, hh).data;
      var n = 0, total = ww * hh;
      for (var i = 0; i < d.length; i += 16) {
        if (d[i] !== 0 || d[i+1] !== 0 || d[i+2] !== 0) n++;
      }
      return (n * 4) / total;
    } catch (e) { return -1; }
  }
  var out = {
    q2Rect: rectOf(q2),
    glRect: rectOf(glc),
    stageRect: rectOf(stage),
    bezelRect: rectOf(bezel),
    q2Backing: q2 ? { w: q2.width | 0, h: q2.height | 0 } : null,
    q2Style: q2 ? { w: (q2.style && q2.style.width) || '', h: (q2.style && q2.style.height) || '' } : null,
    q2Client: q2 ? { w: q2.clientWidth | 0, h: q2.clientHeight | 0 } : null,
    glBacking: glc ? { w: glc.width | 0, h: glc.height | 0 } : null,
    glStyle: glc ? { w: (glc.style && glc.style.width) || '', h: (glc.style && glc.style.height) || '' } : null,
    dpr: Number(window.devicePixelRatio) || 0,
    vw: window.innerWidth | 0,
    vh: window.innerHeight | 0,
    scrollX: window.scrollX | 0,
    scrollY: window.scrollY | 0,
    scrollH: 0,
    scrollW: 0,
    frames: 0,
    renderer: '',
    centerPx: null,
    armL: null, armR: null, armT: null, armB: null,
    gunFrac: -1,
  };
  try {
    var se = document.scrollingElement;
    out.scrollH = se ? se.scrollHeight | 0 : 0;
    out.scrollW = se ? se.scrollWidth | 0 : 0;
  } catch (e) { /* ignore */ }
  try {
    var st = window.__q2stats;
    out.frames = (st && typeof st.frame === 'number') ? st.frame : 0;
  } catch (e) { /* ignore */ }
  try {
    out.renderer = String((window.__q2soakState && window.__q2soakState().renderer) || '');
  } catch (e) { out.renderer = 'n/a-normal-boot'; }
  if (q2 && q2.width > 0 && q2.height > 0) {
    var cx = (q2.width / 2) | 0, cy = (q2.height / 2) | 0;
    out.centerPx = px2d(q2, cx, cy);
    out.armL = px2d(q2, cx - 4, cy);
    out.armR = px2d(q2, cx + 4, cy);
    out.armT = px2d(q2, cx, cy - 4);
    out.armB = px2d(q2, cx, cy + 4);
    out.gunFrac = gunNonBlack(q2);
  }
  return out;
})()
`;

interface Probe {
  q2Rect: { x: number; y: number; width: number; height: number } | null;
  glRect: { x: number; y: number; width: number; height: number } | null;
  stageRect: { x: number; y: number; width: number; height: number } | null;
  bezelRect: { x: number; y: number; width: number; height: number } | null;
  q2Backing: { w: number; h: number } | null;
  q2Style: { w: string; h: string } | null;
  q2Client: { w: number; h: number } | null;
  glBacking: { w: number; h: number } | null;
  glStyle: { w: string; h: string } | null;
  dpr: number;
  vw: number;
  vh: number;
  scrollX: number;
  scrollY: number;
  scrollH: number;
  scrollW: number;
  frames: number;
  renderer: string;
  centerPx: number[] | null;
  armL: number[] | null;
  armR: number[] | null;
  armT: number[] | null;
  armB: number[] | null;
  gunFrac: number;
}

const LEGS = [
  { w: 640, h: 480, renderer: 'software' },
  { w: 800, h: 600, renderer: 'software' },
  { w: 1024, h: 768, renderer: 'software' },
  { w: 640, h: 480, renderer: 'webgl2-experimental' },
  { w: 800, h: 600, renderer: 'webgl2-experimental' },
  { w: 1024, h: 768, renderer: 'webgl2-experimental' },
] as const;

let viteUrl = '';
let viteProc: ChildProcess | null = null;
let page: CdpPage | null = null;
let pageConsole: string[] = [];
let chromiumProc: ChildProcess | null = null;
const fullscreenNotes: string[] = [];

function outDir(): string {
  const dir = join(repoRoot(), 'apps', 'web', 'test-output');
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  if (!CAN_RUN) return;
  const started = await startVite();
  viteUrl = started.url;
  viteProc = started.proc;
  await waitHttpOk(`${viteUrl}/`, 120000);
  const profile = join(tmpdir(), `q2-resfit-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(profile, { recursive: true });
  const launched = await launchChromium(`${viteUrl}/`, profile);
  chromiumProc = launched.proc;
  const res = await fetch(`http://127.0.0.1:${launched.port}/json/list`);
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`);
  const targets = (await res.json()) as { type?: string; webSocketDebuggerUrl?: string }[];
  const target = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target?.webSocketDebuggerUrl) throw new Error('no page target');
  const connected = await createPage(target.webSocketDebuggerUrl);
  page = connected.page;
  pageConsole = connected.consoleLines;
}, 180000);

afterAll(async () => {
  try {
    page?.close();
  } catch {
    /* x */
  }
  page = null;
  if (chromiumProc) {
    try {
      chromiumProc.kill('SIGTERM');
    } catch {
      /* x */
    }
    chromiumProc = null;
  }
  if (viteProc) {
    try {
      viteProc.kill('SIGTERM');
    } catch {
      /* x */
    }
    viteProc = null;
  }
});

async function runLeg(fbW: number, fbH: number, renderer: string): Promise<Probe> {
  const p = page!;
  const persisted = {
    vid_resolution: `${fbW}x${fbH}`,
    vid_renderer: renderer,
    map_source: 'devroom',
    skill: '1',
  };
  const storeJs = `localStorage.setItem('q2ts.cvars.v1', '${JSON.stringify(persisted).replace(/'/g, "\\'")}'); 'stored'`;
  // The freshly launched (or just reloaded) page may not have committed its
  // document yet — localStorage on the initial empty document throws a
  // SecurityError ("Uncaught") and evaluates during navigation report no
  // execution context. Wait for a committed document first, retrying.
  const readyDeadline = Date.now() + 90000;
  for (;;) {
    try {
      const href = await p.evaluate<string>(`String(window.location.href)`, 15000);
      const state = await p.evaluate<string>(`String(document.readyState)`, 15000);
      if (href.startsWith(viteUrl) && (state === 'complete' || state === 'interactive')) break;
    } catch {
      /* not committed yet */
    }
    if (Date.now() > readyDeadline) throw new Error(`leg ${fbW}x${fbH}/${renderer}: page never reached ready state`);
    await sleep(1000);
  }
  let stored = false;
  const storeDeadline = Date.now() + 60000;
  let lastStoreErr: string = '';
  while (!stored) {
    try {
      await p.evaluate(storeJs, 15000);
      stored = true;
    } catch (e) {
      lastStoreErr = e instanceof Error ? e.message : String(e);
      if (Date.now() > storeDeadline) throw new Error(`leg ${fbW}x${fbH}/${renderer}: localStorage store failed: ${lastStoreErr}`);
      await sleep(1000);
    }
  }
  await p.evaluate(`window.location.reload(); 'navigating'`);
  // Wait for the rebooted loop: backing matches the requested fb and the
  // rAF loop has presented steady-state frames.
  const deadline = Date.now() + 120000;
  let probe: Probe | null = null;
  for (;;) {
    await sleep(1500);
    try {
      probe = await p.evaluate<Probe>(PROBE_JS, 30000);
    } catch {
      probe = null;
    }
    if (probe && probe.q2Backing?.w === fbW && probe.q2Backing?.h === fbH && probe.frames > 30) break;
    if (Date.now() > deadline) {
      throw new Error(
        `leg ${fbW}x${fbH}/${renderer}: boot never settled (backing=${JSON.stringify(probe?.q2Backing)} frames=${probe?.frames})`,
      );
    }
  }
  return probe!;
}

function maxRectDelta(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
}

describe.runIf(CAN_RUN)('RELEASE-3 composed-page geometry (real browser)', () => {
  for (const leg of LEGS) {
    const name = `${leg.w}x${leg.h} ${leg.renderer}`;
    it(`canvas fits the stage, centers align, HUD visible: ${name}`, { timeout: 300000 }, async () => {
      const probe = await runLeg(leg.w, leg.h, leg.renderer);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const tag = `${leg.w}x${leg.h}-${leg.renderer === 'software' ? 'sw' : 'gl'}`;
      // Screenshot artifact (composed page, viewport 1500x1000 @ dpr 1).
      const b64 = await page!.screenshot();
      const shotPath = join(outDir(), `resolution-fit-${stamp}-${tag}.png`);
      writeFileSync(shotPath, Buffer.from(b64, 'base64'));
      const probePath = join(outDir(), `resolution-fit-${stamp}-${tag}.json`);
      writeFileSync(probePath, JSON.stringify({ leg, probe }, null, 2));
      console.log(`[resolution-fit] ${name}: artifacts test-output/resolution-fit-${stamp}-${tag}.{png,json}`);

      // Backing equals the requested framebuffer (no stale size).
      expect(probe.q2Backing).toEqual({ w: leg.w, h: leg.h });
      expect(probe.q2Rect).not.toBeNull();
      const rect = probe.q2Rect!;
      // Displayed box preserves the framebuffer aspect: uniform scale, so
      // the content cannot letterbox inside the element box.
      const aspect = rect.width / Math.max(1, rect.height);
      expect(Math.abs(aspect - leg.w / leg.h)).toBeLessThan(0.02);
      // The whole canvas is inside the viewport: nothing below the fold,
      // no scroll needed to see the bottom HUD (weapon/hp/fps/pos).
      expect(rect.x).toBeGreaterThanOrEqual(-1);
      expect(rect.y).toBeGreaterThanOrEqual(-1);
      expect(rect.x + rect.width).toBeLessThanOrEqual(probe.vw + 1);
      expect(rect.y + rect.height).toBeLessThanOrEqual(probe.vh + 1);
      expect(probe.scrollX).toBe(0);
      expect(probe.scrollY).toBe(0);
      expect(probe.scrollH).toBeLessThanOrEqual(probe.vh + 2);
      expect(probe.dpr).toBe(1);
      expect(probe.vw).toBeGreaterThanOrEqual(1400);
      // Rendered crosshair on the backing center pixel, both backends.
      expect(probe.centerPx).toEqual([255, 255, 255, 255]);
      for (const arm of [probe.armL, probe.armR, probe.armT, probe.armB]) {
        expect(arm).toEqual([136, 136, 136, 255]);
      }
      // 2D gun silhouette present bottom-right (devroom has no pak models).
      expect(probe.gunFrac).toBeGreaterThan(0.02);
      if (leg.renderer === 'webgl2-experimental') {
        // GL overlay shares the identical box: shared center, shared scale.
        expect(probe.glRect).not.toBeNull();
        expect(probe.glBacking).toEqual({ w: leg.w, h: leg.h });
        expect(maxRectDelta(probe.glRect!, rect)).toBeLessThanOrEqual(1);
      } else {
        expect(probe.glRect).toBeNull();
      }
    });
  }

  it('fullscreen keeps the fitted aspect and alignment (1024x768 WebGL2)', { timeout: 300000 }, async () => {
    const probe0 = await runLeg(1024, 768, 'webgl2-experimental');
    expect(probe0.q2Backing).toEqual({ w: 1024, h: 768 });
    const entered = await page!.evaluate<string>(
      `(async () => {
        try {
          var b = document.querySelector('#q2-bezel');
          if (!b || !b.requestFullscreen) return 'no-requestFullscreen';
          await b.requestFullscreen();
          await new Promise(function (r) { setTimeout(r, 1500); });
          return document.fullscreenElement ? 'entered' : 'entry-silently-failed';
        } catch (e) { return 'entry-threw:' + String((e && e.message) || e).slice(0, 120); }
      })()`,
      30000,
    );
    fullscreenNotes.push(entered);
    const probe = await page!.evaluate<Probe>(PROBE_JS, 30000);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(outDir(), `resolution-fit-${stamp}-fullscreen.json`), JSON.stringify({ entered, probe }, null, 2));
    writeFileSync(join(outDir(), `resolution-fit-${stamp}-fullscreen.png`), Buffer.from(await page!.screenshot(), 'base64'));
    console.log(`[resolution-fit] fullscreen attempt: ${entered}`);
    if (entered === 'entered') {
      const rect = probe.q2Rect!;
      expect(Math.abs(rect.width / Math.max(1, rect.height) - 1024 / 768)).toBeLessThan(0.02);
      expect(maxRectDelta(probe.glRect!, rect)).toBeLessThanOrEqual(1);
      expect(probe.centerPx).toEqual([255, 255, 255, 255]);
      await page!.evaluate(`document.exitFullscreen().catch(function () {}); 'exited'`, 30000).catch(() => 'exit-failed');
    } else {
      // Headless may refuse fullscreen: record the outcome, do not fail the
      // card on a harness limitation (viewport/DPR/scroll legs above carry
      // the verdict). The note is kept with the artifacts.
      expect(typeof entered).toBe('string');
    }
  });
});
