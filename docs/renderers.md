# Renderers — software + Voodoo3 fidelity spec

> Extracted from BRAIN.md §7. Normative for renderer behaviour and cvars.

## 7. The two renderers

### 7.1 Software (`@q2/sw-renderer`) — the `ref_soft` port map

| id source | our module | notes |
| --- | --- | --- |
| `r_main.c` | `frame.ts` | setup, frustum, `R_SetupFrame`, viewcluster |
| `r_bsp.c` | `worldNodes.ts` | recursive node walk, PVS + frustum reject, surface marking |
| `r_surf.c` | `surfaceCache.ts` | **the hard one.** Builds lit, mipped texture blocks on demand into an LRU cache keyed by `(surface, lightstyle hash, miplevel)` |
| `r_edge.c` | `edges.ts` | edge list, `R_ScanEdges`, span emission, z-sorted spans |
| `d_scan.c` | `spans.ts` | `D_DrawSpans16`: the 16-pixel affine subdivision inner loop |
| `d_sprite.c` | `sprites.ts` | per-span clipped sprites |
| `r_alias.c` / `d_polyse.c` | `alias.ts` | MD2 drawing, affine triangle rasteriser, shade dots |
| `r_part.c` | `particles.ts` | single-pixel + blended particles |
| `r_light.c` | `light.ts` | dynamic light marking (`R_MarkLights`), blocklights |
| `colormap.pcx` | `colormap.ts` | 64×256 shade table; generate at load from the palette if missing |

**Inner loop (normative):**

```ts
// per 16-pixel subdivision: ONE division, then fixed-point stepping
const z1 = 1 / (iz + diz * n);
const u1 = (uz + duz * n) * z1, v1 = (vz + dvz * n) * z1;
let tu = (u0 * 65536) | 0, tv = (v0 * 65536) | 0;
const dtu = (((u1 - u0) / n) * 65536) | 0, dtv = (((v1 - v0) / n) * 65536) | 0;
for (let i = 0; i < n; i++, o++) {
  if (iz > zb[o]) {
    zb[o] = iz;
    idx[o] = colormap[(light << 8) + texels[(((tv >> 16) & hmask) << wshift) + ((tu >> 16) & wmask)]];
  }
  tu += dtu; tv += dtv; iz += diz; light += dlight;
}
```

Light is interpolated **per span**, not per pixel sample of the lightmap — that is what gives the
unmistakable soft 16-unit light gradient of the software renderer.

### 7.2 Voodoo 3 3000 (`@q2/voodoo`) — fidelity checklist

The Voodoo3 3000 is: 2 pixel pipelines × 1 TMU, 16 MB SDRAM, 166 MHz, 16-bit rendering only,
max 256×256 textures, 16-bit Z, no stencil, table fog, bilinear/trilinear-by-mip-dither.
Emulate **all** of the following; each is a cvar in `@q2/config` so we can A/B them:

| Hardware behaviour | Our implementation | cvar |
| --- | --- | --- |
| 16-bit RGB565 framebuffer | quantise 8:8:8 → 5:6:5 at resolve; `vd_16bit=0` is a genuine RGB888 debug bypass (gamma stays on, dither/reconstruction off) | `vd_16bit` |
| 4×4 ordered dither before quantise | Bayer matrix, ±4 on R/B, ±2 on G; colour dither at target writes, independent of mip dithering | `vd_dither` |
| 2×2 "22-bit" RAMDAC post filter | matched scanout reconstruction on output; off still displays the current target (never stale) | `vd_postfilter` |
| Bilinear filtering | 4-tap, 8-bit fractional weights, fixed point; works in paletted or expanded storage | `vd_bilinear` |
| Single-TMU "trilinear" | mipmap dithering: per-pixel pick LOD *n* or *n+1* by Bayer threshold vs LOD fraction (avg +0.375, needs bias comp) | `vd_mipdither` |
| LOD bias (Glide default ≈ -0.35) | added to computed `log2(rho)` (tLOD.lodbias convention; negative favours finer) | `vd_lodbias` |
| Table fog (64 entries, exp²) | capability gate: per-pixel table lookup on w, blend to fog colour; scene contribution is zero unless a scene/material/profile enables it (no haze in `base1`) | `vd_fog` |
| Glide gamma ≈ 1.3 | display-stage transfer LUT applied before dithering; 1.3 is a project preset, not a hardware constant | `vd_gamma` |
| 256×256 texture cap | asset cooker downsamples oversized WALs; helper currently returns capped dimensions — real texel resampling + mip/UV adjustment pending | `vd_maxtexsize` |
| 16-bit Z precision at visibility tests | 16 for the hardware profile; the per-frame helper is a banding-only approximation (post-hoc, cannot affect visibility) — true emulation must quantise before test/write | `vd_zbits` |
| 8-bit palettised textures (GL_EXT_shared_texture_palette) | texture storage/upload policy (paletted vs expanded RGB); expand through the palette at sample time; never gates filtering | `vd_palettetex` |
| No per-pixel colour overbright, lightmap modulate ×2 | explicit compat policy: multiply, then clamp — clipping highlights like the real thing; blanket ×2 pending `gl_image.c` upload-intensity/`inverse_intensity` audit for strict mode | `vd_overbright` |
| Dither matrix profile data (read-path only) | `2x2` \| `4x4`; current approximation is `4x4` | `vd_dithermode` |
| Reconstruction mode profile data (read-path only) | `legacy` (current 4×4-dither + 2×2-box approx — not an established hardware pairing) \| `2x2sub+2x2box` \| `4x4sub+4x1` (vidProcCfg modes, reserved) | `vd_reconmode` |
| Reconstruction edge thresholds profile data (read-path only) | `r,g,b` rgbMaxDelta thresholds; `0,0,0` = no rejection (current unconditional box) | `vd_rgbmaxdelta` |

The current cvar preset is the **legacy** preset: it preserves long-standing captures and
defaults. Do not change global defaults to make an uncalibrated image more dramatic — new
defaults need a hardware/driver capture reference (Quake II build, MiniGL/driver version,
gamma and filter settings) reviewed by a human. The three profile-data cvars
(`vd_dithermode`, `vd_reconmode`, `vd_rgbmaxdelta`) are read-path only: they document the
selected hardware state for future calibration and currently change no rendering behaviour.

Deliberately **not** emulated: the Voodoo's 3-bit sub-pixel accuracy, the 4 MB texture memory thrash,
and the 22-bit output's chroma-only filtering (we filter all channels — it looks the same at 2× scale).

Also ship the *presentation* layer: optional CRT mask + slight bloom + 4:3 letterbox, as a CSS/canvas
overlay in `apps/web`, never inside the renderer.

