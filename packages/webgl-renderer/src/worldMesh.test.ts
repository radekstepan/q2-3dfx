// @q2/webgl-renderer worldMesh tests — pure batch/atlas/texture builders.

import { describe, expect, it } from 'vitest';
import type { GpuSurfaceRef } from '@q2/renderer-api';
import type { MiniWorld } from '@q2/sw-renderer';
import {
  buildFullWorldStore,
  buildTexturedWorldBatches,
  expandPaletteTexture,
  packLightAtlas,
  pickSkyPaletteIndex,
  styleSignature,
  TRANS33_ALPHA,
  TRANS66_ALPHA,
  UNLIT_LUXEL,
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
    // Light UVs land on luxel centres inside the surface atlas rect
    // (FOLLOW-2B: integer luxel coords address luxel centres, matching the
    // CPU sampleLightBlock rule where integer lu/lv hit exact luxels; the
    // GPU LINEAR tap at (rect + 0.5 + lux) lands on the texel centre instead
    // of straddling the texel edge into the neighbour tile).
    const r0 = atlas.rectOf.get(0)!;
    expect(opaque[0]!.lightUVs[0]).toBeCloseTo((r0.x + 0.5) / atlas.width, 6);
    expect(opaque[0]!.lightUVs[1]).toBeCloseTo((r0.y + 0.5) / atlas.height, 6);
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

  it('FOLLOW-2B: no-light surfaces sample the uniform unlit tile, never atlas origin', () => {
    const world = testWorld();
    // Surface 3 is sky; add an opaque surface with no lightmap entry.
    world.surfaces.push(quadSurf(4, 0));
    world.lightmaps.length = 0; // no blocks at all
    const styles = new Float32Array(256).fill(1);
    const { atlas, skipped, shortFallback } = packLightAtlas(world, [4], styles);
    expect(skipped).toEqual([]);
    expect(shortFallback).toEqual([]);
    expect(atlas.rectOf.has(4)).toBe(false);
    const { opaque } = buildTexturedWorldBatches(world, [ref(4, 'opaque', false, 0)], atlas);
    expect(opaque).toHaveLength(1);
    expect(opaque[0]!.lightUVs[0]).toBeCloseTo(atlas.unlitUV[0], 9);
    expect(opaque[0]!.lightUVs[1]).toBeCloseTo(atlas.unlitUV[1], 9);
    // The unlit tile is neutral mid-gray, not black, not atlas-origin content.
    const ux = 1; const uy = 1;
    const o = (uy * atlas.width + ux) * 3;
    expect(atlas.pixels[o]).toBe(UNLIT_LUXEL);
    expect(atlas.pixels[o + 1]).toBe(UNLIT_LUXEL);
    expect(atlas.pixels[o + 2]).toBe(UNLIT_LUXEL);
    // Full-store path agrees.
    const store = buildFullWorldStore(world, atlas);
    const range = store.world.surfaces.get(4);
    expect(range).toBeDefined();
  });

  it('FOLLOW-2B: short lightmap samples expand per-luxel and record shortFallback', () => {
    const world = testWorld();
    world.lightmaps[0] = { samples: new Uint8Array([128, 128, 128]), luxW: 2, luxH: 2, styles: [0, 255, 255, 255] };
    const styles = new Float32Array(256).fill(1);
    const { atlas, shortFallback } = packLightAtlas(world, [0], styles);
    expect(shortFallback).toEqual([0]);
    const r0 = atlas.rectOf.get(0)!;
    expect(r0.w).toBe(2);
    expect(r0.h).toBe(2);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const o = ((r0.y + y) * atlas.width + (r0.x + x)) * 3;
        expect(atlas.pixels[o]).toBe(UNLIT_LUXEL);
        expect(atlas.pixels[o + 1]).toBe(UNLIT_LUXEL);
        expect(atlas.pixels[o + 2]).toBe(UNLIT_LUXEL);
      }
    }
  });

  it('FOLLOW-2B: oversized blocks skip with a record, never crash, and sample unlit', () => {
    const world = testWorld();
    // Width beyond the 1024 shelf forces the overflow path deterministically.
    world.lightmaps[0] = { samples: new Uint8Array(2000 * 1 * 3).fill(9), luxW: 2000, luxH: 1, styles: [0, 255, 255, 255] };
    const styles = new Float32Array(256).fill(1);
    const { atlas, skipped } = packLightAtlas(world, [0], styles);
    expect(skipped).toEqual([0]);
    expect(atlas.rectOf.has(0)).toBe(false);
    const { opaque } = buildTexturedWorldBatches(world, [ref(0, 'opaque', false, 0)], atlas);
    expect(opaque[0]!.lightUVs[0]).toBeCloseTo(atlas.unlitUV[0], 9);
    expect(opaque[0]!.lightUVs[1]).toBeCloseTo(atlas.unlitUV[1], 9);
  });

  it('FOLLOW-2B: gutters duplicate tile edges and last-luxel centres stay in-tile', () => {
    const world = testWorld();
    world.lightmaps[0] = { samples: new Uint8Array([255, 255, 255, 0, 0, 0, 0, 0, 0, 255, 255, 255]), luxW: 2, luxH: 2, styles: [0, 255, 255, 255] };
    world.lightmaps[1] = { samples: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), luxW: 2, luxH: 2, styles: [0, 255, 255, 255] };
    const styles = new Float32Array(256).fill(1);
    const { atlas } = packLightAtlas(world, [0, 1], styles);
    const r0 = atlas.rectOf.get(0)!;
    // Content first texel is white (255); gutters must carry the same edge.
    const content = (r0.y * atlas.width + r0.x) * 3;
    expect(atlas.pixels[content]).toBe(255);
    const topGutter = ((r0.y - 1) * atlas.width + r0.x) * 3;
    expect(atlas.pixels[topGutter]).toBe(255);
    const leftGutter = (r0.y * atlas.width + (r0.x - 1)) * 3;
    expect(atlas.pixels[leftGutter]).toBe(255);
    // Last luxel centre ((w-1)+0.5) stays inside the content rect + gutter.
    const lastU = (r0.x + (r0.w - 1) + 0.5) / atlas.width;
    const lastV = (r0.y + (r0.h - 1) + 0.5) / atlas.height;
    expect(lastU).toBeGreaterThan(r0.x / atlas.width);
    expect(lastU).toBeLessThan((r0.x + r0.w + 1) / atlas.width);
    expect(lastV).toBeLessThan((r0.y + r0.h + 1) / atlas.height);
    // buildTexturedWorldBatches emits the last-luxel centre for (1,1).
    const { opaque } = buildTexturedWorldBatches(world, [ref(0, 'opaque', false, 0)], atlas);
    // lux (1,1) is the 3rd vert of quadSurf: lightUVs[4,5].
    expect(opaque[0]!.lightUVs[4]).toBeCloseTo(lastU, 6);
    expect(opaque[0]!.lightUVs[5]).toBeCloseTo(lastV, 6);
  });

  it('FOLLOW-2B: lightId remap samples the CPU block (lightId % len), not surface id', () => {
    const world = testWorld();
    // Surface 0 claims lightId 2 while id 0 holds a different block.
    world.surfaces[0]!.lightId = 2;
    world.lightmaps[0] = { samples: new Uint8Array(12).fill(11), luxW: 2, luxH: 2, styles: [0, 255, 255, 255] };
    world.lightmaps[2] = { samples: new Uint8Array(12).fill(77), luxW: 2, luxH: 2, styles: [0, 255, 255, 255] };
    const styles = new Float32Array(256).fill(1);
    const { atlas } = packLightAtlas(world, [0], styles);
    const r0 = atlas.rectOf.get(0)!;
    const o = (r0.y * atlas.width + r0.x) * 3;
    expect(atlas.pixels[o]).toBe(77);
  });
});
