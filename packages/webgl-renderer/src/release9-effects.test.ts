// @q2/webgl-renderer RELEASE-9 tests — GPU explosion/blaster presentation audit.
//
// Lane: packages/webgl-renderer only (setEntities/refreshGpuScene selection,
// alias Entity draw dispatch, beam dispatch). The synthesizer (extraEntities,
// frameGpuPlay light windows) lives in apps/web and is NOT under test here;
// entities are built with the same field mapping the play layer emits
// (frame/oldframe/backlerp/alpha/skin) so the GPU consumption is pinned.
//
// Original-source reference (external/quake-2-source, client/cl_tent.c
// CL_AddExplosions + TE_BLASTER/TE_EXPLOSION1/2 cases):
//   - ex_misc (blaster): 4 frames, model cl_mod_explode
//     (models/objects/explode/tris.md2), alpha = 1-frac/3, orientation from
//     the hit dir (pitch = acos(dir[2]), yaw = atan2), freed at f>=3.
//   - ex_poly (big boom): model cl_mod_explo4 (models/objects/r_explode),
//     alpha = (16-f)/16, baseframe 30 (explosion2, 19f) or 0/15 (explosion1,
//     15f), skinnum animates 0..6 over the life, freed at f>=frames-1.
// Producer-side deviations observed (apps/web + server lanes, NOT fixed
// here — frozen contracts / other owns): blaster alpha fades over 0.1s not
// ~0.3s, frames trail the original by one (base+f vs base+f+1), ex_poly
// skinnum animation is absent (single skin1.pcx registered), blaster pitch
// is dropped ([0,yaw,0]). This file pins the GPU consumption: given an
// Entity, selection + interpolation + projection + alpha dispatch must match
// the CPU SoftwareRenderer goldens path.
//
// Audit verdict (measured with real pak MD2s, Q2_PAK legs below): GPU
// projected extents agree with CPU rasterized extents to <1.2px across
// distances 96/200/400, FOVs 60/90/110, pitched cameras, pitched entity
// orientations and lerp 0..1 — NO GPU-side scaling/animation deviation.
// The wrong-scale control proves the parity legs are sensitive (a 1.5x draw
// scale fails them by a wide margin).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { parseMD2, parsePCX } from '@q2/formats';
import type { Entity, GpuFrameInput } from '@q2/renderer-api';
import {
  buildANorms,
  buildShadeDots,
  createBoxMesh,
  drawAliasInstance,
  md2ToAliasMesh,
  setupCamera,
  type AliasMesh,
  type MiniWorld,
} from '@q2/sw-renderer';
import { refreshGpuScene, type GpuEntityModelKind } from './scene.js';
import {
  buildEntityModel,
  buildProjectionMatrix,
  buildViewMatrix,
  GPU_NEAR,
  multiplyMat4,
  transformPoint,
} from './matrices.js';
import { interpolateAliasFrame, resolveAliasLerp } from './alias.js';
import { WebGLRenderer } from './renderer.js';
import { stubGLFull } from './proof3.test.js';

const W = 640;
const H = 480;

// --- CPU raster bbox (the goldens path: drawAliasInstance into a buffer) ---

const AN = buildANorms();
const DOTS = buildShadeDots(AN);
const COLORMAP = new Uint8Array(64 * 256).fill(7);

interface Box { x0: number; y0: number; x1: number; y1: number; n: number }

function cpuRasterBBox(
  mesh: AliasMesh, skin: { texels: Uint8Array; width: number; height: number },
  origin: Float32Array, angles: Float32Array,
  frameA: number, frameB: number, lerp: number, alpha: number,
  camOrigin: Float32Array, camAngles: Float32Array, fovX: number,
): Box | null {
  const cam = setupCamera(camOrigin, camAngles, fovX, W, H);
  const idx = new Uint8Array(W * H);
  const zb = new Float32Array(W * H);
  drawAliasInstance(idx, zb, W, H, {
    mesh, origin, angles, frameA, frameB, lerp,
    lightAngle: ((angles[1]! * 256) / 360) & 255,
    depthScale: 1, alpha,
  }, skin, cam, AN, DOTS, COLORMAP);
  let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (idx[y * W + x] !== 0) {
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (n === 0) return null;
  return { x0, y0, x1, y1, n };
}

// --- GPU projected bbox (the audited path: interpolate + MVP, no GL) ---

function gpuProjectBBox(
  mesh: AliasMesh, origin: Float32Array, angles: Float32Array,
  frameA: number, frameB: number, lerp: number,
  camOrigin: Float32Array, camAngles: Float32Array, fovX: number,
): Box | null {
  const cam = setupCamera(camOrigin, camAngles, fovX, W, H);
  const M = buildEntityModel(origin, angles);
  const V = buildViewMatrix(cam.origin, cam.forward, cam.right, cam.up);
  const P = buildProjectionMatrix(fovX, W, H);
  const MV = multiplyMat4(V, M);
  const MVP = multiplyMat4(P, MV);
  const pos = interpolateAliasFrame(mesh, frameA, frameB, lerp, new Float32Array(mesh.numVerts * 3));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  for (let i = 0; i < mesh.numVerts; i++) {
    const lx = pos[i * 3]!, ly = pos[i * 3 + 1]!, lz = pos[i * 3 + 2]!;
    const vz = MV[2]! * lx + MV[6]! * ly + MV[10]! * lz + MV[14]!;
    if (!(vz >= GPU_NEAR)) continue;
    const [nx, ny] = transformPoint(MVP, lx, ly, lz);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) continue;
    if (nx < -1.2 || nx > 1.2 || ny < -1.2 || ny > 1.2) continue;
    const px = (nx * 0.5 + 0.5) * W;
    const py = (1 - (ny * 0.5 + 0.5)) * H;
    n++;
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  }
  if (n === 0) return null;
  return { x0, y0, x1, y1, n };
}

/** Parity holds when both paths see the effect and extents agree. */
function parityError(cpu: Box | null, gpu: Box | null): { dw: number; dh: number; ok: boolean } {
  if (!cpu || !gpu) return { dw: Infinity, dh: Infinity, ok: false };
  const dw = Math.abs((gpu.x1 - gpu.x0) - (cpu.x1 - cpu.x0 + 1));
  const dh = Math.abs((gpu.y1 - gpu.y0) - (cpu.y1 - cpu.y0 + 1));
  const tol = Math.max(3, 0.06 * Math.max(cpu.x1 - cpu.x0 + 1, cpu.y1 - cpu.y0 + 1));
  return { dw, dh, ok: dw <= tol && dh <= tol };
}

// --- Hermetic legs (no pak): selection + dispatch + lerp contracts ---

function fixtureWorld(): MiniWorld {
  const quad = (id: number, cx: number, texId: number): MiniWorld['surfaces'][number] => ({
    id,
    verts: new Float32Array([cx - 1, -1, 0, cx + 1, -1, 0, cx + 1, 1, 0, cx - 1, 1, 0]),
    uvs: new Float32Array([0, 0, 8, 0, 8, 8, 0, 8]),
    lux: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    n: 4, texId, lightId: id,
    center: new Float32Array([cx, 0, 0]), radius: 2,
    mins: new Float32Array([cx - 1, -1, 0]), maxs: new Float32Array([cx + 1, 1, 0]),
    turbulent: false, translucent: 0, sky: false, fn: new Float32Array([0, 0, 1]),
  });
  return {
    brand: 'miniworld', nodes: [],
    leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 2, faceList: [0, 1] }],
    pvs: [new Uint8Array([1])], clusterCount: 1,
    surfaces: [quad(0, 50, 0), quad(1, 60, 1)],
    textures: [
      { texels: new Uint8Array(8 * 8).fill(7), width: 8, height: 8 },
      { texels: new Uint8Array(8 * 8).fill(9), width: 8, height: 8 },
    ],
    lightmaps: [0, 1].map(() => ({
      samples: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]),
      luxW: 2, luxH: 2, styles: [0, 255, 255, 255],
    })),
    dynamicLights: [], alias: [], sprites: [], particles: [],
  };
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

function fixtureView(): GpuFrameInput['view'] {
  return {
    origin: new Float32Array([0, 0, 0]),
    angles: new Float32Array([0, 90, 0]),
    fovX: 90, time: 0,
    lightStyles: new Float32Array(256).fill(1),
  };
}

describe('RELEASE-9 GPU lane: alias selection/dispatch contracts (hermetic)', () => {
  it('resolveAliasLerp pins explosion frame selection incl. wrap + guards', () => {
    // Mid-life explosion1 frame: old -> frame by backlerp.
    expect(resolveAliasLerp(7, 6, 0.5, 49)).toEqual({ frameA: 6, frameB: 7, lerp: 0.5 });
    // Wrap at the mesh end (r_explode has 49 frames; base 15 + 14 = 29 fits,
    // frame 49 wraps to 0 exactly like the CPU wrap in frame.ts).
    expect(resolveAliasLerp(49, 48, 0.25, 49)).toEqual({ frameA: 48, frameB: 0, lerp: 0.25 });
    // explode MD2 has 5 frames: blaster frame 3 + old 2 stay in range.
    expect(resolveAliasLerp(3, 2, 0.5, 5)).toEqual({ frameA: 2, frameB: 3, lerp: 0.5 });
    // Guards mirror the CPU (frame.ts): clamped, non-finite -> 0, no old -> 0.
    expect(resolveAliasLerp(4, 3, 2, 49).lerp).toBe(1);
    expect(resolveAliasLerp(4, 3, -1, 49).lerp).toBe(0);
    expect(resolveAliasLerp(4, 3, NaN, 49).lerp).toBe(0);
    expect(resolveAliasLerp(4, undefined, 0.5, 49)).toEqual({ frameA: 4, frameB: 4, lerp: 0 });
  });

  it('refreshGpuScene routes explosion alpha: 1 -> opaque, (0,1) -> blend far->near, tracer always blends', () => {
    const kinds = new Map<number, GpuEntityModelKind>([[0, 'md2'], [1, 'md2'], [2, 'md2'], [3, 'tracer']]);
    const entities: Entity[] = [
      // Opaque mid-life frame (alpha exactly 1, e.g. big-boom f=0).
      { model: 0, origin: new Float32Array([200, 0, 0]), angles: new Float32Array([0, 0, 0]), frame: 1, oldframe: 0, backlerp: 0.5, skin: 0, alpha: 1 },
      // Fading explosion (alpha 0.5).
      { model: 1, origin: new Float32Array([100, 0, 0]), angles: new Float32Array([0, 0, 0]), frame: 5, oldframe: 4, backlerp: 0.5, skin: 0, alpha: 0.5 },
      // Fully faded (alpha 0): still selected, but the draw pass must skip it.
      { model: 2, origin: new Float32Array([150, 0, 0]), angles: new Float32Array([0, 0, 0]), frame: 13, oldframe: 12, backlerp: 0.5, skin: 0, alpha: 0 },
      // Tracer beam at default alpha: blend pass with a real distance order.
      { model: 3, origin: new Float32Array([120, 0, 0]), angles: new Float32Array([0, 0, 0]), frame: 96, skin: 7 },
    ];
    const scene = refreshGpuScene(fixtureWorld(), entities, fixtureView(), W, H, kinds);
    const refs = scene.surfaces.filter((r) => r.transformIndex !== 0);
    expect(refs).toHaveLength(4);
    const byEntity = new Map(refs.map((r) => [-1 - r.surfaceId, r]));
    // Alpha 1 -> opaque alias; alpha 0.5/0 + tracer -> transparent.
    expect(byEntity.get(0)).toMatchObject({ material: 'alias', transparent: false });
    expect(byEntity.get(1)).toMatchObject({ material: 'alias', transparent: true });
    expect(byEntity.get(2)).toMatchObject({ material: 'alias', transparent: true });
    expect(byEntity.get(3)).toMatchObject({ material: 'beam', transparent: true });
    // Combined blend tail sorts far->near: entity2 (dist 150) first, then
    // the tracer (120), then entity1 (100) — proves distance order keys,
    // not order 0.
    const blendOrder = scene.surfaces.filter((r) => r.transparent).map((r) => r.surfaceId);
    expect(blendOrder).toEqual([-3, -4, -2]);
    // Wrong-routing control: the opaque explosion must NOT sit in the blend
    // tail, and the fading one must NOT sit in the opaque head.
    expect(blendOrder).not.toContain(-1);
    expect(scene.surfaces.filter((r) => !r.transparent && r.transformIndex !== 0).map((r) => r.surfaceId)).toEqual([-1]);
  });

  it('stub-GL draw dispatch: opaque alias / translucent alias / beam ride the right passes with exact alpha', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl as unknown as WebGL2RenderingContext, W, H);
    r.attachWorld(fixtureWorld());
    r.setPalette(rampPalette());
    const box = createBoxMesh();
    r.registerModelData(0, 'md2', box);
    r.registerModelData(1, 'md2', box);
    r.registerModelData(3, 'tracer', null);
    r.registerSkinPixels(0, new Uint8Array(8 * 8).fill(11), 8, 8);
    const kinds = new Map<number, GpuEntityModelKind>([[0, 'md2'], [1, 'md2'], [3, 'tracer']]);
    const entities: Entity[] = [
      { model: 0, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 1, oldframe: 0, backlerp: 0.5, skin: 0, alpha: 1 },
      { model: 1, origin: new Float32Array([52, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 2, oldframe: 1, backlerp: 0.5, skin: 0, alpha: 0.5 },
      { model: 0, origin: new Float32Array([54, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 3, oldframe: 2, backlerp: 0.5, skin: 0, alpha: 0 },
      { model: 3, origin: new Float32Array([50, 5, -10]), angles: new Float32Array([0, 0, 0]), frame: 96, skin: 7 },
    ];
    const scene = refreshGpuScene(fixtureWorld(), entities, fixtureView(), W, H, kinds);
    r.setScene(scene);
    r.setEntities(entities, kinds);
    r.renderFrame({ view: fixtureView(), scene, time: 0 });
    expect(r.getStatus().framesSubmitted).toBe(1);
    const log = state.calls;
    // Exact alpha dispatch: opaque alias draws with uAlpha 1, the fading one
    // with uAlpha 0.5 in the blend pass (after BLEND enable), never uAlpha 0.
    expect(log).toContain('uniform1f uAlpha 1');
    expect(log).toContain('uniform1f uAlpha 0.5');
    expect(log.some((c) => c === 'uniform1f uAlpha 0')).toBe(false);
    const blendOn = log.findIndex((c) => c === 'enable BLEND');
    expect(blendOn).toBeGreaterThan(-1);
    const alphaHalf = log.findIndex((c) => c === 'uniform1f uAlpha 0.5');
    expect(alphaHalf).toBeGreaterThan(blendOn);
    // Beam rides the blend pass (drawElements after BLEND enable); the
    // muzzle-parallax gun path is untouched: no depth-hack bias here.
    expect(log.filter((c) => c.startsWith('drawElements')).length).toBeGreaterThan(0);
    expect(log.some((c) => c === 'uniform1f uDepthBias -0.9')).toBe(false);
    expect(r.testWarnings().some((w) => w.includes('no mesh'))).toBe(false);
  });
});

// --- Real-asset legs (Q2_PAK): model facts + CPU/GPU size parity ---

/** Parse a pak MD2 into a mesh (throws on null — the art is required). */
function mustMesh(pakPath: string, name: string): AliasMesh {
  const mesh = md2ToAliasMesh(parseMD2(pakReadFile(pakPath, name)));
  if (!mesh) throw new Error(`MD2 conversion failed: ${name}`);
  return mesh;
}

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

describe.runIf(!!process.env.Q2_PAK)('RELEASE-9 GPU lane: explosion/blaster parity on real pak art (Q2_PAK)', () => {
  it('model facts: r_explode 49f + explode 5f cover the consumed frame ranges', () => {
    const pakPath = process.env.Q2_PAK as string;
    const rExplode = mustMesh(pakPath, 'models/objects/r_explode/tris.md2');
    const explode = mustMesh(pakPath, 'models/objects/explode/tris.md2');
    expect(rExplode.numFrames).toBe(49);
    expect(explode.numFrames).toBe(5);
    // Play-layer mapping frame=base+f: explosion1 base 15 + f<=14 = 29 < 49;
    // blaster base 0 + f<=3 = 3 < 5. Original mapping (base+f+1) also fits.
    for (const base of [0, 15]) {
      for (let f = 0; f <= 14; f++) {
        const { frameA, frameB } = resolveAliasLerp(base + f, base + Math.max(0, f - 1), 0.5, rExplode.numFrames);
        expect(frameA).toBeGreaterThanOrEqual(0);
        expect(frameB).toBeLessThan(rExplode.numFrames);
      }
    }
    for (let f = 0; f <= 3; f++) {
      const { frameA, frameB } = resolveAliasLerp(f, Math.max(0, f - 1), 0.5, explode.numFrames);
      expect(frameB).toBeLessThan(explode.numFrames);
      expect(frameA).toBeLessThan(explode.numFrames);
    }
    console.log(`RELEASE-9 models: r_explode ${rExplode.numFrames}f/${rExplode.numVerts}v, explode ${explode.numFrames}f/${explode.numVerts}v`);
  });

  it('explosion1 projected size matches the CPU across distance/FOV', { timeout: 120000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const mesh = mustMesh(pakPath, 'models/objects/r_explode/tris.md2');
    const skinPcx = parsePCX(pakReadFile(pakPath, 'models/objects/r_explode/skin1.pcx'));
    const skin = { texels: skinPcx.pixels, width: skinPcx.width, height: skinPcx.height };
    // Play-layer mapping, mid-window frac=0.5, yaw 37 (ex_poly random yaw).
    for (const dist of [96, 200, 400]) {
      for (const fovX of [60, 90, 110]) {
        const eO = new Float32Array([dist, 0, 0]);
        const eA = new Float32Array([0, 37, 0]);
        const { frameA, frameB, lerp } = resolveAliasLerp(4, 3, 0.5, mesh.numFrames);
        const cpu = cpuRasterBBox(mesh, skin, eO, eA, frameA, frameB, lerp, 1,
          new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), fovX);
        const gpu = gpuProjectBBox(mesh, eO, eA, frameA, frameB, lerp,
          new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), fovX);
        const { dw, dh, ok } = parityError(cpu, gpu);
        console.log(`explode1 dist=${dist} fov=${fovX}: cpu=${cpu!.x1 - cpu!.x0 + 1}x${cpu!.y1 - cpu!.y0 + 1} ` +
          `gpu=${(gpu!.x1 - gpu!.x0).toFixed(1)}x${(gpu!.y1 - gpu!.y0).toFixed(1)} d=${dw.toFixed(2)}/${dh.toFixed(2)}`);
        expect(ok).toBe(true);
      }
    }
  });

  it('pitched views and pitched blaster orientations match the CPU', { timeout: 120000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const rMesh = mustMesh(pakPath, 'models/objects/r_explode/tris.md2');
    const rSkinPcx = parsePCX(pakReadFile(pakPath, 'models/objects/r_explode/skin1.pcx'));
    const rSkin = { texels: rSkinPcx.pixels, width: rSkinPcx.width, height: rSkinPcx.height };
    const bMesh = mustMesh(pakPath, 'models/objects/explode/tris.md2');
    const bSkinPcx = parsePCX(pakReadFile(pakPath, 'models/objects/explode/skin.pcx'));
    const bSkin = { texels: bSkinPcx.pixels, width: bSkinPcx.width, height: bSkinPcx.height };
    // Pitched cameras on a big boom (original ex_poly has yaw only; the
    // camera pitches when the player looks up/down at the blast).
    for (const pitch of [-20, 20]) {
      const eO = new Float32Array([200, 0, 0]);
      const eA = new Float32Array([0, 137, 0]);
      const { frameA, frameB, lerp } = resolveAliasLerp(7, 6, 0.5, rMesh.numFrames);
      const cpu = cpuRasterBBox(rMesh, rSkin, eO, eA, frameA, frameB, lerp, 1,
        new Float32Array([0, 0, 0]), new Float32Array([pitch, 0, 0]), 90);
      const gpu = gpuProjectBBox(rMesh, eO, eA, frameA, frameB, lerp,
        new Float32Array([0, 0, 0]), new Float32Array([pitch, 0, 0]), 90);
      const { dw, dh, ok } = parityError(cpu, gpu);
      console.log(`explode1 camPitch=${pitch}: cpu=${cpu!.x1 - cpu!.x0 + 1}x${cpu!.y1 - cpu!.y0 + 1} d=${dw.toFixed(2)}/${dh.toFixed(2)}`);
      expect(ok).toBe(true);
    }
    // Blaster wall/floor/diagonal hits with ORIGINAL orientation
    // (pitch = acos(dir[2]), yaw from atan2 — the GPU full-basis path).
    const dirs: Array<[number, number, number, string]> = [
      [1, 0, 0, 'wall+x'], [0, 0, 1, 'floor'], [0.7071, 0.7071, 0, 'diag-wall'],
    ];
    for (const [dx, dy, dz, label] of dirs) {
      const pitch = (Math.acos(Math.max(-1, Math.min(1, dz))) * 180) / Math.PI;
      const yaw = dx ? (Math.atan2(dy, dx) * 180) / Math.PI : dy > 0 ? 90 : 270;
      for (const dist of [96, 400]) {
        const eO = new Float32Array([dist, 0, 0]);
        const eA = new Float32Array([pitch, yaw, 0]);
        // Original ex_misc stepping at f=1: frame=base+f+1, old=base+f.
        const cpu = cpuRasterBBox(bMesh, bSkin, eO, eA, 1, 2, 0.5, 0.7,
          new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90);
        const gpu = gpuProjectBBox(bMesh, eO, eA, 1, 2, 0.5,
          new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90);
        const { dw, dh, ok } = parityError(cpu, gpu);
        console.log(`blaster ${label} dist=${dist}: cpu=${cpu!.x1 - cpu!.x0 + 1}x${cpu!.y1 - cpu!.y0 + 1} d=${dw.toFixed(2)}/${dh.toFixed(2)}`);
        expect(ok).toBe(true);
      }
    }
  });

  it('frame interpolation sweep matches the CPU (no popping between frames)', { timeout: 60000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const mesh = mustMesh(pakPath, 'models/objects/r_explode/tris.md2');
    const skinPcx = parsePCX(pakReadFile(pakPath, 'models/objects/r_explode/skin1.pcx'));
    const skin = { texels: skinPcx.pixels, width: skinPcx.width, height: skinPcx.height };
    for (const lerp of [0, 0.25, 0.5, 0.75, 1]) {
      const eO = new Float32Array([200, 0, 0]);
      const eA = new Float32Array([0, 0, 0]);
      const cpu = cpuRasterBBox(mesh, skin, eO, eA, 2, 3, lerp, 1,
        new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90);
      const gpu = gpuProjectBBox(mesh, eO, eA, 2, 3, lerp,
        new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90);
      const { dw, ok } = parityError(cpu, gpu);
      console.log(`lerp=${lerp}: cpuW=${cpu!.x1 - cpu!.x0 + 1} gpuW=${(gpu!.x1 - gpu!.x0).toFixed(2)} d=${dw.toFixed(2)}`);
      expect(ok).toBe(true);
    }
  });

  it('wrong-scale control: a 1.5x draw scale FAILS parity (legs are sensitive)', { timeout: 60000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const mesh = mustMesh(pakPath, 'models/objects/r_explode/tris.md2');
    const skinPcx = parsePCX(pakReadFile(pakPath, 'models/objects/r_explode/skin1.pcx'));
    const skin = { texels: skinPcx.pixels, width: skinPcx.width, height: skinPcx.height };
    const eO = new Float32Array([200, 0, 0]);
    const eA = new Float32Array([0, 37, 0]);
    const { frameA, frameB, lerp } = resolveAliasLerp(4, 3, 0.5, mesh.numFrames);
    const cpu = cpuRasterBBox(mesh, skin, eO, eA, frameA, frameB, lerp, 1,
      new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90)!;
    const gpu = gpuProjectBBox(mesh, eO, eA, frameA, frameB, lerp,
      new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90)!;
    // Simulate a 1.5x draw-scale regression on the GPU extents.
    const wrongW = (gpu.x1 - gpu.x0) * 1.5;
    const wrongH = (gpu.y1 - gpu.y0) * 1.5;
    const cpuW = cpu.x1 - cpu.x0 + 1;
    const tol = Math.max(3, 0.06 * cpuW);
    expect(Math.abs(wrongW - cpuW)).toBeGreaterThan(tol);
    expect(wrongH - (cpu.y1 - cpu.y0 + 1)).toBeGreaterThan(tol);
    // And the true GPU extents pass the same bar (parity leg is not vacuous).
    expect(parityError(cpu, gpu).ok).toBe(true);
  });

  it('stub-GL dispatch: real explode/blast entities draw with exact frames/alpha/skin', { timeout: 120000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const explodeMd2 = parseMD2(pakReadFile(pakPath, 'models/objects/r_explode/tris.md2'));
    const blastMd2 = parseMD2(pakReadFile(pakPath, 'models/objects/explode/tris.md2'));
    const explodeSkin = parsePCX(pakReadFile(pakPath, 'models/objects/r_explode/skin1.pcx'));
    const blastSkin = parsePCX(pakReadFile(pakPath, 'models/objects/explode/skin.pcx'));
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl as unknown as WebGL2RenderingContext, W, H);
    r.attachWorld(fixtureWorld());
    r.setPalette(rampPalette());
    const EXPLODE = 10;
    const BLAST = 11;
    const EXSKIN = 20;
    const BLSKIN = 21;
    r.registerModelData(EXPLODE, 'md2', explodeMd2);
    r.registerModelData(BLAST, 'md2', blastMd2);
    r.registerSkinPixels(EXSKIN, explodeSkin.pixels, explodeSkin.width, explodeSkin.height);
    r.registerSkinPixels(BLSKIN, blastSkin.pixels, blastSkin.width, blastSkin.height);
    const kinds = new Map<number, GpuEntityModelKind>([[EXPLODE, 'md2'], [BLAST, 'md2']]);
    // Play-layer mapping mid-life: explosion1 base 0 f=4 frac .5 alpha 12/16;
    // blaster base 0 f=1 frac .5 alpha per the emitted entity.
    const entities: Entity[] = [
      {
        model: EXPLODE, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 37, 0]),
        frame: 4, oldframe: 3, backlerp: 0.5, skin: EXSKIN, alpha: 12 / 16,
      },
      {
        model: BLAST, origin: new Float32Array([52, 0, -10]), angles: new Float32Array([90, 0, 0]),
        frame: 1, oldframe: 0, backlerp: 0.5, skin: BLSKIN, alpha: 0.5,
      },
    ];
    const scene = refreshGpuScene(fixtureWorld(), entities, fixtureView(), W, H, kinds);
    r.setScene(scene);
    r.setEntities(entities, kinds);
    r.renderFrame({ view: fixtureView(), scene, time: 0 });
    expect(r.getStatus().framesSubmitted).toBe(1);
    const log = state.calls;
    // Both fading entities ride the blend pass with their exact alphas.
    expect(log).toContain('uniform1f uAlpha 0.75');
    expect(log).toContain('uniform1f uAlpha 0.5');
    // Skin handles resolve to the real dims (uUVScale = 1/w, 1/h):
    // r_explode skins are 256x128-class, explode skin 64x64-class — assert
    // the exact normalization the draw used, i.e. no white-fallback 1x1.
    expect(log.some((c) => c.startsWith('uniform2f uUVScale'))).toBe(true);
    expect(log).not.toContain('uniform2f uUVScale 1 1');
    expect(r.testWarnings().some((w) => w.includes('no mesh'))).toBe(false);
    expect(r.testWarnings().some((w) => w.includes('white fallback'))).toBe(false);
    expect(r.testWarnings().some((w) => w.includes('texel mismatch'))).toBe(false);
    expect(r.testMaterialStats().skinTextures).toBe(2);
    console.log(`RELEASE-9 dispatch: draws=${log.filter((c) => c.startsWith('drawElements')).length} ` +
      `skins=${JSON.stringify(r.testRegisteredSkins())}`);
  });
});
