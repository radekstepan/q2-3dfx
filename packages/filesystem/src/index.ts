// @q2/filesystem — PAK reader, virtual FS, IndexedDB cache. M1.2 owns this.
import { Com_Error } from '@q2/config';
export interface PakEntry { name: string; offset: number; size: number }
export interface Pak { entries: PakEntry[]; data: ArrayBuffer }
export function parsePakDirectory(buf: ArrayBuffer): PakEntry[] { Com_Error('fatal', 'not implemented: parsePakDirectory'); }
export function readPakFile(pak: Pak, name: string): ArrayBuffer { Com_Error('fatal', 'not implemented: readPakFile'); }
export function normalizePath(p: string): string { return p.toLowerCase().replace(/\\/g, '/'); }
