// @q2/testkit — GPU-FOLLOW-0 lane B: production-page presentation regression.
//
// Real-browser suite drives the PRODUCTION page (apps/web via vite dev, soak
// boot query) over CDP and asserts the composed visible page: transparent HUD
// background in GPU mode, HUD/GPU canvas alignment, canvas/context state, no
// rendering errors, and visible scene pixels in Page.captureScreenshot (never
// a GL readback anywhere — the production path stays readback-free).
//
// Gating: Q2_PAK + chromium + vite must all be present; otherwise the browser
// suite skips gracefully (the pure-helper suite below ALWAYS runs headless).

import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { connectCdp, type CdpConnection } from './gpu-browser.js';
import {
  PRESENTATION_MAX_NEARWHITE_FRAC,
  PRESENTATION_MIN_DISTINCT_TRIPLES,
  PRESENTATION_MIN_GUN_REGION_FRAC,
  PRESENTATION_MIN_NONBLACK_FRAC,
  PRESENTATION_RECT_TOLERANCE_PX,
  chromiumFlagsForRenderer,
  decodePngRgba,
  distinctTripleCount,
  gunRegion,
  isTransparentBlack,
  launchProductionChromium,
  maxRectDelta,
  nearWhiteFraction,
  nonBlackFraction,
  probePresentation,
  rectsAligned,
  regionNonBlackFraction,
  reloadProductionPage,
  resolvePresentationDeps,
  soakPageUrl,
  startPakFileServer,
  startViteDev,
  waitForSoakBoot,
  waitHttpOk,
  type PresentationProbe,
  type PresentationServer,
} from './gpu-presentation.js';

// --- Always-on headless unit tests (pure helpers, no browser) ----------------

function crcPlaceholder(): number[] {
  return [0, 0, 0, 0];
}

function chunk(type: string, data: Uint8Array): number[] {
  const out: number[] = [];
  const len = data.length;
  out.push((len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255);
  for (const c of type) out.push(c.charCodeAt(0));
  for (const b of data) out.push(b);
  out.push(...crcPlaceholder());
  return out;
}

/** Build a minimal PNG (decoder under test ignores CRCs). */
function encodeTestPng(width: number, height: number, rows: Uint8Array[], colorType: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  ihdr[0] = (width >>> 24) & 255;
  ihdr[1] = (width >>> 16) & 255;
  ihdr[2] = (width >>> 8) & 255;
  ihdr[3] = width & 255;
  ihdr[4] = (height >>> 24) & 255;
  ihdr[5] = (height >>> 16) & 255;
  ihdr[6] = (height >>> 8) & 255;
  ihdr[7] = height & 255;
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const channels = colorType === 6 ? 4 : 3;
  const raw = new Uint8Array(height * (width * channels + 1));
  for (let y = 0; y < height; y++) raw.set(rows[y]!, y * (width * channels + 1));
  const idat = deflateSync(raw);
  const bytes: number[] = [137, 80, 78, 71, 13, 10, 26, 10];
  bytes.push(...chunk('IHDR', ihdr));
  bytes.push(...chunk('IDAT', new Uint8Array(idat)));
  bytes.push(...chunk('IEND', new Uint8Array(0)));
  return new Uint8Array(bytes);
}

describe('gpu-presentation pure helpers', () => {
  it('decodes RGBA PNG rows through every filter type', () => {
    const w = 4;
    const px: number[][] = [
      [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255],
      [5, 5, 5, 255, 0, 0, 0, 255, 255, 255, 255, 255, 1, 2, 3, 255],
      [200, 0, 100, 128, 0, 200, 50, 77, 33, 44, 55, 66, 9, 9, 9, 9],
      [0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255],
      [17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255, 0],
    ];
    // One row per filter type 0..4. Filtered bytes are computed against the
    // true previous raw row (the decoder reconstructs against the same).
    const chans = 4;
    const filtered: Uint8Array[] = [];
    let prev = new Uint8Array(w * chans);
    for (let y = 0; y < 5; y++) {
      const rawRow = new Uint8Array(px[y]!);
      const f = new Uint8Array(1 + rawRow.length);
      f[0] = y;
      for (let i = 0; i < rawRow.length; i++) {
        const a = i >= chans ? rawRow[i - chans]! : 0;
        const b = prev[i]!;
        const c = i >= chans ? prev[i - chans]! : 0;
        let v = rawRow[i]!;
        if (y === 1) v = (v - a) & 255;
        else if (y === 2) v = (v - b) & 255;
        else if (y === 3) v = (v - ((a + b) >> 1)) & 255;
        else if (y === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = (v - pr) & 255;
        }
        f[1 + i] = v;
      }
      filtered.push(f);
      prev = rawRow;
    }
    const png = encodeTestPng(w, 5, filtered, 6);
    const dec = decodePngRgba(png);
    expect(dec.width).toBe(w);
    expect(dec.height).toBe(5);
    for (let y = 0; y < 5; y++) {
      expect(Array.from(dec.data.subarray(y * w * 4, (y + 1) * w * 4))).toEqual(px[y]);
    }
  });

  it('decodes RGB PNGs to opaque RGBA', () => {
    const png = encodeTestPng(2, 1, [new Uint8Array([0, 255, 0, 0, 0, 0, 255])], 2);
    const dec = decodePngRgba(png);
    expect(dec.width).toBe(2);
    expect(Array.from(dec.data)).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });

  it('rejects non-PNG input', () => {
    expect(() => decodePngRgba(new Uint8Array([1, 2, 3]))).toThrow();
  });

  it('measures non-black fractions', () => {
    expect(nonBlackFraction(new Uint8Array(16))).toBe(0);
    const half = new Uint8Array(16);
    half[0] = 1;
    half[8] = 255;
    half[9] = 255;
    half[10] = 255;
    expect(nonBlackFraction(half)).toBe(0.5);
    expect(() => nonBlackFraction(new Uint8Array(3))).toThrow();
  });

  it('measures region fractions (gun-region presence floor)', () => {
    const w = 10;
    const h = 10;
    const rgba = new Uint8Array(w * h * 4);
    // Light only the bottom-center block.
    for (let y = 6; y < 10; y++) {
      for (let x = 3; x < 8; x++) {
        const o = (y * w + x) * 4;
        rgba[o] = 200;
        rgba[o + 3] = 255;
      }
    }
    const frac = regionNonBlackFraction(rgba, w, h, gunRegion());
    expect(frac).toBeGreaterThan(0.5);
    const top = regionNonBlackFraction(rgba, w, h, { x0: 0, y0: 0, x1: 1, y1: 0.5 });
    expect(top).toBe(0);
    expect(() => regionNonBlackFraction(new Uint8Array(4), 2, 2, gunRegion())).toThrow();
  });

  it('compares rects within tolerance', () => {
    const a = { x: 0, y: 0, width: 640, height: 480 };
    expect(rectsAligned(a, { ...a }, PRESENTATION_RECT_TOLERANCE_PX)).toBe(true);
    expect(rectsAligned(a, { x: 0.5, y: 0.5, width: 640.5, height: 479.5 }, 1)).toBe(true);
    expect(rectsAligned(a, { x: 0, y: 0, width: 640, height: 482 }, 1)).toBe(false);
    expect(maxRectDelta(a, { x: 0, y: 0, width: 640, height: 482 })).toBe(2);
  });

  it('detects transparent vs opaque black CSS backgrounds', () => {
    expect(isTransparentBlack('rgba(0, 0, 0, 0)')).toBe(true);
    expect(isTransparentBlack('transparent')).toBe(true);
    // The overlay defect: opaque black (what #q2 ships with pre-fix).
    expect(isTransparentBlack('rgb(0, 0, 0)')).toBe(false);
    expect(isTransparentBlack('rgba(0, 0, 0, 1)')).toBe(false);
    expect(isTransparentBlack('rgba(0,0,0,0.5)')).toBe(false);
    expect(isTransparentBlack('red')).toBe(false);
  });

  it('pins wash and variety on both sides of the screenshot gate', () => {
    const white = new Uint8Array([255, 255, 255, 255, 254, 253, 252, 255]);
    expect(nearWhiteFraction(white)).toBe(1);
    expect(distinctTripleCount(white)).toBe(2);
    const black = new Uint8Array(16);
    expect(nearWhiteFraction(black)).toBe(0);
    expect(distinctTripleCount(black)).toBe(1);
    const varied = new Uint8Array(400);
    for (let i = 0; i < 100; i++) {
      varied[i * 4] = i;
      varied[i * 4 + 1] = (i * 2) % 256;
      varied[i * 4 + 2] = (i * 3) % 256;
      varied[i * 4 + 3] = 255;
    }
    expect(nearWhiteFraction(varied)).toBe(0);
    expect(distinctTripleCount(varied)).toBe(100);
    expect(() => nearWhiteFraction(new Uint8Array(3))).toThrow();
    expect(() => distinctTripleCount(new Uint8Array(0))).toThrow();
  });
});

// --- Gated real-browser suite (production page over CDP) ----------------------

const RESOLVED = resolvePresentationDeps();
const GATE = 'deps' in RESOLVED;

describe.runIf(!GATE)('gpu-presentation production page (skipped)', () => {
  it('logs the skip reason', () => {
    console.log(!GATE ? RESOLVED.skip : 'unexpected');
  });
});

interface LegEvidence {
  leg: string;
  renderer: string;
  width: number;
  height: number;
  probe: PresentationProbe;
  nonBlackFrac: number;
  gunRegionFrac: number;
  nearWhiteFrac: number;
  distinctTriples: number;
  consoleTail: string[];
}

describe.runIf(GATE)('gpu-presentation production page (GPU-FOLLOW-0 lane B)', () => {
  it(
    'boot + CPU→GPU→CPU switching show the composed scene (default + small viewport)',
    { timeout: 900000 },
    async () => {
      if (!GATE) throw new Error('unreachable (suite is gated)');
      const { pakPath, webRoot, viteBin } = RESOLVED.deps;
      const testDir = dirname(fileURLToPath(import.meta.url));
      const scratchProfile = join(testDir, '..', 'test-output', '.q2-presentation-profile');
      mkdirSync(scratchProfile, { recursive: true });

      let pakServer: PresentationServer | null = null;
      let vite: PresentationServer | null = null;
      let chromium: { port: number; kill(): void } | null = null;
      let cdp: CdpConnection | null = null;
      const evidence: LegEvidence[] = [];
      try {
        pakServer = await startPakFileServer(pakPath);
        vite = await startViteDev(webRoot, viteBin);
        console.log(`[gpu-presentation] vite: ${vite.url} pak: ${pakServer.url}/pak0.pak`);
        await waitHttpOk(`${vite.url}/`, 120000);

        const bootUrl = soakPageUrl(vite.url, pakServer.url, 'software');
        chromium = await launchProductionChromium(bootUrl, scratchProfile, chromiumFlagsForRenderer('software'));
        cdp = await connectCdp(chromium.port);
        // Leg 1: CPU boot at 640x480.
        await waitForSoakBoot(cdp, 300000);
        evidence.push(await checkLeg(cdp, 'boot-cpu-640x480', 'software', 640, 480, false));

        // Leg 2: CPU → GPU at 640x480 (reload with the GPU renderer).
        await reloadProductionPage(cdp, soakPageUrl(vite.url, pakServer.url, 'webgl2-experimental'), 300000);
        evidence.push(await checkLeg(cdp, 'cpu-to-gpu-640x480', 'webgl2-experimental', 640, 480, true));

        // Leg 3: GPU → CPU at 640x480 (back to software).
        await reloadProductionPage(cdp, soakPageUrl(vite.url, pakServer.url, 'software'), 300000);
        evidence.push(await checkLeg(cdp, 'gpu-to-cpu-640x480', 'software', 640, 480, false));

        // Leg 4: small-viewport GPU leg (fresh chromium at 384x256, same
        // 640x480 backing). NOTE: a vid_resolution q2cvars override cannot
        // change the soak framebuffer — runSoakBoot passes explicit 640x480
        // dims to bootPlay, which win over the latched cvar (verified: the
        // override leg still boots 640x480) — so the honest small-size leg
        // varies the DISPLAYED size (the composed-page half of the alignment
        // contract) instead of asserting on a no-op knob.
        if (cdp) {
          await cdp.close().catch(() => undefined);
          cdp = null;
        }
        if (chromium) {
          chromium.kill();
          chromium = null;
        }
        const leg4Profile = join(testDir, '..', 'test-output', `.q2-presentation-profile-leg4-${process.pid}-${Date.now()}`);
        mkdirSync(leg4Profile, { recursive: true });
        chromium = await launchProductionChromium(
          soakPageUrl(vite.url, pakServer.url, 'webgl2-experimental'),
          // Unique profile for the fresh leg-4 chromium: the legs 1-3
          // profile may still hold a SingletonLock from the killed process.
          leg4Profile,
          [...chromiumFlagsForRenderer('webgl2-experimental'), '--window-size=384,256', '--force-device-scale-factor=1'],
        );
        cdp = await connectCdp(chromium.port);
        await waitForSoakBoot(cdp, 300000);
        evidence.push(await checkLeg(cdp, 'gpu-small-viewport', 'webgl2-experimental', 640, 480, true));
      } finally {
        if (cdp) {
          await cdp.close().catch(() => undefined);
          cdp = null;
        }
        if (chromium) {
          chromium.kill();
          chromium = null;
        }
        if (vite) {
          await vite.close();
          vite = null;
        }
        if (pakServer) {
          await pakServer.close();
          pakServer = null;
        }
      }

      // Artifacts (gitignored test-output/; paths logged).
      const outDir = join(testDir, '..', 'test-output');
      mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      for (const ev of evidence) {
        writeFileSync(join(outDir, `gpu-presentation-${stamp}-${ev.leg}.json`), JSON.stringify(ev, null, 2));
      }
      console.log(`[gpu-presentation] artifacts: test-output/gpu-presentation-${stamp}-*.json (+ per-leg .png)`);
    },
  );
});

/** Poll until the GPU leg reports submitted frames (real on-canvas work). */
async function waitForFramesSubmitted(cdp: CdpConnection, timeoutMs: number): Promise<number> {
  const start = Date.now();
  let polls = 0;
  for (;;) {
    polls++;
    const n = await cdp.evaluate<number | null>(
      'window.__q2soakState ? window.__q2soakState().framesSubmitted : null',
      30000,
    );
    if (typeof n === 'number' && n > 0) return n;
    if (polls % 5 === 1) {
      console.log(`[gpu-presentation] framesSubmitted waiting: polls=${polls} elapsed=${Date.now() - start}ms last=${String(n)}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `[gpu-presentation] framesSubmitted never exceeded 0 within ${timeoutMs}ms (polls=${polls} last=${String(n)})`,
      );
    }
    await new Promise<void>((r) => setTimeout(r, 2000));
  }
}

async function checkLeg(
  cdp: CdpConnection,
  leg: string,
  renderer: string,
  width: number,
  height: number,
  expectGpu: boolean,
): Promise<LegEvidence> {
  const probe = await probePresentation(cdp);
  let activeProbe = probe;
  const testDir = dirname(fileURLToPath(import.meta.url));
  console.log(`[gpu-presentation] ${leg}: ${JSON.stringify(probe.soak)} bg=${probe.q2Background} ` +
    `q2rect=${JSON.stringify(probe.q2Rect)} glrect=${JSON.stringify(probe.glRect)}` +
    ` href=${probe.href} cvars=${JSON.stringify(probe.cvars)}`);

  // --- boot health ---
  expect(probe.soak, `${leg}: page must publish soak state`).not.toBeNull();
  expect(probe.soak!.booted, `${leg}: soak boot flag`).toBe(true);
  expect(probe.soak!.error, `${leg}: soak boot error`).toBeNull();
  expect(probe.soak!.actualRenderer, `${leg}: active renderer`).toBe(renderer);
  expect(probe.soak!.warning, `${leg}: renderer fallback warning`).toBeNull();
  expect(probe.hasQ2, `${leg}: production page must keep the #q2 HUD canvas`).toBe(true);
  expect(probe.q2Background, `${leg}: readable #q2 background`).not.toBeNull();

  if (expectGpu) {
    // --- GPU mode: real submissions, transparent HUD, aligned canvases ---
    const submitted = await waitForFramesSubmitted(cdp, 120000);
    expect(submitted).toBeGreaterThan(0);
    // Re-probe after frames: backing/CSS settle on the first presented frame.
    const freshGpu = await probePresentation(cdp);
    activeProbe = freshGpu;
    expect(freshGpu.soak!.gpuActive, `${leg}: GPU backend must be attached`).toBe(true);
    expect(freshGpu.hasGl, `${leg}: production page must mount the #q2-gl canvas`).toBe(true);
    // The black-CSS-overlay regression: the HUD canvas above the GL canvas
    // must be transparent or the composed page is black despite GPU work.
    expect(
      isTransparentBlack(freshGpu.q2Background!),
      `${leg}: #q2 background must be transparent in GPU mode (got ${freshGpu.q2Background})`,
    ).toBe(true);
    expect(freshGpu.q2Rect, `${leg}: #q2 rect`).not.toBeNull();
    expect(freshGpu.glRect, `${leg}: #q2-gl rect`).not.toBeNull();
    expect(
      maxRectDelta(freshGpu.q2Rect!, freshGpu.glRect!),
      `${leg}: HUD/GPU canvas rects must match within ${PRESENTATION_RECT_TOLERANCE_PX}px`,
    ).toBeLessThanOrEqual(PRESENTATION_RECT_TOLERANCE_PX);
    expect(freshGpu.gl, `${leg}: GL context info`).not.toBeNull();
    expect(freshGpu.gl!.available, `${leg}: webgl2 context`).toBe(true);
    expect(freshGpu.gl!.contextLost, `${leg}: context must not be lost`).toBe(false);
    expect(freshGpu.gl!.version ?? '', `${leg}: WebGL2 version`).toContain('WebGL 2.0');
    // Backing store tracks the requested resolution; displayed size tracks the
    // HUD box (fb*2 normally, bezel-capped in small viewports). Pin backing +
    // aspect; rect equality above pins displayed alignment.
    expect(freshGpu.glCanvas, `${leg}: #q2-gl size`).not.toBeNull();
    expect(freshGpu.glCanvas!.width, `${leg}: GL backing width`).toBe(width);
    expect(freshGpu.glCanvas!.height, `${leg}: GL backing height`).toBe(height);
    expect(freshGpu.glRect!.width, `${leg}: GL displayed width`).toBeGreaterThan(0);
    expect(freshGpu.glRect!.height, `${leg}: GL displayed height`).toBeGreaterThan(0);
    // Displayed geometry is pinned by HUD/GPU rect equality above (responsive
    // bezel capping can letterbox both boxes identically vs backing — the
    // pre-existing CPU presentation shares it, so it is not asserted here).
  } else {
    // --- CPU mode: no GL canvas; #q2 is the blit target at full resolution ---
    // Backing resizes on the first blitted frame (initial HTML attr is
    // 320x240), so advance frames first, then re-probe for canvas geometry.
    const f0 = await cdp.evaluate<number>(
      'window.__q2stats && typeof window.__q2stats.frame === \'number\' ? window.__q2stats.frame : -1',
      30000,
    );
    await new Promise<void>((r) => setTimeout(r, 1500));
    const f1 = await cdp.evaluate<number>(
      'window.__q2stats && typeof window.__q2stats.frame === \'number\' ? window.__q2stats.frame : -1',
      30000,
    );
    expect(f1, `${leg}: CPU loop must advance frames (${f0} -> ${f1})`).toBeGreaterThan(f0);
    const fresh = await probePresentation(cdp);
    activeProbe = fresh;
    expect(fresh.hasGl, `${leg}: CPU mode must not mount a GL canvas`).toBe(false);
    expect(fresh.q2Canvas, `${leg}: #q2 size`).not.toBeNull();
    expect(fresh.q2Canvas!.width, `${leg}: CPU backing width`).toBe(width);
    expect(fresh.q2Canvas!.height, `${leg}: CPU backing height`).toBe(height);
  }

  // --- rendering errors: soak status + page console must be clean ---
  const consoleLines = cdp.consoleLines();
  const exceptions = consoleLines.filter((l) => l.startsWith('[exception]'));
  expect(exceptions, `${leg}: page must not throw (tail: ${consoleLines.slice(-5).join(' | ')})`).toEqual([]);
  // --- composed visible page: screenshot must show the scene, not black ---
  const shot = await cdp.screenshot();
  const outDir = join(testDir, '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(outDir, `gpu-presentation-${stamp}-${leg}.png`), shot);
  const decoded = decodePngRgba(shot);
  const nonBlack = nonBlackFraction(decoded.data);
  const gun = regionNonBlackFraction(decoded.data, decoded.width, decoded.height, gunRegion());
  const nearWhite = nearWhiteFraction(decoded.data);
  const triples = distinctTripleCount(decoded.data);
  console.log(`[gpu-presentation] ${leg}: shot ${decoded.width}x${decoded.height} ` +
    `nonBlack=${nonBlack.toFixed(4)} gunRegion=${gun.toFixed(4)} ` +
    `nearWhite=${nearWhite.toFixed(4)} triples=${triples}`);
  expect(
    nonBlack,
    `${leg}: composed screenshot must show scene pixels (need >=${PRESENTATION_MIN_NONBLACK_FRAC}, ` +
    `all-black fails the presentation gate — not a headless artifact)`,
  ).toBeGreaterThanOrEqual(PRESENTATION_MIN_NONBLACK_FRAC);
  expect(
    gun,
    `${leg}: gun/HUD region must be present (need >=${PRESENTATION_MIN_GUN_REGION_FRAC})`,
  ).toBeGreaterThanOrEqual(PRESENTATION_MIN_GUN_REGION_FRAC);
  // Anti-wash pins: an all-white failure passes the floors above, so pin it
  // from the other side (near-white ceiling + color-variety floor).
  expect(
    nearWhite,
    `${leg}: composed screenshot must not be a near-white wash (need <=${PRESENTATION_MAX_NEARWHITE_FRAC})`,
  ).toBeLessThanOrEqual(PRESENTATION_MAX_NEARWHITE_FRAC);
  expect(
    triples,
    `${leg}: composed screenshot must show varied scene colors (need >=${PRESENTATION_MIN_DISTINCT_TRIPLES} distinct triples)`,
  ).toBeGreaterThanOrEqual(PRESENTATION_MIN_DISTINCT_TRIPLES);

  return {
    leg,
    renderer,
    width,
    height,
    probe: activeProbe,
    nonBlackFrac: nonBlack,
    gunRegionFrac: gun,
    nearWhiteFrac: nearWhite,
    distinctTriples: triples,
    consoleTail: consoleLines.slice(-20),
  };
}
