# BRAIN.md — Q2TS: Quake II in TypeScript (software renderer + Voodoo 3 3000 look)

> **This file is the single source of truth for every coding agent that touches this repo.**
> Read it fully before writing code. Never invent architecture that contradicts it.
> If reality and this file disagree, fix the file in the same PR that fixes reality.
>
> Detail docs live in `docs/`: `architecture.md`, `renderers.md`, `data-pipeline.md`,
> `process.md`, `perf-ledger.md`, `lessons.md`, `tasks-archive.md`.
> This file states the rules and the *active* work. Everything else is a pointer.
> **Current direction (2026-10-29, reviewed at `ff2e232`): user reports none of
> the outstanding visual issues fixed. Sky asset replay is committed, but is
> not visual acceptance; fix skybox borders, black sky through windows and water
> seams next. Active order: 3A → 3B → 5/6 → 7. CPU optimization stays paused.
> Only §8 contains the active task queue.**

---

## 1. TL;DR

1. `corepack enable && yarn install`
2. `yarn turbo run build typecheck test --filter=...[origin/main]`
3. Follow the current-direction queue first. Pick **one** task card from §8 (or from a task list pasted in-session) that is `status: ready` or resume the `status: review` card.
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
  edge/span rasteriser, affine alias models. Preserve this CPU-only reference/fallback;
  do not require a GPU for its Node tests or change its goldens for the new backend.
- **Renders in "3dfx Voodoo 3 3000" mode.** Emulation of `ref_gl`-on-Voodoo3: RGB565 + 4×4
  ordered dither, 2×2 "22-bit" post filter, bilinear, mip LOD with mip-dithering, 64-entry
  table fog, LOD bias, 256×256 max texture size, 16-bit depth, ~1.3 Glide gamma lift.
  Full checklist + cvars: `docs/renderers.md`. RGB mip sampling scales UVs
  into the picked level (`1/(1<<lvl)`); alias tracks the shared `vd_lodbias`
  (`ALIAS_LOD_BIAS_DELTA = 0`, reassessed post-fix — see VOODOO-REPAIR-2 note).
- **Adds a WebGL2 browser backend** for fast gameplay with a reviewed Voodoo-style
  appearance. This is an authorized independent renderer, not a replacement for
  the software reference. Cross-backend pixel identity is not assumed (see §8).
- **Targets ≥60 fps at 640×480 in a hardware-backed browser** through the new
  backend. Preserve Node headless software testing. CPU performance goals remain
  recorded, but are not prerequisites for the WebGL2 proof.
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
├─ packages/math filesystem formats bsp sw-renderer voodoo webgl-renderer renderer-api
│            game server client sound input host testkit config
└─ tools/asset-cooker bench
```

Dependency flow (enforced by `yarn deps:check`):

```
math ← formats ← bsp ← {sw-renderer, voodoo} ← renderer-api ← host
{renderer-api, sw-renderer, bsp, math, config} ← webgl-renderer (GPU boundary impl, PROOF-2; + formats test-only)
filesystem ← formats · game ← {math, bsp, config} · server ← {game, bsp}
client ← {renderer-api, input, sound, config, game (pmove prediction)}
host ← {server, client} · apps/web ← host
```

- **Nothing** imports from `apps/*`.
- `sw-renderer` must not import `dom` types; it writes into a handed `ArrayBuffer`.
- `voodoo` is a post-process + sampling policy, not a second renderer.
- Implemented (GPU-PROOF-2): `packages/webgl-renderer`, a browser GPU renderer with an
  explicit injected WebGL2 context; only this backend and browser integration may
  depend on browser graphics types. Keep sw-renderer/math/bsp/renderer-api DOM-free.
  Reuses lower-level assets/math/BSP and shared policy (MiniWorld + camera helpers
  from `@q2/sw-renderer`, PVS from `@q2/bsp`); never imports apps/web.
  Dependency rule: `{renderer-api, sw-renderer, bsp, math, config} ← webgl-renderer`,
  enforced by `yarn deps:check`.

---

## 4. Conventions (do not deviate)

- **Coordinates:** Quake's. `+X` forward, `+Y` left, `+Z` up. 1 unit ≈ 1 inch. Angles in degrees,
  `[pitch, yaw, roll]`, pitch **positive = down**.
- **Time:** server ticks at 10 Hz (`0.1s`), client renders uncapped and interpolates. `level.time`
  is a float of seconds; never use wall-clock in game logic.
- **Texture mapping:** `u = dot(p, texinfo.s)/scale + s_off` in *texels*. Lightmap luxels are every
  **16 texels**. Keep the `LUXEL = 16` constant in `@q2/math`.
- **Colour:** the following exact rules apply to the existing CPU reference. The new
  GPU backend follows the explicit fidelity contract in GPU-PROOF-1, with reviewed
  tolerances for documented rasterization differences.
  Software path never leaves 8-bit until resolve. Voodoo path rasters
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
status: ready            # ready | in-progress(@agent) | review | done | paused | blocked
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
10. `paused` cards are not eligible until explicitly resumed or their card-specific
    authorized activation condition passes; `blocked` cards record
    the concrete missing prerequisite. Never treat either as done.
11. Pasted lists are authoritative for the session: `status: ready` = eligible,
    `depends:` must be `done` before starting, update `status`/`done-when` in place.

Spawn prompt: read BRAIN.md §§1–7 + the card; modify only `owns:`; follow §4–§5 exactly —
if a contract must change, stop and report. Finish with `yarn verify` + bench output,
changeset, ticked boxes.

Commands: `yarn dev` · `yarn verify` (= typecheck+lint+test+build, the gate) ·
`yarn golden -u` · `yarn bench` · `yarn changeset` · `yarn cook ~/q2/pak0.pak`.
Full tooling + turbo tasks + risks + glossary: `docs/process.md`.

---

## 8. Actionable queue

Read `docs/gpu-review-d934fdc-sky-water.md` for current findings and test limits.
Earlier dirty-file ownership and lifecycle reviews are historical. Completed cards/evidence live in
`docs/tasks-archive.md` and `docs/performance-gpu-history-2026-10-29.md`.
This queue supersedes old task lists and the archived snapshot.

### Review checkpoint — 2026-10-29, `ff2e232`

**User verdict: the reported issues remain unresolved.** No sky/water card is
closed by the latest commit. This checkpoint is a source/history review, not a
new browser reproduction or a test pass; no browser capture, benchmark or full
`yarn verify` was run for this documentation update.

- `ff2e232` adds CPU recovery/disposal coverage, foreground diagnostics and a
  moving-camera benchmark probe. The diff from `d934fdc` through `ff2e232`
  contains no changes to `packages/webgl-renderer`, the web sky test or the
  testkit sky validator. Those changes do not repair the reported GPU visuals.
- **Skybox borders — open (3A).** `renderer.ts: skyStripFor` still uploads an
  unguttered six-face vertical strip with whole-texture clamp;
  `entities.ts: emitSkyBoxFaces` still reuses CPU `skyUvOnFace` bounds. Face-local
  bilinear isolation remains unaddressed. Its contribution to the specific
  reported border must still be established with rendered pixels.
- **Black sky through windows — open (3A).** `drawScene` still gates the sky
  texture on selected world sky refs (`hasSky`). The failing camera's PVS,
  background draw and glass depth/blend behavior still need pixel-backed
  diagnosis; the conditional alone is not proof of the cause.
- **Water tile seams — open (3B).** The GPU warp/sampling implementation is
  unchanged. No new seam repair or real-map before/after evidence landed.
  Preserve the water motion the user previously found satisfactory.
- **Visual proof — missing (3A/3B/5).** `gpu-sky.test.ts` still describes stub-GL
  bookkeeping as a “sky-image check.” Asset diversity and draw logs cannot
  establish correct borders, window backgrounds or opaque occlusion.
- **Integrated acceptance — open (5/6/7).** The latest ledger reports verify
  79/80 with the PROOF-4 appearance failure; this is not a green full gate.
  It also reports CPU pooled combat at 50.30 ms, above the 16 ms target, and
  missing final-code five-minute visible-browser evidence. These are historical
  reported results, not measurements rerun here and not GPU display acceptance.
  “FAIL budget by design” in that ledger does not waive the target.

`TASK.md` is the older CPU campaign rooted at `460232d`, not the active queue.
Do not execute it merely because it remains in the tree or because the latest
commit references it. A task list explicitly supplied by the user in a new
session can change priorities under §7; this review does not resume CPU work.
Next eligible implementation is **GPU-FOLLOW-3A**, then 3B, then 5/6, then 7.
Preserve useful landed CPU work without treating it as visual repair. Leave all
acceptance boxes below open until their stated evidence exists.

Execution: 3A → 3B → 5/6 → 7. FOLLOW-4 landed in `dfc58d9`; sky asset replay
landed in `d934fdc`. Preserve both; 3A below is only the remaining sky repair.
Working tree was clean at review start. Treat `review` as resumable
work; claim ownership before editing. One writer per package. Preserve the landed
lifecycle machinery. Commit validated increments with changesets, no push. Archive completed cards
with evidence rather than growing this queue with implementation narratives.
Keep GPU experimental and CPU reference/goldens intact. Stop speculative
optimization; only a measured final gate miss permits the one remaining measured
optimization iteration. Unit/mirror tests and draw counts do not prove visible
correctness. Expensive validation runs sequentially. Known full-suite failures
are assigned to FOLLOW-5 below: record them on intermediate repairs and continue
independent work; never call a failing full run green. Final FOLLOW-7 requires
the integrated gate to pass.

### GPU-FOLLOW-3A — Fix skybox borders and black sky through windows — DONE 2026-10-30
owns: `apps/web`, `packages/webgl-renderer`, `packages/testkit` · depends: GPU-FOLLOW-4 (landed)
status: done (all 5 boxes evidenced; archived in `docs/tasks-archive.md`, commit in this stack)
done-when:
- [x] Reproduce both symptoms in actual rendered pixels: capture an affected skybox edge/corner and a window looking outside, recording map/camera/FOV/cvars. Keep the successful retained-asset boot/switch/restore wiring; do not rebuild it.
- [x] Fix sky-face border sampling. Audit the six-face strip's bilinear footprint and face-local texel-center bounds: whole-texture CLAMP does not isolate adjacent faces, and the reused CPU UV bounds are not half-texel GPU bounds. Use a suitable face-isolated sampling/layout solution. Distinguish atlas bleed, source-art dark pixels, orientation and clipping/fog before attributing the user's black border to one cause. Test edges/corners during yaw/pitch, with filtering on/off; preserve intended artwork and foreground occlusion.
- [x] Fix absent sky through windows. At the failing view log selected sky refs/PVS, whether the sky pass runs, and glass alpha/depth state. Audit the `hasSky` gate (currently no selected sky refs means no background box). Ensure valid exterior background survives transparent windows and relevant visibility transitions, while opaque walls remain opaque. Do not disable PVS, backface culling, depth or transparency globally to hide the issue.
- [x] Add real-WebGL pixel regressions for face-edge isolation and a window with known sky behind it. Include negative controls that introduce a border or omit the background draw, plus opaque occluders. Capture real-map views before/after switch and context restore. Existing asset-statistics and stub 36-index-draw tests remain wiring tests, not image or occlusion proof; correct misleading test/report descriptions.
- [x] Run relevant sky/lifecycle/gameplay gates, record full-verify outcome and any already-assigned FOLLOW-5 failures, add required changesets and commit the bounded fix. Both reported sky defects must have pixel evidence before closing this card.

### GPU-FOLLOW-3B — Remove visible water tile boundaries
owns: `packages/webgl-renderer`, `apps/web`, `packages/testkit`
depends: GPU-FOLLOW-3A
status: ready
starting-points: `shaders.ts: FS_LIT/voodooWarp`, world UVs, diffuse mip generation/sampling
done-when:
- [ ] Preserve the now-satisfactory water motion. Reproduce the remaining visible tile seams in real water; record map, camera, material, time and crops. Distinguish texture-repeat boundaries from BSP-face/lightmap seams and warp/LOD/precision effects using fixed-time, fixed-LOD and diffuse/unlit diagnostics. Compare adjacent faces at the same world position and the CPU/reference appearance. Record the demonstrated cause before changing the algorithm.
- [ ] Fix that cause while retaining animated turbulence, intended texture scale, repeat behavior and transparent/depth ordering. Check original versus resized texture dimensions and derivatives if implicated. Do not mask seams by disabling warp, lighting or mipmapping, or globally blurring water.
- [ ] Add a regression that fails for the observed defect: actual sampled pixels across repeat/face boundaries at multiple times, plus real-page stationary/moving water captures. Include combined turbulent/translucent material coverage. Formula-string/mirror checks alone are insufficient.
- [ ] Run relevant gates and record `yarn verify` outcome (known suite failures belong to FOLLOW-5); add changesets and commit separately. Confirm sky and prior wall/enemy/barrel repairs remain intact.

### GPU-FOLLOW-5 — Refresh final fidelity evidence
owns: `packages/webgl-renderer`, `packages/testkit`, `tools/bench`, `docs`
depends: GPU-FOLLOW-3B
status: ready
done-when:
- [ ] Resolve the reported full-suite PROOF-3 CDP 30-second timeout under load: reproduce and isolate resource/process contention, run expensive browser tests with controlled concurrency, and retain bounded useful timeouts. Do not skip the gate or merely inflate timeouts without evidence.
- [ ] Capture matched F0/F1/F2 CPU/GPU scene/time/cvars on the repaired renderer; report new full-frame and region/material metrics. Repair the degenerate PROOF-4 far/mip fixture so it actually exercises its intended content. Keep historical pre-repair failures labelled historical.
- [ ] Strengthen lifecycle image evidence with matched deterministic before/after scene crops or independent world/model/skin expectations and negative controls removing a required asset. Existing nonblack, gun-region brightness and distinct-color counts can pass with missing textures; do not label them semantic proof.
- [ ] Investigate remaining unexplained UV/lighting/depth/transparency differences and add meaningful regression fixtures. Include repaired sky/water. Do not loosen assertions or replace goldens to conceal defects.
- [ ] Meet the existing fidelity contract, or present concrete side-by-sides and a precise proposed contract for user approval. Record automated and user verdicts separately; no implicit approval of threshold changes.

### GPU-FOLLOW-6 — Verify complete gameplay on a visible display
owns: `apps/web`, `tools/bench`, `packages/testkit`, `docs`
depends: GPU-FOLLOW-3B
status: ready
done-when:
- [ ] Run a hardware-backed visible-browser 640×480 soak ≥5 minutes: stationary, multi-room/PVS movement, doors/lifts and combat, real viewmodel/effects and sky/water. Record actual route state, visible captures, bounded resources and absence of silent fallback.
- [ ] Record immutable build, device, refresh/vsync, raw timing samples, p50/p95/p99 and dropped frames. Check median work ≤16 ms, ≥59 FPS at nominal 60 Hz and p95 interval ≤20 ms separately. Describe completed/display cadence evidence accurately; submitted frames/headless throughput are not scanout proof. Use matched settings for CPU/GPU comparisons.
- [ ] Measure cached-pak-to-first-frame against the existing ≤2.5 s startup requirement; report separately from steady-state FPS.
- [ ] If a performance gate fails, make at most the remaining one measured optimization iteration, then report. If display access is absent, record the exact missing prerequisite and leave that gate blocked; continue independent work.

### GPU-FOLLOW-7 — Final integrated acceptance
owns: `BRAIN.md`, `docs`, `.changeset`, `apps/web`, `packages/config` (integrator)
depends: GPU-FOLLOW-4, GPU-FOLLOW-3A, GPU-FOLLOW-3B, GPU-FOLLOW-5, GPU-FOLLOW-6
status: ready
done-when:
- [ ] Run `yarn verify`, `yarn deps:check`, real-asset base1/voodoo and GPU lifecycle/image/gameplay gates on the integrated result. Record skipped coverage and preserve CPU/Node support.
- [ ] Publish separate implementation, correctness, fidelity and displayed-performance verdicts with commits/artifacts; reconcile contradictory PASS/GO claims in existing reports. Carry forward precise unresolved blockers.
- [ ] Only after all required gates pass, close GPU-EXPAND-1 and decide default rollout with accurate selection/fallback labels. Otherwise keep GPU experimental.
- [ ] Commit validated remaining changes with required changesets, no push; move completed cards to the archive. Keep deferred CPU/hardware-oracle/demo work in the review/history docs, not silently marked complete.

---

## 9. Doc index

| Doc | What |
| --- | --- |
| `docs/architecture.md` | repo layout, sources/licences, dependency rules |
| `docs/renderers.md` | software port map + inner loop, Voodoo3 checklist + cvars |
| `docs/data-pipeline.md` | BSP/WAL/PCX/MD2 flow, cooker, cache, devroom fallback |
| `docs/process.md` | feasibility ladder, turbo/changesets/testing, subagent protocol, risks, C→TS glossary |
| `docs/perf-ledger.md` | budgets + every bench row |
| `docs/gpu-proof-1-contract.md` | GPU-PROOF-1 baseline + fidelity contract (pre-implementation) |
| `docs/gpu-proof-5-report.md` | Historical prototype report; acceptance corrected by FOLLOW-1 |
| `docs/performance-gpu-history-2026-10-29.md` | Archived reviews/cards/evidence, including unresolved deferred work; not an active queue |
| `docs/gpu-follow-1-reconciliation.md` | Corrected interpretation of prototype evidence |
| `docs/lessons.md` | dual-sim root cause, single-sim rule, base1 play-verified gate, closed/open lists |
| `docs/gpu-review-d934fdc-sky-water.md` | Current sky/water findings, evidence limits and prior card snapshot |
| `docs/gpu-review-2026-10-29-lifecycle-sky-water.md` | Dirty-file ownership, review evidence, diagnoses and superseded queue |
| `docs/tasks-archive.md` | all DONE cards (M0–M9 + TODOs) with lane reports |
