---
"@q2/voodoo": patch
---

test(voodoo): banded scanout differential pins (Track A)

scanoutBand.test.ts proves the sw-renderer banded fused scanout is
byte-identical to voodoo resolveFusedFrame across all reconmodes
(2x2sub+2x2box, 4x4sub+4x1, legacy), dither on/off, 2x2/4x4 matrices,
postfilter on/off, gamma 1/1.3, quantise on/off, odd dimensions and 1/2/3/7
band splits (halo handling included). No resolve logic changed; the serial
fused path remains the oracle.
