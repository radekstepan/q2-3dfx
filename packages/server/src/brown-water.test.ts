// R9F-10 — brown-water splash color (g_weapon.c fire_lead water branch).
//
// Ground truth: game/g_weapon.c fire_lead (WATER 32 + strcmp surface
// "*brwater" -> SPLASH_BROWN_WATER 3, else SPLASH_BLUE_WATER 2; SLIME 16,
// LAVA 8 by contents), client/cl_tent.c splash_color table
// (2 -> 0xb0 blue, 3 -> 0x50 brown, 4 -> 0xd0 slime, 5 -> 0xe0 lava).
// Route R9F-10b: WATER resolves brown vs blue through the optional
// SVFireOpts.brownWaterAt surface query (server/game-owned; frozen
// TraceFn/TraceResult and @q2/renderer-api untouched), backed by
// bspBrownWaterFor in @q2/game for real maps.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { PakFile } from '@q2/filesystem';
import { loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { bspBrownWaterFor, mulberry32, resetEdictNums } from '@q2/game';
import type { TraceFn } from '@q2/game';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import { SV_Init, SV_PlayerFire, SV_TraceFor } from './index.js';

const Q2_PAK = process.env.Q2_PAK;

function loadMap(name: string): BspMap {
  const bytes = readFileSync(Q2_PAK as string);
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  const pak = new PakFile(buf);
  return loadBsp(pak.readFile(name)) as BspMap;
}

/** Synthetic water-wall trace: every pellet stops in WATER contents. */
function waterTrace(): TraceFn {
  return (start: Vec3, _mins: Vec3, _maxs: Vec3, end: Vec3) => ({
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
}

/** Synthetic dry-wall trace: pellets stop on solid, no water bits. */
function dryTrace(): TraceFn {
  return (start: Vec3, _mins: Vec3, _maxs: Vec3, end: Vec3) => ({
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
}

describe('R9F-10: brown-water splash class', () => {
  it('synthetic brown query draws the brown class (0x50 base); absent stays blue', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_PlayerFire(st, 'weapon_shotgun', {
      eye: v3(0, 0, 22),
      feet: v3(0, 0, 0),
      angles: v3(0, 0, 0),
      viewheight: 22,
      ammo: 10,
      trace: waterTrace(),
      rand: mulberry32(7),
      brownWaterAt: () => true,
    });
    const brown = st.sparks.filter((s) => s.splash !== undefined);
    expect(brown.length).toBeGreaterThan(0);
    for (const s of brown) {
      expect(s.splash).toBe('brown');
      expect(s.color).toBeGreaterThanOrEqual(0x50);
      expect(s.color).toBeLessThanOrEqual(0x57);
    }

    // Legacy caller (no query): same water still draws blue.
    resetEdictNums();
    const stBlue = SV_Init();
    SV_PlayerFire(stBlue, 'weapon_shotgun', {
      eye: v3(0, 0, 22),
      feet: v3(0, 0, 0),
      angles: v3(0, 0, 0),
      viewheight: 22,
      ammo: 10,
      trace: waterTrace(),
      rand: mulberry32(7),
    });
    const blue = stBlue.sparks.filter((s) => s.splash !== undefined);
    expect(blue.length).toBe(brown.length);
    for (const s of blue) expect(s.splash).toBe('blue');

    // Explicit false query: blue as well (slime/lava unaffected by query).
    resetEdictNums();
    const stFalse = SV_Init();
    SV_PlayerFire(stFalse, 'weapon_shotgun', {
      eye: v3(0, 0, 22),
      feet: v3(0, 0, 0),
      angles: v3(0, 0, 0),
      viewheight: 22,
      ammo: 10,
      trace: waterTrace(),
      rand: mulberry32(7),
      brownWaterAt: () => false,
    });
    for (const s of stFalse.sparks.filter((s) => s.splash !== undefined)) expect(s.splash).toBe('blue');
  });

  it('dry puffs stay dry even with a brown query present (non-water unchanged)', () => {
    resetEdictNums();
    const st = SV_Init();
    SV_PlayerFire(st, 'weapon_shotgun', {
      eye: v3(0, 0, 22),
      feet: v3(0, 0, 0),
      angles: v3(0, 0, 0),
      viewheight: 22,
      ammo: 10,
      trace: dryTrace(),
      rand: mulberry32(7),
      brownWaterAt: () => true,
    });
    expect(st.sparks.length).toBeGreaterThan(0);
    expect(st.sparks.every((s) => s.splash === undefined && s.blood === undefined)).toBe(true);
  });

  it('slime/lava contents keep their class with a brown query present', () => {
    for (const [contents, kind, lo] of [[16, 'slime', 0xd0], [8, 'lava', 0xe0]] as const) {
      resetEdictNums();
      const st = SV_Init();
      const trace: TraceFn = (start, _mins, _maxs, end) => ({
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
        contents,
      });
      SV_PlayerFire(st, 'weapon_shotgun', {
        eye: v3(0, 0, 22),
        feet: v3(0, 0, 0),
        angles: v3(0, 0, 0),
        viewheight: 22,
        ammo: 10,
        trace,
        rand: mulberry32(7),
        brownWaterAt: () => true,
      });
      const splashes = st.sparks.filter((s) => s.splash !== undefined);
      expect(splashes.length).toBeGreaterThan(0);
      for (const s of splashes) {
        expect(s.splash).toBe(kind);
        expect(s.color).toBeGreaterThanOrEqual(lo);
        expect(s.color).toBeLessThanOrEqual(lo + 7);
      }
    }
  });
});

describe.runIf(!!Q2_PAK)('R9F-10: real-asset water (Q2_PAK)', () => {
  it('base1 blue water stays blue; train brown water draws brown', { timeout: 300000 }, () => {
    // Base1: blue pool at (320,1248) — air above z=-200, water leaf at -254.
    const base1 = loadMap('maps/base1.bsp');
    const blueAt = bspBrownWaterFor(base1);
    expect(blueAt(v3(320, 1248, -253.5))).toBe(false);
    resetEdictNums();
    const stBlue = SV_Init();
    const blueTrace = SV_TraceFor(base1, 1 | 2 | 32 | 16 | 8);
    SV_PlayerFire(stBlue, 'weapon_machinegun', {
      eye: v3(320, 1248, -200),
      feet: v3(320, 1248, -222),
      angles: v3(90, 0, 0),
      viewheight: 22,
      ammo: 10,
      trace: blueTrace,
      rand: mulberry32(7),
      brownWaterAt: blueAt,
    });
    const blueSplash = stBlue.sparks.filter((s) => s.splash !== undefined);
    expect(blueSplash.length).toBeGreaterThan(0);
    for (const s of blueSplash) expect(s.splash).toBe('blue');

    // Train: brown pool at (312,384) — air above z=-160, water leaf at -360.
    const train = loadMap('maps/train.bsp');
    const brownAt = bspBrownWaterFor(train);
    expect(brownAt(v3(312, 384, -352.5))).toBe(true);
    expect(brownAt(v3(320, 1248, -253.5))).toBe(false);
    resetEdictNums();
    const stBrown = SV_Init();
    const brownTrace = SV_TraceFor(train, 1 | 2 | 32 | 16 | 8);
    SV_PlayerFire(stBrown, 'weapon_machinegun', {
      eye: v3(312, 384, -160),
      feet: v3(312, 384, -182),
      angles: v3(90, 0, 0),
      viewheight: 22,
      ammo: 10,
      trace: brownTrace,
      rand: mulberry32(7),
      brownWaterAt: brownAt,
    });
    const brownSplash = stBrown.sparks.filter((s) => s.splash !== undefined);
    expect(brownSplash.length).toBeGreaterThan(0);
    for (const s of brownSplash) {
      expect(s.splash).toBe('brown');
      expect(s.color).toBeGreaterThanOrEqual(0x50);
      expect(s.color).toBeLessThanOrEqual(0x57);
    }
  });

  it('real dry wall draws no splash even with the brown query wired', { timeout: 300000 }, () => {
    const base1 = loadMap('maps/base1.bsp');
    const brownAt = bspBrownWaterFor(base1);
    resetEdictNums();
    const st = SV_Init();
    const trace = SV_TraceFor(base1, 1 | 2 | 32 | 16 | 8);
    // Horizontal shot across the start room: solid wall, no water bits.
    SV_PlayerFire(st, 'weapon_machinegun', {
      eye: v3(0, -300, 0),
      feet: v3(0, -300, -22),
      angles: v3(0, 90, 0),
      viewheight: 22,
      ammo: 10,
      trace,
      rand: mulberry32(7),
      brownWaterAt: brownAt,
    });
    expect(st.sparks.length).toBeGreaterThan(0);
    expect(st.sparks.every((s) => s.splash === undefined && s.blood === undefined)).toBe(true);
  });
});
