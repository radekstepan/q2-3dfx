// @q2/input — keyboard/mouse/pointer-lock/gamepad → usercmd_t (M6.1).
//
// Headless-testable core lives here with zero DOM imports: pure key/mouse
// accumulation plus `buildUserCmd`. The DOM glue (`attachPointerLock`,
// `attachKeyboard`, `pollBrowserGamepads`) is isolated in `dom.ts` and only
// touches `document`/`window` when they exist, so Node tests import this
// package safely.

import { getCVarNumber } from '@q2/config';

/** Quake II usercmd_t, headless-friendly (mirrors @q2/game UserCmd). */
export interface UserCmdT {
  /** command duration in ms */
  msec: number;
  /** view angles [pitch, yaw, roll] in degrees */
  angles: [number, number, number];
  forwardmove: number;
  sidemove: number;
  upmove: number;
  /** bitmask: 1=attack, 2=use, 4=jump ... */
  buttons: number;
}

export const BUTTON_ATTACK = 1;
export const BUTTON_USE = 2;
export const BUTTON_JUMP = 4;

/** Logical keys tracked by the headless core. */
export type LogicalKey =
  | 'forward' | 'back' | 'moveleft' | 'moveright'
  | 'up' | 'down' | 'jump' | 'attack' | 'use'
  | 'left' | 'right' | 'lookup' | 'lookdown';

export interface InputOptions {
  sensitivity?: number;
  mYaw?: number;
  mPitch?: number;
}

/** Mutable accumulated input state (per client frame). */
export interface InputCore {
  keys: Set<LogicalKey>;
  /** accumulated mouse deltas in pixels since last buildUserCmd */
  mouseDX: number;
  mouseDY: number;
  /** view angles [pitch, yaw, roll]; mouse/gamepad update yaw+pitch */
  angles: [number, number, number];
  buttons: number;
}

export function createInput(): InputCore {
  return { keys: new Set(), mouseDX: 0, mouseDY: 0, angles: [0, 0, 0], buttons: 0 };
}

export function keyDown(input: InputCore, key: LogicalKey): void {
  input.keys.add(key);
  if (key === 'attack') input.buttons |= BUTTON_ATTACK;
  if (key === 'use') input.buttons |= BUTTON_USE;
  if (key === 'jump') input.buttons |= BUTTON_JUMP;
}

export function keyUp(input: InputCore, key: LogicalKey): void {
  input.keys.delete(key);
  if (key === 'attack') input.buttons &= ~BUTTON_ATTACK;
  if (key === 'use') input.buttons &= ~BUTTON_USE;
  if (key === 'jump') input.buttons &= ~BUTTON_JUMP;
}

/** Feed raw mouse motion (pixels). Applied to angles on buildUserCmd. */
export function mouseMove(input: InputCore, dx: number, dy: number): void {
  input.mouseDX += dx;
  input.mouseDY += dy;
}

/** Minimal gamepad snapshot (subset of the DOM Gamepad needed for mapping). */
export interface GamepadLike {
  axes: ArrayLike<number>;
  buttons: ArrayLike<{ pressed: boolean }>;
}

/**
 * Map a gamepad onto the input core: left stick strafes/moves, right stick
 * looks, button 0 jumps, button 7 (RT) attacks. Dead-zone 0.15.
 */
export function applyGamepad(input: InputCore, pad: GamepadLike | null, opts: InputOptions = {}): void {
  if (!pad) return;
  const dz = 0.15;
  const ax = (i: number): number => {
    const v = pad.axes[i] ?? 0;
    return Math.abs(v) < dz ? 0 : v;
  };
  const rx = ax(2);
  const ry = ax(3);
  const sens = opts.sensitivity ?? getCVarNumber('sensitivity') ?? 3;
  const mYaw = opts.mYaw ?? getCVarNumber('m_yaw') ?? 0.022;
  const mPitch = opts.mPitch ?? getCVarNumber('m_pitch') ?? 0.022;
  input.angles[1] -= rx * sens * mYaw * 500;
  input.angles[0] += ry * sens * mPitch * 500;
  clampAngles(input.angles);
  const b = (i: number): boolean => pad.buttons[i]?.pressed ?? false;
  if (b(0)) input.buttons |= BUTTON_JUMP;
  if (b(7)) input.buttons |= BUTTON_ATTACK;
  // Left stick nudges movement keys analogically via stored fields.
  gamepadMove.x = ax(0);
  gamepadMove.y = -ax(1);
}

/** Last analog move vector from applyGamepad (-1..1). Reset each frame. */
export const gamepadMove = { x: 0, y: 0 };

export function clampAngles(angles: [number, number, number]): void {
  if (angles[0] > 89) angles[0] = 89;
  if (angles[0] < -89) angles[0] = -89;
  while (angles[1] >= 180) angles[1] -= 360;
  while (angles[1] < -180) angles[1] += 360;
  angles[2] = 0;
}

const KEY_MOVE: Record<LogicalKey, [number, number, number]> = {
  forward: [400, 0, 0],
  back: [-400, 0, 0],
  moveleft: [0, -400, 0],
  moveright: [0, 400, 0],
  up: [0, 0, 400],
  down: [0, 0, -400],
  jump: [0, 0, 400],
  attack: [0, 0, 0],
  use: [0, 0, 0],
  left: [0, 0, 0],
  right: [0, 0, 0],
  lookup: [0, 0, 0],
  lookdown: [0, 0, 0],
};

/**
 * Consume accumulated state into a usercmd (Q2 `CL_CreateCmd`). Pure and
 * headless: advances angles from mouse deltas, derives move speeds from
 * held keys + analog stick, clears deltas. `msec` is the frame time.
 */
export function buildUserCmd(input: InputCore, msec: number, opts: InputOptions = {}): UserCmdT {
  const sens = opts.sensitivity ?? 3;
  const mYaw = opts.mYaw ?? 0.022;
  const mPitch = opts.mPitch ?? 0.022;
  input.angles[1] -= input.mouseDX * sens * mYaw;
  input.angles[0] += input.mouseDY * sens * mPitch;
  input.mouseDX = 0;
  input.mouseDY = 0;
  // Keyboard turn keys (Q2 cl.keyleft/right style, 140 deg/s).
  const turnRate = 140 * (msec / 1000);
  if (input.keys.has('left')) input.angles[1] += turnRate;
  if (input.keys.has('right')) input.angles[1] -= turnRate;
  if (input.keys.has('lookup')) input.angles[0] -= turnRate;
  if (input.keys.has('lookdown')) input.angles[0] += turnRate;
  clampAngles(input.angles);

  let forwardmove = 0;
  let sidemove = 0;
  let upmove = 0;
  for (const key of input.keys) {
    const m = KEY_MOVE[key];
    if (!m) continue;
    forwardmove += m[0];
    sidemove += m[1];
    upmove += m[2];
  }
  forwardmove += gamepadMove.y * 400;
  sidemove += gamepadMove.x * 400;
  gamepadMove.x = 0;
  gamepadMove.y = 0;

  let buttons = input.buttons;
  if (input.keys.has('jump')) buttons |= BUTTON_JUMP;
  if (input.keys.has('attack')) buttons |= BUTTON_ATTACK;
  if (input.keys.has('use')) buttons |= BUTTON_USE;

  return {
    msec,
    angles: [input.angles[0], input.angles[1], input.angles[2]],
    forwardmove: Math.max(-400, Math.min(400, Math.round(forwardmove))),
    sidemove: Math.max(-400, Math.min(400, Math.round(sidemove))),
    upmove: Math.max(-400, Math.min(400, Math.round(upmove))),
    buttons,
  };
}

/** Legacy helper kept for the stub-era API surface. */
export interface InputState {
  forward: number;
  side: number;
  yaw: number;
  pitch: number;
  buttons: number;
}

export function emptyInput(): InputState {
  return { forward: 0, side: 0, yaw: 0, pitch: 0, buttons: 0 };
}

/** Convert a built UserCmdT to the legacy InputState shape. */
export function cmdToInputState(cmd: UserCmdT): InputState {
  return {
    forward: cmd.forwardmove,
    side: cmd.sidemove,
    yaw: cmd.angles[1],
    pitch: cmd.angles[0],
    buttons: cmd.buttons,
  };
}
