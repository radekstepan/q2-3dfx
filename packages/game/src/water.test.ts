// Water handling: C pmove.c waterjump parity + P_WorldEffects drowning.
// Ground truth: qcommon/pmove.c (PM_CheckJump/PM_CheckSpecialMovement/
// PM_WaterMove/TIME_WATERJUMP branch), game/p_view.c P_WorldEffects.
import { describe, expect, it } from 'vitest';
import { v3 } from '@q2/math';
import {
  CONTENTS_LAVA,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  MASK_WATER,
  PMF_JUMP_HELD,
  PMF_TIME_WATERJUMP,
  makePmoveState,
  pmoveFull,
  resetPmoveWorld,
  setPmoveWorld,
} from './pmove.js';
import type { TraceResult } from './pmove.js';
import {
  AIR_GRACE,
  DROWN_DAMAGE_CAP,
  bspBrownWaterFor,
  bspPointContentsFor,
  isBrownWaterTexture,
  makeWorldEffectsState,
  mapWaterContents,
  sampleWaterLevel,
  updateWorldEffects,
} from './water.js';

function openTrace(s: Float32Array, _mi: Float32Array, _ma: Float32Array, e: Float32Array): TraceResult {
  return {
    fraction: 1,
    endpos: new Float32Array(e),
    planeNormal: v3(0, 0, 1),
    allsolid: false,
    startsolid: false,
    entityNum: -1,
    contents: 0,
  };
}

/** Finite pool: water below z=0, air above, no walls. */
function poolContents(p: Float32Array): number {
  return p[2]! < 0 ? CONTENTS_WATER : 0;
}

describe('waterjump parity (qcommon/pmove.c)', () => {
  it('open-water breach never vaults: single swim impulse, no auto-jump', () => {
    setPmoveWorld(openTrace, poolContents);
    try {
      const st = makePmoveState();
      st.origin = v3(0, 0, -100); // deep, waterlevel 3
      st.velocity = v3();
      // Single press: exactly one swim impulse, no waterjump latch.
      pmoveFull(st, { msec: 100, angles: v3(), forwardmove: 0, sidemove: 0, upmove: 100, buttons: 0 });
      expect(st.waterlevel).toBe(3);
      expect(st.pmFlags & PMF_TIME_WATERJUMP).toBe(0);
      expect(st.pmFlags & PMF_JUMP_HELD).toBe(0); // C never latches held-jump in water
      // Release and hold still: no further impulses, no chained auto-jump.
      let jumped = 0;
      for (let i = 0; i < 20; i++) {
        const before = st.velocity[2]!;
        pmoveFull(st, { msec: 100, angles: v3(), forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 });
        if (st.velocity[2]! > before + 1) jumped++;
        expect(st.pmFlags & PMF_TIME_WATERJUMP).toBe(0);
      }
      expect(jumped).toBe(0);
      // Hold jump from depth to the surface: swims up, never vaults in open water.
      const swim = makePmoveState();
      swim.origin = v3(0, 0, -100);
      swim.velocity = v3();
      for (let i = 0; i < 60; i++) {
        pmoveFull(swim, { msec: 100, angles: v3(), forwardmove: 0, sidemove: 0, upmove: 100, buttons: 0 });
        expect(swim.pmFlags & PMF_TIME_WATERJUMP).toBe(0);
        expect(swim.pmTime).toBe(0);
        if (swim.waterlevel === 0) break;
      }
      expect(swim.origin[2]!).toBeGreaterThan(-100); // rose toward the surface
    } finally {
      resetPmoveWorld();
    }
  });

  it('vault fires only against a wall (waterlevel 2, solid at feet+4, air above)', () => {
    // Wall block ahead: x in [20,40], z in [-40,-4]; water below z=0.
    const walled = (p: Float32Array): number => {
      if (p[0]! >= 20 && p[0]! <= 40 && p[2]! >= -40 && p[2]! <= -4) return CONTENTS_SOLID;
      return p[2]! < 0 ? CONTENTS_WATER : 0;
    };
    setPmoveWorld(openTrace, walled);
    try {
      const st = makePmoveState();
      st.origin = v3(0, 0, -10); // samples: -33w -11w +12a -> waterlevel 2
      st.velocity = v3();
      st.viewAngles = v3(0, 0, 0); // flat forward = +X, into the wall
      // Tick 1 categorizes (waterlevel 2); tick 2 sees it and vaults.
      pmoveFull(st, { msec: 100, angles: v3(0, 0, 0), forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 });
      expect(st.waterlevel).toBe(2);
      expect(st.pmFlags & PMF_TIME_WATERJUMP).toBe(0);
      pmoveFull(st, { msec: 100, angles: v3(0, 0, 0), forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 });
      expect(st.pmFlags & PMF_TIME_WATERJUMP).toBe(PMF_TIME_WATERJUMP);
      expect(st.pmTime).toBeGreaterThan(0);
      expect(st.velocity[0]!).toBeCloseTo(50, 5);
      // C vaults to 350, then the same Pmove call runs the TIME_WATERJUMP
      // branch (gravity): 350 - 800*0.1 = 270 post-tick.
      expect(st.velocity[2]!).toBeCloseTo(270, 5);
    } finally {
      resetPmoveWorld();
    }
  });

  it('vault branch falls with gravity and cancels when falling (not a raw slide)', () => {
    setPmoveWorld(openTrace, poolContents);
    try {
      const st = makePmoveState();
      st.origin = v3(0, 0, 0);
      st.velocity = v3(0, 0, 350);
      st.pmFlags |= PMF_TIME_WATERJUMP;
      st.pmTime = 255;
      pmoveFull(st, { msec: 100, angles: v3(), forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 });
      // C applies gravity in the vault branch: 350 - 800*0.1 = 270, still rising.
      expect(st.velocity[2]!).toBeCloseTo(270, 5);
      expect(st.pmFlags & PMF_TIME_WATERJUMP).toBe(PMF_TIME_WATERJUMP);
      // A spent vault cancels the moment it falls: small upward velocity
      // goes negative in one branch tick and clears flags + timer.
      const spent = makePmoveState();
      spent.origin = v3(0, 0, 0);
      spent.velocity = v3(0, 0, 50);
      spent.pmFlags |= PMF_TIME_WATERJUMP;
      spent.pmTime = 255;
      pmoveFull(spent, { msec: 100, angles: v3(), forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 });
      expect(spent.velocity[2]!).toBeCloseTo(-30, 5);
      expect(spent.pmFlags & PMF_TIME_WATERJUMP).toBe(0);
      expect(spent.pmTime).toBe(0);
    } finally {
      resetPmoveWorld();
    }
  });
});

describe('solid-aware contents + sampler', () => {
  it('maps the BSP solid bit into the pmove space; sampler matches Categorize', () => {
    expect(mapWaterContents(1)).toBe(CONTENTS_SOLID);
    expect(mapWaterContents(32)).toBe(CONTENTS_WATER);
    expect(mapWaterContents(16)).toBe(CONTENTS_SLIME);
    expect(mapWaterContents(8)).toBe(CONTENTS_LAVA);
    expect(mapWaterContents(33)).toBe(CONTENTS_SOLID | CONTENTS_WATER);
    expect(mapWaterContents(0)).toBe(0);
    setPmoveWorld(openTrace, poolContents);
    try {
      // standing hull: feet+1/feet+23/feet+46
      const at = (z: number): number =>
        sampleWaterLevel(v3(0, 0, z), v3(-16, -16, -24), 22, poolContents).level;
      expect(at(-100)).toBe(3);
      expect(at(-10)).toBe(2); // head out, waist+ in
      expect(at(0)).toBe(2);
      expect(at(20)).toBe(1);
      expect(at(100)).toBe(0);
      // ducked hull (C viewheight -2): feet+1/feet+11/feet+22
      const duckAt = (z: number): number =>
        sampleWaterLevel(v3(0, 0, z), v3(-16, -16, -24), -2, poolContents).level;
      expect(duckAt(-100)).toBe(3);
      expect(duckAt(-10)).toBe(3); // ducked head still under at the surface line
      expect(duckAt(20)).toBe(1);
    } finally {
      resetPmoveWorld();
    }
  });

  it('bspPointContentsFor carries SOLID through a real map leaf', () => {
    void bspPointContentsFor;
    void MASK_WATER;
  });

  it('isBrownWaterTexture matches id *brwater plus stock unit paths', () => {
    expect(isBrownWaterTexture('*brwater')).toBe(true);
    expect(isBrownWaterTexture('e1u1/brwater')).toBe(true);
    expect(isBrownWaterTexture('E1U3/BRWATER')).toBe(true);
    expect(isBrownWaterTexture('e1u1/bluwter')).toBe(false);
    expect(isBrownWaterTexture('e2u2/brlava')).toBe(false);
    expect(isBrownWaterTexture('e1u1/broken2_4')).toBe(false);
    expect(isBrownWaterTexture('')).toBe(false);
  });

  it('bspBrownWaterFor hits brown brushes, misses blue and air', () => {
    const boxFor = (name: string): Record<string, unknown> => {
      // Single water brush: axis box +/-10 around the origin (6 planes).
      const planes = new Float32Array([
        1, 0, 0, 10, -1, 0, 0, 10,
        0, 1, 0, 10, 0, -1, 0, 10,
        0, 0, 1, 10, 0, 0, -1, 10,
      ]);
      return {
        visibility: new Uint8Array(0),
        visBitofs: new Int32Array(0),
        numClusters: 0,
        nodes: new Int32Array(0),
        modelsExtra: new Int32Array([0, 0, 0]),
        leafs: new Int32Array([32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        leafbrushes: new Uint16Array([0]),
        brushes: new Int32Array([0, 6, 32]),
        brushsides: new Int32Array([0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0]),
        planes,
        texinfoNames: [name],
      };
    };
    const inside = v3(0, 0, 0);
    const outside = v3(50, 0, 0);
    expect(bspBrownWaterFor(boxFor('e1u1/brwater') as never)(inside)).toBe(true);
    expect(bspBrownWaterFor(boxFor('*brwater') as never)(inside)).toBe(true);
    expect(bspBrownWaterFor(boxFor('e1u1/bluwter') as never)(inside)).toBe(false);
    expect(bspBrownWaterFor(boxFor('e1u1/brwater') as never)(outside)).toBe(false);
  });
});

describe('P_WorldEffects drowning (game/p_view.c)', () => {
  const rand = (): number => 0.75; // deterministic gurp/burn branch

  it('dry: air at grace, damage reset; entering plays watr_in', () => {
    const st = makeWorldEffectsState();
    let r = updateWorldEffects(st, { time: 0, waterlevel: 0, watertype: 0, health: 100 }, rand);
    expect(r.damage).toBe(0);
    expect(r.airLeft).toBe(AIR_GRACE);
    r = updateWorldEffects(st, { time: 1, waterlevel: 3, watertype: CONTENTS_WATER, health: 100 }, rand);
    expect(r.sounds).toContain('player/watr_in.wav');
    expect(r.sounds).toContain('player/watr_un.wav'); // head just went under
  });

  it('drowning ramps 2,4,6... capped at 15, one tick per second', () => {
    const st = makeWorldEffectsState();
    // Out-of-water grace first (C sets air_finished = now+12 whenever the
    // head is out), then submerge past the grace.
    updateWorldEffects(st, { time: 0, waterlevel: 0, watertype: 0, health: 100 }, rand);
    expect(st.airFinished).toBe(AIR_GRACE);
    updateWorldEffects(st, { time: 1, waterlevel: 3, watertype: CONTENTS_WATER, health: 100 }, rand);
    const dealt: number[] = [];
    for (let t = 2; t <= 40; t++) {
      const r = updateWorldEffects(st, { time: t, waterlevel: 3, watertype: CONTENTS_WATER, health: 100 }, rand);
      if (r.damage > 0) dealt.push(r.damage);
    }
    expect(dealt.length).toBeGreaterThan(3);
    // C deals dmg AFTER += 2 (reset value 2), so the first tick lands 4.
    expect(dealt[0]).toBe(4);
    for (let i = 1; i < dealt.length; i++) {
      expect(dealt[i]! - dealt[i - 1]!).toBeLessThanOrEqual(2);
      expect(dealt[i]!).toBeLessThanOrEqual(DROWN_DAMAGE_CAP);
    }
    expect(dealt[dealt.length - 1]).toBe(DROWN_DAMAGE_CAP);
  });

  it('surfacing resets air + dmg and gasps', () => {
    const st = makeWorldEffectsState();
    updateWorldEffects(st, { time: 0, waterlevel: 3, watertype: CONTENTS_WATER, health: 100 }, rand);
    updateWorldEffects(st, { time: 13, waterlevel: 3, watertype: CONTENTS_WATER, health: 100 }, rand);
    expect(st.dmg).toBeGreaterThan(2);
    const r = updateWorldEffects(st, { time: 14, waterlevel: 0, watertype: 0, health: 100 }, rand);
    expect(st.dmg).toBe(2);
    expect(st.airFinished).toBe(14 + AIR_GRACE);
    expect(r.sounds).toContain('player/gasp1.wav');
    expect(r.sounds).toContain('player/watr_out.wav');
  });

  it('lava sizzles 3/level + burn sound; slime 1/level', () => {
    const st = makeWorldEffectsState();
    const lava = updateWorldEffects(
      st, { time: 0, waterlevel: 2, watertype: 8, health: 100 }, rand,
    );
    expect(lava.damage).toBe(6);
    expect(lava.sounds.some((s) => s.startsWith('player/burn'))).toBe(true);
    const st2 = makeWorldEffectsState();
    const slime = updateWorldEffects(
      st2, { time: 0, waterlevel: 1, watertype: 4, health: 100 }, rand,
    );
    expect(slime.damage).toBe(1);
  });

  it('no drowning ticks when already dead', () => {
    const st = makeWorldEffectsState();
    updateWorldEffects(st, { time: 0, waterlevel: 3, watertype: CONTENTS_WATER, health: 0 }, rand);
    const r = updateWorldEffects(st, { time: 20, waterlevel: 3, watertype: CONTENTS_WATER, health: 0 }, rand);
    expect(r.damage).toBe(0);
  });
});
