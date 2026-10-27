// Sweep gameplay lane: corpse overkill-mince (g_misc.c) + suit timed
// immunity (p_view.c) at the server tick. Headless: synthetic edicts and a
// synthetic water pool (no pak needed); the driver-level play proofs live
// in apps/web (gib-overkill + breather timed-immunity bot tests).
import { describe, expect, it } from 'vitest';
import { mulberry32, resetEdictNums, spawnEdict } from '@q2/game';
import { v3 } from '@q2/math';
import {
  SV_DamageDeadsoldier,
  SV_Init,
  SV_SetPlayerSuit,
  SV_Tick,
} from './index.js';
import type { PointContentsFn, TraceFn } from '@q2/game';

const MISS_TRACE: TraceFn = (start, _mins, _maxs, end) => ({
  fraction: 1,
  endpos: v3(end[0], end[1], end[2]),
  planeNormal: v3(0, 0, 1),
  allsolid: false,
  startsolid: false,
  entityNum: 0,
  contents: 0,
});

// pmove bit space (game/pmove.ts): WATER 2, SLIME 4, LAVA 8.
const waterPool = (bits: number) => (): number => bits;

function tickGame(bits: number) {
  const contents: PointContentsFn = () => bits;
  return {
    player: { pos: v3(0, 0, 0), mins: v3(-16, -16, -24), maxs: v3(16, 16, 32), view: 22 },
    trace: MISS_TRACE,
    contents,
    rand: mulberry32(7),
  };
}

describe('misc_deadsoldier overkill mince (C misc_deadsoldier_die)', () => {
  it('hits above -80 accumulate without mincing', () => {
    resetEdictNums();
    const st = SV_Init();
    const e = spawnEdict({ classname: 'misc_deadsoldier' });
    expect(e.health).toBe(0);
    expect(SV_DamageDeadsoldier(st, e, 79, mulberry32(1))).toBe(false);
    expect(e.health).toBe(-79);
    expect(e.freed).toBe(false);
    expect(st.gibs).toHaveLength(0);
    expect(st.sounds).toHaveLength(0);
  });

  it('the hit reaching -80 minces: 4x meat + head + udeath, corpse persists', () => {
    resetEdictNums();
    const st = SV_Init();
    const e = spawnEdict({ classname: 'misc_deadsoldier' });
    expect(SV_DamageDeadsoldier(st, e, 79, mulberry32(1))).toBe(false);
    expect(SV_DamageDeadsoldier(st, e, 1, mulberry32(2))).toBe(true);
    expect(e.health).toBe(-80);
    // C keeps the corpse (no G_FreeEdict): still standing scenery.
    expect(e.freed).toBe(false);
    expect(st.gibs).toHaveLength(5);
    expect(st.gibs.filter((g) => g.kind === 'meat')).toHaveLength(4);
    expect(st.gibs.filter((g) => g.kind === 'head')).toHaveLength(1);
    expect(st.sounds.map((s) => s.name)).toContain('misc/udeath.wav');
    expect(e.extra['gibHits']).toBe('1');
  });

  it('overkill past -80 re-minces every hit (never freed)', () => {
    resetEdictNums();
    const st = SV_Init();
    const e = spawnEdict({ classname: 'misc_deadsoldier' });
    SV_DamageDeadsoldier(st, e, 80, mulberry32(1));
    SV_DamageDeadsoldier(st, e, 15, mulberry32(2));
    expect(e.freed).toBe(false);
    expect(st.gibs).toHaveLength(10);
    expect(e.extra['gibHits']).toBe('2');
  });
});

describe('SV_SetPlayerSuit (C breather/enviro framenum domain)', () => {
  it('sets and clears the Until timers', () => {
    const st = SV_Init();
    SV_SetPlayerSuit(st, 130, 140);
    expect(st.playerBreatherUntil).toBe(130);
    expect(st.playerEnviroUntil).toBe(140);
    SV_SetPlayerSuit(st, 0, 0);
    expect(st.playerBreatherUntil).toBe(0);
    expect(st.playerEnviroUntil).toBe(0);
  });
});

describe('suit timed immunity at the tick (C P_WorldEffects branches)', () => {
  it('breather refreshes air: no drowning across 15s submerged', () => {
    const st = SV_Init();
    SV_SetPlayerSuit(st, 1000, 0);
    for (let i = 0; i < 150; i++) SV_Tick(st, 0.1, tickGame(2));
    expect(st.playerHealth).toBe(100);
    expect(st.playerBreatherLeft).toBeGreaterThan(800);
    expect(st.playerAirLeft).toBeGreaterThan(9);
  });

  it('without a suit the same pool drowns on schedule', () => {
    const st = SV_Init();
    for (let i = 0; i < 150; i++) SV_Tick(st, 0.1, tickGame(2));
    expect(st.playerHealth).toBeLessThan(100);
  });

  it('breath sounds alternate u_breath1/2 while submerged+protected', () => {
    // 30 ticks: two breaths (t=0.1, t=2.6), both inside the 5s one-shot
    // prune window at the end (t=3).
    const st = SV_Init();
    SV_SetPlayerSuit(st, 1000, 0);
    for (let i = 0; i < 30; i++) SV_Tick(st, 0.1, tickGame(2));
    const breaths = st.sounds.map((s) => s.name).filter((n) => n.startsWith('player/u_breath'));
    expect(breaths.length).toBeGreaterThanOrEqual(2);
    expect(breaths[0]).toBe('player/u_breath1.wav');
    expect(breaths[1]).toBe('player/u_breath2.wav');
    expect(new Set(breaths).size).toBe(2);
  });

  it('envirosuit cuts lava 3x->1x and immunizes slime', () => {
    const suited = SV_Init();
    SV_SetPlayerSuit(suited, 0, 1000);
    for (let i = 0; i < 10; i++) SV_Tick(suited, 0.1, tickGame(8));
    // 10 ticks x waterlevel 3 x 1 (suited) = 30, no drown (protected air).
    expect(100 - suited.playerHealth).toBe(30);
    // Bare lava sizzles 3x — with pre-supplied air so the matching drown
    // tick (C drowns in lava too) doesn't pollute the sizzle ratio.
    const bare = SV_Init();
    bare.playerWorld.airFinished = 1000;
    for (let i = 0; i < 10; i++) SV_Tick(bare, 0.1, tickGame(8));
    expect(100 - bare.playerHealth).toBe(90);
    const suitedSlime = SV_Init();
    SV_SetPlayerSuit(suitedSlime, 0, 1000);
    for (let i = 0; i < 10; i++) SV_Tick(suitedSlime, 0.1, tickGame(4));
    expect(suitedSlime.playerHealth).toBe(100);
  });

  it('airout fade warning fires once at <=3s remaining', () => {
    const st = SV_Init();
    SV_SetPlayerSuit(st, 2, 0);
    for (let i = 0; i < 30; i++) SV_Tick(st, 0.1, tickGame(0));
    const warns = st.sounds.map((s) => s.name).filter((n) => n === 'items/airout.wav');
    expect(warns).toHaveLength(1);
  });

  it('drown gurps resolve to the C male fallback (real pak lumps)', () => {
    // Short run: the 5s one-shot prune eats older sounds, and the ramp
    // kills the player ~t8 (gurps stop at death) — 30 ticks keeps the
    // drown hooks alive (hp 100-4-6=90 at t=3).
    const st = SV_Init();
    for (let i = 0; i < 30; i++) SV_Tick(st, 0.1, tickGame(2));
    const gurps = st.sounds.map((s) => s.name).filter((n) => n.includes('gurp'));
    expect(gurps.length).toBeGreaterThan(0);
    for (const g of gurps) expect(g.startsWith('*')).toBe(false);
    expect(gurps.every((g) => g === 'player/male/gurp1.wav' || g === 'player/male/gurp2.wav')).toBe(true);
  });
});
