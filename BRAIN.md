# BRAIN.md — Q2TS: Quake II in TypeScript (software renderer + Voodoo 3 3000 look)

> **This file is the single source of truth for every coding agent that touches this repo.**
> Read it fully before writing code. Never invent architecture that contradicts it.
> If reality and this file disagree, fix the file in the same PR that fixes reality.
>
> Detail docs live in `docs/`: `architecture.md`, `renderers.md`, `data-pipeline.md`,
> `process.md`, `perf-ledger.md`, `lessons.md`, `tasks-archive.md`.
> This file states the rules and the *active* work. Everything else is a pointer.
> **Current direction (2026-10-30, reviewed at `71b58bd`): preserve the
> user-confirmed sky fixes and landed display-fit repair. Water seams, asset UI,
> elevator, infantry collision, restart-free settings and legacy Voodoo removal
> remain open. Investigate the newly reported blaster offset; display alignment
> does not prove projectile accuracy. CPU optimization stays paused. §8 is the
> only active queue; old TASK.md and historical reviews do not override it.**

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
- **Preserves the "3dfx Voodoo 3 3000" look in WebGL2.** Retire the legacy
  CPU Voodoo mode under RELEASE-8; shared policy is not automatically obsolete. Emulation of `ref_gl`-on-Voodoo3: RGB565 + 4×4
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
- `voodoo` currently supplies post-process/sampling policy. RELEASE-8 retires the
  legacy CPU Voodoo execution mode; audit shared consumers before deleting modules.
  The map below describes the current tree, not the completed retirement.
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
  Software path never leaves 8-bit until resolve. Until RELEASE-8 retires it,
  the legacy CPU Voodoo path rasters
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

### Current status and execution rules

Reviewed source/history at `71b58bd`; user feedback dated 2026-10-30 is the
current visual verdict. This review checks the latest diff and local original
Quake II source; browser captures, gameplay reproduction and full verify were not
rerun. Focused test results are recorded below; do not treat them as visual acceptance.

Review validation: `yarn workspace web exec vitest run src/aim-hud.test.ts`
passed 6 tests, with 1 real-asset eye-ray test skipped because Q2_PAK was not
set for this run. This did not fire a blaster or rerun the browser display probe.

- **Done: GPU-FOLLOW-3A.** Skybox black borders and sky missing through windows
  are fixed, explicitly confirmed by the user. `73c3076` isolates sky faces and
  removes the selected-sky-ref background gate. Details and implementation
  evidence are in `docs/tasks-archive.md`; preserve cold boot/switch/restore and
  opaque occlusion. The older `d934fdc` review is historical, not current status.
- **Open:** water seams, elevator, infantry collision, asset UI,
  restart-free settings, startup sizing and legacy retirement. The user retested
  and still reports water/UI/elevator/collision/restart/retirement issues after
  `71b58bd`; startup sizing remains open from earlier feedback. Wall climbing remains unconfirmed;
  infantry fire still needs an actual source/visual audit. Water motion is satisfactory.
- **Implemented, acceptance pending:** volume and devroom changes landed; this
  feedback does not confirm or reject them. Preserve the work, verify outstanding
  acceptance criteria, and do not conflate implementation with visual sign-off.
- **Review:** `docs/review-2c4c162.md` records unsupported completion claims and
  test limitations at the earlier commit. RELEASE-4/5 remain reopened.
- **Latest implementation: RELEASE-3 display fit.** `71b58bd` fits both canvases
  to the stage, preserves framebuffer aspect, adds resize cleanup and replaces
  the earlier ineffective tests. Its archived headless-browser report covers
  display rectangles/HUD at a 1500×1000 viewport, DPR 1. Preserve that bounded
  repair; do not generalize it to all devices or actual projectile accuracy.
  `aim-hud.test.ts` traces from the eye along the view axis, not a fired bolt.
  New blaster feedback belongs to RELEASE-3B below. No new confirmation of
  earlier startup, wall-climb or infantry-fire issues was supplied; retain them.
- **Latest scope:** no water shader, server/game behavior, game-asset HUD,
  resolution-reboot policy or renderer-selection removal changed in `71b58bd`.
  The six repeated unresolved reports remain open, not regressions proved fixed
  by this display-only commit. Elapsed effort and test counts are not acceptance evidence.
- **Backend terminology:** the user's “new webgpu renderer” refers to the new
  GPU path; this tree implements WebGL2 (`packages/webgl-renderer`), not WebGPU.
- **Acceptance remains open:** the latest archived sky report records a failing
  full verify (PROOF-4 far/mip and a foreground-recovery timeout under suite load).
  The latest RELEASE-3 archive also reports web suite 423/427 and two
  `sound → config` dependency violations; these are reported results, not fresh
  passes or failures from this review. Resolve the dependency violations under
  RELEASE-1/FOLLOW-7. Earlier reports also mention PROOF-3 CDP timeout. Reproduce current failures
  under FOLLOW-5 rather than assuming every historical failure remains current.

Priority: RELEASE-4/5 (gameplay), RELEASE-3B (blaster aim), GPU-FOLLOW-3B (water), RELEASE-6 (asset UI), RELEASE-7
(settings/startup), RELEASE-8 (legacy retirement), then FOLLOW-5/6 → FOLLOW-7. Verify RELEASE-1/2 independently.
Never tick a behavior/visual box from a constant assertion, formula mirror, stub
call count or pre-existing unrelated test. Require a reproduction of the actual
symptom, an effective negative control, and evidence from the repaired production
path. Keep implementation, automated correctness and user verdict separate.
Independent cards may proceed with disjoint package ownership; this priority
is not an artificial dependency chain. Claim one card before implementation.
Keep GPU experimental until integrated acceptance; preserve software/Node support.
Expensive browser tests and benchmarks run sequentially. Intermediate targeted
passes are not full-suite acceptance. Archive completed cards with evidence;
commit validated implementation increments with changesets, no push.

### RELEASE-2 — Render the asset-free demo room in WebGL2
owns: `apps/web`, `packages/webgl-renderer`, `packages/testkit`
depends: none
status: review
starting-points: `play.ts: bootPlay/applyRendererCvar`, `devroom.ts`, `devroom-fallback.test.ts`
done-when:
- [ ] Verify the landed procedural palette/world/model replay on GPU cold boot, switching and restoration without a pak. The former palette guard was addressed in `2c4c162`; do not repeat the obsolete diagnosis or rebuild the implementation. Diagnose any remaining failure from rendered evidence.
- [ ] Real-WebGL pixels show expected room geometry/materials and entities without pak assets; verify cold boot, map switch, renderer switch and context restoration. Check that an intentional missing-world control fails; nonblack clear color alone is insufficient.

### RELEASE-6 — Use game assets for HUD, F1 and level completion
owns: `apps/web`, `packages/client`, `packages/formats`, `packages/testkit`
depends: none
status: in-progress(@opencode)
starting-points: `play.ts: drawPlayHud`, browser F1/menu handler, pak `pics/` and original client screen/layout code
review-finding: current HUD draws text such as `hp` and weapon classname; completion uses a custom text block.
lane-2026-10-30 (@opencode): formats+client lane DONE + testkit lane DONE (35/35, 79-pic manifest noted vs 78 task text); apps/web drawPlayHud replacement + F1 wiring still open for integrator.
done-when:
- [ ] Compare startup/F1 help, health/ammo/armor and level-completion/intermission layout with original game assets and layout semantics. Inventory required pak pictures/fonts and stats; implement the appropriate asset-based screens instead of placeholder styling.
- [ ] Preserve readable asset-free devroom fallback and distinguish game HUD from optional FPS/position diagnostics. Verify real assets, values, transparency, scaling and placement at 640×480 and 1024×768, including death and level completion.

### RELEASE-7 — Change display settings without restarting; stable startup size
owns: `apps/web`, `packages/host`, `packages/webgl-renderer`, `packages/testkit`
depends: RELEASE-3
status: in-progress(@opencode)
review-findings: `dom.ts: REBOOT_CVARS` includes resolution; renderer already uses `applyRendererCvar` hot-swap; `resizeGpuBackend` exists.
lane-2026-10-30 (@opencode): host lane DONE (20/20, sim-preserving resize + snapshot/dispose hooks); apps/web + webgl-renderer + testkit wiring still open.
done-when:
- [ ] Wire resolution changes through coordinated framebuffer/viewport/HUD resizing without rebuilding the game simulation. Preserve map, position, health, enemies, elapsed time and audio. Confirm renderer changes also preserve these states in the actual menu; diagnose any remaining restart rather than adding another switch path.
- [ ] Reserve the selected/persisted display dimensions before async asset loading. Show a correctly sized loading surface immediately, then present the first valid frame without a small black box or layout jump. Cover cold cache, cached pak, no pak and failed GPU initialization.
- [ ] Verify repeated resize/switch, context loss/restore, resource disposal and no duplicate loop/listeners; keep explicit restart behavior only for settings that genuinely require a new level (e.g. map/skill).

### RELEASE-8 — Retire the old CPU Voodoo renderer
owns: `apps/web`, `packages/config`, `packages/renderer-api`, `packages/sw-renderer`, `packages/voodoo`, `packages/host`, `packages/testkit`, `tools/bench`, `tools/asset-cooker`, `docs`, root workspace configuration
depends: RELEASE-2, RELEASE-7
status: ready
inventory-2026-10-30 (@opencode, read-only): static `@q2/voodoo` importers are `apps/web/play.ts` (resolve/scanout), `render-workers.ts` (SAB/scanout), `tools/bench` rgb legs, dynamic `testkit` resolve reference — all retire-execution; policy tables already duplicated in `webgl-renderer/appearance.ts` (keep/relocate, not blind delete). `webgl-renderer→sw-renderer` imports are all KEEP (MiniWorld/camera/alias front-end). `vid_renderer` vocab `software|voodoo|webgl2-experimental` → `software|webgl2-experimental` with persisted-`voodoo`→`software` warned fallback; `vd_*` stay (WebGL uniforms). Workers/bench/tests RGB legs retire, software+GPU goldens preserved; frozen majors required for `config`+`renderer-api` (+`sw-renderer`/`voodoo`/`webgl-renderer` if APIs change). Ordered plan: selection vocab → web CPU-resolve removal → sw-renderer RGB strip → bench legs → voodoo package decision → obsolete tests → contracts/docs/gates.
done-when:
- [ ] Remove the legacy CPU Voodoo execution mode and its menu/config selection in favor of WebGL2; map persisted legacy selections deliberately and report unsupported-GPU fallback accurately. Preserve the software reference/Node renderer and the WebGL Voodoo appearance.
- [ ] Inventory shared imports first: WebGL currently reuses `sw-renderer` helpers and `voodoo` is a policy/post-process package. Remove obsolete mode-specific code, workers, controls and benchmarks; retain or relocate shared utilities. Do not delete whole packages blindly or silently turn WebGL into a CPU path.
- [ ] Update frozen contracts with required major changesets if changed, dependency rules, scripts, docs and tests. Retire obsolete tests explicitly while preserving meaningful software goldens and GPU parity/lifecycle coverage. Update §§2–6 to describe the final architecture, not a planned deletion.

### GPU-FOLLOW-3B — Remove visible water tile boundaries
owns: `packages/webgl-renderer`, `apps/web`, `packages/testkit`
depends: GPU-FOLLOW-3A
status: in-progress(@opencode)
starting-points: `shaders.ts: FS_LIT/voodooWarp`, world UVs, diffuse mip generation/sampling
review-finding: `2c4c162` only added formula tests; no shader repair or sampled-pixel diagnostic landed. LOD/lightmap cause is unproven; the prior TODO claiming diagnostics established it is withdrawn.
lane-2026-10-30 (@opencode): webgl-renderer lane DONE + testkit lane DONE (water-pixels real-WebGL: wrap 0.0207 < anim 4x, overlap 0.43, det 0); apps/web stationary/moving captures still open for integrator.
done-when:
- [ ] Preserve the now-satisfactory water motion. Reproduce the remaining visible tile seams in real water; record map, camera, material, time and crops. Distinguish texture-repeat boundaries from BSP-face/lightmap seams and warp/LOD/precision effects using fixed-time, fixed-LOD and diffuse/unlit diagnostics. Compare adjacent faces at the same world position and the CPU/reference appearance. Record the demonstrated cause before changing the algorithm.
- [ ] Fix that cause while retaining animated turbulence, intended texture scale, repeat behavior and transparent/depth ordering. Check original versus resized texture dimensions and derivatives if implicated. Do not mask seams by disabling warp, lighting or mipmapping, or globally blurring water.
- [ ] Add a regression that fails for the observed defect: actual sampled pixels across repeat/face boundaries at multiple times, plus real-page stationary/moving water captures. Include combined turbulent/translucent material coverage. Formula-string/mirror checks alone are insufficient.
- [ ] Run relevant gates and record `yarn verify` outcome (known suite failures belong to FOLLOW-5); add changesets and commit separately. Confirm sky and prior wall/enemy/barrel repairs remain intact.

### GPU-FOLLOW-5 — Refresh final fidelity evidence
owns: `packages/webgl-renderer`, `packages/testkit`, `tools/bench`, `docs`
depends: GPU-FOLLOW-3B, RELEASE-2, RELEASE-3, RELEASE-3B, RELEASE-4, RELEASE-5, RELEASE-6, RELEASE-7, RELEASE-8
status: ready
done-when:
- [ ] Reproduce current full-suite failures, including reported foreground-recovery pool and PROOF-3 CDP timeouts under load: reproduce and isolate resource/process contention, run expensive browser tests with controlled concurrency, and retain bounded useful timeouts. Do not skip the gate or merely inflate timeouts without evidence.
- [ ] Capture matched F0/F1/F2 CPU/GPU scene/time/cvars on the repaired renderer; report new full-frame and region/material metrics. Repair the degenerate PROOF-4 far/mip fixture so it actually exercises its intended content. Keep historical pre-repair failures labelled historical.
- [ ] Strengthen lifecycle image evidence with matched deterministic before/after scene crops or independent world/model/skin expectations and negative controls removing a required asset. Existing nonblack, gun-region brightness and distinct-color counts can pass with missing textures; do not label them semantic proof.
- [ ] Investigate remaining unexplained UV/lighting/depth/transparency differences and add meaningful regression fixtures. Include repaired sky/water. Do not loosen assertions or replace goldens to conceal defects.
- [ ] Meet the existing fidelity contract, or present concrete side-by-sides and a precise proposed contract for user approval. Record automated and user verdicts separately; no implicit approval of threshold changes.

### GPU-FOLLOW-6 — Verify complete gameplay on a visible display
owns: `apps/web`, `tools/bench`, `packages/testkit`, `docs`
depends: GPU-FOLLOW-3B, RELEASE-2, RELEASE-3, RELEASE-3B, RELEASE-4, RELEASE-5, RELEASE-6, RELEASE-7, RELEASE-8
status: ready
done-when:
- [ ] Run a hardware-backed visible-browser 640×480 soak ≥5 minutes: stationary, multi-room/PVS movement, doors/lifts and combat, real viewmodel/effects and sky/water. Record actual route state, visible captures, bounded resources and absence of silent fallback.
- [ ] Record immutable build, device, refresh/vsync, raw timing samples, p50/p95/p99 and dropped frames. Check median work ≤16 ms, ≥59 FPS at nominal 60 Hz and p95 interval ≤20 ms separately. Describe completed/display cadence evidence accurately; submitted frames/headless throughput are not scanout proof. Use matched settings for CPU/GPU comparisons.
- [ ] Measure cached-pak-to-first-frame against the existing ≤2.5 s startup requirement; report separately from steady-state FPS.
- [ ] If a performance gate fails, make at most the remaining one measured optimization iteration, then report. If display access is absent, record the exact missing prerequisite and leave that gate blocked; continue independent work.

### GPU-FOLLOW-7 — Final integrated acceptance
owns: `BRAIN.md`, `docs`, `.changeset`, `apps/web`, `packages/config` (integrator)
depends: RELEASE-1 through RELEASE-8, RELEASE-3B, GPU-FOLLOW-3B, GPU-FOLLOW-5, GPU-FOLLOW-6
status: ready
done-when:
- [ ] Resolve the reported `sound → config` dependency-rule violations without weakening the dependency gate; run `yarn verify`, `yarn deps:check`, real-asset base1, retained software and GPU lifecycle/image/gameplay gates after legacy retirement on the integrated result. Record skipped coverage and preserve CPU/Node support.
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
| `docs/gpu-review-d934fdc-sky-water.md` | Historical pre-73c3076 sky/water review; sky findings superseded, water still open |
| `docs/gpu-review-2026-10-29-lifecycle-sky-water.md` | Dirty-file ownership, review evidence, diagnoses and superseded queue |
| `docs/review-2c4c162.md` | Earlier review at 2c4c162: reopened acceptance, ineffective tests and unresolved user reports |
| `docs/tasks-archive.md` | all DONE cards (M0–M9 + TODOs) with lane reports |
