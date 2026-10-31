---
"web": patch
---

RELEASE-3 aim/HUD: fit the display box to the stage at the framebuffer aspect instead of requesting framebuffer-x2 CSS pixels unconditionally. The x2 request overflowed the bezel at 800x600+ (1600x1200/2048x1536 CSS), so max-width/height + object-fit letterboxed the content, drifting the scene/HUD center and pushing bottom HUD below the fold. Both canvases now share one fitted box (identical rects, uniform scale); crosshair, shot ray and projection centers coincide at 640x480/800x600/1024x768 on Software and WebGL2.
