---
"@q2/voodoo": patch
"@q2/webgl-renderer": patch
---

VF-4: relabel overbright ×2 as game-pipeline policy. `modulateLightmap` / `applyOverbrightCPU` / `shadePixel` docs now cite the verified provenance (ref_gl `gl_modulate` default 1; PG CCU/ACU/texture-combine have no scale stage) and drop the Voodoo-hardware claim; new `lightmap.overbright-x2` approx:chosen profile entry; VF-4 no-math-change guard pins. No math changed.
