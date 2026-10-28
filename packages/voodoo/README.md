# @q2/voodoo

Voodoo3/Glide emulation: per-frame post-process + texture-sampling policy (M4.1/M4.2).
Ports the `ref_gl` Voodoo path's resolve chain and sampler rules; not a second renderer —
it reuses the software geometry front end and adjusts sampling/resolve (BRAIN.md §7.2).

Entry point: `src/index.ts:1`. Re-exports `bayer.js`, `capture.js`, `profile.js`,
`resolve.js`, `sampler.js`, `upload.js` (`src/index.ts:13-17`) plus cvar-aware wrappers driven by `VoodooState`.

## Public API

- `VoodooState` (`src/index.ts:20`) — per-frame snapshot of all `vd_*` fidelity cvars, incl. `dithermode`, `reconmode`, `rgbmaxdelta` profile data (read-path only).
- `defaultVoodooState()` (`src/index.ts:35`) — hardware defaults (gamma 1.3, 256px cap, 16-bit…, dither `4x4`, recon `legacy`, thresholds `0,0,0` = no rejection).
- `readVoodooState()` (`src/index.ts:53`) — snapshots `vd_*` cvars from `@q2/config` (incl. `vd_dithermode`/`vd_reconmode`/`vd_rgbmaxdelta` with legacy fallbacks); call once per frame.
- `resolveFrame(src, dst565, display, w, h, st)` (`src/index.ts:75`) — gamma → dither (matrix per `dithermode`) → RGB565, then scanout reconstruction per `reconmode` (`legacy` = unconditional 2x2 box; `2x2sub+2x2box` / `4x4sub+4x1` = dither-subtract + box with `rgbmaxdelta` edge rejection) or per-pixel 565-expand into display (display is always fully rewritten, never stale). With `quantise` off, display is filled by the genuine RGB888 bypass (`resolveRGB888`: gamma on, dither/postfilter off). Pass `display = null` to skip.
- `sampleTexture(indices, palette, w, h, u, v, out, off, st)` (`src/index.ts:115`) — cvar-aware palette texture sample; filtering follows `vd_bilinear` only (`vd_palettetex` is upload/storage policy, not a filter switch).
- `sampleRGBTextureFrame(tex, w, h, u, v, out, off, st)` (`src/index.ts`) — cvar-aware expanded-RGB-triplet sample with the same bilinear/nearest policy.
- `shadePixel(...)` (`src/index.ts:135`) — overbright lightmap modulate + table-fog blend, returns packed `0xFFBBGGRR`.
- `quantiseDepthFrame(depth, st)` (`src/index.ts:91`) — 1/z banding to `vd_zbits` bits (display/banding approximation only, NOT depth-buffer emulation).
- `capTextureSizeFrame(w, h, st)` (`src/index.ts:102`) — halve-until-fit for `vd_maxtexsize`.
- Low level (`src/resolve.ts`, `src/sampler.ts`): `gammaLUT` (`:24`, power-curve LUT, gamma 1 default-off at 1.0 / preset 1.3), `resolveRGB565` (`:77`, `ditherMode` `2x2`|`4x4` default `4x4`), `resolveRGB888` (genuine RGB888 bypass, gamma on / dither off by default), `applyPostFilter` (`:136`, legacy unconditional 2x2 box), `applyReconstruction2x2` / `applyReconstruction4x1` (dither-subtract + box/4x1 with `RgbMaxDelta` edge rejection, `passesReconstructionThreshold[Row]`; all-zero thresholds = unconditional box), `DitherMode` / `ReconMode` / `parseDitherMode` / `parseReconMode` / `parseRgbMaxDelta`, `quantiseDepth` (`:192`, banding-only compat), pre-test depth plane `createDepth16` / `clearDepth16` / `testAndWriteDepth16` (normalized Z16: depth01 derived from the projection near/far planes, LESS, tie-keeps-stored, clear = far; W-buffer NOT implemented) alongside compat `quantiseDepthBeforeTest` / `depthTestLess`, `sampleBilinear` (`sampler.ts:18`), `samplePalette` (`sampler.ts:81`), `sampleRGBTexture` (expanded RGB triplets, same filter policy), `pickMipLevel` (`sampler.ts:155`), `buildFogTable` (`sampler.ts:186`), `modulateLightmap` (`sampler.ts:240`), `capTextureSize` (`sampler.ts:265`); upload `resampleTexture` / `halveRGB` / `completeMipChainRGB` / `padTextureToPOT` / `nextPOT` (`src/upload.ts`: REPEAT textures resample, CLAMPED textures pad-to-POT + UV adjust — application/driver policy choice); tables `BAYER4`, `DITHER_RB_POS` (`src/bayer.ts:9,27`), `BAYER2`, `DITHER2_RB_POS` (`src/bayer.ts`). All non-legacy scanout modes are deterministic approximations until HW capture (see source docs).
- `VOODOO_APPROX_PROFILE` (`src/profile.ts`) — the documented approximation profile: every non-calibrated setting with its source tag (`manual:fbzMode` / `manual:vidProcCfg` / `manual:tLOD` / `approx:chosen` / `preset:appearance`). Nothing here is "hardware-calibrated" (reserved for later HW comparison). Scanout order is subtract-then-filter for non-legacy modes with matched pairs only (`2x2sub+2x2box`, `4x4sub+4x1`); `legacy` stays the default to preserve the bit-exact M4.1 path. LOD compensation (+0.375) applies exactly once in `mipLevel` for the tlodDither path only — never in the round-to-nearest `pickMipLevel` path.
- `captureCVarTable()` (`src/capture.ts:16`) — the 12 `vd_*` cvars at capture values; single source for `packages/testkit/CAPTURE-M4.1.md`.

## How it is used

No in-repo package imports `@q2/voodoo` yet; it is designed for the host/web shell resolve
stage: rasterise in 8:8:8, sample via `sampleTexture`, then `resolveFrame` per frame.

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

- Dependency direction (BRAIN.md §4): sits beside `sw-renderer` above `bsp`/`formats`/`math`; reads (never writes) `vd_*` cvars from `@q2/config`. Nothing may import `apps/*`.
- Platform: DOM-free, zero-alloc inner loops, typed arrays only — runs in a worker and in Node tests.
