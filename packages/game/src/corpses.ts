// @q2/game/corpses — misc_deadsoldier corpse damage (g_misc.c).
// C ground truth: misc_deadsoldier_die (game/g_misc.c) —
//   void misc_deadsoldier_die (edict_t *self, ...)
//   {
//     if (self->health > -80) return;
//     gi.sound (self, CHAN_BODY, gi.soundindex ("misc/udeath.wav"), 1, ATTN_NORM, 0);
//     for (n = 0; n < 4; n++)
//       ThrowGib (self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
//     ThrowHead (self, "models/objects/gibs/head2/tris.md2", damage, GIB_ORGANIC);
//   }
// Notes: the threshold is -80 (NOT the monster gib_healths -30/-70/-40);
// the corpse is NOT freed (no G_FreeEdict — it keeps taking damage and
// re-gibs on every qualifying hit); takedamage stays DAMAGE_YES with
// DEAD_DEAD from spawn (SP_misc_deadsoldier).

/** C misc_deadsoldier_die gib threshold (health at/below this minces). */
export const DEADSOLDIER_GIB_HEALTH = -80;

/** C gib recipe: 4x sm_meat (ThrowGib) + head2 (ThrowHead), all GIB_ORGANIC. */
export const DEADSOLDIER_GIB_MODELS = ['sm_meat', 'sm_meat', 'sm_meat', 'sm_meat', 'head2'] as const;

/** C gib sound (CHAN_BODY in C; the server event queue carries no channel). */
export const DEADSOLDIER_GIB_SOUND = 'misc/udeath.wav';

/** id corpse hull (SP_misc_deadsoldier: VectorSet mins -16,-16,0 / maxs 16,16,16). */
export const DEADSOLDIER_MINS: readonly [number, number, number] = [-16, -16, 0];
export const DEADSOLDIER_MAXS: readonly [number, number, number] = [16, 16, 16];

export interface DeadsoldierHit {
  /** Health after applying the damage. */
  health: number;
  /** True when the hit reached the -80 threshold (spawn gibs + udeath). */
  gibbed: boolean;
}

/**
 * One damage application to a misc_deadsoldier corpse (T_Damage equivalent).
 * `health` is the corpse's current health (0 at spawn — C zeroes edicts).
 * Returns the updated health plus whether this hit minces (health <= -80).
 * Pure; the caller spawns the DEADSOLDIER_GIB_MODELS extras + sound.
 */
export function damageDeadsoldier(health: number, damage: number): DeadsoldierHit {
  const next = health - damage;
  return { health: next, gibbed: next <= DEADSOLDIER_GIB_HEALTH };
}
