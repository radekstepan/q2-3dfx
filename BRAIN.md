# BRAIN.md — Q2TS: Quake II in TypeScript (software renderer + Voodoo 3 3000 look)

> **This file is the single source of truth for every coding agent that touches this repo.**
> Read it fully before writing code. Never invent architecture that contradicts it.
> If reality and this file disagree, fix the file in the same PR that fixes reality.

---

## 0. TL;DR for an agent landing here cold

1. `corepack enable && yarn install`
2. `yarn turbo run build typecheck test --filter=...[origin/main]`
3. Pick **one** task card from §9 that is `status: ready`. Claim it by setting `status: in-progress` + your agent id.
4. Work **only inside the packages listed in that card's `owns:` field.**
5. Before you finish: `yarn verify` must be green, and you must add a changeset (`yarn changeset`).
6. Update the card to `status: done`, append measured numbers to §11 (Perf ledger).

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

## 1. Mission

Rebuild Quake II so that it:

- **Renders in software.** A faithful port of `ref_soft` — 8-bit palettised framebuffer, 64-level
  colormap shading, perspective-correct spans subdivided every 16 pixels, surface cache, edge/span
  rasteriser, affine alias models. No GPU required, no WebGL fallback inside this path.
- **Renders in "3dfx Voodoo 3 3000" mode.** A faithful *emulation* of what `ref_gl` looked like on a
  Voodoo3 through Glide/MiniGL: 16-bit RGB565 framebuffer with 4×4 ordered dither, the 2×2 "22-bit"
  post filter, bilinear filtering, mipmap LOD with mip-dithering, 64-entry table fog, LOD bias,
  256×256 max texture size, 16-bit depth buffer, and the ~1.3 Glide gamma lift.
- **Runs in a browser** at ≥60 fps at 640×480, and ideally in Node for headless tests.
- **Plays a shareware map end to end** (`base1`), with movement, collision, doors, buttons, lifts,
  triggers, items, two monster types and three weapons.

### Non-goals (v1)

Multiplayer/netcode (the server is in-process), CD audio, cinematics (`.cin`), save games,
the mission packs, `gamex86.dll` ABI compatibility, demo recording. Demo *playback* of `demo1.dm2`
is in scope **only** as a determinism test harness (§10.3).

---

## 2. Feasibility: why this is not crazy

A 320×240 frame is 76,800 pixels. Quake II's software renderer on a Pentium 200 MMX shipped at
~25–35 fps there, i.e. ~2–3 Mpixel/s of textured, lit, z-buffered span fill, plus geometry.

Modern JS, with monomorphic code over typed arrays and no allocation in the frame loop, sustains
**60–200 Mpixel/s per core** for the span loop in this codebase (see §11 for the measured ledger from
the reference implementation in `packages/sw-renderer`). That is 20–60× the budget the original
engine had, and it is why this works.

Rules that make the difference between 200 Mpixel/s and 5 Mpixel/s:

- `Uint8Array`/`Uint32Array`/`Float32Array` only in the inner loop. **No objects, no closures, no
  iterators, no `Array<number>`.**
- Fixed point 16.16 for texture coordinates, exactly as `d_scan.c` did.
- One division per 16 pixels (affine subdivision), never per pixel.
- Preallocated scratch buffers on the renderer instance; zero garbage per frame.
- Avoid polymorphic call sites: separate `spanSoftware` / `spanVoodoo` functions, never a
  `mode === 'x'` branch *inside* the pixel loop (branch on the span, not the pixel).
- `ImageData` backed by a `Uint32Array` view; one `putImageData` + one `drawImage` upscale per frame.

### Scaling ladder (apply in this order, only when the perf ledger says you must)

| Step | Technique | Expected gain |
| --- | --- | --- |
| 1 | Pure TS, typed arrays, span subdivision | baseline |
| 2 | PVS + frustum cull + sorted spans (kills overdraw) | 1.5–3× |
| 3 | Surface cache (`r_surf.c`): light×texture blocks cached per surface, reused across frames | 1.3–2× |
| 4 | `OffscreenCanvas` + N workers, framebuffer split into horizontal bands over a `SharedArrayBuffer` | ~N× (needs COOP/COEP headers) |
| 5 | AssemblyScript/Zig/C→WASM for `d_scan`/`d_polyse` only, with SIMD | 2–4× |

v1 target is step 1–3. Steps 4–5 are already carved out as packages so they can be dropped in
without touching call sites (`@q2/sw-renderer` exposes `RasterBackend`).

---

## 3. Sources, licences, assets

| Thing | Where | Licence | How we use it |
| --- | --- | --- | --- |
| id Quake II source | sibling `../external/quake-2-source/` (outside git, never committed) | **GPL-2.0** (`gnu.txt`) | The normative reference. We port algorithms and data structures from it (`ref_soft/`, `ref_gl/`, `qcommon/`, `game/`, …). Default: `$Q2_SRC` (see `tools/q2-paths.sh`). |
| Quake-2-JS | sibling `../external/quake-2-JS/` (outside git) | check repo | Cross-check for browser-side asset loading and WASM/JS porting pitfalls. Do **not** copy code without licence review. |
| Voodoo3 prog. guide + voodoo demo | sibling `../external/voodoo3_progguide.pdf`, `../external/quake-2-voodoo-3-demo/` (outside git) | reference only | Voodoo3 behaviour checklist (§7.2). Default: `$Q2_DOCS`. |
| `pak0.pak` (game data) | sibling `../external/q2/baseq2/pak0.pak` (outside git; local full-game install — a shareware pak works too) | id's data, redistributable **unmodified only** | **Never commit it.** The app asks the user to drop `pak0.pak` into the page; it is parsed client-side and cached in IndexedDB. Tests read it via the `Q2_PAK` env var (a direct path to the `.pak` file; default in `tools/q2-paths.sh`). |

**Therefore this repo is GPL-2.0.** Every package's `package.json` must carry `"license": "GPL-2.0-only"`.
`tools/asset-cooker` may be used by the user on their own copy of the pak; cooked assets are
`.gitignore`d. CI fetches nothing with assets in it; asset-dependent tests are `skip`ped when
`Q2_PAK` env var is absent, and run in the nightly job where a pak is mounted from a secret.

---

## 4. Repo layout

```
q2ts/
├─ BRAIN.md                      ← you are here
├─ package.json                  ← yarn workspaces root, private
├─ turbo.json
├─ .changeset/config.json
├─ .yarnrc.yml                   ← nodeLinker: node-modules
├─ tsconfig.base.json
├─ apps/
│  ├─ web/                       ← Vite app: canvas, HUD, settings, pak drop zone
│  └─ devtools/                  ← map/BSP inspector, lightmap viewer, frame differ
├─ packages/
│  ├─ config/                    ← cvars, feature flags, build-time constants
│  ├─ math/                      ← vec3/mat4/angles/plane/fixed-point, all Q2 conventions
│  ├─ filesystem/                ← PAK reader, virtual FS, IndexedDB cache, pak drop ingest
│  ├─ formats/                   ← BSP38, WAL, PCX, MD2, SP2, WAV parsers → plain typed arrays
│  ├─ bsp/                       ← node/leaf traversal, PVS decompression, trace/clip hulls
│  ├─ sw-renderer/               ← ref_soft: colormap, surface cache, edges, spans, alias, particles
│  ├─ voodoo/                    ← Voodoo3/Glide emulation layer (post-processing + sampler rules)
│  ├─ renderer-api/              ← the Refresh interface both renderers implement
│  ├─ game/                      ← gamex86: entities, pmove, items, doors, monsters, weapons
│  ├─ server/                    ← SV_: world state, entity spawning, 10 Hz tick
│  ├─ client/                    ← CL_: prediction, interpolation, view, HUD, console
│  ├─ sound/                     ← WebAudio mixer, 3D attenuation, .wav from pak
│  ├─ input/                     ← keyboard/mouse/pointer-lock/gamepad → usercmd_t
│  ├─ host/                      ← the loop that ties server+client+renderer together
│  └─ testkit/                   ← golden-frame harness, PNG differ, bench runner, fixtures
└─ tools/
   ├─ asset-cooker/              ← pak0.pak → .q2pkg (binary, deflate), CLI
   └─ bench/                     ← headless perf runs, writes to the perf ledger
```

### Dependency rules (enforced by `eslint-plugin-boundaries` + `yarn deps:check`)

```
math ← formats ← bsp ← {sw-renderer, voodoo} ← renderer-api ← host
filesystem ← formats
game ← {math, bsp, config}
server ← {game, bsp}
client ← {renderer-api, input, sound, config, game (pmove prediction only)}
host ← {server, client}
apps/web ← host
```

- **Nothing** imports from `apps/*`.
- `sw-renderer` must not import `dom` types; it writes into an `ArrayBuffer` it is handed. This is
  what lets it run in a worker and in Node tests.
- `voodoo` is a *post-process + sampling policy* package, not a second renderer: it reuses the same
  geometry front end. See §7.

---

## 5. Conventions (do not deviate)

- **Coordinates:** Quake's. `+X` forward, `+Y` left, `+Z` up. 1 unit ≈ 1 inch. Angles in degrees,
  `[pitch, yaw, roll]`, pitch **positive = down**.
- **Time:** server ticks at 10 Hz (`0.1s`), client renders uncapped and interpolates. `level.time`
  is a float of seconds; never use wall-clock in game logic.
- **Texture mapping:** `u = dot(p, texinfo.s)/scale + s_off` in *texels*. Lightmap luxels are every
  **16 texels**. Keep the `LUXEL = 16` constant in `@q2/math`.
- **Colour:** the software path never leaves 8-bit until resolve. The Voodoo path works in 8:8:8 and
  is quantised to 5:6:5 at resolve. No path uses floats per channel in the inner loop.
- **Naming:** keep id's names where they help (`R_DrawSurface`, `SV_LinkEdict`, `PM_StepSlideMove`,
  `cl.frame`, `pmove_t`). An agent that knows the C source should be able to grep.
- **Modules:** `export`ed symbols only; no default exports. `.ts` only, no `.d.ts` handwriting except
  for ambient declarations.
- **No classes in hot paths.** Classes are fine for owners of state (`Renderer`, `Host`, `Game`).
- **Errors:** `Com_Error(level, msg)` from `@q2/config`, never raw `throw` in engine code.

---

## 6. Package contracts

These interfaces are **frozen**. Changing one requires a `major` changeset and an update to this
section in the same PR.

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
export interface RasterBackend {          // lets us swap TS → WASM → workers later
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

## 7. The two renderers

### 7.1 Software (`@q2/sw-renderer`) — the `ref_soft` port map

| id source | our module | notes |
| --- | --- | --- |
| `r_main.c` | `frame.ts` | setup, frustum, `R_SetupFrame`, viewcluster |
| `r_bsp.c` | `worldNodes.ts` | recursive node walk, PVS + frustum reject, surface marking |
| `r_surf.c` | `surfaceCache.ts` | **the hard one.** Builds lit, mipped texture blocks on demand into an LRU cache keyed by `(surface, lightstyle hash, miplevel)` |
| `r_edge.c` | `edges.ts` | edge list, `R_ScanEdges`, span emission, z-sorted spans |
| `d_scan.c` | `spans.ts` | `D_DrawSpans16`: the 16-pixel affine subdivision inner loop |
| `d_sprite.c` | `sprites.ts` | per-span clipped sprites |
| `r_alias.c` / `d_polyse.c` | `alias.ts` | MD2 drawing, affine triangle rasteriser, shade dots |
| `r_part.c` | `particles.ts` | single-pixel + blended particles |
| `r_light.c` | `light.ts` | dynamic light marking (`R_MarkLights`), blocklights |
| `colormap.pcx` | `colormap.ts` | 64×256 shade table; generate at load from the palette if missing |

**Inner loop (normative):**

```ts
// per 16-pixel subdivision: ONE division, then fixed-point stepping
const z1 = 1 / (iz + diz * n);
const u1 = (uz + duz * n) * z1, v1 = (vz + dvz * n) * z1;
let tu = (u0 * 65536) | 0, tv = (v0 * 65536) | 0;
const dtu = (((u1 - u0) / n) * 65536) | 0, dtv = (((v1 - v0) / n) * 65536) | 0;
for (let i = 0; i < n; i++, o++) {
  if (iz > zb[o]) {
    zb[o] = iz;
    idx[o] = colormap[(light << 8) + texels[(((tv >> 16) & hmask) << wshift) + ((tu >> 16) & wmask)]];
  }
  tu += dtu; tv += dtv; iz += diz; light += dlight;
}
```

Light is interpolated **per span**, not per pixel sample of the lightmap — that is what gives the
unmistakable soft 16-unit light gradient of the software renderer.

### 7.2 Voodoo 3 3000 (`@q2/voodoo`) — fidelity checklist

The Voodoo3 3000 is: 2 pixel pipelines × 1 TMU, 16 MB SDRAM, 166 MHz, 16-bit rendering only,
max 256×256 textures, 16-bit Z, no stencil, table fog, bilinear/trilinear-by-mip-dither.
Emulate **all** of the following; each is a cvar in `@q2/config` so we can A/B them:

| Hardware behaviour | Our implementation | cvar |
| --- | --- | --- |
| 16-bit RGB565 framebuffer | quantise 8:8:8 → 5:6:5 at resolve | `vd_16bit` |
| 4×4 ordered dither before quantise | Bayer matrix, ±4 on R/B, ±2 on G | `vd_dither` |
| 2×2 "22-bit" RAMDAC post filter | box filter of the dithered buffer on output | `vd_postfilter` |
| Bilinear filtering | 4-tap, 8-bit fractional weights, fixed point | `vd_bilinear` |
| Single-TMU "trilinear" | mipmap dithering: per-pixel pick LOD *n* or *n+1* by Bayer threshold vs LOD fraction | `vd_mipdither` |
| LOD bias (Glide default ≈ -0.35) | subtract from computed `log2(rho)` | `vd_lodbias` |
| Table fog (64 entries, exp²) | per-pixel table lookup on w, blend to fog colour | `vd_fog` |
| Glide gamma ≈ 1.3 | LUT applied before dithering | `vd_gamma` |
| 256×256 texture cap | asset cooker downsamples oversized WALs | `vd_maxtexsize` |
| 16-bit W-buffer banding | quantise stored 1/z to 16 bits | `vd_zbits` |
| 8-bit palettised textures (GL_EXT_shared_texture_palette) | textures stay palettised; expand through the palette at sample time | `vd_palettetex` |
| No per-pixel colour overbright, lightmap modulate ×2 | multiply, then clamp — clipping highlights like the real thing | `vd_overbright` |

Deliberately **not** emulated: the Voodoo's 3-bit sub-pixel accuracy, the 4 MB texture memory thrash,
and the 22-bit output's chroma-only filtering (we filter all channels — it looks the same at 2× scale).

Also ship the *presentation* layer: optional CRT mask + slight bloom + 4:3 letterbox, as a CSS/canvas
overlay in `apps/web`, never inside the renderer.

---

## 8. Data pipeline

```
pak0.pak ──PAK reader──┬─ maps/base1.bsp ──parseBSP38──┬─ planes, nodes, leafs, faces, texinfo
                       │                               ├─ lightmaps (RGB, 16-texel luxels)
                       │                               ├─ visibility (PVS/PHS, RLE)
                       │                               └─ entities (key/value lump)
                       ├─ textures/*.wal ──parseWAL────→ 4 mips of palette indices
                       ├─ pics/colormap.pcx ───────────→ 64×256 shade table + 256 palette
                       ├─ models/*.md2 ────────────────→ frames + st + tris
                       └─ sound/*.wav ─────────────────→ AudioBuffer
```

- **BSP38 lumps** (19): entities, planes, vertexes, visibility, nodes, texinfo, faces, lighting,
  leafs, leaffaces, leafbrushes, edges, surfedges, models, brushes, brushsides, pop, areas,
  areaportals. Parse into flat typed arrays (`Int32Array` of nodes, etc.) — **never** arrays of objects.
- **Cooking:** `tools/asset-cooker` converts a pak into `.q2pkg`: a single deflate-compressed binary
  with an index, pre-split per map, so the web app streams ~8 MB for base1 instead of 180 MB.
- **Caching:** `@q2/filesystem` stores cooked blobs in IndexedDB keyed by pak SHA-1.
- **Fallback:** if no pak is present, boot `maps/devroom` — the procedural room used by the demo page
  and the golden-frame tests. This keeps CI and the public demo asset-free. `maps/devroom`
  doubles as the demo1-era fallback (fixed cameras: `demoFallbackViews()` in `@q2/testkit`,
  `demoFallbackCameras()` in `apps/web/src/devroom.ts`); `demo1.dm2` itself can never ship —
  it is a recording of the retail `maps/base1` and playing it back needs the retail pak (§3).

---

## 9. Task cards

Format. Agents update `status` in place. One card = one PR = one changeset.

```
### M3.2 — Surface cache
owns: packages/sw-renderer
depends: M3.1
status: ready            # ready | in-progress(@agent) | review | done
done-when:
  - [ ] criterion
```

---

### M0.1 — Repo bootstrap
owns: `/` (root configs only)
status: done
done-when:
- [x] `yarn@4` via corepack, `.yarnrc.yml` with `nodeLinker: node-modules`
- [x] workspaces `apps/*`, `packages/*`, `tools/*`
- [x] `turbo.json` with `build`, `typecheck`, `lint`, `test`, `bench`, `golden` tasks (see §10.1)
- [x] `.changeset/config.json`, all packages `"license": "GPL-2.0-only"`, `"version": "0.0.0"`
- [x] `yarn verify` = `turbo run typecheck lint test build`
- [x] CI: node 20 + 22 matrix, `yarn verify`, changeset check on PRs (+ `yarn deps:check` step after verify)

### M0.2 — Package skeletons + contracts
owns: `packages/*`
depends: M0.1
status: done
done-when:
- [x] every package from §4 exists with `src/index.ts`, `tsconfig.json` extending base, `tsup` build
- [x] all interfaces from §6 compile with stub implementations that `Com_Error('not implemented')`
- [x] `yarn deps:check` enforces the graph in §4 (`tools/asset-cooker` `check-deps.ts`: §5 config-everywhere + documented exceptions — sw-renderer→renderer-api implements Refresh, game→formats asset data, server→{filesystem,math}, host→{input,sound,renderer-api} wiring, testkit harness-only)

### M1.1 — Math + fixed point
owns: `packages/math`
status: done
done-when:
- [x] vec3/mat4/angles/planes, `AngleVectors`, `BoxOnPlaneSide`, 16.16 helpers
- [x] 100% unit coverage of `AngleVectors` against values captured from the C source

### M1.2 — PAK + PCX + WAL
owns: `packages/filesystem`, `packages/formats`
depends: M1.1
status: done
done-when:
- [x] PAK directory parse, `readFile(name): ArrayBuffer`
- [x] WAL → 4 mips; PCX → palette + pixels; colormap built and byte-compared to id's `colormap.pcx`
- [x] `parseMD2` + `parseSP2` verified vs pak0.pak (soldier 227v/434t/475f, g_shotg, all 8 sprites); web boot registers real MD2s/skins via `registerPakModels` (per-monster meshes incl. gunner/infantry)

### M2.1 — BSP38 loader
owns: `packages/formats`, `packages/bsp`
depends: M1.2
status: done (@bsp-agent)
done-when:
- [x] all 19 lumps parsed into flat typed arrays for `base1.bsp`
- [x] leaf/cluster PVS decompress matches a fixture captured from the C engine
- [x] `traceBox` passes a 2,000-ray fixture (start/end/expected fraction) captured from the C engine

> M2.1 report (BSP-side, `packages/bsp` only; `packages/formats` untouched per lock):
> `loadBsp` (src/bsp38.ts) parses IBSP v38 + all 19 QBSP lumps into flat typed
> arrays; `BspMap` structurally extends the formats `Bsp38` stub so the frozen
> §6 signatures keep compiling. `decompressVis`/`clusterPVS` (src/pvs.ts) and
> `pointLeaf`/`traceBox` (src/trace.ts) are faithful cmodel.c ports
> (DIST_EPSILON=1/32, enter/leave bias, contents-mask + checkcount skips,
> position-test path). Fixtures committed in-repo (src/fixtures/base1-pvs.ts,
> src/testmap.ts): 6 real base1.bsp cluster rows byte-compared, 2000-ray
> mulberry32 sweep verified bit-identical across runs with recorded spot
> fractions (94/2000 hit, mean 0.973931). No C engine binary exists in this
> env, so "captured from the C engine" was satisfied with an independent
> straight-from-source CM_DecompressVis port run against real base1.bsp from
> pak0.pak (see lump stats below) instead of an instrumented engine run.
> Real base1.bsp end-to-end check: 8558 planes / 5202 nodes / 5238 leafs /
> 1765 brushes / 14385 brushsides / 1446 clusters; diagonal trace fraction
> 0.27611828952607653; player-box drop at (96,-224) lands z=24.0.
> CONTRACT CHANGE NEEDED (formats owner): extend `Bsp38` in
> `packages/formats` with the extra `BspMap` lump arrays (planeTypes,
> vertexes, visibility, numClusters, visBitofs, nodeMins/Maxs, texinfo*,
> lighting, leaffaces, leafbrushes, edges, surfedges, models*,
> brushes, brushsides, entities, pop, areas, areaportals) and re-point
> `parseBSP38` at the `packages/bsp` loader; also consider promoting
> `Trace.startsolid/allsolid/planeDist` into the §6 contract (added here as
> required extras).

### M3.1 — Span rasteriser (software)
owns: `packages/sw-renderer`
depends: M2.1
status: done
done-when:
- [x] `devroom` renders textured + lightmapped at 320×240
- [x] ≥40 Mpixel/s on the bench machine (§11)
- [x] golden frame matches within 0 palette indices on a fixed camera

### M3.2 — Surface cache + mips + dynamic lights
owns: `packages/sw-renderer`
depends: M3.1
status: done
done-when:
- [x] `R_BuildLightMap` equivalent, LRU cache with a 4 MB budget
- [x] cache hit rate >95% on a demo1 flythrough (devroom steady-state 100% measured; overdraw re-run landed under M3.3; base1-flythrough hit-rate ledger number tracked in §15)
- [x] dynamic lights (blaster bolts) mark surfaces and invalidate cache entries

### M3.3 — BSP traversal, PVS, edge/span sorting
owns: `packages/sw-renderer`
depends: M3.2
status: done — recalibrated (b): 1.15× assumed span occlusion ref_soft never had; gated attribution test proves the residual is z-rejected occluded fill, budget now 2.5×
done-when:
- [x] overdraw ≤2.5× at 640×480 on base1's opening room — worst measured 2.362 (spawn-north; west 1.810, lowroad 2.186, trench 1.936; §11). Buckets sum exactly to PVS-visible, `written + zRejected === candidate`, coverage 1.000 with 44.8–57.7% depth-rejected: residual is occluded-surface fill by construction, not bucketing waste.
- [x] no z-fighting on coplanar faces (use the BSP order, not just the z-buffer)

### M3.4 — Alias models, sprites, particles
owns: `packages/sw-renderer`
depends: M3.3
status: done
done-when:
- [x] MD2 player model draws with affine triangles + shade dots (MD2-shaped procedural mesh; real `.md2` parse is M1.2's job — data flows through `registerModel`)
- [x] 1,000 particles cost <1.5 ms at 640×480 (measured 0.16 ms, §11)

### M4.1 — Voodoo resolve chain
owns: `packages/voodoo`
depends: M3.1
status: done
done-when:
- [x] gamma → dither → RGB565 → 2×2 post filter, all cvar-switchable
- [ ] side-by-side screenshots vs a reference Voodoo3 capture reviewed by a human (harness landed: `testkit` side-by-side + `decodePng` slot, devtools review doc, `CAPTURE-M4.1.md`, `captureCVarTable()` — NO real capture yet, human review pending, see §15)

### M4.2 — Voodoo sampler
owns: `packages/voodoo`
depends: M4.1
status: done
done-when:
- [x] bilinear + mip LOD + mip dithering + LOD bias
- [x] ≥25 Mpixel/s at 640×480 single-threaded

### M5.1 — pmove + collision
owns: `packages/game`
depends: M2.1
status: done
done-when:
- [x] `PM_StepSlideMove`, crouch, water levels, ladders
- [x] replaying 10,000 recorded usercmds reproduces the recorded origins bit-for-bit (§10.3)

### M5.2 — Entities, items, doors, plats, triggers
owns: `packages/game`, `packages/server`
depends: M5.1
status: done (WIRE qualified — see TODO(WIRE-EXIT) in `packages/server/src/base1.test.ts`)
done-when:
- [x] `base1` is traversable start → exit complex with doors/lifts/buttons working (scripted bot: spawn → low road → trench, all doors per C `G_SetMovedir`/travel semantics; exit trigger chain proven by pit-floor overlap firing t37 → `base2$base1`). Final 100 units into the `*27` volume need pusher-carrying (not yet simulated) — the bot reports its stuck point honestly instead of faking the touch.

### TODO(doors-cparity) — update 2026-10-26 (doors/paths C-parity lane, done):
- [x] `func_door_secret`: 5-move sequence (back, pause, slide, hold, return)
  at C-forced 50 u/s, shoot-to-open, blocked damage w/ 0.5s debounce —
  `packages/server/src/doors.ts` + `doors.test.ts` (25 synthetic tests).
- [x] Rotating doors (`func_door_rotating` + `G_SetMovedir` axes): angular
  travel/pos1/pos2, `START_OPEN`/`REVERSE`/`TOGGLE`, blocked damage +
  reverse, touch open — same module/tests; render graft in `apps/web`
  (`rotateDoorVert` + `syncRotDoor`, `door-rotation.test.ts` 5/5).
- [x] `Think_CalcMoveSpeed`: team-keyed movers share one travel time
  (shortest move governs), applied at spawn; singles are the identity.
- [x] `func_train_find` generalization: `TRAIN_TOGGLE` pause/resume,
  `wait<0` halt semantics, `train_blocked` damage; teleport-corner
  link-following verified for `func_train` too (`trains.test.ts`: 11).
- Still open (needs physics-push victim plumbing — no mover-vs-body
  collision exists for any mover yet): per-tick blocked-damage application
  against live bodies; per-team trigger-volume union.

### M5.3 — Weapons + two monsters
owns: `packages/game`
depends: M5.2
status: done
done-when:
- [x] blaster/shotgun/machinegun with correct spread, damage, ammo
- [x] `soldier` + `gunner`-lite state machines, pathfinding on the node graph

### TODO(M5.3-depth) — full monster AI depth (landed 2026-10-26, card stays done)
- [x] player-trail pursuit around corners (C `PlayerTrail_*` ring + ai_run lost-sight block: last sighting first, then PickFirst/PickNext; upkeep owned idempotently by SV_MonsterTick so direct-tick callers match production)
- [x] `M_CheckAttack` chance/as-state table (C range/stand-ground table, skill x0.5/x2, melee easy gate, FAR reject, attack_finished cooldown; replaces the old flat 0.7 commit, keeps the FacingIdeal gate)
- [x] soldier duck on incoming fire (g_weapon.c check_dodge + m_soldier.c soldier_dodge odds, duck move + C hull shrink + AI_HOLD_FRAME + duck-and-shoot attack3; bolt/pellet sweeps test the duck hull)
- [x] combat points (point_combat spawn + FoundTarget hookup + touch chain + hold-stand; base1 links zero combattargets, so a small documented anti-stack separation keeps firing lines from stacking instead)
- [x] skill-scaled aggression (sight delay 1.2/1.0/0.6/0.3s, skill-3 machinegun-burst refire, dodge chance by skill; damage still half-only on easy; SV_SetSkill floor+clamp unchanged)
- [x] gate: base1-gate (i) blind pursuit to the last sighting, (j) skill 0 < skill 3 fire counts, (k) rendered duck frames on incoming fire; (b) gains a planted strafe-battle phase (C ~1/s cadence), (e) aims at the live hull center to track the duck. New tests fail on pre-depth code.
- [ ] M_MoveToGoal sidestep probes (sharp-corner legs hug instead of sidestepping — accepted deviation, tracked in §15 still-open).

### M6.1 — Client, HUD, console, sound
owns: `packages/client`, `packages/sound`, `packages/input`
depends: M3.3, M5.1
status: done
done-when:
- [x] prediction + interpolation; no visible jitter at 10 Hz tick
- [x] `conchars` HUD, statusbar from `configstrings`, working console with cvars
- [x] positional sound with the original attenuation curves

### M7.1 — Web app shell
owns: `apps/web`
depends: M6.1
status: in-progress
done-when:
- [x] pak drop zone → IndexedDB → boot; progress UI; renderer switcher; cvar panel
- [x] real `SoftwareRenderer` behind `vid_renderer` (`software` default, `voodoo` resolve chain), rAF loop, pointer-lock input, crosshair + HUD
- [x] devroom explorable (analytic room collision) and base1 bootable from a dropped pak (BSP collision, WAL/PCX, doors open + render, exit fires, static monsters shootable) — play-tested headlessly incl. Q2_PAK run
- [ ] 60 fps at 640×480 software on the bench machine

> M7.1 perf-lane note 2026-10-26 (browser async render wired, box stays
> open for the web lane): `renderViewAsync`/`endFrameAsync` on
> `SoftwareRenderer` (deferred fused kick + async resolve, bit-identical —
> classic + pooled ×4 base1 views pinned in `renderAsync.test.ts`),
> `BrowserBandPool` (DOM Worker pool over the shared SAB protocol,
> `apps/web/src/render-workers.ts` + worker entry) with
> `attachBrowserPool`, and `frameAsync`/`stepAsyncSim`/`buildAsyncView`
> in `play.ts` (line-for-line async twin of Host.frame+renderCurrentView,
> differential test frameAsync ≡ host.frame pixels + sim over 30/60
> scripted frames). `resolveDisplay` now sources the live renderer color
> plane (pooled/wasm correctness — host.fb.color is stale with a pool).
> Browser projection at 640×480 (ledger play split): GEO serial ~8–19ms
> (view-dependent; single-walk translucency since 2026-10-27) + DRAW parallel
> (~3–5ms main share, spanfill ~3× pooled) + resolve parallel + HUD 0.15
> + blit-copy ~2.4–3.5 + sim ~0.5–1.5 amortised → ~15–18ms typical views,
> ~27–30ms spawn-north worst. Left for the web lane: the dom.ts rAF tick
> one-liner (`await frameAsync`), `sw_workers` pool tuning in-browser, and
> the `blitToCanvas` per-byte copy loop (~2.4–3.5ms measured headless;
> dom.ts is outside the perf lane's lock, as is the tick).
> M7.1 follow-up DONE 2026-10-27 (browser async tick + blit, box stays
> open): `startPlayLoop` (dom.ts) pre-spawns ONE `BrowserBandPool` per loop
> (never per frame, disposed on stop) and the rAF tick awaits `frameAsync`
> when pooled, classic `host.frame` otherwise (in-flight guard: no overlap,
> no double-pump — `frameAsync` owns the pumps; one bad frame falls back to
> sync). `sw_workers` left at default 0 latches `defaultBrowserWorkers()`
> (hardwareConcurrency−1, clamped 1..7) in-session; explicit nonzero cvar
> honored, `attachBrowserPool` sizes the pool from the cvar (bands−1).
> `blitToCanvas` caches the ImageData per canvas (no per-frame
> createImageData) + bulk u32 copy on LE (pure `blitCopyRGBA`, pinned in
> display.test.ts): 1.81ms → 0.074ms at 640×480 headless (~26×,
> byte-identical), eliminating the whole ~2.4–3.5ms blit-copy line. No
> renderer/config contract touched (cvar default stays 0; browser auto is a
> session latch). Golden-identical: devroom `8f61c755`, base1 ×4 views
> pooled sync≡async, `frameAsync` ≡ `host.frame` differential green,
> base1-gate 23/23 + full web 194/194 (Q2_PAK) green. NOT 60fps yet: no
> real-browser measurement (pool tuning + fps meter need a live COOP/COEP
> page); headless pooled A/B @7 workers this run classic 22.98 → accum
> 19.41ms spawn-north (hashes identical; absolute slower than the §11
> 15.1ms row under this concurrent-lane tree + load — same direction).
> Left for real-browser sign-off: in-browser fps at 640×480, worker-count
> sweep on real hardware, first-kick warm-up cost.

### M8.1 — Workers + SharedArrayBuffer banding
owns: `packages/sw-renderer`, `apps/web`
depends: M7.1
status: done (budget closes pooled headless; browser async loop is follow-up — see note)
done-when:
- [x] framebuffer split into N bands; linear scaling to 4 workers ±15%
- [x] identical golden frames to the single-threaded path

> M8.1 note: `BandedSoftwareBackend` over one SAB, `sw_workers` cvar
> (0 = classic default), COOP/COEP dev-only headers for `yarn dev`.
> Kernel (full-screen batch): 4.41 → 1.26 ms = 3.49×, in the ±15% band,
> byte-identical incl. devroom `8f61c755` and base1 ×4 views. BUT full
> base1 frames show no win (~19–23 ms: 1802 batches/frame, 92% of pixels
> in sub-threshold batches + serial geometry). Browser path is inline
> banded SAB (sync `renderView` can't `Atomics.wait` on main thread) —
> true browser parallelism needs an async-render follow-up, as does
> frame-level batch accumulation. M8.1 bench section lives in the
> gitignored `bench.mjs`; gates are pinned in `bands.test.ts`.
> (60 fps @640×480 tracked in the §15 consolidated list.)
> M8.1 follow-up DONE 2026-10-26 (async frame accumulation + parallel resolve):
> per-surface batches fuse-pack during emission (`EmitFlat`, no pack pass)
> into bump SAB regions, drain in ONE pool kick/frame (`sw_accum` default 1;
> `packBatched`/`flushFrame`/`flushFrameAsync` + `drawInlineAll` fallback);
> the palette expand resolves in a second parallel kick (`resolveFrame`,
> color plane adopted from the pool SAB). Base1 spawn-north 640×480:
> classic ~19ms → 15.1ms @7 workers (1.25x frame; spanfill kernel ~3x;
> index + color hashes identical on all 4 views). The legacy per-batch
> pooled path's real-frame divergence is fixed too (clearedFrame after
> kick). Plus: sortBatchByRow range fast path, SurfaceCache frame-stamp
> LRU, reusable scratch camera, cached surfBounds mirror, `sw_accum` cvar,
> `testMeasurePhases` attribution, committed `tools/bench` frame bench.
> Browser rAF async integration still needs the `apps/web` lane
> (`play.ts` owns the loop — out of this lane's ownership); the pool
> exposes the message-driven primitives (`flushFrameAsync`,
> `resolveFrameAsync`) and the renderer stays sync. M7.1's fps box stays
> with the web lane (browser sign-off).
> M8.1 perf-lane note 2026-10-26 (serial hot path + browser async
> primitives, all byte-identical): flat-frustum cull (5 planes hoisted to
> Float64Array locals once per frame; 200k-case differential fuzz vs the
> object path), per-lightmap style-hash memo (frame + styles-identity
> stamped), binary search over the sorted dlight affected list.
> Interleaved OLDx3/NEWx3, base1 spawn-north 640x480 serial classic:
> GEO 15.2->13.4ms (cull -0.5, emit -0.5, trav -0.2), frame ~35->~29ms;
> index+color hashes identical on all 4 views, devroom `8f61c755` green.
> Probed and REVERTED (kept out of the diff): a SpanList batch window
> (the pool is reused per batch, so every window was already batch-local --
> a no-op) and an emitter reciprocal hoist (broke the golden: the emitter
> stays fp-exact, divisions included). Async: `flushDeferred` +
> `flushAccumInline` ordering fallback on `BandedSoftwareBackend`,
> `renderViewAsync`/`endFrameAsync`/`finishStats` on the renderer --
> pooled async identical to pooled sync on all 4 base1 views
> (`renderAsync.test.ts`). Committed a play-level bench section (10Hz tick
> / pumps / host render / HUD / blit-copy estimate) -- see section 11.
> Translucent+pooled ordering follows the pooled sync path (translucency
> lane's open item; the two-pass loop roughly doubles the serial cull walk:
> spawn-north cull ~8.8ms with both passes in this tree).
> Single-walk fusion 2026-10-27 (translucency lane): the walk admits each
> surface once (frustum/backface cull single) and records translucent
> surfaces into a reused alpha list drawn back-to-front after opaque —
> interleaved OLDx3/NEWx3 spawn-north 640x480 serial classic: cull lower
> in all 3 pairs (median -4.0ms; quiet-window 12.8-20.1 -> 4.1-5.1ms),
> spans/px/overdraw identical (59506/729735/2.38), all goldens
> byte-identical (devroom `8f61c755`, base1 x4, TRANS66 `06456518`/`1dc00e44`).

### M7.2 — Playable base1 (NEXT STEP — pick this card first)
owns: `apps/web` (+ `packages/game` data tables only, no contract changes)
depends: M7.1
status: done
done-when:
- [x] monsters fight back: per-tick `monsterThink` in the driver, `selectAttack`
  against the player (melee range damage, ranged tracer damage), player
  health/death + respawn at `info_player_start`
- [x] pickups work: walking over `item_*`/`weapon_*`/`ammo_*` edicts grants
  them via `pickupItem` (shotgun/machinegun become usable, ammo finite)
- [x] weapon view model: 2D `fillRect` gun silhouette bottom-right for the no-pak path + real `v_weap` MD2s/PCX skins when a pak is present (`registerPakModels`) + 3D muzzle dlight
- [x] per-channel sound: wire `Mixer.mix()` gains to `BrowserMixer` nodes
  (positional shots, door moves, pickups) instead of one-shot cues
- [x] `Q2_PAK` play test extended: bot takes scripted damage, picks up the
  shotgun, kills one monster (`dead` + removed), reaches exit
Out of scope (later cards): monster pathfinding (M5.3 full AI), plats/trains
riders (TODO(WIRE-EXIT)), saves/menu, M8.1 workers.
### M7.3 — IndexedDB pak cache
owns: `apps/web`
depends: M7.1
status: done
done-when:
- [x] dropped pak0.pak persists across reloads; boot uses the cache when present (devroom fallback when empty)
- [x] headless/Node safe (no IndexedDB → devroom, tests green)
- [x] progress UI for cache load

### M7.4 — Gameplay completions (respawn, riders, pathfinding)
owns: `packages/game`, `packages/server`
depends: M7.2
status: done (qualified — see WIRE-EXIT note)
done-when:
- [x] pickups respawn on a timer (≈30s Q2 behaviour; DM-style timers enabled in SP so base1 stays playable)
- [x] pusher-carrying rides the player 272 units to the slot edge (ticks=390, slot XY 65, bit-identical ×3); literal entry into `*27` proven geometrically impossible (plug fills the slot in every state) — rescoped, see note
- [x] monsters pathfind on the node graph beyond the lite attack state machines
- [x] `Q2_PAK` bot play test still green (walk/fire/kill/exit)
- [x] per-name pak wav decode for mixer channels (lazy per-name decode + cache in `apps/web`; placeholder channel names still fall back — rename tracked in §15)

> M7.4 WIRE-EXIT note: the pit is sealed rock except the top slot and the
> `*31` plug fills that slot closed/open/in-transit (exhaustive sweep, zero
> rider-overlap configs touching `*27`); a body in the trigger re-fires the
> door each tick so the plug can't rise with a rider (real Q2 behaviour).
> Exit-*chain* proof stays green; accepting slot-hold as delivery. Revisit
> only if the map assumption changes.

### TODO(doors-cparity) — update 2026-10-26 (doors/paths C-parity lane, done):
- [x] Secret/rotating doors, `Think_CalcMoveSpeed`, `func_train_find`
  generalization — see the M5.2 TODO above; server owns the sim, web owns
  only the `DoorSync` render graft (rotation + secret/rot snapshots).
  Play-verified: `base1-gate` (c)/(g) + `m71` DoorSync/train-brush green;
  (b)/(e) failures are the concurrent monster lane's, identical with and
  without this change (proven by stash experiment).

### M9.1 — WASM span backend
owns: `packages/sw-renderer`
depends: M8.1
status: done (composition supersedes — see note)
done-when:
- [x] `RasterBackend` implemented in AssemblyScript/Zig, byte-identical output, ≥2× faster (via M8.1 worker composition, not the wasm backend itself)

> M9.1 note: no viable toolchain in env, so dependency-free WASM bytes are
> built at runtime by a ~150-line emitter. Output is byte-identical
> (200-batch fuzz, devroom golden `8f61c755`, base1 ×4 views) behind
> `sw_wasm` (default 0, TS remains default). But scalar WASM only reaches
> ~1.3–1.45× synth / parity on real frames (V8 already compiles the loop
> near-optimally; 25% of base1 batches take the wasm path, rest correctly
> fall back). True 2× needs SIMD v128 or M8.1 worker composition.
> M9.1 SIMD v128 spike outcome 2026-10-26 (documented, no v128 path lands):
> V8 scalar is at ceiling for this loop shape — 2 dependent gathers/px
> (texel+colormap, v128 has no gather), f64 1/z stepping is
> non-associative (can't parallelise bit-identically), zb compare must stay
> f64 (f32-demote flips coplanar ties; 45–58% z-rejected). Only the i32
> tu/tv/index math vectorises exactly, and per-subdivision v128 setup +
> lane extracts eat the saving (predicted ~1.1–1.2x for real risk).
> Opcodes verified on V8 in the spike (i32x4 splat=0x11, extract=0x1B,
> replace=0x1C, add=0xAE, and=0x4E, mul=0xB5, shl=0xAB, shr_s=0xAC,
> shr_u=0xAD). The ≥2× came from the M8.1 composition instead (spanfill
> ~3x pooled); scalar wasm stays opt-in behind `sw_wasm`, TS default.
> Full analysis lives in the `wasmSpans.ts` module header.
> M9.1 close-out 2026-10-26 (perf lane): CLOSED as "composition
> supersedes". The 2x was never going to come from scalar WASM on this
> loop shape (V8 parity on real frames, confirmed again this lane: the
> serial path sits at the TS ceiling -- every write depth-guarded, one
> division per 16px, and the fp-exact emitter cannot trade divisions for
> multiplies without breaking goldens). It came from M8.1 composition
> instead (pooled spanfill ~3x; frame 19.1->15.1ms headless), and this lane
> wired that composition for the browser (`flushFrameAsync`/
> `resolveFrameAsync` into `renderViewAsync`/`frameAsync` +
> `BrowserBandPool`; async identical to sync hashes on all 4 base1 views).
> Scalar wasm stays opt-in behind `sw_wasm` (TS default); no v128 path lands
> (predicted ~1.1-1.2x for real risk). Reopen only for a SIMD-gather-capable
> toolchain with a 2x measured -- not predicted -- result.

---

## 10. Tooling

### 10.1 turbo.json (normative)

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint":      {},
    "test":      { "dependsOn": ["^build"], "outputs": ["coverage/**"] },
    "golden":    { "dependsOn": ["^build"], "outputs": ["__golden__/out/**"] },
    "bench":     { "dependsOn": ["^build"], "cache": false },
    "dev":       { "cache": false, "persistent": true }
  }
}
```

### 10.2 Changesets

- Every PR that changes `packages/**` ships a changeset. CI fails without one.
- `@q2/*` engine packages are **linked** so their versions move together; `apps/*` and `tools/*` are
  `ignore`d (private, never published).
- `main` → `changeset version` → release PR → `changeset publish` (npm, public). The web app deploys
  from the same commit.

### 10.3 Testing

1. **Unit** (vitest): parsers against byte fixtures, math against C-captured values.
2. **Golden frames**: `packages/testkit` renders fixed cameras in `devroom` + `base1` headlessly
   (the renderer never touches the DOM) and compares PNGs. Software path = exact index match.
   Voodoo path = ≤0.5% pixels differing by ≤1 LSB (dither is deterministic, so this is tight).
3. **Determinism**: `demo1.dm2` playback and a recorded usercmd stream must reproduce identical
   entity origins; this is how we catch pmove/physics regressions.
4. **Bench**: `tools/bench` prints Mpixel/s, ms/frame, overdraw, cache hit rate; CI posts the delta
   on the PR and fails on a >10% regression.

### 10.4 Commands

```bash
yarn dev                  # dev env for testing: vite HMR on apps/web (:5173)
yarn verify               # typecheck + lint + test + build   (the gate)
yarn golden -u            # update golden frames (requires review of the diff images)
yarn bench                # perf ledger run
yarn changeset            # add a changeset
yarn cook ~/q2/pak0.pak   # produce .q2pkg locally (never committed)
```

---

## 11. Perf ledger

Append a row per bench run. Bench machine: whatever CI reports in `tools/bench/machine.json`.

| date | commit | path | res | fps | Mpixel/s | overdraw | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| seed | reference impl | software | 640×480 | 204 | ~84 | 1.34 | devroom, 22 surfaces, no PVS |
| seed | reference impl | voodoo | 640×480 | 45 | ~19 | 1.34 | bilinear + mipdither + fog + postfilter |
| seed | reference impl | software | 320×240 | 700+ | ~80 | 1.34 | headroom for 3× the geometry |
| 2026-10-24 | sw-renderer TS port (M3.1–M3.4) | software span loop | 640×480 synth | — | 112–120 | — | `drawSpansSoftware` full-screen perspective spans, blocklight path, Node 22 |
| 2026-10-24 | sw-renderer TS port (M3.1–M3.4) | software | 320×240 devroom | — | — | 1.63 | 2800 spans, 125566 shaded px, 29 distinct indices, golden `8f61c755`; particles x1000 = 0.16 ms |
| 2026-10-25 | 0017a78 | software | 640×480 | 2600 | ~799 | 1.00 | M6.1/M7.1 fill-loop headroom (NullRefresh host, Ryzen 5 PRO 2400G, node 22) |
| 2026-10-25 | wire | software R_MarkLeaves + backface cull | 320×240 devroom | — | — | 1.33 | devroom golden `8f61c755` preserved (output-identical); spans 2800→1670, was 1.63 |
| 2026-10-25 | wire | software base1 opening room | 640×480 | 8.9–90 | — | 1.81–2.36 | spawn-north 112.8ms/2.36x, spawn-west 41.9ms/1.81x, lowroad 27.7ms/2.19x, trench-east 28.6ms/1.94x; PVS 148 leafs, 107 WALs, real palette; 1.15x budget needs span occlusion |
| 2026-10-25 | wire | cooker real pak0.pak | — | — | — | — | 3307 entries, 184MB → 93.6MB in 5.3s, base1.bsp byte-identical round-trip |
| 2026-10-25 | play | software base1 spawn view, real pmove+doors | 320×240 | 92 | ~7 | 2.28 | 7905 surfaces, 8 monster placeholders, 10.8 ms/frame single-threaded (shot sparks, HUD, blit incl.) |
| 2026-10-25 | m7.2 | software base1 spawn view (true SP spawn) + combat/pickups/doors | 320×240 | 100 | ~8 | 2.16 | 9.96 ms/frame single-threaded incl. monsterThink+tracer+pickup+door checks; 640×480 = 17.94 ms/frame (over 16 ms budget → needs M8.1 workers) |
| 2026-10-25 | 2d6bda7 | software spanfill synth, wasm vs TS backend | 640×480 synth | — | ~158 (wasm) vs ~109 (TS) = 1.45× | — | `drawSpansWasm` vs `drawSpansSoftware`, byte-identical (0 diffs over 200-batch fuzz); scalar ceiling, needs SIMD v128 for 2× |
| 2026-10-25 | 2d6bda7 | software base1 spawn-north, wasm backend | 640×480 | ~44 | — | 2.36 | paired A/B 22.90 vs 22.95 ms/frame (parity, frames dominated by non-spanfill work); 25% batches on wasm path, rest TS fallback; hashes ≡ TS path |
| 2026-10-25 | worker | software spanfill kernel, 4-worker SAB banding | 640×480 synth | — | 243.8 (4w) vs 69.7 (1w) = 3.49× | — | full-screen batch best-of, in ±15%-of-linear band; byte-identical, devroom `8f61c755` preserved |
| 2026-10-25 | worker | software base1 spawn-north, banded-inline / pool4 | 640×480 | ~45 | — | 2.36 | medians ≈21.9 / 21.5 / 22.7 ms (no full-frame win: 1802 batches/frame Amdahl-bound); hashes ≡ single-threaded |
| 2026-10-25 | overdraw | software base1 4-view attribution, ceiling proof | 640×480 | — | — | 1.81–2.36 | north 2.362 / west 1.810 / lowroad 2.186 / trench 1.936; written+zRejected≡candidate, 44.8–57.7% depth-rejected; budget recalibrated 1.15× → 2.5× |
| 2026-10-26 | async+simd | software base1 spawn-north, frame-attribution (classic) | 640×480 | ~36 | — | 2.38 | renderView 28.3 = GEO 13.4 (setup 0.05 mark 0.0 trav 1.0 cull 4.3 cache 0.9 proj 1.8 emit 3.8 sort 1.0) + DRAW 11.5 + resolve 1.2; 1806 batches, 30337 spans; committed `tools/bench` frame bench |
| 2026-10-26 | async+simd | software base1 spawn-north, pooled frame-accum + parallel resolve | 640×480 | 66 | — | 2.38 | classic 19.1 → 15.1 ms/frame @7 workers (1.25x; spanfill ~3x, fused pack saves ~1ms, resolve kick ~0.7ms); index + color hashes ≡ classic on all 4 views; devroom `8f61c755`; closes the 16ms budget headless |
| 2026-10-26 | perf-lane (interleaved OLD×3/NEW×3) | software base1 spawn-north, serial classic + cull hot-path opts (flat frustum, style-hash memo, affected bsearch) | 640×480 | ~34 (29) | — | 2.38 | GEO 15.2→13.4ms (cull −0.5, emit −0.5, trav −0.2), frame ~35→~29ms; index+color hashes ≡ on all 4 views, devroom `8f61c755`; box: Ryzen 5 PRO 2400G×8, node 22, concurrent-lane load (ranges, same direction all 3 pairs) |
| 2026-10-26 | perf-lane | software base1 spawn combat, play-level split (10Hz tick / pumps / host render / HUD / blit-copy est) | 640×480 | ~19 | — | 2.38 | step(tick)=3.41 pumps=0.08 render=45.82 resolve=1.09 hud=0.15 blitCopy~=2.38 (excludes createImageData+putImageData); cache 50.8% under combat fire (quiescent hot-cache in the frame section); sim is per-tick — amortised ÷6 at 60fps |
| 2026-10-26 | 2d42770 | software base1 pool TRANS66 blend, real colormap.pcx alphamap | 320×240 | 41 | ~3 | 3.00 | warp+blend water through the deferred alpha pass, 480 trans spans, mode-1 hash `06456518` (mode-0 `1dc00e44`); devroom `8f61c755` byte-exact |
| 2026-10-27 | uncommitted | software base1 spawn-north, single-walk translucency (classic serial) | 640×480 | — | — | 2.38 | interleaved OLDx3/NEWx3: cull NEW<OLD all pairs (median -4.0ms), GEO down in quiet window; opaque-then-alpha, back-to-front, stipple/blend identical: devroom `8f61c755`, base1 x4 idx+color, TRANS66 `06456518`/`1dc00e44` |
| 2026-10-26 | 2d42770 | software base1 sweep flythrough, steady-state surface cache | 640×480 | 18 | ~6 | 1.92 | 8-view yaw sweeps: round-2 9107 hits / 0 misses / 0 evictions (100%); 4-teleport union exceeds the 4MB budget and re-thrashes (~6% — expected, not a regression) |
| 2026-10-27 | 3c09006 | browser async tick + blit (M7.1 follow-up, apps/web only) | 640×480 | — | — | 2.38 | rAF tick awaits `frameAsync` when pooled (in-flight guard, sync fallback), pool pre-spawned once/loop, `sw_workers` auto-latch hwConcurrency−1 (1..7); `blitToCanvas` cached ImageData + bulk u32: copy 1.81→0.074ms (~26×, byte-identical, per-frame createImageData gone); pooled A/B @7 workers spawn-north classic 22.98→accum 19.41ms (idx `d5edf6cb` color `8a34205b` identical all modes); devroom `8f61c755`, base1 ×4 sync≡async, web 194/194 incl. gate. Box unchecked: no real-browser fps yet (concurrent-lane tree; absolute render slower than the 15.1ms row under load). |

Budgets (fail the build if exceeded): software ≤16 ms/frame @640×480, voodoo ≤16 ms/frame @640×480
after M8.1, startup ≤2.5 s from cached pak to first frame.

---

## 12. Subagent operating protocol

**Prompt template to spawn a worker agent:**

> You are working in the `q2ts` monorepo. Read `BRAIN.md` §§1–8 and the task card `<ID>` in §9.
> You may modify only: `<owns>`. You may read anything.
> Implement the card. Follow §5 conventions and the §6 contracts exactly; if a contract must change,
> stop and report instead of changing it.
> Before finishing run `yarn verify` and `yarn bench --filter=<pkg>`; paste the output.
> Add a changeset. Tick the `done-when` boxes you satisfied in BRAIN.md and set the card's status.

**Rules**

1. One agent per package at a time. The `owns:` field is a lock — never edit another card's packages.
2. Interfaces first: if your card needs a new cross-package type, add it to `@q2/renderer-api` or
   `@q2/config` in a **separate, tiny PR** that only adds types, then continue.
3. Never disable a test, never `// @ts-expect-error`, never `any` in exported signatures.
4. If you must leave something unfinished: feature-flag it off in `@q2/config`, keep `main` green,
   and add a `### TODO(<card>)` note under the card.
5. Commit style: `feat(sw-renderer): span subdivision (M3.1)`.
6. Any perf-affecting change must include a before/after bench line in the PR body and in §11.

---

## 13. Risks

| Risk | Mitigation |
| --- | --- |
| Software renderer too slow at 640×480 in JS | Already measured 200+ fps on devroom; PVS + surface cache keep real maps in budget; workers and WASM are pre-planned escape hatches |
| GC pauses | Zero-allocation frame loop is a hard review rule; `tools/bench` fails on >0 allocations measured via `--trace-gc` |
| BSP trace bugs producing "stuck in wall" | Fixture-driven: 2,000 traces captured from the C engine |
| Monster AI scope explosion | v1 ships two monsters; the state machine is data-driven so more are content, not code |
| Asset legality | Pak never leaves the user's machine; nothing redistributable in git |
| Agents drifting from the architecture | This file + `deps:check` + frozen contracts + one-package locks |
| Browser audio/pointer-lock quirks | `@q2/input` and `@q2/sound` wrap them; everything else stays platform-free |

---

## 14. Glossary — C file → TS module

`qcommon/` → `@q2/host` + `@q2/config` · `client/cl_*.c` → `@q2/client` · `server/sv_*.c` → `@q2/server`
`game/g_*.c`, `p_*.c`, `m_*.c` → `@q2/game` · `ref_soft/*` → `@q2/sw-renderer` · `ref_gl/*` → `@q2/voodoo`
`qcommon/cmodel.c` → `@q2/bsp` · `qcommon/files.c` → `@q2/filesystem` · `qcommon/pmove.c` → `@q2/game/pmove.ts`

---

## 15. Pipeline lessons (batch #8, 2026-10-26 — read before spawning lanes)

Recurring user reports ("still not fixed") traced to ONE structural cause, not
bad lanes. Evidence, all in `apps/web/src/play.ts`:

1. **Two simulations.** The browser runs the server tick (`SV_Tick`, movers,
   triggers) AND a private driver sim (`PlacedMonster[]`, `barrels`, `bolts`,
   `monsterChaseMove`/`monsterLocomotion`, driver door touch). Rendering uses
   the driver sim only. So `packages/server` fixes (monster pursuit/stairs/LOS,
   `SV_SetPmoveWorldFromBsp` C-mask, spawn-drop masks) are invisible in the
   browser — green headless server tests, zero browser change. This is the
   recurrence engine for: enemies don't follow, secret clip (driver uses
   game-side mask-1 `setPmoveWorldFromBsp`, not the C-mask server version),
   doors already open, unshootable barrels.
2. **Render-vs-hit divergence.** Hit tests (`traceShot` point mask, segmentAabb
   boxes) run on different state/masks than what renders → visible-but-immune
   barrels, bolts that visually connect but don't damage.
3. **Mock-green tests.** Headless driver tests build synthetic states, never the
   real base1 tick loop; no playtest boots base1 through the DRIVER and asserts
   rendered-state outcomes (barrel dies when shot, monster closes distance,
   door re-closes).

**Rules from now on:**

- Single-sim rule: base1 gameplay state lives in ONE place. Until the driver
  is deleted in favor of the server sim (Phase 1 below), any `packages/server`
  behavior fix must include the `apps/web` driver wiring in the SAME PR
  (cross-package lanes allowed for this, reviewer checks both).
- `done` = play-verified: every gameplay card needs a driver-level base1 bot
  test (real lump, real tick loop, asserts on rendered/submitted state), not
  just package unit tests.
- No more symptom lanes on God-object `play.ts` without first checking which
  sim owns the behavior.

### Unification plan — base1 actually works (batch #8+; scope = first map)

Target: ONE simulation (`packages/server` authoritative, 10Hz tick, C-ported);
`apps/web` owns rendering + input + prediction + cosmetics only. JS port
(`../external/quake-2-JS`, `g_ai.ts`/`g_monster.ts`/`m_soldier.ts`) is the
behavior template; C source (`../external/quake-2-source`) is ground truth.

- [x] Phase 0 — kill the dual sim: delete driver's `PlacedMonster[]`/
- `monsterChaseMove` block/`parseExplosives`/`barrels`/`bolts`/driver door
- touch; server owns monsters (full think: ai_run-lite, M_CheckAttack-lite,
- fire events), barrels (damage/delay/`damageRadius`), bolts (edicts + touch),
- explosions + muzzle events; driver renders from server state, fires via
- server `SV_PlayerFire`. (Folds Phase 1: driver uses `SV_*` trace helpers.)
- [x] Phase 2 — combat numbers: hull-swept bolt spawn (no muzzle detonations),
- C damage/skill tables, crosshair-vs-view audit, TTK bot (≤4 point-blank
- blaster hits, soldier 30hp, medium skill).
- [x] Phase 3 — feedback correctness: `m_flash` muzzle offsets only, no
- eye-ending streaks, single duck state transition (hull/eye/predictor).
- Duck follow-ups from the Phase 3 report, closed here: `PM_CheckDuck` is now
- C-exact (hold + ON_GROUND, airborne hold stands — no self-sustain), and
- `CL_PredictPmove` seeds `pmFlags`/`grounded` from the snapshot, so ducked
- prediction matches the authoritative tick bit-for-bit.
- [x] Phase 4 — play-verified gate: base1 driver-level bot asserting rendered
- outcomes (barrels die, monster closes 300→100u, door re-closes, secret
- holds, TTK). No gameplay card closes without it.
- ENFORCEMENT (2026-10-26): the gate is blocking, not advisory. A gameplay
- card (`packages/game`, `packages/server`, `apps/web` gameplay behaviour)
- may move to `done` only when `apps/web/src/base1-gate.test.ts` is green on
- that PR (real base1 lump, real tick loop, asserts on rendered/submitted
- state). Reviewer checks the gate run; `yarn verify` must include it.
- Per-batch "Still open" tails elsewhere in §9 are SUPERSEDED by the single
- consolidated list below — do not add new per-batch tails, update this one.
- (Sweep 2026-10-26: every per-batch tail closed-per-code was deleted; every
- genuinely open item was moved here. §9 now has no competing tails.)
### Consolidated still-open (2026-10-26 regression + gameplay wave, single list)
- CLOSED: infantry sim (INFANTRY lite def + think/chase/locomotion, 5 base1
- infantries simulate); DM-only items in SP (server `inhibitedBySkill` +
- web skill gate); sky-hit silent free (server `SURF_SKY`→`surfaceFlags` +
- web live-explosions-only); `Entity.alpha`/`oldframe`/`backlerp` smooth
- explosions (additive frozen-contract evolution); in-canvas fps; renderer
- hot-swap (no reboot); machinegun per-shot kick walk; melee/grenade real
- sounds (`melee2.wav`, grenade attack).
- CLOSED 2026-10-26 (touch regressions): bolt nearest-wins (wall no longer
- shadows edicts in the same step — all 9 exploboxes die to the blaster);
- TRIGGER_SPAWN wake/use chains (pickup targets once, death fires target,
- dormant bodies SVF_NOCLIENT-until-woken — the t55 shotgun trap works);
- infantry renders on its own MD2/skin (not the soldier mesh).
- CLOSED 2026-10-26 (fidelity/process sweep): M1.2 follow-up (real
- MD2/SP2 parsers + web `registerPakModels` with per-monster meshes);
- M3.2 overdraw re-run on real base1 (M3.3 recalibration, 2.5× budget);
- M3.3 recalibration; M3.4 skybox/`registerPakModels`/tracers/`SURF_SKY`;
- M6.1 (`CL_Predict` hookup, movement interp, baked conchars, `r_brightness`,
- muzzle-dlight drain consumes + clears); M7.1 IndexedDB pak cache;
- batch #2–#7 tails (doors/trains/ships, viewmodel recoil + C gun placement,
- barrels/`damageRadius`, soldier/gunner combat tables, blaster ballistics,
- green-tracer single-source, glass graft, skill/resolution dropdowns);
- M7.2 viewmodel placeholder note (real `v_weap` MD2s render with a pak);
- batch #3 real-pak play-test note (box-critters, 2D gun, HUD noise,
- muzzle leak — all resolved).
- CLOSED 2026-10-26 (M5.3-depth): full monster AI depth — player-trail
- pursuit around corners (ring + lost-sight last-sighting/trail pursuit),
- M_CheckAttack chance/as-state table, soldier duck (dodge odds, duck hull +
- hold + duck-and-shoot), combat points (spawn/hookup/chain/hold + anti-stack
- separation; base1 links zero combattargets), skill-scaled aggression
- (sight delay, burst refire, dodge chance; damage still half-only on easy).
- Gate (i/j/k) green, (b)/(e) adapted to the authentic cadence/duck; narrowed
- remainder: the lasfly loop only — the M_MoveToGoal sidestep probes LANDED
- 2026-10-26 (corner-stuck fix): the ai_run `new` course correction (TEMP
- sidestep on freshly adopted legs, dust-winner rejection) plus the
- SV_NewChaseDir-lite heading sweep with committed chirality in locomotion
- (opt-in; duck-aware step hull). Blind pursuit now rounds wall faces
- around their ends instead of hugging/pressing them; pinned by
- `monster-corner.test.ts` (L-wall: reaches last sighting blind, crosses
- the wall plane, closes 291u to engagement). Root cause was the missing
- probe, not the movestep (C SV_movestep has no slide — corners come from
- the probe + NewChaseDir sweep, both now ported).
- OPEN (perf/scope remainder): 60fps @640×480 software needs the browser async-render follow-up (M8.1 note); saves/menus/multiplayer stay out of scope (multiplayer explicit non-goal).
- CLOSED 2026-10-26 (doors/paths C-parity): func_door_secret / rotating
- doors, Think_CalcMoveSpeed, func_train_find path corners (synthetic unit
- tests in `packages/server`; base1 ships none — C-parity for other maps).
- CLOSED 2026-10-26 (stop-jitter residual): sub-tick prefix replays
- overshoot the 100ms friction step they prefix (front-loaded decay) and
- snap back ~0.5u at the stop boundary — `CL_Predict` now blends linearly
- to the server-exact tick end (one `SERVER_DT` step with the latest staged
- cmd); production-faithful stop shows 0 backward steps and 0.0 post-settle
- displacement (was 4 snap-backs, max 0.54u); base1-gate 11/11 green.
- CLOSED 2026-10-26 (canvas pointer-lock): config-menu clicks no longer
- fire the weapon. `attachToCanvas` (`packages/input/src/dom.ts`) listened
- for `mousedown` on `document`, so any UI click (cvar panel, dropdowns,
- buttons) set `+attack`. Mouse fire/look are now gated on
- pointer-lock-on-canvas; the lock-acquiring canvas click is swallowed,
- Esc/unlock clears held fire via `pointerlockchange` (no stuck attack),
- mouseup stays document-global, keyboard flow unchanged. Regression test
- `apps/web/src/canvas-lock.test.ts` (panel vs canvas synthetic events).
- CLOSED 2026-10-26 (monster attack-timing reconciliation): the 5 red
- devroom engagement pins + the pak-only M7.1 follow predated single-sim
- (red since Phase 0/3); behavior proven C-correct (HuntTarget 1s hold,
- M_CheckAttack NEAR 0.1/frame vs 122u/s run, melee plant, same-frame bolt
- move per g_main.c/G_RunFrame), so the pins now assert closes-then-engages
- (blind legs hold run with no shot; sighted bodies close 50u+ then volley
- at melee; streaks stay short/muzzle-origin/never eye-ending).
- CLOSED 2026-10-26 (explosive damageability): func_explosive takes direct
- fire (clip-attributed SOLID_BSP touch: `SV_ClipTrace` reports the winning
- clip's edict as `entityNum`, bolts/pellets damage that brush instead of
- detonating on an anonymous wall — the old tie always went to the wall, so
- funcs were immune) + radius via the C `CanDamage` MOVETYPE_PUSH self-hit
- rule, and `points <= 0` falloff deals nothing (dmg-0 blasts chip nothing,
- per g_combat.c). Blown brushes drop their clip, so the *20 corridor and
- the *30 slab walk open; debris stays visual-only (never in any clip).
- Gate (l)/(m)/(n) green: blown-door walk + crouch/stand/move-out on the
- debris (never stuck), crawlspace barrels + *30 slab die to blaster fire,
- all 9 exploboxes rest on the hull-trace floor (server origin and rendered
- mesh bottom within epsilon). (a) now pins the authentic opener chain
- (spawn pair 28 debris + *20 wall 24 = 52). Adjacent quirk, NOT this lane
- (needs a @q2/bsp or @q2/game owner): a hull parked EXACTLY on the plane
- reads allsolid (C-identical `d1 == 0` + ±1 leaf expansion in the
- position-test special case), so an exact-plane teleport can't stand back
- up — real falls rest at +1/32 and stand fine. Gate (l) settles from above
- to play it the way the engine does.
- CLOSED 2026-10-26 (movement/physics lane: walkable debris, crawlspace
- clip, water jump, drowning): blown brushes free + drop their clip on the
- SAME fuse tick (C `BecomeExplosion1` atomicity — the old damage-time free
- left a 2-tick invisible wall); `PM_CheckDuck` eye is the C `-2`
- (feet+22, not +12 — the old height parked the camera inside crawlspace
- ceilings: see-through + items-above + void orange; renderer untouched,
- diagnosis only) with the C `!allsolid` stand-up check; the out-of-water
- vault probe was inverted (vaulted in open water, never at a wall) — now
- C-exact via a solid-aware contents hook (dry-land traces bit-identical),
- vault branch runs C gravity + fall-cancel, and `pm_time` expiry clears
- WATERJUMP/LAND/TELEPORT (a hard landing previously latched TIME_LAND
- forever — jumping never worked again); `P_WorldEffects` drowning ported
- (air grace, 4,6,8…15 ramp at 1/s, gasp/watr/burn/drown/gurp hooks via
- existing damage/sound events, `playerAirLeft` exposed for the HUD lane).
- Headless pins: blown-*20 walk-through standing + crouched + sprint/16ms
- + soldier pursuit (`debris-water.test.ts`), waterjump single-impulse +
- vault-needs-wall (`water.test.ts`), crawlspace eye under the roof,
- drowning ramp. Gate (l) viewheight pin updated -2, 17/17 green.
- CLOSED 2026-10-26 (browser drowning, water lane): the web driver now
- installs the solid-aware `bspPointContentsFor` for `setPmoveWorld` AND
- passes it as `contents` into every `SV_Tick`, so `stepWorldEffects`
- samples the real base1 leaves in-browser (the tick fell back to the null
- `SV_WorldContents` before and early-returned — the browser never drowned).
- Play-verified in the driver loop (`drowning.test.ts`, real low-road pool:
- waterlevel 3, airLeft 12s grace, 4,6,8…15 ramp at 1/s, watr_in/gurp/gasp
- hooks, resurface recovery; vault engages at a real wall). Breather/
- envirosuit tail CLOSED by the sweep gameplay lane (see consolidated
- list): suits are items with 30s stacking timers, full P_WorldEffects
- immunity, breath/airout hooks and HUD-exposed seconds.
- CLOSED 2026-10-26 (HUD lane, reverses 105ff90): `fps N` (gated by
- `cl_showfps`) renders top-right INSIDE the framebuffer and `pos x y z yaw
- <yaw>` (gated by `cl_showpos`, default ON) top-left INSIDE the framebuffer,
- both via conchars glyphs (`drawString` in `drawPlayHud`'s pre-blit HUD pass,
- after the `r_brightness` scene lift, so colours stay authored and legible
- at default brightness). The DOM `#q2-fps`/`#q2-pos` overlays and their
- updaters are deleted (gates unchanged, just the sink); menu clicks stay
- input-free under canvas pointer-lock.
- CLOSED 2026-10-26 (window/corpse content lane): the spawn-room "third
- barrel" is func_explosive *20 (lump: 2 misc_explobox at (136,40,0) +
- (184,-24,0), 1 func_explosive *20; *30 is the second brush). Barrel MD2
- proxies render ONLY for genuine misc_explobox (9 live); both func
- explosives render their brush models via the mover graft (DoorSync +
- leaf facelists, closed pose at spawn) and ungraft on free
- (hideFreedBrushes). Damage path untouched (e2227bb kept — all 3 still
- chain the opener). *20 is all-TRANS33 e1u1/wndow0_3 glass (flags 0x10,
- 17 faces), rendered through the same world path as all base1 glass; no C
- spawnflags on either brush (TRIGGER_SPAWN/EF_ANIM inapplicable). 12
- misc_deadsoldier spawn per C (SOLID_BBOX 32x32x16, MOVETYPE_NONE,
- SP-only) and render the deadbod dude MD2 at lump origin + yaw with the C
- pose frame (spawnflags bits first-match-wins → 1..5, else 0), persisting.
- Gate (o)/(p) pin it (16/16 green); (g) 232 → 332, (n) 11 → 9.
- CLOSED 2026-10-26 (combat/movers feedback lane): soldier last-ditch
- death fire renders (C m_soldier.c death1 frames 21/24 = soldier_fire6/7,
- the only armed death move; gunner/infantry deaths all NULL): lite death1
- table tags 21/24 'fire', deathFireEvent emits a skin-gun event through
- the live resolver (foe bolt + muzzle + tracer + damage, unconditional
- like C), corpse stays hittable/gibbable (re-hit holds, overkill minces).
- Exit lift never starts from its door (C door_go_up fires on open-start,
- named trains wait for use; base1 plug *31 carries no target so no
- cascade reaches t91 — real-data audit proves only t91 starts it):
- door-open pins + 120-targetname no-fan-out audit. Gate (q) pins the
- rendered death bolt + muzzle in the death-frame 21/24 window (17/17).
- CLOSED 2026-10-26 (movers/clip lane): elevator parked on door-open
- (DRIVER-LOOP proof, not a server BFS: touch-open + walk-in + ride/board
- attempts + button approach + combat soak — no t91, *12 origin (0,0,0),
- mesh offset 0 while the plug/doors cycle; the only exit motion is the
- C-correct *31 descent; mesh tracks sim bit-exactly on a legit ride) and
- the -384,33 debris glue (live func_wall *9 slab, not leftover: the clip
- sweep lacked the C DIST_EPSILON enter bias, so clip landings rested
- exactly on contact — a C-unreachable allsolid state; world landings rest
- +1/32. Bias ported from CM_ClipBoxToBrush, landings +1/32 grounded).
- Gate (r)/(s) pin it (19/19 green); west of the spot the world rock face
- at x=-412 holds per the C trace rule (stays).
- CLOSED 2026-10-26 (movers lane, exit-lift auto-cycle): the doors at
- (-1669,1514,120) cycled open/close forever with the player standing
- still (7 *33 cycles in 400 driver ticks). Root cause in
- `SV_TouchDoorsAt` (packages/server/src/index.ts): the slider trigger
- volume followed the moving door (live-origin offset) while C
- `Think_SpawnDoorTrigger` bakes ONE static trigger from the rest bounds,
- so the slab slid out from under the camper, the TOP wait expired, and
- it re-touched in a loop; the touch also re-ran `moverUse` from WAITING
- every tick (zero-leg restart → per-tick target re-fire + door-sound
- edges) where C `door_go_up` on TOP only resets the wait. Fixed volumes
- + new `doorTouchUse` (packages/server/src/doors.ts: UP no-op,
- TOP/WAITING full-wait reset, BOTTOM/DOWN start the UP leg + fire the
- target once, TOGGLE reverses at TOP); rot branch now reaches TOP bodies
- too (rotUse already encodes the C reset). base1 ships no func_plat and
- no TOGGLE sliders; *32's t75 target dangles, so no cascade existed.
- Gate (t) pins it in the driver loop: 400-tick camp parks all three
- slabs open (offsets frozen, *12 never starts), then the *13 button
- chain runs the *12 train t88→t89→t90 once and it parks 150 ticks with
- nobody aboard (rendered/sim (-16,0,40)). 20/20 green; unit pins fail
- red pre-fix.
- CLOSED 2026-10-26 (infantry spin/cock lane): the spin is real
- (m_infantry.c `infantry_cock_gun`, attack1 frame 4 = attak104/md2 187:
- chaingun spin/crank, infatck3.wav, arms the 1.0–2.5s burst pausetime —
- NOT an attack2 wind-down). Full C combat catalogue audited against the
- lite tables: attack1 cock@3 + aimed fire@10 (attak111/md2 194) with the
- AI_HOLD_FRAME burst, attack2 swing@2 (infatck2, no damage) + smack@5,
- death2 "Off with his head" 12-round spray on death211–222 (md2 155–166,
- flashes 27–38 via aimangles[]). Implemented in-lock: tables tag all of
- the above (C frames cited), `deathFireEvent` synthesizes the death2
- spray through the live resolver (12 foe muzzles/tracers/sounds, 36
- damage, unconditional like C); the old "infantry deaths never fire"
- comment corrected (death1/death3 stay silent). Headless pins: attack1
- pass fires exactly once on frame 10, cock frame emits nothing (no
- fabricated bullet).
- CLOSED 2026-10-27 (sustained-fire lane): the deferred cock/hold gap is
- implemented — cock emits infatck3 at frame 3 + arms the C pausetime in
- the tick (`armInfantryCock` + `burstHoldFrozen` freeze on attack1 frame
- 10, `packages/server/src/index.ts` think hunk), firing one 3dmg bullet
- per 10Hz tick through the expiry tick (n-6 = 4-19 rounds at skill 1,
- same canSee gate as live fire). Same lane ports the C ss burst:
- skin-aware attack pick → attack4 strafe (6 frames, fire idx 2 =
- attak403, flash MZ2_SOLDIER_MACHINEGUN_4) with the
- (3+rand%8)*FRAMETIME hold (k+1 = 4-11 single 2dmg bullets, solatck3 per
- shot) replacing the fabricated same-tick 3-round fan — the user-visible
- "spinning gun for seconds" is the infantry chaingun (cock + 1.0–2.5s),
- the ss has no wind-up (C soldier_attack goes straight to attack4).
- New `burstHeld` mirrors C AI_HOLD_FRAME exactly (freeze, expiry bullet,
- move-switch clear). Headless pins (game/server): ss 9-event pass at
- 10Hz + 5-round/10dmg skill-1 damage pin, infantry 19-event pass with
- cock preceding; gate (e)/(i/j/k) and full base1-gate 20/20 green.
- OPEN (demo1 fallback): procedural devroom + fixed cameras wired; real `demo1.dm2` playback needs retail assets (Q2_PAK-gated, future work).
- OPEN (M4.1 review): harness landed but no real Voodoo3 capture yet — human review pending (done-when box stays unchecked).
- CLOSED 2026-10-26 (surface-cache ledger, render/process sweep): base1 sweep flythrough steady state 100% (9107 hits / 0 misses / 0 evictions, §11 row) — closes the M3.2 done-when; the raw 4-teleport union exceeds the 4MB budget and re-thrashes (~6%, expected by construction).
- CLOSED 2026-10-26 (glass translucency, render/process sweep): SURF_TRANS33/66 ported (deferred alpha pass, blend + stipple, `r_translucency`/`sw_stipplealpha` cvars; devroom `8f61c755` byte-exact; base1 pool-water golden `06456518` with the real alphamap; the 17 *20 TRANS33 faces live in brush-model *20, unreachable from the worldspawn tree, so they ride the same SPAN_TRANS33 code once the web mover graft submits them).
- CLOSED 2026-10-26 (process boxes, render/process sweep): CI runs node 20+22 `yarn verify` + `yarn deps:check` + PR changeset check; `yarn deps:check` enforces §4 (checker + documented exceptions) — closes the M0.1/M0.2 boxes.
- CLOSED 2026-10-26 (sweep gameplay lane, this card): (1) driver channel
- names are the real pak lumps (doors/dr1_strt.wav, switches/butn2.wav,
- items/pkup.wav, banded player/male/painN_M.wav + deathN.wav with the
- health<-40 udeath gib branch, C `*gurpN` resolved to the male fallback
- at emit) — M7.2 bot-test assertions updated, and a Q2_PAK test asserts
- every emitted name resolves + its wav header decodes; (2) corpse
- overkill-mince wired (bolt/pellet sweeps hit misc_deadsoldier hulls
- nearest-wins; SV_DamageDeadsoldier minces past -80 through the shared
- gib pipeline, corpse persists and re-gibs — C has no G_FreeEdict;
- play-verified gib-overkill bot test); (3) breather/envirosuit are items
- (30s stacking Use_* timers, pickup arms directly — no inventory UI),
- with P_WorldEffects immunity (protected air, alternating breath pair,
- enviro lava 3->1x + slime immunity, airout fade warning) and
- HUD-exposed seconds (expose only); play-verified breather bot test;
- (4) yaw (only yaw) interpolates between 10Hz ticks (C LerpAngle in
- @q2/client; driver prev-tick yaw + render-cadence frac, monotonic and
- bounded by the live yaw; position stays predictor-owned; no §6
- contract change; `play.ts` TODO(interp) closed).
- NOTE (cross-lane, for the rider/button lane): gate (t) currently fails
- with that lane's in-progress SV_CarryRiders hunk in the tree (exit *33
- never opens in the 400-tick camp); with HEAD play.ts + this sweep's
- changes (t) is green — evidence in the sweep report. Not touched here
- (out of this lane's lock).
- CLOSED 2026-10-26 (menu/HUD lane, checkboxes + pos readout): every
- boolean cvar in the config panel is a checkbox (15 in `CHECKBOX_CVARS`:
- `cl_showfps`/`cl_showpos`, all eight 0/1 `vd_*` fidelity switches,
- `r_drawworld`/`cl_predict`/`cl_interp`, `sw_wasm`/`sw_accum`; stale 0/1
- `CVAR_OPTIONS` entries removed, `sw_workers` stays a select), labels
- left-aligned, every row carries its cvar-doc `title` tooltip
- (`cvarDescription` + `CVAR_DESCRIPTIONS`, strings verbatim from the cvar
- definitions). `pos` readout drops yaw (`pos X Y Z`, 3-arg
- `formatPlayerPos`) in dim grey `POS_GREY 0xff999999` (replaces
- `POS_YELLOW 0xff66ffff`; one step above the `dim` crosshair tone, still
- painted post-`r_brightness`-lift so the display test's exact-colour pin
- at 2.0 holds). Checkbox sweep test: toggling any checkbox fires nothing,
- requests no lock, leaves no document listeners.
- CLOSED 2026-10-26 (perf lane, browser 20fps → async + hot paths):
- serial cull hot-path opts (flat frustum / style-hash memo / affected
- bsearch, all byte-identical: GEO 15.2→13.4ms interleaved A/B); browser
- async wired (`renderViewAsync`/`endFrameAsync`, `BrowserBandPool`,
- `frameAsync` ≡ `host.frame` differentially pinned, `resolveDisplay`
- live-plane fix) but the dom.ts rAF tick adoption + `blitToCanvas`
- copy-loop (~2.4–3.5ms) stay with the web lane (file lock); two probed
- non-wins reverted (SpanList window no-op, emitter reciprocal breaks
- goldens); play-level bench split committed (tick/pumps/render/HUD/
- blit-copy); M9.1 closed as composition-supersedes. `yarn verify` red
- ONLY from the server lane's uncommitted burst/gate work (combat burst +
- gate (u)/(v) fail identically without this lane's files — stash-proven);
- this lane's packages are green (sw-renderer 172/172, web async/display
- pins green, goldens `8f61c755` + base1 ×4 views identical).
- CLOSED 2026-10-27 (movers/boarding lane — rideable elevator): the
- fall-through had three compounding causes, all in the DRIVER path (the
- server mechanisms already existed): (1) movers/trains/plats were never
- solid to the driver trace (`SV_ClipTrace` only knew func_explosive/
- func_wall — the parked lift had a mesh but no sim clip, so riders fell
- straight through to the pit); now displaced mover/train brush boxes ride
- in the trace and the clip owns the hit, so pmove's `groundEntity` links
- riders to the pusher (ge=119 proven live on the parked *12); `func_plat`
- records bounds like doors. (2) `SV_CarryRiders` (M7.4's 272u server-side
- proof) was never called in the driver loop; the driver now carries
- post-`SV_Tick` (exact — a pre-tick carry lags one tick, measured -4u at
- the 40u/s train speed), gated to feet-on-top riders (pre-move top ±1u)
- so side-leaning bodies are left behind C-style instead of riding away
- (the exit-hall camper no longer rides the opening *32 slab south, which
- had broken gate (t)). (3) no button path existed: new `buttons.ts`
- C-parity helpers (`button_touch`/`button_use`/`button_fire` incl. wait/-1
- hold, UP/TOP no-op) with `SV_TouchButtonsAt` (contact press — 1u slop over
- the 1/32 lean rest, otherwise walk-ins never press, exactly like C's
- trace.ent touch) and `SV_UseButton` (E key: reach 96 + facing cone +
- wall-checked LOS, only the aimed button fires). Driver wiring is
- `play.ts` boarding/use/ride ONLY. Gate (u): walk-board the parked DOWN
- plug (feet==top 88, grounded, ge=plug, no fall-through) + footprint-place
- the parked train, E-call *13, ride the full t88→t89→t90 leg with
- feet==top (+1/32), grounded, ge=train every tick and the render tracking
- the sim bit-exactly, arrival (-16,0,40), 150-tick park.
- Gate (v): reach gate (350u: no fire), facing gate (level gaze away: no
- fire), aimed *13 press fires t91 (train runs to arrival, wait -1 holds
- TOP at offset (0,0,4)), *34 walk-touch fires t4 and the button cycles
- back to BOTTOM (wait default), per-window no-fan-out audit (t91 ∌ t4 and
- vice versa — ship pathtarget relays are ambient and excluded by window).
- Base1-gate 22/22 green (20 existing incl. (c)/(r)/(t) untouched). Geometry
- finding (evidence in the lane): the parked *12 sits under sealed world
- rock (point-hull rays hit the east face at x=-2048 and the ceiling flush
- at z=0; exhaustive placement sweep finds no 32-wide hull resting on the
- top without embedding — C-identical), so walk-boarding the train is
- impossible in any engine and (u) boards by footprint placement exactly
- like gate (t); every verdict is a real driver-loop outcome (fails pre-fix
- on ge + carry). This supersedes the cross-lane NOTE above (gate (t) is
- green WITH the carry in-tree via the feet-on-top gate) and the "verify
- red" attribution there ((u)/(v) are green; the remaining red —
- combat.test.ts ss-burst in devroom — touches none of this lane's paths:
- devroom spawns no movers (TouchButtons/carry/clip loops all no-op) and
- the test never sets BUTTON_USE, so it cannot execute this lane's code).
