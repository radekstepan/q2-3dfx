---
"@q2/sw-renderer": patch
---

perf(sw-renderer): fuse redundant span/resolve scans (PERF-2 A/B/C, byte-identical)

A — kill repeated scans: `BandedSoftwareBackend.runInline` was one filter
scan per chunk per band plus opaque/turbulent/flat triple scans per band;
it is now a single kind-dispatched pass (same per-span setup op-for-op:
clip, light resolve, skip-adjusted perspective start, 16-px subdivision
chain). `drawSpansRGB` banded was filter scan + dispatch scan per band;
the row range now rides the call (`drawSpansRGB(..., yLo, yHi)`), one scan
per band, absolute dither phase preserved.

B — gated classic skip: new `sw_rgb_skip_classic` cvar (default 0 = off,
classic world spanfill always runs). When opted in, world batches with an
RGB material skip the redundant classic draw (translucent/foreground
classic draws always run). The proof is not airtight (classic zb feeds
foreground depth tests, seedRGBBackground needs idx where uncovered,
stipple has no RGB equivalent), so the default path is bit-identical and
the flag stays OFF.

C — serial RGB hot loop: the four RGB span loops shared one window-Z
derivation (2 divisions + validity branch per 16-px subdiv); a
frame-constant memo (`winMemoSync`, keyed on the exact near/far/zbits
inputs) hoists it out — bitwise-identical values. `endFrame` serial
resolve fuses palette-expand + RGB565 composite into one full-frame pass
(disjoint pixel sets, identical math).

Byte-identical: full package suite green (devroom `8f61c755`, RGB
`68b22dea`/`58e0ecf1` pins hold), 4 base1 views idx+color hashes unchanged,
new odd-dim (161x121, bands 2/3/5/8) RGB differential + gated-skip tests.
Measured 640x480 spawn-north (Ryzen 5 PRO 2400G, Node 22): RGB resolve
3.8ms → 2.3ms (~38%); renderView within box noise (classic 19-23ms, RGB
95-113ms both before/after — shared noisy box, ranges overlap).
