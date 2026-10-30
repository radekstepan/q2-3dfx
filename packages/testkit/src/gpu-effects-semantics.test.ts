// @q2/testkit — GPU-FOLLOW-3 lane C tests: live arsenal + required effects.
//
// Owns: `packages/testkit` ONLY. The oracle is the CPU reference
// (`SoftwareRenderer` on/off deltas over the hermetic single-room fixture +
// the pure `refreshGpuScene` selector classification) — never GPU/renderer
// self-agreement. Tampered captures (unfired weapon, unseen enemy, untaken
// pickup, zeroed effect pixels/submissions, dropped/duplicated events) keep
// HEALTHY frames/uploads/screenshot counts to prove the FOLLOW-3 gate
// rejects what the submission gate passes.

import { describe, expect, it } from 'vitest';
import {
  buildEffectFixtureWorld,
  deriveFollow3EffectOracle,
  FOLLOW3_LIVE_WEAPONS,
  FOLLOW3_PIXEL_KEY,
  FOLLOW3_REQUIRED_EFFECTS,
  FOLLOW3_REQUIRED_ENEMIES,
  FOLLOW3_REQUIRED_PICKUPS,
  FOLLOW3_SUBMITTED_KEY,
  formatFollow3HudNote,
  validateFollow3Coverage,
  validateLiveArsenal,
  validateRequiredEffects,
  validateEffectEventDrain,
  type Follow3CombatEvent,
  type Follow3EffectOracle,
  type Follow3LiveCapture,
} from './gpu-effects-semantics.js';
import { validateSceneCoverage } from './gpu-acceptance.js';

/** Healthy submission/capture counts (identical for pass AND tamper legs). */
function healthyCoverage(): Follow3LiveCapture['coverage'] {
  return {
    framesSubmittedStart: 100,
    framesSubmittedEnd: 70000,
    uploads: 7,
    screenshotsPresent: true,
    workloads: ['stationary', 'moving', 'combat'],
  };
}

/** Healthy combat-event log: every live weapon fired, impacts caused, one take. */
function healthyEvents(): Follow3CombatEvent[] {
  return [
    { id: 1, kind: 'fire-blaster', tick: 0.1 },
    { id: 2, kind: 'bolt-impact', tick: 0.2 },
    { id: 3, kind: 'fire-shotgun', tick: 0.3 },
    { id: 4, kind: 'hitscan-impact', tick: 0.3 },
    { id: 5, kind: 'fire-machinegun', tick: 0.4 },
    { id: 6, kind: 'hitscan-impact', tick: 0.4 },
    { id: 7, kind: 'monster-shot', tick: 0.5 },
    { id: 8, kind: 'bolt-impact', tick: 0.6 },
    { id: 9, kind: 'pickup', tick: 0.7 },
  ];
}

/** Oracle-matching capture: arsenal exercised, every effect submitted + visible. */
function healthyCapture(oracle: Follow3EffectOracle): Follow3LiveCapture {
  return {
    coverage: healthyCoverage(),
    weaponsFired: [...FOLLOW3_LIVE_WEAPONS],
    enemiesObserved: [...FOLLOW3_REQUIRED_ENEMIES],
    pickupsTaken: [...FOLLOW3_REQUIRED_PICKUPS],
    submitted: { sprites: 3, particles: 24, beams: 2, explosions: 1, lights: 2 },
    entityRefs: 12,
    pixels: {
      sprites: oracle.minPixels.sprite * 40 + 500,
      particles: oracle.minPixels.particle * 40 + 500,
      beams: oracle.minPixels.beam * 40 + 500,
      explosions: oracle.minPixels.explosion * 40 + 500,
    },
    uploadErrors: 0,
    missingMeshes: [],
  };
}

describe('CPU effect oracle derivation (fixture geometry, never self-agreement)', () => {
  it('derives positive pixel floors for every drawable kind', () => {
    const oracle = deriveFollow3EffectOracle(buildEffectFixtureWorld());
    expect(oracle.minPixels.sprite).toBeGreaterThanOrEqual(1);
    expect(oracle.minPixels.particle).toBeGreaterThanOrEqual(1);
    expect(oracle.minPixels.beam).toBeGreaterThanOrEqual(1);
    expect(oracle.minPixels.explosion).toBeGreaterThanOrEqual(1);
  });
  it('derives a positive lit-delta for the dynamic light and unit submission floors', () => {
    const oracle = deriveFollow3EffectOracle(buildEffectFixtureWorld());
    expect(oracle.lightDeltaPixels).toBeGreaterThanOrEqual(1);
    for (const k of FOLLOW3_REQUIRED_EFFECTS) {
      expect(oracle.minSubmitted[k]).toBeGreaterThanOrEqual(1);
    }
  });
  it('requires all three live weapons, both base1 enemies and the proven pickup', () => {
    expect([...FOLLOW3_LIVE_WEAPONS].sort()).toEqual(['weapon_blaster', 'weapon_machinegun', 'weapon_shotgun']);
    expect([...FOLLOW3_REQUIRED_ENEMIES].sort()).toEqual(['infantry', 'soldier']);
    expect(FOLLOW3_REQUIRED_PICKUPS).toContain('weapon_shotgun');
  });
});

describe('validateFollow3Coverage (FOLLOW-3 close-out gate)', () => {
  it('PASSES the oracle-matching combat leg', () => {
    const oracle = deriveFollow3EffectOracle(buildEffectFixtureWorld());
    const v = validateFollow3Coverage(healthyCapture(oracle), oracle, healthyEvents());
    expect(v.verdict).toBe('PASS');
  });
  it('PASSES the drain gate on the healthy event log', () => {
    expect(validateEffectEventDrain(healthyEvents()).verdict).toBe('PASS');
  });
  it('REJECTS an unfired live weapon even with healthy counts', () => {
    const oracle = deriveFollow3EffectOracle(buildEffectFixtureWorld());
    const capture = healthyCapture(oracle);
    expect(validateSceneCoverage(capture.coverage).verdict).toBe('PASS');
    capture.weaponsFired = capture.weaponsFired.filter((w) => w !== 'weapon_machinegun');
    const v = validateFollow3Coverage(capture, oracle, healthyEvents());
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join('; ')).toMatch(/weapon_machinegun/);
  });
  it('REJECTS an unknown weapon classname (wiring bug, never ignored)', () => {
    const oracle = deriveFollow3EffectOracle(buildEffectFixtureWorld());
    const capture = healthyCapture(oracle);
    capture.weaponsFired = [...capture.weaponsFired, 'weapon_plasma'];
    expect(validateLiveArsenal(capture).verdict).toBe('FAIL');
  });
  it('REJECTS an unobserved enemy even with healthy counts', () => {
    const oracle = deriveFollow3EffectOracle(buildEffectFixtureWorld());
    const capture = healthyCapture(oracle);
    capture.enemiesObserved = ['soldier'];
    const v = validateFollow3Coverage(capture, oracle, healthyEvents());
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join('; ')).toMatch(/infantry/);
  });
  it('REJECTS an untaken pickup even with healthy counts', () => {
    const oracle = deriveFollow3EffectOracle(buildEffectFixtureWorld());
    const capture = healthyCapture(oracle);
    capture.pickupsTaken = [];
    const v = validateFollow3Coverage(capture, oracle, healthyEvents());
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join('; ')).toMatch(/weapon_shotgun/);
  });
  it('REJECTS missing meshes in a supported scene', () => {
    const oracle = deriveFollow3EffectOracle(buildEffectFixtureWorld());
    const capture = healthyCapture(oracle);
    (capture as { missingMeshes: readonly string[] }).missingMeshes = ['models/monsters/soldier/tris.md2'];
    const v = validateFollow3Coverage(capture, oracle, healthyEvents());
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join('; ')).toMatch(/missingMeshes/);
  });
  it('REJECTS a zeroed effect submission per required kind at healthy counts', () => {
    const oracle = deriveFollow3EffectOracle(buildEffectFixtureWorld());
    for (const kind of FOLLOW3_REQUIRED_EFFECTS) {
      const capture = healthyCapture(oracle);
      expect(validateSceneCoverage(capture.coverage).verdict).toBe('PASS');
      capture.submitted = { ...capture.submitted, [FOLLOW3_SUBMITTED_KEY[kind]]: 0 };
      const v = validateRequiredEffects(oracle, capture);
      expect(v.verdict).toBe('FAIL');
      expect(v.reasons.join('; ')).toMatch(new RegExp(kind));
    }
  });
  it('REJECTS zeroed effect pixels per drawable kind (submitted but invisible)', () => {
    const oracle = deriveFollow3EffectOracle(buildEffectFixtureWorld());
    for (const kind of ['sprite', 'particle', 'beam', 'explosion'] as const) {
      const capture = healthyCapture(oracle);
      capture.pixels = { ...capture.pixels, [FOLLOW3_PIXEL_KEY[kind]]: 0 };
      const v = validateRequiredEffects(oracle, capture);
      expect(v.verdict).toBe('FAIL');
      expect(v.reasons.join('; ')).toMatch(new RegExp(kind));
    }
  });
  it('REJECTS upload errors on the combat leg', () => {
    const oracle = deriveFollow3EffectOracle(buildEffectFixtureWorld());
    const capture = healthyCapture(oracle);
    capture.uploadErrors = 2;
    expect(validateRequiredEffects(oracle, capture).verdict).toBe('FAIL');
  });
  it('REJECTS a double-consumed event id', () => {
    const events = healthyEvents();
    events[3] = { ...events[3]!, id: events[2]!.id };
    const v = validateEffectEventDrain(events);
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join('; ')).toMatch(/twice|double/);
  });
  it('REJECTS out-of-order ticks and impacts without producers', () => {
    const shuffled = healthyEvents().reverse();
    expect(validateEffectEventDrain(shuffled).verdict).toBe('FAIL');
    const orphan: Follow3CombatEvent[] = [{ id: 1, kind: 'bolt-impact', tick: 0.2 }];
    const v = validateEffectEventDrain(orphan);
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join('; ')).toMatch(/preceding fire|no fire/);
  });
  it('REJECTS an empty event log (combat never happened)', () => {
    expect(validateEffectEventDrain([]).verdict).toBe('FAIL');
  });
  it('REJECTS stalled submissions through the wired coverage gate', () => {
    const oracle = deriveFollow3EffectOracle(buildEffectFixtureWorld());
    const capture = healthyCapture(oracle);
    const stalled: Follow3LiveCapture = {
      ...capture,
      coverage: { ...capture.coverage, framesSubmittedEnd: 100 },
    };
    const v = validateFollow3Coverage(stalled, oracle, healthyEvents());
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join('; ')).toMatch(/framesSubmitted/);
  });
  it('keeps the GPU-resident HUD optional (report-only, never a gate)', () => {
    expect(formatFollow3HudNote(null)).toMatch(/not required/);
    expect(formatFollow3HudNote(0.4)).toMatch(/0\.4ms/);
  });
});
