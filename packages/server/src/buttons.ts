// @q2/server/buttons — C func_button touch/use (game/g_func.c button_*).
//
// Ground truth is ../external/quake-2-source/game/g_func.c; the touch/use
// entry points are button_touch / button_use, gated by button_fire:
//
// - button_fire is a no-op while the button is UP or TOP (C checks
//   STATE_UP/STATE_TOP; our sim splits TOP into TOP (wait<0, holds) and
//   WAITING (wait>=0, armed to return) — both refuse a re-press).
// - button_touch fires only for clients with health>0, and SP_func_button
//   installs the touch field only when the button has no targetname and no
//   health (remote/health buttons answer use only).
// - button_use (remote activation) has no such gate: any live button answers.
// - button_wait (reaching the top) fires the button's target; wait<0 holds
//   the TOP pose (no return think), otherwise button_return runs after wait.
//
// The E-key (use) reach+facing selection below is a driver convenience (Q2
// has no +use-for-buttons): the aimed button within reach fires, exactly
// like its touch would — and only that button (no targetname fan-out).
// Geometry helpers here are pure; SV_TouchButtonsAt / SV_UseButton live in
// index.ts next to the other SV_ touch/use wiring.

import type { Edict, Mover } from '@q2/game';
import type { Vec3 } from '@q2/math';
import { v3 } from '@q2/math';

/** C SP_func_button: touch only when it has no targetname and no health. */
export function isButtonTouchable(ent: Edict): boolean {
  return !ent.targetname && !(ent.health > 0);
}

/**
 * C button_fire gate: a button already travelling up or holding the top
 * (TOP for wait<0, WAITING for the wait>=0 return hold) ignores new presses.
 * Movers at BOTTOM — or closing (GOING_DOWN, re-pressable in C) — answer.
 */
export function buttonCanFire(m: Mover): boolean {
  return m.state !== 'going_up' && m.state !== 'top' && m.state !== 'waiting';
}

/**
 * Touch slop for the button overlap test (world units, all axes). C fires
 * button_touch through the BLOCKING clip (G_TouchTriggers on the trace that
 * stops the move): leaning on the button at the engine's 1/32 contact rest
 * still presses it. Our test sees only post-move overlap, where that same
 * rest reads as a 0.03 gap — without slop a walk-in never presses. 1u keeps
 * contact-pressing while staying far below any accidental range (buttons
 * are 8+ units thick; the exit-hall camper stands 100+ away).
 */
export const BUTTON_TOUCH_SLOP = 1.0;
/**
 * E-use reach in world units (RELEASE-4: 120, up from the 96-unit
 * point-trigger slop). Q2 has no +use-for-buttons (driver convenience);
 * the aboard-plug finisher (open plug east top to the east-face *34,
 * ~25-40u) sits well inside it, and so does the walkway *34 opener and
 * the *13 train call from the bridge. Outside presses still never finish
 * (aboard guard in fireTargets), so the extra reach only lets intended
 * aboard/deck presses connect — no new premature finishes.
 */
export const BUTTON_USE_REACH = 120;
/** E-use facing gate: cosine between the view forward and the eye->button ray. */
export const BUTTON_USE_DOT = 0.7;

/**
 * Aim selection for the E-use path: the nearest button whose center sits
 * within `reach` of the eye and inside the facing cone (`dot`). Ties and
 * far/behind buttons never win, so only the aimed button fires.
 */
export function selectUseButton(
  centers: Array<{ m: Mover; center: Vec3 }>,
  eye: Vec3,
  fwd: Vec3,
  reach: number = BUTTON_USE_REACH,
  dot: number = BUTTON_USE_DOT,
): Mover | null {
  let best: Mover | null = null;
  let bestD = Infinity;
  for (const c of centers) {
    const dx = c.center[0]! - eye[0]!;
    const dy = c.center[1]! - eye[1]!;
    const dz = c.center[2]! - eye[2]!;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > reach) continue;
    let cos: number;
    if (d < 1e-6) {
      cos = 1;
    } else {
      cos = (dx * fwd[0]! + dy * fwd[1]! + dz * fwd[2]!) / d;
    }
    if (cos < dot) continue;
    if (d < bestD) {
      bestD = d;
      best = c.m;
    }
  }
  return best;
}

/**
 * Center of a displaced brush box (rest bounds + travel offset), the E-use
 * aim point and the LOS trace end.
 */
export function displacedCenter(
  rest: { mins: Float32Array; maxs: Float32Array },
  offset: Vec3,
): Vec3 {
  return v3(
    (rest.mins[0]! + rest.maxs[0]!) / 2 + offset[0]!,
    (rest.mins[1]! + rest.maxs[1]!) / 2 + offset[1]!,
    (rest.mins[2]! + rest.maxs[2]!) / 2 + offset[2]!,
  );
}
