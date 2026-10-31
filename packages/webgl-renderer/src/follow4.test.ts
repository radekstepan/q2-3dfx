// @q2/webgl-renderer FOLLOW-4 tests — resource lifecycle, resize sync,
// context loss/restoration and repeated-cycle stability (stub GL).
//
// Boxes (renderer-owned only; canvas wiring in apps/web is out of scope):
// (1) same-context replacement deletes obsolete GL objects before dropping
// ownership (uploadStatic generations, resize targets, registry
// re-registration, capacity growth) — never drop-and-GC;
// (2) loss stops submission safely, restoration recreates programs + state
// from retained assets (FOLLOW-2A replay, no migration rebuild);
// (3) resize synchronizes viewport, target, camera dims and status size;
// repeated resize/switch/map/loss cycles keep live counts stable with
// correct output. Fallback is never counted: lost frames never submit.

import { describe, expect, it } from 'vitest';
import { createBoxMesh, type MiniWorld } from '@q2/sw-renderer';
import type { Entity, GpuFrameInput, GpuSceneInput } from '@q2/renderer-api';
import { selectGpuScene, type GpuEntityModelKind } from './scene.js';
import { buildProjectionMatrix } from './matrices.js';
import { WebGLRenderer } from './renderer.js';

const GLC = {
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  ARRAY_BUFFER: 0x8892,
  ELEMENT_ARRAY_BUFFER: 0x8893,
  STATIC_DRAW: 0x88e4,
  DYNAMIC_DRAW: 0x88e8,
  TEXTURE_2D: 0x0de1,
  TEXTURE0: 0x84c0,
  TEXTURE1: 0x84c1,
  RGB: 0x1907,
  UNSIGNED_BYTE: 0x1401,
  UNSIGNED_INT: 0x1405,
  FLOAT: 0x1406,
  LINEAR: 0x2601,
  CLAMP_TO_EDGE: 0x812f,
  REPEAT: 0x2901,
  COLOR_BUFFER_BIT: 0x4000,
  DEPTH_BUFFER_BIT: 0x0100,
  DEPTH_TEST: 0x0b71,
  LESS: 0x0201,
  BLEND: 0x0be2,
  SRC_ALPHA: 0x0302,
  ONE_MINUS_SRC_ALPHA: 0x0303,
  TRIANGLES: 0x0004,
  POINTS: 0x0000,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  UNPACK_ALIGNMENT: 0x0cf5,
  UNPACK_ROW_LENGTH: 0x0cf2,
  NO_ERROR: 0,
  FRAMEBUFFER: 0x8d40,
  RENDERBUFFER: 0x8d41,
  COLOR_ATTACHMENT0: 0x8ce0,
  DEPTH_ATTACHMENT: 0x8d00,
  DEPTH_COMPONENT16: 0x81a5,
  RGBA8: 0x8058,
  RGBA16F: 0x881a,
  RGBA: 0x1908,
  HALF_FLOAT: 0x140b,
  UNSIGNED_BYTE_T: 0x1401,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  VERSION: 0x1f02,
};

interface Stub4 {
  calls: string[];
  gl: WebGL2RenderingContext;
  created: { tex: number; buf: number; fbo: number; rb: number; prog: number };
  deleted: { tex: number; buf: number; fbo: number; rb: number; prog: number };
  mvps: number[][];
}

function stubGL4(): Stub4 {
  const calls: string[] = [];
  const created = { tex: 0, buf: 0, fbo: 0, rb: 0, prog: 0 };
  const deleted = { tex: 0, buf: 0, fbo: 0, rb: 0, prog: 0 };
  const mvps: number[][] = [];
  let nextBuf = 1;
  let nextTex = 1001;
  let nextFb = 5001;
  let nextRb = 6001;
  let nextProg = 3001;
  const gl = {
    ...GLC,
    UNSIGNED_BYTE: 0x1401,
    VERSION: 0x1f02,
    viewport(x: number, y: number, w: number, h: number): void {
      calls.push(`viewport ${x} ${y} ${w} ${h}`);
    },
    clearColor(): void {},
    clearDepth(): void {},
    clear(m: number): void {
      calls.push(`clear ${m}`);
    },
    enable(): void {},
    disable(): void {},
    depthFunc(): void {},
    depthMask(): void {},
    blendFunc(): void {},
    createShader(): unknown {
      return { sid: 1 };
    },
    shaderSource(): void {},
    compileShader(): void {},
    getShaderParameter(): unknown {
      return true;
    },
    getShaderInfoLog(): unknown {
      return '';
    },
    deleteShader(): void {},
    attachShader(): void {},
    bindAttribLocation(): void {},
    linkProgram(): void {},
    createProgram(): unknown {
      created.prog++;
      calls.push('createProgram');
      return { pid: nextProg++ };
    },
    getProgramParameter(): unknown {
      return true;
    },
    getProgramInfoLog(): unknown {
      return '';
    },
    detachShader(): void {},
    deleteProgram(): void {
      deleted.prog++;
      calls.push('deleteProgram');
    },
    useProgram(): void {
      calls.push('useProgram');
    },
    getUniformLocation(_p: unknown, name: string): unknown {
      return { name };
    },
    createBuffer(): unknown {
      created.buf++;
      return { id: nextBuf++ };
    },
    bindBuffer(): void {},
    bufferData(): void {
      calls.push('bufferData');
    },
    deleteBuffer(): void {
      deleted.buf++;
      calls.push('deleteBuffer');
    },
    createTexture(): unknown {
      created.tex++;
      return { id: nextTex++ };
    },
    bindTexture(): void {},
    texParameteri(): void {},
    texImage2D(): void {},
    deleteTexture(): void {
      deleted.tex++;
      calls.push('deleteTexture');
    },
    activeTexture(): void {},
    pixelStorei(): void {},
    getParameter(p: number): unknown {
      if (p === GLC.UNPACK_ALIGNMENT) return 4;
      if (p === GLC.UNPACK_ROW_LENGTH) return 0;
      return 0;
    },
    getError(): number {
      return GLC.NO_ERROR;
    },
    getExtension(): unknown {
      return null;
    },
    createFramebuffer(): unknown {
      created.fbo++;
      calls.push('createFramebuffer');
      return { id: nextFb++ };
    },
    bindFramebuffer(): void {},
    framebufferTexture2D(): void {},
    framebufferRenderbuffer(): void {},
    checkFramebufferStatus(): unknown {
      return GLC.FRAMEBUFFER_COMPLETE;
    },
    deleteFramebuffer(): void {
      deleted.fbo++;
      calls.push('deleteFramebuffer');
    },
    createRenderbuffer(): unknown {
      created.rb++;
      calls.push('createRenderbuffer');
      return { id: nextRb++ };
    },
    bindRenderbuffer(): void {},
    renderbufferStorage(): void {},
    deleteRenderbuffer(): void {
      deleted.rb++;
      calls.push('deleteRenderbuffer');
    },
    uniform1fv(): void {},
    uniform3f(): void {},
    uniform1f(): void {},
    uniform2f(): void {},
    uniform1i(): void {},
    uniform4fv(): void {},
    uniform3fv(): void {},
    uniformMatrix4fv(_l: unknown, _t: boolean, v: Float32Array): void {
      mvps.push([...v.slice(0, 4)]);
      calls.push('uniformMatrix4fv');
    },
    vertexAttribPointer(): void {},
    enableVertexAttribArray(): void {},
    drawElements(): void {
      calls.push('drawElements');
    },
    drawArrays(): void {
      calls.push('drawArrays');
    },
  } as unknown as WebGL2RenderingContext;
  return { calls, gl, created, deleted, mvps };
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

function quadSurf(id: number, cx: number, texId: number): MiniWorld['surfaces'][number] {
  return {
    id,
    verts: new Float32Array([cx - 1, -1, 0, cx + 1, -1, 0, cx + 1, 1, 0, cx - 1, 1, 0]),
    uvs: new Float32Array([0, 0, 8, 0, 8, 8, 0, 0]),
    lux: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    n: 4,
    texId,
    lightId: id,
    center: new Float32Array([cx, 0, 0]),
    radius: 2,
    mins: new Float32Array([cx - 1, -1, 0]),
    maxs: new Float32Array([cx + 1, 1, 0]),
    turbulent: false,
    translucent: 0,
    sky: false,
    fn: new Float32Array([0, 0, 1]),
  };
}

function fixtureWorld(): MiniWorld {
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 2, faceList: [0, 1] }],
    pvs: [new Uint8Array([1])],
    clusterCount: 1,
    surfaces: [quadSurf(0, 50, 0), quadSurf(1, 60, 1)],
    textures: [
      { texels: new Uint8Array(8 * 8).fill(7), width: 8, height: 8 },
      { texels: new Uint8Array(8 * 8).fill(9), width: 8, height: 8 },
    ],
    lightmaps: [0, 1].map(() => ({
      samples: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]),
      luxW: 2, luxH: 2, styles: [0, 255, 255, 255],
    })),
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
}

const KINDS = new Map<number, GpuEntityModelKind>([[0, 'md2']]);

function view(): GpuFrameInput['view'] {
  return {
    origin: new Float32Array([0, 0, 0]),
    angles: new Float32Array([0, 90, 0]),
    fovX: 90,
    time: 0,
    lightStyles: new Float32Array(256).fill(1),
  };
}

function drive(r: WebGLRenderer, world: MiniWorld, gen: number, entities?: Entity[]): GpuSceneInput {
  const list = entities ?? [
    { model: 0, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0 },
  ];
  const scene = { ...selectGpuScene(world, list, view(), 64, 48), staticGeneration: gen };
  r.setScene(scene);
  r.setEntities(list, KINDS);
  r.renderFrame({ view: view(), scene, time: 0 });
  return scene;
}

function wire(r: WebGLRenderer): MiniWorld {
  const world = fixtureWorld();
  r.attachWorld(world);
  r.setPalette(rampPalette());
  r.registerModelData(0, 'md2', createBoxMesh());
  r.registerSkinPixels(0, new Uint8Array(8 * 8).fill(11), 8, 8);
  return world;
}

function draws(calls: string[]): number {
  return calls.filter((c) => c === 'drawElements' || c === 'drawArrays').length;
}

describe('FOLLOW-4 renderer lifecycle (stub GL)', () => {
  it('resize deletes the same-context target and re-syncs viewport/target/status/camera', () => {
    const s = stubGL4();
    const r = new WebGLRenderer();
    r.init(s.gl, 64, 48);
    const world = wire(r);
    drive(r, world, 1);
    expect(r.testTargetInfo()).toMatchObject({ w: 64, h: 48 });
    expect(draws(s.calls)).toBeGreaterThan(0);
    const mvpBefore = JSON.stringify(s.mvps);
    const delBefore = { ...r.testDeleteCounts() };

    r.resize(128, 96);
    // Same-context target delete BEFORE replacement (FBO + tex + renderbuffer).
    expect(r.testDeleteCounts().framebuffers).toBeGreaterThan(delBefore.framebuffers);
    expect(r.testDeleteCounts().textures).toBeGreaterThan(delBefore.textures);
    expect(r.testDeleteCounts().renderbuffers).toBeGreaterThan(delBefore.renderbuffers);
    expect(r.testTargetInfo()).toBeNull(); // dropped; recreated on next frame
    expect(r.getStatus()).toMatchObject({ width: 128, height: 96 });
    expect(s.calls).toContain('viewport 0 0 128 96');

    drive(r, world, 1); // same generation: static kept, target recreated
    expect(r.testTargetInfo()).toMatchObject({ w: 128, h: 96 });
    expect(draws(s.calls)).toBeGreaterThan(0);
    // Camera aspect follows the new size: projection MVP stream changes.
    expect(JSON.stringify(s.mvps)).not.toBe(mvpBefore);
    // No-op resize issues nothing.
    const n = s.calls.length;
    r.resize(128, 96);
    expect(s.calls.length).toBe(n);
  });

  it('map replacement (generation bump) deletes previous static objects, output stays correct', () => {
    const s = stubGL4();
    const r = new WebGLRenderer();
    r.init(s.gl, 64, 48);
    const world = wire(r);
    drive(r, world, 1);
    const liveBefore = r.testLiveResources();
    const delBefore = { ...r.testDeleteCounts() };
    const drawsBefore = draws(s.calls);

    drive(r, world, 2); // map switch: same inventory, new generation
    expect(r.testUploadStats()).toEqual({ uploads: 2 });
    // Obsolete generation deleted (world buffers + atlas at minimum).
    expect(r.testDeleteCounts().buffers).toBeGreaterThan(delBefore.buffers);
    expect(r.testDeleteCounts().textures).toBeGreaterThan(delBefore.textures);
    // Live counts stable: freed-then-recreated in place, never accumulated.
    expect(r.testLiveResources()).toEqual(liveBefore);
    expect(draws(s.calls)).toBeGreaterThan(drawsBefore);
    expect(r.testWarnings().filter((w) => w.includes('upload deferred')).length).toBe(0);
  });

  it('re-registration deletes the obsolete same-context skin/model objects (no dupes)', () => {
    const s = stubGL4();
    const r = new WebGLRenderer();
    r.init(s.gl, 64, 48);
    const world = wire(r);
    drive(r, world, 1);
    const skinsBefore = r.testDeleteCounts().textures;
    const bufsBefore = r.testDeleteCounts().buffers;
    // Hot-swap replay (FOLLOW-2A): same handles again must delete, not dup.
    r.registerModelData(0, 'md2', createBoxMesh());
    r.registerSkinPixels(0, new Uint8Array(8 * 8).fill(12), 8, 8);
    expect(r.testRegisteredModels()).toEqual([0]);
    expect(r.testRegisteredSkins()).toEqual([0]);
    drive(r, world, 1);
    expect(r.testDeleteCounts().textures).toBeGreaterThan(skinsBefore);
    expect(r.testDeleteCounts().buffers).toBeGreaterThan(bufsBefore);
    expect(r.testModelCacheSize()).toBe(1);
  });

  it('sky clear drops the strip (map change) without warnings; re-register restores it', () => {
    const s = stubGL4();
    const r = new WebGLRenderer();
    r.init(s.gl, 64, 48);
    expect(r.registerSkyStrip(new Uint8Array(8 * 48).fill(7), 8, 8)).toBe(true);
    expect(r.testSkyStrip()).toEqual({ tileW: 8, tileH: 8 });
    const warnsBefore = r.testWarnings().length;
    r.clearSkyStrip();
    expect(r.testSkyStrip()).toBeNull();
    // Explicit map-change clears are silent (diagnostics belong to play.ts).
    expect(r.testWarnings().length).toBe(warnsBefore);
    expect(r.registerSkyStrip(new Uint8Array(8 * 48).fill(9), 8, 8)).toBe(true);
    expect(r.testSkyStrip()).toEqual({ tileW: 8, tileH: 8 });
  });

  it('loss stops submission with no deletes; restore replays retained assets and recreates state', () => {
    const s = stubGL4();
    const r = new WebGLRenderer();
    r.init(s.gl, 64, 48);
    const world = wire(r);
    drive(r, world, 1);
    const submitted = r.getStatus().framesSubmitted;
    const drawsBefore = draws(s.calls);
    const progsBefore = s.created.prog;
    const delAtLoss = { ...r.testDeleteCounts() };
    expect(r.testRegisteredModels()).toEqual([0]);
    expect(r.testRegisteredSkins()).toEqual([0]);

    r.handleContextLost();
    expect(r.getStatus().contextLost).toBe(true);
    // Loss drops invalid handles WITHOUT GL deletes (never counted).
    expect(r.testDeleteCounts()).toEqual(delAtLoss);
    expect(r.testLiveResources()).toEqual({ textures: 0, buffers: 0, framebuffers: 0, renderbuffers: 0, programs: 0 });
    const callsAtLoss = s.calls.length;
    r.renderFrame({ view: view(), scene: { surfaces: [], transforms: [], staticGeneration: 1 }, time: 0 });
    // No submit, no GL traffic: fallback/CPU is never counted as GPU execution.
    expect(r.getStatus().framesSubmitted).toBe(submitted);
    expect(s.calls.length).toBe(callsAtLoss);
    expect(r.getStatus().lastError).toMatch(/context lost/);
    // Retained registries survive the loss (no re-registration needed).
    expect(r.testRegisteredModels()).toEqual([0]);
    expect(r.testRegisteredSkins()).toEqual([0]);

    // Restoration on a fresh context: no re-registration, programs + static
    // state recreate from retained assets, draws resume.
    const s2 = stubGL4();
    r.handleContextRestored(s2.gl);
    expect(r.getStatus().contextLost).toBe(false);
    drive(r, world, 1);
    expect(s2.created.prog).toBeGreaterThanOrEqual(4); // lit + alias + flat + appearance
    void progsBefore;
    expect(draws(s2.calls)).toBeGreaterThan(0);
    expect(s2.calls).toContain('drawArrays'); // appearance resolve to canvas
    expect(r.getStatus().framesSubmitted).toBe(submitted + 1);
    expect(r.testTargetInfo()).toMatchObject({ w: 64, h: 48 });
    expect(r.getStatus().lastError).toBeNull();
  });

  it('repeated resize/switch/map/loss cycles keep resources stable with correct output', () => {
    const s = stubGL4();
    const r = new WebGLRenderer();
    r.init(s.gl, 64, 48);
    const world = wire(r);
    drive(r, world, 1);
    drive(r, world, 1);
    const liveWarm = r.testLiveResources();
    let submitted = r.getStatus().framesSubmitted;
    const sizes: Array<[number, number]> = [[128, 96], [64, 48], [320, 240], [64, 48]];
    for (let cycle = 0; cycle < sizes.length; cycle++) {
      const [w, h] = sizes[cycle]!;
      // Switch: resize synchronizes viewport/status/target dims.
      r.resize(w, h);
      expect(r.getStatus()).toMatchObject({ width: w, height: h });
      drive(r, world, 1 + cycle);
      expect(r.testTargetInfo()).toMatchObject({ w, h });
      const drawsNow = draws(s.calls);
      expect(drawsNow).toBeGreaterThan(0);
      submitted = r.getStatus().framesSubmitted;
      // Loss inside every cycle: frozen counter, no GL traffic, replay after.
      const delBefore = { ...r.testDeleteCounts() };
      r.handleContextLost();
      expect(r.testDeleteCounts()).toEqual(delBefore); // invalid handles: no deletes
      const frozen = r.getStatus().framesSubmitted;
      r.renderFrame({ view: view(), scene: { surfaces: [], transforms: [], staticGeneration: 1 }, time: 0 });
      expect(r.getStatus().framesSubmitted).toBe(frozen);
      r.handleContextRestored(s.gl);
      drive(r, world, 1 + cycle);
      expect(r.getStatus().framesSubmitted).toBe(frozen + 1);
      submitted = frozen + 1;
      // Stable live counts after every full cycle (freed-then-recreated).
      expect(r.testLiveResources()).toEqual(liveWarm);
    }
    // Deletion happened (same-context work), loss frames never submitted.
    const del = r.testDeleteCounts();
    expect(del.textures).toBeGreaterThan(0);
    expect(del.buffers).toBeGreaterThan(0);
    expect(del.framebuffers).toBeGreaterThan(0);
    expect(r.getStatus().framesSubmitted).toBe(submitted);
    expect(r.testWarnings().filter((w) => w.includes('upload deferred')).length).toBe(0);
  });

  it('dispose with a live context deletes owned objects; dispose-after-loss issues no deletes', () => {
    const s = stubGL4();
    const r = new WebGLRenderer();
    r.init(s.gl, 64, 48);
    const world = wire(r);
    drive(r, world, 1);
    const delBefore = { ...r.testDeleteCounts() };
    r.dispose();
    const delAfter = r.testDeleteCounts();
    expect(delAfter.textures).toBeGreaterThan(delBefore.textures);
    expect(delAfter.buffers).toBeGreaterThan(delBefore.buffers);
    expect(delAfter.programs).toBeGreaterThan(delBefore.programs);
    expect(r.testLiveResources()).toEqual({ textures: 0, buffers: 0, framebuffers: 0, renderbuffers: 0, programs: 0 });
    expect(() => r.dispose()).not.toThrow(); // idempotent

    const s2 = stubGL4();
    const r2 = new WebGLRenderer();
    r2.init(s2.gl, 32, 24);
    wire(r2);
    r2.handleContextLost();
    const delLost = { ...r2.testDeleteCounts() };
    expect(() => r2.dispose()).not.toThrow();
    expect(r2.testDeleteCounts()).toEqual(delLost); // invalid handles: no deletes
  });

  it('rapid repeated resize cycles both directions stay in sync; invalid sizes leave coherent state', () => {
    const s = stubGL4();
    const r = new WebGLRenderer();
    r.init(s.gl, 320, 240);
    const world = wire(r);
    drive(r, world, 1);
    expect(r.testTargetInfo()).toMatchObject({ w: 320, h: 240 });

    // Camera re-derives per frame from width/height (renderer holds no cached
    // projection): aspect actually moves the matrix, so a stale cache would
    // skew/zoom. Pin the derivation the resize path relies on.
    const p43 = buildProjectionMatrix(90, 320, 240);
    const pWide = buildProjectionMatrix(90, 512, 256);
    expect(pWide[5]).not.toBe(p43[5]);

    // Offered sizes forward + back, one frame per step (both directions).
    const sizes: Array<[number, number]> = [[640, 480], [800, 600], [1024, 768], [800, 600], [640, 480], [320, 240]];
    for (const [w, h] of sizes) {
      r.resize(w, h);
      expect(r.getStatus()).toMatchObject({ width: w, height: h });
      expect(r.testTargetInfo()).toBeNull(); // obsolete target dropped, not leaked
      expect(s.calls).toContain(`viewport 0 0 ${w} ${h}`);
      const drawsBefore = draws(s.calls);
      const subBefore = r.getStatus().framesSubmitted;
      drive(r, world, 1); // same generation: static kept, target recreated
      expect(r.testTargetInfo()).toMatchObject({ w, h });
      expect(draws(s.calls)).toBeGreaterThan(drawsBefore);
      expect(r.getStatus().framesSubmitted).toBeGreaterThan(subBefore);
      expect(s.calls).toContain(`viewport 0 0 ${w} ${h}`); // per-frame re-sync
    }

    // Rapid: three resizes with no frame between — final size wins, one recreate.
    r.resize(640, 480);
    r.resize(800, 600);
    r.resize(320, 240);
    expect(r.getStatus()).toMatchObject({ width: 320, height: 240 });
    expect(r.testTargetInfo()).toBeNull();
    drive(r, world, 1);
    expect(r.testTargetInfo()).toMatchObject({ w: 320, h: 240 });

    // Same-size no-op: zero GL traffic, live target kept.
    const n = s.calls.length;
    const delsNoop = { ...r.testDeleteCounts() };
    r.resize(320, 240);
    expect(s.calls.length).toBe(n);
    expect(r.testDeleteCounts()).toEqual(delsNoop);
    expect(r.testTargetInfo()).toMatchObject({ w: 320, h: 240 });

    // Invalid sizes: ignored with a warning, no half-mutated dims, no
    // viewport, no target drop (coherent state, never throws).
    const bad: Array<[number, number]> = [[0, 48], [320, 0], [-1, 96], [64.5, 48], [NaN, 48], [Infinity, 48]];
    for (const [bw, bh] of bad) {
      const stBefore = r.getStatus();
      const targetBefore = r.testTargetInfo();
      const callsBefore = s.calls.length;
      const delsBefore = { ...r.testDeleteCounts() };
      expect(() => r.resize(bw, bh)).not.toThrow();
      expect(r.getStatus()).toMatchObject({ width: stBefore.width, height: stBefore.height });
      expect(r.testTargetInfo()).toEqual(targetBefore);
      expect(s.calls.length).toBe(callsBefore);
      expect(r.testDeleteCounts()).toEqual(delsBefore);
    }
    expect(r.testWarnings().some((w) => w.startsWith('resize: invalid'))).toBe(true);

    // Renderer still draws at the kept size after the invalid attempts.
    const drawsBefore = draws(s.calls);
    drive(r, world, 1);
    expect(r.testTargetInfo()).toMatchObject({ w: 320, h: 240 });
    expect(draws(s.calls)).toBeGreaterThan(drawsBefore);
    expect(r.testDeleteCounts().framebuffers).toBeGreaterThan(0);
  });
});
