// GPU-FOLLOW-3B apps/web lane: production-path water seam localization +
// fix verification (test-only, no production behavior change).
//
// Drives the PRODUCTION page (vite + soak + SwiftShader WebGL2, the exact
// `bootPlay` webgl2-experimental path the shipped rAF tick uses) on base1
// and records, per view: map / camera / material / time + CLOSE CROPS with
// annotated seam-line pixel coordinates.
//
// Defect discriminator (box 1): the SAME view captured at 3 warp phases.
// Edges that MOVE between phases are warp/repeat-boundary attributed (the
// reported tile-seam defect: warp floor() steps fold into the tap); edges
// STATIC across phases are geometry/lightmap/source-art attributed
// (adjacent BSP faces, luxel borders). Prior wrap/ROI metrics could not
// reject the defect because they pooled both classes; this lane scores them
// separately and fails on long MOVING lines (full-bbox-width/height runs)
// with peak row/column coordinates.
//
// Verification (box 3): the same matrix re-captured after the
// webgl-renderer fix lands must show the moving-line scores at ~0 while
// flow (inter-phase motion), lighting, sky and occlusion stay intact. If
// the fix has NOT landed, the moving-line asserts fail with the exact
// view/time/coords — that failure IS the box-1 defect proof.
//
// Legs:
//   - headless (Q2_PAK): pool view through production `frameGpuPlay`:
//     turbulent+translucent selection is deterministic stationary, advances
//     across sim times (flow alive), sky/wall census intact.
//   - real page (chromium, Q2_PAK): 2 views x 3 times matrix + sky view,
//     every capture scored; injected-seam control proves the metric can
//     fail; route snapshot confirms enemies/walls/submissions + clean
//     console. PNG artifacts land under test-output/ and are DELETED after
//     analysis (only the JSON report + console summary remain; the dir is
//     gitignored — nothing is ever committed).
import { afterEach, describe, expect, it } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { accessSync, constants, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { createServer } from 'http';
import { v3 } from '@q2/math';
import { bootPlay, frameGpuPlay } from './play.js';
import { censusSceneMaterials, censusWorldMaterials } from './gpu-effects.js';

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g['document'];
});

const WEB_Q2_PAK = process.env.Q2_PAK;
const CHROMIUM_BIN = process.env.CHROMIUM_BIN ?? '/usr/bin/chromium';

/** base1 pool: production soak camera (player + 22 standing). */
const POOL = { x: 416, y: 900, z: -100 };
/**
 * Recorded defect view (user report; testkit box-2 lane record): the pool
 * surface (surf 127 front side) faced from ~[416,1040,-244] yaw 90 pitch -6.
 * The older (416,900,-100)/pitch-30 legs show the pool only in small
 * patches; the seam hunt belongs HERE, facing the water.
 */
const DEFECT_VIEW = { x: 416, y: 1040, z: -244, yaw: 90, pitch: -6 };
/** Map/material under test (recorded in every report line). */
const MAP = 'base1';
const MATERIAL = 'textures/e1u1/bluwter.wal 64x64 TRANS66';

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

describe.runIf(!!WEB_Q2_PAK)('gpu-water-seam headless pool selection (Q2_PAK)', () => {
  it('stationary deterministic, moving across sim times, transparent water ON', { timeout: 180000 }, () => {
    return (async () => {
      installStubDoc();
      const boot = await loadPakBoot();
      const census = censusWorldMaterials(boot.driver.mini);
      expect(census.sky, 'sky faces exist (sky repair input)').toBeGreaterThan(0);
      expect(census.turbulent, 'turbulent water exists').toBeGreaterThan(0);
      expect(census.opaque, 'opaque walls exist').toBeGreaterThan(0);
      boot.driver.pm.origin = v3(POOL.x, POOL.y, POOL.z - 22);
      boot.driver.pm.velocity = v3();
      boot.driver.pm.viewAngles = v3(30, 90, 0);
      boot.host.input.angles = [30, 90, 0];
      let now = 0;
      for (let i = 0; i < 12; i++) {
        now += 16;
        frameGpuPlay(boot, now);
      }
      const first = censusSceneMaterials(boot.gpu!.scene);
      expect(first.turbulent, 'pool view submits turbulent water').toBeGreaterThan(0);
      // Transparent water ON: every submitted turbulent ref rides the blend pass.
      const turbRefs = boot.gpu!.scene.surfaces.filter((r) => r.material === 'turbulent');
      expect(turbRefs.length).toBeGreaterThan(0);
      for (const r of turbRefs) expect(r.transparent, 'water refs transparent (TRANS66)').toBe(true);
      // Stationary replay at the same sim time: identical selection.
      frameGpuPlay(boot, now);
      expect(censusSceneMaterials(boot.gpu!.scene)).toEqual(first);
      // Moving across sim times (warp phases): selection stays live.
      const seen = new Set<string>();
      for (let k = 0; k < 3; k++) {
        now += 1200;
        frameGpuPlay(boot, now);
        const c = censusSceneMaterials(boot.gpu!.scene);
        expect(c.turbulent, `turbulent live at sim step ${k}`).toBeGreaterThan(0);
        seen.add(JSON.stringify(c));
      }
      console.log(`[water-seam] headless map=${MAP} material=${MATERIAL} turbulent=${first.turbulent} phases=${seen.size}`);
    })();
  });
});

// --- real page (chromium, Q2_PAK): 2 views x 3 times + sky -------------------

interface CdpKey { key: string; code: string; windowsVirtualKeyCode: number; nativeVirtualKeyCode: number; }

interface BrowserPage {
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
  keyDown(key: CdpKey): Promise<void>;
  keyUp(key: CdpKey): Promise<void>;
  screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<string>;
  close(): void;
}

const KEY_LEFT: CdpKey = { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 };
const KEY_RIGHT: CdpKey = { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 };
const KEY_PAGEDOWN: CdpKey = { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34 };
const KEY_PAGEUP: CdpKey = { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33, nativeVirtualKeyCode: 33 };

// Seam analyzer: decodes N captures of the SAME view at different warp
// phases and scores edge classes separately:
//   all     — edgy in any capture (prior pooled metric, kept for reference);
//   static  — edgy in ALL captures (geometry/lightmap/source-art attributed);
//   moving  — edgy in exactly ONE capture (warp/repeat-boundary attributed).
// A repeat-boundary seam from warp floor() steps is a long straight run:
// full-bbox-height vertical (maxColH) or full-bbox-width horizontal
// (maxRowV), reported with absolute canvas pixel coordinates.
const SEAM_ANALYZE_INSTALL = `window.__q2seam2 = async (shots, inject) => {
  const dec = async (b) => {
    const blob = await (await fetch('data:image/png;base64,' + b)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(bmp, 0, 0);
    if (inject === 'line') {
      // Partial-width white line drawn ACROSS CLEAN WATER (left of the gun
      // block, inside the typical pool bbox): white always steps hard on
      // dark water, so a working metric must report a long run here.
      x.fillStyle = '#fff';
      x.fillRect(c.width * 0.05, (c.height * 0.78) | 0, c.width * 0.4, 1);
    }
    const d = x.getImageData(0, 0, c.width, c.height).data;
    bmp.close();
    return { w: c.width, h: c.height, d };
  };
  const A = [];
  for (const s of shots) A.push(await dec(s));
  const W = A[0].w, H = A[0].h, N = A.length;
  const lum = (im, px, py) => { const o = (py * W + px) * 4; return (im.d[o] + im.d[o+1] + im.d[o+2]) / 3; };
  // Full-frame motion field (below the HUD text band): the water region is
  // found from ANIMATION, not from a fixed ROI — the pool fills different
  // frame areas per view. Static HUD/gun/crosshair/sky never enter the mask.
  const x0 = 0, x1 = W, y0 = (H * 0.08) | 0, y1 = H;
  const RW = x1 - x0, RH = y1 - y0;
  // Static-occluder mask (composed page furniture over the GL scene — HUD
  // 2D overlay: viewmodel gun, bottom status bar, center crosshair). These
  // pixels never show water; their silhouettes against shimmering water
  // would forge phase-varying boundary edges. Excluded from motion AND
  // edge scoring (water visible around them still scores).
  const inOccluder = (px, py) => {
    if (px >= W * 0.53 && py >= H * 0.5) return true; // viewmodel gun block
    if (py >= H * 0.9) return true; // bottom status bar
    if (Math.abs(px - W / 2) < 9 && Math.abs(py - H / 2) < 9) return true; // crosshair
    return false;
  };
  // Motion mask between consecutive phases (|Δlum| > 10): water warp
  // shimmers; walls/sky/HUD/gun are static.
  const pairMasks = [];
  for (let k = 1; k < N; k++) {
    const m = new Uint8Array(RW * RH);
    for (let py = 0; py < RH; py++) for (let px = 0; px < RW; px++) {
      if (inOccluder(x0 + px, y0 + py)) continue;
      const d = Math.abs(lum(A[k], x0 + px, y0 + py) - lum(A[k-1], x0 + px, y0 + py));
      if (d > 10) m[py * RW + px] = 1;
    }
    pairMasks.push(m);
  }
  const motion = new Uint8Array(RW * RH);
  let motionCount = 0;
  for (let i = 0; i < RW * RH; i++) {
    for (const m of pairMasks) {
      if (m[i]) { motion[i] = 1; break; }
    }
    if (motion[i]) motionCount++;
  }
  // Stable shimmer = motion in EVERY pair (persistently animating water).
  // A walking monster moves to new pixels per pair (disjoint masks); water
  // shimmers in place (large stable intersection).
  const stable = new Uint8Array(RW * RH);
  let stableCount = 0;
  for (let i = 0; i < RW * RH; i++) {
    let all = pairMasks.length > 0 ? true : false;
    for (const m of pairMasks) { if (!m[i]) { all = false; break; } }
    if (all) { stable[i] = 1; stableCount++; }
  }
  const bboxOf = (mask) => {
    let qx0 = RW, qy0 = RH, qx1 = -1, qy1 = -1;
    for (let py = 0; py < RH; py++) for (let px = 0; px < RW; px++) {
      if (mask[py * RW + px]) {
        if (px < qx0) qx0 = px; if (px > qx1) qx1 = px;
        if (py < qy0) qy0 = py; if (py > qy1) qy1 = py;
      }
    }
    if (qx1 < 0) return null;
    qx0 = Math.max(0, qx0 - 6); qy0 = Math.max(0, qy0 - 6);
    qx1 = Math.min(RW - 1, qx1 + 6); qy1 = Math.min(RH - 1, qy1 + 6);
    return [x0 + qx0, y0 + qy0, x0 + qx1, y0 + qy1];
  };
  const wbox = bboxOf(motion);
  const sbox = pairMasks.length >= 2 ? bboxOf(stable) : wbox;
  // Per-capture edge maps (h: adjacent-col step = vertical edge;
  // v: adjacent-row step = horizontal edge), threshold 40 like prior legs.
  const hedges = [], vedges = [];
  for (let k = 0; k < N; k++) {
    const he = new Uint8Array(RW * RH), ve = new Uint8Array(RW * RH);
    for (let py = 0; py < RH; py++) for (let px = 0; px < RW - 1; px++) {
      if (inOccluder(x0 + px, y0 + py) || inOccluder(x0 + px + 1, y0 + py)) continue;
      if (Math.abs(lum(A[k], x0 + px + 1, y0 + py) - lum(A[k], x0 + px, y0 + py)) > 40) he[py * RW + px] = 1;
    }
    for (let py = 0; py < RH - 1; py++) for (let px = 0; px < RW; px++) {
      if (inOccluder(x0 + px, y0 + py) || inOccluder(x0 + px, y0 + py + 1)) continue;
      if (Math.abs(lum(A[k], x0 + px, y0 + py + 1) - lum(A[k], x0 + px, y0 + py)) > 40) ve[py * RW + px] = 1;
    }
    hedges.push(he); vedges.push(ve);
  }
  // Edge scoring runs inside the water bbox (falls back to the full ROI).
  const bwq = wbox ? [wbox[0] - x0, wbox[1] - y0, wbox[2] - x0, wbox[3] - y0] : [0, 0, RW - 1, RH - 1];
  const bx0 = Math.max(0, Math.min(RW - 1, bwq[0]));
  const by0 = Math.max(0, Math.min(RH - 1, bwq[1]));
  const bx1 = Math.max(0, Math.min(RW - 1, bwq[2]));
  const by1 = Math.max(0, Math.min(RH - 1, bwq[3]));
  const BW = bx1 - bx0 + 1, BH = by1 - by0 + 1;
  const score = (cls) => {
    // cls: 'all' | 'static' | 'moving'
    // static = edgy in ALL captures (geometry/lightmap/source-art class);
    // moving = edgy in SOME but not all (warp-phase-varying class: the
    // repeat-boundary defect lives here — a warp seam sits at a FIXED
    // screen line (fixed texture row) but its STEP varies with phase, so
    // it flickers across captures instead of sitting still).
    const hsel = new Uint8Array(RW * RH), vsel = new Uint8Array(RW * RH);
    let hTot = 0, vTot = 0;
    for (let py = by0; py <= by1; py++) for (let px = bx0; px <= bx1; px++) {
      const i = py * RW + px;
      let hc = 0, vc = 0;
      for (let k = 0; k < N; k++) { hc += hedges[k][i]; vc += vedges[k][i]; }
      const h = cls === 'all' ? hc > 0 : cls === 'static' ? hc === N : (hc > 0 && hc < N);
      const v = cls === 'all' ? vc > 0 : cls === 'static' ? vc === N : (vc > 0 && vc < N);
      if (h) { hsel[i] = 1; hTot++; }
      if (v) { vsel[i] = 1; vTot++; }
    }
    // Long-line runs: per-column h-density (vertical lines), per-row
    // v-density (horizontal lines), with peak coordinates (ROI-relative).
    let maxColH = 0, peakColH = -1, maxRowV = 0, peakRowV = -1;
    for (let px = bx0; px <= bx1; px++) {
      let n = 0;
      for (let py = by0; py <= by1; py++) n += hsel[py * RW + px];
      const f = n / BH;
      if (f > maxColH) { maxColH = f; peakColH = px; }
    }
    for (let py = by0; py <= by1; py++) {
      let n = 0;
      for (let px = bx0; px <= bx1; px++) n += vsel[py * RW + px];
      const f = n / BW;
      if (f > maxRowV) { maxRowV = f; peakRowV = py; }
    }
    // Per-phase strength at the pooled peak row/col: warp seams VARY with
    // phase (fixed screen line, flickering step); lightmap borders and
    // face edges are CONSTANT across phases.
    const perPhaseRowV = [], perPhaseColH = [];
    for (let k = 0; k < N; k++) {
      if (peakRowV >= 0) {
        let n = 0;
        for (let px = bx0; px <= bx1; px++) n += vedges[k][peakRowV * RW + px];
        perPhaseRowV.push(n / BW);
      } else perPhaseRowV.push(0);
      if (peakColH >= 0) {
        let n = 0;
        for (let py = by0; py <= by1; py++) n += hedges[k][py * RW + peakColH];
        perPhaseColH.push(n / BH);
      } else perPhaseColH.push(0);
    }
    return {
      hFrac: hTot / (BW * BH), vFrac: vTot / (BW * BH),
      maxColH, peakColH: peakColH < 0 ? null : x0 + peakColH,
      maxRowV, peakRowV: peakRowV < 0 ? null : y0 + peakRowV,
      perPhaseRowV, perPhaseColH,
    };
  };
  // Pairwise water motion (flow proof): changed fraction INSIDE the water
  // bbox between phases (framing-independent: full-frame dilution would
  // bury the shimmer of a small water patch).
  const dWin = wbox ? [wbox[0] - x0, wbox[1] - y0, wbox[2] - x0, wbox[3] - y0] : [0, 0, RW - 1, RH - 1];
  const dArea = (dWin[2] - dWin[0] + 1) * (dWin[3] - dWin[1] + 1);
  const diffs = [];
  for (let k = 1; k < N; k++) {
    let d = 0;
    for (let py = dWin[1]; py <= dWin[3]; py++) for (let px = dWin[0]; px <= dWin[2]; px++) {
      if (Math.abs(lum(A[k], x0 + px, y0 + py) - lum(A[k-1], x0 + px, y0 + py)) > 8) d++;
    }
    diffs.push(d / dArea);
  }
  let nb0 = 0;
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    if (lum(A[0], px, py) > 8) nb0++;
  }
  return {
    w: W, h: H, roi: [x0, y0, x1, y1], waterBbox: wbox, stableBbox: sbox,
    motionFrac: motionCount / (RW * RH), stableFrac: stableCount / (RW * RH),
    roiDiffs: diffs, nonblack: nb0 / (W * H),
    all: score('all'), stat: score('static'), moving: score('moving'),
  };
};
window.__q2crop = async (b64, r) => {
  const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
  const bmp = await createImageBitmap(blob);
  const src = document.createElement('canvas');
  src.width = bmp.width; src.height = bmp.height;
  const sx = src.getContext('2d', { willReadFrequently: true });
  sx.drawImage(bmp, 0, 0);
  bmp.close();
  const cx0 = Math.max(0, Math.min(src.width - 1, r.x0 | 0)), cy0 = Math.max(0, Math.min(src.height - 1, r.y0 | 0));
  const cx1 = Math.max(cx0 + 1, Math.min(src.width, r.x1 | 0)), cy1 = Math.max(cy0 + 1, Math.min(src.height, r.y1 | 0));
  const c = document.createElement('canvas');
  c.width = cx1 - cx0; c.height = cy1 - cy0;
  const x = c.getContext('2d');
  x.drawImage(src, cx0, cy0, c.width, c.height, 0, 0, c.width, c.height);
  // Annotate peak seam lines (red): horizontal at peakRowV, vertical at peakColH.
  x.fillStyle = '#f00';
  for (const ry of (r.rows || [])) { const y = (ry | 0) - cy0; if (y >= 0 && y < c.height) x.fillRect(0, y, c.width, 1); }
  for (const cx of (r.cols || [])) { const xx = (cx | 0) - cx0; if (xx >= 0 && xx < c.width) x.fillRect(xx, 0, 1, c.height); }
  x.fillStyle = '#0f0';
  x.fillRect(0, 0, Math.min(8, c.width), Math.min(8, c.height));
  const url = c.toDataURL('image/png');
  return url.slice(url.indexOf(',') + 1);
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

interface SeamClass {
  hFrac: number; vFrac: number;
  maxColH: number; peakColH: number | null;
  maxRowV: number; peakRowV: number | null;
  perPhaseRowV: number[]; perPhaseColH: number[];
}
interface SeamResult {
  w: number; h: number; roi: [number, number, number, number];
  waterBbox: [number, number, number, number] | null;
  stableBbox: [number, number, number, number] | null;
  motionFrac: number; stableFrac: number; roiDiffs: number[]; nonblack: number;
  all: SeamClass; stat: SeamClass; moving: SeamClass;
}

function outDir(): string {
  const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test-output'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe.runIf(!!WEB_Q2_PAK)('gpu-water-seam real-page matrix (chromium, Q2_PAK)', () => {
  it('2 views x 3 warp phases: locate seams, verify fix, keep sky/occlusion', { timeout: 600000 }, async () => {
    let chromiumPresent = false;
    try {
      accessSync(CHROMIUM_BIN, constants.X_OK);
      chromiumPresent = true;
    } catch {
      chromiumPresent = false;
    }
    if (!chromiumPresent) {
      console.log('[water-seam] browser SKIP: no chromium binary');
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
    const vitePort = Number(process.env.WATER_SEAM_VITE_PORT ?? 5195);
    const viteProc = spawn(process.execPath, [viteBin, '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], {
      cwd: appDir, stdio: ['ignore', 'ignore', 'ignore'],
    });
    const pngs: string[] = [];
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
      const userDataDir = join(tmpdir(), `q2-water-seam-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
      mkdirSync(userDataDir, { recursive: true });
      const chromium = await launchChromium(pageUrl, userDataDir);
      try {
        const { page, consoleLines } = await connectCdp(chromium.port);
        try {
          type SoakBoot = {
            booted?: boolean; error?: string | null; actualRenderer?: string;
            warning?: string | null; glRenderer?: string | null;
          } | null;
          let status: SoakBoot = null;
          const bootDeadline = Date.now() + 240000;
          for (;;) {
            status = await page.evaluate<SoakBoot>('window.__q2soak ? window.__q2soak : null', 30000).catch(() => null);
            if (status && status.booted) break;
            if (status && status.error) throw new Error(`page boot error: ${status.error}`);
            if (Date.now() > bootDeadline) throw new Error('soak boot timeout (240s)');
            await sleep(2000);
          }
          expect(status!.actualRenderer).toBe('webgl2-experimental');
          expect(status!.warning).toBeNull();
          // Renderer string (localization record: SwiftShader GL in headless).
          const soakState0 = await page.evaluate('window.__q2soakState ? window.__q2soakState() : null', 15000) as {
            glRenderer?: string | null; gpuActive?: boolean; framesSubmitted?: number | null; uploads?: number | null;
          } | null;
          const rendererString = status!.glRenderer ?? soakState0?.glRenderer ?? '<unmasked>';
          console.log(`[water-seam] renderer=${status!.actualRenderer} gl=${rendererString}`);
          expect(soakState0?.gpuActive).toBe(true);
          await page.evaluate(SEAM_ANALYZE_INSTALL, 30000);

          const routeOf = (): Promise<{
            camera?: { origin: number[]; angles: number[] } | null;
            aliveMonsters?: number; monsterKinds?: string[];
            scene?: { worldOpaque: number; worldTransparent: number; entityRefs: number } | null;
            effects?: { turbulent?: number } | null;
            framesSubmitted?: number | null; uploads?: number | null; warnings?: string[];
          } | null> => page.evaluate('window.__q2soakRoute ? window.__q2soakRoute() : null', 15000);

          const camAngles = async (): Promise<[number, number] | null> => {
            const r = await routeOf().catch(() => null);
            const a = r?.camera?.angles;
            return a && a.length >= 2 ? [a[0], a[1]] : null;
          };
          const wrapYaw = (y: number): number => ((y % 360) + 360) % 360;
          const yawDist = (a: number, b: number): number => {
            const d = Math.abs(wrapYaw(a) - wrapYaw(b));
            return Math.min(d, 360 - d);
          };
          // Closed-loop aim through real CDP key input (never page-code
          // input synthesis): probe each axis sign with a short tap, then
          // drive to the target, re-polling the route camera.
          const aimAt = async (targetYaw: number, targetPitch: number): Promise<[number, number]> => {
            // Signed remaining distance in axis space (degrees).
            const yawNeed = async (): Promise<number | null> => {
              const a = await camAngles();
              return a ? ((wrapYaw(targetYaw) - wrapYaw(a[1]) + 540) % 360) - 180 : null;
            };
            const pitchNeed = async (): Promise<number | null> => {
              const a = await camAngles();
              return a ? targetPitch - a[0] : null;
            };
            const driveAxis = async (
              need: () => Promise<number | null>,
              tap: CdpKey, alt: CdpKey, tol: number,
            ): Promise<void> => {
              for (let i = 0; i < 30; i++) {
                const n0 = await need();
                if (n0 === null || Math.abs(n0) < tol) break;
                // Probe: tap once, observe motion sign in axis space.
                await page.keyDown(tap);
                await sleep(150);
                await page.keyUp(tap);
                const n1 = await need();
                if (n1 === null) break;
                if (Math.abs(n1) < tol) break;
                // Hold the key whose axis motion reduces the need: tap moves
                // the axis by tapDelta (n0 - n1); alt is its opposite.
                const tapDelta = n0 - n1;
                const key = tapDelta !== 0 && Math.sign(tapDelta) === Math.sign(n1) ? tap : alt;
                await page.keyDown(key);
                for (let j = 0; j < 20; j++) {
                  await sleep(100);
                  const c = await need();
                  if (c === null || Math.abs(c) < tol) break;
                }
                await page.keyUp(key);
              }
            };
            // Yaw: ArrowLeft/Right (sign calibrated live by the probe above).
            await driveAxis(yawNeed, KEY_LEFT, KEY_RIGHT, 5);
            // Pitch: PageDown = down/positive, PageUp = up/negative.
            await driveAxis(pitchNeed, KEY_PAGEDOWN, KEY_PAGEUP, 4);
            const fin = await camAngles();
            if (!fin) throw new Error('aim failed: no camera');
            return fin;
          };

          const boxOf = (): Promise<{ x: number; y: number; width: number; height: number }> =>
            page.evaluate(
              '(() => { const c = document.querySelector("#q2"); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()',
              30000,
            ) as Promise<{ x: number; y: number; width: number; height: number }>;

          const dir = outDir();
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const report: Record<string, unknown> = {
            map: MAP, material: MATERIAL, renderer: 'webgl2-experimental',
            glRenderer: rendererString, transparentWater: 'TRANS66 (production default)',
          };

          const captureView = async (
            name: string, candidates: Array<{ tx: number; ty: number; tz: number; yaw: number; pitch: number }>,
          ): Promise<{ shots: string[]; seam: SeamResult; cameras: Array<{ origin: number[]; angles: number[] } | null>; frames: Array<number | null>; scenes: Array<{ worldOpaque: number; worldTransparent: number; entityRefs: number } | null | undefined>; chosen: { tx: number; ty: number; tz: number; yaw: number; pitch: number } }> => {
            let lastErr = '';
            for (const cand of candidates) {
              const { tx, ty, tz, yaw, pitch } = cand;
              const ok = await page.evaluate(
                `window.__q2soakTeleport ? window.__q2soakTeleport(${tx}, ${ty}, ${tz}) : false`,
                15000,
              ) as boolean;
              expect(ok, `${name}: teleport`).toBe(true);
              const aimed = await aimAt(yaw, pitch);
              console.log(`[water-seam] ${name} candidate (${tx},${ty},${tz}) yaw=${yaw} pitch=${pitch} aimed pitch=${aimed[0].toFixed(1)} yaw=${aimed[1].toFixed(1)}`);
              await sleep(1500);
              const box = await boxOf();
              expect(box.width, `${name}: canvas live`).toBeGreaterThan(100);
              // Motion pre-check: two shots 1.2s apart must show a WATER-SIZED
              // motion bbox (proves water is in frame at different warp
              // phases). roiDiff alone is not enough — a passing monster can
              // move pixels without any water present.
              const s0 = await page.screenshot(box);
              await sleep(1200);
              const s1 = await page.screenshot(box);
              const pre = await page.evaluate(
                `window.__q2seam2(${JSON.stringify([s0, s1])})`, 120000,
              ) as unknown as SeamResult;
              const preW = pre.waterBbox ? pre.waterBbox[2] - pre.waterBbox[0] + 1 : 0;
              const preH = pre.waterBbox ? pre.waterBbox[3] - pre.waterBbox[1] + 1 : 0;
              console.log(`[water-seam] ${name} precheck motionFrac=${pre.motionFrac.toFixed(4)} roiDiff=${pre.roiDiffs.map((d) => d.toFixed(4)).join(',')} waterBbox=${JSON.stringify(pre.waterBbox)}`);
              if (!(pre.waterBbox && preW >= 80 && preH >= 25)) {
                lastErr = `${name} candidate (${tx},${ty},${tz}) yaw=${yaw}: no water-sized motion (bbox=${JSON.stringify(pre.waterBbox)}) — water not in frame`;
                continue;
              }
              // Full matrix: reuse the two pre-check shots + one more phase.
              await sleep(1200);
              const s2 = await page.screenshot(box);
              const shots = [s0, s1, s2];
              for (let i = 0; i < shots.length; i++) {
                writeFileSync(join(dir, `water-seam-${stamp}-${name}-t${i}-full.png`), Buffer.from(shots[i]!, 'base64'));
                pngs.push(join(dir, `water-seam-${stamp}-${name}-t${i}-full.png`));
              }
              const cameras: Array<{ origin: number[]; angles: number[] } | null> = [];
              const frames: Array<number | null> = [];
              const scenes: Array<{ worldOpaque: number; worldTransparent: number; entityRefs: number } | null | undefined> = [];
              for (let i = 0; i < 3; i++) {
                const r = await routeOf().catch(() => null);
                cameras.push(r?.camera ?? null);
                frames.push(r?.framesSubmitted ?? null);
                scenes.push(r?.scene ?? null);
              }
              const seam = await page.evaluate(
                `window.__q2seam2(${JSON.stringify(shots)})`, 120000,
              ) as unknown as SeamResult;
              return { shots, seam, cameras, frames, scenes, chosen: cand };
            }
            throw new Error(`no water-bearing candidate for ${name}: ${lastErr}`);
          };

          const annotateCrop = async (
            name: string, idx: number, fullB64: string, seam: SeamResult,
          ): Promise<string> => {
            // Close crop 1: center ROI (legacy framing) with peak lines.
            const [rx0, ry0, rx1, ry1] = seam.roi;
            const rows = [seam.moving.peakRowV, seam.stat.peakRowV].filter((v): v is number => v !== null);
            const cols = [seam.moving.peakColH, seam.stat.peakColH].filter((v): v is number => v !== null);
            const cropB64 = await page.evaluate(
              `window.__q2crop(${JSON.stringify(fullB64)}, ${JSON.stringify({ x0: rx0, y0: ry0, x1: rx1, y1: ry1, rows, cols })})`,
              60000,
            ) as unknown as string;
            const p = join(dir, `water-seam-${stamp}-${name}-t${idx}-crop.png`);
            writeFileSync(p, Buffer.from(cropB64, 'base64'));
            pngs.push(p);
            // Close crop 2 (THE water close-up): zoom onto the motion-water
            // bbox expanded 1.5x (min 160px), annotated with the peak seam
            // lines — this is the user-visible defect proof framing.
            let wp = '';
            if (seam.waterBbox) {
              let [ax0, ay0, ax1, ay1] = seam.waterBbox;
              // Clean-water framing: cut the viewmodel gun block out of the
              // zoom (keep the wider clean side) so the close crop shows
              // water, not HUD furniture.
              const gunX = Math.floor(seam.w * 0.53);
              if (ax0 < gunX && ax1 >= gunX) {
                if (gunX - ax0 >= ax1 - gunX) ax1 = gunX - 1;
                else ax0 = gunX;
              }
              const cx = (ax0 + ax1) / 2, cy = (ay0 + ay1) / 2;
              let hw = Math.max(80, ((ax1 - ax0 + 1) * 1.5) / 2);
              let hh = Math.max(80, ((ay1 - ay0 + 1) * 1.5) / 2);
              hw = Math.min(hw, seam.w / 2);
              hh = Math.min(hh, seam.h / 2);
              const zoomB64 = await page.evaluate(
                `window.__q2crop(${JSON.stringify(fullB64)}, ${JSON.stringify({
                  x0: Math.max(0, cx - hw), y0: Math.max(0, cy - hh),
                  x1: Math.min(seam.w, cx + hw), y1: Math.min(seam.h, cy + hh),
                  rows, cols,
                })})`,
                60000,
              ) as unknown as string;
              wp = join(dir, `water-seam-${stamp}-${name}-t${idx}-watercrop.png`);
              writeFileSync(wp, Buffer.from(zoomB64, 'base64'));
              pngs.push(wp);
            }
            return wp || p;
          };

          // V0: the recorded defect view — facing the pool surface
          // (yaw ~105 from (416,1040,-244) shows the water; yaw 90 faces wall).
          const v0 = await captureView('V0-pool', [
            { tx: DEFECT_VIEW.x, ty: DEFECT_VIEW.y, tz: DEFECT_VIEW.z, yaw: 105, pitch: DEFECT_VIEW.pitch },
            { tx: DEFECT_VIEW.x, ty: DEFECT_VIEW.y, tz: DEFECT_VIEW.z, yaw: 90, pitch: DEFECT_VIEW.pitch },
            { tx: 416, ty: 1020, tz: -244, yaw: 105, pitch: -6 },
            { tx: POOL.x, ty: POOL.y, tz: POOL.z - 22, yaw: 90, pitch: 30 },
          ]);
          // V1: translated + angled variants around the water system (different
          // tiles, different view angle). The first water-bearing candidate
          // wins so the matrix always scores real water, never a dry wall.
          // The 1300/1301 surface (x 192-576, y 464-960, 6.0x7.8 tiles) is
          // the largest repeat-boundary field; it lies SOUTH of the defect
          // stance (yaw ~270), connected to the 117/118 pool at y~960-1024.
          const v1 = await captureView('V1-shift', [
            { tx: 416, ty: 1040, tz: -244, yaw: 270, pitch: -6 },
            { tx: 416, ty: 1040, tz: -244, yaw: 250, pitch: -10 },
            { tx: 384, ty: 900, tz: -244, yaw: 270, pitch: -6 },
            { tx: 352, ty: 990, tz: -244, yaw: 270, pitch: -15 },
            { tx: 456, ty: 1040, tz: -244, yaw: 105, pitch: -6 },
            { tx: POOL.x + 40, ty: POOL.y, tz: POOL.z - 22, yaw: 90, pitch: 30 },
          ]);

          const summarize = (
            name: string,
            v: { shots: string[]; seam: SeamResult; cameras: Array<{ origin: number[]; angles: number[] } | null>; frames: Array<number | null>; scenes: Array<{ worldOpaque: number; worldTransparent: number; entityRefs: number } | null | undefined> },
          ): void => {
            const s = v.seam;
            console.log(
              `[water-seam] ${name} map=${MAP} material=${MATERIAL} ` +
              `cam=${JSON.stringify(v.cameras[0])} frames=${JSON.stringify(v.frames)} ` +
              `scene=${JSON.stringify(v.scenes[0])} ` +
              `nonblack=${s.nonblack.toFixed(3)} motionFrac=${s.motionFrac.toFixed(4)} stableFrac=${s.stableFrac.toFixed(4)} ` +
              `roiDiffs=${s.roiDiffs.map((d) => d.toFixed(4)).join(',')} ` +
              `waterBbox=${JSON.stringify(s.waterBbox)} stableBbox=${JSON.stringify(s.stableBbox)}`,
            );
            for (const [cls, c] of [['all', s.all], ['static', s.stat], ['moving', s.moving]] as const) {
              console.log(
                `[water-seam] ${name}.${cls} hFrac=${c.hFrac.toFixed(4)} vFrac=${c.vFrac.toFixed(4)} ` +
                `maxColH=${c.maxColH.toFixed(3)}@x=${c.peakColH} perPhaseColH=[${c.perPhaseColH.map((v) => v.toFixed(3)).join(',')}] ` +
                `maxRowV=${c.maxRowV.toFixed(3)}@y=${c.peakRowV} perPhaseRowV=[${c.perPhaseRowV.map((v) => v.toFixed(3)).join(',')}]`,
              );
            }
          };
          summarize('V0-pool', v0);
          summarize('V1-shift', v1);

          // Close crops for every capture (annotated with peak seam coords).
          for (const [name, v] of [['V0-pool', v0], ['V1-shift', v1]] as const) {
            for (let i = 0; i < v.shots.length; i++) {
              const p = await annotateCrop(name, i, v.shots[i], v.seam);
              console.log(`[water-seam] crop ${p} roi=${JSON.stringify(v.seam.roi)}`);
            }
          }

          report['V0-pool'] = {
            chosen: v0.chosen, cameras: v0.cameras, frames: v0.frames,
            nonblack: v0.seam.nonblack, motionFrac: v0.seam.motionFrac, roiDiffs: v0.seam.roiDiffs,
            waterBbox: v0.seam.waterBbox, all: v0.seam.all, static: v0.seam.stat, moving: v0.seam.moving,
          };
          report['V1-shift'] = {
            chosen: v1.chosen, cameras: v1.cameras, frames: v1.frames,
            nonblack: v1.seam.nonblack, motionFrac: v1.seam.motionFrac, roiDiffs: v1.seam.roiDiffs,
            waterBbox: v1.seam.waterBbox, all: v1.seam.all, static: v1.seam.stat, moving: v1.seam.moving,
          };

          // --- verdicts -------------------------------------------------------
          for (const [name, v] of [['V0-pool', v0], ['V1-shift', v1]] as const) {
            const s = v.seam;
            // Capture live (dark pool views run <50% nonblack; motion below
            // proves liveness — this gate only rejects black/dead frames).
            expect(s.nonblack, `${name}: capture live`).toBeGreaterThan(0.25);
            for (const [k, d] of s.roiDiffs.entries()) {
              expect(d, `${name}: warp motion between phase ${k}->${k + 1} (flow ON)`).toBeGreaterThan(0.005);
            }
            // Stable-water proof: persistently shimmering bbox (a passing
            // monster gives disjoint pair masks and no stable intersection).
            const sw = s.stableBbox ? s.stableBbox[2] - s.stableBbox[0] + 1 : 0;
            const sh = s.stableBbox ? s.stableBbox[3] - s.stableBbox[1] + 1 : 0;
            expect(
              s.stableBbox !== null && sw >= 60 && sh >= 20,
              `${name}: stable water region (stableBbox=${JSON.stringify(s.stableBbox)})`,
            ).toBe(true);
            const transp = v.scenes.map((sc) => sc?.worldTransparent ?? -1);
            console.log(`[water-seam] ${name} worldTransparent per capture: ${JSON.stringify(transp)}`);
            for (const [k, t] of transp.entries()) {
              expect(t, `${name} capture ${k}: transparent water submits (TRANS66 ON)`).toBeGreaterThan(0);
            }
            // Pooled reference (prior metric shape): no long straight hard
            // edges anywhere in the water bbox.
            expect(s.all.hFrac, `${name}: sparse vertical hard edges`).toBeLessThan(0.05);
            expect(s.all.vFrac, `${name}: sparse horizontal hard edges`).toBeLessThan(0.05);
            expect(s.all.maxRowV, `${name}: no full-width horizontal seam (all) @y=${s.all.peakRowV}`).toBeLessThan(0.6);
            expect(s.all.maxColH, `${name}: no full-height vertical seam (all) @x=${s.all.peakColH}`).toBeLessThan(0.6);
            // Warp-attributed (THE defect class): long lines that MOVE with
            // the warp phase must be absent post-fix. Static long lines are
            // reported above (geometry/lightmap/art) but do not fail here.
            expect(
              s.moving.maxRowV,
              `${name}: no MOVING full-width seam line (repeat boundary) @y=${s.moving.peakRowV} ` +
              `static@${s.stat.peakRowV}=${s.stat.maxRowV.toFixed(3)}`,
            ).toBeLessThan(0.5);
            expect(
              s.moving.maxColH,
              `${name}: no MOVING full-height seam line (repeat boundary) @x=${s.moving.peakColH} ` +
              `static@${s.stat.peakColH}=${s.stat.maxColH.toFixed(3)}`,
            ).toBeLessThan(0.5);
            expect(s.moving.hFrac, `${name}: sparse moving vertical edges`).toBeLessThan(0.05);
            expect(s.moving.vFrac, `${name}: sparse moving horizontal edges`).toBeLessThan(0.05);
          }

          // Injected-seam control: the same analyzer MUST trip on a partial
          // line drawn across clean water on the REAL triplet (water motion
          // present, so the water bbox exists; the identical line on all 3
          // captures scores in the pooled/static class). Proves the metric
          // can fail on a long straight run in this exact framing.
          const injected = await page.evaluate(
            `window.__q2seam2(${JSON.stringify(v0.shots)}, "line")`,
            120000,
          ) as unknown as SeamResult;
          console.log(`[water-seam] injected waterBbox=${JSON.stringify(injected.waterBbox)} all.maxRowV=${injected.all.maxRowV.toFixed(3)}@y=${injected.all.peakRowV} moving.maxRowV=${injected.moving.maxRowV.toFixed(3)}`);
          expect(
            injected.waterBbox !== null && (injected.all.maxRowV > 0.6 || injected.all.vFrac > 0.05),
            `injected seam trips the metric (got maxRowV=${injected.all.maxRowV} bbox=${JSON.stringify(injected.waterBbox)})`,
          ).toBe(true);

          // Sky + occlusion intact around the pool (box 3): look up from V1,
          // capture, confirm live pixels + submissions advance; enemies live,
          // opaque walls submit, no backend warnings, console clean.
          const skyOk = await page.evaluate(
            `window.__q2soakTeleport ? window.__q2soakTeleport(${POOL.x + 80}, ${POOL.y}, ${POOL.z - 22}) : false`,
            15000,
          ) as boolean;
          expect(skyOk).toBe(true);
          await aimAt(80, -20);
          await sleep(1500);
          const skyBox = await boxOf();
          const skyB64 = await page.screenshot(skyBox);
          writeFileSync(join(dir, `water-seam-${stamp}-sky-full.png`), Buffer.from(skyB64, 'base64'));
          pngs.push(join(dir, `water-seam-${stamp}-sky-full.png`));
          const skySeam = await page.evaluate(
            `window.__q2seam2(${JSON.stringify([skyB64, skyB64])})`, 60000,
          ) as unknown as SeamResult;
          const route = await routeOf();
          console.log(
            `[water-seam] sky nonblack=${skySeam.nonblack.toFixed(3)} ` +
            `monsters=${route?.aliveMonsters} kinds=${JSON.stringify(route?.monsterKinds)} ` +
            `opaque=${route?.scene?.worldOpaque} transparent=${route?.scene?.worldTransparent} ` +
            `frames=${route?.framesSubmitted} uploads=${route?.uploads} warnings=${JSON.stringify(route?.warnings)}`,
          );
          report['sky'] = {
            nonblack: skySeam.nonblack, aliveMonsters: route?.aliveMonsters,
            monsterKinds: route?.monsterKinds, scene: route?.scene,
            framesSubmitted: route?.framesSubmitted, uploads: route?.uploads,
            warnings: route?.warnings, camera: route?.camera,
          };
          expect(skySeam.nonblack, 'sky view live').toBeGreaterThan(0.5);
          expect(route?.aliveMonsters ?? -1, 'enemies live (enemy repair intact)').toBeGreaterThan(0);
          expect(route?.scene?.worldOpaque ?? 0, 'walls submit (occlusion intact)').toBeGreaterThan(0);
          // Backend notices (oversized-skin resamples from the 256px upload
          // cap) are recorded; only fatal backend failures fail the leg.
          const fatal = (route?.warnings ?? []).filter((w) => /missing|invalid|failed/i.test(w));
          expect(fatal, `fatal backend warnings: ${JSON.stringify(route?.warnings)}`).toEqual([]);
          const consoleErrors = consoleLines.filter(
            (l) => l.startsWith('[exception]') || l.includes('Uncaught') || l.includes('ERROR'));
          expect(consoleErrors).toEqual([]);

          const reportPath = join(dir, `water-seam-${stamp}-report.json`);
          writeFileSync(reportPath, JSON.stringify(report, null, 2));
          console.log(`[water-seam] report ${reportPath}`);
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
      // Artifact hygiene: PNGs served their purpose (in-page analysis +
      // JSON report above); delete them so only the small JSON report
      // remains — unless KEEP_SEAM_PNGS=1 (defect investigation). The
      // directory is gitignored — nothing is ever committed.
      if (process.env.KEEP_SEAM_PNGS === '1') {
        console.log(`[water-seam] kept ${pngs.length} PNG artifacts (KEEP_SEAM_PNGS=1)`);
      } else {
        for (const p of pngs) {
          try { unlinkSync(p); } catch { /* already gone */ }
        }
        console.log(`[water-seam] cleaned ${pngs.length} PNG artifacts`);
      }
    }
  });
});
