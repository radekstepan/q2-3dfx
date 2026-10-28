---
"@q2/sw-renderer": minor
---

feat(sw-renderer): real RGB raster jobs on workers (PERF-2 JOB_RGB kick)

World RGB batches (opaque/turbulent spans, textured skybox faces, flat sky fills) now stage into SharedArrayBuffer regions and drain in ONE worker kick instead of rasterizing serially on the calling thread. New SAB regions (appended after the frame-accum layout): RGB authority planes (rgb565/cover/rgbDepth), private RGB span arrays, a per-frame chain directory + level table + chain bytes (world + sky chains, deduped by identity), luxel bytes, RGB descriptors, and float kick params (near/far/lodBias). The shared bandWorkerLoop handles JOB_RGB (no lazy clear — beginFrame clears serially; indexed planes untouched), running a packed-span RGB core that mirrors drawSpansRGB op-for-op (same subdivs, absolute dither coords, same-row order, window-Z mapping). Foreground RGB (alias, sprites, particles, tracers, translucent alpha) stays inline after the kick, preserving the kick-then-foreground ordering. Any staging miss replays pending work inline and latches the rest of the frame inline (depth-guarded convergence — identical output); serial fallback is bit-identical by construction.

Measured (Ryzen 5 PRO 2400G, Q2_PAK base1, fixed cam/time): spawn-north 640x480 RGB renderView 110.55ms -> 55.73ms (DRAW 90.14 -> 35.95), full production frame incl. fused scanout 123.13 -> 77.96ms; 320x240 renderView 47.40 -> 34.94ms. All idx/color hashes identical serial-vs-worker on every scene/mode/entity/worker-count combination (incl. the committed BEFORE pins). Browser kick verified engaged via __q2stats (pooled base1 spawn 320x240: staged ~1848/kicks 1/inline 0 per frame).

Tests: new rgbWorkers.test.ts (devroom serial-vs-kick at 1/3/7 workers, odd dims, determinism, dead-pool fallback, async kick path, Q2_PAK base1 x2 views x entities x 1/7 workers with full-RGBA hashes). Fixes found by the tests: odd-dimension SAB misalignment, indexed resetAccum aliasing RGB staging (decoupled), sky-chain overflow of the original 4MB cap (raised to 8MB). No fidelity change: no goldens updated, software path untouched, sw_rgb_skip_classic stays default-off.
