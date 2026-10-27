# @q2/voodoo

Voodoo3/Glide emulation: per-frame post-process + texture-sampling policy (M4.1/M4.2).
Ports the `ref_gl` Voodoo path's resolve chain and sampler rules; not a second renderer —
it reuses the software geometry front end and adjusts sampling/resolve (BRAIN.md §7.2).

Entry point: `src/index.ts:1`. Re-exports `bayer.js`, `capture.js`, `resolve.js`,
`sampler.js` (`src/index.ts:13-16`) plus cvar-aware wrappers driven by `VoodooState`.

## Public API

- `VoodooState` (`src/index.ts:20`) — per-frame snapshot of all `vd_*` fidelity cvars.
- `defaultVoodooState()` (`src/index.ts:35`) — hardware defaults (gamma 1.3, 256px cap, 16-bit…).
- `readVoodooState()` (`src/index.ts:53`) — snapshots `vd_*` cvars from `@q2/config`; call once per frame.
- `resolveFrame(src, dst565, display, w, h, st)` (`src/index.ts:75`) — gamma → dither → RGB565, then optional 2x2 box post-filter. Pass `display = null` to skip.
- `sampleTexture(indices, palette, w, h, u, v, out, off, st)` (`src/index.ts:115`) — cvar-aware palette texture sample (bilinear on/off).
- `shadePixel(...)` (`src/index.ts:135`) — overbright lightmap modulate + table-fog blend, returns packed `0xFFBBGGRR`.
- `quantiseDepthFrame(depth, st)` (`src/index.ts:91`) — 1/z banding to `vd_zbits` bits.
- `capTextureSizeFrame(w, h, st)` (`src/index.ts:102`) — halve-until-fit for `vd_maxtexsize`.
- Low level (`src/resolve.ts`, `src/sampler.ts`): `gammaLUT` (`:24`), `resolveRGB565` (`:77`), `applyPostFilter` (`:136`), `quantiseDepth` (`:192`), `sampleBilinear` (`sampler.ts:18`), `samplePalette` (`sampler.ts:81`), `pickMipLevel` (`sampler.ts:155`), `buildFogTable` (`sampler.ts:186`), `modulateLightmap` (`sampler.ts:240`), `capTextureSize` (`sampler.ts:265`); tables `BAYER4`, `DITHER_RB_POS` (`src/bayer.ts:9,27`).
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

- `yarn workspace @q2/voodoo test` — vitest; suites `src/resolve.test.ts`, `src/sampler.test.ts` (deterministic: fixed 4x4 Bayer matrix, no RNG).
- `yarn workspace @q2/voodoo golden` / `bench` are stub `echo` scripts (no goldens pinned here).

## Constraints

- Dependency direction (BRAIN.md §4): sits beside `sw-renderer` above `bsp`/`formats`/`math`; reads (never writes) `vd_*` cvars from `@q2/config`. Nothing may import `apps/*`.
- Platform: DOM-free, zero-alloc inner loops, typed arrays only — runs in a worker and in Node tests.
