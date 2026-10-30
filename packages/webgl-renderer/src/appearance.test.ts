// @q2/webgl-renderer appearance tests — GPU-PROOF-4 (Voodoo appearance).
//
// Pure units always run (no GL, no assets). Stub-GL legs pin the capability
// branches (float vs RGBA8 fallback), the appearance program/uniforms, and
// determinism (same frame twice -> identical call sequence). Q2_PAK-gated
// real-asset F1 legs live in proof3.test.ts (shared fixtures there).
// NO pixel-identity assertions here: mechanics + determinism only (the
// testkit lane owns toleranced capture comparison).

import { describe, expect, it } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import type { Entity, GpuFrameInput, GpuSceneInput } from '@q2/renderer-api';
import {
  bayerThreshold4,
  buildFogLUT01,
  buildGammaLUT,
  buildMipChainRGB,
  capCappedDims,
  DEFAULT_RGB_MAX_DELTA,
  ditherModeToInt,
  ditherOffsetG,
  ditherOffsetRB,
  downsampleToCap,
  expand565,
  fogTableIndex,
  gammaLUTValue,
  halveRGBBox,
  LOD_DITHER_MEAN,
  mipLevelFor,
  mipUVScale,
  pack565,
  parseDitherModeStr,
  parseReconModeStr,
  parseRgbMaxDeltaStr,
  pickMipLevelFor,
  PINNED_LOD_BIAS,
  reconModeToInt,
  resampleRGBBox,
  resolveAppearanceFrame,
  applyOverbrightCPU,
  BAYER2,
  BAYER4,
  DITHER_G2,
  DITHER_G4,
  DITHER_RB2,
  DITHER_RB4,
  FS_APPEARANCE,
  VS_POST,
} from './appearance.js';
import { selectGpuScene, type GpuEntityModelKind } from './scene.js';
import { WebGLRenderer } from './renderer.js';
import {
  createBoxMesh,
  type MiniWorld,
} from '@q2/sw-renderer';
import { compileProgram } from './shaders.js';

// --- Pure policy units (always run, no GL) ---

describe('appearance pure policy (CPU mirrors of the voodoo source)', () => {
  it('4x4 Bayer matrix phase matches the voodoo source values', () => {
    expect([...BAYER4]).toEqual([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
    expect(bayerThreshold4(0, 0)).toBe(0);
    expect(bayerThreshold4(1, 0)).toBe(8);
    expect(bayerThreshold4(0, 1)).toBe(12);
    expect(bayerThreshold4(3, 3)).toBe(5);
    // Absolute phase wraps every 4 (worker-band seamlessness rule).
    expect(bayerThreshold4(4, 0)).toBe(bayerThreshold4(0, 0));
    expect(bayerThreshold4(1, 5)).toBe(bayerThreshold4(1, 1));
    expect([...BAYER2]).toEqual([0, 2, 3, 1]);
  });

  it('dither offsets match the voodoo amplitudes (+-4 R/B, +-2 G)', () => {
    expect([...DITHER_RB4]).toEqual([-4, 0, -3, 1, 2, -2, 3, -1, -2, 2, -3, 1, 4, 0, 3, -1]);
    expect([...DITHER_G4]).toEqual([-2, 0, -1, 1, 1, -1, 2, 0, -1, 1, -2, 0, 2, 0, 1, -1]);
    expect([...DITHER_RB2]).toEqual([-3, 1, 3, -1]);
    expect([...DITHER_G2]).toEqual([-1, 1, 2, 0]);
    expect(ditherOffsetRB(0, 0)).toBe(-4);
    expect(ditherOffsetG(0, 0)).toBe(-2);
    expect(ditherOffsetRB(1, 0)).toBe(0);
    expect(ditherOffsetG(15, 15)).toBe(-1);
    expect(ditherOffsetRB(7, 9)).toBe(ditherOffsetRB(3, 1)); // phase wrap
  });

  it('RGB565 pack/expand is exact on ramps and spot values', () => {
    expect(pack565(255, 255, 255)).toBe(0xffff);
    expect(pack565(0, 0, 0)).toBe(0);
    expect(pack565(248, 252, 248)).toBe(0xffff);
    expect(pack565(8, 4, 8)).toBe(0x0821);
    expect(expand565(0xffff)).toEqual([255, 255, 255]);
    expect(expand565(0)).toEqual([0, 0, 0]);
    // Full ramps stay in-range and monotone per channel.
    let prev = -1;
    for (let r = 0; r < 256; r++) {
      const [e] = expand565(pack565(r, 0, 0));
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(255);
      expect(e).toBeGreaterThanOrEqual(prev - 8); // quantum is 8
      prev = e;
    }
    let prevG = -1;
    for (let g = 0; g < 256; g++) {
      const [, e] = expand565(pack565(0, g, 0));
      expect(e).toBeGreaterThanOrEqual(prevG - 4);
      prevG = e;
    }
  });

  it('gamma LUT(1.3) spot values match the CPU reference curve', () => {
    expect(gammaLUTValue(0, 1.3)).toBe(0);
    expect(gammaLUTValue(255, 1.3)).toBe(255);
    expect(gammaLUTValue(128, 1.3)).toBe(150); // pinned CPU reference value
    expect(gammaLUTValue(128, 1)).toBe(128);
    const lut = buildGammaLUT(1.3);
    expect(lut.length).toBe(256);
    for (let i = 1; i < 256; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]!);
  });

  it('fog LUT shape: zero at near, ~full at far, monotone', () => {
    const lut = buildFogLUT01();
    expect(lut.length).toBe(64);
    expect(lut[0]).toBe(0);
    expect(lut[63]!).toBeGreaterThan(0.999);
    for (let i = 1; i < 64; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]!);
    expect(fogTableIndex(-1)).toBe(0);
    expect(fogTableIndex(0)).toBe(0);
    expect(fogTableIndex(0.5)).toBe(32);
    expect(fogTableIndex(1)).toBe(63);
    expect(fogTableIndex(2)).toBe(63);
  });

  it('mip-level selection: bias, +0.375 dither mean, Bayer pick, UV scale', () => {
    expect(PINNED_LOD_BIAS).toBeCloseTo(-0.35, 9);
    expect(LOD_DITHER_MEAN).toBe(0.375);
    // Table: rho, bias, maxLevel, mipDither, x, y -> level + uvScale.
    const rows: Array<{
      rho: number; bias: number; max: number; dither: boolean; x: number; y: number;
      level: number; scale: number;
    }> = [
      // lod = 0 + (-0.35) + 0.375 = +0.025 -> n=0, f=0.025*16=0.4.
      { rho: 1, bias: -0.35, max: 16, dither: true, x: 0, y: 0, level: 1, scale: 0.5 }, // b=0: 0.4<=0 false -> n+1
      { rho: 1, bias: -0.35, max: 16, dither: true, x: 1, y: 0, level: 0, scale: 1 }, // b=8: 0.4<=8 -> n
      // lod = 1 + 0.025 = 1.025 -> dither pick between 1 and 2 by phase.
      { rho: 2, bias: -0.35, max: 16, dither: true, x: 0, y: 0, level: 2, scale: 0.25 },
      { rho: 2, bias: -0.35, max: 16, dither: true, x: 1, y: 0, level: 1, scale: 0.5 },
      // No dither: round-to-nearest (1.025 -> 1).
      { rho: 2, bias: -0.35, max: 16, dither: false, x: 0, y: 0, level: 1, scale: 0.5 },
      { rho: 3, bias: -0.35, max: 16, dither: false, x: 3, y: 3, level: 1, scale: 0.5 },
      // maxLevel clamp.
      { rho: 8, bias: -0.35, max: 1, dither: true, x: 1, y: 0, level: 1, scale: 0.5 },
      // Magnification (rho 0) clamps to LOD 0.
      { rho: 0, bias: -0.35, max: 16, dither: true, x: 2, y: 2, level: 0, scale: 1 },
    ];
    for (const r of rows) {
      const lod = mipLevelFor(r.rho, r.bias, r.max, r.dither);
      const lvl = pickMipLevelFor(lod, r.x, r.y, r.dither, r.max);
      expect(lvl, `rho=${r.rho} x=${r.x} y=${r.y} d=${r.dither}`).toBe(r.level);
      expect(mipUVScale(lvl)).toBe(r.scale);
    }
    expect(mipUVScale(0)).toBe(1);
    expect(mipUVScale(4)).toBe(1 / 16);
    expect(() => mipLevelFor(NaN, -0.35)).toThrow();
  });

  it('dither pick is deterministic over a pixel grid', () => {
    const run = (): number[] => {
      const out: number[] = [];
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          out.push(pickMipLevelFor(mipLevelFor(2.7, -0.35, 16, true), x, y, true, 16));
        }
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('upload cap + resample: aspect-preserving, byte-shaped', () => {
    expect(capCappedDims(300, 300, 256)).toEqual({ w: 150, h: 150 });
    expect(capCappedDims(320, 200, 256)).toEqual({ w: 160, h: 100 });
    expect(capCappedDims(256, 256, 256)).toEqual({ w: 256, h: 256 });
    const rgb = new Uint8Array(8 * 8 * 3).fill(128);
    const half = halveRGBBox(rgb, 8, 8);
    expect([half.w, half.h]).toEqual([4, 4]);
    expect(half.data.length).toBe(4 * 4 * 3);
    const capped = downsampleToCap(rgb, 8, 8, 256);
    expect(capped.capped).toBe(false);
    const big = downsampleToCap(new Uint8Array(300 * 300 * 3).fill(64), 300, 300, 256);
    expect(big.capped).toBe(true);
    expect([big.w, big.h]).toEqual([150, 150]);
    expect(big.data.length).toBe(150 * 150 * 3);
    // Box average of a flat field is the field.
    expect(big.data[0]).toBe(64);
    // Odd dims cover the full footprint (3x1 -> average of all three).
    const row = new Uint8Array([0, 0, 0, 100, 100, 100, 200, 200, 200]);
    const one = resampleRGBBox(row, 3, 1, 1, 1);
    expect(one[0]).toBe(100);
  });

  it('scanout parsers + overbright CPU spot rule', () => {
    expect(parseDitherModeStr('2x2')).toBe('2x2');
    expect(parseDitherModeStr('nope')).toBe('4x4');
    expect(parseReconModeStr('legacy')).toBe('legacy');
    expect(parseReconModeStr('4x4sub+4x1')).toBe('4x4sub+4x1');
    expect(parseReconModeStr('nope')).toBe('2x2sub+2x2box');
    expect(parseRgbMaxDeltaStr('8,8,8')).toEqual([8, 8, 8]);
    expect(parseRgbMaxDeltaStr('0,0,0')).toEqual([0, 0, 0]);
    expect(DEFAULT_RGB_MAX_DELTA).toEqual([8, 8, 8]);
    expect(reconModeToInt('legacy')).toBe(0);
    expect(reconModeToInt('2x2sub+2x2box')).toBe(1);
    expect(reconModeToInt('4x4sub+4x1')).toBe(2);
    expect(ditherModeToInt('2x2')).toBe(0);
    expect(ditherModeToInt('4x4')).toBe(1);
    expect(applyOverbrightCPU(200, 200, true)).toBe(255); // clips like hardware
    expect(applyOverbrightCPU(100, 100, true)).toBe(78); // (100*100*2+127)/255
    expect(applyOverbrightCPU(100, 100, false)).toBe(39);
  });

  it('appearance GLSL is absolute-phase and alpha-preserving by review', () => {
    expect(FS_APPEARANCE).toContain('gl_FragCoord');
    expect(FS_APPEARANCE).toContain('texelFetch');
    // Every early-out path re-emits the fetched alpha (blend invariant).
    const outs = FS_APPEARANCE.match(/oColor = vec4\([^;]*,\s*alpha\)/g) ?? [];
    expect(outs.length).toBeGreaterThanOrEqual(2);
    // Postfilter-off arm quantizes per pixel (never stale), then gamma.
    expect(FS_APPEARANCE).toContain('uPostfilter == 0');
    expect(VS_POST).toContain('gl_VertexID');
    // Source pin for the covering-triangle bit math (overscan 4.0 corners).
    expect(VS_POST).toContain('(gl_VertexID & 1) << 2');
    expect(VS_POST).toContain('(gl_VertexID & 2) << 1');
    // Covering-triangle pin: replicate the VertexID bit math and require the
    // (-1,-1),(3,-1),(-1,3) triangle (every viewport fragment inside; a
    // (0,0),(2,0),(0,2) triangle covers only the x+y<=0 half — the
    // resolve-coverage fixture fails closed on it).
    const tri = [0, 1, 2].map((vid) => {
      const px = (vid & 1) << 2;
      const py = (vid & 2) << 1;
      return [px - 1, py - 1];
    });
    expect(tri).toEqual([[-1, -1], [3, -1], [-1, 3]]);
  });

  it('resolveAppearanceFrame snapshots the pinned defaults', () => {
    const ap = resolveAppearanceFrame();
    expect(ap).toMatchObject({
      dither: true, ditherMode: '4x4', postfilter: true, reconMode: '2x2sub+2x2box',
      use16bit: true, overbright: true, fogEnabled: true, lodBias: -0.35,
      mipDither: true, bilinear: true, maxtexsize: 256, zbits: 16, gamma: 1.3,
    });
    expect(ap.rgbMaxDelta).toEqual([8, 8, 8]);
  });
});

// --- Compact stub GL (float-capable toggle; records everything) ---

interface StubBuffer { id: number }
interface UniformLoc { name: string }

const GLC = {
  VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
  ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
  TEXTURE_2D: 0x0de1, TEXTURE0: 0x84c0, TEXTURE1: 0x84c1,
  RGB: 0x1907, RGBA: 0x1908, RGBA8: 0x8058, RGBA16F: 0x881a,
  UNSIGNED_BYTE: 0x1401, HALF_FLOAT: 0x140b, UNSIGNED_INT: 0x1405, FLOAT: 0x1406,
  LINEAR: 0x2601, NEAREST: 0x2600, CLAMP_TO_EDGE: 0x812f,
  COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x0100, DEPTH_TEST: 0x0b71, LESS: 0x0201,
  BLEND: 0x0be2, SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303,
  TRIANGLES: 0x0004, POINTS: 0x0000,
  TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
  FRAMEBUFFER: 0x8d40, RENDERBUFFER: 0x8d41, COLOR_ATTACHMENT0: 0x8ce0,
  DEPTH_ATTACHMENT: 0x8d00, DEPTH_COMPONENT16: 0x81a5, DEPTH_COMPONENT24: 0x81a6,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
};

function stubGLFloatCapable(floatCapable: boolean): { calls: string[]; gl: WebGL2RenderingContext } {
  const calls: string[] = [];
  let nextBuf = 1;
  let nextTex = 1001;
  let nextShader = 2001;
  let nextProg = 3001;
  let nextFb = 5001;
  let nextRb = 6001;
  const gl = {
    ...GLC,
    viewport(x: number, y: number, w: number, h: number): void { calls.push(`viewport ${x} ${y} ${w} ${h}`); },
    clearColor(r: number, g: number, b: number, a: number): void { calls.push(`clearColor ${r} ${g} ${b} ${a}`); },
    clearDepth(d: number): void { calls.push(`clearDepth ${d}`); },
    clear(m: number): void { calls.push(`clear ${m}`); },
    enable(c: number): void { calls.push(`enable ${c}`); },
    disable(c: number): void { calls.push(`disable ${c}`); },
    depthFunc(f: number): void { calls.push(`depthFunc ${f}`); },
    depthMask(on: boolean): void { calls.push(`depthMask ${on}`); },
    blendFunc(s: number, d: number): void { calls.push(`blendFunc ${s} ${d}`); },
    createShader(t: number): unknown { calls.push(`createShader ${t}`); return { sid: nextShader++ }; },
    shaderSource(s: unknown, src: string): void { void s; calls.push(`shaderSource len=${src.length}`); },
    compileShader(s: unknown): void { void s; calls.push('compileShader'); },
    getShaderParameter(): unknown { return true; },
    getShaderInfoLog(): unknown { return ''; },
    deleteShader(): void { calls.push('deleteShader'); },
    createProgram(): unknown { const pid = nextProg++; calls.push(`createProgram ${pid}`); return { pid }; },
    attachShader(): void { calls.push('attachShader'); },
    bindAttribLocation(_p: unknown, loc: number, name: string): void { calls.push(`bindAttribLocation ${loc} ${name}`); },
    linkProgram(): void { calls.push('linkProgram'); },
    getProgramParameter(): unknown { return true; },
    getProgramInfoLog(): unknown { return ''; },
    detachShader(): void {},
    deleteProgram(): void {},
    getUniformLocation(_p: unknown, name: string): unknown { return { name } as UniformLoc; },
    createBuffer(): unknown { return { id: nextBuf++ } as StubBuffer; },
    bindBuffer(): void {},
    bufferData(_t: number, data: ArrayBufferView): void { calls.push(`bufferData ${data.byteLength}`); },
    createTexture(): unknown { return { id: nextTex++ }; },
    bindTexture(t: number, tex: unknown): void { calls.push(`bindTexture ${t} ${(tex as { id: number } | null)?.id ?? 'null'}`); },
    texParameteri(): void {},
    texImage2D(_t: number, l: number, i: number, w: number, h: number): void {
      calls.push(`texImage2D lvl=${l} fmt=${i} ${w}x${h}`);
    },
    activeTexture(t: number): void { calls.push(`activeTexture ${t}`); },
    useProgram(p: unknown): void { calls.push(`useProgram ${(p as { pid: number }).pid}`); },
    uniformMatrix4fv(l: unknown, _t: boolean, v: Float32Array): void { calls.push(`uniformMatrix4fv ${(l as UniformLoc).name} len=${v.length}`); },
    uniform1f(l: unknown, v: number): void { calls.push(`uniform1f ${(l as UniformLoc).name} ${v}`); },
    uniform2f(l: unknown, x: number, y: number): void { calls.push(`uniform2f ${(l as UniformLoc).name} ${x} ${y}`); },
    uniform1i(l: unknown, v: number): void { calls.push(`uniform1i ${(l as UniformLoc).name} ${v}`); },
    uniform1fv(l: unknown, v: Float32Array): void { calls.push(`uniform1fv ${(l as UniformLoc).name} len=${v.length}`); },
    uniform3f(l: unknown, x: number, y: number, z: number): void { calls.push(`uniform3f ${(l as UniformLoc).name} ${x} ${y} ${z}`); },
    uniform4fv(l: unknown, v: Float32Array): void { calls.push(`uniform4fv ${(l as UniformLoc).name} len=${v.length}`); },
    uniform3fv(l: unknown, v: Float32Array): void { calls.push(`uniform3fv ${(l as UniformLoc).name} len=${v.length}`); },
    vertexAttribPointer(loc: number, size: number): void { calls.push(`vertexAttribPointer ${loc} ${size}`); },
    enableVertexAttribArray(loc: number): void { calls.push(`enableVertexAttribArray ${loc}`); },
    drawElements(mode: number, count: number): void { calls.push(`drawElements ${mode} ${count}`); },
    drawArrays(mode: number, _f: number, count: number): void { calls.push(`drawArrays ${mode} ${count}`); },
    getExtension(name: string): unknown {
      calls.push(`getExtension ${name}`);
      return floatCapable && name === 'EXT_color_buffer_float' ? {} : null;
    },
    createFramebuffer(): unknown { const id = nextFb++; calls.push(`createFramebuffer ${id}`); return { id }; },
    bindFramebuffer(t: number, fb: unknown): void {
      calls.push(`bindFramebuffer ${t} ${(fb as { id: number } | null)?.id ?? 'null'}`);
    },
    framebufferTexture2D(): void { calls.push('framebufferTexture2D'); },
    framebufferRenderbuffer(): void { calls.push('framebufferRenderbuffer'); },
    checkFramebufferStatus(): unknown { calls.push('checkFramebufferStatus'); return GLC.FRAMEBUFFER_COMPLETE; },
    createRenderbuffer(): unknown { const id = nextRb++; calls.push(`createRenderbuffer ${id}`); return { id }; },
    bindRenderbuffer(t: number, rb: unknown): void {
      calls.push(`bindRenderbuffer ${t} ${(rb as { id: number } | null)?.id ?? 'null'}`);
    },
    renderbufferStorage(_t: number, fmt: number, w: number, h: number): void {
      calls.push(`renderbufferStorage fmt=${fmt} ${w}x${h}`);
    },
  } as unknown as WebGL2RenderingContext;
  return { calls, gl };
}

// --- Tiny synthetic world (asset-free render path driver) ---

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
    particles: [{ origin: new Float32Array([50, 0, 5]), color: 200 }],
  };
}

function tinyView(): GpuFrameInput['view'] {
  return {
    origin: new Float32Array([0, 0, 0]),
    angles: new Float32Array([0, 90, 0]),
    fovX: 90, time: 0,
    lightStyles: new Float32Array(256).fill(1),
  };
}

function driveTiny(floatCapable: boolean): { calls: string[]; r: WebGLRenderer; scene: GpuSceneInput } {
  const { calls, gl } = stubGLFloatCapable(floatCapable);
  const r = new WebGLRenderer();
  r.init(gl, 64, 48);
  r.attachWorld(tinyWorld());
  r.setPalette(rampPalette());
  r.registerModelData(0, 'md2', createBoxMesh());
  r.registerSkinPixels(0, new Uint8Array(8 * 8).fill(11), 8, 8);
  const kinds = new Map<number, GpuEntityModelKind>([[0, 'md2']]);
  const entities: Entity[] = [
    { model: 0, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0 },
  ];
  const scene = selectGpuScene(tinyWorld(), entities, tinyView(), 64, 48, kinds);
  r.setScene(scene);
  r.setEntities(entities, kinds);
  r.renderFrame({ view: tinyView(), scene, time: 0 });
  return { calls, r, scene };
}

// --- Stub-GL appearance legs ---

describe('appearance stub-GL legs (capability branches + uniforms)', () => {
  it('appearance program compiles (4 programs: lit/alias/flat/post)', () => {
    const { gl } = stubGLFloatCapable(true);
    const prog = compileProgram(gl, VS_POST, FS_APPEARANCE);
    expect(prog).toBeTruthy();
  });

  it('float-capable GL gets an RGBA16F target; otherwise RGBA8 + one warning', () => {
    const floatLeg = driveTiny(true);
    expect(floatLeg.r.testTargetInfo()).toEqual({ float: true, w: 64, h: 48 });
    expect(floatLeg.calls.some((c) => c.startsWith('texImage2D lvl=0 fmt=34842 '))).toBe(true); // RGBA16F
    expect(floatLeg.r.testWarnings().some((w) => w.includes('RGBA8 fallback'))).toBe(false);

    const fallbackLeg = driveTiny(false);
    expect(fallbackLeg.r.testTargetInfo()).toEqual({ float: false, w: 64, h: 48 });
    expect(fallbackLeg.calls.some((c) => c.startsWith('texImage2D lvl=0 fmt=32856 '))).toBe(true); // RGBA8
    expect(fallbackLeg.r.testWarnings().filter((w) => w.includes('RGBA8 fallback')).length).toBe(1);
    // One fullscreen resolve per frame, after unbinding to the canvas.
    const unbind = fallbackLeg.calls.findIndex((c) => c === `bindFramebuffer 36160 null`);
    expect(unbind).toBeGreaterThan(-1);
    expect(fallbackLeg.calls.slice(unbind)).toContain(`drawArrays 4 3`);
  });

  it('target re-created on resize; uploads contract unaffected', () => {
    const { calls, gl } = stubGLFloatCapable(false);
    const r = new WebGLRenderer();
    r.init(gl, 64, 48);
    r.attachWorld(tinyWorld());
    r.setPalette(rampPalette());
    const scene: GpuSceneInput = {
      surfaces: [], transforms: [new Float32Array(16)], staticGeneration: 1,
    };
    r.setScene(scene);
    r.setEntities([], undefined);
    const view = tinyView();
    // Empty-surface scene still renders (world+palette present): linear
    // target created at size on first render.
    r.renderFrame({ view, scene, time: 0 });
    expect(r.testTargetInfo()).toEqual({ float: false, w: 64, h: 48 });
    // Resize drops the target (only the viewport GL call); re-created next render.
    const fbosBefore = calls.filter((c) => c.startsWith('createFramebuffer')).length;
    r.resize(128, 96);
    expect(calls.filter((c) => c.startsWith('createFramebuffer')).length).toBe(fbosBefore);
    expect(r.testTargetInfo()).toBe(null);
    r.renderFrame({ view, scene, time: 0 });
    expect(r.testTargetInfo()).toEqual({ float: false, w: 128, h: 96 });
    expect(r.testUploadStats()).toEqual({ uploads: 1 });
  });

  it('vd_reconmode legacy vs matched changes the tap sequence', () => {
    try {
      setCVar('vd_reconmode', 'legacy');
      const legacy = driveTiny(false);
      expect(legacy.calls).toContain('uniform1i uReconMode 0');
      setCVar('vd_reconmode', '2x2sub+2x2box');
      const matched = driveTiny(false);
      expect(matched.calls).toContain('uniform1i uReconMode 1');
      setCVar('vd_reconmode', '4x4sub+4x1');
      const row = driveTiny(false);
      expect(row.calls).toContain('uniform1i uReconMode 2');
    } finally {
      resetCVars();
    }
  });

  it('vd_postfilter=0 shows the quantized target (uniform 0, still resolved)', () => {
    try {
      setCVar('vd_postfilter', 0);
      const leg = driveTiny(false);
      expect(leg.calls).toContain('uniform1i uPostfilter 0');
      // Still resolves every frame: fullscreen draw present, no stale frame.
      expect(leg.calls).toContain(`drawArrays 4 3`);
    } finally {
      resetCVars();
    }
  });

  it('vd_16bit=0 debug bypass: gamma on, dither/recon off', () => {
    try {
      setCVar('vd_16bit', 0);
      const leg = driveTiny(false);
      expect(leg.calls).toContain('uniform1i u16bit 0');
      expect(leg.calls).toContain('uniform1f uGamma 1.3');
    } finally {
      resetCVars();
    }
  });

  it('FORCED fog: default frames carry zero contribution; override proves the LUT path', () => {
    // Default: capability on, scene contribution 0 (base1 rule).
    const base = driveTiny(false);
    expect(base.calls).toContain('uniform1i uFogEnabled 1');
    expect(base.calls).toContain('uniform1f uFogAmount 0');
    expect(base.calls).toContain('uniform1fv uFogTable len=64');
    // Forced: nonzero amount + color reach the scene programs.
    const { calls, gl } = stubGLFloatCapable(false);
    const r = new WebGLRenderer();
    r.init(gl, 64, 48);
    r.attachWorld(tinyWorld());
    r.setPalette(rampPalette());
    const kinds = new Map<number, GpuEntityModelKind>([[0, 'md2']]);
    const entities: Entity[] = [
      { model: 0, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0 },
    ];
    const scene = selectGpuScene(tinyWorld(), entities, tinyView(), 64, 48, kinds);
    r.setScene(scene);
    r.setEntities(entities, kinds);
    r.registerModelData(0, 'md2', createBoxMesh());
    r.registerSkinPixels(0, new Uint8Array(8 * 8).fill(11), 8, 8);
    r.setFogOverride(1, [1, 0.5, 0.25]);
    r.renderFrame({ view: tinyView(), scene, time: 0 });
    expect(calls).toContain('uniform1f uFogAmount 1');
    expect(calls).toContain('uniform3f uFogColor 1 0.5 0.25');
    expect(calls).toContain('uniform1fv uFogTable len=64');
    r.setFogOverride(null);
  });

  it('same frame twice -> identical stub call sequence (determinism)', () => {
    const { calls, gl } = stubGLFloatCapable(false);
    const r = new WebGLRenderer();
    r.init(gl, 64, 48);
    r.attachWorld(tinyWorld());
    r.setPalette(rampPalette());
    r.registerModelData(0, 'md2', createBoxMesh());
    r.registerSkinPixels(0, new Uint8Array(8 * 8).fill(11), 8, 8);
    const kinds = new Map<number, GpuEntityModelKind>([[0, 'md2']]);
    const entities: Entity[] = [
      { model: 0, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0 },
    ];
    const scene = selectGpuScene(tinyWorld(), entities, tinyView(), 64, 48, kinds);
    r.setScene(scene);
    r.setEntities(entities, kinds);
    const input = { view: tinyView(), scene, time: 0 };
    r.renderFrame(input); // warmup: static uploads + target creation
    const steady = calls.length;
    r.renderFrame(input);
    const first = calls.slice(steady);
    r.renderFrame(input);
    const second = calls.slice(steady + first.length);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it('oversized skins cap with a warning, never crash; uploads stay bounded', () => {
    const { calls, gl } = stubGLFloatCapable(false);
    void calls;
    const r = new WebGLRenderer();
    r.init(gl, 64, 48);
    r.attachWorld(tinyWorld());
    r.setPalette(rampPalette());
    r.registerModelData(0, 'md2', createBoxMesh());
    r.registerSkinPixels(9, new Uint8Array(300 * 300).fill(11), 300, 300);
    const kinds = new Map<number, GpuEntityModelKind>([[0, 'md2']]);
    const entities: Entity[] = [
      { model: 0, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 9, alpha: 0.5 },
    ];
    const scene = selectGpuScene(tinyWorld(), entities, tinyView(), 64, 48, kinds);
    r.setScene(scene);
    r.setEntities(entities, kinds);
    r.renderFrame({ view: tinyView(), scene, time: 0 });
    expect(r.getStatus().framesSubmitted).toBe(1);
    expect(r.testWarnings().some((w) => w.includes('skin 9 oversized 300x300'))).toBe(true);
    expect(r.testUploadStats()).toEqual({ uploads: 1 });
  });

  it('mip chains upload per level; shader clamps to the chain depth', () => {
    const leg = driveTiny(false);
    // 8x8 diffuse -> 4 levels (8,4,2,1): per-level texImage2D uploads.
    const chain = leg.calls.filter((c) => c.startsWith('texImage2D lvl='));
    expect(chain.length).toBeGreaterThan(2);
    expect(leg.calls).toContain('uniform1f uLodBias -0.35');
    expect(leg.calls).toContain('uniform1i uMipDither 1');
    expect(leg.calls.some((c) => c.startsWith('uniform1i uMaxLevel'))).toBe(true);
  });
});
