---
"web": minor
---

feat(web): original id skybox wiring + respawn clears exit state (feedback batch #2)

- `skyNameForMap` (worldspawn `sky`; base1 = "unit1_") + `loadSkyStrip` pack the six `env/<sky>{rt,bk,lf,ft,up,dn}.pcx` faces into the renderer's `setSkyTexture` vertical-strip contract, remapped onto the engine palette (no-op when palettes match, nearest-color otherwise); invalid/missing art keeps the flat-fill fallback. Q2_PAK test pins 256x1536 + real-art distinct indices.
- `respawn()` clears `exited`: a new life is vulnerable again (previously a completed level — spurious or real — left permanent invincibility via the `damagePlayer` guard).
