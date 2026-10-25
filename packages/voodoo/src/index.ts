// @q2/voodoo — Voodoo3/Glide emulation: post-process + sampling policy. M4.1/M4.2 own this.
import { Com_Error } from '@q2/config';
export interface VoodooState { gamma: number; lodbias: number; dither: boolean; postfilter: boolean; fog: boolean }
export function defaultVoodooState(): VoodooState { return { gamma: 1.3, lodbias: -0.35, dither: true, postfilter: true, fog: true }; }
export function gammaLUT(_gamma: number): Uint8Array { Com_Error('fatal', 'not implemented: gammaLUT'); }
export function resolveRGB565(_src: Uint32Array, _dst: Uint16Array, _w: number, _h: number, _st: VoodooState): void { Com_Error('fatal', 'not implemented: resolveRGB565'); }
export function sampleBilinear(_tex: Uint8Array, _w: number, _h: number, _u: number, _v: number): number { Com_Error('fatal', 'not implemented: sampleBilinear'); }
export function mipLevel(_rho: number, _bias: number): number { Com_Error('fatal', 'not implemented: mipLevel'); }
