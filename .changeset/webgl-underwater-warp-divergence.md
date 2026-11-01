---
'@q2/renderer-api': patch
'@q2/webgl-renderer': patch
'web': patch
---

DIVERGENCE underwater screen warp on WebGL2 (user-requested): the appearance pass now applies the ref_soft D_WarpScreen sine warp when the eye is submerged, before the Voodoo resolve (warp-then-tint, like software warp-then-palettize). Original ref_gl never did this (tint-only R_PolyBlend); the new behavior intentionally diverges. GpuFrameInput gains an optional underwater flag, the FS_APPEARANCE shader gains uWarpOn/uWarpTime + warpSrcPx (AMP2=3/SPEED=20/CYCLE=128 table mirror, software top-origin orientation), and frameGpuPlay forwards driver.underwaterOverlay().submerged. Dry/solid eyes keep verbatim passthrough (ref_gl parity).
