// m_flash data (game/m_flash.c, q_shared.h): soldier/gunner slice goldens +
// G_ProjectSource behaviour. Values keep id's *1.2 (soldier) / *1.15
// (gunner) scale factors from monster_flash_offset[].
import { describe, expect, it } from 'vitest';
import { v3 } from '@q2/math';
import {
  monsterFlashOffset,
  projectSource,
  MZ2_SOLDIER_BLASTER_1,
  MZ2_SOLDIER_BLASTER_2,
  MZ2_SOLDIER_BLASTER_8,
  MZ2_SOLDIER_SHOTGUN_8,
  MZ2_GUNNER_MACHINEGUN_1,
  MZ2_GUNNER_GRENADE_1,
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

  it('unknown flash ids fall back to the origin (flash 0 is unused)', () => {
    expect([...monsterFlashOffset(0)]).toEqual([0, 0, 0]);
    expect([...monsterFlashOffset(999)]).toEqual([0, 0, 0]);
  });

  it('projectSource matches G_ProjectSource (muzzle = p + f*d0 + r*d1, z += d2)', () => {
    const out = projectSource(v3(1, 2, 3), v3(10, 20, 30), v3(1, 0, 0), v3(0, 1, 0));
    expect([...out]).toEqual([11, 22, 33]);
  });
});
