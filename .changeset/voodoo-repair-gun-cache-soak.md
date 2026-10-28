"@q2/sw-renderer": minor
---

feat(sw-renderer): voodoo repair — depth-bias UV/LOD, opaque alias, shared RGB chains, surgical dlight invalidation

Fixes the reported Voodoo regressions (black/holey viewmodel gun, missing
geometry, progressive FPS decline). All root causes in the RGB backend; the
software indexed path is bit-identical (all goldens green) and no frozen
§5 contract changes.

Rendering (alias.ts, tracer.ts, frame.ts skin wiring):
- drawAliasInstanceRGB stored iz*depthScale in v.iz but u*iz/v*iz with the
  unscaled iz, so fillPerspTriRGB recovered u = u_true/depthScale (the
  depthHack gun sampled at u/3: black + holes). Both the ordinary and the
  near-clipped paths now scale the numerators with the stored iz: depth bias
  no longer alters UV mapping, perspective interpolation, or LOD.
- fillPerspTriRGB's per-tri rho multiplied texels by base.width/height again
  (texels*width/pixel); the double-scale forced the coarsest mip on every
  alias tri (nearly-flat dark gun from edge-repeat averages). rho is now
  texels/pixel like drawSpansRGB's dudx.
- Index-255 audit vs id source: ref_soft's alias path (r_polyse/D_DrawPoly)
  has no TRANSPARENT_COLOR check and ref_gl draws meshes opaque (blend only
  under RF_TRANSLUCENT, which rides Entity.alpha); only sprites (r_spr8.asm)
  and HUD pics (r_draw.c) honor 255. Alias materials are now opaque
  (opaqueMask, separate rgbAliasMats cache); sprites keep the hole mask.
  Whole-pak audit: zero 255 texels in all 2118 world WALs, so world output
  is unchanged; real MD2 skins carry a few 255s (drawn opaque, like C).
- drawTracerBeamRGB bdy copy-paste (`pby * cam.up[0]` for `pbx * ...`)
  misplaced the RGB beam endpoint off-axis; now matches the indexed beam.

Sustained performance (frame.ts, spans.ts, surfaceCache.ts):
- Per-surface full-chain expansion thrashed the 4MB RGBLightCache on real
  maps (0% hits, ~4900 misses/frame, full rebuild + MBs of garbage/frame:
  ~445ms/frame at base1 spawn-north). Chains are now shared per texture
  (upload-time cost, VRAM-like 16MB LRU; base1: 71 chains/2.39MB) via
  buildRGBChain; entries own only the small per-surface luxels.
- invalidateAll-on-dlight-serial rebuilt both caches per combat frame.
  Invalidation is now the surgical union of last-frame-touched and
  current-affected surfaces (covers expiry/removal), and the RGB key
  carries no dlight serial (a serial would miss for every surface on every
  muzzle flash and leak never-read old-serial entries). Stationary
  ~152ms/renderView, combat frameAsync ~340ms, drift <5%, zero evictions
  (600-frame stationary + 300-frame combat + 200-frame frozen soaks).
- Honest shortfall (budgets NOT relaxed): serial RGB spanfill is ~6Mpx/s,
  still far from the ≤16ms budget at overdraw 3 — needs the pooled/worker
  composition (M8.1 follow-up). No periodic wipes, forced GC, or reboots.

Tests: rgbAliasDepth.test.ts (7: depthScale invariance ordinary+clipped,
fine-mip LOD, 255 alias-opaque/sprite-masked, tracer placement — 5 fail
pre-fix), rgbSustain.test.ts (3: hot second frame, churn confinement +
baseline restore, 200-frame determinism — 3 fail pre-fix),
apps/web/src/voodoo-regression.test.ts (Q2_PAK release gate: full-path
world/gun/HUD, 60-frame soak, combat; fails clearly without assets).
Devroom RGB pins re-pinned with cause (a9988ff4 → 436fe0c5; index 58e0ecf1
unchanged) — the delta is exactly the alias LOD fix on the box critter
(devroom skins contain no 255).
