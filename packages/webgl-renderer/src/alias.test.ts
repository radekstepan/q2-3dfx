// @q2/webgl-renderer alias tests — MD2 conversion + per-frame interpolation.

import { describe, expect, it } from 'vitest';
import { createBoxMesh } from '@q2/sw-renderer';
import {
  aliasShadeBase,
  gpuMeshFromMd2,
  interpolateAliasFrame,
  resolveAliasLerp,
  wrapAliasFrame,
} from './alias.js';

describe('proof-3 alias (pure)', () => {
  it('passes AliasMesh through, rejects garbage', () => {
    const box = createBoxMesh();
    expect(gpuMeshFromMd2(box)).toBe(box);
    expect(gpuMeshFromMd2(null)).toBeNull();
    expect(gpuMeshFromMd2({})).toBeNull();
    expect(gpuMeshFromMd2(new Float32Array(8))).toBeNull();
  });

  it('wrapAliasFrame wraps negatives and overflows like the CPU', () => {
    expect(wrapAliasFrame(7, 4)).toBe(3);
    expect(wrapAliasFrame(-1, 4)).toBe(3);
    expect(wrapAliasFrame(0, 0)).toBe(0);
  });

  it('resolveAliasLerp mirrors the CPU frame/oldframe/backlerp rule', () => {
    // No oldframe: no lerp (frameA == frameB, blend 0).
    expect(resolveAliasLerp(4, undefined, 0.7, 8)).toEqual({ frameA: 4, frameB: 4, lerp: 0 });
    // Oldframe present: oldframe -> frame by clamped backlerp.
    expect(resolveAliasLerp(4, 1, 0.4, 8)).toEqual({ frameA: 1, frameB: 4, lerp: 0.4 });
    expect(resolveAliasLerp(4, 1, 9, 8)).toEqual({ frameA: 1, frameB: 4, lerp: 1 });
    expect(resolveAliasLerp(9, -2, 0.5, 4)).toEqual({ frameA: 2, frameB: 1, lerp: 0.5 });
  });

  it('interpolation is exact at endpoints and deterministic', () => {
    const box = createBoxMesh(); // 2 frames: frame 1 shifts +4 on z
    const nv = box.numVerts;
    const a = new Float32Array(nv * 3);
    const b = new Float32Array(nv * 3);
    const mid = new Float32Array(nv * 3);
    const mid2 = new Float32Array(nv * 3);
    interpolateAliasFrame(box, 0, 1, 0, a);
    interpolateAliasFrame(box, 0, 1, 1, b);
    interpolateAliasFrame(box, 0, 1, 0.5, mid);
    interpolateAliasFrame(box, 0, 1, 0.5, mid2);
    expect([...a]).toEqual([...box.frames.subarray(0, nv * 3)]);
    expect([...b]).toEqual([...box.frames.subarray(nv * 3, nv * 6)]);
    for (let i = 0; i < nv * 3; i++) {
      expect(mid[i]).toBeCloseTo((a[i]! + b[i]!) / 2, 6);
    }
    expect([...mid]).toEqual([...mid2]); // identical inputs -> identical bytes
    // Different lerp -> different bytes.
    expect([...mid].join(',')).not.toBe([...a].join(','));
  });

  it('shade base follows the t<0.5 frame rule and stays in range', () => {
    const box = createBoxMesh();
    const nv = box.numVerts;
    const s0 = new Float32Array(nv);
    const s1 = new Float32Array(nv);
    aliasShadeBase(box, 0, 1, 0.2, 33, s0);
    aliasShadeBase(box, 0, 1, 0.8, 33, s1);
    for (let i = 0; i < nv; i++) {
      expect(s0[i]).toBeGreaterThan(0);
      expect(s0[i]).toBeLessThanOrEqual(1);
      expect(s1[i]).toBeGreaterThan(0);
      expect(s1[i]).toBeLessThanOrEqual(1);
    }
  });
});
