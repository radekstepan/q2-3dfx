// Phase 2 combat numbers (BRAIN.md §15): hull-swept bolt spawn, C damage/skill
// tables, TTK proof, crosshair audit. Base1 skill is 1 (medium).
import { describe, expect, it } from 'vitest';
import {
  INFANTRY_C,
  MONSTER_HULL_MAXS,
  MONSTER_HULL_MINS,
  SOLDIER_HP,
  mulberry32,
  resetEdictNums,
  soldierHealthForSkin,
} from '@q2/game';
import type { TraceFn } from '@q2/game';
import { AngleVectors, v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  SV_DamagePlayer,
  SV_Init,
  SV_MonsterTick,
  SV_PlayerFire,
  SV_SetSkill,
  SV_SpawnEntities,
  SV_SpawnMonster,
  SV_Tick,
  skillMultiplier,
} from './index.js';

/** TraceBox-faithful abutting-slab seam: slab A x in [0,8], slab B x in [8,16]. */
function seamTrace(): TraceFn {
  const solid = (p: Vec3): boolean => p[0]! >= 0 && p[0]! <= 16;
  const slabFrac = (s: number, e: number, lo: number, hi: number): number => {
    const d = e - s;
    if (Math.abs(d) < 1e-9) return s >= lo && s <= hi ? 0 : 1;
    let t0 = (lo - s) / d;
    let t1 = (hi - s) / d;
    if (t0 > t1) {
      const t = t0;
      t0 = t1;
      t1 = t;
    }
    if (t1 < 0 || t0 > 1) return 1;
    return Math.max(0, t0);
  };
  return (start: Vec3, _mins: Vec3, _maxs: Vec3, end: Vec3) => {
    const f = Math.min(
      slabFrac(start[0]!, end[0]!, 0, 8),
      slabFrac(start[0]!, end[0]!, 8, 16),
    );
    return {
      fraction: f,
      endpos: v3(start[0]! + (end[0]! - start[0]!) * f, end[1], end[2]),
      planeNormal: v3(-1, 0, 0),
      allsolid: false,
      startsolid: solid(start),
      entityNum: -1,
      contents: 0,
    };
  };
}

/** Open room with a floor at z = -mins.z (hull-aware: monsters rest at z=24). */
function floorTrace(): TraceFn {
  return (start: Vec3, mins: Vec3, _maxs: Vec3, end: Vec3) => {
    const plane = -mins[2]!;
    if (start[0] === end[0] && start[1] === end[1] && start[2] === end[2]) {
      return {
        fraction: 1,
        endpos: v3(start[0], start[1], start[2]),
        planeNormal: v3(0, 0, 1),
        allsolid: false,
        startsolid: start[2]! < plane,
        entityNum: -1,
        contents: 0,
      };
    }
    if (start[2]! >= plane && end[2]! >= plane) {
      return {
        fraction: 1,
        endpos: v3(end[0], end[1], end[2]),
        planeNormal: v3(0, 0, 1),
        allsolid: false,
        startsolid: false,
        entityNum: -1,
        contents: 0,
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
    };
  };
}

/** cmd angles (deg) aiming eye at target (Q2: pitch positive = down). */
function aimAt(eye: Vec3, target: Vec3): Vec3 {
  const dx = target[0]! - eye[0]!;
  const dy = target[1]! - eye[1]!;
  const dz = target[2]! - eye[2]!;
  const len = Math.hypot(dx, dy, dz) || 1;
  return v3(
    (-Math.asin(dz / len) * 180) / Math.PI,
    (Math.atan2(dy, dx) * 180) / Math.PI,
    0,
  );
}

function monsterCenter(m: { edict: { origin: Vec3 } }): Vec3 {
  return v3(
    m.edict.origin[0],
    m.edict.origin[1],
    m.edict.origin[2]! + (MONSTER_HULL_MINS[2]! + MONSTER_HULL_MAXS[2]!) / 2,
  );
}

describe('Phase 2: hull-swept bolt spawn (no muzzle detonations)', () => {
  it('100 point-blank seam shots all leave the gun and travel', () => {
    // Point-blank at a doorframe seam: feet 20u out, muzzle 24u ahead = 4u
    // inside slab A. The raw first step crosses the A/B abutment
    // (fraction < 1): pre-fix this is a wasted shot + face flash every time.
    const trace = seamTrace();
    const raw = trace(v3(4, 0, 0), v3(0, 0, 0), v3(0, 0, 0), v3(104, 0, 0));
    expect(raw.startsolid).toBe(true);
    expect(raw.fraction).toBeLessThan(1);
    for (let i = 0; i < 100; i++) {
      const st = SV_Init();
      const y = -50 + i; // walk the seam so no two shots share a muzzle
      const feet = v3(-20, y, 0);
      const res = SV_PlayerFire(st, 'weapon_blaster', {
        eye: v3(-20, y, 22),
        feet,
        angles: v3(0, 0, 0),
        viewheight: 22,
        ammo: 0,
        trace,
        rand: mulberry32(i),
      });
      expect(res.fired).toBe(true);
      expect(res.bolt).toBe(true);
      expect(st.bolts).toHaveLength(1);
      // ejected forward past both slabs (never detonated at the muzzle)
      expect(st.bolts[0]!.pos[0]!).toBeGreaterThan(16);
      SV_Tick(
        st,
        0.1,
        {
          player: {
            pos: v3(feet[0], feet[1], feet[2]),
            mins: v3(-16, -16, -24),
            maxs: v3(16, 16, 32),
            view: 22,
          },
          trace,
          rand: mulberry32(i),
        },
      );
      // still flying a full step later, far past the muzzle — no face flash
      expect(st.bolts).toHaveLength(1);
      expect(st.bolts[0]!.pos[0]!).toBeGreaterThan(60);
    }
  });

  it('a muzzle buried in a real wall still detonates C-style (no tunneling)', () => {
    // Ejection caps at BOLT_EJECT_MAX: past it the spawn is still embedded,
    // so the shot touches at the muzzle like C fire_blaster (pullback +
    // blaster_touch) instead of tunneling through the wall.
    const deep: TraceFn = (start, _mins, _maxs, end) => ({
      fraction: 1,
      endpos: v3(end[0], end[1], end[2]),
      planeNormal: v3(0, 0, 1),
      allsolid: false,
      startsolid: start[0]! < 200,
      entityNum: -1,
      contents: 0,
    });
    const st = SV_Init();
    const res = SV_PlayerFire(st, 'weapon_blaster', {
      eye: v3(-20, 0, 22),
      feet: v3(-20, 0, 0),
      angles: v3(0, 0, 0),
      viewheight: 22,
      ammo: 0,
      trace: deep,
      rand: mulberry32(1),
    });
    expect(res.fired).toBe(true);
    expect(res.bolt).toBe(false); // detonated, never spawned
    expect(st.bolts).toHaveLength(0);
    expect(st.explosions.length).toBeGreaterThan(0); // the C touch flash
  });
});

describe('Phase 2: TTK proof (skill 1 = medium)', () => {
  it('point-blank blaster TTK on a basic soldier is <= 4 hits', () => {
    // 30hp / 10dmg = 3 perfect hits; +1 slack for spread/travel. The miss,
    // if any, is in spawn/trace/damage — the driver only forwards eye/feet
    // /angles through SV_PlayerFire.
    const st = SV_Init(); // skill 1 default
    const trace = floorTrace();
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(150, 0, 24));
    expect(m.state.health).toBe(30);
    const rand = mulberry32(0x2b17);
    const player = {
      pos: v3(0, 0, 0),
      mins: v3(-16, -16, -24),
      maxs: v3(16, 16, 32),
      view: 22,
    };
    let shots = 0;
    for (let i = 0; i < 40 && !m.state.dead; i++) {
      const eye = v3(0, 0, 22);
      const res = SV_PlayerFire(st, 'weapon_blaster', {
        eye,
        feet: v3(0, 0, 0),
        angles: aimAt(eye, monsterCenter(m)),
        viewheight: 22,
        ammo: 0,
        trace,
        rand,
      });
      if (res.fired) shots++;
      SV_Tick(st, 0.1, { player, trace, rand });
    }
    expect(m.state.dead).toBe(true);
    expect(shots).toBeLessThanOrEqual(4);
  });

  it('mid-range shotgun TTK stays sane (tight 500/500 SP spread)', () => {
    // C weapon_shotgun_fire passes literal 500, 500 — not the 1000-wide
    // monster default. At 400u a centered 12-pellet shell lands most of its
    // 4dmg pellets on the 32-wide box: 1-2 shells for 30hp.
    const st = SV_Init();
    const trace = floorTrace();
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(400, 0, 24));
    expect(m.state.health).toBe(30);
    const rand = mulberry32(0x97);
    const player = {
      pos: v3(0, 0, 0),
      mins: v3(-16, -16, -24),
      maxs: v3(16, 16, 32),
      view: 22,
    };
    let shots = 0;
    let ammo = 10;
    for (let i = 0; i < 40 && !m.state.dead; i++) {
      const eye = v3(0, 0, 22);
      const res = SV_PlayerFire(st, 'weapon_shotgun', {
        eye,
        feet: v3(0, 0, 0),
        angles: aimAt(eye, monsterCenter(m)),
        viewheight: 22,
        ammo,
        trace,
        rand,
      });
      ammo = res.ammoLeft;
      if (res.fired) shots++;
      SV_Tick(st, 0.1, { player, trace, rand });
    }
    expect(m.state.dead).toBe(true);
    expect(shots).toBeLessThanOrEqual(3);
  });

  it('600u shotgun aggregate pins the 500 SP spread (not the 1000 monster one)', () => {
    // At 600u the spread dominates: the C 500-wide gun lands ~2x the pellets
    // of the 1000-wide monster spread. Ten fixed seeds, fresh sims: the 500
    // gun totals ~23 shells, the 1000 gun ~41. Bound 30 fails pre-fix.
    let total = 0;
    for (let seed = 0; seed < 10; seed++) {
      const st = SV_Init();
      const trace = floorTrace();
      resetEdictNums();
      const m = SV_SpawnMonster(st, 'monster_soldier', v3(600, 0, 24));
      const rand = mulberry32(seed);
      const player = {
        pos: v3(0, 0, 0),
        mins: v3(-16, -16, -24),
        maxs: v3(16, 16, 32),
        view: 22,
      };
      let ammo = 20;
      for (let i = 0; i < 40 && !m.state.dead; i++) {
        const eye = v3(0, 0, 22);
        const res = SV_PlayerFire(st, 'weapon_shotgun', {
          eye,
          feet: v3(0, 0, 0),
          angles: aimAt(eye, monsterCenter(m)),
          viewheight: 22,
          ammo,
          trace,
          rand,
        });
        ammo = res.ammoLeft;
        if (res.fired) total++;
        SV_Tick(st, 0.1, { player, trace, rand });
      }
      expect(m.state.dead).toBe(true);
    }
    expect(total).toBeLessThanOrEqual(30);
  });
});

describe('sustained fire: ss burst is C-true (attack4 + hold, not a fan)', () => {
  it('attack4 pass: 3-10 single-bullet events at 10Hz on the C fire frame', () => {
    // m_soldier.c: soldier_attack always picks soldier_move_attack4 for
    // skinnum 4+ (6 frames, soldier_fire4 at index 2 = attak403, flash
    // machinegun_flash[3]); soldier_fire arms pausetime = level.time +
    // (3 + rand()%8) * FRAMETIME on the first fire frame, and M_MoveFrame
    // (g_monster.c) freezes + re-fires the frame every 0.1s — 3-10 single
    // 2dmg bullets, no wind-up, no spin, no same-tick fan.
    resetEdictNums();
    const st = SV_Init();
    expect(st.skill).toBe(1);
    const m = SV_SpawnMonster(st, 'monster_soldier_ss', v3(0, 0, 24));
    expect(m.edict.extra['skinnum']).toBe('4');
    m.state.yaw = 0;
    m.state.move = 'attack4';
    m.state.frame = 0;
    const trace = floorTrace();
    const fired: number[] = [];
    const tickOf: number[] = [];
    for (let i = 0; i < 20; i++) {
      st.time += 0.1;
      for (const ev of SV_MonsterTick(st, v3(300, 0, 24), trace, null, () => 0.5)) {
        if (ev.move === 'attack4') {
          expect(ev.attack).toBe('machinegun');
          fired.push(ev.frame);
          tickOf.push(i);
        }
      }
    }
    // rand 0.5: hold k = 3 + floor(0.5*8) = 7 frames (0.7s). The arming
    // tick, every frozen tick, and the expiry tick all fire (C: the
    // thinkfunc runs on the expiry tick too, then clears AI_HOLD_FRAME):
    // k+1 = 8 single rounds, all on the C fire frame (attak403, index 2),
    // one per consecutive tick — plus the float-boundary tick the 0.1s
    // accumulation buys (deterministic: 9). No same-tick fan, no spin-up.
    expect(fired).toHaveLength(9);
    expect(fired.every((f) => f === 2)).toBe(true);
    for (let k = 1; k < tickOf.length; k++) expect(tickOf[k]! - tickOf[k - 1]!).toBe(1);
    expect(tickOf[0]).toBe(2); // first shot on the attak403 pass
    // The move plays out after the hold (no infinite freeze).
    expect(m.state.move).toBe('run');
  });

  it('each burst round is one 2dmg bullet (solatck3): skill-1 TTK matches C numbers', () => {
    // C soldier_fire4 -> monster_fire_bullet dmg 2 kick 4, one bullet per
    // 10Hz tick, sound solatck3.wav per shot (cl_fx.c muzzleflash). At
    // skill 1 the 100hp player takes exactly 2 per connecting round.
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_soldier_ss', v3(0, 0, 24));
    m.state.yaw = 0;
    m.state.move = 'attack4';
    m.state.frame = 0;
    const trace = floorTrace();
    const player = {
      pos: v3(300, 0, 24),
      mins: v3(-16, -16, -24),
      maxs: v3(16, 16, 32),
      view: 22,
    };
    const hp0 = st.playerHealth;
    // rand 0: hold k = 3 frames (0.3s); every round connects (pHit 0.6 at
    // 300u, rand 0 always beats it). The arming tick, the frozen ticks,
    // and the expiry tick all fire (C thinkfunc tail): k+1 = 4 rounds plus
    // the float-boundary tick (deterministic: 5). 8 ticks cover the pass
    // without tripping the next M_CheckAttack roll.
    for (let i = 0; i < 8; i++) SV_Tick(st, 0.1, { player, trace, rand: () => 0 });
    expect(st.playerHealth).toBe(hp0 - 5 * 2);
    // One tracer + muzzle + solatck3 per round — single bullets, no fan.
    expect(st.tracers).toHaveLength(5);
    expect(st.muzzles.filter((z) => z.foe)).toHaveLength(5);
    expect(st.sounds.filter((s) => s.name === 'soldier/solatck3.wav')).toHaveLength(5);
  });
});

describe('Phase 2: C damage/skill tables (soldier skins + infantry)', () => {
  it('lump spawn stamps skin HP: light 20 / normal 30 / ss 40', () => {
    // m_soldier.c SP_monster_soldier_light -> 20, SP_monster_soldier -> 30,
    // SP_monster_soldier_ss -> 40 (gib -30 throughout).
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{ "classname" "worldspawn" }\n` +
        `{ "classname" "monster_soldier_light" "origin" "0 0 24" }\n` +
        `{ "classname" "monster_soldier" "origin" "64 0 24" }\n` +
        `{ "classname" "monster_soldier_ss" "origin" "128 0 24" }\n`,
    );
    const hp = (cls: string): number =>
      st.monsters.find((m) => m.edict.classname === cls)!.state.health;
    expect(hp('monster_soldier_light')).toBe(20);
    expect(hp('monster_soldier')).toBe(30);
    expect(hp('monster_soldier_ss')).toBe(40);
    expect(SOLDIER_HP).toEqual({ blaster: 20, shotgun: 30, machinegun: 40 });
    // spawn paths key off the same skin helper (thresholds mirror
    // soldierWeaponForSkin): light skins 0-1, normal 2-3, ss 4+.
    expect(soldierHealthForSkin(0)).toBe(20);
    expect(soldierHealthForSkin(2)).toBe(30);
    expect(soldierHealthForSkin(4)).toBe(40);
  });

  it('synthetic spawns carry the same skin HP (TTK honesty per skin)', () => {
    const st = SV_Init();
    resetEdictNums();
    expect(SV_SpawnMonster(st, 'monster_soldier_light', v3(0, 0, 24)).state.health).toBe(20);
    expect(SV_SpawnMonster(st, 'monster_soldier', v3(64, 0, 24)).state.health).toBe(30);
    expect(SV_SpawnMonster(st, 'monster_soldier_ss', v3(128, 0, 24)).state.health).toBe(40);
  });

  it('easy halves damage to the player; nightmare does NOT scale damage', () => {
    // g_combat.c T_Damage: `if (skill == 0 && !deathmatch && targ->client)
    // damage *= 0.5 (min 1)`. Nightmare skill-3 effects (pain debounce,
    // duck/dodge rates, re-attack odds) are behavioral — there is no damage
    // multiplier anywhere in C, so skillMultiplier stays 1 past easy.
    expect(skillMultiplier(0)).toBe(0.5);
    expect(skillMultiplier(1)).toBe(1);
    expect(skillMultiplier(2)).toBe(1);
    expect(skillMultiplier(3)).toBe(1);
    const st = SV_Init();
    SV_SetSkill(st, 0);
    SV_DamagePlayer(st, 10);
    expect(st.playerHealth).toBe(95);
    SV_SetSkill(st, 3);
    st.playerHealth = 100;
    SV_DamagePlayer(st, 10);
    expect(st.playerHealth).toBe(90); // NOT 80: no nightmare x2 in C
    SV_SetSkill(st, 1);
    st.playerHealth = 100;
    SV_DamagePlayer(st, 10);
    expect(st.playerHealth).toBe(90);
  });

  it('infantry C numbers back the lite def (m_infantry.c, now simulated)', () => {
    // m_infantry.c SP_monster_infantry: 100hp / gib -40 / mass 200;
    // InfantryMachineGun: bullet dmg 3 kick 4 spread 300/500;
    // infantry_smack: fire_hit dmg 5+(rand%5) kick 50.
    expect(INFANTRY_C.health).toBe(100);
    expect(INFANTRY_C.gibHealth).toBe(-40);
    expect(INFANTRY_C.mass).toBe(200);
    expect(INFANTRY_C.bulletDamage).toBe(3);
    expect(INFANTRY_C.bulletKick).toBe(4);
    expect(INFANTRY_C.meleeDamageMin).toBe(5);
    expect(INFANTRY_C.meleeDamageMax).toBe(9);
    expect(INFANTRY_C.meleeKick).toBe(50);
  });
});

describe('Phase 2: crosshair audit (server side of cmd angles -> dir)', () => {
  it('Q2 angle convention: pitch positive = down, yaw 0=+X 90=+Y(left)', () => {
    // q_shared.c AngleVectors, forward = (cp*cy, cp*sy, -sp). Golden-tested
    // in @q2/math; re-pinned here because SV_PlayerFire aims purely off it.
    const f = v3();
    AngleVectors(v3(0, 0, 0), f, undefined, undefined);
    expect(f[0]!).toBeCloseTo(1, 6);
    expect(f[1]!).toBeCloseTo(0, 6);
    expect(f[2]!).toBeCloseTo(0, 6);
    AngleVectors(v3(90, 0, 0), f, undefined, undefined);
    expect(f[0]!).toBeCloseTo(0, 6);
    expect(f[1]!).toBeCloseTo(0, 6);
    expect(f[2]!).toBeCloseTo(-1, 6); // pitch +90 looks straight down
    AngleVectors(v3(-90, 0, 0), f, undefined, undefined);
    expect(f[2]!).toBeCloseTo(1, 6); // pitch -90 looks straight up
    AngleVectors(v3(0, 90, 0), f, undefined, undefined);
    expect(f[0]!).toBeCloseTo(0, 6);
    expect(f[1]!).toBeCloseTo(1, 6);
    // yaw wraps (cmd angles wrap past 360 from mouse turn)
    const a = v3();
    const b = v3();
    AngleVectors(v3(0, 370, 0), a, undefined, undefined);
    AngleVectors(v3(0, 10, 0), b, undefined, undefined);
    expect(a[0]!).toBeCloseTo(b[0]!, 6);
    expect(a[1]!).toBeCloseTo(b[1]!, 6);
    expect(a[2]!).toBeCloseTo(b[2]!, 6);
  });

  it('SV_PlayerFire bolt dir is exactly AngleVectors(cmd angles)', () => {
    // The fired direction is pure cmd-angles math (no eye/muzzle feedback):
    // roll never changes forward (q_shared.c forward has no roll terms), and
    // the driver renders the view from the same angles (view-side check is
    // apps/web-owned, out of this lock).
    const st = SV_Init();
    const trace = floorTrace();
    for (const [pitch, yaw, roll] of [
      [0, 0, 0],
      [-15, 135, 0],
      [10, -90, 30],
      [45, 180, 0],
    ] as const) {
      const angles = v3(pitch, yaw, roll);
      const res = SV_PlayerFire(st, 'weapon_blaster', {
        eye: v3(0, 0, 122),
        feet: v3(0, 0, 100),
        angles,
        viewheight: 22,
        ammo: 0,
        trace,
        rand: mulberry32(3),
      });
      expect(res.fired).toBe(true);
      expect(res.bolt).toBe(true);
      const want = v3();
      AngleVectors(angles, want, undefined, undefined);
      const got = st.bolts[st.bolts.length - 1]!;
      expect(got.dir[0]!).toBeCloseTo(want[0]!, 6);
      expect(got.dir[1]!).toBeCloseTo(want[1]!, 6);
      expect(got.dir[2]!).toBeCloseTo(want[2]!, 6);
      st.bolts.length = 0;
    }
    // roll invariance: same pitch/yaw with and without roll fires identically
    const fire = (roll: number): Vec3 => {
      const s = SV_Init();
      SV_PlayerFire(s, 'weapon_blaster', {
        eye: v3(0, 0, 122),
        feet: v3(0, 0, 100),
        angles: v3(10, -90, roll),
        viewheight: 22,
        ammo: 0,
        trace,
        rand: mulberry32(3),
      });
      return s.bolts[0]!.dir;
    };
    const plain = fire(0);
    const rolled = fire(30);
    expect(rolled[0]!).toBeCloseTo(plain[0]!, 6);
    expect(rolled[1]!).toBeCloseTo(plain[1]!, 6);
    expect(rolled[2]!).toBeCloseTo(plain[2]!, 6);
  });
});
