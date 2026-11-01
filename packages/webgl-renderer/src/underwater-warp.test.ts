// DIVERGENCE underwater screen warp (user-requested): the WebGL appearance
// pass warps when the eye is submerged (ref_soft D_WarpScreen mirror).
// ref_gl never did this (tint-only R_PolyBlend); this backend now diverges
// by design. Tests: CPU mirror determinism/bounds, shader presence, stub-GL
// uniform uploads (dry 0 vs submerged 1 + time).
import { describe, expect, it } from 'vitest';
import {
  FS_APPEARANCE,
  underwaterWarpIntAt,
  underwaterWarpPhaseFor,
  underwaterWarpSrc,
} from './appearance.js';
import { WebGLRenderer } from './renderer.js';
import { selectGpuScene } from './scene.js';
import type { MiniWorld } from '@q2/sw-renderer';
import type { GpuFrameInput, GpuSceneInput, RefDef } from '@q2/renderer-api';

const W = 64;
const H = 48;

function refDef(origin: [number, number, number], yaw: number, time = 0): RefDef {
  return {
    origin: new Float32Array(origin),
    angles: new Float32Array([0, yaw, 0]),
    fovX: 90,
    time,
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

function tinyWorld(): MiniWorld {
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 1, faceList: [0] }],
    pvs: [new Uint8Array([1])],
    clusterCount: 1,
    surfaces: [{
      id: 0,
      verts: new Float32Array([49, -1, 0, 51, -1, 0, 51, 1, 0, 49, 1, 0]),
      uvs: new Float32Array([0, 0, 8, 0, 8, 8, 0, 8]),
      lux: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      n: 4, texId: 0, lightId: 0,
      center: new Float32Array([50, 0, 0]), radius: 2,
      mins: new Float32Array([49, -1, 0]), maxs: new Float32Array([51, 1, 0]),
      turbulent: false, translucent: 0, sky: false, fn: new Float32Array([0, 0, 1]),
    }],
    textures: [{ texels: new Uint8Array(8 * 8).fill(7), width: 8, height: 8 }],
    lightmaps: [{
      samples: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]),
      luxW: 2, luxH: 2, styles: [0, 255, 255, 255],
    }],
    dynamicLights: [], alias: [], sprites: [],
    particles: [],
  };
}

type UniformLoc = { name: string };

function stubGL(): { calls: string[]; gl: WebGL2RenderingContext } {
  const calls: string[] = [];
  let nextBuf = 1;
  let nextTex = 1;
  let nextFb = 5001;
  let nextRb = 6001;
  let nextProg = 3001;
  const GLC = {
    VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, LINK_STATUS: 35714,
    COMPILE_STATUS: 35713, ARRAY_BUFFER: 34962, ELEMENT_ARRAY_BUFFER: 34963,
    STATIC_DRAW: 35044, DYNAMIC_DRAW: 35048, TEXTURE_2D: 3553, TEXTURE0: 33984,
    RGBA: 6408, RGBA8: 32856, RGBA16F: 34842, HALF_FLOAT: 5131,
    UNSIGNED_BYTE: 5121, LINEAR: 9729, CLAMP_TO_EDGE: 33071,
    TEXTURE_MIN_FILTER: 10241, TEXTURE_MAG_FILTER: 10240,
    TEXTURE_WRAP_S: 10242, TEXTURE_WRAP_T: 10243,
    DEPTH_TEST: 2929, LESS: 513, BLEND: 3042, SRC_ALPHA: 770,
    ONE_MINUS_SRC_ALPHA: 771, COLOR_BUFFER_BIT: 16384, DEPTH_BUFFER_BIT: 256,
    TRIANGLES: 4, POINTS: 0, FRAMEBUFFER: 36160, RENDERBUFFER: 36161,
    COLOR_ATTACHMENT0: 36064, DEPTH_ATTACHMENT: 36096,
    DEPTH_COMPONENT16: 33189, DEPTH_COMPONENT24: 33190,
    FRAMEBUFFER_COMPLETE: 36053,
  };
  const gl = {
    ...GLC,
    viewport(): void {},
    clearColor(): void {},
    clearDepth(): void {},
    clear(): void {},
    enable(c: number): void { calls.push(`enable ${c}`); },
    disable(c: number): void { calls.push(`disable ${c}`); },
    depthFunc(): void {},
    depthMask(): void {},
    blendFunc(): void {},
    createShader(t: number): unknown { return { sid: t }; },
    shaderSource(): void {},
    compileShader(): void {},
    getShaderParameter(): unknown { return true; },
    getShaderInfoLog(): unknown { return ''; },
    deleteShader(): void {},
    createProgram(): unknown { return { pid: nextProg++ }; },
    attachShader(): void {},
    bindAttribLocation(): void {},
    linkProgram(): void {},
    getProgramParameter(): unknown { return true; },
    getProgramInfoLog(): unknown { return ''; },
    detachShader(): void {},
    deleteProgram(): void {},
    deleteShader2(): void {},
    getUniformLocation(_p: unknown, name: string): unknown { return { name } as UniformLoc; },
    createBuffer(): unknown { return { id: nextBuf++ }; },
    bindBuffer(): void {},
    bufferData(): void {},
    createTexture(): unknown { return { id: nextTex++ }; },
    bindTexture(): void {},
    texParameteri(): void {},
    texImage2D(): void {},
    activeTexture(): void {},
    useProgram(): void {},
    uniformMatrix4fv(): void {},
    uniform1f(l: unknown, v: number): void { calls.push(`uniform1f ${(l as UniformLoc).name} ${v}`); },
    uniform2f(): void {},
    uniform1i(l: unknown, v: number): void { calls.push(`uniform1i ${(l as UniformLoc).name} ${v}`); },
    uniform1fv(): void {},
    uniform3f(): void {},
    uniform4fv(): void {},
    uniform3fv(): void {},
    vertexAttribPointer(): void {},
    enableVertexAttribArray(): void {},
    drawElements(): void {},
    drawArrays(): void {},
    getExtension(name: string): unknown { return name === 'EXT_color_buffer_float' ? null : null; },
    createFramebuffer(): unknown { return { id: nextFb++ }; },
    bindFramebuffer(): void {},
    framebufferTexture2D(): void {},
    framebufferRenderbuffer(): void {},
    checkFramebufferStatus(): unknown { return GLC.FRAMEBUFFER_COMPLETE; },
    createRenderbuffer(): unknown { return { id: nextRb++ }; },
    bindRenderbuffer(): void {},
    renderbufferStorage(): void {},
  } as unknown as WebGL2RenderingContext;
  return { calls, gl };
}

describe('underwater screen-warp CPU mirror (D_WarpScreen divergence)', () => {
  it('phase is deterministic at fixed time (SPEED=20, CYCLE=128)', () => {
    expect(underwaterWarpPhaseFor(0)).toBe(0);
    expect(underwaterWarpPhaseFor(1.0)).toBe(20);
    expect(underwaterWarpPhaseFor(1.0)).toBe(underwaterWarpPhaseFor(1.0));
    expect(underwaterWarpPhaseFor(6.4)).toBe(0); // wraps every 6.4s
  });

  it('table ints are C-truncated 0..6 with known spots', () => {
    expect(underwaterWarpIntAt(0)).toBe(3);
    expect(underwaterWarpIntAt(32)).toBe(6);
    expect(underwaterWarpIntAt(64)).toBe(3);
    expect(underwaterWarpIntAt(96)).toBe(0);
    for (let i = 0; i < 1280; i++) {
      const v = underwaterWarpIntAt(i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(6);
    }
  });

  it('every dest maps inside the frame with bounded displacement', () => {
    for (const t of [0, 1.25, 2.75]) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const [sx, sy] = underwaterWarpSrc(x, y, W, H, t);
          expect(sx).toBeGreaterThanOrEqual(0);
          expect(sx).toBeLessThan(W);
          expect(sy).toBeGreaterThanOrEqual(0);
          expect(sy).toBeLessThan(H);
          expect(Math.abs(sx - x)).toBeLessThanOrEqual(7);
          expect(Math.abs(sy - y)).toBeLessThanOrEqual(7);
        }
      }
    }
  });

  it('moved clock moves the warp (phase runs on RefDef.time)', () => {
    const [ax, ay] = underwaterWarpSrc(10, 10, W, H, 1.0);
    const [bx, by] = underwaterWarpSrc(10, 10, W, H, 2.7);
    expect(ax !== bx || ay !== by).toBe(true);
  });
});

describe('underwater screen-warp shader + submission', () => {
  it('FS_APPEARANCE carries the warp uniforms and lookup', () => {
    expect(FS_APPEARANCE).toContain('uWarpOn');
    expect(FS_APPEARANCE).toContain('uWarpTime');
    expect(FS_APPEARANCE).toContain('warpSrcPx');
    expect(FS_APPEARANCE).toContain('warpIntAt');
  });

  it('dry render uploads uWarpOn 0; submerged uploads 1 + time', () => {
    const dry = stubGL();
    const r = new WebGLRenderer();
    r.init(dry.gl, W, H);
    const world = tinyWorld();
    r.attachWorld(world);
    r.setPalette(rampPalette());
    const scene: GpuSceneInput = selectGpuScene(world, [], refDef([0, 0, 0], 90), W, H);
    r.setScene(scene);
    r.setEntities([], undefined);
    const view = refDef([0, 0, 0], 90, 1.25);
    r.renderFrame({ view, scene, time: 1.25 } as GpuFrameInput);
    expect(dry.calls).toContain('uniform1i uWarpOn 0');

    const wet = stubGL();
    const r2 = new WebGLRenderer();
    r2.init(wet.gl, W, H);
    r2.attachWorld(world);
    r2.setPalette(rampPalette());
    r2.setScene(scene);
    r2.setEntities([], undefined);
    r2.renderFrame({ view, scene, time: 1.25, underwater: { submerged: true } });
    expect(wet.calls).toContain('uniform1i uWarpOn 1');
    expect(wet.calls).toContain('uniform1f uWarpTime 1.25');
  });
});
