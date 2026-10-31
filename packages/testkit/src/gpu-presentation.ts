// @q2/testkit — GPU-FOLLOW-0 lane B: real-browser presentation regression (Node-only).
//
// Drives the PRODUCTION page (apps/web served by its vite dev server, exactly like
// tools/bench/gpu-soak.mjs does) over CDP and asserts the composed visible page:
// computed styles, HUD/GPU canvas alignment, canvas/context state, rendering
// errors, and visible scene pixels from Page.captureScreenshot.
//
// Serving choice (documented per the card): vite dev (repo node_modules/.bin/vite,
// cwd apps/web) serves the real index.html + module graph with the soak boot query
// (?q2soak=1&q2pak=<pak-url>&q2renderer=<id>[&q2cvars=...]). A built-dist static
// server is NOT used: apps/web/dist is a library build without index.html, so it
// cannot reproduce the production DOM/CSS. When vite, chromium, or Q2_PAK is
// absent the caller SKIPs with a message (never fails).
//
// Renderer switching is exercised by reloading the page with a different
// q2renderer value (the real user-visible boot path). Size coverage pairs the
// 640x480 backing leg with a small-viewport leg (fresh chromium at
// --window-size=384,256): the soak hook passes explicit 640x480 dims to
// bootPlay, which win over a vid_resolution q2cvars override (verified live),
// so the honest small-size leg varies the DISPLAYED size — the composed-page
// half of the alignment contract — instead of asserting on a no-op knob.
//
// Screenshot analysis decodes the PNG in-Node (no new deps, node:zlib only).
// The production path stays readback-free: neither this module nor its test
// performs a GL readback of any kind (no capture API beyond the composed-page
// Page.captureScreenshot, which is what the regression is about).
//
// DOM-free by construction: imports only node:* here. NEVER import this module
// from a browser bundle. Exported symbols only; no default exports.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { accessSync, constants, createReadStream, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import {
  chromiumBinaryPath,
  resolvePakPath,
  type CdpConnection,
} from './gpu-browser.js';

// --- Predeclared bands (rationale inline; wide presence floors, never fitted) ---

/** Composed page must show a real scene: below 5% non-black means blank/overlay. */
export const PRESENTATION_MIN_NONBLACK_FRAC = 0.05;
/**
 * Gun-region presence floor (bottom-center block where the viewmodel lives).
 * 2% of that region must be non-black — far below a rendered gun, far above
 * an all-black overlay. Fails closed on the black-CSS-overlay defect.
 */
export const PRESENTATION_MIN_GUN_REGION_FRAC = 0.02;
/** HUD/GPU canvas rect equality tolerance (CSS px, per the card). */
export const PRESENTATION_RECT_TOLERANCE_PX = 1;
/** Backing-store vs displayed-size tolerance (CSS px; dpr=1 headless). */
export const PRESENTATION_SIZE_TOLERANCE_PX = 1;
/**
 * Near-white wash ceiling: a real base1 spawn frame is never majority
 * near-white (all-white reads 1.0 — the failure this pins alongside the
 * all-black non-black floor).
 */
export const PRESENTATION_MAX_NEARWHITE_FRAC = 0.5;
/**
 * Distinct-triple floor: a degenerate single-color failure reads 1; a real
 * textured scene reads in the thousands.
 */
export const PRESENTATION_MIN_DISTINCT_TRIPLES = 100;

// --- Pure screenshot analysis (headless-unit-tested, no browser needed) ---

/** Decoded PNG image (always RGBA, 8 bit). */
export interface PngRgba {
  width: number;
  height: number;
  /** Row-major RGBA, top row first. */
  data: Uint8Array;
}

function readU32BE(bytes: Uint8Array, off: number): number {
  return (
    bytes[off]! * 0x1000000 +
    ((bytes[off + 1]! << 16) | ((bytes[off + 2]! << 8) | bytes[off + 3]!))
  ) >>> 0;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode an 8-bit non-interlaced PNG (color types 2 RGB / 6 RGBA) to RGBA.
 * Throws on anything else (fail closed — never silently analyze a guess).
 * CRCs are not verified (integrity is the transport's job, not the analyzer's).
 */
export function decodePngRgba(png: Uint8Array): PngRgba {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 8) throw new Error('[gpu-presentation] PNG too short for a signature');
  for (let i = 0; i < 8; i++) {
    if (png[i] !== sig[i]) throw new Error('[gpu-presentation] bad PNG signature');
  }
  let off = 8;
  let width = -1;
  let height = -1;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  let idatLen = 0;
  while (off + 8 <= png.length) {
    const len = readU32BE(png, off);
    const type =
      String.fromCharCode(png[off + 4]!, png[off + 5]!, png[off + 6]!, png[off + 7]!);
    const dataOff = off + 8;
    const dataEnd = dataOff + len;
    if (dataEnd + 4 > png.length) throw new Error('[gpu-presentation] PNG chunk overruns the buffer');
    if (type === 'IHDR') {
      if (len !== 13) throw new Error('[gpu-presentation] bad IHDR length');
      width = readU32BE(png, dataOff);
      height = readU32BE(png, dataOff + 4);
      const depth = png[dataOff + 8]!;
      colorType = png[dataOff + 9]!;
      const comp = png[dataOff + 10]!;
      const filter = png[dataOff + 11]!;
      const interlace = png[dataOff + 12]!;
      if (depth !== 8) throw new Error(`[gpu-presentation] unsupported PNG bit depth ${depth}`);
      if (colorType !== 2 && colorType !== 6) {
        throw new Error(`[gpu-presentation] unsupported PNG color type ${colorType}`);
      }
      if (comp !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error('[gpu-presentation] unsupported PNG compression/filter/interlace');
      }
    } else if (type === 'IDAT') {
      const slice = png.subarray(dataOff, dataEnd);
      idat.push(slice);
      idatLen += slice.length;
    } else if (type === 'IEND') {
      break;
    }
    off = dataEnd + 4;
  }
  if (width <= 0 || height <= 0) throw new Error('[gpu-presentation] PNG missing IHDR');
  if (idat.length === 0) throw new Error('[gpu-presentation] PNG has no IDAT');
  const packed = new Uint8Array(idatLen);
  let w = 0;
  for (const s of idat) {
    packed.set(s, w);
    w += s.length;
  }
  const raw = inflateSync(packed);
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) {
    throw new Error(
      `[gpu-presentation] PNG scanline length mismatch: got ${raw.length}, want ${height * (stride + 1)}`,
    );
  }
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]!;
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      let v = raw[p++]!;
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) v = (v + paethPredictor(a, b, c)) & 255;
      else if (filter !== 0) throw new Error(`[gpu-presentation] bad PNG filter ${filter}`);
      cur[i] = v;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      out[o] = cur[s]!;
      out[o + 1] = cur[s + 1]!;
      out[o + 2] = cur[s + 2]!;
      out[o + 3] = channels === 4 ? cur[s + 3]! : 255;
    }
    prev = cur;
  }
  return { width, height, data: out };
}

/** Fraction of pixels with any nonzero R/G/B channel. */
export function nonBlackFraction(rgba: Uint8Array): number {
  if (rgba.length % 4 !== 0 || rgba.length === 0) {
    throw new Error('[gpu-presentation] nonBlackFraction needs a non-empty RGBA buffer');
  }
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] !== 0 || rgba[i + 1] !== 0 || rgba[i + 2] !== 0) n++;
  }
  return n / (rgba.length / 4);
}

/** Fractional sub-rectangle of the frame (0..1 in each axis, top-first rows). */
export interface FrameRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Fraction of pixels with all channels above 240 (near-white wash detector). */
export function nearWhiteFraction(rgba: Uint8Array): number {
  if (rgba.length % 4 !== 0 || rgba.length === 0) {
    throw new Error('[gpu-presentation] nearWhiteFraction needs a non-empty RGBA buffer');
  }
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i]! > 240 && rgba[i + 1]! > 240 && rgba[i + 2]! > 240) n++;
  }
  return n / (rgba.length / 4);
}

/**
 * Distinct opaque RGB triples (exact). A degenerate all-white/all-black
 * failure reads 1; a real textured scene reads in the thousands.
 */
export function distinctTripleCount(rgba: Uint8Array): number {
  if (rgba.length % 4 !== 0 || rgba.length === 0) {
    throw new Error('[gpu-presentation] distinctTripleCount needs a non-empty RGBA buffer');
  }
  const seen = new Set<number>();
  for (let i = 0; i + 2 < rgba.length; i += 4) {
    seen.add(rgba[i]! * 65536 + rgba[i + 1]! * 256 + rgba[i + 2]!);
  }
  return seen.size;
}

/**
 * Bottom-center block where the GPU viewmodel renders (top-first rows).
 * Wide on purpose: a presence floor, not a placement pin.
 */
export function gunRegion(): FrameRegion {
  return { x0: 0.25, y0: 0.55, x1: 0.9, y1: 1.0 };
}

/** Non-black fraction restricted to a fractional frame region. */
export function regionNonBlackFraction(
  rgba: Uint8Array,
  width: number,
  height: number,
  region: FrameRegion,
): number {
  if (rgba.length !== width * height * 4) {
    throw new Error('[gpu-presentation] regionNonBlackFraction: buffer/geometry mismatch');
  }
  const x0 = Math.max(0, Math.floor(region.x0 * width));
  const x1 = Math.min(width, Math.ceil(region.x1 * width));
  const y0 = Math.max(0, Math.floor(region.y0 * height));
  const y1 = Math.min(height, Math.ceil(region.y1 * height));
  if (x1 <= x0 || y1 <= y0) throw new Error('[gpu-presentation] empty region');
  let n = 0;
  const total = (x1 - x0) * (y1 - y0);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * width + x) * 4;
      if (rgba[o] !== 0 || rgba[o + 1] !== 0 || rgba[o + 2] !== 0) n++;
    }
  }
  return n / total;
}

/** CSS-pixel rectangle (getBoundingClientRect shape). */
export interface DomRectJson {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Max absolute edge delta between two rects (CSS px). */
export function maxRectDelta(a: DomRectJson, b: DomRectJson): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height),
  );
}

/** Rect equality within a CSS-px tolerance (the card requires 1px). */
export function rectsAligned(a: DomRectJson, b: DomRectJson, tolerancePx: number): boolean {
  return maxRectDelta(a, b) <= tolerancePx;
}

/**
 * True for `transparent` or rgba() with a zero alpha channel. `rgb(0, 0, 0)`
 * (and any opaque black) is NOT transparent — that is the overlay defect.
 */
export function isTransparentBlack(cssColor: string): boolean {
  const s = cssColor.trim().toLowerCase();
  if (s === 'transparent') return true;
  const m = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)$/.exec(s);
  if (!m) return false;
  const alpha = m[4] === undefined ? 1 : Number(m[4]);
  return alpha === 0;
}

// --- Production-page probe (CDP Runtime.evaluate, no page imports) ---

/** One composed-page presentation observation (all fields nullable when absent). */
export interface PresentationProbe {
  hasQ2: boolean;
  hasGl: boolean;
  /** getComputedStyle(#q2).backgroundColor (null when #q2 is absent). */
  q2Background: string | null;
  q2Rect: DomRectJson | null;
  glRect: DomRectJson | null;
  q2Canvas: { width: number; height: number; clientWidth: number; clientHeight: number } | null;
  glCanvas: { width: number; height: number; clientWidth: number; clientHeight: number } | null;
  devicePixelRatio: number;
  gl: {
    available: boolean;
    contextLost: boolean | null;
    version: string | null;
    renderer: string | null;
    alpha: boolean | null;
  } | null;
  soak: {
    booted: boolean;
    actualRenderer: string;
    warning: string | null;
    error: string | null;
    framesSubmitted: number | null;
    uploads: number | null;
    gpuActive: boolean;
  } | null;
  /** Current page URL (distinguishes stale-page reads after a reload). */
  href: string;
  /** Live cvar snapshot via window.__q2soakCvars (null when unavailable). */
  cvars: Record<string, string> | null;
}

// Plain JS (no ${} — embedded in a TS string literal is unnecessary here since
// the harness passes it straight to Runtime.evaluate; kept ${}-free anyway).
const PROBE_JS = `
(function () {
  function rectOf(el) {
    if (!el || !el.getBoundingClientRect) return null;
    var r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  function canvasOf(el) {
    if (!el) return null;
    return {
      width: Number(el.width) || 0,
      height: Number(el.height) || 0,
      clientWidth: Number(el.clientWidth) || 0,
      clientHeight: Number(el.clientHeight) || 0,
    };
  }
  var q2 = document.querySelector('#q2');
  var glc = document.querySelector('#q2-gl');
  var bg = null;
  try {
    if (q2) bg = String(window.getComputedStyle(q2).backgroundColor || '');
  } catch (e) { bg = 'unreadable'; }
  var gl = null;
  try {
    if (glc && glc.getContext) {
      var g = glc.getContext('webgl2');
      if (g) {
        var attrs = null;
        try { attrs = g.getContextAttributes(); } catch (e) { attrs = null; }
        var lost = null;
        try { lost = g.isContextLost(); } catch (e) { lost = null; }
        var ver = null, ren = null;
        try {
          ver = String(g.getParameter(g.VERSION) || '');
          ren = String(g.getParameter(g.RENDERER) || '');
        } catch (e) { ver = null; ren = null; }
        gl = {
          available: true,
          contextLost: lost,
          version: ver,
          renderer: ren,
          alpha: attrs ? !!attrs.alpha : null,
        };
      } else {
        gl = { available: false, contextLost: null, version: null, renderer: null, alpha: null };
      }
    }
  } catch (e) {
    gl = { available: false, contextLost: null, version: null, renderer: null, alpha: null };
  }
  var soak = null;
  try {
    if (window.__q2soakState) {
      var st = window.__q2soakState();
      soak = {
        booted: !!(window.__q2soak && window.__q2soak.booted),
        actualRenderer: String(st.renderer || ''),
        warning: st.warning == null ? null : String(st.warning),
        error: (window.__q2soak && window.__q2soak.error) || null,
        framesSubmitted: (typeof st.framesSubmitted === 'number') ? st.framesSubmitted : null,
        uploads: (typeof st.uploads === 'number') ? st.uploads : null,
        gpuActive: !!st.gpuActive,
      };
    } else if (window.__q2soak) {
      soak = {
        booted: !!window.__q2soak.booted,
        actualRenderer: String(window.__q2soak.actualRenderer || ''),
        warning: window.__q2soak.warning == null ? null : String(window.__q2soak.warning),
        error: window.__q2soak.error || null,
        framesSubmitted: null,
        uploads: null,
        gpuActive: false,
      };
    }
  } catch (e) { soak = null; }
  var cvars = null;
  try {
    if (window.__q2soakCvars) cvars = window.__q2soakCvars();
  } catch (e) { cvars = null; }
  return {
    hasQ2: !!q2,
    hasGl: !!glc,
    q2Background: bg,
    q2Rect: rectOf(q2),
    glRect: rectOf(glc),
    q2Canvas: canvasOf(q2),
    glCanvas: canvasOf(glc),
    devicePixelRatio: Number(window.devicePixelRatio) || 1,
    gl: gl,
    soak: soak,
    href: String(window.location ? window.location.href : ''),
    cvars: cvars,
  };
})()
`;

/** Run the production-page probe (single Runtime.evaluate, returnByValue). */
export function probePresentation(cdp: CdpConnection, timeoutMs = 60000): Promise<PresentationProbe> {
  return cdp.evaluate<PresentationProbe>(PROBE_JS, timeoutMs);
}

/**
 * Poll until the soak boot publishes booted=true. Throws on a page-side boot
 * error or on timeout (fail closed — never assert on a half-booted page).
 * Evaluate faults (e.g. mid-navigation) count as "not booted yet".
 */
export async function waitForSoakBoot(cdp: CdpConnection, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let polls = 0;
  let lastFault: string | null = null;
  for (;;) {
    polls++;
    let s: { booted?: boolean; error?: string | null } | null = null;
    try {
      s = await cdp.evaluate<{ booted?: boolean; error?: string | null } | null>(
        'window.__q2soak ? { booted: !!window.__q2soak.booted, error: window.__q2soak.error || null } : null',
        30000,
      );
      lastFault = null;
    } catch (err) {
      lastFault = err instanceof Error ? err.message : String(err);
      s = null;
    }
    if (s && s.booted) return;
    if (s && s.error) throw new Error(`[gpu-presentation] soak boot error: ${s.error}`);
    if (polls % 5 === 1) {
      console.log(
        `[gpu-presentation] soak boot waiting: polls=${polls} elapsed=${Date.now() - start}ms ` +
        `lastFault=${lastFault ?? 'none'}`,
      );
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `[gpu-presentation] soak boot timeout (${timeoutMs}ms, polls=${polls}): ` +
        `__q2soak.booted never true; lastFault=${lastFault ?? 'none'}`,
      );
    }
    await new Promise<void>((r) => setTimeout(r, 2000));
  }
}

// --- Production-page serving (vite dev + pak bytes, like gpu-soak.mjs) ---

/** Resolved production-page dependencies (null fields mean SKIP, never fail). */
export interface PresentationDeps {
  pakPath: string;
  chromiumBin: string;
  viteBin: string;
  webRoot: string;
}

/** Locate vite (repo node_modules/.bin/vite, the gpu-soak.mjs choice). */
export function viteBinaryPath(repoRoot: string): string | null {
  const cands = [join(repoRoot, 'node_modules', '.bin', 'vite')];
  for (const c of cands) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

/** Repo root from this module (packages/testkit/src → repo root). */
export function repoRootFromHere(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/**
 * Resolve every production-page dependency. Returns null + a reason when the
 * environment cannot drive the production page (caller SKIPs gracefully).
 */
export function resolvePresentationDeps(): { deps: PresentationDeps } | { skip: string } {
  const pakPath = resolvePakPath();
  if (!pakPath) {
    return {
      skip:
        '[gpu-presentation] SKIP: no pak0.pak (set Q2_PAK or check out the sibling external/q2)',
    };
  }
  const chromiumBin = chromiumBinaryPath();
  if (!chromiumBin) {
    return {
      skip: '[gpu-presentation] SKIP: no chromium binary (tried $CHROMIUM_BIN and /usr/bin/chromium)',
    };
  }
  const repoRoot = repoRootFromHere();
  const viteBin = viteBinaryPath(repoRoot);
  if (!viteBin) {
    return { skip: '[gpu-presentation] SKIP: no vite binary (run yarn install; need node_modules/.bin/vite)' };
  }
  return { deps: { pakPath, chromiumBin, viteBin, webRoot: join(repoRoot, 'apps', 'web') } };
}

export interface PresentationServer {
  url: string;
  close(): Promise<void>;
}

/** Serve raw pak bytes at /pak0.pak (whole-file GET/HEAD, CORS-open, like gpu-soak.mjs). */
export function startPakFileServer(pakPath: string): Promise<PresentationServer> {
  return new Promise<PresentationServer>((resolvePromise, reject) => {
    const server: Server = createServer((req, res) => {
      try {
        const url = (req.url ?? '/').split('?')[0] ?? '/';
        if (url !== '/pak0.pak') {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
          return;
        }
        const st = statSync(pakPath);
        const base = {
          'content-type': 'application/octet-stream',
          'access-control-allow-origin': '*',
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
        };
        if (req.method === 'HEAD') {
          res.writeHead(200, { ...base, 'content-length': String(st.size) });
          res.end();
          return;
        }
        res.writeHead(200, { ...base, 'content-length': String(st.size) });
        if (req.method !== 'GET') {
          res.end();
          return;
        }
        createReadStream(pakPath).pipe(res);
      } catch {
        try {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('server error');
        } catch {
          /* socket gone */
        }
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr.port !== 'number') {
        server.close(() => undefined);
        reject(new Error('[gpu-presentation] pak server yielded no port'));
        return;
      }
      resolvePromise({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => {
          server.close(() => undefined);
          return Promise.resolve();
        },
      });
    });
  });
}

/** Wait for an HTTP 200 at url (vite transform warmup can be slow on boot 1). */
export async function waitHttpOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`[gpu-presentation] server not ready: ${url}`);
    await new Promise<void>((r) => setTimeout(r, 1000));
  }
}

/**
 * Start the vite dev server for apps/web and resolve its Local URL by parsing
 * stdout (no --strictPort: the runner picks whatever port is free from the
 * hint). The child is reaped by close().
 */
export function startViteDev(webRoot: string, viteBin: string, portHint = 5191): Promise<PresentationServer> {
  return new Promise<PresentationServer>((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(
        process.execPath,
        [viteBin, '--port', String(portHint), '--host', '127.0.0.1'],
        { cwd: webRoot, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      reject(new Error(`[gpu-presentation] vite spawn failed: ${String(err)}`));
      return;
    }
    let out = '';
    let settled = false;
    const kill = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 8000);
    };
    const fail = (msg: string): void => {
      if (settled) return;
      settled = true;
      kill();
      reject(new Error(msg));
    };
    const onData = (chunk: Uint8Array): void => {
      if (settled) return;
      out += String(chunk);
      const m = /Local:\s+(http:\/\/\S+)/.exec(out);
      if (m) {
        settled = true;
        const url = (m[1] ?? '').replace(/\/$/, '');
        resolvePromise({
          url,
          close: () => {
            kill();
            return Promise.resolve();
          },
        });
      }
      if (out.length > 200000) out = out.slice(-50000);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    setTimeout(() => {
      fail('[gpu-presentation] vite did not print a Local URL within 60s. tail: ' + out.slice(-2000));
    }, 60000);
    child.on('error', (err: Error) => {
      fail(`[gpu-presentation] vite process error: ${err.message}`);
    });
    child.on('exit', (code: number | null) => {
      if (!settled) fail(`[gpu-presentation] vite exited early (code ${code}). tail: ` + out.slice(-2000));
    });
  });
}

/** Soak boot query for a leg (mirrors the gpu-soak.mjs page URL shape). */
export function soakPageUrl(
  viteUrl: string,
  pakServerUrl: string,
  renderer: string,
  extraCvars?: Record<string, string>,
): string {
  const pakUrl = `${pakServerUrl}/pak0.pak`;
  let url =
    `${viteUrl}/?q2soak=1&q2pak=${encodeURIComponent(pakUrl)}` +
    `&q2renderer=${encodeURIComponent(renderer)}`;
  if (extraCvars && Object.keys(extraCvars).length > 0) {
    const cvars = Object.entries(extraCvars)
      .map(([k, v]) => `${k}:${v}`)
      .join(';');
    url += `&q2cvars=${encodeURIComponent(cvars)}`;
  }
  return url;
}

/**
 * Reload the production page at a new URL (renderer/resolution switch) and
 * wait for the fresh soak boot. The CDP target survives same-page reloads,
 * but `__q2soak.booted` does not distinguish the old document from the new
 * one — so this first waits for the old status to go away (absent or rotated
 * t0) and only then waits for the fresh boot.
 */
export async function reloadProductionPage(
  cdp: CdpConnection,
  url: string,
  bootTimeoutMs: number,
): Promise<void> {
  let prevT0: number | null = null;
  try {
    prevT0 = await cdp.evaluate<number | null>(
      'window.__q2soak && typeof window.__q2soak.t0 === \'number\' ? window.__q2soak.t0 : null',
      30000,
    );
  } catch {
    prevT0 = null;
  }
  await cdp.evaluate<string>(`window.location.href = ${JSON.stringify(url)}; 'navigating'`, 30000);
  const goneDeadline = Date.now() + 120000;
  for (;;) {
    let cur: { absent: boolean; t0: number | null } = { absent: true, t0: null };
    try {
      cur = await cdp.evaluate<{ absent: boolean; t0: number | null }>(
        'window.__q2soak ? { absent: false, t0: window.__q2soak.t0 } : { absent: true, t0: null }',
        30000,
      );
    } catch {
      cur = { absent: true, t0: null };
    }
    if (cur.absent || (prevT0 !== null && cur.t0 !== null && cur.t0 !== prevT0)) break;
    if (Date.now() > goneDeadline) {
      throw new Error('[gpu-presentation] reload never unloaded the old document (stale soak status)');
    }
    await new Promise<void>((r) => setTimeout(r, 500));
  }
  await waitForSoakBoot(cdp, bootTimeoutMs);
}

/**
 * Chromium flags per leg (mirrors the gpu-soak.mjs split, adapted for a
 * presentation gate): the GPU leg uses software WebGL2 (SwiftShader ANGLE) —
 * a real WebGL2 context compiling the production shaders with real page
 * compositing, portable to machines without hardware GL. A CSS-overlay
 * presentation defect reproduces identically on any GL backend, so hardware
 * backing is not required for this gate (unlike the PROOF-5 cadence gate).
 */
export function chromiumFlagsForRenderer(renderer: string): string[] {
  if (renderer === 'webgl2-experimental') {
    return ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  }
  return ['--disable-gpu', '--enable-unsafe-swiftshader'];
}

/**
 * Launch chromium directly on a production page URL (wraps the shared
 * launchChromium with a scratch profile). Extra flags select the GL backend.
 */
export function launchProductionChromium(
  pageUrl: string,
  profileDir: string,
  extraFlags: string[],
): Promise<{ port: number; kill(): void }> {
  // NOTE: gpu-browser.launchChromium pins SwiftShader flags internally, so the
  // GPU leg needs its own spawn here (hardware GL via --use-angle=gl-egl).
  const bin = chromiumBinaryPath();
  if (!bin) throw new Error('[gpu-presentation] SKIP: no chromium binary');
  return new Promise<{ port: number; kill(): void }>((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(
        bin,
        [
          '--headless',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--mute-audio',
          '--no-first-run',
          '--no-default-browser-check',
          '--hide-scrollbars',
          '--remote-debugging-port=0',
          `--user-data-dir=${profileDir}`,
          ...extraFlags,
          pageUrl,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
    } catch (err) {
      reject(new Error(`[gpu-presentation] chromium spawn failed: ${String(err)}`));
      return;
    }
    let stderr = '';
    let settled = false;
    const kill = (): void => {
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
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        kill();
        reject(
          new Error('[gpu-presentation] chromium: no DevTools port within 30s. tail: ' + stderr.slice(-2000)),
        );
      }
    }, 30000);
    child.stderr?.on('data', (chunk: Uint8Array) => {
      if (settled) return;
      stderr += String(chunk);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (m) {
        const portM = /127\.0\.0\.1:(\d+)/.exec(m[1] ?? '');
        if (portM) {
          settled = true;
          clearTimeout(timeout);
          resolvePromise({ port: Number(portM[1]), kill });
        }
      }
    });
    child.on('error', (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`[gpu-presentation] chromium process error: ${err.message}`));
      }
    });
    child.on('exit', (code: number | null) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`[gpu-presentation] chromium exited early (code ${code}). tail: ` + stderr.slice(-2000)));
      }
    });
  });
}

export type { CdpConnection };
