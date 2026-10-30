# GPU-FOLLOW-1 — acceptance reporting reconciliation (2026-10-29, reporting lane)

Scope: `docs/` + `tools/bench/` only. Integrator owns BRAIN.md/changesets/commits.
Historical evidence is preserved; superseded verdicts are annotated, never deleted.

## 1. Separated verdicts (reconciles PROOF-4/5 report, ledger, acceptance predicates)

- **Implementation: EXISTS.** The WebGL2 prototype renders the real base1
  scene (world, lightmaps, viewmodel, entities, transparency) behind the
  experimental flag. No rebuild claimed or needed here.
- **Headless throughput: PROMISING (headroom only).** 300 s AMD Vega headless
  unthrottled leg: cadence 233.76/s, interval p50 3.92 ms / p95 6.01 ms.
  This is main-thread submission-cadence work headroom — NOT proof of
  visible-display 60 FPS, NOT completed GPU work, NOT full-map correctness
  (spawn-subset coverage defect per FOLLOW-2 review). The 6.9x cadence ratio
  vs the SwiftShader CPU leg is non-comparative (different compositing) and
  is not a matched GPU speedup.
- **Fidelity: FAILED (fixed gate).** F1-vs-CPU 0.912 vs the predeclared 0.02
  gate (`GPU_PROOF_TOLERANCES`: 0.02 @3LSB, 1px edge, warn>24). Thresholds
  are FIXED (`tools/bench/src/gpu-acceptance.ts` pins them by value);
  the 0.912 is reported FAILED, never reclassified as PASS. Documented
  approximation classes and agent side-by-side review are not a numeric
  pass or user approval.
- **Visible-display acceptance: PENDING.** Headless (`headless=true`,
  `vsync=false`) legs cannot claim scanout presentation. No live display,
  refresh/vsync, or user/hardware-oracle approval was recorded. FOLLOW-6
  stays open until a hardware-backed visible-browser soak passes.

Superseded claims (annotated, retained in place): `docs/gpu-proof-5-report.md`
"GO (conditional)" verdict, "gate PASS 3/3", "≥59 fps clause is established
by work headroom", "submit (GPU work + present)", and "GPU-EXPAND-1 is
eligible" recommendation; ledger row 2026-10-29 GPU-PROOF-5 "gate PASS 3/3
(4.2x/6.9x headroom)". All are now marked headroom-only / superseded.

## 2. Timing vocabulary (use verbatim in reports)

- rAF/submission cadence: unthrottled BeginFrames rate — main-thread frame
  WORK headroom, not display refresh (headless "refresh ~228 Hz" is this).
- CPU frame work: caller-clock splits drains/sim/view/tail/submit/total.
- Async GPU duration: UNKNOWN in this harness (no disjoint-timer query).
  Never label submit time as GPU work.
- Displayed-frame evidence: visible (`headless=false`) vsync-locked leg with
  recorded refresh/vsync/dropped frames only. Never infer display refresh
  from unthrottled BeginFrames.

## 3. Manifest provenance (repaired going forward; history preserved with limits)

Existing `tools/bench/evidence/browser-soak-8544883-2026-10-29T10-03-32.manifest.json`
(GPU leg) limitations, preserved as-is:

- `fidelity: null` (page cvar snapshot existed in raw
  `gpu-soak-2026-10-29T09-52-27-webgl2-experimental.json` but was never
  carried into the record/manifest).
- `warmup: null` (runner used 20 s; not recorded).
- `machine: {}` (host descriptor not collected).
- `pak.missing: true` ("(browser-imported)" placeholder; Q2_PAK bytes/mtime
  known to the runner but not recorded).
- `treeDirty: true` on 8544883 with no dirty-file list (run-time vs
  import-time status ambiguous).
- `compositorDetail` = real GL string (good); `refreshHz`/vsync/dropped
  recorded only in notes, not as gate fields; work splits (`submit ~2.8 ms`)
  cited in the report without raw backing in that manifest cycle.

Repair (this lane, `tools/bench/`): `BrowserSoakRecord` now carries optional
`fidelity`, `warmupS`, `pak`, `machineDetail`, `sourceDirty`,
`sourceDirtyFiles`, `chromiumFlags`, `cvarSnapshot`, `refreshHz`, `vsync`,
`droppedFrames`, `cpuFallback`, `limitations`; `importBrowserSoak` preserves
record-carried provenance with explicit limitation entries instead of silent
nulls (`SoakImportOpts` overrides for backfill); `buildSoakRecord` assembles
them from the runner; `gpu-soak.mjs` now collects pak stat, page cvar
snapshot → fidelity, warmup, host machine (`collectMachine`), run-time dirty
files (`gitDirtyFiles`), chromium flags, `__q2soakWork` splits, and
refresh/vsync/dropped/cpuFallback into both raw and record JSON; notes use
the §2 vocabulary. New runs leave no silent gaps; old manifests keep their
limits (see `tools/bench/evidence/README.md`).

Source/build identity: commit short+full + tree-dirty flag + dirty-file list
+ `distFreshness` + chromium flags + page URL now persist per leg; the dirty
8544883 tree's exact file list is unrecoverable post hoc and is recorded as
"unknown beyond dirty=true" rather than fabricated.

## 4. Acceptance predicates (bench lane: implemented; testkit lane: proposed)

Implemented in `tools/bench/src/gpu-acceptance.ts` (+
`src/gpu-acceptance.test.ts`, 10 tests green; tolerances pinned by value):

- `validateGpuFidelity` — PASS only when measured `fractionDiff <= 0.02`;
  0.912 FAILs with "thresholds fixed, never reclassified as PASS".
- `validateSceneCoverage` — FAILs stalled `framesSubmitted`, `uploads < 1`,
  missing per-interval screenshots, or skipped stationary/moving/combat
  intervals (nonblack pixels or gun close-up alone never pass).
- `validateDisplayedClaim` — VOIDs headless/unverified-vsync/unmeasured
  refresh legs as displayed-FPS evidence (headroom stays report-only).
- `formatGpuAcceptanceReport` — four separated verdict lines; combined PASS
  only when fidelity + coverage + displayed all PASS.

Proposed testkit snippets for the integrator (later testkit lane — NOT
applied here): see the lane return message (file paths + exact code for a
fidelity-rejection pin, a coverage-rejection pin, and a headless-display
rejection pin against the canonical `GPU_PROOF_TOLERANCES`).

## 5. Evidence for this lane

- `yarn typecheck` (tools/bench): clean.
- `yarn test` (tools/bench): 6 files / 62 tests green (incl. new
  `gpu-acceptance.test.ts` 10/10).
- `yarn build` (tools/bench): ESM+CJS+DTS success; new exports present in
  `dist/index.mjs`.
- No packages touched; no commits made (integrator commits).
