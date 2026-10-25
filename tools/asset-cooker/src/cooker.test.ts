import { describe, expect, it } from 'vitest';
import { cookPak, extractEntry, makeSyntheticPak, readQ2Pkg, splitPak } from './index.js';

const files = (): Record<string, Uint8Array> => ({
  'maps/devroom.bsp': Uint8Array.from({ length: 1024 }, (_, i) => i & 255),
  'sound/blaster.wav': Uint8Array.from([82, 73, 70, 70, 1, 2, 3, 4]),
  'pics/conchars.pcx': Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 255),
});

describe('asset-cooker pak -> .q2pkg round-trip', () => {
  it('synthetic pak splits into named files', () => {
    const pak = makeSyntheticPak(files());
    const split = splitPak(pak);
    expect(split.map((f) => f.name).sort()).toEqual([
      'maps/devroom.bsp',
      'pics/conchars.pcx',
      'sound/blaster.wav',
    ]);
  });

  it('cook -> read -> extract is byte-identical', async () => {
    const original = files();
    const pak = makeSyntheticPak(original);
    const cooked = await cookPak(pak);
    expect(cooked.length).toBeGreaterThan(10);
    const pkg = readQ2Pkg(cooked);
    expect(pkg.entries).toHaveLength(3);
    for (const [name, data] of Object.entries(original)) {
      expect(await extractEntry(pkg, name)).toEqual(data);
    }
  });

  it('deflate actually compresses redundant data', async () => {
    const pak = makeSyntheticPak({ 'pad.bin': new Uint8Array(4096) });
    const cooked = await cookPak(pak);
    expect(cooked.length).toBeLessThan(pak.byteLength);
  });

  it('rejects bad magic on both ends', async () => {
    await expect(cookPak(new ArrayBuffer(64))).rejects.toThrow();
    expect(() => readQ2Pkg(new Uint8Array(64))).toThrow();
  });
});
