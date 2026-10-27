---
"@q2/sw-renderer": minor
"@q2/testkit": minor
---

feat(sw-renderer,testkit): glass translucency, cache ledger, CI wiring

Render/process sweep lane. Glass TRANS33 translucency (r_surf.c/d_scan.c
port): SURF_TRANS33/TRANS66 surfaces skip the edge/span path and draw in a
deferred alpha pass after all opaque geometry (R_DrawAlphaSurfaces order,
back-to-front), depth-tested but never depth-writing, blended through the
8-bit alphamap (C index orders: 33 = alphamap[src + dst*256], 66 =
alphamap[src*256 + dst]) with texel-255 skip, or screen-door stipple when
sw_stipplealpha is set. Cvar-gated: r_translucency (1 = blend, C default;
0 = opaque fallback) + sw_stipplealpha (C parity-0 lattices: 33 = 1/4, 66 =
3/4). Real blend tables install from pics/colormap.pcx
(setAlphamapFromColormapPcx); procedural 0.30/0.60 fallback builds lazily.
Devroom golden stays byte-identical (8f61c755, no glass there); base1
TRANS66 pool water pinned (base1-translucent.test.ts). Note: the 17 TRANS33
*20 window faces live in brush-model *20 (unreachable from the worldspawn
tree), so the base path never emits them — they ride the same SPAN_TRANS33
code once the web mover graft submits them.

Cache ledger: runCacheFlythrough helper + Q2_PAK-gated test over base1
sweep cameras — steady state 100% (9107 hits / 0 misses, 4MB budget).
CI/deps: changesets status job on PRs, deps:check step after verify, and a
real `yarn deps:check` (tools/asset-cooker check-deps.ts enforcing the §4
diagram + §5 config-everywhere, with the documented reality exceptions).
