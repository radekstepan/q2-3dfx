// M3.4 tests: MD2 affine alias triangles + shade dots, clipped sprites,
// single-pixel particles.
import { describe, expect, it } from 'vitest';
import {
  ANORM_COUNT, buildANorms, buildShadeDots, createBoxMesh,
  drawAliasInstance, fillAffineTri,
} from './alias.js';
import { drawSprite } from './sprites.js';
import { drawParticles, projectParticles } from './particles.js';
import { setupCamera } from './camera.js';
import { buildColormap, defaultPalette } from './colormap.js';

const colormap = buildColormap(defaultPalette());

function testCam() {
  return setupCamera(new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90, 64, 64);
}

function flatSkin(v: number): { texels: Uint8Array; width: number; height: number } {
  return { texels: new Uint8Array(32 * 32).fill(v), width: 32, height: 32 };
}

describe('shade dots', () => {
  it('builds a 256x162 table in grade range', () => {
    expect(ANORM_COUNT).toBe(162);
    const anorms = buildANorms();
    expect(anorms.length).toBe(162 * 3);
    // unit length
    for (let i = 0; i < 162; i++) {
      const l = Math.hypot(anorms[i * 3]!, anorms[i * 3 + 1]!, anorms[i * 3 + 2]!);
      expect(l).toBeCloseTo(1, 5);
    }
    const dots = buildShadeDots(anorms);
    expect(dots.length).toBe(256 * 162);
    for (let i = 0; i < dots.length; i += 977) {
      expect(dots[i]).toBeGreaterThanOrEqual(0);
      expect(dots[i]).toBeLessThanOrEqual(63);
    }
  });

  it('light angle changes the shading', () => {
    const dots = buildShadeDots(buildANorms());
    expect(dots[0 * 162 + 5]).not.toBe(dots[128 * 162 + 5]);
  });
});

describe('fillAffineTri', () => {
  it('backface culls clockwise winding', () => {
    const idx = new Uint8Array(64 * 64);
    const zb = new Float32Array(64 * 64);
    const skin = flatSkin(9);
    const a = { x: 10, y: 10, iz: 0.1, u: 0, v: 0, grade: 63 };
    const b = { x: 20, y: 10, iz: 0.1, u: 8, v: 0, grade: 63 };
    const c = { x: 10, y: 20, iz: 0.1, u: 0, v: 8, grade: 63 };
    // ccw in screen coords (y down): area>0 draws
    expect(fillAffineTri(idx, zb, 64, 64, a, b, c, skin, colormap)).toBeGreaterThan(0);
    const idx2 = new Uint8Array(64 * 64);
    const zb2 = new Float32Array(64 * 64);
    expect(fillAffineTri(idx2, zb2, 64, 64, a, c, b, skin, colormap)).toBe(0);
  });
});

describe('drawAliasInstance', () => {
  it('draws a deterministic box mesh (lerp changes pixels)', () => {
    const cam = testCam();
    const anorms = buildANorms();
    const dots = buildShadeDots(anorms);
    const skin = flatSkin(14);
    const mk = () => ({ idx: new Uint8Array(64 * 64), zb: new Float32Array(64 * 64) });
    const f1 = mk(), f2 = mk();
    const mesh = createBoxMesh(10);
    const base = {
      mesh, origin: new Float32Array([80, 0, 10]), angles: new Float32Array([0, 0, 0]),
      frameA: 0, frameB: 1, lightAngle: 0,
    };
    const p1 = drawAliasInstance(f1.idx, f1.zb, 64, 64, { ...base, lerp: 0 }, skin, cam, anorms, dots, colormap);
    const p2 = drawAliasInstance(f2.idx, f2.zb, 64, 64, { ...base, lerp: 0.5 }, skin, cam, anorms, dots, colormap);
    expect(p1).toBeGreaterThan(50);
    expect(p2).toBeGreaterThan(50);
    // frames differ (z+4 lift) -> buffers differ
    expect(f1.idx.some((v, i) => v !== f2.idx[i])).toBe(true);
    // deterministic: same input -> identical buffer
    const f3 = mk();
    drawAliasInstance(f3.idx, f3.zb, 64, 64, { ...base, lerp: 0.5 }, skin, cam, anorms, dots, colormap);
    expect([...f3.idx]).toEqual([...f2.idx]);
  });

  it('culls meshes fully behind the camera', () => {
    const cam = testCam();
    const anorms = buildANorms();
    const dots = buildShadeDots(anorms);
    const idx = new Uint8Array(64 * 64);
    const zb = new Float32Array(64 * 64);
    const p = drawAliasInstance(idx, zb, 64, 64, {
      mesh: createBoxMesh(10),
      origin: new Float32Array([-80, 0, 10]), angles: new Float32Array([0, 0, 0]),
      frameA: 0, frameB: 0, lerp: 0, lightAngle: 0,
    }, flatSkin(14), cam, anorms, dots, colormap);
    expect(p).toBe(0);
  });
});

describe('drawSprite', () => {
  it('draws a centered billboard and clips a half-offscreen one without OOB', () => {
    const cam = testCam();
    const light = { width: 1, height: 1, values: new Uint8Array([60]) };
    const tex = { width: 32, height: 32, texels: new Uint8Array(32 * 32).fill(21) };
    const scratch = { spans: [], count: 0 };
    const idx = new Uint8Array(64 * 64);
    const zb = new Float32Array(64 * 64);
    const p1 = drawSprite(idx, zb, 64, 64,
      { origin: new Float32Array([100, 0, 0]), width: 40, height: 40, texId: 0, grade: 60 },
      [tex], light, colormap, cam, scratch, 256);
    expect(p1).toBeGreaterThan(100);
    // half off the right edge: must not throw / write OOB, draws fewer pixels
    const idx2 = new Uint8Array(64 * 64);
    const zb2 = new Float32Array(64 * 64);
    const p2 = drawSprite(idx2, zb2, 64, 64,
      { origin: new Float32Array([100, 100, 0]), width: 40, height: 40, texId: 0, grade: 60 },
      [tex], light, colormap, cam, scratch, 256);
    expect(p2).toBeGreaterThan(0);
    expect(p2).toBeLessThan(p1);
    // fully behind -> zero
    const p3 = drawSprite(idx2, zb2, 64, 64,
      { origin: new Float32Array([-50, 0, 0]), width: 40, height: 40, texId: 0, grade: 60 },
      [tex], light, colormap, cam, scratch, 256);
    expect(p3).toBe(0);
  });
});

describe('particles', () => {
  it('draws single pixels with depth test + clip', () => {
    const idx = new Uint8Array(8 * 8).fill(1);
    const zb = new Float32Array(8 * 8);
    zb[3 * 8 + 3] = 0.9;
    const n = drawParticles(idx, zb, 8, 8, [
      { x: 3, y: 3, iz: 0.5, color: 5 },   // behind stored -> kept
      { x: 4, y: 4, iz: 0.7, color: 6 },   // drawn
      { x: -1, y: 0, iz: 0.9, color: 7 },  // clipped
      { x: 100, y: 100, iz: 0.9, color: 7 }, // clipped
    ], 0, 4);
    expect(n).toBe(1);
    expect(idx[3 * 8 + 3]).toBe(1);
    expect(idx[4 * 8 + 4]).toBe(6);
  });

  it('projectParticles puts a centered point at the screen center', () => {
    const cam = testCam();
    const out: { x: number; y: number; iz: number; color: number }[] = [];
    const n = projectParticles(
      new Float32Array([100, 0, 0]), new Uint8Array([200]), 1,
      cam.origin, cam.forward, cam.right, cam.up,
      cam.xCenter, cam.yCenter, cam.focalX, cam.focalY, cam.near, out,
    );
    expect(n).toBe(1);
    expect(out[0]!.x).toBe(32);
    expect(out[0]!.y).toBe(32);
    expect(out[0]!.iz).toBeCloseTo(0.01, 6);
  });
});
