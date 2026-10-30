// @q2/webgl-renderer worldMesh tests — pure batch/atlas/texture builders.

import { describe, expect, it } from 'vitest';
import type { GpuSurfaceRef } from '@q2/renderer-api';
import type { MiniWorld } from '@q2/sw-renderer';
import {
  buildTexturedWorldBatches,
  expandPaletteTexture,
  packLightAtlas,
  pickSkyPaletteIndex,
  styleSignature,
  TRANS33_ALPHA,
  TRANS66_ALPHA,
} from './worldMesh.js';

function quadSurf(id: number, texId: number, extra: Partial<MiniWorld['surfaces'][number]> = {}): MiniWorld['surfaces'][number] {
  return {
    id,
    verts: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    uvs: new Float32Array([0, 0, 64, 0, 64, 64, 0, 64]),
    lux: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    n: 4,
    texId,
    lightId: id,
    center: new Float32Array([0, 0, 0]),
    radius: 2,
    mins: new Float32Array([-1, -1, 0]),
    maxs: new Float32Array([1, 1, 0]),
    turbulent: false,
    translucent: 0,
    sky: false,
    fn: new Float32Array([0, 0, 1]),
    ...extra,
  };
}

function testWorld(): MiniWorld {
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [],
    pvs: [],
    clusterCount: 0,
    surfaces: [
      quadSurf(0, 0),
      quadSurf(1, 0, { translucent: 1 }),
      quadSurf(2, 1, { translucent: 2 }),
      quadSurf(3, 0, { sky: true }),
    ],
    textures: [
      { texels: new Uint8Array(64 * 64), width: 64, height: 64 },
      { texels: new Uint8Array(32 * 32), width: 32, height: 32 },
    ],
    lightmaps: [
      { samples: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]), luxW: 2, luxH: 2, styles: [0, 255, 255, 255] },
      { samples: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), luxW: 2, luxH: 2, styles: [0, 255, 255, 255] },
      { samples: new Uint8Array([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]), luxW: 2, luxH: 2, styles: [0, 255, 255, 255] },
      { samples: new Uint8Array([0, 0, 0]), luxW: 1, luxH: 1, styles: [0, 0, 0, 0] },
    ],
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
}

function ref(surfaceId: number, material: GpuSurfaceRef['material'], transparent: boolean, order: number): GpuSurfaceRef {
  return { surfaceId, material, materialHandle: 0, transparent, order, transformIndex: 0 };
}

describe('proof-3 worldMesh (pure)', () => {
  it('packs the lightmap atlas with style scaling baked', () => {
    const world = testWorld();
    const styles = new Float32Array(256).fill(0);
    styles[0] = 2; // overbright-ish style value doubles the block
    const { atlas, skipped } = packLightAtlas(world, [0, 1], styles);
    expect(skipped).toEqual([]);
    expect(atlas.rectOf.size).toBe(2);
    for (const [, r] of atlas.rectOf) {
      expect(r.x + r.w).toBeLessThanOrEqual(atlas.width);
      expect(r.y + r.h).toBeLessThanOrEqual(atlas.height);
    }
    const r0 = atlas.rectOf.get(0)!;
    // First luxel of surface 0 (10,20,30) scaled by 2, clamped.
    const o = (r0.y * atlas.width + r0.x) * 3;
    expect(atlas.pixels[o]).toBe(20);
    expect(atlas.pixels[o + 1]).toBe(40);
    expect(atlas.pixels[o + 2]).toBe(60);
    // Flat styles hash: identical arrays -> identical signatures.
    expect(styleSignature(styles)).toBe(styleSignature(styles.slice()));
    expect(styleSignature(new Float32Array(256).fill(1))).not.toBe(styleSignature(styles));
  });

  it('builds opaque-per-texId batches, transparent in scene order, sky aside', () => {
    const world = testWorld();
    const styles = new Float32Array(256).fill(1);
    const { atlas } = packLightAtlas(world, [0, 1, 2], styles);
    const refs = [
      ref(0, 'opaque', false, 0),
      ref(1, 'transparent', true, 200),
      ref(2, 'transparent', true, 100),
      ref(3, 'sky', false, 0),
    ];
    const { opaque, transparent, sky } = buildTexturedWorldBatches(world, refs, atlas);
    expect(opaque).toHaveLength(1);
    expect(opaque[0]!.texId).toBe(0);
    expect(opaque[0]!.indices.length).toBe(6); // one quad fan
    expect(transparent).toHaveLength(2); // different texIds: no merge
    expect(transparent[0]!.alphas[0]).toBeCloseTo(TRANS33_ALPHA, 9);
    expect(transparent[1]!.alphas[0]).toBeCloseTo(TRANS66_ALPHA, 9);
    expect(transparent[0]!.indices.length).toBe(6);
    expect(sky).toHaveLength(1);
    expect(sky[0]!.indices.length).toBe(6);
    // Light UVs land inside the surface atlas rect.
    const r0 = atlas.rectOf.get(0)!;
    expect(opaque[0]!.lightUVs[0]).toBeCloseTo(r0.x / atlas.width, 6);
    expect(opaque[0]!.lightUVs[1]).toBeCloseTo(r0.y / atlas.height, 6);
  });

  it('merges consecutive same-texId transparent runs', () => {
    const world = testWorld();
    world.surfaces[2]!.texId = 0; // same texId as surface 1
    const styles = new Float32Array(256).fill(1);
    const { atlas } = packLightAtlas(world, [1, 2], styles);
    const refs = [ref(1, 'transparent', true, 200), ref(2, 'transparent', true, 100)];
    const { transparent } = buildTexturedWorldBatches(world, refs, atlas);
    expect(transparent).toHaveLength(1);
    expect(transparent[0]!.indices.length).toBe(12); // two quads
  });

  it('expandPaletteTexture maps indices through the palette', () => {
    const palette = new Uint8Array(768);
    palette[3] = 10; palette[4] = 20; palette[5] = 30;
    const rgb = expandPaletteTexture(new Uint8Array([0, 1]), 2, 1, palette);
    expect(rgb).not.toBeNull();
    expect([...rgb!]).toEqual([0, 0, 0, 10, 20, 30]);
    expect(expandPaletteTexture(new Uint8Array([0]), 2, 1, palette)).toBeNull();
  });

  it('pickSkyPaletteIndex prefers blue-bright entries', () => {
    const palette = new Uint8Array(768);
    palette[0] = 200; palette[1] = 0; palette[2] = 0; // bright red
    palette[6] = 0; palette[7] = 0; palette[8] = 200; // bright blue
    expect(pickSkyPaletteIndex(palette)).toBe(2);
  });
});
