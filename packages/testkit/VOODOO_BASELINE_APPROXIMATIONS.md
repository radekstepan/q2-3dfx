# Voodoo working-baseline approximations

Working visual baseline only — **not hardware-calibrated**. The word
"hardware-calibrated" is reserved for a future comparison against a
documented Voodoo3/MiniGL capture (see `CAPTURE-M4.1.md`). Base pinned at
`5e13d42`.

Regenerate: `yarn workspace @q2/testkit baseline` — writes
`test-output/voodoo-baseline/` (gitignored `.rgba` blobs + sidecar JSON)
and refreshes the committed hash manifest
`baseline-manifests/voodoo-baseline.json` (hashes + settings, no pixels).
Tests gate on the committed hashes, never on blobs.

## 1. Pinned profile (duplicated by value, not imported)

Values mirror `packages/config` `vd_*` defaults and
`packages/voodoo` `defaultVoodooState()` at the pinned base. Duplication is
deliberate: `deps:check` allows `testkit: ['*']`, but a live import would let
parallel voodoo lanes move this baseline. The voodoo test cross-checks the
live package only through optional dynamic import (stable properties:
`resolveFrame`/`expandRGB565` exist; expand inverts a 565 pack to within one
quantum per channel).

| cvar | pinned | source | status |
| --- | --- | --- | --- |
| `vd_16bit` | 1 | prog guide: 16-bit RGB565 target | manual |
| `vd_dither` | 1 | `fbzMode[8,11]`: ordered dither at target writes | manual (matrix: approx) |
| `vd_postfilter` | 1 | `vidProcCfg[17:16]`: scanout reconstruction | manual (pairing: approx) |
| `vd_bilinear` | 1 | game default `GL_LINEAR_MIPMAP_NEAREST` | manual |
| `vd_mipdither` | 1 | `textureMode.tlodDither` (+0.375 avg LOD, needs bias comp) | manual (selector: approx) |
| `vd_lodbias` | -0.35 | `tLOD.lodbias` added to `log2(rho)` | manual (value: project preset) |
| `vd_fog` | 1 | 64-entry table fog capability gate; scene contribution zero | manual |
| `vd_gamma` | 1.3 | MiniGL transfer LUT before dither | manual (1.3 is a preset, not a hw constant) |
| `vd_maxtexsize` | 256 | Voodoo3 256x256 texture cap | manual |
| `vd_zbits` | 16 | 16-bit depth buffer | manual |
| `vd_palettetex` | 1 | palettised upload policy | manual |
| `vd_overbright` | 1 | compat modulate x2 + clamp (blanket; `gl_image` audit pending) | approx |
| `vd_dithermode` | `4x4` | `fbzMode` 4x4 matrix select | approx (exact weights/phase unverified) |
| `vd_reconmode` | `legacy` | `vidProcCfg` pairing select | approx (legacy = 4x4-dither + 2x2 box, no subtract) |
| `vd_rgbmaxdelta` | `0,0,0` | `rgbMaxDelta` edge-rejection thresholds | approx (zeros = unconditional box) |

## 2. Manual-sourced (hardware/programmer-guide grounded)

- RGB565 render target; truncate quantise; bit-replication expand.
- Gamma LUT shape `round(255 * (c/255)^(1/gamma))` applied pre-dither.
- 4x4 Bayer phase `(y & 3) << 2 | (x & 3)`; amplitudes ±0.5 LSB of the
  16-bit target (RB ±4, G ±2 8-bit units).
- Legacy scanout: 2x2 box of expanded taps, clamp-to-edge, `(sum + 2) >> 2`.
- LOD sign convention: bias ADDED (`log2(rho) + bias`); negative favours finer.
- Opaque alpha (`0xFF...`) on every display pixel; channel order `0xAABBGGRR`.

## 3. Chosen approximations (no HW capture yet)

1. Dither matrix exact weights/phase = canonical Bayer (MiniGL programming
   of `fbzMode` unverified). Would confirm: `fbzMode` register trace.
2. Legacy recon pairing (4x4 dither + unconditional 2x2 box, no dither
   subtraction) — a blanket blur that melts dither; `2x2sub+2x2box` /
   `4x4sub+4x1` modes with `rgbMaxDelta` rejection are reserved, thresholds 0.
3. Gamma value 1.3 and LOD bias -0.35 are project presets, not constants.
4. `vd_overbright` blanket x2 (id `intensity`/`gl_image` staging audit pending).
5. **Fixtures are synthetic**, not engine renders (except `devroom`, which is
   the procedural NullRefresh serial path): no WAL/MD2/BSP lightmaps, no
   translucency sorting, no depth test, no HUD. `display` stage == 
...[truncated 2086 chars]