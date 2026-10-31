# Architecture — q2ts repo layout, sources, dependencies

> Extracted from BRAIN.md. Normative for layout and dependency rules.

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
│  ├─ webgl-renderer/            ← WebGL2 backend (scene boundary + resource ownership; Voodoo3 appearance in shader/target passes)
│  ├─ renderer-api/              ← the Refresh interface the software backend implements + the additive GPU boundary
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
math ← formats ← bsp ← sw-renderer ← renderer-api ← host
{renderer-api, sw-renderer, bsp, math, config} ← webgl-renderer (GPU boundary impl; + formats test-only)
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
- RELEASE-8 retired the legacy CPU Voodoo execution mode (`@q2/voodoo` resolve/scanout
  path). The Voodoo3 appearance policy (RGB565 + ordered dither, matched reconstruction,
  LOD policy, table fog, `vd_*` uniforms) is implemented by `webgl-renderer` in
  shader/target passes, with the policy tables duplicated by value in
  `src/appearance.ts` — there is no `webgl-renderer → voodoo` edge. `vd_*` cvars
  remain as WebGL appearance uniforms. See §7.2.
- `webgl-renderer` owns the injected WebGL2 context, GPU buffers/textures/programs/targets and the
  persistent-upload bookkeeping; browser glue owns canvas/context acquisition and forwards
  context loss/restoration. Only this package and `apps/web` may depend on browser graphics types.

---
