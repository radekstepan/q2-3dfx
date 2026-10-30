// GPU-PROOF-5 browser soak runner (MEASUREMENT ONLY).
//
// Launches headless Chromium per leg (hardware GL flags parameterized and
// RECORDED — never assumed), serves the built web page via the repo's vite
// dev server + the Q2 pak via a tiny CORS/CORP file server, boots base1 at
// 640x480 through `apps/web` soak mode (?q2soak=1), then warms up (>=15s) and
// runs >=5 minutes TOTAL across stationary / movement / combat intervals
// with separately reported samples.
//
// Input is scripted from CDP key events only (KeyW/arrows/strafe + attack via
// the page's Mouse0 keydown path, verified through the __q2soakState echo).
// 1 Hz sampling of __q2stats + performance.memory + CDP Performance metrics,
// per-interval screenshots, GL_RENDERER capture, refresh/vsync probing.
//
// Legs: software (SwiftShader CPU default baseline), webgl2-experimental
// (hardware GL gate leg), optional voodoo CPU leg (GPU_SOAK_LEGS).
// CPU legs import via the existing importBrowserSoak; the GPU leg is
// validated with validateGpuProofBrowserRecord + formatGpuProofGateReport.
// Software-emulated numbers are NEVER presented as a gate pass.
//
// Env:
//   Q2_PAK (required — skip otherwise), CHROMIUM_BIN (default /usr/bin/chromium),
//   GPU_SOAK_LEGS (default 'software,webgl2-experimental'; add ',voodoo'),
//   GPU_SOAK_WARMUP_S (default 20), GPU_SOAK_INTERVAL_S (default 100),
//   GPU_SOAK_OUT (default tools/bench/evidence/raw),
//   GPU_SOAK_VITE_PORT (default 5191), GPU_SOAK_LOG (default <out>/gpu-soak-<stamp>.log).
//
// Total runtime ~20-40 min (soaks are long — run in background, log to file).
// Exit 0 = all legs measured; exit 2 = SKIP (no pak / no chromium); exit 1 = error.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { accessSync, constants, createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const EVIDENCE_DIR = join(REPO, 'tools', 'bench', 'evidence');
const OUT_DIR = process.env.GPU_SOAK_OUT ?? join(EVIDENCE_DIR, 'raw');
const Q2_PAK = process.env.Q2_PAK ?? '';
const CHROMIUM_BIN = process.env.CHROMIUM_BIN ?? '/usr/bin/chromium';
const LEGS = (process.env.GPU_SOAK_LEGS ?? 'software,webgl2-experimental').split(',').map((s) => s.trim()).filter(Boolean);
const WARMUP_S = Number(process.env.GPU_SOAK_WARMUP_S ?? 20);
const INTERVAL_S = Number(process.env.GPU_SOAK_INTERVAL_S ?? 100);
const VITE_PORT = Number(process.env.GPU_SOAK_VITE_PORT ?? 5191);
// Unthrottled rAF (measurement only): removes the headless 60Hz BeginFrames
// cap so intervals measure actual frame WORK instead of the cap quantum.
// The gate's cadence clause still needs a real vsync display to verify;
// unthrottled numbers establish work headroom, never a cadence pass.
const UNTHROTTLED = process.env.GPU_SOAK_UNTHROTTLED === '1';
const UNTHROTTLED_FLAGS = ['--disable-frame-rate-limit', '--disable-gpu-vsync'];

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
const STAMP = stamp();
const LOG_PATH = process.env.GPU_SOAK_LOG ?? join(OUT_DIR, `gpu-soak-${STAMP}.log`);
mkdirSync(OUT_DIR, { recursive: true });

const logLines = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logLines.push(line);
  try {
    writeFileSync(LOG_PATH, logLines.join('\n') + '\n');
  } catch { /* logging best-effort */ }
}

function fail(msg) {
  log(`FATAL: ${msg}`);
  process.exit(1);
}

// --- Preconditions: Q2_PAK + chromium (skip otherwise) -----------------------

if (!Q2_PAK) {
  console.log('SKIP: Q2_PAK required (pak-gated soak, no assets to measure).');
  process.exit(2);
}
let pakStat = null;
try {
  pakStat = statSync(Q2_PAK);
} catch {
  console.log(`SKIP: Q2_PAK not found: ${Q2_PAK}`);
  process.exit(2);
}
try {
  accessSync(CHROMIUM_BIN, constants.X_OK);
} catch {
  console.log(`SKIP: no chromium binary (tried $CHROMIUM_BIN and ${CHROMIUM_BIN}).`);
  process.exit(2);
}
log(`pak: ${Q2_PAK} (${pakStat.size} bytes)`);
log(`chromium: ${CHROMIUM_BIN}`);
log(`legs: ${LEGS.join(',')} warmup=${WARMUP_S}s interval=${INTERVAL_S}s`);

// --- Pinned fidelity cvars (GPU-PROOF-1 contract §2, duplicated by value) ----

const SOAK_CVARS = [
  'vd_gamma:1.3', 'vd_dither:1', 'vd_16bit:1', 'vd_postfilter:1',
  'vd_bilinear:1', 'vd_mipdither:1', 'vd_lodbias:-0.35', 'vd_fog:1',
  'vd_overbright:1', 'vd_palettetex:1', 'vd_maxtexsize:256', 'vd_zbits:16',
  'vd_dithermode:4x4', 'vd_reconmode:2x2sub+2x2box', 'vd_rgbmaxdelta:8,8,8',
].join(';');

// --- Child-process hygiene (no orphans) --------------------------------------

const children = new Set();
function track(child) {
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
async function killChild(child, name) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGTERM'); } catch { /* gone */ }
  const exited = await Promise.race([
    new Promise((res) => child.on('exit', () => res(true))),
    new Promise((res) => setTimeout(() => res(false), 8000)),
  ]);
  if (!exited) {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    await new Promise((res) => {
      child.on('exit', () => res(undefined));
      setTimeout(() => res(undefined), 5000);
    });
  }
  log(`${name}: reaped (exit=${child.exitCode} sig=${child.signalCode})`);
}
process.on('SIGINT', () => { log('SIGINT: reaping children'); void Promise.all([...children].map((c) => killChild(c, 'child'))).then(() => process.exit(130)); });
process.on('SIGTERM', () => { log('SIGTERM: reaping children'); void Promise.all([...children].map((c) => killChild(c, 'child'))).then(() => process.exit(143)); });

// --- Servers: vite (app) + pak bytes -----------------------------------------

function viteBin() {
  const cands = [join(REPO, 'node_modules', '.bin', 'vite'), join(REPO, 'apps', 'web', 'node_modules', '.bin', 'vite')];
  for (const c of cands) {
    try { accessSync(c, constants.X_OK); return c; } catch { /* next */ }
  }
  return null;
}

async function waitHttpOk(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) { log(`${label} ready: ${url}`); return; }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`${label} not ready within ${timeoutMs}ms: ${url}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function startPakServer() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = (req.url ?? '/').split('?')[0];
        if (url !== '/pak0.pak') { res.writeHead(404); res.end('not found'); return; }
        const st = statSync(Q2_PAK);
        const range = req.headers.range;
        const base = {
          'content-type': 'application/octet-stream',
          'access-control-allow-origin': '*',
          'cross-origin-resource-policy': 'cross-origin',
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
        };
        if (req.method === 'OPTIONS') { res.writeHead(204, base); res.end(); return; }
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          let start = m && m[1] ? Number(m[1]) : 0;
          let end = m && m[2] ? Number(m[2]) : st.size - 1;
          if (!Number.isFinite(start) || start < 0) start = 0;
          if (!Number.isFinite(end) || end >= st.size) end = st.size - 1;
          res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': String(end - start + 1) });
          createReadStream(Q2_PAK, { start, end }).pipe(res);
          return;
        }
        res.writeHead(200, { ...base, 'content-length': String(st.size) });
        if (req.method === 'HEAD') { res.end(); return; }
        createReadStream(Q2_PAK).pipe(res);
      } catch (e) {
        try { res.writeHead(500); res.end(String(e)); } catch { /* socket gone */ }
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr.port !== 'number') { server.close(); reject(new Error('pak server: no port')); return; }
      resolvePromise({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

// --- Minimal CDP client (global fetch + WebSocket, no new deps) ---------------

function createCdp(wsUrl, consoleCap = 800) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const consoleLines = [];
    let nextId = 1;
    let closed = false;
    const send = (method, params, timeoutMs) => new Promise((res, rej) => {
      if (closed) { rej(new Error('CDP closed')); return; }
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method} after ${timeoutMs}ms`)); }, timeoutMs);
      pending.set(id, { res, rej, timer });
      try { ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { pending.delete(id); clearTimeout(timer); rej(e); }
    });
    const openTimer = setTimeout(() => { try { ws.close(); } catch { /* x */ } reject(new Error('CDP socket open timeout')); }, 20000);
    ws.onopen = () => {
      clearTimeout(openTimer);
      const conn = {
        send,
        evaluate: async (expression, timeoutMs = 60000) => {
          const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
          if (r.exceptionDetails) throw new Error('page evaluate threw: ' + (r.exceptionDetails.text ?? r.exceptionDetails.exception?.description ?? 'unknown'));
          return r.result?.value ?? null;
        },
        keyEvent: (type, keyParams, timeoutMs = 15000) =>
          send('Input.dispatchKeyEvent', { type, autoRepeat: false, ...keyParams }, timeoutMs),
        mouseEvent: (type, p, timeoutMs = 15000) =>
          send('Input.dispatchMouseEvent', { type, x: 320, y: 240, button: 'left', clickCount: 1, ...p }, timeoutMs),
        metrics: async (timeoutMs = 15000) => {
          const r = await send('Performance.getMetrics', {}, timeoutMs);
          const out = {};
          for (const m of r.metrics ?? []) out[m.name] = m.value;
          return out;
        },
        screenshot: async (timeoutMs = 60000) => {
          const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true }, timeoutMs);
          if (typeof r.data !== 'string') throw new Error('screenshot: no data');
          return r.data;
        },
        consoleLines: () => [...consoleLines],
        close: async () => { closed = true; for (const [, p] of pending) { clearTimeout(p.timer); p.rej(new Error('CDP closed')); } pending.clear(); try { ws.close(); } catch { /* x */ } },
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.rej(new Error('CDP error: ' + (msg.error.message ?? 'unknown')));
          else p.res(msg.result ?? {});
          return;
        }
        if (msg.method === 'Runtime.consoleAPICalled') {
          const args = msg.params?.args ?? [];
          const text = args.map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description ?? String(a.type ?? '?')))).join(' ');
          if (consoleLines.length < consoleCap) consoleLines.push(`[console.${msg.params?.type ?? 'log'}] ${text}`);
        } else if (msg.method === 'Runtime.exceptionThrown') {
          if (consoleLines.length < consoleCap) consoleLines.push(`[exception] ${msg.params?.exceptionDetails?.text ?? 'unknown'}`);
        }
      };
      ws.onerror = () => { if (!closed) { /* open-phase errors surface via onclose */ } };
      ws.onclose = () => { closed = true; for (const [, p] of pending) { clearTimeout(p.timer); p.rej(new Error('CDP socket closed')); } pending.clear(); };
      void (async () => {
        try {
          await send('Runtime.enable', {}, 20000);
          await send('Page.enable', {}, 20000);
          try { await send('Performance.enable', {}, 10000); } catch { /* metrics best-effort */ }
          resolvePromise(conn);
        } catch (e) { reject(e); }
      })();
    };
    ws.onerror = () => { clearTimeout(openTimer); reject(new Error('CDP socket error before open')); };
  });
}

async function connectCdp(devtoolsPort) {
  const res = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`);
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no type=page target with a debugger URL');
  return createCdp(page.webSocketDebuggerUrl);
}

function launchChromium(pageUrl, extraFlags) {
  return new Promise((resolvePromise, reject) => {
    const userDataDir = join(tmpdir(), `q2-gpu-soak-${STAMP}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(userDataDir, { recursive: true });
    const args = [
      '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--mute-audio',
      '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
      '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
      ...extraFlags, pageUrl,
    ];
    log(`chromium flags: ${extraFlags.join(' ')}`);
    let child;
    try {
      child = track(spawn(CHROMIUM_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] }));
    } catch (e) { reject(new Error('chromium spawn failed: ' + String(e))); return; }
    let stderr = '';
    let settled = false;
    const kill = () => killChild(child, 'chromium');
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; void kill().then(() => reject(new Error('chromium: no DevTools port within 30s. tail: ' + stderr.slice(-2000)))); }
    }, 30000);
    child.stderr.on('data', (chunk) => {
      if (settled) return;
      stderr += String(chunk);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (m) {
        const portM = /127\.0\.0\.1:(\d+)/.exec(m[1] ?? '');
        if (portM) {
          settled = true;
          clearTimeout(timeout);
          resolvePromise({ port: Number(portM[1]), userDataDir, kill, child });
        }
      }
    });
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timeout); reject(new Error('chromium process error: ' + e.message)); } });
    child.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(`chromium exited early (code ${code}). tail: ${stderr.slice(-2000)}`)); } });
  });
}

// --- Input scripting (CDP key events only — never page code) ------------------

const KEY_W = { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 };
const KEY_A = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 };
const KEY_D = { key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68 };
const ARROW_LEFT = { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 };
const ARROW_RIGHT = { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 };

async function keyDown(cdp, k) { await cdp.keyEvent('keyDown', k); }
async function keyUp(cdp, k) { await cdp.keyEvent('keyUp', k); }
async function allUp(cdp) {
  for (const k of [KEY_W, KEY_A, KEY_D, ARROW_LEFT, ARROW_RIGHT]) {
    try { await keyUp(cdp, k); } catch { /* release best-effort */ }
  }
}

/**
 * Probe the attack path: the page maps e.code==='Mouse0' keydown → attack
 * (no pointer lock needed). Falls back to pointer-lock + CDP mouse press.
 * Returns the working method ('key-Mouse0' | 'locked-mouse') or throws.
 */
async function probeAttack(cdp) {
  const stateExpr = 'window.__q2soakState ? window.__q2soakState().buttons : -1';
  // Candidate 1: CDP key event with code Mouse0.
  try {
    await cdp.keyEvent('rawKeyDown', { key: 'Unidentified', code: 'Mouse0', windowsVirtualKeyCode: 0 });
    await new Promise((r) => setTimeout(r, 800));
    const b = await cdp.evaluate(stateExpr, 15000);
    await cdp.keyEvent('rawKeyUp', { key: 'Unidentified', code: 'Mouse0', windowsVirtualKeyCode: 0 }).catch(() => undefined);
    if (typeof b === 'number' && (b & 1) === 1) return 'key-Mouse0';
  } catch { /* next candidate */ }
  // Candidate 2: pointer lock + CDP mouse press.
  try {
    await cdp.evaluate(`(function(){var c=document.querySelector('#q2');if(c&&c.requestPointerLock)c.requestPointerLock();return !!document.pointerLockElement;})()`, 15000);
    await new Promise((r) => setTimeout(r, 800));
    await cdp.mouseEvent('mousePressed', {});
    await new Promise((r) => setTimeout(r, 800));
    const b = await cdp.evaluate(stateExpr, 15000);
    await cdp.mouseEvent('mouseReleased', {}).catch(() => undefined);
    if (typeof b === 'number' && (b & 1) === 1) return 'locked-mouse';
  } catch { /* fall through */ }
  throw new Error('attack path unverified: neither key-Mouse0 nor locked-mouse set BUTTON_ATTACK');
}

async function attackDown(cdp, method) {
  if (method === 'key-Mouse0') await cdp.keyEvent('rawKeyDown', { key: 'Unidentified', code: 'Mouse0', windowsVirtualKeyCode: 0 });
  else await cdp.mouseEvent('mousePressed', {});
}
async function attackUp(cdp, method) {
  try {
    if (method === 'key-Mouse0') await cdp.keyEvent('rawKeyUp', { key: 'Unidentified', code: 'Mouse0', windowsVirtualKeyCode: 0 });
    else await cdp.mouseEvent('mouseReleased', {});
  } catch { /* release best-effort */ }
}

// --- Leg runner -----------------------------------------------------------------

function chromiumVersion() {
  try {
    return execSync(`"${CHROMIUM_BIN}" --version`, { encoding: 'utf8' }).trim();
  } catch {
    return `${CHROMIUM_BIN} (version unknown)`;
  }
}
function gitInfo() {
  const rev = (args) => { try { return execSync(`git ${args}`, { encoding: 'utf8', cwd: REPO }).trim(); } catch { return 'unknown'; } };
  return { short: rev('rev-parse --short HEAD'), full: rev('rev-parse HEAD'), dirty: rev('status --porcelain').length > 0 };
}

async function runLeg(ctx, renderer) {
  const isGpu = renderer === 'webgl2-experimental';
  const flags = [
    ...(isGpu
      ? ['--use-angle=gl-egl']
      : ['--disable-gpu', '--enable-unsafe-swiftshader']),
    ...(UNTHROTTLED ? UNTHROTTLED_FLAGS : []),
  ];
  const pageUrl = `${ctx.viteUrl}/?q2soak=1&q2pak=${encodeURIComponent(`${ctx.pakUrl}/pak0.pak`)}&q2renderer=${renderer}&q2cvars=${encodeURIComponent(SOAK_CVARS)}`;
  log(`leg ${renderer}: navigating`);
  const launched = await launchChromium(pageUrl, flags);
  let cdp = null;
  const legErrors = [];
  try {
    cdp = await connectCdp(launched.port);
    // Wait for soak boot (pak fetch 184MB + base1 parse under SwiftShader can be slow).
    const bootDeadline = Date.now() + 240000;
    let status = null;
    for (;;) {
      try {
        status = await cdp.evaluate(`window.__q2soak ? window.__q2soak : null`, 30000);
      } catch (e) { status = null; }
      if (status && status.booted) break;
      if (status && status.error) throw new Error(`page boot error: ${status.error}`);
      if (Date.now() > bootDeadline) throw new Error('soak boot timeout (240s): __q2soak.booted never true');
      await new Promise((r) => setTimeout(r, 2000));
    }
    log(`leg ${renderer}: booted actual=${status.actualRenderer} warning=${status.warning} gl=${status.glRenderer}`);
    const cvarSnap = await cdp.evaluate('window.__q2soakCvars ? window.__q2soakCvars() : null', 15000);
    const state0 = await cdp.evaluate('window.__q2soakState ? window.__q2soakState() : null', 15000);
    if (state0 && (state0.renderer !== renderer || state0.warning)) {
      log(`leg ${renderer}: NOTE state renderer=${state0.renderer} warning=${state0.warning} gpuActive=${state0.gpuActive}`);
    }
    // Refresh/vsync probe: 3s rAF timestamp capture → effective BeginFrames rate.
    const rafProbe = await cdp.evaluate(
      `new Promise((res)=>{const t=[];const f=()=>{t.push(performance.now());if(t.length<240)requestAnimationFrame(f);else res(t);};requestAnimationFrame(f);})`,
      30000,
    );
    // Input-path verification (once per leg, before warmup).
    await keyDown(cdp, KEY_W);
    await new Promise((r) => setTimeout(r, 1500));
    const moveState = await cdp.evaluate('window.__q2soakState ? window.__q2soakState() : null', 15000);
    await keyUp(cdp, KEY_W);
    const moveOk = !!moveState && Array.isArray(moveState.keys) && moveState.keys.includes('forward');
    log(`leg ${renderer}: movement echo forward=${moveOk} (keys=${moveState ? moveState.keys.join(',') : 'n/a'})`);
    if (!moveOk) legErrors.push('movement key echo failed (KeyW did not register)');
    let attackMethod = 'unverified';
    try {
      attackMethod = await probeAttack(cdp);
      log(`leg ${renderer}: attack method = ${attackMethod}`);
    } catch (e) {
      legErrors.push(String(e.message ?? e));
      log(`leg ${renderer}: ATTACK PROBE FAILED: ${String(e.message ?? e)}`);
    }
    // Warmup (>=15s): verify frames advance.
    const frameA = await cdp.evaluate(`window.__q2stats ? window.__q2stats.frame : -1`, 15000);
    await new Promise((r) => setTimeout(r, WARMUP_S * 1000));
    const frameB = await cdp.evaluate(`window.__q2stats ? window.__q2stats.frame : -1`, 15000);
    log(`leg ${renderer}: warmup frames ${frameA} -> ${frameB} over ${WARMUP_S}s`);
    if (!(frameB > frameA)) throw new Error(`warmup stall: frames ${frameA} -> ${frameB} (loop not advancing)`);

    // Intervals: stationary (no input), movement, combat.
    const intervals = [];
    const plan = ['stationary', 'moving', 'combat'];
    for (const name of plan) {
      log(`leg ${renderer}: interval ${name} (${INTERVAL_S}s)`);
      const idxStart = await cdp.evaluate('window.__q2soakFrames ? window.__q2soakFrames.length : -1', 15000);
      const fStart = await cdp.evaluate('window.__q2stats ? window.__q2stats.frame : -1', 15000);
      const t0 = Date.now();
      const samples = [];
      const tEnd = t0 + INTERVAL_S * 1000;
      let turnPhase = 0;
      if (name === 'moving') await keyDown(cdp, KEY_W);
      if (name === 'combat') { await keyDown(cdp, KEY_W); if (attackMethod !== 'unverified') await attackDown(cdp, attackMethod); }
      const stateStart = await cdp.evaluate('window.__q2soakState ? window.__q2soakState() : null', 15000).catch(() => null);
      try {
        while (Date.now() < tEnd) {
          const elapsed = (Date.now() - t0) / 1000;
          // Scripted sub-patterns (CDP key events only).
          if (name === 'moving') {
            const phase = Math.floor(elapsed / 10) % 5;
            if (phase !== turnPhase) {
              turnPhase = phase;
              await allUp(cdp).catch(() => undefined);
              await keyDown(cdp, KEY_W).catch(() => undefined);
              if (phase === 1) await keyDown(cdp, ARROW_LEFT).catch(() => undefined);
              if (phase === 2) await keyDown(cdp, ARROW_RIGHT).catch(() => undefined);
              if (phase === 3) await keyDown(cdp, KEY_A).catch(() => undefined);
              if (phase === 4) await keyDown(cdp, KEY_D).catch(() => undefined);
            }
          } else if (name === 'combat') {
            const phase = Math.floor(elapsed / 15) % 2;
            if (phase !== turnPhase) {
              turnPhase = phase;
              try {
                await keyUp(cdp, ARROW_LEFT); await keyUp(cdp, ARROW_RIGHT);
                await keyDown(cdp, phase === 0 ? ARROW_LEFT : ARROW_RIGHT);
              } catch { /* keep firing */ }
            }
          }
          const sample = await cdp.evaluate(
            `(function(){var s=null;try{s=window.__q2stats?{frame:window.__q2stats.frame,fps:window.__q2stats.fps,rgbKicks:window.__q2stats.rgbKicks,rgbInline:window.__q2stats.rgbInline,fallbacks:window.__q2stats.rgbFallbacks}:null;}catch(e){}var m=-1;try{if(performance.memory)m=performance.memory.usedJSHeapSize;}catch(e){}var inp=null;try{if(window.__q2soakState){var st=window.__q2soakState();inp={keys:st.keys,buttons:st.buttons};}}catch(e){}return {stats:s,mem:m,t:performance.now(),input:inp};})()`,
            15000,
          ).catch((e) => ({ sampleError: String(e.message ?? e) }));
          let metrics = null;
          try { metrics = await cdp.metrics(10000); } catch { /* best-effort */ }
          samples.push({ wallMs: Date.now(), ...sample, metrics });
          const remain = tEnd - Date.now();
          if (remain > 0) await new Promise((r) => setTimeout(r, Math.min(1000, remain)));
        }
      } finally {
        await allUp(cdp).catch(() => undefined);
        if (name === 'combat' && attackMethod !== 'unverified') await attackUp(cdp, attackMethod).catch(() => undefined);
      }
      const durS = (Date.now() - t0) / 1000;
      const fEnd = await cdp.evaluate('window.__q2stats ? window.__q2stats.frame : -1', 15000);
      const idxEnd = await cdp.evaluate('window.__q2soakFrames ? window.__q2soakFrames.length : -1', 15000);
      let frameSlice = [];
      try {
        frameSlice = await cdp.evaluate(`window.__q2soakFrames ? window.__q2soakFrames.slice(${Math.max(0, idxStart)}, ${Math.max(0, idxEnd)}) : []`, 60000);
      } catch (e) { legErrors.push(`interval ${name}: frame ring slice failed: ${String(e.message ?? e)}`); }
      const stateEnd = await cdp.evaluate('window.__q2soakState ? window.__q2soakState() : null', 15000).catch(() => null);
      let shotB64 = null;
      try { shotB64 = await cdp.screenshot(60000); } catch (e) { legErrors.push(`interval ${name}: screenshot failed: ${String(e.message ?? e)}`); }
      const shotPath = shotB64 ? join(OUT_DIR, `gpu-soak-${STAMP}-${renderer}-${name}.png`) : null;
      if (shotB64 && shotPath) {
        try { writeFileSync(shotPath, Buffer.from(shotB64, 'base64')); } catch (e) { legErrors.push(`interval ${name}: screenshot write failed: ${String(e)}`); }
      }
      intervals.push({
        name, durationS: durS, samples,
        frameStart: fStart, frameEnd: fEnd,
        frameStamps: frameSlice,
        stateStart, stateEnd,
        screenshot: shotPath,
      });
      log(`leg ${renderer}: interval ${name} done frames ${fStart}->${fEnd} over ${durS.toFixed(1)}s samples=${samples.length}`);
    }
    const consoleLines = cdp.consoleLines();
    return { renderer, isGpu, status, cvarSnap, intervals, consoleLines, legErrors, rafProbe, attackMethod, moveOk };
  } finally {
    try { if (cdp) await cdp.close(); } catch { /* x */ }
    await launched.kill();
    try {
      const { rmSync } = await import('node:fs');
      rmSync(launched.userDataDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
}

// --- Main ----------------------------------------------------------------------

const lib = await import('./dist/index.mjs').catch((e) => fail(`bench dist import failed (run 'yarn workspace bench build' first): ${String(e.message ?? e)}`));
const {
  buildSoakRecord, buildGpuProofRecord, summarizeFrameTimes, frameIntervals,
  cadenceFps, countDroppedBeats, classifyCompositor,
  validateGpuProofBrowserRecord, formatGpuProofGateReport, importBrowserSoak,
  renderLegNumbersTable,
} = lib;

log(`chromium version: ${chromiumVersion()}`);
const git = gitInfo();
log(`commit: ${git.short} (${git.full}) dirty=${git.dirty}`);

// Vite dev server (the supported web runtime, with COOP/COEP for SAB pools).
const vite = viteBin();
if (!vite) fail('vite binary not found (node_modules/.bin/vite)');
const viteLogTail = [];
const viteProc = track(spawn(process.execPath, [vite, '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: join(REPO, 'apps', 'web'), stdio: ['ignore', 'pipe', 'pipe'],
}));
viteProc.stdout.on('data', (c) => { viteLogTail.push(String(c)); if (viteLogTail.length > 40) viteLogTail.shift(); });
viteProc.stderr.on('data', (c) => { viteLogTail.push(String(c)); if (viteLogTail.length > 40) viteLogTail.shift(); });
viteProc.on('exit', (code) => log(`vite exited code=${code} tail: ${viteLogTail.slice(-5).join('').slice(-1500)}`));
const viteUrl = `http://127.0.0.1:${VITE_PORT}`;
try {
  await waitHttpOk(viteUrl + '/', 120000, 'vite');
} catch (e) { await killChild(viteProc, 'vite'); fail(String(e.message ?? e)); }

const pakServer = await startPakServer();
log(`pak server: ${pakServer.url}/pak0.pak`);
const ctx = { viteUrl, pakUrl: pakServer.url };

const legSummaries = [];
const manifestPaths = [];
let gpuGateText = null;

for (const renderer of LEGS) {
  if (!['software', 'voodoo', 'webgl2-experimental'].includes(renderer)) {
    log(`leg ${renderer}: unknown renderer id — skipped`);
    continue;
  }
  const tLeg0 = Date.now();
  const leg = await runLeg(ctx, renderer).catch((e) => ({ renderer, fatal: String(e.message ?? e) }));
  if (leg.fatal) {
    log(`leg ${renderer}: FATAL (no evidence): ${leg.fatal}`);
    legSummaries.push({ leg: renderer, renderer, glRenderer: null, hardwareBacked: false, durationS: 0, cadenceFps: null, p50Ms: null, p95Ms: null, p99Ms: null, dropped: 0, heapDeltaMB: null, errors: 1 });
    manifestPaths.push(`leg ${renderer}: FATAL — ${leg.fatal}`);
    continue;
  }
  // Whole-leg analysis: concatenate interval stamps.
  const allStamps = leg.intervals.flatMap((iv) => iv.frameStamps);
  const allIntervals = frameIntervals(allStamps);
  const sumAll = summarizeFrameTimes(allStamps);
  const totalDur = leg.intervals.reduce((s, iv) => s + iv.durationS, 0);
  const firstF = leg.intervals[0]?.frameStart ?? 0;
  const lastF = leg.intervals[leg.intervals.length - 1]?.frameEnd ?? 0;
  const cadence = cadenceFps(firstF, lastF, totalDur);
  const dropped = countDroppedBeats(allIntervals, 34);
  const mems = leg.intervals.flatMap((iv) => iv.samples.map((s) => s.mem).filter((m) => typeof m === 'number' && m > 0));
  const heapDeltaMB = mems.length >= 2 ? (mems[mems.length - 1] - mems[0]) / 1048576 : null;
  const cls = classifyCompositor(leg.status.glRenderer);
  const errCount = leg.legErrors.length + leg.consoleLines.filter((l) => l.startsWith('[exception]')).length;

  // rAF/BeginFrames probe → refreshHz.
  const probeIv = frameIntervals(Array.isArray(leg.rafProbe) ? leg.rafProbe : []);
  const probeSorted = [...probeIv].sort((a, b) => a - b);
  const probeMed = probeSorted.length > 0 ? probeSorted[probeSorted.length >> 1] : null;
  const refreshHz = probeMed && probeMed > 0 ? 1000 / probeMed : null;

  const perInterval = leg.intervals.map((iv) => {
    const s = summarizeFrameTimes(iv.frameStamps);
    return { name: iv.name, durationS: iv.durationS, frames: iv.frameStart + '->' + iv.frameEnd, cadenceFps: cadenceFps(iv.frameStart, iv.frameEnd, iv.durationS), ...s, dropped: countDroppedBeats(frameIntervals(iv.frameStamps), 34), samples: iv.samples.length, screenshot: iv.screenshot };
  });
  for (const pi of perInterval) {
    log(`leg ${renderer}: [${pi.name}] cadence=${pi.cadenceFps?.toFixed(2) ?? 'n/a'}fps p50=${pi.p50Ms?.toFixed(2) ?? 'n/a'}ms p95=${pi.p95Ms?.toFixed(2) ?? 'n/a'}ms p99=${pi.p99Ms?.toFixed(2) ?? 'n/a'}ms max=${pi.maxMs?.toFixed(2) ?? 'n/a'}ms dropped=${pi.dropped} shots=${pi.screenshot ?? 'none'}`);
  }

  // Raw evidence (gitignored raw/ when large).
  const rawRecord = {
    kind: 'gpu-soak-leg',
    stamp: STAMP,
    date: new Date().toISOString(),
    commit: git,
    browser: { name: 'chromium', version: chromiumVersion(), headless: true },
    chromiumFlags: leg.isGpu ? ['--use-angle=gl-egl'] : ['--disable-gpu', '--enable-unsafe-swiftshader'],
    renderer,
    page: 'soak (?q2soak=1, 640x480, pinned vd_* profile)',
    cvarsRequested: SOAK_CVARS,
    cvarSnapshot: leg.cvarSnap,
    glRenderer: leg.status.glRenderer,
    compositor: cls,
    warmupS: WARMUP_S,
    attackMethod: leg.attackMethod,
    movementEchoOk: leg.moveOk,
    refreshProbeMedianMs: probeMed,
    refreshHz,
    perInterval,
    summary: { durationS: totalDur, cadenceFps: cadence, ...sumAll, dropped, heapDeltaMB, memSamples: mems.length },
    samples: leg.intervals.map((iv) => ({ name: iv.name, rows: iv.samples })),
    frameStamps: allStamps,
    stateStarts: leg.intervals.map((iv) => ({ name: iv.name, state: iv.stateStart })),
    stateEnds: leg.intervals.map((iv) => ({ name: iv.name, state: iv.stateEnd })),
    consoleLines: leg.consoleLines,
    legErrors: leg.legErrors,
  };
  const rawPath = join(OUT_DIR, `gpu-soak-${STAMP}-${renderer}.json`);
  writeFileSync(rawPath, JSON.stringify(rawRecord, null, 1));
  log(`leg ${renderer}: raw ${rawPath} (${allStamps.length} frame stamps, ${(JSON.stringify(rawRecord).length / 1048576).toFixed(1)}MB)`);

  // Committed record via the existing importer.
  const swWorkersRaw = leg.cvarSnap?.sw_workers;
  const swWorkers = Number.isFinite(Number(swWorkersRaw)) ? [Number(swWorkersRaw)] : [0];
  const recordInput = {
    commitShort: git.short, commitFull: git.full,
    browserName: 'chromium', browserVersion: chromiumVersion(), headless: true,
    glRenderer: leg.status.glRenderer, renderer,
    width: 640, height: 480,
    page: `vite-dev ?q2soak=1 renderer=${renderer} (see raw)`,
    durationS: totalDur, samples: leg.intervals.reduce((s, iv) => s + iv.samples.length, 0),
    presentedFpsMedian: cadence, frameP50Ms: sumAll.p50Ms, frameP95Ms: sumAll.p95Ms, frameMaxMs: sumAll.maxMs,
    workloads: ['stationary', 'moving', 'combat'],
    notes: `gpu-soak ${STAMP} ${renderer}: gl=${leg.status.glRenderer} actual=${leg.status.actualRenderer} warn=${leg.status.warning} attack=${leg.attackMethod} moveEcho=${leg.moveOk} refresh~${refreshHz ? refreshHz.toFixed(1) : 'n/a'}Hz(vsync unverified headless; dropped=gaps>=34ms) memΔ=${heapDeltaMB !== null ? heapDeltaMB.toFixed(1) : 'n/a'}MB errors=${errCount} unthrottled=${UNTHROTTLED ? 'yes (rAF uncapped: intervals measure frame work, not the 60Hz cap)' : 'no (60Hz BeginFrames cap applies)'} . Raw+shots: ${rawPath}. No display vsync.`,
    workers: swWorkers,
    dateIso: new Date().toISOString(),
  };
  let manifestPath = '(import skipped)';
  try {
    const built = buildSoakRecord(recordInput);
    const recPath = join(OUT_DIR, `gpu-soak-${STAMP}-${renderer}.record.json`);
    writeFileSync(recPath, JSON.stringify(built, null, 1));
    const imported = importBrowserSoak(recPath, {});
    manifestPath = imported.manifestPath;
    log(`leg ${renderer}: manifest ${manifestPath}`);
  } catch (e) {
    log(`leg ${renderer}: importBrowserSoak FAILED: ${String(e.message ?? e)}`);
    manifestPath = `IMPORT-FAILED: ${String(e.message ?? e)}`;
  }
  manifestPaths.push(`leg ${renderer}: manifest ${manifestPath}`);

  // GPU-leg gate verdict (hardware only; SwiftShader can never pass).
  if (leg.isGpu) {
    const gateInput = {
      refreshHz,
      vsync: false,
      droppedFrames: dropped,
      cpuFallback: leg.status.warning === null && leg.status.actualRenderer === 'webgl2-experimental' ? false : true,
    };
    let proof = null;
    try {
      proof = buildGpuProofRecord(buildSoakRecord(recordInput), gateInput);
    } catch (e) {
      proof = { ok: false, errors: [String(e.message ?? e)] };
    }
    if (proof.ok) {
      const check = validateGpuProofBrowserRecord(proof.record);
      const measured = { medianFrameMs: sumAll.p50Ms, completedFps: cadence, p95FrameIntervalMs: sumAll.p95Ms };
      gpuGateText = formatGpuProofGateReport(proof.record, measured) + `\nleg wall time: ${((Date.now() - tLeg0) / 1000).toFixed(0)}s`;
      log('GATE REPORT:\n' + gpuGateText);
      writeFileSync(join(OUT_DIR, `gpu-soak-${STAMP}-gpu.gate.txt`), gpuGateText + '\n');
    } else {
      gpuGateText = `gpu-proof gate @640x480 hw-backed webgl2-experimental: VOID (record invalid — no CPU fallback counts as GPU success)\n` +
        proof.errors.map((e) => `  - ${e}`).join('\n') +
        `\nNode CPU baselines supplement but NEVER satisfy this gate.`;
      log('GATE REPORT:\n' + gpuGateText);
      writeFileSync(join(OUT_DIR, `gpu-soak-${STAMP}-gpu.gate.txt`), gpuGateText + '\n');
    }
  }
  legSummaries.push({
    leg: renderer, renderer, glRenderer: leg.status.glRenderer, hardwareBacked: cls.hardwareBacked,
    durationS: totalDur, cadenceFps: cadence,
    p50Ms: sumAll.p50Ms, p95Ms: sumAll.p95Ms, p99Ms: sumAll.p99Ms,
    dropped, heapDeltaMB, errors: errCount,
  });
}

pakServer.close();
await killChild(viteProc, 'vite');

log('per-leg numbers:\n' + renderLegNumbersTable(legSummaries));
for (const m of manifestPaths) log(m);
if (gpuGateText) log('final gate verdict:\n' + gpuGateText);
log(`log: ${LOG_PATH}`);
