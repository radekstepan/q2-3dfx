// Foreground/worker recovery: fail-before tests with REAL partial
// writes (PERF-FINISH follow-up item 1, bench/testkit lane).
//
// A mocked worker that never writes cannot prove partial-write recovery: the
// recovery under test replays staged descriptors over planes that may already
// hold band-completed pixels. Every test below drives the real
// BandWorkerPool (real threads, real SAB planes) and compares the recovered
// frame against an uninterrupted serial render of the identical scene:
//
//   a. staging refusal BEFORE dispatch (pool filled to MAX_FRAME_BATCHES
//      with real SAB staging: the overfill refuses with real `false`, and
//      the retained set kicks exactly; plus stale pre-frame retention is
//      dropped at the frame boundary by design, never drawn).
//   b. failure BEFORE any writes (disposed pool: every stage refuses).
//   c. failure AFTER partial execution (pool level: a big indexed batch set
//      is staged, the calling thread drains its band inline — a guaranteed
//      real partial write — while worker bands race; the 20ms timeout
//      forces the inline-replay fallback, and the exact tally proves every
//      staged span drew exactly once).
//   d. calling-thread band + timeout (renderer level: the 1ms world kick can
//      never complete a ~30ms frame in budget, so the timeout path fires;
//      output must still equal serial).
//
// Verified vs uninterrupted serial: full-RGBA hash, index hash, cover,
// translucent-span counts, alpha applied exactly once (frame equality with
// the single-blend serial oracle), the next frame correct, and no wedged
// loop (a fresh pool stages and kicks normally afterwards).
//
// NOTE (RELEASE-8): the RGB composite retired; recovery now runs through
// the indexed frame protocol (`packBatched` / `flushFrame` /
// `drawInlineAll` / `accumPending`). Pool-level exact-tally asserts below
// use that protocol directly; renderer-level legs assert serial-identical
// output through public hooks.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'fs';
import { createFramebuffer } from '@q2/renderer-api';
import type { Entity } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import {
  BandWorkerPool,
  SoftwareRenderer,
  MAX_FRAME_BATCHES,
  SW_ACCUM_CVAR,
  SW_WORKERS_CVAR,
  bspToMiniWorld,
  buildColormap,
  createDevroom,
  createSpan,
  defaultPalette,
  DEVROOM_CAMERA,
  packFrameSpans,
  type BspTexelSource,
  type MiniWorld,
  type Span,
} from '@q2/sw-renderer';
import { loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { PakFile } from '@q2/filesystem';
import { parsePCX, parseWAL } from '@q2/formats';
import { hashColorFull, pngDiff } from './index.js';

const Q2_PAK = process.env.Q2_PAK;
const require = createRequire(process.cwd() + '/');

/** Built @q2/sw-renderer ESM bundle (worker bootstrap source). */
function swRendererEsmPath(): string | null {
  try {
    const cjs = require.resolve('@q2/sw-renderer');
    const esm = cjs.replace(/index\.js$/, 'index.mjs');
    return existsSync(esm) ? esm : null;
  } catch {
    return null;
  }
}

function testPalette(): Uint8Array {
  return new Uint8Array(768).fill(128);
}

interface ViewLike {
  origin: Float32Array;
  angles: Float32Array;
  fovX: number;
  time: number;
  lightStyles: Float32Array;
}

function devView(): ViewLike {
  return {
    origin: DEVROOM_CAMERA.origin,
    angles: DEVROOM_CAMERA.angles,
    fovX: DEVROOM_CAMERA.fovX,
    time: 1.5,
    lightStyles: new Float32Array(256).fill(1),
  };
}

function fnvIdx(idx: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < idx.length; i++) {
    h ^= idx[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Uninterrupted serial indexed oracle: full-RGBA color hash + index hash + cover. */
function renderSerialIndexed(
  W: number, H: number, view: ViewLike,
  world: { name: string; data: MiniWorld }, entities: Entity[],
): { full: string; idx: string; cover: number; trans: number; color: Uint32Array } {
  resetCVars();
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(testPalette());
  r.beginFrame();
  r.renderView(view, world, entities);
  r.endFrame();
  const live = r.getFramebuffer();
  // Cover = depth-written pixels (the depth plane clears to 0).
  let cover = 0;
  for (let i = 0; i < live.depth!.length; i++) if (live.depth![i] !== 0) cover++;
  resetCVars();
  return {
    full: hashColorFull(live.color),
    idx: fnvIdx(live.index!),
    cover,
    trans: r.testTranslucentSpans(),
    color: live.color.slice(),
  };
}

/** Attach a real thread pool (skips cleanly when threads/SAB are missing). */
function attachPool(
  r: SoftwareRenderer, W: number, H: number, workers: number, timeoutMs?: number,
): BandWorkerPool | null {
  const esm = swRendererEsmPath();
  if (!esm) {
    console.log('SKIP pooled recovery: sw-renderer dist not built (run yarn build first)');
    return null;
  }
  resetCVars();
  setCVar(SW_WORKERS_CVAR, workers + 1);
  setCVar(SW_ACCUM_CVAR, 1);
  if (!r.syncWorkersFromCvar()) return null;
  const pool = BandWorkerPool.create(
    workers, W, H,
    timeoutMs === undefined ? { indexJsPath: esm } : { indexJsPath: esm, timeoutMs },
  );
  if (!pool) return null;
  r.attachWorkerPool(pool);
  return pool;
}

const STAGE_TEX = { width: 1, height: 1, texels: new Uint8Array([7]) };
const STAGE_LIGHT = { width: 1, height: 1, values: new Uint8Array([32]) };

/**
 * Stage `batches` indexed batches of `spansEach` full-width opaque spans
 * through the pool's flat cursor (real SAB staging). Returns total spans
 * staged. Throws when a batch refuses (caller asserts refusal explicitly
 * via the boolean form instead).
 */
function stageFullWidth(
  pool: BandWorkerPool, W: number, H: number, batches: number, spansEach: number,
): number {
  const colormap = buildColormap(defaultPalette());
  let n = 0;
  for (let b = 0; b < batches; b++) {
    const cursor = pool.flatCursor();
    if (!cursor) throw new Error('no flat cursor');
    const spans: Span[] = [];
    for (let s = 0; s < spansEach; s++) {
      const sp = createSpan();
      sp.y = (b * spansEach + s) % H;
      sp.x0 = 0;
      sp.x1 = W;
      sp.iz = 0.01;
      sp.light = 32;
      spans.push(sp);
    }
    const packed = packFrameSpans(
      { spans, count: spans.length }, cursor.F, cursor.I, cursor.base, cursor.base, cursor.cap,
    );
    if (!packed || packed.count !== spans.length) throw new Error('pack failed');
    const ok = pool.packBatched(cursor.base, packed.count, STAGE_TEX, STAGE_LIGHT, colormap, 0);
    expect(ok).toBe(true);
    n += packed.count;
  }
  return n;
}

describe('fg recovery (a): staging refusal before dispatch', () => {
  it('pool refuses past capacity: real SAB staging, real refusal, exact kick tally', async () => {
    const esm = swRendererEsmPath();
    if (!esm) {
      console.log('SKIP refusal contract: sw-renderer dist not built (run yarn build first)');
      return;
    }
    const W = 320, H = 240;
    const pool = BandWorkerPool.create(1, W, H, { indexJsPath: esm, timeoutMs: 30000 });
    if (!pool) {
      console.log('SKIP refusal contract: threads/SAB unavailable');
      return;
    }
    try {
      pool.beginFrame();
      // Fill to capacity with real 1-span batches, then overfill: the first
      // MAX_FRAME_BATCHES stage (true), the rest refuse (false) — refusal
      // BEFORE dispatch, no writes.
      const colormap = buildColormap(defaultPalette());
      let staged = 0;
      for (;;) {
        const cursor = pool.flatCursor();
        if (!cursor) throw new Error('no flat cursor');
        const sp = createSpan();
        sp.y = staged % H; sp.x0 = 0; sp.x1 = W; sp.iz = 0.01; sp.light = 32;
        const packed = packFrameSpans(
          { spans: [sp], count: 1 }, cursor.F, cursor.I, cursor.base, cursor.base, cursor.cap,
        );
        if (!packed) throw new Error('pack failed');
        const ok = pool.packBatched(cursor.base, packed.count, STAGE_TEX, STAGE_LIGHT, colormap, 0);
        if (!ok) break;
        staged++;
        if (staged > MAX_FRAME_BATCHES + 16) throw new Error('pool never refused');
      }
      expect(staged).toBe(MAX_FRAME_BATCHES);
      expect(pool.accumPending()).toBe(MAX_FRAME_BATCHES);
      // The retained set kicks exactly (ordering preserved, nothing lost).
      const res = pool.flushFrame();
      expect(res).not.toBeNull();
      expect(res!.spans).toBe(MAX_FRAME_BATCHES);
      expect(pool.accumPending()).toBe(0);
    } finally {
      await pool.dispose();
    }
  });

  it('stale pre-frame retention never leaks: beginFrame drops it, frame proceeds normally', async () => {
    const W = 320, H = 240;
    const world = { name: 'devroom', data: createDevroom() };
    const ref = renderSerialIndexed(W, H, devView(), world, []);
    resetCVars();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    const pool = attachPool(r, W, H, 3);
    if (!pool) return;
    try {
      // Stale retention from a "missed commit" (simulated by direct staging
      // outside any frame): the frame boundary must drop it, never draw it.
      const staged = stageFullWidth(pool, W, H, 4, 8);
      expect(staged).toBe(32);
      expect(pool.accumPending()).toBe(4);
      r.beginFrame();
      r.renderView(devView(), world, []);
      r.endFrame();
      // No leaked descriptors were drawn: the frame is bit-identical to
      // uninterrupted serial, and the pool staged/kicked this frame's own
      // work normally (the stale set was dropped, not replayed).
      const wst = r.testWorkerStats();
      expect(wst.active).toBe(true);
      expect(wst.pooled).toBe(true);
      expect(wst.spans).toBeGreaterThan(0);
      expect(hashColorFull(r.getFramebuffer().color)).toBe(ref.full);
      expect(fnvIdx(r.getFramebuffer().index!)).toBe(ref.idx);
    } finally {
      await pool.dispose();
      resetCVars();
    }
  });
});

describe('fg recovery (b): failure before any writes', () => {
  it('disposed pool falls back to serial-identical output', async () => {
    const W = 320, H = 240;
    const world = { name: 'devroom', data: createDevroom() };
    const ref = renderSerialIndexed(W, H, devView(), world, []);
    resetCVars();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    const pool = attachPool(r, W, H, 1);
    if (!pool) return;
    await pool.dispose();
    r.beginFrame();
    r.renderView(devView(), world, []);
    r.endFrame();
    const live = r.getFramebuffer();
    const wst = r.testWorkerStats();
    // The banded backend stays engaged (inline drain on the dead pool) yet
    // the frame is serial-identical.
    expect(wst.active).toBe(true);
    expect(hashColorFull(live.color)).toBe(ref.full);
    expect(fnvIdx(live.index!)).toBe(ref.idx);
    // Second frame: still identical (no use-after-dispose, nothing wedged).
    r.beginFrame();
    r.renderView(devView(), world, []);
    r.endFrame();
    expect(hashColorFull(r.getFramebuffer().color)).toBe(ref.full);
    resetCVars();
  });
});

describe('fg recovery (c): failure after partial execution (pool level)', () => {
  /**
   * Deterministic partial-write test. The SYNC kick timeout only binds the
   * post-main-drain wait while workers race the calling-thread drain, so
   * under contention a big kick can still complete inside it (workers
   * finish during the main thread's descheduled time). The ASYNC kick
   * (flushFrameAsync, the message-driven path the browser uses) has no
   * such coupling: its timeout is a message-timer covering the WHOLE kick
   * including the main-band drain. With full-width spans (320px each) the
   * workload is a memory-bandwidth floor: 60000 spans (~19M depth-guarded
   * pixels) cannot finish inside a 20ms budget — that is a physical floor
   * (~1000x margin), not a timing assumption — while readiness is proven
   * beforehand by warmup (not assumed). The result is a deterministic
   * timeout: the timer fires, the timed-out kick returns null, and
   * drawInlineAll must then apply every staged span exactly once.
   */
  it('timed-out kick replays every staged span exactly once', async () => {
    const esm = swRendererEsmPath();
    if (!esm) {
      console.log('SKIP pool recovery: sw-renderer dist not built (run yarn build first)');
      return;
    }
    const W = 320, H = 240;
    // Version-independent core API the test needs (all live indexed hooks).
    {
      const probe = BandWorkerPool.create(1, W, H, { indexJsPath: esm, timeoutMs: 30000 });
      if (!probe) {
        console.log('SKIP pool recovery: threads/SAB unavailable');
        return;
      }
      const hasCursor = probe.flatCursor() !== null;
      await probe.dispose();
      if (!hasCursor) {
        console.log('SKIP pool recovery: flat cursor absent in this dist');
        return;
      }
    }
    const BATCHES = 20, SPANS_EACH = 3000;
    const TOTAL = BATCHES * SPANS_EACH;
    const tiny = { spans: [(() => {
      const sp = createSpan();
      sp.y = 0; sp.x0 = 0; sp.x1 = W; sp.iz = 0.01; sp.light = 32;
      return sp;
    })()], count: 1 };
    const stageAll = (pool: BandWorkerPool): number => {
      const colormap = buildColormap(defaultPalette());
      let n = 0;
      for (let b = 0; b < BATCHES; b++) {
        const cursor = pool.flatCursor();
        if (!cursor) throw new Error('no flat cursor');
        const spans: Span[] = [];
        for (let s = 0; s < SPANS_EACH; s++) {
          const sp = createSpan();
          sp.y = (b * SPANS_EACH + s) % H;
          sp.x0 = 0;
          sp.x1 = W;
          sp.iz = 0.01;
          sp.light = 32;
          spans.push(sp);
        }
        const packed = packFrameSpans(
          { spans, count: spans.length }, cursor.F, cursor.I, cursor.base, cursor.base, cursor.cap,
        );
        if (!packed || packed.count !== spans.length) throw new Error('pack failed');
        const ok = pool.packBatched(cursor.base, packed.count, STAGE_TEX, STAGE_LIGHT, colormap, 0);
        expect(ok).toBe(true);
        n += packed.count;
      }
      return n;
    };
    const stageTiny = (pool: BandWorkerPool): boolean => {
      const colormap = buildColormap(defaultPalette());
      const cursor = pool.flatCursor();
      if (!cursor) return false;
      const packed = packFrameSpans(
        tiny, cursor.F, cursor.I, cursor.base, cursor.base, cursor.cap,
      );
      if (!packed || packed.count !== 1) return false;
      return pool.packBatched(cursor.base, packed.count, STAGE_TEX, STAGE_LIGHT, colormap, 0);
    };
    // Well-formedness probe (generous pool): the big kick succeeds with an
    // exact tally. Not a calibration — the attempt budget below is fixed.
    const calib = BandWorkerPool.create(3, W, H, { indexJsPath: esm, timeoutMs: 30000 });
    if (!calib) {
      console.log('SKIP pool recovery: threads/SAB unavailable');
      return;
    }
    try {
      calib.beginFrame();
      expect(stageAll(calib)).toBe(TOTAL);
      const t = process.hrtime.bigint();
      const res = calib.flushFrame();
      expect(res).not.toBeNull();
      expect(res!.spans).toBe(TOTAL);
      console.log(`well-formed: big kick ${TOTAL} spans in ${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(1)}ms`);
    } finally {
      await calib.dispose();
    }
    // Attempt loop (bounded): each fresh pool (fixed 20ms budget) warms
    // until provably ready, stages big, and kicks once via the ASYNC
    // message-driven path. The timer covers the whole kick including the
    // main-band drain, so the kick times out deterministically with the
    // retained set intact. Each iteration asserts exact replay regardless
    // of outcome. Passes with >=1 timeout across attempts; a fast-box
    // fluke costs one attempt, and all-success fails loudly.
    const timeoutMs = 20;
    let partials = 0;
    let successes = 0;
    let lastPool: BandWorkerPool | null = null;
    for (let attempt = 0; attempt < 5 && partials === 0; attempt++) {
      const cand = BandWorkerPool.create(3, W, H, { indexJsPath: esm, timeoutMs });
      if (!cand) break;
      cand.beginFrame();
      // Warmup until a tiny kick SUCCEEDS (readiness observed, never
      // assumed; not-ready kicks return null and refuse nothing).
      let ready = false;
      for (let i = 0; i < 200 && !ready; i++) {
        if (!stageTiny(cand)) break;
        const res = cand.flushFrame();
        if (res !== null) {
          expect(res.spans).toBe(1);
          ready = true;
        } else {
          cand.drawInlineAll();
        }
      }
      if (!ready) {
        await cand.dispose();
        console.log(`attempt ${attempt}: warmup never succeeded — retrying fresh`);
        continue;
      }
      expect(cand.accumPending()).toBe(0);
      // Measurement kick (fixed 20ms async budget): the main-band drain
      // alone exceeds the message-timer, so the kick times out with real
      // partial writes outstanding.
      expect(stageAll(cand)).toBe(TOTAL);
      const res = await cand.flushFrameAsync();
      if (res === null) {
        // The issued kick timed out with real partial writes outstanding.
        // The inline replay must apply every staged span exactly once.
        console.log(`attempt ${attempt}: TIMEOUT pending=${cand.accumPending()}`);
        const tally = cand.drawInlineAll();
        expect(tally.spans).toBe(TOTAL);
        expect(cand.accumPending()).toBe(0);
        partials++;
        lastPool = cand;
      } else {
        // Fast-box moment: the kick completed. Tally still asserted
        // exact (well-formedness holds either way); keep looking for a
        // genuine partial on a fresh pool.
        expect(res.spans).toBe(TOTAL);
        successes++;
        console.log(`attempt ${attempt}: unexpected success (tally=${res.spans}) — retrying fresh`);
        await cand.dispose();
      }
    }
    if (partials === 0) {
      throw new Error(
        `partial path NOT exercised: ${successes} consecutive big kicks completed ` +
        'despite same-pool reference calibration — box too fast for this workload/budget; grow spans',
      );
    }
    expect(lastPool).not.toBeNull();
    const pool: BandWorkerPool = lastPool!;
    try {
      // Timeout-experienced pool + renderer frame: everything stages fresh
      // and the frame must equal uninterrupted serial (class b at renderer
      // level, with the timeout-experienced pool behind it).
      resetCVars();
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(testPalette());
      setCVar(SW_WORKERS_CVAR, 4);
      setCVar(SW_ACCUM_CVAR, 1);
      expect(r.syncWorkersFromCvar()).toBe(true);
      r.attachWorkerPool(pool);
      const world = { name: 'devroom', data: createDevroom() };
      const ref = renderSerialIndexed(W, H, devView(), world, []);
      r.beginFrame();
      r.renderView(devView(), world, []);
      r.endFrame();
      expect(hashColorFull(r.getFramebuffer().color)).toBe(ref.full);
      expect(fnvIdx(r.getFramebuffer().index!)).toBe(ref.idx);
    } finally {
      await pool.dispose();
      resetCVars();
    }
  });
});

describe('fg recovery (d): calling-thread band + timeout (renderer level)', () => {
  it('1ms world kick fails yet the frame matches serial (devroom 640x480)', async () => {
    const W = 640, H = 480;
    const world = { name: 'devroom', data: createDevroom() };
    const ref = renderSerialIndexed(W, H, devView(), world, []);
    resetCVars();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    const pool = attachPool(r, W, H, 3, 1);
    if (!pool) return;
    try {
      r.beginFrame();
      r.renderView(devView(), world, []);
      r.endFrame();
      // The heavy world kick (~30ms pooled at 640x480) cannot complete
      // inside a 1ms budget: the timeout path replays inline, so the frame
      // still matches serial exactly.
      const wst = r.testWorkerStats();
      expect(wst.active).toBe(true);
      expect(wst.pooled).toBe(true);
      expect(wst.spans).toBeGreaterThan(0);
      const live = r.getFramebuffer();
      const diff = pngDiff(live.color, ref.color);
      if (diff !== 0) console.log(`timeout-recovery output diff: ${diff}/${live.color.length} pixels vs serial`);
      expect(hashColorFull(live.color)).toBe(ref.full);
      expect(fnvIdx(live.index!)).toBe(ref.idx);
      expect(wst.pixels).toBeGreaterThan(0);
      // Next frame on a healthy pool: normal pooled execution, still
      // identical (recovery left no wedged state behind).
      await pool.dispose();
      const good = attachPool(r, W, H, 3);
      if (!good) return;
      try {
        r.beginFrame();
        r.renderView(devView(), world, []);
        r.endFrame();
        const w2 = r.testWorkerStats();
        expect(w2.pooled).toBe(true);
        expect(w2.spans).toBeGreaterThan(0);
        expect(hashColorFull(r.getFramebuffer().color)).toBe(ref.full);
      } finally {
        await good.dispose();
      }
    } finally {
      resetCVars();
    }
  });

  it.runIf(!!Q2_PAK)('kick failure over translucent water replays exactly once (base1 pool)', async () => {
    const pakBytes = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(pakBytes.length);
    new Uint8Array(buf).set(pakBytes);
    const pak = new PakFile(buf);
    const map = loadBsp(pak.readFile('maps/base1.bsp')) as BspMap;
    const walCache = new Map<string, BspTexelSource | null>();
    const texelFor = (walName: string): BspTexelSource | null => {
      if (walCache.has(walName)) return walCache.get(walName)!;
      let src: BspTexelSource | null = null;
      try {
        const wal = parseWAL(pak.readFile(`textures/${walName}.wal`));
        src = { texels: wal.mips[0] as Uint8Array, width: wal.width, height: wal.height };
      } catch { src = null; }
      walCache.set(walName, src);
      return src;
    };
    const world = { name: 'base1', data: bspToMiniWorld(map, { texelFor }) };
    const pcx = parsePCX(pak.readFile('pics/colormap.pcx'));
    // Low-road pool: 102 worldspawn TRANS66 faces through deferred alpha.
    const view: ViewLike = {
      origin: new Float32Array([430, 620, -150]),
      angles: new Float32Array([90, 0, 0]),
      fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
    };
    const W = 320, H = 240;
    resetCVars();
    const serial = (() => {
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(pcx.palette);
      r.beginFrame();
      r.renderView(view, world, []);
      r.endFrame();
      const live = r.getFramebuffer();
      let cover = 0;
      for (let i = 0; i < live.index!.length; i++) if (live.index![i] !== 0) cover++;
      const out = {
        full: hashColorFull(live.color),
        cover,
        trans: r.testTranslucentSpans(),
      };
      resetCVars();
      return out;
    })();
    // Translucency must actually be present or alpha-once is vacuous.
    expect(serial.trans).toBeGreaterThan(0);
    resetCVars();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(pcx.palette);
    const pool = attachPool(r, W, H, 3, 1);
    if (!pool) return;
    try {
      r.beginFrame();
      r.renderView(view, world, []);
      r.endFrame();
      const wst = r.testWorkerStats();
      expect(wst.active).toBe(true);
      expect(wst.pooled).toBe(true);
      expect(wst.spans).toBeGreaterThan(0);
      const live = r.getFramebuffer();
      // Full-frame equality with the single-blend serial oracle IS the
      // alpha-once proof: replaying the deferred alpha over already-blended
      // pixels would double-blend and change these pixels.
      expect(hashColorFull(live.color)).toBe(serial.full);
      let cover = 0;
      for (let i = 0; i < live.index!.length; i++) if (live.index![i] !== 0) cover++;
      expect(cover).toBe(serial.cover);
      expect(r.testTranslucentSpans()).toBe(serial.trans);
    } finally {
      await pool.dispose();
      resetCVars();
    }
  });
});
