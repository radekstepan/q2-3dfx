// @q2/webgl-renderer RELEASE-10 lane — GPU-side cvar audit (box 1, GPU side).
//
// For every panel cvar, determines EFFECTIVE vs DECORATIVE on the webgl2 path
// with real evidence: a CPU mirror of FS_APPEARANCE (same algorithm the
// shader executes) proves pixel sensitivity per toggle, and stub-GL legs
// prove each toggle reaches GL state (uniform / sampler / storage format).
// Decorative cvars are pinned two ways: the per-frame appearance snapshot is
// bit-identical with exotic values set, and a full stub frame produces the
// identical GL call sequence.
//
// verdict summary (evidence in the tests below):
//   EFFECTIVE (live-uniform, pixel-observable): vd_16bit vd_dither
//     vd_dithermode vd_postfilter vd_reconmode vd_rgbmaxdelta vd_gamma
//     vd_overbright vd_fog vd_lodbias vd_mipdither vd_bilinear
//   EFFECTIVE (upload-time: applies to textures uploaded AFTER the toggle;
//     cached uploads are NOT resampled — pinned below): vd_maxtexsize
//   EFFECTIVE (target-creation: applies at FBO creation; a live toggle is
//     inert until resize/recreate — pinned below): vd_zbits
//   DECORATIVE (zero production reads in this package — grep-verified, only
//     appearance.ts doc entries name them): vd_palettetex sw_gamma
//     sw_stipplealpha r_drawworld r_translucency sw_workers sw_wasm sw_accum
//
// Conditional notes (config-lane input, not silent-disable traps):
//   - vd_dithermode matters only when vd_dither=1 AND vd_16bit=1 (pinned: no
//     pixel change with dither off). The scanout SUBTRACT matrix is dictated
//     by vd_reconmode, never by vd_dithermode (matched-reinforcement rule).
//   - vd_reconmode / vd_rgbmaxdelta matter only when vd_postfilter=1 AND
//     vd_16bit=1 (postfilter-off arm skips reconstruction entirely).
//   - vd_fog gates live state, but the scene contribution (uFogAmount) is 0
//     in base1, so toggling it changes no base1 pixel (pinned: uniform flips
//     1->0 while the GLSL early-outs on amount 0). Observable with fog
//     content (forced-fog hook proves the gate is honored, not dead).
//   - vd_zbits changes the depth STORAGE format only; pixel impact is limited
//     to depth-tie scenes (banding-only approx on the CPU side is unrelated).
//   - sw_gamma is NOT read here by design (no sw_* read exists in this
//     package): the GPU's gamma role is played by vd_gamma (RAMDAC placement
//     after reconstruction). Answers "why does appearance read a
//     software-named cvar": it doesn't.

import { describe, expect, it } from 'vitest';
import { listCVars, resetCVars, setCVar } from '@q2/config';
import type { Entity, GpuFrameInput, GpuSceneInput } from '@q2/renderer-api';
import {
  APPEARANCE_CVAR_DOC,
  DITHER_G2,
  DITHER_G4,
  DITHER_RB2,
  DITHER_RB4,
  GPU_CVAR_GAPS,
  resolveAppearanceFrame,
  type AppearanceFrame,
} from './appearance.js';
import { selectGpuScene, type GpuEntityModelKind } from './scene.js';
import { WebGLRenderer } from './renderer.js';
import { createBoxMesh, type MiniWorld } from '@q2/sw-renderer';

// --- CPU mirror of FS_APPEARANCE (same algorithm, f64) -----------------------
// Sensitivity evidence only: proves the documented algorithm's output moves
// when a cvar toggles. GLSL f32 vs mirror f64 may differ by ~1 LSB at exact
// quantum boundaries; every assertion below compares mirror-vs-mirror
// (default vs toggled through the SAME code), so no bit-exactness with the
// shader is claimed or needed. The production link is cited per test via the
// FS_APPEARANCE uniform/arm the stub legs prove live.

type RGB = [number, number, number];

function mirrorResolve(src: Uint8Array, w: number, h: number, ap: AppearanceFrame): Uint8Array {
  const tap = (x: number, y: number): RGB => {
    const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
    const o = (cy * w + cx) * 3;
    return [src[o]!, src[o + 1]!, src[o + 2]!];
  };
  const dOff = (x: number, y: number): RGB => {
    if (ap.ditherMode === '2x2') {
      const p = ((y & 1) << 1) | (x & 1);
      return [DITHER_RB2[p]!, DITHER_G2[p]!, DITHER_RB2[p]!];
    }
    const p = ((y & 3) << 2) | (x & 3);
    return [DITHER_RB4[p]!, DITHER_G4[p]!, DITHER_RB4[p]!];
  };
  // Subtract matrix is dictated by the RECON mode, never by ditherMode
  // (FS_APPEARANCE subOffAt(subPhase(px, two), two): two=1 for matched-2x2,
  // two=0 for 4x4; legacy never subtracts).
  const subOff = (x: number, y: number): RGB => {
    if (ap.reconMode === '4x4sub+4x1') return dOff(x, y); // 4x4 tables
    const p = ((y & 1) << 1) | (x & 1);
    return [DITHER_RB2[p]!, DITHER_G2[p]!, DITHER_RB2[p]!]; // 2x2 tables
  };
  const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
  const quant = (x: number, y: number): RGB => {
    let [r, g, b] = tap(x, y);
    if (ap.dither) {
      const [dr, dg, db] = dOff(x, y);
      r += dr;
      g += dg;
      b += db;
    }
    r = clamp255(r);
    g = clamp255(g);
    b = clamp255(b);
    const r5 = Math.floor(r / 8);
    const g6 = Math.floor(g / 4);
    const b5 = Math.floor(b / 8);
    return [r5 * 8 + Math.floor(r5 / 4), g6 * 4 + Math.floor(g6 / 16), b5 * 8 + Math.floor(b5 / 4)];
  };
  const subTapGate = (tap: RGB, centre: RGB): RGB => {
    const [dr, dg, db] = ap.rgbMaxDelta;
    if (dr === 0 && dg === 0 && db === 0) return tap;
    return [
      Math.abs(tap[0] - centre[0]) > dr ? centre[0] : tap[0],
      Math.abs(tap[1] - centre[1]) > dg ? centre[1] : tap[1],
      Math.abs(tap[2] - centre[2]) > db ? centre[2] : tap[2],
    ];
  };
  const sub = (q: RGB, x: number, y: number): RGB => {
    if (!ap.dither) return q; // ditherSub = null rule
    const [sr, sg, sb] = subOff(x, y);
    return [clamp255(q[0] - sr), clamp255(q[1] - sg), clamp255(q[2] - sb)];
  };
  const box = (a: RGB, b: RGB, c: RGB, d: RGB): RGB => [
    Math.floor((a[0] + b[0] + c[0] + d[0] + 2) / 4),
    Math.floor((a[1] + b[1] + c[1] + d[1] + 2) / 4),
    Math.floor((a[2] + b[2] + c[2] + d[2] + 2) / 4),
  ];
  const out = new Uint8Array(w * h * 3);
  const gamma = ap.gamma;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let col: RGB;
      if (!ap.use16bit) {
        col = tap(x, y); // RGB888 debug bypass (u16bit==0 arm)
      } else if (!ap.postfilter) {
        col = quant(x, y); // postfilter-off arm: quantized target, then gamma
      } else if (ap.reconMode === 'legacy') {
        col = box(quant(x, y), quant(x + 1, y), quant(x, y + 1), quant(x + 1, y + 1));
      } else if (ap.reconMode === '4x4sub+4x1') {
        const pts: Array<[number, number]> = [[x - 1, y], [x, y], [x + 1, y], [x + 2, y]];
        const qs = pts.map(([px, py]) => sub(quant(px, py), px, py));
        const ctr = qs[1]!;
        const f = [subTapGate(qs[0]!, ctr), ctr, subTapGate(qs[2]!, ctr), subTapGate(qs[3]!, ctr)];
        col = box(f[0]!, f[1]!, f[2]!, f[3]!);
      } else {
        const qs: Array<{ q: RGB; px: number; py: number }> = [
          { q: quant(x, y), px: x, py: y },
          { q: quant(x + 1, y), px: x + 1, py: y },
          { q: quant(x, y + 1), px: x, py: y + 1 },
          { q: quant(x + 1, y + 1), px: x + 1, py: y + 1 },
        ].map((t) => ({ ...t, q: sub(t.q, t.px, t.py) }));
        const [a, b, c, d] = [qs[0]!.q, qs[1]!.q, qs[2]!.q, qs[3]!.q];
        col = box(a, subTapGate(b, a), subTapGate(c, a), subTapGate(d, a));
      }
      const o = (y * w + x) * 3;
      const g = gamma <= 0 || !Number.isFinite(gamma) ? 1 : 1 / gamma;
      out[o] = Math.round(255 * Math.pow(col[0] / 255, g));
      out[o + 1] = Math.round(255 * Math.pow(col[1] / 255, g));
      out[o + 2] = Math.round(255 * Math.pow(col[2] / 255, g));
    }
  }
  return out;
}

/** Smooth mid-tone gradient crossing many 565 quantum boundaries. */
function gradientFixture(w: number, h: number): Uint8Array {
  const img = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      img[o] = 96 + x * 3 + y * 5;
      img[o + 1] = 100 + x * 2 + y * 7;
      img[o + 2] = 92 + x * 5 + y * 3;
    }
  }
  return img;
}

/** Hard vertical edge (gate-rejection probe for vd_rgbmaxdelta). */
function edgeFixture(w: number, h: number): Uint8Array {
  const img = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = x < w / 2 ? 40 : 200;
      const o = (y * w + x) * 3;
      img[o] = v;
      img[o + 1] = v;
      img[o + 2] = v;
    }
  }
  return img;
}

function diffStats(a: Uint8Array, b: Uint8Array): { diffBytes: number; maxAbs: number } {
  let diffBytes = 0;
  let maxAbs = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > 0) diffBytes++;
    if (d > maxAbs) maxAbs = d;
  }
  return { diffBytes, maxAbs };
}

function withCvar<T>(name: string, value: number | string, fn: () => T): T {
  try {
    setCVar(name, value);
    return fn();
  } finally {
    resetCVars();
  }
}

// --- Compact recording stub GL (texParameteri + storage formats recorded) ---

const GLC = {
  VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
  ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
  TEXTURE_2D: 0x0de1, TEXTURE0: 0x84c0, TEXTURE1: 0x84c1,
  RGBA8: 0x8058, RGBA16F: 0x881a, RGBA: 0x1908, HALF_FLOAT: 0x140b,
  UNSIGNED_BYTE: 0x1401, UNSIGNED_INT: 0x1405, FLOAT: 0x1406,
  LINEAR: 0x2601, NEAREST: 0x2600,
  TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
  COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x0100, DEPTH_TEST: 0x0b71, LESS: 0x0201,
  BLEND: 0x0be2, SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303,
  TRIANGLES: 0x0004, POINTS: 0x0000,
  FRAMEBUFFER: 0x8d40, RENDERBUFFER: 0x8d41, COLOR_ATTACHMENT0: 0x8ce0,
  DEPTH_ATTACHMENT: 0x8d00, DEPTH_COMPONENT16: 0x81a5, DEPTH_COMPONENT24: 0x81a6,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
};

function stubGLRecording(): { calls: string[]; gl: WebGL2RenderingContext } {
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
    deleteShader2(): void {},
    getUniformLocation(_p: unknown, name: string): unknown { return { name }; },
    createBuffer(): unknown { return { id: nextBuf++ }; },
    bindBuffer(): void {},
    bufferData(_t: number, data: ArrayBufferView): void { calls.push(`bufferData ${data.byteLength}`); },
    createTexture(): unknown { return { id: nextTex++ }; },
    bindTexture(t: number, tex: unknown): void { calls.push(`bindTexture ${t} ${(tex as { id: number } | null)?.id ?? 'null'}`); },
    texParameteri(_t: number, pname: number, param: number): void {
      calls.push(`texParameteri ${pname} ${param}`);
    },
    texImage2D(_t: number, l: number, i: number, w: number, h: number): void {
      calls.push(`texImage2D lvl=${l} fmt=${i} ${w}x${h}`);
    },
    activeTexture(t: number): void { calls.push(`activeTexture ${t}`); },
    useProgram(p: unknown): void { calls.push(`useProgram ${(p as { pid: number }).pid}`); },
    uniformMatrix4fv(l: unknown, _t: boolean, v: Float32Array): void { calls.push(`uniformMatrix4fv ${(l as { name: string }).name} len=${v.length}`); },
    uniform1f(l: unknown, v: number): void { calls.push(`uniform1f ${(l as { name: string }).name} ${v}`); },
    uniform2f(l: unknown, x: number, y: number): void { calls.push(`uniform2f ${(l as { name: string }).name} ${x} ${y}`); },
    uniform1i(l: unknown, v: number): void { calls.push(`uniform1i ${(l as { name: string }).name} ${v}`); },
    uniform1fv(l: unknown, v: Float32Array): void { calls.push(`uniform1fv ${(l as { name: string }).name} len=${v.length}`); },
    uniform3f(l: unknown, x: number, y: number, z: number): void { calls.push(`uniform3f ${(l as { name: string }).name} ${x} ${y} ${z}`); },
    uniform4fv(l: unknown, v: Float32Array): void { calls.push(`uniform4fv ${(l as { name: string }).name} len=${v.length}`); },
    uniform3fv(l: unknown, v: Float32Array): void { calls.push(`uniform3fv ${(l as { name: string }).name} len=${v.length}`); },
    vertexAttribPointer(loc: number, size: number): void { calls.push(`vertexAttribPointer ${loc} ${size}`); },
    enableVertexAttribArray(loc: number): void { calls.push(`enableVertexAttribArray ${loc}`); },
    drawElements(mode: number, count: number): void { calls.push(`drawElements ${mode} ${count}`); },
    drawArrays(mode: number, _f: number, count: number): void { calls.push(`drawArrays ${mode} ${count}`); },
    getExtension(name: string): unknown {
      calls.push(`getExtension ${name}`);
      return null; // RGBA8 fallback branch (float-capable path is pinned elsewhere)
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

/** Drive one full stub frame (warm static path incl. appearance resolve). */
function driveFrame(stub: { calls: string[]; gl: WebGL2RenderingContext }): WebGLRenderer {
  const r = new WebGLRenderer();
  r.init(stub.gl, 64, 48);
  r.attachWorld(tinyWorld());
  r.setPalette(rampPalette());
  r.registerModelData(0, 'md2', createBoxMesh());
  r.registerSkinPixels(0, new Uint8Array(8 * 8).fill(11), 8, 8);
  const kinds = new Map<number, GpuEntityModelKind>([[0, 'md2']]);
  const entities: Entity[] = [
    { model: 0, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 0 },
  ];
  const scene = selectGpuScene(tinyWorld(), entities, tinyView(), 64, 48, kinds);
  const view = tinyView();
  r.setScene(scene);
  r.setEntities(entities, kinds);
  r.renderFrame({ view, scene, time: 0 });
  return r;
}

// --- RELEASE-10 box 1: EFFECTIVE cvars (mirror pixel sensitivity) -----------

describe('RELEASE-10 GPU audit: scanout-profile cvars move pixels (CPU mirror of FS_APPEARANCE)', () => {
  const W = 8;
  const H = 8;

  it('vd_dither on/off changes quantized pixels (FS_APPEARANCE uDitherOn -> quantTap dither add)', () => {
    const img = gradientFixture(W, H);
    const on = mirrorResolve(img, W, H, resolveAppearanceFrame());
    const off = withCvar('vd_dither', 0, () => mirrorResolve(img, W, H, resolveAppearanceFrame()));
    const { diffBytes, maxAbs } = diffStats(on, off);
    expect(diffBytes).toBeGreaterThan(0);
    expect(maxAbs).toBeGreaterThanOrEqual(1);
  });

  it('vd_dithermode 4x4/2x2 changes pixels when dither is on (uDitherMode -> ditherOffAt)', () => {
    const img = gradientFixture(W, H);
    const def = mirrorResolve(img, W, H, resolveAppearanceFrame());
    const alt = withCvar('vd_dithermode', '2x2', () => mirrorResolve(img, W, H, resolveAppearanceFrame()));
    expect(diffStats(def, alt).diffBytes).toBeGreaterThan(0);
  });

  it('vd_dithermode is inert when vd_dither=0 (no dither add, no subtract: ditherSub=null rule)', () => {
    const img = gradientFixture(W, H);
    const eq = withCvar('vd_dither', 0, () =>
      withCvar('vd_dithermode', '2x2', () => mirrorResolve(img, W, H, resolveAppearanceFrame())));
    const base = withCvar('vd_dither', 0, () => mirrorResolve(img, W, H, resolveAppearanceFrame()));
    expect(diffStats(eq, base).diffBytes).toBe(0);
  });

  it('vd_postfilter off shows the quantized target (uPostfilter arm skips reconstruction)', () => {
    const img = gradientFixture(W, H);
    const on = mirrorResolve(img, W, H, resolveAppearanceFrame());
    const off = withCvar('vd_postfilter', 0, () => mirrorResolve(img, W, H, resolveAppearanceFrame()));
    expect(diffStats(on, off).diffBytes).toBeGreaterThan(0);
  });

  it('vd_reconmode legacy vs matched changes taps (unconditional box, no subtract, no gate)', () => {
    const img = gradientFixture(W, H);
    const matched = mirrorResolve(img, W, H, resolveAppearanceFrame());
    const legacy = withCvar('vd_reconmode', 'legacy', () => mirrorResolve(img, W, H, resolveAppearanceFrame()));
    expect(diffStats(matched, legacy).diffBytes).toBeGreaterThan(0);
  });

  it('vd_reconmode 4x4sub+4x1 vs 2x2sub+2x2box changes the window (centered row vs 2x2)', () => {
    const img = gradientFixture(W, H);
    const def = mirrorResolve(img, W, H, resolveAppearanceFrame());
    const row = withCvar('vd_reconmode', '4x4sub+4x1', () => mirrorResolve(img, W, H, resolveAppearanceFrame()));
    expect(diffStats(def, row).diffBytes).toBeGreaterThan(0);
  });

  it('vd_rgbmaxdelta 8,8,8 vs 0,0,0 differs on a hard edge (gate rejects straddling windows)', () => {
    const img = edgeFixture(W, H);
    const gated = mirrorResolve(img, W, H, resolveAppearanceFrame());
    const flat = withCvar('vd_rgbmaxdelta', '0,0,0', () => mirrorResolve(img, W, H, resolveAppearanceFrame()));
    const { diffBytes, maxAbs } = diffStats(gated, flat);
    expect(diffBytes).toBeGreaterThan(0);
    expect(maxAbs).toBeGreaterThan(10); // edge blend vs kept centre tap
  });

  it('vd_gamma moves mid-tones (uGamma display-stage transfer after reconstruction)', () => {
    const img = gradientFixture(W, H);
    const def = mirrorResolve(img, W, H, resolveAppearanceFrame());
    const alt = withCvar('vd_gamma', 2.2, () => mirrorResolve(img, W, H, resolveAppearanceFrame()));
    const { diffBytes, maxAbs } = diffStats(def, alt);
    expect(diffBytes).toBeGreaterThan(0);
    expect(maxAbs).toBeGreaterThan(5);
  });

  it('vd_16bit=0 bypasses quantize+reconstruction (u16bit==0 arm: fetch + gamma only)', () => {
    const img = gradientFixture(W, H);
    const on = mirrorResolve(img, W, H, resolveAppearanceFrame());
    const off = withCvar('vd_16bit', 0, () => mirrorResolve(img, W, H, resolveAppearanceFrame()));
    expect(diffStats(on, off).diffBytes).toBeGreaterThan(0);
  });
});

// --- RELEASE-10 box 1: EFFECTIVE cvars (stub-GL wiring legs) ----------------

describe('RELEASE-10 GPU audit: toggles reach live GL state (stub legs)', () => {
  it('vd_dither/vd_dithermode/vd_postfilter/vd_reconmode/vd_rgbmaxdelta/vd_gamma/vd_16bit hit FS_APPEARANCE uniforms', () => {
    try {
      const base = stubGLRecording();
      driveFrame(base);
      expect(base.calls).toContain('uniform1i uDitherOn 1');
      expect(base.calls).toContain('uniform1i uDitherMode 1'); // 4x4
      expect(base.calls).toContain('uniform1i uPostfilter 1');
      expect(base.calls).toContain('uniform1i uReconMode 1'); // matched 2x2
      expect(base.calls).toContain('uniform3f uRgbMaxDelta 8 8 8');
      expect(base.calls).toContain('uniform1f uGamma 1.3');
      expect(base.calls).toContain('uniform1i u16bit 1');

      const toggled = stubGLRecording();
      setCVar('vd_dither', 0);
      setCVar('vd_dithermode', '2x2');
      setCVar('vd_postfilter', 0);
      setCVar('vd_reconmode', 'legacy');
      setCVar('vd_rgbmaxdelta', '0,0,0');
      setCVar('vd_gamma', 2.2);
      setCVar('vd_16bit', 0);
      driveFrame(toggled);
      expect(toggled.calls).toContain('uniform1i uDitherOn 0');
      expect(toggled.calls).toContain('uniform1i uDitherMode 0'); // 2x2
      expect(toggled.calls).toContain('uniform1i uPostfilter 0');
      expect(toggled.calls).toContain('uniform1i uReconMode 0'); // legacy
      expect(toggled.calls).toContain('uniform3f uRgbMaxDelta 0 0 0');
      expect(toggled.calls).toContain('uniform1f uGamma 2.2');
      expect(toggled.calls).toContain('uniform1i u16bit 0');
    } finally {
      resetCVars();
    }
  });

  it('vd_dithermode doc matches live behavior: the GPU honors it via uDitherMode', () => {
    // Reconciled (RELEASE-10 integrator): the config registry documents
    // vd_dithermode as a live WebGL uniform (the old "read-path only"
    // wording was stale). This test pins the reconciled doc AND the live
    // uniform so the two can never silently disagree again.
    const doc = listCVars().find((c) => c.name === 'vd_dithermode')?.doc ?? '';
    expect(doc).toContain('live');
    try {
      const def = stubGLRecording();
      driveFrame(def);
      expect(def.calls).toContain('uniform1i uDitherMode 1');
      setCVar('vd_dithermode', '2x2');
      const alt = stubGLRecording();
      driveFrame(alt);
      expect(alt.calls).toContain('uniform1i uDitherMode 0');
    } finally {
      resetCVars();
    }
  });

  it('vd_overbright toggles the uOverbright modulate (2 vs 1)', () => {
    try {
      const on = stubGLRecording();
      driveFrame(on);
      expect(on.calls).toContain('uniform1f uOverbright 2');
      setCVar('vd_overbright', 0);
      const off = stubGLRecording();
      driveFrame(off);
      expect(off.calls).toContain('uniform1f uOverbright 1');
    } finally {
      resetCVars();
    }
  });

  it('vd_lodbias / vd_mipdither reach the mip policy uniforms live (no re-upload)', () => {
    try {
      const def = stubGLRecording();
      driveFrame(def);
      expect(def.calls).toContain('uniform1f uLodBias -0.35');
      expect(def.calls).toContain('uniform1i uMipDither 1');
      setCVar('vd_lodbias', 0);
      setCVar('vd_mipdither', 0);
      const alt = stubGLRecording();
      driveFrame(alt);
      expect(alt.calls).toContain('uniform1f uLodBias 0');
      expect(alt.calls).toContain('uniform1i uMipDither 0');
    } finally {
      resetCVars();
    }
  });

  it('vd_bilinear switches sampler filtering live (LINEAR vs NEAREST params, no re-upload)', () => {
    const MIN = GLC.TEXTURE_MIN_FILTER;
    const MAG = GLC.TEXTURE_MAG_FILTER;
    const LIN = GLC.LINEAR;
    const NEAR = GLC.NEAREST;
    try {
      // Warm frame creates the target (target setup always uses LINEAR for
      // the scene color texture — filter the POST-warmup draws only).
      const stub = stubGLRecording();
      const r = new WebGLRenderer();
      r.init(stub.gl, 64, 48);
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
      const input: GpuFrameInput = { view: tinyView(), scene, time: 0 };
      r.renderFrame(input); // warmup: target creation + uploads
      stub.calls.length = 0;
      r.renderFrame(input); // steady state, default bilinear
      const linDraws = stub.calls.filter((c) => c === `texParameteri ${MIN} ${LIN}` || c === `texParameteri ${MAG} ${LIN}`);
      expect(linDraws.length).toBeGreaterThan(0);
      expect(stub.calls.some((c) => c === `texParameteri ${MIN} ${NEAR}`)).toBe(false);

      setCVar('vd_bilinear', 0);
      stub.calls.length = 0;
      r.renderFrame(input); // same scene, same uploads — only params change
      const nearDraws = stub.calls.filter((c) => c === `texParameteri ${MIN} ${NEAR}` || c === `texParameteri ${MAG} ${NEAR}`);
      expect(nearDraws.length).toBeGreaterThan(0);
      expect(stub.calls.some((c) => c === `texParameteri ${MIN} ${LIN}`)).toBe(false);
    } finally {
      resetCVars();
    }
  });

  it('vd_fog gates the live uniform (honored), but base1 carries zero scene contribution', () => {
    try {
      const def = stubGLRecording();
      driveFrame(def);
      expect(def.calls).toContain('uniform1i uFogEnabled 1');
      expect(def.calls).toContain('uniform1f uFogAmount 0'); // base1 rule: no haze
      setCVar('vd_fog', 0);
      const off = stubGLRecording();
      driveFrame(off);
      expect(off.calls).toContain('uniform1i uFogEnabled 0');
      expect(off.calls).toContain('uniform1f uFogAmount 0');
    } finally {
      resetCVars();
    }
  });

  it('vd_maxtexsize is upload-time: fresh uploads resample, live toggles do not retro-resample', () => {
    const skin = new Uint8Array(300 * 300).fill(11);
    const driveBig = (stub: { calls: string[]; gl: WebGL2RenderingContext }): { r: WebGLRenderer; scene: GpuSceneInput } => {
      const r = new WebGLRenderer();
      r.init(stub.gl, 64, 48);
      r.attachWorld(tinyWorld());
      r.setPalette(rampPalette());
      r.registerModelData(0, 'md2', createBoxMesh());
      r.registerSkinPixels(9, skin, 300, 300);
      const kinds = new Map<number, GpuEntityModelKind>([[0, 'md2']]);
      const entities: Entity[] = [
        { model: 0, origin: new Float32Array([50, 0, -10]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 9, alpha: 0.5 },
      ];
      const scene = selectGpuScene(tinyWorld(), entities, tinyView(), 64, 48, kinds);
      r.setScene(scene);
      r.setEntities(entities, kinds);
      r.renderFrame({ view: tinyView(), scene, time: 0 });
      return { r, scene };
    };
    try {
      const def = stubGLRecording();
      const { r: rDef, scene } = driveBig(def);
      expect(rDef.testWarnings().some((w) => w.includes('skin 9 oversized 300x300 (resampled to 150x150)'))).toBe(true);
      expect(def.calls.some((c) => c.endsWith(' 150x150'))).toBe(true);

      // Live toggle on the SAME renderer/scene: cached uploads stand (no
      // retro-resample, no new warning until the next upload generation).
      setCVar('vd_maxtexsize', 64);
      const warnsBefore = rDef.testWarnings().length;
      const texBefore = def.calls.filter((c) => c.startsWith('texImage2D')).length;
      rDef.renderFrame({ view: tinyView(), scene, time: 0 });
      expect(rDef.testWarnings().length).toBe(warnsBefore);
      expect(def.calls.filter((c) => c.startsWith('texImage2D')).length).toBe(texBefore);

      // A fresh upload generation at 64 resamples deeper (upload-time gate).
      const small = stubGLRecording();
      const { r: rSmall } = driveBig(small);
      expect(rSmall.testWarnings().some((w) => w.includes('skin 9 oversized 300x300 (resampled to 37x37)'))).toBe(true);
      expect(small.calls.some((c) => c.endsWith(' 37x37'))).toBe(true);
      expect(small.calls.some((c) => c.endsWith(' 150x150'))).toBe(false);
    } finally {
      resetCVars();
    }
  });

  it('vd_zbits selects the depth storage format at target creation (live toggle latent until resize)', () => {
    const D16 = GLC.DEPTH_COMPONENT16;
    const D24 = GLC.DEPTH_COMPONENT24;
    try {
      const def = stubGLRecording();
      const rDef = new WebGLRenderer();
      rDef.init(def.gl, 64, 48);
      rDef.attachWorld(tinyWorld());
      rDef.setPalette(rampPalette());
      const kinds = new Map<number, GpuEntityModelKind>();
      const scene: GpuSceneInput = {
        surfaces: [], transforms: [new Float32Array(16)], staticGeneration: 1,
      };
      rDef.setScene(scene);
      rDef.setEntities([], kinds);
      const input: GpuFrameInput = { view: tinyView(), scene, time: 0 };
      rDef.renderFrame(input);
      expect(def.calls.some((c) => c === `renderbufferStorage fmt=${D16} 64x48`)).toBe(true);

      setCVar('vd_zbits', 24);
      const before = def.calls.length;
      rDef.renderFrame(input); // live toggle: target cached, format stands
      expect(def.calls.slice(before).some((c) => c.startsWith('renderbufferStorage'))).toBe(false);

      rDef.resize(128, 96); // target recreation picks up the new depth format
      rDef.renderFrame(input);
      expect(def.calls.some((c) => c === `renderbufferStorage fmt=${D24} 128x96`)).toBe(true);
    } finally {
      resetCVars();
    }
  });
});

// --- RELEASE-10 box 1: DECORATIVE cvars (no GPU consumer) --------------------

const DECORATIVE: Array<[string, number | string]> = [
  ['vd_palettetex', 0],
  ['sw_gamma', 2.5],
  ['sw_stipplealpha', 1],
  ['r_drawworld', 0],
  ['r_translucency', 0],
  ['sw_workers', 8],
  ['sw_wasm', 1],
  ['sw_accum', 0],
];

describe('RELEASE-10 GPU audit: decorative cvars change nothing on the GPU path', () => {
  it('no decorative cvar perturbs the per-frame appearance snapshot', () => {
    const before = JSON.stringify(resolveAppearanceFrame());
    try {
      for (const [name, value] of DECORATIVE) setCVar(name, value);
      expect(JSON.stringify(resolveAppearanceFrame())).toBe(before);
    } finally {
      resetCVars();
    }
  });

  it('a full stub frame with every decorative cvar toggled is GL-identical to defaults', () => {
    const def = stubGLRecording();
    driveFrame(def);
    try {
      for (const [name, value] of DECORATIVE) setCVar(name, value);
      const alt = stubGLRecording();
      driveFrame(alt);
      expect(alt.calls).toEqual(def.calls);
    } finally {
      resetCVars();
    }
  });

  it('contract tables back the config lane mapping: gaps are policy-notes, palettetex is not live', () => {
    const gapNames = new Set(GPU_CVAR_GAPS.map((g) => g.cvar));
    for (const [name] of DECORATIVE) {
      if (name === 'vd_palettetex') continue; // documented in APPEARANCE_CVAR_DOC instead
      expect(gapNames.has(name), name).toBe(true);
    }
    for (const g of GPU_CVAR_GAPS) {
      expect(g.kind).toBe('policy-note');
      expect(g.note).toMatch(/UNSUPPORTED|NOT READ/);
    }
    const docByName = new Map(APPEARANCE_CVAR_DOC.map((d) => [d.cvar, d]));
    expect(docByName.get('vd_palettetex')?.kind).toBe('policy-note');
    for (const live of [
      'vd_gamma', 'vd_dither', 'vd_dithermode', 'vd_postfilter', 'vd_reconmode',
      'vd_rgbmaxdelta', 'vd_16bit', 'vd_overbright', 'vd_fog', 'vd_lodbias',
      'vd_mipdither', 'vd_bilinear',
    ]) {
      expect(docByName.get(live)?.kind).toBe('live-uniform');
    }
    expect(docByName.get('vd_maxtexsize')?.kind).toBe('upload-time');
    expect(docByName.get('vd_zbits')?.kind).toBe('target-creation');
  });
});
