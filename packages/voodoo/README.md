# @q2/voodoo — pure policy library (RELEASE-8)

> The legacy CPU Voodoo execution mode (per-frame resolve/scanout on the CPU:
> `resolveFrame`, `resolveFusedFrame`, `resolveRGB565/888`, `applyDisplayGamma`,
> `applyPostFilter`, `applyReconstruction2x2/4x1`) is retired and deleted.
> This package is now a pure-function policy library (quantise, gamma LUT,
> Bayer/dither tables, mip/LOD, fog, modulate, cap, upload, table-fog) with
> no frame driver. The WebGL2 appearance canonical source is `@q2/webgl-renderer`
> (`src/appearance.ts`, duplicated by value — no `webgl-renderer → voodoo` dep
> edge); `vd_*` cvars remain as per-frame WebGL appearance uniforms.
> Kept cvar-aware adapters (`readVoodooState`, `sampleTexture`, `shadePixel`, ...)
> take explicit parameters so unit tests stay deterministic.
> Do not add frame-execution code or new CPU resolve importers.

Voodoo3/Glide policy: pure sampling + quantise/display policy (M4.1/M4.2 pins, no frame driver).
Ports the `ref_gl` Voodoo path's resolve chain and sampler rules; not a second renderer —
it reuses the software geometry front end and adjusts sampling/resolve (BRAIN.md §7.2).

Entry point: `src/index.ts:1`. Re-exports `bayer.js`, `capture.js`, `profile.js`,
`resolve.js`, `sampler.js`, `upload.js` (`src/index.ts:13-18`) plus cvar-aware wrappers driven by `VoodooState`.

## Public API

- `VoodooState` (`src/index.ts:24`) — per-frame snapshot of all `vd_*` fidelity cvars, incl. `dithermode`, `reconmode`, `rgbmaxdelta` profile data (read-path only).
- `defaultVoodooState()` (`src/index.ts:48`) — hardware defaults (gamma 1.3, 256px cap, 16-bit…, dither `4x4`, recon `2x2sub+2x2box`, thresholds `8,8,8` = smooth passes, hard edges reject).
- `readVoodooState()` (`src/index.ts:69`) — snapshots `vd_*` cvars from `@q2/config` (incl. `vd_dithermode`/`vd_reconmode`/`vd_rgbmaxdelta`; `legacy` reconmode stays an accepted alias for the unconditional box, unknown modes fall back to `2x2sub+2x2box`); call once per frame.
- `resolveFrame` / `resolveFusedFrame` / `resolveRGB565` / `resolveRGB888` / `applyDisplayGamma` / `applyPostFilter` / `applyReconstruction2x2` / `applyReconstruction4x1` — RETIRED and deleted under RELEASE-8 (per-frame CPU resolve/scanout driver). WebGL2 appearance canonical source: `packages/webgl-renderer/src/appearance.ts` (duplicated by value).
- `sampleTexture(indices, palette, w, h, u, v, out, off, st)` (`src/index.ts:185`) — cvar-aware palette texture sample; filtering follows `vd_bilinear` only (`vd_palettetex` is upload/storage policy, not a filter switch).
- `sampleRGBTextureFrame(tex, w, h, u, v, out, off, st)` (`src/index.ts`) — cvar-aware expanded-RGB-triplet sample with the same bilinear/nearest policy.
- `shadePixel(...)` (`src/index.ts:223`) — overbright lightmap modulate + table-fog blend, returns packed `0xFFBBGGRR`.
- `quantiseDepthFrame(depth, st)` (`src/index.ts:158`) — 1/z banding to `vd_zbits` bits (display/banding approximation only, NOT depth-buffer emulation).
- `capTextureSizeFrame(w, h, st)` (`src/index.ts:169`) — halve-until-fit for `vd_maxtexsize`.
- Low level (`src/resolve.ts`, `src/sampler.ts`): `gammaLUT` (power-curve LUT, gamma 1 identity / preset 1.3), `quantiseRGB565` / `expandRGB565` (single-pixel pack/expand with bit replication), `DitherMode` / `ReconMode` / `parseDitherMode` / `parseReconMode` / `parseRgbMaxDelta`, `passesReconstructionThreshold[Row]` (pure rgbMaxDelta gates; all-zero thresholds = unconditional pass), `quantiseDepth` (banding-only compat), pre-test depth plane `createDepth16` / `clearDepth16` / `testAndWriteDepth16` (normalized Z16: depth01 derived from the projection near/far planes, LESS, tie-keeps-stored, clear = far; W-buffer NOT implemented) alongside compat `quantiseDepthBeforeTest` / `depthTestLess`, `sampleBilinear`, `sampleNearest`, `samplePalette`, `expandPalette`, `sampleRGBTexture` (expanded RGB triplets, same filter policy), `mipRho` / `mipLevel` / `pickMipLevel` / `lodBiasCompensation`, `buildFogTable` / `fogFactor` / `fogFactorLerp` / `fogContribution` / `applyFog`, `modulateLightmap`, `capTextureSize`; upload `resampleTexture` / `halveRGB` / `completeMipChainRGB` / `padTextureToPOT` / `nextPOT` (`src/upload.ts`: REPEAT textures resample, CLAMPED textures pad-to-POT + UV adjust — application/driver policy choice); tables `BAYER4`, `DITHER_RB_POS`, `BAYER2`, `DITHER2_RB_POS` (`src/bayer.ts`). All scanout/dither profiles are deterministic approximations until HW capture (see source docs).
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

- `yarn workspace @q2/voodoo test` — vitest; suites `src/policy.test.ts` (gamma/Bayer/RGB565/parse/gate/depth/fog pins), `src/sampler.test.ts`, `src/upload.test.ts` (incl. LOD-compensation-once + clamp-pad policy tests), `src/profile.test.ts` (pins `VOODOO_APPROX_PROFILE`) — deterministic: fixed Bayer matrices, no RNG.
- `yarn workspace @q2/voodoo golden` / `bench` are stub `echo` scripts (no goldens pinned here).
- `yarn workspace @q2/voodoo golden` / `bench` are stub `echo` scripts (no goldens pinned here).

## Constraints

- Dependency direction (BRAIN.md §4, RELEASE-8 residual): sat beside `sw-renderer`
  above `bsp`/`formats`/`math`; read (never wrote) `vd_*` cvars from `@q2/config`.
  Nothing may import `apps/*`. No new importers; this package is deleted on
   retirement completion (kept as a pure policy library; no frame driver).
- Platform: DOM-free, zero-alloc inner loops, typed arrays only — runs in a worker and in Node tests.
