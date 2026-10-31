---
'@q2/renderer-api': major
---

RELEASE-8: remove `voodoo` from `ResolvedBackend` (`software | webgl2-experimental`); `resolveRendererSelection('voodoo', …)` migrates one-time to `software` with an explicit warning, never auto-promoted to webgl2. Frozen `Refresh`/`Framebuffer`/`RefDef`/`Entity` contracts untouched.
