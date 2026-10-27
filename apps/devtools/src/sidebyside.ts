// devtools M4.1 human-review helper (dependency-free).
//
// Thin presentation layer over the `@q2/testkit` side-by-side stats: the
// reviewer pastes harness numbers in (or the CLI wires them later) and gets
// a review document. Pixel math is duplicated here in ~15 lines on purpose:
// apps are leaves and must not depend on `@q2/testkit` (test-only harness).
// Canonical tolerance: BRAIN.md §10.3 (<=0.5% px differing by <=1 LSB).

export const REVIEW_TOLERANCE_FRACTION = 0.005;
export const REVIEW_TOLERANCE_LSB = 1;

export interface ReviewView {
  name: string;
  pixels: number;
  diff: number;
  fraction: number;
  maxAbsDelta: number;
  pass: boolean;
  referencePresent: boolean;
}

/** Summarize one view: our display buffer vs a reference capture (null = pending). */
export function summarizeReview(
  name: string,
  actual: Uint32Array,
  reference: Uint32Array | null,
  lsb = REVIEW_TOLERANCE_LSB,
  fraction = REVIEW_TOLERANCE_FRACTION,
): ReviewView {
  if (reference === null) {
    return { name, pixels: actual.length, diff: 0, fraction: 0, maxAbsDelta: 0, pass: false, referencePresent: false };
  }
  let diff = 0;
  let maxAbsDelta = 0;
  const n = Math.max(actual.length, reference.length);
  for (let i = 0; i < n; i++) {
    const x = actual[i] ?? 0;
    const y = reference[i] ?? 0;
    if (x === y) continue;
    const dr = Math.abs((x & 255) - (y & 255));
    const dg = Math.abs(((x >> 8) & 255) - ((y >> 8) & 255));
    const db = Math.abs(((x >> 16) & 255) - ((y >> 16) & 255));
    const m = Math.max(dr, dg, db);
    if (m > maxAbsDelta) maxAbsDelta = m;
    if (dr <= lsb && dg <= lsb && db <= lsb) continue;
    diff++;
  }
  const fr = actual.length === 0 ? 0 : diff / actual.length;
  return { name, pixels: actual.length, diff, fraction: fr, maxAbsDelta, pass: fr <= fraction, referencePresent: true };
}

/** One-line verdict per view (missing reference stays visibly pending). */
export function reviewLine(v: ReviewView): string {
  if (!v.referencePresent) return `${v.name}: reference capture missing — human review pending`;
  const pct = (v.fraction * 100).toFixed(3);
  return `${v.name}: ${v.diff}/${v.pixels} px (${pct}%) maxΔ${v.maxAbsDelta} ${v.pass ? 'PASS' : 'FAIL'}`;
}

/** Standalone HTML review document (table + verdicts, no pixel embedding). */
export function reviewReportHtml(views: ReviewView[]): string {
  const rows = views
    .map(
      (v) =>
        `<tr><td>${v.name}</td><td>${v.referencePresent ? 'yes' : 'PENDING'}</td>` +
        `<td>${v.diff}</td><td>${(v.fraction * 100).toFixed(3)}%</td>` +
        `<td>${v.maxAbsDelta}</td><td>${v.referencePresent ? (v.pass ? 'PASS' : 'FAIL') : '—'}</td></tr>`,
    )
    .join('');
  const allPass = views.length > 0 && views.every((v) => v.referencePresent && v.pass);
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<title>M4.1 Voodoo3 side-by-side review</title></head><body>' +
    '<h1>M4.1 Voodoo3 side-by-side review</h1>' +
    `<p>Overall: ${allPass ? 'PASS — human sign-off may tick the M4.1 box' : 'PENDING/FAIL — see CAPTURE-M4.1.md'}</p>` +
    '<table border="1"><tr><th>view</th><th>reference</th><th>diff px</th>' +
    '<th>fraction</th><th>max Δ</th><th>verdict</th></tr>' +
    rows +
    '</table></body></html>'
  );
}

/**
 * Human capture checklist (short form; the full instructions live in
 * `packages/testkit/CAPTURE-M4.1.md`, cvar values single-sourced from
 * `captureCVarTable()` in `@q2/voodoo`).
 */
export function captureChecklist(): string[] {
  return [
    'Render our side through the voodoo resolve chain at vd_* defaults (640x480, FOV 90).',
    'Capture the same cameras on a real Voodoo3 (3.20 ref_gl) or dgVoodoo2 wrapper.',
    'Save references as 8-bit RGB/RGBA non-interlaced PNGs into the slot dir.',
    'Run compareSideBySide per view; every view must PASS (<=0.5% px over 1 LSB).',
    'Record source, date, per-view stats, and verdict in BRAIN.md §15 before ticking M4.1.',
  ];
}
