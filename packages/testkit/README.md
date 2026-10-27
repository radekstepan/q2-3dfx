# @q2/testkit

Golden-frame harness, pixel differ, bench runner, and fixtures (`src/index.ts:1`).
Compares `Refresh` output headlessly; software path is bit-exact, voodoo allows 1 LSB.

Entry point: `src/index.ts`.

## Public API

- `renderGolden(refresh, view, world, entities, name)` (`src/index.ts:50`) — `beginFrame` → `renderView` → `endFrame`, returns `{ result: GoldenResult, rgba }`. Reads the buffer via `framebuffer`/`getFramebuffer()` (`:75-81`).
- `GoldenResult` (`src/index.ts:36`) — `{ name, hash, width, height, pixels, stats }`.
- `hashFrame(color)` (`src/index.ts:8`) — FNV-1a hex of the color plane.
- `pngDiff(a, b, lsb)` (`src/index.ts:18`) / `compareGolden(actual, expected, tolerance)` (`:95`) — differing-pixel count; `'voodoo'` forgives ≤1 LSB per channel (`GOLDEN_TOLERANCE_VOODOO_LSB`, `:5`; software `:4` is exact).
- `writeGoldenFiles(outDir, result, rgba)` (`src/index.ts:84`) — Node-only (lazy `fs`/`path` import), writes `<name>.{rgba,json}`.
- `runBench(name, pixels, iterations, fn)` (`src/index.ts:121`), `syntheticFill(color, seed)` (`:143`), `BenchSample` (`:107`) — timing + Mpixel/s workload.
- M4.1 side-by-side (`src/sidebyside.ts`): `compareSideBySide(name, actual, reference)` (§10.3 tolerance: ≤0.5% px over 1 LSB), `loadReferenceSlot` / `writeActualSlot` (Node-only slot IO: `<name>.png` reference capture, else `<name>.rgba` + `<name>.json`), `decodePng` (8-bit RGB/RGBA reference PNGs), `formatSideBySideReport`. Missing reference → `reference: 'missing'` (review pending, never thrown).
- Demo1-era fallback (`src/demo-fallback.ts`): `DEMO_FALLBACK_MAP` (`maps/devroom`, asset-free — real `demo1.dm2` needs the retail pak, §3), `demoFallbackViews()` (3 fixed cameras), `demoFallbackWorld()`.
- Written capture instructions: `CAPTURE-M4.1.md` (cameras, cvars, sign-off rule).
- `formatLedgerRow(sample, commit, path, notes)` (`src/index.ts:154`) — BRAIN.md §11 perf-ledger row; `machineJson()` (`:165`, Node-only `os` import).

## How it is used

Consumed by `tools/bench` (`src/index.ts:3`: `runBench`, `syntheticFill`, `formatLedgerRow`,
`machineJson`) and `apps/web` (`src/devroom.ts:8`: `hashFrame`).

```ts
import { NullRefresh, createFramebuffer, devroomView, devroomWorld } from '@q2/renderer-api';
import { renderGolden, compareGolden } from '@q2/testkit';
const r = new NullRefresh(); r.init(createFramebuffer(64, 48, true));
const { result } = renderGolden(r, devroomView(0), devroomWorld(), [], 'devroom');
compareGolden(actual, expected, 'software'); // { diff, pass }
```

## Testing

- `yarn workspace @q2/testkit test` — `src/testkit.test.ts`: render determinism, camera-sensitivity, differ + voodoo-tolerance checks, bench/ledger smoke test; `src/sidebyside.test.ts`: M4.1 harness (§10.3 boundaries, missing-slot pending, PNG decode, slot round-trip); `src/demo-fallback.test.ts`: asset-free fallback cameras render deterministically.
- `src/base1-render.test.ts` — asset-gated WIRE test (`Q2_PAK=... yarn workspace @q2/testkit test`): boots real `maps/base1.bsp` through pak → BSP38 → WAL → `SoftwareRenderer`, pins a 4.0x overdraw ceiling. Skipped without `Q2_PAK`.

## Constraints

- Dependency direction: test-only harness; depends on `bsp`, `config`, `filesystem`, `formats`, `math`, `renderer-api`, `sw-renderer` (package.json). Production code must not depend on testkit.
- Platform: core (`renderGolden`, `compareGolden`, `runBench`) is DOM-free and browser-safe; only `writeGoldenFiles`/`machineJson` are Node-only (lazy imports so browsers still pass).
