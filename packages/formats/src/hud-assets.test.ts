// RELEASE-6: HUD/F1/completion asset inventory checks.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import {
  HUD_PICS,
  PIC_TRANSPARENT,
  checkHudPic,
  digitPicName,
  hudPicByName,
  hudPicTransparentExpected,
  parsePCX,
  type HudPicSpec,
} from './index.js';

describe('HUD asset manifest', () => {
  it('covers every digit pic in both sets plus the minus sign', () => {
    for (const style of ['num', 'anum'] as const) {
      for (let d = 0; d <= 9; d++) {
        expect(hudPicByName(digitPicName(style, d))).toMatchObject({ width: 16, height: 24 });
      }
      expect(hudPicByName(digitPicName(style, -1))).toMatchObject({ width: 16, height: 24 });
    }
    expect(() => digitPicName('num', 10)).toThrow();
    expect(() => digitPicName('num', -2)).toThrow();
  });

  it('declares the statusbar icons, help/inventory backgrounds and plaques', () => {
    expect(hudPicByName('pics/i_health.pcx')).toMatchObject({ width: 24, height: 24, kind: 'icon' });
    expect(hudPicByName('pics/help.pcx')).toMatchObject({ width: 256, height: 192 });
    expect(hudPicByName('pics/inventory.pcx')).toMatchObject({ width: 256, height: 192 });
    expect(hudPicByName('pics/victory.pcx')).toMatchObject({ width: 320, height: 240 });
    expect(hudPicByName('pics/conchars.pcx')).toMatchObject({ width: 128, height: 128 });
    expect(hudPicByName('pics/nope.pcx')).toBeUndefined();
    // No duplicate pak paths.
    expect(new Set(HUD_PICS.map((p) => p.name)).size).toBe(HUD_PICS.length);
  });

  it('cutout art expects transparency, opaque blocks do not', () => {
    expect(hudPicTransparentExpected('digit')).toBe(true);
    expect(hudPicTransparentExpected('crosshair')).toBe(true);
    expect(hudPicTransparentExpected('icon')).toBe(false);
    expect(hudPicTransparentExpected('screen')).toBe(false);
    expect(hudPicTransparentExpected('field')).toBe(false);
  });

  it('checkHudPic flags dimension, coverage and transparency problems', () => {
    const spec: HudPicSpec = { name: 'pics/num_0.pcx', width: 16, height: 24, kind: 'digit' };
    const good = new Uint8Array(16 * 24).fill(PIC_TRANSPARENT);
    good[0] = 1;
    expect(checkHudPic(spec, { width: 16, height: 24, pixels: good })).toEqual([]);
    expect(checkHudPic(spec, { width: 8, height: 8, pixels: new Uint8Array(64) }).length).toBeGreaterThan(0);
    const opaque = new Uint8Array(16 * 24).fill(7);
    expect(checkHudPic(spec, { width: 16, height: 24, pixels: opaque })).toContain(
      'cutout art has no transparent pixels',
    );
    const flat = new Uint8Array(16 * 24).fill(PIC_TRANSPARENT);
    expect(checkHudPic(spec, { width: 16, height: 24, pixels: flat })).toContain('fully transparent');
  });
});

const Q2_PAK = process.env.Q2_PAK;

function loadReal(name: string): Uint8Array {
  const bytes = readFileSync(Q2_PAK as string);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dirofs = view.getInt32(4, true);
  const dirlen = view.getInt32(8, true);
  for (let i = 0; i < dirlen / 64; i++) {
    const base = dirofs + i * 64;
    let end = base;
    while (end < base + 56 && bytes[end] !== 0) end++;
    let s = '';
    for (let k = base; k < end; k++) s += String.fromCharCode(bytes[k]!);
    if (s.toLowerCase() === name.toLowerCase()) {
      const off = view.getInt32(base + 56, true);
      const len = view.getInt32(base + 60, true);
      return bytes.subarray(off, off + len);
    }
  }
  throw new Error(`lump missing in test pak: ${name}`);
}

describe.runIf(!!Q2_PAK && existsSync(Q2_PAK as string))('real HUD pics (Q2_PAK)', () => {
  it('every manifest entry exists with the declared dimensions and valid art', () => {
    for (const spec of HUD_PICS) {
      const lump = loadReal(spec.name);
      const buf = new ArrayBuffer(lump.length);
      new Uint8Array(buf).set(lump);
      const pcx = parsePCX(buf);
      expect([pcx.width, pcx.height], spec.name).toEqual([spec.width, spec.height]);
      expect(checkHudPic(spec, pcx), spec.name).toEqual([]);
    }
  });

  it('pins key production dims (help/F1, field_3, digit cells, conchars)', () => {
    // Explicit pins for the dims production code hardcodes elsewhere —
    // keep in sync with @q2/client `HELP_W/HELP_H` (256/192),
    // `FIELD_DIGIT_W/FIELD_DIGIT_H` (16/24), `CONCHARS_PIC_SIZE` (128)
    // and the 8px `drawString`/`stringWidth` advance. The manifest loop
    // above checks manifest-vs-art; this test names the values the
    // renderers depend on so a bad constant fails loudly here too.
    const dims = (name: string): [number, number] => {
      const lump = loadReal(name);
      const buf = new ArrayBuffer(lump.length);
      new Uint8Array(buf).set(lump);
      const pcx = parsePCX(buf);
      return [pcx.width, pcx.height];
    };
    expect(dims('pics/help.pcx')).toEqual([256, 192]);
    expect(dims('pics/inventory.pcx')).toEqual([256, 192]);
    expect(dims('pics/field_3.pcx')).toEqual([48, 24]);
    for (const style of ['num', 'anum'] as const) {
      for (let d = 0; d <= 9; d++) expect(dims(`pics/${style}_${d}.pcx`), style).toEqual([16, 24]);
      expect(dims(`pics/${style}_minus.pcx`), style).toEqual([16, 24]);
    }
    expect(dims('pics/conchars.pcx')).toEqual([128, 128]);
    expect(dims('pics/tag1.pcx')).toEqual([128, 32]);
    expect(dims('pics/tag2.pcx')).toEqual([128, 32]);
    expect(dims('pics/victory.pcx')).toEqual([320, 240]);
  });

  it('digit sets differ between normal and alert, icons are opaque blocks', () => {
    const num = loadReal('pics/num_0.pcx');
    const anum = loadReal('pics/aNum_0.pcx'.toLowerCase());
    const nbuf = new ArrayBuffer(num.length);
    new Uint8Array(nbuf).set(num);
    const abuf = new ArrayBuffer(anum.length);
    new Uint8Array(abuf).set(anum);
    const n0 = parsePCX(nbuf);
    const a0 = parsePCX(abuf);
    // Same glyph shape class but distinct baked art (different ink indices,
    // shared palette): the alert set is not a runtime tint of the normal set.
    expect([n0.width, n0.height]).toEqual([a0.width, a0.height]);
    expect(n0.pixels).not.toEqual(a0.pixels);
    expect(n0.palette).toEqual(a0.palette);
    // Icons and fields are fully opaque 24x24/48x24 blocks.
    for (const name of ['pics/i_health.pcx', 'pics/w_blaster.pcx', 'pics/field_3.pcx']) {
      const lump = loadReal(name);
      const buf = new ArrayBuffer(lump.length);
      new Uint8Array(buf).set(lump);
      const pcx = parsePCX(buf);
      expect(pcx.pixels.includes(PIC_TRANSPARENT), name).toBe(false);
    }
  });
});
