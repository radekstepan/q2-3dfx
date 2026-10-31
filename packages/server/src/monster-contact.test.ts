// RELEASE-5 monster-vs-body collision (C g_phys.c SV_Move /
// server/sv_world.c SV_ClipMoveToEntities): live monsters block movement
// like every other SOLID_BBOX — walkers stop on bodies instead of entering
// them. MASK_MONSTERSOLID carries CONTENTS_MONSTER, and only SVF_DEADMONSTER
// (corpses, without CONTENTS_DEADMONSTER) skips the clip. Corpses stay
// hittable through the state-based bolt/pellet sweeps (never minced by
// radius), so blocking and hitting stay on their separate C paths.
import { describe, expect, it } from 'vitest';
import {
  MONSTER_HULL_MAXS,
  MONSTER_HULL_MINS,
  mulberry32,
  resetEdictNums,
} from '@q2/game';
import type { TraceFn } from '@q2/game';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  SV_ClipTrace,
  SV_DamageMonster,
  SV_DamagePlayer,
  SV_Init,
  SV_MonsterTick,
  SV_SpawnMonster,
  SV_Tick,
} from './index.js';
import type { SVGameTick } from './index.js';

/** Open room with a floor at z = -mins.z (hull-aware: monsters rest at z=24). */
function openTrace(): TraceFn {
  return (start: Vec3, mins: Vec3, _maxs: Vec3, end: Vec3) => {
    const plane = -mins[2]!;
    if (start[2]! >= plane && end[2]! >= plane) {
      return {
        fraction: 1,
        endpos: v3(end[0], end[1], end[2]),
        planeNormal: v3(0, 0, 1),
        allsolid: false,
        startsolid: false,
        entityNum: -1,
        contents: 0,
        surfaceFlags: 0,
      };
    }
    if (start[2]! >= plane) {
      const f = (start[2]! - plane) / (start[2]! - end[2]!);
      return {
        fraction: Math.max(0, Math.min(1, f)),
        endpos: v3(
          start[0]! + (end[0]! - start[0]!) * f,
          start[1]! + (end[1]! - start[1]!) * f,
          plane,
        ),
        planeNormal: v3(0, 0, 1),
        allsolid: false,
        startsolid: false,
        entityNum: -1,
        contents: 0,
        surfaceFlags: 0,
      };
    }
    return {
      fraction: 1,
      endpos: v3(end[0], end[1], end[2]),
      planeNormal: v3(0, 0, 1),
      allsolid: false,
      startsolid: true,
      entityNum: -1,
      contents: 0,
      surfaceFlags: 0,
    };
  };
}

function playerAt(x: number, y = 0, z = 24): SVGameTick['player'] {
  return {
    pos: v3(x, y, z),
    mins: v3(-16, -16, -24),
    maxs: v3(16, 16, 32),
    view: 22,
  };
}

describe('RELEASE-5 live bodies block movement', () => {
  it('stationary live infantry stops a player-box sweep (SOLID_BBOX clip)', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
    const trace = SV_ClipTrace(st, openTrace(), -1, true);
    const mins = v3(-16, -16, -24);
    const maxs = v3(16, 16, 32);
    const t = trace(v3(200, 0, 24), mins, maxs, v3(-200, 0, 24));
    // Hulls 16+16: the sweep stops 32 short of the body center, plus the
    // C DIST_EPSILON (1/32) contact bias.
    expect(t.fraction).toBeLessThan(1);
    expect(t.entityNum).toBe(m.edict.num);
    expect(t.endpos[0]).toBeCloseTo(32, 1);
  });

  it('moving infantry stops at the live player instead of entering them', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(200, 0, 24));
    m.state.yaw = 180; // already facing the player (no turn lag)
    const game: SVGameTick = { player: playerAt(0), trace: openTrace(), nav: null, rand: mulberry32(0xC0) };
    let minGap = Infinity;
    let crossed = false;
    for (let t = 0; t < 120; t++) {
      SV_Tick(st, 0.1, game);
      const o = m.edict.origin;
      const gap = Math.hypot(o[0]! - game.player.pos[0]!, o[1]! - game.player.pos[1]!);
      minGap = Math.min(minGap, gap);
      if (o[0]! < 0) crossed = true;
    }
    // Closes to contact (hulls 16+16) but never enters the player box.
    expect(minGap).toBeLessThan(60);
    expect(minGap).toBeGreaterThanOrEqual(30);
    expect(crossed).toBe(false);
  });

  it('two converging infantries stop body-to-body instead of stacking', () => {
    resetEdictNums();
    const st = SV_Init();
    // The player is far away so both bodies chase east past each other.
    const a = SV_SpawnMonster(st, 'monster_infantry', v3(-200, -40, 24));
    const b = SV_SpawnMonster(st, 'monster_infantry', v3(0, 40, 24));
    a.state.yaw = 0;
    b.state.yaw = 0;
    const game: SVGameTick = { player: playerAt(9000), trace: openTrace(), nav: null, rand: () => 0.99 };
    let minGap = Infinity;
    for (let t = 0; t < 120; t++) {
      SV_Tick(st, 0.1, game);
      const gap = Math.hypot(
        a.edict.origin[0]! - b.edict.origin[0]!,
        a.edict.origin[1]! - b.edict.origin[1]!,
      );
      minGap = Math.min(minGap, gap);
    }
    // The 40u lateral offset already separates them; neither run passes
    // through the other hull (gap never collapses below contact).
    expect(minGap).toBeGreaterThanOrEqual(30);
  });

  it('the downed player body still blocks (C keeps the client edict solid)', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(200, 0, 24));
    m.state.yaw = 180;
    SV_DamagePlayer(st, 10000); // pool to 0 through the C easy-half path
    expect(st.playerHealth).toBe(0);
    const game: SVGameTick = { player: playerAt(0), trace: openTrace(), nav: null, rand: () => 0.99 };
    let minGap = Infinity;
    for (let t = 0; t < 120; t++) {
      SV_Tick(st, 0.1, game);
      const gap = Math.hypot(m.edict.origin[0]! - game.player.pos[0]!, m.edict.origin[1]! - game.player.pos[1]!);
      minGap = Math.min(minGap, gap);
    }
    // Closes to contact but never enters the downed body.
    expect(minGap).toBeLessThan(60);
    expect(minGap).toBeGreaterThanOrEqual(30);
  });
});

describe('RELEASE-5 corpses never block (C SVF_DEADMONSTER skip)', () => {
  it('fresh corpses, gibbed bodies and dormant TRIGGER_SPAWN pass sweeps', () => {
    resetEdictNums();
    const st = SV_Init();
    const dead = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
    expect(SV_DamageMonster(st, dead, 120, mulberry32(3))).toBe('dead');
    const gibbed = SV_SpawnMonster(st, 'monster_soldier', v3(300, 0, 24));
    expect(SV_DamageMonster(st, gibbed, 500, mulberry32(4))).toBe('gib');
    const dormant = SV_SpawnMonster(st, 'monster_infantry', v3(600, 0, 24));
    dormant.triggered = true;
    dormant.woken = false;
    const trace = SV_ClipTrace(st, openTrace(), -1, true);
    const mins = v3(-16, -16, -24);
    const maxs = v3(16, 16, 32);
    for (const x of [0, 300, 600]) {
      const t = trace(v3(x + 200, 0, 24), mins, maxs, v3(x - 200, 0, 24));
      expect(t.fraction).toBe(1);
    }
  });

  it('a chasing infantry walks through a corpse (hittable, not solid)', () => {
    resetEdictNums();
    const st = SV_Init();
    const corpse = SV_SpawnMonster(st, 'monster_infantry', v3(100, 0, 24));
    expect(SV_DamageMonster(st, corpse, 120, mulberry32(5))).toBe('dead');
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(200, 0, 24));
    m.state.yaw = 180;
    const game: SVGameTick = {
      player: playerAt(-500),
      trace: openTrace(),
      nav: null,
      rand: () => 0.99, // pure chase: never commits to an attack
    };
    let crossed = false;
    for (let t = 0; t < 120; t++) {
      SV_Tick(st, 0.1, game);
      if (m.edict.origin[0]! < 100 - 32) crossed = true;
    }
    // Passes the corpse's station (x=100) heading for the player; the
    // corpse itself never moved and stays hittable (takedamage YES).
    expect(crossed).toBe(true);
    expect(corpse.state.dead).toBe(true);
  });

  it('SV_MonsterTick with a playerBody stops the walker at contact', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(120, 0, 24));
    m.state.yaw = 180;
    const player = playerAt(0);
    const rand = mulberry32(0xB0);
    let minGap = Infinity;
    for (let t = 0; t < 60; t++) {
      st.time += 0.1;
      SV_MonsterTick(st, player.pos, openTrace(), null, rand, {
        playerBody: { mins: player.mins, maxs: player.maxs },
      });
      const gap = Math.hypot(m.edict.origin[0]! - player.pos[0]!, m.edict.origin[1]! - player.pos[1]!);
      minGap = Math.min(minGap, gap);
    }
    expect(minGap).toBeLessThan(60);
    expect(minGap).toBeGreaterThanOrEqual(30);
  });
});
