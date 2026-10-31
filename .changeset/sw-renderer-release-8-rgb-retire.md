---
'@q2/sw-renderer': major
---

Retire the legacy CPU RGB/scanout execution path (RELEASE-8 step 3). Removes RGBWorldBackend, drawSpansRGB and all RGB span/mip/565/window-Z helpers, SPAN_ADD, JOB_RGB/JOB_SCANOUT and the RGB/scanout worker staging (bands + pool), scanout buffers, the renderer's RGB planes/caches/materials/fidelity/skip flags, and all RGB test suites. The indexed software renderer (spans, surface cache, alias/sprite/particle/tracer draws, banded SAB workers, async render) is unchanged and bit-identical (devroom golden 8f61c755 preserved). webgl-renderer shared imports (MiniWorld/camera/alias/worldNodes/spans front-end) are unaffected. Consumers must migrate off the removed symbols; the WebGL2 backend owns Voodoo appearance.
