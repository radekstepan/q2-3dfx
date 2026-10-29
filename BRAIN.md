# BRAIN.md — Q2TS: Quake II in TypeScript (software renderer + Voodoo 3 3000 look)

> **This file is the single source of truth for every coding agent that touches this repo.**
> Read it fully before writing code. Never invent architecture that contradicts it.
> If reality and this file disagree, fix the file in the same PR that fixes reality.
>
> Detail docs live in `docs/`: `architecture.md`, `renderers.md`, `data-pipeline.md`,
> `process.md`, `perf-ledger.md`, `lessons.md`, `tasks-archive.md`.
> This file states the rules and the *active* work. Everything else is a pointer.

---

## 1. TL;DR

1. `corepack enable && yarn install`
2. `yarn turbo run build typecheck test --filter=...[origin/main]`
3. Pick **one** task card from §8 (or from a task list pasted in-session) that is `status: ready`.
   Claim it by setting `status: in-progress` + your agent id.
4. Work **only inside the packages listed in that card's `owns:` field.**
5. Before you finish: `yarn verify` must be green, and you must add a changeset (`yarn changeset`).
6. Mark done-when boxes, set card to `done`, move it to `docs/tasks-archive.md`,
   append measured numbers to `docs/perf-ledger.md`.

**Prime directive: `main` always builds and always boots to a rendered frame.** Any change that
cannot keep `yarn verify` green must be landed behind a feature flag in `@q2/config`.

- External reference material lives **sibling to this repo** in `../external/`
  (outside git — never committed, never published; names contain no spaces):
  - `../external/q2/` — Quake II game install with all data files (`baseq2/pak0.pak`)
  - `../external/quake-2-source/` — id Quake II source, GPL-2.0 (`ref_soft/`, `ref_gl/`, …)
  - `../external/quake-2-JS/` — community TS port (cross-check only)
  - `../external/quake-2-voodoo-3-demo/` — Voodoo-look web demo (reference)
  - `../external/voodoo3_progguide.pdf` — Voodoo3 programming reference
- `source tools/q2-paths.sh` exports `Q2_SRC` / `Q2_PAK` / `Q2_DOCS`
  (env-overridable defaults pointing at the above; `Q2_PAK` gates asset tests).

---

## 2. Mission

Rebuild Quake II so that it:

- **Renders in software.** Faithful port of `ref_soft` — 8-bit palettised framebuffer, 64-level
  colormap shading, perspective-correct spans subdivided every 16 pixels, surface cache,
  edge/span rasteriser, affine alias models. No GPU required.
- **Renders in "3dfx Voodoo 3 3000" mode.** Emulation of `ref_gl`-on-Voodoo3: RGB565 + 4×4
  ordered dither, 2×2 "22-bit" post filter, bilinear, mip LOD with mip-dithering, 64-entry
  table fog, LOD bias, 256×256 max texture size, 16-bit depth, ~1.3 Glide gamma lift.
  Full checklist + cvars: `docs/renderers.md`. RGB mip sampling scales UVs
  into the picked level (`1/(1<<lvl)`); alias tracks the shared `vd_lodbias`
  (`ALIAS_LOD_BIAS_DELTA = 0`, reassessed post-fix — see VOODOO-REPAIR-2 note).
- **Runs in a browser** at ≥60 fps at 640×480, and in Node for headless tests.
- **Plays shareware map end to end** (`base1`): movement, collision, doors, buttons, lifts,
  triggers, items, two monster types, three weapons.

### Non-goals (v1)

Multiplayer/netcode (server is in-process), CD audio, cinematics (`.cin`), save games,
mission packs, `gamex86.dll` ABI compatibility, demo recording. Demo *playback* of
`demo1.dm2` is in scope **only** as a determinism test harness. Full spec: `docs/process.md`.

---

## 3. Repo map (short) — full layout + dependency rules: `docs/architecture.md`

```
q2ts/
├─ BRAIN.md · package.json · turbo.json · .changeset/ · tsconfig.base.json
├─ apps/web devtools
├─ packages/math filesystem formats bsp sw-renderer voodoo renderer-api
│            game server client sound input host testkit config
└─ tools/asset-cooker bench
```

Dependency flow (enforced by `yarn deps:check`):

```
math ← formats ← bsp ← {sw-renderer, voodoo} ← renderer-api ← host
filesystem ← formats · game ← {math, bsp, config} · server ← {game, bsp}
client ← {renderer-api, input, sound, config, game (pmove prediction)}
host ← {server, client} · apps/web ← host
```

- **Nothing** imports from `apps/*`.
- `sw-renderer` must not import `dom` types; it writes into a handed `ArrayBuffer`.
- `voodoo` is a post-process + sampling policy, not a second renderer.

---

## 4. Conventions (do not deviate)

- **Coordinates:** Quake's. `+X` forward, `+Y` left, `+Z` up. 1 unit ≈ 1 inch. Angles in degrees,
  `[pitch, yaw, roll]`, pitch **positive = down**.
- **Time:** server ticks at 10 Hz (`0.1s`), client renders uncapped and interpolates. `level.time`
  is a float of seconds; never use wall-clock in game logic.
- **Texture mapping:** `u = dot(p, texinfo.s)/scale + s_off` in *texels*. Lightmap luxels are every
  **16 texels**. Keep the `LUXEL = 16` constant in `@q2/math`.
- **Colour:** software path never leaves 8-bit until resolve. Voodoo path rasters
  authoritatively to RGB565 + window-Z (16-bit depth) planes and scanout
  reconstructs from that target (matched `2x2sub+2x2box` by default; `vd_16bit=0`
  is an RGB888 debug bypass). No path uses floats per channel in the inner loop.
- **Naming:** keep id's names (`R_DrawSurface`, `SV_LinkEdict`, `PM_StepSlideMove`,
  `cl.frame`, `pmove_t`) so the C source stays greppable.
- **Modules:** `export`ed symbols only; no default exports. `.ts` only, no handwritten `.d.ts`.
- **No classes in hot paths.** Classes fine for owners of state (`Renderer`, `Host`, `Game`).
- **Errors:** `Com_Error(level, msg)` from `@q2/config`, never raw `throw` in engine code.

---

## 5. Package contracts (frozen — changing one needs a `major` changeset + §5 update in same PR)

```ts
// @q2/renderer-api
export interface Entity {
  model: ModelHandle;
  origin: Vec3; angles: Vec3;
  frame: number; skin: TextureHandle;
  /** RF_DEPTHHACK: alias backend scales stored 1/z by 3 (eye-anchored viewmodel). */
  depthHack?: boolean;
  /** RF_FRAMELERP previous frame (explosion smoothing): alias backend lerps oldframe -> frame. */
  oldframe?: number;
  /** RF_FRAMELERP blend 0..1 (1 = fully oldframe). Defaults to 0; clamped. */
  backlerp?: number;
  /** Translucency 0..1 (1 = opaque): screen-door fade for explosions. */
  alpha?: number;
}
export interface Refresh {
  init(fb: Framebuffer): void;
  beginFrame(): void;
  renderView(view: RefDef, world: WorldModel, entities: Entity[]): FrameStats;
  endFrame(): void;              // resolve: palette expand, or dither+postfilter
  setPalette(p: Uint8Array): void;
  registerModel(m: Model): ModelHandle;
  registerSkin(name: string): TextureHandle;
}

export interface Framebuffer {
  width: number; height: number;
  color: Uint32Array;    // 0xAABBGGRR, what gets blitted
  index?: Uint8Array;    // present only for the software path
  depth: Float32Array;   // 1/z
}

export interface RefDef {
  origin: Vec3; angles: Vec3; fovX: number; time: number;
  lightStyles: Float32Array; // 256 styles, 0..2
}
```

```ts
// @q2/sw-renderer
export interface RasterBackend {          // lets us swap TS → WASM → workers
  drawSpans(list: SpanList, tex: Texture, light: LightBlock): void;
}
```

```ts
// @q2/formats
export function parseBSP38(buf: ArrayBuffer): Bsp38;
export function parseWAL(buf: ArrayBuffer): Wal;      // 4 mip levels of palette indices
export function parseMD2(buf: ArrayBuffer): Md2;      // frames, st coords, glcmds ignored
export function parsePCX(buf: ArrayBuffer): Pcx;      // used for colormap.pcx + pics
```

```ts
// @q2/bsp
export function traceBox(world: Bsp38, start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, mask: number): Trace;
export function pointLeaf(world: Bsp38, p: Vec3): number;
export function clusterPVS(world: Bsp38, cluster: number): Uint8Array;
```

---

## 6. Renderer + pipeline pointers (normative detail lives in docs)

- Software inner loop, span subdivision, surface cache, edge/sort rules: `docs/renderers.md`.
- Voodoo3 fidelity checklist and the 12 `vd_*` cvars: `docs/renderers.md`.
- BSP lumps, cooking (`.q2pkg`), caching, devroom fallback: `docs/data-pipeline.md`.
- Perf rules (typed arrays only, 16.16 fixed point, zero alloc/frame, branch-on-span):
  `docs/process.md` ("Feasibility").

---

## 7. Task engine — how to work a pasted task list

A task card looks like this (same shape for §8 cards and any list pasted in-session):

```
### M7.1 — Web app shell
owns: `apps/web`
depends: M6.1
status: ready            # ready | in-progress(@agent) | review | done
done-when:
- [ ] 60 fps at 640×480 software on the bench machine
```

Rules for **any** card, whether from §8 or pasted in:

1. One agent per package at a time. `owns:` is a lock — never edit another card's packages.
   Cross-package fix allowed **only** for the single-sim rule (`docs/lessons.md`): a
   `packages/server` behaviour fix must ship its `apps/web` driver wiring in the same PR.
2. Interfaces first: new cross-package type goes to `@q2/renderer-api` or `@q2/config`
   in a **separate tiny PR** that only adds types.
3. Never disable a test, never `// @ts-expect-error`, never `any` in exported signatures.
4. If unfinished: feature-flag it off in `@q2/config`, keep `main` green, add a
   `### TODO(<card>)` note under the card.
5. Commit style: `feat(sw-renderer): span subdivision (M3.1)`.
6. Perf-affecting change: before/after bench line in PR body + row in `docs/perf-ledger.md`.
7. Gameplay behaviour card (`packages/game`, `packages/server`, `apps/web` gameplay):
   `done` requires `apps/web/src/base1-gate.test.ts` green on that PR (real base1 lump,
   real tick loop, asserts on rendered/submitted state). Unit tests alone do not close it.
8. Every `packages/**` PR ships a changeset. CI fails without one.
9. Independent workstreams run as parallel subagents (one writer per package, disjoint
    `owns:` — never two writers in one package). The integrator dispatches them with the
    §7 card + §§1–6 context; each lane returns changed files, test/bench evidence, and
    suggested changeset text, and does NOT commit. The integrator runs `yarn verify` +
    bench on the merged tree, writes the changesets + ledger rows, ticks the boxes, and
    commits. Full protocol: `docs/process.md` §12.
10. Pasted lists are authoritative for the session: `status: ready` = eligible,
    `depends:` must be `done` before starting, update `status`/`done-when` in place.

Spawn prompt: read BRAIN.md §§1–7 + the card; modify only `owns:`; follow §4–§5 exactly —
if a contract must change, stop and report. Finish with `yarn verify` + bench output,
changeset, ticked boxes.

Commands: `yarn dev` · `yarn verify` (= typecheck+lint+test+build, the gate) ·
`yarn golden -u` · `yarn bench` · `yarn changeset` · `yarn cook ~/q2/pak0.pak`.
Full tooling + turbo tasks + risks + glossary: `docs/process.md`.

---

## 8. Active tasks (everything else is DONE — see `docs/tasks-archive.md`)

### Performance follow-through — authoritative queue after review of `4631ca2` (2026-10-28)

These cards supersede stale performance completion claims below and in `TASK.md`.
Existing RGB-authoritative rendering, true band subranges, shared ESM/CJS config,
RGB-first preparation and exact model/gun worker rasterization must be preserved.
The recorded 48.84 ms Node combat frame is NOT a controlled commit speedup or
browser acceptance. No new final-code browser soak has established 60 FPS.

Execution contract for this queue:
- The integrator continuously selects eligible cards, delegates independent work to
  subagents under §7, integrates, validates and commits, then picks the next card.
  Do not stop after infrastructure, tests, a partial speedup, or one completed card.
  No pushing. Preserve unrelated user changes. Subagents do not commit.
- `ready` means unclaimed; ALL dependencies must be done before implementation.
  A package has only one writer, including when multiple ready cards name it.
  Integrator owns BRAIN.md, shared tracking, ledger and changesets; workers report
  evidence to the integrator instead of editing shared tracking concurrently.
  Assign/transfer ownership explicitly; ownership is not an external blocker.
- Agree interfaces before dependent work; apply §5/§7 contract rules. A card owning
  several packages may be split into disjoint subagent assignments with one owner
  per package. Coordinate interface changes before parallel implementation.
- Every card records four separate outcomes: implementation / correctness /
  performance measurement / target acceptance, each with evidence or explicit N/A.
  `done` requires every applicable done-when box and evidence links/commands.
  Unit-test success is not proof of production wiring, race safety or speed.
- Keep these cards and completion evidence here until PERF-NEXT-8 is done; then
  archive together. Do not erase an unresolved checkbox by moving/rewording it.
- Benchmarks run sequentially on a quiet machine. No lower resolution, disabled
  effects/entities, changed goldens hiding differences, GPU replacement, relaxed
  budgets, or mock-only production proof. Preserve full-RGBA and depth/coverage.
- A failed performance gate is a failure, never success “by design”. If acceptance
  fails, reopen/add a concrete optimization card and continue the profile/change/
  compare loop. Only a genuine external blocker permits stopping: record the exact
  missing resource, attempted remedies and dependent cards left open. Slow code,
  package ownership and unfinished integration are not external blockers.

### PERF-NEXT-1 — Establish reproducible baseline and evidence storage
owns: `tools/bench`, `packages/testkit`
depends: none
status: done(@integrator 2026-10-28)
done-when:
- [x] Capture baseline at `4631ca2` (or explicitly identify any newer starting tree) before implementation benchmarks; use separate checkout/build outputs without disturbing user changes.
- [x] Save reproducible commands, commit/build identity, assets, machine/browser versions, fidelity cvars, warmup/reps, load and raw results in durable evidence referenced by the ledger (not only disposable /tmp paths).
- [x] Measure matched 640×480 software/Voodoo workloads: stationary, deterministic moving camera, combat with real viewmodel; serial and 1/3/7 workers. Measure whole production frames, full-channel output hashes and fallbacks. 320×240 is diagnostic only.
- [x] Record browser baseline separately from Node and distinguish software/headless compositing from hardware-backed browser conditions. Do not infer commit gains from old unmatched ledger rows.
completion (four outcomes):
- implementation: `tools/bench` durable-evidence core (`src/evidence.ts`: manifests + raw blobs, provenance, browser-soak importer w/ compositor validation) + `packages/testkit` baseline harness (`bench-workloads.ts`, `frame-evidence.ts`, `provenance.ts`, `browser-evidence.ts`); disjoint lanes, no renderer/contract changes.
- correctness: `yarn verify` 76/76 green, `deps:check` 535 edges ok, base1-gate 23/23 + voodoo-regression 4/4 green; pooled≡serial full-RGBA all swept configs + odd-dims + dead-pool fallback, 0 fallbacks, exec proven; no goldens updated, budgets NOT relaxed.
- performance measurement: Node `node-compare` (640 sw-fixed-serial 21.49ms, rgb-fixed-serial 129.91ms, rgb-combat-pooled-7 50.98ms; moving rgb combat w7 101.0ms) + `node-accept` gates A 20.48 / B 123.59 / C 50.35 (FAIL budget by design, parity PASS); browser fresh-boot 640×480 Chromium 156 SwiftShader (hw=false): voodoo 14.46fps / software 18.42fps presented.
- target acceptance: N/A (this card establishes the baseline; targets gated by PERF-NEXT-6/7). Starting tree 53f7070 explicitly identified — engine code == 4631ca2 (`git diff 4631ca2 -- packages/sw-renderer packages/voodoo packages/config packages/renderer-api apps/web` empty); harness-only delta.
evidence: `tools/bench/evidence/node-compare-53f7070-2026-10-28T22-52-47.manifest.json`, `node-accept-53f7070-2026-10-28T22-54-52.manifest.json`, `browser-soak-53f7070-voodoo-640x480.manifest.json`, `browser-soak-53f7070-software-640x480.manifest.json` (+ ledger rows 2026-10-28 PERF-NEXT-1). Changeset: `.changeset/testkit-baseline-harness.md` (bench is changeset-ignored).
follow-ups for later cards (not this card): browser-soak importer resolves relative manifest paths against the workspace cwd (used absolute-ish repo paths; consider resolving against repoRoot); same-second raw-file stamp collision (worked around with explicit names; consider renderer-tagged default names); testkit combat gun frame 4 vs bench fixedEntities frame 0 + vd_lodbias -0.35 vs reassessed 0 (align both when the profile moves — PERF-NEXT-4/6).

### PERF-NEXT-2 — Make recovery safe against genuinely live writers
owns: `packages/sw-renderer`, `apps/web`
depends: PERF-NEXT-1
status: done(@integrator 2026-10-28)
done-when:
- [x] Node recovery cannot mutate/reuse shared output until old workers provably cannot write. Current `void worker.terminate()` is not a completion fence. Cover both sync and async paths; use an acknowledged stop, completed termination or isolated replacement buffers as appropriate.
- [x] Browser recovery stops/isolates writers BEFORE restoring or replaying shared planes; remove the current restore-before-quarantine ordering. Handle timeout, disposal, rejected dispatch and stale completion messages.
- [x] Distinguish staging refusal, failure before writes and partial execution; preserve world, inline foreground, blend order and exactly-once alpha/additive contributions. Checkpoint allocation failure must select a correct fallback before dispatch, not best-effort replay over partial writes.
- [x] Add deterministic adversarial tests with a REAL worker continuing writes during timeout/recovery, not only scripted workers that have already stopped. Compare RGB565, depth, coverage and full RGBA to serial, including translucent/additive geometry, main-band completion, capacity refusal and the next frame.
- [x] Retain existing parity/recovery tests; demonstrate no hang, late mutation or shared-buffer reuse race. Measure successful-path overhead, not just recovery latency.
completion (four outcomes):
- implementation: Node `quarantineWorkers` fence (shutdown signal + replacement-SAB isolation + epoch bump + terminate) + `quarantineWorkersAsync` bounded join + `readoptQuarantinedPlanes`; browser isolate-before-restore (removed restore-before-quarantine at `flushRGBFrameAsync`), epoch, exit-ack handshake, refused-before-dispatch checkpoint failures. Integrator extras: exit-ack baseline fix (stale exits can't satisfy the join), disposed vocabulary precision (pre- vs mid-flight).
- correctness: `yarn verify` 76/76, `deps:check` 539 edges ok, base1-gate 23/23 + voodoo-regression 4/4; retained suites green (rgbRecovery 12, fgTris 6, fgSpans 5, browser-lane 19, pool/diag/scanout/worker-rgb/render-async); new adversarial Node 3 + browser 8 tests (REAL writers, RGB565/depth/coverage/full-RGBA vs serial, translucent+additive, capacity refusal, next frame).
- performance measurement: post-change `bench:accept` A 20.45 (base 20.48), B 126.76 (base 123.59, noise, hashes identical), C 50.39 (base 50.35); parity/exec PASS; success-path overhead zero by construction (fence off the hot path) ±0.2ms noise; browser 15.4KB/checkpoint-kick (640×480: 1.536MB) reported as PERF-NEXT-3 input.
- target acceptance: N/A (safety card; targets gated by PERF-NEXT-6/7). Budget gates still FAIL by design.
evidence: `tools/bench/evidence/node-accept-ea4fa40-2026-10-28T23-34-43.manifest.json` (+ ledger PERF-NEXT-2 row). Changeset: `.changeset/sw-renderer-live-writer-recovery.md` (web ignored).
residual (not this card): Node indexed sync/async timeout paths never had recovery (no terminate/quarantine — legacy 30s wedged-pool scenario, unchanged); all RGB + browser raster/RGB paths fenced. Feeds PERF-NEXT-6.

### PERF-NEXT-3 — Remove per-kick browser checkpoint allocation churn
owns: `apps/web`
depends: PERF-NEXT-2
status: done(@integrator 2026-10-28)
done-when:
- [x] Reuse appropriately sized checkpoint storage across successful kicks/frames if checkpoints remain necessary; separate invalidating snapshot contents from freeing storage. Handle resize/disposal without retaining unbounded buffers.
- [x] Measure copied/allocated bytes per kick and frame. Current three planes total 1,536,000 bytes per kick at 640×480, up to 6,144,000 bytes across world plus three nonempty foreground kicks; successful kicks currently discard storage.
- [x] Evaluate whether retained replay makes some checkpoints unnecessary, or dirty ranges reduce copies. Keep only reductions preserving PERF-NEXT-2 guarantees; do not remove recovery safety to improve benchmarks.
- [x] Verify no steady-state checkpoint allocation per kick and bounded memory during resize/soak; publish controlled browser whole-frame and allocation/GC before/after results.
completion (four outcomes):
- implementation: pooled checkpoint spare (`rgbSnapValid` validity flag; `discardSnapshot` invalidates, `freeSnapshot` on dispose only; lazy first-kick alloc; `checkpointStats()` observability); checkpoints retained (load-bearing), copies stay full-frame, dirty ranges rejected with seeded-background divergence evidence.
- correctness: `yarn verify` 76/76, base1-gate 23/23 + voodoo-regression 4/4; new `checkpoint-pool.test.ts` 4/4; PERF-NEXT-2 adversarial suites preserved (recovery-live-writer 8/8, browser-lane 19, pool-diag 9, scanout-async 2, worker-rgb 8, render-async 4).
- performance measurement: 1 alloc/pool lifetime, 0/kick (was 3 allocs + 1.536MB copy/kick @640×480); controlled browser A/B (base b8951f4 worktree vs head, sequential, 60s+warmup, SwiftShader): base 13.90fps/heap+2.24MB vs head 14.52fps/heap−4.25MB — no regression, heap bounded both legs.
- target acceptance: N/A (churn card; targets gated by PERF-NEXT-6/7).
evidence: `tools/bench/evidence/pn3-ab-base-b8951f4.json` + `pn3-ab-head.json` (+ ledger PERF-NEXT-3 row). No changeset (web ignored).

### PERF-NEXT-4 — Wire real worker execution timing end to end
owns: `packages/sw-renderer`, `apps/web`, `packages/testkit`, `tools/bench`
depends: PERF-NEXT-2
status: done(@integrator 2026-10-29)
done-when:
- [x] Measure execution inside the PRODUCTION worker loop for world, foreground, resolve and scanout jobs; publish duration plus frame/sequence/job/band identity and actual work counts. Current production completion messages omit execMs although mocks send it.
- [x] Wire Node and browser consumers, renderer/test hooks and benchmark/browser reports. Distinguish worker compute, calling-thread band execution and caller dispatch-to-completion latency; never subtract unrelated time origins.
- [x] Add integration tests through the real built Node worker and real browser worker entry points; require finite measured durations for executed jobs and correct identity. A test accepting null or supplying synthetic execMs does not close this card.
- [x] Instrument geometry/material/staging, worker raster, barriers/idle, scanout, presentation/scheduling and material GC; reconcile per-frame timing without summing independent medians. Attribute every foreground flush, including the placed pass.
- [x] Detailed timing can be disabled; run acceptance with it disabled. Publish initial actual critical-path/imbalance measurements to drive PERF-NEXT-6.
completion (four outcomes):
- implementation: loop measures + posts finite execMs (all 4 job kinds) + CTL_EXEC shared slot for sync harvest; Node lastWorkerExec/testBandExecStats (frame accumulation, string job labels); browser entry stamp + clock forward, DiagSnapshot straggler fields, KickTiming ledger, testBandExecStats, __q2stats timing; testkit parsers/imbalance/kill-switch/collectors; bench attribution + acceptance disable. Integrator unification: string job labels at source (loop was numeric vs browser/testkit strings); Node testBandExecStats hook; sync harvester (slot clear/mark/ingest); per-kick group report; stale acceptance note; reverted stray root .gitignore evidence exclusion.
- correctness: package suites green in isolation (testkit 99, sw-renderer 328+8 new sync, web 225 incl. 10 new worker-timing, bench 8); new tests: sw-renderer 6 async + 2 sync (real threads, no synthetics), web 10 (real bundled entry), testkit 14 (real built Node worker + hash equality); base1-gate 23/23 + voodoo-regression 4/4; pooled≡serial hashes identical; no goldens changed, budgets NOT relaxed.
- performance measurement: detail-enabled `node-compare-...00-50-29` publishes compute[] end to end: world RGB med 14.98/max 24.37 (band3), empty FG kick s47 ~0.01, FG s48 3.49/4.16, resolve 0.43 flat, scanout 4.91/5.17, fenceIdle 0.00; disabled-accept C 53.67 vs detail frame 53.88 (timing cost: noise). Disabled-vs-enabled planes bit-identical (lane A/B).
- target acceptance: N/A (instrumentation card; targets gated by PERF-NEXT-6/7). Budget gates still FAIL by design.
evidence: `tools/bench/evidence/node-accept-ed8470a-2026-10-29T00-32-20.manifest.json` (disabled), `node-compare-ed8470a-2026-10-29T00-47-25.manifest.json` (first end-to-end publish), `node-compare-ed8470a-2026-10-29T00-50-29.manifest.json` (per-kick groups → PERF-NEXT-6 input) + ledger PERF-NEXT-4 row. Changesets: `.changeset/sw-renderer-worker-timing.md` + `.changeset/testkit-worker-timing.md` (bench/web ignored).
residuals: (1) parallel-turbo load flakes in timing-sensitive tests (fg-recovery 5s-timeout, fg-counters) — green in isolation/sequentially every time, reproduced at clean base; (2) Node indexed sync/async timeout paths still legacy (PERF-NEXT-2 residual, unchanged).

### PERF-NEXT-5 — Correct browser worker/main-thread attribution
owns: `packages/sw-renderer`, `apps/web`, `packages/testkit`, `tools/bench`
depends: PERF-NEXT-4
status: done(@integrator 2026-10-29)
done-when:
- [x] Browser results return workerSpans/workerPixels/workerTris separately from combined totals, matching Node semantics; absent fields imply the calling-thread band ran inline (never report it as worker-completed).
- [x] Audit every primitive class (alias/viewmodel, alpha spans, sprites, particles, beams): prepared/staged, actually completed, main-band, inline and replayed work have explicit units. Unavailable attribution is unknown, not worker-completed.
- [x] Test a nonempty main band and worker bands with actual execution, staged-but-failed jobs, serial viewmodel and fallback. Combined totals reconcile; failure/replay is not reported as successful worker execution.
- [x] Update browser stats, bench output and docs consistently. Real-browser viewmodel execution is demonstrated with corrected counters, not inferred from staged alpha batches or fake worker messages.
completion (four outcomes):
- implementation: sw-renderer pool main*/worker* split + UNKNOWN→main mapping + particle/per-class inline fixes + new counters; browser pool tally split + Q2Stats/StageReport + fgDetail; testkit fg-attribution taxonomy/reader/reconcile/format; bench worker/main/combined rows + reconcile warnings + diff void-on-misattribute.
- correctness: `yarn verify` 76/76; new tests sw-renderer 7/7 + web 5/5 + testkit 12/12 + bench 7/7 (real threads/entries, no synthetics); base1-gate 23/23 + voodoo-regression 4/4; Q2_PAK viewmodel proof (worker gun tris, cross-lane reconcile); pooled≡serial hashes unchanged; budgets NOT relaxed.
- performance measurement: counters ride along (no raster change); disabled-accept A 22.61 / B 129.54 / C ~50.5 (FAIL by design, noise band vs baselines 20.48/123.59/50.35).
- target acceptance: N/A (attribution card; targets gated by PERF-NEXT-6/7).
evidence: `tools/bench/evidence/node-accept-13eeb85-2026-10-29T01-26-58.manifest.json` (+ ledger PERF-NEXT-5 row). Changesets: `.changeset/sw-renderer-fg-attribution.md` + `.changeset/testkit-fg-attribution.md` (bench/web ignored).
residuals: see PERF-NEXT-9 (recovery double-replay divergence) + parallel-turbo load-flake pattern (known).

### PERF-NEXT-9 — Fix frame-level recovery double-replay divergence
owns: `packages/sw-renderer`
depends: PERF-NEXT-5
status: ready
starting-points: `frame.ts: recoverRetainedRGB/recoverInlineRGBAll callers`; Lane C probe `/tmp/opencode/probe-fgc.mjs` (frame-level, timeoutMs:1 storm, devroom 640×480)
done-when:
- [ ] Commit a deterministic fail-before reproduction (no /tmp-only scripts): timeout-storm frame-level recovery yields full-RGBA-identical output to serial across N frames, or fails for the documented reason. Intermittent-only proof does not close this card.
- [ ] Root-cause the double recovery (signature: `recoveryCount>=2`, `fgkicks==0`, pixels `65cf87ee`/`3c53a7c5` vs serial `f674729a`): two recovery replays overlap or a second replay runs over already-replayed planes (blends/seed applied twice?). Fix, don't mask: exactly-once alpha/additive must hold on every recovery path, including back-to-back timeouts.
- [ ] Prove the fix under the storm loop (≥30 frames, zero divergence) AND the normal suites (`yarn verify`, base1-gate, voodoo-regression, all recovery/adversarial tests). Counter truthfulness must survive the fix (reconcile clean on every path).
- [ ] Evaluate Lane A's pool-level translucent-combo report (unreproduced in 2 integrator probes — likely same root at frame level): either reproduce + fix or document why it cannot occur, with a test pinning the conclusion.
- [ ] Publish before/after storm-loop results + a ledger row. `main` stays green throughout (feature-flag in `@q2/config` if the fix can't land cleanly at once).

### PERF-NEXT-6 — Optimize measured barriers and remaining frame cost
owns: `packages/sw-renderer`, `packages/voodoo`, `apps/web`, `tools/bench`, `packages/testkit`
depends: PERF-NEXT-3, PERF-NEXT-4, PERF-NEXT-5
status: ready
starting-points: `frame.ts: drawForeground/drawForegroundAsync`; RGB span kernels, geometry emission, band scheduling, scanout
done-when:
- [ ] Audit all three foreground flush barriers now that exact model/gun work is staged. Combine ordered jobs where safe; retain only barriers required by actual inline/dependency boundaries. Measure kick overhead and tiny jobs; test mixed primitive order and fallback after any batching change.
- [ ] Use measured per-band compute and idle time to select worker counts/band scheduling; do not assume seven workers is fastest. Compare production browser and Node with the same workload.
- [ ] Profile and implement the largest remaining whole-frame reductions in RGB span shading/lightmaps, material/descriptor preparation, geometry emission, load imbalance and scanout. Historical GEO ~12–13 ms / DRAW ~34 ms / scanout ~7 ms are leads, not a current additive frame breakdown.
- [ ] For each candidate record hotspot evidence, changed behavior, controlled before/after whole-frame results and fidelity checks. Reject/revert measured regressions; keep investigating the next hotspot. Exact arithmetic parallelism and justified CPU WASM/SIMD remain available; no GPU substitution.
- [ ] Achieve the existing ≤16 ms production-frame gate at 640×480 under the defined acceptance workloads/settings, with software unchanged or improved and normal Voodoo fidelity. Gate failure keeps this card open and triggers another concrete optimization iteration.

### PERF-NEXT-7 — Final-code browser acceptance and stability
owns: `apps/web`, `tools/bench`, `packages/testkit`
depends: PERF-NEXT-6
status: ready
done-when:
- [ ] Run a NEW ≥5-minute final-code 640×480 browser soak covering stationary, movement and combat with real assets/viewmodel, for software and Voodoo. Old 15 FPS stationary captures and Node tests cannot close this card.
- [ ] Report completed-frame cadence (not rAF callbacks), frame-time percentiles, exact resolution/cvars, worker count, corrected execution/replay/fallback counters, timing diagnostics, memory/cache trends and screenshots/visual checks. Preserve raw samples and workload intervals.
- [ ] Demonstrate ≥60 presented FPS for each representative workload with normal fidelity and no sustained decline, missing entities, incomplete frames or unexplained fallback. Distinguish browser/compositor conditions and include simulation, HUD and presentation costs.
- [ ] If any target fails, leave acceptance open, feed the measured bottleneck back into PERF-NEXT-6 (or a new owned card), implement and repeat final-code validation. No “all tasks done except performance” completion.

### PERF-NEXT-8 — Integrate, reconcile evidence and commit completion
owns: `BRAIN.md`, `docs`, `.changeset` (integrator only)
depends: PERF-NEXT-1, PERF-NEXT-2, PERF-NEXT-3, PERF-NEXT-4, PERF-NEXT-5, PERF-NEXT-6, PERF-NEXT-7
status: ready
done-when:
- [ ] Integrator reviews all code and runs yarn verify, yarn deps:check, real-asset base1-gate, Voodoo regression, focused recovery/model/counter/timing/config suites and full-frame acceptance on the integrated tree. Missing assets/skipped required gates are unresolved, not passes.
- [ ] Preserve full-RGBA, RGB565/depth/coverage parity, odd dimensions, 0/1/3/7-worker coverage and software goldens; investigate every difference rather than repinning unexplained output.
- [ ] Correct stale PERF-FINISH-A/B/C and TASK completion claims against actual evidence; link baseline/final artifacts and commands in docs/perf-ledger.md. Separate historical data from current measurements and implementation from accepted targets.
- [ ] Add valid changesets for changed publishable packages and commit intended changes autonomously without pushing; intermediate validated commits are encouraged, do not wait for this final card to commit all work.
- [ ] Publish commit hashes, changesets, per-card completion matrix, controlled before/after results, live-writer recovery proof, actual worker timing/counter evidence and final browser acceptance. Every review finding is resolved; unresolved items remain visible and cannot be archived as done.


```
### PERF-FINISH-A — RGB-authoritative Voodoo + worker ranges + foreground (renderer)
owns: `packages/sw-renderer`
depends: VOODOO-REPAIR-2
status: review
done-when:
- [x] Voodoo production skips duplicate classic world+foreground by default with counters proving skipped work; software unchanged
- [x] Indexed+RGB workers use true per-band span subranges (R_ORDERED/D_ORDERED staged proofs; workers binary-search owned subranges via lowerBoundRow, CTL_SCAN inspected counts; unordered/legacy full-scan fallback identical); 0/1/3/7 scaling measured
- [x] Foreground span-based work (deferred TRANS alpha, world sprites) stages into the same JOB_RGB kick after world batches with ordering + serial fallback (fgStaged/fgKicks proof, pooled≡serial full-RGBA). UPDATE at 4631ca2: exact alias/model/gun triangles and remaining foreground span classes now stage for workers. Recovery synchronization, production diagnostics and performance acceptance remain open in PERF-NEXT-2 through PERF-NEXT-7; do not reimplement model parallelism
- [x] Emitter order-validation scans removed at proven sites; GEO re-profiled
```

```
### PERF-FINISH-B — browser critical path + acceptance (web)
owns: `apps/web`
depends: VOODOO-REPAIR-2
status: in-progress
done-when:
- [x] Per-stage browser critical path measured (sim/GEO/staging/raster/fg/scanout/blit/gaps), worker wait per band, fallback counts
- [x] Representative 640x480 presented-FPS + 5-min soak on new code: 640×480 fresh-boot voodoo pooled-7 soak 66 samples/326s, presented med 15.00fps (cadence 15.00/s, monotonic), fgStaged 10/fgWorker 10/fgKicks 1 every sample (production FG worker proof NEW), rgbStaged 2071/kicks 1/inline 0, 0 fallbacks/quarantine, canvas row-reads full-frame paint, start/end screenshots pixel-identical (see perf-ledger). 60fps acceptance still OPEN (need ≤16.7ms; at ~4× over)
```

```
### PERF-FINISH-C — trustworthy measurement (bench/testkit)
owns: `tools/bench`, `packages/testkit`
depends: VOODOO-REPAIR-2
status: review
done-when:
- [x] Quiet-machine parent-vs-HEAD controlled before/after, identical workloads (a7b753b vs HEAD, same command, sequential — see perf-ledger)
- [x] Full-RGBA serial-vs-pooled raster+display parity (blue/alpha fail), RGB execution proof, Voodoo fallback races, fixed translucent test, sky+world same skip policy
- [x] ESM/CJS config-store unified (`packages/config` globalThis singleton owner): writes through ESM visible through CJS and vice versa (built-artifact probes 19/19 both load orders, worker isolation preserved); test flipped from pinned isolation to shared; renderer selection + fidelity reach the real graph
```

```
### VOODOO-REPAIR-2 — black areas on MD2s (barrels, enemies, bolts, gun fringe)
owns: `packages/sw-renderer` (gates: `packages/sw-renderer` unit pins; release: `apps/web` voodoo-regression)
depends: VOODOO-REPAIR
status: done
done-when:
- [x] reproduced entity-isolated with real base1 assets (soldier yaw90 @120u 29.4% pure-black pre-resolve px, bolt @40u 64.5%; software keeps texture in both)
- [x] root cause fixed, not masked: MD2 skins are ~40% black gutter (barrel 37%, soldier 47% idx-127) poisoning coarse box-filter mips (software alias never mips — affine L0); fillPerspTriRGB honored clamp addressing (was hardcoded repeat). FOLLOW-UP 2026-10-27: the -3.3 content bias masked a second sampling bug (full-res UVs into shrunken mips — green-where-red repro); all samplers now scale UVs into the picked mip (`1/(1<<lvl)`) and the bias is reassessed to `ALIAS_LOD_BIAS_DELTA = 0` (alias tracks shared `vd_lodbias`; post-fix soldier @120u 1.7% black, v_blast @40u 4.4%, flat across bias sweep; gates `rgbMipUV.test.ts` 4 fail-before, `rgbAliasSkin.test.ts` re-pinned, devroom RGB `206e1dad` → `68b22dea`)
- [x] post-fix at/below software black levels post-resolve, all measured classes: soldier 0.4%, barrel 0.1%, bolt 0.0%, infantry 1.2%, gunner 0.2%, corpse 0.2%, explode 0.0%, all 3 viewmodels ≤0.3%; before/after crops reviewed (backs mottled again, bolt glows red-orange)
- [x] regression gates: `rgbAliasSkin.test.ts` (4 fail-before: clamp tap, delta value, delta-vs-shared sampling, frame RGB/software parity); devroom RGB re-pinned with cause (`436fe0c5` → `206e1dad`, critter px only, index `58e0ecf1` unchanged). FOLLOW-UP 2026-10-27: `rgbMipUV.test.ts` (alias+world UV-scale, 4 fail-before), chain-eviction ownership `rgbChainEvict.test.ts` (retained==accounted<=16MiB), voodoo-regression gun-present-vs-absent diff asserts (fails with viewmodel stripped)
- [x] `yarn verify` green (76 tasks) + Q2_PAK voodoo-regression gate 4/4 + changeset
- [ ] OPEN (not this card): real-Voodoo3 capture review (M4.1) is the only oracle that can confirm distant-minification brightness vs strict-GL; current trade (finer alias mips = sharper/software-like at range) is documented in ALIAS_LOD_BIAS_DELTA
```

```
### VOODOO-REPAIR — Voodoo regression repair (black gun, missing geometry, FPS decline)
owns: `packages/sw-renderer`, `apps/web` (investigated with no changes needed: `packages/voodoo`, `packages/config`, `packages/testkit` — see note)
depends: M7.1
status: done
done-when:
- [x] real base1 assets + real browser boot/render loop reproduce all three symptoms at 640x480 (viewmodel, entities, HUD, resolve/display stages; software-vs-voodoo same-scene)
- [x] gun renders textured (not black, no holes): depth-bias UV invariant (ordinary + near-clipped), per-tri LOD in texels/pixel, opaque alias materials (255 masked for sprites only, per ref_soft/ref_gl audit)
- [x] no missing geometry: world/entities/sprites/tracers/HUD verified through resolveDisplay (strict pre-scanout HUD); tracer bdy typo fixed
- [x] no progressive FPS decline: shared per-texture RGB chains + surgical dlight invalidation (serial-free keys); soak shows stable frame times, bounded caches, zero evictions (stationary, combat, frozen scene)
- [x] regression gates: `rgbAliasDepth.test.ts` (5 fail-before), `rgbSustain.test.ts` (3 fail-before), `apps/web/src/voodoo-regression.test.ts` (Q2_PAK release gate, fails clearly when assets unavailable); devroom RGB pins re-pinned with documented cause (`a9988ff4` → `436fe0c5`, index `58e0ecf1` unchanged)
- [x] `yarn verify` green + changeset; perf-ledger rows appended (honest shortfalls, no relaxed thresholds)
- [ ] OPEN (not this card): serial RGB spanfill ~6Mpx/s needs pooled/worker composition to reach the ≤16ms budget (~152ms/frame serial at spawn-north overdraw 3.1); headless-Chromium soak done 2026-10-27 (voodoo ~13.5fps/no-decline over 326s, software ~50.5fps — SwiftShader, serial path) but real-GPU + BrowserBandPool worker-count sweep stay with M7.1; human Voodoo3-capture review stays with M4.1
```

> VOODOO-REPAIR note (2026-10-27): all three symptoms reproduced and fixed.
> Voodoo/config/testkit packages needed NO changes: the vd_* cvars and
> resolve/scanout/upload/sampler policies are sound (audit vs prog guide +
> MiniGL behavior); the testkit empty-entity baseline is harness-level by
> design (entity coverage lives in the web release gate). Root causes were
> all in `packages/sw-renderer`'s RGB backend + `apps/web` gates:
> (1) drawAliasInstanceRGB stored iz*depthScale in v.iz but u*iz/v*iz
> unscaled (plus the same in the near-clipped path) → viewmodel UVs /3
> (black gun); per-tri LOD multiplied texels by width/height again (→
> coarsest mip, dark edge-repeat averages); index-255 holes punched in
> MD2 skins that ref_soft/ref_gl draw opaque (only sprites/HUD honor 255).
> (2) tracer bdy copy-paste (`pby` for `pbx`) misplaced RGB beams off-axis.
> (3) per-surface full-chain expansion thrashed the 4MB RGBLightCache (0%
> hits, ~445ms/frame + MBs of garbage/frame) and invalidateAll-on-serial
> rebuilt everything per combat frame; now per-texture shared chains
> (71 chains/2.39MB base1, VRAM-like 16MB LRU) + surgical union
> invalidation with serial-free keys (~152ms stationary, ~340ms combat
> frameAsync, drift <5%, zero evictions). Evidence: before/after
> screenshots (`software.png` vs `voodoo_prefix.png` vs `post_vd.png`),
> soaks, and fail-before gates listed above. No frozen §5 contract changed;
> software rendering bit-identical (all goldens green).
```

```
### M7.1 — Web app shell (tail: fps sign-off)
owns: `apps/web`
depends: M6.1
status: in-progress
done-when:
- [x] pak drop zone → IndexedDB → boot; progress UI; renderer switcher; cvar panel
- [x] real `SoftwareRenderer` behind `vid_renderer`, rAF loop, pointer-lock input, HUD
- [x] devroom explorable, base1 bootable from dropped pak (play-tested headlessly incl. Q2_PAK run)
- [x] browser async tick + pooled loop + blit fast path wired (see tasks-archive M7.1 note)
- [ ] 60 fps at 640×480 software on a real browser page (needs live COOP/COEP fps meter + worker-count sweep; headless pooled closes ~15ms but no in-browser measurement yet)
```

```
### M4.1 — Voodoo resolve chain (tail: human review)
owns: `packages/voodoo`
depends: M3.1
status: done (code) / review (sign-off pending)
done-when:
- [x] gamma → dither → RGB565 → 2×2 post filter, all cvar-switchable
- [ ] side-by-side screenshots vs a reference Voodoo3 capture reviewed by a human (harness landed in `packages/testkit`; NO real capture yet — see docs/tasks-archive.md M4.1 note)
```

```
### DEMO1 — determinism harness (tail)
owns: `packages/testkit`
depends: M7.1
status: ready
done-when:
- [x] procedural devroom + fixed cameras wired (`demoFallbackViews`, devroom cameras)
- [ ] real `demo1.dm2` playback (needs retail assets; Q2_PAK-gated; `demo1.dm2` itself never ships — recording of retail `maps/base1`)
```

Budgets: software ≤16 ms/frame @640×480, voodoo ≤16 ms/frame @640×480, startup ≤2.5 s
cached-pak to first frame. Full history: `docs/perf-ledger.md`.
Gameplay rules (single-sim, play-verified gate, open/closed lists): `docs/lessons.md`.

> Historical TASK.md remediation report at 4631ca2 (not current sign-off): claimed items 1–4 complete; focused correctness suites passed (`yarn verify` 76/76, pooled≡serial full-RGBA, recovery alpha-once, next-frame); performance measured (Node pooled-7 rgb combat 48.84ms, serial 122ms, sw 20.3ms @640×480; budgets NOT met); target acceptance OPEN (5-min 640×480 browser soak on final code + 60fps/16ms). Review found live-writer recovery gaps, per-kick browser checkpoint allocations, absent production worker timings and incorrect browser worker/main attribution; PERF-NEXT-1–8 above govern completion. See `docs/perf-ledger.md` 2026-10-28 TASK row and changesets `sw-renderer-fg-recovery-tris`, `testkit-fg-recovery-harness`.

---

## 9. Doc index

| Doc | What |
| --- | --- |
| `docs/architecture.md` | repo layout, sources/licences, dependency rules |
| `docs/renderers.md` | software port map + inner loop, Voodoo3 checklist + cvars |
| `docs/data-pipeline.md` | BSP/WAL/PCX/MD2 flow, cooker, cache, devroom fallback |
| `docs/process.md` | feasibility ladder, turbo/changesets/testing, subagent protocol, risks, C→TS glossary |
| `docs/perf-ledger.md` | budgets + every bench row |
| `docs/lessons.md` | dual-sim root cause, single-sim rule, base1 play-verified gate, closed/open lists |
| `docs/tasks-archive.md` | all DONE cards (M0–M9 + TODOs) with lane reports |
