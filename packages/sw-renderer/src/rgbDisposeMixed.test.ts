// Disposal-during-RGB-kick + mixed-class partial-failure + indexed-timeout pin.
//
// Lane scope: packages/sw-renderer only. Deterministic (scripted stub pools,
// no threads) except where noted. What this file proves:
//  1. Dispose mid-flight: an async RGB kick over never-acking stub workers +
//     dispose() during the wait resolves bounded (no hang), classifies
//     'partial' + quarantines, and the inline fallback converges to the
//     uninterrupted serial reference (RGB565 + coverage + depth at pool
//     level; full RGBA + index at renderer level). The next frame on a fresh
//     pool is exact.
//  2. Mixed-class partial failure: one retained frame of opaque world spans
//     + translucent alias tris (emitAliasTris) + alpha spans + additive beam
//     spans (projectTracerBeam + emitTracerSpans) + occluded alpha; the
//     calling-thread main band applies real writes, the worker band fails,
//     and blend-suffix recovery converges with alpha applied exactly once
//     (double-apply control differs) and full-channel parity vs serial.
//  3. Indexed (non-RGB) timeout pin: flushFrame refuses fast-fail (null),
//     does NOT quarantine, retains workers, leaves the epoch alone. This
//     documents the known gap vs the RGB fence (see the NOTE on
//     BandWorkerPool.flushFrame) — behavior is pinned, not changed.
import { afterEach, describe, expect, it } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import { SoftwareRenderer, setRGBWorldEnabled, SW_RGB_SKIP_CLASSIC_CVAR } from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import { BandWorkerPool } from './bandPool.js';
import {
  processRGBFrameJob,
  R_FLAG_ADDITIVE, R_FLAG_BLEND_ALPHA, R_FLAG_DEPTHWRITE, R_FLAG_LIGHT, R_FLAG_OPAQUE, R_FLAG_REPEAT, R_FLAG_TRI,
  SW_ACCUM_CVAR, SW_WORKERS_CVAR, packFrameSpans,
  splitBands,
  type RGBAccumViews,
} from './bands.js';
import {
  SPAN_ADD, SPAN_OPAQUE, SPAN_TRANS66, buildRGBMaterial, createSpan,
  type RGBMipLevel, type Span, type SpanList,
} from './spans.js';
import { buildANorms, buildShadeDots, createGunMesh, emitAliasTris } from './alias.js';
import { setupCamera } from './camera.js';
import { emitTracerSpans, projectTracerBeam } from './tracer.js';
import { stubPool } from './testStubPool.js';
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

/** Reject when a promise does not settle bounded — proves no hang. */
function bounded<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`hang: ${label} exceeded ${ms}ms`)), ms)),
  ]);
}

function stubViewsOf(pool: BandWorkerPool): RGBAccumViews {
  return (pool as unknown as { rgbViews: RGBAccumViews }).rgbViews;
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

/** Opaque world (all rows) + translucent FG front + occluded FG back. */
function stageWorldPlusFG(pool: BandWorkerPool, W: number, H: number): void {
  const chain = tinyChain(7);
  const fgChain = tinyChain(200);
  const world: Span[] = [];
  for (let y = 0; y < H; y++) world.push(makeSpan(y, W, SPAN_OPAQUE, 0.2));
  expect(pool.stageRGB({ spans: world, count: world.length }, 0, world.length,
    chain, LUX, 1, 1, WORLD_FLAGS, 0, 0, 0)).toBe(true);
  const fgFront: Span[] = [];
  for (let y = Math.floor(H / 4); y < Math.floor((3 * H) / 4); y++) fgFront.push(makeSpan(y, W, SPAN_TRANS66, 0.24));
  expect(pool.stageRGB({ spans: fgFront, count: fgFront.length }, 0, fgFront.length,
    fgChain, LUX, 1, 1, FG_FLAGS, 0, 0, 0)).toBe(true);
  const fgBack: Span[] = [];
  for (let y = Math.floor(H / 2); y < H; y++) fgBack.push(makeSpan(y, W, SPAN_TRANS66, 0.1));
  expect(pool.stageRGB({ spans: fgBack, count: fgBack.length }, 0, fgBack.length,
    fgChain, LUX, 1, 1, FG_FLAGS, 0, 0, 0)).toBe(true);
}

function snapPlanes(pool: BandWorkerPool): { q: string; cover: string; depth: string } {
  const v = stubViewsOf(pool);
  return {
    q: fnvU8(new Uint8Array(v.rgb565.buffer, v.rgb565.byteOffset, v.rgb565.byteLength)),
    cover: fnvU8(v.cover),
    depth: fnvU8(new Uint8Array(v.rgbDepth.buffer, v.rgbDepth.byteOffset, v.rgbDepth.byteLength)),
  };
}

function seedForTest(pool: BandWorkerPool, v: number): void {
  const w = stubViewsOf(pool);
  for (let i = 0; i < w.rgb565.length; i++) {
    if (w.cover[i] === 0) w.rgb565[i] = v;
  }
}

function prepKick(pool: BandWorkerPool): void {
  const v = stubViewsOf(pool);
  v.kick[0] = 4; v.kick[1] = 32768; v.kick[2] = 0;
  v.rgbDepth.fill(0xffff);
}

describe('disposal during an RGB kick: bounded fallback converges to serial', () => {
  it('async kick over never-acking workers + dispose() mid-flight: no hang, recovery exact', { timeout: 60000 }, async () => {
    const W = 64, H = 64;
    // Uninterrupted serial reference.
    const ref = stubPool(W, H);
    stageWorldPlusFG(ref, W, H);
    prepKick(ref);
    seedForTest(ref, 0x8410);
    const full = processRGBFrameJob(stubViewsOf(ref), W, H, 3, 0, H);
    expect(full.spans).toBeGreaterThan(0);
    const expected = snapPlanes(ref);
    // Double-apply control (no clear): must differ — the comparison sees
    // exactly-once violations.
    processRGBFrameJob(stubViewsOf(ref), W, H, 3, 0, H, 1);
    expect(snapPlanes(ref).q).not.toBe(expected.q);

    // Never-acking workers: ready preset so the kick proceeds, DONE never
    // arrives. Start the async kick, dispose mid-flight, await bounded.
    const p = stubPool(W, H, { readyBands: 3, timeoutMs: 15 });
    stageWorldPlusFG(p, W, H);
    prepKick(p);
    seedForTest(p, 0x8410);
    const kickP = p.flushRGBFrameAsync(4, 32768, 0);
    await bounded(p.dispose(), 5000, 'dispose during RGB kick');
    const r = await bounded(kickP, 10000, 'async RGB kick after dispose');
    expect(r).toBeNull();
    // Timeout with workers running: 'partial' + quarantine fence, same as
    // the non-dispose timeout path (dispose alone never quarantines — the
    // timed-out kick does).
    expect(p.lastRGBFailure()).toBe('partial');
    expect((p as unknown as { quarantined: boolean }).quarantined).toBe(true);
    expect(p.recoveryEpoch()).toBe(1);
    // Inline fallback converges to the uninterrupted serial planes.
    const tally = p.recoverInlineRGBAll(() => seedForTest(p, 0x8410), 4, 32768, 0);
    expect(tally.spans).toBe(full.spans);
    expect(snapPlanes(p)).toEqual(expected);
    // Disposed pool refuses later work fast (no hang, no wedge).
    const t0 = Date.now();
    expect(p.flushRGBFrame(4, 32768, 0)).toBeNull();
    expect(p.stageRGB({ spans: [], count: 0 }, 0, 0, tinyChain(), null, 0, 0, WORLD_FLAGS, 0, 0, 0)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(p.lastRGBFailure()).toBe('clean');
  });

  it('renderer level: dispose-recovery matches serial RGBA, next frame on a fresh pool exact', { timeout: 120000 }, async () => {
    const W = 96, H = 72;
    const base = createDevroom();
    const world: MiniWorld = { ...base, surfaces: [{ ...base.surfaces[0]!, translucent: 2 }, ...base.surfaces.slice(1)] };
    const view = {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
    };
    const snapRenderer = (r: SoftwareRenderer): { color: string; index: string; q: string; cover: string; depth: string } => {
      const pr = r as unknown as { rgb565: Uint16Array; rgbCover: Uint8Array; rgbDepth16: Uint16Array };
      const live = r.getFramebuffer();
      return {
        color: fnvRGBA(new Uint32Array(live.color.buffer, live.color.byteOffset, live.color.byteLength / 4)),
        index: fnvU8(live.index!),
        q: fnvU8(new Uint8Array(pr.rgb565.buffer, pr.rgb565.byteOffset, pr.rgb565.byteLength)),
        cover: fnvU8(pr.rgbCover),
        depth: fnvU8(new Uint8Array(pr.rgbDepth16.buffer, pr.rgbDepth16.byteOffset, pr.rgbDepth16.byteLength)),
      };
    };
    // Serial reference.
    const rs = new SoftwareRenderer();
    rs.init(createFramebuffer(W, H, true));
    rs.setPalette(testPalette());
    setRGBWorldEnabled(true);
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
    rs.beginFrame();
    rs.renderView(view, { name: 'devroom', data: world }, []);
    rs.endFrame();
    const expected = snapRenderer(rs);

    // Pooled frame over never-acking workers: timeout + quarantine +
    // retained recovery must match serial on every channel incl. RGBA.
    const r = new SoftwareRenderer();
    r.init(createFramebuffer(W, H, true));
    r.setPalette(testPalette());
    setCVar(SW_WORKERS_CVAR, 4);
    setCVar(SW_ACCUM_CVAR, 1);
    if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
    const pool = stubPool(W, H, { readyBands: 3, timeoutMs: 10 });
    r.attachWorkerPool(pool);
    setRGBWorldEnabled(true);
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
    r.beginFrame();
    r.renderView(view, { name: 'devroom', data: world }, []);
    r.endFrame();
    expect(snapRenderer(r)).toEqual(expected);
    expect((pool as unknown as { quarantined: boolean }).quarantined).toBe(true);

    // Dispose bounded, then the next frame on a FRESH pool is exact too.
    await bounded(pool.dispose(), 5000, 'renderer pool dispose');
    const fresh = stubPool(W, H, { readyBands: 0, timeoutMs: 10 });
    r.attachWorkerPool(fresh);
    r.beginFrame();
    r.renderView(view, { name: 'devroom', data: world }, []);
    r.endFrame();
    expect(snapRenderer(r)).toEqual(expected);
    expect(r.testForegroundStats().recoveryCount).toBeGreaterThan(0);
    await bounded(fresh.dispose(), 5000, 'fresh pool dispose');
  });
});

describe('mixed-class partial failure: tris + alpha spans + beams converge exactly once', () => {
  /** Palette-chain additive material for beam spans (mirrors frame.ts rgbPaletteMaterials). */
  function beamMaterial(): { levels: RGBMipLevel[]; flags: number } {
    const pal = testPalette();
    const texels = new Uint8Array(256);
    for (let i = 0; i < 256; i++) texels[i] = i;
    const mat = buildRGBMaterial(texels, 256, 1, pal, null, {
      addressS: 'clamp', addressT: 'clamp', overbright: false, lodBias: 0,
      mipDither: false, bilinear: false, zbits: 16, blend: 'additive',
      depthWrite: true, opaqueMask: true,
    });
    return { levels: mat.levels, flags: R_FLAG_OPAQUE | R_FLAG_DEPTHWRITE | R_FLAG_ADDITIVE };
  }

  function stageMixed(pool: BandWorkerPool, W: number, H: number): { beamSpans: number; triCount: number } {
    // [0] opaque world, all rows.
    const world: Span[] = [];
    for (let y = 0; y < H; y++) world.push(makeSpan(y, W, SPAN_OPAQUE, 0.2));
    expect(pool.stageRGB({ spans: world, count: world.length }, 0, world.length,
      tinyChain(7), LUX, 1, 1, WORLD_FLAGS, 0, 0, 0)).toBe(true);
    // [1] translucent alias tris (gun mesh, alpha 0.5) via emitAliasTris.
    const anorms = buildANorms();
    const shadeDots = buildShadeDots(anorms);
    const cam = setupCamera(new Float32Array([0, 0, 64]), new Float32Array([0, 0, 0]), 90, W, H);
    const triMat = buildRGBMaterial(new Uint8Array(64 * 64).fill(120), 64, 64, testPalette(), null, {
      addressS: 'clamp', addressT: 'clamp', overbright: false, lodBias: 0,
      mipDither: false, bilinear: false, zbits: 0, opaqueMask: true,
    });
    const cursor = pool.triCursor!();
    if (!cursor) throw new Error('no tri cursor');
    const n = emitAliasTris(
      {
        mesh: createGunMesh(), origin: new Float32Array([0, 0, 60]), angles: new Float32Array([0, 0, 0]),
        frameA: 0, frameB: 0, lerp: 0, lightAngle: 0, alpha: 0.5,
      },
      cam, anorms, shadeDots, null, cursor.F, cursor.I, cursor.base, cursor.base + cursor.cap,
    );
    if (n < 0) throw new Error('tri emit overflow');
    const triCount = n - cursor.base;
    expect(triCount).toBeGreaterThan(0);
    expect(pool.stageTriBatch!(cursor.base, triCount, triMat.levels, R_FLAG_TRI | R_FLAG_BLEND_ALPHA, 0, 128)).toBe(true);
    // [2] alpha spans, bottom half (covers the calling-thread main band).
    const fgChain = tinyChain(200);
    const alpha: Span[] = [];
    for (let y = Math.floor(H / 2); y < H; y++) alpha.push(makeSpan(y, W, SPAN_TRANS66, 0.24));
    expect(pool.stageRGB({ spans: alpha, count: alpha.length }, 0, alpha.length,
      fgChain, LUX, 1, 1, FG_FLAGS, 0, 0, 0)).toBe(true);
    // [3] additive beam spans via projectTracerBeam + emitTracerSpans.
    const proj = projectTracerBeam(cam, 40, -30, 60, 40, 30, 60, 225);
    if (!proj) throw new Error('beam fully behind near plane');
    const beamPool: SpanList = { spans: [], count: 0 };
    const bn = emitTracerSpans(proj, W, H, beamPool, 4096);
    expect(bn).toBeGreaterThan(0);
    beamPool.count = bn;
    const bmat = beamMaterial();
    expect(pool.stageRGB(beamPool, 0, bn, bmat.levels, null, 0, 0, bmat.flags, 16, 0, 0)).toBe(true);
    // [4] occluded alpha (behind the world everywhere): world occlusion pin.
    const back: Span[] = [];
    for (let y = 0; y < H; y++) back.push(makeSpan(y, W, SPAN_TRANS66, 0.1));
    expect(pool.stageRGB({ spans: back, count: back.length }, 0, back.length,
      fgChain, LUX, 1, 1, FG_FLAGS, 0, 0, 0)).toBe(true);
    expect(pool.rgbPending()).toBe(5);
    return { beamSpans: bn, triCount };
  }

  it('main-band real writes + failed worker band: blend-suffix recovery is exact, alpha once', () => {
    const W = 64, H = 64;
    // Uninterrupted serial reference over the mixed frame.
    const ref = stubPool(W, H);
    const staged = stageMixed(ref, W, H);
    expect(staged.beamSpans).toBeGreaterThan(0);
    expect(staged.triCount).toBeGreaterThan(0);
    prepKick(ref);
    seedForTest(ref, 0x8410);
    const full = processRGBFrameJob(stubViewsOf(ref), W, H, 5, 0, H);
    expect(full.spans).toBeGreaterThan(0);
    expect(full.tris).toBeGreaterThan(0);
    expect(full.pixels).toBeGreaterThan(0);
    const expected = snapPlanes(ref);
    // Double-apply control (no clear): re-running the BLEND SUFFIX alone
    // [1, 5) over the completed planes applies destination-dependent
    // blends/additives twice, so it MUST differ — proves the test sees
    // exactly-once violations. (The full range would first replay the
    // opaque world prefix, resetting the destination and masking the
    // double blend — hence the suffix-only control.)
    processRGBFrameJob(stubViewsOf(ref), W, H, 5, 0, H, 1);
    const doubled = snapPlanes(ref);
    expect(doubled.q).not.toBe(expected.q);

    // Recovery case: the calling-thread MAIN band (last band) applies real
    // writes — including bottom-half alpha blends — then the worker band
    // fails and the blend-suffix recovery replays.
    const rec = stubPool(W, H);
    stageMixed(rec, W, H);
    prepKick(rec);
    seedForTest(rec, 0x8410);
    const bands = splitBands(H, 4);
    const main = bands[bands.length - 1]!;
    const mainTally = processRGBFrameJob(stubViewsOf(rec), W, H, 5, main.y0, main.y1);
    expect(mainTally.spans).toBeGreaterThan(0);
    // The main band really covered rows (world + alpha wrote there).
    let mainCovered = 0;
    const cover = stubViewsOf(rec).cover;
    for (let y = main.y0; y < main.y1; y++) {
      for (let x = 0; x < W; x++) mainCovered += cover[y * W + x]!;
    }
    expect(mainCovered).toBeGreaterThan(0);
    const tally = rec.recoverInlineRGBAll!(() => seedForTest(rec, 0x8410), 4, 32768, 0);
    expect(tally.pixels).toBe(full.pixels);
    expect(tally.tris).toBe(full.tris);
    expect(snapPlanes(rec)).toEqual(expected);
    expect(rec.rgbPending()).toBe(rec.rgbFlushed!());
    expect(rec.lastRGBFailure!()).toBeNull();
  });
});

describe('indexed (non-RGB) timeout pin: fast-fail null, no quarantine', () => {
  it('flushFrame timeout refuses without quarantining; pool stays usable', () => {
    // NOTE: this pins the KNOWN GAP documented on BandWorkerPool.flushFrame:
    // the indexed path has no isolation fence — a timed-out kick returns
    // null and the caller replays inline via drawInlineAll. Do not add
    // quarantine/isolation here without a matching design review; do not
    // weaken this pin (workers retained, epoch unmoved) silently.
    const W = 32, H = 32;
    const p = stubPool(W, H, { readyBands: 3, timeoutMs: 15 });
    const cur = p.flatCursor();
    expect(cur).not.toBeNull();
    const s = createSpan();
    s.kind = SPAN_OPAQUE;
    s.y = 0; s.x0 = 0; s.x1 = W;
    s.iz = 0.2; s.diz = 0;
    s.uz = 8; s.duz = 0; s.vz = 8; s.dvz = 0;
    s.light = 40; s.dlight = 0;
    s.lu = 0; s.lv = 0; s.dlu = 0;
    s.turb = 0; s.ord = 0; s.dudy = 0; s.dvdy = 0;
    const list: SpanList = { spans: [s], count: 1 };
    const pk = packFrameSpans(list, cur!.F, cur!.I, cur!.base, cur!.base, cur!.cap);
    expect(pk).not.toBeNull();
    const tex = { width: 4, height: 4, texels: new Uint8Array(16).fill(7) };
    const light = { width: 1, height: 1, values: new Uint8Array([40]) };
    const colormap = new Uint8Array(64 * 256);
    for (let g = 0; g < 64; g++) colormap.fill(g, g * 256, g * 256 + 256);
    expect(p.packBatched(cur!.base, pk!.count, tex, light, colormap, 0)).toBe(true);
    // Kick proceeds (ready preset), DONE never arrives -> bounded timeout.
    const t0 = Date.now();
    const r = p.flushFrame();
    const dt = Date.now() - t0;
    expect(r).toBeNull();
    expect(dt).toBeLessThan(10000);
    // No quarantine: workers retained, epoch unmoved, RGB classification
    // untouched (the indexed path never sets it).
    expect((p as unknown as { quarantined: boolean }).quarantined).toBe(false);
    expect((p as unknown as { workers: unknown[] }).workers.length).toBe(3);
    expect(p.recoveryEpoch()).toBe(0);
    expect(p.lastRGBFailure!()).toBeNull();
    // Pool stays usable (not wedged): staging cursor live, beginFrame resets.
    expect(p.flatCursor()).not.toBeNull();
    p.beginFrame();
    expect(p.accumPending()).toBe(0);
  });
});
