// @q2/webgl-renderer alias tests — MD2 conversion + per-frame interpolation.

import { describe, expect, it } from 'vitest';
import { createBoxMesh } from '@q2/sw-renderer';
import {
  aliasShadeBase,
  aliasDotFactorGL,
  aliasShadeLightGL,
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

  it('GL dot factor mirrors the anormtab range and follows yaw', () => {
    // ref_gl anormtab.h spans [0.7, 2.0] (mean ~1.11): gentle modulation,
    // never a crush. Sweep normals x yaw quanta like the runtime does.
    let lo = Infinity, hi = -Infinity, sum = 0, n = 0;
    for (let k = 0; k < 64; k++) {
      const y = 1 - ((k + 0.5) / 64) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = Math.PI * (3 - Math.sqrt(5)) * k;
      const nx = Math.cos(th) * r, ny = Math.sin(th) * r, nz = y;
      for (let q = 0; q < 16; q++) {
        const l = aliasDotFactorGL(nx, ny, nz, (q / 16) * Math.PI * 2);
        if (l < lo) lo = l;
        if (l > hi) hi = l;
        sum += l; n++;
      }
    }
    expect(lo).toBeGreaterThanOrEqual(0.7);
    expect(hi).toBeLessThanOrEqual(2.0);
    expect(sum / n).toBeGreaterThan(0.9);
    expect(sum / n).toBeLessThan(1.4);
    // Up-facing normal reads bright from the 45-degree elevated light and
    // the factor varies with yaw for side normals.
    expect(aliasDotFactorGL(0, 0, 1, 0)).toBeGreaterThan(1.4);
    const sideA = aliasDotFactorGL(1, 0, 0, 0);
    const sideB = aliasDotFactorGL(1, 0, 0, Math.PI);
    expect(sideA).not.toBeCloseTo(sideB, 2);
  });

  it('GL shade light keeps per-channel RGB with all-or-nothing minlight', () => {
    const close3 = (got: Float32Array, want: number[]): void => {
      expect(got.length).toBe(3);
      for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(want[k]!, 6);
    };
    close3(aliasShadeLightGL(new Float32Array([0.5, 0.3, 0.1]), {}), [0.5, 0.3, 0.1]);
    // No clamps, no inversion: a bright sample passes through verbatim.
    close3(aliasShadeLightGL(new Float32Array([1, 1, 1]), {}), [1, 1, 1]);
    // ref_gl MINLIGHT fires only when every channel is below 0.1.
    close3(aliasShadeLightGL(new Float32Array([0.05, 0.04, 0.03]), { minlight: true }), [0.1, 0.1, 0.1]);
    close3(aliasShadeLightGL(new Float32Array([0.05, 0.4, 0.03]), { minlight: true }), [0.05, 0.4, 0.03]);
    // GLOW pulses per channel around the sample (sin(0) = 0: no shift).
    expect(aliasShadeLightGL(new Float32Array([0.5, 0.5, 0.5]), { glow: true, time: 0 })[0]).toBeCloseTo(0.5, 6);
    // Pulse peak (sin(7t) = 1): +0.1 per channel, like the dark pickup.
    const peak = aliasShadeLightGL(new Float32Array([0.03, 0.02, 0.04]), { glow: true, time: Math.PI / 14 });
    close3(peak, [0.13, 0.12, 0.14]);
    // Pulse trough floors at 0.8x per channel (never below).
    const trough = aliasShadeLightGL(new Float32Array([0.03, 0.02, 0.04]), { glow: true, time: (3 * Math.PI) / 14 });
    close3(trough, [0.024, 0.016, 0.032]);
  });

  it('GL shade base writes dot factors and follows the frame rule', () => {
    const box = createBoxMesh();
    const nv = box.numVerts;
    const base = new Float32Array([0.5, 0.3, 0.1]);
    const s0 = new Float32Array(nv);
    const s1 = new Float32Array(nv);
    aliasShadeBase(box, 0, 1, 0.2, 0, s0, { yaw: 0.7, base });
    aliasShadeBase(box, 0, 1, 0.8, 0, s1, { yaw: 0.7, base });
    for (let i = 0; i < nv; i++) {
      expect(s0[i]).toBeGreaterThanOrEqual(0.7);
      expect(s0[i]).toBeLessThanOrEqual(2.0);
      expect(s1[i]).toBeGreaterThanOrEqual(0.7);
      expect(s1[i]).toBeLessThanOrEqual(2.0);
    }
    // frameA != frameB interpolations ride different shade frames
    // (createBoxMesh frames share normals here, so assert determinism).
    const s0b = new Float32Array(nv);
    aliasShadeBase(box, 0, 1, 0.2, 0, s0b, { yaw: 0.7, base });
    expect([...s0b]).toEqual([...s0]);
  });
});
