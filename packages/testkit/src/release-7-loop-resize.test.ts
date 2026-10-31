// @q2/testkit — RELEASE-7 running-loop resize regression (testkit lane).
//
// Owns: `packages/testkit` ONLY. Read-only on `apps/web` (source pins read
// `dom.ts`/`play.ts` as TEXT through node:fs — never imported, so
// `yarn deps:check` stays green: testkit may use anything except apps/*,
// and nothing may import from apps/*).
//
// What this covers (RELEASE-7 done-when box 3, testkit side):
//   - a REAL running loop: Host + SoftwareRenderer, frame() + resize() +
//     frame(), never bare resizePlay calls (resizePlay lives in apps/web,
//     outside this lane);
//   - new row stride + output dims, fresh rendered pixels, no RangeError,
//     canvas content bounds matching the live framebuffer, undistorted known
//     geometry across switches/restores, at every offered size
//     (320x240, 640x480, 800x600, 1024x768) in both directions + rapid cycles;
//   - sim preservation: map (world identity), player + enemy (snapshot
//     origins), time (serverTime), audio (mixer channels/masterVol);
//   - synchronously + correctly sized startup loading surface;
//   - DPR note: backing store always equals the framebuffer; DPR only scales
//     the CSS fit box (asserted, never the backing);
//   - headless PPM captures under test-output/ (regenerable, not committed) + pixel
//     assertions (no browser needed).
//
// The stale-blitFb defect (BRAIN.md §8 RELEASE-7 review-finding):
// `apps/web/src/dom.ts:startPlayLoop` builds `blitFb` ONCE from the initial
// framebuffer and `finishFrame` only refreshes `.color`; after `Host.resize`
// replaces the framebuffer the wrapper keeps old width/height (and stale
// index/depth), so the blit copies with the old row stride / overflows the
// cached ImageData, and `blitCopyRGBA`'s min-prefix copy skews silently
// instead of throwing. `resizePlay` additionally ignores `resizeGpuBackend`'s
// boolean failure after mutating host state.
//
// Two pins nail the production defect from this lane:
//   (a) source pins (always run, no env needed) assert the apps/web fix is
//       present in the real files. PRE-FIX THEY FAIL — that failure is the
//       defect proof. POST-FIX they pass without modification.
//   (b) a stale-wrapper mirror, replicated BY VALUE from the pre-fix dom.ts
//       (cited line ranges), demonstrates the skew mechanism headlessly:
//       no RangeError, wrong pixels — which is why "no throw" alone cannot
//       close the card.
//
// Ground truth: apps/web/src/dom.ts blitToCanvas (~L179-215), blitCaches
// (~L218-227), blitCopyRGBA (~L248-262), fitScaleForStage (~L1322-1335),
// startPlayLoop blitFb/finishFrame (~L1517-1611); apps/web/src/play.ts
// resizePlay (~L4173-4214), resolveDisplay (~L4372-4389);
// packages/host/src/index.ts Host.resize (~L508-528),
// captureSimState/restoreSimState (~L530-592). Software goldens untouched
// (no thresholds in this file).

import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetCVars } from '@q2/config';
import { Host } from '@q2/host';
import type { HostDriver } from '@q2/host';
import type { Snapshot } from '@q2/client';
import type { UserCmdT } from '@q2/input';
import type { Framebuffer } from '@q2/renderer-api';
import { SoftwareRenderer, createDevroom, DEVROOM_CAMERA } from '@q2/sw-renderer';

// ---------------------------------------------------------------------------
// Offered sizes (apps/web CVAR_OPTIONS vid_resolution, dom.ts).
// ---------------------------------------------------------------------------

const SIZES: ReadonlyArray<readonly [number, number]> = [
  [320, 240],
  [640, 480],
  [800, 600],
  [1024, 768],
];

// ---------------------------------------------------------------------------
// Deterministic devroom palette (same shape as sw-renderer renderAsync tests).
// ---------------------------------------------------------------------------

function devPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = (i * 5) & 255;
    pal[i * 3 + 1] = (i * 3 + 40) & 255;
    pal[i * 3 + 2] = (i * 2 + 80) & 255;
  }
  return pal;
}

// ---------------------------------------------------------------------------
// Scripted live sim: fixed player spawn + one deterministically moving enemy.
// Map/player/enemy/time/audio preservation is asserted through Host.
// ---------------------------------------------------------------------------

const PLAYER_ID = 1;
const ENEMY_ID = 2;

class ScriptDriver implements HostDriver {
  private enemyPhase = 0;
  readonly spawnOrigin: [number, number, number] = [
    DEVROOM_CAMERA.origin[0]!,
    DEVROOM_CAMERA.origin[1]!,
    DEVROOM_CAMERA.origin[2]! - 22, // Host adds the 22u eye height (calcViewOrigin)
  ];
  spawn(): { origin: [number, number, number]; angles?: [number, number, number] } {
    return {
      origin: [...this.spawnOrigin],
      angles: [DEVROOM_CAMERA.angles[0]!, DEVROOM_CAMERA.angles[1]!, DEVROOM_CAMERA.angles[2]!],
    };
  }
  step(_cmd: UserCmdT, dt: number): void {
    this.enemyPhase += dt;
  }
  snapshot(serverTime: number): Snapshot {
    const ex = 60 + Math.sin(this.enemyPhase * 2) * 40;
    return {
      serverTime,
      entities: [
        { id: PLAYER_ID, origin: [...this.spawnOrigin], velocity: [0, 0, 0] },
        { id: ENEMY_ID, origin: [ex, -40, 20], velocity: [0, 0, 0] },
      ],
    };
  }
}

interface Loop {
  host: Host;
  driver: ScriptDriver;
}

function makeLoop(width: number, height: number): Loop {
  resetCVars();
  const driver = new ScriptDriver();
  const refresh = new SoftwareRenderer();
  const host = new Host({
    refresh,
    width,
    height,
    indexed: true,
    world: { name: 'maps/devroom', data: createDevroom() },
    driver,
  });
  refresh.setPalette(devPalette());
  // Live positional channel so the audio-preservation pin is real.
  host.mixer.startSound({
    origin: [0, 0, 0],
    fixedOrigin: true,
    entnum: PLAYER_ID,
    attenuation: 1,
    masterVol: 1,
    loop: false,
    name: 'test/pin.wav',
  });
  return { host, driver };
}

/** Advance the running loop by n frames of stepMs wall-clock ms. */
function frameN(host: Host, n: number, stepMs: number, clock: { t: number }): void {
  for (let i = 0; i < n; i++) {
    clock.t += stepMs;
    host.frame(clock.t);
  }
}

/** Everything a resize must preserve (values + object identities). */
function simFingerprint(host: Host): Record<string, unknown> {
  const snap = host.captureSimState();
  return {
    serverTime: snap.serverTime,
    origin: [...snap.playerOrigin],
    velocity: [...snap.playerVelocity],
    angles: [...snap.inputAngles],
    listener: [...snap.listenerOrigin],
    masterVol: snap.masterVol,
    channelCount: snap.channelCount,
    prev: JSON.stringify(snap.prevSnapshot),
    next: JSON.stringify(snap.nextSnapshot),
  };
}

function expectSimPreserved(before: Record<string, unknown>, host: Host): void {
  const after = simFingerprint(host);
  expect(after.serverTime, 'serverTime survives resize').toBe(before.serverTime);
  expect(after.origin, 'player origin survives resize').toEqual(before.origin);
  expect(after.velocity, 'player velocity survives resize').toEqual(before.velocity);
  expect(after.angles, 'input angles survive resize').toEqual(before.angles);
  expect(after.listener, 'audio listener survives resize').toEqual(before.listener);
  expect(after.masterVol, 'master volume survives resize').toBe(before.masterVol);
  expect(after.channelCount, 'audio channels survive resize').toBe(before.channelCount);
  expect(after.prev, 'enemy snapshot (prev) survives resize').toBe(before.prev);
  expect(after.next, 'enemy snapshot (next) survives resize').toBe(before.next);
}

function hashU32(a: Uint32Array): string {
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) {
    h ^= a[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// DOM-less 2D canvas stub (shape mirrors the gpu-lifecycle.test.ts /
// release-7-resize.test.ts stub-DOM patterns in apps/web).
// ---------------------------------------------------------------------------

interface StubImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

interface StubCtx2D {
  created: StubImageData[];
  presented: StubImageData[];
  createImageData(w: number, h: number): StubImageData;
  putImageData(img: StubImageData, x: number, y: number): void;
}

interface StubCanvas {
  width: number;
  height: number;
  ctx: StubCtx2D;
  getContext(kind: string): StubCtx2D | null;
}

function makeStubCanvas(): StubCanvas {
  const ctx: StubCtx2D = {
    created: [],
    presented: [],
    createImageData(w: number, h: number): StubImageData {
      const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      ctx.created.push(img);
      return img;
    },
    putImageData(img: StubImageData): void {
      ctx.presented.push(img);
    },
  };
  return {
    width: 0,
    height: 0,
    ctx,
    getContext(kind: string): StubCtx2D | null {
      return kind === '2d' ? ctx : null;
    },
  };
}

// ---------------------------------------------------------------------------
// blitCopyRGBA — replicated BY VALUE from apps/web/src/dom.ts (~L248-262).
// Never throws on length mismatch: fills the min prefix (the skew vector).
// ---------------------------------------------------------------------------

function blitCopyRGBA(dst: Uint8Array | Uint8ClampedArray, src: Uint32Array): void {
  const n = Math.min(src.length, Math.floor(dst.length / 4));
  if (n <= 0) return;
  const u32 = new Uint32Array([0x0a0b0c0d]);
  const littleEndian = new Uint8Array(u32.buffer)[0] === 0x0d;
  if (littleEndian && dst.length === src.length * 4 && dst.byteOffset % 4 === 0) {
    new Uint32Array(dst.buffer, dst.byteOffset, src.length).set(src);
    return;
  }
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const px = src[i]!;
    dst[j] = px & 255;
    dst[j + 1] = (px >> 8) & 255;
    dst[j + 2] = (px >> 16) & 255;
    dst[j + 3] = px >>> 24;
  }
}

interface BlitCache {
  img: StubImageData;
  w: number;
  h: number;
}

/**
 * FIXED production blit: wrapper dims resynced from the LIVE framebuffer
 * every frame (what dom.ts finishFrame must do post-fix). Mirrors
 * blitToCanvas (dom.ts ~L179-215) with the wrapper sourced per-frame.
 */
function presentFixed(canvas: StubCanvas, fb: Framebuffer, caches: Map<StubCanvas, BlitCache>): void {
  if (canvas.width !== fb.width || canvas.height !== fb.height) {
    canvas.width = fb.width;
    canvas.height = fb.height;
  }
  let cached = caches.get(canvas);
  if (!cached || cached.w !== fb.width || cached.h !== fb.height) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    cached = { img: ctx.createImageData(fb.width, fb.height), w: fb.width, h: fb.height };
    caches.set(canvas, cached);
  }
  blitCopyRGBA(cached.img.data, fb.color);
  canvas.ctx.putImageData(cached.img, 0, 0);
}

/**
 * STALE production blit — replicates the PRE-FIX dom.ts startPlayLoop
 * (~L1517-1541): `blitFb` captures width/height (+index/depth) ONCE at
 * construction; `finishFrame` only refreshes `.color`. The canvas backing
 * and cached ImageData therefore pin to the boot size forever.
 */
function makeStalePresenter(canvas: StubCanvas, bootFb: Framebuffer): (live: Framebuffer) => void {
  const blitFb: { width: number; height: number; color: Uint32Array } = {
    width: bootFb.width,
    height: bootFb.height,
    color: bootFb.color,
  };
  const caches = new Map<StubCanvas, BlitCache>();
  return (live: Framebuffer): void => {
    blitFb.color = live.color; // pre-fix finishFrame: ONLY the color is refreshed
    if (canvas.width !== blitFb.width || canvas.height !== blitFb.height) {
      canvas.width = blitFb.width;
      canvas.height = blitFb.height;
    }
    let cached = caches.get(canvas);
    if (!cached || cached.w !== blitFb.width || cached.h !== blitFb.height) {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      cached = { img: ctx.createImageData(blitFb.width, blitFb.height), w: blitFb.width, h: blitFb.height };
      caches.set(canvas, cached);
    }
    blitCopyRGBA(cached.img.data, blitFb.color);
    canvas.ctx.putImageData(cached.img, 0, 0);
  };
}

// ---------------------------------------------------------------------------
// fitScaleForStage — replicated BY VALUE from apps/web/src/dom.ts (~L1322).
// Pure CSS-fit math: largest integer box with the fb aspect inside avail.
// ---------------------------------------------------------------------------

function fitScaleForStageMirror(
  fbW: number,
  fbH: number,
  availW: number,
  availH: number,
): { cssW: number; cssH: number; scale: number } {
  const fw = Number.isFinite(fbW) && fbW > 0 ? fbW : 1;
  const fh = Number.isFinite(fbH) && fbH > 0 ? fbH : 1;
  const aw = Number.isFinite(availW) && availW > 0 ? availW : fw * 2;
  const ah = Number.isFinite(availH) && availH > 0 ? availH : fh * 2;
  const raw = Math.min(aw / fw, ah / fh);
  const s = Number.isFinite(raw) && raw > 0 ? raw : 1;
  return { cssW: Math.max(1, Math.floor(fw * s)), cssH: Math.max(1, Math.floor(fh * s)), scale: s };
}

// ---------------------------------------------------------------------------
// Headless captures (PPM, regenerable test-output/, not committed): the screenshot leg where
// no browser exists. Pixel assertions below are the actual gate.
// ---------------------------------------------------------------------------

const testDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(testDir, 'test-output');

function writePpm(tag: string, w: number, h: number, color: Uint32Array): void {
  try {
    mkdirSync(outDir, { recursive: true });
    const head = `P6\n${w} ${h}\n255\n`;
    const out = new Uint8Array(head.length + w * h * 3);
    for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i) & 255;
    for (let i = 0; i < w * h; i++) {
      const px = color[i]!;
      out[head.length + i * 3] = px & 255;
      out[head.length + i * 3 + 1] = (px >> 8) & 255;
      out[head.length + i * 3 + 2] = (px >> 16) & 255;
    }
    writeFileSync(join(outDir, `release-7-loop-${tag}-${w}x${h}.ppm`), out);
  } catch {
    /* capture is record-only; assertions below are the gate */
  }
}

function repoRoot(): string {
  return join(testDir, '..', '..', '..');
}

/** Read a (ASCII) source file as text: ambient fs has no encoding overload. */
function readSourceText(path: string): string {
  const bytes = readFileSync(path);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

describe('RELEASE-7 running-loop resize (testkit lane, asset-free)', () => {
  it('startup loading surface is synchronously sized at every offered size', () => {
    for (const [w, h] of SIZES) {
      const { host } = makeLoop(w, h);
      // No frames yet: the surface is reserved synchronously at construction
      // (Host owns the framebuffer; apps/web applies the reserved cvar size
      // before any async asset load — no small black box, no layout jump).
      expect(host.fb.width, `startup width ${w}x${h}`).toBe(w);
      expect(host.fb.height, `startup height ${w}x${h}`).toBe(h);
      expect(host.fb.color.length, `startup color ${w}x${h}`).toBe(w * h);
      expect(host.fb.index!.length, `startup index ${w}x${h}`).toBe(w * h);
      expect(host.fb.depth.length, `startup depth ${w}x${h}`).toBe(w * h);
      host.dispose();
    }
    console.log('[release-7-loop] startup surfaces ok at 320x240, 640x480, 800x600, 1024x768');
  });

  it('running loop survives resize cycles both directions with sim intact', () => {
    const { host } = makeLoop(320, 240);
    const clock = { t: 0 };
    frameN(host, 3, 100, clock);
    const worldIdentity = host.world;
    const driverIdentity = host.driver;
    const refreshIdentity = host.refresh;
    const before = simFingerprint(host);

    // Rapid both-direction cycle across ALL offered sizes, some back-to-back
    // (no frame between) to model DPR/zoom/menu thrash.
    const seq: ReadonlyArray<readonly [number, number]> = [
      [640, 480],
      [800, 600],
      [1024, 768],
      [1024, 768], // same-size: must no-op
      [320, 240],
      [1024, 768], // rapid up without settling
      [320, 240], // rapid down without settling
      [800, 600],
      [640, 480],
    ];
    let resizes = host.resizeCount;
    for (const [w, h] of seq) {
      const same = host.fb.width === w && host.fb.height === h;
      expect(() => host.resize(w, h), `resize ${w}x${h} must not throw`).not.toThrow();
      if (!same) {
        resizes += 1;
        expect(host.resizeCount, `resizeCount tracks ${w}x${h}`).toBe(resizes);
      }
      expect(host.fb.width, `fb width ${w}x${h}`).toBe(w);
      expect(host.fb.height, `fb height ${w}x${h}`).toBe(h);
      expect(host.fb.color.length, `color stride ${w}x${h}`).toBe(w * h);
      expect(host.fb.index!.length, `index stride ${w}x${h}`).toBe(w * h);
      expect(host.fb.depth.length, `depth stride ${w}x${h}`).toBe(w * h);
      expectSimPreserved(before, host);
      expect(host.world, 'map identity survives resize').toBe(worldIdentity);
      expect(host.driver, 'driver identity survives resize').toBe(driverIdentity);
      expect(host.refresh, 'refresh identity survives resize').toBe(refreshIdentity);
    }

    // Fresh rendered pixels at the final size: stamp a sentinel AFTER a
    // frame, resize, frame, and require the sentinel to be repainted away
    // (overlap copy alone would keep it) with live pixels submitted.
    host.resize(320, 240);
    frameN(host, 2, 100, clock);
    const stats = host.frame(clock.t + 100);
    clock.t += 100;
    expect(stats.pixels, 'resized frame submits pixels').toBeGreaterThan(0);
    expect(host.fb.color.length).toBe(320 * 240);
    expect(new Set(host.fb.color).size, 'resized frame is not a flat fill').toBeGreaterThan(1);
    // Three ticks ran since `before`: the sim is LIVE (snapshots track ticks,
    // not resizes). Pin the exact advance + continued preservation + liveness.
    const fin = simFingerprint(host);
    expect(fin.serverTime as number, 'ticks advance across frames, never across resizes').toBeCloseTo(
      (before.serverTime as number) + 0.3, 9,
    );
    expect(fin.origin, 'player origin preserved').toEqual(before.origin);
    expect(fin.channelCount, 'audio channels preserved').toBe(before.channelCount);
    expect(fin.masterVol, 'master volume preserved').toBe(before.masterVol);
    expect(fin.prev, 'live sim advanced past the resize').not.toBe(before.prev);
    host.dispose();
    console.log(`[release-7-loop] ${seq.length}-leg cycle ok, resizeCount=${host.resizeCount}`);
  });

  it('fresh pixels repaint the new plane (sentinel is painted over, not copied)', () => {
    const { host } = makeLoop(320, 240);
    const clock = { t: 0 };
    frameN(host, 3, 100, clock);
    host.resize(640, 480);
    // Marker AFTER resize, BEFORE the next frame: proves the post-resize
    // frame really paints (a stale/uncleared plane would keep it).
    host.fb.color[5 * 640 + 5] = 0xdeadbeef;
    host.fb.color[479 * 640 + 639] = 0x12345678;
    const stats = host.frame(clock.t + 100);
    clock.t += 100;
    expect(stats.pixels).toBeGreaterThan(0);
    expect(host.fb.color[5 * 640 + 5], 'fresh frame repaints overlap region').not.toBe(0xdeadbeef);
    expect(host.fb.color[479 * 640 + 639], 'fresh frame paints new region').not.toBe(0x12345678);
    host.dispose();
  });

  it('row stride, canvas bounds and aspect track the live framebuffer (DPR-independent)', () => {
    const { host } = makeLoop(320, 240);
    const clock = { t: 0 };
    frameN(host, 3, 100, clock);
    const canvas = makeStubCanvas();
    const caches = new Map<StubCanvas, BlitCache>();
    for (const dpr of [1, 2]) {
      for (const [w, h] of SIZES) {
        host.resize(w, h);
        const stats = host.frame(clock.t + 100);
        clock.t += 100;
        expect(stats.pixels, `pixels at ${w}x${h}`).toBeGreaterThan(0);
        expect(() => presentFixed(canvas, host.fb, caches), `present ${w}x${h} must not throw`).not.toThrow();
        // Matching canvas content bounds: backing tracks the LIVE fb, at any DPR.
        expect(canvas.width, `canvas backing w @${w}x${h} dpr=${dpr}`).toBe(w);
        expect(canvas.height, `canvas backing h @${w}x${h} dpr=${dpr}`).toBe(h);
        const last = canvas.ctx.presented[canvas.ctx.presented.length - 1]!;
        expect(last.width, `ImageData w @${w}x${h}`).toBe(w);
        expect(last.height, `ImageData h @${w}x${h}`).toBe(h);
        expect(last.data.length).toBe(w * h * 4);
        // Row stride: byte row y starts at y*w*4 (old-stride skew would fail here).
        const samples: Array<readonly [number, number]> = [
          [0, 0],
          [w - 1, 0],
          [0, h - 1],
          [w - 1, h - 1],
          [Math.floor(w / 2), Math.floor(h / 2)],
          [Math.min(w - 1, 7), Math.min(h - 1, 13)],
        ];
        for (const [x, y] of samples) {
          const px = host.fb.color[y * w + x]!;
          const o = (y * w + x) * 4;
          expect(last.data[o], `R(${x},${y}) @${w}x${h}`).toBe(px & 255);
          expect(last.data[o + 1], `G(${x},${y}) @${w}x${h}`).toBe((px >> 8) & 255);
          expect(last.data[o + 2], `B(${x},${y}) @${w}x${h}`).toBe((px >> 16) & 255);
          expect(last.data[o + 3], `A(${x},${y}) @${w}x${h}`).toBe(px >>> 24);
        }
        // Undistorted aspect: CSS fit box keeps the fb aspect (DPR scales the
        // available stage, never the backing — backing pinned above).
        const fit = fitScaleForStageMirror(w, h, 1280 * dpr, 720 * dpr);
        expect(Math.abs(fit.cssW / fit.cssH - w / h), `css aspect @${w}x${h} dpr=${dpr}`).toBeLessThan(2 / Math.min(fit.cssW, fit.cssH) + 1e-9);
        writePpm(`fixed-dpr${dpr}`, w, h, host.fb.color);
      }
    }
    host.dispose();
    console.log(`[release-7-loop] stride/bounds/aspect ok at all sizes, dpr=1,2 (ppm in test-output/)`);
  });

  it('switch/restore round-trip is pixel-identical (no distortion)', () => {
    const { host } = makeLoop(320, 240);
    const clock = { t: 0 };
    frameN(host, 5, 100, clock);
    const refColor = hashU32(host.fb.color);
    const refIndex = hashU32(new Uint32Array(host.fb.index!));
    const before = simFingerprint(host);
    // renderCurrentView (no tick): freezes time so the comparison is exact.
    host.renderCurrentView();
    const still = hashU32(host.fb.color);
    // Switch away and restore with NO sim advance between.
    host.resize(1024, 768);
    expect(host.fb.color.length).toBe(1024 * 768);
    host.resize(320, 240);
    host.renderCurrentView();
    expect(hashU32(host.fb.color), 'restore repaints identical pixels').toBe(still);
    expect(hashU32(host.fb.color), 'restore matches pre-switch frame').toBe(refColor);
    expect(hashU32(new Uint32Array(host.fb.index!)), 'index plane restores too').toBe(refIndex);
    expectSimPreserved(before, host);
    // And the sim is still live afterwards (enemy moves, time advances).
    const enemyBefore = JSON.parse(before.next as string).entities.find((e: { id: number }) => e.id === ENEMY_ID);
    frameN(host, 4, 100, clock);
    const enemyAfter = host.captureSimState().nextSnapshot!.entities.find((e) => e.id === ENEMY_ID)!;
    expect(enemyAfter.origin, 'enemy keeps simulating after restore').not.toEqual(enemyBefore.origin);
    host.dispose();
  });

  it('STALE wrapper + min-prefix copy skews without throwing (defect mechanism)', () => {
    // Replicates the PRE-FIX dom.ts pipeline by value: wrapper dims pinned
    // at boot (320x240), only .color refreshed after resize. This leg PASSES
    // by demonstrating the corruption the source pin (below) forbids.
    const { host } = makeLoop(320, 240);
    const clock = { t: 0 };
    frameN(host, 3, 100, clock);
    const canvas = makeStubCanvas();
    const presentStale = makeStalePresenter(canvas, host.fb);
    host.resize(640, 480);
    host.frame(clock.t + 100);
    clock.t += 100;
    expect(() => presentStale(host.fb), 'stale present must not throw (silent skew, not RangeError)').not.toThrow();
    // The canvas is stuck at the boot size while the sim renders 640x480.
    expect(canvas.width, 'stale canvas keeps boot width').toBe(320);
    expect(canvas.height, 'stale canvas keeps boot height').toBe(240);
    const shown = canvas.ctx.presented[canvas.ctx.presented.length - 1]!;
    expect(shown.width * shown.height).toBe(320 * 240);
    // Ground truth at the same boot-size crop: rows past the first already
    // diverge because the source stride is 640 while the blit assumed 320
    // (min-prefix copy fills 320*240 u32 from a 640*480 plane row-skewed).
    const ground = host.fb.color;
    let mismatches = 0;
    const checked: Array<readonly [number, number]> = [
      [0, 1],
      [10, 5],
      [0, 100],
      [319, 200],
    ];
    for (const [x, y] of checked) {
      const want = ground[y * 640 + x]!;
      const o = (y * 320 + x) * 4;
      const got = (shown.data[o]! | (shown.data[o + 1]! << 8) | (shown.data[o + 2]! << 16)) >>> 0;
      if ((got & 0xffffff) !== (want & 0xffffff)) mismatches++;
    }
    expect(mismatches, 'stale stride visibly skews sampled rows (defect proof)').toBeGreaterThan(0);
    // Unit face of the same defect: min-prefix copy never throws on shrink.
    const small = new Uint8ClampedArray(4 * 4 * 4);
    expect(() => blitCopyRGBA(small, new Uint32Array(640 * 480).fill(0x11223344))).not.toThrow();
    host.dispose();
    console.log(`[release-7-loop] stale-wrapper skew demonstrated (${mismatches}/${checked.length} rows diverge, no throw)`);
  });

  it('production blit path resyncs wrapper dims every frame (apps/web source pin)', () => {
    // Reads the REAL apps/web/src/dom.ts (never imported). FAILS PRE-FIX:
    // startPlayLoop builds blitFb once and finishFrame only sets .color.
    // Passes for any coherent fix: per-frame width/height resync, a rebuilt
    // wrapper, or a live-fb spread.
    const src = readSourceText(join(repoRoot(), 'apps', 'web', 'src', 'dom.ts'));
    // Strip comments: the pre-fix file only mentions `{...host.fb}` inside a
    // comment ("avoids the old per-frame spread garbage") — code must do it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const resyncsDims = /blitFb\.width\s*=/.test(code) && /blitFb\.height\s*=/.test(code);
    const resyncsPlanes = /blitFb\.index\s*=/.test(code) && /blitFb\.depth\s*=/.test(code);
    const rebuilds = (code.match(/blitFb\s*[:=]\s*\{/g) ?? []).length > 1;
    const spreadsLive = /\{\s*\.\.\.host\.fb/.test(code);
    expect(
      resyncsDims || rebuilds || spreadsLive,
      'DEFECT PROOF (RELEASE-7): dom.ts finishFrame keeps the boot-time blitFb ' +
        'width/height and only refreshes .color — after Host.resize the blit copies ' +
        'with the old row stride. Fix: resync blitFb width/height (and index/depth) ' +
        'from the live framebuffer every frame.',
    ).toBe(true);
    expect(
      resyncsPlanes || rebuilds || spreadsLive,
      'DEFECT PROOF (RELEASE-7): dom.ts finishFrame keeps stale blitFb index/depth ' +
        'references across Host.resize. Fix: resync them with the live framebuffer.',
    ).toBe(true);
  });

  it('resizePlay honors GPU resize failure (apps/web source pin)', () => {
    // Reads the REAL apps/web/src/play.ts (never imported). FAILS PRE-FIX:
    // `if (boot.gpu) resizeGpuBackend(boot, width, height);` ignores the
    // boolean after mutating host state. Passes when the outcome is honored
    // (checked, propagated, or coherently reverted).
    const src = readSourceText(join(repoRoot(), 'apps', 'web', 'src', 'play.ts'));
    const start = src.indexOf('export function resizePlay');
    const end = src.indexOf('export function reservedDisplaySize');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, end > start ? end : undefined);
    expect(body, 'resizePlay must still coordinate the GPU backend').toContain('resizeGpuBackend');
    const honored =
      /=\s*resizeGpuBackend\(/.test(body) ||
      /if\s*\(\s*!?\s*resizeGpuBackend\(/.test(body) ||
      /resizeGpuBackend\([^)]*\)[\s\S]{0,120}return false/.test(body);
    expect(
      honored,
      'DEFECT PROOF (RELEASE-7): resizePlay ignores resizeGpuBackend\'s boolean ' +
        'failure result after mutating host state (reports success with mismatched ' +
        'state). Fix: honor the result — propagate false / revert coherently.',
    ).toBe(true);
  });
});

describe.runIf(!!process.env.Q2_PAK)('RELEASE-7 running-loop resize (real base1, Q2_PAK)', () => {
  it('base1 loop preserves sim and repaints across resize cycles', async () => {
    const { loadBenchWorld, benchSpawnOrigin, benchSpawnYaw } = await import('./bench-workloads.js');
    const raw = readFileSync(process.env.Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const bw = loadBenchWorld(buf);
    resetCVars();
    const refresh = new SoftwareRenderer();
    const host = new Host({
      refresh,
      width: 320,
      height: 240,
      indexed: true,
      world: { name: 'base1', data: bw.world },
    });
    refresh.setPalette(bw.palette);
    const spawn = benchSpawnOrigin();
    host.playerOrigin = [...spawn];
    host.input.angles = [0, benchSpawnYaw(), 0];
    host.mixer.startSound({
      origin: [0, 0, 0],
      fixedOrigin: true,
      entnum: 1,
      attenuation: 1,
      masterVol: 1,
      loop: false,
      name: 'test/pin.wav',
    });
    const clock = { t: 0 };
    frameN(host, 3, 100, clock);
    expect(host.frame(clock.t).pixels, 'base1 paints at 320x240').toBeGreaterThan(0);
    const before = simFingerprint(host);
    const worldIdentity = host.world;
    for (const [w, h] of [
      [640, 480],
      [1024, 768],
      [320, 240],
    ] as ReadonlyArray<readonly [number, number]>) {
      const legBefore = simFingerprint(host);
      host.resize(w, h);
      expect(host.fb.color.length).toBe(w * h);
      // The resize itself preserves the sim (no frames between).
      expectSimPreserved(legBefore, host);
      expect(host.world).toBe(worldIdentity);
      const stats = host.frame(clock.t + 100);
      clock.t += 100;
      expect(stats.pixels, `base1 paints at ${w}x${h}`).toBeGreaterThan(0);
    }
    // Across the three leg frames the sim ticked exactly 3x and stayed intact.
    const fin = simFingerprint(host);
    expect(fin.serverTime as number).toBeCloseTo((before.serverTime as number) + 0.3, 9);
    host.dispose();
    console.log('[release-7-loop] base1 320->640->1024->320 sim intact, pixels live');
  });
});
