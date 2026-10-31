// RELEASE-9 server lane: effect-producer audit (boxes 1-3 producer side).
//
// Ground truth: game/g_misc.c (barrel_explode/ThrowDebris/BecomeExplosion,
// func_explosive_explode), game/g_target.c (use_target_splash,
// Use_Target_Speaker, use_target_explosion), game/g_func.c
// (func_timer_think/use), game/g_weapon.c (blaster_touch),
// client/cl_tent.c (TE_SPLASH/TE_BLASTER/TE_EXPLOSION1/2 sounds + colors),
// client/cl_fx.c (CL_BlasterParticles, CL_ParticleEffect).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { PakFile } from '@q2/filesystem';
import { loadBsp } from '@q2/bsp';
import {
  MONSTER_HULL_MAXS,
  MONSTER_HULL_MINS,
  mulberry32,
  resetEdictNums,
  spawnEdict,
} from '@q2/game';
import type { Edict, TraceFn } from '@q2/game';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  SV_AddBarrel,
  SV_BlasterImpact,
  SV_DamageBarrel,
  SV_DrainCenterprints,
  SV_DrainSounds,
  SV_Init,
  SV_PlayerFire,
  SV_SpawnEntities,
  SV_SpawnExplosion,
  SV_SpawnMonster,
  SV_Tick,
  SV_UseMover,
  fireExplosionTarget,
  fireSplashTarget,
  fireTargets,
  splashMovedir,
  useTimer,
} from './index.js';

const Q2_PAK = process.env.Q2_PAK;

/** Zero-argue open trace: nothing blocks, floor plane never near. */
function openTrace(): TraceFn {
  return (start: Vec3, _mins: Vec3, _maxs: Vec3, end: Vec3) => ({
    fraction: 1,
    endpos: v3(end[0], end[1], end[2]),
    planeNormal: v3(0, 0, 1),
    allsolid: false,
    startsolid: false,
    entityNum: -1,
    contents: 0,
  });
}

function farPlayer(): { pos: Vec3; mins: Vec3; maxs: Vec3; view: number } {
  return {
    pos: v3(9000, 9000, 9000),
    mins: v3(-16, -16, -24),
    maxs: v3(16, 16, 32),
    view: 22,
  };
}

function userTargeting(target: string): Edict {
  return spawnEdict({ classname: 'trigger_once', target });
}

describe('RELEASE-9: target_splash producer (g_target.c use_target_splash)', () => {
  it('movedir follows G_SetMovedir (angle -2 down, -1 up, yaw otherwise)', () => {
    expect([...splashMovedir({ angle: '-2' })]).toEqual([0, 0, -1]);
    expect([...splashMovedir({ angle: '-1' })]).toEqual([0, 0, 1]);
    const yaw90 = splashMovedir({ angle: '90' });
    expect(yaw90[0]!).toBeCloseTo(0, 5);
    expect(yaw90[1]!).toBeCloseTo(1, 5);
    expect(yaw90[2]!).toBeCloseTo(0, 5);
    const yaw180 = splashMovedir({ angle: '180' });
    expect(yaw180[0]!).toBeCloseTo(-1, 5);
    expect(yaw180[1]!).toBeCloseTo(0, 5);
    expect(yaw180[2]!).toBeCloseTo(0, 5);
  });

  it('fires a 32-spark TE_SPLASH burst along movedir with the spark sound', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{"classname" "worldspawn"}\n{"classname" "target_splash" "targetname" "tS" "origin" "0 0 64" "angle" "-2" "sounds" "1"}\n`,
    );
    expect(st.splashes.get('tS')).toHaveLength(1);
    expect(st.splashes.get('tS')![0]!.count).toBe(32);
    expect([...st.splashes.get('tS')![0]!.dir]).toEqual([0, 0, -1]);
    fireSplashTarget(st, 'tS', mulberry32(7));
    expect(st.sparks).toHaveLength(32);
    for (const s of st.sparks) {
      expect(s.color).toBeGreaterThanOrEqual(0xe0);
      expect(s.color).toBeLessThanOrEqual(0xe7);
      expect(s.vel).not.toBeNull();
      expect(s.vel![0]!).toBeGreaterThanOrEqual(-20);
      expect(s.vel![0]!).toBeLessThanOrEqual(20);
      expect(s.vel![1]!).toBeGreaterThanOrEqual(-20);
      expect(s.vel![1]!).toBeLessThanOrEqual(20);
      expect(s.vel![2]!).toBeGreaterThanOrEqual(-20);
      expect(s.vel![2]!).toBeLessThanOrEqual(20);
      expect(s.ttl).toBeGreaterThanOrEqual(0.5);
      expect(s.ttl).toBeLessThanOrEqual(0.8);
    }
    // dir-biased: the d*dir term (d = rand&31 down) drags the cloud down.
    const meanZ = st.sparks.reduce((a, s) => a + s.pos[2]!, 0) / st.sparks.length;
    expect(meanZ).toBeLessThan(64 - 5);
    expect(st.sounds).toHaveLength(1);
    expect(['world/spark5.wav', 'world/spark6.wav', 'world/spark7.wav']).toContain(
      st.sounds[0]!.name,
    );
  });

  it('non-spark sounds recolor with no sound hook', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{"classname" "worldspawn"}\n{"classname" "target_splash" "targetname" "tW" "origin" "0 0 0" "sounds" "2"}\n`,
    );
    fireSplashTarget(st, 'tW', mulberry32(3));
    expect(st.sparks).toHaveLength(32);
    for (const s of st.sparks) {
      expect(s.color).toBeGreaterThanOrEqual(0xb0);
      expect(s.color).toBeLessThanOrEqual(0xb7);
    }
    expect(st.sounds).toHaveLength(0);
  });

  it('fires through the G_UseTargets cascade', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{"classname" "worldspawn"}\n{"classname" "target_splash" "targetname" "tS" "origin" "0 0 64" "sounds" "1"}\n`,
    );
    fireTargets(st, userTargeting('tS'));
    expect(st.sparks).toHaveLength(32);
    expect(st.sounds).toHaveLength(1);
  });
});

describe('RELEASE-9: func_timer cadence (g_func.c)', () => {
  const splashLump = `{"classname" "target_splash" "targetname" "tS" "origin" "0 0 64" "sounds" "1"}\n`;

  it('START_ON timers fire on wait cadence; use toggles the loop off', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{"classname" "worldspawn"}\n${splashLump}{"classname" "func_timer" "targetname" "tT" "target" "tS" "wait" "0.5" "spawnflags" "1"}\n`,
    );
    const running = st.timers.find((t) => t.ent.targetname === 'tT')!;
    expect(running.nextAt).toBeCloseTo(1.5, 9);
    for (let i = 0; i < 15; i++) SV_Tick(st, 0.1);
    expect(st.time).toBeCloseTo(1.5, 9);
    expect(st.sparks.length).toBeGreaterThan(0);
    const fired = st.sparks.length;
    // Toggle off via use (C func_timer_use): the cadence stops.
    fireTargets(st, userTargeting('tT'));
    expect(running.nextAt).toBe(-1);
    for (let i = 0; i < 20; i++) SV_Tick(st, 0.1);
    expect(st.sparks.length).toBe(fired);
  });

  it('START_OFF timers wait for a use, then fire immediately', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{"classname" "worldspawn"}\n${splashLump}{"classname" "func_timer" "targetname" "tOff" "target" "tS" "wait" "0.5" "spawnflags" "0"}\n`,
    );
    const idle = st.timers.find((t) => t.ent.targetname === 'tOff')!;
    expect(idle.nextAt).toBe(-1);
    for (let i = 0; i < 30; i++) SV_Tick(st, 0.1);
    expect(st.sparks).toHaveLength(0);
    useTimer(st, idle);
    expect(st.sparks).toHaveLength(32);
    expect(idle.nextAt).toBeCloseTo(st.time + 0.5, 9);
  });
});

describe('RELEASE-9: target_speaker one-shot (g_target.c Use_Target_Speaker)', () => {
  it('one-shot noises play; looped speakers toggle their loop channel', () => {
    // C Use_Target_Speaker (g_target.c): spawnflags&3 toggles ent->s.sound.
    // tB is prestarted (spawnflags&1), so its loop entry exists from spawn;
    // firing stops it, firing again restarts it. One-shots queue positioned.
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{"classname" "worldspawn"}\n{"classname" "target_speaker" "targetname" "tA" "origin" "48 112 88" "noise" "world/brkglas.wav"}\n{"classname" "target_speaker" "targetname" "tB" "origin" "0 0 0" "noise" "world/amb1.wav" "spawnflags" "1"}\n`,
    );
    expect(st.sounds.filter((s) => s.loop === true && s.name === 'world/amb1.wav')).toHaveLength(1);
    fireTargets(st, userTargeting('tA'));
    expect(st.sounds.map((s) => s.name)).toContain('world/brkglas.wav');
    const before = st.sounds.length;
    fireTargets(st, userTargeting('tB'));
    expect(st.sounds).toHaveLength(before - 1);
    expect(st.sounds.some((s) => s.loop === true && s.name === 'world/amb1.wav')).toBe(false);
    fireTargets(st, userTargeting('tB'));
    expect(st.sounds).toHaveLength(before);
    const loop = st.sounds.find((s) => s.loop === true && s.name === 'world/amb1.wav')!;
    expect(loop).toBeDefined();
    expect([...loop.pos]).toEqual([0, 0, 0]);
  });
});

describe('RELEASE-9: barrel/explosive fullness (g_misc.c)', () => {
  function tickGame(st: ReturnType<typeof SV_Init>, ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      SV_Tick(st, 0.1, { player: farPlayer(), trace: openTrace(), rand: mulberry32(i + 1) });
    }
  }

  it('damageless func_explosive frees silently: debris + target, no flash/sound/radius', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{"classname" "worldspawn"}\n{"classname" "target_speaker" "targetname" "tS" "origin" "0 0 0" "noise" "world/brkglas.wav"}\n`,
    );
    const b = SV_AddBarrel(st, v3(28, 140, 64), { isFunc: true, dmg: 0, mass: 800 });
    b.edict.target = 'tS';
    expect(SV_DamageBarrel(st, b, 100)).toBe(true);
    tickGame(st, 3);
    expect(b.edict.freed).toBe(true);
    // mass 800: 8 big (debris1) + 16 small (debris2), C mass formula.
    expect(st.debris).toHaveLength(24);
    // target fired (glass shatter), but no TE, no explosion sound, no radius.
    expect(st.sounds.map((s) => s.name)).toEqual(['world/brkglas.wav']);
    expect(st.explosions).toHaveLength(0);
    expect(st.sparks).toHaveLength(0);
    expect(st.playerHealth).toBe(100);
  });

  it('control: damaging func_explosive booms (explosion1 + rocklx1a + radius)', () => {
    resetEdictNums();
    const st = SV_Init();
    const b = SV_AddBarrel(st, v3(0, 0, 0), { isFunc: true, dmg: 25, mass: 75 });
    expect(SV_DamageBarrel(st, b, 100)).toBe(true);
    // Player inside the dmg+40 = 65 radius takes half-points (attacker rule).
    for (let i = 0; i < 3; i++) {
      SV_Tick(
        st,
        0.1,
        {
          player: {
            pos: v3(20, 0, 0),
            mins: v3(-16, -16, -24),
            maxs: v3(16, 16, 32),
            view: 22,
          },
          trace: openTrace(),
          rand: mulberry32(i + 1),
        },
      );
    }
    expect(b.edict.freed).toBe(true);
    expect(st.debris.length).toBeGreaterThan(0);
    expect(st.explosions).toHaveLength(1);
    expect(st.explosions[0]!.kind).toBe('explosion1');
    expect(st.sounds.map((s) => s.name)).toContain('weapons/rocklx1a.wav');
    expect(st.playerHealth).toBeLessThan(100);
  });

  it('explosion sound follows the TE kind (C cl_tent.c registrations)', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnExplosion(st, v3(0, 0, 0), 0, { kind: 'explosion1', rand: mulberry32(1) });
    SV_SpawnExplosion(st, v3(100, 0, 0), 0, { kind: 'explosion2', rand: mulberry32(2) });
    SV_SpawnExplosion(st, v3(200, 0, 0), 0, { kind: 'blaster', rand: mulberry32(3) });
    const names = st.sounds.map((s) => s.name);
    expect(names).toContain('weapons/rocklx1a.wav');
    expect(names).toContain('weapons/grenlx1a.wav');
    expect(names).not.toContain('world/explod1.wav');
    // blaster flash carries no sound of its own (lashit comes from touch).
    expect(names.filter((n) => n === 'weapons/lashit.wav')).toHaveLength(0);
  });

  it('stacked target_explosion charges all fire (base1 t151 is four edicts)', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{"classname" "worldspawn"}\n{"classname" "target_explosion" "targetname" "tX" "origin" "0 0 0"}\n{"classname" "target_explosion" "targetname" "tX" "origin" "100 0 0"}\n`,
    );
    expect(st.explosionTargets.get('tX')).toHaveLength(2);
    fireExplosionTarget(st, 'tX');
    expect(st.explosions).toHaveLength(2);
  });
});

describe('RELEASE-9: blaster impact event (g_weapon.c blaster_touch)', () => {
  it('wall hit carries the normal with C particle shape + lashit', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_BlasterImpact(st, v3(0, 0, 64), 10, null, mulberry32(3), v3(0, 0, 1));
    expect(st.sparks).toHaveLength(40);
    for (const s of st.sparks) {
      expect(s.color).toBeGreaterThanOrEqual(0xe0);
      expect(s.color).toBeLessThanOrEqual(0xe7);
      expect(s.vel).not.toBeNull();
      // dir*30 + crand*40 along the normal.
      expect(s.vel![0]!).toBeGreaterThanOrEqual(-40);
      expect(s.vel![0]!).toBeLessThanOrEqual(40);
      expect(s.vel![2]!).toBeGreaterThanOrEqual(-10);
      expect(s.vel![2]!).toBeLessThanOrEqual(70);
      expect(s.ttl).toBeGreaterThanOrEqual(0.5);
      expect(s.ttl).toBeLessThanOrEqual(0.8);
    }
    // d*dir bias (d = rand&15 up the normal) lifts the cloud off the wall.
    const top = Math.max(...st.sparks.map((s) => s.pos[2]!));
    expect(top).toBeGreaterThan(64 + 8);
    expect(st.explosions).toHaveLength(1);
    expect(st.explosions[0]!.kind).toBe('blaster');
    expect([...st.explosions[0]!.dir!]).toEqual([0, 0, 1]);
    expect(st.sounds.map((s) => s.name)).toContain('weapons/lashit.wav');
  });

  it('flesh hits deal damage with no TE event (C takedamage branch)', () => {
    resetEdictNums();
    const st = SV_Init();
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(150, 0, 24));
    expect(m.state.health).toBe(30);
    // Freeze the body: ambush holds without sight, the blocked sight trace
    // also suppresses return fire, and the floor trace keeps it grounded.
    m.ambush = true;
    m.seen = false;
    st.bolts.push({
      pos: v3(100, 0, 24),
      dir: v3(1, 0, 0),
      life: 2,
      damage: 10,
      speed: 1000,
      foe: false,
      born: 0,
    });
    const floor: TraceFn = (start, mins, _maxs, end) => {
      void _maxs;
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
        };
      }
      return {
        fraction: 0,
        endpos: v3(start[0], start[1], start[2]),
        planeNormal: v3(0, 0, 1),
        allsolid: false,
        startsolid: false,
        entityNum: -1,
        contents: 0,
      };
    };
    const blind: TraceFn = (start, _mins, _maxs, end) => ({
      fraction: 0,
      endpos: v3(start[0], start[1], start[2]),
      planeNormal: v3(0, 0, 1),
      allsolid: false,
      startsolid: false,
      entityNum: -1,
      contents: 0,
    });
    SV_Tick(
      st,
      0.1,
      {
        player: farPlayer(),
        trace: floor,
        sightTrace: blind,
        rand: mulberry32(11),
      },
    );
    expect(st.bolts).toHaveLength(0);
    expect(m.state.health).toBeLessThan(30);
    // No TE_BLASTER flash, no lashit on flesh (flight trail sparks remain).
    expect(st.explosions).toHaveLength(0);
    expect(st.sounds).toHaveLength(0);
  });
});

describe.runIf(!!Q2_PAK)('RELEASE-9: real base1 effect-producer inventory', () => {
  function loadBase1(): { entities: string } {
    const bytes = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(bytes.length);
    new Uint8Array(buf).set(bytes);
    const pak = new PakFile(buf);
    const map = loadBsp(pak.readFile('maps/base1.bsp')) as unknown as { entities: string };
    return { entities: map.entities };
  }

  it('registers the map splash/timer/speaker/explosion tables', () => {
    resetEdictNums();
    const { entities } = loadBase1();
    const st = SV_Init();
    SV_SpawnEntities(st, entities);
    // 12 timer-driven spark showers, 30 cadence timers, 84 speakers (26
    // named/fireable; 58 unnamed looped ambients + 4 named looped toggles
    // need the audio lane's loop channel — deferred, counted as entities).
    expect(st.splashes.size).toBeGreaterThan(0);
    let splashCount = 0;
    for (const list of st.splashes.values()) splashCount += list.length;
    expect(splashCount).toBe(12);
    expect(st.timers).toHaveLength(30);
    let speakerCount = 0;
    for (const list of st.speakers.values()) speakerCount += list.length;
    expect(speakerCount).toBe(26);
    expect(
      st.entities.filter((e) => !e.freed && e.classname === 'target_speaker'),
    ).toHaveLength(84);
    // Every base1 splash is sounds 1 (sparks), count default 32, no dmg.
    for (const list of st.splashes.values()) {
      for (const sp of list) {
        expect(sp.sounds).toBe(1);
        expect(sp.count).toBe(32);
        expect(sp.dmg).toBe(0);
      }
    }
    // The t2 shower (first-hall timer loop, wait 7 START_ON) fires on its
    // first cadence tick with sparks + a spark sound.
    const t2 = st.timers.find((t) => t.target === 't2');
    expect(t2).toBeDefined();
    expect(t2!.wait).toBe(7);
    fireSplashTarget(st, 't2', mulberry32(1));
    expect(st.sparks.length).toBeGreaterThan(0);
    expect(st.sounds.map((s) => s.name).some((n) => n.startsWith('world/spark'))).toBe(true);
    // Stacked scripted charges: t151 is four edicts, t150 three, t154 two.
    expect(st.explosionTargets.get('t151')).toHaveLength(4);
    expect(st.explosionTargets.get('t150')).toHaveLength(3);
    expect(st.explosionTargets.get('t154')).toHaveLength(2);
  });

  it('monster hull constants referenced by the flesh-touch sweep', () => {
    expect(MONSTER_HULL_MINS).toBeDefined();
    expect(MONSTER_HULL_MAXS).toBeDefined();
  });
});

describe('RELEASE-9 batch R9F: delay / light / mover-sound / message / blood / splash / areaportal', () => {
  it('delayed relay fires through the level.time think (g_utils.c DelayedUse)', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{"classname" "worldspawn"}\n{"classname" "trigger_relay" "targetname" "a" "target" "b" "delay" "0.3"}\n{"classname" "target_secret" "targetname" "b" "message" "x"}\n`,
    );
    fireTargets(st, userTargeting('a'));
    expect(st.foundSecrets).toBe(0);
    expect(st.delayed).toHaveLength(1);
    SV_Tick(st, 0.1);
    expect(st.foundSecrets).toBe(0);
    SV_Tick(st, 0.1);
    SV_Tick(st, 0.1);
    expect(st.foundSecrets).toBe(1);
    expect(st.delayed).toHaveLength(0);
  });

  it('targeted light toggles its style record on/off (g_misc.c light_use)', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{"classname" "worldspawn"}\n{"classname" "light" "targetname" "t159" "style" "32" "spawnflags" "1" "origin" "0 0 0"}\n{"classname" "light" "targetname" "plain" "style" "0" "origin" "0 0 0"}\n`,
    );
    // START_OFF(1) starts dark; a style<32 light installs no use at all.
    expect(st.lightStyles[32]).toBe('a');
    fireTargets(st, userTargeting('t159'));
    expect(st.lightStyles[32]).toBe('m');
    expect(st.lightToggles).toHaveLength(1);
    expect(st.lightToggles[0]).toEqual({ style: 32, value: 'm' });
    fireTargets(st, userTargeting('t159'));
    expect(st.lightStyles[32]).toBe('a');
    expect(st.lightToggles).toHaveLength(2);
    fireTargets(st, userTargeting('plain'));
    expect(st.lightToggles).toHaveLength(2);
  });

  it('door legs queue start/end sounds; silent doors stay silent (g_func.c door_go_up/down)', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{"classname" "worldspawn"}\n{"classname" "func_door" "angle" "0"}\n{"classname" "func_door" "angle" "0" "sounds" "1"}\n`,
    );
    const [loud, silent] = st.movers;
    SV_UseMover(st, loud!);
    SV_UseMover(st, silent!);
    const names = st.sounds.map((s) => s.name);
    expect(names.filter((n) => n === 'doors/dr1_strt.wav')).toHaveLength(1);
    // Travel 120u at 100u/s + radiator: arrival queues the end sound.
    for (let i = 0; i < 30; i++) SV_Tick(st, 0.1);
    expect(st.sounds.map((s) => s.name)).toContain('doors/dr1_end.wav');
  });

  it('buttons queue butn2 on fire; sounds==1 buttons stay silent (g_func.c button_fire)', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{"classname" "worldspawn"}\n{"classname" "func_button" "angle" "0"}\n{"classname" "func_button" "angle" "0" "sounds" "1"}\n`,
    );
    const [loud, silent] = st.movers;
    SV_UseMover(st, loud!);
    SV_UseMover(st, silent!);
    expect(st.sounds.filter((s) => s.name === 'switches/butn2.wav')).toHaveLength(1);
  });

  it('used-entity messages centerprint + talk1 (g_utils.c G_UseTargets)', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(st, `{"classname" "trigger_once" "message" "Crouch here"}\n`);
    const trig = st.entities.find((e) => !e.freed && e.classname === 'trigger_once')!;
    fireTargets(st, trig);
    expect(st.centerprints).toEqual(['Crouch here']);
    expect(st.sounds.map((s) => s.name)).toContain('misc/talk1.wav');
    expect(SV_DrainCenterprints(st)).toEqual(['Crouch here']);
    expect(st.centerprints).toHaveLength(0);
  });

  it('loop channels persist through drain and the 5s prune', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{"classname" "worldspawn"}\n{"classname" "target_speaker" "noise" "world/amb7.wav" "origin" "0 0 64" "spawnflags" "1"}\n`,
    );
    expect(st.sounds.some((s) => s.loop === true)).toBe(true);
    for (let i = 0; i < 60; i++) SV_Tick(st, 0.1);
    const loops = st.sounds.filter((s) => s.loop === true);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.name).toBe('world/amb7.wav');
    const drained = SV_DrainSounds(st);
    expect(drained.some((s) => s.loop === true)).toBe(false);
    expect(st.sounds.filter((s) => s.loop === true)).toHaveLength(1);
  });

  it('shotgun flesh draws blood, dry walls draw plain puffs (g_combat.c TE_BLOOD)', () => {
    resetEdictNums();
    const st = SV_Init();
    const open: TraceFn = (start, _mins, _maxs, end) => ({
      fraction: 1,
      endpos: v3(end[0], end[1], end[2]),
      planeNormal: v3(0, 0, 1),
      allsolid: false,
      startsolid: false,
      entityNum: -1,
      contents: 0,
    });
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(150, 0, 24));
    const eye = v3(0, 0, 22);
    const center = v3(
      m.edict.origin[0],
      m.edict.origin[1],
      m.edict.origin[2]! + (MONSTER_HULL_MINS[2]! + MONSTER_HULL_MAXS[2]!) / 2,
    );
    const dx = center[0]! - eye[0]!;
    const dy = center[1]! - eye[1]!;
    const dz = center[2]! - eye[2]!;
    const yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
    const pitch = (-Math.asin(dz / Math.hypot(dx, dy, dz)) * 180) / Math.PI;
    SV_PlayerFire(st, 'weapon_shotgun', {
      eye,
      feet: v3(0, 0, 0),
      angles: v3(pitch, yaw, 0),
      viewheight: 22,
      ammo: 10,
      trace: open,
      rand: mulberry32(0x9e37),
    });
    expect(m.state.health).toBeLessThan(30);
    const blood = st.sparks.filter((s) => s.blood === true);
    expect(blood.length).toBeGreaterThan(0);
    for (const s of blood) {
      expect(s.color).toBeGreaterThanOrEqual(0xe8);
      expect(s.color).toBeLessThanOrEqual(0xef);
    }
    // Gib path untouched: a lethal shell still minces through SV_DamageMonster.
    expect(m.state.gibbed || m.state.dead || m.state.health < 30).toBe(true);
  });

  it('shotgun vs water draws a splash-class event; dry puffs unchanged (g_weapon.c fire_lead)', () => {
    resetEdictNums();
    const st = SV_Init();
    const water: TraceFn = (start, _mins, _maxs, end) => ({
      fraction: 0.5,
      endpos: v3(
        start[0]! + (end[0]! - start[0]!) * 0.5,
        start[1]! + (end[1]! - start[1]!) * 0.5,
        start[2]! + (end[2]! - start[2]!) * 0.5,
      ),
      planeNormal: v3(0, 0, 1),
      allsolid: false,
      startsolid: false,
      entityNum: -1,
      contents: 32,
    });
    SV_PlayerFire(st, 'weapon_shotgun', {
      eye: v3(0, 0, 22),
      feet: v3(0, 0, 0),
      angles: v3(0, 0, 0),
      viewheight: 22,
      ammo: 10,
      trace: water,
      rand: mulberry32(7),
    });
    const splashes = st.sparks.filter((s) => s.splash !== undefined);
    expect(splashes.length).toBeGreaterThan(0);
    for (const s of splashes) expect(s.splash).toBe('blue');
    // Dry wall: plain gray puff, no splash/blood markers.
    const st2 = SV_Init();
    const wall: TraceFn = (start, _mins, _maxs, end) => ({
      fraction: 0.5,
      endpos: v3(
        start[0]! + (end[0]! - start[0]!) * 0.5,
        start[1]! + (end[1]! - start[1]!) * 0.5,
        start[2]! + (end[2]! - start[2]!) * 0.5,
      ),
      planeNormal: v3(0, 0, 1),
      allsolid: false,
      startsolid: false,
      entityNum: -1,
      contents: 0,
    });
    SV_PlayerFire(st2, 'weapon_shotgun', {
      eye: v3(0, 0, 22),
      feet: v3(0, 0, 0),
      angles: v3(0, 0, 0),
      viewheight: 22,
      ammo: 10,
      trace: wall,
      rand: mulberry32(7),
    });
    expect(st2.sparks.length).toBeGreaterThan(0);
    expect(st2.sparks.every((s) => s.splash === undefined && s.blood === undefined)).toBe(true);
  });

  it('door travel drives its areaportal record; portal-less doors unaffected (g_func.c door_use_areaportals)', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_SpawnEntities(
      st,
      `{"classname" "worldspawn"}\n{"classname" "func_areaportal" "targetname" "t69" "style" "1"}\n{"classname" "func_door" "angle" "0" "target" "t69"}\n{"classname" "func_door" "angle" "90"}\n`,
    );
    // C SP_func_areaportal starts closed.
    expect(st.areaPortals['t69']).toBe(false);
    const [with_, without] = st.movers;
    SV_UseMover(st, with_!);
    expect(st.areaPortals['t69']).toBe(true);
    SV_UseMover(st, without!);
    expect(Object.keys(st.areaPortals)).toEqual(['t69']);
    // Full travel: up leg, 3s hold, down leg lands shut again.
    for (let i = 0; i < 80; i++) SV_Tick(st, 0.1);
    expect(st.areaPortals['t69']).toBe(false);
  });
});
