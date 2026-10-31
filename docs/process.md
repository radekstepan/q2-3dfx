# Process — tooling, subagent protocol, risks, glossary, feasibility

> Extracted from BRAIN.md §§2,10,12,13,14.

## Feasibility

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
- Avoid polymorphic call sites: branch on the span, never a mode check *inside* the pixel loop.
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

## Tooling

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
   GPU-vs-CPU parity is judged by the `docs/gpu-proof-1-contract.md` tolerances with mandatory
   human review, never auto-pass. The legacy CPU Voodoo resolve leg is retired (RELEASE-8).
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


## Subagent operating protocol

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


## Risks

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


## Glossary

## 14. Glossary — C file → TS module

`qcommon/` → `@q2/host` + `@q2/config` · `client/cl_*.c` → `@q2/client` · `server/sv_*.c` → `@q2/server`
`game/g_*.c`, `p_*.c`, `m_*.c` → `@q2/game` · `ref_soft/*` → `@q2/sw-renderer` · `ref_gl`-on-Voodoo3 look → `@q2/webgl-renderer` appearance (legacy `@q2/voodoo` CPU path retired, RELEASE-8)
`qcommon/cmodel.c` → `@q2/bsp` · `qcommon/files.c` → `@q2/filesystem` · `qcommon/pmove.c` → `@q2/game/pmove.ts`

