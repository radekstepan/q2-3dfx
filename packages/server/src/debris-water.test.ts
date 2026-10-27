// Movement-physics lane: blown-debris walk-through (A), crawlspace eye (B),
// server-tick drowning (D). All headless against the real base1 lump.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { PakFile } from '@q2/filesystem';
import { loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import {
  PMF_DUCKED,
  bspPointContentsFor,
  makePmoveState,
  mulberry32,
  pmoveFull,
  resetEdictNums,
  resetPmoveWorld,
  setPmoveWorld,
} from '@q2/game';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  SV_ClipTrace,
  SV_DamageBarrel,
  SV_Init,
  SV_MonsterTick,
  SV_SpawnEntities,
  SV_Tick,
  SV_TraceFor,
} from './index.js';
import type { TraceFn } from '@q2/game';
import type { SVGameTick } from './index.js';

const Q2_PAK = process.env.Q2_PAK;

function loadBase1(): BspMap {
  const bytes = readFileSync(Q2_PAK as string);
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  const pak = new PakFile(buf);
  return loadBsp(pak.readFile('maps/base1.bsp')) as BspMap;
}

function spawnC(st: ReturnType<typeof SV_Init>, map: BspMap): void {
  SV_SpawnEntities(
    st,
    map.entities,
    (model) => {
      if (!model.startsWith('*')) return null;
      const n = Number.parseInt(model.slice(1), 10);
      if (!Number.isFinite(n)) return null;
      return {
        mins: new Float32Array([map.modelsMins[n * 3]!, map.modelsMins[n * 3 + 1]!, map.modelsMins[n * 3 + 2]!]),
        maxs: new Float32Array([map.modelsMaxs[n * 3]!, map.modelsMaxs[n * 3 + 1]!, map.modelsMaxs[n * 3 + 2]!]),
      };
    },
    SV_TraceFor(map),
  );
}

/** Blow *20 through the real path: lethal damage + fuse ticks on server time. */
function blowDoor20(st: ReturnType<typeof SV_Init>, trace: TraceFn): void {
  const b20 = st.barrels.find((b) => b.isFunc && b.edict.model === '*20')!;
  expect(b20).toBeDefined();
  expect(st.brushClips.has(b20.edict.num)).toBe(true);
  SV_DamageBarrel(st, b20, 500);
  // C barrel_delay: the lethal hit latches the 0.2s fuse — the brush stays
  // live AND solid until the fuse blows (mesh rendered, clip blocking).
  expect(b20.fused).toBe(true);
  expect(b20.edict.freed).toBe(false);
  expect(st.brushClips.has(b20.edict.num)).toBe(true);
  const game: SVGameTick = {
    player: { pos: v3(28, 60, 30), mins: v3(-16, -16, -24), maxs: v3(16, 16, 32), view: 22 },
    trace,
  };
  for (let i = 0; i < 10; i++) SV_Tick(st, 0.1, game);
  // Fuse blew: freed + clip removed on the SAME tick (C BecomeExplosion1
  // atomicity) — no freed-but-solid window to collide with.
  expect(b20.edict.freed).toBe(true);
  expect(st.brushClips.has(b20.edict.num)).toBe(false);
}

describe.runIf(!!Q2_PAK)('A: blown-*20 walk-through (no jump, both hulls, monster)', () => {
  it('player walks the doorway standing + crouched, moves out again', { timeout: 300000 }, () => {
    const map = loadBase1();
    resetEdictNums();
    const st = SV_Init();
    spawnC(st, map);
    const trace = SV_ClipTrace(st, SV_TraceFor(map));
    blowDoor20(st, trace);
    setPmoveWorld(trace, bspPointContentsFor(map));
    try {
      for (const crouch of [false, true]) {
        const p = makePmoveState();
        p.origin = v3(28, 60, 30);
        p.velocity = v3();
        for (let i = 0; i < 10; i++) {
          pmoveFull(p, { msec: 100, angles: v3(0, 90, 0), forwardmove: 0, sidemove: 0, upmove: crouch ? -400 : 0, buttons: 0 });
        }
        expect(p.onGround).toBe(true);
        // Walk north through the blown slab band (y 136..144), no jumping.
        let n = 0;
        while (p.origin[1]! <= 144 && n++ < 80) {
          pmoveFull(p, { msec: 100, angles: v3(0, 90, 0), forwardmove: 200, sidemove: 0, upmove: crouch ? -400 : 0, buttons: 0 });
        }
        expect(p.origin[1]!).toBeGreaterThan(140);
        expect(p.origin[1]!).toBeLessThan(200);
        // Stepped up onto the upper landing, never wedged.
        expect(p.origin[2]!).toBeGreaterThan(30);
        expect(p.origin[2]!).toBeLessThan(50);
        expect(p.onGround).toBe(true);
        if (crouch) {
          expect(p.pmFlags & PMF_DUCKED).toBe(PMF_DUCKED);
          expect(p.maxs[2]).toBe(4);
        }
        // Move out again: head back south the way we came.
        const bx = p.origin[0]!;
        const by = p.origin[1]!;
        for (let i = 0; i < 8; i++) {
          pmoveFull(p, { msec: 100, angles: v3(0, 270, 0), forwardmove: 200, sidemove: 0, upmove: crouch ? -400 : 0, buttons: 0 });
        }
        expect(Math.hypot(p.origin[0]! - bx, p.origin[1]! - by)).toBeGreaterThan(5);
        expect(p.onGround).toBe(true);
      }
    } finally {
      resetPmoveWorld();
    }
  });

  it('sprint paces cross at small frame quanta too', { timeout: 300000 }, () => {
    const map = loadBase1();
    resetEdictNums();
    const st = SV_Init();
    spawnC(st, map);
    const trace = SV_ClipTrace(st, SV_TraceFor(map));
    blowDoor20(st, trace);
    setPmoveWorld(trace, bspPointContentsFor(map));
    try {
      for (const msec of [16, 33]) {
        const p = makePmoveState();
        p.origin = v3(28, 60, 30);
        p.velocity = v3();
        for (let i = 0; i < 30; i++) {
          pmoveFull(p, { msec: 100, angles: v3(0, 90, 0), forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 });
        }
        let n = 0;
        while (p.origin[1]! <= 144 && n++ < 600) {
          pmoveFull(p, { msec, angles: v3(0, 90, 0), forwardmove: 400, sidemove: 0, upmove: 0, buttons: 0 });
        }
        expect(p.origin[1]!).toBeGreaterThan(140);
      }
    } finally {
      resetPmoveWorld();
    }
  });

  it('a soldier chases through the blown doorway in pure pursuit', { timeout: 300000 }, () => {
    const map = loadBase1();
    resetEdictNums();
    const st = SV_Init();
    spawnC(st, map);
    const trace = SV_ClipTrace(st, SV_TraceFor(map));
    blowDoor20(st, trace);
    const playerPos = v3(28, 170, 40);
    const m = st.monsters.find((mm) => mm.kind === 'soldier' && !(mm.triggered && !mm.woken))!;
    expect(m).toBeDefined();
    m.edict.origin = v3(28, 40, 40);
    m.seen = true;
    const rand = mulberry32(0x20);
    for (let i = 0; i < 150; i++) {
      // Gate attacks off: pure locomotion pursuit (attack planning is the
      // monster lane's; this pins the body getting through the hole).
      m.reactionAt = st.time + 1000;
      SV_MonsterTick(st, playerPos, trace, null, rand);
      if (m.edict.origin[1]! > 150) break;
    }
    expect(m.edict.origin[1]!).toBeGreaterThan(150);
  });
});

describe.runIf(!!Q2_PAK)('B: crawlspace crouched eye stays under the roof', () => {
  it('ducked camera is in tunnel air, old +12 eye poked into the ceiling', { timeout: 300000 }, () => {
    const map = loadBase1();
    resetEdictNums();
    const st = SV_Init();
    spawnC(st, map);
    const trace = SV_ClipTrace(st, SV_TraceFor(map));
    const contents = bspPointContentsFor(map);
    setPmoveWorld(trace, contents);
    try {
      const Z = v3(0, 0, 0);
      for (const [gx, gy] of [[900, -280], [920, -280]] as const) {
        const p = makePmoveState();
        // Start inside the tunnel (the roof is solid from above).
        p.origin = v3(gx, gy, 0);
        p.velocity = v3();
        for (let i = 0; i < 120; i++) {
          pmoveFull(p, { msec: 100, angles: v3(0, 0, 0), forwardmove: 0, sidemove: 0, upmove: -400, buttons: 0 });
        }
        expect(p.pmFlags & PMF_DUCKED).toBe(PMF_DUCKED);
        // C PM_CheckDuck: ducked eye 2 below the origin (feet+22).
        expect(p.viewheight).toBe(-2);
        expect(p.maxs[2]).toBe(4);
        const o = p.origin;
        // Tunnel roof above the crouched hull top.
        const roof = trace(v3(o[0], o[1], o[2]! + 4), Z, Z, v3(o[0], o[1], o[2]! + 100));
        expect(roof.fraction).toBeLessThan(1);
        const ceilAbs = o[2]! + 4 + roof.fraction * 96;
        // The fixed eye sits below the roof plane, inside the tunnel air:
        // bounded pocket (roof above, floor below, walls north/south), open
        // along the tunnel axis — not the void.
        const eye = v3(o[0], o[1], o[2]! - 2);
        expect(eye[2]!).toBeLessThan(ceilAbs);
        expect(ceilAbs - eye[2]!).toBeLessThan(30);
        const floor = trace(
          eye,
          v3(-16, -16, -24),
          v3(16, 16, 4),
          v3(eye[0], eye[1], eye[2]! - 40),
        );
        expect(floor.fraction).toBeLessThan(1);
        const north = trace(eye, Z, Z, v3(eye[0], eye[1] + 200, eye[2]));
        expect(north.fraction).toBeLessThan(1);
        const south = trace(eye, Z, Z, v3(eye[0], eye[1] - 200, eye[2]));
        expect(south.fraction).toBeLessThan(1);
        // The old +12 eye poked above the roof plane into the cavity (near
        // plane inside the ceiling slab: see-through + void orange). The
        // roof height varies along the tunnel; (900,-280) is the tight spot
        // where the old camera demonstrably breached it.
        if (gx === 900) {
          const oldEye = v3(o[0], o[1], o[2]! + 12);
          expect(oldEye[2]!).toBeGreaterThan(ceilAbs);
        }
        // Releasing duck under the low roof keeps the C hull ducked.
        for (let i = 0; i < 10; i++) {
          pmoveFull(p, { msec: 100, angles: v3(0, 0, 0), forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 });
        }
        expect(p.pmFlags & PMF_DUCKED).toBe(PMF_DUCKED);
      }
    } finally {
      resetPmoveWorld();
    }
  });
});

describe('D: server-tick drowning (P_WorldEffects wiring)', () => {
  it('submerged player ramps 4,6,8... capped, surfaces reset, sounds emitted', () => {
    const st = SV_Init();
    // Synthetic pool: water below z=0. Exercises the SV_GameTick wiring
    // with an explicit contents hook (no map needed).
    const pool = (p: Vec3): number => (p[2]! < 0 ? 2 : 0);
    const open = (s: Vec3, _mi: Vec3, _ma: Vec3, e: Vec3): never => ({
      fraction: 1,
      endpos: e,
      planeNormal: v3(0, 0, 1),
      allsolid: false,
      startsolid: false,
      entityNum: -1,
      contents: 0,
    }) as never;
    const game: SVGameTick = {
      player: { pos: v3(0, 0, 100), mins: v3(-16, -16, -24), maxs: v3(16, 16, 32), view: 22 },
      trace: open,
      contents: pool,
      rand: mulberry32(0xd),
    };
    // Dry tick first (air grace), then submerge past the 12s grace.
    SV_Tick(st, 0.1, game);
    expect(st.playerAirLeft).toBeCloseTo(12, 5);
    game.player.pos = v3(0, 0, -100);
    for (let i = 0; i < 3; i++) SV_Tick(st, 0.1, game);
    // Enter/head-under hooks fire before the 5s event prune can eat them.
    expect(st.sounds.map((s) => s.name)).toContain('player/watr_in.wav');
    const hp: number[] = [st.playerHealth];
    for (let i = 0; i < 300; i++) {
      SV_Tick(st, 0.1, game);
      hp.push(st.playerHealth);
      if (st.playerHealth <= 0) break;
    }
    // Damage ramps per second of submersion past the grace (4,6,8...15
    // per ~10 ticks at 10Hz), never instantly lethal.
    expect(hp[115]).toBe(100); // still grace (t≈11.9)
    expect(hp[130]).toBeLessThan(100); // first drown ticks landed
    const drops: number[] = [];
    for (let i = 1; i < hp.length; i++) {
      if (hp[i]! < hp[i - 1]!) drops.push(hp[i - 1]! - hp[i]!);
    }
    expect(drops.length).toBeGreaterThan(3);
    expect(drops[0]).toBe(4); // skill 1: full first-tick damage
    expect(Math.max(...drops)).toBeLessThanOrEqual(15);
    // Surfacing resets the air + damage ramp, with gasp + exit hooks.
    game.player.pos = v3(0, 0, 100);
    for (let i = 0; i < 5; i++) SV_Tick(st, 0.1, game);
    expect(st.playerAirLeft).toBeCloseTo(12, 5);
    const late = st.sounds.map((s) => s.name);
    expect(late).toContain('player/watr_out.wav');
    expect(late.some((n) => n === 'player/gasp1.wav' || n === 'player/gasp2.wav')).toBe(true);
  });
});
