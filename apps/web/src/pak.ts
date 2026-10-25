// q2ts-web pak ingest: parse a dropped pak0.pak client-side (M7.1).
//
// Minimal PAK directory reader ("PACK" magic, 64-byte entries). Kept local
// to the web shell so the page works before @q2/filesystem's full reader
// lands; shapes mirror it (`PakEntry`) for a drop-in swap later.

export interface WebPakEntry {
  name: string;
  offset: number;
  size: number;
}

export interface WebPak {
  entries: WebPakEntry[];
  data: ArrayBuffer;
}

function readAscii(bytes: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = bytes[off + i]!;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Parse PAK entries from a raw buffer. Throws on bad magic. */
export function parsePakEntries(buf: ArrayBuffer): WebPakEntry[] {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 12) throw new Error('pak too small');
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== 'PACK') throw new Error(`bad pak magic: ${JSON.stringify(magic)}`);
  const view = new DataView(buf);
  const dirOffset = view.getUint32(4, true);
  const dirLength = view.getUint32(8, true);
  if (dirOffset + dirLength > bytes.length) throw new Error('pak directory out of range');
  const count = dirLength / 64;
  if (!Number.isInteger(count)) throw new Error('pak directory not a multiple of 64 bytes');
  const entries: WebPakEntry[] = [];
  for (let i = 0; i < count; i++) {
    const off = dirOffset + i * 64;
    const name = readAscii(bytes, off, 56).toLowerCase();
    const offset = view.getUint32(off + 56, true);
    const size = view.getUint32(off + 60, true);
    if (offset + size > bytes.length) throw new Error(`pak entry out of range: ${name}`);
    entries.push({ name, offset, size });
  }
  return entries;
}

/** Wrap a dropped file's bytes as a WebPak. */
export function ingestPak(buf: ArrayBuffer): WebPak {
  return { entries: parsePakEntries(buf), data: buf };
}

/** Slice one lump out of the pak. */
export function readPakEntry(pak: WebPak, name: string): ArrayBuffer {
  const lower = name.toLowerCase();
  const entry = pak.entries.find((e) => e.name === lower);
  if (!entry) throw new Error(`pak: no such file ${name}`);
  return pak.data.slice(entry.offset, entry.offset + entry.size);
}

/** True when the pak looks like shareware/retail Quake II (has a BSP). */
export function pakHasMaps(pak: WebPak): boolean {
  return pak.entries.some((e) => e.name.endsWith('.bsp'));
}
