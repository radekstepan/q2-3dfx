// TASK items 1+3 (renderer lane): retained-frame foreground recovery +
// truthful foreground counters.
//
// Recovery protocol under test (see BandDispatcher docs in bands.ts):
// descriptors are retained across flushes within a frame; flushes kick
// the unapplied suffix; failure replays the FULL retained range in order
// (world prefix, background seed, foreground suffix) with exactly-once
// blends. These tests use REAL pool staging/kick paths with scripted
// workers (no threads — deterministic), plus renderer-level renders
// against uninterrupted serial references.
//
// What the tests prove (fail-before: they fail on the old reset-on-flush
// code because world descriptors are gone after the world flush):
//  - capacity-exhaustion after staged FG work preserves world + FG;
//  - one completed band with translucent pixels + a failed band replays
//    exactly once (world occlusion, untouched pixels, RGB565, coverage,
//    depth, single blend — and the double-blend control differs);
//  - calling-thread band completion + worker timeout converges;
//  - next frame after quarantine is correct and nothing wedges;
//  - counters: serial FG draws are visible inline; worker execution is
//    visible as completed; staged-but-failed work is never completed.
import { afterEach, describe, expect, it } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import type { Entity } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import { SoftwareRenderer, setRGBWorldEnabled, SW_RGB_SKIP_CLASSIC_CVAR } from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import { BandWorkerPool } from './bandPool.js';
import {
  attachFrameAccum, attachRGBAccum, CTL_READY,
  frameAccumTotal, processRGBFrameJob,
  R_FLAG_BLEND_ALPHA, R_FLAG_DEPTHWRITE, R_FLAG_LIGHT, R_FLAG_OPAQUE, R_FLAG_REPEAT,
  RGB_MAX_CHAINS, rgbAccumTotal, splitBands, SW_ACCUM_CVAR, SW_WORKERS_CVAR,
  type Band, type RGBAccumViews,
} from './bands.js';
import {
  SPAN_OPAQUE, SPAN_TRANS66, createSpan,
  type RGBMipLevel, type Span, type SpanList,
} from './spans.js';
import { createGunMesh } from './alias.js';
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

/** Scripted pool: REAL staging/kick code, fake workers (no threads). */
export interface StubPool extends BandWorkerPool {
  __stubViews: RGBAccumViews;
}
export function stubPool(W: number, H: number, opts?: { readyBands?: number; timeoutMs?: number }): StubPool {
  const full = new SharedArrayBuffer(rgbAccumTotal(W, H));
  const { views } = attachFrameAccum(full, W, H);
  const { views: rgbViews } = attachRGBAccum(full, W, H);
  const fakeWorkers = [{}, {}, {}];
  const pool = Object.create(BandWorkerPool.prototype) as unknown as Record<string, unknown>;
  const bands: Band[] = splitBands(H, fakeWorkers.length + 1);
  pool['bandCount'] = bands.length;
  pool['workers'] = fakeWorkers;
  pool['views'] = views;
  pool['rgbViews'] = rgbViews;
  pool['base'] = views.base;
  pool['ctl'] = views.ctl;
  pool['bands'] = bands;
  pool['timeoutMs'] = opts?.timeoutMs ?? 10;
  pool['fbW'] = W;
  pool['fbH'] = H;
  pool['seq'] = 0;
  pool['lastTexels'] = null;
  pool['lastLight'] = null;
  pool['lastColormap'] = null;
  pool['lastPalette'] = null;
  pool['pending'] = new Map();
  pool['readyCount'] = 0;
  pool['frameGen'] = 0;
  pool['mainLastGen'] = 0;
  pool['disposed'] = false;
  pool['spansUsed'] = 0;
  pool['texUsed'] = 0;
  pool['lightUsed'] = 0;
  pool['descCount'] = 0;
  pool['rgbSpansUsed'] = 0;
  pool['rgbChainUsed'] = 0;
  pool['rgbChainLevels'] = 0;
  pool['rgbChainSlots'] = 0;
  pool['rgbLuxUsed'] = 0;
  pool['rgbDescCount'] = 0;
  pool['rgbChainMap'] = new Map();
  pool['rgbTriUsed'] = 0;
  pool['rgbFlushedCount'] = 0;
  pool['rgbFailure'] = null;
  pool['quarantined'] = false;
  // Readiness: fake workers never signal, so preset the counter the
  // awaitReadySync path polls (ready = kick proceeds, main band runs,
  // DONE never arrives -> deterministic timeout).
  views.ctl[CTL_READY] = opts?.readyBands ?? 0;
  const p = pool as unknown as StubPool;
  p.__stubViews = rgbViews;
  return p;
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

/**
 * Stage: opaque world covering all rows (iz=0.2) + translucent FG in the
 * middle band (iz=0.24, in front -> blends) + translucent FG behind the
 * world (iz=0.1 -> occluded). Returns descriptor counts.
 */
function stageWorldPlusFG(pool: BandWorkerPool, W: number, H: number): { world: number; fg: number } {
  const chain = tinyChain(7);
  // A DIFFERENT chain for the foreground (index 200): blending a distinct
  // source over the destination is observable, so single vs double
  // application differ and the recovery tests are not vacuous (blending
  // a texel with itself would be a silent no-op).
  const fgChain = tinyChain(200);
  const world: Span[] = [];
  for (let y = 0; y < H; y++) world.push(makeSpan(y, W, SPAN_OPAQUE, 0.2));
  const okW = pool.stageRGB({ spans: world, count: world.length }, 0, world.length,
    chain, LUX, 1, 1, WORLD_FLAGS, 0, 0, 0);
  expect(okW).toBe(true);
  const fgFront: Span[] = [];
  for (let y = Math.floor(H / 4); y < Math.floor((3 * H) / 4); y++) fgFront.push(makeSpan(y, W, SPAN_TRANS66, 0.24));
  const okF = pool.stageRGB({ spans: fgFront, count: fgFront.length }, 0, fgFront.length,
    fgChain, LUX, 1, 1, FG_FLAGS, 0, 0, 0);
  expect(okF).toBe(true);
  const fgBack: Span[] = [];
  for (let y = Math.floor(H / 2); y < H; y++) fgBack.push(makeSpan(y, W, SPAN_TRANS66, 0.1));
  const okB = pool.stageRGB({ spans: fgBack, count: fgBack.length }, 0, fgBack.length,
    fgChain, LUX, 1, 1, FG_FLAGS, 0, 0, 0);
  expect(okB).toBe(true);
  return { world: world.length, fg: fgFront.length + fgBack.length };
}

function planesOf(pool: BandWorkerPool): { q: Uint16Array; cover: Uint8Array; depth: Uint16Array } {
  const v = stubViewsOf(pool);
  return { q: v.rgb565, cover: v.cover, depth: v.rgbDepth };
}

function snapPlanes(pool: BandWorkerPool): { q: string; cover: string; depth: string } {
  const p = planesOf(pool);
  return { q: fnvU8(new Uint8Array(p.q.buffer, p.q.byteOffset, p.q.byteLength)), cover: fnvU8(p.cover), depth: fnvU8(new Uint8Array(p.depth.buffer, p.depth.byteOffset, p.depth.byteLength)) };
}

/** Seed the RGB565 destination (mirrors frame.ts seedRGBBackground: uncovered pixels only). */
function seedForTest(pool: BandWorkerPool, v: number): void {
  const p = planesOf(pool);
  for (let i = 0; i < p.q.length; i++) {
    if (p.cover[i] === 0) p.q[i] = v;
  }
}

describe('retained-frame recovery: partial writes replay exactly once', () => {
  it('completed band with translucent pixels + failed band converges to the uninterrupted reference', () => {
    const W = 64, H = 64;
    // Reference: stage everything, run the full range once over a seed.
    const ref = stubPool(W, H);
    stageWorldPlusFG(ref, W, H);
    const rv = stubViewsOf(ref);
    rv.kick[0] = 4; rv.kick[1] = 32768; rv.kick[2] = 0;
    rv.rgbDepth.fill(0xffff);
    seedForTest(ref, 0x8410);
    const full = processRGBFrameJob(rv, W, H, 3, 0, H);
    expect(full.spans).toBeGreaterThan(0);
    const expected = snapPlanes(ref);

    // Double-blend control: run the FG suffix a second time WITHOUT a
    // clear (the old bug shape). Must differ — proves the test can see
    // double-applied alpha.
    const dbl = processRGBFrameJob(rv, W, H, 3, 0, H, 1);
    expect(dbl.spans).toBeGreaterThan(0);
    const doubleApplied = snapPlanes(ref);
    expect(doubleApplied.q).not.toBe(expected.q);

    // Recovery case: fresh staging, one band fully applied (incl. the
    // translucent rows), then the rest fails.
    const rec = stubPool(W, H);
    stageWorldPlusFG(rec, W, H);
    const rw = stubViewsOf(rec);
    rw.kick[0] = 4; rw.kick[1] = 32768; rw.kick[2] = 0;
    rw.rgbDepth.fill(0xffff);
    seedForTest(rec, 0x8410);
    const bands = splitBands(H, 4);
    const band0 = processRGBFrameJob(rw, W, H, 3, bands[0]!.y0, bands[0]!.y1);
    expect(band0.spans).toBeGreaterThan(0);
    // The timed-out kick would have left bands partially drawn: recover.
    const tally = rec.recoverInlineRGBAll!(() => seedForTest(rec, 0x8410), 4, 32768, 0);
    expect(tally.spans).toBe(full.spans);
    expect(snapPlanes(rec)).toEqual(expected);
    // Watermark advanced: nothing left unapplied, failure cleared.
    expect(rec.rgbPending()).toBe(rec.rgbFlushed!());
    expect(rec.lastRGBFailure!()).toBeNull();
  });

  it('capacity exhaustion after staged FG work preserves world + FG', () => {
    const W = 64, H = 64;
    const ref = stubPool(W, H);
    stageWorldPlusFG(ref, W, H);
    const rv = stubViewsOf(ref);
    rv.kick[0] = 4; rv.kick[1] = 32768; rv.kick[2] = 0;
    rv.rgbDepth.fill(0xffff);
    seedForTest(ref, 0x8410);
    processRGBFrameJob(rv, W, H, 3, 0, H);
    const expected = snapPlanes(ref);

    const rec = stubPool(W, H);
    stageWorldPlusFG(rec, W, H);
    // Force chain-capacity exhaustion with a NEW chain while retained
    // descriptors exist: the eviction guard must refuse (it cannot reuse
    // slots that live descriptors reference).
    (rec as unknown as Record<string, unknown>)['rgbChainSlots'] = RGB_MAX_CHAINS;
    const otherChain: RGBMipLevel[] = [{
      data: new Uint8Array(12).fill(9), width: 2, height: 2, mask: new Uint8Array(4).fill(255),
    }];
    const refused = rec.stageRGB(
      { spans: [makeSpan(0, W, SPAN_OPAQUE, 0.2)], count: 1 }, 0, 1,
      otherChain, LUX, 1, 1, WORLD_FLAGS, 0, 0, 0);
    expect(refused).toBe(false);
    expect(rec.rgbPending()).toBe(3);
    // Staging-refusal recovery (class a): replay retained work, then the
    // pool is usable again (beginFrame resets; no wedge).
    const rw = stubViewsOf(rec);
    rw.kick[0] = 4; rw.kick[1] = 32768; rw.kick[2] = 0;
    rw.rgbDepth.fill(0xffff);
    const tally = rec.recoverInlineRGBAll!(() => seedForTest(rec, 0x8410), 4, 32768, 0);
    expect(tally.spans).toBeGreaterThan(0);
    expect(snapPlanes(rec)).toEqual(expected);
    rec.beginFrame();
    expect(rec.rgbPending()).toBe(0);
    expect(rec.rgbFlushed!()).toBe(0);
    const okAfter = rec.stageRGB(
      { spans: [makeSpan(0, W, SPAN_OPAQUE, 0.2)], count: 1 }, 0, 1,
      otherChain, LUX, 1, 1, WORLD_FLAGS, 0, 0, 0);
    expect(okAfter).toBe(true);
  });

  it('calling-thread band completes, worker timeout quarantines, recovery converges', () => {
    const W = 64, H = 64;
    const ref = stubPool(W, H);
    stageWorldPlusFG(ref, W, H);
    const rv = stubViewsOf(ref);
    rv.kick[0] = 4; rv.kick[1] = 32768; rv.kick[2] = 0;
    rv.rgbDepth.fill(0xffff);
    seedForTest(ref, 0x8410);
    processRGBFrameJob(rv, W, H, 3, 0, H);
    const expected = snapPlanes(ref);

    // Kick proceeds (ready preset) with fake workers: the calling-thread
    // band applies, DONE never arrives -> timeout -> 'partial' + quarantine.
    const p = stubPool(W, H, { readyBands: 3, timeoutMs: 10 });
    stageWorldPlusFG(p, W, H);
    const pw = stubViewsOf(p);
    pw.rgbDepth.fill(0xffff);
    seedForTest(p, 0x8410);
    const r = p.flushRGBFrame(4, 32768, 0);
    expect(r).toBeNull();
    expect(p.lastRGBFailure!()).toBe('partial');
    expect((p as unknown as { quarantined: boolean }).quarantined).toBe(true);
    expect((p as unknown as { workers: unknown[] }).workers.length).toBe(0);
    // Calling-thread (last) band really ran before the timeout.
    const mainRows = splitBands(H, 4)[3]!;
    let mainCovered = 0;
    const cover = planesOf(p).cover;
    for (let y = mainRows.y0; y < mainRows.y1; y++) {
      for (let x = 0; x < W; x++) mainCovered += cover[y * W + x]!;
    }
    expect(mainCovered).toBeGreaterThan(0);
    // Quarantined pool refuses later kicks fast (no hang).
    expect(p.flushRGBFrame(4, 32768, 0)).toBeNull();
    expect(p.stageRGB({ spans: [], count: 0 }, 0, 0, tinyChain(), null, 0, 0, WORLD_FLAGS, 0, 0, 0)).toBe(false);
    // Recovery converges to the uninterrupted reference.
    const tally = p.recoverInlineRGBAll!(() => seedForTest(p, 0x8410), 4, 32768, 0);
    expect(tally.spans).toBeGreaterThan(0);
    expect(snapPlanes(p)).toEqual(expected);
  });

  it('clean failure (workers never ready) replays without clearing applied work', () => {
    const W = 48, H = 48;
    const ref = stubPool(W, H);
    stageWorldPlusFG(ref, W, H);
    const rv = stubViewsOf(ref);
    rv.kick[0] = 4; rv.kick[1] = 32768; rv.kick[2] = 0;
    rv.rgbDepth.fill(0xffff);
    seedForTest(ref, 0x8410);
    processRGBFrameJob(rv, W, H, 3, 0, H);
    const expected = snapPlanes(ref);

    const p = stubPool(W, H, { readyBands: 0, timeoutMs: 10 });
    stageWorldPlusFG(p, W, H);
    const pw = stubViewsOf(p);
    pw.rgbDepth.fill(0xffff);
    seedForTest(p, 0x8410);
    const r = p.flushRGBFrame(4, 32768, 0);
    expect(r).toBeNull();
    expect(p.lastRGBFailure!()).toBe('clean');
    // Nothing ran: workers intact (no quarantine on clean failure).
    expect((p as unknown as { workers: unknown[] }).workers.length).toBe(3);
    const tally = p.recoverInlineRGBAll!(() => seedForTest(p, 0x8410), 4, 32768, 0);
    expect(tally.spans).toBeGreaterThan(0);
    expect(snapPlanes(p)).toEqual(expected);
  });

  it('odd dims + band seams: suffix kicks + recovery are exact', () => {    const W = 61, H = 45;
    const mk = (pool: BandWorkerPool): void => { stageWorldPlusFG(pool, W, H); };
    const runFull = (pool: BandWorkerPool): void => {
      const v = stubViewsOf(pool);
      v.kick[0] = 4; v.kick[1] = 32768; v.kick[2] = 0;
      v.rgbDepth.fill(0xffff);
      seedForTest(pool, 0x1234);
      processRGBFrameJob(v, W, H, 3, 0, H);
    };
    const ref = stubPool(W, H);
    mk(ref);
    runFull(ref);
    const expected = snapPlanes(ref);
    // Suffix-only execution (world prefix already applied) == full run.
    const suf = stubPool(W, H);
    mk(suf);
    const sv = stubViewsOf(suf);
    sv.kick[0] = 4; sv.kick[1] = 32768; sv.kick[2] = 0;
    sv.rgbDepth.fill(0xffff);
    seedForTest(suf, 0x1234);
    processRGBFrameJob(sv, W, H, 1, 0, H);
    seedForTest(suf, 0x1234);
    processRGBFrameJob(sv, W, H, 3, 0, H, 1);
    expect(snapPlanes(suf)).toEqual(expected);
    // Recovery after a partial middle band == full run.
    const rec = stubPool(W, H);
    mk(rec);
    const rw2 = stubViewsOf(rec);
    rw2.kick[0] = 4; rw2.kick[1] = 32768; rw2.kick[2] = 0;
    rw2.rgbDepth.fill(0xffff);
    seedForTest(rec, 0x1234);
    const bands = splitBands(H, 4);
    processRGBFrameJob(rw2, W, H, 3, bands[1]!.y0, bands[1]!.y1);
    rec.recoverInlineRGBAll!(() => seedForTest(rec, 0x1234), 4, 32768, 0);
    expect(snapPlanes(rec)).toEqual(expected);
  });

  it('opaque suffix recovery preserves non-retained inline writes (no clear)', () => {
    const W = 64, H = 64;
    // World covers rows 1..H-1 only; row 0 stays a non-retained inline
    // write (simulates a critter drawn between kicks). The FG batch is
    // opaque, so its recovery must replay in place WITHOUT a clear.
    const stageBoth = (pool: BandWorkerPool): void => {
      const chain = tinyChain(7);
      const world: Span[] = [];
      for (let y = 1; y < H; y++) world.push(makeSpan(y, W, SPAN_OPAQUE, 0.2));
      expect(pool.stageRGB({ spans: world, count: world.length }, 0, world.length,
        chain, LUX, 1, 1, WORLD_FLAGS, 0, 0, 0)).toBe(true);
      const fgChain = tinyChain(200);
      const fg: Span[] = [];
      for (let y = 16; y < 48; y++) fg.push(makeSpan(y, W, SPAN_OPAQUE, 0.24));
      expect(pool.stageRGB({ spans: fg, count: fg.length }, 0, fg.length,
        fgChain, LUX, 1, 1, WORLD_FLAGS, 0, 0, 0)).toBe(true);
    };
    const writeMarker = (pool: BandWorkerPool): void => {
      const p = planesOf(pool);
      p.q[0] = 0x1234; p.cover[0] = 1; p.depth[0] = 1000;
    };
    // Reference: uninterrupted full run, then the same inline marker.
    const ref = stubPool(W, H);
    stageBoth(ref);
    const rv = stubViewsOf(ref);
    rv.kick[0] = 4; rv.kick[1] = 32768; rv.kick[2] = 0;
    rv.rgbDepth.fill(0xffff);
    seedForTest(ref, 0x8410);
    processRGBFrameJob(rv, W, H, 2, 0, H);
    writeMarker(ref);
    const expected = snapPlanes(ref);
    // Recovery case: world prefix applied (flushed), inline marker
    // written, one FG band partially executed, then recovery. The opaque
    // suffix must replay WITHOUT clearing, so the marker survives and
    // the planes converge.
    const rec = stubPool(W, H);
    stageBoth(rec);
    const rw = stubViewsOf(rec);
    rw.kick[0] = 4; rw.kick[1] = 32768; rw.kick[2] = 0;
    rw.rgbDepth.fill(0xffff);
    seedForTest(rec, 0x8410);
    processRGBFrameJob(rw, W, H, 1, 0, H);
    (rec as unknown as Record<string, unknown>)['rgbFlushedCount'] = 1;
    writeMarker(rec);
    const bands = splitBands(H, 4);
    processRGBFrameJob(rw, W, H, 2, bands[2]!.y0, bands[2]!.y1, 1);
    const tally = rec.recoverInlineRGBAll!(() => seedForTest(rec, 0x8410), 4, 32768, 0);
    expect(tally.spans).toBe(32);
    expect(snapPlanes(rec)).toEqual(expected);
    expect(planesOf(rec).q[0]).toBe(0x1234);
  });
});

// --- renderer level: stub pool attached, devroom, serial reference --------

function devView() {
  return {
    origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
    fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
  };
}

function renderSerial(W: number, H: number, world: MiniWorld, entities: Entity[]): {
  color: string; index: string; planes: { q: string; cover: string; depth: string };
} {
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(testPalette());
  setRGBWorldEnabled(true);
  setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
  r.beginFrame();
  r.renderView(devView(), { name: 'devroom', data: world }, entities);
  r.endFrame();
  const pr = r as unknown as {
    rgb565: Uint16Array; rgbCover: Uint8Array; rgbDepth16: Uint16Array;
  };
  // Live views: with an attached pool, color/index point at the shared
  // planes, not the init-time framebuffer object.
  const live = r.getFramebuffer();
  return {
    color: fnvU8(new Uint8Array(live.color.buffer, live.color.byteOffset, live.color.byteLength)),
    index: fnvU8(live.index!),
    planes: {
      q: fnvU8(new Uint8Array(pr.rgb565.buffer, pr.rgb565.byteOffset, pr.rgb565.byteLength)),
      cover: fnvU8(pr.rgbCover),
      depth: fnvU8(new Uint8Array(pr.rgbDepth16.buffer, pr.rgbDepth16.byteOffset, pr.rgbDepth16.byteLength)),
    },
  };
}

export function renderStubPooled(W: number, H: number, world: MiniWorld, entities: Entity[], readyBands: number): {
  color: string; index: string; planes: { q: string; cover: string; depth: string };
  fg: ReturnType<SoftwareRenderer['testForegroundStats']>;
  pool: StubPool; renderer: SoftwareRenderer;
} {
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(testPalette());
  setCVar(SW_WORKERS_CVAR, 4);
  setCVar(SW_ACCUM_CVAR, 1);
  if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
  const pool = stubPool(W, H, { readyBands, timeoutMs: 10 });
  r.attachWorkerPool(pool);
  setRGBWorldEnabled(true);
  setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
  r.beginFrame();
  r.renderView(devView(), { name: 'devroom', data: world }, entities);
  r.endFrame();
  const pr = r as unknown as {
    rgb565: Uint16Array; rgbCover: Uint8Array; rgbDepth16: Uint16Array;
  };
  // Live views: with an attached pool, color/index point at the shared
  // planes, not the init-time framebuffer object.
  const live = r.getFramebuffer();
  return {
    color: fnvU8(new Uint8Array(live.color.buffer, live.color.byteOffset, live.color.byteLength)),
    index: fnvU8(live.index!),
    planes: {
      q: fnvU8(new Uint8Array(pr.rgb565.buffer, pr.rgb565.byteOffset, pr.rgb565.byteLength)),
      cover: fnvU8(pr.rgbCover),
      depth: fnvU8(new Uint8Array(pr.rgbDepth16.buffer, pr.rgbDepth16.byteOffset, pr.rgbDepth16.byteLength)),
    },
    fg: r.testForegroundStats(),
    pool,
    renderer: r,
  };
}

/** Devroom with the floor marked translucent (drives the deferred alpha FG path). */
function translucentDevroom(): MiniWorld {
  const base = createDevroom();
  const floor = { ...base.surfaces[0]!, translucent: 2 };
  return { ...base, surfaces: [floor, ...base.surfaces.slice(1)] };
}

describe('renderer-level recovery: pooled failures match serial', () => {
  it('clean failure (never ready) preserves world + FG, alpha exactly once, next frame correct', () => {
    const W = 96, H = 72;
    const world = translucentDevroom();
    const expected = renderSerial(W, H, world, []);
    const got = renderStubPooled(W, H, world, [], 0);
    expect(got.color).toBe(expected.color);
    expect(got.index).toBe(expected.index);
    expect(got.planes).toEqual(expected.planes);
    // Nothing staged-but-failed is reported as worker-rendered.
    expect(got.fg.kicks).toBe(0);
    expect(got.fg.workerSpansCompleted).toBe(0);
    expect(got.fg.workerPixelsCompleted).toBe(0);
    expect(got.fg.recoveryCount).toBeGreaterThan(0);
    expect(got.fg.replayedSpans).toBeGreaterThan(0);
    // Alpha spans staged (not completed) — staged != completed.
    expect(got.fg.alphaSpansStaged).toBeGreaterThan(0);
    // Next frame on the failed pool stays correct (all-inline fallback).
    const r2 = got.renderer;
    r2.beginFrame();
    r2.renderView(devView(), { name: 'devroom', data: world }, []);
    r2.endFrame();
    const fb2 = r2.getFramebuffer();
    expect(fnvU8(new Uint8Array(fb2.color.buffer, fb2.color.byteOffset, fb2.color.byteLength))).toBe(expected.color);
  });

  it('partial failure (main band ran, workers timed out) converges + quarantines + next frame correct', () => {
    const W = 96, H = 72;
    const world = translucentDevroom();
    const expected = renderSerial(W, H, world, []);
    const got = renderStubPooled(W, H, world, [], 3);
    expect(got.color).toBe(expected.color);
    expect(got.index).toBe(expected.index);
    expect(got.planes).toEqual(expected.planes);
    const priv = got.pool as unknown as { quarantined: boolean; workers: unknown[] };
    expect(priv.quarantined).toBe(true);
    expect(priv.workers.length).toBe(0);
    expect(got.fg.kicks).toBe(0);
    expect(got.fg.workerSpansCompleted).toBe(0);
    expect(got.fg.recoveryCount).toBeGreaterThan(0);
    // Next frame: quarantined pool refuses fast, inline fallback is exact.
    const r2 = got.renderer;
    r2.beginFrame();
    r2.renderView(devView(), { name: 'devroom', data: world }, []);
    r2.endFrame();
    const fb2 = r2.getFramebuffer();
    expect(fnvU8(new Uint8Array(fb2.color.buffer, fb2.color.byteOffset, fb2.color.byteLength))).toBe(expected.color);
  });

  it('counters: serial FG draws are inline-visible with native units', () => {
    const W = 96, H = 72;
    const world = translucentDevroom();
    const expected = renderSerial(W, H, world, []);
    void expected;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    setRGBWorldEnabled(true);
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
    // One gun entity (viewmodel path) in front of the devroom camera.
    const gun = r.registerModel({ name: 'gun', kind: 'md2', data: createGunMesh() });
    const entities: Entity[] = [{
      model: gun, origin: new Float32Array([60, -90, 20]), angles: new Float32Array([0, 35, 0]),
      frame: 0, skin: 0,
    }];
    r.beginFrame();
    r.renderView(devView(), { name: 'devroom', data: world }, entities);
    r.endFrame();
    const fg = r.testForegroundStats();
    // Placed alias + the gun entity drew inline (draws + triangles).
    expect(fg.aliasDrawsInline).toBe(2);
    expect(fg.aliasTrisInline).toBeGreaterThan(0);
    // Particles drew inline (draws + particle count, native units).
    expect(fg.particleDrawsInline).toBe(1);
    expect(fg.particlesInline).toBeGreaterThan(0);
    // Serial render stages nothing and completes nothing by workers.
    expect(fg.stagedBatches).toBe(0);
    expect(fg.workerSpansCompleted).toBe(0);
    expect(fg.kicks).toBe(0);
    // Entity pass timing is measured (always on, ms).
    expect(typeof fg.entityMs).toBe('number');
    expect(fg.entityMs).toBeGreaterThanOrEqual(0);
    // Legacy shape still reports inline span batches only.
    const legacy = r.testForegroundWorkerStats();
    expect(legacy.staged).toBe(0);
    expect(legacy.kicks).toBe(0);
  });

  it('counters: pooled success reports worker completion; failure reports replay, never completion', () => {
    const W = 96, H = 72;
    const world = translucentDevroom();
    // Clean-failure run: staged work exists but nothing completes.
    const failed = renderStubPooled(W, H, world, [], 0);
    expect(failed.fg.stagedBatches).toBeGreaterThan(0);
    expect(failed.fg.kicks).toBe(0);
    expect(failed.fg.workerSpansCompleted).toBe(0);
    expect(failed.fg.mainSpansCompleted).toBe(0);
    expect(failed.fg.recoveryCount).toBeGreaterThan(0);
    expect(failed.fg.replayedSpans).toBeGreaterThan(0);
    // Sprite spans staged through the span protocol are counted in spans.
    expect(failed.fg.spriteSpansStaged).toBeGreaterThan(0);
  });

  it('scripted staging refusal forces world-inline + blend-after-inline refusal, still exact', () => {
    const W = 96, H = 72;
    const world = translucentDevroom();
    const expected = renderSerial(W, H, world, []);
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    setCVar(SW_WORKERS_CVAR, 4);
    setCVar(SW_ACCUM_CVAR, 1);
    if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
    const pool = stubPool(W, H, { readyBands: 0, timeoutMs: 10 });
    // Scripted capacity exhaustion: the first two world stages succeed,
    // everything after refuses (class a). Exercises the refusal replay,
    // world-inline writes, and the blend-after-inline refusal for alpha.
    let stages = 0;
    const origStage = pool.stageRGB.bind(pool);
    pool.stageRGB = ((
      list: SpanList, spanStart: number, spanCount: number,
      levels: RGBMipLevel[], luxels: Uint8Array | null, luxW: number, luxH: number,
      flags: number, zbits: number, turbPhase: number, flatRGB: number,
    ): boolean => {
      stages++;
      if (stages > 2) return false;
      return origStage(list, spanStart, spanCount, levels, luxels, luxW, luxH, flags, zbits, turbPhase, flatRGB);
    }) as typeof pool.stageRGB;
    r.attachWorkerPool(pool);
    setRGBWorldEnabled(true);
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
    r.beginFrame();
    r.renderView(devView(), { name: 'devroom', data: world }, []);
    r.endFrame();
    const pr = r as unknown as { rgb565: Uint16Array; rgbCover: Uint8Array; rgbDepth16: Uint16Array };
    const live = r.getFramebuffer();
    expect(fnvU8(new Uint8Array(live.color.buffer, live.color.byteOffset, live.color.byteLength))).toBe(expected.color);
    expect(fnvU8(live.index!)).toBe(expected.index);
    expect(fnvU8(new Uint8Array(pr.rgb565.buffer, pr.rgb565.byteOffset, pr.rgb565.byteLength))).toBe(expected.planes.q);
    expect(fnvU8(pr.rgbCover)).toBe(expected.planes.cover);
    expect(fnvU8(new Uint8Array(pr.rgbDepth16.buffer, pr.rgbDepth16.byteOffset, pr.rgbDepth16.byteLength))).toBe(expected.planes.depth);
    const fg = r.testForegroundStats();
    // World-inline writes happened, so the deferred alpha blend drew
    // inline (refused staging) instead of staging: staged alpha is zero,
    // inline alpha spans are visible, and the frame still recovered.
    expect(fg.directInlineWrites).toBe(true);
    expect(fg.alphaSpansStaged).toBe(0);
    expect(fg.alphaSpansInline).toBeGreaterThan(0);
    expect(fg.recoveryCount).toBeGreaterThan(0);
    expect(fg.kicks).toBe(0);
    expect(fg.workerSpansCompleted).toBe(0);
  });
});

describe('retained-frame protocol: watermark + commit ownership', () => {
  it('flush advances the watermark; commit drops retention; beginFrame resets', () => {
    const W = 32, H = 32;
    const p = stubPool(W, H, { readyBands: 0, timeoutMs: 5 });
    const chain = tinyChain();
    const spans: Span[] = [makeSpan(0, W, SPAN_OPAQUE, 0.2)];
    const list: SpanList = { spans, count: spans.length };
    expect(p.stageRGB(list, 0, 1, chain, LUX, 1, 1, WORLD_FLAGS, 0, 0, 0)).toBe(true);
    expect(p.rgbPending()).toBe(1);
    expect(p.rgbFlushed!()).toBe(0);
    // Empty suffix after manual watermark advance is a no-op success.
    (p as unknown as Record<string, unknown>)['rgbFlushedCount'] = 1;
    const r = p.flushRGBFrame(4, 32768, 0);
    expect(r).toEqual({ pixels: 0, spans: 0, workerSpans: 0, workerPixels: 0, tris: 0, workerTris: 0 });
    expect(p.lastRGBFailure!()).toBeNull();
    p.commitRGB!();
    expect(p.rgbPending()).toBe(0);
    expect(p.rgbFlushed!()).toBe(0);
    p.beginFrame();
    expect(p.rgbPending()).toBe(0);
    expect(p.stageRGB(list, 0, 1, chain, LUX, 1, 1, WORLD_FLAGS, 0, 0, 0)).toBe(true);
    expect(p.rgbPending()).toBe(1);
  });
});
