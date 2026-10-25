---
'@q2/sw-renderer': minor
---

Faithful Quake 2 software sky + readable blaster beam. SURF_SKY now samples a packed skybox strip via setSkyTexture (ref_soft R_EmitSkyBox/D_SkySurf port: 6 env/ faces, view-locked, static — ref_soft has no sky scroll); null keeps the flat-fill fallback. Tracer beams draw a two-pass near-white core + orange halo, proven by a 320x240 bright-pixel test.
