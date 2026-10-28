// Voodoo regression release gate (Q2_PAK-gated, 640x480, real assets).
//
// Asset-free unit tests cannot catch these — they need the real base1 lump,
// real MD2/PCX skins, the actual boot/render/resolve path (viewmodel,
// entities, animation, HUD, resolve/display), and sustained frames:
//
// 1. Missing assets or geometry: world/entities/gun/HUD render through the
//    full application path (bootPlay -> buildAsyncView -> renderView ->
//    endFrame -> resolveDisplay), asserting pixel/region behavior.
// 2. Black/holey viewmodel gun: depth-bias UV/LOD + 255-hole fixes.
// 3. Progressive FPS decline: bounded caches + no time drift over a soak.
//
// Ordinary CI (no pak) SKIPS these (repo convention). The release gate must
// FAIL CLEARLY when assets are unavailable instead of reporting a silent
// skip: set Q2_RELEASE_GATE=1 in the release job and the availability probe
// below fails the run when Q2_PAK is absent. Never commit game assets.
import { describe, expect, it, afterEach } from 'vitest';
import { setCVar } from '@q2/config';
import {
  applyRendererCvar,
  bootPlay,
  buildAsyncView,
  createAsyncLoopState,
  frameAsync,
  resolveDisplay,
} from './play.js';

const WEB_Q2_PAK = process.env.Q2_PAK;
const RELEASE_GATE = process.env.Q2_RELEASE_GATE === '1';

const W = 640;
const H = 480;

async function bootBase1() {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  return bootPlay({ width: W, height: H, pak: ingestPak(buf) });
}

function resetCvars(): void {
  for (const [name, value] of [
    ['vid_renderer', 'software'],
    ['sw_workers', 0],
    ['r_brightness', 1],
    ['cl_showfps', 0],
    ['cl_showpos', 0],
  ] as Array<[string, string | number]>) {
    try {
      setCVar(name, value);
    } catch {
      /* absent cvar: sandbox best-effort */
    }
  }
}

afterEach(() => {
  resetCvars();
});

function luminance(px: number): number {
  return ((px & 255) + ((px >> 8) & 255) + ((px >> 16) & 255)) / 3;
}

function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

describe('voodoo release-gate availability', () => {
  it('fails clearly when the asset gate cannot run', () => {
    if (WEB_Q2_PAK) return;
    expect(
      RELEASE_GATE,
      'Q2_RELEASE_GATE=1 but Q2_PAK is absent: the asset-enabled release gate did NOT run — this is a release failure, not a pass',
    ).toBe(false);
  });
});

describe.runIf(!!WEB_Q2_PAK)('voodoo regression release gate (base1, 640x480)', () => {
  it('world, entities, gun and HUD render through the full application path', { timeout: 240000 }, async () => {
    const boot = await bootBase1();
    // hermetic HUD gates (afterEach(resetCvars) disables these; defaults
    // would pass by luck of test order — pin them explicitly)
    setCVar('cl_showfps', 1);
    setCVar('cl_showpos', 1);
    for (let f = 0; f < 10; f++) boot.host.frame(f * 100);
    const { view, renderables } = buildAsyncView(boot.host, 0);
    expect(renderables.length).toBeGreaterThan(10);
    const gun = renderables.filter((e) => (e as { depthHack?: boolean }).depthHack === true);
    expect(gun.length).toBe(1);

    // software leg (reference behavior for this scene)
    setCVar('vid_renderer', 'software');
    applyRendererCvar(boot);
    (boot.refresh as unknown as { setRGBWorldEnabled: (b: boolean) => void }).setRGBWorldEnabled(false);
    boot.refresh.beginFrame();
    const stSw = boot.refresh.renderView(view, boot.host.world, renderables);
    boot.refresh.endFrame();
    const swColor = boot.refresh.getFramebuffer().color.slice();

    // voodoo leg: RGB world path armed, same view/entities
    setCVar('vid_renderer', 'voodoo');
    applyRendererCvar(boot);
    (boot.refresh as unknown as { setRGBWorldEnabled: (b: boolean) => void }).setRGBWorldEnabled(true);
    boot.refresh.beginFrame();
    const stVd = boot.refresh.renderView(view, boot.host.world, renderables);
    boot.refresh.endFrame();
    const vdColor = boot.refresh.getFramebuffer().color.slice();
    const rr = boot.refresh as unknown as {
      testRGBStats: () => { used: boolean; coverPixels: number };
    };
    const rgbStats = rr.testRGBStats();
    expect(rgbStats.used).toBe(true);
    // same geometry admitted in both paths (stats track the classic path)
    expect(stVd.spans).toBe(stSw.spans);
    expect(stVd.pixels).toBe(stSw.pixels);
    // opaque world + sky fill the frame: the overlay must cover ~all of it
    // (a dropped material class would leave seed/composite seams behind)
    expect(rgbStats.coverPixels).toBeGreaterThan(0.95 * W * H);

    // gun region (bottom-right): not black, not holed — within a brightness
    // band of the software reference (overbright x2 lifts RGB by design, so
    // the band is asymmetric; a black-gun regression reads ~5x darker)
    // Entity-isolated gun coverage (P2 gate): the bbox means below mix gun
    // pixels with background wall/floor, so a missing or invisible gun still
    // passes the brightness band (background keeps the rect bright). Compare
    // gun-present vs gun-absent submissions in the SAME renderer mode: only
    // pixels the depthHack entity actually paints can differ. A gun that
    // renders nothing (or is stripped) yields diff ~ 0 and fails here.
    const bbox = { x0: 380, y0: 280, x1: W - 1, y1: H - 1 };
    const noGun = renderables.filter((e) => (e as { depthHack?: boolean }).depthHack !== true);
    expect(noGun.length).toBe(renderables.length - 1);
    setCVar('vid_renderer', 'software');
    applyRendererCvar(boot);
    (boot.refresh as unknown as { setRGBWorldEnabled: (b: boolean) => void }).setRGBWorldEnabled(false);
    boot.refresh.beginFrame();
    boot.refresh.renderView(view, boot.host.world, noGun);
    boot.refresh.endFrame();
    const swNoGun = boot.refresh.getFramebuffer().color.slice();
    setCVar('vid_renderer', 'voodoo');
    applyRendererCvar(boot);
    (boot.refresh as unknown as { setRGBWorldEnabled: (b: boolean) => void }).setRGBWorldEnabled(true);
    boot.refresh.beginFrame();
    boot.refresh.renderView(view, boot.host.world, noGun);
    boot.refresh.endFrame();
    const vdNoGun = boot.refresh.getFramebuffer().color.slice();
    const DIFF_T = 8;
    let swSum = 0, vdSum = 0, vdNz = 0, n = 0;
    let swDiff = 0, vdDiff = 0;
    for (let y = bbox.y0; y <= bbox.y1; y++) {
      for (let x = bbox.x0; x <= bbox.x1; x++) {
        const s = luminance(swColor[y * W + x]!);
        const v = luminance(vdColor[y * W + x]!);
        swSum += s;
        vdSum += v;
        if (v > 4) vdNz++;
        n++;
        if (Math.abs(s - luminance(swNoGun[y * W + x]!)) > DIFF_T) swDiff++;
        if (Math.abs(v - luminance(vdNoGun[y * W + x]!)) > DIFF_T) vdDiff++;
      }
    }
    // The reference leg must actually show the gun here (guards a camera
    // where the gun is off-screen: without this the voodoo asserts below
    // could pass vacuously). 2% of the 52k-px box = ~1040 px; a real
    // viewmodel covers several thousand.
    expect(swDiff / n).toBeGreaterThan(0.02);
    // Voodoo must paint a comparable gun silhouette: an invisible gun
    // (full ~= absent, diff ~ 0) fails, as does a holed/shrunken one.
    expect(vdDiff / n).toBeGreaterThan(0.02);
    expect(vdDiff).toBeGreaterThan(0.5 * swDiff);
    const swMean = swSum / n, vdMean = vdSum / n;
    expect(vdNz / n).toBeGreaterThan(0.5);
    expect(vdMean).toBeGreaterThan(0.5 * swMean);
    expect(vdMean).toBeLessThan(3.0 * swMean);

    // resolve/display stage with HUD: scanout completes and HUD text lands
    const disp = resolveDisplay(boot, { fps: 60, frame: 1 }).slice();
    expect(disp.length).toBe(W * H);
    let hudTop = 0;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < W; x++) if (luminance(disp[y * W + x]!) > 150) hudTop++;
    }
    expect(hudTop).toBeGreaterThan(50);
  });

  it('sustained soak: bounded resources, no progressive slowdown', { timeout: 420000 }, async () => {
    const boot = await bootBase1();
    setCVar('vid_renderer', 'voodoo');
    applyRendererCvar(boot);
    const rr = boot.refresh as unknown as {
      setRGBWorldEnabled: (b: boolean) => void;
      testRGBCacheStats: () => {
        hits: number; misses: number; size: number; evictions: number;
        chainHits: number; chainMisses: number; chainSize: number;
        chainUsed: number; chainEvictions: number;
      };
      testCacheStats: () => { size: number; evictions: number; used: number };
    };
    rr.setRGBWorldEnabled(true);
    const st = createAsyncLoopState();
    let nowMs = 1000;
    // warmup: hot caches, steady state (not counted)
    for (let f = 0; f < 12; f++) {
      nowMs += 100;
      boot.host.input.angles = [0, 135, 0];
      await frameAsync(boot, st, nowMs);
    }
    const N = 60;
    const frameMs: number[] = [];
    for (let f = 0; f < N; f++) {
      nowMs += 100;
      boot.host.input.angles = [0, 135, 0];
      const t0 = performance.now();
      await frameAsync(boot, st, nowMs);
      frameMs.push(performance.now() - t0);
    }
    const first = med(frameMs.slice(0, 20));
    const last = med(frameMs.slice(-20));
    // no progressive degradation: last window within 50% of first (ratio,
    // not absolute ms — machine-independent; absolute budgets stay in
    // docs/perf-ledger.md on the benchmark machine)
    expect(last).toBeLessThan(first * 1.5);
    const rc = rr.testRGBCacheStats();
    const sc = rr.testCacheStats();
    // bounded resources: working set fits, nothing evicted, nothing grows
    expect(rc.chainEvictions).toBe(0);
    expect(rc.evictions).toBe(0);
    expect(sc.evictions).toBe(0);
    expect(rc.chainSize).toBeLessThanOrEqual(512);
    expect(rc.size).toBeLessThanOrEqual(20000);
    // caches actually serve (a silently-cold cache would pass eviction
    // checks while rebuilding everything every frame)
    expect(rc.hits).toBeGreaterThan(rc.misses);
    expect(rc.chainHits).toBeGreaterThan(rc.chainMisses);
  });

  it('combat frames render effects with hot caches', { timeout: 300000 }, async () => {
    const boot = await bootBase1();
    setCVar('vid_renderer', 'voodoo');
    applyRendererCvar(boot);
    const rr = boot.refresh as unknown as {
      setRGBWorldEnabled: (b: boolean) => void;
      testRGBCacheStats: () => { hits: number; misses: number };
      testTracerCount: () => number;
      testDynamicLightCount: () => number;
    };
    rr.setRGBWorldEnabled(true);
    const st = createAsyncLoopState();
    let nowMs = 1000;
    for (let f = 0; f < 10; f++) {
      nowMs += 100;
      await frameAsync(boot, st, nowMs);
    }
    let fired = false;
    for (let f = 0; f < 20; f++) {
      nowMs += 100;
      boot.host.input.angles = [0, 135, 0];
      (boot.host.input as unknown as { buttons: number }).buttons = 1;
      await frameAsync(boot, st, nowMs);
      if (rr.testTracerCount() > 0 || rr.testDynamicLightCount() > 0) fired = true;
    }
    (boot.host.input as unknown as { buttons: number }).buttons = 0;
    // firing happened (muzzle/dlight/tracer path exercised, serial churned)
    expect(fired).toBe(true);
    const rc = rr.testRGBCacheStats();
    // untouched surfaces stay hot through the churn (surgical invalidation)
    expect(rc.hits).toBeGreaterThan(rc.misses);
  });
});
