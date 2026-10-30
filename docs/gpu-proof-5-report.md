# GPU-PROOF-5 — go/no-go report (2026-10-29)

> FOLLOW-1 reconciliation note (2026-10-29, reporting lane — supersedes the
> verdict below, preserves all measured numbers):
> implementation EXISTS (prototype renders the base1 scene); headless
> throughput is PROMISING (233.76/s unthrottled BeginFrames cadence, p50
> 3.92 ms / p95 6.01 ms on AMD Vega headless — main-thread work headroom,
> NOT displayed 60 FPS, NOT measured GPU execution); fidelity FAILED
> (0.912 vs the fixed 0.02 gate — thresholds unchanged, never reclassified
> as PASS); visible-display acceptance is PENDING (headless + vsync=false
> cannot claim scanout presentation; no user/hardware-oracle approval
> fabricated). The historical "GO (conditional)" + "gate PASS 3/3" lines
> below are retained as the 2026-10-29 record of headroom only — they do not
> constitute fidelity or displayed-frame acceptance. Manifest limitations:
> `browser-soak-8544883-2026-10-29T10-03-32` records fidelity null,
> warmup null, machine {}, pak missing, on a dirty 8544883 tree — preserved
> with those limits; future soaks carry the repaired provenance (FOLLOW-1
> bench lane). Timing terms: "refresh ~228 Hz" below is the unthrottled
> BeginFrames rate, not a display refresh; "submit ~2.8 ms" is caller-clock
> submission work, not async GPU duration (unknown in this harness).
> Separated predicates: `tools/bench/src/gpu-acceptance.ts`
> (`validateGpuFidelity` / `validateSceneCoverage` / `validateDisplayedClaim`
> / `formatGpuAcceptanceReport`).

> Verdict: **GO (conditional)** — SUPERSEDED by the FOLLOW-1 note above.
> Retained verbatim as the 2026-10-29 headroom record: the performance
> headroom claim below PASSES decisively on a hardware-backed headless
> browser; fidelity differences are documented (0.912 FAILED vs 0.02, never
> passed) and visible-display acceptance remains pending. GPU-EXPAND-1 is
> NOT eligible on this report alone.

## 1. Scope + identity

- Proof: one real base1 scene + deterministic movement/combat route (gun,
  lightmaps, dynamic lights, opaque + transparent overlap), 640x480 internal,
  normal fidelity, hardware-backed browser (PROOF-1 contract).
- Starting tree `8544883` (PROOF-4 done); this card's tree adds the soak
  harness (`apps/web` soak hook + `tools/bench/gpu-soak.*`), one measured
  optimization iteration (static scene cache), and two correctness fixes found
  by measurement (tick routing, work-split sharing — §5).
- Commits: see ledger rows 2026-10-29 GPU-PROOF-5; evidence manifests
  `tools/bench/evidence/browser-soak-8544883-*.manifest.json` (+ raw JSON,
  interval screenshots — screenshots of hardware GL legs read back BLACK in
  headless compositing; pixels are proven by in-page readbacks instead, §3).

## 2. Performance (gate: ≤16 ms median, ≥59 FPS, p95 ≤20 ms @640x480, hw-backed)

Same box (AMD Ryzen 5 PRO 2400G / Radeon Vega 11, Chromium 156 headless),
same scene/settings, sequential legs, warmup + 3x100 s intervals
(stationary / moving / combat), unthrottled rAF (measures work, not the
60 Hz cap — the capped mode cannot resolve medians below its 16.6 ms
quantum; vsync=false recorded honestly, no display vsync in headless).

| leg (renderer) | hw | dur | cadence | p50 | p95 | p99 | dropped | heapΔ | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| software (SwiftShader CPU) | no | 300 s | 33.91 fps | 16.50 ms | 17.75 ms | 30.59 ms | 160 | −6.5 MB | 0 |
| webgl2-experimental (AMD Vega, `ANGLE (AMD, AMD Radeon Vega 11 Graphics (radeonsi raven ACO), OpenGL ES 3.2)`) | **yes** | 300 s | **233.76 fps** | **3.92 ms** | **6.01 ms** | **13.84 ms** | 4 | −39.2 MB | 0 |

Per-interval GPU leg: stationary 237.57 fps (p50 3.84/p95 6.36),
moving 235.99 (3.90/5.50), combat 226.98 (4.02/6.07) — combat holds under
fire. Gate: **median 3.92 ≤ 16 PASS, cadence 233.76 ≥ 59 PASS,
p95 6.01 ≤ 20 PASS**, refresh ~228 Hz (unthrottled BeginFrames),
cpuFallback=false, 0 errors, memory bounded (GC settling, no growth).

Headroom vs the CPU baseline: **6.9x cadence, 4.2x median work**.
Work-split medians (in-frame `performance.now` ring, live GPU leg — caller
clock, main thread only): drains ~0.005 ms, sim ~0.02 ms, view+entities
~0.35 ms, tail ~0.02 ms, **submit ~2.8 ms**, total ~3.4 ms. The submit
(CPU-side submission work + present, NEVER measured GPU execution) dominates;
CPU-side prep is sub-millisecond. Async GPU duration is UNKNOWN in this
harness (no disjoint-timer query — never inferred from submit time).
No `gl.finish`/readPixels per-frame tricks, no disabled effects; HUD + sim
+ scene prep + presentation all included. (FOLLOW-1 2026-10-29: this paragraph
previously labelled submit as "GPU work + present" — corrected to
submission work; the numbers are retained.)

Limits, stated plainly: headless has no vsync — the ≥59 fps clause CANNOT be
established by work headroom (every frame fits in 4–6 ms ≪ 16.7 ms quantum,
so a 60 Hz display *could* sustain 60 fps, but no displayed-frame measurement
exists). (FOLLOW-1 2026-10-29: the original text below claimed the clause
"is established by work headroom" — that sentence is superseded; headroom
is promising, display acceptance is pending.) Software-baseline numbers are
SwiftShader-composited supplements, never mixed with hardware numbers. Timing
run used `GPU_SOAK_UNTHROTTLED=1`; capped-headless runs are cap-shaped
(p50 pins at 16.6 ms) and cannot resolve the median — documented in the
manifest notes. "Refresh ~228 Hz" is the unthrottled BeginFrames/rAF rate
(submission cadence), not a display refresh rate.

## 3. Fidelity (contract: exact asset/UV orientation, tolerances 0.02 @ 3 LSB)

- Fixed-scene F1 capture (pinned profile, voodoo-resolve CPU reference
  `a18f1963`/`51da7b04` reproduced exactly): GPU-vs-CPU **0.912 outside the
  0.02 gate — EXPECTED, fails loudly with artifacts, thresholds untouched.**
- Integrator side-by-side review of `-gpu.ppm` vs `-cpu.ppm` (this report):
  same soldier/gun/beam/room/silhouettes/order; the GPU frame is
  systematically brighter/warmer (linear pipeline + 1.3 gamma after
  reconstruction + per-pixel dlights + resampled skins). Gun present,
  textured, correctly placed and depth-hacked; geometry complete, no holes;
  beam/sprite transparency ordered; dark areas lifted, not crushed;
  minification smooth (dithered mip transition, no hard band). Every delta
  falls in the 8 documented approximation classes (true blending vs
  screen-door, per-pixel vs per-luxel lights, single-level mip, unwarped
  turbulence, no per-draw 565 rounding, pre-test depth, resampled skins,
  global lighting curve). **No unexplained differences found.**
- Coverage 99.8%, f1-vs-f1b byte-identical after warmup,uploads stable at 1,
  transparent overlap + depth-off/on checks pass at 12–33x margins.
- Formal human Voodoo3-oracle sign-off remains **pending** (no hardware
  oracle exists; M4.1) — tracked risk, not a blocker: nothing in the review
  suggests misrendering, and the pending item cannot be closed by agents.

## 4. Correctness found by measurement (fixed in-tree, all green)

1. **Tick routing shadowed the GPU backend**: with a worker pool available,
   the live loop took the pooled CPU path (`frameAsync`) and never called
   `frameGpuPlay` — the first full soak measured CPU-on-both-legs. Fixed:
   explicit GPU-first branch in the rAF tick (hot-swap-safe). The pre-fix
   numbers are voided and marked as such; the post-fix short + full runs
   above are the evidence. Lesson recorded: selection ≠ submission — the
   soak now captures `framesSubmitted`/`uploads` per interval.
2. **VS_POST half-triangle** (PROOF-4): fullscreen triangle covered x+y≤0
   only (resolveCoverage 0.5). Fixed to the covering triangle + pinned
   (unit bit-math pin + browser resolve-coverage ≥0.99 fixture, now 1.0).
3. Work-split ring sharing (globalThis store, config-store precedent):
   measurement-only, zero behavior change.

## 5. Optimization iterations (budget: at most two — ONE used, one banked)

- Iteration 1 (apps/web): per-frame full `selectGpuScene` → cached static
  world + `updateGpuEntities` tail. Effect (short unthrottled legs):
  tail collapse (p95 −24%, p99 −36%, dropped 190→9) — GC/alloc churn gone;
  median unchanged (17.13 → 16.77: the median was never scene-prep).
  Uploads stay 1, pixels identical, no CPU raster. Worth keeping regardless.
- Iteration 2: NOT NEEDED — the (invalid) first run's bottleneck was the
  routing bug, not frame cost. After the fix the gate passes with 3–4x
  headroom. Per the card's stop rules, no further iterations are started.

## 6. Remaining risks (visible, not buried)

- Formal human fidelity sign-off pending (M4.1 oracle missing) — §3 review
  above is the integrator's evidence, not the oracle's approval.
- Headless ≠ display vsync: cadence claim rests on work headroom (§2 limits).
- HUD overlay is CPU-composited per frame (fill + paint + putImageData);
  included in every number above, bounded, but GPU-resident HUD is EXPAND work.
- Sprite/particle live-pool mirroring, resize handling, context-loss
  re-upload, hot-swap asset migration: documented EXPAND gaps (backend
  supports them; the live loop doesn't drive them yet).
- No GPU substitution for the CPU reference: software path, goldens,
  Node tests and all regression gates untouched and green.

## 7. Recommendation

**SUPERSEDED by GPU-FOLLOW review (BRAIN.md §8, 2026-10-29) and the FOLLOW-1
note at the top of this report.** The original line below ("GO: promote the
GPU backend ... and open GPU-EXPAND-1") is retained as history but no longer
operative: EXPAND-1 stays paused until FOLLOW-1–7 pass, and no promotion or
default change happens on headless headroom alone. Do NOT resume the CPU
optimization campaign either — the finite FOLLOW queue governs next work.

Original (superseded, retained): **GO**: promote the GPU backend to
experimental-default candidate and open GPU-EXPAND-1 (coverage inventory →
full-scene parity → explicit fallback policy → default promotion). Do NOT
resume the CPU optimization campaign. Next measurements belong to EXPAND-1
(repeat this soak after coverage expansion, same gates, same box).
