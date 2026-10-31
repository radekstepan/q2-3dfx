---
'@q2/webgl-renderer': patch
---

GPU-FOLLOW-5 Box 1 (webgl lane): add hermetic mip-regime evidence. New mip-regime.test.ts pins the production sampling path three ways: a high-frequency checker proving mipDither on/off bites (level + sampled bytes) when content minifies with contrast; a real-base1 census over the production PVS/frustum/backface selection quantifying the shipped MID fixture as ~80% LOD-0 pixel-weight (toggle provably inert — the 0/0 blocker, thresholds untouched); and a sensitivity control showing the mirror sees on/off effects on real art through the full lit chain. No production raster change, no threshold change.
