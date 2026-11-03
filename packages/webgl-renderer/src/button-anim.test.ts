// RELEASE-16 — animated button textures follow the live texId on WebGL2.
//
// Ground truth (../external/quake-2-source): client/cl_ents.c autoanim +
// R_TextureAnimation (ref_soft/r_surf.c, ref_gl/gl_rsurf.c) pick the chain
// frame per entity fx/frame/time. The play layer writes the picked frame
// into the live MiniSurf texId per tick (syncButtonAnim); the GPU must draw
// the picked frame without a static re-upload (diffuse binds per range).
import { describe, expect, it } from 'vitest';
import type { MiniSurf, MiniWorld } from '@q2/sw-renderer';
import type { RefDef } from '@q2/renderer-api';
import { refreshGpuScene, selectGpuScene } from './scene.js';
import { WebGLRenderer } from './renderer.js';
import { stubGLFull } from './proof3.test.js';

const W = 640;
const H = 480;

function refDef(origin: [number, number, number], yaw: number): RefDef {
  return {
    origin: new Float32Array(origin),
    angles: new Float32Array([0, yaw, 0]),
    fovX: 90,
    time: 0,
    lightStyles: new Float32Array(256).fill(1),
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

function animWorld(): MiniWorld {
  const surf: MiniSurf = {
    id: 0,
    verts: new Float32Array([-10, 100, -10, 10, 100, -10, 10, 100, 10]),
    uvs: new Float32Array(6),
    lux: new Float32Array(6),
    n: 3,
    texId: 0,
    animTexIds: [0, 1],
    lightId: 0,
    center: new Float32Array([0, 100, 0]),
    radius: 20,
    mins: new Float32Array([-10, 90, -10]),
    maxs: new Float32Array([10, 110, 10]),
    turbulent: false,
    translucent: 0,
    sky: false,
    fn: new Float32Array([0, -1, 0]),
  };
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 0, faceList: [0] }],
    pvs: [new Uint8Array([1])],
    clusterCount: 1,
    surfaces: [surf],
    textures: [
      { texels: new Uint8Array(64).fill(3), width: 8, height: 8 },
      { texels: new Uint8Array(64).fill(200), width: 8, height: 8 },
    ],
    lightmaps: [],
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
}

/** World diffuse texture ids bound per draw: the unit-0 bind feeding uDiffuse. */
function diffuseBinds(state: ReturnType<typeof stubGLFull>, before: number): number[] {
  const out: number[] = [];
  let unit = -1;
  let pending = -1;
  for (const c of state.calls.slice(before)) {
    if (c.startsWith('activeTexture ')) unit = Number(c.split(' ')[1]);
    else if (c.startsWith('bindTexture ') && unit === 0) {
      const id = Number(c.split(' ')[2]);
      if (Number.isFinite(id)) pending = id;
    } else if (c === 'uniform1i uDiffuse 0' && pending >= 0) {
      out.push(pending);
      pending = -1;
    }
  }
  return out;
}

describe('RELEASE-16 button texture animation on WebGL2 (stub GL)', () => {
  it('a live texId swap rebinds the picked frame with no static re-upload', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, W, H);
    const w = animWorld();
    r.attachWorld(w);
    r.setPalette(rampPalette());
    const draw = (): number[] => {
      r.setEntities([], undefined);
      const scene = selectGpuScene(w, [], refDef([0, 0, 0], 90), W, H);
      r.setScene(scene);
      const before = state.calls.length;
      r.renderFrame({ view: refDef([0, 0, 0], 90), scene, time: 0 });
      return diffuseBinds(state, before);
    };
    const first = draw();
    expect(first.length).toBeGreaterThan(0);
    expect(r.testUploadStats()).toEqual({ uploads: 1 });
    // Submission picks the next chain frame (syncButtonAnim equivalent).
    w.surfaces[0]!.texId = 1;
    const second = draw();
    expect(second.length).toBeGreaterThan(0);
    expect(second).not.toEqual(first); // the picked frame rebinds
    expect(r.testUploadStats()).toEqual({ uploads: 1 }); // no re-upload
    // Returning to the base frame rebinds the base texture.
    w.surfaces[0]!.texId = 0;
    expect(draw()).toEqual(first);
    expect(r.testUploadStats()).toEqual({ uploads: 1 });
  });

  it('negative control: a texId swap with no anim chain keeps the static frame', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, W, H);
    const w = animWorld();
    delete w.surfaces[0]!.animTexIds;
    r.attachWorld(w);
    r.setPalette(rampPalette());
    r.setEntities([], undefined);
    const scene = selectGpuScene(w, [], refDef([0, 0, 0], 90), W, H);
    r.setScene(scene);
    const before = state.calls.length;
    r.renderFrame({ view: refDef([0, 0, 0], 90), scene, time: 0 });
    const first = diffuseBinds(state, before);
    expect(first.length).toBeGreaterThan(0);
    // Same texId mutation, but the face carries no animation chain: the
    // static snapshot keeps serving the bake-time frame (proves the rebind
    // above is the animation path, not a global live re-read).
    w.surfaces[0]!.texId = 1;
    r.setEntities([], undefined);
    const scene2 = selectGpuScene(w, [], refDef([0, 0, 0], 90), W, H);
    r.setScene(scene2);
    const before2 = state.calls.length;
    r.renderFrame({ view: refDef([0, 0, 0], 90), scene: scene2, time: 0 });
    expect(diffuseBinds(state, before2)).toEqual(first);
  });

  it('refreshGpuScene carries the live texId per frame (scene side)', () => {
    const w = animWorld();
    const a = refreshGpuScene(w, [], refDef([0, 0, 0], 90), W, H);
    expect(a.surfaces.find((s) => s.surfaceId === 0)?.materialHandle).toBe(0);
    w.surfaces[0]!.texId = 1;
    const b = refreshGpuScene(w, [], refDef([0, 0, 0], 90), W, H);
    expect(b.surfaces.find((s) => s.surfaceId === 0)?.materialHandle).toBe(1);
  });
});
