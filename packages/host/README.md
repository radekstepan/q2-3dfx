# @q2/host

The loop that ties server + client + renderer together (`qcommon/` + `client/cl_main.c` frame logic).

## What it is

Owns wall-clock accumulation, fixed-step 10 Hz server ticks, client command
building, snapshot ingestion into the `Predictor`, and per-frame rendering
through any `Refresh` backend. Everything heavy is injected: the world
simulation arrives via an optional `HostDriver`, the world geometry via
`WorldModel`, rendering via `@q2/renderer-api`.

## Public API (`src/index.ts`)

- `HostOptions { refresh, width?, height?, indexed?, localPlayerId?, world?, driver? }` — `driver` absent = synthetic offline/devroom mode.
- `HostDriver { spawn(), step(cmd, dt), snapshot(serverTime) }` — app-owned
  server-authoritative sim (pmove, movers, triggers, monsters). The Host owns
  time; the driver owns the world. Implemented by `apps/web` (`play.ts`).
- `Host`: `frame(nowMs): FrameStats`, `ingestSnapshot(snap)`,
  `renderCurrentView()`, `resize(w, h)`, plus live state (`fb`, `input`,
  `playerOrigin`, `lastCmd`, `predictor`, `console`, `mixer`).
- The local player's own entity is filtered out of renderables (it sits at
  the camera); remote/monster entities from the `Predictor` are rendered.

## How it is used

`apps/web` builds `new Host({ refresh: new SoftwareRenderer(), world, driver })`
and calls `host.frame(performance.now())` from `requestAnimationFrame`.
`host.input` is the shared `InputCore` that `@q2/input/dom` writes into;
`driver.snapshot()` feeds authoritative entities back each tick.

## Testing

`yarn workspace @q2/host test` — loop/snapshot/interp tests plus a mock-driver
test (spawn delegation, 10 Hz stepping, snapshot sync into `playerOrigin`).

## Constraints

Depends only on `@q2/{config,renderer-api,client,sound,input}`. Never imports
`@q2/server` or `@q2/game` (driver interface keeps the dependency inverted).
`serverTick` without a driver only advances `serverTime`.
