// @q2/server — SV_: world state, entity spawning, 10Hz tick. M5.2 owns this.
import { Com_Error } from '@q2/config';
export interface ServerState { time: number; entities: unknown[] }
export function SV_Init(): ServerState { return { time: 0, entities: [] }; }
export function SV_Tick(_st: ServerState, _dt: number): void { Com_Error('fatal', 'not implemented: SV_Tick'); }
export function SV_LinkEdict(_st: ServerState, _e: unknown): void { Com_Error('fatal', 'not implemented: SV_LinkEdict'); }
