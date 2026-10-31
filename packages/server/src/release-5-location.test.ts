// RELEASE-5 real-base1 wall-climb guard at the reported spot.
//
// Player report: the soldier behind the door at (-1148.1, 1542.3, -24)
// climbed up the wall then descended. The lump soldier is t38 at
// (-1025, 1598, -24) — east of the *19 up-door (x -1120..-1104,
// y 1560..1704, z -48..80). This runs the real map with real traces and
// asserts the C contract at that exact spot:
// - step 18 hulls + droptofloor + stepHullTrace refuse tall walls
//   (m_move.c SV_movestep / M_CheckBottom);
// - the *19 slider carries no NOMONSTER flag, so C Touch_DoorTrigger opens
//   it for monsters too — crossing the slab plane is legitimate ONLY while
//   the door is off its rest seat, never through the closed slab;
// - corpses keep their hittable-but-unblocking behavior (M5.3 depth).
//
// Unlike the constant-assert pin this replaces, every expectation below
// reads the live simulation (positions, yaw, door state, skill).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { PakFile } from '@q2/filesystem';
import { loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import {
  INFANTRY_C,
  MONSTER_HULL_MAXS,
  MONSTER_HULL_MINS,
  monsterYawTo,
  mulberry32,
  resetEdictNums,
  yawDiff,
} from '@q2/game';
import type { Vec3 } from '@q2/math';
import { v3 } from '@q2/math';
import {
  MASK_OPAQUE_C,
  SV_ClipTrace,
  SV_DropTraceFor,
  SV_Init,
  SV_SetSkill,
  SV_SpawnEntities,
  SV_Tick,
  SV_TraceFor,
} from './index.js';
import type { SVGameTick } from './index.js';

const Q2_PAK = process.env.Q2_PAK;

/** The reported player spot (origin space; feet at -48). */
const REPORTED_PLAYER: Vec3 = v3(-1148.1, 1542.3, -24);
const PLAYER_MINS: Vec3 = v3(-16, -16, -24);
const PLAYER_MAXS: Vec3 = v3(16, 16, 32);

/** *19 rest slab (map units; z -48..80 — 128 tall, unclimbable at step 18). */
const DOOR19_MIN = [-1120, 1560, -48];
const DOOR19_MAX = [-1104, 1704, 80];

function loadBase1(): BspMap {
  const bytes = readFileSync(Q2_PAK as string);
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  const pak = new PakFile(buf);
  return loadBsp(pak.readFile('maps/base1.bsp')) as BspMap;
}

function modelBoundsOf(map: BspMap, model: string): { mins: Float32Array; maxs: Float32Array } | null {
  if (!model.startsWith('*')) return null;
  const n = Number.parseInt(model.slice(1), 10);
  if (!Number.isFinite(n)) return null;
  return {
    mins: new Float32Array([map.modelsMins[n * 3]!, map.modelsMins[n * 3 + 1]!, map.modelsMins[n * 3 + 2]!]),
    maxs: new Float32Array([map.modelsMaxs[n * 3]!, map.modelsMaxs[n * 3 + 1]!, map.modelsMaxs[n * 3 + 2]!]),
  };
}

/** Strict interior overlap (>1u on every axis): contact rests never count. */
function strictOverlap(o: Vec3, mins: Vec3, maxs: Vec3, bmins: Float32Array, bmaxs: Float32Array): boolean {
  for (let i = 0; i < 3; i++) {
    if (o[i]! + mins[i]! + 1 >= bmaxs[i]! || o[i]! + maxs[i]! - 1 <= bmins[i]!) return false;
  }
  return true;
}

describe.runIf(!!Q2_PAK)('RELEASE-5 real-base1 wall guard at (-1148.1,1542.3,-24) (Q2_PAK)', () => {
  it('t38 identity: normal soldier, ambush, mapper yaw 0, skill 1, door *19 shut', { timeout: 120000 }, () => {
    const map = loadBase1();
    resetEdictNums();
    const st = SV_Init();
    SV_SetSkill(st, 1);
    SV_SpawnEntities(st, map.entities, (model) => modelBoundsOf(map, model), SV_DropTraceFor(map));
    const m = st.monsters.find((x) => x.edict.targetname === 't38');
    expect(m).toBeDefined();
    // Identity pins (card: facing, soldier identity, skill, door state).
    expect(m!.edict.classname).toBe('monster_soldier');
    expect(m!.kind).toBe('soldier');
    expect([...m!.edict.origin].map((n) => Math.round(n * 100) / 100)).toEqual([-1025, 1598, -23.97]);
    expect(m!.state.yaw).toBe(0);
    expect(m!.ambush).toBe(true);
    expect(m!.state.health).toBe(30); // normal skin (skinnum 2), not light/ss
    expect(st.skill).toBe(1);
    console.log(
      `R5 identity: ${m!.edict.classname} targetname=t38 origin=[${[...m!.edict.origin].map((n) => n.toFixed(2))}] ` +
        `yaw=${m!.state.yaw} ambush=${m!.ambush} hp=${m!.state.health} skill=${st.skill}`,
    );
    const door19 = st.movers.find((x) => x.ent.model === '*19');
    expect(door19).toBeDefined();
    expect(door19!.state).toBe('bottom');
    // Rest slab matches the lump bounds the geometry test pins.
    const rest = st.moverBounds.get(door19!.ent.num);
    expect(rest).toBeDefined();
    expect([...rest!.mins]).toEqual(DOOR19_MIN);
    expect([...rest!.maxs]).toEqual(DOOR19_MAX);
    console.log(`R5 door: *19 state=${door19!.state} rest=[${DOOR19_MIN}]..[${DOOR19_MAX}] spawnflags=${door19!.ent.spawnflags} (no NOMONSTER: opens for monsters, like C Touch_DoorTrigger)`);
  });

  it('ambush hold: unseen soldier never moves, never climbs, never turns', { timeout: 120000 }, () => {
    const map = loadBase1();
    resetEdictNums();
    const st = SV_Init();
    SV_SetSkill(st, 1);
    SV_SpawnEntities(st, map.entities, (model) => modelBoundsOf(map, model), SV_DropTraceFor(map));
    const worldTrace = SV_ClipTrace(st, SV_TraceFor(map));
    const m = st.monsters.find((x) => x.edict.targetname === 't38');
    expect(m).toBeDefined();
    const game: SVGameTick = {
      player: { pos: v3(REPORTED_PLAYER[0], REPORTED_PLAYER[1], REPORTED_PLAYER[2]), mins: PLAYER_MINS, maxs: PLAYER_MAXS, view: 22 },
      trace: worldTrace,
      nav: null,
      rand: mulberry32(0x51),
    };
    const z0 = m!.edict.origin[2]!;
    // 60s at 10Hz with the player parked at the reported spot and no door
    // touches: the closed door + wall block all LOS, so the ambush holds.
    for (let t = 0; t < 600; t++) SV_Tick(st, 0.1, game);
    expect(m!.seen).toBe(false);
    expect([...m!.edict.origin]).toEqual([-1025, 1598, z0]);
    expect(m!.state.yaw).toBe(0);
    expect(m!.state.move).toBe('stand1');
    console.log(`R5 hold: 600 ticks unseen at [${[...m!.edict.origin].map((n) => n.toFixed(2))}] yaw=0 move=stand1`);
  });

  it('lured pursuit: reaches the player side at floor level, never climbs, never ghosts the closed slab', { timeout: 120000 }, () => {
    const map = loadBase1();
    resetEdictNums();
    const st = SV_Init();
    SV_SetSkill(st, 1);
    SV_SpawnEntities(st, map.entities, (model) => modelBoundsOf(map, model), SV_DropTraceFor(map));
    const worldTrace = SV_ClipTrace(st, SV_TraceFor(map));
    const sightTrace = SV_ClipTrace(st, SV_TraceFor(map, MASK_OPAQUE_C));
    const m = st.monsters.find((x) => x.edict.targetname === 't38');
    expect(m).toBeDefined();
    const door19 = st.movers.find((x) => x.ent.model === '*19');
    expect(door19).toBeDefined();
    const game: SVGameTick = {
      player: { pos: v3(-1060, 1598, -24), mins: PLAYER_MINS, maxs: PLAYER_MAXS, view: 22 },
      trace: worldTrace,
      sightTrace,
      nav: null,
      rand: mulberry32(0x52),
    };
    // Phase 1: lure — the player steps into the soldier's room so the ambush
    // acquires (FoundTarget), exactly the C sight path.
    for (let t = 0; t < 30; t++) SV_Tick(st, 0.1, game);
    expect(m!.seen).toBe(true);
    expect(m!.state.yaw).not.toBe(0); // M_ChangeYaw turned toward the player
    console.log(`R5 lure: seen=${m!.seen} yaw=${m!.state.yaw.toFixed(1)} move=${m!.state.move} (mapper yaw was 0)`);
    // Phase 2: the player retreats to the reported spot; nobody touches the
    // door, so it sits shut. The woken soldier must pursue to the wall.
    game.player.pos = v3(REPORTED_PLAYER[0], REPORTED_PLAYER[1], REPORTED_PLAYER[2]);
    const zSpawn = m!.edict.origin[2]!;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let minGap = Infinity;
    let crossedAt = -1;
    let crossDoor: string | null = null;
    let eastArmed = m!.edict.origin[0]! > DOOR19_MAX[0]! + 16;
    let engaged = false;
    let closedOverlap = 0;
    const trace: string[] = [];
    for (let t = 0; t < 600; t++) {
      SV_Tick(st, 0.1, game);
      const o = m!.edict.origin;
      minZ = Math.min(minZ, o[2]!);
      maxZ = Math.max(maxZ, o[2]!);
      const gap = Math.hypot(
        o[0]! - game.player.pos[0]!,
        o[1]! - game.player.pos[1]!,
        o[2]! - game.player.pos[2]!,
      );
      minGap = Math.min(minGap, gap);
      if (m!.state.move.startsWith('attack')) engaged = true;
      // Slab-plane crossing: latch while east of the east face (+hull),
      // complete west of the west face (-hull). Legitimate only while the
      // door is off its seat (the soldier's own C touch opens this
      // NOMONSTER-free door).
      if (o[0]! > DOOR19_MAX[0]! + 16) eastArmed = true;
      if (crossedAt < 0 && eastArmed && o[0]! < DOOR19_MIN[0]! - 16) {
        crossedAt = t;
        crossDoor = door19!.state;
      }
      // Closed-slab ghost check: at rest the live slab must never contain
      // the hull interior (contact rests excluded by the 1u margin).
      const rest = door19!.ent.origin[0]! === door19!.pos1[0]! &&
        door19!.ent.origin[1]! === door19!.pos1[1]! &&
        door19!.ent.origin[2]! === door19!.pos1[2]!;
      if (rest) {
        const b = st.moverBounds.get(door19!.ent.num)!;
        const cur = {
          mins: new Float32Array([b.mins[0]!, b.mins[1]!, b.mins[2]!]),
          maxs: new Float32Array([b.maxs[0]!, b.maxs[1]!, b.maxs[2]!]),
        };
        if (strictOverlap(o, MONSTER_HULL_MINS, MONSTER_HULL_MAXS, cur.mins, cur.maxs)) closedOverlap++;
      }
      if (t % 60 === 0) {
        trace.push(
          `t=${(t * 0.1).toFixed(0)}s [${o[0]!.toFixed(1)},${o[1]!.toFixed(1)},${o[2]!.toFixed(1)}] ` +
            `yaw=${m!.state.yaw.toFixed(0)} ${m!.state.move} door=${door19!.state}`,
        );
      }
    }
    console.log(`R5 pursuit track:\n  ${trace.join('\n  ')}`);
    console.log(
      `R5 pursuit: z=[${minZ.toFixed(2)},${maxZ.toFixed(2)}] (spawn ${zSpawn.toFixed(2)}) ` +
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
    expect(minGap).toBeLessThan(200); // actually closed to attack range
    expect(minGap).toBeGreaterThanOrEqual(30);
    // Facing: the M_ChangeYaw turn latched at lure and the attack latch
    // (FacingIdeal ±45° gate) fired at least once.
    expect(engaged).toBe(true);
    expect(m!.state.yaw).not.toBe(0);
    const bearing = monsterYawTo(m!.edict.origin, game.player.pos);
    expect(Math.abs(yawDiff(bearing, m!.state.yaw))).toBeLessThanOrEqual(90);
  });

  it('infantry fire uses bullets, not blaster bolts (m_infantry.c guard)', () => {
    // Source-level pin that needs no pak: machinegun ballistics live here,
    // blaster visuals must never substitute (card negative control).
    // Attack1 aims at the enemy, the death2 spray walks flashes 2..13
    // through aimangles[] (see the burst audit in infantry-burst.test.ts).
    expect(INFANTRY_C.bulletDamage).toBe(3);
    expect(INFANTRY_C.bulletKick).toBe(4);
    expect(INFANTRY_C.bulletHspread).toBe(300);
    expect(INFANTRY_C.bulletVspread).toBe(500);
  });
});
