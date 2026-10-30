// @q2/testkit — GPU-FOLLOW-2A lane helpers (DOM-free, Node-safe, browser-safe).
//
// Pins the missing-enemy repair on BOTH entry paths (cold GPU boot and
// software/voodoo→GPU hot-swap replay) without touching apps/web or
// @q2/webgl-renderer. Every helper is a pure structural harness over the
// PUBLIC backend API (WebGLRenderer + selectGpuScene/refreshGpuScene +
// alias mesh/shade helpers); the production registration path in apps/web
// (`registerPakModels` / `replayPakAssetsToGpu`) is mirrored here BY VALUE so
// the entry-path contract is pinned even though that module is out of owns.
//
// Roster contract (mirrors the renderer-lane FOLLOW-2A roster):
//   model 0 / skin 0 — alive soldier (real base1 MD2/PCX in Q2_PAK legs)
//   model 2 / skin 2 — second model (infantry; never soldier-only fixtures)
//   model 4 / skin 3 — barrel misc_explobox (named FOLLOW-2A regression)
//   model 3 / skin 1 — depth-hacked viewmodel gun (never gun-only fixtures)

import type { Entity } from '@q2/renderer-api';
import type { GpuEntityModelKind } from '@q2/webgl-renderer';

// --- Roster handles (fixture contract, documented above) --------------------

export const FOLLOW2A_SOLDIER_MODEL = 0;
export const FOLLOW2A_SOLDIER_SKIN = 0;
export const FOLLOW2A_GUN_MODEL = 3;
export const FOLLOW2A_GUN_SKIN = 1;
export const FOLLOW2A_INFANTRY_MODEL = 2;
export const FOLLOW2A_INFANTRY_SKIN = 2;
export const FOLLOW2A_BARREL_MODEL = 4;
export const FOLLOW2A_BARREL_SKIN = 3;

export function follow2aKinds(): Map<number, GpuEntityModelKind> {
  return new Map<number, GpuEntityModelKind>([
    [FOLLOW2A_SOLDIER_MODEL, 'md2'],
    [FOLLOW2A_INFANTRY_MODEL, 'md2'],
    [FOLLOW2A_GUN_MODEL, 'md2'],
    [FOLLOW2A_BARREL_MODEL, 'md2'],
  ]);
}

/** Required roster (handle order is provenance, not a numeric pin). */
export function follow2aRequiredModels(): number[] {
  return [FOLLOW2A_SOLDIER_MODEL, FOLLOW2A_INFANTRY_MODEL, FOLLOW2A_GUN_MODEL, FOLLOW2A_BARREL_MODEL];
}

export function follow2aRequiredSkins(): number[] {
  return [FOLLOW2A_SOLDIER_SKIN, FOLLOW2A_GUN_SKIN, FOLLOW2A_INFANTRY_SKIN, FOLLOW2A_BARREL_SKIN];
}

// --- Entity builders (game-state -> renderable mapping, mirrored by value) -

/**
 * Alive base1 soldier ~48 units ahead of the spawn-north camera, facing the
 * player (yaw 270 = facing -Y... kept identical to the renderer-lane leg).
 */
export function aliveSoldierEntity(frame: number): Entity {
  return {
    model: FOLLOW2A_SOLDIER_MODEL,
    origin: new Float32Array([50, 0, -10]),
    angles: new Float32Array([0, 270, 0]),
    frame,
    skin: FOLLOW2A_SOLDIER_SKIN,
  };
}

/** Second model: infantry MD2/PCX at a distinct slot (not soldier, not gun). */
export function infantryEntity(frame: number): Entity {
  return {
    model: FOLLOW2A_INFANTRY_MODEL,
    origin: new Float32Array([52, 0, -10]),
    angles: new Float32Array([0, 270, 0]),
    frame,
    skin: FOLLOW2A_INFANTRY_SKIN,
  };
}

/** Named regression: live misc_explobox barrel (bottom-pivot origin). */
export function barrelEntity(): Entity {
  return {
    model: FOLLOW2A_BARREL_MODEL,
    origin: new Float32Array([48, 6, -24]),
    angles: new Float32Array([0, 0, 0]),
    frame: 0,
    skin: FOLLOW2A_BARREL_SKIN,
  };
}

/** Eye-anchored depth-hacked viewmodel gun. */
export function viewmodelGunEntity(frame: number): Entity {
  return {
    model: FOLLOW2A_GUN_MODEL,
    origin: new Float32Array([2, 0, 0]),
    angles: new Float32Array([0, 90, 0]),
    frame,
    skin: FOLLOW2A_GUN_SKIN,
    depthHack: true,
  };
}

/** Full combat roster: soldier + infantry + barrel + gun. */
export function follow2aCombatEntities(soldierFrame: number, gunFrame: number): Entity[] {
  return [
    aliveSoldierEntity(soldierFrame),
    infantryEntity(1),
    barrelEntity(),
    viewmodelGunEntity(gunFrame),
  ];
}

// --- Retained-asset replay mirror (production path BY VALUE, no import) ----

export interface RetainedModelAssetMirror {
  handle: number;
  kind: 'md2' | 'sp2' | 'tracer';
  data: unknown;
  path: string;
  fallback: boolean;
}

export interface RetainedSkinAssetMirror {
  handle: number;
  pixels: Uint8Array | null;
  width: number;
  height: number;
  path: string;
  fallback: boolean;
}

export interface RetainedAssetsMirror {
  models: RetainedModelAssetMirror[];
  skins: RetainedSkinAssetMirror[];
}

export interface GpuAssetSinkMirror {
  registerModelData(handle: number, kind: 'md2' | 'sp2' | 'tracer', data: unknown): void;
  registerSkinPixels(handle: number, pixels: Uint8Array, width: number, height: number): number;
}

export interface ReplayOutcome {
  models: number;
  skins: number;
  /** Required entries that failed (empty = clean; tests fail loudly on any). */
  failures: string[];
}

/**
 * Replay retained parsed assets under their SAME handles (mirrors
 * `replayPakAssetsToGpu` in apps/web/src/play.ts BY VALUE: checker-fallback
 * skins stay CPU-only, every other entry replays, failures are collected with
 * asset/handle context, one bad lump never blocks the rest).
 */
export function replayRetainedAssetsMirror(
  assets: RetainedAssetsMirror | null,
  sink: GpuAssetSinkMirror | null | undefined,
): ReplayOutcome {
  if (!assets || !sink) return { models: 0, skins: 0, failures: [] };
  let models = 0;
  let skins = 0;
  const failures: string[] = [];
  for (const m of assets.models) {
    try {
      sink.registerModelData(m.handle, m.kind, m.data);
      models++;
    } catch (err) {
      failures.push(`model ${m.path} (model ${m.handle}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const s of assets.skins) {
    if (s.pixels === null) continue; // checker fallback is CPU-only by design
    try {
      sink.registerSkinPixels(s.handle, s.pixels, s.width, s.height);
      skins++;
    } catch (err) {
      failures.push(`skin ${s.path} (skin ${s.handle}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { models, skins, failures };
}

// --- CPU registration spy (no-duplicate-registration / no-handle-drift pin) -

export interface CpuRegisterSpy {
  modelCalls: number;
  skinCalls: number;
  modelHandles: number[];
  skinHandles: number[];
  registerModel(model: { name: string; kind: string; data: unknown }): number;
  registerSkinData(name: string, texels: Uint8Array, width: number, height: number): number;
}

/**
 * Fake CPU refresh registration surface. The hot-swap contract is: CPU
 * registration runs ONCE at boot (populating the retained cache); every
 * later GPU attach replays WITHOUT touching these counters again.
 */
export function makeCpuRegisterSpy(): CpuRegisterSpy {
  let nextModel = 0;
  let nextSkin = 0;
  const modelHandles: number[] = [];
  const skinHandles: number[] = [];
  return {
    modelCalls: 0,
    skinCalls: 0,
    modelHandles,
    skinHandles,
    registerModel(model: { name: string; kind: string; data: unknown }): number {
      void model;
      const h = nextModel++;
      modelHandles.push(h);
      (this as CpuRegisterSpy).modelCalls++;
      return h;
    },
    registerSkinData(name: string, texels: Uint8Array, width: number, height: number): number {
      void name;
      void texels;
      void width;
      void height;
      const h = nextSkin++;
      skinHandles.push(h);
      (this as CpuRegisterSpy).skinCalls++;
      return h;
    },
  };
}

// --- Gameplay-state preservation pin (replay must not touch the game) -------

export interface GameplaySnapshot {
  pos: [number, number, number];
  health: number;
  ammo: number;
  weapon: string;
}

export function snapshotGameplay(pos: [number, number, number], health: number, ammo: number, weapon: string): GameplaySnapshot {
  return { pos: [pos[0], pos[1], pos[2]], health, ammo, weapon };
}

export function gameplayPreserved(before: GameplaySnapshot, after: GameplaySnapshot): boolean {
  return (
    before.pos[0] === after.pos[0] &&
    before.pos[1] === after.pos[1] &&
    before.pos[2] === after.pos[2] &&
    before.health === after.health &&
    before.ammo === after.ammo &&
    before.weapon === after.weapon
  );
}

// --- Warning triage (fail loudly, never silently) ----------------------------

/** Mesh-less / missing-asset warnings (drawAlias skip context). */
export function meshWarnings(warnings: string[]): string[] {
  return warnings.filter((w) => /no mesh|missing|skipped|invalid/i.test(w));
}

// --- Minimal WebGL2 stub (hermetic legs: records calls, no GL, no DOM) ------

export interface Follow2aStubState {
  calls: string[];
  gl: WebGL2RenderingContext;
  /** Number of recorded drawElements calls (alias/world draws). */
  drawElements: number;
  /** Number of recorded drawArrays calls (post pass). */
  drawArrays: number;
  /** texImage2D upload records (level + dims per call). */
  texUploads: Array<{ level: number; w: number; h: number }>;
}

/**
 * Structural WebGL2 stub for hermetic FOLLOW-2A legs. Compiles "clean"
 * (all status queries true, FBO complete, float unavailable => RGBA8
 * fallback branch), records draws + texture uploads, reports NO_ERROR.
 * Real-context upload-error coverage (odd strides, NPOT mips) belongs to
 * FOLLOW-2B's real-GL tests — stated here so a stub pass is never
 * misread as upload validation.
 */
export function createFollow2aStubGL(): Follow2aStubState {
  const calls: string[] = [];
  const texUploads: Array<{ level: number; w: number; h: number }> = [];
  let drawElements = 0;
  let drawArrays = 0;
  let nextBuf = 1;
  let nextTex = 1001;
  let nextShader = 2001;
  let nextProg = 3001;
  let nextFb = 5001;
  let nextRb = 6001;
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
    RGBA: 0x1908,
    RGBA8: 0x8058,
    RGBA16F: 0x881a,
    UNSIGNED_BYTE: 0x1401,
    UNSIGNED_INT: 0x1405,
    HALF_FLOAT: 0x140b,
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
    NO_ERROR: 0,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    FRAMEBUFFER: 0x8d40,
    RENDERBUFFER: 0x8d41,
    COLOR_ATTACHMENT0: 0x8ce0,
    DEPTH_ATTACHMENT: 0x8d00,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
  };
  interface Box {
    id: number;
  }
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
      calls.push(`enable ${cap}`);
    },
    disable(cap: number): void {
      calls.push(`disable ${cap}`);
    },
    depthFunc(f: number): void {
      calls.push(`depthFunc ${f}`);
    },
    depthMask(on: boolean): void {
      calls.push(`depthMask ${on}`);
    },
    blendFunc(s: number, d: number): void {
      calls.push(`blendFunc ${s} ${d}`);
    },
    createShader(t: number): unknown {
      calls.push(`createShader ${t}`);
      return { id: nextShader++ } as Box;
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
    deleteShader(): void {},
    createProgram(): unknown {
      const pid = nextProg++;
      calls.push(`createProgram ${pid}`);
      return { pid } as Box & { pid: number };
    },
    attachShader(): void {},
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
      return { name };
    },
    createBuffer(): unknown {
      return { id: nextBuf++ } as Box;
    },
    bindBuffer(): void {},
    bufferData(_t: number, data: ArrayBufferView, _u: number): void {
      calls.push(`bufferData ${data.byteLength}`);
    },
    createTexture(): unknown {
      return { id: nextTex++ } as Box;
    },
    bindTexture(): void {},
    texParameteri(): void {},
    texImage2D(...args: unknown[]): void {
      const level = typeof args[1] === 'number' ? (args[1] as number) : 0;
      const w = typeof args[3] === 'number' ? (args[3] as number) : -1;
      const h = typeof args[4] === 'number' ? (args[4] as number) : -1;
      texUploads.push({ level, w, h });
      calls.push(`texImage2D lvl=${level} ${w}x${h}`);
    },
    getExtension(): unknown {
      return null;
    },
    createFramebuffer(): unknown {
      return { id: nextFb++ } as Box;
    },
    bindFramebuffer(): void {},
    framebufferTexture2D(): void {},
    framebufferRenderbuffer(): void {},
    checkFramebufferStatus(): unknown {
      return GLC.FRAMEBUFFER_COMPLETE;
    },
    createRenderbuffer(): unknown {
      return { id: nextRb++ } as Box;
    },
    bindRenderbuffer(): void {},
    renderbufferStorage(_t: number, fmt: number, w: number, h: number): void {
      calls.push(`renderbufferStorage fmt=${fmt} ${w}x${h}`);
    },
    activeTexture(t: number): void {
      calls.push(`activeTexture ${t}`);
    },
    useProgram(p: unknown): void {
      calls.push(`useProgram ${(p as { pid?: number }).pid ?? '?'}`);
    },
    uniform1fv(l: unknown, v: Float32Array): void {
      calls.push(`uniform1fv ${(l as { name: string }).name} len=${v.length}`);
    },
    uniform3f(l: unknown, x: number, y: number, z: number): void {
      calls.push(`uniform3f ${(l as { name: string }).name} ${x} ${y} ${z}`);
    },
    uniform1f(l: unknown, v: number): void {
      calls.push(`uniform1f ${(l as { name: string }).name} ${v}`);
    },
    uniform2f(l: unknown, x: number, y: number): void {
      calls.push(`uniform2f ${(l as { name: string }).name} ${x} ${y}`);
    },
    uniform1i(l: unknown, v: number): void {
      calls.push(`uniform1i ${(l as { name: string }).name} ${v}`);
    },
    uniform4fv(l: unknown, v: Float32Array): void {
      calls.push(`uniform4fv ${(l as { name: string }).name} len=${v.length}`);
    },
    uniform3fv(l: unknown, v: Float32Array): void {
      calls.push(`uniform3fv ${(l as { name: string }).name} len=${v.length}`);
    },
    uniformMatrix4fv(l: unknown, _t: boolean, v: Float32Array): void {
      calls.push(`uniformMatrix4fv ${(l as { name: string }).name} len=${v.length}`);
    },
    vertexAttribPointer(loc: number, size: number): void {
      calls.push(`vertexAttribPointer ${loc} ${size}`);
    },
    enableVertexAttribArray(loc: number): void {
      calls.push(`enableVertexAttribArray ${loc}`);
    },
    drawElements(_mode: number, count: number, _type?: unknown, offset?: unknown): void {
      drawElements++;
      calls.push(`drawElements ${count} @${String(offset ?? 0)}`);
    },
    drawArrays(_mode: number, _f: number, count: number): void {
      drawArrays++;
      calls.push(`drawArrays ${count}`);
    },
    getError(): number {
      return GLC.NO_ERROR;
    },
  } as unknown as WebGL2RenderingContext;
  return {
    calls,
    gl,
    get drawElements(): number {
      return drawElements;
    },
    get drawArrays(): number {
      return drawArrays;
    },
    texUploads,
  };
}

// --- Shade-stage triage (black-infantry isolation, hermetic) -----------------

export interface ShadeStageStats {
  min: number;
  max: number;
  mean: number;
  finite: boolean;
  nonConstant: boolean;
  count: number;
}

/** Finite + range stats over a shade-base array (NaN/Inf = upload/lighting bug). */
export function shadeStats(shade: Float32Array): ShadeStageStats {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let finite = true;
  for (let i = 0; i < shade.length; i++) {
    const v = shade[i]!;
    if (!Number.isFinite(v)) finite = false;
    else {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
  }
  if (shade.length === 0 || !finite) return { min: NaN, max: NaN, mean: NaN, finite: false, nonConstant: false, count: shade.length };
  return { min, max, mean: sum / shade.length, finite: true, nonConstant: max > min, count: shade.length };
}

export interface UnlitSkinStats {
  width: number;
  height: number;
  distinct: number;
  nonBlackFrac: number;
  gutterBlackFrac: number;
}

/** Unlit-stage stats over raw skin texels (palette indices, pre-lighting). */
export function unlitSkinStats(pixels: Uint8Array, width: number, height: number): UnlitSkinStats {
  const seen = new Set<number>();
  let nonBlack = 0;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const v = pixels[i]!;
    seen.add(v);
    if (v !== 0) nonBlack++;
  }
  // Gutter probe: first row (skin gutters are intentionally black in places).
  let gutterBlack = 0;
  const gutterN = Math.min(width, n);
  for (let i = 0; i < gutterN; i++) {
    if (pixels[i] === 0) gutterBlack++;
  }
  return {
    width,
    height,
    distinct: seen.size,
    nonBlackFrac: n === 0 ? 0 : nonBlack / n,
    gutterBlackFrac: gutterN === 0 ? 0 : gutterBlack / gutterN,
  };
}

export interface UvRange {
  minS: number;
  maxS: number;
  minT: number;
  maxT: number;
  skinW: number;
  skinH: number;
}

/** UV source range in texel units + declaring skin dims (upload-scale check). */
export function skinUvRange(st: Float32Array, skinW: number, skinH: number): UvRange {
  let minS = Infinity;
  let maxS = -Infinity;
  let minT = Infinity;
  let maxT = -Infinity;
  for (let i = 0; i + 1 < st.length; i += 2) {
    const s = st[i]!;
    const t = st[i + 1]!;
    if (s < minS) minS = s;
    if (s > maxS) maxS = s;
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
  }
  return { minS, maxS, minT, maxT, skinW, skinH };
}
