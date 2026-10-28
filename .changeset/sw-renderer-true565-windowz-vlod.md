---
"@q2/sw-renderer": minor
---

feat(sw-renderer): true per-write RGB565 storage, window-Z depth, vertical LOD footprint

BREAKING (RGB path only — the software indexed path is bit-identical): the RGB
world/effect backend now owns packed RGB565 (`Uint16Array rgb565`) as the color
authority plus a `Uint16Array` window-Z depth plane, instead of the RGB888
`Uint32Array` + float `1/z` planes. Every opaque write quantises 8:8:8 → 565 on
write; every translucent/alpha/additive read-modify-write expands the STORED 565
quantum, blends in 8-bit integer math, and re-quantises. The `Uint32` plane
survives only as the endFrame resolve scratch (expanded from 565 where covered).
Depth is normalized window-Z from the projection window threaded
Camera → renderView → drawSpansRGB (`depth01 = far/(far-near) -
(far*near/(far-near))*iz`, clamped 0..1, quantised to `mat.zbits`, integer LESS,
ties keep stored, clear all-ones = far; default window 4..32768 contains the
16384 skybox). The span LOD footprint is now fully 2D: `emitSpansForPoly` fits a
screen-space plane per polygon and stores du/dy + dv/dy on the Span
(`F_PER_SPAN` 11 → 13, banded flat pack carries them), sprites use analytic
billboard gradients, alias keeps its per-tri edge footprint; `rho =
max(|dudx|,|dvdx|,|dudy|,|dvdy|) + lodBias`.

Golden pins recomputed (RGB only): devroom 160x120 RGB composite `3534624e` →
`a9988ff4`; software index `58e0ecf1` and pooled `8f61c755` unchanged.
