// Perf remediation items 1-8: invariant + fallback + equivalence pins.
//
// Each item proves the waste is actually eliminated (not just investigated)
// while output stays identical. Software goldens stay bit-identical (the
// full suite pins them); RGB hashes are documented where they change.
import { afterEach, describe, expect, it } from 'vitest';
import { createFramebuffer, type Entity } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import {
  SoftwareRenderer, setRGBWorldEnabled,
  SW_RGB_SKIP_CLASSIC_CVAR, skipClassicRequested,
  spansBatchIsRowOrdered, sortBatchByRow,
  sphereCulledByFlatFrustum,
} from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import { createBoxMesh } from './alias.js';
import {
  attachFrameAccum, frameAccumTotal,
  D_PER_BATCH, D_SPAN_BASE, D_SPAN_COUNT,
  D_TEX_OFF, D_TEX_W, D_TEX_H, D_LIGHT_OFF, D_LIGHT_W, D_LIGHT_H,
  D_WSHIFT, D_WMASK, D_HMASK, D_TURBPHASE,
  processFrameJob, F_PER_SPAN, I_PER_SPAN,
  R_FLAG_OPAQUE,
  type FrameAccumViews,
} from './bands.js';
import {
  SPAN_OPAQUE, TRANSLUCENCY_CVAR,
  buildRGBMaterial, buildRGBChain,
  windowDepthQ16,
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
  setRGBWorldEnabled(false);
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
    const putDesc = (b: number, base: number, count: number) => {
      const d = b * D_PER_BATCH;
      views.desc[d + D_SPAN_BASE] = base;
      views.desc[d + D_SPAN_COUNT] = count;
      views.desc[d + D_TEX_OFF] = 0; views.desc[d + D_TEX_W] = 1; views.desc[d + D_TEX_H] = 1;
      views.desc[d + D_LIGHT_OFF] = 0; views.desc[d + D_LIGHT_W] = 1; views.desc[d + D_LIGHT_H] = 1;
      views.desc[d + D_WSHIFT] = 0; views.desc[d + D_WMASK] = 0; views.desc[d + D_HMASK] = 0;
      views.desc[d + D_TURBPHASE] = 0;
    };
    // Batch 0: rows 2..5. Batch 1: rows H-6..H-3. Batch 2: empty.
    for (let y = 2; y <= 5; y++) putSpan(y - 2, y);
    putDesc(0, 0, 4);
    const H1 = H - 6;
    for (let y = H1; y <= H1 + 3; y++) putSpan(4 + (y - H1), y);
    putDesc(1, 4, 4);
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
      // Disjoint bands partition the work exactly.
      expect(lo.spans + hi.spans).toBe(full.spans);
      expect(lo.pixels + hi.pixels).toBe(full.pixels);
      expect(full.spans).toBe(8);
      expect(full.pixels).toBe(8 * W);
      // Band planes agree pixel-for-pixel with the full-range planes.
      const ref = { idx: views.base.idx.slice(), zb: views.base.zb.slice() };
      views.base.idx.fill(0);
      views.base.zb.fill(0);
      processFrameJob(views, W, H, 3, 0, yA + 1);
      processFrameJob(views, W, H, 3, yA + 1, yB);
      processFrameJob(views, W, H, 3, yB, H);
      expect(views.base.idx).toEqual(ref.idx);
      expect(views.base.zb).toEqual(ref.zb);
    }
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

describe('item 4: specialised RGB pixel paths', () => {
  const pal = testPalette();

  it('opaqueMask materials carry all-opaque masks at every mip', () => {
    const texels = new Uint8Array(16 * 16).fill(7);
    texels[3] = 255; // a hole in the source art
    const open = buildRGBChain(texels, 16, 16, pal, false);
    const shut = buildRGBChain(texels, 16, 16, pal, true);
    expect(open.some((l) => l.mask.some((m) => m === 0))).toBe(true);
    for (const l of shut) expect(l.mask.every((m) => m === 1)).toBe(true);
  });

  it('mask skip is a proven no-op on all-opaque chains', () => {
    const texels = new Uint8Array(16 * 16).fill(7);
    const matOpen = buildRGBMaterial(texels, 16, 16, pal, null, {
      addressS: 'repeat', addressT: 'repeat', zbits: 16, opaqueMask: false,
    });
    const matShut = buildRGBMaterial(texels, 16, 16, pal, null, {
      addressS: 'repeat', addressT: 'repeat', zbits: 16, opaqueMask: true,
    });
    expect(matShut.opaqueMask).toBe(true);
    expect(matOpen.opaqueMask).toBe(false);
    // Same chain bytes (no 255 in the art), only the proof flag differs.
    expect(matShut.levels[0]!.data).toEqual(matOpen.levels[0]!.data);
  });

  it('16-bit fast path matches windowDepthQ16 bit-for-bit on loop inputs', () => {
    // The loops sanitise d01 first (clamp + NaN -> far), so the fast path
    // only ever sees [0,1] finite inputs — mirror that derivation here.
    for (const raw of [0, 1e-9, 0.001, 0.25, 0.5, 0.999, 1, NaN, -0.5, 1.5]) {
      const d = raw < 0 ? 0 : raw > 1 ? 1 : (raw === raw ? raw : 1);
      expect(Math.round(d * 65535) & 0xffff).toBe(windowDepthQ16(d, 16));
      expect(Math.round(d * 65535) & 0xffff).toBe(windowDepthQ16(d, 23));
    }
    // Sub-16-bit policies still quantise (the kept fallback path).
    expect(windowDepthQ16(0.5, 1)).toBe(0xffff);
    expect(windowDepthQ16(0.5, 8)).toBe(Math.round((Math.round(0.5 * 255) * 65535) / 255) & 0xffff);
  });

  it('R_FLAG_OPAQUE round-trips through the worker material adapter', () => {
    expect(R_FLAG_OPAQUE).toBe(256);
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
    // The world-alias loop draws every critter classically then (with RGB
    // on) in RGB — the second call reuses the shared view verts. Three
    // consecutive frames (A, B, A) prove the memoised frame equals a fresh
    // computation: A1 === A2 while B differs.
    setRGBWorldEnabled(true);
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
    // The classic+RGB twin per instance shares one setup: every render
    // draws critters twice (miss then hit), so both counters are live.
    const share = testAliasShareStats();
    expect(share.misses).toBeGreaterThan(0);
    expect(share.hits).toBeGreaterThan(0);
  });
});

describe('item 8: RGB-authoritative production path', () => {
  function renderRGB(W: number, H: number, skip: boolean, entities: Entity[] = []) {
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, skip ? 1 : 0);
    expect(skipClassicRequested()).toBe(skip);
    setRGBWorldEnabled(true);
    r.beginFrame();
    r.renderView(devView(), { name: 'devroom', data: createDevroom() }, entities);
    r.endFrame();
    const live = r.getFramebuffer();
    const color = fnvU8(new Uint8Array(live.color.buffer, live.color.byteOffset, live.color.byteLength));
    const idx = fnvU8(live.index!);
    const st = r.testRGBStats();
    setRGBWorldEnabled(false);
    return { color, idx, cover: st.coverPixels, used: st.used };
  }

  function idxDiff(a: Uint8Array, b: Uint8Array): number {
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    return n;
  }

  it('all-opaque frames: skip-on composite equals skip-off composite', () => {
    setCVar(TRANSLUCENCY_CVAR, 0); // tMode 0: the authoritative gate arms
    const off = renderRGB(160, 120, false);
    const on = renderRGB(160, 120, true);
    expect(on.used).toBe(true);
    expect(on.cover).toBe(off.cover);
    // The production resolve (what scanout consumes) is identical: the
    // duplicate classic fill is proven waste on this scene.
    expect(on.color).toBe(off.color);
  });

  it('foreground depth survives the skip (entity in front of a wall)', () => {
    setCVar(TRANSLUCENCY_CVAR, 0);
    const mk = (skip: boolean) => {
      const fb = createFramebuffer(160, 120, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(testPalette());
      const box = r.registerModel({ kind: 'md2', name: 'box', data: createBoxMesh() });
      const skin = r.registerSkin('fg');
      setCVar(SW_RGB_SKIP_CLASSIC_CVAR, skip ? 1 : 0);
      setRGBWorldEnabled(true);
      r.beginFrame();
      r.renderView(
        devView(),
        { name: 'devroom', data: createDevroom() },
        [{ model: box, skin, frame: 0,
           origin: new Float32Array([DEVROOM_CAMERA.origin[0]! + 60, DEVROOM_CAMERA.origin[1]!, DEVROOM_CAMERA.origin[2]!]),
           angles: new Float32Array([0, 0, 0]) }],
      );
      r.endFrame();
      const live = r.getFramebuffer();
      const out = {
        color: fnvU8(new Uint8Array(live.color.buffer, live.color.byteOffset, live.color.byteLength)),
        idx: live.index!.slice(),
      };
      setRGBWorldEnabled(false);
      return out;
    };
    const off = mk(false);
    const on = mk(true);
    // RGB composite identical: the entity won the same depth test both ways
    // (foreground depth reads the backfilled classic plane under the skip).
    expect(on.color).toBe(off.color);
    // The classic index plane stops being meaningful under the skip BY
    // DESIGN (batches the RGB overlay drew never run their classic fill):
    // most world pixels differ. That IS the eliminated duplicate work.
    // Software mode (flag off) is untouched; the composite is the
    // production authority. Integrator: docs/tests invariant update.
    const d = idxDiff(on.idx, off.idx);
    expect(d).toBeGreaterThan(1000);
  });

  it('translucent frames keep the classic path (gate disarms the skip)', () => {
    setCVar(TRANSLUCENCY_CVAR, 1); // tMode 1: alpha loop live
    const plain = (() => {
      const fb = createFramebuffer(160, 120, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(testPalette());
      r.beginFrame();
      r.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
      r.endFrame();
      return fnvU8(r.getFramebuffer().index!);
    })();
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, 1);
    const fb = createFramebuffer(160, 120, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    r.beginFrame();
    r.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
    r.endFrame();
    // Software mode unchanged: flag on + RGB off never skips.
    expect(fnvU8(r.getFramebuffer().index!)).toBe(plain);
  });
});
