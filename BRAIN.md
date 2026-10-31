# BRAIN.md — Q2TS: Quake II in TypeScript (software renderer + Voodoo 3 3000 look)

> **This file is the single source of truth for every coding agent that touches this repo.**
> Read it fully before writing code. Never invent architecture that contradicts it.
> If reality and this file disagree, fix the file in the same PR that fixes reality.
>
> Detail docs live in `docs/`: `architecture.md`, `renderers.md`, `data-pipeline.md`,
> `process.md`, `perf-ledger.md`, `lessons.md`, `tasks-archive.md`.
> This file states the rules and the *active* work. Everything else is a pointer.
> **Current direction (2026-10-31, reviewed at `b55fec0`): repair elevator
> boarding, ladder/water movement, F1 notification/live secrets and message UI;
> audit monster behavior, damage feedback, view roll and underwater appearance.
> Preserve landed resize, effects and renderer retirement. §8 is the only active
> queue; archived completion claims do not override current user feedback.**

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

Source/history reviewed at `b55fec0` on 2026-10-31. No runtime/browser tests or
full verification were rerun in this review. Findings below distinguish direct
code observations from symptoms still needing a production reproduction.

**Current user verdict: the repeated issues are still unresolved.** `b55fec0`
only adds an elevator approach/obstruction test and an F1 completion headline;
it does not implement boarding or repair help, messages, movement, patrols,
damage/view effects or sidebar styling. Do not call that increment a gameplay
fix. The message flicker and dying-enemy collision reports are now explicit
acceptance requirements below. These remain active work, not display blockers.

Earlier resize/blit, unlit-water, effects/audio and renderer-retirement work is
retained; latest feedback does not establish a new verdict on every old issue.
Sky fixes remain preserved. FOLLOW-5 tone/structural acceptance is recorded in
`9d99612`/`c3396ab`; it does not close current gameplay/UI defects. GPU remains
experimental pending FOLLOW-6/7. No runtime tests were rerun in this review.

Priority: RELEASE-4 (boarding) → RELEASE-12
(movement) → RELEASE-6 (help) → RELEASE-13 (dying collision/patrols) →
RELEASE-10/14/15 (RELEASE-11 message repair landed this session). Independent bounded fixes can proceed without waiting for
the elevator investigation; do not leave the rest untouched after one diagnostic.
Use disjoint ownership for independent work. Claim one card, run expensive tests
sequentially, and keep implementation/test/user verdicts separate. Real-map
movement and visible behavior require end-to-end regressions, not helper-only
assertions. Reopened cards supersede their archived DONE versions. Do not erase
valid prior fixes or silently waive newly reported symptoms.

### RELEASE-4 — Walk into the final elevator and show completion help
owns: `packages/server`, `packages/game`, `apps/web`, `packages/testkit`
depends: none
status: ready (diagnostic landed; boarding fix outstanding)
user-verdict: original game allows walking onto the elevator and then loads the next level. This project must allow boarding, then show the F1/help screen stating the level is finished. Invisible blockage persists; preserve the repaired waiting/open behavior.
review-finding: the previous blocker analyzed the *12 train/rock slot and punted the route. That does not establish that the user’s actual exit is impossible. Prior notes identify *31 descending plug and t37 changelevel as a different candidate; re-identify from the visible approach.
done-when:
- [x] Trace normal walking from the final doorway to the actual exit platform; record player/camera, hit brush/edict/model, origin/bounds, startsolid/fraction and mover state. Follow real map targets/buttons and original source; distinguish *12/*13 from *31/*34 and the exit trigger instead of assuming the wrong elevator.
  Evidence: `b55fec0` approach trace reaches a closed *31 mover or a world wall on the tested routes; entry sliders open, but *13/*34 and t91/t4/t37 remain unfired. This identifies tested obstructions, not the complete intended route. F1 headline is implemented; actual boarding and automatic finish presentation are not verified.
- [ ] Fix the blocking collision/transform/activation chain without noclip, teleport, globally disabling solids or prematurely moving the elevator. Keep prior sweep/button repairs where valid.
- [ ] End-to-end base1 gate must approach, enter and stand on the platform through player input, then trigger finish at the intended transition. Show the requested F1 completion panel with frozen final kills/secrets/goals/time and an explicit finished state; next-map loading is not required by this task. No test may start inside the elevator to claim boarding passed.
  Do not prescribe a speculative *34/pit route as fact or require hidden E-use unless the original supports it. Establish the route the user verified in the original. The prior above-pit descent test cannot substitute for walking aboard. Historical base1-gate death-fire timing failure (boltSeenAt 14 vs >=16) remains a reported test issue, not a boarding prerequisite.

### RELEASE-12 — Ladder climbing, water exits and slopes
owns: `packages/game`, `packages/server`, `apps/web`, `packages/testkit`
depends: none
status: ready
review-finding: pmove checks compact `CONTENTS_LADDER = 16`; `SV_TraceFor` returns raw BSP trace contents (`0x20000000` for ladder), and the live driver feeds it through `SV_ClipTrace` to pmove. `game/collision.ts` has a mapping helper, but the live trace boundary needs auditing. Raw bits must remain correct for weapon/effect consumers; do not change every trace indiscriminately.
done-when:
- [ ] Reproduce a real base1 ladder with the hint visible but no climb; fix the contents/trace integration and verify up/down, sideways departure, top/bottom transitions, hull collisions and client prediction. Include an actual raw-BSP ladder regression so compact-bit mock tests cannot mask failure.
- [ ] Revisit the water secret at the supplied position **“1057-9 865.3 -207.9”** (provisional interpretation x=1057.9, y=865.3, z=-207.9; verify against map geometry). Record jump/swim input, water levels, hull, edge height, velocity and ground normal. Compare original `qcommon/pmove.c` water-jump, jump-held, friction/acceleration, step-slide and slope clipping behavior.
- [ ] Test escaping that pool and traversing the reported angled wall through normal input; fix demonstrated divergence, not difficulty that matches original physics. Cover submerged/edge transitions, steep versus walkable slopes, frame/tick variations and both renderers. Preserve source movement constants unless evidence justifies a change.

### RELEASE-6 — F1 startup flash and live secret progression
owns: `apps/web`, `packages/client`, `packages/server`, `packages/testkit`
depends: none
status: ready (reopened)
review-findings: HUD uses `boot.helpChangedSeq/helpSeenSeq`; boot initializes both to zero and no advancing assignment was found. Server now has a target_help producer and independent helpChangedSeq, but the boot comment still says that producer is absent. Live F1 already reads `foundSecrets`; therefore the repeated secret-count symptom needs trigger/counter/presentation tracing, not another blind replacement of finish counters.
done-when:
- [ ] Show the startup F1/help notification flashing until the first F1 acknowledgment, as requested. Reconcile server help-change state with HUD acknowledgment, initial map help, actual icon visibility and the original `p_view.c`/`p_hud.c` cadence; new help changes should notify again. Verify a real cold boot rather than manually altering counters in tests.
- [ ] Follow a real secret discovery from trigger/target chain through single-use `foundSecrets` increment to F1 rendering. With help open and closed, verify multiple discoveries update immediately and never double-count. Preserve final frozen counters once finished.
- [ ] Use current help text/map name, remove stale producer comments, and verify icon/panel across resolutions, resize/switch and respawn. Coordinate the final help screen with RELEASE-4.

### RELEASE-11 — Fix message flicker, centered hints and status toggle
owns: `apps/web`, `packages/client`, `packages/config`, `packages/server`
depends: none
status: done (repaired 2026-10-31; see docs/tasks-archive.md RELEASE-11 repair entry)
review-findings: successful firing calls `setMessage('', 'status')`, clearing the shared string; `setMessage` has no duration/deadline. Continued shooting can therefore erase “soldier minced” almost immediately. This is a concrete clearing path, not a browser reproduction. `cl_showmessages` already exists, is persisted and gates status text. The driver drains server centerprints into `setMessage(..., 'status')`, sharing the cosmetic one-line channel; this loses original centered presentation and lets the status toggle hide hints/secrets.
done-when:
- [x] Give transient status messages an explicit readable lifetime and deterministic expiry. Successful shots and unrelated empty updates must not erase a fresh kill/status message. Verify duration under held fire, automatic weapons, varying FPS and successive events, with screenshots/time samples; preserve deliberate death/respawn/finish transitions.
- [x] Make the existing gameplay-status toggle easy to find and verify it hides/shows messages such as “soldier minced” immediately, across both renderers and reloads. Diagnose why the user still requests it; do not add a duplicate cvar.
- [x] Give trigger/ladder/secret messages their own centerprint presentation with white game-font text, source-matched centering, multiline handling and lifetime. Verify original source/message assets and real trigger routes. Keep these messages distinct from cosmetic kill/status text, F1 and completion; explicitly test toggle behavior for each channel.
- [x] Add rendered regressions for “crouch here,” ladder hint, secret discovery, kill status on/off, message expiry and simultaneous events without overwriting essential completion/errors.

### RELEASE-10 — Tooltip-only disabled explanations; matching checkbox styling
owns: `apps/web`
depends: none
status: ready (reopened)
review-finding: `renderCvarRow: noteDisabled` appends a visible `q2-cvar-why` span even though the row/control already has the full reason in its title.
done-when:
- [ ] Remove visible reason paragraphs; put explanations in hover/focus-accessible tooltips on the control/label or wrapper, with an accessible description. Disabled native inputs may not receive focus/hover events, so verify the wrapper path.
- [ ] Keep disabled checkbox geometry, custom styling, alignment and size identical to enabled checkboxes; only disabled affordance/interaction changes. Preserve renderer capability decisions, saved values and switch/fallback updates.
- [ ] Check the real sidebar on both renderers at representative viewport sizes, mouse and keyboard; no layout shift or duplicated visible explanation text.

### RELEASE-13 — Dying-enemy collision, death variety and soldier patrols
owns: `packages/game`, `packages/server`, `apps/web`, `packages/testkit`
depends: none
status: ready
review-findings: `monsterClipBox` returns null on `state.dead`, while monster damage sets that flag immediately at health <= 0, before death animation completes. Audit the source dying→dead transition and collision masks; do not equate lethal damage with finished corpse state. Infantry already defines death1/death2/death3 and chooses via `floor(rand()*3)` in monster damage; soldier lite currently pins death1. The user’s infantry observation may concern RNG delivery, frame submission or identity rather than missing tables.
done-when:
- [ ] Keep enemies blocking the player while downed/dying but not yet fully dead, as requested. Separate lethal-hit, active death animation/last-shot, final corpse and gib states; audit source `Killed`, species dead callbacks and SVF_DEADMONSTER timing. Preserve appropriate final-corpse behavior and shootability. Test walking into each state, including infantry death2 firing, on real server/prediction paths; never make all corpses permanently solid.
- [ ] Exercise all three non-gib infantry deaths through the production damage→server→snapshot→renderer path with controlled RNG, then sample normal play. Compare original frames, timing, movement, death2 firing and final corpse bounds; distinguish soldiers from infantry and gib deaths. Fix actual selection/rendering omissions.
- [ ] Reproduce the missing patrol behavior the user sees in the original; audit base1 soldier spawn targets/path_corner chains, idle/walk patrol, facing, ambush flags, sight/hearing and wake-up against original `g_monster.c`/`g_ai.c` and map entities. Identify which soldiers should patrol and be approachable from behind; do not make every idle soldier patrol or detect players omnidirectionally.
- [ ] Record real-map routes and visible death sequences; add regressions for patrol→detection/combat and rear approach with appropriate source sight/noise behavior.

### RELEASE-14 — Source-faithful damage feedback and strafe view roll
owns: `packages/game`, `packages/server`, `packages/client`, `apps/web`, `packages/webgl-renderer`, `packages/renderer-api`
depends: none
status: ready
done-when:
- [ ] Port/audit original `p_view.c: P_DamageFeedback` and `p_hud.c` damage flashes: health-number flash, damage color/alpha blend, decay and directional view kick. Cover armor/blood contributions, repeated hits, immunity/death and reset. Distinguish low-health blinking from a just-hit flash; render feedback on Software and WebGL2.
- [ ] Compare `SV_CalcRoll`/`SV_CalcViewOffset` lateral-velocity roll and bob with the actual submitted camera. Weapon sway is not camera lean. Verify magnitude, sign, speed clamp, grounded/air/water cases and decay against source, including aim/crosshair consistency.
- [ ] Use deterministic damage and strafe sequences with pixel/camera evidence at multiple resolutions; keep HUD readable and avoid applying blend/kick twice. Any shared contract changes follow §5.

### RELEASE-15 — Underwater view distortion and transitions
owns: `packages/client`, `apps/web`, `packages/webgl-renderer`, `packages/sw-renderer`, `packages/renderer-api`, `packages/testkit`
depends: none
status: ready
done-when:
- [ ] Inspect original renderer/client handling of submerged view, contents flags, blend and underwater warp; distinguish being underwater from looking through an animated surface at submerged objects. Compare matched scene/camera/time to the original OpenGL behavior before assuming distortion is wrong or adding surface refraction.
- [ ] Audit current view/projection/render flags and implement missing or repair excessive distortion to match the source. Preserve Software reference semantics, water-surface motion, HUD/crosshair alignment and source FOV behavior.
- [ ] Verify above/below/partially submerged transitions, opaque submerged objects and moving views with deterministic captures and an omitted-warp control. Record backend differences explicitly.

### GPU-FOLLOW-6 — Verify gameplay on a visible display
owns: `apps/web`, `tools/bench`, `packages/testkit`, `docs`
depends: RELEASE-4, RELEASE-6, RELEASE-10, RELEASE-11, RELEASE-12, RELEASE-13, RELEASE-14, RELEASE-15
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
