# Perf ledger — full history + budgets

> Extracted from BRAIN.md §11. Append a row per bench run. Bench machine: whatever CI reports in `tools/bench/machine.json`.
>
> Budgets (fail the build if exceeded): software ≤16 ms/frame @640×480, voodoo ≤16 ms/frame @640×480 after M8.1, startup ≤2.5 s from cached pak to first frame.

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
| 2026-10-26 | async+simd | software base1 spawn-north, frame-attribution (classic) | 640×480 | ~36 | — | 2.38 | renderView 28.3 = GEO 13.4 (setup 0.05 mark 0.0 trav 1.0 cull 4.3 cache 0.9 proj 1.8 emit 3.8 sort 1.0) + DRAW 11.5 + resolve 1.2; 1806 batches, 30337 spans; committed `tools/bench` frame bench |
| 2026-10-26 | async+simd | software base1 spawn-north, pooled frame-accum + parallel resolve | 640×480 | 66 | — | 2.38 | classic 19.1 → 15.1 ms/frame @7 workers (1.25x; spanfill ~3x, fused pack saves ~1ms, resolve kick ~0.7ms); index + color hashes ≡ classic on all 4 views; devroom `8f61c755`; closes the 16ms budget headless |
| 2026-10-26 | perf-lane (interleaved OLD×3/NEW×3) | software base1 spawn-north, serial classic + cull hot-path opts (flat frustum, style-hash memo, affected bsearch) | 640×480 | ~34 (29) | — | 2.38 | GEO 15.2→13.4ms (cull −0.5, emit −0.5, trav −0.2), frame ~35→~29ms; index+color hashes ≡ on all 4 views, devroom `8f61c755`; box: Ryzen 5 PRO 2400G×8, node 22, concurrent-lane load (ranges, same direction all 3 pairs) |
| 2026-10-26 | perf-lane | software base1 spawn combat, play-level split (10Hz tick / pumps / host render / HUD / blit-copy est) | 640×480 | ~19 | — | 2.38 | step(tick)=3.41 pumps=0.08 render=45.82 resolve=1.09 hud=0.15 blitCopy~=2.38 (excludes createImageData+putImageData); cache 50.8% under combat fire (quiescent hot-cache in the frame section); sim is per-tick — amortised ÷6 at 60fps |
| 2026-10-26 | 2d42770 | software base1 pool TRANS66 blend, real colormap.pcx alphamap | 320×240 | 41 | ~3 | 3.00 | warp+blend water through the deferred alpha pass, 480 trans spans, mode-1 hash `06456518` (mode-0 `1dc00e44`); devroom `8f61c755` byte-exact |
| 2026-10-27 | uncommitted | software base1 spawn-north, single-walk translucency (classic serial) | 640×480 | — | — | 2.38 | interleaved OLDx3/NEWx3: cull NEW<OLD all pairs (median -4.0ms), GEO down in quiet window; opaque-then-alpha, back-to-front, stipple/blend identical: devroom `8f61c755`, base1 x4 idx+color, TRANS66 `06456518`/`1dc00e44` |
| 2026-10-26 | 2d42770 | software base1 sweep flythrough, steady-state surface cache | 640×480 | 18 | ~6 | 1.92 | 8-view yaw sweeps: round-2 9107 hits / 0 misses / 0 evictions (100%); 4-teleport union exceeds the 4MB budget and re-thrashes (~6% — expected, not a regression) |
| 2026-10-27 | 3c09006 | browser async tick + blit (M7.1 follow-up, apps/web only) | 640×480 | — | — | 2.38 | rAF tick awaits `frameAsync` when pooled (in-flight guard, sync fallback), pool pre-spawned once/loop, `sw_workers` auto-latch hwConcurrency−1 (1..7); `blitToCanvas` cached ImageData + bulk u32: copy 1.81→0.074ms (~26×, byte-identical, per-frame createImageData gone); pooled A/B @7 workers spawn-north classic 22.98→accum 19.41ms (idx `d5edf6cb` color `8a34205b` identical all modes); devroom `8f61c755`, base1 ×4 sync≡async, web 194/194 incl. gate. Box unchecked: no real-browser fps yet (concurrent-lane tree; absolute render slower than the 15.1ms row under load). |

Budgets (fail the build if exceeded): software ≤16 ms/frame @640×480, voodoo ≤16 ms/frame @640×480
after M8.1, startup ≤2.5 s from cached pak to first frame.
