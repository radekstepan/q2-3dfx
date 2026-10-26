---
"@q2/sw-renderer": patch
---

fix(sw-renderer): per-luxel dlight falloff, dlight expiry, sky orientation

- Per-luxel dynamic-light falloff (bug 1): `buildLightMap` took a single
  surfCenter distance for every luxel, so a blaster impact lit the whole
  tile uniformly. New optional trailing `luxelPos` grid (w*h*3 world-space
  luxel centers) switches the R_AddDynamicLights loop to per-luxel
  distances; absent grids keep the legacy uniform path bit-identical (the
  devroom golden `8f61c755` has no dlights and is untouched). New exported
  `luxelWorldPositions` fits exact world pos per luxel from the surface
  geometry (planar surfaces are exactly affine in luxel coords; degenerate
  input falls back to center, never NaN), computed in `buildSurfaceBlock`
  only when a light actually affects the surface. Tests: fitter exactness,
  nearby-only boost ([63,31,0,0] vs legacy uniform), degenerate fallback,
  and a full render-path localisation check (lit-half mean exceeds far-half
  mean by 40+).
- TTL paths (bug 2): audited `DLightState` (expire-before-serial,
  age-after-draw, swap-remove sweep) and the renderer-owned tracer pool —
  both decrement/expire correctly and are now pinned headlessly (light added
  once gone within ~3 renders; ttl-6 beam drawn 6 renders, gone by the 7th).
  `clear()` no longer bumps serial when idle (was one free full-cache
  rebuild per no-op clear).
- Sky orientation (bug 3): verified SKY_SIDE_IMAGE, SKY_FACE_AXES, dominant
  axis/tie-break and su/tv against r_rast.c box_vecs, r_main.c R_SetSky and
  r_edge.c D_SkySurf — all 12 adjacent-face edges invert to the same 3D
  point (now a regression test, plus a no-tile-bleed grid check). The real
  seam was structural: fan-triangulating world polys with one centroid face
  smeared whole triangles with the wrong tile. The textured path now ports
  R_EmitSkyBox: world SURF_SKY polys are never rasterised; the 6
  single-face box quads (SKY_BOX_CORNERS at SKY_BOX_HALF, far enough to
  depth-test as background with exact perspective math) emit once per frame
  (r_skyframe guard), each face sampling its own tile unlit and cache-free.
  The corner-straddle test now asserts per-pixel face-exactness against
  camera rays (failed pre-fix, passes now). Flat-fill fallback unchanged.
