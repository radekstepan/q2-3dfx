---
"@q2/sw-renderer": patch
---

Coordinated RGB texture-chain eviction: evicting a per-texture mip chain now invalidates the RGBLightCache entries sharing it, so evicted bytes are no longer pinned alive through material.levels (retained matched the 16 MiB budget on paper while real retention ran ~5 MiB over). Adds testRGBChainAccounting probe + rgbChainEvict ownership pins.
