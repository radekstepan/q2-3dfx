Optimize Q2TS rendering performance while preserving the current software and Voodoo appearance and gameplay. Implement and validate the work using coordinated subagents and changesets.

Read BRAIN.md fully before editing, followed by docs/architecture.md, docs/renderers.md, docs/process.md, docs/lessons.md and docs/perf-ledger.md. Follow repository instructions and package ownership rules.

OBJECTIVE

The user reports 15–20 FPS even at 320×240, particularly in Voodoo mode. Identify and remove the actual bottlenecks. Preserve BRAIN.md’s ≤16 ms/frame budget at 640×480 and its browser 60 FPS objective; do not weaken budgets or declare success from a synthetic kernel benchmark.

Keep the software-first architecture and Node/headless support. A GPU backend is outside this task. Do not replace the renderer with WebGL, change fidelity defaults, lower resolution, or reduce scene complexity to claim a performance improvement.

STARTING EVIDENCE — REVERIFY

A previous source inspection found:

1. apps/web/src/dom.ts presents a CPU framebuffer using Canvas 2D putImageData.
2. packages/sw-renderer/src/frame.ts draws the classic indexed world pass even when it subsequently draws RGB spans.
3. packages/sw-renderer/src/bands.ts partitions RGB spans into bands but executes them on the calling thread; workers handle indexed planes. Its band loop repeatedly scans spans.
4. packages/sw-renderer/src/spans.ts performs CPU texture and lightmap bilinear sampling, depth tests, modulation and RGB565 writes.
5. End-frame palette expansion/RGB composition and apps/web/src/play.ts resolveDisplay add serial full-frame work.

An existing devroom benchmark, run against the package builds available at the time, reported:
- 320×240: software 2.17 ms; Voodoo raster 15.62 ms, composition 1.08 ms, scanout 7.83 ms.
- 640×480: software 6.68 ms; Voodoo raster 55.36 ms, composition 4.14 ms, scanout 26.82 ms.

These are leads, not acceptance baselines: they exclude browser presentation/full gameplay, may use stale builds, and do not establish your machine’s performance. Rebuild dependencies and collect fresh measurements.

PHASE 1 — BASELINE AND CONTRACTS

Before optimization:
- Inspect the working tree and preserve unrelated user changes.
- Use tools/q2-paths.sh to locate real assets; never commit proprietary assets.
- Establish reproducible fixed-camera/fixed-time baselines for both renderers at 320×240 and 640×480.
- Include real base1 views and gameplay, not only devroom.
- Record framebuffer hashes and baseline screenshots/crops covering world, sky, water/glass, entities, viewmodels, sprites, particles, tracers and HUD.
- Attribute simulation, geometry/culling, projection/span generation/sorting, indexed raster, RGB raster, foreground, composition, scanout, worker staging/waiting and browser presentation.
- Verify the browser actually uses the intended worker path and internal canvas resolution.
- Inspect current fidelity tests and normative documentation. BRAIN.md contains historical descriptions that may conflict with later fixes, including quantization and gamma order. Resolve contradictions using current implementation, regression evidence and authoritative renderer docs; do not “restore” an obsolete pipeline.

Capture the required frame-ordering, buffer-ownership, depth, coverage and fallback invariants before designing changes.

SUBAGENT ORGANIZATION

Use a primary integrator and up to three concurrent subagents, respecting available slots and ONE writer per package at a time.

Create task cards with owns, depends, status and measurable done-when criteria. Delegate:
- Raster lane: packages/sw-renderer. Investigate duplicated indexed/RGB work, real parallel RGB execution, span partitioning and pixel-loop costs.
- Scanout lane: packages/voodoo. Optimize reconstruction, packing and gamma without changing output.
- Measurement/integration lane: tools/bench and apps/web. Build reproducible attribution and browser validation, then integrate worker/presentation changes after the relevant interfaces are ready.

The primary integrator owns shared documentation and task coordination. Assign packages/config, packages/renderer-api and packages/testkit explicitly when needed; never allow overlapping ownership. Respect existing active task claims.

Before cross-package implementation, agree on interfaces and ordering. Follow BRAIN.md’s separate interface-change process and frozen-contract requirements. Agents request handoffs instead of editing another agent’s packages. Each agent returns changed files, correctness evidence, benchmark results, risks and its changeset.

PHASE 2 — MEASURED OPTIMIZATION

Prioritize changes by measured frame cost:

A. Remove redundant indexed work where safe.
Do not simply delete the classic draw. Establish which pixels and consumers still depend on indexed color/depth, background seeding, uncovered pixels, foreground ordering and fallback paths. Preserve all required behavior. If Voodoo-mode internal index-plane parity is only a diagnostic expectation, explicitly resolve that contract before changing it; keep software-mode parity intact.

B. Implement actual RGB parallelism where it improves end-to-end performance.
Workers must execute RGB raster work, not merely partition it on the main thread. Define shared plane ownership, material/lightmap lifetime, frame barriers, buffer reuse and ordered foreground composition. Preserve absolute dither coordinates and correct filter access across band boundaries. Exercise worker counts including zero/serial fallback; choose scheduling based on measured overhead, especially at 320×240.

C. Optimize serial RGB and scanout work.
Remove unnecessary passes, repeated calculations, staging copies and allocations where equivalence can be proven. Investigate reuse of overlapping reconstruction taps. Do not fuse or reorder stages if that changes rounding, quantization, blending or gamma behavior.

D. Verify presentation and frame scheduling.
Measure rAF pacing, worker waits and frame completion separately. Preserve responsive input, single simulation ownership, 10 Hz game ticks, interpolation and non-overlapping renderer state.

Retain only optimizations that improve representative frame performance without correctness regressions. Keep unfinished work disabled behind the required feature flag.

FIDELITY AND REGRESSION REQUIREMENTS

Treat the current corrected appearance as the regression oracle, not as proof of hardware calibration.

Require byte-identical output for unchanged rendering inputs wherever the existing deterministic path permits it. Do not update golden hashes merely to make an optimization pass. Investigate every difference; an intentional visual correction is outside this optimization task unless separately authorized.

Preserve:
- Software palette/colormap behavior and existing goldens.
- Texture addressing, mip UV scaling, LOD bias and mip dithering.
- Texture/lightmap filtering, dynamic lights and light styles.
- RGB565 write/blend semantics, normalized depth, ties and viewmodel depth handling.
- Dither phase, reconstruction thresholds, gamma placement and vd_* semantics.
- MD2 opacity, sprite transparency and the fixed black-gun/missing-geometry behavior.
- Strict HUD-before-scanout ordering and exactly one scanout.
- Serial/worker equivalence, band seams, sky, alpha ordering and foreground visibility.
- Cache bounds, eviction ownership and sustained-performance stability.

Use meaningful differential tests for optimized paths, including odd dimensions, band boundaries, relevant cvar combinations and worker fallback/failure behavior. Do not disable tests, weaken assertions, or hide incomplete work by changing baselines.

MEASUREMENT AND COMPLETION

Run matched before/after cases with identical cameras, time, entities, cvars, resolution and worker settings. Warm up both versions. Record machine/browser/build information, medians and p95 frame times, repeated runs and variability. Avoid concurrent benchmarks competing for CPU. Report stage timings separately from full-frame latency and actual presented FPS.

Validate:
- Devroom and multiple real base1 views.
- Stationary, moving/turning and sustained-combat scenes.
- Both resolutions and both renderers.
- Serial and useful worker-count configurations.
- A several-minute browser soak for FPS drift, memory/cache growth and correctness.

Synthetic benchmarks cannot close the task. Missing assets or browser access must be reported as missing validation, not counted as passing.

Every logical package change must include an appropriately scoped changeset using the actual package names. Frozen contract changes require BRAIN.md’s major changeset and documentation update. Keep independently reviewable changes separate; do not publish releases.

Before declaring completion:
- Run focused regression checks, real-asset release gates, yarn deps:check and yarn verify against the integrated final tree.
- Review before/after screenshots and pixel differences.
- Append honest measurements to docs/perf-ledger.md.
- Update task cards, archive completed work, and correct relevant documentation.
- Report improvements, remaining bottlenecks, fidelity evidence, changesets and any unmet budget.

Continue through implementation and integration rather than stopping at recommendations. Never claim “60 FPS” from kernel throughput or a partial-frame measurement. If the target remains unmet, state the measured shortfall and remaining work explicitly.

---

## Task cards (integrator-owned coordination)

### PERF-1 — Baseline attribution + reproducible harness
owns: `tools/bench`, `packages/testkit`
depends: none (respects M7.1 `apps/web` lock — read-only there)
status: done
done-when:
- [x] rebuilt deps, fresh 320×240 + 640×480 numbers for software + Voodoo on devroom + ≥2 real base1 views, warmed, medians + p95, machine/build recorded (`yarn bench:rgb`, Ryzen 5 PRO 2400G, Node 22)
- [x] stage attribution: sim, GEO/cull, project/emit/sort, indexed raster, RGB raster, foreground, composition, scanout, worker staging/wait, browser present separated (worker/rAF/present documented as browser-only gaps)
- [x] framebuffer hashes + baseline crops recorded; browser worker-path + canvas resolution verified (frameAsync + BrowserBandPool + sw_workers, internal W×H)
- [x] fidelity-test vs docs contradictions listed with current-implementation resolution (linear-pack → recon → display-gamma; no obsolete restore)

### PERF-2 — Raster lane (indexed/RGB + parallel RGB)
owns: `packages/sw-renderer`
depends: PERF-1 (contracts + baselines)
status: done (RGB workers LANDED 2026-10-28; budget acceptance remains open — see blocker note below)
done-when:
- [x] indexed-dependency map (value-parity contract; software parity intact)
- [x] RGB executes on workers where it wins end-to-end (LANDED 2026-10-28: JOB_RGB raster kick — SAB RGB planes + per-frame chain directory + luxel staging + RGB descriptors; Node BandWorkerPool + BrowserBandPool + shared bandWorkerLoop; renderer stages world/skybox/flat-sky batches, single kick after the indexed kick, foreground inline after. Bugs found+fixed: odd-dim SAB misalign, indexed resetAccum wiped RGB staging, 2MB sky chain overflowed 4MB cap (now 8MB). Differential pins: rgbWorkers.test.ts — devroom 1/3/7 workers, odd dims, determinism, dead-pool, async kick, Q2_PAK base1 ×2 views ×entities ×1/7, full-RGBA hash)
- [x] representative-frame win with byte-identical outputs (Node spawn-north 640×480 RGB renderView 110.55→55.73, 2.0×; full production frame 123.13→77.96, 1.58×; 320×240 renderView 47.40→34.94, frame 43.02→35.71. ALL hashes identical serial-vs-worker on 48 configs incl. BEFORE pins 90bb1188/58c218d4; browser kick verified engaged via __q2stats rgbStaged/kicks)
- [x] changeset + bench rows + risks (.changeset/sw-rgb-workers-perf2.md, perf-ledger PERF-2 + PERF-4 rows)

> PERF-2 blocker note (2026-10-28): the LANDED worker kick is real end-to-end parallelism with byte-identical
> output, but the ≤16ms/60fps acceptance is NOT met (Node full-frame 78ms@640×480, browser 66ms@320×240).
> Roofline: GEO ~17ms serial floor (resolution-independent) + serial alias RGB incl. viewmodel gun + serial
> fused scanout 22ms@640×480 (5.8ms@320×240) + classic indexed pass kept (skip proven unsafe: window-Z vs
> float-zb, foreground depth, seed, stipple — see dependency map) + browser sim/HUD/blit/compositor. No single
> remaining optimization closes a 4–5× gap; further gains need parallel scanout + alias and/or algorithmic GEO
> cuts, all measured against the same bit-identical oracle. Budgets NOT relaxed.

### PERF-3 — Scanout lane (reconstruction/pack/gamma)
owns: `packages/voodoo`
depends: PERF-1
status: done (fused resolve landed, bit-identical)
done-when:
- [x] reconstruction + packing + gamma profiled + fused (single-pass pack->recon->gamma, 1.10-1.24x, 1920-combo 0-mismatch)
- [x] vd_* semantics, thresholds, placement unchanged (48-combo + f4ebd424 + odd dims green)
- [x] changeset + bench rows + risks (.changeset/voodoo-fused-resolve-perf3.md)

### PERF-4 — Integration (browser present + scheduling)
owns: `apps/web`
depends: PERF-1, PERF-2, PERF-3 (starts after interfaces ready; respects M7.1 lock — coordinate/handoff)
status: in-progress (browser measured 2026-10-28: kick engaged, presented FPS recorded; 640×480 + full soak + 60fps acceptance remain open)
done-when:
- [x] rAF pacing vs worker-wait vs frame-completion measured separately; responsive input, single sim, 10Hz ticks, interpolation, non-overlapping renderer state preserved (presented-FPS via frame-counter deltas; engagement via __q2stats pooled/rgbStaged/rgbKicks/rgbInline; pool auto-latch sw_workers=7, crossOriginIsolated true; no sim duplication — frameAsync owns sim; foreground after kicks)
- [ ] serial + worker-count validation at both resolutions both renderers; multi-minute soak (FPS drift, mem/cache, correctness) (DONE 2026-10-28 at 320×240: voodoo pooled 15.1fps presented [kicks flowing: staged ~1848/kicks 1/inline 0] vs serial-path 11–13fps; software pooled 41.3fps [RGB off as expected]. Screenshots reviewed: spawn view correct, gun textured, HUD live. 5-min stability soak running, no decline in-window; voodoo-regression headless gate 29/29 + web 247/247 green. OPEN: 640×480 browser run; full worker-count sweep in-browser (mid-loop cvar switch cannot re-attach the pool — needs fresh loads); 60fps acceptance NOT met)
- [x] exactly-one-scanout + HUD-before-scanout preserved; changeset + honest ledger rows (web + voodoo-regression gates green; screenshots reviewed; ledger PERF-4 row)
