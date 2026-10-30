// @q2/webgl-renderer GPU-FOLLOW-3 tests — combined material semantics, warp,
// textured sky, beam blend ordering, cvar gaps.
//
// Box (1) pins the fixed classification (TRANS-first: turbulent+translucent
// water blends AND warps; default-alpha beams ride the blend pass with real
// distance keys) plus beam/glass/translucent-alias overlap at changing
// cameras. Box (2) pins the CPU-mirror warp, the view-centered textured
// skybox, and the explicit unsupported-cvar table. Synthetic fixtures pin
// the rules; Q2_PAK-gated legs drive the SAME rules from real base1
// surfaces/entities (real produced events — retail BSP flags, the frame.ts
// tracer convention, env/unit1_ sky art), because fixtures alone cannot
// close the card.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { listCVars, resetCVars, setCVar } from '@q2/config';
import { loadBsp } from '@q2/bsp';
import { parsePCX, parseWAL } from '@q2/formats';
import {
  bspToMiniWorld,
  buildTurbTable,
  SKY_SIDE_IMAGE,
  SKY_TILE_SUFFIXES,
  translucencyModeFromCvars,
  type BspTexelSource,
  type MiniSurf,
  type MiniWorld,
} from '@q2/sw-renderer';
import type { Entity, GpuFrameInput, GpuSceneInput, RefDef } from '@q2/renderer-api';
import {
  entityBlend,
  fullWorldRefs,
  refreshGpuScene,
  selectGpuScene,
  type GpuEntityModelKind,
} from './scene.js';
import {
  buildFullWorldStore,
  packLightAtlas,
  TRANS33_ALPHA,
  TRANS66_ALPHA,
} from './worldMesh.js';
import {
  APPEARANCE_CVAR_DOC,
  GPU_CVAR_GAPS,
  warpPhaseFor,
  warpTableValue,
  warpUv,
} from './appearance.js';
import { FS_LIT } from './shaders.js';
import { emitSkyBoxFaces, emptyFlatBatch, updateGpuEntities } from './entities.js';
import { WebGLRenderer } from './renderer.js';
import { stubGLFull } from './proof3.test.js';

const W = 640;
const H = 480;

function refDef(origin: [number, number, number], yaw: number, time = 0): RefDef {
  return {
    origin: new Float32Array(origin),
    angles: new Float32Array([0, yaw, 0]),
    fovX: 90,
    time,
    lightStyles: new Float32Array(256).fill(1),
  };
}

function emptyWorld(): MiniWorld {
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [],
    pvs: [],
    clusterCount: 0,
    surfaces: [],
    textures: [],
    lightmaps: [],
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
}

function quadSurf(
  id: number,
  center: [number, number, number],
  fn: [number, number, number],
  extra: Partial<MiniSurf> = {},
): MiniSurf {
  const [cx, cy, cz] = center;
  return {
    id,
    verts: new Float32Array([cx - 1, cy, cz - 1, cx + 1, cy, cz - 1, cx + 1, cy, cz + 1, cx - 1, cy, cz + 1]),
    uvs: new Float32Array([0, 0, 8, 0, 8, 8, 0, 8]),
    lux: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    n: 4,
    texId: 0,
    lightId: id,
    center: new Float32Array(center),
    radius: 2,
    mins: new Float32Array([cx - 1, cy - 1, cz - 1]),
    maxs: new Float32Array([cx + 1, cy + 1, cz + 1]),
    turbulent: false,
    translucent: 0,
    sky: false,
    fn: new Float32Array(fn),
    ...extra,
  };
}

/** Single-leaf world looking +Y (yaw 90): opaque + glass + water + sky. */
function materialWorld(): MiniWorld {
  const w = emptyWorld();
  w.leafs = [{ cluster: 0, firstSurf: 0, numSurfs: 0, faceList: [0, 1, 2, 3] }];
  w.pvs = [new Uint8Array([1])];
  w.clusterCount = 1;
  w.surfaces = [
    quadSurf(0, [0, 100, 0], [0, -1, 0]), // opaque, faces the camera
    quadSurf(1, [0, 140, 0], [0, -1, 0], { translucent: 1 }), // glass TRANS33
    quadSurf(2, [0, 180, 0], [0, -1, 0], { translucent: 2, turbulent: true }), // water TRANS66
    quadSurf(3, [0, 120, 60], [0, 1, 0], { sky: true }), // sky (exempt either way)
  ];
  w.textures = [{ texels: new Uint8Array(64).fill(3), width: 8, height: 8 }];
  w.lightmaps = [0, 1, 2, 3].map(() => ({
    samples: new Uint8Array(12).fill(64),
    luxW: 2, luxH: 2, styles: [0, 255, 255, 255],
  }));
  return w;
}

function rampPalette(): Uint8Array {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    p[i * 3] = i;
    p[i * 3 + 1] = (i * 2) & 255;
    p[i * 3 + 2] = (i * 3) & 255;
  }
  return p;
}

/** Beam (default alpha) + translucent alias + default sprite, tracer convention. */
function overlapEntities(): { entities: Entity[]; kinds: Map<number, GpuEntityModelKind> } {
  const entities: Entity[] = [
    // Tracer: origin = start, angles = direction, frame = length, skin = palette idx.
    { model: 1, origin: new Float32Array([10, 60, 0]), angles: new Float32Array([0, 90, 0]), frame: 96, skin: 231 },
    // Translucent alias (explosion fade).
    { model: 0, origin: new Float32Array([-10, 100, 0]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0, alpha: 0.5 },
    // Default-alpha sprite.
    { model: 2, origin: new Float32Array([5, 80, 10]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0 },
  ];
  return { entities, kinds: new Map<number, GpuEntityModelKind>([[0, 'md2'], [1, 'tracer'], [2, 'sp2']]) };
}

describe('FOLLOW-3 combined material semantics (pure)', () => {
  it('turbulent+translucent water blends AND keeps the warp material', () => {
    const out = selectGpuScene(materialWorld(), [], refDef([0, 0, 0], 90), W, H);
    const water = out.surfaces.find((r) => r.surfaceId === 2)!;
    expect(water).toMatchObject({ material: 'turbulent', transparent: true });
    expect(water.order).toBeGreaterThan(0);
    // The full inventory agrees (storage side, order 0, same class).
    const full = fullWorldRefs(materialWorld()).find((r) => r.surfaceId === 2)!;
    expect(full).toMatchObject({ material: 'turbulent', transparent: true, order: 0 });
    // The store bakes the TRANS66 alpha for the blend pass.
    const styles = new Float32Array(256).fill(1);
    const { atlas } = packLightAtlas(materialWorld(), [0, 1, 2], styles);
    const store = buildFullWorldStore(materialWorld(), atlas);
    const range = store.world.surfaces.get(2)!;
    expect(range.material).toBe('turbulent');
    expect(range.transparent).toBe(true);
    const a0 = store.world.alphas[range.vertStart]!;
    expect(a0).toBeCloseTo(TRANS66_ALPHA, 6);
    const glass = store.world.surfaces.get(1)!;
    expect(store.world.alphas[glass.vertStart]).toBeCloseTo(TRANS33_ALPHA, 6);
  });

  it('sky+translucent follows TRANS-first into the blend pass (never in base1)', () => {
    const w = materialWorld();
    w.surfaces[3] = { ...w.surfaces[3]!, translucent: 1 };
    const out = selectGpuScene(w, [], refDef([0, 0, 0], 90), W, H);
    const sky = out.surfaces.find((r) => r.surfaceId === 3)!;
    expect(sky.transparent).toBe(true);
    expect(sky.material).toBe('transparent');
  });

  it('glass is single-sided like the CPU; water and sky stay double-sided', () => {
    // South camera: glass front (+Y normal faces -Y camera) is kept ...
    const south = selectGpuScene(materialWorld(), [], refDef([0, 0, 0], 90), W, H);
    expect(south.surfaces.some((r) => r.surfaceId === 1)).toBe(true);
    // ... viewed from behind (north camera looking south) it is culled ...
    const north = selectGpuScene(materialWorld(), [], refDef([0, 200, 0], 270), W, H);
    expect(north.surfaces.some((r) => r.surfaceId === 1)).toBe(false);
    // ... while turbulent water and sky read from both sides in both views.
    for (const sel of [south, north]) {
      expect(sel.surfaces.some((r) => r.surfaceId === 2)).toBe(true);
    }
    expect(south.surfaces.some((r) => r.surfaceId === 3)).toBe(true);
  });

  it('default-alpha beams blend with a real distance key (not order 0)', () => {
    const beam: Entity = {
      model: 1, origin: new Float32Array([10, 60, 0]),
      angles: new Float32Array([0, 90, 0]), frame: 96, skin: 231,
    };
    expect(entityBlend(beam, 'tracer')).toBe(true);
    expect(entityBlend(beam, undefined)).toBe(false); // unknown kind + alpha 1: opaque alias
    const kinds = new Map<number, GpuEntityModelKind>([[1, 'tracer']]);
    const out = selectGpuScene(materialWorld(), [beam], refDef([0, 0, 0], 90), W, H, kinds);
    const ref = out.surfaces.find((r) => r.transformIndex === 1)!;
    expect(ref.material).toBe('beam');
    expect(ref.transparent).toBe(true);
    expect(ref.order).toBeCloseTo(Math.sqrt(10 * 10 + 60 * 60), 9);
    // updateGpuEntities agrees (tail helper, same rule).
    const scene: GpuSceneInput = {
      surfaces: [],
      transforms: [new Float32Array(16).fill(0)],
      staticGeneration: 1,
    };
    const tail = updateGpuEntities(scene, [beam], refDef([0, 0, 0], 90), kinds);
    expect(tail.find((r) => r.transformIndex === 1)).toMatchObject({ material: 'beam', transparent: true });
    expect(tail.find((r) => r.transformIndex === 1)!.order).toBeGreaterThan(0);
  });

  it('beam/glass/translucent-alias overlap sorts far->near at changing cameras', () => {
    const { entities, kinds } = overlapEntities();
    const cameras: Array<[number, number, number]> = [
      [0, 0, 0], // south: glass 140 > alias 100 > sprite 80 > beam ~60.8
      [0, 120, 0], // between: glass/water ahead, entities behind
      [0, 220, 0], // north looking back south is yaw 270; keep yaw 90 look-through
    ];
    const orders: number[][] = [];
    for (const origin of cameras) {
      const out = refreshGpuScene(materialWorld(), entities, refDef(origin, 90), W, H, kinds);
      const blend = out.surfaces.filter((r) => r.transparent);
      // Far->near, recomputed per camera (view-dependent keys, never frozen).
      for (let i = 1; i < blend.length; i++) {
        expect(blend[i - 1]!.order, `camera ${origin}`).toBeGreaterThanOrEqual(blend[i]!.order);
      }
      orders.push(blend.map((r) => r.order));
      // Every pass carries the beam with a live key.
      const beam = blend.find((r) => r.material === 'beam')!;
      expect(beam).toBeDefined();
      expect(beam.order).toBeGreaterThan(0);
    }
    // The camera move actually re-sorts (keys are view-dependent).
    expect(JSON.stringify(orders[0])).not.toBe(JSON.stringify(orders[1]));
  });

  it('refreshGpuScene is idempotent: no drops, no dupes, stable slots', () => {
    const { entities, kinds } = overlapEntities();
    const view = refDef([0, 0, 0], 90);
    const a = refreshGpuScene(materialWorld(), entities, view, W, H, kinds);
    const b = refreshGpuScene(materialWorld(), entities, view, W, H, kinds);
    expect(JSON.stringify(a.surfaces)).toBe(JSON.stringify(b.surfaces));
    // Opaque sprite first (surfaceId -3), then the blend tail far->near:
    // translucent alias (-2, order ~100) ahead of the nearer beam (-1).
    // Slots are input-stable: identical sequences across refreshes.
    expect(a.surfaces.filter((r) => r.transformIndex >= 1).map((r) => r.surfaceId)).toEqual([-3, -2, -1]);
    const ids = a.surfaces.map((r) => `${r.transformIndex}:${r.surfaceId}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('FOLLOW-3 warp mirror (pure)', () => {
  it('closed form matches the real turbTable within half a texel', () => {
    const table = buildTurbTable();
    expect(table.length).toBe(1024);
    expect(warpTableValue(0)).toBeCloseTo(16, 9);
    expect(warpTableValue(256)).toBeCloseTo(31, 9);
    expect(warpTableValue(768)).toBeCloseTo(1, 9);
    for (const time of [0, 1.5, 123.456]) {
      const phase = warpPhaseFor(time);
      expect(phase).toBe(((time * 64) | 0) & 1023);
      for (const [u, v] of [[0, 0], [7.5, -3.25], [300.1, 511.9], [-64, -32]] as const) {
        const [wu, wv] = warpUv(u, v, time);
        const pos = (x: number): number => ((x % 1024) + 1024) % 1024;
        const eu = u + table[pos(Math.floor(v) + phase)]!;
        const ev = v + table[pos(Math.floor(u) + phase)]!;
        expect(Math.abs(wu - eu)).toBeLessThanOrEqual(0.5 + 1e-9);
        expect(Math.abs(wv - ev)).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
  });

  it('warp advances with time and freezes at time 0 phase', () => {
    const [a, b] = [warpUv(10, 20, 0), warpUv(10, 20, 1 / 64)];
    expect(warpPhaseFor(0)).toBe(0);
    expect(warpPhaseFor(1 / 64)).toBe(1);
    expect(a).not.toEqual(b); // phase step moves the table index
    expect(warpUv(10, 20, 0)).toEqual(a); // same time, same warp
  });

  it('FS_LIT carries the warp chunk (uniforms + closed-form table)', () => {
    expect(FS_LIT).toContain('uWarpOn');
    expect(FS_LIT).toContain('uTime');
    expect(FS_LIT).toContain('voodooWarp');
    expect(FS_LIT).toContain('16.0 + 15.0 * sin');
  });
});

describe('FOLLOW-3 skybox emitter (pure)', () => {
  it('emits 6 single-face quads with per-face tiles and normalized UVs', () => {
    const b = emptyFlatBatch();
    emitSkyBoxFaces(b, new Float32Array([100, 200, 300]), 16384, 256, 256);
    expect(b.pos.length).toBe(24 * 3);
    expect(b.col.length).toBe(24 * 4);
    expect(b.uv.length).toBe(24 * 2);
    expect(b.idx.length).toBe(36);
    // Every face samples its own strip tile (SKY_SIDE_IMAGE), in-tile.
    for (let face = 0; face < 6; face++) {
      for (let c = 0; c < 4; c++) {
        const v = face * 4 + c;
        const u = b.uv[v * 2]!;
        const vv = b.uv[v * 2 + 1]!;
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThan(1);
        const tile = vv * 6;
        expect(tile).toBeGreaterThanOrEqual(SKY_SIDE_IMAGE[face]!);
        expect(tile).toBeLessThan(SKY_SIDE_IMAGE[face]! + 1);
      }
      // Fullbright white, opaque.
      for (let c = 0; c < 4; c++) {
        const v = face * 4 + c;
        expect(b.col.slice(v * 4, v * 4 + 4)).toEqual([1, 1, 1, 1]);
      }
    }
  });

  it('is view-locked: translating the origin translates the box exactly', () => {
    const a = emptyFlatBatch();
    const c = emptyFlatBatch();
    emitSkyBoxFaces(a, new Float32Array([100, 200, 300]), 16384, 256, 256);
    emitSkyBoxFaces(c, new Float32Array([110, 190, 320]), 16384, 256, 256);
    const d = [10, -10, 20];
    for (let i = 0; i < a.pos.length; i++) {
      expect(c.pos[i]! - a.pos[i]!).toBeCloseTo(d[i % 3]!, 6);
    }
    // UVs are direction-only: identical for both origins.
    expect(c.uv).toEqual(a.uv);
    // Corners sit at +/-half on every axis (id box_verts shape).
    let maxAbs = 0;
    for (let i = 0; i < a.pos.length; i += 3) {
      maxAbs = Math.max(
        maxAbs,
        Math.abs(a.pos[i]! - 100), Math.abs(a.pos[i + 1]! - 200), Math.abs(a.pos[i + 2]! - 300),
      );
    }
    expect(maxAbs).toBe(16384);
  });
});

describe('FOLLOW-3 cvar audit (unsupported choices labelled)', () => {
  it('every vd_* cvar has a documented GPU interpretation', () => {
    const vdNames = listCVars().filter((c) => c.name.startsWith('vd_')).map((c) => c.name);
    expect(vdNames.length).toBeGreaterThan(0);
    const docced = new Set(APPEARANCE_CVAR_DOC.map((d) => d.cvar));
    for (const name of vdNames) expect(docced.has(name), name).toBe(true);
  });

  it('gap table names real cvars and labels every one unsupported', () => {
    expect(GPU_CVAR_GAPS.length).toBeGreaterThanOrEqual(4);
    for (const g of GPU_CVAR_GAPS) {
      expect(g.kind).toBe('policy-note');
      expect(g.note).toMatch(/UNSUPPORTED|NOT READ/);
    }
    const names = GPU_CVAR_GAPS.map((g) => g.cvar);
    for (const n of ['r_translucency', 'sw_stipplealpha', 'r_drawworld', 'sw_gamma']) {
      expect(names).toContain(n);
    }
    // The named cvars exist once lazily registered.
    void translucencyModeFromCvars();
    const all = new Set(listCVars().map((c) => c.name));
    for (const n of ['r_translucency', 'r_drawworld', 'sw_gamma']) expect(all.has(n)).toBe(true);
  });

  it('r_translucency=0 does not change GPU selection (gap is honest)', () => {
    try {
      const before = selectGpuScene(materialWorld(), [], refDef([0, 0, 0], 90), W, H);
      setCVar('r_translucency', 0);
      const after = selectGpuScene(materialWorld(), [], refDef([0, 0, 0], 90), W, H);
      expect(JSON.stringify(after.surfaces)).toBe(JSON.stringify(before.surfaces));
      expect(after.surfaces.some((r) => r.transparent)).toBe(true);
    } finally {
      resetCVars();
    }
  });
});

describe('FOLLOW-3 draw paths (stub GL)', () => {
  it('turbulent draws warp (uWarpOn 1 + uTime), opaque draws do not', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, W, H);
    const world = materialWorld();
    r.attachWorld(world);
    r.setPalette(rampPalette());
    const scene = selectGpuScene(world, [], refDef([0, 0, 0], 90), W, H);
    r.setScene(scene);
    r.setEntities([], undefined);
    r.renderFrame({ view: refDef([0, 0, 0], 90), scene, time: 1.5 });
    expect(state.calls).toContain('uniform1i uWarpOn 1'); // water (opaque? no: blend) + none opaque
    expect(state.calls).toContain('uniform1i uWarpOn 0'); // the opaque wall
    expect(state.calls).toContain('uniform1f uTime 1.5');
    // Warp rides the blend pass too (water is transparent): a uWarpOn 1
    // upload lands inside the blend window.
    const blendOn = state.calls.findIndex((c) => c === 'enable BLEND');
    const blendOff = state.calls.findIndex((c) => c === 'disable BLEND');
    expect(blendOn).toBeGreaterThan(-1);
    expect(state.calls.slice(blendOn, blendOff)).toContain('uniform1i uWarpOn 1');
  });

  it('a default-alpha beam draws ONLY in the blend window (never opaque)', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, W, H);
    const world = emptyWorld();
    r.attachWorld(world);
    r.setPalette(rampPalette());
    r.registerModelData(0, 'tracer', null);
    const kinds = new Map<number, GpuEntityModelKind>([[0, 'tracer']]);
    const beam: Entity = {
      model: 0, origin: new Float32Array([10, 60, 0]),
      angles: new Float32Array([0, 90, 0]), frame: 96, skin: 231,
    };
    const scene = refreshGpuScene(world, [beam], refDef([0, 0, 0], 90), W, H, kinds);
    const ref = scene.surfaces.find((x) => x.transformIndex === 1)!;
    expect(ref.transparent).toBe(true); // fail-before: order-0 opaque tail
    expect(ref.order).toBeGreaterThan(0);
    r.setScene(scene);
    r.setEntities([beam], kinds);
    r.renderFrame({ view: refDef([0, 0, 0], 90), scene, time: 0 });
    const blendOn = state.calls.findIndex((c) => c === 'enable BLEND');
    const blendOff = state.calls.findIndex((c) => c === 'disable BLEND');
    expect(blendOn).toBeGreaterThan(-1);
    const opaqueDraws = state.calls.slice(0, blendOn).filter((c) => c.startsWith('drawElements'));
    const blendDraws = state.calls.slice(blendOn, blendOff).filter((c) => c.startsWith('drawElements'));
    expect(opaqueDraws.length).toBe(0); // empty world: nothing opaque may draw
    expect(blendDraws.length).toBe(1); // exactly the beam quad (2 tris)
  });

  it('textured skybox draws one 36-index box with a strip; fallback draws hulls', () => {
    const mkWorld = (): MiniWorld => {
      const w = emptyWorld();
      w.leafs = [{ cluster: 0, firstSurf: 0, numSurfs: 0, faceList: [0] }];
      w.pvs = [new Uint8Array([1])];
      w.clusterCount = 1;
      w.surfaces = [quadSurf(0, [0, 100, 60], [0, -1, 0], { sky: true })];
      w.textures = [{ texels: new Uint8Array(64).fill(3), width: 8, height: 8 }];
      w.lightmaps = [];
      return w;
    };
    const wire = (strip: boolean): string[] => {
      const state = stubGLFull();
      const r = new WebGLRenderer();
      r.init(state.gl, 64, 48);
      const world = mkWorld();
      r.attachWorld(world);
      r.setPalette(rampPalette());
      if (strip) {
        expect(r.registerSkyStrip(new Uint8Array(8 * 48).fill(7), 8, 8)).toBe(true);
        expect(r.testSkyStrip()).toEqual({ tileW: 8, tileH: 8 });
      }
      const scene = selectGpuScene(world, [], refDef([0, 0, 0], 90), 64, 48);
      expect(scene.surfaces.some((s) => s.material === 'sky')).toBe(true);
      r.setScene(scene);
      r.setEntities([], undefined);
      r.renderFrame({ view: refDef([0, 0, 0], 90), scene, time: 0 });
      return state.calls;
    };
    // Invalid strips are rejected, flat fallback kept.
    {
      const state = stubGLFull();
      const r = new WebGLRenderer();
      r.init(state.gl, 64, 48);
      expect(r.registerSkyStrip(new Uint8Array(10), 8, 8)).toBe(false);
      expect(r.testSkyStrip()).toBeNull();
      expect(r.testWarnings().some((w) => w.includes('registerSkyStrip'))).toBe(true);
    }
    const boxed = wire(true);
    expect(boxed).toContain('drawElements TRIANGLES 36 @0'); // 6 faces x 2 tris
    expect(boxed).toContain('uniform1i uTextured 1');
    const flat = wire(false);
    expect(flat).not.toContain('drawElements TRIANGLES 36 @0');
    expect(flat.filter((c) => c.startsWith('drawElements')).length).toBeGreaterThan(0);
  });
});

// --- Real base1 (Q2_PAK-gated): real produced events -------------------------

function pakReadFile(pakPath: string, name: string): ArrayBuffer {
  const data = readFileSync(pakPath);
  const dirofs = data.readUInt32LE(4);
  const dirlen = data.readUInt32LE(8);
  for (let o = dirofs; o < dirofs + dirlen; o += 64) {
    const entry = data.subarray(o, o + 56).toString().replace(/\0.*$/, '');
    if (entry === name) {
      const off = data.readUInt32LE(o + 56);
      const len = data.readUInt32LE(o + 60);
      return data.buffer.slice(data.byteOffset + off, data.byteOffset + off + len) as ArrayBuffer;
    }
  }
  throw new Error(`pak entry missing: ${name}`);
}

function loadRealWorld(pakPath: string): { world: MiniWorld; palette: Uint8Array } {
  const map = loadBsp(pakReadFile(pakPath, 'maps/base1.bsp'));
  const walCache = new Map<string, BspTexelSource | null>();
  const texelFor = (walName: string): BspTexelSource | null => {
    if (walCache.has(walName)) return walCache.get(walName)!;
    let src: BspTexelSource | null = null;
    try {
      const wal = parseWAL(pakReadFile(pakPath, `textures/${walName}.wal`));
      src = { texels: wal.mips[0] as Uint8Array, width: wal.width, height: wal.height };
    } catch {
      src = null;
    }
    walCache.set(walName, src);
    return src;
  };
  return {
    world: bspToMiniWorld(map, { texelFor }),
    palette: parsePCX(pakReadFile(pakPath, 'pics/colormap.pcx')).palette,
  };
}

function realOverlapEntities(): { entities: Entity[]; kinds: Map<number, GpuEntityModelKind> } {
  return {
    entities: [
      { model: 0, origin: new Float32Array([128, -272, 24]), angles: new Float32Array([0, 270, 0]), frame: 4, skin: 0 },
      { model: 0, origin: new Float32Array([140, -260, 30]), angles: new Float32Array([0, 270, 0]), frame: 2, skin: 0, alpha: 0.5 },
      // Default-alpha tracer (frame.ts contract: origin=start, angles=dir, frame=len, skin=palette idx).
      { model: 1, origin: new Float32Array([128, -300, 40]), angles: new Float32Array([0, 90, 0]), frame: 96, skin: 231 },
      { model: 2, origin: new Float32Array([120, -280, 50]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0 },
    ],
    kinds: new Map<number, GpuEntityModelKind>([[0, 'md2'], [1, 'tracer'], [2, 'sp2']]),
  };
}

/** Camera looking at surface s from its front side (fn rule). */
function faceView(s: MiniSurf): RefDef {
  const ox = s.center[0]! + s.fn[0]! * 80;
  const oy = s.center[1]! + s.fn[1]! * 80;
  const oz = s.center[2]! + s.fn[2]! * 80 + 8;
  const dx = s.center[0]! - ox;
  const dy = s.center[1]! - oy;
  const dz = s.center[2]! - oz;
  const len = Math.hypot(dx, dy, dz) || 1;
  const yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
  const pitch = (-Math.asin(dz / len) * 180) / Math.PI;
  return refDef([ox, oy, oz], yaw, 1.5);
}

describe.runIf(!!process.env.Q2_PAK)('FOLLOW-3 on real base1 (Q2_PAK)', () => {
  it('inventory: 128 sky, 102 turbulent+translucent, 17 glass (retail base1)', { timeout: 180000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const { world } = loadRealWorld(pakPath);
    const refs = fullWorldRefs(world);
    const sky = refs.filter((r) => r.material === 'sky');
    const water = refs.filter((r) => r.material === 'turbulent');
    const glass = refs.filter((r) => r.material === 'transparent');
    expect(sky.length).toBe(128);
    expect(water.length).toBe(102);
    expect(glass.length).toBe(17);
    expect(sky.every((r) => !r.transparent)).toBe(true);
    expect(water.every((r) => r.transparent)).toBe(true);
    expect(glass.every((r) => r.transparent)).toBe(true);
    // Sky keeps the flat handle; glass/water keep their WAL texIds.
    expect(sky.every((r) => r.materialHandle === -1)).toBe(true);
    // Spot-check the CPU flag source for one of each (never trust one layer).
    const byId = new Map(world.surfaces.map((s) => [s.id, s]));
    for (const r of sky.slice(0, 4)) expect(byId.get(r.surfaceId)!.sky).toBe(true);
    for (const r of water.slice(0, 4)) {
      expect(byId.get(r.surfaceId)!.turbulent).toBe(true);
      expect([1, 2]).toContain(byId.get(r.surfaceId)!.translucent);
    }
  });

  it('selection: real water + glass + sky classify, beam blends, order far->near', { timeout: 180000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const { world } = loadRealWorld(pakPath);
    const { entities, kinds } = realOverlapEntities();
    const cameras = [
      refDef([128, -320, 54], 90, 1.5), // F0 spawn-north
      refDef([128, -160, 54], 90, 1.5), // translated up the corridor
      refDef([128, -320, 54], 270, 1.5), // 180-degree turn
    ];
    for (const view of cameras) {
      const out = refreshGpuScene(world, entities, view, W, H, kinds);
      const blend = out.surfaces.filter((r) => r.transparent);
      for (let i = 1; i < blend.length; i++) {
        expect(blend[i - 1]!.order).toBeGreaterThanOrEqual(blend[i]!.order);
      }
      // Default-alpha beam rides the blend pass with a live key in every view.
      const tracerSlot = 3; // entities[2] -> surfaceId -3
      const beam = out.surfaces.find((r) => r.surfaceId === -tracerSlot)!;
      expect(beam.material).toBe('beam');
      expect(beam.transparent).toBe(true);
      expect(beam.order).toBeGreaterThan(0);
      // No drops, no dupes across the re-selection.
      const ids = out.surfaces.map((r) => `${r.transformIndex}:${r.surfaceId}`);
      expect(new Set(ids).size).toBe(ids.length);
    }
    // Targeted water view: a real TRANS66 water face selects as warped blend.
    let waterOk = false;
    for (const s of world.surfaces) {
      if (!s.turbulent || (s.translucent !== 1 && s.translucent !== 2) || s.n < 3) continue;
      const view = faceView(s);
      const sel = selectGpuScene(world, [], view, W, H);
      const hit = sel.surfaces.find((r) => r.surfaceId === s.id);
      if (hit && hit.material === 'turbulent' && hit.transparent && hit.order > 0) {
        waterOk = true;
        break;
      }
      if (waterOk) break;
    }
    expect(waterOk).toBe(true);
    // Targeted sky view: a real sky face selects as sky.
    let skyOk = false;
    for (const s of world.surfaces) {
      if (!s.sky || s.n < 3) continue;
      const view = faceView(s);
      const sel = selectGpuScene(world, [], view, W, H);
      const hit = sel.surfaces.find((r) => r.surfaceId === s.id);
      if (hit && hit.material === 'sky' && !hit.transparent) {
        skyOk = true;
        break;
      }
    }
    expect(skyOk).toBe(true);
  });

  it('textured skybox from real env/unit1_ art draws the box (stub GL)', { timeout: 180000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const { world, palette } = loadRealWorld(pakPath);
    // Pack the strip in SKY_TILE_SUFFIXES order from real palette art.
    const tiles = SKY_TILE_SUFFIXES.map((suf) => {
      const pcx = parsePCX(pakReadFile(pakPath, `env/unit1_${suf}.pcx`));
      return pcx;
    });
    const tileW = tiles[0]!.width;
    const tileH = tiles[0]!.height;
    for (const t of tiles) {
      expect(t.width).toBe(tileW);
      expect(t.height).toBe(tileH);
    }
    const strip = new Uint8Array(tileW * tileH * 6);
    tiles.forEach((t, i) => strip.set(t.pixels, i * tileW * tileH));
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, W, H);
    expect(r.registerSkyStrip(strip, tileW, tileH)).toBe(true);
    r.attachWorld(world);
    r.setPalette(palette);
    const { entities, kinds } = realOverlapEntities();
    // Sky is visible from the turned spawn view (2 sky refs; the F0
    // spawn-north view has none — probed, not assumed).
    const view = refDef([128, -320, 54], 270, 1.5);
    const scene = refreshGpuScene(world, entities, view, W, H, kinds);
    expect(scene.surfaces.some((r) => r.material === 'sky')).toBe(true);
    r.setScene(scene);
    r.setEntities(entities, kinds);
    r.renderFrame({ view, scene, time: 1.5 });
    // The view-centered box (6 faces x 2 tris) draws textured in the sky pass.
    expect(state.calls).toContain('drawElements TRIANGLES 36 @0');
    expect(state.calls).toContain('uniform1i uTextured 1');
    // No upload GL errors on the supported route (real WALs + real skins absent
    // here ride white-fallback warnings, never silent origin reads).
    expect(r.testWarnings().filter((w) => w.startsWith('texture upload')).length).toBe(0);
    expect(r.getStatus().framesSubmitted).toBe(1);
  });
});

describe.runIf(!process.env.Q2_PAK)('FOLLOW-3 real base1 (no Q2_PAK)', () => {
  it('skips the real-base1 legs gracefully', () => {
    console.log('FOLLOW-3 real-base1 skipped: Q2_PAK absent');
  });
});
