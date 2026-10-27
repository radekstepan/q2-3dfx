// M4.1 capture table: single source for the written capture instructions.
import { describe, expect, it } from 'vitest';
import { getCVarNumber } from '@q2/config';
import { captureCVarTable, defaultVoodooState } from './index.js';

describe('capture table', () => {
  it('lists all 12 vd_* cvars at their registered defaults', () => {
    const table = captureCVarTable();
    expect(table).toHaveLength(12);
    expect(table.map((c) => c.name)).toEqual([
      'vd_16bit',
      'vd_dither',
      'vd_postfilter',
      'vd_bilinear',
      'vd_mipdither',
      'vd_lodbias',
      'vd_fog',
      'vd_gamma',
      'vd_maxtexsize',
      'vd_zbits',
      'vd_palettetex',
      'vd_overbright',
    ]);
    // Every row matches the live registered default (no drift between the
    // written instructions and the comparison harness).
    for (const row of table) {
      expect(row.value).toBe(getCVarNumber(row.name));
    }
    const st = defaultVoodooState();
    expect(st.gamma).toBe(1.3);
    expect(st.lodbias).toBe(-0.35);
  });

  it('is deterministic (same rows twice)', () => {
    expect(captureCVarTable()).toEqual(captureCVarTable());
  });
});
