# bench

Headless perf runs that append a row to the perf ledger (BRAIN.md §11). No id Quake II source port — new harness over `@q2/testkit` + `@q2/renderer-api`.

## Public API

Entry point: `src/index.ts`.

- `BenchOptions` (`src/index.ts:6`) — `{ width?, height?, iterations?, path?, notes? }` (defaults 640×480, 60 iterations, `'software'` path).
- `runBenchTool(opts?)` (`:14`) — creates a framebuffer, runs a `syntheticFill` loop via `@q2/testkit`'s `runBench`, resolves the git commit, prints a `formatLedgerRow` line plus `{ machine, msPerFrame }` JSON, and returns the row string.
- Direct execution: if `process.argv[1]` matches the built entry, the module runs `runBenchTool()` with defaults (`:39`).

```ts
import { runBenchTool } from 'bench';
const row = await runBenchTool({ width: 640, height: 480, iterations: 60, path: 'software' });
// | date | commit | path | res | fps | Mpixel/s | overdraw | notes |
```

## RGB attribution bench (PERF-1)

Reproducible BEFORE/AFTER harness for PERF-2 (indexed/RGB + parallel RGB)
and PERF-3 (reconstruction/pack/gamma). No renderer changes — attribution
only, so PERF-2/3 can prove wins against it.

- `src/rgbattr.ts` — `runRgbAttr(pakPath, { warmup?, reps?, scenes?,
  entities?, workers? })`. Per (320×240 + 640×480) × (devroom +
  spawn-north + trench-east) × (entities none/fixed/combat) ×
  (software/RGB) × workers: renderView GEO split
  (setup/mark/traverse/cull/cache/project/emit/sort via
  `testMeasurePhases`, reused) + DRAW + alias medians + p95, endFrame wall
  time (hrtime), voodoo resolve split on the produced frame via live
  `@q2/voodoo` API (`resolveRGB565` pack vs `applyReconstruction2x2` recon
  vs `applyDisplayGamma` gamma), index-plane FNV + color-plane R+G FNV
  hashes (same scheme as `src/frame.ts`).
- INSTRUMENTED (testMeasurePhases medians, stage probes) vs UNINSTRUMENTED
  (full production frames measured TOGETHER per rep — `frameMs`, never a
  sum of medians). The production scanout is `resolveFrame` serial, or
  `pool.flushScanout` pooled (Track A parallel scanout, the Node analogue
  of the browser `resolveDisplayAsync` path); the serial fused resolve
  stays as a LABELED control (`scanoutSerialMs`/`frameSerialMs`,
  interleaved back-to-back per rep). Presented-plane display hashes prove
  pooled/serial parity.
- Classic DRAW vs RGB spanfill without renderer probes: `phases.draw`
  lumps classic + RGB (classic always draws; RGB composites on top), so
  RGB_extra = draw(rgbOn) − draw(rgbOff) on the identical scene/camera;
  same for alias (RGB twins + seed) and endFrame (seed + composite).
  Documented estimates, not probes.
- Fixed cameras: `@q2/testkit` `base1Views()` (time 1.5, fov 90, flat
  styles) + `DEVROOM_CAMERA`. Entity sets (camera-relative, in-frustum):
  `none` (empty attribution floor), `fixed` (1 alias real soldier MD2
  frame 4 + 1 sprite sp2 + 1 tracer beam + 12 world particles on base1),
  `combat` (fixed + eye-anchored depthHack viewmodel gun `v_blast` +
  per-frame muzzle/explosion dynamic lights re-pumped like the live loop —
  the representative gameplay workload). Fixed cvars: vd profile
  γ1.3/dither/16bit/postfilter/bilinear/mipdither/fog/overbright/
  palettetex/maxtex256/zbits16/dithermode 4x4/recon 2x2sub+2x2box/
  rgbmaxdelta 8,8,8, sw_workers=0 serial, single-thread sequential.
- Build freshness: `distFreshness()` compares the executed
  `tools/bench/dist` against the newest engine-src mtime and WARNs when
  stale — a stale dist silently benchmarks old code. `runRgbAttr` records
  commit + freshness + machine + node + workers + fidelity profile.
- Runner: `rgb-attr.mjs` (uses the built `dist/`):
  `Q2_PAK=../external/q2/baseq2/pak0.pak yarn bench:rgb`
  (`RGB_BENCH_REPS=10`, `RGB_BENCH_WARMUP=3`, `RGB_BENCH_WORKERS="0"`,
  `RGB_BENCH_ENTS="none,fixed,combat"` overrides).
- Fixed cameras also live in `@q2/testkit` (`src/base1-views.ts`) so
  bench, goldens and gates share one definition.

## Budget acceptance gate (item-9 checklist)

Timing-sensitive budget enforcement lives OUTSIDE vitest (correctness-only
tests are NOT gates): `src/acceptance.ts` + `bench-accept.mjs`.

- Reference config: 640×480 spawn-north, `fixed` + `combat` entity sets,
  software + RGB, worker sweep `0,1,3,7` (`RGB_ACCEPT_WORKERS`,
  `RGB_ACCEPT_WARMUP=5`, `RGB_ACCEPT_REPS=10`).
- Gates A/B/C: software-fixed-serial, rgb-fixed-serial, and
  rgb-combat-pooled(max workers) production frames each ≤ 16ms.
- Gate D (correctness, exit 1): serial/pooled idx+color+display parity on
  every swept config, odd-dimensions smoke (639×479), dead-pool fallback.
- Exit codes: 0 pass, 1 hard failure (stale dist / parity / fallback),
  2 budget miss with the gap printed.
- Run: `Q2_PAK=... yarn bench:accept` (sequentially, quiet machine).

## Frame attribution bench (M8.1)

Methodology recreated from the gitignored `bench.mjs` era (M8.1/M9.1 job §1):
real-base1 frame split into geometry (setup/mark/traverse/cull/cache/
project/emit/sort) vs spanfill vs resolve, plus pooled A/B with
byte-identity hashes. Committed here so any agent can re-run it.

- `src/frame.ts` — `runFrameBench(pakPath, workers?)`, `attributeView`,
  `poolCompareView`, `loadBase1World`, `BASE1_VIEWS` (4 fixed cameras).
  Q2_PAK-gated: throws without a pak path.
- Runner: `frame-bench.mjs` (uses the built `dist/`): 
  `Q2_PAK=.../pak0.pak SW_BENCH_WORKERS=5 yarn bench:frame`.
- Gates live in `packages/sw-renderer/src/bands.test.ts` (golden hashes
  across classic / per-batch pool / frame-accum pool); this bench reports
  medians for the §11 ledger and PR bodies.

## Testing

`yarn workspace bench test` (vitest, `--passWithNoTests`). No test files, fixtures, or goldens — verification is the ledger row itself plus `machineJson()` output.

## Constraints

- Dependency direction: `tools/*` are leaves — nothing depends on them. May depend on engine packages for measurement only (`@q2/sw-renderer`, `@q2/bsp`, `@q2/formats`, `@q2/renderer-api`, `@q2/config`, `@q2/testkit`, `@q2/voodoo`).
- Platform: Node-only (`process.argv`, `child_process.execSync` for the commit hash, `process.version` fallback in `machineJson`).
