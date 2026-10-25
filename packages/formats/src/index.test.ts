// @q2/formats tests (M1.2): synthetic fixtures + real-pak integration.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import {
  buildColormap,
  extractColormap,
  parseBSP38,
  parseMD2,
  parsePCX,
  parseSP2,
  parseWAL,
  parseWavHeader,
  COLORMAP_SIZE,
} from './index.js';
import { ComError } from '@q2/config';

// ---------- fixture builders ----------

function buildWAL(width: number, height: number, seed = 0): ArrayBuffer {
  const area = width * height;
  const sizes = [area, area >> 2, area >> 4, area >> 6];
  const total = 100 + sizes[0] + sizes[1] + sizes[2] + sizes[3];
  const buf = new ArrayBuffer(total);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const enc = new TextEncoder();
  const nm = enc.encode('test/wall1');
  bytes.set(nm, 0);
  view.setUint32(32, width, true);
  view.setUint32(36, height, true);
  let off = 100;
  for (let k = 0; k < 4; k++) {
    view.setUint32(40 + k * 4, off, true);
    for (let i = 0; i < sizes[k]; i++) bytes[off + i] = (seed + i) & 0xff;
    off += sizes[k];
  }
  const an = enc.encode('test/wall2');
  bytes.set(an, 56);
  view.setInt32(88, 3, true);
  return buf;
}

/** Minimal RLE encoder: runs up to 63, bytes >= 0xC0 always run-encoded. */
function rleRow(pixels: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < pixels.length) {
    let run = 1;
    while (run < 63 && i + run < pixels.length && pixels[i + run] === pixels[i]) run++;
    if (run > 1 || pixels[i] >= 0xc0) {
      out.push(0xc0 | run, pixels[i]);
    } else {
      out.push(pixels[i]);
    }
    i += run;
  }
  return out;
}

function buildPCX(width: number, height: number, pixels: Uint8Array, palette: Uint8Array): ArrayBuffer {
  // encode scanline by scanline: runs never cross row boundaries.
  const data: number[] = [];
  for (let y = 0; y < height; y++) data.push(...rleRow(pixels.subarray(y * width, (y + 1) * width)));
  const buf = new ArrayBuffer(128 + data.length + 1 + 768);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  bytes[0] = 0x0a;
  bytes[1] = 5;
  bytes[2] = 1;
  bytes[3] = 8;
  view.setUint16(8, width - 1, true);
  view.setUint16(10, height - 1, true);
  bytes[65] = 1;
  view.setUint16(66, width, true);
  bytes.set(data, 128);
  bytes[128 + data.length] = 0x0c;
  bytes.set(palette, 128 + data.length + 1);
  return buf;
}

function grayPalette(): Uint8Array {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    const v = i === 0 ? 0 : i;
    p[i * 3] = v;
    p[i * 3 + 1] = v;
    p[i * 3 + 2] = v;
  }
  return p;
}

function buildSP2(frames: Array<{ w: number; h: number; ox: number; oy: number; name: string }>): ArrayBuffer {
  const buf = new ArrayBuffer(12 + frames.length * 80);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  view.setInt32(0, 0x32534449, true);
  view.setInt32(4, 2, true);
  view.setInt32(8, frames.length, true);
  const enc = new TextEncoder();
  frames.forEach((f, i) => {
    const base = 12 + i * 80;
    view.setInt32(base, f.w, true);
    view.setInt32(base + 4, f.h, true);
    view.setInt32(base + 8, f.ox, true);
    view.setInt32(base + 12, f.oy, true);
    bytes.set(enc.encode(f.name).subarray(0, 63), base + 16);
  });
  return buf;
}

function buildWAV(opts: {
  rate: number;
  width: number;
  channels: number;
  samples: Uint8Array;
  format?: number;
  withCue?: boolean;
}): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  const fmt = new Uint8Array(16);
  const fv = new DataView(fmt.buffer);
  fv.setUint16(0, opts.format ?? 1, true);
  fv.setUint16(2, opts.channels, true);
  fv.setUint32(4, opts.rate, true);
  fv.setUint32(8, opts.rate * opts.channels * opts.width, true);
  fv.setUint16(12, opts.channels * opts.width, true);
  fv.setUint16(14, opts.width * 8, true);
  const push = (id: string, body: Uint8Array): void => {
    const h = new Uint8Array(8);
    for (let i = 0; i < 4; i++) h[i] = id.charCodeAt(i);
    new DataView(h.buffer).setUint32(4, body.length, true);
    chunks.push(h, body);
    if (body.length & 1) chunks.push(new Uint8Array([0]));
  };
  push('fmt ', fmt);
  if (opts.withCue) {
    const cue = new Uint8Array(28);
    const cv = new DataView(cue.buffer);
    cv.setUint32(0, 1, true); // one cue point
    cv.setInt32(24, 2, true); // first point's sample offset (chunk start + 8 + 4 + 20)
    push('cue ', cue);
  }
  push('data', opts.samples);
  let size = 4;
  for (const c of chunks) size += c.length;
  const buf = new ArrayBuffer(8 + size);
  const bytes = new Uint8Array(buf);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  new DataView(buf).setUint32(4, size, true);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  let o = 12;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return buf;
}

function buildMD2(opts: {
  skinWidth?: number;
  skinHeight?: number;
  skins?: string[];
  st?: Array<[number, number]>;
  tris?: Array<[number, number, number, number, number, number]>;
  frames?: Array<{ scale: [number, number, number]; translate: [number, number, number]; name: string; verts: Array<[number, number, number, number]> }>;
  glcmds?: number[];
}): ArrayBuffer {
  const skins = opts.skins ?? ['models/test.pcx'];
  const st = opts.st ?? [[0, 0], [64, 0], [0, 32]];
  const tris = opts.tris ?? [[0, 1, 2, 0, 1, 2]];
  const frames = opts.frames ?? [
    { scale: [0.5, 0.25, 1], translate: [1, 2, 4], name: 'frame0', verts: [[2, 4, 8, 10], [4, 0, 0, 20], [0, 8, 16, 30]] },
    { scale: [1, 1, 1], translate: [0, 0, 0], name: 'frame1', verts: [[1, 2, 3, 5], [6, 7, 8, 9], [10, 11, 12, 13]] },
  ];
  const glcmds = opts.glcmds ?? [0];
  const numVerts = frames[0]!.verts.length;
  const framesize = 40 + numVerts * 4;
  const ofsSkins = 68;
  const ofsSt = ofsSkins + skins.length * 64;
  const ofsTris = ofsSt + st.length * 4;
  const ofsFrames = ofsTris + tris.length * 12;
  const ofsGlcmds = ofsFrames + frames.length * framesize;
  const ofsEnd = ofsGlcmds + glcmds.length * 4;
  const buf = new ArrayBuffer(ofsEnd);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const enc = new TextEncoder();
  view.setInt32(0, 0x32504449, true);
  view.setInt32(4, 8, true);
  view.setInt32(8, opts.skinWidth ?? 64, true);
  view.setInt32(12, opts.skinHeight ?? 32, true);
  view.setInt32(16, framesize, true);
  view.setInt32(20, skins.length, true);
  view.setInt32(24, numVerts, true);
  view.setInt32(28, st.length, true);
  view.setInt32(32, tris.length, true);
  view.setInt32(36, glcmds.length, true);
  view.setInt32(40, frames.length, true);
  view.setInt32(44, ofsSkins, true);
  view.setInt32(48, ofsSt, true);
  view.setInt32(52, ofsTris, true);
  view.setInt32(56, ofsFrames, true);
  view.setInt32(60, ofsGlcmds, true);
  view.setInt32(64, ofsEnd, true);
  skins.forEach((s, i) => bytes.set(enc.encode(s).subarray(0, 63), ofsSkins + i * 64));
  st.forEach(([s, t], i) => {
    view.setInt16(ofsSt + i * 4, s, true);
    view.setInt16(ofsSt + i * 4 + 2, t, true);
  });
  tris.forEach(([a, b, c, ta, tb, tc], i) => {
    view.setInt16(ofsTris + i * 12, a, true);
    view.setInt16(ofsTris + i * 12 + 2, b, true);
    view.setInt16(ofsTris + i * 12 + 4, c, true);
    view.setInt16(ofsTris + i * 12 + 6, ta, true);
    view.setInt16(ofsTris + i * 12 + 8, tb, true);
    view.setInt16(ofsTris + i * 12 + 10, tc, true);
  });
  frames.forEach((f, i) => {
    const base = ofsFrames + i * framesize;
    view.setFloat32(base, f.scale[0], true);
    view.setFloat32(base + 4, f.scale[1], true);
    view.setFloat32(base + 8, f.scale[2], true);
    view.setFloat32(base + 12, f.translate[0], true);
    view.setFloat32(base + 16, f.translate[1], true);
    view.setFloat32(base + 20, f.translate[2], true);
    bytes.set(enc.encode(f.name).subarray(0, 15), base + 24);
    f.verts.forEach(([x, y, z, n], v) => {
      const o = base + 40 + v * 4;
      bytes[o] = x;
      bytes[o + 1] = y;
      bytes[o + 2] = z;
      bytes[o + 3] = n;
    });
  });
  glcmds.forEach((g, i) => view.setInt32(ofsGlcmds + i * 4, g, true));
  return buf;
}

// ---------- parseMD2 ----------

describe('parseMD2', () => {
  it('decodes frames, st, tris and skins into flat arrays', () => {
    const md2 = parseMD2(buildMD2({}));
    expect(md2.skinWidth).toBe(64);
    expect(md2.skinHeight).toBe(32);
    expect(md2.numFrames).toBe(2);
    expect(md2.numVerts).toBe(3);
    expect(md2.numSt).toBe(3);
    expect(md2.numTris).toBe(1);
    expect(md2.numSkins).toBe(1);
    expect(md2.skins).toEqual(['models/test.pcx']);
    expect([...md2.st]).toEqual([0, 0, 64, 0, 0, 32]);
    expect([...md2.trisXyz]).toEqual([0, 1, 2]);
    expect([...md2.trisSt]).toEqual([0, 1, 2]);
    expect(md2.frameNames).toEqual(['frame0', 'frame1']);
    // frame0: v*scale+translate
    expect(md2.frames[0]).toBeCloseTo(2 * 0.5 + 1, 5);
    expect(md2.frames[1]).toBeCloseTo(4 * 0.25 + 2, 5);
    expect(md2.frames[2]).toBeCloseTo(8 * 1 + 4, 5);
    expect(md2.frames[3]).toBeCloseTo(4 * 0.5 + 1, 5);
    // frame1 identity scale/translate
    expect(md2.frames[9]).toBeCloseTo(1, 5);
    expect(md2.frames[10]).toBeCloseTo(2, 5);
    expect(md2.frames[11]).toBeCloseTo(3, 5);
    expect([...md2.normals]).toEqual([10, 20, 30, 5, 9, 13]);
    expect([...md2.scales]).toEqual([0.5, 0.25, 1, 1, 1, 1]);
    expect([...md2.translates]).toEqual([1, 2, 4, 0, 0, 0]);
  });

  it('rejects bad ident, version, counts, offsets and indices', () => {
    const good = buildMD2({});
    const badIdent = good.slice(0);
    new DataView(badIdent).setInt32(0, 0, true);
    expect(() => parseMD2(badIdent)).toThrow(ComError);
    const badVer = good.slice(0);
    new DataView(badVer).setInt32(4, 9, true);
    expect(() => parseMD2(badVer)).toThrow(ComError);
    expect(() => parseMD2(new ArrayBuffer(8))).toThrow(ComError);
    // truncated frames
    expect(() => parseMD2(good.slice(0, 100))).toThrow(ComError);
    // bad tri vert index
    const badTri = buildMD2({ tris: [[0, 1, 99, 0, 1, 2]] });
    expect(() => parseMD2(badTri)).toThrow(ComError);
    // bad tri st index
    const badSt = buildMD2({ tris: [[0, 1, 2, 0, 1, 99]] });
    expect(() => parseMD2(badSt)).toThrow(ComError);
    // out-of-order offsets
    const badOfs = good.slice(0);
    new DataView(badOfs).setInt32(48, 10, true);
    expect(() => parseMD2(badOfs)).toThrow(ComError);
    // zero verts
    const zeroVerts = good.slice(0);
    new DataView(zeroVerts).setInt32(24, 0, true);
    expect(() => parseMD2(zeroVerts)).toThrow(ComError);
  });
});

describe('parseWAL', () => {
  it('decodes header and 4 mips', () => {
    const wal = parseWAL(buildWAL(16, 16, 7));
    expect(wal.name).toBe('test/wall1');
    expect(wal.width).toBe(16);
    expect(wal.height).toBe(16);
    expect(wal.animname).toBe('test/wall2');
    expect(wal.flags).toBe(3);
    expect(wal.mips.map((m) => m.length)).toEqual([256, 64, 16, 4]);
    expect(wal.mips[0][0]).toBe(7);
    expect(wal.mips[0][255]).toBe((7 + 255) & 0xff);
    expect(wal.mips[3][3]).toBe((7 + 3) & 0xff);
  });

  it('rejects truncated and degenerate lumps', () => {
    expect(() => parseWAL(new ArrayBuffer(10))).toThrow(ComError);
    const bad = buildWAL(16, 16);
    expect(() => parseWAL(bad.slice(0, 200))).toThrow(ComError);
    const zero = buildWAL(16, 16);
    new DataView(zero).setUint32(32, 0, true);
    expect(() => parseWAL(zero)).toThrow(ComError);
  });
});

// ---------- parsePCX ----------

describe('parsePCX', () => {
  const palette = grayPalette();

  it('RLE-decodes pixels and reads the trailing palette', () => {
    const pixels = new Uint8Array([1, 1, 2, 200, 3, 3, 3, 4]);
    const pcx = parsePCX(buildPCX(4, 2, pixels, palette));
    expect(pcx.width).toBe(4);
    expect(pcx.height).toBe(2);
    expect([...pcx.pixels]).toEqual([1, 1, 2, 200, 3, 3, 3, 4]);
    expect(pcx.palette.length).toBe(768);
    expect(pcx.palette[3]).toBe(1);
    expect(pcx.palette[765]).toBe(255);
  });

  it('rejects bad headers and malformed runs', () => {
    const pixels = new Uint8Array([1, 2, 3, 4]);
    const good = buildPCX(4, 1, pixels, palette);
    const badMan = good.slice(0);
    new Uint8Array(badMan)[0] = 0x0b;
    expect(() => parsePCX(badMan)).toThrow(ComError);
    // run overruns the scanline: C5 01 into a 4-wide row
    const over = new ArrayBuffer(128 + 2 + 1 + 768);
    const ob = new Uint8Array(over);
    ob.set(new Uint8Array(good.slice(0, 128)));
    ob.set([0xc5, 0x01, 0x0c], 128);
    ob.set(palette, 128 + 3);
    expect(() => parsePCX(over)).toThrow(ComError);
    expect(() => parsePCX(good.slice(0, 100))).toThrow(ComError);
  });

  it('extractColormap takes the 64x256 head of a 256-wide pic', () => {
    const pixels = new Uint8Array(256 * 64).fill(7);
    const pcx = parsePCX(buildPCX(256, 64, pixels, palette));
    const table = extractColormap(pcx);
    expect(table.length).toBe(COLORMAP_SIZE);
    expect(table.every((v) => v === 7)).toBe(true);
    const small = parsePCX(buildPCX(4, 1, new Uint8Array([1, 2, 3, 4]), palette));
    expect(() => extractColormap(small)).toThrow(ComError);
  });
});

// ---------- buildColormap ----------

describe('buildColormap', () => {
  // red ramp: index j holds (j,0,0); index 0 is never a match target.
  const ramp = new Uint8Array(768);
  for (let j = 1; j < 256; j++) ramp[j * 3] = j;

  it('emits 64x256 entries and never targets index 0', () => {
    const table = buildColormap(ramp);
    expect(table.length).toBe(COLORMAP_SIZE);
    expect(table.every((v) => v >= 1)).toBe(true);
  });

  it('row 32 truncates (127/128 scale): tex i maps to max(1, i-1)', () => {
    const table = buildColormap(ramp);
    expect(table[32 * 256 + 0]).toBe(1);
    expect(table[32 * 256 + 1]).toBe(1);
    expect(table[32 * 256 + 100]).toBe(99);
    expect(table[32 * 256 + 255]).toBe(253);
  });

  it('row 0 overbrights and clips at 255', () => {
    const table = buildColormap(ramp);
    expect(table[0 * 256 + 100]).toBe(199);
    expect(table[0 * 256 + 200]).toBe(255);
  });

  it('row 63 collapses toward black and brightness falls monotonically', () => {
    const table = buildColormap(ramp);
    for (let i = 0; i < 256; i++) expect(table[63 * 256 + i]).toBeLessThanOrEqual(5);
    let prev = 256;
    for (let l = 0; l < 64; l++) {
      const v = table[l * 256 + 200];
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });

  it('rejects a bad palette size', () => {
    expect(() => buildColormap(new Uint8Array(100))).toThrow(ComError);
  });
});

// ---------- parseSP2 ----------

describe('parseSP2', () => {
  it('decodes frames into flat arrays', () => {
    const sp2 = parseSP2(
      buildSP2([
        { w: 64, h: 64, ox: 0, oy: 0, name: 'sprites/a.pcx' },
        { w: 32, h: 16, ox: -5, oy: 3, name: 'b.pcx' },
      ]),
    );
    expect(sp2.version).toBe(2);
    expect([...sp2.widths]).toEqual([64, 32]);
    expect([...sp2.heights]).toEqual([64, 16]);
    expect([...sp2.originX]).toEqual([0, -5]);
    expect([...sp2.originY]).toEqual([0, 3]);
    expect(sp2.names).toEqual(['sprites/a.pcx', 'b.pcx']);
  });

  it('rejects bad ident, version and truncation', () => {
    const good = buildSP2([{ w: 8, h: 8, ox: 0, oy: 0, name: 'a' }]);
    const badIdent = good.slice(0);
    new DataView(badIdent).setInt32(0, 0, true);
    expect(() => parseSP2(badIdent)).toThrow(ComError);
    const badVer = good.slice(0);
    new DataView(badVer).setInt32(4, 3, true);
    expect(() => parseSP2(badVer)).toThrow(ComError);
    expect(() => parseSP2(good.slice(0, 20))).toThrow(ComError);
  });
});

// ---------- parseWavHeader ----------

describe('parseWavHeader', () => {
  it('decodes a minimal PCM header', () => {
    const samples = new Uint8Array([128, 129, 130, 131, 132, 133, 134, 135]);
    const info = parseWavHeader(buildWAV({ rate: 22050, width: 1, channels: 1, samples }));
    expect(info.rate).toBe(22050);
    expect(info.width).toBe(1);
    expect(info.channels).toBe(1);
    expect(info.samples).toBe(8);
    expect(info.loopstart).toBe(-1);
    expect(info.dataOffset).toBe(44);
  });

  it('reads the cue chunk loopstart', () => {
    const samples = new Uint8Array(16).fill(128);
    const info = parseWavHeader(
      buildWAV({ rate: 11025, width: 1, channels: 1, samples, withCue: true }),
    );
    expect(info.loopstart).toBe(2);
    expect(info.samples).toBe(16);
  });

  it('rejects non-RIFF and non-PCM lumps', () => {
    const samples = new Uint8Array(8).fill(128);
    const good = buildWAV({ rate: 8000, width: 1, channels: 1, samples });
    const bad = good.slice(0);
    new Uint8Array(bad).set([0x58, 0x58, 0x58, 0x58], 0);
    expect(() => parseWavHeader(bad)).toThrow(ComError);
    const nonPcm = buildWAV({ rate: 8000, width: 1, channels: 1, samples, format: 3 });
    expect(() => parseWavHeader(nonPcm)).toThrow(ComError);
    expect(() => parseWavHeader(good.slice(0, 20))).toThrow(ComError);
  });
});

// ---------- contract stubs owned by later cards ----------

describe('later-card stubs', () => {
  it('parseBSP38 is still unimplemented (lives in @q2/bsp loadBsp)', () => {
    expect(() => parseBSP38(new ArrayBuffer(8))).toThrow(ComError);
  });
});

// ---------- real-data integration ----------

const Q2_PAK = process.env.Q2_PAK;

function loadReal(name: string): ArrayBuffer {
  const bytes = readFileSync(Q2_PAK as string);
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  const view = new DataView(buf);
  const dirofs = view.getInt32(4, true);
  const dirlen = view.getInt32(8, true);
  const want = name.toLowerCase();
  for (let i = 0; i < dirlen / 64; i++) {
    const base = dirofs + i * 64;
    const bytes = new Uint8Array(buf, base, 56);
    let end = 0;
    while (end < 56 && bytes[end] !== 0) end++;
    let s = '';
    for (let k = 0; k < end; k++) s += String.fromCharCode(bytes[k]);
    if (s.toLowerCase() === want) {
      const off = view.getInt32(base + 56, true);
      const len = view.getInt32(base + 60, true);
      return buf.slice(off, off + len);
    }
  }
  throw new Error(`lump missing in test pak: ${name}`);
}

describe.runIf(!!Q2_PAK)('real pak0.pak (Q2_PAK)', () => {
  it('colormap.pcx decodes to 256x320 with a byte-comparable shade table', () => {
    const pcx = parsePCX(loadReal('pics/colormap.pcx'));
    expect(pcx.width).toBe(256);
    expect(pcx.height).toBe(320);
    expect(pcx.pixels.length).toBe(256 * 320);
    expect(pcx.palette.length).toBe(768);
    const table = extractColormap(pcx);
    expect(table.length).toBe(COLORMAP_SIZE);
    const generated = buildColormap(pcx.palette);
    let same = 0;
    for (let i = 0; i < COLORMAP_SIZE; i++) if (generated[i] === table[i]) same++;
    expect(same / COLORMAP_SIZE).toBeGreaterThanOrEqual(0.8);
    // real table structure: rows 31/32 near-identity, row 63 near-black
    for (const row of [31, 32]) {
      let ident = 0;
      for (let i = 0; i < 256; i++) if (table[row * 256 + i] === i) ident++;
      expect(ident).toBeGreaterThanOrEqual(240);
    }
    let black = 0;
    for (let i = 0; i < 256; i++) if (table[63 * 256 + i] === 127) black++;
    expect(black).toBeGreaterThanOrEqual(250);
  });

  it('a real .wal decodes to 4 mips', () => {
    const wal = parseWAL(loadReal('textures/e1u1/metal2_1.wal'));
    expect(wal.name).toBe('e1u1/metal2_1');
    expect(wal.width).toBe(64);
    expect(wal.height).toBe(128);
    expect(wal.mips.map((m) => m.length)).toEqual([8192, 2048, 512, 128]);
  });

  it('a real .sp2 and .wav parse', () => {
    const sp2 = parseSP2(loadReal('sprites/s_explod.sp2'));
    expect(sp2.version).toBe(2);
    expect(sp2.widths.length).toBe(6);
    expect([...sp2.widths]).toEqual([56, 56, 56, 56, 56, 56]);
    expect([...sp2.heights]).toEqual([56, 56, 56, 56, 56, 56]);
    expect([...sp2.originX]).toEqual([28, 28, 28, 28, 28, 28]);
    expect([...sp2.originY]).toEqual([28, 28, 28, 28, 28, 28]);
    expect(sp2.names).toEqual([
      'sprites/s_explod_0.pcx',
      'sprites/s_explod_1.pcx',
      'sprites/s_explod_2.pcx',
      'sprites/s_explod_3.pcx',
      'sprites/s_explod_4.pcx',
      'sprites/s_explod_5.pcx',
    ]);
    const wav = parseWavHeader(loadReal('sound/berserk/attack.wav'));
    expect(wav.channels).toBe(1);
    expect(wav.rate).toBeGreaterThan(0);
    expect(wav.samples).toBeGreaterThan(0);
    expect(wav.dataOffset).toBeGreaterThan(0);
  });

  it('all real .sp2 sprites parse', () => {
    for (const name of [
      'sprites/s_explod.sp2',
      'sprites/s_bubble.sp2',
      'sprites/s_explo2.sp2',
      'sprites/s_explo3.sp2',
      'sprites/s_flash.sp2',
      'sprites/s_bfg1.sp2',
      'sprites/s_bfg2.sp2',
      'sprites/s_bfg3.sp2',
    ]) {
      const sp2 = parseSP2(loadReal(name));
      expect(sp2.version).toBe(2);
      expect(sp2.widths.length).toBeGreaterThan(0);
      for (let i = 0; i < sp2.widths.length; i++) {
        expect(sp2.widths[i]).toBeGreaterThan(0);
        expect(sp2.heights[i]).toBeGreaterThan(0);
        expect(sp2.names[i]!.length).toBeGreaterThan(0);
      }
    }
  });

  it('real .md2 models parse (soldier + weapon)', () => {
    for (const name of ['models/monsters/soldier/tris.md2', 'models/weapons/g_shotg/tris.md2']) {
      const md2 = parseMD2(loadReal(name));
      expect(md2.numFrames).toBeGreaterThan(0);
      expect(md2.numTris).toBeGreaterThan(0);
      expect(md2.numVerts).toBeGreaterThan(0);
      expect(md2.frames.length).toBe(md2.numFrames * md2.numVerts * 3);
      expect(md2.normals.length).toBe(md2.numFrames * md2.numVerts);
      expect(md2.st.length).toBe(md2.numSt * 2);
      expect(md2.trisXyz.length).toBe(md2.numTris * 3);
      expect(md2.skins.length).toBe(md2.numSkins);
      expect(md2.frameNames.length).toBe(md2.numFrames);
      // all indices in range
      for (let i = 0; i < md2.trisXyz.length; i++) expect(md2.trisXyz[i]).toBeLessThan(md2.numVerts);
      for (let i = 0; i < md2.trisSt.length; i++) expect(md2.trisSt[i]).toBeLessThan(md2.numSt);
      // decoded positions are finite
      let finite = 0;
      for (let i = 0; i < md2.frames.length; i++) if (Number.isFinite(md2.frames[i])) finite++;
      expect(finite).toBe(md2.frames.length);
    }
    const soldier = parseMD2(loadReal('models/monsters/soldier/tris.md2'));
    expect(soldier.skinWidth).toBe(288);
    expect(soldier.skinHeight).toBe(195);
    expect(soldier.numSkins).toBe(6);
    expect(soldier.numVerts).toBe(227);
    expect(soldier.numTris).toBe(434);
    expect(soldier.numFrames).toBe(475);
    expect(soldier.skins[0]).toBe('models/monsters/soldier/skin_lt.pcx');
  });
});
