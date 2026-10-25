---
'@q2/sw-renderer': minor
---

M8.1: SAB-banded spanfill with a worker-thread pool.

- Framebuffer index + depth planes live in one `SharedArrayBuffer` split
  into N horizontal bands (`sw_workers` cvar, 0 = classic default).
  Banding is exposed through the frozen `RasterBackend` surface
  (`BandedSoftwareBackend`); single-threaded TS stays the default and every
  path falls back silently without SAB/threads.
- `BandWorkerPool` (Node `worker_threads`) runs the same TS span loop per
  band over the shared views: zero copy, parallel lazy clear, no per-frame
  allocation. Inline and pooled outputs are bit-identical by construction
  (depth-guarded writes) and pinned by differential fuzz + golden tests.
- `apps/web` opts in via `syncWorkersFromCvar()` after boot and ships
  dev-server-only COOP/COEP headers (`apps/web/vite.config.ts`,
  headers-only) to unlock `SharedArrayBuffer` under `yarn dev`.
- Bench (`packages/sw-renderer/bench.mjs`): spanfill kernel scales with
  worker count (4 workers + main-thread band measured 3.49x single,
  byte-identical); full base1 frames stay geometry/batch-fragment bound
  (1802 batches/frame), so frame-level accumulation is the follow-up.
