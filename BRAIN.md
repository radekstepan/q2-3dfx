# BRAIN.md — Q2TS: Quake II in TypeScript (software renderer + Voodoo 3 3000 look)

> **This file is the single source of truth for every coding agent that touches this repo.**
> Read it fully before writing code. Never invent architecture that contradicts it.
> If reality and this file disagree, fix the file in the same PR that fixes reality.
>
> Detail docs live in `docs/`: `architecture.md`, `renderers.md`, `data-pipeline.md`,
> `process.md`, `perf-ledger.md`, `lessons.md`, `tasks-archive.md`.
> This file states the rules and the *active* work. Everything else is a pointer.
> **Current direction (2026-11-01, over-door + standing-guard + button-anim
> landed): elevator entry is fixed without side routes (over-door housing,
> genuine-standing finish guard) and secret-button art states are implemented
> (C frame/effects end to end) — both in review awaiting the user's browser
> verdicts. Software underwater warping is user-confirmed correct (source
> parity: eye-under warp is soft-only, GL is tint-only — no code change).
> Preserve landed patrol/tooltip/elevator/button repairs; §8 is the only
> active queue.**

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
  in the GPU appearance pass (`webgl-renderer/appearance.ts`). The CPU reference avoids float-per-channel inner-loop work; GPU shaders use floating-point arithmetic.
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
  /** RF_GLOW: bonus-item pulse (every pre-placed pickup unless ITEM_NO_TOUCH). */
  glow?: boolean;
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

### Review checkpoint and rules

Source/history reviewed at `e11cfe0` on 2026-10-31, plus RELEASE-4 visible-entry
fix 2026-11-01 (this session). This was a source/documentation review; no
browser reproduction or test suite was rerun for the checkpoint itself.
Latest changes: `b1123a4` elevator button relocation/boarding guard, `1f5d982`
patrol arrival wait and live-route checks, `00c5790` underwater audit, `e11cfe0`
custom tooltips, plus this session's render-vs-collision parity (BUTTON_34_SHIFT
145,-48, visual==collision, C 96 reach) and multi-offset visible-doorway gates.
User retest: south-half entries still blocked on the south-gap housing, and the
ground-only aboard guard finished on face leans via contact-rest graze. This
session answers both: BUTTON_34_SHIFT is now [145,0,40] (over-door housing,
out of every walk line, E-use-only) and SV_StandingOn requires the latched
ground link PLUS feet on the live box top PLUS footprint (face leans open
without finishing; boarding still finishes exactly once). RELEASE-16 is
implemented end to end (Mover fx/frame, chain bake, per-tick pick, sw drift
invalidation, WebGL2 range re-sync). Preserve valid increments. Both repair
lanes are in review below awaiting the user's browser verdicts. Software
underwater warp is explicitly confirmed correct; no further software warp
redesign is requested.

Patrol and custom-tooltip cards remain archived with their evidence; omission
from this feedback is not a new visual sign-off. Sky fixes, software support,
legacy Voodoo retirement and recorded FOLLOW-5 approval remain preserved. GPU
stays experimental pending integrated/display acceptance. Display absence does
not block gameplay or button-texture repairs.

Priority: user verdicts on RELEASE-4B + RELEASE-16; RELEASE-15 retains
only the narrower OpenGL comparison uncertainty. Claim one card; use disjoint
ownership for independent work and run expensive validation sequentially.
Actual entry/visual symptoms need production-browser evidence, not a direct
target invocation or synthetic render. Separate implementation, automated
results and user verdicts.

### RELEASE-4B — Over-door housing + genuine-standing finish guard
owns: `packages/server`, `apps/web`, `packages/testkit`
depends: none
status: review (automated green; awaiting user browser verdict)
user-contract: walk onto the waiting/open final elevator at ANY doorway
offset, then press its button to finish and show frozen F1 completion stats.
Boarding alone never finishes; face leans never finish.
lane-report: south-gap housing blocked south-half entries at head height;
ground-only aboard guard finished on face leans (contact rest parks the body
overlapping the clip, latching its num with deck feet). Fix: over-door
housing [145,0,40] (1u off the shut face, west of the slider plane, 8u above
every hull, E-use-only, both E-use endpoints west of the sliders so LOS never
crosses them); SV_StandingOn (ground link + feet within 4u of the live box
top + hull-margin footprint, latched with the ground every tick and E-use).
No noclip/teleport/collision bypass; C 96 reach; first-reason-wins.
evidence: server base1 33/33 (rest/pressed housing boxes, PART B + repeat
E-use, boarding walk with no phantom obstruction, traversal E-use endgame,
face-lean no-finish + boarding finish); web release-4-trace 6/6 (box-4
Y 1492/1536/1568: visual==collision, face stop owns the plug mover, E-use
opens with t4 and no finish, board ge==plug origin 112 no finish, aboard
E-use finishes 'lift' once, F1 frozen; box-3b outside-press guard intact),
elevator 1/1, elevator-ride-gate 1/1, base1-gate 24/24; typecheck clean.
Y 1488.0-exact grazes the open *32 edge plane and reads contact — C-identical
1/32-rest + DIST_EPSILON corner behavior, unholdable in play; the gate uses
Y 1492 (still inside the old housing's band, so the regression stands).
done-when:
- [x] Reproduce the blockage from the visible doorway and fix the
blocking state/geometry/activation locally, preserving waiting and valid
mover/button fixes.
- [x] Normal entry onto the platform at multiple offsets → reachable button
press → exactly one finished state with F1 time/kills/secrets/goals; no
hidden preliminary contact or aim point; outside/unrelated/duplicate
finish triggers still rejected (incl. the face-lean graze).
- [x] Browser and real-base1 regressions for the user-visible entry without
repositioning inside the route or directly firing targets.
- [ ] User browser verdict on the visible route (walk on, press button, F1).

### RELEASE-16 — Shootable secret-button texture/lighting states
owns: `packages/game`, `packages/server`, `apps/web`, `packages/sw-renderer`, `packages/webgl-renderer`, `packages/testkit`
depends: none
status: review (automated green; awaiting user visual verdict)
lane-report 2026-11-01: the button is base1 *13 (func_button, target t91,
wait -1, health 1); its up/down faces carry 4-frame +0btshoot chains, sides
are static box1_1. frame/effects were never modeled, submitted, or selected
(always base texture = always lit). Now: Mover fx/frame with C transitions,
buttonAnimFrame client rule, texinfo-next chain bake (animTexIds),
per-tick DoorSync pick, sw texId-drift invalidation, WebGL2 range re-sync
(no re-upload). Damage activation, target firing, travel (+4z TOP hold) and
illumination otherwise untouched.
evidence: game 259/259; sw-renderer 189/189; web button-anim 4/4 (real base1:
*13 shot swaps ANIM01->ANIM23 with travel/secret preserved, repeat shots
never re-fire, *34 cycle ANIM01->ANIM23->ANIM23->ANIM01 + 2Hz rest flips,
WebGL2 scene handles follow live texIds, forced-frame negative control fails
the held assertion and moves only button pixels); webgl-renderer button-anim
3/3 (stub-GL rebind without re-upload, no-chain negative control,
scene-side handles); underwater 13/13 unaffected; typecheck clean.
user-report: near **(-2146.2, 1556.6, -24)** the secret's shootable button is always lit; its inward motion when shot is correct and must be preserved.
review-finding: original `game/g_func.c` changes `s.frame` and animation flags: button_wait selects frame 1 and EF_ANIM23; button_return resets frame 0; button_done restores EF_ANIM01. Physical mover position alone is not the complete visual state. The specific brush/material at this camera still needs identification; do not assume every button shares the same art.
done-when:
- [ ] Identify the button brush/entity and WAL/texinfo animation chain at the reported position. Compare original unpressed, pressing, held and returning appearances; distinguish authored lit/unlit texture variants from dynamic lighting. Record camera and close crops before/after shooting.
- [ ] Trace original frame/effect state through server mover updates, retained brush/scene submission and each renderer's animated texture selection. Implement missing state propagation or selection without hardcoded recoloring or globally changing illumination. Preserve damage activation, target firing and correct physical press motion.
- [ ] Render real-asset before/after/return states on Software and WebGL2, including repeated shots, held buttons and resize/switch while pressed. Add an effective negative control that forces one visual state and fails; mover-distance assertions alone cannot establish button-art correctness.

### RELEASE-15 — Verify underwater object appearance against the original
owns: `apps/web`, `packages/webgl-renderer`, `packages/sw-renderer`, `packages/testkit`
depends: none
status: review (Software appearance user-confirmed; original OpenGL comparison remains unverified)
review-finding: `a42e951` adds contents tint on both backends and full-frame software warp; WebGL2 gets tint only. Local original `ref_soft` uses D_WarpScreen, whereas reviewed `ref_gl/gl_rmain.c` uses normal projection and polyblend, with no corresponding RDF_UNDERWATER screen-warp path. Animated water surface UVs are a separate effect. This source finding does not replace a matched visual check of the user's observation.
user-verdict 2026-10-31: Software underwater warping renders correctly; preserve it. This is not a request to add the software warp to WebGL2.
distortion-answer 2026-11-01 (source parity, no code change): neither original
backend refracts objects seen through the surface. ref_soft warps the FULL
screen only while the eye is under contents (D_WarpScreen + R_CalcPalette);
ref_gl never warps (R_PolyBlend tint quad only, zero RDF_UNDERWATER readers).
This project matches both: software warps when submerged (preserved), WebGL2
tints only (by design). Water-surface UV animation is separate on all sides.
box-1 remaining scope: matched original-OpenGL-vs-project-WebGL2 captures (eye above/below/crossing, engine/version/map/camera/FOV/time/contents + screenshots or video) plus the user verdict on warp vs tint vs refraction. No headless path to a running original binary in this environment.
done-when:
- [ ] Compare matched original OpenGL and project views: eye above water looking at submerged objects, eye below water, and crossing the surface. Record engine/version, map/camera/FOV/time, contents and screenshots/video. Distinguish surface animation, full-screen warp, tint and genuine refraction; identify the observed distortion rather than adding an invented effect.
- [x] Audit warp/blend ordering, eye-contents detection, viewmodel and HUD behavior, plus renderer switches underwater. Fix demonstrated regressions, preserving backend-specific source behavior and intended water motion. Do not apply software full-screen warp to WebGL solely because it exists in the software source.
- [x] Capture deterministic known-object geometry and transition tests with omitted-effect controls at multiple resolutions. Record source parity and user visual verdict separately; keep uncertainty open if the original comparison is unavailable.

### GPU-FOLLOW-6 — Verify gameplay on a visible display
owns: `apps/web`, `tools/bench`, `packages/testkit`, `docs`
depends: RELEASE-4, RELEASE-16, RELEASE-15 (other repair evidence archived)
status: blocked (displayed-performance evidence only)
blocker: archived `docs/gpu-follow-6-gate-record.md` reports hardware GL but no connected monitor/vsync/scanout. This review did not recheck display availability. Submitted-frame throughput is not displayed FPS. Historical startup 3.05s exceeds the 2.5s target.
done-when:
- [ ] Once a measurable display exists, run ≥5-minute 640×480 hardware-backed visible soak with rooms/PVS, boarding/ride, combat, viewmodel/effects, sky/water and settings cycles; no silent fallback or unbounded resources.
- [ ] Record immutable build/device/refresh, raw samples, p50/p95/p99 and dropped frames; require median work ≤16ms, ≥59 FPS at nominal 60Hz and p95 interval ≤20ms separately. Measure cached-pak-to-first-frame ≤2.5s separately.
- [ ] If a performance gate misses, permit only the remaining one measured optimization iteration, then report. Keep display blocker separate from fixable startup/content defects and continue independent work.

### GPU-FOLLOW-7 — Final integrated acceptance
owns: `BRAIN.md`, `docs`, `.changeset`, `apps/web`, `packages/config`
depends: all active repair cards above, GPU-FOLLOW-5, GPU-FOLLOW-6
status: blocked (active repairs and display prerequisites; FOLLOW-5 acceptance archived)
done-when:
- [ ] Run full `yarn verify`, `yarn deps:check`, real-asset base1, software/Node and GPU lifecycle/image/gameplay gates after integration. Record skips, failures and exact artifacts; no claim of completion based on archived partial greens.
- [ ] Reconcile archive claims with current user verdicts; publish separate implementation/correctness/fidelity/display-performance results. Close cards only with their required evidence.
- [ ] Keep GPU experimental until required gates pass and default rollout is explicitly decided. Commit validated increments with changesets, no push; archive completed cards without erasing unresolved work.

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
