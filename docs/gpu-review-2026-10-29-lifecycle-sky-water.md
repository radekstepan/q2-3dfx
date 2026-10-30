# GPU review — lifecycle, sky and water (2026-10-29)

Review baseline: HEAD `8fde77f`. User reports application builds/runs, mostly
60 FPS at 640×480 in the preceding review, and no recurring black textures.
Current defects: sky absent; water has visible moving tiles/hard boundaries.
This is evidence and history, not an execution queue. See BRAIN.md for tasks.

## Follow-up review at `dfc58d9` — solid blue sky

This follow-up supersedes the dirty-tree/readiness snapshot below. Working tree
was clean before this documentation update. FOLLOW-4 is now committed. Renderer
`follow4.test.ts` was rerun: 6/6 passed. No full verification or live browser run
was repeated in this review.

The commit binds a complete white sampler texture in `drawSkyRange`, fixing the
previous invalid draw (GL 1282). Sky vertices still have a single palette-derived
color. `drawScene` selects this flat branch when no sky strip is registered, and
`apps/web` still contains no `registerSkyStrip` call. Thus the user's all-blue
sky is consistent with the fallback now rendering, not a completed textured-sky
repair. Keep the sampler fix; implement FOLLOW-3A's production asset replay.

The browser test now asserts frozen/resumed submissions and lifecycle counts over
two cycles. Its screenshot checks still measure only nonblack fraction, gun-region
nonblack fraction, near-white fraction and distinct colors. They do not prove
specific restored world/model/skin content, nor reject a flat sky on an otherwise
colorful page. FOLLOW-5 retains semantic recovery evidence; FOLLOW-3A requires a
sky-specific negative control. Commit evidence reports focused tests and
 typecheck/lint/build/dependency checks; retain the final full verify gate rather
than treating the old checked box as independently verified here.

## Historical uncommitted work and readiness

The existing dirty files form GPU-FOLLOW-4, not unexplained rendering experiments:

| Files | Purpose |
| --- | --- |
| `packages/webgl-renderer/src/renderer.ts`, `follow4.test.ts` | Resource ownership, deletion, context loss and restore |
| `apps/web/src/gpu-canvas.ts`, `play.ts`, `soak.ts`, `gpu-lifecycle.test.ts` | Canvas events, retained replay, submission guards, lifecycle diagnostics/tests |
| `packages/config/src/index.ts`, `renderer-selection.test.ts` | Renderer-selection/fallback vocabulary and tests |
| `packages/testkit/src/index.ts`, `gpu-follow-4.ts`, `gpu-follow-4.test.ts` | Lifecycle helpers, mirrors, browser test and exports |
| `.changeset/{config,testkit,web,webgl-renderer}-gpu-follow-4.md` | Four package changeset files; reconcile with existing ignored-package policy |

These are a coherent candidate commit, **not yet certified ready**. No source
files were changed or committed by this review. Preserve this work; do not reset,
stash or mix unrelated sky/water repairs into its commit. Re-read the diff before
staging, since another agent may still be editing.

Validation performed in this review:

- Renderer `follow4.test.ts`: 6 passed.
- Web `gpu-lifecycle.test.ts`: initially 13 passed / 3 skipped; rerun with local
  `Q2_PAK` supplied: all 16 passed (including repeated asset/map/loss cycles).
- Config `renderer-selection.test.ts`: 5 passed.
- Testkit `gpu-follow-4.test.ts`: 7 passed / 1 skipped without Q2_PAK; one passing
  test only logs the browser skip reason. This is NOT browser recovery evidence.
- Targeted Turbo typecheck: exit 0, 20 cached tasks. Not a fresh full build/verify.
- `git diff --check`: passed before documentation edits.
- Full `yarn verify`, dependency gate and real-browser lifecycle suite were not run
  in this review. User's successful build/run is additional manual evidence.

Concrete test deficiency: the real-browser test in
`packages/testkit/src/gpu-follow-4.test.ts` records before/during/after submission
counts but asserts only renderer identity/warning behavior after restoration.
It does not assert frozen submissions while lost, resumed submissions afterward,
or restored scene pixels. Its throwaway probe proves the extension mechanism,
not application recovery. Add production-canvas assertions before calling this
card done; mirror/stub tests cannot replace that evidence.

## Sky: confirmed integration omission

`apps/web/src/play.ts` loads the map sky through `loadSkyStrip` and calls only
`refresh.setSkyTexture`. No app call to GPU `registerSkyStrip` exists. The GPU
implementation and fixture were added in FOLLOW-3, but production asset wiring
was missed. The strip loader returns total height of six vertically stacked
faces; `registerSkyStrip` expects per-face tile height (`strip.height / 6`).
Connect retained sky data to boot, selection, map changes and context restore.
Renderer capability tests alone did not establish visible production sky.

## Water: visible defect, root cause not established

Inspect `shaders.ts` FS_LIT/`voodooWarp`, world UV construction and mip/addressing.
The shader uses floored UV/time lookup coordinates and reconstructs texel UVs
using uploaded texture dimensions. Investigate repeat boundaries, adjacent BSP
face coordinates, resampling scale, derivatives/LOD, precision and lightmap
boundaries separately. These are hypotheses, not a diagnosis. Current FOLLOW-3
warp mirror/uniform tests do not prove spatial/temporal continuity in real water.
Preserve intended turbulence and transparency while fixing actual seams.

## Outstanding evidence and deferred scope

- FOLLOW-2B's PROOF-4 far/mip fixture reads 0/0 after repairs: repair meaningful
  fixture coverage in FOLLOW-5, without loosening assertions to make it green.
- Historical first-submit GL 1282 remains unexplained. “SwiftShader quirk” is not
  established root cause; reproduce/isolate in FOLLOW-4, don't drain and hide it.
- Prior 0.912/0.02 fidelity figures predate repairs and are not current verdicts.
- FOLLOW-2C route timings were report-only; final displayed soak remains open.
- No live sprite producer was found in FOLLOW-3; sprite fixture support exists.
  A future server/game producer decision is outside this renderer defect queue.
- CPU campaign/M7.1 stays paused; historical Voodoo hardware oracle M4.1 remains
  pending; DEMO1 remains asset-dependent. See previous history/process docs.
- Cached-pak startup ≤2.5 s is still a requirement, not a measured success.

## Superseded queue snapshot

The following completed summaries and old status claims are retained solely for
traceability. In particular “working tree is clean”, the old ready FOLLOW-4 and
fully complete sky/water claims are superseded by the review above and BRAIN.md.

## 8. Current state and remaining work

### State as of 2026-10-29

**User validation:** “Major major improvement”; mostly 60 FPS even at 640×480;
no failing textures or black spots observed. Treat those earlier reports as
visually improved, not current known failures. Preserve the gains and regression
fixtures; do not repeat old investigations without new failing evidence.

**Reviewed baseline:** committed `866a553` plus FOLLOW-2B work now landed as
`3467ddd` (wiring + stub regression) and `ee180f2` (real-browser triage,
honest GL attribution, dither-liveness proof). Working tree is clean; the
former dirty-tree reservation is released. Re-read git status and this queue
before claiming ownership.

| Work | Current disposition |
| --- | --- |
| WebGL scene/backend and appearance prototype | Implemented; retain CPU reference/fallback |
| FOLLOW-0 black CSS overlay/alignment | Done, `4dd7fc0`; page now visibly renders |
| FOLLOW-1 acceptance/reporting corrections | Done, `f05e0ba` + `a53baf4`; retain rejection gates |
| FOLLOW-2 full-map storage/current-view selection + FOLLOW-2C live-route validation | DONE (2C integrated below); full-map store + live multi-room/turn/door/lift route with semantic coverage + report-only timings |
| FOLLOW-2A model/skin replay and switches | Done, `866a553`; replay retained assets without restarting game |
| FOLLOW-2B textures/lightmaps | DONE (`3467ddd` + `ee180f2`); all 7 boxes evidenced (stub + real-GL); 2 follow-ups filed (PROOF-4 far/mip fixture → FOLLOW-5; stale first-submit 1282 → lifecycle note) |
| Full gameplay coverage, lifecycle and final acceptance | Remaining cards below |

History and full prior evidence: `docs/performance-gpu-history-2026-10-29.md`,
`docs/perf-ledger.md`, `docs/gpu-follow-1-reconciliation.md`. Old “no enemies”,
“black screen”, “frozen spawn geometry” and “clamped walls” diagnoses there are
historical, not instructions to reimplement completed/current repairs.

### Execution rules for the remaining queue

- Continue 4 → 5/6 → 7 (2B/2C/3 done and integrated). FOLLOW-5 and 6
  may run independently after 4 when package ownership permits. Exactly one writer
  per package; delegate independent lanes under §7; integrator owns shared docs,
  changesets and commits. Keep card IDs stable for the LLM already working.
- This cleanup supersedes older task lists, including TASK.md, as the active queue.
  Completed IDs in the table satisfy dependency references; FOLLOW-2 implementation
  does not need another card to repeat it. No extra feature work beyond this queue.
- User-reported visual improvement is real evidence. It does not require re-proving
  every historical bug from scratch, nor does it replace final route/lifecycle tests.
  Keep barrel/infantry/wall regressions in tests; treat old 0.912/0.02 fidelity numbers
  as PRE-REPAIR measurements and rerun before claiming a current failure.
- Correctness repairs are allowed; stop speculative optimization now that gameplay
  is reportedly near target. Only investigate speed again for a measured regression
  or final gate miss, with at most the ONE remaining measured optimization iteration.
  Do not restart the CPU campaign, chase higher FPS or build a new abstraction layer.
- Keep GPU experimental until final evidence supports rollout. Preserve CPU goldens,
  software selection, Node support and game state. GPU-resident HUD is optional and
  is not a completion requirement while the existing overlay works acceptably.
- Unit tests, real-browser rendering, semantic content and performance prove different
  things. Use actual page captures, GL error checks and live gameplay for the relevant
  cards. Nonblack pixels, draw counts or unthrottled headless cadence alone do not
  establish visual completeness/displayed 60 FPS.
- Record concise implementation/correctness/measurement/acceptance outcomes and
  durable evidence. Run expensive validation sequentially. Commit validated increments
  with required changesets, no push; do not ask again for already authorized work.
- If a genuine external prerequisite (display access or a specifically requested
  visual-contract decision) is missing, complete independent work, record it precisely
  and leave only that gate blocked. Do not manufacture approval or relax thresholds.

### Remaining source-level concerns (not reports of current visible failures)

1. Browser context loss/restoration is not wired end to end. resize drops its target
   reference and uploadStatic replaces caches without deleting same-context resources.
   FOLLOW-4 owns teardown/restoration and repeated-cycle tests; reuse FOLLOW-2A replay.
2. Sky is still a flat fill; water turbulence is deferred. Live sprites/particles and
   event lifetimes need coverage. FOLLOW-3 owns these, not another texture rewrite.
3. Default-alpha beams get opaque/order-zero refs but draw in the blend pass;
   turbulent flags are classified before translucency. FOLLOW-3 must test/correct
   combined material semantics and overlap ordering, using real produced events.
4. Reporting/acceptance helpers now exist, but multi-room semantic coverage still
   needs integration (FOLLOW-2C). Previous fresh-vs-reselected equality is useful
   but not an independent oracle for all geometry.
5. Formal final fidelity and displayed-frame evidence must be collected from the
   completed, committed renderer. The user's near-60-FPS observation is encouraging;
   do not mislabel historical headless numbers as a matched final displayed run.

### GPU-FOLLOW-2B — Repair diffuse texture and lightmap correctness
owns: `packages/webgl-renderer`, `packages/testkit`
depends: GPU-FOLLOW-2A
status: done (landed `3467ddd` + `ee180f2`; lane report in `docs/tasks-archive.md`)
starting-points: `renderer.ts: uploadTextureLevels/diffuseFor/skinFor`; `worldMesh.ts: pushSurfaceTris/packLightAtlas`; `appearance.ts: voodooSampleMipped`
done-when:
- [x] Reproduce a failing world-repeat fixture with UVs outside [0,1], including negative UVs and bilinear seams. Give WAL/world materials repeat addressing and skins/sprites/lightmap atlases their intended clamp policy through texture creation and sampling. Preserve correct mip derivatives and resampling UV scale. (stub REPEAT/CLAMP param pins + negative/multi-tile UV fixture in `follow2b.test.ts`; real-GL: 31 diffuse + atlas healthy, triage nonblack ~0.89)
- [x] Set/restore appropriate pixel-unpack state for tightly packed RGB data; exercise 1/2/3-wide, odd-width/NPOT and real skin mip chains in a real WebGL context. Assert no upload GL errors, valid expected mip texels and sampled colors (not only texImage2D arguments). (stub ALIGNMENT set/restore in `follow2b.test.ts`; real-GL: `uploadErrors: []` ×4 runs, mipChain 7 levels lastMean [128,128,128], stage diffs 0.71)
- [x] Expand missing/short lightmap fallback to every luxel or represent a deliberate uniform unlit material. Never index beyond a three-byte fallback; test no-light surfaces and atlas overflow. Audit surface lightId mapping and light-style handling against the CPU reference. (no-light→unlitUV, short-fill+shortFallback, overflow→unlit, lightId%len tests in `worldMesh.test.ts`; real base1: skipped 0, shortFallback 0)
- [x] Fix/test luxel centre placement and bilinear isolation between adjacent atlas tiles (gutters/edge duplication or equivalent). Use contrasting tiles, last-row/column samples and actual map edges to detect dark bleeding. (centre/gutter-duplication/last-luxel/lightId tests; real far-camera content 0.978 nonblack, no dark bleeding)
- [x] Capture diffuse-only, lightmap-only and final output at the same camera for reported black regions; identify each region's cause. Test actual textured walls/floors and enemy/gun skins in the composed page. No global brightness boost, disabling lighting or changed goldens to hide black spots. (same-camera 0/1/2 captures + diffs 0.707/0.710 in `proof.follow2b`; production path untouched)
- [x] Pin sampler-unit isolation during first-use lazy world/skin uploads and mixed world/alias/sprite draws. Assert unit 0 diffuse and unit 1 lightmap bindings at actual draws with a real-GL image regression; no accidental atlas replacement by uploads. Measure full-map atlas capacity/overflow and implement correct handling rather than sampling unrelated atlas-origin pixels. (stub per-draw unit0+unit1 + uDebugMode upload test; real atlas 1024x395, 7663 rects, skipped 0; triage renders clean)
- [x] Retain intended genuinely dark texels and documented appearance policy. Report asset warnings and material/texture counts; no silently missing required textures or GL upload errors on the supported route. (material counts 31+2+atlas + warnings published; uploadErrors [] on SwiftShader route)
- Follow-ups (not 2B blockers, remain visible): (1) PROOF-4 near-camera far/mip fixtures read 0/0 post-fix (were 169895 with bleed + unsettled first-submit) — mechanism documented, asserts left untouched (no loosening), repair belongs to FOLLOW-5 post-repair re-baselining. (2) Stale per-context 1282 on first-submit/fixture frames (SwiftShader quirk, zero pixel impact): uploads/draws exonerated (uploadErrors [], postTriage []), precise phase hooks landed (`glFirstErrors`, honest pre-poll); root-cause to lifecycle/driver-quirk note.

### GPU-FOLLOW-2C — Prove live map completeness and close visibility validation
owns: `apps/web`, `packages/webgl-renderer`, `packages/testkit`, `tools/bench`
depends: GPU-FOLLOW-2B
status: done (3-lane integration below; lane report in `docs/tasks-archive.md`)
done-when:
- [x] Drive the production page through actual multi-room translation/PVS transitions, a 180-degree turn and opening/closing doors plus a lift. Record camera/cluster changes and mover state; selecting two synthetic views is not a live route. (Lane A `apps/web/src/gpu-live-route.test.ts`: stub 820 frames/16 clusters/odometer ~855, door *32 open+close peak 35.0, lift *13 ride peak 56.0; real-page CDP legs stationary/translate/turn with cluster 631→1166 + per-leg screenshots + consoleErrors [])
- [x] Use independent expectations for named wall/floor/ceiling regions and opaque occlusion (CPU reference or known fixture geometry), plus real composed-page captures. A fresh and reselected GPU renderer agreeing does not count as proof on its own. (Lane B CPU-oracle fixture + `deriveSemanticOracle`; live-route capture input shape `LiveRouteSemanticCapture`; real-page leg screenshots)
- [x] Prove specific alive enemies/viewmodel and textured surfaces persist through movement and switches; fail on missing required meshes/skins, upload errors or unexplained holes. Preserve the earlier TURN equality test as a narrower regression. (Lane A infantry+soldier alive, viewmodel, worldOpaque counts, missing/upload gates stub+browser; TURN equality untouched green)
- [x] Feed semantic content/occlusion results into validateSceneCoverage and tests that reject a scene with an intentionally removed wall/enemy even when frames, uploads and screenshot counts look healthy. Keep helper/type ownership explicit across bench/testkit. (Lane B `validateSceneCoverageAndContent` successor gate, 12/12: removed wall/floor/ceiling/enemy/viewmodel, occluder leak, missing waypoint, upload errors, stalled submissions; bench keeps its by-value duplicate, no type duplication)
- [x] Record report-only route timings on the now-complete scene, not a new optimization campaign. Close the remaining FOLLOW-2 validation here only with this evidence (the old card is historical); full final soak remains FOLLOW-6. (Lane C `tools/bench/gpu-route.mjs`: Vega 11 hardware GL, stationary 60.01 / moving 60.07 / combat 58.23 fps, p95 ≤22.85ms, dropped 6, uploads 1, displayed claims VOID; bench changeset-ignored per convention)

### GPU-FOLLOW-3 — Complete live effects and required world appearance
owns: `packages/webgl-renderer`, `apps/web`, `packages/testkit`
depends: GPU-FOLLOW-2C
status: done (3-lane integration below; lane report in `docs/tasks-archive.md`)
done-when:
- [x] Inventory actual live producers/consumers for sprites, particles, beams, explosions, lights and model/skin kinds. Connect game events and lifetimes to GPU drawing; rendering synthetic fixtures alone is insufficient. Verify event drains occur in the intended tick order without dropping or double-consuming effects. (Lane B `gpu-effects.ts` inventory + drain-order tests; blaster→bolt→muzzle→impact→explosion→particles proven live)
- [x] Classify/order default-alpha beams for their actual blended draw pass; test beam/glass/translucent-alias overlap at changing camera positions. (Lane A `entityBlend`: tracers always blend with distance keys; overlap tested at spawn/translated/180°-turn cameras; combined far→near world+entity order, CPU difference documented in PROOF-4.md §6)
- [x] Preserve model-kind metadata (not just the temporary tracer map), sprite animation/size, particle counts/lifetimes and weapon/light timing. Prove real combat event → submitted geometry → visible pixels with tests. (Lane B full `modelKindsForFrame` to selection+draw; browser combat leg: bolts=2 expl=1 particles=80 muzzle=true nonblack 0.919)
- [x] Implement base1-required sky and water/warp/transparent behavior; current sky is flat and turbulence unwarped. Test combined turbulent/translucent flags and draw/depth order. Audit remaining cvar behavior and label unsupported choices explicitly. (Lane A: TRANS-first, single-sided glass, per-pixel warp, textured skybox via registerSkyStrip with flat fallback, `GPU_CVAR_GAPS`; real inventory 128 sky / 102 turbulent+translucent / 17 glass)
- [x] Exercise all supported weapons, enemies, pickups and relevant effects on the live path; no missing-mesh/skin warnings in supported scenes. Keep GPU-resident HUD optional unless measured CPU-overlay cost or correctness requires it. (Lane C catalogs + `validateFollow3Coverage` 18/18; HUD stays report-only. Follow-up, not a blocker: no live sprite producer — 8 sp2 ship in pak0, server queue absent, sprite path covered by fixture + billboard contract; needs a server/game producer decision)
- Integrator merge fixes (no loosening): lane B's pre-fix turbulent pin → post-fix blend expectation; `gpu-boundary` entity-kind pins → index-stable `surfaceId`-slot matching (transparent refs sort far→near; identity is the slot, order the draw sequence).

### GPU-FOLLOW-4 — Make resource lifecycle, switching and resize reliable
owns: `packages/webgl-renderer`, `apps/web`, `packages/testkit`, `packages/config`
depends: GPU-FOLLOW-3
status: ready
starting-points: `renderer.ts: uploadStatic/resize/dispose`; `gpu-canvas.ts`; `play.ts` GPU attach and renderer switching
done-when:
- [ ] Delete obsolete same-context buffers/textures/programs/FBOs/renderbuffers before replacing their ownership; do not drop maps/targets and rely on GC. Distinguish invalid handles after context loss from live resources during ordinary resize/map replacement.
- [ ] Wire actual canvas contextlost/contextrestored events, prevent default loss handling where restoration is supported, stop submission safely and recreate programs/world/model/skin/appearance state after restoration. Test using a real browser context-loss mechanism.
- [ ] Reuse the landed FOLLOW-2A retained-asset replay for restoration; retain CPU→GPU→CPU switching tests. Extend to actual context loss/recovery, unsupported-device fallback and repeated cycles; do not rebuild asset migration. Never count fallback as GPU execution.
- [ ] Resize synchronizes drawing buffer, render targets, viewport, camera aspect and HUD overlay. Repeated resize/switch/map/loss cycles have stable resource counts, no duplicate canvases/listeners and correct rendered output.

### GPU-FOLLOW-5 — Refresh fidelity evidence after the visual repairs
owns: `packages/webgl-renderer`, `packages/testkit`, `tools/bench`, `docs`
depends: GPU-FOLLOW-4
status: ready
done-when:
- [ ] Reproduce F0/F1/F2 CPU/GPU captures with identical scene/time/cvars after coverage fixes. Keep the old 0.912-vs-0.02 result as historical baseline; record the NEW metric and investigate only remaining unexplained lighting/UV/depth/transparency differences. The user now reports no broken textures or black spots; do not present the old failure as current.
- [ ] Fix unintended differences and add local regression fixtures. Measure region/class-specific differences for intended approximations; retain full-frame metrics. No threshold loosening or golden replacement to hide unexplained changes.
- [ ] Meet the existing fidelity contract OR prepare concrete side-by-side artifacts and a precise proposed visual contract for USER approval. The latest positive user report confirms usability/visual improvement but does not by itself approve an unspecified numerical threshold change. Agent approval or missing historical Voodoo captures cannot supply that approval.
- [ ] Record automated fidelity and any required user visual approval separately. Independent lifecycle/measurement work may continue while approval is pending; final acceptance/default promotion may not.

### GPU-FOLLOW-6 — Verify the complete live renderer on a visible display
owns: `apps/web`, `tools/bench`, `packages/testkit`, `docs`
depends: GPU-FOLLOW-4
status: ready
done-when:
- [ ] Run a hardware-backed visible-browser 640×480 soak ≥5 minutes with stationary, multi-room movement/PVS changes and combat, all required effects and real viewmodel. Capture actual camera positions, visited regions, geometry/effect execution and nonblack visible captures, not just echoed inputs.
- [ ] Use matched CPU/GPU browser/compositor settings for comparisons or label unmatched numbers non-comparative. Record refresh/vsync, p50/p95/p99, dropped frames and explicitly described completed/display cadence evidence. Do not claim scanout presentation from framesSubmitted alone.
- [ ] Check original work/cadence gates (≤16 ms median frame work, ≥59 FPS on nominal 60 Hz, p95 interval ≤20 ms) separately, with bounded CPU/GPU resources and no silent fallback. Avoid per-frame blocking readbacks/finish; asynchronous GPU timing is supplementary.
- [ ] Record the immutable final build, raw samples and captures. If display access is unavailable, leave this card blocked with exact environment requirements. If performance fails, use at most the remaining one measured optimization iteration then report; do not resume CPU tuning.

### GPU-FOLLOW-7 — Final acceptance and deliberate rollout
owns: `BRAIN.md`, `docs`, `.changeset`, `apps/web`, `packages/config` (integrator)
depends: GPU-FOLLOW-2B, GPU-FOLLOW-2C, GPU-FOLLOW-3, GPU-FOLLOW-4, GPU-FOLLOW-5, GPU-FOLLOW-6
status: ready
done-when:
- [ ] Review integrated changes; run yarn verify, yarn deps:check, real-asset base1/voodoo gates and GPU lifecycle/image/gameplay suites. Record skips as missing coverage; retain CPU goldens and Node support.
- [ ] Publish separate implementation, correctness, fidelity and displayed-performance verdicts with evidence/commits. Resolve contradictory PASS/GO statements in reports/ledger/BRAIN; no unsupported final acceptance.
- [ ] Only with all required gates passed, close the historical GPU-EXPAND-1 umbrella and decide/promote the GPU selection/default with accurate labels and explicit fallback. Otherwise keep experimental and list remaining blockers; no automatic promotion from headless throughput.
- [ ] Add publishable-package changesets and validated commits without pushing. Archive completed proof/follow-up cards only after evidence is linked and unresolved items remain visible.

### Deferred work — not prerequisites for GPU completion

- **CPU performance campaign / M7.1 CPU-only FPS sign-off:** paused. Keep its
  original ≤16 ms/60 FPS goals and unresolved recovery notes in the history; do not
  mark them passed or resume optimization as part of GPU work.
- **M4.1 historical Voodoo3 hardware-capture review:** pending reference/human review.
  No claim of hardware-exact emulation; this is separate from the project's agreed
  GPU visual contract and does not block ordinary defect repair.
- **DEMO1 retail demo playback:** still pending, requires retail demo assets and its
  original prerequisites; out of this renderer completion queue. Procedural harness
  remains implemented. Do not delete this follow-up or ship retail assets.
- **Startup budget:** ≤2.5 s cached-pak to first frame remains a project requirement;
  no new startup benchmark or sign-off is claimed by this cleanup.

---

