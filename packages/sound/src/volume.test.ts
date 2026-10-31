// RELEASE-1 — quiet capped volume scale: actual output gain, not just the cvar.
import { describe, expect, it, beforeEach } from 'vitest';
import { ATTN_NORM, Mixer, masterOutputGainFromConfig, normalizeMasterVolume } from './index.js';
import { S_VOLUME_REFERENCE_GAIN, getCVarNumber, resetCVars, setCVar, setCVarFromString, sVolumeToOutputGain } from '@q2/config';

beforeEach(() => {
  resetCVars();
});

describe('RELEASE-1 volume cap', () => {
  it('new default 1 maps to old quiet gain 0.05', () => {
    expect(getCVarNumber('s_volume')).toBe(1);
    expect(sVolumeToOutputGain(1)).toBeCloseTo(0.05, 9);
    expect(S_VOLUME_REFERENCE_GAIN).toBe(0.05);
  });

  it('default mixer output is capped, not 1.0', () => {
    const m = new Mixer();
    m.syncMasterVolFromConfig();
    m.setListener([0, 0, 0], [0, 1, 0]);
    m.startSound({
      origin: [0, 0, 0],
      fixedOrigin: false,
      entnum: 1,
      attenuation: ATTN_NORM,
      masterVol: 1,
      loop: false,
      name: 'self/blaster.wav',
    });
    const mixed = m.mix();
    expect(mixed).toHaveLength(1);
    expect(mixed[0]!.left).toBeCloseTo(0.05, 9);
    expect(mixed[0]!.right).toBeCloseTo(0.05, 9);
    expect(m.effectiveOutputGain).toBeCloseTo(0.05, 9);
  });

  it('zero mutes; max never exceeds 0.05', () => {
    const m = new Mixer();
    m.setListener([0, 0, 0], [0, 1, 0]);
    setCVar('s_volume', 0);
    m.syncMasterVolFromConfig();
    m.startSound({ origin: [0, 0, 0], fixedOrigin: false, entnum: 1, attenuation: ATTN_NORM, masterVol: 1, loop: false, name: 'a.wav' });
    expect(m.mix()[0]!.left).toBe(0);
    m.stopAll();
    setCVar('s_volume', 1);
    m.syncMasterVolFromConfig();
    m.startSound({ origin: [0, 0, 0], fixedOrigin: false, entnum: 1, attenuation: ATTN_NORM, masterVol: 1, loop: false, name: 'b.wav' });
    expect(m.mix()[0]!.left).toBeLessThanOrEqual(0.0500001);
    expect(m.mix()[0]!.left).toBeCloseTo(0.05, 9);
  });

  it('out-of-range values clamp; invalid mutes', () => {
    expect(sVolumeToOutputGain(5)).toBeCloseTo(0.05, 9);
    expect(sVolumeToOutputGain(-2)).toBe(0);
    expect(sVolumeToOutputGain(Number.NaN)).toBe(0);
    expect(sVolumeToOutputGain(Number.POSITIVE_INFINITY)).toBe(0);
    expect(sVolumeToOutputGain('loud')).toBe(0);
    expect(sVolumeToOutputGain(undefined)).toBe(0);
    // Legacy 0.8 maps to quiet 0.04, never double-scaled.
    expect(sVolumeToOutputGain(0.8)).toBeCloseTo(0.04, 9);
    expect(normalizeMasterVolume(0.8)).toBeCloseTo(0.8, 9);
  });

  it('console coercion clamps through the same path', () => {
    setCVarFromString('s_volume', '3');
    expect(masterOutputGainFromConfig()).toBeCloseTo(0.05, 9);
    setCVarFromString('s_volume', 'not-a-number');
    expect(masterOutputGainFromConfig()).toBe(0);
  });

  it('overlapping combat sounds never exceed the cap per-channel', () => {
    const m = new Mixer();
    m.setListener([0, 0, 0], [0, 1, 0]);
    setCVar('s_volume', 1);
    m.syncMasterVolFromConfig();
    for (let i = 0; i < 8; i++) {
      m.startSound({ origin: [10 * i, 0, 0], fixedOrigin: false, entnum: 1, attenuation: ATTN_NORM, masterVol: 1, loop: false, name: `shot${i}.wav` });
    }
    const mixed = m.mix();
    expect(mixed.length).toBeGreaterThan(0);
    for (const ch of mixed) {
      expect(ch.left).toBeLessThanOrEqual(0.0500001);
      expect(ch.right).toBeLessThanOrEqual(0.0500001);
    }
  });

  it('positional attenuation preserved under the cap', () => {
    const m = new Mixer();
    m.setListener([0, 0, 0], [0, 1, 0]);
    setCVar('s_volume', 1);
    m.syncMasterVolFromConfig();
    m.startSound({ origin: [500, 0, 0], fixedOrigin: true, entnum: 0, attenuation: ATTN_NORM, masterVol: 1, loop: false, name: 'near.wav' });
    m.startSound({ origin: [900, 0, 0], fixedOrigin: true, entnum: 0, attenuation: ATTN_NORM, masterVol: 1, loop: false, name: 'far.wav' });
    const mixed = m.mix();
    const near = mixed.find((c) => c.name === 'near.wav')!;
    const far = mixed.find((c) => c.name === 'far.wav')!;
    expect(near.left).toBeGreaterThan(far.left);
    expect(near.left).toBeLessThanOrEqual(0.0500001);
  });
});
