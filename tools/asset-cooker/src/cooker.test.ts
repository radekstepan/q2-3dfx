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

const Q2_PAK = process.env.Q2_PAK;

describe.runIf(!!Q2_PAK)('asset-cooker real pak0.pak (Q2_PAK)', () => {
  it('cooks the full shareware pak and reads base1.bsp back byte-identical', async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const t0 = performance.now();
    const cooked = await cookPak(buf);
    const cookMs = performance.now() - t0;
    const pkg = readQ2Pkg(cooked);
    const base1 = await extractEntry(pkg, 'maps/base1.bsp');
    const { PakFile } = await import('@q2/filesystem');
    const direct = new PakFile(buf).readFile('maps/base1.bsp');
    console.log(
      `WIRE cook real pak: entries=${pkg.entries.length} cooked=${(cooked.length / 1048576).toFixed(1)}MB ` +
        `cookMs=${cookMs.toFixed(0)} base1=${base1.length}B identical=${base1.length === direct.byteLength}`,
    );
    expect(pkg.entries.length).toBe(3307);
    expect(base1.length).toBe(direct.byteLength);
    const dv = new Uint8Array(direct);
    let same = base1.length === dv.length;
    for (let i = 0; same && i < base1.length; i++) same = base1[i] === dv[i];
    expect(same).toBe(true);
  }, 300000);
});
