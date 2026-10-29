Fix the remaining correctness and performance issues after commit 460232d. Implement with subagents, validate, create changesets, update documentation and commit autonomously. Do not push. Preserve unrelated user changes.

Read BRAIN.md completely, then the relevant renderer, architecture, process, lessons and performance-ledger documentation. Follow package ownership, dependency, frozen-contract and changeset rules.

Preserve completed improvements: RGB-authoritative rendering, true per-band span subranges, shared ESM/CJS configuration, RGB-first material preparation and full-RGBA parity checks.

The target remains ≤16 ms production frames and ≥60 presented FPS at 640×480 with normal fidelity and representative gameplay. No reduced resolution, disabled effects, missing entities or relaxed correctness checks.

Work in the order below. The correctness issue must be fixed before expanding foreground worker execution.

1. FIX FOREGROUND RECOVERY

Current problem:
- SoftwareRenderer.flushForegroundRGB() and related fallback paths call drawInlineRGBAll().
- Both Node and browser implementations clear the entire RGB coverage and depth planes.
- During foreground recovery, the pending descriptors contain only foreground work, not the previously rendered world.
- Consequently recovery can destroy world coverage and occlusion.
- If workers/main-band processing already blended some translucent pixels, replay can blend them again because destination colors are not restored.
- Quarantining workers prevents later writes; it does not undo writes already completed.
- Staging-capacity exhaustion also reaches this recovery path.

Relevant files:
- packages/sw-renderer/src/frame.ts
- packages/sw-renderer/src/bandPool.ts
- apps/web/src/render-workers.ts

Implement explicit recovery semantics distinguishing:
a. Staging refusal before dispatch.
b. Failure before any writes.
c. Failure after partial execution.
d. Disposal or timeout while writes may be in flight.

Choose a correct recovery design: checkpoint/restore, complete-frame replay, or safely tracked per-band recovery. Preserve previously rendered world and foreground state, exact blend order, coverage and depth. Do not merely remove the clears: that does not fix partial alpha replay.

Ensure workers cannot mutate buffers while recovery or subsequent frames use them. Handle both Node and browser pools.

Add deterministic fail-before regression tests:
- Force capacity exhaustion after staging some foreground work.
- Complete at least one band containing translucent pixels, then fail another.
- Exercise the calling thread’s completed band plus worker timeout.
- Verify world occlusion, untouched pixels, RGB565 color, coverage and depth against uninterrupted serial rendering.
- Verify alpha is applied exactly once.
- Verify the next frame is correct and no pending job wedges the loop.

Mocked workers that never write cannot prove partial-write recovery.

2. IMPLEMENT EXACT MODEL/GUN WORKER RASTERIZATION

The current foreground worker implementation handles deferred translucent spans and world-placed sprites. The expensive MD2 models/viewmodel, particles, entity sprites and tracers remain serial.

Do not defer this again because an incremental barycentric experiment changed pixels. Parallelize the existing exact rasterizer first, retaining its arithmetic and coverage rules.

Prepare transforms, clipping and immutable primitive/material data once where practical. Stage descriptors for disjoint row bands or tiles. Each worker owns its scratch and framebuffer region.

Preserve:
- World-before-foreground dependencies.
- Primitive order within every pixel region.
- Opaque and translucent blending.
- Window-Z comparisons and ties.
- RGB565 destination reads/writes.
- Viewmodel depth hack and near-plane clipping.
- Texture addressing, mip selection and lighting.
- Sprites, particles and beams.
- Software renderer behavior.
- The recovery guarantees established in item 1.

Do not schedule overlapping primitives as concurrent writers to the same pixels.

Implement Node and browser execution, not just a headless protocol. Make the normal browser Voodoo path use it by default when the pool is available.

Start with model/gun triangles because their recorded serial cost is approximately 15 ms. Then cover the remaining foreground primitive classes or retain narrowly justified inline work with explicit counts and measured cost.

Avoid a separate worker kick per entity or triangle. Preserve order through batched command streams and minimize synchronization barriers.

Required tests:
- Full-RGBA and relevant depth/coverage equality against exact serial rendering.
- Multiple overlapping opaque/translucent models.
- Gun against nearby walls and near-plane intersections.
- Animated frame interpolation and dynamic lighting.
- Odd dimensions and band seams.
- Multiple worker counts.
- Primitive ordering across triangles, sprites, particles and beams.
- Partial-job recovery using the new protocol.
- Actual browser worker execution with the real viewmodel.

3. MAKE FOREGROUND COUNTERS TRUTHFUL

Current fgInlineRgb tracks span batches, not all foreground work. Direct model/particle/tracer draws do not increment it. Thus “fgWorker=10, fgInlineRgb=0” can coexist with expensive serial model rendering.

The browser also derives fgWorker from staged batches whenever any foreground kick completed. Staging is not execution proof.

Replace or clarify these counters:
- Primitive class: alias/viewmodel triangles, alpha spans, sprites, particles, beams.
- Prepared/staged work.
- Actual worker-completed work.
- Calling-thread band work.
- Deliberately inline work.
- Fallback/replayed work.
- Separate timing for expensive foreground stages.

Count actual completion where possible. Use clear units; do not compare batches with triangles or pixels.

Add tests proving a serial viewmodel is visible in inline counters, successful worker execution is visible in completed counters, and staged-but-failed work is not reported as successfully worker-rendered.

Update browser stats, benchmark output, documentation and tests together. Preserve lightweight production behavior; detailed instrumentation may be optional.

4. MEASURE REAL WORKER EXECUTION AND SYNCHRONIZATION

Current diagnostics identify bands but measure caller-side completion-message arrival. That includes execution, scheduling and delivery delay.

Add worker-local execution duration measurements associated with:
- Frame/sequence.
- Job type.
- Stable worker/band identity.
- Actual primitive/span/pixel counts.

Keep caller dispatch-to-completion latency separate. Do not subtract timestamps across different time origins without establishing comparability.

Measure:
- Main-thread geometry/material preparation/staging.
- Worker world raster.
- Worker foreground raster.
- Calling-thread band execution.
- Idle time and barrier delays.
- Composition and scanout.
- Presentation and scheduling gaps.
- Allocation/GC where material.

Audit the newly introduced foreground flush points. Determine whether extra kicks, tiny jobs, or imbalanced bands offset useful parallelism.

Use measurements to optimize scheduling. Do not assume maximum hardwareConcurrency or more kicks is optimal.

Use instrumentation for attribution and uninstrumented runs for acceptance.

5. OPTIMIZE THE REMAINING CRITICAL PATH

After items 1–4, profile again and implement the largest remaining measured reductions.

Likely candidates:
- RGB span shading and lightmap sampling.
- Repeated material/descriptor/view setup.
- Geometry emission.
- Uneven band workload.
- Excess synchronization.
- Composition/scanout passes and repeated neighborhood expansion.

Preserve sampling, depth, dithering, reconstruction, gamma and HUD semantics. Existing WASM/SIMD infrastructure may be extended if supported by measured evidence and repository rules. Do not substitute a GPU renderer.

Evaluate whole-frame effects, not only microbenchmarks. Reject optimizations that regress production frames or output fidelity.

SUBAGENT ORGANIZATION

Use parallel subagents with exactly one writer per package:
- Renderer owner: packages/sw-renderer, sequencing recovery and exact foreground execution.
- Browser owner: apps/web, corresponding pool/protocol integration, diagnostics and browser validation.
- Benchmark/test owner: tools/bench and packages/testkit, measurement, adversarial recovery tests and acceptance.
- Integrator: shared contracts, ownership transfers, documentation, changesets and commits.

Adapt to available slots. Assign any additional packages explicitly.

Agree on protocol/interface changes before dependent implementation. Follow BRAIN.md’s interface-first and major-changeset rules for frozen contracts.

Subagents return changed files, tests, before/after evidence, unresolved issues and proposed changeset text. They do not commit or concurrently edit shared tracking files. The integrator commits.

Do not treat package ownership as an external blocker. Transfer or assign ownership when needed.

BASELINE AND VALIDATION

Establish a quiet-machine baseline at 460232d. Compare identical workloads and settings on the final tree. Do not reuse earlier serial-versus-pooled comparisons as commit speedups.

Recorded results to verify:
- Browser 640×480 Voodoo soak: approximately 15 presented FPS.
- Node pooled combat acceptance: approximately 80.5 ms.
- Earlier combat results were around 68 ms, but the records alone do not establish a controlled regression.

Run expensive benchmarks sequentially, not concurrently across agents.

Measure software and Voodoo, serial and 1/3/7 workers. Use stationary, moving-camera and combat workloads with the real viewmodel. 320×240 is diagnostic only; acceptance is 640×480.

Use full-channel comparisons and meaningful work counters. Preserve software goldens. Do not update goldens to hide unexplained differences.

Run:
- yarn verify
- yarn deps:check
- Real-asset base1-gate
- Voodoo regression gates
- Relevant renderer, worker, recovery and configuration suites
- Corrected full-frame acceptance commands

Perform a NEW final-code 640×480 browser soak of at least five minutes covering stationary, movement and combat. Report completed-frame cadence, frame-time percentiles, worker execution, fallback/replay counts, memory/cache trends and visual checks.

Do not sum separate stage medians and label them actual frame time. State headless versus hardware-backed browser conditions accurately.

COMPLETION

Create task cards with separate statuses:
implementation complete / correctness verified / performance measured / target accepted.

Do not close model/gun parallelism based on alpha-span worker counters.
Do not close recovery based only on failures before writes.
Do not close worker timing based only on message arrivals.
Do not label an unmet budget successful completion “by design”.

Continue implementing against the measured critical path while the target is missed. If a genuine external blocker prevents progress, identify it precisely and leave the corresponding acceptance item open.

The integrator must:
- Review all changes and run integrated validation.
- Add valid changesets for changed publishable packages.
- Update BRAIN.md and docs/perf-ledger.md honestly.
- Record reproducible controlled before/after results.
- Commit only intended work autonomously, without pushing or amending unrelated commits.

Finish with commit hashes, changesets, the completion matrix, recovery-test evidence, actual model/gun worker-execution proof, controlled performance results, final 640×480 browser evidence and any genuine remaining blocker.
