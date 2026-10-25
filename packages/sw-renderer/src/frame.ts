// @q2/sw-renderer frame — r_main.c equivalent: R_SetupFrame, viewcluster,
// per-surface batching (surface cache -> edge emit -> row z-sort -> spans),
// alias/sprite/particle draws, palette resolve. Zero allocation per frame:
// every scratch buffer lives on the renderer instance.

import type {
  Entity, Framebuffer, FrameStats, Model, ModelHandle, RefDef, Refresh, TextureHandle, WorldModel,
} from '@q2/renderer-api';
import { DLightState, buildLightMap, type DynamicLight, type SurfaceBounds } from './light.js';
import { SurfaceCache, hashLightStyles, type SurfaceBlock } from './surfaceCache.js';
import { setupCamera, type Camera } from './camera.js';
import {
  collectVisibleSurfaces, findLeaf, isMiniWorld, surfFrustumCulled,
  type MiniSurf, type MiniWorld,
} from './worldNodes.js';
import {
  createEdgeScratch, emitSpansForPoly, projectClippedPoly,
  type EdgeScratch, type PolyInput,
} from './edges.js';
import {
  SPAN_OPAQUE, SPAN_TURBULENT, buildTurbTable, createSpan,
  drawSpansSoftware, drawSpansTurbulent,
  type LightBlock, type RasterBackend, type Span, type SpanList, type Texture,
} from './spans.js';
import { buildANorms, buildShadeDots, createBoxMesh, type AliasMesh } from './alias.js';
import { drawAliasInstance } from './alias.js';
import { drawSprite } from './sprites.js';
import { drawParticles, projectParticles, type ScreenParticle } from './particles.js';
import { buildColormap, defaultPalette } from './colormap.js';
import { createDevroom, getDevMesh } from './devroom.js';

export const MAX_SPANS = 16384;
const MAX_ROW = 4096;

function isAliasMesh(data: unknown): data is AliasMesh {
  if (!data || typeof data !== 'object') return false;
  const m = data as Record<string, unknown>;
  return m.frames instanceof Float32Array && m.tris instanceof Uint16Array
    && typeof m.numVerts === 'number' && typeof m.numTris === 'number'
    && m.st instanceof Float32Array && m.normals instanceof Uint8Array;
}

/** Monomorphic backend: owns framebuffer views, dispatches per span kind. */
export class SoftwareBackend implements RasterBackend {
  idx: Uint8Array = new Uint8Array(0);
  zb: Float32Array = new Float32Array(0);
  fbW = 0;
  fbH = 0;
  colormap: Uint8Array = new Uint8Array(0);
  turbTable: Uint8Array = buildTurbTable();
  time = 0;
  spansDrawn = 0;
  pixelsDrawn = 0;

  attach(idx: Uint8Array, zb: Float32Array, w: number, h: number, colormap: Uint8Array): void {
    this.idx = idx;
    this.zb = zb;
    this.fbW = w;
    this.fbH = h;
    this.colormap = colormap;
  }

  /** Branch on the span kind, never in the pixel loop (BRAIN.md §2). */
  drawSpans(list: SpanList, tex: Texture, light: LightBlock): void {
    const a = drawSpansSoftware(this.idx, this.zb, this.fbW, this.fbH, list, tex, light, this.colormap);
    const b = drawSpansTurbulent(this.idx, this.zb, this.fbW, this.fbH, list, tex, this.colormap, this.turbTable, this.time);
    this.spansDrawn += a.spans + b.spans;
    this.pixelsDrawn += a.pixels + b.pixels;
  }
}

/** In-place per-row z-sort of a span batch: rows ascending, 1/z descending,
 *  BSP traversal order ascending (R_ScanEdges semantics, coplanar-stable). */
export function sortBatchByRow(
  spans: Span[], start: number, count: number, H: number,
  rowBase: Int32Array, tmp: Span[],
): void {
  if (count <= 1 || H <= 0) return;
  const h = H > MAX_ROW ? MAX_ROW : H;
  rowBase.fill(0, 0, h + 1);
  for (let i = 0; i < count; i++) {
    let y = spans[start + i]!.y;
    if (y < 0) y = 0;
    else if (y >= h) y = h - 1;
    rowBase[y + 1]++;
  }
  for (let y = 0; y < h; y++) rowBase[y + 1] += rowBase[y]!;
  for (let i = 0; i < count; i++) {
    let y = spans[start + i]!.y;
    if (y < 0) y = 0;
    else if (y >= h) y = h - 1;
    tmp[rowBase[y]++] = spans[start + i]!;
  }
  // tmp now holds spans grouped by row at [0, count); insertion-sort rows.
  let runStart = 0;
  // rowBase[y] was advanced; recompute boundaries via recount is wasteful:
  // instead sort by scanning runs of equal y.
  while (runStart < count) {
    const y = tmp[runStart]!.y;
    let runEnd = runStart + 1;
    while (runEnd < count && tmp[runEnd]!.y === y) runEnd++;
    for (let i = runStart + 1; i < runEnd; i++) {
      const t = tmp[i]!;
      const tiz = t.iz, tord = t.ord;
      let j = i - 1;
      while (j >= runStart && (tmp[j]!.iz < tiz || (tmp[j]!.iz === tiz && tmp[j]!.ord > tord))) {
        tmp[j + 1] = tmp[j]!;
        j--;
      }
      tmp[j + 1] = t;
    }
    runStart = runEnd;
  }
  for (let i = 0; i < count; i++) spans[start + i] = tmp[i]!;
}

interface RegisteredModel {
  kind: string;
  data: unknown;
}

export class SoftwareRenderer implements Refresh {
  private fbW = 0;
  private fbH = 0;
  private idx: Uint8Array = new Uint8Array(0);
  private zb: Float32Array = new Float32Array(0);
  private color: Uint32Array = new Uint32Array(0);
  private palette: Uint8Array = defaultPalette();
  private colormap: Uint8Array = buildColormap(this.palette);
  private backend = new SoftwareBackend();
  private cache = new SurfaceCache();
  private dlights = new DLightState();
  private lastDynSerial = 0;
  private models: RegisteredModel[] = [];
  private skins: Texture[] = [];
  private scratch: EdgeScratch = createEdgeScratch(64);
  private pool: Span[] = [];
  private spanList: SpanList = { spans: [], count: 0 };
  private spriteScratch: SpanList = { spans: [], count: 0 };
  private tmpSort: Span[] = [];
  private rowBase = new Int32Array(MAX_ROW + 1);
  private visSurfs: number[] = [];
  private visOrder: number[] = [];
  private surfBounds: SurfaceBounds[] = [];
  private polyInput: PolyInput = {
    verts: new Float32Array(0), uvs: new Float32Array(0), lux: new Float32Array(0), n: 0,
  };
  private anorms = buildANorms();
  private shadeDots = buildShadeDots(this.anorms);
  private partPool: ScreenParticle[] = [];
  private partOrigins = new Float32Array(3 * 256);
  private partColors = new Uint8Array(256);
  private frame = 0;
  private fallbackMesh = createBoxMesh(20);
  private lightBlockScratch: Uint8Array = new Uint8Array(0);
  private styleScratch = new Float32Array(8);
  private frameStats: FrameStats = { spans: 0, pixels: 0, overdraw: 0, ms: 0 };

  init(fb: Framebuffer): void {
    this.fbW = fb.width;
    this.fbH = fb.height;
    this.idx = fb.index ?? new Uint8Array(fb.width * fb.height);
    this.zb = fb.depth;
    this.color = fb.color;
    for (let i = 0; i < MAX_SPANS; i++) this.pool.push(createSpan());
    for (let i = 0; i < MAX_SPANS; i++) this.tmpSort.push(this.pool[i]!);
    this.spanList = { spans: this.pool, count: 0 };
    this.backend.attach(this.idx, this.zb, this.fbW, this.fbH, this.colormap);
  }

  setPalette(p: Uint8Array): void {
    this.palette = p.length >= 768 ? p.slice(0, 768) : defaultPalette();
    this.colormap = buildColormap(this.palette);
    this.backend.colormap = this.colormap;
  }

  registerModel(m: Model): ModelHandle {
    this.models.push({ kind: m.kind, data: m.data });
    return this.models.length - 1;
  }

  registerSkin(name: string): TextureHandle {
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const size = 32;
    const texels = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const c = (((x >> 3) + (y >> 3) + (h & 7)) & 1) === 0 ? 200 : 90;
        texels[y * size + x] = (c + ((h >> (x & 7)) & 15)) & 255;
      }
    }
    this.skins.push({ width: size, height: size, texels });
    return this.skins.length - 1;
  }

  beginFrame(): void {
    this.frame++;
    this.idx.fill(0);
    this.zb.fill(0);
    this.backend.spansDrawn = 0;
    this.backend.pixelsDrawn = 0;
    this.backend.time = 0;
  }

  renderView(view: RefDef, world: WorldModel, entities: Entity[]): FrameStats {
    const t0 = Date.now();
    const worldData = isMiniWorld(world.data) ? world.data : createDevroom();
    const cam = setupCamera(view.origin, view.angles, view.fovX, this.fbW, this.fbH);
    this.backend.time = view.time;
    // dynamic lights -> cache invalidation (serial change = add/remove)
    if (this.dlights.serial !== this.lastDynSerial) {
      this.cache.invalidateAll();
      this.lastDynSerial = this.dlights.serial;
    }
    const nSurfs = worldData.surfaces.length;
    const bounds = this.surfBounds;
    while (bounds.length < nSurfs) {
      bounds.push({ id: 0, mins: new Float32Array(3), maxs: new Float32Array(3) });
    }
    for (let i = 0; i < nSurfs; i++) {
      const s = worldData.surfaces[i]!;
      const b = bounds[i]!;
      b.id = s.id;
      b.mins = s.mins;
      b.maxs = s.maxs;
    }
    const dyn: DynamicLight[] = this.dlights.lights.length > 0
      ? this.dlights.lights
      : worldData.dynamicLights;
    const dlState = this.dlights;
    const savedLights = dlState.lights;
    dlState.lights = dyn;
    const affected = dlState.markLights(bounds, nSurfs);
    dlState.lights = savedLights;
    if (affected.length > 0) this.cache.invalidateSurfaces(affected);
    const hasRendererLights = savedLights.length > 0;
    const dlightFrameBits = (id: number): number => {
      if (hasRendererLights) return dlState.bitsFor(id);
      // world-embedded lights always affect bit 0 when marked this frame
      return affected.includes(id) ? 1 : 0;
    };

    // viewcluster + traversal
    const leaf = worldData.nodes.length === 0 ? 0 : findLeaf(worldData.nodes, view.origin);
    const viewCluster = worldData.leafs[leaf]?.cluster ?? 0;
    while (this.visSurfs.length < worldData.surfaces.length) {
      this.visSurfs.push(0);
      this.visOrder.push(0);
    }
    const nvis = collectVisibleSurfaces(worldData, cam, viewCluster, this.visSurfs, this.visOrder);

    let spansEmitted = 0;
    let candidatePixels = 0;
    // per-surface batches: cache -> emit -> row z-sort -> draw
    for (let vi = 0; vi < nvis; vi++) {
      const si = this.visSurfs[vi]!;
      const order = this.visOrder[vi]!;
      const surf = worldData.surfaces[si]!;
      if (surfFrustumCulled(cam, surf)) continue;
      const dist = Math.sqrt(
        (surf.center[0]! - view.origin[0]!) ** 2 +
        (surf.center[1]! - view.origin[1]!) ** 2 +
        (surf.center[2]! - view.origin[2]!) ** 2,
      );
      const mip = dist < 320 ? 0 : dist < 640 ? 1 : dist < 1280 ? 2 : 3;
      const lm = worldData.lightmaps[surf.lightId % worldData.lightmaps.length]!;
      const nStyles = Math.min(lm.styles.length, this.styleScratch.length);
      for (let k = 0; k < nStyles; k++) {
        this.styleScratch[k] = view.lightStyles[lm.styles[k]!] ?? 0;
      }
      const stylesHash = hashLightStyles(this.styleScratch, nStyles);
      let block = this.cache.get(surf.id, stylesHash, mip);
      if (!block) {
        // copy the style scales out of scratch (build is a miss-only path)
        const scalesCopy = [this.styleScratch[0] ?? 1];
        for (let k = 1; k < nStyles; k++) scalesCopy.push(this.styleScratch[k]!);
        block = this.buildSurfaceBlock(worldData, surf, mip, scalesCopy, dyn, dlightFrameBits(surf.id));
        this.cache.put(surf.id, stylesHash, mip, block);
      }
      const tex = texView;
      tex.width = block.bw;
      tex.height = block.bh;
      tex.texels = block.texels;
      const lb = lightView;
      lb.width = block.luxW;
      lb.height = block.luxH;
      lb.values = block.light;
      // emit
      this.polyInput.verts = surf.verts;
      this.polyInput.uvs = surf.uvs;
      this.polyInput.lux = surf.lux;
      this.polyInput.n = surf.n;
      const nproj = projectClippedPoly(this.polyInput, cam, this.fbW, this.fbH, this.scratch);
      if (nproj < 3) continue;
      const start = this.spanList.count;
      const endCount = emitSpansForPoly(
        this.scratch.poly, nproj, order, this.pool, start, MAX_SPANS, 63, 0, this.fbH,
      );
      if (endCount <= start) continue;
      for (let i = start; i < endCount; i++) {
        const sp = this.pool[i]!;
        sp.kind = surf.turbulent ? SPAN_TURBULENT : SPAN_OPAQUE;
        sp.ord = order;
      }
      sortBatchByRow(this.pool, start, endCount - start, this.fbH, this.rowBase, this.tmpSort);
      this.spanList.count = endCount;
      const before = this.backend.pixelsDrawn;
      this.backend.drawSpans(this.spanList, tex, lb);
      candidatePixels += this.backend.pixelsDrawn - before;
      this.spanList.count = 0;
      spansEmitted += endCount - start;
    }

    // world-placed alias / sprites / particles (M3.4 in the devroom)
    for (const pa of worldData.alias) {
      const mesh = getDevMeshSafe(pa.meshId, this.fallbackMesh);
      const skin = worldData.textures[pa.skinId % worldData.textures.length]!;
      drawAliasInstance(this.idx, this.zb, this.fbW, this.fbH, {
        mesh, origin: pa.origin, angles: pa.angles,
        frameA: pa.frameA, frameB: pa.frameB, lerp: pa.lerp,
        lightAngle: ((pa.angles[1]! * 256) / 360) & 255,
      }, skin, cam, this.anorms, this.shadeDots, this.colormap);
    }
    for (const ps of worldData.sprites) {
      const tex = worldData.textures[ps.skinId % worldData.textures.length]!;
      drawSprite(this.idx, this.zb, this.fbW, this.fbH,
        { origin: ps.origin, width: ps.size, height: ps.size, texId: 0, grade: 60 },
        [{ width: tex.width, height: tex.height, texels: tex.texels }],
        emptyLight, this.colormap, cam, this.spriteScratch, 1024);
    }
    if (worldData.particles.length > 0) {
      const n = Math.min(worldData.particles.length, 256);
      for (let i = 0; i < n; i++) {
        const wp = worldData.particles[i]!;
        this.partOrigins[i * 3] = wp.origin[0]!;
        this.partOrigins[i * 3 + 1] = wp.origin[1]!;
        this.partOrigins[i * 3 + 2] = wp.origin[2]!;
        this.partColors[i] = wp.color;
      }
      const np = projectParticles(
        this.partOrigins, this.partColors, n,
        cam.origin, cam.forward, cam.right, cam.up,
        cam.xCenter, cam.yCenter, cam.focalX, cam.focalY, cam.near,
        this.partPool,
      );
      drawParticles(this.idx, this.zb, this.fbW, this.fbH, this.partPool, 0, np);
    }

    // entities (game-driven; model kind selects the M3.4 path)
    for (let ei = 0; ei < entities.length; ei++) {
      const e = entities[ei]!;
      const m = this.models[e.model];
      if (!m) continue;
      if (m.kind === 'md2' && isAliasMesh(m.data)) {
        const skin = this.skins[e.skin] ?? devSkin0(worldData);
        drawAliasInstance(this.idx, this.zb, this.fbW, this.fbH, {
          mesh: m.data, origin: e.origin, angles: e.angles,
          frameA: e.frame, frameB: e.frame, lerp: 0,
          lightAngle: ((e.angles[1]! * 256) / 360) & 255,
        }, skin, cam, this.anorms, this.shadeDots, this.colormap);
      } else if (m.kind === 'sp2') {
        const skin = this.skins[e.skin] ?? devSkin0(worldData);
        drawSprite(this.idx, this.zb, this.fbW, this.fbH,
          { origin: e.origin, width: 48, height: 48, texId: 0, grade: 60 },
          [skin], emptyLight, this.colormap, cam, this.spriteScratch, 1024);
      }
    }

    const ms = Date.now() - t0;
    const area = this.fbW * this.fbH;
    this.frameStats = {
      spans: spansEmitted + this.backend.spansDrawn,
      pixels: this.backend.pixelsDrawn,
      overdraw: area > 0 ? candidatePixels / area : 0,
      ms,
    };
    return this.frameStats;
  }

  endFrame(): void {
    // palette expand to 0xAABBGGRR
    const pal = this.palette;
    const n = this.fbW * this.fbH;
    for (let i = 0; i < n; i++) {
      const c = this.idx[i]! * 3;
      const r = pal[c]!, g = pal[c + 1]!, b = pal[c + 2]!;
      this.color[i] = (0xff << 24) | (b << 16) | (g << 8) | r;
    }
  }

  /** Test hook: renderer-owned dynamic lights (R_MarkLights input). */
  testAddDynamicLight(l: DynamicLight): void {
    this.dlights.addLight(l);
  }

  testClearDynamicLights(): void {
    this.dlights.clear();
  }

  /** Observability for bench/golden (BRAIN.md §10.3: cache hit rate). */
  testCacheStats(): { hits: number; misses: number; evictions: number; used: number; size: number; hitRate: number } {
    const c = this.cache;
    return { hits: c.hits, misses: c.misses, evictions: c.evictions, used: c.used, size: c.size, hitRate: c.hitRate() };
  }

  testResetCacheStats(): void {
    this.cache.resetStats();
  }

  private buildSurfaceBlock(
    world: MiniWorld, surf: MiniSurf, mip: number,
    scales: number[], dyn: DynamicLight[], dlightBits: number,
  ): SurfaceBlock {
    const src = world.textures[surf.texId % world.textures.length]!;
    const shift = mip > 3 ? 3 : mip;
    const bw = Math.max(1, src.width >> shift);
    const bh = Math.max(1, src.height >> shift);
    const texels = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        texels[y * bw + x] = src.texels[(y << shift) * src.width + (x << shift)]!;
      }
    }
    const lm = world.lightmaps[surf.lightId % world.lightmaps.length]!;
    const n = lm.luxW * lm.luxH;
    if (this.lightBlockScratch.length < n) this.lightBlockScratch = new Uint8Array(n);
    // NOTE: lightBlockScratch is reused then copied; the cache owns the copy.
    buildLightMap(this.lightBlockScratch, lm.samples, lm.luxW, lm.luxH, scales, dyn, surf.center, dlightBits);
    return {
      texels, bw, bh,
      light: this.lightBlockScratch.slice(0, n),
      luxW: lm.luxW, luxH: lm.luxH,
    };
  }
}

function getDevMeshSafe(id: number, fallback: AliasMesh): AliasMesh {
  try {
    return getDevMesh(id);
  } catch {
    return fallback;
  }
}

const texView: Texture = { width: 0, height: 0, texels: new Uint8Array(0) };
const lightView: LightBlock = { width: 1, height: 1, values: new Uint8Array(0) };
const emptyLight: LightBlock = { width: 1, height: 1, values: new Uint8Array([63]) };

let devSkinMemo: Texture | null = null;

function devSkin0(world: MiniWorld): Texture {
  if (!devSkinMemo) {
    const t = world.textures[0] ?? { texels: new Uint8Array(1024), width: 32, height: 32 };
    devSkinMemo = { width: t.width, height: t.height, texels: t.texels };
  }
  return devSkinMemo;
}
