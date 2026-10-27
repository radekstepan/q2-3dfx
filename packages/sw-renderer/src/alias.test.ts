// M3.4 tests: MD2 affine alias triangles + shade dots, clipped sprites,
// single-pixel particles.
import { describe, expect, it } from 'vitest';
import {
  ANORM_COUNT, buildANorms, buildShadeDots, createBoxMesh,
  drawAliasInstance, fillAffineTri,
  clampBacklerp, aliasAlphaKeeps,
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

  it('clips (not drops) a tri straddling the near plane', () => {
    // Eye-anchored viewmodel case: two verts ahead of near=4, one at
    // vz=2 behind it. The old drop-whole-tri path drew zero pixels; the
    // Sutherland clip keeps the visible quad.
    const cam = testCam();
    const anorms = buildANorms();
    const dots = buildShadeDots(anorms);
    const mesh = {
      frames: new Float32Array([20, -5, -2, 20, 5, -2, 2, 0, 2]),
      normals: new Uint8Array([80, 80, 80]),
      numVerts: 3,
      numFrames: 1,
      tris: new Uint16Array([0, 1, 2]),
      numTris: 1,
      st: new Float32Array([0, 0, 16, 0, 8, 16]),
    };
    const inst = {
      mesh, origin: new Float32Array([0, 0, 0]), angles: new Float32Array([0, 0, 0]),
      frameA: 0, frameB: 0, lerp: 0, lightAngle: 0,
    };
    const idx = new Uint8Array(64 * 64);
    const zb = new Float32Array(64 * 64);
    const p = drawAliasInstance(idx, zb, 64, 64, inst, flatSkin(14), cam, anorms, dots, colormap);
    expect(p).toBeGreaterThan(0);
    // The kept part sits ahead of the clip: every written depth is at or
    // beyond the near plane (iz <= 1/near).
    for (let i = 0; i < zb.length; i++) {
      if (idx[i] !== 0) expect(zb[i]!).toBeLessThanOrEqual(1 / cam.near + 1e-6);
    }
  });

  it('depthScale biases stored 1/z without moving pixels', () => {
    const cam = testCam();
    const anorms = buildANorms();
    const dots = buildShadeDots(anorms);
    const mesh = {
      frames: new Float32Array([20, -5, 0, 20, 5, 0, 20, 0, 10]),
      normals: new Uint8Array([80, 80, 80]),
      numVerts: 3,
      numFrames: 1,
      tris: new Uint16Array([0, 1, 2]),
      numTris: 1,
      st: new Float32Array([0, 0, 16, 0, 8, 16]),
    };
    const base = {
      mesh, origin: new Float32Array([0, 0, 0]), angles: new Float32Array([0, 0, 0]),
      frameA: 0, frameB: 0, lerp: 0, lightAngle: 0,
    };
    const mk = () => ({ idx: new Uint8Array(64 * 64), zb: new Float32Array(64 * 64) });
    const f1 = mk(), f3 = mk();
    const skin = flatSkin(14);
    const p1 = drawAliasInstance(f1.idx, f1.zb, 64, 64, { ...base }, skin, cam, anorms, dots, colormap);
    const p3 = drawAliasInstance(f3.idx, f3.zb, 64, 64, { ...base, depthScale: 3 }, skin, cam, anorms, dots, colormap);
    expect(p1).toBeGreaterThan(0);
    expect(p3).toBe(p1);
    // Same coverage, tripled depth: the RF_DEPTHHACK bias (s_ziscale *= 3).
    expect([...f1.idx]).toEqual([...f3.idx]);
    for (let i = 0; i < f1.zb.length; i++) {
      if (f1.zb[i]! > 0) expect(f3.zb[i]!).toBeCloseTo(f1.zb[i]! * 3, 5);
    }
  });

  it('eye-anchored gun is glued across pitch: entity angles == camera angles', () => {
    // R_AliasSetUpTransform maps model +X to the entity forward vector, so
    // with entity origin/angles == camera origin/angles the view-space
    // coords are (vx, vy, vz) = (-ly, lz, lx) at EVERY pitch: vz is invariant
    // and the screen image is glued. The old yaw-then-pitch-about-X path let
    // vz collapse with pitch (20 -> ~14.6 at 60 deg) and swung the hand into
    // the near plane. Exact cross-pitch bit-equality is unachievable (float
    // rounding paths differ per pitch), so this asserts tight tolerances the
    // old path misses by an order of magnitude.
    const anorms = buildANorms();
    const dots = buildShadeDots(anorms);
    // Texel 100 survives colormap grade 21 (texels <95 shade to index 0 and
    // would be invisible against the background).
    const skin = flatSkin(100);
    const mesh = {
      frames: new Float32Array([20, -5, -2, 20, 5, -2, 20, 0, 4]),
      // Distinct normals: the shade grade varies across the tri, so no
      // pixel sits on a grade-truncation knife-edge (equal vert grades sum
      // to G*(1±eps), flipping (|0) under any infinitesimal perturbation).
      normals: new Uint8Array([5, 80, 120]),
      numVerts: 3,
      numFrames: 1,
      tris: new Uint16Array([0, 1, 2]),
      numTris: 1,
      st: new Float32Array([0, 0, 16, 0, 8, 16]),
    };
    const render = (pitch: number, yaw: number, roll: number): { idx: Uint8Array; zb: Float32Array; pixels: number } => {
      const cam = setupCamera(
        new Float32Array([0, 0, 0]), new Float32Array([pitch, yaw, roll]), 90, 64, 64,
      );
      const idx = new Uint8Array(64 * 64);
      const zb = new Float32Array(64 * 64);
      const pixels = drawAliasInstance(idx, zb, 64, 64, {
        mesh, origin: new Float32Array([0, 0, 0]),
        angles: new Float32Array([pitch, yaw, roll]),
        frameA: 0, frameB: 0, lerp: 0, lightAngle: 0,
      }, skin, cam, anorms, dots, colormap);
      return { idx, zb, pixels };
    };
    const cover = (zb: Float32Array): { rows: number[]; cols: number[]; mean: number } => {
      const rows: number[] = [], cols: number[] = [];
      let sum = 0, n = 0;
      for (let i = 0; i < zb.length; i++) {
        if (zb[i]! > 0) { rows.push((i / 64) | 0); cols.push(i % 64); sum += zb[i]!; n++; }
      }
      return { rows, cols, mean: n === 0 ? 0 : sum / n };
    };
    const ref = render(0, 0, 0);
    expect(ref.pixels).toBeGreaterThan(50);
    const refCover = cover(ref.zb);
    // Sanity: every drawn fragment is visible (no index-0 shading).
    expect(refCover.rows.length).toBe(ref.pixels);
    // Determinism: same angles in -> bit-identical buffers out.
    const again = render(0, 0, 0);
    expect([...again.idx]).toEqual([...ref.idx]);
    expect([...again.zb]).toEqual([...ref.zb]);
    // Glue across pitch and full orientation: same coverage (edge ulps only),
    // same screen bbox, and mean depth == 1/lx (vz invariant).
    const range = (v: number[]): [number, number] => [Math.min(...v), Math.max(...v)];
    const [r0, r1] = range(refCover.rows), [c0, c1] = range(refCover.cols);
    for (const [pitch, yaw, roll] of [[-60, 0, 0], [-30, 0, 0], [30, 0, 0], [60, 0, 0], [30, 20, 10], [-45, 90, 0], [60, 180, 25]] as const) {
      const got = render(pitch, yaw, roll);
      const cov = cover(got.zb);
      expect(Math.abs(got.pixels - ref.pixels)).toBeLessThanOrEqual(4);
      let diff = 0;
      for (let i = 0; i < got.idx.length; i++) if (got.idx[i] !== ref.idx[i]) diff++;
      expect(diff).toBeLessThanOrEqual(6);
      const [gr0, gr1] = range(cov.rows), [gc0, gc1] = range(cov.cols);
      expect(Math.abs(gr0 - r0)).toBeLessThanOrEqual(1);
      expect(Math.abs(gr1 - r1)).toBeLessThanOrEqual(1);
      expect(Math.abs(gc0 - c0)).toBeLessThanOrEqual(1);
      expect(Math.abs(gc1 - c1)).toBeLessThanOrEqual(1);
      // vz == lx == 20 for every vert at every pitch (old path: ~14.6).
      expect(cov.mean).toBeCloseTo(1 / 20, 3);
    }
  });

  it('barrel-forward vert stays below center when looking down (limb-above)', () => {
    // Tri entirely below the eye line (lz < 0): the glued basis keeps every
    // fragment below screen center at every pitch. The old path pushed vy
    // positive with +pitch, throwing the hand above center into the near
    // plane (the "cutoff limb above" symptom).
    const anorms = buildANorms();
    const dots = buildShadeDots(anorms);
    const skin = flatSkin(100);
    const mesh = {
      frames: new Float32Array([28, -2, -2, 28, 2, -2, 24, 0, -4]),
      normals: new Uint8Array([80, 80, 80]),
      numVerts: 3,
      numFrames: 1,
      tris: new Uint16Array([0, 2, 1]),
      numTris: 1,
      st: new Float32Array([0, 0, 16, 0, 8, 16]),
    };
    for (const pitch of [-60, -30, 0, 30, 60]) {
      const cam = setupCamera(
        new Float32Array([0, 0, 0]), new Float32Array([pitch, 0, 0]), 90, 64, 64,
      );
      const idx = new Uint8Array(64 * 64);
      const zb = new Float32Array(64 * 64);
      const pixels = drawAliasInstance(idx, zb, 64, 64, {
        mesh, origin: new Float32Array([0, 0, 0]),
        angles: new Float32Array([pitch, 0, 0]),
        frameA: 0, frameB: 0, lerp: 0, lightAngle: 0,
      }, skin, cam, anorms, dots, colormap);
      expect(pixels).toBeGreaterThan(0);
      let minRow = 64;
      for (let i = 0; i < zb.length; i++) {
        if (zb[i]! > 0) minRow = Math.min(minRow, (i / 64) | 0);
      }
      // Screen center row is 31 (yCenter = 31.5); nothing may render above it.
      expect(minRow).toBeGreaterThanOrEqual(31);
    }
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

describe('RF_FRAMELERP helpers (Entity.oldframe/backlerp/alpha)', () => {
  it('clampBacklerp clamps to [0,1], non-finite -> 0', () => {
    expect(clampBacklerp(0.5)).toBe(0.5);
    expect(clampBacklerp(0)).toBe(0);
    expect(clampBacklerp(1)).toBe(1);
    expect(clampBacklerp(-0.2)).toBe(0);
    expect(clampBacklerp(1.7)).toBe(1);
    expect(clampBacklerp(Number.NaN)).toBe(0);
    expect(clampBacklerp(undefined)).toBe(0);
  });

  it('aliasAlphaKeeps: opaque default, transparent zero, Bayer dither between', () => {
    expect(aliasAlphaKeeps(3, 5, undefined)).toBe(true);
    expect(aliasAlphaKeeps(3, 5, 1)).toBe(true);
    expect(aliasAlphaKeeps(3, 5, 2)).toBe(true);
    expect(aliasAlphaKeeps(3, 5, Number.NaN)).toBe(true);
    expect(aliasAlphaKeeps(3, 5, 0)).toBe(false);
    expect(aliasAlphaKeeps(3, 5, -1)).toBe(false);
    // 4x4 Bayer holds 8/16 cells below 0.5 -> exactly half the 16 cells keep.
    let kept = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        if (aliasAlphaKeeps(x, y, 0.5)) kept++;
      }
    }
    expect(kept).toBe(8);
  });

  it('backlerp interpolates verts oldframe -> frame (lerp math)', () => {
    const cam = testCam();
    const anorms = buildANorms();
    const dots = buildShadeDots(anorms);
    const skin = flatSkin(100);
    // Two frames 6 units apart LATERALLY (y): lerp 0 == frameA pose,
    // lerp 1 == frameB pose. (A pure depth/x shift would be sub-pixel at
    // this distance and rasterise identically — that is perspective, not
    // a lerp failure.) Normals vary per vert and texel 100 survives
    // colormap grade 21 (texels <95 shade to index 0 and would be
    // invisible against the background — an all-zero buffer compares
    // equal no matter the geometry).
    const mesh = {
      frames: new Float32Array([20, 0, 0, 20, 5, 0, 20, 0, 10, 20, 6, 0, 20, 11, 0, 20, 6, 10]),
      normals: new Uint8Array([5, 80, 120, 5, 80, 120]),
      numVerts: 3,
      numFrames: 2,
      numTris: 1,
      tris: new Uint16Array([0, 1, 2]),
      numSt: 3,
      st: new Float32Array([0, 0, 16, 0, 8, 16]),
    };
    const base = {
      mesh, origin: new Float32Array([0, 0, 0]), angles: new Float32Array([0, 0, 0]),
      lightAngle: 0,
    };
    const run = (frameA: number, frameB: number, lerp: number): { idx: Uint8Array; zb: Float32Array; pixels: number } => {
      const idx = new Uint8Array(64 * 64);
      const zb = new Float32Array(64 * 64);
      const pixels = drawAliasInstance(idx, zb, 64, 64, { ...base, frameA, frameB, lerp }, skin, cam, anorms, dots, colormap);
      return { idx, zb, pixels };
    };
    const a = run(0, 0, 0);
    const b = run(1, 1, 0);
    const mid = run(0, 1, 0.5);
    expect(a.pixels).toBeGreaterThan(0);
    expect(b.pixels).toBeGreaterThan(0);
    // Midpoint differs from both endpoints (true interpolation, not a pop).
    expect(mid.idx.some((v, i) => v !== a.idx[i])).toBe(true);
    expect(mid.idx.some((v, i) => v !== b.idx[i])).toBe(true);
    // Endpoints of the blend equal the frozen frames.
    const aEnd = run(0, 1, 0);
    const bEnd = run(0, 1, 1);
    expect([...aEnd.idx]).toEqual([...a.idx]);
    expect([...bEnd.idx]).toEqual([...b.idx]);
  });

  it('alpha 0 draws nothing, alpha 1 is bit-identical to unset, partial dithers', () => {
    const cam = testCam();
    const anorms = buildANorms();
    const dots = buildShadeDots(anorms);
    const skin = flatSkin(14);
    const mesh = createBoxMesh(10);
    const base = {
      mesh, origin: new Float32Array([80, 0, 10]), angles: new Float32Array([0, 0, 0]),
      frameA: 0, frameB: 1, lerp: 0.5, lightAngle: 0,
    };
    const mk = () => ({ idx: new Uint8Array(64 * 64), zb: new Float32Array(64 * 64) });
    const ref = mk();
    const pRef = drawAliasInstance(ref.idx, ref.zb, 64, 64, { ...base }, skin, cam, anorms, dots, colormap);
    const opaque = mk();
    const pOpaque = drawAliasInstance(opaque.idx, opaque.zb, 64, 64, { ...base, alpha: 1 }, skin, cam, anorms, dots, colormap);
    expect(pOpaque).toBe(pRef);
    expect([...opaque.idx]).toEqual([...ref.idx]);
    const gone = mk();
    const pGone = drawAliasInstance(gone.idx, gone.zb, 64, 64, { ...base, alpha: 0 }, skin, cam, anorms, dots, colormap);
    expect(pGone).toBe(0);
    expect(gone.idx.every((v) => v === 0)).toBe(true);
    const half = mk();
    const pHalf = drawAliasInstance(half.idx, half.zb, 64, 64, { ...base, alpha: 0.5 }, skin, cam, anorms, dots, colormap);
    expect(pHalf).toBeGreaterThan(0);
    expect(pHalf).toBeLessThan(pRef);
  });
});
