// @q2/game/collision — world-query hookup for pmove (WIRE integration).
//
// Adapts @q2/bsp's traceBox/pointLeaf to the pmove TraceFn/PointContentsFn
// hooks (see pmove.ts setPmoveWorld). Conventions follow the C source:
// traces run against model 0 with MASK_PLAYERSOLID collapsed to the solid
// bit our hulls carry, and contents map from Q2 BSP bits
// (q_shared.h: WATER 32, SLIME 16, LAVA 8, LADDER 0x20000000) to the pmove
// bits (pmove.c: WATER 2, SLIME 4, LAVA 8, LADDER 16).
import type { Bsp38 } from '@q2/formats';
import { traceBox, pointLeaf, LEAF_STRIDE, SURF_SKY } from '@q2/bsp';
import type { Vec3 } from '@q2/math';
import type { TraceFn, TraceResult, PointContentsFn } from './pmove.js';
import {
  setPmoveWorld,
  resetPmoveWorld,
  CONTENTS_WATER,
  CONTENTS_SLIME,
  CONTENTS_LAVA,
  CONTENTS_LADDER,
} from './pmove.js';

/** Q2 BSP contents bits (game/q_shared.h) relevant to movement. */
export const BSP_CONTENTS_WATER = 32;
export const BSP_CONTENTS_SLIME = 16;
export const BSP_CONTENTS_LAVA = 8;
export const BSP_CONTENTS_LADDER = 0x20000000;
/** Solid mask used for player hull traces (MASK_PLAYERSOLID, game side). */
export const MASK_PLAYERSOLID = 1;

/** Build the swept-box world trace pmove consumes (CM_BoxTrace, model 0). */
export function bspTraceFor(world: Bsp38, mask: number = MASK_PLAYERSOLID): TraceFn {
  return (start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => {
    const t = traceBox(world, start, end, mins, maxs, mask);
    return {
      fraction: t.fraction,
      endpos: t.endpos,
      planeNormal: t.planeNormal,
      allsolid: t.allsolid,
      startsolid: t.startsolid,
      entityNum: t.entityNum,
      contents: t.contents,
      surfaceFlags: t.surfaceFlags,
    };
  };
}

/**
 * C blaster_touch sky gate (g_weapon.c): a bolt whose wall trace hit a
 * SURF_SKY surface frees silently — no explosion, no dlight, no sound.
 */
export function traceHitSky(t: TraceResult): boolean {
  return ((t.surfaceFlags ?? 0) & SURF_SKY) !== 0;
}

export { SURF_SKY };

/** Map a Q2 BSP leaf-contents value to pmove contents bits. */
export function mapBspContents(contents: number): number {
  let out = 0;
  if (contents & BSP_CONTENTS_WATER) out |= CONTENTS_WATER;
  if (contents & BSP_CONTENTS_SLIME) out |= CONTENTS_SLIME;
  if (contents & BSP_CONTENTS_LAVA) out |= CONTENTS_LAVA;
  if (contents & BSP_CONTENTS_LADDER) out |= CONTENTS_LADDER;
  return out;
}

/** Build the point-contents query pmove consumes (leaf contents mapping). */
export function bspContentsFor(world: Bsp38): PointContentsFn {
  return (p: Vec3): number => {
    const leaf = pointLeaf(world, p);
    if (leaf < 0) return 0;
    // BspMap leaf stride layout: leafs[d] is contents (see @q2/bsp LEAF_STRIDE).
    const leafs = (world as unknown as { leafs: Int32Array }).leafs;
    if (!leafs) return 0;
    return mapBspContents(leafs[leaf * LEAF_STRIDE] ?? 0);
  };
}

/**
 * Install BSP-backed world hooks for pmove (collision hookup).
 * Call resetPmoveWorld() afterwards to restore the empty world.
 */
export function setPmoveWorldFromBsp(world: Bsp38, mask: number = MASK_PLAYERSOLID): void {
  setPmoveWorld(bspTraceFor(world, mask), bspContentsFor(world));
}

export { resetPmoveWorld };
