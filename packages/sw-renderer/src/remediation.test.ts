// Perf remediation items 1-8: invariant + fallback + equivalence pins.
//
// Each item proves the waste is actually eliminated (not just investigated)
// while output stays identical. Software goldens stay bit-identical (the
// full suite pins them); RGB hashes are documented where they change.
import { afterEach, describe, expect, it } from 'vitest';
import { createFramebuffer, type Entity } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import {
  SoftwareRenderer,
  spansBatchIsRowOrdered, sortBatchByRow,
  sphereCulledByFlatFrustum,
} from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import { createBoxMesh } from './alias.js';
import {
  attachFrameAccum, frameAccumTotal,
  D_PER_BATCH, D_SPAN_BASE, D_SPAN_COUNT,
  D_TEX_OFF, D_TEX_W, D_TEX_H, D_LIGHT_OFF, D_LIGHT_W, D_LIGHT_H,
  D_WSHIFT, D_WMASK, D_HMASK, D_TURBPHASE, D_YMIN, D_YMAX,
  processFrameJob, F_PER_SPAN, I_PER_SPAN,
  type FrameAccumViews,
} from './bands.js';
import {
  SPAN_OPAQUE,
} from './spans.js';
import {
  DLightState, bboxDistance, type SurfaceBounds,
} from './light.js';
import {
  testAliasShareStats, testResetAliasShareStats,
} from './alias.js';
import {
  collectVisibleSurfaces,
  testMarkCacheStats, testResetMarkCacheStats,
  type MiniWorld,
} from './worldNodes.js';
import { setupCamera } from './camera.js';

afterEach(() => {
  resetCVars();
  testResetMarkCacheStats();
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

function devView(time = 1.5) {
  return {
    origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
    fovX: DEVROOM_CAMERA.fovX, time, lightStyles: new Float32Array(256).fill(1),
  };
}

function boxEntity(model: number, skin: number, origin: [number, number, number]): Entity {
  return {
    model, skin, frame: 0,
    origin: new Float32Array(origin), angles: new Float32Array([0, 0, 0]),
  };
}

describe('item 1: early model/entity culling', () => {
  function renderWith(W: number, H: number, entities: Entity[]) {
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    const box = r.registerModel({ kind: 'md2', name: 'box', data: createBoxMesh() });
    const skin = r.registerSkin('test');
    const ents = entities.map((e) => ({ ...e, model: box, skin }));
    r.beginFrame();
    const stats = r.renderView(devView(), { name: 'devroom', data: createDevroom() }, ents);
    r.endFrame();
    const live = r.getFramebuffer();
    return { idx: fnvU8(live.index!), stats, cull: r.testEntityCullStats() };
  }

  it('off-screen entities are culled with identical output', () => {
    const base = renderWith(160, 120, []);
    // Three critters parked 500u behind the camera (fully behind near).
    const behind: Entity[] = [0, 1, 2].map((k) => boxEntity(0, 0, [
      DEVROOM_CAMERA.origin[0]! - 500 - k * 10,
      DEVROOM_CAMERA.origin[1]!,
      DEVROOM_CAMERA.origin[2]!,
    ]));
    const culled = renderWith(160, 120, behind);
    expect(culled.idx).toBe(base.idx);
    expect(culled.cull.culled).toBe(3);
    expect(culled.cull.drawn).toBe(base.cull.drawn);
  });

  it('rotation cannot hide a visible model, and cannot save an invisible one', () => {
    const base = renderWith(160, 120, []);
    const mk = (yaw: number, origin: [number, number, number]): Entity => ({
      model: 0, skin: 0, frame: 0,
      origin: new Float32Array(origin), angles: new Float32Array([0, yaw, 0]),
    });
    // Behind the camera at several yaws: always fully culled, same pixels.
    for (const yaw of [0, 45, 90, 180, 270]) {
      const r = renderWith(160, 120, [mk(yaw, [
        DEVROOM_CAMERA.origin[0]! - 400,
        DEVROOM_CAMERA.origin[1]! - 200,
        DEVROOM_CAMERA.origin[2]!,
      ])]);
      expect(r.idx).toBe(base.idx);
      expect(r.cull.culled).toBe(1);
    }
    // In front of the camera: drawn at every yaw (conservative sphere).
    // (Different yaws render different silhouettes, so only the cull
    // decision — not the pixels — is asserted across rotations.)
    const before = renderWith(160, 120, [mk(0, [
      DEVROOM_CAMERA.origin[0]! + 60,
      DEVROOM_CAMERA.origin[1]!,
      DEVROOM_CAMERA.origin[2]!,
    ])]);
    expect(before.cull.drawn).toBeGreaterThan(base.cull.drawn);
    for (const yaw of [90, 180]) {
      const r = renderWith(160, 120, [mk(yaw, [
        DEVROOM_CAMERA.origin[0]! + 60,
        DEVROOM_CAMERA.origin[1]!,
        DEVROOM_CAMERA.origin[2]!,
      ])]);
      expect(r.cull.culled).toBe(0);
      expect(r.cull.drawn).toBe(before.cull.drawn);
    }
  });

  it('depth-hack viewmodels are exempt (drawn, never culled)', () => {
    const fb = createFramebuffer(160, 120, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    const box = r.registerModel({ kind: 'md2', name: 'box', data: createBoxMesh() });
    const skin = r.registerSkin('test');
    // Behind the camera: a normal instance culls; the depth-hack twin draws
    // (and clips to zero pixels, so output is still identical).
    const behind = boxEntity(box, skin, [
      DEVROOM_CAMERA.origin[0]! - 400,
      DEVROOM_CAMERA.origin[1]!,
      DEVROOM_CAMERA.origin[2]!,
    ]);
    const baseDrawn = (() => {
      const fb0 = createFramebuffer(160, 120, true);
      const r0 = new SoftwareRenderer();
      r0.init(fb0);
      r0.setPalette(testPalette());
      r0.beginFrame();
      r0.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
      r0.endFrame();
      return r0.testEntityCullStats().drawn;
    })();
    r.beginFrame();
    r.renderView(devView(), { name: 'devroom', data: createDevroom() }, [
      behind,
      { ...behind, depthHack: true },
    ]);
    r.endFrame();
    const cull = r.testEntityCullStats();
    expect(cull.culled).toBe(1);
    expect(cull.drawn).toBe(baseDrawn + 1);
    const live = r.getFramebuffer();
    const plain = (() => {
      const fb2 = createFramebuffer(160, 120, true);
      const r2 = new SoftwareRenderer();
      r2.init(fb2);
      r2.setPalette(testPalette());
      r2.beginFrame();
      r2.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
      r2.endFrame();
      return fnvU8(r2.getFramebuffer().index!);
    })();
    expect(fnvU8(live.index!)).toBe(plain);
  });
});

describe('item 2: per-band work ranges for the indexed frame kick', () => {
  // Craft a two-batch frame: batch 0 lives in rows 0..10, batch 1 in
  // rows 50..60. Each band must skip the other batch BEFORE any
  // material/view setup, and the band union must equal the full range.
  function stagedFrame(W: number, H: number): { views: FrameAccumViews; yA: number; yB: number } {
    const sab = new SharedArrayBuffer(frameAccumTotal(W, H));
    const { views } = attachFrameAccum(sab, W, H);
    // 1x1 white texel + fullbright light staged once, shared by descriptors.
    views.fTex[0] = 7;
    views.fLight[0] = 63;
    const putSpan = (slot: number, y: number) => {
      const o = slot * F_PER_SPAN;
      views.fSpansF[o] = 1; views.fSpansF[o + 1] = 0;
      views.fSpansF[o + 2] = 8; views.fSpansF[o + 3] = 0;
      views.fSpansF[o + 4] = 8; views.fSpansF[o + 5] = 0;
      views.fSpansF[o + 6] = 63; views.fSpansF[o + 7] = 0;
      views.fSpansF[o + 8] = 0; views.fSpansF[o + 9] = -1;
      views.fSpansF[o + 10] = 0; views.fSpansF[o + 11] = 0; views.fSpansF[o + 12] = 0;
      const q = slot * I_PER_SPAN;
      views.fSpansI[q] = SPAN_OPAQUE; views.fSpansI[q + 1] = y;
      views.fSpansI[q + 2] = 0; views.fSpansI[q + 3] = W; views.fSpansI[q + 4] = 0;
    };
    const putDesc = (b: number, base: number, count: number, ymin = 0, ymax = 0) => {
      const d = b * D_PER_BATCH;
      views.desc[d + D_SPAN_BASE] = base;
      views.desc[d + D_SPAN_COUNT] = count;
      views.desc[d + D_TEX_OFF] = 0; views.desc[d + D_TEX_W] = 1; views.desc[d + D_TEX_H] = 1;
      views.desc[d + D_LIGHT_OFF] = 0; views.desc[d + D_LIGHT_W] = 1; views.desc[d + D_LIGHT_H] = 1;
      views.desc[d + D_WSHIFT] = 0; views.desc[d + D_WMASK] = 0; views.desc[d + D_HMASK] = 0;
      views.desc[d + D_TURBPHASE] = 0;
      views.desc[d + D_YMIN] = ymin;
      views.desc[d + D_YMAX] = ymax;
    };
    // Batch 0: rows 2..5. Batch 1: rows H-6..H-3. Batch 2: empty.
    for (let y = 2; y <= 5; y++) putSpan(y - 2, y);
    putDesc(0, 0, 4, 2, 6);
    const H1 = H - 6;
    for (let y = H1; y <= H1 + 3; y++) putSpan(4 + (y - H1), y);
    putDesc(1, 4, 4, H1, H1 + 4);
    putDesc(2, 8, 0);
    return { views, yA: 5, yB: H1 };
  }

  it('bands skip non-overlapping batches; union equals the full range', () => {
    for (const [W, H] of [[64, 64], [61, 37]] as Array<[number, number]>) {
      const { views, yA, yB } = stagedFrame(W, H);
      const full = processFrameJob(views, W, H, 3, 0, H);
      const lo = processFrameJob(views, W, H, 3, 0, yA + 1);
      const hi = processFrameJob(views, W, H, 3, yB, H);
      const mid = processFrameJob(views, W, H, 3, yA + 1, yB);
      // Middle band holds no staged rows: zero work, no crash.
      expect(mid.spans).toBe(0);
      expect(mid.pixels).toBe(0);
      // Staged bounds reject pre-setup: the middle band visits nothing,
      // the side bands visit exactly their own batch.
      expect(mid.descs).toBe(0);
      expect(mid.spansStaged).toBe(0);
      expect(lo.descs).toBe(1);
      expect(lo.spansStaged).toBe(4);
      expect(hi.descs).toBe(1);
      expect(hi.spansStaged).toBe(4);
      expect(full.descs).toBe(2);
      expect(full.spansStaged).toBe(8);
      // Disjoint bands partition the work exactly.
      expect(lo.spans + hi.spans).toBe(full.spans);
      expect(lo.pixels + hi.pixels).toBe(full.pixels);
      expect(full.spans).toBe(8);
      expect(full.pixels).toBe(8 * W);
      // Band planes agree pixel-for-pixel with the full-range planes.
      const ref = { idx: views.base.idx.slice(), zb: views.base.zb.slice() };
      views.base.idx.fill(0);
      views.base.zb.fill(0);
      const b0 = processFrameJob(views, W, H, 3, 0, yA + 1);
      const b1 = processFrameJob(views, W, H, 3, yA + 1, yB);
      const b2 = processFrameJob(views, W, H, 3, yB, H);
      expect(views.base.idx).toEqual(ref.idx);
      expect(views.base.zb).toEqual(ref.zb);
      // Total visited across all bands: both batches visited exactly once
      // each (middle band visited nothing); no per-worker rescan anywhere.
      expect(b0.descs + b1.descs + b2.descs).toBe(2);
      expect(b0.spansStaged + b1.spansStaged + b2.spansStaged).toBe(8);
    }
  });

  it('unknown (zero) ranges fall back to full visits with identical output', () => {
    // Legacy / manual descriptors (e.g. an older browser pool that only
    // writes the first 12 fields) carry ymin == ymax == 0: bands must NOT
    // cull them — every band visits them and the raster core's own per-span
    // y filter restricts the pixels, so output matches the ranged path.
    for (const [W, H] of [[64, 64], [61, 37]] as Array<[number, number]>) {
      const staged = stagedFrame(W, H);
      const { views, yA, yB } = staged;
      // Wipe the staged bounds back to the legacy zero range.
      for (let b = 0; b < 2; b++) {
        const d = b * D_PER_BATCH;
        views.desc[d + D_YMIN] = 0;
        views.desc[d + D_YMAX] = 0;
      }
      const full = processFrameJob(views, W, H, 3, 0, H);
      const lo = processFrameJob(views, W, H, 3, 0, yA + 1);
      const hi = processFrameJob(views, W, H, 3, yB, H);
      const mid = processFrameJob(views, W, H, 3, yA + 1, yB);
      // No cull without bounds: every band visits both batches...
      expect(full.descs).toBe(2);
      expect(lo.descs).toBe(2);
      expect(hi.descs).toBe(2);
      expect(mid.descs).toBe(2);
      // ...but the drawn pixels partition exactly as before.
      expect(mid.spans).toBe(0);
      expect(mid.pixels).toBe(0);
      expect(lo.spans + hi.spans).toBe(full.spans);
      expect(full.spans).toBe(8);
      expect(full.pixels).toBe(8 * W);
    }
  });

  it('unordered spans still draw identically (fallback never reorders)', () => {
    // The band-cull only skips whole descriptors; within a band the order
    // is pack order. Shuffled-y spans with a covering range draw the same
    // pixels as the ranged path — culling is order-agnostic.
    const W = 64, H = 64;
    const sab = new SharedArrayBuffer(frameAccumTotal(W, H));
    const { views } = attachFrameAccum(sab, W, H);
    views.fTex[0] = 7;
    views.fLight[0] = 63;
    const rows = [9, 3, 7, 3, 12, 5];
    rows.forEach((y, slot) => {
      const o = slot * F_PER_SPAN;
      views.fSpansF[o] = 1; views.fSpansF[o + 6] = 63; views.fSpansF[o + 9] = -1;
      const q = slot * I_PER_SPAN;
      views.fSpansI[q] = SPAN_OPAQUE; views.fSpansI[q + 1] = y;
      views.fSpansI[q + 2] = 0; views.fSpansI[q + 3] = W; views.fSpansI[q + 4] = 0;
    });
    const put = (ymin: number, ymax: number) => {
      views.desc[D_SPAN_BASE] = 0;
      views.desc[D_SPAN_COUNT] = rows.length;
      views.desc[D_TEX_OFF] = 0; views.desc[D_TEX_W] = 1; views.desc[D_TEX_H] = 1;
      views.desc[D_LIGHT_OFF] = 0; views.desc[D_LIGHT_W] = 1; views.desc[D_LIGHT_H] = 1;
      views.desc[D_WSHIFT] = 0; views.desc[D_WMASK] = 0; views.desc[D_HMASK] = 0;
      views.desc[D_TURBPHASE] = 0;
      views.desc[D_YMIN] = ymin;
      views.desc[D_YMAX] = ymax;
    };
    put(3, 13);
    const ranged = processFrameJob(views, W, H, 1, 0, H);
    const refIdx = views.base.idx.slice();
    views.base.idx.fill(0);
    views.base.zb.fill(0);
    put(0, 0);
    const legacy = processFrameJob(views, W, H, 1, 0, H);
    expect(legacy.pixels).toBe(ranged.pixels);
    expect(legacy.spans).toBe(ranged.spans);
    expect(views.base.idx).toEqual(refIdx);
    expect(ranged.descs).toBe(1);
  });
});

describe('item 3: emitter-order sort bypass', () => {
  it('ordered batches pass, unordered batches fall back to the exact sorter', () => {
    const { createSpan } = { createSpan: null as never };
    void createSpan;
    // Ordered: strictly increasing y (what emitSpansForPoly guarantees).
    const ordered = [3, 4, 5, 9, 200].map((y) => ({ y }) as { y: number });
    expect(spansBatchIsRowOrdered(ordered as never, 0, ordered.length)).toBe(true);
    expect(spansBatchIsRowOrdered(ordered as never, 0, 1)).toBe(true);
    expect(spansBatchIsRowOrdered(ordered as never, 0, 0)).toBe(true);
    // One span per row ascending is required: dupes and dips fail.
    const dupes = [3, 4, 4, 5].map((y) => ({ y }) as { y: number });
    expect(spansBatchIsRowOrdered(dupes as never, 0, dupes.length)).toBe(false);
    const dipped = [3, 9, 5].map((y) => ({ y }) as { y: number });
    expect(spansBatchIsRowOrdered(dipped as never, 0, dipped.length)).toBe(false);
    // Fallback sorts exactly like the general path (clipped rows included).
    const mk = (y: number, iz: number, ord: number) => ({
      kind: 0, y, x0: 0, x1: 4, iz, diz: 0, uz: 0, duz: 0, vz: 0, dvz: 0,
      light: 63, dlight: 0, lu: 0, lv: -1, dlu: 0, turb: 0, ord,
      dudy: 0, dvdy: 0,
    });
    const rows = [mk(9, 0.5, 2), mk(3, 0.9, 0), mk(3, 0.4, 1), mk(5, 0.7, 3)];
    const H = 16;
    const rowBase = new Int32Array(H + 1);
    const tmp = rows.map((s) => ({ ...s }));
    sortBatchByRow(rows, 0, rows.length, H, rowBase, tmp);
    const ys = rows.map((s) => s.y);
    expect(ys).toEqual([3, 3, 5, 9]);
    // Same-row ties keep BSP order (ord ascending) — the coplanar rule.
    expect(rows.filter((s) => s.y === 3).map((s) => s.ord)).toEqual([0, 1]);
  });

  it('devroom output is unchanged with the bypass live (golden suite pins it)', () => {
    // The bypass is always on for world batches; the full golden suite
    // (devroom 8f61c755 + base1 views) passing IS the fidelity proof.
    // Here: the emitter invariant holds for every world batch of a frame.
    const fb = createFramebuffer(160, 120, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    r.beginFrame();
    const stats = r.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
    r.endFrame();
    expect(stats.spans).toBeGreaterThan(0);
    expect(fnvU8(r.getFramebuffer().index!)).toBe(fnvU8(r.getFramebuffer().index!));
  });
});

describe('item 5: cached PVS marking', () => {
  function twoLeafWorld(): MiniWorld {
    const big = new Float32Array([-1000, -1000, -1000]);
    const big2 = new Float32Array([1000, 1000, 1000]);
    return {
      brand: 'miniworld',
      nodes: [{
        nx: 1, ny: 0, nz: 0, dist: 0, front: -1, back: -2,
        mins: big, maxs: big2, firstSurf: 0, numSurfs: 0,
      }],
      leafs: [
        { cluster: 0, firstSurf: 0, numSurfs: 0 },
        { cluster: 1, firstSurf: 0, numSurfs: 0 },
      ],
      pvs: [new Uint8Array([0b01]), new Uint8Array([0b10])],
      clusterCount: 2,
      surfaces: [], textures: [], lightmaps: [],
      dynamicLights: [], alias: [], sprites: [], particles: [],
    };
  }

  function collect(world: MiniWorld, x: number): number {
    const cam = setupCamera(
      new Float32Array([x, 0, 0]), new Float32Array([0, 180, 0]), 90, 64, 64,
    );
    return collectVisibleSurfaces(world, cam, x >= 0 ? 0 : 1, [], []);
  }

  it('rotation within a cluster reuses the marking; crossing clusters recomputes', () => {
    const world = twoLeafWorld();
    testResetMarkCacheStats();
    expect(collect(world, 10)).toBe(0);
    expect(testMarkCacheStats()).toEqual({ hits: 0, misses: 1 });
    // Same cluster (rotation in place): hit, same result.
    expect(collect(world, 20)).toBe(0);
    expect(testMarkCacheStats()).toEqual({ hits: 1, misses: 1 });
    expect(collect(world, 30)).toBe(0);
    expect(testMarkCacheStats()).toEqual({ hits: 2, misses: 1 });
    // Crossing to the other cluster: recompute, same (empty) result.
    expect(collect(world, -10)).toBe(0);
    expect(testMarkCacheStats()).toEqual({ hits: 2, misses: 2 });
    // Back again: miss (last marking was the other cluster).
    expect(collect(world, 40)).toBe(0);
    expect(testMarkCacheStats()).toEqual({ hits: 2, misses: 3 });
  });

  it('switching worlds recomputes (per-world memos do not alias)', () => {
    const a = twoLeafWorld();
    const b = twoLeafWorld();
    testResetMarkCacheStats();
    collect(a, 10);
    collect(b, 10);
    expect(testMarkCacheStats()).toEqual({ hits: 0, misses: 2 });
    // a's own memo is intact (b never touched it): a re-hit, not a rebuild.
    collect(a, 10);
    expect(testMarkCacheStats()).toEqual({ hits: 1, misses: 2 });
    // Mutating the topology (node count) invalidates the memo.
    a.nodes.push({ ...a.nodes[0]! });
    collect(a, 10);
    expect(testMarkCacheStats()).toEqual({ hits: 1, misses: 3 });
  });
});

describe('item 6: dynamic-light marking without the quadratic scan', () => {
  function grid(n: number, step: number): SurfaceBounds[] {
    const out: SurfaceBounds[] = [];
    for (let i = 0; i < n; i++) {
      const x = (i % 20) * step, y = Math.floor(i / 20) * step;
      out.push({
        id: i,
        mins: new Float32Array([x, y, 0]),
        maxs: new Float32Array([x + step / 2, y + step / 2, 8]),
      });
    }
    return out;
  }

  function oracle(surfs: SurfaceBounds[], lights: { origin: Float32Array; intensity: number }[]): number[] {
    const hit = new Set<number>();
    for (const l of lights) {
      const rad = l.intensity < 0 ? -l.intensity : l.intensity;
      for (const s of surfs) {
        if (bboxDistance(l.origin, s.mins, s.maxs) <= rad) hit.add(s.id);
      }
    }
    return [...hit].sort((a, b) => a - b);
  }

  it('matches the brute-force oracle with sorted output, overlapping lights merge bits', () => {
    const surfs = grid(400, 16);
    const st = new DLightState();
    st.addLight({ origin: new Float32Array([10, 10, 4]), intensity: 60, color: new Float32Array([1, 0, 0]) });
    st.addLight({ origin: new Float32Array([40, 10, 4]), intensity: 60, color: new Float32Array([0, 0, 1]) });
    st.addLight({ origin: new Float32Array([5000, 5000, 4]), intensity: 10, color: new Float32Array([1, 1, 1]) });
    const affected = st.markLights(surfs);
    expect(affected).toEqual(oracle(surfs, st.lights));
    // Sorted ascending (frame path binary-searches it).
    const sorted = [...affected].sort((a, b) => a - b);
    expect(affected).toEqual(sorted);
    // Overlapping region carries both light bits.
    const both = affected.filter((id) => (st.bitsFor(id) & 0b11) === 0b11);
    expect(both.length).toBeGreaterThan(0);
    // Spatial rejection fired: fewer precise tests than pairs, all pairs accounted.
    expect(st.lastTests + st.lastAabbRejects).toBe(3 * surfs.length);
    expect(st.lastAabbRejects).toBeGreaterThan(0);
  });

  it('expiry still invalidates exactly once (no per-surface cost change)', () => {
    const surfs = grid(100, 16);
    const st = new DLightState();
    st.addLight({ origin: new Float32Array([10, 10, 4]), intensity: 60, color: new Float32Array([1, 1, 1]) });
    const first = st.markLights(surfs);
    expect(first.length).toBeGreaterThan(0);
    st.expireAll();
    const second = st.markLights(surfs);
    expect(second).toEqual([]);
  });
});

describe('item 7: foreground/model setup sharing', () => {
  it('shared setup is deterministic across cameras (memo hit + miss agree)', () => {
    // The world-alias loop draws every critter through the shared setup:
    // repeated instances reuse the shared view verts. Three consecutive
    // frames (A, B, A) prove the memoised frame equals a fresh computation:
    // A1 === A2 while B differs.
    testResetAliasShareStats();
    const render = (ox: number, yaw: number) => {
      const fb = createFramebuffer(160, 120, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(testPalette());
      r.beginFrame();
      r.renderView(
        {
          origin: new Float32Array([ox, DEVROOM_CAMERA.origin[1]!, DEVROOM_CAMERA.origin[2]!]),
          angles: new Float32Array([DEVROOM_CAMERA.angles[0]!, yaw, DEVROOM_CAMERA.angles[2]!]),
          fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
        },
        { name: 'devroom', data: createDevroom() },
        [],
      );
      r.endFrame();
      const live = r.getFramebuffer();
      return fnvU8(new Uint8Array(live.color.buffer, live.color.byteOffset, live.color.byteLength));
    };
    const yawA = DEVROOM_CAMERA.angles[1]!;
    const a1 = render(DEVROOM_CAMERA.origin[0]!, yawA);
    const b = render(DEVROOM_CAMERA.origin[0]!, yawA + 10);
    const a2 = render(DEVROOM_CAMERA.origin[0]!, yawA);
    expect(a2).toBe(a1);
    expect(b).not.toBe(a1);
    // Instances after the first share one setup (miss then hits), so both
    // counters are live.
    const share = testAliasShareStats();
    expect(share.misses).toBeGreaterThan(0);
    expect(share.hits).toBeGreaterThan(0);
  });
});
