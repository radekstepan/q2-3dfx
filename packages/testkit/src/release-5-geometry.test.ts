// RELEASE-5 geometry evidence for the wall-climb guard (Q2_PAK).
//
// Dependency-clean (bsp + filesystem only — no game/server imports): pins
// the base1 map facts the server's real-base1 regression
// (release-5-location.test.ts) depends on, at the reported spot
// (-1148.1, 1542.3, -24):
// - the *19 up-door slab is 16 x 144 x 128 — its 128-unit height is 7x the
//   C STEPSIZE (18, m_move.c), so no 18-step hull trace can mount it;
// - both sides of the door share one floor (dropped hulls rest equal), so
//   the pursuit needs no climb at all;
// - *19 carries no NOMONSTER flag (C Touch_DoorTrigger opens it for
//   monsters), while the *32/*33 exit pair does;
// - the t38 soldier lump record (identity the server test re-pins live).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { PakFile } from '@q2/filesystem';
import { loadBsp, traceBox } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { v3 } from '@q2/math';

const Q2_PAK = process.env.Q2_PAK;

/** C STEPSIZE (m_move.c): the tallest riser SV_movestep mounts. */
const C_STEPSIZE = 18;

function loadBase1(): BspMap {
  const bytes = readFileSync(Q2_PAK as string);
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  const pak = new PakFile(buf);
  return loadBsp(pak.readFile('maps/base1.bsp')) as BspMap;
}

function lumpField(block: string, key: string): string {
  const m = block.match(new RegExp(`"${key}"\\s+"([^"]*)"`));
  return m ? m[1]! : '';
}

function blocksOf(entities: string): string[] {
  return entities.match(/\{[^}]*\}/g) ?? [];
}

function modelBounds(map: BspMap, model: string): { mins: number[]; maxs: number[] } | null {
  if (!model.startsWith('*')) return null;
  const n = Number.parseInt(model.slice(1), 10);
  if (!Number.isFinite(n)) return null;
  return {
    mins: [map.modelsMins[n * 3]!, map.modelsMins[n * 3 + 1]!, map.modelsMins[n * 3 + 2]!],
    maxs: [map.modelsMaxs[n * 3]!, map.modelsMaxs[n * 3 + 1]!, map.modelsMaxs[n * 3 + 2]!],
  };
}

/** Drop a player-size hull straight down; return the rest origin z. */
function dropRestZ(map: BspMap, x: number, y: number): number {
  const mins = v3(-16, -16, -24);
  const maxs = v3(16, 16, 32);
  const t = traceBox(map, v3(x, y, 32), v3(x, y, 32 - 256), mins, maxs, 1);
  return t.endpos[2]!;
}

describe.runIf(!!Q2_PAK)('RELEASE-5 base1 geometry at the door-19 report (Q2_PAK)', () => {
  it('the *19 slider is a 128-tall slab: unclimbable at the C step height', () => {
    const map = loadBase1();
    const blocks = blocksOf(map.entities);
    const door19 = blocks.find((b) => lumpField(b, 'classname') === 'func_door' && lumpField(b, 'model') === '*19');
    expect(door19).toBeDefined();
    const bounds = modelBounds(map, '*19')!;
    expect(bounds.mins).toEqual([-1120, 1560, -48]);
    expect(bounds.maxs).toEqual([-1104, 1704, 80]);
    const height = bounds.maxs[2]! - bounds.mins[2]!;
    expect(height).toBe(128);
    expect(height).toBeGreaterThan(7 * C_STEPSIZE);
    console.log(`R5 geo: *19 slab x[${bounds.mins[0]},${bounds.maxs[0]}] y[${bounds.mins[1]},${bounds.maxs[1]}] z[${bounds.mins[2]},${bounds.maxs[2]}] height=${height} vs STEPSIZE=${C_STEPSIZE}`);
    // No NOMONSTER bit: C Touch_DoorTrigger opens it for monsters.
    expect(Number.parseInt(lumpField(door19!, 'spawnflags') || '0', 10) & 8).toBe(0);
    // The exit-hall pair carries NOMONSTER (control: monsters never trip it).
    for (const model of ['*32', '*33']) {
      const door = blocks.find((b) => lumpField(b, 'classname') === 'func_door' && lumpField(b, 'model') === model);
      expect(door).toBeDefined();
      expect(Number.parseInt(lumpField(door!, 'spawnflags'), 10) & 8).toBe(8);
    }
  });

  it('both sides of *19 share one floor: pursuit needs no climb', () => {
    const map = loadBase1();
    // Soldier room (east) vs reported player spot (west).
    const east = dropRestZ(map, -1025, 1598);
    const west = dropRestZ(map, -1148.1, 1542.3);
    console.log(`R5 geo: rest z east=${east.toFixed(2)} west=${west.toFixed(2)}`);
    expect(east).toBeCloseTo(west, 0);
    expect(east).toBeCloseTo(-24, 0);
  });

  it('t38 lump record: normal soldier behind *19, ambush, mapper yaw 0', () => {
    const map = loadBase1();
    const blocks = blocksOf(map.entities);
    const soldiers = blocks.filter((b) => lumpField(b, 'classname') === 'monster_soldier');
    const t38 = soldiers.find((b) => lumpField(b, 'targetname') === 't38');
    expect(t38).toBeDefined();
    expect(lumpField(t38!, 'origin')).toBe('-1025 1598 -24');
    expect(lumpField(t38!, 'spawnflags')).toBe('1'); // ambush
    expect(lumpField(t38!, 'angle') || '0').toBe('0');
    // The waker that can alert it (trigger_multiple *22 -> t38).
    const waker = blocks.find((b) => lumpField(b, 'target') === 't38');
    expect(waker).toBeDefined();
    expect(lumpField(waker!, 'model')).toBe('*22');
    const wb = modelBounds(map, '*22')!;
    console.log(`R5 geo: t38 soldier (-1025 1598 -24) ambush yaw 0; waker *22 x[${wb.mins[0]},${wb.maxs[0]}] y[${wb.mins[1]},${wb.maxs[1]}]`);
  });
});
