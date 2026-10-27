---
'web': patch
---

Connect vid_renderer to the real raster policy (V2d). `applyRendererCvar` now arms/disarms the sw-renderer RGB world path via feature-detected hooks (`setRGBWorldEnabled` et al, no hard dependency) and zeroes shell scratch so mode switches never show a stale frame. Resolve ownership is documented and enforced: the shell owns scanout (single `resolveFrame` per frame; a renderer-side `voodooScanoutDone` flag would skip the shell pass). New strict-voodoo path (default ON) composes HUD into the emulated target before scanout reconstruction + display gamma; legacy/software paths keep paint-HUD-after + `r_brightness`. Worker bands share one per-frame `VoodooState` snapshot with absolute screen coords; scanout stays global-serial after all bands complete (explicit `selectVoodooBandPath() === 'serial'` until a worker/WASM voodoo backend exists). Strict presentation targets fixed 640x480 4:3 pixelated upscale with no second smoothing pass.
