# BRAIN.md — Q2TS: Quake II in TypeScript (software renderer + Voodoo 3 3000 look)

> **This file is the single source of truth for every coding agent that touches this repo.**
> Read it fully before writing code. Never invent architecture that contradicts it.
> If reality and this file disagree, fix the file in the same PR that fixes reality.
>
> Detail docs live in `docs/`: `architecture.md`, `renderers.md`, `data-pipeline.md`,
> `process.md`, `perf-ledger.md`, `lessons.md`, `tasks-archive.md`.
> This file states the rules and the *active* work. Everything else is a pointer.
> **Current direction (2026-11-03, voodoo-fidelity queue): `packages/voodoo`
> (+ its duplicated-by-value mirror in `packages/webgl-renderer`) reviewed
> against `../external/voodoo3_progguide.pdf` + `../external/voodoo3_spec.pdf`.
> The review found 1 behavioral bug in a hot path (rgbMaxDelta gate), 1 more
> behavioral deviation (fog interpolation), and labeling/provenance fixes —
> plus investigation cards for unattested mechanisms and unimplemented stages.
> Old queue (RELEASE-4B/16/15, GPU-FOLLOW-6/7) is parked cleared-not-done in
> `docs/tasks-archive.md`. VF-1 first; §8 is the only active queue.**

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

### Fidelity review source (2026-11-03)

`packages/voodoo` (+ the duplicated-by-value mirror in
`packages/webgl-renderer/src/appearance.ts`, shaders + `*For` CPU helpers)
reviewed against `../external/voodoo3_progguide.pdf` (rev 1.4, 14 Jun 1999)
and `../external/voodoo3_spec.pdf`. Extracted text: `/tmp/opencode/voodoo-review/`
(regenerable via `pdftotext -layout`). Verdict scale: **BUG** (contradicted by
the manuals) vs **INVESTIGATE** (unverifiable from the manuals, or a scope
decision to make). Guide shorthand below: PG = prog guide, SP = spec.
Old queue (RELEASE-4B/16/15, GPU-FOLLOW-6/7) moved to `docs/tasks-archive.md`
cleared-not-done on 2026-11-03; resume by moving a card back here.

Priority: VF-1 first — the only behavioral bug in a hot path, mirrored in the
GLSL gate. VF-2/VF-3 next (one more behavioral deviation + labeling). Claim one
card; keep `packages/voodoo` and its `webgl-renderer` mirror in sync in the
same PR (duplicated-by-value rule); `yarn verify` green + changeset per card.

### VF-1 — rgbMaxDelta gate: per-component substitute-then-filter (BUG)
owns: `packages/voodoo`, `packages/webgl-renderer`
depends: none
status: ready
review-finding: PG §6.5.2 (SP §11.1.2 identical): on a threshold breach *"the
particular component will be replaced with that corresponding component of the
center pixel before the pixel is used in the filter"* — per-component
substitute-and-still-filter, gated on each tap's absolute deviation from the
centre. Implementation (`resolve.ts:319 passesReconstructionThreshold`,
`:353 passesReconstructionThresholdRow`, mirrored in GLSL
`appearance.ts:723-792`) rejects the whole 2x2/4x1 block on max−min spread.
Observably different (e.g. taps {0,0,0,10}, centre 0: hardware filters with one
clamped component; ours keeps the block sharp). Parser (`resolve.ts:295`,
`appearance.ts:149`) accepts 0–255; hardware fields are 6-bit (0–63, PG
§6.5.2 bits 21:16/13:8/5:0).
done-when:
- [ ] CPU gates + GLSL gate implement per-component substitute-with-centre then filter; metric is per-tap deviation from centre, not block spread.
- [ ] Both parsers clamp to 0–63; defaults stay 8,8,8; `0,0,0` still disables.
- [ ] `scanout.rgbMaxDelta-register` profile entry restated (substitute rule, deviation metric, 6-bit range); mirrored cvar note in `appearance.ts:906` updated.
- [ ] Fail-before tests: mixed-tap block ({0,0,0,10} centre 0) filters with clamped component; >63 parses clamp; CPU↔GLSL gate parity pin.

### VF-2 — Fog: inter-entry interpolation + fog provenance (BUG-gap)
owns: `packages/voodoo`, `packages/webgl-renderer`
depends: none
status: ready
review-finding: 64-entry table + high-6-bits-of-1/W index CONFIRMED (PG §9.3.45,
§10.3.4). But PG documents hardware de-banding the implementation skips:
*"Eight lower order bits of… 1/W are used to blend between multiple entries"*,
plus 6.2 per-entry deltas and `fogdither` (fogMode[6]). `fogFactor`
(`sampler.ts:357`, `appearance.ts:183`) does nearest-entry lookup. The exp²
formula + density 3.0 is driver-table policy (PG: *"table is loaded by the
application"*) with no profile entry; `fogFactor`'s linear-w01 input domain ≠
hardware's raw-1/W-bit indexing and the caller mapping is unspecified.
done-when:
- [ ] Either implement the low-8-bit inter-entry lerp (CPU + shader) or add a tracked `approx:chosen` omission entry; same decision for deltas/dither.
- [ ] Profile entries: fog-table formula (driver policy), fog input-domain mapping (who converts to 1/W-bit space), interpolation status.
- [ ] Banding pin: smooth-depth ramp shows no 64-step banding, or the omission entry says so.

### VF-3 — Profile/comment attribution corrections (BUG-labels)
owns: `packages/voodoo`
depends: none
status: ready
review-finding: (a) `scanout.order` tagged `manual:vidProcCfg` — no explicit
order sentence exists in PG; filter-before-CLUT is inferred from video-proc vs
RAMDAC placement, and "RAMDAC order" mislabels video-processor logic.
(b) `scanout.matched-pairs` claims "only" — PG §17.8 retains a *"3-bit tap
filter for RGB565 dithered as an alternative to the 2x2 box filter"*.
(c) `lod.dither-mean` tagged `manual:tLOD` — `tloddither` is `textureMode`
bit 4. (d) "guide §4 'Alpha, depth, fog and HUD'" citations (`resolve.ts:143,
177, 202`) — PG §4 is unrelated; correct anchors are `fbzMode` §9.3.31, depth
§10.4.2/Table 10.7, zaColor §9.3.35, fastfill §9.3.25. (e) "Single-TMU
'trilinear'" (`sampler.ts:285`) misnames PG trilinear (two-pass blending); the
Bayer-threshold pick has no profile entry (the +0.375 addend is manual; the
pick mechanism is `approx:chosen` invention).
done-when:
- [ ] `scanout.order` → `approx:chosen` with inference note; video-proc (not RAMDAC) wording.
- [ ] `matched-pairs` drops "only"; §17.8 3-bit-tap alternative recorded (scope decision goes to VF-6).
- [ ] `lod.dither-mean` source → `manual:textureMode`; new entries for the Bayer-pick mechanism, 8-bit bilinear weights, box mip kernel.
- [ ] All "guide §4" citations fixed; "trilinear" renamed to dithered single-level selection with PG/SP citations.

### VF-4 — Overbright ×2 provenance (INVESTIGATE)
owns: `packages/voodoo`, `packages/webgl-renderer`
depends: none
status: ready
review-finding: no ×2/overbright/lightmap stage exists in PG's combine units
(CCU §10.3.1, ACU §10.3.2, texture-combine §10.6.1 — mux/add-local/invert only).
The ×2 (`modulateLightmap`, `sampler.ts:391`) is plausibly Glide/Quake-II-level
convention (multipass lightmap `SCALE_OTHER`-style programming saturated in the
8-bit pipeline), but the "No per-pixel overbright on Voodoo" header asserts a
hardware negative the manuals don't establish.
done-when:
- [ ] Grep `../external/quake-2-source/ref_gl/` + Glide docs for the ×2 convention; record the actual provenance (file/symbol).
- [ ] Relabel helper + profile entry as Glide/game-pipeline policy (`approx:chosen` or manual-with-source); soften the hardware claim.
- [ ] No math change unless the source shows different rounding/clamp.

### VF-5 — Write/scanout default pairing mismatch (INVESTIGATE)
owns: `packages/voodoo`, `packages/config`
depends: none
status: ready
review-finding: writes default 4x4 (`index.ts:62`) under a `2x2sub+2x2box`
scanout default (`index.ts:63`) — a mismatched pair by the package's own
subtract-matrix doctrine; PG notes 3Dfx software often hard-codes 2x2
(`fbzMode` §9.3.31: *"In some 3Dfx… software, this bit is always '1'"*).
Mismatch tolerance is guide-silent (separate registers, so tolerated — but
unverified against MiniGL).
done-when:
- [ ] Decide: default `vd_dithermode` to `2x2` for a matched default, or document the mismatch as accepted with rationale.
- [ ] Whichever way: cvar doc + profile `scanout.default` entry updated; goldens re-pinned only with recorded cause.

### VF-6 — Scanout path label + unmodeled filter modes (INVESTIGATE)
owns: `packages/voodoo`
depends: none
status: ready
review-finding: the dithered-565 reconstruction path is the *overlay* path
(PG §6.5.3 overlay formats incl. `111b RGB565 dithered`; desktop formats have
no dithered option) — if the implementation presents reconstruction as desktop
scanout, the chain is right but the path label is wrong (unless MiniGL presents
3D via the overlay — unverified). Unmodeled: PG §17.8 3-bit tap alternative
and `vidProcCfg` mode `11b` bilinear scaling.
done-when:
- [ ] Determine which path MiniGL/Quake-II 3D presentation uses (overlay vs desktop); fix path labels in profile/README/comments.
- [ ] Scope decision per unmodeled mode (implement vs tracked omission entry): 3-bit tap filter, bilinear-scaling 11b.

### VF-7 — Unimplemented pipeline stages: track + scope (INVESTIGATE)
owns: `packages/voodoo`
depends: none
status: ready
review-finding: core PG pixel-pipeline stages with no helper and no tracking
entry: alpha-test (αMode[0], §10.4.1 — the masked-texture path), alpha-blend
(`Dnew = S·alpha + Dold·beta`, §10.3.3 — translucent water/explosions),
chroma-key (`fbzMode[1]`, §10.4.3), stipple (`fbzMode[2]/[12]`, §10.4.4),
depth-bias (`fbzMode[16]` — the hardware coplanar tool, cf. the tie-rule
rationale), 7 of 8 depth ops (only LESS modeled, Table 10.7), `lodmin > 0`.
done-when:
- [ ] One `approx:chosen` NOT-implemented profile entry per stage (suggested priority: alpha-test → alpha-blend → chroma-key → depth-bias → stipple → extra depth ops → lodmin).
- [ ] No silent gaps remain: every PG §10.3–10.4 stage is either implemented or tracked.

### VF-8 — Uncalibrated numerics: profile entries (INVESTIGATE-docs)
owns: `packages/voodoo`, `packages/webgl-renderer`
depends: none
status: ready
review-finding: deterministic stand-ins with no `VOODOO_APPROX_PROFILE` entry:
8-bit bilinear weight precision (PG confirms 4 taps, silent on precision),
2x2-box mip-generation kernel (PG describes only driver-provided chains),
single 256-entry gamma LUT vs hardware's 512-entry triple tables with separate
video/graphics gamma + desktop/overlay select (PG §6.4.4–6.4.5, SP §11.1.3),
fog caller-side w01 mapping (linear ≠ 1/W-bit space), dither ±0.5-LSB
amplitude/absolute phase (PG silent; fog-XOR diagrams must NOT be cited as
color-dither evidence), G-channel `Math.round` half-up asymmetry (`+2` vs `-1`,
`bayer.ts:53-56`), `vd_lodbias` −0.35 unrepresentable in HW 4.2 format
(confirming software-side preset status).
done-when:
- [ ] One `approx:chosen`/`preset:appearance` entry per item above; code comments point at entries instead of asserting equivalence.
- [ ] `parseRgbMaxDelta`-style overstatements swept: no *"what the Voodoo does"* phrasing for host-API concepts (`GL_EXT_shared_texture_palette`, NPT).

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
