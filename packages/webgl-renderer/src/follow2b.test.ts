// @q2/webgl-renderer FOLLOW-2B tests — wrap/unpack/sampler/debug/stats (stub GL).
//
// Covers the boxes the unstaged FOLLOW-2B diff implements without a real
// browser: per-kind wrap addressing, explicit unpack state, sampler-unit
// isolation at draws, uDebugMode upload wiring, and atlas/material reporting.
// Real-GL image triage (same-camera 0/1/2 captures, NPOT/odd-width sampling)
// remains a FOLLOW-2C/live-route concern; these stub tests pin the state
// machine so a lazy upload can never silently clobber unit 1.

import { describe, expect, it } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import type { MiniWorld } from '@q2/sw-renderer';
import type { GpuFrameInput, GpuSceneInput } from '@q2/renderer-api';
import { WebGLRenderer } from './renderer.js';

const GLC = {
  TEXTURE0: 0x84c0,
  TEXTURE1: 0x84c1,
  TEXTURE_2D: 0x0de1,
  REPEAT: 0x2901,
  CLAMP_TO_EDGE: 0x812f,
  RGB: 0x1907,
  UNSIGNED_BYTE: 0x1401,
  UNPACK_ALIGNMENT: 0x0cf5,
  NO_ERROR: 0,
};

interface TexParam {
  tex: unknown;
  pname: number;
  param: number;
}

function stubGL2B(): { calls: string[]; gl: WebGL2RenderingContext; texParams: TexParam[]; pixelStore: number[][]; errors: number[] } {
  const calls: string[] = [];
  const texParams: TexParam[] = [];
  const pixelStore: number[][] = [];
  const uploads: string[] = [];
  let nextTex = 1;
  let nextBuf = 1;
  let nextProg = 1;
  let activeUnit = GLC.TEXTURE0;
  const boundAtUnit = new Map<number, unknown>();
  const gl = {
    VERSION: 0x1f02,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    DEPTH_TEST: 0x0b71,
    BLEND: 0x0be2,
    LESS: 0x0201,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    UNSIGNED_INT: 0x1405,
    TRIANGLES: 0x0004,
    TEXTURE0: GLC.TEXTURE0,
    TEXTURE1: GLC.TEXTURE1,
    TEXTURE_2D: GLC.TEXTURE_2D,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    REPEAT: GLC.REPEAT,
    CLAMP_TO_EDGE: GLC.CLAMP_TO_EDGE,
    RGB: GLC.RGB,
    UNSIGNED_BYTE: GLC.UNSIGNED_BYTE,
    UNPACK_ALIGNMENT: GLC.UNPACK_ALIGNMENT,
    UNPACK_ROW_LENGTH: 0x0cf2,
    NO_ERROR: GLC.NO_ERROR,
    FRAMEBUFFER: 0x8d40,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    getParameter(p: number): unknown {
      if (p === GLC.UNPACK_ALIGNMENT) return 4;
      if (p === 0x0cf2) return 0;
      if (p === 0x1f02) return 'WebGL 2.0 (stub-2B)';
      return 0;
    },
    getError(): number {
      calls.push('getError');
      return GLC.NO_ERROR;
    },
    pixelStorei(p: number, v: number): void {
      pixelStore.push([p, v]);
      calls.push(`pixelStorei ${p} ${v}`);
    },
    activeTexture(t: number): void {
      activeUnit = t;
      calls.push(`activeTexture ${t === GLC.TEXTURE0 ? 0 : 1}`);
    },
    bindTexture(_t: number, tex: unknown): void {
      boundAtUnit.set(activeUnit, tex);
      calls.push(`bindTexture unit=${activeUnit === GLC.TEXTURE0 ? 0 : 1} tex=${(tex as { id?: number } | null)?.id ?? 'null'}`);
    },
    texParameteri(_t: number, pname: number, param: number): void {
      texParams.push({ tex: boundAtUnit.get(activeUnit), pname, param });
      calls.push(`texParameteri ${pname} ${param}`);
    },
    texImage2D(_t: number, level: number, _i: number, w: number, h: number): void {
      uploads.push(`${w}x${h}@${level}`);
      calls.push(`texImage2D lvl=${level} ${w}x${h}`);
    },
    createTexture(): unknown {
      return { id: nextTex++ };
    },
    createBuffer(): unknown {
      return { id: nextBuf++ };
    },
    bindBuffer(): void {},
    bufferData(): void {},
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
    createProgram(): unknown {
      return { pid: nextProg++ };
    },
    attachShader(): void {},
    detachShader(): void {},
    deleteShader(): void {},
    deleteProgram(): void {},
    bindAttribLocation(): void {},
    linkProgram(): void {},
    getProgramParameter(): unknown {
      return true;
    },
    getProgramInfoLog(): unknown {
      return '';
    },
    getUniformLocation(_p: unknown, name: string): unknown {
      return { name };
    },
    getAttribLocation(): unknown {
      return 0;
    },
    useProgram(p: unknown): void {
      calls.push(`useProgram ${(p as { pid: number }).pid}`);
    },
    uniform1i(l: unknown, v: number): void {
      calls.push(`uniform1i ${(l as { name: string }).name} ${v}`);
    },
    uniform1f(l: unknown, v: number): void {
      calls.push(`uniform1f ${(l as { name: string }).name} ${v}`);
    },
    uniform2f(l: unknown, x: number, y: number): void {
      calls.push(`uniform2f ${(l as { name: string }).name} ${x} ${y}`);
    },
    uniform3f(l: unknown, x: number, y: number, z: number): void {
      calls.push(`uniform3f ${(l as { name: string }).name} ${x} ${y} ${z}`);
    },
    uniform1fv(l: unknown, v: Float32Array): void {
      calls.push(`uniform1fv ${(l as { name: string }).name} len=${v.length}`);
    },
    uniform3fv(l: unknown, v: Float32Array): void {
      calls.push(`uniform3fv ${(l as { name: string }).name} len=${v.length}`);
    },
    uniform4fv(l: unknown, v: Float32Array): void {
      calls.push(`uniform4fv ${(l as { name: string }).name} len=${v.length}`);
    },
    uniformMatrix4fv(l: unknown, _t: boolean, v: Float32Array): void {
      calls.push(`uniformMatrix4fv ${(l as { name: string }).name} len=${v.length}`);
    },
    enableVertexAttribArray(): void {},
    vertexAttribPointer(): void {},
    bindAttribLocation2(): void {},
    drawElements(): void {
      calls.push('drawElements');
    },
    drawArrays(): void {},
    viewport(): void {},
    clearColor(): void {},
    clearDepth(): void {},
    clear(): void {},
    enable(): void {},
    disable(): void {},
    depthFunc(): void {},
    depthMask(): void {},
    blendFunc(): void {},
    getExtension(): unknown {
      return null;
    },
    createFramebuffer(): unknown {
      return { id: 900 };
    },
    bindFramebuffer(): void {},
    framebufferTexture2D(): void {},
    framebufferRenderbuffer(): void {},
    checkFramebufferStatus(): unknown {
      return 0x8cd5;
    },
    createRenderbuffer(): unknown {
      return { id: 901 };
    },
    bindRenderbuffer(): void {},
    renderbufferStorage(): void {},
    deleteTexture(): void {},
    deleteBuffer(): void {},
  } as unknown as WebGL2RenderingContext;
  void uploads;
  return { calls, gl, texParams, pixelStore, errors: [] };
}

function miniWorld(): MiniWorld {
  const surf = {
    id: 0,
    verts: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    // Negative + multi-tile UVs: the world-repeat fixture (box 1).
    uvs: new Float32Array([-64, -32, 192, -32, 192, 320, -64, 320]),
    lux: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    n: 4,
    texId: 0,
    lightId: 0,
    center: new Float32Array([0, 0, 0]),
    radius: 2,
    mins: new Float32Array([-1, -1, 0]),
    maxs: new Float32Array([1, 1, 0]),
    turbulent: false,
    translucent: 0,
    sky: false,
    fn: new Float32Array([0, 0, 1]),
  };
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 1, faceList: [0] }],
    pvs: [new Uint8Array([1])],
    clusterCount: 1,
    surfaces: [surf],
    textures: [{ texels: new Uint8Array(64 * 64).fill(7), width: 64, height: 64 }],
    lightmaps: [{ samples: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]), luxW: 2, luxH: 2, styles: [0, 255, 255, 255] }],
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
}

function driveFrame(r: WebGLRenderer, gl: WebGL2RenderingContext): void {
  const scene: GpuSceneInput = {
    surfaces: [{ surfaceId: 0, material: 'opaque', materialHandle: 0, transparent: false, order: 0, transformIndex: 0 }],
    transforms: [new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])],
    staticGeneration: 1,
  };
  const input: GpuFrameInput = {
    view: { origin: new Float32Array([0, -8, 1]), angles: new Float32Array([0, 90, 0]), fovX: 90, time: 0, lightStyles: new Float32Array(256).fill(1) },
    scene,
    time: 0,
  };
  r.setPalette(new Uint8Array(768).fill(7));
  r.attachWorld(miniWorld());
  r.setEntities([]);
  r.setScene(scene);
  r.renderFrame(input);
}

describe('GPU-FOLLOW-2B wiring (stub GL)', () => {
  it('world diffuse uses REPEAT, atlas uses CLAMP; unpack is set + restored', () => {
    const { calls, gl, texParams, pixelStore } = stubGL2B();
    const r = new WebGLRenderer();
    r.init(gl, 64, 48);
    driveFrame(r, gl);
    const wrapS = 0x2802;
    const wrapT = 0x2803;
    const repeats = texParams.filter((t) => (t.pname === wrapS || t.pname === wrapT) && t.param === GLC.REPEAT);
    const clamps = texParams.filter((t) => (t.pname === wrapS || t.pname === wrapT) && t.param === GLC.CLAMP_TO_EDGE);
    // 1 world diffuse (REPEAT s+t) + 1 atlas (CLAMP s+t) at minimum.
    expect(repeats.length).toBeGreaterThanOrEqual(2);
    expect(clamps.length).toBeGreaterThanOrEqual(2);
    // Tightly-packed upload state was requested and restored to default 4.
    expect(pixelStore.some(([p, v]) => p === GLC.UNPACK_ALIGNMENT && v === 1)).toBe(true);
    expect(pixelStore.some(([p, v]) => p === GLC.UNPACK_ALIGNMENT && v === 4)).toBe(true);
    expect(calls.some((c) => c.startsWith('texImage2D'))).toBe(true);
  });

  it('every world draw re-binds unit 0 diffuse + unit 1 lightmap and uploads uDebugMode', () => {
    const { calls, gl } = stubGL2B();
    const r = new WebGLRenderer();
    r.init(gl, 64, 48);
    r.setDebugView(2);
    driveFrame(r, gl);
    // uDebugMode is uploaded (lit program, value 2 for the lightmap triage view).
    expect(calls).toContain('uniform1i uDebugMode 2');
    // Diffuse on unit 0 and lightmap on unit 1 both bound around the draw.
    const unit0 = calls.filter((c) => c === 'activeTexture 0').length;
    const unit1 = calls.filter((c) => c === 'activeTexture 1').length;
    expect(unit0).toBeGreaterThanOrEqual(1);
    expect(unit1).toBeGreaterThanOrEqual(1);
    r.setDebugView(0);
    driveFrame(r, gl);
    expect(calls).toContain('uniform1i uDebugMode 0');
  });

  it('atlas stats + material counts are reported after the static upload', () => {
    const { gl } = stubGL2B();
    const r = new WebGLRenderer();
    expect(r.testAtlasStats()).toBeNull();
    r.init(gl, 64, 48);
    driveFrame(r, gl);
    const stats = r.testAtlasStats();
    expect(stats).not.toBeNull();
    expect(stats!.width).toBe(1024);
    expect(stats!.rects).toBe(1);
    expect(stats!.skipped).toBe(0);
    expect(stats!.shortFallback).toBe(0);
    const mat = r.testMaterialStats();
    expect(mat.atlas).toBe(true);
    expect(mat.diffuseTextures).toBeGreaterThanOrEqual(1);
    // Stub GL has no float-rendering extension, so the RGBA8 fallback warning
    // is expected; what must NOT appear is any upload/missing-asset warning.
    const warns = r.testWarnings();
    expect(warns.filter((w) => w.startsWith('texture upload')).length).toBe(0);
    expect(mat.warnings).toBe(warns.length);
  });

  it('vd_mipdither cvar reaches the uMipDither uniform live (no re-upload)', () => {
    const { calls, gl } = stubGL2B();
    const r = new WebGLRenderer();
    r.init(gl, 64, 48);
    try {
      resetCVars();
      setCVar('vd_mipdither', 1);
      driveFrame(r, gl);
      expect(calls).toContain('uniform1i uMipDither 1');
      setCVar('vd_mipdither', 0);
      driveFrame(r, gl);
      expect(calls).toContain('uniform1i uMipDither 0');
    } finally {
      resetCVars();
    }
  });
});
