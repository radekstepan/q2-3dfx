---
'web': patch
---

RELEASE-15 underwater parity audit tests: second-resolution (160x120) warp gating/determinism with a resizePlay round-trip proving bit-identical warp bytes after compression-table rebuild, a warp-locality bound (every warped texel originates within Chebyshev radius 8, derived from AMP2+MARGIN) distinguishing the C sine warp from invented distortion, and a renderer-switch-while-submerged test (software round-trip zeroes stale pixels, failed-GPU fallback keeps tint+warp with warning). No production change: source audit against ref_soft/ref_gl confirmed tint values, warp structure, warp-then-tint ordering, and WebGL2 tint-only parity. Vitest: 13/13 underwater tests pass; apps/web typecheck clean.
