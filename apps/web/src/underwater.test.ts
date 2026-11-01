// RELEASE-15 — underwater view distortion and transitions.
//
// Ground truth (../external/quake-2-source): game/p_view.c SV_CalcBlend
// (eye-contents blend + RDF_UNDERWATER), ref_soft/r_scan.c D_WarpScreen
// (sine screen warp, sw_waterwarp default 1), ref_soft/r_main.c
// R_CalcPalette (warp-then-tint), ref_gl/gl_rmain.c R_PolyBlend (tint quad,
// NO screen warp anywhere in ref_gl — grep RDF_UNDERWATER hits only game +
// ref_soft). There is no FOV change and no surface refraction in either
// original backend: looking through the animated surface at submerged
// objects renders them unrefracted; only the eye-under-contents case warps.
//
// Boots real base1 through bootPlay and asserts the presented frame:
//   (u1) eye-contents classification + C-exact tint (drawPlayHud wash,
//        contents composited BEFORE the damage wash per C order), HUD
//        painted after, unblended; dry eye = no wash.
//   (u2) software screen warp on the index plane (D_WarpScreen port):
//        deterministic per time, absent above water, omitted-warp control.
//   (u3) transitions above/below/partially-submerged, opaque submerged
//        objects (viewmodel gun), moving views, source FOV, GPU overlay
//        parity (tint, never warp).
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import type { UserCmdT } from '@q2/input';
import { v3, type Vec3 } from '@q2/math';
import {
  bspPointContentsFor,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  CONTENTS_LAVA,
  MASK_WATER,
} from '@q2/game';
import {
  applyUnderwaterWarp,
  applyRendererCvar,
  bootPlay,
  buildAsyncView,
  createAsyncLoopState,
  drawPlayHud,
  frameAsync,
  paintHudOverlay,
  resizePlay,
  resolveDisplay,
} from './play.js';
import {
  eyeContentsAt,
  UNDERWATER_WARP_AMP,
  UNDERWATER_WARP_CYCLE,
  underwaterBlendForContents,
  warpIndexBufferUnderwater,
  warpTableInt,
} from './underwater.js';

const WEB_Q2_PAK = process.env.Q2_PAK;

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

async function bootBase1(width = 96, height = 72) {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  return bootPlay({ width, height, pak: ingestPak(buf) });
}

/** Low-road pool probe column (drowning.test.ts survey). */
const POOL_X = 430;
const POOL_Y = 620;

afterEach(() => {
  resetCVars();
});

describe('RELEASE-15 port constants (C-exact, asset-free)', () => {
  it('warp table matches R_InitTurb intsintable (AMP2=3, CYCLE=128)', () => {
    // intsintable[i] = 3 + sin(i*2π/128)*3, integer truncation.
    expect(warpTableInt(0)).toBe(3);
    expect(warpTableInt(32)).toBe(6);
    expect(warpTableInt(64)).toBe(3);
    expect(warpTableInt(96)).toBe(0);
    expect(UNDERWATER_WARP_AMP).toBe(3);
    expect(UNDERWATER_WARP_CYCLE).toBe(128);
  });

  it('contents blend matches the SV_CalcBlend block exactly', () => {
    expect(underwaterBlendForContents(0)).toBeNull();
    expect(underwaterBlendForContents(CONTENTS_WATER)).toEqual({
      kind: 'water', r: 0.5, g: 0.3, b: 0.2, a: 0.4, submerged: true,
    });
    expect(underwaterBlendForContents(CONTENTS_SLIME)).toEqual({
      kind: 'slime', r: 0.0, g: 0.1, b: 0.05, a: 0.6, submerged: true,
    });
    expect(underwaterBlendForContents(CONTENTS_LAVA)).toEqual({
      kind: 'lava', r: 1.0, g: 0.3, b: 0.0, a: 0.6, submerged: true,
    });
    // Solid eye blends orange like C but never warps (no RDF_UNDERWATER).
    const solid = underwaterBlendForContents(CONTENTS_SOLID)!;
    expect(solid.a).toBe(0.6);
    expect(solid.submerged).toBe(false);
  });

  it('warp is deterministic per time and permutes a gradient', () => {
    const w = 48;
    const h = 36;
    const grad = new Uint8Array(w * h);
    for (let i = 0; i < grad.length; i++) grad[i] = i & 255;
    const a = grad.slice();
    expect(warpIndexBufferUnderwater(a, w, h, 1.25)).toBe(true);
    expect([...a]).not.toEqual([...grad]); // displacement moves texels
    const b = grad.slice();
    expect(warpIndexBufferUnderwater(b, w, h, 1.25)).toBe(true);
    expect([...b]).toEqual([...a]); // same time = bit-identical
    const c = grad.slice();
    expect(warpIndexBufferUnderwater(c, w, h, 2.75)).toBe(true);
    expect([...c]).not.toEqual([...a]); // moved phase = moved frame
    // Nearest-neighbor warp only relocates texels, never invents them.
    const inSet = new Set(grad);
    for (const v of c) expect(inSet.has(v)).toBe(true);
    expect(warpIndexBufferUnderwater(new Uint8Array(10), w, h, 1)).toBe(false);
  });
});

describe.runIf(!!WEB_Q2_PAK)('RELEASE-15 base1 underwater presentation', () => {
  /** Scan the pool column for the first water leaf: the render surface. */
  async function surveySurface(contents: (p: Vec3) => number): Promise<number> {
    for (let z = -100; z > -400; z -= 2) {
      if (contents(v3(POOL_X, POOL_Y, z)) & MASK_WATER) return z;
    }
    throw new Error('no water found in pool column');
  }

  /**
   * Teleport an already-settled boot's authoritative eye and build the
   * matching view + renderables (no boot). Split from placeEye so resize and
   * switch tests can re-derive the view WITHOUT stepping (a settle step
   * would sink the player and move the eye, breaking byte equality).
   */
  function framePartsForEye(
    boot: ReturnType<typeof bootPlay>,
    angles: [number, number, number] = [0, 0, 0],
    time = 3.7,
  ) {
    const { driver } = boot;
    const eye: [number, number, number] = [
      driver.pm.origin[0]!,
      driver.pm.origin[1]!,
      driver.pm.origin[2]! + driver.pm.viewheight,
    ];
    const view = {
      origin: new Float32Array(eye) as Vec3,
      angles: new Float32Array(angles) as Vec3,
      fovX: 90,
      time,
      lightStyles: new Float32Array(256).fill(1),
    };
    const { renderables } = buildAsyncView(boot.host, 0);
    for (const e of renderables) {
      if (e.depthHack) e.origin = new Float32Array(eye) as typeof e.origin;
    }
    return { view, renderables };
  }

  function submergeBoot(
    boot: ReturnType<typeof bootPlay>,
    originZ: number,
    angles: [number, number, number] = [0, 0, 0],
    time = 3.7,
  ) {
    const { driver } = boot;
    driver.pm.origin = v3(POOL_X, POOL_Y, originZ);
    driver.pm.velocity = v3();
    driver.step(neutralCmd(), 0.1);
    return framePartsForEye(boot, angles, time);
  }

  async function placeEye(originZ: number, angles: [number, number, number] = [0, 0, 0], time = 3.7, width = 96, height = 72) {
    // NOTE: buildAsyncView reads predictor entities (stale across a bare
    // pm teleport), so the view is built from the authoritative pm eye
    // directly — origin + viewheight, the exact point SV_CalcBlend samples
    // and underwaterOverlay() classifies. Renderables (gun tail) come from
    // buildAsyncView with the depthHack gun re-anchored to this eye.
    const boot = await bootBase1(width, height);
    const { driver } = boot;
    for (let i = 0; i < 5; i++) driver.step(neutralCmd(), 0.1);
    return { boot, ...submergeBoot(boot, originZ, angles, time) };
  }

  function renderFrame(
    boot: ReturnType<typeof bootPlay>,
    view: { origin: Vec3; angles: Vec3; fovX: number; time: number; lightStyles: Float32Array },
    renderables: Parameters<ReturnType<typeof bootPlay>['refresh']['renderView']>[2],
  ): Uint32Array {
    boot.refresh.beginFrame();
    boot.refresh.renderView(
      view as Parameters<ReturnType<typeof bootPlay>['refresh']['renderView']>[0],
      boot.host.world,
      renderables,
    );
    boot.refresh.endFrame();
    return new Uint32Array(resolveDisplay(boot));
  }

  it('(u1) submerged eye tints C-exact, dry eye stays clean, HUD unblended', { timeout: 180000 }, async () => {
    const boot0 = await bootBase1();
    const contents = bspPointContentsFor(boot0.driver.map!);
    const surf = await surveySurface(contents);
    // Eye 12 under the surface (viewheight 22 standing + margin).
    const { boot, view, renderables } = await placeEye(surf - 22 - 12);
    const eyeZ = view.origin[2]!;
    expect(eyeZ).toBeLessThan(surf);
    const uw = boot.driver.underwaterOverlay();
    expect(uw).not.toBeNull();
    expect(uw!.kind).toBe('water');
    expect(uw!.a).toBeCloseTo(0.4, 5);
    // Presented frame: SRC_OVER the resolved pixel with the exact C rgba
    // (driver overlay channels are 0..255 like damageOverlay; alpha 0..1).
    const frame = renderFrame(boot, view, renderables);
    const w = 96;
    const h = 72;
    const px = 2;
    const py = (h / 2) | 0;
    const before = frame[py * w + px]!;
    const target = { width: w, height: h, color: frame };
    drawPlayHud(target, boot, { fps: 0, frame: 1 });
    const after = target.color[py * w + px]!;
    const sr = Math.round(uw!.r);
    const sg = Math.round(uw!.g);
    const sb = Math.round(uw!.b);
    const dr = before & 255;
    const dg = (before >> 8) & 255;
    const db = (before >> 16) & 255;
    const er = Math.round(sr * uw!.a + dr * (1 - uw!.a));
    const eg = Math.round(sg * uw!.a + dg * (1 - uw!.a));
    const eb = Math.round(sb * uw!.a + db * (1 - uw!.a));
    expect(after & 255).toBe(er);
    expect((after >> 8) & 255).toBe(eg);
    expect((after >> 16) & 255).toBe(eb);
    // Crosshair paints after the wash, full white.
    expect(target.color[((h / 2) | 0) * w + ((w / 2) | 0)]).toBe(0xffffffff);
    // Dry control: spawn eye has no overlay and the probe pixel is untouched.
    const dry = await bootBase1();
    for (let i = 0; i < 5; i++) dry.driver.step(neutralCmd(), 0.1);
    expect(dry.driver.underwaterOverlay()).toBeNull();
    const { view: dv, renderables: dr2 } = buildAsyncView(dry.host, 0);
    const dframe = renderFrame(dry, dv, dr2);
    const dcopy = new Uint32Array(dframe);
    drawPlayHud({ width: w, height: h, color: dframe }, dry, { fps: 0, frame: 1 });
    expect(dframe[py * w + px]).toBe(dcopy[py * w + px]);
  });

  it('(u2) software warp is gated, deterministic, time-varying (omitted-warp control)', { timeout: 180000 }, async () => {
    const boot0 = await bootBase1();
    const contents = bspPointContentsFor(boot0.driver.map!);
    const surf = await surveySurface(contents);
    const { boot, view, renderables } = await placeEye(surf - 22 - 12);
    const fb = boot.refresh.getFramebuffer();
    expect(fb.index).toBeDefined();
    // Omitted-warp control: render twice with no warp, identical.
    boot.refresh.beginFrame();
    boot.refresh.renderView(view as never, boot.host.world, renderables);
    const plainA = new Uint8Array(fb.index!);
    boot.refresh.beginFrame();
    boot.refresh.renderView(view as never, boot.host.world, renderables);
    const plainB = new Uint8Array(fb.index!);
    expect([...plainB]).toEqual([...plainA]);
    // Warp applies exactly when submerged, bit-identical per time.
    boot.refresh.beginFrame();
    boot.refresh.renderView(view as never, boot.host.world, renderables);
    expect(applyUnderwaterWarp(boot, view.time)).toBe(true);
    const warpedA = new Uint8Array(fb.index!);
    expect([...warpedA]).not.toEqual([...plainA]);
    boot.refresh.beginFrame();
    boot.refresh.renderView(view as never, boot.host.world, renderables);
    expect(applyUnderwaterWarp(boot, view.time)).toBe(true);
    expect([...new Uint8Array(fb.index!)]).toEqual([...warpedA]);
    // Moved clock = moved warp (D_WarpScreen phase runs on RefDef.time).
    boot.refresh.beginFrame();
    boot.refresh.renderView(view as never, boot.host.world, renderables);
    expect(applyUnderwaterWarp(boot, view.time + 1.7)).toBe(true);
    expect([...new Uint8Array(fb.index!)]).not.toEqual([...warpedA]);
    // Dry eye: the hook is a no-op (ref_gl parity above water — no warp).
    const dry = await bootBase1();
    for (let i = 0; i < 5; i++) dry.driver.step(neutralCmd(), 0.1);
    const { view: dv, renderables: drr } = buildAsyncView(dry.host, 0);
    dry.refresh.beginFrame();
    dry.refresh.renderView(dv as never, dry.host.world, drr);
    const dfb = dry.refresh.getFramebuffer();
    const dBefore = new Uint8Array(dfb.index!);
    expect(applyUnderwaterWarp(dry, dv.time)).toBe(false);
    expect([...new Uint8Array(dfb.index!)]).toEqual([...dBefore]);
  });

  it('(u3) transitions flip at the surface; partial submersion stays clean', { timeout: 180000 }, async () => {
    const boot0 = await bootBase1();
    const contents = bspPointContentsFor(boot0.driver.map!);
    const surf = await surveySurface(contents);
    // Just above: dry. Just below: submerged. Binary flip, no gradualism (C).
    // ±8 margins absorb the single settle-tick gravity sink (~4u).
    const above = await placeEye(surf - 22 + 8);
    expect(above.view.origin[2]!).toBeGreaterThan(surf);
    expect(above.boot.driver.underwaterOverlay()).toBeNull();
    expect(applyUnderwaterWarp(above.boot, above.view.time)).toBe(false);
    const below = await placeEye(surf - 22 - 8);
    expect(below.view.origin[2]!).toBeLessThan(surf);
    expect(below.boot.driver.underwaterOverlay()).not.toBeNull();
    expect(applyUnderwaterWarp(below.boot, below.view.time)).toBe(true);
    // Partially submerged body (feet wet, eye dry): no wash, no warp.
    const partial = await placeEye(surf - 22 + 8);
    expect(partial.boot.driver.pm.waterlevel).toBeGreaterThan(0);
    expect(partial.boot.driver.underwaterOverlay()).toBeNull();
  });

  it('(u3) solid eye stays unwashed (documented SV_CalcBlend deviation)', { timeout: 120000 }, async () => {
    // The pool-view tile-seam camera teleports into rock at (416,900):
    // contents SOLID. C would tint orange (blend without RDF_UNDERWATER);
    // q2ts leaves it clean so capture gates keep reading the raw scene.
    const boot = await bootBase1();
    const { driver } = boot;
    for (let i = 0; i < 5; i++) driver.step(neutralCmd(), 0.1);
    driver.pm.origin = v3(416, 900, -122);
    driver.pm.velocity = v3();
    driver.step(neutralCmd(), 0.1);
    expect(driver.underwaterOverlay()).toBeNull();
    expect(applyUnderwaterWarp(boot, 3.7)).toBe(false);
  });

  it('(u3) submerged opaques still draw, FOV fixed, water keeps moving', { timeout: 240000 }, async () => {
    const boot0 = await bootBase1();
    const contents = bspPointContentsFor(boot0.driver.map!);
    const surf = await surveySurface(contents);
    const { boot, view, renderables } = await placeEye(surf - 22 - 12);
    expect(view.fovX).toBe(90); // no underwater FOV change in either source backend
    expect(renderables.length).toBeGreaterThan(0); // eye-anchored viewmodel gun
    expect(renderables.every((e) => e.alpha === undefined)).toBe(true);
    const withGun = renderFrame(boot, view, renderables);
    const bare = renderFrame(boot, view, []);
    let diff = 0;
    for (let i = 0; i < withGun.length; i++) if (withGun[i] !== bare[i]) diff++;
    expect(diff).toBeGreaterThan(100); // opaque gun draws while submerged
    // Surface motion WITHOUT the screen warp: dry eye over the pool,
    // pitched down at the water — the turbulent surface animates between
    // clocks (looking through it refracts nothing; objects stay put).
    const over1 = await placeEye(surf + 30, [30, 0, 0], 5.0);
    const over2 = await placeEye(surf + 30, [30, 0, 0], 7.0);
    const f1 = renderFrame(over1.boot, over1.view, over1.renderables);
    const f2 = renderFrame(over2.boot, over2.view, over2.renderables);
    let surfaceMotion = 0;
    for (let i = 0; i < f1.length; i++) if (f1[i] !== f2[i]) surfaceMotion++;
    expect(surfaceMotion).toBeGreaterThan(0);
    // Warp-on vs warp-off at the SAME clock isolates the screen warp from
    // surface motion.
    const sameT = renderFrame(boot, view, renderables);
    boot.refresh.beginFrame();
    boot.refresh.renderView(view as never, boot.host.world, renderables);
    expect(applyUnderwaterWarp(boot, view.time)).toBe(true);
    boot.refresh.endFrame();
    const warpedSameT = new Uint32Array(resolveDisplay(boot));
    let warpDelta = 0;
    for (let i = 0; i < sameT.length; i++) if (sameT[i] !== warpedSameT[i]) warpDelta++;
    expect(warpDelta).toBeGreaterThan(0);
    // GPU overlay parity: the tint rides paintHudOverlay as TRANSLUCENT
    // pixels (browser composites tint-over-GL — the scene stays visible;
    // ref_gl has no RDF_UNDERWATER screen warp, so warp never applies).
    const over = paintHudOverlay(boot, { fps: 0, frame: 1 });
    const w = 96;
    const py = ((72 / 2) | 0) * w + 2;
    const opx = over[py]!;
    const uwFull = boot.driver.underwaterOverlay()!;
    const ea = Math.round(uwFull.a * 255);
    const epx = ((ea << 24) |
      (Math.round(uwFull.b) << 16) |
      (Math.round(uwFull.g) << 8) |
      Math.round(uwFull.r)) >>> 0;
    expect(opx).toBe(epx); // exact translucent wash pixel, GL shows through
    expect((opx >>> 24) & 255).toBeLessThan(255); // never seals the overlay
    expect(opx).not.toBe(sameT[py]); // distinct from the opaque scene pixel
  });

  it('(u1) eye query matches raw contents modulo the 1/16 cl_view nudge', { timeout: 60000 }, async () => {
    const boot = await bootBase1();
    const raw = bspPointContentsFor(boot.driver.map!);
    const eye = v3(POOL_X, POOL_Y, -100);
    expect(eyeContentsAt(raw, eye)).toBe(raw(v3(POOL_X + 1 / 16, POOL_Y + 1 / 16, -100 + 1 / 16)));
  });

  it('(u2) production frameAsync runs the warp hook underwater without throwing', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    for (let i = 0; i < 5; i++) driver.step(neutralCmd(), 0.1);
    driver.pm.origin = v3(POOL_X, POOL_Y, -280);
    driver.pm.velocity = v3();
    const st = createAsyncLoopState();
    let shown: Uint32Array | null = null;
    for (let k = 0; k < 3; k++) shown = await frameAsync(boot, st, 5000 + k * 16);
    expect(shown!.length).toBe(96 * 72);
    // The production loop classifies the same submerged eye the unit path
    // does (predictor convergence is a live-loop property; the hook reads
    // the authoritative pm eye either way).
    expect(driver.underwaterOverlay()).not.toBeNull();
  });

  it('(u2-res) warp gating + determinism hold at 160x120 and survive a resizePlay round-trip', { timeout: 240000 }, async () => {
    const W = 160;
    const H = 120;
    const boot = await bootBase1(W, H);
    const contents = bspPointContentsFor(boot.driver.map!);
    const surf = await surveySurface(contents);
    const eyeZ = surf - 22 - 12;
    for (let i = 0; i < 5; i++) boot.driver.step(neutralCmd(), 0.1);
    const placed = submergeBoot(boot, eyeZ);
    expect(boot.driver.underwaterOverlay()?.kind).toBe('water');
    const snapPlain = (): Uint8Array => {
      boot.refresh.beginFrame();
      boot.refresh.renderView(placed.view as never, boot.host.world, placed.renderables);
      return new Uint8Array(boot.refresh.getFramebuffer().index!);
    };
    const snapWarped = (t: number): Uint8Array => {
      boot.refresh.beginFrame();
      boot.refresh.renderView(placed.view as never, boot.host.world, placed.renderables);
      expect(applyUnderwaterWarp(boot, t)).toBe(true);
      return new Uint8Array(boot.refresh.getFramebuffer().index!);
    };
    // Omitted-warp control at the second resolution: no warp = no change.
    expect([...snapPlain()]).toEqual([...snapPlain()]);
    const warpedBig = snapWarped(placed.view.time);
    expect([...warpedBig]).not.toEqual([...snapPlain()]);
    expect([...snapWarped(placed.view.time)]).toEqual([...warpedBig]);
    expect([...snapWarped(placed.view.time + 1.7)]).not.toEqual([...warpedBig]);
    // Resize down: the per-resolution compression tables rebuild and the
    // smaller frame is deterministic too. framePartsForEye re-derives the
    // view WITHOUT stepping (resizePlay preserves sim; a settle step would
    // sink the player and move the eye).
    expect(resizePlay(boot, 96, 72)).toBe(true);
    const smallFb = boot.refresh.getFramebuffer();
    expect(smallFb.width).toBe(96);
    expect(smallFb.height).toBe(72);
    const small = framePartsForEye(boot, [0, 0, 0], placed.view.time);
    const snapSmallWarped = (): Uint8Array => {
      boot.refresh.beginFrame();
      boot.refresh.renderView(small.view as never, boot.host.world, small.renderables);
      expect(applyUnderwaterWarp(boot, small.view.time)).toBe(true);
      return new Uint8Array(boot.refresh.getFramebuffer().index!);
    };
    expect(boot.driver.underwaterOverlay()?.kind).toBe('water');
    expect([...snapSmallWarped()]).toEqual([...snapSmallWarped()]);
    // Resize back: the rebuilt 160x120 tables give back bit-identical bytes.
    expect(resizePlay(boot, W, H)).toBe(true);
    expect(boot.refresh.getFramebuffer().width).toBe(W);
    const back = framePartsForEye(boot, [0, 0, 0], placed.view.time);
    boot.refresh.beginFrame();
    boot.refresh.renderView(back.view as never, boot.host.world, back.renderables);
    expect(applyUnderwaterWarp(boot, back.view.time)).toBe(true);
    expect([...new Uint8Array(boot.refresh.getFramebuffer().index!)]).toEqual([...warpedBig]);
    // Transition flip at the second size: eye just above the surface is dry.
    // ±8 absorbs the single settle-tick gravity sink (~4u).
    const aboveEye = submergeBoot(boot, surf - 22 + 8);
    expect(aboveEye.view.origin[2]!).toBeGreaterThan(surf);
    expect(boot.driver.underwaterOverlay()).toBeNull();
    expect(applyUnderwaterWarp(boot, aboveEye.view.time)).toBe(false);
  });

  it('(u2-locality) warped texels relocate within the AMP2+MARGIN neighborhood', { timeout: 180000 }, async () => {
    // D_WarpScreen displaces by table[phase+v] (0..AMP2) through the
    // compression tables, so |dx|,|dy| <= AMP2 (=3) plus the edge-compression
    // shift (<= MARGIN = 2*AMP2 = 6 total). Radius 8 has headroom; anything
    // beyond it would be an invented distortion, not the C sine warp.
    const W = 160;
    const H = 120;
    const R = 8;
    const boot = await bootBase1(W, H);
    const contents = bspPointContentsFor(boot.driver.map!);
    const surf = await surveySurface(contents);
    for (let i = 0; i < 5; i++) boot.driver.step(neutralCmd(), 0.1);
    const { view, renderables } = submergeBoot(boot, surf - 22 - 12);
    boot.refresh.beginFrame();
    boot.refresh.renderView(view as never, boot.host.world, renderables);
    const plain = new Uint8Array(boot.refresh.getFramebuffer().index!);
    boot.refresh.beginFrame();
    boot.refresh.renderView(view as never, boot.host.world, renderables);
    expect(applyUnderwaterWarp(boot, view.time)).toBe(true);
    const warped = new Uint8Array(boot.refresh.getFramebuffer().index!);
    expect([...warped]).not.toEqual([...plain]);
    let missing = 0;
    let first = '';
    for (let v = 0; v < H; v++) {
      for (let u = 0; u < W; u++) {
        const val = warped[v * W + u]!;
        let found = false;
        for (let dv = -R; dv <= R && !found; dv++) {
          const vv = v + dv;
          if (vv < 0 || vv >= H) continue;
          for (let du = -R; du <= R; du++) {
            const uu = u + du;
            if (uu < 0 || uu >= W) continue;
            if (plain[vv * W + uu] === val) {
              found = true;
              break;
            }
          }
        }
        if (!found) {
          if (missing === 0) first = `pixel (${u},${v}) value ${val} has no match within Chebyshev ${R}`;
          missing++;
        }
      }
    }
    expect(`${missing} ${first}`).toBe(`0 `);
  });

  it('(u3-switch) renderer switch + failed-GPU fallback while submerged keep tint and warp', { timeout: 180000 }, async () => {
    const probe = await bootBase1();
    const contents = bspPointContentsFor(probe.driver.map!);
    const surf = await surveySurface(contents);
    const { boot, view, renderables } = await placeEye(surf - 22 - 12);
    expect(boot.driver.underwaterOverlay()?.kind).toBe('water');
    // software->software hot-swap: sim untouched, stale display pixels zeroed.
    boot.display.fill(0xdeadbeef);
    setCVar('vid_renderer', 'software');
    expect(applyRendererCvar(boot)).toBe('software');
    expect(boot.lastRendererWarning).toBeNull();
    expect(boot.display.every((v) => v === 0)).toBe(true);
    expect(boot.driver.underwaterOverlay()?.kind).toBe('water');
    boot.refresh.beginFrame();
    boot.refresh.renderView(view as never, boot.host.world, renderables);
    expect(applyUnderwaterWarp(boot, view.time)).toBe(true);
    // Failed GPU attach while submerged (no GL in node): graceful fallback
    // WITH a warning — the wash and the warp both survive on the CPU path.
    setCVar('vid_renderer', 'webgl2-experimental');
    expect(applyRendererCvar(boot)).toBe('software');
    expect(boot.lastRendererWarning).not.toBeNull();
    expect(boot.gpu).toBeNull();
    expect(boot.driver.underwaterOverlay()?.kind).toBe('water');
    boot.refresh.beginFrame();
    boot.refresh.renderView(view as never, boot.host.world, renderables);
    expect(applyUnderwaterWarp(boot, view.time)).toBe(true);
    boot.refresh.endFrame();
    const shown = new Uint32Array(resolveDisplay(boot));
    const w = 96;
    const h = 72;
    const target = { width: w, height: h, color: shown };
    const px = 2;
    const py = (h / 2) | 0;
    const before = target.color[py * w + px]!;
    drawPlayHud(target, boot, { fps: 0, frame: 1 });
    expect(target.color[py * w + px]).not.toBe(before);
  });
});
