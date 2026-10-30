// @q2/webgl-renderer matrices tests — pure projection/model math.

import { describe, expect, it } from 'vitest';
import {
  buildEntityModel,
  buildProjectionMatrix,
  buildViewMatrix,
  GPU_FAR,
  GPU_NEAR,
  multiplyMat4,
  transformPoint,
} from './matrices.js';
import { entityTransform } from './scene.js';

describe('proof-3 matrices (pure)', () => {
  it('near maps to NDC -1, far to NDC +1 on the forward axis', () => {
    const V = buildViewMatrix(
      new Float32Array([0, 0, 0]),
      new Float32Array([1, 0, 0]),
      new Float32Array([0, 1, 0]),
      new Float32Array([0, 0, 1]),
    );
    const P = buildProjectionMatrix(90, 640, 480, GPU_NEAR, GPU_FAR);
    const MVP = multiplyMat4(P, V);
    const [, , zn] = transformPoint(MVP, GPU_NEAR, 0, 0);
    const [, , zf] = transformPoint(MVP, GPU_FAR, 0, 0);
    expect(zn).toBeCloseTo(-1, 9);
    expect(zf).toBeCloseTo(1, 6);
    // Depth increases monotonically with distance (LESS wins).
    const [, , z1] = transformPoint(MVP, 100, 0, 0);
    const [, , z2] = transformPoint(MVP, 200, 0, 0);
    expect(z2).toBeGreaterThan(z1);
  });

  it('forward-axis point projects to the screen center', () => {
    const V = buildViewMatrix(
      new Float32Array([10, 20, 30]),
      new Float32Array([0, 1, 0]),
      new Float32Array([-1, 0, 0]),
      new Float32Array([0, 0, 1]),
    );
    const P = buildProjectionMatrix(90, 640, 480);
    const MVP = multiplyMat4(P, V);
    // Camera at (10,20,30) looking +Y: (10,120,30) is 100 ahead, centered.
    const [x, y] = transformPoint(MVP, 10, 120, 30);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
  });

  it('view-up maps to NDC-up (no vertical flip vs the CPU reference)', () => {
    const V = buildViewMatrix(
      new Float32Array([10, 20, 30]),
      new Float32Array([0, 1, 0]),
      new Float32Array([-1, 0, 0]),
      new Float32Array([0, 0, 1]),
    );
    const P = buildProjectionMatrix(90, 640, 480);
    const MVP = multiplyMat4(P, V);
    // 100 ahead, 10 up in view space: NDC y must be positive (top of canvas).
    const [, y] = transformPoint(MVP, 10, 120, 40);
    const tanY = Math.tan(Math.PI / 4) * (480 / 640);
    expect(y).toBeCloseTo(10 / (100 * tanY), 6);
    expect(y).toBeGreaterThan(0);
  });

  it('entity model at pitch=roll=0 equals the yaw-only scene transform', () => {
    const origin = new Float32Array([10, 20, 30]);
    for (const yaw of [0, 45, 90, 180, 270]) {
      const angles = new Float32Array([0, yaw, 0]);
      const full = buildEntityModel(origin, angles);
      const yawOnly = entityTransform(origin, yaw);
      for (let i = 0; i < 16; i++) expect(full[i]).toBeCloseTo(yawOnly[i]!, 9);
    }
  });

  it('multiplyMat4 identity is neutral', () => {
    const I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const P = buildProjectionMatrix(90, 640, 480);
    const out = multiplyMat4(P, I);
    for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(P[i]!, 12);
  });
});
