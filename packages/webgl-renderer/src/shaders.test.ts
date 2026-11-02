// @q2/webgl-renderer shaders tests — source reviewability + compile errors.
//
// The GLSL sources are exported consts so they stay reviewable; these tests
// pin the required features (texture() sampling, lightmap uniform, alpha).
// compileProgram is exercised against a structural stub (records calls).

import { describe, expect, it } from 'vitest';
import {
  compileProgram,
  FS_ALIAS,
  FS_FLAT,
  FS_LIT,
  VS_ALIAS,
  VS_FLAT,
  VS_LIT,
} from './shaders.js';
import { FS_APPEARANCE, VS_POST } from './appearance.js';

function stubGL(opts: { compileOk?: boolean; linkOk?: boolean; infoLog?: string } = {}): {
  calls: string[];
  gl: WebGL2RenderingContext;
} {
  const calls: string[] = [];
  const { compileOk = true, linkOk = true, infoLog = '' } = opts;
  let nextShader = 1;
  let nextProg = 100;
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    createShader(type: number): unknown {
      calls.push(`createShader ${type}`);
      return { sid: nextShader++ };
    },
    shaderSource(sh: unknown, src: string): void {
      calls.push(`shaderSource ${(sh as { sid: number }).sid} len=${src.length}`);
    },
    compileShader(sh: unknown): void {
      calls.push(`compileShader ${(sh as { sid: number }).sid}`);
    },
    getShaderParameter(sh: unknown, p: number): unknown {
      calls.push(`getShaderParameter ${(sh as { sid: number }).sid} ${p}`);
      return compileOk;
    },
    getShaderInfoLog(sh: unknown): unknown {
      calls.push(`getShaderInfoLog ${(sh as { sid: number }).sid}`);
      return infoLog;
    },
    deleteShader(sh: unknown): void {
      calls.push(`deleteShader ${(sh as { sid: number }).sid}`);
    },
    createProgram(): unknown {
      calls.push('createProgram');
      return { pid: nextProg++ };
    },
    attachShader(p: unknown, sh: unknown): void {
      calls.push(`attachShader ${(p as { pid: number }).pid} ${(sh as { sid: number }).sid}`);
    },
    bindAttribLocation(p: unknown, loc: number, name: string): void {
      calls.push(`bindAttribLocation ${(p as { pid: number }).pid} ${loc} ${name}`);
    },
    linkProgram(p: unknown): void {
      calls.push(`linkProgram ${(p as { pid: number }).pid}`);
    },
    getProgramParameter(p: unknown, q: number): unknown {
      calls.push(`getProgramParameter ${(p as { pid: number }).pid} ${q}`);
      return linkOk;
    },
    getProgramInfoLog(p: unknown): unknown {
      calls.push(`getProgramInfoLog ${(p as { pid: number }).pid}`);
      return infoLog;
    },
    detachShader(p: unknown, sh: unknown): void {
      calls.push(`detachShader ${(p as { pid: number }).pid} ${(sh as { sid: number }).sid}`);
    },
    deleteProgram(p: unknown): void {
      calls.push(`deleteProgram ${(p as { pid: number }).pid}`);
    },
  } as unknown as WebGL2RenderingContext;
  return { calls, gl };
}

describe('proof-3 shader sources (reviewable consts)', () => {
  it('all six sources are GLSL ES 3.00', () => {
    for (const src of [VS_LIT, FS_LIT, VS_ALIAS, FS_ALIAS, VS_FLAT, FS_FLAT]) {
      expect(src).toContain('#version 300 es');
    }
  });

  it('lit program samples texture() with a lightmap uniform and alpha varying', () => {
    expect(FS_LIT).toContain('texture(');
    expect(FS_LIT).toContain('uLightmap');
    expect(FS_LIT).toContain('uDiffuse');
    expect(FS_LIT).toContain('vAlpha');
    expect(VS_LIT).toContain('aAlpha');
    expect(FS_LIT).toContain('uLightPos');
    expect(FS_LIT).toContain('uNumLights');
  });

  it('lit program carries the single-TMU mip + fog/overbright policy (PROOF-4)', () => {
    expect(FS_LIT).toContain('textureLod');
    expect(FS_LIT).toContain('uLodBias');
    expect(FS_LIT).toContain('uMipDither');
    expect(FS_LIT).toContain('uMaxLevel');
    expect(FS_LIT).toContain('uOverbright');
    expect(FS_LIT).toContain('uFogTable');
    expect(FS_LIT).toContain('vFogW');
    expect(VS_LIT).toContain('vFogW');
  });

  it('alias program samples texture() with per-pixel dlights + shade base', () => {
    expect(FS_ALIAS).toContain('textureLod');
    expect(FS_ALIAS).toContain('uDiffuse');
    expect(FS_ALIAS).toContain('vShade');
    expect(FS_ALIAS).toContain('uShadeBase');
    expect(FS_ALIAS).toContain('uLightPos');
    expect(FS_ALIAS).toContain('uAlpha');
    expect(FS_ALIAS).toContain('uLodBias');
    expect(FS_ALIAS).toContain('uFogTable');
    expect(VS_ALIAS).toContain('uUVScale');
    // Dynamic lights arrive in world space, so the dlight varying must be
    // world space too: uModel transforms model-space verts for the
    // per-pixel distance (previously vWorldPos = aPos compared model-space
    // verts against world-space lights, pushing every light out of range
    // for entities away from the origin).
    expect(VS_ALIAS).toContain('uniform mat4 uModel');
    expect(VS_ALIAS).toContain('uModel * vec4(aPos, 1.0)');
  });

  it('flat program supports textured (sprite) and vertex-color (beam/particle) modes', () => {
    expect(FS_FLAT).toContain('textureLod');
    expect(FS_FLAT).toContain('uTextured');
    expect(FS_FLAT).toContain('uMap');
    expect(FS_FLAT).toContain('vColor');
    expect(FS_FLAT).toContain('uFogTable');
    expect(VS_FLAT).toContain('gl_PointSize');
  });

  it('appearance pass is a reviewable fullscreen resolve (dither/565/recon/gamma)', () => {
    expect(VS_POST).toContain('gl_VertexID');
    expect(FS_APPEARANCE).toContain('#version 300 es');
    expect(FS_APPEARANCE).toContain('texelFetch');
    expect(FS_APPEARANCE).toContain('uReconMode');
    expect(FS_APPEARANCE).toContain('uRgbMaxDelta');
    expect(FS_APPEARANCE).toContain('uGamma');
    expect(FS_APPEARANCE).toContain('u16bit');
    expect(FS_APPEARANCE).toContain('gl_FragCoord');
  });
});

describe('compileProgram (stub GL)', () => {
  it('links the lit program and binds fixed attribute locations', () => {
    const { calls, gl } = stubGL();
    const prog = compileProgram(gl, VS_LIT, FS_LIT);
    expect(prog).toBeTruthy();
    expect(calls).toContain('bindAttribLocation 100 0 aPos');
    expect(calls).toContain('bindAttribLocation 100 1 aUV');
    expect(calls).toContain('linkProgram 100');
  });

  it('vertex compile failure throws with the shader info log', () => {
    const { gl } = stubGL({ compileOk: false, infoLog: 'vertex boom: syntax' });
    expect(() => compileProgram(gl, VS_LIT, FS_LIT)).toThrow(/vertex boom: syntax/);
  });

  it('fragment compile failure throws with the shader info log', () => {
    // First shader (vertex) succeeds, second (fragment) fails: alternate by
    // making only the second createShader return a failing handle is stub-
    // complex, so fail-all and assert the fragment stage is named. To keep
    // it simple: the stub fails every compile; the vertex error surfaces
    // first. The fragment path is covered by the link test below plus a
    // dedicated alternating stub.
    let n = 0;
    const { gl } = stubGL();
    const inner = gl;
    (gl as unknown as Record<string, unknown>).getShaderParameter = () => ++n === 1;
    (gl as unknown as Record<string, unknown>).getShaderInfoLog = () => 'fragment boom: type';
    expect(() => compileProgram(inner, VS_LIT, FS_LIT)).toThrow(/fragment.*fragment boom: type/s);
  });

  it('link failure throws with the program info log', () => {
    const { gl } = stubGL({ linkOk: false, infoLog: 'link boom: varyings' });
    expect(() => compileProgram(gl, VS_LIT, FS_LIT)).toThrow(/link boom: varyings/);
  });
});
