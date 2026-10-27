// @q2/game/corpses — misc_deadsoldier_die threshold + recipe (g_misc.c).
import { describe, expect, it } from 'vitest';
import {
  damageDeadsoldier,
  DEADSOLDIER_GIB_HEALTH,
  DEADSOLDIER_GIB_MODELS,
  DEADSOLDIER_GIB_SOUND,
} from './corpses.js';

describe('misc_deadsoldier gibbing (C g_misc.c misc_deadsoldier_die)', () => {
  it('threshold is -80, not a monster gib_health', () => {
    expect(DEADSOLDIER_GIB_HEALTH).toBe(-80);
  });

  it('recipe is 4x sm_meat + head2 over udeath', () => {
    expect([...DEADSOLDIER_GIB_MODELS]).toEqual(['sm_meat', 'sm_meat', 'sm_meat', 'sm_meat', 'head2']);
    expect(DEADSOLDIER_GIB_SOUND).toBe('misc/udeath.wav');
  });

  it('hits above -80 accumulate without mincing', () => {
    // Fresh corpse (health 0): 79 damage leaves -79, no mince.
    const r = damageDeadsoldier(0, 79);
    expect(r.health).toBe(-79);
    expect(r.gibbed).toBe(false);
  });

  it('the hit reaching -80 minces', () => {
    const r = damageDeadsoldier(-79, 1);
    expect(r.health).toBe(-80);
    expect(r.gibbed).toBe(true);
  });

  it('overkill past -80 keeps mincing (corpse is never freed)', () => {
    // C has no G_FreeEdict here: every qualifying hit re-gibs.
    expect(damageDeadsoldier(-80, 15).gibbed).toBe(true);
    expect(damageDeadsoldier(-200, 15).gibbed).toBe(true);
  });
});
