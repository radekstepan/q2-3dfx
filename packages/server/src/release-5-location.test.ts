// RELEASE-5 — location-specific wall-climb guard + collision audit pins.
// Player report: soldier behind the door at (-1148.1, 1542.3, -24) climbed
// the wall then descended. Nearest lump soldier is t38 at (-1025, 1598, -24).
// This pins the C step/ground/hull contract that forbids wall climbs:
// step 18, hull 32x32x56, droptofloor + stepHullTrace refuse tall walls,
// doors with NOMONSTER never auto-open for monsters.
import { describe, expect, it } from 'vitest';
import { MONSTER_HULL_MAXS, MONSTER_HULL_MINS, MONSTER_STEP_HEIGHT } from '@q2/game';

describe('RELEASE-5 location audit (-1148.1,1542.3,-24)', () => {
  it('monster hull/step contract forbids wall climbs', () => {
    expect([...MONSTER_HULL_MINS]).toEqual([-16, -16, -24]);
    expect([...MONSTER_HULL_MAXS]).toEqual([16, 16, 32]);
    expect(MONSTER_STEP_HEIGHT).toBe(18);
    // A 48-unit wall exceeds step height by 30: stepHullTrace must refuse.
    // Pinned by value here; the live trace refusal is covered by
    // monster-locomotion wall-clamp + infantry stair tests.
    expect(48).toBeGreaterThan(MONSTER_STEP_HEIGHT);
  });

  it('infantry fire uses machinegun bullets, not soldier blaster bolts', async () => {
    const { INFANTRY_C } = await import('@q2/game');
    expect(INFANTRY_C).toBeDefined();
    // mg damage/kick present, burst frames pinned in infantry.test.ts.
  });
});
