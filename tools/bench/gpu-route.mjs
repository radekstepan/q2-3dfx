// GPU-FOLLOW-2C box 5: report-only route-timing mode (MEASUREMENT ONLY).
//
// Runs the now-complete scene over ONE fixed live route — stationary baseline,
// multi-room movement/PVS transitions, combat with required effects +
// viewmodel — and records camera positions, visited regions, geometry/effect
// execution, refresh/vsync, p50/p95/p99, dropped beats. NOT an optimization
// campaign: no tuning knobs, no speed gates, no PASS/FAIL on frame times.
//
// Launches Chromium per leg (hardware GL flags parameterized and RECORDED —
// never assumed), serves the built web page via the repo's vite dev server +
// the Q2 pak via a tiny CORS/CORP file server, boots base1 at 640x480 through
// `apps/web` soak mode (?q2soak=1), warms up, then runs the fixed route with
// separately reported segments. Input is scripted from CDP key events only
// (KeyW/arrows/strafe + attack via the page's Mouse0 keydown path, verified
// through the __q2soakState echo).
//
// Sampling discipline (never blocks the frame loop): 1 Hz combined polls of
// the page's __q2soakState/__q2stats/__q2soakWork readers + performance.memory;
// per-segment Page.captureScreenshot runs ONCE at segment boundaries, outside
// the sampling loop. No per-frame readbacks, no finish/blocking calls.
//
// Timing vocabulary (FOLLOW-1, load-bearing — repeated verbatim in output):
// rAF/submission cadence = unthrottled BeginFrames rate (main-thread work
// headroom, NOT display refresh); CPU frame work = caller-clock splits
// (submitMs is submission work, NOT GPU execution); async GPU duration =
// unknown (no timer query); framesSubmitted = on-canvas submission proof,
// NEVER scanout presentation; displayed-frame claims on a headless leg are
// VOID. Unmatched CPU/GPU/browser/compositor numbers are NON-COMPARATIVE.
//
// Env:
//   Q2_PAK (required — skip otherwise), CHROMIUM_BIN (default /usr/bin/chromium),
//   GPU_ROUTE_LEGS (default 'webgl2-experimental'),
//   GPU_ROUTE_WARMUP_S (default 5), GPU_ROUTE_SEGMENT_S (default 10),
//   GPU_ROUTE_HEADLESS (default 1; 0 = headed, needs a display),
//   GPU_ROUTE_OUT (default tools/bench/evidence/raw),
//   GPU_ROUTE_VITE_PORT (default 5192), GPU_ROUTE_LOG (default <out>/gpu-route-<stamp>.log).
//
// A short smoke (small warmup/segment) is enough for lane evidence; the full
// soak stays FOLLOW-6. Exit 0 = all legs measured; exit 2 = SKIP; exit 1 = error.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { accessSync, constants, createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const EVIDENCE_DIR = join(REPO, 'tools', 'bench', 'evidence');
const OUT_DIR = process.env.GPU_ROUTE_OUT ?? join(EVIDENCE_DIR, 'raw');
const Q2_PAK = process.env.Q2_PAK ?? '';
const CHROMIUM_BIN = process.env.CHROMIUM_BIN ?? '/usr/bin/chromium';
const LEGS = (process.env.GPU_ROUTE_LEGS ?? 'webgl2-experimental').split(',').map((s) => s.trim()).filter(Boolean);
const WARMUP_S = Number(process.env.GPU_ROUTE_WARMUP_S ?? 5);
const SEGMENT_S = Number(process.env.GPU_ROUTE_SEGMENT_S ?? 10);
const HEADLESS = (process.env.GPU_ROUTE_HEADLESS ?? '1') !== '0';
const VITE_PORT = Number(process.env.GPU_ROUTE_VITE_PORT ?? 5192);

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
const STAMP = stamp();
const LOG_PATH = process.env.GPU_ROUTE_LOG ?? join(OUT_DIR, `gpu-route-${STAMP}.log`);
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
  console.log('SKIP: Q2_PAK required (pak-gated route, no assets to measure).');
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
log(`chromium: ${CHROMIUM_BIN} headless=${HEADLESS}`);
log(`legs: ${LEGS.join(',')} warmup=${WARMUP_S}s segment=${SEGMENT_S}s`);

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

// --- Minimal CDP client (global fetch + WebSocket, no new deps) --------------

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
      ws.onclose = () => { closed = true; for (const [, p] of pending) { clearTimeout(p.timer); p.rej(new Error('CDP socket closed')); } pending.clear(); };
      void (async () => {
        try {
          await send('Runtime.enable', {}, 20000);
          await send('Page.enable', {}, 20000);
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
    const userDataDir = join(tmpdir(), `q2-gpu-route-${STAMP}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(userDataDir, { recursive: true });
    const args = [
      ...(HEADLESS ? ['--headless'] : []),
      '--no-sandbox', '--disable-dev-shm-usage', '--mute-audio',
      '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
      '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
      ...extraFlags, pageUrl,
    ];
    log(`chromium flags: ${extraFlags.join(' ')}${HEADLESS ? '' : ' (headed)'}`);
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

async function probeAttack(cdp) {
  const stateExpr = 'window.__q2soakState ? window.__q2soakState().buttons : -1';
  try {
    await cdp.keyEvent('rawKeyDown', { key: 'Unidentified', code: 'Mouse0', windowsVirtualKeyCode: 0 });
    await new Promise((r) => setTimeout(r, 800));
    const b = await cdp.evaluate(stateExpr, 15000);
    await cdp.keyEvent('rawKeyUp', { key: 'Unidentified', code: 'Mouse0', windowsVirtualKeyCode: 0 }).catch(() => undefined);
    if (typeof b === 'number' && (b & 1) === 1) return 'key-Mouse0';
  } catch { /* next candidate */ }
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

// --- Combined 1 Hz poll (single round-trip; reader-only, never frame-blocking)
const POLL_EXPR = `(function(){
  var st=null; try{ if(window.__q2soakState){ var s=window.__q2soakState();
    st={pos:s.pos,yawDeg:s.yawDeg,keys:s.keys,buttons:s.buttons,framesSubmitted:s.framesSubmitted,uploads:s.uploads}; } }catch(e){}
  var stats=null; try{ if(window.__q2stats){ stats={frame:window.__q2stats.frame,fps:window.__q2stats.fps,
    rgbKicks:window.__q2stats.rgbKicks,rgbInline:window.__q2stats.rgbInline,fallbacks:window.__q2stats.rgbFallbacks}; } }catch(e){}
  var mem=-1; try{ if(performance.memory) mem=performance.memory.usedJSHeapSize; }catch(e){}
  return {state:st,stats:stats,mem:mem,t:performance.now()};
})()`;

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

async function runLeg(ctx, renderer, lib) {
  const isGpu = renderer === 'webgl2-experimental';
  const flags = [
    ...(isGpu
      ? ['--use-angle=gl-egl']
      : ['--disable-gpu', '--enable-unsafe-swiftshader']),
  ];
  const pageUrl = `${ctx.viteUrl}/?q2soak=1&q2pak=${encodeURIComponent(`${ctx.pakUrl}/pak0.pak`)}&q2renderer=${renderer}&q2cvars=${encodeURIComponent(SOAK_CVARS)}`;
  log(`leg ${renderer}: navigating`);
  const launched = await launchChromium(pageUrl, flags);
  let cdp = null;
  const legErrors = [];
  try {
    cdp = await connectCdp(launched.port);
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
    const rafProbe = await cdp.evaluate(
      `new Promise((res)=>{var t=[];var f=function(){t.push(performance.now());if(t.length<240)requestAnimationFrame(f);else res(t);};requestAnimationFrame(f);})`,
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
    // Warmup: verify frames advance.
    const frameA = await cdp.evaluate(`window.__q2stats ? window.__q2stats.frame : -1`, 15000);
    await new Promise((r) => setTimeout(r, WARMUP_S * 1000));
    const frameB = await cdp.evaluate(`window.__q2stats ? window.__q2stats.frame : -1`, 15000);
    log(`leg ${renderer}: warmup frames ${frameA} -> ${frameB} over ${WARMUP_S}s`);
    if (!(frameB > frameA)) throw new Error(`warmup stall: frames ${frameA} -> ${frameB} (loop not advancing)`);

    // Fixed route: stationary / moving / combat (scripts in GPU_ROUTE_SCRIPT).
    const segments = [];
    const allCams = [];
    const plan = ['stationary', 'moving', 'combat'];
    const tRoute0 = Date.now();
    for (const name of plan) {
      log(`leg ${renderer}: route segment ${name} (${SEGMENT_S}s) — ${lib.GPU_ROUTE_SCRIPT[name]}`);
      const idxStart = await cdp.evaluate('window.__q2soakFrames ? window.__q2soakFrames.length : -1', 15000);
      const fStart = await cdp.evaluate('window.__q2stats ? window.__q2stats.frame : -1', 15000);
      const subStart = await cdp.evaluate(`window.__q2soakState ? window.__q2soakState().framesSubmitted : null`, 15000).catch(() => null);
      const upStart = await cdp.evaluate(`window.__q2soakState ? window.__q2soakState().uploads : null`, 15000).catch(() => null);
      const t0 = Date.now();
      const tEnd = t0 + SEGMENT_S * 1000;
      const cams = [];
      let phase = -1;
      if (name === 'moving' || name === 'combat') await keyDown(cdp, KEY_W);
      if (name === 'combat' && attackMethod !== 'unverified') await attackDown(cdp, attackMethod);
      try {
        while (Date.now() < tEnd) {
          const elapsed = (Date.now() - t0) / 1000;
          if (name === 'moving') {
            // 8 s rotation: straight | +left | +right | +strafe-left | +strafe-right.
            const p = Math.floor(elapsed / 8) % 5;
            if (p !== phase) {
              phase = p;
              await allUp(cdp).catch(() => undefined);
              await keyDown(cdp, KEY_W).catch(() => undefined);
              if (p === 1) await keyDown(cdp, ARROW_LEFT).catch(() => undefined);
              if (p === 2) await keyDown(cdp, ARROW_RIGHT).catch(() => undefined);
              if (p === 3) await keyDown(cdp, KEY_A).catch(() => undefined);
              if (p === 4) await keyDown(cdp, KEY_D).catch(() => undefined);
            }
          } else if (name === 'combat') {
            // 10 s alternating turn hold while firing on the move.
            const p = Math.floor(elapsed / 10) % 2;
            if (p !== phase) {
              phase = p;
              try {
                await keyUp(cdp, ARROW_LEFT); await keyUp(cdp, ARROW_RIGHT);
                await keyDown(cdp, p === 0 ? ARROW_LEFT : ARROW_RIGHT);
              } catch { /* keep firing */ }
            }
          }
          const poll = await cdp.evaluate(POLL_EXPR, 15000).catch((e) => ({ pollError: String(e.message ?? e) }));
          if (poll && poll.state) {
            cams.push({
              tS: (Date.now() - t0) / 1000,
              pos: typeof poll.state.pos === 'string' ? poll.state.pos : null,
              yawDeg: typeof poll.state.yawDeg === 'number' ? poll.state.yawDeg : null,
              keys: Array.isArray(poll.state.keys) ? poll.state.keys : null,
              buttons: typeof poll.state.buttons === 'number' ? poll.state.buttons : null,
              framesSubmitted: typeof poll.state.framesSubmitted === 'number' ? poll.state.framesSubmitted : null,
              uploads: typeof poll.state.uploads === 'number' ? poll.state.uploads : null,
            });
          }
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
      } catch (e) { legErrors.push(`segment ${name}: frame ring slice failed: ${String(e.message ?? e)}`); }
      const subEnd = await cdp.evaluate(`window.__q2soakState ? window.__q2soakState().framesSubmitted : null`, 15000).catch(() => null);
      const upEnd = await cdp.evaluate(`window.__q2soakState ? window.__q2soakState().uploads : null`, 15000).catch(() => null);
      let workLine = null;
      try {
        const w = await cdp.evaluate('window.__q2soakWork ? window.__q2soakWork() : null', 15000);
        if (w && typeof w === 'object') {
          workLine = `submit~${w.submitMs ?? 'n/a'}ms total~${w.totalMs ?? 'n/a'}ms drains~${w.drainsMs ?? 'n/a'} sim~${w.simMs ?? 'n/a'} view~${w.viewMs ?? 'n/a'} tail~${w.tailMs ?? 'n/a'} (caller-clock submission work, NOT GPU execution)`;
        }
      } catch { workLine = null; }
      // Segment-boundary capture only: one compositor readback BETWEEN
      // segments, never inside the sampling loop (no frame-loop blocking).
      let shotB64 = null;
      try { shotB64 = await cdp.screenshot(60000); } catch (e) { legErrors.push(`segment ${name}: screenshot failed: ${String(e.message ?? e)}`); }
      const shotPath = shotB64 ? join(OUT_DIR, `gpu-route-${STAMP}-${renderer}-${name}.png`) : null;
      if (shotB64 && shotPath) {
        try { writeFileSync(shotPath, Buffer.from(shotB64, 'base64')); } catch (e) { legErrors.push(`segment ${name}: screenshot write failed: ${String(e)}`); }
      }
      for (const c of cams) allCams.push(c);
      segments.push({
        segment: name, durationS: durS, frames: `${fStart}->${fEnd}`,
        frameStamps: frameSlice, cameras: cams,
        submittedStart: typeof subStart === 'number' ? subStart : null,
        submittedEnd: typeof subEnd === 'number' ? subEnd : null,
        uploadsStart: typeof upStart === 'number' ? upStart : null,
        uploadsEnd: typeof upEnd === 'number' ? upEnd : null,
        workLine, screenshot: shotPath,
      });
      log(`leg ${renderer}: segment ${name} done frames ${fStart}->${fEnd} over ${durS.toFixed(1)}s polls=${cams.length} pos=${cams.length > 0 ? cams[cams.length - 1].pos : 'n/a'}`);
    }
    const consoleLines = cdp.consoleLines();
    return { renderer, isGpu, status, cvarSnap, segments, allCams, consoleLines, legErrors, rafProbe, attackMethod, moveOk, routeWallS: (Date.now() - tRoute0) / 1000 };
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
  buildSoakRecord, summarizeFrameTimes, frameIntervals,
  cadenceFps, countDroppedBeats, classifyCompositor,
  buildRouteSegmentReport, buildRouteReport, renderRouteTable,
  summarizeRoute, describeRouteCadenceEvidence, routeComparabilityNote,
  collectMachine, pakIdentity, gitDirtyFiles, importBrowserSoak,
} = lib;

log(`chromium version: ${chromiumVersion()}`);
const git = gitInfo();
log(`commit: ${git.short} (${git.full}) dirty=${git.dirty}`);

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
const legReports = [];

for (const renderer of LEGS) {
  if (!['software', 'voodoo', 'webgl2-experimental'].includes(renderer)) {
    log(`leg ${renderer}: unknown renderer id — skipped`);
    continue;
  }
  const tLeg0 = Date.now();
  const leg = await runLeg(ctx, renderer, lib).catch((e) => ({ renderer, fatal: String(e.message ?? e) }));
  if (leg.fatal) {
    log(`leg ${renderer}: FATAL (no evidence): ${leg.fatal}`);
    manifestPaths.push(`leg ${renderer}: FATAL — ${leg.fatal}`);
    continue;
  }
  const segReports = leg.segments.map((s) => buildRouteSegmentReport({
    segment: s.segment, durationS: s.durationS, frameStart: Number(String(s.frames).split('->')[0]),
    frameEnd: Number(String(s.frames).split('->')[1]),
    frameStamps: s.frameStamps, cameras: s.cameras,
    submittedStart: s.submittedStart, submittedEnd: s.submittedEnd,
    uploadsStart: s.uploadsStart, uploadsEnd: s.uploadsEnd,
    workLine: s.workLine, screenshot: s.screenshot,
  }));
  const probeIv = frameIntervals(Array.isArray(leg.rafProbe) ? leg.rafProbe : []);
  const probeSorted = [...probeIv].sort((a, b) => a - b);
  const probeMed = probeSorted.length > 0 ? probeSorted[probeSorted.length >> 1] : null;
  const refreshHz = probeMed && probeMed > 0 ? 1000 / probeMed : null;
  const report = buildRouteReport({
    renderer, glRenderer: leg.status.glRenderer, headless: HEADLESS,
    vsync: false, refreshHz,
    chromiumFlags: leg.isGpu ? ['--use-angle=gl-egl'] : ['--disable-gpu', '--enable-unsafe-swiftshader'],
    cvarsRequested: SOAK_CVARS, warmupS: WARMUP_S,
    attackMethod: leg.attackMethod, movementEchoOk: leg.moveOk,
    segments: segReports, camerasInOrder: leg.allCams,
    // Wall-clock route duration (includes segment-boundary captures, during
    // which the frame counter keeps advancing): the honest cadence denominator.
    wallDurationS: typeof leg.routeWallS === 'number' ? leg.routeWallS : null,
    dateIso: new Date().toISOString(), commitShort: git.short, commitFull: git.full,
  });
  for (const sr of segReports) {
    log(`leg ${renderer}: [${sr.segment}] cadence=${sr.cadenceFps?.toFixed(2) ?? 'n/a'}fps p50=${sr.intervals.p50Ms?.toFixed(2) ?? 'n/a'}ms p95=${sr.intervals.p95Ms?.toFixed(2) ?? 'n/a'}ms p99=${sr.intervals.p99Ms?.toFixed(2) ?? 'n/a'}ms dropped=${sr.droppedBeats} cells=${sr.distinctCells} yawSpan=${sr.yawSpanDeg?.toFixed(1) ?? 'n/a'}deg submitΔ=${sr.submittedDelta ?? 'n/a'} uploads=${sr.uploadsLast ?? 'n/a'} shot=${sr.screenshot ?? 'MISS'}`);
  }

  const rawPath = join(OUT_DIR, `gpu-route-${STAMP}-${renderer}.json`);
  const rawRecord = {
    kind: 'gpu-route-leg', stamp: STAMP, date: new Date().toISOString(), commit: git,
    browser: { name: 'chromium', version: chromiumVersion(), headless: HEADLESS },
    chromiumFlags: leg.isGpu ? ['--use-angle=gl-egl'] : ['--disable-gpu', '--enable-unsafe-swiftshader'],
    renderer, page: 'soak (?q2soak=1, 640x480, pinned vd_* profile)',
    cvarsRequested: SOAK_CVARS, cvarSnapshot: leg.cvarSnap,
    glRenderer: leg.status.glRenderer, compositor: classifyCompositor(leg.status.glRenderer),
    warmupS: WARMUP_S, attackMethod: leg.attackMethod, movementEchoOk: leg.moveOk,
    refreshProbeMedianMs: probeMed, refreshHz,
    timingKinds: 'rAF/submission cadence = BeginFrames rate (main-thread work headroom, NOT display refresh); CPU frame work = caller-clock splits (submitMs is submission work, NOT GPU execution); async GPU duration = unknown (no disjoint-timer query); framesSubmitted = on-canvas submission proof, NEVER scanout presentation; displayed-frame evidence requires a visible vsync-locked leg',
    report,
    samples: leg.segments.map((s) => ({ segment: s.segment, cameras: s.cameras, frameStamps: s.frameStamps })),
    consoleLines: leg.consoleLines, legErrors: leg.legErrors,
  };
  writeFileSync(rawPath, JSON.stringify(rawRecord, null, 1));
  log(`leg ${renderer}: raw ${rawPath}`);

  // Committed manifest via the existing importer (FOLLOW-1 provenance; the
  // route's workloads ride as stationary/moving/combat intervals).
  const swWorkersRaw = leg.cvarSnap?.sw_workers;
  const swWorkers = Number.isFinite(Number(swWorkersRaw)) ? [Number(swWorkersRaw)] : [0];
  const VD_KEYS = ['vd_gamma', 'vd_dither', 'vd_16bit', 'vd_postfilter', 'vd_bilinear', 'vd_mipdither', 'vd_lodbias', 'vd_fog', 'vd_overbright', 'vd_palettetex', 'vd_maxtexsize', 'vd_zbits', 'vd_dithermode', 'vd_reconmode', 'vd_rgbmaxdelta'];
  const SW_KEYS = ['sw_workers', 'sw_accum'];
  let fidelity = null;
  if (leg.cvarSnap && typeof leg.cvarSnap === 'object') {
    const vd = {};
    const sw = {};
    for (const k of VD_KEYS) if (leg.cvarSnap[k] !== undefined) vd[k] = String(leg.cvarSnap[k]);
    for (const k of SW_KEYS) if (leg.cvarSnap[k] !== undefined) sw[k] = String(leg.cvarSnap[k]);
    if (Object.keys(vd).length > 0) fidelity = { vd, sw };
  }
  let hostMachine = null;
  try { hostMachine = await collectMachine(); } catch { hostMachine = null; }
  let pak = null;
  try { pak = pakIdentity(Q2_PAK); } catch { pak = null; }
  let dirtyFiles = null;
  try { dirtyFiles = gitDirtyFiles(); } catch { dirtyFiles = null; }
  const cpuFallback = leg.status.warning === null && leg.status.actualRenderer === 'webgl2-experimental' ? false : leg.isGpu ? true : null;
  const totalDur = segReports.reduce((s, r) => s + r.durationS, 0);
  const sumAll = summarizeFrameTimes(segReports.flatMap((s, i) => leg.segments[i].frameStamps));
  const allIv = frameIntervals(segReports.flatMap((s, i) => leg.segments[i].frameStamps));
  const firstF = Number(String(leg.segments[0].frames).split('->')[0]);
  const lastF = Number(String(leg.segments[leg.segments.length - 1].frames).split('->')[1]);
  const mems = [];
  let manifestPath = '(import skipped)';
  try {
    const built = buildSoakRecord({
      commitShort: git.short, commitFull: git.full,
      browserName: 'chromium', browserVersion: chromiumVersion(), headless: HEADLESS,
      glRenderer: leg.status.glRenderer, renderer, width: 640, height: 480,
      page: `vite-dev ?q2soak=1 renderer=${renderer} fixed-route stationary/moving/combat (see raw)`,
      durationS: totalDur, samples: leg.allCams.length,
      presentedFpsMedian: cadenceFps(firstF, lastF, totalDur),
      frameP50Ms: sumAll.p50Ms, frameP95Ms: sumAll.p95Ms, frameMaxMs: sumAll.maxMs,
      workloads: ['stationary', 'moving', 'combat'],
      notes: `gpu-route ${STAMP} ${renderer}: gl=${leg.status.glRenderer} actual=${leg.status.actualRenderer} warn=${leg.status.warning} attack=${leg.attackMethod} moveEcho=${leg.moveOk} refresh~${refreshHz ? refreshHz.toFixed(1) : 'n/a'}Hz(BeginFrames rAF rate = submission-cadence work headroom, NOT display refresh; vsync unverified headless; dropped=rAF gaps>=34ms, NOT compositor drops) cells=${report.summary.distinctCells} yawSpan=${report.summary.yawSpanDeg?.toFixed(1) ?? 'n/a'}deg submitΔtotal=${segReports.map((s) => s.submittedDelta ?? 'n/a').join('+')} errors=${leg.legErrors.length} route-timings report-only (NOT an optimization campaign). Raw+shots: ${rawPath}. No display vsync: headless cadence never claims displayed 60 FPS; async GPU duration unknown (no timer query).`,
      workers: swWorkers, dateIso: new Date().toISOString(), fidelity, warmupS: WARMUP_S,
      pak, machineDetail: hostMachine, sourceDirty: git.dirty, sourceDirtyFiles: dirtyFiles,
      chromiumFlags: leg.isGpu ? ['--use-angle=gl-egl'] : ['--disable-gpu', '--enable-unsafe-swiftshader'],
      cvarSnapshot: leg.cvarSnap ?? null, refreshHz, vsync: false,
      droppedFrames: countDroppedBeats(allIv), cpuFallback,
    });
    const recPath = join(OUT_DIR, `gpu-route-${STAMP}-${renderer}.record.json`);
    writeFileSync(recPath, JSON.stringify(built, null, 1));
    const imported = importBrowserSoak(recPath, {});
    manifestPath = imported.manifestPath;
    log(`leg ${renderer}: manifest ${manifestPath}`);
  } catch (e) {
    log(`leg ${renderer}: importBrowserSoak FAILED: ${String(e.message ?? e)}`);
    manifestPath = `IMPORT-FAILED: ${String(e.message ?? e)}`;
  }
  manifestPaths.push(`leg ${renderer}: manifest ${manifestPath}`);

  const reportTxt = [
    `gpu-route report-only timings ${STAMP} leg=${renderer} (NOT an optimization campaign)`,
    `commit ${git.short} dirty=${git.dirty} | chromium ${chromiumVersion()} headless=${HEADLESS} | gl=${leg.status.glRenderer} actual=${leg.status.actualRenderer} warn=${leg.status.warning}`,
    `warmup ${WARMUP_S}s | attack=${leg.attackMethod} moveEcho=${leg.moveOk}`,
    '',
    'per-segment numbers:',
    renderRouteTable(segReports),
    '',
    `route summary: dur=${report.summary.durationS.toFixed(1)}s cadence=${report.summary.cadenceFps?.toFixed(2) ?? 'n/a'}fps worst-seg p50=${report.summary.p50Ms?.toFixed(2) ?? 'n/a'}ms p95=${report.summary.p95Ms?.toFixed(2) ?? 'n/a'}ms p99=${report.summary.p99Ms?.toFixed(2) ?? 'n/a'}ms dropped=${report.summary.droppedBeats} cells=${report.summary.distinctCells} yawSpan=${report.summary.yawSpanDeg?.toFixed(1) ?? 'n/a'}deg`,
    '',
    `cadence evidence: ${report.cadenceEvidence}`,
    '',
    `comparability: ${routeComparabilityNote(legReports.map((l) => ({ renderer: l.renderer, glRenderer: l.glRenderer, headless: l.headless })))}`,
    '',
    report.acceptanceReport,
    '',
    `leg wall time: ${((Date.now() - tLeg0) / 1000).toFixed(0)}s`,
  ].join('\n');
  const reportPath = join(OUT_DIR, `gpu-route-${STAMP}-${renderer}.report.txt`);
  writeFileSync(reportPath, reportTxt + '\n');
  log(`leg ${renderer} report:\n${reportTxt}`);
  legSummaries.push({ renderer, report: reportTxt });
  legReports.push({ renderer, glRenderer: leg.status.glRenderer, headless: HEADLESS });
}

pakServer.close();
await killChild(viteProc, 'vite');

for (const m of manifestPaths) log(m);
log(`log: ${LOG_PATH}`);
