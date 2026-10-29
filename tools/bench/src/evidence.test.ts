// q2-bench evidence unit tests (PERF-NEXT-1, bench lane).
//
// Pure/hermetic only: schema validation, env allowlisting, pak identity,
// fidelity keys. No pak, no workers, no wall-clock budgets — the timing
// gates live in bench:accept, never in vitest.
import { describe, expect, it } from 'vitest';
import {
  BROWSER_SOAK_SCHEMA_VERSION,
  collectFidelityProfile,
  pakIdentity,
  provenanceEnv,
  validateBrowserSoak,
  type BrowserSoakRecord,
} from './evidence.js';
import { pinPerfCvars } from './rgbattr.js';

function validSoak(): BrowserSoakRecord {
  return {
    schemaVersion: BROWSER_SOAK_SCHEMA_VERSION,
    commitShort: '4631ca2',
    commitFull: null,
    date: new Date().toISOString(),
    browser: { name: 'Chromium', version: '130.0.6723.91', headless: true },
    compositor: 'swiftshader',
    compositorDetail: 'WebKit WebGL2 (Google Inc., ANGLE SwiftShader)',
    hardwareBacked: false,
    page: 'http://localhost:5173/?map=base1',
    resolution: '640x480',
    width: 640,
    height: 480,
    renderer: 'voodoo',
    workers: [7],
    durationS: 326,
    samples: 66,
    presentedFpsMedian: 15,
    frameP50Ms: 66.7,
    frameP95Ms: 71.2,
    frameMaxMs: 80.1,
    workloads: ['stationary', 'moving', 'combat'],
    notes: 'headless swiftshader baseline',
    rawFile: null,
  };
}

describe('validateBrowserSoak', () => {
  it('accepts a minimal valid headless-swiftshader record', () => {
    expect(validateBrowserSoak(validSoak())).toEqual({ ok: true, errors: [] });
  });
  it('rejects unknown compositor (must be explicitly classified)', () => {
    const r = { ...validSoak(), compositor: 'unknown' as const };
    const v = validateBrowserSoak(r);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(/explicitly classified/);
  });
  it('rejects hardwareBacked/compositor contradictions', () => {
    const hw = validateBrowserSoak({ ...validSoak(), hardwareBacked: true });
    expect(hw.ok).toBe(false);
    expect(hw.errors.join('\n')).toMatch(/contradicts/);
    const sw = validateBrowserSoak({ ...validSoak(), compositor: 'hardware' as const, hardwareBacked: false });
    expect(sw.ok).toBe(false);
  });
  it('rejects missing browser version and resolution mismatch', () => {
    const v = validateBrowserSoak({
      ...validSoak(),
      browser: { name: 'Chromium', version: '', headless: true },
      resolution: '320x240',
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(/browser\.version/);
    expect(v.errors.join('\n')).toMatch(/resolution/);
  });
  it('rejects non-objects', () => {
    expect(validateBrowserSoak(null).ok).toBe(false);
    expect(validateBrowserSoak('soak').ok).toBe(false);
  });
});

describe('provenanceEnv', () => {
  it('records only allowlisted bench env (no secret leakage)', () => {
    process.env.Q2_PAK = '/tmp/pak0.pak';
    process.env.COMPARE_REPS = '5';
    process.env.EVIDENCE_TEST_SECRET = 'must-not-appear';
    const env = provenanceEnv();
    expect(env['Q2_PAK']).toBe('/tmp/pak0.pak');
    expect(env['COMPARE_REPS']).toBe('5');
    expect('EVIDENCE_TEST_SECRET' in env).toBe(false);
    delete process.env.EVIDENCE_TEST_SECRET;
  });
});

describe('pakIdentity', () => {
  it('flags missing pak without throwing (never reads contents)', () => {
    const id = pakIdentity('/nonexistent/pak0.pak');
    expect(id.missing).toBe(true);
    expect(id.bytes).toBeNull();
  });
});

describe('collectFidelityProfile', () => {
  it('covers every vd_* key plus sw_* after pinning', () => {
    pinPerfCvars();
    const f = collectFidelityProfile();
    for (const k of [
      'vd_gamma', 'vd_lodbias', 'vd_dither', 'vd_postfilter', 'vd_fog',
      'vd_16bit', 'vd_bilinear', 'vd_mipdither', 'vd_overbright', 'vd_palettetex',
      'vd_maxtexsize', 'vd_zbits', 'vd_dithermode', 'vd_reconmode', 'vd_rgbmaxdelta',
    ]) {
      expect(f.vd[k]).toBeDefined();
    }
    expect(f.vd['vd_gamma']).toBe('1.3');
    expect(f.vd['vd_reconmode']).toBe('2x2sub+2x2box');
    expect(f.sw['sw_workers']).toBeDefined();
    expect(f.sw['sw_accum']).toBeDefined();
  });
});
