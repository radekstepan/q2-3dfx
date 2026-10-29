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

```
### PERF-FINISH-A — RGB-authoritative Voodoo + worker ranges + foreground (renderer)
owns: `packages/sw-renderer`
depends: VOODOO-REPAIR-2
status: review
done-when:
- [x] Voodoo production skips duplicate classic world+foreground by default with counters proving skipped work; software unchanged
- [x] Indexed+RGB workers use precomputed bounded ranges, no per-worker full-span rescan; fallback intact; 0/1/3/7 scaling measured
- [ ] Foreground rasterizer measurably faster + worker-staged with ordering; serial fallback (DEFERRED: per-pixel barycentric→incremental rejected — changed coverage/ties; setup sharing kept; needs worker-staged foreground protocol, new card)
- [x] Emitter order-validation scans removed at proven sites; GEO re-profiled
```

```
### PERF-FINISH-B — browser critical path + acceptance (web)
owns: `apps/web`
depends: VOODOO-REPAIR-2
status: in-progress
done-when:
- [x] Per-stage browser critical path measured (sim/GEO/staging/raster/fg/scanout/blit/gaps), worker wait per band, fallback counts
- [x] Representative 640x480 presented-FPS + 5-min soak on new code (320×240 voodoo soak med 21fps, 0 fallbacks, results in perf-ledger; 640×480 browser FPS still open)
```

```
### PERF-FINISH-C — trustworthy measurement (bench/testkit)
owns: `tools/bench`, `packages/testkit`
depends: VOODOO-REPAIR-2
status: review
done-when:
- [x] Quiet-machine parent-vs-HEAD controlled before/after, identical workloads (a7b753b vs HEAD, same command, sequential — see perf-ledger)
- [x] Full-RGBA serial-vs-pooled raster+display parity (blue/alpha fail), RGB execution proof, Voodoo fallback races, fixed translucent test, sky+world same skip policy
- [x] ESM/CJS config-store pinned + regression-tested; instrumented vs uninstrumented vs presented separated; serial independently required (acceptance states it). OPEN: dual-store split needs a `packages/config` owner (single-instance rule) — test documents it as contract need
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
