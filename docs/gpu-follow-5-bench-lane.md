# GPU-FOLLOW-5 bench/docs lane report (2026-10-30)

> Lane scope: `tools/bench` + `docs` ONLY. No `apps/*` or `packages/*` file
> was modified by this lane (the PROOF-4 fixture repair itself lives in
> `packages/testkit` and is handed to the testkit lane with an exact patch
> in §2). Bench is changeset-ignored per `.changeset/config.json`; docs need
> no changeset. DO NOT COMMIT (integrator merges).
>
> Starting tree: `ca1a843` (with other lanes' uncommitted `apps/web` work
> present; untouched by this lane). Box: Ryzen 5 PROD 2400G×8, Node 22.23.4,
> Q2_PAK 183997730 B, headless Chromium + SwiftShader (software GL —
> supplement-only, never a gate).

## 1. Reproduction (this session, controlled concurrency)

- `yarn workspace bench test`: **75 passed / 1 skipped** (34.9 s). Baseline green.
- `fg-recovery.test.ts` isolated: **6/6 green** (5.4 s). Under moderate load
  (full `@q2/sw-renderer` suite concurrently in the same box):
  **25/25 green** across `fg-recovery` + `fg-counters` + `fg-attribution`;
  the background sw suite finished **358/358** concurrently. The historical
  "foreground-recovery pool timeout under suite load" flake needs heavier
  contention than one extra package suite (full-verify parallel-turbo load:
  all packages plus multiple Chromium instances). **Not reproduced at this
  load level** — recorded as a load-threshold finding, not a fix claim.
  "Workers never became ready, replaying RGB inline" warnings appear in
  box (d) both isolated and loaded; the inline-replay fallback converges by
  design and the tests still assert serial equality.
- PROOF-3 boxes 4–5 browser leg (`gpu-browser.test.ts -t "production
  shaders"`) run **with the full sw-renderer suite contending**: **PASS in
  87 s**, no CDP timeout. The historical `Runtime.evaluate after 30000ms`
  failure (d934fdc review) needs heavier parallel load (multiple browser
  legs at once). The 30 s per-poll evaluate budget in `waitForProofDone`
  (`packages/testkit/src/gpu-browser.ts:606`) is **retained, not inflated**:
  each poll round-trips CDP against a software-GL page, and parallel legs
  multiply Chromium CPU demand on the same 8 threads. Mitigation is
  controlled concurrency (expensive browser legs strictly sequential),
  never a bigger timeout without contention evidence.
- PROOF-4 far/mip degenerate fixture: **reproduced live in the same run**
  (2026-10-30, `test-output/gpu-browser-2026-10-30T21-59-56-551Z.json`):
  shipped gates `appearance.farVsNear = 0/0` and `appearance.mipOnOff = 0/0`
  while the page's CORRECT far-camera captures in the same run read
  `follow2b.farView.nonblackFrac = 0.978` and `farViewVsNear = 0.9937`.
  Same page, same run: the shipped gates are blind, the correct captures
  are healthy. `mipFlags = [true, false]`, `policyUploads = on:92/off:8`
  (propagation alive — the failure is capture selection, not dither plumbing).
- F1-vs-CPU report-only gate: unchanged FAIL (0.912 vs fixed 0.02), never
  reclassified as PASS. Thresholds untouched.

## 2. Degenerate fixture: diagnosis + exact repair (testkit lane)

Root cause (`packages/testkit/src/gpu-browser-page.ts`, read-only here):

- `rrFar` selects its scene with FAR_VIEW (`selectGpuScene(world, entities,
  v=FAR_VIEW, …)`, line ~214), but the shipped gates are fed by
  `capFarOn`/`capFarOff`, rendered through the DEFAULT near camera
  (lines 720–722, no 6th `view` argument to `renderCapture`):
  `proof.appearance.farVsNear = summarize(diffStats(capFarOn.px, capF1P.px))`
  and `proof.appearance.mipOnOff = summarize(diffStats(capFarOn.px,
  capFarOff.px))` (lines 821–822).
- The minified captures that DO exercise LOD/mip (`capFarViewOn` /
  `capFarViewOff`, lines 730–735, rendered with `FAR_VIEW`) feed only the
  report-only `follow2b` block, never the shipped gates.

Bench-lane repair delivered (this lane's `owns:`):

- `tools/bench/src/gpu-fixture-audit.ts` — pure static auditor mapping each
  shipped gate to its capture pair and classifying per-gate exercising
  wiring (farVsNear needs two DIFFERENT cameras; mipOnOff needs the SAME
  non-default minifying camera, since the near-camera dither pair converges
  to 0 by construction). Exported from `tools/bench/src/index.ts`.
- `tools/bench/src/gpu-fixture-audit.test.ts` — 4/4 green: strict
  degenerate-vs-repaired classification on synthetic snippets, UNKNOWN (never
  guessed) on unparseable input, plus a report-only live audit of the real
  page source (currently logs `DEGENERATE-HISTORICAL`; flips to EXERCISING
  when the testkit lane repairs — no bench change needed that day).
- `tools/bench/src/node-builtins.d.ts` — added the `node:url`
  (`fileURLToPath`) ambient declaration the new test needs (bench tsconfig
  uses `"types": []`; consistent with the existing shims).

Proposed testkit-lane patch (NOT applied — outside this lane's `owns:`):

```diff
-  proof.appearance.farVsNear = summarize(diffStats(capFarOn.px, capF1P.px));
-  proof.appearance.mipOnOff = summarize(diffStats(capFarOn.px, capFarOff.px));
+  proof.appearance.farVsNear = summarize(diffStats(capFarViewOn.px, capF1P.px));
+  proof.appearance.mipOnOff = summarize(diffStats(capFarViewOn.px, capFarViewOff.px));
```

with `FAR_MIN_FRAC`/`MIP_ONOFF_MIN_PX` expectations re-baselined from the
repaired captures (the `follow2b` numbers above are the starting point, not
a frozen bar). Caveat for the testkit lane: `farViewMipOnOff` also read 0/0
in this run — at THIS far camera the dither toggle still does not bite
(over-minified taps clamp to uMaxLevel; see the FOLLOW-2B invariance note).
If the repaired `mipOnOff` still reads 0 at the repaired camera, that is a
fixture-regime miss, NOT a license to loosen the gate: pick a mid-distance
camera where LOD straddles the dither transition, or bring a threshold
change to the user with side-by-sides. Pre-repair 0/0 rows stay labelled
historical (this report + the ledger row), never re-characterised as passes.

## 3. PASS/GO reconciliation (carried, not rewritten)

- `docs/gpu-proof-5-report.md` "GO (conditional)" / "gate PASS 3/3" is
  SUPERSEDED by `docs/gpu-follow-1-reconciliation.md`: implementation exists,
  headless work headroom is promising (233.76 fps cadence = main-thread
  headroom, NOT displayed FPS), fidelity FAILED (0.912 vs 0.02), and
  visible-display acceptance is PENDING (headless legs are VOID for display).
  No lane in this session re-promotes headroom to a gate.
- Browser presented-FPS numbers in ledger rows (14–21 fps SwiftShader
  headless, 60 fps headless-Vega route legs) are supplement-only cadence,
  never scanout proof; rows that already say so are left intact, rows that
  do not are read under this correction.
- "Green in isolation" for fg-recovery / PROOF-3 CDP is a load-threshold
  statement (this report: green isolated AND under one-extra-suite load),
  not a full-verify PASS. Intermediate targeted passes are never full-suite
  acceptance.

## 4. Unresolved blockers carried forward (precise)

1. PROOF-4 far/mip shipped gates blind (0/0) — testkit-lane patch in §2
   pending; historical rows stay labelled historical.
2. F1-vs-CPU fidelity 0.912 vs fixed 0.02 — root-cause and regression
   fixtures belong to webgl/testkit lanes; no threshold change proposed here.
3. Suite-load flakes (fg-recovery pool timeout; PROOF-3 CDP 30 s evaluate)
   — mitigated by sequential browser legs (recipe in §6); the wedged-pool /
   multi-Chromium full-verify reproduction is still open.
4. No hardware-backed visible-display leg in this lane (headless-only box):
   GPU-PROOF-5 acceptance (≤16 ms, ≥59 FPS, p95 ≤20 ms, vsync/dropped
   recorded) remains PENDING. Nothing here counts toward it.
5. Water tile seams, elevator/infantry/asset-UI/restart/retirement user
   reports — untouched by this lane, still open per BRAIN §8.

## 5. Lifecycle + appearance evidence gaps (recorded, not closed)

- Existing lifecycle checks (nonblack frac, gun-region brightness, distinct
  color counts) PASS with missing textures — they prove the page is not
  blank, never semantic presence. FOLLOW-2A triage (diffuse/light/final
  nonblack 0.889/0.892/0.888, atlas 7663 rects, materials 31+2, uploadErrors
  []) is the current floor; negative-asset controls and matched
  deterministic before/after crops are still missing.
- Surviving unexplained diffs: the F1-vs-CPU 0.912 bundle (systematically
  brighter GPU frame; documented classes only, no per-class closure), and
  the water seam cause (wrap/clamp + atlas bleed fixed under FOLLOW-2B;
  residual seam mechanism still unproven — warp/LOD/precision triage with
  fixed-time, fixed-LOD captures still open). Sky is user-confirmed fixed
  (FOLLOW-3A) — preserved, not re-litigated.

## 6. Controlled-concurrency recipe (used this session)

1. Never run two Chromium browser legs at once on this box: one vitest
   browser file at a time (`vitest run <file> [-t <name>]`), no parallel
   turbo browser tasks.
2. Keep the 30 s CDP per-poll budget and the 480/600 s leg timeouts as-is;
   a timeout is evidence of contention (fix the schedule), not a slow
   threshold (do not inflate).
3. Node worker-thread suites may overlap ONE browser leg (proven above:
   sw 358/358 + PROOF-3 PASS concurrently), but full-verify parallelism
   (all packages at once) is the known flake regime — run it only to
   reproduce, never to accept.
4. Report-only gates (F1-vs-CPU, timings, far/mip until repaired) ride
   along but never gate: collect every violation in one run, fail loudly,
   fix the cause.

## 7. Files changed by this lane (for the integrator)

- `tools/bench/src/gpu-fixture-audit.ts` (new) + export in
  `tools/bench/src/index.ts`
- `tools/bench/src/gpu-fixture-audit.test.ts` (new, 4/4 green)
- `tools/bench/src/node-builtins.d.ts` (`node:url` ambient declaration)
- `docs/gpu-follow-5-bench-lane.md` (this report) + `docs/perf-ledger.md`
  session row
- Evidence: `/tmp/opencode/follow5-proof3-contention.log` (PROOF-3 PASS
  under sw-suite load, 87 s),
  `packages/testkit/test-output/gpu-browser-2026-10-30T21-59-56-551Z.json`
  (shipped 0/0 vs correct-capture 0.978/0.9937 — test-output is gitignored
  by convention; the committed ledger row carries the numbers).
