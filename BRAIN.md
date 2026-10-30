# BRAIN.md — Q2TS: Quake II in TypeScript (software renderer + Voodoo 3 3000 look)

> **This file is the single source of truth for every coding agent that touches this repo.**
> Read it fully before writing code. Never invent architecture that contradicts it.
> If reality and this file disagree, fix the file in the same PR that fixes reality.
>
> Detail docs live in `docs/`: `architecture.md`, `renderers.md`, `data-pipeline.md`,
> `process.md`, `perf-ledger.md`, `lessons.md`, `tasks-archive.md`.
> This file states the rules and the *active* work. Everything else is a pointer.
> **Current direction (2026-10-29): user reports mostly 60 FPS at 640×480 and
> no visible broken textures/black spots. Finish the in-progress GPU-FOLLOW-2B,
> then the short remaining §8 queue. Preserve gains; CPU optimization stays paused.**

---

## 1. TL;DR

1. `corepack enable && yarn install`
2. `yarn turbo run build typecheck test --filter=...[origin/main]`
3. Follow the current-direction queue first. Pick **one** task card from §8 (or from a task list pasted in-session) that is `status: ready`.
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

## 8. Current state and remaining work

### State as of 2026-10-29

**User validation:** “Major major improvement”; mostly 60 FPS even at 640×480;
no failing textures or black spots observed. Treat those earlier reports as
visually improved, not current known failures. Preserve the gains and regression
fixtures; do not repeat old investigations without new failing evidence.

**Reviewed baseline:** committed `866a553` plus active, uncommitted FOLLOW-2B work.
At review, renderer.ts, shaders.ts, worldMesh.ts and worldMesh.test.ts are being
edited by the implementing LLM. Do not overwrite, revert, duplicate or commit its
unfinished work from another lane. Re-read git status and this queue before claiming
ownership; its implementation/evidence may advance after this snapshot.

| Work | Current disposition |
| --- | --- |
| WebGL scene/backend and appearance prototype | Implemented; retain CPU reference/fallback |
| FOLLOW-0 black CSS overlay/alignment | Done, `4dd7fc0`; page now visibly renders |
| FOLLOW-1 acceptance/reporting corrections | Done, `f05e0ba` + `a53baf4`; retain rejection gates |
| FOLLOW-2 full-map storage/current-view selection | Implemented, `f05e0ba`; remaining live route validation is ONLY FOLLOW-2C |
| FOLLOW-2A model/skin replay and switches | Done, `866a553`; replay retained assets without restarting game |
| FOLLOW-2B textures/lightmaps | Implementation in progress; user sees no failures now; finish evidence/commit |
| Full gameplay coverage, lifecycle and final acceptance | Remaining cards below |

History and full prior evidence: `docs/performance-gpu-history-2026-10-29.md`,
`docs/perf-ledger.md`, `docs/gpu-follow-1-reconciliation.md`. Old “no enemies”,
“black screen”, “frozen spawn geometry” and “clamped walls” diagnoses there are
historical, not instructions to reimplement completed/current repairs.

### Execution rules for the remaining queue

- Continue existing FOLLOW-2B ownership, then 2C → 3 → 4 → 5/6 → 7. FOLLOW-5 and 6
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
status: in-progress (existing implementing LLM; preserve current renderer ownership)
progress-at-review: committed 3467ddd on top of the dirty tree (REPEAT vs CLAMP, unpack state, sampler re-bind, uDebugMode upload, atlasStats/material hooks, lightId-parity fix, stub regression in follow2b.test.ts + worldMesh.test.ts). Typecheck/test/build green for @q2/webgl-renderer (104 passed). Remaining to close: real-GL upload sampling (1/2/3-wide, odd/NPOT, skin chains), same-camera 0/1/2 captures of real walls/skins in the composed page, real-GL sampler/atlas-capacity image regression, and full-map overflow measurement. Do not relitigate the landed wiring; finish with browser evidence.
starting-points: `renderer.ts: uploadTextureLevels/diffuseFor/skinFor`; `worldMesh.ts: pushSurfaceTris/packLightAtlas`; `appearance.ts: voodooSampleMipped`
done-when:
- [ ] Reproduce a failing world-repeat fixture with UVs outside [0,1], including negative UVs and bilinear seams. Give WAL/world materials repeat addressing and skins/sprites/lightmap atlases their intended clamp policy through texture creation and sampling. Preserve correct mip derivatives and resampling UV scale.
- [ ] Set/restore appropriate pixel-unpack state for tightly packed RGB data; exercise 1/2/3-wide, odd-width/NPOT and real skin mip chains in a real WebGL context. Assert no upload GL errors, valid expected mip texels and sampled colors (not only texImage2D arguments).
- [ ] Expand missing/short lightmap fallback to every luxel or represent a deliberate uniform unlit material. Never index beyond a three-byte fallback; test no-light surfaces and atlas overflow. Audit surface lightId mapping and light-style handling against the CPU reference.
- [ ] Fix/test luxel centre placement and bilinear isolation between adjacent atlas tiles (gutters/edge duplication or equivalent). Use contrasting tiles, last-row/column samples and actual map edges to detect dark bleeding.
- [ ] Capture diffuse-only, lightmap-only and final output at the same camera for reported black regions; identify each region's cause. Test actual textured walls/floors and enemy/gun skins in the composed page. No global brightness boost, disabling lighting or changed goldens to hide black spots.
- [ ] Pin sampler-unit isolation during first-use lazy world/skin uploads and mixed world/alias/sprite draws. Assert unit 0 diffuse and unit 1 lightmap bindings at actual draws with a real-GL image regression; no accidental atlas replacement by uploads. Measure full-map atlas capacity/overflow and implement correct handling rather than sampling unrelated atlas-origin pixels.
- [ ] Retain intended genuinely dark texels and documented appearance policy. Report asset warnings and material/texture counts; no silently missing required textures or GL upload errors on the supported route.

### GPU-FOLLOW-2C — Prove live map completeness and close visibility validation
owns: `apps/web`, `packages/webgl-renderer`, `packages/testkit`, `tools/bench`
depends: GPU-FOLLOW-2B
status: ready
done-when:
- [ ] Drive the production page through actual multi-room translation/PVS transitions, a 180-degree turn and opening/closing doors plus a lift. Record camera/cluster changes and mover state; selecting two synthetic views is not a live route.
- [ ] Use independent expectations for named wall/floor/ceiling regions and opaque occlusion (CPU reference or known fixture geometry), plus real composed-page captures. A fresh and reselected GPU renderer agreeing does not prove either one is complete.
- [ ] Prove specific alive enemies/viewmodel and textured surfaces persist through movement and switches; fail on missing required meshes/skins, upload errors or unexplained holes. Preserve the earlier TURN equality test as a narrower regression.
- [ ] Feed semantic content/occlusion results into validateSceneCoverage and tests that reject a scene with an intentionally removed wall/enemy even when frames, uploads and screenshot counts look healthy. Keep helper/type ownership explicit across bench/testkit.
- [ ] Record report-only route timings on the now-complete scene, not a new optimization campaign. Close the remaining FOLLOW-2 validation here only with this evidence (the old card is historical); full final soak remains FOLLOW-6.

### GPU-FOLLOW-3 — Complete live effects and required world appearance
owns: `packages/webgl-renderer`, `apps/web`, `packages/testkit`
depends: GPU-FOLLOW-2C
status: ready
done-when:
- [ ] Inventory actual live producers/consumers for sprites, particles, beams, explosions, lights and model/skin kinds. Connect game events and lifetimes to GPU drawing; rendering synthetic fixtures alone is insufficient. Verify event drains occur in the intended tick order without dropping or double-consuming effects.
- [ ] Classify/order default-alpha beams for their actual blended draw pass; test beam/glass/translucent-alias overlap at changing camera positions.
- [ ] Preserve model-kind metadata (not just the temporary tracer map), sprite animation/size, particle counts/lifetimes and weapon/light timing. Prove real combat event → submitted geometry → visible pixels with tests.
- [ ] Implement base1-required sky and water/warp/transparent behavior; current sky is flat and turbulence unwarped. Test combined turbulent/translucent flags and draw/depth order. Audit remaining cvar behavior and label unsupported choices explicitly.
- [ ] Exercise all supported weapons, enemies, pickups and relevant effects on the live path; no missing-mesh/skin warnings in supported scenes. Keep GPU-resident HUD optional unless measured CPU-overlay cost or correctness requires it.

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
| `docs/tasks-archive.md` | all DONE cards (M0–M9 + TODOs) with lane reports |
