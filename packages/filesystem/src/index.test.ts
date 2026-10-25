// @q2/filesystem tests (M1.2): synthetic fixtures + real-pak integration.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import {
  normalizePath,
  parsePak,
  parsePakDirectory,
  readPakFile,
  PakFile,
  PAK_IDENT,
} from './index.js';
import { ComError } from '@q2/config';

/** Build a minimal in-memory .pak from [name, bytes] lumps. */
function buildPak(lumps: Array<[string, Uint8Array]>): ArrayBuffer {
  const encoder = new TextEncoder();
  let dataSize = 12;
  const datas = lumps.map(([name, d]) => {
    const off = dataSize;
    dataSize += d.length;
    void name;
    return { off, d };
  });
  const dirlen = lumps.length * 64;
  const buf = new ArrayBuffer(dataSize + dirlen);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  view.setInt32(0, PAK_IDENT, true);
  view.setInt32(4, dataSize, true);
  view.setInt32(8, dirlen, true);
  lumps.forEach(([name, d], i) => {
    bytes.set(d, datas[i].off);
    const base = dataSize + i * 64;
    const nb = encoder.encode(name);
    bytes.set(nb.subarray(0, Math.min(nb.length, 55)), base);
    view.setInt32(base + 56, datas[i].off, true);
    view.setInt32(base + 60, d.length, true);
  });
  return buf;
}

const lumpA = new Uint8Array([1, 2, 3, 4]);
const lumpB = new Uint8Array([9, 8, 7]);

describe('normalizePath', () => {
  it('lowercases and converts backslashes', () => {
    expect(normalizePath('TEXTURES\\E1U1\\Floor1_3.WAL')).toBe('textures/e1u1/floor1_3.wal');
    expect(normalizePath('/pics/Colormap.PCX')).toBe('pics/colormap.pcx');
  });
});

describe('parsePakDirectory', () => {
  it('parses entries with offsets and sizes', () => {
    const buf = buildPak([
      ['TEXTURES/A.WAL', lumpA],
      ['pics\\b.pcx', lumpB],
    ]);
    const entries = parsePakDirectory(buf);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ name: 'textures/a.wal', offset: 12, size: 4 });
    expect(entries[1]).toEqual({ name: 'pics/b.pcx', offset: 16, size: 3 });
  });

  it('rejects a bad ident', () => {
    const buf = new ArrayBuffer(12);
    expect(() => parsePakDirectory(buf)).toThrow(ComError);
  });

  it('rejects a directory past the end of the buffer', () => {
    const buf = new ArrayBuffer(12);
    new DataView(buf).setInt32(0, PAK_IDENT, true);
    new DataView(buf).setInt32(4, 12, true);
    new DataView(buf).setInt32(8, 64, true);
    expect(() => parsePakDirectory(buf)).toThrow(ComError);
  });
});

describe('readPakFile / PakFile', () => {
  const buf = buildPak([
    ['textures/a.wal', lumpA],
    ['pics/b.pcx', lumpB],
  ]);
  const pak = parsePak(buf);

  it('reads lump bytes exactly', () => {
    expect(new Uint8Array(readPakFile(pak, 'textures/a.wal'))).toEqual(lumpA);
  });

  it('is case-insensitive and slash-normalised', () => {
    expect(new Uint8Array(readPakFile(pak, 'TEXTURES\\A.WAL'))).toEqual(lumpA);
    expect(new Uint8Array(new PakFile(buf).readFile('PICS/B.PCX'))).toEqual(lumpB);
  });

  it('returns a copy, not a view on the pak', () => {
    const out = new Uint8Array(readPakFile(pak, 'textures/a.wal'));
    out[0] = 42;
    expect(new Uint8Array(readPakFile(pak, 'textures/a.wal'))).toEqual(lumpA);
  });

  it('throws ComError on missing lumps', () => {
    expect(() => readPakFile(pak, 'nope.wal')).toThrow(ComError);
    const pf = new PakFile(buf);
    expect(pf.has('textures/a.wal')).toBe(true);
    expect(pf.has('TEXTURES\\A.WAL')).toBe(true);
    expect(pf.has('nope.wal')).toBe(false);
    expect(() => pf.readFile('nope.wal')).toThrow(ComError);
  });
});

const Q2_PAK = process.env.Q2_PAK;

describe.runIf(!!Q2_PAK)('real pak0.pak (Q2_PAK)', () => {
  it('parses the directory and reads lumps', () => {
    const bytes = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(bytes.length);
    new Uint8Array(buf).set(bytes);
    const pak = new PakFile(buf);
    expect(pak.entries.length).toBe(3307);
    const cm = pak.readFile('PICS\\COLORMAP.PCX');
    expect(cm.byteLength).toBe(96927);
    const head = new Uint8Array(cm, 0, 4);
    expect([...head]).toEqual([0x0a, 5, 1, 8]);
  });
});
