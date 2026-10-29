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

## Controlled comparison (parent-vs-HEAD)

Sequential quiet-machine before/after on identical workloads and settings —
never concurrent across agents:

- `src/compare.ts` + `compare-run.mjs` + `compare-diff.mjs`.
- `Q2_PAK=... yarn bench:compare-run` writes the full run JSON to
  `evidence/raw/` (gitignored per-rep bulk; `COMPARE_OUT` overrides) plus a
  committed manifest `evidence/node-compare-<commit>-<ts>.manifest.json`
  (`COMPARE_MANIFEST_OUT` overrides) carrying command, commit, freshness,
  pak identity, machine/node/load, fidelity profile, warmup/reps/workers.
- Copy the file aside, rebuild the other tree, run again, then
  `COMPARE_BASE=compare-base.json COMPARE_HEAD=compare-head.json yarn bench:compare-diff`.
- Matrix: software + RGB (voodoo) × serial + 1/3/7 workers ×
  stationary (spawn-north fixed) + combat (fixed + viewmodel gun + pumped
  dlights) + moving (deterministic 2°/rep yaw sweep, per-frame hashes stay
  comparable) × 320×240 (diagnostic) + 640×480 (acceptance).
- Every run records commit, freshness, machine, node, loadavg, and the full
  settings; the diff step VERIFIES the settings match and prints per-config
  frame medians with Δ%, full-channel parity (index + full-RGBA color +
  full-RGBA display), and execution proof. A settings mismatch voids the
  comparison (exit 1). Budgets compare only whole production frames —
  per-rep splits, kick journals, GEO phases, kick histograms and stage/byte
  ledgers ride along as diagnostics, never summed into frame totals.

### Worker-count sweep procedure (Node + browser, same list)

PERF-NEXT-6 selects worker counts from MEASURED compute+idle, never from
assumption — Node and browser run the SAME sweep on the SAME workload:

- Parse: `COMPARE_WORKERS` accepts any 0..8 list in order
  (`"0,1,2,3,5,6,7"` runs verbatim — verified by `compare.test.ts` sweep
  pins). The matrix header logs one clean line per count
  (`describeWorkerSweep`: serial path vs `bands=N:[...]` tiling with the
  caller-owned last band marked), so partial sweeps read cleanly.
- Node: `COMPARE_WORKERS="0,1,2,3,5,6,7" Q2_PAK=... yarn bench:compare-run`
  (sequential, quiet machine). Per-config rows carry the band tiling
  (`bandId`), per-band compute + straggler (`workerComputeMs` /
  `workerImbalance`), fence idle, GEO phases and kick histograms — the
  worker-count decision inputs.
- Browser: the same list, same spawn-north/combat 640×480 workloads, run
  sequentially on the same box/condition; record each leg with the
  browser-soak schema (evidence/README.md: `workers` array, compositor
  class, percentiles, workload intervals). Never compare browser
  presented-FPS against Node production-frame numbers — same sweep
  procedure, separate records.
- Workload bytes stay identical across every leg (fixed cameras/entity
  sets/cvars — collectors and orchestration differ, never the workload).

### Interleaved candidate-A/B (same box, same build, two configs)

`src/ab.ts` + `ab-run.mjs`: config X vs config Y back-to-back INTERLEAVED
in one process (warm up both legs, then alternate A_i/B_i per rep so both
legs share thermal state rep-by-rep). Complements compare-run/compare-diff
(base-vs-head across builds): this diffs two CONFIGS (workers 7 vs 3,
pooled vs serial) of the same build.

- `AB_A="spawn-north,640x480,combat,rgb,7"
  AB_B="spawn-north,640x480,combat,rgb,3" AB_WARMUP=3 AB_REPS=5
  Q2_PAK=... yarn bench:ab`
  (`AB_OUT` / `AB_MANIFEST_OUT` override the evidence paths; kind
  `node-ab` in the manifest). Leg specs are
  `"scene,res,entities,mode,workers"`; dimensions and the rep-0 camera
  must agree or the pair is void.
- Reports paired per-rep deltas + medians with Δ%, settings MATCH/MISMATCH
  (dimensions + rep-0 camera + mid-run fidelity drift — a mismatch VOIDS the
  pair, exit 1), cross-leg output parity (SAME/DIFFER — worker-count legs
  must stay bit-identical; genuinely different workloads may differ) and
  per-leg execution proof (a pooled leg that only fell back is UNPROVEN).
- Pooled-vs-serial is a legitimate A/B (the scanout-leg shape is the
  experiment, never a mismatch); pooled display hashes stay comparable
  against the serial leg through the per-rep serial control.

### New row/report fields (PERF-NEXT-6 Lane C)

Stationary `AttrRow` and moving `MovingRow` rows (raw JSON + console) now
carry, in addition to the existing split/stage/FG/exec fields:

- GEO phases, per rep reconciled (`setupMs/markMs/traverseMs/cullMs/
  cacheMs/projectMs/emitMs/sortMs` = medians over reps — diagnostic, never
  summed; `geoMs` = median of the per-rep GEO totals, `geoGapMs` = median
  per-rep instrumented-wall gap; `geoDetail` = `measured`/`unavailable`).
  Stationary rows additionally carry `geoGapMs`. Console: `geo[n total=..
  setup=.. mark=.. ... gap=..]`.
- Kick-size histogram for the last production frame (`kickSizes[]`: one
  entry per kick with `{frame,seq,job,order,bands,spans,pixels,tris,
  execMaxMs,empty}` — `order` is drain order within the frame's job,
  world kick first, FG flushes after; `emptyKicks` + `emptyKickIds[]` =
  first-class empty-kick counter with `frame:seq:job` identity).
  Resolve/scanout kicks never carry spans by construction — they are
  reported but never flagged empty. Null while the producer publishes
  nothing (serial/detail-off) — unknown, never zero.
- FG suffix-kick drain (`suffixKick`: newest kick right after renderView —
  `kickBase > 0` marks a foreground-only suffix kick — with `kickDescs`
  drained range, completed spans/pixels/tris and the `empty` flag).
  Console: `lastKick[f7s30:rgb base=1607 descs=1612 bands=1 ...]`.
- How to read them: the lane question "which GEO phase dominates" is
  answered by the GEO medians (never sum them); "how big is each kick / how
  many run empty" by `kickSizes` + `emptyKicks`; barrier/batch follow-ups
  join `order` (world vs FG flushes) against `suffixKick.kickBase`.

## Durable evidence (PERF-NEXT-1)

Ledger rows reference `tools/bench/evidence/`, never `/tmp`. Full protocol,
worktree-baseline recipe and the browser-soak schema live in
`tools/bench/evidence/README.md`.

- `src/evidence.ts` — manifest core: reproducible command + allowlisted env,
  commit + tree dirtiness, `distFreshness`, pak identity (path/bytes/mtime,
  never the pak), machine/node/load, full `vd_*` + `sw_*` profile,
  warmup/reps/workers, summary + `ledgerHint`. Raw per-rep samples ride in
  the referenced `evidence/raw/` JSON (`frameReps[]` on stationary rows,
  `frameMs[]` on moving rows); summaries cover 640×480 only (320×240 is
  diagnostic-only by design).
- Every runner emits a manifest per run: `compare-run.mjs`, `rgb-attr.mjs`
  (also persists the full run JSON now), `bench-accept.mjs` (pass AND fail —
  a missed budget is evidence too). Env overrides: `COMPARE_OUT`,
  `COMPARE_MANIFEST_OUT`, `RGB_ATTR_OUT`, `RGB_ATTR_MANIFEST_OUT`,
  `ACCEPT_OUT`, `ACCEPT_MANIFEST_OUT` (or `emitEvidence: false`).
- Browser baselines are separate records (`browser-soak.mjs` imports a
  validated soak JSON): Node production-frame-no-present numbers are never
  diffed against browser presented-FPS. The soak schema forces an explicit
  `compositor` class (`swiftshader` | `software` | `hardware`; `unknown`
  rejected) plus `hardwareBacked` agreement, exact browser build, ≥5-min
  duration, percentiles and workload intervals. Template:
  `evidence/browser-soak.example.json`.

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
