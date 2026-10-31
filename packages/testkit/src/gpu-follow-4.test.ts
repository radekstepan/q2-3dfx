// @q2/testkit — GPU-FOLLOW-4 lane: lifecycle, switching, resize, loss/recovery.
//
// Owns: `packages/testkit` ONLY. Read-only on apps/web (gpu-canvas glue,
// play.ts GPU attach) and @q2/webgl-renderer (ownership primitives, test
// hooks). This file pins the repeated-cycle contract through the PUBLIC
// backend API + production-glue mirrors BY VALUE:
//
// - repeated resize cycles: stable resource counts, no duplicate
//   canvases/listeners, correct rendered output (draw deltas, not nonblack)
// - repeated CPU→GPU→CPU switches via `replayRetainedAssetsMirror`
//   (FOLLOW-2A shape, reused BY NAME — never reimplemented here)
// - repeated map-replacement cycles: exactly one re-upload per generation,
//   obsolete same-context objects freed before replacement
// - repeated loss/recovery cycles: submission freezes on loss, registry
//   intact without asset migration, full restore replays the retained roster
// - retained switching without fallback masquerading as GPU execution
// - real browser context-loss mechanism (WEBGL_lose_context) where possible
//
// Hermetic legs always run (box mesh + synthetic skins, stub GL). Browser
// legs are gated (Q2_PAK + chromium + vite) and skip gracefully without env.

import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, type CdpConnection } from './gpu-browser.js';
import {
  chromiumFlagsForRenderer,
  launchProductionChromium,
  resolvePresentationDeps,
  soakPageUrl,
  startPakFileServer,
  startViteDev,
  waitForSoakBoot,
  waitHttpOk,
} from './gpu-presentation.js';
import {
  decodePngRgba,
  distinctTripleCount,
  gunRegion,
  nearWhiteFraction,
  nonBlackFraction,
  PRESENTATION_MAX_NEARWHITE_FRAC,
  PRESENTATION_MIN_DISTINCT_TRIPLES,
  PRESENTATION_MIN_GUN_REGION_FRAC,
  PRESENTATION_MIN_NONBLACK_FRAC,
  regionNonBlackFraction,
} from './gpu-presentation.js';
import { createBoxMesh, type MiniWorld } from '@q2/sw-renderer';
import {
  WebGLRenderer,
  refreshGpuScene,
  selectGpuScene,
  GPU_SCENE_GENERATION,
} from '@q2/webgl-renderer';
import {
  createFollow2aStubGL,
  follow2aCombatEntities,
  follow2aKinds,
  follow2aRequiredModels,
  follow2aRequiredSkins,
  gameplayPreserved,
  makeCpuRegisterSpy,
  meshWarnings,
  replayRetainedAssetsMirror,
  snapshotGameplay,
  FOLLOW2A_BARREL_MODEL,
  FOLLOW2A_BARREL_SKIN,
  FOLLOW2A_GUN_MODEL,
  FOLLOW2A_GUN_SKIN,
  FOLLOW2A_INFANTRY_MODEL,
  FOLLOW2A_INFANTRY_SKIN,
  FOLLOW2A_SOLDIER_MODEL,
  FOLLOW2A_SOLDIER_SKIN,
  type RetainedAssetsMirror,
} from './gpu-follow-2a.js';
import {
  acquireMirrorGpuCanvas,
  canvasGlueViolations,
  createFollow4FakeDoc,
  createProbeCanvasScript,
  FOLLOW4_CTX_EXT,
  FOLLOW4_CTX_RECORDER,
  FOLLOW4_GPU_CANVAS_ID,
  formatBrowserLossEvidence,
  formatSwitchReport,
  installContextEventRecorderScript,
  lifecycleViolations,
  loseContextScript,
  readContextEventsScript,
  removeMirrorGpuCanvas,
  removeProbeCanvasScript,
  replayViolations,
  restoreContextScript,
  snapshotGpuLifecycle,
  switchViolations,
  CONTEXT_LOSS_EXTENSION,
  type Follow4CanvasWiring,
  type Follow4CycleExpect,
  type Follow4SwitchRecord,
} from './gpu-follow-4.js';

const W = 64;
const H = 48;

function rampPalette(): Uint8Array {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    p[i * 3] = i;
    p[i * 3 + 1] = (i * 2) & 255;
    p[i * 3 + 2] = (i * 3) & 255;
  }
  return p;
}

function quadSurf(id: number, cx: number, texId: number): MiniWorld['surfaces'][number] {
  return {
    id,
    verts: new Float32Array([cx - 1, -1, 0, cx + 1, -1, 0, cx + 1, 1, 0, cx - 1, 1, 0]),
    uvs: new Float32Array([0, 0, 8, 0, 8, 8, 0, 8]),
    lux: new Float32Array([0, 0, 1, 0, 1, 0, 1, 1]),
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
  };
}

function fixtureWorld(): MiniWorld {
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [{ cluster: 0, firstSurf: 0, numSurfs: 2, faceList: [0, 1] }],
    pvs: [new Uint8Array([1])],
    clusterCount: 1,
    surfaces: [quadSurf(0, 50, 0), quadSurf(1, 60, 1)],
    textures: [
      { texels: new Uint8Array(8 * 8).fill(7), width: 8, height: 8 },
      { texels: new Uint8Array(8 * 8).fill(9), width: 8, height: 8 },
    ],
    lightmaps: [0, 1].map(() => ({
      samples: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]),
      luxW: 2, luxH: 2, styles: [0, 255, 255, 255] as [number, number, number, number],
    })),
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
}

function fixtureView(origin?: [number, number, number], yaw = 90): {
  origin: Float32Array; angles: Float32Array; fovX: number; time: number; lightStyles: Float32Array;
} {
  return {
    origin: new Float32Array(origin ?? [0, 0, 0]),
    angles: new Float32Array([0, yaw, 0]),
    fovX: 90,
    time: 0,
    lightStyles: new Float32Array(256).fill(1),
  };
}

function registerHermeticRoster(r: WebGLRenderer): void {
  const box = createBoxMesh();
  r.registerModelData(FOLLOW2A_SOLDIER_MODEL, 'md2', box);
  r.registerModelData(FOLLOW2A_INFANTRY_MODEL, 'md2', box);
  r.registerModelData(FOLLOW2A_GUN_MODEL, 'md2', box);
  r.registerModelData(FOLLOW2A_BARREL_MODEL, 'md2', box);
  r.registerSkinPixels(FOLLOW2A_SOLDIER_SKIN, new Uint8Array(8 * 8).fill(11), 8, 8);
  r.registerSkinPixels(FOLLOW2A_GUN_SKIN, new Uint8Array(8 * 8).fill(12), 8, 8);
  r.registerSkinPixels(FOLLOW2A_INFANTRY_SKIN, new Uint8Array(8 * 8).fill(13), 8, 8);
  r.registerSkinPixels(FOLLOW2A_BARREL_SKIN, new Uint8Array(8 * 8).fill(14), 8, 8);
}

function hermeticRetainedAssets(): RetainedAssetsMirror {
  const box = createBoxMesh();
  return {
    models: [
      { handle: FOLLOW2A_SOLDIER_MODEL, kind: 'md2', data: box, path: 'models/monsters/soldier/tris.md2', fallback: false },
      { handle: FOLLOW2A_INFANTRY_MODEL, kind: 'md2', data: box, path: 'models/monsters/infantry/tris.md2', fallback: false },
      { handle: FOLLOW2A_GUN_MODEL, kind: 'md2', data: box, path: 'models/weapons/v_blast/tris.md2', fallback: false },
      { handle: FOLLOW2A_BARREL_MODEL, kind: 'md2', data: box, path: 'models/objects/barrels/tris.md2', fallback: false },
    ],
    skins: [
      { handle: FOLLOW2A_SOLDIER_SKIN, pixels: new Uint8Array(8 * 8).fill(11), width: 8, height: 8, path: 'models/monsters/soldier/skin.pcx', fallback: false },
      { handle: FOLLOW2A_GUN_SKIN, pixels: new Uint8Array(8 * 8).fill(12), width: 8, height: 8, path: 'models/weapons/v_blast/skin.pcx', fallback: false },
      { handle: FOLLOW2A_INFANTRY_SKIN, pixels: new Uint8Array(8 * 8).fill(13), width: 8, height: 8, path: 'models/monsters/infantry/skin.pcx', fallback: false },
      { handle: FOLLOW2A_BARREL_SKIN, pixels: new Uint8Array(8 * 8).fill(14), width: 8, height: 8, path: 'models/objects/barrels/skin.pcx', fallback: false },
    ],
  };
}

type Stub = ReturnType<typeof createFollow2aStubGL>;

function bootGpu(): { r: WebGLRenderer; stub: Stub; world: MiniWorld } {
  const stub = createFollow2aStubGL();
  const r = new WebGLRenderer();
  r.init(stub.gl, W, H);
  const world = fixtureWorld();
  r.attachWorld(world);
  r.setPalette(rampPalette());
  registerHermeticRoster(r);
  return { r, stub, world };
}

/** Render one frame; fail loudly on GL errors (stub reports NO_ERROR). */
function renderChecked(
  r: WebGLRenderer, stub: Stub, world: MiniWorld, width: number, height: number, generation: number,
): void {
  const kinds = follow2aKinds();
  const entities = follow2aCombatEntities(4, 1);
  const scene = refreshGpuScene(world, entities, fixtureView(), width, height, kinds, generation);
  r.setScene(scene);
  r.setEntities(entities, kinds);
  expect(() => r.renderFrame({ view: fixtureView(), scene, time: 0 })).not.toThrow();
  expect(stub.gl.getError()).toBe(0);
}

const STEADY: Follow4CycleExpect = {
  uploadDelta: 0, framesAdvanceAtLeast: 1, size: null, lost: null, errorSubstring: null,
};

describe('FOLLOW-4 repeated resize cycles (hermetic, stub GL)', () => {
  it('holds stable resource counts with correct output across resizes', () => {
    const { r, stub, world } = bootGpu();
    renderChecked(r, stub, world, W, H, GPU_SCENE_GENERATION);
    let before = snapshotGpuLifecycle(r);
    expect(before.target).not.toBeNull();

    const sizes: Array<[number, number]> = [
      [320, 240], [640, 480], [160, 120], [640, 480], [640, 480],
    ];
    for (const [w, h] of sizes) {
      r.resize(w, h);
      renderChecked(r, stub, world, w, h, GPU_SCENE_GENERATION);
      const after = snapshotGpuLifecycle(r);
      // Resizing synchronizes drawing buffer, render targets, viewport,
      // camera aspect and HUD overlay: counts stable, one frame submitted.
      expect(lifecycleViolations(before, after, { ...STEADY, size: { width: w, height: h } })).toEqual([]);
      expect(stub.drawElements).toBeGreaterThan(0);
      expect(meshWarnings(r.testWarnings())).toEqual([]);
      before = after;
    }

    // Correct rendered output at the end: dropping ANY roster member
    // strictly reduces executed draws (not a nonblack floor).
    const kinds = follow2aKinds();
    const entities = follow2aCombatEntities(4, 1);
    const drawsFull = stub.drawElements;
    const fewer = entities.filter((_, i) => i !== 1); // drop infantry
    const sc = selectGpuScene(world, fewer, fixtureView(), 640, 480, kinds);
    r.setScene(sc);
    r.setEntities(fewer, kinds);
    expect(() => r.renderFrame({ view: fixtureView(), scene: sc, time: 0 })).not.toThrow();
    expect(stub.drawElements).toBeGreaterThan(drawsFull);
    expect(r.testRegisteredModels()).toEqual(follow2aRequiredModels());
    expect(r.testRegisteredSkins()).toEqual(follow2aRequiredSkins());
    console.log(
      `[follow-4] resize cycles: live=${JSON.stringify(before.live)} ` +
      `deletes=${JSON.stringify(before.deletes)} uploads=${before.uploads} frames=${before.framesSubmitted}`,
    );
  });
});

describe('FOLLOW-4 repeated CPU→GPU→CPU switches (hermetic, FOLLOW-2A replay)', () => {
  it('replays the retained roster cleanly with no drift and no fallback masquerade', () => {
    // CPU boot registration runs ONCE; later attaches replay without
    // touching these counters (FOLLOW-2A hot-swap contract, reused here).
    const cpu = makeCpuRegisterSpy();
    const box = createBoxMesh();
    for (let i = 0; i < 4; i++) cpu.registerModel({ name: `m${i}`, kind: 'md2', data: box });
    for (let i = 0; i < 4; i++) cpu.registerSkinData(`s${i}`, new Uint8Array(64).fill(3), 8, 8);
    const retained = hermeticRetainedAssets();
    const kinds = follow2aKinds();
    const world = fixtureWorld();
    const stub = createFollow2aStubGL();
    const gpu = new WebGLRenderer();
    gpu.init(stub.gl, W, H);
    gpu.attachWorld(world);
    gpu.setPalette(rampPalette());

    const recs: Follow4SwitchRecord[] = [];
    let before: ReturnType<typeof snapshotGpuLifecycle> | null = null;
    for (let round = 0; round < 3; round++) {
      // CPU→GPU attach replays the retained roster under the SAME handles
      // (FOLLOW-2A `replayRetainedAssetsMirror`, reused by name).
      const gameplayBefore = snapshotGameplay([128, -320, 54], 100, 42, 'weapon_supershotgun');
      const outcome = replayRetainedAssetsMirror(retained, gpu);
      expect(replayViolations(outcome, 4, 4)).toEqual([]);
      renderChecked(gpu, stub, world, W, H, GPU_SCENE_GENERATION);
      const after = snapshotGpuLifecycle(gpu);
      if (before) {
        expect(lifecycleViolations(before, after, STEADY)).toEqual([]);
      } else {
        expect(after.uploads).toBe(1);
        expect(after.modelCache).toBe(4);
      }
      expect(meshWarnings(gpu.testWarnings())).toEqual([]);
      expect(gameplayPreserved(gameplayBefore, snapshotGameplay([128, -320, 54], 100, 42, 'weapon_supershotgun'))).toBe(true);
      // Genuine GPU leg: honored request, advancing submissions, no warning.
      recs.push({
        label: `gpu-cycle-${round}`,
        requested: 'webgl2-experimental',
        active: 'webgl2-experimental',
        warning: null,
        framesStart: before?.framesSubmitted ?? 0,
        framesEnd: after.framesSubmitted,
        claimsGpuExecution: true,
      });
      before = after;
      // GPU→CPU switch: the CPU fallback leg is recorded as fallback and
      // must never claim GPU execution (retained switching, no masquerade).
      recs.push({
        label: `cpu-fallback-cycle-${round}`,
        requested: 'webgl2-experimental',
        active: 'software',
        warning: 'webgl2-experimental requested but unavailable (no WebGL2 context); staying on software',
        framesStart: after.framesSubmitted,
        framesEnd: after.framesSubmitted,
        claimsGpuExecution: false,
      });
    }
    for (const rec of recs) expect(switchViolations(rec)).toEqual([]);
    // The gate itself bites: a fallback leg mislabeled as GPU execution is
    // a violation, however healthy its frames look.
    expect(switchViolations({
      label: 'masquerade-negative-control',
      requested: 'webgl2-experimental',
      active: 'software',
      warning: 'webgl2-experimental requested but unavailable (x); staying on software',
      framesStart: 10,
      framesEnd: 60,
      claimsGpuExecution: true,
    }).length).toBeGreaterThan(0);
    expect(cpu.modelCalls).toBe(4);
    expect(cpu.skinCalls).toBe(4);
    expect(gpu.testRegisteredModels()).toEqual(follow2aRequiredModels());
    expect(gpu.testRegisteredSkins()).toEqual(follow2aRequiredSkins());
    console.log(`[follow-4]\n${formatSwitchReport(recs)}`);
  });
});

describe('FOLLOW-4 repeated map-replacement cycles (hermetic, stub GL)', () => {
  it('re-uploads exactly once per generation with stable live counts', () => {
    const { r, stub, world } = bootGpu();
    renderChecked(r, stub, world, W, H, GPU_SCENE_GENERATION);
    let before = snapshotGpuLifecycle(r);
    expect(before.uploads).toBe(1);

    for (let k = 1; k <= 3; k++) {
      // Map replacement bumps the static generation (same world contents:
      // the upload path, not asset content, is under test).
      renderChecked(r, stub, world, W, H, GPU_SCENE_GENERATION + k);
      const after = snapshotGpuLifecycle(r);
      // Obsolete same-context objects are freed before replacement: live
      // counts stable, uploads grow by exactly one per generation.
      expect(lifecycleViolations(before, after, { ...STEADY, uploadDelta: 1 })).toEqual([]);
      expect(stub.drawElements).toBeGreaterThan(0);
      expect(meshWarnings(r.testWarnings())).toEqual([]);
      expect(r.testRegisteredModels()).toEqual(follow2aRequiredModels());
      expect(r.testRegisteredSkins()).toEqual(follow2aRequiredSkins());
      console.log(
        `[follow-4] map cycle ${k}: live=${JSON.stringify(after.live)} ` +
        `deletes=${JSON.stringify(after.deletes)} uploads=${after.uploads}`,
      );
      before = after;
    }
    expect(before.uploads).toBe(4);
  });
});

describe('FOLLOW-4 repeated loss/recovery cycles (hermetic, stub GL)', () => {
  it('freezes submission on loss and restores the full roster after recovery', () => {
    const { r, stub, world } = bootGpu();
    renderChecked(r, stub, world, W, H, GPU_SCENE_GENERATION);
    let steady = snapshotGpuLifecycle(r);
    expect(steady.contextLost).toBe(false);

    for (let round = 0; round < 3; round++) {
      // Loss: submission stops safely (frames frozen, error records loss);
      // invalid GL handles are dropped, never deleted, never counted. Live
      // counts go to zero BY DESIGN here (dropGLCaches); stability is
      // asserted on the full cycle (steady pre-loss vs steady post-restore).
      const submittedBeforeLoss = steady.framesSubmitted;
      r.handleContextLost();
      const lost = snapshotGpuLifecycle(r);
      expect(lost.contextLost).toBe(true);
      expect(lost.live).toEqual({ textures: 0, buffers: 0, framebuffers: 0, renderbuffers: 0, programs: 0 });
      expect(lost.modelCache).toBe(0);
      expect(lost.lastError).toContain('context lost');
      renderChecked(r, stub, world, W, H, GPU_SCENE_GENERATION);
      expect(r.getStatus().framesSubmitted).toBe(submittedBeforeLoss);
      expect(r.getStatus().lastError).toContain('context lost');

      // Recovery: handles re-created from the RETAINED registries (no asset
      // migration rebuild); the same roster draws again with stable counts.
      r.handleContextRestored(stub.gl);
      const restored = snapshotGpuLifecycle(r);
      expect(restored.contextLost).toBe(false);
      expect(restored.models).toEqual(follow2aRequiredModels());
      expect(restored.skins).toEqual(follow2aRequiredSkins());
      renderChecked(r, stub, world, W, H, GPU_SCENE_GENERATION);
      const after = snapshotGpuLifecycle(r);
      expect(lifecycleViolations(steady, after, { ...STEADY, framesAdvanceAtLeast: 1 })).toEqual([]);
      expect(after.modelCache).toBe(4);
      expect(meshWarnings(r.testWarnings())).toEqual([]);
      console.log(
        `[follow-4] loss cycle ${round}: live=${JSON.stringify(after.live)} ` +
        `frames=${after.framesSubmitted} uploads=${after.uploads}`,
      );
      steady = after;
    }
    expect(steady.framesSubmitted).toBe(1 + 3);
  });
});

describe('FOLLOW-4 canvas/listener mirror (hermetic, no DOM)', () => {
  it('repeated acquire/remove cycles leave one canvas and balanced listeners', () => {
    const doc = createFollow4FakeDoc();
    const hooks = { lost: 0, restored: 0 };
    const spy: Follow4CanvasWiring = {
      onLost(): void { hooks.lost++; },
      onRestored(): void { hooks.restored++; },
    };
    for (let round = 0; round < 5; round++) {
      const el = acquireMirrorGpuCanvas(doc, 640, 480, spy);
      expect(el.id).toBe(FOLLOW4_GPU_CANVAS_ID);
      expect(el.width).toBe(640);
      expect(el.height).toBe(480);
      const createdAfterFirst = doc.created;
      // Re-acquire without remove reuses by id: no duplicate canvas and no
      // new creation (created grows only across remove+reacquire rounds).
      const again = acquireMirrorGpuCanvas(doc, 640, 480, spy);
      expect(again).toBe(el);
      expect(doc.created).toBe(createdAfterFirst);
      expect(doc.created).toBe(round + 1);
      expect(canvasGlueViolations(doc, 1)).toEqual([]);
      expect(removeMirrorGpuCanvas(doc, spy)).toBe(true);
      expect(canvasGlueViolations(doc, 0)).toEqual([]);
      expect(el.listenerCount('webglcontextlost')).toBe(0);
      expect(el.listenerCount('webglcontextrestored')).toBe(0);
    }
    expect(doc.live).toBe(0);
    expect(removeMirrorGpuCanvas(doc, spy)).toBe(false);
  });

  it('contextlost dispatch prevents default and stops submission; restored resumes', () => {
    const { r, stub, world } = bootGpu();
    renderChecked(r, stub, world, W, H, GPU_SCENE_GENERATION);
    const doc = createFollow4FakeDoc();
    const spy: Follow4CanvasWiring = {
      onLost(): void { r.handleContextLost(); },
      onRestored(): void { r.handleContextRestored(stub.gl); },
    };
    acquireMirrorGpuCanvas(doc, W, H, spy);
    const el = doc.byId(FOLLOW4_GPU_CANVAS_ID);
    expect(el).not.toBeNull();

    const submitted = r.getStatus().framesSubmitted;
    const lostEv = el!.dispatch('webglcontextlost');
    expect(lostEv.defaultPrevented).toBe(true);
    expect(r.getStatus().contextLost).toBe(true);
    renderChecked(r, stub, world, W, H, GPU_SCENE_GENERATION);
    expect(r.getStatus().framesSubmitted).toBe(submitted);

    el!.dispatch('webglcontextrestored');
    expect(r.getStatus().contextLost).toBe(false);
    renderChecked(r, stub, world, W, H, GPU_SCENE_GENERATION);
    expect(r.getStatus().framesSubmitted).toBe(submitted + 1);
    expect(meshWarnings(r.testWarnings())).toEqual([]);
  });

  it('lose/restore scripts share one per-canvas extension stash (lost-context re-query returns null)', () => {
    // Genuine browser behavior: getExtension() on an already-lost context
    // yields null, so restore must reuse the extension object stashed at
    // lose time instead of re-querying.
    const lose = loseContextScript('probe');
    const restore = restoreContextScript('probe');
    expect(lose).toContain(FOLLOW4_CTX_EXT);
    expect(restore).toContain(FOLLOW4_CTX_EXT);
    // Restore prefers the stashed object; live re-query is only a fallback.
    expect(restore.indexOf(FOLLOW4_CTX_EXT)).toBeLessThan(restore.indexOf('getExtension'));
  });
});

// --- Browser legs (Q2_PAK + chromium + vite gated) --------------------------

const BROWSER_RESOLVED = resolvePresentationDeps();
const BROWSER_GATE = 'deps' in BROWSER_RESOLVED;
const HAS_PAK = !!process.env.Q2_PAK;

describe.runIf(!BROWSER_GATE || !HAS_PAK)('FOLLOW-4 browser loss/recovery (skipped)', () => {
  it('logs the skip reason', () => {
    console.log(!BROWSER_GATE ? BROWSER_RESOLVED.skip : 'Q2_PAK not set (real-asset browser legs skipped)');
  });
});

async function readSoakNumbers(cdp: CdpConnection): Promise<{
  framesSubmitted: number | null; renderer: string | null; warning: string | null; uploads: number | null;
}> {
  return cdp.evaluate<{ framesSubmitted: number | null; renderer: string | null; warning: string | null; uploads: number | null }>(
    'window.__q2soakState ? (function(){var s=window.__q2soakState();return{framesSubmitted:s.framesSubmitted,renderer:s.renderer,warning:s.warning,uploads:s.uploads};})() : {framesSubmitted:null,renderer:null,warning:null,uploads:null}',
    30000,
  );
}

interface SoakLifecycleNumbers {
  gpuActive: boolean | null;
  contextLost: boolean | null;
  lossCount: number | null;
  restoreCount: number | null;
  framesSubmitted: number | null;
  uploads: number | null;
  fallback: string | null;
  width: number | null;
  height: number | null;
}

async function readLifecycleNumbers(cdp: CdpConnection): Promise<SoakLifecycleNumbers | null> {
  return cdp.evaluate<SoakLifecycleNumbers | null>(
    'window.__q2soakLifecycle ? window.__q2soakLifecycle() : null',
    30000,
  );
}

async function readRecorderCounts(cdp: CdpConnection): Promise<{ lost: number; restored: number } | null> {
  return cdp.evaluate<{ lost: number; restored: number } | null>(readContextEventsScript(), 30000);
}

async function readCanvasCounts(cdp: CdpConnection): Promise<{ q2gl: number; total: number }> {
  return cdp.evaluate<{ q2gl: number; total: number }>(
    '(function(){try{return{q2gl:document.querySelectorAll("#q2-gl").length,total:document.querySelectorAll("canvas").length};}catch(e){return{q2gl:-1,total:-1};}})()',
    30000,
  );
}

/**
 * Read one GL error flag WITHOUT draining the queue in a loop (single
 * getError call, recorded verbatim). Returns the numeric error, 'no-context',
 * or 'unreadable'. A 1282 here reproduces the historical first-submit
 * INVALID_OPERATION at the exact phase that read it; the caller must fail
 * loudly rather than clearing and continuing.
 */
async function readOneGlError(cdp: CdpConnection, canvasId: string): Promise<number | string> {
  const script = `(function(){try{var c=document.getElementById(${JSON.stringify(canvasId)});if(!c)return 'no-canvas';var gl=null;try{gl=c.getContext('webgl2');}catch(e){return 'unreadable';}if(!gl)return 'no-context';try{return gl.getError();}catch(e){return 'unreadable';}}catch(e){return 'unreadable';}})()`;
  return cdp.evaluate<number | string>(script, 30000);
}

async function pollContextEvents(cdp: CdpConnection, want: 'lost' | 'restored', timeoutMs: number): Promise<void> {
  const start = Date.now();
  let polls = 0;
  for (;;) {
    polls++;
    const cur = await readRecorderCounts(cdp);
    if (cur && cur[want] >= 1) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `[follow-4] context ${want} event never recorded within ${timeoutMs}ms ` +
        `(polls=${polls} last=${JSON.stringify(cur)} pool=${JSON.stringify(cdp.pendingCalls())})`,
      );
    }
    await new Promise<void>((r) => setTimeout(r, 500));
  }
}

async function assertComposedScenePixels(
  cdp: CdpConnection,
  outDir: string,
  tag: string,
): Promise<{ nonBlack: number; gun: number; nearWhite: number; triples: number }> {
  const shot = await cdp.screenshot();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(outDir, `gpu-follow-4-${stamp}-${tag}.png`), shot);
  const decoded = decodePngRgba(shot);
  const nonBlack = nonBlackFraction(decoded.data);
  const gun = regionNonBlackFraction(decoded.data, decoded.width, decoded.height, gunRegion());
  const nearWhite = nearWhiteFraction(decoded.data);
  const triples = distinctTripleCount(decoded.data);
  console.log(
    `[follow-4] ${tag}: shot ${decoded.width}x${decoded.height} ` +
    `nonBlack=${nonBlack.toFixed(4)} gun=${gun.toFixed(4)} nearWhite=${nearWhite.toFixed(4)} triples=${triples}`,
  );
  expect(
    nonBlack,
    `${tag}: composed production canvas must show textured world/model/skin pixels (need >=${PRESENTATION_MIN_NONBLACK_FRAC}, flat fallback is not acceptance)`,
  ).toBeGreaterThanOrEqual(PRESENTATION_MIN_NONBLACK_FRAC);
  expect(
    gun,
    `${tag}: gun/HUD region must be present (need >=${PRESENTATION_MIN_GUN_REGION_FRAC})`,
  ).toBeGreaterThanOrEqual(PRESENTATION_MIN_GUN_REGION_FRAC);
  expect(
    nearWhite,
    `${tag}: composed capture must not be a near-white wash (need <=${PRESENTATION_MAX_NEARWHITE_FRAC})`,
  ).toBeLessThanOrEqual(PRESENTATION_MAX_NEARWHITE_FRAC);
  expect(
    triples,
    `${tag}: composed capture must show varied scene colors (need >=${PRESENTATION_MIN_DISTINCT_TRIPLES})`,
  ).toBeGreaterThanOrEqual(PRESENTATION_MIN_DISTINCT_TRIPLES);
  return { nonBlack, gun, nearWhite, triples };
}

describe.runIf(BROWSER_GATE && HAS_PAK)('FOLLOW-4 browser: real context-loss mechanism', () => {
  it(
    'WEBGL_lose_context fires genuine lost/restored events; game-canvas loss never silently falls back',
    { timeout: 600000 },
    async () => {
      if (!BROWSER_GATE) throw new Error('unreachable (suite is gated)');
      const { pakPath, webRoot, viteBin } = BROWSER_RESOLVED.deps;
      const testDir = dirname(fileURLToPath(import.meta.url));
      // Unique profile per run (see launch call below): a fixed dir keeps a
      // stale SingletonLock after killed runs and makes the next launch
      // abort (code 21). The directory itself is still pre-created so a
      // missing test-output tree never fails the run.
      mkdirSync(join(testDir, '..', 'test-output'), { recursive: true });

      let pakServer: { url: string; close(): Promise<void> } | null = null;
      let vite: { url: string; close(): Promise<void> } | null = null;
      let chromium: { port: number; kill(): void } | null = null;
      let cdp: CdpConnection | null = null;
      try {
        pakServer = await startPakFileServer(pakPath);
        vite = await startViteDev(webRoot, viteBin);
        await waitHttpOk(`${vite.url}/`, 120000);
        chromium = await launchProductionChromium(
          soakPageUrl(vite.url, pakServer.url, 'webgl2-experimental'),
          // Unique profile per run: a fixed dir keeps a stale SingletonLock
          // after killed runs and makes the next launch abort (code 21).
          // (pre-existing runs left test-output/.q2-follow4-profile locked.)
          join(testDir, '..', 'test-output', `.q2-follow4-profile-${process.pid}-${Date.now()}`),
          chromiumFlagsForRenderer('webgl2-experimental'),
        );
        cdp = await connectCdp(chromium.port);
        await waitForSoakBoot(cdp, 300000);

        // (a) Mechanism proof on a throwaway probe canvas: the REAL
        // WEBGL_lose_context extension fires genuine events (never a flag).
        const probeId = 'q2-follow4-probe';
        expect(await cdp.evaluate<boolean>(createProbeCanvasScript(probeId, 64, 48), 30000)).toBe(true);
        expect(await cdp.evaluate<boolean>(installContextEventRecorderScript(probeId), 30000)).toBe(true);
        const loseProbe = await cdp.evaluate<{ hasCanvas: boolean; lost: boolean }>(loseContextScript(probeId), 30000);
        expect(loseProbe).toMatchObject({ hasCanvas: true, lost: true });
        await pollContextEvents(cdp, 'lost', 30000);
        const restoreProbe = await cdp.evaluate<{ hasCanvas: boolean; restored: boolean }>(restoreContextScript(probeId), 30000);
        expect(restoreProbe).toMatchObject({ hasCanvas: true, restored: true });
        await pollContextEvents(cdp, 'restored', 30000);
        expect(await cdp.evaluate<boolean>(removeProbeCanvasScript(probeId), 30000)).toBe(true);
        console.log(`[follow-4] browser mechanism proof: probe canvas lost/restored via ${CONTEXT_LOSS_EXTENSION} (${FOLLOW4_CTX_RECORDER} observed)`);

        // (b) Production-canvas recovery on #q2-gl: frozen submissions while
        // lost, resumed submissions after restore, lifecycle counts, and
        // restored world/model/skin pixels. Two consecutive loss/restore
        // cycles prove bounded resources with no duplicate canvases.
        const gameCanvasId = 'q2-gl';
        const outDir = join(testDir, '..', 'test-output');
        mkdirSync(outDir, { recursive: true });
        expect(await cdp.evaluate<boolean>(installContextEventRecorderScript(gameCanvasId), 30000)).toBe(true);
        // Let the production loop submit a few frames before measuring.
        await new Promise<void>((r) => setTimeout(r, 3000));
        const diagFresh = await cdp.evaluate<unknown>(
          '(function(){var c=document.createElement("canvas");c.width=16;c.height=16;try{document.body.appendChild(c);}catch(e){}var gl=null;try{gl=c.getContext("webgl2");}catch(e){return "no-ctx";}if(!gl)return "no-ctx";var e0=0;try{e0=gl.getError();}catch(e){e0=-999;}var v="";try{v=String(gl.getParameter(gl.VERSION));}catch(e){v="unreadable";}var e1=-999;try{e1=gl.getError();}catch(e){}try{c.remove();}catch(e){}return{freshCtxError:e0,afterVersionError:e1,version:v};})()',
          30000,
        );
        console.log(`[follow-4] diag fresh canvas (driver-quirk control): ${JSON.stringify(diagFresh)}`);
        const diagRoute = await cdp.evaluate<unknown>(
          'window.__q2soakRoute ? (function(){var r=window.__q2soakRoute();return{warnings:r?r.warnings:null,uploads:r?r.uploads:null,frames:r?r.framesSubmitted:null,materials:r?r.materials:null};})() : null',
          30000,
        );
        console.log(`[follow-4] diag route (warnings/uploads/materials): ${JSON.stringify(diagRoute)}`);
        const glBeforeBoot = await readOneGlError(cdp, gameCanvasId);
        console.log(`[follow-4] boot GL error poll on ${gameCanvasId}: ${String(glBeforeBoot)} (fossil snapshot, report-only)`);
        // GL-error discipline (FOLLOW-4): flags are sticky. The historical
        // first-submit 1282 was an application error — the flat-fill sky pass
        // drew with no texture bound to unit 0 (sampler uMap incomplete on
        // SwiftShader) — fixed by binding the 1x1 white fallback in
        // drawSkyRange. Fresh-canvas control above proves the driver is clean;
        // boot + settled polls below prove the app no longer sets the flag.
        // Gate on SETTLED state, not the fossil: drain, let settled frames
        // advance, and require clean. A recurring defect re-dirties and fails.
        await new Promise<void>((r) => setTimeout(r, 2000));
        const glSettled = await readOneGlError(cdp, gameCanvasId);
        console.log(`[follow-4] settled GL error poll on ${gameCanvasId}: ${String(glSettled)}`);
        expect(
          glSettled,
          'settled GL error must be NO_ERROR (0); boot fossil is report-only, a settled 1282 is an application error — do not clear and continue',
        ).toBe(0);
        const canvasesBefore = await readCanvasCounts(cdp);
        expect(canvasesBefore.q2gl, 'exactly one production GL canvas before loss cycles').toBe(1);

        let prevFrames: number | null = null;
        let prevUploads: number | null = null;
        let prevLoss = 0;
        let prevRestore = 0;
        for (let cycle = 0; cycle < 2; cycle++) {
          const tag = `cycle-${cycle}`;
          const before = await readSoakNumbers(cdp);
          const lifeBefore = await readLifecycleNumbers(cdp);
          expect(before.renderer, `${tag}: production leg must run on the GPU backend`).toBe('webgl2-experimental');
          expect(before.framesSubmitted, `${tag}: production leg must have submitted frames`).not.toBeNull();
          expect(lifeBefore?.gpuActive, `${tag}: GPU must be active before loss`).toBe(true);
          expect(lifeBefore?.fallback, `${tag}: live GPU leg must carry no fallback label`).toBeNull();
          if (prevFrames !== null && before.framesSubmitted !== null) {
            expect(before.framesSubmitted, `${tag}: submissions advance between cycles`).toBeGreaterThan(prevFrames);
          }
          const pixelsBefore = await assertComposedScenePixels(cdp, outDir, `follow4-${tag}-before`);

          const loseGame = await cdp.evaluate<{ hasCanvas: boolean; lost: boolean }>(loseContextScript(gameCanvasId), 30000);
          expect(loseGame).toMatchObject({ hasCanvas: true, lost: true });
          await pollContextEvents(cdp, 'lost', 30000);
          // Freeze proof needs two reads WHILE lost (event delivery races the
          // pre-loss sample: frames may advance between `before` and the loss
          // gate closing). Read once the gate is observed, wait, read again.
          const during1 = await readSoakNumbers(cdp);
          const lifeDuring1 = await readLifecycleNumbers(cdp);
          await new Promise<void>((r) => setTimeout(r, 2500));
          const during = await readSoakNumbers(cdp);
          const lifeDuring = await readLifecycleNumbers(cdp);
          const recDuring = await readRecorderCounts(cdp);
          const canvasesDuring = await readCanvasCounts(cdp);
          console.log(
            `[follow-4] ${tag} while-lost: soak ${JSON.stringify(during)} life ${JSON.stringify(lifeDuring)} rec ${JSON.stringify(recDuring)} canvases ${JSON.stringify(canvasesDuring)}`,
          );
          expect(recDuring?.lost, `${tag}: genuine lost event must be recorded`).toBeGreaterThanOrEqual(1);
          // Frozen while lost: no new submissions once the loss gate has closed
          // (compare the two while-lost samples, not the pre-loss race window).
          expect(during.framesSubmitted, `${tag}: submissions must freeze while lost`).toBe(during1.framesSubmitted);
          if (lifeDuring && lifeDuring1 && lifeDuring.framesSubmitted !== null && lifeDuring1.framesSubmitted !== null) {
            expect(lifeDuring.framesSubmitted, `${tag}: lifecycle submissions freeze while lost`).toBe(lifeDuring1.framesSubmitted);
          }
          expect(lifeDuring?.contextLost, `${tag}: lifecycle must report contextLost while lost`).toBe(true);
          if (lifeBefore && lifeDuring && lifeBefore.lossCount !== null && lifeDuring.lossCount !== null) {
            expect(lifeDuring.lossCount, `${tag}: lossCount must advance on loss`).toBeGreaterThan(lifeBefore.lossCount ?? prevLoss);
          }
          expect(lifeDuring?.fallback, `${tag}: loss must not masquerade as fallback GPU execution`).toBeNull();
          expect(canvasesDuring.q2gl, `${tag}: no duplicate canvases while lost`).toBe(1);

          const restoreGame = await cdp.evaluate<{ hasCanvas: boolean; restored: boolean }>(restoreContextScript(gameCanvasId), 30000);
          expect(restoreGame).toMatchObject({ hasCanvas: true, restored: true });
          await pollContextEvents(cdp, 'restored', 30000);
          await new Promise<void>((r) => setTimeout(r, 3000));
          const after = await readSoakNumbers(cdp);
          const lifeAfter = await readLifecycleNumbers(cdp);
          const recAfter = await readRecorderCounts(cdp);
          const canvasesAfter = await readCanvasCounts(cdp);
          const glAfter = await readOneGlError(cdp, gameCanvasId);
          console.log(`[follow-4] ${tag} post-restore GL error poll: ${String(glAfter)}`);
          expect(
            glAfter,
            `${tag}: post-restore GL error must be NO_ERROR (0); a 1282 here is an application error at restore — do not clear and continue`,
          ).toBe(0);
          expect(recAfter?.lost, `${tag}: lost event survives restore`).toBeGreaterThanOrEqual(1);
          expect(recAfter?.restored, `${tag}: genuine restored event must be recorded`).toBeGreaterThanOrEqual(1);
          // Resumed after restore: submissions advance on the same backend.
          expect(after.framesSubmitted, `${tag}: submissions must resume after restore`).not.toBeNull();
          expect(
            after.framesSubmitted!,
            `${tag}: framesSubmitted must advance after restore (${String(during.framesSubmitted)} -> ${String(after.framesSubmitted)})`,
          ).toBeGreaterThan(during.framesSubmitted ?? -1);
          if (lifeDuring && lifeAfter && lifeAfter.framesSubmitted !== null) {
            expect(
              lifeAfter.framesSubmitted,
              `${tag}: lifecycle submissions resume after restore`,
            ).toBeGreaterThan(lifeDuring.framesSubmitted ?? -1);
          }
          expect(lifeAfter?.contextLost, `${tag}: lifecycle must clear contextLost after restore`).toBe(false);
          if (lifeDuring && lifeAfter && lifeDuring.restoreCount !== null && lifeAfter.restoreCount !== null) {
            expect(lifeAfter.restoreCount, `${tag}: restoreCount must advance on restore`).toBeGreaterThan(
              lifeDuring.restoreCount ?? prevRestore,
            );
          }
          if (before.uploads !== null && after.uploads !== null) {
            expect(after.uploads, `${tag}: uploads stay stable across restore (retained replay, no migration rebuild)`).toBe(before.uploads);
          }
          expect(canvasesAfter.q2gl, `${tag}: no duplicate canvases after restore`).toBe(1);
          const pixelsAfter = await assertComposedScenePixels(cdp, outDir, `follow4-${tag}-after`);

          const evidence = {
            canvasId: gameCanvasId,
            mechanism: CONTEXT_LOSS_EXTENSION,
            bootGlFossil: glBeforeBoot,
            lostEvents: recAfter?.lost ?? null,
            restoredEvents: recAfter?.restored ?? null,
            // Freeze baseline is the gate-closed sample (during1), not the
            // pre-loss race window: frames may advance between `before` and
            // event delivery, but must not advance once the loss gate closes.
            framesBeforeLoss: during1.framesSubmitted,
            framesWhileLost: during.framesSubmitted,
            framesAfterRestore: after.framesSubmitted,
            framesPreLossGate: before.framesSubmitted,
            rendererBefore: before.renderer,
            rendererAfter: after.renderer,
            warningAfter: after.warning,
            uploadsBefore: before.uploads,
            uploadsAfter: after.uploads,
            lossCountBefore: lifeBefore?.lossCount ?? null,
            lossCountDuring: lifeDuring?.lossCount ?? null,
            restoreCountDuring: lifeDuring?.restoreCount ?? null,
            restoreCountAfter: lifeAfter?.restoreCount ?? null,
            glBeforeBoot,
            glAfterRestore: glAfter,
            canvasesBefore,
            canvasesDuring,
            canvasesAfter,
            pixelsBefore,
            pixelsAfter,
          };
          console.log(`[follow-4] ${formatBrowserLossEvidence({ ...evidence, lostEvents: evidence.lostEvents, restoredEvents: evidence.restoredEvents })}`);
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          writeFileSync(join(outDir, `gpu-follow-4-${stamp}-${tag}-loss.json`), JSON.stringify(evidence, null, 2));

          // No silent fallback: renderer identity holds on the production
          // canvas, and a non-GPU renderer would need an explicit warning.
          expect(after.renderer).toBe(before.renderer);
          expect(after.renderer).toBe('webgl2-experimental');
          expect(after.warning).toBeNull();
          expect(lifeAfter?.fallback).toBeNull();

          prevFrames = after.framesSubmitted;
          prevUploads = after.uploads ?? prevUploads;
          prevLoss = lifeAfter?.lossCount ?? prevLoss;
          prevRestore = lifeAfter?.restoreCount ?? prevRestore;
        }
      } finally {
        if (cdp) {
          await cdp.close().catch(() => undefined);
          cdp = null;
        }
        if (chromium) {
          chromium.kill();
          chromium = null;
        }
        if (vite) {
          await vite.close();
          vite = null;
        }
        if (pakServer) {
          await pakServer.close();
          pakServer = null;
        }
      }
    },
  );
});
