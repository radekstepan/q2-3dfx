// @q2/testkit — real-browser harness for PROOF-3 boxes 4-5 (Node-only).
//
// Spawns headless /usr/bin/chromium (real WebGL2 via SwiftShader), serves the
// runtime-generated proof page (gpu-browser-page.ts) plus the BUILT
// production dists, drives the page over CDP with ZERO new npm deps (global
// fetch + global WebSocket on Node 22), and returns compile/draw/coverage
// stats plus end-to-end rAF timings.
//
// DOM-free by construction: imports only node:http, node:child_process,
// node:fs, node:path, node:os, node:url here. NEVER import this module from
// a browser bundle (it would pull node:* into the page).

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// --- Asset + binary gating ---------------------------------------------------

/** Q2_PAK resolution: env first, then the conventional sibling checkout. */
export function resolvePakPath(): string | null {
  const env = process.env.Q2_PAK;
  if (env && env.length > 0) {
    try {
      if (existsSync(env)) return env;
    } catch {
      /* fall through to the sibling probe */
    }
  }
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const cand = join(dir, 'external', 'q2', 'baseq2', 'pak0.pak');
      if (existsSync(cand)) return cand;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* absent */
  }
  return null;
}

/** Chromium binary: $CHROMIUM_BIN override, then the known system path. */
export function chromiumBinaryPath(): string | null {
  const cands: Array<string | undefined> = [process.env.CHROMIUM_BIN, '/usr/bin/chromium'];
  for (const c of cands) {
    if (!c) continue;
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

// --- Minimal pak reader (extraction only; page fetches plain files) ---------

export interface PakEntry {
  name: string;
  offset: number;
  size: number;
}

function readU32LE(bytes: Uint8Array, off: number): number {
  return (
    (bytes[off]! | (bytes[off + 1]! << 8) | (bytes[off + 2]! << 16) | (bytes[off + 3]! << 24)) >>> 0
  );
}

function readAsciiZ(bytes: Uint8Array, off: number, max: number): string {
  let s = '';
  for (let i = 0; i < max; i++) {
    const c = bytes[off + i]!;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Read the pak directory (PACK header + 64-byte entries). */
export function readPakEntries(pakBytes: Uint8Array): PakEntry[] {
  if (pakBytes.length < 12) throw new Error('[gpu-browser] pak too small for a header');
  const magic = readAsciiZ(pakBytes, 0, 4);
  if (magic !== 'PACK') throw new Error('[gpu-browser] bad pak magic: ' + magic);
  const dirOfs = readU32LE(pakBytes, 4);
  const dirLen = readU32LE(pakBytes, 8);
  const out: PakEntry[] = [];
  for (let o = dirOfs; o + 64 <= dirOfs + dirLen && o + 64 <= pakBytes.length; o += 64) {
    const name = readAsciiZ(pakBytes, o, 56).toLowerCase();
    const offset = readU32LE(pakBytes, o + 56);
    const size = readU32LE(pakBytes, o + 60);
    if (name.length > 0) out.push({ name, offset, size });
  }
  return out;
}

const PROOF_FIXED_ASSETS = [
  'maps/base1.bsp',
  'pics/colormap.pcx',
  'models/monsters/soldier/tris.md2',
  'models/monsters/soldier/skin.pcx',
  'models/weapons/v_blast/tris.md2',
  'models/weapons/v_blast/skin.pcx',
];

/**
 * Extract the proof-route asset subset from pak0.pak into outDir (mirrors
 * the pak's relative layout): the six fixed files plus every
 * textures/*.wal. Returns the written relative paths. Throws when a fixed
 * file is missing (fail closed — never render with half an asset set).
 */
export function extractPakAssets(pakPath: string, outDir: string): string[] {
  const pakBytes = readFileSync(pakPath);
  const entries = readPakEntries(pakBytes);
  const byName = new Map<string, PakEntry>();
  for (const e of entries) byName.set(e.name, e);
  const wanted: string[] = [...PROOF_FIXED_ASSETS];
  for (const e of entries) {
    if (e.name.startsWith('textures/') && e.name.endsWith('.wal') && !byName.has(e.name + '.dup')) {
      if (!wanted.includes(e.name)) wanted.push(e.name);
    }
  }
  const missing = PROOF_FIXED_ASSETS.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    throw new Error('[gpu-browser] pak missing required assets: ' + missing.join(', '));
  }
  const written: string[] = [];
  for (const name of wanted) {
    const e = byName.get(name);
    if (!e) continue;
    const slice = pakBytes.subarray(e.offset, e.offset + e.size);
    if (slice.length !== e.size) {
      throw new Error('[gpu-browser] truncated pak entry: ' + name);
    }
    const dest = join(outDir, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, slice);
    written.push(name);
  }
  return written;
}

// --- Static file server ------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.bsp': 'application/octet-stream',
  '.wal': 'application/octet-stream',
  '.md2': 'application/octet-stream',
  '.pcx': 'application/octet-stream',
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : '';
  return MIME[ext] ?? 'application/octet-stream';
}

export interface StaticServer {
  url: string;
  port: number;
  close(): void;
}

function safeJoin(root: string, requestPath: string): string | null {
  const normalized = normalize(join(root, requestPath));
  const rel = relative(root, normalized);
  if (rel === '' || rel.startsWith('..') || rel === '..') return null;
  if (requestPath.includes('\0')) return null;
  return normalized;
}

/**
 * Minimal static file server for one root (path-traversal safe, GET only,
 * 404 otherwise). Used for the generated test dir; see serveProofTestDir
 * for the /lib mount that exposes the built production dists.
 */
export function serveDir(root: string, port = 0): Promise<StaticServer> {
  return serveRoots(root, null, port);
}

function serveRoots(testRoot: string, packagesDir: string | null, port: number): Promise<StaticServer> {
  return new Promise<StaticServer>((resolve, reject) => {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'text/plain' });
          res.end('method not allowed');
          return;
        }
        const raw = (req.url ?? '/').split('?')[0] ?? '/';
        let path: string;
        try {
          path = decodeURIComponent(raw);
        } catch {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('bad url');
          return;
        }
        let file: string | null = null;
        if (packagesDir && (path === '/lib' || path.startsWith('/lib/'))) {
          file = safeJoin(packagesDir, path.slice(4).replace(/^\//, ''));
        } else {
          const rel = path === '/' ? '/page.html' : path;
          file = safeJoin(testRoot, rel.replace(/^\//, '').split('/').join(sep));
        }
        if (!file) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('forbidden');
          return;
        }
        let body: Uint8Array;
        try {
          body = readFileSync(file);
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found: ' + raw);
          return;
        }
        res.writeHead(200, { 'content-type': mimeFor(file) });
        res.end(body);
      } catch (err) {
        try {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('server error');
        } catch {
          /* socket gone */
        }
        void err;
      }
    });
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr.port !== 'number') {
        server.close(() => undefined);
        reject(new Error('[gpu-browser] server.listen did not yield a port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
        close: () => server.close(() => undefined),
      });
    });
  });
}

/**
 * Serve the generated test dir (page.html + /assets/…) with /lib/<pkg>/
 * mounted onto <packagesDir>/<pkg>/dist (built production bundles). The
 * page's import map points at /lib/… URLs.
 */
export function serveProofTestDir(testRoot: string, packagesDir: string): Promise<StaticServer> {
  return serveRoots(testRoot, packagesDir, 0);
}

/** Scratch dir for the generated page + extracted assets. */
export function makeProofScratchDir(): string {
  const dir = join(tmpdir(), `q2-gpu-proof-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// --- Chromium launcher -------------------------------------------------------

export interface ChromiumHandle {
  port: number;
  kill(): void;
}

/**
 * Spawn headless chromium on pageUrl with remote debugging enabled. Parses
 * the DevTools port from stderr. Throws a SKIP-marked error when the binary
 * is absent (callers skip gracefully); any other failure is a real error.
 */
export function launchChromium(pageUrl: string, userDataDir: string): Promise<ChromiumHandle> {
  const bin = chromiumBinaryPath();
  if (!bin) {
    throw new Error(
      '[gpu-browser] SKIP: no chromium binary (tried $CHROMIUM_BIN and /usr/bin/chromium)',
    );
  }
  return new Promise<ChromiumHandle>((resolve, reject) => {
    const args = [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--enable-unsafe-swiftshader',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      pageUrl,
    ];
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      reject(new Error(`[gpu-browser] chromium spawn failed: ${String(err)}`));
      return;
    }
    let stderr = '';
    let settled = false;
    const killTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = (): void => {
      if (killTimer) clearTimeout(killTimer);
    };
    const kill = (): void => {
      cleanup();
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const force = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 8000);
      child.on('exit', () => clearTimeout(force));
    };
    const fail = (msg: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      kill();
      reject(new Error(msg));
    };
    const stderrPipe = child.stderr;
    if (!stderrPipe) {
      fail('[gpu-browser] chromium stderr is not piped (cannot parse DevTools port)');
      return;
    }
    const timeout = setTimeout(() => {
      fail('[gpu-browser] chromium did not print a DevTools port within 30s. stderr tail: ' + stderr.slice(-2000));
    }, 30000);
    stderrPipe.on('data', (chunk: Uint8Array) => {
      if (settled) return;
      stderr += String(chunk);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (m) {
        const portM = /127\.0\.0\.1:(\d+)/.exec(m[1] ?? '');
        if (portM) {
          settled = true;
          clearTimeout(timeout);
          resolve({ port: Number(portM[1]), kill });
        }
      }
    });
    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`[gpu-browser] chromium process error: ${err.message}`));
    });
    child.on('exit', (code: number | null) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(
          new Error(`[gpu-browser] chromium exited early (code ${code}). stderr tail: ${stderr.slice(-2000)}`),
        );
      }
    });
  });
}

// --- Minimal CDP client (global fetch + global WebSocket, no deps) -----------

interface CdpEnvelope {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

function asEnvelope(u: unknown): CdpEnvelope | null {
  if (typeof u !== 'object' || u === null) return null;
  return u as CdpEnvelope;
}

function consoleArgText(arg: unknown): string {
  if (typeof arg !== 'object' || arg === null) return String(arg);
  const a = arg as { value?: unknown; description?: unknown; type?: unknown };
  if (a.value !== undefined) {
    try {
      return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
    } catch {
      return String(a.value);
    }
  }
  if (typeof a.description === 'string') return a.description;
  return String(a.type ?? '?');
}

/** Base64 (standard alphabet) → bytes. No Buffer dependency. */
export function base64ToBytes(s: string): Uint8Array {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const rev = new Map<string, number>();
  for (let i = 0; i < alpha.length; i++) rev.set(alpha[i]!, i);
  const clean = s.replace(/\s+/g, '');
  if (clean.length % 4 !== 0) throw new Error('[gpu-browser] bad base64 length');
  let pad = 0;
  if (clean.endsWith('==')) pad = 2;
  else if (clean.endsWith('=')) pad = 1;
  const out = new Uint8Array(((clean.length / 4) | 0) * 3 - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = rev.get(clean[i]!) ?? 0;
    const b = rev.get(clean[i + 1]!) ?? 0;
    const c = clean[i + 2] === '=' ? 0 : (rev.get(clean[i + 2]!) ?? 0);
    const d = clean[i + 3] === '=' ? 0 : (rev.get(clean[i + 3]!) ?? 0);
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

export interface CdpConnection {
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
  screenshot(timeoutMs?: number): Promise<Uint8Array>;
  consoleLines(): string[];
  /**
   * In-flight CDP calls (method + age at call time): pool-state evidence for
   * triage. A transport timeout with an empty pool + clean console is a
   * wedged page; a busy pool under parallel-suite load is contention.
   */
  pendingCalls(): Array<{ method: string; elapsedMs: number }>;
  /** Last completed CDP call (method + round-trip): slow-transport signal. */
  lastCompletedCall(): { method: string; durationMs: number } | null;
  close(): Promise<void>;
}

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Connect to the first type=page target on the DevTools HTTP endpoint and
 * open its debugger WebSocket. Enables Runtime + Page domains.
 */
export function connectCdp(devtoolsPort: number, timeoutMs = 20000): Promise<CdpConnection> {
  return (async (): Promise<CdpConnection> => {
    const res = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`);
    if (!res.ok) throw new Error(`[gpu-browser] /json/list HTTP ${res.status}`);
    const targets = (await res.json()) as Array<{
      type?: string;
      url?: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page || !page.webSocketDebuggerUrl) {
      throw new Error('[gpu-browser] no type=page target with a debugger URL');
    }
    return openCdpSocket(page.webSocketDebuggerUrl, timeoutMs);
  })();
}

function openCdpSocket(wsUrl: string, timeoutMs: number): Promise<CdpConnection> {
  return new Promise<CdpConnection>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const lines: string[] = [];
    const pending = new Map<number, PendingCall>();
    const inflight = new Map<number, { method: string; started: number }>();
    let lastCompleted: { method: string; durationMs: number } | null = null;
    let nextId = 1;
    let open = false;
    let closed = false;

    const poolState = (): string => {
      const now = Date.now();
      const waiting = [...inflight.values()].map(
        (c) => `${c.method}+${now - c.started}ms`,
      );
      const last = lastCompleted ? `${lastCompleted.method} ${lastCompleted.durationMs}ms` : 'none';
      return `pool=[${waiting.join(', ') || 'idle'}] last=${last}`;
    };

    const send = (method: string, params: Record<string, unknown>, callTimeout: number): Promise<Record<string, unknown>> => {
      return new Promise<Record<string, unknown>>((res, rej) => {
        if (closed) {
          rej(new Error('[gpu-browser] CDP socket closed'));
          return;
        }
        const id = nextId++;
        const started = Date.now();
        const timer = setTimeout(() => {
          pending.delete(id);
          inflight.delete(id);
          rej(new Error(`[gpu-browser] CDP timeout: ${method} after ${callTimeout}ms (${poolState()})`));
        }, callTimeout);
        pending.set(id, { resolve: res, reject: rej, timer });
        inflight.set(id, { method, started });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (err) {
          pending.delete(id);
          inflight.delete(id);
          clearTimeout(timer);
          rej(new Error(`[gpu-browser] CDP send failed: ${String(err)}`));
        }
      });
    };

    const finish = (err: Error | null): void => {
      if (closed) return;
      closed = true;
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(err ?? new Error('[gpu-browser] CDP socket closed'));
      }
      pending.clear();
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };

    const openTimer = setTimeout(() => {
      finish(new Error('[gpu-browser] CDP socket open timeout'));
      reject(new Error('[gpu-browser] CDP socket open timeout'));
    }, timeoutMs);

    ws.onopen = () => {
      if (closed) return;
      open = true;
      clearTimeout(openTimer);
      void (async () => {
        try {
          await send('Runtime.enable', {}, timeoutMs);
          await send('Page.enable', {}, timeoutMs);
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        const conn: CdpConnection = {
          evaluate: async <T>(expression: string, callTimeout = 240000): Promise<T> => {
            const started = Date.now();
            try {
              const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, callTimeout);
              const ex = r['exceptionDetails'] as { text?: string; exception?: { description?: string } } | undefined;
              if (ex) {
                throw new Error('[gpu-browser] page evaluate threw: ' + (ex.text ?? ex.exception?.description ?? 'unknown'));
              }
              const result = r['result'] as { value?: unknown } | undefined;
              return (result?.value ?? null) as T;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              // Page errors (exceptionDetails above) fail loudly as-is: they
              // are code-defect evidence. Transport faults get the harness
              // state needed to tell contention from a wedged page: the CDP
              // call head, pool state, elapsed, and the page console tail.
              if (msg.includes('page evaluate threw') || msg.includes('CDP error')) throw err;
              const head = expression.length > 160 ? expression.slice(0, 160) + '...' : expression;
              const tail = lines.slice(-3).join(' | ') || 'no-console-yet';
              throw new Error(
                `${msg} | expr=${head} | elapsed=${Date.now() - started}ms | ${poolState()} | consoleTail=${tail}`,
              );
            }
          },
          screenshot: async (callTimeout = 60000): Promise<Uint8Array> => {
            const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true }, callTimeout);
            const data = r['data'];
            if (typeof data !== 'string') throw new Error('[gpu-browser] screenshot returned no data');
            return base64ToBytes(data);
          },
          consoleLines: () => [...lines],
          pendingCalls: () => {
            const now = Date.now();
            return [...inflight.values()].map((c) => ({ method: c.method, elapsedMs: now - c.started }));
          },
          lastCompletedCall: () => (lastCompleted ? { ...lastCompleted } : null),
          close: () => {
            finish(null);
            return Promise.resolve();
          },
        };
        resolve(conn);
      })();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const env = asEnvelope(msg);
      if (!env) return;
      if (typeof env.id === 'number' && pending.has(env.id)) {
        const p = pending.get(env.id)!;
        pending.delete(env.id);
        const started = inflight.get(env.id);
        inflight.delete(env.id);
        clearTimeout(p.timer);
        if (started) {
          lastCompleted = { method: started.method, durationMs: Date.now() - started.started };
        }
        if (env.error) p.reject(new Error('[gpu-browser] CDP error: ' + (env.error.message ?? 'unknown')));
        else p.resolve(env.result ?? {});
        return;
      }
      if (env.method === 'Runtime.consoleAPICalled') {
        const params = (env.params ?? {}) as { type?: string; args?: unknown[] };
        const text = (params.args ?? []).map(consoleArgText).join(' ');
        lines.push(`[console.${params.type ?? 'log'}] ${text}`);
      } else if (env.method === 'Runtime.exceptionThrown') {
        const params = (env.params ?? {}) as { exceptionDetails?: { text?: string } };
        lines.push(`[exception] ${params.exceptionDetails?.text ?? 'unknown'}`);
      }
    };
    ws.onerror = () => {
      if (!open && !closed) {
        clearTimeout(openTimer);
        closed = true;
        reject(new Error('[gpu-browser] CDP socket error before open'));
      }
    };
    ws.onclose = () => {
      finish(new Error('[gpu-browser] CDP socket closed'));
    };
  });
}

/**
 * Poll until window.__q2proof.done is true. Resolves with the full proof
 * object (returnByValue). Throws on timeout or on a page-side error — the
 * page always sets proof.error before done on failure paths.
 */
export async function waitForProofDone<T>(cdp: CdpConnection, timeoutMs: number): Promise<T> {
  const start = Date.now();
  let polls = 0;
  for (;;) {
    polls++;
    const done = await cdp.evaluate<boolean>(
      '!!(window.__q2proof && window.__q2proof.done)',
      30000,
    );
    if (done) break;
    if (Date.now() - start > timeoutMs) {
      const tail = cdp.consoleLines().slice(-5).join(' | ') || 'no-console-yet';
      const pending = cdp.pendingCalls().map((c) => `${c.method}+${c.elapsedMs}ms`).join(', ') || 'idle';
      const last = cdp.lastCompletedCall();
      throw new Error(
        `[gpu-browser] proof page did not finish within ${timeoutMs}ms ` +
        `(polls=${polls} pool=[${pending}] last=${last ? `${last.method} ${last.durationMs}ms` : 'none'} consoleTail=${tail})`,
      );
    }
    await new Promise<void>((r) => setTimeout(r, 2000));
  }
  return cdp.evaluate<T>('window.__q2proof', 60000);
}
