// @q2/game/water — water contents with solidity + P_WorldEffects drowning.
//
// Ports two C pieces that need the SOLID bit the legacy contents hook drops:
// - the qcommon/pmove.c PM_CheckSpecialMovement waterjump wall probe
//   (`pointcontents(spot) & CONTENTS_SOLID`), and
// - game/p_view.c P_WorldEffects (air supply, drowning ramp, sizzle).
//
// Contents bit space is the pmove one (pmove.ts: SOLID 1, WATER 2, SLIME 4,
// LAVA 8, LADDER 16); the Q2 BSP leaf space (q_shared.h) shares the SOLID
// bit (1) and carries WATER 32 / SLIME 16 / LAVA 8 / LADDER 0x20000000.

import { LEAF_STRIDE, pointLeaf } from '@q2/bsp';
import type { Bsp38 } from '@q2/formats';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  CONTENTS_LADDER,
  CONTENTS_LAVA,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  MASK_WATER,
} from './pmove.js';
import type { PointContentsFn } from './pmove.js';

/** Q2 BSP leaf-contents bits (game/q_shared.h) relevant to water/solidity. */
export const BSP_CONTENTS_SOLID = 1;
export const BSP_CONTENTS_WATER = 32;
export const BSP_CONTENTS_SLIME = 16;
export const BSP_CONTENTS_LAVA = 8;
export const BSP_CONTENTS_LADDER = 0x20000000;

/** Map raw BSP leaf contents onto the pmove bit space (solid included). */
export function mapWaterContents(contents: number): number {
  let out = 0;
  if (contents & BSP_CONTENTS_SOLID) out |= CONTENTS_SOLID;
  if (contents & BSP_CONTENTS_WATER) out |= CONTENTS_WATER;
  if (contents & BSP_CONTENTS_SLIME) out |= CONTENTS_SLIME;
  if (contents & BSP_CONTENTS_LAVA) out |= CONTENTS_LAVA;
  if (contents & BSP_CONTENTS_LADDER) out |= CONTENTS_LADDER;
  return out;
}

/**
 * Point-contents query carrying the SOLID bit (unlike the legacy
 * bspContentsFor in collision.ts, which drops it). The waterjump wall
 * probe (`& CONTENTS_SOLID`) reads solid through this; dry-land consumers
 * only test MASK_WATER, so dry-land traces are bit-identical.
 */
export function bspPointContentsFor(world: Bsp38): PointContentsFn {
  return (p: Vec3): number => {
    const leaf = pointLeaf(world, p);
    if (leaf < 0) return 0;
    const leafs = (world as unknown as { leafs: Int32Array }).leafs;
    if (!leafs) return 0;
    return mapWaterContents(leafs[leaf * LEAF_STRIDE] ?? 0);
  };
}

/**
 * C PM_CatagorizePosition water sampling (qcommon/pmove.c): three heights
 * above the hull bottom (feet+1, midpoint, viewheight line), duck-aware via
 * the caller's viewheight/mins. Pure helper for the server-side world
 * effects; pmove.ts keeps its own inline copy for the move path.
 */
export function sampleWaterLevel(
  origin: Vec3,
  mins: Vec3,
  viewheight: number,
  contents: PointContentsFn,
): { level: number; type: number } {
  const sample2 = viewheight - mins[2]!;
  const sample1 = sample2 / 2;
  const z0 = origin[2]! + mins[2]!;
  let cont = contents(v3(origin[0], origin[1], z0 + 1));
  if (!(cont & MASK_WATER)) return { level: 0, type: 0 };
  const type = cont;
  cont = contents(v3(origin[0], origin[1], z0 + sample1));
  if (!(cont & MASK_WATER)) return { level: 1, type };
  cont = contents(v3(origin[0], origin[1], z0 + sample2));
  if (!(cont & MASK_WATER)) return { level: 2, type };
  return { level: 3, type };
}

// --- P_WorldEffects (game/p_view.c) ------------------------------------------
//
// Per-tick playerport: air supply while the head is under (waterlevel 3),
// escalating drowning damage, lava/slime sizzle, and the enter/exit/gasp/
// breath/burn/drown/gurp sound hooks. C cues carried by other systems are
// noted, not invented: breather/envirosuit frames (no such items in this
// sim — always absent), PlayerNoise (no noise system — dropped), FL_INWATER
// (no client flags — dropped), MOD_* (the caller applies damage through its
// own T_Damage equivalent).

/** Persistent per-player world-effects state (id client->air_finished etc.). */
export interface WorldEffectsState {
  /** level.time until which the player has air (grace 12s out of water). */
  airFinished: number;
  /** Current drowning damage: +2 per second while under, capped at 15. */
  dmg: number;
  /** Next server time a drowning tick may land (1s debounce). */
  nextDrownTime: number;
  /** Previous tick waterlevel (enter/exit/head-under/head-out sounds). */
  oldWaterlevel: number;
  /** Lava burn-sound debounce (id pain_debounce_time, 1s). */
  painDebounce: number;
}

export function makeWorldEffectsState(): WorldEffectsState {
  return { airFinished: 0, dmg: 2, nextDrownTime: 0, oldWaterlevel: 0, painDebounce: 0 };
}

export interface WorldEffectsInput {
  /** Server level.time in seconds. */
  time: number;
  /** Current waterlevel 0..3 (sampleWaterLevel or the pmove state). */
  waterlevel: number;
  /** Current watertype bits (pmove CONTENTS_* space). */
  watertype: number;
  /** Current player health (drowning ticks only while alive). */
  health: number;
}

export interface WorldEffectsResult {
  /** Total damage to apply this tick (drown + sizzle, 0 when dry/alive-gated). */
  damage: number;
  /** Sound hooks to emit through the existing positional-sound events. */
  sounds: string[];
  /** Seconds of air left (HUD timer value; 12+ when not submerged). */
  airLeft: number;
}

/** id DROWN_DAMAGE cap (p_view.c: dmg += 2, clamped at 15). */
export const DROWN_DAMAGE_CAP = 15;
/** id air grace: 12s out of water, 10s with breather (no breather items here). */
export const AIR_GRACE = 12;

export function updateWorldEffects(
  st: WorldEffectsState,
  input: WorldEffectsInput,
  rand: () => number,
): WorldEffectsResult {
  const sounds: string[] = [];
  let damage = 0;
  const waterlevel = input.waterlevel;
  const old = st.oldWaterlevel;
  st.oldWaterlevel = waterlevel;

  if (!old && waterlevel) {
    if (input.watertype & CONTENTS_LAVA) sounds.push('player/lava_in.wav');
    else if (input.watertype & CONTENTS_SLIME) sounds.push('player/watr_in.wav');
    else if (input.watertype & CONTENTS_WATER) sounds.push('player/watr_in.wav');
  }
  if (old && !waterlevel) sounds.push('player/watr_out.wav');
  if (old !== 3 && waterlevel === 3) sounds.push('player/watr_un.wav');
  if (old === 3 && waterlevel !== 3) {
    if (st.airFinished < input.time) sounds.push('player/gasp1.wav');
    else if (st.airFinished < input.time + 11) sounds.push('player/gasp2.wav');
  }

  if (waterlevel === 3) {
    // No breather/envirosuit items in this sim: air runs out on schedule.
    if (st.airFinished < input.time) {
      if (st.nextDrownTime < input.time && input.health > 0) {
        st.nextDrownTime = input.time + 1;
        st.dmg += 2;
        if (st.dmg > DROWN_DAMAGE_CAP) st.dmg = DROWN_DAMAGE_CAP;
        if (input.health <= st.dmg) sounds.push('player/drown1.wav');
        else if (rand() < 0.5) sounds.push('*gurp1.wav');
        else sounds.push('*gurp2.wav');
        damage += st.dmg;
      }
    }
  } else {
    st.airFinished = input.time + AIR_GRACE;
    st.dmg = 2;
  }

  if (waterlevel && input.watertype & (CONTENTS_LAVA | CONTENTS_SLIME)) {
    if (input.watertype & CONTENTS_LAVA) {
      if (input.health > 0 && st.painDebounce <= input.time) {
        if (rand() < 0.5) sounds.push('player/burn1.wav');
        else sounds.push('player/burn2.wav');
        st.painDebounce = input.time + 1;
      }
      damage += 3 * waterlevel;
    }
    if (input.watertype & CONTENTS_SLIME) damage += 1 * waterlevel;
  }

  return { damage, sounds, airLeft: Math.max(0, st.airFinished - input.time) };
}
