# @q2/voodoo — RETIRED (RELEASE-8)

> The legacy CPU Voodoo execution mode (per-frame resolve/scanout on the CPU) is
> retired. The Voodoo3 appearance policy now lives in `@q2/webgl-renderer`
> (`src/appearance.ts`, duplicated by value — no `webgl-renderer → voodoo` dep
> edge); `vd_*` cvars remain as per-frame WebGL appearance uniforms
> (`docs/renderers.md` §7.2). What follows is the historical record of this
> package, kept until the code lane removes it. Do not add new importers.

Voodoo3/Glide emulation: per-frame post-process + texture-sampling policy (M4.1/M4.2).
Ports the `ref_gl` Voodoo path's resolve chain and sampler rules; not a second renderer —
it reuses the software geometry front end and adjusts sampling/resolve (BRAIN.md §7.2).

Entry point: `src/index.ts:1`. Re-exports `bayer.js`, `capture.js`, `profile.js`,
`resolve.js`, `sampler.js`, `upload.js` (`src/index.ts:13-18`) plus cvar-aware wrappers driven by `VoodooState`.

## Public API

- `VoodooState` (`src/index.ts:24`) — per-frame snapshot of all `vd_*` fidelity cvars, incl. `dithermode`, `reconmode`, `rgbmaxdelta` profile data (read-path only).
- `defaultVoodooState()` (`src/index.ts:48`) — hardware defaults (gamma 1.3, 256px cap, 16-bit…, dither `4x4`, recon `2x2sub+2x2box`, thresholds `8,8,8` = smooth passes, hard edges reject).
- `readVoodooState()` (`src/index.ts:69`) — snapshots `vd_*` cvars from `@q2/config` (incl. `vd_dithermode`/`vd_reconmode`/`vd_rgbmaxdelta`; `legacy` reconmode stays an accepted alias for the unconditional box, unknown modes fall back to `2x2sub+2x2box`); call once per frame.
- `resolveFrame(src, dst565, display, w, h, st)` (`src/index.ts:113`) — single hardware-correct path for ALL reconmodes (guide §7.2 RAMDAC order): LINEAR pack (gamma 1) → matched reconstruction per `reconmode` (`2x2sub+2x2box` / `4x4sub+4x1` = mode-forced dither-subtract + box with `rgbmaxdelta` edge rejection; `legacy` alias = unconditional 2x2 box, no subtract, same gamma placement) → display gamma LUT on the display plane (`applyDisplayGamma`); postfilter-off packs linear, expands, then gamma-corrects. PERF-3: the quantise-on chain runs fused (`resolveFusedFrame`, `src/resolve.ts:445` — pack rows on demand into `dst565`, reconstruct from the hot rows, gamma inline; byte-identical to the manual 3-pass pipeline, pinned by `src/fused.test.ts`). Display is always fully rewritten, never stale. With `quantise` off, display is filled by the genuine RGB888 bypass (`resolveRGB888`: gamma on source, dither/postfilter off). Pass `display = null` to skip.
- `sampleTexture(indices, palette, w, h, u, v, out, off, st)` (`src/index.ts:185`) — cvar-aware palette texture sample; filtering follows `vd_bilinear` only (`vd_palettetex` is upload/storage policy, not a filter switch).
- `sampleRGBTextureFrame(tex, w, h, u, v, out, off, st)` (`src/index.ts`) — cvar-aware expanded-RGB-triplet sample with the same bilinear/nearest policy.
- `shadePixel(...)` (`src/index.ts:223`) — overbright lightmap modulate + table-fog blend, returns packed `0xFFBBGGRR`.
- `quantiseDepthFrame(depth, st)` (`src/index.ts:158`) — 1/z banding to `vd_zbits` bits (display/banding approximation only, NOT depth-buffer emulation).
- `capTextureSizeFrame(w, h, st)` (`src/index.ts:169`) — halve-until-fit for `vd_maxtexsize`.
- Low level (`src/resolve.ts`, `src/sampler.ts`): `gammaLUT` (`:40`, power-curve LUT, gamma 1 default-off at 1.0 / preset 1.3), `applyDisplayGamma` (RAMDAC-stage LUT on the display plane; every quantise-on path), `resolveRGB565` (`:174`, `ditherMode` `2x2`|`4x4` default `4x4`), `resolveRGB888` (genuine RGB888 bypass, gamma on / dither off by default), `applyPostFilter` (`:326`, unconditional 2x2 box — the `legacy` alias path), `applyReconstruction2x2` / `applyReconstruction4x1` (dither-subtract + box/4x1 with `RgbMaxDelta` edge rejection, `passesReconstructionThreshold[Row]`; all-zero thresholds = unconditional box), `DitherMode` / `ReconMode` / `parseDitherMode` / `parseReconMode` / `parseRgbMaxDelta`, `quantiseDepth` (`:798`, banding-only compat), pre-test depth plane `createDepth16` / `clearDepth16` / `testAndWriteDepth16` (normalized Z16: depth01 derived from the projection near/far planes, LESS, tie-keeps-stored, clear = far; W-buffer NOT implemented) alongside compat `quantiseDepthBeforeTest` / `depthTestLess`, `sampleBilinear` (`sampler.ts:18`), `samplePalette` (`sampler.ts:81`), `sampleRGBTexture` (expanded RGB triplets, same filter policy), `pickMipLevel` (`sampler.ts:155`), `buildFogTable` (`sampler.ts:186`), `modulateLightmap` (`sampler.ts:240`), `capTextureSize` (`sampler.ts:265`); upload `resampleTexture` / `halveRGB` / `completeMipChainRGB` / `padTextureToPOT` / `nextPOT` (`src/upload.ts`: REPEAT textures resample, CLAMPED textures pad-to-POT + UV adjust — application/driver policy choice); tables `BAYER4`, `DITHER_RB_POS` (`src/bayer.ts:9,27`), `BAYER2`, `DITHER2_RB_POS` (`src/bayer.ts`). All non-legacy scanout modes are deterministic approximations until HW capture (see source docs).
- `VOODOO_APPROX_PROFILE` (`src/profile.ts`) — the documented approximation profile: every non-calibrated setting with its source tag (`manual:fbzMode` / `manual:vidProcCfg` / `manual:tLOD` / `approx:chosen` / `preset:appearance`). Nothing here is "hardware-calibrated" (reserved for later HW comparison). Scanout order is linear-pack → reconstruct/box → display gamma for all modes with matched pairs only (`2x2sub+2x2box` default, `4x4sub+4x1`; `legacy` alias = unconditional box, no subtraction). LOD compensation (+0.375) applies exactly once in `mipLevel` for the tlodDither path only — never in the round-to-nearest `pickMipLevel` path.
- `captureCVarTable()` (`src/capture.ts:16`) — the 12 `vd_*` cvars at capture values; single source for `packages/testkit/CAPTURE-M4.1.md`.

## How it is used (historical — retired)

No package may import `@q2/voodoo`; the remaining static/dynamic references
(`apps/web` resolve/scanout, `tools/bench` RGB legs, `testkit` resolve probes)
are removed by the RELEASE-8 code lanes. The snippet below is the retired
calling convention, kept for the record:

```ts
import { readVoodooState, resolveFrame } from '@q2/voodoo';
const st = readVoodooState();          // one snapshot per frame
// ... rasterise into fb (Uint32Array 0xAABBGGRR), fb565 (Uint16Array)
resolveFrame(fb, fb565, display, w, h, st);
```

## Testing

- `yarn workspace @q2/voodoo test` — vitest; suites `src/resolve.test.ts`, `src/sampler.test.ts`, `src/scanout.test.ts` (threshold/scanout/depth-plane fixtures), `src/upload.test.ts` (incl. LOD-compensation-once + clamp-pad policy tests), `src/profile.test.ts` (pins `VOODOO_APPROX_PROFILE`) — deterministic: fixed Bayer matrices, no RNG.
- `yarn workspace @q2/voodoo golden` / `bench` are stub `echo` scripts (no goldens pinned here).
- `yarn workspace @q2/voodoo golden` / `bench` are stub `echo` scripts (no goldens pinned here).

## Constraints

- Dependency direction (BRAIN.md §4, RELEASE-8 residual): sat beside `sw-renderer`
  above `bsp`/`formats`/`math`; read (never wrote) `vd_*` cvars from `@q2/config`.
  Nothing may import `apps/*`. No new importers; this package is deleted on
  retirement completion.
- Platform: DOM-free, zero-alloc inner loops, typed arrays only — runs in a worker and in Node tests.
