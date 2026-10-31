// m_flash data (game/m_flash.c, q_shared.h): soldier/gunner slice goldens +
// G_ProjectSource behaviour. Values keep id's *1.2 (soldier) / *1.15
// (gunner) scale factors from monster_flash_offset[].
import { describe, expect, it } from 'vitest';
import { v3 } from '@q2/math';
import {
  monsterFlashOffset,
  projectSource,
  MZ2_INFANTRY_MACHINEGUN_1,
  MZ2_INFANTRY_MACHINEGUN_2,
  MZ2_INFANTRY_MACHINEGUN_13,
  MZ2_SOLDIER_BLASTER_1,
  MZ2_SOLDIER_BLASTER_2,
  MZ2_SOLDIER_BLASTER_8,
  MZ2_SOLDIER_SHOTGUN_8,
  MZ2_GUNNER_MACHINEGUN_1,
  MZ2_GUNNER_GRENADE_1,
  BLASTER_SPAWN_FWD,
  BLASTER_SPAWN_RIGHT,
  BLASTER_SPAWN_UP,
  MUZZLE_OFFSET_FWD,
  MUZZLE_OFFSET_RIGHT,
} from './index.js';

describe('m_flash (id monster_flash_offset soldier/gunner slices)', () => {
  function expectOffset(id: number, x: number, y: number, z: number): void {
    const o = monsterFlashOffset(id);
    expect(o[0]).toBeCloseTo(x, 5);
    expect(o[1]).toBeCloseTo(y, 5);
    expect(o[2]).toBeCloseTo(z, 5);
  }

  it('soldier blaster offsets keep the *1.2 scale', () => {
    expectOffset(MZ2_SOLDIER_BLASTER_1, 10.6 * 1.2, 7.7 * 1.2, 7.8 * 1.2);
    expectOffset(MZ2_SOLDIER_BLASTER_2, 21.1 * 1.2, 3.6 * 1.2, 19.0 * 1.2);
    // MZ2_SOLDIER_BLASTER_8 uses the corrected row (31.5, not the old 34.5).
    expectOffset(MZ2_SOLDIER_BLASTER_8, 31.5 * 1.2, 9.6 * 1.2, 10.1 * 1.2);
    expectOffset(MZ2_SOLDIER_SHOTGUN_8, 34.5 * 1.2, 9.6 * 1.2, 6.1 * 1.2);
  });

  it('gunner offsets keep the *1.15 scale', () => {
    expectOffset(MZ2_GUNNER_MACHINEGUN_1, 30.1 * 1.15, 3.9 * 1.15, 19.6 * 1.15);
    expectOffset(MZ2_GUNNER_GRENADE_1, 4.6 * 1.15, -16.8 * 1.15, 7.3 * 1.15);
  });

  it('infantry rows are raw (no *1.2 bake — verbatim m_flash.c)', () => {
    // m_flash.c monster_flash_offset[] rows 26-38: only the soldier rows
    // carry the MODEL_SCALE factor. The resolver keys the attack1 fire
    // frame (attak111) to row 26 and the death2 spray (death211-222) to
    // rows 27-38 through aimangles[].
    expectOffset(MZ2_INFANTRY_MACHINEGUN_1, 26.6, 7.1, 13.1);
    expectOffset(MZ2_INFANTRY_MACHINEGUN_2, 18.2, 7.5, 15.4);
    expectOffset(MZ2_INFANTRY_MACHINEGUN_13, -12.4, 13.0, 20.2);
  });

  it('unknown flash ids fall back to the origin (flash 0 is unused)', () => {
    expect([...monsterFlashOffset(0)]).toEqual([0, 0, 0]);
    expect([...monsterFlashOffset(999)]).toEqual([0, 0, 0]);
  });

  it('projectSource matches G_ProjectSource (muzzle = p + f*d0 + r*d1, z += d2)', () => {
    const out = projectSource(v3(1, 2, 3), v3(10, 20, 30), v3(1, 0, 0), v3(0, 1, 0));
    expect([...out]).toEqual([11, 22, 33]);
  });

  it('monster muzzle composes via G_ProjectSource (soldier_fire / GunnerFire)', () => {
    // G_ProjectSource offsets: blaster spawn (24 fwd + 8 right, z += viewheight-8),
    // muzzle dlight (18 fwd + 16 right). The m_flash table rows feed d0/d1/d2.
    expect(BLASTER_SPAWN_FWD).toBe(24);
    expect(BLASTER_SPAWN_RIGHT).toBe(8);
    expect(BLASTER_SPAWN_UP).toBe(-8);
    expect(MUZZLE_OFFSET_FWD).toBe(18);
    expect(MUZZLE_OFFSET_RIGHT).toBe(16);
    const feet = v3(0, 0, 32);
    const fwd = v3(1, 0, 0);
    const right = v3(0, 1, 0);
    const spawn = projectSource(feet, v3(BLASTER_SPAWN_FWD, BLASTER_SPAWN_RIGHT, 22 + BLASTER_SPAWN_UP), fwd, right);
    expect([...spawn]).toEqual([24, 8, 46]); // z = 32 + 14 (viewheight 22 - 8)
    const muzzle = projectSource(feet, v3(MUZZLE_OFFSET_FWD, MUZZLE_OFFSET_RIGHT, 0), fwd, right);
    expect([...muzzle]).toEqual([18, 16, 32]);
    // soldier blaster row 1 keeps the *1.2 scale (matches soldier_fire flash 0)
    const o = monsterFlashOffset(MZ2_SOLDIER_BLASTER_1);
    const m = projectSource(v3(100, 0, 0), o, fwd, right);
    expect(m[0]).toBeCloseTo(100 + 10.6 * 1.2, 5);
  });
});
