// RELEASE-5 visible replay + infantry burst capture (apps/web only, Q2_PAK-gated).
//
// The game+server+testkit lane landed the headless half (per-monster trace,
// frozen hold, flashless smack + swing cue, n-6/k+1 windows, real-base1
// t38/*19 regression in packages/server/src/release-5-location.test.ts,
// console-logged per 6s). This file is the web half:
//
// - (t38) an automated headless mirror of the pursuit through the REAL
//   driver+server tick loop (bootPlay), asserting on SUBMITTED snapshot
//   origins (never sim internals for the verdict): the soldier holds the
//   floor, crosses the slab plane only while *19 is off its seat, and never
//   overlaps the closed slab. The track logs per 60 ticks like the server
//   lane. A headless-Chromium render pass on the production soak page
//   repeats the sampled verdicts with composed-pixel captures (software
//   backend — the webgl2 path currently fails its own shader compile in a
//   real browser; see the browser leg header + lane report).
// - (burst) a representative infantry machinegun round through the web
//   driver: MZ2_1 foe flash + dlight, exactly one infatck1, one short
//   muzzle streak, damage-correlated impact sparks — plus negative
//   controls (no bolts, no blaster/shotgun/soldier/cock/swing/melee
//   audio on the fire frame; the swing is sound-only; the smack is
//   flashless). One pumped GPU frame submits the streak as a tracer-kind
//   beam. The browser leg watches live courtyard combat and counts
//   infatck1 emissions in-page.
//
// Documented deviation, signed off here (see the server-lane audit):
// C (m_infantry.c monster_fire_bullet + cl_fx.c TE_GUNSHOT) draws NO beam
// for bullets — the impact is a gray puff + smoke + ricochet. The short
// (<=48u) muzzle-origin streaks this tree submits are a readability aid,
// never muzzle->eye beams (pinned below: short, flash-paired, near the
// body, never overshooting toward the eye).
//
// Verdict bookkeeping: every test logs BOTH verdicts separately —
// `automated=PASS|FAIL` (assertions in this file) and
// `visual=CAPTURED(path hash=...)` (composed-pixel artifacts for manual
// review; hashes prove the captures differ per leg, not what they show).
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import type { UserCmdT } from '@q2/input';
import { AngleVectors, v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  INFANTRY_C,
  INFANTRY_COCK_SOUND,
  INFANTRY_GUN_SOUND,
  INFANTRY_MELEE_SOUND,
  INFANTRY_SWING_SOUND,
  HITSCAN_TRACER_COLOR,
  MONSTER_HULL_MAXS,
  MONSTER_HULL_MINS,
  MONSTER_MELEE_SOUND_ALIAS,
  MZ2_INFANTRY_MACHINEGUN_1,
  SOLDIER_WEAPON_STATS,
  isGreenBoltColor,
  monsterFlashOffset,
  projectSource,
} from '@q2/game';
import { MASK_OPAQUE_C, SV_SetPlayerHealth, SV_TraceFor } from '@q2/server';
import type { BspMap } from '@q2/bsp';
import { bootPlay, frameGpuPlay } from './play.js';
import type { LocalDriver } from './play.js';
import { ENEMY_TRACER_LENGTH } from './play.js';
import { censusSceneMaterials } from './gpu-effects.js';
import type { SoakRouteSnapshot } from './soak.js';
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { createServer } from 'http';

const WEB_Q2_PAK = process.env.Q2_PAK;
const CHROMIUM_BIN = process.env.CHROMIUM_BIN ?? '/usr/bin/chromium';

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

function stepDriver(driver: LocalDriver, cmd: UserCmdT, n: number): void {
  for (let i = 0; i < n; i++) driver.step(cmd, 0.1);
}

async function bootBase1(width = 96, height = 72) {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  return bootPlay({ width, height, pak: ingestPak(buf) });
}

// --- Stub DOM/GL boot (recording-proxy shape mirrored from
// gpu-live-route.test.ts): lets one pumped GPU frame run headless so the
// burst test asserts the real submit path (queue drains into a tracer-kind
// beam), not just the queued state. -------------------------------------

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

function installStubDoc(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const gl = makeStubGL([]);
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
    body: { appendChild: (): void => undefined },
  };
  g['document'] = doc;
}

async function bootBase1GpuStub(width = 96, height = 72): Promise<ReturnType<typeof bootPlay>> {
  installStubDoc();
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

function expectInWorld(origin: Vec3, map: BspMap): void {
  const mins = [...map.modelsMins.slice(0, 3)];
  const maxs = [...map.modelsMaxs.slice(0, 3)];
  for (let i = 0; i < 3; i++) {
    expect(origin[i]!).toBeGreaterThanOrEqual(mins[i]! - 32);
    expect(origin[i]!).toBeLessThanOrEqual(maxs[i]! + 32);
  }
}

function yawAt(from: [number, number], to: [number, number]): number {
  return (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
}

/** The reported player spot (origin space; feet at -48). */
const REPORTED: [number, number, number] = [-1148.1, 1542.3, -24];

/** *19 rest slab (map units; z -48..80 — 128 tall, unclimbable at step 18). */
const DOOR19_MIN = [-1120, 1560, -48];
const DOOR19_MAX = [-1104, 1704, 80];

/** Strict interior overlap (>1u on every axis): contact rests never count. */
function strictOverlap(o: Vec3, mins: Vec3, maxs: Vec3, bmins: Float32Array, bmaxs: Float32Array): boolean {
  for (let i = 0; i < 3; i++) {
    if (o[i]! + mins[i]! + 1 >= bmaxs[i]! || o[i]! + maxs[i]! - 1 <= bmins[i]!) return false;
  }
  return true;
}

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g['document'];
});

describe.runIf(!!WEB_Q2_PAK)('RELEASE-5 web visible replay + burst capture (Q2_PAK)', () => {
  it('t38 pursuit holds floor, crosses only through opened *19, never ghosts (automated headless mirror)', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const map = driver.map!;
    const m = driver.server.monsters.find((x) => x.edict.targetname === 't38')!;
    expect(m).toBeDefined();
    expect(m.edict.classname).toBe('monster_soldier');
    expect(m.ambush).toBe(true);
    const door19 = driver.server.movers.find((x) => x.ent.model === '*19')!;
    expect(door19).toBeDefined();
    expect(door19.state).toBe('bottom');
    // Phase 1: lure — step into the soldier's room so the ambush acquires.
    driver.pm.origin = v3(-1060, 1598, -24);
    driver.pm.velocity = v3();
    for (let i = 0; i < 30; i++) {
      SV_SetPlayerHealth(driver.server, 100); // setup: hold the lure alive
      driver.step(neutralCmd(), 0.1);
    }
    expect(m.seen).toBe(true);
    expect(m.state.yaw).not.toBe(0);
    // Phase 2: retreat to the reported spot; the woken soldier pursues.
    driver.pm.origin = v3(REPORTED[0], REPORTED[1], REPORTED[2]);
    driver.pm.velocity = v3();
    const zSpawn = m.edict.origin[2]!;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let minGap = Infinity;
    let crossedAt = -1;
    let crossDoor: string | null = null;
    let eastArmed = m.edict.origin[0]! > DOOR19_MAX[0]! + 16;
    let engaged = false;
    let closedOverlap = 0;
    const track: string[] = [];
    for (let t = 0; t < 600; t++) {
      SV_SetPlayerHealth(driver.server, 100); // setup: park the camper alive
      driver.step(neutralCmd(), 0.1);
      const o = m.edict.origin;
      minZ = Math.min(minZ, o[2]!);
      maxZ = Math.max(maxZ, o[2]!);
      // RENDERED gap: the submitted snapshot origin, not the sim field.
      const snap = driver.snapshot(driver.server.time);
      const sent = snap.entities.find((e) => e.id === m.edict.num)!;
      expect(sent).toBeDefined();
      expect(Math.hypot(sent.origin[0]! - o[0]!, sent.origin[1]! - o[1]!, sent.origin[2]! - o[2]!)).toBeLessThan(1);
      minGap = Math.min(
        minGap,
        Math.hypot(sent.origin[0]! - driver.pm.origin[0]!, sent.origin[1]! - driver.pm.origin[1]!),
      );
      if (m.state.move.startsWith('attack')) engaged = true;
      if (o[0]! > DOOR19_MAX[0]! + 16) eastArmed = true;
      if (crossedAt < 0 && eastArmed && o[0]! < DOOR19_MIN[0]! - 16) {
        crossedAt = t;
        crossDoor = door19.state;
      }
      const rest =
        door19.ent.origin[0]! === door19.pos1[0]! &&
        door19.ent.origin[1]! === door19.pos1[1]! &&
        door19.ent.origin[2]! === door19.pos1[2]!;
      if (rest) {
        const b = driver.server.moverBounds.get(door19.ent.num)!;
        const cur = {
          mins: new Float32Array([b.mins[0]!, b.mins[1]!, b.mins[2]!]),
          maxs: new Float32Array([b.maxs[0]!, b.maxs[1]!, b.maxs[2]!]),
        };
        if (strictOverlap(o, MONSTER_HULL_MINS, MONSTER_HULL_MAXS, cur.mins, cur.maxs)) closedOverlap++;
      }
      if (t % 60 === 0) {
        track.push(
          `t=${(t * 0.1).toFixed(0)}s [${o[0]!.toFixed(1)},${o[1]!.toFixed(1)},${o[2]!.toFixed(1)}] ` +
            `yaw=${m.state.yaw.toFixed(0)} ${m.state.move} door=${door19.state}`,
        );
      }
      expectInWorld(driver.pm.origin, map);
    }
    console.log(`[release-5-visual] automated t38 track:\n  ${track.join('\n  ')}`);
    console.log(
      `[release-5-visual] automated t38: z=[${minZ.toFixed(2)},${maxZ.toFixed(2)}] (spawn ${zSpawn.toFixed(2)}) ` +
        `minGap=${minGap.toFixed(1)} crossedAt=${crossedAt} crossDoor=${crossDoor} engaged=${engaged} closedOverlap=${closedOverlap}`,
    );
    // No wall climb: both rooms share one floor; the hull never leaves it.
    expect(maxZ - minZ).toBeLessThanOrEqual(1);
    expect(maxZ).toBeLessThanOrEqual(zSpawn + 1);
    // No closed-slab ghosting: the 128-tall slab is never entered at rest.
    expect(closedOverlap).toBe(0);
    // The pursuit reaches the player side through the opened doorway.
    expect(crossedAt).toBeGreaterThanOrEqual(0);
    expect(crossDoor).not.toBe('bottom');
    // Close contact without interpenetration (hulls 16+16 stop the walker).
    expect(minGap).toBeLessThan(200);
    expect(minGap).toBeGreaterThanOrEqual(30);
    expect(engaged).toBe(true);
    console.log('[release-5-visual] automated=t38-PASS visual=pending-browser-leg');
  });

  it('infantry representative burst round: MZ2_1 muzzle + dlight + infatck1 + streak + impact (negatives hold)', { timeout: 180000 }, async () => {
    const boot = await bootBase1GpuStub();
    const { driver } = boot;
    const map = driver.map!;
    // Stage: first live non-dormant infantry with a clear 300u lane east.
    const sight = SV_TraceFor(map, MASK_OPAQUE_C);
    let staged: { idx: number } | null = null;
    const cands = driver.server.monsters.filter((x) => x.kind === 'infantry' && !x.state.dead && !(x.triggered && !x.woken));
    expect(cands.length).toBeGreaterThan(0);
    for (const cand of cands) {
      driver.pm.origin = v3(cand.edict.origin[0]! + 300, cand.edict.origin[1]!, cand.edict.origin[2]!);
      driver.pm.velocity = v3();
      stepDriver(driver, neutralCmd(), 2);
      const eye = [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + 22];
      const ctr = [cand.edict.origin[0]!, cand.edict.origin[1]!, cand.edict.origin[2]! + 4];
      const t = sight(v3(eye[0], eye[1], eye[2]), v3(0, 0, 0), v3(0, 0, 0), v3(ctr[0], ctr[1], ctr[2]));
      if (t.fraction === 1 && !t.startsolid && driver.pm.onGround) {
        staged = { idx: cand.edict.num };
        break;
      }
    }
    expect(staged, 'a live infantry with a clear 300u lane').not.toBeNull();
    const inf = driver.server.monsters.find((x) => x.edict.num === staged!.idx)!;
    // Face the player, then force the fire frame (attak111 InfantryMachineGun,
    // the same setup the server-lane representative round uses).
    const yaw = yawAt([inf.edict.origin[0]!, inf.edict.origin[1]!], [driver.pm.origin[0]!, driver.pm.origin[1]!]);
    inf.state.yaw = yaw;
    const fireRound = (): void => {
      inf.state.move = 'attack1';
      inf.state.frame = 10;
      const soundsBefore = driver.heardSounds.length;
      const monshotBefore = driver.events.filter((e) => e === 'monshot').length;
      const boltsBefore = driver.bolts.length;
      driver.step(neutralCmd(), 0.1);
      const newSounds = driver.heardSounds.slice(soundsBefore);
      const guns = newSounds.filter((s) => s === INFANTRY_GUN_SOUND).length;
      // Negative controls on the fire tick: no bolts, no wrong audio.
      expect(driver.bolts.length).toBe(boltsBefore);
      for (const bad of [
        SOLDIER_WEAPON_STATS.blaster.sound,
        SOLDIER_WEAPON_STATS.shotgun.sound,
        SOLDIER_WEAPON_STATS.machinegun.sound,
        INFANTRY_COCK_SOUND,
        INFANTRY_SWING_SOUND,
        INFANTRY_MELEE_SOUND,
        MONSTER_MELEE_SOUND_ALIAS,
      ]) {
        expect(newSounds, bad).not.toContain(bad);
      }
      // Exactly one machinegun round per forced fire frame (n-6 single-bullet
      // pacing: one trigger = one dmg-3 bullet, never a volley).
      expect(guns).toBe(1);
      expect(driver.events.filter((e) => e === 'monshot').length).toBe(monshotBefore + 1);
      // MZ2_1 foe flash + yellow dlight (C 200+(rand&31)).
      const flashes = driver.drainEnemyMuzzle();
      expect(flashes).toHaveLength(1);
      expect(flashes[0]!.intensity).toBeGreaterThanOrEqual(200);
      expect(flashes[0]!.intensity).toBeLessThanOrEqual(231);
      const fwd = v3();
      const right = v3();
      AngleVectors(v3(0, yaw, 0), fwd, right);
      const want = projectSource(
        v3(inf.edict.origin[0], inf.edict.origin[1], inf.edict.origin[2]),
        monsterFlashOffset(MZ2_INFANTRY_MACHINEGUN_1),
        fwd,
        right,
      );
      expect(flashes[0]!.pos[0]!).toBeCloseTo(want[0]!, 4);
      expect(flashes[0]!.pos[1]!).toBeCloseTo(want[1]!, 4);
      expect(flashes[0]!.pos[2]!).toBeCloseTo(want[2]!, 4);
      // One short muzzle streak (documented aid: C draws no beam — short,
      // flash-paired, near the body, never overshooting toward the eye).
      const got = driver.drainTracers();
      expect(got).toHaveLength(1);
      const t0 = got[0]!;
      expect(t0.color).toBe(HITSCAN_TRACER_COLOR);
      expect(isGreenBoltColor(t0.color)).toBe(false);
      expect(t0.length).toBe(ENEMY_TRACER_LENGTH);
      expect(t0.length).toBeLessThanOrEqual(48);
      expect(
        Math.hypot(
          t0.origin[0]! - flashes[0]!.pos[0]!,
          t0.origin[1]! - flashes[0]!.pos[1]!,
          t0.origin[2]! - flashes[0]!.pos[2]!,
        ),
      ).toBeLessThan(0.001);
      expect(
        Math.hypot(
          t0.origin[0]! - inf.edict.origin[0]!,
          t0.origin[1]! - inf.edict.origin[1]!,
          t0.origin[2]! - inf.edict.origin[2]!,
        ),
      ).toBeLessThan(64);
      const eye: [number, number, number] = [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + 22];
      const gap0 = Math.hypot(t0.origin[0]! - eye[0], t0.origin[1]! - eye[1], t0.origin[2]! - eye[2]);
      const dl = Math.hypot(t0.dir[0]!, t0.dir[1]!, t0.dir[2]!) || 1;
      const end: [number, number, number] = [
        t0.origin[0]! + (t0.dir[0]! / dl) * t0.length,
        t0.origin[1]! + (t0.dir[1]! / dl) * t0.length,
        t0.origin[2]! + (t0.dir[2]! / dl) * t0.length,
      ];
      const endDist = Math.hypot(end[0] - eye[0], end[1] - eye[1], end[2] - eye[2]);
      expect(endDist).toBeGreaterThanOrEqual(gap0 - t0.length - 0.5);
      if (gap0 > 130) expect(endDist).toBeGreaterThan(78.7);
    };
    // Forced rounds until the C spread roll lands a hit (bounded: the
    // seeded stream alternates; every round still pins the full invariant
    // set above). The hitting round proves impact: dmg 3 + spark growth.
    let hitAt = -1;
    for (let r = 0; r < 6 && hitAt < 0; r++) {
      const hpBefore = driver.playerHealth;
      const partsBefore = driver.mini.particles.length;
      fireRound();
      const damaged = hpBefore - driver.playerHealth;
      const sparked = driver.mini.particles.length - partsBefore;
      if (damaged > 0) {
        hitAt = r;
        expect(damaged).toBe(INFANTRY_C.bulletDamage);
        expect(sparked).toBeGreaterThan(0);
      } else {
        // A miss leaves no impact sparks and costs no health (correlated).
        expect(sparked).toBe(0);
      }
      expectInWorld(driver.pm.origin, map);
    }
    expect(hitAt, 'a hitting round within 6 forced frames').toBeGreaterThanOrEqual(0);
    // Render pass: one more forced round, then a single pumped GPU frame —
    // the queue must drain exactly once into a tracer-kind beam submit.
    inf.state.move = 'attack1';
    inf.state.frame = 10;
    inf.state.yaw = yaw;
    driver.step(neutralCmd(), 0.1);
    expect(driver.pendingTracers).toBe(1);
    frameGpuPlay(boot, 16);
    expect(driver.pendingTracers).toBe(0);
    expect(censusSceneMaterials(boot.gpu!.scene).beam).toBeGreaterThanOrEqual(1);
    expect(boot.gpu!.gpu.testWarnings().filter((w) => /missing|invalid|failed/i.test(w))).toEqual([]);
    expect(driver.playerHealth).toBeGreaterThan(0);
    console.log(
      `[release-5-visual] automated burst: infantry #${inf.edict.num} hitAt=${hitAt} ` +
        `dmg=${INFANTRY_C.bulletDamage} streak<=48 paired flash-only negatives-clean automated=PASS`,
    );
  });

  it('infantry swing is sound-only; the smack is flashless (C fire_hit)', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const map = driver.map!;
    const inf = driver.server.monsters.find((x) => x.kind === 'infantry' && !x.state.dead && !(x.triggered && !x.woken))!;
    expect(inf).toBeDefined();
    // Park the player 40u east for the smack (melee range), settle first.
    driver.pm.origin = v3(inf.edict.origin[0]! + 40, inf.edict.origin[1]!, inf.edict.origin[2]!);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 2);
    inf.state.yaw = yawAt([inf.edict.origin[0]!, inf.edict.origin[1]!], [driver.pm.origin[0]!, driver.pm.origin[1]!]);
    // Swing wind-up (attak203): infatck2, no damage, no muzzle/tracer/bolt.
    {
      inf.state.move = 'attack2';
      inf.state.frame = 2;
      const soundsBefore = driver.heardSounds.length;
      const hpBefore = driver.playerHealth;
      const boltsBefore = driver.bolts.length;
      driver.step(neutralCmd(), 0.1);
      const newSounds = driver.heardSounds.slice(soundsBefore);
      expect(newSounds).toContain(INFANTRY_SWING_SOUND);
      expect(driver.playerHealth).toBe(hpBefore);
      expect(driver.drainEnemyMuzzle()).toHaveLength(0);
      expect(driver.drainTracers()).toHaveLength(0);
      expect(driver.bolts.length).toBe(boltsBefore);
    }
    // Smack (attak206): 5+(rand%5) + melee2, flashless — no muzzle, no
    // dlight, no tracer, no projectile.
    {
      inf.state.move = 'attack2';
      inf.state.frame = 5;
      inf.state.yaw = yawAt([inf.edict.origin[0]!, inf.edict.origin[1]!], [driver.pm.origin[0]!, driver.pm.origin[1]!]);
      const soundsBefore = driver.heardSounds.length;
      const hpBefore = driver.playerHealth;
      const boltsBefore = driver.bolts.length;
      driver.step(neutralCmd(), 0.1);
      const dealt = hpBefore - driver.playerHealth;
      expect(dealt).toBeGreaterThanOrEqual(5);
      expect(dealt).toBeLessThanOrEqual(9);
      expect(driver.heardSounds.slice(soundsBefore)).toContain(INFANTRY_MELEE_SOUND);
      expect(driver.drainEnemyMuzzle()).toHaveLength(0);
      expect(driver.drainTracers()).toHaveLength(0);
      expect(driver.bolts.length).toBe(boltsBefore);
    }
    expectInWorld(driver.pm.origin, map);
    console.log('[release-5-visual] automated melee: swing sound-only + flashless smack automated=PASS');
  });
});

// --- Chromium render pass (production page, CDP only) -----------------------

interface CdpShotStats { w: number; h: number; nonblack: number; mean: number; hash: number }

interface BrowserPage {
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
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

describe.runIf(!!WEB_Q2_PAK)('RELEASE-5 browser render pass (Q2_PAK + chromium)', () => {
  it('t38 pursuit + infantry courtyard: sampled verdicts with composed captures', { timeout: 600000 }, async () => {    let chromiumPresent = false;
    try {
      accessSync(CHROMIUM_BIN, constants.X_OK);
      chromiumPresent = true;
    } catch {
      chromiumPresent = false;
    }
    if (!chromiumPresent) {
      console.log('[release-5-visual] browser SKIP: no chromium binary');
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
    const vitePort = Number(process.env.GPU_ROUTE_VITE_PORT ?? 5197);
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
      // Software backend (not webgl2): the production GPU loop currently
      // throws in real Chromium on a FOLLOW-3B shader regression
      // (FS_LIT `voodooSampleMippedWarped`: ANGLE reports "no matching
      // overloaded function" at ensurePrograms, so frameGpuPlay never
      // submits — stub-GL unit tests cannot catch a real compile failure).
      // That breakage is packages/webgl-renderer-owned and OUT of this
      // lane's apps/web lock; it is reported, not fixed, here. The
      // software path runs the identical driver+server sim and submits
      // the identical scene through the 2D canvas, so the visible geometry
      // verdicts (floor level, doorway traversal, no ghost) still hold on
      // composed pixels. Re-point at webgl2 once the shader compiles.
      const pageUrl = `http://127.0.0.1:${vitePort}/?q2soak=1&q2pak=${encodeURIComponent(`${pakUrl}/pak0.pak`)}&q2renderer=software`;
      const userDataDir = join(tmpdir(), `q2-r5-visual-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
      mkdirSync(userDataDir, { recursive: true });
      const chromium = await launchChromium(pageUrl, userDataDir);
      const outDir = join(tmpdir(), `q2-r5-visual-${Date.now()}`);
      mkdirSync(outDir, { recursive: true });
      try {
        const { page, consoleLines } = await (async () => {
          const res = await fetch(`http://127.0.0.1:${chromium.port}/json/list`);
          if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`);
          const targets = (await res.json()) as { type?: string; webSocketDebuggerUrl?: string }[];
          const target = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          if (!target?.webSocketDebuggerUrl) throw new Error('no page target with debugger URL');
          return createBrowserPage(target.webSocketDebuggerUrl);
        })();
        try {
          let status: { booted?: boolean; error?: string | null; actualRenderer?: string; warning?: string | null } | null = null;
          const bootDeadline = Date.now() + 240000;
          for (;;) {
            status = await page.evaluate<{ booted?: boolean; error?: string | null; actualRenderer?: string; warning?: string | null } | null>(
              'window.__q2soak ? window.__q2soak : null', 30000).catch(() => null);
            if (status && status.booted) break;
            if (status && status.error) throw new Error(`page boot error: ${status.error}`);
            if (Date.now() > bootDeadline) throw new Error('soak boot timeout (240s)');
            await sleep(2000);
          }
          expect(status!.actualRenderer, 'software leg attached').toBe('software');
          expect(status!.warning, 'no fallback warning').toBeNull();
          await page.evaluate<void>(SHOT_STATS_INSTALL, 30000);
          const box = await page.evaluate<{ x: number; y: number; width: number; height: number } | null>(
            '(() => { const c = document.querySelector("#q2"); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()',
            30000,
          );
          expect(box, 'game canvas box present').not.toBeNull();
          expect(box!.width, 'canvas box wide enough').toBeGreaterThanOrEqual(640);
          expect(box!.height, 'canvas box tall enough').toBeGreaterThanOrEqual(480);
          const routeOf = (): Promise<SoakRouteSnapshot | null> =>
            page.evaluate<SoakRouteSnapshot | null>('window.__q2soakRoute ? window.__q2soakRoute() : null', 30000);
          const teleport = (x: number, y: number, z: number): Promise<boolean> =>
            page.evaluate<boolean>(`window.__q2soakTeleport ? window.__q2soakTeleport(${x},${y},${z}) : false`, 15000);
          const snapLeg = async (name: string): Promise<{ route: SoakRouteSnapshot | null; shot: CdpShotStats; path: string }> => {
            const route = await routeOf();
            const b64 = await page.screenshot(box!);
            const shot = await page.evaluate<CdpShotStats>(`window.__shotStats("${b64}")`, 60000);
            const path = join(outDir, `r5-${name}.png`);
            writeFileSync(path, Buffer.from(b64, 'base64'));
            return { route, shot, path };
          };
          const t38Of = (r: SoakRouteSnapshot | null) => r?.monsters?.find((x) => x.targetname === 't38') ?? null;
          const door19Of = (r: SoakRouteSnapshot | null) => r?.movers?.find((x) => x.model === '*19') ?? null;
          const FATAL_RE = /missing|texels may be corrupt|invalid|failed|deferred/i;

          // Leg 1: lure — inside the soldier's room; the ambush must acquire.
          // Poll until seen (headless SwiftShader runs the sim slower than
          // wall clock, so a fixed sleep would be timing luck).
          expect(await teleport(-1060, 1598, -24), 'lure teleport landed').toBe(true);
          let lureSeen = false;
          for (let w = 0; w < 30; w++) {
            await sleep(1000);
            const r = await routeOf();
            const t = t38Of(r);
            if (t?.seen === true) { lureSeen = true; break; }
          }
          const lure = await snapLeg('t38-lure');
          expect(lure.route, 'lure route present').not.toBeNull();
          expect(lureSeen, 'ambush acquired the lure within 30s wall').toBe(true);
          // Software backend: no GPU uploads/submissions (both null); the
          // rAF frame counter advancing proves the production loop submits.
          expect(lure.route!.frame, 'production loop advances frames').toBeGreaterThan(0);
          expect((lure.route!.warnings ?? []).filter((w) => FATAL_RE.test(w)), 'no fatal warnings').toEqual([]);
          const lureT38 = t38Of(lure.route);
          expect(lureT38, 't38 visible in route').not.toBeNull();
          expect(lureT38!.seen, 'ambush acquired the lure').toBe(true);
          // Composed page live: 0.3 rejects a black-screen failure while
          // tolerating wall close-ups (the staged infantry lane varies the
          // viewpoint per run; observed 0.51..0.88).
          expect(lure.shot.nonblack, 'composed lure page live').toBeGreaterThan(0.3);

          // Leg 2: retreat — the reported spot; sample the pursuit for up to
          // 180s wall (sim may run slower than wall under SwiftShader).
          // Sampled verdicts (per-poll, not per-tick): the per-tick proof
          // lives in the headless mirror above + the server lane.
          expect(await teleport(REPORTED[0], REPORTED[1], REPORTED[2]), 'retreat teleport landed').toBe(true);
          let minZ = Infinity;
          let maxZ = -Infinity;
          let closedOverlap = 0;
          let crossed = false;
          let doorOpenSeen = false;
          let minGap = Infinity;
          let lastT38: [number, number, number] | null = null;
          const track: string[] = [];
          for (let p = 0; p < 90; p++) {
            await sleep(2000);
            // Heal = setup (same class as the headless SV_SetPlayerHealth
            // park: keeps the camper, never a verdict input).
            await teleport(REPORTED[0], REPORTED[1], REPORTED[2]);
            const r = await routeOf();
            const t38 = t38Of(r);
            if (!t38) continue;
            lastT38 = [...t38.origin];
            minZ = Math.min(minZ, t38.origin[2]!);
            maxZ = Math.max(maxZ, t38.origin[2]!);
            const d19 = door19Of(r);
            // Rest = rendered offset back at the closed pose (the snapshot
            // carries doorRenderOffset magnitudes, no pos1 to compare).
            const shut = d19 != null && d19.state === 'bottom' && (d19.offsetMag ?? 0) < 0.01;
            if (shut && d19) {
              // Closed-slab ghost check at poll granularity (contact rests
              // excluded by the 1u margin, same rule as the per-tick pins).
              let inside = true;
              for (let i = 0; i < 3; i++) {
                const lo = (i === 0 ? DOOR19_MIN[i]! : i === 1 ? DOOR19_MIN[i]! : DOOR19_MIN[i]!) as number;
                const hi = (i === 0 ? DOOR19_MAX[i]! : i === 1 ? DOOR19_MAX[i]! : DOOR19_MAX[i]!) as number;
                const mins = [-16, -16, -24][i]!;
                const maxs = [16, 16, 32][i]!;
                if (t38.origin[i]! + mins + 1 >= hi || t38.origin[i]! + maxs - 1 <= lo) { inside = false; break; }
              }
              if (inside) closedOverlap++;
            }
            if (d19 && d19.state !== 'bottom') doorOpenSeen = true;
            if (t38.origin[0]! < DOOR19_MIN[0]! - 16) crossed = true;
            if (r?.camera?.origin) {
              minGap = Math.min(
                minGap,
                Math.hypot(t38.origin[0]! - r.camera.origin[0]!, t38.origin[1]! - r.camera.origin[1]!),
              );
            }
            if (p % 3 === 0) {
              track.push(
                `+${(p * 2).toFixed(0)}s [${t38.origin[0]!.toFixed(1)},${t38.origin[1]!.toFixed(1)},${t38.origin[2]!.toFixed(1)}] ` +
                  `${t38.move} door=${d19?.state ?? '?'} hp=${r?.playerHealth ?? '?'}`,
              );
            }
            if (crossed && doorOpenSeen && minGap < 200) break;
          }
          const reported = await snapLeg('t38-reported');
          expect(reported.route, 'reported route present').not.toBeNull();
          expect(reported.route!.frame, 'production loop advances frames').toBeGreaterThan(lure.route!.frame);
          expect((reported.route!.warnings ?? []).filter((w) => FATAL_RE.test(w)), 'no fatal warnings').toEqual([]);
          expect(reported.shot.nonblack, 'composed reported page live').toBeGreaterThan(0.3);
          console.log(`[release-5-visual] browser t38 track (sampled):\n  ${track.join('\n  ')}`);
          console.log(
            `[release-5-visual] browser t38: z=[${minZ.toFixed(2)},${maxZ.toFixed(2)}] crossed=${crossed} ` +
              `doorOpenSeen=${doorOpenSeen} minGap=${minGap.toFixed(1)} closedOverlap=${closedOverlap} last=${lastT38}`,
          );
          // Sampled automated verdicts (per-poll; per-tick proof is headless).
          expect(maxZ - minZ, 'floor held (sampled)').toBeLessThanOrEqual(1.5);
          expect(closedOverlap, 'never in the closed slab (sampled)').toBe(0);
          expect(crossed, 'reached the player side through the doorway').toBe(true);
          expect(doorOpenSeen, '*19 opened for the crossing (no ghost path)').toBe(true);
          expect(minGap, 'closed to attack range').toBeLessThan(200);

          // Leg 3: infantry courtyard — watch live combat, count infatck1
          // emissions in-page (machinegun rounds only). The courtyard
          // overlook alone only guarantees the soldier (bolts); the watch
          // re-stages the player at ballistic range with a trace-verified
          // open lane (real base1 lump + C opaque mask, same construction
          // as the headless staging above — a blind offset risks a wall
          // between body and gun, which reads as "seen but never fires",
          // and a fixed 120u offset lets the gun close to melee, which
          // smacks instead of bursting). Re-staging every 5s keeps fresh
          // LOS at ballistic range so M_CheckAttack rolls live rounds;
          // the first counter advance ends the watch (natural engagement,
          // no forced frames — the forcing variant is the headless leg).
          type LaneTrace = (
            start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3,
          ) => { fraction: number; startsolid: boolean; allsolid: boolean };
          const { PakFile } = await import('@q2/filesystem');
          const { loadBsp } = await import('@q2/bsp');
          const raw = readFileSync(WEB_Q2_PAK as string);
          const buf = new ArrayBuffer(raw.length);
          new Uint8Array(buf).set(raw);
          const pak = new PakFile(buf);
          const map = loadBsp(pak.readFile('maps/base1.bsp'));
          const sight = SV_TraceFor(map, MASK_OPAQUE_C) as unknown as LaneTrace;
          const world = SV_TraceFor(map) as unknown as LaneTrace;
          const P_MINS = v3(-16, -16, -24);
          const P_MAXS = v3(16, 16, 32);
          const ZERO = v3(0, 0, 0);
          // First verified lane to an awake infantry (dormant TRIGGER_SPAWN
          // bodies never acquire or fire — staging next to one watches
          // nothing). Ballistic offsets only (250-300u).
          const pickLane = (
            live: { id: number; origin: [number, number, number] }[],
          ): { id: number; spot: [number, number, number] } | null => {
            for (const m of live) {
              const ix = m.origin[0]!, iy = m.origin[1]!, iz = m.origin[2]!;
              for (const [dx, dy] of [[300, 0], [-300, 0], [0, 300], [0, -300], [250, 0]] as const) {
                const sx = ix + dx, sy = iy + dy, sz = iz;
                const embed = world(v3(sx, sy, sz), P_MINS, P_MAXS, v3(sx, sy, sz - 1));
                if (embed.startsolid || embed.allsolid) continue;
                const los = sight(v3(sx, sy, sz + 22), ZERO, ZERO, v3(ix, iy, iz + 4));
                if (los.fraction === 1 && !los.startsolid) return { id: m.id, spot: [sx, sy, sz] };
              }
            }
            return null;
          };
          expect(await teleport(-904, 1326, -24), 'courtyard teleport landed').toBe(true);
          const shots0 = (await routeOf())?.combat?.infantryShots ?? null;
          expect(shots0, 'combat counters present').not.toBeNull();
          let shots1 = shots0!;
          let boltsMax = 0;
          let stagedSeen = false;
          let stagedMove = '?';
          let stagedGap = Infinity;
          let stagedId = -1;
          let stage: [number, number, number] = [-904, 1326, -24];
          let everStaged = false;
          const kindsSeen = new Set<string>();
          for (let w = 0; w < 60 && shots1 <= shots0!; w++) {
            // Fresh lane every 5s: the gun chases, so a fixed spot decays
            // to melee (smacks) or blind pursuit (no rounds).
            if (w % 5 === 0) {
              const r0 = await routeOf();
              const live = (r0?.monsters ?? []).filter(
                (x) => x.kind === 'infantry' && !x.dead && !(x.triggered && !x.woken),
              );
              if (live.length > 0) {
                const cam0 = r0?.camera?.origin ?? stage;
                const ordered = [...live].sort(
                  (a, b) =>
                    Math.hypot(a.origin[0]! - cam0[0]!, a.origin[1]! - cam0[1]!) -
                    Math.hypot(b.origin[0]! - cam0[0]!, b.origin[1]! - cam0[1]!),
                );
                const picked = pickLane(ordered);
                if (picked) {
                  stage = picked.spot;
                  stagedId = picked.id;
                  everStaged = true;
                }
              }
            }
            await teleport(stage[0], stage[1], stage[2]); // setup: park + heal
            await sleep(1000);
            const r = await routeOf();
            if (!r) continue;
            for (const k of r.monsterKinds ?? []) kindsSeen.add(k);
            shots1 = r.combat?.infantryShots ?? shots1;
            boltsMax = Math.max(boltsMax, r.combat?.bolts ?? 0);
            const staged = (r.monsters ?? []).find((x) => x.id === stagedId);
            if (staged) {
              if (staged.seen === true) stagedSeen = true;
              stagedMove = staged.move;
              stagedGap = Math.min(
                stagedGap,
                Math.hypot(staged.origin[0]! - stage[0], staged.origin[1]! - stage[1]),
              );
            }
          }
          const court = await snapLeg('infantry-court');
          expect(court.route, 'courtyard route present').not.toBeNull();
          expect((court.route!.warnings ?? []).filter((w) => FATAL_RE.test(w)), 'no fatal warnings').toEqual([]);
          expect(court.route!.frame, 'production loop advances frames').toBeGreaterThan(reported.route!.frame);
          expect(court.shot.nonblack, 'composed courtyard page live').toBeGreaterThan(0.3);
          console.log(
            `[release-5-visual] browser infantry: kinds=[${[...kindsSeen].sort().join(',')}] ` +
              `infatck1 ${shots0}->${shots1} boltsMax=${boltsMax} hp=${court.route!.playerHealth} ` +
              `stagedId=${stagedId} stagedSeen=${stagedSeen} stagedMove=${stagedMove} stagedGap=${stagedGap.toFixed(0)} ` +
              `stage=[${stage.map((n) => n.toFixed(1)).join(',')}]`,
          );
          expect(kindsSeen.has('infantry'), 'live infantry on the page').toBe(true);
          expect(everStaged, 'a verified ballistic lane was staged').toBe(true);
          expect(shots1, 'live infantry burst heard in-page (infatck1 counter advanced)').toBeGreaterThan(shots0!);

          const consoleErrors = consoleLines.filter(
            (l) => l.startsWith('[exception]') || l.includes('Uncaught') || l.includes('ERROR'));
          expect(consoleErrors).toEqual([]);
          // Distinct captures per leg (rejects a stale repeated frame).
          expect(new Set([lure.shot.hash, reported.shot.hash, court.shot.hash]).size).toBe(3);
          for (const [nm, cap] of [['t38-lure', lure], ['t38-reported', reported], ['infantry-court', court]] as const) {
            console.log(
              `[release-5-visual] browser ${nm}: frame=${cap.route!.frame} cluster=${cap.route!.cluster} ` +
                `alive=${cap.route!.aliveMonsters} nonblack=${cap.shot.nonblack.toFixed(3)} mean=${cap.shot.mean.toFixed(1)} ` +
                `hash=${cap.shot.hash.toString(16)} shot=${cap.path}`,
            );
          }
          console.log('[release-5-visual] browser automated=PASS visual=CAPTURED(3 legs above, manual review)');
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
