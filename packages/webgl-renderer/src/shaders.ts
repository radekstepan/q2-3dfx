// @q2/webgl-renderer shaders — production GLSL ES 3.00 sources (GPU-PROOF-3).
//
// Plain linear-RGB output is CORRECT for this card: dither/RGB565/fog/gamma
// are PROOF-4 appearance policy, explicitly out of scope. Two lit programs
// (world + alias, which have different lighting inputs) plus one flat
// vertex-color program (beams/particles/sky, with an opt-in texture mode
// for sprites) — the minimal variant set that covers the route.
//
// Reviewability: sources are exported consts; tests assert the required
// features (texture() sampling, lightmap uniform, alpha) are present.

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
void main() {
  vec4 clip = uMVP * vec4(aPos, 1.0);
  clip.z *= uDepthScale;
  gl_Position = clip;
  vUV = aUV;
  vLightUV = aLightUV;
  vAlpha = aAlpha;
  vWorldPos = aPos;
}
`;

/** Lit world fragment shader: diffuse x (lightmap + per-pixel dlights). */
export const FS_LIT = `#version 300 es
precision mediump float;
in vec2 vUV;
in vec2 vLightUV;
in float vAlpha;
in vec3 vWorldPos;
uniform sampler2D uDiffuse;
uniform sampler2D uLightmap;
uniform vec4 uLightPos[8];
uniform vec3 uLightColor[8];
uniform int uNumLights;
out vec4 oColor;
void main() {
  vec3 texel = texture(uDiffuse, vUV).rgb;
  vec3 lm = texture(uLightmap, vLightUV).rgb;
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
  vec3 col = texel * (lm + dyn);
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
void main() {
  vec4 clip = uMVP * vec4(aPos, 1.0);
  clip.z *= uDepthScale;
  gl_Position = clip;
  vUV = aUV * uUVScale;
  vShade = aShade;
  vAlpha = aAlpha;
  vWorldPos = aPos;
}
`;

/** Alias fragment shader: skin x (shade base + per-pixel dlights). */
export const FS_ALIAS = `#version 300 es
precision mediump float;
in vec2 vUV;
in float vShade;
in float vAlpha;
in vec3 vWorldPos;
uniform sampler2D uDiffuse;
uniform vec4 uLightPos[8];
uniform vec3 uLightColor[8];
uniform int uNumLights;
uniform float uAlpha;
out vec4 oColor;
void main() {
  vec3 texel = texture(uDiffuse, vUV).rgb;
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
  vec3 col = texel * (vec3(vShade) + dyn);
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
void main() {
  vec4 clip = uMVP * vec4(aPos, 1.0);
  clip.z *= uDepthScale;
  gl_Position = clip;
  gl_PointSize = uPointSize;
  vColor = aColor;
  vUV = aUV;
}
`;

/** Flat fragment shader: vertex color, optionally modulated by a texture. */
export const FS_FLAT = `#version 300 es
precision mediump float;
in vec4 vColor;
in vec2 vUV;
uniform sampler2D uMap;
uniform int uTextured;
out vec4 oColor;
void main() {
  vec3 base = vColor.rgb;
  if (uTextured != 0) {
    base *= texture(uMap, vUV).rgb;
  }
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
