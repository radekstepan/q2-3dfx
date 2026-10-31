// @q2/game/damageFeedback — pure port of game/p_view.c damage + view terms.
//
// Covers P_DamageFeedback (STAT_FLASHES bits, damage color/alpha blend +
// decay, directional view kick), the SV_CalcViewOffset camera terms
// (damage-kick decay, velocity lean, bob lean) and SV_CalcRoll. All numbers
// are id's (cvar defaults from game/g_save.c); the driver in apps/web owns
// the per-tick state, this module owns the arithmetic so tests pin it.
//
// Deliberate omissions (documented, not silent):
// - Player armor absorption (CheckArmor/CheckPowerArmor, g_combat.c) is not
//   ported: the sim applies full damage to health, so live feedback feeds
//   blood-only contributions. The armor/white + power/green mixing below is
//   still ported + unit-pinned so a future absorption port plugs straight in.
// - Fall kick (fall_value/fall_time, FALL_TIME) needs landing detection the
//   driver does not track; not ported.
// - SV_CalcRoll's x4 model roll is third-person (ClientEndServerFrame sets
//   ent->s.angles[ROLL]); first-person needs only the base value, exported
//   here for completeness.

/** P_DamageFeedback view-kick window, seconds (game/g_local.h). */
export const DAMAGE_TIME = 0.5;
/** Per-10Hz-tick decay of damage_alpha (SV_CalcBlend). */
export const DAMAGE_ALPHA_DECAY = 0.06;
/** damage_alpha floor once any damage lands (SV_CalcBlend clamps). */
export const DAMAGE_ALPHA_MIN = 0.2;
/** damage_alpha ceiling (never fully saturated). */
export const DAMAGE_ALPHA_MAX = 0.6;
/** Minimum visible effect: counts below this still read as 10. */
export const DAMAGE_COUNT_FLOOR = 10;
/** View-kick scale (kick*side*0.3, P_DamageFeedback). */
export const DAMAGE_KICK_SCALE = 0.3;
/** View-kick ceiling in degrees. */
export const DAMAGE_KICK_MAX = 50;

/** run_pitch / run_roll cvar defaults (velocity lean, SV_CalcViewOffset). */
export const RUN_PITCH = 0.002;
export const RUN_ROLL = 0.005;
/** bob_up / bob_pitch / bob_roll cvar defaults (bob lean). */
export const BOB_UP = 0.005;
export const BOB_PITCH = 0.002;
export const BOB_ROLL = 0.002;
/** Ducked bob multiplier (crouching, SV_CalcViewOffset). */
export const DUCK_BOB_SCALE = 6;
/** sv_rollangle / sv_rollspeed cvar defaults (SV_CalcRoll). */
export const SV_ROLLANGLE = 2;
export const SV_ROLLSPEED = 200;
/** Dead-player camera pose (SV_CalcViewOffset deadflag branch). */
export const DEATH_PITCH = -15;
export const DEATH_ROLL = 40;

/** Blend colors: power shield green, armor white, blood red (p_view.c). */
export const POWER_BLEND: readonly [number, number, number] = [0.0, 1.0, 0.0];
export const ARMOR_BLEND: readonly [number, number, number] = [1.0, 1.0, 1.0];
export const BLOOD_BLEND: readonly [number, number, number] = [1.0, 0.0, 0.0];

/** STAT_FLASHES bits (game/q_shared.h STAT_FLASHES = 15). */
export const FLASH_HEALTH = 1;
export const FLASH_ARMOR = 2;

export type BlendColor = readonly [number, number, number];

/**
 * Weighted damage-blend color (P_DamageFeedback VectorMA mix): each armor
 * class contributes proportionally to its share of the real count. Zero
 * count reads black (caller must early-return like C's `count == 0`).
 */
export function mixDamageBlend(blood: number, armor: number, parmor: number): BlendColor {
  const real = blood + armor + parmor;
  if (!(real > 0)) return [0, 0, 0];
  return [
    (parmor / real) * POWER_BLEND[0] + (armor / real) * ARMOR_BLEND[0] + (blood / real) * BLOOD_BLEND[0],
    (parmor / real) * POWER_BLEND[1] + (armor / real) * ARMOR_BLEND[1] + (blood / real) * BLOOD_BLEND[1],
    (parmor / real) * POWER_BLEND[2] + (armor / real) * ARMOR_BLEND[2] + (blood / real) * BLOOD_BLEND[2],
  ];
}

/**
 * Accumulate one frame's damage into damage_alpha (P_DamageFeedback): the
 * count floors at 10 for visibility, then alpha grows by count*0.01 and
 * clamps to [0.2, 0.6].
 */
export function accumulateDamageAlpha(prev: number, blood: number, armor: number, parmor: number): number {
  const real = blood + armor + parmor;
  if (!(real > 0)) return prev;
  const count = Math.max(DAMAGE_COUNT_FLOOR, real);
  let alpha = Math.max(0, prev) + count * 0.01;
  if (alpha < DAMAGE_ALPHA_MIN) alpha = DAMAGE_ALPHA_MIN;
  if (alpha > DAMAGE_ALPHA_MAX) alpha = DAMAGE_ALPHA_MAX;
  return alpha;
}

/** One 10Hz tick of SV_CalcBlend damage decay. */
export function decayDamageAlpha(alpha: number): number {
  return Math.max(0, alpha - DAMAGE_ALPHA_DECAY);
}

/**
 * Directional view kick (P_DamageFeedback "calculate view angle kicks").
 * dirToAttacker is the normalized (damage_from - origin); null/zero means
 * the direction is unknown (C's zero-vector normalize), which still arms
 * the kick window but contributes no angles. Returns null when there is no
 * kick at all (knockback 0 or already dead — `health > 0` gate), matching
 * C's `kick of 0 means no view adjust at all`.
 */
export function damageKickAngles(
  knockback: number,
  health: number,
  count: number,
  dirToAttacker: ArrayLike<number> | null,
  forward: ArrayLike<number>,
  right: ArrayLike<number>,
): { pitch: number; roll: number } | null {
  const kick0 = Math.abs(knockback);
  if (!(kick0 > 0) || !(health > 0)) return null;
  let kick = (kick0 * 100) / health;
  const floor = count * 0.5;
  if (kick < floor) kick = floor;
  if (kick > DAMAGE_KICK_MAX) kick = DAMAGE_KICK_MAX;
  if (!dirToAttacker) return { pitch: 0, roll: 0 };
  const sideRoll = dirToAttacker[0]! * right[0]! + dirToAttacker[1]! * right[1]! + dirToAttacker[2]! * right[2]!;
  const sidePitch =
    -(dirToAttacker[0]! * forward[0]! + dirToAttacker[1]! * forward[1]! + dirToAttacker[2]! * forward[2]!);
  return { pitch: kick * sidePitch * DAMAGE_KICK_SCALE, roll: kick * sideRoll * DAMAGE_KICK_SCALE };
}

/**
 * Decay a stored damage kick for the current time (SV_CalcViewOffset
 * `ratio = (v_dmg_time - level.time) / DAMAGE_TIME`): full strength at the
 * hit, linear to zero at the window end, zero past it (C also zeroes the
 * stored values then — the caller resets its latch when ratio hits 0).
 */
export function decayDamageKick(
  vDmgPitch: number,
  vDmgRoll: number,
  vDmgTime: number,
  now: number,
): { pitch: number; roll: number; live: boolean } {
  const ratio = (vDmgTime - now) / DAMAGE_TIME;
  if (!(ratio > 0)) return { pitch: 0, roll: 0, live: false };
  return { pitch: ratio * vDmgPitch, roll: ratio * vDmgRoll, live: true };
}

/**
 * Velocity lean (SV_CalcViewOffset "add angles based on velocity"): raw
 * planar+vertical velocity dotted into the view basis, scaled by run_pitch
 * / run_roll. Deliberately unclamped like C (unlike SV_CalcRoll). Applies
 * grounded, airborne and submerged — C gates none of it.
 */
export function velocityLean(
  velocity: ArrayLike<number>,
  forward: ArrayLike<number>,
  right: ArrayLike<number>,
): { pitch: number; roll: number } {
  const fwd = velocity[0]! * forward[0]! + velocity[1]! * forward[1]! + velocity[2]! * forward[2]!;
  const side = velocity[0]! * right[0]! + velocity[1]! * right[1]! + velocity[2]! * right[2]!;
  return { pitch: fwd * RUN_PITCH, roll: side * RUN_ROLL };
}

/**
 * Bob lean (SV_CalcViewOffset "add angles based on bob"): speed-scaled
 * sin-cycled sway, x6 while ducked, roll sign flipped on odd bob cycles.
 * xyspeed is the planar speed; the bob clock itself (ground-gated,
 * duck-x4) lives with the caller, like C's file-static bobtime.
 */
export function bobLean(
  xyspeed: number,
  bobfracsin: number,
  bobcycle: number,
  ducked: boolean,
): { pitch: number; roll: number } {
  const duck = ducked ? DUCK_BOB_SCALE : 1;
  const pitch = bobfracsin * BOB_PITCH * xyspeed * duck;
  let roll = bobfracsin * BOB_ROLL * xyspeed * duck;
  if ((bobcycle & 1) !== 0) roll = -roll;
  return { pitch, roll };
}

/**
 * SV_CalcRoll base value (sign * min(side,rollspeed)*rollangle/rollspeed):
 * the lateral-velocity roll C applies x4 to the third-person model angles.
 * First-person uses velocityLean instead; this is exported so the clamp,
 * sign and speed mapping stay pinned against source.
 */
export function svCalcRoll(
  sideVelocity: number,
  rollAngle: number = SV_ROLLANGLE,
  rollSpeed: number = SV_ROLLSPEED,
): number {
  const sign = sideVelocity < 0 ? -1 : 1;
  const side = Math.abs(sideVelocity);
  const clamped = side < rollSpeed ? (side * rollAngle) / rollSpeed : rollAngle;
  return clamped * sign;
}

/**
 * SV_AddBlend compositing (kept here so the over operator stays pinned):
 * `a2` is the new total alpha, old color keeps fraction a3 of the mix.
 */
export function addScreenBlend(
  dst: readonly [number, number, number, number],
  r: number,
  g: number,
  b: number,
  a: number,
): [number, number, number, number] {
  if (!(a > 0)) return [dst[0], dst[1], dst[2], dst[3]];
  const a2 = dst[3] + (1 - dst[3]) * a;
  const a3 = dst[3] / a2;
  return [dst[0] * a3 + r * (1 - a3), dst[1] * a3 + g * (1 - a3), dst[2] * a3 + b * (1 - a3), a2];
}
