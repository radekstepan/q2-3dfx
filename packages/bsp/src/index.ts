// @q2/bsp — node/leaf traversal, PVS decompression, trace/clip hulls. M2.1 owns this.
import { Com_Error } from '@q2/config';
import type { Bsp38 } from '@q2/formats';
import type { Vec3 } from '@q2/math';
export interface Trace { fraction: number; endpos: Vec3; planeNormal: Vec3; contents: number; entityNum: number }
export function traceBox(_world: Bsp38, _start: Vec3, _end: Vec3, _mins: Vec3, _maxs: Vec3, _mask: number): Trace { Com_Error('fatal', 'not implemented: traceBox'); }
export function pointLeaf(_world: Bsp38, _p: Vec3): number { Com_Error('fatal', 'not implemented: pointLeaf'); }
export function clusterPVS(_world: Bsp38, _cluster: number): Uint8Array { Com_Error('fatal', 'not implemented: clusterPVS'); }
