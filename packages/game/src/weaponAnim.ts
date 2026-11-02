// @q2/game/weaponAnim — pure port of game/p_weapon.c Weapon_Generic viewmodel
// animation (gunframe cadence). Covers the two behaviours the lite driver
// needs; the sim-side fire/damage stays where it is.
//
// - WEAPON_READY idle walk: IDLE_FIRST..IDLE_LAST, wrapping to IDLE_FIRST,
//   with `rand()&15` hesitations on the weapon's pause_frames (15/16 ticks
//   hold). This is the "sometimes stretches the hand" motion: ~44 idle poses
//   at 10Hz for the blaster, lingering at frames 19/32.
// - WEAPON_FIRING walk: +1 per tick; on fire_frames ticks the shot fires
//   and the fire() function itself advances the frame (Generic skips its
//   own increment there). Net cadence is still +1/tick until IDLE_FIRST+1,
//   where C flips to READY and the idle walk continues from there (no snap
//   back to IDLE_FIRST). The lite sim fires immediately on trigger (not on
//   the fire frame), so only the READY walk and the tables are consumed
//   here; GUN_FIRE_FRAMES/isGunFireFrame pin the source tables for the
//   future fire-on-frame port.
//
// Weapon_Grenade is custom in C (READY 16..48, pauses 29/34/39/48); the lite
// keeps its Generic-shaped bounds (0,15,48,51), whose IDLE_FIRST/LAST match,
// so it shares the same stepper with its own pause list.

/** Pause (hesitation) frames per weapon (p_weapon.c Weapon_* call sites). */
export const GUN_PAUSE_FRAMES: Record<string, readonly number[]> = {
  weapon_blaster: [19, 32],
  weapon_shotgun: [22, 28, 34],
  weapon_supershotgun: [29, 42, 57],
  weapon_machinegun: [23, 45],
  weapon_chaingun: [38, 43, 51, 61],
  weapon_grenades: [29, 34, 39, 48],
  weapon_grenadelauncher: [34, 51, 59],
  weapon_rocketlauncher: [25, 33, 42, 50],
  weapon_hyperblaster: [],
  weapon_railgun: [56],
  weapon_bfg: [39, 45, 50, 55],
};

/** Fire frames per weapon (the shot fires, the frame holds one tick). */
export const GUN_FIRE_FRAMES: Record<string, readonly number[]> = {
  weapon_blaster: [5],
  weapon_shotgun: [8, 9],
  weapon_supershotgun: [7],
  weapon_machinegun: [4, 5],
  weapon_chaingun: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
  weapon_grenades: [],
  weapon_grenadelauncher: [6],
  weapon_rocketlauncher: [5],
  weapon_hyperblaster: [6, 7, 8, 9, 10, 11],
  weapon_railgun: [4],
  weapon_bfg: [9, 17],
};

export function gunPauseFrames(classname: string): readonly number[] {
  return GUN_PAUSE_FRAMES[classname] ?? [];
}

export function gunFireFrames(classname: string): readonly number[] {
  return GUN_FIRE_FRAMES[classname] ?? [];
}

/**
 * One WEAPON_READY tick (p_weapon.c Weapon_Generic READY branch): at
 * IDLE_LAST wrap to IDLE_FIRST, on a pause frame hold when `hold` is true
 * (C `if (rand()&15) return`), else advance. Order matters: the wrap wins
 * over the pause (blaster never pauses on 52 — it is IDLE_LAST, not listed).
 */
export function stepGunReady(
  gunframe: number,
  idleFirst: number,
  idleLast: number,
  pauseFrames: ArrayLike<number>,
  hold: boolean,
): number {
  if (gunframe >= idleLast) return idleFirst;
  if (gunframe < idleFirst) return idleFirst;
  if (hold) {
    for (let i = 0; i < pauseFrames.length; i++) {
      if (gunframe === pauseFrames[i]) return gunframe;
    }
  }
  return gunframe + 1;
}

/** True on a fire frame (C fires there; the fire() then advances the frame). */
export function isGunFireFrame(gunframe: number, fireFrames: ArrayLike<number>): boolean {
  for (let i = 0; i < fireFrames.length; i++) {
    if (gunframe === fireFrames[i]) return true;
  }
  return false;
}
