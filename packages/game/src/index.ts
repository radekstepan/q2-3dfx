// @q2/game — gamex86: entities, pmove, items, doors, monsters, weapons. M5.x owns this.
import { Com_Error } from '@q2/config';
import type { Vec3 } from '@q2/math';
export interface UserCmd { msec: number; angles: Vec3; forwardmove: number; sidemove: number; upmove: number; buttons: number }
export interface PmoveState { origin: Vec3; velocity: Vec3; onGround: boolean }
export function PM_StepSlideMove(_st: PmoveState, _dt: number): void { Com_Error('fatal', 'not implemented: PM_StepSlideMove'); }
export function pmove(_st: PmoveState, _cmd: UserCmd): PmoveState { Com_Error('fatal', 'not implemented: pmove'); }
