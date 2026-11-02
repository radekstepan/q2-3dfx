// Demo download/extraction unit tests (headless, no DOM, no network).
import { describe, expect, it } from 'vitest';
import {
  DEMO_PAK_SUFFIX,
  extractDemoPak,
  extractZipEntry,
  findEocd,
  parseZipCentralDirectory,
  sha256Hex,
  verifySha256,
} from './demo.js';

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Minimal zip builder (stored or deflated) for tests. */
async function buildZip(entries: Array<{ name: string; data: Uint8Array; method: 0 | 8 }>): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (part: Uint8Array): void => {
    chunks.push(part);
    offset += part.length;
  };
  for (const e of entries) {
    let payload = e.data;
    if (e.method === 8) {
      const cs = new CompressionStream('deflate-raw');
      const src = new Blob([e.data as BlobPart]).stream().pipeThrough(cs);
      payload = new Uint8Array(await new Response(src).arrayBuffer());
    }
    const name = enc(e.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, e.method, true);
    lv.setUint32(14, 0, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const localOff = offset;
    push(local);
    push(payload);
    const centralHead = new Uint8Array(46 + name.length);
    const cv = new DataView(centralHead.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, e.method, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint32(42, localOff, true);
    centralHead.set(name, 46);
    central.push(centralHead);
  }
  let cdOffset = offset;
  for (const c of central) {
    chunks.push(c);
    offset += c.length;
  }
  const cdSize = offset - cdOffset;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  chunks.push(eocd);
  offset += 22;
  const out = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer as ArrayBuffer;
}

function fakePak(extra = 64): Uint8Array {
  const out = new Uint8Array(extra);
  out.set(enc('PACK'), 0);
  return out;
}

describe('demo zip helpers', () => {
  it('sha256 of "abc" matches the known vector', async () => {
    expect(await sha256Hex(enc('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    await expect(verifySha256(enc('abc'), '', 'x')).resolves.toBeUndefined();
    await expect(verifySha256(enc('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'x')).resolves
      .toBeUndefined();
    await expect(verifySha256(enc('abd'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'x')).rejects
      .toThrow(/mismatch/);
  });

  it('findEocd rejects non-zip input', () => {
    expect(() => findEocd(new Uint8Array(64))).toThrow(/end-of-central-directory/);
  });

  it('round-trips a stored pak entry', async () => {
    const pak = fakePak();
    const buf = await buildZip([{ name: 'Install/Data/baseq2/pak0.pak', data: pak, method: 0 }]);
    const entries = parseZipCentralDirectory(buf);
    expect(entries.length).toBe(1);
    expect(entries[0]!.name.toLowerCase().replace(/\\/g, '/')).toContain(DEMO_PAK_SUFFIX);
    const out = await extractZipEntry(buf, entries[0]!);
    expect(out).toEqual(pak);
    const extracted = await extractDemoPak(buf);
    expect(new Uint8Array(extracted)).toEqual(pak);
  });

  it('round-trips a deflated pak entry', async () => {
    const pak = fakePak(4096);
    for (let i = 12; i < pak.length; i++) pak[i] = i & 255;
    const buf = await buildZip([{ name: 'INSTALL\\DATA\\BASEQ2\\PAK0.PAK', data: pak, method: 8 }]);
    const extracted = await extractDemoPak(buf);
    expect(new Uint8Array(extracted)).toEqual(pak);
  });

  it('prefers baseq2/pak0.pak and rejects bad magic', async () => {
    const good = fakePak();
    const buf = await buildZip([
      { name: 'other/pak0.pak', data: enc('PACKjunkpad....'), method: 0 },
      { name: 'Install/Data/baseq2/pak0.pak', data: good, method: 0 },
    ]);
    expect(new Uint8Array(await extractDemoPak(buf))).toEqual(good);
    const badMagic = await buildZip([
      { name: 'Install/Data/baseq2/pak0.pak', data: enc('NOPE-not-a-pak'), method: 0 },
    ]);
    await expect(extractDemoPak(badMagic)).rejects.toThrow(/PACK/);
    const none = await buildZip([{ name: 'readme.txt', data: enc('hi'), method: 0 }]);
    await expect(extractDemoPak(none)).rejects.toThrow(/no pak0/);
  });
});
