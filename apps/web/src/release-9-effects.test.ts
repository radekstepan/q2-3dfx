// RELEASE-9 apps/web effects presentation audit (boxes 1–3).
//
// Web-lane pumps under test: pumpMuzzleLight / pumpExplosionLights /
// pumpBoltLights / pumpTracers (play.ts), synthesizeBeamEntities /
// modelKindsForFrame (gpu-effects.ts), the TRACER_TTL_FRAMES /
// EXPLOSION_LIGHT_WINDOW / SPARK_TTL constants, the viewmodel/muzzle path
// (read-only here — muzzle parallax from web-m71/release-3b is INTENTIONAL
// and untouched), and the ambient target_splash replication.
//
// Ground truth is id Quake II C (../external/quake-2-source): client/cl_tent.c
// CL_AddExplosions (frame/oldframe/backlerp/alpha/lifetime), cl_fx.c
// CL_ParticleEffect / CL_ExplosionParticles / CL_BlasterParticles,
// game/g_target.c use_target_splash + SP_func_timer cadence, game/g_utils.c
// G_SetMovedir. Game-lane tables (@q2/game explosives.ts) carry the same C
// findings — the mapping tests below assert equality against them instead of
// re-stating C.
//
// Box verdicts are recorded in the RELEASE-9 lane report; this file pins the
// web-lane behavior with visible effect sequences (frame dumps/stats), plus
// missing-effect controls: every leg asserts the full producer → event →
// render/audio chain, so a removed link fails loudly.
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import type { UserCmdT } from '@q2/input';
import { AngleVectors, v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import { mulberry32 } from '@q2/game';
import type { Entity } from '@q2/renderer-api';
import type { ExtraRenderable } from '@q2/host';
import { parseMD2 } from '@q2/formats';
import {
  explosionAlpha,
  explosionBaseframe,
  explosionFrames as gameExplosionFrames,
  EXPLOSION_LIGHT,
  EXPLOSION_LIGHT_COLOR,
  EXPLOSION_SPARK_COUNT,
  BLASTER_SPARK_COUNT,
  SPARK_COLOR_BASE,
  spawnEdict,
} from '@q2/game';
import { SV_SetPlayerHealth, SV_UseMover, SV_UseTargetname, fireTargets } from '@q2/server';
import { setupCamera } from '@q2/sw-renderer';
import {
  buildEntityModel,
  buildProjectionMatrix,
  buildViewMatrix,
  multiplyMat4,
  transformPoint,
} from '@q2/webgl-renderer';
import {
  bootPlay,
  buildAsyncView,
  EXPLOSION_LIGHT_WINDOW,
  explosionFrames,
  explosionStepFor,
  pumpBoltLights,
  pumpExplosionLights,
  pumpMuzzleLight,
  pumpTracers,
  SPARK_TTL,
  SPLASH_COLORS,
  SPLASH_SPARKS,
  splashBurst,
  splashMovedir,
  TRACER_TTL_FRAMES,
} from './play.js';
import type { ExplosionKind, PlayBoot } from './play.js';
import {
  BLASTER_LIGHT_INTENSITY,
  BOOM_LIGHT_COLOR,
  BOOM_LIGHT_INTENSITY,
  BOLT_LIGHT_INTENSITY,
  MUZZLE_LIGHT_COLOR,
} from './gpu-effects.js';

const WEB_Q2_PAK = process.env.Q2_PAK;

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

function attackCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 1 };
}

function stepDriver(driver: { step(cmd: UserCmdT, dt: number): void }, cmd: UserCmdT, n: number): void {
  for (let i = 0; i < n; i++) driver.step(cmd, 0.1);
}

async function bootBase1(width = 96, height = 72): Promise<PlayBoot> {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  return bootPlay({ width, height, pak: ingestPak(buf) });
}

function yawAt(from: [number, number], to: [number, number]): number {
  return (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
}

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g['document'];
});

// --- stub DOM/GL (same proven shape as gpu-follow3.test.ts) -----------------

const GL_NUM = {
  NO_ERROR: 0, VERSION: 7937, VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632,
  COMPILE_STATUS: 35713, LINK_STATUS: 35714, ARRAY_BUFFER: 34962,
  ELEMENT_ARRAY_BUFFER: 34963, STATIC_DRAW: 35044, DYNAMIC_DRAW: 35048,
  TEXTURE_2D: 3553, TEXTURE0: 33984, RGBA: 6408, UNSIGNED_BYTE: 5121,
  UNSIGNED_INT: 5125, FLOAT: 5126, LINEAR: 9729, NEAREST: 9728,
  CLAMP_TO_EDGE: 33071, TEXTURE_MIN_FILTER: 10241, TEXTURE_MAG_FILTER: 10240,
  TEXTURE_WRAP_S: 10242, TEXTURE_WRAP_T: 10243, UNPACK_FLIP_Y_WEBGL: 37440,
  DEPTH_TEST: 2929, BLEND: 3042, LESS: 513, SRC_ALPHA: 770,
  ONE_MINUS_SRC_ALPHA: 771, COLOR_BUFFER_BIT: 16384, DEPTH_BUFFER_BIT: 256,
  TRIANGLES: 4, POINTS: 0, MAX_TEXTURE_SIZE: 3379, RENDERBUFFER: 36161,
  DEPTH_COMPONENT16: 33189, DEPTH_COMPONENT24: 33190, COLOR_ATTACHMENT0: 36064,
  DEPTH_ATTACHMENT: 36096, FRAMEBUFFER: 36160, FRAMEBUFFER_COMPLETE: 36053,
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

async function loadGpuBoot(width = 96, height = 72): Promise<PlayBoot> {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  setCVar('vid_renderer', 'webgl2-experimental');
  const boot = bootPlay({ width, height, pak: ingestPak(buf) });
  expect(boot.renderer).toBe('webgl2-experimental');
  expect(boot.gpu).not.toBeNull();
  expect(boot.source).toBe('pak');
  return boot;
}

// ---------------------------------------------------------------------------
// Box 1+2 shared: C-parity mapping of the explosion step (no pak).
// ---------------------------------------------------------------------------

describe('release-9 explosion step mapping = C CL_AddExplosions (no pak)', () => {
  it('frame/oldframe pairs step base+1/base over the C life (never a bare hold)', () => {
    // C: ent->frame = base+f+1, oldframe = base+f while f < frames-1.
    const cases: Array<{ kind: ExplosionKind; base: number; life: number }> = [
      { kind: 'explosion1', base: 0, life: 1.4 },
      { kind: 'explosion1', base: 15, life: 1.4 },
      { kind: 'explosion2', base: 30, life: 1.8 },
      { kind: 'blaster', base: 0, life: 0.3 },
    ];
    for (const { kind, base, life } of cases) {
      for (let t = 0; t < life; t += 0.1) {
        const s = explosionStepFor(kind, base, t + 1e-9);
        const f = Math.floor((t + 1e-9) / 0.1);
        expect(s.visible, `${kind}@${t.toFixed(1)} visible`).toBe(true);
        expect(s.frame, `${kind}@${t.toFixed(1)} frame`).toBe(base + f + 1);
        expect(s.oldframe, `${kind}@${t.toFixed(1)} oldframe`).toBe(base + f);
        expect(s.frame - s.oldframe).toBe(1);
        expect(s.oldframe).toBeGreaterThanOrEqual(base);
        expect(s.backlerp).toBeGreaterThanOrEqual(0);
        expect(s.backlerp).toBeLessThanOrEqual(1);
      }
      // One step past the C free point the visual is gone (no stuck flash).
      expect(explosionStepFor(kind, base, life).visible, `${kind} pruned`).toBe(false);
      expect(explosionStepFor(kind, base, life + 10).visible, `${kind} pruned+10s`).toBe(false);
      expect(explosionStepFor(kind, base, -0.05).visible, `${kind} negative age`).toBe(false);
    }
  });

  it('alpha follows the C fades (ex_poly (16-f)/16, ex_misc linear 1->0)', () => {
    // Grounded boom: full-strength first step, then the 16-frame decay.
    expect(explosionStepFor('explosion2', 30, 0.001).alpha).toBeCloseTo(1, 5);
    expect(explosionStepFor('explosion1', 0, 0.55).alpha).toBeCloseTo((16 - 5) / 16, 5);
    expect(explosionStepFor('explosion1', 15, 1.35).alpha).toBeCloseTo((16 - 13) / 16, 5);
    // Blaster: linear over its 3 live steps (frees at f>=3, never 0-hold).
    expect(explosionStepFor('blaster', 0, 0.001).alpha).toBeCloseTo(1, 2);
    expect(explosionStepFor('blaster', 0, 0.15).alpha).toBeCloseTo(1 - 1.5 / 3, 5);
    expect(explosionStepFor('blaster', 0, 0.25).alpha).toBeCloseTo(1 - 2.5 / 3, 5);
  });

  it('ex_poly skinnum cycles r_explode skin1..7 (f<10 f>>1, f<13 5, else 6)', () => {
    const got: number[] = [];
    for (let f = 0; f <= 13; f++) got.push(explosionStepFor('explosion1', 0, f * 0.1 + 0.001).skinnum);
    expect(got).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5, 6]);
    expect(explosionStepFor('blaster', 0, 0.05).skinnum).toBe(0);
  });

  it('matches the game lane C tables (frames, alpha, light, colors)', () => {
    // Same frame budgets the sim prunes by (single-sim rule: one C table).
    for (const kind of ['explosion1', 'explosion2', 'blaster'] as const) {
      expect(explosionFrames(kind)).toBe(gameExplosionFrames(kind));
    }
    // Same alpha decay (game helper takes fractional f for the blaster path).
    for (const age of [0.001, 0.05, 0.15, 0.25, 0.55, 1.35]) {
      for (const [kind, base] of [['explosion1', 0], ['explosion1', 15], ['blaster', 0]] as const) {
        const s = explosionStepFor(kind, base, age);
        if (!s.visible) continue;
        const f = kind === 'blaster' ? age / 0.1 : Math.floor(age / 0.1);
        expect(s.alpha, `${kind}@${age}`).toBeCloseTo(explosionAlpha(kind, f), 9);
      }
    }
    // Same dlight mapping the pumps submit (C cl_tent.c light/lightcolor).
    expect(EXPLOSION_LIGHT['explosion1']).toBe(BOOM_LIGHT_INTENSITY);
    expect(EXPLOSION_LIGHT['explosion2']).toBe(BOOM_LIGHT_INTENSITY);
    expect(EXPLOSION_LIGHT['blaster']).toBe(BLASTER_LIGHT_INTENSITY);
    expect([...EXPLOSION_LIGHT_COLOR['explosion1']]).toEqual([...BOOM_LIGHT_COLOR]);
    expect([...EXPLOSION_LIGHT_COLOR['blaster']]).toEqual([...MUZZLE_LIGHT_COLOR]);
    expect(BOLT_LIGHT_INTENSITY).toBe(200);
    expect(MUZZLE_LIGHT_COLOR).toEqual([1, 1, 0]);
    // Same burst budgets the server replicates (cl_fx.c counts + 0xe0 base).
    expect(BLASTER_SPARK_COUNT).toBe(40);
    expect(EXPLOSION_SPARK_COUNT).toBe(256);
    expect(SPARK_COLOR_BASE).toBe(0xe0);
  });

  it('splash helpers match C (G_SetMovedir angles, CL_ParticleEffect spread)', () => {
    expect([...splashMovedir(-1)]).toEqual([0, 0, 1]);
    expect([...splashMovedir(-2)]).toEqual([0, 0, -1]);
    expect([...splashMovedir(0)].map((v) => Math.round(v) + 0)).toEqual([1, 0, 0]);
    expect([...splashMovedir(90)].map((v) => Math.round(v) + 0)).toEqual([0, 1, 0]);
    const rand = mulberry32(7);
    const burst = splashBurst(rand, v3(0, 0, 0), v3(0, 0, 1), 32, 0xe0);
    expect(burst).toHaveLength(32);
    for (const sp of burst) {
      expect(sp.color).toBeGreaterThanOrEqual(0xe0);
      expect(sp.color).toBeLessThanOrEqual(0xe7);
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(sp.vel[k]!)).toBeLessThanOrEqual(20);
      }
      expect(sp.ttl).toBeGreaterThanOrEqual(0.5);
      expect(sp.ttl).toBeLessThanOrEqual(0.8);
      // C org spread: ((rand&7)-4) per axis + d*dir with d in [0,31].
      expect(Math.abs(sp.pos[0]!)).toBeLessThanOrEqual(4);
      expect(Math.abs(sp.pos[1]!)).toBeLessThanOrEqual(4);
      expect(sp.pos[2]!).toBeGreaterThanOrEqual(-4);
      expect(sp.pos[2]!).toBeLessThanOrEqual(35);
    }
    expect(SPLASH_COLORS[SPLASH_SPARKS]).toBe(0xe0);
  });

  it('ballistic + static sparks expire on their ttl; world-seeded never do', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    // Devroom ships static torch-flame particles (born +Infinity): the
    // baseline the sweep must preserve.
    const baseline = driver.mini.particles.length;
    expect(baseline).toBeGreaterThan(0);
    // Fire once: trail sparks (0.4s) + impact burst (0.4s) pool on top.
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: 1 }, 0.1);
    for (let i = 0; i < 10 && driver.bolts.length > 0; i++) driver.step(neutralCmd(), 0.1);
    expect(driver.mini.particles.length).toBeGreaterThan(baseline);
    // Settle 2s: every driver-pushed spark expires, the seeded flames stay.
    stepDriver(driver, neutralCmd(), 20);
    expect(driver.mini.particles.length).toBe(baseline);
  });

  it('missing-effect controls: no models = no explosion submit; aged = silent', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    // Devroom ships no pak models: explosions cannot submit (documents the
    // models requirement — an absent render link submits nothing, silently).
    driver.server.explosions.push({
      pos: v3(10, 20, 30), born: driver.server.time, kind: 'explosion1', baseframe: 0, yaw: 0,
    });
    expect(driver.extraEntities()).toBeNull();
    // With models the SAME explosion submits (fails if the producer link
    // between server.explosions and extraEntities is ever removed).
    (driver as unknown as { models: unknown }).models = {
      monster: 0, monsterSkin: 0, soldierLightSkin: 0, soldierSsSkin: 0,
      gunner: 0, gunnerSkin: 0, weapons: {}, weaponSkins: {},
      bolt: 0, boltSkin: 0, barrel: 0, barrelSkin: 0,
      explode: 7, explodeSkin: 8, explodeSkins: [11, 12, 13, 14, 15, 16], blast: 9, blastSkin: 10,
      debris1: 0, debris1Skin: 0, debris2: 0, debris2Skin: 0, debris3: 0, debris3Skin: 0,
      gibMeat: 0, gibMeatSkin: 0, gibChest: 0, gibChestSkin: 0,
      gibBone: 0, gibBoneSkin: 0, gibHead: 0, gibHeadSkin: 0,
      items: {}, ship: -1, shipSkin: 0, banner: -1, bannerSkin: 0, skins: [],
    };
    const submitted = driver.extraEntities()!.find((x) => x.model === 7);
    expect(submitted, 'explosion submits once models exist').toBeDefined();
    expect(submitted!.frame).toBe(1);
    // Aged out: no submit, no light (fails if the prune link is removed and
    // flashes stick).
    driver.server.time += 10;
    expect((driver.extraEntities() ?? []).filter((x) => x.model === 7)).toHaveLength(0);
    expect(driver.drainExplosions()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Box 1: barrel explosion frame sequence on Software (real base1 + real ticks).
// ---------------------------------------------------------------------------

describe.runIf(!!WEB_Q2_PAK)('release-9 barrel explosion sequence (Q2_PAK, software)', () => {
  it('full boom: C frames/skins/alpha, 256-burst, debris, boom light+sound, clean prune', { timeout: 180000 }, async () => {
    const boot = await bootBase1(96, 72);
    const { driver } = boot;
    const models = boot.models!;
    // Spawn-room explobox pair (base1-gate (a) pattern): stand 80u south,
    // bead level, fire until a barrel leaves the submitted set.
    const spawnBarrels = driver.barrels.filter(
      (b) => !b.isFunc && Math.hypot(b.origin[0]! - 128, b.origin[1]! + 320) < 400,
    );
    expect(spawnBarrels.length).toBe(2);
    const barrelSubmitted = (tx: number, ty: number): boolean =>
      (driver.extraEntities() ?? []).some(
        (x) => x.model === models.barrel && Math.hypot(x.origin![0]! - tx, x.origin![1]! - ty) < 1,
      );
    const target = spawnBarrels[0]!;
    const tx = target.origin[0]!;
    const ty = target.origin[1]!;
    driver.pm.origin = v3(tx, ty - 80, 40);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 5);
    const yaw = yawAt([driver.pm.origin[0]!, driver.pm.origin[1]!], [tx, ty]);
    let ticks = 0;
    while (barrelSubmitted(tx, ty) && ticks++ < 120) {
      if (ticks % 20 === 0) SV_SetPlayerHealth(driver.server, 100);
      driver.step(attackCmd([0, yaw, 0]), 0.1);
    }
    expect(barrelSubmitted(tx, ty)).toBe(false);
    // The 0.2s fuse blows on server time: capture the live explosion record.
    stepDriver(driver, neutralCmd(), 5);
    expect(driver.events).toContain('explosion');
    expect(driver.events).toContain('barrel');
    // Particles: the 256-count ballistic burst is pooled right after the
    // boom (checked before the ttl expires — fails if the server spark →
    // driver pool link is absent).
    const yellow = driver.mini.particles.filter(
      (p) => (p as { color: number }).color >= 0xe0 && (p as { color: number }).color <= 0xe7,
    );
    expect(yellow.length).toBeGreaterThanOrEqual(200);
    const live = driver.explosions.find((e) => e.kind !== 'blaster');
    expect(live, 'a big-boom explosion is live').toBeDefined();
    const kind = live!.kind;
    const base = live!.baseframe;
    expect(base === 0 || base === 15 || base === 30).toBe(true);

    // Consecutive-tick frame dump of ONE boom (nearest to the first live
    // record): C pairs base+f+1/base+f, frac lerp, (16-f)/16 alpha, skinnum
    // cycle — captured while RENDERED, not counted. The C tail (f=16,17 at
    // alpha<=0) is emitted and skipped by the renderer's alpha<=0 rule, so
    // the dump allows a flat zero tail.
    const dump: Array<{ frame: number; oldframe: number; backlerp: number; alpha: number; skin: number }> = [];
    const ax = live!.pos[0]!, ay = live!.pos[1]!;
    for (let i = 0; i < 22; i++) {
      const recs = (driver.extraEntities() ?? []).filter(
        (x) => x.model === models.explode && Math.hypot(x.origin![0]! - ax, x.origin![1]! - ay) < 64,
      );
      recs.sort(
        (a, b) =>
          Math.hypot(a.origin![0]! - ax, a.origin![1]! - ay) -
          Math.hypot(b.origin![0]! - ax, b.origin![1]! - ay),
      );
      const rec = recs[0];
      if (rec) {
        dump.push({ frame: rec.frame!, oldframe: rec.oldframe!, backlerp: rec.backlerp!, alpha: rec.alpha!, skin: rec.skin! });
      }
      driver.step(neutralCmd(), 0.1);
    }
    expect(dump.length).toBeGreaterThanOrEqual(10);
    expect(dump.length).toBeLessThanOrEqual(19);
    // Sequence shape: consecutive C pairs, lerp pinned at the tick grid,
    // alpha non-increasing (flat zero tail), skins cycling past skin1.
    for (let i = 1; i < dump.length; i++) {
      expect(dump[i]!.frame - dump[i - 1]!.frame).toBe(1);
      expect(dump[i]!.frame - dump[i]!.oldframe!).toBe(1);
      expect(dump[i]!.alpha).toBeLessThanOrEqual(dump[i - 1]!.alpha);
      expect(dump[i]!.backlerp).toBeCloseTo(0, 5);
    }
    expect(dump.slice(0, 10).some((d, i, a) => i > 0 && a[i]!.alpha < a[i - 1]!.alpha)).toBe(true);
    expect(dump[0]!.frame).toBeGreaterThanOrEqual(base + 1);
    expect(dump[0]!.oldframe).toBe(dump[0]!.frame - 1);
    const skins = new Set(dump.map((d) => d.skin));
    expect(skins.size).toBeGreaterThan(1);
    for (const s of skins) {
      expect([models.explodeSkin, ...models.explodeSkins]).toContain(s);
    }
    console.log(
      `[release-9] boom kind=${kind} base=${base} steps=${dump.length} ` +
      `frames=${dump[0]!.frame}..${dump[dump.length - 1]!.frame} ` +
      `alpha=${dump[0]!.alpha.toFixed(3)}..${dump[dump.length - 1]!.alpha.toFixed(3)} skins=${skins.size}`,
    );

    // Debris renders as its own MD2s (fails if the debris render link dies).
    const debrisModels = new Set([models.debris1, models.debris2, models.debris3]);
    const extras = driver.extraEntities() ?? [];
    expect(extras.filter((x) => debrisModels.has(x.model as number)).length).toBeGreaterThan(0);

    // Audio: the C TE boom sound (rocklx1a for explosion1, grenlx1a for
    // grounded explosion2 — the server lane carries the C registrations).
    // Missing-sound control: heardSounds is the single audio proof — an
    // absent server sound drain fails here.
    expect(driver.heardSounds).toContain(
      kind === 'explosion2' ? 'weapons/grenlx1a.wav' : 'weapons/rocklx1a.wav',
    );

    // Light: boom dlight pumped with the C color/scale (fails if the
    // drain→pump link is removed). Fresh boom for a live (not aged) sample.
    driver.server.explosions.push({
      pos: v3(live!.pos[0], live!.pos[1], live!.pos[2]),
      born: driver.server.time, kind, baseframe: base, yaw: 0,
    });
    const flashes = driver.drainExplosions();
    expect(flashes.length).toBeGreaterThan(0);
    expect(pumpExplosionLights(boot)).toBeGreaterThan(0);
    const after: unknown[] = [];
    const origAdd = (boot.refresh as unknown as { testAddDynamicLight(l: unknown): void }).testAddDynamicLight.bind(boot.refresh);
    (boot.refresh as unknown as { testAddDynamicLight(l: unknown): void }).testAddDynamicLight = (l: unknown): void => {
      after.push(l);
      origAdd(l);
    };
    driver.server.explosions.push({
      pos: v3(live!.pos[0], live!.pos[1], live!.pos[2]),
      born: driver.server.time, kind, baseframe: base, yaw: 0,
    });
    driver.drainExplosions();
    pumpExplosionLights(boot);
    expect(after.length).toBeGreaterThan(0);
    for (const l of after as Array<{ intensity: number; color: Float32Array }>) {
      expect(l.intensity).toBeGreaterThan(0);
      expect(l.intensity).toBeLessThanOrEqual(350);
      expect([...l.color]).toEqual([1, 0.5, 0.5]);
    }

    // Prune control: after the full life nothing submits and nothing lights
    // (fails if explosions stick — the "fuller by enlarging" temptation
    // would also fail the size legs below, which pin real art scale).
    // Settle to quiescence (cap 90 ticks ≈ 9s): barrel fuse delays (C 0.2s
    // DelayedUse) plus radius chain-detonation (E1: one hit → two booms) can
    // legally start new lives mid-settle; a stuck explosion never drains and
    // still fails the length assert below.
    for (let i = 0; i < 90 && driver.drainExplosions().length > 0; i++) {
      stepDriver(driver, neutralCmd(), 1);
    }
    expect(driver.drainExplosions()).toHaveLength(0);
    expect(pumpExplosionLights(boot)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Box 2: blaster wall-impact projected size (both renderers, pitched hits).
// ---------------------------------------------------------------------------

/** Project explode-frame verts through the CPU camera → pixel bbox area. */
function cpuBboxArea(
  verts: Float32Array,
  origin: [number, number, number],
  yawDeg: number,
  eye: [number, number, number],
  camAngles: [number, number, number],
  fovX: number,
  w: number,
  h: number,
): number {
  const cam = setupCamera(
    new Float32Array(eye), new Float32Array(camAngles), fovX, w, h,
  );
  const yawR = (yawDeg * Math.PI) / 180;
  const cy = Math.cos(yawR), sy = Math.sin(yawR);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    // Entity basis at pitch=roll=0 (yaw-only, the submitted orientation).
    const lx = verts[i]!, ly = verts[i + 1]!, lz = verts[i + 2]!;
    const wx = origin[0] + lx * cy - ly * sy;
    const wy = origin[1] + lx * sy + ly * cy;
    const wz = origin[2] + lz;
    const vx = wx - cam.origin[0]!, vy = wy - cam.origin[1]!, vz = wz - cam.origin[2]!;
    const z = vx * cam.forward[0]! + vy * cam.forward[1]! + vz * cam.forward[2]!;
    if (z <= cam.near) return NaN;
    const x = vx * cam.right[0]! + vy * cam.right[1]! + vz * cam.right[2]!;
    const y = vx * cam.up[0]! + vy * cam.up[1]! + vz * cam.up[2]!;
    const sx = cam.xCenter + (x * cam.focalX) / z;
    const sy2 = cam.yCenter - (y * cam.focalY) / z;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy2 < minY) minY = sy2;
    if (sy2 > maxY) maxY = sy2;
  }
  // Continuous extents (no +1 raster padding: padding breaks the 1/d²
  // ratio once the flash spans a few pixels — the raster proof below pins
  // actual pixels separately).
  return (maxX - minX) * (maxY - minY);
}

/** Project explode-frame verts through the GPU matrices → pixel bbox area. */
function gpuBboxArea(
  verts: Float32Array,
  origin: [number, number, number],
  yawDeg: number,
  eye: [number, number, number],
  camAngles: [number, number, number],
  fovX: number,
  w: number,
  h: number,
): number {
  const fwd = new Float32Array(3), right = new Float32Array(3), up = new Float32Array(3);
  AngleVectors(new Float32Array(camAngles), fwd, right, up);
  const V = buildViewMatrix(new Float32Array(eye), fwd, right, up);
  const P = buildProjectionMatrix(fovX, w, h);
  const M = buildEntityModel(new Float32Array(origin), new Float32Array([0, yawDeg, 0]));
  const MVP = multiplyMat4(P, multiplyMat4(V, M));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    const [nx, ny] = transformPoint(MVP, verts[i]!, verts[i + 1]!, verts[i + 2]!);
    const sx = (nx * 0.5 + 0.5) * w;
    const sy2 = (0.5 - ny * 0.5) * h;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy2 < minY) minY = sy2;
    if (sy2 > maxY) maxY = sy2;
  }
  // Continuous extents (see cpuBboxArea: no raster padding in the ratio).
  return (maxX - minX) * (maxY - minY);
}

describe.runIf(!!WEB_Q2_PAK)('release-9 blaster impact size + pitched hits (Q2_PAK)', () => {
  it('wall impact: flash entity/light/sparks at the surface, size scales 1/d^2 + FOV on both renderers', { timeout: 180000 }, async () => {
    const boot = await bootBase1(96, 72);
    const { driver } = boot;
    const models = boot.models!;
    // Level bead from spawn: the wall ~100u out (gpu-follow3 live pattern).
    // Record the eye so the pixel camera below sights back along the bolt's
    // proven-open flight path (an arbitrary offset can sit inside rock).
    const eye0: [number, number, number] = [
      driver.pm.origin[0]!,
      driver.pm.origin[1]!,
      driver.pm.origin[2]! + driver.pm.viewheight,
    ];
    driver.step({ ...neutralCmd(), buttons: 1 }, 0.1);
    expect(driver.events).toContain('bolt');
    let impactTick = -1;
    for (let i = 0; i < 60 && impactTick < 0; i++) {
      if (i % 20 === 0) SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
      if (driver.explosions.some((e) => e.kind === 'blaster')) impactTick = i;
    }
    expect(impactTick).toBeGreaterThanOrEqual(0);
    const boom = driver.explosions.find((e) => e.kind === 'blaster')!;
    // Position: at the surface the bolt died on (fails if the explosion is
    // displaced from the impact — the "enlarging" temptation starts here).
    expect(boom.pos[2]!).toBeGreaterThan(-100);
    // Rendered as the C ex_misc model with the pair/lerp/alpha mapping.
    const rec = (driver.extraEntities() ?? []).find((x) => x.model === models.blast);
    expect(rec, 'blaster flash submits the explode MD2').toBeDefined();
    expect(rec!.skin).toBe(models.blastSkin);
    expect(rec!.frame! - rec!.oldframe!).toBe(1);
    expect(rec!.alpha!).toBeGreaterThan(0);
    expect(rec!.alpha!).toBeLessThanOrEqual(1);
    // Light + audio links (fail if the drain→pump or sound-drain link dies).
    const flashes = driver.drainExplosions().filter((f) => f.kind === 'blaster');
    expect(flashes.length).toBeGreaterThan(0);
    expect(pumpExplosionLights(boot)).toBeGreaterThan(0);
    driver.server.explosions.push({
      pos: v3(boom.pos[0], boom.pos[1], boom.pos[2]), born: driver.server.time, kind: 'blaster', baseframe: 0, yaw: 0,
    });
    const seen: Array<{ intensity: number; color: Float32Array }> = [];
    const refresh = boot.refresh as unknown as { testAddDynamicLight(l: unknown): void };
    const origAdd = refresh.testAddDynamicLight.bind(boot.refresh);
    refresh.testAddDynamicLight = (l: unknown): void => {
      seen.push(l as { intensity: number; color: Float32Array });
      origAdd(l);
    };
    driver.drainExplosions();
    pumpExplosionLights(boot);
    const touch = seen.filter((l) => l.color[0] === 1 && l.color[1] === 1 && l.color[2] === 0 && l.intensity <= 150);
    expect(touch.length, '150-scaled yellow touch light pumped').toBeGreaterThan(0);
    expect(driver.heardSounds).toContain('weapons/lashit.wav');
    expect(driver.mini.particles.length).toBeGreaterThanOrEqual(40);

    // Projected size: real explode art (frame 1, the first shown) through
    // the production matrices of BOTH renderers, same entity pose.
    const { readPakEntry } = await import('./pak.js');
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const pak = ingestPak(buf);
    const md2 = parseMD2(readPakEntry(pak, 'models/objects/explode/tris.md2'));
    expect(md2.numFrames).toBeGreaterThanOrEqual(4);
    const nv = md2.numVerts;
    const frame1 = (md2.frames as Float32Array).subarray(nv * 3, nv * 6);
    const origin: [number, number, number] = [boom.pos[0]!, boom.pos[1]!, boom.pos[2]!];
    // 640x480 for the projection math (the flash spans several pixels at
    // every leg distance, so quantization noise stays out of the ratios).
    const W = 640, H = 480;
    const eyeFor = (d: number): [number, number, number] => [origin[0] - d, origin[1], origin[2]];
    // Distance scaling ≈ 1/d² on both renderers (perspective, no fixed-size sprites).
    for (const [d0, d1, want] of [[150, 300, 4], [300, 600, 4]] as const) {
      const c0 = cpuBboxArea(frame1, origin, 0, eyeFor(d0), [0, 0, 0], 90, W, H);
      const c1 = cpuBboxArea(frame1, origin, 0, eyeFor(d1), [0, 0, 0], 90, W, H);
      expect(c1).toBeGreaterThan(0);
      expect(c0 / c1, `cpu area ${d0}->${d1}`).toBeGreaterThan(want * 0.85);
      expect(c0 / c1, `cpu area ${d0}->${d1}`).toBeLessThan(want * 1.15);
      const g0 = gpuBboxArea(frame1, origin, 0, eyeFor(d0), [0, 0, 0], 90, W, H);
      const g1 = gpuBboxArea(frame1, origin, 0, eyeFor(d1), [0, 0, 0], 90, W, H);
      expect(g0 / g1, `gpu area ${d0}->${d1}`).toBeGreaterThan(want * 0.85);
      expect(g0 / g1, `gpu area ${d0}->${d1}`).toBeLessThan(want * 1.15);
      // CPU and GPU projections agree (same geometry feeds both backends).
      expect(g0 / c0, `cpu/gpu agree @${d0}`).toBeGreaterThan(0.95);
      expect(g0 / c0, `cpu/gpu agree @${d0}`).toBeLessThan(1.05);
    }
    // FOV scaling ≈ (tan(fov0/2)/tan(fov1/2))² = 1/9 for 60→120 (wider
    // FOV squeezes: focal shrinks, so the same flash covers fewer pixels).
    const fa60 = cpuBboxArea(frame1, origin, 0, eyeFor(300), [0, 0, 0], 60, W, H);
    const fa120 = cpuBboxArea(frame1, origin, 0, eyeFor(300), [0, 0, 0], 120, W, H);
    expect(fa120 / fa60).toBeGreaterThan((1 / 9) * 0.85);
    expect(fa120 / fa60).toBeLessThan((1 / 9) * 1.15);
    const ga120 = gpuBboxArea(frame1, origin, 0, eyeFor(300), [0, 0, 0], 120, W, H);
    expect(ga120 / fa120).toBeGreaterThan(0.95);
    expect(ga120 / fa120).toBeLessThan(1.05);
    // Pitched cameras (the ex_misc orientation gap is yaw-only until the
    // server ships the impact dir — size must stay sane, never collapse).
    const level = cpuBboxArea(frame1, origin, 0, eyeFor(300), [0, 0, 0], 90, W, H);
    for (const pitch of [20, -20] as const) {
      const pitched = cpuBboxArea(frame1, origin, 0, eyeFor(300), [pitch, 0, 0], 90, W, H);
      expect(pitched / level, `pitched ${pitch}`).toBeGreaterThan(0.5);
      expect(pitched / level, `pitched ${pitch}`).toBeLessThan(2);
      const gp = gpuBboxArea(frame1, origin, 0, eyeFor(300), [pitch, 0, 0], 90, W, H);
      expect(gp / pitched).toBeGreaterThan(0.95);
      expect(gp / pitched).toBeLessThan(1.05);
    }
    console.log(
      `[release-9] blaster area150=${cpuBboxArea(frame1, origin, 0, eyeFor(150), [0, 0, 0], 90, W, H).toFixed(1)}px ` +
      `area300=${cpuBboxArea(frame1, origin, 0, eyeFor(300), [0, 0, 0], 90, W, H).toFixed(1)}px ` +
      `area600=${cpuBboxArea(frame1, origin, 0, eyeFor(600), [0, 0, 0], 90, W, H).toFixed(1)}px (640x480 fov90)`,
    );

    // Software pixels: the submitted flash draws inside its projected bbox
    // (fails if the entity never rasterises — real raster proof, not counts).
    driver.server.explosions.push({
      pos: v3(boom.pos[0], boom.pos[1], boom.pos[2]), born: driver.server.time, kind: 'blaster', baseframe: 0, yaw: 0,
    });
    const toEntity = (x: ExtraRenderable): Entity => ({
      model: x.model as number,
      origin: new Float32Array(x.origin as number[]),
      angles: new Float32Array((x.angles ?? [0, 0, 0]) as number[]),
      frame: x.frame as number,
      skin: x.skin as number,
      ...(x.oldframe !== undefined ? { oldframe: x.oldframe as number } : {}),
      ...(x.backlerp !== undefined ? { backlerp: x.backlerp as number } : {}),
      ...(x.alpha !== undefined ? { alpha: x.alpha as number } : {}),
    });
    const blastOnly = (driver.extraEntities() ?? [])
      .filter((x) => x.model === models.blast)
      .map(toEntity);
    expect(blastOnly.length).toBeGreaterThan(0);
    // Sight back along the bolt's flight path (guaranteed open — the bolt
    // just flew it): eye 150u out from the impact toward the muzzle.
    const blen =
      Math.hypot(boom.pos[0]! - eye0[0], boom.pos[1]! - eye0[1], boom.pos[2]! - eye0[2]) || 1;
    const bdir: [number, number, number] = [
      (boom.pos[0]! - eye0[0]) / blen,
      (boom.pos[1]! - eye0[1]) / blen,
      (boom.pos[2]! - eye0[2]) / blen,
    ];
    const eye: [number, number, number] = [
      boom.pos[0]! - bdir[0] * 150,
      boom.pos[1]! - bdir[1] * 150,
      boom.pos[2]! - bdir[2] * 150,
    ];
    const yaw = (Math.atan2(bdir[1], bdir[0]) * 180) / Math.PI;
    const pitch = (-Math.asin(Math.max(-1, Math.min(1, bdir[2]))) * 180) / Math.PI;
    const view = {
      origin: new Float32Array(eye),
      angles: new Float32Array([pitch, yaw, 0]),
      fovX: 90,
      time: driver.server.time,
      lightStyles: new Float32Array(256).fill(1),
    };
    boot.refresh.beginFrame();
    boot.refresh.renderView(view, boot.host.world, []);
    boot.refresh.endFrame();
    const base = Array.from(boot.refresh.getFramebuffer().color);
    boot.refresh.beginFrame();
    boot.refresh.renderView(view, boot.host.world, blastOnly);
    boot.refresh.endFrame();
    const shot = Array.from(boot.refresh.getFramebuffer().color);
    let diff = 0;
    for (let i = 0; i < base.length; i++) {
      if (base[i] !== shot[i]) diff++;
    }
    expect(diff, 'flash rasterises pixels on software').toBeGreaterThan(10);
  });

  it('pitched shots explode at the surface with light + sparks (orientation gap documented)', { timeout: 180000 }, async () => {
    const boot = await bootBase1(96, 72);
    const { driver } = boot;
    // Steep downward bead: the bolt meets the floor, not a wall.
    const eyeZ = driver.pm.origin[2]! + driver.pm.viewheight;
    driver.step({ ...neutralCmd([30, 0, 0]), buttons: 1 }, 0.1);
    expect(driver.events).toContain('bolt');
    let impactTick = -1;
    for (let i = 0; i < 60 && impactTick < 0; i++) {
      if (i % 20 === 0) SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd([30, 0, 0]), 0.1);
      if (driver.explosions.some((e) => e.kind === 'blaster')) impactTick = i;
    }
    expect(impactTick, 'pitched bolt impacts the floor').toBeGreaterThanOrEqual(0);
    const boom = driver.explosions.find((e) => e.kind === 'blaster')!;
    expect(boom.pos[2]!, 'impact below the eye').toBeLessThan(eyeZ);
    // Full chain fires for pitched hits: entity + light + sound + sparks.
    expect((driver.extraEntities() ?? []).some((x) => x.model === boot.models!.blast)).toBe(true);
    expect(driver.drainExplosions().filter((f) => f.kind === 'blaster').length).toBeGreaterThan(0);
    expect(driver.heardSounds).toContain('weapons/lashit.wav');
    expect(driver.mini.particles.length).toBeGreaterThanOrEqual(40);
    // KNOWN GAP (server lane): ex_misc orients pitch+yaw from the impact
    // dir (cl_tent.c acos/atan2), but ServerExplosion carries no dir, so the
    // web lane submits yaw-only ([0, yaw, 0] — the server's random yaw).
    // Size legs above prove the flash stays sane pitched; orientation itself
    // needs ServerExplosion.dir (server TODO, not worked around here).
    const rec = (driver.extraEntities() ?? []).find((x) => x.model === boot.models!.blast);
    if (rec) expect(rec.angles![0]).toBe(0);
  });

  it('gpu submission carries the identical blast geometry (no renderer-side enlargement)', { timeout: 180000 }, async () => {
    installStubDoc();
    const boot = await loadGpuBoot();
    const { driver } = boot;
    const { frameGpuPlay } = await import('./play.js');
    driver.step({ ...neutralCmd(), buttons: 1 }, 0.1);
    expect(driver.events).toContain('bolt');
    let now = 0;
    let impactFrame = -1;
    const submitted: Entity[][] = [];
    const innerEntities = boot.gpu!.gpu.setEntities.bind(boot.gpu!.gpu);
    boot.gpu!.gpu.setEntities = ((entities: Entity[], kinds): void => {
      submitted.push([...entities]);
      innerEntities(entities, kinds);
    }) as typeof innerEntities;
    for (let i = 0; i < 60 && impactFrame < 0; i++) {
      if (i % 20 === 0) SV_SetPlayerHealth(driver.server, 100);
      now += 16;
      frameGpuPlay(boot, now);
      if (driver.explosions.some((e) => e.kind === 'blaster')) impactFrame = i;
    }
    expect(impactFrame).toBeGreaterThanOrEqual(0);
    // The NEXT frame's drain submits the flash (tick order: sim runs after
    // the frame's drains — gpu-follow3 pins this).
    now += 16;
    frameGpuPlay(boot, now);
    const blastHandle = boot.models!.blast;
    const last = submitted[submitted.length - 1]!;
    const gpuBlast = last.find((e) => e.model === blastHandle);
    expect(gpuBlast, 'gpu frame submits the blast MD2').toBeDefined();
    const cpuBlast = (driver.extraEntities() ?? []).find((x) => x.model === blastHandle);
    // Same driver tick may have aged the CPU record past the submitted
    // frame: compare shape + ranges, not tick-exact floats.
    expect(gpuBlast!.frame).toBeGreaterThanOrEqual(1);
    expect(gpuBlast!.frame! - gpuBlast!.oldframe!).toBe(1);
    expect(gpuBlast!.skin).toBe(boot.models!.blastSkin);
    expect(gpuBlast!.alpha!).toBeGreaterThan(0);
    expect(gpuBlast!.alpha!).toBeLessThanOrEqual(1);
    if (cpuBlast) {
      expect(Math.abs(gpuBlast!.frame! - cpuBlast.frame!)).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Box 3: door sparks — map truth + ambient timer chain + destruction proof.
// ---------------------------------------------------------------------------

describe.runIf(!!WEB_Q2_PAK)('release-9 door sparks (Q2_PAK)', () => {
  it('map truth: splash is ambient timer-driven; door chains carry no splash', { timeout: 60000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // 12 target_splash emitters; every START_ON func_timer in the map is
    // indexed (27), of which 11 drive a splash targetname (t1 shares one
    // timer for its pair; the rest drive doors, relays and speakers).
    expect(driver.ambientSplashSources()).toBe(12);
    expect(driver.ambientSplashTimers()).toBe(27);
    const splashTargets = new Set(
      driver.server.entities.filter((e) => e.classname === 'target_splash').map((e) => e.targetname),
    );
    const splashTimers = driver.server.entities.filter(
      (e) => e.classname === 'func_timer' && (e.spawnflags & 1) !== 0 && splashTargets.has(e.target),
    );
    expect(splashTimers.length).toBe(11);
    const byClass = (c: string): Array<{ targetname: string; target: string; model: string }> =>
      driver.server.entities.filter((e) => e.classname === c && !e.freed)
        .map((e) => ({ targetname: e.targetname, target: e.target, model: e.model }));
    // First blasted door (*19, target t69) and glass (*20, target t78):
    expect(byClass('func_door').find((d) => d.model === '*19')?.target).toBe('t69');
    expect(byClass('func_explosive').find((d) => d.model === '*20')?.target).toBe('t78');
    // Their targets are an areaportal and a glass-break speaker — no splash.
    const t69 = driver.server.entities.find((e) => e.targetname === 't69' && e.classname !== 'func_door');
    const t78 = driver.server.entities.find((e) => e.targetname === 't78' && e.classname !== 'func_explosive');
    expect(t69?.classname).toBe('func_areaportal');
    expect(t78?.classname).toBe('target_speaker');
    // No splash emitter is fired by either door chain (all splash targets
    // are timer-driven t1/t2/t3/t41/t48..t54).
    expect(splashTargets.has('t69')).toBe(false);
    expect(splashTargets.has('t78')).toBe(false);
  });

  it('ambient sparks fire on timer cadence through the pump→pool/audio path', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // Cadence lower bound: the earliest first fire is 1+2.8-1.5=2.3s, so a
    // quiet first second proves the timers gate (missing-timer control).
    stepDriver(driver, neutralCmd(), 10);
    expect(driver.events.filter((e) => e === 'splash')).toHaveLength(0);
    expect(driver.heardSounds.filter((s) => s.startsWith('world/spark'))).toHaveLength(0);
    // Run 15s silent (no firing): several timers must fire.
    const sparkSounds = (): string[] => driver.heardSounds.filter((s) => s.startsWith('world/spark'));
    const before = sparkSounds().length;
    let splashTicks = 0;
    for (let i = 0; i < 150; i++) {
      if (i % 20 === 0) SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
      if (driver.events.includes('splash')) splashTicks++;
      driver.events.length = 0;
    }
    expect(splashTicks, 'timers fired during the window').toBeGreaterThan(0);
    const heard = sparkSounds();
    expect(heard.length - before, 'spark sounds heard').toBeGreaterThan(0);
    for (const s of heard) {
      expect(['world/spark5.wav', 'world/spark6.wav', 'world/spark7.wav']).toContain(s);
    }
    // Yellow-band pool presence at a firing sample (fails if the
    // timer→pool link is absent — the pool would stay empty).
    let sawYellow = false;
    for (let i = 0; i < 150 && !sawYellow; i++) {
      if (i % 20 === 0) SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
      sawYellow = driver.mini.particles.some(
        (p) => (p as { color: number }).color >= 0xe0 && (p as { color: number }).color <= 0xe7,
      );
    }
    expect(sawYellow).toBe(true);
    // Ballistic decay: a 2s settle drains splash ttl (0.5–0.8s) back down.
    const peak = driver.mini.particles.length;
    stepDriver(driver, neutralCmd(), 20);
    expect(driver.mini.particles.length).toBeLessThanOrEqual(peak);
  });

  it('sparks persist after the glass blows and the first door opens', { timeout: 240000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // Blow the *20 glass via the spawn-barrel splash chain (base1-gate (a)).
    const spawnBarrels = driver.barrels.filter(
      (b) => !b.isFunc && Math.hypot(b.origin[0]! - 128, b.origin[1]! + 320) < 400,
    );
    expect(spawnBarrels.length).toBe(2);
    const target = spawnBarrels[0]!;
    driver.pm.origin = v3(target.origin[0]!, target.origin[1]! - 80, 40);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 5);
    const yaw = yawAt([driver.pm.origin[0]!, driver.pm.origin[1]!], [target.origin[0]!, target.origin[1]!]);
    let ticks = 0;
    while (!driver.server.barrels.find((b) => b.isFunc && b.edict.model === '*20')!.edict.freed && ticks++ < 200) {
      if (ticks % 20 === 0) SV_SetPlayerHealth(driver.server, 100);
      driver.step(attackCmd([0, yaw, 0]), 0.1);
    }
    const glass = driver.server.barrels.find((b) => b.isFunc && b.edict.model === '*20')!;
    expect(glass.edict.freed, '*20 glass blown').toBe(true);
    // Open the *19 door through its use entry (fires t69 areaportal).
    const door19 = driver.server.movers.find((m) => m.ent.model === '*19');
    expect(door19).toBeDefined();
    SV_UseMover(driver.server, door19!);
    let moved = false;
    for (let i = 0; i < 60 && !moved; i++) {
      driver.step(neutralCmd(), 0.1);
      moved = door19!.state !== 'closed' && door19!.state !== 'open';
    }
    expect(moved || door19!.state !== 'closed', '*19 door left the closed pose').toBe(true);
    // Through both transitions the ambient chain keeps firing: new spark
    // sounds accumulate over the next 12s (fails if sparks were wired to
    // brush life or a one-shot trigger instead of the timer roster).
    const sparkCount = (): number => driver.heardSounds.filter((s) => s.startsWith('world/spark')).length;
    const before = sparkCount();
    for (let i = 0; i < 120; i++) {
      if (i % 20 === 0) SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
    }
    expect(sparkCount() - before, 'sparks fire after destruction + door transition').toBeGreaterThan(0);
  });

  it('devroom negative control: no splash edicts, no sparks, ever', { timeout: 60000 }, async () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    expect(driver.ambientSplashSources()).toBe(0);
    expect(driver.ambientSplashTimers()).toBe(0);
    stepDriver(driver, neutralCmd(), 150);
    expect(driver.events.includes('splash')).toBe(false);
    expect(driver.heardSounds.filter((s) => s.startsWith('world/spark'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pumps stay wired (regression net for the lanes owned here).
// ---------------------------------------------------------------------------

describe('release-9 pump wiring (no pak)', () => {
  it('muzzle + bolt + tracer pumps drain one-shot without accumulation', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    driver.step({ ...neutralCmd([0, 0, 0]), buttons: 1 }, 0.1);
    expect(driver.events).toContain('shot');
    expect(driver.muzzleLit()).toBe(true);
    expect(pumpMuzzleLight(boot)).toBe(true);
    expect(driver.drainFlash()).toBeNull();
    // Bolt dlights: one per live bolt (fails if the bolt→light link dies).
    expect(driver.bolts.length).toBe(1);
    expect(pumpBoltLights(boot)).toBe(1);
    // Tracer queue drains through the renderer pool (fails if pumpTracers
    // stops consuming — the queue would grow across frames).
    expect(TRACER_TTL_FRAMES).toBe(6);
    expect(pumpTracers(boot)).toBeGreaterThanOrEqual(0);
    expect(driver.pendingTracers).toBe(0);
    driver.step(neutralCmd(), 0.1);
    expect(driver.pendingTracers).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integrator: server records consumed by the render path (R9F-3 light styles,
// R9F-6 centerprints). Synthetic edicts on the real boot (fresh nums, no
// SV_SpawnEntities reset); the map-wiring halves are covered by M6/M10.
// ---------------------------------------------------------------------------

describe.runIf(!!WEB_Q2_PAK)('release-9 render consumption (Q2_PAK)', () => {
  it('light_use toggles reach RefDef.lightStyles on both view builders', { timeout: 60000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // Synthetic relay → light(style 200, off-map so no map style moves).
    const relay = spawnEdict({ classname: 'trigger_relay', targetname: 'r9style', target: 't959x' });
    const lamp = spawnEdict({ classname: 'light', targetname: 't959x', style: '200' });
    driver.server.entities.push(relay, lamp);
    expect(driver.lightStyleScale(200)).toBe(1);
    expect(buildAsyncView(boot.host).view.lightStyles[200]).toBe(1);
    SV_UseTargetname(driver.server, 'r9style');
    expect(driver.server.lightStyles[200]).toBe('a');
    expect(driver.lightStyleScale(200)).toBeCloseTo(0, 10);
    expect(buildAsyncView(boot.host).view.lightStyles[200]).toBeCloseTo(0, 10);
    SV_UseTargetname(driver.server, 'r9style');
    expect(driver.server.lightStyles[200]).toBe('m');
    expect(driver.lightStyleScale(200)).toBeCloseTo(1, 10);
    expect(buildAsyncView(boot.host).view.lightStyles[200]).toBeCloseTo(1, 10);
    // Unrecorded styles stay 1 (style 201 is off-map; nothing touches it).
    expect(driver.server.lightStyles[201]).toBeUndefined();
    expect(driver.lightStyleScale(201)).toBe(1);
  });

  it('trigger message centerprints surface on the centered channel, not the status line', { timeout: 60000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const trig = spawnEdict({ classname: 'trigger_once', message: 'R9F-6 probe line' });
    driver.server.entities.push(trig);
    stepDriver(driver, neutralCmd(), 5);
    expect(driver.centerText).not.toBe('R9F-6 probe line');
    fireTargets(driver.server, trig);
    stepDriver(driver, neutralCmd(), 3);
    expect(driver.centerText).toBe('R9F-6 probe line');
    expect(driver.message).not.toBe('R9F-6 probe line');
    expect(driver.heardSounds).toContain('misc/talk1.wav');
  });
});
