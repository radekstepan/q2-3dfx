# GPU-PROOF-4 — Voodoo appearance on WebGL2 (implementation notes)

Card: BRAIN.md §8 GPU-PROOF-4. Owner packages: `packages/webgl-renderer`
(+ `packages/voodoo` — NOT changed, see §1). This file is the PROOF-4
"README": every GPU interpretation of the `vd_*` cvars and every documented
deviation from the CPU reference / contract.

## 1. Shared-policy reuse list (voodoo stays WebGL-free, untouched)

`yarn deps:check` (allowlist in `tools/asset-cooker/.../check-deps`,
mirrored in BRAIN.md §3) permits `webgl-renderer` to depend ONLY on
`bsp/config/formats/math/renderer-api/sw-renderer` — `@q2/voodoo` is NOT an
allowed edge, and this card may not touch BRAIN.md, docs/ or the allowlist.
So NO import was added; every voodoo value below is DUPLICATED BY VALUE in
`src/appearance.ts` (file + formula cited per symbol) and pinned by
`src/appearance.test.ts` against literals transcribed from the voodoo source
(verified against the source formulas with node: Bayer offsets, gamma
LUT(128,1.3)=150 — see card report). If the integrator later adds the
`voodoo` edge, these become imports with zero policy change.

Duplicated (voodoo source -> `src/appearance.ts`):
- `bayer.ts` BAYER4/BAYER2/DITHER_RB_POS/DITHER_G_POS/DITHER2_* (+ GLSL
  `VOODOO_BAYER4` int array, same row-major values, absolute screen phase).
- `resolve.ts` quantiseRGB565/expandRGB565/gammaLUT/parseDitherMode/
  parseReconMode/parseRgbMaxDelta/defaultRgbMaxDelta
  -> pack565/expand565/gammaLUTValue/parseDitherModeStr/parseReconModeStr/
  parseRgbMaxDeltaStr/DEFAULT_RGB_MAX_DELTA([8,8,8]).
- `sampler.ts` buildFogTable/fogFactor/mipLevel/pickMipLevel/
  lodBiasCompensation/capTextureSize/modulateLightmap
  -> buildFogLUT01(0..1 floats)/fogTableIndex/mipLevelFor/pickMipLevelFor/
  LOD_DITHER_MEAN(0.375)/capCappedDims/applyOverbrightCPU.
- `upload.ts` halveRGB/resampleRGBInto -> halveRGBBox/resampleRGBBox
  (expanded-RGB arms only: the GPU always uploads expanded RGB, so the
  indexed-input arms are dropped).

Read live from `@q2/config` (already a dependency): every `vd_*` cvar via
`resolveAppearanceFrame()` once per frame (uniform updates only).

## 2. GPU interpretation of every vd_* cvar

| cvar | kind | GPU interpretation |
| --- | --- | --- |
| `vd_gamma` | live uniform | `uGamma` display LUT AFTER reconstruction (RAMDAC placement): `pow(c,1/gamma)` in FS_APPEARANCE, the shader form of gammaLUTValue. 1.3 is a project preset, not a hardware constant. |
| `vd_dither` | live uniform | `uDitherOn` write-matrix dither at target resolve; independent of mip dithering. |
| `vd_dithermode` | live uniform | `uDitherMode` write matrix 4x4 (default) / 2x2. The scanout subtract matrix is dictated by `vd_reconmode`, never this (matched-reinforcement rule). |
| `vd_postfilter` | live uniform | `uPostfilter`; 0 shows the quantized target per pixel (every pixel rewritten via texelFetch — never stale), then display gamma. |
| `vd_reconmode` | live uniform | `uReconMode`: 1 = matched `2x2sub+2x2box` (default); 0 = `legacy` unconditional 2x2 box (no subtract, no edge gate); 2 = `4x4sub+4x1` centered `[x-1,x+2]` window with row gate. Subtracted on dithered writes only (dither-off => no subtract). Taps use absolute screen coordinates. |
| `vd_rgbmaxdelta` | live uniform | `uRgbMaxDelta` per-component 2x2 spread gate; rejected pixels keep the dither-subtracted centre tap, sharp. `0,0,0` disables (= unconditional box). |
| `vd_16bit` | live uniform | `u16bit`; `=0` is the RGB888 debug bypass (gamma on, dither/reconstruction off), mirroring resolveRGB888. Alpha preserved verbatim in every path. |
| `vd_overbright` | live uniform | `uOverbright` light modulate ×2 + clamp (clipping highlights like hardware); blanket ×2 pending the `gl_image` audit. Applies to lit world + alias (lightmapped); flat/beam/particle color passes through. |
| `vd_fog` | live uniform | `uFogEnabled` capability gate for the 64-entry exp² table (`uFogTable`, density 3.0). Scene contribution `uFogAmount` is 0 in base1 — no haze expected (proven by default; the FORCED-fog fixture drives amount=1 to prove the LUT path, not base1). Order: overbright first, then fog (CPU shadePixel order). |
| `vd_lodbias` | live uniform | `uLodBias` added to `log2(rho)`; pinned **-0.35** for the proof baseline (negative favours finer). |
| `vd_mipdither` | live uniform | `uMipDither` single-TMU n/n+1 Bayer pick by threshold vs fraction (`f*16<=b`), with the avg **+0.375** compensation on the dither path ONLY (never double-added); `=0` forces level-n LINEAR (round-to-nearest). |
| `vd_bilinear` | live uniform | Sampler MIN/MAG LINEAR vs NEAREST, switched per frame via texParameteri (no re-upload). Mip levels are still addressed explicitly via textureLod. |
| `vd_maxtexsize` | upload-time | Cap enforced at upload: aspect-preserving box resample to capped dims + recorded warning. The GPU goes one step further than the contract's clamp+warn minimum and actually resamples (box), closing the "real resampling pending" gap on the GPU path; the CPU dims-helper stays dims-only. Oversized skins (e.g. real 288x195 soldier / 296x164 gun) resample instead of crashing. |
| `vd_zbits` | target-creation | `<=16` requests DEPTH_COMPONENT16, `>=24` requests DEPTH_COMPONENT24. GL depth tests BEFORE the write (true pre-test policy), unlike the CPU post-hoc banding helper. Re-read on target (re)creation (init/resize/restore). |
| `vd_palettetex` | policy note | No paletted textures in WebGL: always uploads expanded RGB; filtering is identical either way and `vd_palettetex` never gates filtering (per the CPU rule). |
| `vd_dithermode` (read-path) | live uniform | See `vd_dithermode` above. |
| `vd_reconmode` (read-path) | live uniform | See `vd_reconmode` above. |
| `vd_rgbmaxdelta` (read-path) | live uniform | See `vd_rgbmaxdelta` above. |

HUD ordering: the HUD is composited ABOVE by the `apps/web` overlay (already
above GL); no HUD code runs here (ordering preserved, nothing to implement).

## 3. Render-target design (resident on GPU through presentation)

- Scene renders into a size-matched linear target FBO (color + depth
  renderbuffer), then ONE fullscreen pass (buffer-less `gl_VertexID`
  triangle) resolves to the canvas. The normal path never reads back
  (no `readPixels` in `src/` — pinned by stub-call assertions).
- RGBA16F when `EXT_color_buffer_float` renders it, else an RGBA8 fallback
  with ONE recorded warning. Capability branch, tested both ways via stub
  (float-capable stub + float-less stub; proof3's stub pins the fallback).
- `resize` / context-loss re-create targets lazily on the next real frame
  (no GL calls in `resize` itself — minimal-stub safe). Target (re)creation
  is NOT a texture upload: `testUploadStats()` counts only
  static-generation uploads (contract pinned by test).
- Alpha is preserved verbatim through the appearance pass (blend-pass
  invariant: translucents composite in the linear target in draw order; the
  resolve must not touch alpha — reviewed in GLSL, all `oColor` writes
  re-emit the fetched alpha).

## 4. Mip policy (single-TMU dither on the GPU)

- Chains built on the CPU at upload with the Voodoo box-filter rule and
  CLAMP addressing (the VOODOO-REPAIR-2 green-where-red fix: footprints never
  wrap into foreign texels), down to 1x1; every level uploaded explicitly.
- Fragment shader: `rho = max(|dFdx|,|dFdy|)` of texel-space UVs via
  fwidth, `lod = log2(rho) + uLodBias + (dither ? 0.375 : 0)`, Bayer pick
  of n/n+1 by threshold vs fraction, `textureLod(map, vUV, lvl)` with
  LINEAR sampling and a per-texture `uMaxLevel` clamp.
- The CPU sampler's explicit "scale UVs into the picked level (1/(1<<lvl))"
  is SUBSUMED by `textureLod`: the picked level is addressed in its own
  coordinate space. `mipUVScale(lvl) = 1/(1<<lvl)` documents/pins this
  equivalence (table-driven tests); `vUV` stays level-0 texel space.
- Lightmaps are deliberately NOT mipped (plain LINEAR `texture()`): the CPU
  bakes per-miplevel surface blocks, which has no GPU equivalent (gap).
- NPOT textures need no POT handling (WebGL2 + CLAMP); noted as differing
  from real-Voodoo POT requirements (accepted approximation).

## 5. Documented deviations (approximations, not bit-exact emulation)

1. Mip filter: single-level LINEAR pick with dither, not smooth trilinear;
   lightmaps unmipped (see §4).
2. Blending: true SRC_ALPHA blending, not Voodoo screen-door (contract §4
   deviation, preserved from PROOF-3).
3. Fog: capability-gated table fog, scene contribution 0 in base1 (no haze);
   proven inert by default + proven live by the FORCED-fog fixture.
4. Turbulence: water draws unwarped (warp deferred to EXPAND).
5. Skins cap: GPU resamples oversized skins (box) where the CPU helper is
   still dims-only — GPU closes the gap, CPU helper pending.
6. Depth: GL pre-test depth (true policy); the CPU post-hoc banding helper
   is display-only and not used here.
7. No per-draw RGB565 rounding between translucent draws mirrored exactly:
   the linear target holds lit values, translucents composite in draw order
   in the quantized target at resolve — the contract's chosen approximation
   (F1/F2 pin scenes: tracer over world + sprite + particle cloud + gun).
8. No claim of hardware-accurate Voodoo3 emulation without a Voodoo3 capture
   oracle (contract §4).
