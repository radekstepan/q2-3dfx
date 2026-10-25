# bench

Headless perf runs that append a row to the perf ledger (BRAIN.md §11). No id Quake II source port — new harness over `@q2/testkit` + `@q2/renderer-api`.

## Public API

Entry point: `src/index.ts`.

- `BenchOptions` (`src/index.ts:6`) — `{ width?, height?, iterations?, path?, notes? }` (defaults 640×480, 60 iterations, `'software'` path).
- `runBenchTool(opts?)` (`:14`) — creates a framebuffer, runs a `syntheticFill` loop via `@q2/testkit`'s `runBench`, resolves the git commit, prints a `formatLedgerRow` line plus `{ machine, msPerFrame }` JSON, and returns the row string.
- Direct execution: if `process.argv[1]` matches `/bench/`, the module runs `runBenchTool()` with defaults (`:39`).

## How it is used

Standalone tool (`private: true`); nothing imports it. Invoked via turbo (`yarn bench`) or directly; output is pasted into the perf ledger and PR bodies.

```ts
import { runBenchTool } from 'bench';
const row = await runBenchTool({ width: 640, height: 480, iterations: 60, path: 'software' });
// | date | commit | path | res | fps | Mpixel/s | overdraw | notes |
```

## Testing

`yarn workspace bench test` (vitest, `--passWithNoTests`). No test files, fixtures, or goldens — verification is the ledger row itself plus `machineJson()` output.

## Constraints

- Dependency direction: `tools/*` are leaves — nothing depends on them. May depend on `@q2/config` and `@q2/testkit` (per `package.json`).
- Platform: Node-only (`process.argv`, `child_process.execSync` for the commit hash, `process.version` fallback in `machineJson`).
