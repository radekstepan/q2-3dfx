// RELEASE-5 infantry fire audit vs game/m_infantry.c + client/cl_fx.c.
//
// The source uses monster_fire_bullet (g_monster.c -> fire_bullet ->
// fire_lead in g_weapon.c): single aimed bullet per trigger (dmg 3, kick 4,
// spread 300/500), burst paced by the cock-armed AI_HOLD_FRAME hold
// (pausetime = cock + ((rand&15)+3+7) frames, fire frame 7 frames after the
// cock, hold re-fires through the expiry tick: n-6 = 4-19 rounds).
// Client effects per round (CL_ParseMuzzleFlash2, infantry case): yellow
// dlight 200+(rand&31), ParticleEffect(40, color 0) + CL_SmokeAndFlash at
// the MZ2_INFANTRY_MACHINEGUN_* muzzle, infatck1.wav on CHAN_WEAPON;
// wall impact is TE_GUNSHOT (gray puff + smoke + ricochet 3/16). C draws NO
// beam for bullets — the short server tracer streaks are a documented
// readability aid (never muzzle->eye beams), not original visuals.
//
// Negative controls pin what infantry fire must NEVER do: no blaster bolts
// (soldier skin gun), no shotgun/soldier sounds, no melee alias, no green
// bolt visuals, no muzzle/dlight on the flashless smack.
import { describe, expect, it } from 'vitest';
import {
  INFANTRY_C,
  INFANTRY_COCK_SOUND,
  INFANTRY_GUN_SOUND,
  INFANTRY_MELEE_SOUND,
  INFANTRY_SWING_SOUND,
  MONSTER_MELEE_SOUND_ALIAS,
  MZ2_INFANTRY_MACHINEGUN_1,
  SOLDIER_WEAPON_STATS,
  infantryDeathSprayAngles,
  monsterFlashOffset,
  mulberry32,
  projectSource,
  resetEdictNums,
} from '@q2/game';
import type { TraceFn } from '@q2/game';
import { AngleVectors, v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  SV_Init,
  SV_SpawnMonster,
  SV_Tick,
} from './index.js';
import type { SVGameTick } from './index.js';

/** Open room with a floor at z = -mins.z (hull-aware: monsters rest at z=24). */
function floorTrace(): TraceFn {
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

/** Run attack1 from the cock frame; count gun sounds until the move exits. */
function runBurst(rand: () => number): { guns: number; cocks: number; swings: number; bolts: number } {
  resetEdictNums();
  const st = SV_Init();
  const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
  m.state.yaw = 0;
  m.state.move = 'attack1';
  m.state.frame = 3; // attak104 cock: arms the C pausetime this tick
  const game: SVGameTick = { player: playerAt(300), trace: floorTrace(), nav: null, rand };
  let guns = 0;
  let cocks = 0;
  let swings = 0;
  for (let i = 0; i < 40 && m.state.move === 'attack1'; i++) {
    SV_Tick(st, 0.1, game);
    for (const s of st.sounds) {
      if (s.name === INFANTRY_GUN_SOUND) guns++;
      if (s.name === INFANTRY_COCK_SOUND) cocks++;
      if (s.name === INFANTRY_SWING_SOUND) swings++;
    }
    st.sounds.length = 0;
  }
  expect(m.state.move).not.toBe('attack1'); // the hold released, C expiry done
  return { guns, cocks, swings, bolts: st.bolts.length };
}

describe('RELEASE-5 infantry burst timing (m_infantry.c AI_HOLD_FRAME)', () => {
  it('short window (rand 0 -> n=10): cock + 4 single bullets incl. the expiry tick', () => {
    const { guns, cocks, swings, bolts } = runBurst(() => 0);
    expect(cocks).toBe(1); // infatck3 once, on the cock frame only
    expect(guns).toBe(4); // n-6: arrival + 2 frozen replays + expiry replay
    expect(swings).toBe(0);
    expect(bolts).toBe(0); // machinegun: hitscan, never a projectile
  });

  it('long window (rand ~1 -> n=25): cock + 19 single bullets, one per tick', () => {
    const st = { count: 0 };
    void st;
    const { guns, cocks, bolts } = runBurst(() => 0.99999);
    expect(cocks).toBe(1);
    expect(guns).toBe(19);
    expect(bolts).toBe(0);
  });

  it('the burst holds the body in place (C aifunc dist 0 under HOLD)', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
    m.state.yaw = 0;
    m.state.move = 'attack1';
    m.state.frame = 3;
    const game: SVGameTick = { player: playerAt(300), trace: floorTrace(), nav: null, rand: () => 0 };
    const held: Array<[number, number]> = [];
    for (let i = 0; i < 20; i++) {
      SV_Tick(st, 0.1, game);
      if (m.burstHeld) held.push([m.edict.origin[0]!, m.edict.origin[1]!]);
      st.sounds.length = 0;
    }
    expect(held.length).toBeGreaterThan(0);
    for (const [x, y] of held) {
      expect(x).toBeCloseTo(held[0]![0]!, 9);
      expect(y).toBeCloseTo(held[0]![1]!, 9);
    }
  });
});

describe('RELEASE-5 infantry muzzle/flash/light/sound/impact (cl_fx.c)', () => {
  it('representative burst round: MZ2_1 muzzle, foe dlight, infatck1, streak, impact sparks', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
    m.state.yaw = 0;
    m.state.move = 'attack1';
    m.state.frame = 10; // attak111 InfantryMachineGun
    // rand 0: pHit always lands, dlight roll 0 -> intensity exactly 200.
    SV_Tick(st, 0.1, { player: playerAt(300), trace: floorTrace(), rand: () => 0 });
    // Muzzle flash + dlight (C radius 200+(rand&31), yellow, foe-side).
    const foes = st.muzzles.filter((z) => z.foe);
    expect(foes).toHaveLength(1);
    expect(foes[0]!.intensity).toBe(200);
    const fwd = v3();
    const right = v3();
    AngleVectors(v3(0, 0, 0), fwd, right);
    const want = projectSource(v3(m.edict.origin[0], m.edict.origin[1], m.edict.origin[2]), monsterFlashOffset(MZ2_INFANTRY_MACHINEGUN_1), fwd, right);
    expect(foes[0]!.pos[0]!).toBeCloseTo(want[0]!, 9);
    expect(foes[0]!.pos[1]!).toBeCloseTo(want[1]!, 9);
    expect(foes[0]!.pos[2]!).toBeCloseTo(want[2]!, 9);
    // Sound: exactly one infatck1 on the fire tick (cock is a separate frame).
    expect(st.sounds.filter((s) => s.name === INFANTRY_GUN_SOUND)).toHaveLength(1);
    // Damage: one C bullet (dmg 3, the pHit roll is the spread stand-in).
    expect(st.playerHealth).toBe(100 - INFANTRY_C.bulletDamage);
    // Impact sparks at the player hull (TE_GUNSHOT gray puff equivalent).
    expect(st.sparks.length).toBeGreaterThan(0);
    // Short muzzle streak (documented aid: C draws no beam; never eye-ending).
    expect(st.tracers).toHaveLength(1);
  });

  it('miss round: same flash/sound/streak, no damage, no sparks', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
    m.state.yaw = 0;
    m.state.move = 'attack1';
    m.state.frame = 10;
    // rand ~1: pHit never lands, dlight roll maxes at 231.
    SV_Tick(st, 0.1, { player: playerAt(300), trace: floorTrace(), rand: () => 0.99999 });
    expect(st.muzzles.filter((z) => z.foe)).toHaveLength(1);
    expect(st.muzzles.find((z) => z.foe)!.intensity).toBe(200 + ((0.99999 * 32) | 0));
    expect(st.sounds.filter((s) => s.name === INFANTRY_GUN_SOUND)).toHaveLength(1);
    expect(st.playerHealth).toBe(100);
    // A miss leaves no impact sparks (nothing was hit).
    expect(st.sparks).toHaveLength(0);
    expect(st.tracers).toHaveLength(1); // the streak still leaves the muzzle
  });

  it('negative controls: no bolts, no blaster/shotgun/soldier audio, no melee alias', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
    m.state.yaw = 0;
    m.state.move = 'attack1';
    m.state.frame = 3;
    const game: SVGameTick = { player: playerAt(300), trace: floorTrace(), nav: null, rand: mulberry32(0x1f) };
    for (let i = 0; i < 40 && m.state.move === 'attack1'; i++) {
      SV_Tick(st, 0.1, game);
      st.sounds.length = 0;
    }
    expect(st.bolts).toHaveLength(0); // never a soldier-style projectile
    const names = st.sounds.map((s) => s.name);
    expect(names).not.toContain(SOLDIER_WEAPON_STATS.blaster.sound);
    expect(names).not.toContain(SOLDIER_WEAPON_STATS.shotgun.sound);
    expect(names).not.toContain(SOLDIER_WEAPON_STATS.machinegun.sound);
    expect(names).not.toContain(INFANTRY_MELEE_SOUND);
    expect(names).not.toContain(MONSTER_MELEE_SOUND_ALIAS);
  });

  it('melee smack is flashless (C fire_hit): melee2.wav + damage, no muzzle/tracer/bolt', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
    m.state.yaw = 0;
    m.state.move = 'attack2';
    m.state.frame = 5; // attak206 infantry_smack
    const before = st.playerHealth;
    SV_Tick(st, 0.1, { player: playerAt(50), trace: floorTrace(), rand: mulberry32(11) });
    const dealt = before - st.playerHealth;
    expect(dealt).toBeGreaterThanOrEqual(5);
    expect(dealt).toBeLessThanOrEqual(9);
    expect(st.sounds.map((s) => s.name)).toContain(INFANTRY_MELEE_SOUND);
    // fire_hit emits no muzzle flash, no dlight, no tracer, no projectile.
    expect(st.muzzles).toHaveLength(0);
    expect(st.tracers).toHaveLength(0);
    expect(st.bolts).toHaveLength(0);
  });

  it('swing wind-up plays infatck2 with no damage (m_infantry.c infantry_swing)', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_infantry', v3(0, 0, 24));
    m.state.yaw = 0;
    m.state.move = 'attack2';
    m.state.frame = 2; // attak203 infantry_swing
    SV_Tick(st, 0.1, { player: playerAt(50), trace: floorTrace(), rand: mulberry32(11) });
    expect(st.sounds.map((s) => s.name)).toContain(INFANTRY_SWING_SOUND);
    expect(st.playerHealth).toBe(100); // the swing never damages
    expect(st.muzzles).toHaveLength(0);
    expect(st.tracers).toHaveLength(0);
  });

  it('death-spray round flies blind (aimangles, not enemy tracking)', () => {
    const spray = infantryDeathSprayAngles(0, 10);
    expect([...spray]).toEqual([-0.0, -5.0, -0.0]);
    // A sprayed tracer must not chase the player hull (see the full
    // 12-round walk in infantry.test.ts death spray resolves ...).
  });
});
