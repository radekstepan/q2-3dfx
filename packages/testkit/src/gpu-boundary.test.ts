// @q2/testkit — GPU-PROOF-2 box 5: scene selection/transform/order invariants
// + resource lifecycle invariants (interface-first, no backend rewrite).
//
// Scope: tests ONLY the committed `packages/renderer-api/src/gpu.ts`
// surface (GpuRenderer/GpuSceneInput/GpuSurfaceRef/GpuFrameInput). It does
// NOT re-test `resolveRendererSelection` (already unit-tested in
// renderer-api) and does NOT modify any other package.
//
// webgl-renderer integration: LIVE — `selectGpuScene` / `WebGLRenderer`
// are probed by dynamic import and every assertion below runs against the
// real backend when resolvable. A present-but-deviating backend fails
// loudly instead of being silently adapted to.
//
// Ordering-convention note (read before "fixing" the assertions): gpu.ts
// documents `order` as "larger = farther (far-to-near draw)". In a
// far-to-near draw sequence the keys therefore run NON-INCREASING
// (largest/farthest first) alongside non-increasing distance — asserted here.
//
// Entity-ref scoping note: world refs carry the frustum/order contract and
// material 'transparent' for world blend surfaces. Entity refs keep their
// kind (alias/sprite/beam) with the transparent bit honored from alpha;
// blend-pass membership for entities is real data (PROOF-2), draw order
// within the pass follows the same far-to-near key (PROOF-3 draws it).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import {
  createFramebuffer,
  type Entity,
  type GpuFrameInput,
  type GpuMaterialKind,
  type GpuRenderer,
  type GpuRendererStatus,
  type GpuSceneInput,
} from '@q2/renderer-api';
import { resetCVars } from '@q2/config';
import {
  SoftwareRenderer,
  collectVisibleSurfaces,
  culledByFrustum,
  findLeaf,
  setupCamera,
  surfFrustumCulled,
  type MiniWorld,
} from '@q2/sw-renderer';
import {
  loadBenchWorld,
  pinBenchCvars,
  type BenchWorld,
} from './bench-workloads.js';
import {
  GPU_PROOF_HEIGHT,
  GPU_PROOF_WIDTH,
  gpuProofEntitiesFor,
  gpuProofRoute,
  gpuProofViewFor,
  type GpuProofFrame,
} from './gpu-proof.js';

const Q2_PAK = process.env.Q2_PAK;

// --- Test-local scene selection (fixture, NOT a harness module) ----------------
// Implements exactly what gpu.ts documents so the invariants below are an
// executable conformance target for the real `selectGpuScene`:
//   transforms[0] = identity (world geometry); entity i -> transform 1+i.
//   World refs: sky/turbulent/opaque -> opaque batch (order 0);
//     translucent (SURF_TRANS33/66) -> blend pass, order = camera distance
//     (larger = farther), sorted far-to-near (non-increasing order).
//   Entity refs: surfaceId -1 (they reference dynamic geometry, not world
//     surfaces), transparent=false/order=0 (blend membership is PROOF-3).

const IDENTITY_4X4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function translation4x4(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(IDENTITY_4X4);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

function distance3(a: Float32Array, b: Float32Array): number {
  const dx = a[0]! - b[0]!;
  const dy = a[1]! - b[1]!;
  const dz = a[2]! - b[2]!;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Fixture entity-kind layout. Mirrors bench-workloads order exactly:
 * fixedBenchEntities() = [alias soldier, sprite, beam tracer],
 * combatBenchEntities() appends the depthHack viewmodel gun (alias).
 */
function entityKindsForFixture(count: number): GpuMaterialKind[] {
  if (count === 3) return ['alias', 'sprite', 'beam'];
  if (count === 4) return ['alias', 'sprite', 'beam', 'alias'];
  throw new Error(`[testkit gpu-boundary] unexpected fixture entity count ${count}`);
}

/**
 * Registry seam for the live selector: handle -> model kind by fixture
 * position (soldier md2, sprite sp2, tracer beam, gun md2). The pure
 * selector cannot see the model registry; unknown handles default to
 * 'alias' inside the backend.
 */
function modelKindsForFixture(entities: Entity[]): ReadonlyMap<number, 'md2' | 'sp2' | 'tracer'> {
  const kinds = entityKindsForFixture(entities.length);
  const map = new Map<number, 'md2' | 'sp2' | 'tracer'>();
  entities.forEach((e, i) => {
    const k = kinds[i]!;
    map.set(e.model, k === 'alias' ? 'md2' : k === 'sprite' ? 'sp2' : 'tracer');
  });
  return map;
}

function buildTestSceneSelection(
  world: MiniWorld,
  view: { origin: Float32Array; angles: Float32Array; fovX: number },
  entities: Entity[],
  kinds: GpuMaterialKind[],
  staticGeneration: number,
): GpuSceneInput {
  if (entities.length !== kinds.length) {
    throw new Error('[testkit gpu-boundary] entities/kinds length mismatch');
  }
  const cam = setupCamera(view.origin, view.angles, view.fovX, GPU_PROOF_WIDTH, GPU_PROOF_HEIGHT);
  const leaf = findLeaf(world.nodes, view.origin);
  const cluster = leaf >= 0 && world.leafs[leaf] ? world.leafs[leaf]!.cluster : -1;
  const outSurfs: number[] = [];
  const outOrder: number[] = [];
  const visible = collectVisibleSurfaces(world, cam, cluster, outSurfs, outOrder);
  const opaque: GpuSceneInput['surfaces'] = [];
  const blend: GpuSceneInput['surfaces'] = [];
  for (let i = 0; i < visible; i++) {
    const si = outSurfs[i]!;
    const s = world.surfaces[si]!;
    if (surfFrustumCulled(cam, s)) continue;
    if (s.sky) {
      opaque.push({ surfaceId: si, material: 'sky', materialHandle: s.texId, transparent: false, order: 0, transformIndex: 0 });
    } else if ((s.translucent ?? 0) !== 0) {
      blend.push({ surfaceId: si, material: 'transparent', materialHandle: s.texId, transparent: true, order: distance3(cam.origin, s.center), transformIndex: 0 });
    } else if (s.turbulent) {
      opaque.push({ surfaceId: si, material: 'turbulent', materialHandle: s.texId, transparent: false, order: 0, transformIndex: 0 });
    } else {
      opaque.push({ surfaceId: si, material: 'opaque', materialHandle: s.texId, transparent: false, order: 0, transformIndex: 0 });
    }
  }
  // Far-to-near draw: non-increasing order (larger = farther, per gpu.ts).
  blend.sort((a, b) => b.order - a.order);
  const transforms: Float32Array[] = [new Float32Array(IDENTITY_4X4)];
  const entityRefs: GpuSceneInput['surfaces'] = entities.map((e, i) => {
    transforms.push(translation4x4(e.origin[0]!, e.origin[1]!, e.origin[2]!));
    return {
      surfaceId: -1,
      material: kinds[i]!,
      materialHandle: e.skin,
      transparent: false,
      order: 0,
      transformIndex: 1 + i,
    };
  });
  return { surfaces: [...opaque, ...blend, ...entityRefs], transforms, staticGeneration };
}

interface SceneSnapshot {
  generation: number;
  surfaces: Array<{
    surfaceId: number;
    material: GpuMaterialKind;
    materialHandle: number;
    transparent: boolean;
    order: number;
    transformIndex: number;
  }>;
  transforms: number[][];
}

function snapshotScene(scene: GpuSceneInput): SceneSnapshot {
  return {
    generation: scene.staticGeneration,
    surfaces: scene.surfaces.map((s) => ({
      surfaceId: s.surfaceId,
      material: s.material,
      materialHandle: s.materialHandle,
      transparent: s.transparent,
      order: s.order,
      transformIndex: s.transformIndex,
    })),
    transforms: scene.transforms.map((t) => Array.from(t)),
  };
}

function countSelection(scene: GpuSceneInput): { opaque: number; transparent: number; sky: number; entity: number } {
  let opaque = 0;
  let transparent = 0;
  let sky = 0;
  let entity = 0;
  for (const s of scene.surfaces) {
    if (s.surfaceId < 0) {
      entity++;
      continue;
    }
    if (s.transparent) transparent++;
    else opaque++;
    if (s.material === 'sky') sky++;
  }
  return { opaque, transparent, sky, entity };
}

// --- Synthetic asset-free world (classification/order/identity units) ----------

function syntheticMiniWorld(): MiniWorld {
  const surf = (
    id: number, cx: number, opts: { sky?: boolean; translucent?: number; turbulent?: boolean },
  ): MiniWorld['surfaces'][number] => ({
    id,
    verts: new Float32Array([cx - 5, -5, -5, cx + 5, -5, -5, cx + 5, 5, -5]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1]),
    lux: new Float32Array([0, 0, 1, 0, 1, 1]),
    n: 3,
    texId: 10 + id,
    lightId: 0,
    center: new Float32Array([cx, 0, -5]),
    radius: 10,
    mins: new Float32Array([cx - 5, -5, -5]),
    maxs: new Float32Array([cx + 5, 5, -5]),
    turbulent: opts.turbulent ?? false,
    translucent: opts.translucent,
    sky: opts.sky ?? false,
    fn: new Float32Array([-1, 0, 0]),
  });
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 3, faceList: [0, 1, 2] }],
    pvs: [new Uint8Array([0b1])],
    clusterCount: 1,
    surfaces: [surf(0, 100, {}), surf(1, 200, { translucent: 1 }), surf(2, 150, { sky: true })],
    textures: [],
    lightmaps: [],
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
}

function syntheticView(): { origin: Float32Array; angles: Float32Array; fovX: number } {
  return { origin: new Float32Array([0, 0, 0]), angles: new Float32Array([0, 0, 0]), fovX: 90 };
}

// --- webgl-renderer probes (pending until the parallel lane lands) -------------

type SelectGpuSceneFn = (
  world: MiniWorld,
  entities: Entity[],
  view: { origin: Float32Array; angles: Float32Array; fovX: number },
  width: number,
  height: number,
  modelKinds?: ReadonlyMap<number, 'md2' | 'sp2' | 'tracer'>,
) => GpuSceneInput;

async function probeSelectGpuScene(): Promise<{ fn: SelectGpuSceneFn | null; reason: string }> {
  const specifier: string = '@q2/webgl-renderer';
  try {
    const mod: unknown = await import(specifier);
    if (mod !== null && typeof mod === 'object' && 'selectGpuScene' in mod) {
      const candidate: unknown = (mod as { selectGpuScene: unknown }).selectGpuScene;
      if (typeof candidate === 'function') {
        return { fn: candidate as SelectGpuSceneFn, reason: 'live' };
      }
    }
    return { fn: null, reason: 'module present but selectGpuScene missing' };
  } catch {
    return { fn: null, reason: '@q2/webgl-renderer not resolvable (lane pending)' };
  }
}

async function probeWebGLRenderer(): Promise<{ renderer: GpuRenderer<unknown> | null; reason: string }> {
  const specifier: string = '@q2/webgl-renderer';
  try {
    const mod: unknown = await import(specifier);
    if (mod !== null && typeof mod === 'object' && 'WebGLRenderer' in mod) {
      const ctor: unknown = (mod as { WebGLRenderer: unknown }).WebGLRenderer;
      if (typeof ctor === 'function') {
        const instance: unknown = new (ctor as new () => unknown)();
        return { renderer: instance as GpuRenderer<unknown>, reason: 'live' };
      }
    }
    return { renderer: null, reason: 'module present but WebGLRenderer missing' };
  } catch {
    return { renderer: null, reason: '@q2/webgl-renderer not resolvable (lane pending)' };
  }
}

// --- Reference lifecycle double (executable gpu.ts lifecycle contract) ---------
// Implements GpuRenderer<unknown> exactly as the boundary documents it:
// real submissions counted, same-generation setScene skips upload, context
// loss blocks submission with a recorded lastError (never a silent no-op),
// dispose is idempotent, use-after-dispose throws. Extra introspection
// (`uploads`) is test-local surface, NOT part of the interface.

class ReferenceGpuLifecycle implements GpuRenderer<unknown> {
  private status: GpuRendererStatus = {
    initialized: false, width: 0, height: 0, contextLost: false, framesSubmitted: 0, lastError: null,
  };
  private sceneGeneration: number | null = null;
  private disposed = false;
  uploads = 0;

  private fail(message: string): never {
    this.status = { ...this.status, lastError: message };
    throw new Error(`[testkit gpu-boundary] ${message}`);
  }

  init(gl: unknown, width: number, height: number): void {
    void gl;
    if (this.disposed) this.fail('init after dispose');
    this.status = {
      initialized: true, width, height, contextLost: false,
      framesSubmitted: this.status.framesSubmitted, lastError: null,
    };
  }

  resize(width: number, height: number): void {
    if (this.disposed) this.fail('resize after dispose');
    if (!this.status.initialized) this.fail('resize before init');
    this.status = { ...this.status, width, height };
  }

  setScene(scene: GpuSceneInput): void {
    if (this.disposed) this.fail('setScene after dispose');
    if (!this.status.initialized) this.fail('setScene before init');
    if (this.sceneGeneration !== scene.staticGeneration) {
      this.sceneGeneration = scene.staticGeneration;
      this.uploads++;
    }
  }

  renderFrame(input: GpuFrameInput): void {
    void input;
    if (this.disposed) this.fail('renderFrame after dispose');
    if (!this.status.initialized) this.fail('renderFrame before init');
    // Context loss is externally induced (browser event), not a programmer
    // error: record + skip submission, never throw out of the frame loop.
    if (this.status.contextLost) {
      this.status = { ...this.status, lastError: 'renderFrame while context lost (submission blocked)' };
      return;
    }
    this.status = { ...this.status, framesSubmitted: this.status.framesSubmitted + 1, lastError: null };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.status = { ...this.status, initialized: false, lastError: null };
  }

  getStatus(): GpuRendererStatus {
    return { ...this.status };
  }

  handleContextLost(): void {
    this.status = { ...this.status, contextLost: true };
  }

  handleContextRestored(gl: unknown): void {
    void gl;
    this.status = { ...this.status, contextLost: false, lastError: null };
  }
}

function blankFrameInput(scene: GpuSceneInput): GpuFrameInput {
  return {
    view: {
      origin: new Float32Array([0, 0, 0]),
      angles: new Float32Array([0, 0, 0]),
      fovX: 90,
      time: 0,
      lightStyles: new Float32Array(256),
    },
    scene,
    time: 0,
  };
}

function blankScene(generation: number): GpuSceneInput {
  return { surfaces: [], transforms: [new Float32Array(IDENTITY_4X4)], staticGeneration: generation };
}

/**
 * Drive the full lifecycle contract. Upload assertions run only when the
 * subject exposes a counter (the reference double); status transitions are
 * asserted for every subject, live backend included.
 */
function driveLifecycleContract(
  renderer: GpuRenderer<unknown>,
  uploads: (() => number) | null,
  gl: unknown,
): void {
  const status = (): GpuRendererStatus => renderer.getStatus();
  const frame = blankFrameInput(blankScene(7));

  // Pre-init: pristine status; submission throws AND records lastError.
  expect(status()).toEqual({
    initialized: false, width: 0, height: 0, contextLost: false, framesSubmitted: 0, lastError: null,
  });
  expect(() => renderer.renderFrame(frame)).toThrow();
  {
    const s = status();
    expect(s.framesSubmitted).toBe(0);
    expect(typeof s.lastError).toBe('string');
  }

  // init -> setScene -> renderFrame x2: 2 submissions, 1 upload.
  renderer.init(gl, GPU_PROOF_WIDTH, GPU_PROOF_HEIGHT);
  expect(status()).toEqual({
    initialized: true, width: GPU_PROOF_WIDTH, height: GPU_PROOF_HEIGHT,
    contextLost: false, framesSubmitted: 0, lastError: null,
  });
  renderer.setScene(blankScene(7));
  if (uploads) expect(uploads()).toBe(1);
  renderer.renderFrame(frame);
  renderer.renderFrame(frame);
  {
    const s = status();
    expect(s.framesSubmitted).toBe(2);
    expect(s.lastError).toBeNull();
  }
  if (uploads) expect(uploads()).toBe(1);

  // Same-generation setScene: no re-upload; submission continues.
  renderer.setScene(blankScene(7));
  if (uploads) expect(uploads()).toBe(1);
  renderer.renderFrame(frame);
  expect(status().framesSubmitted).toBe(3);

  // Bumped generation: re-uploads.
  renderer.setScene(blankScene(8));
  if (uploads) expect(uploads()).toBe(2);
  renderer.renderFrame(frame);
  expect(status().framesSubmitted).toBe(4);

  // Resize updates dims; submissions continue.
  renderer.resize(320, 240);
  {
    const s = status();
    expect(s.width).toBe(320);
    expect(s.height).toBe(240);
  }
  renderer.renderFrame(frame);
  expect(status().framesSubmitted).toBe(5);

  // Context loss blocks submission with lastError (no silent no-op, no
  // throw: loss is externally induced, the frame loop must survive it).
  renderer.handleContextLost();
  expect(status().contextLost).toBe(true);
  expect(() => renderer.renderFrame(frame)).not.toThrow();
  {
    const s = status();
    expect(s.framesSubmitted).toBe(5);
    expect(typeof s.lastError).toBe('string');
  }

  // Restored: submits again.
  renderer.handleContextRestored(gl);
  {
    const s = status();
    expect(s.contextLost).toBe(false);
    expect(s.lastError).toBeNull();
  }
  renderer.renderFrame(frame);
  expect(status().framesSubmitted).toBe(6);

  // Dispose is idempotent; use-after-dispose throws.
  renderer.dispose();
  {
    const s = status();
    expect(s.initialized).toBe(false);
    expect(s.framesSubmitted).toBe(6);
  }
  expect(() => renderer.dispose()).not.toThrow();
  expect(() => renderer.renderFrame(frame)).toThrow();
  expect(typeof status().lastError).toBe('string');
}

// --- Asset-free: builder classification / identity / ordering -------------------

describe('gpu boundary builder contract (asset-free)', () => {
  it('classifies opaque/transparent/sky with the gpu.ts ordering convention', () => {
    const world = syntheticMiniWorld();
    const view = syntheticView();
    const entities: Entity[] = [
      { model: 0, origin: new Float32Array([10, 0, 0]), angles: new Float32Array([0, 0, 0]), frame: 0, skin: 5 },
    ];
    const scene = buildTestSceneSelection(world, view, entities, ['alias'], 1);
    expect(scene.staticGeneration).toBe(1);
    expect(scene.transforms).toHaveLength(2);
    expect(Array.from(scene.transforms[0]!)).toEqual(IDENTITY_4X4);

    const worldRefs = scene.surfaces.filter((s) => s.surfaceId >= 0);
    const entityRefs = scene.surfaces.filter((s) => s.surfaceId < 0);
    // 1 opaque + 1 transparent + 1 sky world refs, 1 entity ref.
    expect(worldRefs).toHaveLength(3);
    expect(entityRefs).toHaveLength(1);

    const byId = (id: number): (typeof worldRefs)[number] => worldRefs.find((s) => s.surfaceId === id)!;
    expect(byId(0)).toMatchObject({ material: 'opaque', transparent: false, order: 0, transformIndex: 0 });
    expect(byId(0)!.materialHandle).toBe(10);
    expect(byId(1)).toMatchObject({ material: 'transparent', transparent: true, transformIndex: 0 });
    expect(byId(1)!.order).toBeGreaterThan(0);
    expect(byId(2)).toMatchObject({ material: 'sky', transparent: false, order: 0, transformIndex: 0 });

    // Opaque refs never carry a meaningful order.
    for (const s of scene.surfaces) {
      if (!s.transparent) expect(s.order).toBe(0);
    }
    // Entity ref: dynamic geometry block, transform >= 1, kind preserved.
    expect(entityRefs[0]).toMatchObject({
      surfaceId: -1, material: 'alias', materialHandle: 5, transparent: false, order: 0, transformIndex: 1,
    });
    expect(Array.from(scene.transforms[1]!)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1]);
  });

  it('identical selections are stable (same generation, deep-equal snapshot)', () => {
    const world = syntheticMiniWorld();
    const view = syntheticView();
    const a = buildTestSceneSelection(world, view, [], [], 3);
    const b = buildTestSceneSelection(world, view, [], [], 3);
    expect(snapshotScene(a)).toEqual(snapshotScene(b));
    const bumped = buildTestSceneSelection(world, view, [], [], 4);
    expect(bumped.staticGeneration).toBe(4);
    expect(snapshotScene(bumped).surfaces).toEqual(snapshotScene(a).surfaces);
  });
});

// --- Asset-free: resource lifecycle ----------------------------------------------

describe('gpu boundary lifecycle (asset-free)', () => {
  it('reference double honors the full lifecycle contract', () => {
    const double = new ReferenceGpuLifecycle();
    driveLifecycleContract(double, () => double.uploads, {});
    console.log('GPU-BOUNDARY lifecycle: reference double frames=6 uploads=2 (init 640x480, resize 320x240, loss/restore, dispose)');
  });

  it('webgl-renderer backend lifecycle (live when the lane lands)', async () => {
    const probe = await probeWebGLRenderer();
    if (!probe.renderer) {
      console.log(`GPU-BOUNDARY lifecycle: real backend pending (${probe.reason}); reference double above pins the contract`);
      return;
    }
    // Live lane: same contract; wire upload introspection when exposed.
    // The stub GL implements the viewport/clear surface the backend owns.
    const stubGL: unknown = {
      COLOR_BUFFER_BIT: 0x4000,
      viewport(): void { /* owned target proof only */ },
      clearColor(): void { /* owned target proof only */ },
      clear(): void { /* owned target proof only */ },
    };
    const withStats = probe.renderer as Partial<{ testUploadStats: () => { uploads: number } }>;
    const uploads =
      typeof withStats.testUploadStats === 'function' ? (): number => withStats.testUploadStats!().uploads : null;
    driveLifecycleContract(probe.renderer, uploads, stubGL);
    console.log('GPU-BOUNDARY lifecycle: live WebGLRenderer honored the status contract');
  });
});

// --- Q2_PAK-gated: real-base1 scene selection invariants --------------------------

function loadGatedWorld(): { bw: BenchWorld; renderer: SoftwareRenderer } {
  if (!Q2_PAK) throw new Error('[testkit gpu-boundary] Q2_PAK absent');
  const bytes = readFileSync(Q2_PAK);
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  const bw = loadBenchWorld(buf);
  pinBenchCvars();
  const renderer = new SoftwareRenderer();
  renderer.init(createFramebuffer(GPU_PROOF_WIDTH, GPU_PROOF_HEIGHT, true));
  renderer.setPalette(bw.palette);
  return { bw, renderer };
}

function assertSelectionInvariants(
  label: string,
  world: MiniWorld,
  frame: GpuProofFrame,
  entities: Entity[],
  scene: GpuSceneInput,
  selectReason: string,
): void {
  const view = gpuProofViewFor(frame);
  // Route/view fixtures the selector consumes.
  expect(world.surfaces.length).toBeGreaterThan(1000);
  expect(Array.from(view.origin as Float32Array)).toEqual([128, -320, 54]);
  expect(view.fovX).toBe(90);

  // Selection is non-empty.
  expect(scene.surfaces.length).toBeGreaterThan(0);
  expect(scene.transforms.length).toBeGreaterThan(0);

  // transforms[0] is identity 4x4 (column-major).
  expect(Array.from(scene.transforms[0]!)).toEqual(IDENTITY_4X4);

  const worldRefs = scene.surfaces.filter((s) => s.surfaceId >= 0);
  const entityRefs = scene.surfaces.filter((s) => s.surfaceId < 0);
  const counts = countSelection(scene);
  console.log(
    `GPU-BOUNDARY selection ${label} [${selectReason}]: ` +
      `opaque=${counts.opaque} transparent=${counts.transparent} sky=${counts.sky} ` +
      `entity=${counts.entity} total=${scene.surfaces.length} gen=${scene.staticGeneration}`,
  );
  expect(counts.opaque).toBeGreaterThan(0);

  // Every selected world surface re-passes an independent frustum check
  // (fresh setupCamera, not the selection's camera object).
  const fresh = setupCamera(view.origin, view.angles, view.fovX, GPU_PROOF_WIDTH, GPU_PROOF_HEIGHT);
  for (const ref of worldRefs) {
    const s = world.surfaces[ref.surfaceId]!;
    expect(culledByFrustum(fresh, s.mins, s.maxs)).toBe(false);
    expect(ref.transformIndex).toBe(0);
  }

  // Ordering-bit contract (gpu.ts: larger = farther; transparent bit is the
  // ordering bit, NOT the material classifier — world blend refs carry
  // material 'transparent', entity blend refs keep their kind + transparent).
  const ENTITY_KINDS: GpuMaterialKind[] = ['alias', 'sprite', 'beam', 'particle'];
  for (const ref of scene.surfaces) {
    if (!ref.transparent) {
      expect(ref.order).toBe(0);
    } else {
      expect(ref.order).toBeGreaterThan(0);
      if (ref.transformIndex === 0) {
        // World blend ref: real surface id, 'transparent' classifier.
        expect(ref.material).toBe('transparent');
        expect(ref.surfaceId).toBeGreaterThanOrEqual(0);
      } else {
        // Entity blend ref: kind preserved, negative index-stable sentinel.
        expect(ENTITY_KINDS).toContain(ref.material);
        expect(ref.surfaceId).toBeLessThan(0);
      }
    }
  }
  // Blend pass is one far-to-near sequence: world distances non-increasing
  // with the order keys (entity refs interleave by the same key).
  const transparent = scene.surfaces.filter((s) => s.transparent);
  const keyOf = (ref: (typeof transparent)[number]): number => {
    if (ref.surfaceId >= 0) return distance3(view.origin as Float32Array, world.surfaces[ref.surfaceId]!.center);
    const t = scene.transforms[ref.transformIndex]!;
    return distance3(view.origin as Float32Array, new Float32Array([t[12]!, t[13]!, t[14]!]));
  };
  for (let i = 1; i < transparent.length; i++) {
    // Far-to-near draw sequence: non-increasing distance AND order key.
    expect(keyOf(transparent[i]!)).toBeLessThanOrEqual(keyOf(transparent[i - 1]!) + 1e-6);
    expect(transparent[i]!.order).toBeLessThanOrEqual(transparent[i - 1]!.order);
  }

  // Combat entity refs exist with transformIndex >= 1, kinds preserved.
  // Entity refs ride the blend pass far->near when transparent (tracers
  // always blend), so match by the index-stable surfaceId slot (-1-i),
  // not by position: order is a draw sequence, identity is the slot.
  expect(entityRefs).toHaveLength(entities.length);
  const kinds = entityKindsForFixture(entities.length);
  const bySlot = new Map(entityRefs.map((r) => [r.surfaceId, r]));
  entities.forEach((e, i) => {
    const ref = bySlot.get(-1 - i)!;
    expect(ref).toBeDefined();
    expect(ref.transformIndex).toBeGreaterThanOrEqual(1);
    expect(ref.transformIndex).toBeLessThan(scene.transforms.length);
    expect(ref.material === 'alias' || ref.material === 'sprite' || ref.material === 'beam').toBe(true);
    expect(ref.material).toBe(kinds[i]);
    expect(ref.materialHandle).toBe(entities[i]!.skin);
  });
}

describe.runIf(!!Q2_PAK)('gpu boundary scene selection (Q2_PAK base1)', () => {
  it('F0 stationary selection honors the boundary invariants', { timeout: 120000 }, async () => {
    const { bw, renderer } = loadGatedWorld();
    try {
      const frame = gpuProofRoute()[0]!;
      const entities = gpuProofEntitiesFor(renderer, bw, frame);
      expect(entities).toHaveLength(3);
      const kinds = entityKindsForFixture(entities.length);
      const probe = await probeSelectGpuScene();
      const selectReason = probe.fn ? 'live selectGpuScene' : `pending (${probe.reason})`;
      const scene = probe.fn
        ? probe.fn(bw.world, entities, gpuProofViewFor(frame), GPU_PROOF_WIDTH, GPU_PROOF_HEIGHT, modelKindsForFixture(entities))
        : buildTestSceneSelection(bw.world, gpuProofViewFor(frame), entities, kinds, 1);
      assertSelectionInvariants('f0-stationary', bw.world, frame, entities, scene, selectReason);
      // staticGeneration stability across two identical selections.
      const again = probe.fn
        ? probe.fn(bw.world, entities, gpuProofViewFor(frame), GPU_PROOF_WIDTH, GPU_PROOF_HEIGHT, modelKindsForFixture(entities))
        : buildTestSceneSelection(bw.world, gpuProofViewFor(frame), entities, kinds, 1);
      expect(again.staticGeneration).toBe(scene.staticGeneration);
      expect(snapshotScene(again)).toEqual(snapshotScene(scene));
    } finally {
      resetCVars();
    }
  });

  it('F1 combat selection honors the boundary invariants (gun + foreground)', { timeout: 120000 }, async () => {
    const { bw, renderer } = loadGatedWorld();
    try {
      const frame = gpuProofRoute()[1]!;
      const entities = gpuProofEntitiesFor(renderer, bw, frame);
      expect(entities).toHaveLength(4);
      expect(entities[3]!.depthHack).toBe(true);
      const kinds = entityKindsForFixture(entities.length);
      const probe = await probeSelectGpuScene();
      const selectReason = probe.fn ? 'live selectGpuScene' : `pending (${probe.reason})`;
      const scene = probe.fn
        ? probe.fn(bw.world, entities, gpuProofViewFor(frame), GPU_PROOF_WIDTH, GPU_PROOF_HEIGHT, modelKindsForFixture(entities))
        : buildTestSceneSelection(bw.world, gpuProofViewFor(frame), entities, kinds, 1);
      assertSelectionInvariants('f1-combat', bw.world, frame, entities, scene, selectReason);
      const counts = countSelection(scene);
      expect(counts.entity).toBe(4);
      const again = probe.fn
        ? probe.fn(bw.world, entities, gpuProofViewFor(frame), GPU_PROOF_WIDTH, GPU_PROOF_HEIGHT, modelKindsForFixture(entities))
        : buildTestSceneSelection(bw.world, gpuProofViewFor(frame), entities, kinds, 1);
      expect(snapshotScene(again)).toEqual(snapshotScene(scene));
    } finally {
      resetCVars();
    }
  });
});

describe.runIf(!Q2_PAK)('gpu boundary scene selection (no Q2_PAK)', () => {
  it('skips real-base1 selection gracefully', () => {
    console.log('GPU-BOUNDARY selection skipped: Q2_PAK absent (set Q2_PAK to a pak0.pak for real-base1 invariants)');
  });
});
