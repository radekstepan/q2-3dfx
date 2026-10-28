---
"@q2/sw-renderer": patch
---

perf(sw-renderer): fuse the banded RGB span fan-out into one full-range call

`BandedSoftwareBackend.drawSpansRGB` scanned every world span batch once
per band; when bands contiguously partition the frame (the `splitBands`
steady state, verified per call, zero allocation) it now issues a single
full-range call. Bit-identical: per-span effects are per-pixel and each
span touches one row, so cross-row order commutes (incl. alpha/additive
and depth ties); same-row spans keep list order in both forms; absolute
coords (Bayer phase) and band-seam rows unchanged. Stale-band state falls
back to the old per-band loop. New adversarial banded-vs-serial tests in
`rgbBands.test.ts` (unsorted/out-of-range spans, all 5 kinds, same-row
overlap, warp, zbits 0/16, bands 1..8). Measured base1 spawn-north
(Ryzen 5 PRO 2400G, Node 22, Q2_PAK, interleaved A/B): w=4 RGB 320x240
renderView -8.5%, DRAW -8.7%, hashes identical 24/24 configs; w=4 RGB
640x480 renderView -3.9%; w=0 serial control within noise (unchanged path).
