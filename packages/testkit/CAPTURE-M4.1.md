# M4.1 — Voodoo3 reference-capture instructions (human review)

Status: **harness landed, human review PENDING**. The M4.1 done-when
checkbox ("side-by-side screenshots vs a reference Voodoo3 capture reviewed
by a human") stays **unchecked** until a real capture lands in the slot and
a human signs off on the diff report.

## What the harness does (already wired)

`src/sidebyside.ts` compares our voodoo display buffer against a reference
capture slot with the §10.3 tolerance (≤0.5% of pixels differing by ≤1 LSB):

- `compareSideBySide(name, actual, reference)` — pure stats + pass/fail.
- `loadReferenceSlot(slotDir, name)` — loads `<name>.png` (real capture,
  8-bit RGB/RGBA, non-interlaced) when present, else `<name>.rgba` +
  `<name>.json`; returns `null` (review pending) when the slot is empty.
- `writeActualSlot(slotDir, name, rgba, meta)` — writes our render for review.
- `decodePng` — minimal PNG decoder for reference captures.
- `src/demo-fallback.ts` — asset-free fallback cameras (no-pak path).

Dither is deterministic (fixed 4×4 Bayer matrices, no RNG — pinned by the
`voodoo golden` test in `packages/voodoo`), so re-renders are bit-identical
and any diff vs the capture is real signal, not noise.

## What to capture (on real hardware or a Glide wrapper)

Pick ONE reference source:

1. **Real Voodoo3 3000** + Quake II 3.20 `ref_gl` (MiniGL/Glide), or
2. **dgVoodoo2 / nGlide wrapper** + the same 3.20 `ref_gl` (note which in the
   sign-off; wrappers are approximate but far better than nothing).

Settings (must match `captureCVarTable()` in `packages/voodoo` — the 12
`vd_*` defaults, §7.2 order):

| cvar | value | meaning |
| --- | --- | --- |
| `vd_16bit` | 1 | RGB565 framebuffer |
| `vd_dither` | 1 | 4×4 ordered dither |
| `vd_postfilter` | 1 | 2×2 "22-bit" post filter |
| `vd_bilinear` | 1 | bilinear filtering |
| `vd_mipdither` | 1 | single-TMU trilinear |
| `vd_lodbias` | -0.35 | Glide LOD bias |
| `vd_fog` | 1 | table fog |
| `vd_gamma` | 1.3 | Glide gamma lift |
| `vd_maxtexsize` | 256 | texture cap |
| `vd_zbits` | 16 | 16-bit depth |
| `vd_palettetex` | 1 | palettised textures |
| `vd_overbright` | 1 | lightmap ×2 + clamp |

Renderer: `640×480`, default FOV 90. Disable any wrapper "enhancements"
(forced AA, texture filtering overrides, widescreen hacks). Save screenshots
as **8-bit RGB/RGBA non-interlaced PNG** (the harness rejects 16-bit and
interlaced files with a descriptive error).

## Which cameras

Asset-free (works today, no pak): the three `demoFallbackViews()` cameras
(`demo-spawn`, `demo-pillar`, `demo-wide` over `maps/devroom`).

With a retail pak (`Q2_PAK`-gated, same views the WIRE test renders at
`640×480`, FOV 90, time 1.5, lightstyles all 1.0):

| slot name | origin | angles |
| --- | --- | --- |
| `base1-spawn-north` | (128, -320, 54) | (0, 90, 0) |
| `base1-spawn-west` | (128, -320, 54) | (0, 180, 0) |
| `base1-lowroad-west` | (-944, 1552, 0) | (0, 180, 0) |
| `base1-trench-east` | (-1648, 1544, 16) | (0, 0, 0) |

On the real game: `map base1`, `set viewpos` to the origin, set the angles,
`timedemo`-style still capture (no enemies mid-frame if avoidable).

## How to run the comparison

1. Render our side headlessly through the voodoo resolve chain
   (`resolveFrame` with `readVoodooState()`, i.e. all `vd_*` at default).
2. Drop each reference PNG at `<slotDir>/<name>.png`.
3. `loadReferenceSlot` + `compareSideBySide` per view; print
   `formatSideBySideReport`.
4. Pass = every view `PASS` (≤0.5% px over 1 LSB). A `FAIL` needs a human
   look: dither-pattern mismatch (our Bayer vs silicon), fog-table curve, or
   gamma-LUT shape are the prime suspects (§7.2).

## Sign-off

Record in BRAIN.md §15 (consolidated still-open list, M4.1 line): capture
source (card / wrapper + version), date, per-view diff stats, and the
reviewer's verdict. Only then may the M4.1 done-when box be ticked.
