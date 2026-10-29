---
"@q2/testkit": patch
---

Audit + report the corrected browser worker/main-thread attribution (PERF-NEXT-5, testkit lane).

- New shared taxonomy module `fg-attribution.ts` (single vocabulary for
  testkit readers, bench rows and browser stats): staged vs
  worker-completed vs main-completed vs inline vs replayed vs combined
  counts in explicit units (spans, draws, tris, particles, pixels, kicks,
  ms — never mixed), `null` = unknown/unpublished (never a fake zero,
  never staged-as-completed). `readForegroundAttribution()` projects the
  renderer's `testForegroundStats()` hook with corrected semantics (absent
  split fields imply the calling-thread band ran inline; kick-level worker
  tris derived as `trisCompleted - trisMainCompleted` only from
  completion-side counters); `reconcileForegroundAttribution()` enforces
  combined == worker + main and flags failure staged as execution;
  `formatForegroundAttribution()` renders the one-line ledger.
- `renderer-hooks.ts`: accept the renderer's new optional producer fields
  (`workerTrisCompleted`, `mainTrisCompleted`, `spriteSpansInline`,
  `aliasDrawsStaged`, `particleSpansInline`, `beamSpansInline`, per-class
  worker/main completion splits) — feature-detected, malformed rejects,
  absent reads null.
- New `fg-attribution.test.ts` (12 tests, real execution only): nonempty
  main band + worker bands with combined reconciliation; staged-but-failed
  (timeout) with zero world completions and replay counters; serial
  viewmodel as main/inline, never worker; pool-disposal fallback and
  disposed-pool decline with reconciling totals and identical output;
  per-class staged vs completed vs inline in explicit units; per-class
  completion splits pinned unknown; reader contract + reconcile rules on
  synthetic shapes.
