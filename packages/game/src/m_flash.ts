// @q2/game/m_flash — monster muzzle-flash offsets (game/m_flash.c, q_shared.h).
// Ports the soldier + gunner slices of `monster_flash_offset[]` as a data
// table keyed by MZ2_* id, plus id's G_ProjectSource (g_utils.c) as a pure
// helper so callers (the web driver) can place monster muzzles exactly like
// soldier_fire / GunnerFire: start = origin + fwd*d[0] + right*d[1], z += d[2].
//
// Only the soldier/gunner slices are ported (the lite state machines in
// monsters.ts only run those two kinds). Values keep id's *1.2 (soldier)
// and *1.15 (gunner) scale factors evaluated inline, matching m_flash.c.

import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';

// --- MZ2_* ids (game/q_shared.h) -------------------------------------------
export const MZ2_SOLDIER_BLASTER_1 = 39;
export const MZ2_SOLDIER_BLASTER_2 = 40;
export const MZ2_SOLDIER_SHOTGUN_1 = 41;
export const MZ2_SOLDIER_SHOTGUN_2 = 42;
export const MZ2_SOLDIER_MACHINEGUN_1 = 43;
export const MZ2_SOLDIER_MACHINEGUN_2 = 44;
export const MZ2_GUNNER_MACHINEGUN_1 = 45;
export const MZ2_GUNNER_MACHINEGUN_2 = 46;
export const MZ2_GUNNER_MACHINEGUN_3 = 47;
export const MZ2_GUNNER_MACHINEGUN_4 = 48;
export const MZ2_GUNNER_MACHINEGUN_5 = 49;
export const MZ2_GUNNER_MACHINEGUN_6 = 50;
export const MZ2_GUNNER_MACHINEGUN_7 = 51;
export const MZ2_GUNNER_MACHINEGUN_8 = 52;
export const MZ2_GUNNER_GRENADE_1 = 53;
export const MZ2_GUNNER_GRENADE_2 = 54;
export const MZ2_GUNNER_GRENADE_3 = 55;
export const MZ2_GUNNER_GRENADE_4 = 56;
export const MZ2_SOLDIER_BLASTER_3 = 83;
export const MZ2_SOLDIER_SHOTGUN_3 = 84;
export const MZ2_SOLDIER_MACHINEGUN_3 = 85;
export const MZ2_SOLDIER_BLASTER_4 = 86;
export const MZ2_SOLDIER_SHOTGUN_4 = 87;
export const MZ2_SOLDIER_MACHINEGUN_4 = 88;
export const MZ2_SOLDIER_BLASTER_5 = 89;
export const MZ2_SOLDIER_SHOTGUN_5 = 90;
export const MZ2_SOLDIER_MACHINEGUN_5 = 91;
export const MZ2_SOLDIER_BLASTER_6 = 92;
export const MZ2_SOLDIER_SHOTGUN_6 = 93;
export const MZ2_SOLDIER_MACHINEGUN_6 = 94;
export const MZ2_SOLDIER_BLASTER_7 = 95;
export const MZ2_SOLDIER_SHOTGUN_7 = 96;
export const MZ2_SOLDIER_MACHINEGUN_7 = 97;
export const MZ2_SOLDIER_BLASTER_8 = 98;
export const MZ2_SOLDIER_SHOTGUN_8 = 99;
export const MZ2_SOLDIER_MACHINEGUN_8 = 100;

/** soldier/gunner slices of m_flash.c monster_flash_offset[] (id values). */
const FLASH_OFFSETS: Record<number, [number, number, number]> = {
  [MZ2_SOLDIER_BLASTER_1]: [10.6 * 1.2, 7.7 * 1.2, 7.8 * 1.2],
  [MZ2_SOLDIER_BLASTER_2]: [21.1 * 1.2, 3.6 * 1.2, 19.0 * 1.2],
  [MZ2_SOLDIER_SHOTGUN_1]: [10.6 * 1.2, 7.7 * 1.2, 7.8 * 1.2],
  [MZ2_SOLDIER_SHOTGUN_2]: [21.1 * 1.2, 3.6 * 1.2, 19.0 * 1.2],
  [MZ2_SOLDIER_MACHINEGUN_1]: [10.6 * 1.2, 7.7 * 1.2, 7.8 * 1.2],
  [MZ2_SOLDIER_MACHINEGUN_2]: [21.1 * 1.2, 3.6 * 1.2, 19.0 * 1.2],
  [MZ2_GUNNER_MACHINEGUN_1]: [30.1 * 1.15, 3.9 * 1.15, 19.6 * 1.15],
  [MZ2_GUNNER_MACHINEGUN_2]: [29.1 * 1.15, 2.5 * 1.15, 20.7 * 1.15],
  [MZ2_GUNNER_MACHINEGUN_3]: [28.2 * 1.15, 2.5 * 1.15, 22.2 * 1.15],
  [MZ2_GUNNER_MACHINEGUN_4]: [28.2 * 1.15, 3.6 * 1.15, 22.0 * 1.15],
  [MZ2_GUNNER_MACHINEGUN_5]: [26.9 * 1.15, 2.0 * 1.15, 23.4 * 1.15],
  [MZ2_GUNNER_MACHINEGUN_6]: [26.5 * 1.15, 0.6 * 1.15, 20.8 * 1.15],
  [MZ2_GUNNER_MACHINEGUN_7]: [26.9 * 1.15, 0.5 * 1.15, 21.5 * 1.15],
  [MZ2_GUNNER_MACHINEGUN_8]: [29.0 * 1.15, 2.4 * 1.15, 19.5 * 1.15],
  [MZ2_GUNNER_GRENADE_1]: [4.6 * 1.15, -16.8 * 1.15, 7.3 * 1.15],
  [MZ2_GUNNER_GRENADE_2]: [4.6 * 1.15, -16.8 * 1.15, 7.3 * 1.15],
  [MZ2_GUNNER_GRENADE_3]: [4.6 * 1.15, -16.8 * 1.15, 7.3 * 1.15],
  [MZ2_GUNNER_GRENADE_4]: [4.6 * 1.15, -16.8 * 1.15, 7.3 * 1.15],
  [MZ2_SOLDIER_BLASTER_3]: [20.8 * 1.2, 10.1 * 1.2, -2.7 * 1.2],
  [MZ2_SOLDIER_SHOTGUN_3]: [20.8 * 1.2, 10.1 * 1.2, -2.7 * 1.2],
  [MZ2_SOLDIER_MACHINEGUN_3]: [20.8 * 1.2, 10.1 * 1.2, -2.7 * 1.2],
  [MZ2_SOLDIER_BLASTER_4]: [7.6 * 1.2, 9.3 * 1.2, 0.8 * 1.2],
  [MZ2_SOLDIER_SHOTGUN_4]: [7.6 * 1.2, 9.3 * 1.2, 0.8 * 1.2],
  [MZ2_SOLDIER_MACHINEGUN_4]: [7.6 * 1.2, 9.3 * 1.2, 0.8 * 1.2],
  [MZ2_SOLDIER_BLASTER_5]: [30.5 * 1.2, 9.9 * 1.2, -18.7 * 1.2],
  [MZ2_SOLDIER_SHOTGUN_5]: [30.5 * 1.2, 9.9 * 1.2, -18.7 * 1.2],
  [MZ2_SOLDIER_MACHINEGUN_5]: [30.5 * 1.2, 9.9 * 1.2, -18.7 * 1.2],
  [MZ2_SOLDIER_BLASTER_6]: [27.6 * 1.2, 3.4 * 1.2, -10.4 * 1.2],
  [MZ2_SOLDIER_SHOTGUN_6]: [27.6 * 1.2, 3.4 * 1.2, -10.4 * 1.2],
  [MZ2_SOLDIER_MACHINEGUN_6]: [27.6 * 1.2, 3.4 * 1.2, -10.4 * 1.2],
  [MZ2_SOLDIER_BLASTER_7]: [28.9 * 1.2, 4.6 * 1.2, -8.1 * 1.2],
  [MZ2_SOLDIER_SHOTGUN_7]: [28.9 * 1.2, 4.6 * 1.2, -8.1 * 1.2],
  [MZ2_SOLDIER_MACHINEGUN_7]: [28.9 * 1.2, 4.6 * 1.2, -8.1 * 1.2],
  [MZ2_SOLDIER_BLASTER_8]: [31.5 * 1.2, 9.6 * 1.2, 10.1 * 1.2],
  [MZ2_SOLDIER_SHOTGUN_8]: [34.5 * 1.2, 9.6 * 1.2, 6.1 * 1.2],
  [MZ2_SOLDIER_MACHINEGUN_8]: [34.5 * 1.2, 9.6 * 1.2, 6.1 * 1.2],
};

/**
 * Flash offset for an MZ2_* id (m_flash.c row). Unknown ids (other monster
 * families) return the zero vector — the muzzle falls back to the entity
 * origin, matching flash 0 ("not used").
 */
export function monsterFlashOffset(flashId: number): Vec3 {
  const o = FLASH_OFFSETS[flashId];
  if (!o) return v3();
  return v3(o[0], o[1], o[2]);
}

/**
 * id G_ProjectSource (g_utils.c): muzzle = point + fwd*d[0] + right*d[1],
 * z += d[2]. Pure (no I/O), deterministic, headless-testable.
 */
export function projectSource(point: Vec3, offset: Vec3, forward: Vec3, right: Vec3): Vec3 {
  return v3(
    point[0]! + forward[0]! * offset[0]! + right[0]! * offset[1]!,
    point[1]! + forward[1]! * offset[0]! + right[1]! * offset[1]!,
    point[2]! + forward[2]! * offset[0]! + right[2]! * offset[1]! + offset[2]!,
  );
}
