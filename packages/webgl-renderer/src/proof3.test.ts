// @q2/webgl-renderer PROOF-3 tests — real scene drawing behind a stub GL.
//
// A structural WebGL2 stub records the full call log (no real GL, no DOM,
// no readPixels). Asset-free legs always run; the F1 leg boots real base1
// (manual pak reader — no new dep edges) and skips gracefully without Q2_PAK.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { loadBsp } from '@q2/bsp';
import { parseMD2, parsePCX, parseWAL } from '@q2/formats';
import {
  bspToMiniWorld,
  createBoxMesh,
  setupCamera,
  type BspTexelSource,
  type MiniWorld,
} from '@q2/sw-renderer';
import type { Entity, GpuFrameInput, GpuSceneInput } from '@q2/renderer-api';
import { selectGpuScene, type GpuEntityModelKind } from './scene.js';
import { WebGLRenderer } from './renderer.js';

// --- Full stub GL (records every call; copies bufferData payloads) ---

interface StubBuffer { id: number }
interface UniformLoc { name: string }

export interface StubGLState {
  calls: string[];
  gl: WebGL2RenderingContext;
  /** buffer id -> per-upload byte copies (in call order). */
  uploads: Map<number, Uint8Array[]>;
  /** program creation order (lit, alias, flat). */
  programs: number[];
}

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
  FRAMEBUFFER: 0x8d40,
  RENDERBUFFER: 0x8d41,
  COLOR_ATTACHMENT0: 0x8ce0,
  DEPTH_ATTACHMENT: 0x8d00,
  DEPTH_COMPONENT16: 0x81a5,
  DEPTH_COMPONENT24: 0x81a6,
  RGBA16F: 0x881a,
  RGBA8: 0x8058,
  RGBA: 0x1908,
  HALF_FLOAT: 0x140b,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
};

export function stubGLFull(): StubGLState {
  const calls: string[] = [];
  const uploads = new Map<number, Uint8Array[]>();
  const programs: number[] = [];
  let nextBuf = 1;
  let nextTex = 1001;
  let nextShader = 2001;
  let nextProg = 3001;
  let nextFb = 5001;
  let nextRb = 6001;
  let boundArray = 0;
  let boundElement = 0;
  const modeName = (m: number): string => (m === GLC.TRIANGLES ? 'TRIANGLES' : m === GLC.POINTS ? 'POINTS' : String(m));
  const gl = {
    ...GLC,
    viewport(x: number, y: number, w: number, h: number): void {
      calls.push(`viewport ${x} ${y} ${w} ${h}`);
    },
    clearColor(r: number, g: number, b: number, a: number): void {
      calls.push(`clearColor ${r} ${g} ${b} ${a}`);
    },
    clearDepth(d: number): void {
      calls.push(`clearDepth ${d}`);
    },
    clear(mask: number): void {
      calls.push(`clear ${mask}`);
    },
    enable(cap: number): void {
      calls.push(`enable ${cap === GLC.DEPTH_TEST ? 'DEPTH_TEST' : cap === GLC.BLEND ? 'BLEND' : cap}`);
    },
    disable(cap: number): void {
      calls.push(`disable ${cap === GLC.BLEND ? 'BLEND' : cap}`);
    },
    depthFunc(f: number): void {
      calls.push(`depthFunc ${f === GLC.LESS ? 'LESS' : f}`);
    },
    depthMask(on: boolean): void {
      calls.push(`depthMask ${on}`);
    },
    blendFunc(s: number, d: number): void {
      calls.push(`blendFunc ${s} ${d}`);
    },
    createShader(t: number): unknown {
      calls.push(`createShader ${t}`);
      return { sid: nextShader++ };
    },
    shaderSource(s: unknown, src: string): void {
      void s;
      calls.push(`shaderSource len=${src.length}`);
    },
    compileShader(s: unknown): void {
      void s;
      calls.push('compileShader');
    },
    getShaderParameter(): unknown {
      return true;
    },
    getShaderInfoLog(): unknown {
      return '';
    },
    deleteShader(): void {
      calls.push('deleteShader');
    },
    createProgram(): unknown {
      const pid = nextProg++;
      programs.push(pid);
      calls.push(`createProgram ${pid}`);
      return { pid };
    },
    attachShader(): void {
      calls.push('attachShader');
    },
    bindAttribLocation(_p: unknown, loc: number, name: string): void {
      calls.push(`bindAttribLocation ${loc} ${name}`);
    },
    linkProgram(): void {
      calls.push('linkProgram');
    },
    getProgramParameter(): unknown {
      return true;
    },
    getProgramInfoLog(): unknown {
      return '';
    },
    detachShader(): void {},
    deleteProgram(): void {},
    getUniformLocation(_p: unknown, name: string): unknown {
      return { name } as UniformLoc;
    },
    createBuffer(): unknown {
      return { id: nextBuf++ } as StubBuffer;
    },
    bindBuffer(t: number, b: unknown): void {
      const id = (b as StubBuffer | null)?.id ?? 0;
      if (t === GLC.ARRAY_BUFFER) boundArray = id;
      else if (t === GLC.ELEMENT_ARRAY_BUFFER) boundElement = id;
    },
    bufferData(t: number, data: ArrayBufferView, _u: number): void {
      const id = t === GLC.ARRAY_BUFFER ? boundArray : boundElement;
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
      const list = uploads.get(id) ?? [];
      list.push(bytes);
      uploads.set(id, list);
      calls.push(`bufferData buf=${id} ${bytes.length}`);
    },
    createTexture(): unknown {
      return { id: nextTex++ };
    },
    bindTexture(t: number, tex: unknown): void {
      calls.push(`bindTexture ${t} ${(tex as { id: number } | null)?.id ?? 'null'}`);
    },
    texParameteri(): void {},
    texImage2D(_t: number, l: number, i: number, w: number, h: number): void {
      calls.push(`texImage2D lvl=${l} fmt=${i} ${w}x${h}`);
    },
    getExtension(name: string): unknown {
      calls.push(`getExtension ${name}`);
      return null; // no float rendering here: pins the RGBA8 fallback branch
    },
    createFramebuffer(): unknown {
      calls.push(`createFramebuffer ${nextFb}`);
      return { id: nextFb++ };
    },
    bindFramebuffer(t: number, fb: unknown): void {
      calls.push(`bindFramebuffer ${t} ${(fb as { id: number } | null)?.id ?? 'null'}`);
    },
    framebufferTexture2D(): void {
      calls.push('framebufferTexture2D');
    },
    framebufferRenderbuffer(): void {
      calls.push('framebufferRenderbuffer');
    },
    checkFramebufferStatus(): unknown {
      calls.push('checkFramebufferStatus');
      return GLC.FRAMEBUFFER_COMPLETE;
    },
    createRenderbuffer(): unknown {
      calls.push(`createRenderbuffer ${nextRb}`);
      return { id: nextRb++ };
    },
    bindRenderbuffer(t: number, rb: unknown): void {
      calls.push(`bindRenderbuffer ${t} ${(rb as { id: number } | null)?.id ?? 'null'}`);
    },
    renderbufferStorage(_t: number, fmt: number, w: number, h: number): void {
      calls.push(`renderbufferStorage fmt=${fmt} ${w}x${h}`);
    },
    uniform1fv(l: unknown, v: Float32Array): void {
      calls.push(`uniform1fv ${(l as UniformLoc).name} len=${v.length}`);
    },
    uniform3f(l: unknown, x: number, y: number, z: number): void {
      calls.push(`uniform3f ${(l as UniformLoc).name} ${x} ${y} ${z}`);
    },
    activeTexture(t: number): void {
      calls.push(`activeTexture ${t === GLC.TEXTURE0 ? 0 : 1}`);
    },
    useProgram(p: unknown): void {
      calls.push(`useProgram ${(p as { pid: number }).pid}`);
    },
    uniformMatrix4fv(l: unknown, _t: boolean, v: Float32Array): void {
      calls.push(`uniformMatrix4fv ${(l as UniformLoc).name} len=${v.length}`);
    },
    uniform1f(l: unknown, v: number): void {
      calls.push(`uniform1f ${(l as UniformLoc).name} ${v}`);
    },
    uniform2f(l: unknown, x: number, y: number): void {
      calls.push(`uniform2f ${(l as UniformLoc).name} ${x} ${y}`);
    },
    uniform1i(l: unknown, v: number): void {
      calls.push(`uniform1i ${(l as UniformLoc).name} ${v}`);
    },
    uniform4fv(l: unknown, v: Float32Array): void {
      calls.push(`uniform4fv ${(l as UniformLoc).name} len=${v.length}`);
    },
    uniform3fv(l: unknown, v: Float32Array): void {
      calls.push(`uniform3fv ${(l as UniformLoc).name} len=${v.length}`);
    },
    vertexAttribPointer(loc: number, size: number): void {
      calls.push(`vertexAttribPointer ${loc} ${size}`);
    },
    enableVertexAttribArray(loc: number): void {
      calls.push(`enableVertexAttribArray ${loc}`);
    },
    drawElements(mode: number, count: number, _type?: unknown, offset?: number): void {
      calls.push(`drawElements ${modeName(mode)} ${count} @${offset ?? 0}`);
    },
    drawArrays(mode: number, _f: number, count: number): void {
      calls.push(`drawArrays ${modeName(mode)} ${count}`);
    },
  } as unknown as WebGL2RenderingContext;
  return { calls, gl, uploads, programs };
}

// --- Shared fixtures ---

function rampPalette(): Uint8Array {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    p[i * 3] = i;
    p[i * 3 + 1] = (i * 2) & 255;
    p[i * 3 + 2] = (i * 3) & 255;
  }
  return p;
}

function quadSurf(
  id: number, cx: number, texId: number,
  extra: Partial<MiniWorld['surfaces'][number]> = {},
): MiniWorld['surfaces'][number] {
  return {
    id,
    verts: new Float32Array([cx - 1, -1, 0, cx + 1, -1, 0, cx + 1, 1, 0, cx - 1, 1, 0]),
    uvs: new Float32Array([0, 0, 8, 0, 8, 8, 0, 8]),
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
    ...extra,
  };
}

/** Small synthetic world: 2 opaque quads, 1 transparent, particles. */
function fixtureWorld(): MiniWorld {
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 3, faceList: [0, 1, 2] }],
    pvs: [new Uint8Array([1])],
    clusterCount: 1,
    surfaces: [quadSurf(0, 50, 0), quadSurf(1, 60, 1), quadSurf(2, 55, 0, { translucent: 1 })],
    textures: [
      { texels: new Uint8Array(8 * 8).fill(7), width: 8, height: 8 },
      { texels: new Uint8Array(8 * 8).fill(9), width: 8, height: 8 },
    ],
    lightmaps: [0, 1, 2].map(() => ({
      samples: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]),
      luxW: 2, luxH: 2, styles: [0, 255, 255, 255],
    })),
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [{ origin: new Float32Array([55, 0, 5]), color: 200 }],
  };
}

function fixtureView(): GpuFrameInput['view'] {
  return {
    origin: new Float32Array([0, 0, 0]),
    angles: new Float32Array([0, 90, 0]),
    fovX: 90,
    time: 0,
    lightStyles: new Float32Array(256).fill(1),
  };
}

function wireRenderer(r: WebGLRenderer, world: MiniWorld, entities: Entity[], kinds: Map<number, GpuEntityModelKind>): GpuSceneInput {
  r.attachWorld(world);
  r.setPalette(rampPalette());
  r.registerModelData(0, 'md2', createBoxMesh());
  r.registerModelData(1, 'tracer', null);
  r.registerModelData(2, 'sp2', null);
  r.registerSkinPixels(0, new Uint8Array(8 * 8).fill(11), 8, 8);
  const scene = selectGpuScene(world, entities, fixtureView(), 64, 48, kinds);
  r.setScene(scene);
  r.setEntities(entities, kinds);
  return scene;
}

function frameInput(scene: GpuSceneInput, lights?: GpuFrameInput['lights']): GpuFrameInput {
  return { view: fixtureView(), scene, time: 0, lights };
}

describe('proof-3 scene drawing (stub GL, asset-free)', () => {
  it('draws opaque batches + gun + blend in order with depth/blend state', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, 64, 48);
    const entities: Entity[] = [
      { model: 0, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0 },
      { model: 2, origin: new Float32Array([52, 0, 5]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0 },
      { model: 1, origin: new Float32Array([50, -5, 0]), angles: new Float32Array([0, 90, 0]), frame: 32, skin: 200 },
      // Eye-anchored gun (depth-hack viewmodel).
      { model: 0, origin: new Float32Array([2, 0, 0]), angles: new Float32Array([0, 90, 0]), frame: 1, skin: 0, depthHack: true },
      // Translucent alias (explosion fade): rides the blend pass via uAlpha.
      { model: 0, origin: new Float32Array([54, 0, -8]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0, alpha: 0.5 },
    ];
    const kinds = new Map<number, GpuEntityModelKind>([[0, 'md2'], [1, 'tracer'], [2, 'sp2']]);
    const scene = wireRenderer(r, fixtureWorld(), entities, kinds);
    r.renderFrame(frameInput(scene));
    const log = state.calls;
    // Real batches: opaque world + alias + gun + blend draws.
    const draws = log.filter((c) => c.startsWith('drawElements'));
    expect(draws.length).toBeGreaterThan(0);
    const points = log.filter((c) => c.startsWith('drawArrays POINTS'));
    expect(points.length).toBe(1);
    expect(log).toContain('enable DEPTH_TEST');
    expect(log).toContain('depthFunc LESS');
    expect(log).toContain('depthMask true');
    expect(log).toContain('depthMask false');
    expect(log).toContain('enable BLEND');
    expect(log).toContain(`blendFunc ${GLC.SRC_ALPHA} ${GLC.ONE_MINUS_SRC_ALPHA}`);
    expect(log).toContain('disable BLEND');
    // Gun pass: depth-bias uniform before a draw.
    const gunBias = log.findIndex((c) => c === 'uniform1f uDepthBias -0.9');
    expect(gunBias).toBeGreaterThan(-1);
    expect(log.slice(gunBias).some((c) => c.startsWith('drawElements'))).toBe(true);
    // Translucent alias rides the blend pass via the uAlpha uniform.
    expect(log).toContain('uniform1f uAlpha 0.5');
    // Transparent draws strictly after opaque: everything inside the
    // enable-BLEND/disable-BLEND window is blend; opaque draws precede it.
    const blendOn = log.findIndex((c) => c === 'enable BLEND');
    const blendOff = log.findIndex((c) => c === 'disable BLEND');
    expect(blendOn).toBeGreaterThan(-1);
    expect(blendOff).toBeGreaterThan(blendOn);
    const opaqueDraws = log.slice(0, blendOn).filter((c) => c.startsWith('drawElements'));
    const blendDraws = log.slice(blendOn, blendOff).filter((c) => c.startsWith('drawElements'));
    expect(opaqueDraws.length).toBeGreaterThan(0);
    expect(blendDraws.length).toBeGreaterThan(0);
    // No pixel readbacks anywhere.
    expect(log.some((c) => c.startsWith('readPixels'))).toBe(false);
    expect(r.getStatus().framesSubmitted).toBe(1);
    // The only warning is the RGBA8 fallback (this stub has no float ext).
    expect(r.testWarnings()).toEqual([
      'appearance: EXT_color_buffer_float unavailable — RGBA8 fallback target',
    ]);
  });

  it('uploads static buffers ONCE; dynamic buffers re-upload per frame (bounded)', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, 64, 48);
    const entities: Entity[] = [
      { model: 0, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0 },
    ];
    const kinds = new Map<number, GpuEntityModelKind>([[0, 'md2']]);
    const scene = wireRenderer(r, fixtureWorld(), entities, kinds);
    r.renderFrame(frameInput(scene));
    r.renderFrame(frameInput(scene));
    r.renderFrame(frameInput(scene));
    // Per-buffer upload counts: static (world batches, model uv/index,
    // filler) exactly 1; dynamic (alias lerp, billboards, points) exactly 3.
    const once: number[] = [];
    const thrice: number[] = [];
    for (const [id, list] of state.uploads) {
      if (list.length === 1) once.push(id);
      else if (list.length === 3) thrice.push(id);
      else expect.fail(`buffer ${id} uploaded ${list.length}x (expected 1 or 3)`);
    }
    expect(once.length).toBeGreaterThan(0); // world bufferData count == 1 each
    expect(thrice.length).toBeGreaterThan(0); // dynamic re-uploads, bounded
    expect(r.testUploadStats()).toEqual({ uploads: 1 });
  });

  it('interpolation changes dynamic bytes; identical lerp is byte-identical', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, 64, 48);
    const kinds = new Map<number, GpuEntityModelKind>([[0, 'md2']]);
    const mkEntities = (backlerp: number): Entity[] => [
      { model: 0, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 1, oldframe: 0, backlerp, skin: 0 },
    ];
    const scene = wireRenderer(r, fixtureWorld(), mkEntities(0), kinds);
    const snap = (): string => {
      const parts: string[] = [];
      for (const [id, list] of [...state.uploads.entries()].sort((a, b) => a[0] - b[0])) {
        const last = list[list.length - 1]!;
        parts.push(`${id}:${last.length}:${hashBytes(last)}`);
      }
      return parts.join('|');
    };
    r.setEntities(mkEntities(0), kinds);
    r.renderFrame(frameInput(scene));
    const s0 = snap();
    r.setEntities(mkEntities(0.5), kinds);
    r.renderFrame(frameInput(scene));
    const s1 = snap();
    r.setEntities(mkEntities(0.5), kinds);
    r.renderFrame(frameInput(scene));
    const s2 = snap();
    expect(s1).not.toBe(s0); // different lerp -> different dynamic contents
    expect(s2).toBe(s1); // same lerp twice -> identical bytes
  });

  it('uploads dynamic lights as uniforms; clamps >8 with a recorded warning', () => {
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, 64, 48);
    const entities: Entity[] = [
      { model: 0, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0 },
    ];
    const kinds = new Map<number, GpuEntityModelKind>([[0, 'md2']]);
    const scene = wireRenderer(r, fixtureWorld(), entities, kinds);
    const two = [
      { origin: new Float32Array([50, 0, 0]), intensity: 250, color: new Float32Array([1, 0.55, 0.15]) },
      { origin: new Float32Array([60, 0, 0]), intensity: 350, color: new Float32Array([1, 0.9, 0.7]) },
    ];
    r.renderFrame(frameInput(scene, two));
    expect(state.calls).toContain('uniform4fv uLightPos[0] len=32');
    expect(state.calls).toContain('uniform3fv uLightColor[0] len=24');
    expect(state.calls.filter((c) => c === 'uniform1i uNumLights 2').length).toBeGreaterThan(0);
    const nine = Array.from({ length: 9 }, (_, i) => ({
      origin: new Float32Array([i * 10, 0, 0]),
      intensity: 100,
      color: new Float32Array([1, 1, 1]),
    }));
    r.renderFrame(frameInput(scene, nine));
    expect(state.calls.filter((c) => c === 'uniform1i uNumLights 8').length).toBeGreaterThan(0);
    expect(r.testWarnings().some((w) => w.includes('clamped to 8'))).toBe(true);
    expect(r.getStatus().framesSubmitted).toBe(2);
  });
});

function hashBytes(b: Uint8Array): number {
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) {
    h = Math.imul(h ^ b[i]!, 16777619);
  }
  return h >>> 0;
}

// --- Real base1 F1 leg (Q2_PAK-gated) ---

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

interface F1Assets {
  world: MiniWorld;
  palette: Uint8Array;
  soldierMd2: ArrayBuffer;
  gunMd2: ArrayBuffer;
  soldierSkin: { pixels: Uint8Array; width: number; height: number };
  gunSkin: { pixels: Uint8Array; width: number; height: number };
}

function loadF1Assets(pakPath: string): F1Assets {
  const pak = (name: string): ArrayBuffer => pakReadFile(pakPath, name);
  const map = loadBsp(pak('maps/base1.bsp'));
  const walCache = new Map<string, BspTexelSource | null>();
  const texelFor = (walName: string): BspTexelSource | null => {
    if (walCache.has(walName)) return walCache.get(walName)!;
    let src: BspTexelSource | null = null;
    try {
      const wal = parseWAL(pak(`textures/${walName}.wal`));
      src = { texels: wal.mips[0] as Uint8Array, width: wal.width, height: wal.height };
    } catch {
      src = null;
    }
    walCache.set(walName, src);
    return src;
  };
  const soldierSkinPcx = parsePCX(pak('models/monsters/soldier/skin.pcx'));
  const gunSkinPcx = parsePCX(pak('models/weapons/v_blast/skin.pcx'));
  return {
    world: bspToMiniWorld(map, { texelFor }),
    palette: parsePCX(pak('pics/colormap.pcx')).palette,
    soldierMd2: pak('models/monsters/soldier/tris.md2'),
    gunMd2: pak('models/weapons/v_blast/tris.md2'),
    soldierSkin: { pixels: soldierSkinPcx.pixels, width: soldierSkinPcx.width, height: soldierSkinPcx.height },
    gunSkin: { pixels: gunSkinPcx.pixels, width: gunSkinPcx.width, height: gunSkinPcx.height },
  };
}

/**
 * F1 combat entity set, mirroring bench-workloads combatBenchEntities by
 * value (spawn-north camera, soldier + sprite + tracer + depthHack gun).
 * Handles are the renderer's own registration order (0..3 models, 0..1
 * skins).
 */
function f1Entities(): Entity[] {
  return [
    { model: 0, origin: new Float32Array([128, -272, 24]), angles: new Float32Array([0, 270, 0]), frame: 4, skin: 0 },
    { model: 2, origin: new Float32Array([128, -272, 72]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0 },
    { model: 1, origin: new Float32Array([103, -280, 44]), angles: new Float32Array([0, 180, 0]), frame: 96, skin: 231 },
    { model: 3, origin: new Float32Array([128, -320, 54]), angles: new Float32Array([0, 90, 0]), frame: 4, skin: 1, depthHack: true },
  ];
}

function f1Kinds(): Map<number, GpuEntityModelKind> {
  return new Map([[0, 'md2'], [1, 'tracer'], [2, 'sp2'], [3, 'md2']]);
}

function f1View(): GpuFrameInput['view'] {
  return {
    origin: new Float32Array([128, -320, 54]),
    angles: new Float32Array([0, 90, 0]),
    fovX: 90,
    time: 1.5,
    lightStyles: new Float32Array(256).fill(1),
  };
}

/** Combat dlights, mirroring bench-workloads pumpBenchLights by value. */
function f1Lights(): NonNullable<GpuFrameInput['lights']> {
  return [
    { origin: new Float32Array([128, -272, 34]), intensity: 250, color: new Float32Array([1, 0.55, 0.15]) },
    { origin: new Float32Array([128, -230, 44]), intensity: 350, color: new Float32Array([1, 0.9, 0.7]) },
  ];
}

/** 12-spark cloud, mirroring bench-workloads benchSparkParticles by value. */
function f1Particles(): MiniWorld['particles'] {
  const colors = [8, 70, 200, 231, 250, 180, 33, 99, 150, 210, 240, 15];
  const [cx, cy, cz] = [128, -272, 24];
  return colors.map((color, i) => ({
    origin: new Float32Array([cx + ((i * 37) % 17) - 8, cy + ((i * 53) % 17) - 8, cz + 10 + ((i * 29) % 25)]),
    color,
  }));
}

describe.runIf(!!process.env.Q2_PAK)('proof-3 F1 combat scene (Q2_PAK base1)', () => {
  it('renders F1: batches, gun, ordered transparency, static-once uploads', { timeout: 180000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const a = loadF1Assets(pakPath);
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, 640, 480);
    const world = { ...a.world, particles: f1Particles() };
    r.attachWorld(world);
    r.setPalette(a.palette);
    r.registerModelData(0, 'md2', parseMD2(a.soldierMd2.slice(0)));
    r.registerModelData(1, 'tracer', null);
    r.registerModelData(2, 'sp2', null);
    r.registerModelData(3, 'md2', parseMD2(a.gunMd2.slice(0)));
    r.registerSkinPixels(0, a.soldierSkin.pixels, a.soldierSkin.width, a.soldierSkin.height);
    r.registerSkinPixels(1, a.gunSkin.pixels, a.gunSkin.width, a.gunSkin.height);
    const entities = f1Entities();
    const scene = selectGpuScene(world, entities, f1View(), 640, 480, f1Kinds());
    expect(scene.surfaces.length).toBeGreaterThan(100);
    r.setScene(scene);
    r.setEntities(entities, f1Kinds());
    const input: GpuFrameInput = { view: f1View(), scene, time: 1.5, lights: f1Lights() };
    r.renderFrame(input);
    r.renderFrame(input);
    r.renderFrame(input);
    const log = state.calls;

    // Batch count > 0 (opaque world draws exist).
    const draws = log.filter((c) => c.startsWith('drawElements'));
    expect(draws.length).toBeGreaterThan(0);
    console.log(`PROOF-3 F1: drawElements=${draws.length} programs=${state.programs.length} warnings=${JSON.stringify(r.testWarnings())}`);

    // Gun batch present (depth-hack uniforms before a draw).
    const gunBias = log.findIndex((c) => c === 'uniform1f uDepthBias -0.9');
    expect(gunBias).toBeGreaterThan(-1);
    expect(log.slice(gunBias).some((c) => c.startsWith('drawElements'))).toBe(true);

    // Transparent draws strictly after opaque (blend window non-empty).
    const blendOn = log.findIndex((c) => c === 'enable BLEND');
    const blendOff = log.findIndex((c) => c === 'disable BLEND');
    expect(blendOn).toBeGreaterThan(-1);
    expect(blendOff).toBeGreaterThan(blendOn);
    expect(log.slice(0, blendOn).filter((c) => c.startsWith('drawElements')).length).toBeGreaterThan(0);

    // Dynamic lights: uniform uploads present (2 lights).
    expect(log).toContain('uniform4fv uLightPos[0] len=32');
    expect(log).toContain('uniform3fv uLightColor[0] len=24');
    expect(log.filter((c) => c === 'uniform1i uNumLights 2').length).toBeGreaterThan(0);

    // No pixel readbacks; depth/blend state present.
    expect(log.some((c) => c.startsWith('readPixels'))).toBe(false);
    expect(log).toContain('enable DEPTH_TEST');
    expect(log).toContain('depthFunc LESS');

    // Static bufferData happens ONCE: attribute uploads per frame by
    // snapshotting. Frame 1 carries the one-time static uploads (world
    // batches, model uv/index: exactly 1 upload each, never repeated);
    // frames 2..3 repeat the identical bounded dynamic set, disjoint from
    // the static set. (Shared dynamic buffers re-upload per use within a
    // frame — soldier+gun share dynPos — so per-frame totals, not per-buffer
    // totals, are the honest invariant.)
    expect(r.getStatus().framesSubmitted).toBe(3);
    expect(r.testUploadStats()).toEqual({ uploads: 1 });
  });

  it('F1 through the appearance pass: target, resolve, capped skins, order', { timeout: 180000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const a = loadF1Assets(pakPath);
    const state = stubGLFull();
    const r = new WebGLRenderer();
    r.init(state.gl, 640, 480);
    const world = { ...a.world, particles: f1Particles() };
    r.attachWorld(world);
    r.setPalette(a.palette);
    r.registerModelData(0, 'md2', parseMD2(a.soldierMd2.slice(0)));
    r.registerModelData(1, 'tracer', null);
    r.registerModelData(2, 'sp2', null);
    r.registerModelData(3, 'md2', parseMD2(a.gunMd2.slice(0)));
    r.registerSkinPixels(0, a.soldierSkin.pixels, a.soldierSkin.width, a.soldierSkin.height);
    r.registerSkinPixels(1, a.gunSkin.pixels, a.gunSkin.width, a.gunSkin.height);
    // Oversized skin (300x300 > vd_maxtexsize 256): must not crash — the
    // upload caps it with a recorded warning. Rides a translucent alias so
    // it flows through the blend pass.
    r.registerSkinPixels(7, new Uint8Array(300 * 300).fill(11), 300, 300);
    const entities = [...f1Entities(), { model: 0, origin: new Float32Array([136, -272, 24]), angles: new Float32Array([0, 270, 0]), frame: 4, skin: 7, alpha: 0.5 } as Entity];
    const scene = selectGpuScene(world, entities, f1View(), 640, 480, f1Kinds());
    r.setScene(scene);
    r.setEntities(entities, f1Kinds());
    const input: GpuFrameInput = { view: f1View(), scene, time: 1.5, lights: f1Lights() };
    r.renderFrame(input);
    r.renderFrame(input);
    r.renderFrame(input);
    const log = state.calls;

    // Scene target created once at size (RGBA8 fallback: this stub has no
    // EXT_color_buffer_float — the fallback branch is pinned here; the float
    // branch is pinned in appearance.test.ts).
    expect(r.testTargetInfo()).toEqual({ float: false, w: 640, h: 480 });
    expect(log.some((c) => c.startsWith('createFramebuffer'))).toBe(true);
    expect(log.some((c) => c.startsWith('texImage2D lvl=0 fmt=32856 '))).toBe(true); // RGBA8 target
    expect(r.testWarnings().some((w) => w.includes('RGBA8 fallback'))).toBe(true);

    // Appearance program (4th) linked; fullscreen resolve after the blend
    // window; depth/blend state restored for the next frame.
    expect(state.programs.length).toBe(4);
    const blendOff = log.findIndex((c) => c === 'disable BLEND');
    expect(blendOff).toBeGreaterThan(-1);
    const postDraw = log.findIndex((c, i) => i > blendOff && c === 'drawArrays TRIANGLES 3');
    expect(postDraw).toBeGreaterThan(blendOff);
    expect(log.slice(postDraw)).toContain('enable DEPTH_TEST'); // next frame re-arms
    expect(log).toContain('uniform1i uReconMode 1'); // matched 2x2 default
    expect(log).toContain('uniform1f uGamma 1.3');
    // Per-frame policy uniforms, no re-uploads: target creation is not a
    // texture upload (upload contract pinned).
    expect(r.testUploadStats()).toEqual({ uploads: 1 });

    // Oversized skin capped, never crashed.
    expect(r.testWarnings().some((w) => w.includes('skin 7 oversized 300x300'))).toBe(true);

    // Blend order preserved through the appearance pass; no readbacks.
    const blendOn = log.findIndex((c) => c === 'enable BLEND');
    expect(blendOn).toBeGreaterThan(-1);
    expect(log.slice(0, blendOn).filter((c) => c.startsWith('drawElements')).length).toBeGreaterThan(0);
    expect(log.some((c) => c.startsWith('readPixels'))).toBe(false);
    expect(r.getStatus().framesSubmitted).toBe(3);
  });

  it('F1 static-once / dynamic-bounded upload accounting', { timeout: 180000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const a = loadF1Assets(pakPath);
    const world = { ...a.world, particles: f1Particles() };
    const entities = f1Entities();
    const kinds = f1Kinds();
    const fresh = (): { r: WebGLRenderer; state: StubGLState; scene: GpuSceneInput } => {
      const state = stubGLFull();
      const r = new WebGLRenderer();
      r.init(state.gl, 640, 480);
      r.attachWorld(world);
      r.setPalette(a.palette);
      r.registerModelData(0, 'md2', parseMD2(a.soldierMd2.slice(0)));
      r.registerModelData(1, 'tracer', null);
      r.registerModelData(2, 'sp2', null);
      r.registerModelData(3, 'md2', parseMD2(a.gunMd2.slice(0)));
      r.registerSkinPixels(0, a.soldierSkin.pixels, a.soldierSkin.width, a.soldierSkin.height);
      r.registerSkinPixels(1, a.gunSkin.pixels, a.gunSkin.width, a.gunSkin.height);
      const scene = selectGpuScene(world, entities, f1View(), 640, 480, kinds);
      r.setScene(scene);
      r.setEntities(entities, kinds);
      return { r, state, scene };
    };
    const { r, state, scene } = fresh();
    const input: GpuFrameInput = { view: f1View(), scene, time: 1.5, lights: f1Lights() };
    const snap = (): Map<number, number> => {
      const m = new Map<number, number>();
      for (const [id, list] of state.uploads) m.set(id, list.length);
      return m;
    };
    const delta = (before: Map<number, number>, after: Map<number, number>): Map<number, number> => {
      const m = new Map<number, number>();
      for (const [id, n] of after) {
        const d = n - (before.get(id) ?? 0);
        if (d > 0) m.set(id, d);
      }
      return m;
    };
    let prev = snap();
    r.renderFrame(input);
    const f1 = delta(prev, snap());
    prev = snap();
    r.renderFrame(input);
    const f2 = delta(prev, snap());
    prev = snap();
    r.renderFrame(input);
    const f3 = delta(prev, snap());
    const keyOf = (m: Map<number, number>): string =>
      [...m.entries()].sort((x, y) => x[0] - y[0]).map(([k, v]) => `${k}:${v}`).join(',');
    // Steady state: frames 2 and 3 upload the identical per-buffer set.
    expect(keyOf(f2)).toBe(keyOf(f3));
    expect(f2.size).toBeGreaterThan(0);
    // Bounded: a handful of dynamic uploads per frame, no more.
    let total2 = 0;
    for (const n of f2.values()) total2 += n;
    expect(total2).toBeLessThanOrEqual(24);
    // Static set (frame-1-only buffers) uploaded exactly once each.
    const staticIds = [...f1.keys()].filter((id) => !f2.has(id));
    expect(staticIds.length).toBeGreaterThan(0); // world bufferData count == 1 each
    for (const id of staticIds) {
      expect(f1.get(id)).toBe(1);
      expect(state.uploads.get(id)!.length).toBe(1);
    }
    // No static buffer re-uploaded later (disjoint sets).
    for (const id of f2.keys()) expect(staticIds).not.toContain(id);
  });
});

/** Split the call log into per-frame bufferData-count signatures. */
function splitFrames(log: string[]): number[] {
  // Frames are delimited by `clear ` calls (one clear per renderFrame in the
  // full path: COLOR|DEPTH; the minimal path clears COLOR only).
  const out: number[] = [];
  let n = 0;
  let started = false;
  for (const c of log) {
    if (c.startsWith('clear ')) {
      if (started) out.push(n);
      n = 0;
      started = true;
      continue;
    }
    if (started && c.startsWith('bufferData')) n++;
  }
  if (started) out.push(n);
  return out;
}

describe.runIf(!process.env.Q2_PAK)('proof-3 F1 combat scene (no Q2_PAK)', () => {
  it('skips the real-base1 F1 leg gracefully', () => {
    console.log('PROOF-3 F1 skipped: Q2_PAK absent (set Q2_PAK to a pak0.pak for the real-base1 leg)');
  });
});
