# GPU-FOLLOW-5 refresh — bench + docs lane (2026-10-31)

> Lane scope: `tools/bench` + `docs` ONLY. No `apps/*` or `packages/*` file
> was modified by this lane. Bench is changeset-ignored per
> `.changeset/config.json`; docs need no changeset. DO NOT COMMIT
> (integrator merges).
>
> Starting tree: `185a02d` (dirty: `BRAIN.md` status line only +
> `packages/webgl-renderer/src/release10-cvars.test.ts` in-progress doc
> reconciliation + untracked `packages/testkit/src/test-output/` captures;
> sibling webgl/testkit lanes' in-flight work untouched). Box: Ryzen 5 PRO
> 2400G×8, Node v22.23.4, Q2_PAK 183997730 B
> (`sha1ce99eb11e7e251ccdf690858effba79836dbe5e32a4083ad00a13ecda491679`),
> headless Chromium + SwiftShader where noted (software GL —
> supplement-only, never a gate).
>
> Contract status: `docs/gpu-proof-1-contract.md` UNTOUCHED. Historical
> ledger rows stay labelled historical. The tone-normalized 0.02 proposal
> in §5 is PRESENTED, not applied — UNAPPROVED pending explicit user
> approval. No threshold change, no rollout. Failures are explicit;
> nothing here claims completion.

## 1. What changed since the archived evidence (visual repairs + pixel effects)

The archived baseline is `docs/performance-gpu-history-2026-10-29.md`
(review at `866a553`); fidelity numbers predating RELEASE-8 are additionally
superseded by the raw-color oracle rebase (see §4). Since then the
following user-visible repairs landed (commits on the current tree):

1. **Unlit water (FOLLOW-3B repair, `3bbead1`).** Cause pinned with numbers:
   the per-face lightmap multiply on turbulent water drew the baked blocks'
   face-boundary steps — 130/134 coplanar shared water edges carried steps
   >8/255 (mean 134, max **247/255**) — as tile seams. Both id refs draw
   warp faces UNLIT (`ref_soft` raw texels, `ref_gl` "no lightmaps"), so
   `FS_LIT` gained a warp-gated `col = texel` branch; glass/opaque lighting,
   motion, mips, transparency, unwarped-LOD + highp preserved. Pixel effect:
   tile seams gone; post-fix web captures (2 views × 3 phases) show no
   repeat seams with flow alive (roiDiff 0.21–0.31), sparse moving edges
   (hFrac/vFrac < 0.05, no full-width/height seam). Repeat/adjacent-face/art
   exonerated (UV bit-identical at 149 shared verts, wrap bit-exact).
2. **Live-counter F1 + intermission-lite finish (RELEASE-6 repair,
   `ff85aa6`).** `drawHelpOverlay` reads LIVE
   killedMonsters/foundGoals/foundSecrets (frozen `finish*` only at
   completion); `i_help` flashes iff unacked change and `(serverframe&8)`,
   acked on F1-open per `Cmd_Help_f`. Completion is SP-faithful
   intermission-lite: gun down, no world interaction, frozen totals, no DM
   scoreboard, no victory asset. Pixel effect: F1 counters advance during
   play and freeze only at completion; no stale-zero/placeholder totals.
3. **Resize present (RELEASE-7 repair, `006d5ff`).** `finishFrame` re-syncs
   blit-wrapper dims from live `host.fb` every frame, drops stale in-flight
   presents, re-fits CSS + re-pairs the pool on observed dims change;
   `resizePlay` rolls back on GPU-backend failure. Pixel effect: resolution
   switches render undistorted with gameplay/sim preserved (pixel-identical
   restore), instead of stretched/mismatched output.
4. **Explosion framelerp/alpha/skin + blaster window (RELEASE-9,
   `c7dd19e`).** Barrel `framelerp`/`alpha`/`skin`/sound fixed; blaster
   0.3s light window fixed without enlargement (GPU extents match CPU
   <1.2px); `ex_misc` continuous alpha; C-exact TE tables. Pixel effect:
   explosions interpolate frames with correct fade/skin instead of popping;
   blaster impact light lasts its full 0.3 s life at the right size.
5. **Splash producers (R9F-1..8 `744c9e1`, R9F-10 `185a02d`).**
   `fire_lead` blood + water-splash classes (blue/slime/lava unchanged),
   brown-water splash path (`isBrownWaterTexture` → brown splash class),
   loop-channel speaker records with mixer `updateSoundOrigin` retargeting.
   Pixel effect: blood/splash particles appear for the correct surface class
   (including brown water); looping sounds no longer restart per frame.
6. **HUD/help/panel gating (RELEASE-6/10/11, `c8bbe52`, `e58ff3d`).**
   Real-art dims pins, `cl_showmessages` toggle, renderer-unsupported
   controls disabled with reasons. No fidelity-oracle impact; carried here
   so the UI legs of box 2 evidence are current.

## 2. Refreshed matched scene/time/cvar evidence (headless; cited, not duplicated)

This lane ran NO browser legs and NO webgl/testkit suites (their lanes own
them; browser legs run strictly sequentially on this box). The current
matched numbers below are read from the sibling lanes' suites on the
current tree family (testkit lane at `e214dd4`; `packages/testkit` and
`packages/webgl-renderer` unchanged between `e214dd4` and `185a02d` except
the dirty release10-cvars doc-reconciliation test, §3.5):

- **PROOF-4 browser leg** (`packages/testkit/src/gpu-browser.test.ts`,
  repaired page): `farVsNear = 0.9937` (305259/307200 px — gate HOLDS, was
  0/0); `midView.nonblackFrac = 0.961`, `midVsNear = 0.9873` (valid
  minified view); `midMipOnOff = 0/0` with `mipFlagsMid = [true,false]` +
  `policyUploads on=92/off=8` (propagation alive, fixture-regime miss —
  gate fails loudly, thresholds UNTOUCHED). 3 full runs, identical numbers.
- **Matched F0/F1/F2 CPU/GPU** (same run): CPU color hashes F0 `930337c1`
  / F1 `730221a2` / F2 `84e627e3` (deterministic across consecutive runs);
  GPU coverage F0/F1/F2 0.9976/0.9972/0.9964; F2-vs-F1 0.6286 (matched F2
  is a real second viewpoint, +6° yaw); F-vs-CPU report-only F0 99.513% /
  F1 99.659% / F2 99.614%, maxΔ 251–255.

> Concurrent-lane note (observed at write time, not owned here): the
> sibling testkit lane has UNCOMMITTED in-flight edits under
> `packages/testkit/src/` (`gpu-browser.ts` CDP pool-state triage,
> `gpu-follow-2a.test.ts`, `gpu-presentation.ts`) plus a new untracked
> `packages/webgl-renderer/src/mip-regime.test.ts` — box-1
> contention/mip diagnosis. Untouched by this lane; the numbers above are
> the testkit lane's reported measurements, and the integrator reconciles
> any re-measurement on merge.
- **Lifecycle negative control** (same run + hermetic
  `webgl-renderer/src/follow2a.test.ts` pin): gun-skin-withheld renderer
  draws the white fallback at the SAME draw count (never skipped);
  `noGunSkinVsF1 = 23607 px`, bbox == gun bbox (overlap 1.0, asserted ≥
  0.5, count asserted ≥ 5000). Presence pins hold in the same run (gun
  23752 px, beam 489 px, soldier 21535 px, sprite 87580 px, uploads 1).
- **Water/sky pixels** (`gpu-water-pixels`, `gpu-sky-pixels`, real WebGL2):
  GREEN — turbSelected 30/102, nonblack 0.998, anim 0.0804 (moves across
  time), wrap 0.0207, dryVsWet 0.0860 (bluwter-withheld control differs),
  overlap 0.4320; sky face edges isolate, zero-ref windows keep the
  textured background.
- **Seam matrix** (`packages/testkit/src/release-3b-seam.test.ts` 15/1skip
  with Q2_PAK + 3 caught injected controls; `webgl-renderer/src/water-seam.test.ts`
  178/6skip incl. pre-fix stash FAIL of the 2 warp-gate pins; `apps/web`
  `gpu-water-seam.test.ts` 2 views × 3 phases, thresholds in §1.1).
- **Determinism**: `f1vsF1b = 0`, `reselectVsFresh = 0`, dual-chunk CDP
  fetch byte-identical.

## 3. CURRENT automated-failure list (explicit; no completion claimed)

Full-verify status on the current tree was NOT re-run by this lane
(expensive + contention-prone; sibling lanes own their suites). The
current list, carried from the latest integrated runs on this tree family
(RELEASE-7 repair + RELEASE-8 + testkit lane, trees `7c49c1d`–`e214dd4`):

1. **fg-recovery pool timeout (5 s).** `sw-renderer` foreground-recovery
   suite flakes ONLY under full-verify parallel-turbo contention (all
   packages + multiple Chromium instances); green isolated 6/6 and green
   under one-extra-suite load 25/25. Load-threshold finding, not a fix;
   timeouts retained, never inflated.
2. **PROOF-3 CDP timeout (30 s `Runtime.evaluate`).** Same contention
   class; `waitForProofDone` per-poll budget retained. Mitigation is
   schedule (sequential browser legs), never a bigger threshold.
3. **PROOF-4 scene mip-dither gate 0/0 (fixture-regime miss).** Repaired
   wiring (bench-lane auditor now classifies the page EXERCISING) moved the
   failure: `farVsNear` HOLDS at 0.9937; `mipOnOff` reads 0/0 at near, mid
   AND far cameras (over-minified taps clamp to `uMaxLevel`; flat walls
   converge per-tile post-bleed-fix). Fails loudly via 2 soft asserts;
   thresholds untouched. Proposal in §5, user decision needed.
4. **follow-2a composed-page pose (90 s).** Does NOT reproduce on a quiet
   box (GREEN isolated 17.2 s); contention-class like (1)–(2).
5. **In-progress reconciliation (dirty tree, NOT a failure).** The working
   tree carries an uncommitted `release10-cvars.test.ts` edit flipping the
   `vd_dithermode` pin from stale-doc ("read-path only") to reconciled-doc
   ("honored live on WebGL (uDitherMode)"); the committed
   `packages/config/src/index.ts` registry already documents the live
   uniform, so test and registry agree. Integrator-owned; untouched here.

Environment notes: headless-only box (no connected display, no
vsync/scanout) — visible-display acceptance stays PENDING per FOLLOW-6;
all SwiftShader browser timings are supplement-only cadence, never gate
evidence. Historical FAIL rows (e.g. pre-repair far/mip 0/0, historical
0.912 voodoo-oracle numbers) stay labelled historical.

## 4. Precise CPU-vs-GPU side-by-sides for the remaining fidelity gap

Oracle note (RELEASE-8): the live GPU appearance evidence is re-captured
against the RAW-COLOR CPU plane; the historical 0.912 (voodoo-resolved
oracle) is NOT comparable to the current ~0.99 report-only numbers across
the oracle change. Both are labelled with their oracle wherever cited.

- **Global tone transform (dominates all three frames identically).** GPU:
  linear `texel × (lightmap + dyn)` → overbright ×2 + clamp → RGB565 →
  matched `2x2sub+2x2box` reconstruction → gamma `pow(c, 1/1.3)` lift.
  CPU: colormap-grade path (`LIGHT_OVERBRIGHT = 1`), no gamma. Measured:
  CPU luma 24 → ×2 = 48 → gamma ≈ 71 matches the GPU dark-bin mean 71.7;
  flat response GPU ~40–70 for CPU 0–100 (overbright-clamp + gamma-lift
  signature, not a lighting-scale bug). Tone-invariant Sobel edge
  disagreement is 24.4% full-frame and UNIFORM (soldier crop 30.8%, gun
  area 25.0%, mid-walls 26.4%) — no localized geometry/pose defect.
- **Water pixels: GPU-unlit-per-id vs CPU-lit-per-TS-port.** GPU classifies
  per warp-flagged surface id (`uWarpOn` branch in `FS_LIT`,
  `packages/webgl-renderer/src/shaders.ts`): `col = texel` — no lightmap
  tap, no `dyn` loop. CPU TS port routes turbulent spans through its lit
  span machinery (`runSubdivTurbulent shades via
  `colormap[(light<<8)+texel]` with the span light/dlight terms; the
  single-poly emit site posts grade 63 with dlight 0,
  `packages/sw-renderer/src/frame.ts`). Direction of divergence: GPU water
  is systematically BRIGHTER than CPU water (raw texel through
  overbright×2 + gamma lift vs flat grade-63 identity colormap shade with
  no tone lift), ON TOP of the global tone gap; and under combat lighting
  the CPU span path retains a dlight term the GPU warp branch skips
  entirely, so muzzle/explosion flashes can modulate CPU water while GPU
  water stays fixed. This is a specified-appearance difference (both id
  refs draw warp faces unlit), not unexplained geometry — but the per-pixel
  delta concentrates in water regions and is NOT absorbed by the 1px-edge
  exclusion.
- **Remaining authorized classes (unchanged, still pending human review):**
  true blending vs screen-door; per-pixel vs per-luxel dlights; single-level
  mip pick vs baked CPU blocks + unmipped lightmaps; no per-draw 565
  rounding; GL-vs-CPU depth ties; box-resampled skins. Side-by-side
  artifacts per run: `gpu-proof4-*-gpu.ppm / -cpu.ppm / -diff.ppm /
  -browser.png` (gitignored test-output; `gate.json` carries hashes,
  regions, bands, verdict).

## 5. Tone-normalized 0.02 proposal — UNAPPROVED (presented, NOT applied)

Restated verbatim in substance from the testkit lane (§5, still pending;
NO threshold changed, NO rollout, contract doc untouched):

1. Keep the 0.02 / 3 LSB / 1px-edge / maxΔ24 gate, but apply it to a
   TONE-NORMALIZED comparison: map the CPU reference through the specified
   appearance curve (overbright ×2 + gamma 1/1.3) before diffing, so the
   gate measures structure (geometry/UV/pose/seams), not the specified
   tone lift.
2. Add a separate TONE-CURVE pin: GPU output must follow the specified
   chain within a tight band on flat/ramp fixtures (already passing:
   flat/membership/period 0 violations, ramp R/G/B 30+/60+/30+, gamma
   frac 0.97) — the appearance is verified, not punished.
3. Keep the scene mip-dither gate wiring repaired but DOWNGRADE its
   threshold to report-only until a biting regime is demonstrated, OR
   replace it with a synthetic minification pair through the production
   sampling path (decision: user).

Requires EXPLICIT user approval. Until then: automated verdict stays
FAIL (loud), human sign-off stays PENDING (recorded per gate.json), and
final acceptance/default promotion stay blocked.

## 6. Evidence for this lane

- Bench output tail (current tree `185a02d`, `yarn bench:accept`,
  warmup 5 / reps 10 / workers 0,1,3,7):

```text
spawn-north 640x480 ent=fixed software w=0: renderView=33.93(p95 41.84) GEO(sum-of-medians,diagnostic)=12.93 DRAW=14.09(p95 17.16) alias=3.13(fg-serial) endFrame=1.37(p95 2.14) frame(production,Node,no-present)=29.97(p95 34.24 max 34.24) spans=59506 px=729735 ov=2.38 idx=52b2c6ad color=3f274c4c full=7172afa0 cache[hits=48528 miss=2022 evict=0] trans=8 bands=1:[0-480] detail=disabled
spawn-north 640x480 ent=fixed software w=7: frame(production,Node,no-present)=19.03(p95 21.00 max 21.00) idx=52b2c6ad color=3f274c4c full=7172afa0
odd-dims 639x479 software fixed w=0 vs w=3: IDENTICAL full=c75ae949 (frame serial 33.58ms pooled-prod 33.06ms)
parity: serial/pooled full-RGBA identical on all swept configs + software odd-dims
gate A software fixed serial frame: 29.97ms vs 16ms budget → FAIL (+13.97ms over)
FAIL(budget): gate A missed the ≤16ms/frame @640x480 budget.
```

  Full rows + provenance: committed manifest
  `tools/bench/evidence/node-accept-185a02d-2026-10-31T05-53-04.manifest.json`
  (raw per-rep JSON gitignored under `evidence/raw/`). Exit code 2 BY
  DESIGN (parity pass, budget miss); CPU optimization stays paused — no
  tuning was attempted or claimed.

- Ledger: `docs/perf-ledger.md` row 2026-10-31 (this lane).
- This report: `docs/gpu-follow-5-refresh-2026-10-31.md` (this file).
- Contract doc: untouched (`git status` shows no modification under
  `docs/gpu-proof-1-contract.md`).

## 7. Files changed by this lane (for the integrator)

- `docs/perf-ledger.md` — appended 2026-10-31 node-accept row (current-tree
  numbers, fixed cam/time, Q2_PAK hash, Node/machine).
- `docs/gpu-follow-5-refresh-2026-10-31.md` — this report (new file).
- `tools/bench/evidence/node-accept-185a02d-2026-10-31T05-53-04.manifest.json`
  + `evidence/raw/node-accept-185a02d-2026-10-31T05-53-04.json` — run
  artifacts (manifest committed by integrator convention; raw gitignored).

Suggested changeset note: NONE required — `tools/bench` is
changeset-ignored per `.changeset/config.json` and `docs` are unversioned
(same convention as the FOLLOW-1 and FOLLOW-5 bench/testkit lanes: bench
ignored, docs need none). No `packages/**` file was touched, so no
package changeset exists to write. DO NOT COMMIT (integrator merges; the
dirty `BRAIN.md` status line and release10-cvars reconciliation belong to
other lanes).

## 8. Box-3 implementation result (integrator, 2026-10-31 — user approved the tone-normalized 0.02 proposal)

Implemented exactly as proposed in §5 (testkit lane, no threshold changes):
tone-normalized PROOF-4 comparison (`toneNormalizeCpuReference`: CPU through
overbright ×2 + clamp, gamma 1/1.3; formula mirrors `voodooOverbright` and
`pow(c, 1/uGamma)`), explicit TONE-CURVE gate with mistuned-curve negative
control, scene mip-dither asserts to report-only (values kept, measured,
logged). Re-ran PROOF-4 (headless Chromium/SwiftShader, base1 spawn-north,
pinned cvars, Q2_PAK):
- TONE-CURVE GATE: PASS (flat 0/0, distinct 3/1, onVsOff 0.4297; ramp
  R31/G61/B31, membership 0, triples 112>60, gammaFrac 0.9688; resolve 1.0).
- mip-dither: report-only (count 0, scatter 0.0000 — the 0/0 blocker stands).
- F1 GATE (tone-normalized CPU): 303945/304964 px (99.666%) maxΔ255 FAIL.
  F0/F2 report-only: 99.609%/99.604% FAIL. CPU hashes unchanged
  (F0 930337c1 / F1 730221a2 / F2 84e627e3); water contributes 0 px in-view.
New finding: tone normalization moved the needle 0.007% (99.659→99.666%).
The divergence is structural, not tonal: per-level analysis (normalized-CPU
R → GPU−CPU) shows bias +1…+45 LSB with within-level std 19–53 LSB across
the 12 most populous levels — the GPU linear pipeline (texel×lightmap,
overbright, 565, reconstruction, gamma) vs the CPU colormap-graded bytes
differ per-pixel in ways no global map can absorb. Neither renderer path
was touched. The 0.02 gate cannot be met by tone work; the remaining
question is whether this structural divergence is acceptable
(different-but-faithful pipelines) or a defect — NEW user verdict needed
(the approved proposal is spent). Artifacts: gitignored
`packages/testkit/test-output/gpu-proof4-2026-10-31T07-44-03-766Z-*`
(gate.json carries `toneCurveGate`, `mipReportOnly`, `regions.water`).
