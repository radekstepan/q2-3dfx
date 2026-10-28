---
'web': patch
---

Slim the retro shell and fix the viewport fit

- Removes the right-rail help/description block and drops the topbar `64 fps tick` fluff; the faceplate header collapses to a single-line `Game config` title with tighter paddings, rows, console (76px), and a 340/360px sidebar.
- Fixes game visibility on desktop: the shell locks to `100vh` with internal scroll regions (`>=1024px`), so the canvas centers inside the viewport stage instead of pushing the page tall and forcing a scroll to find the game; the canvas/bezel are capped with `max-width/max-height: 100%` + `object-fit: contain` so large framebuffer modes scale down instead of overflowing.
