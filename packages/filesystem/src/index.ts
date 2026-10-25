// @q2/filesystem — PAK reader, virtual FS, IndexedDB cache. M1.2 owns this.
//
// Ports qcommon/files.c (FS_LoadPackFile): a .pak is a flat archive with a
// 12-byte header at offset 0 and the directory at the tail. The directory
// lists every lump, so readers (including HTTP Range-based streaming readers)
// only need the header + directory + the byte ranges they actually want.
// PAK lumps are stored uncompressed: parsing never decompresses.
import { Com_Error } from '@q2/config';

/** Magic ident of a Quake II packfile: little-endian "PACK". */
export const PAK_IDENT = 0x4b434150;
/** Size in bytes of one on-disk directory entry: 56-byte name + filepos + filelen. */
export const PAK_ENTRY_SIZE = 64;
/** id's hard cap on files per pack (qcommon/files.c). */
export const PAK_MAX_FILES = 4096;

export interface PakEntry {
  /** Normalised lump path, e.g. `textures/e1u1/floor1_3.wal`. */
  name: string;
  /** Byte offset of the lump data from the start of the .pak. */
  offset: number;
  /** Byte length of the lump data. */
  size: number;
}

export interface Pak {
  entries: PakEntry[];
  data: ArrayBuffer;
}

/**
 * Normalise a lump path for case-insensitive lookup: lowercase with
 * backslashes converted to forward slashes, leading slashes stripped.
 */
export function normalizePath(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '');
}

/** Read a NUL-terminated ASCII name out of a fixed-width field. */
function readName(bytes: Uint8Array, start: number, len: number): string {
  let end = start;
  const stop = start + len;
  while (end < stop && bytes[end] !== 0) end++;
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Parse the PAK directory from the tail header. `buf` must contain at least
 * the 12-byte header and the full directory; it is not copied.
 */
export function parsePakDirectory(buf: ArrayBuffer): PakEntry[] {
  if (buf.byteLength < 12) Com_Error('fatal', 'not a packfile: too small for header');
  const view = new DataView(buf);
  const ident = view.getInt32(0, true);
  if (ident !== PAK_IDENT) Com_Error('fatal', 'not a packfile: bad ident');
  const dirofs = view.getInt32(4, true);
  const dirlen = view.getInt32(8, true);
  if (dirlen % PAK_ENTRY_SIZE !== 0) Com_Error('fatal', 'packfile has corrupt directory length');
  const count = dirlen / PAK_ENTRY_SIZE;
  if (count > PAK_MAX_FILES) Com_Error('fatal', `packfile has too many files: ${count}`);
  if (dirofs < 12 || dirlen < 0 || dirofs + dirlen > buf.byteLength) {
    Com_Error('fatal', 'packfile directory extends past end of buffer');
  }
  const bytes = new Uint8Array(buf);
  const entries: PakEntry[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = dirofs + i * PAK_ENTRY_SIZE;
    const name = normalizePath(readName(bytes, base, 56));
    const offset = view.getInt32(base + 56, true);
    const size = view.getInt32(base + 60, true);
    if (offset < 0 || size < 0 || offset + size > buf.byteLength) {
      Com_Error('fatal', `packfile entry out of range: ${name}`);
    }
    entries[i] = { name, offset, size };
  }
  return entries;
}

/** Wrap a raw .pak buffer with its parsed directory. */
export function parsePak(buf: ArrayBuffer): Pak {
  return { entries: parsePakDirectory(buf), data: buf };
}

/**
 * Read a whole lump out of a parsed pak. The lookup is case-insensitive and
 * slash-normalised. Returns a copy so the full pak buffer can be released.
 */
export function readPakFile(pak: Pak, name: string): ArrayBuffer {
  const want = normalizePath(name);
  for (let i = 0; i < pak.entries.length; i++) {
    const e = pak.entries[i];
    if (e.name === want) return pak.data.slice(e.offset, e.offset + e.size);
  }
  Com_Error('error', `readPakFile: not found: ${name}`);
}

/**
 * Owner of a parsed .pak buffer with an index for repeated lookups.
 * `readPakFile` above stays for one-off reads and ABI stability.
 */
export class PakFile {
  readonly entries: PakEntry[];
  private readonly index: Map<string, PakEntry>;
  private readonly buf: ArrayBuffer;

  constructor(buf: ArrayBuffer) {
    this.buf = buf;
    this.entries = parsePakDirectory(buf);
    this.index = new Map();
    for (const e of this.entries) {
      if (!this.index.has(e.name)) this.index.set(e.name, e);
    }
  }

  has(name: string): boolean {
    return this.index.has(normalizePath(name));
  }

  /** Case-insensitive, slash-normalised lump read. Returns a copy. */
  readFile(name: string): ArrayBuffer {
    const e = this.index.get(normalizePath(name));
    if (!e) Com_Error('error', `PakFile.readFile: not found: ${name}`);
    return this.buf.slice(e.offset, e.offset + e.size);
  }
}
