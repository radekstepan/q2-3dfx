---
'web': patch
---

HUD lane: fps + player position render in the game font, in-canvas.

`fps N` (gated by `cl_showfps`) draws top-right inside the framebuffer and
`pos x y z yaw <yaw>` (gated by `cl_showpos`, default ON) draws top-left
inside the framebuffer, both via conchars glyphs (`drawString`) in
`drawPlayHud`'s pre-blit HUD pass — after the `r_brightness` scene lift, so
both readouts keep their authored colours at default brightness. The DOM
`#q2-fps`/`#q2-pos` overlays and their updaters are removed (cvar semantics
unchanged, only the sink); `fps.test.ts`/`pos.test.ts`/`display.test.ts`
now assert framebuffer glyph pixels.
