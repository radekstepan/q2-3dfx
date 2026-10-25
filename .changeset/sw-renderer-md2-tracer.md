---
'@q2/sw-renderer': minor
---

M3.4/M7.2 follow-up: real MD2/skins render, tracer beams, gun fallback (Refresh frozen).

- `registerModel` now uses real data when provided: `AliasMesh` passes
  through, parsed MD2 output (`frames`/`normals`/`st`/`trisXyz`/`trisSt`)
  converts via `md2ToAliasMesh` (welds `(xyz, st)` corners, dequantised
  positions, st clamped to the skin dims, index-validated, null on garbage),
  and kind `md2` without usable data falls back to a procedural gun
  silhouette (`createGunMesh` + `createGunSkin`) instead of vanishing.
- `registerSkinData`/`registerSkinPixels` (internal extensions, Refresh
  untouched) store real WAL mip-0 / PCX index texels; non-POT dims (e.g.
  soldier skin 288 wide) expand to POT by edge repeat so the mask sampler
  stays valid and MD2 st needs no remap. Plain `registerSkin` keeps the
  checker; devroom golden `8f61c755` unchanged.
- Tracer/beam path for blaster + shotgun pellets: `drawTracerBeam` (1/z
  depth-tested index-space line, full-bright palette index, zero alloc)
  fed by kind-`'tracer'` entities (`skin` = raw palette index, `frame` =
  beam length) and the pooled `spawnTracer()` (fixed 64 ring, per-render
  ttl expiry). `Model.kind` keeps the frozen union — tracer registration
  casts at the call site until a contract-change PR widens it.
- Tests (`src/md2Tracer.test.ts`, 15): synthetic weld/seam/clamp/reject
  cases, gun silhouette draw, checker + POT/non-POT/bogus skins, beam
  visibility + behind-camera cull + occluder depth-fail, entity beam and
  pool ttl expiry restoring the frame. Q2_PAK-gated: soldier + g_shotg
  MD2 convert and draw >0 pixels with their real `skin.pcx` skins.
