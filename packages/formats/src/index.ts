// @q2/formats — BSP38, WAL, PCX, MD2, SP2, WAV parsers → plain typed arrays. M1.2/M2.1 own this.
import { Com_Error } from '@q2/config';
export interface Bsp38 { planes: Float32Array; nodes: Int32Array; leafs: Int32Array; faces: Int32Array; raw: ArrayBuffer }
export interface Wal { name: string; width: number; height: number; mips: Uint8Array[] }
export interface Pcx { width: number; height: number; pixels: Uint8Array; palette: Uint8Array }
export interface Md2 { numFrames: number; numTris: number; data: ArrayBuffer }
export function parseBSP38(_buf: ArrayBuffer): Bsp38 { Com_Error('fatal', 'not implemented: parseBSP38'); }
export function parseWAL(_buf: ArrayBuffer): Wal { Com_Error('fatal', 'not implemented: parseWAL'); }
export function parseMD2(_buf: ArrayBuffer): Md2 { Com_Error('fatal', 'not implemented: parseMD2'); }
export function parsePCX(_buf: ArrayBuffer): Pcx { Com_Error('fatal', 'not implemented: parsePCX'); }
export function buildColormap(_palette: Uint8Array): Uint8Array { Com_Error('fatal', 'not implemented: buildColormap'); }
