// @q2/input — keyboard/mouse/pointer-lock/gamepad → usercmd_t. M6.1 owns this.
export interface InputState { forward: number; side: number; yaw: number; pitch: number; buttons: number }
export function emptyInput(): InputState { return { forward: 0, side: 0, yaw: 0, pitch: 0, buttons: 0 }; }
