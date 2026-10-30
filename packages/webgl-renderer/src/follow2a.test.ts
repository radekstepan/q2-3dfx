// @q2/webgl-renderer FOLLOW-2A tests — asset registration replay robustness.
//
// Defect (BRAIN.md review at f05e0ba): apps/web applyRendererCvar attaches
// world/palette WITHOUT models/skins on CPU→GPU switch, so drawAlias warns
// and skips every enemy until reboot. The renderer side of the repair:
// registration must be idempotent for same-handle replay (overwrite + drop
// the GL cache entry, preserve kind), missing/invalid data must record
// explicit handle-context warnings (never crash, never silent), and the
// draw path must distinguish missing-asset (warn + skip) from absent
// entity/occlusion (never reaches drawAlias).
//
// Hermetic legs always run (box mesh + synthetic skins); the real-MD2/PCX leg
// is Q2_PAK-gated (soldier + viewmodel + infantry).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { parseMD2, parsePCX } from '@q2/formats';
import { createBoxMesh, type MiniWorld } from '@q2/sw-renderer';
import type { Entity, GpuFrameInput, GpuSceneInput } from '@q2/renderer-api';
import { selectGpuScene, type GpuEntityModelKind } from './scene.js';
import { WebGLRenderer } from './renderer.js';
import { stubGLFull } from './proof3.test.js';

const W = 64;
const H = 48;

function rampPalette(): Uint8Array {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    p[i * 3] = i;
    p[i * 3 + 1] = (i * 2) & 255;
    p[i * 3 + 2] = (i * 3) & 255;
  }
  return p;
}

function quadSurf(
  id: number, cx: number, texId: number,
): MiniWorld['surfaces'][number] {
  return {
    id,
    verts: new Float32Array([cx - 1, -1, 0, cx + 1, -1, 0, cx + 1, 1, 0, cx - 1, 1, 0]),
    uvs: new Float32Array([0, 0, 8, 0, 8, 8, 0, 8]),
    lux: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    n: 4,
    texId,
    lightId: id,
    center: new Float32Array([cx, 0, 0]),
    radius: 2,
    mins: new Float32Array([cx - 1, -1, 0]),
    maxs: new Float32Array([cx + 1, 1, 0]),
    turbulent: false,
    translucent: 0,
    sky: false,
    fn: new Float32Array([0, 0, 1]),
  };
}

/** Minimal opaque world so renderFrame takes the full static+draw path. */
function fixtureWorld(): MiniWorld {
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 2, faceList: [0, 1] }],
    pvs: [new Uint8Array([1])],
    clusterCount: 1,
    surfaces: [quadSurf(0, 50, 0), quadSurf(1, 60, 1)],
    textures: [
      { texels: new Uint8Array(8 * 8).fill(7), width: 8, height: 8 },
      { texels: new Uint8Array(8 * 8).fill(9), width: 8, height: 8 },
    ],
    lightmaps: [0, 1].map(() => ({
      samples: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]),
      luxW: 2, luxH: 2, styles: [0, 255, 255, 255],
    })),
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
}

function fixtureView(): GpuFrameInput['view'] {
  return {
    origin: new Float32Array([0, 0, 0]),
    angles: new Float32Array([0, 90, 0]),
    fovX: 90,
    time: 0,
    lightStyles: new Float32Array(256).fill(1),
  };
}

/** Soldier(0) + viewmodel(3) + second md2(2), tracer(1)/sp2(4) null by design. */
function registerFullRoster(r: WebGLRenderer): void {
  const box = createBoxMesh();
  r.registerModelData(0, 'md2', box);
  r.registerModelData(1, 'tracer', null);
  r.registerModelData(3, 'md2', box);
  r.registerModelData(2, 'md2', box);
  r.registerModelData(4, 'sp2', null);
  r.registerSkinPixels(0, new Uint8Array(8 * 8).fill(11), 8, 8);
  r.registerSkinPixels(1, new Uint8Array(8 * 8).fill(12), 8, 8);
  r.registerSkinPixels(2, new Uint8Array(8 * 8).fill(13), 8, 8);
}

function rosterKinds(): Map<number, GpuEntityModelKind> {
  return new Map<number, GpuEntityModelKind>([
    [0, 'md2'], [1, 'tracer'], [2, 'md2'], [3, 'md2'], [4, 'sp2'],
  ]);
}

function rosterEntities(): Entity[] {
  return [
    { model: 0, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0 },
    { model: 2, origin: new Float32Array([52, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 2 },
    { model: 3, origin: new Float32Array([2, 0, 0]), angles: new Float32Array([0, 90, 0]), frame: 1, skin: 1, depthHack: true },
  ];
}

function drawCount(state: { calls: string[] }): number {
  return state.calls.filter((c) => c.startsWith('drawElements')).length;
}

describe('FOLLOW-2A asset registration replay (stub GL, hermetic)', () => {
  it('registers soldier + viewmodel + second model/skin: registry complete, draws execute', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, W, H);
    r.attachWorld(fixtureWorld());
    r.setPalette(rampPalette());
    registerFullRoster(r);

    // Registry completeness + preserved kinds (web/testkit observability).
    expect(r.testRegisteredModels()).toEqual([0, 1, 2, 3, 4]);
    expect(r.testRegisteredSkins()).toEqual([0, 1, 2]);
    expect(r.testModelKind(0)).toBe('md2');
    expect(r.testModelKind(1)).toBe('tracer');
    expect(r.testModelKind(2)).toBe('md2');
    expect(r.testModelKind(3)).toBe('md2');
    expect(r.testModelKind(4)).toBe('sp2');
    expect(r.testModelKind(99)).toBe(null);

    // Null tracer/sp2 data is by design: no missing-mesh warnings for them.
    const entities = rosterEntities();
    const kinds = rosterKinds();
    const scene = selectGpuScene(fixtureWorld(), entities, fixtureView(), W, H, kinds);
    r.setScene(scene);
    r.setEntities(entities, kinds);
    expect(() => r.renderFrame({ view: fixtureView(), scene, time: 0 })).not.toThrow();
    expect(drawCount(state)).toBeGreaterThan(0);
    expect(r.getStatus().framesSubmitted).toBe(1);
    expect(r.testWarnings().some((w) => w.includes('no mesh'))).toBe(false);
    expect(r.testWarnings().some((w) => w.includes('missing'))).toBe(false);
  });

  it('re-registering same handles (hot-swap replay) preserves completeness without duplicate GL resources', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, W, H);
    const world = fixtureWorld();
    r.attachWorld(world);
    r.setPalette(rampPalette());
    registerFullRoster(r);
    const entities = rosterEntities();
    const kinds = rosterKinds();
    const scene = selectGpuScene(world, entities, fixtureView(), W, H, kinds);
    r.setScene(scene);
    r.setEntities(entities, kinds);
    r.renderFrame({ view: fixtureView(), scene, time: 0 });
    const drawsFirst = drawCount(state);
    expect(drawsFirst).toBeGreaterThan(0);
    const cacheFirst = r.testModelCacheSize();
    expect(cacheFirst).toBe(3); // soldier(0) + second md2(2) opaque, gun(3) gun pass
    const warningsFirst = r.testWarnings().length;

    // Hot-swap replay: same handles, same data, same kinds (mirrors
    // GpuAssetSink re-registration on CPU→GPU switch).
    registerFullRoster(r);
    expect(r.testRegisteredModels()).toEqual([0, 1, 2, 3, 4]);
    expect(r.testRegisteredSkins()).toEqual([0, 1, 2]);
    for (const [h, k] of kinds) expect(r.testModelKind(h)).toBe(k);

    r.renderFrame({ view: fixtureView(), scene, time: 0 });
    expect(drawCount(state)).toBeGreaterThan(drawsFirst);
    // Exactly one GL cache entry per drawn md2 handle — replay rebuilds in
    // place instead of accumulating duplicates.
    expect(r.testModelCacheSize()).toBe(cacheFirst);
    // Replay of valid data adds no warnings.
    expect(r.testWarnings().length).toBe(warningsFirst);
    expect(r.getStatus().framesSubmitted).toBe(2);
  });

  it('invalid skin dims records a handle-context warning, never silent', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, W, H);
    // Length mismatch: claims 8x8, carries 10 texels.
    r.registerSkinPixels(9, new Uint8Array(10).fill(3), 8, 8);
    // Degenerate dims.
    r.registerSkinPixels(10, new Uint8Array(0), 0, 0);
    const warnings = r.testWarnings();
    const w9 = warnings.find((w) => w.includes('handle 9'));
    expect(w9).toBeDefined();
    expect(w9).toContain('8x8');
    expect(warnings.find((w) => w.includes('handle 10'))).toBeDefined();
    // Invalid skins never enter the registry ...
    expect(r.testRegisteredSkins()).toEqual([]);
    // ... so an entity using one draws the white fallback with its own
    // handle-context warning, never a crash.
    r.attachWorld(fixtureWorld());
    r.setPalette(rampPalette());
    r.registerModelData(0, 'md2', createBoxMesh());
    const entities: Entity[] = [
      { model: 0, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 9 },
    ];
    const kinds = new Map<number, GpuEntityModelKind>([[0, 'md2']]);
    const scene = selectGpuScene(fixtureWorld(), entities, fixtureView(), W, H, kinds);
    r.setScene(scene);
    r.setEntities(entities, kinds);
    expect(() => r.renderFrame({ view: fixtureView(), scene, time: 0 })).not.toThrow();
    expect(r.testWarnings().some((w) => w.includes('skin 9'))).toBe(true);
    expect(r.getStatus().framesSubmitted).toBe(1);
  });

  it('missing mesh draw records a handle warning, never a crash', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, W, H);
    r.attachWorld(fixtureWorld());
    r.setPalette(rampPalette());
    // md2 handle with null data: registration warns with handle/kind context.
    r.registerModelData(5, 'md2', null);
    expect(r.testRegisteredModels()).toEqual([5]);
    expect(r.testModelKind(5)).toBe('md2');
    expect(r.testWarnings().some((w) => w.includes('model 5') && w.includes('md2'))).toBe(true);

    // The entity exists and is submitted (not occluded/absent) but mesh-less:
    // the draw path warns with the handle and skips — frames still submit.
    const entities: Entity[] = [
      { model: 5, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0 },
    ];
    const kinds = new Map<number, GpuEntityModelKind>([[5, 'md2']]);
    const scene = selectGpuScene(fixtureWorld(), entities, fixtureView(), W, H, kinds);
    r.setScene(scene);
    r.setEntities(entities, kinds);
    expect(() => r.renderFrame({ view: fixtureView(), scene, time: 0 })).not.toThrow();
    expect(r.getStatus().framesSubmitted).toBe(1);
    expect(r.testWarnings().some((w) => w.includes('model 5') && w.includes('skipped'))).toBe(true);
    void state;
  });

  it('invalid handles/kinds are ignored with context, never crash', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, W, H);
    r.registerModelData(-1, 'md2', createBoxMesh());
    r.registerModelData(3.5, 'md2', createBoxMesh());
    r.registerModelData(6, 'bogus' as GpuEntityModelKind, createBoxMesh());
    expect(r.testRegisteredModels()).toEqual([]);
    expect(r.testWarnings().some((w) => w.includes('-1'))).toBe(true);
    expect(r.testWarnings().some((w) => w.includes('bogus') && w.includes('handle 6'))).toBe(true);
    void state;
  });
});

// --- Real assets (Q2_PAK-gated): soldier + viewmodel + infantry ------------

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

describe.runIf(!!process.env.Q2_PAK)('FOLLOW-2A real soldier/viewmodel/infantry (Q2_PAK)', () => {
  it('registers real MD2/PCX roster, replays it, and draws without missing-mesh warnings', { timeout: 180000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const soldierMd2 = parseMD2(pakReadFile(pakPath, 'models/monsters/soldier/tris.md2'));
    const soldierSkin = parsePCX(pakReadFile(pakPath, 'models/monsters/soldier/skin.pcx'));
    const gunMd2 = parseMD2(pakReadFile(pakPath, 'models/weapons/v_blast/tris.md2'));
    const gunSkin = parsePCX(pakReadFile(pakPath, 'models/weapons/v_blast/skin.pcx'));
    const infantryMd2 = parseMD2(pakReadFile(pakPath, 'models/monsters/infantry/tris.md2'));
    const infantrySkin = parsePCX(pakReadFile(pakPath, 'models/monsters/infantry/skin.pcx'));

    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, 640, 480);
    const world = fixtureWorld();
    r.attachWorld(world);
    r.setPalette(rampPalette());

    const register = (): void => {
      r.registerModelData(0, 'md2', soldierMd2);
      r.registerModelData(2, 'md2', infantryMd2);
      r.registerModelData(3, 'md2', gunMd2);
      r.registerSkinPixels(0, soldierSkin.pixels, soldierSkin.width, soldierSkin.height);
      r.registerSkinPixels(1, gunSkin.pixels, gunSkin.width, gunSkin.height);
      r.registerSkinPixels(2, infantrySkin.pixels, infantrySkin.width, infantrySkin.height);
    };
    register();
    expect(r.testRegisteredModels()).toEqual([0, 2, 3]);
    expect(r.testRegisteredSkins()).toEqual([0, 1, 2]);
    expect(r.testModelKind(0)).toBe('md2');
    expect(r.testModelKind(2)).toBe('md2');

    // Hot-swap replay: same handles again — completeness + kinds preserved.
    register();
    expect(r.testRegisteredModels()).toEqual([0, 2, 3]);
    expect(r.testRegisteredSkins()).toEqual([0, 1, 2]);

    // Soldier + infantry + depth-hacked gun all execute real draws.
    const entities: Entity[] = [
      { model: 0, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 270, 0]), frame: 4, skin: 0 },
      { model: 2, origin: new Float32Array([52, 0, -10]), angles: new Float32Array([0, 270, 0]), frame: 0, skin: 2 },
      { model: 3, origin: new Float32Array([2, 0, 0]), angles: new Float32Array([0, 90, 0]), frame: 1, skin: 1, depthHack: true },
    ];
    const kinds = new Map<number, GpuEntityModelKind>([[0, 'md2'], [2, 'md2'], [3, 'md2']]);
    const scene = selectGpuScene(world, entities, fixtureView(), 640, 480, kinds);
    r.setScene(scene);
    r.setEntities(entities, kinds);
    expect(() => r.renderFrame({ view: fixtureView(), scene, time: 0 })).not.toThrow();
    expect(drawCount(state)).toBeGreaterThan(0);
    expect(r.getStatus().framesSubmitted).toBe(1);
    expect(r.testWarnings().some((w) => w.includes('no mesh'))).toBe(false);
    expect(r.testWarnings().some((w) => w.includes('model 0'))).toBe(false);
    expect(r.testWarnings().some((w) => w.includes('model 2'))).toBe(false);
    expect(r.testWarnings().some((w) => w.includes('model 3'))).toBe(false);
    console.log(
      `FOLLOW-2A real roster: models=${JSON.stringify(r.testRegisteredModels())} ` +
        `skins=${JSON.stringify(r.testRegisteredSkins())} draws=${drawCount(state)}`,
    );
  });
});
