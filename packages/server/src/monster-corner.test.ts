// Monster corner-rounding: blind pursuit around a synthetic L-wall.
//
// C ground truth (game/g_ai.c ai_run + game/m_move.c M_MoveToGoal /
// SV_NewChaseDir): after LOS breaks the monster steers at last_sighting,
// then advances down the player trail (PickFirst once, PickNext after),
// probing ±16u sidesteps when the hull leg is blocked (AI_PURSUE_TEMP) and
// sweeping alternate headings when the direct step fails. Without those the
// body presses into the corner wall forever: it reaches the sighting point
// but never rounds the corner.
//
// Layout (top view, +X forward, +Y left): a tall slab wall on the x=100
// plane spanning y in [-400, 160]. The monster starts at M, sees the player
// at L (direct leg clear), then the player teleports to H behind the wall
// (M->H and L->H both cross the slab; the only way through is around the
// y=160 end). The run must keep closing and cross the x=100 plane.
import { describe, expect, it } from 'vitest';
import { mulberry32, resetEdictNums, trailInit } from '@q2/game';
import type { TraceFn, TraceResult } from '@q2/game';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import { SV_Init, SV_MonsterTick, SV_SpawnMonster } from './index.js';

const M: Vec3 = v3(0, 150, 24);
const L: Vec3 = v3(0, 0, 24);
const H: Vec3 = v3(250, 0, 24);

const WALL_X0 = 100;
const WALL_X1 = 116;
const WALL_Y0 = -400;
const WALL_Y1 = 160;
const FLOOR_Z = 24;

/** Floor at z=24 + one tall slab wall (x in [100,116], y in [-400,160]). */
function lWallTrace(): TraceFn {
  return (start: Vec3, _mins: Vec3, _maxs: Vec3, end: Vec3): TraceResult => {
    const inSlab = (x: number, y: number): boolean =>
      x > WALL_X0 && x < WALL_X1 && y >= WALL_Y0 && y <= WALL_Y1;
    if (inSlab(start[0]!, start[1]!)) {
      return {
        fraction: 0,
        endpos: v3(start[0], start[1], start[2]),
        planeNormal: v3(-1, 0, 0),
        allsolid: false,
        startsolid: true,
        entityNum: 0,
        contents: 1,
      };
    }
    let fraction = 1;
    let nx = 0;
    let ny = 0;
    let nz = 1;
    if (end[2]! < FLOOR_Z && start[2]! > FLOOR_Z) {
      const t = (start[2]! - FLOOR_Z) / (start[2]! - end[2]!);
      if (t < fraction) {
        fraction = t;
        nx = 0;
        ny = 0;
        nz = 1;
      }
    }
    // Slab faces: crossing x=100 from the west, or x=116 from the east,
    // counts only while the crossing point sits inside the y span.
    // Face contact counts too (a body resting on the face that pushes
    // inward is blocked at t=0); sliding along the face stays clear.
    // The span ends are capped too (crossing y=-400/160 with x inside the
    // slab), or bodies slip through the top/bottom edge like it wasn't there.
    for (const face of [WALL_X0, WALL_X1]) {
      const x0 = start[0]!;
      const x1 = end[0]!;
      const d0 = x0 - face;
      const d1 = x1 - face;
      const inward = face === WALL_X0 ? d1 > 0 : d1 < 0;
      if (d0 * d1 < 0 || (d0 === 0 && d1 !== 0 && inward)) {
        const t = d0 === 0 ? 0 : (face - x0) / (x1 - x0);
        const y = start[1]! + (end[1]! - start[1]!) * t;
        if (y >= WALL_Y0 && y <= WALL_Y1 && t < fraction) {
          fraction = t;
          nx = face === WALL_X0 ? -1 : 1;
          ny = 0;
          nz = 0;
        }
      }
    }
    for (const cap of [WALL_Y0, WALL_Y1]) {
      const y0 = start[1]!;
      const y1 = end[1]!;
      const e0 = y0 - cap;
      const e1 = y1 - cap;
      const inward = cap === WALL_Y0 ? e1 < 0 : e1 > 0;
      if (e0 * e1 < 0 || (e0 === 0 && e1 !== 0 && inward)) {
        const t = e0 === 0 ? 0 : (cap - y0) / (y1 - y0);
        const x = start[0]! + (end[0]! - start[0]!) * t;
        if (x >= WALL_X0 && x <= WALL_X1 && t < fraction) {
          fraction = t;
          nx = 0;
          ny = cap === WALL_Y0 ? 1 : -1;
          nz = 0;
        }
      }
    }
    return {
      fraction,
      endpos: v3(
        start[0]! + (end[0]! - start[0]!) * fraction,
        start[1]! + (end[1]! - start[1]!) * fraction,
        start[2]! + (end[2]! - start[2]!) * fraction,
      ),
      planeNormal: v3(nx, ny, nz),
      allsolid: false,
      startsolid: false,
      entityNum: fraction < 1 ? 0 : -1,
      contents: 0,
    };
  };
}

function dist2D(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);
}

/** Eye-to-eye LOS through the stub (monster eye +25, player eye +22). */
function los(trace: TraceFn, from: Vec3, to: Vec3): boolean {
  const t = trace(
    v3(from[0], from[1], from[2]! + 25),
    v3(0, 0, 0),
    v3(0, 0, 0),
    v3(to[0], to[1], to[2]! + 22),
  );
  return t.fraction === 1 && !t.startsolid;
}

describe('blind pursuit rounds an L-wall corner', () => {
  it('reaches the last sighting, then keeps closing past the corner plane', () => {
    resetEdictNums();
    const st = SV_Init();
    st.trail = trailInit(true);
    const trace = lWallTrace();
    const m = SV_SpawnMonster(st, 'monster_soldier', v3(M[0], M[1], M[2]));
    expect(los(trace, M, L)).toBe(true);
    expect(los(trace, M, H)).toBe(false);
    // Visible phase: the monster latches the player at the last sighting.
    for (let i = 0; i < 15; i++) {
      st.time += 0.1;
      SV_MonsterTick(st, v3(L[0], L[1], L[2]), trace, null, mulberry32(i + 1), {
        sightTrace: trace,
      });
    }
    expect(m.seen).toBe(true);
    // The beeline to H crosses the slab, and the stall point short of it is
    // far from L — so reaching L proves nothing about rounding the corner.
    const d0 = dist2D(m.edict.origin, H);
    // Blind phase: teleport the player behind the wall.
    let minLblind = dist2D(m.edict.origin, L);
    let minH = d0;
    let maxX = m.edict.origin[0]!;
    let sightTick = -1;
    let t = 0;
    for (; t < 250 && minH > 80; t++) {
      st.time += 0.1;
      SV_MonsterTick(st, v3(H[0], H[1], H[2]), trace, null, mulberry32(1000 + t), {
        sightTrace: trace,
      });
      const see = los(trace, m.edict.origin, H);
      if (see && sightTick < 0) sightTick = t;
      if (!see) minLblind = Math.min(minLblind, dist2D(m.edict.origin, L));
      minH = Math.min(minH, dist2D(m.edict.origin, H));
      maxX = Math.max(maxX, m.edict.origin[0]!);
    }
    // Blind almost the whole way: sight only returns once it rounds the
    // corner into the player's spot (within 80u every point sees H, so an
    // early sight would mean it never lost the trail).
    expect(sightTick).toBeGreaterThan(20);
    // Reached the last sighting while still blind (the old gate-(i) bar).
    expect(minLblind).toBeLessThanOrEqual(40);
    // Rounded the corner plane instead of stalling at the slab face.
    expect(maxX).toBeGreaterThan(WALL_X1);
    // Kept closing past the corner to engagement range (C point-blanks
    // with its gun inside 80u, so arrival parks the loop, not the wall).
    expect(minH).toBeLessThanOrEqual(80);
    expect(minH).toBeLessThan(d0 - 150);
    expect(t).toBeLessThan(250);
  });
});
