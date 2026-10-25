// q2-cook: pak0.pak → .q2pkg (deflate, per-map split) — M7.1 skeleton.
//
// `.q2pkg` binary layout (little-endian):
//   magic   6 bytes "Q2PKG1"
//   u32     entry count
//   per entry:
//     u16 name length, name bytes (utf-8, lower-cased),
//     u32 payload offset (from payload base), u32 comp size, u32 raw size
//   payload concatenated deflate streams
//
// Node-only (node:fs/node:zlib via lazy import in CLI paths so the library
// stays importable anywhere). Round-trips byte-for-byte.
import { createDeflate, createInflate } from './codec.js';

export const Q2PKG_MAGIC = 'Q2PKG1';

export interface Q2PkgEntry {
  name: string;
  offset: number;
  compSize: number;
  rawSize: number;
}

export interface CookedPkg {
  entries: Q2PkgEntry[];
  payload: Uint8Array;
}

export interface PakFile {
  name: string;
  data: Uint8Array;
}

function ascii(bytes: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = bytes[off + i]!;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Split a PAK buffer into files (local reader; mirrors @q2/filesystem). */
export function splitPak(buf: ArrayBuffer): PakFile[] {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 12) throw new Error('cook: pak too small');
  if (String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== 'PACK') {
    throw new Error('cook: bad pak magic');
  }
  const view = new DataView(buf);
  const dirOffset = view.getUint32(4, true);
  const dirLength = view.getUint32(8, true);
  const files: PakFile[] = [];
  for (let off = dirOffset; off < dirOffset + dirLength; off += 64) {
    const name = ascii(bytes, off, 56).toLowerCase();
    const offset = view.getUint32(off + 56, true);
    const size = view.getUint32(off + 60, true);
    files.push({ name, data: bytes.slice(offset, offset + size) });
  }
  return files;
}

/** Cook PAK bytes into a .q2pkg image. */
export async function cookPak(pakBuf: ArrayBuffer): Promise<Uint8Array> {
  const files = splitPak(pakBuf);
  const cooked: Array<{ name: string; comp: Uint8Array; raw: number }> = [];
  for (const f of files) {
    cooked.push({ name: f.name, comp: await createDeflate(f.data), raw: f.data.length });
  }
  let headerSize = 6 + 4;
  const nameBytes = cooked.map((c) => new TextEncoder().encode(c.name));
  for (let i = 0; i < cooked.length; i++) headerSize += 2 + nameBytes[i]!.length + 12;
  let payloadSize = 0;
  for (const c of cooked) payloadSize += c.comp.length;
  const out = new Uint8Array(headerSize + payloadSize);
  const view = new DataView(out.buffer);
  for (let i = 0; i < Q2PKG_MAGIC.length; i++) out[i] = Q2PKG_MAGIC.charCodeAt(i);
  view.setUint32(6, cooked.length, true);
  let hp = 10;
  let pp = headerSize;
  for (let i = 0; i < cooked.length; i++) {
    const c = cooked[i]!;
    const nb = nameBytes[i]!;
    view.setUint16(hp, nb.length, true);
    hp += 2;
    out.set(nb, hp);
    hp += nb.length;
    view.setUint32(hp, pp - headerSize, true);
    hp += 4;
    view.setUint32(hp, c.comp.length, true);
    hp += 4;
    view.setUint32(hp, c.raw, true);
    hp += 4;
    out.set(c.comp, pp);
    pp += c.comp.length;
  }
  return out;
}

/** Read a .q2pkg image index (payload stays compressed until `extract`). */
export function readQ2Pkg(buf: Uint8Array | ArrayBuffer): CookedPkg {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < 10) throw new Error('cook: q2pkg too small');
  const magic = String.fromCharCode(...bytes.slice(0, 6));
  if (magic !== Q2PKG_MAGIC) throw new Error(`cook: bad q2pkg magic ${JSON.stringify(magic)}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const count = view.getUint32(6, true);
  const entries: Q2PkgEntry[] = [];
  let hp = 10;
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const nl = view.getUint16(hp, true);
    hp += 2;
    const name = dec.decode(bytes.slice(hp, hp + nl));
    hp += nl;
    const offset = view.getUint32(hp, true);
    hp += 4;
    const compSize = view.getUint32(hp, true);
    hp += 4;
    const rawSize = view.getUint32(hp, true);
    hp += 4;
    entries.push({ name, offset, compSize, rawSize });
  }
  return { entries, payload: bytes.slice(hp) };
}

/** Extract + inflate one entry. */
export async function extractEntry(pkg: CookedPkg, name: string): Promise<Uint8Array> {
  const lower = name.toLowerCase();
  const e = pkg.entries.find((x) => x.name === lower);
  if (!e) throw new Error(`cook: no such entry ${name}`);
  const comp = pkg.payload.slice(e.offset, e.offset + e.compSize);
  const raw = await createInflate(comp);
  if (raw.length !== e.rawSize) throw new Error(`cook: size mismatch for ${name}`);
  return raw;
}

/** Build a small synthetic pak for tests / smoke runs. */
export function makeSyntheticPak(files: Record<string, Uint8Array>): ArrayBuffer {
  const names = Object.keys(files);
  const headerSize = 12;
  let dataSize = 0;
  for (const n of names) dataSize += files[n]!.length;
  const dirOffset = headerSize + dataSize;
  const buf = new ArrayBuffer(dirOffset + names.length * 64);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  bytes[0] = 0x50; bytes[1] = 0x41; bytes[2] = 0x43; bytes[3] = 0x4b; // PACK
  view.setUint32(4, dirOffset, true);
  view.setUint32(8, names.length * 64, true);
  let dp = headerSize;
  names.forEach((n, i) => {
    const data = files[n]!;
    bytes.set(data, dp);
    const off = dirOffset + i * 64;
    for (let k = 0; k < Math.min(n.length, 56); k++) bytes[off + k] = n.charCodeAt(k);
    view.setUint32(off + 56, dp, true);
    view.setUint32(off + 60, data.length, true);
    dp += data.length;
  });
  return buf;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length < 2 || argv[0] === '--help' || argv[0] === '-h') {
    console.log('usage: q2-cook <in.pak> <out.q2pkg>');
    process.exit(argv.length < 2 ? 1 : 0);
  }
  const fs = await import('fs');
  const [input = '', output = ''] = argv as [string, string];
  const pakBuf = fs.readFileSync(input).buffer as ArrayBuffer;
  const t0 = Date.now();
  const cooked = await cookPak(pakBuf);
  fs.writeFileSync(output, cooked);
  const files = splitPak(pakBuf).length;
  console.log(
    `cooked ${files} files: ${(pakBuf.byteLength / 1048576).toFixed(2)}MB -> ` +
      `${(cooked.length / 1048576).toFixed(2)}MB in ${Date.now() - t0}ms`,
  );
}

const invoked = typeof process !== 'undefined' && process.argv[1] != null;
if (invoked && /asset-cooker|q2-cook|cook/.test(process.argv[1]!)) {
  void main();
}
