// q2ts-web voodoo display freshness (astra §2 defect #1 + §6 fixtures).
//
// Pre-fix `resolveFrame` only fills `display` when `vd_postfilter` is on, so
// `resolveDisplay` returned last frame's pixels with the filter off (stale).
// These tests paint solid frames straight into the live renderer color plane
// and assert every `vd_16bit`/`vd_dither`/`vd_postfilter` combination shows
// the CURRENT frame — robust to both the old behaviour (web-side backfill)
// and the fixed voodoo `resolveFrame` (canary no-op).

import { describe, expect, it, afterEach } from 'vitest';
import { getCVarNumber, setCVar } from '@q2/config';
import { expandRGB565, gammaLUT, quantiseRGB565 } from '@q2/voodoo';
import { splitBands } from '@q2/sw-renderer';
import {
  applyRendererCvar,
  applyVoodooPresentation,
  armRasterPolicy,
  bootPlay,
  drawPlayHud,
  hudComposedPreScanout,
  isVoodooAspect,
  resolveDisplay,
  VOODOO_FRAME_HEIGHT,
  VOODOO_FRAME_WIDTH,
  type PlayBoot,
} from './play.js';
import {
  selectVoodooBandPath,
  snapshotVoodooState,
  voodooBandEnvelopes,
} from './render-workers.js';

const W = 32;
const H = 24;
const N = W * H;
// 0xAABBGGRR solid frames.
const RED = 0xff0000ff;
const GREEN = 0xff00ff00;

function paintLive(boot: PlayBoot, px: number): void {
  boot.refresh.getFramebuffer().color.fill(px);
}

function meanChannels(buf: Uint32Array): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    const px = buf[i]!;
    r += px & 255;
    g += (px >> 8) & 255;
    b += (px >> 16) & 255;
  }
  return { r: r / buf.length, g: g / buf.length, b: b / buf.length };
}

// Cvar sandbox: every test leaves the global registry as it found it.
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
      // Lazily-registered cvar (sw_workers, cl_show*): not present yet.
      // Remember and reset to the package default on teardown.
      ABSENT.add(name);
    }
  }
}
function voodooSandbox(): void {
  for (const name of ['vid_renderer', 'r_brightness', 'vd_postfilter', 'vd_16bit', 'vd_dither', 'vd_gamma', 'sw_workers', 'cl_showfps', 'cl_showpos']) {
    saveCvar(name);
  }
  setCVar('vid_renderer', 'voodoo');
  setCVar('r_brightness', 1.0);
}
afterEach(() => {
  for (const [name, value] of SAVED) setCVar(name, value);
  for (const name of ABSENT) {
    const def = ABSENT_DEFAULTS[name];
    if (def !== undefined) setCVar(name, def);
  }
});

describe('voodoo display freshness (postfilter-off stale guard)', () => {
  it('postfilter 1->0->1 with changing solid frames shows no stale pixels', () => {
    voodooSandbox();
    const boot = bootPlay({ width: W, height: H });
    expect(boot.display.length).toBe(N);

    paintLive(boot, RED);
    setCVar('vd_postfilter', 1);
    let out = resolveDisplay(boot);
    let m = meanChannels(out);
    expect(m.r).toBeGreaterThan(200);
    expect(m.g).toBeLessThan(24);
    expect(m.b).toBeLessThan(24);

    // Filter off + new (green) frame: must be green, not stale red.
    paintLive(boot, GREEN);
    setCVar('vd_postfilter', 0);
    out = resolveDisplay(boot);
    m = meanChannels(out);
    expect(m.g).toBeGreaterThan(200);
    expect(m.r).toBeLessThan(24);
    expect(m.b).toBeLessThan(24);

    // Filter back on + red frame: red again, no green ghost.
    paintLive(boot, RED);
    setCVar('vd_postfilter', 1);
    out = resolveDisplay(boot);
    m = meanChannels(out);
    expect(m.r).toBeGreaterThan(200);
    expect(m.g).toBeLessThan(24);
    expect(m.b).toBeLessThan(24);
  });

  it('every vd_16bit/vd_dither/vd_postfilter combination tracks the current frame', () => {
    voodooSandbox();
    const boot = bootPlay({ width: W, height: H });
    let frame: number = RED;
    for (const bit16 of [1, 0]) {
      for (const dither of [1, 0]) {
        for (const post of [1, 0]) {
          setCVar('vd_16bit', bit16);
          setCVar('vd_dither', dither);
          setCVar('vd_postfilter', post);
          // Alternate the painted frame so a stale buffer always fails.
          frame = frame === RED ? GREEN : RED;
          paintLive(boot, frame);
          const out = resolveDisplay(boot);
          expect(out.length).toBe(N);
          const m = meanChannels(out);
          if (frame === RED) {
            expect(m.r).toBeGreaterThan(200);
            expect(m.g).toBeLessThan(24);
            expect(m.b).toBeLessThan(24);
          } else {
            expect(m.g).toBeGreaterThan(200);
            expect(m.r).toBeLessThan(24);
            expect(m.b).toBeLessThan(24);
          }
          // Opaque alpha in every combination (0xAABBGGRR display plane).
          for (let i = 0; i < out.length; i++) {
            expect(out[i]! >>> 24).toBe(0xff);
          }
        }
      }
    }
  });

  it('vd_16bit off preserves sub-565 values; on collapses them (true bypass)', () => {
    voodooSandbox();
    const boot = bootPlay({ width: W, height: H });
    // Low channels gamma-lifted but still sub-565 at gamma 1.0; dither off
    // so the quantise leg is deterministic. r=4/g=3/b=2 all truncate to 0
    // in 5:6:5 yet survive an RGB888 copy.
    setCVar('vd_gamma', 1.0);
    setCVar('vd_dither', 0);
    setCVar('vd_postfilter', 0);
    paintLive(boot, 0xff020304);

    setCVar('vd_16bit', 1);
    let out = resolveDisplay(boot);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]! & 255).toBe(0);
      expect((out[i]! >> 8) & 255).toBe(0);
      expect((out[i]! >> 16) & 255).toBe(0);
    }

    setCVar('vd_16bit', 0);
    out = resolveDisplay(boot);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]!).toBe(0xff020304);
    }
  });

  it('brightness lift applies in LEGACY voodoo mode; strict voodoo skips it (vd_gamma is the gamma stage)', () => {
    voodooSandbox();
    const boot = bootPlay({ width: W, height: H });
    setCVar('vd_gamma', 1.0);
    setCVar('vd_dither', 0);
    setCVar('vd_postfilter', 0);
    setCVar('vd_16bit', 0);
    paintLive(boot, 0xff404040);
    const live = boot.refresh.getFramebuffer().color;

    // LEGACY branch keeps the post-scanout lift.
    boot.strictVoodoo = false;
    setCVar('r_brightness', 1.0);
    const plain = resolveDisplay(boot).slice();
    expect(meanChannels(plain).r).toBe(0x40);

    setCVar('r_brightness', 2.0);
    const lifted = resolveDisplay(boot);
    // 0x40 * 2 = 0x80 per channel.
    for (let i = 0; i < lifted.length; i++) {
      expect(lifted[i]!).toBe(0xff808080);
    }
    expect(meanChannels(lifted).r).toBeGreaterThan(meanChannels(plain).r);
    // Engine buffer never mutated by the lift.
    for (let i = 0; i < live.length; i++) {
      expect(live[i]).toBe(0xff404040);
    }

    // STRICT branch skips the lift (effective 1.0): 2.0 resolves exactly
    // like 1.0 because vd_gamma inside resolveFrame is the gamma stage.
    boot.strictVoodoo = true;
    const strictLifted = resolveDisplay(boot).slice();
    setCVar('r_brightness', 1.0);
    paintLive(boot, 0xff404040);
    const strictPlain = resolveDisplay(boot);
    expect(Array.from(strictLifted)).toEqual(Array.from(strictPlain));
  });
});

// V2d raster policy: vid_renderer drives the real backend selection.
describe('renderer cvar policy (arm/disarm, no stale frame)', () => {
  it('applyRendererCvar arms/disarms the RGB hook and zeroes scratch on switch (UNIT-ONLY: mocked instance hook)', () => {
    // UNIT-ONLY contract test: injects a fake instance hook to prove the
    // duck-call + scratch-zeroing wiring. It does NOT prove real RGB
    // activation — see voodoo-rgb-activation.test.ts (real SoftwareRenderer,
    // no mocks) for the integration proof.
    voodooSandbox();
    const boot = bootPlay({ width: W, height: H });
    // Feature-detected hook (assumed name; see armRasterPolicy): the
    // parallel sw-renderer agent owns the real one — absence is a no-op.
    const calls: boolean[] = [];
    (boot.refresh as unknown as Record<string, unknown>)['setRGBWorldEnabled'] = (on: boolean) => {
      calls.push(on);
    };
    setCVar('vid_renderer', 'voodoo');
    expect(applyRendererCvar(boot)).toBe('voodoo');
    expect(boot.renderer).toBe('voodoo');
    expect(calls).toEqual([true]);
    // armRasterPolicy reports success and records the outcome for tests.
    expect(boot.lastRasterPolicy).toEqual({ mode: 'voodoo', rgbEnabled: true, hooked: true });

    // Dirty the shell scratch, then switch away: zeroed immediately so the
    // next frame can never show previous-mode pixels.
    boot.display.fill(0xdeadbeef);
    boot.fb565.fill(0x1234);
    setCVar('vid_renderer', 'software');
    expect(applyRendererCvar(boot)).toBe('software');
    expect(calls).toEqual([true, false]);
    expect(boot.display.every((v) => v === 0)).toBe(true);
    expect(boot.fb565.every((v) => v === 0)).toBe(true);
    expect(boot.lastRasterPolicy).toEqual({ mode: 'software', rgbEnabled: false, hooked: true });
  });

  it('missing hook fails LOUDLY: returns false, records hooked:false, warns', () => {
    // The real SoftwareRenderer now ships the instance hook, so arm against
    // the real boot succeeds. Loud-failure is covered with a hookless stub.
    voodooSandbox();
    const boot = bootPlay({ width: W, height: H });
    setCVar('vid_renderer', 'voodoo');
    expect(armRasterPolicy(boot)).toBe(true);
    expect(boot.lastRasterPolicy).toEqual({ mode: 'voodoo', rgbEnabled: true, hooked: true });
    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(' '));
    };
    try {
      const stub = { display: boot.display, fb565: boot.fb565, renderer: 'voodoo', refresh: {} };
      expect(armRasterPolicy(stub as never)).toBe(false);
      expect((stub as { lastRasterPolicy?: unknown }).lastRasterPolicy).toEqual({ mode: 'voodoo', rgbEnabled: true, hooked: false });
      expect(warned.length).toBeGreaterThan(0);
      expect(warned.join('\n')).toContain('setRGBWorldEnabled');
      setCVar('vid_renderer', 'software');
      expect(applyRendererCvar(boot)).toBe('software');
      expect(boot.lastRasterPolicy).toEqual({ mode: 'software', rgbEnabled: false, hooked: true });
    } finally {
      console.warn = origWarn;
    }
  });

  it('applyRendererCvar is a no-op without hooks (future-agent-absent fallback)', () => {
    voodooSandbox();
    const boot = bootPlay({ width: W, height: H });
    setCVar('vid_renderer', 'voodoo');
    expect(() => applyRendererCvar(boot)).not.toThrow();
    setCVar('vid_renderer', 'software');
    expect(() => applyRendererCvar(boot)).not.toThrow();
    expect(() => armRasterPolicy(boot)).not.toThrow();
  });

  it('mode switch never shows the previous frame', () => {
    voodooSandbox();
    const boot = bootPlay({ width: W, height: H });
    setCVar('vd_gamma', 1.0);
    setCVar('vd_dither', 0);
    setCVar('vd_postfilter', 0);
    setCVar('vd_16bit', 0);
    setCVar('r_brightness', 1.0);

    // Voodoo shows the red frame; strict path records its order + selection.
    paintLive(boot, RED);
    setCVar('vid_renderer', 'voodoo');
    applyRendererCvar(boot);
    let out = resolveDisplay(boot);
    let m = meanChannels(out);
    expect(m.r).toBeGreaterThan(200);
    expect(boot.lastResolveOrder).toBe('strict-hud-first');
    expect(boot.lastVoodooPath).toBe('serial');

    // Switch to software + new (green) frame: green, never stale red; the
    // 1.0 path returns the live engine buffer untouched (byte-identical).
    setCVar('vid_renderer', 'software');
    applyRendererCvar(boot);
    paintLive(boot, GREEN);
    out = resolveDisplay(boot);
    expect(out).toBe(boot.refresh.getFramebuffer().color);
    m = meanChannels(out);
    expect(m.g).toBeGreaterThan(200);
    expect(m.r).toBeLessThan(24);
    expect(boot.lastResolveOrder).toBe('software-passthrough');
    expect(boot.lastVoodooPath).toBe('none');

    // Back to voodoo: the green frame resolves fresh, no red ghost.
    setCVar('vid_renderer', 'voodoo');
    applyRendererCvar(boot);
    out = resolveDisplay(boot);
    m = meanChannels(out);
    expect(m.g).toBeGreaterThan(200);
    expect(m.r).toBeLessThan(24);
  });

  it('single resolve owner: renderer-flagged scanout skips the shell resolve', () => {
    voodooSandbox();
    const boot = bootPlay({ width: W, height: H });
    setCVar('vd_gamma', 1.0);
    setCVar('vd_dither', 0);
    setCVar('vd_postfilter', 0);
    setCVar('r_brightness', 1.0);
    paintLive(boot, RED);
    // A future renderer-side voodoo backend flags its own scanout via the
    // optional `voodooScanoutDone` hook (see resolve ownership in play.ts):
    // the shell must then NOT resolve again — exactly one resolve runs.
    (boot.refresh as unknown as Record<string, unknown>)['voodooScanoutDone'] = () => true;
    boot.display.fill(0xff010203);
    const out = resolveDisplay(boot);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0xff010203);
    // Policy selection is still recorded explicitly.
    expect(boot.lastVoodooPath).toBe('serial');
  });
});

// V2d strict voodoo: HUD composed into the emulated target BEFORE scanout.
describe('strict voodoo HUD-before-scanout ordering', () => {
  const SW = 160;
  const SH = 120;

  function strictBoot(): PlayBoot {
    const boot = bootPlay({ width: SW, height: SH });
    setCVar('vd_dither', 0);
    setCVar('vd_postfilter', 0);
    setCVar('vd_16bit', 1);
    setCVar('r_brightness', 1.0);
    setCVar('cl_showfps', 0);
    setCVar('cl_showpos', 0);
    boot.refresh.getFramebuffer().color.fill(0xff000000);
    return boot;
  }

  it('strict HUD pixels travel through scanout (gamma + 565), legacy keeps authored colours', () => {
    voodooSandbox();
    const boot = strictBoot();
    setCVar('vd_gamma', 2.0);
    expect(hudComposedPreScanout(boot)).toBe(true);

    const hud = { fps: 0, frame: 1 };
    const out = resolveDisplay(boot, hud);
    expect(boot.lastResolveOrder).toBe('strict-hud-first');
    // Crosshair arm pixel: authored dim grey 0xff888888. Strict mode runs
    // it through gamma + 565 quantise, so the display pixel is the
    // scanout-transformed value — provably not the authored colour.
    const cx = (SW / 2) | 0;
    const cy = (SH / 2) | 0;
    const arm = cy * SW + (cx - 4);
    const g = gammaLUT(2.0)[0x88]!;
    const expected = expandRGB565(quantiseRGB565(g, g, g));
    expect(expected).not.toBe(0xff888888);
    expect(out[arm]).toBe(expected);
    // The live (pre-scanout) target really was HUD-painted: the authored
    // colour sits in the engine plane the resolve read.
    expect(boot.refresh.getFramebuffer().color[arm]).toBe(0xff888888);

    // Legacy path: scanout first (no HUD in the target), HUD painted after
    // by the caller keeps exact authored colours.
    boot.strictVoodoo = false;
    expect(hudComposedPreScanout(boot)).toBe(false);
    boot.refresh.getFramebuffer().color.fill(0xff000000);
    const legacy = resolveDisplay(boot);
    expect(boot.lastResolveOrder).toBe('legacy-hud-last');
    drawPlayHud({ width: SW, height: SH, color: legacy }, boot, hud);
    expect(legacy[arm]).toBe(0xff888888);
  });

  it('strict mode without hud resolves the scene alone (no crash, scene intact)', () => {
    voodooSandbox();
    const boot = strictBoot();
    setCVar('vd_gamma', 1.0);
    paintLive(boot, RED);
    const out = resolveDisplay(boot);
    expect(boot.lastResolveOrder).toBe('strict-hud-first');
    const m = meanChannels(out);
    expect(m.r).toBeGreaterThan(200);
  });
});

// V2d worker bands: same snapshot to every band, global reconstruction.
describe('voodoo worker-band contract', () => {
  it('envelopes share one snapshot with absolute screen coords; path is explicit serial', () => {
    const st = snapshotVoodooState();
    expect(typeof st.gamma).toBe('number');
    const bands = splitBands(48, 4);
    expect(bands.length).toBe(4);
    const envs = voodooBandEnvelopes(st, bands, 64, 48);
    expect(envs.length).toBe(4);
    // Same reference everywhere: no per-band/per-pixel state reads.
    for (const e of envs) expect(e.state).toBe(st);
    // Absolute screen coords: contiguous full-frame coverage.
    expect(envs[0]!.y0).toBe(0);
    expect(envs[envs.length - 1]!.y1).toBe(48);
    for (let i = 1; i < envs.length; i++) {
      expect(envs[i]!.y0).toBe(envs[i - 1]!.y1);
    }
    for (const e of envs) {
      expect(e.width).toBe(64);
      expect(e.height).toBe(48);
    }
    // No worker/WASM voodoo backend yet: explicit serial, never silent software.
    expect(selectVoodooBandPath(false)).toBe('serial');
    expect(selectVoodooBandPath(true)).toBe('serial');
  });

  it('banded raster resolves byte-identical to serial, dither phase included', () => {
    voodooSandbox();
    setCVar('sw_workers', 0);
    const serial = bootPlay({ width: 64, height: 48 });
    setCVar('sw_workers', 4);
    const banded = bootPlay({ width: 64, height: 48 });
    expect(banded.refresh.testWorkerStats().active).toBe(true);
    expect(serial.refresh.testWorkerStats().active).toBe(false);
    try {
      for (const boot of [serial, banded]) {
        for (let t = 0; t <= 320; t += 16) boot.host.frame(t);
      }
      setCVar('vid_renderer', 'voodoo');
      setCVar('vd_gamma', 1.3);
      setCVar('vd_dither', 1);
      setCVar('vd_16bit', 1);
      setCVar('vd_postfilter', 1);
      setCVar('cl_showfps', 0);
      setCVar('cl_showpos', 0);
      const hud = { fps: 60, frame: 7 };
      const a = resolveDisplay(serial, hud);
      const b = resolveDisplay(banded, hud);
      expect(Array.from(b)).toEqual(Array.from(a));
      expect(serial.lastVoodooPath).toBe('serial');
      expect(banded.lastVoodooPath).toBe('serial');
    } finally {
      setCVar('sw_workers', 0);
    }
  });

  it('dither phase is global across the frame (no per-band restart, seams invisible)', () => {
    voodooSandbox();
    const boot = bootPlay({ width: 64, height: 48 });
    setCVar('vd_gamma', 1.0);
    setCVar('vd_dither', 1);
    setCVar('vd_postfilter', 0);
    setCVar('vd_16bit', 1);
    paintLive(boot, 0xff808080);
    const out = resolveDisplay(boot);
    const w = 64;
    const h = 48;
    // Flat field + absolute-coordinate 4x4 dither: period 4 in both axes
    // across the WHOLE frame, including every band boundary row.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x + 4 < w; x++) {
        expect(out[y * w + x]).toBe(out[y * w + x + 4]);
      }
    }
    for (let y = 0; y + 4 < h; y++) {
      for (let x = 0; x < w; x++) {
        expect(out[y * w + x]).toBe(out[(y + 4) * w + x]);
      }
    }
  });
});

// V2d presentation: fixed 640x480 4:3, controlled upscale, no smoothing.
describe('strict voodoo presentation', () => {
  it('capture resolution is fixed 640x480 4:3', () => {
    expect(VOODOO_FRAME_WIDTH).toBe(640);
    expect(VOODOO_FRAME_HEIGHT).toBe(480);
    expect(isVoodooAspect(640, 480)).toBe(true);
    expect(isVoodooAspect(320, 240)).toBe(true);
    expect(isVoodooAspect(800, 600)).toBe(true);
    expect(isVoodooAspect(100, 100)).toBe(false);
    expect(isVoodooAspect(0, 0)).toBe(false);
  });

  it('canvas presentation is pixelated (no second smoothing) and headless-safe', () => {
    expect(() => applyVoodooPresentation(undefined)).not.toThrow();
    expect(() => applyVoodooPresentation(null)).not.toThrow();
    expect(() => applyVoodooPresentation({})).not.toThrow();
    const style: Record<string, string> = {};
    applyVoodooPresentation({ style });
    expect(style['imageRendering']).toBe('pixelated');
  });
});
