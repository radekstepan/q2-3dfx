// @q2/webgl-renderer shaders — production GLSL ES 3.00 sources (GPU-PROOF-4).
//
// Scene output is LINEAR into the scene render target; the fullscreen
// appearance pass (VS_POST/FS_APPEARANCE in appearance.ts) applies dither,
// RGB565 quantization, reconstruction and display gamma. Scene programs carry
// the sampling/fog/overbright policy as live uniforms (see appearance.ts
// GLSL_MIP_POLICY / GLSL_FOG_OVERBRIGHT + PROOF-4.md):
//   - single-TMU mip LOD (fwidth rho + vd_lodbias + 0.375 dither mean,
//     Bayer n/n+1 pick, textureLod into uploaded box-filtered chains);
//   - 64-entry table fog AFTER overbright (CPU shadePixel order), inert in
//     base1 (scene contribution 0);
//   - overbright modulate x2 + clamp via uOverbright.
// Lightmaps stay plain LINEAR texture() (no LOD): the CPU bakes per-miplevel
// surface blocks, which has no GPU equivalent here (documented gap).
// Turbulent water skips the lightmap tap entirely (GPU-FOLLOW-3B): both
// refs draw warp faces unlit (ref_soft raw texels, ref_gl "no lightmaps").
//
// Reviewability: sources are exported consts; tests assert the required
// features (texture() sampling, lightmap uniform, alpha) are present.

import { GLSL_FOG_OVERBRIGHT, GLSL_MIP_POLICY } from './appearance.js';

/** Lit world vertex shader: MVP + diffuse/lightmap UVs + per-vertex alpha. */
export const VS_LIT = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUV;
layout(location = 2) in vec2 aLightUV;
layout(location = 3) in float aAlpha;
uniform mat4 uMVP;
uniform float uDepthScale;
out vec2 vUV;
out vec2 vLightUV;
out float vAlpha;
out vec3 vWorldPos;
out float vFogW;
void main() {
  vec4 clip = uMVP * vec4(aPos, 1.0);
  clip.z *= uDepthScale;
  gl_Position = clip;
  vUV = aUV;
  vLightUV = aLightUV;
  vAlpha = aAlpha;
  vWorldPos = aPos;
  vFogW = clamp(clip.z / max(clip.w, 1e-6) * 0.5 + 0.5, 0.0, 1.0);
}
`;

/** Lit world fragment shader: mipped diffuse x (lightmap + per-pixel dlights). */
export const FS_LIT = `#version 300 es
// highp (FS_APPEARANCE parity): world UVs span many tiles (base1 water
// covers ~30 tiles with negative coords); mediump's min-spec mantissa
// quantizes the varying to whole texels at that magnitude, snapping warp
// indices and bilinear fractions on a tile grid.
precision highp float;
in vec2 vUV;
in vec2 vLightUV;
in float vAlpha;
in vec3 vWorldPos;
in float vFogW;
uniform sampler2D uDiffuse;
uniform sampler2D uLightmap;
uniform vec4 uLightPos[8];
uniform vec3 uLightColor[8];
uniform int uNumLights;
uniform int uDebugMode;
uniform int uWarpOn;
uniform float uTime;
out vec4 oColor;
${GLSL_MIP_POLICY}
${GLSL_FOG_OVERBRIGHT}
// Turbulent water warp (GPU-FOLLOW-3, CPU runSubdivTurbulent parity):
// wu = u + T[(v+phase) & 1023], wv = v + T[(u+phase) & 1023], T closed-form
// 16 + 15*sin(2*pi*idx/1024) (the CPU table, unrounded), phase from uTime.
// UVs are texel units here (the uploaded world UVs are normalized 0..1, so
// the caller scales by texture size first). uWarpOn 0 = verbatim passthrough.
vec2 voodooWarp(vec2 uv) {
  if (uWarpOn == 0) return uv;
  float ph = floor(uTime * 64.0);
  float iu = floor(uv.x);
  float iv = floor(uv.y);
  float tu = 16.0 + 15.0 * sin(6.283185307179586 * mod(iv + ph, 1024.0) / 1024.0);
  float tv = 16.0 + 15.0 * sin(6.283185307179586 * mod(iu + ph, 1024.0) / 1024.0);
  return vec2(uv.x + tu, uv.y + tv);
}
void main() {
  // vUV is normalized 0..1 (world batches); warp runs in texel units.
  // LOD comes from the UNWARPED vUV (CPU spanLod parity: spans.ts derives
  // spanLod from unwarped gradients and warps only the diffuse lookup);
  // the warped coords offset only the textureLod tap (REPEAT wrap holds).
  // Sampling LOD from warped coords folds floor() steps into fwidth and
  // flips the mip pick along integer texel lines (GPU-FOLLOW-3B repair).
  vec2 tsz = vec2(textureSize(uDiffuse, 0));
  vec2 wuv = voodooWarp(vUV * tsz);
  vec3 texel = voodooSampleMippedWarped(uDiffuse, vUV, wuv / tsz);
  // FOLLOW-2B test-only diagnostic views (debug-gated, production stays 0):
  // 1 = unlit diffuse (repeat/wrap + upload triage), 2 = lightmap block only
  // (atlas placement/bleed triage). Final (0) is the shipped path.
  if (uDebugMode == 1) {
    oColor = vec4(texel, vAlpha);
    return;
  }
  vec3 lm = texture(uLightmap, vLightUV).rgb;
  if (uDebugMode == 2) {
    oColor = vec4(lm, vAlpha);
    return;
  }
  // GPU-FOLLOW-3B: turbulent water is UNLIT (ref_soft
  // R_BuildPolygonFromSurface serves SURF_WARP faces raw texels to
  // R_DrawSpanletTurbulentBlended66 — no surface cache, no lightmap;
  // ref_gl R_RenderBrushPoly: "warp texture, no lightmaps"). The per-face
  // lightmap multiply drew the baked blocks' face-boundary steps (up to
  // 247/255 at shared edges on real base1 water) as tile seams.
  // Non-turbulent translucent glass stays lit (both refs light it).
  vec3 col;
  if (uWarpOn != 0) {
    col = texel;
  } else {
    vec3 dyn = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      if (i >= uNumLights) break;
      vec4 L = uLightPos[i];
      float d = distance(vWorldPos, L.xyz);
      if (L.w > 0.0 && d < L.w) {
        float f = (L.w - d) / L.w;
        dyn += f * uLightColor[i];
      }
    }
    col = voodooOverbright(texel * (lm + dyn));
  }
  col = voodooApplyFog(col, vFogW);
  oColor = vec4(col, vAlpha);
}
`;

/** Alias vertex shader: MVP + skin UV + CPU shade-dot base + alpha attr. */
export const VS_ALIAS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUV;
layout(location = 2) in float aShade;
layout(location = 3) in float aAlpha;
uniform mat4 uMVP;
uniform float uDepthScale;
uniform vec2 uUVScale;
out vec2 vUV;
out float vShade;
out float vAlpha;
out vec3 vWorldPos;
out float vFogW;
void main() {
  vec4 clip = uMVP * vec4(aPos, 1.0);
  clip.z *= uDepthScale;
  gl_Position = clip;
  vUV = aUV * uUVScale;
  vShade = aShade;
  vAlpha = aAlpha;
  vWorldPos = aPos;
  vFogW = clamp(clip.z / max(clip.w, 1e-6) * 0.5 + 0.5, 0.0, 1.0);
}
`;

/** Alias fragment shader: mipped skin x (shade base + per-pixel dlights). */
export const FS_ALIAS = `#version 300 es
precision mediump float;
in vec2 vUV;
in float vShade;
in float vAlpha;
in vec3 vWorldPos;
in float vFogW;
uniform sampler2D uDiffuse;
uniform vec4 uLightPos[8];
uniform vec3 uLightColor[8];
uniform int uNumLights;
uniform float uAlpha;
uniform int uDebugMode;
out vec4 oColor;
${GLSL_MIP_POLICY}
${GLSL_FOG_OVERBRIGHT}
void main() {
  vec3 texel = voodooSampleMipped(uDiffuse, vUV);
  // FOLLOW-2B test-only diagnostic views (debug-gated, production stays 0):
  // 1 = unlit skin (upload/UV/palette triage), 2 = shade base only
  // (normal/shading triage). Final (0) is the shipped path.
  if (uDebugMode == 1) {
    oColor = vec4(texel, vAlpha * uAlpha);
    return;
  }
  if (uDebugMode == 2) {
    oColor = vec4(vec3(vShade), vAlpha * uAlpha);
    return;
  }
  vec3 dyn = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= uNumLights) break;
    vec4 L = uLightPos[i];
    float d = distance(vWorldPos, L.xyz);
    if (L.w > 0.0 && d < L.w) {
      float f = (L.w - d) / L.w;
      dyn += f * uLightColor[i];
    }
  }
  vec3 col = voodooOverbright(texel * (vec3(vShade) + dyn));
  col = voodooApplyFog(col, vFogW);
  oColor = vec4(col, vAlpha * uAlpha);
}
`;

/** Flat vertex shader: vertex color/alpha + optional UVs (sprites/POINTS). */
export const VS_FLAT = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aColor;
layout(location = 2) in vec2 aUV;
uniform mat4 uMVP;
uniform float uDepthScale;
uniform float uPointSize;
out vec4 vColor;
out vec2 vUV;
out float vFogW;
void main() {
  vec4 clip = uMVP * vec4(aPos, 1.0);
  clip.z *= uDepthScale;
  gl_Position = clip;
  gl_PointSize = uPointSize;
  vColor = aColor;
  vUV = aUV;
  vFogW = clamp(clip.z / max(clip.w, 1e-6) * 0.5 + 0.5, 0.0, 1.0);
}
`;

/** Flat fragment shader: vertex color, optionally modulated by a texture. */
export const FS_FLAT = `#version 300 es
precision mediump float;
in vec4 vColor;
in vec2 vUV;
in float vFogW;
uniform sampler2D uMap;
uniform int uTextured;
out vec4 oColor;
${GLSL_MIP_POLICY}
${GLSL_FOG_OVERBRIGHT}
void main() {
  vec3 base = vColor.rgb;
  if (uTextured != 0) {
    base *= voodooSampleMipped(uMap, vUV);
  }
  base = voodooApplyFog(base, vFogW);
  oColor = vec4(base, vColor.a);
}
`;

/**
 * Compile + link one program. Throws (never silent): the message carries
 * the stage, the shader info log and the program info log. Shaders are
 * detached/deleted on both paths; a failed program is deleted before throw.
 */
export function compileProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
): WebGLProgram {
  const vs = compileStage(gl, gl.VERTEX_SHADER, vsSrc, 'vertex');
  let fs: WebGLShader | null = null;
  try {
    fs = compileStage(gl, gl.FRAGMENT_SHADER, fsSrc, 'fragment');
  } catch (err) {
    gl.deleteShader(vs);
    throw err;
  }
  const prog = gl.createProgram();
  if (!prog) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error('[webgl-renderer] compileProgram: createProgram returned null');
  }
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  // Fixed attribute locations match the layout() qualifiers above; binding
  // them explicitly keeps stub-GL tests (which ignore layout) honest too.
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.bindAttribLocation(prog, 1, 'aUV');
  gl.linkProgram(prog);
  const linked = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean;
  const progLog = gl.getProgramInfoLog(prog) ?? '';
  gl.detachShader(prog, vs);
  gl.detachShader(prog, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!linked) {
    gl.deleteProgram(prog);
    throw new Error(`[webgl-renderer] compileProgram: link failed: ${progLog}`);
  }
  return prog;
}

function compileStage(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
  stage: string,
): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) {
    throw new Error(`[webgl-renderer] compileProgram: createShader(${stage}) returned null`);
  }
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean;
  const log = gl.getShaderInfoLog(sh) ?? '';
  if (!ok) {
    gl.deleteShader(sh);
    throw new Error(`[webgl-renderer] compileProgram: ${stage} compile failed: ${log}`);
  }
  return sh;
}
