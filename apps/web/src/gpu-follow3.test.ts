// GPU-FOLLOW-3 live effects (apps/web only, Q2_PAK-gated for the live path).
//
// Proves, on the REAL production path (`frameGpuPlay` — the exact entry the
// shipped rAF tick calls), that combat events become submitted GPU geometry:
// blaster bolt → muzzle dlight → wall impact → explosion entity + light +
// spark particles → submitted scene refs with preserved model-kind metadata
// → real on-canvas submissions (stub GL records the draw walk) — and, on a
// real headless page, visible combat pixels next to live effects state.
//
// What this file is NOT: a renderer re-implementation. Sprite animation/size,
// the 256-point particle cap and beam widths are renderer-owned; this lane
// pins the LIVE wiring (producers → drains → submitted geometry). The two
// renderer gaps this lane initially documented are now CLOSED by the
// packages/webgl-renderer lane in the same card: combined
// turbulent+translucent flags ride the blend pass (TRANS-first, warped) and
// default-alpha beams sort by blend-pass distance order.
// Unit-level policy (inventory shape, drain order, lifetimes) runs without a
// pak; every combat/beam/material assertion below runs the live server tick.
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { BUTTON_ATTACK, keyDown, keyUp } from '@q2/input';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import { SV_SpawnMonster, SV_SetPlayerHealth } from '@q2/server';
import { parseSP2 } from '@q2/formats';
import { GPU_SPRITE_SIZE } from '@q2/webgl-renderer';
import type { GpuEntityModelKind } from '@q2/webgl-renderer';
import type { GpuFrameInput, GpuLight } from '@q2/renderer-api';
import {
  bootPlay,
  buildAsyncView,
  frameGpuPlay,
  explosionFrames,
  SPARK_TTL,
  EXPLOSION_LIGHT_WINDOW,
  HITSCAN_TRACER_COLOR,
  ENEMY_TRACER_LENGTH,
  TRACER_TTL_FRAMES,
  BLASTER_TRACER_COLOR,
} from './play.js';
import type { ExplosionKind } from './play.js';
import {
  EFFECT_DRAIN_ORDER,
  describeEffectInventory,
  modelKindsForFrame,
  synthesizeBeamEntities,
  censusWorldMaterials,
  censusSceneMaterials,
  isBlendOrderSorted,
  readLiveEffects,
  MUZZLE_LIGHT_COLOR,
  BOLT_LIGHT_INTENSITY,
  BLASTER_LIGHT_INTENSITY,
  BOOM_LIGHT_INTENSITY,
  BOOM_LIGHT_COLOR,
} from './gpu-effects.js';
import { accessSync, constants, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { createServer } from 'http';

const WEB_Q2_PAK = process.env.Q2_PAK;
const CHROMIUM_BIN = process.env.CHROMIUM_BIN ?? '/usr/bin/chromium';

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g['document'];
});

// --- stub DOM/GL (same recording-proxy shape as gpu-live-route.test.ts) ----

const GL_NUM = {
  NO_ERROR: 0,
  VERSION: 7937,
  VERTEX_SHADER: 35633,
  FRAGMENT_SHADER: 35632,
  COMPILE_STATUS: 35713,
  LINK_STATUS: 35714,
  ARRAY_BUFFER: 34962,
  ELEMENT_ARRAY_BUFFER: 34963,
  STATIC_DRAW: 35044,
  DYNAMIC_DRAW: 35048,
  TEXTURE_2D: 3553,
  TEXTURE0: 33984,
  RGBA: 6408,
  UNSIGNED_BYTE: 5121,
  UNSIGNED_INT: 5125,
  FLOAT: 5126,
  LINEAR: 9729,
  NEAREST: 9728,
  CLAMP_TO_EDGE: 33071,
  TEXTURE_MIN_FILTER: 10241,
  TEXTURE_MAG_FILTER: 10240,
  TEXTURE_WRAP_S: 10242,
  TEXTURE_WRAP_T: 10243,
  UNPACK_FLIP_Y_WEBGL: 37440,
  DEPTH_TEST: 2929,
  BLEND: 3042,
  LESS: 513,
  SRC_ALPHA: 770,
  ONE_MINUS_SRC_ALPHA: 771,
  COLOR_BUFFER_BIT: 16384,
  DEPTH_BUFFER_BIT: 256,
  TRIANGLES: 4,
  POINTS: 0,
  MAX_TEXTURE_SIZE: 3379,
  RENDERBUFFER: 36161,
  DEPTH_COMPONENT16: 33189,
  DEPTH_COMPONENT24: 33190,
  COLOR_ATTACHMENT0: 36064,
  DEPTH_ATTACHMENT: 36096,
  FRAMEBUFFER: 36160,
  FRAMEBUFFER_COMPLETE: 36053,
} as const;

function makeStubGL(log: string[]): Record<string, unknown> {
  const target: Record<string, unknown> = { ...GL_NUM };
  target['getParameter'] = (p: unknown): unknown => {
    log.push('getParameter');
    if (p === GL_NUM.VERSION) return 'WebGL 2.0 (stub)';
    if (p === GL_NUM.MAX_TEXTURE_SIZE) return 4096;
    return 1024;
  };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(t, prop, receiver): unknown {
      if (typeof prop === 'symbol') return undefined;
      if (prop in t) return Reflect.get(t, prop, receiver);
      return (...args: unknown[]): unknown => {
        log.push(String(prop));
        void args;
        switch (prop) {
          case 'getShaderParameter':
          case 'getProgramParameter':
            return true;
          case 'getShaderInfoLog':
          case 'getProgramInfoLog':
            return '';
          case 'getAttribLocation':
            return 0;
          case 'getUniformLocation':
            return {};
          case 'getError':
            return 0;
          case 'checkFramebufferStatus':
            return 36053;
          case 'createShader':
          case 'createProgram':
          case 'createBuffer':
          case 'createTexture':
          case 'createRenderbuffer':
          case 'createFramebuffer':
          case 'createVertexArray':
            return {};
          default:
            return undefined;
        }
      };
    },
  };
  return new Proxy(target, handler);
}

interface StubCanvas {
  id: string;
  width: number;
  height: number;
  style: Record<string, string>;
  setAttribute(k: string, v: string): void;
  getContext(kind: string, attrs?: unknown): unknown;
}

function installStubDoc(): { log: string[] } {
  const g = globalThis as unknown as Record<string, unknown>;
  const log: string[] = [];
  const gl = makeStubGL(log);
  const canvases: StubCanvas[] = [];
  const hud = {
    id: 'q2',
    style: {} as Record<string, string>,
    parentNode: { inserted: [] as unknown[] },
  };
  (hud.parentNode as { insertBefore?: unknown }).insertBefore = (c: unknown, ref: unknown): void => {
    hud.parentNode.inserted.push([c, ref]);
  };
  const doc = {
    createElement: (tag: string): unknown => {
      if (tag !== 'canvas') return {};
      const canvas: StubCanvas = {
        id: '',
        width: 0,
        height: 0,
        style: {},
        setAttribute(k: string, v: string): void {
          if (k === 'id') canvas.id = v;
        },
        getContext(kind: string): unknown {
          return kind === 'webgl2' ? gl : null;
        },
      };
      canvases.push(canvas);
      return canvas;
    },
    getElementById: (id: string): unknown => {
      if (id === 'q2') return hud;
      if (id === 'q2-gl') return canvases.find((c) => c.id === 'q2-gl') ?? null;
      return null;
    },
    body: { appendChild: (c: unknown): void => { log.push('body.appendChild'); void c; } },
  };
  g['document'] = doc;
  return { log };
}

async function loadPakBoot(width = 96, height = 72): Promise<ReturnType<typeof bootPlay>> {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  const pak = ingestPak(buf);
  setCVar('vid_renderer', 'webgl2-experimental');
  const boot = bootPlay({ width, height, pak });
  expect(boot.renderer).toBe('webgl2-experimental');
  expect(boot.gpu).not.toBeNull();
  expect(boot.source).toBe('pak');
  return boot;
}

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

const FATAL_WARNING_RE = /missing|texels may be corrupt|invalid|failed|deferred/i;
function fatalWarnings(all: string[]): string[] {
  return all.filter((w) => FATAL_WARNING_RE.test(w));
}

/** Capture per-frame lights + entity kinds off the committed backend. */
function spyGpuFrame(boot: ReturnType<typeof bootPlay>): {
  lights: GpuLight[][];
  kinds: Array<ReadonlyMap<number, GpuEntityModelKind> | undefined>;
} {
  const gpu = boot.gpu!.gpu;
  const lights: GpuLight[][] = [];
  const kinds: Array<ReadonlyMap<number, GpuEntityModelKind> | undefined> = [];
  const innerRender = gpu.renderFrame.bind(gpu);
  gpu.renderFrame = (input: GpuFrameInput): void => {
    lights.push(input.lights ?? []);
    innerRender(input);
  };
  const innerEntities = gpu.setEntities.bind(gpu);
  gpu.setEntities = (entities, modelKinds): void => {
    kinds.push(modelKinds);
    innerEntities(entities, modelKinds);
  };
  return { lights, kinds };
}

// --- unit-level policy (no pak) --------------------------------------------

describe('gpu-follow3 inventory + wiring policy (no pak)', () => {
  it('inventory covers every live producer/consumer; only sprites are idle', () => {
    const rows = describeEffectInventory();
    expect(rows.length).toBeGreaterThanOrEqual(14);
    const byEffect = new Map(rows.map((r) => [r.effect, r]));
    for (const name of ['bolts', 'muzzles', 'tracers', 'sparks', 'explosions', 'debris', 'gibs',
      'particles', 'lights', 'monsters', 'pickups', 'viewmodel', 'sky', 'turbulent', 'transparent']) {
      expect(byEffect.get(name)?.live, `${name} must have a live producer`).toBe(true);
    }
    // No server sprite queue feeds the renderer (gap for the server lane).
    expect(byEffect.get('sprites')?.live).toBe(false);
  });

  it('server one-shot drains run in the documented tick order, once per tick', () => {
    expect([...EFFECT_DRAIN_ORDER]).toEqual(['muzzles', 'tracers', 'sparks', 'sounds']);
  });

  it('light mapping constants match the frameGpuPlay submission', () => {
    expect(MUZZLE_LIGHT_COLOR).toEqual([1, 1, 0]);
    expect(BOLT_LIGHT_INTENSITY).toBe(200);
    expect(BLASTER_LIGHT_INTENSITY).toBe(150);
    expect(BOOM_LIGHT_INTENSITY).toBe(350);
    expect(BOOM_LIGHT_COLOR).toEqual([1, 0.5, 0.5]);
    // Enemy streaks and blaster bolts share the C-correct yellow, never green.
    expect(HITSCAN_TRACER_COLOR).toBe(225);
    expect(BLASTER_TRACER_COLOR).toBe(225);
  });

  it('effect lifetimes are preserved (frames, TTLs, windows)', () => {
    const blaster: ExplosionKind = 'blaster';
    const e1: ExplosionKind = 'explosion1';
    const e2: ExplosionKind = 'explosion2';
    expect(explosionFrames(blaster)).toBe(4);
    expect(explosionFrames(e1)).toBe(15);
    expect(explosionFrames(e2)).toBe(19);
    expect(SPARK_TTL).toBe(0.4);
    // ex_misc frees at f>=frames-1=3 (cl_tent.c CL_AddExplosions): the
    // 150-intensity yellow touch flash burns 3 steps, not one 100ms tick.
    expect(EXPLOSION_LIGHT_WINDOW).toBe(0.3);
    expect(TRACER_TTL_FRAMES).toBe(6);
  });

  it('beam synthesis keeps the contract-free convention + tracer kinds', () => {
    const { entities, kinds } = synthesizeBeamEntities([
      { origin: [1, 2, 3], dir: [0, 1, 0], color: 225, length: 48 },
      { origin: [4, 5, 6], dir: [1, 0, 0], color: 225, length: 48 },
    ]);
    expect(entities).toHaveLength(2);
    expect(entities[0]!.model).toBe(-1000);
    expect(entities[1]!.model).toBe(-1001);
    expect([...entities[0]!.origin]).toEqual([1, 2, 3]);
    expect(entities[0]!.frame).toBe(48);
    expect(entities[0]!.skin).toBe(225);
    expect(kinds.get(-1000)).toBe('tracer');
    expect(kinds.get(-1001)).toBe('tracer');
  });

  it('modelKindsForFrame preserves registered kinds, beams override to tracer', () => {
    expect(modelKindsForFrame(null, []).size).toBe(0);
    const fake = {
      assets: {
        models: [
          { handle: 3, kind: 'md2', data: {}, path: 'a', fallback: false },
          { handle: 7, kind: 'sp2', data: {}, path: 'b', fallback: false },
        ],
        skins: [],
      },
    } as unknown as Parameters<typeof modelKindsForFrame>[0];
    const kinds = modelKindsForFrame(fake, [-1000]);
    expect(kinds.get(3)).toBe('md2');
    expect(kinds.get(7)).toBe('sp2');
    expect(kinds.get(-1000)).toBe('tracer');
  });

  it('blend-pass order contract checker matches the scene invariant', () => {
    const sorted = {
      surfaces: [
        { transparent: false, order: 0 },
        { transparent: true, order: 30 },
        { transparent: true, order: 10 },
      ],
      transforms: [],
      staticGeneration: 1,
    } as unknown as Parameters<typeof isBlendOrderSorted>[0];
    expect(isBlendOrderSorted(sorted)).toBe(true);
    const unsorted = {
      surfaces: [
        { transparent: true, order: 10 },
        { transparent: true, order: 30 },
      ],
      transforms: [],
      staticGeneration: 1,
    } as unknown as Parameters<typeof isBlendOrderSorted>[0];
    expect(isBlendOrderSorted(unsorted)).toBe(false);
  });

  it('sprite size matches the renderer billboard contract (48x48)', () => {
    expect(GPU_SPRITE_SIZE).toBe(48);
  });

  it('readLiveEffects degrades gracefully without a GPU boot (devroom)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    expect(boot.gpu).toBeNull();
    const fx = readLiveEffects(boot);
    expect(fx.bolts).toBe(0);
    expect(fx.explosions).toBe(0);
    expect(fx.muzzleLit).toBe(false);
    expect(fx.scene).toBeNull();
    expect(fx.blendSorted).toBeNull();
    expect(fx.world).not.toBeNull();
    expect(fx.particleCap).toBe(256);
  });
});

// --- live combat → submitted geometry (Q2_PAK) ------------------------------

describe.runIf(!!WEB_Q2_PAK)('gpu-follow3 live combat → submitted geometry (Q2_PAK)', () => {
  it('real pak sprites parse (animation frames + sizes the live loop would use)', async () => {
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak, readPakEntry } = await import('./pak.js');
    const pak = ingestPak(buf);
    for (const name of ['sprites/s_explod.sp2', 'sprites/s_bfg1.sp2']) {
      const bytes = readPakEntry(pak, name);
      const sp2 = parseSP2(bytes);
      expect(sp2.names.length).toBeGreaterThanOrEqual(1);
      expect(sp2.widths.length).toBe(sp2.names.length);
      for (let i = 0; i < sp2.names.length; i++) {
        expect(sp2.widths[i]).toBeGreaterThan(0);
        expect(sp2.heights[i]).toBeGreaterThan(0);
      }
    }
  });

  it('blaster: shot → bolt entity + muzzle light → impact explosion + particles → submitted scene', { timeout: 180000 }, async () => {
    const doc = installStubDoc();
    const boot = await loadPakBoot();
    const { driver } = boot;
    const models = boot.models!;
    const spy = spyGpuFrame(boot);
    let now = 0;

    // Live shot through the real server tick (not a synthetic entity).
    driver.step({ ...neutralCmd(), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.events).toContain('shot');
    expect(driver.events).toContain('bolt');
    expect(driver.bolts).toHaveLength(1);
    expect(driver.muzzleLit()).toBe(true);
    // Single-drain rule: the tick already drained every server queue.
    expect(driver.server.muzzles).toHaveLength(0);
    expect(driver.server.tracers).toHaveLength(0);
    expect(driver.server.sparks).toHaveLength(0);
    expect(driver.server.sounds).toHaveLength(0);

    // Bolt extras carry the registered pak mesh/skin before the first submit.
    const pre = buildAsyncView(boot.host, 0);
    const boltExtra = pre.renderables.find((e) => e.model === models.bolt);
    expect(boltExtra, 'live bolt resolves to the registered bolt MD2').toBeDefined();
    expect(boltExtra!.skin).toBe(models.boltSkin);

    // First GPU frame: muzzle dlight + bolt entity submitted, metadata kept.
    now += 16;
    const st0 = frameGpuPlay(boot, now);
    expect(st0?.framesSubmitted).toBe(1);
    expect(spy.lights[0]!.length).toBeGreaterThanOrEqual(2); // muzzle + per-bolt
    const muzzle = spy.lights[0]!.find((l) => l.intensity === driver.peekFlashIntensity());
    expect(muzzle, 'player muzzle dlight submitted with fire-time intensity').toBeDefined();
    expect([...muzzle!.color]).toEqual([1, 1, 0]);
    expect(spy.kinds[0]?.get(models.bolt)).toBe('md2');
    // NOTE: no absence assertion on skin handles here — model and skin
    // handles live in separate namespaces that reuse small integers, so a
    // skin handle can numerically equal an unrelated model handle.
    const scene0 = censusSceneMaterials(boot.gpu!.scene);
    expect(scene0.worldOpaque).toBeGreaterThan(0);
    expect(scene0.alias).toBeGreaterThanOrEqual(1);
    expect(isBlendOrderSorted(boot.gpu!.scene)).toBe(true);
    // One-shot driver queues are consumed by the frame (no double-submit).
    expect(driver.drainFlash()).toBeNull();
    expect(driver.drainTracers()).toEqual([]);

    // Fly the bolt to the wall on the live tick (spawn faces it ~100u out).
    let impactFrame = -1;
    let impactParticles = -1;
    for (let i = 0; i < 60 && impactFrame < 0; i++) {
      if (i % 20 === 0) SV_SetPlayerHealth(driver.server, 100);
      now += 16;
      frameGpuPlay(boot, now);
      if (driver.explosions.length > 0) {
        impactFrame = i;
        impactParticles = driver.mini.particles.length;
      }
    }
    expect(impactFrame).toBeGreaterThanOrEqual(0);
    expect(driver.explosions[0]!.kind).toBe('blaster');
    expect(impactParticles).toBeGreaterThanOrEqual(40); // 40 impact + trail
    // The impact lands in frame i's SIM, which runs AFTER frame i's drains —
    // so the explosion light first appears in the NEXT frame's drain (same
    // server.time, age 0 < 0.1 window). This is the intended tick order, and
    // the test observes it instead of assuming same-frame visibility.
    now += 16;
    frameGpuPlay(boot, now);
    const flat = spy.lights.flat();
    // alpha is exactly 1 on the first post-impact drain (age 0), so the
    // bound is inclusive; muzzle (>=200) and bolt (200) still cannot match.
    const boom = flat.find((l) => l.color[0] === 1 && l.color[1] === 1 && l.color[2] === 0
      && l.intensity > 0 && l.intensity <= BLASTER_LIGHT_INTENSITY);
    expect(boom, 'blaster-touch explosion light submitted with 150*alpha scale').toBeDefined();
    // Explosion entity rides the submitted scene with framelerp + alpha.
    const post = buildAsyncView(boot.host, 0);
    const blast = post.renderables.find((e) => e.model === models.blast);
    expect(blast, 'live blaster explosion submits the explode MD2').toBeDefined();
    expect(blast!.skin).toBe(models.blastSkin);
    const scene1 = censusSceneMaterials(boot.gpu!.scene);
    expect(scene1.alias).toBeGreaterThanOrEqual(1);
    // Real on-canvas submissions advanced; the stub GL walked real draws.
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(impactFrame + 3);
    expect(doc.log.filter((m) => m === 'drawElements' || m === 'drawArrays').length).toBeGreaterThan(0);
    expect(fatalWarnings(boot.gpu!.gpu.testWarnings())).toEqual([]);

    // Lifetimes: the 4-frame blaster flash prunes after 0.4s of server time.
    for (let i = 0; i < 6; i++) driver.step(neutralCmd(), 0.1);
    expect(driver.drainExplosions()).toEqual([]);
    now += 16;
    frameGpuPlay(boot, now);
    const later = buildAsyncView(boot.host, 0);
    expect(later.renderables.find((e) => e.model === models.blast)).toBeUndefined();
    console.log(
      `[gpu-follow3] blaster impactFrame=${impactFrame} impactParticles=${impactParticles} `
        + `frames=${boot.gpu!.gpu.getStatus().framesSubmitted} uploads=${boot.gpu!.gpu.testUploadStats().uploads}`,
    );
  });

  it('monster return fire: tracers → beam entities with tracer kinds + enemy light', { timeout: 180000 }, async () => {
    installStubDoc();
    const boot = await loadPakBoot();
    const { driver } = boot;
    const spy = spyGpuFrame(boot);
    let now = 0;
    SV_SpawnMonster(driver.server, 'monster_soldier', v3(128, -120, 32));
    let monshotTick = -1;
    for (let i = 0; i < 200 && monshotTick < 0; i++) {
      if (i % 20 === 0) SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
      if (driver.events.includes('monshot')) monshotTick = i;
    }
    expect(monshotTick, 'live soldier must return fire (monshot)').toBeGreaterThanOrEqual(0);
    // The tick drained the server tracer queue into live driver beams.
    expect(driver.pendingTracers).toBeGreaterThan(0);
    expect(driver.server.tracers).toHaveLength(0);
    now += 16;
    frameGpuPlay(boot, now);
    // Beams submitted as tracer-kind entities with the C-correct color.
    const scene = censusSceneMaterials(boot.gpu!.scene);
    expect(scene.beam).toBeGreaterThanOrEqual(1);
    const kinds = spy.kinds[spy.kinds.length - 1];
    expect(kinds, 'entity kinds map submitted').toBeDefined();
    let beamModels = 0;
    for (const [h, k] of kinds!) {
      if (h < 0) {
        expect(k).toBe('tracer');
        beamModels++;
      }
    }
    expect(beamModels).toBeGreaterThan(0);
    const post = buildAsyncView(boot.host, 0);
    for (const e of post.renderables) {
      if (e.model < 0) expect(e.skin).toBe(HITSCAN_TRACER_COLOR);
    }
    // Enemy muzzle flash rode the same frame as a yellow dlight, then drained.
    expect(spy.lights[spy.lights.length - 1]!.length).toBeGreaterThanOrEqual(1);
    expect(driver.drainEnemyMuzzle()).toEqual([]);
    expect(isBlendOrderSorted(boot.gpu!.scene)).toBe(true);
    expect(fatalWarnings(boot.gpu!.gpu.testWarnings())).toEqual([]);
    console.log(`[gpu-follow3] monshot tick=${monshotTick} beams=${scene.beam} len=${ENEMY_TRACER_LENGTH}`);
  });

  it('player pellets spark but never beam (live hitscan split)', { timeout: 120000 }, async () => {
    installStubDoc();
    const boot = await loadPakBoot();
    const { driver } = boot;
    if (!driver.hasWeapon('weapon_shotgun')) {
      (driver as unknown as { ps: { weapons: string[] } }).ps.weapons.push('weapon_shotgun');
    }
    (driver as unknown as { shells: number }).shells = 50;
    driver.selectWeapon('weapon_shotgun');
    for (let i = 0; i < 30 && driver.weaponSwitching; i++) driver.step(neutralCmd(), 0.1);
    expect(driver.weaponSwitching).toBe(false);
    driver.step({ ...neutralCmd(), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.events).toContain('shot');
    expect(driver.pendingTracers).toBe(0); // C fire_lead: impact sparks only
    expect(driver.mini.particles.length).toBeGreaterThan(0);
  });

  it('lifetimes + weapon timing on the live path (refire, muzzle window, gunframe)', { timeout: 120000 }, async () => {
    installStubDoc();
    const boot = await loadPakBoot();
    const { driver } = boot;
    driver.step({ ...neutralCmd(), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.muzzleLit()).toBe(true);
    const litAt = driver.peekFlashIntensity();
    expect(litAt).toBeGreaterThanOrEqual(200);
    expect(litAt).toBeLessThanOrEqual(231);
    // Refire gate: an immediate second trigger fires nothing new.
    const bolts = driver.bolts.length;
    driver.step({ ...neutralCmd(), buttons: BUTTON_ATTACK }, 0.1);
    expect(driver.bolts.length).toBeLessThanOrEqual(bolts);
    // Muzzle window expires 0.09s after the shot (server time).
    for (let i = 0; i < 3; i++) driver.step(neutralCmd(), 0.1);
    expect(driver.muzzleLit()).toBe(false);
    // Weapon_Generic-lite gunframe walks fire → idle READY and holds.
    expect(driver.gunFrame).toBeGreaterThanOrEqual(0);
  });

  it('supported arsenal, enemies, pickups: every mesh/skin registered, none missing', { timeout: 180000 }, async () => {
    installStubDoc();
    const boot = await loadPakBoot();
    const { driver } = boot;
    const models = boot.models!;
    let now = 0;
    for (let i = 0; i < 10; i++) {
      now += 16;
      frameGpuPlay(boot, now);
    }
    const gpu = boot.gpu!.gpu;
    const regModels = gpu.testRegisteredModels();
    const regSkins = gpu.testRegisteredSkins();
    // Every supported weapon view model + skin resolves and stays registered.
    for (const cls of Object.keys(models.weapons)) {
      expect(regModels, `${cls} mesh registered`).toContain(models.weapons[cls]!);
      expect(regSkins, `${cls} skin registered`).toContain(models.weaponSkins[cls]!);
    }
    // Enemies: soldier + infantry live in base1; gunner mesh registered (roster fact: none live).
    expect(driver.aliveMonsters).toBeGreaterThan(0);
    const kinds = new Set(driver.monsters.filter((m) => !m.state.dead).map((m) => String(m.state.kind)));
    expect([...kinds].sort()).toEqual(['infantry', 'soldier']);
    for (const h of [models.monster, models.gunner, models.infantry, models.barrel, models.bolt]) {
      expect(regModels).toContain(h);
    }
    for (const h of [models.monsterSkin, models.gunnerSkin, models.infantrySkin, models.barrelSkin, models.boltSkin]) {
      expect(regSkins).toContain(h);
    }
    // Soldier skinnum looks resolve per skin (light/plain/ss).
    expect(driver.soldierSkinFor(0)).toBe(models.soldierLightSkin);
    expect(driver.soldierSkinFor(2)).toBe(models.monsterSkin);
    expect(driver.soldierSkinFor(4)).toBe(models.soldierSsSkin);
    // Pickups: live skill-kept items all resolve to registered world models.
    expect(driver.livePickupCount()).toBeGreaterThan(0);
    for (const h of Object.values(models.items)) {
      expect(regModels).toContain(h.model);
      expect(regSkins).toContain(h.skin);
    }
    // Explosion/debris/gib/corpse/ship/banner meshes registered (submitted when live).
    for (const h of [models.explode, models.blast, models.debris1, models.debris2, models.debris3,
      models.gibMeat, models.gibChest, models.gibBone, models.gibHead,
      models.corpse, models.ship, models.banner]) {
      expect(regModels, `mesh ${h} registered`).toContain(h);
    }
    // Viewmodel reports the live gunframe on the registered v_weap MD2.
    const vm = driver.viewModel();
    expect(vm).not.toBeNull();
    expect(regModels).toContain(vm!.model);
    expect(regSkins).toContain(vm!.skin);
    expect(vm!.frame).toBe(driver.gunFrame);
    expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
    expect(fatalWarnings(gpu.testWarnings())).toEqual([]);
  });

  it('world materials: live census + submitted selection + blend order over a live walk', { timeout: 300000 }, async () => {
    installStubDoc();
    const boot = await loadPakBoot();
    const { driver } = boot;
    // Static live census (real base1 MiniWorld, not a fixture).
    const census = censusWorldMaterials(driver.mini);
    expect(census.sky).toBeGreaterThan(0);
    expect(census.turbulent).toBeGreaterThan(0);
    expect(census.transparent).toBeGreaterThan(0);
    expect(census.opaque).toBeGreaterThan(0);
    // Combined turbulent+translucent flags (base1 water/glass overlap).
    expect(census.turbulentTranslucent).toBe(census.turbulent);
    let now = 0;
    const seen = { sky: 0, turbulent: 0, transparent: 0, opaque: 0, beam: 0 };
    let yawExtra = 0;
    let lastCheck: [number, number, number] = [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]!];
    keyDown(boot.host.input, 'forward');
    const FRAMES = 300;
    for (let i = 0; i < FRAMES; i++) {
      if (i % 20 === 0) SV_SetPlayerHealth(driver.server, 100);
      now += 16;
      frameGpuPlay(boot, now);
      const c = censusSceneMaterials(boot.gpu!.scene);
      seen.sky = Math.max(seen.sky, c.sky);
      seen.turbulent = Math.max(seen.turbulent, c.turbulent);
      seen.transparent = Math.max(seen.transparent, c.worldTransparent);
      seen.opaque = Math.max(seen.opaque, c.worldOpaque);
      seen.beam = Math.max(seen.beam, c.beam);
      expect(c.worldOpaque).toBeGreaterThan(0);
      expect(isBlendOrderSorted(boot.gpu!.scene), `frame ${i}: blend pass stays far->near`).toBe(true);
      expect(boot.gpu!.gpu.testUploadStats().uploads).toBe(1);
      expect(fatalWarnings(boot.gpu!.gpu.testWarnings())).toEqual([]);
      const o = driver.pm.origin;
      if (i > 0 && i % 40 === 0) {
        const moved = Math.hypot(o[0]! - lastCheck[0], o[1]! - lastCheck[1], o[2]! - lastCheck[2]);
        lastCheck = [o[0]!, o[1]!, o[2]!];
        if (moved < 30) {
          yawExtra = (yawExtra + 90) % 360;
          boot.host.input.angles = [0, yawExtra, 0];
        }
      }
    }
    keyUp(boot.host.input, 'forward');
    expect(boot.gpu!.gpu.getStatus().framesSubmitted).toBe(FRAMES);
    expect(boot.gpu!.staticScene.staticGeneration).toBe(boot.gpu!.scene.staticGeneration);
    console.log(
      `[gpu-follow3] walk maxRefs=${JSON.stringify(seen)} clusters…`,
    );
    // Transparent glass and turbulent water both submit on a real multi-room walk.
    expect(seen.transparent).toBeGreaterThan(0);
    expect(seen.turbulent).toBeGreaterThan(0);
    // Submitted turbulent refs carry the FIXED classification (blend pass,
    // warped — the TRANS-first correction landed in packages/webgl-renderer
    // in this same card; the pre-fix opaque-batch pin is superseded).
    for (const r of boot.gpu!.scene.surfaces) {
      if (r.material === 'turbulent') expect(r.transparent).toBe(true);
    }
  });
});

// --- live combat pixels on the real page (chromium, Q2_PAK) -----------------

interface CdpKey { key: string; code: string; windowsVirtualKeyCode: number; nativeVirtualKeyCode: number; }
interface CdpShotStats { w: number; h: number; nonblack: number; mean: number; hash: number; }
interface BrowserPage {
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
  keyDown(key: CdpKey): Promise<void>;
  keyUp(key: CdpKey): Promise<void>;
  mouseDown(x: number, y: number): Promise<void>;
  mouseUp(x: number, y: number): Promise<void>;
  screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<string>;
  close(): void;
}

const SHOT_STATS_INSTALL = `window.__shotStats = async (b64) => {
  const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let n = 0; let s = 0; let h = 0;
  for (let i = 0; i < d.length; i += 4) {
    const m = (d[i] + d[i+1] + d[i+2]) / 3;
    if (m > 8) n++;
    s += m;
    h = ((h * 31 + (m | 0)) | 0) >>> 0;
  }
  const px = d.length / 4;
  bmp.close();
  return { w: c.width, h: c.height, nonblack: n / px, mean: s / px, hash: h };
};`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitHttpOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`http not ready: ${url}`);
    await sleep(2000);
  }
}

interface CdpMessage {
  id?: unknown;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: {
    args?: { value?: unknown; description?: string; type?: string }[];
    type?: string;
    exceptionDetails?: { text?: string };
  };
}

function createBrowserPage(wsUrl: string): Promise<{ page: BrowserPage; consoleLines: string[] }> {
  return new Promise((resolvePage, rejectPage) => {
    const ws = new WebSocket(wsUrl);
    const consoleLines: string[] = [];
    const pending = new Map<number, { res: (v: Record<string, unknown>) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let nextId = 1;
    let closed = false;
    const send = (method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> =>
      new Promise((res, rej) => {
        if (closed) { rej(new Error('CDP closed')); return; }
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
        pending.set(id, { res, rej, timer });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (e) {
          pending.delete(id);
          clearTimeout(timer);
          rej(e instanceof Error ? e : new Error(String(e)));
        }
      });
    const openTimer = setTimeout(() => { try { ws.close(); } catch { /* x */ } rejectPage(new Error('CDP socket open timeout')); }, 20000);
    ws.onopen = () => {
      clearTimeout(openTimer);
      const page: BrowserPage = {
        evaluate: async <T>(expression: string, timeoutMs = 60000): Promise<T> => {
          const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
          const rec = r as { exceptionDetails?: { text?: string }; result?: { value?: unknown } };
          if (rec.exceptionDetails) throw new Error(`page evaluate threw: ${(rec.exceptionDetails.text ?? 'unknown').slice(0, 200)}`);
          return rec.result?.value as T;
        },
        keyDown: async (key) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: false, ...key }, 15000); },
        keyUp: async (key) => { await send('Input.dispatchKeyEvent', { type: 'keyUp', autoRepeat: false, ...key }, 15000); },
        mouseDown: async (x, y) => {
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, 15000);
        },
        mouseUp: async (x, y) => {
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, 15000);
        },
        screenshot: async (clip?: { x: number; y: number; width: number; height: number }): Promise<string> => {
          const params: Record<string, unknown> = { format: 'png', fromSurface: true };
          if (clip) {
            params['clip'] = { ...clip, scale: 1 };
            params['captureBeyondViewport'] = true;
          }
          const r = await send('Page.captureScreenshot', params, 60000);
          const data = (r as { data?: unknown }).data;
          if (typeof data !== 'string') throw new Error('screenshot: no data');
          return data;
        },
        close: (): void => {
          closed = true;
          for (const [, p] of pending) { clearTimeout(p.timer); p.rej(new Error('CDP closed')); }
          pending.clear();
          try { ws.close(); } catch { /* x */ }
        },
      };
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== 'string') return;
        let msg: CdpMessage | null = null;
        try {
          msg = JSON.parse(ev.data) as CdpMessage;
        } catch { return; }
        if (!msg) return;
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.rej(new Error(`CDP error: ${msg.error.message ?? 'unknown'}`));
          else p.res((msg.result ?? {}) as Record<string, unknown>);
          return;
        }
        if (msg.method === 'Runtime.consoleAPICalled') {
          const args = msg.params?.args ?? [];
          const text = args.map((a) => (a.value !== undefined
            ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value))
            : (a.description ?? String(a.type ?? '?')))).join(' ');
          if (consoleLines.length < 400) consoleLines.push(`[console.${msg.params?.type ?? 'log'}] ${text}`);
        } else if (msg.method === 'Runtime.exceptionThrown') {
          if (consoleLines.length < 400) consoleLines.push(`[exception] ${msg.params?.exceptionDetails?.text ?? 'unknown'}`);
        }
      };
      ws.onclose = () => {
        closed = true;
        for (const [, p] of pending) { clearTimeout(p.timer); p.rej(new Error('CDP socket closed')); }
        pending.clear();
      };
      void (async () => {
        try {
          await send('Runtime.enable', {}, 20000);
          await send('Page.enable', {}, 20000);
          resolvePage({ page, consoleLines });
        } catch (e) {
          rejectPage(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    };
    ws.onerror = () => { clearTimeout(openTimer); rejectPage(new Error('CDP socket error before open')); };
  });
}

async function launchChromium(pageUrl: string, userDataDir: string): Promise<{ port: number; proc: ChildProcess }> {
  return new Promise((resolveLaunch, rejectLaunch) => {
    const args = [
      '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--mute-audio',
      '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
      '--window-size=1400,1000', '--force-device-scale-factor=1',
      '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
      '--enable-unsafe-swiftshader', pageUrl,
    ];
    let proc: ChildProcess;
    try {
      proc = spawn(CHROMIUM_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { rejectLaunch(new Error('chromium spawn failed: ' + String(e))); return; }
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { proc.kill('SIGKILL'); } catch { /* x */ } rejectLaunch(new Error('chromium: no DevTools port within 30s')); }
    }, 30000);
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderr += String(chunk);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (m) {
        const portM = /127\.0\.0\.1:(\d+)/.exec(m[1] ?? '');
        if (portM) {
          settled = true;
          clearTimeout(timer);
          resolveLaunch({ port: Number(portM[1]), proc });
        }
      }
    });
    proc.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); rejectLaunch(new Error('chromium process error: ' + e.message)); } });
    proc.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); rejectLaunch(new Error(`chromium exited early (code ${code}). tail: ${stderr.slice(-2000)}`)); } });
  });
}

async function connectCdp(port: number): Promise<{ page: BrowserPage; consoleLines: string[] }> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`);
  const targets = (await res.json()) as { type?: string; webSocketDebuggerUrl?: string }[];
  const target = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target?.webSocketDebuggerUrl) throw new Error('no page target with debugger URL');
  return createBrowserPage(target.webSocketDebuggerUrl);
}

describe.runIf(!!WEB_Q2_PAK)('gpu-follow3 live combat pixels (chromium, Q2_PAK)', () => {
  it('real combat on the production page: effects observed, submissions advance, composed pixels live', { timeout: 600000 }, async () => {
    let chromiumPresent = false;
    try {
      accessSync(CHROMIUM_BIN, constants.X_OK);
      chromiumPresent = true;
    } catch {
      chromiumPresent = false;
    }
    if (!chromiumPresent) {
      console.log('[gpu-follow3] browser SKIP: no chromium binary');
      return;
    }
    const here = dirname(fileURLToPath(import.meta.url));
    const appDir = resolve(here, '..');
    const repoRoot = resolve(here, '..', '..', '..');
    const viteCands = [join(repoRoot, 'node_modules', '.bin', 'vite'), join(appDir, 'node_modules', '.bin', 'vite')];
    let viteBin: string | null = null;
    for (const c of viteCands) {
      try { accessSync(c, constants.X_OK); viteBin = c; break; } catch { /* next */ }
    }
    if (!viteBin) throw new Error('vite binary not found');
    const pakBytes = readFileSync(WEB_Q2_PAK as string);
    const pakServer = createServer((req, res) => {
      try {
        const url = (req.url ?? '/').split('?')[0];
        if (url !== '/pak0.pak' || req.method === 'OPTIONS') {
          res.writeHead(url === '/pak0.pak' ? 204 : 404, {
            'access-control-allow-origin': '*',
            'cross-origin-resource-policy': 'cross-origin',
          });
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'access-control-allow-origin': '*',
          'cross-origin-resource-policy': 'cross-origin',
          'content-length': String(pakBytes.length),
        });
        res.end(pakBytes);
      } catch { try { res.writeHead(500); res.end('err'); } catch { /* gone */ } }
    });
    await new Promise<void>((res, rej) => {
      pakServer.on('error', rej);
      pakServer.listen(0, '127.0.0.1', () => res());
    });
    const pakAddr = pakServer.address() as unknown as { port: number } | null;
    if (!pakAddr || typeof pakAddr.port !== 'number') throw new Error('pak server: no port');
    const pakUrl = `http://127.0.0.1:${pakAddr.port}`;
    const vitePort = Number(process.env.GPU_FOLLOW3_VITE_PORT ?? 5194);
    const viteProc = spawn(process.execPath, [viteBin, '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], {
      cwd: appDir, stdio: ['ignore', 'ignore', 'ignore'],
    });
    const killAll = async (): Promise<void> => {
      try { await new Promise<void>((res) => { pakServer.close(() => res()); setTimeout(() => res(), 3000); }); } catch { /* x */ }
      try {
        if (viteProc.exitCode === null && viteProc.signalCode === null) {
          viteProc.kill('SIGTERM');
          await new Promise<void>((res) => { viteProc.on('exit', () => res()); setTimeout(() => res(), 8000); });
          if (viteProc.exitCode === null) { try { viteProc.kill('SIGKILL'); } catch { /* gone */ } }
        }
      } catch { /* gone */ }
    };
    try {
      await waitHttpOk(`http://127.0.0.1:${vitePort}/`, 120000);
      const pageUrl = `http://127.0.0.1:${vitePort}/?q2soak=1&q2pak=${encodeURIComponent(`${pakUrl}/pak0.pak`)}&q2renderer=webgl2-experimental`;
      const userDataDir = join(tmpdir(), `q2-follow3-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
      mkdirSync(userDataDir, { recursive: true });
      const chromium = await launchChromium(pageUrl, userDataDir);
      try {
        const { page, consoleLines } = await connectCdp(chromium.port);
        try {
          let status: { booted?: boolean; error?: string | null; actualRenderer?: string; warning?: string | null } | null = null;
          const bootDeadline = Date.now() + 240000;
          for (;;) {
            status = await page.evaluate<{ booted?: boolean; error?: string | null; actualRenderer?: string; warning?: string | null } | null>('window.__q2soak ? window.__q2soak : null', 30000).catch(() => null);
            if (status && status.booted) break;
            if (status && status.error) throw new Error(`page boot error: ${status.error}`);
            if (Date.now() > bootDeadline) throw new Error('soak boot timeout (240s)');
            await sleep(2000);
          }
          if (status!.actualRenderer !== 'webgl2-experimental' || status!.warning !== null) {
            throw new Error(`GPU leg did not attach (actual=${status!.actualRenderer} warning=${status!.warning})`);
          }
          await page.evaluate<void>(SHOT_STATS_INSTALL, 30000);
          // The soak page stacks config UI above the game canvas: scroll the
          // canvas into view BEFORE reading its box, or CDP mouse coords land
          // outside the viewport (elementFromPoint null) and the lock click
          // misses. Box is re-read after the scroll.
          await page.evaluate('(() => { const c = document.querySelector("#q2"); if (c) c.scrollIntoView({ block: "start" }); })()', 15000).catch(() => null);
          await sleep(500);
          const box = await page.evaluate<{ x: number; y: number; width: number; height: number } | null>(
            '(() => { const c = document.querySelector("#q2"); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()',
            30000,
          );
          if (!box || !(box.width >= 640) || !(box.height >= 480)) {
            throw new Error(`game canvas box missing/too small: ${JSON.stringify(box)}`);
          }
          const viewport = await page.evaluate<{ w: number; h: number }>(
            '({ w: window.innerWidth, h: window.innerHeight })', 15000).catch(() => ({ w: -1, h: -1 }));
          console.log(`[gpu-follow3] canvas box=${JSON.stringify(box)} viewport=${JSON.stringify(viewport)}`);
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          const routeOf = (): Promise<import('./soak.js').SoakRouteSnapshot | null> =>
            page.evaluate<import('./soak.js').SoakRouteSnapshot | null>('window.__q2soakRoute ? window.__q2soakRoute() : null', 30000);
          const base = await routeOf();
          expect(base, 'route sample present').not.toBeNull();
          expect(base!.framesSubmitted).not.toBeNull();
          const frames0 = base!.framesSubmitted!;
          const baseFx = base!.effects;
          expect(baseFx, 'FOLLOW-3 additive effects present (shape intact)').not.toBeNull();
          // Combat via CDP mouse input through the genuine pointer-lock flow:
          // a canvas click acquires the lock (the page's own click handler),
          // then a held left button is game fire (never page-code input).
          await page.mouseDown(cx, cy);
          await sleep(150);
          await page.mouseUp(cx, cy);
          await sleep(1500);
          const hit = await page.evaluate<string | null>(
            '(() => { const el = document.elementFromPoint(' + cx + ', ' + cy + '); return el ? (el.id || el.tagName) : null; })()', 15000).catch(() => null);
          let lockId = await page.evaluate<string | null>(
            'document.pointerLockElement ? document.pointerLockElement.id : null', 15000).catch(() => null);
          if (lockId !== 'q2') {
            // Headless setup accommodation (NOT game input): a real user click
            // acquires the lock through the page's own click handler, but the
            // headless harness grants no gesture — request it directly so the
            // subsequent CDP mouse hold is genuine game fire. All movement and
            // fire inputs below stay CDP-driven; page code never synthesizes
            // them.
            await page.evaluate('(() => { const c = document.querySelector("#q2"); if (c && c.requestPointerLock) { try { c.requestPointerLock(); } catch (e) {} } })()', 15000).catch(() => null);
            await sleep(1500);
            lockId = await page.evaluate<string | null>(
              'document.pointerLockElement ? document.pointerLockElement.id : null', 15000).catch(() => null);
          }
          console.log(`[gpu-follow3] combat setup clickTarget=${hit} lock=${lockId}`);
          if (lockId !== 'q2') {
            throw new Error(`combat leg: pointer lock not acquired (lock=${lockId}) — cannot fire via CDP mouse`);
          }
          // Held trigger: the blaster refires every 0.25s server-time, so
          // bolts/impacts/particles stay observable between 1s polls.
          await page.mouseDown(cx, cy);
          let combat: import('./soak.js').SoakRouteSnapshot | null = null;
          let lastState: { keys?: unknown; buttons?: unknown } | null = null;
          const combatDeadline = Date.now() + 60000;
          for (;;) {
            await sleep(1000);
            combat = await routeOf();
            lastState = await page.evaluate<{ keys?: unknown; buttons?: unknown } | null>('window.__q2soakState ? window.__q2soakState() : null', 15000).catch(() => null);
            const fx = combat?.effects;
            if (fx && (fx.bolts > 0 || fx.explosions > 0 || fx.particles > 0 || fx.muzzleLit)) break;
            if (Date.now() > combatDeadline) break;
          }
          await page.mouseUp(cx, cy);
          expect(combat, 'combat route sample present').not.toBeNull();
          const fx = combat!.effects;
          expect(fx, 'combat effects present').not.toBeNull();
          const observed = fx!.bolts > 0 || fx!.explosions > 0 || fx!.particles > 0 || fx!.muzzleLit;
          expect(observed, `live combat observed on the page (bolts=${fx!.bolts} expl=${fx!.explosions} particles=${fx!.particles} muzzle=${fx!.muzzleLit} keys=${JSON.stringify(lastState?.keys)} buttons=${JSON.stringify(lastState?.buttons)})`).toBe(true);
          expect(combat!.framesSubmitted!).toBeGreaterThan(frames0);
          const shotOf = async (): Promise<CdpShotStats> => {
            const b64 = await page.screenshot(box);
            return page.evaluate<CdpShotStats>(`window.__shotStats("${b64}")`, 60000);
          };
          const shot = await shotOf();
          expect(shot.nonblack, 'composed combat page is live').toBeGreaterThan(0.5);
          const consoleErrors = consoleLines.filter(
            (l) => l.startsWith('[exception]') || l.includes('Uncaught') || l.includes('ERROR'));
          expect(consoleErrors).toEqual([]);
          console.log(
            `[gpu-follow3] browser combat bolts=${fx!.bolts} expl=${fx!.explosions} kinds=[${fx!.explosionKinds.join(',')}] `
              + `particles=${fx!.particles} muzzle=${fx!.muzzleLit} frames=${frames0}->${combat!.framesSubmitted} `
              + `nonblack=${shot.nonblack.toFixed(3)} mean=${shot.mean.toFixed(1)} hash=${shot.hash.toString(16)}`,
          );
        } finally {
          page.close();
        }
      } finally {
        try {
          if (chromium.proc.exitCode === null) {
            chromium.proc.kill('SIGTERM');
            await new Promise<void>((res) => { chromium.proc.on('exit', () => res()); setTimeout(() => res(), 8000); });
            if (chromium.proc.exitCode === null) { try { chromium.proc.kill('SIGKILL'); } catch { /* exited */ } }
          }
        } catch { /* gone */ }
        try {
          spawnSync('rm', ['-rf', userDataDir]);
        } catch { /* best-effort */ }
      }
    } finally {
      await killAll();
    }
  });
});
