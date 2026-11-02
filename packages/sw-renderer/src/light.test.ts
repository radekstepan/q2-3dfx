// @q2/sw-renderer light tests — buildLightMap mono rule + dark-end floor +
// real-pcx shade rows (R_BuildLightMap / Mod_LoadLighting parity).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { parsePCX } from '@q2/formats';
import { buildLightMap, WORLD_GRADE_FLOOR } from './light.js';
import { SoftwareRenderer } from './frame.js';

const PAK = process.env.Q2_PAK;

function pakReadFile(pakPath: string, name: string): ArrayBuffer {
  const data = readFileSync(pakPath);
  if (data.subarray(0, 4).toString() !== 'PACK') throw new Error('not a pak');
  const dirofs = data.readUInt32LE(4);
  const dirlen = data.readUInt32LE(8);
  for (let o = dirofs; o < dirofs + dirlen; o += 64) {
    const entry = data.subarray(o, o + 56).toString().replace(/\0.*$/, '');
    if (entry === name) {
      const off = data.readUInt32LE(o + 56);
      const len = data.readUInt32LE(o + 60);
      return data.buffer.slice(data.byteOffset + off, data.byteOffset + off + len);
    }
  }
  throw new Error(`pak entry missing: ${name}`);
}

describe('buildLightMap', () => {
  it('uses Rec.601 luma mono (devroom-golden-pinned house rule)', () => {
    // NOTE: id folds by brightest channel (ref_soft r_model.c
    // Mod_LoadLighting), which reads warm sconce light ~2x brighter.
    // Switching the shared path would re-pin the warm-tinted devroom
    // golden (8f61c755), so the mono rule stays luma; the grade floor
    // below carries the dark-end lift instead.
    const out = new Uint8Array(1);
    buildLightMap(out, new Uint8Array([120, 40, 20]), 1, 1, [1], [], new Float32Array(3), 0, 1, null);
    expect(out[0]).toBe(WORLD_GRADE_FLOOR);
  });

  it('dynamic lights add luma-folded contribution (same mono rule)', () => {
    const out = new Uint8Array(1);
    buildLightMap(
      out, new Uint8Array([0, 0, 0]), 1, 1, [1],
      [{ origin: new Float32Array([0, 0, 0]), intensity: 256, color: new Float32Array([1, 1, 0]) }],
      new Float32Array([0, 0, 0]), 1, 1, null,
    );
    // Centered 256-intensity yellow light: (256-0)/256 * luma(1,1,0).
    // luma(1,1,0) = 0.886 -> grade 56, well above the dark-end floor.
    expect(out[0]).toBe(Math.round(0.886 * 63));
  });

  it('floors the dark end so walkable shadow is never pure black', () => {
    const out = new Uint8Array(1);
    buildLightMap(out, new Uint8Array([0, 0, 0]), 1, 1, [1], [], new Float32Array(3), 0, 1, null);
    expect(out[0]).toBe(WORLD_GRADE_FLOOR);
    // Bright grades are untouched by the floor.
    const hi = new Uint8Array(1);
    buildLightMap(hi, new Uint8Array([200, 200, 200]), 1, 1, [1], [], new Float32Array(3), 0, 1, null);
    expect(hi[0]).toBe(Math.round((200 / 255) * 63));
  });

  it.runIf(!!PAK)('installs real pcx shade rows (bright stays bright, dark stays dark)', () => {
    const pcx = parsePCX(pakReadFile(PAK as string, 'pics/colormap.pcx'));
    const r = new SoftwareRenderer();
    expect(r.setShadeRowsFromColormapPcx(new Uint8Array(100))).toBe(false);
    expect(r.setShadeRowsFromColormapPcx(pcx.pixels)).toBe(true);
    const table = (r as unknown as { colormap: Uint8Array }).colormap;
    expect(table.length).toBe(64 * 256);
    const pal = pcx.palette;
    const rowMean = (g: number): number => {
      let sum = 0;
      for (let i = 0; i < 256; i++) {
        const v = table[g * 256 + i]!;
        sum += (pal[v * 3]! + pal[v * 3 + 1]! + pal[v * 3 + 2]!) / 3;
      }
      return sum / 256;
    };
    // Grade 63 (fullbright) preserves the palette's own brightness
    // (near-identity row); grade 0 stays dark.
    let palMean = 0;
    for (let i = 0; i < 256; i++) palMean += (pal[i * 3]! + pal[i * 3 + 1]! + pal[i * 3 + 2]!) / 3;
    palMean /= 256;
    expect(Math.abs(rowMean(63) - palMean)).toBeLessThan(15);
    expect(rowMean(0)).toBeLessThan(30);
  });
});
