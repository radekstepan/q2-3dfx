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
   `reconstructed` (fixtures carry no HUD; a strict-HUD path would compose
   HUD pre-scanout).

## 4. Determinism harness + coverage gaps (DEMO1 tail, 2026-10-27)

Scripted tick sequence: `src/demo-determinism.ts` renders every fixed
`demoFallbackViews()` camera for 6 ticks at the 10 Hz server tick through
`SoftwareRenderer` + procedural `createDevroom()` (160x120, warm-ramp
palette shared with the sw-renderer golden) and records per frame
`{camera, tick, time, origin, angles, style0, style1, colorHash, indexHash}`.
`src/demo-determinism.test.ts` proves two fresh runs are identical, pins
all 18 frame hashes, and proves time advancement (pillar/wide ticks 0 vs 2
move) and style-0 flicker (ticks 0 vs 1 move on every camera) both change
the frame. Re-pin procedure: render `runDemoTicks()`, paste the new
`{camera, tick, colorHash, indexHash}` rows into `PINNED`, re-run
`yarn workspace @q2/testkit test`. Manifest envelope
(`demoTickManifest`) is JSON-safe; hashes only, never pixels or blobs.

Manifest completeness is gated programmatically
(`src/voodoo-baseline.test.ts`): every committed AND freshly generated
entry must carry map, camera (name/origin/angles/fovX), simTime,
resolution, the full 15-key profile (12 `vd_*` + dithermode/reconmode/
rgbmaxDelta), renderer (revision/resolve) and all three stages
(raw-565/reconstructed/display) with hash + pixel count. Sim-time coverage
(t=0/1.5/3 via round-robin fallback cameras) is asserted as a set.

Known gaps (no retail assets involved):

- Baseline captures use static `lightStyles = 1`: the `devroom` scene goes
  through `NullRefresh`, which ignores `RefDef.time` AND `lightStyles`
  entirely, so baseline simTimes are labels, not animated frames. Flicker
  coverage lives on the `SoftwareRenderer` determinism path instead.
- `styles[1]` is unobservable on the asset-free devroom: its only consumer
  is the turbulent water banner's lightmap, and turbulent spans render
  unlit (fullbright warp). The tick flicker drives `styles[0]` (the slot
  every lit surface consumes); `style1` is recorded at 1.0 so a future
  devroom that lights the banner trips the pins loudly.
- Real `demo1.dm2` playback needs the retail pak (`maps/base1.bsp`, WAL,
  MD2) and stays Q2_PAK-gated; `demo1.dm2` itself never ships and no pak
  bytes are committed, cooked, or fetched by CI.