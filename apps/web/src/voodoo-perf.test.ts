// q2ts-web full-frame raster+resolve bench at 640x480 (serial, devroom).
//
// Report-only harness (astra §6 perf): renders real devroom frames at the
// 640x480 capture resolution on the SERIAL path and prints a
// raster/resolve/scanout breakdown to the console. It asserts NOTHING about
// budgets (BRAIN budgets stay untouched) — only that every frame completes
// with sane output. Copy the console block into docs/perf-ledger.md.
import { describe, expect, it, afterEach } from 'vitest';
import { getCVarNumber, setCVar } from '@q2/config';
import { SW_RGB_SKIP_CLASSIC_CVAR, skipClassicRequested } from '@q2/sw-renderer';
import {
  applyRendererCvar,
  bootPlay,
  buildAsyncView,
  resolveDisplay,
} from './play.js';

const W = 640;
const H = 480;
const PX = W * H;
const WARMUP = 8;
const FRAMES = 15;

const SAVED = new Map<string, number | string | boolean>();
const ABSENT_DEFAULTS: Record<string, number> = {
  sw_workers: 0,
  cl_showfps: 1,
  cl_showpos: 1,
};
const ABSENT = new Set<string>();
function saveCvar(name: string): void {
  if (!SAVED.has(name) && !ABSENT.has(name)) {
    try {
      SAVED.set(name, getCVarNumber(name));
    } catch {
      ABSENT.add(name);
    }
  }
}
function sandbox(): void {
  for (const name of ['vid_renderer', 'r_brightness', 'vd_postfilter', 'vd_16bit', 'vd_dither', 'vd_gamma', 'sw_workers', 'cl_showfps', 'cl_showpos']) {
    saveCvar(name);
  }
  setCVar('sw_workers', 0);
  setCVar('r_brightness', 1.0);
  setCVar('cl_showfps', 0);
  setCVar('cl_showpos', 0);
  // Classic oracle (PERF-FINISH-A defensive): frame stats intentionally track
  // the classic path, which the authoritative RGB skip elides where the
  // overlay drew. Pin the oracle so raster throughput stays measurable and
  // comparable across skip defaults; resolved output is identical either
  // way (covered pixels composite from the RGB planes in endFrame). Saved
  // via the honest probe (never an absent-vs-0 leak) and restored above.
  if (!SAVED.has(SW_RGB_SKIP_CLASSIC_CVAR)) {
    SAVED.set(SW_RGB_SKIP_CLASSIC_CVAR, skipClassicRequested() ? 1 : 0);
  }
  setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 0);
}
afterEach(() => {
  for (const [name, value] of SAVED) setCVar(name, value);
  for (const name of ABSENT) {
    const def = ABSENT_DEFAULTS[name];
    if (def !== undefined) setCVar(name, def);
  }
});

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** One timed frame: raster (renderView) + palette (endFrame) + scanout. */
function timedFrame(
  boot: ReturnType<typeof bootPlay>,
  yaw: number,
  scanout: boolean,
): { raster: number; palette: number; scan: number; spans: number; pixels: number; overdraw: number } {
  boot.host.input.angles = [0, yaw, 0];
  if (boot.host.lastCmd) boot.host.lastCmd.angles = [0, yaw, 0];
  const { view, renderables } = buildAsyncView(boot.host, 0);
  boot.refresh.beginFrame();
  const t0 = performance.now();
  const stats = boot.refresh.renderView(view, boot.host.world, renderables);
  const t1 = performance.now();
  boot.refresh.endFrame();
  const t2 = performance.now();
  const out = scanout ? resolveDisplay(boot) : boot.refresh.getFramebuffer().color;
  const t3 = performance.now();
  expect(out.length).toBe(PX);
  return {
    raster: t1 - t0, palette: t2 - t1, scan: t3 - t2,
    spans: stats.spans, pixels: stats.pixels, overdraw: stats.overdraw,
  };
}

describe('web 640x480 raster+resolve bench (serial devroom, report-only)', () => {
  it('reports full-frame breakdown to console (no budget assertions)', () => {
    sandbox();
    const boot = bootPlay({ width: W, height: H });
    // Warmup: full sim+render frames so the surface cache is hot, then the
    // measured legs sweep the yaw like a slow turn (no two frames alike).
    let t = 0;
    for (let f = 0; f < WARMUP; f++) {
      t += 16.7;
      boot.host.input.angles = [0, (f * 13) % 360, 0];
      boot.host.frame(t);
    }

    // Leg 1: software raster + palette resolve (serial).
    setCVar('vid_renderer', 'software');
    applyRendererCvar(boot);
    const sw = [];
    for (let f = 0; f < FRAMES; f++) sw.push(timedFrame(boot, (f * 17) % 360, false));
    const swRaster = median(sw.map((r) => r.raster));
    const swPalette = median(sw.map((r) => r.palette));
    const swSpans = Math.round(median(sw.map((r) => r.spans)));
    const swPixels = Math.round(median(sw.map((r) => r.pixels)));
    const swOver = median(sw.map((r) => r.overdraw));

    // Leg 2: same raster + voodoo scanout (dither + RGB565 + postfilter).
    setCVar('vid_renderer', 'voodoo');
    applyRendererCvar(boot);
    setCVar('vd_gamma', 1.3);
    setCVar('vd_dither', 1);
    setCVar('vd_16bit', 1);
    setCVar('vd_postfilter', 1);
    expect(boot.lastVoodooPath).toBe('none');
    const vd = [];
    for (let f = 0; f < FRAMES; f++) vd.push(timedFrame(boot, (f * 17 + 7) % 360, true));
    const vdRaster = median(vd.map((r) => r.raster));
    const vdPalette = median(vd.map((r) => r.palette));
    const vdScan = median(vd.map((r) => r.scan));
    const vdSpans = Math.round(median(vd.map((r) => r.spans)));
    const vdPixels = Math.round(median(vd.map((r) => r.pixels)));
    const vdOver = median(vd.map((r) => r.overdraw));
    expect(boot.lastVoodooPath).toBe('serial');

    const fmt = (v: number): string => v.toFixed(2);
    const mpix = (px: number, ms: number): string => (ms > 0 ? (px / ms / 1000).toFixed(1) : 'n/a');
    // Machine-agnostic block: medians in ms + pixel counts, no hw claims.
    console.log(
      `[web-bench] full-frame raster+resolve @${W}x${H} serial devroom (N=${FRAMES}, medians)\n` +
      `  software: raster(world+entities) ${fmt(swRaster)} ms | endFrame(palette) ${fmt(swPalette)} ms | ` +
      `frame ${fmt(swRaster + swPalette)} ms | spans ${swSpans} | shaded ${swPixels}/${PX} px | overdraw ${swOver.toFixed(2)} | raster ${mpix(swPixels, swRaster)} Mpixel/s\n` +
      `  voodoo:   raster(world+entities) ${fmt(vdRaster)} ms | endFrame(palette) ${fmt(vdPalette)} ms | ` +
      `scanout(resolveFrame) ${fmt(vdScan)} ms | frame ${fmt(vdRaster + vdPalette + vdScan)} ms | spans ${vdSpans} | ` +
      `shaded ${vdPixels}/${PX} px | overdraw ${vdOver.toFixed(2)} | raster ${mpix(vdPixels, vdRaster)} Mpixel/s`,
    );

    // Sanity only: frames completed with real geometry, no budget gates.
    expect(swSpans).toBeGreaterThan(0);
    expect(swPixels).toBeGreaterThan(0);
    expect(vdSpans).toBeGreaterThan(0);
    expect(vdPixels).toBeGreaterThan(0);
    for (const r of [...sw, ...vd]) {
      expect(Number.isFinite(r.raster)).toBe(true);
      expect(Number.isFinite(r.palette)).toBe(true);
      expect(Number.isFinite(r.scan)).toBe(true);
    }
  });
});
