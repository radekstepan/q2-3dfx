// @q2/testkit — GPU-FOLLOW-2C lane tests: semantic content + occlusion coverage.
//
// Owns: `packages/testkit` ONLY. The oracle is the CPU reference
// (`SoftwareRenderer` renders + `collectVisibleSurfaces` traversal over the
// hermetic two-room fixture) — never GPU/renderer self-agreement. Tampered
// captures (removed wall/enemy, broken occluder) keep HEALTHY
// frames/uploads/screenshot counts to prove the semantic gate rejects what
// the submission gate passes.

import { describe, expect, it } from 'vitest';
import {
  buildSemanticFixtureWorld,
  deriveSemanticOracle,
  validateSceneCoverageAndContent,
  validateSceneSemanticContent,
  type LiveRouteSemanticCapture,
  type SceneSemanticOracle,
} from './gpu-scene-semantics.js';
import { validateSceneCoverage } from './gpu-acceptance.js';

/** Healthy submission/capture counts (identical for pass AND tamper legs). */
function healthyCoverage(): LiveRouteSemanticCapture['coverage'] {
  return {
    framesSubmittedStart: 100,
    framesSubmittedEnd: 70000,
    uploads: 7,
    screenshotsPresent: true,
    workloads: ['stationary', 'moving', 'combat'],
  };
}

/** Oracle-matching observations: every visible region well above its floor. */
function healthyCapture(oracle: SceneSemanticOracle): LiveRouteSemanticCapture {
  return {
    coverage: healthyCoverage(),
    waypoints: oracle.cameras.map((cam) => {
      const regionPixels: Record<string, number> = {};
      for (const name of oracle.visible[cam.label] ?? []) regionPixels[name] = oracle.minRegionPixels * 40 + 500;
      for (const occ of oracle.occlusions) {
        if (occ.camera === cam.label) regionPixels[occ.hidden] = 0;
      }
      return {
        label: cam.label,
        room: cam.label === 'room-a-view' ? 'room-a' : 'room-b',
        cluster: cam.cluster,
        mover: cam.label === 'room-a-view' ? 'door-closed' : 'door-open',
        regionPixels,
        enemyPixels: oracle.minActorPixels * 10 + 50,
        viewmodelPixels: oracle.minActorPixels * 10 + 50,
        uploadErrors: 0,
        missingMeshes: [],
      };
    }),
  };
}

describe('CPU oracle derivation (fixture geometry, never self-agreement)', () => {
  it('marks room-A regions visible and room-B hidden from room-a-view', () => {
    const oracle = deriveSemanticOracle(buildSemanticFixtureWorld());
    const seenA = oracle.visible['room-a-view'] ?? [];
    expect(seenA).toContain('wall-a');
    expect(seenA).toContain('floor-a');
    expect(seenA).toContain('ceiling-a');
    expect(seenA).toContain('divider');
    expect(seenA).not.toContain('wall-b');
    expect(seenA).not.toContain('floor-b');
    expect(seenA).not.toContain('ceiling-b');
  });
  it('marks room-B regions visible from room-b-view (multi-room)', () => {
    const oracle = deriveSemanticOracle(buildSemanticFixtureWorld());
    const seenB = oracle.visible['room-b-view'] ?? [];
    expect(seenB).toContain('wall-b');
    expect(seenB).toContain('floor-b');
    expect(seenB).toContain('ceiling-b');
  });
  it('pins divider-occludes-room-B rules verified against CPU sets', () => {
    const oracle = deriveSemanticOracle(buildSemanticFixtureWorld());
    expect(oracle.occlusions.length).toBeGreaterThan(0);
    for (const occ of oracle.occlusions) {
      expect(occ.occluder).toBe('divider');
      expect(occ.camera).toBe('room-a-view');
    }
    expect(oracle.occlusions.map((o) => o.hidden).sort()).toEqual(['ceiling-b', 'floor-b', 'wall-b']);
  });
  it('requires one enemy + viewmodel with positive CPU-derived floors', () => {
    const oracle = deriveSemanticOracle(buildSemanticFixtureWorld());
    expect(oracle.requiredActors).toEqual(['enemy', 'viewmodel']);
    expect(oracle.minRegionPixels).toBeGreaterThanOrEqual(1);
    expect(oracle.minActorPixels).toBeGreaterThanOrEqual(1);
    expect(oracle.maxHiddenPixels).toBe(0);
  });
});

describe('validateSceneCoverageAndContent (successor gate)', () => {
  it('PASSES the oracle-matching live route', () => {
    const oracle = deriveSemanticOracle(buildSemanticFixtureWorld());
    const v = validateSceneCoverageAndContent(healthyCapture(oracle), oracle);
    expect(v.verdict).toBe('PASS');
  });
  it('REJECTS a removed wall even with healthy frames/uploads/screenshots', () => {
    const oracle = deriveSemanticOracle(buildSemanticFixtureWorld());
    const capture = healthyCapture(oracle);
    // Submission gate alone still passes — the scene "looks healthy".
    expect(validateSceneCoverage(capture.coverage).verdict).toBe('PASS');
    const wp = capture.waypoints.find((w) => w.label === 'room-a-view')!;
    wp.regionPixels['wall-a'] = 0;
    const v = validateSceneCoverageAndContent(capture, oracle);
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join('; ')).toMatch(/wall-a/);
  });
  it('REJECTS a removed floor and a removed ceiling by name', () => {
    const oracle = deriveSemanticOracle(buildSemanticFixtureWorld());
    for (const removed of ['floor-b', 'ceiling-b']) {
      const capture = healthyCapture(oracle);
      const wp = capture.waypoints.find((w) => w.label === 'room-b-view')!;
      wp.regionPixels[removed] = 0;
      const v = validateSceneCoverageAndContent(capture, oracle);
      expect(v.verdict).toBe('FAIL');
      expect(v.reasons.join('; ')).toMatch(new RegExp(removed));
    }
  });
  it('REJECTS a removed enemy even with healthy counts', () => {
    const oracle = deriveSemanticOracle(buildSemanticFixtureWorld());
    const capture = healthyCapture(oracle);
    expect(validateSceneCoverage(capture.coverage).verdict).toBe('PASS');
    for (const wp of capture.waypoints) wp.enemyPixels = 0;
    const v = validateSceneSemanticContent(oracle, capture);
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join('; ')).toMatch(/enemy/);
  });
  it('REJECTS a removed viewmodel even with healthy counts', () => {
    const oracle = deriveSemanticOracle(buildSemanticFixtureWorld());
    const capture = healthyCapture(oracle);
    for (const wp of capture.waypoints) wp.viewmodelPixels = 0;
    const v = validateSceneSemanticContent(oracle, capture);
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join('; ')).toMatch(/viewmodel/);
  });
  it('REJECTS visible hidden content (occluder removed) at healthy counts', () => {
    const oracle = deriveSemanticOracle(buildSemanticFixtureWorld());
    const capture = healthyCapture(oracle);
    expect(validateSceneCoverage(capture.coverage).verdict).toBe('PASS');
    const wp = capture.waypoints.find((w) => w.label === 'room-a-view')!;
    wp.regionPixels['wall-b'] = 900; // divider gone: room B leaks through
    const v = validateSceneSemanticContent(oracle, capture);
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join('; ')).toMatch(/divider/);
    expect(v.reasons.join('; ')).toMatch(/wall-b/);
  });
  it('REJECTS a missing waypoint, upload errors and missing meshes', () => {
    const oracle = deriveSemanticOracle(buildSemanticFixtureWorld());
    const dropped = healthyCapture(oracle);
    const cut = {
      coverage: dropped.coverage,
      waypoints: dropped.waypoints.filter((w) => w.label !== 'room-b-view'),
    };
    expect(validateSceneSemanticContent(oracle, cut).verdict).toBe('FAIL');
    expect(validateSceneSemanticContent(oracle, cut).reasons.join('; ')).toMatch(/room-b-view/);

    const glErr = healthyCapture(oracle);
    glErr.waypoints[0]!.uploadErrors = 3;
    expect(validateSceneSemanticContent(oracle, glErr).verdict).toBe('FAIL');

    const missing = healthyCapture(oracle);
    (missing.waypoints[0] as { missingMeshes: readonly string[] }).missingMeshes = ['soldier'];
    expect(validateSceneSemanticContent(oracle, missing).verdict).toBe('FAIL');
    expect(validateSceneSemanticContent(oracle, missing).reasons.join('; ')).toMatch(/soldier/);
  });
  it('REJECTS stalled submissions through the wired coverage gate', () => {
    const oracle = deriveSemanticOracle(buildSemanticFixtureWorld());
    const capture = healthyCapture(oracle);
    const stalled: LiveRouteSemanticCapture = {
      ...capture,
      coverage: { ...capture.coverage, framesSubmittedEnd: 100 },
    };
    const v = validateSceneCoverageAndContent(stalled, oracle);
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons.join('; ')).toMatch(/framesSubmitted/);
  });
});
