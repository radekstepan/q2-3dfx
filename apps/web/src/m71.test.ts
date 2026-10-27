import { describe, expect, it, vi, afterEach } from 'vitest';
import { resetCVars, setCVar, getCVarString } from '@q2/config';
import { BUTTON_DUCK, isDuckHeld as isDuckHeldCmd } from '@q2/input';
import { CODE_TO_KEY } from '@q2/input/dom';
import type { Entity } from '@q2/renderer-api';
import { MODEL_EXTRA_STRIDE } from '@q2/bsp';
import { moverUse } from '@q2/game';
import {
  bootPlay,
  getSkill,
  skillInhibits,
  worldModelForPickup,
  CONTROLS_HINT,
  SKILL_DEFAULT,
} from './play.js';
import type { UserCmdT } from '@q2/input';
import {
  cvarControlKind,
  cvarOptions,
  cvarOptionLabels,
  skillLabel,
  skillValueForLabel,
  SKILL_LABELS,
} from './dom.js';

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

afterEach(() => {
  resetCVars();
});

describe('M7.1 difficulty dropdown + skill cvar (headless)', () => {
  it('skill options are the 0-3 domain with Easy/Medium/Hard/Nightmare labels', () => {
    expect(cvarControlKind('skill')).toBe('select');
    expect(cvarOptions('skill')).toEqual(['0', '1', '2', '3']);
    expect(cvarOptionLabels('skill')).toEqual(['Easy', 'Medium', 'Hard', 'Nightmare']);
    expect(SKILL_LABELS).toEqual(['Easy', 'Medium', 'Hard', 'Nightmare']);
    // Labeled domains persist bare values; labels are display-only.
    expect(skillLabel(0)).toBe('Easy');
    expect(skillLabel('1')).toBe('Medium');
    expect(skillLabel(2)).toBe('Hard');
    expect(skillLabel(3)).toBe('Nightmare');
    expect(skillLabel(99)).toBe('Nightmare');
    expect(skillLabel('bogus')).toBe('Medium');
    expect(skillValueForLabel('Easy')).toBe(0);
    expect(skillValueForLabel('medium')).toBe(1);
    expect(skillValueForLabel('HARD')).toBe(2);
    expect(skillValueForLabel('nightmare')).toBe(3);
    expect(skillValueForLabel('2')).toBe(2);
    expect(skillValueForLabel('bogus')).toBe(1);
  });

  it('skill cvar defaults to Medium(1), clamps, and persists via setCVar', () => {
    expect(SKILL_DEFAULT).toBe(1);
    expect(getSkill()).toBe(1);
    setCVar('skill', 3);
    expect(getSkill()).toBe(3);
    expect(getCVarString('skill')).toBe('3');
    setCVar('skill', 99);
    expect(getSkill()).toBe(3);
    setCVar('skill', -5);
    expect(getSkill()).toBe(0);
    setCVar('skill', 0);
    expect(getSkill()).toBe(0);
  });

  it('skillInhibits mirrors the C SpawnEntities filter (NOT_EASY/MEDIUM/HARD)', () => {
    // skill 0 inhibits NOT_EASY only; skill 1 NOT_MEDIUM; skill 2/3 NOT_HARD.
    expect(skillInhibits(256, 0)).toBe(true);
    expect(skillInhibits(512, 0)).toBe(false);
    expect(skillInhibits(1024, 0)).toBe(false);
    expect(skillInhibits(256, 1)).toBe(false);
    expect(skillInhibits(512, 1)).toBe(true);
    expect(skillInhibits(1024, 1)).toBe(false);
    expect(skillInhibits(256, 2)).toBe(false);
    expect(skillInhibits(512, 2)).toBe(false);
    expect(skillInhibits(1024, 2)).toBe(true);
    expect(skillInhibits(1024, 3)).toBe(true);
    // 1792 (DM jacket: 1024+512+256) is inhibited on every SP skill.
    for (const s of [0, 1, 2, 3]) expect(skillInhibits(1792, s)).toBe(true);
    expect(skillInhibits(0, 1)).toBe(false);
  });

  it('worldModelForPickup resolves base1 pickups to C world-model lumps', () => {
    expect(worldModelForPickup('item_armor_shard')).toBe('models/items/armor/shard/tris.md2');
    expect(worldModelForPickup('item_armor_combat')).toBe('models/items/armor/combat/tris.md2');
    expect(worldModelForPickup('item_health')).toBe('models/items/healing/medium/tris.md2');
    expect(worldModelForPickup('ammo_shells')).toBe('models/items/ammo/shells/medium/tris.md2');
    expect(worldModelForPickup('item_quad')).toBe('models/items/quaddama/tris.md2');
    expect(worldModelForPickup('weapon_shotgun')).toBe('models/weapons/g_shotg/tris.md2');
    expect(worldModelForPickup('weapon_machinegun')).toBe('models/weapons/g_machn/tris.md2');
    expect(worldModelForPickup('monster_soldier')).toBeNull();
    expect(worldModelForPickup('light')).toBeNull();
  });
});

describe('M7.1 crouch UX (headless)', () => {
  it('KeyC maps to crouch and the cmd duck bit shrinks the pmove hull', () => {
    // The keyboard map lives in @q2/input (M5.1 crouch bind): KeyC → crouch.
    expect(CODE_TO_KEY['KeyC']).toBe('crouch');
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    expect(driver.pm.maxs[2]).toBe(32);
    // What Host.buildUserCmd produces while C is held: BUTTON_DUCK set.
    expect(isDuckHeldCmd({ buttons: BUTTON_DUCK })).toBe(true);
    driver.step({ ...neutralCmd(), buttons: BUTTON_DUCK }, 0.1);
    // First held tick categorizes (C: ON_GROUND comes from the previous
    // tick); the second held tick ducks and holds the ducked hull.
    expect(driver.pm.maxs[2]).toBe(32);
    driver.step({ ...neutralCmd(), buttons: BUTTON_DUCK }, 0.1);
    expect(driver.pm.maxs[2]).toBe(4);
    expect(driver.pm.mins[2]).toBe(-24);
    expect(driver.pm.viewheight).toBe(12);
    // Release clears the flag on the next step (no stuck crouch).
    driver.step(neutralCmd(), 0.1);
    expect(driver.pm.maxs[2]).toBe(32);
    expect(driver.pm.viewheight).toBe(22);
  });

  it('HUD advertises crouch/use/attack keys', () => {
    expect(CONTROLS_HINT).toContain('crouch C');
    expect(CONTROLS_HINT).toContain('use E');
    expect(CONTROLS_HINT).toContain('attack');
  });
});

const WEB_Q2_PAK = process.env.Q2_PAK;

describe.runIf(!!WEB_Q2_PAK)('M7.1 base1 view (real pak, Q2_PAK)', () => {
  async function bootPak(width = 96, height = 72) {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    return bootPlay({ width, height, pak: ingestPak(buf) });
  }

  it('skill filter inhibits per-skill edicts at boot (infantry/jacket/shards)', { timeout: 180000 }, async () => {
    // The server owns the C SpawnEntities filter; the driver wires the
    // latched skill cvar via SV_SetSkill before spawning. monster_infantry:
    // two carry spawnflags 769 (512+256+1) and spawn on hard/nightmare only.
    for (const skill of [0, 1]) {
      setCVar('skill', skill);
      const boot = await bootPak();
      // Wiring proof: the server latched our cvar value.
      expect(boot.driver.server.skill).toBe(skill);
      const inf = boot.driver.server.entities.filter((e) => e.classname === 'monster_infantry');
      expect(inf.length).toBe(3);
      // The NOT bits are stripped after the check (like C): survivors carry
      // only the low bits.
      for (const e of inf) expect(e.spawnflags & 1792).toBe(0);
      // The 1792-flagged DM jacket never spawns in SP; the unflagged SP
      // jacket and the unflagged low-hole armor shards always do.
      const jackets = boot.driver.server.entities.filter((e) => e.classname === 'item_armor_jacket');
      expect(jackets.length).toBe(1);
      expect(jackets[0]!.freed).toBe(false);
      const shards = boot.driver.server.entities.filter((e) => e.classname === 'item_armor_shard');
      expect(shards.length).toBe(5);
      expect(shards.every((e) => !e.freed)).toBe(true);
    }

    setCVar('skill', 2);
    const hard = await bootPak();
    expect(hard.driver.server.skill).toBe(2);
    // Hard keeps the NOT_HARD-free ambush pair: all five infantries spawn.
    expect(hard.driver.server.entities.filter((e) => e.classname === 'monster_infantry').length).toBe(5);
    // Default boot (no explicit skill) is Medium.
    resetCVars();
    const def = await bootPak();
    expect(getSkill()).toBe(1);
    expect(def.driver.server.skill).toBe(1);
  });

  it('sliding doors visibly move rendered faces (DoorSync baseVerts path)', { timeout: 180000 }, async () => {
    const boot = await bootPak();
    const { driver } = boot;
    expect(driver.map).not.toBeNull();
    const map = driver.map!;
    const door = driver.server.movers.find((m) => m.ent.classname === 'func_door');
    expect(door).toBeDefined();
    const n = Number.parseInt(door!.ent.model.slice(1), 10);
    const first = map.modelsExtra[n * MODEL_EXTRA_STRIDE + 1]!;
    const num = map.modelsExtra[n * MODEL_EXTRA_STRIDE + 2]!;
    // Snapshot the live surface verts (the same objects renderView reads).
    const before: Float32Array[] = [];
    for (let f = first; f < first + num; f++) {
      const s = driver.mini.surfaces[f];
      if (s && s.n > 0) before.push(new Float32Array(s.verts));
    }
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((v) => v.length > 0)).toBe(true);
    // Fire the door and run ticks: the mover must leave `bottom`.
    moverUse(door!, driver.server.time);
    for (let i = 0; i < 15; i++) driver.step(neutralCmd(), 0.1);
    const ox = door!.ent.origin[0]! - door!.pos1[0]!;
    const oy = door!.ent.origin[1]! - door!.pos1[1]!;
    const oz = door!.ent.origin[2]! - door!.pos1[2]!;
    expect(Math.hypot(ox, oy, oz)).toBeGreaterThan(1);
    // The rendered faces moved by exactly the mover displacement.
    let moved = 0;
    let k = 0;
    for (let f = first; f < first + num; f++) {
      const s = driver.mini.surfaces[f];
      if (!s || s.n === 0) continue;
      const b = before[k++]!;
      for (let v = 0; v < b.length; v += 3) {
        expect(s.verts[v]! - b[v]!).toBeCloseTo(ox, 4);
        expect(s.verts[v + 1]! - b[v + 1]!).toBeCloseTo(oy, 4);
        expect(s.verts[v + 2]! - b[v + 2]!).toBeCloseTo(oz, 4);
      }
      moved++;
    }
    expect(moved).toBe(before.length);
  });

  it('flyers/banners/pickups get real model handles and reach the renderer', { timeout: 180000 }, async () => {
    const boot = await bootPak();
    const { driver, host } = boot;
    expect(boot.models).not.toBeNull();
    const models = boot.models!;
    // Handles registered (never -1/unregistered; box-critter fallback only
    // for lumps the pak lacks — all of these verified present).
    expect(models.ship).toBeGreaterThanOrEqual(0);
    expect(models.shipSkin).toBeGreaterThanOrEqual(0);
    expect(models.banner).toBeGreaterThanOrEqual(0);
    expect(models.bannerSkin).toBeGreaterThanOrEqual(0);
    expect(models.items['item_armor_shard']).toBeDefined();
    expect(models.items['weapon_shotgun']).toBeDefined();
    // The server's trigger_always pass starts all three flybys at spawn
    // (C behavior), so every ship train is started and rendered.
    const ships = driver.server.trains.filter((t) => t.ship);
    expect(ships.length).toBe(3);
    expect(ships.every((t) => t.started)).toBe(true);
    expect(driver.startedShips()).toBe(3);
    // Both courtyard banners survive as plain edicts (skill-kept).
    const banners = driver.server.entities.filter((e) => !e.freed && e.classname === 'misc_banner');
    expect(banners.length).toBe(2);
    // Live pickups render (low-hole shards included); picked-up ones hide.
    const shard = driver.server.entities.find(
      (e) => e.classname === 'item_armor_shard' && e.origin[2] === -216,
    );
    expect(shard).toBeDefined();
    expect(shard!.freed).toBe(false);
    const extras = driver.extraEntities()!;
    const shardX = extras.filter((x) => x.model === models.items['item_armor_shard']!.model);
    expect(shardX.length).toBe(5);
    expect(shardX.map((x) => [...x.origin!])).toContainEqual([1088, 936, -216]);
    const shipX = extras.filter((x) => x.model === models.ship);
    expect(shipX.length).toBe(3);
    const bannerX = extras.filter((x) => x.model === models.banner);
    expect(bannerX.length).toBe(2);
    // Everything submitted reaches renderView (no invisible/cube fallback).
    let rendered: Entity[] = [];
    const orig = boot.refresh.renderView.bind(boot.refresh);
    vi.spyOn(boot.refresh, 'renderView').mockImplementation((view, world, entities) => {
      rendered = [...entities];
      return orig(view, world, entities);
    });
    host.frame(100);
    expect(rendered.some((e) => e.model === models.ship)).toBe(true);
    expect(rendered.some((e) => e.model === models.banner)).toBe(true);
    expect(rendered.some((e) => e.model === models.items['item_armor_shard']!.model)).toBe(true);
  });

  it('initial view: two spawn barrels, no ghost third, train brush present', { timeout: 180000 }, async () => {
    const boot = await bootPak();
    const { driver, host } = boot;
    // Exactly two live barrels near spawn at the lump origins (G-verified);
    // extras mirror the server list 1:1 (no duplicates, no floaters).
    const near = driver.barrels.filter(
      (b) => Math.hypot(b.origin[0]! - 128, b.origin[1]! + 320) < 400,
    );
    expect(near.length).toBe(2);
    // C M_droptofloor outcome (server-spawned, MASK_MONSTERSOLID): the lump
    // origins rest on the floor with the +1/32 contact epsilon — the server
    // barrel test pins the same rounding, so compare rounded here.
    const rounded = near.map((x) => [Math.round(x.origin[0]!), Math.round(x.origin[1]!), Math.round(x.origin[2]!)]);
    expect(rounded).toContainEqual([136, 40, 0]);
    expect(rounded).toContainEqual([184, -24, 0]);
    const extras = driver.extraEntities()!;
    const barrelX = extras.filter((x) => x.model === boot.models!.barrel);
    // Live exploboxes only: the two func_explosive walls render as grafted
    // brush geometry (DoorSync), never as barrel MD2 proxies.
    expect(barrelX.length).toBe(driver.barrels.filter((b) => !b.edict.freed && !b.isFunc).length);
    const origins = barrelX.map((x) => [Math.round(x.origin![0]!), Math.round(x.origin![1]!), Math.round(x.origin![2]!)].join(','));
    expect(new Set(origins).size).toBe(origins.length);
    expect(origins).toContain('136,40,0');
    expect(origins).toContain('184,-24,0');
    // The func_train brush (*12) rides the DoorSync like the doors: baked at
    // the mapper position, shifted by the authoritative server origin every
    // tick (dormant at its first corner until the *13 button fires it).
    // 9 total: 4 doors + 2 buttons + *12 train + *20/*30 func_explosive.
    expect(driver.doorSyncCount()).toBe(9); // 4 doors + 2 buttons + *12 train + *20 + *30
    const train = driver.server.trains.find((t) => !t.ship)!;
    expect(train).toBeDefined();
    expect(train.ent.model).toBe('*12');
    const map = driver.map!;
    const n = 12;
    const first = map.modelsExtra[n * MODEL_EXTRA_STRIDE + 1]!;
    const num = map.modelsExtra[n * MODEL_EXTRA_STRIDE + 2]!;
    let live = 0;
    for (let f = first; f < first + num; f++) {
      if (driver.mini.surfaces[f]?.n) live++;
    }
    expect(live).toBeGreaterThan(0);
    // The spawn view itself renders (world + both barrels submitted).
    let rendered: Entity[] = [];
    const orig = boot.refresh.renderView.bind(boot.refresh);
    vi.spyOn(boot.refresh, 'renderView').mockImplementation((view, world, entities) => {
      rendered = [...entities];
      return orig(view, world, entities);
    });
    const stats = host.frame(100);
    expect(stats.pixels).toBeGreaterThan(0);
    // Spawn view submits the live exploboxes (func_explosive walls ride the
    // brush graft, never the barrel MD2).
    expect(rendered.filter((e) => e.model === boot.models!.barrel).length).toBe(
      driver.barrels.filter((b) => !b.edict.freed && !b.isFunc).length,
    );
  });

  it('func_train brush follows the server train once started (*13 path)', { timeout: 180000 }, async () => {
    const boot = await bootPak();
    const { driver } = boot;
    const train = driver.server.trains.find((t) => !t.ship)!;
    expect(train.ent.model).toBe('*12');
    // Dormant until used (waits for the *13 secret button like in C).
    expect(train.started).toBe(false);
    const map = driver.map!;
    const first = map.modelsExtra[12 * MODEL_EXTRA_STRIDE + 1]!;
    const num = map.modelsExtra[12 * MODEL_EXTRA_STRIDE + 2]!;
    const before: Float32Array[] = [];
    for (let f = first; f < first + num; f++) {
      const s = driver.mini.surfaces[f];
      if (s && s.n > 0) before.push(new Float32Array(s.verts));
    }
    expect(before.length).toBeGreaterThan(0);
    const p0: [number, number, number] = [train.ent.origin[0]!, train.ent.origin[1]!, train.ent.origin[2]!];
    // Fire it the way the *13 button would, then run ticks: the brush must
    // travel exactly the server displacement (same DoorSync path as doors).
    const { startTrain } = await import('@q2/server');
    startTrain(train, driver.server.time);
    for (let i = 0; i < 10; i++) driver.step(neutralCmd(), 0.1);
    expect(train.started).toBe(true);
    const dx = train.ent.origin[0]! - p0[0];
    const dy = train.ent.origin[1]! - p0[1];
    const dz = train.ent.origin[2]! - p0[2];
    expect(Math.hypot(dx, dy, dz)).toBeGreaterThan(1);
    let k = 0;
    for (let f = first; f < first + num; f++) {
      const s = driver.mini.surfaces[f];
      if (!s || s.n === 0) continue;
      const b = before[k++]!;
      for (let v = 0; v < b.length; v += 3) {
        expect(s.verts[v]! - b[v]!).toBeCloseTo(dx, 4);
        expect(s.verts[v + 1]! - b[v + 1]!).toBeCloseTo(dy, 4);
        expect(s.verts[v + 2]! - b[v + 2]!).toBeCloseTo(dz, 4);
      }
    }
    expect(k).toBe(before.length);
  });
});
