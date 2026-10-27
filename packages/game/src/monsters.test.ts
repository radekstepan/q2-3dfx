// misc_deadsoldier pose table (g_misc.c SP_misc_deadsoldier): spawnflags
// pose bits -> deadbod dude MD2 frame, first match wins, default 0.
import { describe, expect, it } from 'vitest';
import { deadsoldierFrameForSpawnflags } from './monsters.js';

describe('deadsoldierFrameForSpawnflags (C SP_misc_deadsoldier)', () => {
  it('maps each QUAKED pose bit to its frame, default 0', () => {
    expect(deadsoldierFrameForSpawnflags(0)).toBe(0);
    expect(deadsoldierFrameForSpawnflags(1)).toBe(0);
    expect(deadsoldierFrameForSpawnflags(2)).toBe(1);
    expect(deadsoldierFrameForSpawnflags(4)).toBe(2);
    expect(deadsoldierFrameForSpawnflags(8)).toBe(3);
    expect(deadsoldierFrameForSpawnflags(16)).toBe(4);
    expect(deadsoldierFrameForSpawnflags(32)).toBe(5);
  });
  it('first match wins in C bit order (9 = bits 8+1 -> frame 3)', () => {
    expect(deadsoldierFrameForSpawnflags(9)).toBe(3);
    expect(deadsoldierFrameForSpawnflags(48)).toBe(4);
  });
});
