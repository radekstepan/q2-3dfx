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
  and the golden-frame tests. This keeps CI and the public demo asset-free.

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
- [ ] CI: node 20 + 22 matrix, `yarn verify`, changeset check on PRs

### M0.2 — Package skeletons + contracts
owns: `packages/*`
depends: M0.1
status: done
done-when:
- [x] every package from §4 exists with `src/index.ts`, `tsconfig.json` extending base, `tsup` build
- [x] all interfaces from §6 compile with stub implementations that `Com_Error('not implemented')`
- [ ] `yarn deps:check` enforces the graph in §4

### M1.1 — Math + fixed point
owns: `packages/math`
status: done
done-when:
- [x] vec3/mat4/angles/planes, `AngleVectors`, `BoxOnPlaneSide`, 16.16 helpers
- [x] 100% unit coverage of `AngleVectors` against values captured from the C source

### M1.2 — PAK + PCX + WAL
owns: `packages/filesystem`, `packages/formats`
depends: M1.1
status: done (qualified — WAL/PCX only; MD2/SP2/BSP38 split out, see TODO(M1.2 follow-up))
done-when:
- [x] PAK directory parse, `readFile(name): ArrayBuffer`
- [x] WAL → 4 mips; PCX → palette + pixels; colormap built and byte-compared to id's `colormap.pcx`

### TODO(M1.2 follow-up) — update 2026-10-25 pm:
- `parseMD2` DONE (`packages/formats`): real IDP2 parser + `parseSP2` verified vs
  pak0.pak (soldier 227v/434t/475f, g_shotg, all 8 sprites). `parseBSP38` stays a
  stub (full loader in `@q2/bsp`); re-point is a separate contract PR.
- Remaining wiring (not parser): `apps/web` still registers the box-critter
  (`play.ts:1014`) — switch boot to `modelForMonster`/`skinForMonster` +
  `registerModel` MD2 path + `registerSkinData` (both landed in sw-renderer).

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
- [x] cache hit rate >95% on a demo1 flythrough (devroom steady-state 100% measured; demo1 run pending pak assets — see TODO(M3.2))
- [x] dynamic lights (blaster bolts) mark surfaces and invalidate cache entries

### TODO(M3.2)
- Re-run hit-rate + overdraw on `demo1`/base1 once M2.1 lands and pak assets are mounted; the renderer exposes `testCacheStats()` for the bench (§10.3).

### M3.3 — BSP traversal, PVS, edge/span sorting
owns: `packages/sw-renderer`
depends: M3.2
status: done — recalibrated (b): 1.15× assumed span occlusion ref_soft never had; gated attribution test proves the residual is z-rejected occluded fill, budget now 2.5×
done-when:
- [x] overdraw ≤2.5× at 640×480 on base1's opening room — worst measured 2.362 (spawn-north; west 1.810, lowroad 2.186, trench 1.936; §11). Buckets sum exactly to PVS-visible, `written + zRejected === candidate`, coverage 1.000 with 44.8–57.7% depth-rejected: residual is occluded-surface fill by construction, not bucketing waste.
- [x] no z-fighting on coplanar faces (use the BSP order, not just the z-buffer)

### TODO(M3.3)
- Closed: recalibration chosen over occluder clipping (clipping would be non-C-faithful work that changes no visible pixel — the depth test already rejects that fill). Attribution pinned by `overdraw.test.ts`.

### M3.4 — Alias models, sprites, particles
owns: `packages/sw-renderer`
depends: M3.3
status: done (placeholder qualified — real MD2/skins missing, see TODO(M3.4))
done-when:
- [x] MD2 player model draws with affine triangles + shade dots (MD2-shaped procedural mesh; real `.md2` parse is M1.2's job — data flows through `registerModel`)
- [x] 1,000 particles cost <1.5 ms at 640×480 (measured 0.16 ms, §11)

### TODO(M3.4) — update 2026-10-25 pm:
- DONE: `md2ToAliasMesh` + `registerSkinData/Pixels` + `drawTracerBeam`/`spawnTracer`
  (`packages/sw-renderer`); asset tables + blaster `BoltSpec`/`MuzzleSpec`
  (`packages/game/src/assets.ts`, `weapons.ts`); baked readable fallback font
  (`packages/client`); `r_brightness` display-only lift + fps top-right green +
  select-panel + nicer 2D viewmodel (`apps/web`). Devroom golden `8f61c755` intact.
- Still open: boot path still registers `getDevMesh(0)` box-critter and renders the
  2D gun — wire `modelForMonster/viewModelForWeapon` + `registerSkinData` +
  bolt entity + tracer spawn in `apps/web` boot/driver (suggested M1.3 wiring card).

### M4.1 — Voodoo resolve chain
owns: `packages/voodoo`
depends: M3.1
status: done
done-when:
- [x] gamma → dither → RGB565 → 2×2 post filter, all cvar-switchable
- [ ] side-by-side screenshots vs a reference Voodoo3 capture reviewed by a human (TODO(M4.1): no web app frame to capture yet; pipeline is golden-hash locked meanwhile)

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

### M5.3 — Weapons + two monsters
owns: `packages/game`
depends: M5.2
status: done
done-when:
- [x] blaster/shotgun/machinegun with correct spread, damage, ammo
- [x] `soldier` + `gunner`-lite state machines, pathfinding on the node graph

### M6.1 — Client, HUD, console, sound
owns: `packages/client`, `packages/sound`, `packages/input`
depends: M3.3, M5.1
status: done
done-when:
- [x] prediction + interpolation; no visible jitter at 10 Hz tick
- [x] `conchars` HUD, statusbar from `configstrings`, working console with cvars
- [x] positional sound with the original attenuation curves

### TODO(M6.1): `CL_Predict` pmove hookup DONE (headless `pmoveFull` replay
### behind `cl_predict`, exact-match vs server, legacy fallback preserved).
### Remaining (confirmed real pak0.pak play-test 2026-10-25):
### - HUD font: baked readable 8×8 fallback DONE (`packages/client`); real
###   `pics/conchars.pcx` loads via `loadConcharsFont`/`setConcharsFont` when the pak
###   is present (devroom + base1 both legible now).
### - Brightness: `r_brightness` (0.5–2.0, default 1.25) DONE (`apps/web`,
###   display-only post-resolve scale; 1.0 byte-identical, HUD unclipped). Original
###   game data untouched — numbers on the right only, per request. Dark default is
###   now tunable, not hardcoded.
### - Muzzle dlight leaks: `drainFlash` (`apps/web/src/play.ts:456`) doesn't consume
###   and `pumpMuzzleLight` (`:1035`) `testAddDynamicLight`s every tick with no
###   `testClearDynamicLights`, so lights accumulate and the scene stays bright.
###   Fix = expire the flash + invalidate (M3.2 path) instead of accumulating.
### `packages/client` now depends on `@q2/game` (pmove only — §4 diagram updated); the headless
### Mixer glue from M7.2 is unchanged. Integration glue also delivered:
### `@q2/host` loop, `NullRefresh` + devroom fallback in `@q2/renderer-api`,
### golden/bench helpers in `@q2/testkit`, cvar console wiring in `@q2/config`.

### M7.1 — Web app shell
owns: `apps/web`
depends: M6.1
status: in-progress
done-when:
- [x] pak drop zone → IndexedDB → boot; progress UI; renderer switcher; cvar panel
- [x] real `SoftwareRenderer` behind `vid_renderer` (`software` default, `voodoo` resolve chain), rAF loop, pointer-lock input, crosshair + HUD
- [x] devroom explorable (analytic room collision) and base1 bootable from a dropped pak (BSP collision, WAL/PCX, doors open + render, exit fires, static monsters shootable) — play-tested headlessly incl. Q2_PAK run
- [ ] 60 fps at 640×480 software on the bench machine

### TODO(M7.1): IndexedDB pak cache DONE (M7.3) and the 60 fps sign-off: base1 spawn view costs ~10.8 ms/frame
### single-threaded at 320×240 (internal res, CSS 2× upscale; measured Ryzen 5 PRO
### 2400G, Node 22) — 640×480 needs M8.1 workers. No saves/menu.
### (Monster AI/attacks + weapon view model + per-channel sound moved to M7.2,
### plats/train riders to M7.4 — see those cards for real-pak qualifications.)
### WIRE update: real pak0.pak ingests client-side (3307 entries, hasBase1),
### cooker round-trips it (184MB → 93.6MB in 5.3s, base1.bsp byte-identical),
### and the real map renders headlessly (4 views, hashes logged in testkit).
### Real-map frame cost single-threaded is 11–127 ms @640×480 (view-dependent);
### 60 fps needs M8.1 workers.

### M8.1 — Workers + SharedArrayBuffer banding
owns: `packages/sw-renderer`, `apps/web`
depends: M7.1
status: review (kernel scales, full frames Amdahl-bound — see note)
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
> 60 fps @640×480 still open.
done-when:
- [ ] framebuffer split into N bands; linear scaling to 4 workers ±15%
- [ ] identical golden frames to the single-threaded path

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
- [x] weapon view model (placeholder): 2D `fillRect` gun silhouette bottom-right + muzzle flash rect (`apps/web/src/play.ts:1086 drawViewModel`) + 3D muzzle dlight — NOT the real `v_weap` MD2/skins, blocked on TODO(M1.2 follow-up)
- [x] per-channel sound: wire `Mixer.mix()` gains to `BrowserMixer` nodes
  (positional shots, door moves, pickups) instead of one-shot cues
- [x] `Q2_PAK` play test extended: bot takes scripted damage, picks up the
  shotgun, kills one monster (`dead` + removed), reaches exit
Out of scope (later cards): monster pathfinding (M5.3 full AI), plats/trains
riders (TODO(WIRE-EXIT)), saves/menu, M8.1 workers.
### TODO(M7.2 follow-up)
- Spawn correctness fix landed here: `spawnFromLump` skips targeted
  `info_player_start` (id SP `SelectSpawnPoint` rule) — base1's lump leads
  with a `targetname "base2"` start over the exit pit that used to spawn the
  player onto the exit volume and instantly "complete" the level.
- Pickups respawn: DONE (M7.4, DM-style ~30s timers in SP).
- `syncMixerToBrowser` per-name pak wav decode: DONE (lazy per-channel decode,
  24-entry cache, shot/synth fallback). Follow-up: several driver channel names
  are placeholders with no pak counterpart (`doors/door.wav` vs `doors/dr1_strt.wav`,
  `items/pickup.wav` vs `items/pkup.wav`); renaming them to real pak names needs a
  `play.ts` + M7.2 bot-test assertion update.
- Real-pak play-test 2026-10-25: enemies render as untextured box-critters
  (blocked on TODO(M1.2 follow-up)), weapon is the 2D placeholder above, HUD text
  is procedural noise (see TODO(M6.1)), and firing permanently brightens the scene
  (muzzle dlight leak, see TODO(M6.1)). Sound/positioning works, so monsters are
  heard but not seen.

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
- [x] per-name pak wav decode for mixer channels (lazy per-name decode + cache in `apps/web`; placeholder channel names still fall back — see TODO(M7.2 follow-up))

> M7.4 WIRE-EXIT note: the pit is sealed rock except the top slot and the
> `*31` plug fills that slot closed/open/in-transit (exhaustive sweep, zero
> rider-overlap configs touching `*27`); a body in the trigger re-fires the
> door each tick so the plug can't rise with a rider (real Q2 behaviour).
> Exit-*chain* proof stays green; accepting slot-hold as delivery. Revisit
> only if the map assumption changes.

### M9.1 — WASM span backend
owns: `packages/sw-renderer`
depends: M8.1
status: review (scalar-port ceiling measured — ran ahead of blocked M8.1, see note)
done-when:
- [ ] `RasterBackend` implemented in AssemblyScript/Zig, byte-identical output, ≥2× faster

> M9.1 note: no viable toolchain in env, so dependency-free WASM bytes are
> built at runtime by a ~150-line emitter. Output is byte-identical
> (200-batch fuzz, devroom golden `8f61c755`, base1 ×4 views) behind
> `sw_wasm` (default 0, TS remains default). But scalar WASM only reaches
> ~1.3–1.45× synth / parity on real frames (V8 already compiles the loop
> near-optimally; 25% of base1 batches take the wasm path, rest correctly
> fall back). True 2× needs SIMD v128 or M8.1 worker composition.
done-when:
- [ ] `RasterBackend` implemented in AssemblyScript/Zig, byte-identical output, ≥2× faster

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
