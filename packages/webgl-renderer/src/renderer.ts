// @q2/webgl-renderer renderer — WebGL2 scene drawing (GPU-PROOF-3).
//
// Owns: the injected GL context handle, the DEFAULT framebuffer target
// (viewport + clear state), per-generation static uploads (world batches,
// diffuse/lightmap textures, model index/uv caches) and per-frame dynamic
// buffers (alias interpolation, billboards, particles).
//
// Passes per frame (transparent ordering preserved, far->near):
//   sky (flat, no depth write) -> opaque world (lit) -> opaque alias +
//   opaque sprites (entity order) -> gun pass (depth-hack MVP) ->
//   particles (POINTS, depth write) -> blend pass (SRC_ALPHA/ONE_MINUS,
//   depth test on, depth write OFF): transparent world in scene order,
//   transparent alias, beams.
//
// Documented PROOF-3 approximations (appearance policy is PROOF-4):
//   - LINEAR filtering everywhere, no mipmaps (no LOD/bilinear policy yet);
//   - lightmap style scale baked per style-signature (re-baked on change);
//   - dynamic lights per-pixel in world + alias shaders (CPU bakes
//     per-luxel; tolerances cover the difference);
//   - gun depth: NDC z remapped by (scale 0.02, bias -0.9), the GPU
//     interpretation of RF_DEPTHHACK 1/z x3 (wins except nose-to-wall);
//   - beams are ~1.5px camera-facing quads (CPU: 1px DDA core+glow);
//   - no GL face culling (visibility = selectGpuScene's CPU backface rule);
//   - turbulent water draws unwarped (warp deferred to PROOF-4/EXPAND);
//   - translucency is true blending (CPU: screen-door on the 8-bit path);
//   - near plane near=4 like the CPU (automatic GL clip).
//   - small per-frame CPU garbage is accepted (lerp/scratch arrays for the
//     handful of dynamic entities; static geometry never re-uploads).
//
// Lifecycle/status/loss/restore/dispose semantics are EXACTLY the PROOF-2
// pins (driveLifecycleContract): renderFrame before init throws Com_Error;
// loss records + skips; empty world (no attached MiniWorld/palette) still
// clears + submits so the boundary contract holds without assets.
//
// Normal rendering never reads pixels back (no readPixels anywhere in src/).

import { Com_Error } from '@q2/config';
import type {
  Entity,
  GpuFrameInput,
  GpuLight,
  GpuRenderer,
  GpuRendererStatus,
  GpuSceneInput,
} from '@q2/renderer-api';
import { MAX_GPU_LIGHTS } from '@q2/renderer-api';
import {
  setupCamera,
  type Camera,
  type MiniWorld,
} from '@q2/sw-renderer';
import {
  compileProgram,
  FS_ALIAS,
  FS_FLAT,
  FS_LIT,
  VS_ALIAS,
  VS_FLAT,
  VS_LIT,
} from './shaders.js';
import {
  buildEntityModel,
  buildProjectionMatrix,
  buildViewMatrix,
  GPU_FAR,
  GPU_NEAR,
  multiplyMat4,
} from './matrices.js';
import {
  buildTexturedWorldBatches,
  expandPaletteTexture,
  packLightAtlas,
  pickSkyPaletteIndex,
  styleSignature,
  type LightAtlas,
  type WorldBatch,
} from './worldMesh.js';
import {
  aliasShadeBase,
  gpuMeshFromMd2,
  interpolateAliasFrame,
  resolveAliasLerp,
  type AliasMesh,
} from './alias.js';
import {
  collectParticlePoints,
  emitBeamQuad,
  emitSpriteQuad,
  emptyFlatBatch,
  resolveBeam,
  updateGpuEntities,
  type FlatBatch,
} from './entities.js';
import type { GpuEntityModelKind } from './scene.js';

/** Observability for the persistent-upload contract (test hook). */
export interface WebGLUploadStats {
  uploads: number;
}

/** Gun NDC depth remap (GPU interpretation of RF_DEPTHHACK 1/z x3). */
export const GUN_DEPTH_SCALE = 0.02;
/** Gun NDC depth bias (centers the remapped gun near the near plane). */
export const GUN_DEPTH_BIAS = -0.9;

const CLEAR_R = 0;
const CLEAR_G = 0;
const CLEAR_B = 0;
const CLEAR_A = 1;

interface SkinData {
  texels: Uint8Array;
  width: number;
  height: number;
}

interface ModelData {
  kind: GpuEntityModelKind;
  mesh: AliasMesh | null;
}

interface GLBatch {
  texId: number;
  posBuf: WebGLBuffer;
  uvBuf: WebGLBuffer;
  luvBuf: WebGLBuffer;
  alphaBuf: WebGLBuffer;
  idxBuf: WebGLBuffer;
  count: number;
}

interface GLSky {
  posBuf: WebGLBuffer;
  colBuf: WebGLBuffer;
  idxBuf: WebGLBuffer;
  count: number;
}

interface ModelGL {
  uvBuf: WebGLBuffer;
  idxBuf: WebGLBuffer;
  count: number;
  nv: number;
}

interface ProgLocs {
  prog: WebGLProgram;
  uMVP: WebGLUniformLocation | null;
  uDepthScale: WebGLUniformLocation | null;
  uDepthBias: WebGLUniformLocation | null;
  uDiffuse: WebGLUniformLocation | null;
  uLightmap: WebGLUniformLocation | null;
  uMap: WebGLUniformLocation | null;
  uTextured: WebGLUniformLocation | null;
  uPointSize: WebGLUniformLocation | null;
  uLightPos: WebGLUniformLocation | null;
  uLightColor: WebGLUniformLocation | null;
  uNumLights: WebGLUniformLocation | null;
  uAlpha: WebGLUniformLocation | null;
  uUVScale: WebGLUniformLocation | null;
}

export class WebGLRenderer implements GpuRenderer<WebGL2RenderingContext> {
  private gl: WebGL2RenderingContext | null = null;
  private width = 0;
  private height = 0;
  private ready = false;
  private lost = false;
  private submitted = 0;
  private error: string | null = null;
  private scene: GpuSceneInput | null = null;
  private uploadedGeneration: number | null = null;
  private uploadCount = 0;

  // --- PROOF-3 asset inputs (concrete methods; the GpuRenderer boundary is untouched) ---
  private world: MiniWorld | null = null;
  private palette: Uint8Array | null = null;
  private models = new Map<number, ModelData>();
  private skins = new Map<number, SkinData>();
  private entities: Entity[] = [];
  private entityKinds: ReadonlyMap<number, GpuEntityModelKind> | undefined;
  private warnings: string[] = [];

  // --- GL objects (cleared on init/restore/dispose: contexts die) ---
  private progs: { lit: ProgLocs; alias: ProgLocs; flat: ProgLocs } | null = null;
  private staticDirty = true;
  private opaqueBatches: GLBatch[] = [];
  private transparentBatches: GLBatch[] = [];
  private skyDraws: GLSky[] = [];
  private atlasTex: WebGLTexture | null = null;
  private atlas: LightAtlas | null = null;
  private styleSig = 0;
  private diffuseTex = new Map<number, WebGLTexture | null>();
  private skinTex = new Map<number, { tex: WebGLTexture; w: number; h: number } | null>();
  private whiteTex: WebGLTexture | null = null;
  private onesBuf: WebGLBuffer | null = null;
  private modelGL = new Map<number, ModelGL>();
  private dynPos: WebGLBuffer | null = null;
  private dynShade: WebGLBuffer | null = null;
  private dynSize = 0;
  private flatPos: WebGLBuffer | null = null;
  private flatCol: WebGLBuffer | null = null;
  private flatUV: WebGLBuffer | null = null;
  private flatIdx: WebGLBuffer | null = null;
  private flatSize = 0;
  private flatIdxSize = 0;
  private pointPos: WebGLBuffer | null = null;
  private pointCol: WebGLBuffer | null = null;
  private pointCount = 0;

  init(gl: WebGL2RenderingContext, width: number, height: number): void {
    this.gl = gl;
    this.width = width;
    this.height = height;
    gl.viewport(0, 0, width, height);
    gl.clearColor(CLEAR_R, CLEAR_G, CLEAR_B, CLEAR_A);
    this.ready = true;
    this.lost = false;
    this.error = null;
    // Fresh context => fresh targets: drop previous upload bookkeeping.
    this.scene = null;
    this.uploadedGeneration = null;
    this.clearGLCaches();
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return; // no-op
    this.width = width;
    this.height = height;
    if (this.gl !== null) this.gl.viewport(0, 0, width, height);
  }

  setScene(scene: GpuSceneInput): void {
    this.scene = scene;
    // Persistent upload: re-upload if and only if the static generation
    // changed (PROOF-2 bookkeeping; PROOF-3 performs the GL work lazily in
    // renderFrame once world+palette are attached).
    if (this.uploadedGeneration !== scene.staticGeneration) {
      this.uploadedGeneration = scene.staticGeneration;
      this.uploadCount++;
      this.staticDirty = true;
    }
  }

  /** Attach the world whose surfaces setScene references (test/glue-owned). */
  attachWorld(world: MiniWorld | null): void {
    this.world = world;
    this.staticDirty = true;
  }

  /** Copy the palette (Refresh.setPalette spirit) for texture expansion. */
  setPalette(p: Uint8Array): void {
    this.palette = p.slice();
    this.staticDirty = true;
  }

  /** Register model data for an entity model handle (kind + parsed MD2). */
  registerModelData(handle: number, kind: GpuEntityModelKind, data: unknown): void {
    this.models.set(handle, { kind, mesh: kind === 'md2' ? gpuMeshFromMd2(data) : null });
    this.modelGL.delete(handle);
  }

  /** Register skin texels (palette indices) for an entity skin handle. */
  registerSkinPixels(handle: number, pixels: Uint8Array, width: number, height: number): number {
    if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > 1024 || height > 1024 ||
      pixels.length !== width * height) {
      this.warn(`registerSkinPixels: invalid ${width}x${height} for handle ${handle} (white fallback)`);
      this.skins.delete(handle);
      return handle;
    }
    this.skins.set(handle, { texels: pixels.slice(), width, height });
    this.skinTex.delete(handle);
    return handle;
  }

  /** Per-frame entity list (stored by reference; no alloc, no copy). */
  setEntities(entities: Entity[], modelKinds?: ReadonlyMap<number, GpuEntityModelKind>): void {
    this.entities = entities;
    this.entityKinds = modelKinds;
  }

  renderFrame(input: GpuFrameInput): void {
    if (!this.ready || this.gl === null) {
      this.fail('WebGLRenderer.renderFrame: not initialized (init first)');
    }
    if (this.lost) {
      this.error = 'WebGLRenderer.renderFrame: context lost (no submit)';
      return;
    }
    const gl = this.gl as WebGL2RenderingContext;
    // Static path needs world + palette + scene; without them this is the
    // PROOF-2 clear-only submit (lifecycle contract holds without assets,
    // and only viewport/clear/clearColor run — minimal-stub safe).
    if (this.world && this.palette && (this.scene ?? input.scene)) {
      this.ensurePrograms(gl);
      if (this.staticDirty) this.uploadStatic(gl, input);
      // Light-style flicker re-bakes the atlas texels only (no re-upload).
      const sig = styleSignature(input.view.lightStyles);
      if (!this.staticDirty && this.atlasTex && this.atlas && sig !== this.styleSig && this.world) {
        this.rebakeAtlas(gl, this.world, input.view.lightStyles, sig);
      }
      if (!this.staticDirty) {
        this.drawScene(gl, input);
        this.submitted++;
        this.error = null;
        return;
      }
      this.warn('renderFrame: static upload deferred (see earlier warnings)');
    }
    gl.viewport(0, 0, this.width, this.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.submitted++;
    this.error = null;
  }

  dispose(): void {
    // Idempotent: releasing twice is safe and never throws. No GL calls
    // (stub-safe; the context may already be gone).
    this.gl = null;
    this.ready = false;
    this.scene = null;
    this.clearGLCaches();
  }

  getStatus(): GpuRendererStatus {
    return {
      initialized: this.ready,
      width: this.width,
      height: this.height,
      contextLost: this.lost,
      framesSubmitted: this.submitted,
      lastError: this.error,
    };
  }

  handleContextLost(): void {
    this.lost = true;
  }

  handleContextRestored(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.lost = false;
    // Re-create owned targets: re-apply viewport + clear state. Upload
    // bookkeeping is kept (PROOF-3 re-uploads from the stored scene).
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(CLEAR_R, CLEAR_G, CLEAR_B, CLEAR_A);
    this.clearGLCaches();
    this.staticDirty = true;
    this.error = null;
  }

  /** Upload bookkeeping (test hook): persistent uploads so far. */
  testUploadStats(): WebGLUploadStats {
    return { uploads: this.uploadCount };
  }

  /** Recorded non-fatal warnings (test hook): oversize, caps, fallbacks. */
  testWarnings(): string[] {
    return [...this.warnings];
  }

  private warn(msg: string): void {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  private fail(message: string): never {
    this.error = message;
    Com_Error('error', message);
  }

  private clearGLCaches(): void {
    this.progs = null;
    this.staticDirty = true;
    this.opaqueBatches = [];
    this.transparentBatches = [];
    this.skyDraws = [];
    this.atlasTex = null;
    this.atlas = null;
    this.diffuseTex = new Map();
    this.skinTex = new Map();
    this.whiteTex = null;
    this.onesBuf = null;
    this.modelGL = new Map();
    this.dynPos = null;
    this.dynShade = null;
    this.dynSize = 0;
    this.flatPos = null;
    this.flatCol = null;
    this.flatUV = null;
    this.flatIdx = null;
    this.flatSize = 0;
    this.flatIdxSize = 0;
    this.pointPos = null;
    this.pointCol = null;
    this.pointCount = 0;
  }

  private ensurePrograms(gl: WebGL2RenderingContext): void {
    if (this.progs) return;
    const locs = (vs: string, fs: string): ProgLocs => {
      const prog = compileProgram(gl, vs, fs);
      const L = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(prog, name);
      return {
        prog,
        uMVP: L('uMVP'),
        uDepthScale: L('uDepthScale'),
        uDepthBias: L('uDepthBias'),
        uDiffuse: L('uDiffuse'),
        uLightmap: L('uLightmap'),
        uMap: L('uMap'),
        uTextured: L('uTextured'),
        uPointSize: L('uPointSize'),
        uLightPos: L('uLightPos[0]'),
        uLightColor: L('uLightColor[0]'),
        uNumLights: L('uNumLights'),
        uAlpha: L('uAlpha'),
        uUVScale: L('uUVScale'),
      };
    };
    try {
      this.progs = { lit: locs(VS_LIT, FS_LIT), alias: locs(VS_ALIAS, FS_ALIAS), flat: locs(VS_FLAT, FS_FLAT) };
    } catch (err) {
      this.fail(`WebGLRenderer.ensurePrograms: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Upload all static GL state for the current generation (once). */
  private uploadStatic(gl: WebGL2RenderingContext, input: GpuFrameInput): void {
    const world = this.world;
    const palette = this.palette;
    const scene = this.scene ?? input.scene;
    if (!world || !palette || !scene) return;
    // Fresh GL objects for this generation (same-context re-upload leaks by
    // design — generations change on map switch only).
    this.opaqueBatches = [];
    this.transparentBatches = [];
    this.skyDraws = [];
    this.diffuseTex = new Map();
    this.skinTex = new Map();
    this.modelGL = new Map();
    this.whiteTex = null;
    this.onesBuf = null;

    const refs = updateGpuEntities(scene, [], input.view, undefined);
    const worldIds = refs.filter((r) => r.transformIndex === 0 && r.material !== 'sky').map((r) => r.surfaceId);
    const sig = styleSignature(input.view.lightStyles);
    const { atlas, skipped } = packLightAtlas(world, worldIds, input.view.lightStyles);
    for (const id of skipped) this.warn(`lightmap atlas overflow: surface ${id} unlit (atlas origin)`);
    this.atlas = atlas;
    this.styleSig = sig;
    const { opaque, transparent, sky } = buildTexturedWorldBatches(world, refs, atlas);

    for (const b of opaque) this.opaqueBatches.push(this.uploadBatch(gl, b));
    for (const b of transparent) this.transparentBatches.push(this.uploadBatch(gl, b));
    const skyIdx = pickSkyPaletteIndex(palette);
    const sr = (palette[skyIdx * 3] ?? 0) / 255;
    const sg = (palette[skyIdx * 3 + 1] ?? 0) / 255;
    const sb = (palette[skyIdx * 3 + 2] ?? 0) / 255;
    for (const s of sky) {
      const posBuf = this.createStaticBuffer(gl, s.positions);
      const colArr = new Float32Array((s.positions.length / 3) * 4);
      for (let i = 0; i < colArr.length; i += 4) {
        colArr[i] = sr; colArr[i + 1] = sg; colArr[i + 2] = sb; colArr[i + 3] = 1;
      }
      const colBuf = this.createStaticBuffer(gl, colArr);
      const idxBuf = this.createStaticIndexBuffer(gl, s.indices);
      this.skyDraws.push({ posBuf, colBuf, idxBuf, count: s.indices.length });
    }
    this.atlasTex = this.uploadTexture(gl, atlas.pixels, atlas.width, atlas.height);
    this.staticDirty = false;
  }

  private uploadBatch(gl: WebGL2RenderingContext, b: WorldBatch): GLBatch {
    return {
      texId: b.texId,
      posBuf: this.createStaticBuffer(gl, b.positions),
      uvBuf: this.createStaticBuffer(gl, b.uvs),
      luvBuf: this.createStaticBuffer(gl, b.lightUVs),
      alphaBuf: this.createStaticBuffer(gl, b.alphas),
      idxBuf: this.createStaticIndexBuffer(gl, b.indices),
      count: b.indices.length,
    };
  }

  private createStaticBuffer(gl: WebGL2RenderingContext, data: Float32Array): WebGLBuffer {
    const buf = gl.createBuffer();
    if (!buf) this.fail('WebGLRenderer.uploadStatic: createBuffer returned null');
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return buf;
  }

  private createStaticIndexBuffer(gl: WebGL2RenderingContext, data: Uint32Array): WebGLBuffer {
    const buf = gl.createBuffer();
    if (!buf) this.fail('WebGLRenderer.uploadStatic: createBuffer returned null');
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return buf;
  }

  private uploadTexture(gl: WebGL2RenderingContext, rgb: Uint8Array, w: number, h: number): WebGLTexture {
    const tex = gl.createTexture();
    if (!tex) this.fail('WebGLRenderer.uploadStatic: createTexture returned null');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, rgb);
    return tex;
  }

  /** Diffuse texture for a world texId (expanded via palette; null = skip). */
  private diffuseFor(gl: WebGL2RenderingContext, texId: number): WebGLTexture | null {
    if (this.diffuseTex.has(texId)) return this.diffuseTex.get(texId)!;
    const world = this.world;
    const palette = this.palette;
    let out: WebGLTexture | null = null;
    if (world && palette) {
      const tex = world.textures[texId];
      if (tex) {
        if (tex.width > 256 || tex.height > 256) {
          this.warn(`diffuse texture ${texId} oversized ${tex.width}x${tex.height} (skipped)`);
        } else {
          const rgb = expandPaletteTexture(tex.texels, tex.width, tex.height, palette);
          if (!rgb) {
            this.warn(`diffuse texture ${texId} texel mismatch (skipped)`);
          } else {
            out = this.uploadTexture(gl, rgb, tex.width, tex.height);
          }
        }
      }
    }
    this.diffuseTex.set(texId, out);
    return out;
  }

  /** Skin texture for an entity skin handle (uploaded as-is; >256 warns). */
  private skinFor(gl: WebGL2RenderingContext, handle: number): { tex: WebGLTexture; w: number; h: number } | null {
    if (this.skinTex.has(handle)) return this.skinTex.get(handle)!;
    const palette = this.palette;
    let out: { tex: WebGLTexture; w: number; h: number } | null = null;
    const skin = this.skins.get(handle);
    if (skin && palette) {
      const rgb = expandPaletteTexture(skin.texels, skin.width, skin.height, palette);
      if (rgb) {
        if (skin.width > 256 || skin.height > 256) {
          this.warn(`skin ${handle} oversized ${skin.width}x${skin.height} (uploaded; Voodoo cap is PROOF-4)`);
        }
        out = { tex: this.uploadTexture(gl, rgb, skin.width, skin.height), w: skin.width, h: skin.height };
      } else {
        this.warn(`skin ${handle} texel mismatch (white fallback)`);
      }
    }
    this.skinTex.set(handle, out);
    return out;
  }

  private whiteFor(gl: WebGL2RenderingContext): WebGLTexture {
    if (!this.whiteTex) {
      this.whiteTex = this.uploadTexture(gl, new Uint8Array([255, 255, 255]), 1, 1);
    }
    return this.whiteTex;
  }

  /** 1.0-filled buffer (alias alpha attribute filler). */
  private onesFor(gl: WebGL2RenderingContext): WebGLBuffer | null {
    if (!this.onesBuf) {
      this.onesBuf = gl.createBuffer();
      if (!this.onesBuf) return null;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.onesBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(4096).fill(1), gl.STATIC_DRAW);
    }
    return this.onesBuf;
  }

  /** Re-bake atlas texels for a new style signature (rects/buffers kept). */
  private rebakeAtlas(
    gl: WebGL2RenderingContext,
    world: MiniWorld,
    lightStyles: Float32Array,
    sig: number,
  ): void {
    const scene = this.scene;
    if (!scene || !this.atlas) return;
    const worldIds: number[] = [];
    for (const r of scene.surfaces) {
      if (r.transformIndex === 0 && world.surfaces[r.surfaceId] && world.surfaces[r.surfaceId]!.n >= 3) {
        worldIds.push(r.surfaceId);
      }
    }
    const { atlas, skipped } = packLightAtlas(world, worldIds, lightStyles);
    // Same surface set => same rects (pack order is deterministic); only
    // texels change, so lightUV attributes stay valid.
    for (const id of skipped) this.warn(`lightmap atlas overflow: surface ${id} unlit (atlas origin)`);
    if (this.atlasTex && atlas.width === this.atlas.width && atlas.height === this.atlas.height) {
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, atlas.width, atlas.height, 0, gl.RGB, gl.UNSIGNED_BYTE, atlas.pixels);
      this.atlas.pixels = atlas.pixels;
    } else {
      this.atlasTex = this.uploadTexture(gl, atlas.pixels, atlas.width, atlas.height);
      this.atlas = atlas;
    }
    this.styleSig = sig;
  }

  private entityKind(handle: number): GpuEntityModelKind | 'alias' {
    return this.entityKinds?.get(handle) ?? this.models.get(handle)?.kind ?? 'alias';
  }

  private drawScene(gl: WebGL2RenderingContext, input: GpuFrameInput): void {
    const world = this.world;
    const palette = this.palette;
    if (!world || !palette || !this.progs || !this.atlasTex) return;
    const cam: Camera = setupCamera(input.view.origin, input.view.angles, input.view.fovX, this.width, this.height);
    const V = buildViewMatrix(cam.origin, cam.forward, cam.right, cam.up);
    const P = buildProjectionMatrix(input.view.fovX, this.width, this.height, GPU_NEAR, GPU_FAR);
    const VP = multiplyMat4(P, V);
    const lights = (input.lights ?? []).slice(0, MAX_GPU_LIGHTS);
    if ((input.lights ?? []).length > MAX_GPU_LIGHTS) {
      this.warn(`dynamic lights clamped to ${MAX_GPU_LIGHTS} (first-come wins)`);
    }

    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(CLEAR_R, CLEAR_G, CLEAR_B, CLEAR_A);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);

    // Sky first (flat fill, no depth write so nothing z-fights the hull).
    if (this.skyDraws.length > 0) {
      const flat = this.progs.flat;
      gl.useProgram(flat.prog);
      this.setMVP(gl, flat, VP, 1);
      if (flat.uPointSize) gl.uniform1f(flat.uPointSize, 1);
      if (flat.uTextured) gl.uniform1i(flat.uTextured, 0);
      gl.depthMask(false);
      for (const s of this.skyDraws) {
        this.bindAttrib(gl, 0, s.posBuf, 3);
        this.bindAttrib(gl, 1, s.colBuf, 4);
        this.bindAttrib(gl, 2, this.onesFor(gl), 2);
        this.bindIndex(gl, s.idxBuf);
        gl.drawElements(gl.TRIANGLES, s.count, gl.UNSIGNED_INT, 0);
      }
      gl.depthMask(true);
    }

    // Opaque world (lit; depth test on, depth write on).
    {
      const lit = this.progs.lit;
      gl.useProgram(lit.prog);
      this.setMVP(gl, lit, VP, 1);
      this.setLights(gl, lit, lights);
      this.bindLightmap(gl, lit);
      gl.depthMask(true);
      for (const b of this.opaqueBatches) {
        const tex = this.diffuseFor(gl, b.texId) ?? this.whiteFor(gl);
        this.bindDiffuse(gl, lit, tex);
        this.bindWorldBatch(gl, b);
        gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_INT, 0);
      }
    }

    // Entity resolution for this frame (refs + model matrices).

    // Opaque alias + opaque sprites (entity order preserved).
    const spriteBatches = new Map<number, FlatBatch>();
    for (let ei = 0; ei < this.entities.length; ei++) {
      const e = this.entities[ei]!;
      const kind = this.entityKind(e.model);
      const alpha = clamp01(e.alpha ?? 1);
      if (alpha <= 0) continue;
      if (kind === 'md2') {
        if (alpha >= 1 && e.depthHack !== true) this.drawAlias(gl, V, P, e, false, lights);
      } else if (kind === 'sp2') {
        if (alpha >= 1) {
          let b = spriteBatches.get(e.skin);
          if (!b) {
            b = emptyFlatBatch();
            spriteBatches.set(e.skin, b);
          }
          this.emitSprite(b, e, cam, alpha);
        }
      }
    }
    for (const [skinHandle, b] of spriteBatches) {
      if (b.idx.length > 0) this.drawFlatBatch(gl, VP, b, this.skinFor(gl, skinHandle)?.tex ?? null);
    }

    // Gun pass (eye-anchored viewmodel, depth-hack MVP).
    for (let ei = 0; ei < this.entities.length; ei++) {
      const e = this.entities[ei]!;
      if (e.depthHack !== true) continue;
      if (this.entityKind(e.model) !== 'md2') continue;
      const alpha = clamp01(e.alpha ?? 1);
      if (alpha <= 0 || alpha < 1) continue; // translucent guns ride the blend pass
      this.drawAlias(gl, V, P, e, true, lights);
    }

    // Particles (POINTS, depth-tested, depth-writing).
    {
      const { positions, colors } = collectParticlePoints(world, palette);
      if (positions.length > 0) this.drawPoints(gl, VP, positions, colors);
    }

    // Blend pass: transparent world (scene order) + transparent alias +
    // beams, far->near. Depth test on, depth write OFF (CPU deferred alpha).
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    {
      const lit = this.progs.lit;
      gl.useProgram(lit.prog);
      this.setMVP(gl, lit, VP, 1);
      this.setLights(gl, lit, lights);
      this.bindLightmap(gl, lit);
      // Transparent world batches were built in scene order already.
      for (const b of this.transparentBatches) {
        const tex = this.diffuseFor(gl, b.texId) ?? this.whiteFor(gl);
        this.bindDiffuse(gl, lit, tex);
        this.bindWorldBatch(gl, b);
        gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_INT, 0);
      }
      // Transparent alias (entity order).
      for (let ei = 0; ei < this.entities.length; ei++) {
        const e = this.entities[ei]!;
        if (this.entityKind(e.model) !== 'md2') continue;
        const alpha = clamp01(e.alpha ?? 1);
        if (alpha <= 0 || alpha >= 1) continue;
        this.drawAlias(gl, V, P, e, e.depthHack === true, lights, alpha);
      }
    }
    // Beams (flat quads, blend-pass state).
    {
      const beamBatch = emptyFlatBatch();
      for (let ei = 0; ei < this.entities.length; ei++) {
        const e = this.entities[ei]!;
        if (this.entityKind(e.model) !== 'tracer') continue;
        const seg = resolveBeam(e);
        const c = (seg.color & 255) * 3;
        emitBeamQuad(
          beamBatch, seg.ax, seg.ay, seg.az, seg.bx, seg.by, seg.bz, cam,
          (palette[c] ?? 0) / 255, (palette[c + 1] ?? 0) / 255, (palette[c + 2] ?? 0) / 255, 1,
        );
      }
      if (beamBatch.idx.length > 0) this.drawFlatBatch(gl, VP, beamBatch, null);
    }
    // Transparent sprites ride the blend pass too (entity order).
    {
      const spriteBlend = new Map<number, FlatBatch>();
      for (let ei = 0; ei < this.entities.length; ei++) {
        const e = this.entities[ei]!;
        if (this.entityKind(e.model) !== 'sp2') continue;
        const alpha = clamp01(e.alpha ?? 1);
        if (alpha <= 0 || alpha >= 1) continue;
        let b = spriteBlend.get(e.skin);
        if (!b) {
          b = emptyFlatBatch();
          spriteBlend.set(e.skin, b);
        }
        this.emitSprite(b, e, cam, alpha);
      }
      for (const [skinHandle, b] of spriteBlend) {
        if (b.idx.length > 0) this.drawFlatBatch(gl, VP, b, this.skinFor(gl, skinHandle)?.tex ?? null);
      }
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  private drawAlias(
    gl: WebGL2RenderingContext,
    V: Float32Array,
    P: Float32Array,
    e: Entity,
    gun: boolean,
    lights: GpuLight[],
    alphaOverride?: number,
  ): void {
    const progs = this.progs;
    if (!progs) return;
    const reg = this.models.get(e.model);
    const mesh = reg?.mesh ?? null;
    if (!mesh) {
      this.warn(`alias entity model ${e.model} has no mesh (skipped)`);
      return;
    }
    const { frameA, frameB, lerp } = resolveAliasLerp(e.frame, e.oldframe, e.backlerp, mesh.numFrames);
    const skin = this.skinFor(gl, e.skin);
    if (!skin) {
      this.warn(`alias entity skin ${e.skin} missing (white fallback)`);
    }
    // Interpolated positions + shade base into the shared dynamic buffers.
    // Small per-frame garbage (two scratch arrays per alias entity) is the
    // documented PROOF-3 cost; static geometry never re-uploads.
    const nv = mesh.numVerts;
    this.ensureDynCapacity(gl, nv);
    const posArr = new Float32Array(nv * 3);
    const shadeArr = new Float32Array(nv);
    interpolateAliasFrame(mesh, frameA, frameB, lerp, posArr);
    aliasShadeBase(mesh, frameA, frameB, lerp, ((e.angles[1]! * 256) / 360) & 255, shadeArr);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynPos);
    gl.bufferData(gl.ARRAY_BUFFER, posArr, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynShade);
    gl.bufferData(gl.ARRAY_BUFFER, shadeArr, gl.DYNAMIC_DRAW);
    const mgl = this.ensureModelGL(gl, e.model, mesh);
    if (!mgl) return;
    const M = buildEntityModel(e.origin, e.angles);
    const MV = multiplyMat4(V, M);
    const MVP = multiplyMat4(P, MV);
    const alias = progs.alias;
    gl.useProgram(alias.prog);
    this.setMVP(gl, alias, MVP, gun ? GUN_DEPTH_SCALE : 1);
    if (alias.uDepthBias) gl.uniform1f(alias.uDepthBias, gun ? GUN_DEPTH_BIAS : 0);
    this.setLights(gl, alias, lights);
    this.bindDiffuse(gl, alias, skin?.tex ?? this.whiteFor(gl));
    const alpha = alphaOverride ?? clamp01(e.alpha ?? 1);
    if (alias.uAlpha) gl.uniform1f(alias.uAlpha, alpha);
    // Skin st are texel units; uUVScale normalizes by the bound skin dims.
    // (CPU wraps with a POT mask; registered skins are POT-expanded with
    // edge repeat, and st are pre-clamped to the header dims, so CLAMP is
    // equivalent here.)
    if (alias.uUVScale) gl.uniform2f(alias.uUVScale, 1 / (skin?.w ?? 1), 1 / (skin?.h ?? 1));
    this.bindAttrib(gl, 0, this.dynPos, 3);
    this.bindAttrib(gl, 1, mgl.uvBuf, 2);
    this.bindAttrib(gl, 2, this.dynShade, 1);
    this.bindAttrib(gl, 3, this.onesFor(gl), 1);
    this.bindIndex(gl, mgl.idxBuf);
    gl.drawElements(gl.TRIANGLES, mgl.count, gl.UNSIGNED_INT, 0);
  }

  private emitSprite(batch: FlatBatch, e: Entity, cam: Camera, alpha: number): void {
    const skin = this.skins.get(e.skin);
    if (!skin) {
      this.warn(`sprite entity skin ${e.skin} missing (skipped)`);
      return;
    }
    // White vertex color: the bound skin texture carries the color.
    emitSpriteQuad(batch, e.origin, cam, skin.width, skin.height, 1, 1, 1, alpha);
  }

  private setMVP(gl: WebGL2RenderingContext, p: ProgLocs, mvp: Float32Array, scale: number): void {
    if (p.uMVP) gl.uniformMatrix4fv(p.uMVP, false, mvp);
    if (p.uDepthScale) gl.uniform1f(p.uDepthScale, scale);
  }

  private setLights(gl: WebGL2RenderingContext, p: ProgLocs, lights: GpuLight[]): void {
    const pos = new Float32Array(MAX_GPU_LIGHTS * 4);
    const col = new Float32Array(MAX_GPU_LIGHTS * 3);
    for (let i = 0; i < lights.length && i < MAX_GPU_LIGHTS; i++) {
      const L = lights[i]!;
      pos[i * 4] = L.origin[0]!;
      pos[i * 4 + 1] = L.origin[1]!;
      pos[i * 4 + 2] = L.origin[2]!;
      pos[i * 4 + 3] = L.intensity;
      col[i * 3] = L.color[0]!;
      col[i * 3 + 1] = L.color[1]!;
      col[i * 3 + 2] = L.color[2]!;
    }
    if (p.uLightPos) gl.uniform4fv(p.uLightPos, pos);
    if (p.uLightColor) gl.uniform3fv(p.uLightColor, col);
    if (p.uNumLights) gl.uniform1i(p.uNumLights, Math.min(lights.length, MAX_GPU_LIGHTS));
  }

  private bindDiffuse(gl: WebGL2RenderingContext, p: ProgLocs, tex: WebGLTexture): void {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (p.uDiffuse) gl.uniform1i(p.uDiffuse, 0);
  }

  private bindLightmap(gl: WebGL2RenderingContext, p: ProgLocs): void {
    if (!this.atlasTex) return;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    if (p.uLightmap) gl.uniform1i(p.uLightmap, 1);
  }

  private bindAttrib(gl: WebGL2RenderingContext, loc: number, buf: WebGLBuffer | null, size: number): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  private bindIndex(gl: WebGL2RenderingContext, buf: WebGLBuffer | null): void {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf);
  }

  private bindWorldBatch(gl: WebGL2RenderingContext, b: GLBatch): void {
    this.bindAttrib(gl, 0, b.posBuf, 3);
    this.bindAttrib(gl, 1, b.uvBuf, 2);
    this.bindAttrib(gl, 2, b.luvBuf, 2);
    this.bindAttrib(gl, 3, b.alphaBuf, 1);
    this.bindIndex(gl, b.idxBuf);
  }

  private drawFlatBatch(
    gl: WebGL2RenderingContext,
    VP: Float32Array,
    batch: FlatBatch,
    tex: WebGLTexture | null,
  ): void {
    const progs = this.progs;
    if (!progs || batch.idx.length === 0) return;
    const flat = progs.flat;
    gl.useProgram(flat.prog);
    this.setMVP(gl, flat, VP, 1);
    if (flat.uPointSize) gl.uniform1f(flat.uPointSize, 1);
    if (flat.uTextured) gl.uniform1i(flat.uTextured, tex ? 1 : 0);
    if (tex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (flat.uMap) gl.uniform1i(flat.uMap, 0);
    }
    const n = batch.pos.length / 3;
    this.ensureFlatCapacity(gl, n, batch.idx.length);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatPos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(batch.pos), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatCol);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(batch.col), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatUV);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(batch.uv), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.flatIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(batch.idx), gl.DYNAMIC_DRAW);
    this.bindAttrib(gl, 0, this.flatPos, 3);
    this.bindAttrib(gl, 1, this.flatCol, 4);
    this.bindAttrib(gl, 2, this.flatUV, 2);
    this.bindIndex(gl, this.flatIdx);
    gl.drawElements(gl.TRIANGLES, batch.idx.length, gl.UNSIGNED_INT, 0);
  }

  private drawPoints(
    gl: WebGL2RenderingContext,
    VP: Float32Array,
    positions: Float32Array,
    colors: Float32Array,
  ): void {
    const progs = this.progs;
    if (!progs) return;
    const flat = progs.flat;
    gl.useProgram(flat.prog);
    this.setMVP(gl, flat, VP, 1);
    if (flat.uPointSize) gl.uniform1f(flat.uPointSize, 1);
    if (flat.uTextured) gl.uniform1i(flat.uTextured, 0);
    this.ensurePointCapacity(gl, positions.length / 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointPos);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointCol);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    this.bindAttrib(gl, 0, this.pointPos, 3);
    this.bindAttrib(gl, 1, this.pointCol, 4);
    // aUV (loc 2) is don't-care for untextured POINTS: bind the filler.
    this.bindAttrib(gl, 2, this.onesFor(gl), 2);
    gl.drawArrays(gl.POINTS, 0, positions.length / 3);
  }

  private ensureDynCapacity(gl: WebGL2RenderingContext, nv: number): void {
    if (!this.dynPos || !this.dynShade || this.dynSize < nv) {
      this.dynPos = gl.createBuffer();
      this.dynShade = gl.createBuffer();
      if (!this.dynPos || !this.dynShade) this.fail('WebGLRenderer: createBuffer returned null');
      this.dynSize = Math.max(nv, 64);
    }
  }

  private ensureFlatCapacity(gl: WebGL2RenderingContext, nverts: number, nidx: number): void {
    if (!this.flatPos || !this.flatCol || !this.flatUV || !this.flatIdx ||
      this.flatSize < nverts || this.flatIdxSize < nidx) {
      this.flatPos = gl.createBuffer();
      this.flatCol = gl.createBuffer();
      this.flatUV = gl.createBuffer();
      this.flatIdx = gl.createBuffer();
      if (!this.flatPos || !this.flatCol || !this.flatUV || !this.flatIdx) {
        this.fail('WebGLRenderer: createBuffer returned null');
      }
      this.flatSize = Math.max(nverts, 16);
      this.flatIdxSize = Math.max(nidx, 16);
    }
  }

  private ensurePointCapacity(gl: WebGL2RenderingContext, n: number): void {
    if (!this.pointPos || !this.pointCol || this.pointCount < n) {
      this.pointPos = gl.createBuffer();
      this.pointCol = gl.createBuffer();
      if (!this.pointPos || !this.pointCol) this.fail('WebGLRenderer: createBuffer returned null');
      this.pointCount = Math.max(n, 16);
    }
  }

  /** Per-model static UV/index cache (positions interpolate per frame). */
  private ensureModelGL(gl: WebGL2RenderingContext, handle: number, mesh: AliasMesh): ModelGL | null {
    const hit = this.modelGL.get(handle);
    if (hit) return hit;
    const uvBuf = gl.createBuffer();
    const idxBuf = gl.createBuffer();
    if (!uvBuf || !idxBuf) this.fail('WebGLRenderer: createBuffer returned null');
    // UVs stay in MD2 texel units here; uUVScale normalizes per draw by the
    // bound skin dims. Indices widen to Uint32 (drawElements UNSIGNED_INT).
    const entry: ModelGL = { uvBuf, idxBuf, count: mesh.tris.length, nv: mesh.numVerts };
    this.modelGL.set(handle, entry);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.st, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(mesh.tris), gl.STATIC_DRAW);
    return entry;
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
