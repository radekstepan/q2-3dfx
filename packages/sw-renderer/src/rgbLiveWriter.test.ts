// PERF-NEXT-2 (Lane A): recovery is safe against genuinely live writers.
//
// The pre-existing recovery tests use scripted workers that have already
// stopped (DONE never arrives, nothing writes). These tests close the real
// gap: a REAL Node worker thread keeps issuing SAB plane writes through the
// timeout/quarantine/recovery window (it ignores termination until its
// acknowledged stop), while the pool must still converge to the serial
// planes. What the tests prove:
//  - sync timeout (flushRGBFrame): quarantine isolates the planes onto a
//    replacement SAB (fence epoch bumps, pool views move) BEFORE any replay
//    touches them; recovery then converges to the uninterrupted serial
//    reference across RGB565, depth and coverage.
//  - async timeout (flushRGBFrameAsync): same isolation, plus the bounded
//    completed-termination join resolves (doomed workers provably gone).
//  - the live writer's writes (garbage 0xF800 + cover + depth on the
//    ABANDONED buffer) never leak into the recovered planes: snapshots are
//    stable across a sleep with the writer still running, and match serial.
//  - renderer level: full-RGBA resolve + index match serial with a live
//    writer racing the frame, the renderer re-adopts the isolated planes,
//    the acknowledged stop handshake completes (no hang), and the NEXT frame
//    on the quarantined pool (inline fallback) is still exact.
//  - scene dimensions: opaque world + translucent alpha + ADDITIVE spans
//    (destination-dependent like alpha: double-apply control must differ),
//    capacity-refusal probe before dispatch, main-band completion path.
//  - successful-path overhead is measured separately (see the lane report;
//    the fence adds no work to the success path by construction).
import { afterEach, describe, expect, it } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import type { Entity } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import { SoftwareRenderer, setRGBWorldEnabled, SW_RGB_SKIP_CLASSIC_CVAR } from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import { createGunMesh } from './alias.js';
import { BandWorkerPool } from './bandPool.js';
import {
  processRGBFrameJob,
  R_FLAG_ADDITIVE, R_FLAG_BLEND_ALPHA, R_FLAG_DEPTHWRITE, R_FLAG_LIGHT, R_FLAG_OPAQUE, R_FLAG_REPEAT,
  RGB_MAX_CHAINS, SW_ACCUM_CVAR, SW_WORKERS_CVAR,
} from './bands.js';
import {
  SPAN_ADD, SPAN_OPAQUE, SPAN_TRANS66, createSpan,
  type RGBMipLevel, type Span,
} from './spans.js';
import { stubPool, type StubPool } from './testStubPool.js';
import type { MiniWorld } from './index.js';

afterEach(() => {
  setRGBWorldEnabled(false);
  resetCVars();
});

function testPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = (i * 5) & 255;
    pal[i * 3 + 1] = (i * 3 + 40) & 255;
    pal[i * 3 + 2] = (i * 2 + 80) & 255;
  }
  return pal;
}

function fnvU8(a: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) {
    h ^= a[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function fnvRGBA(color: Uint32Array): string {
  let h = 2166136261;
  for (let i = 0; i < color.length; i++) {
    const px = color[i]!;
    h ^= px & 0xff; h = Math.imul(h, 16777619);
    h ^= (px >>> 8) & 0xff; h = Math.imul(h, 16777619);
    h ^= (px >>> 16) & 0xff; h = Math.imul(h, 16777619);
    h ^= (px >>> 24) & 0xff; h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function makeSpan(y: number, W: number, kind: number, iz: number): Span {
  const s = createSpan();
  s.kind = kind;
  s.y = y;
  s.x0 = 0; s.x1 = W;
  s.iz = iz; s.diz = 0;
  s.uz = 8; s.duz = 0;
  s.vz = 8; s.dvz = 0;
  s.light = 200; s.dlight = 0;
  s.lu = 0; s.lv = 0; s.dlu = 0;
  s.turb = 0; s.ord = 0;
  s.dudy = 0; s.dvdy = 0;
  return s;
}

function tinyChain(palIndex = 7): RGBMipLevel[] {
  const pal = testPalette();
  const r = pal[palIndex * 3]!, g = pal[palIndex * 3 + 1]!, b = pal[palIndex * 3 + 2]!;
  const data = new Uint8Array([r, g, b, r, g, b, r, g, b, r, g, b]);
  const mask = new Uint8Array([255, 255, 255, 255]);
  return [{ data, width: 2, height: 2, mask }];
}

const LUX = new Uint8Array([200, 200, 200]);
const WORLD_FLAGS = R_FLAG_REPEAT | R_FLAG_DEPTHWRITE | R_FLAG_LIGHT | R_FLAG_OPAQUE;
const FG_FLAGS = R_FLAG_REPEAT | R_FLAG_LIGHT | R_FLAG_BLEND_ALPHA;
const ADD_FLAGS = R_FLAG_REPEAT | R_FLAG_DEPTHWRITE | R_FLAG_LIGHT | R_FLAG_ADDITIVE;

/** Stage opaque world + translucent FG + additive FG (all in front blends). */
function stageWorldPlusFGAdd(pool: BandWorkerPool, W: number, H: number): void {
  const chain = tinyChain(7);
  const fgChain = tinyChain(200);
  const addChain = tinyChain(45);
  const world: Span[] = [];
  for (let y = 0; y < H; y++) world.push(makeSpan(y, W, SPAN_OPAQUE, 0.2));
  expect(pool.stageRGB({ spans: world, count: world.length }, 0, world.length,
    chain, LUX, 1, 1, WORLD_FLAGS, 0, 0, 0)).toBe(true);
  const fgFront: Span[] = [];
  for (let y = Math.floor(H / 4); y < Math.floor((3 * H) / 4); y++) fgFront.push(makeSpan(y, W, SPAN_TRANS66, 0.24));
  expect(pool.stageRGB({ spans: fgFront, count: fgFront.length }, 0, fgFront.length,
    fgChain, LUX, 1, 1, FG_FLAGS, 0, 0, 0)).toBe(true);
  const add: Span[] = [];
  for (let y = 0; y < Math.floor(H / 4); y++) add.push(makeSpan(y, W, SPAN_ADD, 0.26));
  expect(pool.stageRGB({ spans: add, count: add.length }, 0, add.length,
    addChain, LUX, 1, 1, ADD_FLAGS, 0, 0, 0)).toBe(true);
}

function snapPool(pool: BandWorkerPool): { q: string; cover: string; depth: string } {
  const v = (pool as unknown as { rgbViews: { rgb565: Uint16Array; cover: Uint8Array; rgbDepth: Uint16Array } }).rgbViews;
  return {
    q: fnvU8(new Uint8Array(v.rgb565.buffer, v.rgb565.byteOffset, v.rgb565.byteLength)),
    cover: fnvU8(v.cover),
    depth: fnvU8(new Uint8Array(v.rgbDepth.buffer, v.rgbDepth.byteOffset, v.rgbDepth.byteLength)),
  };
}

function seedForTest(pool: BandWorkerPool, v: number): void {
  const w = (pool as unknown as { rgbViews: { rgb565: Uint16Array; cover: Uint8Array } }).rgbViews;
  for (let i = 0; i < w.rgb565.length; i++) {
    if (w.cover[i] === 0) w.rgb565[i] = v;
  }
}

function prepKick(pool: BandWorkerPool): void {
  const v = (pool as unknown as { rgbViews: { kick: Float64Array; rgbDepth: Uint16Array } }).rgbViews;
  v.kick[0] = 4; v.kick[1] = 32768; v.kick[2] = 0;
  v.rgbDepth.fill(0xffff);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- live writer: a REAL worker thread hammering shared planes ----------
//
// Evaluated as CommonJS inside the worker (require is available to eval
// workers). It scribbles garbage over the rgb565/cover/rgbDepth planes of
// the buffer it was handed and only stops on the acknowledged stop flag —
// it ignores terminate() the way a worker stuck mid-raster does until the
// OS thread actually dies. Liveness is observable from the main thread
// (garbage appears); the stop is provable (ack message / exit).
const ROGUE_SCRIPT = [
  "const { parentPort, workerData } = require('node:worker_threads');",
  "const sab = workerData.sab;",
  "const n = workerData.n;",
  "const q = new Uint16Array(sab, workerData.qOff, n);",
  "const cv = new Uint8Array(sab, workerData.cOff, n);",
  "const dp = new Uint16Array(sab, workerData.dOff, n);",
  "const stop = new Int32Array(workerData.stopBuf);",
  "let i = 0;",
  "function burst() {",
  "  for (let k = 0; k < 4096; k++) {",
  "    const o = (i + k) % n;",
  "    q[o] = 0xf800; cv[o] = 1; dp[o] = 0;",
  "  }",
  "  i = (i + 4096) % n;",
  "  if (Atomics.load(stop, 0) !== 0) {",
  "    try { parentPort.postMessage({ ack: true }); } catch (e) {}",
  "    process.exit(0);",
  "    return;",
  "  }",
  "  setImmediate(burst);",
  "}",
  "burst();",
].join('\n');

interface TestWorker {
  on(ev: string, cb: (arg: unknown) => void): void;
  terminate(): Promise<unknown>;
}

interface TestWorkerCtor {
  new (script: string, opts?: { eval?: boolean; workerData?: unknown }): TestWorker;
}

/** Node worker_threads via the dynamic builtin (no static @types/node). */
function loadWorkerCtor(): TestWorkerCtor | null {
  try {
    const g = globalThis as { process?: { getBuiltinModule?(id: string): unknown } };
    const p = g.process;
    if (!p || typeof p.getBuiltinModule !== 'function') return null;
    const wt = p.getBuiltinModule('node:worker_threads') as { Worker?: TestWorkerCtor } | null;
    if (!wt || typeof wt.Worker !== 'function') return null;
    return wt.Worker;
  } catch {
    return null;
  }
}

interface LiveWriter {
  worker: TestWorker;
  stop: Int32Array;
  stopped: Promise<'ack' | 'exit' | 'timeout'>;
  stopNow(): Promise<'ack' | 'exit' | 'timeout'>;
}

function spawnLiveWriter(
  buf: SharedArrayBuffer, qOff: number, cOff: number, dOff: number, n: number,
): LiveWriter | null {
  const Ctor = loadWorkerCtor();
  if (!Ctor) return null;
  const stopBuf = new SharedArrayBuffer(4);
  const stop = new Int32Array(stopBuf);
  const worker = new Ctor(ROGUE_SCRIPT, {
    eval: true,
    workerData: { sab: buf, qOff, cOff, dOff, n, stopBuf },
  });
  let resolveStopped!: (v: 'ack' | 'exit' | 'timeout') => void;
  const stopped = new Promise<'ack' | 'exit' | 'timeout'>((resolve) => { resolveStopped = resolve; });
  let finished = false;
  const finish = (v: 'ack' | 'exit' | 'timeout'): void => {
    if (!finished) { finished = true; resolveStopped(v); }
  };
  worker.on('message', (msg: unknown) => {
    if (msg && typeof msg === 'object' && (msg as { ack?: unknown }).ack === true) finish('ack');
  });
  worker.on('exit', () => finish('exit'));
  worker.on('error', () => finish('exit'));
  return {
    worker, stop, stopped,
    stopNow: async (): Promise<'ack' | 'exit' | 'timeout'> => {
      try {
        Atomics.store(stop, 0, 1);
      } catch {
        /* ignore */
      }
      const timer = new Promise<'ack' | 'exit' | 'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000));
      const result = await Promise.race([stopped, timer]);
      finish(result);
      try {
        await worker.terminate();
      } catch {
        /* already gone */
      }
      return result;
    },
  };
}

/** Poll until the writer's garbage is observable (proves it is live). */
async function waitForGarbage(q: Uint16Array, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let i = 0; i < q.length; i += 97) {
      if (q[i] === 0xf800) return;
    }
    if (Date.now() >= deadline) throw new Error('live writer never wrote (not live)');
    await sleep(5);
  }
}

function oldPlaneViews(pool: BandWorkerPool): { buf: SharedArrayBuffer; q: Uint16Array; n: number } {
  const v = (pool as unknown as { rgbViews: { rgb565: Uint16Array; cover: Uint8Array; rgbDepth: Uint16Array } }).rgbViews;
  return {
    buf: v.rgb565.buffer as SharedArrayBuffer,
    q: v.rgb565,
    n: v.rgb565.length,
  };
}

function writerOffsets(pool: BandWorkerPool): { qOff: number; cOff: number; dOff: number } {
  const v = (pool as unknown as { rgbViews: { rgb565: Uint16Array; cover: Uint8Array; rgbDepth: Uint16Array } }).rgbViews;
  return { qOff: v.rgb565.byteOffset, cOff: v.cover.byteOffset, dOff: v.rgbDepth.byteOffset };
}

describe('PERF-NEXT-2: recovery against a genuinely live writer', () => {
  it('sync timeout isolates then converges: RGB565/depth/coverage match serial, no late mutation', { timeout: 60000 }, async () => {
    const W = 64, H = 64;
    // Uninterrupted serial reference (opaque + translucent + additive).
    const ref = stubPool(W, H);
    stageWorldPlusFGAdd(ref, W, H);
    prepKick(ref);
    seedForTest(ref, 0x8410);
    const full = processRGBFrameJob(
      (ref as unknown as { rgbViews: Parameters<typeof processRGBFrameJob>[0] }).rgbViews, W, H, 3, 0, H);
    expect(full.spans).toBeGreaterThan(0);
    const expected = snapPool(ref);
    // Double-apply control (no clear): additive + alpha apply twice, so it
    // MUST differ — proves the comparison sees exactly-once violations.
    processRGBFrameJob(
      (ref as unknown as { rgbViews: Parameters<typeof processRGBFrameJob>[0] }).rgbViews, W, H, 3, 0, H, 1);
    expect(snapPool(ref).q).not.toBe(expected.q);

    // Recovery case: capacity-refusal probe first (allocation failure is a
    // pre-dispatch fallback, never a replay over partial writes), then a
    // live writer hammers the planes through the timeout + recovery.
    const p = stubPool(W, H, { readyBands: 3, timeoutMs: 15 });
    stageWorldPlusFGAdd(p, W, H);
    const savedSlots = (p as unknown as Record<string, unknown>)['rgbChainSlots'];
    (p as unknown as Record<string, unknown>)['rgbChainSlots'] = RGB_MAX_CHAINS;
    const otherChain: RGBMipLevel[] = [{
      data: new Uint8Array(12).fill(9), width: 2, height: 2, mask: new Uint8Array(4).fill(255),
    }];
    expect(p.stageRGB(
      { spans: [makeSpan(0, W, SPAN_OPAQUE, 0.2)], count: 1 }, 0, 1,
      otherChain, LUX, 1, 1, WORLD_FLAGS, 0, 0, 0)).toBe(false);
    expect(p.rgbPending()).toBe(3);
    (p as unknown as Record<string, unknown>)['rgbChainSlots'] = savedSlots;
    prepKick(p);
    seedForTest(p, 0x8410);

    const old = oldPlaneViews(p);
    const off = writerOffsets(p);
    const writer = spawnLiveWriter(old.buf, off.qOff, off.cOff, off.dOff, old.n);
    if (!writer) {
      console.log('SKIP live-writer test: worker_threads unavailable');
      return;
    }
    try {
      await waitForGarbage(old.q);
      // Kick proceeds (ready preset): the calling-thread band runs, DONE
      // never arrives -> timeout -> 'partial' + quarantine + isolation.
      const r = p.flushRGBFrame(4, 32768, 0);
      expect(r).toBeNull();
      expect(p.lastRGBFailure()).toBe('partial');
      expect((p as unknown as { quarantined: boolean }).quarantined).toBe(true);
      expect((p as unknown as { workers: unknown[] }).workers.length).toBe(0);
      // Fence proof: isolation moved the pool onto a replacement buffer.
      expect(p.recoveryEpoch()).toBe(1);
      expect(p.planes.color.buffer).not.toBe(old.buf);
      // Recovery converges while the writer is STILL running on the old
      // buffer (no acknowledged stop yet — isolation is the fence).
      const tally = p.recoverInlineRGBAll(() => seedForTest(p, 0x8410), 4, 32768, 0);
      expect(tally.spans).toBe(full.spans);
      expect(snapPool(p)).toEqual(expected);
      // Stable with the writer still live: no late mutation, no
      // shared-buffer reuse race.
      const calm = snapPool(p);
      await sleep(150);
      expect(snapPool(p)).toEqual(calm);
      expect(snapPool(p)).toEqual(expected);
      // Acknowledged stop: the writer was alive through recovery and now
      // provably cannot write (no hang).
      const stopped = await writer.stopNow();
      expect(stopped === 'ack' || stopped === 'exit').toBe(true);
      await sleep(50);
      expect(snapPool(p)).toEqual(expected);
    } finally {
      try {
        await writer.stopNow();
      } catch {
        /* already stopped */
      }
    }
    // Next frame on the quarantined pool: fast clean refusal, no hang, no
    // wedge; the serial path stays exact (stale-state check).
    p.beginFrame();
    expect(p.rgbPending()).toBe(0);
    const again = p.flushRGBFrame(4, 32768, 0);
    expect(again).toBeNull();
    expect(p.lastRGBFailure()).toBe('clean');
    expect(p.stageRGB({ spans: [], count: 0 }, 0, 0, tinyChain(), null, 0, 0, WORLD_FLAGS, 0, 0, 0)).toBe(false);
  });

  it('async timeout joins completed termination, then converges + stays stable', { timeout: 60000 }, async () => {
    const W = 64, H = 64;
    const ref = stubPool(W, H);
    stageWorldPlusFGAdd(ref, W, H);
    prepKick(ref);
    seedForTest(ref, 0x8410);
    processRGBFrameJob(
      (ref as unknown as { rgbViews: Parameters<typeof processRGBFrameJob>[0] }).rgbViews, W, H, 3, 0, H);
    const expected = snapPool(ref);

    const p = stubPool(W, H, { readyBands: 3, timeoutMs: 15 });
    stageWorldPlusFGAdd(p, W, H);
    prepKick(p);
    seedForTest(p, 0x8410);
    const old = oldPlaneViews(p);
    const off = writerOffsets(p);
    const writer = spawnLiveWriter(old.buf, off.qOff, off.cOff, off.dOff, old.n);
    if (!writer) {
      console.log('SKIP live-writer test: worker_threads unavailable');
      return;
    }
    try {
      await waitForGarbage(old.q);
      const r = await p.flushRGBFrameAsync(4, 32768, 0);
      expect(r).toBeNull();
      expect(p.lastRGBFailure()).toBe('partial');
      expect(p.recoveryEpoch()).toBe(1);
      expect(p.planes.color.buffer).not.toBe(old.buf);
      // Completed-termination join resolves (bounded, never hangs): the
      // doomed scripted workers are provably gone.
      await p.quarantineWorkersAsync(2000);
      const tally = p.recoverInlineRGBAll(() => seedForTest(p, 0x8410), 4, 32768, 0);
      expect(tally.spans).toBeGreaterThan(0);
      expect(snapPool(p)).toEqual(expected);
      const calm = snapPool(p);
      await sleep(150);
      expect(snapPool(p)).toEqual(calm);
      const stopped = await writer.stopNow();
      expect(stopped === 'ack' || stopped === 'exit').toBe(true);
      expect(snapPool(p)).toEqual(expected);
    } finally {
      try {
        await writer.stopNow();
      } catch {
        /* already stopped */
      }
    }
  });
});

// --- renderer level: full-RGBA resolve + index under a live writer ------

function devView() {
  return {
    origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
    fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
  };
}

interface SerialFrame {
  color: string; index: string; planes: { q: string; cover: string; depth: string };
}

function renderSerial(W: number, H: number, world: MiniWorld, withGun: boolean): SerialFrame {
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(testPalette());
  setRGBWorldEnabled(true);
  setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
  const entities = withGun ? gunEntities(r) : [];
  r.beginFrame();
  r.renderView(devView(), { name: 'devroom', data: world }, entities);
  r.endFrame();
  const pr = r as unknown as { rgb565: Uint16Array; rgbCover: Uint8Array; rgbDepth16: Uint16Array };
  const live = r.getFramebuffer();
  return {
    color: fnvRGBA(new Uint32Array(live.color.buffer, live.color.byteOffset, live.color.byteLength / 4)),
    index: fnvU8(live.index!),
    planes: {
      q: fnvU8(new Uint8Array(pr.rgb565.buffer, pr.rgb565.byteOffset, pr.rgb565.byteLength)),
      cover: fnvU8(pr.rgbCover),
      depth: fnvU8(new Uint8Array(pr.rgbDepth16.buffer, pr.rgbDepth16.byteOffset, pr.rgbDepth16.byteLength)),
    },
  };
}

/** Devroom with the floor marked translucent (drives the deferred alpha FG path). */
function translucentDevroom(): MiniWorld {
  const base = createDevroom();
  const floor = { ...base.surfaces[0]!, translucent: 2 };
  return { ...base, surfaces: [floor, ...base.surfaces.slice(1)] };
}

function gunEntities(r: SoftwareRenderer): Entity[] {
  const gun = r.registerModel({ name: 'gun', kind: 'md2', data: createGunMesh() });
  return [{
    model: gun, origin: new Float32Array([60, -90, 20]), angles: new Float32Array([0, 35, 0]),
    frame: 0, skin: 0,
  }];
}

describe('renderer-level live-writer recovery: full RGBA + index + next frame', () => {
  it('live writer racing the frame: recovery matches serial RGBA, re-adopts planes, next frame exact', { timeout: 120000 }, async () => {
    const W = 96, H = 72;
    const world = translucentDevroom();
    // Serial reference (gun entity included for the alias tri path).
    const expected = renderSerial(W, H, world, true);

    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    setCVar(SW_WORKERS_CVAR, 4);
    setCVar(SW_ACCUM_CVAR, 1);
    if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
    const pool = stubPool(W, H, { readyBands: 3, timeoutMs: 10 });
    r.attachWorkerPool(pool);
    setRGBWorldEnabled(true);
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
    r.beginFrame();

    // The writer races everything from here: staging (disjoint regions —
    // untouched), the main-band inline run, the timeout wait, the
    // quarantine/isolation, and the recovery replay.
    const poolViews = (pool as unknown as { rgbViews: { rgb565: Uint16Array; cover: Uint8Array; rgbDepth: Uint16Array } }).rgbViews;
    const oldBuf = poolViews.rgb565.buffer as SharedArrayBuffer;
    const writer = spawnLiveWriter(
      oldBuf, poolViews.rgb565.byteOffset, poolViews.cover.byteOffset, poolViews.rgbDepth.byteOffset,
      poolViews.rgb565.length);
    if (!writer) {
      console.log('SKIP renderer live-writer test: worker_threads unavailable');
      return;
    }
    let got: SerialFrame;
    try {
      await waitForGarbage(poolViews.rgb565);
      r.renderView(devView(), { name: 'devroom', data: world }, gunEntities(r));
      r.endFrame();
      const pr = r as unknown as { rgb565: Uint16Array; rgbCover: Uint8Array; rgbDepth16: Uint16Array };
      const live = r.getFramebuffer();
      got = {
        color: fnvRGBA(new Uint32Array(live.color.buffer, live.color.byteOffset, live.color.byteLength / 4)),
        index: fnvU8(live.index!),
        planes: {
          q: fnvU8(new Uint8Array(pr.rgb565.buffer, pr.rgb565.byteOffset, pr.rgb565.byteLength)),
          cover: fnvU8(pr.rgbCover),
          depth: fnvU8(new Uint8Array(pr.rgbDepth16.buffer, pr.rgbDepth16.byteOffset, pr.rgbDepth16.byteLength)),
        },
      };
      expect(got.color).toBe(expected.color);
      expect(got.index).toBe(expected.index);
      expect(got.planes).toEqual(expected.planes);
      // Quarantine fenced (epoch moved) and the renderer re-adopted the
      // isolated planes (not the writer-scribbled buffer).
      expect(pool.recoveryEpoch()).toBe(1);
      expect(pr.rgb565.buffer).not.toBe(oldBuf);
      expect(pr.rgb565.buffer).toBe(pool.rgbPlanes.rgb565.buffer);
      // Stable with the writer still live, then the acknowledged stop.
      await sleep(150);
      const live2 = r.getFramebuffer();
      expect(fnvRGBA(new Uint32Array(live2.color.buffer, live2.color.byteOffset, live2.color.byteLength / 4))).toBe(expected.color);
      const stopped = await writer.stopNow();
      expect(stopped === 'ack' || stopped === 'exit').toBe(true);
    } finally {
      try {
        await writer.stopNow();
      } catch {
        /* already stopped */
      }
    }
    // Next frame on the quarantined pool: inline fallback, exact, no hang.
    r.beginFrame();
    r.renderView(devView(), { name: 'devroom', data: world }, gunEntities(r));
    r.endFrame();
    const fb2 = r.getFramebuffer();
    expect(fnvRGBA(new Uint32Array(fb2.color.buffer, fb2.color.byteOffset, fb2.color.byteLength / 4))).toBe(expected.color);
  });
});
