// @q2/webgl-renderer entities tests — tail refresh + billboard emitters.

import { describe, expect, it } from 'vitest';
import type { Entity } from '@q2/renderer-api';
import { setupCamera } from '@q2/sw-renderer';
import {
  collectParticlePoints,
  emitBeamQuad,
  emitSpriteQuad,
  emptyFlatBatch,
  resolveBeam,
  updateGpuEntities,
} from './entities.js';

function view(): { origin: Float32Array; angles: Float32Array; fovX: number; time: number; lightStyles: Float32Array } {
  return {
    origin: new Float32Array([0, 0, 0]),
    angles: new Float32Array([0, 0, 0]),
    fovX: 90,
    time: 0,
    lightStyles: new Float32Array(256).fill(1),
  };
}

describe('proof-3 updateGpuEntities (pure)', () => {
  it('reuses world refs by reference and refreshes only the tail', () => {
    const worldRef = {
      surfaceId: 7, material: 'opaque' as const, materialHandle: 3,
      transparent: false, order: 0, transformIndex: 0,
    };
    const scene = {
      surfaces: [worldRef],
      transforms: [new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])],
      staticGeneration: 1,
    };
    const entities: Entity[] = [
      { model: 1, origin: new Float32Array([50, 0, 0]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0 },
      { model: 2, origin: new Float32Array([30, 0, 0]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0, alpha: 0.5 },
    ];
    const kinds = new Map([[1, 'md2' as const], [2, 'sp2' as const]]);
    const out = updateGpuEntities(scene, entities, view(), kinds);
    expect(out[0]).toBe(worldRef); // static prefix untouched
    expect(out).toHaveLength(3);
    expect(out[1]).toMatchObject({ surfaceId: -1, material: 'alias', transparent: false, transformIndex: 1 });
    expect(out[2]).toMatchObject({ surfaceId: -2, material: 'sprite', transparent: true, transformIndex: 2 });
    expect(out[2]!.order).toBeGreaterThan(0);
    // Empty entities: tail is empty, world refs preserved.
    const bare = updateGpuEntities(scene, [], view());
    expect(bare).toEqual([worldRef]);
  });

  it('sorts the merged blend tail far->near', () => {
    const scene = {
      surfaces: [{
        surfaceId: 1, material: 'transparent' as const, materialHandle: 0,
        transparent: true, order: 150, transformIndex: 0,
      }],
      transforms: [new Float32Array(16).fill(0)],
      staticGeneration: 1,
    };
    const entities: Entity[] = [
      { model: 1, origin: new Float32Array([200, 0, 0]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0, alpha: 0.5 },
    ];
    const out = updateGpuEntities(scene, entities, view(), new Map([[1, 'md2' as const]]));
    const blend = out.filter((r) => r.transparent);
    expect(blend.map((r) => r.order)).toEqual([200, 150]);
  });
});

describe('proof-3 billboard emitters (pure)', () => {
  it('sprite quads are camera-facing with 0..1 uvs', () => {
    const cam = setupCamera(new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90, 640, 480);
    const b = emptyFlatBatch();
    emitSpriteQuad(b, new Float32Array([100, 0, 0]), cam, 64, 64, 1, 0.5, 0.25, 1);
    expect(b.pos.length).toBe(12);
    expect(b.col.length).toBe(16);
    expect(b.idx).toEqual([0, 1, 2, 0, 2, 3]);
    expect(b.uv).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    for (const v of b.pos) expect(Number.isFinite(v)).toBe(true);
  });

  it('beam quads span the segment with finite verts', () => {
    const cam = setupCamera(new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90, 640, 480);
    const b = emptyFlatBatch();
    emitBeamQuad(b, 50, -10, 0, 150, -10, 0, cam, 1, 1, 1, 1);
    expect(b.pos.length).toBe(12);
    expect(b.idx).toEqual([0, 1, 2, 0, 2, 3]);
    for (const v of b.pos) expect(Number.isFinite(v)).toBe(true);
  });

  it('resolveBeam follows the contract-free beam convention', () => {
    const e: Entity = {
      model: 3, origin: new Float32Array([10, 20, 30]),
      angles: new Float32Array([0, 0, 0]), frame: 96, skin: 231,
    };
    const seg = resolveBeam(e);
    // Angles [0,0,0] -> forward +X; length 96.
    expect(seg.bx - seg.ax).toBeCloseTo(96, 6);
    expect(seg.color).toBe(231);
  });

  it('particle points expand palette colors', () => {
    const palette = new Uint8Array(768);
    palette[8 * 3] = 255;
    const world = {
      particles: [{ origin: new Float32Array([1, 2, 3]), color: 8 }],
    } as unknown as Parameters<typeof collectParticlePoints>[0];
    const { positions, colors } = collectParticlePoints(world, palette);
    expect([...positions]).toEqual([1, 2, 3]);
    expect(colors[0]).toBe(1);
    expect(colors[1]).toBe(0);
    expect(colors[3]).toBe(1);
  });
});
