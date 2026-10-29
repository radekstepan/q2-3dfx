---
'@q2/voodoo': patch
---

PERF-NEXT-6 round 1: fuse 565-expand + dither-subtract + clamp into phase-strided tables in resolveFusedFrame's dither-on recon arms (2x2sub+2x2box and 4x4sub+4x1). Bit-identical output (full cross-product fidelity suite green, display golden unchanged); ~28% faster serial scanout at 640x480 on the default profile.
