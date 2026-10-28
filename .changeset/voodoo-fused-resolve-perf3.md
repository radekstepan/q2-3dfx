---
"@q2/voodoo": patch
---

perf(voodoo): fuse pack→recon→gamma in resolveFrame (PERF-3, byte-identical)

`resolveFrame`'s quantise-on path ran three serial full-frame passes (linear
pack → reconstruction/box → display gamma) plus threshold repack and
per-tap object allocs. It now runs fused (`resolveFusedFrame`): pack rows on
demand into `dst565`, reconstruct display rows from the hot rows, gamma LUT
inline; spread computed directly from subtracted taps; taps expanded into
locals. No scratch buffers, zero per-frame allocation, shell buffer
ownership unchanged.

Byte-identical: 1920-combo differential (`src/fused.test.ts`: every
dither/dithermode/postfilter/reconmode/gamma/threshold combo × 10 sizes incl.
1x1/odd/1xN) plus base1-WAL mosaic oracle (96 combos) all match the manual
pipeline; locked `f4ebd424` unchanged; new display golden `29f9da92`.
Isolated interleaved A/B (node 22, same process): 640×480 default 1.16x,
legacy 1.19x, 4x1 1.19x, direct 1.22x; 320×240 1.13–1.19x.
