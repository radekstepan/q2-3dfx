// q2-bench FOLLOW-5 fixture auditor (bench lane, bench-owned).
//
// Static, deterministic audit of the PROOF-4 far/mip fixture wiring in the
// testkit browser page (`packages/testkit/src/gpu-browser-page.ts`, read
// read-only — this lane never edits `packages/*`).
//
// Background (FOLLOW-2B lane evidence + d934fdc review): the shipped
// PROOF-4 gates read 0/0 while the page's CORRECT far-camera captures in
// the SAME run read real content:
//
//   appearance.farVsNear = 0, appearance.mipOnOff = 0              (shipped gates)
//   follow2b.farView.nonblackFrac = 0.978, farViewVsNear = 0.9937  (correct captures)
//
// Mechanism (`gpu-browser-page.ts`): `rrFar` selects its scene with
// FAR_VIEW, but the shipped gates are fed by `capFarOn`/`capFarOff`, which
// are rendered through the DEFAULT (near) camera:
//
//   var capFarOn  = renderCapture(rawGL, rrFar, counted.draws, ENT_F1, LIGHTS_F1);
//   var capFarOff = renderCapture(rawGL, rrFar, counted.draws, ENT_F1, LIGHTS_F1);
//   proof.appearance.farVsNear = summarize(diffStats(capFarOn.px,  capF1P.px));
//   proof.appearance.mipOnOff  = summarize(diffStats(capFarOn.px,  capFarOff.px));
//
// while the far-camera captures that DO exercise minification sit unused
// by the shipped gates:
//
//   var capFarViewOn  = renderCapture(..., FAR_VIEW);   // minified, nonblack 0.978
//   var capFarViewOff = renderCapture(..., FAR_VIEW);
//
// A gate named "far/mip" must be fed by captures taken through FAR_VIEW;
// a same-camera pair cannot exercise LOD/mip minification by construction.
// This auditor classifies each shipped gate from the page SOURCE so the
// repair (a testkit-lane edit) is machine-checkable without running a
// 10-minute browser leg: DEGENERATE-HISTORICAL before the repair,
// EXERCISING after.
//
// No `any` in exported signatures; no DOM; no imports from apps/*.

/** One shipped PROOF-4 gate and the capture pair that feeds it. */
export interface ProofFixtureGateWiring {
  /** Shipped gate name under `proof.appearance`. */
  gate: 'farVsNear' | 'mipOnOff';
  /** Capture identifier on the left of `diffStats`, if parseable. */
  leftCapture: string | null;
  /** Capture identifier on the right of `diffStats`, if parseable. */
  rightCapture: string | null;
  /**
   * View argument passed to `renderCapture` for the left capture (`FAR_VIEW`
   * when the far camera is used, `null` when the default near VIEW applies).
   */
  leftViewArg: string | null;
  /** Same for the right capture. */
  rightViewArg: string | null;
  /**
   * `true` when the gate pair cannot exercise minification by
   * construction; `false` when it can; `null` when the source shape is
   * unparseable (never guessed). Per-gate rule:
   * - `farVsNear`: degenerate when both captures share ONE camera (a
   *   "far vs near" comparison with no far camera compares two
   *   near-camera renders);
   * - `mipOnOff`: degenerate unless both captures share one NON-DEFAULT
   *   (far) camera — the dither toggle only bites at minified taps, and
   *   the near-camera pair converges to 0 by construction (magnified taps
   *   clamp lod to 0; over-minified taps clamp to uMaxLevel).
   */
  degenerate: boolean | null;
}

/** Whole-page audit result. */
export interface ProofFixtureAudit {
  gates: ProofFixtureGateWiring[];
  /** The correct FAR_VIEW capture pair exists in the page source. */
  correctPairPresent: boolean;
  /**
   * `DEGENERATE-HISTORICAL` while any shipped gate cannot exercise
   * minification; `EXERCISING` once every shipped gate is fed its
   * exercising wiring; `UNKNOWN` when the source shape is unparseable.
   */
  verdict: 'DEGENERATE-HISTORICAL' | 'EXERCISING' | 'UNKNOWN';
  /** Human-readable trace of what was (not) found. */
  notes: string[];
}

/** Shipped gates this auditor tracks. */
const TRACKED_GATES = ['farVsNear', 'mipOnOff'] as const;

/**
 * Split a `renderCapture(...)` argument list on top-level commas.
 * Arguments are plain identifiers / member access / literals (no nested
 * calls in the fixture), so depth tracking is a guard, not a parser.
 */
function splitTopLevelArgs(argText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of argText) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

/**
 * Map capture identifier -> view argument (`FAR_VIEW`, another identifier,
 * or `null` for the default VIEW). Only `renderCapture` definitions of the
 * form `<name> = renderCapture(<args>);` are considered.
 */
function captureViewArgs(pageSource: string): Map<string, string | null> {
  const views = new Map<string, string | null>();
  const re = /(\w+)\s*=\s*renderCapture\(([^;]*?)\)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pageSource)) !== null) {
    const name = m[1]!;
    const args = splitTopLevelArgs(m[2]!);
    // renderCapture(rawGL, rr, draws, entities, lights, view?): 6th arg is the view.
    views.set(name, args.length >= 6 ? args[5]! : null);
  }
  return views;
}

/**
 * Map shipped gate -> [leftCapture, rightCapture] from
 * `proof.appearance.<gate> = summarize(diffStats(<L>.px, <R>.px));`.
 */
function gateCapturePairs(pageSource: string): Map<string, [string, string]> {
  const pairs = new Map<string, [string, string]>();
  const re = /proof\.appearance\.(farVsNear|mipOnOff)\s*=\s*summarize\(diffStats\((\w+)\.px,\s*(\w+)\.px\)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pageSource)) !== null) {
    pairs.set(m[1]!, [m[2]!, m[3]!]);
  }
  return pairs;
}

/**
 * Statically audit the PROOF-4 far/mip fixture wiring in a page source.
 * Pure string analysis; never executes page code, never touches the page.
 */
export function auditProofFixtureWiring(pageSource: string): ProofFixtureAudit {
  const notes: string[] = [];
  const views = captureViewArgs(pageSource);
  const pairs = gateCapturePairs(pageSource);
  const gates: ProofFixtureGateWiring[] = [];
  let unparseable = false;

  for (const gate of TRACKED_GATES) {
    const pair = pairs.get(gate);
    if (!pair) {
      notes.push(`gate ${gate}: no proof.appearance assignment found (source shape changed?)`);
      unparseable = true;
      gates.push({ gate, leftCapture: null, rightCapture: null, leftViewArg: null, rightViewArg: null, degenerate: null });
      continue;
    }
    const [left, right] = pair;
    const leftKnown = views.has(left);
    const rightKnown = views.has(right);
    if (!leftKnown || !rightKnown) {
      notes.push(
        `gate ${gate}: capture definition missing for ${!leftKnown ? left : ''}${!leftKnown && !rightKnown ? '/' : ''}${!rightKnown ? right : ''} (source shape changed?)`,
      );
      unparseable = true;
      gates.push({ gate, leftCapture: left, rightCapture: right, leftViewArg: null, rightViewArg: null, degenerate: null });
      continue;
    }
    const leftView = views.get(left) ?? null;
    const rightView = views.get(right) ?? null;
    // Per-gate exercising rule (see the `degenerate` field docs): farVsNear
    // needs two DIFFERENT cameras; mipOnOff needs the SAME non-default
    // (minifying) camera on both sides.
    const degenerate =
      gate === 'farVsNear' ? leftView === rightView : !(leftView !== null && leftView === rightView);
    notes.push(
      `gate ${gate}: ${left} (view=${leftView ?? 'default-VIEW'}) vs ${right} (view=${rightView ?? 'default-VIEW'}) -> ${degenerate ? 'DEGENERATE (cannot exercise minification)' : 'EXERCISING'}`,
    );
    gates.push({ gate, leftCapture: left, rightCapture: right, leftViewArg: leftView, rightViewArg: rightView, degenerate });
  }

  const correctPairPresent =
    (views.get('capFarViewOn') ?? null) !== null && (views.get('capFarViewOff') ?? null) !== null;
  notes.push(
    correctPairPresent
      ? 'correct FAR_VIEW capture pair (capFarViewOn/capFarViewOff) present in source'
      : 'correct FAR_VIEW capture pair (capFarViewOn/capFarViewOff) NOT found (source shape changed?)',
  );
  if (!correctPairPresent) unparseable = true;

  const verdict =
    unparseable
      ? 'UNKNOWN'
      : gates.every((g) => g.degenerate === false)
        ? 'EXERCISING'
        : 'DEGENERATE-HISTORICAL';
  notes.push(`verdict: ${verdict}`);
  return { gates, correctPairPresent, verdict, notes };
}

/**
 * One-line human summary of an audit (for logs and manifests).
 */
export function formatProofFixtureAudit(audit: ProofFixtureAudit): string {
  const gateLines = audit.gates.map((g) => {
    const state = g.degenerate === null ? 'UNPARSEABLE' : g.degenerate ? 'DEGENERATE' : 'EXERCISING';
    return `  gate ${g.gate}: ${g.leftCapture ?? '?'} vs ${g.rightCapture ?? '?'} -> ${state}`;
  });
  return ['proof-4 far/mip fixture audit', ...gateLines, `  verdict: ${audit.verdict}`].join('\n');
}
