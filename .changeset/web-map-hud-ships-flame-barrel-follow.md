---
'web': patch
---

# M7.1 web: map-source dropdown, HUD declutter, ships/flame/barrel/follow fixes

`apps/web` only (no contract changes):

- Config menu gains a `map_source` dropdown (Built-in devroom / Cached
  pak0.pak): the pak appears only after a drop, selection persists via cvar,
  changing it reboots the level fresh (same path as skill/resolution).
- Play canvas drops the position readout, controls hint, and green in-canvas
  fps text; the DOM `#q2-fps` overlay stays the fps counter and `cl_showfps`
  still gates it.
- Strogg flybys submit live train positions every frame regardless of
  `started`-gating mistakes (models/skins verified registered).
- Enemy hitscan is a short 48u muzzle streak (same 225 yellow), never a beam
  ending at the eye; muzzle dlight stays a small C-sized flash at the muzzle.
- Explosive barrels render 1:1 with no doubles; `func_explosive` brush
  centers no longer float mid-air (rendered at bbox bottom); spawn pair
  bases pinned at floor z=0 with the MD2 pivot audited (frame min-z ≈ 0).
- Enemy follow pinned headlessly: rendered monster origins close on the
  player over ticks (devroom + base1 pair), via monsterThink + locomotion.
