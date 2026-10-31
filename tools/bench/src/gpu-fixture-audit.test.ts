// Bench-lane regression pin for the PROOF-4 far/mip fixture wiring.
//
// The classifier (`./gpu-fixture-audit.js`) is unit-tested against
// synthetic degenerate AND repaired snippets (strict asserts — the
// classifier must tell them apart). The live page source is audited
// REPORT-ONLY: the test logs the current verdict and asserts only
// structural properties (both shipped gates found, correct pair found),
// so this test stays green both before and after the testkit-lane repair.
// The DEGENERATE verdict itself is recorded in `docs/perf-ledger.md` and
// `docs/gpu-follow-5-bench-lane.md`, not as a gate here.
//
// When the testkit lane repairs `gpu-browser-page.ts` (feed the shipped
// gates from the FAR_VIEW captures), the live log line will flip from
// DEGENERATE-HISTORICAL to EXERCISING and the lane docs must gain a
// follow-up ledger row. This test needs no change on that day.

import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { auditProofFixtureWiring, formatProofFixtureAudit } from './gpu-fixture-audit.js';

const DEGENERATE_SNIPPET = `
  var capFarOn = renderCapture(rawGL, rrFar, counted.draws, ENT_F1, LIGHTS_F1);
  var capFarOff = renderCapture(rawGL, rrFar, counted.draws, ENT_F1, LIGHTS_F1);
  var capFarViewOn = renderCapture(rawGL, rrFar, counted.draws, ENT_F1, LIGHTS_F1, FAR_VIEW);
  var capFarViewOff = renderCapture(rawGL, rrFar, counted.draws, ENT_F1, LIGHTS_F1, FAR_VIEW);
  var capF1P = renderCapture(rawGL, rrF1, counted.draws, ENT_F1, LIGHTS_F1);
  proof.appearance.farVsNear = summarize(diffStats(capFarOn.px, capF1P.px));
  proof.appearance.mipOnOff = summarize(diffStats(capFarOn.px, capFarOff.px));
`;

const REPAIRED_SNIPPET = `
  var capFarOn = renderCapture(rawGL, rrFar, counted.draws, ENT_F1, LIGHTS_F1);
  var capFarOff = renderCapture(rawGL, rrFar, counted.draws, ENT_F1, LIGHTS_F1);
  var capFarViewOn = renderCapture(rawGL, rrFar, counted.draws, ENT_F1, LIGHTS_F1, FAR_VIEW);
  var capFarViewOff = renderCapture(rawGL, rrFar, counted.draws, ENT_F1, LIGHTS_F1, FAR_VIEW);
  var capF1P = renderCapture(rawGL, rrF1, counted.draws, ENT_F1, LIGHTS_F1);
  proof.appearance.farVsNear = summarize(diffStats(capFarViewOn.px, capF1P.px));
  proof.appearance.mipOnOff = summarize(diffStats(capFarViewOn.px, capFarViewOff.px));
`;

describe('proof-4 far/mip fixture wiring audit (FOLLOW-5 bench lane)', () => {
  it('flags the same-camera shipped wiring as DEGENERATE-HISTORICAL', () => {
    const audit = auditProofFixtureWiring(DEGENERATE_SNIPPET);
    expect(audit.gates).toHaveLength(2);
    expect(audit.gates.map((g) => g.gate).sort()).toEqual(['farVsNear', 'mipOnOff']);
    for (const g of audit.gates) expect(g.degenerate).toBe(true);
    expect(audit.correctPairPresent).toBe(true);
    expect(audit.verdict).toBe('DEGENERATE-HISTORICAL');
  });

  it('recognises FAR_VIEW-fed shipped gates as EXERCISING', () => {
    const audit = auditProofFixtureWiring(REPAIRED_SNIPPET);
    expect(audit.gates).toHaveLength(2);
    for (const g of audit.gates) expect(g.degenerate).toBe(false);
    expect(audit.correctPairPresent).toBe(true);
    expect(audit.verdict).toBe('EXERCISING');
  });

  it('returns UNKNOWN (never a guessed verdict) on unparseable source', () => {
    const audit = auditProofFixtureWiring('// no fixture here\nvar x = 1;\n');
    expect(audit.verdict).toBe('UNKNOWN');
    expect(audit.gates.every((g) => g.degenerate === null)).toBe(true);
  });

  it('live page source audit (report-only; structural asserts only)', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const pagePath = join(testDir, '..', '..', '..', 'packages', 'testkit', 'src', 'gpu-browser-page.ts');
    if (!existsSync(pagePath)) {
      console.log('[fixture-audit] SKIP live audit: testkit page source absent');
      return;
    }
    const source = readFileSync(pagePath, 'utf8');
    const audit = auditProofFixtureWiring(source);
    console.log(`[fixture-audit] live wiring:\n${formatProofFixtureAudit(audit)}`);
    // Structural pins only: both shipped gates and the correct FAR_VIEW
    // pair must be locatable. The verdict itself is recorded in the lane
    // docs (DEGENERATE-HISTORICAL until the testkit lane repairs it).
    expect(audit.gates).toHaveLength(2);
    expect(audit.correctPairPresent).toBe(true);
  });
});
