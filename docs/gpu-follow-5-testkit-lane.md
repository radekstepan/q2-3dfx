# GPU-FOLLOW-5 testkit/webgl-renderer lane report (2026-10-31)

> Lane scope: `packages/testkit`, `packages/webgl-renderer`, `tools/bench`
> (auditor test only), `docs`. No `apps/*` or other `packages/*` file was
> modified. Bench remains changeset-ignored; docs need no changeset.
> DO NOT COMMIT (integrator merges).
>
> Starting tree: `3b1f7b3` (clean; RELEASE-8 done, verify 78/80 with 4 known
> FOLLOW-5 failures). Box: Ryzen 5 PROD 2400G×8, Node 22.23.4,
> Q2_PAK 183997730 B, headless Chromium 156.0.8078.47 + SwiftShader
> (software GL — supplement-only, never a gate).

## 1. PROOF-4 far/mip fixture repair (bench-lane §2 exact patch + mid regime)

Applied the exact patch (`packages/testkit/src/gpu-browser-page.ts`):

```diff
-  proof.appearance.farVsNear = summarize(diffStats(capFarOn.px, capF1P.px));
-  proof.appearance.mipOnOff = summarize(diffStats(capFarOn.px, capFarOff.px));
+  proof.appearance.farVsNear = summarize(diffStats(capFarViewOn.px, capF1P.px));
+  proof.appearance.mipOnOff = summarize(diffStats(capMidViewOn.px, capMidViewOff.px));
```

`farVsNear` is the verbatim bench-lane patch (FAR_VIEW capture vs pinned
F1). For `mipOnOff` the far pair cannot be used: `farViewMipOnOff` reads
0/0 in every run to date (over-minified taps clamp to `uMaxLevel`, and
base1's flat walls converge per-tile once atlas bleed is removed — the
FOLLOW-2B invariance note). A new `MID_VIEW` camera (same yaw, on the
spawn→FAR ray at 70/150 distance and 19/40 elevation: origin
`[128,-390,73]`) keeps the camera inside valid map space while roughly
doubling wall/floor distances, so the LOD straddles the Bayer n/n+1
transition instead of clamping to 0 (near, magnified) or converging
(far). The mid on/off pair shares one non-default camera on both sides,
so the bench auditor rule classifies it EXERCISING (camera-name generic;
new synthetic MID case pinned in `gpu-fixture-audit.test.ts`, 5/5 green,
live source audit flips DEGENERATE-HISTORICAL → EXERCISING).

Thresholds (`FAR_MIN_FRAC`, `MIP_ONOFF_MIN_PX`, `MIP_SCATTER_MIN_FRAC`)
are UNCHANGED — no loosening, silent or otherwise.

Measured (PROOF-4 browser leg, same run, `gpu-proof4-2026-10-31T00-28-17-758Z-gate.json`):

- `farVsNear = 0.9937` (305259/307200 px) — gate HOLDS (was 0/0).
- `midView.nonblackFrac = 0.961`, `midViewVsNear = 0.9873` — the mid
  camera is valid: real minified content, genuinely different view.
- `midViewMipOnOff = 0/0`, `mipFlagsMid = [true, false]`,
  `policyUploads = on:92/off:8`, `f1MipOnOff = 0`, `farViewMipOnOff = 0`.
  Propagation is proven alive (cvar reaches frame state AND GL uploads);
  the texture-stage dither toggle bites at NONE of the three cameras
  (near/mid/far). This is a fixture-regime miss, NOT a pass: the gate
  fails loudly (2 soft asserts), thresholds untouched. §6 carries the
  proposal to the user.

World diffuse and skin uploads carry full mip chains (`mips:true`;
`texLevels = chain.length - 1`, sky faces single-level by design), and
the appearance-stage dither is independently alive
(`flatOnVsOff = 0.43`, `flatDistinctOn = 3` vs `flatDistinctOff = 1`).
The 0/0 is content-regime, not dead plumbing — no silent mip-death bug.

## 2. Matched F0/F1/F2 CPU/GPU evidence (repaired renderer)

New F2 moving-combat view (proof-route yaw +6°) with own
`selectGpuScene` selection and entities/lights/particles re-placed for
yaw +6 by the same derivation as the yaw-90 fixtures; Node CPU renders
`renderCpuProofFrame(bw, 0/1/2)` under the same rule (F0 stationary
without particles/pump, matching the page `worldF0`; F1/F2 combat with
pump at the frame yaw). Same-run numbers:

- CPU color hashes: F0 `930337c1`, F1 `730221a2`, F2 `84e627e3`
  (deterministic across consecutive runs).
- GPU coverage: F0 0.9976, F1 0.9972, F2 0.9964 (all ~full-frame).
- GPU F2-vs-F1 frac = 0.6286 — the +6° camera moves the frame (matched
  F2 is a real second viewpoint, not a stale scene).
- F-vs-CPU report-only (same oracle + tolerances as the F1 gate, never
  gates, never re-baselined): F0 99.513% maxΔ251, F1 99.659% maxΔ251,
  F2 99.614% maxΔ255. The systematic-brightness bundle dominates all
  three frames identically (see §5); the oracle change (RELEASE-8
  raw-color, no gamma/overbright) explains the step from the historical
  0.912 (voodoo-resolved oracle) — the two numbers are NOT comparable
  across the oracle change and are labelled accordingly.

Determinism (matched before/after): `f1vsF1b = 0` (byte-identical
re-render), `reselectVsFresh = 0` (TURN reselect exact, uploads 1→1),
dual-chunking CDP fetch of the same capture byte-identical (harness
slice path pinned end to end).

## 3. Lifecycle image evidence: negative control + localization

New `rrNoGunSkin` renderer: identical F1 scene/camera with the REQUIRED
gun skin withheld. Production behavior (pinned hermetically in
`webgl-renderer/follow2a.test.ts`: withheld skin draws the white
fallback with the SAME draw count, never skipped — new test green in
37 ms):

- warning `alias entity skin 1 missing (white fallback)` present;
- `noGunSkinVsF1 = 23607 px`, bbox `[373,0,607,208]` =
  EXACTLY the gun bbox (overlap 1.0, asserted ≥ 0.5, count asserted
  ≥ 5000 with 23607 measured).

The lifecycle image checks respond to a removed required asset
(presence proof, not nonblack/counting). Existing presence pins hold in
the same run: gun 23752 px bboxFrac 0.48, beam 489 px bboxFrac 0.45,
soldier 21635 px, sprite 87580 px, depthOff 28728 px (9.35%),
centroids for all four classes, uploads 1, framesSubmitted ≥ 120.

## 4. F1-vs-CPU gap analysis (no defect found; no goldens touched)

- Edge-disagreement (tone-invariant Sobel, threshold 12): 24.4%
  full-frame, uniform across soldier crop (30.8%), gun area (25.0%),
  mid-walls (26.4%) — NOT concentrated on any entity. No localized
  geometry/pose defect; the earlier soldier-pose scare was a mis-crop
  (soldier bbox is x 212–372, centroid x 299 — placement math matches
  BY VALUE on both sides).
- The gap is the SPECIFIED appearance transform, applied to every
  pixel: linear `texel × (lightmap + dyn)` → overbright ×2 + clamp →
  RGB565 → matched reconstruction → gamma `pow(c, 1/1.3)` lift, vs the
  CPU colormap-grade path (`LIGHT_OVERBRIGHT = 1`, no gamma). CPU luma
  24 → ×2 = 48 → gamma ≈ 71 matches the measured GPU dark-bin mean
  71.7. Flat measured response (GPU ~40–70 for CPU 0–100) is the
  overbright-clamp + gamma-lift signature, not a lighting-scale bug.
- Unlit-luxel neutral fill (128) exists on BOTH paths (CPU
  `bspWorld` sentinel `[128,128,128]`; GPU `UNLIT_LUXEL = 128`) —
  parity by design, not a gap source.
- Remaining authorized classes (unchanged, still pending human review):
  linear-vs-exact raster edges (1px exclusion), true blending vs
  screen-door, per-pixel vs per-luxel dlights, single-level mip pick
  vs baked CPU blocks + unmipped lightmaps, unwarped water (deferred),
  no per-draw 565 rounding, GL-vs-CPU depth ties, box-resampled skins.
- Side-by-sides: `gpu-proof4-*-gpu.ppm / -cpu.ppm / -diff.ppm /
  -browser.png` per run (committed paths are gitignored test-output;
  gate.json carries hashes, regions, bands, verdict).

## 5. Fidelity contract status: NOT MET — precise proposal for the user

The 0.02 gate cannot be met while comparing Voodoo-look GPU output
(overbright ×2 + gamma 1/1.3 are the specified appearance) against the
raw-color CPU plane: the tone map alone moves ~99% of pixels by more
than 3 LSB. Recorded verdicts: automated FAIL (loud, thresholds
intact); human sign-off STILL NEEDED (pending, recorded in every
gate.json). PROPOSED contract change (needs user approval — NOT applied):

1. Keep the 0.02 / 3 LSB / 1px-edge / maxΔ24 gate, but apply it to a
   TONE-NORMALIZED comparison: map the CPU reference through the
   specified appearance curve (overbright ×2 + gamma 1/1.3) before
   diffing, so the gate measures structure (geometry/UV/pose/seams),
   not the specified tone lift.
2. Add a separate TONE-CURVE pin: GPU output must follow the specified
   chain within a tight band on flat/ramp fixtures (already passing:
   flat/membership/period 0 violations, ramp R/G/B 30+/60+/30+,
   gamma frac 0.97) — the appearance is verified, not punished.
3. Keep the scene mip-dither gate wiring repaired but DOWNGRADE its
   threshold to report-only until a biting regime is demonstrated, OR
   replace it with a synthetic minification pair through the production
   sampling path (decision: user).

No goldens replaced, no thresholds changed, no silent anything.

## 6. Unresolved blockers carried forward (precise)

1. Scene mip-dither gate 0/0 at three cameras (repaired wiring, regime
   miss). Proposal in §5; user decision needed.
2. F1-vs-CPU 0.99 vs 0.02 (specified tone transform; proposal in §5).
3. Suite-load flakes (fg-recovery pool timeout, PROOF-3 CDP 30 s,
   follow-2a pose 90 s): reproduced-or-recorded under §7 recipe;
   full-verify parallel-turbo contention remains the known flake
   regime — sequential browser legs only for acceptance.
4. Visible-display acceptance still PENDING (headless-only box).
5. Water seams, elevator, infantry, asset-UI, restart, retirement:
   untouched by this lane, still open per BRAIN §8.

## 7. Reproduction / regression runs (this lane, controlled concurrency)

- PROOF-4 browser leg (repaired page): 3 full runs, identical numbers
  (deterministic incl. under webgl-renderer-suite contention) — green
  except the 2 honest mip soft-fails. farVsNear 0.9937 all runs (was
  0/0); CPU hashes identical F0 `930337c1` / F1 `730221a2` /
  F2 `84e627e3` all runs. 40 s/leg isolated.
- PROOF-3 boxes 4–5 leg (same repaired page): GREEN isolated 33.9 s and
  GREEN full-file under contention 56.9 s
  (`gpu-browser-2026-10-31T00-29-12-665Z.json`): coverage F0/F1
  0.9976/0.9972, f0vsF1 0.6656, f1vsF1b 0, reselectVsFresh 0,
  uploads 1→1, all presence/occlusion/transparency pins hold. Timings
  report-only SwiftShader: median 133.3 ms isolated vs 233.2 ms loaded,
  max 13–23 s first-frame stalls — cadence is load-sensitive, never
  a gate. Additive page fields break nothing.
- gpu-water-pixels (real WebGL2, negative controls): GREEN 4.6 s —
  turbSelected 30/102, nonblack 0.998, anim 0.0804 (moves across time),
  wrap 0.0207, dryVsWet 0.0860 (bluwter-withheld control differs),
  overlap 0.4320.
- gpu-sky-pixels (real WebGL2): GREEN 5.2 s — face edges isolate,
  zero-ref windows keep the textured background.
- fg-recovery isolation: 6/6 green (4.7 s). Contention probe:
  fg-recovery + fg-counters + fg-attribution 25/25 green WHILE the full
  sw-renderer suite (19 files / 201 tests, green) ran concurrently on the
  same box. The historical pool-timeout flake needs heavier contention
  than one extra package suite (full-verify parallel-turbo + multiple
  Chromium instances per the bench lane) — load-threshold finding,
  not a fix claim. Timeouts retained, none inflated.
- bench full suite: 9 files, 80 passed / 1 skipped (incl. 5/5
  fixture-audit with the new MID synthetic case; live audit
  EXERCISING post-repair).
- follow-2a composed page (matched before/after crops): GREEN isolated,
  17.2 s — cold-gpu-boot nonBlack 0.9985 gunRegion 0.9988 triples 15930
  framesSubmitted 30 uploads 1; cpu-boot same pose
  (128.0 -320.0 24.0 yaw 135) nonBlack 0.9168 gunRegion 0.9977. The
  recorded pose-90s failure does NOT reproduce on a quiet box
  (load-threshold finding, consistent with the other three; apps/web
  page untouched, timeouts retained).
- Bench auditor: 5/5 green (live audit EXERCISING post-repair).
- webgl-renderer follow2a: 14 passed / 1 skipped incl. the new
  white-fallback pin (Q2_PAK legs green).

## 8. Files changed (for the integrator)

- `packages/testkit/src/gpu-browser-page.ts` — MID_VIEW + mid pair,
  F2 view/entities/lights/particles + capture, gun-skin-withheld
  renderer + capture, F0/F2 exposure, repaired gate wiring.
- `packages/testkit/src/gpu-browser.test.ts` — interfaces, mid logging,
  negControl hard asserts (wide bands), F0/F2 CPU + report-only,
  dual-chunk determinism pin, follow2b in gate.json.
- `packages/testkit/src/gpu-proof-cpu.ts` — `renderCpuProofFrame`
  (F0/F1/F2), `renderCpuProofF1` kept as wrapper.
- `packages/webgl-renderer/src/follow2a.test.ts` — withheld-skin
  white-fallback differential pin (hermetic, 37 ms).
- `tools/bench/src/gpu-fixture-audit.test.ts` — MID synthetic case.
- `docs/gpu-follow-5-testkit-lane.md` (this report) + `docs/perf-ledger.md`
  row (integrator appends with final numbers).

Suggested changesets: `@q2/testkit` patch (fixture repair + report-only
F0/F2/negControl evidence; additive exports only); `@q2/webgl-renderer`
patch (hermetic regression pin, no production change). Bench/docs need
none (bench ignored, docs unversioned).
