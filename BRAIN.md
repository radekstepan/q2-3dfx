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
- **Preserves the "3dfx Voodoo 3 3000" look in WebGL2.** Emulation of `ref_gl`-on-Voodoo3: RGB565 + 4×4
  ordered dither, 2×2 "22-bit" post filter, bilinear, mip LOD with mip-dithering, 64-entry
  table fog, LOD bias, 256×256 max texture size, 16-bit depth, ~1.3 Glide gamma lift.
  Full checklist + cvars: `docs/renderers.md`. RGB mip sampling scales UVs
  into the picked level (`1/(1<<lvl)`); alias tracks the shared `vd_lodbias`
  (`ALIAS_LOD_BIAS_DELTA = 0`). Canonical appearance policy lives in
  `packages/webgl-renderer/src/appearance.ts`; `packages/voodoo` is a pure
  policy library (quantise, gammaLUT, Bayer/dither, mip/LOD, fog, upload);
  no CPU frame-execution path remains.
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
math ← formats ← bsp ← sw-renderer ← renderer-api ← host
{renderer-api, sw-renderer, bsp, math, config} ← webgl-renderer (GPU boundary impl; + formats test-only)
voodoo (pure policy: quantise/gamma/Bayer/mip/fog/upload; no frame execution, no renderer imports)
filesystem ← formats · game ← {math, bsp, config} · server ← {game, bsp}
client ← {renderer-api, input, sound, config, game (pmove prediction)}
host ← {server, client} · apps/web ← host
```

- **Nothing** imports from `apps/*`.
- `sw-renderer` must not import `dom` types; it writes into a handed `ArrayBuffer`. Indexed software renderer only (spans, surface cache, alias/sprite/particle/tracer draws, banded SAB workers, async render); no RGB/scanout execution.
- `voodoo` is a pure policy library (see above); WebGL2 appearance is canonical in `webgl-renderer/appearance.ts`. Renderer selection vocab is `software | webgl2-experimental` (persisted `voodoo` migrates to `software` with warning); `vd_*` remain as WebGL live-uniforms.
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
- **Colour:** the following exact rules apply to the CPU reference. The
  WebGL2 backend follows the explicit fidelity contract in GPU-PROOF-1, with reviewed
  tolerances for documented rasterization differences.
  Software path never leaves 8-bit indexed until display (palette expand).
  WebGL2 appearance (RGB565 + 4x4 dither + 2x2 postfilter, gamma ~1.3) is applied
  in the GPU appearance pass (`webgl-renderer/appearance.ts`). No path uses floats per channel in the inner loop.
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

### GPU-FOLLOW-6 — Verify complete gameplay on a visible display
owns: `apps/web`, `tools/bench`, `packages/testkit`, `docs`
depends: GPU-FOLLOW-3B, RELEASE-2, RELEASE-3, RELEASE-3B, RELEASE-4, RELEASE-5, RELEASE-6, RELEASE-7, RELEASE-8
status: blocked
gate-record 2026-10-31: DISPLAY_ABSENT — X.Org :0.0 + Vega 11 DRI, headed Chromium real hardware GL, but 0 connected monitors (virtual 2560x1440, no mode/refresh/vsync); no scanout path, displayed-frame claims VOID. Headed hardware-GL route smoke (webgl2-experimental, no fallback, cells 1→3→4, +1148 submitted, uploads 1) reported as headroom-only; startup 3.05s harness-path exceeds 2.5s pending display-backed rerun. Full ≥5min soak + all boxes BLOCKED pending vsync-measurable display. See docs/gpu-follow-6-gate-record.md.
done-when:
- [ ] Run a hardware-backed visible-browser 640×480 soak ≥5 minutes: stationary, multi-room/PVS movement, doors/lifts and combat, real viewmodel/effects and sky/water. Record actual route state, visible captures, bounded resources and absence of silent fallback.
- [ ] Record immutable build, device, refresh/vsync, raw timing samples, p50/p95/p99 and dropped frames. Check median work ≤16 ms, ≥59 FPS at nominal 60 Hz and p95 interval ≤20 ms separately. Describe completed/display cadence evidence accurately; submitted frames/headless throughput are not scanout proof. Use matched settings for CPU/GPU comparisons.
- [ ] Measure cached-pak-to-first-frame against the existing ≤2.5 s startup requirement; report separately from steady-state FPS.
- [ ] If a performance gate fails, make at most the remaining one measured optimization iteration, then report. If display access is absent, record the exact missing prerequisite and leave that gate blocked; continue independent work.

### GPU-FOLLOW-7 — Final integrated acceptance
owns: `BRAIN.md`, `docs`, `.changeset`, `apps/web`, `packages/config` (integrator)
depends: RELEASE-1 through RELEASE-8, RELEASE-3B, GPU-FOLLOW-3B, GPU-FOLLOW-5, GPU-FOLLOW-6
status: blocked
blockers-2026-10-31: FOLLOW-6 BLOCKED (DISPLAY_ABSENT, no vsync/scanout — gate record docs/gpu-follow-6-gate-record.md); FOLLOW-5 fidelity contract proposal (tone-normalized 0.02 gate) NEEDS USER APPROVAL, NOT applied — automated F1 FAIL stands loud. `sound→config` resolved (deps:check 676 ok); full verify 78/80 with 4 known load/contention failures recorded. GPU stays experimental (`software | webgl2-experimental`, persisted `voodoo`→`software` warned); no default rollout. All implementation lanes committed below; no push.
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
